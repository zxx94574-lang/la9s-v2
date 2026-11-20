// 0075: 游客询价必须留 姓名 / 电话 / 城市 / 等级; 转报价时按等级给系统默认档位 (最高 Retail), 未确认
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const G = `select app.guest_inquiry2($1,$2,$3,null) as v`;
test('游客询价: 四项缺一不可; 等级 → 默认档位, 批发店也只给 Retail, 未确认', async () => {
  const t = await setup();
  const pid = (await t.db.query(`select id from app.products where org_id = $1 limit 1`, [t.ids.org])).rows[0].id;
  const L = JSON.stringify([{ product_id: pid, qty: 3 }]);
  const base = { contact: 'Awa', phone: '+225 07 11 22 33 44', city: 'Daloa', level: 'WHOLESALE' };
  for (const [k, re] of [['contact', /姓名/], ['phone', /电话/], ['city', /城市/], ['level', /哪种店/]]) {
    await assert.rejects(t.db.query(G, [t.ids.org, JSON.stringify({ ...base, [k]: '' }), L]), re);
  }
  await assert.rejects(t.db.query(G, [t.ids.org, JSON.stringify(base), '[]']), /型号/);
  const no = (await t.db.query(G, [t.ids.org, JSON.stringify(base), L])).rows[0].v;
  const iq = (await t.one(`select id, guest_info from app.inquiries where iq_no = $1`, [no]));
  assert.equal(iq.guest_info.level, 'WHOLESALE');
  const d = await t.val(U.admin, `select app.inquiry_convert($1)`, [iq.id]);
  const c = await t.one(`select c.tier, c.tier_confirmed_at, c.shop_type, c.tier_note from app.customers c join app.deals d on d.customer_id = c.id where d.id = $1`, [d]);
  assert.equal(c.tier, 'RETAIL'); assert.equal(c.tier_confirmed_at, null); assert.equal(c.shop_type, 'WHOLESALE'); assert.match(c.tier_note, /系统默认/);

  const no2 = (await t.db.query(G, [t.ids.org, JSON.stringify({ ...base, phone: '+225 05 99 88 77 66', level: 'repair' }), L])).rows[0].v;
  const iq2 = (await t.one(`select id from app.inquiries where iq_no = $1`, [no2])).id;
  const d2 = await t.val(U.admin, `select app.inquiry_convert($1)`, [iq2]);
  assert.equal((await t.one(`select c.tier from app.customers c join app.deals d on d.customer_id = c.id where d.id = $1`, [d2])).tier, 'REPAIR');
});
