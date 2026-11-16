-- 0049 (Frank 11-16 00:23–00:35 待改 328「要做就做起来」): 订单毛利 / 利润，只中方看
-- 口径 (Frank 定):
--   · 只算已出库的; 成本在出库那一刻锁定 (当时的到岸成本, 含物流, 和物料档案同一个算法)
--   · 毛利率 = 利润 ÷ 售价; 汇总一律加权 (总利润 ÷ 总销售额), 能按档位 / 种类 / 型号 / 客户 / 销售员 / 月份任意组合
--   · 事后变动全部算进这张单: 退货、收货差异冲减 / 抹零 / 核销、价格调整、我们出的运费、我们承担的收款手续费
--   · 整单级的钱 (调整、核销、运费、手续费) 按这张单各行的销售额比例分摊到行 → 按型号 / 种类看也加得起来
--   · 没有成本的型号不算进毛利率, 单独显示「成本缺失」
-- 不进金蝶、不改任何已有账; 只是读出来算.

-- 和 app.landed_cost 同一个算法, 只是汇率可以指定 (FOB 仓的货用 FOB 汇率)
create or replace function app.landed_cost_at(p_rmb numeric, p_freight numeric, p_rate numeric, p_round int)
returns numeric language sql immutable as $$
  select case when p_rmb is null or coalesce(p_rate, 0) = 0 then null
    else ceil((p_rmb / p_rate + coalesce(p_freight, 0)) / coalesce(nullif(p_round, 0), 1)) * coalesce(nullif(p_round, 0), 1) end
$$;

-- ① 出库那一刻锁定: 每片成本 + 当时客户档位
alter table app.shipment_lines add column unit_cost numeric(18,2), add column cost_src text, add column tier app.customer_tier;

create or replace function app.unit_cost_now(p_line uuid)
returns table (unit_cost numeric, tier app.customer_tier)
language sql stable security definer set search_path = app, public as $$
  select case when w.kind = 'fob'
           then app.landed_cost_at(p.rmb_cost, p.freight_xof, ps.rmb_per_xof_fob, ps.round_to)
           else app.landed_cost(p.rmb_cost, p.freight_xof, ps) end,
         c.tier
  from app.deal_lines dl
  join app.deals d on d.id = dl.deal_id
  join app.customers c on c.id = d.customer_id
  left join app.products p on p.id = dl.product_id
  left join app.stock_items si on si.id = dl.stock_item_id
  left join app.warehouses w on w.id = si.warehouse_id
  left join app.price_settings ps on ps.org_id = d.org_id
  where dl.id = p_line
$$;

create or replace function app.sl_lock_cost() returns trigger
language plpgsql security definer set search_path = app, public as $$
declare v record;
begin
  if new.unit_cost is null then
    select * into v from app.unit_cost_now(new.deal_line_id);
    new.unit_cost := v.unit_cost;
    new.cost_src := case when v.unit_cost is null then 'missing' else 'ship' end;
    new.tier := coalesce(new.tier, v.tier);
  end if;
  return new;
end $$;
create trigger sl_lock_cost before insert on app.shipment_lines for each row execute function app.sl_lock_cost();

-- 已经出过库的: 用现在的成本补一次 (标「补算」, 以后不再变)
update app.shipment_lines sl set unit_cost = v.unit_cost, tier = v.tier,
  cost_src = case when v.unit_cost is null then 'missing' else 'backfill' end
from app.shipment_lines x cross join lateral app.unit_cost_now(x.deal_line_id) v
where x.id = sl.id and sl.unit_cost is null;

