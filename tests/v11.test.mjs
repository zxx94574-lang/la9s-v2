// 0035 (Frank 11-11): 收款三段状态 + 手续费 + 员工代收 + 改冲账 + 对账盘点 + 月结锁账 + 坏账核销 + 账户互转在途
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const wave = (t) => t.val(U.admin, `select app.upsert_cash_account($1,null,'Wave-XOF','wave','XOF',null,null,null)`, [t.ids.org]);
const rc = (t, who, p) => t.val(who, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: new Date().toISOString().slice(0, 10), currency: 'XOF', method: 'wave', mode: 'oldest', proof: 'x.jpg', ...p })]);
const bal = (t, a) => t.val(U.admin, `select app.account_balance($1)`, [a]).then(Number);

test('手续费我方出: 冲客户账 = 到账 + 手续费; 确认到账后账户进到账金额、记一笔手续费支出', async () => {
  const t = await setup(); const a = await wave(t);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const before = await t.balance(t.ids.camaraAbobo);
  const id = await rc(t, U.finance, { amount_landed: 9900, fee: 100, fee_bearer: 'company', account_id: a });
  assert.equal(await t.balance(t.ids.camaraAbobo), before - 10000);
  assert.equal(await bal(t, a), 0, '没确认到账前账户不动');
  await rejects(t.as(U.finance, `select app.verify_receipt($1)`, [id]), /不能自己确认/);
  await t.as(U.admin, `select app.verify_receipt($1)`, [id]);
  assert.equal(await bal(t, a), 9900 - 100);
  const r = await t.one(`select verify_status, fee_bearer from app.receipts where id=$1`, [id]);
  assert.equal(r.verify_status, 'verified');
});

test('手续费客户出: 冲客户账 = 到账; 导入流水金额对上自动确认到账', async () => {
  const t = await setup(); const a = await wave(t);
  const id = await rc(t, U.finance, { amount_landed: 10000, fee: 100, fee_bearer: 'customer', account_id: a });
  assert.equal(await t.balance(t.ids.camaraAbobo), -10000);
  await t.as(U.finance, `select app.record_deposit($1,current_date,10000,'CAMARA','TX9',null)`, [a]);
  assert.equal(Number(await t.val(U.finance, `select app.auto_verify_receipts($1)`, [a])), 1);
  assert.equal((await t.one(`select verify_status from app.receipts where id=$1`, [id])).verify_status, 'verified');
  assert.equal(await bal(t, a), 10000, '流水那笔认领了, 没重复记');
});

test('员工代收: 客户账照冲; 没交不能确认到账; 交到 Wave 后进账户', async () => {
  const t = await setup(); const a = await wave(t);
  const id = await rc(t, U.finance, { amount_landed: 50000, method: 'cash', collector_employee_id: t.ids.sales });
  assert.equal(await t.balance(t.ids.camaraAbobo), -50000);
  assert.equal((await t.as(U.admin, `select * from app.v_staff_held`)).length, 1);
  await rejects(t.as(U.admin, `select app.verify_receipt($1)`, [id]), /还没交/);
  await t.as(U.admin, `select app.receipt_handed($1,$2,'wave.jpg')`, [id, a]);
  assert.equal(await bal(t, a), 50000);
  assert.equal((await t.as(U.admin, `select * from app.v_staff_held`)).length, 0);
});

test('改冲账: 从 A 单挪到 B 单 / 挪成预付; 原因必填; 不能超过目标欠款', async () => {
  const t = await setup();
  const d1 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]); await t.shipAll(d1);
  const d2 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]); await t.shipAll(d2);
  const due1 = Number(await t.due(d1));
  const id = await rc(t, U.finance, { amount_landed: 1000, mode: 'specific', targets: [d1] });
  await rejects(t.as(U.finance, `select app.reallocate_receipt($1,$2,500,$3,'')`, [id, d1, d2]), /原因/);
  await t.as(U.finance, `select app.reallocate_receipt($1,$2,600,$3,'客户说这笔付的是第二单')`, [id, d1, d2]);
  assert.equal(Number(await t.due(d1)), due1 - 400);
  await t.as(U.finance, `select app.reallocate_receipt($1,$2,400,null,'先当预付')`, [id, d1]);
  assert.equal(Number(await t.due(d1)), due1);
  await rejects(t.as(U.finance, `select app.reallocate_receipt($1,$2,999999,$3,'x')`, [id, d2, d1]), /只有/);
});

test('对账 / 盘点: 差额要写原因, 盘点要照片; 月结: 有问题不让锁, 锁了不能再记那个月', async () => {
  const t = await setup(); const a = await wave(t);
  await t.as(U.finance, `select app.record_deposit($1,date_trunc('month', current_date)::date - 3,7000,'X',null,null)`, [a]);
  await t.as(U.admin, `select app.mark_other_income(id,'内部转入') from app.cash_moves where account_id=$1`, [a]);
  const last = (await t.one(`select (date_trunc('month', current_date) - interval '1 day')::date::text as d`)).d;
  await rejects(t.as(U.finance, `select app.record_cash_check($1,'recon',$2,6500,null,null)`, [a, last]), /要写原因/);
  await rejects(t.as(U.finance, `select app.record_cash_check($1,'count',$2,7000,null,null)`, [a, last]), /拍照/);
  await rejects(t.as(U.admin, `select app.lock_month($1,$2)`, [t.ids.org, last]), /没对账/);
  await t.as(U.finance, `select app.record_cash_check($1,'recon',$2,7000,null,'app.jpg')`, [a, last]);
  await t.as(U.admin, `select app.lock_month($1,$2)`, [t.ids.org, last]);
  await rejects(t.as(U.finance, `select app.record_deposit($1,$2::date,100,'Y',null,null)`, [a, last]), /已锁账/);
  await rejects(t.as(U.admin, `select app.unlock_month($1,$2,'')`, [t.ids.org, last]), /原因/);
  await t.as(U.admin, `select app.unlock_month($1,$2,'补录')`, [t.ids.org, last]);
});

test('坏账核销只中方 + 原因 + 留记录; 账户互转在途到了才加', async () => {
  const t = await setup(); const a = await wave(t);
  const b = await t.val(U.admin, `select app.upsert_cash_account($1,null,'Cash-XOF','cash','XOF',null,null,null)`, [t.ids.org]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 1 }]); await t.shipAll(d);
  const due = Number(await t.due(d));
  await rejects(t.as(U.finance, `select app.write_off_bad_debt($1,$2,'跑了')`, [d, due]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.write_off_bad_debt($1,$2,'客户跑了，追不回','chat.jpg')`, [d, due]);
  assert.equal(Number(await t.due(d)), 0);
  assert.equal((await t.as(U.admin, `select * from app.bad_debt_writeoffs`)).length, 1);
  await t.as(U.finance, `select app.record_deposit($1,current_date,20000,'Z',null,null)`, [a]);
  const pair = await t.val(U.finance, `select app.transfer_between($1,$2,5000,current_date,'交现金')`, [a, b]);
  assert.equal(await bal(t, a), 15000); assert.equal(await bal(t, b), 0, '在途不算');
  const mv = await t.val(U.finance, `select id from app.cash_moves where pair_id=$1 and kind='transfer_in'`, [pair]);
  await t.as(U.finance, `select app.transfer_arrived($1)`, [mv]);
  assert.equal(await bal(t, b), 5000);
});
