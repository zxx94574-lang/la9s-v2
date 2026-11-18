-- 0059 最终版修订 A (Frank 11-18 12:47 逐条答复)
--  ① 销售提成每片 17 XOF, 自动进工资单 (做法同仓库提成: 自动带出, 手改不覆盖)
--  ② 清仓价表 → 特价表: 每条有名字 (默认「促销价」, 名字中方自己定义), 生效期间自动成为这个客户的单价 (不用手改)
--  ③ 出库新增两道拦截, 要中方放行: 超欠款上限 / 超账期; 出库数量 > 客户确认的数量
--  ④ 大变动通知补齐: 抹零 / 坏账核销 / 改客户档位

-- ───────────────────────── ① 销售提成进工资 ─────────────────────────
alter table app.payroll add column sales_comm numeric(18,2) not null default 0, add column sales_comm_auto numeric(18,2);

-- 内部 (不查岗位): 每个销售员在一段时间里「整单付清」的片数. 口径同 0058.
create or replace function app.sales_comm_pieces(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, deals int, pieces int)
language sql stable security definer set search_path = app, public as $$
  select x.emp, count(*)::int, coalesce(sum(x.pcs), 0)::int from (
    select d.owner_employee_id as emp,
      (coalesce((select sum(sl.qty) from app.shipment_lines sl join app.shipments s on s.id = sl.shipment_id where s.deal_id = d.id and s.voided_at is null), 0)
        - coalesce((select sum(rl.qty) from app.return_lines rl join app.returns rt on rt.id = rl.return_id where rt.deal_id = d.id and rt.status not in ('requested','rejected')), 0)) as pcs,
      (select max(a.at)::date from app.receipt_allocations a join app.receipts r on r.id = a.receipt_id where a.deal_id = d.id and r.voided_at is null) as paid_on
    from app.deals d join app.customers c on c.id = d.customer_id join app.v_deal_due v on v.deal_id = d.id
    where d.org_id = p_org and d.kind = 'normal' and d.status = 'shipped' and d.owner_employee_id is not null and c.supply <> 'fob' and not d.price_pending
      and v.shipped_amount > 0 and v.due <= 0) x
  where x.paid_on between p_from and p_to group by x.emp
$$;
revoke all on function app.sales_comm_pieces(uuid, date, date) from public;

-- 每片多少: 没设 = 17 (Frank 11-18 定)
create or replace function app.sales_comm_rate(p_org uuid) returns numeric language sql stable security definer set search_path = app, public as $$
  select coalesce((select (value->>'per_piece')::numeric from app.org_settings where org_id = p_org and key = 'sales_comm'), 17)
$$;
revoke all on function app.sales_comm_rate(uuid) from public;

create or replace function app.sales_commission(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, short_name text, deals int, pieces int, per_piece numeric, amount numeric)
language plpgsql stable security definer set search_path = app, public as $$
declare v_pp numeric := app.sales_comm_rate(p_org);
begin
  perform app.require_role(p_org, 'admin');
  return query
  select x.employee_id, x.short_name, count(*)::int, coalesce(sum(x.pieces), 0)::int, v_pp, coalesce(sum(x.pieces), 0) * v_pp
  from app.sales_commission_deals(p_org, p_from, p_to) x group by x.employee_id, x.short_name order by 4 desc;
end $$;

