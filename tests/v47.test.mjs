// 0079: 制单指令 —— 交的时候必须选订单; 候选只列同一客户、指令下达后新建的; 订单上记「来自中方指令」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('制单指令: 候选订单 / 必须选单据 / 订单记来源; 其他类型照片也行', async () => {
  const t = await setup();
  const hot = (await t.one(`insert into app.employees (org_id, short_name, active) values ($1,'热线员',true) returning id`, [t.ids.org])).id;
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2`, [hot, U.hotline]);
  const old = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.x6516, qty_req: 3 }])]);
  await t.db.query(`update app.deals set created_at = now() - interval '1 hour' where id = $1`, [old]);
  const id = await t.val(U.admin, `select app.issue_directive3($1,$2)`, [t.ids.org, JSON.stringify({ title: '制单：CAMARA 群里下的单', assignees: [hot], dir_type: '制单', customer_id: t.ids.camaraAbobo })]);
  const dir = await t.one(`select id, dir_type, ref_customer_id from app.directives where assignee_employee_id = $1 order by created_at desc limit 1`, [hot]);
  assert.equal(dir.dir_type, '制单'); assert.equal(dir.ref_customer_id, t.ids.camaraAbobo);
  await assert.rejects(t.as(U.hotline, `select app.complete_directive2($1,'建好了',null)`, [dir.id]), /选你做好的那张单据/);
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 5 }])]);
  const other = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraOme, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 5 }])]);
  const c = await t.as(U.hotline, `select * from app.directive_candidates($1)`, [dir.id]);
  assert.deepEqual(c.map((x) => x.id), [deal]);           // 老单、别的客户的单都不在
  await assert.rejects(t.as(U.hotline, `select app.complete_directive2($1,null,null,'deal',$2)`, [dir.id, other]), /不能当/);
  await t.as(U.hotline, `select app.complete_directive2($1,null,null,'deal',$2)`, [dir.id, deal]);
  const after = await t.one(`select status, proof_label from app.directives where id = $1`, [dir.id]);
  assert.equal(after.status, 'done'); assert.match(after.proof_label, /^CI-/);
  assert.ok((await t.db.query(`select 1 from app.deal_events where deal_id = $1 and action = 'from_directive'`, [deal])).rows.length);
  // 其他类型: 文字 / 照片照样能交
  await t.val(U.admin, `select app.issue_directive3($1,$2)`, [t.ids.org, JSON.stringify({ title: '盘点 A 架', assignees: [hot], dir_type: '其他' })]);
  const d2 = await t.one(`select id from app.directives where title = '盘点 A 架'`);
  await t.as(U.hotline, `select app.complete_directive2($1,'盘完了，少 2 个',null)`, [d2.id]);
  void id;
});
