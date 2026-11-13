-- 0044 (Frank 11-12, 待改 244–276 第 2 批: 业务规则)
-- ① 订单号 CI-年月日-当日序号, 报价 / 找货 / 销售单 / 出库单跟着订单号走  ② 四个资金账户 + 运费发货当场记实付
-- ③ 问题库存冻结  ④ 申请定级 (档位没确认不能发给客户, 定档后自动重算价)  ⑤ 仓库提成 + 发错记责
-- ⑥ 指令附件 + 迟收到要写原因  ⑦ 热线打电话名单  ⑧ 价格调整单  ⑨ 找货人 ≠ 复核人  ⑩ 过期草稿作废

-- ───────────────────────── ① 订单号 ─────────────────────────
create or replace function app.next_doc_no(p_org uuid, p_type text)
returns text language plpgsql security definer set search_path = app, public as $$
declare v_period text; v_no int; v_prefix text;
begin
  select doc_prefix into v_prefix from app.orgs where id = p_org;
  if p_type = 'BIZ' then   -- 订单号: CI-261112-03 (当日序号, 超过 99 自动变三位)
    v_period := to_char(now() at time zone 'UTC', 'YYMMDD');
    insert into app.doc_counters as c (org_id, doc_type, period, last_no) values (p_org, 'ORD', v_period, 1)
    on conflict (org_id, doc_type, period) do update set last_no = c.last_no + 1 returning last_no into v_no;
    return v_prefix || '-' || v_period || '-' || case when v_no < 100 then lpad(v_no::text, 2, '0') else v_no::text end;
  end if;
  v_period := to_char(now() at time zone 'UTC', 'YYMM');
  insert into app.doc_counters as c (org_id, doc_type, period, last_no) values (p_org, p_type, v_period, 1)
  on conflict (org_id, doc_type, period) do update set last_no = c.last_no + 1 returning last_no into v_no;
  return p_type || '-' || v_prefix || '-' || v_period || '-' || lpad(v_no::text, 4, '0');
end $$;

-- 新格式的订单: 报价单 = 订单号-Q, 找货单 -P, 销售订单 -O, 出库单 -S1 / -S2 (第几批). 旧单号 (BIZ- 开头) 不动
create or replace function app.docno_follow() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.biz_no like 'BIZ-%' then return new; end if;
  if new.quote_no is not null and new.quote_no <> new.biz_no || '-Q' then new.quote_no := new.biz_no || '-Q'; end if;
  if new.pick_no is not null and new.pick_no <> new.biz_no || '-P' then new.pick_no := new.biz_no || '-P'; end if;
  if new.so_no is not null and new.so_no <> new.biz_no || '-O' then new.so_no := new.biz_no || '-O'; end if;
  return new;
end $$;
create trigger docno_follow before insert or update of quote_no, pick_no, so_no on app.deals for each row execute function app.docno_follow();
create or replace function app.outno_follow() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_biz text; n int;
begin
  select biz_no into v_biz from app.deals where id = new.deal_id;
  if v_biz is null or v_biz like 'BIZ-%' then return new; end if;
  select count(*) into n from app.shipments where deal_id = new.deal_id;
  new.out_no := v_biz || '-S' || (n + 1);
  return new;
end $$;
create trigger outno_follow before insert on app.shipments for each row execute function app.outno_follow();

-- ───────────────────────── ② 资金账户 + 运费 ─────────────────────────
create or replace function app.ensure_cash_accounts(p_org uuid) returns void language sql security definer set search_path = app, public as $$
  insert into app.cash_accounts (org_id, name, kind, currency, note)
  select p_org, x.name, x.kind, x.cur, x.note
  from (values ('Cash-XOF','cash','XOF','金蝶账户 12345001'), ('Wave-XOF','wave','XOF','金蝶账户 12345002'), ('Cash-RMB','cash','CNY','金蝶账户 12345003'), ('Cash-USD','cash','USD','金蝶账户 12345004')) as x(name, kind, cur, note)
  where exists (select 1 from app.currencies c where c.code = x.cur)
  on conflict (org_id, name) do nothing;
$$;
revoke all on function app.ensure_cash_accounts(uuid) from public;
select app.ensure_cash_accounts(id) from app.orgs;

