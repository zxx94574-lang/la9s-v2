-- 0106 (Frank 11-27 15:12 / 15:21)
-- A. 采购单 = 物流全程: 金蝶采购订单表头照搬 (物流公司 / 运输方式 / 物流单号 / 件数 / 重量体积 / 预估物流费 / 发出日期 / 交货日期),
--    外贸常用的补上 (提单号、柜号、到港 / 清关 / 提货日期), 单号各有各的格子, 不再堆在备注里.
--    文件附件 (装箱单 / 发票 / 提单 / 提货单 / 海关文件…): 国内一拿到就传, 提货单没传不能标「已提货」.
--    预计到货: 没填 = 发货日 + 75 天 (2 个半月, 规则可调); 改日期必须写原因, 每次留延误记录.
-- B. 下班卡后锁系统: 打了下班卡 / 过了晚上截止时间 / 早上开门前 → 本地员工进不了系统; 中方 / 国家经理 / 国内不锁; 中方可当天放行一次.

alter table app.purchase_orders
  add column if not exists forwarder text,          -- 物流公司 / 货代 (金蝶「物流公司」: 赛时 / 捷道 / 古月…)
  add column if not exists tracking_no text,        -- 物流单号 / 提单号 B/L / 空运单号 AWB
  add column if not exists container_no text,       -- 柜号 (+ 封条号, 写一起)
  add column if not exists weight_vol text,         -- 货物重量与体积 (金蝶原样: 「2.1方」「820kg」)
  add column if not exists freight_est numeric,     -- 预估物流费 (CNY)
  add column if not exists freight_none boolean,    -- 无物流费 (FOB 无运费)
  add column if not exists arrived_on date,         -- 到港
  add column if not exists cleared_on date,         -- 清关完
  add column if not exists picked_on date,          -- 已提货 (要先有提货单)
  add column if not exists eta_first date,          -- 第一次定的预计到货
  add column if not exists eta_changes int not null default 0;

create table if not exists app.po_eta_log (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references app.purchase_orders(id) on delete cascade,
  old_eta date, new_eta date, reason text,
  created_by uuid default app.uid(), created_at timestamptz not null default now()
);
create index if not exists po_eta_log_po on app.po_eta_log (po_id, created_at);

create table if not exists app.po_docs (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references app.purchase_orders(id) on delete cascade,
  kind text not null,                 -- 选项组 po_doc_kind (⚙ 可加); pickup = 提货单 (流程上要它)
  name text, file text not null, note text,
  removed boolean not null default false,
  created_by uuid default app.uid(), created_at timestamptz not null default now()
);
create index if not exists po_docs_po on app.po_docs (po_id);

create or replace function app.po_eta_days(p_org uuid) returns int language sql stable security definer set search_path = app, public as $$
  select coalesce((select nullif(value->>'eta_days', '')::numeric::int from app.org_settings where org_id = p_org and key = 'po_rules'), 75)
$$;

