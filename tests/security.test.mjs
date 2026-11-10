// RLS + grants as the real client role (authenticated), not superuser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('客户端角色：只能读本组织数据；不能直接改表；不能调用内部库存函数', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`,
    [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 5 }])]);
  const client = async (uid, sql, p = []) => {
    await t.db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
    await t.db.exec('set role authenticated');
    try { return (await t.db.query(sql, p)).rows; } finally { await t.db.exec('reset role'); }
  };
  assert.equal((await client(U.manager, `select id from app.deals`)).length, 1);
  assert.equal((await client(U.outsider, `select id from app.deals`)).length, 0, '别的组织看不到');
  assert.equal((await client(U.outsider, `select * from app.v_stock`)).length, 0);
  assert.equal((await client(U.picker, `select * from app.ar_entries`)).length, 0);
  assert.equal((await client(U.picker, `select * from app.product_prices`)).length, 0, '找货员看不到价格');
  await assert.rejects(client(U.admin, `update app.stock_items set qty_on_hand = 9999`), /permission denied/);
  await assert.rejects(client(U.admin, `select app.move_stock($1, 999, 'hack', null, null)`, [t.ids.stLA_bg6m]), /permission denied/);
  await assert.rejects(client(U.admin, `select app.reserve($1, -5)`, [t.ids.stLA_bg6m]), /permission denied/);
  const r = await client(U.manager, `select app.start_picking($1)`, [deal]);
  assert.ok(r, '业务函数可正常调用');
  assert.equal((await client(U.manager, `select qty_reserved from app.stock_items where id=$1`, [t.ids.stLA_bg6m]))[0].qty_reserved, 5);
});
