-- 0035 (Frank 11-11 214 / 217–220): 收款三段状态 + 手续费 + 员工代收 + 改冲账 + 每天对账 / 盘点 + 月结锁账 + 坏账核销 + 退款 + 账户互转在途 + 流水分类

-- ───────── ① 收款扩展 ─────────
alter table app.receipts
  add column account_id uuid references app.cash_accounts(id),      -- 钱进了哪个账户 (Wave-XOF / Cash-XOF …)
  add column landed numeric(18,2),                                   -- 实际到账金额 (原币)
  add column fee numeric(18,2) not null default 0,                   -- 手续费 (原币)
  add column fee_bearer text check (fee_bearer in ('customer','company')),
  add column payer text,                                             -- 付款人 (别人代付时写)
  add column collector_employee_id uuid references app.employees(id),-- 员工代收 (现金先给员工, 员工再转公司)
  add column handed_at timestamptz, add column handed_by uuid, add column handed_proof text,
  add column verify_status text not null default 'pending' check (verify_status in ('pending','verified')),
  add column verified_at timestamptz, add column verified_by uuid, add column verify_note text;
update app.receipts set landed = amount where landed is null;
-- 这次之前登记的收款: 当时没有「核对到账」这一步, 一律当已到账 (不然几十笔历史收款全挤进待核对、10 月也锁不了账)
update app.receipts set verify_status = 'verified', verified_at = now(), verify_note = '0035 之前登记，默认已到账' where verify_status = 'pending';

-- 流水分类 (照 Frank「CI 销售表 · 基本信息」): 业务类别 / 收支大类 / 一级科目 (= category)
alter table app.cash_moves add column biz_type text, add column flow_class text, add column pair_id uuid;
alter table app.cash_moves drop constraint if exists cash_moves_kind_check;
alter table app.cash_moves add constraint cash_moves_kind_check check (kind in ('opening','deposit','handover','expense','bank_out','transfer_out','transfer_in','count_adjust'));
alter table app.cash_moves drop constraint if exists cash_moves_status_check;
alter table app.cash_moves add constraint cash_moves_status_check check (status in ('unclaimed','claimed','other_income','pending','confirmed','approved','rejected','unexplained','in_transit'));

-- 余额方向: 转出马上减; 转入到了 (confirmed) 才加, 中间叫「在途」
create or replace function app.move_sign(m app.cash_moves) returns int language sql immutable as $$
  select case
    when m.kind in ('opening','deposit') then 1
    when m.kind = 'handover' and m.status = 'confirmed' then -1
    when m.kind = 'expense' and m.status = 'approved' then -1
    when m.kind = 'bank_out' then -1
    when m.kind = 'transfer_out' then -1
    when m.kind = 'transfer_in' and m.status = 'confirmed' then 1
    when m.kind = 'count_adjust' then 1          -- 盘点调整: amount 可正可负由 note 说明; 这里按正记, 负的用 expense
    else 0 end
$$;

