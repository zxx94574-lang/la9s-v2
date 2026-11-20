-- 0074: 可售 / 可预订 + 在途不外露 (464 / 467 / 468), 询单「无效」和下面几项 (460 / 461)
-- ① 在途数量只给 中方 和 国内采购岗位; 其他员工、客户、游客一律拿不到数字 (只知道「可预订」)
create or replace function app.inquiry_catalog(p_org uuid)
returns table (id uuid, code text, category_id uuid, category text, cat_sort int, model text, variant text, shared_models text[], band text, avail int, transit int, price numeric)
language plpgsql stable security definer set search_path = app, public as $$
declare me record; v_staff boolean := exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active and not (m.roles <@ array['boss','clerk']::app.role_name[]));
  v_tr boolean := exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active and m.roles && array['admin','cn_support']::app.role_name[]);
  v_cust uuid; v_stock boolean := false; v_price boolean := false; v_low int; o jsonb;
begin
  select coalesce((value->>'low')::int, 50) into v_low from app.org_settings where org_id = p_org and key = 'guest_rules';
  v_low := coalesce(v_low, 50);
  if not v_staff then
    v_stock := app.portal_can(p_org, 'guest', 'stock');
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
    case when v_tr then t.r::int else null end,
    case when v_price and v_cust is not null then app.tier_price(p.id, v_cust, 'XOF') else null end
  from app.products p join app.categories c on c.id = p.category_id
  left join lateral (select coalesce(sum(si.qty_on_hand - si.qty_reserved), 0) as a from app.stock_items si join app.warehouses w on w.id = si.warehouse_id where si.product_id = p.id and w.kind = 'local') s on true
  left join lateral (select coalesce(sum(it.remaining - it.fob_remaining), 0) as r from app.v_in_transit it where it.product_id = p.id) t on true
  where p.org_id = p_org and p.active;
end $$;

-- ② 「可预订」小框上看在途: 预计到货时间 · 片数 · 机型名. 不含 FOB 采购. 只中方 + 国内采购.
create or replace function app.transit_peek(p_org uuid, p_product uuid)
returns table (eta date, qty int, model text, po_no text)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin', 'cn_support');
  return query
  select it.eta, (it.remaining - it.fob_remaining)::int, p.model, it.po_no
  from app.v_in_transit it join app.products p on p.id = it.product_id
  where it.org_id = p_org and it.product_id = p_product and coalesce(it.purpose, '') <> 'fob' and it.remaining - it.fob_remaining > 0
  order by it.eta nulls last;
end $$;

-- ③ 询单: 无效 (只中方标, 不算进转化率) 和 没成交 分开; 可以恢复. 下面几项: 什么时候要 / Yango 运费 / Wave 手续费
alter table app.inquiries drop constraint inquiries_status_check;
alter table app.inquiries add constraint inquiries_status_check check (status in ('new', 'contacted', 'quoted', 'converted', 'lost', 'invalid'));
alter table app.inquiries add column invalid_reason text, add column want_on date, add column yango_pay text, add column wave_pay text;

create or replace function app.inquiry_void(p_inq uuid, p_action text, p_reason text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare q app.inquiries;
begin
  select * into q from app.inquiries where id = p_inq for update;
  if q.id is null then raise exception 'NOT_FOUND: 询单不存在'; end if;
  perform app.require_role(q.org_id, 'admin');
  if p_action = 'invalid' then
    if q.status in ('converted', 'quoted') then raise exception 'BAD_STATE: 已经转成报价的询单不能标无效，去订单里作废'; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 标无效要选原因'; end if;
    update app.inquiries set status = 'invalid', invalid_reason = trim(p_reason), closed_by = app.uid(), closed_at = now() where id = p_inq;
  elsif p_action = 'restore' then
    if q.status not in ('invalid', 'lost') or q.deal_id is not null then raise exception 'BAD_STATE: 只有标了无效 / 没成交、还没转报价的询单能恢复'; end if;
    update app.inquiries set status = case when q.contacted_at is null then 'new' else 'contacted' end, invalid_reason = null, lost_reason = null, closed_by = null, closed_at = null where id = p_inq;
  else raise exception 'VALIDATION: 不认识的操作';
  end if;
  perform app.audit(q.org_id, 'inquiry_' || p_action, 'inquiries', p_inq, jsonb_build_object('reason', p_reason, 'was', q.status));
end $$;

create or replace function app.inquiry_extra(p_inq uuid, p_want date, p_yango text, p_wave text)
returns void language plpgsql security definer set search_path = app, public as $$
declare q app.inquiries;
begin
  select * into q from app.inquiries where id = p_inq;
  if q.id is null then raise exception 'NOT_FOUND: 询单不存在'; end if;
  if not app.is_member(q.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  if q.status not in ('new', 'contacted') then raise exception 'BAD_STATE: 询单已经处理过了'; end if;
  update app.inquiries set want_on = p_want, yango_pay = nullif(trim(p_yango), ''), wave_pay = nullif(trim(p_wave), '') where id = p_inq;
end $$;

revoke all on function app.transit_peek(uuid, uuid), app.inquiry_void(uuid, text, text), app.inquiry_extra(uuid, date, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.transit_peek(uuid, uuid), app.inquiry_void(uuid, text, text), app.inquiry_extra(uuid, date, text, text) to authenticated;
  end if;
end $$;
