// 0059: 销售提成进工资 (17 / 片) · 特价表有名字、自动成为单价 · 出库拦截 (欠款上限 / 账期 / 超过客户确认的数量) · 大变动通知补齐
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const today = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const NOW = () => new Date().toISOString();

test('销售提成: 默认每片 17, 自动进工资单和实发, 手改不被重算覆盖', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d, null, NOW());
  await t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: today, currency: 'XOF', method: 'cash', mode: 'oldest', proof: 'x.jpg', amount_landed: await t.due(d) })]);
  const r0 = await t.as(U.admin, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today]);
  assert.equal(Number(r0[0].per_piece), 17); assert.equal(Number(r0[0].amount), 170);
  await t.as(U.admin, `select app.payroll_open($1,current_date)`, [t.ids.org]);
  await t.as(U.admin, `select app.payroll_sales_comm($1,current_date)`, [t.ids.org]);
  const p = async () => t.one(`select sales_comm, sales_comm_auto, wh_comm, net, base, allowance, incentive, prime_team, deduction from app.payroll where employee_id = $1`, [t.ids.sales]);
  let r = await p(); assert.equal(Number(r.sales_comm), 170); assert.equal(Number(r.sales_comm_auto), 170);
  assert.equal(Number(r.net), Number(r.base) + Number(r.allowance) + Number(r.incentive) + Number(r.prime_team) + Number(r.wh_comm) + 170 - Number(r.deduction));
  await t.as(U.admin, `select app.payroll_set_sales_comm($1,current_date,$2,100)`, [t.ids.org, t.ids.sales]);
  await t.as(U.admin, `select app.payroll_sales_comm($1,current_date)`, [t.ids.org]);
  r = await p(); assert.equal(Number(r.sales_comm), 100, '手改的不被覆盖'); assert.equal(Number(r.sales_comm_auto), 170);
  await rejects(t.as(U.manager, `select app.payroll_sales_comm($1,current_date)`, [t.ids.org]), /PERMISSION/);
});

test('特价: 有名字, 生效期间自动成为这个客户的单价; 只对适用的档位; 到期 / 结束后恢复', async () => {
  const t = await setup();
  const tier = Number((await t.one(`select app.tier_price($1,$2,'XOF') p`, [t.ids.bg6mCover, t.ids.camaraAbobo])).p);
  assert.ok(tier > 100);
  const promo = tier - 100;
  const id = await t.val(U.admin, `select app.set_promo($1,$2,$3,$4,$5,array['WHOLESALE'],null,'十一月促销','促销价')`, [t.ids.org, t.ids.bg6mCover, promo, day(0), day(7)]);
  assert.equal((await t.one(`select label from app.clearance_prices where id = $1`, [id])).label, '促销价');
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5 }])]);
  assert.equal(Number((await t.lines(d))[0].unit_price), promo, '报价自动带出促销价');
  assert.equal((await t.lines(d))[0].odd, false, '按促销价不算异价');
  const pr = await t.as(U.manager, `select * from app.customer_promos($1)`, [t.ids.camaraAbobo]);
  assert.equal(pr.length, 1); assert.equal(pr[0].label, '促销价'); assert.equal(Number(pr[0].price), promo);
  // 别的档位不适用
  const d2 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5 }])]);
  assert.notEqual(Number((await t.lines(d2))[0].unit_price), promo);
  assert.equal((await t.as(U.manager, `select * from app.customer_promos($1)`, [t.ids.bigS])).length, 0);
  // 特价比档位价还贵 → 仍用档位价
  await t.val(U.admin, `select app.set_promo($1,$2,$3,$4,$5,null,null,'写错的','清仓价')`, [t.ids.org, t.ids.x6516, 99999999, day(0), day(7)]);
  const tp = Number((await t.one(`select app.tier_price($1,$2,'XOF') p`, [t.ids.x6516, t.ids.camaraAbobo])).p);
  assert.ok(tp < 99999999);
  await t.as(U.admin, `select app.end_clearance($1)`, [id]);
  assert.equal(Number((await t.one(`select app.tier_price($1,$2,'XOF') p`, [t.ids.bg6mCover, t.ids.camaraAbobo])).p), tier);
});

