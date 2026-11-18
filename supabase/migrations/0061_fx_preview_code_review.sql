-- 0061 (Frank 11-18 第 9、10 点)
--  ① 改汇率 / 取整前先预览: 每个型号四档价 改前 → 改后, 看过再确认 (预览不落库)
--  ② 人民币报价只给 S 档客户 (中方可以破例)
--  ③ 编码甄别: 同种类 + 同型号下有多个编码的, 一组一组定「是同一种货 / 不是同一种货」; 支持按清单批量导入

-- ───────────────────────── ① 汇率预览 ─────────────────────────
-- 做法: 在子事务里真的改一遍、读出改后的价, 再回滚. 所以预览和真正保存走的是同一套算法, 不会两边算得不一样.
create or replace function app.preview_price_settings(p_org uuid, p_rate numeric, p_rate_fob numeric, p_round int, p_usd numeric default null)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare v_before jsonb; v jsonb;
begin
  perform app.require_role(p_org, 'admin');
  select coalesce(jsonb_object_agg(pp.product_id::text || ':' || pp.tier::text, pp.price), '{}'::jsonb) into v_before
    from app.product_prices pp join app.products p on p.id = pp.product_id where p.org_id = p_org and pp.currency = 'XOF';
  begin
    perform app.set_price_settings(p_org, p_rate, p_rate_fob, p_round);
    if coalesce(p_usd, 0) > 0 then perform app.set_usd_rate(p_org, p_usd); perform app.recompute_prices(p_org, null); end if;
    select jsonb_build_object(
      'total', (select count(*) from app.products where org_id = p_org),
      'changed', coalesce(jsonb_agg(x.j order by x.cat, x.model), '[]'::jsonb)) into v
    from (
      select c.name as cat, p.model, jsonb_build_object('product_id', p.id, 'code', p.code, 'model', p.model, 'category', c.name,
        'before', (select jsonb_object_agg(t.tier, (v_before->>(p.id::text || ':' || t.tier))::numeric) from unnest(array['S','WHOLESALE','RETAIL','REPAIR']) t(tier)),
        'after', (select coalesce(jsonb_object_agg(pp.tier::text, pp.price), '{}'::jsonb) from app.product_prices pp where pp.product_id = p.id and pp.currency = 'XOF')) as j
      from app.products p left join app.categories c on c.id = p.category_id
      where p.org_id = p_org and exists (
        select 1 from unnest(array['S','WHOLESALE','RETAIL','REPAIR']) t(tier)
        where (v_before->>(p.id::text || ':' || t.tier))::numeric is distinct from
              (select pp.price from app.product_prices pp where pp.product_id = p.id and pp.currency = 'XOF' and pp.tier::text = t.tier))) x;
    raise exception 'PREVIEW_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PREVIEW_ROLLBACK' then raise; end if;
  end;
  return v;
end $$;

-- ───────────────────────── ② 人民币报价只给 S 档 ─────────────────────────
create or replace function app.trg_cny_only_s() returns trigger language plpgsql security definer set search_path = app, public as $$
declare c app.customers;
begin
  if new.kind <> 'normal' or new.currency <> 'CNY' then return new; end if;
  if tg_op = 'UPDATE' and old.currency = 'CNY' then return new; end if;
  if not coalesce((select (value->>'cny_only_s')::boolean from app.org_settings where org_id = new.org_id and key = 'price_rules'), true) then return new; end if;
  select * into c from app.customers where id = new.customer_id;
  if c.tier is distinct from 'S' and not app.has_role(new.org_id, array['admin']::app.role_name[]) then
    raise exception 'VALIDATION: 人民币报价只给 S 档客户；这个客户不是 S 档，请用 XOF 报价，或请中方来建这张单';
  end if;
  return new;
end $$;
create trigger cny_only_s before insert or update of currency on app.deals for each row execute function app.trg_cny_only_s();

-- ───────────────────────── ③ 编码甄别 ─────────────────────────
-- unify_code: 归一编码 (同一种货的几个料号, 归到其中一个「主编码」上). unify_status: same = 定了是同一种货; diff = 定了不是; null = 还没定.
-- 注意: 这里只记「结论」. 库存、出库、金蝶仍然按各自的料号走 (§3b: 归一只影响搜索和显示).
alter table app.products add column unify_code text, add column unify_status text check (unify_status in ('same', 'diff')), add column unify_note text,
  add column unify_at timestamptz, add column unify_by uuid;

