-- LA&9S Operations · 0045 (Frank 2026-11-13, 待改 277–290 + 财务排查 B1–B10)
-- ① 账: 价格调整计入订单欠款 (B1)、退款扣掉没冲的预付 (B2)、多冲的钱自动退回预付 (B3)、抹零上限进设置 (B4)、每日对账自检 (B5)、
--       有争议的单自动冲账先跳过 (B6)、手续费支出记「办公费」(B7)
-- ② 销售员名下有隔天没收回的欠款 → 他名下所有客户暂不出货 (中方放行 / 员工申诉)
-- ③ 改价: 销售订单阶段员工申请改价 → 中方审批 (批 / 驳都要写备注); 「异价单」标记; 「变更通知」
-- ④ 仓库提成进工资单 (自动带出、可改、进实发)
-- ⑤ 金蝶: 其他出入库 / 调拨 / 退货入库 的待录清单

-- ───────────────────────── ① 账 ─────────────────────────
-- B1: 订单欠款 = 出库 − 退货 − 已冲 − 核销 + 价格调整 (adjust 且挂在订单上的)
create or replace view app.v_deal_totals as
select d.id as deal_id, d.org_id, d.customer_id, d.currency, d.kind, d.status,
  coalesce((select sum(sl.amount) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id
            where sh.deal_id = d.id and sh.voided_at is null), 0)
  + coalesce((select sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'opening'), 0) as shipped_amount,
  coalesce((select sum(r.amount) from app.returns r where r.deal_id = d.id and r.status = 'approved'), 0) as returned_amount,
  coalesce((select sum(a.amount) from app.receipt_allocations a where a.deal_id = d.id), 0) as allocated_amount,
  coalesce((select min(sh.shipped_at) from app.shipments sh where sh.deal_id = d.id and sh.voided_at is null), d.opened_on::timestamptz) as first_shipped_at,
  coalesce((select -sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'writeoff'), 0) as writeoff_amount,
  coalesce((select sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'adjust'), 0) as adjust_amount
from app.deals d;

create or replace view app.v_deal_due as
select t.deal_id, t.org_id, t.customer_id, t.currency, t.kind, t.status, t.shipped_amount, t.returned_amount, t.allocated_amount, t.first_shipped_at, t.writeoff_amount,
  t.shipped_amount - t.returned_amount - t.allocated_amount - t.writeoff_amount + t.adjust_amount as due,
  t.adjust_amount
from app.v_deal_totals t;

-- B2: 退款从「没冲的预付」里扣 (记在具体收款单上), 以后不会再被自动冲一次
create table app.receipt_refunds (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references app.receipts(id),
  move_id uuid,
  amount numeric(18,2) not null check (amount > 0),
  at timestamptz not null default now()
);
create index on app.receipt_refunds (receipt_id);
alter table app.receipt_refunds enable row level security;
create policy receipt_refunds_read on app.receipt_refunds for select using (exists (select 1 from app.receipts r where r.id = receipt_id and app.is_member(r.org_id)));

drop view app.v_receipt_open;
create view app.v_receipt_open as
select r.*, case when r.voided_at is not null then 0
  else r.converted - coalesce((select sum(a.amount) from app.receipt_allocations a where a.receipt_id = r.id), 0)
                   - coalesce((select sum(f.amount) from app.receipt_refunds f where f.receipt_id = r.id), 0) end as unallocated
from app.receipts r;
alter view app.v_receipt_open set (security_invoker = true);
grant select on app.v_receipt_open to authenticated;

