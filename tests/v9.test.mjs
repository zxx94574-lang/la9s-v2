// 0018 第九版 (Frank 11-07): 出勤从打卡自动算 + 申诉; BL 编号 / 签收; 热线要货日期; 导出记录; 客户资料编辑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const SALES = '00000000-0000-0000-0000-000000000010';
const rejects = async (p, re) => { try { await p; } catch (e) { assert.match(e.message, re); return; } assert.fail('should have thrown'); };

test('工资按打卡: 有打卡的月份实到天数自动算; 迟到太久不算; 申诉批准后补回; 手改后重算不覆盖', async () => {
  const t = await setup();
  await t.as(U.admin, `insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,'{sales}')`, [SALES, t.ids.org, t.ids.sales]);
  await t.as(U.admin, `select app.upsert_employee($1,$2,$3)`, [t.ids.org, t.ids.sales, JSON.stringify({ short_name: 'Koffi', full_name: 'koffi demo', base_salary: 260000 })]);
  await t.as(U.admin, `select app.set_attendance_rules($1,'{"start_time":"08:30","grace_min":10,"late_absent_min":120}')`, [t.ids.org]);
  // 直接造本月的打卡记录: 1 号准时, 2 号迟到 3 小时 (算旷工), 3 号准时
  const m = (await t.one(`select date_trunc('month', current_date)::date as m`)).m;
  const ins = (day, time) => t.as(U.admin, `insert into app.attendance (org_id, employee_id, user_id, kind, at, ok) values ($1,$2,$3,'in', (($4::date + $5::time) at time zone 'Africa/Abidjan'), true)`, [t.ids.org, t.ids.sales, SALES, day, time]);
  const d = (n) => { const x = new Date(m); x.setUTCDate(n); return x.toISOString().slice(0, 10); };
  await ins(d(1), '08:20'); await ins(d(2), '11:40'); await ins(d(3), '08:35');
  assert.equal(Number(await t.val(U.admin, `select app.worked_days($1,$2,$3)`, [t.ids.org, t.ids.sales, m])), 2);
  await t.as(U.admin, `select app.payroll_open($1,$2)`, [t.ids.org, m]);
  let p = await t.one(`select * from app.payroll where employee_id=$1`, [t.ids.sales]);
  const h = await t.one(`select days_base from app.payroll_months where org_id=$1`, [t.ids.org]);
  assert.equal(Number(p.days_auto), 2); assert.equal(Number(p.days_worked), 2);
  assert.equal(Number(p.base), Math.round(260000 / Number(h.days_base) * 2));
  // 员工申诉 2 号 (理由必填, 只能申诉过去的日子); 中方批准 → 草稿月份自动变 3 天
  await rejects(t.as(SALES, `select app.appeal_attendance($1,$2,'')`, [t.ids.org, d(2)]), /理由/);
  const ap = await t.val(SALES, `select app.appeal_attendance($1,$2,'堵车，到了先去客户那里送货')`, [t.ids.org, d(2)]);
  await rejects(t.as(U.manager, `select app.decide_appeal($1,true)`, [ap]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.decide_appeal($1,true,'有送货单为证')`, [ap]);
  p = await t.one(`select * from app.payroll where employee_id=$1`, [t.ids.sales]);
  assert.equal(Number(p.days_worked), 3); assert.equal(Number(p.days_auto), 3);
  // 中方手改成 5 天后, 「重新按打卡算」不覆盖手改, 只刷新自动值
  await t.as(U.admin, `select app.payroll_set_line($1,$2,$3,'{"days_worked":5}')`, [t.ids.org, m, t.ids.sales]);
  await ins(d(4), '08:00');
  await t.as(U.admin, `select app.payroll_refresh_auto($1,$2)`, [t.ids.org, m]);
  p = await t.one(`select * from app.payroll where employee_id=$1`, [t.ids.sales]);
  assert.equal(Number(p.days_worked), 5); assert.equal(Number(p.days_auto), 4);
  // 0022: 指定人重算 = 明确要按打卡来, 覆盖手改
  await t.as(U.admin, `select app.payroll_refresh_auto($1,$2,$3)`, [t.ids.org, m, [t.ids.sales]]);
  p = await t.one(`select * from app.payroll where employee_id=$1`, [t.ids.sales]);
  assert.equal(Number(p.days_worked), 4);
});

test('BL: 编号 BL-日期-客户前三位-序号, 同一天同客户递增, 重复发单原样返回; 签收照片必填; 海关文件只中方上传', async () => {
  const t = await setup();
  const d1 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const s1 = await t.shipAll(d1, null, '2026-10-23T10:00:00Z');
  const d2 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  const s2 = await t.shipAll(d2, null, '2026-10-23T15:00:00Z');
  const no1 = await t.val(U.picker, `select app.issue_bl($1)`, [s1]);
  assert.equal(no1, 'BL-23102026-CAM-001');
  assert.equal(await t.val(U.picker, `select app.issue_bl($1)`, [s1]), no1, '再点不换号');
  assert.equal(await t.val(U.manager, `select app.issue_bl($1)`, [s2]), 'BL-23102026-CAM-002');
  await rejects(t.as(U.picker, `select app.attach_bl_signature($1,'')`, [s1]), /签字照片/);
  await t.as(U.picker, `select app.attach_bl_signature($1,'photo://signed.jpg')`, [s1]);
  const sh = await t.one(`select signed_photo, signed_at, bl_no from app.shipments where id=$1`, [s1]);
  assert.equal(sh.signed_photo, 'photo://signed.jpg'); assert.ok(sh.signed_at);
  await rejects(t.as(U.manager, `select app.set_org_file($1,'customs','q.pdf','application/pdf','AAAA',4)`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_org_file($1,'customs','QUITTANCE.pdf','application/pdf','AAAA',4)`, [t.ids.org]);
  await t.as(U.admin, `select app.set_org_file($1,'customs','Q2.pdf','application/pdf','BBBB',4)`, [t.ids.org]);
  const f = await t.one(`select * from app.org_files where org_id=$1 and key='customs'`, [t.ids.org]);
  assert.equal(f.name, 'Q2.pdf', '重传覆盖');
});

test('热线: 打开记时间 (提醒用); 确认时记客户要货日期; 导出留记录; 客户资料编辑只中方 / 主管', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 10 }])]);
  await t.as(U.hotline, `select app.mark_hotline_opened($1)`, [deal]);
  const a = await t.one(`select hotline_opened_at from app.deals where id=$1`, [deal]);
  assert.ok(a.hotline_opened_at);
  await t.as(U.hotline, `select app.hotline_confirm($1,'明天要','phone',null,current_date + 1)`, [deal]);
  const b = await t.one(`select status, want_on, hotline_opened_at from app.deals where id=$1`, [deal]);
  assert.equal(b.status, 'hotline_ok'); assert.equal(new Date(b.want_on).toISOString().slice(0, 10), new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  assert.equal(String(b.hotline_opened_at), String(a.hotline_opened_at), '打开时间不被确认覆盖');
  // 导出记录: 谁 / 什么 / 多少行, 不存文件
  await t.as(U.manager, `select app.log_export($1,'payroll','{"rows":12}')`, [t.ids.org]);
  const l = await t.one(`select * from app.export_log where org_id=$1`, [t.ids.org]);
  assert.equal(l.user_id, U.manager); assert.equal(l.detail.rows, 12);
  // 客户资料
  await rejects(t.as(U.picker, `select app.edit_customer_info($1,'{"phone":"x"}')`, [t.ids.camaraAbobo]), /PERMISSION_DENIED/);
  await t.as(U.manager, `select app.edit_customer_info($1,$2)`, [t.ids.camaraAbobo, JSON.stringify({ contact_name: 'M. Camara', phone: '07 49 33 88 43', city: 'Abobo', owner_employee_id: t.ids.picker })]);
  const c = await t.one(`select contact_name, phone, city, owner_employee_id from app.customers where id=$1`, [t.ids.camaraAbobo]);
  assert.equal(c.contact_name, 'M. Camara'); assert.equal(c.owner_employee_id, t.ids.picker);
});

