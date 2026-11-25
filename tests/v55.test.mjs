// 0093: 应收期初差异表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('期初差异: 粘金蝶应收 → 每客户 系统/金蝶/差; 系统有余额金蝶没有的也列; 调平要写原因, 只中方', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.one(`insert into app.ar_entries (org_id, customer_id, currency, kind, amount) values ($1,$2,'XOF','opening',500000)`, [org, t.ids.camaraAbobo]);
  await t.one(`insert into app.ar_entries (org_id, customer_id, currency, kind, amount) values ($1,$2,'XOF','opening',80000) returning id`, [org, t.ids.bigS]);
  await assert.rejects(t.as(U.picker, `select app.kd_opening_paste($1, current_date, '[]')`, [org]), /PERMISSION/);
  const n = await t.val(U.finance, `select app.kd_opening_paste($1, current_date, $2)`, [org, JSON.stringify([{ code: 'c001', amount: 450000 }, { code: 'C999', amount: 1000 }])]);
  assert.equal(n, 2);
  const rows = await t.as(U.admin, `select customer_code, customer_id is not null as known, sys_amount::numeric s, kd_amount::numeric k from app.kd_opening_diff order by customer_code`);
  const by = Object.fromEntries(rows.map((r) => [r.customer_code, r]));
  assert.equal(Number(by.C001.s), 500000); assert.equal(Number(by.C001.k), 450000);
  assert.equal(by.C999.known, false);
  assert.equal(Number(by.C003.s), 80000); assert.equal(Number(by.C003.k), 0);
  const id = (await t.one(`select id from app.kd_opening_diff where customer_code = 'C001'`)).id;
  await assert.rejects(t.as(U.finance, `select app.kd_opening_clear($1,'x')`, [id]), /PERMISSION/);
  await assert.rejects(t.as(U.admin, `select app.kd_opening_clear($1,'  ')`, [id]), /怎么调平/);
  await t.as(U.admin, `select app.kd_opening_clear($1,'金蝶补录了一张')`, [id]);
  // 再粘一次: 已调平的不动
  await t.val(U.finance, `select app.kd_opening_paste($1, current_date, $2)`, [org, JSON.stringify([{ code: 'C001', amount: 1 }])]);
  assert.ok((await t.one(`select cleared_at from app.kd_opening_diff where id = $1`, [id])).cleared_at);
  // 不影响客户 Balance
  assert.equal(await t.balance(t.ids.camaraAbobo), 500000);
});

test('0094 批次付款汇率: 存得进, 非正数拒绝', async () => {
  const t = await setup();
  const id = await t.val(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mScreen, JSON.stringify({ qty: 100, currency: 'CNY', unit_price: 30, pay_rate: 92.5 })]);
  assert.equal(Number((await t.one(`select pay_rate from app.product_batches where id = $1`, [id])).pay_rate), 92.5);
  await assert.rejects(t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mScreen, JSON.stringify({ qty: 1, unit_price: 1, pay_rate: 0 })]), /汇率要大于 0/);
  await t.as(U.admin, `select app.save_product_batch($1,$2,$3)`, [t.ids.bg6mScreen, id, JSON.stringify({ qty: 100, currency: 'CNY', unit_price: 30 })]);
  assert.equal((await t.one(`select pay_rate from app.product_batches where id = $1`, [id])).pay_rate, null);
});

