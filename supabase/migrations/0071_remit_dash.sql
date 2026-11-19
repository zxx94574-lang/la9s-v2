-- 0071 (Frank 11-19): ① 回款记录 (436) ② 记账汇率留历史 (434) ③ 经营总览用的数 (429 / 433 / 434)
-- 只加不改: 新表 + 新函数; 老的 margin_rows / price_settings 不动.

-- ───────── ① 记账汇率历史: 每次改汇率留一条 (哪天起生效), 合并币种时按「出库那天生效的汇率」折 ─────────
create table app.fx_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  effective_from timestamptz not null default now(),
  rmb_per_xof numeric(12,6) not null,
  xof_per_usd numeric(12,4) not null,
  by_user uuid
);
create index on app.fx_history (org_id, effective_from desc);
alter table app.fx_history enable row level security;
create policy read_own on app.fx_history for select using (app.is_member(org_id));
insert into app.fx_history (org_id, effective_from, rmb_per_xof, xof_per_usd)
select org_id, '2000-01-01', rmb_per_xof, xof_per_usd from app.price_settings;

create or replace function app.fx_history_log() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if tg_op = 'INSERT' then
    insert into app.fx_history (org_id, effective_from, rmb_per_xof, xof_per_usd, by_user) values (new.org_id, '2000-01-01', new.rmb_per_xof, new.xof_per_usd, app.uid());
  elsif new.rmb_per_xof is distinct from old.rmb_per_xof or new.xof_per_usd is distinct from old.xof_per_usd then
    insert into app.fx_history (org_id, rmb_per_xof, xof_per_usd, by_user) values (new.org_id, new.rmb_per_xof, new.xof_per_usd, app.uid());
  end if;
  return new;
end $$;
create trigger fx_history_log after insert or update on app.price_settings for each row execute function app.fx_history_log();

