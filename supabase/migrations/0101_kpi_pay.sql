-- 0101 时效 / 准确率 联动工资（Frank 11-25 12:57「我的时效和准确性好像没有和我的工资联动起来」）
-- 工资单加一栏「时效准确奖扣」：可正可负；自动数（依据）+ 可手改，手改和自动差 10% 以上标出来（同仓库提成 / 销售提成）
-- 自动数由「时效与准确率」同一套算法算（只算上班时间、每段谁经手算谁的），规则参数里可调、可关
alter table app.payroll add column kpi_pay numeric(18,2) not null default 0, add column kpi_pay_auto numeric(18,2), add column kpi_note text;

create or replace function app.payroll_recalc(p_org uuid, p_month date, p_emp uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare h app.payroll_months;
begin
  select * into h from app.payroll_months where org_id = p_org and month = p_month;
  update app.payroll p set
    base = round(least(coalesce(p.contract_salary,0), coalesce(p.contract_salary,0) / h.days_base * coalesce(p.days_worked, h.days_base))),
    updated_at = now()
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
  update app.payroll p set net = p.base + p.allowance + p.incentive + p.prime_team + coalesce(p.wh_comm, 0) + coalesce(p.sales_comm, 0) + coalesce(p.kpi_pay, 0)
      + case when h.cnps_in_net then p.cnps else 0 end - p.deduction
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
end $$;

-- 批量带出：rows = [{employee_id, amount, note}]；手改过的（当前数 ≠ 上次自动数）不覆盖，p_force 才覆盖
create or replace function app.payroll_kpi_pay(p_org uuid, p_month date, p_rows jsonb, p_force boolean default false)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months; n int;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.month is null then return 0; end if;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经确认发放，不能重算'; end if;
  update app.payroll p set
    kpi_pay = case when p_force or p.kpi_pay = coalesce(p.kpi_pay_auto, 0) then coalesce(x.amount, 0) else p.kpi_pay end,
    kpi_pay_auto = coalesce(x.amount, 0), kpi_note = x.note, updated_at = now()
  from (select p2.employee_id, (r->>'amount')::numeric as amount, r->>'note' as note
        from app.payroll p2 left join jsonb_array_elements(coalesce(p_rows, '[]')) r on (r->>'employee_id')::uuid = p2.employee_id
        where p2.org_id = p_org and p2.month = m) x
  where p.org_id = p_org and p.month = m and p.employee_id = x.employee_id;
  get diagnostics n = row_count;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;

create or replace function app.payroll_set_kpi_pay(p_org uuid, p_month date, p_emp uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin', 'sales_manager');
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经确认发放，不能改'; end if;
  update app.payroll set kpi_pay = coalesce(p_amount, 0), updated_at = now() where org_id = p_org and month = m and employee_id = p_emp;
  perform app.payroll_recalc(p_org, m, p_emp);
  perform app.audit(p_org, 'payroll_kpi_pay', 'payroll', p_emp, jsonb_build_object('month', m, 'amount', p_amount));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.payroll_kpi_pay(uuid, date, jsonb, boolean), app.payroll_set_kpi_pay(uuid, date, uuid, numeric) to authenticated;
  end if;
end $$;