create or replace function app.set_po_info2(p_po uuid, p jsonb)
returns void language plpgsql security definer set search_path = app, public as $$
declare po app.purchase_orders; v_new date; v_ship date;
begin
  select * into po from app.purchase_orders where id = p_po for update;
  if po.id is null then raise exception 'NOT_FOUND: 采购单'; end if;
  perform app.require_role(po.org_id, 'admin', 'manager', 'cn_support');
  if p ? 'mode' and coalesce(p->>'mode', '') not in ('', 'sea', 'air', 'other') then raise exception 'VALIDATION: 运输方式只能是 海运 / 空运 / 其他'; end if;
  if p ? 'picked_on' and nullif(p->>'picked_on', '') is not null
     and not exists (select 1 from app.po_docs where po_id = p_po and kind = 'pickup' and not removed) then
    raise exception 'VALIDATION: 先上传提货单，才能标「已提货」';
  end if;
  update app.purchase_orders set
    supplier     = case when p ? 'supplier'     then nullif(trim(p->>'supplier'), '')     else supplier end,
    mode         = coalesce(nullif(p->>'mode', ''), mode),
    forwarder    = case when p ? 'forwarder'    then nullif(trim(p->>'forwarder'), '')    else forwarder end,
    tracking_no  = case when p ? 'tracking_no'  then nullif(upper(trim(p->>'tracking_no')), '')  else tracking_no end,
    container_no = case when p ? 'container_no' then nullif(upper(trim(p->>'container_no')), '') else container_no end,
    weight_vol   = case when p ? 'weight_vol'   then nullif(trim(p->>'weight_vol'), '')   else weight_vol end,
    freight_est  = case when p ? 'freight_est'  then nullif(p->>'freight_est', '')::numeric else freight_est end,
    freight_none = case when p ? 'freight_none' then (p->>'freight_none')::boolean else freight_none end,
    batch_name   = case when p ? 'batch_name'   then nullif(trim(p->>'batch_name'), '')   else batch_name end,
    warehouse_nos = case when p ? 'warehouse_nos' then coalesce((select array_agg(distinct upper(x)) from regexp_split_to_table(coalesce(p->>'warehouse_nos', ''), '[\s/,;，；]+') x where x <> ''), '{}') else warehouse_nos end,
    boxes        = case when p ? 'boxes'        then nullif(p->>'boxes', '')::numeric::int else boxes end,
    pcs          = case when p ? 'pcs'          then nullif(p->>'pcs', '')::numeric::int else pcs end,
    shipped_on   = case when p ? 'shipped_on'   then nullif(p->>'shipped_on', '')::date else shipped_on end,
    arrived_on   = case when p ? 'arrived_on'   then nullif(p->>'arrived_on', '')::date else arrived_on end,
    cleared_on   = case when p ? 'cleared_on'   then nullif(p->>'cleared_on', '')::date else cleared_on end,
    picked_on    = case when p ? 'picked_on'    then nullif(p->>'picked_on', '')::date else picked_on end,
    note         = case when p ? 'note'         then nullif(trim(p->>'note'), '')         else note end,
    updated_at = now()
  where id = p_po;
  -- 预计到货: 改已有的日期要写原因并留记录
  if p ? 'eta' then
    v_new := nullif(p->>'eta', '')::date;
    if po.eta is not null and v_new is distinct from po.eta then
      if coalesce(trim(p->>'eta_reason'), '') = '' then raise exception 'VALIDATION: 改预计到货要写原因（例：船晚开 / 清关慢）'; end if;
      insert into app.po_eta_log (po_id, old_eta, new_eta, reason) values (p_po, po.eta, v_new, trim(p->>'eta_reason'));
      update app.purchase_orders set eta = v_new, eta_changes = eta_changes + 1 where id = p_po;
    elsif po.eta is null and v_new is not null then
      update app.purchase_orders set eta = v_new, eta_first = coalesce(eta_first, v_new) where id = p_po;
    end if;
  end if;
  -- 没有预计到货 → 发货日 + 75 天 (默认 2 个半月)
  select shipped_on into v_ship from app.purchase_orders where id = p_po;
  update app.purchase_orders set eta = v_ship + app.po_eta_days(org_id), eta_first = coalesce(eta_first, v_ship + app.po_eta_days(org_id))
  where id = p_po and eta is null and v_ship is not null;
  perform app.audit(po.org_id, 'set_po_info2', 'purchase_orders', p_po, p - 'file');
end $$;

create or replace function app.add_po_doc(p_po uuid, p_kind text, p_name text, p_file text, p_note text default null)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_id uuid;
begin
  select org_id into v_org from app.purchase_orders where id = p_po;
  if v_org is null then raise exception 'NOT_FOUND: 采购单'; end if;
  perform app.require_role(v_org, 'admin', 'manager', 'cn_support');
  if coalesce(trim(p_kind), '') = '' then raise exception 'VALIDATION: 要选文件类型'; end if;
  if coalesce(p_file, '') = '' then raise exception 'VALIDATION: 没有文件'; end if;
  insert into app.po_docs (po_id, kind, name, file, note) values (p_po, trim(p_kind), nullif(trim(p_name), ''), p_file, nullif(trim(p_note), '')) returning id into v_id;
  perform app.audit(v_org, 'add_po_doc', 'purchase_orders', p_po, jsonb_build_object('kind', p_kind, 'name', p_name));
  return v_id;
end $$;

