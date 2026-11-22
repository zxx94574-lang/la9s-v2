-- 0078 想要 + 到货分配（Frank 11-22）
-- 不接预订：客户只登记「想要」（型号 + 大概多少）。想要有有效期（默认 14 天，want_rules.days），过期不再算。
-- 货到了：先出「还要吗」名单给热线（还要 / 不要了（找别人买了）/ 联系不上），只有「还要」的进分配；中方填每人分多少 → 生成热线电话名单。
-- 备货看三个数分开：实际卖出、下单时没供够的缺口、想要 × 客户兑现率（以前登记的想要最后真要了几成）。

create table app.wants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null references app.customers(id),
  product_id uuid references app.products(id),
  model text not null, category_id uuid references app.categories(id),
  qty int not null check (qty > 0),
  source text not null default 'manual' check (source in ('manual','order_short','inquiry','call')),
  deal_line_id uuid unique references app.deal_lines(id),
  note text,
  created_by uuid, created_at timestamptz not null default now(),
  expires_on date not null,
  status text not null default 'open' check (status in ('open','yes','no','no_answer','expired','allocated','cancelled')),
  checked_at timestamptz, checked_by uuid, check_note text,
  allocated_qty int, allocated_at timestamptz, allocated_by uuid, call_list_id uuid references app.call_lists(id)
);
create index on app.wants (org_id, status, product_id);
alter table app.wants enable row level security;
create policy wants_read on app.wants for select using (app.is_member(org_id));

create or replace function app.want_days(p_org uuid) returns int language sql stable security definer set search_path = app, public as $$
  select coalesce((select (value->>'days')::int from app.org_settings where org_id = p_org and key = 'want_rules'), 14)
$$;

