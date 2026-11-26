-- 0103（Frank 11-26「直接改」）：
--   ① 工资单只给中方 + 国家经理：工资相关函数都写的是 require_role(…, 'admin', 'sales_manager')（当初罗兰挂在销售主管下），
--      这里统一把「正好是 admin + sales_manager」这一组解释成 admin + country_manager，销售主管不再能动工资。
--   ② 金蝶导出的各种「…列表」原样存一份（kd_lines），飞书 CI 销售表按行存一份（hist_sales，只是历史，不记账、不动库存）。
--   ③ 对账：按客户对应收（recon_ar）、按销售订单对（recon_so）；每条差异选结论才算处理完（recon_marks）。
--   ④ 在库批次按「现在的库存从最后一次进货往前倒推」算（v_batch_layers）—— 导入几年的历史批次后，挂牌价 / 会亏只看还在库的那几批。

create or replace function app.require_role(p_org uuid, variadic p_roles app.role_name[])
returns void language plpgsql stable security definer set search_path = app, public as $$
begin
  if p_roles::text[] = array['admin', 'sales_manager'] then
    if not exists (
      select 1 from app.members m where m.user_id = app.uid() and m.org_id = p_org and m.active and ('admin' = any(m.roles::text[]) or 'country_manager' = any(m.roles::text[]))) then
      raise exception 'PERMISSION_DENIED: 工资只有中方和国家经理能动' using errcode = '42501';
    end if;
    return;
  end if;
  if not app.has_role(p_org, p_roles) then
    raise exception 'PERMISSION_DENIED: requires one of %', p_roles using errcode = '42501';
  end if;
end $$;

-- 客户 / 料号编码统一：CI00102 = CI0102 = ci102
create or replace function app.norm_code(p text) returns text language sql immutable as $$
  select case when upper(trim(coalesce(p, ''))) ~ '^[A-Z]+0*[0-9]+$'
    then regexp_replace(upper(trim(p)), '^([A-Z]+)0*([0-9]+)$', '\1') || lpad(regexp_replace(upper(trim(p)), '^[A-Z]+0*([0-9]+)$', '\1'), 4, '0')
    else upper(trim(coalesce(p, ''))) end
$$;

create table if not exists app.kd_lines (
  id bigserial primary key,
  org_id uuid not null references app.orgs(id),
  kind text not null check (kind in ('so', 'out', 'ret', 'receipt', 'opening', 'ar', 'po', 'grn', 'customer')),
  doc_no text, src_no text, d date, party_code text, party_name text,
  code text, wh text, qty numeric, amount numeric, currency text, amount_xof numeric, biz text,
  extra jsonb, imported_at timestamptz not null default now(), imported_by uuid);
create index if not exists kd_lines_k on app.kd_lines (org_id, kind, doc_no);
alter table app.kd_lines enable row level security;
create policy kd_lines_read on app.kd_lines for select using (app.has_role_txt(org_id, array['finance']));

