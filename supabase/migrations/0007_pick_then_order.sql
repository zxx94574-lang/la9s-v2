-- LA&9S Operations · 0007 流程调整 (Frank 2026-10-29)
-- 初拣后直接出销售订单 → 客户确认 → 主管复检 + 打包 (打包照片) → 出库
--   picked    = 初拣已提交 (找货照片)            → create_sales_order
--   ordered   = 销售订单已出, 待客户确认          → customer_confirm
--   confirmed = 客户已确认, 待主管复检打包        → review_pick (复检 + 打包照片)
--   reviewed  = 已复检打包, 待出库                → ship
-- 复检时数量变少 → 回到「待客户确认」, 只标出变动的行; 客户再确认后直接回到「已复检」, 不用重检.
-- 出库前追加货 / 加数量 → 已有的复检作废, 需要重新复检.

alter table app.deal_lines add column review_changed boolean not null default false;

-- 销售订单: 从初拣直接出
create or replace function app.create_sales_order(p_deal uuid, p_confirm_manual_prices boolean default false)
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_no text;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['picked']::app.deal_status[]);
  if exists (select 1 from app.deal_lines where deal_id = p_deal and price_manual) and not p_confirm_manual_prices then
    raise exception 'CONFIRM_REQUIRED: 存在手动改价，需二次确认' using errcode = 'P0004';
  end if;
  if exists (select 1 from app.deal_lines where deal_id = p_deal and qty_supply > 0 and unit_price = 0 and not price_manual) then
    raise exception 'VALIDATION: 有供货行单价为 0（如是赠品/样品，请中方改价并注明原因）';
  end if;
  v_no := coalesce(d.so_no, app.next_doc_no(d.org_id, 'SO'));
  update app.deals set status = 'ordered', so_no = v_no where id = p_deal;
  perform app.deal_event(p_deal, 'sales_order_created', jsonb_build_object('so_no', v_no));
  return v_no;
end $$;

-- 客户确认: 已经复检过且之后没有追加/加量 → 直接回到「已复检」; 否则进入「待复检打包」
create or replace function app.customer_confirm(p_deal uuid, p_note text default null, p_method text default null,
                                                p_proof text default null, p_ship_date date default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_to app.deal_status;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  d := app.lock_deal(p_deal, array['ordered']::app.deal_status[]);
  if coalesce(p_method,'') not in ('whatsapp','phone','in_store') then raise exception 'VALIDATION: 请选择确认方式'; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 客户最终确认必须上传截图'; end if;
  v_to := case when d.reviewed_at is not null then 'reviewed'::app.deal_status else 'confirmed'::app.deal_status end;
  update app.deals set status = v_to, confirm_note = p_note, confirm_method = p_method, confirm_proof = p_proof,
    planned_ship_date = coalesce(p_ship_date, current_date) where id = p_deal;
  update app.deal_lines set review_changed = false where deal_id = p_deal;
  perform app.deal_event(p_deal, 'customer_confirmed', jsonb_build_object('note', p_note, 'method', p_method, 'ship_date', coalesce(p_ship_date, current_date)));
end $$;

-- 复检 + 打包 (主管): 复检人 + 打包照片必填; 少了必须选原因 → 回到待客户确认, 变动行标出
drop function app.review_pick(uuid, uuid, text, jsonb, jsonb);
create function app.review_pick(p_deal uuid, p_reviewer uuid, p_photo text, p_actual jsonb default '[]', p_checks jsonb default '[]')
returns app.deal_status language plpgsql security definer set search_path = app, public as $$
declare d app.deals; a jsonb; l app.deal_lines; c jsonb; v_changed int := 0; v_to app.deal_status;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['confirmed']::app.deal_status[]);
  if p_reviewer is null then raise exception 'VALIDATION: 复核人必选'; end if;
  if coalesce(p_photo,'') = '' then raise exception 'VALIDATION: 打包照片必传'; end if;
  for c in select * from jsonb_array_elements(coalesce(p_checks,'[]')) loop
    if not exists (select 1 from app.deal_lines where id = (c->>'line_id')::uuid and deal_id = p_deal) then raise exception 'NOT_FOUND: line'; end if;
    insert into app.pick_checks (deal_line_id, result, note, by_user) values ((c->>'line_id')::uuid, c->>'result', c->>'note', app.uid());
  end loop;
  for a in select * from jsonb_array_elements(coalesce(p_actual,'[]')) loop
    select * into l from app.deal_lines where id = (a->>'line_id')::uuid and deal_id = p_deal for update;
    if not found then raise exception 'NOT_FOUND: line'; end if;
    if (a->>'qty')::int > l.qty_supply then raise exception 'VALIDATION: 复检数量不能超过订单数量，加货请走追加'; end if;
    if (a->>'qty')::int < l.qty_supply then
      if coalesce(trim(a->>'reason'),'') = '' then raise exception 'VALIDATION: 复检数量变少必须填原因'; end if;
      perform app.reserve(l.stock_item_id, (a->>'qty')::int - l.qty_supply);
      update app.deal_lines set qty_supply = (a->>'qty')::int, diff_reason = '复检：' || (a->>'reason'), review_changed = true where id = l.id;
      v_changed := v_changed + 1;
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p_checks,'[]')) as ck(v)
             where ck.v->>'result' <> 'ok' and coalesce(trim(ck.v->>'note'),'') = ''
               and not exists (select 1 from jsonb_array_elements(coalesce(p_actual,'[]')) as ac(v) where ac.v->>'line_id' = ck.v->>'line_id')) then
    raise exception 'VALIDATION: 抽检有问题的行必须改数量或写原因';
  end if;
  v_to := case when v_changed > 0 then 'ordered'::app.deal_status else 'reviewed'::app.deal_status end;
  update app.deals set status = v_to, reviewed_by = app.uid(), reviewed_at = now(),
    reviewer_employee_id = p_reviewer, review_photo_path = p_photo,
    confirm_proof = case when v_changed > 0 then null else confirm_proof end, version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'pick_reviewed', jsonb_build_object('reviewer', p_reviewer, 'changes', p_actual,
    'checks', jsonb_array_length(coalesce(p_checks,'[]')), 'reconfirm', v_changed > 0));
  return v_to;
