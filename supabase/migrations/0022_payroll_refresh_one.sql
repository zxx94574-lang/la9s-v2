-- 0022 (11-07 16:49 Frank): 「按打卡重算」不要太机械 —— 可以只算选中的人 / 某一个人
create or replace function app.payroll_refresh_auto(p_org uuid, p_month date, p_emps uuid[] default null)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months; r record; n int := 0; v_auto numeric;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status is distinct from 'draft' then raise exception 'BAD_STATE: 只有草稿能重算'; end if;
  if not app.month_has_attendance(p_org, m) then raise exception 'VALIDATION: 这个月还没有打卡记录'; end if;
  for r in select * from app.payroll where org_id = p_org and month = m and (p_emps is null or employee_id = any(p_emps)) loop
    v_auto := app.worked_days(p_org, r.employee_id, m);
    -- 指定了人 = 他明确要按打卡来, 覆盖手改; 全表重算才保留手改
    update app.payroll set days_auto = v_auto, days_worked = case when p_emps is not null or r.days_worked is null or r.days_worked = r.days_auto then v_auto else days_worked end
    where org_id = p_org and month = m and employee_id = r.employee_id;
    n := n + 1;
  end loop;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;
drop function if exists app.payroll_refresh_auto(uuid, date);
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.payroll_refresh_auto(uuid, date, uuid[]) to authenticated;
  end if;
end $$;
