// 0043: 收货差异修正 (同一机型再报 = 在上次基础上改, 账只动差额)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('收货差异: 再报是修正不是另起 —— 补扣只扣差的, 找到了能冲回, 历史都留着', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 11 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  await t.as(U.manager, `select app.sign_receipt($1,'s.jpg',now())`, [sh]);
  const line = await t.one(`select deal_line_id, unit_price, qty from app.shipment_lines where shipment_id = $1`, [sh]);
  const px = Number(line.unit_price); const L = (n) => JSON.stringify([{ deal_line_id: line.deal_line_id, received: n }]);
  const bal = async () => Number(await t.val(U.admin, `select coalesce(sum(amount),0) from app.ar_entries where deal_id = $1 and kind = 'writeoff'`, [d]));
  // 第一次: 收到 10
  const a = await t.val(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, L(10)]);
  await rejects(t.as(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, L(9)]), /还有一张差异没处理/);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','复检没查出来','lost',null)`, [a]);
  assert.equal(await bal(), -px);
  assert.equal(Number(await t.val(U.admin, `select app.disc_received($1,$2)`, [sh, line.deal_line_id])), 10);
  // 再报同样的数 → 没有差异; 员工不能修正; 中方修正要写原因
  await rejects(t.as(U.admin, `select app.report_discrepancy($1,'short',$2,'p.jpg','x')`, [sh, L(10)]), /没有差异/);
  await rejects(t.as(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg','其实只收到 9')`, [sh, L(9)]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, L(9)]), /要写原因/);
  // 修正: 其实只收到 9 → 只补扣 1 片 (不是再扣 2 片)
  const b = await t.val(U.admin, `select app.report_discrepancy($1,'short',$2,'p.jpg','客户重新数了，只有 9 片')`, [sh, L(9)]);
  const rb = await t.one(`select amount, corrects from app.receipt_discrepancies where id = $1`, [b]);
  assert.equal(Number(rb.amount), px); assert.equal(rb.corrects, a);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','复检没查出来','lost',null)`, [b]);
  assert.equal(await bal(), -2 * px);
  // 客户后来全找到了 → 改回 11, 之前扣的全部冲回
  const c = await t.val(U.admin, `select app.report_discrepancy($1,'short',$2,'p.jpg','客户在另一个箱子里找到了')`, [sh, L(11)]);
  assert.equal(Number((await t.one(`select amount from app.receipt_discrepancies where id = $1`, [c])).amount), -2 * px);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','客户自己的问题','with_customer',null)`, [c]);
  assert.equal(await bal(), 0);
  assert.equal(Number(await t.val(U.admin, `select count(*) from app.receipt_discrepancies where deal_id = $1`, [d])), 3);   // 历史全留
  assert.equal(Number(await t.val(U.admin, `select coalesce(sum(amount),0) from app.receipt_discrepancies where deal_id = $1 and decision = 'credit'`, [d])), 0);
});

test('收货差异修正: 少发的货加回仓库后, 发现客户其实收到了 → 库存再减回去', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  await t.as(U.manager, `select app.sign_receipt($1,'s.jpg',now())`, [sh]);
  const line = await t.one(`select sl.deal_line_id, dl.stock_item_id from app.shipment_lines sl join app.deal_lines dl on dl.id = sl.deal_line_id where sl.shipment_id = $1`, [sh]);
  const stock = async () => Number(await t.val(U.admin, `select qty_on_hand from app.stock_items where id = $1`, [line.stock_item_id]));
  const s0 = await stock(); const L = (n) => JSON.stringify([{ deal_line_id: line.deal_line_id, received: n }]);
  const a = await t.val(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, L(3)]);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','复检没查出来','in_warehouse',null)`, [a]);
  assert.equal(await stock(), s0 + 2);
  const b = await t.val(U.admin, `select app.report_discrepancy($1,'short',$2,'p.jpg','客户找到了')`, [sh, L(5)]);
  await rejects(t.as(U.admin, `select app.decide_discrepancy($1,'reship','x','with_customer',null)`, [b]), /修正只能/);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','客户自己的问题','with_customer',null)`, [b]);
  assert.equal(await stock(), s0);
});
