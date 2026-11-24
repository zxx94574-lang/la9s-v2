-- 0088 指令一键去做（Frank 11-24，待改 508）
-- 每种类型挂「跳到哪」（前端 + org_settings directive_jump）；员工点「去做」跳到那个页面，办完在那页点「提交指令」就算交了
-- 催款：反馈「客户说哪天付」→ 到那天前算进行中；过了那天还没交 → 自动变紧急，员工要再反馈一次
-- 批量：一条指令挂一批客户（directive_items），每位客户一项，逐个提交；全部提交完这条指令才算交了
alter table app.directives add column if not exists promise_on date, add column if not exists promise_note text,
  add column if not exists batch boolean not null default false;

create table if not exists app.directive_items (
  id uuid primary key default gen_random_uuid(),
  directive_id uuid not null references app.directives(id) on delete cascade,
  customer_id uuid not null references app.customers(id),
  status text not null default 'todo' check (status in ('todo', 'done', 'promised')),
  proof_kind text, proof_id uuid, proof_label text, note text,
  promise_on date, done_at timestamptz,
  unique (directive_id, customer_id));
create index if not exists directive_items_dir on app.directive_items (directive_id);
alter table app.directive_items enable row level security;
create policy read_own on app.directive_items for select using (exists (select 1 from app.directives d where d.id = directive_id and app.is_member(d.org_id)));

-- 能当凭证的记录（指定客户版：批量指令每位客户各找各的）
create or replace function app.directive_candidates2(p_id uuid, p_cust uuid)
returns table (kind text, id uuid, label text, at timestamptz, detail text)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare d app.directives; r jsonb; ks text[];
begin
  select * into d from app.directives where id = p_id;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  r := app.directive_proof_rule(d.org_id, coalesce(d.dir_type, ''));
  ks := array(select jsonb_array_elements_text(coalesce(r->'kinds', '[]')));
  if cardinality(ks) = 0 then ks := array['deal','receipt','shipment','visit','call','return']; end if;
  return query
  select * from (
    select 'deal'::text, x.id, x.biz_no, x.created_at, (select count(*) || ' 个型号' from app.deal_lines l where l.deal_id = x.id)
      from app.deals x where 'deal' = any(ks) and x.org_id = d.org_id and x.customer_id = p_cust and x.created_at >= d.created_at and x.status <> 'cancelled'
    union all
    select 'receipt', x.id, coalesce(x.rcv_no, '收款'), x.created_at, to_char(x.amount, 'FM999,999,999,990') || ' ' || x.currency
      from app.receipts x where 'receipt' = any(ks) and x.org_id = d.org_id and x.customer_id = p_cust and x.created_at >= d.created_at and x.voided_at is null
    union all
    select 'shipment', x.id, coalesce(x.out_no, '出库'), x.created_at, null
      from app.shipments x join app.deals y on y.id = x.deal_id where 'shipment' = any(ks) and y.org_id = d.org_id and y.customer_id = p_cust and x.created_at >= d.created_at and x.voided_at is null
    union all
    select 'visit', x.id, '拜访记录', x.at, x.result::text
      from app.visits x join app.customers c on c.id = x.customer_id where 'visit' = any(ks) and c.org_id = d.org_id and x.customer_id = p_cust and x.at >= d.created_at
    union all
    select 'call', x.id, '热线记录', x.at, x.result::text
      from app.hotline_calls x join app.customers c on c.id = x.customer_id where 'call' = any(ks) and c.org_id = d.org_id and x.customer_id = p_cust and x.at >= d.created_at
    union all
    select 'return', x.id, coalesce(x.rt_no, '退货'), x.requested_at, x.status::text
      from app.returns x where 'return' = any(ks) and x.org_id = d.org_id and x.customer_id = p_cust and x.requested_at >= d.created_at
  ) t order by 4 desc limit 30;
end $$;

