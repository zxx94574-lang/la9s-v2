-- 经营总览改版 (待改 487–500 / 504–506, Frank 11-23): 库存看板 (件数 + 成本 + 库龄 + 四档价) / 在途 / 每日快照
-- 库龄: 从「我们收到货那天」开始算. 现有的货按先进先出, 算作最近进仓的那些 (入库流水 stock_moves.qty > 0, 退货回仓不算新货).

create or replace function app.dash_stock(p_org uuid)
returns table (stock_item_id uuid, product_id uuid, product_code text, model text, category text, warehouse text, wh_kind app.wh_kind,
  qty numeric, reserved numeric, unit_cost numeric, price_s numeric, price_w numeric, price_r numeric, price_p numeric,
  q0_30 numeric, q31_120 numeric, q120 numeric, oldest_days int, sold_90 numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare ps app.price_settings;
begin
  perform app.require_role(p_org, 'admin');
  select * into ps from app.price_settings where org_id = p_org;
  return query
  with ins as (
    select m.stock_item_id, m.qty, m.at,
      coalesce(sum(m.qty) over (partition by m.stock_item_id order by m.at desc, m.id desc rows between unbounded preceding and 1 preceding), 0) as before
    from app.stock_moves m join app.stock_items si on si.id = m.stock_item_id join app.products p on p.id = si.product_id
    where p.org_id = p_org and m.qty > 0 and m.reason not in ('return_in', 'inspect', 'unreserve', 'release')
  ), alloc as (
    select i.stock_item_id, i.at, greatest(0, least(i.qty, si.qty_on_hand - i.before)) as n
    from ins i join app.stock_items si on si.id = i.stock_item_id
  ), age as (
    select a.stock_item_id,
      sum(a.n) filter (where current_date - a.at::date <= 30) as q0_30,
      sum(a.n) filter (where current_date - a.at::date between 31 and 120) as q31_120,
      sum(a.n) filter (where current_date - a.at::date > 120) as q120,
      sum(a.n) as known, max(current_date - a.at::date) filter (where a.n > 0) as oldest
    from alloc a group by 1
  ), sold as (
    select dl.product_id, sum(sl.qty) as sold_90
    from app.shipment_lines sl join app.shipments sh on sh.id = sl.shipment_id and sh.voided_at is null
    join app.deal_lines dl on dl.id = sl.deal_line_id
    where sh.org_id = p_org and sh.shipped_at > now() - interval '90 days' group by 1
  )
  select si.id, p.id, p.code, p.model, cat.name, w.code, w.kind, si.qty_on_hand::numeric, si.qty_reserved::numeric,
    case when w.kind = 'fob' then app.landed_cost_at(p.rmb_cost, p.freight_xof, ps.rmb_per_xof_fob, ps.round_to)
         else app.landed_cost(p.rmb_cost, p.freight_xof, ps) end,
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'S' and pp.currency = 'XOF'),
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'WHOLESALE' and pp.currency = 'XOF'),
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'RETAIL' and pp.currency = 'XOF'),
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'REPAIR' and pp.currency = 'XOF'),
    coalesce(age.q0_30, 0)::numeric, coalesce(age.q31_120, 0)::numeric,
    -- 没有入库流水可对的那部分 (期初之前的老货) 一律算进「120 天以上」
    (coalesce(age.q120, 0) + greatest(0, si.qty_on_hand - coalesce(age.known, 0)))::numeric,
    age.oldest::int, coalesce(sold.sold_90, 0)::numeric
  from app.stock_items si
  join app.products p on p.id = si.product_id
  join app.warehouses w on w.id = si.warehouse_id
  left join app.categories cat on cat.id = p.category_id
  left join age on age.stock_item_id = si.id
  left join sold on sold.product_id = p.id
  where p.org_id = p_org and si.qty_on_hand > 0;
end $$;

-- 在途: 没收完的采购单, 一单一行. 成本按物料现在的到岸成本估 (单上有单价就用单上的).
create or replace function app.dash_transit(p_org uuid)
returns table (po_id uuid, po_no text, mode text, eta date, purpose text, pcs numeric, fob_pcs numeric, cost_xof numeric, nocost_pcs numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare ps app.price_settings;
begin
  perform app.require_role(p_org, 'admin');
  select * into ps from app.price_settings where org_id = p_org;
  return query
  select po.id, po.po_no, po.mode, po.eta, po.purpose,
    sum(l.qty - l.qty_received - l.closed_qty)::numeric,
    sum(least(l.qty - l.qty_received - l.closed_qty, l.fob_qty))::numeric,
    coalesce(sum((l.qty - l.qty_received - l.closed_qty) * app.landed_cost(coalesce(case when l.currency = 'CNY' then l.unit_price end, p.rmb_cost), p.freight_xof, ps)), 0)::numeric,
    coalesce(sum(l.qty - l.qty_received - l.closed_qty) filter (where coalesce(case when l.currency = 'CNY' then l.unit_price end, p.rmb_cost) is null), 0)::numeric
  from app.purchase_orders po join app.po_lines l on l.po_id = po.id left join app.products p on p.id = l.product_id
  where po.org_id = p_org and po.status = 'open' and l.qty - l.qty_received - l.closed_qty > 0
  group by po.id;
end $$;

-- 每日快照 (待改 489 / 498 的折线, 493「比上月底」): 一天一个 key 一行, 重复写不覆盖
create table if not exists app.dash_snapshots (
  org_id uuid not null references app.orgs(id),
  day date not null,
  key text not null,
  value numeric not null,
  primary key (org_id, day, key)
);
alter table app.dash_snapshots enable row level security;
drop policy if exists snap_read on app.dash_snapshots;
create policy snap_read on app.dash_snapshots for select using (app.has_role(org_id, array['admin']::app.role_name[]));

create or replace function app.dash_snap(p_org uuid, p_vals jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare k text; v jsonb;
begin
  perform app.require_role(p_org, 'admin');
  for k, v in select * from jsonb_each(p_vals) loop
    insert into app.dash_snapshots (org_id, day, key, value)
    values (p_org, (now() at time zone 'Africa/Abidjan')::date, k, (v #>> '{}')::numeric)
    on conflict (org_id, day, key) do update set value = excluded.value;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.dash_snapshots to authenticated;
    grant execute on function app.dash_stock(uuid), app.dash_transit(uuid), app.dash_snap(uuid, jsonb) to authenticated;
  end if;
end $$;
