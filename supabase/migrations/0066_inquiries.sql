-- 0066 (Frank 11-18 391–394, 方案见 docs/整合方案-接单询单账号.md): 询单 = 没有定价权的人的统一前门
-- 游客 / 客户账号 / 外跑销售 → 询单 (IQ-年月日-序号, 不带价) → 中方看一眼定价 → 转成报价 (CI-…) → 后面流程不变.
-- 销售对自己名下的客户可以: 确认客户 / 下推找货 / 发销售单给客户确认 (别人的客户只看不接).
-- 客户归属: 一键移交 + 归属历史.

-- ───────────────────────── ① 询单 ─────────────────────────
create table app.inquiries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  iq_no text not null,
  source text not null check (source in ('guest', 'customer', 'staff')),
  customer_id uuid references app.customers(id),
  guest_info jsonb,                           -- 游客: { phone, shop, city, contact, sales_id }
  lines jsonb not null,                       -- [{ product_id, qty } | { category_id, model, grade, qty, note }]
  note text,
  status text not null default 'new' check (status in ('new', 'contacted', 'quoted', 'converted', 'lost')),
  deal_id uuid references app.deals(id),
  lost_reason text,
  owner_employee_id uuid references app.employees(id),     -- 跟这张询单的销售 (建单的销售 / 客户的归属销售 / 游客选的销售)
  created_by uuid, created_at timestamptz not null default now(),
  contacted_by uuid, contacted_at timestamptz,
  quoted_by uuid, quoted_at timestamptz,
  closed_by uuid, closed_at timestamptz,
  seen_at timestamptz,                         -- 建单的人看过「价格出来了」
  unique (org_id, iq_no)
);
create index on app.inquiries (org_id, status, created_at desc);
create index on app.inquiries (customer_id);
alter table app.inquiries enable row level security;
create policy read_own on app.inquiries for select using (app.is_member(org_id) or customer_id = (select customer_id from app.portal_me()));
grant select on app.inquiries to authenticated;

-- 询单号: IQ-年月日-两位序号 (和订单号一个写法)
create or replace function app.next_iq_no(p_org uuid) returns text language plpgsql security definer set search_path = app, public as $$
declare v_day text := to_char(now(), 'YYMMDD'); n int;
begin
  perform pg_advisory_xact_lock(hashtext('iq:' || p_org::text || v_day));
  select count(*) + 1 into n from app.inquiries where org_id = p_org and iq_no like 'IQ-' || v_day || '-%';
  return 'IQ-' || v_day || '-' || lpad(n::text, 2, '0');
end $$;

create or replace function app.clean_inq_lines(p_lines jsonb) returns jsonb language plpgsql immutable as $$
declare x jsonb; o jsonb := '[]';
begin
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    if coalesce((x->>'qty')::int, 0) <= 0 then continue; end if;
    if nullif(x->>'product_id', '') is not null then
      o := o || jsonb_build_array(jsonb_build_object('product_id', x->>'product_id', 'qty', (x->>'qty')::int, 'note', nullif(trim(coalesce(x->>'note', '')), '')));
    elsif coalesce(trim(x->>'model'), '') <> '' then
      o := o || jsonb_build_array(jsonb_build_object('category_id', nullif(x->>'category_id', ''), 'model', upper(trim(x->>'model')), 'grade', nullif(trim(coalesce(x->>'grade', '')), ''),
        'qty', (x->>'qty')::int, 'note', nullif(trim(coalesce(x->>'note', '')), '')));
    end if;
  end loop;
  if jsonb_array_length(o) = 0 then raise exception 'VALIDATION: 请先选型号和数量'; end if;
  return o;
end $$;

