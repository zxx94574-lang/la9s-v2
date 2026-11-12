// Read-only SQL used by the UI. Writes never happen here — only through app.* business functions.
// Convention for list queries: $1 = org, $2 = from date (inclusive), $3 = to date (inclusive), 'YYYY-MM-DD'.

export const customers = `
select c.id, c.code, c.temp_code, c.name, c.city, c.tier, c.status, c.phone, c.supply, c.market, c.shop_type, c.contact_name, c.block_on_debt,
       e.short_name as owner
from app.customers c left join app.employees e on e.id = c.owner_employee_id
where c.org_id = $1
order by c.status, c.code nulls last, c.name`;

export const employees = `
select id, short_name, full_name, department, position, emp_no from app.employees where org_id = $1 and active order by department, short_name`;

export const categories = `select id, name from app.categories where org_id = $1 order by sort, name`;

// whole catalog with tier prices and local stock rows; the quote editor filters client-side
export const catalog = `
select p.id, p.code, p.model, p.variant, p.brand, p.shared_models, c.id as category_id, c.name as category,
  coalesce((select jsonb_object_agg(pp.tier, pp.price) from app.product_prices pp where pp.product_id = p.id and pp.currency = 'XOF'), '{}') as prices,
  coalesce((select jsonb_agg(jsonb_build_object('stock_item_id', s.id, 'warehouse', w.code, 'bin', s.bin,
            'on_hand', s.qty_on_hand, 'reserved', s.qty_reserved) order by w.code)
     from app.stock_items s join app.warehouses w on w.id = s.warehouse_id
     where s.product_id = p.id and w.kind = 'local'), '[]') as stock,
  -- 中方用: 最贵的到岸成本 (当前成本 vs 各采购批次, 按最新汇率), 判断「会亏」; 员工界面不显示
  (select greatest(
     case when p.rmb_cost is not null and ps.rmb_per_xof > 0 then round((p.rmb_cost / ps.rmb_per_xof + coalesce(p.freight_xof, 0)) / ps.round_to) * ps.round_to end,
     (select max(round(((case b.currency when 'USD' then b.unit_price * ps.xof_per_usd when 'XOF' then b.unit_price else b.unit_price / ps.rmb_per_xof end) + coalesce(b.freight_xof, p.freight_xof, 0)) / ps.round_to) * ps.round_to)
        from app.product_batches b where b.product_id = p.id))
   from app.price_settings ps where ps.org_id = p.org_id) as cost_xof
from app.products p join app.categories c on c.id = p.category_id
where p.org_id = $1 and p.active
order by c.sort, p.model`;

export const searchProducts = `
select p.id, p.code, p.model from app.products p where p.org_id = $1 and (p.model ilike $2 or p.code ilike $2) limit 20`;

const dealTotals = `
  (select coalesce(sum(l.qty_req),0) from app.deal_lines l where l.deal_id = d.id) as qty_req,
  (select coalesce(sum(l.qty_supply),0) from app.deal_lines l where l.deal_id = d.id) as qty_supply,
  (select count(*) from app.deal_lines l where l.deal_id = d.id) as line_count,
  (select coalesce(sum(case when d.status in ('quoted','hotline_ok') then l.qty_req else l.qty_supply end * l.unit_price),0)
     from app.deal_lines l where l.deal_id = d.id) as amount`;

export const orders = `
select d.id, d.biz_no, d.quote_no, d.pick_no, d.so_no, d.kind, d.status, d.currency, d.created_at, d.updated_at, d.planned_ship_date, d.urgent, d.staged_at, d.staged_photo, d.staged_note, (select count(*) from app.deal_events ev where ev.deal_id = d.id and ev.action = 'hotline_busy')::int as busy_n, d.approval, d.source, d.want_on, d.hotline_opened_at, d.hotline_busy_at,
  c.id as customer_id, coalesce(c.code, c.temp_code) as customer_code, c.name as customer_name, c.city, c.tier,
  (select string_agg(distinct coalesce(p.model, l.req_model), ' / ') from app.deal_lines l left join app.products p on p.id = l.product_id where l.deal_id = d.id) as models,
  ${dealTotals},
  t.first_shipped_at, t.shipped_amount, t.returned_amount, t.allocated_amount, t.shipped_amount - t.returned_amount - t.allocated_amount - t.writeoff_amount as due, t.writeoff_amount,
  (select coalesce(sum(a.amount), 0) from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id where a.deal_id = d.id and r.voided_at is null and a.at > r.created_at + interval '1 minute') as prepaid_used,
  (select count(*) from app.shipments sx where sx.deal_id = d.id and sx.voided_at is null and sx.customer_received_at is null)::int as unsigned_n,
  (select count(*) from app.returns rx where rx.deal_id = d.id and (rx.status = 'requested' or (rx.status = 'approved' and rx.reconciled_at is null)))::int as open_returns_n,
  app.balance_pending(d.id) as balance_pending,
  (select count(*) from app.shipments sf where sf.deal_id = d.id and sf.voided_at is null and sf.freight_bearer in ('company','company_part') and sf.freight_paid_at is null)::int as freight_due_n,
  (select count(*) from app.receipt_discrepancies rd where rd.deal_id = d.id and rd.status = 'open')::int as open_disc_n,
  (select coalesce(sum(rd.amount), 0) from app.receipt_discrepancies rd where rd.deal_id = d.id and rd.decision = 'credit') as disc_credit,
  (select short_name from app.employees oe where oe.id = d.owner_employee_id) as owner_name
from app.deals d
join app.customers c on c.id = d.customer_id
join app.v_deal_totals t on t.deal_id = d.id
where d.org_id = $1 and d.created_at >= $2::date and d.created_at < $3::date + 1
order by d.created_at desc`;

export const dealById = `
select d.*, c.code as customer_code, c.name as customer_name, c.city, c.tier, c.phone as customer_phone, c.contact_name as customer_contact, c.status as customer_status, c.temp_code,
  (select count(*) from app.shipments sx where sx.deal_id = d.id and sx.voided_at is null and sx.customer_received_at is null)::int as unsigned_n,
  (select count(*) from app.shipments sx where sx.deal_id = d.id and sx.voided_at is null)::int as live_shipments_n,
  (select count(*) from app.returns rx where rx.deal_id = d.id and (rx.status = 'requested' or (rx.status = 'approved' and rx.reconciled_at is null)))::int as open_returns_n,
  app.balance_pending(d.id) as balance_pending,
  (select count(*) from app.shipments sf where sf.deal_id = d.id and sf.voided_at is null and sf.freight_bearer in ('company','company_part') and sf.freight_paid_at is null)::int as freight_due_n,
  (select count(*) from app.receipt_discrepancies rd where rd.deal_id = d.id and rd.status = 'open')::int as open_disc_n,
  (select coalesce(sum(rd.amount), 0) from app.receipt_discrepancies rd where rd.deal_id = d.id and rd.decision = 'credit') as disc_credit,
  pe.short_name as picker_name, oe.short_name as owner_name, re.short_name as reviewer_name,
  (select count(*) from app.pick_checks pc join app.deal_lines pl on pl.id = pc.deal_line_id join app.deals pd on pd.id = pl.deal_id
     where pd.picker_employee_id = d.picker_employee_id and pc.result <> 'ok' and pc.at > now() - interval '30 days') as picker_errors,
  ${dealTotals},
  t.first_shipped_at, t.shipped_amount, t.returned_amount, t.allocated_amount, t.shipped_amount - t.returned_amount - t.allocated_amount - t.writeoff_amount as due, t.writeoff_amount,
  (select coalesce(sum(a.amount), 0) from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id where a.deal_id = d.id and r.voided_at is null and a.at > r.created_at + interval '1 minute') as prepaid_used,
  (select coalesce(sum(e.amount),0) from app.ar_entries e where e.customer_id = d.customer_id and e.currency = d.currency) as customer_balance
from app.deals d
join app.customers c on c.id = d.customer_id
join app.v_deal_totals t on t.deal_id = d.id
left join app.employees pe on pe.id = d.picker_employee_id
left join app.employees oe on oe.id = d.owner_employee_id
left join app.employees re on re.id = d.reviewer_employee_id
where d.id = $1`;

