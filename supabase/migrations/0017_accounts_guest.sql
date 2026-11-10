-- 0017 客户账号 + 游客询价 + 员工编号 (Frank 2026-11-01)
-- 1) 客户账号: 中方开通 (账号默认用客户手机号, 也可以改成别的), 系统生成临时密码只显示一次;
--    中方可以重置密码、冻结 / 解冻、看登录记录; 客户自己改密码要手机验证码, 改完自动生效, 同时通知中方 (不是本人就冻结).
--    密码只存加密后的 (bcrypt), 谁都看不到原文, 中方也不行 —— 忘了就重置.
-- 2) 游客询价: 一个总链接, 游客自己选销售员 (员工编号 + 全名), 填电话 / 店名 / 城市 / 称呼提交,
--    电话对上老客户就挂老客户, 对不上就新建潜客 (归属 = 选的销售员), 生成一张「已报价」单进热线待办. 游客看不到价格.
-- 3) 员工编号 emp_no 进员工档案 (游客选销售员时显示).

-- ───────── 员工编号 ─────────
create or replace function app.upsert_employee(p_org uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = app, public as $$
declare v_id uuid := p_id; v_active boolean; v_no text := nullif(upper(trim(p_data->>'emp_no')),'');
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(trim(p_data->>'short_name'),'') = '' then raise exception 'VALIDATION: 工作名必填'; end if;
  if nullif(p_data->>'email','') is not null and p_data->>'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'VALIDATION: 邮箱格式不对'; end if;
  if v_no is not null and exists (select 1 from app.employees where org_id = p_org and emp_no = v_no and id is distinct from v_id) then
    raise exception 'CONFLICT: 员工编号 % 已经有人用了', v_no;
  end if;
  v_active := coalesce((p_data->>'active')::boolean, true);
  if v_id is null then
    insert into app.employees (org_id, short_name) values (p_org, trim(p_data->>'short_name')) returning id into v_id;
  end if;
  update app.employees set short_name = trim(p_data->>'short_name'), full_name = nullif(upper(trim(p_data->>'full_name')),''),
    emp_no = case when p_data ? 'emp_no' then v_no else emp_no end,
    phone = nullif(trim(p_data->>'phone'),''), email = nullif(lower(trim(p_data->>'email')),''),
    department = nullif(p_data->>'department',''), position = nullif(p_data->>'position',''),
    sys_role = nullif(p_data->>'sys_role',''), sales_channel = nullif(p_data->>'sales_channel',''),
    joined_on = nullif(p_data->>'joined_on','')::date, resigned_on = case when v_active then null else nullif(p_data->>'resigned_on','')::date end,
    active = v_active, feishu_name = nullif(trim(p_data->>'feishu_name'),''),
    base_salary = nullif(p_data->>'base_salary','')::numeric, allowance = nullif(p_data->>'allowance','')::numeric,
    incentive_rate = nullif(p_data->>'incentive_rate','')::numeric, incentive_per_piece = nullif(p_data->>'incentive_per_piece','')::numeric,
    note = nullif(p_data->>'note',''), updated_at = now()
  where id = v_id and org_id = p_org;
  perform app.audit(p_org, 'upsert_employee', 'employees', v_id, null);
  return v_id;
end $$;

-- ───────── 客户账号 ─────────
create table app.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  customer_id uuid not null unique references app.customers(id),
  login text not null,                       -- 默认客户手机号 (只留数字), 也可以用客户编码等
  phone text,                                -- 收验证码的号码
  pass_hash text not null,
  must_change boolean not null default true, -- 临时密码登录后要求改
  status text not null default 'active' check (status in ('active','frozen')),
  user_id uuid not null default gen_random_uuid(),   -- 登录后的身份 (members 里是 boss)
  created_by uuid, created_at timestamptz not null default now(),
  last_login_at timestamptz,
  unique (org_id, login)
);
create table app.account_events (
  id bigint generated always as identity primary key,
  account_id uuid not null references app.customer_accounts(id),
  kind text not null check (kind in ('opened','reset','frozen','unfrozen','login','login_failed','pw_changed','otp_sent','login_changed')),
  at timestamptz not null default now(),
  by_user uuid, note text,
  acked_at timestamptz, acked_by uuid          -- 中方看过了 (改密码通知)
);
create table app.account_otps (
  account_id uuid primary key references app.customer_accounts(id),
  code_hash text not null, expires_at timestamptz not null, tries int not null default 0
);
alter table app.customer_accounts enable row level security; alter table app.account_events enable row level security; alter table app.account_otps enable row level security;
create policy admin_only on app.customer_accounts for select using (app.has_role(org_id, array['admin']::app.role_name[]));
create policy admin_only on app.account_events for select using (exists (select 1 from app.customer_accounts a where a.id = account_id and app.has_role(a.org_id, array['admin']::app.role_name[])));
-- account_otps: 没有 select 策略 = 谁都读不到