test('0095 审批三种模式: self 直接生效 / notify 生效 + 知会 / approve 要另一位中方批, 不能自己批自己', async () => {
  const t = await setup();
  const org = t.ids.org;
  const A2 = '00000000-0000-0000-0000-0000000000a2';
  await t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{admin}')`, [A2, org]);
  const args = { product: t.ids.bg6mCover, price: 1000, from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), note: '清货', label: '清仓价' };
  // self (没设置)
  const r1 = await t.val(U.admin, `select app.decision_submit($1,'promo','清仓 BG6M 盖',null,$2)`, [org, JSON.stringify(args)]);
  assert.equal(r1.mode, 'self');
  // approve
  await t.as(U.admin, `select app.set_org_setting($1,'approval_modes',$2)`, [org, JSON.stringify({ promo: { mode: 'approve' }, writeoff: { mode: 'notify' } })]);
  const r2 = await t.val(U.admin, `select app.decision_submit($1,'promo','清仓 BG6M 盖',$2,$3)`, [org, JSON.stringify({ 库存: 500 }), JSON.stringify({ ...args, price: 900 })]);
  assert.equal(r2.mode, 'approve');
  await assert.rejects(t.as(U.admin, `select app.decision_approve($1)`, [r2.id]), /不能自己批自己/);
  await assert.rejects(t.as(U.manager, `select app.decision_approve($1)`, [r2.id]), /PERMISSION/);
  await t.as(A2, `select app.decision_approve($1,'可以，价再高点',$2)`, [r2.id, JSON.stringify({ ...args, price: 950 })]);
  const d = await t.one(`select status, (args->>'price')::numeric p, report ? '改前参数' as edited from app.decisions where id = $1`, [r2.id]);
  assert.equal(d.status, 'done'); assert.equal(Number(d.p), 950); assert.equal(d.edited, true);
  await assert.rejects(t.as(A2, `select app.decision_approve($1)`, [r2.id]), /处理过了/);
  // 退回要写意见; 提的人自己撤 = cancelled
  const r3 = await t.val(U.admin, `select app.decision_submit($1,'promo','x',null,$2)`, [org, JSON.stringify(args)]);
  await assert.rejects(t.as(A2, `select app.decision_reject($1,' ')`, [r3.id]), /写意见/);
  await t.as(U.admin, `select app.decision_reject($1,'不做了')`, [r3.id]);
  assert.equal((await t.one(`select status from app.decisions where id = $1`, [r3.id])).status, 'cancelled');
  await assert.rejects(t.as(U.admin, `select app.decision_submit($1,'drop_table','x',null,'{}')`, [org]), /不能走审批/);
  await assert.rejects(t.as(U.manager, `select app.decision_submit($1,'promo','x',null,$2)`, [org, JSON.stringify(args)]), /PERMISSION/);
});

test('0096 按采购单看利润: 先进先出把出库分到批次, 收入按那几张单的单价, 成本按付款汇率', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mCover, JSON.stringify({ po_no: 'PO-A', ordered_on: '2026-09-01', qty: 6, currency: 'XOF', unit_price: 1000 })]);
  await t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mCover, JSON.stringify({ po_no: 'PO-B', ordered_on: '2026-10-01', qty: 10, currency: 'CNY', unit_price: 10, pay_rate: 100 })]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  const price = Number((await t.lines(d))[0].unit_price);
  const rows = await t.as(U.admin, `select * from app.po_profit($1)`, [org]);
  const A = rows.find((r) => r.po_no === 'PO-A'); const B = rows.find((r) => r.po_no === 'PO-B');
  assert.equal(A.sold, 6); assert.equal(A.left_qty, 0); assert.equal(Number(A.cost_sold), 6000);
  assert.equal(B.sold, 4); assert.equal(B.left_qty, 6); assert.equal(Number(B.unit_cost), 1000 + Number((await t.one(`select freight_xof from app.products where id=$1`, [t.ids.bg6mCover])).freight_xof || 0));
  assert.equal(B.rate_basis, '付款汇率');
  assert.equal(Number(A.revenue), Math.round(6 * price)); assert.equal(Number(B.revenue), Math.round(4 * price));
  assert.equal((await t.as(U.admin, `select * from app.po_profit($1,'PO-B')`, [org])).length, 1);
  await assert.rejects(t.as(U.manager, `select * from app.po_profit($1)`, [org]), /PERMISSION/);
});

