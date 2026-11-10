# LA&9S Operations v2

科特迪瓦销售系统重建版。需求依据：`docs/需求原话记录.md`（Frank 原话，冲突时以时间靠后的为准）与 `CLAUDE.md`。

## 怎么打开演示版

- **最简单**：双击 `启动演示版.command`（Mac）。浏览器会自动打开 http://localhost:5173 ，关闭终端窗口即停止。不需要联网，也不需要 `npm install`，用的是已经构建好的 `dist/`。
- **开发模式**：`npm install && npm run dev`
- **重新构建**：`npm run build` → 产物在 `dist/`

演示版完全在浏览器里运行：PGlite（WebAssembly 版 PostgreSQL）跑的是和正式版**同一套** `supabase/migrations`，所以权限、预占、冲账这些规则跟正式版一致。数据存在浏览器的 IndexedDB 里，刷新不会丢；右上角 ⚙ 可以重置。**演示版只放虚构数据。**

## 架构

| 层 | 选择 | 原因 |
|---|---|---|
| 数据库 | PostgreSQL (Supabase) | 事务、行锁保证库存/账款不出错；多组织隔离用 RLS |
| 业务规则 | `supabase/migrations/0003_functions.sql` 里的 SQL 函数 | 规则在服务器强制执行，前端无法绕过；一个函数 = 一个业务动作 |
| 前端 | React 18 + Vite 5（`src/`） | 演示版用 PGlite；正式版把 `src/db/client.js` 换成 Supabase 客户端即可 |
| 登录 | Supabase Auth（演示版用右上角「岗位」切换模拟） | |

## 前端目录

```
src/db/bootstrap.js   迁移 + 虚构演示数据（浏览器和 node 测试共用）
src/db/client.js      浏览器数据库；call(岗位, sql) = 以该岗位身份调用业务函数
src/db/queries.js     界面用到的全部只读 SQL
src/lib/domain.js     状态/岗位/选项文案；权限镜像（真正的闸门在 SQL）
src/components/       Grid（类 Excel 表格）、ModelPicker、LineEntry、Doc（打印/复制图片）、日期选择等
src/pages/            经营总览、待办、新建报价、订单总览、订单工作流（Deal + DealPanels）、收款、客户总账、库存、未满足需求
scripts/serve.mjs     零依赖静态服务器（给 启动演示版.command 用）
```

## 业务主链（每一步一个函数）

```
create_quote → hotline_confirm → start_picking(预占) → submit_pick(找货人+照片) → review_pick
→ create_sales_order(手改价需二次确认) → customer_confirm → ship(可分批) → mark_received(金蝶可补录)
收款: record_receipt(oldest/specific/manual/none, 锁定汇率) · apply_unallocated
退货: request_return → decide_return(中方) → inspect_return_line(好货回原仓/坏货报废)
其他: edit_quote · refresh_prices(不覆盖手改价) · set_line_price(仅中方) · add_lines_before_ship · cancel_deal · import_opening(期初作为一单)
```

## 测试

```sh
npm install
npm test          # 20 个规则验收场景 + 1 个演示数据场景，在内嵌 PostgreSQL 上跑真实迁移
```
