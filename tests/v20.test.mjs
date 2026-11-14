// 0048: Roland 公户两个账户 (Frank 11-14) —— 老库有公司时补两个账户, 持有人 = 名字带 ROLAND 的员工; 重跑不重复
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './harness.mjs';

test('v20: Roland 公户 · Wave / 银行 两个账户, 持有人 Roland, 重跑不重复', async () => {
  const { db, ids } = await setup();
  const ro = (await db.query(`insert into app.employees (org_id, short_name, full_name) values ($1,'Roland','ROLAND KOUAME') returning id`, [ids.org])).rows[0].id;
  const sql = readFileSync(new URL('../supabase/migrations/0048_roland_accounts.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  const r = (await db.query(`select name, kind, currency, holder_employee_id, hold_limit::int, hold_days from app.cash_accounts where org_id = $1 and name like 'Roland 公户%' order by name`, [ids.org])).rows;
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.kind).sort(), ['bank', 'wave']);
  assert.ok(r.every((x) => x.holder_employee_id === ro && x.currency === 'XOF' && x.hold_limit === 5000000 && x.hold_days === 7));
});
