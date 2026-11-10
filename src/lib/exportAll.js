// 导出整库 (Frank 11-05 第 1 组: 上线前真实数据只在浏览器里 → 每周手动导到飞书云盘, 是唯一的 Plan B)
// 两个文件: JSON (完整, 含照片, 以后能原样导回) + Excel (每张表一个工作表, 人看的). 留记录不留文件 (export_log).
import { q } from '../db/client.js';

const SKIP = new Set(['account_otps']);   // 验证码不导
const cellStr = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && v.length > 32000) return v.slice(0, 32000) + '…(太长，完整内容在 JSON 里)';
  return v;
};
const replacer = (k, v) => (typeof v === 'bigint' ? Number(v) : v);

export async function listTables() {
  const rows = await q(`select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE' order by table_name`);
  return rows.map((r) => r.table_name).filter((t) => !SKIP.has(t));
}

export async function dumpAll(onProgress = () => {}) {
  const tables = await listTables();
  const data = {}; const stats = [];
  for (const t of tables) {
    onProgress(t);
    const rows = await q(`select * from app."${t}"`);
    data[t] = rows; stats.push({ name: t, rows: rows.length });
  }
  return { data, stats };
}

export function toJsonBlob({ data, stats }, meta) {
  const s = JSON.stringify({ app: 'LA&9S Operations', exported_at: new Date().toISOString(), ...meta, tables: stats, data }, replacer);
  return new Blob([s], { type: 'application/json' });
}

export async function toXlsxBlob({ data, stats }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); wb.creator = 'LA&9S';
  const idx = wb.addWorksheet('目录');
  idx.columns = [{ header: '表', key: 'name', width: 34 }, { header: '行数', key: 'rows', width: 10 }];
  idx.addRows(stats); idx.getRow(1).font = { bold: true };
  const used = new Set(['目录']);
  for (const t of Object.keys(data)) {
    let name = t.replace(/[\\/*?:[\]]/g, '_').slice(0, 31); let i = 2;
    while (used.has(name)) name = `${t.slice(0, 28)}_${i++}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    const rows = data[t];
    const keys = rows.length ? Object.keys(rows[0]) : (await q(`select column_name from information_schema.columns where table_schema='app' and table_name=$1 order by ordinal_position`, [t])).map((r) => r.column_name);
    ws.columns = keys.map((k) => ({ header: k, key: k, width: Math.min(40, Math.max(10, k.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(Object.fromEntries(keys.map((k) => [k, cellStr(r[k])])));
  }
  return new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
