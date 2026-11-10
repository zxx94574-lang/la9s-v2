-- LA&9S Operations · 0018 第九版 (Frank 2026-11-07「直接改吧」: 待改 106 / 124–130)
-- 1 导出记录 (留记录不留文件)   2 员工「负责城市」、客户「负责人」与资料编辑
-- 3 工资: 分母 = 当月周一到周六工作日; 出勤天数从打卡自动算; 奖金自动值 + 手改偏差; CNPS 公司承担不进实发; 申诉
-- 4 打卡地点: 仓库固定点 + 100 米; 市场不预设, 200 米内自动归成一个「地点」, 中方命名一次
-- 5 发货文件: BL 编号 + 签收照片; 组织文件 (海关 5 页 PDF)
-- 6 热线: 打开时间 (提醒 5 / 10 分钟用)、客户要货日期

-- ───────────────────────── 1 导出记录 ─────────────────────────
create table app.export_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  user_id uuid not null,
  kind text not null,                 -- full / payroll / table:<name> ...
  detail jsonb,                       -- {tables:[{name,rows}], rows, bytes}
  at timestamptz not null default now()
);
create index on app.export_log (org_id, at desc);
alter table app.export_log enable row level security;
create policy admin_only on app.export_log for select using (app.has_role(org_id, array['admin','manager']::app.role_name[]));

create or replace function app.log_export(p_org uuid, p_kind text, p_detail jsonb default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  insert into app.export_log (org_id, user_id, kind, detail) values (p_org, app.uid(), p_kind, p_detail) returning id into v_id;
  return v_id;
end $$;

-- ───────────────────────── 2 员工负责城市 / 客户负责人 ─────────────────────────
alter table app.employees add column city text;                 -- 负责城市
alter table app.customers add column contact_name text;         -- 负责人 (BL 上的 Responsable)

create or replace function app.upsert_employee(p_org uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id; v_active boolean; v_no text := nullif(upper(trim(p_data->>'emp_no')),'');
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_data->>'short_name'),'') = '' then raise exception 'VALIDATION: 工作名必填'; end if;
  if nullif(p_data->>'email','') is not null and p_data->>'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'VALIDATION: 邮箱格式不对'; end if;
  if v_no is not null and exists (select 1 from app.employees where org_id = p_org and emp_no = v_no and id is distinct from v_id) then
    raise exception 'CONFLICT: 员工编号 % 已经有人用了', v_no;
  end if;
  v_active := coalesce((p_data->>'active')::boolean, true);
  if v_id is null then
    insert into app.employees (org_id, short_name) values (p_org, trim(p_data->>'short_name')) returning id into v_id;
  end if;
  update app.employees set short_name = trim(p_data->>'short_name'), full_name = nullif(upper(trim(p_data->>'full_name')),''),
    emp_no = case when p_data ? 'emp_no' then v_no else emp_no end,
    phone = nullif(trim(p_data->>'phone'),''), email = nullif(lower(trim(p_data->>'email')),''),
    address = case when p_data ? 'address' then nullif(trim(p_data->>'address'),'') else address end,
    city = case when p_data ? 'city' then nullif(trim(p_data->>'city'),'') else city end,
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

-- 客户基本资料 (名字 / 城市 / 负责人 / 电话 / 地址 / 归属销售): 中方和主管改, 留审计
create or replace function app.edit_customer_info(p_customer uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(c.org_id, 'admin', 'manager', 'sales_manager');
  update app.customers set
    name = case when p_data ? 'name' and coalesce(trim(p_data->>'name'),'') <> '' then upper(trim(p_data->>'name')) else name end,
    city = case when p_data ? 'city' then nullif(trim(p_data->>'city'),'') else city end,
    contact_name = case when p_data ? 'contact_name' then nullif(trim(p_data->>'contact_name'),'') else contact_name end,
    phone = case when p_data ? 'phone' then nullif(trim(p_data->>'phone'),'') else phone end,
    address = case when p_data ? 'address' then nullif(trim(p_data->>'address'),'') else address end,
    owner_employee_id = case when p_data ? 'owner_employee_id' then nullif(p_data->>'owner_employee_id','')::uuid else owner_employee_id end,
    updated_at = now()
  where id = p_customer;
  perform app.audit(c.org_id, 'edit_customer_info', 'customers', p_customer, p_data - 'photo');
end $$;

-- ───────────────────────── 3 工资 ─────────────────────────
-- Frank 11-07: 基本工资 = 月薪 ÷ 当月周一到周六的工作日数 × 实到工作日数; CNPS 公司交保险局, 不进实发; 奖金可手改, 偏差 ±10% 要醒目
alter table app.payroll_months alter column cnps_in_net set default false;
alter table app.payroll add column days_auto numeric(5,1), add column incentive_auto numeric(18,2);
alter table app.attendance_settings add column late_absent_min int not null default 120;   -- 迟到超过这么多分钟按旷工 (当天不算出勤)

-- 申诉: 员工对某一天的缺勤 / 迟到写理由, 中方认可后那天算出勤
create table app.attendance_appeals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  employee_id uuid not null references app.employees(id),
  user_id uuid not null,
  day date not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid, decided_at timestamptz, decision_note text,
  created_at timestamptz not null default now(),
  unique (org_id, employee_id, day)
);
alter table app.attendance_appeals enable row level security;
create policy read_own on app.attendance_appeals for select using (app.is_member(org_id));

