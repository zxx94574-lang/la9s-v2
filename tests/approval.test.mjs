// 0014: 询单分级审批 / 采购·物资申请 / 采购备注识别后收货分 FOB 和本地 / 上班打卡带定位
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const SALES = '00000000-0000-0000-0000-000000000010';

test('询单: 老客户公式价自动通过; 申请特价 / 没编码 / 新客户要中方批; 没批不能往下推', async () => {
  const t = await setup();
  await t.as(U.admin, `insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,'{sales}')`, [SALES, t.ids.org, t.ids.sales]);
  const a = await t.val(SALES, `select app.create_inquiry($1,$2,$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 10 }])]);
  assert.equal((await t.one(`select approval from app.deals where id=$1`, [a])).approval, 'auto');
  const b = await t.val(SALES, `select app.create_inquiry($1,$2,$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 100, requested_price: 450 }])]);
  const db = await t.one(`select approval, approval_reasons from app.deals where id=$1`, [b]);
  assert.equal(db.approval, 'pending'); assert.deepEqual(db.approval_reasons, ['申请特价']);
  await rejects(t.as(U.hotline, `select app.hotline_confirm($1,'ok','phone')`, [b]), /中方先审批/);
  await rejects(t.as(U.manager, `select app.approve_quote($1,true)`, [b]), /PERMISSION_DENIED/);
  const [l] = await t.lines(b);
  await t.as(U.admin, `select app.approve_quote($1,true,'大单',$2)`, [b, JSON.stringify([{ line_id: l.id, price: 470 }])]);
  const l2 = (await t.lines(b))[0];
  assert.equal(Number(l2.unit_price), 470); assert.equal(l2.price_manual, true);
  await t.as(U.hotline, `select app.hotline_confirm($1,'ok','phone')`, [b]);

  // 新客户 (潜客): 先转正式再批
  const p = await t.val(SALES, `select app.create_prospect($1,'new shop','0102030405','Abobo')`, [t.ids.org]);
  const c = await t.val(SALES, `select app.create_inquiry($1,$2,$3)`, [t.ids.org, p, JSON.stringify([{ product_id: t.ids.x6516, qty_req: 5 }])]);
  assert.deepEqual((await t.one(`select approval_reasons from app.deals where id=$1`, [c])).approval_reasons, ['新客户（还没定档位）']);
  await rejects(t.as(U.admin, `select app.approve_quote($1,true)`, [c]), /转正式/);
  await t.as(U.admin, `select app.activate_customer($1,'C800','RETAIL')`, [p]);
  await t.as(U.admin, `select app.approve_quote($1,true)`, [c]);
  assert.equal(Number((await t.lines(c))[0].unit_price), 2400, 'RETAIL 价');
  await rejects(t.as(U.admin, `select app.approve_quote($1,false,'')`, [a]), /原因/);
});

