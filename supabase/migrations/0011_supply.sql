-- LA&9S Operations · 0011 采购在途 · 备货看板 · 库龄 · 初始导入 (Frank 2026-10-29)
-- 初始导入只导主数据和期初: 物料 (含 Material Information 定价)、客户、库存 (含库龄)、在途采购、应收期初 (按单据日期, 才有账龄).
-- 历史销售订单和出库单不导 (Frank: 不包含销售订单和销售出库单).

-- ── 应收期初按单据导, 才算得出账龄 ──
alter table app.deals add column opened_on date;      -- 期初单的原单据日期 (金蝶应收单日期)

create or replace view app.v_deal_totals as
select d.id as deal_id, d.org_id, d.customer_id, d.currency, d.kind, d.status,
  coalesce((select sum(sl.amount) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id
            where sh.deal_id = d.id and sh.voided_at is null), 0)
  + coalesce((select sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'opening'), 0) as shipped_amount,
  coalesce((select sum(r.amount) from app.returns r where r.deal_id = d.id and r.status = 'approved'), 0) as returned_amount,
  coalesce((select sum(a.amount) from app.receipt_allocations a where a.deal_id = d.id), 0) as allocated_amount,
  coalesce((select min(sh.shipped_at) from app.shipments sh where sh.deal_id = d.id and sh.voided_at is null), d.opened_on::timestamptz) as first_shipped_at,
  coalesce((select -sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'writeoff'), 0) as writeoff_amount
from app.deals d;

-- p_rows: [{customer_code, currency?, amount, date, ref?}]; 找不到客户的行原样退回
create or replace function app.import_opening_items(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_c uuid; v_deal uuid; n int := 0; v_total numeric := 0; v_missing jsonb := '[]';
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    continue when coalesce((x->>'amount')::numeric, 0) = 0;
    select id into v_c from app.customers where org_id = p_org and code = upper(trim(x->>'customer_code'));
    if not found then v_missing := v_missing || jsonb_build_array(x); continue; end if;
    insert into app.deals (org_id, kind, biz_no, customer_id, currency, status, note, created_by, opened_on)
    values (p_org, 'opening', app.next_doc_no(p_org, 'OPEN'), v_c, coalesce(nullif(x->>'currency',''), 'XOF'), 'shipped',
      concat_ws(' · ', '期初导入', nullif(x->>'ref','')), app.uid(), nullif(x->>'date','')::date)
    returning id into v_deal;
    insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, note)
    values (p_org, v_c, coalesce(nullif(x->>'currency',''), 'XOF'), 'opening', (x->>'amount')::numeric, v_deal, x->>'ref');
    n := n + 1; v_total := v_total + (x->>'amount')::numeric;
  end loop;
  perform app.audit(p_org, 'import_opening_items', 'deals', null, jsonb_build_object('n', n, 'total', v_total, 'missing', jsonb_array_length(v_missing)));
  return jsonb_build_object('n', n, 'total', v_total, 'missing', v_missing);
end $$;

-- 应收账龄 (按单据 / 首次出库日期; 只算还欠的)
create view app.v_ar_aging as
select t.org_id, t.customer_id, t.currency,
  sum(t.due) as due,
  sum(t.due) filter (where current_date - t.first_shipped_at::date <= 30) as d0_30,
  sum(t.due) filter (where current_date - t.first_shipped_at::date between 31 and 60) as d31_60,
  sum(t.due) filter (where current_date - t.first_shipped_at::date between 61 and 90) as d61_90,
  sum(t.due) filter (where current_date - t.first_shipped_at::date between 91 and 180) as d91_180,
  sum(t.due) filter (where current_date - t.first_shipped_at::date > 180) as d180,
  sum(t.due) filter (where t.first_shipped_at is null) as d_unknown,
  max(current_date - t.first_shipped_at::date) as oldest_days
from app.v_deal_due t where t.due > 0
group by 1,2,3;

