-- 0083 (Frank 11-23 00:36): 经营总览「FOB 销售与毛利」是空的 —— 原来只算从 FOB 仓走普通订单卖的货, FOB 项目自己的出库没算进去.
-- 现在: 每次 FOB 出库 (fob_ship2) 记一行出了多少 → 经营总览 / 毛利按出库那天算进 FOB.
create table if not exists app.fob_ship_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references app.fob_projects(id) on delete cascade,
  line_id uuid not null references app.fob_lines(id) on delete cascade,
  qty int not null check (qty > 0),
  shipped_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists fob_ship_lines_p on app.fob_ship_lines (project_id);
alter table app.fob_ship_lines enable row level security;
drop policy if exists read_own on app.fob_ship_lines;
create policy read_own on app.fob_ship_lines for select using (exists (select 1 from app.fob_projects f where f.id = project_id and app.is_member(f.org_id)));
grant select on app.fob_ship_lines to authenticated;

-- 老的出库记录补进来: 新的 (0081 起) 事件里带了每行数量; 更老的一次全出 = 当时每行已出的数量
insert into app.fob_ship_lines (project_id, line_id, qty, shipped_on)
select e.project_id, (r->>'line_id')::uuid, (r->>'qty')::int, (e.at at time zone 'Africa/Abidjan')::date
from app.fob_events e, jsonb_array_elements(e.detail->'rows') r
where e.action = 'shipped' and e.detail ? 'rows' and (r->>'qty')::int > 0
  and not exists (select 1 from app.fob_ship_lines x where x.project_id = e.project_id);
insert into app.fob_ship_lines (project_id, line_id, qty, shipped_on)
select l.project_id, l.id, l.qty_shipped, (select (max(e.at) at time zone 'Africa/Abidjan')::date from app.fob_events e where e.project_id = l.project_id and e.action = 'shipped')
from app.fob_lines l
where l.qty_shipped > 0 and not exists (select 1 from app.fob_ship_lines x where x.project_id = l.project_id)
  and exists (select 1 from app.fob_events e where e.project_id = l.project_id and e.action = 'shipped');

-- 出库时记一行 (fob_ship2 末尾的事件里已经有 rows, 这里用触发器从事件取, 不改 fob_ship2 本身)
create or replace function app.trg_fob_ship_lines() returns trigger language plpgsql security definer set search_path = app, public as $$
declare r jsonb;
begin
  if new.action = 'shipped' and new.detail ? 'rows' then
    for r in select * from jsonb_array_elements(new.detail->'rows') loop
      continue when coalesce((r->>'qty')::int, 0) <= 0;
      insert into app.fob_ship_lines (project_id, line_id, qty, shipped_on) values (new.project_id, (r->>'line_id')::uuid, (r->>'qty')::int, (new.at at time zone 'Africa/Abidjan')::date);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists fob_ship_lines on app.fob_events;
create trigger fob_ship_lines after insert on app.fob_events for each row execute function app.trg_fob_ship_lines();

drop function if exists app.dash_rows(uuid);
create or replace function app.dash_rows(p_org uuid)
returns table (
  shipment_line_id uuid, deal_id uuid, biz_no text, shipped_on date, customer_id uuid, customer_name text, supply text, tier app.customer_tier,
  product_id uuid, product_code text, model text, category text, qty numeric, revenue numeric, cost numeric, profit numeric, cost_missing boolean,
  returned numeric, adjust numeric, currency text, k numeric, rmb_per_xof numeric, xof_per_usd numeric, fob_project_id uuid)
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
    coalesce(h.rmb_per_xof, ps.rmb_per_xof)::numeric, coalesce(h.xof_per_usd, ps.xof_per_usd)::numeric, null::uuid
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
    coalesce(h.rmb_per_xof, ps.rmb_per_xof)::numeric, coalesce(h.xof_per_usd, ps.xof_per_usd)::numeric, f.id
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
