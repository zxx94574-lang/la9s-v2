// 0069: 待录金蝶总表 + 单号回填 + 对账记录
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('待录金蝶总表: 出库单签收后待录 → 回填单号 = 已录; 对账记录存一份, 疑似的确认后自动回填', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  await t.shipAll(d);
  let rows = (await t.db.query(`select * from app.v_kingdee_all where org_id = $1`, [t.ids.org])).rows;
  const ob = rows.find((r) => r.kind === 'outbound');
  assert.ok(ob, '出库单进总表'); assert.equal(ob.qty, 20);
  await assert.rejects(t.val(U.picker, `select app.kingdee_fill($1,$2)`, [t.ids.org, JSON.stringify([{ kind: 'outbound', row_id: ob.row_id, no: 'XSCKD001' }])]));
  await assert.rejects(t.val(U.finance, `select app.kingdee_fill($1,$2)`, [t.ids.org, JSON.stringify([{ kind: 'outbound', row_id: ob.row_id, no: ' ' }])]), /单号要填/);
  const run = await t.val(U.admin, `select app.save_kd_recon($1,$2,$3)`, [t.ids.org, JSON.stringify([{ name: 'a.xlsx', type: 'outbound', rows: 3 }]),
    JSON.stringify([{ cat: 'suspect', doc_kind: 'outbound', kd_no: 'XSCKD009', sys_kind: 'outbound', sys_row: ob.row_id, sys_label: ob.label, deal_id: d, info: { why: '日期 + 客户 + 型号数量都一样' } },
      { cat: 'kd_only', doc_kind: 'outbound', kd_no: 'XSCKD010', info: {} }, { cat: 'ok', doc_kind: 'outbound', kd_no: 'XSCKD011' }])]);
  const c = (await t.one(`select counts from app.kd_recon_runs where id = $1`, [run])).counts;
  assert.equal(c.suspect, 1); assert.equal(c.kd_only, 1); assert.equal(c.ok, 1);
  const items = (await t.db.query(`select * from app.kd_recon_items where run_id = $1`, [run])).rows;
  const sus = items.find((i) => i.cat === 'suspect'); const ko = items.find((i) => i.cat === 'kd_only');
  await assert.rejects(t.as(U.admin, `select app.handle_kd_item($1,'',false)`, [ko.id]), /怎么回事/);
  await t.as(U.admin, `select app.handle_kd_item($1,'金蝶里录错客户，已让财务改',false)`, [ko.id]);
  await t.as(U.admin, `select app.handle_kd_item($1,null,true)`, [sus.id]);
  const k = await t.one(`select status, remote_no from app.kingdee_outbox where id = $1`, [ob.row_id]);
  assert.equal(k.remote_no, 'XSCKD009'); assert.equal(k.status, 'synced');
  rows = (await t.db.query(`select state, kd_no from app.v_kingdee_all where row_id = $1`, [ob.row_id])).rows;
  assert.equal(rows[0].state, 'done');
});
