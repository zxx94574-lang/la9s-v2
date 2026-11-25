// 0089: 盘点 + 库位 + 消耗池
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('盘点: 库位格式 / 错码进消耗池 / 盘亏 / 确认后系统 = 实物 / 出货从池里捞 / 库位扣空', async () => {
  const t = await setup();
  const org = t.ids.org;
  const b2 = (await t.one(`insert into app.products (org_id, code, category_id, model, variant) values ($1,'1009',$2,'BG6M','旧码') returning id`, [org, t.ids.catScreen])).id;
  await t.as(U.admin, `select app.set_code_unify($1,$2,'same',$3,null)`, [org, [t.ids.bg6mScreen, b2], t.ids.bg6mScreen]);
  await assert.rejects(t.as(U.admin, `select app.bin_upsert($1,'SSA-1')`, [org]), /格式不对|没有「SSA」/);
  await assert.rejects(t.as(U.admin, `select app.bin_upsert($1,'SS-E-1')`, [org]), /只有货架/);
  await assert.rejects(t.as(U.admin, `select app.bin_upsert($1,'SS-A-5')`, [org]), /1–4 层/);
  await assert.rejects(t.as(U.admin, `select app.bin_upsert($1,'LR-A-1')`, [org]), /没有货架/);
  await t.as(U.admin, `select app.bin_upsert($1,' lr ')`, [org]);
  const c = await t.val(U.admin, `select app.count_start($1,'年前大盘点',true)`, [org]);
  await assert.rejects(t.as(U.admin, `select app.count_start($1,'x',true)`, [org]), /已经有一次/);
  await t.val(U.admin, `select app.count_task_set($1,$2,'SS-A, SS-B')`, [c, t.ids.sales]);
  await t.as(U.picker, `select app.count_add($1,'ss-a-1',$2,70,null)`, [c, t.ids.bg6mScreen]);
  await t.as(U.picker, `select app.count_add($1,'SS-A-2',$2,30,'贴错码')`, [c, b2]);
  await t.as(U.picker, `select app.count_add($1,'TXI-A-1',$2,490,null)`, [c, t.ids.bg6mCover]);
  const pv = await t.as(U.admin, `select * from app.count_preview($1)`, [c]);
  const by = Object.fromEntries(pv.map((r) => [r.product_id, r]));
  assert.deepEqual([by[t.ids.bg6mScreen].diff, by[t.ids.bg6mScreen].pool_plus, by[t.ids.bg6mScreen].loss], [40, 30, 10]);
  assert.deepEqual([by[b2].diff, by[b2].pool_minus, by[b2].gain], [-30, 30, 0]);
  assert.equal(by[t.ids.bg6mCover].loss, 10); assert.equal(by[t.ids.x6516].loss, 200);   // 没盘到 = 实物 0
  await assert.rejects(t.as(U.picker, `select app.count_apply($1)`, [c]), /PERMISSION/);
  const res = await t.val(U.admin, `select app.count_apply($1)`, [c]);
  assert.equal(res.loss, 220); assert.equal(res.pool, 2);
  const q = async (p) => Number((await t.one(`select coalesce(sum(s.qty_on_hand),0) q from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where w.kind = 'local' and s.product_id = $1`, [p])).q);
  assert.equal(await q(t.ids.bg6mScreen), 70); assert.equal(await q(b2), 30); assert.equal(await q(t.ids.bg6mCover), 490); assert.equal(await q(t.ids.x6516), 0);
  assert.equal((await t.one(`select status, pause_ship from app.counts where id = $1`, [c])).pause_ship, false);
  // 出 b2 20 片: 库位扣 20, 金蝶改记 bg6mScreen (池里捞)
  const st = (await t.one(`select s.id from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where w.kind = 'local' and s.product_id = $1`, [b2])).id;
  await t.db.query(`select app.move_stock($1,-20,'ship','shipment',null)`, [st]);
  const use = await t.one(`select kd_product, qty from app.pool_uses where ship_product = $1`, [b2]);
  assert.equal(use.kd_product, t.ids.bg6mScreen); assert.equal(use.qty, 20);
  assert.equal(Number((await t.one(`select qty from app.bin_items i join app.bins b on b.id = i.bin_id where b.code = 'SS-A-2'`)).qty), 10);
  assert.equal((await t.one(`select bin from app.stock_items where id = $1`, [st])).bin, 'SS-A-2');
  // 上架 / 挪位
  await t.db.query(`select app.move_stock($1,15,'grn','po',null)`, [st]);
  await assert.rejects(t.as(U.picker, `select app.bin_putaway($1,'SS-B-1',$2,16,null)`, [org, b2]), /只有 15/);
  await t.as(U.picker, `select app.bin_putaway($1,'SS-B-1',$2,15,null)`, [org, b2]);
  await t.as(U.picker, `select app.bin_move($1,'SS-A-2','SS-B-1',$2,10)`, [org, b2]);
  assert.equal(Number((await t.one(`select qty from app.bin_items i join app.bins b on b.id = i.bin_id where b.code = 'SS-A-2'`)).qty), 0);
  assert.ok((await t.db.query(`select 1 from app.bin_log l join app.bins b on b.id = l.bin_id where b.code = 'SS-A-2' and l.kind = 'move_out'`)).rows.length);
  // 盘点中不能出库
  await t.val(U.admin, `select app.count_start($1,'复盘',true)`, [org]);
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 1 }])]);
  await assert.rejects(t.db.query(`insert into app.shipments (org_id, deal_id, out_no) values ($1,$2,'T1')`, [org, deal]), /正在盘点/);
});

