-- LA&9S Operations · 0046 (Frank 2026-11-13, 待改 294 / 299 / 302)
-- ① 国内初略版: 采购单分本地 / FOB → 箱单导入 (箱号) → 到货按箱下推采购入库单 → 没入库的 = 在途 → 少到的差额选结果 + 凭证才能关
-- ② 「中国支持」岗位 cn_support (国内工厂 / 商务 / 采购)
-- ③ 报价草稿存进系统 (选了客户 + 至少 5 行货; 同一个人同一个客户只有一张); 等中方定档的报价不再算草稿、不再自动作废

alter type app.role_name add value if not exists 'cn_support';

-- ───────────────────────── ① 采购单 / 箱号 / 差额 ─────────────────────────
alter table app.purchase_orders add column batch_name text,                    -- 需求批次 (20260715-KABRE海运-3批)
  add column shipped_on date, add column fob_project_id uuid references app.fob_projects(id),
  add column source text not null default 'kingdee' check (source in ('kingdee','system','packing_list')),
  add column created_by uuid, add column updated_at timestamptz not null default now();
alter table app.po_lines add column unit_price numeric(18,6), add column currency text not null default 'CNY',
  add column descr text,                                                       -- 箱单上的写法 (BG6M LCD COMP)
  add column closed_qty int not null default 0 check (closed_qty >= 0),
  add column close_result text, add column close_proof text, add column close_note text, add column closed_by uuid, add column closed_at timestamptz;
alter table app.po_lines add constraint po_lines_received_closed check (qty_received + closed_qty <= qty);

create table app.po_boxes (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references app.purchase_orders(id) on delete cascade,
  box_no int not null,
  po_line_id uuid references app.po_lines(id) on delete cascade,
  qty int not null check (qty > 0),
  status text not null default 'transit' check (status in ('transit','received','missing')),
  receipt_id uuid references app.po_receipts(id),
  unique (po_id, box_no, po_line_id)
);
create index on app.po_boxes (po_id);
alter table app.po_boxes enable row level security;
create policy read_own on app.po_boxes for select using (exists (select 1 from app.purchase_orders p where p.id = po_id and app.is_member(p.org_id)));

-- 箱单上的型号写法 → 系统物料 (第一次人工挑, 以后自动对上)
create table app.desc_map (
  org_id uuid not null references app.orgs(id),
  descr text not null,
  product_id uuid not null references app.products(id),
  primary key (org_id, descr)
);
alter table app.desc_map enable row level security;
create policy read_own on app.desc_map for select using (app.is_member(org_id));

-- 采购单状态跟着行走: 每行 已收 + 已关差额 = 采购数 → 关闭
create or replace function app.trg_po_status() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  update app.purchase_orders p set status = case when not exists (select 1 from app.po_lines l where l.po_id = p.id and l.qty_received + l.closed_qty < l.qty) then 'closed' else 'open' end,
    updated_at = now()
  where p.id = coalesce(new.po_id, old.po_id);
  return null;
end $$;
create trigger po_status after insert or update of qty_received, closed_qty or delete on app.po_lines for each row execute function app.trg_po_status();

-- 在途 = 采购数 − 已入库 − 已关差额; FOB 单整单算 FOB, 混装单按行上的 FOB 数量
create or replace view app.v_in_transit as
select p.org_id, l.product_id, p.id as po_id, p.po_no, p.batch_name, p.eta, p.shipped_on, p.purpose,
  l.qty - l.qty_received - l.closed_qty as remaining,
  case when p.purpose = 'fob' then l.qty - l.qty_received - l.closed_qty
       else least(l.qty - l.qty_received - l.closed_qty, greatest(l.fob_qty, 0)) end as fob_remaining
from app.po_lines l join app.purchase_orders p on p.id = l.po_id
where l.qty - l.qty_received - l.closed_qty > 0 and l.product_id is not null;
alter view app.v_in_transit set (security_invoker = true);
grant select on app.v_in_transit to authenticated;

