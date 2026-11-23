// 426–437 (Frank 11-19): 经营总览的板块 —— 总览 / 本地销售与毛利 / FOB 销售与毛利 / 账款四张卡 / 打卡情况 / 客户拜访 / 热线电话.
// 统一做法: 标题 → 一个大数 (带单位, 不省略) → 小方框 → 右端小实心 ▼ 展开明细 (默认收起).
import React, { useCallback, useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Assumed, Modal, MoneyIn, Choice, Info, TierPill } from './ui.jsx';
import { CustLink, EmpLink, DealLink, ModelLink } from './Archives.jsx';
import { useMarginRules } from './Margin.jsx';
import { usePublicHeld } from './PublicHeld.jsx';
import { useRemits, useRemitRules, remitFlag, remitCols } from './Remit.jsx';
import { LayoutGrid } from './Layout.jsx';
import Grid from './Grid.jsx';
import { money, qty, dDate, today } from '../lib/format.js';
import { TIERS } from '../lib/domain.js';

const N = (v) => Number(v || 0);
const ymd = (v) => { if (!v) return ''; const x = v instanceof Date ? v : new Date(v); return isNaN(x) ? String(v).slice(0, 10) : x.toISOString().slice(0, 10); };
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
const useLs = (k, d) => { const [v, setV] = useState(() => ls.get(k, d)); return [v, (x) => { setV(x); ls.set(k, x); }]; };
const CURS = ['XOF', 'CNY', 'USD'];
const AMBER = '#8DB4EE';   // 440 (Frank 11-19): FOB 用浅蓝, 和品牌蓝同色系; 全站「本地 vs FOB」= 品牌蓝 + 浅蓝

// 小实心三角: 展开 / 收起明细
// 439 (Frank 11-19): 展开明细的按钮全站统一, 永远在板块 / 卡片的右下角; 11-20 Frank: 明细一律用 ☰ 图标 (和单号预览同一个), 只放大不加框
// 11-20 Frank: 只留 ☰ 图标, 不要「明细 / 收起」两个字; 展开 = 图标变实心蓝, 收起 = 回到白底
export const Fold = ({ open, onClick, label = '明细' }) => <button type="button" className={`fold-btn ico-only ${open ? 'on' : ''}`} onClick={onClick} aria-expanded={!!open} aria-label={open ? '收起' : label} title={open ? '收起' : label}><i className="fold-ico">☰</i></button>;
const Amt = ({ v, cur, tone }) => <span className={`dk-v ${tone || ''}`}>{v == null ? '—' : money(v, cur)}<small>{cur}</small></span>;

// ───────── 折算 ─────────
// 行里的销售额 / 成本都是 XOF; k = 这张单 1 原币 = 多少 XOF; rmb_per_xof / xof_per_usd = 出库那天的记账汇率
// m = { target, rates? }: rates (统一汇率, 手填) = { 源币种: 1 源币 = 多少目标币 }
function toCur(r, m) {
  const t = m.target; const cur = r.currency || 'XOF'; const k = N(r.k) || 1;
  const lock = (xof) => (t === 'XOF' ? xof : t === 'CNY' ? xof * N(r.rmb_per_xof) : N(r.xof_per_usd) ? xof / N(r.xof_per_usd) : 0);
  let rev, cost;
  if (m.rates) {
    rev = cur === t ? N(r.revenue) / k : N(r.revenue) / k * N(m.rates[cur]);
    cost = t === 'XOF' ? N(r.cost) : N(r.cost) * N(m.rates.XOF);
  } else {
    rev = cur === t ? N(r.revenue) / k : lock(N(r.revenue));
    cost = cur === t && t !== 'XOF' ? N(r.cost) / k : lock(N(r.cost));
  }
  return { rev, cost: r.cost_missing ? 0 : cost, known: r.cost_missing ? 0 : rev, qty: N(r.qty), miss: r.cost_missing ? N(r.qty) : 0 };
}
function total(rows, m) {
  const t = { rev: 0, cost: 0, known: 0, qty: 0, miss: 0, deals: new Set(), custs: new Set(), missModels: new Map() };
  for (const r of rows) {
    const c = toCur(r, m); t.rev += c.rev; t.cost += c.cost; t.known += c.known; t.qty += c.qty; t.miss += c.miss; t.deals.add(r.deal_id || r.fob_project_id); t.custs.add(r.customer_id);
    if (r.cost_missing) { const x = t.missModels.get(r.product_id) || { id: r.product_id, code: r.product_code, model: r.model, category: r.category, qty: 0 }; x.qty += N(r.qty); t.missModels.set(r.product_id, x); }
  }
  t.profit = t.known - t.cost; t.pct = t.known ? t.profit / t.known * 100 : null; t.n = t.deals.size; t.c = t.custs.size;
  return t;
}
const pctTone = (p, low) => (p == null ? '' : p < 0 ? 'red' : p < low ? 'amber' : 'green');
const Pct = ({ p, low }) => (p == null ? <span className="muted">—</span> : <span className={`pill ${pctTone(p, low)}`}>{p.toFixed(1)}%</span>);
// 看板卡片上的百分比 = 同一种色块, 大一号 (Frank 11-20: 和表格里的小块一样, 只是更大)
export const BigPct = ({ p, low }) => (p == null ? <span className="dk-v muted">—</span> : <span className={`pill dk-pct ${pctTone(p, low)}`}>{p.toFixed(1)}<small>%</small></span>);