test('工资: 确认发放后锁定; 撤回要写原因并留痕; 撤回过的月份再确认必须勾核实', async () => {
  const t = await setup();
  await t.as(U.admin, `select app.payroll_open($1,current_date)`, [t.ids.org]);
  await t.as(U.admin, `select app.payroll_confirm($1,current_date)`, [t.ids.org]);
  await rejects(t.as(U.admin, `select app.payroll_set_line($1,current_date,$2,'{"deduction":1}')`, [t.ids.org, t.ids.sales]), /BAD_STATE/);
  await rejects(t.as(U.admin, `select app.payroll_unconfirm($1,current_date,'')`, [t.ids.org]), /原因/);
  await rejects(t.as(U.manager, `select app.payroll_unconfirm($1,current_date,'误点')`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.payroll_unconfirm($1,current_date,'误点')`, [t.ids.org]);
  let h = await t.one(`select status, reopen_count, last_reopen_reason, paid_on from app.payroll_months where org_id=$1`, [t.ids.org]);
  assert.equal(h.status, 'draft'); assert.equal(h.reopen_count, 1); assert.equal(h.last_reopen_reason, '误点'); assert.equal(h.paid_on, null);
  await t.as(U.admin, `select app.payroll_set_line($1,current_date,$2,'{"deduction":1}')`, [t.ids.org, t.ids.sales]);
  await rejects(t.as(U.admin, `select app.payroll_confirm($1,current_date)`, [t.ids.org]), /核实/);
  await t.as(U.admin, `select app.payroll_confirm($1,current_date,null,true)`, [t.ids.org]);
  h = await t.one(`select status from app.payroll_months where org_id=$1`, [t.ids.org]); assert.equal(h.status, 'paid');
  const au = await t.one(`select count(*)::int as n from app.audit_log where org_id=$1 and action in ('payroll_unconfirm','payroll_confirm')`, [t.ids.org]); assert.ok(au.n >= 2);
});

test('0023 客户: 供货方式 本地备货 / FOB (默认本地, 名字 FOB 开头的回填成 FOB); 跟进状态; 自定义列 attrs 合并; 非法供货方式拒绝', async () => {
  const t = await setup();
  const c0 = await t.one(`select supply, attrs from app.customers where id=$1`, [t.ids.camaraAbobo]);
  assert.equal(c0.supply, 'local'); assert.deepEqual(c0.attrs, {});
  const fobN = await t.one(`select count(*)::int as n from app.customers where org_id=$1 and upper(name) like 'FOB %'`, [t.ids.org]);
  const fobS = await t.one(`select count(*)::int as n from app.customers where org_id=$1 and supply='fob'`, [t.ids.org]);
  assert.equal(fobS.n, fobN.n);
  await t.as(U.manager, `select app.edit_customer_info($1,$2)`, [t.ids.camaraAbobo, JSON.stringify({ supply: 'fob', follow_status: 'FOLLOWING', shop_type: 'WHOLESALE', attrs: { kind: 'A' } })]);
  await t.as(U.manager, `select app.edit_customer_info($1,$2)`, [t.ids.camaraAbobo, JSON.stringify({ attrs: { src: 'VISIT' } })]);
  let c = await t.one(`select supply, follow_status, shop_type, attrs from app.customers where id=$1`, [t.ids.camaraAbobo]);
  assert.equal(c.supply, 'fob'); assert.equal(c.follow_status, 'FOLLOWING'); assert.equal(c.shop_type, 'WHOLESALE'); assert.deepEqual(c.attrs, { kind: 'A', src: 'VISIT' });
  await t.as(U.manager, `select app.edit_customer_info($1,$2)`, [t.ids.camaraAbobo, JSON.stringify({ attrs: { kind: null } })]);
  c = await t.one(`select attrs from app.customers where id=$1`, [t.ids.camaraAbobo]); assert.deepEqual(c.attrs, { src: 'VISIT' });
  await rejects(t.as(U.manager, `select app.edit_customer_info($1,'{"supply":"x"}')`, [t.ids.camaraAbobo]), /供货方式/);
});

test('0024 上报问题: 任何成员可报 (文字必填), 进单据记录; 只中方能处理; 报价 0 价拦截: 没档位 / 没价格的编码不让建报价, 补录型号可以', async () => {
  const t = await setup();
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 10 }])]);
  await rejects(t.as(U.picker, `select app.report_issue($1,$2,'pick','库存','  ')`, [t.ids.org, deal]), /出了什么问题/);
  const id = await t.val(U.picker, `select app.report_issue($1,$2,'pick','库存和系统对不上','BG6M 架上只有 6 只，系统 10')`, [t.ids.org, deal]);
  const ev = await t.one(`select count(*)::int as n from app.deal_events where deal_id=$1 and action='issue_reported'`, [deal]); assert.equal(ev.n, 1);
  await rejects(t.as(U.manager, `select app.close_issue($1,'ok')`, [id]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.close_issue($1,'已盘，按 6 只走')`, [id]);
  const r = await t.one(`select status, reply from app.issue_reports where id=$1`, [id]); assert.equal(r.status, 'closed'); assert.equal(r.reply, '已盘，按 6 只走');
  await rejects(t.as(U.admin, `select app.close_issue($1)`, [id]), /BAD_STATE/);
  // 0 价拦截
  const prospect = await t.val(U.manager, `select app.create_prospect($1,'ZERO TEST','0700000000','Abobo')`, [t.ids.org]);
  if (prospect) await rejects(t.as(U.manager, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, prospect, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 1 }])]), /没定档位|no price tier/);
  const noPrice = (await t.one(`select p.id from app.products p where p.org_id=$1 and not exists (select 1 from app.product_prices pp where pp.product_id=p.id) limit 1`, [t.ids.org]))?.id;
  if (noPrice) await rejects(t.as(U.manager, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: noPrice, qty_req: 1 }])]), /没有价格/);
  const catId = (await t.one(`select category_id from app.products where id=$1`, [t.ids.bg6mCover])).category_id;
  const ok = await t.val(U.manager, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 2 }, { req_category_id: catId, req_model: 'NOCODE-X', qty_req: 3 }])]);
  assert.ok(ok);
  const n = await t.one(`select count(*)::int as n from app.deals where id=$1`, [ok]); assert.equal(n.n, 1);
});

