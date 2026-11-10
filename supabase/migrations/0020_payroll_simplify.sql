-- 0020 (11-07 15:35 Frank): 工资页重做
-- · 审批流去掉: 草稿 → 「确认发放」一步 (只中方), 确认后锁定不再改
-- · 罗兰 (sales_manager) 可以起草、改行、按打卡重算; 确认发放只有中方 (admin)
-- · 社保公司承担: 默认已在 0018 设为不进实发, 这里不再提供开关

create or replace function app.payroll_set_line(p_org uuid, p_month date, p_emp uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
  num constant text[] := array['contract_salary','days_worked','allowance','incentive','prime_team','cnps','deduction'];
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');   -- 0020: 罗兰 (销售主管 / 国家经理) 可以起草和初审
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status is distinct from 'draft' then raise exception 'BAD_STATE: 这个月已经批准 / 发放，先撤回批准才能改'; end if;
  if (p_data ? 'days_worked') and ((p_data->>'days_worked')::numeric < 0 or (p_data->>'days_worked')::numeric > 31) then raise exception 'VALIDATION: 出勤天数 0–31'; end if;
  update app.payroll set
    contract_salary = case when p_data ? 'contract_salary' then coalesce(nullif(p_data->>'contract_salary','')::numeric, 0) else contract_salary end,
    days_worked     = case when p_data ? 'days_worked' then coalesce(nullif(p_data->>'days_worked','')::numeric, 0) else days_worked end,
    allowance       = case when p_data ? 'allowance' then coalesce(nullif(p_data->>'allowance','')::numeric, 0) else allowance end,
    incentive       = case when p_data ? 'incentive' then coalesce(nullif(p_data->>'incentive','')::numeric, 0) else incentive end,
    prime_team      = case when p_data ? 'prime_team' then coalesce(nullif(p_data->>'prime_team','')::numeric, 0) else prime_team end,
    cnps            = case when p_data ? 'cnps' then coalesce(nullif(p_data->>'cnps','')::numeric, 0) else cnps end,
    deduction       = case when p_data ? 'deduction' then coalesce(nullif(p_data->>'deduction','')::numeric, 0) else deduction end,
    note            = case when p_data ? 'note' then nullif(p_data->>'note','') else note end,
    snap_position   = case when p_data ? 'snap_position' then nullif(p_data->>'snap_position','') else snap_position end
  where org_id = p_org and month = m and employee_id = p_emp;
  if not found then raise exception 'NOT_FOUND: 这个月没有这个人'; end if;
  perform app.payroll_recalc(p_org, m, p_emp);
end $$;

create or replace function app.payroll_drop_line(p_org uuid, p_month date, p_emp uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');   -- 0020: 罗兰 (销售主管 / 国家经理) 可以起草和初审
  if (select status from app.payroll_months where org_id = p_org and month = m) <> 'draft' then raise exception 'BAD_STATE: 已批准的记录不能删'; end if;
  delete from app.payroll where org_id = p_org and month = m and employee_id = p_emp;
end $$;

create or replace function app.payroll_set_header(p_org uuid, p_month date, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');   -- 0020: 罗兰 (销售主管 / 国家经理) 可以起草和初审
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.month is null then raise exception 'NOT_FOUND: 先打开这个月'; end if;
  if h.status = 'paid' then raise exception 'BAD_STATE: 已发放的月份锁定，不能改'; end if;
  if h.status = 'approved' and (p_data ? 'days_base' or p_data ? 'cnps_in_net') then raise exception 'BAD_STATE: 已批准，不能改计算规则'; end if;
  update app.payroll_months set
    days_base = coalesce(nullif(p_data->>'days_base','')::int, days_base),
    cnps_in_net = coalesce((p_data->>'cnps_in_net')::boolean, cnps_in_net),
    dept_label = case when p_data ? 'dept_label' then nullif(p_data->>'dept_label','') else dept_label end,
    prepared_by = case when p_data ? 'prepared_by' then nullif(p_data->>'prepared_by','') else prepared_by end,
    supervisor = case when p_data ? 'supervisor' then nullif(p_data->>'supervisor','') else supervisor end,
    finance_check = case when p_data ? 'finance_check' then nullif(p_data->>'finance_check','') else finance_check end,
    approver = case when p_data ? 'approver' then nullif(p_data->>'approver','') else approver end,
    remarks = case when p_data ? 'remarks' then nullif(p_data->>'remarks','') else remarks end
  where org_id = p_org and month = m;
  if p_data ? 'days_base' or p_data ? 'cnps_in_net' then perform app.payroll_recalc(p_org, m, null); end if;
end $$;

create or replace function app.payroll_open(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; e_end date; e app.employees; n int := 0; v_days numeric; v_auto numeric; v_from date; v_to date; h app.payroll_months; v_amt numeric; v_qty numeric; v_has boolean; v_inc numeric;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');   -- 0020: 罗兰 (销售主管 / 国家经理) 可以起草和初审
  e_end := (m + interval '1 month - 1 day')::date;
  insert into app.attendance_settings (org_id) values (p_org) on conflict do nothing;
  -- 分母 = 当月周一到周六的工作日数 (Frank 11-07)
  insert into app.payroll_months (org_id, month, days_base) values (p_org, m, app.workdays(m, e_end)) on conflict do nothing;
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经批准 / 发放，不能再加人'; end if;
  v_has := app.month_has_attendance(p_org, m);
  for e in select * from app.employees where org_id = p_org
           and coalesce(joined_on, m) <= e_end and (active or resigned_on >= m)
           and not (ext_ref is null and full_name is null and exists (select 1 from app.members mm where mm.employee_id = employees.id))
           and coalesce(sys_role,'') <> 'admin'
           and not exists (select 1 from app.payroll p where p.org_id = p_org and p.month = m and p.employee_id = employees.id) loop
    v_from := greatest(m, coalesce(e.joined_on, m)); v_to := least(e_end, coalesce(e.resigned_on, e_end));
    -- 有打卡的月份: 实到天数从打卡来; 没有打卡的月份 (历史 / 演示): 按在职区间满勤
    if v_has then v_auto := app.worked_days(p_org, e.id, m);
    else v_auto := case when v_from = m and v_to = e_end then h.days_base else least(h.days_base, app.workdays(v_from, v_to)) end; end if;
    v_days := v_auto;
    select coalesce(sum(sl.amount), 0), coalesce(sum(sl.qty), 0) into v_amt, v_qty
    from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
    where d.org_id = p_org and d.owner_employee_id = e.id and sh.voided_at is null and d.currency = 'XOF'
      and sh.shipped_at >= m and sh.shipped_at < (m + interval '1 month');
    v_inc := round(coalesce(v_amt * e.incentive_rate / 100, 0) + coalesce(v_qty * e.incentive_per_piece, 0));
    insert into app.payroll (org_id, month, employee_id, contract_salary, days_worked, days_auto, allowance, incentive, incentive_auto, incentive_basis, snap_name, snap_dept, snap_position)
    values (p_org, m, e.id, coalesce(e.base_salary, 0), v_days, v_auto, coalesce(e.allowance, 0), v_inc, v_inc,
      jsonb_build_object('amount', v_amt, 'qty', v_qty, 'rate', e.incentive_rate, 'per_piece', e.incentive_per_piece),
      coalesce(e.full_name, e.short_name), e.department, e.position);
    n := n + 1;
  end loop;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;

create or replace function app.payroll_refresh_auto(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months; r record; n int := 0; v_auto numeric;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');   -- 0020: 罗兰 (销售主管 / 国家经理) 可以起草和初审
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status is distinct from 'draft' then raise exception 'BAD_STATE: 只有草稿能重算'; end if;
  if not app.month_has_attendance(p_org, m) then raise exception 'VALIDATION: 这个月还没有打卡记录'; end if;
  for r in select * from app.payroll where org_id = p_org and month = m loop
    v_auto := app.worked_days(p_org, r.employee_id, m);
    update app.payroll set days_auto = v_auto, days_worked = case when r.days_worked is null or r.days_worked = r.days_auto then v_auto else days_worked end
    where org_id = p_org and month = m and employee_id = r.employee_id;
    n := n + 1;
  end loop;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;

-- 一步确认发放 = 批准 + 标记已付 (Frank 11-07: 发工资肯定中方审批, 不要多级审批流)
create or replace function app.payroll_confirm(p_org uuid, p_month date, p_paid_on date default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin');
  select * into h from app.payroll_months where org_id = p_org and month = m for update;
  if h.month is null then raise exception 'NOT_FOUND: 先打开这个月'; end if;
  if h.status = 'paid' then raise exception 'BAD_STATE: 这个月已经确认发放，不能再改'; end if;
  if not exists (select 1 from app.payroll where org_id = p_org and month = m) then raise exception 'VALIDATION: 这个月没有人'; end if;
  update app.payroll_months set status = 'paid', approved_by = coalesce(approved_by, app.uid()), approved_at = coalesce(approved_at, now()),
    paid_on = coalesce(p_paid_on, current_date), paid_by = app.uid() where org_id = p_org and month = m;
  update app.payroll set status = 'paid', paid_on = coalesce(p_paid_on, current_date) where org_id = p_org and month = m;
  perform app.audit(p_org, 'payroll_confirm', 'payroll_months', null, jsonb_build_object('month', m));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.payroll_confirm(uuid, date, date) to authenticated;
  end if;
end $$;
