// 0050 (Frank 11-16 Q7): 签收记跟谁确认的; 24 小时损坏反馈 —— 超时 / 人为损坏要中方写破例原因; 驳回要写原因
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

async function shipped(t) {
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  const l = await t.one(`select id from app.deal_lines where deal_id = $1`, [d]);
  return { d, sh, l };
}

test('签收必须写跟谁确认的; 电话进客户联系人, 不重复加', async () => {
  const t = await setup(); const { d, sh } = await shipped(t);
  const at = '2026-10-27T12:00:00Z';
  await rejects(t.as(U.hotline, `select app.sign_receipt($1,'s.jpg',$2,'',' 0701','staff')`, [sh, at]), /姓名/);
  // 0062 (409): 电话不再强制; 身份不限定三种, 但必须选
  await rejects(t.as(U.hotline, `select app.sign_receipt($1,'s.jpg',$2,'Awa','0701','')`, [sh, at]), /跟谁确认/);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg',$2,'Awa','07 01 02 03 04','staff')`, [sh, at]);
  const s = await t.one(`select confirm_name, confirm_phone, confirm_role, customer_received_at from app.shipments where id = $1`, [sh]);
  assert.equal(s.confirm_name, 'Awa'); assert.equal(s.confirm_phone, '0701020304'); assert.equal(s.confirm_role, 'staff');
  const c = await t.one(`select contacts from app.customers where id = $1`, [t.ids.camaraAbobo]);
  assert.equal(c.contacts.length, 1); assert.equal(c.contacts[0].phone, '0701020304');
  // 第二张单同一个店员 → 不重复加
  const d2 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]); await t.shipAll(d2);
  const sh2 = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d2]);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg',$2,'Awa','0701020304','staff')`, [sh2, at]);
  assert.equal((await t.one(`select contacts from app.customers where id = $1`, [t.ids.camaraAbobo])).contacts.length, 1);
  const ev = await t.one(`select detail from app.deal_events where deal_id = $1 and action = 'sign_confirmed_with'`, [d]);
  assert.equal(ev.detail.name, 'Awa');
});

test('退货: 签收 24 小时内的损坏正常批; 超过 24 小时要写破例原因', async () => {
  const t = await setup(); const { d, sh, l } = await shipped(t);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg','2026-10-27T12:00:00Z','Camara','0700000001','boss')`, [sh]);
  const ok = await t.val(U.hotline, `select app.request_return($1,'quality','屏幕不亮',$2,null,'2026-10-28T08:00:00Z','r.jpg')`, [d, JSON.stringify([{ line_id: l.id, qty: 1 }])]);
  assert.equal((await t.one(`select late from app.returns where id = $1`, [ok])).late, false);
  await t.as(U.admin, `select app.decide_return($1,true,null)`, [ok]);
  const late = await t.val(U.hotline, `select app.request_return($1,'logistics','破了',$2,null,'2026-10-29T13:00:00Z','r.jpg')`, [d, JSON.stringify([{ line_id: l.id, qty: 1 }])]);
  assert.equal((await t.one(`select late from app.returns where id = $1`, [late])).late, true);
  await rejects(t.as(U.admin, `select app.decide_return($1,true,null)`, [late]), /24 小时/);
  await rejects(t.as(U.admin, `select app.decide_return($1,true)`, [late]), /24 小时/);   // 老接口也拦
  await t.as(U.admin, `select app.decide_return($1,true,'老板出差，回来点货才发现')`, [late]);
  const r = await t.one(`select status, decide_note from app.returns where id = $1`, [late]);
  assert.equal(r.status, 'approved'); assert.match(r.decide_note, /出差/);
});

test('退货: 人为损坏一律要写破例原因; 驳回必须写原因; 「其他」不算 24 小时', async () => {
  const t = await setup(); const { d, sh, l } = await shipped(t);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg','2026-10-27T12:00:00Z','Camara','0700000001','boss')`, [sh]);
  const dmg = await t.val(U.hotline, `select app.request_return($1,'customer_damage','摔了',$2,null,'2026-10-27T15:00:00Z','r.jpg')`, [d, JSON.stringify([{ line_id: l.id, qty: 1 }])]);
  await rejects(t.as(U.admin, `select app.decide_return($1,true,'')`, [dmg]), /人为损坏/);
  await rejects(t.as(U.admin, `select app.decide_return($1,false,null)`, [dmg]), /驳回要写原因/);
  await t.as(U.admin, `select app.decide_return($1,false,'屏幕有裂痕，人为摔坏')`, [dmg]);
  assert.equal((await t.one(`select status from app.returns where id = $1`, [dmg])).status, 'rejected');
  const other = await t.val(U.hotline, `select app.request_return($1,'other','发错颜色',$2,null,'2026-11-05T15:00:00Z','r.jpg')`, [d, JSON.stringify([{ line_id: l.id, qty: 1 }])]);
  assert.equal((await t.one(`select late from app.returns where id = $1`, [other])).late, false);
  await t.as(U.admin, `select app.decide_return($1,true,null)`, [other]);
});

test('收货差异: 超过 24 小时才报的, 要认必须写破例原因', async () => {
  const t = await setup(); const { sh } = await shipped(t);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg',now() - interval '3 days','Camara','0700000001','boss')`, [sh]);
  const line = await t.one(`select deal_line_id from app.shipment_lines where shipment_id = $1`, [sh]);
  const id = await t.val(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg','少 2 片')`, [sh, JSON.stringify([{ deal_line_id: line.deal_line_id, received: 8 }])]);
  assert.equal((await t.one(`select late from app.receipt_discrepancies where id = $1`, [id])).late, true);
  await rejects(t.as(U.admin, `select app.decide_discrepancy($1,'credit','找货少数','in_warehouse','')`, [id]), /破例原因/);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','找货少数','in_warehouse','店员当天没点数，老板第三天点出来')`, [id]);
});
