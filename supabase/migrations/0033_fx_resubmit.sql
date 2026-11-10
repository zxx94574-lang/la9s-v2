-- LA&9S Operations · 0033 (Frank 11-09 19:10 总盘点)
--  190 非 XOF 报价: 汇率每张单手填 (1 CNY / 1 USD = ? XOF), 档位价 = XOF 档位价 ÷ 汇率, 两位小数; 锁在单子上
--  191 驳回 ≠ 作废: 单子照常可用; 「重新提交审批」; 客户还款 / 总账变动后自动重新评估 (原因没了 → 自动通过)
--  202 退货: 对完账才算完成, 检验不卡「对账完成」(没检验完的另作仓库待办)
alter table app.deals add column fx_rate numeric(14,6);

create or replace function app.deal_price(p_deal app.deals, p_prod uuid)
returns numeric language sql stable security definer set search_path = app, public as $$
  select case when p_prod is null then null
              when p_deal.currency = 'XOF' then app.tier_price(p_prod, p_deal.customer_id, 'XOF')
              when coalesce(p_deal.fx_rate, 0) > 0 then round(app.tier_price(p_prod, p_deal.customer_id, 'XOF') / p_deal.fx_rate, 2)
         end
$$;
revoke all on function app.deal_price(app.deals, uuid) from public;