test('0097 退货坏货按原来出货的仓进对应报废仓: 9S 的进 SCRAP-9S, 没有对应的进默认报废仓', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.one(`insert into app.warehouses (org_id, code, name, kind) values ($1,'SCRAP-9S','报废仓 9S','scrap') returning id`, [org]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.x6516, qty_req: 5 }]);
  await t.shipAll(d);
  const [l] = await t.lines(d);
  const rt = await t.val(U.hotline, `select app.request_return($1,'quality','坏',$2)`, [d, JSON.stringify([{ line_id: l.id, qty: 2 }])]);
  await t.as(U.admin, `select app.decide_return($1,true)`, [rt]);
  const rl = await t.one(`select id from app.return_lines where return_id=$1`, [rt]);
  await t.as(U.manager, `select app.inspect_return_line($1,0,2)`, [rl.id]);
  const r = await t.one(`select w.code, s.qty_on_hand from app.stock_items s join app.warehouses w on w.id=s.warehouse_id where w.kind='scrap' and s.product_id=$1 and s.qty_on_hand > 0`, [t.ids.x6516]);
  assert.equal(r.code, 'SCRAP-9S'); assert.equal(r.qty_on_hand, 2);
});

test('0098 先进先出追溯: 退货扣回去 / 卖给了谁 / 订单行来自哪张采购单', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mCover, JSON.stringify({ po_no: 'PO-A', ordered_on: '2026-09-01', qty: 6, currency: 'XOF', unit_price: 1000 })]);
  await t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [t.ids.bg6mCover, JSON.stringify({ po_no: 'PO-B', ordered_on: '2026-10-01', qty: 10, currency: 'XOF', unit_price: 1200 })]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  const [l] = await t.lines(d);
  const rt = await t.val(U.hotline, `select app.request_return($1,'quality','坏',$2)`, [d, JSON.stringify([{ line_id: l.id, qty: 3 }])]);
  await t.as(U.admin, `select app.decide_return($1,true)`, [rt]);
  const rows = await t.as(U.admin, `select * from app.po_profit($1)`, [org]);
  assert.equal(rows.find((r) => r.po_no === 'PO-A').sold, 6);
  assert.equal(rows.find((r) => r.po_no === 'PO-B').sold, 1, '退 3 片 → 卖出净 7 片, PO-B 只剩 1 片算卖出');
  const tr = await t.as(U.admin, `select * from app.po_trace($1,'PO-A')`, [org]);
  assert.equal(tr.length, 1); assert.equal(tr[0].customer_id, t.ids.camaraAbobo); assert.equal(tr[0].qty, 6);
  const src = await t.as(U.admin, `select * from app.deal_line_sources($1)`, [d]);
  assert.deepEqual(src.map((r) => [r.po_no, r.qty]), [['PO-A', 6], ['PO-B', 1]]);
  await assert.rejects(t.as(U.manager, `select * from app.deal_line_sources($1)`, [d]), /PERMISSION/);
});

test('0099 国内财务记货款带汇率 → 批次付款汇率 = 带汇率货款的加权平均', async () => {
  const t = await setup();
  const CNF = '00000000-0000-0000-0000-0000000000cb', CNP = '00000000-0000-0000-0000-0000000000c9';
  for (const [u, r] of [[CNF, '{cn_finance}'], [CNP, '{cn_support}']]) await t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,$3)`, [u, t.ids.org, r]);
  const po = await t.val(CNP, `select app.save_po($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ po_no: 'PO-R', purpose: 'local', inbound_no: 'CR1' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 400, unit_price: 10 }])]);
  await t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: 3000, currency: 'CNY', xof_per_unit: 90, proof: 'p.jpg' })]);
  assert.equal(Number((await t.one(`select pay_rate from app.product_batches where po_no = 'PO-R'`)).pay_rate), 90);
  await t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: 1000, currency: 'CNY', xof_per_unit: 94, proof: 'p.jpg' })]);
  assert.equal(Number((await t.one(`select pay_rate from app.product_batches where po_no = 'PO-R'`)).pay_rate), 91);
  await t.as(CNF, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: 500, currency: 'CNY', proof: 'p.jpg' })]);
  assert.equal(Number((await t.one(`select pay_rate from app.product_batches where po_no = 'PO-R'`)).pay_rate), 91, '没填汇率的货款不影响');
});

