-- 0057 审批三种结果 (Frank 11-17, 待改 345 / 338): 中方批单时三选一
--   pass       直接放行 (和原来一样)
--   pick_only  先找货、不出库: 单子照常往下走到复检, 但出库被卡住, 中方「放行出库」后才能发 (典型: 客户说先备货, 钱到了再发)
--   no_pick    不找货、先放着: 审批保持「等中方批」, 记下暂缓原因, 单子留在报价; 之后中方再批 / 不批
alter table app.deals add column ship_hold boolean not null default false, add column ship_hold_note text, add column ship_hold_by uuid, add column ship_hold_at timestamptz,
  add column ship_released_at timestamptz, add column ship_released_by uuid, add column approval_hold_note text, add column approval_hold_at timestamptz;

create or replace function app.approve_quote_mode(p_deal uuid, p_mode text, p_note text, p_prices jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if p_mode not in ('pass','pick_only','no_pick') then raise exception 'VALIDATION: 审批结果不对'; end if;
  if p_mode <> 'pass' and coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 这种批法要写说明（等什么、什么时候再看）'; end if;
  if p_mode = 'no_pick' then
    update app.deals set approval_hold_note = trim(p_note), approval_hold_at = now() where id = p_deal;
    perform app.deal_event(p_deal, 'approval_held', jsonb_build_object('note', p_note));
    return;
  end if;
  perform app.approve_quote(p_deal, true, p_note, coalesce(p_prices, '[]'));
  update app.deals set approval_hold_note = null, approval_hold_at = null,
    ship_hold = (p_mode = 'pick_only'), ship_hold_note = case when p_mode = 'pick_only' then trim(p_note) end,
    ship_hold_by = case when p_mode = 'pick_only' then app.uid() end, ship_hold_at = case when p_mode = 'pick_only' then now() end,
    ship_released_at = null, ship_released_by = null where id = p_deal;
  if p_mode = 'pick_only' then perform app.deal_event(p_deal, 'ship_hold_set', jsonb_build_object('note', p_note)); end if;
end $$;

-- 任何时候中方都可以给一张没出完库的单加「先别出库」/ 放行
create or replace function app.set_ship_hold(p_deal uuid, p_hold boolean, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 要写原因'; end if;
  if d.status in ('shipped','cancelled') then raise exception 'BAD_STATE: 这张单已经出完库或已作废'; end if;
  if p_hold then
    update app.deals set ship_hold = true, ship_hold_note = trim(p_note), ship_hold_by = app.uid(), ship_hold_at = now(), ship_released_at = null, ship_released_by = null where id = p_deal;
    perform app.deal_event(p_deal, 'ship_hold_set', jsonb_build_object('note', p_note));
  else
    if not d.ship_hold then raise exception 'VALIDATION: 这张单没有被卡出库'; end if;
    update app.deals set ship_hold = false, ship_released_at = now(), ship_released_by = app.uid() where id = p_deal;
    perform app.deal_event(p_deal, 'ship_hold_released', jsonb_build_object('note', p_note));
  end if;
end $$;

create or replace function app.trg_ship_hold() returns trigger language plpgsql security definer set search_path = app, public as $$
declare n text;
begin
  select ship_hold_note into n from app.deals where id = new.deal_id and ship_hold;
  if found then raise exception 'SHIP_HOLD: 中方批的是「先找货、不出库」（%）。要出库先让中方放行', coalesce(n, ''); end if;
  return new;
end $$;
create trigger ship_hold_gate before insert on app.shipments for each row execute function app.trg_ship_hold();

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.approve_quote_mode(uuid, text, text, jsonb), app.set_ship_hold(uuid, boolean, text) to authenticated;
  end if;
end $$;
