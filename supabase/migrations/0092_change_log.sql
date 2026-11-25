-- 0092 变更记录（体检第 2 组 / 待改 116）：改设置时把「改前 → 改后」一起记下来，变更记录页按人 / 时间 / 哪一项看
create or replace function app.set_org_setting(p_org uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_old jsonb;
begin
  perform app.require_role(p_org, 'admin');
  select value into v_old from app.org_settings where org_id = p_org and key = p_key;
  if p_value is null then delete from app.org_settings where org_id = p_org and key = p_key;
  else
    insert into app.org_settings values (p_org, p_key, p_value, app.uid(), now())
    on conflict (org_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;
  if v_old is distinct from p_value then
    perform app.audit(p_org, case when p_value is null then 'reset_setting' else 'set_org_setting' end, 'org_settings', null, jsonb_build_object('key', p_key, 'old', v_old, 'new', p_value));
  end if;
end $$;

-- 变更记录（只中方看）
create or replace function app.change_log(p_org uuid, p_limit int default 500)
returns table (id bigint, at timestamptz, who text, action text, entity text, detail jsonb)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query select a.id, a.at, coalesce(e.short_name, m.role::text, '系统'), a.action, a.entity, a.detail
    from app.audit_log a left join app.members m on m.user_id = a.user_id and m.org_id = a.org_id left join app.employees e on e.id = m.employee_id
    where a.org_id = p_org order by a.at desc limit p_limit;
end $$;

-- 系统健康：各类数据多少条、最近一次变动
create or replace function app.system_health(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  return jsonb_build_object(
    'deals', (select count(*) from app.deals where org_id = p_org), 'last_deal', (select max(created_at) from app.deals where org_id = p_org),
    'shipments', (select count(*) from app.shipments where org_id = p_org), 'last_ship', (select max(created_at) from app.shipments where org_id = p_org),
    'receipts', (select count(*) from app.receipts where org_id = p_org), 'last_receipt', (select max(created_at) from app.receipts where org_id = p_org),
    'customers', (select count(*) from app.customers where org_id = p_org), 'products', (select count(*) from app.products where org_id = p_org),
    'stock_moves', (select count(*) from app.stock_moves m join app.stock_items s on s.id = m.stock_item_id join app.warehouses w on w.id = s.warehouse_id where w.org_id = p_org),
    'last_snapshot', (select max(day) from app.dash_snapshots where org_id = p_org),
    'last_change', (select max(at) from app.audit_log where org_id = p_org),
    'last_export', (select max(e.at) from app.export_log e where e.org_id = p_org and e.kind like 'full:%')
  );
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function app.change_log(uuid, int), app.system_health(uuid) to authenticated; end if;
end $$;