test('0100 盘点: 员工只能盘派给自己的货架 / 种类; 报盘完才能自己再领; 主管随时能派', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2`, [t.ids.picker, U.picker]);
  const c = await t.val(U.admin, `select app.count_start($1,'x',true)`, [org]);
  await assert.rejects(t.as(U.picker, `select app.count_add($1,'SS-A-1',$2,5,null)`, [c, t.ids.bg6mScreen]), /还没给你派/);
  const tk = await t.val(U.manager, `select app.count_task_set2($1,$2,$3,$4)`, [c, t.ids.picker, ['SS-A'], t.ids.catScreen]);
  await t.as(U.picker, `select app.count_add($1,'ss-a-1',$2,5,null)`, [c, t.ids.bg6mScreen]);
  await assert.rejects(t.as(U.picker, `select app.count_add($1,'SS-B-1',$2,5,null)`, [c, t.ids.bg6mScreen]), /不在你的任务/);
  await assert.rejects(t.as(U.picker, `select app.count_add($1,'SS-A-2',$2,5,null)`, [c, t.ids.bg6mCover]), /种类不在你的任务/);
  await assert.rejects(t.as(U.picker, `select app.count_task_claim($1,$2,null)`, [c, ['SS-B']]), /先把手上这批/);
  await t.as(U.picker, `select app.count_task_done($1,true)`, [tk]);
  await assert.rejects(t.as(U.picker, `select app.count_task_claim($1,$2,null)`, [c, ['SS-A']]), /已经派给/);
  await t.val(U.picker, `select app.count_task_claim($1,$2,null)`, [c, ['SS-B']]);
  await t.as(U.picker, `select app.count_add($1,'SS-B-1',$2,3,null)`, [c, t.ids.bg6mCover]);
  await t.as(U.manager, `select app.count_add($1,'AA-A-1',$2,1,null)`, [c, t.ids.bg6mCover]);   // 主管哪里都能录
  assert.equal(Number((await t.one(`select count(*) n from app.count_lines where count_id = $1`, [c])).n), 3);
});

test('0101 时效准确奖扣: 带进工资单 + 进实发; 手改过的重算不覆盖, force 才覆盖', async () => {
  const t = await setup();
  const org = t.ids.org;
  await t.as(U.admin, `select app.payroll_open($1,'2026-11-01')`, [org]);
  const net0 = Number((await t.one(`select net from app.payroll where org_id = $1 and employee_id = $2`, [org, t.ids.picker])).net);
  await t.as(U.admin, `select app.payroll_kpi_pay($1,'2026-11-01',$2,false)`, [org, JSON.stringify([{ employee_id: t.ids.picker, amount: -5000, note: '时效 60%' }])]);
  let r = await t.one(`select net, kpi_pay, kpi_note from app.payroll where org_id = $1 and employee_id = $2`, [org, t.ids.picker]);
  assert.equal(Number(r.kpi_pay), -5000); assert.equal(Number(r.net), net0 - 5000); assert.equal(r.kpi_note, '时效 60%');
  await t.as(U.admin, `select app.payroll_set_kpi_pay($1,'2026-11-01',$2,0)`, [org, t.ids.picker]);
  await t.as(U.admin, `select app.payroll_kpi_pay($1,'2026-11-01',$2,false)`, [org, JSON.stringify([{ employee_id: t.ids.picker, amount: 10000, note: 'x' }])]);
  assert.equal(Number((await t.one(`select kpi_pay from app.payroll where org_id = $1 and employee_id = $2`, [org, t.ids.picker])).kpi_pay), 0);
  await t.as(U.admin, `select app.payroll_kpi_pay($1,'2026-11-01',$2,true)`, [org, JSON.stringify([{ employee_id: t.ids.picker, amount: 10000, note: 'x' }])]);
  assert.equal(Number((await t.one(`select kpi_pay from app.payroll where org_id = $1 and employee_id = $2`, [org, t.ids.picker])).kpi_pay), 10000);
  await assert.rejects(t.as(U.picker, `select app.payroll_kpi_pay($1,'2026-11-01','[]',true)`, [org]), /PERMISSION/);
});
