-- LA&9S Operations · 0008 物料母表定价规则 (Frank 2026-10-29, 照飞书 Material Information 的公式)
--   到岸成本 XOF = ROUND((人民币成本 ÷ 汇率 + 运费 XOF), 取整到百位)        汇率默认 0.0107 (1 XOF = 0.0107 RMB)
--   S / Wholesale / Retail / Repair 价 = 到岸成本 + 各档 FEE (飞书的 S / A / B / C FEE)
--   FOB 成本 = 人民币成本 ÷ FOB 汇率 (默认 0.01135)
-- 手改过的档位价 (price_locked) 重算时不覆盖. 汇率和取整只有中方能改.

alter table app.products
  add column brand_group text,                 -- 屏幕 / 电池 / 小板 / 电池盖 (飞书「种类」)
  add column cost_owner text,                  -- 货权 LA / 9S
  add column bin_default text,                 -- 默认库位 (飞书 Bin Code)
  add column rmb_cost numeric(18,4),           -- 人民币成本
  add column freight_xof numeric(18,2),        -- 每件运费 XOF
  add column fee_s numeric(18,2), add column fee_a numeric(18,2),
  add column fee_b numeric(18,2), add column fee_c numeric(18,2),
  add column repair_bulk_discount numeric(18,2),  -- 飞书 C≥10 DISSCOUNT
  add column cost_updated_at timestamptz;

alter table app.product_prices add column locked boolean not null default false;   -- 中方手改，不被重算覆盖

create table app.price_settings (
  org_id uuid primary key references app.orgs(id),
  rmb_per_xof numeric(12,6) not null default 0.0107,      -- 1 XOF = ? RMB (本地价)
  rmb_per_xof_fob numeric(12,6) not null default 0.01135, -- FOB 成本用
  round_to int not null default 100,
  updated_by uuid, updated_at timestamptz not null default now()
);
alter table app.price_settings enable row level security;
create policy read_own on app.price_settings for select using (app.is_member(org_id));

create or replace function app.landed_cost(p_rmb numeric, p_freight numeric, s app.price_settings)
returns numeric language sql immutable as $$
  select case when p_rmb is null then null
    else round((p_rmb / s.rmb_per_xof + coalesce(p_freight, 0)) / s.round_to) * s.round_to end
$$;

-- 重算档位价: 只算有成本的物料; locked 的价格不动. 返回改动的价格条数
create or replace function app.recompute_prices(p_org uuid, p_products uuid[] default null)
returns int language plpgsql security definer set search_path = app, public as $$
declare s app.price_settings; p record; v_land numeric; t record; n int := 0; v_old numeric;
begin
  perform app.require_role(p_org, 'admin');
  insert into app.price_settings (org_id) values (p_org) on conflict do nothing;
  select * into s from app.price_settings where org_id = p_org;
  for p in select * from app.products where org_id = p_org and rmb_cost is not null and (p_products is null or id = any(p_products)) loop
    v_land := app.landed_cost(p.rmb_cost, p.freight_xof, s);
    for t in select * from (values ('S'::app.customer_tier, p.fee_s), ('WHOLESALE', p.fee_a), ('RETAIL', p.fee_b), ('REPAIR', p.fee_c)) as x(tier, fee) loop
      continue when t.fee is null;
      select price into v_old from app.product_prices where product_id = p.id and tier = t.tier and currency = 'XOF';
      if found and (select locked from app.product_prices where product_id = p.id and tier = t.tier and currency = 'XOF') then continue; end if;
      if v_old is distinct from v_land + t.fee then
        insert into app.product_prices (product_id, tier, currency, price) values (p.id, t.tier, 'XOF', v_land + t.fee)
        on conflict (product_id, tier, currency) do update set price = excluded.price, updated_at = now();
        n := n + 1;
      end if;
    end loop;
  end loop;
  perform app.audit(p_org, 'recompute_prices', 'product_prices', null, jsonb_build_object('changed', n));
  return n;
end $$;

-- 中方改成本 / 运费 / FEE (一行); 改完立即重算这一行
create or replace function app.set_product_cost(p_product uuid, p_rmb numeric, p_freight numeric,
  p_fee_s numeric, p_fee_a numeric, p_fee_b numeric, p_fee_c numeric)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.products where id = p_product;
  perform app.require_role(v_org, 'admin');
  if coalesce(p_rmb, 0) < 0 or coalesce(p_freight, 0) < 0 then raise exception 'VALIDATION: 成本和运费不能为负'; end if;
  update app.products set rmb_cost = p_rmb, freight_xof = p_freight, fee_s = p_fee_s, fee_a = p_fee_a, fee_b = p_fee_b, fee_c = p_fee_c,
    cost_updated_at = now() where id = p_product;
  perform app.recompute_prices(v_org, array[p_product]);
end $$;

-- 中方锁定某一档的价格 (一口价), 或解锁让它跟公式走
create or replace function app.set_tier_price(p_product uuid, p_tier app.customer_tier, p_price numeric, p_lock boolean)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.products where id = p_product;
  perform app.require_role(v_org, 'admin');
  if p_lock then
    if p_price is null or p_price < 0 then raise exception 'VALIDATION: 价格无效'; end if;
    insert into app.product_prices (product_id, tier, currency, price, locked) values (p_product, p_tier, 'XOF', p_price, true)
    on conflict (product_id, tier, currency) do update set price = excluded.price, locked = true, updated_at = now();
  else
    update app.product_prices set locked = false where product_id = p_product and tier = p_tier and currency = 'XOF';
    perform app.recompute_prices(v_org, array[p_product]);
  end if;
end $$;

create or replace function app.set_price_settings(p_org uuid, p_rate numeric, p_rate_fob numeric, p_round int)
returns int language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  if not (p_rate > 0 and p_rate_fob > 0 and p_round in (1, 10, 50, 100, 500, 1000)) then raise exception 'VALIDATION: 汇率或取整无效'; end if;
  insert into app.price_settings (org_id, rmb_per_xof, rmb_per_xof_fob, round_to, updated_by, updated_at)
  values (p_org, p_rate, p_rate_fob, p_round, app.uid(), now())
  on conflict (org_id) do update set rmb_per_xof = excluded.rmb_per_xof, rmb_per_xof_fob = excluded.rmb_per_xof_fob,
    round_to = excluded.round_to, updated_by = excluded.updated_by, updated_at = now();
  return app.recompute_prices(p_org, null);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.price_settings to authenticated;
    grant execute on function app.recompute_prices(uuid, uuid[]), app.set_product_cost(uuid, numeric, numeric, numeric, numeric, numeric, numeric),
      app.set_tier_price(uuid, app.customer_tier, numeric, boolean), app.set_price_settings(uuid, numeric, numeric, int) to authenticated;
  end if;
end $$;
