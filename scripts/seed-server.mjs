// 往服务器 (Supabase la9s-staging) 灌演示数据: 复用 src/db/bootstrap.js 的 seedDemo, 通过 Management API 执行.
// 用法: SB_TOKEN=... node scripts/seed-server.mjs   (只在空库上跑; 已有 org 就停)
import { seedDemo } from '../src/db/bootstrap.js';
import { inlineSql } from './sqlinline.mjs';
const REF = process.env.SB_REF || 'jqtkftmcrgfozbilvyzg', TOKEN = process.env.SB_TOKEN;
let claim = '', n = 0;
async function run(sql) {
  const body = (claim ? `select set_config('request.jwt.claim.sub', '${claim}', false);\n` : '') + sql;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: body }) });
    const t = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
    let j; try { j = JSON.parse(t); } catch { throw new Error(t.slice(0, 500)); }
    if (!Array.isArray(j)) throw new Error((j.message || t).slice(0, 800) + '\n--- SQL: ' + sql.slice(0, 300));
    n++; if (n % 50 === 0) process.stdout.write(`.${n}`);
    return j;
  }
  throw new Error('server busy');
}
const db = {
  async query(sql, params = []) {
    const m = sql.match(/^\s*select set_config\('request\.jwt\.claim\.sub', \$1, false\)\s*$/);
    if (m) { claim = params[0] || ''; return { rows: [{ set_config: claim }] }; }
    return { rows: await run(inlineSql(sql, params)) };
  },
  async exec(sql) { await run(sql); },
};
const [{ c }] = await run('select count(*)::int c from app.orgs');
if (c > 0) { console.log('已有数据, 不重复灌'); process.exit(0); }
const t0 = Date.now();
const r = await seedDemo(db);
console.log('\nseeded org', r.org, 'queries', n, 'sec', Math.round((Date.now() - t0) / 1000));
