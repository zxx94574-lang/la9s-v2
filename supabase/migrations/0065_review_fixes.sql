-- 0065 (Frank 11-18 403 / 404): 复检抽出问题必须当场改好并留记录; 复检最终数 = 实际发货数
-- 每一行: 复检实点数 (复核人数出来的) ＋ 补上的 − 放回的 ＝ 最终打包数 (系统算, 人不能直接改结果).
--   多了 → 原路放回货架 + 拍照;  少了 → 去拿来补上 + 拍照, 或者真没货 → 少发 (写原因, 客户重新确认变动的行).
-- 每一笔放回 / 补上 / 少发都是一条记录 (谁、几点、几片、照片), 并算到找货人头上 (找货出错记录).

create table app.review_fixes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.orgs(id),
  deal_id uuid not null references app.deals(id) on delete cascade,
  deal_line_id uuid not null references app.deal_lines(id) on delete cascade,
  expected int not null,            -- 该有几片 (找货交的数)
  counted int not null,             -- 复核人实点几片
  action text not null check (action in ('put_back', 'refill', 'less')),   -- 放回 / 补上 / 少发
  qty int not null check (qty > 0), -- 放回 / 补上 / 少发 了几片
  final_qty int not null,           -- 这一行最后打包几片
  photo text, reason text,
  picker_employee_id uuid references app.employees(id),     -- 找货的人 (出错记到他头上)
  reviewer_employee_id uuid references app.employees(id),
  by_user uuid, at timestamptz not null default now()
);
create index on app.review_fixes (deal_id);
create index on app.review_fixes (picker_employee_id, at);
alter table app.review_fixes enable row level security;
create policy read_own on app.review_fixes for select using (app.is_member(org_id));
grant select on app.review_fixes to authenticated;

-- p_lines: [{ line_id, counted, action, photo, reason }]  (只传实点数和该有的不一样的行)
create or replace function app.review_pick_fixed(p_deal uuid, p_reviewer uuid, p_photo text, p_lines jsonb default '[]', p_checks jsonb default '[]')
returns app.deal_status language plpgsql security definer set search_path = app, public as $$
declare d app.deals; x jsonb; l app.deal_lines; v_cnt int; v_act text; v_qty int; v_final int; v_actual jsonb := '[]'; v_checks jsonb := coalesce(p_checks, '[]');
begin
  select * into d from app.deals where id = p_deal;
  if d.id is null then raise exception 'NOT_FOUND: 订单不存在'; end if;
  perform app.require_role(d.org_id, 'manager');
  if d.status <> 'confirmed' then raise exception 'BAD_STATE: 这张单现在不在「待复检打包」'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    select * into l from app.deal_lines where id = (x->>'line_id')::uuid and deal_id = p_deal;
    if not found then raise exception 'NOT_FOUND: line'; end if;
    v_cnt := (x->>'counted')::int; v_act := x->>'action';
    if v_cnt is null or v_cnt < 0 then raise exception 'VALIDATION: 实点数要填'; end if;
    if v_cnt = l.qty_supply then continue; end if;
    if v_cnt > l.qty_supply then
      if v_act is distinct from 'put_back' then raise exception 'VALIDATION: 多出来的要放回货架（加货请走追加）'; end if;
      if coalesce(x->>'photo', '') = '' then raise exception 'VALIDATION: 放回货架要拍照'; end if;
      v_qty := v_cnt - l.qty_supply; v_final := l.qty_supply;
    elsif v_act = 'refill' then
      if coalesce(x->>'photo', '') = '' then raise exception 'VALIDATION: 补上的货要拍照确认'; end if;
      v_qty := l.qty_supply - v_cnt; v_final := l.qty_supply;
    elsif v_act = 'less' then
      if coalesce(trim(x->>'reason'), '') = '' then raise exception 'VALIDATION: 少发要写原因'; end if;
      v_qty := l.qty_supply - v_cnt; v_final := v_cnt;
      v_actual := v_actual || jsonb_build_object('line_id', l.id, 'qty', v_cnt, 'reason', trim(x->>'reason'));
    else raise exception 'VALIDATION: 少了的行要选「补上」还是「少发」';
    end if;
    insert into app.review_fixes (org_id, deal_id, deal_line_id, expected, counted, action, qty, final_qty, photo, reason, picker_employee_id, reviewer_employee_id, by_user)
    values (d.org_id, p_deal, l.id, l.qty_supply, v_cnt, v_act, v_qty, v_final, nullif(x->>'photo', ''), nullif(trim(x->>'reason'), ''), d.picker_employee_id, p_reviewer, app.uid());
    perform app.deal_event(p_deal, 'review_fix', jsonb_build_object('line', l.id, 'expected', l.qty_supply, 'counted', v_cnt, 'action', v_act, 'qty', v_qty, 'final', v_final, 'reason', x->>'reason'));
    -- 数量不对 = 找货出错: 没单独选抽检结果的, 自动记一条
    if not exists (select 1 from jsonb_array_elements(v_checks) c where c->>'line_id' = l.id::text) then
      v_checks := v_checks || jsonb_build_object('line_id', l.id, 'result', 'qty_wrong', 'note', case when v_cnt > l.qty_supply then '多了 ' || v_qty || ' 片，已放回' when v_act = 'refill' then '少了 ' || v_qty || ' 片，已补上' else '少了 ' || v_qty || ' 片，少发' end);
    end if;
  end loop;
  return app.review_pick(p_deal, p_reviewer, p_photo, v_actual, v_checks);
end $$;
revoke all on function app.review_pick_fixed(uuid, uuid, text, jsonb, jsonb) from public;
grant execute on function app.review_pick_fixed(uuid, uuid, text, jsonb, jsonb) to authenticated;
