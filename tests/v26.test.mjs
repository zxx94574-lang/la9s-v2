// 0055 (待改 338 / 339): 挂在单据上的任务 —— 派任务带单号 / 客户; 付款计划必须结构化 (哪天付多少) + 截图; 到期没付进中方清单
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('派任务挂在订单上: 只中方; 默认期限第二天; 付款计划要日期 + 金额 + 截图; 到期没付列出来, 收到钱就不列', async () => {
  const t = await setup();
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2 and org_id = $3`, [t.ids.picker, U.picker, t.ids.org]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const p = { title: '问 CAMARA 什么时候付清', assignee: t.ids.picker, task_type: 'payment_plan', ref_kind: 'deal', ref_id: d, ref_label: 'CI-TEST' };
  await rejects(t.as(U.manager, `select app.issue_task($1,$2)`, [t.ids.org, JSON.stringify(p)]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.issue_task($1,$2)`, [t.ids.org, JSON.stringify({ ...p, ref_id: '' })]), /VALIDATION/);
  const id = await t.val(U.admin, `select app.issue_task($1,$2)`, [t.ids.org, JSON.stringify(p)]);
  const row = await t.one(`select due_on, require_photo, ref_customer_id, task_type from app.directives where id = $1`, [id]);
  assert.equal(row.require_photo, true); assert.equal(row.ref_customer_id, t.ids.camaraAbobo); assert.equal(row.task_type, 'payment_plan');
  assert.equal(new Date(row.due_on).toISOString().slice(0, 10) > new Date().toISOString().slice(0, 10), true);
  await rejects(t.as(U.picker, `select app.complete_task($1,'[]','客户说过几天','p.jpg')`, [id]), /哪天付多少/);
  await rejects(t.as(U.picker, `select app.complete_task($1,$2,'','')`, [id, JSON.stringify([{ on: '2020-01-05', amount: 3000 }])]), /拍照/);
  await t.as(U.picker, `select app.complete_task($1,$2,'老板亲口说的','p.jpg')`, [id, JSON.stringify([{ on: '2020-01-05', amount: 3000 }, { on: '2099-01-01', amount: 2500 }])]);
  const done = await t.one(`select status, done_note, result from app.directives where id = $1`, [id]);
  assert.equal(done.status, 'done'); assert.match(done.done_note, /2020-01-05 付 3,000/); assert.equal(done.result.length, 2);
  await rejects(t.as(U.manager, `select * from app.overdue_payment_plans($1)`, [t.ids.org]), /PERMISSION/);
  const od = await t.as(U.admin, `select * from app.overdue_payment_plans($1)`, [t.ids.org]);
  assert.equal(od.length, 1); assert.equal(Number(od[0].amount), 3000);
});