-- ───────── ② 经营总览: 已出库的行 (本地 + FOB), 带原币种和折算系数; 只中方 (含成本) ─────────
-- k = 这张单 1 原币 = 多少 XOF (和 margin_rows 同一个算法); rmb_per_xof / xof_per_usd = 出库那天生效的记账汇率
create or replace function app.dash_rows(p_org uuid)
returns table (
  shipment_line_id uuid, deal_id uuid, biz_no text, shipped_on date, customer_id uuid, customer_name text, supply text, tier app.customer_tier,
  product_id uuid, product_code text, model text, category text, qty numeric, revenue numeric, cost numeric, profit numeric, cost_missing boolean,
  returned numeric, adjust numeric, currency text, k numeric, rmb_per_xof numeric, xof_per_usd numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  select m.shipment_line_id, m.deal_id, m.biz_no, m.shipped_on, m.customer_id, m.customer_name, m.supply, m.tier,
    m.product_id, m.product_code, m.model, m.category, m.qty, m.revenue, m.cost, m.profit, m.cost_missing, m.returned, m.adjust,
    d.currency::text,
    (case when d.currency = 'XOF' then 1::numeric
          when coalesce(d.fx_rate, 0) > 0 then d.fx_rate
          when d.currency = 'CNY' then 1 / nullif(ps.rmb_per_xof, 0)
          when d.currency = 'USD' then ps.xof_per_usd else 1 end)::numeric,
    coalesce(h.rmb_per_xof, ps.rmb_per_xof)::numeric, coalesce(h.xof_per_usd, ps.xof_per_usd)::numeric
  from app.margin_rows(p_org) m
  join app.deals d on d.id = m.deal_id
  left join app.price_settings ps on ps.org_id = p_org
  left join lateral (select x.rmb_per_xof, x.xof_per_usd from app.fx_history x
                     where x.org_id = p_org and x.effective_from < m.shipped_on + 1 order by x.effective_from desc limit 1) h on true;
end $$;

-- 打卡异常: 时间段里每个有工号的在职员工 迟到几次 / 没打卡几次 (排班休息的不算; 申诉通过的不算; 今天还没过完不算没打卡)
create or replace function app.attendance_anomalies(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, short_name text, emp_no text, late int, missing int)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare v_today date := (now() at time zone 'Africa/Abidjan')::date;
begin
  perform app.require_role(p_org, 'admin', 'manager', 'sales_manager', 'finance');
  return query
  with emp as (
    select e.id, coalesce(e.short_name, e.full_name) as nm, e.emp_no, e.joined_on, coalesce(e.work_schedule, '{}'::jsonb) as ws
    from app.employees e where e.org_id = p_org and e.active and coalesce(e.emp_no, '') <> ''),
  days as (
    select e.id, g::date as day from emp e, generate_series(greatest(p_from, coalesce(e.joined_on, p_from)), least(p_to, v_today), interval '1 day') g
    where coalesce(e.ws->>(extract(dow from g)::int)::text, case when extract(dow from g) = 0 then 'off' else 'full' end) <> 'off'),
  ins as (
    select a.employee_id, (a.at at time zone 'Africa/Abidjan')::date as day, bool_or(coalesce(a.late, false)) as late
    from app.attendance a where a.org_id = p_org and a.kind = 'in' and a.at >= p_from and a.at < p_to + 2 group by 1, 2),
  ok as (select ap.employee_id, ap.day from app.attendance_appeals ap where ap.org_id = p_org and ap.status = 'approved')
  select e.id, e.nm, e.emp_no,
    count(*) filter (where i.late and o.day is null)::int,
    count(*) filter (where i.day is null and o.day is null and d.day < v_today)::int
  from emp e join days d on d.id = e.id
  left join ins i on i.employee_id = e.id and i.day = d.day
  left join ok o on o.employee_id = e.id and o.day = d.day
  group by 1, 2, 3;
end $$;

-- ───────── ③ 回款记录: 把钱通过回款公司汇回国内 ─────────
create table app.remit_accounts (       -- 国内 / 香港的收款账户
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  name text not null,
  currency text not null references app.currencies(code),
  sort int not null default 0, active boolean not null default true,
  unique (org_id, name)
);
create table app.remittances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  remit_no text not null,
  on_date date not null,
  from_account_id uuid not null references app.cash_accounts(id),   -- 从哪个账户交出去
  amount_out numeric(18,2) not null check (amount_out > 0),          -- 交出多少 (那个账户的币种, 一般 XOF)
  out_currency text not null,
  company text not null,                                             -- 回款公司
  to_account_id uuid not null references app.remit_accounts(id),
  currency text not null,                                            -- 换回的币种 (CNY / USD)
  rate numeric(14,6) not null check (rate > 0),                      -- 约定汇率: 1 外币 = ? 交出币种
  ref_rate numeric(14,6),                                            -- 参考汇率 (当天真实价): 用来看汇率上付了多少
  expected numeric(18,2) not null,                                   -- 应到 = 交出 ÷ 约定汇率
  fee_declared numeric(18,2) not null default 0,                     -- 回款公司声明的手续费 (换回的币种)
  proof text not null, note text,
  move_id uuid references app.cash_moves(id),                        -- 扣账户余额的那笔流水
  status text not null default 'sent' check (status in ('sent', 'arrived', 'checked', 'void')),
  created_by uuid, created_at timestamptz not null default now(),
  checked_by uuid, checked_at timestamptz, check_note text,
  void_by uuid, void_at timestamptz, void_note text, void_move_id uuid references app.cash_moves(id),
  unique (org_id, remit_no)
);
create table app.remit_arrivals (       -- 到账 (可以分几次)
  id uuid primary key default gen_random_uuid(),
  remittance_id uuid not null references app.remittances(id),
  org_id uuid not null references app.orgs(id),
  on_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  proof text not null, note text,
  created_by uuid, created_at timestamptz not null default now()
);
alter table app.remit_accounts enable row level security;
alter table app.remittances enable row level security;
alter table app.remit_arrivals enable row level security;
create policy read_fin on app.remit_accounts for select using (app.has_role(org_id, array['admin', 'finance']::app.role_name[]));
create policy read_fin on app.remittances for select using (app.has_role(org_id, array['admin', 'finance']::app.role_name[]));
create policy read_fin on app.remit_arrivals for select using (app.has_role(org_id, array['admin', 'finance']::app.role_name[]));
-- 没有 update / delete 的 policy: 记录只能通过下面的函数动, 删不了

create or replace function app.ensure_remit_accounts(p_org uuid) returns void language plpgsql security definer set search_path = app, public as $$
begin
  insert into app.remit_accounts (org_id, name, currency, sort) values
    (p_org, '9S 人民币账户', 'CNY', 1), (p_org, 'LA 人民币账户', 'CNY', 2), (p_org, '9S 香港美金账户', 'USD', 3)
  on conflict (org_id, name) do nothing;
