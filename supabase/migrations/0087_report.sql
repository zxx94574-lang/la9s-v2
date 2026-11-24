-- 月报 (待改 496 / 498 / 499): 库存按「入库那一层」给出库龄天数, 分几段由前端按设置切 (国内 7 段 / 看板 3 段都从这里出)
create or replace function app.dash_stock_layers(p_org uuid)
returns table (stock_item_id uuid, product_id uuid, category text, warehouse text, wh_kind app.wh_kind, unit_cost numeric, age_days int, qty numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare ps app.price_settings;
begin
  perform app.require_role(p_org, 'admin');
  select * into ps from app.price_settings where org_id = p_org;
  return query
  with base as (
    select si.id, p.id as pid, cat.name as cat, w.code as wh, w.kind, si.qty_on_hand,
      case when w.kind = 'fob' then app.landed_cost_at(p.rmb_cost, p.freight_xof, ps.rmb_per_xof_fob, ps.round_to) else app.landed_cost(p.rmb_cost, p.freight_xof, ps) end as uc
    from app.stock_items si join app.products p on p.id = si.product_id join app.warehouses w on w.id = si.warehouse_id
    left join app.categories cat on cat.id = p.category_id
    where p.org_id = p_org and si.qty_on_hand > 0 and w.kind in ('local', 'fob')),
  ins as (
    select m.stock_item_id, m.qty, m.at,
      coalesce(sum(m.qty) over (partition by m.stock_item_id order by m.at desc, m.id desc rows between unbounded preceding and 1 preceding), 0) as before
    from app.stock_moves m join base b on b.id = m.stock_item_id
    where m.qty > 0 and m.reason not in ('return_in', 'inspect', 'unreserve', 'release')),
  lay as (
    select i.stock_item_id, (current_date - i.at::date)::int as age, greatest(0, least(i.qty, b.qty_on_hand - i.before))::numeric as n
    from ins i join base b on b.id = i.stock_item_id),
  known as (select stock_item_id, sum(n) as n from lay group by 1)
  select b.id, b.pid, b.cat, b.wh, b.kind, b.uc, l.age, l.n from lay l join base b on b.id = l.stock_item_id where l.n > 0
  union all
  -- 没有入库流水可对的老货: 库龄不知道 (age_days 空), 算最老的一段
  select b.id, b.pid, b.cat, b.wh, b.kind, b.uc, null::int, (b.qty_on_hand - coalesce(k.n, 0))::numeric
  from base b left join known k on k.stock_item_id = b.id where b.qty_on_hand - coalesce(k.n, 0) > 0;
end $$;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.dash_stock_layers(uuid) to authenticated;
  end if;
end $$;
