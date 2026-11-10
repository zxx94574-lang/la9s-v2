-- 0021 (11-07 16:17 Frank): 误点「确认发放」要能撤回; 但怕忘了已经发过又发一次 → 撤回留痕 + 再次确认要勾「已核实没重复付款」
alter table app.payroll_months add column reopen_count int not null default 0, add column last_confirmed_at timestamptz, add column last_reopen_reason text, add column last_reopen_at timestamptz;

create or replace function app.payroll_unconfirm(p_org uuid, p_month date, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_reason),'') = '' then raise exception 'VALIDATION: 要写撤回原因'; end if;
  select * into h from app.payroll_months where org_id = p_org and month = m for update;
  if h.month is null then raise exception 'NOT_FOUND'; end if;
  if h.status <> 'paid' then raise exception 'BAD_STATE: 这个月不是已确认发放'; end if;
  update app.payroll_months set status = 'draft', reopen_count = reopen_count + 1, last_confirmed_at = coalesce(paid_on::timestamptz, now()),
    last_reopen_reason = trim(p_reason), last_reopen_at = now(), paid_on = null, paid_by = null, approved_by = null, approved_at = null
  where org_id = p_org and month = m;
  update app.payroll set status = 'draft', paid_on = null where org_id = p_org and month = m;
  perform app.audit(p_org, 'payroll_unconfirm', 'payroll_months', null, jsonb_build_object('month', m, 'reason', trim(p_reason), 'was_paid_on', h.paid_on));
end $$;

-- 再次确认: 撤回过的月份必须 p_ack = true (界面上勾「已核实没有重复付款」)
drop function app.payroll_confirm(uuid, date, date);
create function app.payroll_confirm(p_org uuid, p_month date, p_paid_on date default null, p_ack boolean default false)
returns void language plpgsql security definer set search_path = app, public as $$
declare m date := date_trunc('month', p_month)::date; h app.payroll_months;
begin
  perform app.require_role(p_org, 'admin');
  select * into h from app.payroll_months where org_id = p_org and month = m for update;
  if h.month is null then raise exception 'NOT_FOUND: 先打开这个月'; end if;
  if h.status = 'paid' then raise exception 'BAD_STATE: 这个月已经确认发放，不能再改'; end if;
  if h.reopen_count > 0 and not p_ack then raise exception 'VALIDATION: 这个月之前确认过 % 次，再确认前要勾「已核实没有重复付款」', h.reopen_count; end if;
  if not exists (select 1 from app.payroll where org_id = p_org and month = m) then raise exception 'VALIDATION: 这个月没有人'; end if;
  update app.payroll_months set status = 'paid', approved_by = app.uid(), approved_at = now(), paid_on = coalesce(p_paid_on, current_date), paid_by = app.uid() where org_id = p_org and month = m;
  update app.payroll set status = 'paid', paid_on = coalesce(p_paid_on, current_date) where org_id = p_org and month = m;
  perform app.audit(p_org, 'payroll_confirm', 'payroll_months', null, jsonb_build_object('month', m, 'reconfirm', h.reopen_count > 0));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.payroll_unconfirm(uuid, date, text), app.payroll_confirm(uuid, date, date, boolean) to authenticated;
  end if;
end $$;
