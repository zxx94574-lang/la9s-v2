-- 0053 整单折扣 (Frank 11-17, 待改 357, 取代 308 的「单独一行折扣」)
-- 中方和客户谈好一个总价 → 折扣按金额比例摊进每个型号的单价 (单价向上取整), 取整多出来的零头在第一次出库时自动记一笔抹零,
-- 客户应收正好 = 谈好的总价. 之后照常走异价 / 会亏检查; 金蝶直接用折后单价. 「上次成交价」不取打过整单折扣的单.
-- 零头怎么处理是 Claude 按建议定的 (Frank 11-18 00:38:「不确定的按你的建议」).

alter table app.deals add column discount_amount numeric(18,2), add column discount_target numeric(18,2), add column discount_round numeric(18,2),
  add column discount_note text, add column discount_by uuid, add column discount_at timestamptz, add column discount_round_done boolean not null default false;
alter table app.deal_lines add column pre_discount_price numeric(18,2);

create or replace function app.apply_deal_discount(p_deal uuid, p_target numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_total numeric; v_new numeric; v_unit numeric;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 整单折扣要写原因'; end if;
  d := app.lock_deal(d.id, array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed']::app.deal_status[]);
  if d.discount_amount is not null then raise exception 'VALIDATION: 这张单已经打过整单折扣；要重打先撤销上一次'; end if;
  select coalesce(sum((case when qty_supply > 0 then qty_supply else qty_req end) * unit_price), 0) into v_total from app.deal_lines where deal_id = p_deal and coalesce(unit_price, 0) > 0;
  if v_total <= 0 then raise exception 'VALIDATION: 这张单还没有价格'; end if;
  if coalesce(p_target, 0) <= 0 or p_target >= v_total then raise exception 'VALIDATION: 谈好的总价要大于 0、小于现在的总价（%）', v_total; end if;
  v_unit := case when d.currency = 'XOF' then 1 else 0.01 end;
  update app.deal_lines set pre_discount_price = unit_price,
    unit_price = ceil(unit_price * p_target / v_total / v_unit) * v_unit, price_manual = true, price_set_by = app.uid(),
    review_changed = d.status in ('confirmed','reviewed')
  where deal_id = p_deal and coalesce(unit_price, 0) > 0;
  select sum((case when qty_supply > 0 then qty_supply else qty_req end) * unit_price) into v_new from app.deal_lines where deal_id = p_deal and coalesce(unit_price, 0) > 0;
  update app.deals set discount_amount = v_total - p_target, discount_target = p_target, discount_round = v_new - p_target, discount_note = p_note,
    discount_by = app.uid(), discount_at = now(), discount_round_done = false,
    status = case when d.status in ('confirmed','reviewed') then 'ordered'::app.deal_status else status end,
    confirm_proof = case when d.status in ('confirmed','reviewed') then null else confirm_proof end
  where id = p_deal;
  perform app.deal_event(p_deal, 'deal_discount', jsonb_build_object('from', v_total, 'to', p_target, 'discount', v_total - p_target, 'round', v_new - p_target, 'note', p_note));
  return jsonb_build_object('from', v_total, 'target', p_target, 'lines_total', v_new, 'round', v_new - p_target);
end $$;

create or replace function app.undo_deal_discount(p_deal uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if d.discount_amount is null then raise exception 'VALIDATION: 这张单没有整单折扣'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 撤销折扣要写原因'; end if;
  d := app.lock_deal(d.id, array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed']::app.deal_status[]);
  update app.deal_lines set unit_price = pre_discount_price, pre_discount_price = null, review_changed = d.status in ('confirmed','reviewed')
  where deal_id = p_deal and pre_discount_price is not null;
  update app.deals set discount_amount = null, discount_target = null, discount_round = null, discount_note = null, discount_by = null, discount_at = null,
    status = case when d.status in ('confirmed','reviewed') then 'ordered'::app.deal_status else status end,
    confirm_proof = case when d.status in ('confirmed','reviewed') then null else confirm_proof end
  where id = p_deal;
  perform app.deal_event(p_deal, 'deal_discount_undone', jsonb_build_object('note', p_note));
end $$;

-- 第一次出库记应收时, 把取整多出来的零头抹掉 (一张单只抹一次)
create or replace function app.trg_discount_round() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  if new.kind <> 'shipment' or new.deal_id is null then return null; end if;
  select * into d from app.deals where id = new.deal_id;
  if coalesce(d.discount_round, 0) > 0 and not d.discount_round_done and d.discount_round <= new.amount then
    update app.deals set discount_round_done = true where id = d.id;
    insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, note)
    values (d.org_id, d.customer_id, d.currency, 'writeoff', -d.discount_round, d.id, '整单折扣取整零头');
  end if;
  return null;
end $$;
create trigger discount_round after insert on app.ar_entries for each row execute function app.trg_discount_round();

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.apply_deal_discount(uuid, numeric, text), app.undo_deal_discount(uuid, text) to authenticated;
  end if;
end $$;
