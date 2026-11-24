-- 0089 年前大盘点 + 库位 + 上架（Frank 11-24，待改 509 / 510）
-- 库位：房间（按品牌）- 货架字母 - 层，例 SS-A-1（布局在 org_settings bin_rooms，⚙ 可改）；一个库位可以放几个型号，每个型号记片数（bin_items），每次变动记 bin_log（以前放过什么都能回溯）
-- 盘点：中方开一次盘点（默认暂停出库）→ 分任务（谁盘哪几个货架）→ 员工手机逐条录 库位 · 型号 · 数量 → 中方看差异 → 确认写进系统
-- 差异：系统数 = 本地两个仓（LA + 9S）合计；同一组（编码甄别里定了是同一种货的几个编码）里一个多一个少能抵消的 → 消耗池（金蝶靠以后出货慢慢对齐）；
--       抵消不了的 → 盘亏 / 盘盈（系统直接改，金蝶要录盘亏 / 盘盈单）。确认后系统库存 = 实物
create table if not exists app.bins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  code text not null, room text, shelf text, level int,
  active boolean not null default true, created_at timestamptz not null default now(),
  unique (org_id, code));
create table if not exists app.bin_items (
  id uuid primary key default gen_random_uuid(),
  bin_id uuid not null references app.bins(id) on delete cascade,
  product_id uuid not null references app.products(id),
  qty int not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  unique (bin_id, product_id));
create table if not exists app.bin_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.orgs(id),
  bin_id uuid references app.bins(id) on delete set null,
  product_id uuid references app.products(id),
  change int not null, qty_after int,
  kind text not null check (kind in ('count', 'putaway', 'refill', 'move_out', 'move_in', 'ship', 'adjust')),
  ref_id uuid, note text, at timestamptz not null default now(), by_user uuid);
create index if not exists bin_log_bin on app.bin_log (bin_id, at desc);
create index if not exists bin_log_prod on app.bin_log (product_id, at desc);

create table if not exists app.counts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  no text, title text, status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  pause_ship boolean not null default true,
  started_at timestamptz not null default now(), started_by uuid, closed_at timestamptz, closed_by uuid, note text);
create table if not exists app.count_tasks (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references app.counts(id) on delete cascade,
  employee_id uuid not null references app.employees(id),
  scope text not null,                      -- 盘哪几个货架，例 SSA, SSB, ITA
  status text not null default 'todo' check (status in ('todo', 'done')),
  done_at timestamptz, created_at timestamptz not null default now());
create table if not exists app.count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references app.counts(id) on delete cascade,
  task_id uuid references app.count_tasks(id) on delete set null,
  bin_id uuid not null references app.bins(id),
  product_id uuid not null references app.products(id),
  qty int not null check (qty >= 0),
  note text, by_employee uuid references app.employees(id), by_user uuid, at timestamptz not null default now());
create index if not exists count_lines_c on app.count_lines (count_id);
create table if not exists app.count_diffs (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references app.counts(id) on delete cascade,
  product_id uuid not null references app.products(id),
  grp text, sys_qty int, actual_qty int, diff int,       -- diff = 系统 − 实物
  pool_plus int not null default 0, pool_minus int not null default 0, loss int not null default 0, gain int not null default 0);
-- 消耗池：side '+' = 金蝶比实物多（没有实物的编码），side '-' = 实物比金蝶多；以后出 '-' 那个编码时，金蝶改记同组 '+' 的编码
create table if not exists app.stock_pool (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  count_id uuid references app.counts(id),
  product_id uuid not null references app.products(id),
  grp text not null, side text not null check (side in ('+', '-')),
  qty int not null, qty_left int not null, created_at timestamptz not null default now());
create table if not exists app.pool_uses (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.orgs(id),
  move_id bigint, ship_product uuid references app.products(id), kd_product uuid references app.products(id),
  qty int not null, at timestamptz not null default now());

alter table app.bins enable row level security; alter table app.bin_items enable row level security; alter table app.bin_log enable row level security;
alter table app.counts enable row level security; alter table app.count_tasks enable row level security; alter table app.count_lines enable row level security;
alter table app.count_diffs enable row level security; alter table app.stock_pool enable row level security; alter table app.pool_uses enable row level security;
create policy read_own on app.bins for select using (app.is_member(org_id));
create policy read_own on app.bin_items for select using (exists (select 1 from app.bins b where b.id = bin_id and app.is_member(b.org_id)));
create policy read_own on app.bin_log for select using (app.is_member(org_id));
create policy read_own on app.counts for select using (app.is_member(org_id));
create policy read_own on app.count_tasks for select using (exists (select 1 from app.counts c where c.id = count_id and app.is_member(c.org_id)));
create policy read_own on app.count_lines for select using (exists (select 1 from app.counts c where c.id = count_id and app.is_member(c.org_id)));
create policy read_own on app.count_diffs for select using (exists (select 1 from app.counts c where c.id = count_id and app.is_member(c.org_id)));
create policy read_own on app.stock_pool for select using (app.is_member(org_id));
create policy read_own on app.pool_uses for select using (app.is_member(org_id));