export const dealLines = `
select l.*, p.code, p.brand, coalesce(p.model, l.req_model) as model, p.variant, coalesce(c.name, rc.name) as category, p.shared_models,
  (select pp.price from app.product_prices pp where pp.product_id = l.product_id and pp.tier = cu.tier and pp.currency = dd.currency) as tier_price,
  (select pp.price from app.product_prices pp where pp.product_id = l.product_id and pp.tier = cu.tier and pp.currency = 'XOF') as tier_xof,
  (select pp.price from app.product_prices pp where pp.product_id = l.product_id and pp.tier = 'S' and pp.currency = 'XOF') as s_xof,
  dd.fx_rate,
  (select greatest(
     case when p.rmb_cost is not null and ps.rmb_per_xof > 0 then round((p.rmb_cost / ps.rmb_per_xof + coalesce(p.freight_xof, 0)) / ps.round_to) * ps.round_to end,
     (select max(round(((case b.currency when 'USD' then b.unit_price * ps.xof_per_usd when 'XOF' then b.unit_price else b.unit_price / ps.rmb_per_xof end) + coalesce(b.freight_xof, p.freight_xof, 0)) / ps.round_to) * ps.round_to)
        from app.product_batches b where b.product_id = p.id))
   from app.price_settings ps where ps.org_id = dd.org_id) as cost_xof,
  (select coalesce(jsonb_agg(jsonb_build_object('result', pc.result, 'note', pc.note, 'at', pc.at) order by pc.at), '[]') from app.pick_checks pc where pc.deal_line_id = l.id) as checks,
  w.code as warehouse, s.bin, s.qty_on_hand, s.qty_reserved, s.qty_on_hand - s.qty_reserved as qty_available
from app.deal_lines l
join app.deals dd on dd.id = l.deal_id
join app.customers cu on cu.id = dd.customer_id
left join app.products p on p.id = l.product_id
left join app.categories c on c.id = p.category_id
left join app.categories rc on rc.id = l.req_category_id
left join app.stock_items s on s.id = l.stock_item_id
left join app.warehouses w on w.id = s.warehouse_id
where l.deal_id = $1
order by l.seq`;

export const dealEvents = `
select e.at, e.action, e.detail, to_jsonb(m.roles::text[]) as roles, emp.short_name
from app.deal_events e
left join app.members m on m.user_id = e.user_id
left join app.employees emp on emp.id = m.employee_id
where e.deal_id = $1 order by e.at, e.id`;

export const dealShipments = `
select s.*, (select coalesce(sum(qty),0) from app.shipment_lines sl where sl.shipment_id = s.id) as qty,
  (select coalesce(jsonb_agg(jsonb_build_object('deal_line_id', sl.deal_line_id, 'qty', sl.qty)), '[]') from app.shipment_lines sl where sl.shipment_id = s.id) as lines,
  k.status as kingdee_status
from app.shipments s left join app.kingdee_outbox k on k.shipment_id = s.id
where s.deal_id = $1 order by s.shipped_at`;

export const dealReturns = `
select r.*, coalesce((select jsonb_agg(jsonb_build_object('id', rl.id, 'deal_line_id', rl.deal_line_id, 'qty', rl.qty,
    'unit_price', rl.unit_price, 'qty_good', rl.qty_good, 'qty_scrap', rl.qty_scrap,
    'model', coalesce(p.model, l.req_model), 'category', c.name, 'code', p.code) order by l.seq)
  from app.return_lines rl join app.deal_lines l on l.id = rl.deal_line_id
  left join app.products p on p.id = l.product_id left join app.categories c on c.id = p.category_id
  where rl.return_id = r.id), '[]') as lines
from app.returns r where r.deal_id = $1 order by r.requested_at`;

export const dealReceipts = `
select a.amount, a.at, r.id as receipt_id, r.id, r.rcv_no, r.received_on, r.method, r.amount as receipt_amount, r.currency, r.rate,
  r.verify_status, r.fee, r.fee_bearer, r.payer, r.collector_employee_id, r.handed_at, r.voided_at, r.proof_path, r.handed_proof, e.short_name as collector_name
from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id left join app.employees e on e.id = r.collector_employee_id
where a.deal_id = $1 order by a.at`;

export const dashboard = `
select
  (select coalesce(sum(s.amount),0) from app.shipments s where s.org_id = $1 and s.voided_at is null and s.shipped_at >= $2::date and s.shipped_at < $3::date + 1) as sales_amount,
  (select coalesce(sum(sl.qty),0) from app.shipments s join app.shipment_lines sl on sl.shipment_id = s.id
     where s.org_id = $1 and s.voided_at is null and s.shipped_at >= $2::date and s.shipped_at < $3::date + 1) as sales_qty,
  (select count(*) from app.shipments s where s.org_id = $1 and s.voided_at is null and s.shipped_at >= $2::date and s.shipped_at < $3::date + 1) as ship_count,
  (select count(distinct s.deal_id) from app.shipments s where s.org_id = $1 and s.voided_at is null and s.shipped_at >= $2::date and s.shipped_at < $3::date + 1) as order_count,
  (select coalesce(sum(r.converted),0) from app.receipts r where r.org_id = $1 and r.voided_at is null and r.account_currency = 'XOF'
     and r.received_on >= $2::date and r.received_on <= $3::date) as receipts_amount,
  (select count(*) from app.receipts r where r.org_id = $1 and r.voided_at is null and r.received_on >= $2::date and r.received_on <= $3::date) as receipt_count,
  (select coalesce(sum(r.amount),0) from app.returns r where r.org_id = $1 and r.status = 'approved'
     and r.decided_at >= $2::date and r.decided_at < $3::date + 1) as returns_amount,
  (select coalesce(sum(b.balance),0) from app.v_customer_balance b where b.org_id = $1 and b.currency = 'XOF' and b.balance > 0) as debt_total,
  (select count(*) from app.v_customer_balance b where b.org_id = $1 and b.currency = 'XOF' and b.balance > 0) as debtor_count,
  (select coalesce(-sum(b.balance),0) from app.v_customer_balance b where b.org_id = $1 and b.currency = 'XOF' and b.balance < 0) as prepaid_total,
  (select count(*) from app.deals d where d.org_id = $1 and d.status in ('reviewed','partial')) as to_ship,
  (select count(*) from app.deals d where d.org_id = $1 and d.status in ('picking','picked','confirmed')) as in_picking`;

