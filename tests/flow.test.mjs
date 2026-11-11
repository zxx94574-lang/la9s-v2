// 0005 flow controls — acceptance scenarios from docs/待改清单.md (Frank 2026-10-28)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const quote = (t, cust, lines) => t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, cust, JSON.stringify(lines)]);

test('撤回下推：找货单撤回释放预占；一步一步往回；已出库不能撤；找货员不能撤', async () => {
  const t = await setup();
  const d = await quote(t, t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 100 }]);
  await t.as(U.hotline, `select app.hotline_confirm($1,'ok','phone')`, [d]);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 100);
  await rejects(t.as(U.picker, `select app.revert_step($1,'x')`, [d]), /PERMISSION_DENIED/);
  await rejects(t.as(U.manager, `select app.revert_step($1,'')`, [d]), /必须选原因/);
  assert.equal(await t.val(U.manager, `select app.revert_step($1,'客户改数量')`, [d]), 'hotline_ok');
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 0, '预占释放');
  assert.equal((await t.one(`select pick_no from app.deals where id=$1`, [d])).pick_no, null);
  assert.equal(await t.val(U.manager, `select app.revert_step($1,'客户改数量')`, [d]), 'quoted');
  await rejects(t.as(U.manager, `select app.revert_step($1,'x')`, [d]), /BAD_STATE/);

  const d2 = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);   // 已复检打包
  assert.equal(await t.val(U.manager, `select app.revert_step($1,'打包有误')`, [d2]), 'confirmed');
  assert.equal(await t.val(U.manager, `select app.revert_step($1,'客户要改')`, [d2]), 'ordered');
  assert.equal((await t.one(`select confirm_proof from app.deals where id=$1`, [d2])).confirm_proof, null);
  assert.equal(await t.val(U.manager, `select app.revert_step($1,'价格重谈')`, [d2]), 'picked');
  await t.as(U.manager, `select app.create_sales_order($1)`, [d2]);
  await t.as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','p.jpg')`, [d2]);
  await t.as(U.manager, `select app.review_pick($1,$2,'pack.jpg')`, [d2, t.ids.picker]);
  await t.shipAll(d2);
  await rejects(t.as(U.manager, `select app.revert_step($1,'x')`, [d2]), /BAD_STATE/);
});

test('新顺序：初拣直接出销售订单；客户确认后才复检打包；复检少了回到待确认，只标变动行；再确认不用重检', async () => {
  const t = await setup();
  const d = await quote(t, t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 100 }]);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  await t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg','[]')`, [d, t.ids.picker]);
  const [l] = await t.lines(d);
  assert.equal(l.qty_picked, 100);
  await rejects(t.as(U.manager, `select app.review_pick($1,$2,'r.jpg')`, [d, t.ids.picker]), /BAD_STATE/);   // 还没客户确认
  await t.as(U.manager, `select app.create_sales_order($1)`, [d]);
  await rejects(t.shipAll(d), /BAD_STATE/);
  await t.as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','ok.jpg')`, [d]);
  assert.equal(await t.status(d), 'confirmed');
  await rejects(t.shipAll(d), /BAD_STATE/);                                                                 // 没复检不能出库
  await rejects(t.as(U.picker, `select app.review_pick($1,$2,'r.jpg')`, [d, t.ids.picker]), /PERMISSION_DENIED/);   // 只有主管
  await rejects(t.as(U.manager, `select app.review_pick($1,null,'r.jpg')`, [d]), /复核人必选/);
  await rejects(t.as(U.manager, `select app.review_pick($1,$2,'')`, [d, t.ids.picker]), /打包照片必传/);
  await rejects(t.as(U.manager, `select app.review_pick($1,$2,'r.jpg','[]',$3)`, [d, t.ids.picker,
    JSON.stringify([{ line_id: l.id, result: 'qty_wrong' }])]), /抽检有问题/);
  await rejects(t.as(U.manager, `select app.review_pick($1,$2,'r.jpg',$3)`, [d, t.ids.picker,
    JSON.stringify([{ line_id: l.id, qty: 95 }])]), /必须填原因/);
  assert.equal(await t.val(U.manager, `select app.review_pick($1,$2,'r.jpg',$3,$4)`, [d, t.ids.picker,
    JSON.stringify([{ line_id: l.id, qty: 95, reason: '少一盒' }]), JSON.stringify([{ line_id: l.id, result: 'qty_wrong' }])]), 'ordered');
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 95);
  const [l2] = await t.lines(d);
  assert.equal(l2.qty_supply, 95); assert.equal(l2.review_changed, true);
  assert.equal((await t.one(`select confirm_proof from app.deals where id=$1`, [d])).confirm_proof, null, '要客户重新确认');
  await t.as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','ok2.jpg')`, [d]);
  assert.equal(await t.status(d), 'reviewed', '已复检过，再确认直接到待出库');
  assert.equal((await t.lines(d))[0].review_changed, false);
  await t.shipAll(d);
  assert.equal(await t.status(d), 'shipped');
});

