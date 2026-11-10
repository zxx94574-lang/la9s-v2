-- LA&9S Operations · 0010 资金账户 / 公户 (Frank 2026-10-29)
-- 公户只有一个, 开在员工罗安 (Roland) 名下, 流水要找他拿. 他手上最多压 500 万 XOF, 超了马上交, 最长不超过 7 天.
-- 到账先登记在账户里 (不动客户欠款), 中方认领到客户才生成收款并冲账. 热线报「客户说付了」先挂着, 自动找金额日期对得上的到账.
-- 交款两边确认: 持有人发起, 中方确认收到才算交了. 支出超过审批线要中方批 (审批线待 Frank 定, 默认 0 = 全部要批).

create table app.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  name text not null,
  kind text not null check (kind in ('bank','cash','wave','orange','other')),
  currency text not null references app.currencies(code),
  holder_employee_id uuid references app.employees(id),   -- 账户在谁手上 / 谁名下
  hold_limit numeric(18,2),                               -- 最多压多少 (超了要交)
  hold_days int,                                          -- 最长压几天
  active boolean not null default true,
  note text, created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table app.cash_settings (
  org_id uuid primary key references app.orgs(id),
  expense_approval_over numeric(18,2) not null default 0,   -- 支出超过这个数要中方批; 0 = 全部要批
  match_days int not null default 3                          -- 付款通知和到账自动配对: 日期前后几天
);

-- 一个账户的每一笔进出 (金额永远为正, 方向看 kind)
create table app.cash_moves (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  account_id uuid not null references app.cash_accounts(id),
  kind text not null check (kind in ('opening','deposit','handover','expense','bank_out')),
  amount numeric(18,2) not null check (amount > 0),
  on_date date not null,
  status text not null check (status in ('unclaimed','claimed','other_income','pending','confirmed','approved','rejected','unexplained')),
  payer text,                   -- 到账: 付款人 (流水上的名字)
  ref text,                     -- 流水号 / 交易号
  category text,                -- 支出科目 (照飞书 CI-资金流水科目)
  customer_id uuid references app.customers(id),
  receipt_id uuid references app.receipts(id),
  notice_id uuid,
  proof text, note text,
  created_by uuid, created_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz, decide_note text,
  source text not null default 'manual' check (source in ('manual','statement','import'))
);
create index on app.cash_moves (account_id, on_date);
create unique index cash_moves_stmt_uq on app.cash_moves (account_id, on_date, amount, ref, kind) where source = 'statement' and ref is not null;

-- 热线: 「客户说已经付了」(带截图) —— 等到账来了配对
create table app.payment_notices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null references app.customers(id),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null references app.currencies(code),
  method app.pay_method not null,
  paid_on date not null,
  proof text, note text,
  status text not null default 'open' check (status in ('open','matched','dropped')),
  move_id uuid references app.cash_moves(id),
  created_by uuid, created_at timestamptz not null default now()
);
alter table app.cash_moves add foreign key (notice_id) references app.payment_notices(id);

alter table app.cash_accounts enable row level security;
alter table app.cash_settings enable row level security;
alter table app.cash_moves enable row level security;
alter table app.payment_notices enable row level security;
create policy read_own on app.cash_accounts for select using (app.is_member(org_id));
create policy read_own on app.cash_settings for select using (app.is_member(org_id));
create policy read_own on app.cash_moves for select using (app.is_member(org_id));
create policy read_own on app.payment_notices for select using (app.is_member(org_id));

-- 余额里算不算这一笔: 到账一进来就算 (钱已经在账户里); 交款要中方确认才减; 支出批了才减; 流水导出的支出直接减
create or replace function app.move_sign(m app.cash_moves) returns int language sql immutable as $$
  select case
    when m.kind in ('opening','deposit') then 1
    when m.kind = 'handover' and m.status = 'confirmed' then -1
    when m.kind = 'expense' and m.status = 'approved' then -1
    when m.kind = 'bank_out' then -1
    else 0 end
$$;

