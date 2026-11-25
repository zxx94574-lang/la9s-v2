// 按采购单看利润（Frank 11-25）：选一个采购单号 → 这单的货卖了多少、赚了多少、还剩多少
// 后端 app.po_profit：同一编码的批次先进先出，出库按时间分到批次，收入按那几张出库单的单价算
import React, { useMemo, useState } from 'react';
import { call } from '../db/client.js';
import { useApp, useData, Info, Choice, Pill } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ModelLink, CustLink, DealLink } from '../components/Archives.jsx';
import { money, qty, dt, dDate } from '../lib/format.js';
import { useMarginRules } from '../components/Margin.jsx';

const N = (x) => Number(x) || 0;
const pct = (p, r) => (r > 0 ? (p / r) * 100 : null);

export default function PoProfit() {
  const { org, role, tick } = useApp();
  const { lowPct } = useMarginRules();
  const [po, setPo] = useState(() => { try { return localStorage.getItem('la9s.poProfit') || '*'; } catch { return '*'; } });
  const pick = (v) => { setPo(v); try { localStorage.setItem('la9s.poProfit', v); } catch { /* */ } };
  const { data, error } = useData(() => call(role, `select * from app.po_profit($1)`, [org]), [org, role, tick]);
  const rows = useMemo(() => data || [], [data]);
  const byPo = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const g = m.get(r.po_no) || { po_no: r.po_no, ordered_on: r.ordered_on, models: 0, qty: 0, sold: 0, left: 0, revenue: 0, cost_sold: 0, cost_all: 0, cost_left: 0, last: null, est: false };
      g.models += 1; g.qty += N(r.qty); g.sold += N(r.sold); g.left += N(r.left_qty); g.revenue += N(r.revenue); g.cost_sold += N(r.cost_sold);
      g.cost_all += N(r.unit_cost) * N(r.qty); g.cost_left += N(r.unit_cost) * N(r.left_qty);
      if (r.last_sold && (!g.last || r.last_sold > g.last)) g.last = r.last_sold;
      if (r.rate_basis === '现在定价汇率') g.est = true;
      if (r.ordered_on && (!g.ordered_on || r.ordered_on < g.ordered_on)) g.ordered_on = r.ordered_on;
      m.set(r.po_no, g);
    }
    return [...m.values()].map((g) => ({ ...g, profit: g.revenue - g.cost_sold, id: g.po_no }));
  }, [rows]);
  if (error) return <div className="card"><div className="empty">{String(error.message || error)}</div></div>;
  if (!data) return <div className="card"><div className="empty">加载中…</div></div>;
  const one = po !== '*' ? byPo.find((g) => g.po_no === po) : null;
  const detail = one ? rows.filter((r) => r.po_no === po).map((r) => ({ ...r, id: r.product_id + r.po_no })) : [];
  const mTone = (m) => (m == null ? 'gray' : m < 0 ? 'red' : m < lowPct ? 'amber' : 'green');
  const Mg = ({ p, r }) => { const m = pct(p, r); return m == null ? <span className="muted">—</span> : <Pill tone={mTone(m)}>{m.toFixed(1)}%</Pill>; };
  const tot = byPo.reduce((a, g) => ({ revenue: a.revenue + g.revenue, profit: a.profit + g.profit, left: a.left + g.cost_left }), { revenue: 0, profit: 0, left: 0 });
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Profit par achat</div><h1>按采购单看利润 <Info>同一个编码的几批货按<b>先进先出</b>排队（下单日期早的先卖），出库也按时间排队：某批的第几片卖给了哪几张出库单，就按那几张单的单价算收入。<br />成本 / 片 = 采购价 × <b>这批的付款汇率</b>（物料档案批次表里填；没填就按现在的定价汇率，标黄「估」）+ 这批每片运费。只算出库，没扣退货。</Info></h1></div>
        <Choice value={po} onChange={pick} width={260} options={[['*', `全部采购单（${byPo.length}）`], ...byPo.map((g) => [g.po_no, `${g.po_no}${g.ordered_on ? ` · ${dDate(g.ordered_on)}` : ''}`])]} /></div>
      {!rows.length && <div className="card"><div className="empty">还没有批次。物料档案 → 采购批次 里录（或从箱单 / 金蝶采购单导入），写上采购单号，这里就按单号算。</div></div>}
      {!!rows.length && (one ? <PoCard g={one} Mg={Mg} /> : (
        <div className="card"><div className="card-b"><div className="d2-row" style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div><div className="small muted">已卖出的收入</div><div style={{ fontSize: 26, fontWeight: 700 }}>{money(tot.revenue)} <span className="small muted">XOF</span></div></div>
          <div><div className="small muted">已赚</div><div style={{ fontSize: 26, fontWeight: 700, color: tot.profit < 0 ? 'var(--red, #c62828)' : undefined }}>{money(tot.profit)}</div><Mg p={tot.profit} r={tot.revenue} /></div>
          <div><div className="small muted">还压在库里的成本</div><div style={{ fontSize: 26, fontWeight: 700 }}>{money(tot.left)}</div></div>
        </div></div></div>))}
      {!!rows.length && <div className="card">{one
        ? <Grid id="po-profit-d" rows={detail} empty="这单没有批次" columns={[
          { key: 'code', label: '编码', w: 110, render: (r) => <span className="mono">{r.code}</span> },
          { key: 'model', label: '型号', w: 150, render: (r) => <><ModelLink id={r.product_id} model={r.model} /> <span className="small muted">{r.category}</span></> },
          { key: 'qty', label: '进了', w: 80, type: 'number', sum: true, render: (r) => qty(r.qty) },
          { key: 'unit_cost', label: '成本 / 片', w: 110, type: 'number', render: (r) => <>{money(r.unit_cost)}{r.rate_basis === '现在定价汇率' && <span className="pill amber" title="这批没填付款汇率，按现在的定价汇率估" style={{ marginLeft: 4 }}>估</span>}</> },
          { key: 'sold', label: '卖了', w: 80, type: 'number', sum: true, render: (r) => qty(r.sold) },
          { key: 'avg', label: '平均卖价', w: 100, type: 'number', value: (r) => (N(r.sold) ? Math.round(N(r.revenue) / N(r.sold)) : null), render: (r) => (N(r.sold) ? money(Math.round(N(r.revenue) / N(r.sold))) : '—') },
          { key: 'revenue', label: '收入', w: 120, type: 'number', sum: true, render: (r) => money(r.revenue) },
          { key: 'profit', label: '赚了', w: 120, type: 'number', sum: true, value: (r) => N(r.revenue) - N(r.cost_sold), render: (r) => <b style={{ color: N(r.revenue) - N(r.cost_sold) < 0 ? 'var(--red, #c62828)' : undefined }}>{money(N(r.revenue) - N(r.cost_sold))}</b> },
          { key: 'margin', label: '毛利率', w: 90, value: (r) => pct(N(r.revenue) - N(r.cost_sold), N(r.revenue)), render: (r) => <Mg p={N(r.revenue) - N(r.cost_sold)} r={N(r.revenue)} /> },
          { key: 'left_qty', label: '还剩', w: 80, type: 'number', sum: true, render: (r) => (N(r.left_qty) ? qty(r.left_qty) : <Pill tone="green">卖完</Pill>) },
          { key: 'last_sold', label: '最近卖出', w: 120, render: (r) => (r.last_sold ? dt(r.last_sold) : '—') },
        ]} />
        : <Grid id="po-profit" rows={byPo} onRowClick={(g) => pick(g.po_no)} empty="没有" columns={[
          { key: 'po_no', label: '采购单号', w: 170, render: (g) => <button type="button" className="linkbtn" onClick={() => pick(g.po_no)}>{g.po_no}</button> },
          { key: 'ordered_on', label: '下单', w: 100, render: (g) => (g.ordered_on ? dDate(g.ordered_on) : '—') },
          { key: 'models', label: '型号数', w: 70, type: 'number' },
          { key: 'qty', label: '进了', w: 90, type: 'number', sum: true, render: (g) => qty(g.qty) },
          { key: 'sold', label: '卖了', w: 90, type: 'number', sum: true, render: (g) => <>{qty(g.sold)} <span className="small muted">{g.qty ? Math.round((g.sold / g.qty) * 100) : 0}%</span></> },
          { key: 'revenue', label: '收入', w: 130, type: 'number', sum: true, render: (g) => money(g.revenue) },
          { key: 'profit', label: '赚了', w: 130, type: 'number', sum: true, render: (g) => <b style={{ color: g.profit < 0 ? 'var(--red, #c62828)' : undefined }}>{money(g.profit)}</b> },
          { key: 'margin', label: '毛利率', w: 90, value: (g) => pct(g.profit, g.revenue), render: (g) => <Mg p={g.profit} r={g.revenue} /> },
          { key: 'cost_left', label: '还压着的成本', w: 130, type: 'number', sum: true, render: (g) => (g.left ? money(g.cost_left) : <Pill tone="green">卖完</Pill>) },
          { key: 'est', label: '汇率', w: 80, value: (g) => (g.est ? '估' : '实付'), render: (g) => (g.est ? <Pill tone="amber">有估的</Pill> : <Pill tone="green">实付</Pill>) },
        ]} />}</div>}
      {one && <PoTrace po={one.po_no} />}
      {one && <CnyPricing rows={detail} />}
    </>);
}