create or replace function app.payroll_recalc(p_org uuid, p_month date, p_emp uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare h app.payroll_months;
begin
  select * into h from app.payroll_months where org_id = p_org and month = p_month;
  update app.payroll p set
    base = round(least(coalesce(p.contract_salary,0), coalesce(p.contract_salary,0) / h.days_base * coalesce(p.days_worked, h.days_base))),
    updated_at = now()
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
  update app.payroll p set net = p.base + p.allowance + p.incentive + p.prime_team + coalesce(p.wh_comm, 0) + coalesce(p.sales_comm, 0)
      + case when h.cnps_in_net then p.cnps else 0 end - p.deduction
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
end $$;

create or replace function app.payroll_sales_comm(p_org uuid, p_month date, p_emps uuid[] default null, p_force boolean default false)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months; v_rate numeric := app.sales_comm_rate(p_org); n int;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.month is null then return 0; end if;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经确认发放，不能重算'; end if;
  update app.payroll p set
    sales_comm = case when p_force or p.sales_comm = coalesce(p.sales_comm_auto, 0) then x.amt else p.sales_comm end,
    sales_comm_auto = x.amt
  from (select p2.employee_id, coalesce((select s.pieces from app.sales_comm_pieces(p_org, m, (m + interval '1 month - 1 day')::date) s where s.employee_id = p2.employee_id), 0) * v_rate as amt
        from app.payroll p2 where p2.org_id = p_org and p2.month = m) x
  where p.org_id = p_org and p.month = m and p.employee_id = x.employee_id and (p_emps is null or p.employee_id = any(p_emps));
  get diagnostics n = row_count;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;

create or replace function app.payroll_set_sales_comm(p_org uuid, p_month date, p_emp uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经确认发放，不能改'; end if;
  if coalesce(p_amount, 0) < 0 then raise exception 'VALIDATION: 提成不能为负'; end if;
  update app.payroll set sales_comm = coalesce(p_amount, 0), updated_at = now() where org_id = p_org and month = m and employee_id = p_emp;
  perform app.payroll_recalc(p_org, m, p_emp);
  perform app.audit(p_org, 'payroll_sales_comm', 'payroll', p_emp, jsonb_build_object('month', m, 'amount', p_amount));
end $$;

-- ───────────────────────── ② 特价表: 有名字, 自动成为单价 ─────────────────────────
alter table app.clearance_prices add column label text not null default '促销价';
update app.clearance_prices set label = '清仓价';      -- 0059 之前建的都是按「清仓」建的

create or replace function app.set_promo(p_org uuid, p_product uuid, p_price numeric, p_from date, p_to date, p_tiers text[], p_customers uuid[], p_note text, p_label text default '促销价')
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v uuid;
begin
  v := app.set_clearance(p_org, p_product, p_price, p_from, p_to, p_tiers, p_customers, p_note);
  update app.clearance_prices set label = coalesce(nullif(trim(p_label), ''), '促销价') where id = v;
  return v;
end $$;

-- 内部: 这个客户今天买这个型号, 生效的特价里最低的那条 (价 + 名字)
create or replace function app.promo_for(p_product uuid, p_customer uuid, p_on date default current_date)
returns table (price numeric, label text) language sql stable security definer set search_path = app, public as $$
  select cp.price, cp.label from app.clearance_prices cp join app.customers c on c.id = p_customer
  where cp.product_id = p_product and cp.org_id = c.org_id and cp.ended_at is null and p_on between cp.starts_on and cp.ends_on
    and (cp.tiers is null or c.tier = any(cp.tiers)) and (cp.customer_ids is null or c.id = any(cp.customer_ids))
  order by cp.price limit 1
$$;
revoke all on function app.promo_for(uuid, uuid, date) from public;

-- 档位价: 有生效的特价且更低 → 用特价 (XOF). 所有「带出价格」的地方都走这个函数, 所以报价 / 获取价格 / 异价判断一起跟着变.
create or replace function app.tier_price(p_product uuid, p_customer uuid, p_currency text)
returns numeric language sql stable security definer set search_path = app, public as $$
  select case when p_currency = 'XOF'
    then least((select pp.price from app.product_prices pp join app.customers c on c.id = p_customer
                 where pp.product_id = p_product and pp.tier = c.tier and pp.currency = 'XOF'),
               (select f.price from app.promo_for(p_product, p_customer) f))
    else (select pp.price from app.product_prices pp join app.customers c on c.id = p_customer
           where pp.product_id = p_product and pp.tier = c.tier and pp.currency = p_currency) end
$$;
revoke execute on function app.tier_price(uuid, uuid, text) from public;

-- 给界面: 这个客户现在生效的特价 (任何成员: 员工本来就看得到这单的价; 不带成本、不带原因)
create or replace function app.customer_promos(p_customer uuid)
returns table (product_id uuid, price numeric, label text, ends_on date)
language plpgsql stable security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then return; end if;
  if not app.is_member(c.org_id) then raise exception 'PERMISSION_DENIED: 不是本组织成员'; end if;
  return query
  select distinct on (cp.product_id) cp.product_id, cp.price, cp.label, cp.ends_on from app.clearance_prices cp
  where cp.org_id = c.org_id and cp.ended_at is null and current_date between cp.starts_on and cp.ends_on
    and (cp.tiers is null or c.tier = any(cp.tiers)) and (cp.customer_ids is null or c.id = any(cp.customer_ids))
  order by cp.product_id, cp.price;
end $$;

-- ───────────────────────── ③ 出库拦截: 欠款上限 / 账期 / 数量超过客户确认的 ─────────────────────────
alter table app.deals add column credit_released_at timestamptz, add column credit_released_by uuid, add column credit_release_note text,
  add column qty_snap_at timestamptz;
alter table app.deal_lines add column qty_confirmed int;

-- 客户确认那一刻, 记下每行确认的数量
create or replace function app.trg_snap_confirmed() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if old.status = 'ordered' and new.status in ('confirmed', 'reviewed') then
    update app.deal_lines set qty_confirmed = qty_supply where deal_id = new.id;
    new.qty_snap_at := now();
  end if;
  return new;
end $$;
create trigger snap_confirmed before update of status on app.deals for each row execute function app.trg_snap_confirmed();

-- 这张单现在被哪几道拦着 (任何成员看得到; 不含成本)
create or replace function app.ship_gate_state(p_deal uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare d app.deals; c app.customers; cr app.v_customer_credit; v_on boolean; v_rest numeric; v_over_limit boolean; v_over_days boolean; v_qty jsonb; v_ok_l boolean; v_ok_d boolean;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED: 不是本组织成员'; end if;
  if d.kind <> 'normal' then return jsonb_build_object('credit', null, 'qty', '[]'::jsonb); end if;
  select * into c from app.customers where id = d.customer_id;
  select * into cr from app.v_customer_credit where customer_id = d.customer_id;
  v_on := coalesce((select (value->>'on')::boolean from app.org_settings where org_id = d.org_id and key = 'credit_gate'), true);
  select coalesce(sum((l.qty_supply - l.qty_shipped) * coalesce(l.unit_price, 0)), 0) into v_rest from app.deal_lines l where l.deal_id = p_deal and l.qty_supply > l.qty_shipped;
  if d.currency <> 'XOF' then v_rest := v_rest * coalesce(d.fx_rate, 0); end if;
  v_over_limit := c.credit_limit is not null and coalesce(cr.balance, 0) + v_rest > c.credit_limit;
  v_over_days := coalesce(cr.over_days, false);
  -- 报价审批时中方已经批过同一个原因的, 不再拦第二次
  v_ok_l := d.approval = 'approved' and '超欠款上限' = any(d.approval_reasons);
  v_ok_d := d.approval = 'approved' and '超账期' = any(d.approval_reasons);
  select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'model', coalesce(p.model, l.req_model), 'confirmed', coalesce(l.qty_confirmed, 0), 'now', l.qty_supply) order by l.seq), '[]'::jsonb)
    into v_qty from app.deal_lines l left join app.products p on p.id = l.product_id
    where l.deal_id = p_deal and d.qty_snap_at is not null and l.qty_supply > coalesce(l.qty_confirmed, 0) and l.qty_supply > l.qty_shipped;
  return jsonb_build_object(
    'credit', case when v_on and d.credit_released_at is null and ((v_over_limit and not v_ok_l) or (v_over_days and not v_ok_d)) then jsonb_build_object(
      'over_limit', v_over_limit and not v_ok_l, 'over_days', v_over_days and not v_ok_d, 'balance', coalesce(cr.balance, 0), 'this', round(v_rest),
      'limit', c.credit_limit, 'days', c.credit_days, 'oldest', cr.oldest_days) end,
    'qty', v_qty,
    'released', case when d.credit_released_at is not null then jsonb_build_object('at', d.credit_released_at, 'note', d.credit_release_note) end);
