// 11-26 金蝶「…列表」导出 + 飞书 CI 销售表：拖进来自动认是哪种表 → 整理成一行一条 → 交给后台存。
// 金蝶导出一张单多行时，单头那几列只在第一行有值 → 同一张单往下补齐（不能整列往下补，会串到下一张单）。

const S = (v) => (v == null ? '' : String(v).replace(/[​ ]/g, ' ').trim());
export const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const s = S(v).replace(/[^\d.-]/g, ''); if (!s || s === '-' || s === '.') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
export const day = (v) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const m = S(v).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const CUR = (v) => { const s = S(v); return /人民币|RMB|CNY/i.test(s) ? 'CNY' : /美元|USD/i.test(s) ? 'USD' : 'XOF'; };

export const KIND_L = { feishu: '飞书 CI 销售表', so: '金蝶 · 销售订单', outret: '金蝶 · 销售出库 / 退货', receipt: '金蝶 · 收款单', opening: '金蝶 · 期初应收', ar: '金蝶 · 财务应收单',
  customer: '金蝶 · 客户列表', po: '金蝶 · 采购订单', grn: '金蝶 · 采购入库单', skip: '用不上（跳过）' };

export function detect(head) {
  const h = new Set(head.map(S));
  const has = (...xs) => xs.every((x) => h.has(x));
  if (has('Sales Order NO', 'Qté Fournie')) return 'feishu';
  if (has('收款用途', '实收金额')) return 'receipt';
  if (has('收货客户.编码', '价税合计', '来源单据编号')) return 'outret';
  if (has('订货客户.编码', '已出库数量')) return 'so';
  if (has('往来单位', '未核销金额')) return h.has('源单类型') ? 'ar' : 'opening';
  if (has('订货供应商', '已入库数量')) return 'po';
  if (has('供货供应商', '来源单据编号', '仓库')) return 'grn';
  if (has('客户编码', '客户名称') && !h.has('物料编码')) return 'customer';
  return 'skip';
}

// rows: 第一行表头的二维数组 → 对象数组（同一张单补齐单头）
function objects(rows, docCol, docFields) {
  const head = rows[0].map(S); const out = []; let prev = null;
  for (const r of rows.slice(1)) {
    if (!r || r.every((x) => x == null || x === '')) continue;
    const o = Object.fromEntries(head.map((k, i) => [k, r[i]]));
    if (docCol) {
      if (S(o[docCol]) === '' && prev) { o[docCol] = prev[docCol]; for (const f of docFields) if (o[f] == null || o[f] === '') o[f] = prev[f]; }
      else if (prev && S(o[docCol]) === S(prev[docCol])) { for (const f of docFields) if (o[f] == null || o[f] === '') o[f] = prev[f]; }
    }
    out.push(o); prev = o;
  }
  return out;
}