test('盘点任务: 货架 + 种类, 一个货架只派一个人; 确认后金蝶已录完', async () => {
  const t = await setup();
  const org = t.ids.org;
  const c = await t.val(U.admin, `select app.count_start($1,'x',true)`, [org]);
  await t.val(U.admin, `select app.count_task_set2($1,$2,$3,$4)`, [c, t.ids.sales, ['ss-a', 'SS-B'], t.ids.catScreen]);
  await assert.rejects(t.as(U.admin, `select app.count_task_set2($1,$2,$3,null)`, [c, t.ids.sales, ['SS-B', 'LR']]), /已经派给/);
  await assert.rejects(t.as(U.admin, `select app.count_task_set2($1,$2,$3,null)`, [c, t.ids.sales, ['SS-E']]), /没有货架/);
  await assert.rejects(t.as(U.admin, `select app.count_task_set2($1,$2,$3,null)`, [c, t.ids.sales, ['SS']]), /没有货架/);
  await t.val(U.admin, `select app.count_task_set2($1,$2,$3,null)`, [c, t.ids.sales, ['LR']]);
  const tk = await t.one(`select shelves, category_id from app.count_tasks where count_id = $1 order by created_at limit 1`, [c]);
  assert.deepEqual(tk.shelves.sort(), ['SS-A', 'SS-B']); assert.equal(tk.category_id, t.ids.catScreen);
  await t.as(U.picker, `select app.count_add($1,'SS-A-1',$2,5,null)`, [c, t.ids.bg6mScreen]);
  await assert.rejects(t.as(U.admin, `select app.count_kd_done($1)`, [c]), /还没确认/);
  await t.val(U.admin, `select app.count_apply($1)`, [c]);
  await t.as(U.admin, `select app.count_kd_done($1)`, [c]);
  assert.ok((await t.one(`select kd_done_at from app.counts where id = $1`, [c])).kd_done_at);
});

test('找货选了库位: 出库先扣那个库位', async () => {
  const t = await setup();
  const org = t.ids.org;
  const st = (await t.one(`select s.id from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where w.kind = 'local' and s.product_id = $1 limit 1`, [t.ids.bg6mCover])).id;
  await t.as(U.picker, `select app.bin_putaway($1,'SS-A-1',$2,10,null)`, [org, t.ids.bg6mCover]);
  await t.as(U.picker, `select app.bin_putaway($1,'SS-B-1',$2,50,null)`, [org, t.ids.bg6mCover]);
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5 }])]);
  const line = (await t.one(`select id from app.deal_lines where deal_id = $1`, [deal])).id;
  await t.as(U.picker, `select app.set_pick_bin($1,'ss-b-1')`, [line]);
  const sh = (await t.one(`insert into app.shipments (org_id, deal_id, out_no, shipped_at, method, contact_phone, address, proof_path, amount) select $1,$2,'T9',now(),(enum_range(null::app.ship_method))[1],'0','x','p',0 returning id`, [org, deal])).id;
  await t.db.query(`select app.move_stock($1,-5,'ship','shipment',$2)`, [st, sh]);
  const q = async (c) => Number((await t.one(`select i.qty from app.bin_items i join app.bins b on b.id = i.bin_id where b.code = $1 and i.product_id = $2`, [c, t.ids.bg6mCover])).qty);
  assert.equal(await q('SS-B-1'), 45); assert.equal(await q('SS-A-1'), 10);
});