create or replace function app.refund_customer(p_customer uuid, p_account uuid, p_amount numeric, p_on date, p_reason text, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; a app.cash_accounts; v_mv uuid; v_open numeric; o record; v_left numeric; v_cut numeric;
begin
  select * into c from app.customers where id = p_customer;
  select * into a from app.cash_accounts where id = p_account and org_id = c.org_id;
  perform app.require_role(c.org_id, 'admin');
  if a.id is null then raise exception 'VALIDATION: 选从哪个账户退'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if coalesce(trim(p_reason),'') = '' or coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 退款要写原因、传凭证'; end if;
  select coalesce(sum(unallocated), 0) into v_open from app.v_receipt_open where customer_id = p_customer and account_currency = a.currency and unallocated > 0;
  if p_amount > v_open then
    raise exception 'VALIDATION: 这个客户没冲到订单上的预付只有 % %，退不了 %（已经冲到订单上的钱，先「改冲账」放回预付再退）', to_char(v_open, 'FM999,999,999,990.##'), a.currency, to_char(p_amount, 'FM999,999,999,990.##');
  end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, customer_id, proof, note, created_by, decided_by, decided_at, biz_type, flow_class)
  values (c.org_id, p_account, 'expense', p_amount, p_on, 'approved', '退款', p_customer, p_proof, '退款给客户：' || p_reason, app.uid(), app.uid(), now(), '备件', '收客户货款')
  returning id into v_mv;
  v_left := p_amount;
  for o in select id, unallocated from app.v_receipt_open where customer_id = p_customer and account_currency = a.currency and unallocated > 0 order by received_on, rcv_no loop
    exit when v_left <= 0;
    v_cut := least(v_left, o.unallocated);
    insert into app.receipt_refunds (receipt_id, move_id, amount) values (o.id, v_mv, v_cut);
    v_left := v_left - v_cut;
  end loop;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, ref_id, note)
  values (c.org_id, p_customer, a.currency, 'adjust', p_amount, v_mv, '退款：' || p_reason);
  perform app.audit(c.org_id, 'refund_customer', 'customers', p_customer, jsonb_build_object('amount', p_amount, 'account', p_account));
  return v_mv;
end $$;

-- B3: 订单的应收被调低 (收货差异冲减 / 价格调低 / 抹零) 后, 如果已经多收 → 多出的钱退回预付, 下一单能冲到
create or replace function app.trg_ar_release_over() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.deal_id is not null and new.kind in ('writeoff','adjust') and new.amount < 0 then perform app.release_overallocation(new.deal_id); end if;
  return null;
end $$;
create trigger ar_release_over after insert on app.ar_entries for each row execute function app.trg_ar_release_over();

-- B4: 抹零上限进设置 (org_settings writeoff_rules {max_xof, max_other}), 默认 100 XOF / 1
create or replace function app.write_off(p_deal uuid, p_amount numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_due numeric; v_rule jsonb; v_max numeric;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'admin');
  select due into v_due from app.v_deal_due where deal_id = p_deal;
  select value into v_rule from app.org_settings where org_id = d.org_id and key = 'writeoff_rules';
  v_max := case when d.currency = 'XOF' then coalesce((v_rule->>'max_xof')::numeric, 100) else coalesce((v_rule->>'max_other')::numeric, 1) end;
  if p_amount <= 0 or p_amount > v_due then raise exception 'VALIDATION: 抹零金额必须大于 0 且不超过未付'; end if;
  if p_amount > v_max then raise exception 'VALIDATION: 抹零超过上限（现在是 % %，设置 → 规则参数里可调）', v_max, d.currency; end if;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, note)
  values (d.org_id, d.customer_id, d.currency, 'writeoff', -p_amount, p_deal, '抹零：' || coalesce(p_reason,''));
  perform app.audit(d.org_id, 'write_off', 'deals', p_deal, jsonb_build_object('amount', p_amount));
end $$;

-- B5: 对账自检 —— 每个客户: 各单欠款合计 − 没冲的预付 必须 = 总账余额
create or replace function app.ledger_check(p_org uuid)
returns table (customer_id uuid, customer_name text, currency text, balance numeric, due_sum numeric, unallocated numeric, diff numeric)
language sql stable security definer set search_path = app, public as $$
  with b as (select e.customer_id, e.currency, sum(e.amount) as balance from app.ar_entries e where e.org_id = p_org group by 1, 2),
       du as (select t.customer_id, t.currency, sum(t.due) as due_sum from app.v_deal_due t where t.org_id = p_org group by 1, 2),
       u as (select o.customer_id, o.account_currency as currency, sum(o.unallocated) as unallocated from app.v_receipt_open o where o.org_id = p_org group by 1, 2),
       k as (select customer_id, currency from b union select customer_id, currency from du union select customer_id, currency from u)
  select k.customer_id, c.name, k.currency, coalesce(b.balance, 0), coalesce(du.due_sum, 0), coalesce(u.unallocated, 0),
         coalesce(b.balance, 0) - (coalesce(du.due_sum, 0) - coalesce(u.unallocated, 0))
  from k join app.customers c on c.id = k.customer_id
  left join b on b.customer_id = k.customer_id and b.currency = k.currency
  left join du on du.customer_id = k.customer_id and du.currency = k.currency
  left join u on u.customer_id = k.customer_id and u.currency = k.currency
  where app.is_member(p_org) and abs(coalesce(b.balance, 0) - (coalesce(du.due_sum, 0) - coalesce(u.unallocated, 0))) >= 0.01