create or replace function app.remove_po_doc(p_doc uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid; v_po uuid; v_kind text;
begin
  select p.org_id, d.po_id, d.kind into v_org, v_po, v_kind from app.po_docs d join app.purchase_orders p on p.id = d.po_id where d.id = p_doc;
  if v_org is null then raise exception 'NOT_FOUND: 文件'; end if;
  perform app.require_role(v_org, 'admin', 'manager', 'cn_support');
  if v_kind = 'pickup' and exists (select 1 from app.purchase_orders where id = v_po and picked_on is not null)
     and not exists (select 1 from app.po_docs where po_id = v_po and kind = 'pickup' and not removed and id <> p_doc) then
    raise exception 'BAD_STATE: 已经提货了，提货单不能删（要换就先传新的再删）';
  end if;
  update app.po_docs set removed = true where id = p_doc;
  perform app.audit(v_org, 'remove_po_doc', 'purchase_orders', v_po, jsonb_build_object('doc', p_doc));
end $$;

-- 金蝶采购订单导入后: 把表头的物流信息填进对应格子 (只填空的, 系统里已经改过的不盖)
create or replace function app.set_po_logistics_bulk(p_org uuid, p_rows jsonb)
returns int language plpgsql security definer set search_path = app, public as $$
declare x jsonb; n int := 0; v_po app.purchase_orders; v_tr text;
begin
  perform app.require_role(p_org, 'admin', 'manager');
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    select * into v_po from app.purchase_orders where org_id = p_org and po_no = x->>'po_no';
    if v_po.id is null then continue; end if;
    v_tr := nullif(upper(trim(x->>'tracking_no')), '');
    if v_tr in ('暂无', '无', '-') then v_tr := null; end if;
    update app.purchase_orders set
      forwarder   = coalesce(forwarder, nullif(trim(x->>'forwarder'), '')),
      weight_vol  = coalesce(weight_vol, nullif(trim(x->>'weight_vol'), '')),
      freight_est = coalesce(freight_est, nullif(x->>'freight_est', '')::numeric),
      shipped_on  = coalesce(shipped_on, nullif(x->>'shipped_on', '')::date),
      boxes       = coalesce(boxes, nullif(x->>'pieces', '')::numeric::int),
      -- 金蝶「物流单号」里常常填的是入仓号 (CG… / LKY…Y): 认出来就并进入仓号, 其余才当物流单号
      warehouse_nos = case when v_tr ~ '^(CG|LKY|LAY|TG)\d{6,}[A-Z]?$|^\d{9}Y$' and not (v_tr = any(coalesce(warehouse_nos, '{}'))) then coalesce(warehouse_nos, '{}') || v_tr else warehouse_nos end,
      tracking_no = case when tracking_no is null and v_tr is not null and v_tr !~ '^(CG|LKY|LAY|TG)\d{6,}[A-Z]?$|^\d{9}Y$' then v_tr else tracking_no end,
      freight_none = coalesce(freight_none, case when remark ~ '无物流费|无运费' then true end),
      eta_first = coalesce(eta_first, eta)
    where id = v_po.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── B. 下班后锁系统 ──
create table if not exists app.access_unlocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  employee_id uuid not null references app.employees(id),
  on_date date not null, reason text,
  created_by uuid default app.uid(), created_at timestamptz not null default now()
);
create index if not exists access_unlocks_k on app.access_unlocks (org_id, employee_id, on_date);

-- 设置 org_settings 'offhours_lock': {enabled, cutoff 'HH:MM', reopen 'HH:MM', exempt [岗位], exempt_emps [员工 id]}
create or replace function app.offhours_cfg(p_org uuid) returns jsonb language sql stable security definer set search_path = app, public as $$
  select jsonb_build_object('enabled', true, 'cutoff', '21:00', 'reopen', '06:00',
    'exempt', '["admin","country_manager","cn_support","cn_business","cn_finance"]'::jsonb, 'exempt_emps', '[]'::jsonb)
    || coalesce((select value from app.org_settings where org_id = p_org and key = 'offhours_lock'), '{}'::jsonb)
$$;