-- 对上物料: 先按金蝶料号 / 编码, 再按对照表
create or replace function app.match_descr(p_org uuid, p_descr text, p_code text)
returns uuid language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select id from app.products where org_id = p_org and nullif(trim(p_code), '') is not null and (code = trim(p_code) or kingdee_code = trim(p_code)) limit 1),
    (select product_id from app.desc_map where org_id = p_org and descr = upper(regexp_replace(trim(coalesce(p_descr, '')), '\s+', ' ', 'g'))),
    -- 箱单写法「KL4 LCD COMP」「KG5J/KG5K LCD COMP」: 第一个型号 + 种类名都对得上、而且只有一个物料 → 自动对上 (有「区分」多个编码的不自动, 留人挑)
    (select min(p.id::text)::uuid from app.products p join app.categories c on c.id = p.category_id
      where p.org_id = p_org and p.active
        and upper(p.model) = split_part(split_part(upper(trim(coalesce(p_descr, ''))), ' ', 1), '/', 1)
        and (' ' || upper(regexp_replace(trim(coalesce(p_descr, '')), '\s+', ' ', 'g')) || ' ') like '% ' || upper(c.name) || ' %'
      having count(*) = 1))
$$;

-- 国内 / 中方建或改采购单 (系统里建). 有入库记录后不能再改行.
-- p_data: {po_no?, supplier, purpose local|fob, fob_project_id, batch_name, ordered_on, shipped_on, eta, mode, inbound_no, request_id, note}
-- p_lines: [{product_id?, descr?, qty, unit_price?, currency?}]
create or replace function app.save_po(p_org uuid, p_id uuid, p_data jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id; x jsonb; v_p uuid; v_purpose text := coalesce(nullif(p_data->>'purpose', ''), 'local');
begin
  perform app.require_role(p_org, 'admin', 'manager', 'cn_support');
  if v_purpose not in ('local','fob') then raise exception 'VALIDATION: 用途只能是 本地备货 或 FOB'; end if;
  if v_purpose = 'fob' and nullif(p_data->>'fob_project_id', '') is null and nullif(trim(p_data->>'fob_customer'), '') is null then raise exception 'VALIDATION: FOB 的采购单要选 FOB 项目，或写上 FOB 客户'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'VALIDATION: 采购单至少要有一行'; end if;
  if v_id is null then
    insert into app.purchase_orders (org_id, po_no, source, created_by)
    values (p_org, coalesce(nullif(trim(p_data->>'po_no'), ''), app.next_doc_no(p_org, 'PO')), 'system', app.uid()) returning id into v_id;
  elsif exists (select 1 from app.po_lines where po_id = v_id and (qty_received > 0 or closed_qty > 0)) then
    raise exception 'BAD_STATE: 这张采购单已经有到货 / 关过差额，不能再改行';
  end if;
  update app.purchase_orders set supplier = nullif(trim(p_data->>'supplier'), ''), purpose = v_purpose,
    fob_project_id = case when v_purpose = 'fob' then nullif(p_data->>'fob_project_id', '')::uuid end,
    batch_name = nullif(trim(p_data->>'batch_name'), ''), ordered_on = nullif(p_data->>'ordered_on', '')::date,
    shipped_on = nullif(p_data->>'shipped_on', '')::date, eta = nullif(p_data->>'eta', '')::date,
    mode = coalesce(nullif(p_data->>'mode', ''), mode),
    warehouse_nos = case when nullif(trim(p_data->>'inbound_no'), '') is null then warehouse_nos else array[upper(trim(p_data->>'inbound_no'))] end,
    request_id = coalesce(nullif(p_data->>'request_id', '')::uuid, request_id), note = coalesce(nullif(p_data->>'note', ''), note), updated_at = now(),
    fob_customer_codes = case when v_purpose = 'fob' and nullif(trim(p_data->>'fob_customer'), '') is not null then array[upper(trim(p_data->>'fob_customer'))] else fob_customer_codes end
  where id = v_id;
  delete from app.po_lines where po_id = v_id;
  for x in select * from jsonb_array_elements(p_lines) loop
    if coalesce((x->>'qty')::int, 0) <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
    v_p := coalesce(nullif(x->>'product_id', '')::uuid, app.match_descr(p_org, x->>'descr', x->>'code'));
    insert into app.po_lines (po_id, product_id, model, descr, qty, unit_price, currency, fob_qty, fob_customer, alloc_source)
    values (v_id, v_p, coalesce((select model from app.products where id = v_p), x->>'descr'), nullif(trim(x->>'descr'), ''), (x->>'qty')::int,
            nullif(x->>'unit_price', '')::numeric, coalesce(nullif(x->>'currency', ''), 'CNY'),
            case when v_purpose = 'fob' then (x->>'qty')::int else 0 end, null, 'manual');
  end loop;
  if nullif(p_data->>'request_id', '') is not null then
    update app.purchase_requests set status = 'ordered', po_no = (select po_no from app.purchase_orders where id = v_id), updated_at = now()
    where id = (p_data->>'request_id')::uuid and status in ('draft','submitted');
  end if;
  perform app.audit(p_org, 'save_po', 'purchase_orders', v_id, jsonb_build_object('lines', jsonb_array_length(p_lines)));
  return v_id;
end $$;

-- 导入一份箱单 (浏览器读好 Excel 传进来): 按入仓号 / 需求批次找采购单, 没有就新建; 行 + 箱号整份替换 (已经有到货的不许替换)
-- p: {batch_name, date, inbound_no, purpose local|fob, fob_project_id?, fob_customer?, supplier?,
--     lines: [{descr, code?, qty, unit_price?, currency?}], boxes: [{box_no, descr, qty}]}
create or replace function app.import_packing_list(p_org uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; x jsonb; v_p uuid; v_line uuid; v_d text; v_unmatched text[] := '{}'; v_purpose text := coalesce(nullif(p->>'purpose', ''), 'local');
  v_in text := upper(nullif(trim(p->>'inbound_no'), '')); v_batch text := nullif(trim(p->>'batch_name'), ''); n_box int := 0;
begin
  perform app.require_role(p_org, 'admin', 'manager', 'cn_support');
  if v_batch is null and v_in is null then raise exception 'VALIDATION: 箱单上找不到需求批次（Invoice No）也找不到入仓号'; end if;
  if jsonb_array_length(coalesce(p->'lines', '[]')) = 0 then raise exception 'VALIDATION: 箱单里没有货'; end if;
  select id into v_id from app.purchase_orders
  where org_id = p_org and ((v_in is not null and v_in = any(warehouse_nos)) or (v_batch is not null and (batch_name = v_batch or po_no = v_batch)))
  order by created_at limit 1;
  if v_id is not null and exists (select 1 from app.po_lines where po_id = v_id and (qty_received > 0 or closed_qty > 0)) then
    raise exception 'BAD_STATE: 这批货（%）已经有到货记录，不能再用箱单覆盖', coalesce(v_batch, v_in);
  end if;
  if v_id is null then
    insert into app.purchase_orders (org_id, po_no, source, created_by) values (p_org, coalesce(v_batch, v_in), 'packing_list', app.uid()) returning id into v_id;
  end if;
  update app.purchase_orders set batch_name = coalesce(v_batch, batch_name), purpose = v_purpose,
    fob_project_id = case when v_purpose = 'fob' then coalesce(nullif(p->>'fob_project_id', '')::uuid, fob_project_id) end,
    fob_customer_codes = case when nullif(p->>'fob_customer', '') is not null then array[p->>'fob_customer'] else fob_customer_codes end,
    shipped_on = coalesce(nullif(p->>'date', '')::date, shipped_on), supplier = coalesce(nullif(trim(p->>'supplier'), ''), supplier),
    warehouse_nos = case when v_in is null then warehouse_nos when v_in = any(warehouse_nos) then warehouse_nos else warehouse_nos || v_in end,
    boxes = (select count(distinct (b->>'box_no')) from jsonb_array_elements(coalesce(p->'boxes', '[]')) b),
    pcs = (select sum((l->>'qty')::int) from jsonb_array_elements(p->'lines') l), updated_at = now()
  where id = v_id;
  delete from app.po_lines where po_id = v_id;   -- 箱号跟着行删 (cascade)
  for x in select * from jsonb_array_elements(p->'lines') loop
    v_d := upper(regexp_replace(trim(coalesce(x->>'descr', '')), '\s+', ' ', 'g'));
    v_p := app.match_descr(p_org, v_d, x->>'code');
    if v_p is null then v_unmatched := v_unmatched || v_d; end if;
    insert into app.po_lines (po_id, product_id, model, descr, qty, unit_price, currency, fob_qty, fob_customer, alloc_source)
    values (v_id, v_p, coalesce((select model from app.products where id = v_p), v_d), v_d, (x->>'qty')::int, nullif(x->>'unit_price', '')::numeric,
            coalesce(nullif(x->>'currency', ''), 'CNY'), case when v_purpose = 'fob' then (x->>'qty')::int else 0 end, nullif(p->>'fob_customer', ''), 'manual');
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'boxes', '[]')) loop
    v_d := upper(regexp_replace(trim(coalesce(x->>'descr', '')), '\s+', ' ', 'g'));
    select id into v_line from app.po_lines where po_id = v_id and descr = v_d limit 1;
    if v_line is null then select id into v_line from app.po_lines where po_id = v_id order by qty desc limit 1; end if;
    insert into app.po_boxes (po_id, box_no, po_line_id, qty) values (v_id, (x->>'box_no')::int, v_line, (x->>'qty')::int)
    on conflict (po_id, box_no, po_line_id) do update set qty = app.po_boxes.qty + excluded.qty;
    n_box := n_box + 1;
  end loop;
  perform app.audit(p_org, 'import_packing_list', 'purchase_orders', v_id, jsonb_build_object('batch', v_batch, 'inbound', v_in, 'boxes', n_box));
  return jsonb_build_object('po_id', v_id, 'unmatched', to_jsonb(v_unmatched), 'boxes', n_box);
