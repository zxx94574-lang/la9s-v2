// 数据导入: 从 Excel / 金蝶导出表 / 飞书复制一块 (第一行是表头) 粘进来 → 按表头认列 → 变成导入函数要的 JSON.
// 表头认中文、金蝶字段名和飞书字段名, 认不出的列忽略. 每一类有模板 (表头 + 两行示例), 可以下载成 CSV.

const num = (v) => {
  if (v == null || v === '') return null;
  let s = String(v).replace(/[\s  ]/g, '').replace(/^(XOF|CFA|FCFA|¥|RMB)/i, '');
  s = /^-?\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');   // 28,5 (法语小数) vs 350,000 (千分位)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
export function date(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;   // 法语区 日/月/年
  if (/^\d{5}$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 864e5); return d.toISOString().slice(0, 10); }   // Excel 序列号
  return null;
}
const tier = (v) => {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return null;
  if (s === 'S' || s.startsWith('S ')) return 'S';
  if (s === 'A' || s.includes('WHOLESALE') || s.includes('批发')) return 'WHOLESALE';
  if (s === 'B' || s.includes('RETAIL') || s.includes('零售')) return 'RETAIL';
  if (s === 'C' || s.includes('REPAIR') || s.includes('维修')) return 'REPAIR';
  return null;
};
const list = (v) => String(v || '').split(/[/,，;；、\n]/).map((x) => x.trim()).filter(Boolean);
const kind = (v) => { const s = String(v || ''); return /回收|recycl/i.test(s) && /备件|spare/i.test(s) ? 'both' : /回收|recycl/i.test(s) ? 'recycle' : 'spare'; };
const yes = (v) => (v === '' || v == null ? null : /^(是|有|y|yes|oui|true|1|✓)$/i.test(String(v).trim()));

