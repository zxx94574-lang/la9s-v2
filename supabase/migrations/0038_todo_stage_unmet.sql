-- 0038 (Frank 11-11 夜, 待改 227 / 234 / 236):
-- ① 中方可以手动把一张单提成「紧急」(待办红色板块)
alter table app.deals add column urgent boolean not null default false;
create or replace function app.set_deal_urgent(p_deal uuid, p_on boolean)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.deals where id = p_deal;
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'admin');
  update app.deals set urgent = coalesce(p_on, false) where id = p_deal;
  perform app.deal_event(p_deal, case when p_on then 'marked_urgent' else 'unmarked_urgent' end, '{}'::jsonb);
end $$;

-- ② 约定发货日不是今天的单: 不提前复检打包, 仓管先把货放到暂存位置 (点「已放好」+ 照片)
alter table app.deals add column staged_at timestamptz, add column staged_by uuid, add column staged_photo text, add column staged_note text;
create or replace function app.mark_staged(p_deal uuid, p_photo text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(d.org_id, 'manager', 'picker');
  if d.status <> 'confirmed' then raise exception 'BAD_STATE: 客户确认之后、复检之前才需要放暂存位置'; end if;
  if coalesce(p_photo, '') = '' then raise exception 'VALIDATION: 放好之后拍一张照片（放在哪、是哪一堆）'; end if;
  update app.deals set staged_at = now(), staged_by = app.uid(), staged_photo = p_photo, staged_note = nullif(trim(coalesce(p_note, '')), '') where id = p_deal;
  perform app.deal_event(p_deal, 'staged', jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')));
end $$;

-- ③ 未满足需求: 报价阶段就记缺口 (客户要 1000、可售只有 40 → 记 960), 不等找货; 找货之后照旧按 需求 − 实际供货
create or replace view app.v_unmet_demand as
select d.org_id, d.id as deal_id, d.biz_no, d.customer_id, d.created_at,
       l.id as line_id, l.product_id, coalesce(p.model, l.req_model) as model,
       coalesce(p.category_id, l.req_category_id) as category_id,
       case when l.product_id is null then 'no_code' else 'short' end as kind,
       l.qty_req - l.qty_supply as qty_unmet
from app.deal_lines l
join app.deals d on d.id = l.deal_id
left join app.products p on p.id = l.product_id
where d.status <> 'cancelled' and d.kind <> 'opening' and l.qty_req > l.qty_supply
  and (l.product_id is null or d.status not in ('quoted','hotline_ok'))
union all
select d.org_id, d.id, d.biz_no, d.customer_id, d.created_at, l.id, l.product_id, p.model, p.category_id, 'short',
       (l.qty_req - greatest(coalesce(st.avail, 0), 0))::int
from app.deal_lines l
join app.deals d on d.id = l.deal_id
join app.products p on p.id = l.product_id
left join lateral (select sum(s.qty_on_hand - s.qty_reserved) as avail from app.stock_items s join app.warehouses w on w.id = s.warehouse_id
                   where s.product_id = l.product_id and w.kind = 'local') st on true
where d.status in ('quoted','hotline_ok') and d.kind <> 'opening' and l.qty_req > greatest(coalesce(st.avail, 0), 0);

revoke all on function app.set_deal_urgent(uuid, boolean), app.mark_staged(uuid, text, text) from public;
grant execute on function app.set_deal_urgent(uuid, boolean), app.mark_staged(uuid, text, text) to authenticated;
alter view app.v_unmet_demand set (security_invoker = true);
