-- 0080 (Frank 11-22): 每一笔收款都通知中方 (进「变更通知」, 绿色) + 待办顶上每日收款汇总 (前端按日汇总, 不另建表)
create or replace function app.trg_receipt_notice() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  insert into app.change_notices (org_id, deal_id, kind, detail, by_user)
  values (new.org_id, null, 'receipt_in', jsonb_build_object('customer_id', new.customer_id, 'rcv_no', new.rcv_no, 'amount', new.amount,
    'currency', new.currency, 'converted', new.converted, 'account_currency', new.account_currency, 'method', new.method::text), new.created_by);
  return new;
end $$;
drop trigger if exists receipt_notice on app.receipts;
create trigger receipt_notice after insert on app.receipts for each row execute function app.trg_receipt_notice();