-- 同一组 = 「编码甄别」里定了是同一种货的几个编码（§3b：归一由中方逐个定，系统不自动合并；通用性不同默认是两种货）；没定过的编码自己一组
create or replace function app.prod_group(p uuid) returns text language sql stable security definer set search_path = app, public as $$
  select case when x.unify_status = 'same' and x.unify_code is not null then 'U:' || x.unify_code else 'P:' || x.code end from app.products x where x.id = p
$$;

-- 库位布局（Frank 11-24 13:47，⚙ 可改：以后会加 / 减货架）：房间 - 货架字母 - 层，例 SS-A-1；没有货架的房间（LR / SLR）库位就是房间名
create or replace function app.bin_rooms(p_org uuid) returns jsonb language sql stable security definer set search_path = app, public as $$
  select coalesce((select value from app.org_settings where org_id = p_org and key = 'bin_rooms'),
    '[{"room":"TXI","name":"Tecno / Infinix / itel","shelves":"ABCDEFG","levels":4},{"room":"AA","name":"iPhone","shelves":"ABCD","levels":4},{"room":"SS","name":"三星","shelves":"ABCD","levels":4},{"room":"LR","name":"Living Room","shelves":"","levels":0},{"room":"SLR","name":"Small Living Room","shelves":"","levels":0}]'::jsonb)
$$;
-- 库位号：去空格转大写；必须在库位布局里（房间对、货架字母和层数在范围内）
create or replace function app.bin_upsert(p_org uuid, p_code text) returns uuid language plpgsql security definer set search_path = app, public as $$
declare c text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')); m text[]; v uuid; r jsonb;
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  m := regexp_match(c, '^([A-Z0-9]+)(?:-([A-Z])-([0-9]{1,2}))?$');
  if m is null then raise exception 'VALIDATION: 库位「%」格式不对：房间-货架-层，例 SS-A-1；LR / SLR 直接写房间名', p_code; end if;
  select x into r from jsonb_array_elements(app.bin_rooms(p_org)) x where upper(x->>'room') = m[1];
  if r is null then raise exception 'VALIDATION: 没有「%」这个房间（库位布局里有：%）', m[1], (select string_agg(x->>'room', ' / ') from jsonb_array_elements(app.bin_rooms(p_org)) x); end if;
  if coalesce(r->>'shelves', '') = '' then
    if m[2] is not null then raise exception 'VALIDATION: % 没有货架，库位直接写 %', m[1], m[1]; end if;
  else
    if m[2] is null then raise exception 'VALIDATION: % 要写到货架和层，例 %-A-1', m[1], m[1]; end if;
    if position(m[2] in upper(r->>'shelves')) = 0 then raise exception 'VALIDATION: % 只有货架 %', m[1], r->>'shelves'; end if;
    if m[3]::int < 1 or m[3]::int > coalesce((r->>'levels')::int, 0) then raise exception 'VALIDATION: % 的货架只有 1–% 层', m[1], r->>'levels'; end if;
  end if;
  insert into app.bins (org_id, code, room, shelf, level) values (p_org, c, m[1], m[2], m[3]::int) on conflict (org_id, code) do nothing;
  select id into v from app.bins where org_id = p_org and code = c;
  return v;
end $$;

-- 库位里某个型号的片数变动（记日志）
create or replace function app.bin_change(p_bin uuid, p_product uuid, p_change int, p_kind text, p_ref uuid, p_note text) returns int
language plpgsql security definer set search_path = app, public as $$
declare v_after int; v_org uuid;
begin
  select org_id into v_org from app.bins where id = p_bin;
  insert into app.bin_items (bin_id, product_id, qty) values (p_bin, p_product, greatest(p_change, 0))
  on conflict (bin_id, product_id) do update set qty = app.bin_items.qty + p_change, updated_at = now()
  returning qty into v_after;
  insert into app.bin_log (org_id, bin_id, product_id, change, qty_after, kind, ref_id, note, by_user) values (v_org, p_bin, p_product, p_change, v_after, p_kind, p_ref, p_note, app.uid());
  return v_after;