// field: [aliases, transform]
export const KINDS = {
  products: {
    label: '物料（Material Information）', fn: 'import_products',
    fields: {
      code: [['编码', '物料编码', 'code', 'item code', 'no']], category: [['种类', '物料类别', 'category', 'type']], model: [['型号', '规格型号', 'model']],
      brand: [['品牌', 'brand']], brand_group: [['大类', '品类', 'group']], cost_owner: [['货权', 'owner', 'LA/9S']], bin: [['库位', 'bin code', 'bin']],
      shared_models: [['通用机型', '通用', 'compatible', 'shared'], list], kingdee_code: [['金蝶编码', 'kingdee']],
      rmb_cost: [['人民币成本', '成本', 'rmb', 'cost'], num], freight: [['运费', 'freight', 'transport'], num],
      fee_s: [['S FEE', 'S费', 'fee s'], num], fee_a: [['A FEE', 'WHOLESALE FEE', 'fee a'], num], fee_b: [['B FEE', 'RETAIL FEE', 'fee b'], num], fee_c: [['C FEE', 'REPAIR FEE', 'fee c'], num],
    },
    required: ['code', 'category', 'model'],
    sample: [['编码', '种类', '型号', '品牌', '大类', '货权', '库位', '通用机型', '人民币成本', '运费', 'S FEE', 'A FEE', 'B FEE', 'C FEE'],
      ['1001', 'LCD', 'BG6M', 'TECNO', '屏幕', 'LA', 'A-1-2', 'SPARK 10/POP 7', '28.5', '120', '300', '500', '800', '1200'],
      ['1002', 'BACK COVER', 'BG6M', 'TECNO', '电池盖', 'LA', 'A-2-1', '', '3.2', '50', '100', '150', '250', '350']],
  },
  customers: {
    label: '客户（备件 / 回收）', fn: 'import_customers',
    fields: {
      code: [['客户编码', '编码', 'code']], name: [['客户名称', '名称', '店名', 'name', 'nom', 'boutique']], phone: [['电话', '手机', 'phone', 'téléphone', 'tel']],
      city: [['城市', '区', 'city', 'commune', 'ville']], tier: [['档位', '客户档位', 'tier', 'niveau'], tier], kind: [['类型', '客户类型', 'kind'], kind],
      market: [['市场', 'market', 'marché']], zone: [['区域', 'zone']], recycle_type: [['回收类型', 'recycle type', 'catégorie']],
      interested: [['有兴趣', '意向', 'intéressé', 'interested'], yes], note: [['备注', 'note', 'remarque']], credit_days: [['账期', 'credit days'], num],
    },
    required: ['name'],
    sample: [['客户编码', '客户名称', '电话', '城市', '档位', '类型', '市场', '回收类型', '有兴趣', '备注'],
      ['C101', 'BOUTIQUE EXEMPLE', '+225 07 00 00 00', 'Adjamé', 'Wholesale shop', '备件', 'Roxy', '', '', ''],
      ['', 'RECUP EXEMPLE', '+225 01 00 00 00', 'Abobo', '', '回收', '', 'Recycleurs', '是', '']],
  },
  stock: {
    label: '库存 + 库龄（金蝶即时库存 / 库存账龄）', fn: 'import_stock', asOf: true,
    fields: {
      code: [['物料编码', '编码', 'code']], warehouse: [['仓库', '仓库名称', 'warehouse']], qty: [['库存数量', '数量', '库存量', 'qty', '结存数量'], num], bin: [['库位', '仓位', 'bin']],
      a0_30: [['0-30', '0-30天', '30天以内'], num], a31_90: [['31-90', '31-90天'], num], a91_180: [['91-180', '91-180天'], num],
      a181_365: [['181-365', '181-365天'], num], a365: [['365以上', '365天以上', '>365', '一年以上'], num],
    },
    required: ['code', 'warehouse', 'qty'],
    sample: [['物料编码', '仓库', '库存数量', '库位', '0-30', '31-90', '91-180', '181-365', '365以上'],
      ['1001', 'LA', '120', 'A-1-2', '80', '40', '0', '0', '0'], ['1002', '9S', '300', 'B-3-1', '100', '100', '50', '50', '0']],
  },
  po: {
    label: '在途采购（金蝶采购订单）', fn: 'import_purchase_orders',
    fields: {
      po_no: [['单据编号', '采购订单号', '单号', 'po']], supplier: [['供应商', 'supplier']], mode: [['运输方式', '方式', 'mode'], (v) => (/空|air/i.test(v || '') ? 'air' : /海|sea/i.test(v || '') ? 'sea' : null)],
      ordered_on: [['采购日期', '下单日期', '日期', 'date'], date], eta: [['预计到货', '交货日期', 'eta'], date],
      code: [['物料编码', '编码', 'code']], model: [['型号', '物料名称', 'model']], qty: [['采购数量', '数量', 'qty'], num], qty_received: [['累计入库数量', '已入库', '入库数量', 'received'], num],
      remark: [['备注', 'remark']],
    },
    required: ['po_no', 'qty'],
    sample: [['单据编号', '供应商', '运输方式', '采购日期', '预计到货', '物料编码', '型号', '采购数量', '累计入库数量'],
      ['CGDD000101', '供应商示例', '海运', '2026-10-01', '2026-11-20', '1001', 'BG6M', '200', '0'],
      ['CGDD000101', '供应商示例', '海运', '2026-10-01', '2026-11-20', '1002', 'BG6M', '500', '0']],
  },
  batches: {
    label: '采购批次单价（金蝶采购订单导出 / Excel）', fn: 'import_product_batches',
    fields: {
      code: [['物料编码', '编码', 'code']], po_no: [['单据编号', '采购订单号', '采购单号', '批次', 'po']], ordered_on: [['订单日期', '采购日期', '日期', 'date'], date],
      qty: [['数量', '采购数量', 'qty'], num], unit_price: [['单价', '采购单价', 'unit price', 'price'], num],
      currency: [['币别', '币种', 'currency'], (v) => { const t = String(v || '').toUpperCase(); return /USD|美元|\$/.test(t) ? 'USD' : /CNY|RMB|人民币|¥/.test(t) ? 'CNY' : /XOF|CFA/.test(t) ? 'XOF' : null; }],
      freight_xof: [['每件运费', '运费 XOF', '运费'], num],
    },
    required: ['code', 'qty', 'unit_price'],
    // 金蝶采购订单导出没有币别列, 单价是美元 (表头带「订货供应商」认作金蝶); 别的表没写币别按人民币
    post: (r, head) => ({ ...r, currency: r.currency || (head.some((h) => /订货供应商|价税合计/.test(h)) ? 'USD' : 'CNY'), source: head.some((h) => /订货供应商/.test(h)) ? 'kingdee' : 'manual' }),
    sample: [['物料编码', '采购单号', '日期', '数量', '单价', '币别', '每件运费'],
      ['1001', 'PO261010007', '2026-10-10', '1000', '31', 'CNY', ''],
      ['1001', 'PO260917015', '2026-09-17', '2000', '4.3', 'USD', '']],
  },
  sales: {
    label: '月销量（备货看板用，按编码按月汇总）', fn: 'import_sales_history',
    fields: {
      code: [['物料编码', '编码', 'code']], month: [['月份', '年月', '日期', 'month'], (v) => { const d = date(v) || (String(v || '').match(/^(\d{4})[-/.年](\d{1,2})/) ? String(v).replace(/^(\d{4})[-/.年](\d{1,2}).*$/, (_, y, m) => `${y}-${m.padStart(2, '0')}-01`) : null); return d ? d.slice(0, 7) : null; }],
      qty: [['出库数量', '实发数量', '销量', '数量', 'qty'], num],
    },
    required: ['code', 'month', 'qty'],
    sample: [['物料编码', '月份', '出库数量'], ['1001', '2026-08', '320'], ['1001', '2026-09', '280']],
  },
  opening: {
    label: '应收期初（按单据，才有账龄）', fn: 'import_opening_items',
    fields: {
      customer_code: [['客户编码', '编码', 'customer code', 'code']], amount: [['未收金额', '应收余额', '金额', '余额', 'amount'], num],
      date: [['单据日期', '业务日期', '日期', 'date'], date], ref: [['单据编号', '单号', 'ref']], currency: [['币别', '币种', 'currency'], (v) => (/人民|RMB|CNY/i.test(v || '') ? 'CNY' : /美|USD/i.test(v || '') ? 'USD' : v ? 'XOF' : null)],
    },
    required: ['customer_code', 'amount', 'date'],
    sample: [['客户编码', '单据编号', '单据日期', '未收金额', '币种'], ['C101', 'AR-2026-0001', '2026-08-15', '350000', 'XOF'], ['C101', 'AR-2026-0002', '2026-10-02', '120000', 'XOF']],
  },
};

