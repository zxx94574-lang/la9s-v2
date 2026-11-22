// 测试版数据: node 里跑一遍 = 迁移 + 10-19 数据包 + 场景, 输出检查结果
// 用法: REAL_DATA=…/real-data.json node scripts/test-seed.mjs  (real-data.json 是真实快照, 不进仓库)
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const R = new URL('../', import.meta.url).pathname;
const { applyMigrations } = await import(R + 'src/db/bootstrap.js');
const { seedReal } = await import(R + 'src/db/realSeed.js');
const MIG = R + 'supabase/migrations/';
const migs = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort().map((f) => [f, readFileSync(join(MIG, f), 'utf8')]);
const db = new PGlite({ extensions: { pgcrypto } });
let t = Date.now();
await applyMigrations(db, migs);
const data = JSON.parse(readFileSync(process.env.REAL_DATA || '/home/claude/tdata/real-data.json', 'utf8'));
const r = await seedReal(db, data.import, data.as_of);
console.log('seed', Date.now() - t, 'ms org', r.org);
const sc = await import(R + 'src/db/testScenarios.js?' + Date.now());
t = Date.now();
const out = await sc.seedScenarios(db, r.org, (m) => console.log('  ·', m));
console.log('scenarios', Date.now() - t, 'ms');
console.log(JSON.stringify(out, null, 1));
