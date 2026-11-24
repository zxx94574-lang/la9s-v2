-- 待改 501 (Frank 11-23 定): 请假 (全天 / 半天 / 按小时, 员工自填不审批) + 迟到报备 (每月前 N 次不扣)
-- 出勤: 请的那部分不算出勤 (全天 0, 半天 0.5, 按小时 ÷ 8); 请了假当天没打卡不算异常.
-- 迟到: 报备过的标黄, 每月前 N 次 (late_rules.free, 默认 2) 不扣; 没报备 / 超过次数的迟到扣当天 (late_rules.deduct, 默认开).

create table app.leaves (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  employee_id uuid not null references app.employees(id),
  user_id uuid,
  day date not null,
  kind text not null check (kind in ('full', 'am', 'pm', 'hours')),
  from_time time, to_time time,
  hours numeric(4,1),
  reason text,
  created_at timestamptz not null default now(),
  unique (employee_id, day)
);
create table app.late_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  employee_id uuid not null references app.employees(id),
  user_id uuid,
  day date not null,
  reason text not null,
  proof text,
  created_at timestamptz not null default now(),
  unique (employee_id, day)
);
alter table app.leaves enable row level security; alter table app.late_reports enable row level security;
create policy read_own on app.leaves for select using (app.is_member(org_id));
create policy read_own on app.late_reports for select using (app.is_member(org_id));

-- 这一天请掉了多少 (0–1)
create or replace function app.leave_frac(p_kind text, p_hours numeric) returns numeric language sql immutable as $$
  select case p_kind when 'full' then 1 when 'am' then 0.5 when 'pm' then 0.5 else least(1, greatest(0, coalesce(p_hours, 0) / 8.0)) end
$$;

-- p: {from, to?, kind, from_time?, to_time?, reason?}; 一段日子一次填, 周日 / 排班休息的日子跳过
create or replace function app.take_leave(p_org uuid, p jsonb) returns int language plpgsql security definer set search_path = app, public as $$
declare v_emp uuid; v_from date := (p->>'from')::date; v_to date := coalesce(nullif(p->>'to', '')::date, (p->>'from')::date);
  v_kind text := coalesce(p->>'kind', 'full'); v_ft time := nullif(p->>'from_time', '')::time; v_tt time := nullif(p->>'to_time', '')::time;
  v_h numeric; d date; n int := 0; ws jsonb;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  select m.employee_id, coalesce(e.work_schedule, '{}'::jsonb) into v_emp, ws from app.members m join app.employees e on e.id = m.employee_id where m.user_id = app.uid() and m.org_id = p_org;
  if v_emp is null then raise exception 'VALIDATION: 这个账号没挂员工档案'; end if;
  if v_from is null or v_to < v_from or v_to - v_from > 60 then raise exception 'VALIDATION: 日期不对'; end if;
  if v_kind not in ('full', 'am', 'pm', 'hours') then raise exception 'VALIDATION: 选请多久'; end if;
  if v_kind = 'hours' then
    if v_ft is null or v_tt is null or v_tt <= v_ft then raise exception 'VALIDATION: 按小时请假要填几点到几点'; end if;
    v_h := round((extract(epoch from (v_tt - v_ft)) / 3600.0)::numeric, 1);
    v_to := v_from;
  end if;
  for d in select g::date from generate_series(v_from, v_to, interval '1 day') g loop
    if coalesce(ws->>(extract(dow from d)::int)::text, case when extract(dow from d) = 0 then 'off' else 'full' end) = 'off' then continue; end if;
    insert into app.leaves (org_id, employee_id, user_id, day, kind, from_time, to_time, hours, reason)
    values (p_org, v_emp, app.uid(), d, v_kind, v_ft, v_tt, v_h, nullif(trim(coalesce(p->>'reason', '')), ''))
    on conflict (employee_id, day) do update set kind = excluded.kind, from_time = excluded.from_time, to_time = excluded.to_time, hours = excluded.hours, reason = excluded.reason;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'VALIDATION: 选的日子都是休息日'; end if;
  perform app.audit(p_org, 'take_leave', 'leaves', v_emp, p);
  return n;