function splitLine(line, sep) {
  if (sep === '\t') return line.split('\t').map((x) => x.trim().replace(/^"|"$/g, ''));
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim()); return out;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-()（）:：]/g, '');

export function parse(kindKey, text) {
  const K = KINDS[kindKey];
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], cols: [], missing: K.required, problems: [] };
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const head = splitLine(lines[0].replace(/^\ufeff/, ''), sep);
  const map = {};
  for (const [f, [aliases]] of Object.entries(K.fields)) {
    const al = aliases.map(norm);
    let i = head.findIndex((h) => al.includes(norm(h)));
    if (i < 0) i = head.findIndex((h) => al.some((a) => a.length > 2 && norm(h).includes(a)));
    if (i >= 0 && !Object.values(map).includes(i)) map[f] = i;
  }
  const missing = K.required.filter((f) => !(f in map));
  const rows = []; const problems = [];
  lines.slice(1).forEach((line, n) => {
    const c = splitLine(line, sep);
    if (c.every((x) => !x)) return;
    const r = {};
    for (const [f, i] of Object.entries(map)) { const tf = K.fields[f][1]; const v = c[i] ?? ''; r[f] = tf ? tf(v) : v || null; }
    const bad = K.required.filter((f) => r[f] == null || r[f] === '');
    if (bad.length) problems.push({ line: n + 2, why: `缺 ${bad.map((b) => K.fields[b][0][0]).join('、')}` });
    else rows.push(K.post ? K.post(r, head) : r);
  });
  return { rows, cols: Object.keys(map).map((f) => ({ key: f, label: K.fields[f][0][0], from: head[map[f]] })), missing, problems, ignored: head.filter((_, i) => !Object.values(map).includes(i)) };
}

export function templateCsv(kindKey) {
  return '﻿' + KINDS[kindKey].sample.map((r) => r.map((x) => (/[,"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',')).join('\n');
}
