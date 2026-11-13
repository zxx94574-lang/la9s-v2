-- 只在服务器 (Supabase) 上跑, 在 0001 之前. 浏览器版 (PGlite) 不需要.
-- Supabase 把 pgcrypto 装在 extensions 模式里; 迁移里的函数 search_path = app, public, 找不到 crypt / gen_salt.
-- 在 public 里放两个同名转发函数, 不改任何已发布的迁移.
create or replace function public.crypt(text, text) returns text language sql immutable strict set search_path = '' as $$ select extensions.crypt($1, $2) $$;
create or replace function public.gen_salt(text) returns text language sql volatile strict set search_path = '' as $$ select extensions.gen_salt($1) $$;
create or replace function public.gen_salt(text, integer) returns text language sql volatile strict set search_path = '' as $$ select extensions.gen_salt($1, $2) $$;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
-- 「自动开 RLS」选项建的辅助函数, 不该让未登录 / 普通用户调用
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
