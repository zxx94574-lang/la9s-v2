// 0034 (Frank 11-11 206): 到岸成本向上进位; 运费按批次实付 ÷ 片数 (每片进 50); 档案里改基本信息 + 修改记录
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = async (p, re) => { try { await p; } catch (e) { assert.match(e.message, re); return; } assert.fail('should have thrown'); };

test('到岸成本向上进到 100; 批次运费 = 总运费 ÷ 总片数 向上进 50', async () => {
  const t = await setup();
  const p = t.ids.bg6mScreen;
  // 汇率 1 XOF = 0.0107 RMB, 取整 100: ¥2.857 ÷ 0.0107 ≈ 267 + 运费 150 = 417 → 500
  await t.as(U.admin, `select app.set_product_cost($1,2.857,150,100,200,300,400)`, [p]);
  const s = await t.one(`select price::float from app.product_prices where product_id=$1 and tier='S' and currency='XOF'`, [p]);
  assert.equal(s.price, 600);   // 500 + FEE 100
  // 一批: 总运费 630,000 ÷ 6,000 片 = 105 → 每片 150
  const id = await t.val(U.admin, `select app.save_product_batch($1,null,$2)`, [p, JSON.stringify({ po_no: 'PO9', qty: 100, currency: 'USD', unit_price: 0.4443, freight_total: 630000, freight_pieces: 6000 })]);
  const f = await t.one(`select app.batch_freight(b)::float f from app.product_batches b where id=$1`, [id]);
  assert.equal(f.f, 150);
  await rejects(t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [p, JSON.stringify({ qty: 1, unit_price: 1, freight_total: 100 })]), /一共多少片/);
  // 同一采购单号一次填运费
  const n = await t.val(U.admin, `select app.set_batch_freight($1,'PO9',500000,5000)`, [t.ids.org]);
  assert.equal(Number(n), 1);
  assert.equal((await t.one(`select app.batch_freight(b)::float f from app.product_batches b where id=$1`, [id])).f, 100);
});

test('档案里改物料基本信息 (只中方) + 修改记录', async () => {
  const t = await setup();
  const p = t.ids.bg6mScreen;
  await rejects(t.as(U.hotline, `select app.edit_product_info($1,$2)`, [p, JSON.stringify({ brand: 'TECNO' })]), /PERMISSION_DENIED|FORBIDDEN/);
  await t.as(U.admin, `select app.edit_product_info($1,$2)`, [p, JSON.stringify({ brand: 'TECNO', shared_models: ['bg6', ' x6516 '] })]);
  const r = await t.one(`select brand, shared_models from app.products where id=$1`, [p]);
  assert.equal(r.brand, 'TECNO'); assert.deepEqual(r.shared_models, ['BG6', 'X6516']);
  await t.as(U.admin, `select app.log_archive_edit($1,'product',$2,$3,$4,$5)`, [t.ids.org, p, JSON.stringify({ brand: ['', 'TECNO'] }), JSON.stringify(['运费没填']), '核对过']);
  const h = await t.as(U.admin, `select * from app.archive_history($1,'product',$2)`, [t.ids.org, p]);
  assert.ok(h.some((x) => x.action === 'archive_edit' && x.detail.reason === '核对过'));
  assert.ok(h.some((x) => x.action === 'edit_product_info'));
});