test('出库拦截: 超欠款上限要中方放行; 关掉开关不拦', async () => {
  const t = await setup();
  await t.db.query(`delete from app.org_settings where key = 'credit_gate'`);
  // 报价时还没超 (审批不触发), 到出库那一刻才超 —— 以前这种情况没人拦
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const d2 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.db.query(`update app.customers set credit_limit = 1000 where id = $1`, [t.ids.camaraAbobo]);
  const g = await t.val(U.manager, `select app.ship_gate_state($1)`, [d]);
  assert.equal(g.credit.over_limit, true);
  await rejects(t.shipAll(d, null, NOW()), /CREDIT_BLOCK/);
  await rejects(t.as(U.manager, `select app.release_ship_gate($1,'credit','答应今天付')`, [d]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.release_ship_gate($1,'credit',' ')`, [d]), /VALIDATION/);
  await t.as(U.admin, `select app.release_ship_gate($1,'credit','答应今天付')`, [d]);
  assert.equal((await t.val(U.manager, `select app.ship_gate_state($1)`, [d])).credit, null);
  await t.shipAll(d, null, NOW());
  assert.equal((await t.one(`select count(*)::int n from app.change_notices where deal_id = $1 and kind = 'gate_released'`, [d])).n, 1);
  // 开关
  await rejects(t.shipAll(d2, null, NOW()), /CREDIT_BLOCK/);
  await t.as(U.admin, `select app.set_org_setting($1,'credit_gate','{"on":false}')`, [t.ids.org]);
  await t.shipAll(d2, null, NOW());
});

test('出库拦截: 超账期', async () => {
  const t = await setup();
  await t.db.query(`delete from app.org_settings where key = 'credit_gate'`);
  const d0 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d0);   // 很久以前出的, 没付
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.db.query(`update app.customers set credit_days = 3 where id = $1`, [t.ids.camaraAbobo]);
  await rejects(t.shipAll(d, null, NOW()), /CREDIT_BLOCK.*账期/);
  await t.as(U.admin, `select app.release_ship_gate($1,'credit','老客户，月底结')`, [d]);
  await t.shipAll(d, null, NOW());
});

test('出库拦截: 出库数量超过客户确认的数量 → 中方放行才行', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const l = (await t.lines(d))[0];
  assert.equal(l.qty_confirmed, 10);
  // 模拟确认后数量被加大 (正常入口会要求重新确认; 这里直接改, 验证硬拦)
  await t.db.query(`update app.stock_items set qty_reserved = qty_reserved + 5 where id = $1`, [l.stock_item_id]);
  await t.db.query(`update app.deal_lines set qty_supply = 15 where id = $1`, [l.id]);
  const g = await t.val(U.manager, `select app.ship_gate_state($1)`, [d]);
  assert.equal(g.qty.length, 1); assert.equal(g.qty[0].confirmed, 10); assert.equal(g.qty[0].now, 15);
  await rejects(t.shipAll(d, null, NOW()), /QTY_BLOCK/);
  await t.shipAll(d, [{ line_id: l.id, qty: 10 }], NOW());                       // 只发确认过的 10 片可以
  await rejects(t.shipAll(d, null, NOW()), /QTY_BLOCK/);
  await t.as(U.admin, `select app.release_ship_gate($1,'qty','客户电话里加了 5 片')`, [d]);
  await t.shipAll(d, null, NOW());
});

test('大变动通知: 改已定档客户的档位', async () => {
  const t = await setup();
  await t.as(U.admin, `select app.confirm_customer_tier($1,'RETAIL','confirm')`, [t.ids.camaraAbobo]);
  const n = await t.one(`select kind, detail from app.change_notices where kind = 'tier_changed'`);
  assert.equal(n.detail.from, 'WHOLESALE'); assert.equal(n.detail.to, 'RETAIL');
});
