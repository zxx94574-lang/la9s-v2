// 0077: 客户店里的收银 + 店里库存 (我们出库自动进他库存; 别家货按品质分; 收银一单就完; 中方能看)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const BOSS = '00000000-0000-0000-0000-0000000000b1', CLERK = '00000000-0000-0000-0000-0000000000c1';
test('店里收银: 出库自动进库存 → 别家货另算 → 卖 → 撤销; 店员不能改价; 中方看总览', async () => {
  const t = await setup();
  const corg = (await t.one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('customer','CAMARA','CI','XOF','CM') returning id`)).id;
  await t.db.query(`update app.customers set linked_org_id = $1 where id = $2`, [corg, t.ids.camaraAbobo]);
  await t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{boss}')`, [BOSS, corg]);
  const store = await t.val(U.admin, `select app.create_store($1,'Abobo 1','Abobo','Moussa')`, [t.ids.camaraAbobo]);
  const sorg = (await t.one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix,parent_id) values ('store','ABOBO 1','CI','XOF','A1',$1) returning id`, [corg])).id;
  await t.db.query(`update app.portal_stores set org_id = $1 where id = $2`, [sorg, store]);
  await t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{clerk}')`, [CLERK, sorg]);

  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 40 }]);
  await t.shipAll(d);
  let items = await t.as(BOSS, `select * from app.shop_items order by quality`);
  assert.equal(items.length, 1); assert.equal(items[0].quality, 'LA&9S'); assert.equal(items[0].qty, 40); assert.equal(items[0].model, 'BG6M');
  // 别家的货: 同型号不同品质 = 另一份库存
  await assert.rejects(t.as(CLERK, `select app.shop_stock_in('BG6M','电池盖','',10)`), /品质/);
  await t.as(CLERK, `select app.shop_stock_in('BG6M','电池盖','其他 · A 货',10,700)`);
  items = await t.as(BOSS, `select * from app.shop_items order by quality`);
  assert.equal(items.length, 2);
  const la = items.find((x) => x.quality === 'LA&9S');
  await assert.rejects(t.as(CLERK, `select app.shop_set_price($1,900)`, [la.id]), /老板/);
  await assert.rejects(t.as(CLERK, `select app.shop_sell($1,'cash')`, [JSON.stringify([{ item_id: la.id, qty: 2 }])]), /零售价/);
  await t.as(BOSS, `select app.shop_set_price($1,900)`, [la.id]);
  await assert.rejects(t.as(CLERK, `select app.shop_sell($1,'cash')`, [JSON.stringify([{ item_id: la.id, qty: 99 }])]), /库存只有/);
  const no = await t.val(CLERK, `select app.shop_sell($1,'cash')`, [JSON.stringify([{ item_id: la.id, qty: 3 }])]);
  assert.match(no, /^POS-/);
  assert.equal((await t.one(`select qty from app.shop_items where id = $1`, [la.id])).qty, 37);
  const sale = await t.one(`select id, total, buyer from app.shop_sales where sale_no = $1`, [no]);
  assert.equal(Number(sale.total), 2700); assert.equal(sale.buyer, null);
  // 我们的应收不受影响
  const bal = await t.balance(t.ids.camaraAbobo);
  await t.as(BOSS, `select app.shop_void_sale($1,'客人退回')`, [sale.id]);
  assert.equal((await t.one(`select qty from app.shop_items where id = $1`, [la.id])).qty, 40);
  assert.equal(await t.balance(t.ids.camaraAbobo), bal);
  // 我们撤销出库 → 他库存减回去
  const sh = await t.one(`select id from app.shipments where deal_id = $1`, [d]);
  await t.as(U.admin, `select app.void_shipment($1,'测试')`, [sh.id]);
  assert.equal((await t.one(`select qty from app.shop_items where id = $1`, [la.id])).qty, 0);
  // 中方总览; 别的客户 / 员工看不到店里数据
  const ov = await t.as(U.admin, `select * from app.customer_accounts_overview($1)`, [t.ids.org]);
  assert.equal(ov.length, 1); assert.equal(Number(ov[0].shop_pcs), 10);
  await assert.rejects(t.as(U.manager, `select * from app.customer_accounts_overview($1)`, [t.ids.org]), /PERMISSION/);
});
