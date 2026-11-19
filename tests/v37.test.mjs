// 0067: 出库前追加货 = 分支 (3.2 / 3.3…): 派人 → 找货 + 照片 → 销售单 -O2 → 客户确认 → 复检 → 并进原单一起出库
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const link = (t) => t.db.query(`update app.members set employee_id = $1 where user_id = $2`, [t.ids.picker, U.picker]);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('追加批走完整条小流程: 原单已复检的那批不动, 复检完并进原单, 一起出库', async () => {
  const t = await setup(); await link(t);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  assert.equal(await t.status(d), 'reviewed');
  const r0 = (await t.stockOf(t.ids.st9S_x6516)).qty_reserved;
  const a = await t.val(U.hotline, `select app.start_addon($1,$2,'客户又要 X6516')`, [d, JSON.stringify([{ product_id: t.ids.x6516, qty: 10 }])]);
  assert.equal(await t.status(d), 'reviewed', '原单状态不动');
  assert.equal((await t.lines(d)).length, 1, '追加的行先不进原单');
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_reserved, r0 + 10, '一开就预占');
  await rejects(t.as(U.picker, `select app.addon_pick_submit($1,'[]','p.jpg')`, [a]), /不在找货中|派给你/);
  await rejects(t.as(U.hotline, `select app.assign_addon($1,$2)`, [a, t.ids.picker]), /PERMISSION|权限|role/i);
  await t.as(U.manager, `select app.assign_addon($1,$2)`, [a, t.ids.picker]);
  const [al] = (await t.db.query(`select * from app.addon_lines where addon_id = $1`, [a])).rows;
  await rejects(t.as(U.picker, `select app.addon_pick_submit($1,$2,'')`, [a, '[]']), /照片/);
  await rejects(t.as(U.picker, `select app.addon_pick_submit($1,$2,'p.jpg')`, [a, JSON.stringify([{ line_id: al.id, qty: 8 }])]), /原因/);
  await t.as(U.picker, `select app.addon_pick_submit($1,$2,'p.jpg')`, [a, JSON.stringify([{ line_id: al.id, qty: 8, reason: '只剩 8 片好的' }])]);
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_reserved, r0 + 8, '找少了放掉多占的');
  const ad = await t.one(`select status, so_no from app.deal_addons where id = $1`, [a]);
  assert.equal(ad.status, 'ordered'); assert.match(ad.so_no, /-O2$/);
  await rejects(t.as(U.manager, `select app.addon_review($1,$2,'k.jpg')`, [a, t.ids.reviewer]), /客户还没确认/);
  await rejects(t.as(U.hotline, `select app.addon_confirm($1,'whatsapp','')`, [a]), /截图/);
  await t.as(U.hotline, `select app.addon_confirm($1,'whatsapp','c.jpg')`, [a]);
  await rejects(t.as(U.manager, `select app.addon_review($1,$2,'k.jpg')`, [a, t.ids.picker]), /复核人不能是找货/);
  await t.as(U.manager, `select app.addon_review($1,$2,'k.jpg')`, [a, t.ids.reviewer]);
  const ls = await t.lines(d);
  assert.equal(ls.length, 2); assert.equal(ls[1].qty_req, 10); assert.equal(ls[1].qty_supply, 8); assert.equal(ls[1].qty_confirmed, 8); assert.equal(ls[1].addon_id, a);
  assert.equal(await t.status(d), 'reviewed');
  await t.shipAll(d);
  assert.equal(await t.status(d), 'shipped');
  assert.equal((await t.lines(d))[1].qty_shipped, 8);
  await rejects(t.val(U.hotline, `select app.start_addon($1,$2)`, [d, JSON.stringify([{ product_id: t.ids.x6516, qty: 1 }])]), /已经发出去/);
});

test('追加批可以取消 (放掉预占); 可以开多批; 先出原单那批、追加批后并进来 → 回到部分出库', async () => {
  const t = await setup(); await link(t);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  const r0 = (await t.stockOf(t.ids.st9S_x6516)).qty_reserved;
  const a1 = await t.val(U.manager, `select app.start_addon($1,$2)`, [d, JSON.stringify([{ product_id: t.ids.x6516, qty: 5 }])]);
  const a2 = await t.val(U.manager, `select app.start_addon($1,$2)`, [d, JSON.stringify([{ product_id: t.ids.x6516, qty: 7 }])]);
  assert.deepEqual((await t.db.query(`select no from app.deal_addons where deal_id = $1 order by no`, [d])).rows.map((r) => r.no), [2, 3]);
  await rejects(t.as(U.manager, `select app.cancel_addon($1,'')`, [a1]), /原因/);
  await t.as(U.manager, `select app.cancel_addon($1,'客户不要了')`, [a1]);
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_reserved, r0 + 7);
  await t.as(U.manager, `select app.assign_addon($1,$2)`, [a2, t.ids.picker]);
  await t.as(U.picker, `select app.addon_pick_submit($1,'[]','p.jpg')`, [a2]);
  await t.shipAll(d);                                    // 先把已经好的那批发了
  assert.equal(await t.status(d), 'shipped');
  await t.as(U.hotline, `select app.addon_confirm($1,'phone','c.jpg')`, [a2]);
  await t.as(U.manager, `select app.addon_review($1,$2,'k.jpg')`, [a2, t.ids.reviewer]);
  assert.equal(await t.status(d), 'partial', '追加批并进来 → 还有货没发');
  await t.shipAll(d);
  assert.equal(await t.status(d), 'shipped');
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_reserved, r0);
});

test('整单作废: 没走完的追加批一起放掉预占', async () => {
  const t = await setup(); await link(t);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }], { review: false });
  const r0 = (await t.stockOf(t.ids.st9S_x6516)).qty_reserved;
  const a = await t.val(U.manager, `select app.start_addon($1,$2)`, [d, JSON.stringify([{ product_id: t.ids.x6516, qty: 5 }])]);
  await t.as(U.manager, `select app.cancel_deal($1,'客户不要了')`, [d]);
  assert.equal((await t.one(`select status from app.deal_addons where id = $1`, [a])).status, 'cancelled');
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_reserved, r0);
});
