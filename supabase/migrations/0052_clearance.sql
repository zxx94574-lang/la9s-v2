-- 0052 清仓价表 (Frank 11-17, 待改 344 / 345): 唯一允许亏本卖的情况 = 有「清仓决定」背书
-- 一条 = 型号 + 清仓价 + 起止日期 + 适用对象 (指定档位 / 指定客户, 都不填 = 所有客户); 卖价 ≥ 清仓价的行不算「会亏」, 不再被 0051 拦
-- 另: 349 没有成本的行要不要拦 —— 开关 loss_rules.no_cost (默认关: 真实库里没成本的编码还很多, 开了每张单都会被卡)

create table app.clearance_prices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  product_id uuid not null references app.products(id),
  price numeric(18,2) not null check (price >= 0),
  starts_on date not null default current_date,
  ends_on date not null,
  tiers app.customer_tier[],
  customer_ids uuid[],
  note text not null,
  created_by uuid, created_at timestamptz not null default now(),
  ended_at timestamptz, ended_by uuid,
  check (ends_on >= starts_on)
);
create index on app.clearance_prices (org_id, product_id);
alter table app.clearance_prices enable row level security;
create policy clearance_admin on app.clearance_prices for select using (app.has_role(org_id, array['admin']::app.role_name[]));

create or replace function app.set_clearance(p_org uuid, p_product uuid, p_price numeric, p_from date, p_to date, p_tiers text[], p_customers uuid[], p_note text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v uuid;
begin
  perform app.require_role(p_org, 'admin');
  if not exists (select 1 from app.products where id = p_product and org_id = p_org) then raise exception 'NOT_FOUND: 型号不存在'; end if;
  if coalesce(p_price, -1) < 0 then raise exception 'VALIDATION: 清仓价要填'; end if;
  if p_to is null then raise exception 'VALIDATION: 清仓要有结束日期'; end if;
  if p_to < coalesce(p_from, current_date) then raise exception 'VALIDATION: 结束日期不能早于开始日期'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 要写清仓原因（谁定的、为什么清）'; end if;
  insert into app.clearance_prices (org_id, product_id, price, starts_on, ends_on, tiers, customer_ids, note, created_by)
  values (p_org, p_product, p_price, coalesce(p_from, current_date), p_to,
    case when coalesce(cardinality(p_tiers), 0) = 0 then null else p_tiers::app.customer_tier[] end,
    case when coalesce(cardinality(p_customers), 0) = 0 then null else p_customers end, p_note, app.uid())
  returning id into v;
  perform app.audit(p_org, 'set_clearance', 'clearance_prices', v, jsonb_build_object('product', p_product, 'price', p_price, 'from', p_from, 'to', p_to, 'note', p_note));
  return v;
end $$;

create or replace function app.end_clearance(p_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.clearance_prices;
begin
  select * into c from app.clearance_prices where id = p_id;
  if c.id is null then raise exception 'NOT_FOUND: 清仓价不存在'; end if;
  perform app.require_role(c.org_id, 'admin');
  update app.clearance_prices set ended_at = now(), ended_by = app.uid() where id = p_id and ended_at is null;
  perform app.audit(c.org_id, 'end_clearance', 'clearance_prices', p_id, '{}'::jsonb);
end $$;

-- 内部: 这个客户今天买这个型号, 有没有生效的清仓价 (多条取最低)
create or replace function app.clearance_floor(p_product uuid, p_customer uuid, p_on date default current_date)
returns numeric language sql stable security definer set search_path = app, public as $$
  select min(cp.price) from app.clearance_prices cp join app.customers c on c.id = p_customer
  where cp.product_id = p_product and cp.org_id = c.org_id and cp.ended_at is null and p_on between cp.starts_on and cp.ends_on
    and (cp.tiers is null or c.tier = any(cp.tiers)) and (cp.customer_ids is null or c.id = any(cp.customer_ids))
$$;

-- 重写 0051 的「会亏的行」: 卖价 ≥ 生效清仓价的不算; 开了 no_cost 开关时, 没成本的行也算要批
create or replace function app.deal_loss_lines(p_deal uuid)
returns table (deal_line_id uuid, price_xof numeric, unit_cost numeric)
language sql stable security definer set search_path = app, public as $$
  select dl.id, round(coalesce(dl.unit_price, 0) * k.k, 2), u.unit_cost
  from app.deals d
  join app.deal_lines dl on dl.deal_id = d.id
  cross join lateral (select case when d.currency = 'XOF' then 1::numeric when coalesce(d.fx_rate, 0) > 0 then d.fx_rate else null end as k) k
  cross join lateral app.unit_cost_now(dl.id) u
  where d.id = p_deal and d.kind = 'normal' and dl.product_id is not null and k.k is not null
    and (case when dl.qty_supply > 0 then dl.qty_supply else dl.qty_req end) > 0
    and ( (u.unit_cost is not null and coalesce(dl.unit_price, 0) * k.k < u.unit_cost
            and not coalesce(coalesce(dl.unit_price, 0) * k.k >= app.clearance_floor(dl.product_id, d.customer_id), false))
       or (u.unit_cost is null and coalesce((select (value->>'no_cost')::boolean from app.org_settings where org_id = d.org_id and key = 'loss_rules'), false)) )
$$;

-- 给界面: 这张单各行生效的清仓价 (只中方)
create or replace function app.deal_clearance(p_deal uuid)
returns table (deal_line_id uuid, floor numeric)
language plpgsql stable security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'admin');
  return query select dl.id, app.clearance_floor(dl.product_id, d.customer_id) from app.deal_lines dl
    where dl.deal_id = p_deal and dl.product_id is not null and app.clearance_floor(dl.product_id, d.customer_id) is not null;
end $$;

do $$ begin
  revoke all on function app.clearance_floor(uuid, uuid, date) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function app.clearance_floor(uuid, uuid, date) from authenticated;
    grant select on app.clearance_prices to authenticated;
    grant execute on function app.set_clearance(uuid, uuid, numeric, date, date, text[], uuid[], text), app.end_clearance(uuid), app.deal_clearance(uuid) to authenticated;
  end if;
end $$;