-- 下指令（可挂一批客户）：p.customers = [客户 id…]
create or replace function app.issue_directive4(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_before uuid[]; v_cs uuid[]; v_n int;
begin
  v_cs := array(select distinct x::uuid from jsonb_array_elements_text(case when jsonb_typeof(p->'customers') = 'array' then p->'customers' else '[]'::jsonb end) x);
  if cardinality(v_cs) = 0 then return app.issue_directive3(p_org, p); end if;
  if exists (select 1 from unnest(v_cs) c where not exists (select 1 from app.customers where id = c and org_id = p_org)) then raise exception 'VALIDATION: 有客户不在这个公司'; end if;
  v_before := array(select id from app.directives where org_id = p_org and created_by = app.uid());
  v_id := app.issue_directive3(p_org, (p - 'customers') - 'customer_id');
  v_n := cardinality(v_cs);
  update app.directives set batch = true, ref_label = v_n || ' 位客户'
   where org_id = p_org and created_by = app.uid() and not (id = any(v_before));
  insert into app.directive_items (directive_id, customer_id)
  select d.id, c from app.directives d, unnest(v_cs) c
   where d.org_id = p_org and d.created_by = app.uid() and not (d.id = any(v_before)) and d.reporter;
  return v_id;
end $$;

-- 一批里的一项全部反馈完 → 整条指令算交了
create or replace function app.directive_items_close(p_dir uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare n int; m int;
begin
  select count(*), count(*) filter (where status = 'todo') into n, m from app.directive_items where directive_id = p_dir;
  if n > 0 and m = 0 then
    update app.directives set status = 'done', ack_at = coalesce(ack_at, now()), done_at = now(),
      done_note = n || ' 位客户都提交了' where id = p_dir and status in ('sent', 'acked');
  end if;
end $$;

-- 交一批里的一项：系统里的记录（同一客户、指令下达后建的）或者文字
create or replace function app.directive_item_done(p_item uuid, p_kind text, p_ref uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare it app.directive_items; v_label text; v_ok boolean;
begin
  select * into it from app.directive_items where id = p_item for update;
  if it.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.directive_mine(it.directive_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的'; end if;
  if it.status = 'done' then raise exception 'BAD_STATE: 这位客户已经交过了'; end if;
  if p_ref is not null then
    select true, c.label into v_ok, v_label from app.directive_candidates2(it.directive_id, it.customer_id) c where c.kind = p_kind and c.id = p_ref;
    if not coalesce(v_ok, false) then raise exception 'VALIDATION: 这条记录不能当凭证（要同一个客户、指令下达以后建的）'; end if;
  elsif coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 要选一条系统里的记录，或者写一句结果';
  end if;
  update app.directive_items set status = 'done', proof_kind = p_kind, proof_id = p_ref, proof_label = v_label,
    note = nullif(trim(coalesce(p_note, '')), ''), done_at = now() where id = p_item;
  update app.directives set status = 'acked', ack_at = coalesce(ack_at, now()) where id = it.directive_id and status = 'sent';
  perform app.directive_items_close(it.directive_id);
end $$;

-- 催款反馈：客户说哪天付（整条指令或一批里的一项）
create or replace function app.directive_promise(p_id uuid, p_item uuid, p_on date, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.directives;
begin
  select * into d from app.directives where id = p_id for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.directive_mine(p_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的'; end if;
  if d.status not in ('sent', 'acked') then raise exception 'BAD_STATE: 这条已经交过了'; end if;
  if p_on is null or p_on < current_date then raise exception 'VALIDATION: 客户说哪天付要填今天或以后的日子'; end if;
  if p_item is not null then
    update app.directive_items set status = 'promised', promise_on = p_on, note = nullif(trim(coalesce(p_note, '')), ''), done_at = now()
     where id = p_item and directive_id = p_id and status <> 'done';
    if not found then raise exception 'NOT_FOUND'; end if;
    update app.directives set status = 'acked', ack_at = coalesce(ack_at, now()) where id = p_id and status = 'sent';
    perform app.directive_items_close(p_id);
  else
    update app.directives set status = 'acked', ack_at = coalesce(ack_at, now()), promise_on = p_on, promise_note = nullif(trim(coalesce(p_note, '')), ''), urgent = false where id = p_id;
  end if;
end $$;

-- 到期没付：自动变紧急、回到员工手里（打开待办时跑一次）
create or replace function app.directive_sweep(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int := 0; m int := 0;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  update app.directives set urgent = true
   where org_id = p_org and promise_on < current_date and status in ('sent', 'acked') and not urgent;
  get diagnostics n = row_count;
  with back as (
    update app.directive_items i set status = 'todo' from app.directives d
     where d.id = i.directive_id and d.org_id = p_org and i.status = 'promised' and i.promise_on < current_date and d.status <> 'closed'
    returning i.directive_id)
  update app.directives set status = 'acked', urgent = true, done_at = null where id in (select directive_id from back);
  get diagnostics m = row_count;
  return n + m;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.directive_items to authenticated;
    grant execute on function app.directive_candidates2(uuid, uuid), app.issue_directive4(uuid, jsonb), app.directive_item_done(uuid, text, uuid, text),
      app.directive_promise(uuid, uuid, date, text), app.directive_sweep(uuid) to authenticated;
  end if;
end $$;
