// 0044: 订单号 / 运费流水 / 冻结库存 / 申请定级 / 提成记责 / 指令 / 打电话名单 / 价格调整 / 找货人≠复核人
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('订单号 CI-年月日-序号; 报价 / 找货 / 销售单 / 出库单跟着订单号走', async () => {
  const t = await setup();
  const d1 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const d2 = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.bigS, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 1 }])]);
  const a = await t.one(`select biz_no, quote_no, pick_no, so_no from app.deals where id = $1`, [d1]);
  const ymd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  assert.equal(a.biz_no, `CI-${ymd}-01`); assert.equal(a.quote_no, a.biz_no + '-Q'); assert.equal(a.pick_no, a.biz_no + '-P'); assert.equal(a.so_no, a.biz_no + '-O');
  assert.equal((await t.one(`select biz_no from app.deals where id = $1`, [d2])).biz_no, `CI-${ymd}-02`);
  await t.shipAll(d1);
  assert.equal(await t.val(U.admin, `select out_no from app.shipments where deal_id = $1`, [d1]), a.biz_no + '-S1');
});

test('运费: 四个账户已建好; 我们出 → 填实付, 自动记一笔 Wave-XOF 支出, 不动客户的账', async () => {
  const t = await setup();
  await t.db.query(`select app.ensure_cash_accounts($1)`, [t.ids.org]);
  assert.deepEqual((await t.db.query(`select name from app.cash_accounts where org_id = $1 order by name`, [t.ids.org])).rows.map((r) => r.name).filter((n) => /^(Cash|Wave)-/.test(n)), ['Cash-RMB', 'Cash-USD', 'Cash-XOF', 'Wave-XOF']);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1`, [d]);
  const bal0 = Number(await t.val(U.admin, `select coalesce(sum(amount),0) from app.ar_entries where customer_id = $1`, [t.ids.camaraAbobo]));
  await rejects(t.as(U.manager, `select app.record_ship_freight($1,'company',0,'p.jpg')`, [sh]), /实际付了多少/);
  await rejects(t.as(U.manager, `select app.record_ship_freight($1,'company',1990,'')`, [sh]), /截图/);
  const mv = await t.val(U.manager, `select app.record_ship_freight($1,'company',1990,'p.jpg')`, [sh]);
  const m = await t.one(`select m.kind, m.amount, m.category, a.name from app.cash_moves m join app.cash_accounts a on a.id = m.account_id where m.id = $1`, [mv]);
  assert.equal(m.kind, 'expense'); assert.equal(Number(m.amount), 1990); assert.equal(m.category, '本地物流费'); assert.equal(m.name, 'Wave-XOF');
  assert.equal(Number(await t.val(U.admin, `select coalesce(sum(amount),0) from app.ar_entries where customer_id = $1`, [t.ids.camaraAbobo])), bal0);
  await rejects(t.as(U.manager, `select app.record_ship_freight($1,'company',1990,'p.jpg')`, [sh]), /已经记过/);
});

test('问题库存: 冻结要凭证 → 可售立刻变少; 整个编码冻结时已预占的单也不能出库; 解冻 / 转待检仓都要凭证', async () => {
  const t = await setup();
  const free = async (id) => { const r = await t.one(`select qty_on_hand - qty_reserved as f, qty_on_hand as h from app.stock_items where id = $1`, [id]); return [Number(r.f), Number(r.h)]; };
  await rejects(t.as(U.manager, `select app.freeze_stock($1,10,'软件没升级','')`, [t.ids.stLA_cover]), /凭证/);
  await rejects(t.as(U.picker, `select app.freeze_stock($1,10,'x','p.jpg')`, [t.ids.stLA_cover]), /PERMISSION/);
  await rejects(t.as(U.manager, `select app.freeze_stock($1,9999,'x','p.jpg')`, [t.ids.stLA_cover]), /可售只有/);
  const h1 = await t.val(U.manager, `select app.freeze_stock($1,100,'老库存软件没升级','p.jpg')`, [t.ids.stLA_cover]);
  assert.deepEqual(await free(t.ids.stLA_cover), [400, 500]);
  await rejects(t.as(U.manager, `select app.close_stock_hold($1,'release','没问题','')`, [h1]), /凭证/);
  await t.as(U.manager, `select app.close_stock_hold($1,'release','升级完了，抽检 10 片正常','ok.jpg')`, [h1]);
  assert.deepEqual(await free(t.ids.stLA_cover), [500, 500]);
  // 整个编码: 已经确认待出库的单也发不了
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 20 }]);
  const h2 = await t.val(U.manager, `select app.freeze_stock($1,null,'整批怀疑有问题','p.jpg')`, [t.ids.stLA_cover]);
  assert.deepEqual(await free(t.ids.stLA_cover), [0, 500]);
  await rejects(t.shipAll(d), /暂停出库/);
  await t.as(U.manager, `select app.close_stock_hold($1,'to_pending','确认有问题，搬去待检仓','moved.jpg')`, [h2]);
  assert.deepEqual(await free(t.ids.stLA_cover), [0, 20]);          // 只剩这张单预占的 20 片
  assert.equal(Number(await t.val(U.admin, `select s.qty_on_hand from app.stock_items s where s.warehouse_id = $1 and s.product_id = $2`, [t.ids.whPending, t.ids.bg6mCover])), 480);
  await t.shipAll(d);
});

test('申请定级: 档位没确认的客户报价是草稿, 不能确认; 中方定档后自动按新档位重算, 才能往下走', async () => {
  const t = await setup();
  const c = await t.val(U.hotline, `select app.create_prospect($1,'NEW SHOP','0700000000','Abidjan','{}')`, [t.ids.org]);
  assert.equal((await t.one(`select tier, tier_confirmed_at from app.customers where id = $1`, [c])).tier, 'REPAIR');
  const d = await t.val(U.hotline, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 10 }])]);
  const px = async () => Number(await t.val(U.admin, `select unit_price from app.deal_lines where deal_id = $1`, [d]));
  assert.equal(await px(), 700);
  await rejects(t.as(U.hotline, `select app.quote_confirm($1,'ok','whatsapp',null,null,false)`, [d]), /档位|NEEDS_APPROVAL/);
  await t.as(U.hotline, `select app.request_tier($1,$2,'两个档口')`, [c, d]);
  assert.ok((await t.one(`select tier_requested_at from app.customers where id = $1`, [c])).tier_requested_at);
  await t.as(U.admin, `select app.activate_customer($1,'CI0900','RETAIL',null)`, [c]);
  await t.as(U.admin, `select app.confirm_customer_tier($1,'RETAIL','confirm',null,null)`, [c]);
  assert.equal(await px(), 600);
  assert.equal((await t.one(`select tier_requested_at from app.customers where id = $1`, [c])).tier_requested_at, null);
  if ((await t.one(`select approval from app.deals where id = $1`, [d])).approval === 'pending') await t.as(U.admin, `select app.approve_quote($1,true,'新客户，已定档')`, [d]);
  await t.as(U.hotline, `select app.quote_confirm($1,'ok','whatsapp',null,null,false)`, [d]);
});

test('草稿超过 7 天没人动 → 自动作废', async () => {
  const t = await setup();
  const c = await t.val(U.hotline, `select app.create_prospect($1,'OLD DRAFT','0700000001','Abidjan','{}')`, [t.ids.org]);
  const d = await t.val(U.hotline, `select app.create_quote_checked($1,$2,'XOF',$3)`, [t.ids.org, c, JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 1 }])]);
  assert.equal(Number(await t.val(U.hotline, `select app.void_stale_drafts($1)`, [t.ids.org])), 0);
  await t.db.query(`update app.deals set created_at = now() - interval '9 days' where id = $1`, [d]);
  await t.db.query(`update app.deal_events set at = now() - interval '9 days' where deal_id = $1`, [d]);
  assert.equal(Number(await t.val(U.hotline, `select app.void_stale_drafts($1)`, [t.ids.org])), 1);
  assert.equal(await t.val(U.admin, `select status from app.deals where id = $1`, [d]), 'cancelled');
});

test('找货人和复核人不能同一人 (中方除外); 发错记复检人 → 这张单提成取消', async () => {
  const t = await setup();
  const mk = async () => { const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }], { review: false }); return d; };
  const d = await mk();
  await rejects(t.as(U.manager, `select app.review_pick($1,$2,'photo://pack.jpg')`, [d, t.ids.picker]), /不能是同一个人/);
  await t.as(U.manager, `select app.review_pick($1,$2,'photo://pack.jpg')`, [d, t.ids.reviewer]);
  await t.shipAll(d);
  const d2 = await mk(); await t.as(U.admin, `select app.review_pick($1,$2,'photo://pack.jpg')`, [d2, t.ids.picker]);   // 只有一个仓管: 中方来点
  const com = async (deal) => t.one(`select employee_id, pieces, voided from app.v_wh_commission where deal_id = $1`, [deal]);
  let c = await com(d); assert.equal(c.employee_id, t.ids.reviewer); assert.equal(Number(c.pieces), 10); assert.equal(c.voided, false);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1`, [d]); await t.as(U.manager, `select app.sign_receipt($1,'s.jpg',now())`, [sh]);
  const line = await t.val(U.admin, `select deal_line_id from app.shipment_lines where shipment_id = $1`, [sh]);
  const x = await t.val(U.hotline, `select app.report_discrepancy($1,'short',$2,'p.jpg',null)`, [sh, JSON.stringify([{ deal_line_id: line, received: 9 }])]);
  await t.as(U.admin, `select app.decide_discrepancy($1,'credit','复检没查出来（复检人 Grace）','lost',null)`, [x]);
  assert.equal((await t.one(`select blame_employee_id from app.receipt_discrepancies where id = $1`, [x])).blame_employee_id, t.ids.reviewer);
  c = await com(d); assert.equal(c.voided, true);
});

