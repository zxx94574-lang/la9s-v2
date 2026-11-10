// Acceptance scenarios from Frank's requirements (docs/需求原话记录.md) and HANDOFF §11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('只问价不买：报价不预占、不记应收；无权限角色不能报价', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`,
    [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 10 }])]);
  assert.deepEqual(await t.stockOf(t.ids.stLA_bg6m), { qty_on_hand: 60, qty_reserved: 0 });
  assert.equal(await t.balance(t.ids.camaraAbobo), 0);
  const [l] = await t.lines(deal);
  assert.equal(Number(l.unit_price), 3300, 'WHOLESALE 档自动带价');
  await rejects(t.as(U.picker, `select app.create_quote($1,$2,'XOF',$3)`,
    [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 1 }])]), /PERMISSION_DENIED/);
  await rejects(t.as(U.outsider, `select app.hotline_confirm($1)`, [deal]), /PERMISSION_DENIED/);
});

test('数量必须 > 0（默认 0 不能下推）', async () => {
  const t = await setup();
  await rejects(t.as(U.manager, `select app.create_quote($1,$2,'XOF',$3)`,
    [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 0 }])]), /quantity must be > 0/);
});

test('要100给60：只预占本行仓位的60，不从9S自动补；缺口40进未满足需求', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`,
    [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 100, stock_item_id: t.ids.stLA_bg6m }])]);
  const short = await t.val(U.manager, `select app.start_picking($1)`, [deal]);
  assert.equal(short[0].qty, 40);
  assert.deepEqual(await t.stockOf(t.ids.stLA_bg6m), { qty_on_hand: 60, qty_reserved: 60 });
  assert.deepEqual(await t.stockOf(t.ids.st9S_bg6m), { qty_on_hand: 50, qty_reserved: 0 }, '9S 不被自动拿来补货');
  const unmet = await t.one(`select kind, qty_unmet from app.v_unmet_demand where deal_id=$1`, [deal]);
  assert.deepEqual(unmet, { kind: 'short', qty_unmet: 40 });
});

test('同编码两个仓：手动加第二行指定9S，分行预占', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([
    { product_id: t.ids.bg6mScreen, qty_req: 60, stock_item_id: t.ids.stLA_bg6m },
    { product_id: t.ids.bg6mScreen, qty_req: 40, stock_item_id: t.ids.st9S_bg6m }])]);
  await t.as(U.manager, `select app.start_picking($1)`, [deal]);
  assert.equal((await t.stockOf(t.ids.stLA_bg6m)).qty_reserved, 60);
  assert.equal((await t.stockOf(t.ids.st9S_bg6m)).qty_reserved, 40);
});

test('未建档机型：先种类后型号，自动大写，询单阶段即进入未满足需求；不能供货', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([
    { req_category_id: t.ids.catScreen, req_model: 'spark 20 pro', qty_req: 30 }])]);
  const [l] = await t.lines(deal);
  assert.equal(l.req_model, 'SPARK 20 PRO');
  assert.equal(Number(l.unit_price), 0);
  const u = await t.one(`select kind, qty_unmet, model from app.v_unmet_demand where deal_id=$1`, [deal]);
  assert.deepEqual(u, { kind: 'no_code', qty_unmet: 30, model: 'SPARK 20 PRO' });
  await rejects(t.as(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo,
    JSON.stringify([{ req_model: 'X', qty_req: 1 }])]), /needs product or \(category \+ model\)/);
});

test('同型号不同种类：BG6M 屏幕与电池盖是两个物料、两个价格', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([
    { product_id: t.ids.bg6mScreen, qty_req: 1 }, { product_id: t.ids.bg6mCover, qty_req: 1 }])]);
  const ls = await t.lines(deal);
  assert.deepEqual(ls.map((l) => Number(l.unit_price)), [3000, 500]);
});

test('FOB 仓不能用于本地单', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo,
    JSON.stringify([{ product_id: t.ids.x6516, qty_req: 5, stock_item_id: t.ids.stFOB_x6516 }])]);
  await rejects(t.as(U.manager, `select app.start_picking($1)`, [deal]), /WAREHOUSE_SCOPE/);
});

test('找货：找货人和照片必填；少于预占必须写原因并释放预占；不能多于预占', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo,
    JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 100 }])]);
  await t.as(U.manager, `select app.start_picking($1)`, [deal]);
  const [l] = await t.lines(deal);
  await rejects(t.as(U.picker, `select app.submit_pick($1,$2,'', '[]')`, [deal, t.ids.picker]), /找货照片必传/);
  await rejects(t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg',$3)`, [deal, t.ids.picker, JSON.stringify([{ line_id: l.id, qty: 90 }])]), /必须填原因/);
  await rejects(t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg',$3)`, [deal, t.ids.picker, JSON.stringify([{ line_id: l.id, qty: 101, reason: 'x' }])]), /不能超过预占/);
  await t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg',$3)`, [deal, t.ids.picker, JSON.stringify([{ line_id: l.id, qty: 90, reason: '货架只剩90' }])]);
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 90);
  assert.equal(await t.status(deal), 'picked');
});

