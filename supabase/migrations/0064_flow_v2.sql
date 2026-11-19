-- 0064 (Frank 11-18 396–398 / 406 / 410): 流程第二版
-- ① 初检一提交, 销售订单自动生成 (去掉「生成销售订单」按钮); 原来挂在那一步的把关挪到「客户确认」拦.
-- ② 主管派人找货 + 随时改派; 找货打勾进度存库 (改派后新的人接着找); 被派的人 (仓管 / 销售都行) 自己提交.
-- ③ 拆单能按数量拆 (这次发 50、以后发 50).
-- ④ 客户联系人小表: 身份 + 名字 + 电话, 可加可改可停用; 出库 / 签收填过的人自动进表.

-- ───────────────────────── ① 销售订单自动生成 ─────────────────────────
create or replace function app.trg_auto_sales_order() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_no text;
begin
  if new.status = 'picked' and old.status = 'picking' then
    v_no := coalesce(new.so_no, app.next_doc_no(new.org_id, 'SO'));
    update app.deals set status = 'ordered', so_no = v_no where id = new.id;
    perform app.deal_event(new.id, 'sales_order_created', jsonb_build_object('so_no', (select so_no from app.deals where id = new.id), 'auto', true));
  end if;
  return null;
end $$;
create trigger auto_sales_order after update of status on app.deals for each row execute function app.trg_auto_sales_order();

-- 原来「生成销售订单」时查的: 有供货的行单价不能是 0 (赠品 / 样品要中方改价并注明) → 现在客户确认时查
create or replace function app.trg_confirm_price_check() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if old.status = 'ordered' and new.status in ('confirmed', 'reviewed') and exists
     (select 1 from app.deal_lines where deal_id = new.id and qty_supply > 0 and unit_price = 0 and not price_manual) then
    raise exception 'VALIDATION: 有供货行单价为 0（如是赠品 / 样品，请中方改价并注明原因），定好价才能让客户确认';
  end if;
  return new;
end $$;
create trigger confirm_price_check before update of status on app.deals for each row execute function app.trg_confirm_price_check();

-- 老入口保留: 已经自动生成过的直接返回单号 (不报错); 还停在「待出销售订单」的老单照旧能手动生成
create or replace function app.create_sales_order(p_deal uuid, p_confirm_manual_prices boolean default false)
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_no text;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager');
  if d.status = 'ordered' and d.so_no is not null then return d.so_no; end if;
  d := app.lock_deal(p_deal, array['picked']::app.deal_status[]);
  if exists (select 1 from app.deal_lines where deal_id = p_deal and qty_supply > 0 and unit_price = 0 and not price_manual) then
    raise exception 'VALIDATION: 有供货行单价为 0（如是赠品/样品，请中方改价并注明原因）';
  end if;
  v_no := coalesce(d.so_no, app.next_doc_no(d.org_id, 'SO'));
  update app.deals set status = 'ordered', so_no = v_no where id = p_deal;
  perform app.deal_event(p_deal, 'sales_order_created', jsonb_build_object('so_no', v_no));
  return v_no;
end $$;

-- ───────────────────────── ② 派人找货 / 改派 / 打勾 ─────────────────────────
alter table app.deals add column pick_assignee_employee_id uuid references app.employees(id), add column pick_assigned_by uuid, add column pick_assigned_at timestamptz;
alter table app.deal_lines add column pick_tick_qty int, add column pick_tick_reason text, add column pick_tick_at timestamptz, add column pick_tick_by uuid;

create or replace function app.assign_picker(p_deal uuid, p_employee uuid, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_old uuid;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'manager', 'sales_manager');
  if d.status <> 'picking' then raise exception 'BAD_STATE: 只有「找货中」的单能派人 / 改派'; end if;
  if p_employee is null or not exists (select 1 from app.employees where id = p_employee and org_id = d.org_id and active) then raise exception 'VALIDATION: 选一个在职员工去找货'; end if;
  v_old := d.pick_assignee_employee_id;
  update app.deals set pick_assignee_employee_id = p_employee, pick_assigned_by = app.uid(), pick_assigned_at = now() where id = p_deal;
  perform app.deal_event(p_deal, case when v_old is null then 'picker_assigned' else 'picker_reassigned' end,
    jsonb_build_object('from', v_old, 'to', p_employee, 'to_name', (select short_name from app.employees where id = p_employee), 'from_name', (select short_name from app.employees where id = v_old), 'note', nullif(trim(coalesce(p_note, '')), '')));
end $$;

-- 谁能找这张单: 中方 / 主管 / 销售主管随时; 仓管 / 销售 = 被派的那个人 (账号没挂员工档案的演示账号不卡)
create or replace function app.can_pick(d app.deals) returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare me uuid := app.current_employee(d.org_id);
begin
  if app.has_role(d.org_id, array['admin','manager','sales_manager']::app.role_name[]) then return true; end if;
  if not app.has_role(d.org_id, array['picker','sales','hotline']::app.role_name[]) then return false; end if;
  return d.pick_assignee_employee_id is null or me is null or me = d.pick_assignee_employee_id;
