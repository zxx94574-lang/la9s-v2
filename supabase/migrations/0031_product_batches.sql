-- LA&9S Operations · 0031 物料采购批次 (Frank 11-09 14:45: 采购单价不同要记录下来, 按我设定的最新汇率换成西法, 好评定给客户多少钱才不亏)
--   每批 = 一张采购单里这个编码的一行: 采购单号 / 日期 / 数量 / 单价 + 币别 (金蝶采购单是 USD, 手录可 CNY)
--   折合西法用设置里「最新」汇率 (不是当时付款汇率): CNY ÷ rmb_per_xof, USD × xof_per_usd; 再加物料每件运费, 进到 round_to
alter table app.price_settings add column xof_per_usd numeric(12,4) not null default 600;

create table app.product_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  product_id uuid not null references app.products(id) on delete cascade,
  po_no text,                                   -- 采购单号 (金蝶 PO…) / 批次号
  ordered_on date,
  qty int not null check (qty > 0),
  currency text not null default 'CNY' check (currency in ('CNY','USD','XOF')),
  unit_price numeric(18,6) not null check (unit_price >= 0),
  freight_xof numeric(18,2),                    -- 这批每件运费 (空 = 用物料默认运费)
  source text not null default 'manual' check (source in ('manual','kingdee')),
  note text,
  created_by uuid, created_at timestamptz not null default now()
);
create index on app.product_batches (product_id, ordered_on);
alter table app.product_batches enable row level security;
create policy read_admin on app.product_batches for select using (app.has_role(org_id, array['admin']::app.role_name[]));
grant select on app.product_batches to authenticated;

