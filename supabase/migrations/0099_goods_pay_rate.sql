-- 0099 国内财务记货款时填汇率 → 自动写进这张采购单批次的「付款汇率」（Frank 11-25：按 Claude 建议，付款汇率由国内财务付完工厂货款时填）
create or replace function app.record_po_payment(p_po uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare po app.purchase_orders; v_id uuid; v_amt numeric := nullif(p->>'amount', '')::numeric; v_cur text := coalesce(nullif(p->>'currency', ''), 'CNY');
  v_rate numeric := nullif(p->>'xof_per_unit', '')::numeric; v_frt numeric; v_pcs int; l record;
begin
  select * into po from app.purchase_orders where id = p_po;
  if po.id is null then raise exception 'NOT_FOUND: 采购单'; end if;
  perform app.require_role(po.org_id, 'cn_finance');
  if coalesce(p->>'kind', '') not in ('goods','freight') then raise exception 'VALIDATION: 选货款还是运费'; end if;
  if coalesce(v_amt, 0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if coalesce(p->>'proof', '') = '' then raise exception 'VALIDATION: 付款要传凭证（银行回单 / 转账截图）'; end if;
  if p->>'kind' = 'freight' and v_cur <> 'XOF' and coalesce(v_rate, 0) <= 0 then raise exception 'VALIDATION: 运费不是西法，要填汇率（1 % = ? 西法）', v_cur; end if;
  insert into app.po_payments (org_id, po_id, kind, on_date, amount, currency, xof_per_unit, proof, note, created_by)
  values (po.org_id, p_po, p->>'kind', coalesce(nullif(p->>'on_date', '')::date, current_date), v_amt, v_cur, v_rate, p->>'proof', nullif(trim(p->>'note'), ''), app.uid())
  returning id into v_id;
  -- 运费: 这张采购单所有运费合计折西法 ÷ 总片数 → 进这批的成本 (和「档案 → 批次运费」同一个算法, 每片向上进 50)
  -- 货款带了汇率（1 CNY = ? 西法）→ 这张单批次的「付款汇率」= 这张单所有带汇率货款的加权平均（成本按实际付款算）
  if p->>'kind' = 'goods' and coalesce(v_rate, 0) > 0 then
    for l in select pl.product_id, sum(pl.qty)::int as qty, max(pl.unit_price) as price, max(pl.currency) as cur from app.po_lines pl
             where pl.po_id = p_po and pl.product_id is not null and pl.unit_price is not null group by pl.product_id loop
      if not exists (select 1 from app.product_batches b where b.product_id = l.product_id and b.po_no = po.po_no) then
        insert into app.product_batches (org_id, product_id, po_no, ordered_on, qty, currency, unit_price, source, note, created_by)
        values (po.org_id, l.product_id, po.po_no, coalesce(po.ordered_on, po.shipped_on, current_date), l.qty, coalesce(l.cur, 'CNY'), l.price, 'manual', '国内财务登记货款时按采购单补的批次', app.uid());
      end if;
    end loop;
    update app.product_batches b set pay_rate = x.r
      from (select sum(amount * xof_per_unit) / nullif(sum(amount), 0) as r from app.po_payments where po_id = p_po and kind = 'goods' and xof_per_unit > 0 and currency = v_cur) x
      where b.org_id = po.org_id and b.po_no = po.po_no and b.currency = v_cur and x.r > 0;
  end if;
  if p->>'kind' = 'freight' then
    select coalesce(sum(case when currency = 'XOF' then amount else amount * xof_per_unit end), 0) into v_frt from app.po_payments where po_id = p_po and kind = 'freight';
    select coalesce(sum(qty), 0) into v_pcs from app.po_lines where po_id = p_po;
    -- 这张单的货还没有批次的, 按采购单价补一条批次 (有单价、对上编码的才补)
    for l in select pl.product_id, sum(pl.qty)::int as qty, max(pl.unit_price) as price, max(pl.currency) as cur from app.po_lines pl
             where pl.po_id = p_po and pl.product_id is not null and pl.unit_price is not null group by pl.product_id loop
      if not exists (select 1 from app.product_batches b where b.product_id = l.product_id and b.po_no = po.po_no) then
        insert into app.product_batches (org_id, product_id, po_no, ordered_on, qty, currency, unit_price, source, note, created_by)
        values (po.org_id, l.product_id, po.po_no, coalesce(po.ordered_on, po.shipped_on, current_date), l.qty, coalesce(l.cur, 'CNY'), l.price, 'manual', '国内财务登记运费时按采购单补的批次', app.uid());
      end if;
    end loop;
    if v_pcs > 0 then update app.product_batches set freight_total = v_frt, freight_pieces = v_pcs where org_id = po.org_id and po_no = po.po_no; end if;
  end if;
  perform app.audit(po.org_id, 'record_po_payment', 'purchase_orders', p_po, p);
  return v_id;
end $$;