-- ② 一行 = 一次出库的一个型号, 带上分摊好的事后变动. 只给中方.
create or replace function app.margin_rows(p_org uuid, p_deal uuid default null)
returns table (
  shipment_line_id uuid, deal_id uuid, biz_no text, shipped_on date, month text,
  customer_id uuid, customer_name text, customer_code text, supply text, tier app.customer_tier,
  owner_id uuid, owner_name text, product_id uuid, product_code text, model text, category text,
  qty numeric, sale numeric, returned numeric, adjust numeric, cost_goods numeric, freight numeric, fee numeric,
  revenue numeric, cost numeric, profit numeric, cost_missing boolean, cost_src text)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  with ps as (select * from app.price_settings where org_id = p_org),
  fx as (   -- 每张单折成 XOF 的系数
    select d.id as deal_id,
      case when d.currency = 'XOF' then 1::numeric
           when coalesce(d.fx_rate, 0) > 0 then d.fx_rate
           when d.currency = 'CNY' then 1 / nullif((select rmb_per_xof from ps), 0)
           when d.currency = 'USD' then (select xof_per_usd from ps)
           else 1 end as k
    from app.deals d where d.org_id = p_org and (p_deal is null or d.id = p_deal)),
  sl as (
    select x.id, sh.deal_id, x.deal_line_id, sh.shipped_at::date as shipped_on, x.qty::numeric as qty,
      x.amount * f.k as sale, x.unit_cost, x.cost_src, x.tier
    from app.shipment_lines x join app.shipments sh on sh.id = x.shipment_id join fx f on f.deal_id = sh.deal_id
    where sh.voided_at is null),
  line_tot as (select deal_line_id, sum(qty) as q from sl group by 1),
  ret as (   -- 批准的退货, 按这个型号各次出库的片数分摊; 成本按锁定的单价退回
    select rl.deal_line_id, sum(rl.qty)::numeric as q, sum(rl.qty * rl.unit_price * f.k) as amt
    from app.return_lines rl join app.returns r on r.id = rl.return_id join fx f on f.deal_id = r.deal_id
    where r.status = 'approved' group by 1),
  deal_x as (   -- 整单级: 调整 / 核销 (改的是收入), 运费 / 手续费 (加的是成本)
    select f.deal_id,
      coalesce((select sum(e.amount) from app.ar_entries e where e.deal_id = f.deal_id and e.kind in ('adjust','writeoff')), 0) * f.k as adj,
      coalesce((select sum(sh.freight_amount) from app.shipments sh where sh.deal_id = f.deal_id and sh.voided_at is null
                 and sh.freight_bearer in ('company','company_part') and sh.freight_paid_at is not null), 0) as freight,
      coalesce((select sum(a.amount / nullif(r.converted, 0) * r.fee * r.rate) from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id
                 where a.deal_id = f.deal_id and r.voided_at is null and r.fee > 0 and r.fee_bearer = 'company'), 0) * f.k as fee
    from fx f),
  deal_sale as (select deal_id, sum(sale) as s from sl group by 1),
  rows_ as (
    select sl.*,
      coalesce(rt.amt * sl.qty / nullif(lt.q, 0), 0) as returned,
      coalesce(rt.q * sl.qty / nullif(lt.q, 0), 0) as rq,
      coalesce(dx.adj * sl.sale / nullif(ds.s, 0), 0) as adjust,
      coalesce(dx.freight * sl.sale / nullif(ds.s, 0), 0) as freight,
      coalesce(dx.fee * sl.sale / nullif(ds.s, 0), 0) as fee
    from sl
    left join line_tot lt on lt.deal_line_id = sl.deal_line_id
    left join ret rt on rt.deal_line_id = sl.deal_line_id
    left join deal_x dx on dx.deal_id = sl.deal_id
    left join deal_sale ds on ds.deal_id = sl.deal_id)
  select r.id, r.deal_id, d.biz_no, r.shipped_on, to_char(r.shipped_on, 'YYYY-MM'),
    c.id, c.name, c.code, coalesce(c.supply, 'local'), coalesce(r.tier, c.tier),
    d.owner_employee_id, coalesce(e.short_name, e.full_name), p.id, p.code, coalesce(p.model, dl.req_model), cat.name,
    r.qty - r.rq, round(r.sale, 2), round(r.returned, 2), round(r.adjust, 2),
    round(r.unit_cost * (r.qty - r.rq), 2), round(r.freight, 2), round(r.fee, 2),
    round(r.sale - r.returned + r.adjust, 2),
    case when r.unit_cost is null then null else round(r.unit_cost * (r.qty - r.rq) + r.freight + r.fee, 2) end,
    case when r.unit_cost is null then null else round(r.sale - r.returned + r.adjust - r.unit_cost * (r.qty - r.rq) - r.freight - r.fee, 2) end,
    r.unit_cost is null, r.cost_src
  from rows_ r
  join app.deals d on d.id = r.deal_id
  join app.customers c on c.id = d.customer_id
  join app.deal_lines dl on dl.id = r.deal_line_id
  left join app.products p on p.id = dl.product_id
  left join app.categories cat on cat.id = coalesce(p.category_id, dl.req_category_id)
  left join app.employees e on e.id = d.owner_employee_id
  order by r.shipped_on desc, d.biz_no;
