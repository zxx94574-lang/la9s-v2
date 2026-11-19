-- 0069 (Frank 11-18 378 / 379 / 380)
-- A. 「待录金蝶」总表: 凡是动库存 / 动钱的单据一张清单 (销售出库 / 采购入库 / 其他出入库·调拨·退货 / 收款), 金蝶单号回填 + 反查.
-- B. 「和金蝶对账」: 从金蝶导出的表拖进来 → 前端按单号 / 相似度比 → 结果存一份 (哪天、谁、导了什么、各类多少条), 每条可以写原因标「已处理」.
-- 系统不往金蝶写, 只记单号、对状态.

alter table app.receipts add column kd_no text, add column kd_at timestamptz, add column kd_by uuid;

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
from app.receipts r join app.customers c on c.id = r.customer_id where r.voided_at is null;
grant select on app.v_kingdee_all to authenticated;

-- 回填金蝶单号 (哪一类都走这一个): p_rows = [{kind, row_id, no}]. 出库单 = 直接记成已录 (三步照旧在出库单页签里走也行)
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
    else raise exception 'VALIDATION: 不认识的单据类型 %', x->>'kind';
    end if;
    if found then n := n + 1; end if;
  end loop;
  perform app.audit(p_org, 'kingdee_fill', 'kingdee', null, jsonb_build_object('rows', n));
  return n;
end $$;

-- 对账记录
create table app.kd_recon_runs (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references app.orgs(id),
  at timestamptz not null default now(), by_user uuid, files jsonb not null default '[]', counts jsonb not null default '{}', note text
);
create table app.kd_recon_items (
  id uuid primary key default gen_random_uuid(), run_id uuid not null references app.kd_recon_runs(id) on delete cascade, org_id uuid not null,
  cat text not null check (cat in ('ok', 'kd_only', 'sys_only', 'diff', 'suspect', 'stock')),
  doc_kind text, kd_no text, sys_kind text, sys_row uuid, sys_label text, deal_id uuid, info jsonb,
  status text not null default 'open' check (status in ('open', 'handled')), handle_note text, handled_by uuid, handled_at timestamptz
);
create index on app.kd_recon_items (run_id, cat);
alter table app.kd_recon_runs enable row level security; alter table app.kd_recon_items enable row level security;
create policy read_admin on app.kd_recon_runs for select using (app.has_role(org_id, array['admin', 'finance']::app.role_name[]));
create policy read_admin on app.kd_recon_items for select using (app.has_role(org_id, array['admin', 'finance']::app.role_name[]));
grant select on app.kd_recon_runs, app.kd_recon_items to authenticated;

create or replace function app.save_kd_recon(p_org uuid, p_files jsonb, p_items jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  perform app.require_role(p_org, 'admin', 'finance');
  insert into app.kd_recon_runs (org_id, by_user, files, note, counts)
  values (p_org, app.uid(), coalesce(p_files, '[]'), nullif(trim(coalesce(p_note, '')), ''),
    coalesce((select jsonb_object_agg(cat, n) from (select x->>'cat' as cat, count(*) as n from jsonb_array_elements(coalesce(p_items, '[]')) x group by 1) t), '{}'))
  returning id into v_id;
  insert into app.kd_recon_items (run_id, org_id, cat, doc_kind, kd_no, sys_kind, sys_row, sys_label, deal_id, info, status)
  select v_id, p_org, x->>'cat', x->>'doc_kind', x->>'kd_no', x->>'sys_kind', nullif(x->>'sys_row', '')::uuid, x->>'sys_label', nullif(x->>'deal_id', '')::uuid, x->'info',
    case when x->>'cat' = 'ok' then 'handled' else 'open' end
  from jsonb_array_elements(coalesce(p_items, '[]')) x;
  return v_id;
end $$;

-- 一条差异: 写原因标已处理; p_fill = true 且是「疑似是这张」→ 顺手把金蝶单号回填到系统那张单
create or replace function app.handle_kd_item(p_item uuid, p_note text, p_fill boolean default false)
returns void language plpgsql security definer set search_path = app, public as $$
declare i app.kd_recon_items;
begin
  select * into i from app.kd_recon_items where id = p_item;
  if i.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(i.org_id, 'admin', 'finance');
  if p_fill then
    if i.sys_row is null or i.kd_no is null then raise exception 'VALIDATION: 这一条没有可以回填的单'; end if;
    perform app.kingdee_fill(i.org_id, jsonb_build_array(jsonb_build_object('kind', i.sys_kind, 'row_id', i.sys_row, 'no', i.kd_no)));
  elsif coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 写一下是怎么回事';
  end if;
  update app.kd_recon_items set status = 'handled', handle_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), '确认是同一张，已回填金蝶单号'), handled_by = app.uid(), handled_at = now() where id = p_item;
end $$;

revoke all on function app.kingdee_fill(uuid, jsonb), app.save_kd_recon(uuid, jsonb, jsonb, text), app.handle_kd_item(uuid, text, boolean) from public;
grant execute on function app.kingdee_fill(uuid, jsonb), app.save_kd_recon(uuid, jsonb, jsonb, text), app.handle_kd_item(uuid, text, boolean) to authenticated;
