// 328 (Frank 11-16): 毛利分析 —— 只中方
// ① 已出货: 任意组合细分 (档位 / 种类 / 型号 / 客户 / 销售员 / 月份 / 本地 · FOB), 下面明细表的筛选会同时作用到上面的汇总和交叉表
// ② 库存毛利: 四个档位各算一列 + 按最近 3 个月各档实际出货占比加权 (数据不够就写「数据不足」, 不硬凑)
// ③ 和金蝶对: 粘贴金蝶导出的出库成本 / 毛利表, 按编码和我们的数并排, 差额一眼看出来
import { RuleGear } from '../components/Rules.jsx';
import React, { useMemo, useState } from 'react';
import { call } from '../db/client.js';
import { useApp, useData, DatePicker, Info, MoneyIn, usePeriod, PeriodBar, TierPill } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { DealLink, ModelLink, CustLink } from '../components/Archives.jsx';
import { periodRange, PERIODS, money, qty, today } from '../lib/format.js';
import { sumMargin, MarginPill, MarginKpis, useMarginRules, TIER_LABEL, marginCols } from '../components/Margin.jsx';

const N = (v) => Number(v || 0);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const DIMS = [
  ['tier', '档位', (r) => TIER_LABEL[r.tier] || '（没档位）'],
  ['category', '种类', (r) => r.category || '（没种类）'],
  ['model', '型号', (r) => r.model || '（补录）'],
  ['customer', '客户', (r) => r.customer_name],
  ['owner', '销售员', (r) => r.owner_name || '（没归属）'],
  ['month', '月份', (r) => r.month],
  ['supply', '本地 / FOB', (r) => (r.supply === 'fob' ? 'FOB' : '本地')],
];
const TIER_OF = { S: 'S', Wholesale: 'WHOLESALE', Retail: 'RETAIL', Repair: 'REPAIR' };   // 交叉表里的档位 key → 色块 (473)
const tierCell = (k) => (TIER_OF[k] ? <TierPill tier={TIER_OF[k]} short /> : k);
const DIM_ORDER = { tier: ['S', 'Wholesale', 'Retail', 'Repair', '（没档位）'] };
const sortKeys = (dim, keys) => {
  const o = DIM_ORDER[dim];
  return [...keys].sort((a, b) => (o ? (o.indexOf(a) + 1 || 99) - (o.indexOf(b) + 1 || 99) : dim === 'month' ? b.localeCompare(a) : a.localeCompare(b, 'zh')));
};

export default function MarginPage() {
  const { org, role } = useApp();
  const [tab, setTab] = useState('sold');
  if (role !== 'admin') return <div className="card"><div className="card-b muted">只有中方能看毛利。</div></div>;
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Marge brute</div><h1 tabIndex={0}>毛利分析 <RuleGear anchor="margin-rules" title="毛利 / 亏钱规则" ids={['margin.low', 'loss.on', 'loss.nocost']} /></h1>
        <Info>只有中方看得到。成本在出库那一刻锁定（当时的到岸成本，含物流）；退货、收货差异冲减、抹零 / 核销、价格调整、我们出的运费、我们承担的收款手续费都扣掉。毛利率 = 利润 ÷ 销售额，所有汇总都是加权（先把钱加起来再除），没有成本的行不算进毛利率。</Info></div></div>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[['sold', '已出货毛利'], ['stock', '库存毛利'], ['kd', '和金蝶对毛利']].map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'sold' && <Sold org={org} role={role} />}
      {tab === 'stock' && <StockMargin org={org} role={role} />}
      {tab === 'kd' && <KingdeeCompare org={org} role={role} />}
    </>
  );
}

function useMarginRows(org, role) {
  return useData(() => call(role, `select * from app.margin_rows($1)`, [org]), [org, role]);
}

