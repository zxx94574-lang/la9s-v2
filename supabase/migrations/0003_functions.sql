-- LA&9S Operations · 0003 business functions (the ONLY write path)
-- Each function: permission check → row locks → invariants → write → audit/event.

-- ───────────────────────── helpers ─────────────────────────
create or replace function app.deal_event(p_deal uuid, p_action text, p_detail jsonb default null)
returns void language sql security definer set search_path = app, public as $$
  insert into app.deal_events (deal_id, user_id, action, detail) values (p_deal, app.uid(), p_action, p_detail);
  update app.deals set updated_at = now() where id = p_deal;
$$;

create or replace function app.lock_deal(p_deal uuid, p_allowed app.deal_status[])
returns app.deals language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal for update;
  if not found then raise exception 'NOT_FOUND: deal %', p_deal; end if;
  if not (d.status = any(p_allowed)) then
    raise exception 'BAD_STATE: deal % is %, expected %', d.biz_no, d.status, p_allowed using errcode = 'P0001';
  end if;
  return d;
end $$;

create or replace function app.tier_price(p_product uuid, p_customer uuid, p_currency text)
returns numeric language sql stable security definer set search_path = app, public as $$
  select pp.price from app.product_prices pp join app.customers c on c.id = p_customer
  where pp.product_id = p_product and pp.tier = c.tier and pp.currency = p_currency
$$;

-- change reservation on one stock row (locks it); delta may be negative
create or replace function app.reserve(p_stock uuid, p_delta int)
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.stock_items;
begin
  if p_delta = 0 then return; end if;
  select * into s from app.stock_items where id = p_stock for update;
  if s.qty_reserved + p_delta < 0 then raise exception 'INVARIANT: reservation below zero'; end if;
  if p_delta > 0 and s.qty_on_hand - s.qty_reserved < p_delta then
    raise exception 'INSUFFICIENT_STOCK: available %, need %', s.qty_on_hand - s.qty_reserved, p_delta using errcode = 'P0002';
  end if;
  update app.stock_items set qty_reserved = qty_reserved + p_delta where id = p_stock;
end $$;

create or replace function app.move_stock(p_stock uuid, p_qty int, p_reason text, p_ref_type text, p_ref uuid)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  update app.stock_items set qty_on_hand = qty_on_hand + p_qty where id = p_stock;
  insert into app.stock_moves (stock_item_id, qty, reason, ref_type, ref_id, by_user)
  values (p_stock, p_qty, p_reason, p_ref_type, p_ref, app.uid());
end $$;

-- stock row for (warehouse kind, product); creates if missing
create or replace function app.stock_row(p_org uuid, p_kind app.wh_kind, p_product uuid)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_wh uuid; v_id uuid;
begin
  select id into v_wh from app.warehouses where org_id = p_org and kind = p_kind order by code limit 1;
  if v_wh is null then raise exception 'CONFIG: no % warehouse', p_kind; end if;
  insert into app.stock_items (warehouse_id, product_id) values (v_wh, p_product)
  on conflict (warehouse_id, product_id) do nothing;
  select id into v_id from app.stock_items where warehouse_id = v_wh and product_id = p_product;
  return v_id;
end $$;

