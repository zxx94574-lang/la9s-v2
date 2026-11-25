-- 0097 报废仓按货权分两个（体检第 3 组：金蝶 CI Defective WH-LA / WH-9S）
-- 原来的 SCRAP 当 LA 的报废仓（改名「报废仓 LA」），再建一个 SCRAP-9S；退货检验坏货按原来出货的仓进对应的报废仓。
update app.warehouses set name = '报废仓 LA' where kind = 'scrap' and code = 'SCRAP' and name = '报废仓';
insert into app.warehouses (org_id, code, name, kind, supplier)
  select distinct w.org_id, 'SCRAP-9S', '报废仓 9S', 'scrap'::app.wh_kind, '9S' from app.warehouses w
  where w.code = '9S' and w.kind = 'local'
  on conflict (org_id, code) do nothing;

-- 源库存行在哪个本地仓 → 那个仓的报废仓（code 里带仓号的），找不到就用第一个报废仓
create or replace function app.scrap_row_for(p_org uuid, p_src_item uuid, p_product uuid)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_code text; v_wh uuid; v_id uuid;
begin
  select w.code into v_code from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.id = p_src_item;
  if v_code is not null then
    select id into v_wh from app.warehouses where org_id = p_org and kind = 'scrap' and code = 'SCRAP-' || v_code;
  end if;
  if v_wh is null then return app.stock_row(p_org, 'scrap', p_product); end if;
  insert into app.stock_items (warehouse_id, product_id) values (v_wh, p_product) on conflict (warehouse_id, product_id) do nothing;
  select id into v_id from app.stock_items where warehouse_id = v_wh and product_id = p_product;
  return v_id;
end $$;
revoke execute on function app.scrap_row_for(uuid, uuid, uuid) from public;

create or replace function app.inspect_return_line(p_return_line uuid, p_good int, p_scrap int)
returns void language plpgsql security definer set search_path = app, public as $$
declare rl app.return_lines; r app.returns; l app.deal_lines; v_scrap uuid;
begin
  select * into rl from app.return_lines where id = p_return_line for update;
  select * into r from app.returns where id = rl.return_id;
  perform app.require_role(r.org_id, 'manager');
  if r.status <> 'approved' then raise exception 'BAD_STATE: return not approved'; end if;
  if p_good < 0 or p_scrap < 0 or rl.qty_good + rl.qty_scrap + p_good + p_scrap > rl.qty then
    raise exception 'VALIDATION: 检验数量超过退货数量';
  end if;
  select * into l from app.deal_lines where id = rl.deal_line_id;
  if p_good > 0 then
    perform app.move_stock(rl.pending_stock_item_id, -p_good, 'inspect_good', 'return', r.id);
    perform app.move_stock(l.stock_item_id, p_good, 'inspect_good', 'return', r.id);
  end if;
  if p_scrap > 0 then
    v_scrap := app.scrap_row_for(r.org_id, l.stock_item_id, l.product_id);
    perform app.move_stock(rl.pending_stock_item_id, -p_scrap, 'inspect_scrap', 'return', r.id);
    perform app.move_stock(v_scrap, p_scrap, 'inspect_scrap', 'return', r.id);
  end if;
  update app.return_lines set qty_good = qty_good + p_good, qty_scrap = qty_scrap + p_scrap where id = rl.id;
end $$;