end $$;

-- 人工对上一个写法 → 物料 (记住, 同一写法的采购行一起补上)
create or replace function app.map_descr(p_org uuid, p_descr text, p_product uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_d text := upper(regexp_replace(trim(coalesce(p_descr, '')), '\s+', ' ', 'g')); n int;
begin
  perform app.require_role(p_org, 'admin', 'manager', 'cn_support');
  if v_d = '' then raise exception 'VALIDATION: 写法是空的'; end if;
  if not exists (select 1 from app.products where id = p_product and org_id = p_org) then raise exception 'NOT_FOUND: 物料不存在'; end if;
  insert into app.desc_map values (p_org, v_d, p_product) on conflict (org_id, descr) do update set product_id = excluded.product_id;
  update app.po_lines l set product_id = p_product, model = (select model from app.products where id = p_product)
  from app.purchase_orders p where p.id = l.po_id and p.org_id = p_org and l.descr = v_d and l.qty_received = 0;
  get diagnostics n = row_count;
  return n;
end $$;

-- 到货: 勾选到了哪些箱 → 一次下推一张采购入库单 (本地进 LA / 9S, FOB 进 FOB 仓); 入库照片必传
create or replace function app.receive_boxes(p_po uuid, p_boxes uuid[], p_warehouse text, p_photo text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare po app.purchase_orders; v_rows jsonb; v_id uuid;
begin
  select * into po from app.purchase_orders where id = p_po;
  if po.id is null then raise exception 'NOT_FOUND: 采购单'; end if;
  perform app.require_role(po.org_id, 'manager');
  if coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 到货要拍照（箱子 / 入仓单）'; end if;
  if coalesce(array_length(p_boxes, 1), 0) = 0 then raise exception 'VALIDATION: 勾选到了哪些箱'; end if;
  if exists (select 1 from app.po_boxes where id = any(p_boxes) and (po_id <> p_po or status <> 'transit')) then raise exception 'BAD_STATE: 有的箱不在这张单上，或者已经收过'; end if;
  if exists (select 1 from app.po_boxes b join app.po_lines l on l.id = b.po_line_id where b.id = any(p_boxes) and l.product_id is null) then
    raise exception 'VALIDATION: 有的箱里的货还没对上系统编码，先在采购单里「对上编码」';
  end if;
  select jsonb_agg(jsonb_build_object('line_id', b.po_line_id,
           'local_qty', case when po.purpose = 'fob' then 0 else b.q end, 'fob_qty', case when po.purpose = 'fob' then b.q else 0 end,
           'warehouse', coalesce(nullif(p_warehouse, ''), 'LA')))
  into v_rows
  from (select po_line_id, sum(qty)::int as q from app.po_boxes where id = any(p_boxes) group by po_line_id) b;
  v_id := app.receive_po_split(p_po, v_rows, p_photo, p_note);
  update app.po_boxes set status = 'received', receipt_id = v_id where id = any(p_boxes);
  return v_id;
end $$;

-- 少到的差额: 只有中方能关; 必须从选项里选结果 + 传凭证; 关掉的是这行剩下的全部 (不手填数)
create or replace function app.close_po_gap(p_line uuid, p_result text, p_proof text, p_note text default null)
returns int language plpgsql security definer set search_path = app, public as $$
declare l app.po_lines; v_org uuid; v_left int;
begin
  select * into l from app.po_lines where id = p_line for update;
  select org_id into v_org from app.purchase_orders where id = l.po_id;
  perform app.require_role(v_org, 'admin');
  if coalesce(p_result, '') not in ('破损','少发','国内取消','丢失','补发中（另开单）','其他') then raise exception 'VALIDATION: 选一个结果'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 关差额要传凭证（截图 / 照片）'; end if;
  if p_result = '其他' and coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 选「其他」要写清楚'; end if;
  v_left := l.qty - l.qty_received - l.closed_qty;
  if v_left <= 0 then raise exception 'BAD_STATE: 这一行没有差额了'; end if;
  update app.po_lines set closed_qty = closed_qty + v_left, close_result = p_result, close_proof = p_proof, close_note = nullif(trim(p_note), ''),
    closed_by = app.uid(), closed_at = now() where id = p_line;
  update app.po_boxes set status = 'missing' where po_line_id = p_line and status = 'transit';
  perform app.audit(v_org, 'close_po_gap', 'po_lines', p_line, jsonb_build_object('qty', v_left, 'result', p_result));
  return v_left;
end $$;

-- 物料申请的进度国内也能推 (已下单 / 已发货 …)
create or replace function app.advance_purchase_request(p_id uuid, p_to text, p_data jsonb default '{}')
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.purchase_requests;
begin
  select * into r from app.purchase_requests where id = p_id for update;
  perform app.require_role(r.org_id, 'manager', 'finance', 'cn_support');
  if p_to not in ('ordered','shipped','arrived','received','cancelled') then raise exception 'VALIDATION: 状态无效'; end if;
  update app.purchase_requests set status = p_to, po_no = coalesce(nullif(p_data->>'po_no',''), po_no), logistics = coalesce(nullif(p_data->>'logistics',''), logistics),
    tracking = coalesce(nullif(p_data->>'tracking',''), tracking), container = coalesce(nullif(p_data->>'container',''), container),
    eta = coalesce(nullif(p_data->>'eta','')::date, eta), planned_ship = coalesce(nullif(p_data->>'planned_ship','')::date, planned_ship), updated_at = now()
  where id = p_id;
end $$;

-- ───────────────────────── ③ 报价草稿 ─────────────────────────
create table app.quote_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  user_id uuid not null,
  customer_id uuid not null references app.customers(id),
  data jsonb not null,                  -- {lines:[...], currency, fx, note, ...} 新建报价页的整份内容
  n_lines int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id, user_id, customer_id)
);
alter table app.quote_drafts enable row level security;
create policy read_own on app.quote_drafts for select using (app.is_member(org_id));

