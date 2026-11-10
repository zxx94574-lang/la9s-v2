-- 0024 (11-08 晚 Frank): ① 员工在每个环节都能「上报问题」, 立刻进中方待办; 事项分类以后 Frank 在选项设置里加
--                        ② 报价单不能带 0 价: 有编码的物料单价为 0 (没维护 / 客户没档位) 不让建报价, 提示去定价; 补录型号 (无编码) 允许 0
create table app.issue_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  deal_id uuid references app.deals(id),
  step text,                       -- 上报时所在环节 (STEPS key / 页面名)
  category text,                   -- 事项分类 (选项设置 issue_options)
  text text not null,
  photo text,                      -- data url / 以后换对象存储
  reported_by uuid not null,
  reported_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','closed')),
  reply text, closed_by uuid, closed_at timestamptz
);
create index on app.issue_reports (org_id, status, reported_at desc);
alter table app.issue_reports enable row level security;
create policy issue_reports_member on app.issue_reports for select using (app.is_member(org_id));

create or replace function app.report_issue(p_org uuid, p_deal uuid, p_step text, p_category text, p_text text, p_photo text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  if coalesce(trim(p_text),'') = '' then raise exception 'VALIDATION: 写一句出了什么问题'; end if;
  if p_deal is not null and not exists (select 1 from app.deals where id = p_deal and org_id = p_org) then raise exception 'NOT_FOUND'; end if;
  insert into app.issue_reports (org_id, deal_id, step, category, text, photo, reported_by)
  values (p_org, p_deal, p_step, nullif(trim(p_category),''), trim(p_text), nullif(p_photo,''), app.uid()) returning id into v_id;
  if p_deal is not null then perform app.deal_event(p_deal, 'issue_reported', jsonb_build_object('issue', v_id, 'step', p_step, 'category', p_category, 'text', trim(p_text))); end if;
  perform app.audit(p_org, 'report_issue', 'issue_reports', v_id, jsonb_build_object('deal', p_deal, 'step', p_step, 'category', p_category));
  return v_id;
end $$;

create or replace function app.close_issue(p_id uuid, p_reply text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.issue_reports;
begin
  select * into r from app.issue_reports where id = p_id;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'admin');
  if r.status = 'closed' then raise exception 'BAD_STATE: 已经处理过了'; end if;
  update app.issue_reports set status = 'closed', reply = nullif(trim(p_reply),''), closed_by = app.uid(), closed_at = now() where id = p_id;
  if r.deal_id is not null then perform app.deal_event(r.deal_id, 'issue_closed', jsonb_build_object('issue', p_id, 'reply', p_reply)); end if;
  perform app.audit(r.org_id, 'close_issue', 'issue_reports', p_id, jsonb_build_object('reply', p_reply));
end $$;

-- 报价 0 价拦截: 包一层, 建完检查, 有问题整单回滚
create or replace function app.create_quote_checked(p_org uuid, p_customer uuid, p_currency text, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_bad text; v_tier app.customer_tier;
begin
  v_id := app.create_quote(p_org, p_customer, p_currency, p_lines, p_note);
  select c.tier into v_tier from app.customers c where c.id = p_customer;
  select string_agg(coalesce(p.code,'') || ' ' || p.model, '、' order by l.seq) into v_bad
    from app.deal_lines l join app.products p on p.id = l.product_id
   where l.deal_id = v_id and coalesce(l.unit_price, 0) <= 0;
  if v_bad is not null then
    if v_tier is null then raise exception 'VALIDATION: 这个客户还没定档位，报价会全是 0。先在客户档案给档位（或转正式），再报价'; end if;
    raise exception 'VALIDATION: 这些型号在「%」档没有价格，报价单不能带 0：%。先到「物料与定价」填价，再回来报', v_tier, v_bad;
  end if;
  if exists (select 1 from app.deal_lines where deal_id = v_id and coalesce(qty_req,0) <= 0) then raise exception 'VALIDATION: 数量不能为 0'; end if;
  return v_id;
end $$;
