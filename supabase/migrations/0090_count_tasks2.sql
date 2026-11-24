-- 0090 盘点改版（Frank 11-24 15:02–15:20，待改 512 / 513）
-- 任务 = 种类 + 货架（一个货架只派给一个人）；员工按任务一层一层盘
-- 确认写进系统后出货就恢复（本地运营优先，金蝶只是对账）；金蝶要录的单在盘点里列着，财务录完点「金蝶已录完」
alter table app.count_tasks add column if not exists shelves text[] not null default '{}', add column if not exists category_id uuid references app.categories(id);
alter table app.counts add column if not exists kd_done_at timestamptz, add column if not exists kd_done_by uuid;

-- 库位布局默认值加上「这个房间放哪些品牌」（型号名前缀，用来把型号按品牌分组、本房间的排前面）
create or replace function app.bin_rooms(p_org uuid) returns jsonb language sql stable security definer set search_path = app, public as $$
  select coalesce((select value from app.org_settings where org_id = p_org and key = 'bin_rooms'),
    '[{"room":"TXI","name":"Tecno / Infinix / itel","shelves":"ABCDEFG","levels":4,"brands":"TECNO,INFINIX,ITEL,TX,IT"},{"room":"AA","name":"iPhone","shelves":"ABCD","levels":4,"brands":"AA,IPHONE"},{"room":"SS","name":"三星","shelves":"ABCD","levels":4,"brands":"SS,SAMSUNG"},{"room":"LR","name":"Living Room","shelves":"","levels":0,"brands":""},{"room":"SLR","name":"Small Living Room","shelves":"","levels":0,"brands":""}]'::jsonb)
$$;

-- 派任务：谁 · 哪些货架（例 SS-A / LR）· 什么种类（空 = 全部）；同一次盘点里一个货架只能派给一个人
create or replace function app.count_task_set2(p_count uuid, p_emp uuid, p_shelves text[], p_category uuid) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v uuid; s text; m text[]; r jsonb; v_who text; v_sh text[];
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  perform app.require_role(v_org, 'admin', 'manager');
  v_sh := array(select distinct upper(trim(x)) from unnest(coalesce(p_shelves, '{}')) x where trim(x) <> '');
  if cardinality(v_sh) = 0 then raise exception 'VALIDATION: 选要盘的货架'; end if;
  foreach s in array v_sh loop
    m := regexp_match(s, '^([A-Z0-9]+)(?:-([A-Z]))?$');
    if m is null then raise exception 'VALIDATION: 货架「%」不对，例 SS-A；没货架的房间写房间名', s; end if;
    select x into r from jsonb_array_elements(app.bin_rooms(v_org)) x where upper(x->>'room') = m[1];
    if r is null then raise exception 'VALIDATION: 没有「%」这个房间', m[1]; end if;
    if coalesce(r->>'shelves', '') <> '' and (m[2] is null or position(m[2] in upper(r->>'shelves')) = 0) then raise exception 'VALIDATION: % 没有货架「%」', m[1], coalesce(m[2], ''); end if;
    select e.short_name into v_who from app.count_tasks t join app.employees e on e.id = t.employee_id where t.count_id = p_count and s = any(t.shelves) limit 1;
    if v_who is not null then raise exception 'VALIDATION: 货架 % 已经派给 % 了（一个货架只派一个人）', s, v_who; end if;
  end loop;
  if p_category is not null and not exists (select 1 from app.categories where id = p_category and org_id = v_org) then raise exception 'VALIDATION: 种类不对'; end if;
  insert into app.count_tasks (count_id, employee_id, scope, shelves, category_id)
  values (p_count, p_emp, array_to_string(v_sh, '、'), v_sh, p_category) returning id into v;
  return v;
end $$;

-- 金蝶那边录完了（财务点）
create or replace function app.count_kd_done(p_count uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'closed';
  if v_org is null then raise exception 'NOT_FOUND: 盘点还没确认'; end if;
  perform app.require_role(v_org, 'admin', 'finance');
  update app.counts set kd_done_at = now(), kd_done_by = app.uid() where id = p_count;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.count_task_set2(uuid, uuid, text[], uuid), app.count_kd_done(uuid) to authenticated;
  end if;
end $$;
