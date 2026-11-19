-- 0062 (Frank 11-18 401 / 407 / 409 / 416): 选项不许在后台写死 —— ⚙ 里新增的选项后台要认
-- ① 确认方式 (whatsapp / phone / in_store): 所有函数里的写死校验放开成「选了就行」(老的三个值照常认), 值存组织自己在 ⚙ 里定的名字.
-- ② 发货方式 / 运费谁出 / 退货类型: 这些后台按固定类别处理 (枚举), 新加的选项 = 「按某一类处理 + 自己的名字」, 名字单独存一列.
-- ③ 签收「跟谁确认的」: 身份不再限定三种 (加了「销售员」, ⚙ 可再加); 电话不再强制 (409).

-- ① 现存函数里凡是写死确认方式的校验, 原地放开 (不改函数别的部分)
do $$
declare r record; d text; n text;
begin
  for r in select p.oid from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'app' and p.prosrc ~ $re$not in \('whatsapp',\s*'phone',\s*'in_store'\)$re$ loop
    d := pg_get_functiondef(r.oid);
    n := regexp_replace(d, $re$coalesce\(p_method,\s*''\) not in \('whatsapp',\s*'phone',\s*'in_store'\)$re$, $x$coalesce(trim(p_method),'') = ''$x$, 'g');
    n := regexp_replace(n, $re$p_method not in \('whatsapp',\s*'phone',\s*'in_store'\)$re$, 'false', 'g');
    if n <> d then execute n; end if;
  end loop;
end $$;

-- ② 自己加的选项的名字
alter table app.shipments add column method_label text, add column freight_label text;
alter table app.returns add column reason_label text;
create or replace function app.set_opt_label(p_kind text, p_id uuid, p_label text)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v text := nullif(trim(coalesce(p_label,'')), '');
begin
  if p_kind in ('ship_method','ship_freight') then
    select org_id into v_org from app.shipments where id = p_id;
    if v_org is null then raise exception 'NOT_FOUND: 出库单不存在'; end if;
    if not app.is_member(v_org) then raise exception 'PERMISSION_DENIED: 不是这家公司的成员'; end if;
    if p_kind = 'ship_method' then update app.shipments set method_label = v where id = p_id;
    else update app.shipments set freight_label = v where id = p_id; end if;
  elsif p_kind = 'return_reason' then
    select org_id into v_org from app.returns where id = p_id;
    if v_org is null then raise exception 'NOT_FOUND: 退货单不存在'; end if;
    if not app.is_member(v_org) then raise exception 'PERMISSION_DENIED: 不是这家公司的成员'; end if;
    update app.returns set reason_label = v where id = p_id;
  else raise exception 'VALIDATION: 不认识的选项组';
  end if;
end $$;
grant execute on function app.set_opt_label(text, uuid, text) to authenticated;

-- ③ 签收确认人: 身份放开, 电话选填 (填了照样进客户联系人)
alter table app.shipments drop constraint if exists shipments_confirm_role_check;
create or replace function app.sign_receipt(p_shipment uuid, p_photo text, p_at timestamptz, p_name text, p_phone text, p_role text)
returns void language plpgsql security definer set search_path = app, public as $$
declare s app.shipments; v_phone text := regexp_replace(coalesce(p_phone,''), '\s', '', 'g');
begin
  if coalesce(trim(p_role),'') = '' then raise exception 'VALIDATION: 选跟谁确认的（老板 / 店员 / 销售员 / 其他人）'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'VALIDATION: 写清楚跟谁确认的（姓名）'; end if;
  perform app.sign_receipt(p_shipment, p_photo, p_at);
  update app.shipments set confirm_name = trim(p_name), confirm_phone = nullif(v_phone,''), confirm_role = trim(p_role) where id = p_shipment returning * into s;
  if v_phone <> '' and p_role <> 'sales' then
    update app.customers c set contacts = c.contacts || jsonb_build_array(jsonb_build_object('name', trim(p_name), 'phone', v_phone, 'role', p_role, 'added_at', now()))
     where c.id = (select customer_id from app.deals where id = s.deal_id)
       and regexp_replace(coalesce(c.phone,''), '\s', '', 'g') <> v_phone
       and not exists (select 1 from jsonb_array_elements(c.contacts) x where x->>'phone' = v_phone);
  end if;
  perform app.deal_event(s.deal_id, 'sign_confirmed_with', jsonb_build_object('out_no', s.out_no, 'name', trim(p_name), 'phone', nullif(v_phone,''), 'role', p_role));
end $$;

-- ④ 这几组选项后台没有专门的算法, 只是记个值 → 去掉写死的清单, ⚙ 里随便加
alter table app.directives drop constraint if exists directives_task_type_check;
alter table app.hotline_calls drop constraint if exists hotline_calls_result_check;
alter table app.visits drop constraint if exists visits_result_check;
