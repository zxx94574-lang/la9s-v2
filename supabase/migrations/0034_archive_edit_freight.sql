-- 0034 (Frank 11-11 206): 档案里直接改 (解锁 → 改 → 自检确认 → 留记录) + 运费按批次实付 + 到岸成本向上进位

-- ① 到岸成本取整: 原来四舍五入 (220 → 200 偏低), 改成向上进到下一个 round_to (Frank 11-11 10:12 定: 417 → 500, 407 → 500)
create or replace function app.landed_cost(p_rmb numeric, p_freight numeric, s app.price_settings)
returns numeric language sql immutable as $$
  select case when p_rmb is null then null
    else ceil((p_rmb / s.rmb_per_xof + coalesce(p_freight, 0)) / s.round_to) * s.round_to end
$$;

-- ② 每批运费按实际付款: 这批总运费 ÷ 这批总片数, 每片向上进到下一个 50 (50 多 → 100, 100 零几 → 150)
alter table app.product_batches add column freight_total numeric(18,2), add column freight_pieces int;
create or replace function app.batch_freight(b app.product_batches)
returns numeric language sql immutable as $$
  select case when coalesce(b.freight_total, 0) > 0 and coalesce(b.freight_pieces, 0) > 0
    then ceil(b.freight_total / b.freight_pieces / 50) * 50 else b.freight_xof end
$$;