test('0025 自定义列: 任何成员可存 row_attrs (合并 / null 删键 / 表名校验); 客户旧 attrs 和 custom 列定义并进来', async () => {
  const t = await setup();
  await t.as(U.picker, `select app.set_row_attrs($1,'employees',$2,'{"grade":"A"}')`, [t.ids.org, t.ids.sales]);
  await t.as(U.picker, `select app.set_row_attrs($1,'employees',$2,'{"team":"NORD"}')`, [t.ids.org, t.ids.sales]);
  let r = await t.one(`select attrs from app.row_attrs where org_id=$1 and tbl='employees' and row_id=$2`, [t.ids.org, t.ids.sales]);
  assert.deepEqual(r.attrs, { grade: 'A', team: 'NORD' });
  await t.as(U.picker, `select app.set_row_attrs($1,'employees',$2,'{"grade":null}')`, [t.ids.org, t.ids.sales]);
  r = await t.one(`select attrs from app.row_attrs where org_id=$1 and tbl='employees' and row_id=$2`, [t.ids.org, t.ids.sales]); assert.deepEqual(r.attrs, { team: 'NORD' });
  await rejects(t.as(U.picker, `select app.set_row_attrs($1,'Bad Table',$2,'{"a":1}')`, [t.ids.org, t.ids.sales]), /表名/);
  await rejects(t.as(U.picker, `select app.set_row_attrs($1,'employees',$2,'[1]')`, [t.ids.org, t.ids.sales]), /列/);
  // 选项设置只中方
  await rejects(t.as(U.manager, `select app.set_org_setting($1,'table_options:employees','{"custom":[]}')`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_org_setting($1,'table_options:employees',$2)`, [t.ids.org, JSON.stringify({ custom: [{ key: 'grade', label: '等级', type: 'select', items: [{ v: 'A', l: 'A 级' }] }] })]);
  const o = await t.one(`select value from app.org_settings where org_id=$1 and key='table_options:employees'`, [t.ids.org]); assert.equal(o.value.custom[0].label, '等级');
});

test('0026 流程合并: 热线 / 主管 / 销售主管都能确认; 今天要 = 确认 + 预占下推一步; 明天要 = 只确认, 热线也能之后下推', async () => {
  const t = await setup();
  const d1 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 3 }])]);
  await rejects(t.as(U.picker, `select app.quote_confirm($1,'ok','phone',null,current_date,true)`, [d1]), /PERMISSION_DENIED/);
  await t.as(U.manager, `select app.quote_confirm($1,'客户确认数量','phone',null,current_date,true)`, [d1]);
  let d = await t.one(`select status, pick_no, hotline_method, want_on from app.deals where id=$1`, [d1]);
  assert.equal(d.status, 'picking'); assert.ok(d.pick_no); assert.equal(d.hotline_method, 'phone');
  const ev = await t.one(`select array_agg(action order by at) as a from app.deal_events where deal_id=$1`, [d1]); assert.ok(ev.a.includes('hotline_confirmed') && ev.a.includes('picking_started'));
  const d2 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 2 }])]);
  await t.as(U.hotline, `select app.quote_confirm($1,'明天','whatsapp',null,current_date + 1,false)`, [d2]);
  d = await t.one(`select status, pick_no from app.deals where id=$1`, [d2]); assert.equal(d.status, 'hotline_ok'); assert.equal(d.pick_no, null);
  await t.as(U.hotline, `select app.start_picking($1)`, [d2]);   // 0026: 热线也能下推
  d = await t.one(`select status from app.deals where id=$1`, [d2]); assert.equal(d.status, 'picking');
  await rejects(t.as(U.hotline, `select app.quote_confirm($1,'x','phone')`, [d2]), /BAD_STATE|状态/);
});

test('0027 建单页: 潜客快速建档 (电话可空, 店铺类型给估价档位) 能报价; 中方报价时直接给价 = 手改留痕, 不受 0 价拦截; 客户忙留痕', async () => {
  const t = await setup();
  const pid = await t.val(U.hotline, `select app.create_prospect($1,'DRAMANE KOUMASSI','','Koumassi',$2)`, [t.ids.org, JSON.stringify({ shop_type: 'RETAIL', market: 'Koumassi' })]);
  const c = await t.one(`select tier, status, phone from app.customers where id=$1`, [pid]);
  assert.equal(c.tier, 'RETAIL'); assert.equal(c.status, 'prospect'); assert.equal(c.phone, null);
  // 热线能给潜客改估价档位; 正式客户的档位只中方
  await t.as(U.hotline, `select app.edit_customer_info($1,'{"tier":"WHOLESALE"}')`, [pid]);
  await rejects(t.as(U.hotline, `select app.edit_customer_info($1,'{"tier":"S"}')`, [t.ids.camaraAbobo]), /PERMISSION_DENIED/);
  const d1 = await t.val(U.hotline, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, pid, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 2 }])]);
  assert.ok(d1);
  // 没价格的编码: 员工给价不行, 中方给价可以 (手改留痕), 顺手过 0 价拦截
  const noPrice = (await t.one(`select p.id from app.products p where p.org_id=$1 and not exists (select 1 from app.product_prices pp where pp.product_id=p.id) limit 1`, [t.ids.org]))?.id;
  if (noPrice) {
    await rejects(t.as(U.manager, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: noPrice, qty_req: 1, unit_price: 900 }])]), /PERMISSION_DENIED/);
    const d2 = await t.val(U.admin, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: noPrice, qty_req: 1, unit_price: 900 }])]);
    const l = await t.one(`select unit_price, price_manual from app.deal_lines where deal_id=$1`, [d2]); assert.equal(Number(l.unit_price), 900); assert.equal(l.price_manual, true);
    const ev = await t.one(`select count(*)::int as n from app.deal_events where deal_id=$1 and action='price_set'`, [d2]); assert.equal(ev.n, 1);
  }
  await t.as(U.hotline, `select app.hotline_busy($1,'开会')`, [d1]);
  const d = await t.one(`select status, hotline_busy_at, hotline_busy_note from app.deals where id=$1`, [d1]); assert.equal(d.status, 'quoted'); assert.ok(d.hotline_busy_at); assert.equal(d.hotline_busy_note, '开会');
});

test('0028 发货文件 + 签收: 复检后提前出 BL 编号, 出库时落到出库单; 签收要照片, 签收后金蝶可录', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 4 }], { review: false });
  await rejects(t.as(U.manager, `select app.issue_bl_pending($1)`, [d]), /BAD_STATE/);
  await t.as(U.manager, `select app.review_pick($1,$2,'photo://pack.jpg')`, [d, t.ids.picker]);
  const no = await t.val(U.manager, `select app.issue_bl_pending($1)`, [d]);
  assert.match(no, /^BL-\d{8}-CAM-\d{3}$/);
  assert.equal(await t.val(U.manager, `select app.issue_bl_pending($1)`, [d]), no, '再点不换号');
  const sid = await t.shipAll(d);
  const sh = await t.one(`select bl_no, customer_received_at from app.shipments where id=$1`, [sid]);
  assert.equal(sh.bl_no, no); assert.equal(sh.customer_received_at, null);
  const dd = await t.one(`select next_bl_no from app.deals where id=$1`, [d]); assert.equal(dd.next_bl_no, null);
  await rejects(t.as(U.hotline, `select app.sign_receipt($1,null)`, [sid]), /照片/);
  await t.as(U.hotline, `select app.sign_receipt($1,'photo://signed.jpg', now() - interval '10 minutes')`, [sid]);
  const s2 = await t.one(`select customer_received_at, signed_photo from app.shipments where id=$1`, [sid]); assert.ok(s2.customer_received_at); assert.equal(s2.signed_photo, 'photo://signed.jpg');
  const k = await t.one(`select status from app.kingdee_outbox where shipment_id=$1`, [sid]); assert.equal(k.status, 'ready');
});

test('0029 退货三板块: 收到退货要时间 + 实物照片; 批准 + 检验完才能「对账完成」; 没完成的在 v_open_returns 里', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await t.shipAll(d);
  const line = (await t.lines(d))[0];
  await rejects(t.as(U.hotline, `select app.request_return($1,'quality','坏了',$2,null,now(),'')`, [d, JSON.stringify([{ line_id: line.id, qty: 2 }])]), /照片/);
  const rid = await t.val(U.hotline, `select app.request_return($1,'quality','坏了',$2,null,now() - interval '1 hour','photo://returned.jpg')`, [d, JSON.stringify([{ line_id: line.id, qty: 2 }])]);
  let o = await t.one(`select pending from app.v_open_returns where id=$1`, [rid]); assert.equal(o.pending, 'decide');
  await rejects(t.as(U.hotline, `select app.return_reconciled($1)`, [rid]), /没批准/);
  await t.as(U.admin, `select app.decide_return($1,true)`, [rid]);
  o = await t.one(`select pending from app.v_open_returns where id=$1`, [rid]); assert.equal(o.pending, 'reconcile');   // 0033: 先对账, 检验不卡
  const rl = await t.one(`select id from app.return_lines where return_id=$1`, [rid]);
  await rejects(t.as(U.hotline, `select app.return_reconciled($1,'')`, [rid]), /凭证/);
  await t.as(U.hotline, `select app.return_reconciled($1,'photo://recon.jpg')`, [rid]);
  o = await t.one(`select pending from app.v_open_returns where id=$1`, [rid]); assert.equal(o.pending, 'inspect');   // 对完账但没检验 → 仓库待办
  await t.as(U.manager, `select app.inspect_return_line($1,2,0)`, [rl.id]);
  const gone = await t.one(`select count(*)::int as n from app.v_open_returns where id=$1`, [rid]); assert.equal(gone.n, 0);
  const r = await t.one(`select received_photo, reconciled_at from app.returns where id=$1`, [rid]); assert.equal(r.received_photo, 'photo://returned.jpg'); assert.ok(r.reconciled_at);
});

test('0030 撤销收款: 必填原因, 冲账收回, 总账反冲, 不能撤两次; 退货对账完成要凭证', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await t.shipAll(d);
  const bal = async () => Number((await t.one(`select coalesce(sum(amount),0) as b from app.ar_entries where customer_id=$1`, [t.ids.camaraAbobo])).b);
  const b0 = await bal();
  const rc = await t.val(U.finance, `select app.record_receipt($1,$2,current_date,111111,'XOF','cash','XOF',1,'specific',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([d])]);
  assert.ok(Number((await t.one(`select count(*)::int n from app.receipt_allocations where receipt_id=$1`, [rc])).n) > 0);
  await rejects(t.as(U.finance, `select app.void_receipt($1,'')`, [rc]), /原因/);
  await rejects(t.as(U.picker, `select app.void_receipt($1,'错')`, [rc]), /PERMISSION/);
  await t.as(U.finance, `select app.void_receipt($1,'小数点输错')`, [rc]);
  assert.equal(await bal(), b0, '总账恢复');
  assert.equal(Number((await t.one(`select count(*)::int n from app.receipt_allocations where receipt_id=$1`, [rc])).n), 0);
  assert.equal(Number((await t.one(`select unallocated from app.v_receipt_open where id=$1`, [rc])).unallocated), 0);
  await rejects(t.as(U.finance, `select app.void_receipt($1,'再撤')`, [rc]), /撤销过/);
  const ev = await t.one(`select count(*)::int n from app.deal_events where deal_id=$1 and action='receipt_voided'`, [d]); assert.equal(ev.n, 1);
});

test('0031 采购批次: 只中方能录; 导入按编码 + 采购单号去重; 不认识的编码退回; 美元汇率可设', async () => {
  const t = await setup();
  const p = (await t.one(`select id, code from app.products where org_id=$1 limit 1`, [t.ids.org]));
  await rejects(t.as(U.manager, `select app.save_product_batch($1,null,$2)`, [p.id, JSON.stringify({ qty: 10, unit_price: 3 })]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.save_product_batch($1,null,$2)`, [p.id, JSON.stringify({ qty: 0, unit_price: 3 })]), /数量/);
  const rows = [{ code: p.code, po_no: 'PO1', qty: 100, unit_price: 4.2, currency: 'USD', source: 'kingdee' }, { code: 'NOPE', po_no: 'PO1', qty: 5, unit_price: 1 }];
  let r = await t.val(U.admin, `select app.import_product_batches($1,$2)`, [t.ids.org, JSON.stringify(rows)]);
  assert.equal(r.inserted, 1); assert.equal(r.bad_rows.length, 1);
  rows[0].unit_price = 4.5;
  r = await t.val(U.admin, `select app.import_product_batches($1,$2)`, [t.ids.org, JSON.stringify(rows)]);
  assert.equal(r.updated, 1);
  const b = await t.one(`select count(*)::int n, max(unit_price)::float u, max(currency) c from app.product_batches where product_id=$1 and po_no='PO1'`, [p.id]);
  assert.equal(b.n, 1); assert.equal(b.u, 4.5); assert.equal(b.c, 'USD');
  await t.as(U.admin, `select app.set_usd_rate($1,610)`, [t.ids.org]);
  assert.equal(Number((await t.one(`select xof_per_usd from app.price_settings where org_id=$1`, [t.ids.org])).xof_per_usd), 610);
});

test('0031 改价规则: 员工报价时申请价 → 待审批, 没批不能下推; 中方直接改价生效留痕; 员工改单可原样带回中方手改价但不能自己改', async () => {
  const t = await setup();
  const lines = [{ product_id: t.ids.bg6mCover, qty_req: 5, requested_price: 600 }];
  const d = await t.val(U.hotline, `select app.create_quote_priced($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify(lines)]);
  let x = await t.one(`select approval, approval_reasons from app.deals where id=$1`, [d]);
  assert.equal(x.approval, 'pending'); assert.ok(x.approval_reasons.includes('申请特价'));
  const l = (await t.lines(d))[0]; assert.equal(Number(l.requested_price), 600);
  await rejects(t.as(U.hotline, `select app.quote_confirm($1,'ok','phone','photo://x',null,true)`, [d]), /审批/);
  await t.as(U.admin, `select app.approve_quote($1,true,'可以',$2)`, [d, JSON.stringify([{ line_id: l.id, price: 600 }])]);
  x = await t.one(`select approval from app.deals where id=$1`, [d]); assert.equal(x.approval, 'approved');
  // 批过以后员工再申请 → 重新待批
  await t.as(U.hotline, `select app.edit_quote_priced($1,$2,$3)`, [d, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5, unit_price: 600, requested_price: 550 }]), [l.id]]);
  x = await t.one(`select approval from app.deals where id=$1`, [d]); assert.equal(x.approval, 'pending');
  // 员工不能自己直接改价
  const l2 = (await t.lines(d))[0];
  await rejects(t.as(U.hotline, `select app.edit_quote_priced($1,$2,$3)`, [d, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5, unit_price: 500 }]), [l2.id]]), /只有中方/);
  // 中方直接改: 生效 + 留痕
  const d2 = await t.val(U.admin, `select app.create_quote_priced($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 3, unit_price: 777 }])]);
  const m = (await t.lines(d2))[0]; assert.equal(Number(m.unit_price), 777); assert.equal(m.price_manual, true);
  const ev = await t.one(`select count(*)::int n from app.deal_events where deal_id=$1 and action='price_set'`, [d2]); assert.ok(ev.n >= 1);
});

test('0031 种类管理: 改名不能撞名; 合并把物料搬过去; 有物料的种类不能删', async () => {
  const t = await setup();
  const cats = (await t.db.query(`select id, name from app.categories where org_id=$1 order by sort`, [t.ids.org])).rows;
  const [a, b] = cats;
  await rejects(t.as(U.admin, `select app.rename_category($1,$2)`, [a.id, b.name]), /已经有/);
  await rejects(t.as(U.manager, `select app.rename_category($1,'X')`, [a.id]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.delete_category($1)`, [a.id]), /还有物料/);
  const nc = await t.one(`insert into app.categories (org_id,name,sort) values ($1,'TESTCAT',99) returning id`, [t.ids.org]);
  await t.db.query(`insert into app.products (org_id,code,category_id,model) values ($1,'ZZ01',$2,'ONLY-HERE')`, [t.ids.org, nc.id]);
  const moved = await t.val(U.admin, `select app.merge_category($1,$2)`, [nc.id, b.id]);
  assert.equal(moved, 1);
  assert.equal(Number((await t.one(`select count(*) n from app.categories where id=$1`, [nc.id])).n), 0);
  if (Number((await t.one(`select count(*) n from app.products p1 join app.products p2 on p1.model = p2.model and coalesce(p1.variant,'') = coalesce(p2.variant,'') where p1.category_id=$1 and p2.category_id=$2`, [a.id, b.id])).n) > 0)
    await rejects(t.as(U.admin, `select app.merge_category($1,$2)`, [a.id, b.id]), /不能直接合并/);
});