// 330 人民币主线定价（Frank 11-16 的做法）：人民币价 = 进价 + 每片运费（向上取整到 1 元）+ 各档利润（元）；
// 西法价 = 人民币价 ÷ 回款汇率 ×（1 + 余量）向上到 100。参数存 org_settings 'cny_pricing'，中方在这里改。
const TIER_KEYS = [['S', 'S'], ['Wholesale shop', 'Wholesale'], ['Retail shop', 'Retail'], ['Repair shop', 'Repair']];
const CP_DEF = { rate10k: 107.2, extra: 5, round: 100, profit: { S: 2, 'Wholesale shop': 3, 'Retail shop': 4, 'Repair shop': 5 } };
function CnyPricing({ rows }) {
  const { org, role, toast, refresh, tick } = useApp();
  const { data } = useData(() => call(role, `select value from app.org_settings where org_id = $1 and key = 'cny_pricing'`, [org]), [org, role, tick]);
  const cfg = { ...CP_DEF, ...(data?.[0]?.value || {}), profit: { ...CP_DEF.profit, ...(data?.[0]?.value?.profit || {}) } };
  const save = async (patch) => { try { await call(role, `select app.set_org_setting($1,'cny_pricing',$2)`, [org, JSON.stringify({ ...cfg, ...patch })]); toast('已保存定价参数'); refresh(); } catch (e) { toast(String(e.message || e), 'err'); } };
  const cnyPerXof = cfg.rate10k / 10000;
  const cnyRows = rows.filter((r) => r.currency === 'CNY');
  const Num = ({ v, on, w = 70, step }) => <input className="in sm" style={{ width: w }} inputMode="decimal" defaultValue={v} step={step} onBlur={(e) => { const n = Number(e.target.value); if (n >= 0 && n !== Number(v)) on(n); }} />;
  return (
    <div className="card"><div className="card-h"><h2>按这单定价（人民币主线）</h2><Info>你 11-16 的做法：箱单人民币进价 + 每片运费（国际 + 本地派送 ÷ 片数，向上取整到 1 元）+ 各档利润（元）= 人民币价；西法价 = 人民币价 ÷ 回款汇率 ×（1 + 余量），向上到 100。客户付人民币就不加余量。参数改了全公司生效，只是算给你看，不会自动改挂牌价。</Info></div>
      <div className="card-b stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 6 }}>1 万西法 = <Num v={cfg.rate10k} on={(n) => save({ rate10k: n })} /> 元</label>
          <label className="row" style={{ gap: 6 }}>西法余量 <Num v={cfg.extra} w={50} on={(n) => save({ extra: n })} /> %</label>
          <span className="small muted">各档利润（元 / 片）：</span>
          {TIER_KEYS.map(([k, l]) => <label key={k} className="row" style={{ gap: 4 }}>{l}<Num v={cfg.profit[k]} w={50} on={(n) => save({ profit: { ...cfg.profit, [k]: n } })} /></label>)}
        </div>
        {!cnyRows.length ? <div className="muted small">这单的批次不是人民币进价，没法按人民币主线算。</div> : (
          <Grid id="po-cny-price" rows={cnyRows} columns={[
            { key: 'model', label: '型号', w: 140, render: (r) => <><ModelLink id={r.product_id} model={r.model} /> <span className="small muted">{r.category}</span></> },
            { key: 'unit_price', label: '进价 元', w: 80, type: 'number', render: (r) => N(r.unit_price).toFixed(2) },
            { key: 'fr', label: '运费 元 / 片', w: 90, type: 'number', value: (r) => Math.ceil(N(r.freight_xof) * cnyPerXof), render: (r) => <span title={`${money(r.freight_xof)} XOF`}>{Math.ceil(N(r.freight_xof) * cnyPerXof)}</span> },
            ...TIER_KEYS.map(([k, l]) => ({ key: 'p_' + k, label: `${l} 元 / 西法`, w: 130, type: 'number',
              value: (r) => N(r.unit_price) + Math.ceil(N(r.freight_xof) * cnyPerXof) + N(cfg.profit[k]),
              render: (r) => { const cny = N(r.unit_price) + Math.ceil(N(r.freight_xof) * cnyPerXof) + N(cfg.profit[k]); const xof = Math.ceil((cny / cnyPerXof) * (1 + N(cfg.extra) / 100) / cfg.round) * cfg.round;
                return <span><b>{+cny.toFixed(2)}</b> <span className="muted small">/ {money(xof)}</span></span>; } })),
          ]} />)}
      </div></div>);
}

