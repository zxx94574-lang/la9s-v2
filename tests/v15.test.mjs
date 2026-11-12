// 0042: 拆单
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('拆单: 勾的行去新单、价格锁住、两张单各走各的流程', async () => {
  const t = await setup();
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5 }, { product_id: t.ids.bg6mScreen, qty_req: 3 }])]);
  await t.as(U.hotline, `select app.quote_confirm($1,'ok','whatsapp',null,null,false)`, [d]);
  const lines = (await t.db.query(`select id, product_id, unit_price from app.deal_lines where deal_id = $1 order by seq`, [d])).rows;
  await rejects(t.as(U.hotline, `select app.split_deal($1,'{}'::uuid[],null,null)`, [d]), /先勾选/);
  await rejects(t.as(U.hotline, `select app.split_deal($1,$2::uuid[],null,null)`, [d, `{${lines.map((l) => l.id).join(',')}}`]), /至少留一行/);
  await rejects(t.as(U.picker, `select app.split_deal($1,$2::uuid[],null,null)`, [d, `{${lines[1].id}}`]), /PERMISSION/);
  const n = await t.val(U.hotline, `select app.split_deal($1,$2::uuid[],(current_date + 3),'屏以后再发')`, [d, `{${lines[1].id}}`]);
  const nd = await t.one(`select biz_no, quote_no, status, split_from, want_on, customer_id, hotline_method from app.deals where id = $1`, [n]);
  assert.equal(nd.split_from, d); assert.equal(nd.status, 'hotline_ok'); assert.equal(nd.hotline_method, 'whatsapp'); assert.ok(nd.want_on);
  assert.notEqual(nd.biz_no, await t.val(U.admin, `select biz_no from app.deals where id = $1`, [d]));
  assert.equal(Number(await t.val(U.admin, `select count(*) from app.deal_lines where deal_id = $1`, [d])), 1);
  const moved = await t.one(`select deal_id, seq, price_locked, unit_price from app.deal_lines where id = $1`, [lines[1].id]);
  assert.equal(moved.deal_id, n); assert.equal(moved.seq, 1); assert.equal(moved.price_locked, true);
  // 锁价: 系统 / 员工改不了, 中方可以
  await t.db.query(`update app.deal_lines set unit_price = unit_price + 500 where id = $1`, [lines[1].id]);
  assert.equal(Number(await t.val(U.admin, `select unit_price from app.deal_lines where id = $1`, [lines[1].id])), Number(lines[1].unit_price));
  // 两张单各自下推
  await t.as(U.hotline, `select app.start_picking($1)`, [d]); await t.as(U.hotline, `select app.start_picking($1)`, [n]);
  assert.equal(await t.val(U.admin, `select status from app.deals where id = $1`, [n]), 'picking');
  await rejects(t.as(U.hotline, `select app.split_deal($1,$2::uuid[],null,null)`, [n, `{${lines[1].id}}`]), /BAD_STATE/);
});

test('只发一部分: 原因必填、记在这批出库单上', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  await rejects(t.as(U.manager, `select app.set_partial_reason($1,' ')`, [sh]), /原因/);
  await t.as(U.manager, `select app.set_partial_reason($1,'车装不下')`, [sh]);
  assert.equal(await t.val(U.admin, `select partial_reason from app.shipments where id = $1`, [sh]), '车装不下');
});
