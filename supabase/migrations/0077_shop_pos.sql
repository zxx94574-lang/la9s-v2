-- 0077 客户店里的收银 + 店里库存（Frank 11-22）
-- 给客户老板 / 店员用：选货 → 价格 → 收钱 → 一单就完，进当天流水。没有找货 / 出库 / 签收。
-- 店里库存按「型号 + 种类 + 来源 / 品质」分：我们出的货自动标 LA&9S 自动进库存；别家的货他自己录、选品质标签。
-- 他店里的账和我们的应收、资金账户完全分开；他看不到我们的价格和成本；我们中方能看（客户账号页）。

create table app.shop_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers(id),
  product_id uuid references app.products(id),         -- 从我们这进的货才有
  model text not null, category text not null default '', quality text not null default 'LA&9S',
  qty int not null default 0,
  price numeric(18,2),                                  -- 他自己定的零售价（XOF）
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (customer_id, model, category, quality)
);
create table app.shop_sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references app.customers(id),
  store_id uuid references app.portal_stores(id),
  sale_no text not null,
  sold_at timestamptz not null default now(),
  buyer text,                                           -- 空 = 零售客人
  pay_method text not null default 'cash',
  total numeric(18,2) not null default 0,
  note text, created_by uuid,
  voided_at timestamptz, void_reason text, voided_by uuid
);
create table app.shop_sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references app.shop_sales(id) on delete cascade,
  item_id uuid not null references app.shop_items(id),
  qty int not null check (qty > 0), price numeric(18,2) not null check (price >= 0)
);
create table app.shop_moves (
  id bigint generated always as identity primary key,
  item_id uuid not null references app.shop_items(id),
  qty int not null,
  kind text not null check (kind in ('from_us','from_us_void','from_us_return','manual_in','sale','sale_void','adjust')),
  ref uuid, note text, at timestamptz not null default now(), by_user uuid
);
create index on app.shop_sales (customer_id, sold_at);
create index on app.shop_moves (item_id, at);
alter table app.shop_items enable row level security; alter table app.shop_sales enable row level security;
alter table app.shop_sale_lines enable row level security; alter table app.shop_moves enable row level security;

-- 谁能看：这个客户自己的人（老板 / 店员），或者我们的中方
create or replace function app.shop_can_see(p_customer uuid) returns boolean language sql stable security definer set search_path = app, public as $$
  select p_customer = (select customer_id from app.portal_me())
      or exists (select 1 from app.customers c where c.id = p_customer and app.has_role(c.org_id, array['admin']::app.role_name[]))
$$;
create policy shop_read on app.shop_items for select using (app.shop_can_see(customer_id));
create policy shop_read on app.shop_sales for select using (app.shop_can_see(customer_id));
create policy shop_read on app.shop_sale_lines for select using (exists (select 1 from app.shop_sales s where s.id = sale_id and app.shop_can_see(s.customer_id)));
create policy shop_read on app.shop_moves for select using (exists (select 1 from app.shop_items i where i.id = item_id and app.shop_can_see(i.customer_id)));

