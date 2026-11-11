// 0038: 紧急标记、暂存位置、报价阶段就记缺口
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('中方才能标紧急; 暂存位置要照片、只在客户确认后', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }], { review: false });
  await rejects(t.as(U.hotline, `select app.set_deal_urgent($1,true)`, [d]), /PERMISSION|FORBIDDEN/);
  await t.as(U.admin, `select app.set_deal_urgent($1,true)`, [d]);
  assert.equal(await t.val(U.admin, `select urgent from app.deals where id = $1`, [d]), true);
  await rejects(t.as(U.manager, `select app.mark_staged($1,'',null)`, [d]), /照片/);
  await t.as(U.manager, `select app.mark_staged($1,'s.jpg','门口第二排')`, [d]);
  assert.ok(await t.val(U.admin, `select staged_at from app.deals where id = $1`, [d]));
});

test('报价阶段: 客户要的比可售多 → 缺口马上进未满足需求', async () => {
  const t = await setup();
  const avail = Number(await t.val(U.admin, `select coalesce(sum(s.qty_on_hand - s.qty_reserved),0) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = $1 and w.kind = 'local'`, [t.ids.bg6mCover]));
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: avail + 960 }])]);
  const un = Number(await t.val(U.admin, `select coalesce(sum(qty_unmet),0) from app.v_unmet_demand where deal_id = $1`, [d]));
  assert.equal(un, 960);
});