end $$;

-- 找货默认库位 = 这个型号片数最多的库位
create or replace function app.bin_sync_default(p_org uuid, p_product uuid) returns void language sql security definer set search_path = app, public as $$
  update app.stock_items s set bin = (select b.code from app.bin_items i join app.bins b on b.id = i.bin_id where b.org_id = p_org and i.product_id = p_product and i.qty > 0 order by i.qty desc, b.code limit 1)
  from app.warehouses w where w.id = s.warehouse_id and w.org_id = p_org and w.kind = 'local' and s.product_id = p_product
$$;

-- 没上架的货 = 本地两个仓的实存 − 已经放在库位上的
create or replace view app.v_unbinned as
  select w.org_id, s.product_id, sum(s.qty_on_hand)::int as on_hand,
    coalesce((select sum(i.qty) from app.bin_items i join app.bins b on b.id = i.bin_id where b.org_id = w.org_id and i.product_id = s.product_id), 0)::int as binned
  from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where w.kind = 'local' group by w.org_id, s.product_id;

-- 上架 / 补货：把没上架的货放到某个库位
create or replace function app.bin_putaway(p_org uuid, p_bin text, p_product uuid, p_qty int, p_note text) returns int
language plpgsql security definer set search_path = app, public as $$
declare v_bin uuid; v_free int; v_had int;
begin
  perform app.require_role(p_org, 'admin', 'manager', 'picker');
  if coalesce(p_qty, 0) <= 0 then raise exception 'VALIDATION: 数量要大于 0'; end if;
  select greatest(on_hand - binned, 0) into v_free from app.v_unbinned where org_id = p_org and product_id = p_product;
  if coalesce(v_free, 0) < p_qty then raise exception 'VALIDATION: 这个型号没上架的只有 % 片', coalesce(v_free, 0); end if;
  v_bin := app.bin_upsert(p_org, p_bin);
  select qty into v_had from app.bin_items where bin_id = v_bin and product_id = p_product;
  perform app.bin_change(v_bin, p_product, p_qty, case when coalesce(v_had, 0) > 0 then 'refill' else 'putaway' end, null, p_note);
  perform app.bin_sync_default(p_org, p_product);
  return p_qty;
end $$;

-- 挪库位
create or replace function app.bin_move(p_org uuid, p_from text, p_to text, p_product uuid, p_qty int) returns void
language plpgsql security definer set search_path = app, public as $$
declare a uuid; b uuid; v_has int;
begin
  perform app.require_role(p_org, 'admin', 'manager', 'picker');
  a := app.bin_upsert(p_org, p_from); b := app.bin_upsert(p_org, p_to);
  if a = b then raise exception 'VALIDATION: 挪到同一个库位'; end if;
  select qty into v_has from app.bin_items where bin_id = a and product_id = p_product;
  if coalesce(p_qty, 0) <= 0 or coalesce(v_has, 0) < p_qty then raise exception 'VALIDATION: % 这里只有 % 片', p_from, coalesce(v_has, 0); end if;
  perform app.bin_change(a, p_product, -p_qty, 'move_out', null, '挪到 ' || upper(p_to));
  perform app.bin_change(b, p_product, p_qty, 'move_in', null, '从 ' || upper(p_from) || ' 挪来');
  perform app.bin_sync_default(p_org, p_product);
end $$;

-- 出库：库位里先扣片数少的（扣完这个位置就空出来）；同时从消耗池捞（金蝶改记同组没实物的编码）
create or replace function app.trg_ship_bins() returns trigger language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_kind app.wh_kind; v_prod uuid; left_ int; r record; take int; m record; g text;
begin
  if new.reason <> 'ship' or new.qty >= 0 then return new; end if;
  select w.org_id, w.kind, s.product_id into v_org, v_kind, v_prod from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.id = new.stock_item_id;
  if v_kind <> 'local' then return new; end if;
  left_ := -new.qty;
  for r in select i.bin_id, i.qty from app.bin_items i join app.bins b on b.id = i.bin_id where b.org_id = v_org and i.product_id = v_prod and i.qty > 0 order by i.qty, b.code loop
    exit when left_ <= 0;
    take := least(r.qty, left_);
    perform app.bin_change(r.bin_id, v_prod, -take, 'ship', null, null);
    left_ := left_ - take;
  end loop;
  perform app.bin_sync_default(v_org, v_prod);
  -- 消耗池: 这个编码实物比金蝶多 → 这次出的（最多到差额）金蝶改记同组没实物的编码
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
drop trigger if exists ship_bins on app.stock_moves;
create trigger ship_bins after insert on app.stock_moves for each row execute function app.trg_ship_bins();

