-- LA&9S Operations · 0030 撤销收款 (Frank 11-09 14:01: 收款点错了 / 小数点输错要能撤销, 给自己留余地)
--   撤销 = 收款单标记已撤销 (不删, 留痕) + 冲账分配全部收回 + 客户总账反冲一笔 + 公户认领退回待认领. 必填原因.
--   财务 / 中方能撤. 撤销后照常重新登记一笔正确的.
alter table app.receipts add column voided_at timestamptz, add column voided_by uuid, add column void_reason text;

drop view app.v_receipt_open;
create view app.v_receipt_open as
select r.*, case when r.voided_at is not null then 0
  else r.converted - coalesce((select sum(a.amount) from app.receipt_allocations a where a.receipt_id = r.id), 0) end as unallocated
from app.receipts r;
alter view app.v_receipt_open set (security_invoker = true);
grant select on app.v_receipt_open to authenticated;

create or replace function app.void_receipt(p_receipt uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts; a record;
begin
  select * into r from app.receipts where id = p_receipt for update;
  if not found then raise exception 'NOT_FOUND: 收款单不存在'; end if;
  perform app.require_role(r.org_id, 'finance');
  if r.voided_at is not null then raise exception 'BAD_STATE: 这笔收款已经撤销过了'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 请写撤销原因'; end if;
  for a in select deal_id, sum(amount) as amt from app.receipt_allocations where receipt_id = p_receipt group by 1 loop
    perform app.deal_event(a.deal_id, 'receipt_voided', jsonb_build_object('receipt', p_receipt, 'rcv_no', r.rcv_no, 'amount', a.amt, 'reason', p_reason));
  end loop;
  delete from app.receipt_allocations where receipt_id = p_receipt;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, ref_id, note)
  values (r.org_id, r.customer_id, r.account_currency, 'receipt', r.converted, p_receipt, '撤销收款 ' || r.rcv_no || '：' || p_reason);
  update app.cash_moves set status = 'unclaimed', customer_id = null, receipt_id = null where receipt_id = p_receipt;
  update app.receipts set voided_at = now(), voided_by = app.uid(), void_reason = p_reason where id = p_receipt;
  perform app.audit(r.org_id, 'void_receipt', 'receipts', p_receipt, jsonb_build_object('reason', p_reason, 'amount', r.amount, 'currency', r.currency));
end $$;
revoke all on function app.void_receipt(uuid, text) from public;
grant execute on function app.void_receipt(uuid, text) to authenticated;

-- 退货「对账完成」必须挂客户对账凭证 (Frank 11-09 14:03: 先发对账单 → 客户对完给凭证 → 截图放上来 → 才点对账完成)
alter table app.returns add column reconciled_proof text;
create or replace function app.return_reconciled(p_return uuid, p_proof text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 先放客户对账的凭证截图，再点对账完成'; end if;
  perform app.return_reconciled(p_return);
  update app.returns set reconciled_proof = p_proof where id = p_return;
end $$;
revoke all on function app.return_reconciled(uuid, text) from public;
grant execute on function app.return_reconciled(uuid, text) to authenticated;
