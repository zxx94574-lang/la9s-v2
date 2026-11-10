-- LA&9S Operations · 0009 客户档案 · 热线回访 · 销售拜访 · 欠款预警 · 回收客户导入 (Frank 2026-10-29)

alter table app.customers
  add column kind text not null default 'spare' check (kind in ('spare','recycle','both')),   -- 备件客户 / 回收客户
  add column credit_limit numeric(18,2),        -- 欠款上限 (XOF); 超了只预警, 不自动停货
  add column credit_days int,                   -- 账期 (天)
  add column has_agreement boolean not null default false,   -- 有协议的大客户 (例 THOMAS)
  add column market text, add column zone text, add column shop_type text,
  add column monthly_qty int, add column buys_from text, add column transport text,
  add column nearby_suppliers text, add column location text, add column shop_photo text,
  add column interested boolean, add column tags text[] not null default '{}',
  add column recycle_type text;                 -- 回收: Techniciens / Wholesale Shop / Recycleurs

-- 热线回访 (备件 / 回收 共用一张表)
create table app.hotline_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null references app.customers(id),
  at timestamptz not null default now(),
  by_user uuid,
  staff_employee_id uuid references app.employees(id),
  line text not null default 'spare' check (line in ('spare','recycle')),
  channel text not null default 'call' check (channel in ('call','whatsapp','visit')),
  result text not null check (result in ('order','quote','later','no_need','no_answer','busy','other')),
  note text,
  next_follow_on date,
  deal_id uuid references app.deals(id),
  created_at timestamptz not null default now()
);
create index on app.hotline_calls (org_id, at desc);
create index on app.hotline_calls (customer_id, at desc);

-- 销售拜访 (法语表单字段照飞书 Fiche de visite)
create table app.visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null references app.customers(id),
  at timestamptz not null default now(),
  by_user uuid,
  employee_id uuid references app.employees(id),
  photo text, location text,
  activity text, products_wanted text, monthly_qty int, buys_from text, transport text, nearby_suppliers text,
  result text not null check (result in ('order','quote','interested','not_interested','later')),
  note text, next_follow_on date,
  deal_id uuid references app.deals(id),
  created_at timestamptz not null default now()
);
create index on app.visits (org_id, at desc);

alter table app.hotline_calls enable row level security;
alter table app.visits enable row level security;
create policy read_own on app.hotline_calls for select using (app.is_member(org_id));
create policy read_own on app.visits for select using (app.is_member(org_id));

