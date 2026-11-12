-- 0042 (Frank 11-11 23:08, 待改 238): 拆单 —— 客户确认报价后, 事先就知道要分开发的 (急的先发 / 约了不同日期),
-- 把「以后再发」的型号拆成另一张单: 各有各的销售单、各自签收; 拆出去的行锁定拆单时的价格 (只有中方能再改)
alter table app.deals add column split_from uuid references app.deals(id);
alter table app.deal_lines add column price_locked boolean not null default false;

create or replace function app.split_deal(p_deal uuid, p_lines uuid[], p_want_on date default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; n_all int; n_move int; v_new uuid := gen_random_uuid(); v_no text;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales_manager');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok']::app.deal_status[]);
  if d.approval = 'pending' then raise exception 'BAD_STATE: 这张单还在等中方审批，批完再拆'; end if;
  select count(*) into n_all from app.deal_lines where deal_id = p_deal;
  select count(*) into n_move from app.deal_lines where deal_id = p_deal and id = any(coalesce(p_lines, '{}'));
  if n_move = 0 then raise exception 'VALIDATION: 先勾选要拆出去的型号'; end if;
  if n_move >= n_all then raise exception 'VALIDATION: 不能全部拆走，原单至少留一行'; end if;
  if p_want_on is not null and p_want_on < current_date then raise exception 'VALIDATION: 发货日期不能是过去'; end if;
  v_no := app.next_doc_no(d.org_id, 'BIZ');
  insert into app.deals select (jsonb_populate_record(null::app.deals, to_jsonb(d) || jsonb_build_object(
    'id', v_new, 'biz_no', v_no, 'quote_no', app.next_doc_no(d.org_id, 'QT'), 'split_from', d.id, 'want_on', p_want_on,
    'created_by', app.uid(), 'created_at', now(), 'updated_at', now(), 'version', 1, 'urgent', false,
    'note', nullif(trim(coalesce(p_note, '')), '')))).*;
  update app.deal_lines set deal_id = v_new, price_locked = true where deal_id = p_deal and id = any(p_lines);
  update app.deal_lines l set seq = x.rn from (select id, row_number() over (partition by deal_id order by seq) as rn from app.deal_lines where deal_id in (p_deal, v_new)) x where x.id = l.id and l.seq <> x.rn;
  update app.deals set version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'deal_split', jsonb_build_object('to', v_new, 'to_no', v_no, 'lines', n_move, 'want_on', p_want_on, 'note', p_note));
  perform app.deal_event(v_new, 'split_created', jsonb_build_object('from', p_deal, 'from_no', d.biz_no, 'lines', n_move, 'want_on', p_want_on, 'note', p_note));
  return v_new;
end $$;
revoke all on function app.split_deal(uuid, uuid[], date, text) from public;
grant execute on function app.split_deal(uuid, uuid[], date, text) to authenticated;

-- 锁价: 拆出去的行, 不是中方就改不了单价 (批量「获取价格」、重算汇率都跳过它)
create or replace function app.guard_locked_price() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  if old.price_locked and new.unit_price is distinct from old.unit_price then
    select org_id into v_org from app.deals where id = new.deal_id;
    if not app.has_role(v_org, array['admin']::app.role_name[]) then new.unit_price := old.unit_price; new.price_manual := old.price_manual; end if;
  end if;
  return new;
end $$;
create trigger guard_locked_price before update of unit_price on app.deal_lines for each row execute function app.guard_locked_price();

-- 出库步「只发一部分」: 必须写原因 (车装不下 / 货没齐 / 客户只要先拿一部分…), 记在这一批出库单上
alter table app.shipments add column partial_reason text;
create or replace function app.set_partial_reason(p_shipment uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; v_org uuid;
begin
  select * into s from app.shipments where id = p_shipment;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  select org_id into v_org from app.deals where id = s.deal_id;
  perform app.require_role(v_org, 'manager', 'picker', 'sales_manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 只发一部分要写原因'; end if;
  update app.shipments set partial_reason = trim(p_reason) where id = p_shipment;
  perform app.deal_event(s.deal_id, 'partial_reason', jsonb_build_object('reason', trim(p_reason), 'shipment', p_shipment));
end $$;
revoke all on function app.set_partial_reason(uuid, text) from public;
grant execute on function app.set_partial_reason(uuid, text) to authenticated;