// 销售明细：一行一个出库单（= 一个订单的一次出库）
export const dashSales = `
select s.id, s.out_no, s.shipped_at, d.id as deal_id, d.biz_no, c.code as customer_code, c.name as customer_name, c.city, c.tier,
  (select count(*) from app.shipment_lines sl where sl.shipment_id = s.id) as models,
  (select coalesce(sum(qty),0) from app.shipment_lines sl where sl.shipment_id = s.id) as qty,
  s.amount, d.currency
from app.shipments s join app.deals d on d.id = s.deal_id join app.customers c on c.id = d.customer_id
where s.org_id = $1 and s.voided_at is null and s.shipped_at >= $2::date and s.shipped_at < $3::date + 1
order by s.shipped_at desc`;

export const dashWarehouse = `
select s.id, s.out_no, s.shipped_at, s.method, s.contact_phone, d.id as deal_id, d.biz_no, d.pick_no,
  c.name as customer_name, c.city, pe.short_name as picker,
  (select coalesce(sum(qty),0) from app.shipment_lines sl where sl.shipment_id = s.id) as qty,
  s.customer_received_at, k.status as kingdee_status
from app.shipments s join app.deals d on d.id = s.deal_id join app.customers c on c.id = d.customer_id
left join app.employees pe on pe.id = d.picker_employee_id
left join app.kingdee_outbox k on k.shipment_id = s.id
where s.org_id = $1 and s.voided_at is null and s.shipped_at >= $2::date and s.shipped_at < $3::date + 1
order by s.shipped_at desc`;

export const receipts = `
select r.id, r.rcv_no, r.received_on, r.amount, r.currency, r.account_currency, r.rate, r.converted, r.method, r.note, r.proof_path, r.voided_at, r.void_reason,
  r.verify_status, r.landed, r.fee, r.fee_bearer, r.payer, r.collector_employee_id, r.handed_at, r.created_by, ce.short_name as collector_name, ca.name as account_name,
  c.id as customer_id, c.code as customer_code, c.name as customer_name, c.city,
  o.unallocated,
  (select coalesce(jsonb_agg(jsonb_build_object('biz_no', d.biz_no, 'deal_id', d.id, 'amount', a.amount) order by a.at), '[]')
     from app.receipt_allocations a join app.deals d on d.id = a.deal_id where a.receipt_id = r.id) as allocations
from app.receipts r join app.customers c on c.id = r.customer_id join app.v_receipt_open o on o.id = r.id
left join app.employees ce on ce.id = r.collector_employee_id left join app.cash_accounts ca on ca.id = r.account_id
where r.org_id = $1 and r.received_on >= $2::date and r.received_on <= $3::date
order by r.received_on desc, r.created_at desc`;

// 客户总账：累计购买 / 已付 / 退货 / 欠款（负数 = 预付）
export const balances = `
select c.id, c.code, c.name, c.city, c.tier, e.short_name as owner,
  coalesce(b.total_sold,0) as total_sold, coalesce(b.total_paid,0) as total_paid,
  coalesce(b.total_returned,0) as total_returned, coalesce(b.total_writeoff,0) as total_writeoff, coalesce(b.balance,0) as balance,
  (select max(s.shipped_at) from app.shipments s join app.deals d on d.id = s.deal_id where d.customer_id = c.id and s.voided_at is null) as last_shipped,
  ag.d0_30, ag.d31_60, ag.d61_90, ag.d91_180, ag.d180, ag.oldest_days, c.credit_days, c.credit_limit, c.has_agreement
from app.customers c
left join app.v_customer_balance b on b.customer_id = c.id and b.currency = 'XOF'
left join app.v_ar_aging ag on ag.customer_id = c.id and ag.currency = 'XOF'
left join app.employees e on e.id = c.owner_employee_id
where c.org_id = $1 and c.status = 'active'
order by coalesce(b.balance,0) desc, c.code`;

export const customerBalance = `
select c.id, c.code, c.name, c.city, c.tier,
  coalesce(b.total_sold,0) as total_sold, coalesce(b.total_paid,0) as total_paid,
  coalesce(b.total_returned,0) as total_returned, coalesce(b.total_writeoff,0) as total_writeoff, coalesce(b.balance,0) as balance
from app.customers c left join app.v_customer_balance b on b.customer_id = c.id and b.currency = $2
where c.id = $1`;

export const customerLedger = `
select x.*, sum(x.amount) over (order by x.eff_at, x.id) as running from (
  select e.id, case when e.kind = 'receipt' then r.received_on::timestamptz else e.at end as eff_at, e.at, e.kind, e.amount, e.currency, e.note,
    d.biz_no, d.id as deal_id, coalesce(s.out_no, r.rcv_no, rt.rt_no) as doc_no
  from app.ar_entries e
  left join app.deals d on d.id = e.deal_id
  left join app.shipments s on s.id = e.ref_id and e.kind in ('shipment','void')
  left join app.receipts r on r.id = e.ref_id and e.kind = 'receipt'
  left join app.returns rt on rt.id = e.ref_id and e.kind = 'return'
  where e.customer_id = $1 and e.currency = coalesce($2, 'XOF')
) x
order by x.eff_at, x.id`;

export const customerOpenDeals = `
select t.deal_id, d.biz_no, d.kind, d.currency, t.first_shipped_at, t.shipped_amount, t.returned_amount, t.allocated_amount, t.writeoff_amount, t.due
from app.v_deal_due t join app.deals d on d.id = t.deal_id
where t.customer_id = $1 and t.currency = coalesce($2, 'XOF') and t.due > 0 and t.status <> 'cancelled'
order by coalesce(t.first_shipped_at, '-infinity'::timestamptz), t.deal_id`;

export const stock = `
select v.*, w.name as warehouse_name from app.v_stock v join app.warehouses w on w.code = v.warehouse and w.org_id = v.org_id
where v.org_id = $1
order by case v.warehouse_kind when 'local' then 0 when 'fob' then 1 else 2 end, v.warehouse, v.category, v.model`;

export const unmet = `
select u.*, c.code as customer_code, coalesce(c.code, c.temp_code) as cust_code, c.name as customer_name, c.city, c.status as customer_status, cat.name as category,
  d.source, oe.short_name as owner_name, oe.emp_no as owner_no
from app.v_unmet_demand u join app.customers c on c.id = u.customer_id
join app.deals d on d.id = u.deal_id left join app.employees oe on oe.id = d.owner_employee_id
left join app.categories cat on cat.id = u.category_id
where u.org_id = $1
order by u.kind, u.created_at desc`;


// 已结清（出过库、未付 = 0）
export const customerSettledDeals = `
select t.deal_id, d.biz_no, d.kind, d.currency, t.first_shipped_at, t.shipped_amount, t.returned_amount, t.allocated_amount, t.writeoff_amount, t.due
from app.v_deal_due t join app.deals d on d.id = t.deal_id
where t.customer_id = $1 and t.currency = coalesce($2, 'XOF') and t.due <= 0 and t.shipped_amount > 0 and t.status <> 'cancelled'
order by t.first_shipped_at desc nulls last`;

// customers that have deals in another currency than XOF (cross-currency receipts)
export const customerCurrencies = `
select distinct d.currency from app.deals d where d.customer_id = $1 order by 1`;

// all shipped lines of a customer for one product: cross-order return (待改 41), newest first
export const customerReturnable = `
select l.id as line_id, l.deal_id, d.biz_no, l.product_id, p.code, p.model, c.name as category, l.unit_price, d.currency,
  l.qty_shipped, l.qty_returned,
  coalesce((select sum(rl.qty) from app.return_lines rl join app.returns r on r.id = rl.return_id where rl.deal_line_id = l.id and r.status = 'requested'), 0) as qty_pending,
  (select max(s.shipped_at) from app.shipments s where s.deal_id = d.id and s.voided_at is null) as last_shipped
from app.deal_lines l join app.deals d on d.id = l.deal_id
join app.products p on p.id = l.product_id join app.categories c on c.id = p.category_id
where d.customer_id = $1 and l.qty_shipped > l.qty_returned
order by last_shipped desc, d.biz_no desc`;

