-- 0075 (457, Frank 11-20 09:09): 游客想询价就必须留 姓名 / 电话 / 城市 / 等级 —— 不留就不能提交; 游客看不到任何价格 (价格由热线 / 销售联系时报)
-- 等级 = 游客自报的店铺类型. 转成报价时按它给一个系统默认档位: 维修店 → Repair shop, 其他一律 Retail shop (Wholesale / S 永远不自动给, 只中方定), 标「未确认」.
create or replace function app.guest_inquiry2(p_org uuid, p_info jsonb, p_lines jsonb, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare v_phone text := regexp_replace(coalesce(p_info->>'phone', ''), '\D', '', 'g'); v_sales uuid := nullif(p_info->>'sales_id', '')::uuid; v_no text; v_cust uuid;
  v_level text := upper(coalesce(p_info->>'level', ''));
begin
  if coalesce(trim(p_info->>'contact'), '') = '' then raise exception 'VALIDATION: 请填姓名 · Votre nom'; end if;
  if length(v_phone) < 8 then raise exception 'VALIDATION: 请填正确的电话 / WhatsApp 号码 · Téléphone'; end if;
  if coalesce(trim(p_info->>'city'), '') = '' then raise exception 'VALIDATION: 请选城市 · Ville'; end if;
  if v_level not in ('REPAIR', 'RETAIL', 'WHOLESALE', 'MIXED') then raise exception 'VALIDATION: 请选你是哪种店 · Type de boutique'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'VALIDATION: 至少选一个型号'; end if;
  if v_sales is not null and not exists (select 1 from app.employees where id = v_sales and org_id = p_org and active) then v_sales := null; end if;
  if (select count(*) from app.inquiries where org_id = p_org and source = 'guest' and regexp_replace(coalesce(guest_info->>'phone', ''), '\D', '', 'g') = v_phone and created_at > now() - interval '10 minutes') >= 3 then
    raise exception 'VALIDATION: 提交太频繁了，请稍后再试，或直接联系销售员';
  end if;
  select id into v_cust from app.customers where org_id = p_org and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone limit 1;   -- 老客户的号码 → 直接挂上
  v_no := app.next_iq_no(p_org);
  insert into app.inquiries (org_id, iq_no, source, customer_id, guest_info, lines, note, owner_employee_id)
  values (p_org, v_no, 'guest', v_cust, p_info || jsonb_build_object('level', v_level), app.clean_inq_lines(p_lines), nullif(trim(coalesce(p_note, '')), ''),
    coalesce((select owner_employee_id from app.customers where id = v_cust), v_sales));
  return v_no;
end $$;

-- 游客询单转成报价那一刻 (inquiry_convert 新建潜客后把 customer_id 写回询单): 按自报等级给系统默认档位, 未确认
create or replace function app.guest_level_tier() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_level text := upper(coalesce(new.guest_info->>'level', ''));
begin
  if new.source = 'guest' and old.customer_id is null and new.customer_id is not null and v_level <> '' then
    update app.customers set shop_type = coalesce(shop_type, v_level),
      tier = case when v_level = 'REPAIR' then 'REPAIR'::app.customer_tier else 'RETAIL'::app.customer_tier end,
      tier_confirmed_at = null, tier_confirmed_by = null,
      tier_note = '系统默认 · 未确认（游客自报：' || case v_level when 'REPAIR' then '维修店' when 'RETAIL' then '零售店' when 'WHOLESALE' then '批发店' else '批零兼营' end || '）'
    where id = new.customer_id and status = 'prospect';
  end if;
  return new;
end $$;
create trigger inquiries_guest_level after update of customer_id on app.inquiries for each row execute function app.guest_level_tier();