-- 收款 (新版): 一个 jsonb 收齐所有字段
--   amount_landed = 实际到账; fee + fee_bearer: 客户出 → 冲客户账 = 到账; 我方出 → 冲客户账 = 到账 + 手续费 (差额记我方手续费支出)
--   collector_employee_id: 员工代收 → 客户账照冲, 钱挂员工名下在途, 交到公司才进账户
create or replace function app.record_receipt2(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_landed numeric := (p->>'amount_landed')::numeric; v_fee numeric := coalesce(nullif(p->>'fee','')::numeric, 0);
  v_bearer text := nullif(p->>'fee_bearer',''); v_credit numeric; v_acc uuid := nullif(p->>'account_id','')::uuid; a app.cash_accounts;
begin
  perform app.require_role(p_org, 'finance');
  if coalesce(v_landed, 0) <= 0 then raise exception 'VALIDATION: 到账金额要大于 0'; end if;
  if v_fee < 0 then raise exception 'VALIDATION: 手续费不能为负'; end if;
  if v_fee > 0 and v_bearer is null then raise exception 'VALIDATION: 有手续费要选谁出'; end if;
  if v_acc is not null then
    select * into a from app.cash_accounts where id = v_acc and org_id = p_org;
    if a.id is null then raise exception 'VALIDATION: 账户不存在'; end if;
    if a.currency <> p->>'currency' then raise exception 'VALIDATION: 账户币种 % 和收款币种 % 不一样', a.currency, p->>'currency'; end if;
  end if;
  v_credit := v_landed + case when v_bearer = 'company' then v_fee else 0 end;
  v_id := app.record_receipt(p_org, (p->>'customer_id')::uuid, (p->>'received_on')::date, v_credit, p->>'currency', (p->>'method')::app.pay_method,
    nullif(p->>'account_currency',''), coalesce(nullif(p->>'rate','')::numeric, 1), coalesce(nullif(p->>'mode',''), 'oldest'),
    coalesce(p->'targets', '[]'::jsonb), nullif(p->>'proof',''), nullif(p->>'note',''));
  update app.receipts set account_id = v_acc, landed = v_landed, fee = v_fee, fee_bearer = v_bearer, payer = nullif(trim(p->>'payer'),''),
    collector_employee_id = nullif(p->>'collector_employee_id','')::uuid where id = v_id;
  return v_id;
end $$;

-- 进账户: 到账核对过 (或员工交款) 时, 在账户里记一笔「收客户货款」; 我方出的手续费记一笔支出
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
    values (r.org_id, p_account, 'expense', r.fee, r.received_on, 'approved', '手续费', r.customer_id, r.id, '收款手续费（我方出）' || r.rcv_no, app.uid(), '备件', '运营费用', app.uid(), now());
  end if;
end $$;

-- 确认到账 (手动核对): 分工制衡 —— 登记的人不能自己确认, 中方除外 (现在中方一个人做也能走通)
create or replace function app.verify_receipt(p_receipt uuid, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts;
begin
  select * into r from app.receipts where id = p_receipt for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'finance');
  if r.voided_at is not null then raise exception 'BAD_STATE: 这笔收款已撤销'; end if;
  if r.verify_status = 'verified' then raise exception 'BAD_STATE: 已经确认到账了'; end if;
  if r.collector_employee_id is not null and r.handed_at is null then raise exception 'BAD_STATE: 员工代收的钱还没交到公司，交了再确认'; end if;
  if r.created_by = app.uid() and not app.has_role(r.org_id, array['admin']::app.role_name[]) then raise exception 'FORBIDDEN: 登记收款的人不能自己确认到账，请中方或另一位财务确认'; end if;
  update app.receipts set verify_status = 'verified', verified_at = now(), verified_by = app.uid(), verify_note = nullif(p_note,'') where id = p_receipt;
  if r.collector_employee_id is null then perform app.receipt_to_account(r, r.account_id); end if;
  perform app.audit(r.org_id, 'verify_receipt', 'receipts', p_receipt, jsonb_build_object('note', p_note));
end $$;

-- 导入 Wave / 银行流水后自动配对: 账户相同、金额 = 到账金额、日期前后 match_days 天、只有一个候选 → 自动确认到账
create or replace function app.auto_verify_receipts(p_account uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; r record; n int := 0; v_days int;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  select coalesce((select match_days from app.cash_settings where org_id = a.org_id), 3) into v_days;
  for r in
    select rc.id as rid, (array_agg(m.id))[1] as mid, count(*) as k
    from app.receipts rc join app.cash_moves m on m.account_id = rc.account_id and m.kind = 'deposit' and m.status = 'unclaimed'
      and m.amount = coalesce(rc.landed, rc.amount) and abs(m.on_date - rc.received_on) <= v_days
    where rc.account_id = p_account and rc.verify_status = 'pending' and rc.voided_at is null and rc.collector_employee_id is null
    group by rc.id
  loop
    continue when r.k <> 1;
    update app.receipts set verify_status = 'verified', verified_at = now(), verified_by = app.uid(), verify_note = '流水自动配对' where id = r.rid;
    perform app.receipt_to_account((select x from app.receipts x where x.id = r.rid), p_account, r.mid);
    n := n + 1;
  end loop;
  perform app.audit(a.org_id, 'auto_verify_receipts', 'cash_accounts', p_account, jsonb_build_object('matched', n));
  return n;
end $$;

-- 员工代收 → 交到公司 (存进 Wave 转来 / 现金当面交): 选进哪个账户; 交了才进账户、才能确认到账
create or replace function app.receipt_handed(p_receipt uuid, p_account uuid, p_proof text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts;
begin
  select * into r from app.receipts where id = p_receipt for update;
  perform app.require_role(r.org_id, 'finance');
  if r.collector_employee_id is null then raise exception 'BAD_STATE: 这笔不是员工代收'; end if;
  if r.handed_at is not null then raise exception 'BAD_STATE: 已经交过了'; end if;
  update app.receipts set handed_at = now(), handed_by = app.uid(), handed_proof = p_proof, account_id = coalesce(p_account, account_id) where id = p_receipt;
  select * into r from app.receipts where id = p_receipt;
  perform app.receipt_to_account(r, r.account_id);
  update app.receipts set verify_status = 'verified', verified_at = now(), verified_by = app.uid(), verify_note = coalesce(verify_note, '员工已交') where id = p_receipt;
  perform app.audit(r.org_id, 'receipt_handed', 'receipts', p_receipt, jsonb_build_object('account', p_account));
end $$;

create or replace view app.v_staff_held as
select r.id as receipt_id, r.org_id, r.rcv_no, r.customer_id, c.name as customer_name, r.collector_employee_id as employee_id, e.short_name as employee_name,
  r.landed, r.amount, r.currency, r.received_on, current_date - r.received_on as days
from app.receipts r join app.customers c on c.id = r.customer_id left join app.employees e on e.id = r.collector_employee_id
where r.collector_employee_id is not null and r.handed_at is null and r.voided_at is null;
alter view app.v_staff_held set (security_invoker = true);
grant select on app.v_staff_held to authenticated;

-- ───────── ② 改冲账: 把一笔收款冲在 A 单的钱挪到 B 单 / 改成预付; 收款本身不动 ─────────
create or replace function app.reallocate_receipt(p_receipt uuid, p_from_deal uuid, p_amount numeric, p_to_deal uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts; v_have numeric; v_due numeric; a record; v_cut numeric; v_left numeric := p_amount;
begin
  select * into r from app.receipts where id = p_receipt for update;
  perform app.require_role(r.org_id, 'finance');
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 改冲账要写原因'; end if;
  if r.voided_at is not null then raise exception 'BAD_STATE: 这笔收款已撤销'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if p_from_deal is not distinct from p_to_deal then raise exception 'VALIDATION: 挪出和挪入不能是同一张单'; end if;
  if p_from_deal is null then
    select unallocated into v_have from app.v_receipt_open where id = p_receipt;
  else
    select coalesce(sum(amount), 0) into v_have from app.receipt_allocations where receipt_id = p_receipt and deal_id = p_from_deal;
  end if;
  if p_amount > coalesce(v_have, 0) then raise exception 'VALIDATION: 这笔收款在原来那边只有 %，挪不了 %', coalesce(v_have, 0), p_amount; end if;
  if p_to_deal is not null then
    select due into v_due from app.v_deal_due where deal_id = p_to_deal and customer_id = r.customer_id and currency = r.account_currency;
    if v_due is null then raise exception 'VALIDATION: 目标订单不是这个客户的，或币种不一样'; end if;
    if p_amount > v_due then raise exception 'VALIDATION: 目标订单只欠 %，挪不了 %', v_due, p_amount; end if;
  end if;
  if p_from_deal is not null then
    for a in select id, amount from app.receipt_allocations where receipt_id = p_receipt and deal_id = p_from_deal order by at desc, id desc loop
      exit when v_left <= 0;
      v_cut := least(a.amount, v_left);
      if v_cut = a.amount then delete from app.receipt_allocations where id = a.id; else update app.receipt_allocations set amount = amount - v_cut where id = a.id; end if;
      v_left := v_left - v_cut;
    end loop;
    perform app.deal_event(p_from_deal, 'receipt_reallocated', jsonb_build_object('rcv_no', r.rcv_no, 'amount', -p_amount, 'reason', p_reason));
  end if;
  if p_to_deal is not null then
    insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, p_to_deal, p_amount);
    perform app.deal_event(p_to_deal, 'receipt_reallocated', jsonb_build_object('rcv_no', r.rcv_no, 'amount', p_amount, 'reason', p_reason));
  end if;
  perform app.audit(r.org_id, 'reallocate_receipt', 'receipts', p_receipt, jsonb_build_object('from', p_from_deal, 'to', p_to_deal, 'amount', p_amount, 'reason', p_reason));
end $$;

-- ───────── ③ 每天对账 / 现金盘点 ─────────
create table app.cash_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  account_id uuid not null references app.cash_accounts(id),
  kind text not null check (kind in ('recon','count')),           -- recon = 对流水余额; count = 现金盘点
  on_date date not null,
  system_balance numeric(18,2) not null,
  actual_balance numeric(18,2) not null,
  diff numeric(18,2) generated always as (actual_balance - system_balance) stored,
  note text, proof text,
  created_by uuid, created_at timestamptz not null default now()
);
create index on app.cash_checks (account_id, on_date desc);
alter table app.cash_checks enable row level security;
create policy read_fin on app.cash_checks for select using (app.has_role(org_id, array['admin','finance']::app.role_name[]));

create or replace function app.account_balance(p_account uuid, p_on date default current_date)
returns numeric language sql stable security definer set search_path = app, public as $$
  select coalesce(sum(app.move_sign(m) * m.amount), 0) from app.cash_moves m where m.account_id = p_account and m.on_date <= p_on
$$;

create or replace function app.record_cash_check(p_account uuid, p_kind text, p_on date, p_actual numeric, p_note text default null, p_proof text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; v_sys numeric; v_id uuid;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  if p_actual is null then raise exception 'VALIDATION: 填实际余额 / 实点金额'; end if;
  v_sys := app.account_balance(p_account, p_on);
  if p_actual <> v_sys and coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 差了 %，要写原因', p_actual - v_sys; end if;
  if p_kind = 'count' and coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 现金盘点要拍照'; end if;
  insert into app.cash_checks (org_id, account_id, kind, on_date, system_balance, actual_balance, note, proof, created_by)
  values (a.org_id, p_account, p_kind, p_on, v_sys, p_actual, nullif(p_note,''), nullif(p_proof,''), app.uid()) returning id into v_id;
  perform app.audit(a.org_id, 'cash_check', 'cash_accounts', p_account, jsonb_build_object('kind', p_kind, 'system', v_sys, 'actual', p_actual));
  return v_id;
end $$;

-- ───────── ④ 月结锁账 ─────────
create table app.period_locks (
  org_id uuid not null references app.orgs(id),
  month date not null,                    -- 每月 1 号
  locked_at timestamptz not null default now(), locked_by uuid,
  primary key (org_id, month)
);
alter table app.period_locks enable row level security;
create policy read_member on app.period_locks for select using (app.is_member(org_id));

create or replace function app.month_locked(p_org uuid, p_on date)
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.period_locks where org_id = p_org and month = date_trunc('month', p_on)::date)
$$;

-- 锁账前检查: 这个月还有没核对的收款 / 没对上的账户 / 员工代收没交的 → 列出来, 不让锁
create or replace function app.month_close_issues(p_org uuid, p_month date)
returns table (issue text, n int) language sql stable security definer set search_path = app, public as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e)
  select '收款还没确认到账', count(*)::int from app.receipts r, m where r.org_id = p_org and r.voided_at is null and r.verify_status = 'pending' and r.received_on between m.s and m.e having count(*) > 0
  union all
  select '员工代收还没交到公司', count(*)::int from app.receipts r, m where r.org_id = p_org and r.voided_at is null and r.collector_employee_id is not null and r.handed_at is null and r.received_on <= m.e having count(*) > 0
  union all
  select '账户月底没对账：' || a.name, 1 from app.cash_accounts a, m where a.org_id = p_org and a.active
    and not exists (select 1 from app.cash_checks c where c.account_id = a.id and c.on_date >= m.e and (c.diff = 0 or c.note is not null))
    and exists (select 1 from app.cash_moves mv where mv.account_id = a.id and mv.on_date <= m.e)
  union all
  select '到账还没认领', count(*)::int from app.cash_moves mv, m where mv.org_id = p_org and mv.kind = 'deposit' and mv.status = 'unclaimed' and mv.on_date between m.s and m.e having count(*) > 0
  union all
  select '账户互转还在途', count(*)::int from app.cash_moves mv, m where mv.org_id = p_org and mv.kind = 'transfer_in' and mv.status = 'in_transit' and mv.on_date <= m.e having count(*) > 0
$$;

create or replace function app.lock_month(p_org uuid, p_month date)
returns void language plpgsql security definer set search_path = app, public as $$
declare v text;
begin
  perform app.require_role(p_org, 'admin');
  select string_agg(issue || '（' || n || '）', '；') into v from app.month_close_issues(p_org, p_month);
  if v is not null then raise exception 'VALIDATION: 还不能锁账：%', v; end if;
  insert into app.period_locks (org_id, month, locked_by) values (p_org, date_trunc('month', p_month)::date, app.uid()) on conflict do nothing;
  perform app.audit(p_org, 'lock_month', 'period_locks', null, jsonb_build_object('month', date_trunc('month', p_month)::date));
end $$;

create or replace function app.unlock_month(p_org uuid, p_month date, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 解锁要写原因'; end if;
  delete from app.period_locks where org_id = p_org and month = date_trunc('month', p_month)::date;
  perform app.audit(p_org, 'unlock_month', 'period_locks', null, jsonb_build_object('month', date_trunc('month', p_month)::date, 'reason', p_reason));
end $$;

-- 锁了的月份: 不能新登记 / 撤销那个月的收款、流水、出库 (错了在当月做调整)
create or replace function app.guard_locked_period() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d date; d_old date;
begin
  if TG_TABLE_NAME = 'receipts' then d := new.received_on; d_old := case when TG_OP = 'UPDATE' then old.received_on end;
  elsif TG_TABLE_NAME = 'cash_moves' then d := new.on_date; d_old := case when TG_OP = 'UPDATE' then old.on_date end;
  elsif TG_TABLE_NAME = 'shipments' then d := new.shipped_at::date; d_old := case when TG_OP = 'UPDATE' then old.shipped_at::date end;
  end if;
  if TG_OP = 'INSERT' and app.month_locked(new.org_id, d) then
    raise exception 'LOCKED: % 已锁账，不能再记这个月的单据；请记在本月，备注写明是调整', to_char(d, 'YYYY-MM');
  end if;
  if TG_OP = 'UPDATE' and app.month_locked(new.org_id, d_old) then
    if TG_TABLE_NAME = 'receipts' and (new.voided_at is distinct from old.voided_at or new.amount <> old.amount or new.customer_id <> old.customer_id or new.received_on <> old.received_on) then
      raise exception 'LOCKED: 这笔收款在已锁账的 % 月，不能撤销或修改；请在本月做调整', to_char(d_old, 'YYYY-MM');
    elsif TG_TABLE_NAME = 'shipments' and (new.voided_at is distinct from old.voided_at) then
      raise exception 'LOCKED: 这张出库单在已锁账的 % 月，不能撤销；请在本月做调整', to_char(d_old, 'YYYY-MM');
    elsif TG_TABLE_NAME = 'cash_moves' and (new.amount <> old.amount or new.on_date <> old.on_date or new.account_id <> old.account_id) then
      raise exception 'LOCKED: 这笔流水在已锁账的 % 月，不能修改；请在本月做调整', to_char(d_old, 'YYYY-MM');
    end if;
  end if;
  return new;
end $$;
create trigger guard_locked before insert or update on app.receipts for each row execute function app.guard_locked_period();
create trigger guard_locked before insert or update on app.cash_moves for each row execute function app.guard_locked_period();
create trigger guard_locked before insert or update on app.shipments for each row execute function app.guard_locked_period();

-- ───────── ⑤ 坏账核销 (绝不悄悄消掉): 只中方, 写原因, 永久留记录 ─────────
create table app.bad_debt_writeoffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null references app.customers(id),
  deal_id uuid references app.deals(id),
  currency text not null, amount numeric(18,2) not null check (amount > 0),
  reason text not null, proof text,
  created_by uuid, created_at timestamptz not null default now()
);
alter table app.bad_debt_writeoffs enable row level security;
create policy read_fin on app.bad_debt_writeoffs for select using (app.has_role(org_id, array['admin','finance']::app.role_name[]));

create or replace function app.write_off_bad_debt(p_deal uuid, p_amount numeric, p_reason text, p_proof text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_due numeric; v_id uuid;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 坏账核销要写原因'; end if;
  select due into v_due from app.v_deal_due where deal_id = p_deal;
  if coalesce(p_amount,0) <= 0 or p_amount > coalesce(v_due,0) then raise exception 'VALIDATION: 核销金额要大于 0 且不超过这单还欠的 %', coalesce(v_due,0); end if;
  insert into app.bad_debt_writeoffs (org_id, customer_id, deal_id, currency, amount, reason, proof, created_by)
  values (d.org_id, d.customer_id, p_deal, d.currency, p_amount, p_reason, nullif(p_proof,''), app.uid()) returning id into v_id;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id, note)
  values (d.org_id, d.customer_id, d.currency, 'writeoff', -p_amount, p_deal, v_id, '坏账核销：' || p_reason);
  perform app.deal_event(p_deal, 'bad_debt_written_off', jsonb_build_object('amount', p_amount, 'reason', p_reason));
  perform app.audit(d.org_id, 'write_off_bad_debt', 'deals', p_deal, jsonb_build_object('amount', p_amount, 'reason', p_reason));
  return v_id;
end $$;

-- ───────── ⑥ 退款给客户 (退预付 / 退货退钱): 中方批, 记支出, 客户账加回 ─────────
create or replace function app.refund_customer(p_customer uuid, p_account uuid, p_amount numeric, p_on date, p_reason text, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; a app.cash_accounts; v_mv uuid;
begin
  select * into c from app.customers where id = p_customer;
  select * into a from app.cash_accounts where id = p_account and org_id = c.org_id;
  perform app.require_role(c.org_id, 'admin');
  if a.id is null then raise exception 'VALIDATION: 选从哪个账户退'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if coalesce(trim(p_reason),'') = '' or coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 退款要写原因、传凭证'; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, customer_id, proof, note, created_by, decided_by, decided_at, biz_type, flow_class)
  values (c.org_id, p_account, 'expense', p_amount, p_on, 'approved', '退款', p_customer, p_proof, '退款给客户：' || p_reason, app.uid(), app.uid(), now(), '备件', '收客户货款')
  returning id into v_mv;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, ref_id, note)
  values (c.org_id, p_customer, a.currency, 'adjust', p_amount, v_mv, '退款：' || p_reason);
  perform app.audit(c.org_id, 'refund_customer', 'customers', p_customer, jsonb_build_object('amount', p_amount, 'account', p_account));
  return v_mv;
end $$;

-- ───────── ⑦ 账户互转: 转出马上减, 转入到了才加, 中间叫「在途」 ─────────
create or replace function app.transfer_between(p_from uuid, p_to uuid, p_amount numeric, p_on date, p_note text default null, p_amount_in numeric default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; b app.cash_accounts; v_pair uuid := gen_random_uuid();
begin
  select * into a from app.cash_accounts where id = p_from; select * into b from app.cash_accounts where id = p_to;
  perform app.require_role(a.org_id, 'finance');
  if b.org_id <> a.org_id or p_from = p_to then raise exception 'VALIDATION: 两个账户要不同'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if a.currency <> b.currency and coalesce(p_amount_in,0) <= 0 then raise exception 'VALIDATION: 两个账户币种不同，要填到账金额'; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, note, created_by, pair_id, biz_type, flow_class)
  values (a.org_id, p_from, 'transfer_out', p_amount, p_on, 'confirmed', concat_ws(' · ', '转到 ' || b.name, p_note), app.uid(), v_pair, '备件', '账户互转-付款');
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, note, created_by, pair_id, biz_type, flow_class)
  values (a.org_id, p_to, 'transfer_in', coalesce(p_amount_in, p_amount), p_on, 'in_transit', concat_ws(' · ', '从 ' || a.name || ' 转来', p_note), app.uid(), v_pair, '备件', '账户互转-收款');
  perform app.audit(a.org_id, 'transfer_between', 'cash_accounts', p_from, jsonb_build_object('to', p_to, 'amount', p_amount));
  return v_pair;