test('改价只有中方；批量取价不覆盖手改价；手改价下推需二次确认', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([
    { product_id: t.ids.bg6mScreen, qty_req: 10 }, { product_id: t.ids.bg6mCover, qty_req: 10 }])]);
  const [a, b] = await t.lines(deal);
  await rejects(t.as(U.manager, `select app.set_line_price($1, 3000, '老客户')`, [a.id]), /PERMISSION_DENIED/);
  await rejects(t.as(U.admin, `select app.set_line_price($1, 3000, '')`, [a.id]), /needs reason/);
  await t.as(U.admin, `select app.set_line_price($1, 3000, '老客户特价')`, [a.id]);
  await t.db.query(`update app.product_prices set price = 9999 where tier='WHOLESALE'`);
  const n = await t.val(U.manager, `select app.refresh_prices($1,$2)`, [deal, [a.id, b.id]]);
  assert.equal(n, 1, '只刷新未手改的行');
  const ls = await t.lines(deal);
  assert.deepEqual(ls.map((l) => Number(l.unit_price)), [3000, 9999]);
  await t.as(U.manager, `select app.start_picking($1)`, [deal]);
  await t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg','[]')`, [deal, t.ids.picker]);
  await rejects(t.as(U.manager, `select app.create_sales_order($1,false)`, [deal]), /CONFIRM_REQUIRED/);
  const so = await t.val(U.manager, `select app.create_sales_order($1,true)`, [deal]);
  assert.match(so, /^SO-CI-\d{4}-0001$/);
});

test('不能跳步：报价不能直接出库', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo,
    JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 1 }])]);
  await rejects(t.shipAll(deal), /BAD_STATE/);
});

test('分批出库 20 + 40：库存、预占、应收各只记一次；发货信息必填；金蝶待签收', async () => {
  const t = await setup();
  const deal = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mScreen, qty_req: 60 }]);
  const [l] = await t.lines(deal);
  await rejects(t.as(U.manager, `select app.ship($1, now(), 'yango_moto', '', 'addr', 'p', null)`, [deal]), /必填/);
  const s1 = await t.shipAll(deal, [{ line_id: l.id, qty: 20 }]);
  assert.equal(await t.status(deal), 'partial');
  assert.deepEqual(await t.stockOf(t.ids.stLA_bg6m), { qty_on_hand: 40, qty_reserved: 40 });
  assert.equal(await t.balance(t.ids.camaraAbobo), 20 * 3300);
  await t.shipAll(deal);
  assert.equal(await t.status(deal), 'shipped');
  assert.deepEqual(await t.stockOf(t.ids.stLA_bg6m), { qty_on_hand: 0, qty_reserved: 0 });
  assert.equal(await t.balance(t.ids.camaraAbobo), 60 * 3300);
  const ob = await t.one(`select status from app.kingdee_outbox where shipment_id=$1`, [s1]);
  assert.equal(ob.status, 'await_receipt');
  await t.as(U.hotline, `select app.mark_received($1)`, [s1]);
  assert.equal((await t.one(`select status from app.kingdee_outbox where shipment_id=$1`, [s1])).status, 'ready');
});

