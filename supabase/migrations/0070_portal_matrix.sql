-- 0070 (Frank 11-18 393): 权限矩阵加三列 —— 游客 / 客户老板 / 店员. 公司统一定「这三种人能做什么」, 单个客户还能在客户档案里再单独开关 (portal_opts 优先).
-- org_settings 'portal_matrix' = { stock: [..], price: [..], inquiry: [..], balance: [..], orders: [..] }  (值 = 能做的人: guest / boss / clerk)
create or replace function app.portal_can(p_org uuid, p_who text, p_key text)
returns boolean language sql stable security definer set search_path = app, public as $$
  select coalesce(
    (select case when jsonb_typeof(value->p_key) = 'array' then value->p_key ? p_who end from app.org_settings where org_id = p_org and key = 'portal_matrix'),
    case p_key when 'stock' then p_who in ('boss', 'clerk') when 'price' then p_who = 'boss' when 'inquiry' then true
               when 'balance' then p_who = 'boss' when 'orders' then p_who in ('boss', 'clerk') else false end)
$$;
grant execute on function app.portal_can(uuid, text, text) to authenticated;
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then grant execute on function app.portal_can(uuid, text, text) to anon; end if; end $$;

create or replace function app.inquiry_catalog(p_org uuid)
returns table (id uuid, code text, category_id uuid, category text, cat_sort int, model text, variant text, shared_models text[], band text, avail int, transit int, price numeric)
language plpgsql stable security definer set search_path = app, public as $$
declare me record; v_staff boolean := exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active and not (m.roles <@ array['boss','clerk']::app.role_name[]));
  v_cust uuid; v_stock boolean := false; v_price boolean := false; v_low int; o jsonb;
begin
  select coalesce((value->>'low')::int, 50) into v_low from app.org_settings where org_id = p_org and key = 'guest_rules';
  v_low := coalesce(v_low, 50);
  if not v_staff then
    v_stock := app.portal_can(p_org, 'guest', 'stock');      -- 游客: 默认只看 有货 / 少量 / 可预订; 永远没有价
    if app.uid() is not null then
      select * into me from app.portal_me();
      if me.customer_id is not null and me.hq_org = p_org then
        v_cust := me.customer_id;
        select coalesce(portal_opts, '{}'::jsonb) into o from app.customers where customers.id = v_cust;
        v_stock := coalesce((o->>'stock')::boolean, app.portal_can(p_org, me.role::text, 'stock'));
        v_price := case when me.role = 'boss' then coalesce((o->>'price')::boolean, app.portal_can(p_org, 'boss', 'price'))
                        else coalesce((o->>'clerk_price')::boolean, app.portal_can(p_org, 'clerk', 'price')) end;
      end if;
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

-- 不许询单的人: 询单进不来
create or replace function app.trg_inquiry_allowed() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_who text;
begin
  if new.source = 'guest' then v_who := 'guest';
  elsif new.source = 'customer' then select role::text into v_who from app.portal_me();
  else return new; end if;
  if not app.portal_can(new.org_id, coalesce(v_who, 'boss'), 'inquiry') then raise exception 'PERMISSION_DENIED: 现在不接受这个入口的询单，请直接联系销售员'; end if;
  return new;
end $$;
create trigger inquiry_allowed before insert on app.inquiries for each row execute function app.trg_inquiry_allowed();
