-- 0063 (Frank 11-18 414 / 415): 资金账户 —— 手续费重复扣的 bug、账户的明确设置 (不再按名字猜)、改名留记录
-- 记账口径 (Frank 定): 收款 = 客户付了多少 (冲客户账的数). 账户里先记「客户付的」, 再从同一个账户扣手续费 → 净额 = 实际到账.
--   付到 Wave-XOF 300,000 扣 1% → 账户 +300,000 / −3,000 办公费 = 297,000.
--   付到 Roland Wave 300,000 → Roland 欠公司 297,000 (手续费从 Roland Wave 这个账户出, 不再记到 Wave-XOF).
--   付到 Roland 银行: 没有手续费 → 欠 300,000.

-- ① bug: 原来「存到账 (已经是扣过手续费的数) + 再记一笔手续费支出」→ 手续费扣了两次. 改成存「客户付的」再扣手续费.
create or replace function app.receipt_to_account(r app.receipts, p_account uuid, p_move uuid default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_fee numeric := case when coalesce(r.fee, 0) > 0 and r.fee_bearer = 'company' then r.fee else 0 end;
  v_gross numeric := coalesce(r.landed, r.amount) + (case when coalesce(r.fee, 0) > 0 and r.fee_bearer = 'company' then r.fee else 0 end);
begin
  if p_account is null then return; end if;
  if p_move is not null then
    -- 流水导入的那一笔是「实际到账」(扣过手续费的); 认领时补成客户付的全额, 下面再扣手续费, 净额不变
    update app.cash_moves set status = 'claimed', customer_id = r.customer_id, receipt_id = r.id, biz_type = coalesce(biz_type, '备件'), flow_class = '收客户货款',
      amount = amount + v_fee, decided_by = app.uid(), decided_at = now() where id = p_move;
  else
    insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, payer, customer_id, receipt_id, proof, note, created_by, biz_type, flow_class)
    values (r.org_id, p_account, 'deposit', v_gross, r.received_on, 'claimed', r.payer, r.customer_id, r.id, r.proof_path, '收款 ' || r.rcv_no, app.uid(), '备件', '收客户货款');
  end if;
  if v_fee > 0 then
    insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, customer_id, receipt_id, note, created_by, biz_type, flow_class, decided_by, decided_at)
    values (r.org_id, p_account, 'expense', v_fee, r.received_on, 'approved', '办公费', r.customer_id, r.id, '收款手续费 ' || r.rcv_no, app.uid(), '备件', '运营费用', app.uid(), now());
  end if;
end $$;

-- 老数据: 已经按旧算法入账的 (存的是到账数、又扣了一次手续费) → 把那笔存入补回手续费, 备注里写明
update app.cash_moves m set amount = m.amount + r.fee, note = coalesce(m.note, '') || ' · 0063 补回重复扣的手续费 ' || trim(to_char(r.fee, '999,999,999,990'))
  from app.receipts r
 where m.receipt_id = r.id and m.kind = 'deposit' and r.fee > 0 and r.fee_bearer = 'company' and r.voided_at is null
   and m.amount = coalesce(r.landed, r.amount)
   and exists (select 1 from app.cash_moves x where x.receipt_id = r.id and x.kind = 'expense' and x.account_id = m.account_id and x.amount = r.fee);

-- ② 账户上的明确设置: 是不是公户 (钱在持有人手里, 算他欠公司)、手续费率、排序; 类型用原来的 kind (现金 / Wave / 银行 / 其他)
alter table app.cash_accounts add column is_public boolean not null default false, add column fee_pct numeric(6,3) not null default 0, add column sort int;
update app.cash_accounts set is_public = true where holder_employee_id is not null and name like '%公户%';
update app.cash_accounts set kind = 'cash' where name ilike '%cash%' and kind <> 'cash';
update app.cash_accounts set kind = 'wave' where name ilike '%wave%' and kind <> 'wave';
update app.cash_accounts set fee_pct = 1 where kind in ('wave', 'orange');

