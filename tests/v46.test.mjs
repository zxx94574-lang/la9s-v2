// 0078: 想要 (有效期) → 到货问「还要吗」→ 中方分配 → 热线电话名单; 兑现率; 缺口自动变想要
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('想要: 登记 / 过期 / 还要吗 / 分配 / 兑现率', async () => {
  const t = await setup();
  await t.db.query(`insert into app.employees (org_id, short_name) values ($1,'热线员') returning id`, [t.ids.org]);
  await t.db.query(`update app.members set employee_id = (select id from app.employees where short_name = '热线员') where user_id = $1`, [U.hotline]);
  await assert.rejects(t.as(U.picker, `select app.add_want($1,$2,null,50)`, [t.ids.camaraAbobo, t.ids.x6516]), /PERMISSION/);
  const a = await t.val(U.hotline, `select app.add_want($1,$2,null,50,'等到货')`, [t.ids.camaraAbobo, t.ids.x6516]);
  const b = await t.val(U.hotline, `select app.add_want($1,$2,null,30)`, [t.ids.camaraOme, t.ids.x6516]);
  const old = await t.val(U.hotline, `select app.add_want($1,null,'SPARK 99',10)`, [t.ids.bigS]);
  await t.db.query(`update app.wants set expires_on = current_date - 1 where id = $1`, [old]);
  await t.as(U.hotline, `select app.sync_wants($1)`, [t.ids.org]);
  assert.equal((await t.one(`select status from app.wants where id = $1`, [old])).status, 'expired');
  await assert.rejects(t.as(U.hotline, `select app.want_check($1,'no')`, [b]), /为什么/);
  await t.as(U.hotline, `select app.want_check($1,'yes')`, [a]);
  await t.as(U.hotline, `select app.want_check($1,'no','找别人买了')`, [b]);
  await assert.rejects(t.as(U.admin, `select app.allocate_wants($1,$2)`, [t.ids.org, JSON.stringify([{ want_id: b, qty: 10 }])]), /BAD_STATE|处理过|确认/);
  const list = await t.val(U.admin, `select app.allocate_wants($1,$2)`, [t.ids.org, JSON.stringify([{ want_id: a, qty: 40 }])]);
  const rows = (await t.db.query(`select note from app.call_list_rows where list_id = $1`, [list])).rows;
  assert.equal(rows.length, 1); assert.match(rows[0].note, /留了 40/);
  const cv = await t.one(`select rate from app.v_want_conversion where customer_id = $1`, [t.ids.camaraOme]);
  assert.equal(Number(cv.rate), 0);
  assert.equal((await t.db.query(`select * from app.v_want_lost`)).rows.length, 1);
});

test('下单时没供够 → 自动变成想要', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mScreen, qty_req: 500 }], { review: false });
  await t.as(U.hotline, `select app.sync_wants($1)`, [t.ids.org]);
  const w = await t.one(`select qty, source from app.wants where customer_id = $1`, [t.ids.camaraAbobo]);
  assert.equal(w.source, 'order_short'); assert.ok(w.qty > 0);
  void d;
});
