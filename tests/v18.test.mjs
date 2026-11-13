// 0045: 账的修正 (调整进订单欠款 / 退款扣预付 / 多冲退回预付 / 对账自检 / 有争议的单跳过) · 销售员欠款不出货 + 申诉 · 改价审批 + 异价单 + 变更通知 · 仓库提成进工资 · 金蝶其他出入库
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const NOW = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const rc = (t, cust, p) => t.val(U.finance, `select app.record_receipt2($1,$2)`, [t.ids.org, JSON.stringify({ customer_id: cust, received_on: today(), currency: 'XOF', method: 'cash', mode: 'oldest', proof: 'x.jpg', ...p })]);
const due = async (t, d) => Number(await t.val(U.admin, `select due from app.v_deal_due where deal_id = $1`, [d]));
const open = async (t, c) => Number(await t.val(U.admin, `select coalesce(sum(unallocated),0) from app.v_receipt_open where customer_id = $1`, [c]));
const noDiff = async (t) => assert.equal(Number(await t.val(U.admin, `select count(*) from app.ledger_check($1)`, [t.ids.org])), 0, '对账自检: 各单欠款 − 预付 = 总账');

test('价格调整进订单欠款; 调低后多收的钱退回预付; 对账自检平', async () => {
  const t = await setup(); const c = t.ids.camaraAbobo;
  const d = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const d0 = await due(t, d); assert.ok(d0 > 500);
  await rc(t, c, { amount_landed: d0 });
  assert.equal(await due(t, d), 0);
  await t.as(U.admin, `select app.adjust_price($1,-500,'单价多收了 50','p.jpg')`, [d]);
  assert.equal(await due(t, d), 0, '订单不欠也不多');
  assert.equal(await open(t, c), 500, '多收的 500 变回预付');
  await noDiff(t);
  // 下一单出库 → 预付自动抵
  const d2 = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d2);
  assert.equal(await open(t, c), 0); assert.equal(await due(t, d2), d0 - 500);
  await noDiff(t);
});

test('退款只能退没冲的预付, 退了以后不会再被自动冲一次', async () => {
  const t = await setup(); const c = t.ids.camaraAbobo;
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  const acc = await t.val(U.admin, `select id from app.cash_accounts where org_id = $1 and currency = 'XOF' limit 1`, [t.ids.org]);
  await rc(t, c, { amount_landed: 10000, mode: 'none' });
  assert.equal(await open(t, c), 10000);
  await rejects(t.as(U.admin, `select app.refund_customer($1,$2,20000,current_date,'退多了','p.jpg')`, [c, acc]), /预付只有/);
  await t.as(U.admin, `select app.refund_customer($1,$2,4000,current_date,'客户要回一部分','p.jpg')`, [c, acc]);
  assert.equal(await open(t, c), 6000);
  await noDiff(t);
  const d = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 100 }]); await t.shipAll(d);
  const alloc = Number(await t.val(U.admin, `select coalesce(sum(amount),0) from app.receipt_allocations where deal_id = $1`, [d]));
  assert.equal(alloc, 6000, '只冲剩下的 6000, 退掉的 4000 不再出现');
  await noDiff(t);
});

test('付清的单认了收货差异 → 多付的退回预付; 有没处理差异的单自动冲账先跳过', async () => {
  const t = await setup(); const c = t.ids.camaraAbobo;
  const d = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  await t.as(U.manager, `select app.sign_receipt($1,'s.jpg',now())`, [sh]);
  const line = await t.one(`select deal_line_id, unit_price from app.shipment_lines where shipment_id = $1`, [sh]);
  const d0 = await due(t, d);
  const a = await t.val(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, JSON.stringify([{ deal_line_id: line.deal_line_id, received: 8 }])]);
  // 差异没处理: 自动冲最老的单跳过它 → 钱留作预付
  await rc(t, c, { amount_landed: d0 });
  assert.equal(await due(t, d), d0, '有争议的单没被冲'); assert.equal(await open(t, c), d0);
  // 指定冲这张单 (人工决定) 可以
  const r = await t.val(U.admin, `select id from app.v_receipt_open where customer_id = $1 and unallocated > 0`, [c]);
  await t.as(U.finance, `select app.apply_unallocated($1,'specific',$2)`, [r, JSON.stringify([d])]);
  assert.equal(await due(t, d), 0);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','复检没查出来','lost',null)`, [a]);
  assert.equal(await due(t, d), 0); assert.equal(await open(t, c), 2 * Number(line.unit_price), '少的 2 片的钱变回预付');
  await noDiff(t);
});