test('采购 / 物资申请: FOB 必须选项目; 下单后不能改内容; 进度更新', async () => {
  const t = await setup();
  await rejects(t.as(U.manager, `select app.save_purchase_request($1,null,$2,'[]')`, [t.ids.org, JSON.stringify({ kind: 'fob', title: 'x' })]), /FOB 项目/);
  const r = await t.val(U.finance, `select app.save_purchase_request($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ kind: 'supplies', title: '工服', need_by: '2026-12-01', planned_ship: '2026-11-10' }), JSON.stringify([{ item: '工服 L 蓝', qty: 20 }, { item: '工服 XL 蓝', qty: 10 }])]);
  await t.as(U.manager, `select app.advance_purchase_request($1,'ordered','{"po_no":"PO1"}')`, [r]);
  await rejects(t.as(U.finance, `select app.save_purchase_request($1,$2,$3,'[]')`, [t.ids.org, r, JSON.stringify({ kind: 'supplies', title: '工服2' })]), /不能改内容/);
  await t.as(U.manager, `select app.advance_purchase_request($1,'shipped',$2)`, [r, JSON.stringify({ container: 'MSKU123', eta: '2026-12-20' })]);
  const x = await t.one(`select status, container, eta from app.purchase_requests where id=$1`, [r]);
  assert.equal(x.status, 'shipped'); assert.equal(x.container, 'MSKU123');
});

test('采购备注识别 → 整单 FOB 全部算 FOB; 混装人工分; 收货本地进 LA / 9S, FOB 进 FOB 仓, 出金蝶入库待录', async () => {
  const t = await setup();
  await t.val(U.admin, `select app.import_purchase_orders($1,$2)`, [t.ids.org, JSON.stringify([
    { po_no: 'PO-F', code: '1003', qty: 100 }, { po_no: 'PO-M', code: '1003', qty: 300 }, { po_no: 'PO-M', code: '1001', qty: 50 }])]);
  await t.as(U.admin, `select app.set_po_remark($1,'PO-F','KABRE海运-5',$2)`, [t.ids.org, JSON.stringify({ purpose: 'fob', fob_customers: ['C003'] })]);
  await t.as(U.admin, `select app.set_po_remark($1,'PO-M','混装',$2)`, [t.ids.org, JSON.stringify({ purpose: 'mixed', fob_customers: ['C003'] })]);
  const f = await t.one(`select l.id, l.fob_qty, l.fob_customer from app.po_lines l join app.purchase_orders p on p.id=l.po_id where p.po_no='PO-F'`);
  assert.equal(f.fob_qty, 100); assert.equal(f.fob_customer, 'C003');
  const m = await t.as(U.admin, `select l.id, l.qty from app.po_lines l join app.purchase_orders p on p.id=l.po_id where p.po_no='PO-M' order by l.qty desc`);
  await t.as(U.manager, `select app.set_po_line_alloc($1,120,'C003')`, [m[0].id]);
  const po = (await t.one(`select id from app.purchase_orders where po_no='PO-M'`)).id;
  await rejects(t.as(U.manager, `select app.receive_po_split($1,$2)`, [po, JSON.stringify([{ line_id: m[0].id, local_qty: 181, fob_qty: 120, warehouse: '9S' }])]), /超过/);
  const g = await t.val(U.manager, `select app.receive_po_split($1,$2)`, [po, JSON.stringify([{ line_id: m[0].id, local_qty: 180, fob_qty: 120, warehouse: '9S' }, { line_id: m[1].id, local_qty: 50, fob_qty: 0, warehouse: 'LA' }])]);
  assert.equal((await t.stockOf(t.ids.st9S_x6516)).qty_on_hand, 380);
  assert.equal((await t.stockOf(t.ids.stFOB_x6516)).qty_on_hand, 1120);
  assert.equal((await t.stockOf(t.ids.stLA_bg6m)).qty_on_hand, 110);
  assert.equal((await t.one(`select status from app.purchase_orders where id=$1`, [po])).status, 'closed');
  await rejects(t.as(U.finance, `select app.kd_grn_step($1,'save','')`, [g]), /入库单号/);
  await t.as(U.finance, `select app.kd_grn_step($1,'save','CGRK001')`, [g]);
});

test('打卡: 仓库员工要在仓库范围内; 销售在哪都记, 200 米内自动归成一个地点, 中方起名; 第一次上班卡晚了算迟到', async () => {
  const t = await setup();
  await t.as(U.admin, `insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,'{sales}')`, [SALES, t.ids.org, t.ids.sales]);
  await rejects(t.as(U.manager, `select app.upsert_site($1,null,'LA 仓','warehouse',5.35,-4.01,150)`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.upsert_site($1,null,'LA 仓','warehouse',5.3500,-4.0100,150)`, [t.ids.org]);
  await t.as(U.admin, `select app.upsert_site($1,null,'Adjamé 市场','market',5.3600,-4.0200,300)`, [t.ids.org]);
  await t.as(U.admin, `select app.set_attendance_settings($1,'00:00','23:59',0)`, [t.ids.org]);
  const a = await t.val(U.picker, `select app.clock($1,'in',5.3501,-4.0101,20)`, [t.ids.org]);
  assert.equal(a.ok, true); assert.equal(a.site, 'LA 仓');
  const b = await t.val(U.picker, `select app.clock($1,'out',5.3600,-4.0200,20)`, [t.ids.org]);
  assert.equal(b.ok, false, '仓库员工在市场不算');
  const c = await t.val(SALES, `select app.clock($1,'in',5.3605,-4.0205,30)`, [t.ids.org]);
  assert.equal(c.ok, true); assert.equal(c.site, 'Adjamé 市场'); assert.equal(c.new_site, false);
  // 销售去了一个没登记的市场 (离 Adjamé 很远): 自动开一个待起名的地点
  const d = await t.val(SALES, `select app.clock($1,'out',5.3000,-4.1000,30)`, [t.ids.org]);
  assert.equal(d.ok, true, '销售在哪都算打了卡'); assert.equal(d.new_site, true);
  const auto = await t.one(`select * from app.work_sites where org_id=$1 and auto`, [t.ids.org]);
  assert.equal(auto.named, false); assert.equal(auto.kind, 'market');
  // 150 米内再打一次 → 归到同一个地点, 不再新开
  const e = await t.val(SALES, `select app.clock($1,'in',5.3010,-4.1005,30)`, [t.ids.org]);
  assert.equal(e.new_site, false); assert.equal(e.site, auto.name);
  await rejects(t.as(U.picker, `select app.name_site($1,'Yopougon 市场')`, [auto.id]), /PERMISSION_DENIED/);
  await t.as(U.manager, `select app.name_site($1,'Yopougon 市场')`, [auto.id]);
  const f = await t.val(SALES, `select app.clock($1,'in',5.3012,-4.1002,30)`, [t.ids.org]);
  assert.equal(f.site, 'Yopougon 市场');
  await rejects(t.as(U.picker, `select app.clock($1,'in',null,null,null)`, [t.ids.org]), /定位/);
});
