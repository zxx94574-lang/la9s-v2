// Test harness: real migrations on embedded Postgres (PGlite), with a Supabase-compatible auth.uid() stub.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIG = new URL('../supabase/migrations/', import.meta.url).pathname;

export const U = {
  admin: '00000000-0000-0000-0000-00000000000a',
  manager: '00000000-0000-0000-0000-00000000000b',
  picker: '00000000-0000-0000-0000-00000000000c',
  hotline: '00000000-0000-0000-0000-00000000000d',
  finance: '00000000-0000-0000-0000-00000000000e',
  outsider: '00000000-0000-0000-0000-00000000000f',
};

export async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role authenticated nologin;
    create schema auth;
    grant usage on schema auth to authenticated;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant execute on function auth.uid() to authenticated;`);
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIG, f), 'utf8'));
  }
  const ids = {};
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  await db.exec(`
    insert into app.currencies values ('XOF',0),('CNY',2),('USD',2);
    insert into app.countries values ('CI','科特迪瓦','Côte d''Ivoire','XOF');`);
  ids.org = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('hq','LA&9S CI','CI','XOF','CI') returning id`)).id;
  ids.otherOrg = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('hq','Other','CI','XOF','XX') returning id`)).id;
  ids.picker = (await one(`insert into app.employees (org_id, short_name) values ($1,'Abowa') returning id`, [ids.org])).id;
  ids.reviewer = (await one(`insert into app.employees (org_id, short_name) values ($1,'Grace') returning id`, [ids.org])).id;   // 0044: 找货人和复核人不能同一个人
  ids.sales = (await one(`insert into app.employees (org_id, short_name) values ($1,'Koffi') returning id`, [ids.org])).id;
  for (const [u, roles] of [[U.admin, '{admin}'], [U.manager, '{manager}'], [U.picker, '{picker}'], [U.hotline, '{hotline}'], [U.finance, '{finance}']]) {
    await db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,$3)`, [u, ids.org, roles]);
  }
  await db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{admin}')`, [U.outsider, ids.otherOrg]);

  ids.catScreen = (await one(`insert into app.categories (org_id,name) values ($1,'屏幕') returning id`, [ids.org])).id;
  ids.catCover = (await one(`insert into app.categories (org_id,name) values ($1,'电池盖') returning id`, [ids.org])).id;
  const prod = async (code, cat, model, prices) => {
    const id = (await one(`insert into app.products (org_id,code,category_id,model) values ($1,$2,$3,$4) returning id`, [ids.org, code, cat, model])).id;
    for (const [tier, p] of Object.entries(prices)) await db.query(`insert into app.product_prices values ($1,$2,'XOF',$3)`, [id, tier, p]);
    return id;
  };
  ids.bg6mScreen = await prod('1001', ids.catScreen, 'BG6M', { S: 3000, WHOLESALE: 3300, RETAIL: 3600, REPAIR: 4000 });
  ids.bg6mCover = await prod('1002', ids.catCover, 'BG6M', { S: 500, WHOLESALE: 550, RETAIL: 600, REPAIR: 700 });
  ids.x6516 = await prod('1003', ids.catScreen, 'X6516', { S: 2000, WHOLESALE: 2200, RETAIL: 2400, REPAIR: 2600 });

  const wh = async (code, kind) => (await one(`insert into app.warehouses (org_id,code,name,kind) values ($1,$2,$2,$3) returning id`, [ids.org, code, kind])).id;
  ids.whLA = await wh('LA', 'local'); ids.wh9S = await wh('9S', 'local'); ids.whFOB = await wh('FOB', 'fob');
  ids.whPending = await wh('PENDING', 'pending'); ids.whScrap = await wh('SCRAP', 'scrap');
  const stock = async (wh, prod, qty, bin) => (await one(`insert into app.stock_items (warehouse_id,product_id,qty_on_hand,bin) values ($1,$2,$3,$4) returning id`, [wh, prod, qty, bin])).id;
  ids.stLA_bg6m = await stock(ids.whLA, ids.bg6mScreen, 60, 'A-1-2');
  ids.st9S_bg6m = await stock(ids.wh9S, ids.bg6mScreen, 50, 'B-3-1');
  ids.stLA_cover = await stock(ids.whLA, ids.bg6mCover, 500, 'A-2-1');
  ids.st9S_x6516 = await stock(ids.wh9S, ids.x6516, 200, 'B-1-1');
  ids.stFOB_x6516 = await stock(ids.whFOB, ids.x6516, 1000, null);

  const cust = async (code, name, city, tier) => (await one(
    `insert into app.customers (org_id,code,name,city,status,tier,owner_employee_id) values ($1,$2,$3,$4,'active',$5,$6) returning id`,
    [ids.org, code, name, city, tier, ids.sales])).id;
  ids.camaraAbobo = await cust('C001', 'CAMARA', 'Abobo', 'WHOLESALE');
  ids.camaraOme = await cust('C002', 'CAMARA', 'Ome', 'REPAIR');
  ids.bigS = await cust('C003', 'SOUMAHORO', 'Adjamé', 'S');

  // helpers bound to this db
  const as = async (uid, sql, params = []) => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
    try { return (await db.query(sql, params)).rows; }
    finally { await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
  };
  const val = async (uid, sql, params) => Object.values((await as(uid, sql, params))[0])[0];
  const stockOf = async (id) => one(`select qty_on_hand, qty_reserved from app.stock_items where id=$1`, [id]);
  const balance = async (cust, cur = 'XOF') => Number((await one(`select coalesce(sum(amount),0) b from app.ar_entries where customer_id=$1 and currency=$2`, [cust, cur])).b);
  const due = async (deal) => Number((await one(`select due from app.v_deal_due where deal_id=$1`, [deal])).due);
  const lines = async (deal) => (await db.query(`select * from app.deal_lines where deal_id=$1 order by seq`, [deal])).rows;
  const status = async (deal) => (await one(`select status from app.deals where id=$1`, [deal])).status;

  // full happy path up to 'confirmed'
  // 0007 order: 初拣 → 销售订单 → 客户确认 → 复检打包 → 出库. `review:false` stops at 'confirmed'.
  // 0045: 销售员欠款不出货默认开; 老测试用固定的过去日期出库, 这里先关掉, v18 里单独打开测
  await db.query(`insert into app.org_settings (org_id, key, value) values ($1,'rep_debt_rules','{"on":false}')`, [ids.org]);
  const toConfirmed = async (customer, lineSpec, { manualConfirm = false, review = true } = {}) => {
    const deal = await val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [ids.org, customer, JSON.stringify(lineSpec)]);
    await as(U.manager, `select app.start_picking($1)`, [deal]);
    await as(U.picker, `select app.submit_pick($1,$2,'photo://pick.jpg','[]')`, [deal, ids.picker]);
    await as(U.manager, `select app.create_sales_order($1,$2)`, [deal, manualConfirm]);
    await as(U.hotline, `select app.customer_confirm($1,null,'whatsapp','proof://ok.jpg')`, [deal]);
    if (review) await as(U.manager, `select app.review_pick($1,$2,'photo://pack.jpg')`, [deal, ids.reviewer]);
    return deal;
  };
  const shipAll = (deal, items = null, at = '2026-10-27T10:00:00Z') =>
    val(U.manager, `select app.ship($1,$2,'yango_moto','+2250700000000','Abobo marché','proof://yango.jpg',$3)`,
      [deal, at, items && JSON.stringify(items)]);

  return { db, ids, as, val, one, stockOf, balance, due, lines, status, toConfirmed, shipAll };
}