-- write lines from jsonb: [{product_id?, req_category_id?, req_model?, qty_req, stock_item_id?, note?}]
create or replace function app.write_lines(p_deal app.deals, p_lines jsonb, p_after_pick boolean default false)
returns void language plpgsql security definer set search_path = app, public as $$
declare l jsonb; v_seq int; v_price numeric; v_stock uuid; v_prod uuid; v_model text;
begin
  select coalesce(max(seq), 0) into v_seq from app.deal_lines where deal_id = p_deal.id;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_seq := v_seq + 1;
    v_prod := nullif(l->>'product_id','')::uuid;
    v_model := upper(nullif(trim(l->>'req_model'),''));
    if v_prod is null and (v_model is null or nullif(l->>'req_category_id','') is null) then
      raise exception 'VALIDATION: line % needs product or (category + model)', v_seq;
    end if;
    if coalesce((l->>'qty_req')::int, 0) <= 0 then
      raise exception 'VALIDATION: line % quantity must be > 0', v_seq using errcode = 'P0003';
    end if;
    v_stock := nullif(l->>'stock_item_id','')::uuid;
    if v_prod is not null and v_stock is null then
      -- default: the product's own local warehouse row (LA or 9S), never pending/scrap/fob
      select s.id into v_stock from app.stock_items s join app.warehouses w on w.id = s.warehouse_id
      where s.product_id = v_prod and w.org_id = p_deal.org_id
        and w.kind = case when p_deal.kind = 'fob' then 'fob'::app.wh_kind else 'local'::app.wh_kind end
      order by s.qty_on_hand - s.qty_reserved desc limit 1;
    end if;
    v_price := case when v_prod is null then 0 else coalesce(app.tier_price(v_prod, p_deal.customer_id, p_deal.currency), 0) end;
    insert into app.deal_lines (deal_id, seq, product_id, req_category_id, req_model, qty_req, stock_item_id,
                                unit_price, note, added_after_pick)
    values (p_deal.id, v_seq, v_prod, nullif(l->>'req_category_id','')::uuid, v_model,
            (l->>'qty_req')::int, v_stock, v_price, l->>'note', p_after_pick);
  end loop;
end $$;

-- ───────────────────────── 1. 报价 ─────────────────────────
create or replace function app.create_quote(p_org uuid, p_customer uuid, p_currency text, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; c app.customers;
begin
  perform app.require_role(p_org, 'manager', 'hotline', 'sales');
  select * into c from app.customers where id = p_customer and org_id = p_org;
  if not found then raise exception 'NOT_FOUND: customer'; end if;
  if c.tier is null then raise exception 'VALIDATION: customer has no price tier'; end if;
  if jsonb_array_length(coalesce(p_lines,'[]')) = 0 then raise exception 'VALIDATION: no lines'; end if;
  insert into app.deals (org_id, biz_no, quote_no, customer_id, currency, owner_employee_id, note, created_by)
  values (p_org, app.next_doc_no(p_org,'BIZ'), app.next_doc_no(p_org,'QT'), p_customer, p_currency,
          c.owner_employee_id, p_note, app.uid())
  returning * into d;
  perform app.write_lines(d, p_lines);
  perform app.deal_event(d.id, 'quote_created', jsonb_build_object('lines', jsonb_array_length(p_lines)));
  return d.id;
end $$;

-- 报价阶段修改 (增删改行): only before picking
create or replace function app.edit_quote(p_deal uuid, p_lines jsonb, p_remove uuid[] default '{}')
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager', 'hotline', 'sales');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok']::app.deal_status[]);
  delete from app.deal_lines where deal_id = p_deal and id = any(p_remove);
  if p_lines is not null and jsonb_array_length(p_lines) > 0 then perform app.write_lines(d, p_lines); end if;
  update app.deals set version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'quote_edited', jsonb_build_object('removed', coalesce(array_length(p_remove,1),0)));
end $$;

-- 批量获取价格: only selected, non-manual lines (never overwrite 手改价)
create or replace function app.refresh_prices(p_deal uuid, p_line_ids uuid[])
returns int language plpgsql security definer set search_path = app, public as $$
declare d app.deals; n int;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager', 'hotline', 'sales');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok','picking','picked','reviewed']::app.deal_status[]);
  update app.deal_lines l set unit_price = coalesce(app.tier_price(l.product_id, d.customer_id, d.currency), l.unit_price)
  where l.deal_id = p_deal and l.id = any(p_line_ids) and not l.price_manual and l.product_id is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- 改价: 中方 only (admin). 标记 manual, 下推销售订单前需二次确认
