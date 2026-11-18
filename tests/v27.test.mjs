// 0057 (待改 345): 审批三种结果 —— 直接放行 / 先找货不出库 / 不找货先放着; 放行出库只中方
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const SALES = '00000000-0000-0000-0000-0000000000a9';

test('不找货先放着 → 还是等中方批; 先找货不出库 → 能走到复检但出不了库, 中方放行后能出; 直接放行照旧', async () => {
  const t = await setup();
  await t.as(U.admin, `insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,'{sales}')`, [SALES, t.ids.org, t.ids.sales]);
  const mk = () => t.val(SALES, `select app.create_inquiry($1,$2,$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 20, requested_price: 500 }])]);
  const b = await mk();
  assert.equal((await t.one(`select approval from app.deals where id=$1`, [b])).approval, 'pending');
  await rejects(t.as(U.manager, `select app.approve_quote_mode($1,'pass',null,'[]')`, [b]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.approve_quote_mode($1,'no_pick','','[]')`, [b]), /VALIDATION/);
  await t.as(U.admin, `select app.approve_quote_mode($1,'no_pick','等客户先把上一张付了','[]')`, [b]);
  const h = await t.one(`select approval, approval_hold_note from app.deals where id=$1`, [b]);
  assert.equal(h.approval, 'pending'); assert.equal(h.approval_hold_note, '等客户先把上一张付了');
  await rejects(t.as(U.hotline, `select app.hotline_confirm($1,'ok','phone')`, [b]), /中方先审批/);
  // 之后改成「先找货、不出库」
  await rejects(t.as(U.admin, `select app.approve_quote_mode($1,'pick_only',' ','[]')`, [b]), /VALIDATION/);
  await t.as(U.admin, `select app.approve_quote_mode($1,'pick_only','钱到了再发','[]')`, [b]);
  const p = await t.one(`select approval, ship_hold, approval_hold_note from app.deals where id=$1`, [b]);
  assert.equal(p.approval, 'approved'); assert.equal(p.ship_hold, true); assert.equal(p.approval_hold_note, null);
  await t.as(U.hotline, `select app.hotline_confirm($1,'ok','phone')`, [b]);
  await t.as(U.manager, `select app.start_picking($1)`, [b]);
  await t.as(U.picker, `select app.submit_pick($1,$2,'photo://pick.jpg','[]')`, [b, t.ids.picker]);
  await t.as(U.manager, `select app.create_sales_order($1,true)`, [b]);
  await t.as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','proof://ok.jpg')`, [b]);
  await t.as(U.manager, `select app.review_pick($1,$2,'photo://pack.jpg')`, [b, t.ids.reviewer]);
  await rejects(t.shipAll(b), /SHIP_HOLD/);
  await rejects(t.as(U.manager, `select app.set_ship_hold($1,false,'客户付了')`, [b]), /PERMISSION/);
  await t.as(U.admin, `select app.set_ship_hold($1,false,'客户付了')`, [b]);
  await t.shipAll(b);
  assert.equal(await t.status(b), 'shipped');
  // 直接放行
  const c = await mk();
  await t.as(U.admin, `select app.approve_quote_mode($1,'pass','老客户大单','[]')`, [c]);
  const pc = await t.one(`select approval, ship_hold from app.deals where id=$1`, [c]);
  assert.equal(pc.approval, 'approved'); assert.equal(pc.ship_hold, false);
});