end $$;

-- ③ 还没出库的单: 按现在的成本预估 (报价 / 销售订单阶段中方看着定价用)
create or replace function app.deal_margin_estimate(p_deal uuid)
returns table (deal_line_id uuid, model text, category text, qty numeric, sale numeric, unit_cost numeric, cost numeric, profit numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare d app.deals; k numeric;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'admin');
  k := case when d.currency = 'XOF' then 1 when coalesce(d.fx_rate, 0) > 0 then d.fx_rate else null end;
  return query
  select dl.id, coalesce(p.model, dl.req_model), cat.name,
    (case when dl.qty_supply > 0 then dl.qty_supply else dl.qty_req end)::numeric,
    round((case when dl.qty_supply > 0 then dl.qty_supply else dl.qty_req end) * coalesce(dl.unit_price, 0) * k, 2),
    u.unit_cost,
    round(u.unit_cost * (case when dl.qty_supply > 0 then dl.qty_supply else dl.qty_req end), 2),
    round((case when dl.qty_supply > 0 then dl.qty_supply else dl.qty_req end) * (coalesce(dl.unit_price, 0) * k - u.unit_cost), 2)
  from app.deal_lines dl
  left join app.products p on p.id = dl.product_id
  left join app.categories cat on cat.id = coalesce(p.category_id, dl.req_category_id)
  cross join lateral app.unit_cost_now(dl.id) u
  where dl.deal_id = p_deal order by dl.seq;
end $$;

-- ④ 库存毛利: 每个可卖的库存行 × 四档价 (XOF), 成本 = 现在的到岸成本; 前端按档位 / 种类加权
create or replace function app.stock_margin(p_org uuid)
returns table (stock_item_id uuid, product_id uuid, product_code text, model text, category text, warehouse text, wh_kind app.wh_kind,
  qty numeric, unit_cost numeric, price_s numeric, price_w numeric, price_r numeric, price_p numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare ps app.price_settings;
begin
  perform app.require_role(p_org, 'admin');
  select * into ps from app.price_settings where org_id = p_org;
  return query
  select si.id, p.id, p.code, p.model, cat.name, w.code, w.kind, si.qty_on_hand::numeric,
    case when w.kind = 'fob' then app.landed_cost_at(p.rmb_cost, p.freight_xof, ps.rmb_per_xof_fob, ps.round_to)
         else app.landed_cost(p.rmb_cost, p.freight_xof, ps) end,
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'S' and pp.currency = 'XOF'),
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'WHOLESALE' and pp.currency = 'XOF'),
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'RETAIL' and pp.currency = 'XOF'),
    (select price from app.product_prices pp where pp.product_id = p.id and pp.tier = 'REPAIR' and pp.currency = 'XOF')
  from app.stock_items si
  join app.products p on p.id = si.product_id
  join app.warehouses w on w.id = si.warehouse_id
  left join app.categories cat on cat.id = p.category_id
  where p.org_id = p_org and si.qty_on_hand > 0 and w.kind in ('local','fob');
end $$;

do $$
begin
  revoke all on function app.unit_cost_now(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.margin_rows(uuid, uuid), app.deal_margin_estimate(uuid), app.stock_margin(uuid) to authenticated;
  end if;
end $$;
