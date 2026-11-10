-- LA&9S Operations · 0014 (Frank 2026-10-30 / 10-31)
-- 1 询单 + 分级审批: 员工看不到价格清单; 老客户按公式价、没超欠款的单自动通过, 其余 (新客户 / 申请特价 / 超上限 / 超账期 / 没编码) 等中方一键审批; 批了以后员工才看到这张单的价格发给客户
-- 2 采购 / 物资申请: 每一行写清楚用途 (本地备货 / FOB 项目 / 物资), 期望发货日、预计到货提醒
-- 3 金蝶采购订单备注自动识别 (本地 / FOB / 混装 + 哪个 FOB 客户) → 收货时按行分 FOB 和本地, 分别进 FOB 仓和 LA / 9S 仓, 并给出金蝶采购入库要录到哪个仓
-- 4 上班打卡带定位 (不拍照): 销售看在不在市场, 办公室 / 仓库员工看在不在仓库

-- ───────────────────────── 1 询单 + 审批 ─────────────────────────
alter table app.deals add column approval text not null default 'auto' check (approval in ('auto','pending','approved','rejected')),
  add column approval_reasons text[] not null default '{}', add column approved_by uuid, add column approved_at timestamptz, add column approval_note text;
alter table app.deal_lines add column requested_price numeric(18,2);   -- 销售员替客户申请的价 (特价)

create or replace function app.approval_reasons(p_deal uuid)
returns text[] language sql stable security definer set search_path = app, public as $$
  select array_remove(array[
    case when c.status <> 'active' or c.tier is null then '新客户（还没定档位）' end,
    case when cr.over_limit then '超欠款上限' end,
    case when cr.over_days then '超账期' end,
    case when exists (select 1 from app.deal_lines l where l.deal_id = d.id and l.product_id is null) then '有没编码的型号' end,
    case when exists (select 1 from app.deal_lines l where l.deal_id = d.id and l.requested_price is not null) then '申请特价' end
  ], null)
  from app.deals d join app.customers c on c.id = d.customer_id
  left join app.v_customer_credit cr on cr.customer_id = c.id
  where d.id = p_deal
$$;

