-- LA&9S Operations · 0006 品牌列手动设置 (Frank 10-28 待改 10)
-- 品牌一般由型号前缀带出 (SS A05 → SS)；这里给中方手动改的入口。只改显示/统计用的品牌，不动编码和型号。
create or replace function app.set_brand(p_org uuid, p_products uuid[], p_brand text)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int;
begin
  perform app.require_role(p_org, 'admin');
  update app.products set brand = nullif(upper(trim(p_brand)), '') where org_id = p_org and id = any(p_products);
  get diagnostics n = row_count;
  perform app.audit(p_org, 'set_brand', 'products', null, jsonb_build_object('brand', p_brand, 'count', n));
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.set_brand(uuid, uuid[], text) to authenticated;
  end if;
end $$;