test('冲账默认最旧：11号200万 + 13号100万，付250万 → 先清11号，13号冲50万', async () => {
  const t = await setup();
  await t.db.query(`update app.product_prices set price = 10000 where product_id=$1`, [t.ids.x6516]);
  await t.db.query(`update app.stock_items set qty_on_hand = 300 where id=$1`, [t.ids.st9S_x6516]);
  const d1 = await t.toConfirmed(t.ids.bigS, [{ product_id: t.ids.x6516, qty_req: 200 }]);
  await t.shipAll(d1, null, '2026-10-11T09:00:00Z');
  const d2 = await t.toConfirmed(t.ids.bigS, [{ product_id: t.ids.x6516, qty_req: 100 }]);
  await t.shipAll(d2, null, '2026-10-13T09:00:00Z');
  assert.equal(await t.balance(t.ids.bigS), 3_000_000);
  await t.as(U.finance, `select app.record_receipt($1,$2,'2026-10-20',2500000,'XOF','wave')`, [t.ids.org, t.ids.bigS]);
  assert.equal(await t.due(d1), 0);
  assert.equal(await t.due(d2), 500_000);
  assert.equal(await t.balance(t.ids.bigS), 500_000);
});

test('指定冲本单：有旧债只付新单，旧债保留；收款只记一次', async () => {
  const t = await setup();
  const d1 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d1, null, '2026-10-01T09:00:00Z');
  const d2 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  await t.shipAll(d2, null, '2026-10-05T09:00:00Z');
  await t.as(U.finance, `select app.record_receipt($1,$2,'2026-10-06',11000,'XOF','cash','XOF',1,'specific',$3)`,
    [t.ids.org, t.ids.camaraAbobo, JSON.stringify([d2])]);
  assert.equal(await t.due(d1), 5500);
  assert.equal(await t.due(d2), 0);
  assert.equal(await t.balance(t.ids.camaraAbobo), 5500);
});

test('预付：欠100再付1000 → 余额 -900；再出900 → 0', async () => {
  const t = await setup();
  await t.db.query(`update app.product_prices set price = 100 where product_id=$1 and tier='REPAIR'`, [t.ids.bg6mCover]);
  const d1 = await t.toConfirmed(t.ids.camaraOme, [{ product_id: t.ids.bg6mCover, qty_req: 1 }]);
  await t.shipAll(d1);
  await t.as(U.finance, `select app.record_receipt($1,$2,'2026-10-06',1000,'XOF','orange','XOF',1,'oldest')`, [t.ids.org, t.ids.camaraOme]);
  assert.equal(await t.balance(t.ids.camaraOme), -900);
  const d2 = await t.toConfirmed(t.ids.camaraOme, [{ product_id: t.ids.bg6mCover, qty_req: 9 }]);
  await t.shipAll(d2);
  assert.equal(await t.balance(t.ids.camaraOme), 0);
});

test('期初历史导入作为一单，参与最旧冲账', async () => {
  const t = await setup();
  const open = await t.val(U.finance, `select app.import_opening($1,'XOF',50000,'飞书Balance期初')`, [t.ids.camaraAbobo]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  await t.as(U.finance, `select app.record_receipt($1,$2,'2026-10-27',50000,'XOF','cash')`, [t.ids.org, t.ids.camaraAbobo]);
  assert.equal(await t.due(open), 0);
  assert.equal(await t.due(d), 5500);
});

test('跨币收款：100 CNY × 85 锁定为 8500 XOF，原币与汇率保留', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  await t.shipAll(d);
  const r = await t.val(U.finance, `select app.record_receipt($1,$2,'2026-10-27',100,'CNY','bank','XOF',85)`, [t.ids.org, t.ids.camaraAbobo]);
  const row = await t.one(`select amount, currency, rate, converted from app.receipts where id=$1`, [r]);
  assert.deepEqual({ ...row, amount: Number(row.amount), rate: Number(row.rate), converted: Number(row.converted) },
    { amount: 100, currency: 'CNY', rate: 85, converted: 8500 });
  assert.equal(await t.balance(t.ids.camaraAbobo), 11000 - 8500);
  await rejects(t.as(U.finance, `select app.record_receipt($1,$2,'2026-10-27',100,'XOF','cash','XOF',2)`, [t.ids.org, t.ids.camaraAbobo]), /同币种汇率必须为1/);
});

