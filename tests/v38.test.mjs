// 0068: 指令 / 定期任务下给部门 + 汇报人; 异常的单总入口 + 已处理记录
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('指令下给部门: 全员一行; 指定人汇报 → 其他人点收到就关; 全体汇报 → 每人都要交', async () => {
  const t = await setup();
  const mk = async (n) => (await t.one(`insert into app.employees (org_id, short_name, department) values ($1,$2,'wh') returning id`, [t.ids.org, n])).id;
  const a = await mk('WA'); const b = await mk('WB'); const c = await mk('WC');
  await rejects(t.val(U.admin, `select app.issue_directive2($1,$2)`, [t.ids.org, JSON.stringify({ title: '盘点 A 架', dept: 'wh', report_mode: 'named', reporters: [] })]), /谁来汇报/);
  await t.val(U.admin, `select app.issue_directive2($1,$2)`, [t.ids.org, JSON.stringify({ title: '盘点 A 架', dept: 'wh', report_mode: 'named', reporters: [a] })]);
  let rows = (await t.db.query(`select assignee_employee_id, reporter, group_id, target_dept from app.directives where title = '盘点 A 架' order by reporter desc`)).rows;
  assert.equal(rows.length, 3); assert.equal(rows[0].assignee_employee_id, a); assert.equal(rows.filter((r) => r.reporter).length, 1);
  assert.equal(new Set(rows.map((r) => r.group_id)).size, 1); assert.equal(rows[0].target_dept, 'wh');
  // b 只要收到: 点收到 → 关
  await t.db.query(`insert into app.members (user_id, org_id, roles, employee_id) values ('00000000-0000-0000-0000-0000000000b1', $1, '{picker}', $2)`, [t.ids.org, b]);
  const bid = (await t.one(`select id from app.directives where title = '盘点 A 架' and assignee_employee_id = $1`, [b])).id;
  await t.as('00000000-0000-0000-0000-0000000000b1', `select app.ack_directive2($1,'在忙')`, [bid]);
  assert.equal((await t.one(`select status from app.directives where id = $1`, [bid])).status, 'closed');
  await t.val(U.admin, `select app.issue_directive2($1,$2)`, [t.ids.org, JSON.stringify({ title: '全员签到', dept: 'wh', report_mode: 'all' })]);
  rows = (await t.db.query(`select reporter from app.directives where title = '全员签到'`)).rows;
  assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.reporter));
  // 离职免交
  await t.db.query(`update app.employees set active = false where id = $1`, [c]);
  assert.equal((await t.db.query(`select 1 from app.directives where assignee_employee_id = $1 and status <> 'closed'`, [c])).rows.length, 0);
  // 单人 (多个)
  await t.val(U.admin, `select app.issue_directive2($1,$2)`, [t.ids.org, JSON.stringify({ title: '回访客户', assignees: [a, b] })]);
  assert.equal((await t.db.query(`select 1 from app.directives where title = '回访客户' and reporter`)).rows.length, 2);
});

test('定期任务: 模板一条, 到日子按人展开, 同一天不重复生成, 必须拍照', async () => {
  const t = await setup();
  const a = (await t.one(`insert into app.employees (org_id, short_name, department) values ($1,'WA','wh') returning id`, [t.ids.org])).id;
  const dow = (await t.one(`select extract(isodow from current_date)::int as d, extract(day from current_date)::int as m`));
  await t.val(U.admin, `select app.issue_directive2($1,$2)`, [t.ids.org, JSON.stringify({ title: '打扫仓库', dept: 'wh', report_mode: 'all', recurring: { freq: 'weekly', weekdays: [dow.d], at: '16:30' } })]);
  await t.val(U.admin, `select app.issue_directive2($1,$2)`, [t.ids.org, JSON.stringify({ title: '月底盘点', assignees: [a], recurring: { freq: 'monthly', month_days: [dow.m === 1 ? 2 : 1] } })]);
  const n1 = (await t.db.query(`select require_photo, at_time, parent_id from app.directives where title = '打扫仓库' and not is_template`)).rows;
  assert.equal(n1.length, 1); assert.equal(n1[0].require_photo, true); assert.equal(n1[0].at_time, '16:30'); assert.ok(n1[0].parent_id);
  await t.val(U.admin, `select app.spawn_directives($1)`, [t.ids.org]);
  assert.equal((await t.db.query(`select 1 from app.directives where title = '打扫仓库' and not is_template`)).rows.length, 1, '同一天不重复');
  assert.equal((await t.db.query(`select 1 from app.directives where title = '月底盘点' and not is_template`)).rows.length, 0, '不是今天的不生成');
});

test('异常的单: 出现记一条, 处理完转成已处理记录 (谁、怎么处理); 员工看不到带成本的', async () => {
  const t = await setup();
  await t.db.query(`update app.org_settings set value = '{"on":true}' where org_id = $1 and key = 'credit_gate'`, [t.ids.org]);
  await t.db.query(`update app.customers set credit_limit = 1000 where id = $1`, [t.ids.camaraAbobo]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  await t.val(U.admin, `select app.sync_anomalies($1)`, [t.ids.org]);
  let open = (await t.db.query(`select * from app.anomaly_log where org_id = $1 and resolved_at is null`, [t.ids.org])).rows;
  const cr = open.find((x) => x.kind === 'credit' && x.deal_id === d);
  assert.ok(cr, '超欠款上限进异常: ' + JSON.stringify(open.map((x) => x.kind)));
  await t.val(U.admin, `select app.sync_anomalies($1)`, [t.ids.org]);
  assert.equal((await t.db.query(`select 1 from app.anomaly_log where kind = 'credit' and deal_id = $1`, [d])).rows.length, 1, '不重复记');
  await t.as(U.admin, `select app.release_ship_gate($1,'credit','老客户，周五付')`, [d]);
  await t.val(U.manager, `select app.sync_anomalies($1)`, [t.ids.org]);
  const done = await t.one(`select * from app.anomaly_log where id = $1`, [cr.id]);
  assert.ok(done.resolved_at); assert.equal(done.resolved_by, U.admin); assert.match(done.resolution, /中方放行.*周五付/);
  const hist = (await t.db.query(`select set_config('request.jwt.claim.sub', $2, true), * from app.anomaly_list($1, false)`, [t.ids.org, U.manager]).catch(() => ({ rows: null }))).rows;
  const viaAs = await t.val(U.manager, `select count(*)::int from app.anomaly_list($1, false)`, [t.ids.org]);
  assert.ok(viaAs >= 1, '已处理记录里有'); void hist;
  // 带成本的 (admin_only) 员工看不到
  await t.db.query(`insert into app.anomaly_log (org_id, kind, key, summary, admin_only, detail) values ($1,'loss_block','x','卖价低于成本',true,'{"cost":1}')`, [t.ids.org]);
  assert.equal(await t.val(U.manager, `select count(*)::int from app.anomaly_list($1, true) where kind = 'loss_block'`, [t.ids.org]), 0);
  assert.equal(await t.val(U.admin, `select count(*)::int from app.anomaly_list($1, true) where kind = 'loss_block'`, [t.ids.org]), 1);
});
