// 箱单 Excel 解析 (飞书「98.箱单 › 科特」): 页签名字不可靠, 一律按内容认. 纯函数, 浏览器和 node 测试共用.
const N = (v) => Number(v) || 0;
const qty = (v) => Number(v || 0).toLocaleString('en-US');
export const normDesc = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
const cellStr = (v) => String(v ?? '').trim();
const isDescHead = (r) => r.some((c) => /型号|Descriptions?/i.test(cellStr(c))) && r.some((c) => /数量|Quantity/i.test(cellStr(c)));
const xlDate = (v) => {
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = cellStr(v).replace(/\//g, '-'); const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
};
const INBOUND_RE = /\b([A-Z]{2,3}\d{6,8}[A-Z]?)\b/;
// 「23/576.24/424」= 23 号箱 576 + 24 号箱 424;「1-21/576.22/504」= 1–21 号每箱 576 + 22 号 504;「26」= 整行都在 26 号箱
export function expandBoxes(spec, total) {
  const s = cellStr(spec); if (!s) return [];
  if (/^\d+(\.0+)?$/.test(s)) return [{ box_no: parseInt(s, 10), qty: N(total) }];
  return s.split('.').map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const [boxes, q] = part.split('/'); const n = parseInt(q, 10); if (!n) return [];
    const m = boxes.match(/^(\d+)-(\d+)$/); if (m) { const out = []; for (let i = +m[1]; i <= +m[2]; i++) out.push({ box_no: i, qty: n }); return out; }
    return [{ box_no: parseInt(boxes, 10), qty: n }];
  });
}
export function parsePackingBook(wb, XLSX, fileName = '') {
  const sheets = wb.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) }));
  const out = { batch_name: '', date: '', customer: '', inbound_no: '', lines: [], boxes: [], warnings: [] };
  // 抬头: Date / Invoice No / Customer
  for (const s of sheets) for (const r of s.rows.slice(0, 8)) r.forEach((c, i) => {
    const t = cellStr(c); const nextVal = () => r.slice(i + 1).find((x) => cellStr(x) !== '');
    if (!out.batch_name && /^Invoice\s*No/i.test(t)) out.batch_name = cellStr(nextVal());
    if (!out.date && /^Date/i.test(t)) out.date = xlDate(nextVal());
    if (!out.customer && /^Custo/i.test(t)) out.customer = cellStr(nextVal());
    if (/客户[:：]?$/.test(t) && cellStr(nextVal()) && !out.fwdCustomer) out.fwdCustomer = cellStr(nextVal());
    const m = t.toUpperCase().match(INBOUND_RE); if (m && !out.inbound_no && s.rows.indexOf(r) < 3) out.inbound_no = m[1];
  });
  if (!out.inbound_no) { const m = fileName.toUpperCase().match(INBOUND_RE); if (m) out.inbound_no = m[1]; }
  // 价格单: Descriptions / Quantity / UnitPrice
  const price = sheets.map((s) => { const h = s.rows.findIndex((r) => r.some((c) => /UnitPrice/i.test(cellStr(c)))); return h < 0 ? null : { s, h }; }).find(Boolean);
  const summary = sheets.map((s) => { const h = s.rows.findIndex((r) => isDescHead(r) && r.some((c) => /箱号/.test(cellStr(c))) && r.some((c) => /订单编号/.test(cellStr(c)))); return h < 0 ? null : { s, h }; }).find(Boolean)
    || sheets.map((s) => { if (!s.rows.slice(0, 6).some((r) => r.some((c) => /Invoice/i.test(cellStr(c))))) return null; const h = s.rows.findIndex((r) => isDescHead(r) && r.some((c) => /箱号/.test(cellStr(c)))); return h < 0 ? null : { s, h }; }).find(Boolean);
  const colIdx = (row, re) => row.findIndex((c) => re.test(cellStr(c)));
  if (price) {
    const head = price.s.rows[price.h]; const d = colIdx(head, /Descriptions?|型号/i), qn = colIdx(head, /Quantity|数量/i), up = colIdx(head, /UnitPrice/i);
    for (const r of price.s.rows.slice(price.h + 1)) { const descr = normDesc(r[d]); if (!descr || /^TOTAL/.test(descr)) continue; if (N(r[qn]) > 0) out.lines.push({ descr, qty: N(r[qn]), unit_price: N(r[up]) || null }); }
  }
  if (!out.lines.length && summary) {
    const head = summary.s.rows[summary.h]; const d = colIdx(head, /型号/), qn = colIdx(head, /数量/);
    for (const r of summary.s.rows.slice(summary.h + 1)) { const descr = normDesc(r[d]); if (descr && N(r[qn]) > 0) out.lines.push({ descr, qty: N(r[qn]) }); }
  }
  // 金蝶料号: 任何页里「写法 + 后一格像料号」的行 (KABRE 那份的 Sheet1)
  const want = new Set(out.lines.map((l) => l.descr));
  for (const s of sheets) for (const r of s.rows) r.forEach((c, i) => {
    const descr = normDesc(c); if (!want.has(descr)) return; const code = cellStr(r[i + 1]).replace(/\.0+$/, '');
    if (/^[0-9A-Z]{6,10}$/.test(code) && /\d/.test(code)) { const l = out.lines.find((x) => x.descr === descr); if (l && !l.code) l.code = code; }
  });
  // 每箱明细: 两个来源 —— ① 汇总页「箱号」写法 (23/576.24/424) 展开, ② 每箱一行的页 (型号写得具体的那页).
  // 实际箱单里 ② 常有漏写箱号 (拼箱的那几行), 所以: 先选总数对得上的; 都对得上再用「装箱清单」(只写 LCD COMP 的每箱总数) 逐箱核对.
  const sumLine = out.lines.reduce((a, l) => a + l.qty, 0);
  const cands = [];
  if (summary) {
    const head = summary.s.rows[summary.h]; const d = colIdx(head, /型号/), qn = colIdx(head, /数量/), bx = colIdx(head, /箱号/);
    const rows = []; for (const r of summary.s.rows.slice(summary.h + 1)) { const descr = normDesc(r[d]); if (!descr) continue; expandBoxes(r[bx], r[qn]).forEach((b) => rows.push({ ...b, descr })); }
    if (rows.length) cands.push(rows);
  }
  let generic = null;   // 装箱清单: 箱号 → 总片数
  sheets.forEach((s) => { const h = s.rows.findIndex((r) => isDescHead(r) && r.some((c) => /箱号/.test(cellStr(c))) && !r.some((c) => /订单编号/.test(cellStr(c)))); if (h < 0) return;
    const head = s.rows[h]; const d = colIdx(head, /型号/), qn = colIdx(head, /数量/), bx = colIdx(head, /箱号/);
    const rows = s.rows.slice(h + 1).map((r) => ({ descr: normDesc(r[d]), qty: N(r[qn]), box_no: parseInt(cellStr(r[bx]), 10) })).filter((x) => x.descr && x.qty > 0);
    if (rows.length && rows.every((x) => !want.has(x.descr))) { generic = {}; rows.forEach((x) => { if (x.box_no > 0) generic[x.box_no] = (generic[x.box_no] || 0) + x.qty; }); return; }
    if (rows.some((x) => want.has(x.descr))) cands.push(rows.filter((x) => x.box_no > 0)); });
  const total = (rs) => rs.reduce((a, b) => a + b.qty, 0);
  const fitsGeneric = (rs) => { if (!generic) return true; const m = {}; rs.forEach((x) => { m[x.box_no] = (m[x.box_no] || 0) + x.qty; }); return Object.keys(generic).every((k) => m[k] === generic[k]); };
  out.boxes = cands.find((rs) => total(rs) === sumLine && fitsGeneric(rs)) || cands.find((rs) => total(rs) === sumLine) || cands[0] || [];
  if (generic && out.boxes.length && !fitsGeneric(out.boxes)) out.warnings.push('每箱片数和「装箱清单」对不上，导入后请核对箱号');
  const sumBox = total(out.boxes);
  if (out.boxes.length && sumBox !== sumLine) out.warnings.push(`箱子里加起来 ${qty(sumBox)} 片，价格单 / 汇总是 ${qty(sumLine)} 片，对不上——导入后请核对`);
  if (!out.boxes.length) out.warnings.push('没读到每箱明细，导入后只有采购行、没有箱号');
  if (!out.batch_name) out.warnings.push('没读到需求批次（Invoice No）');
  return out;
}