$$;

-- B6: 自动冲最老的单: 有没处理完的收货差异的单先跳过
create or replace function app.allocate(p_receipt uuid, p_mode text, p_targets jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts; v_left numeric; t record; v_take numeric; x jsonb;
begin
  select * into r from app.receipts where id = p_receipt for update;
  select unallocated into v_left from app.v_receipt_open where id = p_receipt;
  if p_mode = 'none' then return; end if;
  if p_mode = 'oldest' then
    for t in select v.deal_id, v.due from app.v_deal_due v
             where v.customer_id = r.customer_id and v.currency = r.account_currency and v.due > 0 and v.status <> 'cancelled'
               and not exists (select 1 from app.receipt_discrepancies x where x.deal_id = v.deal_id and x.status = 'open')
             order by coalesce(v.first_shipped_at, '-infinity'::timestamptz), v.deal_id loop
      exit when v_left <= 0;
      v_take := least(v_left, t.due);
      insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, t.deal_id, v_take);
      v_left := v_left - v_take;
    end loop;
  elsif p_mode = 'specific' then
    for x in select * from jsonb_array_elements(p_targets) loop
      exit when v_left <= 0;
      select due into v_take from app.v_deal_due where deal_id = (x#>>'{}')::uuid and customer_id = r.customer_id and currency = r.account_currency;
      v_take := least(v_left, greatest(coalesce(v_take,0),0));
      if v_take > 0 then
        insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, (x#>>'{}')::uuid, v_take);
        v_left := v_left - v_take;
      end if;
    end loop;
  elsif p_mode = 'manual' then
    for x in select * from jsonb_array_elements(p_targets) loop
      select due into v_take from app.v_deal_due where deal_id = (x->>'deal_id')::uuid and customer_id = r.customer_id and currency = r.account_currency;
      if (x->>'amount')::numeric > coalesce(v_take,0) then raise exception 'VALIDATION: 分配金额超过该单未收'; end if;
      if (x->>'amount')::numeric > v_left then raise exception 'VALIDATION: 分配总额超过收款'; end if;
      insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, (x->>'deal_id')::uuid, (x->>'amount')::numeric);
      v_left := v_left - (x->>'amount')::numeric;
    end loop;
  else raise exception 'VALIDATION: unknown mode %', p_mode;
  end if;
end $$;

-- B7: 手续费 —— 客户账按全额冲, 被扣掉的手续费另记一笔支出, 科目「办公费」
create or replace function app.receipt_to_account(r app.receipts, p_account uuid, p_move uuid default null)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if p_account is null then return; end if;
  if p_move is not null then
    update app.cash_moves set status = 'claimed', customer_id = r.customer_id, receipt_id = r.id, biz_type = coalesce(biz_type, '备件'), flow_class = '收客户货款',
      decided_by = app.uid(), decided_at = now() where id = p_move;
  else
    insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, payer, customer_id, receipt_id, proof, note, created_by, biz_type, flow_class)
    values (r.org_id, p_account, 'deposit', coalesce(r.landed, r.amount), r.received_on, 'claimed', r.payer, r.customer_id, r.id, r.proof_path, '收款 ' || r.rcv_no, app.uid(), '备件', '收客户货款');
  end if;
  if r.fee > 0 and r.fee_bearer = 'company' then
    insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, customer_id, receipt_id, note, created_by, biz_type, flow_class, decided_by, decided_at)
    values (r.org_id, p_account, 'expense', r.fee, r.received_on, 'approved', '办公费', r.customer_id, r.id, '收款手续费 ' || r.rcv_no, app.uid(), '备件', '运营费用', app.uid(), now());
  end if;
end $$;

