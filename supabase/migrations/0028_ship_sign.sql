-- 0028 (11-09 Frank B 组): ① 复检打包 → 发货文件 → 出库 三块一步: BL 可在出库前按复检数量提前出号打印 (next_bl_no), 出库时落到出库单上
--                           ② 新增「签收 · 对账」步: 客户签收 = 签收时间 + 签收照片 (必填), 之后才算到收款
alter table app.deals add column next_bl_no text, add column next_bl_issued_at timestamptz;
alter table app.shipments add column received_by uuid;

create or replace function app.issue_bl_pending(p_deal uuid)
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals; c app.customers; v_short text; v_day text; v_seq int; v_no text;
begin
  select * into d from app.deals where id = p_deal for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'admin', 'manager', 'picker', 'sales', 'finance');
  if d.status not in ('reviewed','partial') then raise exception 'BAD_STATE: 复检打包完成后才能出 BL'; end if;
  if d.next_bl_no is not null then return d.next_bl_no; end if;
  select * into c from app.customers where id = d.customer_id;
  v_short := regexp_replace(upper(coalesce(c.name, 'CLI')), '[^A-Z0-9]', '', 'g');
  v_short := coalesce(nullif(left(v_short, 3), ''), 'CLI');
  v_day := to_char(now() at time zone 'Africa/Abidjan', 'DDMMYYYY');
  select (select count(*) from app.shipments s where s.org_id = d.org_id and s.bl_no like 'BL-' || v_day || '-' || v_short || '-%')
       + (select count(*) from app.deals x where x.org_id = d.org_id and x.next_bl_no like 'BL-' || v_day || '-' || v_short || '-%') + 1 into v_seq;
  v_no := 'BL-' || v_day || '-' || v_short || '-' || lpad(v_seq::text, 3, '0');
  update app.deals set next_bl_no = v_no, next_bl_issued_at = now() where id = p_deal;
  perform app.deal_event(p_deal, 'bl_issued', jsonb_build_object('bl_no', v_no));
  perform app.audit(d.org_id, 'issue_bl_pending', 'deals', p_deal, jsonb_build_object('bl_no', v_no));
  return v_no;
end $$;

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
  -- 0028: 复检后提前打印的 BL 编号 (next_bl_no) 落到这张出库单上
  if d.next_bl_no is not null then
    update app.shipments set bl_no = d.next_bl_no, bl_issued_at = coalesce(d.next_bl_issued_at, now()), bl_printed_at = d.next_bl_issued_at where id = v_ship;
    update app.deals set next_bl_no = null, next_bl_issued_at = null where id = p_deal;
  end if;
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

-- 签收 (第 18 条): 时间 + 照片必填; 签收后金蝶可补录
create or replace function app.sign_receipt(p_shipment uuid, p_photo text, p_at timestamptz default now())
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.shipments;
begin
  select * into s from app.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(s.org_id, 'hotline', 'manager', 'sales_manager', 'sales', 'finance', 'picker');
  if s.voided_at is not null then raise exception 'BAD_STATE: 这张出库单已撤销'; end if;
  if coalesce(p_photo,'') = '' and coalesce(s.signed_photo,'') = '' then raise exception 'VALIDATION: 签收要有照片（客户签字的 BL 或收货现场）'; end if;
  if p_at > now() + interval '1 hour' then raise exception 'VALIDATION: 签收时间不能在将来'; end if;
  update app.shipments set customer_received_at = coalesce(p_at, now()), received_by = app.uid(),
    signed_photo = coalesce(nullif(p_photo,''), signed_photo), signed_at = coalesce(signed_at, now()) where id = p_shipment;
  update app.kingdee_outbox set status = 'ready', updated_at = now() where shipment_id = p_shipment and status = 'await_receipt';
  perform app.deal_event(s.deal_id, 'customer_received', jsonb_build_object('shipment', p_shipment, 'out_no', s.out_no, 'at', p_at));
end $$;