function PoCard({ g, Mg }) {
  const sellPct = g.qty ? (g.sold / g.qty) * 100 : 0;
  // 回本：已收入 ≥ 整单成本
  const back = g.revenue - g.cost_all;
  return (
    <div className="card"><div className="card-b"><div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div><div className="small muted">{g.po_no} · 赚了</div><div style={{ fontSize: 30, fontWeight: 700, color: g.profit < 0 ? 'var(--red, #c62828)' : undefined }}>{money(g.profit)} <span className="small muted">XOF</span></div><Mg p={g.profit} r={g.revenue} /></div>
      <div><div className="small muted">收入</div><div style={{ fontSize: 20, fontWeight: 600 }}>{money(g.revenue)}</div></div>
      <div><div className="small muted">卖了</div><div style={{ fontSize: 20, fontWeight: 600 }}>{qty(g.sold)} / {qty(g.qty)} 片</div><div className="small muted">{sellPct.toFixed(0)}%</div></div>
      <div><div className="small muted">整单成本</div><div style={{ fontSize: 20, fontWeight: 600 }}>{money(g.cost_all)}</div></div>
      <div><div className="small muted">回本</div><div style={{ fontSize: 20, fontWeight: 600 }}>{back >= 0 ? <Pill tone="green">已回本 +{money(back)}</Pill> : <Pill tone="amber">还差 {money(-back)}</Pill>}</div></div>
      <div><div className="small muted">还压着</div><div style={{ fontSize: 20, fontWeight: 600 }}>{qty(g.left)} 片 · {money(g.cost_left)}</div></div>
      {g.est && <div className="small"><Pill tone="amber">有批次没填付款汇率，成本是估的</Pill></div>}
    </div></div></div>);
}

