// 0046: 国内初略版 —— 采购单 / 箱单导入 / 按箱入库 / 在途 / 差额; 中国支持岗位; 报价草稿
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const CN = '00000000-0000-0000-0000-0000000000c9';
const addCn = (t) => t.db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{cn_support}')`, [CN, t.ids.org]);
const pl = (extra = {}) => ({
  batch_name: '20260715-KABRE海运-3批', date: '2026-08-27', inbound_no: 'cg2601995a', purpose: 'local',
  lines: [{ descr: 'X6516 LCD COMP', code: '1003', qty: 1000, unit_price: 31 }, { descr: 'bg6m  cover', qty: 50, unit_price: 5 }],
  boxes: [{ box_no: 1, descr: 'X6516 LCD COMP', qty: 576 }, { box_no: 2, descr: 'X6516 LCD COMP', qty: 424 }, { box_no: 3, descr: 'BG6M COVER', qty: 50 }], ...extra,
});
const transit = async (t, p) => (await t.db.query(`select coalesce(sum(remaining),0)::int r, coalesce(sum(fob_remaining),0)::int f from app.v_in_transit where product_id = $1`, [p])).rows[0];

test('箱单导入: 按料号对上、对不上的人工挑一次记住; 箱号挂在行上; 在途 = 没入库的', async () => {
  const t = await setup(); await addCn(t);
  await rejects(t.as(U.picker, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify(pl())]), /PERMISSION/);
  const r = await t.val(CN, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify(pl())]);
  assert.deepEqual(r.unmatched, ['BG6M COVER']);
  const po = r.po_id;
  assert.equal(Number(await t.val(U.admin, `select count(*) from app.po_boxes where po_id = $1`, [po])), 3);
  assert.deepEqual(await transit(t, t.ids.x6516), { r: 1000, f: 0 });
  // 人工对上 → 记住
  assert.equal(Number(await t.val(CN, `select app.map_descr($1,'BG6M COVER',$2)`, [t.ids.org, t.ids.bg6mCover])), 1);
  // 同一批再导一次 (覆盖, 不重复建单) → 这次自动对上
  const r2 = await t.val(CN, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify(pl())]);
  assert.equal(r2.po_id, po); assert.deepEqual(r2.unmatched, []);
  assert.equal((await t.one(`select warehouse_nos from app.purchase_orders where id = $1`, [po])).warehouse_nos.join(), 'CG2601995A');
});

