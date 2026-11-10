-- LA&9S Operations · 0005 flow controls (Frank 2026-10-28 待改清单)
-- 撤回下推 · 真复核(复核人/照片/复核数量/抽检) · 确认方式与凭证 · 约定发货日 · 解锁改数量 · 撤销出库
-- 预付自动抵扣 · 退货批次 · 品牌 · 机型改名合并 · 抹零 · 作废恢复

-- ───────────────────────── schema ─────────────────────────
alter table app.deals
  add column hotline_method text,
  add column hotline_proof text,
  add column reviewer_employee_id uuid references app.employees(id),
  add column review_photo_path text,
  add column confirm_method text,
  add column confirm_proof text,
  add column planned_ship_date date;

alter table app.deal_lines add column qty_picked int;          -- 找货员报的实际供货 (复核可再改)

create table app.pick_checks (                                 -- 主管抽检记录
  id bigint generated always as identity primary key,
  deal_line_id uuid not null references app.deal_lines(id) on delete cascade,
  result text not null check (result in ('ok','qty_wrong','model_wrong','problem')),
  note text,
  by_user uuid,
  at timestamptz not null default now()
);

alter table app.shipments
  add column voided_at timestamptz,
  add column void_reason text,
  add column voided_by uuid;

alter table app.kingdee_outbox drop constraint kingdee_outbox_status_check;
alter table app.kingdee_outbox add constraint kingdee_outbox_status_check
  check (status in ('await_receipt','ready','synced','error','void'));

alter table app.ar_entries drop constraint ar_entries_kind_check;
alter table app.ar_entries add constraint ar_entries_kind_check
  check (kind in ('opening','shipment','return','receipt','adjust','void','writeoff'));

alter table app.returns add column batch_no text;
alter table app.products add column brand text;

alter table app.pick_checks enable row level security;
create policy read_own on app.pick_checks for select using (
  exists (select 1 from app.deal_lines l join app.deals d on d.id = l.deal_id where l.id = deal_line_id and app.is_member(d.org_id)));

-- ───────────────────────── views (voided shipments and write-offs) ─────────────────────────
drop view app.v_deal_due;
drop view app.v_deal_totals;
create view app.v_deal_totals as
select d.id as deal_id, d.org_id, d.customer_id, d.currency, d.kind, d.status,
  coalesce((select sum(sl.amount) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id
            where sh.deal_id = d.id and sh.voided_at is null), 0)
  + coalesce((select sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'opening'), 0) as shipped_amount,
  coalesce((select sum(r.amount) from app.returns r where r.deal_id = d.id and r.status = 'approved'), 0) as returned_amount,
  coalesce((select sum(a.amount) from app.receipt_allocations a where a.deal_id = d.id), 0) as allocated_amount,
  (select min(sh.shipped_at) from app.shipments sh where sh.deal_id = d.id and sh.voided_at is null) as first_shipped_at,
  coalesce((select -sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'writeoff'), 0) as writeoff_amount
from app.deals d;

create view app.v_deal_due as
select t.*, t.shipped_amount - t.returned_amount - t.allocated_amount - t.writeoff_amount as due
from app.v_deal_totals t;

create or replace view app.v_customer_balance as
select e.org_id, e.customer_id, e.currency,
  sum(e.amount) filter (where e.kind in ('opening','shipment','void')) as total_sold,
  -sum(e.amount) filter (where e.kind = 'receipt') as total_paid,
  -sum(e.amount) filter (where e.kind = 'return') as total_returned,
  sum(e.amount) as balance,
  -sum(e.amount) filter (where e.kind = 'writeoff') as total_writeoff
from app.ar_entries e group by 1,2,3;

alter view app.v_deal_totals set (security_invoker = true);
alter view app.v_deal_due set (security_invoker = true);
alter view app.v_customer_balance set (security_invoker = true);

