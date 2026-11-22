-- 0079 指令（Frank 11-21 / 11-22，待改 478–480）
-- 478 制单指令：WhatsApp 下的单 → 中方下「制单」指令，员工建好单交的时候选那张订单
-- 480 凭证 = 系统里的记录：员工做完的事系统里本来就有记录（订单 / 收款单 / 出库单 / 拜访 / 热线 / 退货），交的时候点选就算交
--     每种类型能拿什么当凭证、要不要必须选单据，存 org_settings directive_proof = {类型: {kinds: [...], required: bool}}，⚙ 可改
--     选单据时只列同一个客户、指令下达以后新建的；最像的一条自动挂上，员工点完成前能看能换
alter table app.directives add column if not exists dir_type text,
  add column if not exists proof_kind text, add column if not exists proof_id uuid, add column if not exists proof_label text;

-- 默认规则（没配就用这个）
create or replace function app.directive_proof_rule(p_org uuid, p_type text)
returns jsonb language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select value -> p_type from app.org_settings where org_id = p_org and key = 'directive_proof' and value ? p_type),
    case p_type
      when '制单' then '{"kinds":["deal"],"required":true}'::jsonb
      when '催款' then '{"kinds":["receipt"],"required":false}'::jsonb
      when '发货' then '{"kinds":["shipment"],"required":false}'::jsonb
      when '拜访' then '{"kinds":["visit"],"required":false}'::jsonb
      when '回电话' then '{"kinds":["call"],"required":false}'::jsonb
      when '对账' then '{"kinds":["deal"],"required":false}'::jsonb
      when '退货' then '{"kinds":["return"],"required":false}'::jsonb
      else '{"kinds":[],"required":false}'::jsonb end)
$$;

-- 下指令（带类型 / 客户）：在 issue_directive2 上再记类型和客户
create or replace function app.issue_directive3(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_t0 timestamptz := clock_timestamp(); v_cust uuid := nullif(p->>'customer_id', '')::uuid; v_cname text;
begin
  v_id := app.issue_directive2(p_org, p);
  if v_cust is not null then select name into v_cname from app.customers where id = v_cust and org_id = p_org; end if;
  update app.directives set dir_type = nullif(trim(coalesce(p->>'dir_type', '')), ''),
    ref_kind = coalesce(ref_kind, case when v_cust is not null then 'customer' end), ref_id = coalesce(ref_id, v_cust),
    ref_customer_id = coalesce(ref_customer_id, v_cust), ref_label = coalesce(ref_label, v_cname)
  where org_id = p_org and created_by = app.uid() and created_at >= v_t0 - interval '1 second' and (id = v_id or not is_template);
  return v_id;
end $$;

-- 能当凭证的记录：同一个客户、指令下达以后新建的（最新的排前面）
create or replace function app.directive_candidates(p_id uuid)
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
      from app.deals x where 'deal' = any(ks) and x.org_id = d.org_id and x.customer_id = d.ref_customer_id and x.created_at >= d.created_at and x.status <> 'cancelled'
    union all
    select 'receipt', x.id, coalesce(x.rcv_no, '收款'), x.created_at, to_char(x.amount, 'FM999,999,999,990') || ' ' || x.currency
      from app.receipts x where 'receipt' = any(ks) and x.org_id = d.org_id and x.customer_id = d.ref_customer_id and x.created_at >= d.created_at and x.voided_at is null
    union all
    select 'shipment', x.id, coalesce(x.out_no, '出库'), x.created_at, null
      from app.shipments x join app.deals y on y.id = x.deal_id where 'shipment' = any(ks) and y.org_id = d.org_id and y.customer_id = d.ref_customer_id and x.created_at >= d.created_at and x.voided_at is null
    union all
    select 'visit', x.id, '拜访记录', x.at, x.result::text
      from app.visits x join app.customers c on c.id = x.customer_id where 'visit' = any(ks) and c.org_id = d.org_id and x.customer_id = d.ref_customer_id and x.at >= d.created_at
    union all
    select 'call', x.id, '热线记录', x.at, x.result::text
      from app.hotline_calls x join app.customers c on c.id = x.customer_id where 'call' = any(ks) and c.org_id = d.org_id and x.customer_id = d.ref_customer_id and x.at >= d.created_at
    union all
    select 'return', x.id, coalesce(x.rt_no, '退货'), x.requested_at, x.status::text
      from app.returns x where 'return' = any(ks) and x.org_id = d.org_id and x.customer_id = d.ref_customer_id and x.requested_at >= d.created_at
  ) t order by 4 desc limit 30;
end $$;

-- 交指令：凭证可以是照片 / 文字，也可以是系统里的一条记录（制单这种必须选单据）
create or replace function app.complete_directive2(p_id uuid, p_note text, p_photo text, p_kind text default null, p_ref uuid default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.directives; r jsonb; v_label text; v_ok boolean;
begin
  select * into d from app.directives where id = p_id for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.directive_mine(p_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的，必须本人点完成'; end if;
  if d.status not in ('sent', 'acked') then raise exception 'BAD_STATE: 这条已经交过了'; end if;
  r := app.directive_proof_rule(d.org_id, coalesce(d.dir_type, ''));
  if coalesce((r->>'required')::boolean, false) and p_ref is null then raise exception 'VALIDATION: 「%」要选你做好的那张单据当凭证', d.dir_type; end if;
  if p_ref is not null then
    select true, c.label into v_ok, v_label from app.directive_candidates(p_id) c where c.kind = p_kind and c.id = p_ref;
    if not coalesce(v_ok, false) then raise exception 'VALIDATION: 这张单据不能当这条指令的凭证（要同一个客户、指令下达以后建的）'; end if;
  else
    if coalesce(trim(p_note), '') = '' and coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 要填结果（文字或照片），或者选一张单据'; end if;
    if d.require_photo and coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 这条要求拍照'; end if;
  end if;
  update app.directives set status = 'done', ack_at = coalesce(ack_at, now()), done_at = now(), done_note = nullif(trim(coalesce(p_note, '')), ''), done_photo = nullif(p_photo, ''),
    proof_kind = p_kind, proof_id = p_ref, proof_label = v_label where id = p_id;
  if p_kind = 'deal' then
    perform app.deal_event(p_ref, 'from_directive', jsonb_build_object('directive', p_id, 'title', d.title, 'type', d.dir_type, 'attachments', d.attachments));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.issue_directive3(uuid, jsonb), app.directive_candidates(uuid), app.complete_directive2(uuid, text, text, text, uuid),
      app.directive_proof_rule(uuid, text) to authenticated;
  end if;
end $$;
