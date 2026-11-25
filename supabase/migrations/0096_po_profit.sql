-- 0096 按采购单号看利润（Frank 11-25：利润最好可以直接选对应的采购订单号看）
-- 每个编码的批次按先进先出排队（下单日期 → 录入时间），出库也按时间排队；某批的第 a..b 片卖给了哪几张出库单，就按那几张单的单价算收入。
-- 成本 / 片 = 采购价按付款汇率换西法（没填付款汇率用现在的定价汇率）+ 这批每片运费（没填用物料默认运费）。
-- 只算出库，不扣退货（退货回原仓以后会再卖出去）。只中方能看。
create or replace function app.po_profit(p_org uuid, p_po text default null)
returns table (po_no text, product_id uuid, code text, category text, model text, ordered_on date,
  qty int, unit_cost numeric, sold int, revenue numeric, cost_sold numeric, left_qty int, last_sold timestamptz, rate_basis text,
  unit_price numeric, currency text, freight_xof numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  with ps as (select coalesce((select rmb_per_xof from app.price_settings where org_id = p_org), 0.0107) as rmb_per_xof, coalesce((select xof_per_usd from app.price_settings where org_id = p_org), 600) as xof_per_usd),
  b as (
    select pb.id, pb.product_id, coalesce(nullif(pb.po_no, ''), '（没写单号）') as po_no, pb.ordered_on, pb.qty,
      (case when pb.currency = 'XOF' then pb.unit_price
            when pb.pay_rate > 0 then pb.unit_price * pb.pay_rate
            when pb.currency = 'USD' then pb.unit_price * ps.xof_per_usd
            else pb.unit_price / ps.rmb_per_xof end)
      + coalesce(pb.freight_xof, case when pb.freight_pieces > 0 then pb.freight_total / pb.freight_pieces end, p.freight_xof, 0) as unit_cost,
      coalesce(pb.freight_xof, case when pb.freight_pieces > 0 then pb.freight_total / pb.freight_pieces end, p.freight_xof, 0) as fx, pb.unit_price as up, pb.currency as cur,
      case when pb.currency = 'XOF' then '西法' when pb.pay_rate > 0 then '付款汇率' else '现在定价汇率' end as rate_basis,
      sum(pb.qty) over (partition by pb.product_id order by pb.ordered_on nulls last, pb.created_at, pb.id) - pb.qty as a
    from app.product_batches pb cross join ps join app.products p on p.id = pb.product_id
    where pb.org_id = p_org),
  s as (
    select l.product_id, sl.qty, x.shipped_at,
      sl.unit_price * case d.currency when 'XOF' then 1 when 'USD' then ps.xof_per_usd else 1 / ps.rmb_per_xof end as px,
      sum(sl.qty) over (partition by l.product_id order by x.shipped_at, sl.id) - sl.qty as a
    from app.shipment_lines sl join app.shipments x on x.id = sl.shipment_id join app.deals d on d.id = x.deal_id
      join app.deal_lines l on l.id = sl.deal_line_id cross join ps
    where x.org_id = p_org and l.product_id in (select product_id from b)),
  m as (
    select b.id, sum(greatest(0, least(b.a + b.qty, s.a + s.qty) - greatest(b.a, s.a)))::int as sold,
      sum(greatest(0, least(b.a + b.qty, s.a + s.qty) - greatest(b.a, s.a)) * s.px) as revenue,
      max(s.shipped_at) filter (where least(b.a + b.qty, s.a + s.qty) > greatest(b.a, s.a)) as last_sold
    from b left join s on s.product_id = b.product_id and s.a < b.a + b.qty and s.a + s.qty > b.a
    group by b.id)
  select b.po_no, b.product_id, p.code, c.name, p.model, b.ordered_on, b.qty, round(b.unit_cost), coalesce(m.sold, 0)::int,
    round(coalesce(m.revenue, 0)), round(b.unit_cost * coalesce(m.sold, 0)), (b.qty - coalesce(m.sold, 0))::int, m.last_sold, b.rate_basis, b.up, b.cur, round(b.fx)
  from b join m on m.id = b.id join app.products p on p.id = b.product_id join app.categories c on c.id = p.category_id
  where p_po is null or b.po_no = p_po
  order by b.ordered_on desc nulls last, b.po_no, p.code;
end $$;
