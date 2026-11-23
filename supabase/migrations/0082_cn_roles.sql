-- 0082 (Frank 11-22 23:55): 国内按账号分 —— 采购是采购 (cn_support, 改名「国内采购」), 商务是商务 (cn_business), 财务是财务 (cn_finance)
-- 481 申请单每行给国内商务填: 能给多少 / 单价 CNY / 预计发货日 / 货权 (LA 工厂 / 9S 调货)
-- 482 采购单快到港提醒 (天数 ⚙ po_rules.eta_days, 默认 7)
-- 483 国内财务在采购单 (入仓号) 上记付款: 货款 / 运费 (运费按件分摊进这批成本)
-- 484 按采购单 (入仓号) 的应付 / 已付; 科特汇回国内的总额放在旁边对
alter type app.role_name add value if not exists 'cn_business';
alter type app.role_name add value if not exists 'cn_finance';


-- 新加的岗位值在同一个迁移里不能写成 role_name 常量 (同一事务里不让用), 策略里按文字比
create or replace function app.has_role_txt(p_org uuid, p_roles text[]) returns boolean language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active
    and (m.roles::text[] && p_roles or 'admin' = any(m.roles::text[])))
$$;

-- ───────── 481 商务回复 ─────────
alter table app.purchase_request_lines add column if not exists offer_qty int, add column if not exists offer_price numeric(18,4),
  add column if not exists offer_currency text not null default 'CNY', add column if not exists offer_ship date,
  add column if not exists offer_owner text check (offer_owner in ('LA','9S')), add column if not exists offer_note text,
  add column if not exists offer_by uuid, add column if not exists offer_at timestamptz;
alter table app.purchase_requests add column if not exists offered_at timestamptz;

create or replace function app.cn_offer(p_line uuid, p jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare l app.purchase_request_lines; r app.purchase_requests;
begin
  select * into l from app.purchase_request_lines where id = p_line for update;
  select * into r from app.purchase_requests where id = l.request_id;
  if r.id is null then raise exception 'NOT_FOUND: 申请单'; end if;
  perform app.require_role(r.org_id, 'cn_business');
  if r.status not in ('submitted','draft','ordered') then raise exception 'BAD_STATE: 这张申请已经发货 / 关了，不能再改回复'; end if;
  if nullif(p->>'qty', '') is not null and (p->>'qty')::int < 0 then raise exception 'VALIDATION: 数量不能为负'; end if;
  if nullif(p->>'price', '') is not null and (p->>'price')::numeric < 0 then raise exception 'VALIDATION: 单价不能为负'; end if;
  update app.purchase_request_lines set
    offer_qty = case when p ? 'qty' then nullif(p->>'qty', '')::int else offer_qty end,
    offer_price = case when p ? 'price' then nullif(p->>'price', '')::numeric else offer_price end,
    offer_currency = coalesce(nullif(p->>'currency', ''), offer_currency),
    offer_ship = case when p ? 'ship' then nullif(p->>'ship', '')::date else offer_ship end,
    offer_owner = case when p ? 'owner' then nullif(upper(p->>'owner'), '') else offer_owner end,
    offer_note = case when p ? 'note' then nullif(trim(p->>'note'), '') else offer_note end,
    offer_by = app.uid(), offer_at = now()
  where id = p_line;
  -- 每行都回了 (数量 + 单价 + 发货日) → 这张申请算「国内已回复」, 通知中方一次
  if r.offered_at is null and not exists (select 1 from app.purchase_request_lines x where x.request_id = r.id
       and (x.offer_qty is null or x.offer_price is null or x.offer_ship is null)) then
    update app.purchase_requests set offered_at = now(), updated_at = now() where id = r.id;
    insert into app.change_notices (org_id, kind, detail, by_user)
    values (r.org_id, 'cn_offer', jsonb_build_object('req_no', r.req_no, 'title', r.title, 'request_id', r.id), app.uid());
  end if;
end $$;

-- ───────── 483 采购单付款 (国内财务) ─────────
create table if not exists app.po_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  po_id uuid not null references app.purchase_orders(id) on delete cascade,
  kind text not null check (kind in ('goods','freight')),     -- 货款 (付工厂) / 运费 (付货代)
  on_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  currency text not null references app.currencies(code),
  xof_per_unit numeric(14,6),                                  -- 1 单位这个币 = ? 西法 (运费用来折西法; 货款记下这次的汇率备查)
  proof text not null, note text,
  created_by uuid, created_at timestamptz not null default now()
);
create index if not exists po_payments_po on app.po_payments (po_id);
alter table app.po_payments enable row level security;
drop policy if exists po_payments_read on app.po_payments;
create policy po_payments_read on app.po_payments for select using (app.has_role_txt(org_id, array['admin','cn_finance']));
grant select on app.po_payments to authenticated;

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

-- ───────── 484 按采购单的应付 / 已付 (国内财务 + 中方) ─────────
create or replace view app.v_po_ledger as
select po.id, po.org_id, po.po_no, po.batch_name, po.warehouse_nos, po.purpose, po.supplier, po.shipped_on, po.eta,
  coalesce((select sum(l.qty * l.unit_price) from app.po_lines l where l.po_id = po.id and l.currency = 'CNY'), 0) as goods_cny,
  coalesce((select sum(l.qty) from app.po_lines l where l.po_id = po.id), 0) as pcs,
  coalesce((select sum(l.qty_received) from app.po_lines l where l.po_id = po.id), 0) as pcs_received,
  (select count(*) from app.po_lines l where l.po_id = po.id and l.unit_price is null) as unpriced,
  coalesce((select sum(x.amount) from app.po_payments x where x.po_id = po.id and x.kind = 'goods' and x.currency = 'CNY'), 0) as paid_cny,
  coalesce((select sum(case when x.currency = 'XOF' then x.amount else x.amount * x.xof_per_unit end) from app.po_payments x where x.po_id = po.id and x.kind = 'freight'), 0) as freight_xof,
  (select max(on_date) from app.po_payments x where x.po_id = po.id) as last_paid
from app.purchase_orders po;
alter view app.v_po_ledger set (security_invoker = true);
grant select on app.v_po_ledger to authenticated;

-- 国内财务 / 采购 / 商务 只读需要的表 (看不到客户和售价: 这些表里本来就没有)
drop policy if exists read_admin on app.product_batches;
create policy read_admin on app.product_batches for select using (app.has_role_txt(org_id, array['admin','cn_finance']));

revoke all on function app.cn_offer(uuid, jsonb), app.record_po_payment(uuid, jsonb) from public;
grant execute on function app.cn_offer(uuid, jsonb), app.record_po_payment(uuid, jsonb) to authenticated;

-- 国内财务能看科特汇回国内的记录 (对总额用); 原来的读权限不变
drop policy if exists remit_read_cnf on app.remittances;
create policy remit_read_cnf on app.remittances for select using (app.has_role_txt(org_id, array['cn_finance']));
