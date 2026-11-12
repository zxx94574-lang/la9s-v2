-- 0041 (Frank 11-05 定稿 / 11-11 催: 待改 227 ②): 中方指令 —— 中方给员工下达任务 / 待办
-- 下达 → 员工点「收到」→ 做完点「完成」并填结果 (文字或照片) → 中方确认才关闭; 全程留记录; 不做延期申请
-- 定期任务: 每天 / 每周 / 每月自动生成一条 (可要求拍照)
create table app.directives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  title text not null check (length(trim(title)) > 0),
  body text,
  urgent boolean not null default false,
  require_photo boolean not null default false,
  assignee_employee_id uuid not null references app.employees(id),
  due_on date,
  repeat text check (repeat in ('daily','weekly','monthly')),      -- 只有模板行有
  is_template boolean not null default false, active boolean not null default true,
  parent_id uuid references app.directives(id), period_key text,
  status text not null default 'sent' check (status in ('sent','acked','done','closed')),
  ack_at timestamptz, done_at timestamptz, done_note text, done_photo text,
  confirmed_at timestamptz, confirmed_by uuid, confirm_note text, reject_count int not null default 0,
  created_by uuid, created_at timestamptz not null default now(),
  unique (parent_id, period_key)
);
create index on app.directives (org_id, status);
alter table app.directives enable row level security;
create policy dir_read on app.directives for select using (app.is_member(org_id));

create or replace function app.issue_directive(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_allow boolean;
begin
  v_allow := coalesce((select (value->>'manager_can_issue')::boolean from app.org_settings where org_id = p_org and key = 'directive_rules'), false);
  if v_allow then perform app.require_role(p_org, 'manager'); else perform app.require_role(p_org, 'admin'); end if;
  if coalesce(trim(p->>'title'), '') = '' then raise exception 'VALIDATION: 写清楚要做什么'; end if;
  if nullif(p->>'assignee', '') is null or not exists (select 1 from app.employees where id = (p->>'assignee')::uuid and org_id = p_org) then raise exception 'VALIDATION: 选给谁'; end if;
  if nullif(p->>'repeat', '') is not null and p->>'repeat' not in ('daily','weekly','monthly') then raise exception 'VALIDATION: 重复方式不对'; end if;
  insert into app.directives (org_id, title, body, urgent, require_photo, assignee_employee_id, due_on, repeat, is_template, created_by)
  values (p_org, trim(p->>'title'), nullif(trim(coalesce(p->>'body', '')), ''), coalesce((p->>'urgent')::boolean, false), coalesce((p->>'require_photo')::boolean, false),
    (p->>'assignee')::uuid, nullif(p->>'due_on', '')::date, nullif(p->>'repeat', ''), nullif(p->>'repeat', '') is not null, app.uid())
  returning id into v_id;
  perform app.audit(p_org, 'issue_directive', 'directives', v_id, p);
  return v_id;
end $$;

-- 定期任务: 按模板生成今天 / 这周 / 这个月的那一条 (已经有就不重复生成); 打开待办时调用
create or replace function app.spawn_directives(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare t app.directives; k text; n int := 0;
begin
  if not app.is_member(p_org) then raise exception 'FORBIDDEN'; end if;
  for t in select * from app.directives where org_id = p_org and is_template and active loop
    k := case t.repeat when 'daily' then to_char(current_date, 'YYYY-MM-DD') when 'weekly' then to_char(current_date, 'IYYY-"W"IW') else to_char(current_date, 'YYYY-MM') end;
    if t.repeat = 'daily' and extract(dow from current_date) = 0 then continue; end if;      -- 周日不生成每日任务
    insert into app.directives (org_id, title, body, urgent, require_photo, assignee_employee_id, due_on, parent_id, period_key, created_by)
    values (p_org, t.title, t.body, t.urgent, t.require_photo, t.assignee_employee_id, current_date, t.id, k, t.created_by)
    on conflict (parent_id, period_key) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function app.directive_mine(p_id uuid) returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.directives d join app.members m on m.org_id = d.org_id and m.employee_id = d.assignee_employee_id where d.id = p_id and m.user_id = app.uid())
$$;
create or replace function app.ack_directive(p_id uuid) returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.directive_mine(p_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的'; end if;
  update app.directives set status = 'acked', ack_at = coalesce(ack_at, now()) where id = p_id and status = 'sent';
end $$;
create or replace function app.complete_directive(p_id uuid, p_note text, p_photo text) returns void language plpgsql security definer set search_path = app, public as $$
declare d app.directives;
begin
  select * into d from app.directives where id = p_id for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.directive_mine(p_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的，必须本人点完成'; end if;
  if d.status not in ('sent', 'acked') then raise exception 'BAD_STATE: 这条已经交过了'; end if;
  if coalesce(trim(p_note), '') = '' and coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 要填结果（文字或照片）'; end if;
  if d.require_photo and coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 这条要求拍照'; end if;
  update app.directives set status = 'done', ack_at = coalesce(ack_at, now()), done_at = now(), done_note = nullif(trim(coalesce(p_note, '')), ''), done_photo = nullif(p_photo, '') where id = p_id;
end $$;
-- 中方确认: 通过 → 关闭; 不通过 → 退回去重做 (写原因)
create or replace function app.confirm_directive(p_id uuid, p_ok boolean, p_note text default null) returns void language plpgsql security definer set search_path = app, public as $$
declare d app.directives;
begin
  select * into d from app.directives where id = p_id for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'admin');
  if d.status <> 'done' then raise exception 'BAD_STATE: 员工还没点完成'; end if;
  if p_ok then update app.directives set status = 'closed', confirmed_at = now(), confirmed_by = app.uid(), confirm_note = nullif(trim(coalesce(p_note, '')), '') where id = p_id;
  else
    if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 退回要写哪里不行'; end if;
    update app.directives set status = 'acked', done_at = null, confirm_note = trim(p_note), reject_count = reject_count + 1 where id = p_id;
  end if;
end $$;
create or replace function app.stop_directive(p_id uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.directives where id = p_id;
  perform app.require_role(v_org, 'admin');
  update app.directives set active = false, status = case when is_template then status else 'closed' end, confirm_note = coalesce(confirm_note, '中方撤销') where id = p_id;
end $$;

revoke all on function app.issue_directive(uuid, jsonb), app.spawn_directives(uuid), app.directive_mine(uuid), app.ack_directive(uuid), app.complete_directive(uuid, text, text), app.confirm_directive(uuid, boolean, text), app.stop_directive(uuid) from public;
grant execute on function app.issue_directive(uuid, jsonb), app.spawn_directives(uuid), app.directive_mine(uuid), app.ack_directive(uuid), app.complete_directive(uuid, text, text), app.confirm_directive(uuid, boolean, text), app.stop_directive(uuid) to authenticated;
grant select on app.directives to authenticated;
