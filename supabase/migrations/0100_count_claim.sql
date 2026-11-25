-- 0100 盘点：员工只能盘派给自己的货架 / 种类；盘完可以自己再领一批；主管随时可以派（Frank 11-25 12:57）
-- 1) 派任务的校验抽成内部函数，中方 / 主管派（count_task_set2）和员工自己领（count_task_claim）共用
create or replace function app.count_task_make(p_count uuid, p_emp uuid, p_shelves text[], p_category uuid) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v uuid; s text; m text[]; r jsonb; v_who text; v_sh text[];
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  if p_emp is null or not exists (select 1 from app.employees where id = p_emp and org_id = v_org) then raise exception 'VALIDATION: 选谁来盘'; end if;
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

create or replace function app.count_task_set2(p_count uuid, p_emp uuid, p_shelves text[], p_category uuid) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  perform app.require_role(v_org, 'admin', 'manager');
  return app.count_task_make(p_count, p_emp, p_shelves, p_category);
end $$;

-- 2) 员工自己再领一批：手上的报盘完了才能领（避免一个人占一堆货架没人盘）
create or replace function app.count_task_claim(p_count uuid, p_shelves text[], p_category uuid) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_emp uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  if not app.is_member(v_org) then raise exception 'PERMISSION_DENIED'; end if;
  v_emp := app.current_employee(v_org);
  if v_emp is null then raise exception 'VALIDATION: 你的账号没绑员工档案，找中方派'; end if;
  if exists (select 1 from app.count_tasks where count_id = p_count and employee_id = v_emp and status = 'todo') then
    raise exception 'VALIDATION: 先把手上这批报「我盘完了」，再领下一批'; end if;
  return app.count_task_make(p_count, v_emp, p_shelves, p_category);
end $$;

-- 3) 录数：中方 / 主管哪里都能录；其他人只能录在派给自己的货架、派的种类里
create or replace function app.count_add(p_count uuid, p_bin text, p_product uuid, p_qty int, p_note text) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_bin uuid; v_emp uuid; v_task uuid; v uuid; v_cat uuid; v_code text;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  if not app.is_member(v_org) then raise exception 'PERMISSION_DENIED'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'VALIDATION: 数量不能是负数'; end if;
  select category_id into v_cat from app.products where id = p_product and org_id = v_org;
  if not found then raise exception 'VALIDATION: 型号不对'; end if;
  v_code := upper(trim(coalesce(p_bin, '')));
  v_emp := app.current_employee(v_org);
  select t.id into v_task from app.count_tasks t
    where t.count_id = p_count and t.employee_id = v_emp
      and exists (select 1 from unnest(t.shelves) s where v_code = s or v_code like s || '-%')
      and (t.category_id is null or t.category_id = v_cat)
    order by (t.status = 'todo') desc, t.created_at limit 1;
  if v_task is null and not app.has_role(v_org, array['admin', 'manager']::app.role_name[]) then
    if not exists (select 1 from app.count_tasks where count_id = p_count and employee_id = v_emp) then
      raise exception 'VALIDATION: 还没给你派货架，先领一批（或找主管派）'; end if;
    if not exists (select 1 from app.count_tasks t where t.count_id = p_count and t.employee_id = v_emp and exists (select 1 from unnest(t.shelves) s where v_code = s or v_code like s || '-%')) then
      raise exception 'VALIDATION: % 不在你的任务里，只能盘派给你的货架', v_code; end if;
    raise exception 'VALIDATION: 这个种类不在你的任务里（只盘派给你的种类）';
  end if;
  if v_task is null then select id into v_task from app.count_tasks where count_id = p_count and employee_id = v_emp and status = 'todo' order by created_at limit 1; end if;
  v_bin := app.bin_upsert(v_org, p_bin);
  select id into v from app.count_lines where count_id = p_count and bin_id = v_bin and product_id = p_product and by_user is not distinct from app.uid();
  if v is not null then update app.count_lines set qty = p_qty, note = nullif(trim(coalesce(p_note, '')), ''), at = now() where id = v;
  else insert into app.count_lines (count_id, task_id, bin_id, product_id, qty, note, by_employee, by_user) values (p_count, v_task, v_bin, p_product, p_qty, nullif(trim(coalesce(p_note, '')), ''), v_emp, app.uid()) returning id into v;
  end if;
  return v;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.count_task_claim(uuid, text[], uuid) to authenticated;
    revoke execute on function app.count_task_make(uuid, uuid, text[], uuid) from public;
  end if;
end $$;