test('客户最终确认：方式 + 截图必填；约定发货日期记录', async () => {
  const t = await setup();
  const d = await quote(t, t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  await t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg','[]')`, [d, t.ids.picker]);
  await t.as(U.manager, `select app.create_sales_order($1)`, [d]);
  await rejects(t.as(U.hotline, `select app.customer_confirm($1)`, [d]), /确认方式/);
  await rejects(t.as(U.hotline, `select app.customer_confirm($1,null,'phone','')`, [d]), /必须上传截图/);
  await t.as(U.hotline, `select app.customer_confirm($1,'明天发','phone','shot.jpg','2026-11-02')`, [d]);
  const r = await t.one(`select confirm_method, planned_ship_date::text d, status::text s from app.deals where id=$1`, [d]);
  assert.deepEqual(r, { confirm_method: 'phone', d: '2026-11-02', s: 'confirmed' });
});

test('解锁改数量：要原因；同步预占；加量后要重新确认并重新复检；不能少于已出库', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);
  const [l] = await t.lines(d);
  await rejects(t.as(U.manager, `select app.change_line_qty($1,20,'')`, [l.id]), /必须选原因/);
  await rejects(t.as(U.hotline, `select app.change_line_qty($1,20,'客户改数量')`, [l.id]), /PERMISSION_DENIED/);
  await t.as(U.manager, `select app.change_line_qty($1,20,'客户改数量')`, [l.id]);
  assert.equal(await t.status(d), 'ordered');
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 20);
  await t.as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','p.jpg')`, [d]);
  assert.equal(await t.status(d), 'confirmed', '加了货要重新复检');
  await t.as(U.manager, `select app.review_pick($1,$2,'pack2.jpg')`, [d, t.ids.picker]);
  await t.shipAll(d, [{ line_id: l.id, qty: 8 }]);
  await rejects(t.as(U.manager, `select app.change_line_qty($1,5,'客户不要了')`, [l.id]), /不能少于已出库/);
  await t.as(U.manager, `select app.change_line_qty($1,8,'客户不要了')`, [l.id]);
  assert.equal(await t.status(d), 'partial');
  assert.equal((await t.stockOf(t.ids.stLA_cover)).qty_reserved, 0);
});

test('撤销出库（发货失败）：货回原仓并重新预占，应收冲回，已收转预付；签收后不能撤', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 10 }]);   // 550 × 10
  const ship = await t.shipAll(d);
  await t.as(U.finance, `select app.record_receipt($1,$2,current_date,5500,'XOF','cash')`, [t.ids.org, t.ids.camaraAbobo]);
  assert.equal(await t.due(d), 0);
  await rejects(t.as(U.manager, `select app.void_shipment($1,'')`, [ship]), /必须选原因/);
  await t.as(U.manager, `select app.void_shipment($1,'Yango 去不了')`, [ship]);
  assert.equal(await t.status(d), 'reviewed');
  assert.deepEqual(await t.stockOf(t.ids.stLA_cover), { qty_on_hand: 500, qty_reserved: 10 });
  assert.equal(await t.balance(t.ids.camaraAbobo), -5500, '已收款变成预付');
  assert.equal(await t.due(d), 0, '撤销后本单不欠也不多');
  const ship2 = await t.shipAll(d);
  assert.equal(await t.due(d), 0, '再次出库时预付自动抵扣');
  assert.equal(await t.balance(t.ids.camaraAbobo), 0);
  await t.as(U.manager, `select app.mark_received($1)`, [ship2]);
  await rejects(t.as(U.manager, `select app.void_shipment($1,'x')`, [ship2]), /已签收/);
});

test('预付自动抵扣：先付 1000 记预付，出库 550 时自动冲掉，剩 450 仍为预付', async () => {
  const t = await setup();
  await t.as(U.finance, `select app.record_receipt($1,$2,current_date,1000,'XOF','wave','XOF',1,'none')`, [t.ids.org, t.ids.camaraAbobo]);
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 1 }]);   // 550
  await t.shipAll(d);
  assert.equal(await t.due(d), 0);
  assert.equal(Number((await t.one(`select unallocated from app.v_receipt_open`)).unallocated), 450);
  assert.equal(await t.balance(t.ids.camaraAbobo), -450);
});

