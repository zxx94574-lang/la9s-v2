-- 0060 工号 = 登录账号 (Frank 11-18 第 13 点)
--  · 员工档案里只要有工号, 就自动有一个账号位置 (登录名 = 工号), **默认锁住**
--  · 密码由中方在员工档案里手动输入 (只能设 / 重设, 存的是加密后的, 谁也看不到原文)
--  · 设了密码才能解锁; 员工离职 (停用) 自动锁住; 工号改了登录名跟着改
--  · staff_login(工号, 密码): 给登录页用. 真正切到「工号登录」是上线前那一步 (待改 320), 这里先把账号、密码、锁都备好.
create table app.staff_accounts (
  employee_id uuid primary key references app.employees(id) on delete cascade,
  org_id uuid not null references app.orgs(id),
  login text not null,
  pass_hash text,
  locked boolean not null default true,
  pass_set_at timestamptz, pass_set_by uuid,
  last_login_at timestamptz, fail_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, login)
);
alter table app.staff_accounts enable row level security;
-- 只中方能读, 而且读不到密码 (下面的视图不含 pass_hash; 表本身不给客户端)
create or replace view app.v_staff_accounts as
  select a.employee_id, a.org_id, a.login, a.locked, (a.pass_hash is not null) as has_password, a.pass_set_at, a.last_login_at
  from app.staff_accounts a where app.has_role(a.org_id, array['admin']::app.role_name[]);

create or replace function app.trg_staff_account() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.emp_no is null or trim(new.emp_no) = '' then
    if tg_op = 'UPDATE' then delete from app.staff_accounts where employee_id = new.id and pass_hash is null; end if;
    return new;
  end if;
  insert into app.staff_accounts (employee_id, org_id, login) values (new.id, new.org_id, upper(trim(new.emp_no)))
  on conflict (employee_id) do update set login = excluded.login;
  if not new.active then update app.staff_accounts set locked = true where employee_id = new.id; end if;
  return new;
end $$;
create trigger staff_account after insert or update of emp_no, active on app.employees for each row execute function app.trg_staff_account();

-- 已有工号的员工补上账号位置 (都锁着)
insert into app.staff_accounts (employee_id, org_id, login)
select e.id, e.org_id, upper(trim(e.emp_no)) from app.employees e where coalesce(trim(e.emp_no), '') <> '' on conflict do nothing;

create or replace function app.set_staff_password(p_employee uuid, p_password text)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.staff_accounts;
begin
  select * into a from app.staff_accounts where employee_id = p_employee;
  if a.employee_id is null then raise exception 'NOT_FOUND: 这个员工还没有工号，先在档案里填工号'; end if;
  perform app.require_role(a.org_id, 'admin');
  if length(coalesce(p_password, '')) < 6 then raise exception 'VALIDATION: 密码至少 6 位'; end if;
  update app.staff_accounts set pass_hash = crypt(p_password, gen_salt('bf')), pass_set_at = now(), pass_set_by = app.uid(), fail_count = 0 where employee_id = p_employee;
  perform app.audit(a.org_id, 'set_staff_password', 'staff_accounts', p_employee, jsonb_build_object('login', a.login));
end $$;

create or replace function app.set_staff_lock(p_employee uuid, p_locked boolean)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.staff_accounts; e app.employees;
begin
  select * into a from app.staff_accounts where employee_id = p_employee;
  if a.employee_id is null then raise exception 'NOT_FOUND: 这个员工还没有工号'; end if;
  perform app.require_role(a.org_id, 'admin');
  select * into e from app.employees where id = p_employee;
  if not coalesce(p_locked, true) then
    if a.pass_hash is null then raise exception 'VALIDATION: 先设密码，才能解锁'; end if;
    if not e.active then raise exception 'VALIDATION: 这个员工已经停用（离职），账号不能解锁'; end if;
  end if;
  update app.staff_accounts set locked = coalesce(p_locked, true), fail_count = 0 where employee_id = p_employee;
  perform app.audit(a.org_id, case when coalesce(p_locked, true) then 'lock_staff_account' else 'unlock_staff_account' end, 'staff_accounts', p_employee, jsonb_build_object('login', a.login));
end $$;

-- 登录: 工号 + 密码. 锁住 / 没设密码 / 密码不对 → 同一句话 (不告诉对方是哪一种). 连错 10 次自动锁.
create or replace function app.staff_login(p_org uuid, p_login text, p_password text)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare a app.staff_accounts; e app.employees;
begin
  select * into a from app.staff_accounts where org_id = p_org and login = upper(trim(coalesce(p_login, '')));
  if a.employee_id is null or a.pass_hash is null or a.locked then raise exception 'VALIDATION: 工号或密码不对，或者账号还没开通'; end if;
  if a.pass_hash <> crypt(coalesce(p_password, ''), a.pass_hash) then
    update app.staff_accounts set fail_count = fail_count + 1, locked = (fail_count + 1 >= 10) where employee_id = a.employee_id;
    raise exception 'VALIDATION: 工号或密码不对，或者账号还没开通';
  end if;
  update app.staff_accounts set last_login_at = now(), fail_count = 0 where employee_id = a.employee_id;
  select * into e from app.employees where id = a.employee_id;
  return jsonb_build_object('employee_id', e.id, 'emp_no', e.emp_no, 'name', coalesce(e.short_name, e.full_name),
    'user_id', (select m.user_id from app.members m where m.employee_id = e.id and m.org_id = p_org limit 1));
end $$;

do $$ begin
  revoke all on app.staff_accounts from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on app.staff_accounts from authenticated;
    grant select on app.v_staff_accounts to authenticated;
    grant execute on function app.set_staff_password(uuid, text), app.set_staff_lock(uuid, boolean) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on app.staff_accounts from anon;
    grant execute on function app.staff_login(uuid, text, text) to anon;
  end if;
end $$;
