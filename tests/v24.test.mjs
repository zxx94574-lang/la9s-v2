// 0053 (待改 357): 整单折扣 —— 摊进单价、向上取整、零头出库时自动抹掉, 应收正好 = 谈好的总价
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('整单折扣: 只中方、要原因; 单价按比例向上取整; 出库后应收正好等于谈好的总价; 账对得上', async () => {
  const t = await setup();
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 7 }, { product_id: t.ids.bg6mScreen, qty_req: 3 }])]);
  const before = await t.lines(d); const total = before.reduce((a, l) => a + Number(l.qty_req) * Number(l.unit_price), 0);
  const target = total - 1000 - 3;   // 故意谈一个除不尽的数
  await rejects(t.as(U.manager, `select app.apply_deal_discount($1,$2,'老客户')`, [d, target]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.apply_deal_discount($1,$2,' ')`, [d, target]), /VALIDATION/);
  await rejects(t.as(U.admin, `select app.apply_deal_discount($1,$2,'x')`, [d, total + 1]), /VALIDATION/);
  const r = await t.val(U.admin, `select app.apply_deal_discount($1,$2,'老客户，谈好的总价')`, [d, target]);
  assert.equal(Number(r.target), target); assert.ok(Number(r.round) >= 0 && Number(r.round) < 10);
  const after = await t.lines(d);
  after.forEach((l, i) => { assert.ok(Number(l.unit_price) < Number(before[i].unit_price)); assert.equal(Number(l.unit_price) % 1, 0); assert.equal(Number(l.pre_discount_price), Number(before[i].unit_price)); });
  await rejects(t.as(U.admin, `select app.apply_deal_discount($1,$2,'再打一次')`, [d, target - 100]), /已经打过/);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  await t.as(U.picker, `select app.submit_pick($1,$2,'photo://pick.jpg','[]')`, [d, t.ids.picker]);
  await t.as(U.manager, `select app.create_sales_order($1,true)`, [d]);
  await t.as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','proof://ok.jpg')`, [d]);
  await t.as(U.manager, `select app.review_pick($1,$2,'photo://pack.jpg')`, [d, t.ids.reviewer]);
  await t.shipAll(d);
  assert.equal(await t.due(d), target);
  assert.equal(await t.balance(t.ids.camaraAbobo), target);
  assert.equal((await t.as(U.admin, `select * from app.ledger_check($1)`, [t.ids.org])).length, 0);
});

test('撤销整单折扣: 单价回到折扣前; 出库后不能再打 / 撤', async () => {
  const t = await setup();
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 10 }])]);
  const p0 = Number((await t.lines(d))[0].unit_price);
  await t.as(U.admin, `select app.apply_deal_discount($1,$2,'试')`, [d, p0 * 10 - 500]);
  await rejects(t.as(U.admin, `select app.undo_deal_discount($1,'')`, [d]), /VALIDATION/);
  await t.as(U.admin, `select app.undo_deal_discount($1,'客户不要折扣了')`, [d]);
  assert.equal(Number((await t.lines(d))[0].unit_price), p0);
  assert.equal((await t.one(`select discount_amount from app.deals where id = $1`, [d])).discount_amount, null);
  const s = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]); await t.shipAll(s);
  await rejects(t.as(U.admin, `select app.apply_deal_discount($1,500,'晚了')`, [s]), /BAD_STATE|VALIDATION/);
});