create or replace function app.reprice_fx(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.currency = 'XOF' then return; end if;
  update app.deal_lines l set unit_price = coalesce(app.deal_price(d, l.product_id), 0)
   where l.deal_id = p_deal and l.product_id is not null and not l.price_manual;
end $$;
revoke all on function app.reprice_fx(uuid) from public;

-- 获取价格: 外币单按单上汇率折算
create or replace function app.refresh_prices(p_deal uuid, p_line_ids uuid[])
returns int language plpgsql security definer set search_path = app, public as $$
declare d app.deals; n int;
begin
  select * into d from app.deals where id = p_deal;
  perform app.require_role(d.org_id, 'manager', 'hotline', 'sales');
  d := app.lock_deal(p_deal, array['quoted','hotline_ok','picking','picked','reviewed']::app.deal_status[]);
  update app.deal_lines l set unit_price = coalesce(app.deal_price(d, l.product_id), l.unit_price)
  where l.deal_id = p_deal and l.id = any(p_line_ids) and not l.price_manual and l.product_id is not null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function app.check_quote_prices(p_deal uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_bad text; v_tier app.customer_tier;
begin
  select c.tier into v_tier from app.deals d join app.customers c on c.id = d.customer_id where d.id = p_deal;
  select string_agg(coalesce(p.code,'') || ' ' || p.model, '、' order by dl.seq) into v_bad
    from app.deal_lines dl join app.products p on p.id = dl.product_id
   where dl.deal_id = p_deal and coalesce(dl.unit_price, 0) <= 0 and coalesce(dl.requested_price, 0) <= 0;
  if v_bad is not null then
    raise exception 'VALIDATION: 这些型号在「%」档没有价格，报价单不能带 0：%。先到「物料与定价」填价，或在单价格子里直接给价', v_tier, v_bad;
  end if;
  if exists (select 1 from app.deal_lines where deal_id = p_deal and coalesce(qty_req,0) <= 0) then raise exception 'VALIDATION: 数量不能为 0'; end if;
end $$;
revoke all on function app.check_quote_prices(uuid) from public;

-- 建报价 (含外币): XOF 走原来的 create_quote_priced; 外币必须给汇率
create or replace function app.create_quote_fx(p_org uuid, p_customer uuid, p_currency text, p_lines jsonb, p_note text, p_fx numeric)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid;
begin
  if coalesce(p_currency, 'XOF') = 'XOF' then return app.create_quote_priced(p_org, p_customer, 'XOF', p_lines, p_note); end if;
  if coalesce(p_fx, 0) <= 0 then raise exception 'VALIDATION: 外币报价要先填汇率（1 % = ? XOF）', p_currency; end if;
  v_id := app.create_quote(p_org, p_customer, p_currency,
    (select coalesce(jsonb_agg(x - 'unit_price' - 'requested_price'), '[]') from jsonb_array_elements(p_lines) x), p_note);
  update app.deals set fx_rate = p_fx where id = v_id;
  perform app.reprice_fx(v_id);
  perform app.apply_line_prices(v_id, p_lines);
  perform app.check_quote_prices(v_id);
  perform app.deal_event(v_id, 'fx_set', jsonb_build_object('currency', p_currency, 'fx', p_fx));
  return v_id;
end $$;

create or replace function app.edit_quote_fx(p_deal uuid, p_lines jsonb, p_remove uuid[], p_fx numeric)
returns int language plpgsql security definer set search_path = app, public as $$
declare d app.deals; v_keep jsonb; n int;
begin
  select * into d from app.deals where id = p_deal;
  if d.currency <> 'XOF' then
    if coalesce(p_fx, d.fx_rate, 0) <= 0 then raise exception 'VALIDATION: 外币报价要先填汇率'; end if;
    if p_fx is not null and p_fx is distinct from d.fx_rate then
      update app.deals set fx_rate = p_fx where id = p_deal;
      perform app.deal_event(p_deal, 'fx_set', jsonb_build_object('currency', d.currency, 'fx', p_fx, 'from', d.fx_rate));
    end if;
  end if;
  select coalesce(jsonb_object_agg(product_id::text, unit_price), '{}') into v_keep from app.deal_lines where deal_id = p_deal and price_manual and product_id is not null;
  perform app.edit_quote(p_deal, p_lines, p_remove);
  perform app.reprice_fx(p_deal);
  n := app.apply_line_prices(p_deal, p_lines, v_keep);
  return n;
end $$;

-- 191 重新提交审批
create or replace function app.resubmit_approval(p_deal uuid, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare d app.deals; r text[]; v text;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'manager', 'hotline', 'sales', 'sales_manager');
  if d.status <> 'quoted' then raise exception 'BAD_STATE: 只有报价阶段的单能重新提交审批'; end if;
  if d.approval not in ('rejected', 'pending') then raise exception 'BAD_STATE: 这张单不在审批中'; end if;
  r := app.approval_reasons(p_deal);
  v := case when coalesce(array_length(r, 1), 0) = 0 then 'auto' else 'pending' end;
  update app.deals set approval = v, approval_reasons = r, approval_note = null where id = p_deal;
  perform app.deal_event(p_deal, 'approval_resubmitted', jsonb_build_object('note', p_note, 'reasons', to_jsonb(r), 'result', v));
  return v;
end $$;

-- 191 总账变动 (收款 / 撤销 / 退货 / 出库) → 这个客户报价阶段的单重新评估: 原因都没了 → 自动通过
create or replace function app.trg_ar_reevaluate() returns trigger language plpgsql security definer set search_path = app, public as $$
declare x record; r text[];
begin
  for x in select id, approval from app.deals where customer_id = new.customer_id and status = 'quoted' and approval in ('pending', 'rejected') loop
    r := app.approval_reasons(x.id);
    if coalesce(array_length(r, 1), 0) = 0 then
      update app.deals set approval = 'auto', approval_reasons = r where id = x.id;
      perform app.deal_event(x.id, 'approval_auto_cleared', jsonb_build_object('why', '客户总账变动后不再需要审批'));
    elsif x.approval = 'pending' then
      update app.deals set approval_reasons = r where id = x.id;
    end if;
  end loop;
  return new;
end $$;
create trigger ar_reevaluate after insert on app.ar_entries for each row execute function app.trg_ar_reevaluate();

-- 202 对完账才算完成; 检验不卡对账完成
create or replace function app.return_reconciled(p_return uuid, p_proof text)
returns void language plpgsql security definer set search_path = app, public as $$
declare r app.returns;
begin
  if coalesce(p_proof, '') = '' then raise exception 'VALIDATION: 先放客户确认凭证截图，再点对账完成'; end if;
  select * into r from app.returns where id = p_return for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(r.org_id, 'hotline', 'manager', 'sales_manager', 'finance');
  if r.status <> 'approved' then raise exception 'BAD_STATE: 退货还没批准'; end if;
  update app.returns set reconciled_at = now(), reconciled_by = app.uid(), reconciled_proof = p_proof where id = p_return;
  perform app.deal_event(r.deal_id, 'return_reconciled', jsonb_build_object('rt_no', r.rt_no));
end $$;

-- 没走完的退货: 对账完成后还没检验完的, 继续挂成仓库待办
drop view app.v_open_returns;
create view app.v_open_returns as
select r.*, d.biz_no, c.name as customer_name,
  case when r.status = 'requested' then 'decide'
       when r.status = 'approved' and r.reconciled_at is null then 'reconcile'
       when r.status = 'approved' and exists (select 1 from app.return_lines rl where rl.return_id = r.id and coalesce(rl.qty_good,0) + coalesce(rl.qty_scrap,0) < rl.qty) then 'inspect' end as pending
from app.returns r join app.deals d on d.id = r.deal_id join app.customers c on c.id = r.customer_id
where r.status = 'requested'
   or (r.status = 'approved' and (r.reconciled_at is null
       or exists (select 1 from app.return_lines rl where rl.return_id = r.id and coalesce(rl.qty_good,0) + coalesce(rl.qty_scrap,0) < rl.qty)));
alter view app.v_open_returns set (security_invoker = true);
grant select on app.v_open_returns to authenticated;

revoke all on function app.create_quote_fx(uuid, uuid, text, jsonb, text, numeric), app.edit_quote_fx(uuid, jsonb, uuid[], numeric), app.resubmit_approval(uuid, text) from public;
grant execute on function app.create_quote_fx(uuid, uuid, text, jsonb, text, numeric), app.edit_quote_fx(uuid, jsonb, uuid[], numeric), app.resubmit_approval(uuid, text) to authenticated;