-- 盘点中暂停出库
create or replace function app.trg_count_freeze() returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if exists (select 1 from app.counts c join app.deals d on d.org_id = c.org_id where d.id = new.deal_id and c.status = 'open' and c.pause_ship) then
    raise exception 'BLOCKED: 正在盘点，出货暂停。盘点确认完（或中方关掉「暂停出库」）才能出库';
  end if;
  return new;
end $$;
drop trigger if exists count_freeze on app.shipments;
create trigger count_freeze before insert on app.shipments for each row execute function app.trg_count_freeze();

-- 开始盘点（一次只能有一个进行中的）
create or replace function app.count_start(p_org uuid, p_title text, p_freeze boolean) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v uuid; n int;
begin
  perform app.require_role(p_org, 'admin');
  if exists (select 1 from app.counts where org_id = p_org and status = 'open') then raise exception 'VALIDATION: 已经有一次盘点在进行'; end if;
  select count(*) + 1 into n from app.counts where org_id = p_org;
  insert into app.counts (org_id, no, title, pause_ship, started_by) values (p_org, 'PD-' || to_char(now(), 'YYMMDD') || '-' || n, coalesce(nullif(trim(p_title), ''), '盘点'), coalesce(p_freeze, true), app.uid()) returning id into v;
  return v;
end $$;
create or replace function app.count_set_freeze(p_count uuid, p_on boolean) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'admin');
  update app.counts set pause_ship = p_on where id = p_count;
end $$;
-- 分任务：谁盘哪几个货架（中方 / 主管）
create or replace function app.count_task_set(p_count uuid, p_emp uuid, p_scope text) returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  perform app.require_role(v_org, 'admin', 'manager');
  if coalesce(trim(p_scope), '') = '' then raise exception 'VALIDATION: 写清楚盘哪几个货架，例 SSA, SSB'; end if;
  insert into app.count_tasks (count_id, employee_id, scope) values (p_count, p_emp, upper(trim(p_scope))) returning id into v;
  return v;
end $$;
create or replace function app.count_task_done(p_task uuid, p_done boolean) returns void language plpgsql security definer set search_path = app, public as $$
declare t app.count_tasks; v_org uuid;
begin
  select * into t from app.count_tasks where id = p_task; select org_id into v_org from app.counts where id = t.count_id and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  if t.employee_id is distinct from app.current_employee(v_org) and not app.has_role(v_org, array['admin', 'manager']::app.role_name[]) then raise exception 'PERMISSION_DENIED: 不是你的任务'; end if;
  update app.count_tasks set status = case when p_done then 'done' else 'todo' end, done_at = case when p_done then now() end where id = p_task;
end $$;
create or replace function app.count_task_del(p_task uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select c.org_id into v_org from app.count_tasks t join app.counts c on c.id = t.count_id where t.id = p_task and c.status = 'open';
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'admin', 'manager');
  delete from app.count_tasks where id = p_task;
end $$;

-- 录一条：库位 · 型号 · 数量（同一人同库位同型号再录 = 改数）
create or replace function app.count_add(p_count uuid, p_bin text, p_product uuid, p_qty int, p_note text) returns uuid
language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_bin uuid; v_emp uuid; v_task uuid; v uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  if not app.is_member(v_org) then raise exception 'PERMISSION_DENIED'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'VALIDATION: 数量不能是负数'; end if;
  if not exists (select 1 from app.products where id = p_product and org_id = v_org) then raise exception 'VALIDATION: 型号不对'; end if;
  v_bin := app.bin_upsert(v_org, p_bin); v_emp := app.current_employee(v_org);
  select id into v_task from app.count_tasks where count_id = p_count and employee_id = v_emp and status = 'todo' order by created_at limit 1;
  select id into v from app.count_lines where count_id = p_count and bin_id = v_bin and product_id = p_product and by_user is not distinct from app.uid();
  if v is not null then update app.count_lines set qty = p_qty, note = nullif(trim(coalesce(p_note, '')), ''), at = now() where id = v;
  else insert into app.count_lines (count_id, task_id, bin_id, product_id, qty, note, by_employee, by_user) values (p_count, v_task, v_bin, p_product, p_qty, nullif(trim(coalesce(p_note, '')), ''), v_emp, app.uid()) returning id into v;
  end if;
  return v;
