-- LA&9S Operations · 0012 接真实数据要改的地方 (Frank 2026-10-29, 看过飞书 + 金蝶导出后)
-- 1. 真实物料里「同种类 + 同型号」有好几个编码 (颜色 / 品质不同, 例 AA XR 电池盖 6 个颜色) → 加「区分」字段, 唯一性改成 种类 + 型号 + 区分.
-- 2. 物料带上金蝶物料名称、FOB 成本、C≥10 折扣.
-- 3. 客户导入带上 欠款上限 (飞书「本地提货账期金额」)、国家、电话.

alter table app.products drop constraint if exists products_org_id_category_id_model_key;
alter table app.products add column variant text, add column kingdee_name text, add column fob_rmb numeric(18,4);
create unique index products_cat_model_variant_uq on app.products (org_id, category_id, model, coalesce(variant, ''));

create or replace function app.import_products(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_cat uuid; v_id uuid; n_new int := 0; n_upd int := 0; n_bad int := 0; v_ids uuid[] := '{}'; v_bad jsonb := '[]';
  v_model text; v_code text; v_shared text[];
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    v_code := nullif(trim(x->>'code'), ''); v_model := upper(nullif(trim(x->>'model'), ''));
    if v_code is null or v_model is null or coalesce(trim(x->>'category'),'') = '' then n_bad := n_bad + 1; v_bad := v_bad || jsonb_build_array(x); continue; end if;
    select id into v_cat from app.categories where org_id = p_org and upper(name) = upper(trim(x->>'category'));
    if not found then
      insert into app.categories (org_id, name, sort) values (p_org, upper(trim(x->>'category')), 100) returning id into v_cat;
    end if;
    v_shared := (select array_agg(distinct upper(trim(v))) from jsonb_array_elements_text(case when jsonb_typeof(x->'shared_models') = 'array' then x->'shared_models' else '[]' end) v where trim(v) <> '');
    begin
      select id into v_id from app.products where org_id = p_org and code = v_code;
      if found then
        update app.products set category_id = v_cat, model = v_model, variant = coalesce(nullif(trim(x->>'variant'),''), variant),
          kingdee_name = coalesce(nullif(x->>'kingdee_name',''), kingdee_name),
          brand = coalesce(nullif(x->>'brand',''), brand), brand_group = coalesce(nullif(x->>'brand_group',''), brand_group),
          cost_owner = coalesce(nullif(x->>'cost_owner',''), cost_owner), bin_default = coalesce(nullif(x->>'bin',''), bin_default),
          kingdee_code = coalesce(nullif(x->>'kingdee_code',''), kingdee_code), shared_models = coalesce(v_shared, shared_models),
          rmb_cost = coalesce(nullif(x->>'rmb_cost','')::numeric, rmb_cost), freight_xof = coalesce(nullif(x->>'freight','')::numeric, freight_xof),
          fee_s = coalesce(nullif(x->>'fee_s','')::numeric, fee_s), fee_a = coalesce(nullif(x->>'fee_a','')::numeric, fee_a),
          fee_b = coalesce(nullif(x->>'fee_b','')::numeric, fee_b), fee_c = coalesce(nullif(x->>'fee_c','')::numeric, fee_c),
          repair_bulk_discount = coalesce(nullif(x->>'repair_bulk_discount','')::numeric, repair_bulk_discount),
          fob_rmb = coalesce(nullif(x->>'fob_rmb','')::numeric, fob_rmb),
          cost_updated_at = case when nullif(x->>'rmb_cost','') is not null then now() else cost_updated_at end
        where id = v_id;
        n_upd := n_upd + 1;
      else
        insert into app.products (org_id, code, kingdee_code, category_id, model, variant, kingdee_name, brand, brand_group, cost_owner, bin_default, shared_models,
          rmb_cost, freight_xof, fee_s, fee_a, fee_b, fee_c, repair_bulk_discount, fob_rmb, cost_updated_at)
        values (p_org, v_code, nullif(x->>'kingdee_code',''), v_cat, v_model, nullif(trim(x->>'variant'),''), nullif(x->>'kingdee_name',''),
          nullif(x->>'brand',''), nullif(x->>'brand_group',''), nullif(x->>'cost_owner',''), nullif(x->>'bin',''), coalesce(v_shared, '{}'),
          nullif(x->>'rmb_cost','')::numeric, nullif(x->>'freight','')::numeric, nullif(x->>'fee_s','')::numeric, nullif(x->>'fee_a','')::numeric,
          nullif(x->>'fee_b','')::numeric, nullif(x->>'fee_c','')::numeric, nullif(x->>'repair_bulk_discount','')::numeric, nullif(x->>'fob_rmb','')::numeric,
          case when nullif(x->>'rmb_cost','') is not null then now() end)
        returning id into v_id;
        n_new := n_new + 1;
      end if;
    exception when unique_violation then
      n_bad := n_bad + 1; v_bad := v_bad || jsonb_build_array(x || '{"why":"同种类同型号已有别的编码，要填「区分」（颜色 / 版本）"}'); continue;
    end;
    v_ids := v_ids || v_id;
  end loop;
  perform app.recompute_prices(p_org, v_ids);
  perform app.audit(p_org, 'import_products', 'products', null, jsonb_build_object('new', n_new, 'updated', n_upd, 'bad', n_bad));
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'bad', n_bad, 'bad_rows', v_bad);
end $$;

