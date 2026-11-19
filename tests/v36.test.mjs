// 0066: 询单 (游客 / 客户账号 / 销售) → 中方转报价 → 跟着订单走; 销售只能动自己名下客户的单; 移交客户
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const SALES = '00000000-0000-0000-0000-0000000000a1';
const addSales = (t) => t.db.query(`insert into app.members (user_id, org_id, roles, employee_id) values ($1,$2,'{sales}',$3)`, [SALES, t.ids.org, t.ids.sales]);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('销售建询单 (只自己名下) → 中方转报价 (自动带档位价, 可改) → 销售自己确认客户 + 下推找货 → 询单变已转订单', async () => {
  const t = await setup();
  await addSales(t);
  const L = JSON.stringify([{ product_id: t.ids.bg6mCover, qty: 10 }, { category_id: t.ids.catScreen, model: 'spark 30', grade: 'HD', qty: 5 }]);
  const iq = await t.val(SALES, `select app.submit_inquiry($1,$2,$3,'客户明天要')`, [t.ids.org, t.ids.camaraAbobo, L]);
  const row = await t.one(`select * from app.inquiries where id = $1`, [iq]);
  assert.match(row.iq_no, /^IQ-\d{6}-01$/); assert.equal(row.status, 'new'); assert.equal(row.source, 'staff');
  // 别人名下的客户: 销售接不了
  const other = (await t.one(`insert into app.employees (org_id, short_name) values ($1,'Awa') returning id`, [t.ids.org])).id;
  const c2 = (await t.one(`insert into app.customers (org_id, code, name, city, tier, status, owner_employee_id) values ($1,'C077','AUTRE','Abobo','RETAIL','active',$2) returning id`, [t.ids.org, other])).id;
  await rejects(t.as(SALES, `select app.submit_inquiry($1,$2,$3)`, [t.ids.org, c2, L]), /不在你名下/);
  await rejects(t.as(SALES, `select app.inquiry_convert($1)`, [iq]), /PERMISSION/);
  const d = await t.val(U.admin, `select app.inquiry_convert($1,$2)`, [iq, JSON.stringify([{ idx: 0, price: 520, note: '老客户' }])]);
  const ls = await t.lines(d);
  assert.equal(Number(ls[0].unit_price), 520, '中方给的价'); assert.equal(ls[0].price_manual, true); assert.equal(ls[1].req_model, 'SPARK 30 HD');
  assert.equal((await t.one(`select status, deal_id from app.inquiries where id = $1`, [iq])).status, 'quoted');
  // 销售对自己名下的客户: 确认客户 + 下推找货
  await t.as(U.admin, `select app.approve_quote($1,true,'ok',null)`, [d]).catch(() => {});
  await t.as(SALES, `select app.quote_confirm($1,'ok','whatsapp',null,null,true)`, [d]);
  assert.equal(await t.status(d), 'picking');
  assert.equal((await t.one(`select status from app.inquiries where id = $1`, [iq])).status, 'converted');
  // 别人名下客户的单: 销售动不了
  const d2 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, c2, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 3 }])]);
  await rejects(t.as(SALES, `select app.quote_confirm($1,'ok','whatsapp',null,null,true)`, [d2]), /不在你名下/);
});

test('游客询单: 不建客户不建单; 转报价时才建潜客; 没成交要原因; 订单作废 → 询单没成交', async () => {
  const t = await setup();
  const n0 = Number((await t.one(`select count(*) n from app.customers`)).n);
  const no = (await t.db.query(`select app.guest_inquiry2($1,$2,$3,null) as v`, [t.ids.org, JSON.stringify({ phone: '+225 07 88 77 66 55', contact: 'Moussa', shop: 'Moussa Phone', city: 'Bouaké' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 4 }])])).rows[0].v;
  assert.match(no, /^IQ-/);
  assert.equal(Number((await t.one(`select count(*) n from app.customers`)).n), n0, '游客询单不建客户');
  const iq = (await t.one(`select id from app.inquiries where iq_no = $1`, [no])).id;
  await rejects(t.as(U.hotline, `select app.inquiry_mark($1,'lost','')`, [iq]), /原因/);
  await t.as(U.hotline, `select app.inquiry_mark($1,'contacted')`, [iq]);
  const d = await t.val(U.admin, `select app.inquiry_convert($1)`, [iq]);
  const c = await t.one(`select c.status, c.phone, c.contact_name from app.customers c join app.deals d on d.customer_id = c.id where d.id = $1`, [d]);
  assert.equal(c.status, 'prospect'); assert.equal(c.contact_name, 'Moussa');
  await t.as(U.manager, `select app.cancel_deal($1,'客户不要了')`, [d]);
  const q = await t.one(`select status, lost_reason from app.inquiries where id = $1`, [iq]);
  assert.equal(q.status, 'lost');
});

test('询单的货: 员工看具体片数不看价; 游客只看 有货 / 少量 / 可预订', async () => {
  const t = await setup(); await addSales(t);
  const staff = await t.as(SALES, `select * from app.inquiry_catalog($1) where id = $2`, [t.ids.org, t.ids.bg6mCover]);
  assert.equal(staff[0].avail, 500); assert.equal(staff[0].price, null);
  const guest = (await t.db.query(`select * from app.inquiry_catalog($1) where id = $2`, [t.ids.org, t.ids.bg6mCover])).rows;
  assert.equal(guest[0].avail, null); assert.equal(guest[0].band, 'ok'); assert.equal(guest[0].price, null);
});

test('移交客户: 一键全部移交 + 归属历史; 只中方', async () => {
  const t = await setup();
  const to = (await t.one(`insert into app.employees (org_id, short_name) values ($1,'Awa') returning id`, [t.ids.org])).id;
  await rejects(t.as(U.manager, `select app.transfer_customers($1,$2,$3)`, [t.ids.org, t.ids.sales, to]), /PERMISSION/);
  const n = await t.val(U.admin, `select app.transfer_customers($1,$2,$3,null,'Koffi 离职')`, [t.ids.org, t.ids.sales, to]);
  assert.ok(n >= 1);
  assert.equal((await t.one(`select owner_employee_id from app.customers where id = $1`, [t.ids.camaraAbobo])).owner_employee_id, to);
  const log = await t.one(`select from_employee_id, to_employee_id, note from app.customer_owner_log where customer_id = $1`, [t.ids.camaraAbobo]);
  assert.equal(log.from_employee_id, t.ids.sales); assert.equal(log.note, 'Koffi 离职');
});