create or replace function app.evaluate_approval(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; r text[];
begin
  select * into d from app.deals where id = p_deal;
  if d.status <> 'quoted' or d.kind <> 'normal' or d.approval = 'rejected' then return; end if;
  r := app.approval_reasons(p_deal);
  update app.deals set approval_reasons = r,
    approval = case when cardinality(r) = 0 then 'auto'
                    when d.approval = 'approved' and r <@ d.approval_reasons then 'approved'
                    else 'pending' end
  where id = p_deal;
end $$;

create or replace function app.trg_lines_approval() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  perform app.evaluate_approval(coalesce(new.deal_id, old.deal_id));
  return null;
end $$;
create trigger lines_approval after insert or update of product_id, requested_price or delete on app.deal_lines
  for each row execute function app.trg_lines_approval();

-- 没批的报价不能往下推 (热线确认 / 下推找货单)
create or replace function app.trg_deal_gate() returns trigger language plpgsql as $$
begin
  if old.status = 'quoted' and new.status not in ('quoted','cancelled') and new.approval not in ('auto','approved') then
    raise exception 'NEEDS_APPROVAL: 这张单要中方先审批（%）', array_to_string(new.approval_reasons, '、');
  end if;
  return new;
end $$;
create trigger deal_gate before update of status on app.deals for each row execute function app.trg_deal_gate();

-- 销售员 / 热线询单: 客户可以是潜客 (还没档位); 每行可以填客户想要的价 (= 申请特价)
create or replace function app.create_inquiry(p_org uuid, p_customer uuid, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; c app.customers; x jsonb; l record; i int := 0;
begin
  perform app.require_role(p_org, 'manager', 'hotline', 'sales');
  select * into c from app.customers where id = p_customer and org_id = p_org;
  if not found then raise exception 'NOT_FOUND: customer'; end if;
  if jsonb_array_length(coalesce(p_lines,'[]')) = 0 then raise exception 'VALIDATION: 没有询的货'; end if;
  insert into app.deals (org_id, biz_no, quote_no, customer_id, currency, owner_employee_id, note, created_by)
  values (p_org, app.next_doc_no(p_org,'BIZ'), app.next_doc_no(p_org,'QT'), p_customer, 'XOF', c.owner_employee_id, p_note, app.uid())
  returning * into d;
  perform app.write_lines(d, p_lines);
  for l in select id from app.deal_lines where deal_id = d.id order by seq loop
    x := p_lines -> i; i := i + 1;
    if nullif(x->>'requested_price','') is not null then update app.deal_lines set requested_price = (x->>'requested_price')::numeric where id = l.id; end if;
  end loop;
  perform app.deal_event(d.id, 'quote_created', jsonb_build_object('source', 'inquiry', 'lines', jsonb_array_length(p_lines)));
  perform app.evaluate_approval(d.id);
  return d.id;
end $$;

-- 中方审批: 可以顺手给特价 (p_prices = [{line_id, price}]); 新客户要先转正式 (给编码 + 档位)
create or replace function app.approve_quote(p_deal uuid, p_ok boolean, p_note text default null, p_prices jsonb default '[]')
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals; c app.customers; x jsonb; v_ids uuid[];
begin
  select * into d from app.deals where id = p_deal for update;
  perform app.require_role(d.org_id, 'admin');
  if d.status <> 'quoted' then raise exception 'BAD_STATE: 只有报价阶段要审批'; end if;
  if not p_ok then
    if coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 不批要写原因'; end if;
    update app.deals set approval = 'rejected', approved_by = app.uid(), approved_at = now(), approval_note = p_note where id = p_deal;
    perform app.deal_event(p_deal, 'quote_rejected', jsonb_build_object('note', p_note));
    return 'rejected';
  end if;
  select * into c from app.customers where id = d.customer_id;
  if c.status <> 'active' or c.tier is null then raise exception 'VALIDATION: 新客户先「转正式」给编码和档位，再批'; end if;
  select array_agg(id) into v_ids from app.deal_lines where deal_id = p_deal;
  update app.deal_lines l set unit_price = coalesce(app.tier_price(l.product_id, d.customer_id, d.currency), l.unit_price)
  where l.deal_id = p_deal and not l.price_manual and l.product_id is not null;
  for x in select * from jsonb_array_elements(coalesce(p_prices, '[]')) loop
    perform app.set_line_price((x->>'line_id')::uuid, (x->>'price')::numeric, coalesce(nullif(p_note,''), '审批特价'));
  end loop;
  update app.deals set approval = 'approved', approval_reasons = app.approval_reasons(p_deal), approved_by = app.uid(), approved_at = now(), approval_note = p_note where id = p_deal;
  perform app.deal_event(p_deal, 'quote_approved', jsonb_build_object('note', p_note, 'special', jsonb_array_length(coalesce(p_prices, '[]'))));
  return 'approved';
end $$;

-- ───────────────────────── 2 采购 / 物资申请 ─────────────────────────
create table app.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  req_no text not null,
  kind text not null check (kind in ('stock','fob','supplies')),     -- 本地备货 / FOB 客户货 / 物资 (工服、工具、办公用品…)
  fob_project_id uuid references app.fob_projects(id),
  title text not null,
  description text,
  need_by date, planned_ship date, eta date,
  mode text check (mode in ('sea','air','courier','other')),
  status text not null default 'submitted' check (status in ('draft','submitted','ordered','shipped','arrived','received','cancelled')),
  po_no text, logistics text, tracking text, container text,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id, req_no)
);
create table app.purchase_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references app.purchase_requests(id) on delete cascade,
  product_id uuid references app.products(id),
  item text not null,                -- 型号 / 物资名称 (例: 工服 L 码 蓝色)
  spec text, qty int not null check (qty > 0), qty_received int not null default 0
);
alter table app.purchase_requests enable row level security; alter table app.purchase_request_lines enable row level security;
create policy read_own on app.purchase_requests for select using (app.is_member(org_id));
create policy read_own on app.purchase_request_lines for select using (exists (select 1 from app.purchase_requests r where r.id = request_id and app.is_member(r.org_id)));

