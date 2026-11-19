-- 0067 (Frank 11-18 398 / 400 / 402): 出库前追加货 = 一条分支, 单独走一遍小流程
--   3.1 原单照旧; 3.2 / 3.3… = 追加批: 等安排找货 → 打勾找货 + 照片 → 销售单 -O2 → 客户确认 → 复检 → 并进原单一起出库.
--   做法: 追加批的行先放在自己的表里 (addon_lines), 不碰 deal_lines —— 原单已经确认 / 复检好的那批保持原样;
--         这一批复检完才把行并进 deal_lines (已预占、带客户确认数量), 之后照现有出库 / 分批出库走.
--   货一发出去 (有出库单) 就不能再开新的追加批; 已经开了的可以走完, 并进去后订单回到「部分出库」.

create table app.deal_addons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  deal_id uuid not null references app.deals(id) on delete cascade,
  no int not null,                         -- 2, 3, … (界面写成 3.2 / 3.3; 销售单号 -O2 / -O3)
  so_no text,
  status text not null default 'assign' check (status in ('assign', 'picking', 'ordered', 'confirmed', 'reviewed', 'cancelled')),
  note text,
  picker_employee_id uuid references app.employees(id), assigned_by uuid, assigned_at timestamptz,
  picked_at timestamptz, pick_photo text, picked_by uuid,
  confirm_method text, confirm_proof text, confirm_note text, confirmed_at timestamptz, confirmed_by uuid,
  reviewer_employee_id uuid references app.employees(id), review_photo text, reviewed_at timestamptz, reviewed_by uuid,
  cancel_reason text, cancelled_at timestamptz, cancelled_by uuid,
  created_by uuid, created_at timestamptz not null default now(),
  unique (deal_id, no)
);
create index on app.deal_addons (org_id, status);
create table app.addon_lines (
  id uuid primary key default gen_random_uuid(),
  addon_id uuid not null references app.deal_addons(id) on delete cascade,
  seq int not null,
  product_id uuid not null references app.products(id),
  stock_item_id uuid not null references app.stock_items(id),
  qty_req int not null check (qty_req > 0),
  qty_picked int, pick_reason text,
  qty_final int, review_reason text,
  unit_price numeric(18,2) not null default 0,
  price_manual boolean not null default false,
  note text
);
create index on app.addon_lines (addon_id);
alter table app.deal_addons enable row level security;
alter table app.addon_lines enable row level security;
create policy read_own on app.deal_addons for select using (app.is_member(org_id));
create policy read_own on app.addon_lines for select using (exists (select 1 from app.deal_addons a where a.id = addon_id and app.is_member(a.org_id)));
grant select on app.deal_addons, app.addon_lines to authenticated;
alter table app.deal_lines add column addon_id uuid references app.deal_addons(id);

-- 销售只能动自己名下客户的单
create or replace function app.addon_own_check(d app.deals) returns void language plpgsql security definer set search_path = app, public as $$
declare me uuid;
begin
  if app.has_role(d.org_id, array['manager', 'sales_manager', 'hotline']::app.role_name[]) then return; end if;
  me := app.current_employee(d.org_id);
  if me is not null and d.owner_employee_id is distinct from me then raise exception 'PERMISSION_DENIED: 这个客户不在你名下，这张单只能看不能动'; end if;
end $$;

