-- 0104 (Frank 11-26 16:22, 待改 523): 经营总览的毛利 = 销售额 − 货的成本; 我们出的运费不再在毛利里扣, 统一算进「日常开支」(资金流水里记的支出都算).
-- dash_rows 多给一列 freight (这一行分摊到的我们出的运费, XOF), 看板拿 cost − freight 当货的成本. margin_rows 不动 (亏钱拦截照旧按含运费的成本).
drop function if exists app.dash_rows(uuid);
create or replace function app.dash_rows(p_org uuid)
returns table (
  shipment_line_id uuid, deal_id uuid, biz_no text, shipped_on date, customer_id uuid, customer_name text, supply text, tier app.customer_tier,
  product_id uuid, product_code text, model text, category text, qty numeric, revenue numeric, cost numeric, profit numeric, cost_missing boolean,
  returned numeric, adjust numeric, currency text, k numeric, rmb_per_xof numeric, xof_per_usd numeric, fob_project_id uuid, freight numeric)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
begin
  perform app.require_role(p_org, 'admin');
  return query
  select m.shipment_line_id, m.deal_id, m.biz_no, m.shipped_on, m.customer_id, m.customer_name, m.supply, m.tier,
    m.product_id, m.product_code, m.model, m.category, m.qty, m.revenue, m.cost, m.profit, m.cost_missing, m.returned, m.adjust,
    d.currency::text,
    (case when d.currency = 'XOF' then 1::numeric
          when coalesce(d.fx_rate, 0) > 0 then d.fx_rate
          when d.currency = 'CNY' then 1 / nullif(ps.rmb_per_xof, 0)
          when d.currency = 'USD' then ps.xof_per_usd else 1 end)::numeric,
    coalesce(h.rmb_per_xof, ps.rmb_per_xof)::numeric, coalesce(h.xof_per_usd, ps.xof_per_usd)::numeric, null::uuid, coalesce(m.freight, 0)::numeric
  from app.margin_rows(p_org) m
  join app.deals d on d.id = m.deal_id
  left join app.price_settings ps on ps.org_id = p_org
  left join lateral (select x.rmb_per_xof, x.xof_per_usd from app.fx_history x
                     where x.org_id = p_org and x.effective_from < m.shipped_on + 1 order by x.effective_from desc limit 1) h on true
  union all
  -- 0083: FOB 项目的出库 (fob_ship2 每一次出了多少) —— 收入 = 出库数 × FOB 单价; 成本 = FOB 汇率算的到岸成本
  select s.id, null::uuid, f.fob_no, s.shipped_on, f.customer_id, c.name, 'fob'::text, c.tier,
    l.product_id, p.code, coalesce(p.model, l.model), cat.name, s.qty::numeric,
    (s.qty * coalesce(l.unit_price, 0) * kk.k)::numeric,
    (s.qty * coalesce(app.landed_cost_at(coalesce(l.rmb_cost, p.fob_rmb, p.rmb_cost), p.freight_xof, ps.rmb_per_xof_fob, ps.round_to), 0))::numeric,
    (s.qty * coalesce(l.unit_price, 0) * kk.k - s.qty * coalesce(app.landed_cost_at(coalesce(l.rmb_cost, p.fob_rmb, p.rmb_cost), p.freight_xof, ps.rmb_per_xof_fob, ps.round_to), 0))::numeric,
    coalesce(l.rmb_cost, p.fob_rmb, p.rmb_cost) is null, 0::numeric, 0::numeric, f.currency::text, kk.k,
    coalesce(h.rmb_per_xof, ps.rmb_per_xof)::numeric, coalesce(h.xof_per_usd, ps.xof_per_usd)::numeric, f.id, 0::numeric
  from app.fob_ship_lines s
  join app.fob_projects f on f.id = s.project_id and f.org_id = p_org
  join app.fob_lines l on l.id = s.line_id
  join app.customers c on c.id = f.customer_id
  left join app.products p on p.id = l.product_id
  left join app.categories cat on cat.id = p.category_id
  left join app.price_settings ps on ps.org_id = p_org
  left join lateral (select x.rmb_per_xof, x.xof_per_usd from app.fx_history x
                     where x.org_id = p_org and x.effective_from < s.shipped_on + 1 order by x.effective_from desc limit 1) h on true
  cross join lateral (select (case when f.currency = 'XOF' then 1::numeric when f.currency = 'CNY' then 1 / nullif(ps.rmb_per_xof, 0)
                                   when f.currency = 'USD' then ps.xof_per_usd else 1 end)::numeric as k) kk;
end $$;

revoke all on function app.dash_rows(uuid) from public;
grant execute on function app.dash_rows(uuid) to authenticated;
