-- 0093 应收期初差异表（体检第 3 组 / 待改 118）：系统应收以飞书为准起步；金蝶和系统的差额单独记在这里，不混进日常账。
-- 财务把金蝶「应收款余额表」粘进来（客户编码 + 金额 [+ 币别]）→ 每个客户一行：系统余额 / 金蝶余额 / 差；跑通后中方逐个「已调平」写原因。
create table if not exists app.kd_opening_diff (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  as_of date not null,
  customer_id uuid references app.customers(id),
  customer_code text not null,
  currency text not null default 'XOF',
  sys_amount numeric(18,2) not null default 0,
  kd_amount numeric(18,2) not null default 0,
  note text,
  cleared_at timestamptz, cleared_by uuid, clear_note text,
  created_at timestamptz not null default now(), created_by uuid,
  unique (org_id, as_of, customer_code, currency));
alter table app.kd_opening_diff enable row level security;
create policy read_own on app.kd_opening_diff for select using (app.is_member(org_id));

-- p_rows: [{code, amount, currency?}]；同一天再粘一次 = 覆盖这一天的（已调平的不动）
create or replace function app.kd_opening_paste(p_org uuid, p_as_of date, p_rows jsonb)
returns int language plpgsql security definer set search_path = app, public as $$
declare r jsonb; v_c uuid; v_cur text; v_sys numeric; n int := 0;
begin
  perform app.require_role(p_org, 'admin', 'finance');
  delete from app.kd_opening_diff where org_id = p_org and as_of = p_as_of and cleared_at is null;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_cur := upper(coalesce(nullif(trim(r->>'currency'), ''), 'XOF'));
    select id into v_c from app.customers where org_id = p_org and upper(code) = upper(trim(r->>'code'));
    select coalesce(sum(amount), 0) into v_sys from app.ar_entries where org_id = p_org and customer_id = v_c and currency = v_cur and at < p_as_of + 1;
    insert into app.kd_opening_diff (org_id, as_of, customer_id, customer_code, currency, sys_amount, kd_amount, created_by)
      values (p_org, p_as_of, v_c, upper(trim(r->>'code')), v_cur, coalesce(v_sys, 0), coalesce((r->>'amount')::numeric, 0), app.uid())
      on conflict (org_id, as_of, customer_code, currency) do nothing;
    n := n + 1;
  end loop;
  -- 系统里有余额、金蝶表里没出现的客户也列出来（金蝶 = 0）
  insert into app.kd_opening_diff (org_id, as_of, customer_id, customer_code, currency, sys_amount, kd_amount, created_by)
    select p_org, p_as_of, c.id, c.code, e.currency, sum(e.amount), 0, app.uid()
    from app.ar_entries e join app.customers c on c.id = e.customer_id
    where e.org_id = p_org and e.at < p_as_of + 1 and c.code is not null
    group by c.id, c.code, e.currency having sum(e.amount) <> 0
    on conflict (org_id, as_of, customer_code, currency) do nothing;
  perform app.audit(p_org, 'kd_opening_paste', 'kd_opening_diff', null, jsonb_build_object('as_of', p_as_of, 'rows', n));
  return n;
end $$;

create or replace function app.kd_opening_clear(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = app, public as $$
declare v_org uuid;
begin
  select org_id into v_org from app.kd_opening_diff where id = p_id;
  perform app.require_role(v_org, 'admin');
  if coalesce(trim(p_note), '') = '' then raise exception '写一下怎么调平的'; end if;
  update app.kd_opening_diff set cleared_at = now(), cleared_by = app.uid(), clear_note = trim(p_note) where id = p_id;
  perform app.audit(v_org, 'kd_opening_clear', 'kd_opening_diff', p_id, jsonb_build_object('note', p_note));
end $$;
