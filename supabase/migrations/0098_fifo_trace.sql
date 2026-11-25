-- 0098 先进先出底层 + 追溯（Frank 11-25：可回溯性）
-- app.fifo_alloc：每个编码的批次（采购单）和出库行按时间排队对上 —— 一行 = 「某批的几片卖在了某张出库单的某一行」。
-- 退货（已批准）从那条订单行最后几次出库里扣掉，扣掉的片数回到队伍里被后面的出库再卖。
-- 比该编码最早一批还早的出库不算（卖的是建批次以前的老库存）。
-- 用它的：po_profit（按采购单利润，现在扣退货）、po_trace（这单卖给了谁）、deal_line_sources（订单每行来自哪张采购单）。
create or replace function app.fifo_alloc(p_org uuid)
returns table (batch_id uuid, po_no text, product_id uuid, shipment_line_id uuid, qty int, px numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  return query
  with ps as (select coalesce((select rmb_per_xof from app.price_settings where org_id = p_org), 0.0107) as rmb_per_xof,
                     coalesce((select xof_per_usd from app.price_settings where org_id = p_org), 600) as xof_per_usd),
  b as (
    select pb.id, pb.product_id, coalesce(nullif(pb.po_no, ''), '（没写单号）') as po_no, pb.qty,
      sum(pb.qty) over (partition by pb.product_id order by pb.ordered_on nulls last, pb.created_at, pb.id) - pb.qty as a
    from app.product_batches pb where pb.org_id = p_org),
  ret as (select rl.deal_line_id, sum(rl.qty) as rq from app.return_lines rl join app.returns r on r.id = rl.return_id
          where r.org_id = p_org and r.status = 'approved' group by rl.deal_line_id),
  s0 as (
    select sl.id, l.product_id, sl.qty, x.shipped_at, sl.deal_line_id,
      sl.unit_price * case d.currency when 'XOF' then 1 when 'USD' then ps.xof_per_usd else 1 / ps.rmb_per_xof end as px,
      coalesce(sum(sl.qty) over (partition by sl.deal_line_id order by x.shipped_at desc, sl.id desc rows between unbounded preceding and 1 preceding), 0) as later
    from app.shipment_lines sl join app.shipments x on x.id = sl.shipment_id join app.deals d on d.id = x.deal_id
      join app.deal_lines l on l.id = sl.deal_line_id cross join ps
    where x.org_id = p_org),
  s1 as (select s0.*, (s0.qty - least(s0.qty, greatest(0, coalesce(ret.rq, 0) - s0.later)))::int as q from s0 left join ret on ret.deal_line_id = s0.deal_line_id),
  -- 比这个编码最早一批货下单还早的出库，卖的是有批次以前的老库存，不算进任何采购单
  first_b as (select pb.product_id, min(pb.ordered_on) as d0 from app.product_batches pb where pb.org_id = p_org group by pb.product_id),
  s as (select s1.*, sum(s1.q) over (partition by s1.product_id order by s1.shipped_at, s1.id) - s1.q as a
        from s1 left join first_b fb on fb.product_id = s1.product_id where s1.q > 0 and (fb.d0 is null or s1.shipped_at >= fb.d0))
  select b.id, b.po_no, b.product_id, s.id, (least(b.a + b.qty, s.a + s.q) - greatest(b.a, s.a))::int, s.px
  from b join s on s.product_id = b.product_id and s.a < b.a + b.qty and s.a + s.q > b.a;
end $$;
revoke execute on function app.fifo_alloc(uuid) from public;

create or replace function app.po_profit(p_org uuid, p_po text default null)
returns table (po_no text, product_id uuid, code text, category text, model text, ordered_on date,
  qty int, unit_cost numeric, sold int, revenue numeric, cost_sold numeric, left_qty int, last_sold timestamptz, rate_basis text,
  unit_price numeric, currency text, freight_xof numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  with ps as (select coalesce((select rmb_per_xof from app.price_settings where org_id = p_org), 0.0107) as rmb_per_xof,
                     coalesce((select xof_per_usd from app.price_settings where org_id = p_org), 600) as xof_per_usd),
  b as (
    select pb.id, pb.product_id, coalesce(nullif(pb.po_no, ''), '（没写单号）') as po_no, pb.ordered_on, pb.qty, pb.unit_price as up, pb.currency as cur,
      coalesce(pb.freight_xof, case when pb.freight_pieces > 0 then pb.freight_total / pb.freight_pieces end, p.freight_xof, 0) as fx,
      case when pb.currency = 'XOF' then pb.unit_price when pb.pay_rate > 0 then pb.unit_price * pb.pay_rate
           when pb.currency = 'USD' then pb.unit_price * ps.xof_per_usd else pb.unit_price / ps.rmb_per_xof end as px0,
      case when pb.currency = 'XOF' then '西法' when pb.pay_rate > 0 then '付款汇率' else '现在定价汇率' end as rate_basis
    from app.product_batches pb cross join ps join app.products p on p.id = pb.product_id where pb.org_id = p_org),
  m as (select f.batch_id, sum(f.qty)::int as sold, sum(f.qty * f.px) as revenue, max(x.shipped_at) as last_sold
        from app.fifo_alloc(p_org) f join app.shipment_lines sl on sl.id = f.shipment_line_id join app.shipments x on x.id = sl.shipment_id group by f.batch_id)
  select b.po_no, b.product_id, p.code, c.name, p.model, b.ordered_on, b.qty, round(b.px0 + b.fx), coalesce(m.sold, 0),
    round(coalesce(m.revenue, 0)), round((b.px0 + b.fx) * coalesce(m.sold, 0)), (b.qty - coalesce(m.sold, 0))::int, m.last_sold, b.rate_basis,
    b.up, b.cur, round(b.fx)
  from b left join m on m.batch_id = b.id join app.products p on p.id = b.product_id join app.categories c on c.id = p.category_id
  where p_po is null or b.po_no = p_po
  order by b.ordered_on desc nulls last, b.po_no, p.code;
end $$;

-- 这张采购单的货卖给了谁（哪张出库单、哪个客户、几片、什么价）
create or replace function app.po_trace(p_org uuid, p_po text)
returns table (product_id uuid, code text, model text, deal_id uuid, biz_no text, out_no text, shipped_at timestamptz,
  customer_id uuid, customer text, qty int, px numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  select f.product_id, p.code, p.model, d.id, d.biz_no, x.out_no, x.shipped_at, c.id, c.name, f.qty, round(f.px)
  from app.fifo_alloc(p_org) f join app.shipment_lines sl on sl.id = f.shipment_line_id join app.shipments x on x.id = sl.shipment_id
    join app.deals d on d.id = x.deal_id join app.customers c on c.id = d.customer_id join app.products p on p.id = f.product_id
  where f.po_no = p_po order by x.shipped_at desc, p.code;
end $$;

-- 一张订单每一行的货来自哪张采购单（中方看；员工看不到成本，所以只给中方）
create or replace function app.deal_line_sources(p_deal uuid)
returns table (deal_line_id uuid, po_no text, qty int)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare v_org uuid;
begin
  select org_id into v_org from app.deals where id = p_deal;
  perform app.require_role(v_org, 'admin');
  return query
  select sl.deal_line_id, f.po_no, sum(f.qty)::int from app.fifo_alloc(v_org) f join app.shipment_lines sl on sl.id = f.shipment_line_id
    join app.shipments x on x.id = sl.shipment_id where x.deal_id = p_deal group by sl.deal_line_id, f.po_no order by 2;
end $$;
