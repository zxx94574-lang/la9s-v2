-- 0095 审批底层（待改 345）：每类决定在设置里选一种模式 —— self 自己定 / notify 知会 / approve 必须批准
-- 设置 org_settings 'approval_modes' = { kind: { mode, who: [employee_id…] } }；没设的类型 = self。
-- 送批 = 一页纸报告（title + report jsonb）+ 要执行的参数 args；批准时由批准人执行（白名单里的类型才能执行，不存任意 SQL）。
create table if not exists app.decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  kind text not null,
  title text not null,
  report jsonb not null default '{}',
  args jsonb not null default '{}',
  mode text not null check (mode in ('notify', 'approve')),
  status text not null default 'pending' check (status in ('pending', 'done', 'rejected', 'cancelled')),
  who uuid[] not null default '{}',           -- 批准人 / 被知会的人（员工）；空 = 除了提的人以外任何中方
  acked uuid[] not null default '{}',         -- 知会：谁点了「已阅」
  result jsonb,
  requested_by uuid, requested_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz, note text);
alter table app.decisions enable row level security;
create policy read_own on app.decisions for select using (app.is_member(org_id));

create or replace function app.decision_mode(p_org uuid, p_kind text) returns jsonb language sql stable security definer set search_path = app, public as $$
  select coalesce((select value->p_kind from app.org_settings where org_id = p_org and key = 'approval_modes'), '{"mode":"self"}'::jsonb);
$$;

-- 白名单执行器：kind → 真正的业务函数（各函数自己再查权限）
create or replace function app.decision_exec(p_org uuid, p_kind text, a jsonb) returns jsonb language plpgsql security definer set search_path = app, public as $$
declare v jsonb;
begin
  if p_kind = 'promo' then
    v := to_jsonb(app.set_promo(p_org, (a->>'product')::uuid, (a->>'price')::numeric, (a->>'from')::date, (a->>'to')::date,
      case when a ? 'tiers' and jsonb_typeof(a->'tiers') = 'array' then array(select jsonb_array_elements_text(a->'tiers')) end,
      case when a ? 'customers' and jsonb_typeof(a->'customers') = 'array' then array(select jsonb_array_elements_text(a->'customers')::uuid) end,
      a->>'note', coalesce(a->>'label', '促销价')));
  elsif p_kind = 'writeoff' then
    v := to_jsonb(app.write_off_bad_debt((a->>'deal')::uuid, (a->>'amount')::numeric, a->>'reason', a->>'proof'));
  elsif p_kind = 'price_rules' then
    perform app.set_org_setting(p_org, 'price_rules', a->'value'); v := 'true'::jsonb;
  else
    raise exception 'VALIDATION: 这类决定（%）不能走审批', p_kind;
  end if;
  return v;
end $$;

-- 提交：self → 直接执行；notify → 执行 + 记一条知会；approve → 只记下，等批
create or replace function app.decision_submit(p_org uuid, p_kind text, p_title text, p_report jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare m jsonb := app.decision_mode(p_org, p_kind); v_mode text := coalesce(m->>'mode', 'self'); v_res jsonb; v_id uuid;
  v_who uuid[] := coalesce(array(select jsonb_array_elements_text(coalesce(m->'who', '[]'::jsonb))::uuid), '{}');
begin
  perform app.require_role(p_org, 'admin');
  if v_mode = 'self' then return jsonb_build_object('mode', 'self', 'result', app.decision_exec(p_org, p_kind, p_args)); end if;
  if v_mode = 'notify' then v_res := app.decision_exec(p_org, p_kind, p_args); end if;
  insert into app.decisions (org_id, kind, title, report, args, mode, status, who, result, requested_by, decided_by, decided_at)
    values (p_org, p_kind, p_title, coalesce(p_report, '{}'), coalesce(p_args, '{}'), v_mode, case when v_mode = 'notify' then 'done' else 'pending' end, v_who, v_res,
      app.uid(), case when v_mode = 'notify' then app.uid() end, case when v_mode = 'notify' then now() end)
    returning id into v_id;
  perform app.audit(p_org, 'decision_' || v_mode, 'decisions', v_id, jsonb_build_object('kind', p_kind, 'title', p_title));
  return jsonb_build_object('mode', v_mode, 'id', v_id, 'result', v_res);
end $$;

create or replace function app.decision_can_decide(d app.decisions) returns boolean language sql stable security definer set search_path = app, public as $$
  select app.has_role(d.org_id, array['admin']::app.role_name[])
    and (case when cardinality(d.who) > 0 then app.current_employee(d.org_id) = any(d.who) else d.requested_by is distinct from app.uid() end);
$$;

-- 批准（可以先在报告上改参数 p_args，改了留痕）→ 立即执行
create or replace function app.decision_approve(p_id uuid, p_note text default null, p_args jsonb default null)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare d app.decisions; v_res jsonb;
begin
  select * into d from app.decisions where id = p_id for update;
  if d.id is null then raise exception 'NOT_FOUND: 没有这条'; end if;
  if d.status <> 'pending' or d.mode <> 'approve' then raise exception 'VALIDATION: 这条已经处理过了'; end if;
  if not app.decision_can_decide(d) then raise exception 'PERMISSION_DENIED: 这条要指定的人批（不能自己批自己的）' using errcode = '42501'; end if;
  v_res := app.decision_exec(d.org_id, d.kind, coalesce(p_args, d.args));
  update app.decisions set status = 'done', decided_by = app.uid(), decided_at = now(), note = nullif(trim(p_note), ''), result = v_res,
    args = coalesce(p_args, args), report = case when p_args is not null and p_args is distinct from d.args then report || jsonb_build_object('改前参数', d.args) else report end
    where id = p_id;
  perform app.audit(d.org_id, 'decision_approve', 'decisions', p_id, jsonb_build_object('kind', d.kind, 'edited', p_args is not null and p_args is distinct from d.args));
  return v_res;
end $$;

create or replace function app.decision_reject(p_id uuid, p_note text) returns void language plpgsql security definer set search_path = app, public as $$
declare d app.decisions;
begin
  select * into d from app.decisions where id = p_id for update;
  if d.status <> 'pending' then raise exception 'VALIDATION: 这条已经处理过了'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 退回要写意见'; end if;
  if d.requested_by = app.uid() then
    update app.decisions set status = 'cancelled', decided_by = app.uid(), decided_at = now(), note = trim(p_note) where id = p_id;
  else
    if not app.decision_can_decide(d) then raise exception 'PERMISSION_DENIED: 不是这条的批准人' using errcode = '42501'; end if;
    update app.decisions set status = 'rejected', decided_by = app.uid(), decided_at = now(), note = trim(p_note) where id = p_id;
  end if;
  perform app.audit(d.org_id, 'decision_reject', 'decisions', p_id, jsonb_build_object('note', p_note));
end $$;

create or replace function app.decision_ack(p_id uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_emp uuid;
begin
  select org_id into v_org from app.decisions where id = p_id;
  perform app.require_role(v_org, 'admin');
  v_emp := app.current_employee(v_org);
  update app.decisions set acked = array(select distinct unnest(acked || coalesce(v_emp, app.uid()))) where id = p_id;
end $$;