-- 账户余额 + 压了几天: 先进先出, 交出去的钱先抵最早的到账, 剩下最早那笔到账的日期就是「压了多久」
create view app.v_cash_holding as
with mv as (
  select a.id as account_id, m.on_date, m.created_at, app.move_sign(m) * m.amount as signed, m.kind, m.status, m.amount
  from app.cash_accounts a join app.cash_moves m on m.account_id = a.id
), tot as (
  select account_id, coalesce(sum(signed) filter (where signed < 0), 0) * -1 as out_total, coalesce(sum(signed), 0) as balance,
    coalesce(sum(amount) filter (where kind = 'handover' and status = 'pending'), 0) as handover_pending,
    coalesce(sum(amount) filter (where kind = 'expense' and status = 'pending'), 0) as expense_pending,
    count(*) filter (where kind = 'deposit' and status = 'unclaimed') as unclaimed_n,
    coalesce(sum(amount) filter (where kind = 'deposit' and status = 'unclaimed'), 0) as unclaimed_amount
  from mv group by account_id
), ins as (
  select account_id, on_date, sum(signed) over (partition by account_id order by on_date, created_at) as cum
  from mv where signed > 0
)
select a.id as account_id, a.org_id, a.name, a.kind, a.currency, a.holder_employee_id, a.hold_limit, a.hold_days,
  coalesce(t.balance, 0) as balance, coalesce(t.handover_pending, 0) as handover_pending, coalesce(t.expense_pending, 0) as expense_pending,
  coalesce(t.unclaimed_n, 0) as unclaimed_n, coalesce(t.unclaimed_amount, 0) as unclaimed_amount,
  (select min(i.on_date) from ins i where i.account_id = a.id and i.cum > coalesce(t.out_total, 0)) as oldest_held_on,
  (a.hold_limit is not null and coalesce(t.balance, 0) > a.hold_limit) as over_limit,
  (a.hold_days is not null and coalesce(t.balance, 0) > 0 and
     current_date - (select min(i.on_date) from ins i where i.account_id = a.id and i.cum > coalesce(t.out_total, 0)) > a.hold_days) as over_days
from app.cash_accounts a left join tot t on t.account_id = a.id
where a.active;

-- 付款通知 ↔ 到账 自动配对建议: 同币种, 金额一样, 日期前后 match_days 天, 两边都还没用掉
create view app.v_notice_matches as
select n.id as notice_id, m.id as move_id, n.org_id, n.customer_id, abs(m.on_date - n.paid_on) as gap_days,
  count(*) over (partition by n.id) as candidates
from app.payment_notices n
join app.cash_moves m on m.org_id = n.org_id and m.kind = 'deposit' and m.status = 'unclaimed' and m.amount = n.amount
join app.cash_accounts a on a.id = m.account_id and a.currency = n.currency
join app.cash_settings s on s.org_id = n.org_id
where n.status = 'open' and abs(m.on_date - n.paid_on) <= s.match_days;

-- ── 动作 ──
create or replace function app.upsert_cash_account(p_org uuid, p_id uuid, p_name text, p_kind text, p_currency text, p_holder uuid,
  p_limit numeric, p_days int, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_name),'') = '' then raise exception 'VALIDATION: 账户名必填'; end if;
  insert into app.cash_settings (org_id) values (p_org) on conflict do nothing;
  if v_id is null then
    insert into app.cash_accounts (org_id, name, kind, currency, holder_employee_id, hold_limit, hold_days, note)
    values (p_org, trim(p_name), p_kind, p_currency, p_holder, p_limit, p_days, p_note) returning id into v_id;
  else
    update app.cash_accounts set name = trim(p_name), kind = p_kind, holder_employee_id = p_holder, hold_limit = p_limit, hold_days = p_days, note = p_note
    where id = v_id and org_id = p_org;
  end if;
  perform app.audit(p_org, 'cash_account', 'cash_accounts', v_id, jsonb_build_object('limit', p_limit, 'days', p_days));
  return v_id;
end $$;

-- 财务登记到账 (不动客户欠款)
create or replace function app.record_deposit(p_account uuid, p_on date, p_amount numeric, p_payer text, p_ref text, p_proof text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; v_id uuid;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  if p_amount is null or p_amount <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, payer, ref, proof, note, created_by)
  values (a.org_id, p_account, 'deposit', p_amount, p_on, 'unclaimed', nullif(trim(p_payer),''), nullif(trim(p_ref),''), p_proof, p_note, app.uid())
  returning id into v_id;
  return v_id;
end $$;