end $$;

-- 打勾 / 取消打勾: p_qty = 找到几片 (null = 取消); 少于要的必须写原因
create or replace function app.pick_tick(p_line uuid, p_qty int, p_reason text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare l app.deal_lines; d app.deals;
begin
  select * into l from app.deal_lines where id = p_line;
  if l.id is null then raise exception 'NOT_FOUND: 这一行不存在'; end if;
  select * into d from app.deals where id = l.deal_id;
  if d.status <> 'picking' then raise exception 'BAD_STATE: 这张单不在找货中'; end if;
  if not app.can_pick(d) then raise exception 'PERMISSION_DENIED: 这张找货单派给了别人'; end if;
  if p_qty is not null then
    if p_qty < 0 or p_qty > l.qty_supply then raise exception 'VALIDATION: 找到的数量要在 0 – % 之间，加货请走追加', l.qty_supply; end if;
    if p_qty < l.qty_supply and coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 找到的比要的少，选原因'; end if;
  end if;
  update app.deal_lines set pick_tick_qty = p_qty, pick_tick_reason = case when p_qty is null or p_qty >= l.qty_supply then null else trim(p_reason) end,
    pick_tick_at = case when p_qty is null then null else now() end, pick_tick_by = case when p_qty is null then null else app.uid() end where id = p_line;
end $$;

-- 提交找货 (打勾版): 全部有库存的行都打过勾 + 现场照片; 数量按打勾时填的; 提交后销售订单自动生成 (①)
create or replace function app.submit_pick_ticks(p_deal uuid, p_photo text, p_picker uuid default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l app.deal_lines; v_picker uuid; n_left int;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  if not app.can_pick(d) then raise exception 'PERMISSION_DENIED: 这张找货单派给了别人'; end if;
  d := app.lock_deal(p_deal, array['picking']::app.deal_status[]);
  v_picker := coalesce(p_picker, d.pick_assignee_employee_id, app.current_employee(d.org_id));
  if v_picker is null then raise exception 'VALIDATION: 找货人必选'; end if;
  if coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 找货照片必传'; end if;
  select count(*) into n_left from app.deal_lines where deal_id = p_deal and qty_supply > 0 and pick_tick_qty is null;
  if n_left > 0 then raise exception 'VALIDATION: 还有 % 行没打勾', n_left; end if;
  for l in select * from app.deal_lines where deal_id = p_deal and qty_supply > 0 and pick_tick_qty < qty_supply for update loop
    perform app.reserve(l.stock_item_id, l.pick_tick_qty - l.qty_supply);
    update app.deal_lines set qty_supply = l.pick_tick_qty, diff_reason = l.pick_tick_reason where id = l.id;
  end loop;
  update app.deal_lines set qty_picked = qty_supply where deal_id = p_deal;
  update app.deals set status = 'picked', picker_employee_id = v_picker, pick_photo_path = p_photo where id = p_deal;
  perform app.deal_event(p_deal, 'pick_submitted', jsonb_build_object('picker', v_picker, 'ticks', true,
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('line_id', id, 'qty', qty_supply, 'reason', diff_reason)), '[]') from app.deal_lines where deal_id = p_deal and pick_tick_reason is not null)));
end $$;

-- 撤回 / 重新找货时把打勾清掉
create or replace function app.trg_clear_ticks() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status = 'picking' and old.status <> 'picking' then
    update app.deal_lines set pick_tick_qty = null, pick_tick_reason = null, pick_tick_at = null, pick_tick_by = null where deal_id = new.id;
  end if;
  return null;
end $$;
create trigger clear_ticks after update of status on app.deals for each row execute function app.trg_clear_ticks();

