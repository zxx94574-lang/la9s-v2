// 0093: 应收期初差异表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('期初差异: 粘金蝶应收 → 每客户 系统/金蝶/差; 系统有余额金蝶没有的也列; 调平要写原因, 只中方', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.one(`insert into app.ar_entries (org_id, customer_id, currency, kind, amount) values ($1,$2,'XOF','opening',500000)`, [org, t.ids.camaraAbobo]);
  await t.one(`insert into app.ar_entries (org_id, customer_id, currency, kind, amount) values ($1,$2,'XOF','opening',80000) returning id`, [org, t.ids.bigS]);
  await assert.rejects(t.as(U.picker, `select app.kd_opening_paste($1, current_date, '[]')`, [org]), /PERMISSION/);
  const n = await t.val(U.finance, `select app.kd_opening_paste($1, current_date, $2)`, [org, JSON.stringify([{ code: 'c001', amount: 450000 }, { code: 'C999', amount: 1000 }])]);
  assert.equal(n, 2);
  const rows = await t.as(U.admin, `select customer_code, customer_id is not null as known, sys_amount::numeric s, kd_amount::numeric k from app.kd_opening_diff order by customer_code`);
  const by = Object.fromEntries(rows.map((r) => [r.customer_code, r]));
  assert.equal(Number(by.C001.s), 500000); assert.equal(Number(by.C001.k), 450000);
  assert.equal(by.C999.known, false);
  assert.equal(Number(by.C003.s), 80000); assert.equal(Number(by.C003.k), 0);
  const id = (await t.one(`select id from app.kd_opening_diff where customer_code = 'C001'`)).id;
  await assert.rejects(t.as(U.finance, `select app.kd_opening_clear($1,'x')`, [id]), /PERMISSION/);
  await assert.rejects(t.as(U.admin, `select app.kd_opening_clear($1,'  ')`, [id]), /怎么调平/);
  await t.as(U.admin, `select app.kd_opening_clear($1,'金蝶补录了一张')`, [id]);
  // 再粘一次: 已调平的不动
  await t.val(U.finance, `select app.kd_opening_paste($1, current_date, $2)`, [org, JSON.stringify([{ code: 'C001', amount: 1 }])]);
  assert.ok((await t.one(`select cleared_at from app.kd_opening_diff where id = $1`, [id])).cleared_at);
  // 不影响客户 Balance
  assert.equal(await t.balance(t.ids.camaraAbobo), 500000);
});