-- 运费: 发货当场记【实际付了多少】, 自动生成一条支出流水 (本地物流费); 只进我们自己的流水, 不动客户的账
create or replace function app.record_ship_freight(p_shipment uuid, p_bearer text, p_amount numeric, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; d app.deals; v_acc uuid; v_mv uuid; v_name text;
begin
  select * into s from app.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  select * into d from app.deals where id = s.deal_id;
  perform app.require_role(d.org_id, 'manager', 'picker', 'finance', 'sales_manager');
  if coalesce(p_bearer, '') not in ('customer','company','company_part') then raise exception 'VALIDATION: 选运费谁出'; end if;
  if p_bearer = 'customer' then update app.shipments set freight_bearer = 'customer' where id = p_shipment; return null; end if;
  if s.freight_paid_at is not null then raise exception 'BAD_STATE: 这批运费已经记过了'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'VALIDATION: 填实际付了多少运费'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要有带价格的截图'; end if;
  v_name := coalesce((select value->>'account' from app.org_settings where org_id = d.org_id and key = 'freight_rules'), 'Wave-XOF');
  perform app.ensure_cash_accounts(d.org_id);
  select id into v_acc from app.cash_accounts where org_id = d.org_id and name = v_name and active;
  if v_acc is null then raise exception 'CONFIG: 找不到付运费的账户 %，到「资金账户」里建一个', v_name; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, category, customer_id, proof, note, created_by, decided_by, decided_at, biz_type, flow_class)
  values (d.org_id, v_acc, 'expense', p_amount, current_date, 'approved', '本地物流费', d.customer_id, p_proof, '运费 ' || s.out_no || ' · ' || d.biz_no, app.uid(), app.uid(), now(), '备件', '运营费用')
  returning id into v_mv;
  update app.shipments set freight_bearer = p_bearer, freight_est = p_amount, freight_amount = p_amount, freight_account_id = v_acc, freight_proof = p_proof,
    freight_paid_at = now(), freight_paid_by = app.uid(), freight_move_id = v_mv where id = p_shipment;
  perform app.deal_event(d.id, 'freight_paid', jsonb_build_object('out_no', s.out_no, 'amount', p_amount, 'account', v_name));
  return v_mv;
end $$;

-- ───────────────────────── ③ 问题库存: 先冻结, 评估后解冻或转待检仓 ─────────────────────────
create table app.stock_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  stock_item_id uuid not null references app.stock_items(id),
  qty int not null check (qty >= 0),            -- 从「可售」里扣住的数量 (算进预占)
  whole boolean not null default false,          -- 整个编码暂停: 已经预占给订单的也不许出库
  reason text not null, proof text not null,
  status text not null default 'active' check (status in ('active','released','moved')),
  created_by uuid, created_at timestamptz not null default now(),
  closed_by uuid, closed_at timestamptz, close_note text, close_proof text
);
create index on app.stock_holds (org_id, status);
alter table app.stock_holds enable row level security;
create policy stock_holds_read on app.stock_holds for select using (app.is_member(org_id));

