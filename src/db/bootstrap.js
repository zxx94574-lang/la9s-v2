// Shared by the browser demo and the node test: apply migrations to an empty PGlite and load demo data.
// Demo data is fictitious. Never put real business data in the demo.
import { seedSops } from './sopDefaults.js';

export const USERS = {
  admin: '00000000-0000-0000-0000-00000000000a',   // 中方
  manager: '00000000-0000-0000-0000-00000000000b', // 仓库主管
  picker: '00000000-0000-0000-0000-00000000000c',  // 找货员
  hotline: '00000000-0000-0000-0000-00000000000d', // 热线
  finance: '00000000-0000-0000-0000-00000000000e', // 财务
  sales: '00000000-0000-0000-0000-000000000010',   // 销售 (外出拜访)
  sales_manager: '00000000-0000-0000-0000-000000000011', // 销售主管
  boss: '00000000-0000-0000-0000-0000000000b1',    // 客户老板 (客户下单端)
  clerk: '00000000-0000-0000-0000-0000000000c1',   // 门店店员
};

export const AUTH_STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists auth;
  grant usage on schema auth to authenticated;
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to authenticated;`;

export async function applyMigrations(db, migrations /* [[name, sql]] sorted */) {
  await db.exec(AUTH_STUB);
  for (const [, sql] of migrations) await db.exec(sql);
}

// run `sql` as a demo user (sets the JWT subject the business functions check)
export async function asUser(db, uid, sql, params = []) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  try { return (await db.query(sql, params)).rows; }
  finally { await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
}

const PRODUCTS = [
  // code, category, model, S price (XOF), shared models
  ['1001', 'LCD', 'BG6M', 3200, ['A70', 'POP8', 'SPARK 10C', 'HOT 30I']],
  ['1002', 'BACK COVER', 'BG6M', 650, []],
  ['1003', 'CHARGE BOARD', 'BG6M', 450, ['SPARK GO 2024']],
  ['1004', 'BATTERY', 'BG6M', 1500, ['BL-49NT']],
  ['1011', 'LCD', 'BF7', 3100, ['X6516', 'X6517', 'POP 7 PRO']],
  ['1012', 'BACK COVER', 'BF7', 600, []],
  ['1021', 'LCD', 'X650', 2800, ['KC8', 'HOT 8', 'HOT 8 LITE', 'SPARK 4', 'X653', 'X655', 'X657', 'KC2', 'KC6', 'POP 3 PLUS', 'BB2', 'BB4', 'HOT 9 PLAY', 'SMART 5']],
  ['1022', 'BATTERY', 'X650', 1400, []],
  ['1031', 'LCD', 'X6525', 3600, ['X6528', 'HOT 40I']],
  ['1032', 'BACK COVER', 'X6525', 700, []],
  ['1041', 'LCD', 'KJ5', 3300, ['SPARK 20', 'SPARK 20C']],
  ['1042', 'CHARGE BOARD', 'KJ5', 500, []],
  ['1051', 'LCD', 'SS A05', 3800, ['SS A05S', 'SS A055F']],
  ['1052', 'BATTERY', 'SS A05', 1900, []],
  ['1061', 'LCD', 'IP 11', 5200, ['IPHONE 11']],
  ['1062', 'BATTERY', 'IP 11', 2600, []],
  ['1071', 'LCD', 'CK7N', 4100, ['CAMON 20', 'CAMON 20 PRO']],
  ['1072', 'BACK COVER', 'CK7N', 800, []],
  ['1081', 'LCD', 'BD4', 2600, ['POP 5', 'POP 5 LTE', 'BD2']],
  ['1082', 'BATTERY', 'BD4', 1200, ['BL-39LV']],
];
const TIER_FACTOR = { S: 1, WHOLESALE: 1.1, RETAIL: 1.22, REPAIR: 1.35 };
const roundTo = (n, step) => Math.round(n / step) * step;

const CUSTOMERS = [
  // code, name, city, tier, phone
  ['C001', 'CAMARA', 'Abobo', 'WHOLESALE', '+225 07 00 00 01'],
  ['C002', 'CAMARA', 'Oumé', 'REPAIR', '+225 07 00 00 02'],
  ['C003', 'SOUMAHORO', 'Adjamé', 'S', '+225 07 00 00 03'],
  ['C004', 'BOUTIQUE SOLEIL', 'Yopougon', 'RETAIL', '+225 07 00 00 04'],
  ['C005', 'KONÉ TÉLÉCOM', 'Treichville', 'WHOLESALE', '+225 07 00 00 05'],
  ['C006', 'ATELIER HORIZON', 'Cocody', 'REPAIR', '+225 07 00 00 06'],
  ['C007', 'DIALLO MOBILE', 'Bouaké', 'S', '+225 07 00 00 07'],
];

export async function seedDemo(db) {
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const as = (u, sql, p) => asUser(db, u, sql, p);
  const val = async (u, sql, p) => Object.values((await as(u, sql, p))[0])[0];

  await db.exec(`
    insert into app.currencies values ('XOF',0),('CNY',2),('USD',2) on conflict do nothing;
    insert into app.countries values ('CI','科特迪瓦','Côte d''Ivoire','XOF') on conflict do nothing;`);
  const org = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('hq','LA&9S Côte d''Ivoire','CI','XOF','CI') returning id`)).id;

  await db.query(`insert into app.org_settings (org_id, key, value) values ($1,'rep_debt_rules','{"on":false}')`, [org]);   // 种子里的单用过去的日期出库, 造数据时先关掉
  const emp = async (short, full, dept, pos, role, extra = {}) =>
    (await one(`insert into app.employees (org_id, short_name, full_name, department, position, sys_role, email, phone, joined_on, sales_channel)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [org, short, full, dept, pos, role, extra.email || null, extra.phone || null, extra.joined || null, extra.channel || null])).id;
  const E = {
    frank: await emp('Frank', 'FRANK（演示）', 'DIRECTION', 'DIRECTION', 'admin'),
    abowa: await emp('Abowa', 'ABOWA DEMO', 'SPARE PARTS', 'STOCK MANAGER', 'manager', { joined: '2025-09-01', phone: '0700000001', email: 'abowa@example.com' }),
    yao: await emp('Yao', 'YAO DEMO', 'SPARE PARTS', 'STOCK STAFF', 'picker', { joined: '2026-01-15', phone: '0700000002' }),
    issa: await emp('Issa', 'ISSA DEMO', 'SPARE PARTS', 'STOCK STAFF', 'picker', { joined: '2026-06-02', phone: '0700000003' }),
    awa: await emp('Awa', 'AWA DEMO', 'SPARE PARTS', 'HOTLINE STAFF', 'hotline', { joined: '2026-03-10', phone: '0700000004', email: 'awa@example.com' }),
    mariam: await emp('Mariam', 'MARIAM DEMO', 'DIRECTION', 'ACCOUNTANT', 'finance', { joined: '2025-11-01', phone: '0700000005' }),
    koffi: await emp('Koffi', 'KOFFI DEMO', 'SPARE PARTS', 'SALES STAFF', 'sales', { joined: '2026-02-01', phone: '0700000006', channel: 'WHOLESALE' }),
    kouame: await emp('Kouamé', 'KOUAME DEMO', 'SPARE PARTS', 'SALES MANAGER', 'sales_manager', { joined: '2025-07-01', phone: '0700000007' }),
  };
  await db.query(`update app.employees set emp_no = case id when $1 then 'S01' when $2 then 'S00' end where id in ($1,$2)`, [E.koffi, E.kouame]);
  for (const [u, roles, e] of [[USERS.admin, '{admin}', E.frank], [USERS.manager, '{manager}', E.abowa], [USERS.picker, '{picker}', E.yao],
    [USERS.hotline, '{hotline}', E.awa], [USERS.finance, '{finance}', E.mariam], [USERS.sales, '{sales}', E.koffi], [USERS.sales_manager, '{sales_manager}', E.kouame]]) {
    await db.query(`insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,$4)`, [u, org, e, roles]);
  }

  const cats = {};
  let sort = 0;
  for (const c of ['LCD', 'BACK COVER', 'BATTERY', 'CHARGE BOARD']) {
    cats[c] = (await one(`insert into app.categories (org_id,name,sort) values ($1,$2,$3) returning id`, [org, c, sort++])).id;
  }

  const wh = async (code, name, kind) => (await one(`insert into app.warehouses (org_id,code,name,kind,supplier) values ($1,$2,$3,$4,$5) returning id`,
    [org, code, name, kind, code === '9S' ? '9S' : 'LA'])).id;
  const W = { LA: await wh('LA', 'LA 仓', 'local'), S9: await wh('9S', '9S 仓', 'local'), FOB: await wh('FOB', 'FOB 仓', 'fob'),
    PENDING: await wh('PENDING', '待检仓', 'pending'), SCRAP: await wh('SCRAP', '报废仓', 'scrap') };

  await db.query(`insert into app.price_settings (org_id) values ($1)`, [org]);
  const P = {}; const ST = {};
  let i = 0;
  for (const [code, cat, model, base, shared] of PRODUCTS) {
    const brand = model.startsWith('SS ') ? 'SAMSUNG' : model.startsWith('IP ') ? 'APPLE' : ['BG6M', 'BF7', 'KJ5', 'CK7N', 'BD4'].includes(model) ? 'TECNO' : 'ITEL';
    const id = (await one(`insert into app.products (org_id,code,category_id,model,shared_models,brand) values ($1,$2,$3,$4,$5,$6) returning id`,
      [org, code, cats[cat], model, shared, brand])).id;
    P[code] = id;
    for (const [tier, f] of Object.entries(TIER_FACTOR)) {
      await db.query(`insert into app.product_prices values ($1,$2,'XOF',$3)`, [id, tier, roundTo(base * f, 50)]);
    }
    // cost side of the price (demo): RMB cost + freight → landed; each tier's FEE = its price − landed (same formula as 飞书)
    const rmb = Math.round(base * 0.8 * 0.0107 * 100) / 100, freight = 100;
    const landed = roundTo(rmb / 0.0107 + freight, 100);
    const fee = (tier) => roundTo(base * TIER_FACTOR[tier], 50) - landed;
    await db.query(`update app.products set rmb_cost=$2, freight_xof=$3, fee_s=$4, fee_a=$5, fee_b=$6, fee_c=$7,
      brand_group=$8, cost_owner='LA' where id=$1`, [id, rmb, freight, fee('S'), fee('WHOLESALE'), fee('RETAIL'), fee('REPAIR'),
      cat === 'LCD' ? '屏幕' : cat === 'BATTERY' ? '电池' : cat === 'BACK COVER' ? '电池盖' : '小板']);
    // each code lives in ONE local warehouse (LA or 9S), like Frank's real setup
    const w = i % 3 === 2 ? W.S9 : W.LA;
    const qty = [120, 300, 80, 150, 90, 200, 60, 140, 45, 180, 75, 110, 40, 95, 30, 50, 65, 120, 0, 85][i];
    const bin = `${w === W.LA ? 'A' : 'B'}-${(i % 6) + 1}-${(i % 4) + 1}`;
    ST[code] = (await one(`insert into app.stock_items (warehouse_id,product_id,qty_on_hand,bin) values ($1,$2,$3,$4) returning id`, [w, id, qty, bin])).id;
    i++;
  }
  // 采购批次 (演示, 虚构): 每个物料 2–3 批, 单价有高有低, 一批是金蝶 USD 采购单
  {
    const pr = (await db.query(`select id, code, rmb_cost from app.products where org_id = $1 and rmb_cost is not null`, [org])).rows;
    let k = 0;
    for (const x of pr) {
      const c = Number(x.rmb_cost);
      const rows = [
        ['PO260712' + String(100 + k).slice(-3), '2026-07-12', 300, 'CNY', Math.round(c * 0.94 * 100) / 100],
        ['PO260905' + String(200 + k).slice(-3), '2026-09-05', 200, 'USD', Math.round(c / 7.1 * 10000) / 10000],
        ...(k % 2 ? [['PO261010' + String(300 + k).slice(-3), '2026-10-10', 150, 'CNY', Math.round(c * 1.06 * 100) / 100]] : []),
      ];
      for (const [po, d, q, cur, up] of rows) {
        await db.query(`insert into app.product_batches (org_id, product_id, po_no, ordered_on, qty, currency, unit_price, source) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [org, x.id, po, d, q, cur, up, cur === 'USD' ? 'kingdee' : 'manual']);
      }
      k++;
    }
  }
  // FOB project stock (never auto-matched for local orders) and one pending item
  await db.query(`insert into app.stock_items (warehouse_id,product_id,qty_on_hand,bin) values ($1,$2,1000,'项目货')`, [W.FOB, P['1011']]);
  await db.query(`insert into app.stock_items (warehouse_id,product_id,qty_on_hand,bin) values ($1,$2,3,'待检区')`, [W.PENDING, P['1001']]);

  const C = {};
  for (const [code, name, city, tier, phone] of CUSTOMERS) {
    C[code] = (await one(`insert into app.customers (org_id,code,name,city,status,tier,owner_employee_id,phone,country,source)
      values ($1,$2,$3,$4,'active',$5,$6,$7,'CI','import') returning id`, [org, code, name, city, tier, E.koffi, phone])).id;
  }
  await db.query(`insert into app.customers (org_id,temp_code,name,city,status,phone,source,owner_employee_id)
    values ($1,'T-0001','GBAGBO RÉPARATION','Marcory','prospect','+225 07 00 00 09','visit',$2)`, [org, E.koffi]);

  // ── demo deals, created through the real business functions ──
  const quote = (cust, lines) => val(USERS.hotline, `select app.create_quote($1,$2,'XOF',$3)`, [org, cust, JSON.stringify(lines)]);
  const L = (code, qty) => ({ product_id: P[code], qty_req: qty });
  const toConfirmed = async (deal, review = true) => {
    await as(USERS.hotline, `select app.hotline_confirm($1,'客户确认数量','whatsapp')`, [deal]);
    await as(USERS.manager, `select app.start_picking($1)`, [deal]);
    await as(USERS.picker, `select app.submit_pick($1,$2,'demo://pick-photo','[]')`, [deal, E.yao]);
    await as(USERS.manager, `select app.create_sales_order($1,false)`, [deal]);
    await as(USERS.hotline, `select app.customer_confirm($1,'客户已确认','whatsapp','demo://confirm-shot')`, [deal]);
    if (review) await as(USERS.manager, `select app.review_pick($1,$2,'demo://pack-photo')`, [deal, E.abowa]);
  };
  const ship = (deal) => val(USERS.manager, `select app.ship($1, now(), 'yango_moto', '+225 07 11 22 33', '客户店铺', 'demo://yango-proof')`, [deal]);
  const backdate = async (deal, days) => {
    const t = `now() - interval '${days} days'`;
    await db.query(`update app.deals set created_at = ${t} where id = $1`, [deal]);
    await db.query(`update app.shipments set shipped_at = ${t}, created_at = ${t} where deal_id = $1`, [deal]);
    await db.query(`update app.ar_entries set at = ${t} where deal_id = $1`, [deal]);
    await db.query(`update app.deal_events set at = ${t} where deal_id = $1`, [deal]);
  };

  // 期初欠款 (历史导入作为一单)
  const op = await val(USERS.finance, `select app.import_opening($1,'XOF',850000,'历史导入：期初欠款')`, [C.C003]);
  await db.query(`update app.ar_entries set at = now() - interval '30 days' where deal_id = $1`, [op]);
  await db.query(`update app.deals set created_at = now() - interval '30 days' where id = $1`, [op]);

  // A · SOUMAHORO (S) — shipped 12 days ago, paid in part (oldest-first clears opening, then part of A)
  const A = await quote(C.C003, [L('1001', 100), L('1011', 60), L('1021', 80), L('1004', 50)]);
  await toConfirmed(A); await ship(A); await backdate(A, 12);
  await as(USERS.finance, `select app.record_receipt($1,$2,(now() - interval '5 days')::date,1500000,'XOF','bank')`, [org, C.C003]);

  // B · CAMARA Abobo (WHOLESALE) — shipped 3 days ago, unpaid
  const B = await quote(C.C001, [L('1002', 120), L('1012', 80), L('1032', 60)]);
  await toConfirmed(B); await ship(B); await backdate(B, 3);

  // C · KONÉ TÉLÉCOM — shipped today, paid in cash today
  const Cd = await quote(C.C005, [L('1041', 20), L('1042', 30), L('1051', 10)]);
  await toConfirmed(Cd); await ship(Cd);
  await as(USERS.finance, `select app.record_receipt($1,$2,current_date,200000,'XOF','cash')`, [org, C.C005]);

  // D · DIALLO MOBILE — customer confirmed, waiting for 复检打包
  const D = await quote(C.C007, [L('1071', 30), L('1072', 40), L('1022', 25)]);
  await toConfirmed(D, false);

  // E · BOUTIQUE SOLEIL — picking (stock reserved); 1081 has 0 stock → short
  const Ed = await quote(C.C004, [L('1031', 15), L('1081', 20), L('1052', 10)]);
  await as(USERS.hotline, `select app.hotline_confirm($1,'客户确认数量','whatsapp')`, [Ed]);
  await as(USERS.manager, `select app.start_picking($1)`, [Ed]);

  // F · CAMARA Oumé — quote only, includes a model we never coded (未建档需求)
  await quote(C.C002, [L('1061', 5), L('1062', 5), { req_category_id: cats.LCD, req_model: 'SPARK 30 PRO', qty_req: 10 }]);

  // ── 客户档案 / 热线回访 / 拜访 / 欠款预警 (演示，虚构) ──
  await as(USERS.admin, `select app.set_customer_terms($1,1000000,30,true,$2)`, [C.C003, E.koffi]);   // 有协议大客户
  await as(USERS.admin, `select app.set_customer_terms($1,300000,15,false,$2)`, [C.C005, E.koffi]);
  await as(USERS.admin, `select app.set_customer_terms($1,150000,2,false,$2)`, [C.C001, E.koffi]);
  await db.query(`update app.customers set market='Adjamé Roxy', zone='Adjamé', shop_type='Wholesale shop', monthly_qty=800 where id=$1`, [C.C003]);
  const call = (c, line, ch, res, note, next, ago) => as(USERS.hotline,
    `with x as (select app.log_call($1,$2,$3,$4,$5,$6::date) id) update app.hotline_calls h set at = now() - ($7 || ' days')::interval from x where h.id = x.id`,
    [c, line, ch, res, note, next, String(ago)]);
  await call(C.C001, 'spare', 'call', 'order', '要 BG6M 盖子 20 个', null, 3);
  await call(C.C004, 'spare', 'whatsapp', 'quote', '问 KJ5 屏幕价格', null, 2);
  await call(C.C006, 'spare', 'call', 'no_answer', null, new Date(Date.now() + 864e5).toISOString().slice(0, 10), 1);
  await call(C.C002, 'spare', 'call', 'later', '月底再要', new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), 9);
  await call(C.C007, 'recycle', 'call', 'busy', '回收：店里忙，明天再打', new Date().toISOString().slice(0, 10), 1);
  const prospect = await val(USERS.sales, `select app.create_prospect($1,'TECH PLUS ANGRÉ','+225 05 00 00 11','Cocody','{"market":"Angré 8e tranche","shop_type":"Repair shop"}')`, [org]);
  await as(USERS.sales, `select app.log_visit($1,'interested',$2)`, [prospect, JSON.stringify({ photo: 'demo://shop-photo', activity: 'Réparation', products_wanted: 'LCD TECNO / ITEL',
    monthly_qty: '120', buys_from: 'Adjamé', transport: 'Yango moto', nearby_suppliers: '2', next_follow_on: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) })]);
  await as(USERS.sales, `select app.log_visit($1,'order',$2)`, [C.C006, JSON.stringify({ photo: 'demo://shop-photo-2', activity: 'Réparation', products_wanted: 'BATTERY', monthly_qty: '60', buys_from: 'LA9S' })]);
  await as(USERS.admin, `select app.import_customers($1,$2)`, [org, JSON.stringify([
    { name: 'RECUP KOUASSI', phone: '+225 01 00 00 21', city: 'Abobo', kind: 'recycle', recycle_type: 'Recycleurs', interested: true },
    { name: 'TECHNICIEN BAMBA', phone: '+225 01 00 00 22', city: 'Yopougon', kind: 'recycle', recycle_type: 'Techniciens', interested: false }])]);

  // ── 资金账户 (演示, 虚构): 公户在员工名下, 上限 500 万 / 7 天 ──
  const accBank = await val(USERS.admin, `select app.upsert_cash_account($1,null,'公户 · Mariam','bank','XOF',$2,5000000,7)`, [org, E.mariam]);
  await val(USERS.admin, `select app.upsert_cash_account($1,null,'Wave 收款','wave','XOF',$2,2000000,3)`, [org, E.awa]);
  await val(USERS.admin, `select app.upsert_cash_account($1,null,'门店现金','cash','XOF',$2,1000000,2)`, [org, E.abowa]);
  const dd = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  await as(USERS.finance, `select app.import_statement($1,$2)`, [accBank, JSON.stringify([
    { date: dd(9), amount: 1800000, ref: 'DEMO-FT01', payer: 'SOUMAHORO', desc: 'VIREMENT' },
    { date: dd(6), amount: 2600000, ref: 'DEMO-FT02', payer: 'DIALLO M', desc: 'VIREMENT' },
    { date: dd(5), amount: -1500000, ref: 'DEMO-FT03', desc: 'RETRAIT GUICHET' },
    { date: dd(2), amount: 950000, ref: 'DEMO-FT04', payer: 'KONE T', desc: 'VERSEMENT' },
    { date: dd(1), amount: 1200000, ref: 'DEMO-FT05', payer: 'ETS INCONNU', desc: 'VIREMENT' }])]);
  await as(USERS.hotline, `select app.record_payment_notice($1,950000,'XOF','bank',$2,'demo://pay-shot','客户 WhatsApp 发来转账截图')`, [C.C005, dd(2)]);
  await as(USERS.hotline, `select app.record_payment_notice($1,400000,'XOF','wave',$2,'demo://pay-shot-2',null)`, [C.C001, dd(0)]);
  await as(USERS.finance, `select app.request_handover($1,1000000,$2,'demo://handover')`, [accBank, dd(1)]);
  await as(USERS.finance, `select app.record_expense($1,15000,$2,'交通费（出租车 / Yango）','demo://taxi','送货 Yango')`, [accBank, dd(1)]);

  // ── 在途采购 + 库龄快照 (演示, 虚构) ──
  await as(USERS.admin, `select app.import_purchase_orders($1,$2)`, [org, JSON.stringify([
    { po_no: 'DEMO-CG-0101', supplier: '深圳供应商（演示）', mode: 'sea', ordered_on: dd(30), eta: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10), code: '1081', qty: 200 },
    { po_no: 'DEMO-CG-0101', code: '1031', qty: 150 },
    { po_no: 'DEMO-CG-0102', supplier: '广州供应商（演示）', mode: 'air', ordered_on: dd(5), eta: dd(-3), code: '1071', qty: 60 },
    { po_no: 'DEMO-CG-0102', model: 'SPARK 30 PRO', qty: 40 }])]);
  await db.query(`insert into app.stock_aging (org_id, as_of, product_id, warehouse_id, qty, a0_30, a31_90, a91_180, a181_365, a365)
    select $1, current_date - 10, s.product_id, s.warehouse_id, s.qty_on_hand,
      s.qty_on_hand * 6 / 10, s.qty_on_hand * 2 / 10, s.qty_on_hand / 10, case when p.code in ('1012','1041') then s.qty_on_hand - s.qty_on_hand * 9 / 10 else 0 end,
      case when p.code in ('1012','1041') then 0 else s.qty_on_hand - s.qty_on_hand * 9 / 10 end * 0
    from app.stock_items s join app.products p on p.id = s.product_id join app.warehouses w on w.id = s.warehouse_id and w.kind = 'local'`, [org]);

  // ── 0013 演示 (虚构): SOP、客户下单端 + 门店、FOB、工资、金蝶同步 ──
  await seedSops(as, USERS.admin, org);
  await db.exec(`insert into app.countries values ('TG','多哥','Togo','XOF') on conflict do nothing`);
  const corg = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('customer','SOUMAHORO','CI','XOF','SM') returning id`)).id;
  await db.query(`update app.customers set linked_org_id = $1 where id = $2`, [corg, C.C003]);
  await db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{boss}')`, [USERS.boss, corg]);
  const store = await val(USERS.admin, `select app.create_store($1,'Adjamé 2','Adjamé','Moussa（演示）')`, [C.C003]);
  await val(USERS.admin, `select app.create_store($1,'Yopougon Siporex','Yopougon','Awa K.（演示）')`, [C.C003]);
  const sorg = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix,parent_id) values ('store','ADJAMÉ 2','CI','XOF','S2',$1) returning id`, [corg])).id;
  await db.query(`update app.portal_stores set org_id = $1 where id = $2`, [sorg, store]);
  await db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{clerk}')`, [USERS.clerk, sorg]);
  await val(USERS.clerk, `select app.store_order($1,'周末前要')`, [JSON.stringify([{ product_id: P['1001'], model: 'BG6M', category: 'LCD', qty: 10 }, { product_id: P['1004'], model: 'BG6M', category: 'BATTERY', qty: 20 }])]);
  await val(USERS.boss, `select app.portal_order($1,'手机下单（演示）')`, [JSON.stringify([{ product_id: P['1011'], qty: 15 }, { product_id: P['1002'], qty: 40 }])]);

  // FOB: 一个多哥物流控货 (在途, 订金已付), 一个科特迪瓦仓库控货 (刚申请, 等中方定价)
  const f1 = await val(USERS.hotline, `select app.create_fob($1,$2,'TG','logistics','XOF',$3,'多哥客户，物流控货（演示）')`, [org, C.C007, JSON.stringify([{ product_id: P['1011'], qty: 500 }, { product_id: P['1021'], qty: 300 }])]);
  for (const l of (await db.query(`select id from app.fob_lines where project_id = $1`, [f1])).rows) await as(USERS.admin, `select app.set_fob_price($1,2600)`, [l.id]);
  await as(USERS.manager, `select app.fob_advance($1,'purchasing','{"po_no":"DEMO-PO-FOB-01"}')`, [f1]);
  await as(USERS.manager, `select app.fob_advance($1,'in_transit',$2)`, [f1, JSON.stringify({ logistics: '物流公司（演示）', tracking: 'DEMO-TRK-01', eta: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10) })]);
  await as(USERS.finance, `select app.record_fob_payment($1,'deposit',624000,current_date - 5,'bank','demo://fob-deposit')`, [f1]);
  await val(USERS.sales, `select app.create_fob($1,$2,'CI','warehouse','XOF',$3,'演示：等中方定价')`, [org, C.C003, JSON.stringify([{ product_id: P['1001'], qty: 1000 }, { model: 'SPARK 40', qty: 200 }])]);

  // 工资: 底薪 + 归属客户出库金额 2% (虚构数字)
  for (const [e, base, rate] of [[E.koffi, 120000, 2], [E.awa, 100000, 1], [E.abowa, 150000, null], [E.yao, 90000, null], [E.mariam, 110000, null]]) {
    const r = (await one(`select short_name, full_name, department, position, sys_role, phone, email, joined_on::text, sales_channel from app.employees where id = $1`, [e]));
    await as(USERS.admin, `select app.upsert_employee($1,$2,$3)`, [org, e, JSON.stringify({ ...r, base_salary: base, incentive_rate: rate, allowance: 10000 })]);
  }
  // 客户下单账号演示: CAMARA 开账号, 密码 demo1234 (只有演示版这样写死, 真实版只能中方开通拿临时密码)
  await db.query(`update app.customers set phone = '0700112233' where id = $1 and coalesce(phone,'') = ''`, [C.C001]);
  await as(USERS.admin, `select app.account_open($1,'0700112233')`, [C.C001]);
  await db.query(`update app.customer_accounts set pass_hash = crypt('demo1234', gen_salt('bf')), must_change = false where customer_id = $1`, [C.C001]);
  // 超期未发货演示: 把几张没出库的单往前挪 (30 小时 / 55 小时 / 5 天)
  { const open = (await db.query(`select id from app.deals where org_id = $1 and status not in ('shipped','cancelled') and created_at > now() - interval '1 hour' order by created_at limit 3`, [org])).rows;
    for (const [i, h] of [[0, 30], [1, 55], [2, 120]]) if (open[i]) await db.query(`update app.deals set created_at = now() - ($2 || ' hours')::interval where id = $1`, [open[i].id, String(h)]); }
  // 上个月: 已批准已付 (永久记录); 本月: 草稿
  await as(USERS.admin, `select app.payroll_open($1,(date_trunc('month', current_date) - interval '1 month')::date)`, [org]);
  await as(USERS.admin, `select app.payroll_set_header($1,(date_trunc('month', current_date) - interval '1 month')::date,$2)`, [org, JSON.stringify({ dept_label: 'SPARE PARTS', prepared_by: 'Kouamé（演示）', finance_check: '财务（演示）', approver: '中方（演示）' })]);
  await as(USERS.admin, `select app.payroll_set_line($1,(date_trunc('month', current_date) - interval '1 month')::date,$2,'{"days_worked":18,"cnps":9000}')`, [org, E.yao]);
  await as(USERS.admin, `select app.payroll_decide($1,(date_trunc('month', current_date) - interval '1 month')::date,'approve')`, [org]);
  await as(USERS.admin, `select app.payroll_decide($1,(date_trunc('month', current_date) - interval '1 month')::date,'pay',(date_trunc('month', current_date) - interval '3 days')::date)`, [org]);
  await as(USERS.admin, `select app.payroll_open($1,current_date)`, [org]);

  // 金蝶: 第一张已出库单签收 → 已保存待提交
  const ob = (await db.query(`select k.id, k.shipment_id from app.kingdee_outbox k order by k.updated_at limit 2`)).rows;
  for (const o of ob) await as(USERS.hotline, `select app.mark_received($1)`, [o.shipment_id]);
  if (ob[0]) await as(USERS.finance, `select app.kd_step($1,'save','XSCKD-DEMO-0001')`, [ob[0].id]);

  // ── 0014 演示 (虚构): 销售询单 (一张自动通过、一张等审批)、采购 / 物资申请、采购备注识别、打卡地点和打卡记录 ──
  await val(USERS.sales, `select app.create_inquiry($1,$2,$3,'客户在店里问的（演示）')`, [org, C.C006, JSON.stringify([{ product_id: P['1011'], qty_req: 10 }])]);
  await val(USERS.sales, `select app.create_inquiry($1,$2,$3,'客户嫌贵，想要便宜点（演示）')`, [org, C.C004, JSON.stringify([{ product_id: P['1001'], qty_req: 50, requested_price: 3300 }, { req_category_id: cats.LCD, req_model: 'HOT 50', qty_req: 20 }])]);
  await val(USERS.finance, `select app.save_purchase_request($1,null,$2,$3)`, [org, JSON.stringify({ kind: 'supplies', title: '仓库和热线工服（演示）', description: '蓝色，胸口印 LA&9S', need_by: dd(-30), planned_ship: dd(-5), mode: 'sea' }),
    JSON.stringify([{ item: '工服', spec: 'L 码 蓝色', qty: 12 }, { item: '工服', spec: 'XL 码 蓝色', qty: 8 }])]);
  const pr2 = await val(USERS.manager, `select app.save_purchase_request($1,null,$2,$3)`, [org, JSON.stringify({ kind: 'stock', title: '11 月屏幕补货（演示）', need_by: dd(-40), planned_ship: dd(-10), mode: 'sea' }),
    JSON.stringify([{ product_id: P['1001'], qty: 300 }, { product_id: P['1021'], qty: 200 }])]);
  await as(USERS.manager, `select app.advance_purchase_request($1,'ordered','{"po_no":"DEMO-CG-0103"}')`, [pr2]);
  await as(USERS.manager, `select app.advance_purchase_request($1,'shipped',$2)`, [pr2, JSON.stringify({ container: 'DEMO-柜 MSKU0000001', tracking: 'DEMO-入仓号 CG000001', eta: dd(-3) })]);
  await as(USERS.admin, `select app.set_po_remark($1,'DEMO-CG-0101',$2,$3)`, [org, '科特9S-LA；LA9S-1020-20261001-总成海运-1；12boxes 350pcs（演示）', JSON.stringify({ purpose: 'local', fob_customers: [], boxes: 12, pcs: 350 })]);
  await as(USERS.admin, `select app.set_po_remark($1,'DEMO-CG-0102',$2,$3)`, [org, '科特9S-LA；LA9S-1025-20261010-DIALLO FOB-1；20261012-总成空运-1；FOB和本地备货混装（演示）', JSON.stringify({ purpose: 'mixed', fob_customers: ['C007'], boxes: 4, pcs: 100 })]);
  for (const [name, kind, lat, lng, r] of [['LA 仓（演示）', 'warehouse', 5.3340, -4.0270, 150], ['Adjamé Roxy 市场（演示）', 'market', 5.3600, -4.0280, 300], ['Yopougon Siporex 市场（演示）', 'market', 5.3400, -4.0750, 300]]) {
    await as(USERS.admin, `select app.upsert_site($1,null,$2,$3,$4,$5,$6)`, [org, name, kind, lat, lng, r]);
  }
  await as(USERS.picker, `select app.clock($1,'in',5.3341,-4.0271,20)`, [org]);
  await as(USERS.manager, `select app.clock($1,'in',5.3342,-4.0268,30)`, [org]);
  await as(USERS.sales, `select app.clock($1,'in',5.3605,-4.0285,40)`, [org]);
  await as(USERS.hotline, `select app.clock($1,'in',5.3500,-4.0000,25)`, [org]);

  // ── 0018 演示 (第九版 11-07): 销售去了没登记的市场 → 自动记一个待起名的地点; 一张申诉; 一张出库单生成 BL 号
  await as(USERS.sales, `select app.clock($1,'out',5.3185,-4.0160,35)`, [org]);
  await as(USERS.sales, `select app.appeal_attendance($1, current_date - 1, '昨天早上先去 Diallo 店里送货，到市场晚了（演示）')`, [org]);
  const shipped = await val(USERS.admin, `select s.id from app.shipments s where s.org_id = $1 and s.voided_at is null order by s.shipped_at desc limit 1`, [org]);
  if (shipped) await as(USERS.manager, `select app.issue_bl($1)`, [shipped]);
  await as(USERS.admin, `update app.customers set contact_name = 'M. ' || initcap(split_part(name, ' ', 1)) where org_id = $1 and status = 'active' and contact_name is null`, [org]);

  await db.query(`update app.org_settings set value = '{"on":true}' where org_id = $1 and key = 'rep_debt_rules'`, [org]);   // 种子数据造完再打开「销售员欠款不出货」
  return { org };
}