end $$;

create or replace function app.transfer_arrived(p_move uuid, p_on date default current_date)
returns void language plpgsql security definer set search_path = app, public as $$
declare m app.cash_moves;
begin
  select * into m from app.cash_moves where id = p_move for update;
  perform app.require_role(m.org_id, 'finance');
  if m.kind <> 'transfer_in' or m.status <> 'in_transit' then raise exception 'BAD_STATE: 这笔不是在途的转入'; end if;
  update app.cash_moves set status = 'confirmed', on_date = coalesce(p_on, on_date), decided_by = app.uid(), decided_at = now() where id = p_move;
end $$;

-- 流水分类可在流水上补 / 改 (业务类别 / 收支大类 / 一级科目)
create or replace function app.classify_move(p_move uuid, p_biz text, p_flow text, p_subject text)
returns void language plpgsql security definer set search_path = app, public as $$
declare m app.cash_moves;
begin
  select * into m from app.cash_moves where id = p_move;
  perform app.require_role(m.org_id, 'finance');
  update app.cash_moves set biz_type = nullif(p_biz,''), flow_class = nullif(p_flow,''), category = nullif(p_subject,'') where id = p_move;
end $$;

revoke all on function app.record_receipt2(uuid, jsonb), app.receipt_to_account(app.receipts, uuid, uuid), app.verify_receipt(uuid, text), app.auto_verify_receipts(uuid),
  app.receipt_handed(uuid, uuid, text), app.reallocate_receipt(uuid, uuid, numeric, uuid, text), app.record_cash_check(uuid, text, date, numeric, text, text),
  app.account_balance(uuid, date), app.month_locked(uuid, date), app.month_close_issues(uuid, date), app.lock_month(uuid, date), app.unlock_month(uuid, date, text),
  app.write_off_bad_debt(uuid, numeric, text, text), app.refund_customer(uuid, uuid, numeric, date, text, text), app.transfer_between(uuid, uuid, numeric, date, text, numeric),
  app.transfer_arrived(uuid, date), app.classify_move(uuid, text, text, text) from public;
grant execute on function app.record_receipt2(uuid, jsonb), app.verify_receipt(uuid, text), app.auto_verify_receipts(uuid),
  app.receipt_handed(uuid, uuid, text), app.reallocate_receipt(uuid, uuid, numeric, uuid, text), app.record_cash_check(uuid, text, date, numeric, text, text),
  app.account_balance(uuid, date), app.month_locked(uuid, date), app.month_close_issues(uuid, date), app.lock_month(uuid, date), app.unlock_month(uuid, date, text),
  app.write_off_bad_debt(uuid, numeric, text, text), app.refund_customer(uuid, uuid, numeric, date, text, text), app.transfer_between(uuid, uuid, numeric, date, text, numeric),
  app.transfer_arrived(uuid, date), app.classify_move(uuid, text, text, text) to authenticated;
