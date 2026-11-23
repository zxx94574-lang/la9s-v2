// 0081: FOB 分批出库 / 全出 / 客户不要了转本地 (订金转预付)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

async function fobReady(t, qty = 300) {
  const f = await t.val(U.hotline, `select app.create_fob($1,$2,'CI','warehouse','XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([{ product_id: t.ids.x6516, qty }])]);
  const [l] = await t.as(U.admin, `select id from app.fob_lines where project_id=$1`, [f]);
  await t.as(U.admin, `select app.set_fob_price($1,1000)`, [l.id]);
  await t.as(U.manager, `select app.fob_advance($1,'purchasing','{"po_no":"P"}')`, [f]);
  await t.as(U.manager, `select app.fob_advance($1,'in_transit','{}')`, [f]);
  await t.as(U.manager, `select app.fob_receive($1,$2)`, [f, JSON.stringify([{ line_id: l.id, qty }])]);
  await t.as(U.finance, `select app.record_fob_payment($1,'deposit',$2,current_date,'bank','d.jpg')`, [f, qty * 1000 * 0.3]);
  return { f, line: l.id };
}

test('FOB 分批出库: 出一部分还是「放货」, 出完才「已出库」', async () => {
  const t = await setup();
  const { f, line } = await fobReady(t);
  await t.as(U.admin, `select app.fob_release($1,'先放')`, [f]);
  await t.as(U.manager, `select app.fob_ship2($1,$2,'s1.jpg','第一批')`, [f, JSON.stringify([{ line_id: line, qty: 100 }])]);
  assert.equal((await t.one(`select status from app.fob_projects where id=$1`, [f])).status, 'released');
  await assert.rejects(t.as(U.manager, `select app.fob_ship2($1,$2,'s2.jpg')`, [f, JSON.stringify([{ line_id: line, qty: 500 }])]), /最多还能出 200/);
  await t.as(U.manager, `select app.fob_ship2($1,null,'s2.jpg','剩下的')`, [f]);
  assert.equal((await t.one(`select status from app.fob_projects where id=$1`, [f])).status, 'shipped');
  assert.equal((await t.stockOf(t.ids.stFOB_x6516)).qty_on_hand, 1000);
});

test('FOB 客户不要了: 剩下的转进 9S 仓, 货款按剩下的算, 多收的订金转成预付款', async () => {
  const t = await setup();
  const { f, line } = await fobReady(t);
  await t.as(U.admin, `select app.fob_release($1,'先放')`, [f]);
  await t.as(U.manager, `select app.fob_ship2($1,$2,'s1.jpg')`, [f, JSON.stringify([{ line_id: line, qty: 50 }])]);
  await assert.rejects(t.as(U.manager, `select app.fob_to_local($1,null,'9S','不要了')`, [f]), /PERMISSION/);
  await assert.rejects(t.as(U.admin, `select app.fob_to_local($1,null,'9S','')`, [f]), /原因/);
  const s9q = `select coalesce(sum(qty_on_hand),0)::int as q from app.stock_items where warehouse_id=$1 and product_id=$2`;
  const before = (await t.one(s9q, [t.ids.wh9S, t.ids.x6516])).q;
  await t.as(U.admin, `select app.fob_to_local($1,null,'9S','客户资金紧张，不要了','credit')`, [f]);
  const v = await t.one(`select status, total, paid, qty_local from app.v_fob where id=$1`, [f]);
  assert.equal(v.qty_local, 250); assert.equal(Number(v.total), 50000); assert.equal(v.status, 'closed');   // 收的钱 ≥ 剩下的货款 → 结清
  assert.equal((await t.one(s9q, [t.ids.wh9S, t.ids.x6516])).q - before, 250);
  const ar = await t.one(`select sum(amount) as s from app.ar_entries where customer_id=$1 and kind='adjust'`, [t.ids.bigS]);
  assert.equal(Number(ar.s), -40000);   // 收了 90,000 订金, 只剩 50,000 货 → 40,000 转预付
});

test('FOB 一片没出就全部转本地 = 项目取消; 订金不退只记录', async () => {
  const t = await setup();
  const { f } = await fobReady(t, 100);
  await t.as(U.admin, `select app.fob_to_local($1,null,'LA','客户跑路','keep')`, [f]);
  assert.equal((await t.one(`select status from app.fob_projects where id=$1`, [f])).status, 'cancelled');
  assert.equal((await t.db.query(`select 1 from app.ar_entries where customer_id=$1 and kind='adjust'`, [t.ids.bigS])).rows.length, 0);
});
