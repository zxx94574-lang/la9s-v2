-- 0102 国家经理（Frank 11-26 配权限）：罗兰这个岗位单独一个 —— 本地运营全管
--   = 仓库主管 + 销售主管 + 销售 + 热线 + 财务 + 库管员 能做的都能做；中方专属的（改价、成本利润、审批、系统规则）不给。
--   做法：不去改几百个函数里的岗位名单，只在「有没有这个岗位」的三个判断函数里把国家经理展开。
alter type app.role_name add value if not exists 'country_manager';

create or replace function app.role_expand(p_roles text[]) returns text[] language sql immutable as $$
  select case when 'country_manager' = any(p_roles) then p_roles || array['manager','sales_manager','sales','hotline','finance','picker']
              when 'sales_manager' = any(p_roles) then p_roles || array['sales']
              else p_roles end
$$;

create or replace function app.has_role(p_org uuid, p_roles app.role_name[])
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from app.members m
    where m.user_id = app.uid() and m.org_id = p_org and m.active
      and ('admin' = any(m.roles::text[]) or app.role_expand(m.roles::text[]) && p_roles::text[]))
$$;

create or replace function app.has_role_txt(p_org uuid, p_roles text[]) returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active
    and ('admin' = any(m.roles::text[]) or app.role_expand(m.roles::text[]) && p_roles))
$$;

create or replace function app.perm_ok(p_org uuid, p_action text, p_default text[])
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from app.members m
    where m.user_id = app.uid() and m.org_id = p_org and m.active
      and ('admin' = any(m.roles) or app.role_expand(m.roles::text[]) && coalesce(
        (select array(select jsonb_array_elements_text(s.value -> p_action)) from app.org_settings s
          where s.org_id = p_org and s.key = 'perm_matrix' and jsonb_typeof(s.value -> p_action) = 'array'),
        p_default)))
$$;
