-- 0105 (11-27 自查): FOB 申请里「没编码的新货」原来没有地方挂编码 —— 到货入库提示「先让中方建编码」, 但建好编码后也挂不回这一行, 卡死.
-- 中方在物料里建好编码后, 在 FOB 单上给这一行「挂编码」; 只能挂没编码的行, 还没入库 / 出库的才能改.
create or replace function app.set_fob_line_product(p_line uuid, p_product uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare l app.fob_lines; f app.fob_projects; v_model text;
begin
  select * into l from app.fob_lines where id = p_line for update;
  if l.id is null then raise exception 'NOT_FOUND: 没有这一行'; end if;
  select * into f from app.fob_projects where id = l.project_id;
  perform app.require_role(f.org_id, 'admin');
  if f.status in ('shipped','closed','cancelled') then raise exception 'BAD_STATE: 项目已结束'; end if;
  if l.qty_received > 0 or l.qty_shipped > 0 or l.qty_local > 0 then raise exception 'BAD_STATE: 这一行已经入库或出库，不能再换编码'; end if;
  select model into v_model from app.products where id = p_product and org_id = f.org_id;
  if v_model is null then raise exception 'VALIDATION: 编码不存在'; end if;
  if exists (select 1 from app.fob_lines where project_id = l.project_id and product_id = p_product and id <> p_line) then
    raise exception 'VALIDATION: 这张 FOB 单里已经有这个编码了'; end if;
  update app.fob_lines set product_id = p_product, model = v_model where id = p_line;  -- 型号换成编码上的, 原来客户写的留在记录里 (was)
  perform app.fob_event(f.id, 'code', jsonb_build_object('line', p_line, 'product', p_product, 'was', l.model, 'model', v_model));
end $$;
revoke execute on function app.set_fob_line_product(uuid, uuid) from public;
grant execute on function app.set_fob_line_product(uuid, uuid) to authenticated;

-- FOB 收款原来只记在 FOB 单上: 不进资金账户 (账户余额对不上)、也不要凭证 (违反「收款必须有凭证，现金也拍照」).
-- 新的 record_fob_payment2: 必须选资金账户 (币种要和 FOB 单一样) + 必须有凭证; 同时在账户里记一笔「收客户货款」.
alter table app.fob_payments add column if not exists account_id uuid references app.cash_accounts(id);
alter table app.fob_payments add column if not exists move_id uuid references app.cash_moves(id);

create or replace function app.record_fob_payment2(p_project uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare f app.fob_projects; a app.cash_accounts; v_id uuid; v_mv uuid;
  v_kind text := coalesce(nullif(p->>'kind',''), 'other'); v_amt numeric := nullif(p->>'amount','')::numeric;
  v_on date := coalesce(nullif(p->>'on_date','')::date, current_date); v_proof text := nullif(p->>'proof','');
begin
  select * into f from app.fob_projects where id = p_project;
  if f.id is null then raise exception 'NOT_FOUND: 没有这个 FOB 项目'; end if;
  perform app.require_role(f.org_id, 'finance');
  if f.status = 'cancelled' then raise exception 'BAD_STATE: 项目已取消'; end if;
  if v_kind not in ('deposit','balance','other') then raise exception 'VALIDATION: 收款类型不对'; end if;
  if coalesce(v_amt, 0) <= 0 then raise exception 'VALIDATION: 金额要大于 0'; end if;
  if v_proof is null then raise exception 'VALIDATION: 收款必须有付款凭证（现金也要拍照）'; end if;
  select * into a from app.cash_accounts where id = nullif(p->>'account_id','')::uuid and org_id = f.org_id and active;
  if a.id is null then raise exception 'VALIDATION: 要选收进哪个资金账户'; end if;
  if a.currency <> f.currency then raise exception 'VALIDATION: 账户币种 % 和 FOB 单币种 % 不一样', a.currency, f.currency; end if;
  insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status, customer_id, proof, note, created_by, biz_type, flow_class)
  values (f.org_id, a.id, 'deposit', v_amt, v_on, 'claimed', f.customer_id, v_proof,
    f.fob_no || ' ' || case v_kind when 'deposit' then '订金' when 'balance' then '尾款' else '收款' end, app.uid(), '备件', '收客户货款')
  returning id into v_mv;
  insert into app.fob_payments (project_id, kind, amount, on_date, method, proof, note, created_by, account_id, move_id)
  values (p_project, v_kind, v_amt, v_on, coalesce(nullif(p->>'method','')::app.pay_method, case a.kind when 'cash' then 'cash' when 'wave' then 'wave' when 'bank' then 'bank' else 'other' end::app.pay_method),
    v_proof, nullif(p->>'note',''), app.uid(), a.id, v_mv) returning id into v_id;
  perform app.fob_event(p_project, 'payment', jsonb_build_object('kind', v_kind, 'amount', v_amt, 'account', a.name));
  update app.fob_projects set status = 'closed' where id = p_project and status = 'shipped'
    and (select paid >= total from app.v_fob where id = p_project);
  return v_id;
end $$;
revoke execute on function app.record_fob_payment2(uuid, jsonb) from public;
grant execute on function app.record_fob_payment2(uuid, jsonb) to authenticated;
