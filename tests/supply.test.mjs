// 0011 初始导入 (物料 / 库存+库龄 / 在途采购 / 应收期初) · 账龄 · 备货看板
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('物料导入: 新种类自动建; 按编码更新; 有成本就按公式出价; 同种类同型号撞编码报出来', async () => {
  const t = await setup();
  await t.as(U.admin, `insert into app.price_settings (org_id) values ($1)`, [t.ids.org]);
  const rows = [
    { code: '2001', category: '电池', model: 'bl-39', brand: 'TECNO', rmb_cost: 10.7, freight: 100, fee_s: 200, fee_a: 300, fee_b: 400, fee_c: 500, shared_models: ['spark 5'] },
    { code: '1001', category: '屏幕', model: 'BG6M', rmb_cost: 21.4 },
    { code: '2002', category: '屏幕', model: 'BG6M' },
    { code: '', category: 'x', model: 'y' },
  ];
  await rejects(t.as(U.manager, `select app.import_products($1,$2)`, [t.ids.org, JSON.stringify(rows)]), /PERMISSION_DENIED/);
  const r = await t.val(U.admin, `select app.import_products($1,$2)`, [t.ids.org, JSON.stringify(rows)]);
  assert.equal(r.new, 1); assert.equal(r.updated, 1); assert.equal(r.bad, 2);
  const p = await t.one(`select id, model, shared_models from app.products where code='2001'`);
  assert.equal(p.model, 'BL-39'); assert.deepEqual(p.shared_models, ['SPARK 5']);
  assert.equal(Number((await t.one(`select price from app.product_prices where product_id=$1 and tier='S'`, [p.id])).price), 1100 + 200);
});

test('库存导入: 对齐实存并记 opening 移动; 不能低于预占; 库龄快照', async () => {
  const t = await setup();
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 100 }])]);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  const r = await t.val(U.admin, `select app.import_stock($1,'2026-10-19',$2)`, [t.ids.org, JSON.stringify([
    { code: '1001', warehouse: 'LA', qty: 80, a0_30: 50, a181_365: 30 },
    { code: '1002', warehouse: 'LA', qty: 50 },
    { code: '9999', warehouse: 'LA', qty: 5 }])]);
  assert.equal(r.n, 1); assert.equal(r.bad, 2);
  assert.equal((await t.stockOf(t.ids.stLA_bg6m)).qty_on_hand, 80);
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_on_hand, 500, '低于预占的行不动');
  const v = await t.one(`select * from app.v_replenish where product_id=$1`, [t.ids.bg6mScreen]);
  assert.equal(Number(v.aged_180), 30);
});

test('在途采购: 导入合并同单号; 到货只能进本地仓, 不能超收; 收完自动关单; 看板算在途和建议', async () => {
  const t = await setup();
  const r = await t.val(U.admin, `select app.import_purchase_orders($1,$2)`, [t.ids.org, JSON.stringify([
    { po_no: 'CGDD001', supplier: '深圳', mode: 'sea', eta: '2026-12-01', code: '1003', qty: 300 },
    { po_no: 'CGDD001', code: '1001', qty: 40 },
    { po_no: 'CGDD002', mode: 'air', model: 'spark 30 pro', qty: 20 }])]);
  assert.deepEqual(r, { po: 2, lines: 3, skipped: 0 });
  let v = await t.one(`select * from app.v_replenish where product_id=$1`, [t.ids.x6516]);
  assert.equal(Number(v.in_transit), 300);
  const po = (await t.one(`select id from app.purchase_orders where po_no='CGDD001'`)).id;
  const [l1, l2] = await t.as(U.admin, `select id, product_id from app.po_lines where po_id=$1 order by qty desc`, [po]);
  await rejects(t.as(U.picker, `select app.receive_po($1,$2)`, [po, JSON.stringify([{ line_id: l1.id, qty: 10, warehouse: '9S' }])]), /PERMISSION_DENIED/);
  await rejects(t.as(U.manager, `select app.receive_po($1,$2)`, [po, JSON.stringify([{ line_id: l1.id, qty: 10, warehouse: 'FOB' }])]), /LA 仓或 9S 仓/);
  await rejects(t.as(U.manager, `select app.receive_po($1,$2)`, [po, JSON.stringify([{ line_id: l1.id, qty: 301, warehouse: '9S' }])]), /超过/);
  await t.as(U.manager, `select app.receive_po($1,$2)`, [po, JSON.stringify([{ line_id: l1.id, qty: 300, warehouse: '9S' }, { line_id: l2.id, qty: 40, warehouse: 'LA' }])]);
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_on_hand, 500);
  assert.equal((await t.one(`select status from app.purchase_orders where id=$1`, [po])).status, 'closed');
  v = await t.one(`select * from app.v_replenish where product_id=$1`, [t.ids.x6516]);
  assert.equal(Number(v.in_transit), 0);
  // 出库 60 → 日均 2 → 备 60 天要 120, 可售 440 → 不用补
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.x6516, qty_req: 60 }]);
  await t.shipAll(d, null, new Date().toISOString());
  v = await t.one(`select * from app.v_replenish where product_id=$1`, [t.ids.x6516]);
  assert.equal(Number(v.sold_30), 60); assert.equal(Number(v.daily), 2); assert.equal(Number(v.suggest), 0); assert.equal(Number(v.days_left), 220);
});

test('应收期初按单据导入: 有账龄; 找不到客户的退回; 冲账先冲最老的期初单', async () => {
  const t = await setup();
  const r = await t.val(U.admin, `select app.import_opening_items($1,$2)`, [t.ids.org, JSON.stringify([
    { customer_code: 'C001', amount: 100000, date: '2026-05-01', ref: 'AR-1' },
    { customer_code: 'C001', amount: 50000, date: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), ref: 'AR-2' },
    { customer_code: 'NOPE', amount: 1, date: '2026-01-01' }])]);
  assert.equal(r.n, 2); assert.equal(r.missing.length, 1);
  const a = await t.one(`select * from app.v_ar_aging where customer_id=$1`, [t.ids.camaraAbobo]);
  assert.equal(Number(a.due), 150000); assert.equal(Number(a.d0_30), 50000); assert.equal(Number(a.d180 ?? 0) + Number(a.d91_180 ?? 0), 100000);
  await t.as(U.finance, `select app.record_receipt($1,$2,current_date,120000,'XOF','cash')`, [t.ids.org, t.ids.camaraAbobo]);
  const a2 = await t.one(`select * from app.v_ar_aging where customer_id=$1`, [t.ids.camaraAbobo]);
  assert.equal(Number(a2.due), 30000); assert.equal(Number(a2.d0_30), 30000, '老的先冲掉');
});

test('0012 真实物料: 同种类同型号不同颜色要填「区分」才能并存', async () => {
  const t = await setup();
  const r = await t.val(U.admin, `select app.import_products($1,$2)`, [t.ids.org, JSON.stringify([
    { code: '3001', category: '电池盖', model: 'AA XR', variant: 'White' },
    { code: '3002', category: '电池盖', model: 'AA XR', variant: 'Orange' },
    { code: '3003', category: '电池盖', model: 'AA XR', variant: 'White' }])]);
  assert.equal(r.new, 2); assert.equal(r.bad, 1); assert.match(r.bad_rows[0].why, /区分/);
});
