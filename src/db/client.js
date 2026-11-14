// Browser database: PGlite (real PostgreSQL in WebAssembly) running the SAME migrations as production.
// Stored in IndexedDB so the demo survives reloads; falls back to memory if the browser blocks storage.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { applyMigrations, seedDemo, USERS } from './bootstrap.js';
import { seedReal } from './realSeed.js';
import { SOP_DEFAULTS } from './sopDefaults.js';

// 真实数据版 (VITE_REAL=1): 同一套规则, 开局导入金蝶 / 飞书快照 (real-data.json, 不进代码仓库), 和演示版的浏览器数据完全分开
export const REAL = import.meta.env.VITE_REAL === '1';
// 服务器版 (VITE_SERVER=1): 数据在 Supabase, 要登录; q / call 都走 server.js
export const SERVER = import.meta.env.VITE_SERVER === '1';
import { exec as srvExec, openServer } from './server.js';
let srvMe = null;
export const serverMe = () => srvMe;

const files = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
const MIGRATIONS = Object.keys(files).sort().map((k) => [k.split('/').pop(), files[k]]);
const SEED_VERSION = 'seed-15';
const DB_NAME = REAL ? 'idb://la9s-real-v1' : 'idb://la9s-demo-v2';

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return String(h >>> 0); }
const FINGERPRINT = hash(MIGRATIONS.map(([n, s]) => n + s).join('\n') + SEED_VERSION);

let db = null;
let persistent = true;
let org = null;
let queue = Promise.resolve();

