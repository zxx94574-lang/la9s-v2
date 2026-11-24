// 0084: 经营总览改版 —— 库存看板 (件数 / 成本 / 库龄) / 在途 / 每日快照
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('库存看板: 库龄按入库先进先出, 只有中方能看', async () => {
  const t = await setup();
  await assert.rejects(t.as(U.manager, `select * from app.dash_stock($1)`, [t.ids.org]), /PERMISSION/);
  const rows = await t.as(U.admin, `select * from app.dash_stock($1)`, [t.ids.org]);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(Number(r.q0_30) + Number(r.q31_120) + Number(r.q120), Number(r.qty), `${r.product_code} 库龄三段加起来 = 现有`);
  // 把一条入库流水改成 200 天前 → 那部分进「120 天以上」
  // 没有入库流水的老货算 120 天以上; 记一笔今天的入库 → 这部分算 0–30 天
  const r00 = rows[0];
  await t.db.query(`insert into app.stock_moves (stock_item_id, qty, reason) values ($1, $2, 'grn')`, [r00.stock_item_id, Number(r00.qty)]);
  const r0 = (await t.as(U.admin, `select * from app.dash_stock($1)`, [t.ids.org])).find((r) => r.stock_item_id === r00.stock_item_id);
  assert.equal(Number(r0.q0_30), Number(r0.qty));
  await t.db.query(`update app.stock_moves set at = now() - interval '200 days' where stock_item_id = $1 and qty > 0`, [r0.stock_item_id]);
  const r1 = (await t.as(U.admin, `select * from app.dash_stock($1)`, [t.ids.org])).find((r) => r.stock_item_id === r0.stock_item_id);
  assert.equal(Number(r1.q120), Number(r1.qty)); assert.ok(r1.oldest_days >= 200);
  // 月报用的「按层」库龄: 每个库存行各层加起来 = 现有
  const lay = await t.as(U.admin, `select * from app.dash_stock_layers($1)`, [t.ids.org]);
  const sumL = lay.filter((x) => x.stock_item_id === r1.stock_item_id).reduce((a, x) => a + Number(x.qty), 0);
  assert.equal(sumL, Number(r1.qty));
  // 在途 + 快照
  await t.as(U.admin, `select * from app.dash_transit($1)`, [t.ids.org]);
  await t.as(U.admin, `select app.dash_snap($1,$2)`, [t.ids.org, JSON.stringify({ stock_cost: 100, ar: 5 })]);
  await t.as(U.admin, `select app.dash_snap($1,$2)`, [t.ids.org, JSON.stringify({ stock_cost: 120 })]);
  const s = await t.db.query(`select key, value from app.dash_snapshots order by key`);
  assert.deepEqual(s.rows.map((x) => [x.key, Number(x.value)]), [['ar', 5], ['stock_cost', 120]]);
  await assert.rejects(t.as(U.manager, `select app.dash_snap($1,'{"a":1}')`, [t.ids.org]), /PERMISSION/);
});
