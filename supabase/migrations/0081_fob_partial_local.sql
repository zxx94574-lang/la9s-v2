-- 0081 (Frank 11-22): FOB 出库的几种情况 —— 全出 / 分批出 / 客户不要了转本地入库
-- 原来 fob_ship 只能一次全出; 现在 fob_ship2 可以按行给数量 (不给 = 剩下的全出), 出完才变「已出库 / 结清」.
-- 客户不要了: fob_to_local 把还没出的货 (整行或部分) 从 FOB 仓转进 LA / 9S 仓, 这部分不再算 FOB 货款;
-- 已收的订金按中方选的处理: credit = 转成客户预付款 (客户总账记负数), keep = 订金不退 (只记录), refund = 退给客户 (只记录, 退款走资金账户).

alter table app.fob_lines add column if not exists qty_local int not null default 0;

drop view if exists app.v_fob;
create view app.v_fob as
select p.*, c.code as customer_code, c.name as customer_name,
  coalesce((select sum((l.qty - l.qty_local) * l.unit_price) from app.fob_lines l where l.project_id = p.id), 0) as total,
  (select count(*) from app.fob_lines l where l.project_id = p.id and l.unit_price is null) as unpriced,
  coalesce((select sum(x.amount) from app.fob_payments x where x.project_id = p.id), 0) as paid,
  coalesce((select sum(l.qty - l.qty_local) from app.fob_lines l where l.project_id = p.id), 0) as qty,
  coalesce((select sum(l.qty_received) from app.fob_lines l where l.project_id = p.id), 0) as qty_received,
  coalesce((select sum(l.qty_shipped) from app.fob_lines l where l.project_id = p.id), 0) as qty_shipped,
  coalesce((select sum(l.qty_local) from app.fob_lines l where l.project_id = p.id), 0) as qty_local
from app.fob_projects p join app.customers c on c.id = p.customer_id;
alter view app.v_fob set (security_invoker = true);
grant select on app.v_fob to authenticated;

-- 一行还能出多少: 仓库控货 = 已入 FOB 仓 - 已出 - 转本地; 物流控货 = 订货 - 已出 - 转本地
create or replace function app._fob_left(f app.fob_projects, l app.fob_lines) returns int language sql immutable as $$
  select greatest(0, case when f.control = 'warehouse' then l.qty_received else l.qty end - l.qty_shipped - l.qty_local)
$$;

