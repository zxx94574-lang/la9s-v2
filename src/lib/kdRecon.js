// 380 (Frank 11-18): 和金蝶对账 —— 金蝶导出的表按列名自动认是哪一种, 先按金蝶单号精确对, 没单号的按「日期 ± 1 天 + 客户 + 编码数量」找最像的.
// 纯函数, 不碰数据库: 输入 金蝶行 + 系统单据, 输出五类结果.
const norm = (s) => String(s ?? '').trim();
const up = (s) => norm(s).toUpperCase();
const num = (v) => Number(String(v ?? '').replace(/[\s,]/g, '')) || 0;
const pick = (h, res) => h.findIndex((x) => res.some((re) => re.test(norm(x))));
const day = (v) => {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }   // Excel 序列日期
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = norm(v).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
};
export const KD_TYPES = { outbound: '销售出库单', so: '销售订单', grn: '采购入库单', po: '采购订单', stock: '即时库存' };
export const KD_WH = { 'CI LA MATERIAL WH': 'LA', 'CI 9S MATERIAL WH': '9S', 'CI LA FOB MATERIAL WH': 'FOB', 'CI PENDING LIABILITY WH': 'PENDING', 'CI DEFECTIVE WH-LA': 'SCRAP', 'CI DEFECTIVE WH-9S': 'SCRAP' };
const COL = {
  no: [/^单据编号$/, /^单据号$/, /bill ?no/i, /^编号$/],
  date: [/^日期$/, /^单据日期$/, /入库日期/, /出库日期/, /采购日期/, /^date$/i],
  party: [/^客户$/, /^客户名称$/, /^供应商$/, /^供应商名称$/, /customer/i, /supplier/i],
  code: [/^物料编码$/, /^物料$/, /^物料代码$/, /material ?(code|number)/i],
  wh: [/^仓库$/, /^仓库名称$/, /^发货仓库$/, /^收料仓库$/, /warehouse/i],
  amount: [/价税合计/, /^金额$/, /amount/i],
  note: [/^备注$/, /摘要/, /remark/i],
};
const QTY = { outbound: [/实发数量/], grn: [/实收数量/, /实到数量/, /入库数量/], po: [/采购数量/], so: [/销售数量/, /^数量$/], stock: [/库存量/, /库存数量/, /可用量/] };

// rows = 二维数组 (第一行不一定是表头: 找含「物料」的那一行当表头). 返回 { type, lines:[{no,date,party,code,qty,wh,amount,note}], missing:[] }
export function parseKdSheet(rows, forceType) {
  const hi = rows.findIndex((r) => r.some((c) => /物料|material/i.test(norm(c))));
  if (hi < 0) return { type: null, lines: [], missing: ['物料编码'] };
  const h = rows[hi].map(norm);
  let type = forceType || null;
  if (!type) {
    const has = (res) => pick(h, res) >= 0;
    type = has(QTY.outbound) ? 'outbound' : has(QTY.grn) ? 'grn' : has(QTY.po) ? 'po' : has(QTY.stock) && pick(h, COL.no) < 0 ? 'stock' : has(QTY.so) ? 'so' : has(QTY.stock) ? 'stock' : null;
  }
  if (!type) return { type: null, lines: [], missing: ['认不出是哪种表（没找到 实发数量 / 实收数量 / 采购数量 / 销售数量 / 库存量 这些列）'] };
  const ix = { no: pick(h, COL.no), date: pick(h, COL.date), party: pick(h, COL.party), code: pick(h, COL.code), wh: pick(h, COL.wh), amount: pick(h, COL.amount), note: pick(h, COL.note), qty: pick(h, QTY[type]) };
  const missing = [ix.code < 0 && '物料编码', ix.qty < 0 && '数量', type !== 'stock' && ix.no < 0 && '单据编号'].filter(Boolean);
  if (missing.length) return { type, lines: [], missing };
  const lines = []; let last = {};
  for (const r of rows.slice(hi + 1)) {
    const code = norm(r[ix.code]); if (!code || /合计|小计/.test(code)) continue;
    // 金蝶列表导出: 同一张单的第 2 行起 单号 / 日期 / 客户 常常是空的 → 沿用上一行
    const cur = { no: norm(r[ix.no]) || last.no || '', date: day(r[ix.date]) || last.date || '', party: norm(r[ix.party]) || last.party || '' };
    last = cur;
    lines.push({ ...cur, code, qty: num(r[ix.qty]), wh: ix.wh >= 0 ? (KD_WH[up(r[ix.wh])] || up(r[ix.wh])) : '', amount: ix.amount >= 0 ? num(r[ix.amount]) : null, note: ix.note >= 0 ? norm(r[ix.note]) : '' });
  }
  return { type, lines, missing: [] };
}

const groupDocs = (lines) => { const m = new Map(); for (const l of lines) { if (!m.has(l.no)) m.set(l.no, { no: l.no, date: l.date, party: l.party, note: l.note, lines: {} }); const d = m.get(l.no); d.lines[l.code] = (d.lines[l.code] || 0) + l.qty; } return [...m.values()]; };
const lineDiff = (a, b) => { const out = []; for (const c of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[c] || 0) !== (b[c] || 0)) out.push({ code: c, kd: a[c] || 0, sys: b[c] || 0 }); return out; };
const dayGap = (a, b) => (a && b ? Math.abs((new Date(a) - new Date(b)) / 864e5) : 99);
const sameParty = (kd, s) => { const k = up(kd); if (!k) return true; return [s.party_code, s.party].filter(Boolean).some((x) => k.includes(up(x)) || up(x).includes(k)); };