-- ── 物料母表导入 (Material Information) ──
-- p_rows: [{code, category, model, brand?, brand_group?, cost_owner?, bin?, shared_models?: [..], rmb_cost?, freight?, fee_s?, fee_a?, fee_b?, fee_c?, kingdee_code?}]
create or replace function app.import_products(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_cat uuid; v_id uuid; n_new int := 0; n_upd int := 0; n_bad int := 0; v_ids uuid[] := '{}'; v_bad jsonb := '[]';
  v_model text; v_code text;
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    v_code := nullif(trim(x->>'code'), ''); v_model := upper(nullif(trim(x->>'model'), ''));
    if v_code is null or v_model is null or coalesce(trim(x->>'category'),'') = '' then n_bad := n_bad + 1; v_bad := v_bad || jsonb_build_array(x); continue; end if;
    select id into v_cat from app.categories where org_id = p_org and upper(name) = upper(trim(x->>'category'));
    if not found then
      insert into app.categories (org_id, name, sort) values (p_org, upper(trim(x->>'category')), 100) returning id into v_cat;
    end if;
    select id into v_id from app.products where org_id = p_org and code = v_code;
    if found then
      update app.products set category_id = v_cat, model = v_model,
        brand = coalesce(nullif(x->>'brand',''), brand), brand_group = coalesce(nullif(x->>'brand_group',''), brand_group),
        cost_owner = coalesce(nullif(x->>'cost_owner',''), cost_owner), bin_default = coalesce(nullif(x->>'bin',''), bin_default),
        kingdee_code = coalesce(nullif(x->>'kingdee_code',''), kingdee_code),
        shared_models = coalesce((select array_agg(upper(trim(v))) from jsonb_array_elements_text(x->'shared_models') v where trim(v) <> ''), shared_models),
        rmb_cost = coalesce(nullif(x->>'rmb_cost','')::numeric, rmb_cost), freight_xof = coalesce(nullif(x->>'freight','')::numeric, freight_xof),
        fee_s = coalesce(nullif(x->>'fee_s','')::numeric, fee_s), fee_a = coalesce(nullif(x->>'fee_a','')::numeric, fee_a),
        fee_b = coalesce(nullif(x->>'fee_b','')::numeric, fee_b), fee_c = coalesce(nullif(x->>'fee_c','')::numeric, fee_c),
        cost_updated_at = case when x ? 'rmb_cost' then now() else cost_updated_at end
      where id = v_id;
      n_upd := n_upd + 1;
    else
      begin
        insert into app.products (org_id, code, kingdee_code, category_id, model, brand, brand_group, cost_owner, bin_default, shared_models,
          rmb_cost, freight_xof, fee_s, fee_a, fee_b, fee_c, cost_updated_at)
        values (p_org, v_code, nullif(x->>'kingdee_code',''), v_cat, v_model, nullif(x->>'brand',''), nullif(x->>'brand_group',''),
          nullif(x->>'cost_owner',''), nullif(x->>'bin',''),
          coalesce((select array_agg(upper(trim(v))) from jsonb_array_elements_text(x->'shared_models') v where trim(v) <> ''), '{}'),
          nullif(x->>'rmb_cost','')::numeric, nullif(x->>'freight','')::numeric, nullif(x->>'fee_s','')::numeric, nullif(x->>'fee_a','')::numeric,
          nullif(x->>'fee_b','')::numeric, nullif(x->>'fee_c','')::numeric, case when x ? 'rmb_cost' then now() end)
        returning id into v_id;
        n_new := n_new + 1;
      exception when unique_violation then
        n_bad := n_bad + 1; v_bad := v_bad || jsonb_build_array(x || '{"why":"同种类同型号已有别的编码"}'); continue;
      end;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  perform app.recompute_prices(p_org, v_ids);
  perform app.audit(p_org, 'import_products', 'products', null, jsonb_build_object('new', n_new, 'updated', n_upd, 'bad', n_bad));
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'bad', n_bad, 'bad_rows', v_bad);
end $$;

-- ── 库存期初 + 库龄快照 ──
create table app.stock_aging (
  org_id uuid not null references app.orgs(id),
  as_of date not null,
  product_id uuid not null references app.products(id),
  warehouse_id uuid not null references app.warehouses(id),
  qty int not null,
  a0_30 int not null default 0, a31_90 int not null default 0, a91_180 int not null default 0, a181_365 int not null default 0, a365 int not null default 0,
  primary key (org_id, as_of, product_id, warehouse_id)
);
alter table app.stock_aging enable row level security;
create policy read_own on app.stock_aging for select using (app.is_member(org_id));