end $$;

-- 撤掉自己的请假 (只能撤今天和以后的; 中方可以撤任何一条)
create or replace function app.cancel_leave(p_id uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare l app.leaves;
begin
  select * into l from app.leaves where id = p_id;
  if l.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.has_role(l.org_id, array['admin']::app.role_name[]) then
    if l.user_id is distinct from app.uid() then raise exception 'PERMISSION_DENIED'; end if;
    if l.day < (now() at time zone 'Africa/Abidjan')::date then raise exception 'BAD_STATE: 已经过去的请假不能自己撤，找中方'; end if;
  end if;
  delete from app.leaves where id = p_id;
  perform app.audit(l.org_id, 'cancel_leave', 'leaves', l.employee_id, jsonb_build_object('day', l.day, 'kind', l.kind));
end $$;

-- 迟到报备: 只能报今天的
create or replace function app.report_late(p_org uuid, p_reason text, p_proof text) returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_emp uuid; v_id uuid; v_day date := (now() at time zone 'Africa/Abidjan')::date;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 要写原因'; end if;
  select employee_id into v_emp from app.members where user_id = app.uid() and org_id = p_org;
  if v_emp is null then raise exception 'VALIDATION: 这个账号没挂员工档案'; end if;
  insert into app.late_reports (org_id, employee_id, user_id, day, reason, proof) values (p_org, v_emp, app.uid(), v_day, trim(p_reason), nullif(p_proof, ''))
  on conflict (employee_id, day) do update set reason = excluded.reason, proof = coalesce(excluded.proof, app.late_reports.proof)
  returning id into v_id;
  return v_id;
end $$;

-- 一个员工一个月里每天的出勤 (0–1): 给工资和月汇总用
create or replace function app.attendance_days(p_org uuid, p_emp uuid, p_month date)
returns table (day date, punched boolean, late boolean, reported boolean, excused boolean, leave_frac numeric, worked numeric)
language sql stable security definer set search_path = app, public as $$
  with st as (select * from app.attendance_settings where org_id = p_org),
  rule as (select coalesce((select (value->>'free')::int from app.org_settings where org_id = p_org and key = 'late_rules'), 2) as free,
                  coalesce((select (value->>'deduct')::boolean from app.org_settings where org_id = p_org and key = 'late_rules'), true) as deduct),
  m as (select date_trunc('month', p_month)::date as a, (date_trunc('month', p_month) + interval '1 month')::date as b),
  ins as (
    select (a.at at time zone 'Africa/Abidjan')::date as d, bool_or(coalesce(a.late, false)) as late,
      bool_or((a.at at time zone 'Africa/Abidjan')::time > st.start_time + make_interval(mins => st.late_absent_min)) as too_late
    from app.attendance a, st, m
    where a.org_id = p_org and a.employee_id = p_emp and a.kind = 'in'
      and (a.at at time zone 'Africa/Abidjan')::date >= m.a and (a.at at time zone 'Africa/Abidjan')::date < m.b
    group by 1),
  ok as (select ap.day as d from app.attendance_appeals ap, m where ap.org_id = p_org and ap.employee_id = p_emp and ap.status = 'approved' and ap.day >= m.a and ap.day < m.b),
  lv as (select l.day as d, app.leave_frac(l.kind, l.hours) as f from app.leaves l, m where l.employee_id = p_emp and l.day >= m.a and l.day < m.b),
  rep as (select r.day as d from app.late_reports r, m where r.employee_id = p_emp and r.day >= m.a and r.day < m.b),
  days as (select d from ins union select d from ok union select d from lv),
  x as (
    select days.d, (ins.d is not null) as punched, coalesce(ins.late, false) as late, coalesce(ins.too_late, false) as too_late,
      (rep.d is not null) as reported, (ok.d is not null) as appealed, coalesce(lv.f, 0) as f
    from days left join ins on ins.d = days.d left join ok on ok.d = days.d left join lv on lv.d = days.d left join rep on rep.d = days.d),
  y as (select x.*, case when x.late and x.reported and not x.appealed then row_number() over (partition by (x.late and x.reported and not x.appealed) order by x.d) end as rep_n from x)
  select y.d, y.punched, y.late, y.reported,
    (y.late and y.reported and y.rep_n <= rule.free) as excused, y.f,
    case
      when y.appealed then greatest(0, 1 - y.f)
      when not y.punched then 0
      when y.too_late then 0
      when y.late and rule.deduct and not (y.reported and y.rep_n <= rule.free) and y.f = 0 then 0
      else greatest(0, 1 - y.f) end
  from y, rule
$$;

create or replace function app.worked_days(p_org uuid, p_emp uuid, p_month date)
returns numeric language sql stable security definer set search_path = app, public as $$
  select coalesce(sum(worked), 0)::numeric from app.attendance_days(p_org, p_emp, p_month)
$$;

-- 异常: 请了假的那天没打卡不算; 报备过的迟到单独数
drop function if exists app.attendance_anomalies(uuid, date, date);
create function app.attendance_anomalies(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, short_name text, emp_no text, late int, missing int, late_reported int, leave_days numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare v_today date := (now() at time zone 'Africa/Abidjan')::date;
begin
  perform app.require_role(p_org, 'admin', 'manager', 'sales_manager', 'finance');
  return query
  with emp as (
    select e.id, coalesce(e.short_name, e.full_name) as nm, e.emp_no, e.joined_on, coalesce(e.work_schedule, '{}'::jsonb) as ws
    from app.employees e where e.org_id = p_org and e.active and coalesce(e.emp_no, '') <> ''),
  days as (
    select e.id, g::date as day from emp e, generate_series(greatest(p_from, coalesce(e.joined_on, p_from)), least(p_to, v_today), interval '1 day') g
    where coalesce(e.ws->>(extract(dow from g)::int)::text, case when extract(dow from g) = 0 then 'off' else 'full' end) <> 'off'),
  ins as (
    select a.employee_id, (a.at at time zone 'Africa/Abidjan')::date as day, bool_or(coalesce(a.late, false)) as late
    from app.attendance a where a.org_id = p_org and a.kind = 'in' and a.at >= p_from and a.at < p_to + 2 group by 1, 2),
  ok as (select ap.employee_id, ap.day from app.attendance_appeals ap where ap.org_id = p_org and ap.status = 'approved'),
  lv as (select l.employee_id, l.day, app.leave_frac(l.kind, l.hours) as f from app.leaves l where l.org_id = p_org),
  rep as (select r.employee_id, r.day from app.late_reports r where r.org_id = p_org)
  select e.id, e.nm, e.emp_no,
    count(*) filter (where i.late and o.day is null and r.day is null)::int,
    count(*) filter (where i.day is null and o.day is null and l.day is null and d.day < v_today)::int,
    count(*) filter (where i.late and o.day is null and r.day is not null)::int,
    coalesce(sum(l.f), 0)::numeric
  from emp e join days d on d.id = e.id
  left join ins i on i.employee_id = e.id and i.day = d.day
  left join ok o on o.employee_id = e.id and o.day = d.day
  left join lv l on l.employee_id = e.id and l.day = d.day
  left join rep r on r.employee_id = e.id and r.day = d.day
  group by 1, 2, 3;
end $$;

revoke all on function app.attendance_anomalies(uuid, date, date) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.leaves, app.late_reports to authenticated;
    grant execute on function app.take_leave(uuid, jsonb), app.cancel_leave(uuid), app.report_late(uuid, text, text), app.attendance_days(uuid, uuid, date), app.attendance_anomalies(uuid, date, date) to authenticated;
  end if;
end $$;