-- 同一种表再导一次：这次文件里出现的单号整张换掉，没出现的老单留着（金蝶导出常常只导一段日期）
create or replace function app.kd_lines_load(p_org uuid, p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare n int;
begin
  perform app.require_role(p_org, 'finance');
  if p_kind = 'customer' then delete from app.kd_lines where org_id = p_org and kind = 'customer';
  else
    delete from app.kd_lines where org_id = p_org and kind = p_kind
      and doc_no in (select distinct r->>'doc_no' from jsonb_array_elements(p_rows) r);
  end if;
  insert into app.kd_lines (org_id, kind, doc_no, src_no, d, party_code, party_name, code, wh, qty, amount, currency, amount_xof, biz, extra, imported_by)
  select p_org, p_kind, r->>'doc_no', nullif(r->>'src_no', ''), nullif(r->>'d', '')::date, nullif(r->>'party_code', ''), nullif(r->>'party_name', ''),
    nullif(r->>'code', ''), nullif(r->>'wh', ''), nullif(r->>'qty', '')::numeric, nullif(r->>'amount', '')::numeric, nullif(r->>'currency', ''),
    nullif(r->>'amount_xof', '')::numeric, nullif(r->>'biz', ''), r->'extra', app.uid()
  from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  perform app.audit(p_org, 'kd_lines_load', 'kd_lines', null, jsonb_build_object('kind', p_kind, 'n', n));
  return jsonb_build_object('n', n);
end $$;

create table if not exists app.hist_sales (
  id bigserial primary key,
  org_id uuid not null references app.orgs(id),
  d date, customer_code text, customer_name text, so_no text, status text,
  code text, model text, category text, qty_ordered numeric, qty numeric, price numeric, amount numeric,
  ret_qty numeric, ret_amount numeric, paid numeric, due numeric, paid_on date, staff text, remark text,
  imported_at timestamptz not null default now());
create index if not exists hist_sales_k on app.hist_sales (org_id, so_no);
alter table app.hist_sales enable row level security;
create policy hist_sales_read on app.hist_sales for select using (app.has_role_txt(org_id, array['finance', 'manager', 'sales_manager']));

-- 飞书整张表导一次 = 整体换掉（飞书是历史的唯一来源）；顺手把按编码按月的销量换成飞书口径（备货看板 / 销量统计用）
create or replace function app.hist_sales_load(p_org uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare n int; m int;
begin
  perform app.require_role(p_org, 'admin');
  delete from app.hist_sales where org_id = p_org;
  insert into app.hist_sales (org_id, d, customer_code, customer_name, so_no, status, code, model, category, qty_ordered, qty, price, amount, ret_qty, ret_amount, paid, due, paid_on, staff, remark)
  select p_org, nullif(r->>'d', '')::date, nullif(r->>'customer_code', ''), nullif(r->>'customer_name', ''), nullif(r->>'so_no', ''), nullif(r->>'status', ''),
    nullif(r->>'code', ''), nullif(r->>'model', ''), nullif(r->>'category', ''), nullif(r->>'qty_ordered', '')::numeric, nullif(r->>'qty', '')::numeric,
    nullif(r->>'price', '')::numeric, nullif(r->>'amount', '')::numeric, nullif(r->>'ret_qty', '')::numeric, nullif(r->>'ret_amount', '')::numeric,
    nullif(r->>'paid', '')::numeric, nullif(r->>'due', '')::numeric, nullif(r->>'paid_on', '')::date, nullif(r->>'staff', ''), nullif(r->>'remark', '')
  from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  insert into app.sales_history (org_id, product_id, month, qty, source)
  select p_org, p.id, date_trunc('month', h.d)::date, sum(h.qty)::int, 'feishu'
  from app.hist_sales h join app.products p on p.org_id = p_org and (p.code = h.code or p.kingdee_code = h.code)
  where h.org_id = p_org and h.status = 'Done' and h.qty > 0 and h.d is not null
  group by p.id, date_trunc('month', h.d)
  on conflict (org_id, product_id, month) do update set qty = excluded.qty, source = 'feishu';
  get diagnostics m = row_count;
  perform app.audit(p_org, 'hist_sales_load', 'hist_sales', null, jsonb_build_object('n', n, 'months', m));
  return jsonb_build_object('n', n, 'months', m);
end $$;

create table if not exists app.recon_marks (
  org_id uuid not null references app.orgs(id), key text not null, cat text, verdict text not null, note text,
  marked_by uuid, marked_at timestamptz not null default now(), primary key (org_id, key));
alter table app.recon_marks enable row level security;
create policy recon_marks_read on app.recon_marks for select using (app.has_role_txt(org_id, array['finance']));

create or replace function app.recon_mark(p_org uuid, p_key text, p_cat text, p_verdict text, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'finance');
  if nullif(trim(coalesce(p_verdict, '')), '') is null then delete from app.recon_marks where org_id = p_org and key = p_key; return; end if;
  insert into app.recon_marks values (p_org, p_key, p_cat, p_verdict, nullif(trim(coalesce(p_note, '')), ''), app.uid(), now())
  on conflict (org_id, key) do update set verdict = excluded.verdict, note = excluded.note, cat = excluded.cat, marked_by = excluded.marked_by, marked_at = now();
  perform app.audit(p_org, 'recon_mark', 'recon_marks', null, jsonb_build_object('key', p_key, 'verdict', p_verdict));
end $$;

-- 按客户对应收：金蝶 = 期初 + 出库 − 退货 − 收款（销售回款，人民币按当时汇率折西法）；
-- 飞书 = Done 行的待付，扣时间差：金蝶收款最后一天之后飞书才收的钱加回来、飞书还没有金蝶单号（没录金蝶）的单减掉
create or replace function app.recon_ar(p_org uuid)
returns table (code text, name text, kd_open numeric, kd_out numeric, kd_ret numeric, kd_recv numeric, kd_ar numeric,
  fs_due numeric, fs_late numeric, fs_nokd numeric, fs_adj numeric, sys_ar numeric, diff numeric, cutoff date, verdict text, note text)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'finance');
  return query
  with cut as (select max(k.d) as c from app.kd_lines k where k.org_id = p_org and k.kind = 'receipt'),
  cu as (select distinct on (k.party_name) app.norm_code(k.party_code) as c, k.party_name as n from app.kd_lines k where k.org_id = p_org and k.kind = 'customer'),
  op as (select coalesce(cu.c, app.norm_code(k.party_code)) as c, sum(k.amount) as v from app.kd_lines k left join cu on cu.n = k.party_name
         where k.org_id = p_org and k.kind = 'opening' group by 1),
  ko as (select app.norm_code(k.party_code) as c, sum(k.amount) as v, max(k.party_name) as n from app.kd_lines k where k.org_id = p_org and k.kind = 'out' group by 1),
  kr as (select app.norm_code(k.party_code) as c, sum(k.amount) as v from app.kd_lines k where k.org_id = p_org and k.kind = 'ret' group by 1),
  kc as (select app.norm_code(k.party_code) as c, sum(coalesce(k.amount_xof, k.amount)) as v, max(k.party_name) as n from app.kd_lines k
         where k.org_id = p_org and k.kind = 'receipt' and coalesce(k.biz, '销售回款') like '%回款%' group by 1),
  fs as (select app.norm_code(h.customer_code) as c, max(h.customer_name) as n, sum(coalesce(h.due, 0)) as due,
           sum(coalesce(h.paid, 0)) filter (where h.paid_on > (select c from cut)) as late,
           sum(coalesce(h.amount, 0)) filter (where h.so_no is null and h.d >= (select min(k.d) from app.kd_lines k where k.org_id = p_org and k.kind = 'out')) as nokd
         from app.hist_sales h where h.org_id = p_org and h.status = 'Done' group by 1),
  sy as (select app.norm_code(c.code) as c, sum(e.amount) as v from app.ar_entries e join app.customers c on c.id = e.customer_id
         where e.org_id = p_org and e.currency = 'XOF' and c.code is not null group by 1),
  keys as (select op.c from op union select ko.c from ko union select kc.c from kc union select fs.c from fs)
  select k.c, coalesce((select cu2.n from cu cu2 where cu2.c = k.c limit 1), ko.n, kc.n, fs.n),
    coalesce(op.v, 0), coalesce(ko.v, 0), coalesce(kr.v, 0), coalesce(kc.v, 0),
    coalesce(op.v, 0) + coalesce(ko.v, 0) + coalesce(kr.v, 0) - coalesce(kc.v, 0),
    coalesce(fs.due, 0), coalesce(fs.late, 0), coalesce(fs.nokd, 0),
    coalesce(fs.due, 0) + coalesce(fs.late, 0) - coalesce(fs.nokd, 0), sy.v,
    (coalesce(op.v, 0) + coalesce(ko.v, 0) + coalesce(kr.v, 0) - coalesce(kc.v, 0)) - (coalesce(fs.due, 0) + coalesce(fs.late, 0) - coalesce(fs.nokd, 0)),
    (select c from cut), m.verdict, m.note
  from keys k left join op on op.c = k.c left join ko on ko.c = k.c left join kr on kr.c = k.c left join kc on kc.c = k.c
    left join fs on fs.c = k.c left join sy on sy.c = k.c left join app.recon_marks m on m.org_id = p_org and m.key = 'ar:' || k.c
  where k.c is not null and k.c <> ''
    and upper(coalesce((select cu2.n from cu cu2 where cu2.c = k.c limit 1), ko.n, kc.n, fs.n, '')) not like 'FOB%' and k.c not like '%-FOB';
end $$;

-- 按销售订单对：飞书写的是出库单号的，先换成它的销售订单号；FOB 客户不比（飞书销售表里没有 FOB）
create or replace function app.recon_so(p_org uuid)
returns table (so_no text, cat text, fs_cust text, fs_name text, fs_amount numeric, fs_ret numeric, fs_date date,
  kd_cust text, kd_name text, kd_amount numeric, kd_ret numeric, kd_date date, diff numeric, verdict text, note text)
language plpgsql stable security definer set search_path = app, public as $$
begin
  perform app.require_role(p_org, 'finance');
  return query
  with x2s as (select distinct k.doc_no, k.src_no from app.kd_lines k where k.org_id = p_org and k.kind = 'out' and k.src_no is not null),
  st as (select min(k.d) as d0 from app.kd_lines k where k.org_id = p_org and k.kind = 'out'),
  f as (select coalesce(x.src_no, h.so_no) as so, string_agg(distinct app.norm_code(h.customer_code), ',') as fc, max(h.customer_name) as fn,
          sum(coalesce(h.amount, 0)) as fs, sum(coalesce(h.ret_amount, 0)) as fr, min(h.d) as fd
        from app.hist_sales h left join x2s x on x.doc_no = h.so_no
        where h.org_id = p_org and h.status = 'Done' and h.so_no is not null group by 1),
  k as (select k.src_no as so, string_agg(distinct app.norm_code(k.party_code), ',') as kc, max(k.party_name) as kn, sum(k.amount) as kd, min(k.d) as kdd
        from app.kd_lines k where k.org_id = p_org and k.kind = 'out' and k.src_no is not null
          and upper(coalesce(k.party_name, '')) not like 'FOB%' and coalesce(k.party_code, '') not like '%-FOB' group by 1),
  r as (select x.src_no as so, sum(k.amount) as kr from app.kd_lines k join x2s x on x.doc_no = k.src_no where k.org_id = p_org and k.kind = 'ret' group by 1),
  j as (select coalesce(f.so, k.so) as so, f.fc, f.fn, f.fs, f.fr, f.fd, k.kc, k.kn, k.kd, coalesce(r.kr, 0) as kr, k.kdd
        from f full join k on k.so = f.so left join r on r.so = coalesce(f.so, k.so))
  select j.so,
    case when j.fc is not null and j.kc is not null and j.fc <> j.kc then '客户不同'
         when j.fs is null then '只在金蝶' when j.kd is null then '只在飞书'
         when abs(j.kd + j.kr - j.fs) < 1 or abs(j.kd - j.fs - coalesce(j.fr, 0)) < 1 then '一致' else '金额不同' end,
    j.fc, j.fn, j.fs, j.fr, j.fd, j.kc, j.kn, j.kd, j.kr, j.kdd, coalesce(j.kd, 0) + j.kr - coalesce(j.fs, 0), m.verdict, m.note
  from j left join app.recon_marks m on m.org_id = p_org and m.key = 'so:' || j.so
  where j.so is not null and not (j.kd is null and j.fd < (select d0 from st));   -- 金蝶开账以前的飞书单在期初里，不算「只在飞书」
end $$;

-- 在库批次：现在的库存（本地 + FOB 仓）从最后一次进货往前倒推；没有库存记录的编码照旧全算在库
create or replace view app.v_batch_layers as
with oh as (select s.product_id, sum(s.qty_on_hand) as q from app.stock_items s join app.warehouses w on w.id = s.warehouse_id
            where w.kind in ('local', 'fob') group by 1),
b as (select pb.*, sum(pb.qty) over (partition by pb.product_id order by pb.ordered_on desc nulls last, pb.created_at desc, pb.id desc) - pb.qty as newer
      from app.product_batches pb)
select b.*, case when oh.product_id is null then b.qty else greatest(0, least(b.qty, oh.q - b.newer))::int end as in_stock
from b left join oh on oh.product_id = b.product_id;

revoke all on function app.kd_lines_load(uuid, text, jsonb), app.hist_sales_load(uuid, jsonb), app.recon_mark(uuid, text, text, text, text),
  app.recon_ar(uuid), app.recon_so(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function app.kd_lines_load(uuid, text, jsonb), app.hist_sales_load(uuid, jsonb), app.recon_mark(uuid, text, text, text, text),
      app.recon_ar(uuid), app.recon_so(uuid), app.norm_code(text) to authenticated;
    grant select on app.kd_lines, app.hist_sales, app.recon_marks, app.v_batch_layers to authenticated;
  end if;
end $$;
