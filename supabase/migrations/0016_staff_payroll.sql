-- 0016 员工档案 + 工资发放记录 (Frank 2026-10-31)
-- 1) 员工档案一张表: 全名 / 工作名 / 邮箱 / 电话 / 部门 / 职位 (都从选项里选) / 销售类型 / 入职 / 离职 / 状态 / 飞书账号 / 身份证照片.
--    选项 (部门、职位、销售类型) 存在 org_settings 'staff_options', 中方可以改.
-- 2) 工资发放记录一张表: 每月每人一行, 列和 8 月的 Excel 一样; 中方批准 → 中方标记已付; 付了就锁死, 永久留底, 不能删.
-- 3) 凡是涉及钱的审批只认中方 (这里顺手把「抹零」从财务收回中方).
-- 4) 销售主管继承销售员的权限; 回收三个岗位先没有权限.

-- ───────── 岗位继承 ─────────
create or replace function app.has_role(p_org uuid, p_roles app.role_name[])
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from app.members m
    where m.user_id = app.uid() and m.org_id = p_org and m.active
      and (m.roles && p_roles or 'admin' = any(m.roles)
           or ('sales_manager' = any(m.roles::text[]) and 'sales' = any(p_roles::text[])))
  )
$$;

-- ───────── 抹零只中方 ─────────
create or replace function app.write_off(p_deal uuid, p_amount numeric, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_due numeric;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'admin');
  select due into v_due from app.v_deal_due where deal_id = p_deal;
  if p_amount <= 0 or p_amount > v_due then raise exception 'VALIDATION: 抹零金额必须大于 0 且不超过未付'; end if;
  if p_amount > (case when d.currency = 'XOF' then 100 else 1 end) then raise exception 'VALIDATION: 抹零超过上限'; end if;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, note)
  values (d.org_id, d.customer_id, d.currency, 'writeoff', -p_amount, p_deal, '抹零：' || coalesce(p_reason,''));
  perform app.audit(d.org_id, 'write_off', 'deals', p_deal, jsonb_build_object('amount', p_amount));
end $$;

-- ───────── 员工档案 ─────────
alter table app.employees
  add column sys_role text,                -- 系统岗位 (admin / manager / sales_manager / picker / sales / hotline / finance / recycle_*)
  add column sales_channel text,           -- 销售员细分: 零售 / 批发 / 区域
  add column resigned_on date,
  add column feishu_name text,             -- 飞书账号显示名
  add column ext_ref text,                 -- 来源记录 (飞书 record_id), 重复导入按它更新
  add column updated_at timestamptz;
create unique index employees_ext_ref on app.employees (org_id, ext_ref) where ext_ref is not null;

create table app.employee_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  employee_id uuid not null references app.employees(id),
  kind text not null check (kind in ('id_front','id_back','id','contract','other')),
  name text, mime text not null default 'image/jpeg',
  data text not null,                      -- base64 (部署后换成存储桶, 这里只存指针)
  w int, h int,
  created_by uuid, created_at timestamptz not null default now(),
  removed_at timestamptz                   -- 不真删, 只标记
);
alter table app.employee_files enable row level security;
create policy admin_only on app.employee_files for select using (app.has_role(org_id, array['admin']::app.role_name[]));

