-- 0039 (Frank 11-11 夜, 待改 240 / 231 / 233 / 232)

-- ═══ ① 240 客户收货有差异 (少了 / 多了 / 发错 / 破损) ═══
-- 原销售单、出库单不改; 另记一张差异单, 只有中方能定: 认并冲减 / 补发 / 不认; 定之前这张单不能对账
create table app.receipt_discrepancies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  deal_id uuid not null references app.deals(id),
  shipment_id uuid not null references app.shipments(id),
  kind text not null check (kind in ('short','over','wrong','damaged')),
  lines jsonb not null,                 -- [{deal_line_id, model, shipped, received, unit_price}]
  amount numeric(18,2) not null default 0,     -- 少的那部分值多少钱 (账务币)
  proof text not null, note text,
  late boolean not null default false,  -- 签收 24 小时之后才反馈 → 只能中方特批
  status text not null default 'open' check (status in ('open','decided')),
  decision text check (decision in ('credit','reship','reject')),
  fault text, goods_where text check (goods_where in ('in_warehouse','lost','with_customer','unknown')),
  decide_note text, decided_by uuid, decided_at timestamptz,
  reported_by uuid, reported_at timestamptz not null default now()
);
create index on app.receipt_discrepancies (deal_id);
alter table app.receipt_discrepancies enable row level security;
create policy rd_read on app.receipt_discrepancies for select using (app.is_member(org_id));

