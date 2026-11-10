// 0010 资金账户 / 公户 (Frank 2026-10-29): 到账不动欠款 → 中方认领才冲账; 交款两边确认; 500 万 / 7 天预警; 支出审批; 流水导入去重
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const hold = (t, a) => t.one(`select * from app.v_cash_holding where account_id=$1`, [a]);

async function acct(t) {
  return t.val(U.admin, `select app.upsert_cash_account($1,null,'公户 · Roland','bank','XOF',$2,5000000,7)`, [t.ids.org, t.ids.sales]);
}

test('到账: 登记不动客户欠款; 中方认领才生成收款冲最老的单; 认领过不能再认', async () => {
  const t = await setup();
  const a = await acct(t);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  const before = await t.balance(t.ids.camaraAbobo);
  const m = await t.val(U.finance, `select app.record_deposit($1,current_date,3000,'CAMARA','TX1','s.jpg')`, [a]);
  assert.equal(await t.balance(t.ids.camaraAbobo), before, '到账不动欠款');
  assert.equal(Number((await hold(t, a)).unclaimed_amount), 3000);
  await rejects(t.as(U.finance, `select app.claim_deposit($1,$2)`, [m, t.ids.camaraAbobo]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.claim_deposit($1,$2)`, [m, t.ids.camaraAbobo]);
  assert.equal(await t.balance(t.ids.camaraAbobo), before - 3000);
  assert.equal(Number(await t.due(d)), before - 3000);
  await rejects(t.as(U.admin, `select app.claim_deposit($1,$2)`, [m, t.ids.camaraAbobo]), /已经处理过/);
  assert.equal(Number((await hold(t, a)).balance), 3000, '钱还在罗安手上');
});

test('付款通知: 热线挂截图; 金额日期对得上自动配对; 认领后通知变已配对', async () => {
  const t = await setup();
  const a = await acct(t);
  await rejects(t.as(U.hotline, `select app.record_payment_notice($1,250000,'XOF','bank',current_date,'')`, [t.ids.bigS]), /截图/);
  const n = await t.val(U.hotline, `select app.record_payment_notice($1,250000,'XOF','bank',current_date - 1,'shot.jpg')`, [t.ids.bigS]);
  await t.as(U.finance, `select app.record_deposit($1,current_date,250000,'SOUMAHORO',null,null)`, [a]);
  await t.as(U.finance, `select app.record_deposit($1,current_date - 10,250000,'X',null,null)`, [a]);   // 日期太远, 不配
  const ms = await t.as(U.admin, `select * from app.v_notice_matches where notice_id=$1`, [n]);
  assert.equal(ms.length, 1);
  await t.as(U.admin, `select app.claim_deposit($1,$2,'none','[]',$3)`, [ms[0].move_id, t.ids.bigS, n]);
  assert.equal((await t.one(`select status from app.payment_notices where id=$1`, [n])).status, 'matched');
  assert.equal(await t.balance(t.ids.bigS), -250000, '没欠款 → 预付');
});

test('压款预警: 超 500 万; 超 7 天按先进先出算; 交款要中方确认才减', async () => {
  const t = await setup();
  const a = await acct(t);
  await t.as(U.finance, `select app.record_deposit($1,current_date - 9,1000000,'A',null,null)`, [a]);
  await t.as(U.finance, `select app.record_deposit($1,current_date - 2,4500000,'B',null,null)`, [a]);
  let h = await hold(t, a);
  assert.equal(Number(h.balance), 5500000); assert.equal(h.over_limit, true); assert.equal(h.over_days, true);
  const ho = await t.val(U.finance, `select app.request_handover($1,1000000,current_date,'bank.jpg')`, [a]);
  h = await hold(t, a);
  assert.equal(Number(h.balance), 5500000, '没确认不减'); assert.equal(Number(h.handover_pending), 1000000);
  await rejects(t.as(U.finance, `select app.decide_move($1,true)`, [ho]), /PERMISSION_DENIED/);
  assert.equal(await t.val(U.admin, `select app.decide_move($1,true)`, [ho]), 'confirmed');
  h = await hold(t, a);
  assert.equal(Number(h.balance), 4500000); assert.equal(h.over_limit, false);
  assert.equal(h.over_days, false, '9 天前那笔已经交掉, 剩下的才 2 天');
});

test('支出: 默认全部要中方批; 设了审批线后线下直接生效; 不批要写原因', async () => {
  const t = await setup();
  const a = await acct(t);
  await t.as(U.finance, `select app.record_deposit($1,current_date,100000,'A',null,null)`, [a]);
  await rejects(t.as(U.finance, `select app.record_expense($1,5000,current_date,'',null,'x')`, [a]), /科目/);
  const s1 = await t.val(U.finance, `select app.record_expense($1,5000,current_date,'交通费',null,'Yango')`, [a]);
  assert.equal(s1, 'pending');
  assert.equal(Number((await hold(t, a)).balance), 100000);
  await t.as(U.admin, `select app.set_cash_settings($1,10000,3)`, [t.ids.org]);
  assert.equal(await t.val(U.finance, `select app.record_expense($1,8000,current_date,'交通费',null,'Yango')`, [a]), 'approved');
  assert.equal(await t.val(U.finance, `select app.record_expense($1,20000,current_date,'房租',null,'')`, [a]), 'pending');
  const p = (await t.one(`select id from app.cash_moves where kind='expense' and amount=20000`)).id;
  await rejects(t.as(U.admin, `select app.decide_move($1,false,'')`, [p]), /原因/);
  await t.as(U.admin, `select app.decide_move($1,false,'太贵')`, [p]);
  assert.equal(Number((await hold(t, a)).balance), 92000);
});

test('流水导入: 进账成待认领, 出账成待说明; 重复导入跳过; 中方把出账说明成交款', async () => {
  const t = await setup();
  const a = await acct(t);
  const rows = [{ date: '2026-10-20', amount: 300000, ref: 'B1', payer: 'KONE' }, { date: '2026-10-21', amount: -200000, ref: 'B2', desc: 'retrait' }, { date: '2026-10-21', amount: 0 }];
  assert.deepEqual(await t.val(U.finance, `select app.import_statement($1,$2)`, [a, JSON.stringify(rows)]), { in: 1, out: 1, dup: 0 });
  assert.deepEqual(await t.val(U.finance, `select app.import_statement($1,$2)`, [a, JSON.stringify(rows)]), { in: 0, out: 0, dup: 2 });
  assert.equal(Number((await hold(t, a)).balance), 100000);
  const o = (await t.one(`select id from app.cash_moves where kind='bank_out'`)).id;
  await t.as(U.admin, `select app.explain_bank_out($1,'handover',null,'交给 Frank')`, [o]);
  assert.equal((await t.one(`select kind, status from app.cash_moves where id=$1`, [o])).status, 'confirmed');
  assert.equal(Number((await hold(t, a)).balance), 100000);
});