// returns for a customer (reconciliation list)
export const customerReturns = `
select r.id, r.rt_no, r.batch_no, r.status, r.amount, r.reason, r.reason_type, r.requested_at, r.decided_at, d.biz_no, d.id as deal_id, d.currency
from app.returns r join app.deals d on d.id = r.deal_id where d.customer_id = $1 order by r.requested_at desc`;

// cancelled = 作废 list (待改 16)
// 229: 订单行 (按机型看 / 按机型筛): 口径 = 已出库数量 − 已退货, 金额按成交价
export const orderLines = `
select l.deal_id, coalesce(p.model, l.req_model) as model, cat.name as category, p.code, p.id as product_id,
  l.qty_req, l.qty_supply, l.qty_shipped, l.qty_returned, l.unit_price
from app.deal_lines l join app.deals d on d.id = l.deal_id
left join app.products p on p.id = l.product_id left join app.categories cat on cat.id = coalesce(p.category_id, l.req_category_id)
where d.org_id = $1 and d.kind = 'normal' and d.created_at >= $2::date and d.created_at < ($3::date + 1)`;
export const voidedDeals = `
select d.id, d.biz_no, d.updated_at, c.name as customer_name, c.code as customer_code,
  (select e.detail->>'reason' from app.deal_events e where e.deal_id = d.id and e.action = 'cancelled' order by e.at desc limit 1) as reason
from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.status = 'cancelled' order by d.updated_at desc`;

// material names: products + unmet req models matching a keyword (待改 9)
export const materialSearch = `
select 'product' as src, p.id, p.code, p.model, p.brand, c.id as category_id, c.name as category, p.shared_models, null::bigint as asked
from app.products p join app.categories c on c.id = p.category_id
where p.org_id = $1 and ($2 = '' or p.model ilike '%' || $2 || '%' or array_to_string(p.shared_models, ' ') ilike '%' || $2 || '%')
union all
select 'unmet', null, null, l.req_model, null, c.id, c.name, null, count(*)
from app.deal_lines l join app.deals d on d.id = l.deal_id join app.categories c on c.id = l.req_category_id
where d.org_id = $1 and l.product_id is null and ($2 = '' or l.req_model ilike '%' || $2 || '%')
group by l.req_model, c.id, c.name
order by 7, 4`;

// duplicate proof image detection (待改 26): same image payload used on another document
export const proofUses = `
select doc from (
  select d.biz_no || ' 找货照片' as doc, d.pick_photo_path as p from app.deals d where d.org_id = $1
  union all select d.biz_no || ' 复核照片', d.review_photo_path from app.deals d where d.org_id = $1
  union all select d.biz_no || ' 热线凭证', d.hotline_proof from app.deals d where d.org_id = $1
  union all select d.biz_no || ' 客户确认截图', d.confirm_proof from app.deals d where d.org_id = $1
  union all select s.out_no || ' 出库凭证', s.proof_path from app.shipments s where s.org_id = $1
  union all select r.rcv_no || ' 收款凭证', r.proof_path from app.receipts r where r.org_id = $1
) x where p is not null and split_part(p, 'base64,', 2) = $2 limit 3`;

// 物料与定价 (中方): cost side + the four tier prices (locked = 一口价)
export const productsPricing = `
select p.id, p.code, p.model, p.variant, p.kingdee_name, p.brand, p.brand_group, p.cost_owner, c.name as category, p.shared_models,
  p.rmb_cost, p.freight_xof, p.fee_s, p.fee_a, p.fee_b, p.fee_c, p.cost_updated_at,
  coalesce((select jsonb_object_agg(pp.tier, jsonb_build_object('price', pp.price, 'locked', pp.locked)) from app.product_prices pp where pp.product_id = p.id and pp.currency = 'XOF'), '{}') as prices,
  (select coalesce(sum(s.qty_on_hand), 0) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = p.id and w.kind = 'local') as on_hand
from app.products p join app.categories c on c.id = p.category_id
where p.org_id = $1 and p.active
order by c.sort, p.model`;

export const priceSettings = `select * from app.price_settings where org_id = $1`;

// ── 0009 客户档案 / 热线回访 / 销售拜访 ──
// 客户档案总表: 档案 + 欠款 + 预警 + 最近联系 + 下次跟进
export const customerProfiles = `
select c.id, c.code, c.temp_code, c.name, c.city, c.tier, c.status, c.phone, c.contact_name, c.address, c.owner_employee_id, c.kind, c.market, c.zone, c.shop_type, c.supply, c.follow_status, c.attrs, c.monthly_qty,
  c.recycle_type, c.interested, c.source, c.credit_limit, c.credit_days, c.has_agreement, c.owner_employee_id, c.shop_photo, c.note, c.block_on_debt,
  e.short_name as owner, cr.balance, cr.oldest_days, cr.over_limit, cr.over_days,
  greatest((select max(at) from app.hotline_calls h where h.customer_id = c.id), (select max(at) from app.visits v where v.customer_id = c.id)) as last_contact,
  (select max(d.created_at) from app.deals d where d.customer_id = c.id and d.status <> 'cancelled') as last_deal,
  (select min(x.n) from (select next_follow_on n from app.hotline_calls h where h.customer_id = c.id
     and h.at = (select max(at) from app.hotline_calls where customer_id = c.id)
   union all select next_follow_on from app.visits v where v.customer_id = c.id and v.at = (select max(at) from app.visits where customer_id = c.id)) x) as next_follow,
  (select h.next_follow_on from app.hotline_calls h where h.customer_id = c.id and h.line = 'spare' order by h.at desc limit 1) as next_spare,
  (select h.next_follow_on from app.hotline_calls h where h.customer_id = c.id and h.line = 'recycle' order by h.at desc limit 1) as next_recycle,
  (select max(h.at) from app.hotline_calls h where h.customer_id = c.id and h.line = 'recycle') as last_recycle
from app.customers c
left join app.employees e on e.id = c.owner_employee_id
left join app.v_customer_credit cr on cr.customer_id = c.id
where c.org_id = $1
order by c.status, c.code nulls last, c.name`;

export const customerContacts = `
select 'call' as src, h.id, h.at, h.line, h.channel, h.result, h.note, h.next_follow_on, null as photo, e.short_name as staff
from app.hotline_calls h left join app.employees e on e.id = h.staff_employee_id where h.customer_id = $1
union all
select 'visit', v.id, v.at, 'spare', 'visit', v.result, concat_ws(' · ', v.products_wanted, v.note), v.next_follow_on, v.photo, e.short_name
from app.visits v left join app.employees e on e.id = v.employee_id where v.customer_id = $1
order by at desc`;

export const hotlineCalls = `
select h.id, h.at, h.line, h.channel, h.result, h.note, h.next_follow_on, h.customer_id, c.code, c.temp_code, c.name, c.city, c.phone,
  e.short_name as staff
from app.hotline_calls h join app.customers c on c.id = h.customer_id left join app.employees e on e.id = h.staff_employee_id
where h.org_id = $1 and h.at::date between $2::date and $3::date
order by h.at desc`;

