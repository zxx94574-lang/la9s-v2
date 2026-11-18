// 0054 (Q8③): 先出库、价格以后再定 —— 只中方批; 没定价不能对账; 定价差额进客户账; 账对得上
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('价格待定: 只中方批、要原因; 出库后不能对账; 定价要截图; 差额进账; 之后能对账', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await rejects(t.as(U.manager, `select app.allow_ship_unpriced($1,'客户急要')`, [d]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.allow_ship_unpriced($1,' ')`, [d]), /VALIDATION/);
  await t.as(U.admin, `select app.allow_ship_unpriced($1,'客户今天开业急要，价格明天谈')`, [d]);
  await t.shipAll(d);
  const due0 = await t.due(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1`, [d]);
  await t.as(U.hotline, `select app.sign_receipt($1,'photo://sign.jpg',now(),'M. Camara','0700000001','boss')`, [sh]);
  await rejects(t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','proof://b.jpg',null)`, [d]), /价格还没定/);
  await rejects(t.as(U.admin, `select app.cancel_price_pending($1)`, [d]), /BAD_STATE/);
  const ln = (await t.lines(d))[0];
  await rejects(t.as(U.manager, `select app.settle_pending_price($1,$2,'谈好了','p.jpg')`, [d, JSON.stringify([{ line_id: ln.id, price: 500 }])]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.settle_pending_price($1,$2,'谈好了','')`, [d, JSON.stringify([{ line_id: ln.id, price: 500 }])]), /VALIDATION/);
  const delta = await t.val(U.admin, `select app.settle_pending_price($1,$2,'谈好了每片 500','p.jpg')`, [d, JSON.stringify([{ line_id: ln.id, price: 500 }])]);
  assert.equal(Number(delta), 10 * (500 - Number(ln.unit_price)));
  assert.equal(await t.due(d), due0 + Number(delta)); assert.equal(await t.due(d), 5000);
  assert.equal(await t.balance(t.ids.camaraAbobo), 5000);
  assert.equal((await t.as(U.admin, `select * from app.ledger_check($1)`, [t.ids.org])).length, 0);
  await t.as(U.hotline, `select app.confirm_balance($1,'whatsapp','proof://b.jpg',null)`, [d]);
  await rejects(t.as(U.admin, `select app.settle_pending_price($1,'[]','再来','p.jpg')`, [d]), /不是「价格待定」/);
});

test('价格待定的单: 单价是 0 也能出库 (会亏检查等到定价那一刻); 定的价低于成本没批 → 拦', async () => {
  const t = await setup();
  await t.db.query(`insert into app.price_settings (org_id, rmb_per_xof, round_to) values ($1, 0.01, 100) on conflict (org_id) do update set rmb_per_xof = 0.01, round_to = 100`, [t.ids.org]);
  await t.db.query(`update app.products set rmb_cost = 2, freight_xof = 50 where id = $1`, [t.ids.bg6mCover]);   // 成本 300
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 4 }]);
  await t.as(U.admin, `select app.allow_ship_unpriced($1,'急单')`, [d]);
  await t.db.query(`update app.deal_lines set unit_price = 0 where deal_id = $1`, [d]);
  await t.shipAll(d);
  assert.equal(await t.due(d), 0);
  const ln = (await t.lines(d))[0];
  await rejects(t.as(U.admin, `select app.settle_pending_price($1,$2,'谈崩了只给 200','p.jpg')`, [d, JSON.stringify([{ line_id: ln.id, price: 200 }])]), /LOSS_BLOCK/);
  assert.equal((await t.one(`select price_pending from app.deals where id = $1`, [d])).price_pending, true);
  await t.as(U.admin, `select app.settle_pending_price($1,$2,'谈好 450','p.jpg')`, [d, JSON.stringify([{ line_id: ln.id, price: 450 }])]);
  assert.equal(await t.due(d), 1800);
});
