-- 0027 (11-09 上午 Frank 21 条 · A 组建单页): ① 建单时快速加客户 (电话可空, 按店铺类型自动给估价档位, 销售主管也能建)
-- ② 潜客可有「估价档位」(报价用; 转正式时再定正式档位) ③ 报价时中方可直接给价 (unit_price, 标手改) ④ 热线「客户现在忙, 稍后再联系」
alter table app.deals add column hotline_busy_at timestamptz, add column hotline_busy_note text;

create or replace function app.create_prospect(p_org uuid, p_name text, p_phone text, p_city text, p_extra jsonb default '{}')
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_owner uuid; v_tier app.customer_tier; v_shop text;
begin
  perform app.require_role(p_org, 'hotline', 'sales', 'manager', 'sales_manager');
  if coalesce(trim(p_name),'') = '' then raise exception 'VALIDATION: 客户名必填'; end if;
  if coalesce(trim(p_phone),'') <> '' and exists (select 1 from app.customers where org_id = p_org and regexp_replace(phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')) then
    raise exception 'CONFLICT: 这个电话已经有客户档案了';
  end if;
  v_shop := upper(coalesce(p_extra->>'shop_type',''));
  v_tier := case
    when (p_extra->>'tier') in ('S','WHOLESALE','RETAIL','REPAIR') then (p_extra->>'tier')::app.customer_tier
    when v_shop like 'WHOLESALE%' then 'WHOLESALE'::app.customer_tier
    when v_shop like 'RETAIL%' then 'RETAIL'::app.customer_tier
    when v_shop like 'REPAIR%' then 'REPAIR'::app.customer_tier
    else null end;
  select employee_id into v_owner from app.members where user_id = app.uid() and org_id = p_org;
  insert into app.customers (org_id, temp_code, name, city, status, phone, source, owner_employee_id, kind, tier,
    shop_name, market, zone, shop_type, monthly_qty, buys_from, transport, nearby_suppliers, location, shop_photo, note)
  values (p_org, app.next_doc_no(p_org, 'T'), upper(trim(p_name)), nullif(trim(p_city),''), 'prospect', nullif(trim(p_phone),''), coalesce(p_extra->>'source', 'visit'), v_owner,
    coalesce(p_extra->>'kind', 'spare'), v_tier, p_extra->>'shop_name', p_extra->>'market', p_extra->>'zone', nullif(p_extra->>'shop_type',''),
    nullif(p_extra->>'monthly_qty','')::int, p_extra->>'buys_from', p_extra->>'transport', p_extra->>'nearby_suppliers',
    p_extra->>'location', p_extra->>'shop_photo', p_extra->>'note')
  returning id into v_id;
  perform app.audit(p_org, 'create_prospect', 'customers', v_id, p_extra);
  return v_id;
end $$;

-- 客户资料: 潜客的档位 = 估价档位, 热线 / 主管 / 销售主管 / 中方可改; 正式客户的档位只中方
create or replace function app.edit_customer_info(p_customer uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_tier app.customer_tier;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(c.org_id, 'admin', 'manager', 'sales_manager', 'hotline');
  if p_data ? 'tier' then
    if c.status = 'active' then perform app.require_role(c.org_id, 'admin'); end if;
    v_tier := nullif(p_data->>'tier','')::app.customer_tier;
    if v_tier is null and c.status = 'active' then raise exception 'VALIDATION: 正式客户档位不能空'; end if;
  end if;
  if p_data ? 'supply' and coalesce(p_data->>'supply','') not in ('local','fob') then raise exception 'VALIDATION: 供货方式只能是 本地备货 / FOB'; end if;
  if (p_data ? 'name' or p_data ? 'owner_employee_id') then perform app.require_role(c.org_id, 'admin', 'manager', 'sales_manager'); end if;
  update app.customers set
    name = case when p_data ? 'name' and coalesce(trim(p_data->>'name'),'') <> '' then upper(trim(p_data->>'name')) else name end,
    city = case when p_data ? 'city' then nullif(trim(p_data->>'city'),'') else city end,
    contact_name = case when p_data ? 'contact_name' then nullif(trim(p_data->>'contact_name'),'') else contact_name end,
    phone = case when p_data ? 'phone' then nullif(trim(p_data->>'phone'),'') else phone end,
    address = case when p_data ? 'address' then nullif(trim(p_data->>'address'),'') else address end,
    owner_employee_id = case when p_data ? 'owner_employee_id' then nullif(p_data->>'owner_employee_id','')::uuid else owner_employee_id end,
    tier = case when p_data ? 'tier' then v_tier else tier end,
    supply = coalesce(nullif(p_data->>'supply',''), supply),
    follow_status = case when p_data ? 'follow_status' then nullif(trim(p_data->>'follow_status'),'') else follow_status end,
    shop_type = case when p_data ? 'shop_type' then nullif(trim(p_data->>'shop_type'),'') else shop_type end,
    market = case when p_data ? 'market' then nullif(trim(p_data->>'market'),'') else market end,
    zone = case when p_data ? 'zone' then nullif(trim(p_data->>'zone'),'') else zone end,
    attrs = case when p_data ? 'attrs' and jsonb_typeof(p_data->'attrs') = 'object' then jsonb_strip_nulls(attrs || (p_data->'attrs')) else attrs end,
    updated_at = now()
  where id = p_customer;
  perform app.audit(c.org_id, 'edit_customer_info', 'customers', p_customer, p_data - 'photo');
end $$;

-- 报价: 行里可带 unit_price (中方直接给价 = 手改, 留痕); 带了价的行不受 0 价拦截
drop function if exists app.create_quote_checked(uuid, uuid, text, jsonb, text);
create or replace function app.create_quote_checked(p_org uuid, p_customer uuid, p_currency text, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_bad text; v_tier app.customer_tier; l jsonb; i int := 0; v_line uuid; v_manual boolean := false;
begin
  v_id := app.create_quote(p_org, p_customer, p_currency, p_lines, p_note);
  -- 手给的价: 按顺序对应 deal_lines.seq
  for l in select * from jsonb_array_elements(p_lines) loop
    i := i + 1;
    if coalesce((l->>'unit_price')::numeric, 0) > 0 and l ? 'product_id' then
      if not v_manual then perform app.require_role(p_org, 'admin'); v_manual := true; end if;
      select id into v_line from app.deal_lines where deal_id = v_id and seq = i;
      update app.deal_lines set unit_price = (l->>'unit_price')::numeric, price_manual = true, price_set_by = app.uid() where id = v_line;
      perform app.deal_event(v_id, 'price_set', jsonb_build_object('line', v_line, 'to', (l->>'unit_price')::numeric, 'reason', '报价时直接给价'));
    end if;
  end loop;
  select c.tier into v_tier from app.customers c where c.id = p_customer;
  select string_agg(coalesce(p.code,'') || ' ' || p.model, '、' order by dl.seq) into v_bad
    from app.deal_lines dl join app.products p on p.id = dl.product_id
   where dl.deal_id = v_id and coalesce(dl.unit_price, 0) <= 0;
  if v_bad is not null then
    if v_tier is null then raise exception 'VALIDATION: 这个客户还没定档位，报价会全是 0。先在客户档案给档位（或转正式），再报价'; end if;
    raise exception 'VALIDATION: 这些型号在「%」档没有价格，报价单不能带 0：%。先到「物料与定价」填价，或在单价格子里直接给价', v_tier, v_bad;
  end if;
  if exists (select 1 from app.deal_lines where deal_id = v_id and coalesce(qty_req,0) <= 0) then raise exception 'VALIDATION: 数量不能为 0'; end if;
  return v_id;
end $$;

-- 热线: 客户现在忙, 稍后再联系 (单子留在报价·确认, 进待办, 提醒照旧)
create or replace function app.hotline_busy(p_deal uuid, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager', 'sales_manager');
  if d.status <> 'quoted' then raise exception 'BAD_STATE: 只有待确认的报价能标稍后联系'; end if;
  update app.deals set hotline_busy_at = now(), hotline_busy_note = nullif(trim(p_note),''), hotline_opened_at = coalesce(hotline_opened_at, now()) where id = p_deal;
  perform app.deal_event(p_deal, 'hotline_busy', jsonb_build_object('note', p_note));
end $$;