-- ───────────────────────── ② 销售员名下有欠款 → 暂不出货 ─────────────────────────
-- 规矩 (Frank 11-13): 按销售员名义。他名下任何客户有「今天以前出的货还没付清」→ 他名下所有客户都暂不出货。
-- 当天出的货当天不追; 中方可以对某张单放行 (写原因, 沿用 release_debt_block); 客户说已付但还没核对 → 员工「申诉」, 中方最优先处理。
create or replace function app.rep_debt(p_owner uuid)
returns table (customer_id uuid, customer_name text, deal_id uuid, biz_no text, due numeric, currency text, shipped_on date)
language sql stable security definer set search_path = app, public as $$
  select c.id, c.name, t.deal_id, d.biz_no, t.due, t.currency, t.first_shipped_at::date
  from app.customers c join app.v_deal_due t on t.customer_id = c.id join app.deals d on d.id = t.deal_id
  where p_owner is not null and c.owner_employee_id = p_owner and app.is_member(c.org_id)
    and t.due > 0 and t.status <> 'cancelled' and t.first_shipped_at::date < current_date
  order by t.first_shipped_at
$$;

create table app.payment_appeals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  deal_id uuid not null references app.deals(id),
  note text not null, proof text not null,
  status text not null default 'open' check (status in ('open','accepted','rejected')),
  created_by uuid, created_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz, decision_note text
);
create index on app.payment_appeals (org_id, status);
alter table app.payment_appeals enable row level security;
create policy payment_appeals_read on app.payment_appeals for select using (app.is_member(org_id));

create or replace function app.rep_block_on(p_org uuid) returns boolean language sql stable security definer set search_path = app, public as $$
  select coalesce((select (value->>'on')::boolean from app.org_settings where org_id = p_org and key = 'rep_debt_rules'), true)
$$;

create or replace function app.trg_ship_rep_block() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals; c app.customers; v_n int; v_who text; v_names text;
begin
  select * into d from app.deals where id = new.deal_id;
  if d.kind <> 'normal' or d.debt_released_at is not null or not app.rep_block_on(d.org_id) then return new; end if;
  select * into c from app.customers where id = d.customer_id;
  if c.owner_employee_id is null then return new; end if;
  select count(distinct t.customer_id), string_agg(distinct cc.name, '、') into v_n, v_names
  from app.v_deal_due t join app.customers cc on cc.id = t.customer_id
  where cc.owner_employee_id = c.owner_employee_id and t.due > 0 and t.status <> 'cancelled' and t.first_shipped_at::date < current_date;
  if coalesce(v_n, 0) = 0 then return new; end if;
  select coalesce(short_name, full_name) into v_who from app.employees where id = c.owner_employee_id;
  raise exception 'REP_DEBT: 销售员 % 名下还有 % 个客户的货款没收回（%），他名下的客户暂不出货。钱收到并登记后自动放开；客户说已经付了 → 点「申诉」让中方核对；中方也可以对这张单放行。', coalesce(v_who, ''), v_n, left(v_names, 80);
end $$;
create trigger ship_rep_block before insert on app.shipments for each row execute function app.trg_ship_rep_block();

