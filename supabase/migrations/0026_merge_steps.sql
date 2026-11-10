-- 0026 (11-08 23:55 Frank): 流程合并 ① 报价 + 热线确认 = 一步 (谁能建报价谁能确认, 仓库主管兼热线)  ② 找货单 + 初检 = 一步
-- 底层状态不变 (quoted → hotline_ok → picking → picked …), 只是: 确认能顺手下推找货; 下推找货的权限放宽到 热线 / 销售主管.
create or replace function app.start_picking(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l record; v_avail int; v_take int; v_short jsonb := '[]';
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager', 'hotline', 'sales_manager');
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

-- 确认 (热线 / 主管 / 销售主管 / 中方) ; p_push = 今天要 → 顺手预占下推找货
create or replace function app.quote_confirm(p_deal uuid, p_note text default null, p_method text default null, p_proof text default null, p_want_on date default null, p_push boolean default false)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales_manager');
  perform app.lock_deal(p_deal, array['quoted']::app.deal_status[]);
  if p_method is not null and p_method not in ('whatsapp','phone','in_store') then raise exception 'VALIDATION: 确认方式无效'; end if;
  update app.deals set status = 'hotline_ok', hotline_note = p_note, hotline_method = p_method, hotline_proof = p_proof, want_on = p_want_on,
    hotline_opened_at = coalesce(hotline_opened_at, now()) where id = p_deal;
  perform app.deal_event(p_deal, 'hotline_confirmed', jsonb_build_object('note', p_note, 'method', p_method, 'want_on', p_want_on));
  if p_push then return app.start_picking(p_deal); end if;
  return null;
end $$;