test('指令: 可带多个附件; 超过 5 分钟才收到必须写原因', async () => {
  const t = await setup();
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2`, [t.ids.sales, U.hotline]);
  const id = await t.val(U.admin, `select app.issue_directive($1,$2)`, [t.ids.org, JSON.stringify({ title: '给这张表上的人打电话', assignee: t.ids.sales, attachments: [{ name: 'a.xlsx', data: 'x' }, { name: 'b.png', data: 'y' }] })]);
  assert.equal(Number(await t.val(U.admin, `select jsonb_array_length(attachments) from app.directives where id = $1`, [id])), 2);
  await t.db.query(`update app.directives set created_at = now() - interval '12 minutes' where id = $1`, [id]);
  await rejects(t.as(U.hotline, `select app.ack_directive2($1,null)`, [id]), /要写原因/);
  await t.as(U.hotline, `select app.ack_directive2($1,'在接客户电话')`, [id]);
  const r = await t.one(`select status, ack_reason from app.directives where id = $1`, [id]); assert.equal(r.status, 'acked'); assert.equal(r.ack_reason, '在接客户电话');
});

test('打电话名单: 中方建名单 → 热线逐行填结果 → 中方把愿意成交的设为潜客', async () => {
  const t = await setup();
  await rejects(t.as(U.hotline, `select app.create_call_list($1,'x',null,null,'[{"name":"A"}]')`, [t.ids.org]), /PERMISSION/);
  const l = await t.val(U.admin, `select app.create_call_list($1,'Adjamé 新店',null,null,$2)`, [t.ids.org, JSON.stringify([{ name: 'KONE', phone: '0711111111', city: 'Adjamé' }, { name: '', phone: '' }, { name: 'BAMBA', phone: '0722222222' }])]);
  const rows = (await t.db.query(`select id, name from app.call_list_rows where list_id = $1 order by seq`, [l])).rows; assert.equal(rows.length, 2);
  await t.as(U.hotline, `select app.set_call_result($1,'yes','想要 BG6M 屏')`, [rows[0].id]);
  await rejects(t.as(U.hotline, `select app.call_row_to_prospect($1)`, [rows[0].id]), /PERMISSION/);
  const c = await t.val(U.admin, `select app.call_row_to_prospect($1)`, [rows[0].id]);
  const cu = await t.one(`select name, status, tier_confirmed_at from app.customers where id = $1`, [c]); assert.equal(cu.name, 'KONE');
  assert.equal(await t.val(U.admin, `select app.call_row_to_prospect($1)`, [rows[0].id]), c);   // 再点不重复建
});

test('价格调整单: 出库后才用, 只中方, 要原因和凭证, 差额进客户总账', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  await rejects(t.as(U.admin, `select app.adjust_price($1,-500,'算错了','p.jpg')`, [d]), /还没出库/);
  await t.shipAll(d);
  const bal = async () => Number(await t.val(U.admin, `select coalesce(sum(amount),0) from app.ar_entries where customer_id = $1`, [t.ids.camaraAbobo]));
  const b0 = await bal();
  await rejects(t.as(U.manager, `select app.adjust_price($1,-500,'算错了','p.jpg')`, [d]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.adjust_price($1,-500,'算错了','')`, [d]), /凭证/);
  await t.as(U.admin, `select app.adjust_price($1,-500,'单价多收了 50','p.jpg')`, [d]);
  assert.equal(await bal(), b0 - 500);
});