export function useDashRows(from, to) {
  const { org, role, tick } = useApp();
  const { data } = useData(() => (role === 'admin' ? call(role, `select * from app.dash_rows($1)`, [org]) : Promise.resolve(null)), [org, role, tick]);
  return useMemo(() => (data ? data.filter((r) => { const d = ymd(r.shipped_on); return d >= from && d <= to; }) : data), [data, from, to]);
}

// ───────── 总览 (本地 + FOB 合在一起, 只算已出库的) ─────────
export function Overview({ rows }) {
  const { lowPct } = useMarginRules();
  const [target, setTarget] = useLs('la9s.dash.ov.cur', 'CNY');
  const [open, setOpen] = useLs('la9s.dash.ov.open', false);
  const m = { target };
  const loc = total(rows.filter((r) => r.supply !== 'fob'), m), fob = total(rows.filter((r) => r.supply === 'fob'), m), all = total(rows, m);
  // Frank 11-20: 卡片上只放合计, 不再上下堆「本地 / FOB」; 分业务的数放进 ☰ 明细
  const card = (title, v, tone) => (
    <div className="dk"><div className="dk-t">{title} <small>{target}</small></div><Amt v={v} cur={target} tone={tone} /></div>);
  const biz = [['本地', loc, 'var(--brand)'], ['FOB', fob, AMBER]].map(([name, t, color]) => ({ id: name, name, color, t }));
  return (
    <div className="card dash-sec">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>总览 <Info>本地 + FOB 合在一起，只算已经出库的。分业务的数在右下角「☰ 明细」里。</Info>
          <Assumed>折算用「出库那天的记账汇率」（汇率与取整里改一次、记一次，从 11-19 起留历史；之前的出库都按现在这个汇率）。要用自己指定的汇率，到下面本地 / FOB 板块点「合并币种 → 统一汇率」。</Assumed></h2>
        <span className="grow" />
        <div className="seg sm">{CURS.map((c) => <button type="button" key={c} className={target === c ? 'on' : ''} onClick={() => setTarget(c)}>{c}</button>)}</div>
      </div>
      {!rows.length ? <div className="card-b muted small">这个时间段还没有出库</div> : <div className="card-b">
        <div className="dk-row">
          {card('销售额', all.rev)}
          {card('成本', all.cost)}
          {card('利润', all.profit, all.profit < 0 ? 'red-t2' : '')}
          <div className="dk"><div className="dk-t">毛利率</div><BigPct p={all.pct} low={lowPct} /></div>
        </div>
        <div className="dk-chips">
          <span className="dchip">出库 <b>{qty(all.qty)}</b> 片</span><span className="dchip"><b>{all.n}</b> 单</span><span className="dchip"><b>{all.c}</b> 位客户</span>
          {all.miss > 0 && <span className="dchip red">{qty(all.miss)} 片没成本，没算进毛利</span>}
          <span className="grow" />
          <Fold open={open} onClick={() => setOpen(!open)} />
        </div>
        {open && <div style={{ marginTop: 10 }}><Grid id="dash-ov" noTools rows={biz} columns={[
          { key: 'name', label: '业务', w: 110, sortable: false, filterable: false, render: (r) => <span className="dk-row0"><i className="dk-dot" style={{ background: r.color }} /><b>{r.name}</b></span> },
          { key: 'share', label: '占比', w: 130, sortable: false, filterable: false, value: (r) => (all.rev ? r.t.rev / all.rev * 100 : 0),
            render: (r) => { const p = all.rev ? r.t.rev / all.rev * 100 : 0; return <span className="dk-share"><span className="dbar"><i style={{ width: `${p}%`, background: r.color }} /></span><small>{p.toFixed(0)}%</small></span>; } },
          { key: 'rev', label: `销售额 ${target}`, w: 140, type: 'money', sortable: false, value: (r) => r.t.rev, render: (r) => money(r.t.rev, target) },
          { key: 'cost', label: `成本 ${target}`, w: 140, type: 'money', sortable: false, value: (r) => r.t.cost, render: (r) => money(r.t.cost, target) },
          { key: 'profit', label: `利润 ${target}`, w: 140, type: 'money', sortable: false, value: (r) => r.t.profit, render: (r) => <span className={r.t.profit < 0 ? 'red-t2' : ''}>{money(r.t.profit, target)}</span> },
          { key: 'pct', label: '毛利率', w: 90, type: 'number', sortable: false, value: (r) => r.t.pct, render: (r) => <Pct p={r.t.pct} low={lowPct} /> },
          { key: 'qty', label: '片', w: 90, type: 'number', sortable: false, value: (r) => r.t.qty, render: (r) => qty(r.t.qty) },
          { key: 'n', label: '单', w: 60, type: 'number', sortable: false, value: (r) => r.t.n },
          { key: 'c', label: '客户', w: 70, type: 'number', sortable: false, value: (r) => r.t.c },
        ]} foot={() => ({ name: '合计', rev: money(all.rev, target), cost: money(all.cost, target), profit: money(all.profit, target), pct: all.pct == null ? '—' : `${all.pct.toFixed(1)}%`, qty: qty(all.qty), n: all.n, c: all.c })} /></div>}
      </div>}
    </div>);
}

