// 0106 (Frank 11-27): 采购单物流信息 / 文件 / 延误记录; 下班卡后锁系统
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('采购单: 物流格子、默认预计到货、改日期要原因、提货单才能提货', async () => {
  const t = await setup();
  const po = await t.val(U.admin, `select app.save_po($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ purpose: 'local', batch_name: 'B1' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 10, descr: 'X6516' }])]);
  await t.as(U.admin, `select app.set_po_info2($1,$2)`, [po, JSON.stringify({ shipped_on: '2026-11-01', forwarder: '赛时', mode: 'sea', tracking_no: 'msku123', warehouse_nos: 'CG2602735A / lky300649y' })]);
  let p = await t.one(`select * from app.purchase_orders where id=$1`, [po]);
  assert.equal(p.forwarder, '赛时'); assert.equal(p.tracking_no, 'MSKU123');
  assert.deepEqual([...p.warehouse_nos].sort(), ['CG2602735A', 'LKY300649Y']);
  assert.equal(String(p.eta.toISOString?.() || p.eta).slice(0, 10), '2027-01-15', '发货日 + 75 天');
  await rejects(t.as(U.admin, `select app.set_po_info2($1,$2)`, [po, JSON.stringify({ eta: '2027-01-25' })]), /原因/);
  await t.as(U.admin, `select app.set_po_info2($1,$2)`, [po, JSON.stringify({ eta: '2027-01-25', eta_reason: '船晚开' })]);
  p = await t.one(`select eta_changes from app.purchase_orders where id=$1`, [po]); assert.equal(p.eta_changes, 1);
  assert.equal((await t.one(`select count(*)::int n from app.po_eta_log where po_id=$1`, [po])).n, 1);
  await rejects(t.as(U.admin, `select app.set_po_info2($1,$2)`, [po, JSON.stringify({ picked_on: '2027-01-26' })]), /提货单/);
  await rejects(t.as(U.picker, `select app.add_po_doc($1,'pickup','BAE.pdf','data:application/pdf;base64,AA')`, [po]), /PERMISSION_DENIED/);
  const d = await t.val(U.admin, `select app.add_po_doc($1,'pickup','BAE.pdf','data:application/pdf;base64,AA')`, [po]);
  await t.as(U.admin, `select app.set_po_info2($1,$2)`, [po, JSON.stringify({ arrived_on: '2027-01-20', cleared_on: '2027-01-24', picked_on: '2027-01-26' })]);
  await rejects(t.as(U.admin, `select app.remove_po_doc($1)`, [d]), /不能删/);
  // 金蝶导入: 物流单号里是入仓号 → 并进入仓号
  await t.as(U.admin, `select app.set_po_logistics_bulk($1,$2)`, [t.ids.org, JSON.stringify([{ po_no: (await t.one(`select po_no from app.purchase_orders where id=$1`, [po])).po_no, tracking_no: 'CG2501577A', weight_vol: '2.1方', freight_est: 1102 }])]);
  p = await t.one(`select * from app.purchase_orders where id=$1`, [po]);
  assert.ok(p.warehouse_nos.includes('CG2501577A')); assert.equal(p.tracking_no, 'MSKU123'); assert.equal(p.weight_vol, '2.1方');
});

test('下班后锁系统: 打了下班卡就锁, 中方 / 国家经理不锁, 放行一次就开', async () => {
  const t = await setup();
  const emp = await t.val(U.admin, `insert into app.employees (org_id, short_name) values ($1,'Yao') returning id`, [t.ids.org]);
  await t.as(U.admin, `update app.members set employee_id=$2 where user_id=$1`, [U.picker, emp]);
  await t.as(U.admin, `insert into app.org_settings (org_id, key, value) values ($1,'offhours_lock','{"cutoff":"23:59","reopen":"00:00"}') on conflict (org_id, key) do update set value=excluded.value`, [t.ids.org]);
  assert.equal((await t.val(U.picker, `select app.offhours_state($1)`, [t.ids.org])).locked, false);
  await t.as(U.admin, `insert into app.attendance (org_id, employee_id, user_id, kind, ok) values ($1,$2,$3,'out',true)`, [t.ids.org, emp, U.picker]);
  const s = await t.val(U.picker, `select app.offhours_state($1)`, [t.ids.org]);
  assert.equal(s.locked, true); assert.equal(s.reason, 'out');
  assert.equal((await t.val(U.admin, `select app.offhours_state($1)`, [t.ids.org])).locked, false, '中方不锁');
  const list = await t.as(U.admin, `select * from app.offhours_today($1)`, [t.ids.org]);
  assert.ok(list.some((r) => r.employee_id === emp && r.out_at));
  await rejects(t.as(U.manager, `select app.grant_access_unlock($1,$2,'x')`, [t.ids.org, emp]), /PERMISSION_DENIED/);
  await rejects(t.as(U.admin, `select app.grant_access_unlock($1,$2,'')`, [t.ids.org, emp]), /为什么/);
  await t.as(U.admin, `select app.grant_access_unlock($1,$2,'今晚盘点')`, [t.ids.org, emp]);
  assert.equal((await t.val(U.picker, `select app.offhours_state($1)`, [t.ids.org])).locked, false);
});

test('0107: FOB 出库 / FOB 收款进「待录金蝶」, 回填单号后变已录', async () => {
  const t = await setup();
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const f = await t.val(U.hotline, `select app.create_fob($1,$2,'CI','warehouse','XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([{ product_id: t.ids.x6516, qty: 10 }])]);
  const wave = await t.val(U.admin, `select id from app.cash_accounts where org_id = $1 and name = 'Wave-XOF'`, [t.ids.org]);
  const pay = await t.val(U.finance, `select app.record_fob_payment2($1,$2)`, [f, JSON.stringify({ kind: 'deposit', amount: 5000, proof: 'p.jpg', account_id: wave })]);
  let rows = await t.as(U.admin, `select * from app.v_kingdee_all where org_id = $1 and kind = 'fob_pay'`, [t.ids.org]);
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'todo'); assert.equal(rows[0].row_id, pay);
  await t.as(U.finance, `select app.kingdee_fill($1,$2)`, [t.ids.org, JSON.stringify([{ kind: 'fob_pay', row_id: pay, no: 'SKD001' }])]);
  rows = await t.as(U.admin, `select * from app.v_kingdee_all where org_id = $1 and kind = 'fob_pay'`, [t.ids.org]);
  assert.equal(rows[0].state, 'done'); assert.equal(rows[0].kd_no, 'SKD001');
});
