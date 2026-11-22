// 0076: 熟客直接下单 —— 三道关（价格 / 欠款 / 特批），过了自动下推找货
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const DO = `select app.create_direct_order($1,$2,'XOF',$3,$4) as r`;
test('直接下单: 关都过 → 自动下推找货、预占；没截图 / 没定档 / 没权限都拦', async () => {
  const t = await setup();
  const L = (q = 10) => JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: q }, { product_id: t.ids.x6516, qty_req: 5 }]);
  await assert.rejects(t.as(U.manager, DO, [t.ids.org, t.ids.camaraAbobo, L(), '']), /截图/);
  await assert.rejects(t.as(U.hotline, DO, [t.ids.org, t.ids.camaraAbobo, L(), 'p://1']), /直接下单/);   // 热线默认没权限
  const r = (await t.as(U.manager, DO, [t.ids.org, t.ids.camaraAbobo, L(), 'p://wa1']))[0].r;
  assert.equal(r.state, 'picking');
  assert.equal(await t.status(r.deal), 'picking');
  assert.equal((await t.stockOf(t.ids.stLA_bg6m)).qty_reserved + (await t.stockOf(t.ids.st9S_bg6m)).qty_reserved, 10);
  const ev = (await t.db.query(`select action from app.deal_events where deal_id = $1`, [r.deal])).rows.map((x) => x.action);
  assert.ok(ev.includes('direct_created') && ev.includes('direct_confirmed'));
  // 权限表开给热线以后可以
  await t.db.query(`insert into app.org_settings (org_id, key, value) values ($1,'perm_matrix','{"direct_order":["manager","hotline"]}')`, [t.ids.org]);
  const r2 = (await t.as(U.hotline, DO, [t.ids.org, t.ids.camaraOme, L(2), 'p://wa2']))[0].r;
  assert.equal(r2.state, 'picking');
  // 没定档 → 走报价
  await t.db.query(`update app.customers set tier_confirmed_at = null where id = $1`, [t.ids.bigS]);
  await assert.rejects(t.as(U.manager, DO, [t.ids.org, t.ids.bigS, L(), 'p://wa3']), /报价/);
});

test('直接下单: 要议价 → 停在价格关，中方批完自动下推', async () => {
  const t = await setup();
  const L = JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 10, requested_price: 3000, reason: '客户说别家 3000' }]);
  await assert.rejects(t.as(U.manager, DO, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 10, requested_price: 3000 }]), 'p://x']), /理由/);
  const r = (await t.as(U.manager, DO, [t.ids.org, t.ids.camaraAbobo, L, 'p://wa']))[0].r;
  assert.equal(r.state, 'price');
  assert.equal(await t.status(r.deal), 'quoted');
  await t.as(U.admin, `select app.approve_quote($1,true,'给 3100',$2)`, [r.deal, JSON.stringify([])]);
  assert.equal(await t.status(r.deal), 'picking');
});

test('直接下单: 超欠款上限 → 停在欠款关，进财务待办；收款后自动下推', async () => {
  const t = await setup();
  await t.as(U.admin, `select app.set_customer_terms($1,100000,30,false,null)`, [t.ids.camaraAbobo]);
  const d0 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 300 }]);
  await t.shipAll(d0);                                   // 欠 165,000 > 上限 100,000
  const r = (await t.as(U.manager, DO, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.x6516, qty_req: 5 }]), 'p://wa']))[0].r;
  assert.equal(r.state, 'credit');
  const held = await t.as(U.finance, `select * from app.v_direct_held where deal_id = $1`, [r.deal]);
  assert.equal(held.length, 1);
  await t.as(U.finance, `select app.record_receipt($1,$2,current_date,165000,'XOF','cash')`, [t.ids.org, t.ids.camaraAbobo]);
  assert.equal(await t.status(r.deal), 'picking');
});
