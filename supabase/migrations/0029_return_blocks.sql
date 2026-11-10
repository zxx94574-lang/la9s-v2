-- 0029 (11-09 Frank 第 21 条): 退货三板块 ① 收到退货 (接收时间 + 实物照片必填, 收到货才能发起) ② 对账 + 核验 ③ 和客户对账 (对账完成才算结束, 没完成挂待办)
alter table app.returns add column received_at timestamptz, add column received_photo text,
  add column reconciled_at timestamptz, add column reconciled_by uuid;

create or replace function app.request_return(p_deal uuid, p_reason_type app.return_reason, p_reason text, p_lines jsonb, p_batch text, p_received_at timestamptz, p_photo text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  if coalesce(p_photo,'') = '' then raise exception 'VALIDATION: 收到退货要拍实物照片（少量要能看清片数，多量拍整体）'; end if;
  if p_received_at is null then raise exception 'VALIDATION: 填收到退货的时间'; end if;
  if p_received_at > now() + interval '1 hour' then raise exception 'VALIDATION: 接收时间不能在将来'; end if;
  v_id := app.request_return(p_deal, p_reason_type, p_reason, p_lines, p_batch);
  update app.returns set received_at = p_received_at, received_photo = p_photo where id = v_id;
  return v_id;
end $$;

-- 对账完成: 已批准 + 全部检验完 才能点; 之后这张退货单不再进待办
create or replace function app.return_reconciled(p_return uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.returns;
begin
  select * into r from app.returns where id = p_return for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'hotline', 'manager', 'sales_manager', 'finance');
  if r.status <> 'approved' then raise exception 'BAD_STATE: 退货还没批准'; end if;
  if exists (select 1 from app.return_lines rl where rl.return_id = p_return and coalesce(rl.qty_good,0) + coalesce(rl.qty_scrap,0) < rl.qty) then
    raise exception 'BAD_STATE: 还有没检验完的行，先核验再对账';
  end if;
  update app.returns set reconciled_at = now(), reconciled_by = app.uid() where id = p_return;
  perform app.deal_event(r.deal_id, 'return_reconciled', jsonb_build_object('rt_no', r.rt_no));
end $$;

-- 待办用: 没走完的退货 (没批 / 没检验完 / 没对账)
create or replace view app.v_open_returns as
select r.*, d.biz_no, c.name as customer_name,
  case when r.status = 'requested' then 'decide' when r.status = 'approved' and exists (select 1 from app.return_lines rl where rl.return_id = r.id and coalesce(rl.qty_good,0) + coalesce(rl.qty_scrap,0) < rl.qty) then 'inspect'
       when r.status = 'approved' and r.reconciled_at is null then 'reconcile' end as pending
from app.returns r join app.deals d on d.id = r.deal_id join app.customers c on c.id = r.customer_id
where r.status in ('requested','approved') and r.reconciled_at is null;
