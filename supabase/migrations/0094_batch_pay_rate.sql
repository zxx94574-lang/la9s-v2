-- 0094 批次付款汇率（待改 329 后半）：每批记当时实际付款汇率（1 外币 = 多少 XOF）；
-- 挂牌价用的「在库最贵那批成本」= 这批按付款汇率算的成本 和 按最新定价汇率算的成本 取高（保守：两种都算，取贵的）
alter table app.product_batches add column if not exists pay_rate numeric(14,6);
create or replace function app.save_product_batch(p_product uuid, p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_id uuid := p_id;
begin
  select org_id into v_org from app.products where id = p_product;
  if v_org is null then raise exception 'NOT_FOUND: 物料不存在'; end if;
  perform app.require_role(v_org, 'admin');
  if coalesce((p->>'qty')::numeric, 0) <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
  if (p->>'unit_price') is null or (p->>'unit_price')::numeric < 0 then raise exception 'VALIDATION: 采购单价必填'; end if;
  if nullif(p->>'pay_rate','') is not null and (p->>'pay_rate')::numeric <= 0 then raise exception 'VALIDATION: 付款汇率要大于 0'; end if;
  if nullif(p->>'freight_total','') is not null and coalesce(nullif(p->>'freight_pieces','')::numeric, 0) <= 0 then
    raise exception 'VALIDATION: 填了这批总运费，就要填这批一共多少片（用来算每片运费）';
  end if;
  if v_id is null then
    insert into app.product_batches (org_id, product_id, po_no, ordered_on, qty, currency, unit_price, freight_xof, freight_total, freight_pieces, source, note, pay_rate, created_by)
    values (v_org, p_product, nullif(trim(p->>'po_no'),''), nullif(p->>'ordered_on','')::date, (p->>'qty')::numeric::int,
      coalesce(nullif(upper(p->>'currency'),''), 'CNY'), (p->>'unit_price')::numeric, nullif(p->>'freight_xof','')::numeric,
      nullif(p->>'freight_total','')::numeric, nullif(p->>'freight_pieces','')::numeric::int,
      coalesce(nullif(p->>'source',''), 'manual'), nullif(p->>'note',''), nullif(p->>'pay_rate','')::numeric, app.uid())
    returning id into v_id;
  else
    update app.product_batches set po_no = nullif(trim(p->>'po_no'),''), ordered_on = nullif(p->>'ordered_on','')::date, qty = (p->>'qty')::numeric::int,
      currency = coalesce(nullif(upper(p->>'currency'),''), 'CNY'), unit_price = (p->>'unit_price')::numeric,
      freight_xof = nullif(p->>'freight_xof','')::numeric, freight_total = nullif(p->>'freight_total','')::numeric,
      freight_pieces = nullif(p->>'freight_pieces','')::numeric::int, note = nullif(p->>'note',''), pay_rate = nullif(p->>'pay_rate','')::numeric
    where id = v_id and product_id = p_product;
    if not found then raise exception 'NOT_FOUND: 批次不存在'; end if;
  end if;
  perform app.audit(v_org, 'save_product_batch', 'products', p_product, p || jsonb_build_object('batch_id', v_id));
  return v_id;
end $$;