end $$;

-- 改价: 已确认 / 已复检的单改价后回到「待客户确认」(复检结果保留)
create or replace function app.set_line_price(p_line uuid, p_price numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into l from app.deal_lines where id = p_line;
  select * into d from app.deals where id = l.deal_id;
  perform app.require_role(d.org_id, 'admin');
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'VALIDATION: price change needs reason'; end if;
  if p_price < 0 then raise exception 'VALIDATION: 价格不能为负'; end if;
  d := app.lock_deal(d.id, array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed']::app.deal_status[]);
  update app.deal_lines set unit_price = p_price, price_manual = true, price_set_by = app.uid(),
    review_changed = d.status in ('confirmed','reviewed') where id = p_line;
  if d.status in ('confirmed','reviewed') then update app.deals set status = 'ordered', confirm_proof = null where id = d.id; end if;
  perform app.deal_event(d.id, 'price_set', jsonb_build_object('line', p_line, 'from', l.unit_price, 'to', p_price, 'reason', p_reason));
end $$;

-- 解锁改数量: 加量 → 复检作废; 减量 → 复检保留; 都要客户重新确认 (部分出库的单除外)
create or replace function app.change_line_qty(p_line uuid, p_qty int, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into l from app.deal_lines where id = p_line for update;
  if not found then raise exception 'NOT_FOUND: line'; end if;
  select * into d from app.deals where id = l.deal_id;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(d.id, array['ordered','confirmed','reviewed','partial']::app.deal_status[]);
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 改数量必须选原因'; end if;
  if p_qty < l.qty_shipped then raise exception 'VALIDATION: 不能少于已出库数量 %', l.qty_shipped; end if;
  if l.product_id is null then raise exception 'VALIDATION: 未建档行不能供货'; end if;
  perform app.reserve(l.stock_item_id, p_qty - l.qty_supply);
  update app.deal_lines set qty_supply = p_qty, qty_req = greatest(qty_req, p_qty), review_changed = true where id = l.id;
  update app.deals set version = version + 1,
    reviewed_at = case when p_qty > l.qty_supply then null else reviewed_at end,
    status = case when status in ('confirmed','reviewed') then 'ordered'::app.deal_status else status end,
    confirm_proof = case when status in ('confirmed','reviewed') then null else confirm_proof end
  where id = d.id;
  perform app.deal_event(d.id, 'qty_changed', jsonb_build_object('line', l.id, 'from', l.qty_supply, 'to', p_qty, 'reason', p_reason));
end $$;

-- 出库前追加: 新货没复检过 → 复检作废; 已出销售订单的回到「待客户确认」
create or replace function app.add_lines_before_ship(p_deal uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['picked','ordered','confirmed','reviewed','partial']::app.deal_status[]);
  perform app.write_lines(d, p_lines, true);
  for l in select * from app.deal_lines where deal_id = p_deal and added_after_pick and qty_supply = 0 and product_id is not null loop
    perform app.reserve(l.stock_item_id, l.qty_req);
    update app.deal_lines set qty_supply = l.qty_req, qty_picked = l.qty_req, review_changed = true where id = l.id;
  end loop;
  update app.deals set version = version + 1, reviewed_at = null,
    status = case when status in ('confirmed','reviewed') then 'ordered'::app.deal_status else status end,
    confirm_proof = case when status in ('confirmed','reviewed') then null else confirm_proof end
  where id = p_deal;
  perform app.deal_event(p_deal, 'lines_added', jsonb_build_object('count', jsonb_array_length(p_lines)));
end $$;

-- 出库: 只能在复检打包之后
create or replace function app.ship(p_deal uuid, p_shipped_at timestamptz, p_method app.ship_method,
                                    p_phone text, p_address text, p_proof text, p_items jsonb default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_ship uuid; v_no text; l app.deal_lines; v_qty int; v_amt numeric := 0; v_left int; v_pre numeric;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['reviewed','partial']::app.deal_status[]);
  if coalesce(trim(p_phone),'') = '' or coalesce(trim(p_address),'') = '' or coalesce(p_proof,'') = '' or p_shipped_at is null then
    raise exception 'VALIDATION: 发货时间/电话/地址/凭证必填';
  end if;
  v_no := app.next_doc_no(d.org_id, 'OUT');
  insert into app.shipments (org_id, deal_id, out_no, shipped_at, method, contact_phone, address, proof_path, amount, created_by)
  values (d.org_id, p_deal, v_no, p_shipped_at, p_method, p_phone, p_address, p_proof, 0, app.uid()) returning id into v_ship;
  for l in select * from app.deal_lines where deal_id = p_deal and qty_supply > qty_shipped order by seq for update loop
    if p_items is null then v_qty := l.qty_supply - l.qty_shipped;
    else
      select coalesce((x->>'qty')::int, 0) into v_qty from jsonb_array_elements(p_items) x where (x->>'line_id')::uuid = l.id;
      v_qty := coalesce(v_qty, 0);
    end if;
    if v_qty = 0 then continue; end if;
    if v_qty < 0 or v_qty > l.qty_supply - l.qty_shipped then raise exception 'VALIDATION: line % ship qty out of range', l.seq; end if;
    perform app.reserve(l.stock_item_id, -v_qty);
    perform app.move_stock(l.stock_item_id, -v_qty, 'ship', 'shipment', v_ship);
    update app.deal_lines set qty_shipped = qty_shipped + v_qty where id = l.id;
    insert into app.shipment_lines (shipment_id, deal_line_id, qty, unit_price, amount)
    values (v_ship, l.id, v_qty, l.unit_price, round(v_qty * l.unit_price, 2));
    v_amt := v_amt + round(v_qty * l.unit_price, 2);
  end loop;
  if not exists (select 1 from app.shipment_lines where shipment_id = v_ship) then raise exception 'VALIDATION: nothing to ship'; end if;
  update app.shipments set amount = v_amt where id = v_ship;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id)
  values (d.org_id, d.customer_id, d.currency, 'shipment', v_amt, p_deal, v_ship);
  insert into app.kingdee_outbox (org_id, shipment_id) values (d.org_id, v_ship);
  select coalesce(sum(qty_supply - qty_shipped), 0) into v_left from app.deal_lines where deal_id = p_deal;
  update app.deals set status = case when v_left = 0 then 'shipped'::app.deal_status else 'partial'::app.deal_status end where id = p_deal;
  perform app.deal_event(p_deal, 'shipped', jsonb_build_object('out_no', v_no, 'amount', v_amt));
  v_pre := app.apply_prepayments(d.customer_id, d.currency);
  if v_pre > 0 then perform app.deal_event(p_deal, 'prepayment_applied', jsonb_build_object('amount', v_pre)); end if;
  return v_ship;
end $$;

-- 撤销出库: 货回去以后单子回到「已复检，待出库」
create or replace function app.void_shipment(p_shipment uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; d app.deals; sl record; v_shipped int;
begin
  select * into s from app.shipments where id = p_shipment for update;
  if not found then raise exception 'NOT_FOUND: shipment'; end if;
  perform app.require_role(s.org_id, 'manager');
  if s.voided_at is not null then raise exception 'BAD_STATE: 这张出库单已撤销'; end if;
  if s.customer_received_at is not null then raise exception 'BAD_STATE: 客户已签收，只能走退货'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 撤销出库必须选原因'; end if;
  d := app.lock_deal(s.deal_id, array['partial','shipped']::app.deal_status[]);
  for sl in select * from app.shipment_lines where shipment_id = p_shipment loop
    perform app.move_stock((select stock_item_id from app.deal_lines where id = sl.deal_line_id), sl.qty, 'ship_void', 'shipment', p_shipment);
    perform app.reserve((select stock_item_id from app.deal_lines where id = sl.deal_line_id), sl.qty);
    update app.deal_lines set qty_shipped = qty_shipped - sl.qty where id = sl.deal_line_id;
  end loop;
  update app.shipments set voided_at = now(), void_reason = p_reason, voided_by = app.uid() where id = p_shipment;
  update app.kingdee_outbox set status = 'void', updated_at = now() where shipment_id = p_shipment;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id, note)
  values (s.org_id, d.customer_id, d.currency, 'void', -s.amount, d.id, p_shipment, '撤销出库：' || p_reason);
  perform app.release_overallocation(d.id);
  select coalesce(sum(qty_shipped),0) into v_shipped from app.deal_lines where deal_id = d.id;
  update app.deals set status = case when v_shipped > 0 then 'partial'::app.deal_status else 'reviewed'::app.deal_status end where id = d.id;
  perform app.deal_event(d.id, 'shipment_voided', jsonb_build_object('out_no', s.out_no, 'amount', s.amount, 'reason', p_reason));
end $$;

-- 撤回到上一步 (新顺序)
create or replace function app.revert_step(p_deal uuid, p_reason text)
returns app.deal_status language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l record; v_to app.deal_status;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['hotline_ok','picking','picked','ordered','confirmed','reviewed']::app.deal_status[]);
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 撤回必须选原因'; end if;
  case d.status
    when 'hotline_ok' then
      v_to := 'quoted';
      update app.deals set hotline_note = null, hotline_method = null, hotline_proof = null where id = p_deal;
    when 'picking' then
      v_to := case when d.hotline_method is not null or d.hotline_note is not null then 'hotline_ok'::app.deal_status else 'quoted'::app.deal_status end;
      for l in select * from app.deal_lines where deal_id = p_deal and qty_supply > 0 loop
        perform app.reserve(l.stock_item_id, -l.qty_supply);
      end loop;
      update app.deal_lines set qty_supply = 0, qty_picked = null, diff_reason = null where deal_id = p_deal;
      update app.deals set pick_no = null where id = p_deal;
    when 'picked' then
      v_to := 'picking';
      update app.deals set picker_employee_id = null, pick_photo_path = null where id = p_deal;
    when 'ordered' then
      v_to := 'picked';
    when 'confirmed' then
      v_to := 'ordered';
      update app.deals set confirm_note = null, confirm_method = null, confirm_proof = null, planned_ship_date = null where id = p_deal;
    when 'reviewed' then
      v_to := 'confirmed';
      update app.deals set reviewer_employee_id = null, review_photo_path = null, reviewed_by = null, reviewed_at = null where id = p_deal;
  end case;
  update app.deals set status = v_to, version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'step_reverted', jsonb_build_object('from', d.status, 'to', v_to, 'reason', p_reason));
  return v_to;
end $$;

-- 作废: 初拣后货已离开货架 → 事件里提示放回原库位
create or replace function app.cancel_deal(p_deal uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed']::app.deal_status[]);
  for l in select * from app.deal_lines where deal_id = p_deal and qty_supply > 0 loop
    perform app.reserve(l.stock_item_id, -l.qty_supply);
  end loop;
  update app.deal_lines set qty_supply = 0 where deal_id = p_deal;
  update app.deals set status = 'cancelled' where id = p_deal;
  perform app.deal_event(p_deal, 'cancelled', jsonb_build_object('reason', p_reason,
    'put_back', d.status in ('picked','ordered','confirmed','reviewed')));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.review_pick(uuid, uuid, text, jsonb, jsonb) to authenticated;
  end if;
end $$;