export const visitsList = `
select v.id, v.at, v.result, v.note, v.next_follow_on, v.photo, v.activity, v.products_wanted, v.monthly_qty, v.buys_from, v.transport,
  v.nearby_suppliers, v.customer_id, c.code, c.temp_code, c.name, c.city, c.phone, c.status, e.short_name as staff
from app.visits v join app.customers c on c.id = v.customer_id left join app.employees e on e.id = v.employee_id
where v.org_id = $1 and v.at::date between $2::date and $3::date
order by v.at desc`;

// ── 0010 资金账户 / 公户 ──
export const cashHoldings = `
select h.*, e.short_name as holder, (select expense_approval_over from app.cash_settings s where s.org_id = h.org_id) as approval_over
from app.v_cash_holding h left join app.employees e on e.id = h.holder_employee_id
where h.org_id = $1 order by h.kind, h.name`;

export const cashMoves = `
select m.id, m.account_id, a.name as account, a.currency, m.kind, m.amount, m.on_date, m.status, m.payer, m.ref, m.category, m.proof, m.note,
  m.decide_note, m.source, m.created_at, m.customer_id, c.code, c.name as customer, r.rcv_no, app.move_sign(m) as sign, m.biz_type, m.flow_class
from app.cash_moves m join app.cash_accounts a on a.id = m.account_id
left join app.customers c on c.id = m.customer_id left join app.receipts r on r.id = m.receipt_id
where m.org_id = $1 and m.on_date between $2::date and $3::date
order by m.on_date desc, m.created_at desc`;

export const cashOpen = `
select m.id, m.account_id, a.name as account, a.currency, m.kind, m.amount, m.on_date, m.status, m.payer, m.ref, m.category, m.proof, m.note, m.source,
  (select jsonb_agg(jsonb_build_object('notice_id', x.notice_id, 'customer_id', x.customer_id, 'gap', x.gap_days, 'n', x.candidates))
     from app.v_notice_matches x where x.move_id = m.id) as matches
from app.cash_moves m join app.cash_accounts a on a.id = m.account_id
where m.org_id = $1 and (m.status in ('unclaimed','pending','unexplained'))
order by m.on_date, m.created_at`;

export const paymentNotices = `
select n.id, n.customer_id, c.code, c.name, c.city, n.amount, n.currency, n.method, n.paid_on, n.proof, n.note, n.status, n.created_at,
  (select count(*) from app.v_notice_matches x where x.notice_id = n.id) as candidates
from app.payment_notices n join app.customers c on c.id = n.customer_id
where n.org_id = $1 and (n.status = 'open' or n.created_at > now() - interval '30 days')
order by (n.status = 'open') desc, n.paid_on desc`;

// ── 0011 备货看板 / 采购在途 / 导入 ──
export const replenish = `select * from app.v_replenish where org_id = $1 order by suggest desc, short_qty desc, sold_30 desc, code`;
export const replenishSettings = `select * from app.replenish_settings where org_id = $1`;
export const openPOs = `
select p.id, p.po_no, p.supplier, p.mode, p.ordered_on, p.eta, p.status, p.remark, p.purpose, p.fob_customer_codes, p.boxes, p.pcs, p.warehouse_nos,
  jsonb_agg(jsonb_build_object('id', l.id, 'product_id', l.product_id, 'code', pr.code, 'model', coalesce(pr.model, l.model), 'category', c.name,
    'qty', l.qty, 'received', l.qty_received, 'fob_qty', l.fob_qty, 'fob_customer', l.fob_customer) order by pr.code nulls last, l.model) as lines,
  sum(l.qty - l.qty_received) as remaining
from app.purchase_orders p join app.po_lines l on l.po_id = p.id
left join app.products pr on pr.id = l.product_id left join app.categories c on c.id = pr.category_id
where p.org_id = $1 and p.status = 'open'
group by p.id order by p.eta nulls last, p.po_no`;
export const unmetNoCode = `
select upper(u.model) as model, cat.name as category, sum(u.qty_unmet) as qty, count(distinct u.customer_id) as customers, max(u.created_at) as last_at
from app.v_unmet_demand u left join app.categories cat on cat.id = u.category_id
where u.org_id = $1 and u.kind = 'no_code' and u.created_at > now() - interval '90 days'
group by 1, 2 order by sum(u.qty_unmet) desc`;

// ── 0013 FOB / 员工工资 / SOP / 金蝶 / 客户下单端 ──
export const fobList = `select * from app.v_fob where org_id = $1 order by (status in ('closed','cancelled')), created_at desc`;
export const fobById = `select * from app.v_fob where id = $1`;
export const fobLines = `
select l.*, p.code, c.name as category, p.variant,
  (select coalesce(sum(s.qty_on_hand), 0) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = l.product_id and w.kind = 'fob') as fob_stock
from app.fob_lines l left join app.products p on p.id = l.product_id left join app.categories c on c.id = p.category_id
where l.project_id = $1 order by l.model`;
export const fobPayments = `select * from app.fob_payments where project_id = $1 order by on_date, created_at`;
export const fobEvents = `select * from app.fob_events where project_id = $1 order by at`;

export const staffList = `
select e.*, e.joined_on::text as joined, e.resigned_on::text as resigned,
  (select count(*) from app.customers c where c.owner_employee_id = e.id and c.status = 'active') as customers,
  (select count(*) from app.employee_files f where f.employee_id = e.id and f.removed_at is null) as files,
  (e.ext_ref is null and e.full_name is null and exists (select 1 from app.members m where m.employee_id = e.id)) as is_account
from app.employees e where e.org_id = $1 order by e.active desc, e.department, e.short_name`;
export const employeeFiles = `
select id, kind, name, mime, data, w, h, created_at from app.employee_files where employee_id = $1 and removed_at is null order by created_at, name`;
export const payrollMonths = `
select h.month::text as month, h.status, h.paid_on::text as paid_on, count(p.*) as n, coalesce(sum(p.net),0) as net
from app.payroll_months h left join app.payroll p on p.org_id = h.org_id and p.month = h.month
where h.org_id = $1 group by h.org_id, h.month order by h.month desc`;
export const payrollHeader = `
select h.*, h.month::text as month, h.paid_on::text as paid_on, ae.short_name as approved_by_name
from app.payroll_months h left join app.members am on am.user_id = h.approved_by and am.org_id = h.org_id left join app.employees ae on ae.id = am.employee_id
where h.org_id = $1 and h.month = date_trunc('month', $2::date)::date`;
export const payroll = `
select p.*, p.paid_on::text as paid_on, e.short_name, e.active
from app.payroll p join app.employees e on e.id = p.employee_id
where p.org_id = $1 and p.month = date_trunc('month', $2::date)::date order by p.snap_dept nulls last, p.snap_name`;

export const sopList = `
select d.*, exists (select 1 from app.sop_acks a where a.doc_id = d.id and a.version = d.version and a.user_id = $2) as acked,
  (select count(distinct a.user_id) from app.sop_acks a where a.doc_id = d.id and a.version = d.version) as ack_n
from app.sop_docs d where d.org_id = $1 and d.active order by d.dept, d.title`;

