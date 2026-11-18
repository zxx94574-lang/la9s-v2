// 0061: 汇率预览 (不落库) · 人民币报价只给 S 档 · 编码甄别
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('汇率预览: 列出改前 → 改后, 不落库; 保存后才真的变', async () => {
  const t = await setup();
  await t.as(U.admin, `select app.set_product_cost($1, 10, 100, 100, 200, 300, 400)`, [t.ids.bg6mCover]);
  const ps = await t.one(`select * from app.price_settings where org_id = $1`, [t.ids.org]);
  const before = (await t.db.query(`select tier, price from app.product_prices where product_id = $1 and currency = 'XOF' order by tier`, [t.ids.bg6mCover])).rows;
  await rejects(t.as(U.manager, `select app.preview_price_settings($1,$2,$3,$4)`, [t.ids.org, Number(ps.rmb_per_xof) / 2, ps.rmb_per_xof_fob, ps.round_to]), /PERMISSION/);
  const pv = await t.val(U.admin, `select app.preview_price_settings($1,$2,$3,$4)`, [t.ids.org, Number(ps.rmb_per_xof) / 2, ps.rmb_per_xof_fob, ps.round_to]);
  const row = pv.changed.find((r) => r.product_id === t.ids.bg6mCover);
  assert.ok(row, '成本按人民币算的型号，汇率变了价格要变');
  assert.ok(Number(row.after.S) > Number(row.before.S));
  const after = (await t.db.query(`select tier, price from app.product_prices where product_id = $1 and currency = 'XOF' order by tier`, [t.ids.bg6mCover])).rows;
  assert.deepEqual(after, before, '预览不落库');
  assert.equal(Number((await t.one(`select rmb_per_xof from app.price_settings where org_id = $1`, [t.ids.org])).rmb_per_xof), Number(ps.rmb_per_xof));
  await t.as(U.admin, `select app.set_price_settings($1,$2,$3,$4)`, [t.ids.org, Number(ps.rmb_per_xof) / 2, ps.rmb_per_xof_fob, ps.round_to]);
  const real = await t.one(`select price from app.product_prices where product_id = $1 and currency = 'XOF' and tier = 'S'`, [t.ids.bg6mCover]);
  assert.equal(Number(real.price), Number(row.after.S), '保存后的价 = 预览的价');
});

test('人民币报价只给 S 档: 员工给别的档建人民币单被拦; S 档可以; 中方可以破例', async () => {
  const t = await setup();
  const L = JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await rejects(t.as(U.manager, `select app.create_quote_fx($1,$2,'CNY',$3,null,90)`, [t.ids.org, t.ids.camaraAbobo, L]), /只给 S 档/);
  await t.as(U.manager, `select app.create_quote_fx($1,$2,'CNY',$3,null,90)`, [t.ids.org, t.ids.bigS, L]);
  await t.as(U.admin, `select app.create_quote_fx($1,$2,'CNY',$3,null,90)`, [t.ids.org, t.ids.camaraAbobo, L]);
});

test('编码甄别: 定同一种货 / 不是 / 重置; 通用性不同要写原因; 批量导入', async () => {
  const t = await setup();
  const a = t.ids.bg6mCover, b = t.ids.bg6mScreen;
  await rejects(t.as(U.manager, `select app.set_code_unify($1,$2,'same')`, [t.ids.org, [a, b]]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.set_code_unify($1,$2,'same')`, [t.ids.org, [a]]), /至少两个/);
  await t.db.query(`update app.products set shared_models = array['X1'] where id = $1`, [a]);
  await t.db.query(`update app.products set shared_models = array['X2'] where id = $1`, [b]);
  await rejects(t.as(U.admin, `select app.set_code_unify($1,$2,'same',$3)`, [t.ids.org, [a, b], a]), /通用性不一样/);
  await t.as(U.admin, `select app.set_code_unify($1,$2,'same',$3,'金蝶重复建档')`, [t.ids.org, [a, b], a]);
  const codeA = (await t.one(`select code from app.products where id = $1`, [a])).code;
  let r = await t.one(`select unify_code, unify_status from app.products where id = $1`, [b]);
  assert.equal(r.unify_code, codeA); assert.equal(r.unify_status, 'same');
  await t.as(U.admin, `select app.set_code_unify($1,$2,'diff')`, [t.ids.org, [a, b]]);
  r = await t.one(`select unify_code, unify_status from app.products where id = $1`, [b]); assert.equal(r.unify_code, null); assert.equal(r.unify_status, 'diff');
  await t.as(U.admin, `select app.set_code_unify($1,$2,'reset')`, [t.ids.org, [a, b]]);
  const codeB = (await t.one(`select code from app.products where id = $1`, [b])).code;
  const res = await t.val(U.admin, `select app.import_code_unify($1,$2)`, [t.ids.org, JSON.stringify([{ code: codeB, main_code: codeA }, { code: codeA }, { code: 'NOPE', main_code: codeA }])]);
  assert.equal(res.ok, 2); assert.deepEqual(res.bad, ['NOPE']);
  assert.equal((await t.one(`select unify_code from app.products where id = $1`, [b])).unify_code, codeA);
});
