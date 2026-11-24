-- 待办改版 (待改 502 / 503, Frank 11-23): 指令编号 T-月日-序号 / 撤销必须写原因 / 订单每一步超时的原因

-- 编号: T-1123-07 (T = Tâche / Task; 当天第几条). 模板 (定期任务的规则本身) 不编号, 它生成的每一条编号.
alter table app.directives add column if not exists no text, add column if not exists stop_reason text;
create or replace function app.trg_directive_no() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_day date := (coalesce(new.created_at, now()) at time zone 'Africa/Abidjan')::date; v_n int;
begin
  if new.is_template or new.no is not null then return new; end if;
  select coalesce(max(nullif(split_part(d.no, '-', 3), '')::int), 0) + 1 into v_n
  from app.directives d where d.org_id = new.org_id and d.no like 'T-' || to_char(v_day, 'MMDD') || '-%'
    and (d.created_at at time zone 'Africa/Abidjan')::date = v_day;
  new.no := 'T-' || to_char(v_day, 'MMDD') || '-' || lpad(v_n::text, 2, '0');
  return new;
end $$;
drop trigger if exists directive_no on app.directives;
create trigger directive_no before insert on app.directives for each row execute function app.trg_directive_no();
-- 老的补上编号
with x as (
  select id, 'T-' || to_char((created_at at time zone 'Africa/Abidjan')::date, 'MMDD') || '-' ||
    lpad((row_number() over (partition by org_id, (created_at at time zone 'Africa/Abidjan')::date order by created_at, id))::text, 2, '0') as no
  from app.directives where not is_template and no is null)
update app.directives d set no = x.no from x where x.id = d.id;

-- 撤销: 必须写原因 (员工能看到); 老的 stop_directive 留着给「停掉定期任务」用
create or replace function app.stop_directive2(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.directives where id = p_id;
  perform app.require_role(v_org, 'admin');
  if coalesce(trim(p_reason), '') = '' then raise exception '撤销要写原因'; end if;
  update app.directives set active = false, status = case when is_template then status else 'closed' end,
    stop_reason = trim(p_reason), confirm_note = '中方撤销：' || trim(p_reason), confirmed_at = now(), confirmed_by = app.uid()
  where id = p_id;
end $$;

-- 订单某一步超时了: 写原因 (谁都能写自己经手的单; 留在订单记录里)
create or replace function app.deal_delay_note(p_deal uuid, p_seg int, p_reason text) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.deals where id = p_deal;
  if v_org is null or not app.is_member(v_org) then raise exception 'PERMISSION'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '要写原因'; end if;
  insert into app.deal_events (deal_id, user_id, action, detail) values (p_deal, app.uid(), 'delay_note', jsonb_build_object('seg', p_seg, 'reason', trim(p_reason)));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.stop_directive2(uuid, text), app.deal_delay_note(uuid, int, text) to authenticated;
  end if;
end $$;