test('已付款退货：按原单原行，审批后进待检、冲应收、多付转预付；检验好货回原仓坏货报废', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  const rc = await t.val(U.finance, `select app.record_receipt($1,$2,'2026-10-27',5500,'XOF','cash')`, [t.ids.org, t.ids.camaraAbobo]);
  const [l] = await t.lines(d);
  await rejects(t.as(U.hotline, `select app.request_return($1,'quality','屏幕不亮',$2)`, [d, JSON.stringify([{ line_id: l.id, qty: 11 }])]), /超过可退/);
  const rt = await t.val(U.hotline, `select app.request_return($1,'quality','屏幕不亮',$2)`, [d, JSON.stringify([{ line_id: l.id, qty: 4 }])]);
  await rejects(t.as(U.manager, `select app.decide_return($1,true)`, [rt]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.decide_return($1,true)`, [rt]);
  assert.equal(await t.balance(t.ids.camaraAbobo), -2200, '多付的 4×550 变成预付款');
  assert.equal(await t.due(d), 0);
  const open = await t.one(`select unallocated from app.v_receipt_open where id=$1`, [rc]);
  assert.equal(Number(open.unallocated), 2200);
  const pending = await t.one(`select s.id, s.qty_on_hand from app.stock_items s join app.warehouses w on w.id=s.warehouse_id where w.kind='pending' and s.product_id=$1`, [t.ids.bg6mCover]);
  assert.equal(pending.qty_on_hand, 4);
  const rl = await t.one(`select id from app.return_lines where return_id=$1`, [rt]);
  await t.as(U.manager, `select app.inspect_return_line($1,3,1)`, [rl.id]);
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_on_hand, 500 - 10 + 3);
  const scrap = await t.one(`select s.qty_on_hand from app.stock_items s join app.warehouses w on w.id=s.warehouse_id where w.kind='scrap' and s.product_id=$1`, [t.ids.bg6mCover]);
  assert.equal(scrap.qty_on_hand, 1);
  await rejects(t.as(U.manager, `select app.inspect_return_line($1,1,0)`, [rl.id]), /超过退货数量/);
});

test('抢库存：A 预占60后，B 只能拿到0；A 取消后释放', async () => {
  const t = await setup();
  const mk = () => t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo,
    JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 60, stock_item_id: t.ids.stLA_bg6m }])]);
  const a = await mk(); const b = await mk();
  await t.as(U.manager, `select app.start_picking($1)`, [a]);
  const shortB = await t.val(U.manager, `select app.start_picking($1)`, [b]);
  assert.equal(shortB[0].qty, 60);
  await t.as(U.manager, `select app.cancel_deal($1,'客户不要了')`, [a]);
  assert.equal((await t.stockOf(t.ids.stLA_bg6m)).qty_reserved, 0);
});

test('出库前追加货：直接预占，已确认的单回到「待客户确认」，销售单号不变', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const so = (await t.one(`select so_no from app.deals where id=$1`, [d])).so_no;
  await t.as(U.manager, `select app.add_lines_before_ship($1,$2)`, [d, JSON.stringify([{ product_id: t.ids.x6516, qty_req: 5 }])]);
  assert.equal(await t.status(d), 'ordered');
  assert.equal((await t.one(`select so_no from app.deals where id=$1`, [d])).so_no, so);
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_reserved, 5);
  const ls = await t.lines(d);
  assert.equal(ls[1].added_after_pick, true);
});