test('单价 0：未经中方改价不能出销售订单；中方注明赠品后可以', async () => {
  const t = await setup();
  const d = await quote(t, t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]);
  await t.as(U.manager, `select app.start_picking($1)`, [d]);
  await t.as(U.picker, `select app.submit_pick($1,$2,'p.jpg','[]')`, [d, t.ids.picker]);
  await t.db.query(`update app.deal_lines set unit_price = 0 where deal_id = $1`, [d]);
  await rejects(t.as(U.manager, `select app.create_sales_order($1,true)`, [d]), /单价为 0/);
  const [l] = await t.lines(d);
  await t.as(U.admin, `select app.set_line_price($1,0,'赠品')`, [l.id]);
  await t.as(U.manager, `select app.create_sales_order($1,true)`, [d]);
  assert.equal(await t.status(d), 'ordered');
});

test('退货批次、机型改名合并（只中方）、抹零上限', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 3 }]);
  await t.shipAll(d);
  const [l] = await t.lines(d);
  const rt = await t.val(U.hotline, `select app.request_return($1,'quality','坏',$2,'B-1')`, [d, JSON.stringify([{ line_id: l.id, qty: 1 }])]);
  assert.equal((await t.one(`select batch_no from app.returns where id=$1`, [rt])).batch_no, 'B-1');

  await quote(t, t.ids.camaraAbobo, [{ req_category_id: t.ids.catScreen, req_model: 'ssa05s', qty_req: 3 }]);
  await rejects(t.as(U.manager, `select app.rename_model($1,null,'SSA05S','SS A05S','统一')`, [t.ids.org]), /PERMISSION_DENIED/);
  assert.equal(await t.val(U.admin, `select app.rename_model($1,null,'SSA05S','ss  a05s','统一')`, [t.ids.org]), 1);
  assert.ok(await t.one(`select 1 from app.v_unmet_demand where model = 'SS A05S'`));
  await rejects(t.as(U.admin, `select app.rename_model($1,null,'BG6M','X6516','x')`, [t.ids.org]), /CONFLICT/);

  await t.db.query(`update app.deal_lines set unit_price = 550.4 where id = $1`, [l.id]);
  await rejects(t.as(U.admin, `select app.write_off($1,500,'尾差')`, [d]), /抹零/);
});

test('品牌：只中方能改；空字符串清空', async () => {
  const t = await setup();
  await rejects(t.as(U.manager, `select app.set_brand($1,$2,'itel')`, [t.ids.org, [t.ids.bg6mCover]]), /PERMISSION_DENIED/);
  assert.equal(await t.val(U.admin, `select app.set_brand($1,$2,' itel ')`, [t.ids.org, [t.ids.bg6mCover]]), 1);
  assert.equal((await t.one(`select brand from app.products where id=$1`, [t.ids.bg6mCover])).brand, 'ITEL');
});

test('定价公式：到岸 = 向上进位(人民币 ÷ 0.0107 + 运费, 百位, Frank 11-11)；档位价 = 到岸 + FEE；锁定价不被重算；汇率只中方改', async () => {
  const t = await setup();
  const p = t.ids.bg6mCover;
  await rejects(t.as(U.manager, `select app.set_product_cost($1,110.26,200,500,1000,1500,3000)`, [p]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_product_cost($1,110.26,200,500,1000,1500,3000)`, [p]);   // 10304.67 + 200 = 10504.67 → 向上进到 10600
  const price = async (tier) => Number((await t.one(`select price from app.product_prices where product_id=$1 and tier=$2 and currency='XOF'`, [p, tier])).price);
  assert.equal(await price('S'), 11100); assert.equal(await price('WHOLESALE'), 11600); assert.equal(await price('RETAIL'), 12100); assert.equal(await price('REPAIR'), 13600);
  await t.as(U.admin, `select app.set_tier_price($1,'WHOLESALE',11900,true)`, [p]);
  await rejects(t.as(U.manager, `select app.set_price_settings($1,0.0105,0.01135,100)`, [t.ids.org]), /PERMISSION_DENIED/);
  await t.as(U.admin, `select app.set_price_settings($1,0.0105,0.01135,100)`, [t.ids.org]);       // 10500.95 + 200 = 10700.95 → 10800
  assert.equal(await price('S'), 11300);
  assert.equal(await price('WHOLESALE'), 11900, '锁定的一口价不动');
  await t.as(U.admin, `select app.set_tier_price($1,'WHOLESALE',null,false)`, [p]);
  assert.equal(await price('WHOLESALE'), 11800);
});