// 一张表 → { kind, lines: [{kind, rows}], extra }  （出库表拆成 出库 / 退货 两种）
export function normalize(kind, rows) {
  const median = (xs) => { const a = xs.filter((x) => x > 0).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
  if (kind === 'outret') {
    const os = objects(rows, '单据编号', ['业务日期', '单据状态', '收货客户.编码', '收货客户', '来源单据编号', '销售员']);
    const m = (o) => ({ doc_no: S(o['单据编号']), src_no: S(o['来源单据编号']), d: day(o['业务日期']), party_code: S(o['收货客户.编码']), party_name: S(o['收货客户']),
      code: S(o['物料编码']), wh: S(o['仓库']), qty: num(o['数量']), amount: num(o['价税合计']), currency: 'XOF', biz: S(o['业务类型']) || null });
    const all = os.map(m).filter((x) => x.doc_no && x.qty);
    return [{ kind: 'out', rows: all.filter((x) => x.qty > 0) }, { kind: 'ret', rows: all.filter((x) => x.qty < 0) }];
  }
  if (kind === 'receipt') {
    const os = objects(rows, '单据编号', ['业务日期', '收款币种', '付款单位编码', '付款单位名称', '单据类型', '收款金额', '结算汇率']);
    const xr = median(os.filter((o) => CUR(o['收款币种']) === 'XOF').map((o) => num(o['结算汇率'])));
    return [{ kind: 'receipt', rows: os.filter((o) => S(o['单据编号']) && num(o['实收金额'])).map((o) => {   // 实收金额是每一行的；整张单的「收款金额」不拿来补（会重复算）
      const cur = CUR(o['收款币种']); const amt = num(o['实收金额']) || 0; const rate = num(o['结算汇率']);
      return { doc_no: S(o['单据编号']), d: day(o['业务日期']), party_code: S(o['付款单位编码']), party_name: S(o['付款单位名称']), amount: amt, currency: cur,
        amount_xof: cur === 'XOF' ? amt : rate && xr ? Math.round((amt * rate) / xr) : null, biz: S(o['收款用途']) || S(o['单据类型']) || null };
    }) }];
  }
  if (kind === 'opening' || kind === 'ar') {
    const os = objects(rows, '单据编号', ['往来单位', '业务日期', '价税合计', '未核销金额']);
    const seen = new Set();
    return [{ kind, rows: os.filter((o) => { const k = S(o['单据编号']); if (!k || seen.has(k)) return false; seen.add(k); return true; })   // 一张应收单多行时价税合计是整张单的，只取一次
      .map((o) => ({ doc_no: S(o['单据编号']), d: day(o['业务日期']), party_name: S(o['往来单位']), amount: num(o['价税合计']), currency: 'XOF', extra: { open: num(o['未核销金额']) } })) }];
  }
  if (kind === 'customer') return [{ kind, rows: objects(rows).filter((o) => S(o['客户编码'])).map((o) => ({ doc_no: S(o['客户编码']), party_code: S(o['客户编码']), party_name: S(o['客户名称']) })) }];
  if (kind === 'so') {
    const os = objects(rows, '单据编号', ['订货客户.编码', '订货客户', '订单日期', '单据状态', '销售员']);
    return [{ kind, rows: os.filter((o) => S(o['单据编号'])).map((o) => ({ doc_no: S(o['单据编号']), d: day(o['订单日期']), party_code: S(o['订货客户.编码']), party_name: S(o['订货客户']),
      code: S(o['物料编码']), qty: num(o['数量']), amount: (num(o['数量']) || 0) * (num(o['单价']) || 0), currency: 'XOF', extra: { shipped: num(o['已出库数量']), returned: num(o['已退库数量']) } })) }];
  }
  if (kind === 'po') {
    const os = objects(rows, '单据编号', ['订单日期', '业务类型.名称', '备注', '订货供应商', '关闭状态', '发出日期', '物流公司', '运输方式', '交货日期']);
    return [{ kind, rows: os.filter((o) => S(o['单据编号'])).map((o) => ({ doc_no: S(o['单据编号']), d: day(o['订单日期']), party_name: S(o['订货供应商']), code: S(o['物料编码']),
      qty: num(o['数量']), amount: num(o['价税合计']), currency: 'USD', biz: S(o['业务类型.名称']),
      extra: { model: S(o['规格型号']), price: num(o['单价']), received: num(o['已入库数量']) || 0, closed: S(o['行关闭状态']) === '已关闭', remark: S(o['备注']), mode: S(o['运输方式']), eta: day(o['交货日期']),
        forwarder: S(o['物流公司']), tracking: S(o['物流单号']), pieces: num(o['件数']), freight: num(o['预估物流费']), wv: S(o['货物重量与体积']), shipped: day(o['发出日期']) } })) }];
  }
  if (kind === 'grn') {
    const os = objects(rows, '单据编号', ['供货供应商', '业务日期', '来源单据编号']);
    return [{ kind, rows: os.filter((o) => S(o['单据编号'])).map((o) => ({ doc_no: S(o['单据编号']), src_no: S(o['来源单据编号']), d: day(o['业务日期']), party_name: S(o['供货供应商']),
      code: S(o['物料编码']), wh: S(o['仓库']), qty: num(o['数量']), amount: num(o['价税合计']), currency: 'USD', extra: { price: num(o['单价']) } })) }];
  }
  return [];
}

// 飞书 CI 销售表的 Sales Order 页 → 历史销售行
export function feishuRows(rows) {
  const head = rows[0].map((x) => S(x).replace(/\s+/g, ' '));
  const at = (name) => head.findIndex((h) => h.replace(/\s/g, '') === name.replace(/\s/g, ''));
  const c = Object.fromEntries(['Date', 'Code', 'Nom', 'Type', 'Sales Order NO', 'Quantité', 'Qté Fournie', 'Prix', 'Prix Total', 'Status', 'STAFF', 'M Code', 'Model', 'Modèle',
    '录单备注', 'Remark', '实收', '待付金额', '付款日期', 'Retournée Qty', 'Retournée Montant'].map((k) => [k, at(k)]));
  const g = (r, k) => (c[k] >= 0 ? r[c[k]] : null);
  const out = [];
  for (const r of rows.slice(1)) {
    if (!r || r.every((x) => x == null || x === '')) continue;
    const qty = num(g(r, 'Qté Fournie')) || 0; const rq = num(g(r, 'Retournée Qty')) || 0; let status = S(g(r, 'Status')) || null;
    if (status === 'Done' && qty === 0 && rq === 0) status = 'NotShipped';   // 当初没发货却标了 Done（11-26 Frank 说的第二种）
    const so = S(g(r, 'Sales Order NO'));
    out.push({ d: day(g(r, 'Date')), customer_code: S(g(r, 'Code')), customer_name: S(g(r, 'Nom')), so_no: so && so !== '0' ? so : null, status,
      code: S(g(r, 'M Code')) || null, model: S(g(r, 'Model')) || S(g(r, 'Modèle')) || null, category: S(g(r, 'Type')) || null,
      qty_ordered: num(g(r, 'Quantité')), qty, price: num(g(r, 'Prix')), amount: num(g(r, 'Prix Total')) || 0, ret_qty: rq, ret_amount: num(g(r, 'Retournée Montant')) || 0,
      paid: num(g(r, '实收')) || 0, due: num(g(r, '待付金额')) || 0, paid_on: day(g(r, '付款日期')), staff: S(g(r, 'STAFF')) || null,
      remark: [S(g(r, '录单备注')), S(g(r, 'Remark'))].filter(Boolean).join(' · ') || null });
  }
  return out;
}

// 采购订单（金蝶）→ 系统采购单导入行：回收业务不进；关掉的行按已入库数算（剩下的不是在途）
export function poImportRows(lines) {
  return lines.filter((l) => !/回收/.test(l.biz || '')).map((l) => {
    const e = l.extra || {}; const qty = e.closed ? e.received : l.qty;
    return { po_no: l.doc_no, supplier: l.party_name, mode: /空/.test(e.mode || '') ? 'air' : 'sea', ordered_on: l.d, eta: e.eta, code: l.code, model: e.model, qty, qty_received: Math.min(e.received || 0, qty || 0), remark: e.remark };
  }).filter((r) => r.qty > 0);
}
// 0106: 采购订单表头的物流信息（物流公司 / 物流单号 / 件数 / 预估物流费 / 重量体积 / 发出日期）→ 每张采购单一行
export function poLogisticsRows(lines) {
  const m = new Map();
  for (const l of lines) {
    if (/回收/.test(l.biz || '') || !l.doc_no || m.has(l.doc_no)) continue;
    const e = l.extra || {};
    m.set(l.doc_no, { po_no: l.doc_no, forwarder: e.forwarder || null, tracking_no: e.tracking || null, pieces: e.pieces || null, freight_est: e.freight || null, weight_vol: e.wv || null, shipped_on: e.shipped || null });
  }
  return [...m.values()];
}
// 采购入库（金蝶）→ 采购批次：同一采购单同一编码合成一批，单价按数量加权；回收仓不进
export function batchRows(lines) {
  const m = new Map();
  for (const l of lines) {
    if (/recycle|回收/i.test(l.wh || '') || !l.code || !(l.qty > 0)) continue;
    const k = `${l.src_no}|${l.code}`; const x = m.get(k) || { code: l.code, po_no: l.src_no, ordered_on: l.d, qty: 0, val: 0, grn: new Set() };
    x.qty += l.qty; x.val += (l.extra?.price || 0) * l.qty; if (l.d && (!x.ordered_on || l.d < x.ordered_on)) x.ordered_on = l.d; x.grn.add(l.doc_no); m.set(k, x);
  }
  return [...m.values()].map((x) => ({ code: x.code, po_no: x.po_no, ordered_on: x.ordered_on, qty: Math.round(x.qty), unit_price: x.qty ? +(x.val / x.qty).toFixed(6) : 0, currency: 'USD', source: 'kingdee', note: `金蝶入库 ${[...x.grn].join(' / ')}`.slice(0, 200) }));
}

// 读 Excel：每一页给出认出来的种类
export async function readFiles(files) {
  const XLSX = await import('xlsx'); const out = [];
  for (const f of files) {
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
      if (rows.length < 2) continue;
      let kind = detect(rows[0] || []);
      if (kind === 'feishu' && name !== 'Sales Order' && wb.SheetNames.includes('Sales Order')) kind = 'skip';   // 飞书整本只用「Sales Order」这一页（FOB 页、1-22 之前那页不进）
      if (kind === 'skip' && wb.SheetNames.length > 1) continue;   // 飞书整本里别的页不列出来
      out.push({ file: f.name, sheet: name, kind, rows });
    }
  }
  return out;
}
