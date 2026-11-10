-- 0023 (11-08 Frank): 客户分「本地备货 / FOB」(编号连着, 只是一个判断栏); 客户跟进状态; 客户资料的选项 (城市 / 店铺类型 / 市场 / 跟进状态) 由中方在「选项设置」里维护
alter table app.customers add column supply text not null default 'local' check (supply in ('local','fob')),
  add column follow_status text,
  add column attrs jsonb not null default '{}'::jsonb;   -- 中方自定义的客户资料列 (选项设置里加), {列key: 选项代码}
-- 现有数据: 名字以 FOB 开头的就是 FOB 客户 (飞书 / 金蝶的习惯)
update app.customers set supply = 'fob' where upper(name) like 'FOB %' or upper(name) like 'FOB-%';

create or replace function app.edit_customer_info(p_customer uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_tier app.customer_tier;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(c.org_id, 'admin', 'manager', 'sales_manager');
  if p_data ? 'tier' then
    perform app.require_role(c.org_id, 'admin');
    if c.status <> 'active' then raise exception 'VALIDATION: 潜客没有档位，先转正式客户'; end if;
    v_tier := nullif(p_data->>'tier','')::app.customer_tier;
    if v_tier is null then raise exception 'VALIDATION: 档位不能空'; end if;
  end if;
  if p_data ? 'supply' and coalesce(p_data->>'supply','') not in ('local','fob') then raise exception 'VALIDATION: 供货方式只能是 本地备货 / FOB'; end if;
  update app.customers set
    name = case when p_data ? 'name' and coalesce(trim(p_data->>'name'),'') <> '' then upper(trim(p_data->>'name')) else name end,
    city = case when p_data ? 'city' then nullif(trim(p_data->>'city'),'') else city end,
    contact_name = case when p_data ? 'contact_name' then nullif(trim(p_data->>'contact_name'),'') else contact_name end,
    phone = case when p_data ? 'phone' then nullif(trim(p_data->>'phone'),'') else phone end,
    address = case when p_data ? 'address' then nullif(trim(p_data->>'address'),'') else address end,
    owner_employee_id = case when p_data ? 'owner_employee_id' then nullif(p_data->>'owner_employee_id','')::uuid else owner_employee_id end,
    tier = coalesce(v_tier, tier),
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