-- p_rows: [{code, warehouse, qty, bin?, a0_30?, a31_90?, a91_180?, a181_365?, a365?}]
-- 把实存「对齐」到导入数 (差额记一笔 opening 库存移动), 不能低于已预占
create or replace function app.import_stock(p_org uuid, p_as_of date, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_p uuid; v_w uuid; v_s uuid; v_cur int; v_res int; v_q int; n int := 0; v_bad jsonb := '[]';
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into v_p from app.products where org_id = p_org and (code = trim(x->>'code') or kingdee_code = trim(x->>'code'));
    if not found then v_bad := v_bad || jsonb_build_array(x || '{"why":"物料编码不存在"}'); continue; end if;
    select id into v_w from app.warehouses where org_id = p_org and upper(code) = upper(trim(x->>'warehouse'));
    if not found then v_bad := v_bad || jsonb_build_array(x || '{"why":"仓库不存在"}'); continue; end if;
    v_q := greatest(coalesce((x->>'qty')::numeric, 0), 0)::int;
    insert into app.stock_items (warehouse_id, product_id, bin) values (v_w, v_p, nullif(x->>'bin',''))
    on conflict (warehouse_id, product_id) do update set bin = coalesce(excluded.bin, app.stock_items.bin)
    returning id, qty_on_hand, qty_reserved into v_s, v_cur, v_res;
    if v_q < v_res then v_bad := v_bad || jsonb_build_array(x || jsonb_build_object('why', '比已预占 ' || v_res || ' 还少')); continue; end if;
    if v_q <> v_cur then perform app.move_stock(v_s, v_q - v_cur, 'opening', 'import', null); end if;
    insert into app.stock_aging (org_id, as_of, product_id, warehouse_id, qty, a0_30, a31_90, a91_180, a181_365, a365)
    values (p_org, p_as_of, v_p, v_w, v_q, coalesce((x->>'a0_30')::numeric, 0), coalesce((x->>'a31_90')::numeric, 0), coalesce((x->>'a91_180')::numeric, 0),
      coalesce((x->>'a181_365')::numeric, 0), coalesce((x->>'a365')::numeric, 0))
    on conflict (org_id, as_of, product_id, warehouse_id) do update set qty = excluded.qty, a0_30 = excluded.a0_30, a31_90 = excluded.a31_90,
      a91_180 = excluded.a91_180, a181_365 = excluded.a181_365, a365 = excluded.a365;
    n := n + 1;
  end loop;
  perform app.audit(p_org, 'import_stock', 'stock_items', null, jsonb_build_object('n', n, 'bad', jsonb_array_length(v_bad), 'as_of', p_as_of));
  return jsonb_build_object('n', n, 'bad', jsonb_array_length(v_bad), 'bad_rows', v_bad);
end $$;

-- ── 采购在途 ──
create table app.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  po_no text not null,                           -- 金蝶采购订单号
  supplier text,
  mode text not null default 'sea' check (mode in ('sea','air','other')),
  ordered_on date, eta date,
  status text not null default 'open' check (status in ('open','closed')),
  note text, created_at timestamptz not null default now(),
  unique (org_id, po_no)
);
create table app.po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references app.purchase_orders(id) on delete cascade,
  product_id uuid references app.products(id),
  model text,                                    -- 没编码的新货先写型号
  qty int not null check (qty > 0),
  qty_received int not null default 0 check (qty_received >= 0 and qty_received <= qty)
);
alter table app.purchase_orders enable row level security;
alter table app.po_lines enable row level security;
create policy read_own on app.purchase_orders for select using (app.is_member(org_id));
create policy read_own on app.po_lines for select using (exists (select 1 from app.purchase_orders p where p.id = po_id and app.is_member(p.org_id)));