create or replace function app.save_quote_draft(p_org uuid, p_customer uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_n int := jsonb_array_length(coalesce(p_data->'lines', '[]')); v_id uuid; v_min int;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED: 不是本组织成员'; end if;
  v_min := coalesce((select (value->>'min_lines')::int from app.org_settings where org_id = p_org and key = 'draft_rules'), 5);
  if v_n < v_min then return null; end if;    -- 不够行数不存 (丢了再建一张)
  insert into app.quote_drafts (org_id, user_id, customer_id, data, n_lines) values (p_org, app.uid(), p_customer, p_data, v_n)
  on conflict (org_id, user_id, customer_id) do update set data = excluded.data, n_lines = excluded.n_lines, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function app.delete_quote_draft(p_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.quote_drafts;
begin
  select * into d from app.quote_drafts where id = p_id;
  if d.id is null then return; end if;
  if d.user_id <> app.uid() and not app.has_role(d.org_id, array['admin']::app.role_name[]) then raise exception 'PERMISSION_DENIED: 只能删自己的草稿'; end if;
  delete from app.quote_drafts where id = p_id;
end $$;

-- 草稿 N 天没动自动删 (draft_rules.days, 默认 7); 等中方定档的报价不再自动作废 (算进行中、卡单)
create or replace function app.void_stale_drafts(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int; v_days int;
begin
  if not app.is_member(p_org) then raise exception 'FORBIDDEN'; end if;
  v_days := coalesce((select (value->>'days')::int from app.org_settings where org_id = p_org and key = 'draft_rules'), 7);
  delete from app.quote_drafts where org_id = p_org and updated_at < now() - make_interval(days => v_days);
  get diagnostics n = row_count;
  return n;
end $$;

-- 改采购单资料 (不动行和箱): 预计到货 / 发货日 / 供应商 / 方式 / 备注 —— 到了一部分以后也能改 (国内跟货代确认后改 ETA)
create or replace function app.set_po_info(p_po uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.purchase_orders where id = p_po;
  if v_org is null then raise exception 'NOT_FOUND: 采购单'; end if;
  perform app.require_role(v_org, 'admin', 'manager', 'cn_support');
  update app.purchase_orders set
    eta = case when p_data ? 'eta' then nullif(p_data->>'eta', '')::date else eta end,
    shipped_on = case when p_data ? 'shipped_on' then nullif(p_data->>'shipped_on', '')::date else shipped_on end,
    supplier = case when p_data ? 'supplier' then nullif(trim(p_data->>'supplier'), '') else supplier end,
    mode = coalesce(nullif(p_data->>'mode', ''), mode),
    note = case when p_data ? 'note' then nullif(trim(p_data->>'note'), '') else note end, updated_at = now()
  where id = p_po;
  perform app.audit(v_org, 'set_po_info', 'purchase_orders', p_po, p_data);
end $$;

revoke all on function app.save_po(uuid, uuid, jsonb, jsonb), app.import_packing_list(uuid, jsonb), app.map_descr(uuid, text, uuid),
  app.receive_boxes(uuid, uuid[], text, text, text), app.close_po_gap(uuid, text, text, text), app.save_quote_draft(uuid, uuid, jsonb),
  app.delete_quote_draft(uuid), app.match_descr(uuid, text, text), app.set_po_info(uuid, jsonb) from public;
grant execute on function app.save_po(uuid, uuid, jsonb, jsonb), app.import_packing_list(uuid, jsonb), app.map_descr(uuid, text, uuid),
  app.receive_boxes(uuid, uuid[], text, text, text), app.close_po_gap(uuid, text, text, text), app.save_quote_draft(uuid, uuid, jsonb),
  app.delete_quote_draft(uuid), app.set_po_info(uuid, jsonb) to authenticated;
grant select on app.po_boxes, app.desc_map, app.quote_drafts to authenticated;