create or replace function app.upsert_employee(p_org uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id; v_active boolean;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_data->>'short_name'),'') = '' then raise exception 'VALIDATION: 工作名必填'; end if;
  if nullif(p_data->>'email','') is not null and p_data->>'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'VALIDATION: 邮箱格式不对'; end if;
  v_active := coalesce((p_data->>'active')::boolean, true);
  if v_id is null then
    insert into app.employees (org_id, short_name) values (p_org, trim(p_data->>'short_name')) returning id into v_id;
  end if;
  update app.employees set short_name = trim(p_data->>'short_name'), full_name = nullif(upper(trim(p_data->>'full_name')),''),
    phone = nullif(trim(p_data->>'phone'),''), email = nullif(lower(trim(p_data->>'email')),''),
    department = nullif(p_data->>'department',''), position = nullif(p_data->>'position',''),
    sys_role = nullif(p_data->>'sys_role',''), sales_channel = nullif(p_data->>'sales_channel',''),
    joined_on = nullif(p_data->>'joined_on','')::date, resigned_on = case when v_active then null else nullif(p_data->>'resigned_on','')::date end,
    active = v_active, feishu_name = nullif(trim(p_data->>'feishu_name'),''),
    base_salary = nullif(p_data->>'base_salary','')::numeric, allowance = nullif(p_data->>'allowance','')::numeric,
    incentive_rate = nullif(p_data->>'incentive_rate','')::numeric, incentive_per_piece = nullif(p_data->>'incentive_per_piece','')::numeric,
    note = nullif(p_data->>'note',''), updated_at = now()
  where id = v_id and org_id = p_org;
  perform app.audit(p_org, 'upsert_employee', 'employees', v_id, null);
  return v_id;
end $$;

create or replace function app.add_employee_file(p_org uuid, p_emp uuid, p_kind text, p_name text, p_mime text, p_data text, p_w int, p_h int)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  perform app.require_role(p_org, 'admin');
  if not exists (select 1 from app.employees where id = p_emp and org_id = p_org) then raise exception 'NOT_FOUND: 员工不存在'; end if;
  if coalesce(p_data,'') = '' then raise exception 'VALIDATION: 没有图片'; end if;
  insert into app.employee_files (org_id, employee_id, kind, name, mime, data, w, h, created_by)
  values (p_org, p_emp, p_kind, p_name, coalesce(p_mime,'image/jpeg'), p_data, p_w, p_h, app.uid()) returning id into v_id;
  perform app.audit(p_org, 'add_employee_file', 'employee_files', v_id, jsonb_build_object('employee', p_emp, 'kind', p_kind));
  return v_id;
end $$;

create or replace function app.remove_employee_file(p_file uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.employee_files;
begin
  select * into f from app.employee_files where id = p_file;
  perform app.require_role(f.org_id, 'admin');
  update app.employee_files set removed_at = now() where id = p_file;
  perform app.audit(f.org_id, 'remove_employee_file', 'employee_files', p_file, null);
end $$;

-- 飞书员工表导入 (中方). 按 ext_ref 更新, 照片同名不重复加.
create or replace function app.import_staff(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare r jsonb; ph jsonb; v_id uuid; n_new int := 0; n_upd int := 0; n_ph int := 0;
begin
  perform app.require_role(p_org, 'admin');
  for r in select * from jsonb_array_elements(p_rows) loop
    select id into v_id from app.employees where org_id = p_org and ext_ref = r->>'ext_ref';
    if v_id is null then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
    v_id := app.upsert_employee(p_org, v_id, r);
    update app.employees set ext_ref = r->>'ext_ref' where id = v_id;
    for ph in select * from jsonb_array_elements(coalesce(r->'photos','[]')) loop
      if not exists (select 1 from app.employee_files where employee_id = v_id and name = ph->>'name' and removed_at is null) then
        perform app.add_employee_file(p_org, v_id, coalesce(ph->>'kind','id'), ph->>'name', ph->>'mime', ph->>'data', (ph->>'w')::int, (ph->>'h')::int);
        n_ph := n_ph + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'photos', n_ph);
end $$;

-- ───────── 工资发放记录 ─────────
-- 每月一个表头 (对应 Excel 抬头和签字栏), 每人一行 (对应 Excel 明细行).
create table app.payroll_months (
  org_id uuid not null references app.orgs(id),
  month date not null,
  status text not null default 'draft' check (status in ('draft','approved','paid')),
  days_base int not null default 25,          -- 满勤天数 (8 月表: 基本工资 ÷ 25 × 出勤天数)
  cnps_in_net boolean not null default true,  -- 8 月表把公司承担的社保加进了实发, 待 Frank 确认
  dept_label text,                            -- Excel 抬头「Département」
  prepared_by text, supervisor text, finance_check text, approver text,   -- 签字栏 (名字)
  remarks text,                               -- Remarques / Anomalies
  approved_by uuid, approved_at timestamptz, paid_on date, paid_by uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, month)
);
alter table app.payroll_months enable row level security;
create policy admin_only on app.payroll_months for select using (app.has_role(org_id, array['admin']::app.role_name[]));