end $$;
select app.ensure_remit_accounts(id) from app.orgs;

-- 登记一笔回款: 马上从交出钱的账户里扣; 凭证必传
create or replace function app.create_remittance(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; t app.remit_accounts; v_id uuid; v_move uuid; v_no text;
  v_amt numeric := nullif(p->>'amount_out', '')::numeric; v_rate numeric := nullif(p->>'rate', '')::numeric;
  v_on date := coalesce(nullif(p->>'on_date', '')::date, current_date); v_ref numeric := nullif(p->>'ref_rate', '')::numeric;
  v_company text := nullif(trim(coalesce(p->>'company', '')), '');
begin
  perform app.require_role(p_org, 'admin', 'finance');
  perform app.ensure_remit_accounts(p_org);
  select * into a from app.cash_accounts where id = nullif(p->>'from_account_id', '')::uuid and org_id = p_org;
  select * into t from app.remit_accounts where id = nullif(p->>'to_account_id', '')::uuid and org_id = p_org;
  if a.id is null then raise exception 'VALIDATION: 选从哪个账户交出去'; end if;
  if t.id is null then raise exception 'VALIDATION: 选回到哪个账户'; end if;
  if coalesce(v_amt, 0) <= 0 then raise exception 'VALIDATION: 交出多少要大于 0'; end if;
  if v_company is null then raise exception 'VALIDATION: 选回款公司'; end if;
  if coalesce(v_rate, 0) <= 0 then raise exception 'VALIDATION: 填约定汇率（1 % = 多少 %）', t.currency, a.currency; end if;
  if coalesce(p->>'proof', '') = '' then raise exception 'VALIDATION: 回款凭证必传'; end if;
  if v_amt > app.account_balance(a.id) then raise exception 'VALIDATION: % 余额只有 %，不够交 %', a.name, app.account_balance(a.id), v_amt; end if;
  if v_ref is null then   -- 没给参考汇率: 用记账汇率
    select case when t.currency = 'USD' then ps.xof_per_usd when t.currency = 'CNY' then round(1 / nullif(ps.rmb_per_xof, 0), 6) end into v_ref
    from app.price_settings ps where ps.org_id = p_org and a.currency = 'XOF';
  end if;
  v_no := app.next_doc_no(p_org, 'RMT');
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, note, proof, created_by, biz_type, flow_class)
  values (p_org, a.id, 'bank_out', v_amt, v_on, 'confirmed', concat_ws(' · ', '回款 ' || v_no, v_company || ' → ' || t.name, nullif(p->>'note', '')), p->>'proof', app.uid(), '备件', '回款')
  returning id into v_move;
  insert into app.remittances (org_id, remit_no, on_date, from_account_id, amount_out, out_currency, company, to_account_id, currency, rate, ref_rate, expected, fee_declared, proof, note, move_id, created_by)
  values (p_org, v_no, v_on, a.id, v_amt, a.currency, v_company, t.id, t.currency, v_rate, v_ref, round(v_amt / v_rate, 2),
    coalesce(nullif(p->>'fee_declared', '')::numeric, 0), p->>'proof', nullif(p->>'note', ''), v_move, app.uid())
  returning id into v_id;
  perform app.audit(p_org, 'create_remittance', 'remittances', v_id, jsonb_build_object('no', v_no, 'out', v_amt, 'rate', v_rate, 'to', t.name, 'company', v_company));
  return v_id;
end $$;

