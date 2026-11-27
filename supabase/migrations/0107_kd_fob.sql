-- 0107 (11-27 自查): 「待录金蝶」总表漏了 FOB —— FOB 出库、FOB 订金 / 尾款都没进清单 (第 3 组规定 FOB 订金尾款也进金蝶).
alter table app.fob_events add column if not exists kd_uid uuid not null default gen_random_uuid(), add column if not exists kd_no text, add column if not exists kd_at timestamptz, add column if not exists kd_by uuid;
alter table app.fob_payments add column if not exists kd_no text, add column if not exists kd_at timestamptz, add column if not exists kd_by uuid;

create or replace view app.v_kingdee_all with (security_invoker = true) as
select 'outbound'::text as kind, '销售出库'::text as kind_name, k.id as row_id, k.org_id, sh.id as src_id, sh.out_no as label, d.id as deal_id, d.customer_id, c.name as customer_name,
  sh.shipped_at as at, case when k.status = 'synced' then 'done' when k.status = 'void' then 'skip' when k.status = 'await_receipt' then 'wait' else 'todo' end as state,
  case k.status when 'await_receipt' then '等客户签收' when 'ready' then '待录' when 'saved' then '已保存，等提交' when 'submitted' then '已提交，等审核' when 'synced' then '已录' when 'error' then '有差异' else '作废' end as state_name,
  k.remote_no as kd_no, (select coalesce(sum(sl.qty), 0)::int from app.shipment_lines sl where sl.shipment_id = sh.id) as qty
from app.kingdee_outbox k join app.shipments sh on sh.id = k.shipment_id join app.deals d on d.id = sh.deal_id join app.customers c on c.id = d.customer_id
where sh.voided_at is null
union all
select 'misc', m.doc_type, m.id, m.org_id, m.ref_id, m.reason, null::uuid, null::uuid, null::text, m.at,
  case m.status when 'done' then 'done' when 'skip' then 'skip' else 'todo' end, case m.status when 'done' then '已录' when 'skip' then '不用录' else '待录' end, m.remote_no, m.qty
from app.kingdee_misc m
union all
select 'grn', '采购入库', g.id, g.org_id, g.po_id, g.grn_no || ' · ' || p.po_no, null::uuid, null::uuid, p.supplier, g.created_at,
  case when g.kd_status = 'synced' then 'done' else 'todo' end, case g.kd_status when 'synced' then '已录' when 'saved' then '已保存，等审核' else '待录' end, g.kd_no,
  (select coalesce(sum(coalesce((x->>'local_qty')::int, 0) + coalesce((x->>'fob_qty')::int, 0)), 0)::int from jsonb_array_elements(g.lines) x)
from app.po_receipts g join app.purchase_orders p on p.id = g.po_id
union all
select 'receipt', '收款', r.id, r.org_id, r.id, r.rcv_no, null::uuid, r.customer_id, c.name, r.received_on::timestamptz,
  case when r.kd_no is not null then 'done' else 'todo' end, case when r.kd_no is not null then '已录' else '待录' end, r.kd_no, null::int
from app.receipts r join app.customers c on c.id = r.customer_id where r.voided_at is null
union all
-- 0107: FOB 出库 (每次出库一张) / FOB 收款 (订金、尾款) 也要进金蝶 (第 3 组: FOB 订金尾款进金蝶)
select 'fob_ship', 'FOB 出库', e.kd_uid, f.org_id, f.id, f.fob_no || ' 出库', null::uuid, f.customer_id, c.name, e.at,
  case when e.kd_no is not null then 'done' else 'todo' end, case when e.kd_no is not null then '已录' else '待录' end, e.kd_no,
  (select coalesce(sum((r->>'qty')::int), 0)::int from jsonb_array_elements(coalesce(e.detail->'rows', '[]')) r)
from app.fob_events e join app.fob_projects f on f.id = e.project_id join app.customers c on c.id = f.customer_id where e.action = 'shipped'
union all
select 'fob_pay', 'FOB 收款', x.id, f.org_id, f.id, f.fob_no || ' ' || case x.kind when 'deposit' then '订金' when 'balance' then '尾款' else '收款' end, null::uuid, f.customer_id, c.name, x.on_date::timestamptz,
  case when x.kd_no is not null then 'done' else 'todo' end, case when x.kd_no is not null then '已录' else '待录' end, x.kd_no, null::int
from app.fob_payments x join app.fob_projects f on f.id = x.project_id join app.customers c on c.id = f.customer_id;

grant select on app.v_kingdee_all to authenticated;

create or replace function app.kingdee_fill(p_org uuid, p_rows jsonb)
returns int language plpgsql security definer set search_path = app, public as $$
declare x jsonb; n int := 0; v_no text; v_id uuid; v_deal uuid;
begin
  perform app.require_role(p_org, 'finance', 'manager');
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    v_no := nullif(trim(coalesce(x->>'no', '')), ''); v_id := (x->>'row_id')::uuid;
    if v_no is null then raise exception 'VALIDATION: 金蝶单号要填'; end if;
    if x->>'kind' = 'outbound' then
      update app.kingdee_outbox set remote_no = v_no, status = case when status in ('await_receipt', 'ready', 'error', 'saved', 'submitted') then 'synced' else status end, updated_at = now()
        where id = v_id and org_id = p_org and status <> 'void' returning (select deal_id from app.shipments s where s.id = shipment_id) into v_deal;
      if v_deal is not null then perform app.deal_event(v_deal, 'kingdee_recorded', jsonb_build_object('no', v_no, 'note', '销售出库')); end if;
    elsif x->>'kind' = 'misc' then
      update app.kingdee_misc set remote_no = v_no, status = 'done', done_by = app.uid(), done_at = now() where id = v_id and org_id = p_org;
    elsif x->>'kind' = 'grn' then
      update app.po_receipts set kd_no = v_no, kd_status = 'synced' where id = v_id and org_id = p_org;
    elsif x->>'kind' = 'receipt' then
      update app.receipts set kd_no = v_no, kd_at = now(), kd_by = app.uid() where id = v_id and org_id = p_org;
    elsif x->>'kind' = 'fob_ship' then
      update app.fob_events e set kd_no = v_no, kd_at = now(), kd_by = app.uid() where e.kd_uid = v_id and e.action = 'shipped' and exists (select 1 from app.fob_projects f where f.id = e.project_id and f.org_id = p_org);
    elsif x->>'kind' = 'fob_pay' then
      update app.fob_payments y set kd_no = v_no, kd_at = now(), kd_by = app.uid() where y.id = v_id and exists (select 1 from app.fob_projects f where f.id = y.project_id and f.org_id = p_org);
    else raise exception 'VALIDATION: 不认识的单据类型 %', x->>'kind';
    end if;
    if found then n := n + 1; end if;
  end loop;
  perform app.audit(p_org, 'kingdee_fill', 'kingdee', null, jsonb_build_object('rows', n));
  return n;
end $$;