test('0032 欠款不出货: 开关只中方; 有欠款的报价进审批; 出库硬拦, 中方放行后能出', async () => {
  const t = await setup();
  const c = t.ids.camaraAbobo;
  const d1 = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await t.shipAll(d1);   // 现在客户欠这一单
  await rejects(t.as(U.manager, `select app.set_block_on_debt($1,true)`, [c]), /PERMISSION/);
  await t.as(U.admin, `select app.set_block_on_debt($1,true)`, [c]);
  const d2 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 2 }])]);
  const a = await t.one(`select approval, approval_reasons from app.deals where id=$1`, [d2]);
  assert.equal(a.approval, 'pending'); assert.ok(a.approval_reasons.some((x) => x.startsWith('有欠款不出货')));
  // 已经在走的单 (审批前就过了的): 出库时拦
  await t.as(U.admin, `select app.set_block_on_debt($1,false)`, [c]);
  const d3 = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 1 }]);
  await t.as(U.admin, `select app.set_block_on_debt($1,true)`, [c]);
  await rejects(t.shipAll(d3), /有欠款不出货/);
  await rejects(t.as(U.admin, `select app.release_debt_block($1,'')`, [d3]), /原因/);
  await t.as(U.admin, `select app.release_debt_block($1,'答应付清')`, [d3]);
  await t.shipAll(d3);
  assert.equal(await t.status(d3), 'shipped');
});