-- 客户导入: 多带 欠款上限 / 国家 / 电话; 有编码有档位的直接正式
create or replace function app.import_customers(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; n_new int := 0; n_upd int := 0; n_skip int := 0; v_id uuid; v_code text; v_phone text;
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(x->>'name'),'') = '' then n_skip := n_skip + 1; continue; end if;
    v_code := nullif(upper(trim(x->>'code')), '');
    v_phone := nullif(trim(x->>'phone'), '');
    select id into v_id from app.customers where org_id = p_org and (
      (v_code is not null and code = v_code) or
      (v_phone is not null and regexp_replace(phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g') and length(regexp_replace(v_phone, '\D', '', 'g')) >= 8));
    if found then
      update app.customers set
        kind = case when kind <> coalesce(x->>'kind','spare') then 'both' else kind end,
        market = coalesce(market, x->>'market'), zone = coalesce(zone, x->>'zone'), recycle_type = coalesce(recycle_type, x->>'recycle_type'),
        interested = coalesce(interested, (x->>'interested')::boolean), note = coalesce(note, x->>'note'),
        credit_days = coalesce(nullif(x->>'credit_days','')::int, credit_days), credit_limit = coalesce(nullif(x->>'credit_limit','')::numeric, credit_limit),
        phone = coalesce(phone, v_phone), updated_at = now()
      where id = v_id;
      n_upd := n_upd + 1;
    else
      insert into app.customers (org_id, code, temp_code, name, phone, city, tier, status, source, kind, market, zone, recycle_type, interested,
        note, credit_days, credit_limit, country, address)
      values (p_org, v_code, case when v_code is null then app.next_doc_no(p_org, 'T') end, upper(trim(x->>'name')), v_phone, x->>'city',
        case when v_code is not null then nullif(x->>'tier','')::app.customer_tier end,
        case when v_code is not null and nullif(x->>'tier','') is not null then 'active'::app.customer_status else 'prospect'::app.customer_status end,
        'import', coalesce(x->>'kind','spare'), x->>'market', x->>'zone', x->>'recycle_type', (x->>'interested')::boolean,
        x->>'note', nullif(x->>'credit_days','')::int, nullif(x->>'credit_limit','')::numeric, coalesce(nullif(x->>'country',''), 'CI'), x->>'address');
      n_new := n_new + 1;
    end if;
  end loop;
  perform app.audit(p_org, 'import_customers', 'customers', null, jsonb_build_object('new', n_new, 'updated', n_upd, 'skipped', n_skip));
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'skipped', n_skip);
end $$;