create or replace function app.offhours_state(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare cfg jsonb := app.offhours_cfg(p_org); m app.members;
  v_today date := (now() at time zone 'Africa/Abidjan')::date; v_now time := (now() at time zone 'Africa/Abidjan')::time;
  v_out timestamptz; v_cut time; v_open time;
begin
  if not coalesce((cfg->>'enabled')::boolean, true) then return jsonb_build_object('locked', false, 'off', true); end if;
  select * into m from app.members where user_id = app.uid() and org_id = p_org and active limit 1;
  if m.user_id is null then return jsonb_build_object('locked', false); end if;
  if m.roles::text[] && array(select jsonb_array_elements_text(cfg->'exempt')) then return jsonb_build_object('locked', false, 'exempt', true); end if;
  if m.employee_id is not null and (cfg->'exempt_emps') ? m.employee_id::text then return jsonb_build_object('locked', false, 'exempt', true); end if;
  if m.employee_id is not null and exists (select 1 from app.access_unlocks where org_id = p_org and employee_id = m.employee_id and on_date = v_today) then
    return jsonb_build_object('locked', false, 'unlocked', true);
  end if;
  v_cut := coalesce(nullif(cfg->>'cutoff', '')::time, '21:00'); v_open := coalesce(nullif(cfg->>'reopen', '')::time, '06:00');
  select max(at) into v_out from app.attendance where org_id = p_org and user_id = app.uid() and kind = 'out' and (at at time zone 'Africa/Abidjan')::date = v_today;
  if v_out is not null then return jsonb_build_object('locked', true, 'reason', 'out', 'out_at', v_out, 'reopen', left(v_open::text, 5)); end if;
  if v_now >= v_cut then return jsonb_build_object('locked', true, 'reason', 'late', 'cutoff', left(v_cut::text, 5), 'reopen', left(v_open::text, 5)); end if;
  if v_now < v_open then return jsonb_build_object('locked', true, 'reason', 'early', 'reopen', left(v_open::text, 5)); end if;
  return jsonb_build_object('locked', false, 'cutoff', left(v_cut::text, 5));
end $$;

create or replace function app.grant_access_unlock(p_org uuid, p_emp uuid, p_reason text)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_today date := (now() at time zone 'Africa/Abidjan')::date;
begin
  if not app.has_role_txt(p_org, array['admin', 'country_manager']) then raise exception 'PERMISSION_DENIED: 只有中方 / 国家经理能放行'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'VALIDATION: 写一下为什么放行（例：今晚要盘点）'; end if;
  insert into app.access_unlocks (org_id, employee_id, on_date, reason) values (p_org, p_emp, v_today, trim(p_reason));
  perform app.audit(p_org, 'grant_access_unlock', 'employees', p_emp, jsonb_build_object('reason', p_reason));
end $$;

-- 今天被锁 / 放行的人 (给中方看): 打过下班卡的本地员工 + 今天的放行记录
create or replace function app.offhours_today(p_org uuid)
returns table (employee_id uuid, name text, out_at timestamptz, unlocked boolean, unlock_reason text)
language plpgsql stable security definer set search_path = app, public as $$
declare cfg jsonb := app.offhours_cfg(p_org); v_today date := (now() at time zone 'Africa/Abidjan')::date;
begin
  if not app.has_role_txt(p_org, array['admin', 'country_manager']) then raise exception 'PERMISSION_DENIED'; end if;
  return query
  select e.id, coalesce(e.short_name, e.full_name)::text,
    (select max(a.at) from app.attendance a where a.org_id = p_org and a.employee_id = e.id and a.kind = 'out' and (a.at at time zone 'Africa/Abidjan')::date = v_today),
    exists (select 1 from app.access_unlocks u where u.org_id = p_org and u.employee_id = e.id and u.on_date = v_today),
    (select u.reason from app.access_unlocks u where u.org_id = p_org and u.employee_id = e.id and u.on_date = v_today order by u.created_at desc limit 1)
  from app.employees e
  join app.members m on m.employee_id = e.id and m.org_id = p_org and m.active
  where e.org_id = p_org and not (m.roles::text[] && array(select jsonb_array_elements_text(cfg->'exempt')))
    and not ((cfg->'exempt_emps') ? e.id::text)
  order by 3 desc nulls last, 2;
end $$;

revoke all on function app.set_po_info2(uuid, jsonb), app.add_po_doc(uuid, text, text, text, text), app.remove_po_doc(uuid), app.set_po_logistics_bulk(uuid, jsonb),
  app.offhours_state(uuid), app.grant_access_unlock(uuid, uuid, text), app.offhours_today(uuid), app.po_eta_days(uuid), app.offhours_cfg(uuid) from public;
grant execute on function app.set_po_info2(uuid, jsonb), app.add_po_doc(uuid, text, text, text, text), app.remove_po_doc(uuid), app.set_po_logistics_bulk(uuid, jsonb),
  app.offhours_state(uuid), app.grant_access_unlock(uuid, uuid, text), app.offhours_today(uuid), app.po_eta_days(uuid), app.offhours_cfg(uuid) to authenticated;
grant select on app.po_eta_log, app.po_docs, app.access_unlocks to authenticated;