create or replace function app.appeal_attendance(p_org uuid, p_day date, p_reason text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_emp uuid; v_id uuid;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 要写理由'; end if;
  if p_day > current_date then raise exception 'VALIDATION: 只能申诉已经过去的日子'; end if;
  select employee_id into v_emp from app.members where user_id = app.uid() and org_id = p_org;
  if v_emp is null then raise exception 'VALIDATION: 这个账号没挂员工档案'; end if;
  insert into app.attendance_appeals (org_id, employee_id, user_id, day, reason) values (p_org, v_emp, app.uid(), p_day, trim(p_reason))
  on conflict (org_id, employee_id, day) do update set reason = excluded.reason, status = 'pending', decided_by = null, decided_at = null, decision_note = null
  where app.attendance_appeals.status <> 'approved'
  returning id into v_id;
  if v_id is null then raise exception 'BAD_STATE: 这天已经批准过了'; end if;
  return v_id;
end $$;

create or replace function app.decide_appeal(p_id uuid, p_ok boolean, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.attendance_appeals; m date;
begin
  select * into a from app.attendance_appeals where id = p_id;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(a.org_id, 'admin');
  update app.attendance_appeals set status = case when p_ok then 'approved' else 'rejected' end, decided_by = app.uid(), decided_at = now(), decision_note = nullif(trim(p_note),'') where id = p_id;
  perform app.audit(a.org_id, 'decide_appeal', 'attendance_appeals', p_id, jsonb_build_object('ok', p_ok, 'day', a.day));
  -- 这个月工资还是草稿的话, 出勤天数跟着重算
  m := date_trunc('month', a.day)::date;
  if exists (select 1 from app.payroll_months where org_id = a.org_id and month = m and status = 'draft') then
    update app.payroll p set days_auto = app.worked_days(a.org_id, a.employee_id, m), days_worked = app.worked_days(a.org_id, a.employee_id, m)
    where p.org_id = a.org_id and p.month = m and p.employee_id = a.employee_id and (p.days_worked is null or p.days_worked = p.days_auto);
    perform app.payroll_recalc(a.org_id, m, a.employee_id);
  end if;
end $$;

-- 实到工作日: 当月有上班打卡的天 (迟到超过 late_absent_min 的那天不算) ∪ 批准的申诉天
create or replace function app.worked_days(p_org uuid, p_emp uuid, p_month date)
returns numeric language sql stable security definer set search_path = app, public as $$
  with st as (select * from app.attendance_settings where org_id = p_org),
  days as (
    select distinct (a.at at time zone 'Africa/Abidjan')::date as d
    from app.attendance a, st
    where a.org_id = p_org and a.employee_id = p_emp and a.kind = 'in'
      and (a.at at time zone 'Africa/Abidjan')::date >= date_trunc('month', p_month)::date
      and (a.at at time zone 'Africa/Abidjan')::date < (date_trunc('month', p_month) + interval '1 month')::date
      and (a.at at time zone 'Africa/Abidjan')::time <= st.start_time + make_interval(mins => st.late_absent_min)
    union
    select day from app.attendance_appeals ap
    where ap.org_id = p_org and ap.employee_id = p_emp and ap.status = 'approved'
      and ap.day >= date_trunc('month', p_month)::date and ap.day < (date_trunc('month', p_month) + interval '1 month')::date
  )
  select count(*)::numeric from days
$$;

-- 这个月有没有打卡记录 (没有的话按满勤起草, 老数据 / 演示不受影响)
create or replace function app.month_has_attendance(p_org uuid, p_month date)
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.attendance a where a.org_id = p_org and a.kind = 'in'
    and a.at >= date_trunc('month', p_month) and a.at < date_trunc('month', p_month) + interval '1 month'
    and a.employee_id is not null)
$$;

create or replace function app.payroll_open(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; e_end date; e app.employees; n int := 0; v_days numeric; v_auto numeric; v_from date; v_to date; h app.payroll_months; v_amt numeric; v_qty numeric; v_has boolean; v_inc numeric;
begin
  perform app.require_role(p_org, 'admin');
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

-- 草稿月份「重新按打卡算」: 只刷新自动值和没手改过的行
create or replace function app.payroll_refresh_auto(p_org uuid, p_month date)
returns int language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months; r record; n int := 0; v_auto numeric;
begin
  perform app.require_role(p_org, 'admin');
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

-- ───────────────────────── 4 打卡地点 ─────────────────────────
alter table app.work_sites add column named boolean not null default true,     -- false = 系统自动聚出来的, 等中方起名
  add column auto boolean not null default false, add column created_at timestamptz not null default now();
alter table app.attendance_settings add column cluster_m int not null default 200;   -- 市场自动聚点半径

-- 仓库固定点 (Frank 11-07 给的坐标), 只给还没有仓库地点的组织补一个; 演示组织由演示数据自己建
insert into app.work_sites (org_id, name, kind, lat, lng, radius_m, active)
select o.id, 'LA 仓库', 'warehouse', 5.388056, -4.002583, 100, true from app.orgs o
where not exists (select 1 from app.work_sites w where w.org_id = o.id and w.kind = 'warehouse');

create or replace function app.clock(p_org uuid, p_kind text, p_lat double precision, p_lng double precision, p_accuracy double precision, p_note text default null)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare v_emp uuid; v_roles app.role_name[]; v_sales boolean; s record; v_ok boolean; v_late boolean := false; st app.attendance_settings; v_id uuid; v_new boolean := false; v_site uuid; v_name text; v_d int;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  if p_lat is null or p_lng is null then raise exception 'VALIDATION: 拿不到定位，打不了卡（手机要允许定位）'; end if;
  if p_kind not in ('in','out') then raise exception 'VALIDATION: 上班 / 下班'; end if;
  select employee_id, roles into v_emp, v_roles from app.members where user_id = app.uid() and org_id = p_org;
  insert into app.attendance_settings (org_id) values (p_org) on conflict do nothing;
  select * into st from app.attendance_settings where org_id = p_org;
  v_sales := 'sales' = any(v_roles) or 'sales_manager' = any(v_roles::text[]);
  if v_sales then
    -- 市场不预设 (Frank 11-07): 找 cluster_m 内最近的市场地点; 没有就自动开一个, 等中方起名
    select w.id, w.name, round(app.distance_m(p_lat, p_lng, w.lat, w.lng))::int as d into s
    from app.work_sites w where w.org_id = p_org and w.active and w.kind = 'market'
    order by app.distance_m(p_lat, p_lng, w.lat, w.lng) limit 1;
    if s.id is not null and s.d <= st.cluster_m then v_site := s.id; v_name := s.name; v_d := s.d;
    else
      insert into app.work_sites (org_id, name, kind, lat, lng, radius_m, active, named, auto)
      values (p_org, '新地点 ' || to_char(now() at time zone 'Africa/Abidjan', 'MM-DD HH24:MI'), 'market', p_lat, p_lng, st.cluster_m, true, false, true) returning id, name into v_site, v_name;
      v_d := 0; v_new := true;
    end if;
    v_ok := true;   -- 销售在哪都算打了卡, 位置记下来事后查验
  else
    select w.id, w.name, round(app.distance_m(p_lat, p_lng, w.lat, w.lng))::int as d, w.radius_m into s
    from app.work_sites w where w.org_id = p_org and w.active and w.kind in ('warehouse','office')
    order by app.distance_m(p_lat, p_lng, w.lat, w.lng) limit 1;
    v_site := s.id; v_name := s.name; v_d := s.d;
    v_ok := s.id is not null and s.d <= s.radius_m + least(coalesce(p_accuracy, 0), st.max_accuracy_m);
  end if;
  if p_kind = 'in' then
    v_late := (now() at time zone 'Africa/Abidjan')::time > st.start_time + make_interval(mins => st.grace_min)
      and not exists (select 1 from app.attendance a where a.user_id = app.uid() and a.kind = 'in' and (a.at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date);
  end if;
  insert into app.attendance (org_id, employee_id, user_id, kind, lat, lng, accuracy_m, site_id, distance_m, ok, late, note)
  values (p_org, v_emp, app.uid(), p_kind, p_lat, p_lng, p_accuracy, v_site, v_d, v_ok, v_late, nullif(trim(p_note),'')) returning id into v_id;
  return jsonb_build_object('ok', v_ok, 'site', v_name, 'distance', v_d, 'late', v_late, 'new_site', v_new);
end $$;

-- 中方给自动聚出来的地点起名 (起一次, 以后落在 cluster_m 内的打卡都套这个名)
create or replace function app.name_site(p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = app, public as $$
declare w app.work_sites;
begin
  select * into w from app.work_sites where id = p_id;
  if w.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(w.org_id, 'admin', 'manager', 'sales_manager');
  if coalesce(trim(p_name),'') = '' then raise exception 'VALIDATION: 名字不能空'; end if;
  update app.work_sites set name = trim(p_name), named = true where id = p_id;
  perform app.audit(w.org_id, 'name_site', 'work_sites', p_id, jsonb_build_object('name', trim(p_name)));
end $$;

create or replace function app.set_attendance_rules(p_org uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  insert into app.attendance_settings (org_id) values (p_org) on conflict do nothing;
  update app.attendance_settings set
    start_time = coalesce(nullif(p_data->>'start_time','')::time, start_time),
    end_time = coalesce(nullif(p_data->>'end_time','')::time, end_time),
    grace_min = coalesce(nullif(p_data->>'grace_min','')::int, grace_min),
    late_absent_min = coalesce(nullif(p_data->>'late_absent_min','')::int, late_absent_min),
    cluster_m = coalesce(nullif(p_data->>'cluster_m','')::int, cluster_m),
    max_accuracy_m = coalesce(nullif(p_data->>'max_accuracy_m','')::int, max_accuracy_m)
  where org_id = p_org;
  perform app.audit(p_org, 'set_attendance_rules', 'attendance_settings', null, p_data);
end $$;

-- ───────────────────────── 5 发货文件 ─────────────────────────
alter table app.shipments add column bl_no text, add column bl_issued_at timestamptz, add column bl_printed_at timestamptz,
  add column signed_photo text, add column signed_at timestamptz, add column signed_by uuid;
create unique index shipments_bl_no on app.shipments (org_id, bl_no) where bl_no is not null;

-- 组织文件 (海关 QUITTANCE 等随货附件): 一个 key 一份, 重传覆盖
create table app.org_files (
  org_id uuid not null references app.orgs(id),
  key text not null,
  name text not null, mime text not null, data text not null, bytes int not null,
  uploaded_by uuid, uploaded_at timestamptz not null default now(),
  primary key (org_id, key)
);
alter table app.org_files enable row level security;
create policy read_own on app.org_files for select using (app.is_member(org_id));

create or replace function app.set_org_file(p_org uuid, p_key text, p_name text, p_mime text, p_data text, p_bytes int)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  if p_data is null then delete from app.org_files where org_id = p_org and key = p_key;
  else
    insert into app.org_files (org_id, key, name, mime, data, bytes, uploaded_by) values (p_org, p_key, p_name, p_mime, p_data, p_bytes, app.uid())
    on conflict (org_id, key) do update set name = excluded.name, mime = excluded.mime, data = excluded.data, bytes = excluded.bytes, uploaded_by = excluded.uploaded_by, uploaded_at = now();
  end if;
  perform app.audit(p_org, 'set_org_file', 'org_files', null, jsonb_build_object('key', p_key, 'name', p_name, 'bytes', p_bytes));
end $$;

-- BL 编号: BL-DDMMYYYY-客户简码-序号 (照 Frank 11-07 样本, 不改规则). 已有编号就原样返回.
create or replace function app.issue_bl(p_shipment uuid)
returns text language plpgsql security definer set search_path = app, public as $$
declare sh app.shipments; d app.deals; c app.customers; v_short text; v_day text; v_seq int; v_no text;
begin
  select * into sh from app.shipments where id = p_shipment for update;
  if sh.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(sh.org_id, 'admin', 'manager', 'picker', 'sales', 'finance');
  if sh.bl_no is not null then return sh.bl_no; end if;
  select * into d from app.deals where id = sh.deal_id;
  select * into c from app.customers where id = d.customer_id;
  v_short := regexp_replace(upper(coalesce(c.name, 'CLI')), '[^A-Z0-9]', '', 'g');
  v_short := coalesce(nullif(left(v_short, 3), ''), 'CLI');
  v_day := to_char(sh.shipped_at at time zone 'Africa/Abidjan', 'DDMMYYYY');
  select count(*) + 1 into v_seq from app.shipments s where s.org_id = sh.org_id and s.bl_no like 'BL-' || v_day || '-' || v_short || '-%';
  v_no := 'BL-' || v_day || '-' || v_short || '-' || lpad(v_seq::text, 3, '0');
  update app.shipments set bl_no = v_no, bl_issued_at = now() where id = p_shipment;
  perform app.audit(sh.org_id, 'issue_bl', 'shipments', p_shipment, jsonb_build_object('bl_no', v_no));
  return v_no;
end $$;

create or replace function app.mark_bl_printed(p_shipment uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare sh app.shipments;
begin
  select * into sh from app.shipments where id = p_shipment;
  if sh.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.is_member(sh.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  update app.shipments set bl_printed_at = now() where id = p_shipment;
end $$;

-- 客户签字后的 BL 拍照回传 = 发货证明
create or replace function app.attach_bl_signature(p_shipment uuid, p_photo text)
returns void language plpgsql security definer set search_path = app, public as $$
declare sh app.shipments;
begin
  select * into sh from app.shipments where id = p_shipment;
  if sh.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(sh.org_id, 'admin', 'manager', 'picker', 'sales', 'finance');
  if coalesce(p_photo,'') = '' then raise exception 'VALIDATION: 要上传签字照片'; end if;
  update app.shipments set signed_photo = p_photo, signed_at = now(), signed_by = app.uid() where id = p_shipment;
  perform app.audit(sh.org_id, 'attach_bl_signature', 'shipments', p_shipment, null);
end $$;

-- ───────────────────────── 6 热线 ─────────────────────────
alter table app.deals add column hotline_opened_at timestamptz, add column want_on date;   -- 热线第一次打开这张单的时间; 客户说什么时候要

create or replace function app.mark_hotline_opened(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  update app.deals set hotline_opened_at = coalesce(hotline_opened_at, now()) where id = p_deal;
end $$;

drop function app.hotline_confirm(uuid, text, text, text);
create function app.hotline_confirm(p_deal uuid, p_note text default null, p_method text default null, p_proof text default null, p_want_on date default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'hotline', 'manager');
  perform app.lock_deal(p_deal, array['quoted']::app.deal_status[]);
  if p_method is not null and p_method not in ('whatsapp','phone','in_store') then raise exception 'VALIDATION: 确认方式无效'; end if;
  update app.deals set status = 'hotline_ok', hotline_note = p_note, hotline_method = p_method, hotline_proof = p_proof, want_on = p_want_on,
    hotline_opened_at = coalesce(hotline_opened_at, now()) where id = p_deal;
  perform app.deal_event(p_deal, 'hotline_confirmed', jsonb_build_object('note', p_note, 'method', p_method, 'want_on', p_want_on));
end $$;

-- 修 0017 的一个小 bug: 字母表 54 个字符, 随机数偶尔取到第 55 位得空串 → 临时密码变 7 位
create or replace function app.temp_password() returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 54)::int, 1), '') from generate_series(1, 8)
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.export_log, app.attendance_appeals, app.org_files to authenticated;
    grant execute on function app.log_export(uuid, text, jsonb), app.edit_customer_info(uuid, jsonb),
      app.appeal_attendance(uuid, date, text), app.decide_appeal(uuid, boolean, text), app.worked_days(uuid, uuid, date), app.month_has_attendance(uuid, date),
      app.payroll_refresh_auto(uuid, date), app.name_site(uuid, text), app.set_attendance_rules(uuid, jsonb),
      app.set_org_file(uuid, text, text, text, text, int), app.issue_bl(uuid), app.mark_bl_printed(uuid), app.attach_bl_signature(uuid, text),
      app.mark_hotline_opened(uuid), app.hotline_confirm(uuid, text, text, text, date) to authenticated;
  end if;
end $$;
