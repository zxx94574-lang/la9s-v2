-- 0019 (11-07 下午): 客户清单格子里直接改 (Frank: 所有列都能在格子里改). 档位只有中方能改 (硬规则), 其他列中方 / 主管.
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
  update app.customers set
    name = case when p_data ? 'name' and coalesce(trim(p_data->>'name'),'') <> '' then upper(trim(p_data->>'name')) else name end,
    city = case when p_data ? 'city' then nullif(trim(p_data->>'city'),'') else city end,
    contact_name = case when p_data ? 'contact_name' then nullif(trim(p_data->>'contact_name'),'') else contact_name end,
    phone = case when p_data ? 'phone' then nullif(trim(p_data->>'phone'),'') else phone end,
    address = case when p_data ? 'address' then nullif(trim(p_data->>'address'),'') else address end,
    owner_employee_id = case when p_data ? 'owner_employee_id' then nullif(p_data->>'owner_employee_id','')::uuid else owner_employee_id end,
    tier = coalesce(v_tier, tier),
    updated_at = now()
  where id = p_customer;
  perform app.audit(c.org_id, 'edit_customer_info', 'customers', p_customer, p_data - 'photo');
end $$;
