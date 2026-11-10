-- LA&9S Operations · 0002 sales chain, finance, returns
-- One 业务 (deal) carries every stage: 报价 → 热线确认 → 找货(预占) → 复核 → 销售订单 → 客户确认 → 出库 → 收款/退货
-- Every line has a stable uuid; shipments/returns reference line ids, never array positions.

create type app.deal_kind   as enum ('normal','opening','fob');
create type app.deal_status as enum ('quoted','hotline_ok','picking','picked','reviewed','ordered','confirmed','partial','shipped','cancelled');
create type app.ship_method as enum ('yango_moto','yango_car','yango_truck','customer_pickup','staff_delivery');
create type app.pay_method  as enum ('cash','wave','orange','bank','other');
create type app.return_reason as enum ('quality','customer_damage','logistics','other');
create type app.return_status as enum ('requested','approved','rejected');

-- ───────────────────────── deals ─────────────────────────
create table app.deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  kind app.deal_kind not null default 'normal',
  biz_no text not null,                     -- 业务号 (stable across stages)
  quote_no text, pick_no text, so_no text,
  customer_id uuid not null references app.customers(id),
  currency text not null references app.currencies(code),
  status app.deal_status not null default 'quoted',
  owner_employee_id uuid references app.employees(id),  -- 归属销售快照 (业绩)
  picker_employee_id uuid references app.employees(id),
  pick_photo_path text,
  reviewed_by uuid, reviewed_at timestamptz,
  hotline_note text, confirm_note text,
  parent_deal_id uuid references app.deals(id),          -- 追加单
  note text,
  created_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (org_id, biz_no)
);
create index on app.deals (org_id, status, created_at desc);
create index on app.deals (customer_id);

create table app.deal_lines (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references app.deals(id) on delete cascade,
  seq int not null,
  product_id uuid references app.products(id),          -- null = 客户要的我们没有建档
  req_category_id uuid references app.categories(id),
  req_model text check (req_model = upper(req_model)),
  qty_req int not null check (qty_req >= 0),            -- 客户需求
  stock_item_id uuid references app.stock_items(id),    -- 指定出货仓位 (no auto cross-warehouse)
  qty_supply int not null default 0 check (qty_supply >= 0),   -- 预占/实际供货
  qty_shipped int not null default 0 check (qty_shipped >= 0),
  qty_returned int not null default 0 check (qty_returned >= 0),
  unit_price numeric(18,2) not null default 0 check (unit_price >= 0),
  price_manual boolean not null default false,
  price_set_by uuid,
  diff_reason text,                         -- 实际供货 ≠ 计划时必填
  added_after_pick boolean not null default false,
  note text,
  check (product_id is not null or req_model is not null),
  check (product_id is not null or qty_supply = 0),
  check (qty_shipped <= qty_supply),
  check (qty_returned <= qty_shipped)
);
create index on app.deal_lines (deal_id);

create table app.deal_events (
  id bigint generated always as identity primary key,
  deal_id uuid not null references app.deals(id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  detail jsonb
);

-- ───────────────────────── shipments (出库单) ─────────────────────────
create table app.shipments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  deal_id uuid not null references app.deals(id),
  out_no text not null,
  shipped_at timestamptz not null,
  method app.ship_method not null,
  contact_phone text not null,
  address text not null,
  proof_path text not null,                 -- 发货凭证截图
  amount numeric(18,2) not null,
  customer_received_at timestamptz,         -- 客户签收 → 才允许补录金蝶
  created_by uuid, created_at timestamptz not null default now(),
  unique (org_id, out_no)
);

create table app.shipment_lines (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references app.shipments(id) on delete cascade,
  deal_line_id uuid not null references app.deal_lines(id),
  qty int not null check (qty > 0),
  unit_price numeric(18,2) not null,
  amount numeric(18,2) not null
);

-- ───────────────────────── AR ledger, receipts, allocations ─────────────────────────
-- balance(customer,currency) = Σ amount ; >0 客户欠款, <0 预付款
create table app.ar_entries (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null references app.customers(id),
  currency text not null references app.currencies(code),
  kind text not null check (kind in ('opening','shipment','return','receipt','adjust')),
  amount numeric(18,2) not null,
  deal_id uuid references app.deals(id),
  ref_id uuid,
  at timestamptz not null default now(),
  note text
);
create index on app.ar_entries (customer_id, currency);

