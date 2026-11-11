-- 0037 (Frank 11-11 17:03): 凭证一律必传 (只有报价确认那一步选填)
-- 收款 (现金也要: 群里说「收到现金 XX」+ 客户回复确认的截图)、员工交款、坏账核销、对账 都改成必传; 找货 / 复检 / 出库 / 签收 / 对账确认 / 退货 / 客户确认 原来就是必传
create or replace function app.record_receipt2(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_landed numeric := (p->>'amount_landed')::numeric; v_fee numeric := coalesce(nullif(p->>'fee','')::numeric, 0);
  v_bearer text := nullif(p->>'fee_bearer',''); v_credit numeric; v_acc uuid := nullif(p->>'account_id','')::uuid; a app.cash_accounts;
begin
  perform app.require_role(p_org, 'finance');
  if coalesce(v_landed, 0) <= 0 then raise exception 'VALIDATION: 到账金额要大于 0'; end if;
  if coalesce(p->>'proof','') = '' then
    raise exception 'VALIDATION: %', case when p->>'method' = 'cash' then '现金收款也要传凭证：在客户群里说「收到现金 XX」，客户回复确认后截图传上来' else '收款要传付款截图' end;
  end if;
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

create or replace function app.receipt_handed(p_receipt uuid, p_account uuid, p_proof text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts;
begin
  select * into r from app.receipts where id = p_receipt for update;
  perform app.require_role(r.org_id, 'finance');
  if r.collector_employee_id is null then raise exception 'BAD_STATE: 这笔不是员工代收'; end if;
  if r.handed_at is not null then raise exception 'BAD_STATE: 已经交过了'; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 员工交款要传凭证（Wave 转账截图 / 当面交现金的照片）'; end if;
  update app.receipts set handed_at = now(), handed_by = app.uid(), handed_proof = p_proof, account_id = coalesce(p_account, account_id) where id = p_receipt;
  select * into r from app.receipts where id = p_receipt;
  perform app.receipt_to_account(r, r.account_id);
  update app.receipts set verify_status = 'verified', verified_at = now(), verified_by = app.uid(), verify_note = coalesce(verify_note, '员工已交') where id = p_receipt;
  perform app.audit(r.org_id, 'receipt_handed', 'receipts', p_receipt, jsonb_build_object('account', p_account));
end $$;

create or replace function app.write_off_bad_debt(p_deal uuid, p_amount numeric, p_reason text, p_proof text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_due numeric; v_id uuid;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 坏账核销要写原因'; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 坏账核销要传凭证（聊天记录 / 照片）'; end if;
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

create or replace function app.record_cash_check(p_account uuid, p_kind text, p_on date, p_actual numeric, p_note text default null, p_proof text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare a app.cash_accounts; v_sys numeric; v_id uuid;
begin
  select * into a from app.cash_accounts where id = p_account;
  perform app.require_role(a.org_id, 'finance');
  if p_actual is null then raise exception 'VALIDATION: 填实际余额 / 实点金额'; end if;
  v_sys := app.account_balance(p_account, p_on);
  if p_actual <> v_sys and coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 差了 %，要写原因', p_actual - v_sys; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: %', case when p_kind = 'count' then '现金盘点要拍照' else '对账要截 App / 银行里的余额图' end; end if;
  insert into app.cash_checks (org_id, account_id, kind, on_date, system_balance, actual_balance, note, proof, created_by)
  values (a.org_id, p_account, p_kind, p_on, v_sys, p_actual, nullif(p_note,''), nullif(p_proof,''), app.uid()) returning id into v_id;
  perform app.audit(a.org_id, 'cash_check', 'cash_accounts', p_account, jsonb_build_object('kind', p_kind, 'system', v_sys, 'actual', p_actual));
  return v_id;
end $$;
