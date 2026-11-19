// 0064: 销售订单自动生成 · 派人找货 / 改派 / 打勾提交 · 拆单按数量 · 客户联系人
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('派人找货 → 打勾 (少了要原因) → 改派 (打勾保留) → 提交 → 销售订单自动生成', async () => {
  const t = await setup();
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 20 }, { product_id: t.ids.bg6mScreen, qty_req: 5 }])]);
  await rejects(t.as(U.manager, `select app.assign_picker($1,$2)`, [d, t.ids.picker]), /找货中/);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  await rejects(t.as(U.picker, `select app.assign_picker($1,$2)`, [d, t.ids.picker]), /PERMISSION/);
  await t.as(U.manager, `select app.assign_picker($1,$2)`, [d, t.ids.picker]);
  const [a, b] = await t.lines(d);
  await rejects(t.as(U.picker, `select app.pick_tick($1, 18, '')`, [a.id]), /原因/);
  await rejects(t.as(U.picker, `select app.pick_tick($1, 21, 'x')`, [a.id]), /0 –/);
  await t.as(U.picker, `select app.pick_tick($1, 18, '货架只剩 18')`, [a.id]);
  await rejects(t.as(U.picker, `select app.submit_pick_ticks($1,'p.jpg')`, [d]), /还有 1 行没打勾/);
  await t.as(U.manager, `select app.assign_picker($1,$2,'上午的人下午放假')`, [d, t.ids.reviewer]);   // 改派
  assert.equal((await t.one(`select pick_tick_qty from app.deal_lines where id = $1`, [a.id])).pick_tick_qty, 18, '改派后已打的勾保留');
  const ev = await t.one(`select detail from app.deal_events where deal_id = $1 and action = 'picker_reassigned'`, [d]);
  assert.equal(ev.detail.note, '上午的人下午放假');
  await t.as(U.picker, `select app.pick_tick($1, 5, null)`, [b.id]);
  await rejects(t.as(U.picker, `select app.submit_pick_ticks($1,'')`, [d]), /照片/);
  await t.as(U.picker, `select app.submit_pick_ticks($1,'p.jpg')`, [d]);
  const row = await t.one(`select status, so_no, picker_employee_id from app.deals where id = $1`, [d]);
  assert.equal(row.status, 'ordered'); assert.match(row.so_no, /-O$/); assert.equal(row.picker_employee_id, t.ids.reviewer);
  const ls = await t.lines(d);
  assert.equal(ls[0].qty_supply, 18); assert.equal(ls[0].diff_reason, '货架只剩 18');
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 18, '少找的预占放掉');
});

test('拆单按数量: 100 片这次发 60、以后发 40; 两张单各一行, 拆出去的锁价', async () => {
  const t = await setup();
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 100 }, { product_id: t.ids.bg6mScreen, qty_req: 5 }])]);
  const [a, b] = await t.lines(d);
  await rejects(t.as(U.manager, `select app.split_deal_qty($1,$2)`, [d, JSON.stringify([{ line_id: a.id, qty: 101 }])]), /还多/);
  await rejects(t.as(U.manager, `select app.split_deal_qty($1,$2)`, [d, JSON.stringify([{ line_id: a.id, qty: 100 }, { line_id: b.id, qty: 5 }])]), /至少留一行/);
  const n = await t.val(U.manager, `select app.split_deal_qty($1,$2,null,'客户说下周再拿')`, [d, JSON.stringify([{ line_id: a.id, qty: 40 }])]);
  const l1 = await t.lines(d), l2 = await t.lines(n);
  assert.equal(l1.length, 2); assert.equal(l1[0].qty_req, 60);
  assert.equal(l2.length, 1); assert.equal(l2[0].qty_req, 40); assert.equal(l2[0].price_locked, true); assert.equal(Number(l2[0].unit_price), Number(l1[0].unit_price));
  assert.equal((await t.one(`select split_from from app.deals where id = $1`, [n])).split_from, d);
});

test('客户联系人: 加 / 同电话不重复 / 改 / 停用; 客户端账号不能改', async () => {
  const t = await setup(); const c = t.ids.camaraAbobo;
  await rejects(t.as(U.manager, `select app.save_customer_contact($1,$2)`, [c, JSON.stringify({ phone: '0701020304' })]), /名字/);
  let l = await t.val(U.manager, `select app.save_customer_contact($1,$2)`, [c, JSON.stringify({ name: 'Awa', phone: '07 01 02 03 04', role: 'staff' })]);
  assert.equal(l.length, 1); assert.equal(l[0].phone, '0701020304');
  l = await t.val(U.hotline, `select app.save_customer_contact($1,$2)`, [c, JSON.stringify({ name: 'AWA 2', phone: '0701020304', role: 'staff' })]);
  assert.equal(l.length, 1, '同一个电话不重复加');
  l = await t.val(U.hotline, `select app.save_customer_contact($1,$2)`, [c, JSON.stringify({ id: l[0].id, name: 'Awa K.', phone: '0701020304', role: 'driver', off: true })]);
  assert.equal(l[0].name, 'Awa K.'); assert.equal(l[0].role, 'driver'); assert.equal(l[0].off, true);
  await rejects(t.as(U.outsider, `select app.save_customer_contact($1,$2)`, [c, JSON.stringify({ name: 'x' })]), /PERMISSION/);
});
