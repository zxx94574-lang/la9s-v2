// 0036 (Frank 11-11 16:34): 签收 · 对账 → 客户确认对账 (方式 + 截图); 之后又签收了新一批要重新对
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const pending = (t, d) => t.val(U.admin, `select app.balance_pending($1)`, [d]);

test('签收完才能对账; 方式 + 截图必填; 对完 pending = false; 新签收一批又要对', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 and voided_at is null limit 1`, [d]);
  assert.equal(await pending(t, d), false, '没签收不算待对账');
  await rejects(t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','x.jpg')`, [d]), /没签收/);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg')`, [sh]);
  assert.equal(await pending(t, d), true);
  await rejects(t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','')`, [d]), /截图/);
  await rejects(t.as(U.hotline, `select app.confirm_balance($1,'','x.jpg')`, [d]), /确认方式/);
  await rejects(t.as(U.picker, `select app.confirm_balance($1,'whatsapp','x.jpg')`, [d]), /FORBIDDEN|PERMISSION|权限/);
  await t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','x.jpg','ok')`, [d]);
  assert.equal(await pending(t, d), false);
  const ev = await t.val(U.admin, `select count(*) from app.deal_events where deal_id = $1 and action = 'balance_confirmed'`, [d]);
  assert.equal(Number(ev), 1);
  await t.db.query(`update app.shipments set customer_received_at = now() + interval '1 minute' where id = $1`, [sh]);
  assert.equal(await pending(t, d), true, '对账之后又签收 → 要重新对');
});

test('0037 凭证一律必传: 现金收款 / 员工交款 / 坏账核销 / 对账', async () => {
  const t = await setup();
  const a = await t.val(U.admin, `select app.upsert_cash_account($1,null,'Cash-XOF','cash','XOF',null,null,null)`, [t.ids.org]);
  const rc = (p) => t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: new Date().toISOString().slice(0, 10), currency: 'XOF', method: 'cash', mode: 'oldest', amount_landed: 5000, ...p })]);
  await rejects(rc({}), /现金收款也要传凭证/);
  await rejects(rc({ method: 'wave' }), /付款截图/);
  const id = await rc({ proof: 'group.jpg', collector_employee_id: t.ids.sales });
  await rejects(t.as(U.admin, `select app.receipt_handed($1,$2,null)`, [id, a]), /交款要传凭证/);
  await t.as(U.admin, `select app.receipt_handed($1,$2,'cash.jpg')`, [id, a]);
  await rejects(t.as(U.finance, `select app.record_cash_check($1,'recon',current_date,5000,null,null)`, [a]), /余额图/);
  await t.as(U.finance, `select app.record_cash_check($1,'recon',current_date,5000,null,'app.jpg')`, [a]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  await rejects(t.as(U.admin, `select app.write_off_bad_debt($1,100,'跑了',null)`, [d]), /坏账核销要传凭证/);
});
