// 0065: 复检数量不对必须当场处理 (放回 / 补上 / 少发), 每一笔留记录、记到找货人; 最终打包数 = 出库数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('复检: 多了要放回 + 拍照; 少了补上 + 拍照 → 最终数不变; 少发 → 退回客户确认; 记录算到找货人', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }, { product_id: t.ids.bg6mScreen, qty_req: 5 }, { product_id: t.ids.x6516, qty_req: 4 }], { review: false });
  const [a, b, c] = await t.lines(d);
  const R = t.ids.reviewer;
  const call = (lines) => t.val(U.manager, `select app.review_pick_fixed($1,$2,'pack.jpg',$3,'[]')`, [d, R, JSON.stringify(lines)]);
  await rejects(call([{ line_id: a.id, counted: 22, action: 'put_back' }]), /放回货架要拍照/);
  await rejects(call([{ line_id: a.id, counted: 22, action: 'refill', photo: 'x' }]), /放回货架/);
  await rejects(call([{ line_id: b.id, counted: 4 }]), /补上.*少发/);
  await rejects(call([{ line_id: b.id, counted: 4, action: 'refill' }]), /拍照/);
  await rejects(call([{ line_id: c.id, counted: 3, action: 'less' }]), /原因/);
  const st = await call([{ line_id: a.id, counted: 22, action: 'put_back', photo: 'back.jpg' }, { line_id: b.id, counted: 4, action: 'refill', photo: 'fill.jpg' }]);
  assert.equal(st, 'reviewed');
  const ls = await t.lines(d);
  assert.deepEqual(ls.map((l) => l.qty_supply), [20, 5, 4], '放回 / 补上之后最终打包数 = 该有的数');
  const fx = (await t.db.query(`select action, qty, final_qty, picker_employee_id, reviewer_employee_id from app.review_fixes where deal_id = $1 order by action`, [d])).rows;
  assert.equal(fx.length, 2); assert.equal(fx[0].action, 'put_back'); assert.equal(fx[0].qty, 2); assert.equal(fx[1].action, 'refill'); assert.equal(fx[1].final_qty, 5);
  assert.ok(fx[0].picker_employee_id, '记到找货人头上'); assert.equal(fx[0].reviewer_employee_id, R);
  const ck = (await t.db.query(`select result from app.pick_checks pc join app.deal_lines l on l.id = pc.deal_line_id where l.deal_id = $1`, [d])).rows;
  assert.equal(ck.filter((x) => x.result === 'qty_wrong').length, 2, '数量不对自动记一条找货出错');
});

test('复检少发: 这一行按实点数发, 单子退回等客户重新确认', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }], { review: false });
  const [a] = await t.lines(d);
  const st = await t.val(U.manager, `select app.review_pick_fixed($1,$2,'pack.jpg',$3,'[]')`, [d, t.ids.reviewer, JSON.stringify([{ line_id: a.id, counted: 18, action: 'less', reason: '货损' }])]);
  assert.equal(st, 'ordered');
  assert.equal((await t.lines(d))[0].qty_supply, 18);
  assert.equal((await t.one(`select final_qty from app.review_fixes where deal_id = $1`, [d])).final_qty, 18);
});
