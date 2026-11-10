-- LA&9S Operations · 0004 row-level security
-- Reads: only rows of orgs you belong to. Writes: only through app.* functions (no direct DML for clients).

do $$
declare t text;
begin
  foreach t in array array['orgs','employees','members','customers','categories','products','product_prices',
    'warehouses','stock_items','stock_moves','audit_log','doc_counters','deals','deal_lines','deal_events',
    'shipments','shipment_lines','ar_entries','receipts','receipt_allocations','returns','return_lines','kingdee_outbox']
  loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;

create policy read_own on app.orgs        for select using (app.is_member(id));
create policy read_own on app.employees   for select using (app.is_member(org_id));
create policy read_own on app.members     for select using (app.is_member(org_id));
create policy read_own on app.customers   for select using (app.is_member(org_id));
create policy read_own on app.categories  for select using (app.is_member(org_id));
create policy read_own on app.products    for select using (app.is_member(org_id));
create policy read_own on app.warehouses  for select using (app.is_member(org_id));
create policy read_own on app.audit_log   for select using (app.has_role(org_id, array['admin']::app.role_name[]));
create policy read_own on app.deals       for select using (app.is_member(org_id));
create policy read_own on app.shipments   for select using (app.is_member(org_id));
create policy read_own on app.returns     for select using (app.is_member(org_id));
create policy read_own on app.kingdee_outbox for select using (app.is_member(org_id));
-- money: finance/admin/manager/hotline see balances; pickers do not
create policy read_fin on app.ar_entries  for select using (app.has_role(org_id, array['finance','manager','hotline','boss']::app.role_name[]));
create policy read_fin on app.receipts    for select using (app.has_role(org_id, array['finance','manager','hotline','boss']::app.role_name[]));
create policy read_fin on app.receipt_allocations for select using (
  exists (select 1 from app.receipts r where r.id = receipt_id and app.has_role(r.org_id, array['finance','manager','hotline','boss']::app.role_name[])));

create policy read_own on app.product_prices for select using (
  exists (select 1 from app.products p where p.id = product_id and app.has_role(p.org_id, array['manager','hotline','sales','finance','boss']::app.role_name[])));
create policy read_own on app.stock_items for select using (
  exists (select 1 from app.warehouses w where w.id = warehouse_id and app.is_member(w.org_id)));
create policy read_own on app.stock_moves for select using (
  exists (select 1 from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.id = stock_item_id and app.is_member(w.org_id)));
create policy read_own on app.deal_lines  for select using (
  exists (select 1 from app.deals d where d.id = deal_id and app.is_member(d.org_id)));
create policy read_own on app.deal_events for select using (
  exists (select 1 from app.deals d where d.id = deal_id and app.is_member(d.org_id)));
create policy read_own on app.shipment_lines for select using (
  exists (select 1 from app.shipments s where s.id = shipment_id and app.is_member(s.org_id)));
create policy read_own on app.return_lines for select using (
  exists (select 1 from app.returns r where r.id = return_id and app.is_member(r.org_id)));

-- views respect caller's RLS
alter view app.v_stock            set (security_invoker = true);
alter view app.v_deal_totals      set (security_invoker = true);
alter view app.v_deal_due         set (security_invoker = true);
alter view app.v_customer_balance set (security_invoker = true);
alter view app.v_receipt_open     set (security_invoker = true);
alter view app.v_unmet_demand     set (security_invoker = true);

-- internal helpers: callable only from inside SECURITY DEFINER business functions
revoke execute on function app.deal_event(uuid, text, jsonb) from public;
revoke execute on function app.lock_deal(uuid, app.deal_status[]) from public;
revoke execute on function app.reserve(uuid, int) from public;
revoke execute on function app.move_stock(uuid, int, text, text, uuid) from public;
revoke execute on function app.stock_row(uuid, app.wh_kind, uuid) from public;
revoke execute on function app.write_lines(app.deals, jsonb, boolean) from public;
revoke execute on function app.allocate(uuid, text, jsonb) from public;
revoke execute on function app.next_doc_no(uuid, text) from public;
revoke execute on function app.audit(uuid, text, text, uuid, jsonb) from public;
revoke execute on function app.tier_price(uuid, uuid, text) from public;

-- Supabase roles (skipped when absent, e.g. in tests)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema app to authenticated;
    grant select on all tables in schema app to authenticated;
    revoke insert, update, delete on all tables in schema app from authenticated;
    grant execute on function app.create_quote, app.edit_quote, app.refresh_prices, app.set_line_price,
      app.hotline_confirm, app.start_picking, app.submit_pick, app.review_pick, app.create_sales_order,
      app.add_lines_before_ship, app.customer_confirm, app.ship, app.mark_received, app.cancel_deal,
      app.import_opening, app.record_receipt, app.apply_unallocated, app.request_return, app.decide_return,
      app.inspect_return_line, app.has_role, app.is_member to authenticated;
  end if;
end $$;