create or replace function app.freeze_stock(p_stock uuid, p_qty int, p_reason text, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare s app.stock_items; v_org uuid; v_free int; v_q int; v_id uuid; v_whole boolean := p_qty is null;
begin
  select * into s from app.stock_items where id = p_stock for update;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  select org_id into v_org from app.warehouses where id = s.warehouse_id;
  perform app.require_role(v_org, 'manager');
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 写清楚为什么暂停出库'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 冻结要传凭证（照片 / 截图），不能平白无故冻结'; end if;
  v_free := s.qty_on_hand - s.qty_reserved;
  if v_whole then v_q := v_free;
  else
    if p_qty <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
    if p_qty > v_free then raise exception 'VALIDATION: 可售只有 % 片，冻结不了 % 片；要全部停就选「整个编码」', v_free, p_qty; end if;
    v_q := p_qty;
  end if;
  update app.stock_items set qty_reserved = qty_reserved + v_q where id = p_stock;
  insert into app.stock_holds (org_id, stock_item_id, qty, whole, reason, proof, created_by) values (v_org, p_stock, v_q, v_whole, trim(p_reason), p_proof, app.uid()) returning id into v_id;
  perform app.audit(v_org, 'freeze_stock', 'stock_holds', v_id, jsonb_build_object('qty', v_q, 'whole', v_whole, 'reason', p_reason));
  return v_id;
end $$;

create or replace function app.close_stock_hold(p_id uuid, p_action text, p_note text, p_proof text)
returns void language plpgsql security definer set search_path = app, public as $$
declare h app.stock_holds; s app.stock_items; v_pending uuid;
begin
  select * into h from app.stock_holds where id = p_id for update;
  if h.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(h.org_id, 'manager');
  if h.status <> 'active' then raise exception 'BAD_STATE: 这条冻结已经处理过了'; end if;
  if coalesce(p_action, '') not in ('release','to_pending') then raise exception 'VALIDATION: 选解冻还是转待检仓'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 写评估结论'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传凭证（解冻 = 检测 / 升级完成的照片；转待检仓 = 货已搬到待检仓的照片）'; end if;
  select * into s from app.stock_items where id = h.stock_item_id for update;
  update app.stock_items set qty_reserved = greatest(qty_reserved - h.qty, 0) where id = h.stock_item_id;
  if p_action = 'to_pending' and h.qty > 0 then
    v_pending := app.stock_row(h.org_id, 'pending', s.product_id);
    perform app.move_stock(h.stock_item_id, -h.qty, 'hold_to_pending', 'stock_hold', h.id);
    perform app.move_stock(v_pending, h.qty, 'hold_to_pending', 'stock_hold', h.id);
  end if;
  update app.stock_holds set status = case when p_action = 'release' then 'released' else 'moved' end, closed_by = app.uid(), closed_at = now(), close_note = trim(p_note), close_proof = p_proof where id = p_id;
  perform app.audit(h.org_id, 'close_stock_hold', 'stock_holds', p_id, jsonb_build_object('action', p_action, 'note', p_note, 'qty', h.qty));
end $$;

-- 整个编码暂停时: 已经预占给订单的也不许出库
create or replace function app.ship_hold_block() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_stock uuid; v_reason text;
begin
  select stock_item_id into v_stock from app.deal_lines where id = new.deal_line_id;
  select reason into v_reason from app.stock_holds where stock_item_id = v_stock and status = 'active' and whole limit 1;
  if v_reason is not null then raise exception 'BAD_STATE: 这个货已经暂停出库（%），中方解冻之前不能发', v_reason; end if;
  return new;
end $$;
create trigger ship_hold_block before insert on app.shipment_lines for each row execute function app.ship_hold_block();

-- ───────────────────────── ④ 申请定级 ─────────────────────────
alter table app.customers add column tier_requested_at timestamptz, add column tier_requested_by uuid, add column tier_request_note text, add column tier_request_deal uuid;
create or replace function app.request_tier(p_customer uuid, p_deal uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.is_member(c.org_id) then raise exception 'FORBIDDEN'; end if;
  if c.tier_confirmed_at is not null then raise exception 'BAD_STATE: 这个客户的档位已经确认过了'; end if;
  update app.customers set tier_requested_at = now(), tier_requested_by = app.uid(), tier_request_note = nullif(trim(coalesce(p_note, '')), ''), tier_request_deal = p_deal where id = p_customer;
  if p_deal is not null then perform app.deal_event(p_deal, 'tier_requested', jsonb_build_object('note', p_note)); end if;
end $$;

-- 档位没经中方确认: 报价只能停在草稿, 不能确认 / 下推
create or replace function app.deal_tier_gate() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if old.status = 'quoted' and new.status in ('hotline_ok','picking') and new.kind = 'normal'
     and exists (select 1 from app.customers c where c.id = new.customer_id and c.tier_confirmed_at is null) then
    raise exception 'BAD_STATE: 这个客户的档位中方还没确认，报价先存着（草稿）。点「申请定级」，中方定了再发给客户';
  end if;
  return new;
end $$;
create trigger deal_tier_gate before update of status on app.deals for each row execute function app.deal_tier_gate();

-- 中方定档 (或改档) → 这个客户还在报价阶段的单按新档位重算价 (手改 / 锁价的行不动), 清掉申请
create or replace function app.customer_tier_applied() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  if new.tier_confirmed_at is not null and (old.tier_confirmed_at is null or new.tier is distinct from old.tier) then
    for d in select * from app.deals where customer_id = new.id and status = 'quoted' and kind = 'normal' loop
      update app.deal_lines l set unit_price = coalesce(app.deal_price(d, l.product_id), l.unit_price)
      where l.deal_id = d.id and l.product_id is not null and not coalesce(l.price_manual, false) and not l.price_locked;
      perform app.deal_event(d.id, 'tier_confirmed', jsonb_build_object('tier', new.tier));
    end loop;
    if new.tier_requested_at is not null then
      update app.customers set tier_requested_at = null, tier_request_note = null, tier_request_deal = null where id = new.id;
    end if;
  end if;
  return null;
end $$;
create trigger customer_tier_applied after update of tier, tier_confirmed_at on app.customers for each row execute function app.customer_tier_applied();

-- ⑩ 草稿 (等定档的报价) 放太久自动作废, 作废的单本来就能恢复
create or replace function app.void_stale_drafts(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare d record; n int := 0; v_days int;
begin
  if not app.is_member(p_org) then raise exception 'FORBIDDEN'; end if;
  v_days := coalesce((select (value->>'days')::int from app.org_settings where org_id = p_org and key = 'draft_rules'), 7);
  for d in select x.id from app.deals x join app.customers c on c.id = x.customer_id
           where x.org_id = p_org and x.status = 'quoted' and x.kind = 'normal' and c.tier_confirmed_at is null
             and greatest(x.created_at, coalesce((select max(e.at) from app.deal_events e where e.deal_id = x.id), x.created_at)) < now() - make_interval(days => v_days) loop
    update app.deals set status = 'cancelled' where id = d.id;
    perform app.deal_event(d.id, 'cancelled', jsonb_build_object('reason', '草稿超过 ' || v_days || ' 天没人动，系统自动作废（可恢复）', 'auto', true));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ───────────────────────── ⑤ 发错记责 + 仓库提成 ─────────────────────────
alter table app.receipt_discrepancies add column blame_employee_id uuid references app.employees(id);
create or replace function app.disc_blame() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  if new.status = 'decided' and old.status <> 'decided' and new.decision in ('credit','reship') and new.amount >= 0 then
    select * into d from app.deals where id = new.deal_id;
    if new.fault like '复检%' then new.blame_employee_id := d.reviewer_employee_id;
    elsif new.fault like '找货%' then new.blame_employee_id := d.picker_employee_id; end if;
  end if;
  return new;
end $$;
create trigger disc_blame before update of status on app.receipt_discrepancies for each row execute function app.disc_blame();

-- 仓库提成: 按【正确出货】的片数算给复核人 (没有复核人就给找货人); 这张单被记了发错的责任 → 这张单的提成取消
create or replace view app.v_wh_commission as
select d.org_id, d.id as deal_id, d.biz_no, coalesce(d.reviewer_employee_id, d.picker_employee_id) as employee_id,
       to_char(min(s.shipped_at), 'YYYY-MM') as month,
       sum(sl.qty)::int as pieces,
       exists (select 1 from app.receipt_discrepancies r where r.deal_id = d.id and r.status = 'decided' and r.decision in ('credit','reship') and r.amount >= 0
               and r.blame_employee_id is not null and r.blame_employee_id = coalesce(d.reviewer_employee_id, d.picker_employee_id)
               and coalesce((select sum(r2.amount) from app.receipt_discrepancies r2 where r2.deal_id = d.id and r2.status = 'decided' and r2.decision = 'credit'), 1) > 0) as voided
from app.deals d join app.shipments s on s.deal_id = d.id and s.voided_at is null join app.shipment_lines sl on sl.shipment_id = s.id
where coalesce(d.reviewer_employee_id, d.picker_employee_id) is not null
group by d.org_id, d.id, d.biz_no, d.reviewer_employee_id, d.picker_employee_id;
grant select on app.v_wh_commission to authenticated;

-- ───────────────────────── ⑥ 指令: 附件 + 迟收到写原因 ─────────────────────────
alter table app.directives add column attachments jsonb not null default '[]', add column ack_reason text, add column done_files jsonb not null default '[]';
create or replace function app.issue_directive(p_org uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_allow boolean;
begin
  v_allow := coalesce((select (value->>'manager_can_issue')::boolean from app.org_settings where org_id = p_org and key = 'directive_rules'), false);
  if v_allow then perform app.require_role(p_org, 'manager'); else perform app.require_role(p_org, 'admin'); end if;
  if coalesce(trim(p->>'title'), '') = '' then raise exception 'VALIDATION: 写清楚要做什么'; end if;
  if nullif(p->>'assignee', '') is null or not exists (select 1 from app.employees where id = (p->>'assignee')::uuid and org_id = p_org) then raise exception 'VALIDATION: 选给谁'; end if;
  if nullif(p->>'repeat', '') is not null and p->>'repeat' not in ('daily','weekly','monthly') then raise exception 'VALIDATION: 重复方式不对'; end if;
  insert into app.directives (org_id, title, body, urgent, require_photo, assignee_employee_id, due_on, repeat, is_template, created_by, attachments)
  values (p_org, trim(p->>'title'), nullif(trim(coalesce(p->>'body', '')), ''), coalesce((p->>'urgent')::boolean, false), coalesce((p->>'require_photo')::boolean, false),
    (p->>'assignee')::uuid, nullif(p->>'due_on', '')::date, nullif(p->>'repeat', ''), nullif(p->>'repeat', '') is not null, app.uid(),
    case when jsonb_typeof(p->'attachments') = 'array' then p->'attachments' else '[]'::jsonb end)
  returning id into v_id;
  perform app.audit(p_org, 'issue_directive', 'directives', v_id, p - 'attachments');
  return v_id;
end $$;
-- 超过时限才点收到 → 必须写原因 (时限: org_settings directive_rules.ack_minutes, 默认 5 分钟)
create or replace function app.ack_directive2(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = app, public as $$
declare d app.directives; v_min numeric;
begin
  select * into d from app.directives where id = p_id for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.directive_mine(p_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的'; end if;
  if d.status <> 'sent' then return; end if;
  v_min := coalesce((select (value->>'ack_minutes')::numeric from app.org_settings where org_id = d.org_id and key = 'directive_rules'), 5);
  if now() - d.created_at > make_interval(mins => v_min::int) and coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION: 超过 % 分钟才收到，要写原因', v_min::int; end if;
  update app.directives set status = 'acked', ack_at = now(), ack_reason = nullif(trim(coalesce(p_reason, '')), '') where id = p_id;
end $$;
create or replace function app.directive_done_files(p_id uuid, p_files jsonb) returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.directive_mine(p_id) then raise exception 'PERMISSION_DENIED: 这条指令不是给你的'; end if;
  update app.directives set done_files = case when jsonb_typeof(p_files) = 'array' then p_files else '[]'::jsonb end where id = p_id and status in ('sent','acked');
end $$;

-- ───────────────────────── ⑦ 热线: 打电话名单 ─────────────────────────
create table app.call_lists (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references app.orgs(id),
  title text not null check (length(trim(title)) > 0), note text, assignee_employee_id uuid references app.employees(id),
  created_by uuid, created_at timestamptz not null default now(), closed_at timestamptz
);
create table app.call_list_rows (
  id uuid primary key default gen_random_uuid(), list_id uuid not null references app.call_lists(id) on delete cascade, seq int not null,
  name text, phone text, city text, note text,
  result text check (result in ('yes','no','no_answer','wrong_number','later')), result_note text, called_at timestamptz, called_by uuid,
  customer_id uuid references app.customers(id)
);
create index on app.call_list_rows (list_id, seq);
alter table app.call_lists enable row level security; alter table app.call_list_rows enable row level security;
create policy call_lists_read on app.call_lists for select using (app.is_member(org_id));
create policy call_list_rows_read on app.call_list_rows for select using (exists (select 1 from app.call_lists l where l.id = list_id and app.is_member(l.org_id)));

create or replace function app.create_call_list(p_org uuid, p_title text, p_assignee uuid, p_note text, p_rows jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; x jsonb; i int := 0;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_title), '') = '' then raise exception 'VALIDATION: 给名单起个名字'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'VALIDATION: 名单是空的'; end if;
  insert into app.call_lists (org_id, title, note, assignee_employee_id, created_by) values (p_org, trim(p_title), nullif(trim(coalesce(p_note, '')), ''), p_assignee, app.uid()) returning id into v_id;
  for x in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(x->>'name'), '') = '' and coalesce(trim(x->>'phone'), '') = '' then continue; end if;
    i := i + 1;
    insert into app.call_list_rows (list_id, seq, name, phone, city, note) values (v_id, i, nullif(trim(x->>'name'), ''), nullif(trim(x->>'phone'), ''), nullif(trim(x->>'city'), ''), nullif(trim(x->>'note'), ''));
  end loop;
  if i = 0 then raise exception 'VALIDATION: 名单里没有能用的行（至少要有名字或电话）'; end if;
  return v_id;
end $$;
create or replace function app.set_call_result(p_row uuid, p_result text, p_note text) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select l.org_id into v_org from app.call_list_rows r join app.call_lists l on l.id = r.list_id where r.id = p_row;
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'hotline', 'manager', 'sales', 'sales_manager', 'picker');
  if coalesce(p_result, '') not in ('yes','no','no_answer','wrong_number','later') then raise exception 'VALIDATION: 选打电话的结果'; end if;
  update app.call_list_rows set result = p_result, result_note = nullif(trim(coalesce(p_note, '')), ''), called_at = now(), called_by = app.uid() where id = p_row;
end $$;
create or replace function app.call_row_to_prospect(p_row uuid) returns uuid language plpgsql security definer set search_path = app, public as $$
declare r app.call_list_rows; v_org uuid; v_id uuid;
begin
  select * into r from app.call_list_rows where id = p_row for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  select org_id into v_org from app.call_lists where id = r.list_id;
  perform app.require_role(v_org, 'admin');
  if r.customer_id is not null then return r.customer_id; end if;
  if coalesce(r.name, '') = '' then raise exception 'VALIDATION: 这一行没有名字，先补上名字'; end if;
  v_id := app.create_prospect(v_org, r.name, r.phone, r.city, jsonb_build_object('note', '来自打电话名单：' || coalesce(r.result_note, '')));
  update app.call_list_rows set customer_id = v_id where id = p_row;
  return v_id;
end $$;
create or replace function app.close_call_list(p_id uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.call_lists where id = p_id; perform app.require_role(v_org, 'admin');
  update app.call_lists set closed_at = coalesce(closed_at, now()) where id = p_id;
end $$;

-- ───────────────────────── ⑧ 价格调整单 (出库后原单不直接改) ─────────────────────────
create table app.price_adjustments (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references app.orgs(id), deal_id uuid not null references app.deals(id),
  amount numeric(18,2) not null check (amount <> 0),     -- 正 = 客户要多付, 负 = 给客户减
  reason text not null, proof text not null, created_by uuid, created_at timestamptz not null default now()
);
alter table app.price_adjustments enable row level security;
create policy price_adjustments_read on app.price_adjustments for select using (app.is_member(org_id));
create or replace function app.adjust_price(p_deal uuid, p_amount numeric, p_reason text, p_proof text)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_id uuid;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'admin');
  if d.status not in ('partial','shipped') then raise exception 'BAD_STATE: 还没出库的单直接改销售订单，不用调整单'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'VALIDATION: 填调整多少（多收填正数，少收填负数）'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 写调整原因'; end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 要传凭证（客户同意的截图）'; end if;
  insert into app.price_adjustments (org_id, deal_id, amount, reason, proof, created_by) values (d.org_id, p_deal, p_amount, trim(p_reason), p_proof, app.uid()) returning id into v_id;
  insert into app.ar_entries (org_id, customer_id, currency, kind, amount, deal_id, ref_id, note)
  values (d.org_id, d.customer_id, d.currency, 'adjust', p_amount, p_deal, v_id, '价格调整：' || trim(p_reason));
  perform app.deal_event(p_deal, 'price_adjusted', jsonb_build_object('amount', p_amount, 'reason', p_reason));
  return v_id;
end $$;

-- ───────────────────────── ⑨ 找货人和复核人不能是同一个人 ─────────────────────────
create or replace function app.reviewer_not_picker() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.reviewer_employee_id is not null and new.reviewer_employee_id = new.picker_employee_id and new.reviewer_employee_id is distinct from old.reviewer_employee_id
     and not app.has_role(new.org_id, array['admin']::app.role_name[]) then
    raise exception 'VALIDATION: 找货人和复核人不能是同一个人（发错货要过两个人的手）。只有一个仓管在岗时，让中方来复检';
  end if;
  return new;
end $$;
create trigger reviewer_not_picker before update of reviewer_employee_id on app.deals for each row execute function app.reviewer_not_picker();

revoke all on function app.record_ship_freight(uuid, text, numeric, text), app.freeze_stock(uuid, int, text, text), app.close_stock_hold(uuid, text, text, text),
  app.request_tier(uuid, uuid, text), app.void_stale_drafts(uuid), app.ack_directive2(uuid, text), app.directive_done_files(uuid, jsonb),
  app.create_call_list(uuid, text, uuid, text, jsonb), app.set_call_result(uuid, text, text), app.call_row_to_prospect(uuid), app.close_call_list(uuid),
  app.adjust_price(uuid, numeric, text, text) from public;
grant execute on function app.record_ship_freight(uuid, text, numeric, text), app.freeze_stock(uuid, int, text, text), app.close_stock_hold(uuid, text, text, text),
  app.request_tier(uuid, uuid, text), app.void_stale_drafts(uuid), app.ack_directive2(uuid, text), app.directive_done_files(uuid, jsonb),
  app.create_call_list(uuid, text, uuid, text, jsonb), app.set_call_result(uuid, text, text), app.call_row_to_prospect(uuid), app.close_call_list(uuid),
  app.adjust_price(uuid, numeric, text, text) to authenticated;
grant select on app.stock_holds, app.call_lists, app.call_list_rows, app.price_adjustments to authenticated;