export const kdOutbox = `
select k.id, k.status, k.remote_no, k.updated_at, k.saved_at, k.submitted_at, k.audited_at, sh.out_no, sh.shipped_at, sh.customer_received_at,
  d.id as deal_id, d.biz_no, d.so_no, c.code as customer_code, c.name as customer_name,
  (select sum(sl.qty) from app.shipment_lines sl where sl.shipment_id = sh.id) as qty,
  (select sum(sl.amount) from app.shipment_lines sl where sl.shipment_id = sh.id) as amount
from app.kingdee_outbox k join app.shipments sh on sh.id = k.shipment_id join app.deals d on d.id = sh.deal_id join app.customers c on c.id = d.customer_id
where k.org_id = $1 order by sh.shipped_at desc`;
export const kdShipmentLines = `
select p.code, p.kingdee_code, c.name as category, p.model, sl.qty, sl.unit_price, sl.amount, w.code as warehouse
from app.shipment_lines sl join app.deal_lines l on l.id = sl.deal_line_id join app.products p on p.id = l.product_id
join app.categories c on c.id = p.category_id left join app.stock_items s on s.id = l.stock_item_id left join app.warehouses w on w.id = s.warehouse_id
join app.kingdee_outbox k on k.shipment_id = sl.shipment_id where k.id = $1`;
export const kdSnapshots = `select as_of, count(*) n from app.kd_stock_snapshot where org_id = $1 group by 1 order by 1 desc`;
export const kdStockDiff = `
with sys as (select p.code, w.code as warehouse, s.qty_on_hand as qty from app.stock_items s join app.products p on p.id = s.product_id
             join app.warehouses w on w.id = s.warehouse_id where w.org_id = $1),
kd as (select code, warehouse, qty from app.kd_stock_snapshot where org_id = $1 and as_of = $2::date)
select coalesce(sys.code, kd.code) as code, coalesce(sys.warehouse, kd.warehouse) as warehouse, coalesce(sys.qty, 0) as sys_qty, coalesce(kd.qty, 0) as kd_qty,
  coalesce(sys.qty, 0) - coalesce(kd.qty, 0) as diff, p.model, c.name as category
from sys full join kd on kd.code = sys.code and kd.warehouse = sys.warehouse
left join app.products p on p.org_id = $1 and p.code = coalesce(sys.code, kd.code) left join app.categories c on c.id = p.category_id
where coalesce(sys.qty, 0) <> coalesce(kd.qty, 0)
order by abs(coalesce(sys.qty, 0) - coalesce(kd.qty, 0)) desc`;

// 客户下单端: $1 = 客户 id. 只给「有货 / 少量 / 无货」, 不给精确库存和价格
export const portalCatalog = `
select p.id, p.code, p.model, p.variant, p.shared_models, c.id as category_id, c.name as category,
  case when coalesce(a.avail, 0) >= 20 then 'ok' when coalesce(a.avail, 0) > 0 then 'low' else 'none' end as band,
  coalesce((select sum(l.qty - l.qty_received) from app.po_lines l join app.purchase_orders po on po.id = l.po_id and po.status = 'open' where l.product_id = p.id), 0) > 0 as coming
from app.products p join app.categories c on c.id = p.category_id
left join (select s.product_id, sum(s.qty_on_hand - s.qty_reserved) as avail from app.stock_items s join app.warehouses w on w.id = s.warehouse_id and w.kind = 'local' group by 1) a on a.product_id = p.id
where p.org_id = (select org_id from app.customers where id = $1) and p.active
order by c.sort, p.model`;
export const portalOrders = `
select d.id, d.biz_no, d.status, d.created_at, d.source, d.planned_ship_date, s.name as store,
  (select count(*) from app.deal_lines l where l.deal_id = d.id) as lines,
  (select coalesce(sum(l.qty_req), 0) from app.deal_lines l where l.deal_id = d.id) as qty_req,
  (select coalesce(sum(sl.qty), 0) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id where sh.deal_id = d.id and sh.voided_at is null) as qty_shipped
from app.deals d left join app.portal_stores s on s.id = d.portal_store_id
where d.customer_id = $1 and d.kind = 'normal' and d.status <> 'cancelled'
order by d.created_at desc limit 100`;
export const portalStores = `select * from app.portal_stores where customer_id = $1 and active order by name`;
export const storeOrders = `
select o.*, s.name as store, s.city, s.customer_id, c.code as customer_code, c.name as customer_name, d.biz_no
from app.store_orders o join app.portal_stores s on s.id = o.store_id join app.customers c on c.id = s.customer_id
left join app.deals d on d.id = o.deal_id
where ($1::uuid is null or s.customer_id = $1) and ($2::uuid is null or o.store_id = $2)
order by o.created_at desc`;
export const storesHq = `
select s.*, c.code as customer_code, c.name as customer_name,
  (select count(*) from app.store_orders o where o.store_id = s.id) as orders,
  (select count(*) from app.store_orders o where o.store_id = s.id and o.status = 'submitted') as open_orders,
  (select max(o.created_at) from app.store_orders o where o.store_id = s.id) as last_order
from app.portal_stores s join app.customers c on c.id = s.customer_id where c.org_id = $1 order by c.code, s.name`;

// ── 0014 询单审批 / 采购·物资申请 / 收货分仓 / 打卡 ──
export const pendingApprovals = `
select d.id, d.biz_no, d.created_at, d.approval_reasons, d.note, c.code, c.temp_code, c.name as customer_name, c.status as customer_status, c.tier,
  e.short_name as by_name, (select count(*) from app.deal_lines l where l.deal_id = d.id) as lines
from app.deals d join app.customers c on c.id = d.customer_id left join app.members m on m.user_id = d.created_by and m.org_id = d.org_id
left join app.employees e on e.id = m.employee_id
where d.org_id = $1 and d.approval = 'pending' and d.status = 'quoted' order by d.created_at`;
export const myInquiries = `
select d.id, d.biz_no, d.created_at, d.status, d.approval, d.approval_reasons, d.approval_note, c.code, c.temp_code, c.name as customer_name,
  (select count(*) from app.deal_lines l where l.deal_id = d.id) as lines
from app.deals d join app.customers c on c.id = d.customer_id
where d.org_id = $1 and d.created_by = $2 and d.kind = 'normal' order by d.created_at desc limit 200`;
export const purchaseRequests = `
select r.*, f.fob_no, (select coalesce(jsonb_agg(jsonb_build_object('item', l.item, 'spec', l.spec, 'qty', l.qty, 'product_id', l.product_id) order by l.item), '[]') from app.purchase_request_lines l where l.request_id = r.id) as lines,
  (select coalesce(sum(qty), 0) from app.purchase_request_lines l where l.request_id = r.id) as qty
from app.purchase_requests r left join app.fob_projects f on f.id = r.fob_project_id
where r.org_id = $1 order by (r.status in ('received','cancelled')), coalesce(r.eta, r.planned_ship, r.need_by) nulls last, r.created_at desc`;
export const poDetail = `
select l.id, l.qty, l.qty_received, l.fob_qty, l.fob_customer, l.alloc_source, l.model, l.product_id, p.code, c.name as category, p.variant
from app.po_lines l left join app.products p on p.id = l.product_id left join app.categories c on c.id = p.category_id
where l.po_id = $1 order by p.code nulls last, l.model`;
export const poReceipts = `
select g.*, p.po_no, p.supplier, p.purpose from app.po_receipts g join app.purchase_orders p on p.id = g.po_id
where g.org_id = $1 order by (g.kd_status = 'synced'), g.created_at desc`;
export const workSites = `select * from app.work_sites where org_id = $1 order by kind, name`;
export const attendanceDay = `
select a.*, e.short_name, e.department, e.city as emp_city, w.name as site_name, w.kind as site_kind, w.named as site_named,
  -- 查验: 和他近 14 天最常去的地点差多远 (Frank 11-07: 跑偏的自动标出来)
  (select round(app.distance_m(a.lat, a.lng, w2.lat, w2.lng))::int from app.work_sites w2 where w2.id = (
     select a2.site_id from app.attendance a2 where a2.employee_id = a.employee_id and a2.site_id is not null and a2.at < a.at and a2.at > a.at - interval '14 days'
     group by a2.site_id order by count(*) desc limit 1)) as usual_dist
from app.attendance a left join app.employees e on e.id = a.employee_id left join app.work_sites w on w.id = a.site_id
where a.org_id = $1 and (a.at at time zone 'Africa/Abidjan')::date = $2::date order by a.at`;
export const attendanceMine = `
select a.*, w.name as site_name, w.named as site_named from app.attendance a left join app.work_sites w on w.id = a.site_id
where a.org_id = $1 and a.user_id = $2 order by a.at desc limit 30`;
export const attendanceMonth = `
select e.id, e.short_name, e.department,
  count(distinct (a.at at time zone 'Africa/Abidjan')::date) filter (where a.kind = 'in') as days,
  count(*) filter (where a.kind = 'in' and a.late) as late,
  count(*) filter (where not a.ok) as off_site
from app.employees e left join app.attendance a on a.employee_id = e.id and to_char(a.at at time zone 'Africa/Abidjan', 'YYYY-MM') = $2
where e.org_id = $1 and e.active group by e.id order by e.department, e.short_name`;
export const attendanceSettings = `select * from app.attendance_settings where org_id = $1`;