create or replace function app.save_product_batch(p_product uuid, p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_id uuid := p_id;
begin
  select org_id into v_org from app.products where id = p_product;
  if v_org is null then raise exception 'NOT_FOUND: 物料不存在'; end if;
  perform app.require_role(v_org, 'admin');
  if coalesce((p->>'qty')::numeric, 0) <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
  if (p->>'unit_price') is null or (p->>'unit_price')::numeric < 0 then raise exception 'VALIDATION: 采购单价必填'; end if;
  if v_id is null then
    insert into app.product_batches (org_id, product_id, po_no, ordered_on, qty, currency, unit_price, freight_xof, source, note, created_by)
    values (v_org, p_product, nullif(trim(p->>'po_no'),''), nullif(p->>'ordered_on','')::date, (p->>'qty')::numeric::int,
      coalesce(nullif(upper(p->>'currency'),''), 'CNY'), (p->>'unit_price')::numeric, nullif(p->>'freight_xof','')::numeric,
      coalesce(nullif(p->>'source',''), 'manual'), nullif(p->>'note',''), app.uid())
    returning id into v_id;
  else
    update app.product_batches set po_no = nullif(trim(p->>'po_no'),''), ordered_on = nullif(p->>'ordered_on','')::date, qty = (p->>'qty')::numeric::int,
      currency = coalesce(nullif(upper(p->>'currency'),''), 'CNY'), unit_price = (p->>'unit_price')::numeric,
      freight_xof = nullif(p->>'freight_xof','')::numeric, note = nullif(p->>'note','')
    where id = v_id and product_id = p_product;
    if not found then raise exception 'NOT_FOUND: 批次不存在'; end if;
  end if;
  perform app.audit(v_org, 'save_product_batch', 'product_batches', v_id, p);
  return v_id;
end $$;

create or replace function app.delete_product_batch(p_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.product_batches where id = p_id;
  if v_org is null then raise exception 'NOT_FOUND: 批次不存在'; end if;
  perform app.require_role(v_org, 'admin');
  delete from app.product_batches where id = p_id;
  perform app.audit(v_org, 'delete_product_batch', 'product_batches', p_id, '{}');
end $$;

-- 批量导入 (金蝶采购订单导出 / Excel): [{code, po_no, ordered_on, qty, unit_price, currency, freight_xof?}]
-- 同编码 + 同采购单号 → 更新那一条 (重复导不重复); 不认识的编码退回
create or replace function app.import_product_batches(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare x jsonb; v_p uuid; v_id uuid; n_new int := 0; n_upd int := 0; v_bad jsonb := '[]';
begin
  perform app.require_role(p_org, 'admin');
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into v_p from app.products where org_id = p_org and code = trim(x->>'code');
    if v_p is null then v_bad := v_bad || jsonb_build_array(x || jsonb_build_object('why', '编码不在物料库')); continue; end if;
    if coalesce((x->>'qty')::numeric, 0) <= 0 or (x->>'unit_price') is null then v_bad := v_bad || jsonb_build_array(x || jsonb_build_object('why', '数量 / 单价缺')); continue; end if;
    v_id := null;
    if nullif(trim(x->>'po_no'),'') is not null then
      select id into v_id from app.product_batches where product_id = v_p and po_no = trim(x->>'po_no') limit 1;
    end if;
    perform app.save_product_batch(v_p, v_id, x);
    if v_id is null then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
  end loop;
  return jsonb_build_object('inserted', n_new, 'updated', n_upd, 'bad_rows', v_bad);
end $$;

create or replace function app.set_usd_rate(p_org uuid, p_xof_per_usd numeric)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(p_xof_per_usd, 0) <= 0 then raise exception 'VALIDATION: 美元汇率要大于 0'; end if;
  insert into app.price_settings (org_id) values (p_org) on conflict do nothing;
  update app.price_settings set xof_per_usd = p_xof_per_usd, updated_by = app.uid(), updated_at = now() where org_id = p_org;
  perform app.audit(p_org, 'set_usd_rate', 'price_settings', null, jsonb_build_object('xof_per_usd', p_xof_per_usd));
end $$;

revoke all on function app.save_product_batch(uuid, uuid, jsonb), app.delete_product_batch(uuid), app.import_product_batches(uuid, jsonb), app.set_usd_rate(uuid, numeric) from public;
grant execute on function app.save_product_batch(uuid, uuid, jsonb), app.delete_product_batch(uuid), app.import_product_batches(uuid, jsonb), app.set_usd_rate(uuid, numeric) to authenticated;

-- 种类管理 (Frank 11-09 13:17: 种类要跟物料表联动, 加减都跟着): 改名 / 合并 / 删空种类, 只中方, 留痕
create or replace function app.rename_category(p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_name text := upper(trim(coalesce(p_name, '')));
begin
  select org_id into v_org from app.categories where id = p_id;
  if v_org is null then raise exception 'NOT_FOUND: 种类不存在'; end if;
  perform app.require_role(v_org, 'admin');
  if v_name = '' then raise exception 'VALIDATION: 名字不能空'; end if;
  if exists (select 1 from app.categories where org_id = v_org and upper(name) = v_name and id <> p_id) then raise exception 'VALIDATION: 已经有叫「%」的种类，要并过去请用「合并到」', v_name; end if;
  update app.categories set name = trim(p_name) where id = p_id;
  perform app.audit(v_org, 'rename_category', 'categories', p_id, jsonb_build_object('name', p_name));
end $$;

create or replace function app.merge_category(p_from uuid, p_into uuid)
returns int language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; n int;
begin
  select org_id into v_org from app.categories where id = p_from;
  if v_org is null or not exists (select 1 from app.categories where id = p_into and org_id = v_org) then raise exception 'NOT_FOUND: 种类不存在'; end if;
  if p_from = p_into then raise exception 'VALIDATION: 不能合并到自己'; end if;
  perform app.require_role(v_org, 'admin');
  begin
    update app.products set category_id = p_into where category_id = p_from;
    get diagnostics n = row_count;
  exception when unique_violation then
    raise exception 'VALIDATION: 两个种类里有同型号同区分的物料（编码不同），不能直接合并；先在物料名称管理里把型号 / 区分分开';
  end;
  update app.deal_lines set req_category_id = p_into where req_category_id = p_from;
  delete from app.categories where id = p_from;
  perform app.audit(v_org, 'merge_category', 'categories', p_from, jsonb_build_object('into', p_into, 'products', n));
  return n;
end $$;

create or replace function app.delete_category(p_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.categories where id = p_id;
  if v_org is null then raise exception 'NOT_FOUND: 种类不存在'; end if;
  perform app.require_role(v_org, 'admin');
  if exists (select 1 from app.products where category_id = p_id) then raise exception 'BAD_STATE: 这个种类下面还有物料，先合并到别的种类'; end if;
  if exists (select 1 from app.deal_lines where req_category_id = p_id) then raise exception 'BAD_STATE: 有订单里的补录需求用着这个种类，请用「合并到」'; end if;
  delete from app.categories where id = p_id;
  perform app.audit(v_org, 'delete_category', 'categories', p_id, '{}');
end $$;
revoke all on function app.rename_category(uuid, text), app.merge_category(uuid, uuid), app.delete_category(uuid) from public;
grant execute on function app.rename_category(uuid, text), app.merge_category(uuid, uuid), app.delete_category(uuid) to authenticated;

-- 改价规则 (Frank 11-09 13:45 / 13:51): 报价时谁都能改价; 中方改 = 直接生效 (手改留痕 + 提示); 员工改 = 申请价, 要中方审批, 批了才能下推
--   p_lines 每行可带 unit_price (只中方) 或 requested_price (员工申请). 行按顺序对应 deal_lines.seq.
create or replace function app.apply_line_prices(p_deal uuid, p_lines jsonb, p_keep jsonb default '{}')
returns int language plpgsql security definer set search_path = app, public as $$
declare d app.deals; x jsonb; l record; i int := 0; n_req int := 0; v_admin boolean;
begin
  select * into d from app.deals where id = p_deal;
  v_admin := app.has_role(d.org_id, array['admin']::app.role_name[]);
  for l in select id, unit_price, product_id from app.deal_lines where deal_id = p_deal order by seq loop
    x := p_lines -> i; i := i + 1;
    exit when x is null;
    if coalesce((x->>'unit_price')::numeric, 0) > 0 and l.product_id is not null then
      if v_admin then
        update app.deal_lines set unit_price = (x->>'unit_price')::numeric, price_manual = true, price_set_by = app.uid(), requested_price = null where id = l.id;
        if (x->>'unit_price')::numeric is distinct from l.unit_price then
          perform app.deal_event(p_deal, 'price_set', jsonb_build_object('line', l.id, 'from', l.unit_price, 'to', (x->>'unit_price')::numeric, 'reason', coalesce(nullif(x->>'price_reason',''), '中方报价时改价')));
        end if;
        continue;   -- 中方给了价就不算申请
      end if;
      -- 员工改单时原样带回中方原来的手改价 (同物料同价) 可以, 别的不行
      if (p_keep ->> l.product_id::text)::numeric is distinct from (x->>'unit_price')::numeric then
        raise exception 'PERMISSION_DENIED: 只有中方能直接改价，员工改价请走申请';
      end if;
      update app.deal_lines set unit_price = (x->>'unit_price')::numeric, price_manual = true where id = l.id;
    end if;
    if not v_admin and coalesce((x->>'requested_price')::numeric, 0) > 0 and l.product_id is not null then
      update app.deal_lines set requested_price = (x->>'requested_price')::numeric where id = l.id;
      perform app.deal_event(p_deal, 'price_requested', jsonb_build_object('line', l.id, 'to', (x->>'requested_price')::numeric));
      n_req := n_req + 1;
    end if;
  end loop;
  if n_req > 0 then
    if d.status <> 'quoted' then raise exception 'BAD_STATE: 已经确认下推的单不能申请改价，先撤回到「报价 · 确认」'; end if;
    update app.deals set approval = 'pending', approval_reasons = app.approval_reasons(p_deal) where id = p_deal;
  end if;
  return n_req;
end $$;
revoke all on function app.apply_line_prices(uuid, jsonb, jsonb) from public;

create or replace function app.create_quote_priced(p_org uuid, p_customer uuid, p_currency text, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid; v_plain jsonb;
begin
  -- 先按原规则建单 (中方给的价在 create_quote_checked 里落), 员工申请价另外记
  select coalesce(jsonb_agg(x - 'requested_price'), '[]') into v_plain from jsonb_array_elements(p_lines) x;
  v_id := app.create_quote_checked(p_org, p_customer, p_currency, v_plain, p_note);
  perform app.apply_line_prices(v_id, (select coalesce(jsonb_agg(x - 'unit_price'), '[]') from jsonb_array_elements(p_lines) x));
  return v_id;
end $$;

create or replace function app.edit_quote_priced(p_deal uuid, p_lines jsonb, p_remove uuid[] default '{}')
returns int language plpgsql security definer set search_path = app, public as $$
declare v_keep jsonb;
begin
  select coalesce(jsonb_object_agg(product_id::text, unit_price), '{}') into v_keep from app.deal_lines where deal_id = p_deal and price_manual and product_id is not null;
  perform app.edit_quote(p_deal, p_lines, p_remove);
  return app.apply_line_prices(p_deal, p_lines, v_keep);
end $$;
revoke all on function app.create_quote_priced(uuid, uuid, text, jsonb, text), app.edit_quote_priced(uuid, jsonb, uuid[]) from public;
grant execute on function app.create_quote_priced(uuid, uuid, text, jsonb, text), app.edit_quote_priced(uuid, jsonb, uuid[]) to authenticated;
