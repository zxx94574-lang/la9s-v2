-- 0076 熟客直接下单（Frank 11-22）：跳过报价确认，下推找货前自动查三道关
--   价格：有「要议价」的行 → 中方议价（沿用报价审批「申请特价」）
--   欠款：超上限 / 超账期 / 有欠款不出货 → 停住，进财务紧急待办；财务对完账、登记收款后自动放行（沿用 ar_reevaluate）
--   特批：中方批（沿用 approve_quote / approve_quote_mode）
-- 关都过了 → 自动「确认 + 预占 + 下推找货」。员工替客户下单要贴客户原话截图。
-- 接单人：customers.taker_employee_id（谁负责给这个客户建单，待办先推给他）。

alter table app.customers add column if not exists taker_employee_id uuid references app.employees(id);
alter table app.deals add column if not exists direct boolean not null default false,
  add column if not exists direct_proof text, add column if not exists direct_by uuid, add column if not exists direct_at timestamptz;

-- 权限表里的动作（org_settings perm_matrix = {action: [roles]}），没配就用默认；中方永远可以
create or replace function app.perm_ok(p_org uuid, p_action text, p_default text[])
returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (
    select 1 from app.members m
    where m.user_id = app.uid() and m.org_id = p_org and m.active
      and ('admin' = any(m.roles) or m.roles::text[] && coalesce(
        (select array(select jsonb_array_elements_text(s.value -> p_action)) from app.org_settings s
          where s.org_id = p_org and s.key = 'perm_matrix' and jsonb_typeof(s.value -> p_action) = 'array'),
        p_default)))
$$;

