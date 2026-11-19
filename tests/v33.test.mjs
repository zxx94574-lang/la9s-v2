// 0063: 手续费不再扣两次 · 公户欠款 = 客户付的 − 手续费 · 账户明确设置 · 改名留记录、运费规则跟着改
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const today = () => new Date().toISOString().slice(0, 10);

test('收款进账户: 客户付 300,000、手续费 3,000 → 账户净 297,000 (不再扣两次); 客户账冲 300,000', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mScreen, qty_req: 50 }]); await t.shipAll(d);
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const acc = (await t.one(`select id, fee_pct, kind from app.cash_accounts where org_id = $1 and name = 'Wave-XOF'`, [t.ids.org]));
  assert.equal(Number(acc.fee_pct), 1); assert.equal(acc.kind, 'wave');
  const bal0 = Number((await t.one(`select balance from app.v_customer_balance where customer_id = $1 and currency = 'XOF'`, [t.ids.camaraAbobo])).balance);
  const rc = await t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: today(), currency: 'XOF', method: 'wave', mode: 'oldest', proof: 'x.jpg', amount_landed: 99000, fee: 1000, fee_bearer: 'company', account_id: acc.id })]);
  const bal1 = Number((await t.one(`select balance from app.v_customer_balance where customer_id = $1 and currency = 'XOF'`, [t.ids.camaraAbobo])).balance);
  assert.equal(bal0 - bal1, 100000, '客户账按客户付的全额冲');
  const pend = await t.val(U.admin, `select coalesce(sum(n),0) from app.cash_pending($1)`, [t.ids.org]);
  assert.equal(Number(pend), 1, '没核对之前卡片上看得见待核对 1 笔');
  await t.as(U.admin, `select app.verify_receipt($1,null)`, [rc]);
  const net = Number((await t.one(`select coalesce(sum(m.amount * app.move_sign(m)),0) as b from app.cash_moves m where m.account_id = $1`, [acc.id])).b);
  assert.equal(net, 99000, '账户净额 = 实际到账 (客户付的 − 手续费)');
  const fee = await t.one(`select amount, category from app.cash_moves where receipt_id = $1 and kind = 'expense'`, [rc]);
  assert.equal(Number(fee.amount), 1000); assert.equal(fee.category, '办公费');
});

test('账户设置: 公户要有持有人; 手续费率; 改名留记录 + 运费规则跟着改; 用量提示', async () => {
  const t = await setup();
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const w = (await t.one(`select id from app.cash_accounts where org_id = $1 and name = 'Wave-XOF'`, [t.ids.org])).id;
  await rejects(t.as(U.manager, `select app.set_cash_account_opts($1,$2)`, [w, JSON.stringify({ fee_pct: 2 })]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.set_cash_account_opts($1,$2)`, [w, JSON.stringify({ is_public: true })]), /在谁手上/);
  await t.as(U.admin, `select app.set_cash_account_opts($1,$2)`, [w, JSON.stringify({ fee_pct: 1.5 })]);
  assert.equal(Number((await t.one(`select fee_pct from app.cash_accounts where id = $1`, [w])).fee_pct), 1.5);
  await t.as(U.admin, `select app.upsert_cash_account($1,$2,'Wave 公司号','wave','XOF',null,null,null)`, [t.ids.org, w]);
  const log = await t.one(`select detail from app.audit_log where action = 'rename_cash_account' and entity_id = $1`, [w]);
  assert.equal(log.detail.from, 'Wave-XOF'); assert.equal(log.detail.to, 'Wave 公司号');
  const fr = await t.one(`select value from app.org_settings where org_id = $1 and key = 'freight_rules'`, [t.ids.org]);
  assert.equal(fr.value.account, 'Wave 公司号', '运费规则默认指着 Wave-XOF, 改名后跟着改');
  const u = await t.val(U.admin, `select app.cash_account_usage($1)`, [w]);
  assert.equal(Number(u.moves), 0);
});
