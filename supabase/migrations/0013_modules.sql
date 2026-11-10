-- LA&9S Operations · 0013 后续模块 (Frank 2026-10-29 16:07「后续的全部搞完」)
-- 1 侧栏配置 (中方调整, 全员生效)   2 销量历史 (备货看板用的按月汇总, 不导单据)
-- 3 FOB 项目   4 员工与工资   5 培训与 SOP   6 金蝶同步 (保存 / 提交 / 审核 + 库存对账)   7 客户下单端 / 门店

-- ───────────────────────── 1 组织设置 (侧栏等) ─────────────────────────
create table app.org_settings (
  org_id uuid not null references app.orgs(id),
  key text not null,
  value jsonb not null,
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (org_id, key)
);
alter table app.org_settings enable row level security;
create policy read_own on app.org_settings for select using (app.is_member(org_id));

create or replace function app.set_org_setting(p_org uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  if p_value is null then delete from app.org_settings where org_id = p_org and key = p_key; return; end if;
  insert into app.org_settings values (p_org, p_key, p_value, app.uid(), now())
  on conflict (org_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform app.audit(p_org, 'set_org_setting', 'org_settings', null, jsonb_build_object('key', p_key));
end $$;

-- ───────────────────────── 2 销量历史 (按编码按月) ─────────────────────────
create table app.sales_history (
  org_id uuid not null references app.orgs(id),
  product_id uuid not null references app.products(id),
  month date not null,                 -- 每月 1 号
  qty int not null,
  source text not null default 'kingdee',
  primary key (org_id, product_id, month)
);
alter table app.sales_history enable row level security;
create policy read_own on app.sales_history for select using (app.is_member(org_id));

-- p_rows: [{code, month:'2026-09', qty}]
create or replace function app.import_sales_history(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_p uuid; n int := 0; v_bad jsonb := '[]'; v_m date;
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into v_p from app.products where org_id = p_org and (code = trim(x->>'code') or kingdee_code = trim(x->>'code'));
    if not found then v_bad := v_bad || jsonb_build_array(x || '{"why":"物料编码不存在"}'); continue; end if;
    v_m := date_trunc('month', (left(x->>'month', 7) || '-01')::date)::date;
    insert into app.sales_history values (p_org, v_p, v_m, round((x->>'qty')::numeric)::int, 'kingdee')
    on conflict (org_id, product_id, month) do update set qty = excluded.qty;
    n := n + 1;
  end loop;
  perform app.audit(p_org, 'import_sales_history', 'sales_history', null, jsonb_build_object('n', n));
  return jsonb_build_object('n', n, 'bad', jsonb_array_length(v_bad), 'bad_rows', v_bad);
end $$;

-- 备货看板: 日均 = max(系统近 30 天, 系统近 90 天, 历史最近 3 个整月) —— 系统刚上线时靠历史
create or replace view app.v_replenish as
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
), hist as (
  select product_id, sum(qty) as hist_3m
  from app.sales_history where month >= (date_trunc('month', current_date) - interval '3 months')::date and month < date_trunc('month', current_date)::date
  group by 1
), short as (
  select product_id, sum(qty_unmet) as short_qty, count(distinct customer_id) as short_customers
  from app.v_unmet_demand where kind = 'short' and created_at > now() - interval '90 days' group by 1
), age as (
  select a.product_id, sum(a.a181_365 + a.a365) as aged_180
  from app.stock_aging a where a.as_of = (select max(as_of) from app.stock_aging b where b.org_id = a.org_id) group by 1
), base as (
  select p.org_id, p.id as product_id, p.code, p.model, p.brand, c.name as category,
    coalesce(loc.on_hand, 0) as on_hand, coalesce(loc.reserved, 0) as reserved, coalesce(loc.on_hand, 0) - coalesce(loc.reserved, 0) as available,
    coalesce(tr.in_transit, 0) as in_transit, tr.eta,
    coalesce(sold.sold_30, 0) as sold_30, coalesce(sold.sold_90, 0) as sold_90,
    round(greatest(coalesce(sold.sold_30, 0) / 30.0, coalesce(sold.sold_90, 0) / 90.0, coalesce(hist.hist_3m, 0) / 91.0), 2) as daily,
    coalesce(short.short_qty, 0) as short_qty, coalesce(short.short_customers, 0) as short_customers,
    coalesce(age.aged_180, 0) as aged_180, coalesce(rs.cover_days, 60) as cover_days, coalesce(hist.hist_3m, 0) as hist_3m, p.variant
  from app.products p join app.categories c on c.id = p.category_id
  left join loc on loc.product_id = p.id left join tr on tr.product_id = p.id left join sold on sold.product_id = p.id
  left join hist on hist.product_id = p.id left join short on short.product_id = p.id left join age on age.product_id = p.id
  left join app.replenish_settings rs on rs.org_id = p.org_id
  where p.active
)
select org_id, product_id, code, model, brand, category, on_hand, reserved, available, in_transit, eta, sold_30, sold_90, daily,
  short_qty, short_customers, aged_180,
  case when daily > 0 then floor(available / daily) end as days_left,
  greatest(0, ceil(daily * cover_days) + short_qty - available - in_transit)::int as suggest,
  hist_3m, variant
from base;

-- ───────────────────────── 3 FOB 项目 ─────────────────────────
-- 一客一单: 申请 → 采购 → 在途 → 到货 (进 FOB 仓) → 放货 → 出库 → 结清. 常规 30% 订金 70% 尾款, 放货由中方人工决定.
-- 科特迪瓦: 仓库控货 (货进 FOB 仓, 我们发货); 多哥等: 物流控货 (货在物流手上, 放货 = 通知物流放)
create table app.fob_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  fob_no text not null,
  customer_id uuid not null references app.customers(id),
  country text not null references app.countries(code),
  control text not null default 'warehouse' check (control in ('warehouse','logistics')),
  currency text not null references app.currencies(code),
  deposit_pct numeric(5,2) not null default 30,
  status text not null default 'applied' check (status in ('applied','purchasing','in_transit','arrived','released','shipped','closed','cancelled')),
  po_no text, logistics text, tracking text, eta date,
  released_by uuid, released_at timestamptz, release_note text,
  note text, created_by uuid, created_at timestamptz not null default now(),
  unique (org_id, fob_no)
);
create table app.fob_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.fob_projects(id) on delete cascade,
  product_id uuid references app.products(id),
  model text not null,
  qty int not null check (qty > 0),
  unit_price numeric(18,2),             -- 中方定
  rmb_cost numeric(18,4),
  qty_received int not null default 0, qty_shipped int not null default 0
);
create table app.fob_payments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.fob_projects(id),
  kind text not null check (kind in ('deposit','balance','other')),
  amount numeric(18,2) not null check (amount > 0),
  on_date date not null, method app.pay_method not null, proof text, note text,
  created_by uuid, created_at timestamptz not null default now()
);
create table app.fob_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references app.fob_projects(id),
  at timestamptz not null default now(), by_user uuid, action text not null, detail jsonb
);
alter table app.fob_projects enable row level security; alter table app.fob_lines enable row level security;
alter table app.fob_payments enable row level security; alter table app.fob_events enable row level security;
create policy read_own on app.fob_projects for select using (app.is_member(org_id));
create policy read_own on app.fob_lines for select using (exists (select 1 from app.fob_projects p where p.id = project_id and app.is_member(p.org_id)));
create policy read_own on app.fob_payments for select using (exists (select 1 from app.fob_projects p where p.id = project_id and app.is_member(p.org_id)));
create policy read_own on app.fob_events for select using (exists (select 1 from app.fob_projects p where p.id = project_id and app.is_member(p.org_id)));