// ───────── 本地 / FOB 销售与毛利 ─────────
export function SalesSection({ kind, rows, transit }) {
  const { org, go } = useApp(); const { lowPct } = useMarginRules();
  const fob = kind === 'fob';
  const groups = useMemo(() => { const g = {}; for (const r of rows) { const c = r.currency || 'XOF'; (g[c] = g[c] || new Set()).add(r.deal_id || r.fob_project_id); } return CURS.filter((c) => g[c]).map((c) => [c, g[c].size]); }, [rows]);
  const [curS, setCur] = useLs(`la9s.dash.${kind}.cur`, null);
  const [merge, setMerge] = useState(fob ? { target: 'CNY' } : null);          // FOB 默认折人民币 (Frank 11-19); null | { target } | { target, rates }
  const [dlg, setDlg] = useState(false);
  const [open, setOpen] = useLs(`la9s.dash.${kind}.open`, false);
  const [dim, setDim] = useLs(`la9s.dash.${kind}.dim`, 'category');
  const [exp, setExp] = useState({});
  const [missOpen, setMissOpen] = useState(false);
  const def = fob ? 'CNY' : 'XOF';
  const cur = groups.find((g) => g[0] === curS)?.[0] || groups.find((g) => g[0] === def)?.[0] || groups[0]?.[0] || def;
  const m = merge || { target: cur };
  const list = merge ? rows : rows.filter((r) => (r.currency || 'XOF') === cur);
  const t = total(list, m); const C = m.target;

  // 明细表: 父行 (按种类 / 按档位; FOB 按客户) 默认收起, 点 ▸ 展开另一个维度 (FOB 展开到订单)
  const keyOf = fob ? { p: (r) => r.customer_id, pl: (r) => r.customer_name, c: (r) => r.deal_id || r.fob_project_id, cl: (r) => r.biz_no }
    : dim === 'category' ? { p: (r) => r.category || '（没种类）', pl: (r) => r.category || '（没种类）', c: (r) => r.tier || '-', cl: (r) => TIERS[r.tier] || '没定档' }
      : { p: (r) => r.tier || '-', pl: (r) => TIERS[r.tier] || '没定档', c: (r) => r.category || '（没种类）', cl: (r) => r.category || '（没种类）' };
  const table = useMemo(() => {
    const by = new Map();
    for (const r of list) { const k = keyOf.p(r); if (!by.has(k)) by.set(k, { k, label: keyOf.pl(r), rows: [], ref: r }); by.get(k).rows.push(r); }
    const out = [];
    const ps = [...by.values()].map((g) => ({ ...g, t: total(g.rows, m) })).sort((a, b) => b.t.rev - a.t.rev);
    for (const p of ps) {
      out.push({ id: 'p:' + p.k, lvl: 0, label: p.label, t: p.t, pk: p.k, ref: p.ref, tier: !fob && dim === 'tier' && p.k !== '-' ? p.k : null });
      if (!exp[p.k]) continue;
      const cb = new Map();
      for (const r of p.rows) { const k = keyOf.c(r); if (!cb.has(k)) cb.set(k, { k, label: keyOf.cl(r), rows: [], ref: r }); cb.get(k).rows.push(r); }
      for (const c of [...cb.values()].map((g) => ({ ...g, t: total(g.rows, m) })).sort((a, b) => b.t.rev - a.t.rev)) out.push({ id: `c:${p.k}:${c.k}`, pk: p.k, lvl: 1, label: c.label, t: c.t, ref: c.ref, tier: !fob && dim === 'category' && c.k !== '-' ? c.k : null });
    }
    return out;
  }, [list, exp, dim, kind, JSON.stringify(m)]);   // eslint-disable-line react-hooks/exhaustive-deps
  const parentOf = useCallback((r) => (r.lvl ? 'p:' + r.pk : null), []);
  const cols = [
    { key: 'label', label: fob ? '客户 / 订单' : dim === 'category' ? '种类 / 档位' : '档位 / 种类', w: 220, sortable: false, filterable: false, value: (r) => r.label,
      render: (r) => (r.lvl === 0
        ? <span className="dk-row0"><button type="button" className={`peek-eye dk-exp ${exp[r.pk] ? 'on' : ''}`} aria-label={exp[r.pk] ? '收起' : '展开'} onClick={(e) => { e.stopPropagation(); setExp((x) => ({ ...x, [r.pk]: !x[r.pk] })); }}>☰</button>{fob ? <CustLink id={r.ref.customer_id} name={r.label} /> : r.tier ? <TierPill tier={r.tier} /> : <b>{r.label}</b>}</span>
        : <span className="dk-row1">{fob ? (r.ref.fob_project_id ? <button type="button" className="linkbtn mono" onClick={(e) => { e.stopPropagation(); go('fob/' + r.ref.fob_project_id); }}>{r.label}</button> : <DealLink id={r.ref.deal_id} no={r.label} />) : r.tier ? <TierPill tier={r.tier} /> : r.label}</span>) },
    { key: 'share', label: '占比', w: 110, sortable: false, filterable: false, value: (r) => (t.rev ? r.t.rev / t.rev * 100 : 0),
      render: (r) => { const p = t.rev ? r.t.rev / t.rev * 100 : 0; return <span className={`dbar ${r.lvl ? 'sub' : ''}`} data-tip={`占销售额 ${p.toFixed(1)}%`}><i style={{ width: `${Math.max(0, Math.min(100, p))}%` }} /></span>; } },
    { key: 'rev', label: `销售额 ${C}`, w: 130, type: 'money', sortable: false, value: (r) => r.t.rev, render: (r) => (r.lvl ? money(r.t.rev, C) : <b>{money(r.t.rev, C)}</b>) },
    { key: 'qty', label: '销量 片', w: 90, type: 'number', sortable: false, value: (r) => r.t.qty, render: (r) => qty(r.t.qty) },
    { key: 'cost', label: `成本 ${C}`, w: 130, type: 'money', sortable: false, value: (r) => r.t.cost, render: (r) => <>{money(r.t.cost, C)}{r.t.miss > 0 && <span className="pill red" style={{ marginLeft: 4 }} title={`${qty(r.t.miss)} 片没成本，没算进成本和毛利`}>缺</span>}</> },
    { key: 'profit', label: `利润 ${C}`, w: 130, type: 'money', sortable: false, value: (r) => r.t.profit, render: (r) => <span className={r.t.profit < 0 ? 'red-t2' : ''}>{money(r.t.profit, C)}</span> },
    { key: 'pct', label: '毛利率', w: 90, type: 'number', sortable: false, value: (r) => r.t.pct, render: (r) => <Pct p={r.t.pct} low={lowPct} /> },
    { key: 'n', label: '单', w: 60, type: 'number', sortable: false, value: (r) => r.t.n, render: (r) => r.t.n },
  ];
  const miss = [...t.missModels.values()].sort((a, b) => b.qty - a.qty);
  return (
    <div className="card dash-sec">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>{fob ? 'FOB 销售与毛利' : '本地销售与毛利'}</h2>
        <span className="grow" />
        {!merge && groups.length > 0 && <div className="seg sm">{groups.map(([c, n]) => <button type="button" key={c} className={cur === c ? 'on' : ''} onClick={() => setCur(c)}>{c} · {n} 单</button>)}</div>}
        {merge && <span className="pill blue">{merge.rates ? `统一汇率 → ${C}（${Object.entries(merge.rates).map(([k, v]) => `1 ${k} = ${v}`).join('，')}）` : `按出库日汇率合并 → ${C}`}</span>}
        {(groups.length > 1 || merge) && <button type="button" className="btn sm" onClick={() => setDlg(true)}>合并币种{merge ? ' ✓' : ''}</button>}
      </div>
      {!rows.length ? <div className="card-b muted small">这个时间段还没有{fob ? ' FOB ' : '本地'}出库{fob && transit?.n > 0 && <button type="button" className="dchip" style={{ marginLeft: 10 }} onClick={() => go('fob')}>在途 <b>{transit.n}</b> 单 · 订金已收 <b>{transit.paid}</b> ›</button>}</div> : <div className="card-b">
        <div className="dk-row">
          <div className="dk"><div className="dk-t">销售额 <small>{C}</small></div><Amt v={t.rev} cur={C} /></div>
          <div className="dk"><div className="dk-t">成本 <small>{C}</small></div><Amt v={t.cost} cur={C} /></div>
          <div className="dk"><div className="dk-t">利润 <small>{C}</small></div><Amt v={t.profit} cur={C} tone={t.profit < 0 ? 'red-t2' : ''} /></div>
          <div className="dk"><div className="dk-t">毛利率</div><BigPct p={t.pct} low={lowPct} /></div>
        </div>
        <div className="dk-chips">
          <span className="dchip">出库 <b>{qty(t.qty)}</b> 片</span><span className="dchip"><b>{t.n}</b> 单</span><span className="dchip"><b>{t.c}</b> 位客户</span>
          {fob && transit?.n > 0 && <button type="button" className="dchip" onClick={() => go('fob')}>在途 <b>{transit.n}</b> 单 · 订金已收 <b>{transit.paid}</b> ›</button>}
          {t.miss > 0 && <button type="button" className="dchip red" onClick={() => setMissOpen(true)}>{qty(t.miss)} 片没成本 · {miss.length} 个型号，去补 ›</button>}
          <span className="grow" />
          {open && !fob && <div className="seg sm">{[['category', '按种类'], ['tier', '按档位']].map(([k, l]) => <button type="button" key={k} className={dim === k ? 'on' : ''} onClick={() => { setDim(k); setExp({}); }}>{l}</button>)}</div>}
          <Fold open={open} onClick={() => setOpen(!open)} />
        </div>
        {open && <div style={{ marginTop: 10 }}><Grid id={`dash-${kind}`} columns={cols} rows={table} noTools parentOf={parentOf} rowClass={(r) => (r.lvl ? 'dk-child' : '')}
          foot={() => ({ label: '合计', rev: money(t.rev, C), qty: qty(t.qty), cost: money(t.cost, C), profit: money(t.profit, C), pct: t.pct == null ? '—' : `${t.pct.toFixed(1)}%`, n: t.n })} /></div>}
      </div>}
      {dlg && <MergeDlg groups={groups} merge={merge} def={def} org={org} onClose={() => setDlg(false)} onSet={(x) => { setMerge(x); setDlg(false); }} />}
      {missOpen && <Modal title={`没成本的型号 · ${miss.length} 个`} onClose={() => setMissOpen(false)} footer={<><button type="button" className="btn" onClick={() => setMissOpen(false)}>关闭</button><button type="button" className="btn primary" onClick={() => go('pricing')}>去物料与定价补成本 ›</button></>}>
        <div className="small muted" style={{ marginBottom: 8 }}>这些型号出库时没有到岸成本，它们的销售额算了、成本和毛利没算。点型号打开档案，在「采购批次」里补上。</div>
        <Grid id="dash-miss" noTools maxHeight={360} rows={miss} columns={[
          { key: 'model', label: '型号', w: 160, render: (r) => <ModelLink id={r.id} name={r.model} /> }, { key: 'category', label: '种类', w: 110 },
          { key: 'code', label: '编码', w: 150 }, { key: 'qty', label: '这段时间出了 片', w: 130, type: 'number', render: (r) => qty(r.qty) }]} />
      </Modal>}
    </div>);
}

