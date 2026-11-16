// 0049 (Frank 11-16 待改 328): 订单毛利 —— 出库锁成本、事后变动全算进来、按行分摊、只中方看
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

async function withCost(t) {
  await t.db.query(`insert into app.price_settings (org_id, rmb_per_xof, round_to) values ($1, 0.01, 100) on conflict (org_id) do update set rmb_per_xof = 0.01, round_to = 100`, [t.ids.org]);
  // 电池盖 2 元 → 200 XOF + 运费 50 → 250 → 进到 300; 屏幕 20 元 → 2000 + 100 → 2100 → 进到 2100
  await t.db.query(`update app.products set rmb_cost = 2, freight_xof = 50 where id = $1`, [t.ids.bg6mCover]);
  await t.db.query(`update app.products set rmb_cost = 20, freight_xof = 100 where id = $1`, [t.ids.bg6mScreen]);
}

test('出库那一刻锁定成本和档位; 之后改成本不影响旧单; 利润 = 销售额 − 成本', async () => {
  const t = await setup(); await withCost(t);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sl = await t.one(`select x.unit_cost, x.cost_src, x.tier from app.shipment_lines x join app.shipments s on s.id = x.shipment_id where s.deal_id = $1`, [d]);
  assert.equal(Number(sl.unit_cost), 300); assert.equal(sl.cost_src, 'ship'); assert.equal(sl.tier, 'WHOLESALE');
  await t.db.query(`update app.products set rmb_cost = 9 where id = $1`, [t.ids.bg6mCover]);
  const r = await t.as(U.admin, `select * from app.margin_rows($1, $2)`, [t.ids.org, d]);
  assert.equal(r.length, 1);
  assert.equal(Number(r[0].revenue), 5500); assert.equal(Number(r[0].cost), 3000); assert.equal(Number(r[0].profit), 2500);
  assert.equal(r[0].tier, 'WHOLESALE'); assert.equal(r[0].category, '电池盖'); assert.equal(r[0].cost_missing, false);
});

test('员工拿不到毛利 (销售 / 主管 / 财务都不行)', async () => {
  const t = await setup();
  for (const u of [U.manager, U.finance, U.hotline, U.picker]) await rejects(t.as(u, `select * from app.margin_rows($1)`, [t.ids.org]), /PERMISSION/);
  await rejects(t.as(U.manager, `select * from app.stock_margin($1)`, [t.ids.org]), /PERMISSION/);
});

test('事后变动: 退货、价格调整、我们出的运费、我们承担的手续费全扣; 整单级的按销售额分摊到行, 加起来等于整单', async () => {
  const t = await setup(); await withCost(t);
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }, { product_id: t.ids.bg6mScreen, qty_req: 2 }]);
  await t.shipAll(d);
  // 销售额 5,500 + 6,600 = 12,100; 成本 3,000 + 4,200 = 7,200
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1`, [d]);
  await t.as(U.manager, `select app.record_ship_freight($1,'company',1210,'p.jpg')`, [sh]);
  await t.as(U.admin, `select app.adjust_price($1,-1210,'整单让一点','ok.jpg')`, [d]);
  const ln = await t.lines(d);
  const rt = await t.val(U.hotline, `select app.request_return($1,'quality','坏',$2)`, [d, JSON.stringify([{ line_id: ln[0].id, qty: 2 }])]);
  await t.as(U.admin, `select app.decide_return($1,true)`, [rt]);
  const wave = await t.val(U.admin, `select id from app.cash_accounts where org_id = $1 and name = 'Wave-XOF'`, [t.ids.org]);
  await t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: new Date().toISOString().slice(0, 10), currency: 'XOF', method: 'wave', mode: 'oldest', proof: 'x.jpg', amount_landed: 9680 - 100, fee: 100, fee_bearer: 'company', account_id: wave })]);
  const r = await t.as(U.admin, `select * from app.margin_rows($1, $2)`, [t.ids.org, d]);
  assert.equal(r.length, 2);
  // 收入 = 12,100 − 退货 1,100 − 调整 1,210 = 9,790; 成本 = (8×300 + 2×2,100) + 运费 1,210 + 手续费 100 = 7,910
  assert.equal(Math.round(sum(r, 'revenue')), 9790);
  assert.equal(Math.round(sum(r, 'cost')), 7910);
  assert.equal(Math.round(sum(r, 'profit')), 1880);
  assert.equal(Math.round(sum(r, 'freight')), 1210); assert.equal(Math.round(sum(r, 'fee')), 100); assert.equal(Math.round(sum(r, 'returned')), 1100);
  const cover = r.find((x) => x.category === '电池盖');
  assert.equal(Number(cover.qty), 8);
  assert.equal(Math.round(Number(cover.freight)), Math.round(1210 * 5500 / 12100));
});

test('没有成本的型号标「成本缺失」, 不算利润; 库存毛利给出四档价和成本', async () => {
  const t = await setup(); await withCost(t);
  const d = await t.toConfirmed(t.ids.bigS, [{ product_id: t.ids.x6516, qty_req: 5 }]); await t.shipAll(d);
  const r = await t.as(U.admin, `select * from app.margin_rows($1, $2)`, [t.ids.org, d]);
  assert.equal(r[0].cost_missing, true); assert.equal(r[0].profit, null); assert.equal(r[0].cost_src, 'missing');
  const s = await t.as(U.admin, `select * from app.stock_margin($1)`, [t.ids.org]);
  const cover = s.find((x) => x.product_code === '1002');
  assert.equal(Number(cover.unit_cost), 300); assert.equal(Number(cover.price_w), 550); assert.equal(Number(cover.price_s), 500);
  assert.ok(!s.some((x) => ['pending', 'scrap'].includes(x.wh_kind)));
  const fob = s.find((x) => x.warehouse === 'FOB'); assert.equal(fob.unit_cost, null);
});

test('还没出库的单: 按现在的成本预估', async () => {
  const t = await setup(); await withCost(t);
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 4 }])]);
  const r = await t.as(U.admin, `select * from app.deal_margin_estimate($1)`, [d]);
  assert.equal(Number(r[0].sale), 2200); assert.equal(Number(r[0].cost), 1200); assert.equal(Number(r[0].profit), 1000);
  await rejects(t.as(U.manager, `select * from app.deal_margin_estimate($1)`, [d]), /PERMISSION/);
});
