// 0009 客户档案 · 热线回访 · 销售拜访 · 欠款预警 · 回收客户导入 (Frank 2026-10-29)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('潜客：热线建档自动给临时编码；电话重复挡住；拜访必须拍门店照；中方转正式', async () => {
  const t = await setup();
  const id = await t.val(U.hotline, `select app.create_prospect($1,'boutique ali','07 07 12 34 56','Yopougon','{"market":"Siporex"}')`, [t.ids.org]);
  const c = await t.one(`select * from app.customers where id=$1`, [id]);
  assert.equal(c.name, 'BOUTIQUE ALI'); assert.equal(c.status, 'prospect'); assert.match(c.temp_code, /^T-/); assert.equal(c.market, 'Siporex');
  await rejects(t.as(U.hotline, `select app.create_prospect($1,'x','0707123456','Abobo')`, [t.ids.org]), /CONFLICT/);
  await rejects(t.as(U.picker, `select app.create_prospect($1,'y','0102030405','Abobo')`, [t.ids.org]), /PERMISSION_DENIED/);

  await rejects(t.as(U.manager, `select app.log_visit($1,'interested','{}')`, [id]), /门店照片/);
  await t.as(U.manager, `select app.log_visit($1,'interested',$2)`, [id, JSON.stringify({ photo: 'shop.jpg', monthly_qty: '300', buys_from: 'Adjamé', next_follow_on: '2026-11-05' })]);
  const c2 = await t.one(`select shop_photo, monthly_qty from app.customers where id=$1`, [id]);
  assert.equal(c2.shop_photo, 'shop.jpg'); assert.equal(c2.monthly_qty, 300);

  await rejects(t.as(U.manager, `select app.activate_customer($1,'C900','RETAIL')`, [id]), /PERMISSION_DENIED/);
  await rejects(t.as(U.admin, `select app.activate_customer($1,'C001','RETAIL')`, [id]), /编码已被占用/);
  await t.as(U.admin, `select app.activate_customer($1,'c900','RETAIL')`, [id]);
  const c3 = await t.one(`select code, tier, status from app.customers where id=$1`, [id]);
  assert.deepEqual([c3.code, c3.tier, c3.status], ['C900', 'RETAIL', 'active']);
});

test('热线回访：记录结果和下次跟进；仓库不能记', async () => {
  const t = await setup();
  await t.as(U.hotline, `select app.log_call($1,'spare','call','no_answer',null,'2026-11-01')`, [t.ids.camaraAbobo]);
  await t.as(U.hotline, `select app.log_call($1,'recycle','whatsapp','later','下周有货',null)`, [t.ids.camaraAbobo]);
  await rejects(t.as(U.hotline, `select app.log_call($1,'spare','call','xx',null,null)`, [t.ids.camaraAbobo]), /check|violates/);
  await rejects(t.as(U.picker, `select app.log_call($1,'spare','call','busy',null,null)`, [t.ids.camaraAbobo]), /PERMISSION_DENIED/);
  assert.equal(Number((await t.one(`select count(*) n from app.hotline_calls where customer_id=$1`, [t.ids.camaraAbobo])).n), 2);
});

test('欠款预警：超上限 / 超账期只提醒；只有中方能设上限和协议', async () => {
  const t = await setup();
  await rejects(t.as(U.manager, `select app.set_customer_terms($1,100000,30,false,null)`, [t.ids.camaraAbobo]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_customer_terms($1,1000,30,true,$2)`, [t.ids.camaraAbobo, t.ids.sales]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  const w = await t.one(`select * from app.v_customer_credit where customer_id=$1`, [t.ids.camaraAbobo]);
  assert.equal(w.over_limit, true, '5500 > 1000');
  assert.equal(w.has_agreement, true);
  assert.equal(w.over_days, false);
});

test('导入客户：备件带编码档位直接正式；回收客户无档位成潜客；同电话合并为 both；中方专属', async () => {
  const t = await setup();
  const rows = [
    { code: 'C500', name: 'Kone', phone: '0505050505', tier: 'S', city: 'Adjamé' },
    { name: 'Recup Yao', phone: '0101010101', kind: 'recycle', recycle_type: 'Recycleurs', interested: true },
    { name: 'Kone shop', phone: '05 05 05 05 05', kind: 'recycle' },
    { name: '' },
  ];
  await rejects(t.as(U.manager, `select app.import_customers($1,$2)`, [t.ids.org, JSON.stringify(rows)]), /PERMISSION_DENIED/);
  const r = await t.val(U.admin, `select app.import_customers($1,$2)`, [t.ids.org, JSON.stringify(rows)]);
  assert.deepEqual(r, { new: 2, updated: 1, skipped: 1 });
  assert.equal((await t.one(`select kind, status from app.customers where code='C500'`)).kind, 'both');
  const y = await t.one(`select status, kind, temp_code, recycle_type from app.customers where name='RECUP YAO'`);
  assert.equal(y.status, 'prospect'); assert.equal(y.kind, 'recycle'); assert.match(y.temp_code, /^T-/);
});