end $$;
create or replace function app.count_del(p_line uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare l app.count_lines; v_org uuid;
begin
  select * into l from app.count_lines where id = p_line; select org_id into v_org from app.counts where id = l.count_id and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  if l.by_user is distinct from app.uid() and not app.has_role(v_org, array['admin', 'manager']::app.role_name[]) then raise exception 'PERMISSION_DENIED: 只能删自己录的'; end if;
  delete from app.count_lines where id = p_line;
end $$;

-- 差异预览：每个编码 系统（LA + 9S）· 实物 · 差 · 进池 / 盘亏 / 盘盈
create or replace function app.count_preview(p_count uuid)
returns table (product_id uuid, grp text, sys_qty int, actual_qty int, diff int, pool_plus int, pool_minus int, loss int, gain int)
language plpgsql stable security definer set search_path = app, public as $$
#variable_conflict use_column
declare v_org uuid;
begin
  select org_id into v_org from app.counts where id = p_count;
  if v_org is null or not app.is_member(v_org) then raise exception 'PERMISSION_DENIED'; end if;
  return query
  with sys as (select s.product_id, sum(s.qty_on_hand)::int q from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where w.org_id = v_org and w.kind = 'local' group by s.product_id),
  act as (select l.product_id, sum(l.qty)::int q from app.count_lines l where l.count_id = p_count group by l.product_id),
  base as (select coalesce(s.product_id, a.product_id) pid, coalesce(s.q, 0) sq, coalesce(a.q, 0) aq from sys s full join act a on a.product_id = s.product_id where coalesce(s.q, 0) <> 0 or coalesce(a.q, 0) <> 0),
  d as (select pid, app.prod_group(pid) g, sq, aq, sq - aq dd from base),
  gm as (select g, least(sum(greatest(dd, 0)), sum(greatest(-dd, 0))) m from d group by g),
  r as (select d.*, gm.m,
      coalesce(sum(greatest(d.dd, 0)) over (partition by d.g order by greatest(d.dd, 0) desc, d.pid rows between unbounded preceding and 1 preceding), 0) cp,
      coalesce(sum(greatest(-d.dd, 0)) over (partition by d.g order by greatest(-d.dd, 0) desc, d.pid rows between unbounded preceding and 1 preceding), 0) cn
    from d join gm on gm.g = d.g)
  select pid, g, sq, aq, dd,
    least(greatest(dd, 0), greatest(m - cp, 0))::int,
    least(greatest(-dd, 0), greatest(m - cn, 0))::int,
    (greatest(dd, 0) - least(greatest(dd, 0), greatest(m - cp, 0)))::int,
    (greatest(-dd, 0) - least(greatest(-dd, 0), greatest(m - cn, 0)))::int
  from r order by g, pid;
end $$;

-- 确认：系统库存改成实物（本地两个仓按现有比例：多了加到数量最多的仓，少了从数量最多的仓开始扣）、库位按盘到的重写、记差异和消耗池、恢复出库
create or replace function app.count_apply(p_count uuid) returns jsonb language plpgsql security definer set search_path = app, public as $$
declare c app.counts; p record; s record; delta int; take int; v_bad text; n_adj int := 0; v_wh uuid;
begin
  select * into c from app.counts where id = p_count for update;
  if c.id is null or c.status <> 'open' then raise exception 'NOT_FOUND: 盘点不在进行中'; end if;
  perform app.require_role(c.org_id, 'admin');
  if not exists (select 1 from app.count_lines where count_id = p_count) then raise exception 'VALIDATION: 还一条都没盘'; end if;
  -- 盘到的比已经预占的少 → 先处理那几张单
  select string_agg(x.code || '（盘到 ' || x.aq || '，预占 ' || x.rq || '）', '、') into v_bad from (
    select pr.code, coalesce((select sum(l.qty) from app.count_lines l where l.count_id = p_count and l.product_id = s2.product_id), 0) aq, sum(s2.qty_reserved) rq
    from app.stock_items s2 join app.warehouses w on w.id = s2.warehouse_id join app.products pr on pr.id = s2.product_id
    where w.org_id = c.org_id and w.kind = 'local' group by pr.code, s2.product_id having sum(s2.qty_reserved) > coalesce((select sum(l.qty) from app.count_lines l where l.count_id = p_count and l.product_id = s2.product_id), 0)) x;
  if v_bad is not null then raise exception 'VALIDATION: 这些货盘到的比订单已经预占的还少，先处理那几张单：%', v_bad; end if;
  insert into app.count_diffs (count_id, product_id, grp, sys_qty, actual_qty, diff, pool_plus, pool_minus, loss, gain)
  select p_count, x.product_id, x.grp, x.sys_qty, x.actual_qty, x.diff, x.pool_plus, x.pool_minus, x.loss, x.gain from app.count_preview(p_count) x;
  for p in select * from app.count_diffs where count_id = p_count and diff <> 0 loop
    delta := -p.diff;   -- 实物 − 系统
    if delta > 0 then
      select s3.id into v_wh from app.stock_items s3 join app.warehouses w on w.id = s3.warehouse_id where w.org_id = c.org_id and w.kind = 'local' and s3.product_id = p.product_id order by s3.qty_on_hand desc, w.code limit 1;
      if v_wh is null then v_wh := app.stock_row(c.org_id, 'local', p.product_id); end if;
      perform app.move_stock(v_wh, delta, 'adjust', 'count', p_count);
    else
      for s in select s3.id, s3.qty_on_hand - s3.qty_reserved free from app.stock_items s3 join app.warehouses w on w.id = s3.warehouse_id where w.org_id = c.org_id and w.kind = 'local' and s3.product_id = p.product_id order by s3.qty_on_hand desc, w.code loop
        exit when delta >= 0;
        take := least(s.free, -delta);
        if take > 0 then perform app.move_stock(s.id, -take, 'adjust', 'count', p_count); delta := delta + take; end if;
      end loop;
    end if;
    n_adj := n_adj + 1;
    if p.pool_plus > 0 then insert into app.stock_pool (org_id, count_id, product_id, grp, side, qty, qty_left) values (c.org_id, p_count, p.product_id, p.grp, '+', p.pool_plus, p.pool_plus); end if;
    if p.pool_minus > 0 then insert into app.stock_pool (org_id, count_id, product_id, grp, side, qty, qty_left) values (c.org_id, p_count, p.product_id, p.grp, '-', p.pool_minus, p.pool_minus); end if;
  end loop;
  -- 库位：以前记的全部归零（记录留着），按这次盘到的重写
  for s in select i.bin_id, i.product_id, i.qty from app.bin_items i join app.bins b on b.id = i.bin_id where b.org_id = c.org_id and i.qty > 0 loop
    perform app.bin_change(s.bin_id, s.product_id, -s.qty, 'count', p_count, '盘点前清零');
  end loop;
  for s in select bin_id, product_id, sum(qty)::int q from app.count_lines where count_id = p_count group by bin_id, product_id having sum(qty) > 0 loop
    perform app.bin_change(s.bin_id, s.product_id, s.q, 'count', p_count, c.no);
  end loop;
  for s in select distinct product_id from app.count_diffs where count_id = p_count loop perform app.bin_sync_default(c.org_id, s.product_id); end loop;
  update app.counts set status = 'closed', closed_at = now(), closed_by = app.uid(), pause_ship = false where id = p_count;
  return jsonb_build_object('adjusted', n_adj,
    'pool', (select count(*) from app.stock_pool where count_id = p_count),
    'loss', (select coalesce(sum(loss), 0) from app.count_diffs where count_id = p_count),
    'gain', (select coalesce(sum(gain), 0) from app.count_diffs where count_id = p_count));
end $$;
create or replace function app.count_cancel(p_count uuid) returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.counts where id = p_count and status = 'open';
  if v_org is null then raise exception 'NOT_FOUND'; end if;
  perform app.require_role(v_org, 'admin');
  update app.counts set status = 'cancelled', closed_at = now(), closed_by = app.uid(), pause_ship = false where id = p_count;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.bins, app.bin_items, app.bin_log, app.counts, app.count_tasks, app.count_lines, app.count_diffs, app.stock_pool, app.pool_uses, app.v_unbinned to authenticated;
    grant execute on function app.bin_upsert(uuid, text), app.bin_putaway(uuid, text, uuid, int, text), app.bin_move(uuid, text, text, uuid, int),
      app.count_start(uuid, text, boolean), app.count_set_freeze(uuid, boolean), app.count_task_set(uuid, uuid, text), app.count_task_done(uuid, boolean), app.count_task_del(uuid),
      app.count_add(uuid, text, uuid, int, text), app.count_del(uuid), app.count_preview(uuid), app.count_apply(uuid), app.count_cancel(uuid), app.prod_group(uuid), app.bin_rooms(uuid) to authenticated;
  end if;
end $$;
