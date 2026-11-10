-- 0025 (11-08 Frank 拍板): 每张表都能「自己加列 + 给列加选项」。
-- 做法: 一张通用的自定义值表 row_attrs (哪张表 / 哪一行 / {列key: 值}) + 一个保存函数; 每张表的自定义列定义存 org_settings 'table_options:<表>'.
-- 限制 (Frank 接受): 自定义列只能是 单选 / 文本 / 日期 / 数字, 不参与金额计算和金蝶对账.
create table app.row_attrs (
  org_id uuid not null references app.orgs(id),
  tbl text not null,
  row_id uuid not null,
  attrs jsonb not null default '{}'::jsonb,
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (org_id, tbl, row_id)
);
alter table app.row_attrs enable row level security;
create policy row_attrs_member on app.row_attrs for select using (app.is_member(org_id));

create or replace function app.set_row_attrs(p_org uuid, p_tbl text, p_row uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  if p_tbl !~ '^[a-z_]{2,40}$' then raise exception 'VALIDATION: 表名不对'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'VALIDATION: 要给 {列: 值}'; end if;
  insert into app.row_attrs (org_id, tbl, row_id, attrs, updated_by)
  values (p_org, p_tbl, p_row, jsonb_strip_nulls(p_patch), app.uid())
  on conflict (org_id, tbl, row_id) do update set attrs = jsonb_strip_nulls(app.row_attrs.attrs || p_patch), updated_by = app.uid(), updated_at = now();
end $$;

-- 客户档案今天 (0023) 先做的 customers.attrs / customer_options.custom 并进来, 以后只用这一套
insert into app.row_attrs (org_id, tbl, row_id, attrs)
select org_id, 'customers', id, attrs from app.customers where attrs <> '{}'::jsonb
on conflict do nothing;
insert into app.org_settings (org_id, key, value, updated_by, updated_at)
select org_id, 'table_options:customers', jsonb_build_object('custom', value->'custom'), updated_by, now()
from app.org_settings where key = 'customer_options' and jsonb_typeof(value->'custom') = 'array' and jsonb_array_length(value->'custom') > 0
on conflict (org_id, key) do nothing;
