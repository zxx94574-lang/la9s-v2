// 0093: 应收期初差异表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('期初差异: 粘金蝶应收 → 每客户 系统/金蝶/差; 系统有余额金蝶没有的也列; 调平要写原因, 只中方', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.one(`insert into app.ar_entries (org_id, customer_id, currency, kind, amount) values ($1,$2,'XOF','opening',500000)`, [org, t.ids.camaraAbobo]);
  await t.one(`insert into app.ar_entries (org_id, customer_id, currency, kind, amount) values ($1,$2,'XOF','opening',80000) returning id`, [org, t.ids.bigS]);
  await assert.rejects(t.as(U.picker, `select app.kd_opening_paste($1, current_date, '[]')`, [org]), /PERMISSION/);
  const n = await t.val(U.finance, `select app.kd_opening_paste($1, current_date, $2)`, [org, JSON.stringify([{ code: 'c001', amount: 450000 }, { code: 'C999', amount: 1000 }])]);
  assert.equal(n, 2);
  const rows = await t.as(U.admin, `select customer_code, customer_id is not null as known, sys_amount::numeric s, kd_amount::numeric k from app.kd_opening_diff order by customer_code`);
  const by = Object.fromEntries(rows.map((r) => [r.customer_code, r]));
  assert.equal(Number(by.C001.s), 500000); assert.equal(Number(by.C001.k), 450000);
  assert.equal(by.C999.known, false);
  assert.equal(Number(by.C003.s), 80000); assert.equal(Number(by.C003.k), 0);
  const id = (await t.one(`select id from app.kd_opening_diff where customer_code = 'C001'`)).id;
  await assert.rejects(t.as(U.finance, `select app.kd_opening_clear($1,'x')`, [id]), /PERMISSION/);
  await assert.rejects(t.as(U.admin, `select app.kd_opening_clear($1,'  ')`, [id]), /怎么调平/);
  await t.as(U.admin, `select app.kd_opening_clear($1,'金蝶补录了一张')`, [id]);
  // 再粘一次: 已调平的不动
  await t.val(U.finance, `select app.kd_opening_paste($1, current_date, $2)`, [org, JSON.stringify([{ code: 'C001', amount: 1 }])]);
  assert.ok((await t.one(`select cleared_at from app.kd_opening_diff where id = $1`, [id])).cleared_at);
  // 不影响客户 Balance
  assert.equal(await t.balance(t.ids.camaraAbobo), 500000);
});

test('0094 批次付款汇率: 存得进, 非正数拒绝', async () => {
  const t = await setup();
  const id = await t.val(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mScreen, JSON.stringify({ qty: 100, currency: 'CNY', unit_price: 30, pay_rate: 92.5 })]);
  assert.equal(Number((await t.one(`select pay_rate from app.product_batches where id = $1`, [id])).pay_rate), 92.5);
  await assert.rejects(t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mScreen, JSON.stringify({ qty: 1, unit_price: 1, pay_rate: 0 })]), /汇率要大于 0/);
  await t.as(U.admin, `select app.save_product_batch($1,$2,$3)`, [t.ids.bg6mScreen, id, JSON.stringify({ qty: 100, currency: 'CNY', unit_price: 30 })]);
  assert.equal((await t.one(`select pay_rate from app.product_batches where id = $1`, [id])).pay_rate, null);
});

test('0095 审批三种模式: self 直接生效 / notify 生效 + 知会 / approve 要另一位中方批, 不能自己批自己', async () => {
  const t = await setup();
  const org = t.ids.org;
  const A2 = '00000000-0000-0000-0000-0000000000a2';
  await t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{admin}')`, [A2, org]);
  const args = { product: t.ids.bg6mCover, price: 1000, from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), note: '清货', label: '清仓价' };
  // self (没设置)
  const r1 = await t.val(U.admin, `select app.decision_submit($1,'promo','清仓 BG6M 盖',null,$2)`, [org, JSON.stringify(args)]);
  assert.equal(r1.mode, 'self');
  // approve
  await t.as(U.admin, `select app.set_org_setting($1,'approval_modes',$2)`, [org, JSON.stringify({ promo: { mode: 'approve' }, writeoff: { mode: 'notify' } })]);
  const r2 = await t.val(U.admin, `select app.decision_submit($1,'promo','清仓 BG6M 盖',$2,$3)`, [org, JSON.stringify({ 库存: 500 }), JSON.stringify({ ...args, price: 900 })]);
  assert.equal(r2.mode, 'approve');
  await assert.rejects(t.as(U.admin, `select app.decision_approve($1)`, [r2.id]), /不能自己批自己/);
  await assert.rejects(t.as(U.manager, `select app.decision_approve($1)`, [r2.id]), /PERMISSION/);
  await t.as(A2, `select app.decision_approve($1,'可以，价再高点',$2)`, [r2.id, JSON.stringify({ ...args, price: 950 })]);
  const d = await t.one(`select status, (args->>'price')::numeric p, report ? '改前参数' as edited from app.decisions where id = $1`, [r2.id]);
  assert.equal(d.status, 'done'); assert.equal(Number(d.p), 950); assert.equal(d.edited, true);
  await assert.rejects(t.as(A2, `select app.decision_approve($1)`, [r2.id]), /处理过了/);
  // 退回要写意见; 提的人自己撤 = cancelled
  const r3 = await t.val(U.admin, `select app.decision_submit($1,'promo','x',null,$2)`, [org, JSON.stringify(args)]);
  await assert.rejects(t.as(A2, `select app.decision_reject($1,' ')`, [r3.id]), /写意见/);
  await t.as(U.admin, `select app.decision_reject($1,'不做了')`, [r3.id]);
  assert.equal((await t.one(`select status from app.decisions where id = $1`, [r3.id])).status, 'cancelled');
  await assert.rejects(t.as(U.admin, `select app.decision_submit($1,'drop_table','x',null,'{}')`, [org]), /不能走审批/);
  await assert.rejects(t.as(U.manager, `select app.decision_submit($1,'promo','x',null,$2)`, [org, JSON.stringify(args)]), /PERMISSION/);
});
