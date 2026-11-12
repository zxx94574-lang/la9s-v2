// 0039: 收货差异、档位只中方定、运费
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('收货差异: 报 → 不能对账 → 中方认并冲减 → 欠款减少、库存加回、可以对账', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  const line = await t.one(`select sl.deal_line_id, sl.unit_price, dl.stock_item_id from app.shipment_lines sl join app.deal_lines dl on dl.id = sl.deal_line_id where sl.shipment_id = $1`, [sh]);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg')`, [sh]);
  await rejects(t.as(U.hotline, `select app.report_discrepancy($1,'short',$2,'',null)`, [sh, JSON.stringify([{ deal_line_id: line.deal_line_id, received: 8 }])]), /凭证/);
  await rejects(t.as(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, JSON.stringify([{ deal_line_id: line.deal_line_id, received: 10 }])]), /没有差异/);
  const id = await t.val(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg','少 2 片')`, [sh, JSON.stringify([{ deal_line_id: line.deal_line_id, received: 8 }])]);
  const r = await t.one(`select amount, late, status from app.receipt_discrepancies where id = $1`, [id]);
  assert.equal(Number(r.amount), 2 * Number(line.unit_price)); assert.equal(r.late, false);
  await rejects(t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','x.jpg')`, [d]), /收货差异还没处理/);
  await rejects(t.as(U.manager, `select app.decide_discrepancy($1,'credit','找货少数了','in_warehouse',null)`, [id]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.decide_discrepancy($1,'credit','','in_warehouse',null)`, [id]), /哪个环节/);
  const due0 = Number(await t.due(d)); const st0 = Number(await t.val(U.admin, `select qty_on_hand from app.stock_items where id = $1`, [line.stock_item_id]));
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','找货少数了 2 片','in_warehouse',null)`, [id]);
  assert.equal(Number(await t.due(d)), due0 - 2 * Number(line.unit_price));
  assert.equal(Number(await t.val(U.admin, `select qty_on_hand from app.stock_items where id = $1`, [line.stock_item_id])), st0 + 2);
  await t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','x.jpg')`, [d]);
});

test('档位只有中方能定: 员工建的客户先按最贵档; 员工改档位被拦; 中方确认 / 试用', async () => {
  const t = await setup();
  const c = await t.val(U.hotline, `select app.create_prospect($1,'NOUVEAU SHOP',null,'Abidjan',$2)`, [t.ids.org, JSON.stringify({ shop_type: '批发' })]);
  const row = await t.one(`select tier, tier_confirmed_at from app.customers where id = $1`, [c]);
  assert.equal(row.tier, 'REPAIR'); assert.equal(row.tier_confirmed_at, null);
  await rejects(t.as(U.hotline, `select app.edit_customer_info($1,$2)`, [c, JSON.stringify({ tier: 'S' })]), /只有中方能定|PERMISSION/);
  await rejects(t.as(U.manager, `select app.confirm_customer_tier($1,'S','confirm')`, [c]), /PERMISSION/);
  await t.as(U.admin, `select app.confirm_customer_tier($1,'WHOLESALE','trial',2,'先试两个月')`, [c]);
  const r2 = await t.one(`select tier, tier_review_on, tier_confirmed_at from app.customers where id = $1`, [c]);
  assert.equal(r2.tier, 'WHOLESALE'); assert.ok(r2.tier_review_on); assert.ok(r2.tier_confirmed_at);
});

test('运费: 我们出 → 财务付, 必须截图 → 自动记一笔本地物流费支出', async () => {
  const t = await setup();
  const a = await t.val(U.admin, `select app.upsert_cash_account($1,null,'Cash-XOF','cash','XOF',null,null,null)`, [t.ids.org]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  await rejects(t.as(U.finance, `select app.pay_ship_freight($1,$2,3000,'p.jpg')`, [sh, a]), /客户出/);
  await t.as(U.manager, `select app.set_ship_freight($1,'company',3000)`, [sh]);
  await rejects(t.as(U.finance, `select app.pay_ship_freight($1,$2,3000,'')`, [sh, a]), /支付截图/);
  await t.as(U.finance, `select app.pay_ship_freight($1,$2,2500,'p.jpg')`, [sh, a]);
  const mv = await t.one(`select m.kind, m.category, m.amount from app.cash_moves m join app.shipments s on s.freight_move_id = m.id where s.id = $1`, [sh]);
  assert.equal(mv.kind, 'expense'); assert.equal(mv.category, '本地物流费'); assert.equal(Number(mv.amount), 2500);
  await rejects(t.as(U.finance, `select app.pay_ship_freight($1,$2,2500,'p.jpg')`, [sh, a]), /已经付过/);
});
