-- 服务器版前端的数据通道 (只在 Supabase 上, 浏览器 PGlite 版不需要).
-- 前端现在到处是直接写的 SQL; 线上演示环境先用这个通道跑通, 正式上线前要换成一个个具体的接口 (见待改清单).
-- 安全边界:
--   · 以登录用户 (authenticated) 的身份执行 (security invoker) → 读表受 RLS 限制, 写只能走带权限检查的 app.* 函数;
--   · 套在子查询里执行 → 只能是一条 SELECT / WITH, 不能直接 insert/update/delete/set;
--   · 禁止碰会话设置 (防止冒充别人身份) 和几个危险函数.
create or replace function public.exec_sql(q text)
returns jsonb language plpgsql security invoker set search_path = app, public as $$
declare r jsonb; l text := lower(q);
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED: 请先登录'; end if;
  if l ~ '(set_config|current_setting|pg_sleep|pg_read|pg_ls|lo_import|lo_export|dblink|copy\s|pg_terminate|pg_cancel|\bset\s+(role|session|local)|\breset\b)' then
    raise exception 'FORBIDDEN: 这条查询不允许';
  end if;
  execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (' || q || ') t' into r;
  return r;
end $$;
revoke all on function public.exec_sql(text) from public, anon;
grant execute on function public.exec_sql(text) to authenticated;