alter table app.payroll
  add column contract_salary numeric(18,2),   -- 合同底薪 (满勤)
  add column days_worked numeric(5,1),        -- Jours travaillés
  add column prime_team numeric(18,2) not null default 0,   -- Prime équipe
  add column cnps numeric(18,2) not null default 0,         -- 公司承担的社保
  add column net numeric(18,2),               -- Net à payer (存下来, 以后规则改了旧月份不变)
  add column snap_name text, add column snap_dept text, add column snap_position text,   -- 当月快照: 以后员工改名 / 调岗, 旧记录不变
  add column paid_on date;
-- base = Salaire fixe (按出勤折算后), allowance = Indemnité, incentive = Prime individuelle, deduction = Retenue

create or replace function app.workdays(p_from date, p_to date)
returns int language sql immutable as $$
  select count(*)::int from generate_series(p_from, p_to, interval '1 day') d where extract(isodow from d) < 7   -- 周一到周六
$$;

create or replace function app.payroll_recalc(p_org uuid, p_month date, p_emp uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare h app.payroll_months;
begin
  select * into h from app.payroll_months where org_id = p_org and month = p_month;
  update app.payroll p set
    base = round(least(coalesce(p.contract_salary,0), coalesce(p.contract_salary,0) / h.days_base * coalesce(p.days_worked, h.days_base))),
    updated_at = now()
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
  update app.payroll p set net = p.base + p.allowance + p.incentive + p.prime_team + case when h.cnps_in_net then p.cnps else 0 end - p.deduction
  where p.org_id = p_org and p.month = p_month and (p_emp is null or p.employee_id = p_emp);
end $$;
revoke execute on function app.payroll_recalc(uuid, date, uuid) from public;

-- 打开某月: 建表头; 把这个月在职 (或这个月离职) 的人加进来, 已有的行不动
create or replace function app.payroll_open(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; e_end date; e app.employees; n int := 0; v_days numeric; v_from date; v_to date; h app.payroll_months; v_amt numeric; v_qty numeric;
begin
  perform app.require_role(p_org, 'admin');
  e_end := (m + interval '1 month - 1 day')::date;
  insert into app.payroll_months (org_id, month) values (p_org, m) on conflict do nothing;
  select * into h from app.payroll_months where org_id = p_org and month = m;
  if h.status <> 'draft' then raise exception 'BAD_STATE: 这个月已经批准 / 发放，不能再加人'; end if;
  for e in select * from app.employees where org_id = p_org
           and coalesce(joined_on, m) <= e_end and (active or resigned_on >= m)
           and not (ext_ref is null and full_name is null and exists (select 1 from app.members mm where mm.employee_id = employees.id))   -- 岗位账号不是人
           and coalesce(sys_role,'') <> 'admin'   -- 中方不在本地工资表里 (要发的话以后再说)
           and not exists (select 1 from app.payroll p where p.org_id = p_org and p.month = m and p.employee_id = employees.id) loop
    v_from := greatest(m, coalesce(e.joined_on, m)); v_to := least(e_end, coalesce(e.resigned_on, e_end));
    v_days := case when v_from = m and v_to = e_end then h.days_base else least(h.days_base, app.workdays(v_from, v_to)) end;
    -- 个人奖金默认 = 归属客户当月出库金额 × 激励 % (+ 件数 × 每件), 规则以后和 Frank 逐条对; 草稿里可以改
    select coalesce(sum(sl.amount), 0), coalesce(sum(sl.qty), 0) into v_amt, v_qty
    from app.shipments sh join app.shipment_lines sl on sl.shipment_id = sh.id join app.deals d on d.id = sh.deal_id
    where d.org_id = p_org and d.owner_employee_id = e.id and sh.voided_at is null and d.currency = 'XOF'
      and sh.shipped_at >= m and sh.shipped_at < (m + interval '1 month');
    insert into app.payroll (org_id, month, employee_id, contract_salary, days_worked, allowance, incentive, incentive_basis, snap_name, snap_dept, snap_position)
    values (p_org, m, e.id, coalesce(e.base_salary, 0), v_days, coalesce(e.allowance, 0),
      round(coalesce(v_amt * e.incentive_rate / 100, 0) + coalesce(v_qty * e.incentive_per_piece, 0)),
      jsonb_build_object('amount', v_amt, 'qty', v_qty, 'rate', e.incentive_rate, 'per_piece', e.incentive_per_piece),
      coalesce(e.full_name, e.short_name), e.department, e.position);
    n := n + 1;
  end loop;
  perform app.payroll_recalc(p_org, m, null);
  return n;
end $$;

create or replace function app.payroll_set_line(p_org uuid, p_month date, p_emp uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
  num constant text[] := array['contract_salary','days_worked','allowance','incentive','prime_team','cnps','deduction'];
begin
  perform app.require_role(p_org, 'admin');
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

-- 草稿里去掉一个人 (只草稿; 批准后的记录永久保留)
create or replace function app.payroll_drop_line(p_org uuid, p_month date, p_emp uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date;
begin
  perform app.require_role(p_org, 'admin');
  if (select status from app.payroll_months where org_id = p_org and month = m) <> 'draft' then raise exception 'BAD_STATE: 已批准的记录不能删'; end if;
  delete from app.payroll where org_id = p_org and month = m and employee_id = p_emp;
end $$;

create or replace function app.payroll_set_header(p_org uuid, p_month date, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin');
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

-- 中方批准 / 撤回批准 / 标记已付. 付了就锁死.
create or replace function app.payroll_decide(p_org uuid, p_month date, p_action text, p_paid_on date default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin');
  select * into h from app.payroll_months where org_id = p_org and month = m for update;
  if h.month is null then raise exception 'NOT_FOUND: 先打开这个月'; end if;
  if p_action = 'approve' then
    if h.status <> 'draft' then raise exception 'BAD_STATE: 只有草稿能批准'; end if;
    if not exists (select 1 from app.payroll where org_id = p_org and month = m) then raise exception 'VALIDATION: 这个月没有人'; end if;
    update app.payroll_months set status = 'approved', approved_by = app.uid(), approved_at = now() where org_id = p_org and month = m;
    update app.payroll set status = 'approved' where org_id = p_org and month = m;
  elsif p_action = 'reopen' then
    if h.status <> 'approved' then raise exception 'BAD_STATE: 只有已批准、还没付的能撤回'; end if;
    update app.payroll_months set status = 'draft', approved_by = null, approved_at = null where org_id = p_org and month = m;
    update app.payroll set status = 'draft' where org_id = p_org and month = m;
  elsif p_action = 'pay' then
    if h.status <> 'approved' then raise exception 'BAD_STATE: 先批准才能标记已付'; end if;
    update app.payroll_months set status = 'paid', paid_on = coalesce(p_paid_on, current_date), paid_by = app.uid() where org_id = p_org and month = m;
    update app.payroll set status = 'paid', paid_on = coalesce(p_paid_on, current_date) where org_id = p_org and month = m;
  else raise exception 'VALIDATION: 未知操作 %', p_action;
  end if;
  perform app.audit(p_org, 'payroll_' || p_action, 'payroll_months', null, jsonb_build_object('month', m));
  return p_action;
end $$;

-- 旧的「算本月」(0013) 不再用: 改成只能动草稿月份, 而且走新的表头
create or replace function app.compute_payroll(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
begin
  return app.payroll_open(p_org, p_month);
end $$;

-- 旧的逐人改状态 (0013) 停用: 批准 / 发放只能整月由中方做
create or replace function app.set_payroll(p_org uuid, p_month date, p_employee uuid, p_deduction numeric, p_note text, p_status text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  raise exception 'BAD_STATE: 工资改成整月批准，请用「工资发放记录」';
end $$;
