-- LA&9S Operations · 0032 欠款客户: 报价时提醒并决定, 出库前硬拦 (Frank 11-09 15:08 / 15:42 同意)
--   客户开关「有欠款不出货」block_on_debt (只中方): 开了的客户只要还欠 (不算这张单自己), 报价进中方审批; 出库时拦住, 只有中方「放行」才能发
--   没开的客户照旧只提醒 (超上限 / 超账期仍是审批原因)
alter table app.customers add column block_on_debt boolean not null default false;
alter table app.deals add column debt_released_by uuid, add column debt_released_at timestamptz, add column debt_release_note text;

-- 这个客户除这张单以外还欠多少 (XOF; 负数 = 预付)
create or replace function app.debt_other_than(p_deal uuid)
returns numeric language sql stable security definer set search_path = app, public as $$
  select coalesce((select balance from app.v_customer_credit where customer_id = d.customer_id), 0)
       - coalesce((select sum(t.due) from app.v_deal_due t where t.deal_id = d.id and t.currency = 'XOF'), 0)
  from app.deals d where d.id = p_deal
$$;

create or replace function app.approval_reasons(p_deal uuid)
returns text[] language sql stable security definer set search_path = app, public as $$
  select array_remove(array[
    case when c.status <> 'active' or c.tier is null then '新客户（还没定档位）' end,
    case when cr.over_limit then '超欠款上限' end,
    case when cr.over_days then '超账期' end,
    case when c.block_on_debt and app.debt_other_than(d.id) > 0 then '有欠款不出货客户（还欠 ' || to_char(app.debt_other_than(d.id), 'FM999,999,999,990') || ' XOF）' end,
    case when exists (select 1 from app.deal_lines l where l.deal_id = d.id and l.product_id is null) then '有没编码的型号' end,
    case when exists (select 1 from app.deal_lines l where l.deal_id = d.id and l.requested_price is not null) then '申请特价' end
  ], null)
  from app.deals d join app.customers c on c.id = d.customer_id
  left join app.v_customer_credit cr on cr.customer_id = c.id
  where d.id = p_deal
$$;

create or replace function app.set_block_on_debt(p_customer uuid, p_on boolean)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.customers where id = p_customer;
  if v_org is null then raise exception 'NOT_FOUND: 客户不存在'; end if;
  perform app.require_role(v_org, 'admin');
  update app.customers set block_on_debt = coalesce(p_on, false) where id = p_customer;
  perform app.audit(v_org, 'set_block_on_debt', 'customers', p_customer, jsonb_build_object('on', p_on));
end $$;

-- 中方放行: 这张单可以出库 (留原因)
create or replace function app.release_debt_block(p_deal uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare d app.deals;
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception 'VALIDATION: 放行要写原因（比如答应今天付清）'; end if;
  update app.deals set debt_released_by = app.uid(), debt_released_at = now(), debt_release_note = p_note where id = p_deal;
  perform app.deal_event(p_deal, 'debt_released', jsonb_build_object('note', p_note, 'debt', app.debt_other_than(p_deal)));
end $$;

-- 出库硬拦
create or replace function app.trg_ship_debt_block() returns trigger language plpgsql security definer set search_path = app, public as $$
declare d app.deals; c app.customers; v_debt numeric;
begin
  select * into d from app.deals where id = new.deal_id;
  select * into c from app.customers where id = d.customer_id;
  if c.block_on_debt and d.debt_released_at is null then
    v_debt := app.debt_other_than(d.id);
    if v_debt > 0 then
      raise exception 'DEBT_BLOCK: % 是「有欠款不出货」客户，还欠 % XOF：先收款，或请中方在订单上「放行」', c.name, to_char(v_debt, 'FM999,999,999,990');
    end if;
  end if;
  return new;
end $$;
create trigger ship_debt_block before insert on app.shipments for each row execute function app.trg_ship_debt_block();

revoke all on function app.set_block_on_debt(uuid, boolean), app.release_debt_block(uuid, text), app.debt_other_than(uuid) from public;
grant execute on function app.set_block_on_debt(uuid, boolean), app.release_debt_block(uuid, text), app.debt_other_than(uuid) to authenticated;
