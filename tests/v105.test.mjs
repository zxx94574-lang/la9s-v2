// 0105 (11-27 自查): FOB 没编码的行挂编码; FOB 收款进资金账户 + 必须有凭证
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('FOB: 没编码的行挂上编码后能入库; 收款要账户 + 凭证, 并进资金账户', async () => {
  const t = await setup();
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const f = await t.val(U.hotline, `select app.create_fob($1,$2,'CI','warehouse','XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([{ product_id: t.ids.x6516, qty: 100 }, { model: 'spark 30', qty: 50 }])]);
  const ls = await t.as(U.admin, `select id from app.fob_lines where project_id=$1 order by qty desc`, [f]);
  await rejects(t.as(U.manager, `select app.set_fob_line_product($1,$2)`, [ls[1].id, t.ids.bg6mCover]), /PERMISSION_DENIED/);
  await rejects(t.as(U.admin, `select app.set_fob_line_product($1,$2)`, [ls[1].id, t.ids.x6516]), /已经有这个编码/);
  await t.as(U.admin, `select app.set_fob_line_product($1,$2)`, [ls[1].id, t.ids.bg6mCover]);
  assert.equal((await t.one(`select model from app.fob_lines where id=$1`, [ls[1].id])).model, 'BG6M', '型号换成编码上的');
  await t.as(U.admin, `select app.set_fob_price($1,1000)`, [ls[0].id]); await t.as(U.admin, `select app.set_fob_price($1,2000)`, [ls[1].id]);
  await t.as(U.manager, `select app.fob_advance($1,'purchasing','{"po_no":"PO1"}')`, [f]);
  await t.as(U.manager, `select app.fob_advance($1,'in_transit','{}')`, [f]);
  await t.as(U.manager, `select app.fob_receive($1,$2)`, [f, JSON.stringify([{ line_id: ls[1].id, qty: 50 }])]);
  await rejects(t.as(U.admin, `select app.set_fob_line_product($1,$2)`, [ls[1].id, t.ids.bg6mScreen]), /已经入库/);

  const wave = await t.val(U.admin, `select id from app.cash_accounts where org_id = $1 and name = 'Wave-XOF'`, [t.ids.org]);
  const usd = await t.val(U.admin, `select id from app.cash_accounts where org_id = $1 and name = 'Cash-USD'`, [t.ids.org]);
  const pay = (p) => t.as(U.finance, `select app.record_fob_payment2($1,$2)`, [f, JSON.stringify(p)]);
  await rejects(pay({ kind: 'deposit', amount: 60000, account_id: wave }), /凭证/);
  await rejects(pay({ kind: 'deposit', amount: 60000, proof: 'p.jpg' }), /资金账户/);
  await rejects(pay({ kind: 'deposit', amount: 60000, proof: 'p.jpg', account_id: usd }), /币种/);
  await pay({ kind: 'deposit', amount: 60000, proof: 'p.jpg', account_id: wave });
  const m = await t.one(`select m.kind, m.amount, m.status, m.customer_id from app.cash_moves m join app.fob_payments x on x.move_id = m.id where x.project_id = $1`, [f]);
  assert.equal(m.kind, 'deposit'); assert.equal(Number(m.amount), 60000); assert.equal(m.customer_id, t.ids.bigS);
  assert.equal(Number((await t.one(`select paid from app.v_fob where id=$1`, [f])).paid), 60000);
});