create table app.receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  rcv_no text not null,
  customer_id uuid not null references app.customers(id),
  received_on date not null,
  amount numeric(18,2) not null check (amount > 0),    -- 实收金额 (原币)
  currency text not null references app.currencies(code),
  account_currency text not null references app.currencies(code),
  rate numeric(18,8) not null check (rate > 0),        -- 1 原币 = rate 账务币 (锁定)
  converted numeric(18,2) not null,
  method app.pay_method not null,
  proof_path text,
  note text,
  created_by uuid, created_at timestamptz not null default now(),
  unique (org_id, rcv_no)
);

create table app.receipt_allocations (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references app.receipts(id),
  deal_id uuid not null references app.deals(id),
  amount numeric(18,2) not null check (amount > 0),    -- 账务币
  at timestamptz not null default now()
);
create index on app.receipt_allocations (deal_id);

-- ───────────────────────── returns ─────────────────────────
create table app.returns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  rt_no text not null,
  deal_id uuid not null references app.deals(id),
  customer_id uuid not null references app.customers(id),
  reason_type app.return_reason not null,
  reason text not null check (length(trim(reason)) > 0),
  status app.return_status not null default 'requested',
  amount numeric(18,2) not null default 0,
  requested_by uuid, requested_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz,
  unique (org_id, rt_no)
);

create table app.return_lines (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references app.returns(id) on delete cascade,
  deal_line_id uuid not null references app.deal_lines(id),
  qty int not null check (qty > 0),
  unit_price numeric(18,2) not null,
  pending_stock_item_id uuid references app.stock_items(id),
  qty_good int not null default 0, qty_scrap int not null default 0,
  check (qty_good + qty_scrap <= qty)
);

-- ───────────────────────── Kingdee outbox ─────────────────────────
-- 金蝶补录门槛: 客户签收后才 ready。真实写入适配器另做，必须幂等。
create table app.kingdee_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  shipment_id uuid not null unique references app.shipments(id),
  status text not null default 'await_receipt' check (status in ('await_receipt','ready','synced','error')),
  remote_no text, last_error text,
  updated_at timestamptz not null default now()
);

-- ───────────────────────── views ─────────────────────────
create view app.v_stock as
select s.id as stock_item_id, w.org_id, w.code as warehouse, w.kind as warehouse_kind, s.bin,
       p.id as product_id, p.code, c.name as category, p.model, p.shared_models,
       s.qty_on_hand, s.qty_reserved, s.qty_on_hand - s.qty_reserved as qty_available
from app.stock_items s
join app.warehouses w on w.id = s.warehouse_id
join app.products p on p.id = s.product_id
join app.categories c on c.id = p.category_id;

create view app.v_deal_totals as
select d.id as deal_id, d.org_id, d.customer_id, d.currency, d.kind, d.status,
  coalesce((select sum(sl.amount) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id where sh.deal_id = d.id), 0)
  + coalesce((select sum(e.amount) from app.ar_entries e where e.deal_id = d.id and e.kind = 'opening'), 0) as shipped_amount,
  coalesce((select sum(r.amount) from app.returns r where r.deal_id = d.id and r.status = 'approved'), 0) as returned_amount,
  coalesce((select sum(a.amount) from app.receipt_allocations a where a.deal_id = d.id), 0) as allocated_amount,
  (select min(sh.shipped_at) from app.shipments sh where sh.deal_id = d.id) as first_shipped_at
from app.deals d;

create view app.v_deal_due as
select t.*, t.shipped_amount - t.returned_amount - t.allocated_amount as due
from app.v_deal_totals t;

create view app.v_customer_balance as
select e.org_id, e.customer_id, e.currency,
  sum(e.amount) filter (where e.kind in ('opening','shipment')) as total_sold,
  -sum(e.amount) filter (where e.kind = 'receipt') as total_paid,
  -sum(e.amount) filter (where e.kind = 'return') as total_returned,
  sum(e.amount) as balance
from app.ar_entries e group by 1,2,3;

create view app.v_receipt_open as
select r.*, r.converted - coalesce((select sum(a.amount) from app.receipt_allocations a where a.receipt_id = r.id), 0) as unallocated
from app.receipts r;

-- 未满足需求: 未建档机型 + 供不足的差额 (备货依据)
create view app.v_unmet_demand as
select d.org_id, d.id as deal_id, d.biz_no, d.customer_id, d.created_at,
       l.id as line_id, l.product_id, coalesce(p.model, l.req_model) as model,
       coalesce(p.category_id, l.req_category_id) as category_id,
       case when l.product_id is null then 'no_code' else 'short' end as kind,
       l.qty_req - l.qty_supply as qty_unmet
from app.deal_lines l
join app.deals d on d.id = l.deal_id
left join app.products p on p.id = l.product_id
where d.status <> 'cancelled' and d.kind <> 'opening' and l.qty_req > l.qty_supply
  and (l.product_id is null or d.status not in ('quoted','hotline_ok'));