-- 预占 + 下推找货的核心（和 start_picking 同一套，不查岗位：只给内部的自动放行用）
create or replace function app._direct_pick(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare d app.deals; l record; v_avail int; v_take int; v_short jsonb := '[]';
begin
  select * into d from app.deals where id = p_deal for update;
  if d.status <> 'quoted' then return null; end if;
  update app.deals set status = 'hotline_ok', hotline_note = '熟客直接下单', hotline_method = 'whatsapp', hotline_proof = d.direct_proof,
    hotline_opened_at = coalesce(hotline_opened_at, now()) where id = p_deal;
  perform app.deal_event(p_deal, 'direct_confirmed', jsonb_build_object('note', '熟客直接下单：价格 / 欠款 / 审批都过了，自动下推找货'));
  for l in select dl.*, w.kind as wh_kind from app.deal_lines dl
           left join app.stock_items s on s.id = dl.stock_item_id
           left join app.warehouses w on w.id = s.warehouse_id
           where dl.deal_id = p_deal order by dl.seq loop
    if l.product_id is null or l.stock_item_id is null then
      v_short := v_short || jsonb_build_object('line', l.id, 'reason', 'no_stock_row', 'qty', l.qty_req);
      continue;
    end if;
    if l.wh_kind <> 'local' then raise exception 'WAREHOUSE_SCOPE: line % uses % warehouse', l.seq, l.wh_kind; end if;
    select qty_on_hand - qty_reserved into v_avail from app.stock_items where id = l.stock_item_id for update;
    v_take := least(l.qty_req, greatest(v_avail, 0));
    perform app.reserve(l.stock_item_id, v_take);
    update app.deal_lines set qty_supply = v_take where id = l.id;
    if v_take < l.qty_req then v_short := v_short || jsonb_build_object('line', l.id, 'reason', 'short', 'qty', l.qty_req - v_take); end if;
  end loop;
  update app.deals set status = 'picking', pick_no = app.next_doc_no(d.org_id, 'PK') where id = p_deal;
  perform app.deal_event(p_deal, 'picking_started', jsonb_build_object('short', v_short, 'direct', true));
  return v_short;
end $$;
revoke all on function app._direct_pick(uuid) from public;

-- 三道关现在卡在哪：price（要议价）/ credit（欠款）/ approval（其他要中方批的）/ ok
create or replace function app.direct_gate(p_deal uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare d app.deals; r text[]; v_price boolean; v_credit boolean; v_other boolean;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if not app.is_member(d.org_id) then raise exception 'PERMISSION_DENIED'; end if;
  r := app.approval_reasons(p_deal);
  v_price := '申请特价' = any(r);
  v_credit := exists (select 1 from unnest(r) x where x in ('超欠款上限','超账期') or x like '有欠款不出货%');
  v_other := exists (select 1 from unnest(r) x where x <> '申请特价' and x not in ('超欠款上限','超账期') and x not like '有欠款不出货%');
  return jsonb_build_object('status', d.status, 'approval', d.approval, 'reasons', to_jsonb(r),
    'gate', case when d.status <> 'quoted' then 'passed'
                 when d.approval = 'approved' then 'ok'
                 when d.approval = 'rejected' then 'rejected'
                 when v_price then 'price' when v_other then 'approval' when v_credit then 'credit' else 'ok' end);
end $$;

-- 能放行就放行（建单后、中方批完、收款后都会来这里）
create or replace function app.direct_try(p_deal uuid)
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null or not d.direct or d.status <> 'quoted' then return coalesce(d.status::text, 'none'); end if;
  if d.approval not in ('auto','approved') then return (app.direct_gate(p_deal)) ->> 'gate'; end if;
  perform app._direct_pick(p_deal);
  return 'picking';
end $$;
revoke all on function app.direct_try(uuid) from public;

create or replace function app.create_direct_order(p_org uuid, p_customer uuid, p_currency text, p_lines jsonb, p_proof text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_id uuid; v_state text;
begin
  if not app.perm_ok(p_org, 'direct_order', array['manager']) then raise exception 'PERMISSION_DENIED: 你的岗位没有「直接下单」权限（中方在权限表里可以开）'; end if;
  select * into c from app.customers where id = p_customer and org_id = p_org;
  if c.id is null then raise exception 'NOT_FOUND: 客户'; end if;
  if c.status <> 'active' or c.tier is null or c.tier_confirmed_at is null then
    raise exception 'DIRECT_NEEDS_QUOTE: 新客户 / 还没定档的客户要先走报价';
  end if;
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 替客户下单要贴客户原话截图（群里那条下单消息）'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'VALIDATION: 至少一行'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) x where nullif(x->>'product_id','') is null) then
    raise exception 'VALIDATION: 直接下单只能选有编码的型号；没编码的走报价';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) x where nullif(x->>'requested_price','') is not null and coalesce(trim(x->>'reason'), '') = '') then
    raise exception 'VALIDATION: 要议价的行要写客户的理由';
  end if;
  v_id := app.create_quote_priced(p_org, p_customer, p_currency, p_lines, coalesce(p_note, '熟客直接下单'));
  update app.deals set direct = true, direct_proof = p_proof, direct_by = app.uid(), direct_at = now() where id = v_id;
  perform app.deal_event(v_id, 'direct_created', jsonb_build_object('proof', p_proof,
    'haggle', (select coalesce(jsonb_agg(jsonb_build_object('product_id', x->>'product_id', 'price', x->>'requested_price', 'reason', x->>'reason')), '[]')
               from jsonb_array_elements(p_lines) x where nullif(x->>'requested_price','') is not null)));
  perform app.evaluate_approval(v_id);
  v_state := app.direct_try(v_id);
  return jsonb_build_object('deal', v_id, 'state', v_state, 'gate', app.direct_gate(v_id));
end $$;
revoke all on function app.create_direct_order(uuid, uuid, text, jsonb, text, text) from public;
grant execute on function app.create_direct_order(uuid, uuid, text, jsonb, text, text), app.direct_gate(uuid), app.perm_ok(uuid, text, text[]) to authenticated;

-- 中方批完 / 收款后审批自动清掉 → 直接下单的单自动放行
create or replace function app.trg_direct_release() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.direct and new.status = 'quoted' and new.approval in ('auto','approved') and old.approval is distinct from new.approval then
    perform app._direct_pick(new.id);
  end if;
  return new;
end $$;
drop trigger if exists direct_release on app.deals;
create trigger direct_release after update of approval on app.deals for each row execute function app.trg_direct_release();

-- 接单人
create or replace function app.set_customer_taker(p_customer uuid, p_employee uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  select * into c from app.customers where id = p_customer;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(c.org_id, 'admin');
  update app.customers set taker_employee_id = p_employee where id = p_customer;
  perform app.log_archive_edit(c.org_id, 'customer', p_customer, jsonb_build_object('接单人', jsonb_build_object('from', c.taker_employee_id, 'to', p_employee)));
end $$;
grant execute on function app.set_customer_taker(uuid, uuid) to authenticated;

-- 卡在欠款关的直接下单（给财务的紧急待办）
create or replace view app.v_direct_held as
select d.id as deal_id, d.org_id, d.biz_no, d.customer_id, c.name as customer_name, d.created_at, d.direct_by,
  d.approval_reasons, cr.balance, cr.credit_limit, cr.oldest_days, c.credit_days, c.taker_employee_id,
  (select coalesce(sum(l.qty_req * coalesce(l.unit_price, 0)), 0) from app.deal_lines l where l.deal_id = d.id) as order_total
from app.deals d join app.customers c on c.id = d.customer_id
left join app.v_customer_credit cr on cr.customer_id = c.id
where d.direct and d.status = 'quoted' and d.approval = 'pending';
alter view app.v_direct_held set (security_invoker = true);
grant select on app.v_direct_held to authenticated;
