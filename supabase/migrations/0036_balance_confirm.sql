-- 0036 (Frank 11-11 16:34): 签收 · 对账 这一步加「客户确认对账」: 跟报价确认 / 退货对账一样 —— 客户信息 + 确认方式 + 确认截图
-- 之后又出库了新的一批 (签收时间比上次对账晚) → 要重新对账
alter table app.deals add column balance_confirmed_at timestamptz, add column balance_confirmed_by uuid,
  add column balance_method text, add column balance_proof text, add column balance_note text;

create or replace function app.confirm_balance(p_deal uuid, p_method text, p_proof text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales_manager', 'sales', 'finance');
  if not exists (select 1 from app.shipments where deal_id = p_deal and voided_at is null) then raise exception 'BAD_STATE: 还没出库，没有可对的账'; end if;
  if exists (select 1 from app.shipments where deal_id = p_deal and voided_at is null and customer_received_at is null) then raise exception 'BAD_STATE: 还有没签收的批次，先签收再对账'; end if;
  if coalesce(p_method, '') not in ('whatsapp', 'phone', 'in_store') then raise exception 'VALIDATION: 选确认方式'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传客户确认对账的截图'; end if;
  update app.deals set balance_confirmed_at = now(), balance_confirmed_by = app.uid(), balance_method = p_method,
    balance_proof = p_proof, balance_note = nullif(trim(coalesce(p_note, '')), '') where id = p_deal;
  perform app.deal_event(p_deal, 'balance_confirmed', jsonb_build_object('method', p_method, 'note', nullif(trim(coalesce(p_note, '')), '')));
end $$;

-- 这张单要不要对账: 全部签收了, 但没对过账 / 对账之后又签收了新的一批
create or replace function app.balance_pending(p_deal uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.shipments where deal_id = p_deal and voided_at is null)
    and not exists (select 1 from app.shipments where deal_id = p_deal and voided_at is null and customer_received_at is null)
    and coalesce((select balance_confirmed_at from app.deals where id = p_deal), '-infinity'::timestamptz)
        < (select max(customer_received_at) from app.shipments where deal_id = p_deal and voided_at is null)
$$;

revoke all on function app.confirm_balance(uuid, text, text, text), app.balance_pending(uuid) from public;
grant execute on function app.confirm_balance(uuid, text, text, text), app.balance_pending(uuid) to authenticated;

-- 以前已经签收并收完款的单: 当作已对账 (不然全挤进待办); 还欠着钱的单留着, 要真对一次
update app.deals d set balance_confirmed_at = now(), balance_note = '0036 之前已签收并收完款，默认已对账'
from app.v_deal_totals t
where t.deal_id = d.id and app.balance_pending(d.id)
  and t.shipped_amount - t.returned_amount - t.allocated_amount - t.writeoff_amount <= 0;