test('按箱到货 → 下推采购入库单, 库存进 LA, 在途减少; 少到的差额只能中方选结果 + 凭证关掉', async () => {
  const t = await setup(); await addCn(t);
  await t.db.query(`insert into app.desc_map values ($1,'BG6M COVER',$2)`, [t.ids.org, t.ids.bg6mCover]);
  const { po_id: po } = await t.val(CN, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify(pl())]);
  const box = async (n) => t.val(U.admin, `select id from app.po_boxes where po_id = $1 and box_no = $2`, [po, n]);
  const laQty = async () => Number(await t.val(U.admin, `select coalesce(sum(s.qty_on_hand),0) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where w.code='LA' and s.product_id = $1`, [t.ids.x6516]));
  const before = await laQty();
  await rejects(t.as(U.manager, `select app.receive_boxes($1,$2,'LA','')`, [po, [await box(1)]]), /拍照/);
  await rejects(t.as(CN, `select app.receive_boxes($1,$2,'LA','p.jpg')`, [po, [await box(1)]]), /PERMISSION/);
  const g = await t.val(U.manager, `select app.receive_boxes($1,$2,'LA','p.jpg')`, [po, [await box(1), await box(3)]]);
  assert.ok(g);
  assert.deepEqual(await transit(t, t.ids.x6516), { r: 424, f: 0 });
  assert.equal(await laQty() - before, 576);
  await rejects(t.as(U.manager, `select app.receive_boxes($1,$2,'LA','p.jpg')`, [po, [await box(1)]]), /已经收过/);
  // 2 号箱没到 → 差额
  const line = await t.val(U.admin, `select id from app.po_lines where po_id = $1 and descr = 'X6516 LCD COMP'`, [po]);
  await rejects(t.as(U.manager, `select app.close_po_gap($1,'破损','p.jpg')`, [line]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.close_po_gap($1,'随便','p.jpg')`, [line]), /选一个结果/);
  await rejects(t.as(U.admin, `select app.close_po_gap($1,'破损','')`, [line]), /凭证/);
  assert.equal(Number(await t.val(U.admin, `select app.close_po_gap($1,'少发','p.jpg','国内确认少装一箱')`, [line])), 424);
  assert.deepEqual(await transit(t, t.ids.x6516), { r: 0, f: 0 });
  assert.equal(await t.val(U.admin, `select status from app.po_boxes where id = $1`, [await box(2)]), 'missing');
  assert.equal(await t.val(U.admin, `select status from app.purchase_orders where id = $1`, [po]), 'closed');
  // 到货后不能再用箱单覆盖
  await rejects(t.as(CN, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify(pl())]), /已经有到货记录/);
});

test('FOB 采购单: 在途算 FOB, 到货进 FOB 仓', async () => {
  const t = await setup(); await addCn(t);
  const fob = (await t.db.query(`insert into app.fob_projects (org_id, fob_no, customer_id, country, currency) values ($1,'FOB-1',$2,'CI','XOF') returning id`, [t.ids.org, t.ids.bigS])).rows[0].id;
  await rejects(t.as(CN, `select app.save_po($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ purpose: 'fob' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 10 }])]), /FOB 项目/);
  const fid = fob;
  const po = await t.val(CN, `select app.save_po($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ purpose: 'fob', fob_project_id: fid, inbound_no: 'TG1', batch_name: 'X-FOB-1' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 10, unit_price: 30 }])]);
  assert.deepEqual(await transit(t, t.ids.x6516), { r: 10, f: 10 });
  const fobBefore = Number(await t.val(U.admin, `select qty_on_hand from app.stock_items where id = $1`, [t.ids.stFOB_x6516]));
  const line = await t.val(U.admin, `select id from app.po_lines where po_id = $1`, [po]);
  await t.as(U.manager, `select app.receive_po_split($1,$2,'p.jpg')`, [po, JSON.stringify([{ line_id: line, fob_qty: 10 }])]);
  assert.equal(Number(await t.val(U.admin, `select qty_on_hand from app.stock_items where id = $1`, [t.ids.stFOB_x6516])) - fobBefore, 10);
});

test('报价草稿: 不够 5 行不存; 同一人同一客户只有一张; 自己的才能删', async () => {
  const t = await setup();
  const L = (n) => JSON.stringify({ lines: Array.from({ length: n }, (_, i) => ({ product_id: t.ids.x6516, qty_req: i + 1 })) });
  assert.equal(await t.val(U.hotline, `select app.save_quote_draft($1,$2,$3)`, [t.ids.org, t.ids.bigS, L(4)]), null);
  const a = await t.val(U.hotline, `select app.save_quote_draft($1,$2,$3)`, [t.ids.org, t.ids.bigS, L(5)]);
  const b = await t.val(U.hotline, `select app.save_quote_draft($1,$2,$3)`, [t.ids.org, t.ids.bigS, L(7)]);
  assert.equal(a, b); assert.equal(Number(await t.val(U.admin, `select n_lines from app.quote_drafts where id = $1`, [a])), 7);
  await rejects(t.as(U.manager, `select app.delete_quote_draft($1)`, [a]), /自己的草稿/);
  await t.db.query(`update app.quote_drafts set updated_at = now() - interval '8 days'`);
  assert.equal(Number(await t.val(U.manager, `select app.void_stale_drafts($1)`, [t.ids.org])), 1);
});

test('改采购单资料: 到了一部分也能改预计到货; 国内能改, 热线不能', async () => {
  const t = await setup();
  const r = await t.val(U.admin, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify({ batch_name: 'T-INFO-1', purpose: 'local', lines: [{ descr: 'X LCD', qty: 10 }], boxes: [{ box_no: 1, descr: 'X LCD', qty: 10 }] })]);
  const po = r.po_id;
  await t.as(U.cn_support || U.admin, `select app.set_po_info($1,$2)`, [po, JSON.stringify({ eta: '2026-12-01', note: '货代说晚一周' })]);
  assert.equal(String(await t.val(U.admin, `select eta::text from app.purchase_orders where id = $1`, [po])), '2026-12-01');
  await assert.rejects(t.as(U.hotline, `select app.set_po_info($1,$2)`, [po, JSON.stringify({ eta: '2026-12-05' })]), /PERMISSION|FORBIDDEN|权限|不能/);
});

test('箱单写法自动对上: 型号 + 种类名唯一才对; 同型号同种类有两个编码 (区分) 不自动', async () => {
  const t = await setup();
  const [u] = (await t.db.query(`select p.id, p.model, c.name as cat from app.products p join app.categories c on c.id = p.category_id
    where p.org_id = $1 and p.active group by p.id, p.model, c.name having (select count(*) from app.products x where x.org_id = p.org_id and x.active and upper(x.model) = upper(p.model) and x.category_id = p.category_id) = 1 limit 1`, [t.ids.org])).rows;
  const r = await t.val(U.admin, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify({ batch_name: 'T-AUTO-1', purpose: 'local', lines: [{ descr: `${u.model}/XYZ ${u.cat} COMP`, qty: 5 }] })]);
  assert.equal(r.unmatched.length, 0);
  assert.equal(await t.val(U.admin, `select product_id from app.po_lines where po_id = $1`, [r.po_id]), u.id);
  // 复制一个同型号同种类的编码 → 不再唯一 → 不自动
  await t.db.query(`insert into app.products (org_id, code, category_id, model, variant) select org_id, code || 'B', category_id, model, 'B' from app.products where id = $1`, [u.id]);
  const r2 = await t.val(U.admin, `select app.import_packing_list($1,$2)`, [t.ids.org, JSON.stringify({ batch_name: 'T-AUTO-2', purpose: 'local', lines: [{ descr: `${u.model} ${u.cat} COMP`, qty: 5 }] })]);
  assert.equal(r2.unmatched.length, 1);
});

test('FOB 采购单没有项目也能建, 但要写 FOB 客户', async () => {
  const t = await setup();
  const id = await t.val(U.admin, `select app.save_po($1,null,$2,$3)`, [t.ids.org, JSON.stringify({ purpose: 'fob', fob_customer: 'la9s-kabre' }), JSON.stringify([{ product_id: t.ids.x6516, qty: 10 }])]);
  assert.deepEqual(await t.val(U.admin, `select fob_customer_codes from app.purchase_orders where id = $1`, [id]), ['LA9S-KABRE']);
});
