-- 0043 (Frank 11-12, 待改 273): 收货差异 = 每个机型只有一个「客户最终收到几片」
-- 同一批出库的同一个机型再报一次 = 在上一次认定的基础上【修正】, 账只动差额 (补扣 / 冲回), 每次修正另记一条、历史全留, 不覆盖
-- 以前: 每报一次独立一条各扣各的 → 同一机型报两次会重复扣账
alter table app.receipt_discrepancies add column corrects uuid references app.receipt_discrepancies(id);

-- 这批出库里某一行, 目前认定客户收到几片 (没报过 = 发了多少就是多少; 不认的不算)
create or replace function app.disc_received(p_shipment uuid, p_line uuid) returns int language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select (x->>'received')::int from app.receipt_discrepancies r, jsonb_array_elements(r.lines) x
      where r.shipment_id = p_shipment and r.status = 'decided' and r.decision in ('credit','reship') and (x->>'deal_line_id')::uuid = p_line
      order by r.decided_at desc limit 1),
    (select qty from app.shipment_lines where shipment_id = p_shipment and deal_line_id = p_line));
$$;
revoke all on function app.disc_received(uuid, uuid) from public;
grant execute on function app.disc_received(uuid, uuid) to authenticated;

create or replace function app.report_discrepancy(p_shipment uuid, p_kind text, p_lines jsonb, p_proof text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; d app.deals; x jsonb; sl record; v_out jsonb := '[]'; v_amt numeric := 0; v_id uuid; v_hours numeric; v_window numeric;
  v_base int; v_recv int; v_fix boolean := false; v_prev uuid;
begin
  select * into s from app.shipments where id = p_shipment;
  if s.id is null or s.voided_at is not null then raise exception 'NOT_FOUND: 出库单不存在'; end if;
  select * into d from app.deals where id = s.deal_id;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales', 'finance');
  if coalesce(p_kind, '') not in ('short','over','wrong','damaged') then raise exception 'VALIDATION: 选差异类型'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传客户给的凭证（开箱照片 / 视频截图 / 聊天截图）'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'VALIDATION: 填哪几个型号有差异、客户实际收到多少'; end if;
  if exists (select 1 from app.receipt_discrepancies where shipment_id = p_shipment and status = 'open') then
    raise exception 'BAD_STATE: 这批货还有一张差异没处理，先让中方处理完，再报新的'; end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    select sl2.qty, sl2.unit_price, coalesce(p.model, dl.req_model) as model, dl.id as line_id into sl
    from app.shipment_lines sl2 join app.deal_lines dl on dl.id = sl2.deal_line_id left join app.products p on p.id = dl.product_id
    where sl2.shipment_id = p_shipment and sl2.deal_line_id = (x->>'deal_line_id')::uuid;
    if sl.line_id is null then raise exception 'VALIDATION: 这一行不在这批出库里'; end if;
    v_recv := (x->>'received')::int;
    if v_recv < 0 then raise exception 'VALIDATION: 实收数量不对'; end if;
    v_base := app.disc_received(p_shipment, sl.line_id);
    if v_recv = v_base and (p_kind in ('short','over') or v_base <> sl.qty) then continue; end if;
    if v_base <> sl.qty then v_fix := true; end if;
    v_out := v_out || jsonb_build_object('deal_line_id', sl.line_id, 'model', sl.model, 'shipped', sl.qty, 'base', v_base, 'received', v_recv, 'unit_price', sl.unit_price);
    -- 钱只算「发了的数量以内」的差额: 上次认定 → 这次, 少了补扣 (正), 多了冲回 (负)
    v_amt := v_amt + (least(v_base, sl.qty) - least(v_recv, sl.qty)) * sl.unit_price;
  end loop;
  if jsonb_array_length(v_out) = 0 then raise exception 'VALIDATION: 和现在认定的收到数量一样，没有差异'; end if;
  if v_fix then
    -- 修正已经处理过的差异: 只有中方, 必须写原因
    perform app.require_role(d.org_id, 'admin');
    if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 修正已经处理过的差异，要写原因'; end if;
    select r.id into v_prev from app.receipt_discrepancies r where r.shipment_id = p_shipment and r.status = 'decided' and r.decision in ('credit','reship') order by r.decided_at desc limit 1;
  end if;
  v_window := coalesce((select (value->>'hours')::numeric from app.org_settings where org_id = d.org_id and key = 'discrepancy_window'), 24);
  v_hours := extract(epoch from (now() - coalesce(s.customer_received_at, now()))) / 3600;
  insert into app.receipt_discrepancies (org_id, deal_id, shipment_id, kind, lines, amount, proof, note, late, reported_by, corrects)
  values (d.org_id, d.id, p_shipment, p_kind, v_out, v_amt, p_proof, nullif(trim(coalesce(p_note, '')), ''), v_hours > v_window and not v_fix, app.uid(), v_prev) returning id into v_id;
  perform app.deal_event(d.id, case when v_fix then 'discrepancy_corrected' else 'receipt_discrepancy' end,
    jsonb_build_object('kind', p_kind, 'amount', v_amt, 'out_no', s.out_no, 'late', v_hours > v_window and not v_fix, 'lines', v_out, 'note', p_note));
  return v_id;
end $$;

create or replace function app.decide_discrepancy(p_id uuid, p_decision text, p_fault text, p_goods_where text, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.receipt_discrepancies; d app.deals; x jsonb; v_stock uuid; v_qty int; v_prev_where text;
begin
  select * into r from app.receipt_discrepancies where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if r.status <> 'open' then raise exception 'BAD_STATE: 这张差异单已经处理过了'; end if;
  if coalesce(p_decision, '') not in ('credit','reship','reject') then raise exception 'VALIDATION: 选怎么处理'; end if;
  if coalesce(trim(p_fault), '') = '' then raise exception 'VALIDATION: 必须写清楚是哪个环节 / 谁的问题'; end if;
  if coalesce(p_goods_where, '') not in ('in_warehouse','lost','with_customer','unknown') then raise exception 'VALIDATION: 选货现在在哪'; end if;
  if p_decision = 'reject' and coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 不认要写原因'; end if;
  if r.corrects is not null and p_decision = 'reship' then raise exception 'VALIDATION: 修正只能选「认」或「不认」'; end if;
  select * into d from app.deals where id = r.deal_id;
  if p_decision = 'credit' and r.amount <> 0 then
    insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id, note)
    values (r.org_id, d.customer_id, d.currency, 'writeoff', -r.amount, d.id, r.id,
            case when r.corrects is null then '收货差异调整' when r.amount > 0 then '收货差异修正：补扣' else '收货差异修正：冲回' end);
  end if;
  if p_decision in ('credit','reship') then
    select goods_where into v_prev_where from app.receipt_discrepancies where id = r.corrects;
    for x in select * from jsonb_array_elements(r.lines) loop
      v_qty := least(coalesce((x->>'base')::int, (x->>'shipped')::int), (x->>'shipped')::int) - least((x->>'received')::int, (x->>'shipped')::int);
      select stock_item_id into v_stock from app.deal_lines where id = (x->>'deal_line_id')::uuid;
      if v_stock is null or v_qty = 0 then continue; end if;
      -- 少了、货其实还在仓库 → 库存加回来; 后来发现客户其实收到了、而上次把货加回过仓库 → 再减掉
      if v_qty > 0 and p_goods_where = 'in_warehouse' then perform app.move_stock(v_stock, v_qty, 'discrepancy_back', 'discrepancy', r.id);
      elsif v_qty < 0 and v_prev_where = 'in_warehouse' then perform app.move_stock(v_stock, v_qty, 'discrepancy_fix', 'discrepancy', r.id); end if;
    end loop;
  end if;
  update app.receipt_discrepancies set status = 'decided', decision = p_decision, fault = trim(p_fault), goods_where = p_goods_where,
    decide_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = app.uid(), decided_at = now() where id = p_id;
  perform app.deal_event(r.deal_id, 'discrepancy_decided', jsonb_build_object('decision', p_decision, 'amount', r.amount, 'fault', trim(p_fault),
    'goods_where', p_goods_where, 'note', p_note, 'lines', r.lines, 'correction', r.corrects is not null));
end $$;
