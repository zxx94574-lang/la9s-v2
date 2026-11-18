// 0051 (Frank 11-17 待改 344): 亏钱事前拦 —— 卖价低于到岸成本的单不能往下推 / 不能出库, 中方批 + 写原因才放行; 事后亏的单中方必须下结论
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

async function costly(t) {
  await t.db.query(`insert into app.price_settings (org_id, rmb_per_xof, round_to) values ($1, 0.01, 100) on conflict (org_id) do update set rmb_per_xof = 0.01, round_to = 100`, [t.ids.org]);
  // 电池盖批发价 550; 成本 9 元 → 900 + 50 → 进到 1,000 → 卖一片亏 450
  await t.db.query(`update app.products set rmb_cost = 9, freight_xof = 50 where id = $1`, [t.ids.bg6mCover]);
}

test('卖价低于成本: 推不下去; 员工批不了; 中方不写原因批不了; 批了才能走; 之后能出库', async () => {
  const t = await setup(); await costly(t);
  await rejects(t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]), /LOSS_BLOCK/);
  const d = (await t.one(`select id from app.deals order by created_at desc limit 1`)).id;
  assert.equal(await t.status(d), 'quoted');
  const st = await t.val(U.hotline, `select app.deal_loss_state($1)`, [d]);
  assert.equal(st.blocked, true); assert.equal(st.lines.length, 1);
  assert.equal(JSON.stringify(st).includes('1000'), false);   // 员工拿到的状态里没有成本数字
  await rejects(t.as(U.manager, `select app.approve_loss($1,'客户老关系','other')`, [d]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.approve_loss($1,'  ','other')`, [d]), /VALIDATION/);
  await t.as(U.admin, `select app.approve_loss($1,'清老库存，11 月清仓决定','clearance')`, [d]);
  const st2 = await t.val(U.hotline, `select app.deal_loss_state($1)`, [d]);
  assert.equal(st2.blocked, false); assert.equal(st2.approved, true);
});

test('批过以后再把价格改得更低 → 要重新批; 没亏的单不受影响; 开关关掉就不拦', async () => {
  const t = await setup(); await costly(t);
  const ok = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mScreen, qty_req: 2 }]);
  assert.equal(await t.status(ok), 'reviewed');
  await rejects(t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]), /LOSS_BLOCK/);
  const d = (await t.one(`select id from app.deals order by created_at desc limit 1`)).id;
  await t.as(U.admin, `select app.approve_loss($1,'清仓','clearance')`, [d]);
  await t.db.query(`update app.deal_lines set unit_price = 400 where deal_id = $1`, [d]);
  assert.equal((await t.val(U.admin, `select app.deal_loss_state($1)`, [d])).blocked, true);
  await rejects(t.db.query(`update app.deals set status = 'hotline_ok' where id = $1`, [d]), /LOSS_BLOCK/);
  await t.db.query(`insert into app.org_settings (org_id, key, value) values ($1,'loss_rules','{"on":false}') on conflict (org_id, key) do update set value = excluded.value`, [t.ids.org]);
  await t.db.query(`update app.deals set status = 'hotline_ok' where id = $1`, [d]);
  assert.equal(await t.status(d), 'hotline_ok');
});

test('事后: 亏了的已出库单进中方清单, 必须选结论 + 写原因才能关; 员工看不到', async () => {
  const t = await setup(); await costly(t);
  await t.db.query(`insert into app.org_settings (org_id, key, value) values ($1,'loss_rules','{"on":false}') on conflict (org_id, key) do update set value = excluded.value`, [t.ids.org]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  await rejects(t.as(U.manager, `select * from app.loss_deals($1)`, [t.ids.org]), /PERMISSION/);
  const r = await t.as(U.admin, `select * from app.loss_deals($1)`, [t.ids.org]);
  assert.equal(r.length, 1); assert.equal(r[0].deal_id, d); assert.equal(Number(r[0].profit), -4500);
  await rejects(t.as(U.admin, `select app.close_loss_review($1,'','x')`, [d]), /VALIDATION/);
  await rejects(t.as(U.admin, `select app.close_loss_review($1,'成本录错','')`, [d]), /VALIDATION/);
  await t.as(U.admin, `select app.close_loss_review($1,'清仓','11 月清仓决定，以后清仓走清仓价表')`, [d]);
  assert.equal((await t.as(U.admin, `select * from app.loss_deals($1)`, [t.ids.org])).length, 0);
});

test('清仓价表: 有生效的清仓价且卖价不低于它 → 不拦; 低于清仓价 / 过期 / 不适用这个档位 → 照拦; 员工设不了', async () => {
  const t = await setup(); await costly(t);
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await rejects(t.as(U.manager, `select app.set_clearance($1,$2,500,$3,$4,null,null,'清老库存')`, [t.ids.org, t.ids.bg6mCover, day(0), day(7)]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.set_clearance($1,$2,500,$3,$4,null,null,' ')`, [t.ids.org, t.ids.bg6mCover, day(0), day(7)]), /VALIDATION/);
  // 只给 S 档: 批发客户 (550) 不适用 → 照拦
  const c1 = await t.val(U.admin, `select app.set_clearance($1,$2,500,$3,$4,array['S'],null,'只给 S')`, [t.ids.org, t.ids.bg6mCover, day(0), day(7)]);
  await rejects(t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 3 }]), /LOSS_BLOCK/);
  await t.as(U.admin, `select app.end_clearance($1)`, [c1]);
  // 所有客户、清仓价 500 ≤ 卖价 550 → 放行
  await t.as(U.admin, `select app.set_clearance($1,$2,500,$3,$4,null,null,'11 月清仓决定')`, [t.ids.org, t.ids.bg6mCover, day(0), day(7)]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 3 }]);
  assert.equal(await t.status(d), 'reviewed');
  // 卖得比清仓价还低 → 拦
  await t.db.query(`update app.deal_lines set unit_price = 400 where deal_id = $1`, [d]);
  assert.equal((await t.val(U.admin, `select app.deal_loss_state($1)`, [d])).blocked, true);
  // 过期的不算
  await t.db.query(`update app.deal_lines set unit_price = 550 where deal_id = $1`, [d]);
  await t.db.query(`update app.clearance_prices set starts_on = current_date - 10, ends_on = current_date - 1 where ended_at is null`);
  assert.equal((await t.val(U.admin, `select app.deal_loss_state($1)`, [d])).blocked, true);
});