// claude.ai artifact build: the host only serves web file types, so the PGlite filesystem
// bundle and the pgcrypto extension ship as base64 .txt files next to the page.
async function pgliteOptions() {
  if (import.meta.env.VITE_ARTIFACT !== '1') return { extensions: { pgcrypto } };
  const bytes = async (u) => { const t = await (await fetch(u)).text(); const b = atob(t.trim()); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  const [fs, crypto] = await Promise.all([bytes('./pglite-fs.txt'), bytes('./pgcrypto-ext.txt')]);
  const cryptoUrl = URL.createObjectURL(new Blob([crypto], { type: 'application/gzip' }));
  return {
    fsBundle: new Blob([fs]),
    extensions: { pgcrypto: { name: 'pgcrypto', setup: async () => ({ bundlePath: new URL(cryptoUrl) }) } },
  };
}

// serialize: set_config + statement must not interleave with another call
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const migKeys = () => MIGRATIONS.map(([n, sql]) => [`mig:${n}`, hash(sql)]);

async function freshInstall(d) {
  await applyMigrations(d, MIGRATIONS);
  await d.exec(`create table public.demo_meta (k text primary key, v text)`);
  for (const [k, h] of migKeys()) await d.query(`insert into public.demo_meta values ($1,$2)`, [k, h]);
  let r;
  if (REAL) {
    const data = await (await fetch('./real-data.json', { cache: 'no-store' })).json();
    r = await seedReal(d, data.import, data.as_of);
    await d.query(`insert into public.demo_meta values ('snapshot',$1)`, [data.as_of]);
  } else r = await seedDemo(d);
  await d.query(`insert into public.demo_meta values ('fingerprint',$1),('org',$2)`, [FINGERPRINT, r.org]);
  return r.org;
}

export async function openDb(onProgress = () => {}) {
  if (SERVER) { onProgress('正在连接服务器…'); srvMe = await openServer(); org = srvMe.org; return { org, persistent: true }; }
  onProgress('正在启动数据库…');
  const opts = await pgliteOptions();
  try {
    db = new PGlite(DB_NAME, { ...opts, relaxedDurability: false });
    await db.waitReady;
  } catch (e) {
    console.warn('IndexedDB unavailable, using memory', e);
    persistent = false;
    db = new PGlite(opts);
    await db.waitReady;
  }
  const meta = await db.query(`select to_regclass('public.demo_meta') is not null as ok`);
  let fp = null;
  if (meta.rows[0].ok) {
    const r = await db.query(`select k, v from public.demo_meta`);
    const m = Object.fromEntries(r.rows.map((x) => [x.k, x.v]));
    fp = m.fingerprint; org = m.org;
  }
  if (fp && fp !== FINGERPRINT && REAL) {
    // 真实数据版: 不清空, 只补新的规则 (迁移). 中方确认导入的数据和在系统里录的东西都留着.
    onProgress('系统升级中：只加新功能，已有数据不动…');
    await upgradeInPlace(fp);
  } else if (fp !== FINGERPRINT) {
    if (fp) { onProgress('规则已更新，正在重建演示数据…'); await wipe(); }
    else onProgress(REAL ? '首次打开：正在导入金蝶 / 飞书数据（约 2400 个物料，要等十几秒）…' : '首次打开：正在加载业务规则和演示数据…');
    org = await freshInstall(db);
  }
  if (REAL) await applyPacks(onProgress);
  return { org, persistent };
}

// 无损升级: 找出这个浏览器里已经跑过哪些迁移 → 只跑新的. 旧迁移被改过就停下, 绝不清空.
const LEGACY_SEEDS = ['seed-11', 'seed-10', 'seed-9'];
// 11-08: 这些迁移只有 create or replace function (不建表不改数据), 浏览器里记的旧文本和现在不一样时允许按现文本重跑 (Frank 真实版 0019 被挡住)
const REAPPLY_OK = new Set(['0019_customer_tier_inline.sql']);
async function upgradeInPlace(fp) {
  const rows = (await db.query(`select k, v from public.demo_meta where k like 'mig:%'`)).rows;
  let done = new Map(rows.map((r) => [r.k, r.v]));
  if (!done.size) {   // 10-31 以前的版本没记迁移, 用指纹反推跑到了第几个
    let k = -1;
    for (const seed of LEGACY_SEEDS) for (let i = MIGRATIONS.length; i > 0 && k < 0; i--) {
      if (hash(MIGRATIONS.slice(0, i).map(([n, s]) => n + s).join('\n') + seed) === fp) k = i;
    }
    if (k < 0) throw new Error('UPGRADE_BLOCKED: 认不出这个浏览器里的数据是哪个版本，为了不丢数据没有升级。请把这句话截图发给 Claude。');
    done = new Map(migKeys().slice(0, k));
  }
  const keys = migKeys();
  for (const [k, h] of done) {
    const cur = keys.find(([x]) => x === k);
    if (cur && cur[1] !== h && REAPPLY_OK.has(k.slice(4))) { done.delete(k); continue; }   // 只改函数的迁移: 文本变了就按新文本重跑一遍, 不动数据
    if (!cur || cur[1] !== h) throw new Error(`UPGRADE_BLOCKED: 旧规则 ${k.slice(4)} 被改过，为了不丢数据没有升级。请把这句话截图发给 Claude。`);
  }
  for (const [name, sql] of MIGRATIONS) {
    const k = `mig:${name}`;
    if (done.has(k)) continue;
    await db.exec(sql);
    await db.query(`insert into public.demo_meta values ($1,$2) on conflict (k) do update set v = excluded.v`, [k, hash(sql)]);
  }
  for (const [k, h] of keys) await db.query(`insert into public.demo_meta values ($1,$2) on conflict (k) do nothing`, [k, h]);
  await db.query(`update public.demo_meta set v = $1 where k = 'fingerprint'`, [FINGERPRINT]);
}

// 数据包: 中方确认过的数据 (员工档案等) 带版本号, 版本变了才导一次; 按来源记录更新, 不会重复
const PACKS = [['staff', './staff-pack.json', 'import_staff'], ['batches', './batch-pack.json', 'import_product_batches']];
async function applyPacks(onProgress) {
  // 新加的岗位 (比如销售主管) 在老的真实数据库里补一个岗位账号, 右上角才切得过去
  for (const [r, uid] of Object.entries(USERS)) {
    if (['boss', 'clerk'].includes(r)) continue;
    const has = (await db.query(`select 1 from app.members where user_id = $1`, [uid])).rows.length;
    if (has) continue;
    const e = (await db.query(`insert into app.employees (org_id, short_name, department, position) values ($1,$2,'系统','岗位账号') returning id`, [org, `${r}（岗位账号）`])).rows[0].id;
    await db.query(`insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,$4)`, [uid, org, e, `{${r}}`]);
  }
  // 新加的 SOP (sopDefaults 里带 add 标记的): 老的真实库按标记补一次, 已有同名的不碰 (中方可能改过)
  const adds = [...new Set(SOP_DEFAULTS.filter((s) => s.add).map((s) => s.add))];
  for (const tag of adds) {
    const k = `sop:${tag}`;
    if ((await db.query(`select 1 from public.demo_meta where k = $1`, [k])).rows.length) continue;
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [USERS.admin]);
    try {
      for (const s of SOP_DEFAULTS.filter((x) => x.add === tag)) {
        if ((await db.query(`select 1 from app.sop_docs where org_id = $1 and title = $2`, [org, s.title])).rows.length) continue;
        await db.query(`select app.upsert_sop($1,null,$2,$3,$4,null)`, [org, s.dept, s.title, JSON.stringify(s.steps)]);
      }
    } finally { await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
    await db.query(`insert into public.demo_meta values ($1,'1') on conflict (k) do nothing`, [k]);
  }
  for (const [name, url, fn] of PACKS) {
    let pack = null;
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) pack = await r.json(); } catch { /* 没有这个包 */ }
    if (!pack?.version) continue;
    const cur = (await db.query(`select v from public.demo_meta where k = $1`, [`pack:${name}`])).rows[0]?.v;
    if (cur === pack.version) continue;
    onProgress(`正在导入已确认的数据：${pack.label || name}（${pack.version}）…`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [USERS.admin]);
    try { await db.query(`select app.${fn}($1,$2)`, [org, JSON.stringify(pack.rows)]); }
    finally { await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
    await db.query(`insert into public.demo_meta values ($1,$2) on conflict (k) do update set v = excluded.v`, [`pack:${name}`, pack.version]);
  }
}