create or replace function app.save_purchase_request(p_org uuid, p_id uuid, p_data jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id; x jsonb; v_p app.products;
begin
  perform app.require_role(p_org, 'manager', 'finance', 'hotline', 'sales', 'picker');
  if coalesce(trim(p_data->>'title'),'') = '' then raise exception 'VALIDATION: 要写申请什么'; end if;
  if (p_data->>'kind') = 'fob' and nullif(p_data->>'fob_project_id','') is null then raise exception 'VALIDATION: FOB 的货要选 FOB 项目'; end if;
  if v_id is null then
    insert into app.purchase_requests (org_id, req_no, kind, title, created_by) values (p_org, app.next_doc_no(p_org, 'PR'), p_data->>'kind', p_data->>'title', app.uid()) returning id into v_id;
  elsif exists (select 1 from app.purchase_requests where id = v_id and status not in ('draft','submitted')) then
    raise exception 'BAD_STATE: 已经下单的申请不能改内容，只能更新进度';
  end if;
  update app.purchase_requests set kind = p_data->>'kind', title = p_data->>'title', description = nullif(p_data->>'description',''),
    fob_project_id = nullif(p_data->>'fob_project_id','')::uuid, need_by = nullif(p_data->>'need_by','')::date,
    planned_ship = nullif(p_data->>'planned_ship','')::date, mode = nullif(p_data->>'mode',''), updated_at = now()
  where id = v_id;
  delete from app.purchase_request_lines where request_id = v_id;
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    v_p := null;
    if nullif(x->>'product_id','') is not null then select * into v_p from app.products where id = (x->>'product_id')::uuid; end if;
    insert into app.purchase_request_lines (request_id, product_id, item, spec, qty)
    values (v_id, v_p.id, coalesce(v_p.model, x->>'item'), x->>'spec', (x->>'qty')::int);
  end loop;
  return v_id;
end $$;

-- 进度: 下单 (采购单号) → 发货 (物流 / 单号 / 柜号 / 预计到货) → 到货 → 收货完成 / 取消. 中方和主管更新, 物资财务也能更新
create or replace function app.advance_purchase_request(p_id uuid, p_to text, p_data jsonb default '{}')
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.purchase_requests;
begin
  select * into r from app.purchase_requests where id = p_id for update;
  perform app.require_role(r.org_id, 'manager', 'finance');
  if p_to not in ('ordered','shipped','arrived','received','cancelled') then raise exception 'VALIDATION: 状态无效'; end if;
  update app.purchase_requests set status = p_to, po_no = coalesce(nullif(p_data->>'po_no',''), po_no), logistics = coalesce(nullif(p_data->>'logistics',''), logistics),
    tracking = coalesce(nullif(p_data->>'tracking',''), tracking), container = coalesce(nullif(p_data->>'container',''), container),
    eta = coalesce(nullif(p_data->>'eta','')::date, eta), planned_ship = coalesce(nullif(p_data->>'planned_ship','')::date, planned_ship), updated_at = now()
  where id = p_id;
end $$;

-- ───────────────────────── 3 采购订单备注识别 + 收货分 FOB / 本地 ─────────────────────────
alter table app.purchase_orders add column remark text, add column purpose text check (purpose in ('local','fob','mixed','supplies','unknown')),
  add column fob_customer_codes text[] not null default '{}', add column boxes int, add column pcs int, add column warehouse_nos text[] not null default '{}',
  add column fx numeric(12,6), add column tax_included boolean, add column remark_parsed jsonb, add column request_id uuid references app.purchase_requests(id);
alter table app.po_lines add column fob_qty int not null default 0,          -- 这一行里属于 FOB 客户的数量 (其余 = 本地备货)
  add column fob_customer text, add column alloc_source text;                -- auto (按备注) / manual (人工改)

-- 导入采购订单的时候带上备注识别结果 (识别在前端 poRemark.js 做, 这里存结果并按用途预分)
create or replace function app.set_po_remark(p_org uuid, p_po_no text, p_remark text, p_parsed jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_po app.purchase_orders; v_fob text;
begin
  perform app.require_role(p_org, 'admin', 'manager');
  select * into v_po from app.purchase_orders where org_id = p_org and po_no = p_po_no;
  if not found then return; end if;
  update app.purchase_orders set remark = p_remark, remark_parsed = p_parsed, purpose = coalesce(p_parsed->>'purpose', 'unknown'),
    fob_customer_codes = coalesce((select array_agg(v) from jsonb_array_elements_text(p_parsed->'fob_customers') v), '{}'),
    boxes = nullif(p_parsed->>'boxes','')::int, pcs = nullif(p_parsed->>'pcs','')::int, fx = nullif(p_parsed->>'fx','')::numeric,
    tax_included = (p_parsed->>'tax')::boolean,
    warehouse_nos = coalesce((select array_agg(v) from jsonb_array_elements_text(p_parsed->'warehouse_no') v), '{}')
  where id = v_po.id;
  v_fob := (select v from jsonb_array_elements_text(p_parsed->'fob_customers') v limit 1);
  -- 整单是 FOB → 每行全部算 FOB; 整单本地 → 全部本地; 混装 / 认不出 → 先不分, 等收货时人工分 (没人工改过的行才自动改)
  update app.po_lines set fob_qty = case p_parsed->>'purpose' when 'fob' then qty else 0 end,
    fob_customer = case when p_parsed->>'purpose' = 'fob' then v_fob end, alloc_source = 'auto'
  where po_id = v_po.id and coalesce(alloc_source, 'auto') = 'auto';
end $$;

create or replace function app.set_po_line_alloc(p_line uuid, p_fob_qty int, p_customer text)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; l app.po_lines;
begin
  select p.org_id into v_org from app.po_lines x join app.purchase_orders p on p.id = x.po_id where x.id = p_line;
  perform app.require_role(v_org, 'manager');
  select * into l from app.po_lines where id = p_line;
  if p_fob_qty < 0 or p_fob_qty > l.qty then raise exception 'VALIDATION: FOB 数量要在 0 到 % 之间', l.qty; end if;
  update app.po_lines set fob_qty = p_fob_qty, fob_customer = case when p_fob_qty > 0 then nullif(p_customer,'') end, alloc_source = 'manual' where id = p_line;
end $$;

-- 收货 (分开): 每行 本地数 进 LA / 9S, FOB 数 进 FOB 仓; 记一张收货单, 金蝶那边照着录采购入库 (FOB 那部分入 CI LA FOB Material WH)
create table app.po_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  po_id uuid not null references app.purchase_orders(id),
  grn_no text not null,
  lines jsonb not null,                       -- [{line_id, code, model, local_qty, fob_qty, fob_customer, warehouse}]
  photo text, note text,
  kd_status text not null default 'ready' check (kd_status in ('ready','saved','synced')), kd_no text,
  created_by uuid, created_at timestamptz not null default now()
);
alter table app.po_receipts enable row level security;
create policy read_own on app.po_receipts for select using (app.is_member(org_id));

create or replace function app.receive_po_split(p_po uuid, p_rows jsonb, p_photo text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare po app.purchase_orders; x jsonb; l app.po_lines; v_w uuid; v_s uuid; v_loc int; v_fob int; v_lines jsonb := '[]'; v_id uuid; p app.products;
begin
  select * into po from app.purchase_orders where id = p_po for update;
  perform app.require_role(po.org_id, 'manager');
  for x in select * from jsonb_array_elements(p_rows) loop
    v_loc := coalesce((x->>'local_qty')::int, 0); v_fob := coalesce((x->>'fob_qty')::int, 0);
    continue when v_loc + v_fob <= 0;
    select * into l from app.po_lines where id = (x->>'line_id')::uuid and po_id = p_po for update;
    if not found then raise exception 'NOT_FOUND: 采购行'; end if;
    if l.product_id is null then raise exception 'VALIDATION: % 还没有物料编码，先让中方建编码', l.model; end if;
    if l.qty_received + v_loc + v_fob > l.qty then raise exception 'VALIDATION: % 收货数超过采购数', l.model; end if;
    select * into p from app.products where id = l.product_id;
    if v_loc > 0 then
      select id into v_w from app.warehouses where org_id = po.org_id and upper(code) = upper(coalesce(x->>'warehouse','LA')) and kind = 'local';
      if not found then raise exception 'VALIDATION: 本地备货只能进 LA 仓或 9S 仓'; end if;
      insert into app.stock_items (warehouse_id, product_id) values (v_w, l.product_id) on conflict (warehouse_id, product_id) do nothing;
      select id into v_s from app.stock_items where warehouse_id = v_w and product_id = l.product_id;
      perform app.move_stock(v_s, v_loc, 'grn', 'po', p_po);
    end if;
    if v_fob > 0 then
      v_s := app.stock_row(po.org_id, 'fob', l.product_id);
      perform app.move_stock(v_s, v_fob, 'grn', 'po_fob', p_po);
    end if;
    update app.po_lines set qty_received = qty_received + v_loc + v_fob where id = l.id;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_id', l.id, 'code', p.code, 'model', p.model, 'local_qty', v_loc, 'fob_qty', v_fob,
      'fob_customer', coalesce(nullif(x->>'fob_customer',''), l.fob_customer), 'warehouse', upper(coalesce(x->>'warehouse','LA'))));
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'VALIDATION: 没有收货数量'; end if;
  insert into app.po_receipts (org_id, po_id, grn_no, lines, photo, note, created_by)
  values (po.org_id, p_po, app.next_doc_no(po.org_id, 'GRN'), v_lines, p_photo, p_note, app.uid()) returning id into v_id;
  update app.purchase_orders set status = case when not exists (select 1 from app.po_lines where po_id = p_po and qty_received < qty) then 'closed' else 'open' end where id = p_po;
  perform app.audit(po.org_id, 'receive_po_split', 'purchase_orders', p_po, v_lines);
  return v_id;
