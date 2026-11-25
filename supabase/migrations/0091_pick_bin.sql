-- 0091 找货时记「从哪个库位拿」(Frank 11-25「联动只做了 60%」自检: 出库原来按片数少的库位先扣, 是猜的, 库位数会越用越不准)
-- 找货单每行可选库位; 出库扣库位时先扣选的那个, 不够再按原规则; 没选的照旧
alter table app.deal_lines add column if not exists pick_bin text;

create or replace function app.set_pick_bin(p_line uuid, p_bin text) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select d.org_id into v_org from app.deal_lines l join app.deals d on d.id = l.deal_id where l.id = p_line;
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'admin', 'manager', 'picker');
  update app.deal_lines set pick_bin = nullif(upper(trim(coalesce(p_bin, ''))), '') where id = p_line;
end $$;

create or replace function app.trg_ship_bins() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_kind app.wh_kind; v_prod uuid; left_ int; r record; take int; m record; g text; v_pick text;
begin
  if new.reason <> 'ship' or new.qty >= 0 then return new; end if;
  select w.org_id, w.kind, s.product_id into v_org, v_kind, v_prod from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.id = new.stock_item_id;
  if v_kind <> 'local' then return new; end if;
  if new.ref_id is not null then
    select l.pick_bin into v_pick from app.shipments x join app.deal_lines l on l.deal_id = x.deal_id where x.id = new.ref_id and l.product_id = v_prod and l.pick_bin is not null limit 1;
  end if;
  left_ := -new.qty;
  for r in select i.bin_id, i.qty from app.bin_items i join app.bins b on b.id = i.bin_id where b.org_id = v_org and i.product_id = v_prod and i.qty > 0
           order by (b.code = v_pick) desc, i.qty, b.code loop
    exit when left_ <= 0;
    take := least(r.qty, left_);
    perform app.bin_change(r.bin_id, v_prod, -take, 'ship', new.ref_id, null);
    left_ := left_ - take;
  end loop;
  perform app.bin_sync_default(v_org, v_prod);
  left_ := -new.qty;
  for m in select * from app.stock_pool where org_id = v_org and product_id = v_prod and side = '-' and qty_left > 0 order by created_at for update loop
    exit when left_ <= 0;
    g := m.grp;
    for r in select * from app.stock_pool where org_id = v_org and grp = g and side = '+' and qty_left > 0 order by created_at for update loop
      exit when left_ <= 0 or m.qty_left <= 0;
      take := least(left_, m.qty_left, r.qty_left);
      update app.stock_pool set qty_left = qty_left - take where id = r.id;
      update app.stock_pool set qty_left = qty_left - take where id = m.id;
      m.qty_left := m.qty_left - take;
      insert into app.pool_uses (org_id, move_id, ship_product, kd_product, qty) values (v_org, new.id, v_prod, r.product_id, take);
      left_ := left_ - take;
    end loop;
  end loop;
  return new;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function app.set_pick_bin(uuid, text) to authenticated; end if;
end $$;