create or replace function app._fob_settle(p_project uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects; v_left int; v_ship int;
begin
  select * into f from app.fob_projects where id = p_project;
  -- 仓库控货: 进了 FOB 仓的都出完 / 转完就算完 (没到的那部分不卡着, 同原来); 物流控货: 订的都出完 / 转完
  select coalesce(sum(app._fob_left(f, l)), 0), coalesce(sum(l.qty_shipped), 0) into v_left, v_ship
  from app.fob_lines l where l.project_id = p_project;
  if v_left > 0 then return; end if;
  if v_ship = 0 then update app.fob_projects set status = 'cancelled' where id = p_project;   -- 全部转本地 = 这个 FOB 不做了
  else update app.fob_projects set status = case when (select paid >= total from app.v_fob where id = p_project) then 'closed' else 'shipped' end where id = p_project;
  end if;
end $$;

-- p_rows: [{line_id, qty}] ; null / [] = 每行剩下的全出
create or replace function app.fob_ship2(p_project uuid, p_rows jsonb, p_proof text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects; l app.fob_lines; v_q int; v_left int; v_s uuid; v_all boolean; v_n int := 0; v_done jsonb := '[]';
begin
  select * into f from app.fob_projects where id = p_project for update;
  perform app.require_role(f.org_id, 'manager');
  if f.status <> 'released' then raise exception 'BAD_STATE: 中方放货后才能出库'; end if;
  if coalesce(p_proof,'') = '' then raise exception 'VALIDATION: 出库要凭证'; end if;
  v_all := p_rows is null or jsonb_array_length(p_rows) = 0;
  for l in select * from app.fob_lines where project_id = p_project order by id for update loop
    v_left := app._fob_left(f, l);
    if v_all then v_q := v_left;
    else select coalesce(max((x->>'qty')::int), 0) into v_q from jsonb_array_elements(p_rows) x where (x->>'line_id')::uuid = l.id; end if;
    continue when coalesce(v_q, 0) <= 0;
    if v_q > v_left then raise exception 'VALIDATION: % 最多还能出 % 片', l.model, v_left; end if;
    if f.control = 'warehouse' then
      v_s := app.stock_row(f.org_id, 'fob', l.product_id);
      perform app.move_stock(v_s, -v_q, 'ship', 'fob', p_project);
    end if;
    update app.fob_lines set qty_shipped = qty_shipped + v_q where id = l.id;
    v_n := v_n + v_q; v_done := v_done || jsonb_build_object('line_id', l.id, 'model', l.model, 'qty', v_q);
  end loop;
  if v_n = 0 then raise exception 'VALIDATION: 没有要出的货'; end if;
  perform app.fob_event(p_project, 'shipped', jsonb_build_object('proof', p_proof, 'note', p_note, 'rows', v_done, 'partial', not v_all));
  perform app._fob_settle(p_project);
end $$;

-- 老入口保留: 一次全出
create or replace function app.fob_ship(p_project uuid, p_proof text, p_note text default null)
returns void language sql security definer set search_path = app, public as $$ select app.fob_ship2(p_project, null, p_proof, p_note) $$;

-- 客户不要了 → 转本地入库. p_rows: [{line_id, qty}] (null = 每行剩下的全转); p_wh: 'LA' / '9S'; p_deposit: credit / keep / refund
create or replace function app.fob_to_local(p_project uuid, p_rows jsonb, p_wh text, p_reason text, p_deposit text default 'credit')
returns void language plpgsql security definer set search_path = app, public as $$
declare f app.v_fob; fp app.fob_projects; l app.fob_lines; v_q int; v_left int; v_wh uuid; v_from uuid; v_to uuid; v_all boolean;
  v_n int := 0; v_val numeric := 0; v_done jsonb := '[]'; v_paid numeric; v_total numeric; v_over numeric;
begin
  select * into fp from app.fob_projects where id = p_project for update;
  perform app.require_role(fp.org_id, 'admin');
  if fp.status not in ('arrived','released','shipped') then raise exception 'BAD_STATE: 到货以后才能转本地（还没到的直接取消项目）'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 转本地要写原因（客户为什么不要了）'; end if;
  if p_deposit not in ('credit','keep','refund') then raise exception 'VALIDATION: 订金怎么处理：转预付 / 不退 / 退回'; end if;
  select id into v_wh from app.warehouses where org_id = fp.org_id and kind = 'local' and code = upper(p_wh);
  if v_wh is null then raise exception 'VALIDATION: 只能转进 LA 仓或 9S 仓'; end if;
  v_all := p_rows is null or jsonb_array_length(p_rows) = 0;
  for l in select * from app.fob_lines where project_id = p_project order by id for update loop
    v_left := greatest(0, l.qty - l.qty_shipped - l.qty_local);
    if fp.control = 'warehouse' then v_left := least(v_left, greatest(0, l.qty_received - l.qty_shipped - l.qty_local)); end if;
    if v_all then v_q := v_left;
    else select coalesce(max((x->>'qty')::int), 0) into v_q from jsonb_array_elements(p_rows) x where (x->>'line_id')::uuid = l.id; end if;
    continue when coalesce(v_q, 0) <= 0;
    if v_q > v_left then raise exception 'VALIDATION: % 最多能转 % 片', l.model, v_left; end if;
    if l.product_id is null then raise exception 'VALIDATION: % 没有编码，先建编码再转本地', l.model; end if;
    if fp.control = 'warehouse' then
      v_from := app.stock_row(fp.org_id, 'fob', l.product_id);
      perform app.move_stock(v_from, -v_q, 'fob_to_local', 'fob', p_project);
    end if;
    insert into app.stock_items (warehouse_id, product_id) values (v_wh, l.product_id) on conflict (warehouse_id, product_id) do nothing;
    select id into v_to from app.stock_items where warehouse_id = v_wh and product_id = l.product_id;
    perform app.move_stock(v_to, v_q, 'fob_to_local', 'fob', p_project);
    update app.fob_lines set qty_local = qty_local + v_q where id = l.id;
    v_n := v_n + v_q; v_val := v_val + v_q * coalesce(l.unit_price, 0);
    v_done := v_done || jsonb_build_object('line_id', l.id, 'model', l.model, 'qty', v_q);
  end loop;
  if v_n = 0 then raise exception 'VALIDATION: 没有能转的货'; end if;
  -- 转完以后: 收的钱超过剩下货款的部分 = 多收的订金, 按中方选的处理
  select paid, total into v_paid, v_total from app.v_fob where id = p_project;
  v_over := greatest(0, v_paid - v_total);
  if v_over > 0 and p_deposit = 'credit' then
    insert into app.ar_entries (org_id, customer_id, currency, kind, amount, ref_id, note)
    values (fp.org_id, fp.customer_id, fp.currency, 'adjust', -v_over, p_project, 'FOB ' || fp.fob_no || ' 转本地，多收的订金转成预付款');
  end if;
  perform app.fob_event(p_project, 'to_local', jsonb_build_object('rows', v_done, 'warehouse', upper(p_wh), 'reason', trim(p_reason),
    'value', v_val, 'deposit', p_deposit, 'over', v_over));
  insert into app.change_notices (org_id, kind, detail, by_user)
  values (fp.org_id, 'fob_to_local', jsonb_build_object('customer_id', fp.customer_id, 'fob_no', fp.fob_no, 'qty', v_n, 'warehouse', upper(p_wh),
    'reason', trim(p_reason), 'deposit', p_deposit, 'over', v_over), app.uid());
  perform app._fob_settle(p_project);
end $$;

revoke execute on function app._fob_left(app.fob_projects, app.fob_lines), app._fob_settle(uuid) from public;
grant execute on function app.fob_ship2(uuid, jsonb, text, text), app.fob_to_local(uuid, jsonb, text, text, text) to authenticated;