async function wipe() {
  await db.exec(`drop schema if exists app cascade; drop schema if exists auth cascade; drop table if exists public.demo_meta;`);
}

export async function resetDemo() {
  if (SERVER) throw new Error('线上环境不能一键重置');
  return exclusive(async () => { await wipe(); org = await freshInstall(db); return org; });
}

export const getOrg = () => org;
export const isPersistent = () => persistent;

// read (as superuser; the demo shows everything to keep screens simple)
export function q(sql, params = []) {
  if (SERVER) return srvExec(sql, params);
  return exclusive(async () => (await db.query(sql, params)).rows);
}

// business action as the current demo role → goes through the permission checks in SQL
// 客户用自己的账号登录后 (#/login), 「客户老板」岗位用他自己的身份, 不用演示身份
let custUid = null;
try { custUid = JSON.parse(localStorage.getItem('la9s.cust') || sessionStorage.getItem('la9s.cust') || 'null')?.user_id || null; } catch { /* */ }
export const setCustomerSession = (s, remember) => {
  custUid = s?.user_id || null;
  try {
    localStorage.removeItem('la9s.cust'); sessionStorage.removeItem('la9s.cust');
    if (s) (remember ? localStorage : sessionStorage).setItem('la9s.cust', JSON.stringify(s));
  } catch { /* 浏览器禁存储: 只在本页有效 */ }
};
export const customerSession = () => { try { return JSON.parse(localStorage.getItem('la9s.cust') || sessionStorage.getItem('la9s.cust') || 'null'); } catch { return null; } };

// 不登录也能用的动作 (登录、改密码、游客询价): 用空身份调用, 只能走 SQL 里对外开放的函数
export function callAnon(sql, params = []) {
  if (SERVER) return Promise.reject(new Error('线上演示环境暂不开放客户 / 游客入口'));
  return exclusive(async () => {
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    return (await db.query(sql, params)).rows;
  });
}

export function call(role, sql, params = []) {
  if (SERVER) return srvExec(sql, params);   // 线上: 一律用登录账号本人的身份, 岗位只决定看到哪些菜单
  const uid = role === 'boss' && custUid ? custUid : USERS[role];
  return exclusive(async () => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
    try { return (await db.query(sql, params)).rows; }
    finally { await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
  });
}

export async function callValue(role, sql, params) {
  const rows = await call(role, sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

// 只在本机 localhost 的演示 / 测试构建里露一个测试口子 (线上和 artifact 都没有)
if (!SERVER && typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) window.__la9sTest = { q, call: (...a) => call(...a) };
