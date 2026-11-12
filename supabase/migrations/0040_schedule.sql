-- 0040 (Frank 11-11 夜, 待改 243 / 226): 作息与排班
-- 上班 9:00–17:30, 全员午休 1 小时 (不打卡, 算时长自动扣); 每周 5 天半: 周六上午; 排班可以按人设 (主管周五上午、周六全天; 热线周六休)
update app.attendance_settings set start_time = '09:00', end_time = '17:30';
alter table app.attendance_settings alter column start_time set default '09:00', alter column end_time set default '17:30';
alter table app.attendance_settings add column lunch_min int not null default 60, add column half_day_end time not null default '12:00';
-- 每人每周的排班: {"1":"full",…,"6":"am","0":"off"} (0 = 周日); null = 用公司默认 (周一到周五全天、周六上午、周日休)
alter table app.employees add column work_schedule jsonb;
create or replace function app.set_work_schedule(p_emp uuid, p_schedule jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; k text;
begin
  select org_id into v_org from app.employees where id = p_emp;
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'admin');
  if p_schedule is not null then
    for k in select jsonb_object_keys(p_schedule) loop
      if k not in ('0','1','2','3','4','5','6') or p_schedule->>k not in ('full','am','off') then raise exception 'VALIDATION: 排班格式不对'; end if;
    end loop;
  end if;
  update app.employees set work_schedule = p_schedule where id = p_emp;
  perform app.audit(v_org, 'set_work_schedule', 'employees', p_emp, coalesce(p_schedule, '{}'::jsonb));
end $$;
revoke all on function app.set_work_schedule(uuid, jsonb) from public;
grant execute on function app.set_work_schedule(uuid, jsonb) to authenticated;
