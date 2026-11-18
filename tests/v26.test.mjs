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
  assert.equal(od.length, 1); assert.equal(Number(od[0].amount), 3000); assert.equal(Number(od[0].short), 3000);
  // 0056: 核对金额 —— 只付了 1,000 还是欠 2,000; 付够 3,000 才不列
  const pay = (amt) => t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: new Date().toISOString().slice(0, 10), currency: 'XOF', method: 'cash', mode: 'oldest', proof: 'x.jpg', amount_landed: amt })]);
  await pay(1000);
  const od2 = await t.as(U.admin, `select * from app.overdue_payment_plans($1)`, [t.ids.org]);
  assert.equal(od2.length, 1); assert.equal(Number(od2[0].paid), 1000); assert.equal(Number(od2[0].short), 2000);
  await pay(2000);
  assert.equal((await t.as(U.admin, `select * from app.overdue_payment_plans($1)`, [t.ids.org])).length, 0);
  const tb = await t.as(U.admin, `select * from app.task_board($1)`, [t.ids.org]);
  assert.equal(tb.length, 1); assert.equal(tb[0].ref_label, 'CI-TEST');
});

test('0056 期限到几点; 「必须先做完」的任务没关 → 订单推不下去也出不了库, 中方确认后放行', async () => {
  const t = await setup();
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2 and org_id = $3`, [t.ids.picker, U.picker, t.ids.org]);
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 3 }])]);
  const id = await t.val(U.admin, `select app.issue_task($1,$2)`, [t.ids.org, JSON.stringify({ title: '先核对客户地址', assignee: t.ids.picker, task_type: 'check', ref_kind: 'deal', ref_id: d, ref_label: 'X', blocks: true, due_at: '2030-01-02T15:30:00Z' })]);
  const row = await t.one(`select due_at, blocks from app.directives where id = $1`, [id]);
  assert.equal(new Date(row.due_at).toISOString(), '2030-01-02T15:30:00.000Z'); assert.equal(row.blocks, true);
  const id2 = await t.val(U.admin, `select app.issue_task($1,$2)`, [t.ids.org, JSON.stringify({ title: '默认期限', assignee: t.ids.picker, ref_kind: 'customer', ref_id: t.ids.camaraAbobo })]);
  const r2 = await t.one(`select due_at, blocks, ref_customer_id from app.directives where id = $1`, [id2]);
  assert.equal(new Date(r2.due_at).getUTCHours(), 12); assert.equal(r2.blocks, false); assert.equal(r2.ref_customer_id, t.ids.camaraAbobo);
  await rejects(t.as(U.manager, `select app.start_picking($1)`, [d]), /TASK_BLOCK/);
  await t.as(U.picker, `select app.complete_task($1,null,'地址对了','')`, [id]);
  await rejects(t.as(U.manager, `select app.start_picking($1)`, [d]), /TASK_BLOCK/);   // 做完了但中方还没确认
  await t.as(U.admin, `select app.confirm_directive($1,true,null)`, [id]);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  assert.equal(await t.status(d), 'picking');
});