create or replace function app.save_product_batch(p_product uuid, p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_id uuid := p_id;
begin
  select org_id into v_org from app.products where id = p_product;
  if v_org is null then raise exception 'NOT_FOUND: 物料不存在'; end if;
  perform app.require_role(v_org, 'admin');
  if coalesce((p->>'qty')::numeric, 0) <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
  if (p->>'unit_price') is null or (p->>'unit_price')::numeric < 0 then raise exception 'VALIDATION: 采购单价必填'; end if;
  if nullif(p->>'freight_total','') is not null and coalesce(nullif(p->>'freight_pieces','')::numeric, 0) <= 0 then
    raise exception 'VALIDATION: 填了这批总运费，就要填这批一共多少片（用来算每片运费）';
  end if;
  if v_id is null then
    insert into app.product_batches (org_id, product_id, po_no, ordered_on, qty, currency, unit_price, freight_xof, freight_total, freight_pieces, source, note, created_by)
    values (v_org, p_product, nullif(trim(p->>'po_no'),''), nullif(p->>'ordered_on','')::date, (p->>'qty')::numeric::int,
      coalesce(nullif(upper(p->>'currency'),''), 'CNY'), (p->>'unit_price')::numeric, nullif(p->>'freight_xof','')::numeric,
      nullif(p->>'freight_total','')::numeric, nullif(p->>'freight_pieces','')::numeric::int,
      coalesce(nullif(p->>'source',''), 'manual'), nullif(p->>'note',''), app.uid())
    returning id into v_id;
  else
    update app.product_batches set po_no = nullif(trim(p->>'po_no'),''), ordered_on = nullif(p->>'ordered_on','')::date, qty = (p->>'qty')::numeric::int,
      currency = coalesce(nullif(upper(p->>'currency'),''), 'CNY'), unit_price = (p->>'unit_price')::numeric,
      freight_xof = nullif(p->>'freight_xof','')::numeric, freight_total = nullif(p->>'freight_total','')::numeric,
      freight_pieces = nullif(p->>'freight_pieces','')::numeric::int, note = nullif(p->>'note','')
    where id = v_id and product_id = p_product;
    if not found then raise exception 'NOT_FOUND: 批次不存在'; end if;
  end if;
  perform app.audit(v_org, 'save_product_batch', 'products', p_product, p || jsonb_build_object('batch_id', v_id));
  return v_id;
end $$;

-- 同一批 (同一采购单号) 的运费一次填进所有物料: 总运费 + 总片数
create or replace function app.set_batch_freight(p_org uuid, p_po text, p_total numeric, p_pieces int)
returns int language plpgsql security definer set search_path = app, public as $$
declare n int;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(p_total, 0) < 0 or coalesce(p_pieces, 0) <= 0 then raise exception 'VALIDATION: 总运费不能为负，总片数要大于 0'; end if;
  update app.product_batches set freight_total = p_total, freight_pieces = p_pieces where org_id = p_org and po_no = p_po;
  get diagnostics n = row_count;
  perform app.audit(p_org, 'set_batch_freight', 'product_batches', null, jsonb_build_object('po_no', p_po, 'total', p_total, 'pieces', p_pieces, 'rows', n));
  return n;
end $$;

-- ③ 物料基本信息在档案里改 (只中方): 型号 / 种类 / 品牌 / 区分 / 通用性
create or replace function app.edit_product_info(p_product uuid, p jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_old jsonb;
begin
  select org_id, to_jsonb(x) into v_org, v_old from app.products x where id = p_product;
  if v_org is null then raise exception 'NOT_FOUND: 物料不存在'; end if;
  perform app.require_role(v_org, 'admin');
  if p ? 'model' and coalesce(trim(p->>'model'), '') = '' then raise exception 'VALIDATION: 型号不能空'; end if;
  update app.products set
    model = case when p ? 'model' then upper(regexp_replace(trim(p->>'model'), '\s+', ' ', 'g')) else model end,
    category_id = case when p ? 'category_id' then (p->>'category_id')::uuid else category_id end,
    brand = case when p ? 'brand' then nullif(trim(p->>'brand'), '') else brand end,
    variant = case when p ? 'variant' then nullif(trim(p->>'variant'), '') else variant end,
    shared_models = case when p ? 'shared_models' then coalesce(array(select upper(trim(x)) from jsonb_array_elements_text(p->'shared_models') x where trim(x) <> ''), '{}') else shared_models end
  where id = p_product;
  perform app.audit(v_org, 'edit_product_info', 'products', p_product, jsonb_build_object('new', p));
exception when unique_violation then raise exception 'VALIDATION: 同种类下已经有这个型号了';
end $$;

-- ④ 档案修改记录: 三种档案 (product / customer / employee) 每次保存记一条: 改了哪几项、旧值 → 新值、自检报警、原因
create or replace function app.log_archive_edit(p_org uuid, p_kind text, p_id uuid, p_changes jsonb, p_warnings jsonb default null, p_reason text default null)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.is_member(p_org) then raise exception 'FORBIDDEN'; end if;
  if p_kind not in ('product', 'customer', 'employee') then raise exception 'VALIDATION: 档案类型不对'; end if;
  perform app.audit(p_org, 'archive_edit', p_kind, p_id, jsonb_build_object('changes', p_changes, 'warnings', p_warnings, 'reason', nullif(p_reason, '')));
end $$;

create or replace function app.archive_history(p_org uuid, p_kind text, p_id uuid)
returns table (at timestamptz, by_name text, action text, detail jsonb) language sql security definer set search_path = app, public as $$
  select a.at, coalesce(e.short_name, '—'), a.action, a.detail
  from app.audit_log a
  left join app.members m on m.org_id = a.org_id and m.user_id = a.user_id
  left join app.employees e on e.id = m.employee_id
  where a.org_id = p_org and a.entity_id = p_id and app.is_member(p_org)
    and (a.action = 'archive_edit' or (p_kind = 'product' and a.action in ('edit_product_info', 'save_product_batch')))
  order by a.at desc limit 200
$$;

revoke all on function app.set_batch_freight(uuid, text, numeric, int), app.edit_product_info(uuid, jsonb),
  app.log_archive_edit(uuid, text, uuid, jsonb, jsonb, text), app.archive_history(uuid, text, uuid) from public;
grant execute on function app.set_batch_freight(uuid, text, numeric, int), app.edit_product_info(uuid, jsonb),
  app.log_archive_edit(uuid, text, uuid, jsonb, jsonb, text), app.archive_history(uuid, text, uuid) to authenticated;
