// The browser demo loads exactly these migrations + seed. This keeps the demo honest against the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyMigrations, seedDemo } from '../src/db/bootstrap.js';
import * as Q from '../src/db/queries.js';

const MIG = new URL('../supabase/migrations/', import.meta.url).pathname;

test('演示数据：迁移 + 种子数据在真实规则下全部跑通，看板与总账口径一致', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort().map((f) => [f, readFileSync(join(MIG, f), 'utf8')]);
  await applyMigrations(db, files);
  const { org } = await seedDemo(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;

  const statuses = (await q(`select status, count(*)::int n from app.deals where kind='normal' group by 1 order by status::text`))
    .map((r) => `${r.status}:${r.n}`).join(',');
  assert.equal(statuses, 'confirmed:1,picking:1,quoted:4,shipped:3');   // quoted 含 1 张客户下单端的单 + 2 张销售询单

  const bal = await q(Q.balances, [org]);
  const soum = bal.find((b) => b.code === 'C003');
  // opening 850000 + shipped A − receipt 1 500 000
  assert.ok(Number(soum.balance) > 0, 'SOUMAHORO 仍欠款');
  assert.equal(Number(soum.balance), Number(soum.total_sold) - Number(soum.total_paid) - Number(soum.total_returned));

  const dash = (await q(Q.dashboard, [org, '1900-01-01', '2999-01-01']))[0];
  const shippedSum = (await q(`select sum(amount) s from app.shipments`))[0].s;
  assert.equal(Number(dash.sales_amount), Number(shippedSum));

  const unmet = await q(Q.unmet, [org]);
  assert.ok(unmet.some((u) => u.kind === 'no_code' && u.model === 'SPARK 30 PRO'));
  assert.ok(unmet.some((u) => u.kind === 'short'), '0 库存的 BD4 进缺口');

  // every read query used by the UI must at least run
  for (const [name, sql] of Object.entries(Q)) {
    if (typeof sql !== 'string') continue;
    const n = (sql.match(/\$\d+/g) || []).reduce((m, s) => Math.max(m, Number(s.slice(1))), 0);
    const params = [org, '1900-01-01', '2999-01-01', null].slice(0, n);
    if (name === 'dealById' || name === 'dealLines' || name === 'dealEvents' || name === 'dealShipments' || name === 'dealReturns' || name === 'dealReceipts')
      params[0] = (await q(`select id from app.deals limit 1`))[0].id;
    const cust = (await q(`select id from app.customers where code='C003'`))[0].id;
    if (['customerLedger', 'customerOpenDeals', 'customerSettledDeals'].includes(name)) { params[0] = cust; params[1] = 'XOF'; }
    if (['customerCurrencies', 'customerReturnable', 'customerReturns', 'customerContacts', 'portalCatalog', 'portalOrders', 'portalStores'].includes(name)) params[0] = cust;
    if (['fobById', 'fobLines', 'fobPayments', 'fobEvents'].includes(name)) params[0] = (await q(`select id from app.fob_projects limit 1`))[0].id;
    if (name === 'kdShipmentLines') params[0] = (await q(`select id from app.kingdee_outbox limit 1`))[0].id;
    if (name === 'storeOrders') { params[0] = null; params[1] = null; }
    if (['sopList', 'attendanceMine', 'myInquiries'].includes(name)) params[1] = '00000000-0000-0000-0000-00000000000a';
    if (['poDetail'].includes(name)) params[0] = (await q(`select id from app.purchase_orders limit 1`))[0]?.id || null;
    if (name === 'attendanceMonth') params[1] = '2026-10';
    if (name === 'customerBalance') { params[0] = cust; params[1] = 'XOF'; }
    if (name === 'searchProducts') { params[1] = '%BG6M%'; }
    if (name === 'materialSearch') params[1] = 'A05';
    if (name === 'proofUses') params[1] = 'abc';
    if (name === 'dashCards') { params[3] = '1800-01-01'; params[4] = '1899-12-31'; }
    if (name === 'employeeFiles') params[0] = null;
    if (name === 'myAppeals') params[1] = '00000000-0000-0000-0000-00000000000a';
    if (['orgFile', 'orgFileData'].includes(name)) params[1] = 'customs';
    if (name === 'salesByOwner') params[1] = '2026-10-01';
    if (name === 'issues') params[1] = 'open';
    if (['attendanceOfEmp', 'appealsOfEmp'].includes(name)) { params[1] = '00000000-0000-0000-0000-00000000000a'; params[2] = '2026-10-01'; }
    try { await q(sql, params); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});
