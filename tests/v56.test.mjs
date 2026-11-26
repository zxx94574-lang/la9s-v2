// 0102 国家经理 + 0103 工资只给中方和国家经理 / 金蝶导入 + 飞书历史 + 对账 / 在库批次倒推
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const CM = '00000000-0000-0000-0000-000000000012', SM = '00000000-0000-0000-0000-000000000011';

test('国家经理 = 本地所有岗位能做的都能做；工资只有中方 + 国家经理，销售主管不行', async () => {
  const t = await setup(); const org = t.ids.org;
  await t.one(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{country_manager}'), ($3,$2,'{sales_manager}') returning 1`, [CM, org, SM]);
  assert.equal(await t.val(CM, `select app.has_role($1, array['manager']::app.role_name[])`, [org]), true);
  assert.equal(await t.val(CM, `select app.has_role_txt($1, array['finance','picker'])`, [org]), true);
  assert.equal(await t.val(SM, `select app.has_role_txt($1, array['finance'])`, [org]), false);
  await t.as(CM, `select app.require_role($1, 'admin', 'sales_manager')`, [org]);
  await assert.rejects(t.as(SM, `select app.require_role($1, 'admin', 'sales_manager')`, [org]), /工资只有中方和国家经理/);
  await t.as(U.admin, `select app.require_role($1, 'admin', 'sales_manager')`, [org]);
  await assert.rejects(t.as(U.picker, `select app.require_role($1, 'manager')`, [org]), /PERMISSION/);
});

test('金蝶导入 + 飞书历史 → 按客户对应收（扣时间差）、按单对（客户挂错 / 只在金蝶 / 金额不同）、结论', async () => {
  const t = await setup(); const org = t.ids.org;
  const load = (kind, rows) => t.val(U.finance, `select app.kd_lines_load($1,$2,$3)`, [org, kind, JSON.stringify(rows)]);
  await assert.rejects(t.as(U.picker, `select app.kd_lines_load($1,'out','[]')`, [org]), /PERMISSION/);
  await load('customer', [{ doc_no: 'CI0003', party_code: 'CI0003', party_name: 'THOMAS' }, { doc_no: 'CI0060', party_code: 'CI0060', party_name: 'DIALLO' }]);
  await load('opening', [{ doc_no: 'AR-1', d: '2025-12-31', party_name: 'DIALLO', amount: 100000 }]);
  await load('out', [
    { doc_no: 'XSCK-1', src_no: 'SO-1', d: '2026-06-08', party_code: 'CI0060', party_name: 'DIALLO', code: '1', qty: 10, amount: 500000 },
    { doc_no: 'XSCK-2', src_no: 'SO-2', d: '2026-06-09', party_code: 'CI00003', party_name: 'THOMAS', code: '1', qty: 10, amount: 300000 },
    { doc_no: 'XSCK-3', src_no: 'SO-3', d: '2026-06-10', party_code: 'CI0003', party_name: 'THOMAS', code: '1', qty: 5, amount: 200000 }]);
  await load('ret', [{ doc_no: 'XSCK-9', src_no: 'XSCK-2', d: '2026-06-12', party_code: 'CI0003', code: '1', qty: -1, amount: -30000 }]);
  await load('receipt', [{ doc_no: 'RV-1', d: '2026-06-20', party_code: 'CI0003', amount: 100000, amount_xof: 100000, biz: '销售回款' }]);
  // 再导一次同一张单 = 换掉，不重复
  await load('receipt', [{ doc_no: 'RV-1', d: '2026-06-20', party_code: 'CI0003', amount: 100000, amount_xof: 100000, biz: '销售回款' }]);
  assert.equal(Number(await t.val(U.admin, `select count(*) from app.kd_lines where kind = 'receipt'`)), 1);
  await assert.rejects(t.as(U.finance, `select app.hist_sales_load($1,'[]')`, [org]), /PERMISSION/);
  await t.as(U.admin, `select app.hist_sales_load($1,$2)`, [org, JSON.stringify([
    { d: '2026-06-01', customer_code: 'CI0003', customer_name: 'THOMAS/3', so_no: 'SO-1', status: 'Done', qty: 10, amount: 500000, due: 500000 },   // 飞书挂在 THOMAS，金蝶挂 DIALLO
    { d: '2026-06-09', customer_code: 'CI0003', customer_name: 'THOMAS/3', so_no: 'XSCK-2', status: 'Done', qty: 9, amount: 270000, ret_amount: 30000, paid: 170000, due: 100000, paid_on: '2026-06-25' },
    { d: '2026-06-30', customer_code: 'CI0003', customer_name: 'THOMAS/3', so_no: null, status: 'Done', qty: 1, amount: 50000, due: 50000 },   // 还没录金蝶
    { d: '2026-06-02', customer_code: 'CI0003', status: 'NotShipped', qty: 0, amount: 0 }])]);
  const so = Object.fromEntries((await t.as(U.finance, `select * from app.recon_so($1)`, [org])).map((r) => [r.so_no, r]));
  assert.equal(so['SO-1'].cat, '客户不同');
  assert.equal(so['SO-2'].cat, '一致');   // 飞书 XSCK-2 换成 SO-2；金蝶 300000 − 退 30000 = 飞书 270000
  assert.equal(so['SO-3'].cat, '只在金蝶');
  const ar = Object.fromEntries((await t.as(U.finance, `select * from app.recon_ar($1)`, [org])).map((r) => [r.code, r]));
  // THOMAS 金蝶 = 300000 + 200000 − 30000 − 100000 = 370000；飞书待付 650000 + 金蝶收款最后一天后收的 170000 − 没录金蝶的 50000 = 770000
  assert.equal(Number(ar.CI0003.kd_ar), 370000);
  assert.equal(Number(ar.CI0003.fs_adj), 770000);
  assert.equal(Number(ar.CI0060.kd_ar), 600000);   // 期初按名字对上客户编码
  await t.as(U.finance, `select app.recon_mark($1,'so:SO-1','客户不同','系统 / 飞书要改','这单是 DIALLO 的')`, [org]);
  assert.equal((await t.as(U.finance, `select * from app.recon_so($1)`, [org])).find((r) => r.so_no === 'SO-1').verdict, '系统 / 飞书要改');
});

test('在库批次：现在的库存从最后一次进货往前倒推；老批次不再算进挂牌成本', async () => {
  const t = await setup(); const p = t.ids.bg6mScreen;
  const onHand = Number(await t.val(U.admin, `select coalesce(sum(qty_on_hand),0) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = $1 and w.kind in ('local','fob')`, [p]));
  await t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [p, JSON.stringify({ po_no: 'OLD', ordered_on: '2025-01-01', qty: 100000, currency: 'CNY', unit_price: 999 })]);
  await t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [p, JSON.stringify({ po_no: 'NEW', ordered_on: '2026-11-01', qty: Math.max(onHand, 1), currency: 'CNY', unit_price: 30 })]);
  const rows = Object.fromEntries((await t.as(U.admin, `select po_no, in_stock from app.v_batch_layers where product_id = $1 and po_no in ('OLD','NEW')`, [p])).map((r) => [r.po_no, Number(r.in_stock)]));
  assert.equal(rows.NEW, Math.min(onHand, Math.max(onHand, 1)));
  assert.equal(rows.OLD, 0);
});

test('0104 经营总览: dash_rows 多一列 freight (我们出的运费), 本地行 cost 里含它, FOB 行是 0', async () => {
  const t = await setup(); const org = t.ids.org;
  const rows = await t.as(U.admin, `select supply, cost, freight from app.dash_rows($1)`, [org]);
  for (const r of rows) {
    assert.ok(r.freight !== undefined, 'freight 这一列要有');
    assert.ok(Number(r.freight) >= 0);
    if (r.supply === 'fob') assert.equal(Number(r.freight), 0);
    if (r.cost != null) assert.ok(Number(r.cost) + 0.01 >= Number(r.freight), '成本里已经含运费, 减了不会变负');
  }
});