-- 到账: 跟国内确认完再填 (只中方), 截图必传; 可以分几次
create or replace function app.remit_arrive(p_id uuid, p_amount numeric, p_on date, p_proof text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.remittances;
begin
  select * into r from app.remittances where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if r.status in ('void', 'checked') then raise exception 'BAD_STATE: 这笔回款已经%，不能再填到账', case r.status when 'void' then '作废' else '核对完' end; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'VALIDATION: 到账金额要大于 0'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 到账截图必传'; end if;
  insert into app.remit_arrivals (remittance_id, org_id, on_date, amount, proof, note, created_by)
  values (p_id, r.org_id, coalesce(p_on, current_date), p_amount, p_proof, nullif(trim(coalesce(p_note, '')), ''), app.uid());
  update app.remittances set status = 'arrived' where id = p_id;
  perform app.audit(r.org_id, 'remit_arrive', 'remittances', p_id, jsonb_build_object('amount', p_amount, 'on', p_on));
end $$;

-- 核对完: 差额超过设定的百分比 (remit_rules.diff_pct, 默认 2%) 必须写原因
create or replace function app.remit_check(p_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.remittances; v_got numeric; v_pct numeric; v_lim numeric;
begin
  select * into r from app.remittances where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if r.status <> 'arrived' then raise exception 'BAD_STATE: 先填到账，再核对'; end if;
  select coalesce(sum(amount), 0) into v_got from app.remit_arrivals where remittance_id = p_id;
  v_pct := abs(r.expected - v_got) / nullif(r.expected, 0) * 100;
  select coalesce((value->>'diff_pct')::numeric, 2) into v_lim from app.org_settings where org_id = r.org_id and key = 'remit_rules';
  if v_pct > coalesce(v_lim, 2) and coalesce(trim(p_note), '') = '' then
    raise exception 'VALIDATION: 到账比应到差了 %%%（超过 %%%），要写原因', round(v_pct, 1), coalesce(v_lim, 2);
  end if;
  update app.remittances set status = 'checked', checked_by = app.uid(), checked_at = now(), check_note = nullif(trim(coalesce(p_note, '')), '') where id = p_id;
  perform app.audit(r.org_id, 'remit_check', 'remittances', p_id, jsonb_build_object('expected', r.expected, 'got', v_got));
end $$;

-- 作废 (不删): 只中方, 必须写原因; 钱加回原账户; 已经填过到账的不能作废
create or replace function app.void_remittance(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.remittances; v_move uuid;
begin
  select * into r from app.remittances where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if r.status = 'void' then raise exception 'BAD_STATE: 已经作废过了'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 作废要写原因'; end if;
  if exists (select 1 from app.remit_arrivals where remittance_id = p_id) then raise exception 'BAD_STATE: 这笔已经填过到账，不能作废'; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, note, created_by, biz_type, flow_class)
  values (r.org_id, r.from_account_id, 'deposit', r.amount_out, current_date, 'other_income', '回款作废冲回 ' || r.remit_no || ' · ' || trim(p_note), app.uid(), '备件', '回款作废')
  returning id into v_move;
  update app.remittances set status = 'void', void_by = app.uid(), void_at = now(), void_note = trim(p_note), void_move_id = v_move where id = p_id;
  perform app.audit(r.org_id, 'void_remittance', 'remittances', p_id, jsonb_build_object('no', r.remit_no, 'note', p_note));
end $$;

-- 列表: 带到账合计和成本拆分 (换回的币种)
--   fx_cost = 按参考汇率本来该到的 − 按约定汇率应到的 (汇率上付的); short = 应到 − 实到 − 声明的手续费 (说不清的差额)
create or replace view app.v_remittances with (security_invoker = true) as
select r.*, a.name as from_account, t.name as to_account,
  coalesce(x.got, 0) as arrived, x.last_on as arrived_on, coalesce(x.n, 0) as arrivals,
  case when r.ref_rate > 0 then round(r.amount_out / r.ref_rate - r.expected, 2) end as fx_cost,
  case when x.got is not null then round(r.expected - x.got - r.fee_declared, 2) end as short,
  (current_date - r.on_date) as days_out
from app.remittances r
join app.cash_accounts a on a.id = r.from_account_id
join app.remit_accounts t on t.id = r.to_account_id
left join lateral (select sum(amount) as got, max(on_date) as last_on, count(*)::int as n from app.remit_arrivals x where x.remittance_id = r.id) x on true;

revoke all on function app.dash_rows(uuid), app.attendance_anomalies(uuid, date, date), app.ensure_remit_accounts(uuid), app.create_remittance(uuid, jsonb),
  app.remit_arrive(uuid, numeric, date, text, text), app.remit_check(uuid, text), app.void_remittance(uuid, text), app.fx_history_log() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.fx_history, app.remit_accounts, app.remittances, app.remit_arrivals, app.v_remittances to authenticated;
    grant execute on function app.dash_rows(uuid), app.attendance_anomalies(uuid, date, date), app.ensure_remit_accounts(uuid), app.create_remittance(uuid, jsonb),
      app.remit_arrive(uuid, numeric, date, text, text), app.remit_check(uuid, text), app.void_remittance(uuid, text) to authenticated;
  end if;
end $$;