// ── 经营总览 四块卡片 (11-01): $2/$3 本期, $4/$5 上一期 (同样长度) ──
export const dashCards = `
with sh as (
  select s.deal_id, s.shipped_at, s.amount, d.customer_id from app.shipments s join app.deals d on d.id = s.deal_id
  where s.org_id = $1 and s.voided_at is null and d.currency = 'XOF'),
lastcall as (
  select distinct on (h.customer_id, h.line) h.customer_id, h.next_follow_on from app.hotline_calls h where h.org_id = $1 order by h.customer_id, h.line, h.at desc),
cust as (
  select c.id,
    coalesce(sum(sh.amount) filter (where sh.shipped_at >= current_date - 30), 0) as d30,
    coalesce(sum(sh.amount) filter (where sh.shipped_at >= current_date - 120 and sh.shipped_at < current_date - 30), 0) / 3 as avg3,
    max(sh.shipped_at) as last_at
  from app.customers c join sh on sh.customer_id = c.id where c.org_id = $1 group by c.id)
select
  -- 仓库
  (select coalesce(sum(si.qty_on_hand),0) from app.stock_items si join app.warehouses w on w.id = si.warehouse_id where w.org_id = $1 and w.code in ('LA','9S')) as stock_pcs,
  (select count(distinct si.product_id) from app.stock_items si join app.warehouses w on w.id = si.warehouse_id where w.org_id = $1 and w.code in ('LA','9S') and si.qty_on_hand > 0) as stock_sku,
  (select coalesce(sum(si.qty_on_hand * app.landed_cost(p.rmb_cost, p.freight_xof, ps)),0) from app.stock_items si join app.warehouses w on w.id = si.warehouse_id
     join app.products p on p.id = si.product_id join app.price_settings ps on ps.org_id = w.org_id where w.org_id = $1 and w.code in ('LA','9S') and p.rmb_cost is not null) as stock_value,
  (select coalesce(sum(si.qty_on_hand),0) from app.stock_items si join app.warehouses w on w.id = si.warehouse_id join app.products p on p.id = si.product_id
     where w.org_id = $1 and w.code in ('LA','9S') and p.rmb_cost is null) as stock_pcs_nocost,
  (select coalesce(sum(a.a181_365 + a.a365),0) from app.stock_aging a where a.org_id = $1 and a.as_of = (select max(as_of) from app.stock_aging where org_id = $1)) as stale_pcs,
  (select max(as_of)::text from app.stock_aging where org_id = $1) as aging_as_of,
  (select count(*) from app.deals d where d.org_id = $1 and d.status in ('reviewed','partial')) as to_ship,
  (select count(*) from app.deals d where d.org_id = $1 and d.status in ('picking','picked','confirmed')) as in_picking,
  -- 销售 (外勤)
  (select count(*) from app.visits v where v.org_id = $1 and v.at >= $2::date and v.at < $3::date + 1) as visits,
  (select count(*) from app.visits v where v.org_id = $1 and v.at >= $4::date and v.at < $5::date + 1) as visits_prev,
  (select count(*) from app.visits v where v.org_id = $1 and v.at >= $2::date and v.at < $3::date + 1 and v.result in ('order','quote')) as visits_won,
  (select count(*) from app.visits v where v.org_id = $1 and v.at >= $2::date and v.at < $3::date + 1 and v.result = 'interested') as visits_interested,
  (select count(distinct a.user_id) from app.attendance a where a.org_id = $1 and a.kind = 'in' and a.at >= current_date) as clock_today,
  (select count(*) from app.attendance a where a.org_id = $1 and a.kind = 'in' and a.at >= current_date and a.late) as late_today,
  (select count(*) from app.attendance a where a.org_id = $1 and a.at >= current_date and not a.ok) as offsite_today,
  -- 热线
  (select count(*) from app.hotline_calls h where h.org_id = $1 and h.at >= $2::date and h.at < $3::date + 1) as calls,
  (select count(*) from app.hotline_calls h where h.org_id = $1 and h.at >= $4::date and h.at < $5::date + 1) as calls_prev,
  (select count(*) from app.hotline_calls h where h.org_id = $1 and h.at >= $2::date and h.at < $3::date + 1 and h.result = 'order') as calls_order,
  (select count(*) from app.hotline_calls h where h.org_id = $1 and h.at >= $2::date and h.at < $3::date + 1 and h.result in ('no_answer','busy')) as calls_missed,
  (select count(*) from lastcall where next_follow_on < current_date) as follow_late,
  (select count(*) from lastcall where next_follow_on = current_date) as follow_today,
  -- 客户
  (select count(distinct customer_id) from sh where shipped_at >= $2::date and shipped_at < $3::date + 1) as buyers,
  (select count(distinct customer_id) from sh where shipped_at >= $4::date and shipped_at < $5::date + 1) as buyers_prev,
  (select coalesce(sum(amount),0) from sh where shipped_at >= $2::date and shipped_at < $3::date + 1) as sales,
  (select coalesce(sum(amount),0) from sh where shipped_at >= $4::date and shipped_at < $5::date + 1) as sales_prev,
  (select count(*) from cust where avg3 > 0 and d30 < avg3 * 0.7) as cust_down,
  (select count(*) from cust where last_at < current_date - 30) as cust_silent`;

