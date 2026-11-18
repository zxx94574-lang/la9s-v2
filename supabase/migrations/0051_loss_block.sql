-- 0051 亏钱 = 重中之重 (Frank 11-17 21:50, 待改 344)
-- 事前: 单价低于到岸成本的行 → 这张单不能往下推 / 不能出库, 中方批准 + 写原因才放行 (批的是「这些行 + 这些价」, 之后再改价要重新批)
-- 事后: 已出库毛利 < 0 的单进中方紧急待办, 中方必须选结论才能关
-- 开关: org_settings 'loss_rules' {"on": true}, 没设 = 开

alter table app.deals
  add column loss_ok_sig text, add column loss_ok_by uuid, add column loss_ok_at timestamptz, add column loss_ok_note text, add column loss_ok_kind text,
  add column loss_review_at timestamptz, add column loss_review_by uuid, add column loss_review_conclusion text, add column loss_review_note text;

-- 内部: 这张单里卖价低于成本的行 (没成本 / 没编码的行不算; 外币按单据汇率折西法)
create or replace function app.deal_loss_lines(p_deal uuid)
returns table (deal_line_id uuid, price_xof numeric, unit_cost numeric)
language sql stable security definer set search_path = app, public as $$
  select dl.id, round(coalesce(dl.unit_price, 0) * k.k, 2), u.unit_cost
  from app.deals d
  join app.deal_lines dl on dl.deal_id = d.id
  cross join lateral (select case when d.currency = 'XOF' then 1::numeric when coalesce(d.fx_rate, 0) > 0 then d.fx_rate else null end as k) k
  cross join lateral app.unit_cost_now(dl.id) u
  where d.id = p_deal and d.kind = 'normal' and dl.product_id is not null and u.unit_cost is not null and k.k is not null
    and (case when dl.qty_supply > 0 then dl.qty_supply else dl.qty_req end) > 0
    and coalesce(dl.unit_price, 0) * k.k < u.unit_cost
$$;

create or replace function app.deal_loss_sig(p_deal uuid)
returns text language sql stable security definer set search_path = app, public as $$
  select md5(string_agg(deal_line_id::text || ':' || price_xof::text, ',' order by deal_line_id)) from app.deal_loss_lines(p_deal)
$$;

create or replace function app.loss_rule_on(p_org uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select coalesce((select (value->>'on')::boolean from app.org_settings where org_id = p_org and key = 'loss_rules'), true)
$$;

-- 给界面: 任何成员都能问「这张单是不是被亏本价卡住了、哪几行」; 成本数字不给 (只有中方从毛利函数里看)
create or replace function app.deal_loss_state(p_deal uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare d app.deals; s text; ids uuid[];
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  if not app.loss_rule_on(d.org_id) then return jsonb_build_object('on', false, 'blocked', false, 'lines', '[]'::jsonb); end if;
  select array_agg(deal_line_id) into ids from app.deal_loss_lines(p_deal);
  s := app.deal_loss_sig(p_deal);
  return jsonb_build_object('on', true, 'lines', to_jsonb(coalesce(ids, '{}')),
    'blocked', s is not null and s is distinct from d.loss_ok_sig,
    'approved', s is not null and s = d.loss_ok_sig,
    'note', d.loss_ok_note, 'kind', d.loss_ok_kind, 'at', d.loss_ok_at);
end $$;

-- 中方批准亏本出货: 必须写原因; kind = clearance (清仓) / other
create or replace function app.approve_loss(p_deal uuid, p_note text, p_kind text default 'other')
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals; s text;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 批准亏本出货必须写原因'; end if;
  s := app.deal_loss_sig(p_deal);
  if s is null then raise exception 'VALIDATION: 这张单没有低于成本的行，不用批'; end if;
  update app.deals set loss_ok_sig = s, loss_ok_by = app.uid(), loss_ok_at = now(), loss_ok_note = p_note, loss_ok_kind = coalesce(nullif(p_kind, ''), 'other') where id = p_deal;
  perform app.deal_event(p_deal, 'loss_approved', jsonb_build_object('note', p_note, 'kind', p_kind, 'lines', (select count(*) from app.deal_loss_lines(p_deal))));
end $$;

create or replace function app.loss_gate(p_deal uuid) returns void
language plpgsql security definer set search_path = app, public as $$
declare d app.deals; s text; n int;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null or d.kind <> 'normal' or not app.loss_rule_on(d.org_id) then return; end if;
  s := app.deal_loss_sig(p_deal);
  if s is not null and s is distinct from d.loss_ok_sig then
    select count(*) into n from app.deal_loss_lines(p_deal);
    raise exception 'LOSS_BLOCK: 有 % 行的价格要中方批准才能往下走', n;
  end if;
end $$;

-- 往下推 (状态往前走) 之前拦
create or replace function app.trg_deal_loss_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  -- 流程先后 (不是枚举定义的先后): 报价 → 确认 → 找货 → 初检完 → 销售订单 → 客户确认 → 复检完 → 部分出库 → 出库; 只拦往前走, 撤回 / 作废不拦
  if new.status <> old.status and new.status <> 'cancelled'
     and array_position(array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed','partial','shipped'], new.status::text)
       > array_position(array['quoted','hotline_ok','picking','picked','ordered','confirmed','reviewed','partial','shipped'], old.status::text) then
    perform app.loss_gate(new.id);
  end if;
  return new;
end $$;
create trigger deal_loss_gate before update of status on app.deals for each row execute function app.trg_deal_loss_gate();

-- 出库硬拦 (最后一道)
create or replace function app.trg_ship_loss_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  perform app.loss_gate(new.deal_id);
  return new;
end $$;
create trigger ship_loss_gate before insert on app.shipments for each row execute function app.trg_ship_loss_gate();

-- 事后: 已出库、整单毛利 < 0、中方还没下结论的单
create or replace function app.loss_deals(p_org uuid)
returns table (deal_id uuid, biz_no text, customer_name text, shipped_on date, revenue numeric, cost numeric, profit numeric, approved_note text)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  select m.deal_id, min(m.biz_no), min(m.customer_name), max(m.shipped_on), sum(m.revenue), sum(m.cost), sum(m.profit), min(d.loss_ok_note)
  from app.margin_rows(p_org) m join app.deals d on d.id = m.deal_id
  where d.loss_review_at is null and not m.cost_missing
  group by m.deal_id having sum(m.profit) < 0
  order by max(m.shipped_on) desc;
end $$;

create or replace function app.close_loss_review(p_deal uuid, p_conclusion text, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_conclusion), '') = '' then raise exception 'VALIDATION: 要选一个结论（为什么亏）'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 要写清楚原因和以后怎么避免'; end if;
  update app.deals set loss_review_at = now(), loss_review_by = app.uid(), loss_review_conclusion = p_conclusion, loss_review_note = p_note where id = p_deal;
  perform app.deal_event(p_deal, 'loss_reviewed', jsonb_build_object('conclusion', p_conclusion, 'note', p_note));
end $$;

do $$ begin
  revoke all on function app.deal_loss_lines(uuid), app.deal_loss_sig(uuid), app.loss_gate(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function app.deal_loss_lines(uuid), app.deal_loss_sig(uuid), app.loss_gate(uuid) from authenticated;
    grant execute on function app.deal_loss_state(uuid), app.approve_loss(uuid, text, text), app.loss_deals(uuid), app.close_loss_review(uuid, text, text), app.loss_rule_on(uuid) to authenticated;
  end if;
end $$;
