// 0013 后续模块: 侧栏配置 / 销量历史 / FOB / 工资 / SOP / 金蝶三步 / 客户下单端与门店
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const BOSS = '00000000-0000-0000-0000-0000000000b1', CLERK = '00000000-0000-0000-0000-0000000000c1';

test('侧栏配置只中方能改; 销量历史让备货看板有日均', async () => {
  const t = await setup();
  await rejects(t.as(U.manager, `select app.set_org_setting($1,'nav','{}')`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_org_setting($1,'nav','{"groups":[]}')`, [t.ids.org]);
  assert.deepEqual((await t.one(`select value from app.org_settings where key='nav'`)).value, { groups: [] });
  const m = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 7); };
  const r = await t.val(U.admin, `select app.import_sales_history($1,$2)`, [t.ids.org, JSON.stringify([
    { code: '1003', month: m(1), qty: 91 }, { code: '1003', month: m(2), qty: 91 }, { code: '1003', month: m(3), qty: 91 }, { code: 'X', month: m(1), qty: 1 }])]);
  assert.equal(r.n, 3); assert.equal(r.bad, 1);
  const v = await t.one(`select * from app.v_replenish where product_id=$1`, [t.ids.x6516]);
  assert.equal(Number(v.daily), 3); assert.equal(Number(v.suggest), 0, '可售 200 > 3×60');
});

test('FOB: 申请 → 中方定价 → 采购 → 在途 → 到货进 FOB 仓 → 订金 → 放货 (没收齐要写原因) → 出库扣 FOB 仓 → 收齐自动结清', async () => {
  const t = await setup();
  const f = await t.val(U.hotline, `select app.create_fob($1,$2,'CI','warehouse','XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([{ product_id: t.ids.x6516, qty: 100 }, { model: 'spark 30', qty: 50 }])]);
  await rejects(t.as(U.manager, `select app.fob_advance($1,'purchasing','{"po_no":"PO1"}')`, [f]), /没定价/);
  const ls = await t.as(U.admin, `select id, product_id from app.fob_lines where project_id=$1 order by qty desc`, [f]);
  await rejects(t.as(U.manager, `select app.set_fob_price($1,1000)`, [ls[0].id]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_fob_price($1,1000)`, [ls[0].id]); await t.as(U.admin, `select app.set_fob_price($1,2000)`, [ls[1].id]);
  await t.as(U.manager, `select app.fob_advance($1,'purchasing','{"po_no":"PO1"}')`, [f]);
  await t.as(U.manager, `select app.fob_advance($1,'in_transit','{"eta":"2026-12-01"}')`, [f]);
  await rejects(t.as(U.manager, `select app.fob_receive($1,$2)`, [f, JSON.stringify([{ line_id: ls[1].id, qty: 50 }])]), /没有编码/);
  await t.as(U.manager, `select app.fob_receive($1,$2)`, [f, JSON.stringify([{ line_id: ls[0].id, qty: 100 }])]);
  assert.equal((await t.stockOf(t.ids.stFOB_x6516)).qty_on_hand, 1100);
  await t.as(U.finance, `select app.record_fob_payment($1,'deposit',60000,current_date,'bank','p.jpg')`, [f]);
  await rejects(t.as(U.manager, `select app.fob_release($1,'')`, [f]), /PERMISSION_DENIED/);
  await rejects(t.as(U.admin, `select app.fob_release($1,'')`, [f]), /写原因/);
  await t.as(U.admin, `select app.fob_release($1,'老客户，先放')`, [f]);
  await t.as(U.manager, `select app.fob_ship($1,'out.jpg')`, [f]);
  assert.equal((await t.stockOf(t.ids.stFOB_x6516)).qty_on_hand, 1000);
  assert.equal((await t.one(`select status from app.fob_projects where id=$1`, [f])).status, 'shipped');
  await t.as(U.finance, `select app.record_fob_payment($1,'balance',140000,current_date,'bank','p2.jpg')`, [f]);
  assert.equal((await t.one(`select status from app.fob_projects where id=$1`, [f])).status, 'closed');
});

test('工资: 激励按归属客户当月出库金额; 按出勤折算; 批准后锁定, 付了永久留底; 只中方', async () => {
  const t = await setup();
  await rejects(t.as(U.manager, `select app.payroll_open($1,current_date)`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.upsert_employee($1,$2,$3)`, [t.ids.org, t.ids.sales, JSON.stringify({ short_name: 'Koffi', full_name: 'koffi demo', base_salary: 100000, incentive_rate: 2 })]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d, null, new Date().toISOString());
  await t.as(U.admin, `select app.payroll_open($1,current_date)`, [t.ids.org]);
  const p = await t.one(`select * from app.payroll where employee_id=$1`, [t.ids.sales]);
  assert.equal(Number(p.base), 100000); assert.equal(Number(p.incentive), 110, '5500 × 2%');
  assert.equal(p.snap_name, 'KOFFI DEMO', '全名大写快照');
  // 分母 = 当月周一到周六的工作日数 (Frank 11-07); 出勤 20 天 → 100000 / 工作日 × 20; CNPS 公司交保险局, 默认不进实发; 扣款 5000
  const h = await t.one(`select days_base, cnps_in_net from app.payroll_months where org_id=$1`, [t.ids.org]);
  const wd = await t.one(`select app.workdays(date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date) as n`);
  assert.equal(Number(h.days_base), Number(wd.n)); assert.equal(h.cnps_in_net, false);
  assert.equal(Number(p.days_auto), Number(wd.n), '没有打卡记录的月份按满勤起草'); assert.equal(Number(p.incentive_auto), 110);
  await t.as(U.admin, `select app.payroll_set_line($1,current_date,$2,$3)`, [t.ids.org, t.ids.sales, JSON.stringify({ days_worked: 20, cnps: 10000, deduction: 5000 })]);
  let q = await t.one(`select * from app.payroll where employee_id=$1`, [t.ids.sales]);
  const base20 = Math.round(100000 / Number(wd.n) * 20);
  assert.equal(Number(q.base), base20); assert.equal(Number(q.net), base20 + 110 - 5000, 'CNPS 不进实发');
  await t.as(U.admin, `select app.payroll_set_header($1,current_date,'{"cnps_in_net":true}')`, [t.ids.org]);
  q = await t.one(`select net from app.payroll where employee_id=$1`, [t.ids.sales]); assert.equal(Number(q.net), base20 + 110 + 10000 - 5000);
  await t.as(U.admin, `select app.payroll_set_header($1,current_date,'{"cnps_in_net":false}')`, [t.ids.org]);
  // 用 80000 继续后面的锁定断言
  const BASE = base20;
  await rejects(t.as(U.finance, `select app.payroll_decide($1,current_date,'approve')`, [t.ids.org]), /PERMISSION_DENIED/, '钱的审批只中方');
  await t.as(U.admin, `select app.payroll_decide($1,current_date,'approve')`, [t.ids.org]);
  await rejects(t.as(U.admin, `select app.payroll_set_line($1,current_date,$2,'{"days_worked":25}')`, [t.ids.org, t.ids.sales]), /BAD_STATE/);
  await rejects(t.as(U.admin, `select app.payroll_drop_line($1,current_date,$2)`, [t.ids.org, t.ids.sales]), /BAD_STATE/);
  await t.as(U.admin, `select app.payroll_decide($1,current_date,'pay','2026-10-28')`, [t.ids.org]);
  await rejects(t.as(U.admin, `select app.payroll_decide($1,current_date,'reopen')`, [t.ids.org]), /BAD_STATE/, '付了不能撤回');
  await rejects(t.as(U.admin, `select app.payroll_set_header($1,current_date,'{"remarks":"x"}')`, [t.ids.org]), /BAD_STATE/);
  // 员工后来改名 / 调薪, 旧月份记录不变
  await t.as(U.admin, `select app.upsert_employee($1,$2,$3)`, [t.ids.org, t.ids.sales, JSON.stringify({ short_name: 'Koffi', full_name: 'NEW NAME', base_salary: 999999 })]);
  q = await t.one(`select snap_name, base, status, paid_on from app.payroll where employee_id=$1`, [t.ids.sales]);
  assert.equal(q.snap_name, 'KOFFI DEMO'); assert.equal(Number(q.base), BASE); assert.equal(q.status, 'paid');
});

test('员工档案: 飞书导入按来源记录更新, 照片不重复; 照片只中方看得到; 销售主管继承销售员权限', async () => {
  const t = await setup();
  const rows = [{ ext_ref: 'rec1', short_name: 'Grace', full_name: 'Kouwakanou Pierre Grace', email: 'G@X.COM', phone: '0500', department: 'SPARE PARTS', position: 'STOCK MANAGER', sys_role: 'manager', joined_on: '2026-05-11', active: true, base_salary: 200000,
    photos: [{ kind: 'id_front', name: 'a.jpg', mime: 'image/jpeg', data: 'AAAA', w: 10, h: 10 }] }];
  let r = await t.val(U.admin, `select app.import_staff($1,$2)`, [t.ids.org, JSON.stringify(rows)]);
  assert.deepEqual([r.new, r.updated, r.photos], [1, 0, 1]);
  r = await t.val(U.admin, `select app.import_staff($1,$2)`, [t.ids.org, JSON.stringify(rows)]);
  assert.deepEqual([r.new, r.updated, r.photos], [0, 1, 0]);
  const e = await t.one(`select * from app.employees where ext_ref='rec1'`);
  assert.equal(e.full_name, 'KOUWAKANOU PIERRE GRACE'); assert.equal(e.email, 'g@x.com');
  await rejects(t.as(U.admin, `select app.upsert_employee($1,$2,$3)`, [t.ids.org, e.id, JSON.stringify({ short_name: 'Grace', email: 'bad' })]), /邮箱/);
  await rejects(t.as(U.manager, `select app.import_staff($1,'[]')`, [t.ids.org]), /PERMISSION_DENIED/);
  // 销售主管: 能做销售员能做的 (建询单), 不能批价
  const SM = '00000000-0000-0000-0000-0000000005a1';
  await t.as(U.admin, `insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,'{sales_manager}')`, [SM, t.ids.org, t.ids.sales]);
  await t.as(SM, `select app.create_inquiry($1,$2,$3,'')`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 1 }])]);
  // 0020: 销售主管 (罗兰) 可以起草工资单, 但「确认发放」只有中方
  await t.as(SM, `select app.payroll_open($1,current_date)`, [t.ids.org]);
  await rejects(t.as(SM, `select app.payroll_confirm($1,current_date)`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.payroll_confirm($1,current_date)`, [t.ids.org]);
  const hh = await t.one(`select status, paid_on from app.payroll_months where org_id=$1`, [t.ids.org]); assert.equal(hh.status, 'paid');
  await rejects(t.as(U.admin, `select app.payroll_set_line($1,current_date,$2,'{"deduction":1}')`, [t.ids.org, t.ids.sales]), /BAD_STATE/);
});

test('SOP: 改了升版本, 要重新确认', async () => {
  const t = await setup();
  const s = await t.val(U.admin, `select app.upsert_sop($1,null,'仓库','初拣',$2,'')`, [t.ids.org, JSON.stringify([{ text: '拍照', route: 'orders' }])]);
  await t.as(U.picker, `select app.ack_sop($1)`, [s]);
  await t.as(U.admin, `select app.upsert_sop($1,$2,'仓库','初拣',$3,'')`, [t.ids.org, s, JSON.stringify([{ text: '拍照两张' }])]);
  const v = await t.one(`select version from app.sop_docs where id=$1`, [s]);
  assert.equal(v.version, 2);
  assert.equal(Number((await t.one(`select count(*) n from app.sop_acks where doc_id=$1 and version=2`, [s])).n), 0);
});

test('金蝶三步: 签收后才能保存; 保存要单号; 提交和审核不能同一人 (中方除外)', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await t.shipAll(d);
  const o = (await t.one(`select k.id, k.shipment_id from app.kingdee_outbox k join app.shipments s on s.id=k.shipment_id where s.deal_id=$1`, [d]));
  await rejects(t.as(U.finance, `select app.kd_step($1,'save','XSCK1')`, [o.id]), /签收后/);
  await t.as(U.hotline, `select app.mark_received($1)`, [o.shipment_id]);
  await rejects(t.as(U.finance, `select app.kd_step($1,'save','')`, [o.id]), /单号/);
  await t.as(U.finance, `select app.kd_step($1,'save','XSCK1')`, [o.id]);
  await t.as(U.manager, `select app.kd_step($1,'submit')`, [o.id]);
  await rejects(t.as(U.manager, `select app.kd_step($1,'audit')`, [o.id]), /同一个人/);
  assert.equal(await t.val(U.admin, `select app.kd_step($1,'audit')`, [o.id]), 'synced');
});

test('客户下单端: 老板下单进我们的已报价; 门店向老板下单, 老板转给我们; 店员不能直接向我们下单', async () => {
  const t = await setup();
  const corg = (await t.one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('customer','SOUMAHORO','CI','XOF','SM') returning id`)).id;
  await t.as(U.admin, `update app.customers set linked_org_id=$1 where id=$2`, [corg, t.ids.bigS]);
  await t.as(U.admin, `insert into app.members (user_id, org_id, roles) values ($1,$2,'{boss}')`, [BOSS, corg]);
  const store = await t.val(U.admin, `select app.create_store($1,'adjame 2','Adjamé','Moussa')`, [t.ids.bigS]);
  const sorg = (await t.one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix,parent_id) values ('store','ADJAME 2','CI','XOF','S2',$1) returning id`, [corg])).id;
  await t.as(U.admin, `update app.portal_stores set org_id=$1 where id=$2`, [sorg, store]);
  await t.as(U.admin, `insert into app.members (user_id, org_id, roles) values ($1,$2,'{clerk}')`, [CLERK, sorg]);

  const d = await t.val(BOSS, `select app.portal_order($1,'急')`, [JSON.stringify([{ product_id: t.ids.bg6mScreen, qty: 5 }, { model: 'spark 40', category: '屏幕', qty: 3 }])]);
  const deal = await t.one(`select status, source, customer_id from app.deals where id=$1`, [d]);
  assert.deepEqual([deal.status, deal.source, deal.customer_id], ['quoted', 'portal', t.ids.bigS]);
  await rejects(t.as(CLERK, `select app.portal_order($1,'')`, [JSON.stringify([{ product_id: t.ids.bg6mScreen, qty: 1 }])]), /老板/);
  const so = await t.val(CLERK, `select app.store_order($1,'')`, [JSON.stringify([{ product_id: t.ids.x6516, model: 'X6516', qty: 4 }])]);
  await t.val(BOSS, `select app.portal_order($1,'门店要的',$2)`, [JSON.stringify([{ product_id: t.ids.x6516, qty: 4 }]), so]);
  const s2 = await t.one(`select status, deal_id from app.store_orders where id=$1`, [so]);
  assert.equal(s2.status, 'forwarded'); assert.ok(s2.deal_id);
  await rejects(t.as(U.outsider, `select app.store_order_decide($1,'accepted')`, [so]), /PERMISSION_DENIED/);
});
