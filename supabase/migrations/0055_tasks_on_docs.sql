-- 0055 挂在单据上的任务 (Frank 11-17, 待改 338 / 339): 复用 0041 中方指令, 加上「挂在哪张单 / 哪个客户」和「结果怎么填」
-- 类型: payment_plan 问付款计划 (结果 = 哪天付多少 + 截图) / recon 对账事项 / check 核对一件事 / other
-- 对账事项默认期限 = 第二天 (系统只有日期, 「12:00」写在说明里)

alter table app.directives add column ref_kind text check (ref_kind in ('deal','customer','shipment','product','employee','po')),
  add column ref_id uuid, add column ref_label text, add column ref_customer_id uuid,
  add column task_type text check (task_type in ('payment_plan','recon','check','other')), add column result jsonb;
create index on app.directives (org_id, ref_kind, ref_id);
create index on app.directives (org_id, ref_customer_id);

create or replace function app.issue_task(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_type text := coalesce(nullif(p->>'task_type', ''), 'other'); v_cust uuid;
begin
  if v_type not in ('payment_plan','recon','check','other') then raise exception 'VALIDATION: 任务类型不对'; end if;
  if nullif(p->>'ref_kind', '') is null or nullif(p->>'ref_id', '') is null then raise exception 'VALIDATION: 任务要挂在一张单 / 一个客户上'; end if;
  v_id := app.issue_directive(p_org, p || jsonb_build_object(
    'due_on', coalesce(nullif(p->>'due_on', ''), (current_date + 1)::text),
    'require_photo', v_type = 'payment_plan' or coalesce((p->>'require_photo')::boolean, false)) - 'repeat');
  v_cust := case when p->>'ref_kind' = 'customer' then (p->>'ref_id')::uuid
                 when p->>'ref_kind' = 'deal' then (select customer_id from app.deals where id = (p->>'ref_id')::uuid and org_id = p_org)
                 else nullif(p->>'ref_customer_id', '')::uuid end;
  update app.directives set ref_kind = p->>'ref_kind', ref_id = (p->>'ref_id')::uuid, ref_label = nullif(p->>'ref_label', ''), ref_customer_id = v_cust, task_type = v_type where id = v_id;
  if p->>'ref_kind' = 'deal' then perform app.deal_event((p->>'ref_id')::uuid, 'task_issued', jsonb_build_object('title', p->>'title', 'type', v_type)); end if;
  return v_id;
end $$;

-- 交结果: 付款计划必须结构化 (哪天付多少) + 截图
create or replace function app.complete_task(p_id uuid, p_result jsonb, p_note text, p_photo text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.directives; x jsonb; v_text text := '';
begin
  select * into d from app.directives where id = p_id;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if d.task_type = 'payment_plan' then
    if jsonb_typeof(p_result) <> 'array' or jsonb_array_length(p_result) = 0 then raise exception 'VALIDATION: 付款计划要填：哪天付多少（至少一行）'; end if;
    for x in select * from jsonb_array_elements(p_result) loop
      if nullif(x->>'on', '') is null or coalesce((x->>'amount')::numeric, 0) <= 0 then raise exception 'VALIDATION: 付款计划每一行都要有日期和金额'; end if;
      v_text := v_text || case when v_text = '' then '' else '；' end || (x->>'on') || ' 付 ' || to_char((x->>'amount')::numeric, 'FM999,999,999,990');
    end loop;
  end if;
  perform app.complete_directive(p_id, nullif(trim(coalesce(v_text, '') || case when coalesce(trim(p_note), '') = '' then '' else case when v_text = '' then '' else '。' end || trim(p_note) end), ''), p_photo);
  update app.directives set result = p_result where id = p_id;
  if d.ref_kind = 'deal' then perform app.deal_event(d.ref_id, 'task_done', jsonb_build_object('title', d.title, 'type', d.task_type)); end if;
end $$;

-- 到期没付的付款计划 (中方看): 计划日已过、客户还有欠款
create or replace function app.overdue_payment_plans(p_org uuid)
returns table (directive_id uuid, customer_id uuid, customer_name text, plan_on date, amount numeric, balance numeric, ref_label text)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  return query
  select d.id, c.id, c.name, (x->>'on')::date, (x->>'amount')::numeric, coalesce(cr.balance, 0), d.ref_label
  from app.directives d join app.customers c on c.id = d.ref_customer_id
  left join app.v_customer_credit cr on cr.customer_id = c.id
  cross join lateral jsonb_array_elements(d.result) x
  where d.org_id = p_org and d.task_type = 'payment_plan' and d.status in ('done','closed') and jsonb_typeof(d.result) = 'array'
    and (x->>'on')::date < current_date and coalesce(cr.balance, 0) > 0
    and not exists (select 1 from app.receipts r where r.customer_id = c.id and r.received_on >= (x->>'on')::date - 1 and r.voided_at is null)
  order by (x->>'on')::date;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.issue_task(uuid, jsonb), app.complete_task(uuid, jsonb, text, text), app.overdue_payment_plans(uuid) to authenticated;
  end if;
end $$;
