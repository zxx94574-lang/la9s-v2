// 0071: 回款记录 (436) + 经营总览的数 (dash_rows) + 打卡异常 + 汇率历史
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('回款: 登记就从账户里扣 → 填到账 → 核对 (差太多要写原因); 作废不删、钱加回; 员工不能动', async () => {
  const t = await setup();
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const acc = await t.val(U.admin, `select id from app.cash_accounts where org_id = $1 and name = 'Cash-XOF'`, [t.ids.org]);
  await t.db.query(`insert into app.cash_moves (org_id, account_id, kind, amount, on_date, status) values ($1,$2,'opening',5000000,current_date,'confirmed')`, [t.ids.org, acc]);
  await t.db.query(`select app.ensure_remit_accounts($1)`, [t.ids.org]);
  const tos = (await t.db.query(`select id, name, currency from app.remit_accounts where org_id = $1 order by sort`, [t.ids.org])).rows;
  assert.deepEqual(tos.map((x) => x.name), ['9S 人民币账户', 'LA 人民币账户', '9S 香港美金账户']);
  const usd = tos[2].id;
  const base = { from_account_id: acc, amount_out: 3075000, company: '回款公司 A', to_account_id: usd, rate: 615, ref_rate: 600, proof: 'p.jpg' };
  await assert.rejects(t.val(U.picker, `select app.create_remittance($1,$2)`, [t.ids.org, JSON.stringify(base)]));
  await assert.rejects(t.val(U.finance, `select app.create_remittance($1,$2)`, [t.ids.org, JSON.stringify({ ...base, proof: '' })]), /凭证必传/);
  await assert.rejects(t.val(U.finance, `select app.create_remittance($1,$2)`, [t.ids.org, JSON.stringify({ ...base, rate: 0 })]), /约定汇率/);
  await assert.rejects(t.val(U.finance, `select app.create_remittance($1,$2)`, [t.ids.org, JSON.stringify({ ...base, amount_out: 9000000 })]), /不够交/);
  const id = await t.val(U.finance, `select app.create_remittance($1,$2)`, [t.ids.org, JSON.stringify(base)]);
  assert.equal(Number(await t.val(U.admin, `select app.account_balance($1)`, [acc])), 1925000, '登记后马上从账户里扣');
  let r = await t.one(`select * from app.v_remittances where id = $1`, [id]);
  assert.equal(Number(r.expected), 5000); assert.equal(r.status, 'sent'); assert.equal(Number(r.fx_cost), 125, '按参考汇率 600 本该到 5125，汇率上付了 125');
  await assert.rejects(t.as(U.finance, `select app.remit_arrive($1,4980,current_date,'a.jpg')`, [id]), /PERMISSION/);
  await assert.rejects(t.as(U.admin, `select app.remit_arrive($1,4980,current_date,'')`, [id]), /截图必传/);
  await assert.rejects(t.as(U.admin, `select app.remit_check($1)`, [id]), /先填到账/);
  await t.as(U.admin, `select app.remit_arrive($1,3000,current_date,'a.jpg')`, [id]);
  await t.as(U.admin, `select app.remit_arrive($1,1800,current_date,'b.jpg')`, [id]);
  r = await t.one(`select * from app.v_remittances where id = $1`, [id]);
  assert.equal(Number(r.arrived), 4800); assert.equal(r.arrivals, 2); assert.equal(Number(r.short), 200); assert.equal(r.status, 'arrived');
  await assert.rejects(t.as(U.admin, `select app.remit_check($1)`, [id]), /要写原因/);
  await assert.rejects(t.as(U.admin, `select app.void_remittance($1,'录错')`, [id]), /已经填过到账/);
  await t.as(U.admin, `select app.remit_check($1,'香港中转行扣了 200')`, [id]);
  assert.equal((await t.one(`select status from app.remittances where id = $1`, [id])).status, 'checked');
  // 作废: 记录还在, 钱加回
  const id2 = await t.val(U.finance, `select app.create_remittance($1,$2)`, [t.ids.org, JSON.stringify({ ...base, amount_out: 1000000 })]);
  assert.equal(Number(await t.val(U.admin, `select app.account_balance($1)`, [acc])), 925000);
  await assert.rejects(t.as(U.admin, `select app.void_remittance($1,' ')`, [id2]), /写原因/);
  await t.as(U.admin, `select app.void_remittance($1,'金额录错')`, [id2]);
  assert.equal(Number(await t.val(U.admin, `select app.account_balance($1)`, [acc])), 1925000, '作废后钱加回');
  const v = await t.one(`select status, void_note from app.remittances where id = $1`, [id2]);
  assert.equal(v.status, 'void'); assert.equal(v.void_note, '金额录错');
  assert.equal((await t.db.query(`select count(*)::int as n from app.remittances where org_id = $1`, [t.ids.org])).rows[0].n, 2, '作废的记录还在');
});

test('经营总览: dash_rows 带币种和出库那天生效的汇率, 只中方; 改汇率留历史; 打卡异常按人数', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  await t.shipAll(d);
  await assert.rejects(t.as(U.manager, `select * from app.dash_rows($1)`, [t.ids.org]));
  const rows = (await t.as(U.admin, `select * from app.dash_rows($1)`, [t.ids.org]));
  assert.equal(rows.length, 1); assert.equal(rows[0].currency, 'XOF'); assert.equal(Number(rows[0].k), 1); assert.equal(Number(rows[0].qty), 20);
  const n0 = (await t.db.query(`select count(*)::int as n from app.fx_history where org_id = $1`, [t.ids.org])).rows[0].n;
  await t.db.query(`insert into app.price_settings (org_id) values ($1) on conflict (org_id) do update set rmb_per_xof = 0.0105`, [t.ids.org]);
  await t.db.query(`update app.price_settings set rmb_per_xof = 0.0111 where org_id = $1`, [t.ids.org]);
  await t.db.query(`update app.price_settings set round_to = 50 where org_id = $1`, [t.ids.org]);
  const n1 = (await t.db.query(`select count(*)::int as n from app.fx_history where org_id = $1`, [t.ids.org])).rows[0].n;
  assert.ok(n1 >= n0 + 1 && n1 <= n0 + 2, '改汇率才记一条, 改别的不记');
  // 打卡异常: 有工号的才算
  await t.db.query(`update app.employees set emp_no = 'S001' where id = $1`, [t.ids.sales]);
  const an = await t.as(U.admin, `select * from app.attendance_anomalies($1, current_date - 13, current_date)`, [t.ids.org]);
  assert.equal(an.length, 1); assert.equal(an[0].emp_no, 'S001'); assert.ok(an[0].missing >= 10, '两周没打卡, 去掉周日');
  await assert.rejects(t.as(U.picker, `select * from app.attendance_anomalies($1, current_date - 13, current_date)`, [t.ids.org]));
});