end $$;

-- 中方放行 (原因必填). kind = credit: 这张单不再查欠款上限 / 账期; kind = qty: 认下现在的数量 (= 客户确认的数量改成现在的)
create or replace function app.release_ship_gate(p_deal uuid, p_kind text, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 放行要写原因'; end if;
  if p_kind = 'credit' then
    update app.deals set credit_released_at = now(), credit_released_by = app.uid(), credit_release_note = p_note where id = p_deal;
  elsif p_kind = 'qty' then
    update app.deal_lines set qty_confirmed = qty_supply where deal_id = p_deal;
  else raise exception 'VALIDATION: 不认识的放行类型';
  end if;
  perform app.deal_event(p_deal, 'gate_released', jsonb_build_object('kind', p_kind, 'note', p_note));
end $$;

create or replace function app.trg_ship_credit_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
declare g jsonb; d app.deals; c app.customers; cr app.v_customer_credit; v_rest numeric;
begin
  select * into d from app.deals where id = new.deal_id;
  if d.kind <> 'normal' or d.credit_released_at is not null then return new; end if;
  if not coalesce((select (value->>'on')::boolean from app.org_settings where org_id = d.org_id and key = 'credit_gate'), true) then return new; end if;
  select * into c from app.customers where id = d.customer_id;
  select * into cr from app.v_customer_credit where customer_id = d.customer_id;
  select coalesce(sum((l.qty_supply - l.qty_shipped) * coalesce(l.unit_price, 0)), 0) into v_rest from app.deal_lines l where l.deal_id = d.id and l.qty_supply > l.qty_shipped;
  if d.currency <> 'XOF' then v_rest := v_rest * coalesce(d.fx_rate, 0); end if;
  if c.credit_limit is not null and coalesce(cr.balance, 0) + v_rest > c.credit_limit and not (d.approval = 'approved' and '超欠款上限' = any(d.approval_reasons)) then
    raise exception 'CREDIT_BLOCK: % 出了这张单就超欠款上限（现在欠 %，这张单 %，上限 %）：先收款，或请中方在订单上放行', c.name,
      to_char(coalesce(cr.balance, 0), 'FM999,999,999,990'), to_char(v_rest, 'FM999,999,999,990'), to_char(c.credit_limit, 'FM999,999,999,990');
  end if;
  if coalesce(cr.over_days, false) and not (d.approval = 'approved' and '超账期' = any(d.approval_reasons)) then
    raise exception 'CREDIT_BLOCK: % 最老的欠款已经 % 天，超过账期 % 天：先收款，或请中方在订单上放行', c.name, cr.oldest_days, c.credit_days;
  end if;
  return new;
end $$;
create trigger ship_credit_gate before insert on app.shipments for each row execute function app.trg_ship_credit_gate();

create or replace function app.trg_ship_qty_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
declare l app.deal_lines; d app.deals;
begin
  select * into l from app.deal_lines where id = new.deal_line_id;
  select * into d from app.deals where id = l.deal_id;
  if d.kind = 'normal' and d.qty_snap_at is not null and l.qty_shipped > coalesce(l.qty_confirmed, 0) then
    raise exception 'QTY_BLOCK: 第 % 行出库数量（累计 %）超过客户确认的数量（%）：让客户重新确认，或请中方在订单上放行', l.seq, l.qty_shipped, coalesce(l.qty_confirmed, 0);
  end if;
  return new;
end $$;
create trigger ship_qty_gate before insert on app.shipment_lines for each row execute function app.trg_ship_qty_gate();

-- ───────────────────────── ④ 大变动通知补齐 ─────────────────────────
create or replace function app.trg_event_notice() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  if new.action not in ('qty_changed','price_set','price_requested','price_decided','lines_added','step_reverted','shipment_voided','deal_split','quote_edited',
                        'receipt_voided','price_adjusted','debt_released','payment_appeal','cancelled','partial_reason',
                        'written_off','bad_debt_written_off','gate_released') then return null; end if;
  select * into d from app.deals where id = new.deal_id;
  if new.action = 'quote_edited' and d.status = 'quoted' then return null; end if;
  if new.action = 'cancelled' and d.pick_no is null then return null; end if;
  insert into app.change_notices (org_id, deal_id, kind, detail, by_user) values (d.org_id, d.id, new.action, new.detail, new.user_id);
  return null;
end $$;

-- 改客户档位 (已经定过档的客户换档) → 通知
create or replace function app.trg_tier_notice() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if old.tier is distinct from new.tier and old.tier_confirmed_at is not null then
    insert into app.change_notices (org_id, deal_id, kind, detail, by_user)
    values (new.org_id, null, 'tier_changed', jsonb_build_object('customer_id', new.id, 'customer', new.name, 'from', old.tier, 'to', new.tier), app.uid());
  end if;
  return null;
end $$;
create trigger tier_notice after update of tier on app.customers for each row execute function app.trg_tier_notice();

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function app.sales_comm_pieces(uuid, date, date), app.sales_comm_rate(uuid), app.promo_for(uuid, uuid, date) from authenticated;
    grant execute on function app.payroll_sales_comm(uuid, date, uuid[], boolean), app.payroll_set_sales_comm(uuid, date, uuid, numeric),
      app.set_promo(uuid, uuid, numeric, date, date, text[], uuid[], text, text), app.customer_promos(uuid),
      app.ship_gate_state(uuid), app.release_ship_gate(uuid, text, text) to authenticated;
  end if;
end $$;

-- 给界面: 这张单哪些行现在走的是特价 (行单价 = 生效特价; 任何成员; 只给名字和价)
create or replace function app.deal_promos(p_deal uuid)
returns table (deal_line_id uuid, price numeric, label text)
language plpgsql stable security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then return; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED: 不是本组织成员'; end if;
  return query
  select l.id, f.price, f.label from app.deal_lines l cross join lateral app.promo_for(l.product_id, d.customer_id) f
  where l.deal_id = p_deal and l.product_id is not null
    and round(coalesce(l.unit_price, 0) * case when d.currency = 'XOF' then 1 else coalesce(d.fx_rate, 0) end) = round(f.price);
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function app.deal_promos(uuid) to authenticated; end if;
end $$;
