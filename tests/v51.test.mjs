// 0085: 指令编号 / 撤销写原因 / 订单超时原因
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('指令编号 T-月日-序号; 撤销必须写原因', async () => {
  const t = await setup();
  const emp = t.ids.sales; await t.db.query(`update app.members set employee_id = $1 where user_id = $2 and org_id = $3`, [emp, U.picker, t.ids.org]);
  const mk = () => t.val(U.admin, `select app.issue_directive($1,$2)`, [t.ids.org, JSON.stringify({ title: '测试指令', assignee: emp })]);
  await mk(); await mk();
  const rows = (await t.db.query(`select id, no from app.directives where not is_template order by created_at, no`)).rows;
  assert.ok(rows.length >= 2);
  assert.match(rows[0].no, /^T-\d{4}-01$/); assert.match(rows[1].no, /^T-\d{4}-02$/);
  await assert.rejects(t.as(U.admin, `select app.stop_directive2($1,'')`, [rows[0].id]), /原因/);
  await assert.rejects(t.as(U.manager, `select app.stop_directive2($1,'下错人')`, [rows[0].id]), /PERMISSION/);
  await t.as(U.admin, `select app.stop_directive2($1,'下错人')`, [rows[0].id]);
  const d = await t.one(`select status, stop_reason, confirm_note from app.directives where id = $1`, [rows[0].id]);
  assert.equal(d.status, 'closed'); assert.equal(d.stop_reason, '下错人'); assert.match(d.confirm_note, /下错人/);
});

test('订单超时原因: 成员能写, 留在订单记录里', async () => {
  const t = await setup();
  const d = (await t.db.query(`select id from app.deals limit 1`)).rows[0];
  if (!d) return;
  await assert.rejects(t.as(U.manager, `select app.deal_delay_note($1,1,'')`, [d.id]), /原因/);
  await t.as(U.manager, `select app.deal_delay_note($1,1,'货架换位置')`, [d.id]);
  const e = await t.one(`select detail from app.deal_events where deal_id = $1 and action = 'delay_note'`, [d.id]);
  assert.equal(e.detail.reason, '货架换位置'); assert.equal(e.detail.seg, 1);
});
