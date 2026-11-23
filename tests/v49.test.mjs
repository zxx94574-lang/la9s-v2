// 0082: 国内三个账号 —— 商务回复申请单 / 财务记采购单付款 (运费进批次成本) / 按采购单对账
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const CNB = '00000000-0000-0000-0000-0000000000ca', CNF = '00000000-0000-0000-0000-0000000000cb', CNP = '00000000-0000-0000-0000-0000000000c9';

test('国内商务 / 财务 / 采购各管各的', async () => {
  const t = await setup();
  for (const [u, r] of [[CNB, '{cn_business}'], [CNF, '{cn_finance}'], [CNP, '{cn_support}']]) await t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,$3)`, [u, t.ids.org, r]);
  // 481 申请单: 商务回复, 每行都回了 → 已回复 + 通知
  const req = await t.val(U.manager, `select app.save_purchase_request($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ kind: 'stock', title: '12 月备货' }), JSON.stringify([{ product_id: t.ids.x6516, item: 'X6516', qty: 500 }])]);
  const [ln] = await t.as(U.admin, `select id from app.purchase_request_lines where request_id = $1`, [req]);
  await assert.rejects(t.as(CNF, `select app.cn_offer($1,'{"qty":400}')`, [ln.id]), /PERMISSION/);
  await assert.rejects(t.as(CNP, `select app.cn_offer($1,'{"qty":400}')`, [ln.id]), /PERMISSION/);
  await t.as(CNB, `select app.cn_offer($1,$2)`, [ln.id, JSON.stringify({ qty: 400, price: 12.5 })]);
  assert.equal((await t.one(`select offered_at from app.purchase_requests where id = $1`, [req])).offered_at, null);
  await t.as(CNB, `select app.cn_offer($1,$2)`, [ln.id, JSON.stringify({ ship: '2026-12-10', owner: 'la' })]);
  assert.ok((await t.one(`select offered_at from app.purchase_requests where id = $1`, [req])).offered_at);
  assert.equal((await t.db.query(`select 1 from app.change_notices where kind = 'cn_offer'`)).rows.length, 1);
  // 483 采购单付款: 只有国内财务; 运费按件进批次
  const po = await t.val(CNP, `select app.save_po($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ po_no: 'PO-CN-1', purpose: 'local', inbound_no: 'CG1' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 400, unit_price: 12.5 }])]);
  await assert.rejects(t.as(CNP, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: 5000, proof: 'p.jpg' })]), /PERMISSION/);
  await assert.rejects(t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: 5000 })]), /凭证/);
  await t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: 5000, currency: 'CNY', xof_per_unit: 85, proof: 'p.jpg' })]);
  await assert.rejects(t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'freight', amount: 1000, currency: 'CNY', proof: 'f.jpg' })]), /汇率/);
  await t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'freight', amount: 1000, currency: 'CNY', xof_per_unit: 85, proof: 'f.jpg' })]);
  const b = await t.one(`select freight_total, freight_pieces, unit_price from app.product_batches where po_no = 'PO-CN-1'`);
  assert.equal(Number(b.freight_total), 85000); assert.equal(b.freight_pieces, 400); assert.equal(Number(b.unit_price), 12.5);
  // 484 对账
  const lg = await t.one(`select goods_cny, paid_cny, freight_xof from app.v_po_ledger where id = $1`, [po]);
  assert.equal(Number(lg.goods_cny), 5000); assert.equal(Number(lg.paid_cny), 5000); assert.equal(Number(lg.freight_xof), 85000);
});
