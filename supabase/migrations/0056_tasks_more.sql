-- 0056 任务补齐 (Frank 11-18 09:23:「没做到的全部搞完」)
-- ① 期限精确到几点 (due_at; 没给 = 第二天 12:00 阿比让时间)
-- ② 「等任务完成才能往下走」: blocks = true 的任务没关闭之前, 挂着它的订单不能往前推 / 不能出库
-- ③ 「答应付款的日子过了钱没到」改成核对金额: 到某个计划日为止累计该付多少 vs 从答应那天起累计实际收了多少
-- ④ 任务可以挂在 客户 / 出库单 / 型号 / 采购单 上 (0055 已支持 ref_kind, 这里补客户自动带出)

alter table app.directives add column due_at timestamptz, add column blocks boolean not null default false;

create or replace function app.issue_task(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_type text := coalesce(nullif(p->>'task_type', ''), 'other'); v_cust uuid; v_due timestamptz;
begin
  if v_type not in ('payment_plan','recon','check','other') then raise exception 'VALIDATION: 任务类型不对'; end if;
  if nullif(p->>'ref_kind', '') is null or nullif(p->>'ref_id', '') is null then raise exception 'VALIDATION: 任务要挂在一张单 / 一个客户上'; end if;
  v_due := coalesce(nullif(p->>'due_at', '')::timestamptz, ((current_date + 1)::text || ' 12:00:00+00')::timestamptz);
  v_id := app.issue_directive(p_org, p || jsonb_build_object('due_on', (v_due at time zone 'UTC')::date::text,
    'require_photo', v_type = 'payment_plan' or coalesce((p->>'require_photo')::boolean, false)) - 'repeat');
  v_cust := case p->>'ref_kind'
    when 'customer' then (p->>'ref_id')::uuid
    when 'deal' then (select customer_id from app.deals where id = (p->>'ref_id')::uuid and org_id = p_org)
    when 'shipment' then (select d.customer_id from app.shipments s join app.deals d on d.id = s.deal_id where s.id = (p->>'ref_id')::uuid and d.org_id = p_org)
    else nullif(p->>'ref_customer_id', '')::uuid end;
  update app.directives set ref_kind = p->>'ref_kind', ref_id = (p->>'ref_id')::uuid, ref_label = nullif(p->>'ref_label', ''), ref_customer_id = v_cust,
    task_type = v_type, due_at = v_due, blocks = coalesce((p->>'blocks')::boolean, false) and p->>'ref_kind' = 'deal' where id = v_id;
  if p->>'ref_kind' = 'deal' then perform app.deal_event((p->>'ref_id')::uuid, 'task_issued', jsonb_build_object('title', p->>'title', 'type', v_type, 'blocks', coalesce((p->>'blocks')::boolean, false))); end if;
  return v_id;
end $$;

-- ② 卡流程: 订单上有「必须先做完」的任务没关 → 不能往前走 / 不能出库 (撤回、作废不拦)
create or replace function app.task_gate(p_deal uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare t text;
begin
  select title into t from app.directives where ref_kind = 'deal' and ref_id = p_deal and blocks and status <> 'closed' and active and not is_template order by created_at limit 1;
  if t is not null then raise exception 'TASK_BLOCK: 这张单上有任务要先做完、中方确认后才能往下走：%', t; end if;
end $$;
create or replace function app.trg_deal_task_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status <> old.status and new.status <> 'cancelled'
     and array_position(array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed','partial','shipped'], new.status::text)
       > array_position(array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed','partial','shipped'], old.status::text) then
    perform app.task_gate(new.id);
  end if;
  return new;
end $$;
create trigger deal_task_gate before update of status on app.deals for each row execute function app.trg_deal_task_gate();
create or replace function app.trg_ship_task_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
begin perform app.task_gate(new.deal_id); return new; end $$;
create trigger ship_task_gate before insert on app.shipments for each row execute function app.trg_ship_task_gate();

-- ③ 到期没付, 核对金额: 一条 = 一个计划日; due_total = 到这天为止累计答应付的; paid = 从员工交计划那天起这个客户累计收到的 (没作废的)
drop function if exists app.overdue_payment_plans(uuid);
create function app.overdue_payment_plans(p_org uuid)
returns table (directive_id uuid, customer_id uuid, customer_name text, plan_on date, amount numeric, due_total numeric, paid numeric, short numeric, balance numeric, ref_label text)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  return query
  with plans as (
    select d.id as did, d.ref_customer_id as cid, d.ref_label as lbl, coalesce(d.done_at, d.created_at)::date as since,
      (x->>'on')::date as on_d, (x->>'amount')::numeric as amt,
      sum((x->>'amount')::numeric) over (partition by d.id order by (x->>'on')::date, ord) as cum
    from app.directives d cross join lateral jsonb_array_elements(d.result) with ordinality as e(x, ord)
    where d.org_id = p_org and d.task_type = 'payment_plan' and d.status in ('done','closed') and jsonb_typeof(d.result) = 'array' and d.ref_customer_id is not null
  ), paid as (
    select p.did, p.on_d, coalesce((select sum(r.amount) from app.receipts r where r.customer_id = p.cid and r.voided_at is null and r.received_on >= p.since), 0) as got
    from plans p
  )
  select p.did, c.id, c.name, p.on_d, p.amt, p.cum, pd.got, p.cum - pd.got, coalesce(cr.balance, 0), p.lbl
  from plans p join paid pd on pd.did = p.did and pd.on_d = p.on_d join app.customers c on c.id = p.cid
  left join app.v_customer_credit cr on cr.customer_id = c.id
  where p.on_d < current_date and pd.got < p.cum and coalesce(cr.balance, 0) > 0
  order by p.on_d;
end $$;

-- 任务总表 (中方): 所有挂在单据 / 客户上的任务
create or replace function app.task_board(p_org uuid)
returns table (id uuid, title text, task_type text, status text, urgent boolean, blocks boolean, due_at timestamptz, created_at timestamptz, done_at timestamptz,
  assignee text, assignee_id uuid, customer text, customer_id uuid, ref_kind text, ref_id uuid, ref_label text, done_note text, overdue boolean)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  return query
  select d.id, d.title, d.task_type, d.status, d.urgent, d.blocks, coalesce(d.due_at, (d.due_on::text || ' 23:59:00+00')::timestamptz), d.created_at, d.done_at,
    e.short_name, e.id, c.name, c.id, d.ref_kind, d.ref_id, d.ref_label, d.done_note,
    d.status in ('sent','acked') and coalesce(d.due_at, (d.due_on::text || ' 23:59:00+00')::timestamptz) < now()
  from app.directives d join app.employees e on e.id = d.assignee_employee_id left join app.customers c on c.id = d.ref_customer_id
  where d.org_id = p_org and d.ref_kind is not null and not d.is_template
  order by (d.status = 'closed'), coalesce(d.due_at, (d.due_on::text || ' 23:59:00+00')::timestamptz) nulls last;
end $$;

do $$ begin
  revoke all on function app.task_gate(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function app.task_gate(uuid) from authenticated;
    grant execute on function app.issue_task(uuid, jsonb), app.overdue_payment_plans(uuid), app.task_board(uuid) to authenticated;
  end if;
end $$;
