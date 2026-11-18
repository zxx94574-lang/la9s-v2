-- 0058 销售提成 (Frank 11-17, 待改 334): 按片; **必须整单付清**才算; 只算有归属销售员的客户的单; 特价单照算; FOB 不算.
-- 算在哪个月: 这张单最后一笔冲账 (付清) 那天. 片数 = 出库 − 退货. 每片多少钱: org_settings sales_comm.per_piece (Frank 还没定, 默认 0).
-- 只给数字, 不自动进工资 (和仓库提成刚上线时一样, 等 Frank 定了每片金额再接).
create or replace function app.sales_commission_deals(p_org uuid, p_from date, p_to date)
returns table (deal_id uuid, biz_no text, employee_id uuid, short_name text, customer_name text, paid_on date, pieces int, special boolean)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  return query
  select d.id, d.biz_no, e.id, e.short_name, c.name, (select max(a.at)::date from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id where a.deal_id = d.id and r.voided_at is null),
    (coalesce((select sum(sl.qty) from app.shipment_lines sl join app.shipments s on s.id = sl.shipment_id where s.deal_id = d.id and s.voided_at is null), 0)
      - coalesce((select sum(rl.qty) from app.return_lines rl join app.returns rt on rt.id = rl.return_id where rt.deal_id = d.id and rt.status not in ('requested','rejected')), 0))::int,
    exists (select 1 from app.deal_lines l where l.deal_id = d.id and l.price_manual)
  from app.deals d join app.customers c on c.id = d.customer_id join app.employees e on e.id = d.owner_employee_id
  join app.v_deal_due v on v.deal_id = d.id
  where d.org_id = p_org and d.kind = 'normal' and d.status = 'shipped' and c.supply <> 'fob' and not d.price_pending
    and v.shipped_amount > 0 and v.due <= 0
    and (select max(a.at)::date from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id where a.deal_id = d.id and r.voided_at is null) between p_from and p_to;
end $$;

create or replace function app.sales_commission(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, short_name text, deals int, pieces int, per_piece numeric, amount numeric)
language plpgsql stable security definer set search_path = app, public as $$
declare v_pp numeric := coalesce((select (value->>'per_piece')::numeric from app.org_settings where org_id = p_org and key = 'sales_comm'), 0);
begin
  perform app.require_role(p_org, 'admin');
  return query
  select x.employee_id, x.short_name, count(*)::int, coalesce(sum(x.pieces), 0)::int, v_pp, coalesce(sum(x.pieces), 0) * v_pp
  from app.sales_commission_deals(p_org, p_from, p_to) x group by x.employee_id, x.short_name order by 4 desc;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.sales_commission_deals(uuid, date, date), app.sales_commission(uuid, date, date) to authenticated;
  end if;
end $$;