-- ───────────────────────── ③ 拆单按数量 ─────────────────────────
-- p_lines: [{ line_id, qty }]; qty = 这一行以后发几片 (填满 = 整行拆走)
create or replace function app.split_deal_qty(p_deal uuid, p_lines jsonb, p_want_on date default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; x jsonb; l app.deal_lines; q int; v_new uuid := gen_random_uuid(); v_no text; n_move int := 0; n_keep int;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales_manager', 'sales');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok']::app.deal_status[]);
  if d.approval = 'pending' then raise exception 'BAD_STATE: 这张单还在等中方审批，批完再拆'; end if;
  if p_want_on is not null and p_want_on < current_date then raise exception 'VALIDATION: 发货日期不能是过去'; end if;
  v_no := app.next_doc_no(d.org_id, 'BIZ');
  insert into app.deals select (jsonb_populate_record(null::app.deals, to_jsonb(d) || jsonb_build_object(
    'id', v_new, 'biz_no', v_no, 'quote_no', app.next_doc_no(d.org_id, 'QT'), 'split_from', d.id, 'want_on', p_want_on,
    'created_by', app.uid(), 'created_at', now(), 'updated_at', now(), 'version', 1, 'urgent', false,
    'note', nullif(trim(coalesce(p_note, '')), '')))).*;
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    q := coalesce((x->>'qty')::int, 0);
    if q <= 0 then continue; end if;
    select * into l from app.deal_lines where id = (x->>'line_id')::uuid and deal_id = p_deal for update;
    if not found then raise exception 'NOT_FOUND: line'; end if;
    if q > l.qty_req then raise exception 'VALIDATION: 以后发的数量不能比这一行要的还多'; end if;
    if q = l.qty_req then
      update app.deal_lines set deal_id = v_new, price_locked = true where id = l.id;
    else
      update app.deal_lines set qty_req = qty_req - q where id = l.id;
      insert into app.deal_lines select (jsonb_populate_record(null::app.deal_lines, to_jsonb(l) || jsonb_build_object(
        'id', gen_random_uuid(), 'deal_id', v_new, 'qty_req', q, 'qty_supply', 0, 'qty_shipped', 0, 'qty_returned', 0, 'price_locked', true))).*;
    end if;
    n_move := n_move + 1;
  end loop;
  if n_move = 0 then raise exception 'VALIDATION: 先填哪几个型号以后发、发几片'; end if;
  select count(*) into n_keep from app.deal_lines where deal_id = p_deal;
  if n_keep = 0 then raise exception 'VALIDATION: 不能全部拆走，原单至少留一行'; end if;
  update app.deal_lines l2 set seq = y.rn from (select id, row_number() over (partition by deal_id order by seq) as rn from app.deal_lines where deal_id in (p_deal, v_new)) y where y.id = l2.id and l2.seq <> y.rn;
  update app.deals set version = version + 1 where id = p_deal;
  perform app.deal_event(p_deal, 'deal_split', jsonb_build_object('to', v_new, 'to_no', v_no, 'lines', n_move, 'want_on', p_want_on, 'note', p_note));
  perform app.deal_event(v_new, 'split_created', jsonb_build_object('from', p_deal, 'from_no', d.biz_no, 'lines', n_move, 'want_on', p_want_on, 'note', p_note));
  return v_new;
end $$;

-- ───────────────────────── ④ 客户联系人 ─────────────────────────
-- contacts: [{ id, role, name, phone, off?, added_at }]. p.id 给了 = 改那一个; 没给 = 加 (同名同电话的不重复加)
create or replace function app.save_customer_contact(p_customer uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_phone text := regexp_replace(coalesce(p->>'phone', ''), '\s', '', 'g'); v_name text := trim(coalesce(p->>'name', ''));
  v_role text := coalesce(nullif(trim(p->>'role'), ''), 'other'); v_id text := nullif(p->>'id', ''); v_list jsonb; v_hit boolean := false;
begin
  select * into c from app.customers where id = p_customer for update;
  if c.id is null then raise exception 'NOT_FOUND: 客户不存在'; end if;
  if not app.is_member(c.org_id) or app.has_role(c.org_id, array['boss','clerk','viewer']::app.role_name[]) then raise exception 'PERMISSION_DENIED: 不能改这个客户的联系人'; end if;
  if v_name = '' then raise exception 'VALIDATION: 联系人要写名字'; end if;
  -- 老数据没有 id 的先补上
  select coalesce(jsonb_agg(case when e ? 'id' then e else e || jsonb_build_object('id', gen_random_uuid()) end), '[]') into v_list from jsonb_array_elements(c.contacts) e;
  if v_id is not null then
    select coalesce(jsonb_agg(case when e->>'id' = v_id then e || jsonb_build_object('name', v_name, 'phone', v_phone, 'role', v_role, 'off', coalesce((p->>'off')::boolean, false)) else e end), '[]') into v_list from jsonb_array_elements(v_list) e;
  else
    select exists (select 1 from jsonb_array_elements(v_list) e where lower(e->>'name') = lower(v_name) and coalesce(e->>'phone', '') = v_phone) into v_hit;
    if not v_hit and v_phone <> '' then
      select exists (select 1 from jsonb_array_elements(v_list) e where e->>'phone' = v_phone) into v_hit;   -- 同一个电话已经有了 → 不重复加
    end if;
    if not v_hit then v_list := v_list || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', v_name, 'phone', v_phone, 'role', v_role, 'added_at', now())); end if;
  end if;
  update app.customers set contacts = v_list where id = p_customer;
  return v_list;
end $$;

revoke all on function app.assign_picker(uuid, uuid, text), app.can_pick(app.deals), app.pick_tick(uuid, int, text), app.submit_pick_ticks(uuid, text, uuid),
  app.split_deal_qty(uuid, jsonb, date, text), app.save_customer_contact(uuid, jsonb), app.trg_auto_sales_order(), app.trg_confirm_price_check(), app.trg_clear_ticks() from public;
grant execute on function app.assign_picker(uuid, uuid, text), app.pick_tick(uuid, int, text), app.submit_pick_ticks(uuid, text, uuid),
  app.split_deal_qty(uuid, jsonb, date, text), app.save_customer_contact(uuid, jsonb) to authenticated;