end $$;

create or replace function app.kd_grn_step(p_receipt uuid, p_step text, p_no text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare g app.po_receipts;
begin
  select * into g from app.po_receipts where id = p_receipt for update;
  perform app.require_role(g.org_id, 'finance', 'manager');
  if p_step = 'save' then
    if coalesce(trim(p_no),'') = '' then raise exception 'VALIDATION: 要填金蝶入库单号'; end if;
    update app.po_receipts set kd_status = 'saved', kd_no = trim(p_no) where id = p_receipt;
  elsif p_step = 'done' then update app.po_receipts set kd_status = 'synced' where id = p_receipt and kd_status = 'saved';
  else raise exception 'VALIDATION: 未知步骤'; end if;
end $$;

-- ───────────────────────── 4 上班打卡 (带定位, 不拍照) ─────────────────────────
create table app.work_sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  name text not null,
  kind text not null check (kind in ('warehouse','office','market')),
  lat double precision not null, lng double precision not null,
  radius_m int not null default 150,
  active boolean not null default true
);
create table app.attendance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  employee_id uuid references app.employees(id),
  user_id uuid not null,
  kind text not null check (kind in ('in','out')),
  at timestamptz not null default now(),
  lat double precision, lng double precision, accuracy_m double precision,
  site_id uuid references app.work_sites(id), distance_m int,
  ok boolean not null,                  -- 在规定的地方 (销售: 任一市场; 其他人: 仓库 / 办公室)
  late boolean not null default false,
  note text
);
create index on app.attendance (org_id, at desc);
create table app.attendance_settings (
  org_id uuid primary key references app.orgs(id),
  start_time time not null default '08:30', end_time time not null default '18:00', grace_min int not null default 10,
  max_accuracy_m int not null default 200
);
alter table app.work_sites enable row level security; alter table app.attendance enable row level security; alter table app.attendance_settings enable row level security;
create policy read_own on app.work_sites for select using (app.is_member(org_id));
create policy read_own on app.attendance for select using (app.is_member(org_id));
create policy read_own on app.attendance_settings for select using (app.is_member(org_id));