create or replace function app.report_discrepancy(p_shipment uuid, p_kind text, p_lines jsonb, p_proof text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; d app.deals; x jsonb; sl record; v_out jsonb := '[]'; v_amt numeric := 0; v_id uuid; v_hours numeric; v_window numeric;
begin
  select * into s from app.shipments where id = p_shipment;
  if s.id is null or s.voided_at is not null then raise exception 'NOT_FOUND: 出库单不存在'; end if;
  select * into d from app.deals where id = s.deal_id;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales', 'finance');
  if coalesce(p_kind, '') not in ('short','over','wrong','damaged') then raise exception 'VALIDATION: 选差异类型'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传客户给的凭证（开箱照片 / 视频截图 / 聊天截图）'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'VALIDATION: 填哪几个型号有差异、客户实际收到多少'; end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    select sl2.qty, sl2.unit_price, coalesce(p.model, dl.req_model) as model, dl.id as line_id into sl
    from app.shipment_lines sl2 join app.deal_lines dl on dl.id = sl2.deal_line_id left join app.products p on p.id = dl.product_id
    where sl2.shipment_id = p_shipment and sl2.deal_line_id = (x->>'deal_line_id')::uuid;
    if sl.line_id is null then raise exception 'VALIDATION: 这一行不在这批出库里'; end if;
    if (x->>'received')::int < 0 then raise exception 'VALIDATION: 实收数量不对'; end if;
    if (x->>'received')::int = sl.qty and p_kind in ('short','over') then continue; end if;
    v_out := v_out || jsonb_build_object('deal_line_id', sl.line_id, 'model', sl.model, 'shipped', sl.qty, 'received', (x->>'received')::int, 'unit_price', sl.unit_price);
    v_amt := v_amt + greatest(sl.qty - (x->>'received')::int, 0) * sl.unit_price;
  end loop;
  if jsonb_array_length(v_out) = 0 then raise exception 'VALIDATION: 实收和出库数量一样，没有差异'; end if;
  v_window := coalesce((select (value->>'hours')::numeric from app.org_settings where org_id = d.org_id and key = 'discrepancy_window'), 24);
  v_hours := extract(epoch from (now() - coalesce(s.customer_received_at, now()))) / 3600;
  insert into app.receipt_discrepancies (org_id, deal_id, shipment_id, kind, lines, amount, proof, note, late, reported_by)
  values (d.org_id, d.id, p_shipment, p_kind, v_out, v_amt, p_proof, nullif(trim(coalesce(p_note, '')), ''), v_hours > v_window, app.uid()) returning id into v_id;
  perform app.deal_event(d.id, 'receipt_discrepancy', jsonb_build_object('kind', p_kind, 'amount', v_amt, 'out_no', s.out_no, 'late', v_hours > v_window));
  return v_id;
end $$;

-- 中方处理: credit = 认, 从客户账上扣掉 (Balance 多一行); reship = 认, 补发 (钱不动, 另出一批); reject = 不认
create or replace function app.decide_discrepancy(p_id uuid, p_decision text, p_fault text, p_goods_where text, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipt_discrepancies; d app.deals; x jsonb; v_stock uuid; v_qty int;
begin
  select * into r from app.receipt_discrepancies where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if r.status <> 'open' then raise exception 'BAD_STATE: 这张差异单已经处理过了'; end if;
  if coalesce(p_decision, '') not in ('credit','reship','reject') then raise exception 'VALIDATION: 选怎么处理'; end if;
  if coalesce(trim(p_fault), '') = '' then raise exception 'VALIDATION: 必须写清楚是哪个环节 / 谁的问题'; end if;
  if coalesce(p_goods_where, '') not in ('in_warehouse','lost','with_customer','unknown') then raise exception 'VALIDATION: 选货现在在哪'; end if;
  if p_decision = 'reject' and coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 不认要写原因'; end if;
  select * into d from app.deals where id = r.deal_id;
  if p_decision = 'credit' and r.amount > 0 then
    insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id, note)
    values (r.org_id, d.customer_id, d.currency, 'writeoff', -r.amount, d.id, r.id, '收货差异调整');
  end if;
  -- 认了、货其实还在仓库 (少发了): 库存加回来
  if p_decision in ('credit','reship') and p_goods_where = 'in_warehouse' then
    for x in select * from jsonb_array_elements(r.lines) loop
      v_qty := greatest((x->>'shipped')::int - (x->>'received')::int, 0);
      select stock_item_id into v_stock from app.deal_lines where id = (x->>'deal_line_id')::uuid;
      if v_qty > 0 and v_stock is not null then perform app.move_stock(v_stock, v_qty, 'discrepancy_back', 'discrepancy', r.id); end if;
    end loop;
  end if;
  update app.receipt_discrepancies set status = 'decided', decision = p_decision, fault = trim(p_fault), goods_where = p_goods_where,
    decide_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = app.uid(), decided_at = now() where id = p_id;
  perform app.deal_event(r.deal_id, 'discrepancy_decided', jsonb_build_object('decision', p_decision, 'amount', r.amount, 'fault', trim(p_fault), 'note', p_note));
end $$;

-- 有没处理的差异单 → 不能对账
create or replace function app.confirm_balance(p_deal uuid, p_method text, p_proof text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales_manager', 'sales', 'finance');
  if not exists (select 1 from app.shipments where deal_id = p_deal and voided_at is null) then raise exception 'BAD_STATE: 还没出库，没有可对的账'; end if;
  if exists (select 1 from app.shipments where deal_id = p_deal and voided_at is null and customer_received_at is null) then raise exception 'BAD_STATE: 还有没签收的批次，先签收再对账'; end if;
  if exists (select 1 from app.receipt_discrepancies where deal_id = p_deal and status = 'open') then raise exception 'BAD_STATE: 这张单有收货差异还没处理，等中方定了再对账'; end if;
  if coalesce(p_method, '') not in ('whatsapp', 'phone', 'in_store') then raise exception 'VALIDATION: 选确认方式'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传客户确认对账的截图'; end if;
  update app.deals set balance_confirmed_at = now(), balance_confirmed_by = app.uid(), balance_method = p_method,
    balance_proof = p_proof, balance_note = nullif(trim(coalesce(p_note, '')), '') where id = p_deal;
  perform app.deal_event(p_deal, 'balance_confirmed', jsonb_build_object('method', p_method, 'note', nullif(trim(coalesce(p_note, '')), '')));
end $$;

-- ═══ ② 231 档位只有中方能定 ═══
-- 员工可以建客户 (名字 / 电话 / 店铺类型), 但档位: 新建一律先按最贵档 REPAIR, 等中方定; 非中方改档位直接拦
alter table app.customers add column tier_confirmed_at timestamptz, add column tier_confirmed_by uuid, add column tier_review_on date, add column tier_note text;
update app.customers set tier_confirmed_at = now(), tier_note = '0039 之前已有的客户，默认已确认' where tier is not null;
create or replace function app.guard_customer_tier() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if app.uid() is null or exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = new.org_id and m.active and 'admin' = any(m.roles)) then
    if tg_op = 'INSERT' and new.tier is not null and new.tier_confirmed_at is null then new.tier_confirmed_at := now(); new.tier_confirmed_by := app.uid(); end if;
    return new;                                   -- 系统导入 / 中方: 放行 (带了档位就算定过)
  end if;
  if tg_op = 'INSERT' then
    new.tier := 'REPAIR'; new.tier_confirmed_at := null;    -- 员工建的客户: 先按最贵档, 等中方定
  elsif new.tier is distinct from old.tier then
    raise exception 'PERMISSION_DENIED: 客户档位只有中方能定';
  end if;
  return new;
end $$;
create trigger customers_tier_guard before insert or update of tier on app.customers for each row execute function app.guard_customer_tier();

-- 中方定档: confirm = 就是这个档 (不再提醒); trial = 先用这个档试 N 个月, 到期再提醒
create or replace function app.confirm_customer_tier(p_customer uuid, p_tier app.customer_tier, p_mode text, p_months int default 2, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(c.org_id, 'admin');
  if p_tier is null then raise exception 'VALIDATION: 选档位'; end if;
  if coalesce(p_mode, '') not in ('confirm', 'trial') then raise exception 'VALIDATION: 选 立即确认 / 先试一段时间'; end if;
  update app.customers set tier = p_tier, tier_confirmed_at = now(), tier_confirmed_by = app.uid(),
    tier_review_on = case when p_mode = 'trial' then (current_date + make_interval(months => greatest(coalesce(p_months, 2), 1)))::date else null end,
    tier_note = nullif(trim(coalesce(p_note, '')), '') where id = p_customer;
  perform app.audit(c.org_id, 'confirm_customer_tier', 'customers', p_customer, jsonb_build_object('from', c.tier, 'to', p_tier, 'mode', p_mode, 'months', p_months, 'note', p_note));
end $$;

-- ═══ ③ 233 档位 × 提货量: 最近 3 个月月均片数 (只算本地出库) ═══
create or replace view app.v_customer_volume as
select c.org_id, c.id as customer_id,
  coalesce((select sum(sl.qty) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
            where d.customer_id = c.id and sh.voided_at is null and sh.shipped_at > now() - interval '90 days'), 0)::int as pcs_90,
  coalesce((select sum(sl.qty) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
            where d.customer_id = c.id and sh.voided_at is null), 0)::int as pcs_all,
  (select min(sh.shipped_at) from app.shipments sh join app.deals d on d.id = sh.deal_id where d.customer_id = c.id and sh.voided_at is null) as first_ship_at
from app.customers c;
alter view app.v_customer_volume set (security_invoker = true);

-- ═══ ④ 232 Yango 运费: 谁出 + 财务 / 中方付完自动记一笔支出 ═══
alter table app.shipments add column freight_bearer text check (freight_bearer in ('customer','company','company_part')),
  add column freight_est numeric(18,2), add column freight_amount numeric(18,2), add column freight_account_id uuid references app.cash_accounts(id),
  add column freight_proof text, add column freight_paid_at timestamptz, add column freight_paid_by uuid, add column freight_move_id uuid;
create or replace function app.set_ship_freight(p_shipment uuid, p_bearer text, p_est numeric default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; v_org uuid;
begin
  select * into s from app.shipments where id = p_shipment;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  select org_id into v_org from app.deals where id = s.deal_id;
  perform app.require_role(v_org, 'manager', 'picker', 'hotline', 'finance');
  if coalesce(p_bearer, '') not in ('customer','company','company_part') then raise exception 'VALIDATION: 选运费谁出'; end if;
  if s.freight_paid_at is not null then raise exception 'BAD_STATE: 运费已经付过了'; end if;
  update app.shipments set freight_bearer = p_bearer, freight_est = case when p_bearer = 'customer' then null else p_est end where id = p_shipment;
end $$;
create or replace function app.pay_ship_freight(p_shipment uuid, p_account uuid, p_amount numeric, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; d app.deals; a app.cash_accounts; v_mv uuid;
begin
  select * into s from app.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  select * into d from app.deals where id = s.deal_id;
  perform app.require_role(d.org_id, 'finance');
  if coalesce(s.freight_bearer, 'customer') = 'customer' then raise exception 'BAD_STATE: 这批运费是客户出，不用我们付'; end if;
  if s.freight_paid_at is not null then raise exception 'BAD_STATE: 运费已经付过了'; end if;
  select * into a from app.cash_accounts where id = p_account and org_id = d.org_id;
  if a.id is null then raise exception 'VALIDATION: 选从哪个账户付'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传支付截图'; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, customer_id, proof, note, created_by, decided_by, decided_at, biz_type, flow_class)
  values (d.org_id, p_account, 'expense', p_amount, current_date, 'approved', '本地物流费', d.customer_id, p_proof, '运费 ' || s.out_no || ' · ' || d.biz_no, app.uid(), app.uid(), now(), '备件', '运营费用')
  returning id into v_mv;
  update app.shipments set freight_amount = p_amount, freight_account_id = p_account, freight_proof = p_proof, freight_paid_at = now(), freight_paid_by = app.uid(), freight_move_id = v_mv where id = p_shipment;
  perform app.deal_event(d.id, 'freight_paid', jsonb_build_object('out_no', s.out_no, 'amount', p_amount));
  return v_mv;
end $$;

revoke all on function app.report_discrepancy(uuid, text, jsonb, text, text), app.decide_discrepancy(uuid, text, text, text, text),
  app.confirm_customer_tier(uuid, app.customer_tier, text, int, text), app.set_ship_freight(uuid, text, numeric), app.pay_ship_freight(uuid, uuid, numeric, text) from public;
grant execute on function app.report_discrepancy(uuid, text, jsonb, text, text), app.decide_discrepancy(uuid, text, text, text, text),
  app.confirm_customer_tier(uuid, app.customer_tier, text, int, text), app.set_ship_freight(uuid, text, numeric), app.pay_ship_freight(uuid, uuid, numeric, text) to authenticated;
grant select on app.receipt_discrepancies, app.v_customer_volume to authenticated;