-- 开一个追加批. p_lines: [{product_id, qty, stock_item_id?, unit_price? (只中方), note?}]
create or replace function app.start_addon(p_deal uuid, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; x jsonb; v_id uuid; v_no int; v_seq int := 0; v_prod uuid; v_stock uuid; v_qty int; v_price numeric; v_manual boolean; v_admin boolean;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'manager', 'sales_manager', 'hotline', 'sales');
  perform app.addon_own_check(d);
  v_admin := app.has_role(d.org_id, array['admin']::app.role_name[]);
  if d.status in ('partial', 'shipped') or exists (select 1 from app.shipments s where s.deal_id = p_deal and s.voided_at is null) then
    raise exception 'BAD_STATE: 货已经发出去了，不能再追加；给这个客户开一张新单';
  end if;
  if d.status not in ('picking', 'picked', 'ordered', 'confirmed', 'reviewed') then
    raise exception 'BAD_STATE: 还没下推找货的单直接改报价就行，不用追加';
  end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'VALIDATION: 请先选要追加的型号和数量'; end if;
  select coalesce(max(no), 1) + 1 into v_no from app.deal_addons where deal_id = p_deal;
  insert into app.deal_addons (org_id, deal_id, no, note, created_by) values (d.org_id, p_deal, v_no, nullif(trim(coalesce(p_note, '')), ''), app.uid()) returning id into v_id;
  for x in select * from jsonb_array_elements(p_lines) loop
    v_seq := v_seq + 1;
    v_prod := nullif(x->>'product_id', '')::uuid; v_qty := coalesce((x->>'qty')::int, 0);
    if v_prod is null then raise exception 'VALIDATION: 追加只能选有编码的型号；没编码的先去「补录需求」'; end if;
    if v_qty <= 0 then raise exception 'VALIDATION: 第 % 行数量要大于 0', v_seq; end if;
    v_stock := nullif(x->>'stock_item_id', '')::uuid;
    if v_stock is null then
      select s.id into v_stock from app.stock_items s join app.warehouses w on w.id = s.warehouse_id
      where s.product_id = v_prod and w.org_id = d.org_id and w.kind = case when d.kind = 'fob' then 'fob'::app.wh_kind else 'local'::app.wh_kind end
      order by s.qty_on_hand - s.qty_reserved desc limit 1;
    end if;
    if v_stock is null then raise exception 'VALIDATION: 第 % 行这个型号没有库存记录', v_seq; end if;
    v_manual := v_admin and nullif(x->>'unit_price', '') is not null;
    v_price := case when v_manual then (x->>'unit_price')::numeric else coalesce(app.tier_price(v_prod, d.customer_id, d.currency), 0) end;
    if v_price <= 0 then raise exception 'VALIDATION: 第 % 行还没有价格，先去「物料与定价」定价', v_seq; end if;
    perform app.reserve(v_stock, v_qty);
    insert into app.addon_lines (addon_id, seq, product_id, stock_item_id, qty_req, unit_price, price_manual, note)
    values (v_id, v_seq, v_prod, v_stock, v_qty, v_price, v_manual, nullif(trim(coalesce(x->>'note', '')), ''));
  end loop;
  perform app.deal_event(p_deal, 'addon_started', jsonb_build_object('addon', v_id, 'no', v_no, 'lines', v_seq));
  return v_id;
end $$;