create or replace function app.set_line_price(p_line uuid, p_price numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines;
begin
  select * into l from app.deal_lines where id = p_line;
  select * into d from app.deals where id = l.deal_id;
  perform app.require_role(d.org_id, 'admin');
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'VALIDATION: price change needs reason'; end if;
  d := app.lock_deal(d.id, array['quoted','hotline_ok','picking','picked','reviewed','ordered']::app.deal_status[]);
  update app.deal_lines set unit_price = p_price, price_manual = true, price_set_by = app.uid() where id = p_line;
  perform app.deal_event(d.id, 'price_set', jsonb_build_object('line', p_line, 'from', l.unit_price, 'to', p_price, 'reason', p_reason));
end $$;

-- ───────────────────────── 2. 热线初步确认 ─────────────────────────
create or replace function app.hotline_confirm(p_deal uuid, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  perform app.lock_deal(p_deal, array['quoted']::app.deal_status[]);
  update app.deals set status = 'hotline_ok', hotline_note = p_note where id = p_deal;
  perform app.deal_event(p_deal, 'hotline_confirmed', jsonb_build_object('note', p_note));
end $$;

-- ───────────────────────── 3. 下推找货单 → 预占 ─────────────────────────
-- Reserves min(需求, 可售) on each line's OWN stock row. Never fills the gap from another warehouse.
create or replace function app.start_picking(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l record; v_avail int; v_take int; v_short jsonb := '[]';
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok']::app.deal_status[]);
  for l in select dl.*, w.kind as wh_kind from app.deal_lines dl
           left join app.stock_items s on s.id = dl.stock_item_id
           left join app.warehouses w on w.id = s.warehouse_id
           where dl.deal_id = p_deal order by dl.seq loop
    if l.product_id is null or l.stock_item_id is null then
      v_short := v_short || jsonb_build_object('line', l.id, 'reason', 'no_stock_row', 'qty', l.qty_req);
      continue;
    end if;
    if (d.kind = 'fob' and l.wh_kind <> 'fob') or (d.kind <> 'fob' and l.wh_kind <> 'local') then
      raise exception 'WAREHOUSE_SCOPE: line % uses % warehouse', l.seq, l.wh_kind;
    end if;
    select qty_on_hand - qty_reserved into v_avail from app.stock_items where id = l.stock_item_id for update;
    v_take := least(l.qty_req, greatest(v_avail, 0));
    perform app.reserve(l.stock_item_id, v_take);
    update app.deal_lines set qty_supply = v_take where id = l.id;
    if v_take < l.qty_req then
      v_short := v_short || jsonb_build_object('line', l.id, 'reason', 'short', 'qty', l.qty_req - v_take);
    end if;
  end loop;
  update app.deals set status = 'picking', pick_no = app.next_doc_no(d.org_id, 'PK') where id = p_deal;
  perform app.deal_event(p_deal, 'picking_started', jsonb_build_object('short', v_short));
  return v_short;
end $$;

-- ───────────────────────── 4. 找货员提交 (实际供货 + 照片) ─────────────────────────
-- p_actual: [{line_id, qty, reason?}] ; qty ≤ reserved; difference needs reason; excess released
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
  update app.deals set status = 'picked', picker_employee_id = p_picker, pick_photo_path = p_photo where id = p_deal;
  perform app.deal_event(p_deal, 'pick_submitted', jsonb_build_object('picker', p_picker, 'changes', p_actual));
end $$;

-- ───────────────────────── 5. 主管复核 ─────────────────────────
create or replace function app.review_pick(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  perform app.lock_deal(p_deal, array['picked']::app.deal_status[]);
  update app.deals set status = 'reviewed', reviewed_by = app.uid(), reviewed_at = now() where id = p_deal;
  perform app.deal_event(p_deal, 'pick_reviewed');
end $$;

-- ───────────────────────── 6. 销售订单 (定价) ─────────────────────────
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
  if exists (select 1 from app.deal_lines where deal_id = p_deal and qty_supply > 0 and unit_price = 0) then
    raise exception 'VALIDATION: 有供货行未定价';
  end if;
  v_no := app.next_doc_no(d.org_id, 'SO');
  update app.deals set status = 'ordered', so_no = v_no where id = p_deal;
  perform app.deal_event(p_deal, 'sales_order_created', jsonb_build_object('so_no', v_no));
  return v_no;
end $$;

-- 出库前追加货 (客户临时加): reserves immediately, flagged, no restart of the whole flow
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
    status = case when status in ('ordered','confirmed') then 'reviewed'::app.deal_status else status end  -- 重新定价确认
  where id = p_deal;
  perform app.deal_event(p_deal, 'lines_added', jsonb_build_object('count', jsonb_array_length(p_lines)));
end $$;

-- ───────────────────────── 7. 客户最终确认 ─────────────────────────
create or replace function app.customer_confirm(p_deal uuid, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  perform app.lock_deal(p_deal, array['ordered']::app.deal_status[]);
  update app.deals set status = 'confirmed', confirm_note = p_note where id = p_deal;
  perform app.deal_event(p_deal, 'customer_confirmed', jsonb_build_object('note', p_note));
end $$;

-- ───────────────────────── 8. 出库 ─────────────────────────
-- p_items: [{line_id, qty}] ; omit → ship all remaining supply
create or replace function app.ship(p_deal uuid, p_shipped_at timestamptz, p_method app.ship_method,
                                    p_phone text, p_address text, p_proof text, p_items jsonb default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_ship uuid; v_no text; l app.deal_lines; v_qty int; v_amt numeric := 0; v_left int;
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
  if v_amt = 0 and not exists (select 1 from app.shipment_lines where shipment_id = v_ship) then
    raise exception 'VALIDATION: nothing to ship';
  end if;
  update app.shipments set amount = v_amt where id = v_ship;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id)
  values (d.org_id, d.customer_id, d.currency, 'shipment', v_amt, p_deal, v_ship);
  insert into app.kingdee_outbox (org_id, shipment_id) values (d.org_id, v_ship);
  select coalesce(sum(qty_supply - qty_shipped), 0) into v_left from app.deal_lines where deal_id = p_deal;
  update app.deals set status = case when v_left = 0 then 'shipped'::app.deal_status else 'partial'::app.deal_status end where id = p_deal;
  perform app.deal_event(p_deal, 'shipped', jsonb_build_object('out_no', v_no, 'amount', v_amt));
  return v_ship;
end $$;

create or replace function app.mark_received(p_shipment uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.shipments where id = p_shipment;
  perform app.require_role(v_org, 'hotline', 'manager');
  update app.shipments set customer_received_at = coalesce(customer_received_at, now()) where id = p_shipment;
  update app.kingdee_outbox set status = 'ready', updated_at = now() where shipment_id = p_shipment and status = 'await_receipt';
end $$;

-- ───────────────────────── 取消 (未出库) ─────────────────────────
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
  update app.deals set status = 'cancelled' where id = p_deal;
  perform app.deal_event(p_deal, 'cancelled', jsonb_build_object('reason', p_reason));
end $$;

-- ───────────────────────── 期初 (历史导入，作为一单) ─────────────────────────
create or replace function app.import_opening(p_customer uuid, p_currency text, p_amount numeric, p_note text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_deal uuid;
begin
  select * into c from app.customers where id = p_customer;
  perform app.require_role(c.org_id, 'admin', 'finance');
  insert into app.deals (org_id, kind, biz_no, customer_id, currency, status, note, created_by)
  values (c.org_id, 'opening', app.next_doc_no(c.org_id, 'OPEN'), p_customer, p_currency, 'shipped', coalesce(p_note,'历史导入'), app.uid())
  returning id into v_deal;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, note)
  values (c.org_id, p_customer, p_currency, 'opening', p_amount, v_deal, p_note);
  return v_deal;
end $$;

-- ───────────────────────── 9. 收款与冲账 ─────────────────────────
-- p_mode: oldest | specific (p_targets = [deal_id,...] in order) | manual (p_targets = [{deal_id, amount}]) | none (预付)
create or replace function app.allocate(p_receipt uuid, p_mode text, p_targets jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipts; v_left numeric; t record; v_take numeric; x jsonb;
begin
  select * into r from app.receipts where id = p_receipt for update;
  select unallocated into v_left from app.v_receipt_open where id = p_receipt;
  if p_mode = 'none' then return; end if;
  if p_mode = 'oldest' then
    for t in select deal_id, due from app.v_deal_due
             where customer_id = r.customer_id and currency = r.account_currency and due > 0 and status <> 'cancelled'
             order by coalesce(first_shipped_at, '-infinity'::timestamptz), deal_id loop
      exit when v_left <= 0;
      v_take := least(v_left, t.due);
      insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, t.deal_id, v_take);
      v_left := v_left - v_take;
    end loop;
  elsif p_mode = 'specific' then
    for x in select * from jsonb_array_elements(p_targets) loop
      exit when v_left <= 0;
      select due into v_take from app.v_deal_due where deal_id = (x#>>'{}')::uuid and customer_id = r.customer_id and currency = r.account_currency;
      v_take := least(v_left, greatest(coalesce(v_take,0),0));
      if v_take > 0 then
        insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, (x#>>'{}')::uuid, v_take);
        v_left := v_left - v_take;
      end if;
    end loop;
  elsif p_mode = 'manual' then
    for x in select * from jsonb_array_elements(p_targets) loop
      select due into v_take from app.v_deal_due where deal_id = (x->>'deal_id')::uuid and customer_id = r.customer_id and currency = r.account_currency;
      if (x->>'amount')::numeric > coalesce(v_take,0) then raise exception 'VALIDATION: 分配金额超过该单未收'; end if;
      if (x->>'amount')::numeric > v_left then raise exception 'VALIDATION: 分配总额超过收款'; end if;
      insert into app.receipt_allocations (receipt_id, deal_id, amount) values (p_receipt, (x->>'deal_id')::uuid, (x->>'amount')::numeric);
      v_left := v_left - (x->>'amount')::numeric;
    end loop;
  else raise exception 'VALIDATION: unknown mode %', p_mode;
  end if;
end $$;

create or replace function app.record_receipt(p_org uuid, p_customer uuid, p_received_on date, p_amount numeric,
  p_currency text, p_method app.pay_method, p_account_currency text default null, p_rate numeric default 1,
  p_mode text default 'oldest', p_targets jsonb default '[]', p_proof text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_acc text := coalesce(p_account_currency, p_currency); v_dec int;
begin
  perform app.require_role(p_org, 'finance');
  if v_acc = p_currency and p_rate <> 1 then raise exception 'VALIDATION: 同币种汇率必须为1'; end if;
  select decimals into v_dec from app.currencies where code = v_acc;
  insert into app.receipts (org_id, rcv_no, customer_id, received_on, amount, currency, account_currency, rate, converted,
                            method, proof_path, note, created_by)
  values (p_org, app.next_doc_no(p_org, 'RCV'), p_customer, p_received_on, p_amount, p_currency, v_acc, p_rate,
          round(p_amount * p_rate, v_dec), p_method, p_proof, p_note, app.uid())
  returning id into v_id;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, ref_id)
  select p_org, p_customer, v_acc, 'receipt', -converted, v_id from app.receipts where id = v_id;
  perform app.allocate(v_id, p_mode, p_targets);
  perform app.audit(p_org, 'receipt', 'receipts', v_id, jsonb_build_object('mode', p_mode));
  return v_id;
end $$;

-- 预付款/未分配款后续冲到订单
create or replace function app.apply_unallocated(p_receipt uuid, p_mode text default 'oldest', p_targets jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.receipts where id = p_receipt;
  perform app.require_role(v_org, 'finance');
  perform app.allocate(p_receipt, p_mode, p_targets);
end $$;

-- ───────────────────────── 10. 退货 ─────────────────────────
-- p_lines: [{line_id, qty}]  按原订单原行
create or replace function app.request_return(p_deal uuid, p_reason_type app.return_reason, p_reason text, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_id uuid; x jsonb; l app.deal_lines; v_pending int;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  if d.status not in ('partial','shipped') or d.kind <> 'normal' then raise exception 'BAD_STATE: 只能对已出库订单退货'; end if;
  insert into app.returns (org_id, rt_no, deal_id, customer_id, reason_type, reason, requested_by)
  values (d.org_id, app.next_doc_no(d.org_id,'RT'), p_deal, d.customer_id, p_reason_type, p_reason, app.uid()) returning id into v_id;
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
  perform app.deal_event(p_deal, 'return_requested', jsonb_build_object('return', v_id));
  return v_id;
end $$;

-- 中方审批: 货进待检仓, 应收冲减; 若该单已收款超过净额 → 多出的分配退回为预付款
create or replace function app.decide_return(p_return uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.returns; rl app.return_lines; l app.deal_lines; v_pending uuid; v_over numeric; a record; v_cut numeric;
begin
  select * into r from app.returns where id = p_return for update;
  perform app.require_role(r.org_id, 'admin');
  if r.status <> 'requested' then raise exception 'BAD_STATE: return already decided'; end if;
  if not p_approve then
    update app.returns set status = 'rejected', decided_by = app.uid(), decided_at = now() where id = p_return;
    return;
  end if;
  for rl in select * from app.return_lines where return_id = p_return loop
    select * into l from app.deal_lines where id = rl.deal_line_id for update;
    if rl.qty > l.qty_shipped - l.qty_returned then raise exception 'VALIDATION: 退货数量超过可退数量'; end if;
    update app.deal_lines set qty_returned = qty_returned + rl.qty where id = l.id;
    v_pending := app.stock_row(r.org_id, 'pending', l.product_id);
    perform app.move_stock(v_pending, rl.qty, 'return_in', 'return', p_return);
    update app.return_lines set pending_stock_item_id = v_pending where id = rl.id;
  end loop;
  update app.returns set status = 'approved', decided_by = app.uid(), decided_at = now() where id = p_return;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id)
  select r.org_id, r.customer_id, d.currency, 'return', -r.amount, r.deal_id, p_return from app.deals d where d.id = r.deal_id;
  -- release over-allocation (newest first) back to the receipt as 预付款
  select -due into v_over from app.v_deal_due where deal_id = r.deal_id;
  for a in select id, amount from app.receipt_allocations where deal_id = r.deal_id order by at desc, id desc loop
    exit when coalesce(v_over,0) <= 0;
    v_cut := least(a.amount, v_over);
    if v_cut = a.amount then delete from app.receipt_allocations where id = a.id;
    else update app.receipt_allocations set amount = amount - v_cut where id = a.id; end if;
    v_over := v_over - v_cut;
  end loop;
  perform app.deal_event(r.deal_id, 'return_approved', jsonb_build_object('return', p_return, 'amount', r.amount));
end $$;

-- 检验: 好货回原仓, 坏货报废
create or replace function app.inspect_return_line(p_return_line uuid, p_good int, p_scrap int)
returns void language plpgsql security definer set search_path = app, public as $$
declare rl app.return_lines; r app.returns; l app.deal_lines; v_scrap uuid;
begin
  select * into rl from app.return_lines where id = p_return_line for update;
  select * into r from app.returns where id = rl.return_id;
  perform app.require_role(r.org_id, 'manager');
  if r.status <> 'approved' then raise exception 'BAD_STATE: return not approved'; end if;
  if p_good < 0 or p_scrap < 0 or rl.qty_good + rl.qty_scrap + p_good + p_scrap > rl.qty then
    raise exception 'VALIDATION: 检验数量超过退货数量';
  end if;
  select * into l from app.deal_lines where id = rl.deal_line_id;
  if p_good > 0 then
    perform app.move_stock(rl.pending_stock_item_id, -p_good, 'inspect_good', 'return', r.id);
    perform app.move_stock(l.stock_item_id, p_good, 'inspect_good', 'return', r.id);
  end if;
  if p_scrap > 0 then
    v_scrap := app.stock_row(r.org_id, 'scrap', l.product_id);
    perform app.move_stock(rl.pending_stock_item_id, -p_scrap, 'inspect_scrap', 'return', r.id);
    perform app.move_stock(v_scrap, p_scrap, 'inspect_scrap', 'return', r.id);
  end if;
  update app.return_lines set qty_good = qty_good + p_good, qty_scrap = qty_scrap + p_scrap where id = rl.id;
end $$;