-- 员工建询单: 销售只能给自己名下的客户 (或自己建的潜客) 建; 主管 / 热线 / 中方不限
create or replace function app.submit_inquiry(p_org uuid, p_customer uuid, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; me uuid := app.current_employee(p_org); v_id uuid;
begin
  perform app.require_role(p_org, 'sales', 'sales_manager', 'hotline', 'manager');
  select * into c from app.customers where id = p_customer and org_id = p_org;
  if not found then raise exception 'NOT_FOUND: 先选客户'; end if;
  if not app.has_role(p_org, array['admin','manager','sales_manager','hotline']::app.role_name[]) and me is not null
     and c.owner_employee_id is distinct from me and not (c.status = 'prospect' and c.owner_employee_id is null) then
    raise exception 'PERMISSION_DENIED: 这个客户不在你名下，只能看不能接单；要接请中方把客户划给你';
  end if;
  insert into app.inquiries (org_id, iq_no, source, customer_id, lines, note, owner_employee_id, created_by)
  values (p_org, app.next_iq_no(p_org), 'staff', p_customer, app.clean_inq_lines(p_lines), nullif(trim(coalesce(p_note, '')), ''), coalesce(me, c.owner_employee_id), app.uid())
  returning id into v_id;
  return v_id;
end $$;

-- 客户账号 (老板 / 店员) 建询单
create or replace function app.portal_inquiry(p_lines jsonb, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare me record; c app.customers; v_no text;
begin
  select * into me from app.portal_me();
  if me.customer_id is null then raise exception 'PERMISSION_DENIED: 这个账号没有绑定客户'; end if;
  select * into c from app.customers where id = me.customer_id;
  if c.status <> 'active' then raise exception 'VALIDATION: 客户还没开通'; end if;
  v_no := app.next_iq_no(c.org_id);
  insert into app.inquiries (org_id, iq_no, source, customer_id, lines, note, owner_employee_id, created_by)
  values (c.org_id, v_no, 'customer', c.id, app.clean_inq_lines(p_lines), nullif(trim(coalesce(p_note, '')), ''), c.owner_employee_id, app.uid());
  return v_no;
end $$;

-- 游客建询单: 只留信息、不建客户也不建单 (中方转报价时才建潜客); 同一个号码 10 分钟 3 次
create or replace function app.guest_inquiry2(p_org uuid, p_info jsonb, p_lines jsonb, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare v_phone text := regexp_replace(coalesce(p_info->>'phone', ''), '\D', '', 'g'); v_sales uuid := nullif(p_info->>'sales_id', '')::uuid; v_no text; v_cust uuid;
begin
  if length(v_phone) < 8 then raise exception 'VALIDATION: 请填正确的电话 / WhatsApp 号码'; end if;
  if coalesce(trim(p_info->>'contact'), '') = '' then raise exception 'VALIDATION: 请填怎么称呼你'; end if;
  if v_sales is not null and not exists (select 1 from app.employees where id = v_sales and org_id = p_org and active) then v_sales := null; end if;
  if (select count(*) from app.inquiries where org_id = p_org and source = 'guest' and regexp_replace(coalesce(guest_info->>'phone', ''), '\D', '', 'g') = v_phone and created_at > now() - interval '10 minutes') >= 3 then
    raise exception 'VALIDATION: 提交太频繁了，请稍后再试，或直接联系销售员';
  end if;
  select id into v_cust from app.customers where org_id = p_org and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone limit 1;   -- 老客户的号码 → 直接挂上
  v_no := app.next_iq_no(p_org);
  insert into app.inquiries (org_id, iq_no, source, customer_id, guest_info, lines, note, owner_employee_id)
  values (p_org, v_no, 'guest', v_cust, p_info, app.clean_inq_lines(p_lines), nullif(trim(coalesce(p_note, '')), ''),
    coalesce((select owner_employee_id from app.customers where id = v_cust), v_sales));
  return v_no;
end $$;

-- 中方: 转成报价 (游客先建潜客; 价格按档位 / 促销价自动带, p_prices 里给了的按中方给的)
-- p_prices: [{ idx, price, note }] idx = 询单里第几行 (从 0)
create or replace function app.inquiry_convert(p_inq uuid, p_prices jsonb default '[]', p_tier text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare q app.inquiries; c app.customers; d app.deals; x jsonb; v_lines jsonb := '[]'; l record; i int := 0; pr jsonb;
begin
  select * into q from app.inquiries where id = p_inq for update;
  if q.id is null then raise exception 'NOT_FOUND: 询单不存在'; end if;
  perform app.require_role(q.org_id, 'admin');
  if q.status not in ('new', 'contacted') then raise exception 'BAD_STATE: 这张询单已经处理过了'; end if;
  if q.customer_id is null then
    insert into app.customers (org_id, temp_code, name, city, status, phone, source, owner_employee_id, kind, shop_name, note, contact_name)
    values (q.org_id, app.next_doc_no(q.org_id, 'T'), upper(coalesce(nullif(trim(q.guest_info->>'shop'), ''), trim(q.guest_info->>'contact'))), nullif(trim(coalesce(q.guest_info->>'city', '')), ''),
      'prospect', trim(q.guest_info->>'phone'), 'guest', q.owner_employee_id, 'spare', upper(nullif(trim(coalesce(q.guest_info->>'shop', '')), '')), '游客询单 ' || q.iq_no, trim(q.guest_info->>'contact'))
    returning * into c;
    update app.inquiries set customer_id = c.id where id = p_inq;
  else
    select * into c from app.customers where id = q.customer_id;
  end if;
  for x in select * from jsonb_array_elements(q.lines) loop
    if x ? 'product_id' then v_lines := v_lines || jsonb_build_array(jsonb_build_object('product_id', x->>'product_id', 'qty_req', (x->>'qty')::int));
    else v_lines := v_lines || jsonb_build_array(jsonb_build_object('req_category_id', x->>'category_id', 'req_model', concat_ws(' ', x->>'model', x->>'grade'), 'qty_req', (x->>'qty')::int)); end if;
  end loop;
  insert into app.deals (org_id, biz_no, quote_no, customer_id, currency, owner_employee_id, note, created_by, source, guest_info)
  values (q.org_id, app.next_doc_no(q.org_id, 'BIZ'), app.next_doc_no(q.org_id, 'QT'), c.id, 'XOF', coalesce(c.owner_employee_id, q.owner_employee_id),
    concat_ws(' · ', '询单 ' || q.iq_no, q.note), app.uid(), case q.source when 'guest' then 'guest' when 'customer' then 'portal' else 'staff' end, q.guest_info)
  returning * into d;
  perform app.write_lines(d, v_lines);
  for l in select id from app.deal_lines where deal_id = d.id order by seq loop
    select e into pr from jsonb_array_elements(coalesce(p_prices, '[]')) e where (e->>'idx')::int = i;
    if pr is not null and nullif(pr->>'price', '') is not null then
      perform app.set_line_price(l.id, (pr->>'price')::numeric, coalesce(nullif(pr->>'note', ''), '询单定价'));
    end if;
    i := i + 1; pr := null;
  end loop;
  perform app.deal_event(d.id, 'quote_created', jsonb_build_object('source', 'inquiry', 'iq_no', q.iq_no, 'lines', jsonb_array_length(v_lines)));
  perform app.evaluate_approval(d.id);
  update app.inquiries set status = 'quoted', deal_id = d.id, quoted_by = app.uid(), quoted_at = now() where id = p_inq;
  return d.id;
end $$;

-- 标记已联系 / 没成交 (没成交必须选原因)
create or replace function app.inquiry_mark(p_inq uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare q app.inquiries;
begin
  select * into q from app.inquiries where id = p_inq for update;
  if q.id is null then raise exception 'NOT_FOUND: 询单不存在'; end if;
  perform app.require_role(q.org_id, 'sales', 'sales_manager', 'hotline', 'manager');
  if p_status = 'contacted' then
    if q.status <> 'new' then raise exception 'BAD_STATE: 只有新询单能标「已联系」'; end if;
    update app.inquiries set status = 'contacted', contacted_by = app.uid(), contacted_at = now() where id = p_inq;
  elsif p_status = 'lost' then
    if q.status in ('converted', 'lost') then raise exception 'BAD_STATE: 这张询单已经结束了'; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 没成交要选原因'; end if;
    update app.inquiries set status = 'lost', lost_reason = trim(p_reason), closed_by = app.uid(), closed_at = now() where id = p_inq;
  elsif p_status = 'seen' then
    update app.inquiries set seen_at = now() where id = p_inq and seen_at is null;
  else raise exception 'VALIDATION: 不认识的状态';
  end if;
end $$;

-- 订单往下走 → 询单自动变「已转订单」; 订单作废 → 询单「没成交」
create or replace function app.trg_inquiry_follow() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('picking', 'picked', 'ordered', 'confirmed', 'reviewed', 'partial', 'shipped') then
      update app.inquiries set status = 'converted', closed_at = coalesce(closed_at, now()) where deal_id = new.id and status = 'quoted';
    elsif new.status = 'cancelled' then
      update app.inquiries set status = 'lost', lost_reason = coalesce(lost_reason, '订单作废'), closed_at = now() where deal_id = new.id and status in ('quoted', 'converted');
    end if;
  end if;
  return null;
end $$;
create trigger inquiry_follow after update of status on app.deals for each row execute function app.trg_inquiry_follow();

-- ───────────────────────── ② 看库存 / 看价格 ─────────────────────────
-- 客户账号两个开关 (默认: 老板看具体库存 + 看自己的价; 店员看库存不看价)
alter table app.customers add column portal_opts jsonb not null default '{}';
create or replace function app.set_portal_opts(p_customer uuid, p jsonb) returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND: 客户不存在'; end if;
  perform app.require_role(c.org_id, 'admin');
  update app.customers set portal_opts = portal_opts || p where id = p_customer;
  perform app.audit(c.org_id, 'set_portal_opts', 'customers', p_customer, p);
end $$;

-- 询单页的货: 一张表给三种人, 内容多少不同.
--   员工: 具体可售片数 + 可预订片数 (在途), 不带价.
--   客户账号: 开了「看库存」给片数, 没开给 有货 / 少量 / 可预订; 开了「看价格」给他自己的价 (档位价 / 促销价, 只有他这一档).
--   游客: 只有 有货 / 少量 / 可预订. 「少量」的线 = 规则参数 guest_rules.low (默认 50).
create or replace function app.inquiry_catalog(p_org uuid)
returns table (id uuid, code text, category_id uuid, category text, cat_sort int, model text, variant text, shared_models text[], band text, avail int, transit int, price numeric)
language plpgsql stable security definer set search_path = app, public as $$
declare me record; v_staff boolean := exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active and not (m.roles <@ array['boss','clerk']::app.role_name[]));
  v_cust uuid; v_stock boolean := false; v_price boolean := false; v_low int;
begin
  select coalesce((value->>'low')::int, 50) into v_low from app.org_settings where org_id = p_org and key = 'guest_rules';
  v_low := coalesce(v_low, 50);
  if not v_staff and app.uid() is not null then
    select * into me from app.portal_me();
    if me.customer_id is not null and me.hq_org = p_org then
      v_cust := me.customer_id;
      select coalesce((portal_opts->>'stock')::boolean, true), case when me.role = 'boss' then coalesce((portal_opts->>'price')::boolean, true) else coalesce((portal_opts->>'clerk_price')::boolean, false) end
        into v_stock, v_price from app.customers where customers.id = v_cust;
    end if;
  end if;
  return query
  select p.id, p.code, p.category_id, c.name, c.sort, p.model, p.variant, p.shared_models,
    case when s.a >= v_low then 'ok' when s.a > 0 then 'low' when t.r > 0 then 'preorder' else 'none' end,
    case when v_staff or v_stock then s.a::int else null end,
    case when v_staff or v_stock then t.r::int else null end,
    case when v_price and v_cust is not null then app.tier_price(p.id, v_cust, 'XOF') else null end
  from app.products p join app.categories c on c.id = p.category_id
  left join lateral (select coalesce(sum(si.qty_on_hand - si.qty_reserved), 0) as a from app.stock_items si join app.warehouses w on w.id = si.warehouse_id where si.product_id = p.id and w.kind = 'local') s on true
  left join lateral (select coalesce(sum(it.remaining - it.fob_remaining), 0) as r from app.v_in_transit it where it.product_id = p.id) t on true
  where p.org_id = p_org and p.active;
end $$;

-- ───────────────────────── ③ 销售对自己名下的客户能接着往下做 ─────────────────────────
-- 「确认客户 / 下推找货 / 客户确认销售单」原来只有热线 / 主管: 把销售加进去, 再用一个触发器卡住「只能动自己名下客户的单」
do $$
declare r record; d text; n text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'app' and p.proname in ('quote_confirm', 'start_picking', 'customer_confirm', 'hotline_busy', 'mark_staged') loop
    d := pg_get_functiondef(r.oid);
    if d ~ $re$require_role\(d\.org_id,[^)]*'sales'\s*[,)]$re$ then continue; end if;
    n := regexp_replace(d, $re$(perform app\.require_role\(d\.org_id,[^)]*)\)$re$, $x$\1, 'sales')$x$);
    if n <> d then execute n; end if;
  end loop;
end $$;

create or replace function app.trg_sales_own_only() returns trigger language plpgsql security definer set search_path = app, public as $$
declare me uuid;
begin
  if new.status is not distinct from old.status or app.uid() is null then return new; end if;
  if not app.has_role(new.org_id, array['sales']::app.role_name[]) or app.has_role(new.org_id, array['admin','manager','sales_manager','hotline','picker','finance']::app.role_name[]) then return new; end if;
  me := app.current_employee(new.org_id);
  if me is not null and new.owner_employee_id is distinct from me then
    raise exception 'PERMISSION_DENIED: 这个客户不在你名下，这张单只能看不能动';
  end if;
  return new;
end $$;
create trigger sales_own_only before update of status on app.deals for each row execute function app.trg_sales_own_only();

-- ───────────────────────── ④ 客户归属: 历史 + 一键移交 ─────────────────────────
create table app.customer_owner_log (
  id bigint generated always as identity primary key,
  org_id uuid not null, customer_id uuid not null references app.customers(id) on delete cascade,
  from_employee_id uuid, to_employee_id uuid, note text, by_user uuid, at timestamptz not null default now()
);
create index on app.customer_owner_log (customer_id, at);
alter table app.customer_owner_log enable row level security;
create policy read_own on app.customer_owner_log for select using (app.is_member(org_id));
grant select on app.customer_owner_log to authenticated;

create or replace function app.trg_owner_log() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.owner_employee_id is distinct from old.owner_employee_id then
    insert into app.customer_owner_log (org_id, customer_id, from_employee_id, to_employee_id, note, by_user)
    values (new.org_id, new.id, old.owner_employee_id, new.owner_employee_id, nullif(current_setting('app.owner_note', true), ''), app.uid());
  end if;
  return null;
end $$;
create trigger owner_log after update of owner_employee_id on app.customers for each row execute function app.trg_owner_log();

-- 移交: p_ids 不给 = 这个人名下全部; p_to 不给 = 放进「待认领」(无归属). 提成照旧按出库那一刻的归属人算, 历史单不动.
create or replace function app.transfer_customers(p_org uuid, p_from uuid, p_to uuid, p_ids uuid[] default null, p_note text default null)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int;
begin
  perform app.require_role(p_org, 'admin');
  if p_from is null then raise exception 'VALIDATION: 选从谁名下移交'; end if;
  if p_to is not null and not exists (select 1 from app.employees where id = p_to and org_id = p_org and active) then raise exception 'VALIDATION: 接手的人要是在职员工'; end if;
  if p_to = p_from then raise exception 'VALIDATION: 不能移交给自己'; end if;
  perform set_config('app.owner_note', coalesce(nullif(trim(coalesce(p_note, '')), ''), '移交客户'), true);
  update app.customers set owner_employee_id = p_to, updated_at = now()
   where org_id = p_org and owner_employee_id = p_from and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  -- 还没结束的询单跟着走
  update app.inquiries set owner_employee_id = p_to where org_id = p_org and owner_employee_id = p_from and status in ('new', 'contacted', 'quoted') and (p_ids is null or customer_id = any(p_ids));
  perform app.audit(p_org, 'transfer_customers', 'employees', p_from, jsonb_build_object('to', p_to, 'n', n, 'note', p_note));
  return n;
end $$;

revoke all on function app.next_iq_no(uuid), app.clean_inq_lines(jsonb), app.submit_inquiry(uuid, uuid, jsonb, text), app.portal_inquiry(jsonb, text), app.guest_inquiry2(uuid, jsonb, jsonb, text),
  app.inquiry_convert(uuid, jsonb, text), app.inquiry_mark(uuid, text, text), app.set_portal_opts(uuid, jsonb), app.inquiry_catalog(uuid), app.transfer_customers(uuid, uuid, uuid, uuid[], text),
  app.trg_inquiry_follow(), app.trg_sales_own_only(), app.trg_owner_log() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.submit_inquiry(uuid, uuid, jsonb, text), app.portal_inquiry(jsonb, text), app.guest_inquiry2(uuid, jsonb, jsonb, text), app.inquiry_convert(uuid, jsonb, text),
      app.inquiry_mark(uuid, text, text), app.set_portal_opts(uuid, jsonb), app.inquiry_catalog(uuid), app.transfer_customers(uuid, uuid, uuid, uuid[], text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function app.guest_inquiry2(uuid, jsonb, jsonb, text), app.inquiry_catalog(uuid) to anon;
  end if;
end $$;