-- 主管派人 / 改派 (不自动派给上次那个人)
create or replace function app.assign_addon(p_addon uuid, p_employee uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.deal_addons;
begin
  select * into a from app.deal_addons where id = p_addon for update;
  if a.id is null then raise exception 'NOT_FOUND: 追加批不存在'; end if;
  perform app.require_role(a.org_id, 'manager');
  if a.status not in ('assign', 'picking') then raise exception 'BAD_STATE: 这一批已经找完了'; end if;
  if p_employee is null then raise exception 'VALIDATION: 选谁去找'; end if;
  update app.deal_addons set picker_employee_id = p_employee, assigned_by = app.uid(), assigned_at = now(), status = 'picking' where id = p_addon;
  perform app.deal_event(a.deal_id, 'addon_assigned', jsonb_build_object('addon', p_addon, 'no', a.no, 'to', p_employee, 'from', a.picker_employee_id));
end $$;

-- 找货提交: p_lines [{line_id, qty, reason}] (没传的行 = 找到了要的数); 照片必传 → 生成这一批的销售单号
create or replace function app.addon_pick_submit(p_addon uuid, p_lines jsonb, p_photo text)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.deal_addons; d app.deals; l app.addon_lines; x jsonb; v_qty int; v_sum int := 0; me uuid;
begin
  select * into a from app.deal_addons where id = p_addon for update;
  if a.id is null then raise exception 'NOT_FOUND: 追加批不存在'; end if;
  select * into d from app.deals where id = a.deal_id;
  me := app.current_employee(a.org_id);
  if not app.has_role(a.org_id, array['manager']::app.role_name[]) and (me is null or a.picker_employee_id is distinct from me) then
    raise exception 'PERMISSION_DENIED: 这一批不是派给你找的';
  end if;
  if a.status <> 'picking' then raise exception 'BAD_STATE: 这一批现在不在找货中（先让主管派人）'; end if;
  if coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 找货要拍现场照片'; end if;
  for l in select * from app.addon_lines where addon_id = p_addon order by seq loop
    select x2 into x from jsonb_array_elements(coalesce(p_lines, '[]')) x2 where (x2->>'line_id')::uuid = l.id;
    v_qty := coalesce((x->>'qty')::int, l.qty_req);
    if x is null then v_qty := l.qty_req; end if;
    if v_qty < 0 or v_qty > l.qty_req then raise exception 'VALIDATION: 第 % 行找到的数量不对', l.seq; end if;
    if v_qty < l.qty_req and coalesce(trim(x->>'reason'), '') = '' then raise exception 'VALIDATION: 第 % 行找少了要选原因', l.seq; end if;
    perform app.reserve(l.stock_item_id, v_qty - l.qty_req);
    update app.addon_lines set qty_picked = v_qty, pick_reason = case when v_qty < l.qty_req then trim(x->>'reason') end where id = l.id;
    v_sum := v_sum + v_qty;
  end loop;
  if v_sum = 0 then raise exception 'VALIDATION: 一片都没找到的话，直接「取消这一批」'; end if;
  update app.deal_addons set status = 'ordered', picked_at = now(), pick_photo = p_photo, picked_by = app.uid(),
    so_no = coalesce(d.biz_no, d.quote_no) || '-O' || a.no where id = p_addon;
  perform app.deal_event(a.deal_id, 'addon_picked', jsonb_build_object('addon', p_addon, 'no', a.no, 'qty', v_sum));
end $$;

-- 客户确认这一批的销售单 (截图必传)
create or replace function app.addon_confirm(p_addon uuid, p_method text, p_proof text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.deal_addons; d app.deals;
begin
  select * into a from app.deal_addons where id = p_addon for update;
  if a.id is null then raise exception 'NOT_FOUND: 追加批不存在'; end if;
  select * into d from app.deals where id = a.deal_id;
  perform app.require_role(a.org_id, 'manager', 'sales_manager', 'hotline', 'sales');
  perform app.addon_own_check(d);
  if a.status <> 'ordered' then raise exception 'BAD_STATE: 这一批现在不在「等客户确认」'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'CONFIRM_REQUIRED: 客户确认要传截图'; end if;
  update app.deal_addons set status = 'confirmed', confirm_method = nullif(trim(coalesce(p_method, '')), ''), confirm_proof = p_proof,
    confirm_note = nullif(trim(coalesce(p_note, '')), ''), confirmed_at = now(), confirmed_by = app.uid() where id = p_addon;
  perform app.deal_event(a.deal_id, 'addon_confirmed', jsonb_build_object('addon', p_addon, 'no', a.no, 'method', p_method));
end $$;

-- 复检这一批 + 并进原单. p_lines [{line_id, counted, reason}] (只传实点数和找货数不一样的行: 只能少, 多的放回货架)
create or replace function app.addon_review(p_addon uuid, p_reviewer uuid, p_photo text, p_lines jsonb default '[]')
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.deal_addons; d app.deals; l app.addon_lines; x jsonb; v_cnt int; v_seq int; v_changed boolean := false; v_line uuid;
begin
  select * into a from app.deal_addons where id = p_addon for update;
  if a.id is null then raise exception 'NOT_FOUND: 追加批不存在'; end if;
  perform app.require_role(a.org_id, 'manager');
  if a.status <> 'confirmed' then raise exception 'BAD_STATE: 这一批客户还没确认，不能复检'; end if;
  if p_reviewer is null then raise exception 'VALIDATION: 选复核人'; end if;
  if coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 复检要拍打包照片'; end if;
  if p_reviewer = a.picker_employee_id and not app.has_role(a.org_id, array['admin']::app.role_name[]) then
    raise exception 'VALIDATION: 复核人不能是找货的那个人';
  end if;
  d := app.lock_deal(a.deal_id, array['picking', 'picked', 'ordered', 'confirmed', 'reviewed', 'partial', 'shipped']::app.deal_status[]);
  select coalesce(max(seq), 0) into v_seq from app.deal_lines where deal_id = a.deal_id;
  for l in select * from app.addon_lines where addon_id = p_addon order by seq loop
    select x2 into x from jsonb_array_elements(coalesce(p_lines, '[]')) x2 where (x2->>'line_id')::uuid = l.id;
    v_cnt := case when x is null then l.qty_picked else (x->>'counted')::int end;
    if v_cnt is null or v_cnt < 0 or v_cnt > l.qty_picked then raise exception 'VALIDATION: 第 % 行实点数不对（多出来的放回货架，按找货数填）', l.seq; end if;
    if v_cnt < l.qty_picked then
      if coalesce(trim(x->>'reason'), '') = '' then raise exception 'VALIDATION: 第 % 行少了要写原因', l.seq; end if;
      perform app.reserve(l.stock_item_id, v_cnt - l.qty_picked);
      v_changed := true;
    end if;
    update app.addon_lines set qty_final = v_cnt, review_reason = case when v_cnt < l.qty_picked then trim(x->>'reason') end where id = l.id;
    v_seq := v_seq + 1;
    insert into app.deal_lines (deal_id, seq, product_id, qty_req, stock_item_id, qty_supply, qty_picked, unit_price, price_manual, added_after_pick, note, addon_id,
                                diff_reason, qty_confirmed)
    values (a.deal_id, v_seq, l.product_id, l.qty_req, l.stock_item_id, v_cnt, v_cnt, l.unit_price, l.price_manual, true, l.note, p_addon,
            case when v_cnt < l.qty_req then coalesce(case when v_cnt < l.qty_picked then trim(x->>'reason') end, l.pick_reason, '追加批少供') end, v_cnt)
    returning id into v_line;
  end loop;
  update app.deal_addons set status = 'reviewed', reviewer_employee_id = p_reviewer, review_photo = p_photo, reviewed_at = now(), reviewed_by = app.uid() where id = p_addon;
  update app.deals set version = version + 1, status = case when status = 'shipped' then 'partial'::app.deal_status else status end where id = a.deal_id;
  perform app.deal_event(a.deal_id, 'addon_merged', jsonb_build_object('addon', p_addon, 'no', a.no, 'changed', v_changed));
end $$;

-- 取消这一批 (并进原单之前都可以): 放掉预占, 留记录
create or replace function app.cancel_addon(p_addon uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.deal_addons; d app.deals; l app.addon_lines;
begin
  select * into a from app.deal_addons where id = p_addon for update;
  if a.id is null then raise exception 'NOT_FOUND: 追加批不存在'; end if;
  select * into d from app.deals where id = a.deal_id;
  perform app.require_role(a.org_id, 'manager', 'sales_manager', 'hotline', 'sales');
  perform app.addon_own_check(d);
  if a.status in ('reviewed', 'cancelled') then raise exception 'BAD_STATE: 这一批已经并进原单或者已经取消了'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 取消要写原因'; end if;
  for l in select * from app.addon_lines where addon_id = p_addon loop
    perform app.reserve(l.stock_item_id, -coalesce(l.qty_picked, l.qty_req));
  end loop;
  update app.deal_addons set status = 'cancelled', cancel_reason = trim(p_reason), cancelled_at = now(), cancelled_by = app.uid() where id = p_addon;
  perform app.deal_event(a.deal_id, 'addon_cancelled', jsonb_build_object('addon', p_addon, 'no', a.no, 'reason', trim(p_reason)));
end $$;

-- 整单作废 / 订单被删时: 没走完的追加批一起放掉预占
create or replace function app.trg_addon_follow_cancel() returns trigger language plpgsql security definer set search_path = app, public as $$
declare a app.deal_addons; l app.addon_lines;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    for a in select * from app.deal_addons where deal_id = new.id and status not in ('reviewed', 'cancelled') loop
      for l in select * from app.addon_lines where addon_id = a.id loop perform app.reserve(l.stock_item_id, -coalesce(l.qty_picked, l.qty_req)); end loop;
      update app.deal_addons set status = 'cancelled', cancel_reason = '整单作废', cancelled_at = now(), cancelled_by = app.uid() where id = a.id;
    end loop;
  end if;
  return new;
end $$;
create trigger addon_follow_cancel after update of status on app.deals for each row execute function app.trg_addon_follow_cancel();

-- 待办用: 还没走完的追加批
create or replace view app.v_open_addons with (security_invoker = true) as
select a.id, a.org_id, a.deal_id, a.no, a.so_no, a.status, a.picker_employee_id, a.created_at, a.assigned_at, a.picked_at, a.confirmed_at,
  d.biz_no, d.customer_id, d.owner_employee_id, c.name as customer, e.short_name as picker,
  (select count(*)::int from app.addon_lines l where l.addon_id = a.id) as lines,
  (select coalesce(sum(l.qty_req), 0)::int from app.addon_lines l where l.addon_id = a.id) as qty
from app.deal_addons a join app.deals d on d.id = a.deal_id join app.customers c on c.id = d.customer_id
left join app.employees e on e.id = a.picker_employee_id
where a.status not in ('reviewed', 'cancelled');
grant select on app.v_open_addons to authenticated;

revoke all on function app.addon_own_check(app.deals), app.start_addon(uuid, jsonb, text), app.assign_addon(uuid, uuid), app.addon_pick_submit(uuid, jsonb, text),
  app.addon_confirm(uuid, text, text, text), app.addon_review(uuid, uuid, text, jsonb), app.cancel_addon(uuid, text), app.trg_addon_follow_cancel() from public;
grant execute on function app.start_addon(uuid, jsonb, text), app.assign_addon(uuid, uuid), app.addon_pick_submit(uuid, jsonb, text),
  app.addon_confirm(uuid, text, text, text), app.addon_review(uuid, uuid, text, jsonb), app.cancel_addon(uuid, text) to authenticated;