-- 热线 / 财务: 客户说付了
create or replace function app.record_payment_notice(p_customer uuid, p_amount numeric, p_currency text, p_method app.pay_method, p_paid_on date, p_proof text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_id uuid;
begin
  select * into c from app.customers where id = p_customer;
  perform app.require_role(c.org_id, 'hotline', 'finance', 'manager', 'sales');
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 付款截图必须上传'; end if;
  insert into app.payment_notices (org_id, customer_id, amount, currency, method, paid_on, proof, note, created_by)
  values (c.org_id, p_customer, p_amount, p_currency, p_method, p_paid_on, p_proof, p_note, app.uid()) returning id into v_id;
  return v_id;
end $$;

-- 中方认领: 这笔到账是哪个客户的 → 生成收款 + 冲账 (方式同收款页: oldest / deals / none)
create or replace function app.claim_deposit(p_move uuid, p_customer uuid, p_mode text default 'oldest', p_targets jsonb default '[]',
  p_notice uuid default null, p_account_currency text default null, p_rate numeric default 1)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare m app.cash_moves; a app.cash_accounts; v_rcv uuid; v_method app.pay_method;
begin
  select * into m from app.cash_moves where id = p_move for update;
  perform app.require_role(m.org_id, 'admin');
  if m.kind <> 'deposit' or m.status <> 'unclaimed' then raise exception 'BAD_STATE: 这笔到账已经处理过了'; end if;
  select * into a from app.cash_accounts where id = m.account_id;
  v_method := case a.kind when 'bank' then 'bank' when 'cash' then 'cash' when 'wave' then 'wave' when 'orange' then 'orange' else 'other' end;
  v_rcv := app.record_receipt(m.org_id, p_customer, m.on_date, m.amount, a.currency, v_method, p_account_currency, p_rate, p_mode, p_targets,
    m.proof, concat_ws(' · ', '公户到账认领 ' || a.name, m.payer, m.ref));
  update app.cash_moves set status = 'claimed', customer_id = p_customer, receipt_id = v_rcv, notice_id = p_notice,
    decided_by = app.uid(), decided_at = now() where id = p_move;
  if p_notice is not null then update app.payment_notices set status = 'matched', move_id = p_move where id = p_notice and status = 'open'; end if;
  perform app.audit(m.org_id, 'claim_deposit', 'cash_moves', p_move, jsonb_build_object('customer', p_customer, 'receipt', v_rcv));
  return v_rcv;
end $$;

-- 不是客户的钱 (退款、内部转入等): 中方标成其他收入
create or replace function app.mark_other_income(p_move uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare m app.cash_moves;
begin
  select * into m from app.cash_moves where id = p_move for update;
  perform app.require_role(m.org_id, 'admin');
  if m.kind <> 'deposit' or m.status <> 'unclaimed' then raise exception 'BAD_STATE: 这笔到账已经处理过了'; end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 要写清楚是什么钱'; end if;
  update app.cash_moves set status = 'other_income', decide_note = p_note, decided_by = app.uid(), decided_at = now() where id = p_move;
end $$;

-- 持有人交款 (发起) → 中方确认收到 (才算交了)
create or replace function app.request_handover(p_account uuid, p_amount numeric, p_on date, p_proof text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; v_id uuid;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  if p_amount is null or p_amount <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, proof, note, created_by)
  values (a.org_id, p_account, 'handover', p_amount, p_on, 'pending', p_proof, p_note, app.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function app.decide_move(p_move uuid, p_ok boolean, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare m app.cash_moves; v_status text;
begin
  select * into m from app.cash_moves where id = p_move for update;
  perform app.require_role(m.org_id, 'admin');
  if m.status <> 'pending' then raise exception 'BAD_STATE: 这一笔已经处理过了'; end if;
  if not p_ok and coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 不同意要写原因'; end if;
  v_status := case when not p_ok then 'rejected' when m.kind = 'handover' then 'confirmed' else 'approved' end;
  update app.cash_moves set status = v_status, decided_by = app.uid(), decided_at = now(), decide_note = p_note where id = p_move;
  perform app.audit(m.org_id, 'decide_move', 'cash_moves', p_move, jsonb_build_object('status', v_status));
  return v_status;
end $$;

-- 财务登记支出: 不超过审批线直接生效, 超过要中方批
create or replace function app.record_expense(p_account uuid, p_amount numeric, p_on date, p_category text, p_proof text, p_note text)
returns text language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; s app.cash_settings; v_status text;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  if p_amount is null or p_amount <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if coalesce(trim(p_category),'') = '' then raise exception 'VALIDATION: 支出科目必选'; end if;
  insert into app.cash_settings (org_id) values (a.org_id) on conflict do nothing;
  select * into s from app.cash_settings where org_id = a.org_id;
  v_status := case when app.has_role(a.org_id, array['admin']::app.role_name[]) or p_amount <= s.expense_approval_over and s.expense_approval_over > 0 then 'approved' else 'pending' end;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, proof, note, created_by)
  values (a.org_id, p_account, 'expense', p_amount, p_on, v_status, p_category, p_proof, p_note, app.uid());
  return v_status;
end $$;

create or replace function app.set_cash_settings(p_org uuid, p_over numeric, p_days int)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  insert into app.cash_settings (org_id, expense_approval_over, match_days) values (p_org, coalesce(p_over, 0), coalesce(p_days, 3))
  on conflict (org_id) do update set expense_approval_over = excluded.expense_approval_over, match_days = excluded.match_days;
end $$;

-- 银行流水导入 (从罗安那里拿的): 进账 → 待认领到账; 出账 → 「流水支出，待说明」. 同一笔重复导入自动跳过.
-- p_rows: [{date:'2026-10-20', amount: 250000 (正=进, 负=出), ref:'...', payer:'...', desc:'...'}]
create or replace function app.import_statement(p_account uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; x jsonb; v_amt numeric; n_in int := 0; n_out int := 0; n_dup int := 0; v_kind text; v_ref text;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  for x in select * from jsonb_array_elements(p_rows) loop
    v_amt := (x->>'amount')::numeric;
    continue when v_amt is null or v_amt = 0;
    v_kind := case when v_amt > 0 then 'deposit' else 'bank_out' end;
    v_ref := coalesce(nullif(trim(x->>'ref'),''), md5(concat(x->>'date', '|', x->>'amount', '|', x->>'desc', '|', x->>'payer')));
    if exists (select 1 from app.cash_moves where account_id = p_account and on_date = (x->>'date')::date and amount = abs(v_amt)
               and kind = v_kind and ref = v_ref) then
      n_dup := n_dup + 1; continue;
    end if;
    insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, payer, ref, note, created_by, source)
    values (a.org_id, p_account, v_kind, abs(v_amt), (x->>'date')::date, case when v_amt > 0 then 'unclaimed' else 'unexplained' end,
      nullif(trim(x->>'payer'),''), v_ref, nullif(trim(x->>'desc'),''), app.uid(), 'statement');
    if v_amt > 0 then n_in := n_in + 1; else n_out := n_out + 1; end if;
  end loop;
  perform app.audit(a.org_id, 'import_statement', 'cash_accounts', p_account, jsonb_build_object('in', n_in, 'out', n_out, 'dup', n_dup));
  return jsonb_build_object('in', n_in, 'out', n_out, 'dup', n_dup);
end $$;

-- 流水上的出账说明白: 是交款 / 支出 (带科目)
create or replace function app.explain_bank_out(p_move uuid, p_as text, p_category text, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare m app.cash_moves;
begin
  select * into m from app.cash_moves where id = p_move for update;
  perform app.require_role(m.org_id, 'admin');
  if m.kind <> 'bank_out' or m.status <> 'unexplained' then raise exception 'BAD_STATE: 这一笔已经说明过了'; end if;
  if p_as = 'handover' then
    update app.cash_moves set kind = 'handover', status = 'confirmed', note = coalesce(p_note, note), decided_by = app.uid(), decided_at = now() where id = p_move;
  elsif p_as = 'expense' then
    if coalesce(trim(p_category),'') = '' then raise exception 'VALIDATION: 支出科目必选'; end if;
    update app.cash_moves set kind = 'expense', status = 'approved', category = p_category, note = coalesce(p_note, note), decided_by = app.uid(), decided_at = now() where id = p_move;
  else raise exception 'VALIDATION: 只能说明为交款或支出'; end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.cash_accounts, app.cash_settings, app.cash_moves, app.payment_notices, app.v_cash_holding, app.v_notice_matches to authenticated;
    grant execute on function app.upsert_cash_account(uuid, uuid, text, text, text, uuid, numeric, int, text),
      app.record_deposit(uuid, date, numeric, text, text, text, text),
      app.record_payment_notice(uuid, numeric, text, app.pay_method, date, text, text),
      app.claim_deposit(uuid, uuid, text, jsonb, uuid, text, numeric), app.mark_other_income(uuid, text),
      app.request_handover(uuid, numeric, date, text, text), app.decide_move(uuid, boolean, text),
      app.record_expense(uuid, numeric, date, text, text, text), app.set_cash_settings(uuid, numeric, int),
      app.import_statement(uuid, jsonb), app.explain_bank_out(uuid, text, text, text) to authenticated;
  end if;
end $$;
