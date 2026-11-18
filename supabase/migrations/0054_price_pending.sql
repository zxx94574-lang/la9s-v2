-- 0054 先出库、价格以后再定 (Frank Q8③, 11-16 / 11-17): 很少用, 必须是急单; 只中方能批; 批了才能在价格没谈定时出库;
-- 出库照常记应收 (按当时单上的价), 从出库起进中方紧急待办; 签收照常确认数量; **价格没定之前不能确认对账**;
-- 定价 = 中方填最终单价 + 客户同意的截图 → 差额记一笔价格调整进客户账, 没发完的行以后按新价出.

alter table app.deals add column price_pending boolean not null default false, add column price_pending_note text, add column price_pending_by uuid, add column price_pending_at timestamptz,
  add column price_settled_at timestamptz, add column price_settled_by uuid;

create or replace function app.allow_ship_unpriced(p_deal uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 要写为什么急着先发（价格以后再定是特例）'; end if;
  if d.status in ('shipped','cancelled') then raise exception 'BAD_STATE: 这张单已经出完库或已作废'; end if;
  update app.deals set price_pending = true, price_pending_note = p_note, price_pending_by = app.uid(), price_pending_at = now(), price_settled_at = null, price_settled_by = null where id = p_deal;
  perform app.deal_event(p_deal, 'price_pending_allowed', jsonb_build_object('note', p_note));
end $$;

create or replace function app.cancel_price_pending(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if exists (select 1 from app.shipments s where s.deal_id = p_deal and s.voided_at is null) then raise exception 'BAD_STATE: 已经出过库了，只能定价，不能取消'; end if;
  update app.deals set price_pending = false, price_pending_note = null, price_pending_by = null, price_pending_at = null where id = p_deal;
  perform app.deal_event(p_deal, 'price_pending_cancelled', '{}'::jsonb);
end $$;

-- 定价: p_lines = [{line_id, price}] (没列的行价格不变)
create or replace function app.settle_pending_price(p_deal uuid, p_lines jsonb, p_note text, p_proof text)
returns numeric language plpgsql security definer set search_path = app, public as $$
declare d app.deals; x jsonb; l app.deal_lines; v_delta numeric := 0; v_id uuid; v_new numeric;
begin
  select * into d from app.deals where id = p_deal for update;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if not d.price_pending then raise exception 'VALIDATION: 这张单不是「价格待定」'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 写一句怎么谈定的'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传客户同意价格的截图'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    select * into l from app.deal_lines where id = (x->>'line_id')::uuid and deal_id = p_deal;
    if l.id is null then raise exception 'NOT_FOUND: 行不在这张单里'; end if;
    v_new := (x->>'price')::numeric;
    if v_new is null or v_new < 0 then raise exception 'VALIDATION: 价格不能为负'; end if;
    v_delta := v_delta + coalesce((select sum(sl.qty * (v_new - sl.unit_price)) from app.shipment_lines sl join app.shipments s on s.id = sl.shipment_id
                                   where sl.deal_line_id = l.id and s.voided_at is null), 0);
    update app.deal_lines set unit_price = v_new, price_manual = true, price_set_by = app.uid() where id = l.id;
  end loop;
  v_delta := round(v_delta, 2);
  update app.deals set price_pending = false, price_settled_at = now(), price_settled_by = app.uid() where id = p_deal;
  -- 定下来的价如果低于成本: 照样要先有亏本批准 (0051)
  perform app.loss_gate(p_deal);
  if v_delta <> 0 then
    insert into app.price_adjustments (org_id, deal_id, amount, reason, proof, created_by) values (d.org_id, p_deal, v_delta, '价格待定 → 定价：' || trim(p_note), p_proof, app.uid()) returning id into v_id;
    insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id, note)
    values (d.org_id, d.customer_id, d.currency, 'adjust', v_delta, p_deal, v_id, '价格待定 → 定价：' || trim(p_note));
  end if;
  perform app.deal_event(p_deal, 'price_settled', jsonb_build_object('delta', v_delta, 'note', p_note));
  return v_delta;
end $$;

-- 价格待定的单: 出库 / 往下走时不查「会亏」(价还没定), 定价那一刻再查
create or replace function app.loss_gate(p_deal uuid) returns void
language plpgsql security definer set search_path = app, public as $$
declare d app.deals; s text; n int;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null or d.kind <> 'normal' or d.price_pending or not app.loss_rule_on(d.org_id) then return; end if;
  s := app.deal_loss_sig(p_deal);
  if s is not null and s is distinct from d.loss_ok_sig then
    select count(*) into n from app.deal_loss_lines(p_deal);
    raise exception 'LOSS_BLOCK: 有 % 行的价格要中方批准才能往下走', n;
  end if;
end $$;

-- 价格没定不能确认对账
create or replace function app.trg_balance_needs_price() returns trigger language plpgsql as $$
begin
  if new.balance_confirmed_at is not null and new.balance_confirmed_at is distinct from old.balance_confirmed_at and new.price_pending then
    raise exception 'VALIDATION: 这张单价格还没定，先让中方定价，再和客户对账';
  end if;
  return new;
end $$;
create trigger balance_needs_price before update of balance_confirmed_at on app.deals for each row execute function app.trg_balance_needs_price();

do $$ begin
  revoke all on function app.loss_gate(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function app.loss_gate(uuid) from authenticated;
    grant execute on function app.allow_ship_unpriced(uuid, text), app.cancel_price_pending(uuid), app.settle_pending_price(uuid, jsonb, text, text) to authenticated;
  end if;
end $$;