// 订单里每一行出掉的货来自哪张采购单（先进先出推出来的）；点单号跳到那张采购单的利润
export function DealSources({ deal, lines }) {
  const { role } = useApp();
  const { data } = useData(() => (role === 'admin' ? call(role, `select * from app.deal_line_sources($1)`, [deal.id]) : Promise.resolve([])), [deal.id, role]);
  if (role !== 'admin' || !data?.length) return null;
  const by = new Map(); for (const r of data) { if (!by.has(r.deal_line_id)) by.set(r.deal_line_id, []); by.get(r.deal_line_id).push(r); }
  const go = (po) => { try { localStorage.setItem('la9s.poProfit', po); } catch { /* */ } window.location.hash = '#/poprofit'; };
  return (
    <div className="card"><div className="card-h"><h2>货从哪来</h2><Info>按先进先出推算：这张单出掉的每一行，用的是哪张采购单（批次）的货。点单号看那张采购单赚了多少、还卖给了谁。退货已经扣掉。</Info></div>
      <div className="card-b stack" style={{ gap: 4 }}>{(lines || []).filter((l) => by.has(l.id)).map((l) => (
        <div key={l.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span style={{ minWidth: 160 }}><ModelLink id={l.product_id} model={l.model} /> <span className="small muted">{l.category}</span></span>
          {by.get(l.id).map((r) => <button key={r.po_no} type="button" className="chip" onClick={() => go(r.po_no)}><span className="mono">{r.po_no}</span> · {qty(r.qty)} 片</button>)}</div>))}
      </div></div>);
}

// 这张采购单卖给了谁
export function PoTrace({ po }) {
  const { org, role, tick } = useApp();
  const { data } = useData(() => call(role, `select * from app.po_trace($1,$2)`, [org, po]), [org, role, po, tick]);
  const rows = useMemo(() => (data || []).map((r, i) => ({ ...r, id: `${r.deal_id}-${r.product_id}-${i}` })), [data]);
  if (!data) return null;
  return (
    <div className="card"><div className="card-h"><h2>这单的货卖给了谁</h2></div>
      <Grid id="po-trace" rows={rows} empty="还没卖出去" columns={[
        { key: 'shipped_at', label: '出库', w: 120, render: (r) => dt(r.shipped_at) },
        { key: 'customer', label: '客户', w: 150, render: (r) => <CustLink id={r.customer_id} name={r.customer} /> },
        { key: 'biz_no', label: '订单', w: 140, render: (r) => <DealLink id={r.deal_id} no={r.out_no || r.biz_no} /> },
        { key: 'model', label: '型号', w: 130, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
        { key: 'qty', label: '片数', w: 80, type: 'number', sum: true },
        { key: 'px', label: '单价 XOF', w: 100, type: 'number', render: (r) => money(r.px) },
        { key: 'amt', label: '金额', w: 120, type: 'number', sum: true, value: (r) => N(r.qty) * N(r.px), render: (r) => money(N(r.qty) * N(r.px)) },
      ]} /></div>);
}