// 合并币种: ① 合并 (按出库那天的记账汇率) ② 统一汇率 (自己选折成哪种 + 手填) ③ 取消合并
function MergeDlg({ groups, merge, def, org, onClose, onSet }) {
  const [mode, setMode] = useState(merge ? (merge.rates ? 'manual' : 'locked') : 'locked');
  const [target, setTarget] = useState(merge?.target || def);
  const [rates, setRates] = useState(merge?.rates || {});
  const { data: ps } = useData(() => q(`select rmb_per_xof, xof_per_usd from app.price_settings where org_id = $1`, [org]), [org]);
  const src = [...new Set([...groups.map((g) => g[0]), 'XOF'])].filter((c) => c !== target);
  const hint = (c) => { const p = ps?.[0]; if (!p) return ''; const x = { XOF: 1, CNY: N(p.rmb_per_xof) ? 1 / N(p.rmb_per_xof) : 0, USD: N(p.xof_per_usd) }; return x[c] && x[target] ? Number((x[c] / x[target]).toPrecision(5)) : ''; };
  const ok = mode !== 'manual' || src.every((c) => N(rates[c]) > 0);
  return (
    <Modal title="合并币种" onClose={onClose} footer={<>
      {merge && <button type="button" className="btn" onClick={() => onSet(null)}>取消合并</button>}<span className="grow" />
      <button type="button" className="btn" onClick={onClose}>关闭</button>
      <button type="button" className="btn primary" disabled={!ok} onClick={() => onSet(mode === 'manual' ? { target, rates: Object.fromEntries(src.map((c) => [c, N(rates[c])])) } : { target })}>确认</button></>}>
      <div className="stack">
        <div className="field"><label>怎么合</label><Choice value={mode} onChange={setMode} options={[['locked', '按出库那天的汇率'], ['manual', '统一汇率（自己填）']]} /></div>
        <div className="field"><label>折成哪种币</label><Choice value={target} onChange={setTarget} options={CURS.map((c) => [c, c])} /></div>
        {mode === 'manual' && src.map((c) => (
          <div className="field req" key={c}><label>1 {c} = 多少 {target}{c === 'XOF' && !groups.some((g) => g[0] === 'XOF') ? '（成本是 XOF，要用它折）' : ''}</label>
            <MoneyIn className={`in ${N(rates[c]) > 0 ? '' : 'err-in'}`} inputMode="decimal" value={rates[c] ?? ''} placeholder={hint(c) ? `记账汇率约 ${hint(c)}` : ''} onChange={(e) => setRates((x) => ({ ...x, [c]: e.target.value.replace(/[^\d.]/g, '') }))} /></div>))}
        <div className="hint">只影响这一块怎么显示，不改任何单据和账。关掉页面就回到默认。</div>
      </div>
    </Modal>);
}