create or replace function app.set_cash_account_opts(p_account uuid, p jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; v_pub boolean; v_fee numeric;
begin
  select * into a from app.cash_accounts where id = p_account;
  if a.id is null then raise exception 'NOT_FOUND: 账户不存在'; end if;
  perform app.require_role(a.org_id, 'admin');
  v_pub := coalesce((p->>'is_public')::boolean, a.is_public);
  v_fee := coalesce(nullif(p->>'fee_pct', '')::numeric, a.fee_pct);
  if v_pub and a.holder_employee_id is null then raise exception 'VALIDATION: 公户要先选「在谁手上」'; end if;
  if v_fee < 0 or v_fee > 20 then raise exception 'VALIDATION: 手续费率填 0–20 之间的百分数'; end if;
  update app.cash_accounts set is_public = v_pub, fee_pct = v_fee, active = coalesce((p->>'active')::boolean, active), sort = coalesce(nullif(p->>'sort', '')::int, sort) where id = p_account;
  perform app.audit(a.org_id, 'set_cash_account_opts', 'cash_accounts', p_account, p);
end $$;

-- 改名留记录 (旧名 → 新名、谁、什么时候)
create or replace function app.cash_account_renamed() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.name is distinct from old.name then
    perform app.audit(new.org_id, 'rename_cash_account', 'cash_accounts', new.id, jsonb_build_object('from', old.name, 'to', new.name));
    -- 运费规则里是按账户名找「运费从哪个账户出」的 (0044, 默认 Wave-XOF): 名字改了, 规则跟着改, 不然运费会记不上
    update app.org_settings set value = jsonb_set(value, '{account}', to_jsonb(new.name)) where org_id = new.org_id and key = 'freight_rules' and value->>'account' = old.name;
    if old.name = 'Wave-XOF' and not exists (select 1 from app.org_settings where org_id = new.org_id and key = 'freight_rules' and value ? 'account') then
      insert into app.org_settings (org_id, key, value) values (new.org_id, 'freight_rules', jsonb_build_object('account', new.name))
      on conflict (org_id, key) do update set value = app.org_settings.value || jsonb_build_object('account', new.name);
    end if;
  end if;
  return new;
end $$;
create trigger cash_account_renamed after update on app.cash_accounts for each row execute function app.cash_account_renamed();

-- 改名 / 停用之前给人看「会影响什么」
create or replace function app.cash_account_usage(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare a app.cash_accounts;
begin
  select * into a from app.cash_accounts where id = p_account;
  if a.id is null then raise exception 'NOT_FOUND: 账户不存在'; end if;
  perform app.require_role(a.org_id, 'admin', 'finance');
  return jsonb_build_object(
    'moves', (select count(*) from app.cash_moves where account_id = p_account),
    'receipts', (select count(*) from app.receipts where account_id = p_account and voided_at is null),
    'pending', (select count(*) from app.receipts where account_id = p_account and voided_at is null and verify_status = 'pending'),
    'freight', exists (select 1 from app.org_settings s where s.org_id = a.org_id and s.key = 'freight_rules' and s.value->>'account' = a.name));
end $$;

-- 账户卡片: 待核对的收款 (还没进余额, 但要看得见)
create or replace function app.cash_pending(p_org uuid)
returns table (account_id uuid, n int, amount numeric)
language sql stable security definer set search_path = app, public as $$
  select r.account_id, count(*)::int, sum(r.amount)
    from app.receipts r
   where r.org_id = p_org and r.account_id is not null and r.voided_at is null and r.verify_status = 'pending' and r.collector_employee_id is null
     and app.has_role(p_org, array['admin','finance','manager']::app.role_name[])
   group by r.account_id
$$;

revoke all on function app.set_cash_account_opts(uuid, jsonb), app.cash_account_usage(uuid), app.cash_pending(uuid), app.cash_account_renamed() from public;
grant execute on function app.set_cash_account_opts(uuid, jsonb), app.cash_account_usage(uuid), app.cash_pending(uuid) to authenticated;

-- 新装的库 / 新公司建默认账户时, Wave 直接带 1% 手续费率
create or replace function app.ensure_cash_accounts(p_org uuid) returns void language sql security definer set search_path = app, public as $$
  insert into app.cash_accounts (org_id, name, kind, currency, note, fee_pct)
  select p_org, x.name, x.kind, x.cur, x.note, case when x.kind = 'wave' then 1 else 0 end
  from (values ('Cash-XOF','cash','XOF','金蝶账户 12345001'), ('Wave-XOF','wave','XOF','金蝶账户 12345002'), ('Cash-RMB','cash','CNY','金蝶账户 12345003'), ('Cash-USD','cash','USD','金蝶账户 12345004')) as x(name, kind, cur, note)
  where exists (select 1 from app.currencies c where c.code = x.cur)
  on conflict (org_id, name) do nothing;
$$;
revoke all on function app.ensure_cash_accounts(uuid) from public;
