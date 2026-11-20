-- 0073: 下班打卡时记下「还有几件待办没做完」(448, Frank 11-19 22:22) —— 中方在打卡「今天」表里看得到谁留了尾巴
alter table app.attendance add column todo_left int;
create or replace function app.punch_left(p_org uuid, p_n int)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if not app.is_member(p_org) then raise exception 'PERMISSION_DENIED'; end if;
  update app.attendance set todo_left = greatest(coalesce(p_n, 0), 0)
  where id = (select id from app.attendance where org_id = p_org and user_id = app.uid() and kind = 'out'
              and (at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date order by at desc limit 1);
end $$;
revoke all on function app.punch_left(uuid, int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function app.punch_left(uuid, int) to authenticated; end if;
end $$;