-- ───────────────────────── helpers ─────────────────────────
-- release receipt allocations of a deal that exceed what it now owes (newest first) → back to 预付款
create or replace function app.release_overallocation(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_over numeric; a record; v_cut numeric;
begin
  select -due into v_over from app.v_deal_due where deal_id = p_deal;
  for a in select id, amount from app.receipt_allocations where deal_id = p_deal order by at desc, id desc loop
    exit when coalesce(v_over,0) <= 0;
    v_cut := least(a.amount, v_over);
    if v_cut = a.amount then delete from app.receipt_allocations where id = a.id;
    else update app.receipt_allocations set amount = amount - v_cut where id = a.id; end if;
    v_over := v_over - v_cut;
  end loop;
end $$;

-- 预付款自动抵扣: put any unallocated money of this customer (same currency) onto open deals, oldest first
create or replace function app.apply_prepayments(p_customer uuid, p_currency text)
returns numeric language plpgsql security definer set search_path = app, public as $$
declare r record; v_before numeric; v_after numeric; v_total numeric := 0;
begin
  for r in select o.id, o.unallocated from app.v_receipt_open o
           where o.customer_id = p_customer and o.account_currency = p_currency and o.unallocated > 0
           order by o.received_on, o.created_at loop
    exit when not exists (select 1 from app.v_deal_due where customer_id = p_customer and currency = p_currency and due > 0 and status <> 'cancelled');
    v_before := r.unallocated;
    perform app.allocate(r.id, 'oldest', '[]');
    select unallocated into v_after from app.v_receipt_open where id = r.id;
    v_total := v_total + (v_before - v_after);
  end loop;
  return v_total;
end $$;

-- ───────────────────────── 2. 热线确认: 方式 (+可选截图) ─────────────────────────
drop function app.hotline_confirm(uuid, text);
create function app.hotline_confirm(p_deal uuid, p_note text default null, p_method text default null, p_proof text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  perform app.lock_deal(p_deal, array['quoted']::app.deal_status[]);
  if p_method is not null and p_method not in ('whatsapp','phone','in_store') then raise exception 'VALIDATION: 确认方式无效'; end if;
  update app.deals set status = 'hotline_ok', hotline_note = p_note, hotline_method = p_method, hotline_proof = p_proof where id = p_deal;
  perform app.deal_event(p_deal, 'hotline_confirmed', jsonb_build_object('note', p_note, 'method', p_method));
end $$;

-- ───────────────────────── 4. 找货员提交: also record 找货员报的数量 ─────────────────────────
create or replace function app.submit_pick(p_deal uuid, p_picker uuid, p_photo text, p_actual jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; a jsonb; l app.deal_lines;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'picker', 'manager');
  d := app.lock_deal(p_deal, array['picking']::app.deal_status[]);
  if p_picker is null then raise exception 'VALIDATION: 找货人必选'; end if;
  if p_photo is null or length(p_photo) = 0 then raise exception 'VALIDATION: 找货照片必传'; end if;
  for a in select * from jsonb_array_elements(coalesce(p_actual,'[]')) loop
    select * into l from app.deal_lines where id = (a->>'line_id')::uuid and deal_id = p_deal for update;
    if not found then raise exception 'NOT_FOUND: line'; end if;
    if (a->>'qty')::int > l.qty_supply then
      raise exception 'VALIDATION: 实际供货不能超过预占 (%>%)，加货请走追加', (a->>'qty')::int, l.qty_supply;
    end if;
    if (a->>'qty')::int < l.qty_supply then
      if coalesce(trim(a->>'reason'),'') = '' then raise exception 'VALIDATION: 数量差异必须填原因'; end if;
      perform app.reserve(l.stock_item_id, (a->>'qty')::int - l.qty_supply);
      update app.deal_lines set qty_supply = (a->>'qty')::int, diff_reason = a->>'reason' where id = l.id;
    end if;
  end loop;
  update app.deal_lines set qty_picked = qty_supply where deal_id = p_deal;
  update app.deals set status = 'picked', picker_employee_id = p_picker, pick_photo_path = p_photo where id = p_deal;
  perform app.deal_event(p_deal, 'pick_submitted', jsonb_build_object('picker', p_picker, 'changes', p_actual));
end $$;

-- ───────────────────────── 5. 主管复核: 复核人 + 照片 + 复核数量 + 抽检 ─────────────────────────
-- p_actual: [{line_id, qty, reason}] (only lower) ; p_checks: [{line_id, result, note?}]
drop function app.review_pick(uuid);
create function app.review_pick(p_deal uuid, p_reviewer uuid, p_photo text, p_actual jsonb default '[]', p_checks jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; a jsonb; l app.deal_lines; c jsonb;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['picked']::app.deal_status[]);
  if p_reviewer is null then raise exception 'VALIDATION: 复核人必选'; end if;
  if coalesce(p_photo,'') = '' then raise exception 'VALIDATION: 复核照片必拍'; end if;
  for c in select * from jsonb_array_elements(coalesce(p_checks,'[]')) loop
    if not exists (select 1 from app.deal_lines where id = (c->>'line_id')::uuid and deal_id = p_deal) then raise exception 'NOT_FOUND: line'; end if;
    insert into app.pick_checks (deal_line_id, result, note, by_user) values ((c->>'line_id')::uuid, c->>'result', c->>'note', app.uid());
  end loop;
  for a in select * from jsonb_array_elements(coalesce(p_actual,'[]')) loop
    select * into l from app.deal_lines where id = (a->>'line_id')::uuid and deal_id = p_deal for update;
    if not found then raise exception 'NOT_FOUND: line'; end if;
    if (a->>'qty')::int > l.qty_supply then raise exception 'VALIDATION: 复核数量不能超过找货数量，加货请走追加'; end if;
    if (a->>'qty')::int < l.qty_supply then
      if coalesce(trim(a->>'reason'),'') = '' then raise exception 'VALIDATION: 复核数量变少必须填原因'; end if;
      perform app.reserve(l.stock_item_id, (a->>'qty')::int - l.qty_supply);
      update app.deal_lines set qty_supply = (a->>'qty')::int, diff_reason = '复核：' || (a->>'reason') where id = l.id;
    end if;
  end loop;
  -- a check marked problem must be resolved by a quantity change or a note
  if exists (select 1 from jsonb_array_elements(coalesce(p_checks,'[]')) as ck(v)
             where ck.v->>'result' <> 'ok' and coalesce(trim(ck.v->>'note'),'') = ''
               and not exists (select 1 from jsonb_array_elements(coalesce(p_actual,'[]')) as ac(v) where ac.v->>'line_id' = ck.v->>'line_id')) then
    raise exception 'VALIDATION: 抽检有问题的行必须改数量或写原因';
  end if;
  update app.deals set status = 'reviewed', reviewed_by = app.uid(), reviewed_at = now(),
    reviewer_employee_id = p_reviewer, review_photo_path = p_photo where id = p_deal;
  perform app.deal_event(p_deal, 'pick_reviewed', jsonb_build_object('reviewer', p_reviewer, 'changes', p_actual, 'checks', jsonb_array_length(coalesce(p_checks,'[]'))));
end $$;

-- ───────────────────────── 6. 销售订单: 0 价仅允许中方手改(赠品/样品) ─────────────────────────
create or replace function app.create_sales_order(p_deal uuid, p_confirm_manual_prices boolean default false)
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_no text;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['reviewed']::app.deal_status[]);
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

-- 改价: 中方; 已确认的单改价后回到「待客户确认」
create or replace function app.set_line_price(p_line uuid, p_price numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into l from app.deal_lines where id = p_line;
  select * into d from app.deals where id = l.deal_id;
  perform app.require_role(d.org_id, 'admin');
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'VALIDATION: price change needs reason'; end if;
  if p_price < 0 then raise exception 'VALIDATION: 价格不能为负'; end if;
  d := app.lock_deal(d.id, array['quoted','hotline_ok','picking','picked','reviewed','ordered','confirmed']::app.deal_status[]);
  update app.deal_lines set unit_price = p_price, price_manual = true, price_set_by = app.uid() where id = p_line;
  if d.status = 'confirmed' then update app.deals set status = 'ordered' where id = d.id; end if;
  perform app.deal_event(d.id, 'price_set', jsonb_build_object('line', p_line, 'from', l.unit_price, 'to', p_price, 'reason', p_reason));
end $$;

-- 解锁改数量 (出库前): 带原因; 同步预占; 已确认的单回到「待客户确认」
create or replace function app.change_line_qty(p_line uuid, p_qty int, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into l from app.deal_lines where id = p_line for update;
  if not found then raise exception 'NOT_FOUND: line'; end if;
  select * into d from app.deals where id = l.deal_id;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(d.id, array['reviewed','ordered','confirmed','partial']::app.deal_status[]);
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 改数量必须选原因'; end if;
  if p_qty < l.qty_shipped then raise exception 'VALIDATION: 不能少于已出库数量 %', l.qty_shipped; end if;
  if l.product_id is null then raise exception 'VALIDATION: 未建档行不能供货'; end if;
  perform app.reserve(l.stock_item_id, p_qty - l.qty_supply);
  update app.deal_lines set qty_supply = p_qty, qty_req = greatest(qty_req, p_qty) where id = l.id;
  update app.deals set version = version + 1,
    status = case when status = 'confirmed' then 'ordered'::app.deal_status else status end where id = d.id;
  perform app.deal_event(d.id, 'qty_changed', jsonb_build_object('line', l.id, 'from', l.qty_supply, 'to', p_qty, 'reason', p_reason));
end $$;

-- 出库前追加: 新行立即预占; 已确认的单回到「待客户确认」(销售单号不变)
create or replace function app.add_lines_before_ship(p_deal uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['picked','reviewed','ordered','confirmed','partial']::app.deal_status[]);
  perform app.write_lines(d, p_lines, true);
  for l in select * from app.deal_lines where deal_id = p_deal and added_after_pick and qty_supply = 0 and product_id is not null loop
    perform app.reserve(l.stock_item_id, l.qty_req);
    update app.deal_lines set qty_supply = l.qty_req where id = l.id;
  end loop;
  update app.deals set version = version + 1,
    status = case when status = 'confirmed' then 'ordered'::app.deal_status else status end
  where id = p_deal;
  perform app.deal_event(p_deal, 'lines_added', jsonb_build_object('count', jsonb_array_length(p_lines)));
end $$;

-- ───────────────────────── 7. 客户最终确认: 方式 + 截图必传 + 约定发货日 ─────────────────────────
drop function app.customer_confirm(uuid, text);
create function app.customer_confirm(p_deal uuid, p_note text default null, p_method text default null,
                                     p_proof text default null, p_ship_date date default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  perform app.lock_deal(p_deal, array['ordered']::app.deal_status[]);
  if coalesce(p_method,'') not in ('whatsapp','phone','in_store') then raise exception 'VALIDATION: 请选择确认方式'; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 客户最终确认必须上传截图'; end if;
  update app.deals set status = 'confirmed', confirm_note = p_note, confirm_method = p_method, confirm_proof = p_proof,
    planned_ship_date = coalesce(p_ship_date, current_date) where id = p_deal;
  perform app.deal_event(p_deal, 'customer_confirmed', jsonb_build_object('note', p_note, 'method', p_method, 'ship_date', coalesce(p_ship_date, current_date)));
end $$;

-- ───────────────────────── 8. 出库: + 预付款自动抵扣 ─────────────────────────
create or replace function app.ship(p_deal uuid, p_shipped_at timestamptz, p_method app.ship_method,
                                    p_phone text, p_address text, p_proof text, p_items jsonb default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_ship uuid; v_no text; l app.deal_lines; v_qty int; v_amt numeric := 0; v_left int; v_pre numeric;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['confirmed','partial']::app.deal_status[]);
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
  if not exists (select 1 from app.shipment_lines where shipment_id = v_ship) then
    raise exception 'VALIDATION: nothing to ship';
  end if;
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

-- 撤销出库 (发货失败/被退回, 客户签收前): 货回原仓位并重新预占, 应收冲回, 单回待出库
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
  update app.deals set status = case when v_shipped > 0 then 'partial'::app.deal_status else 'confirmed'::app.deal_status end where id = d.id;
  perform app.deal_event(d.id, 'shipment_voided', jsonb_build_object('out_no', s.out_no, 'amount', s.amount, 'reason', p_reason));
end $$;

-- ───────────────────────── 撤回到上一步 (像金蝶反审核) ─────────────────────────
create or replace function app.revert_step(p_deal uuid, p_reason text)
returns app.deal_status language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l record; v_to app.deal_status;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['hotline_ok','picking','picked','reviewed','ordered','confirmed']::app.deal_status[]);
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
    when 'reviewed' then
      v_to := 'picked';
      update app.deals set reviewer_employee_id = null, review_photo_path = null, reviewed_by = null, reviewed_at = null where id = p_deal;
    when 'ordered' then
      v_to := 'reviewed';
    when 'confirmed' then
      v_to := 'ordered';
      update app.deals set confirm_note = null, confirm_method = null, confirm_proof = null, planned_ship_date = null where id = p_deal;
  end case;
  update app.deals set status = v_to, version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'step_reverted', jsonb_build_object('from', d.status, 'to', v_to, 'reason', p_reason));
  return v_to;
end $$;

-- 作废的单恢复为报价 (不预占, 需重新下推)
create or replace function app.restore_deal(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  perform app.lock_deal(p_deal, array['cancelled']::app.deal_status[]);
  update app.deal_lines set qty_supply = 0, qty_picked = null where deal_id = p_deal;
  update app.deals set status = 'quoted', pick_no = null, version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'restored');
end $$;

-- cancel must also zero supply so a later restore starts clean
create or replace function app.cancel_deal(p_deal uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok','picking','picked','reviewed','ordered','confirmed']::app.deal_status[]);
  for l in select * from app.deal_lines where deal_id = p_deal and qty_supply > 0 loop
    perform app.reserve(l.stock_item_id, -l.qty_supply);
  end loop;
  update app.deal_lines set qty_supply = 0 where deal_id = p_deal;
  update app.deals set status = 'cancelled' where id = p_deal;
  perform app.deal_event(p_deal, 'cancelled', jsonb_build_object('reason', p_reason));
end $$;

-- ───────────────────────── 退货: 批次号 (跨订单一次退) ─────────────────────────
drop function app.request_return(uuid, app.return_reason, text, jsonb);
create function app.request_return(p_deal uuid, p_reason_type app.return_reason, p_reason text, p_lines jsonb, p_batch text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_id uuid; x jsonb; l app.deal_lines; v_pending int;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  if d.status not in ('partial','shipped') or d.kind <> 'normal' then raise exception 'BAD_STATE: 只能对已出库订单退货'; end if;
  insert into app.returns (org_id, rt_no, deal_id, customer_id, reason_type, reason, requested_by, batch_no)
  values (d.org_id, app.next_doc_no(d.org_id,'RT'), p_deal, d.customer_id, p_reason_type, p_reason, app.uid(), p_batch) returning id into v_id;
  for x in select * from jsonb_array_elements(p_lines) loop
    select * into l from app.deal_lines where id = (x->>'line_id')::uuid and deal_id = p_deal;
    if not found then raise exception 'NOT_FOUND: line not in this order'; end if;
    select coalesce(sum(rl.qty),0) into v_pending from app.return_lines rl join app.returns r on r.id = rl.return_id
      where rl.deal_line_id = l.id and r.status = 'requested' and r.id <> v_id;
    if (x->>'qty')::int > l.qty_shipped - l.qty_returned - v_pending then
      raise exception 'VALIDATION: 退货数量超过可退数量';
    end if;
    insert into app.return_lines (return_id, deal_line_id, qty, unit_price) values (v_id, l.id, (x->>'qty')::int, l.unit_price);
  end loop;
  update app.returns set amount = (select sum(round(qty*unit_price,2)) from app.return_lines where return_id = v_id) where id = v_id;
  perform app.deal_event(p_deal, 'return_requested', jsonb_build_object('return', v_id, 'batch', p_batch));
  return v_id;
end $$;

-- ───────────────────────── 机型改名 / 合并 (仅中方) ─────────────────────────
-- renames products and 未建档需求 whose model equals p_from (optionally within one category)
create or replace function app.rename_model(p_org uuid, p_category uuid, p_from text, p_to text, p_reason text)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_to text := upper(regexp_replace(trim(p_to), '\s+', ' ', 'g')); v_from text := upper(trim(p_from)); n int := 0; m int;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(v_to,'') = '' or coalesce(v_from,'') = '' then raise exception 'VALIDATION: 型号不能为空'; end if;
  if exists (select 1 from app.products p where p.org_id = p_org and p.model = v_to
             and exists (select 1 from app.products q where q.org_id = p_org and q.model = v_from and q.category_id = p.category_id)
             and (p_category is null or p.category_id = p_category)) then
    raise exception 'CONFLICT: 同种类下已有型号 %，物料不能直接合并（编码不同），请先处理编码', v_to;
  end if;
  update app.products set model = v_to where org_id = p_org and model = v_from and (p_category is null or category_id = p_category);
  get diagnostics n = row_count;
  update app.products set shared_models = array_replace(shared_models, v_from, v_to) where org_id = p_org and v_from = any(shared_models);
  update app.deal_lines l set req_model = v_to from app.deals d
    where d.id = l.deal_id and d.org_id = p_org and l.product_id is null and l.req_model = v_from
      and (p_category is null or l.req_category_id = p_category);
  get diagnostics m = row_count;
  perform app.audit(p_org, 'rename_model', 'products', null, jsonb_build_object('from', v_from, 'to', v_to, 'products', n, 'unmet_lines', m, 'reason', p_reason));
  return n + m;
end $$;

-- ───────────────────────── 抹零 (财务, 小额尾差) ─────────────────────────
create or replace function app.write_off(p_deal uuid, p_amount numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_due numeric;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'finance');
  select due into v_due from app.v_deal_due where deal_id = p_deal;
  if p_amount <= 0 or p_amount > v_due then raise exception 'VALIDATION: 抹零金额必须大于 0 且不超过未付'; end if;
  if p_amount > (case when d.currency = 'XOF' then 100 else 1 end) then raise exception 'VALIDATION: 抹零超过上限'; end if;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, note)
  values (d.org_id, d.customer_id, d.currency, 'writeoff', -p_amount, p_deal, '抹零：' || coalesce(p_reason,''));
  perform app.deal_event(p_deal, 'written_off', jsonb_build_object('amount', p_amount, 'reason', p_reason));
end $$;

-- ───────────────────────── permissions ─────────────────────────
revoke execute on function app.release_overallocation(uuid) from public;
revoke execute on function app.apply_prepayments(uuid, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.pick_checks to authenticated;
    grant select on app.v_deal_totals, app.v_deal_due, app.v_customer_balance to authenticated;
    grant execute on function app.hotline_confirm(uuid, text, text, text), app.review_pick(uuid, uuid, text, jsonb, jsonb),
      app.customer_confirm(uuid, text, text, text, date), app.change_line_qty(uuid, int, text), app.void_shipment(uuid, text),
      app.revert_step(uuid, text), app.restore_deal(uuid), app.request_return(uuid, app.return_reason, text, jsonb, text),
      app.rename_model(uuid, uuid, text, text, text), app.write_off(uuid, numeric, text) to authenticated;
  end if;
end $$;