// 客户对比: 本月 / 上月 / 前 3 个月月均 / 近 30 天对比月均
export const customerCompare = `
with sh as (
  select d.customer_id, s.shipped_at, s.amount from app.shipments s join app.deals d on d.id = s.deal_id
  where s.org_id = $1 and s.voided_at is null and d.currency = 'XOF')
select c.id, coalesce(c.code, c.temp_code) as code, c.name, c.city, c.tier,
  coalesce(sum(sh.amount) filter (where sh.shipped_at >= date_trunc('month', current_date)), 0) as this_month,
  coalesce(sum(sh.amount) filter (where sh.shipped_at >= date_trunc('month', current_date) - interval '1 month' and sh.shipped_at < date_trunc('month', current_date)), 0) as last_month,
  coalesce(sum(sh.amount) filter (where sh.shipped_at >= current_date - 120 and sh.shipped_at < current_date - 30), 0) / 3 as avg3,
  coalesce(sum(sh.amount) filter (where sh.shipped_at >= current_date - 30), 0) as d30,
  max(sh.shipped_at) as last_at, count(distinct date_trunc('day', sh.shipped_at)) as ship_days
from app.customers c join sh on sh.customer_id = c.id
where c.org_id = $1 group by c.id order by d30 desc, last_at desc`;

// ── 0017 客户账号 ──
export const customerAccounts = `
select a.id, a.customer_id, a.login, a.status, a.must_change, a.created_at, a.last_login_at,
  (select count(*) from app.account_events e where e.account_id = a.id and e.kind = 'pw_changed' and e.acked_at is null) as unacked
from app.customer_accounts a where a.org_id = $1`;
export const accountEvents = `select e.* from app.account_events e where e.account_id = $1 order by e.at desc limit 50`;
export const accountAlerts = `
select e.id, e.at, a.login, c.name, c.id as customer_id from app.account_events e join app.customer_accounts a on a.id = e.account_id join app.customers c on c.id = a.customer_id
where a.org_id = $1 and e.kind = 'pw_changed' and e.acked_at is null order by e.at desc`;

// 按销售员月汇总 (Frank 11-07): 归属按出库当时的单据归属 (激励口径), 列他名下成交的客户、件数、金额
export const salesByOwner = `
select coalesce(e.id::text, '-') as owner_id, coalesce(e.short_name, '（无归属）') as owner, e.emp_no,
  count(distinct d.customer_id) as customers, count(distinct sh.id) as shipments,
  sum(sl.qty) as qty, sum(sl.amount) as amount,
  string_agg(distinct c.name, '、' order by c.name) as customer_names
from app.shipments sh join app.deals d on d.id = sh.deal_id join app.customers c on c.id = d.customer_id
join app.shipment_lines sl on sl.shipment_id = sh.id
left join app.employees e on e.id = d.owner_employee_id
where d.org_id = $1 and sh.voided_at is null and d.currency = 'XOF' and sh.shipped_at >= $2::date and sh.shipped_at < ($2::date + interval '1 month')
group by e.id, e.short_name, e.emp_no order by amount desc nulls last`;

// 导出记录 (留记录不留文件)
export const exportLog = `
select l.*, coalesce(e.short_name, m.roles::text) as who from app.export_log l
left join app.members m on m.user_id = l.user_id and m.org_id = l.org_id left join app.employees e on e.id = m.employee_id
where l.org_id = $1 order by l.at desc limit 200`;

// 待起名的打卡地点 + 申诉
export const unnamedSites = `select w.*, (select count(*) from app.attendance a where a.site_id = w.id) as hits,
  (select string_agg(distinct coalesce(e.short_name, ''), '、') from app.attendance a left join app.employees e on e.id = a.employee_id where a.site_id = w.id) as who
  from app.work_sites w where w.org_id = $1 and not w.named order by w.created_at desc`;
export const appeals = `select ap.*, e.short_name, e.emp_no from app.attendance_appeals ap join app.employees e on e.id = ap.employee_id
  where ap.org_id = $1 and ap.day >= $2::date order by ap.status = 'pending' desc, ap.day desc`;
export const myAppeals = `select ap.* from app.attendance_appeals ap join app.members m on m.employee_id = ap.employee_id and m.org_id = ap.org_id
  where ap.org_id = $1 and m.user_id = $2 order by ap.day desc limit 30`;
export const attendanceRules = `select * from app.attendance_settings where org_id = $1`;
export const orgFile = `select key, name, mime, bytes, uploaded_at from app.org_files where org_id = $1 and key = $2`;
export const orgFileData = `select data, mime, name from app.org_files where org_id = $1 and key = $2`;

// 出库单总表 (Frank 11-07: 任何列都能筛 —— 客户 / 单号 / BL 号 / 机型 / 状态)
export const shipmentsAll = `
select s.id, s.out_no, s.bl_no, s.shipped_at, s.method, s.contact_phone, s.address, s.amount, s.voided_at, s.customer_received_at, s.signed_at, s.bl_printed_at,
  d.id as deal_id, d.biz_no, d.currency, c.name as customer_name, coalesce(c.code, c.temp_code) as customer_code, c.city,
  (select coalesce(sum(qty),0) from app.shipment_lines sl where sl.shipment_id = s.id) as qty,
  (select string_agg(distinct coalesce(p.model, l.req_model), ' / ') from app.shipment_lines sl join app.deal_lines l on l.id = sl.deal_line_id left join app.products p on p.id = l.product_id where sl.shipment_id = s.id) as models,
  k.status as kingdee_status
from app.shipments s join app.deals d on d.id = s.deal_id join app.customers c on c.id = d.customer_id left join app.kingdee_outbox k on k.shipment_id = s.id
where s.org_id = $1 and s.shipped_at >= $2::date and s.shipped_at < ($3::date + 1) order by s.shipped_at desc`;

// 某员工某月的打卡明细 (工资单里点「打卡情况」用): 按天, 上班 / 下班时间、地点、迟到、在不在
export const attendanceOfEmp = `
select (a.at at time zone 'Africa/Abidjan')::date::text as day, a.kind, to_char(a.at at time zone 'Africa/Abidjan', 'HH24:MI') as hm,
  a.late, a.ok, a.lat, a.lng, a.distance_m, w.name as site_name, w.named as site_named
from app.attendance a left join app.work_sites w on w.id = a.site_id
where a.org_id = $1 and a.employee_id = $2 and a.at >= date_trunc('month', $3::date) and a.at < date_trunc('month', $3::date) + interval '1 month'
order by a.at`;
export const appealsOfEmp = `select ap.day::text as day, ap.reason, ap.status, ap.decision_note from app.attendance_appeals ap
  where ap.org_id = $1 and ap.employee_id = $2 and ap.day >= date_trunc('month', $3::date) and ap.day < date_trunc('month', $3::date) + interval '1 month' order by ap.day`;

// 11-08: 员工上报的问题 (open 在前)
export const issues = `
select i.*, d.biz_no, c.name as customer_name, e.short_name as by_name, (select array_agg(r::text) from app.members mm, unnest(mm.roles) r where mm.user_id = i.reported_by and mm.org_id = i.org_id) as by_roles
from app.issue_reports i left join app.deals d on d.id = i.deal_id left join app.customers c on c.id = d.customer_id
left join app.members m on m.user_id = i.reported_by and m.org_id = i.org_id left join app.employees e on e.id = m.employee_id
where i.org_id = $1 and ($2::text is null or i.status = $2) order by (i.status = 'open') desc, i.reported_at desc limit 200`;
export const issuesOfDeal = `select i.*, (select e.short_name from app.members m join app.employees e on e.id = m.employee_id where m.user_id = i.reported_by and m.org_id = i.org_id limit 1) as by_name from app.issue_reports i where i.deal_id = $1 order by i.reported_at desc`;

// 11-09: 没走完的退货 (待办用)
export const openReturns = `select * from app.v_open_returns where org_id = $1 order by requested_at`;