test('0033 外币报价手填汇率 + 驳回后可重新提交 / 还款自动通过 + 退货对完账不卡检验', async () => {
  const t = await setup();
  const c = t.ids.camaraAbobo;
  await rejects(t.as(U.manager, `select app.create_quote_fx($1,$2,'CNY',$3,null,null)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 2 }])]), /汇率/);
  const d = await t.val(U.manager, `select app.create_quote_fx($1,$2,'CNY',$3,null,93.5)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 2 }])]);
  const xof = Number(await t.val(U.admin, `select app.tier_price($1,$2,'XOF')`, [t.ids.bg6mCover, c]));
  const l = (await t.lines(d))[0];
  assert.equal(Number(l.unit_price), Math.round(xof / 93.5 * 100) / 100);
  assert.equal(Number((await t.one(`select fx_rate from app.deals where id=$1`, [d])).fx_rate), 93.5);
  // 驳回后重新提交
  const d2 = await t.val(U.hotline, `select app.create_quote_priced($1,$2,'XOF',$3)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 3, requested_price: 500 }])]);
  await t.as(U.admin, `select app.approve_quote($1,false,'太低',null)`, [d2]);
  assert.equal((await t.one(`select approval from app.deals where id=$1`, [d2])).approval, 'rejected');
  assert.equal(await t.val(U.hotline, `select app.resubmit_approval($1,'客户加价了')`, [d2]), 'pending');
  // 欠款不出货客户: 付清后自动通过
  const d3 = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]);
  await t.shipAll(d3);
  await t.as(U.admin, `select app.set_block_on_debt($1,true)`, [c]);
  const d4 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 1 }])]);
  assert.equal((await t.one(`select approval from app.deals where id=$1`, [d4])).approval, 'pending');
  const bal = Number((await t.one(`select balance from app.v_customer_credit where customer_id=$1`, [c])).balance);
  await t.val(U.finance, `select app.record_receipt($1,$2,current_date,$3,'XOF','cash','XOF',1,'oldest',null)`, [t.ids.org, c, bal]);
  assert.equal((await t.one(`select approval from app.deals where id=$1`, [d4])).approval, 'auto');
});