test('抹零上限在设置里可调', async () => {
  const t = await setup(); const c = t.ids.camaraAbobo;
  const d = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  await rejects(t.as(U.admin, `select app.write_off($1,300,'尾差')`, [d]), /超过上限/);
  await t.db.query(`insert into app.org_settings (org_id, key, value) values ($1,'writeoff_rules','{"max_xof":500}')`, [t.ids.org]);
  await t.as(U.admin, `select app.write_off($1,300,'尾差')`, [d]);
});

test('销售员名下有隔天没收回的欠款 → 他名下所有客户暂不出货; 当天的不追; 申诉 → 中方放行', async () => {
  const t = await setup(); const A = t.ids.camaraAbobo, B = t.ids.bigS;
  await t.db.query(`update app.org_settings set value = '{"on":true}' where org_id = $1 and key = 'rep_debt_rules'`, [t.ids.org]);
  const ship = (d) => t.shipAll(d, null, NOW());
  const d1 = await t.toConfirmed(A, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await ship(d1);
  // 当天: 同一个销售员的另一个客户照常出货
  const d2 = await t.toConfirmed(B, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]); await ship(d2);
  // 把 A 的货改成昨天出的 → 今天 B 不能出
  await t.db.query(`update app.shipments set shipped_at = now() - interval '1 day' where deal_id = $1`, [d1]);
  assert.equal(Number(await t.val(U.manager, `select count(*) from app.rep_debt($1)`, [t.ids.sales])), 1);
  const d3 = await t.toConfirmed(B, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await rejects(ship(d3), /名下还有 1 个客户的货款没收回/);
  // 申诉: 要截图; 中方处理要写结果
  await rejects(t.as(U.hotline, `select app.appeal_payment($1,'客户说付了','')`, [d3]), /截图/);
  const ap = await t.val(U.hotline, `select app.appeal_payment($1,'CAMARA 昨晚 Wave 付了，截图在群里','w.jpg')`, [d3]);
  await rejects(t.as(U.manager, `select app.decide_payment_appeal($1,true,'ok')`, [ap]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.decide_payment_appeal($1,true,'')`, [ap]), /写结果/);
  await t.as(U.admin, `select app.decide_payment_appeal($1,true,'Wave 查到了，稍后登记')`, [ap]);
  await ship(d3);
  // 钱收回来 → 自动放开
  const d4 = await t.toConfirmed(B, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await rejects(ship(d4), /暂不出货/);
  await rc(t, A, { amount_landed: await due(t, d1) });
  await ship(d4);
});

test('销售订单阶段: 员工申请改价 → 等中方批 (批 / 驳都要备注), 没批不能往下走; 偏离档位价 >10% = 异价; 变更通知', async () => {
  const t = await setup(); const c = t.ids.camaraAbobo;
  const d = await t.toConfirmed(c, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const l = await t.one(`select id, unit_price, odd from app.deal_lines where deal_id = $1`, [d]);
  assert.equal(l.odd, false);
  const px = Number(l.unit_price);
  await rejects(t.as(U.hotline, `select app.request_line_price($1,$2,'')`, [l.id, px / 2]), /写原因/);
  await t.as(U.hotline, `select app.request_line_price($1,$2,'客户说别家便宜')`, [l.id, Math.round(px / 2)]);
  assert.equal(Number((await t.one(`select unit_price from app.deal_lines where id = $1`, [l.id])).unit_price), px, '没批之前价格不变');
  await rejects(t.shipAll(d), /改价在等中方审批/);
  await rejects(t.as(U.manager, `select app.decide_line_price($1,true,'行')`, [l.id]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.decide_line_price($1,true,'')`, [l.id]), /备注/);
  await t.as(U.admin, `select app.decide_line_price($1,true,'清老库存，同意')`, [l.id]);
  const l2 = await t.one(`select unit_price, odd, price_req from app.deal_lines where id = $1`, [l.id]);
  assert.equal(Number(l2.unit_price), Math.round(px / 2)); assert.equal(l2.odd, true); assert.equal(l2.price_req, null);
  const kinds = (await t.db.query(`select kind from app.change_notices where deal_id = $1 order by id`, [d])).rows.map((r) => r.kind);
  assert.ok(kinds.includes('price_requested') && kinds.includes('price_decided') && kinds.includes('price_set'), kinds.join(','));
  await rejects(t.as(U.manager, `select app.ack_change_notices($1)`, [[1]]), /PERMISSION/);
  assert.ok(Number(await t.val(U.admin, `select app.ack_change_notices(array(select id from app.change_notices where deal_id = $1))`, [d])) >= 3);
  // 小改 (5%) 不算异价
  await t.as(U.admin, `select app.set_line_price($1,$2,'抹个零头')`, [l.id, Math.round(px * 0.95)]);
  assert.equal((await t.one(`select odd from app.deal_lines where id = $1`, [l.id])).odd, false);
});

test('重复照片只记一条变更通知; 金蝶: 冻结转待检 / 差异冲回 进其他出入库待录', async () => {
  const t = await setup();
  await t.as(U.picker, `select app.note_dup_photo($1,null,'签收 CI-1-S2','CI-1-S1 签收')`, [t.ids.org]);
  assert.equal(Number(await t.val(U.admin, `select count(*) from app.change_notices where kind = 'dup_photo'`)), 1);
  const h = await t.val(U.manager, `select app.freeze_stock($1,10,'软件没升级','p.jpg')`, [t.ids.stLA_cover]);
  await t.as(U.manager, `select app.close_stock_hold($1,'to_pending','确认有问题','p2.jpg')`, [h]);
  const rows = (await t.db.query(`select doc_type, qty, status from app.kingdee_misc order by qty`)).rows;
  assert.ok(rows.length >= 2 && rows.every((r) => r.doc_type === '调拨' && r.status === 'ready'), JSON.stringify(rows));
  await rejects(t.as(U.manager, `select app.kingdee_misc_done(array(select id from app.kingdee_misc),'')`), /金蝶里的单号/);
  assert.equal(Number(await t.val(U.manager, `select app.kingdee_misc_done(array(select id from app.kingdee_misc),'QTCK0001')`)), rows.length);
});

test('仓库提成进工资单: 自动带出、可手改、进实发; 手改过的重算不覆盖', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 100 }]); await t.shipAll(d, null, NOW());
  await t.as(U.admin, `select app.payroll_open($1,current_date)`, [t.ids.org]);
  await t.as(U.admin, `select app.payroll_wh_comm($1,current_date)`, [t.ids.org]);
  const who = await t.val(U.admin, `select coalesce(reviewer_employee_id, picker_employee_id) from app.deals where id = $1`, [d]);
  const p = async () => t.one(`select wh_comm, wh_comm_auto, net, base, allowance, incentive, prime_team, deduction from app.payroll where employee_id = $1`, [who]);
  let r = await p(); assert.equal(Number(r.wh_comm), 500); assert.equal(Number(r.wh_comm_auto), 500);
  assert.equal(Number(r.net), Number(r.base) + Number(r.allowance) + Number(r.incentive) + Number(r.prime_team) + 500 - Number(r.deduction));
  await t.as(U.admin, `select app.payroll_set_wh_comm($1,current_date,$2,300)`, [t.ids.org, who]);
  await t.as(U.admin, `select app.payroll_wh_comm($1,current_date)`, [t.ids.org]);
  r = await p(); assert.equal(Number(r.wh_comm), 300, '手改的不被覆盖'); assert.equal(Number(r.wh_comm_auto), 500);
});