-- p_rows: [{po_no, supplier?, mode?, ordered_on?, eta?, code?, model?, qty, qty_received?}] —— 同一单号的行合并; 已存在的单整单重写 (还没收货的)
create or replace function app.import_purchase_orders(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare g record; x jsonb; v_po uuid; v_p uuid; n_po int := 0; n_line int := 0; n_skip int := 0;
begin
  perform app.require_role(p_org, 'admin');
  for g in select r->>'po_no' as po_no, jsonb_agg(r) as rows from jsonb_array_elements(p_rows) r where coalesce(r->>'po_no','') <> '' group by 1 loop
    x := g.rows->0;
    select id into v_po from app.purchase_orders where org_id = p_org and po_no = g.po_no;
    if found then
      if exists (select 1 from app.po_lines where po_id = v_po and qty_received > 0) and not exists (select 1 from jsonb_array_elements(g.rows) r where r ? 'qty_received') then
        n_skip := n_skip + 1; continue;    -- 已经在系统里收过货的单, 不拿外部数据覆盖
      end if;
      delete from app.po_lines where po_id = v_po;
      update app.purchase_orders set supplier = x->>'supplier', mode = coalesce(nullif(x->>'mode',''), mode), ordered_on = nullif(x->>'ordered_on','')::date,
        eta = nullif(x->>'eta','')::date where id = v_po;
    else
      insert into app.purchase_orders (org_id, po_no, supplier, mode, ordered_on, eta)
      values (p_org, g.po_no, x->>'supplier', coalesce(nullif(x->>'mode',''), 'sea'), nullif(x->>'ordered_on','')::date, nullif(x->>'eta','')::date)
      returning id into v_po;
    end if;
    n_po := n_po + 1;
    for x in select * from jsonb_array_elements(g.rows) loop
      v_p := null;
      select id into v_p from app.products where org_id = p_org and (code = trim(x->>'code') or kingdee_code = trim(x->>'code'));
      insert into app.po_lines (po_id, product_id, model, qty, qty_received)
      values (v_po, v_p, upper(nullif(trim(x->>'model'),'')), (x->>'qty')::numeric::int, least(coalesce((x->>'qty_received')::numeric, 0), (x->>'qty')::numeric)::int);
      n_line := n_line + 1;
    end loop;
    update app.purchase_orders set status = case when not exists (select 1 from app.po_lines where po_id = v_po and qty_received < qty) then 'closed' else 'open' end where id = v_po;
  end loop;
  perform app.audit(p_org, 'import_purchase_orders', 'purchase_orders', null, jsonb_build_object('po', n_po, 'lines', n_line, 'skipped', n_skip));
  return jsonb_build_object('po', n_po, 'lines', n_line, 'skipped', n_skip);
end $$;

-- 到货入库: p_rows [{line_id, qty, warehouse}] → 进本地仓, 在途减少
create or replace function app.receive_po(p_po uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare po app.purchase_orders; x jsonb; l app.po_lines; v_w uuid; v_s uuid; v_q int;
begin
  select * into po from app.purchase_orders where id = p_po for update;
  perform app.require_role(po.org_id, 'manager');
  for x in select * from jsonb_array_elements(p_rows) loop
    v_q := (x->>'qty')::int;
    continue when coalesce(v_q, 0) <= 0;
    select * into l from app.po_lines where id = (x->>'line_id')::uuid and po_id = p_po for update;
    if not found then raise exception 'NOT_FOUND: 采购行'; end if;
    if l.product_id is null then raise exception 'VALIDATION: % 还没有物料编码，先让中方建编码', l.model; end if;
    if l.qty_received + v_q > l.qty then raise exception 'VALIDATION: 收货数超过采购数'; end if;
    select id into v_w from app.warehouses where org_id = po.org_id and upper(code) = upper(x->>'warehouse') and kind = 'local';
    if not found then raise exception 'VALIDATION: 到货只能进 LA 仓或 9S 仓'; end if;
    insert into app.stock_items (warehouse_id, product_id) values (v_w, l.product_id) on conflict (warehouse_id, product_id) do nothing;
    select id into v_s from app.stock_items where warehouse_id = v_w and product_id = l.product_id;
    perform app.move_stock(v_s, v_q, 'grn', 'po', p_po);
    update app.po_lines set qty_received = qty_received + v_q where id = l.id;
  end loop;
  update app.purchase_orders set status = case when not exists (select 1 from app.po_lines where po_id = p_po and qty_received < qty) then 'closed' else 'open' end where id = p_po;
  perform app.audit(po.org_id, 'receive_po', 'purchase_orders', p_po, p_rows);
end $$;

-- ── 备货看板 ──
create table app.replenish_settings (
  org_id uuid primary key references app.orgs(id),
  cover_days int not null default 60,       -- 备够几天的货
  sea_days int not null default 45,         -- 海运到货要几天
  air_days int not null default 10
);
alter table app.replenish_settings enable row level security;
create policy read_own on app.replenish_settings for select using (app.is_member(org_id));

create or replace function app.set_replenish_settings(p_org uuid, p_cover int, p_sea int, p_air int)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  if least(p_cover, p_sea, p_air) <= 0 then raise exception 'VALIDATION: 天数要大于 0'; end if;
  insert into app.replenish_settings values (p_org, p_cover, p_sea, p_air)
  on conflict (org_id) do update set cover_days = excluded.cover_days, sea_days = excluded.sea_days, air_days = excluded.air_days;
end $$;

-- 每个物料: 本地可售 + 在途, 近 30 / 90 天出库, 欠客户的缺口, 能撑几天, 建议补多少
create view app.v_replenish as
with loc as (
  select s.product_id, sum(s.qty_on_hand) as on_hand, sum(s.qty_reserved) as reserved
  from app.stock_items s join app.warehouses w on w.id = s.warehouse_id and w.kind = 'local' group by 1
), tr as (
  select l.product_id, sum(l.qty - l.qty_received) as in_transit, min(p.eta) as eta
  from app.po_lines l join app.purchase_orders p on p.id = l.po_id and p.status = 'open' where l.product_id is not null group by 1
), sold as (
  select dl.product_id,
    sum(sl.qty) filter (where sh.shipped_at > now() - interval '30 days') as sold_30,
    sum(sl.qty) filter (where sh.shipped_at > now() - interval '90 days') as sold_90
  from app.shipment_lines sl join app.shipments sh on sh.id = sl.shipment_id and sh.voided_at is null
  join app.deal_lines dl on dl.id = sl.deal_line_id where sh.shipped_at > now() - interval '90 days' group by 1
), short as (
  select product_id, sum(qty_unmet) as short_qty, count(distinct customer_id) as short_customers
  from app.v_unmet_demand where kind = 'short' and created_at > now() - interval '90 days' group by 1
), age as (
  select a.product_id, sum(a.a181_365 + a.a365) as aged_180
  from app.stock_aging a where a.as_of = (select max(as_of) from app.stock_aging b where b.org_id = a.org_id) group by 1
)
select p.org_id, p.id as product_id, p.code, p.model, p.brand, c.name as category,
  coalesce(loc.on_hand, 0) as on_hand, coalesce(loc.reserved, 0) as reserved, coalesce(loc.on_hand, 0) - coalesce(loc.reserved, 0) as available,
  coalesce(tr.in_transit, 0) as in_transit, tr.eta,
  coalesce(sold.sold_30, 0) as sold_30, coalesce(sold.sold_90, 0) as sold_90,
  round(greatest(coalesce(sold.sold_30, 0) / 30.0, coalesce(sold.sold_90, 0) / 90.0), 2) as daily,
  coalesce(short.short_qty, 0) as short_qty, coalesce(short.short_customers, 0) as short_customers,
  coalesce(age.aged_180, 0) as aged_180,
  case when greatest(coalesce(sold.sold_30, 0) / 30.0, coalesce(sold.sold_90, 0) / 90.0) > 0
    then floor((coalesce(loc.on_hand, 0) - coalesce(loc.reserved, 0)) / greatest(coalesce(sold.sold_30, 0) / 30.0, coalesce(sold.sold_90, 0) / 90.0)) end as days_left,
  greatest(0, ceil(greatest(coalesce(sold.sold_30, 0) / 30.0, coalesce(sold.sold_90, 0) / 90.0) * coalesce(rs.cover_days, 60))
    + coalesce(short.short_qty, 0) - (coalesce(loc.on_hand, 0) - coalesce(loc.reserved, 0)) - coalesce(tr.in_transit, 0))::int as suggest
from app.products p join app.categories c on c.id = p.category_id
left join loc on loc.product_id = p.id left join tr on tr.product_id = p.id left join sold on sold.product_id = p.id
left join short on short.product_id = p.id left join age on age.product_id = p.id
left join app.replenish_settings rs on rs.org_id = p.org_id
where p.active;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.v_ar_aging, app.stock_aging, app.purchase_orders, app.po_lines, app.replenish_settings, app.v_replenish to authenticated;
    grant execute on function app.import_opening_items(uuid, jsonb), app.import_products(uuid, jsonb), app.import_stock(uuid, date, jsonb),
      app.import_purchase_orders(uuid, jsonb), app.receive_po(uuid, jsonb), app.set_replenish_settings(uuid, int, int, int) to authenticated;
  end if;
end $$;