// 单据类: kdLines = parseKdSheet().lines; sys = [{ kind, row_id, label, deal_id, date, party, party_code, kd_no, lines: {code: qty} }]
export function matchDocs(type, kdLines, sys) {
  const docs = groupDocs(kdLines); const used = new Set(); const out = [];
  const byNo = new Map(sys.filter((s) => s.kd_no).map((s) => [up(s.kd_no), s]));
  const base = (d, s) => ({ doc_kind: type, kd_no: d?.no || null, sys_kind: s?.kind || null, sys_row: s?.row_id || null, sys_label: s?.label || null, deal_id: s?.deal_id || null });
  const rest = [];
  for (const d of docs) {
    const s = byNo.get(up(d.no));
    if (!s) { rest.push(d); continue; }
    used.add(s.row_id); const df = lineDiff(d.lines, s.lines);
    out.push({ ...base(d, s), cat: df.length ? 'diff' : 'ok', info: { date: d.date, party: d.party, sys_date: s.date, sys_party: s.party, lines: df } });
  }
  for (const d of rest) {
    const cands = sys.filter((s) => !s.kd_no && !used.has(s.row_id) && dayGap(d.date, s.date) <= 1 && sameParty(d.party, s))
      .map((s) => { const df = lineDiff(d.lines, s.lines); const all = new Set([...Object.keys(d.lines), ...Object.keys(s.lines)]).size; return { s, df, score: all ? 1 - df.length / all : 0 }; })
      .filter((c) => c.score >= 0.5).sort((a, b) => b.score - a.score || dayGap(d.date, a.s.date) - dayGap(d.date, b.s.date));
    if (cands.length) { const c = cands[0]; used.add(c.s.row_id);
      out.push({ ...base(d, c.s), cat: 'suspect', info: { date: d.date, party: d.party, sys_date: c.s.date, sys_party: c.s.party, lines: c.df, why: c.df.length ? `日期、客户对得上，${c.df.length} 个编码数量不一样` : '日期、客户、编码数量都一样' } });
    } else out.push({ ...base(d, null), cat: 'kd_only', info: { date: d.date, party: d.party, note: d.note, lines: Object.entries(d.lines).map(([code, kd]) => ({ code, kd, sys: 0 })) } });
  }
  // 系统有、金蝶没有: 只看金蝶文件覆盖的日期范围里的
  const dates = docs.map((d) => d.date).filter(Boolean).sort(); const lo = dates[0]; const hi = dates[dates.length - 1];
  for (const s of sys) if (!used.has(s.row_id) && lo && s.date >= lo && s.date <= hi)
    out.push({ ...base(null, s), kd_no: s.kd_no || null, cat: 'sys_only', info: { sys_date: s.date, sys_party: s.party, lines: Object.entries(s.lines).map(([code, q]) => ({ code, kd: 0, sys: q })) } });
  return out;
}

// 库存: kdLines 按 编码 + 仓 汇总; sysStock = [{code, warehouse, qty, category, model}]; pending = {code: 系统已做、金蝶还没录的净变动 (正 = 系统多入, 负 = 系统多出)}
export function matchStock(kdLines, sysStock, pending = {}) {
  const key = (c, w) => `${c}|${w}`; const kd = {}; for (const l of kdLines) kd[key(l.code, l.wh)] = (kd[key(l.code, l.wh)] || 0) + l.qty;
  const sys = {}; const meta = {}; for (const s of sysStock) { sys[key(s.code, s.warehouse)] = (sys[key(s.code, s.warehouse)] || 0) + Number(s.qty || 0); meta[s.code] = s; }
  const whs = new Set(kdLines.map((l) => l.wh)); const rows = [];
  for (const k of new Set([...Object.keys(kd), ...Object.keys(sys)])) {
    const [code, wh] = k.split('|'); if (!whs.has(wh)) continue;       // 金蝶文件里没有的仓不比
    const diff = (sys[k] || 0) - (kd[k] || 0); if (!diff) continue;
    rows.push({ code, wh, sys: sys[k] || 0, kd: kd[k] || 0, diff, category: meta[code]?.category || '', model: meta[code]?.model || '', cls: 'unknown' });
  }
  const byCode = {}; for (const r of rows) byCode[r.code] = (byCode[r.code] || 0) + r.diff;
  for (const r of rows) if (pending[r.code] != null && pending[r.code] === byCode[r.code]) { r.cls = 'explained'; r.why = '系统里有单据还没录金蝶，差的数正好对上'; }
  // 疑似发错编码: 同种类同型号, 一个多 N 一个少 N
  const left = rows.filter((r) => r.cls === 'unknown' && r.model);
  for (const a of left) { if (a.cls !== 'unknown') continue; const b = left.find((x) => x !== a && x.cls === 'unknown' && x.category === a.category && x.model === a.model && x.wh === a.wh && x.diff === -a.diff);
    if (b) { a.cls = b.cls = 'swap'; a.why = `和 ${b.code} 正好一多一少（${a.model} ${a.category}）`; b.why = `和 ${a.code} 正好一多一少（${b.model} ${b.category}）`; } }
  return rows.map((r) => ({ cat: 'stock', doc_kind: 'stock', kd_no: null, sys_kind: null, sys_row: null, sys_label: `${r.code} · ${r.wh}`, deal_id: null, info: r }));
}