create or replace function app.set_code_unify(p_org uuid, p_products uuid[], p_verdict text, p_main uuid default null, p_note text default null)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_main text; n int;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(cardinality(p_products), 0) < 1 then raise exception 'VALIDATION: 没选编码'; end if;
  if exists (select 1 from app.products where id = any(p_products) and org_id <> p_org) then raise exception 'PERMISSION_DENIED: 不是本组织的物料'; end if;
  if p_verdict = 'same' then
    if cardinality(p_products) < 2 then raise exception 'VALIDATION: 至少两个编码才谈得上「同一种货」'; end if;
    select code into v_main from app.products where id = coalesce(p_main, p_products[1]) and id = any(p_products);
    if v_main is null then raise exception 'VALIDATION: 主编码要从这几个里面选'; end if;
    -- 通用性不同的不能归一 (§3b: 那是两种货)
    if (select count(distinct coalesce((select string_agg(x, '|' order by x) from unnest(p.shared_models) x), '')) from app.products p where p.id = any(p_products)) > 1
       and coalesce(trim(p_note), '') = '' then
      raise exception 'VALIDATION: 这几个编码的通用性不一样，按规矩是两种货；确实要归成一种，写一句原因';
    end if;
    update app.products set unify_code = v_main, unify_status = 'same', unify_note = p_note, unify_at = now(), unify_by = app.uid() where id = any(p_products);
  elsif p_verdict = 'diff' then
    update app.products set unify_code = null, unify_status = 'diff', unify_note = p_note, unify_at = now(), unify_by = app.uid() where id = any(p_products);
  elsif p_verdict = 'reset' then
    update app.products set unify_code = null, unify_status = null, unify_note = null, unify_at = null, unify_by = null where id = any(p_products);
  else raise exception 'VALIDATION: 不认识的结论';
  end if;
  get diagnostics n = row_count;
  perform app.audit(p_org, 'set_code_unify', 'products', p_products[1], jsonb_build_object('verdict', p_verdict, 'main', v_main, 'n', n, 'note', p_note));
  return n;
end $$;

-- 批量导入: [{code, main_code}] —— main_code 为空 / 等于自己 = 自己就是主编码; main_code 写 '-' = 定为「不是同一种货」
create or replace function app.import_code_unify(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_code text; v_main text; n_ok int := 0; v_bad text[] := '{}';
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_code := upper(trim(coalesce(x->>'code', ''))); v_main := upper(trim(coalesce(x->>'main_code', '')));
    if v_code = '' then continue; end if;
    if not exists (select 1 from app.products where org_id = p_org and upper(code) = v_code) then v_bad := v_bad || v_code; continue; end if;
    if v_main = '-' then
      update app.products set unify_code = null, unify_status = 'diff', unify_at = now(), unify_by = app.uid(), unify_note = '导入' where org_id = p_org and upper(code) = v_code;
    else
      if v_main = '' then v_main := v_code; end if;
      if not exists (select 1 from app.products where org_id = p_org and upper(code) = v_main) then v_bad := v_bad || (v_code || '→' || v_main); continue; end if;
      update app.products set unify_code = (select code from app.products where org_id = p_org and upper(code) = v_main limit 1), unify_status = 'same',
        unify_at = now(), unify_by = app.uid(), unify_note = '导入' where org_id = p_org and upper(code) = v_code;
    end if;
    n_ok := n_ok + 1;
  end loop;
  perform app.audit(p_org, 'import_code_unify', 'products', null, jsonb_build_object('ok', n_ok, 'bad', cardinality(v_bad)));
  return jsonb_build_object('ok', n_ok, 'bad', to_jsonb(v_bad));
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.preview_price_settings(uuid, numeric, numeric, int, numeric), app.set_code_unify(uuid, uuid[], text, uuid, text), app.import_code_unify(uuid, jsonb) to authenticated;
  end if;
end $$;