create or replace function app.appeal_payment(p_deal uuid, p_note text, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_id uuid;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED: 不是本组织成员'; end if;
  if coalesce(trim(p_note), '') = '' or coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 申诉要写清楚谁付的、付了多少，并传付款截图'; end if;
  if exists (select 1 from app.payment_appeals where deal_id = p_deal and status = 'open') then raise exception 'BAD_STATE: 这张单已经有一条申诉在等中方处理'; end if;
  insert into app.payment_appeals (org_id, deal_id, note, proof, created_by) values (d.org_id, p_deal, trim(p_note), p_proof, app.uid()) returning id into v_id;
  perform app.deal_event(p_deal, 'payment_appeal', jsonb_build_object('note', trim(p_note)));
  return v_id;
end $$;

create or replace function app.decide_payment_appeal(p_id uuid, p_ok boolean, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.payment_appeals;
begin
  select * into a from app.payment_appeals where id = p_id for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(a.org_id, 'admin');
  if a.status <> 'open' then raise exception 'BAD_STATE: 这条申诉已经处理过了'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 处理申诉要写结果（核对到了什么）'; end if;
  update app.payment_appeals set status = case when p_ok then 'accepted' else 'rejected' end, decided_by = app.uid(), decided_at = now(), decision_note = trim(p_note) where id = p_id;
  if p_ok then
    update app.deals set debt_released_by = app.uid(), debt_released_at = now(), debt_release_note = '申诉通过：' || trim(p_note) where id = a.deal_id;
  end if;
  perform app.deal_event(a.deal_id, 'payment_appeal_decided', jsonb_build_object('ok', p_ok, 'note', trim(p_note)));
end $$;

-- ───────────────────────── ③ 改价审批 / 异价单 / 变更通知 ─────────────────────────
alter table app.deal_lines add column odd boolean not null default false,          -- 单价偏离档位价超过阈值 (异价)
  add column price_req numeric(18,2), add column price_req_note text, add column price_req_by uuid, add column price_req_at timestamptz;   -- 销售订单阶段: 员工申请的价, 等中方批

create or replace function app.trg_line_odd() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_tier numeric; v_pct numeric;
begin
  new.odd := false;
  if new.product_id is null or not (coalesce(new.unit_price, 0) > 0 or coalesce(new.price_manual, false)) then return new; end if;
  select * into d from app.deals where id = new.deal_id;
  v_tier := app.deal_price(d, new.product_id);
  if coalesce(v_tier, 0) <= 0 then return new; end if;
  select coalesce((value->>'odd_pct')::numeric, 10) into v_pct from app.org_settings where org_id = d.org_id and key = 'price_rules';
  new.odd := abs(coalesce(new.unit_price, 0) - v_tier) / v_tier * 100 > coalesce(v_pct, 10);
  return new;
end $$;
create trigger line_odd before insert or update of unit_price, product_id, price_manual on app.deal_lines for each row execute function app.trg_line_odd();

-- 员工申请改价 (初检后 → 出库前): 不直接生效, 等中方批; 批之前不能往下走
create or replace function app.request_line_price(p_line uuid, p_price numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare l app.deal_lines; d app.deals;
begin
  select * into l from app.deal_lines where id = p_line for update;
  select * into d from app.deals where id = l.deal_id;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'manager', 'hotline', 'sales', 'sales_manager', 'finance');
  if d.status not in ('picked','ordered','confirmed','reviewed') then raise exception 'BAD_STATE: 这一步不能申请改价'; end if;
  if coalesce(p_price, -1) < 0 then raise exception 'VALIDATION: 价格不能为负'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 申请改价要写原因'; end if;
  update app.deal_lines set price_req = p_price, price_req_note = trim(p_reason), price_req_by = app.uid(), price_req_at = now() where id = p_line;
  perform app.deal_event(d.id, 'price_requested', jsonb_build_object('line', p_line, 'from', l.unit_price, 'to', p_price, 'reason', trim(p_reason)));
end $$;

create or replace function app.decide_line_price(p_line uuid, p_ok boolean, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare l app.deal_lines; d app.deals;
begin
  select * into l from app.deal_lines where id = p_line for update;
  select * into d from app.deals where id = l.deal_id;
  perform app.require_role(d.org_id, 'admin');
  if l.price_req is null then raise exception 'BAD_STATE: 这一行没有在等审批的改价'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 批 / 不批都要写备注（为什么给这个价）'; end if;
  update app.deal_lines set price_req = null, price_req_note = null, price_req_by = null, price_req_at = null where id = p_line;
  if p_ok then perform app.set_line_price(p_line, l.price_req, trim(p_note)); end if;
  perform app.deal_event(d.id, 'price_decided', jsonb_build_object('line', p_line, 'ok', p_ok, 'from', l.unit_price, 'to', l.price_req, 'reason', l.price_req_note, 'note', trim(p_note)));
end $$;

-- 改价没批完不能往下推; 批特价必须写备注
create or replace function app.trg_deal_price_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status <> 'cancelled'
     and exists (select 1 from app.deal_lines l where l.deal_id = new.id and l.price_req is not null) then
    raise exception 'NEEDS_APPROVAL: 这张单有改价在等中方审批，批完才能往下走';
  end if;
  if new.approval = 'approved' and old.approval = 'pending' and coalesce(trim(new.approval_note), '') = ''
     and exists (select 1 from unnest(old.approval_reasons) x where x like '申请特价%') then
    raise exception 'VALIDATION: 批特价必须写备注（为什么给这个价）';
  end if;
  return new;
end $$;
create trigger deal_price_gate before update of status, approval on app.deals for each row execute function app.trg_deal_price_gate();

-- 变更通知: 不按正常流程走的事 (确认后改数量 / 改价 / 撤回 / 作废出库 / 拆单 / 重复照片 …) 一条条记下来, 中方点「已阅」
create table app.change_notices (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.orgs(id),
  deal_id uuid references app.deals(id) on delete cascade,
  kind text not null, detail jsonb,
  by_user uuid, at timestamptz not null default now(),
  read_by uuid, read_at timestamptz
);
create index on app.change_notices (org_id, read_at);
alter table app.change_notices enable row level security;
create policy change_notices_read on app.change_notices for select using (app.is_member(org_id));

create or replace function app.trg_event_notice() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  if new.action not in ('qty_changed','price_set','price_requested','price_decided','lines_added','step_reverted','shipment_voided','deal_split','quote_edited',
                        'receipt_voided','price_adjusted','debt_released','payment_appeal','cancelled','partial_reason') then return null; end if;
  select * into d from app.deals where id = new.deal_id;
  if new.action = 'quote_edited' and d.status = 'quoted' then return null; end if;          -- 还没确认的报价随便改, 不算变更
  if new.action = 'cancelled' and d.pick_no is null then return null; end if;                -- 还没找货就取消的不算
  insert into app.change_notices (org_id, deal_id, kind, detail, by_user) values (d.org_id, d.id, new.action, new.detail, new.user_id);
  return null;
end $$;
create trigger event_notice after insert on app.deal_events for each row execute function app.trg_event_notice();

-- 重复照片: 同一张图用在不止一个地方 → 只提示, 不拦 (任何成员上传时由界面调用)
create or replace function app.note_dup_photo(p_org uuid, p_deal uuid, p_where text, p_uses text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED: 不是本组织成员'; end if;
  insert into app.change_notices (org_id, deal_id, kind, detail, by_user)
  values (p_org, p_deal, 'dup_photo', jsonb_build_object('where', left(coalesce(p_where, ''), 200), 'uses', left(coalesce(p_uses, ''), 500)), app.uid());
end $$;

create or replace function app.ack_change_notices(p_ids bigint[])
returns int language plpgsql security definer set search_path = app, public as $$
declare n int; v_org uuid;
begin
  select org_id into v_org from app.change_notices where id = any(p_ids) limit 1;
  if v_org is null then return 0; end if;
  perform app.require_role(v_org, 'admin');
  update app.change_notices set read_by = app.uid(), read_at = now() where id = any(p_ids) and org_id = v_org and read_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────────────────────── ④ 仓库提成进工资单 ─────────────────────────
alter table app.payroll add column wh_comm numeric(18,2) not null default 0, add column wh_comm_auto numeric(18,2);

create or replace function app.payroll_recalc(p_org uuid, p_month date, p_emp uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare h app.payroll_months;
begin
  select * into h from app.payroll_months where org_id = p_org and month = p_month;
  update app.payroll p set
    base = round(least(coalesce(p.contract_salary,0), coalesce(p.contract_salary,0) / h.days_base * coalesce(p.days_worked, h.days_base))),
    updated_at = now()
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
  update app.payroll p set net = p.base + p.allowance + p.incentive + p.prime_team + coalesce(p.wh_comm, 0) + case when h.cnps_in_net then p.cnps else 0 end - p.deduction
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
end $$;

-- 按出货记录算提成 (正确出货每片 N XOF; 出错被记责任的单整单取消); 自动值只是依据: 没手改过的跟着自动值走, 手改过的不动 (p_force 才覆盖)
create or replace function app.payroll_wh_comm(p_org uuid, p_month date, p_emps uuid[] default null, p_force boolean default false)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months; v_rate numeric; n int;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.month is null then return 0; end if;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经确认发放，不能重算'; end if;
  select coalesce((value->>'per_piece')::numeric, 5) into v_rate from app.org_settings where org_id = p_org and key = 'wh_commission';
  v_rate := coalesce(v_rate, 5);
  update app.payroll p set
    wh_comm = case when p_force or p.wh_comm = coalesce(p.wh_comm_auto, 0) then x.amt else p.wh_comm end,
    wh_comm_auto = x.amt
  from (select p2.employee_id, coalesce((select sum(w.pieces) from app.v_wh_commission w where w.org_id = p_org and w.employee_id = p2.employee_id
                                          and w.month = to_char(m, 'YYYY-MM') and not w.voided), 0) * v_rate as amt
        from app.payroll p2 where p2.org_id = p_org and p2.month = m) x
  where p.org_id = p_org and p.month = m and p.employee_id = x.employee_id and (p_emps is null or p.employee_id = any(p_emps));
  get diagnostics n = row_count;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;

create or replace function app.payroll_set_wh_comm(p_org uuid, p_month date, p_emp uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经确认发放，不能改'; end if;
  if coalesce(p_amount, 0) < 0 then raise exception 'VALIDATION: 提成不能为负'; end if;
  update app.payroll set wh_comm = coalesce(p_amount, 0), updated_at = now() where org_id = p_org and month = m and employee_id = p_emp;
  perform app.payroll_recalc(p_org, m, p_emp);
  perform app.audit(p_org, 'payroll_wh_comm', 'payroll', p_emp, jsonb_build_object('month', m, 'amount', p_amount));
end $$;

-- ───────────────────────── ⑤ 金蝶: 其他出入库 / 调拨 / 退货入库 待录 ─────────────────────────
-- 销售出库走 kingdee_outbox (按出库单)。这里收的是其它会动库存的事: 收货差异补扣 / 冲回、冻结转待检、退货入库、检验分流、手工调整。
create table app.kingdee_misc (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  doc_type text not null,            -- 其他入库 / 其他出库 / 调拨 / 销售退货入库
  reason text not null, ref_type text, ref_id uuid,
  stock_item_id uuid not null references app.stock_items(id),
  qty int not null,
  at timestamptz not null default now(),
  status text not null default 'ready' check (status in ('ready','done','skip')),
  remote_no text, done_by uuid, done_at timestamptz, note text
);
create index on app.kingdee_misc (org_id, status);
alter table app.kingdee_misc enable row level security;
create policy kingdee_misc_read on app.kingdee_misc for select using (app.is_member(org_id));

create or replace function app.trg_move_kingdee() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_type text;
begin
  if new.reason in ('ship','ship_void','opening','grn') or new.qty = 0 then return null; end if;
  v_type := case when new.reason = 'return_in' then '销售退货入库'
                 when new.reason in ('inspect_good','inspect_scrap','hold_to_pending') then '调拨'
                 when new.qty > 0 then '其他入库' else '其他出库' end;
  select w.org_id into v_org from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.id = new.stock_item_id;
  insert into app.kingdee_misc (org_id, doc_type, reason, ref_type, ref_id, stock_item_id, qty, at)
  values (v_org, v_type, new.reason, new.ref_type, new.ref_id, new.stock_item_id, new.qty, new.at);
  return null;
end $$;
create trigger move_kingdee after insert on app.stock_moves for each row execute function app.trg_move_kingdee();

create or replace function app.kingdee_misc_done(p_ids uuid[], p_remote_no text, p_skip boolean default false)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; n int;
begin
  select org_id into v_org from app.kingdee_misc where id = any(p_ids) limit 1;
  if v_org is null then return 0; end if;
  perform app.require_role(v_org, 'admin', 'manager', 'finance');
  if not p_skip and coalesce(trim(p_remote_no), '') = '' then raise exception 'VALIDATION: 填金蝶里的单号'; end if;
  update app.kingdee_misc set status = case when p_skip then 'skip' else 'done' end, remote_no = nullif(trim(coalesce(p_remote_no, '')), ''), done_by = app.uid(), done_at = now()
  where id = any(p_ids) and org_id = v_org and status = 'ready';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function app.rep_debt(uuid), app.appeal_payment(uuid, text, text), app.decide_payment_appeal(uuid, boolean, text),
  app.request_line_price(uuid, numeric, text), app.decide_line_price(uuid, boolean, text), app.note_dup_photo(uuid, uuid, text, text),
  app.ack_change_notices(bigint[]), app.payroll_wh_comm(uuid, date, uuid[], boolean), app.payroll_set_wh_comm(uuid, date, uuid, numeric),
  app.kingdee_misc_done(uuid[], text, boolean), app.ledger_check(uuid), app.rep_block_on(uuid) from public;
grant execute on function app.rep_debt(uuid), app.appeal_payment(uuid, text, text), app.decide_payment_appeal(uuid, boolean, text),
  app.request_line_price(uuid, numeric, text), app.decide_line_price(uuid, boolean, text), app.note_dup_photo(uuid, uuid, text, text),
  app.ack_change_notices(bigint[]), app.payroll_wh_comm(uuid, date, uuid[], boolean), app.payroll_set_wh_comm(uuid, date, uuid, numeric),
  app.kingdee_misc_done(uuid[], text, boolean), app.ledger_check(uuid), app.rep_block_on(uuid) to authenticated;
grant select on app.receipt_refunds, app.payment_appeals, app.change_notices, app.kingdee_misc to authenticated;