create or replace function app.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 6371000 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

create or replace function app.upsert_site(p_org uuid, p_id uuid, p_name text, p_kind text, p_lat double precision, p_lng double precision, p_radius int, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id;
begin
  perform app.require_role(p_org, 'admin');
  if v_id is null then
    insert into app.work_sites (org_id, name, kind, lat, lng, radius_m, active) values (p_org, p_name, p_kind, p_lat, p_lng, coalesce(p_radius, 150), coalesce(p_active, true)) returning id into v_id;
  else
    update app.work_sites set name = p_name, kind = p_kind, lat = p_lat, lng = p_lng, radius_m = coalesce(p_radius, 150), active = coalesce(p_active, true) where id = v_id and org_id = p_org;
  end if;
  return v_id;
end $$;

-- 打卡: 手机定位 → 找最近的工作地点 → 销售只认市场, 其他人只认仓库 / 办公室 → 记「在 / 不在」和迟到
create or replace function app.clock(p_org uuid, p_kind text, p_lat double precision, p_lng double precision, p_accuracy double precision, p_note text default null)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare v_emp uuid; v_roles app.role_name[]; v_sales boolean; s record; v_ok boolean; v_late boolean := false; st app.attendance_settings; v_id uuid;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  if p_lat is null or p_lng is null then raise exception 'VALIDATION: 拿不到定位，打不了卡（手机要允许定位）'; end if;
  if p_kind not in ('in','out') then raise exception 'VALIDATION: 上班 / 下班'; end if;
  select employee_id, roles into v_emp, v_roles from app.members where user_id = app.uid() and org_id = p_org;
  insert into app.attendance_settings (org_id) values (p_org) on conflict do nothing;
  select * into st from app.attendance_settings where org_id = p_org;
  v_sales := 'sales' = any(v_roles);
  select w.id, w.name, w.kind, round(app.distance_m(p_lat, p_lng, w.lat, w.lng))::int as d, w.radius_m into s
  from app.work_sites w where w.org_id = p_org and w.active and (case when v_sales then w.kind = 'market' else w.kind in ('warehouse','office') end)
  order by app.distance_m(p_lat, p_lng, w.lat, w.lng) limit 1;
  v_ok := s.id is not null and s.d <= s.radius_m + least(coalesce(p_accuracy, 0), st.max_accuracy_m);
  if p_kind = 'in' then
    v_late := (now() at time zone 'Africa/Abidjan')::time > st.start_time + make_interval(mins => st.grace_min)
      and not exists (select 1 from app.attendance a where a.user_id = app.uid() and a.kind = 'in' and (a.at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date);
  end if;
  insert into app.attendance (org_id, employee_id, user_id, kind, lat, lng, accuracy_m, site_id, distance_m, ok, late, note)
  values (p_org, v_emp, app.uid(), p_kind, p_lat, p_lng, p_accuracy, s.id, s.d, v_ok, v_late, nullif(trim(p_note),'')) returning id into v_id;
  return jsonb_build_object('ok', v_ok, 'site', s.name, 'distance', s.d, 'late', v_late);
end $$;

create or replace function app.set_attendance_settings(p_org uuid, p_start time, p_end time, p_grace int)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  insert into app.attendance_settings (org_id, start_time, end_time, grace_min) values (p_org, p_start, p_end, p_grace)
  on conflict (org_id) do update set start_time = excluded.start_time, end_time = excluded.end_time, grace_min = excluded.grace_min;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.purchase_requests, app.purchase_request_lines, app.po_receipts, app.work_sites, app.attendance, app.attendance_settings to authenticated;
    grant execute on function app.create_inquiry(uuid, uuid, jsonb, text), app.approve_quote(uuid, boolean, text, jsonb),
      app.save_purchase_request(uuid, uuid, jsonb, jsonb), app.advance_purchase_request(uuid, text, jsonb),
      app.set_po_remark(uuid, text, text, jsonb), app.set_po_line_alloc(uuid, int, text), app.receive_po_split(uuid, jsonb, text, text),
      app.kd_grn_step(uuid, text, text), app.upsert_site(uuid, uuid, text, text, double precision, double precision, int, boolean),
      app.clock(uuid, text, double precision, double precision, double precision, text), app.set_attendance_settings(uuid, time, time, int) to authenticated;
  end if;
end $$;
revoke execute on function app.evaluate_approval(uuid) from public;
