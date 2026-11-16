-- 0050 (Frank 11-16 Q7 / Q8): 签收记「跟谁确认的」+ 24 小时损坏反馈规则
-- Q7: 24 小时从「客户确认收到、数量无误」的签收算; 谁收的货就跟谁确认 (老板不在国内 → 店员), 记姓名 + 电话 + 身份, 电话进客户联系人。
--     超过 24 小时 / 人为损坏 → 原则上不认, 中方可以破例, 必须写原因。不认也必须写原因。
-- Q8-2: 退货在中方批准时减账 (原规则, 不变)。

alter table app.shipments add column confirm_name text, add column confirm_phone text,
  add column confirm_role text check (confirm_role in ('boss','staff','other'));
alter table app.customers add column contacts jsonb not null default '[]';

-- 新签收: 照片 + 跟谁确认的 (姓名 / 电话 / 身份) 都必填
create or replace function app.sign_receipt(p_shipment uuid, p_photo text, p_at timestamptz, p_name text, p_phone text, p_role text)
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; v_phone text := regexp_replace(coalesce(p_phone,''), '\s', '', 'g');
begin
  if coalesce(trim(p_name),'') = '' then raise exception 'VALIDATION: 写清楚跟谁确认的（姓名）'; end if;
  if v_phone = '' then raise exception 'VALIDATION: 填确认人的电话（老板不在就要店员的电话）'; end if;
  if coalesce(p_role,'') not in ('boss','staff','other') then raise exception 'VALIDATION: 选确认人是老板还是店员'; end if;
  perform app.sign_receipt(p_shipment, p_photo, p_at);
  update app.shipments set confirm_name = trim(p_name), confirm_phone = v_phone, confirm_role = p_role where id = p_shipment returning * into s;
  -- 电话存进客户联系人 (已有的不重复加; 和客户主电话一样的也不加)
  update app.customers c set contacts = c.contacts || jsonb_build_array(jsonb_build_object('name', trim(p_name), 'phone', v_phone, 'role', p_role, 'added_at', now()))
   where c.id = (select customer_id from app.deals where id = s.deal_id)
     and regexp_replace(coalesce(c.phone,''), '\s', '', 'g') <> v_phone
     and not exists (select 1 from jsonb_array_elements(c.contacts) x where x->>'phone' = v_phone);
  perform app.deal_event(s.deal_id, 'sign_confirmed_with', jsonb_build_object('out_no', s.out_no, 'name', trim(p_name), 'phone', v_phone, 'role', p_role));
end $$;

-- 收货差异: 超过 24 小时还要认 → 必须写破例原因
create or replace function app.disc_late_note() returns trigger language plpgsql as $$
begin
  if new.status = 'decided' and old.status = 'open' and new.late and new.decision <> 'reject' and coalesce(trim(new.decide_note),'') = '' then
    raise exception 'VALIDATION: 超过 24 小时才反馈，要认必须写破例原因';
  end if;
  return new;
end $$;
create trigger disc_late_note before update on app.receipt_discrepancies for each row execute function app.disc_late_note();

-- 退货: 记签收时间 → 算是否超过 24 小时; 人为损坏 / 超时 → 批准必须写破例原因
alter table app.returns add column signed_ref timestamptz, add column late boolean not null default false, add column decide_note text;

create or replace function app.return_window() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_window numeric;
begin
  if new.received_at is null or new.received_at is not distinct from old.received_at then return new; end if;
  v_window := coalesce((select (value->>'hours')::numeric from app.org_settings where org_id = new.org_id and key = 'discrepancy_window'), 24);
  select max(s.customer_received_at) into new.signed_ref
    from app.return_lines rl join app.shipment_lines sl on sl.deal_line_id = rl.deal_line_id join app.shipments s on s.id = sl.shipment_id
   where rl.return_id = new.id and s.voided_at is null;
  -- 损坏类才算 24 小时 (质量 / 物流 / 客户损坏); 「其他」不算. 没签收 = 还没开始计时
  new.late := new.reason_type in ('quality','logistics','customer_damage') and new.signed_ref is not null
              and extract(epoch from new.received_at - new.signed_ref) / 3600 > v_window;
  return new;
end $$;
create trigger return_window before update of received_at on app.returns for each row execute function app.return_window();

create or replace function app.return_exception_note() returns trigger language plpgsql as $$
begin
  if new.status = 'approved' and old.status = 'requested' and (new.late or new.reason_type = 'customer_damage') and coalesce(trim(new.decide_note),'') = '' then
    raise exception 'VALIDATION: %', case when new.reason_type = 'customer_damage' then '人为损坏原则上不认，要批准必须写破例原因' else '签收超过 24 小时才反馈，要批准必须写破例原因' end;
  end if;
  return new;
end $$;
create trigger return_exception_note before update on app.returns for each row execute function app.return_exception_note();

-- 审批退货带说明: 驳回必须写原因; 超时 / 人为损坏要批准必须写破例原因
create or replace function app.decide_return(p_return uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.returns;
begin
  select * into r from app.returns where id = p_return;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if not p_approve and coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 驳回要写原因'; end if;
  update app.returns set decide_note = nullif(trim(coalesce(p_note,'')),'') where id = p_return;
  perform app.decide_return(p_return, p_approve);
  if nullif(trim(coalesce(p_note,'')),'') is not null then
    perform app.deal_event(r.deal_id, case when p_approve then 'return_exception' else 'return_rejected' end, jsonb_build_object('rt_no', r.rt_no, 'note', trim(p_note)));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.sign_receipt(uuid, text, timestamptz, text, text, text), app.decide_return(uuid, boolean, text) to authenticated;
  end if;
end $$;
