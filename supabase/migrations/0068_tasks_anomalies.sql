-- 0068 (Frank 11-18 366 / 368 / 369 / 370)
-- A. 指令和定期任务用同一套「给谁 + 谁汇报」: 可以下给 单人 (可多个) 或 部门; 下给部门 → 全员收到通知, 汇报人 = 全体都要汇报 / 指定人汇报.
--    定期任务 = 单独的模块: 每天 / 每周几 / 每月几号 + 大概几点, 完成必须交凭证, 没做完一直挂着.
-- B. 「异常的单」总入口: 现在散在各处的异常收成一张清单 (anomaly_log); 处理完自动从待处理里消失, 转成已处理记录 (留当时的数字、谁怎么处理的), 不可改不可删.

-- ───────────────────────── A. 指令 / 定期任务 ─────────────────────────
alter table app.directives
  add column group_id uuid,                          -- 同一次下达 (给多个人 / 一个部门) 共用
  add column target_dept text,                       -- 下给哪个部门 (空 = 下给个人)
  add column report_mode text check (report_mode in ('all', 'named')),
  add column reporter boolean not null default true, -- false = 只要收到通知, 不用交结果
  add column tpl jsonb,                              -- 定期任务模板: { assignees, dept, report_mode, reporters, freq, weekdays, month_days, at }
  add column at_time text;                           -- 大概几点做 (只显示 / 提醒用)
alter table app.directives alter column assignee_employee_id drop not null;
alter table app.directives add constraint directive_has_target check (is_template or assignee_employee_id is not null);
create index on app.directives (group_id);

-- 把「给谁」展开成一行行: 个人 → 每人一行都要汇报; 部门 → 部门里每个在职的人一行, 按汇报方式定谁要交
create or replace function app.expand_directive(p_org uuid, p jsonb, p_parent uuid, p_period text, p_by uuid, p_due date)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_group uuid := gen_random_uuid(); e record; n int := 0; v_dept text := nullif(p->>'dept', ''); v_mode text := coalesce(nullif(p->>'report_mode', ''), 'named');
  v_reporters uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(case when jsonb_typeof(p->'reporters') = 'array' then p->'reporters' else '[]'::jsonb end) x), '{}');
  v_ass uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(case when jsonb_typeof(p->'assignees') = 'array' then p->'assignees' else '[]'::jsonb end) x), '{}');