-- 登记想要（热线 / 销售 / 主管 / 中方）
create or replace function app.add_want(p_customer uuid, p_product uuid, p_model text, p_qty int, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare c app.customers; p app.products; v_id uuid;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND: 客户'; end if;
  perform app.require_role(c.org_id, 'hotline', 'sales', 'manager', 'sales_manager');
  if coalesce(p_qty, 0) <= 0 then raise exception 'VALIDATION: 大概要多少'; end if;
  if p_product is not null then select * into p from app.products where id = p_product and org_id = c.org_id; end if;
  if p.id is null and coalesce(trim(p_model), '') = '' then raise exception 'VALIDATION: 选型号'; end if;
  insert into app.wants (org_id, customer_id, product_id, model, category_id, qty, source, note, created_by, expires_on)
  values (c.org_id, c.id, p.id, coalesce(p.model, upper(trim(p_model))), p.category_id, p_qty, 'manual', nullif(trim(coalesce(p_note, '')), ''), app.uid(),
    current_date + app.want_days(c.org_id))
  returning id into v_id;
  return v_id;
end $$;

-- 同步：下单时没供够的缺口自动变成想要；过期的标过期
create or replace function app.sync_wants(p_org uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int := 0;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  insert into app.wants (org_id, customer_id, product_id, model, category_id, qty, source, deal_line_id, note, expires_on, created_at)
  select d.org_id, d.customer_id, l.product_id, coalesce(p.model, l.req_model), coalesce(p.category_id, l.req_category_id),
    l.qty_req - l.qty_supply, 'order_short', l.id, d.biz_no || ' 没供够', (d.created_at::date + app.want_days(d.org_id)), d.created_at
  from app.deal_lines l join app.deals d on d.id = l.deal_id left join app.products p on p.id = l.product_id
  where d.org_id = p_org and d.kind = 'normal' and d.status not in ('quoted','hotline_ok','cancelled') and l.qty_req > l.qty_supply
    and not exists (select 1 from app.wants w where w.deal_line_id = l.id)
  on conflict (deal_line_id) do nothing;
  get diagnostics n = row_count;
  update app.wants set status = 'expired' where org_id = p_org and status = 'open' and expires_on < current_date;
  return n;
end $$;

-- 货到了：这个型号还开着的想要（给热线打电话问「还要吗」）
create or replace view app.v_open_wants as
select w.*, c.name as customer_name, coalesce(c.code, c.temp_code) as customer_code, c.phone, c.city, cat.name as category,
  (w.expires_on - current_date) as days_left,
  (select coalesce(sum(s.qty_on_hand - s.qty_reserved), 0) from app.stock_items s join app.warehouses wh on wh.id = s.warehouse_id
    where s.product_id = w.product_id and wh.kind = 'local') as avail
from app.wants w join app.customers c on c.id = w.customer_id left join app.categories cat on cat.id = w.category_id
where w.status in ('open','yes','no_answer');
alter view app.v_open_wants set (security_invoker = true);

create or replace function app.want_check(p_want uuid, p_result text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare w app.wants;
begin
  select * into w from app.wants where id = p_want for update;
  if w.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(w.org_id, 'hotline', 'sales', 'manager', 'sales_manager');
  if p_result not in ('yes','no','no_answer') then raise exception 'VALIDATION: 还要 / 不要了 / 联系不上'; end if;
  if w.status not in ('open','yes','no_answer') then raise exception 'BAD_STATE: 这条已经处理过了'; end if;
  if p_result = 'no' and coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 不要了写一句为什么（找别人买了 / 不做这个型号了…）'; end if;
  update app.wants set status = p_result, checked_at = now(), checked_by = app.uid(), check_note = nullif(trim(coalesce(p_note, '')), '') where id = p_want;
end $$;

-- 中方分配：[{want_id, qty}] → 生成热线电话名单
create or replace function app.allocate_wants(p_org uuid, p_rows jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare x jsonb; w record; v_rows jsonb := '[]'; v_list uuid; v_hot uuid;
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    continue when coalesce((x->>'qty')::int, 0) <= 0;
    select w2.*, c.name, c.phone, c.city into w from app.wants w2 join app.customers c on c.id = w2.customer_id where w2.id = (x->>'want_id')::uuid and w2.org_id = p_org for update of w2;
    if w.id is null then raise exception 'NOT_FOUND: 想要'; end if;
    if w.status <> 'yes' then raise exception 'BAD_STATE: % 还没确认还要（热线先问）', w.name; end if;
    update app.wants set status = 'allocated', allocated_qty = (x->>'qty')::int, allocated_at = now(), allocated_by = app.uid() where id = w.id;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('name', w.name, 'phone', w.phone, 'city', w.city,
      'note', format('到货了：%s 给你留了 %s 个（你要 %s）', w.model, x->>'qty', w.qty)));
  end loop;
  if jsonb_array_length(v_rows) = 0 then raise exception 'VALIDATION: 至少给一个人分'; end if;
  select m.employee_id into v_hot from app.members m where m.org_id = p_org and 'hotline' = any(m.roles) and m.employee_id is not null limit 1;
  v_list := app.create_call_list(p_org, '到货通知 · ' || to_char(now(), 'MM-DD'), v_hot, coalesce(p_note, '到货分配：打电话告诉客户给他留了多少'), v_rows);
  update app.wants set call_list_id = v_list where org_id = p_org and status = 'allocated' and call_list_id is null and allocated_at > now() - interval '1 minute';
  return v_list;
end $$;

-- 兑现率：以前登记的想要，问到「还要」（或已分到货）的占几成
create or replace view app.v_want_conversion as
select customer_id, org_id,
  count(*) filter (where status in ('yes','allocated')) as kept,
  count(*) filter (where status in ('yes','allocated','no','expired')) as closed,
  case when count(*) filter (where status in ('yes','allocated','no','expired')) = 0 then null
       else round(count(*) filter (where status in ('yes','allocated'))::numeric / count(*) filter (where status in ('yes','allocated','no','expired')), 2) end as rate
from app.wants group by customer_id, org_id;
alter view app.v_want_conversion set (security_invoker = true);

-- 备货看的三个数（按型号）：缺口（下单时没供够）、开着的想要、想要 × 兑现率（没有历史按 0.5 算）
create or replace view app.v_want_demand as
select w.org_id, w.product_id, max(w.model) as model,
  sum(w.qty) filter (where w.source = 'order_short') as short_qty,
  sum(w.qty) as open_qty,
  round(sum(w.qty * coalesce(cv.rate, 0.5))) as weighted_qty,
  count(distinct w.customer_id) as customers
from app.wants w left join app.v_want_conversion cv on cv.customer_id = w.customer_id
where w.status in ('open','yes','no_answer') and w.product_id is not null
group by w.org_id, w.product_id;
alter view app.v_want_demand set (security_invoker = true);

-- 「不要了（找别人买了）」= 缺货丢单
create or replace view app.v_want_lost as
select w.org_id, w.product_id, w.model, w.customer_id, c.name as customer_name, w.qty, w.check_note, w.checked_at
from app.wants w join app.customers c on c.id = w.customer_id where w.status = 'no';
alter view app.v_want_lost set (security_invoker = true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.wants, app.v_open_wants, app.v_want_conversion, app.v_want_demand, app.v_want_lost to authenticated;
    grant execute on function app.add_want(uuid, uuid, text, int, text), app.sync_wants(uuid), app.want_check(uuid, text, text),
      app.allocate_wants(uuid, jsonb, text), app.want_days(uuid) to authenticated;
  end if;
end $$;
