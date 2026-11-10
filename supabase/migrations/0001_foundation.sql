-- LA&9S Operations · 0001 foundation
-- Multi-org (HQ per country → customer boss org → store), people, roles, master data.
-- All business writes go through SECURITY DEFINER functions in 0002; tables are read via RLS.

create extension if not exists pgcrypto;
create schema if not exists app;

-- ───────────────────────── enums ─────────────────────────
create type app.org_kind      as enum ('hq', 'customer', 'store');
create type app.role_name     as enum ('admin','manager','picker','hotline','sales','finance','boss','clerk','viewer');
create type app.customer_tier as enum ('S','WHOLESALE','RETAIL','REPAIR');
create type app.customer_status as enum ('prospect','active','inactive');
create type app.wh_kind       as enum ('local','fob','pending','scrap','recycle');

-- ───────────────────────── reference ─────────────────────────
create table app.countries (
  code text primary key,                    -- ISO-2: CI, TG, BJ ...
  name_zh text not null, name_fr text not null,
  default_currency text not null
);

create table app.currencies (
  code text primary key,                    -- XOF, CNY, USD
  decimals smallint not null default 0
);

-- ───────────────────────── orgs & people ─────────────────────────
create table app.orgs (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references app.orgs(id),
  kind app.org_kind not null,
  name text not null,
  country text not null references app.countries(code),
  base_currency text not null references app.currencies(code),
  doc_prefix text not null,                 -- e.g. CI → QT-CI-2610-0001
  created_at timestamptz not null default now()
);

-- employee record (may exist without a login)
create table app.employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  emp_no text,
  short_name text not null,                 -- 工作名
  full_name text,
  phone text, email text, address text,
  birthday date, joined_on date,
  department text, position text,
  active boolean not null default true,
  base_salary numeric(18,2),
  incentive_per_piece numeric(18,2),
  created_at timestamptz not null default now(),
  unique (org_id, emp_no)
);

-- login → org membership with one or more roles
create table app.members (
  user_id uuid not null,                    -- auth.users.id
  org_id uuid not null references app.orgs(id),
  employee_id uuid references app.employees(id),
  roles app.role_name[] not null,
  active boolean not null default true,
  primary key (user_id, org_id)
);

-- ───────────────────────── auth helpers ─────────────────────────
create or replace function app.uid() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.has_role(p_org uuid, p_roles app.role_name[])
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from app.members m
    where m.user_id = app.uid() and m.org_id = p_org and m.active
      and (m.roles && p_roles or 'admin' = any(m.roles))
  )
$$;

create or replace function app.is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active)
$$;

create or replace function app.require_role(p_org uuid, variadic p_roles app.role_name[])
returns void language plpgsql stable security definer set search_path = app, public as $$
begin
  if not app.has_role(p_org, p_roles) then
    raise exception 'PERMISSION_DENIED: requires one of %', p_roles using errcode = '42501';
  end if;
end $$;

create or replace function app.current_employee(p_org uuid) returns uuid
language sql stable security definer set search_path = app, public as $$
  select employee_id from app.members where user_id = app.uid() and org_id = p_org
$$;

-- ───────────────────────── document numbering ─────────────────────────
create table app.doc_counters (
  org_id uuid not null references app.orgs(id),
  doc_type text not null,                   -- QT PK SO OUT RCV RT ...
  period text not null,                     -- YYMM
  last_no int not null default 0,
  primary key (org_id, doc_type, period)
);

create or replace function app.next_doc_no(p_org uuid, p_type text)
returns text language plpgsql security definer set search_path = app, public as $$
declare v_period text := to_char(now() at time zone 'UTC', 'YYMM'); v_no int; v_prefix text;
begin
  insert into app.doc_counters as c (org_id, doc_type, period, last_no) values (p_org, p_type, v_period, 1)
  on conflict (org_id, doc_type, period) do update set last_no = c.last_no + 1
  returning last_no into v_no;
  select doc_prefix into v_prefix from app.orgs where id = p_org;
  return p_type || '-' || v_prefix || '-' || v_period || '-' || lpad(v_no::text, 4, '0');
end $$;

-- ───────────────────────── customers (one list + status/relationship columns) ─────────────────────────
create table app.customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  code text,                                -- 正式客户编码 (null for prospects)
  temp_code text,                           -- 拜访临时编码
  name text not null,
  city text,
  status app.customer_status not null default 'prospect',
  tier app.customer_tier,                   -- price tier; required once active
  is_local boolean not null default true,   -- 本地客户
  is_fob boolean not null default false,    -- FOB 客户 (can be both)
  country text references app.countries(code),
  owner_employee_id uuid references app.employees(id),  -- 归属销售 (激励)
  phone text, whatsapp_group text, shop_name text, address text,
  source text,                              -- visit / hotline / import / recycle ...
  linked_org_id uuid references app.orgs(id),           -- if this customer runs our system
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  check (status <> 'active' or (code is not null and tier is not null))
);
create index on app.customers (org_id, status);

-- ───────────────────────── products ─────────────────────────
create table app.categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  name text not null,                       -- 屏幕 / 电池盖 / 电池 ...
  sort int not null default 0,
  unique (org_id, name)
);

create table app.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  code text not null,                       -- 物料编码 (= 金蝶编码 unless mapped)
  kingdee_code text,
  category_id uuid not null references app.categories(id),
  model text not null check (model = upper(model)),     -- 型号，统一大写
  shared_models text[] not null default '{}',            -- 通用机型
  photo_path text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, category_id, model)       -- 同型号靠种类区分
);

-- explicit price per tier & currency (imported from 母表; no guessed formulas)
create table app.product_prices (
  product_id uuid not null references app.products(id) on delete cascade,
  tier app.customer_tier not null,
  currency text not null references app.currencies(code),
  price numeric(18,2) not null check (price >= 0),
  updated_at timestamptz not null default now(),
  primary key (product_id, tier, currency)
);

-- ───────────────────────── warehouses & stock ─────────────────────────
create table app.warehouses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  code text not null,                       -- LA / 9S / FOB / PENDING / SCRAP
  name text not null,
  kind app.wh_kind not null,
  supplier text,                            -- 货权/供应商
  unique (org_id, code)
);

create table app.stock_items (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references app.warehouses(id),
  product_id uuid not null references app.products(id),
  bin text,                                 -- 库位 (货架-层)
  qty_on_hand int not null default 0 check (qty_on_hand >= 0),
  qty_reserved int not null default 0 check (qty_reserved >= 0),
  unique (warehouse_id, product_id),
  check (qty_reserved <= qty_on_hand)
);

create table app.stock_moves (
  id bigint generated always as identity primary key,
  stock_item_id uuid not null references app.stock_items(id),
  qty int not null,                         -- +in / -out
  reason text not null,                     -- ship / return_in / inspect / grn / adjust / opening
  ref_type text, ref_id uuid,
  at timestamptz not null default now(),
  by_user uuid
);

-- ───────────────────────── audit ─────────────────────────
create table app.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  detail jsonb
);

create or replace function app.audit(p_org uuid, p_action text, p_entity text, p_id uuid, p_detail jsonb default null)
returns void language sql security definer set search_path = app, public as $$
  insert into app.audit_log (org_id, user_id, action, entity, entity_id, detail)
  values (p_org, app.uid(), p_action, p_entity, p_id, p_detail)
$$;