function Sold({ org, role }) {
  const { lowPct } = useMarginRules();
  const P = usePeriod('margin'); const { from, to } = P;
  const [rowDim, setRowDim] = useState('tier'); const [colDim, setColDim] = useState('category');
  const { data } = useMarginRows(org, role);
  const inRange = useMemo(() => (data || []).filter((r) => { const d = iso(r.shipped_on); return d >= from && d <= to; }), [data, from, to]);
  const [shown, setShown] = useState(null);
  const rows = shown || inRange;
  const tot = useMemo(() => sumMargin(rows), [rows]);
  const pivot = useMemo(() => {
    const rf = DIMS.find((d) => d[0] === rowDim)[2]; const cf = colDim === 'none' ? () => '合计' : DIMS.find((d) => d[0] === colDim)[2];
    const cells = {}; const rk = new Set(); const ck = new Set();
    for (const r of rows) { const a = rf(r), b = cf(r); rk.add(a); ck.add(b); ((cells[a] ||= {})[b] ||= []).push(r); }
    const cols = colDim === 'none' ? ['合计'] : sortKeys(colDim, ck);
    return { cols, rows: sortKeys(rowDim, rk).map((k) => ({ key: k, cells: Object.fromEntries(cols.map((c) => [c, sumMargin(cells[k]?.[c] || [])])), all: sumMargin(Object.values(cells[k] || {}).flat()) })) };
  }, [rows, rowDim, colDim]);
  const cell = (t) => (t.n ? <span className="mpivot-cell"><MarginPill pct={t.pct} lowPct={lowPct} missing={!t.revKnown && t.revenue > 0} /><span className="small">利润 {money(Math.round(t.profit))} · {qty(t.qty)} 片</span></span> : <span className="muted small">—</span>);
  const sel = (v, set, withNone) => (
    <select className="in" style={{ width: 'auto' }} value={v} onChange={(e) => set(e.target.value)}>
      {withNone && <option value="none">不分</option>}
      {DIMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>);
  return (
    <>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <PeriodBar p={P} />
        <span className="small muted">按出库日期算</span>
      </div>
      <MarginKpis t={tot} lowPct={lowPct} />
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>交叉看</h2>
          <span className="row small" style={{ gap: 6 }}>行 {sel(rowDim, setRowDim)} 列 {sel(colDim, setColDim, true)}</span>
          <Info>每一格 = 这一组货的总利润 ÷ 总销售额（加权）。例：行选「档位」、列选「种类」，Wholesale 那一行电池那一格 = 卖给 Wholesale 客户的电池的毛利率。下面明细表里筛选（某个客户、某个销售员…）会同时作用到这张表和上面的汇总。</Info></div>
        <Grid id={`margin-pivot-${rowDim}-${colDim}`} compactTools rows={pivot.rows} rowKey={(r) => r.key} empty={!data ? '加载中…' : '这个时间段没有出库'} columns={[
          { key: 'key', label: DIMS.find((d) => d[0] === rowDim)[1], w: 150, render: (r) => (rowDim === 'tier' ? tierCell(r.key) : <b>{r.key}</b>) },
          ...(colDim === 'none' ? [] : pivot.cols.map((c) => ({ key: 'c_' + c, label: c, head: colDim === 'tier' ? tierCell(c) : undefined, w: 150, type: 'number', value: (r) => r.cells[c]?.pct ?? null, render: (r) => cell(r.cells[c]) }))),
          { key: 'all', label: '合计', w: 170, type: 'number', value: (r) => r.all.pct ?? null, render: (r) => cell(r.all) },
          { key: 'rev', label: '销售额', w: 120, type: 'number', value: (r) => r.all.revenue, render: (r) => money(Math.round(r.all.revenue)) },
          { key: 'share', label: '占利润', w: 90, type: 'number', value: (r) => (tot.profit ? r.all.profit / tot.profit * 100 : null), render: (r) => (tot.profit ? `${(r.all.profit / tot.profit * 100).toFixed(1)}%` : '') },
        ]} />
      </div>
      <div className="card">
        <div className="card-h"><h2>明细（每次出库的每个型号）</h2><Info>整单的运费、手续费、价格调整、核销按这张单各型号的销售额比例分摊到每一行，所以按型号、按种类加起来也对得上。「补算」= 系统上线前出的货，成本是按上线时的到岸成本补的。</Info></div>
        <Grid id="margin-rows" rows={inRange} onShown={(rs) => setShown(rs.length === inRange.length ? null : rs)} empty={!data ? '加载中…' : '这个时间段没有出库'} rowKey={(r) => r.shipment_line_id} columns={[
          { key: 'shipped_on', label: '出库日', w: 100, value: (r) => iso(r.shipped_on), render: (r) => iso(r.shipped_on) },
          { key: 'biz_no', label: '订单号', w: 150, render: (r) => <DealLink id={r.deal_id} no={r.biz_no} /> },
          { key: 'customer_name', label: '客户', w: 150, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
          { key: 'tier', label: '档位', w: 100, value: (r) => TIER_LABEL[r.tier] || '', render: (r) => <TierPill tier={r.tier} short empty="—" /> },
          { key: 'supply', label: '本地 / FOB', w: 90, value: (r) => (r.supply === 'fob' ? 'FOB' : '本地') },
          { key: 'owner_name', label: '销售员', w: 100 },
          { key: 'category', label: '种类', w: 90 },
          { key: 'model', label: '型号', w: 110, render: (r) => (r.product_id ? <ModelLink id={r.product_id} model={r.model} /> : r.model) },
          ...marginCols(lowPct),
          { key: 'freight', label: '分摊运费', w: 100, type: 'number', render: (r) => (N(r.freight) ? money(Math.round(r.freight)) : '') },
          { key: 'fee', label: '分摊手续费', w: 100, type: 'number', render: (r) => (N(r.fee) ? money(Math.round(r.fee)) : '') },
          { key: 'returned', label: '退货', w: 90, type: 'number', render: (r) => (N(r.returned) ? `−${money(Math.round(r.returned))}` : '') },
          { key: 'adjust', label: '调整 / 核销', w: 100, type: 'number', render: (r) => (N(r.adjust) ? money(Math.round(r.adjust)) : '') },
          { key: 'cost_src', label: '成本来源', w: 90, value: (r) => ({ ship: '出库锁定', backfill: '补算', missing: '缺成本' }[r.cost_src] || '') },
        ]} />
      </div>
    </>
  );
}

// ② 库存毛利
function StockMargin({ org, role }) {
  const { lowPct } = useMarginRules();
  const [kind, setKind] = useState('local');
  const { data } = useData(() => Promise.all([call(role, `select * from app.stock_margin($1)`, [org]), call(role, `select tier, qty, shipped_on from app.margin_rows($1)`, [org])]), [org, role]);
  const calc = useMemo(() => {
    if (!data) return null;
    const [stock, sold] = data;
    // 最近 3 个月各档出货占比 (按片数); 自己的出货不满 30 天 = 数据不足
    const since = new Date(); since.setDate(since.getDate() - 90); const s0 = since.toISOString().slice(0, 10);
    const recent = sold.filter((r) => iso(r.shipped_on) >= s0 && r.tier);
    const days = recent.length ? (Date.now() - new Date(recent.map((r) => iso(r.shipped_on)).sort()[0]).getTime()) / 864e5 : 0;
    const mixQ = { S: 0, WHOLESALE: 0, RETAIL: 0, REPAIR: 0 }; for (const r of recent) mixQ[r.tier] = (mixQ[r.tier] || 0) + N(r.qty);
    const mixTot = Object.values(mixQ).reduce((a, b) => a + b, 0);
    const mix = days >= 30 && mixTot > 0 ? Object.fromEntries(Object.entries(mixQ).map(([k, v]) => [k, v / mixTot])) : null;
    const rows = stock.filter((r) => r.wh_kind === kind);
    const by = {};
    const add = (k, r) => {
      const a = (by[k] ||= { key: k, qty: 0, cost: 0, missingQty: 0, t: { S: [0, 0], WHOLESALE: [0, 0], RETAIL: [0, 0], REPAIR: [0, 0] } });
      a.qty += N(r.qty);
      if (r.unit_cost == null) { a.missingQty += N(r.qty); return; }
      a.cost += N(r.qty) * N(r.unit_cost);
      for (const [tk, pk] of [['S', 'price_s'], ['WHOLESALE', 'price_w'], ['RETAIL', 'price_r'], ['REPAIR', 'price_p']]) {
        if (r[pk] == null) continue;
        a.t[tk][0] += N(r.qty) * N(r[pk]); a.t[tk][1] += N(r.qty) * N(r.unit_cost);   // [销售额, 有价那部分的成本]
      }
    };
    for (const r of rows) { add(r.category || '（没种类）', r); add('__all', r); }
    const fin = (a) => {
      const pct = (tk) => (a.t[tk][0] ? (a.t[tk][0] - a.t[tk][1]) / a.t[tk][0] * 100 : null);
      let blend = null;
      if (mix) { let sale = 0, cost = 0; for (const tk of Object.keys(mix)) { sale += a.t[tk][0] * mix[tk]; cost += a.t[tk][1] * mix[tk]; } blend = sale ? (sale - cost) / sale * 100 : null; }
      return { ...a, pS: pct('S'), pW: pct('WHOLESALE'), pR: pct('RETAIL'), pP: pct('REPAIR'), blend };
    };
    const list = Object.values(by).filter((a) => a.key !== '__all').map(fin).sort((a, b) => b.cost - a.cost);
    return { list, all: by.__all ? fin(by.__all) : null, mix, mixQ, mixTot, days };
  }, [data, kind]);
  const pctCell = (v) => <MarginPill pct={v} lowPct={lowPct} />;
  return (
    <>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="seg">{[['local', '本地仓（LA / 9S）'], ['fob', 'FOB 仓']].map(([k, l]) => <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>
        <span className="small muted">成本 = 现在的到岸成本；售价 = 物料定价里各档的价。待检 / 报废 / 回收仓不算。</span>
      </div>
      {calc?.all && (
        <div className="mkpis">
          <div className="mkpi"><div className="k">库存片数</div><div className="v">{qty(calc.all.qty)}</div>{calc.all.missingQty > 0 && <div className="s">{qty(calc.all.missingQty)} 片没有成本，没算进去</div>}</div>
          <div className="mkpi"><div className="k">库存成本</div><div className="v">{money(Math.round(calc.all.cost))}</div></div>
          {[['S', 'pS'], ['WHOLESALE', 'pW'], ['RETAIL', 'pR'], ['REPAIR', 'pP']].map(([l, k]) => <div className="mkpi" key={k}><div className="k">全按 <TierPill tier={l} short /> 卖</div><div className="v">{pctCell(calc.all[k])}</div></div>)}
          <div className="mkpi"><div className="k">按最近 3 个月出货比例</div><div className="v">{calc.mix ? pctCell(calc.all.blend) : <span className="pill gray">数据不足</span>}</div>
            <div className="s">{calc.mix ? Object.entries(calc.mix).filter(([, v]) => v > 0).map(([k, v]) => <span key={k} style={{ marginRight: 8, whiteSpace: 'nowrap' }}><TierPill tier={k} short /> {(v * 100).toFixed(0)}%</span>)
              : '系统里自己的出货要满 30 天才算；也可以先导入飞书 Sales Order 历史（待改 111）'}</div></div>
        </div>)}
      <div className="card">
        <div className="card-h"><h2>按种类</h2><Info>每一格 = 这类库存全部按这个档位的价卖掉的毛利率 =（Σ 售价 × 数量 − Σ 成本 × 数量）÷ Σ 售价 × 数量。没定这一档价的型号不算进这一格。</Info></div>
        <Grid id={`stock-margin-${kind}`} rows={calc?.list || []} rowKey={(r) => r.key} empty={!calc ? '加载中…' : '没有库存'} columns={[
          { key: 'key', label: '种类', w: 130, render: (r) => <b>{r.key}</b> },
          { key: 'qty', label: '片数', w: 90, type: 'number', render: (r) => qty(r.qty) },
          { key: 'cost', label: '成本', w: 130, type: 'number', render: (r) => money(Math.round(r.cost)) },
          { key: 'pS', label: 'S', head: <TierPill tier="S" short />, w: 100, type: 'number', render: (r) => pctCell(r.pS) },
          { key: 'pW', label: 'Wholesale', head: <TierPill tier="WHOLESALE" short />, w: 100, type: 'number', render: (r) => pctCell(r.pW) },
          { key: 'pR', label: 'Retail', head: <TierPill tier="RETAIL" short />, w: 100, type: 'number', render: (r) => pctCell(r.pR) },
          { key: 'pP', label: 'Repair', head: <TierPill tier="REPAIR" short />, w: 100, type: 'number', render: (r) => pctCell(r.pP) },
          { key: 'blend', label: '按出货比例', w: 120, type: 'number', render: (r) => (calc.mix ? pctCell(r.blend) : <span className="muted small">数据不足</span>) },
          { key: 'missingQty', label: '缺成本片数', w: 100, type: 'number', render: (r) => (r.missingQty ? <span className="pill gray">{qty(r.missingQty)}</span> : '') },
        ]} />
      </div>
    </>
  );
}

// ③ 和金蝶对毛利: 粘贴金蝶导出 (销售出库单 / 销售毛利表 / 存货出库成本表, 都行), 自动认列
const KD_COLS = {
  code: [/物料编码/, /^编码$/, /料号/, /物料代码/],
  qty: [/实发数量/, /^数量$/, /出库数量/, /销售数量/],
  sale: [/价税合计/, /销售收入/, /^金额$/, /收入/],
  cost: [/成本金额/, /出库成本/, /销售成本/, /^成本$/, /总成本/],
};
export function parseKingdee(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.split('\t')).filter((r) => r.some((c) => c.trim()));
  if (lines.length < 2) return { error: '至少要有表头和一行数据（从金蝶导出的 Excel 里整块复制过来）' };
  const hi = lines.findIndex((r) => r.some((c) => KD_COLS.code.some((re) => re.test(c.trim()))));
  if (hi < 0) return { error: '没找到「物料编码」这一列' };
  const head = lines[hi].map((c) => c.trim());
  const idx = Object.fromEntries(Object.entries(KD_COLS).map(([k, res]) => [k, head.findIndex((h) => res.some((re) => re.test(h)))]));
  const num = (v) => { const n = Number(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const by = {};
  for (const r of lines.slice(hi + 1)) {
    const code = String(r[idx.code] || '').trim(); if (!code || /合计|小计/.test(code)) continue;
    const a = (by[code] ||= { code, qty: 0, sale: 0, cost: 0 });
    if (idx.qty >= 0) a.qty += num(r[idx.qty]); if (idx.sale >= 0) a.sale += num(r[idx.sale]); if (idx.cost >= 0) a.cost += num(r[idx.cost]);
  }
  return { rows: Object.values(by), found: Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? head[i] : null])) };
}

function KingdeeCompare({ org, role }) {
  const { lowPct } = useMarginRules();
  const [range, setRange] = useState(() => periodRange('month'));
  const [text, setText] = useState('');
  const [cur, setCur] = useState('CNY');
  const [rate, setRate] = useState('');
  const { data } = useMarginRows(org, role);
  const parsed = useMemo(() => (text.trim() ? parseKingdee(text) : null), [text]);
  const k = cur === 'XOF' ? 1 : N(rate) > 0 ? 1 / N(rate) : null;   // 金蝶的钱 → XOF (rate = 1 XOF 等于几 元)
  const rows = useMemo(() => {
    if (!parsed?.rows || !data) return [];
    const ours = {};
    for (const r of data) { const d = iso(r.shipped_on); if (d < range[0] || d > range[1] || !r.product_code) continue;
      const a = (ours[r.product_code] ||= { qty: 0, rev: 0, cost: 0, model: r.model, product_id: r.product_id, missing: false });
      a.qty += N(r.qty); a.rev += N(r.revenue); if (r.cost_missing) a.missing = true; else a.cost += N(r.cost); }
    const codes = new Set([...Object.keys(ours), ...parsed.rows.map((r) => r.code)]);
    return [...codes].map((code) => {
      const o = ours[code]; const kd = parsed.rows.find((r) => r.code === code);
      const kdRev = kd && k ? kd.sale * k : null, kdCost = kd && k ? kd.cost * k : null;
      return { code, model: o?.model || '', product_id: o?.product_id, oQty: o?.qty ?? 0, kQty: kd?.qty ?? 0, oRev: o?.rev ?? 0, kRev: kdRev, oCost: o?.missing ? null : o?.cost ?? 0, kCost: kdCost,
        oPct: o && o.rev && !o.missing ? (o.rev - o.cost) / o.rev * 100 : null, kPct: kdRev ? (kdRev - kdCost) / kdRev * 100 : null };
    }).sort((a, b) => Math.abs((b.oCost ?? 0) - (b.kCost ?? 0)) - Math.abs((a.oCost ?? 0) - (a.kCost ?? 0)));
  }, [parsed, data, range, k]);
  const T = rows.reduce((a, r) => ({ oRev: a.oRev + r.oRev, kRev: a.kRev + (r.kRev ?? 0), oCost: a.oCost + (r.oCost ?? 0), kCost: a.kCost + (r.kCost ?? 0) }), { oRev: 0, kRev: 0, oCost: 0, kCost: 0 });
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>粘贴金蝶导出的数据</h2>
          <Info>在金蝶里导出同一段时间的「销售出库单」（带成本金额）或「销售毛利表」，Excel 里连表头整块复制，粘贴到下面。系统按「物料编码」认行，自动找 数量 / 价税合计（或销售收入）/ 成本金额 三列。每个编码两边的数并排：数量对不上 = 单据没录全或录错；数量对上、成本不同 = 两边成本算法不一样（金蝶常用加权平均，我们是出库时锁定的到岸成本且进到 100）。看几个月的差异就能知道金蝶用的是哪种算法。</Info></div>
        <div className="card-b stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="small">我们这边取</span><DatePicker range value={range} onChange={setRange} />
            <span className="small">金蝶的钱是</span>
            <select className="in" style={{ width: 'auto' }} value={cur} onChange={(e) => setCur(e.target.value)}><option value="CNY">人民币</option><option value="XOF">西法</option></select>
            {cur === 'CNY' && <><span className="small">1 XOF =</span><MoneyIn className="in" style={{ width: 90 }} inputMode="decimal" placeholder="0.011" value={rate} onChange={(e) => setRate(e.target.value)} /><span className="small">元（用那个月的汇率）</span></>}
          </div>
          <textarea className="in" rows={5} placeholder="在这里粘贴（⌘V）" value={text} onChange={(e) => setText(e.target.value)} />
          {parsed?.error && <div className="pill red" style={{ whiteSpace: 'normal' }}>{parsed.error}</div>}
          {parsed?.found && <div className="small muted">认出的列：编码 = {parsed.found.code || '没找到'} · 数量 = {parsed.found.qty || '没找到'} · 金额 = {parsed.found.sale || '没找到'} · 成本 = {parsed.found.cost || '没找到'} · {parsed.rows.length} 个编码</div>}
          {cur === 'CNY' && !k && parsed?.rows && <div className="pill amber" style={{ whiteSpace: 'normal' }}>先填汇率才能把金蝶的人民币折成西法比</div>}
        </div>
      </div>
      {rows.length > 0 && (
        <>
          <div className="mkpis">
            <div className="mkpi"><div className="k">销售额 我们 / 金蝶</div><div className="v" style={{ fontSize: 17 }}>{money(Math.round(T.oRev))} / {k ? money(Math.round(T.kRev)) : '—'}</div></div>
            <div className="mkpi"><div className="k">成本 我们 / 金蝶</div><div className="v" style={{ fontSize: 17 }}>{money(Math.round(T.oCost))} / {k ? money(Math.round(T.kCost)) : '—'}</div></div>
            <div className="mkpi"><div className="k">毛利率 我们 / 金蝶</div><div className="v"><MarginPill pct={T.oRev ? (T.oRev - T.oCost) / T.oRev * 100 : null} lowPct={lowPct} /> / <MarginPill pct={k && T.kRev ? (T.kRev - T.kCost) / T.kRev * 100 : null} lowPct={lowPct} /></div></div>
          </div>
          <div className="card">
            <div className="card-h"><h2>按编码对比</h2><span className="small muted">差得最多的排最前</span></div>
            <Grid id="kd-margin-compare" rows={rows} rowKey={(r) => r.code} columns={[
              { key: 'code', label: '编码', w: 110 },
              { key: 'model', label: '型号', w: 110, render: (r) => (r.product_id ? <ModelLink id={r.product_id} model={r.model} /> : r.model) },
              { key: 'oQty', label: '数量 我们', w: 90, type: 'number', render: (r) => qty(r.oQty) },
              { key: 'kQty', label: '数量 金蝶', w: 90, type: 'number', render: (r) => <span className={r.kQty !== r.oQty ? 'red-t2' : ''}>{qty(r.kQty)}</span> },
              { key: 'oCost', label: '成本 我们', w: 120, type: 'number', render: (r) => (r.oCost == null ? <span className="pill gray">缺成本</span> : money(Math.round(r.oCost))) },
              { key: 'kCost', label: '成本 金蝶', w: 120, type: 'number', render: (r) => (r.kCost == null ? '—' : money(Math.round(r.kCost))) },
              { key: 'unit', label: '每片成本 我们 / 金蝶', w: 170, value: (r) => (r.oQty && r.kQty && r.oCost != null && r.kCost != null ? r.oCost / r.oQty - r.kCost / r.kQty : null),
                render: (r) => (r.oQty && r.kQty && r.oCost != null && r.kCost != null ? `${money(Math.round(r.oCost / r.oQty))} / ${money(Math.round(r.kCost / r.kQty))}` : '') },
              { key: 'oPct', label: '毛利率 我们', w: 110, type: 'number', render: (r) => <MarginPill pct={r.oPct} lowPct={lowPct} /> },
              { key: 'kPct', label: '毛利率 金蝶', w: 110, type: 'number', render: (r) => <MarginPill pct={r.kPct} lowPct={lowPct} /> },
              { key: 'why', label: '可能的原因', w: 220, value: (r) => (r.kQty !== r.oQty ? '数量不一样' : ''), render: (r) => (!r.kQty ? <span className="small">金蝶没有这个编码的出库（没录？）</span>
                : !r.oQty ? <span className="small">系统里这段时间没出这个编码</span>
                  : r.kQty !== r.oQty ? <span className="small red-t2">数量不一样：先查单据</span>
                    : r.oCost != null && r.kCost != null && Math.abs(r.oCost - r.kCost) / Math.max(1, r.kCost) > 0.02 ? <span className="small">数量对上，成本算法不同</span> : <span className="small">对得上</span>) },
            ]} />
          </div>
        </>)}
    </>
  );
}
