# 服务器（Supabase）部署说明

- 项目：`la9s-staging`（ref `jqtkftmcrgfozbilvyzg`，eu-central-1 法兰克福，免费版，只放演示数据）
- 组织 LA9S，公司邮箱 la9s.admin@gmail.com

## 装 / 升级数据库
1. 先跑 `0000_supabase_compat.sql`（只在服务器上跑：pgcrypto 在 extensions 模式里，给 crypt / gen_salt 加转发；收回 rls_auto_enable 的执行权）。
2. 按编号依次跑 `supabase/migrations/*.sql`，每跑一个往 `supabase_migrations.schema_migrations` 记一行；已记过的跳过。迁移只加不改（铁规矩）。
3. 跑 `smoke.sql`：主链走一遍 + 跨公司权限隔离，最后抛 `SMOKE_RESULT …` 整笔回滚，不留数据。期望 `status=shipped stock=50 ledger=33000.00 own_org_sees=1 other_org_sees=0`。

工具：Supabase Management API（`POST /v1/projects/{ref}/database/query`），钥匙是 Frank 生成的临时 Access Token，**不进仓库、不写进任何文件**。

## 2026-11-13 首次部署
- 0001–0046 全部装上；结构和本地测试库逐项一致（82 张表 / 17 个视图 / 276 个函数 / 23 个触发器）。
- 冒烟测试通过。安全检查剩：11 个函数没固定 search_path（警告级，上线前收口时加迁移统一处理）、2 张表开了 RLS 没策略（本来就只走函数，正常）。