create or replace function app._shop_move(p_item uuid, p_qty int, p_kind text, p_ref uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  update app.shop_items set qty = qty + p_qty, updated_at = now() where id = p_item;
  insert into app.shop_moves (item_id, qty, kind, ref, note, by_user) values (p_item, p_qty, p_kind, p_ref, p_note, app.uid());
end $$;
revoke all on function app._shop_move(uuid, int, text, uuid, text) from public;

create or replace function app._shop_item(p_customer uuid, p_product uuid, p_model text, p_category text, p_quality text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  insert into app.shop_items (customer_id, product_id, model, category, quality)
  values (p_customer, p_product, upper(trim(p_model)), coalesce(trim(p_category), ''), coalesce(nullif(trim(p_quality), ''), 'LA&9S'))
  on conflict (customer_id, model, category, quality) do update set product_id = coalesce(app.shop_items.product_id, excluded.product_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function app._shop_item(uuid, uuid, text, text, text) from public;

-- 开了客户账号的客户（有 customer_accounts 或 linked_org）：我们出库 → 他店里自动加库存；撤销出库 / 退货 → 减
create or replace function app._shop_on(p_customer uuid) returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.customer_accounts a where a.customer_id = p_customer and a.status = 'active')
      or exists (select 1 from app.customers c where c.id = p_customer and c.linked_org_id is not null)
$$;
create or replace function app.trg_shop_from_us() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d record;
begin
  select dl.product_id, coalesce(p.model, dl.req_model) as model, coalesce(cat.name, '') as category, dd.customer_id
    into d from app.deal_lines dl join app.deals dd on dd.id = dl.deal_id left join app.products p on p.id = dl.product_id left join app.categories cat on cat.id = p.category_id
    where dl.id = new.deal_line_id;
  if d.customer_id is null or not app._shop_on(d.customer_id) or new.qty <= 0 then return new; end if;
  perform app._shop_move(app._shop_item(d.customer_id, d.product_id, d.model, d.category, 'LA&9S'), new.qty, 'from_us', new.shipment_id, null);
  return new;
end $$;
drop trigger if exists shop_from_us on app.shipment_lines;
create trigger shop_from_us after insert on app.shipment_lines for each row execute function app.trg_shop_from_us();

create or replace function app.trg_shop_ship_void() returns trigger language plpgsql security definer set search_path = app, public as $$
declare m record;
begin
  if old.voided_at is null and new.voided_at is not null then
    for m in select item_id, sum(qty) q from app.shop_moves where ref = new.id and kind = 'from_us' group by 1 loop
      perform app._shop_move(m.item_id, -m.q::int, 'from_us_void', new.id, '我们撤销了这次出库');
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists shop_ship_void on app.shipments;
create trigger shop_ship_void after update of voided_at on app.shipments for each row execute function app.trg_shop_ship_void();

create or replace function app.trg_shop_return() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d record; l record;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select customer_id into d from app.deals where id = new.deal_id;
    if not app._shop_on(d.customer_id) then return new; end if;
    for l in select rl.qty, dl.product_id, coalesce(p.model, dl.req_model) model, coalesce(cat.name, '') category
             from app.return_lines rl join app.deal_lines dl on dl.id = rl.deal_line_id left join app.products p on p.id = dl.product_id
             left join app.categories cat on cat.id = p.category_id where rl.return_id = new.id loop
      perform app._shop_move(app._shop_item(d.customer_id, l.product_id, l.model, l.category, 'LA&9S'), -l.qty, 'from_us_return', new.id, '退回给 LA&9S');
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists shop_return on app.returns;
create trigger shop_return after update of status on app.returns for each row execute function app.trg_shop_return();

-- 当前登录的客户（老板 / 店员）
create or replace function app._shop_check(p_customer uuid, p_role app.role_name, p_boss_only boolean default false)
returns void language plpgsql stable security definer set search_path = app, public as $$
begin
  if p_customer is null then raise exception 'PERMISSION_DENIED: 客户账号才能用店里的收银'; end if;
  if p_boss_only and p_role <> 'boss' then raise exception 'PERMISSION_DENIED: 这个要老板来做'; end if;
end $$;

-- 别家的货进店 / 补录库存（老板、店员都能录）
create or replace function app.shop_stock_in(p_model text, p_category text, p_quality text, p_qty int, p_price numeric default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare me record; v_id uuid;
begin
  select * into me from app.portal_me(); perform app._shop_check(me.customer_id, me.role, false);
  if coalesce(trim(p_model), '') = '' then raise exception 'VALIDATION: 写型号'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
  if coalesce(trim(p_quality), '') = '' then raise exception 'VALIDATION: 选品质（别家的货要和 LA&9S 的分开）'; end if;
  v_id := app._shop_item(me.customer_id, null, p_model, p_category, p_quality);
  perform app._shop_move(v_id, p_qty, 'manual_in', null, p_note);
  if p_price is not null then update app.shop_items set price = p_price where id = v_id; end if;
  return v_id;
end $$;

create or replace function app.shop_set_price(p_item uuid, p_price numeric)
returns void language plpgsql security definer set search_path = app, public as $$
declare me record;
begin
  select * into me from app.portal_me(); perform app._shop_check(me.customer_id, me.role, true);
  if coalesce(p_price, -1) < 0 then raise exception 'VALIDATION: 价格不能为负'; end if;
  update app.shop_items set price = p_price, updated_at = now() where id = p_item and customer_id = me.customer_id;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

create or replace function app.shop_adjust(p_item uuid, p_new_qty int, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare me record; i app.shop_items;
begin
  select * into me from app.portal_me(); perform app._shop_check(me.customer_id, me.role, true);
  select * into i from app.shop_items where id = p_item and customer_id = me.customer_id for update;
  if i.id is null then raise exception 'NOT_FOUND'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 写为什么调（盘点 / 坏了 / 送人…）'; end if;
  if p_new_qty < 0 then raise exception 'VALIDATION: 数量不能为负'; end if;
  if p_new_qty <> i.qty then perform app._shop_move(p_item, p_new_qty - i.qty, 'adjust', null, trim(p_reason)); end if;
end $$;

-- 收银：一单就完
create or replace function app.shop_sell(p_lines jsonb, p_pay text, p_buyer text default null, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare me record; v_id uuid; v_no text; x jsonb; i app.shop_items; v_q int; v_p numeric; v_total numeric := 0; v_org uuid;
begin
  select * into me from app.portal_me(); perform app._shop_check(me.customer_id, me.role, false);
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'VALIDATION: 还没选货'; end if;
  select org_id into v_org from app.customers where id = me.customer_id;
  v_no := 'POS-' || to_char(now() at time zone 'Africa/Abidjan', 'YYMMDD') || '-' ||
    lpad(((select count(*) from app.shop_sales where customer_id = me.customer_id and (sold_at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date) + 1)::text, 3, '0');
  insert into app.shop_sales (customer_id, store_id, sale_no, buyer, pay_method, note, created_by)
  values (me.customer_id, me.store_id, v_no, nullif(trim(coalesce(p_buyer, '')), ''), coalesce(nullif(p_pay, ''), 'cash'), nullif(trim(coalesce(p_note, '')), ''), app.uid())
  returning id into v_id;
  for x in select * from jsonb_array_elements(p_lines) loop
    select * into i from app.shop_items where id = (x->>'item_id')::uuid and customer_id = me.customer_id for update;
    if i.id is null then raise exception 'NOT_FOUND: 货不在你店里的库存里'; end if;
    v_q := coalesce((x->>'qty')::int, 0); if v_q <= 0 then continue; end if;
    v_p := coalesce(nullif(x->>'price', '')::numeric, i.price);
    if v_p is null then raise exception 'VALIDATION: % 还没定零售价', i.model; end if;
    if v_q > i.qty then raise exception 'VALIDATION: % 库存只有 %，卖不了 %（先在库存里补录）', i.model, i.qty, v_q; end if;
    insert into app.shop_sale_lines (sale_id, item_id, qty, price) values (v_id, i.id, v_q, v_p);
    perform app._shop_move(i.id, -v_q, 'sale', v_id, null);
    v_total := v_total + v_q * v_p;
  end loop;
  if v_total = 0 and not exists (select 1 from app.shop_sale_lines where sale_id = v_id) then raise exception 'VALIDATION: 没有要卖的货'; end if;
  update app.shop_sales set total = v_total where id = v_id;
  return v_no;
end $$;

create or replace function app.shop_void_sale(p_sale uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare me record; s app.shop_sales; l record;
begin
  select * into me from app.portal_me(); perform app._shop_check(me.customer_id, me.role, true);
  select * into s from app.shop_sales where id = p_sale and customer_id = me.customer_id for update;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  if s.voided_at is not null then raise exception 'BAD_STATE: 已经撤销过了'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 写撤销原因'; end if;
  for l in select item_id, qty from app.shop_sale_lines where sale_id = p_sale loop
    perform app._shop_move(l.item_id, l.qty, 'sale_void', p_sale, trim(p_reason));
  end loop;
  update app.shop_sales set voided_at = now(), void_reason = trim(p_reason), voided_by = app.uid() where id = p_sale;
end $$;

-- 中方看：每个开了账号的客户一行（我们卖给他的 + 他店里的收银 / 库存）
create or replace function app.customer_accounts_overview(p_org uuid)
returns table (customer_id uuid, code text, name text, tier text, city text, account_status text, login text, last_login_at timestamptz,
  portal_opts jsonb, stores int, our_30d numeric, our_pcs_30d bigint, balance numeric,
  pos_today numeric, pos_30d numeric, pos_n_30d bigint, shop_items int, shop_pcs bigint, shop_la9s_pcs bigint)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  return query
  select c.id, coalesce(c.code, c.temp_code), c.name, c.tier::text, c.city, a.status, a.login, a.last_login_at, coalesce(c.portal_opts, '{}'::jsonb),
    (select count(*)::int from app.portal_stores s where s.customer_id = c.id and s.active),
    (select coalesce(sum(sl.qty * sl.unit_price), 0) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
      where d.customer_id = c.id and sh.voided_at is null and sh.shipped_at > now() - interval '30 days'),
    (select coalesce(sum(sl.qty), 0) from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
      where d.customer_id = c.id and sh.voided_at is null and sh.shipped_at > now() - interval '30 days'),
    coalesce((select b.balance from app.v_customer_balance b where b.customer_id = c.id and b.currency = 'XOF'), 0),
    (select coalesce(sum(total), 0) from app.shop_sales x where x.customer_id = c.id and x.voided_at is null and (x.sold_at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date),
    (select coalesce(sum(total), 0) from app.shop_sales x where x.customer_id = c.id and x.voided_at is null and x.sold_at > now() - interval '30 days'),
    (select count(*) from app.shop_sales x where x.customer_id = c.id and x.voided_at is null and x.sold_at > now() - interval '30 days'),
    (select count(*)::int from app.shop_items i where i.customer_id = c.id and i.qty > 0),
    (select coalesce(sum(qty), 0) from app.shop_items i where i.customer_id = c.id),
    (select coalesce(sum(qty), 0) from app.shop_items i where i.customer_id = c.id and i.quality = 'LA&9S')
  from app.customers c left join app.customer_accounts a on a.customer_id = c.id
  where c.org_id = p_org and (a.id is not null or c.linked_org_id is not null)
  order by c.code nulls last, c.name;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.shop_items, app.shop_sales, app.shop_sale_lines, app.shop_moves to authenticated;
    grant execute on function app.shop_stock_in(text, text, text, int, numeric, text), app.shop_set_price(uuid, numeric), app.shop_adjust(uuid, int, text),
      app.shop_sell(jsonb, text, text, text), app.shop_void_sale(uuid, text), app.customer_accounts_overview(uuid), app.shop_can_see(uuid) to authenticated;
  end if;
end $$;