create or replace function app.acct_event(p_account uuid, p_kind text, p_note text default null)
returns void language sql security definer set search_path = app, public as $$
  insert into app.account_events (account_id, kind, by_user, note) values (p_account, p_kind, app.uid(), p_note)
$$;
revoke execute on function app.acct_event(uuid, text, text) from public;

create or replace function app.temp_password() returns text language sql volatile as $$
  -- 8 位, 去掉容易看错的 0/O/1/l/I
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 55)::int, 1), '') from generate_series(1, 8)
$$;

-- 开通: 返回临时密码 (只这一次看得到)
create or replace function app.account_open(p_customer uuid, p_login text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare c app.customers; v_login text; v_pw text := app.temp_password(); v_org uuid; v_acc app.customer_accounts;
begin
  select * into c from app.customers where id = p_customer;
  if not found then raise exception 'NOT_FOUND: 客户不存在'; end if;
  perform app.require_role(c.org_id, 'admin');
  if exists (select 1 from app.customer_accounts where customer_id = p_customer) then raise exception 'CONFLICT: 这个客户已经有账号了，要重置密码点「重置」'; end if;
  v_login := coalesce(nullif(lower(regexp_replace(trim(p_login), '\s', '', 'g')), ''), nullif(regexp_replace(coalesce(c.phone,''), '\D', '', 'g'), ''));
  if v_login is null then raise exception 'VALIDATION: 客户没有电话，请先补电话，或者手动填一个账号'; end if;
  if exists (select 1 from app.customer_accounts where org_id = c.org_id and login = v_login) then raise exception 'CONFLICT: 账号 % 已经被别的客户用了', v_login; end if;
  -- 客户自己的组织 (客户下单端用); 已有就沿用
  v_org := c.linked_org_id;
  if v_org is null then
    insert into app.orgs (kind, name, country, base_currency, doc_prefix) values ('customer', c.name, (select country from app.orgs where id = c.org_id), 'XOF', 'C')
    returning id into v_org;
    update app.customers set linked_org_id = v_org where id = p_customer;
  end if;
  insert into app.customer_accounts (org_id, customer_id, login, phone, pass_hash, created_by)
  values (c.org_id, p_customer, v_login, c.phone, crypt(v_pw, gen_salt('bf')), app.uid()) returning * into v_acc;
  insert into app.members (user_id, org_id, roles) values (v_acc.user_id, v_org, '{boss}');
  perform app.acct_event(v_acc.id, 'opened');
  perform app.audit(c.org_id, 'account_open', 'customer_accounts', v_acc.id, jsonb_build_object('customer', p_customer, 'login', v_login));
  return v_pw;
end $$;

create or replace function app.account_reset(p_account uuid)
returns text language plpgsql security definer set search_path = app, public as $$
declare a app.customer_accounts; v_pw text := app.temp_password();
begin
  select * into a from app.customer_accounts where id = p_account;
  perform app.require_role(a.org_id, 'admin');
  update app.customer_accounts set pass_hash = crypt(v_pw, gen_salt('bf')), must_change = true where id = p_account;
  delete from app.account_otps where account_id = p_account;
  perform app.acct_event(p_account, 'reset');
  return v_pw;
end $$;

create or replace function app.account_set_status(p_account uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.customer_accounts;
begin
  select * into a from app.customer_accounts where id = p_account;
  perform app.require_role(a.org_id, 'admin');
  if p_status not in ('active','frozen') then raise exception 'VALIDATION: 状态不对'; end if;
  update app.customer_accounts set status = p_status where id = p_account;
  update app.members set active = (p_status = 'active') where user_id = a.user_id;   -- 冻结 = 马上用不了
  perform app.acct_event(p_account, case when p_status = 'frozen' then 'frozen' else 'unfrozen' end, p_note);
end $$;

create or replace function app.account_set_login(p_account uuid, p_login text)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.customer_accounts; v_login text := lower(regexp_replace(trim(coalesce(p_login,'')), '\s', '', 'g'));
begin
  select * into a from app.customer_accounts where id = p_account;
  perform app.require_role(a.org_id, 'admin');   -- 换账号只能中方做
  if v_login = '' then raise exception 'VALIDATION: 账号不能空'; end if;
  if exists (select 1 from app.customer_accounts where org_id = a.org_id and login = v_login and id <> p_account) then raise exception 'CONFLICT: 账号已被占用'; end if;
  update app.customer_accounts set login = v_login where id = p_account;
  perform app.acct_event(p_account, 'login_changed', a.login || ' → ' || v_login);
end $$;

-- 登录 (不需要先登录). 成功返回 {user_id, customer_id, must_change}; 失败一律同一句话, 不透露账号存不存在
create or replace function app.account_login(p_login text, p_password text)
returns jsonb language plpgsql security definer set search_path = app, public as $$
declare a app.customer_accounts; v_login text := lower(regexp_replace(trim(coalesce(p_login,'')), '\s', '', 'g'));
begin
  select * into a from app.customer_accounts where login = v_login or regexp_replace(coalesce(phone,''), '\D', '', 'g') = regexp_replace(v_login, '\D', '', 'g') and v_login ~ '^\d{8,}$' limit 1;
  if not found or a.pass_hash <> crypt(coalesce(p_password,''), a.pass_hash) then
    if found then perform app.acct_event(a.id, 'login_failed'); end if;
    raise exception 'VALIDATION: 账号或密码不对';
  end if;
  if a.status = 'frozen' then raise exception 'VALIDATION: 账号已被冻结，请联系 LA&9S'; end if;
  update app.customer_accounts set last_login_at = now() where id = a.id;
  perform app.acct_event(a.id, 'login');
  return jsonb_build_object('user_id', a.user_id, 'customer_id', a.customer_id, 'must_change', a.must_change);
end $$;

-- 改密码第 1 步: 往账号绑定的手机发验证码. 现在还没接 WhatsApp / 短信, 演示版把验证码直接返回给页面显示;
-- 部署后这里改成发消息, 不再返回.
create or replace function app.account_send_otp(p_login text)
returns text language plpgsql security definer set search_path = app, public as $$
declare a app.customer_accounts; v_code text := lpad((floor(random() * 1000000))::int::text, 6, '0'); v_login text := lower(regexp_replace(trim(coalesce(p_login,'')), '\s', '', 'g'));
begin
  select * into a from app.customer_accounts where login = v_login or (v_login ~ '^\d{8,}$' and regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_login) limit 1;
  if not found then raise exception 'VALIDATION: 没有这个账号'; end if;
  if a.status = 'frozen' then raise exception 'VALIDATION: 账号已被冻结，请联系 LA&9S'; end if;
  if exists (select 1 from app.account_otps where account_id = a.id and expires_at > now() + interval '4 minutes') then raise exception 'VALIDATION: 验证码刚发过，1 分钟后再试'; end if;
  insert into app.account_otps values (a.id, crypt(v_code, gen_salt('bf')), now() + interval '5 minutes', 0)
  on conflict (account_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0;
  perform app.acct_event(a.id, 'otp_sent', a.phone);
  return v_code;
end $$;

-- 改密码第 2 步: 验证码对了就直接改 (Frank 11-01: 自动改, 通知中方, 不是本人就冻结)
create or replace function app.account_change_password(p_login text, p_code text, p_new text)
returns void language plpgsql security definer set search_path = app, public as $$
declare a app.customer_accounts; o app.account_otps; v_login text := lower(regexp_replace(trim(coalesce(p_login,'')), '\s', '', 'g'));
begin
  select * into a from app.customer_accounts where login = v_login or (v_login ~ '^\d{8,}$' and regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_login) limit 1;
  if not found then raise exception 'VALIDATION: 没有这个账号'; end if;
  select * into o from app.account_otps where account_id = a.id;
  if not found or o.expires_at < now() then raise exception 'VALIDATION: 验证码过期了，请重新获取'; end if;
  if o.tries >= 5 then raise exception 'VALIDATION: 错太多次了，请重新获取验证码'; end if;
  if o.code_hash <> crypt(coalesce(p_code,''), o.code_hash) then
    update app.account_otps set tries = tries + 1 where account_id = a.id;
    raise exception 'VALIDATION: 验证码不对';
  end if;
  if length(coalesce(p_new,'')) < 6 then raise exception 'VALIDATION: 新密码至少 6 位'; end if;
  update app.customer_accounts set pass_hash = crypt(p_new, gen_salt('bf')), must_change = false where id = a.id;
  delete from app.account_otps where account_id = a.id;
  perform app.acct_event(a.id, 'pw_changed');
end $$;

-- 中方看过改密码通知
create or replace function app.account_ack(p_event bigint)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select a.org_id into v_org from app.account_events e join app.customer_accounts a on a.id = e.account_id where e.id = p_event;
  perform app.require_role(v_org, 'admin');
  update app.account_events set acked_at = now(), acked_by = app.uid() where id = p_event;
end $$;

-- ───────── 游客询价 ─────────
alter table app.deals drop constraint if exists deals_source_check;
alter table app.deals add constraint deals_source_check check (source in ('staff','portal','guest'));
alter table app.deals add column guest_info jsonb;     -- 游客填的信息 (电话 / 店名 / 城市 / 称呼 / 选的销售员)

-- 游客能选的销售员: 员工编号 + 全名 (只列在职的销售员 / 销售主管)
create or replace function app.guest_sales(p_org uuid)
returns table (id uuid, emp_no text, full_name text, short_name text) language sql stable security definer set search_path = app, public as $$
  select e.id, e.emp_no, coalesce(e.full_name, e.short_name), e.short_name from app.employees e
  where e.org_id = p_org and e.active and e.sys_role in ('sales','sales_manager')
  order by e.emp_no nulls last, e.short_name
$$;

-- 游客能看的货: 只给有没有货, 不给数量和价格
create or replace function app.guest_catalog(p_org uuid)
returns table (id uuid, code text, category_id uuid, category text, cat_sort int, model text, variant text, shared_models text[], band text)
language sql stable security definer set search_path = app, public as $$
  select p.id, p.code, p.category_id, c.name, c.sort, p.model, p.variant, p.shared_models,
    case when s.avail >= 20 then 'ok' when s.avail > 0 then 'low' else 'none' end
  from app.products p join app.categories c on c.id = p.category_id
  left join lateral (select coalesce(sum(si.qty_on_hand - si.qty_reserved), 0) as avail from app.stock_items si join app.warehouses w on w.id = si.warehouse_id
                     where si.product_id = p.id and w.kind = 'local') s on true
  where p.org_id = p_org and p.active
$$;

-- p_info: {phone, shop, city, contact, sales_id}; p_lines: [{product_id, qty} | {category_id, model, qty}]
create or replace function app.guest_inquiry(p_org uuid, p_info jsonb, p_lines jsonb, p_note text default null)
returns text language plpgsql security definer set search_path = app, public as $$
declare v_phone text := regexp_replace(coalesce(p_info->>'phone',''), '\D', '', 'g'); c app.customers; v_sales uuid := nullif(p_info->>'sales_id','')::uuid;
  d app.deals; x jsonb; v_lines jsonb := '[]';
begin
  if length(v_phone) < 8 then raise exception 'VALIDATION: 请填正确的电话 / WhatsApp 号码'; end if;
  if coalesce(trim(p_info->>'shop'),'') = '' or coalesce(trim(p_info->>'city'),'') = '' or coalesce(trim(p_info->>'contact'),'') = '' then
    raise exception 'VALIDATION: 店名、城市、称呼都要填'; end if;
  if v_sales is not null and not exists (select 1 from app.employees where id = v_sales and org_id = p_org and active) then v_sales := null; end if;
  -- 同一个号码 10 分钟内只能提交 3 次 (防乱刷)
  if (select count(*) from app.deals dd join app.customers cc on cc.id = dd.customer_id
      where dd.org_id = p_org and dd.source = 'guest' and regexp_replace(coalesce(cc.phone,''), '\D', '', 'g') = v_phone and dd.created_at > now() - interval '10 minutes') >= 3 then
    raise exception 'VALIDATION: 提交太频繁了，请稍后再试，或直接联系销售员';
  end if;
  for x in select * from jsonb_array_elements(coalesce(p_lines,'[]')) loop
    if coalesce((x->>'qty')::int, 0) <= 0 then continue; end if;
    if nullif(x->>'product_id','') is not null then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('product_id', x->>'product_id', 'qty_req', (x->>'qty')::int));
    elsif coalesce(trim(x->>'model'),'') <> '' then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('req_category_id', nullif(x->>'category_id',''), 'req_model', upper(trim(x->>'model')), 'qty_req', (x->>'qty')::int));
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'VALIDATION: 请先选型号和数量'; end if;
  select * into c from app.customers where org_id = p_org and regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_phone limit 1;
  if not found then
    insert into app.customers (org_id, temp_code, name, city, status, phone, source, owner_employee_id, kind, shop_name, note)
    values (p_org, app.next_doc_no(p_org, 'T'), upper(trim(p_info->>'shop')), trim(p_info->>'city'), 'prospect', trim(p_info->>'phone'), 'guest', v_sales, 'spare',
      upper(trim(p_info->>'shop')), '游客询价 · 称呼：' || trim(p_info->>'contact'))
    returning * into c;
  elsif c.owner_employee_id is null and v_sales is not null then
    update app.customers set owner_employee_id = v_sales where id = c.id;   -- 老客户没归属才挂上; 有归属的不改 (改归属只中方)
  end if;
  insert into app.deals (org_id, biz_no, quote_no, customer_id, currency, owner_employee_id, note, source, guest_info)
  values (p_org, app.next_doc_no(p_org,'BIZ'), app.next_doc_no(p_org,'QT'), c.id, 'XOF', coalesce(c.owner_employee_id, v_sales),
    concat_ws(' · ', '游客询价', nullif(trim(p_note),'')), 'guest', p_info)
  returning * into d;
  perform app.write_lines(d, v_lines);
  perform app.deal_event(d.id, 'quote_created', jsonb_build_object('source', 'guest', 'lines', jsonb_array_length(v_lines)));
  perform app.evaluate_approval(d.id);
  return d.biz_no;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on app.customer_accounts, app.account_events to authenticated;
    grant execute on function app.account_open(uuid, text), app.account_reset(uuid), app.account_set_status(uuid, text, text), app.account_set_login(uuid, text),
      app.account_ack(bigint), app.upsert_employee(uuid, uuid, jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then   -- 不登录也能用的: 登录、改密码、游客询价
    grant usage on schema app to anon;
    grant execute on function app.account_login(text, text), app.account_send_otp(text), app.account_change_password(text, text, text),
      app.guest_sales(uuid), app.guest_catalog(uuid), app.guest_inquiry(uuid, jsonb, jsonb, text) to anon;
  end if;
end $$;