// ───────── 账款: 客户欠款 / 收款 / Roland 手里的钱 / 回款 ─────────
export function MoneyBlock({ bal, rc, from, to }) {
  const { go, role } = useApp();
  const fin = ['admin', 'finance'].includes(role);
  const held = usePublicHeld(); const remits = useRemits(); const rules = useRemitRules();
  const [open, setOpen] = useState(null);
  const [rcur, setRcur] = useLs('la9s.dash.rc.cur', 'XOF');
  const tog = (k) => setOpen((o) => (o === k ? null : k));
  const debt = bal.filter((b) => N(b.balance) > 0); const pre = bal.filter((b) => N(b.balance) < 0);
  const debtT = debt.reduce((s, b) => s + N(b.balance), 0);
  const oldest = Math.max(0, ...debt.map((b) => N(b.oldest_days)));
  const over = debt.filter((b) => b.credit_days != null && N(b.oldest_days) > N(b.credit_days));
  const live = rc.filter((r) => !r.voided_at);
  const rcBy = (c) => live.filter((r) => (r.account_currency || r.currency) === c);
  const rcCurs = CURS.filter((c) => c === 'XOF' || c === 'CNY' || rcBy(c).length);
  const rcL = rcBy(rcur); const amt = (r) => N(r.account_currency && r.account_currency !== r.currency ? r.converted : r.amount);
  const byAcc = Object.entries(rcL.reduce((a, r) => { const k = r.account_name || '没选账户'; a[k] = (a[k] || 0) + amt(r); return a; }, {})).sort((a, b) => b[1] - a[1]);
  const heldT = (held || []).reduce((s, a) => s + a.total, 0); const heldN = (held || []).reduce((s, a) => s + a.owing.length, 0);
  const heldOld = Math.max(0, ...(held || []).map((a) => a.oldest)); const heldLim = (held || []).reduce((s, a) => s + N(a.hold_limit), 0);
  const rem = (remits || []).filter((r) => r.status !== 'void'); const remP = rem.filter((r) => ymd(r.on_date) >= from && ymd(r.on_date) <= to);
  const remOut = remP.filter((r) => r.out_currency === 'XOF').reduce((s, r) => s + N(r.amount_out), 0);
  const remBack = CURS.map((c) => [c, remP.filter((r) => r.currency === c).reduce((s, r) => s + N(r.arrived), 0)]).filter((x) => x[1] > 0);
  const remFlag = rem.filter((r) => remitFlag(r, rules));
  const cards = [
    { id: 'debt', title: '客户欠款', span: 3, render: () => (
      <div className={`mcard ${open === 'debt' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => go('balances')}>客户欠款 ›</button></div>
        <Amt v={debtT} cur="XOF" tone={debtT > 0 ? 'red-t2' : ''} />
        <div className="dk-chips"><span className="dchip"><b>{debt.length}</b> 位客户</span>{oldest > 0 && <span className="dchip">最老 <b>{oldest}</b> 天</span>}{over.length > 0 && <span className="dchip red">超账期 <b>{over.length}</b> 位</span>}
          {pre.length > 0 && <span className="dchip">预付 <b>{money(-pre.reduce((s, b) => s + N(b.balance), 0))}</b> XOF</span>}<span className="grow" /><Fold open={open === 'debt'} onClick={() => tog('debt')} /></div>
      </div>) },
    { id: 'rc', title: '收款', span: 3, render: () => (
      <div className={`mcard ${open === 'rc' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => go('receipts')}>收款 ›</button><span className="tog2">{rcCurs.map((c) => <button type="button" key={c} className={rcur === c ? 'on' : ''} onClick={() => setRcur(c)}>{c}</button>)}</span></div>
        <Amt v={rcL.reduce((s, r) => s + amt(r), 0)} cur={rcur} />
        <div className="dk-chips"><span className="dchip"><b>{rcL.length}</b> 笔</span><span className="dchip"><b>{new Set(rcL.map((r) => r.customer_id)).size}</b> 位客户</span>
          {rcL.filter((r) => r.verify_status === 'pending').length > 0 && <span className="dchip amber">待核对 <b>{rcL.filter((r) => r.verify_status === 'pending').length}</b> 笔</span>}<span className="grow" /><Fold open={open === 'rc'} onClick={() => tog('rc')} /></div>
      </div>) },
    ...(fin ? [{ id: 'held', title: 'Roland 手里的钱', span: 3, render: () => (
      <div className={`mcard ${open === 'held' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => go('cash')}>{held?.length ? [...new Set(held.map((a) => a.holder))].join(' / ') : '公户'} 手里的钱 ›</button></div>
        <Amt v={heldT} cur="XOF" tone={heldT > 0 ? 'red-t2' : ''} />
        <div className="dk-chips"><span className="dchip"><b>{heldN}</b> 笔没交</span>{heldOld > 0 && <span className={`dchip ${(held || []).some((a) => a.late) ? 'red' : ''}`}>最老压 <b>{heldOld}</b> 天</span>}
          {heldLim > 0 && <span className={`dchip ${heldT > heldLim ? 'red' : ''}`}>上限 <b>{money(heldLim)}</b> XOF</span>}<span className="grow" /><Fold open={open === 'held'} onClick={() => tog('held')} /></div>
      </div>) },
    { id: 'remit', title: '回款', span: 3, render: () => (
      <div className={`mcard ${open === 'remit' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => { go('cash'); setTimeout(() => document.getElementById('remit')?.scrollIntoView({ block: 'start' }), 400); }}>回款 ›</button></div>
        <Amt v={remOut} cur="XOF" />
        <div className="dk-chips">{remBack.map(([c, v]) => <span className="dchip" key={c}>已到 <b>{money(v, c)}</b> {c}</span>)}<span className="dchip"><b>{remP.length}</b> 笔</span>
          {rem[0] && <span className="dchip">最近 <b>{dDate(rem[0].on_date).slice(5)}</b></span>}{remFlag.length > 0 && <span className="dchip red">{remFlag.length} 笔要看</span>}<span className="grow" /><Fold open={open === 'remit'} onClick={() => tog('remit')} /></div>
      </div>) }] : []),
  ];
  return (
    <div className="card dash-sec">
      <div className="card-h"><h2>账款 <Assumed>四张卡的顺序中方可以调（⚙ 配置看板），全员看到的一样。欠款 = 现在的数，不跟日期走；收款 / 回款跟上面的日期走。</Assumed></h2></div>
      <div className="card-b">
        <LayoutGrid page="dash.money" blocks={cards} defaultGap={12} sub="账款" />
        {open === 'debt' && <div className="mc-detail"><Grid id="dash-debt" noTools maxHeight={340} rows={debt} empty="没有客户欠款 ✓" columns={[
          { key: 'name', label: '客户', w: 200, render: (b) => <CustLink id={b.id} name={b.name} /> }, { key: 'owner', label: '销售员', w: 90 },
          { key: 'balance', label: '欠款 XOF', w: 130, type: 'money', value: (b) => N(b.balance), render: (b) => <b className="red-t2">{money(b.balance)}</b> },
          { key: 'oldest_days', label: '最老 天', w: 90, type: 'number', value: (b) => N(b.oldest_days), render: (b) => <span className={b.credit_days != null && N(b.oldest_days) > N(b.credit_days) ? 'pill red' : ''}>{N(b.oldest_days) || ''}</span> },
          { key: 'credit_days', label: '账期 天', w: 80, type: 'number' }, { key: 'last_shipped', label: '最近出库', w: 100, render: (b) => dDate(b.last_shipped) }]} /></div>}
        {open === 'rc' && <div className="mc-detail">
          {byAcc.length > 0 && <div className="acc-bars">{byAcc.map(([n, v]) => <div key={n}><span>{n}</span><span className="dbar"><i style={{ width: `${v / byAcc[0][1] * 100}%` }} /></span><b>{money(v, rcur)} {rcur}</b></div>)}</div>}
          <Grid id="dash-rc" noTools maxHeight={300} rows={rcL} empty={`这段时间没有 ${rcur} 收款`} columns={[
            { key: 'received_on', label: '日期', w: 100, render: (r) => dDate(r.received_on) }, { key: 'customer_name', label: '客户', w: 190, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
            { key: 'amount', label: `金额 ${rcur}`, w: 130, type: 'money', value: amt, render: (r) => <b>{money(amt(r), rcur)}</b> }, { key: 'account_name', label: '账户', w: 130 },
            { key: 'verify_status', label: '核对', w: 90, value: (r) => (r.verify_status === 'pending' ? '待核对' : '已核对'), render: (r) => (r.verify_status === 'pending' ? <span className="pill amber">待核对</span> : <span className="pill green">已核对</span>) },
            { key: 'rcv_no', label: '收款单号', w: 140 }]} /></div>}
        {open === 'held' && <div className="mc-detail"><Grid id="dash-held" noTools maxHeight={340} rows={(held || []).flatMap((a) => a.owing.map((r) => ({ ...r, acc: a.name, holder: a.holder })))} empty="公户里没有没交的钱 ✓" columns={[
          { key: 'on_date', label: '收到日期', w: 100, render: (r) => dDate(r.on_date) }, { key: 'acc', label: '账户', w: 160 }, { key: 'customer', label: '客户', w: 180, value: (r) => r.customer || r.payer || '' },
          { key: 'amount', label: '收了 XOF', w: 120, type: 'money', value: (r) => N(r.amount), render: (r) => money(r.amount) }, { key: 'paid', label: '已交 XOF', w: 120, type: 'money', render: (r) => money(r.paid) },
          { key: 'left', label: '还欠 XOF', w: 120, type: 'money', render: (r) => <b className="red-t2">{money(r.left)}</b> },
          { key: 'd', label: '压了 天', w: 80, type: 'number', value: (r) => Math.floor((Date.now() - new Date(r.on_date).getTime()) / 864e5) }]} /></div>}
        {open === 'remit' && <div className="mc-detail"><Grid id="dash-remit" noTools maxHeight={340} rows={remP} empty="这段时间没有回款记录" columns={remitCols(rules)} /></div>}
      </div>
    </div>);
}

// ───────── 打卡情况 / 客户拜访 / 热线电话 ─────────
export function PeopleBlock({ from, to, label }) {
  const { org, role, go, tick } = useApp();
  const td = today();
  const { data } = useData(async () => {
    const lead = ['admin', 'manager', 'sales_manager', 'finance'].includes(role);
    const [emps, ins, visits, calls, an] = await Promise.all([
      q(`select id, coalesce(short_name, full_name) as short_name, work_schedule from app.employees where org_id = $1 and active and coalesce(emp_no, '') <> '' and (joined_on is null or joined_on <= current_date)`, [org]),
      q(`select distinct employee_id from app.attendance where org_id = $1 and kind = 'in' and (at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date`, [org]),
      q(`select (v.at at time zone 'Africa/Abidjan')::date as day, v.customer_id, v.employee_id, coalesce(e.short_name, e.full_name, '没填') as emp, coalesce(c.city, '') as city
         from app.visits v join app.customers c on c.id = v.customer_id left join app.employees e on e.id = v.employee_id
         where v.org_id = $1 and v.at >= least($2::date, current_date - 1) and v.at < greatest($3::date, current_date) + 2`, [org, from, to]),
      q(`select (h.at at time zone 'Africa/Abidjan')::date as day, h.result, h.staff_employee_id as employee_id, coalesce(e.short_name, e.full_name, '没填') as emp
         from app.hotline_calls h left join app.employees e on e.id = h.staff_employee_id
         where h.org_id = $1 and h.channel = 'call' and h.at >= least($2::date, current_date - 1) and h.at < greatest($3::date, current_date) + 2`, [org, from, to]),
      lead ? call(role, `select * from app.attendance_anomalies($1,$2,$3)`, [org, from, to]).catch(() => []) : []]);
    return { emps, ins: new Set(ins.map((x) => x.employee_id)), visits: visits.map((v) => ({ ...v, day: ymd(v.day) })), calls: calls.map((v) => ({ ...v, day: ymd(v.day) })), an, lead };
  }, [org, role, from, to, tick]);
  const [open, setOpen] = useState(null);
  const [vd, setVd] = useState('t'); const [hd, setHd] = useState('t');
  if (!data) return null;
  const yd = ymd(new Date(new Date(td + 'T00:00:00Z').getTime() - 864e5));
  const wd = new Date().getDay();
  const due = data.emps.filter((e) => ((e.work_schedule || {})[wd] ?? (wd === 0 ? 'off' : 'full')) !== 'off');
  const missing = due.filter((e) => !data.ins.has(e.id));
  const anN = (a) => N(a.late) + N(a.missing) + N(a.early);
  const bad = data.an.filter((a) => anN(a) >= 3).sort((a, b) => anN(b) - anN(a));
  const vOf = (d) => data.visits.filter((v) => v.day === d); const custN = (l) => new Set(l.map((v) => v.customer_id)).size;
  const vP = data.visits.filter((v) => v.day >= from && v.day <= to);
  const vSel = vOf(vd === 't' ? td : yd);
  const vBy = Object.values(vSel.reduce((a, v) => { const k = v.emp + '|' + v.city; (a[k] = a[k] || { id: k, emp: v.emp, employee_id: v.employee_id, city: v.city, s: new Set() }).s.add(v.customer_id); return a; }, {})).map((x) => ({ ...x, n: x.s.size })).sort((a, b) => b.n - a.n);
  const okR = (c) => !['no_answer', 'busy'].includes(c.result);
  const cOf = (d) => data.calls.filter((c) => c.day === d); const cP = data.calls.filter((c) => c.day >= from && c.day <= to);
  const cSel = cOf(hd === 't' ? td : yd);
  const cBy = Object.values(cSel.reduce((a, c) => { (a[c.emp] = a[c.emp] || { id: c.emp, emp: c.emp, employee_id: c.employee_id, ok: 0, fail: 0 })[okR(c) ? 'ok' : 'fail'] += 1; return a; }, {})).sort((a, b) => b.ok + b.fail - a.ok - a.fail);
  const tog = (k) => setOpen((o) => (o === k ? null : k));
  const Two = ({ sel, set, a, b, unit }) => <div className="two-n">{[['t', '今天', a], ['y', '昨天', b]].map(([k, l, n]) => <button type="button" key={k} className={sel === k ? 'on' : ''} onClick={() => set(k)}><small>{l}</small><b>{n}</b><small>{unit}</small></button>)}</div>;
  const cards = [
    { id: 'att', title: '打卡情况', span: 4, render: () => (
      <div className={`mcard ${open === 'att' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => go('attendance')}>打卡情况 ›</button></div>
        {!due.length ? <span className="dk-v muted">今天休息</span> : <span className="dk-v">{due.length - missing.length}<small>人已打卡</small></span>}
        <div className="dk-chips">{due.length > 0 && <span className={`dchip ${missing.length ? 'red' : ''}`}>没打卡 <b>{missing.length}</b> 人</span>}<span className="dchip">总计 <b>{due.length}</b> 人</span>
          {bad.length > 0 && <span className="dchip red">{label}异常 ≥ 3 次 <b>{bad.length}</b> 人</span>}<span className="grow" /><Fold open={open === 'att'} onClick={() => tog('att')} /></div>
      </div>) },
    { id: 'visit', title: '客户拜访', span: 4, render: () => (
      <div className={`mcard ${open === 'visit' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => go('visits')}>客户拜访 ›</button><button type="button" className="mc-sum" onClick={() => go('visits')}>{label}合计 {custN(vP)} 家 ›</button></div>
        <Two sel={vd} set={setVd} a={custN(vOf(td))} b={custN(vOf(yd))} unit="家" />
        <div className="dk-chips"><span className="dchip"><b>{new Set(vSel.map((v) => v.emp)).size}</b> 位销售员</span><span className="dchip"><b>{new Set(vSel.map((v) => v.city).filter(Boolean)).size}</b> 个城市</span><span className="grow" /><Fold open={open === 'visit'} onClick={() => tog('visit')} /></div>
      </div>) },
    { id: 'hot', title: '热线电话', span: 4, render: () => (
      <div className={`mcard ${open === 'hot' ? 'on' : ''}`}>
        <div className="mc-t"><button type="button" onClick={() => go('hotline')}>热线电话 ›</button><button type="button" className="mc-sum" onClick={() => go('hotline')}>{label}合计 {cP.length} 个 · 拨通 {cP.filter(okR).length} ›</button></div>
        <Two sel={hd} set={setHd} a={cOf(td).length} b={cOf(yd).length} unit="个" />
        <div className="dk-chips"><span className="dchip green">拨通 <b>{cSel.filter(okR).length}</b></span><span className={`dchip ${cSel.some((c) => !okR(c)) ? 'red' : ''}`}>没拨通 <b>{cSel.filter((c) => !okR(c)).length}</b></span><span className="grow" /><Fold open={open === 'hot'} onClick={() => tog('hot')} /></div>
      </div>) },
  ];
  return (
    <div className="card dash-sec">
      <div className="card-h"><h2>人员 <Info>打卡只看今天；异常次数、合计跟上面的日期走。</Info></h2></div>
      <div className="card-b">
        <LayoutGrid page="dash.people" blocks={cards} defaultGap={12} sub="打卡 / 拜访 / 热线" />
        {open === 'att' && <div className="mc-detail">
          <div className="dk-chips" style={{ marginBottom: 8 }}><span className="small muted">今天没打卡：</span>{missing.length ? missing.map((e) => <EmpLink key={e.id} id={e.id} name={e.short_name}><span className="dchip red">{e.short_name}</span></EmpLink>) : <span className="dchip green">都到了</span>}</div>
          {data.lead && <Grid id="dash-att" noTools maxHeight={300} rows={bad.map((a) => ({ ...a, id: a.employee_id, n: anN(a) }))} empty={`${label}没有人异常满 3 次 ✓`} columns={[
            { key: 'emp_no', label: '工号', w: 80 }, { key: 'short_name', label: '员工', w: 160, render: (a) => <EmpLink id={a.employee_id} name={a.short_name} /> },
            { key: 'late', label: '迟到 次', w: 90, type: 'number' }, { key: 'missing', label: '没打卡 次', w: 100, type: 'number' }, { key: 'early', label: '早退 次', w: 90, type: 'number' },
            { key: 'n', label: '合计 次', w: 90, type: 'number', render: (a) => <span className="pill red">{a.n}</span> }]} />}
        </div>}
        {open === 'visit' && <div className="mc-detail"><Grid id="dash-visit" noTools maxHeight={300} rows={vBy} empty={`${vd === 't' ? '今天' : '昨天'}还没有拜访记录`} columns={[
          { key: 'emp', label: '销售员', w: 160, render: (r) => (r.employee_id ? <EmpLink id={r.employee_id} name={r.emp} /> : r.emp) }, { key: 'city', label: '城市', w: 140 }, { key: 'n', label: '客户数 家', w: 110, type: 'number' }]} /></div>}
        {open === 'hot' && <div className="mc-detail"><Grid id="dash-hot" noTools maxHeight={300} rows={cBy} empty={`${hd === 't' ? '今天' : '昨天'}还没有电话记录`} columns={[
          { key: 'emp', label: '热线', w: 160, render: (r) => (r.employee_id ? <EmpLink id={r.employee_id} name={r.emp} /> : r.emp) },
          { key: 'ok', label: '拨通 个', w: 100, type: 'number', render: (r) => <span className="pill green">{r.ok}</span> }, { key: 'fail', label: '没拨通 个', w: 100, type: 'number', render: (r) => (r.fail ? <span className="pill red">{r.fail}</span> : 0) },
          { key: 't', label: '合计 个', w: 90, type: 'number', value: (r) => r.ok + r.fail }]} /></div>}
      </div>
    </div>);
}
