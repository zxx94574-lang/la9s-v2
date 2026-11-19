-- 0072: 打卡只留一个按键 (450, Frank 11-19 22:22 / 22:28 / 22:29)
-- 规则按「今天的状态」走, 不按钟点: 没打过 → 这一下是上班卡; 打过上班卡 → 这一下是下班卡; 都打过 → 不能再打.
-- 没打上班卡不能打下班卡. 提前下班不拦, 但必须写原因, 记「早退」, 算一次异常.
alter table app.attendance add column early boolean not null default false, add column early_note text;

create or replace function app.punch_state(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare v_today date := (now() at time zone 'Africa/Abidjan')::date; v_in timestamptz; v_out timestamptz; st app.attendance_settings;
  v_emp uuid; ws jsonb; v_dow text; v_mode text; v_end time;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  select min(at) filter (where kind = 'in'), max(at) filter (where kind = 'out') into v_in, v_out
  from app.attendance where org_id = p_org and user_id = app.uid() and (at at time zone 'Africa/Abidjan')::date = v_today;
  select * into st from app.attendance_settings where org_id = p_org;
  select employee_id into v_emp from app.members where user_id = app.uid() and org_id = p_org;
  select coalesce(work_schedule, '{}'::jsonb) into ws from app.employees where id = v_emp;
  v_dow := extract(dow from v_today)::int::text;
  v_mode := coalesce(ws->>v_dow, case v_dow when '0' then 'off' when '6' then 'am' else 'full' end);
  v_end := case v_mode when 'off' then null when 'am' then coalesce(st.half_day_end, '12:00') else coalesce(st.end_time, '17:30') end;
  return jsonb_build_object('next', case when v_in is null then 'in' when v_out is null then 'out' else 'done' end,
    'in_at', v_in, 'out_at', v_out, 'end_time', v_end,
    'early', v_in is not null and v_out is null and v_end is not null and (now() at time zone 'Africa/Abidjan')::time < v_end);
end $$;

create or replace function app.punch(p_org uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_note text default null)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare s jsonb; r jsonb; v_kind text; v_early boolean;
begin
  s := app.punch_state(p_org);
  v_kind := s->>'next';
  if v_kind = 'done' then raise exception 'VALIDATION: 今天上班、下班都打过卡了'; end if;
  v_early := v_kind = 'out' and (s->>'early')::boolean;
  if v_early and coalesce(trim(p_note), '') = '' then
    raise exception 'EARLY_NOTE: 还没到下班时间（%），提前下班要写原因', left(s->>'end_time', 5);
  end if;
  r := app.clock(p_org, v_kind, p_lat, p_lng, p_accuracy, case when v_early then null else p_note end);
  if v_early then
    update app.attendance set early = true, early_note = trim(p_note)
    where id = (select id from app.attendance where org_id = p_org and user_id = app.uid() and kind = 'out' order by at desc limit 1);
  end if;
  return r || jsonb_build_object('kind', v_kind, 'early', v_early);
end $$;

-- 打卡异常加「早退」
drop function app.attendance_anomalies(uuid, date, date);
create function app.attendance_anomalies(p_org uuid, p_from date, p_to date)
returns table (employee_id uuid, short_name text, emp_no text, late int, missing int, early int)
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
  outs as (
    select a.employee_id, (a.at at time zone 'Africa/Abidjan')::date as day
    from app.attendance a where a.org_id = p_org and a.kind = 'out' and a.early and a.at >= p_from and a.at < p_to + 2 group by 1, 2),
  ok as (select ap.employee_id, ap.day from app.attendance_appeals ap where ap.org_id = p_org and ap.status = 'approved')
  select e.id, e.nm, e.emp_no,
    count(*) filter (where i.late and o.day is null)::int,
    count(*) filter (where i.day is null and o.day is null and d.day < v_today)::int,
    count(*) filter (where x.day is not null and o.day is null)::int
  from emp e join days d on d.id = e.id
  left join ins i on i.employee_id = e.id and i.day = d.day
  left join outs x on x.employee_id = e.id and x.day = d.day
  left join ok o on o.employee_id = e.id and o.day = d.day
  group by 1, 2, 3;
end $$;

revoke all on function app.punch_state(uuid), app.punch(uuid, double precision, double precision, double precision, text), app.attendance_anomalies(uuid, date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.punch_state(uuid), app.punch(uuid, double precision, double precision, double precision, text), app.attendance_anomalies(uuid, date, date) to authenticated;
  end if;
end $$;