create view app.v_fob as
select p.*, c.code as customer_code, c.name as customer_name,
  coalesce((select sum(l.qty * l.unit_price) from app.fob_lines l where l.project_id = p.id), 0) as total,
  (select count(*) from app.fob_lines l where l.project_id = p.id and l.unit_price is null) as unpriced,
  coalesce((select sum(x.amount) from app.fob_payments x where x.project_id = p.id), 0) as paid,
  coalesce((select sum(l.qty) from app.fob_lines l where l.project_id = p.id), 0) as qty,
  coalesce((select sum(l.qty_received) from app.fob_lines l where l.project_id = p.id), 0) as qty_received,
  coalesce((select sum(l.qty_shipped) from app.fob_lines l where l.project_id = p.id), 0) as qty_shipped
from app.fob_projects p join app.customers c on c.id = p.customer_id;
alter view app.v_fob set (security_invoker = true);

create or replace function app.fob_event(p_project uuid, p_action text, p_detail jsonb default null)
returns void language sql security definer set search_path = app, public as $$
  insert into app.fob_events (project_id, by_user, action, detail) values (p_project, app.uid(), p_action, p_detail)
$$;

-- 申请 (热线 / 销售 / 主管 / 中方): 型号可以还没编码
create or replace function app.create_fob(p_org uuid, p_customer uuid, p_country text, p_control text, p_currency text, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; x jsonb; v_p app.products;
begin
  perform app.require_role(p_org, 'hotline', 'sales', 'manager');
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'VALIDATION: 至少一行货'; end if;
  insert into app.fob_projects (org_id, fob_no, customer_id, country, control, currency, note, created_by)
  values (p_org, app.next_doc_no(p_org, 'FOB'), p_customer, p_country, coalesce(p_control, 'warehouse'), p_currency, p_note, app.uid()) returning id into v_id;
  for x in select * from jsonb_array_elements(p_lines) loop
    v_p := null;
    if nullif(x->>'product_id','') is not null then select * into v_p from app.products where id = (x->>'product_id')::uuid; end if;
    insert into app.fob_lines (project_id, product_id, model, qty, rmb_cost)
    values (v_id, v_p.id, upper(coalesce(v_p.model, x->>'model')), (x->>'qty')::int, coalesce(v_p.fob_rmb, v_p.rmb_cost));
  end loop;
  perform app.fob_event(v_id, 'created', jsonb_build_object('lines', jsonb_array_length(p_lines)));
  return v_id;
end $$;

create or replace function app.set_fob_price(p_line uuid, p_price numeric)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_p uuid;
begin
  select p.org_id, p.id into v_org, v_p from app.fob_lines l join app.fob_projects p on p.id = l.project_id where l.id = p_line;
  perform app.require_role(v_org, 'admin');
  if p_price is null or p_price < 0 then raise exception 'VALIDATION: 价格无效'; end if;
  update app.fob_lines set unit_price = p_price where id = p_line;
  perform app.fob_event(v_p, 'price', jsonb_build_object('line', p_line, 'price', p_price));
end $$;

-- 推进状态 (主管 / 中方): 采购 (填采购单号) → 在途 (物流 / 单号 / 预计到货) → 到货
create or replace function app.fob_advance(p_project uuid, p_to text, p_data jsonb default '{}')
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects;
begin
  select * into f from app.fob_projects where id = p_project for update;
  perform app.require_role(f.org_id, 'manager');
  if not ((f.status = 'applied' and p_to = 'purchasing') or (f.status = 'purchasing' and p_to = 'in_transit') or (f.status = 'in_transit' and p_to = 'arrived')
       or (p_to = 'cancelled' and f.status not in ('shipped','closed'))) then
    raise exception 'BAD_STATE: % 不能直接到 %', f.status, p_to;
  end if;
  if p_to = 'purchasing' and exists (select 1 from app.fob_lines where project_id = p_project and unit_price is null) then
    raise exception 'VALIDATION: 还有行没定价（中方定价后才能下采购）';
  end if;
  if p_to = 'purchasing' and coalesce(p_data->>'po_no','') = '' then raise exception 'VALIDATION: 要填采购单号'; end if;
  update app.fob_projects set status = p_to, po_no = coalesce(nullif(p_data->>'po_no',''), po_no),
    logistics = coalesce(nullif(p_data->>'logistics',''), logistics), tracking = coalesce(nullif(p_data->>'tracking',''), tracking),
    eta = coalesce(nullif(p_data->>'eta','')::date, eta) where id = p_project;
  perform app.fob_event(p_project, p_to, p_data);
end $$;

-- 仓库控货: 到货进 FOB 仓 (按行点数). 物流控货不进仓.
create or replace function app.fob_receive(p_project uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects; x jsonb; l app.fob_lines; v_s uuid; v_q int;
begin
  select * into f from app.fob_projects where id = p_project for update;
  perform app.require_role(f.org_id, 'manager');
  if f.control <> 'warehouse' then raise exception 'BAD_STATE: 物流控货的项目不进仓'; end if;
  if f.status not in ('in_transit','arrived') then raise exception 'BAD_STATE: 在途或到货后才能入库'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    v_q := (x->>'qty')::int; continue when coalesce(v_q, 0) <= 0;
    select * into l from app.fob_lines where id = (x->>'line_id')::uuid and project_id = p_project for update;
    if l.product_id is null then raise exception 'VALIDATION: % 没有编码，先建编码再入库', l.model; end if;
    if l.qty_received + v_q > l.qty then raise exception 'VALIDATION: 入库数超过订货数'; end if;
    v_s := app.stock_row(f.org_id, 'fob', l.product_id);
    perform app.move_stock(v_s, v_q, 'grn', 'fob', p_project);
    update app.fob_lines set qty_received = qty_received + v_q where id = l.id;
  end loop;
  update app.fob_projects set status = 'arrived' where id = p_project and status = 'in_transit';
  perform app.fob_event(p_project, 'received', p_rows);
end $$;

create or replace function app.record_fob_payment(p_project uuid, p_kind text, p_amount numeric, p_on date, p_method app.pay_method, p_proof text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects; v_id uuid;
begin
  select * into f from app.fob_projects where id = p_project;
  perform app.require_role(f.org_id, 'finance');
  if f.status in ('cancelled') then raise exception 'BAD_STATE: 项目已取消'; end if;
  insert into app.fob_payments (project_id, kind, amount, on_date, method, proof, note, created_by)
  values (p_project, p_kind, p_amount, p_on, p_method, p_proof, p_note, app.uid()) returning id into v_id;
  perform app.fob_event(p_project, 'payment', jsonb_build_object('kind', p_kind, 'amount', p_amount));
  update app.fob_projects set status = 'closed' where id = p_project and status = 'shipped'
    and (select paid >= total from app.v_fob where id = p_project);
  return v_id;
end $$;

-- 放货 (只中方): 没收齐尾款也可以放, 但要写原因
create or replace function app.fob_release(p_project uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.v_fob;
begin
  select * into f from app.v_fob where id = p_project;
  perform app.require_role(f.org_id, 'admin');
  if f.status <> 'arrived' then raise exception 'BAD_STATE: 到货后才能放货'; end if;
  if f.paid < f.total and coalesce(trim(p_note),'') = '' then raise exception 'VALIDATION: 还没收齐（差 %），放货要写原因', f.total - f.paid; end if;
  update app.fob_projects set status = 'released', released_by = app.uid(), released_at = now(), release_note = p_note where id = p_project;
  perform app.fob_event(p_project, 'released', jsonb_build_object('paid', f.paid, 'total', f.total, 'note', p_note));
end $$;

-- 出库 / 物流放货: 仓库控货从 FOB 仓扣
create or replace function app.fob_ship(p_project uuid, p_proof text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects; l app.fob_lines; v_s uuid;
begin
  select * into f from app.fob_projects where id = p_project for update;
  perform app.require_role(f.org_id, 'manager');
  if f.status <> 'released' then raise exception 'BAD_STATE: 中方放货后才能出库'; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 出库要凭证'; end if;
  for l in select * from app.fob_lines where project_id = p_project loop
    if f.control = 'warehouse' then
      continue when l.qty_received - l.qty_shipped <= 0;
      v_s := app.stock_row(f.org_id, 'fob', l.product_id);
      perform app.move_stock(v_s, -(l.qty_received - l.qty_shipped), 'ship', 'fob', p_project);
      update app.fob_lines set qty_shipped = qty_received where id = l.id;
    else
      update app.fob_lines set qty_shipped = qty where id = l.id;
    end if;
  end loop;
  update app.fob_projects set status = case when (select paid >= total from app.v_fob where id = p_project) then 'closed' else 'shipped' end where id = p_project;
  perform app.fob_event(p_project, 'shipped', jsonb_build_object('proof', p_proof, 'note', p_note));
end $$;

-- ───────────────────────── 4 员工与工资 (只中方) ─────────────────────────
alter table app.employees add column incentive_rate numeric(6,3),   -- 按归属客户出库金额的 %
  add column allowance numeric(18,2), add column note text;

create table app.payroll (
  org_id uuid not null references app.orgs(id),
  month date not null,
  employee_id uuid not null references app.employees(id),
  base numeric(18,2) not null default 0,
  incentive numeric(18,2) not null default 0,
  incentive_basis jsonb,                   -- 怎么算出来的 (归属客户出库金额 / 件数)
  allowance numeric(18,2) not null default 0,
  deduction numeric(18,2) not null default 0,
  note text,
  status text not null default 'draft' check (status in ('draft','approved','paid')),
  updated_at timestamptz not null default now(),
  primary key (org_id, month, employee_id)
);
alter table app.payroll enable row level security;
create policy admin_only on app.payroll for select using (app.has_role(org_id, array['admin']::app.role_name[]));

create or replace function app.upsert_employee(p_org uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_data->>'short_name'),'') = '' then raise exception 'VALIDATION: 工作名必填'; end if;
  if v_id is null then
    insert into app.employees (org_id, short_name) values (p_org, trim(p_data->>'short_name')) returning id into v_id;
  end if;
  update app.employees set short_name = trim(p_data->>'short_name'), full_name = nullif(p_data->>'full_name',''), phone = nullif(p_data->>'phone',''),
    department = nullif(p_data->>'department',''), position = nullif(p_data->>'position',''), joined_on = nullif(p_data->>'joined_on','')::date,
    active = coalesce((p_data->>'active')::boolean, true), base_salary = nullif(p_data->>'base_salary','')::numeric,
    incentive_rate = nullif(p_data->>'incentive_rate','')::numeric, incentive_per_piece = nullif(p_data->>'incentive_per_piece','')::numeric,
    allowance = nullif(p_data->>'allowance','')::numeric, note = nullif(p_data->>'note','')
  where id = v_id and org_id = p_org;
  perform app.audit(p_org, 'upsert_employee', 'employees', v_id, null);
  return v_id;
end $$;

-- 算一个月的工资草稿: 底薪 + 激励 (归属客户当月出库金额 × % 或 件数 × 每件) + 补贴; 已批准的不动
create or replace function app.compute_payroll(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
declare e app.employees; m date := date_trunc('month', p_month)::date; v_amt numeric; v_qty numeric; n int := 0;
begin
  perform app.require_role(p_org, 'admin');
  for e in select * from app.employees where org_id = p_org and active loop
    select coalesce(sum(sl.amount), 0), coalesce(sum(sl.qty), 0) into v_amt, v_qty
    from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
    where d.org_id = p_org and d.owner_employee_id = e.id and sh.voided_at is null and d.currency = 'XOF'
      and sh.shipped_at >= m and sh.shipped_at < (m + interval '1 month');
    insert into app.payroll (org_id, month, employee_id, base, incentive, incentive_basis, allowance)
    values (p_org, m, e.id, coalesce(e.base_salary, 0),
      round(coalesce(v_amt * e.incentive_rate / 100, 0) + coalesce(v_qty * e.incentive_per_piece, 0)),
      jsonb_build_object('amount', v_amt, 'qty', v_qty, 'rate', e.incentive_rate, 'per_piece', e.incentive_per_piece), coalesce(e.allowance, 0))
    on conflict (org_id, month, employee_id) do update set base = excluded.base, incentive = excluded.incentive,
      incentive_basis = excluded.incentive_basis, allowance = excluded.allowance, updated_at = now()
      where app.payroll.status = 'draft';
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app.set_payroll(p_org uuid, p_month date, p_employee uuid, p_deduction numeric, p_note text, p_status text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  update app.payroll set deduction = coalesce(p_deduction, deduction), note = coalesce(p_note, note), status = coalesce(p_status, status), updated_at = now()
  where org_id = p_org and month = date_trunc('month', p_month)::date and employee_id = p_employee
    and (status = 'draft' or p_status in ('paid'));
end $$;

-- ───────────────────────── 5 培训与 SOP ─────────────────────────
create table app.sop_docs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  dept text not null,                     -- 热线 / 仓库 / 财务 / 销售 / 主管 / 全员
  title text not null,
  version int not null default 1,
  steps jsonb not null default '[]',      -- [{text, route?}]  route = 系统里对应的页面 (流程联动)
  body text,
  active boolean not null default true,
  updated_by uuid, updated_at timestamptz not null default now()
);
create table app.sop_acks (
  doc_id uuid not null references app.sop_docs(id) on delete cascade,
  version int not null,
  user_id uuid not null,
  at timestamptz not null default now(),
  primary key (doc_id, version, user_id)
);
alter table app.sop_docs enable row level security; alter table app.sop_acks enable row level security;
create policy read_own on app.sop_docs for select using (app.is_member(org_id));
create policy read_own on app.sop_acks for select using (exists (select 1 from app.sop_docs d where d.id = doc_id and app.is_member(d.org_id)));

create or replace function app.upsert_sop(p_org uuid, p_id uuid, p_dept text, p_title text, p_steps jsonb, p_body text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_title),'') = '' then raise exception 'VALIDATION: 标题必填'; end if;
  if v_id is null then
    insert into app.sop_docs (org_id, dept, title, steps, body, updated_by) values (p_org, p_dept, p_title, coalesce(p_steps,'[]'), p_body, app.uid()) returning id into v_id;
  else
    update app.sop_docs set dept = p_dept, title = p_title, steps = coalesce(p_steps,'[]'), body = p_body, version = version + 1, updated_by = app.uid(), updated_at = now()
    where id = v_id and org_id = p_org;   -- 改了就升版本, 大家要重新确认
  end if;
  return v_id;
end $$;

create or replace function app.ack_sop(p_doc uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.sop_docs;
begin
  select * into d from app.sop_docs where id = p_doc;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  insert into app.sop_acks values (p_doc, d.version, app.uid(), now()) on conflict do nothing;
end $$;

-- ───────────────────────── 6 金蝶同步 ─────────────────────────
-- 出库单: 客户签收 → 待录 → 保存 (填金蝶单号) → 提交 → 审核 (主管 / 中方). 三步分开.
alter table app.kingdee_outbox drop constraint kingdee_outbox_status_check;
alter table app.kingdee_outbox add constraint kingdee_outbox_status_check
  check (status in ('await_receipt','ready','saved','submitted','synced','error','void'));
alter table app.kingdee_outbox add column saved_at timestamptz, add column saved_by uuid,
  add column submitted_at timestamptz, add column submitted_by uuid, add column audited_at timestamptz, add column audited_by uuid;

create or replace function app.kd_step(p_outbox uuid, p_step text, p_remote_no text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare o app.kingdee_outbox;
begin
  select * into o from app.kingdee_outbox where id = p_outbox for update;
  if p_step = 'save' then
    perform app.require_role(o.org_id, 'finance', 'manager');
    if o.status <> 'ready' then raise exception 'BAD_STATE: 客户签收后才能录金蝶'; end if;
    if coalesce(trim(p_remote_no),'') = '' then raise exception 'VALIDATION: 要填金蝶单号'; end if;
    update app.kingdee_outbox set status = 'saved', remote_no = trim(p_remote_no), saved_at = now(), saved_by = app.uid(), updated_at = now() where id = p_outbox;
  elsif p_step = 'submit' then
    perform app.require_role(o.org_id, 'finance', 'manager');
    if o.status <> 'saved' then raise exception 'BAD_STATE: 先保存再提交'; end if;
    update app.kingdee_outbox set status = 'submitted', submitted_at = now(), submitted_by = app.uid(), updated_at = now() where id = p_outbox;
  elsif p_step = 'audit' then
    perform app.require_role(o.org_id, 'manager');
    if o.status <> 'submitted' then raise exception 'BAD_STATE: 先提交再审核'; end if;
    if o.submitted_by = app.uid() and not app.has_role(o.org_id, array['admin']::app.role_name[]) then raise exception 'VALIDATION: 提交和审核不能是同一个人'; end if;
    update app.kingdee_outbox set status = 'synced', audited_at = now(), audited_by = app.uid(), updated_at = now() where id = p_outbox;
  elsif p_step = 'back' then
    perform app.require_role(o.org_id, 'manager');
    update app.kingdee_outbox set status = case o.status when 'synced' then 'submitted' when 'submitted' then 'saved' when 'saved' then 'ready' else o.status end,
      updated_at = now() where id = p_outbox;
  else raise exception 'VALIDATION: 未知步骤';
  end if;
  return (select status from app.kingdee_outbox where id = p_outbox);
end $$;

-- 金蝶库存快照 (只存不改库存) → 和系统库存逐行比对
create table app.kd_stock_snapshot (
  org_id uuid not null references app.orgs(id),
  as_of date not null,
  code text not null, warehouse text not null,
  qty numeric not null,
  primary key (org_id, as_of, code, warehouse)
);
alter table app.kd_stock_snapshot enable row level security;
create policy read_own on app.kd_stock_snapshot for select using (app.is_member(org_id));

create or replace function app.import_kd_snapshot(p_org uuid, p_as_of date, p_rows jsonb)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int;
begin
  perform app.require_role(p_org, 'admin', 'finance');
  delete from app.kd_stock_snapshot where org_id = p_org and as_of = p_as_of;
  insert into app.kd_stock_snapshot (org_id, as_of, code, warehouse, qty)
  select p_org, p_as_of, trim(x->>'code'), upper(trim(x->>'warehouse')), sum((x->>'qty')::numeric)
  from jsonb_array_elements(p_rows) x where coalesce(trim(x->>'code'),'') <> '' group by 3, 4;
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────────────────────── 7 客户下单端 / 门店 ─────────────────────────
-- 客户老板 (boss) 和门店店员 (clerk) 登进的是「客户组织」(orgs.kind = customer / store), 通过 customers.linked_org_id 对到我们的客户.
-- 他们看得到: 我们的货有没有 (有货 / 少量 / 无货, 不给精确数), 自己的订单进度, 自己的对账. 看不到: 底价、别人的价格.
alter table app.deals add column source text not null default 'staff' check (source in ('staff','portal')), add column portal_store_id uuid;

create table app.portal_stores (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers(id),
  org_id uuid references app.orgs(id),      -- 门店自己的组织 (店员登这个)
  name text not null, city text, manager text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table app.store_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references app.portal_stores(id),
  order_no text not null,
  lines jsonb not null,                     -- [{product_id?, model, category, qty}]
  note text,
  status text not null default 'submitted' check (status in ('submitted','accepted','rejected','forwarded','delivered')),
  deal_id uuid references app.deals(id),    -- 老板转给我们时生成的询单
  created_by uuid, created_at timestamptz not null default now(), decided_at timestamptz
);
alter table app.portal_stores enable row level security; alter table app.store_orders enable row level security;

-- 当前登录的人对应哪个客户 / 哪个门店
create or replace function app.portal_me()
returns table (customer_id uuid, store_id uuid, hq_org uuid, role app.role_name) language sql stable security definer set search_path = app, public as $$
  select c.id, s.id, c.org_id, case when 'boss' = any(m.roles) then 'boss'::app.role_name else 'clerk'::app.role_name end
  from app.members m
  left join app.portal_stores s on s.org_id = m.org_id
  join app.customers c on c.linked_org_id = m.org_id or c.id = s.customer_id
  where m.user_id = app.uid() and m.active and (m.roles && array['boss','clerk']::app.role_name[])
  limit 1
$$;

create policy portal_read on app.portal_stores for select using (customer_id = (select customer_id from app.portal_me()) or exists (select 1 from app.customers c where c.id = customer_id and app.is_member(c.org_id)));
create policy portal_read on app.store_orders for select using (
  exists (select 1 from app.portal_stores s join app.customers c on c.id = s.customer_id where s.id = store_id
          and (c.id = (select customer_id from app.portal_me()) or app.is_member(c.org_id))));

-- 客户老板直接向我们下单 → 进我们的「已报价」(来源: 客户下单端), 热线照常确认; 价格由系统按档位带出, 客户端不显示
create or replace function app.portal_order(p_lines jsonb, p_note text, p_store_order uuid default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare me record; c app.customers; d app.deals; x jsonb; v_lines jsonb := '[]';
begin
  select * into me from app.portal_me();
  if me.customer_id is null or me.role <> 'boss' then raise exception 'PERMISSION_DENIED: 只有客户老板能向我们下单'; end if;
  select * into c from app.customers where id = me.customer_id;
  if c.status <> 'active' then raise exception 'VALIDATION: 客户还没开通'; end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    if coalesce((x->>'qty')::int, 0) <= 0 then continue; end if;
    if nullif(x->>'product_id','') is not null then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('product_id', x->>'product_id', 'qty_req', (x->>'qty')::int));
    else
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('req_category_id', (select id from app.categories where org_id = c.org_id and name = x->>'category'),
        'req_model', upper(x->>'model'), 'qty_req', (x->>'qty')::int));
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'VALIDATION: 没有要的货'; end if;
  insert into app.deals (org_id, biz_no, quote_no, customer_id, currency, owner_employee_id, note, created_by, source, portal_store_id)
  values (c.org_id, app.next_doc_no(c.org_id,'BIZ'), app.next_doc_no(c.org_id,'QT'), c.id, 'XOF', c.owner_employee_id,
    concat_ws(' · ', '客户下单端', nullif(p_note,'')), app.uid(), 'portal',
    (select store_id from app.store_orders where id = p_store_order))
  returning * into d;
  perform app.write_lines(d, v_lines);
  perform app.deal_event(d.id, 'quote_created', jsonb_build_object('source', 'portal', 'lines', jsonb_array_length(v_lines)));
  if p_store_order is not null then
    update app.store_orders set status = 'forwarded', deal_id = d.id, decided_at = now() where id = p_store_order;
  end if;
  return d.id;
end $$;

-- 门店向老板下单
create or replace function app.store_order(p_lines jsonb, p_note text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare me record; v_id uuid; v_org uuid;
begin
  select * into me from app.portal_me();
  if me.store_id is null then raise exception 'PERMISSION_DENIED: 只有门店能下门店单'; end if;
  select org_id into v_org from app.customers where id = me.customer_id;
  insert into app.store_orders (store_id, order_no, lines, note, created_by)
  values (me.store_id, app.next_doc_no(v_org, 'ST'), p_lines, p_note, app.uid()) returning id into v_id;
  return v_id;
end $$;

-- 老板处理门店单: 接受 (自己有货自己发) / 拒绝 / 转给我们 (用 portal_order) / 已送达
create or replace function app.store_order_decide(p_order uuid, p_status text)
returns void language plpgsql security definer set search_path = app, public as $$
declare me record; o app.store_orders;
begin
  select * into me from app.portal_me();
  select * into o from app.store_orders where id = p_order;
  if me.role <> 'boss' or not exists (select 1 from app.portal_stores s where s.id = o.store_id and s.customer_id = me.customer_id) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_status not in ('accepted','rejected','delivered') then raise exception 'VALIDATION: 状态无效'; end if;
  update app.store_orders set status = p_status, decided_at = now() where id = p_order;
end $$;

-- 中方开门店 (给客户建门店)
create or replace function app.create_store(p_customer uuid, p_name text, p_city text, p_manager text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_id uuid;
begin
  select * into c from app.customers where id = p_customer;
  perform app.require_role(c.org_id, 'admin');
  insert into app.portal_stores (customer_id, name, city, manager) values (p_customer, upper(trim(p_name)), p_city, p_manager) returning id into v_id;
  return v_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.org_settings, app.sales_history, app.fob_projects, app.fob_lines, app.fob_payments, app.fob_events, app.v_fob,
      app.payroll, app.sop_docs, app.sop_acks, app.kd_stock_snapshot, app.portal_stores, app.store_orders to authenticated;
    grant execute on function app.set_org_setting(uuid, text, jsonb), app.import_sales_history(uuid, jsonb),
      app.create_fob(uuid, uuid, text, text, text, jsonb, text), app.set_fob_price(uuid, numeric), app.fob_advance(uuid, text, jsonb),
      app.fob_receive(uuid, jsonb), app.record_fob_payment(uuid, text, numeric, date, app.pay_method, text, text), app.fob_release(uuid, text),
      app.fob_ship(uuid, text, text), app.upsert_employee(uuid, uuid, jsonb), app.compute_payroll(uuid, date),
      app.set_payroll(uuid, date, uuid, numeric, text, text), app.upsert_sop(uuid, uuid, text, text, jsonb, text), app.ack_sop(uuid),
      app.kd_step(uuid, text, text), app.import_kd_snapshot(uuid, date, jsonb), app.portal_me(), app.portal_order(jsonb, text, uuid),
      app.store_order(jsonb, text), app.store_order_decide(uuid, text), app.create_store(uuid, text, text, text) to authenticated;
  end if;
end $$;
revoke execute on function app.fob_event(uuid, text, jsonb) from public;