begin
  for e in
    select em.id, true as rep, null::text as dept from app.employees em where em.org_id = p_org and em.active and em.id = any(v_ass)
    union all
    select em.id, (v_mode = 'all' or em.id = any(v_reporters)), v_dept from app.employees em
    where v_dept is not null and em.org_id = p_org and em.active and em.department = v_dept and not (em.id = any(v_ass))
  loop
    insert into app.directives (org_id, title, body, urgent, require_photo, assignee_employee_id, due_on, parent_id, period_key, created_by, attachments,
                                group_id, target_dept, report_mode, reporter, at_time)
    values (p_org, trim(p->>'title'), nullif(trim(coalesce(p->>'body', '')), ''), coalesce((p->>'urgent')::boolean, false), coalesce((p->>'require_photo')::boolean, false),
      e.id, p_due, p_parent, case when p_parent is null then null else p_period || ':' || e.id end, p_by,
      case when jsonb_typeof(p->'attachments') = 'array' then p->'attachments' else '[]'::jsonb end,
      v_group, e.dept, case when e.dept is not null then v_mode end, e.rep, nullif(p->>'at', ''))
    on conflict (parent_id, period_key) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- 下达: p = { title, body, urgent, require_photo, due_on, attachments, assignees:[…], dept, report_mode, reporters:[…],
--             recurring: { freq: daily|weekly|monthly, weekdays:[1..6], month_days:[1..31], at:'09:30' } }
create or replace function app.issue_directive2(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_allow boolean; r jsonb := p->'recurring'; v_dept text := nullif(p->>'dept', ''); n int;
begin
  v_allow := coalesce((select (value->>'manager_can_issue')::boolean from app.org_settings where org_id = p_org and key = 'directive_rules'), false);
  if v_allow then perform app.require_role(p_org, 'manager'); else perform app.require_role(p_org, 'admin'); end if;
  if coalesce(trim(p->>'title'), '') = '' then raise exception 'VALIDATION: 写清楚要做什么'; end if;
  if v_dept is null and coalesce(jsonb_array_length(case when jsonb_typeof(p->'assignees') = 'array' then p->'assignees' else '[]'::jsonb end), 0) = 0 then raise exception 'VALIDATION: 选给谁'; end if;
  if v_dept is not null then
    if not exists (select 1 from app.employees where org_id = p_org and active and department = v_dept) then raise exception 'VALIDATION: 这个部门现在没有在职的人'; end if;
    if coalesce(p->>'report_mode', 'named') = 'named' and coalesce(jsonb_array_length(case when jsonb_typeof(p->'reporters') = 'array' then p->'reporters' else '[]'::jsonb end), 0) = 0 then
      raise exception 'VALIDATION: 下给部门要选谁来汇报（或者选「全体都要汇报」）';
    end if;
  end if;
  if r is not null and jsonb_typeof(r) = 'object' then
    if coalesce(r->>'freq', '') not in ('daily', 'weekly', 'monthly') then raise exception 'VALIDATION: 选多久一次'; end if;
    insert into app.directives (org_id, title, body, urgent, require_photo, repeat, is_template, created_by, attachments, target_dept, report_mode, at_time, tpl)
    values (p_org, trim(p->>'title'), nullif(trim(coalesce(p->>'body', '')), ''), false, true, r->>'freq', true, app.uid(),
      case when jsonb_typeof(p->'attachments') = 'array' then p->'attachments' else '[]'::jsonb end, v_dept, case when v_dept is not null then coalesce(p->>'report_mode', 'named') end, nullif(r->>'at', ''),
      (p - 'attachments' - 'recurring') || jsonb_build_object('freq', r->>'freq', 'weekdays', coalesce(r->'weekdays', '[]'::jsonb), 'month_days', coalesce(r->'month_days', '[]'::jsonb), 'at', r->>'at', 'require_photo', true))
    returning id into v_id;
    perform app.audit(p_org, 'issue_recurring', 'directives', v_id, p - 'attachments');
    perform app.spawn_directives(p_org);
    return v_id;
  end if;
  n := app.expand_directive(p_org, p, null, null, app.uid(), nullif(p->>'due_on', '')::date);
  if n = 0 then raise exception 'VALIDATION: 选的人里没有在职的'; end if;
  select id into v_id from app.directives where org_id = p_org and created_by = app.uid() order by created_at desc, id limit 1;
  perform app.audit(p_org, 'issue_directive', 'directives', v_id, p - 'attachments');
  return v_id;
end $$;

-- 定期任务到日子自动生成 (老模板一人一条照旧; 新模板按 tpl 展开)
create or replace function app.spawn_directives(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare t app.directives; k text; n int := 0; v_dow int := extract(isodow from current_date)::int; v_dom int := extract(day from current_date)::int; v_hit boolean;
begin
  if not app.is_member(p_org) then raise exception 'FORBIDDEN'; end if;
  for t in select * from app.directives where org_id = p_org and is_template and active loop
    if t.tpl is null then
      k := case t.repeat when 'daily' then to_char(current_date, 'YYYY-MM-DD') when 'weekly' then to_char(current_date, 'IYYY-"W"IW') else to_char(current_date, 'YYYY-MM') end;
      if t.repeat = 'daily' and v_dow = 7 then continue; end if;
      insert into app.directives (org_id, title, body, urgent, require_photo, assignee_employee_id, due_on, parent_id, period_key, created_by)
      values (p_org, t.title, t.body, t.urgent, t.require_photo, t.assignee_employee_id, current_date, t.id, k, t.created_by)
      on conflict (parent_id, period_key) do nothing;
      if found then n := n + 1; end if;
    else
      v_hit := case t.tpl->>'freq'
        when 'daily' then v_dow <> 7
        when 'weekly' then case when jsonb_array_length(coalesce(t.tpl->'weekdays', '[]'::jsonb)) = 0 then v_dow = 1 else t.tpl->'weekdays' @> to_jsonb(v_dow) end
        else case when jsonb_array_length(coalesce(t.tpl->'month_days', '[]'::jsonb)) = 0 then v_dom = 1 else t.tpl->'month_days' @> to_jsonb(v_dom) end end;
      if not v_hit then continue; end if;
      n := n + app.expand_directive(p_org, t.tpl, t.id, to_char(current_date, 'YYYY-MM-DD'), t.created_by, current_date);
    end if;
  end loop;
  return n;
end $$;

-- 只要「收到」、不用汇报的人: 点了收到这一条就关
create or replace function app.trg_notify_only() returns trigger language plpgsql as $$
begin
  if not new.reporter and new.status = 'acked' and old.status = 'sent' then new.status := 'closed'; new.confirmed_at := now(); new.confirm_note := '只需收到通知'; end if;
  return new;
end $$;
create trigger notify_only before update of status on app.directives for each row execute function app.trg_notify_only();

-- 离职 / 停用的人: 没做完的自动免交
create or replace function app.trg_directive_leave() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if old.active and not new.active then
    update app.directives set status = 'closed', confirmed_at = now(), confirm_note = '已离职，免交' where assignee_employee_id = new.id and not is_template and status <> 'closed';
  end if;
  return new;
end $$;
create trigger directive_leave after update of active on app.employees for each row execute function app.trg_directive_leave();

-- ───────────────────────── B. 异常的单 ─────────────────────────
create table app.anomaly_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.orgs(id),
  kind text not null, key text not null,
  deal_id uuid references app.deals(id) on delete set null, customer_id uuid, employee_id uuid, ref_label text,
  summary text not null, detail jsonb, admin_only boolean not null default false,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz, resolved_by uuid, resolution text
);
create unique index anomaly_open on app.anomaly_log (org_id, kind, key) where resolved_at is null;
create index on app.anomaly_log (org_id, resolved_at);
alter table app.anomaly_log enable row level security;   -- 不开放直接读: 一律走 anomaly_list (员工看不到成本)

-- 现在还存在的异常 (实时算). p_admin = 调用的人是中方 (带成本 / 总账的那几类只在中方调用时算)
create or replace function app.anomalies_now(p_org uuid, p_admin boolean)
returns table (kind text, key text, deal_id uuid, customer_id uuid, employee_id uuid, ref_label text, summary text, detail jsonb, admin_only boolean)
language plpgsql security definer set search_path = app, public as $$
#variable_conflict use_column
declare v_rep boolean := coalesce((select (value->>'on')::boolean from app.org_settings where org_id = p_org and key = 'rep_debt_rules'), true);
begin
  -- 亏钱: 卖价低于成本、还没批
  if app.loss_rule_on(p_org) then
    return query select 'loss_block', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no, '卖价低于成本，中方还没批',
      (select jsonb_build_object('lines', jsonb_agg(jsonb_build_object('line', l.deal_line_id, 'price', l.price_xof, 'cost', l.unit_cost))) from app.deal_loss_lines(d.id) l), true
    from app.deals d where d.org_id = p_org and d.status not in ('cancelled', 'shipped') and d.kind = 'normal'
      and app.deal_loss_sig(d.id) is not null and app.deal_loss_sig(d.id) is distinct from d.loss_ok_sig;
  end if;
  if p_admin then
    return query select 'loss_shipped', x.deal_id::text, x.deal_id, (select customer_id from app.deals where id = x.deal_id), null::uuid, x.biz_no,
      '已出库整单亏 ' || to_char(round(-x.profit), 'FM999,999,999,990') || ' XOF，还没写原因', jsonb_build_object('revenue', round(x.revenue), 'cost', round(x.cost), 'profit', round(x.profit)), true
    from app.loss_deals(p_org) x;
    return query select 'ledger', x.customer_id::text || ':' || x.currency, null::uuid, x.customer_id, null::uuid, x.customer_name,
      '账对不上：各单欠款合计和总账差 ' || to_char(round(x.diff), 'FM999,999,999,990') || ' ' || x.currency, jsonb_build_object('balance', x.balance, 'due_sum', x.due_sum, 'unallocated', x.unallocated, 'diff', x.diff), true
    from app.ledger_check(p_org) x;
  end if;
  -- 价格
  return query select 'price_pending', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no, '货发了、价格还没定', jsonb_build_object('note', d.price_pending_note, 'since', d.price_pending_at), false
    from app.deals d where d.org_id = p_org and d.price_pending and d.status <> 'cancelled' and exists (select 1 from app.shipments s where s.deal_id = d.id and s.voided_at is null);
  return query select 'price_req', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no, '改价申请等中方批（' || count(*) || ' 行）', jsonb_build_object('lines', count(*)), false
    from app.deals d join app.deal_lines l on l.deal_id = d.id where d.org_id = p_org and d.status not in ('cancelled', 'shipped') and l.price_req is not null group by d.id;
  return query select 'odd_price', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no, '异价单：' || count(*) || ' 行单价偏离档位价', jsonb_build_object('lines', count(*)), true
    from app.deals d join app.deal_lines l on l.deal_id = d.id where d.org_id = p_org and d.status not in ('cancelled', 'shipped', 'quoted', 'hotline_ok') and d.kind = 'normal' and l.odd group by d.id;
  -- 数量 / 欠款 (出库拦截)
  return query select 'qty_over', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no, '要出库的数量超过客户确认的数量', g.s->'qty', false
    from app.deals d cross join lateral (select app.ship_gate_state(d.id) as s) g
    where d.org_id = p_org and d.status in ('confirmed', 'reviewed', 'partial') and d.kind = 'normal' and jsonb_array_length(coalesce(g.s->'qty', '[]'::jsonb)) > 0;
  return query select 'credit', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no,
      case when (g.s->'credit'->>'over_limit')::boolean then '出了这张单超欠款上限' else '客户最老的欠款超账期' end, g.s->'credit', false
    from app.deals d cross join lateral (select app.ship_gate_state(d.id) as s) g
    where d.org_id = p_org and d.status in ('confirmed', 'reviewed', 'partial') and d.kind = 'normal' and jsonb_typeof(g.s->'credit') = 'object';
  return query select 'debt_block', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no, '客户设了「有欠款不出货」，现在还欠 ' || to_char(round(cr.balance), 'FM999,999,999,990'), jsonb_build_object('balance', cr.balance), false
    from app.deals d join app.customers c on c.id = d.customer_id join app.v_customer_credit cr on cr.customer_id = c.id
    where d.org_id = p_org and d.status in ('confirmed', 'reviewed', 'partial') and c.block_on_debt and cr.balance > 0 and d.debt_released_at is null;
  if v_rep then
    return query select 'rep_debt', e.id::text, null::uuid, null::uuid, e.id, e.short_name, '销售员 ' || e.short_name || ' 名下 ' || x.n || ' 张单货款没收回，名下客户暂不出货', jsonb_build_object('deals', x.n, 'due', x.due), false
      from app.employees e cross join lateral (select count(*) as n, sum(r.due) as due from app.rep_debt(e.id) r where r.shipped_on < current_date) x
      where e.org_id = p_org and e.active and x.n > 0;
  end if;
  return query select 'discrepancy', r.id::text, r.deal_id, d.customer_id, null::uuid, d.biz_no, '收货差异还没处理（' || case r.kind when 'short' then '少了' when 'over' then '多了' when 'wrong' then '发错' else '损坏' end || '）',
      jsonb_build_object('amount', r.amount, 'late', r.late), false
    from app.receipt_discrepancies r join app.deals d on d.id = r.deal_id where r.org_id = p_org and r.status = 'open';
  return query select 'partial', d.id::text, d.id, d.customer_id, null::uuid, d.biz_no,
      '只发了一部分，还有 ' || (select coalesce(sum(l.qty_supply - l.qty_shipped), 0) from app.deal_lines l where l.deal_id = d.id) || ' 片没发', null::jsonb, false
    from app.deals d where d.org_id = p_org and d.status = 'partial';
  return query select 'task_block', t.id::text, t.ref_id, d.customer_id, t.assignee_employee_id, d.biz_no, '任务没做完，卡着这张单：' || t.title, null::jsonb, false
    from app.directives t join app.deals d on d.id = t.ref_id where t.org_id = p_org and t.ref_kind = 'deal' and t.blocks and t.status <> 'closed' and t.active and not t.is_template and d.status not in ('cancelled', 'shipped');
end $$;

-- 同步: 新出现的记一条; 不存在了的转成已处理 (谁、怎么处理的 从订单操作记录里找)
create or replace function app.sync_anomalies(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_admin boolean; n int; r record; ev record; acts text[];
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  v_admin := app.has_role(p_org, array['admin']::app.role_name[]);
  create temp table if not exists _anom (kind text, key text, deal_id uuid, customer_id uuid, employee_id uuid, ref_label text, summary text, detail jsonb, admin_only boolean);
  truncate _anom;
  insert into _anom select * from app.anomalies_now(p_org, v_admin);
  insert into app.anomaly_log (org_id, kind, key, deal_id, customer_id, employee_id, ref_label, summary, detail, admin_only)
  select p_org, a.kind, a.key, a.deal_id, a.customer_id, a.employee_id, a.ref_label, a.summary, a.detail, a.admin_only from _anom a
  on conflict (org_id, kind, key) where resolved_at is null do nothing;
  get diagnostics n = row_count;
  for r in select l.* from app.anomaly_log l where l.org_id = p_org and l.resolved_at is null
             and (v_admin or l.kind not in ('loss_shipped', 'ledger'))
             and not exists (select 1 from _anom a where a.kind = l.kind and a.key = l.key) loop
    acts := case r.kind when 'loss_block' then array['loss_approved'] when 'loss_shipped' then array['loss_reviewed'] when 'price_pending' then array['price_settled', 'price_pending_cancelled']
      when 'price_req' then array['price_decided'] when 'qty_over' then array['gate_released'] when 'credit' then array['gate_released'] when 'debt_block' then array['debt_released', 'payment_appeal_decided']
      when 'discrepancy' then array['discrepancy_decided'] when 'partial' then array['shipped'] else array[]::text[] end;
    ev := null;
    if r.deal_id is not null and array_length(acts, 1) > 0 then
      select e.user_id, e.action, e.at, coalesce(e.detail->>'note', e.detail->>'reason', e.detail->>'conclusion', e.detail->>'decision') as note into ev
      from app.deal_events e where e.deal_id = r.deal_id and e.action = any(acts) and e.at >= r.detected_at order by e.at desc limit 1;
    end if;
    update app.anomaly_log set resolved_at = coalesce(ev.at, now()), resolved_by = ev.user_id,
      resolution = case when ev.action is null then
          case r.kind when 'rep_debt' then '名下的货款收回来了（或中方放行）' when 'ledger' then '账已经对上' when 'task_block' then '任务已关闭'
            when 'odd_price' then '已出库 / 价格改回档位价' else '情况已经不存在（单子往下走了、改了或作废了）' end
        else (case ev.action when 'loss_approved' then '中方批准亏本出货' when 'loss_reviewed' then '中方写了亏损结论' when 'price_settled' then '中方定了价' when 'price_pending_cancelled' then '取消了价格待定'
            when 'price_decided' then '中方处理了改价申请' when 'gate_released' then '中方放行' when 'debt_released' then '中方放行这张单' when 'payment_appeal_decided' then '付款申诉已处理'
            when 'discrepancy_decided' then '中方处理了差异' when 'shipped' then '剩下的发了' else ev.action end) || coalesce('：' || ev.note, '') end
    where id = r.id;
  end loop;
  return n;
end $$;

-- 读: p_open = true 待处理 / false 已处理记录 (按处理时间段). 员工看不到带成本的几类和明细数字
create or replace function app.anomaly_list(p_org uuid, p_open boolean, p_from date default null, p_to date default null)
returns table (id bigint, kind text, deal_id uuid, customer_id uuid, employee_id uuid, ref_label text, customer_name text, summary text, detail jsonb,
               detected_at timestamptz, resolved_at timestamptz, resolved_by_name text, resolution text)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare v_admin boolean;
begin
  if not app.is_member(p_org) or app.has_role(p_org, array['boss', 'clerk']::app.role_name[]) and not app.has_role(p_org, array['manager']::app.role_name[]) then raise exception 'PERMISSION_DENIED'; end if;
  v_admin := app.has_role(p_org, array['admin']::app.role_name[]);
  return query
  select l.id, l.kind, l.deal_id, l.customer_id, l.employee_id, l.ref_label, c.name, l.summary, case when v_admin then l.detail end, l.detected_at, l.resolved_at,
    (select e.short_name from app.members m join app.employees e on e.id = m.employee_id where m.org_id = l.org_id and m.user_id = l.resolved_by limit 1), l.resolution
  from app.anomaly_log l left join app.customers c on c.id = l.customer_id
  where l.org_id = p_org and (v_admin or not l.admin_only)
    and case when p_open then l.resolved_at is null
        else l.resolved_at is not null and (p_from is null or l.resolved_at::date >= p_from) and (p_to is null or l.resolved_at::date <= p_to) end
  order by case when p_open then l.detected_at end, l.resolved_at desc;
end $$;

revoke all on function app.expand_directive(uuid, jsonb, uuid, text, uuid, date), app.issue_directive2(uuid, jsonb), app.anomalies_now(uuid, boolean), app.sync_anomalies(uuid),
  app.anomaly_list(uuid, boolean, date, date) from public;
grant execute on function app.issue_directive2(uuid, jsonb), app.sync_anomalies(uuid), app.anomaly_list(uuid, boolean, date, date) to authenticated;
