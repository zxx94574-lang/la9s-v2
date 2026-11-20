// 0074: 在途数量只给中方 + 国内采购; 询单无效 / 恢复; 询单下面几项
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('在途: 员工拿不到数字, 中方看得到; transit_peek 只中方 / 国内采购', async () => {
  const t = await setup();
  const a = await t.as(U.admin, `select transit from app.inquiry_catalog($1) limit 1`, [t.ids.org]);
  const h = await t.as(U.hotline, `select transit, avail from app.inquiry_catalog($1) limit 1`, [t.ids.org]);
  const A = (a.rows || a)[0]; const H = (h.rows || h)[0];
  assert.notEqual(A.transit, null); assert.equal(H.transit, null); assert.notEqual(H.avail, null);
  const pid = (await t.db.query(`select id from app.products where org_id = $1 limit 1`, [t.ids.org])).rows[0].id;
  await assert.rejects(t.as(U.hotline, `select * from app.transit_peek($1,$2)`, [t.ids.org, pid]), /PERMISSION/);
  await t.as(U.admin, `select * from app.transit_peek($1,$2)`, [t.ids.org, pid]);
});

test('询单: 无效只中方标、要原因、能恢复; 下面几项存得住', async () => {
  const t = await setup();
  const pid = (await t.db.query(`select id from app.products where org_id = $1 limit 1`, [t.ids.org])).rows[0].id;
  const cust = (await t.db.query(`select id from app.customers where org_id = $1 limit 1`, [t.ids.org])).rows[0].id;
  const id = await t.val(U.hotline, `select app.submit_inquiry($1,$2,$3,$4)`, [t.ids.org, cust, JSON.stringify([{ product_id: pid, qty: 5 }]), null]);
  await t.as(U.hotline, `select app.inquiry_extra($1,current_date + 1,'customer','no')`, [id]);
  await assert.rejects(t.as(U.hotline, `select app.inquiry_void($1,'invalid','测试')`, [id]), /PERMISSION/);
  await assert.rejects(t.as(U.admin, `select app.inquiry_void($1,'invalid','')`, [id]), /原因/);
  await t.as(U.admin, `select app.inquiry_void($1,'invalid','测试')`, [id]);
  let r = await t.one(`select status, invalid_reason, yango_pay from app.inquiries where id = $1`, [id]);
  assert.equal(r.status, 'invalid'); assert.equal(r.invalid_reason, '测试'); assert.equal(r.yango_pay, 'customer');
  await t.as(U.admin, `select app.inquiry_void($1,'restore')`, [id]);
  r = await t.one(`select status, invalid_reason from app.inquiries where id = $1`, [id]);
  assert.equal(r.status, 'new'); assert.equal(r.invalid_reason, null);
});