-- 新潜客: 自动临时编码 T-…; 热线 / 销售 / 主管 / 中方都能建
create or replace function app.create_prospect(p_org uuid, p_name text, p_phone text, p_city text, p_extra jsonb default '{}')
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_owner uuid;
begin
  perform app.require_role(p_org, 'hotline', 'sales', 'manager');
  if coalesce(trim(p_name),'') = '' then raise exception 'VALIDATION: 店名 / 客户名必填'; end if;
  if coalesce(trim(p_phone),'') = '' then raise exception 'VALIDATION: 电话必填'; end if;
  if exists (select 1 from app.customers where org_id = p_org and regexp_replace(phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')) then
    raise exception 'CONFLICT: 这个电话已经有客户档案了';
  end if;
  select employee_id into v_owner from app.members where user_id = app.uid() and org_id = p_org;
  insert into app.customers (org_id, temp_code, name, city, status, phone, source, owner_employee_id, kind,
    shop_name, market, zone, shop_type, monthly_qty, buys_from, transport, nearby_suppliers, location, shop_photo, note)
  values (p_org, app.next_doc_no(p_org, 'T'), upper(trim(p_name)), p_city, 'prospect', trim(p_phone), coalesce(p_extra->>'source', 'visit'), v_owner,
    coalesce(p_extra->>'kind', 'spare'), p_extra->>'shop_name', p_extra->>'market', p_extra->>'zone', p_extra->>'shop_type',
    nullif(p_extra->>'monthly_qty','')::int, p_extra->>'buys_from', p_extra->>'transport', p_extra->>'nearby_suppliers',
    p_extra->>'location', p_extra->>'shop_photo', p_extra->>'note')
  returning id into v_id;
  perform app.audit(p_org, 'create_prospect', 'customers', v_id, p_extra);
  return v_id;
end $$;

-- 潜客转正式: 给正式编码 + 档位 (定档位 = 定价, 只中方)
create or replace function app.activate_customer(p_customer uuid, p_code text, p_tier app.customer_tier, p_owner uuid default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer for update;
  perform app.require_role(c.org_id, 'admin');
  if coalesce(trim(p_code),'') = '' then raise exception 'VALIDATION: 正式编码必填'; end if;
  if exists (select 1 from app.customers where org_id = c.org_id and code = upper(trim(p_code)) and id <> p_customer) then raise exception 'CONFLICT: 编码已被占用'; end if;
  update app.customers set code = upper(trim(p_code)), tier = p_tier, status = 'active',
    owner_employee_id = coalesce(p_owner, owner_employee_id), updated_at = now() where id = p_customer;
  perform app.audit(c.org_id, 'activate_customer', 'customers', p_customer, jsonb_build_object('code', p_code, 'tier', p_tier));
end $$;

-- 欠款上限 / 账期 / 协议 / 归属销售: 只中方
create or replace function app.set_customer_terms(p_customer uuid, p_limit numeric, p_days int, p_agreement boolean, p_owner uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  perform app.require_role(c.org_id, 'admin');
  if coalesce(p_limit, 0) < 0 or coalesce(p_days, 0) < 0 then raise exception 'VALIDATION: 上限和账期不能为负'; end if;
  update app.customers set credit_limit = p_limit, credit_days = p_days, has_agreement = coalesce(p_agreement, false),
    owner_employee_id = p_owner, updated_at = now() where id = p_customer;
  perform app.audit(c.org_id, 'set_customer_terms', 'customers', p_customer,
    jsonb_build_object('limit', p_limit, 'days', p_days, 'agreement', p_agreement));
end $$;

-- 热线回访记录
create or replace function app.log_call(p_customer uuid, p_line text, p_channel text, p_result text, p_note text, p_next date, p_deal uuid default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_id uuid; v_emp uuid;
begin
  select * into c from app.customers where id = p_customer;
  if not found then raise exception 'NOT_FOUND: customer'; end if;
  perform app.require_role(c.org_id, 'hotline', 'sales', 'manager');
  select employee_id into v_emp from app.members where user_id = app.uid() and org_id = c.org_id;
  insert into app.hotline_calls (org_id, customer_id, by_user, staff_employee_id, line, channel, result, note, next_follow_on, deal_id)
  values (c.org_id, p_customer, app.uid(), v_emp, coalesce(p_line,'spare'), coalesce(p_channel,'call'), p_result, nullif(trim(p_note),''), p_next, p_deal)
  returning id into v_id;
  return v_id;
end $$;

-- 销售拜访记录 (客户可以是刚建的潜客)
create or replace function app.log_visit(p_customer uuid, p_result text, p_data jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_id uuid; v_emp uuid;
begin
  select * into c from app.customers where id = p_customer;
  if not found then raise exception 'NOT_FOUND: customer'; end if;
  perform app.require_role(c.org_id, 'hotline', 'sales', 'manager');
  if coalesce(p_data->>'photo','') = '' then raise exception 'VALIDATION: 拜访要拍门店照片'; end if;
  select employee_id into v_emp from app.members where user_id = app.uid() and org_id = c.org_id;
  insert into app.visits (org_id, customer_id, by_user, employee_id, photo, location, activity, products_wanted, monthly_qty, buys_from,
    transport, nearby_suppliers, result, note, next_follow_on)
  values (c.org_id, p_customer, app.uid(), v_emp, p_data->>'photo', p_data->>'location', p_data->>'activity', p_data->>'products_wanted',
    nullif(p_data->>'monthly_qty','')::int, p_data->>'buys_from', p_data->>'transport', p_data->>'nearby_suppliers',
    p_result, nullif(trim(p_data->>'note'),''), nullif(p_data->>'next_follow_on','')::date)
  returning id into v_id;
  update app.customers set shop_photo = coalesce(shop_photo, p_data->>'photo'), monthly_qty = coalesce(nullif(p_data->>'monthly_qty','')::int, monthly_qty),
    buys_from = coalesce(p_data->>'buys_from', buys_from), transport = coalesce(p_data->>'transport', transport) where id = p_customer;
  return v_id;
end $$;

-- 批量导入客户 (中方): 备件客户带编码 + 档位; 回收客户不带档位, 标记 kind = recycle
-- p_rows: [{code?, name, phone?, city?, tier?, kind?, market?, zone?, recycle_type?, interested?, note?, credit_days?}]
create or replace function app.import_customers(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; n_new int := 0; n_upd int := 0; n_skip int := 0; v_id uuid; v_code text; v_phone text;
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(x->>'name'),'') = '' then n_skip := n_skip + 1; continue; end if;
    v_code := nullif(upper(trim(x->>'code')), '');
    v_phone := nullif(trim(x->>'phone'), '');
    select id into v_id from app.customers where org_id = p_org and (
      (v_code is not null and code = v_code) or
      (v_phone is not null and regexp_replace(phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g') and length(regexp_replace(v_phone, '\D', '', 'g')) >= 8));
    if found then
      update app.customers set
        kind = case when kind <> coalesce(x->>'kind','spare') then 'both' else kind end,
        market = coalesce(market, x->>'market'), zone = coalesce(zone, x->>'zone'), recycle_type = coalesce(recycle_type, x->>'recycle_type'),
        interested = coalesce(interested, (x->>'interested')::boolean), note = coalesce(note, x->>'note'), updated_at = now()
      where id = v_id;
      n_upd := n_upd + 1;
    else
      insert into app.customers (org_id, code, temp_code, name, phone, city, tier, status, source, kind, market, zone, recycle_type, interested,
        note, credit_days, country, address)
      values (p_org, v_code, case when v_code is null then app.next_doc_no(p_org, 'T') end, upper(trim(x->>'name')), v_phone, x->>'city',
        case when v_code is not null then nullif(x->>'tier','')::app.customer_tier end,
        case when v_code is not null and nullif(x->>'tier','') is not null then 'active'::app.customer_status else 'prospect'::app.customer_status end,
        'import', coalesce(x->>'kind','spare'), x->>'market', x->>'zone', x->>'recycle_type', (x->>'interested')::boolean,
        x->>'note', nullif(x->>'credit_days','')::int, coalesce(nullif(x->>'country',''), 'CI'), x->>'address');
      n_new := n_new + 1;
    end if;
  end loop;
  perform app.audit(p_org, 'import_customers', 'customers', null, jsonb_build_object('new', n_new, 'updated', n_upd, 'skipped', n_skip));
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'skipped', n_skip);
end $$;

-- 欠款预警 (只提醒, 不拦截): 超上限 / 最老未付超账期
create view app.v_customer_credit as
select c.id as customer_id, c.org_id, c.credit_limit, c.credit_days, c.has_agreement,
  coalesce(b.balance, 0) as balance,
  (select max(current_date - t.first_shipped_at::date) from app.v_deal_due t where t.customer_id = c.id and t.currency = 'XOF' and t.due > 0) as oldest_days,
  (c.credit_limit is not null and coalesce(b.balance, 0) > c.credit_limit) as over_limit,
  (c.credit_days is not null and coalesce((select max(current_date - t.first_shipped_at::date) from app.v_deal_due t
     where t.customer_id = c.id and t.currency = 'XOF' and t.due > 0), 0) > c.credit_days) as over_days
from app.customers c left join app.v_customer_balance b on b.customer_id = c.id and b.currency = 'XOF';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.hotline_calls, app.visits, app.v_customer_credit to authenticated;
    grant execute on function app.create_prospect(uuid, text, text, text, jsonb), app.activate_customer(uuid, text, app.customer_tier, uuid),
      app.set_customer_terms(uuid, numeric, int, boolean, uuid), app.log_call(uuid, text, text, text, text, date, uuid),
      app.log_visit(uuid, text, jsonb), app.import_customers(uuid, jsonb) to authenticated;
  end if;
end $$;
