// 0058 (待改 334): 销售提成 —— 按片, 整单付清才算, 只算有归属销售员的客户, FOB 不算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const today = new Date().toISOString().slice(0, 10);

test('销售提成: 没付清不算; 付清才算; 没归属销售员不算; FOB 不算; 每片金额读设置; 员工看不到', async () => {
  const t = await setup();
  await t.db.query(`update app.customers set owner_employee_id = $1 where id = $2`, [t.ids.sales, t.ids.camaraAbobo]);
  const pay = (amt) => t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: t.ids.camaraAbobo, received_on: today, currency: 'XOF', method: 'cash', mode: 'oldest', proof: 'x.jpg', amount_landed: amt })]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  assert.equal((await t.one(`select owner_employee_id from app.deals where id = $1`, [d])).owner_employee_id, t.ids.sales);
  const due = await t.due(d);
  await rejects(t.as(U.manager, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today]), /PERMISSION/);
  assert.equal((await t.as(U.admin, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today])).length, 0);
  await pay(due - 100);
  assert.equal((await t.as(U.admin, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today])).length, 0, '差 100 没付清，不算');
  await pay(100);
  await t.db.query(`insert into app.org_settings (org_id, key, value) values ($1,'sales_comm','{"per_piece":20}') on conflict (org_id, key) do update set value = excluded.value`, [t.ids.org]);
  const r = await t.as(U.admin, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today]);
  assert.equal(r.length, 1); assert.equal(r[0].employee_id, t.ids.sales); assert.equal(r[0].pieces, 10); assert.equal(Number(r[0].amount), 200);
  // FOB 客户不算
  await t.db.query(`update app.customers set supply = 'fob' where id = $1`, [t.ids.camaraAbobo]);
  assert.equal((await t.as(U.admin, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today])).length, 0);
  await t.db.query(`update app.customers set supply = 'local' where id = $1`, [t.ids.camaraAbobo]);
  // 订单上没有归属销售员不算
  await t.db.query(`update app.deals set owner_employee_id = null where id = $1`, [d]);
  assert.equal((await t.as(U.admin, `select * from app.sales_commission($1,$2,$2)`, [t.ids.org, today])).length, 0);
});
