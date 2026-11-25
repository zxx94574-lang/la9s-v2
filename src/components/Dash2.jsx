// 经营总览改版 (待改 487–506, Frank 11-23「定为我的总方向」):
//   每段 = 一张总卡片 (一个最大的主数 + 三个次数) + 下面两张小卡左右各半; 数字默认黑, 颜色只给有问题的; 比率用红黄绿色块;
//   币种 + 「全数」只在总卡片右上角, 下面的小卡跟着变; ☰ 一律右下角, 同一排共用一个明细位 (开一个关另一个), 明细铺满整行;
//   简洁只改卡片层, 明细一样不少 (Grid: 拖列宽 / 排序 / 隐藏列照旧).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Modal, TierPill } from './ui.jsx';
import { CustLink, EmpLink, DealLink, ModelLink } from './Archives.jsx';
import { useMarginRules } from './Margin.jsx';
import { usePublicHeld } from './PublicHeld.jsx';
import { useRemits, useRemitRules, remitFlag, remitCols } from './Remit.jsx';
import { RuleGear, useRuleValues, ruleNum, useBudget } from './Rules.jsx';
import Grid from './Grid.jsx';
import { Fold, total, pctTone, Pct } from './DashBlocks.jsx';
import { money, qty, dDate, today } from '../lib/format.js';
import { Spark, weekly } from './MonthReport.jsx';
import { TIERS } from '../lib/domain.js';

const N = (v) => Number(v || 0);
const ymd = (v) => { if (!v) return ''; const x = v instanceof Date ? v : new Date(v); return isNaN(x) ? String(v).slice(0, 10) : x.toISOString().slice(0, 10); };
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
const useLs = (k, d) => { const [v, setV] = useState(() => ls.get(k, d)); return [v, (x) => { setV(x); ls.set(k, x); }]; };
const CURS = ['XOF', 'CNY', 'USD'];
const DASH_RULES = ['dash.budget', 'dash.age1', 'dash.age2', 'dash.cover_lo', 'dash.cover_hi', 'dash.ar_days', 'dash.ar_red', 'dash.rr_lo', 'dash.rr_hi', 'dash.silent', 'dash.visit', 'dash.pick'];
const shiftD = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const shiftM = (d, n) => { const x = new Date(d + 'T00:00:00Z'); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);

// 数字: 全数 = 千分位; 简写 = ≥ 100 万写 M (两位小数), ≥ 1 万写 K (一位小数)
export function fmtN(v, cur, short) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  v = Number(v); if (Math.abs(v) < 0.005) v = 0;
  if (!short) return money(v, cur);
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return Math.round(v).toLocaleString('en-US');
}
// 每段自己的币种 + 全数开关 (记住上次选的)
function useSec(key, defCur) {
  const [st, set] = useLs(`la9s.d2.${key}`, { cur: defCur, short: true });
  return { cur: st.cur, short: st.short, setCur: (c) => set({ ...st, cur: c }), flip: () => set({ ...st, short: !st.short }), f: (v) => fmtN(v, st.cur, st.short) };
}
// 现在的记账汇率 (库存 / 账款这种「现在的数」用它换币种)
function useRates() {
  const { org, tick } = useApp();
  const { data } = useData(() => q(`select rmb_per_xof, xof_per_usd from app.price_settings where org_id = $1`, [org]), [org, tick]);
  const p = data?.[0];
  return useCallback((xof, cur) => (cur === 'XOF' ? xof : cur === 'CNY' ? xof * N(p?.rmb_per_xof) : N(p?.xof_per_usd) ? xof / N(p.xof_per_usd) : 0), [p]);
}
const toXof = (amt, cur, p) => (cur === 'XOF' ? amt : cur === 'CNY' ? (N(p?.rmb_per_xof) ? amt / N(p.rmb_per_xof) : 0) : amt * N(p?.xof_per_usd));

const Tog = ({ s }) => (
  <span className="d2-tog">{CURS.map((c) => <button type="button" key={c} className={s.cur === c ? 'on' : ''} onClick={() => s.setCur(c)}>{c}</button>)}
    <i /><button type="button" className={s.short ? '' : 'on'} onClick={s.flip} data-tip={s.short ? '现在是简写（M / K），点一下看完整数字' : '现在是完整数字，点一下回到简写'}>全数</button></span>);

// 一格: 标题 (悬停看算法) + 数 + 下面一行小字
function Cell({ label, tip, main, cur, unit, tone, block, sub, onClick, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {      // 全数时数字太长就自动缩小, 不许出格
    const v = ref.current; if (!v) return; const b = v.querySelector('b'); if (!b) return;
    const fit = () => { b.style.fontSize = ''; let fs = parseFloat(getComputedStyle(b).fontSize); const o = [...v.children].filter((x) => x !== b).reduce((a, x) => a + x.offsetWidth + 6, 0); while (b.scrollWidth > v.clientWidth - o && fs > 12) { fs -= 1; b.style.fontSize = `${fs}px`; } };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  });
  const C = onClick ? 'button' : 'div';
  return (
    <C type={onClick ? 'button' : undefined} className={`d2-m ${main ? 'main' : ''}`} onClick={onClick}>
      <span className="k" data-tip={tip || undefined}>{label}</span>
      <span className="v" ref={ref}><b className={block ? `blk ${block}` : tone || ''}>{children}</b>{unit && <small>{unit}</small>}{cur && <u>{cur}</u>}</span>
      <span className="d">{sub}</span>
    </C>);
}
// to = [页面, 名字]：看板 ↔ 清单联动（11-25 Frank）—— 标题旁「订单总览 →」直接到那一页（那一页顶上同一套总数）
function DCard({ title, sub, tog, gear, children, foot, open, onFold, small, to }) {
  const { go } = useApp();
  return (
    <div className={`d2-card ${small ? 'sub' : ''}`}>
      <div className="d2-h"><span className="t">{title}</span>{sub && <span className="s">{sub}</span>}{gear}{to && <button type="button" className="d2-to" onClick={() => go(to[0])}>{to[1]} →</button>}{tog}</div>
      {children}
      <div className="d2-foot"><div className="f">{foot}</div>{onFold && <Fold open={open} onClick={onFold} />}</div>
    </div>);
}
// 比较: 数字下一行红绿小字 (和前 3 期平均比; 悬停看差多少)
function Cmp({ now, base, goodUp = true, f, what = '比前 3 期平均' }) {
  if (base == null || !Number.isFinite(base) || base === 0) return null;
  const d = now - base, p = d / Math.abs(base) * 100, up = d >= 0, good = goodUp ? up : !up;
  return <span className={`d2-dl ${good ? 'up' : 'dn'}`} data-tip={`${what}：${up ? '+' : '−'}${f ? f(Math.abs(d)) : Math.abs(d)}`}>{up ? '▲' : '▼'} {Math.abs(p).toFixed(1)}%</span>;
}
const Seg = ({ value, onChange, options }) => <span className="d2-seg">{options.map(([k, l]) => <button type="button" key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</span>;
const Detail = ({ title, right, children }) => <div className="d2-detail"><div className="d2-dh"><b>{title}</b>{right}</div>{children}</div>;
const Share = ({ p, sub }) => <span className="d2-share"><span className={`dbar ${sub ? 'sub' : ''}`}><i style={{ width: `${Math.max(0, Math.min(100, p))}%` }} /></span><small>{p.toFixed(0)}%</small></span>;
// 同一排共用一个明细位
const useSlot = (key) => { const [o, set] = useLs(`la9s.d2.open.${key}`, null); return [o, (id) => set(o === id ? null : id)]; };

// ───────────────────────── 销售 ─────────────────────────
// 前 3 期: 一个月以内的范围按月往回挪 (11-01 → 11-23 比 10 / 9 / 8 月的 1–23 号), 更长的按同样天数往回挪
function baseWindows(from, to) {
  const len = daysBetween(from, to) + 1;
  if (len <= 1) return [1, 2, 3].map((i) => [shiftD(from, -i), shiftD(to, -i)]);
  if (len <= 7) return [1, 2, 3].map((i) => [shiftD(from, -7 * i), shiftD(to, -7 * i)]);
  if (len <= 31) return [1, 2, 3].map((i) => [shiftM(from, -i), shiftM(to, -i)]);
  return [1, 2, 3].map((i) => [shiftD(from, -len * i), shiftD(to, -len * i)]);
}
function treeRows(list, levels, exp, m) {
  const out = [];
  const walk = (rows, lvl, path, top) => {
    const lv = levels[lvl]; const by = new Map();
    for (const r of rows) { const k = String(lv.key(r)); if (!by.has(k)) by.set(k, { k, rows: [], ref: r }); by.get(k).rows.push(r); }
    for (const g of [...by.values()].map((x) => ({ ...x, t: total(x.rows, m) })).sort((a, b) => b.t.rev - a.t.rev)) {
      const id = `${path}/${g.k}`;
      // parent = 最上面那一层的行 (Grid 的父子行只认一层, 孙子行也挂在顶层下面, 顺序按这里排好的)
      out.push({ id, parent: lvl ? top : null, lvl, kind: lv.kind, k: g.k, ref: g.ref, t: g.t, last: lvl === levels.length - 1 });
      if (exp[id] && lvl < levels.length - 1) walk(g.rows, lvl + 1, id, lvl ? top : id);
    }
  };
  walk(list, 0, '', null);
  return out;
}
const LV = {
  category: { kind: 'category', key: (r) => r.category || '（没种类）' },
  tier: { kind: 'tier', key: (r) => r.tier || '-' },
  model: { kind: 'model', key: (r) => r.product_id || r.model || '-' },
  customer: { kind: 'customer', key: (r) => r.customer_id },
  order: { kind: 'order', key: (r) => r.deal_id || r.fob_project_id },
};

export function SalesSec({ all, from, to, transit, onAlert }) {
  const { org, go, tick } = useApp(); const { lowPct } = useMarginRules();
  const s = useSec('sale', 'CNY'); const m = useMemo(() => ({ target: s.cur }), [s.cur]);
  const rv = useRuleValues(DASH_RULES);
  const [o0, tg0] = useSlot('s0'); const [o1, tg1] = useSlot('s1');
  const [ovTab, setOvTab] = useLs('la9s.d2.sale.ovtab', 'biz');
  const [dim, setDim] = useLs('la9s.d2.sale.dim', 'category');
  const [exp, setExp] = useState({});
  const [missOpen, setMissOpen] = useState(false);
  const inR = (r, a, b) => { const d = ymd(r.shipped_on); return d >= a && d <= b; };
  const rows = useMemo(() => all.filter((r) => inR(r, from, to)), [all, from, to]);
  const isFob = (r) => r.supply === 'fob';
  const T = useMemo(() => ({ all: total(rows, m), loc: total(rows.filter((r) => !isFob(r)), m), fob: total(rows.filter(isFob), m) }), [rows, m]);
  const base = useMemo(() => {
    const ws = baseWindows(from, to).map(([a, b]) => all.filter((r) => inR(r, a, b)));
    const avg = (pick) => (kind) => { const xs = ws.map((w) => pick(total(kind === 'all' ? w : w.filter((r) => (kind === 'fob') === isFob(r)), m))); return xs.some((x) => x) ? xs.reduce((a, b) => a + b, 0) / 3 : null; };
    return { rev: avg((t) => t.rev), qty: avg((t) => t.qty), profit: avg((t) => t.profit) };
  }, [all, from, to, m]);
  // 日常开支 (506): 不进毛利, 另算净利. 订单运费 (本地物流费 · 运费 xxx) 已经在毛利里扣过, 这里不重复算
  const { data: exps } = useData(() => q(`select coalesce(m.category, '没选科目') as category, a.currency, sum(m.amount) as amount, count(*) as n
    from app.cash_moves m join app.cash_accounts a on a.id = m.account_id
    where m.org_id = $1 and m.kind = 'expense' and m.status in ('approved', 'confirmed') and m.on_date >= $2::date and m.on_date <= $3::date
      and not (coalesce(m.category, '') = '本地物流费' and coalesce(m.note, '') like '运费 %')
      and m.receipt_id is null and coalesce(m.category, '') not like '%退款%'
    group by 1, 2`, [org, from, to]).catch(() => []), [org, from, to, tick]);
  // 工资 (公司成本 = 实发 + 社保): 这段时间里的那几个月的工资表 (草稿也算, 没建工资表的月份就没有)
  const { data: pay } = useData(() => q(`select coalesce(sum(coalesce(p.net, 0) + coalesce(p.cnps, 0)), 0) as v, count(*) as n, count(distinct p.month) as months
    from app.payroll p where p.org_id = $1 and p.month >= date_trunc('month', $2::date)::date and p.month <= $3::date`, [org, from, to]).catch(() => []), [org, from, to, tick]);
  const { data: psd } = useData(() => q(`select rmb_per_xof, xof_per_usd from app.price_settings where org_id = $1`, [org]), [org, tick]);
  const ps = psd?.[0];
  const conv = (xof) => (s.cur === 'XOF' ? xof : s.cur === 'CNY' ? xof * N(ps?.rmb_per_xof) : N(ps?.xof_per_usd) ? xof / N(ps.xof_per_usd) : 0);
  const expRows = useMemo(() => { const by = {}; for (const e of exps || []) { const x = by[e.category] || (by[e.category] = { id: e.category, name: e.category, v: 0, n: 0 }); x.v += conv(toXof(N(e.amount), e.currency, ps)); x.n += N(e.n); } return Object.values(by).sort((a, b) => b.v - a.v); }, [exps, ps, s.cur]);   // eslint-disable-line react-hooks/exhaustive-deps
  const payV = conv(N(pay?.[0]?.v)); const hasPay = N(pay?.[0]?.n) > 0;
  // 有工资表就用工资表, 资金账户里记的「工资」支出不重复算
  const expShown = hasPay ? [{ id: '__pay', name: `工资（工资表 ${N(pay[0].months)} 个月，公司成本）`, v: payV, n: N(pay[0].n) }, ...expRows.filter((e) => !/工资|薪|salaire|CNPS|社保/i.test(e.name))] : expRows;
  const expT = expShown.reduce((a, e) => a + e.v, 0);
  const { budget } = useBudget(from.slice(0, 7)); const inMonth = from.slice(8) === '01' && from.slice(0, 7) === to.slice(0, 7);
  const revCny = useMemo(() => (budget > 0 && inMonth ? total(rows, { target: 'CNY' }).rev : 0), [rows, budget, inMonth]);
  const miss = [...T.all.missModels.values()].sort((a, b) => b.qty - a.qty);
  useEffect(() => { onAlert?.('sale', T.all.profit < 0 ? [{ tone: 'red', text: `这段时间整体亏钱 ${s.f(-T.all.profit)} ${s.cur}`, go: 'margin' }] : []); }, [T.all.profit, s.cur, s.short]);   // eslint-disable-line react-hooks/exhaustive-deps

  const cells = (t, kind, main) => (<>
    <Cell label="销售额" main={main} cur={main ? s.cur : null} onClick={() => go('margin')} sub={<Cmp now={t.rev} base={base.rev(kind)} f={s.f} />}>{s.f(t.rev)}</Cell>
    <Cell label="销量" unit="片" onClick={() => go('margin')} sub={main && <Cmp now={t.qty} base={base.qty(kind)} f={qty} />}>{qty(t.qty)}</Cell>
    <Cell label="利润" tone={t.profit < 0 ? 'num-red' : ''} tip="利润 = 销售额 − 货的到岸成本（退货、我们出的运费和手续费已经扣掉）。日常开支不在里面，看 ☰ 明细的「利润表」。" onClick={() => go('margin')} sub={main && <Cmp now={t.profit} base={base.profit(kind)} f={s.f} />}>{s.f(t.profit)}</Cell>
    <Cell label="毛利率" block={pctTone(t.pct, lowPct)} tip={`毛利率 = 利润 ÷ 销售额。负数红，低于 ${lowPct}% 黄，其余绿。`} onClick={() => go('margin')}>{t.pct == null ? '—' : `${t.pct.toFixed(1)}%`}</Cell></>);

  // 明细: 本地 种类 → 档位 → 型号 (或 档位 → 种类 → 型号); FOB 客户 → 订单 → 型号
  const kind1 = o1 === 'fob' ? 'fob' : 'local';
  const levels = kind1 === 'fob' ? [LV.customer, LV.order, LV.model] : dim === 'category' ? [LV.category, LV.tier, LV.model] : [LV.tier, LV.category, LV.model];
  const list1 = useMemo(() => rows.filter((r) => (kind1 === 'fob') === isFob(r)), [rows, kind1]);
  const t1 = kind1 === 'fob' ? T.fob : T.loc;
  const table = useMemo(() => (o1 ? treeRows(list1, levels, exp, m) : []), [o1, list1, exp, dim, m]);   // eslint-disable-line react-hooks/exhaustive-deps
  const parentOf = useCallback((r) => r.parent, []);
  const nameOf = (r) => {
    const x = r.ref;
    if (r.kind === 'tier') return r.k === '-' ? '没定档' : <TierPill tier={r.k} />;
    if (r.kind === 'model') { const nm = x.model || x.product_code || x.category || '（没型号）'; return x.product_id ? <ModelLink id={x.product_id} model={nm} /> : nm; }
    if (r.kind === 'customer') return <CustLink id={x.customer_id} name={x.customer_name} />;
    if (r.kind === 'order') return x.fob_project_id ? <button type="button" className="linkbtn mono" onClick={(e) => { e.stopPropagation(); go('fob/' + x.fob_project_id); }}>{x.biz_no}</button> : <DealLink id={x.deal_id} no={x.biz_no} />;
    return r.lvl ? r.k : <b>{r.k}</b>;
  };
  const C = s.cur;
  const cols = [
    { key: 'label', label: kind1 === 'fob' ? '客户 / 订单 / 型号' : dim === 'category' ? '种类 / 档位 / 型号' : '档位 / 种类 / 型号', w: 240, sortable: false, filterable: false, value: (r) => r.k,
      render: (r) => <span className={`d2-tree l${r.lvl}`}>{!r.last ? <button type="button" className={`peek-eye dk-exp ${exp[r.id] ? 'on' : ''}`} aria-label={exp[r.id] ? '收起' : '展开'} onClick={(e) => { e.stopPropagation(); setExp((x) => ({ ...x, [r.id]: !x[r.id] })); }}>☰</button> : <i className="d2-nob" />}{nameOf(r)}</span> },
    { key: 'share', label: '占比', w: 130, sortable: false, filterable: false, value: (r) => (t1.rev ? r.t.rev / t1.rev * 100 : 0), render: (r) => <Share p={t1.rev ? r.t.rev / t1.rev * 100 : 0} sub={r.lvl > 0} /> },
    { key: 'rev', label: `销售额 ${C}`, w: 130, type: 'money', sortable: false, value: (r) => r.t.rev, render: (r) => (r.lvl ? s.f(r.t.rev) : <b>{s.f(r.t.rev)}</b>) },
    { key: 'qty', label: '销量 片', w: 90, type: 'number', sortable: false, value: (r) => r.t.qty, render: (r) => qty(r.t.qty) },
    { key: 'cost', label: `成本 ${C}`, w: 130, type: 'money', sortable: false, value: (r) => r.t.cost, render: (r) => <>{s.f(r.t.cost)}{r.t.miss > 0 && <span className="pill red" style={{ marginLeft: 4 }} title={`${qty(r.t.miss)} 片没成本，没算进成本和毛利`}>缺</span>}</> },
    { key: 'profit', label: `利润 ${C}`, w: 130, type: 'money', sortable: false, value: (r) => r.t.profit, render: (r) => <span className={r.t.profit < 0 ? 'red-t2' : ''}>{s.f(r.t.profit)}</span> },
    { key: 'pct', label: '毛利率', w: 90, type: 'number', sortable: false, value: (r) => r.t.pct, render: (r) => <Pct p={r.t.pct} low={lowPct} /> },
    { key: 'n', label: '单', w: 60, type: 'number', sortable: false, value: (r) => r.t.n, render: (r) => r.t.n },
  ];
  const biz = [['本地备货', T.loc, 'var(--brand)'], ['FOB', T.fob, '#8DB4EE']].map(([name, t, color]) => ({ id: name, name, color, t }));
  const pl = [
    { id: 'rev', name: '销售额', v: T.all.rev, b: 1 }, { id: 'cost', name: '− 货的成本', v: -T.all.cost },
    { id: 'gp', name: '= 毛利', v: T.all.profit, b: 1, pct: T.all.pct },
    ...expShown.map((e) => ({ id: 'e:' + e.id, name: `− ${e.name}`, v: -e.v, n: e.n, sub: 1 })),
    { id: 'exp', name: '− 日常开支合计', v: -expT },
    { id: 'net', name: '= 净利', v: T.all.profit - expT, b: 1, pct: T.all.known ? (T.all.profit - expT) / T.all.known * 100 : null },
  ];
  return (
    <div className="d2-sec">
      <DCard title="销售" sub="销售额与毛利 · 只算已经出库的" to={['orders', '订单总览']} tog={<Tog s={s} />} gear={<RuleGear ids={['dash.budget', 'margin.low']} title="销售看板的规则" />} open={o0 === 'ov'} onFold={() => tg0('ov')}
        foot={<>{budget > 0 && inMonth && <span className="d2-goal" data-tip={`本月预算 ${money(budget, 'CNY')} CNY，已完成 ${money(revCny, 'CNY')} CNY`}><i><em style={{ width: `${Math.min(100, revCny / budget * 100)}%` }} /></i>预算 {Math.round(revCny / budget * 100)}%</span>}
          <span>{T.all.n} 单 · {T.all.c} 位客户</span>
          {T.all.miss > 0 && <button type="button" className="d2-warn" onClick={() => setMissOpen(true)} data-tip="这些货出库时没有到岸成本，销售额算了，成本和毛利没算">{qty(T.all.miss)} 片没成本</button>}</>}>
        {!rows.length ? <div className="muted small" style={{ padding: '8px 0' }}>这个时间段还没有出库</div> : <div className="d2-hero">{cells(T.all, 'all', true)}</div>}
      </DCard>
      {o0 === 'ov' && <Detail title={ovTab === 'biz' ? '按业务' : '利润表'} right={<Seg value={ovTab} onChange={setOvTab} options={[['biz', '按业务'], ['pl', '利润表']]} />}>
        {ovTab === 'biz' ? <Grid id="d2-ov" noTools rows={biz} columns={[
          { key: 'name', label: '业务', w: 120, sortable: false, filterable: false, render: (r) => <span className="dk-row0"><i className="dk-dot" style={{ background: r.color }} /><b>{r.name}</b></span> },
          { key: 'share', label: '占比', w: 140, sortable: false, filterable: false, value: (r) => (T.all.rev ? r.t.rev / T.all.rev * 100 : 0), render: (r) => <Share p={T.all.rev ? r.t.rev / T.all.rev * 100 : 0} /> },
          { key: 'rev', label: `销售额 ${C}`, w: 140, type: 'money', sortable: false, value: (r) => r.t.rev, render: (r) => s.f(r.t.rev) },
          { key: 'qty', label: '销量 片', w: 100, type: 'number', sortable: false, value: (r) => r.t.qty, render: (r) => qty(r.t.qty) },
          { key: 'cost', label: `成本 ${C}`, w: 140, type: 'money', sortable: false, value: (r) => r.t.cost, render: (r) => s.f(r.t.cost) },
          { key: 'profit', label: `利润 ${C}`, w: 140, type: 'money', sortable: false, value: (r) => r.t.profit, render: (r) => <span className={r.t.profit < 0 ? 'red-t2' : ''}>{s.f(r.t.profit)}</span> },
          { key: 'pct', label: '毛利率', w: 90, type: 'number', sortable: false, value: (r) => r.t.pct, render: (r) => <Pct p={r.t.pct} low={lowPct} /> },
          { key: 'n', label: '单', w: 70, type: 'number', sortable: false, value: (r) => r.t.n }, { key: 'c', label: '客户', w: 70, type: 'number', sortable: false, value: (r) => r.t.c },
        ]} foot={() => ({ name: '合计', rev: s.f(T.all.rev), qty: qty(T.all.qty), cost: s.f(T.all.cost), profit: s.f(T.all.profit), pct: T.all.pct == null ? '—' : `${T.all.pct.toFixed(1)}%`, n: T.all.n, c: T.all.c })} />
          : <><Grid id="d2-pl" noTools rows={pl} rowClass={(r) => (r.sub ? 'dk-child' : '')} columns={[
            { key: 'name', label: '项目', w: 260, sortable: false, filterable: false, render: (r) => (r.b ? <b>{r.name}</b> : <span style={{ paddingLeft: r.sub ? 18 : 0 }}>{r.name}</span>) },
            { key: 'v', label: `金额 ${C}`, w: 160, type: 'money', sortable: false, value: (r) => r.v, render: (r) => <span className={r.v < 0 && r.b ? 'red-t2' : ''}>{r.b ? <b>{s.f(r.v)}</b> : s.f(r.v)}</span> },
            { key: 'pct', label: '占销售额', w: 110, type: 'number', sortable: false, value: (r) => r.pct, render: (r) => (r.pct == null ? '' : <Pct p={r.pct} low={r.id === 'net' ? 0 : lowPct} />) },
            { key: 'n', label: '笔', w: 70, type: 'number', sortable: false, value: (r) => r.n || '' }]} />
          <div className="small muted" style={{ marginTop: 6 }} data-tip="开支 = 资金账户里已批的支出（按科目）+ 工资表（实发 + 社保）。订单运费已经在毛利里扣过、退给客户的钱不算开支，都不重复算。">{hasPay ? '' : '这段时间还没建工资表，净利里没扣工资。'}开支只算系统里记了的；没记进来的减不掉。</div></>}
      </Detail>}
      <div className="d2-row">
        <DCard small title="本地备货" open={o1 === 'local'} onFold={() => { setExp({}); tg1('local'); }} foot={<span>{T.loc.n} 单 · {T.loc.c} 位客户</span>}><div className="d2-sub">{cells(T.loc, 'local', false)}</div></DCard>
        <DCard small title="FOB" to={['fob', 'FOB 项目']} open={o1 === 'fob'} onFold={() => { setExp({}); tg1('fob'); }}
          foot={<><span>{T.fob.n} 单 · {T.fob.c} 位客户</span>{transit?.n > 0 && <button type="button" className="d2-link" onClick={() => go('fob')}>在途 {transit.n} 单 · 订金已收 {transit.paid} ›</button>}</>}><div className="d2-sub">{cells(T.fob, 'fob', false)}</div></DCard>
      </div>
      {o1 && <Detail title={kind1 === 'fob' ? 'FOB · 客户 → 订单 → 型号' : '本地备货'} right={kind1 === 'local' && <Seg value={dim} onChange={(k) => { setDim(k); setExp({}); }} options={[['category', '按种类'], ['tier', '按档位']]} />}>
        <Grid id={`d2-${kind1}`} columns={cols} rows={table} noTools parentOf={parentOf} rowClass={(r) => (r.lvl ? 'dk-child' : '')} empty={`这个时间段还没有${kind1 === 'fob' ? ' FOB ' : '本地'}出库`}
          foot={() => ({ label: '合计', rev: s.f(t1.rev), qty: qty(t1.qty), cost: s.f(t1.cost), profit: s.f(t1.profit), pct: t1.pct == null ? '—' : `${t1.pct.toFixed(1)}%`, n: t1.n })} />
      </Detail>}
      {missOpen && <Modal title={`没成本的型号 · ${miss.length} 个`} onClose={() => setMissOpen(false)} footer={<><button type="button" className="btn" onClick={() => setMissOpen(false)}>关闭</button><button type="button" className="btn primary" onClick={() => go('pricing')}>去物料与定价补成本 ›</button></>}>
        <div className="small muted" style={{ marginBottom: 8 }}>这些型号出库时没有到岸成本，它们的销售额算了、成本和毛利没算。点型号打开档案，在「采购批次」里补上。</div>
        <Grid id="d2-miss" noTools maxHeight={360} rows={miss} columns={[
          { key: 'model', label: '型号', w: 160, render: (r) => <ModelLink id={r.id} model={r.model} /> }, { key: 'category', label: '种类', w: 110 },
          { key: 'code', label: '编码', w: 150 }, { key: 'qty', label: '这段时间出了 片', w: 130, type: 'number', render: (r) => qty(r.qty) }]} />
      </Modal>}
    </div>);
}

// ───────────────────────── 库存 ─────────────────────────
const TK = [['S', 'price_s'], ['WHOLESALE', 'price_w'], ['RETAIL', 'price_r'], ['REPAIR', 'price_p']];
export function StockSec({ all, onAlert }) {
  const { org, role, go, tick } = useApp(); const { lowPct } = useMarginRules();
  const s = useSec('stock', 'CNY'); const cv = useRates(); const rv = useRuleValues(DASH_RULES);
  const [o0, tg0] = useSlot('k0'); const [o1, tg1] = useSlot('k1');
  const [tab, setTab] = useLs('la9s.d2.stock.tab', 'wh');
  const [stf, setStf] = useState(null);
  const { data } = useData(async () => {
    const [st, tr, rep, snap] = await Promise.all([
      call(role, `select * from app.dash_stock($1)`, [org]), call(role, `select * from app.dash_transit($1)`, [org]), q(Q.replenish, [org]).catch(() => []),
      q(`select key, value from app.dash_snapshots where org_id = $1 and day = (select max(day) from app.dash_snapshots where org_id = $1 and day < date_trunc('month', current_date)::date)`, [org]).catch(() => [])]);
    const hist = await q(`select day::text as day, key, value from app.dash_snapshots where org_id = $1 and key in ('stock_cost', 'q120_cost') order by day`, [org]).catch(() => []);
    return { st, tr, rep, hist, snap: Object.fromEntries(snap.map((x) => [x.key, N(x.value)])) };
  }, [org, role, tick]);
  const a1 = ruleNum(rv, 'dash.age1'), a2 = ruleNum(rv, 'dash.age2'), lo = ruleNum(rv, 'dash.cover_lo'), hi = ruleNum(rv, 'dash.cover_hi');
  // 各档出货占比 (近 90 天本地出库片数), 用来把四档价加权成一个预估
  const w = useMemo(() => {
    const from = shiftD(today(), -90); const by = {}; let n = 0; let first = null;
    for (const r of all || []) { if (r.supply === 'fob' || !r.tier) continue; const d = ymd(r.shipped_on); if (!first || d < first) first = d; if (d < from) continue; by[r.tier] = (by[r.tier] || 0) + N(r.qty); n += N(r.qty); }
    return { by, n, enough: n > 0 && first && daysBetween(first, today()) >= 30 };
  }, [all]);
  const calc = useMemo(() => {
    if (!data) return null;
    const mk = () => ({ pcs: 0, cost: 0, nocost: 0, c0: 0, c1: 0, c2: 0, p2: 0, sku: new Set(), rev: { S: 0, WHOLESALE: 0, RETAIL: 0, REPAIR: 0 }, cb: { S: 0, WHOLESALE: 0, RETAIL: 0, REPAIR: 0 } });
    const add = (t, r) => {
      const n = N(r.qty), uc = r.unit_cost == null ? null : N(r.unit_cost);
      t.pcs += n; t.sku.add(r.product_id); if (uc == null) t.nocost += n; else { t.cost += n * uc; t.c0 += N(r.q0_30) * uc; t.c1 += N(r.q31_120) * uc; t.c2 += N(r.q120) * uc; }
      t.p2 += N(r.q120);
      if (uc != null) for (const [tk, col] of TK) if (r[col] != null) { t.rev[tk] += n * N(r[col]); t.cb[tk] += n * uc; }
    };
    const stock = data.st.filter((r) => ['local', 'fob'].includes(r.wh_kind)); const other = data.st.filter((r) => !['local', 'fob'].includes(r.wh_kind));
    const allT = mk(), loc = mk(), fob = mk(); const byWh = new Map(); const byCat = new Map();
    for (const r of stock) { add(allT, r); add(r.wh_kind === 'fob' ? fob : loc, r); if (!byWh.has(r.warehouse)) byWh.set(r.warehouse, { id: r.warehouse, name: r.warehouse, kind: r.wh_kind, t: mk() }); add(byWh.get(r.warehouse).t, r);
      const ck = r.category || '（没种类）'; if (!byCat.has(ck)) byCat.set(ck, { id: ck, name: ck, t: mk() }); add(byCat.get(ck).t, r); }
    const oth = new Map(); for (const r of other) { if (!oth.has(r.warehouse)) oth.set(r.warehouse, { id: r.warehouse, name: r.warehouse, kind: r.wh_kind, t: mk() }); add(oth.get(r.warehouse).t, r); }
    const tr = { pcs: 0, cost: 0, fob: 0, late: [], n: data.tr.length }; const td = today();
    for (const p of data.tr) { tr.pcs += N(p.pcs); tr.cost += N(p.cost_xof); tr.fob += N(p.fob_pcs); if (p.eta && ymd(p.eta) < td) tr.late.push(p); }
    return { allT, loc, fob, byWh: [...byWh.values()], byCat: [...byCat.values()].sort((a, b) => b.t.cost - a.t.cost), oth: [...oth.values()], tr };
  }, [data]);
  // 预估毛利: 四档各算一遍; 加权 = 按近 90 天各档出货片数占比
  const est = (t) => {
    const per = TK.map(([tk]) => ({ tk, rev: t.rev[tk], cost: t.cb[tk], gp: t.rev[tk] - t.cb[tk], pct: t.rev[tk] ? (t.rev[tk] - t.cb[tk]) / t.rev[tk] * 100 : null }));
    if (!w.enough) return { per, w: null };
    let rev = 0, cost = 0; for (const x of per) { const k = (w.by[x.tk] || 0) / w.n; rev += x.rev * k; cost += x.cost * k; }
    return { per, w: { rev, cost, gp: rev - cost, pct: rev ? (rev - cost) / rev * 100 : null } };
  };
  // 型号可卖月数 (本地): (可售 + 在途) ÷ 近 3 个月月均
  const models = useMemo(() => (data?.rep || []).filter((r) => N(r.on_hand) > 0 || N(r.daily) > 0 || N(r.in_transit) > 0).map((r) => {
    const mo = N(r.daily) > 0 ? (N(r.available) + N(r.in_transit)) / (N(r.daily) * 30) : null;
    const st = N(r.daily) > 0 && N(r.available) <= 0 ? '断货' : mo == null ? (N(r.on_hand) > 0 ? '积压' : '') : mo < lo ? '危机' : mo < 3 ? '警惕' : mo <= hi ? '安全' : '积压';
    return { ...r, id: r.product_id, mo, st };
  }).filter((r) => r.st), [data, lo, hi]);
  const stN = (k) => models.filter((r) => r.st === k).length;
  const cover = useMemo(() => { const d = models.reduce((a, r) => a + N(r.daily), 0); return d > 0 ? models.reduce((a, r) => a + N(r.available) + N(r.in_transit), 0) / (d * 30) : null; }, [models]);
  const X = (xof) => s.f(cv(xof, s.cur));
  useEffect(() => {
    if (!calc) return;
    const al = [];
    if (stN('断货')) al.push({ tone: 'red', text: `${stN('断货')} 个型号断货`, go: 'replenish' });
    if (calc.tr.late.length) al.push({ tone: 'red', text: `${calc.tr.late.length} 单在途已到没取`, go: 'po' });
    onAlert?.('stock', al);
    call(role, `select app.dash_snap($1,$2)`, [org, JSON.stringify({ stock_cost: Math.round(calc.allT.cost), stock_pcs: calc.allT.pcs, transit_cost: Math.round(calc.tr.cost), q120_cost: Math.round(calc.allT.c2) })]).catch(() => {});
  }, [calc, models.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!calc) return <div className="d2-sec"><div className="d2-card muted small">库存加载中…</div></div>;
  const { allT, loc, fob, tr } = calc; const e0 = est(allT);
  const agep = [[`0–${a1} 天`, allT.c0, 'green'], [`${a1 + 1}–${a2} 天`, allT.c1, 'amber'], [`${a2} 天以上`, allT.c2, 'red']];
  const snapBase = data.snap.stock_cost != null ? data.snap.stock_cost + (data.snap.transit_cost || 0) : null;
  const etaTone = (p) => { if (!p.eta) return ['grey', '没填到货日']; const d = daysBetween(today(), ymd(p.eta)); return d < 0 ? ['red', `已到 ${-d} 天没取`] : d <= 7 ? ['amber', `${d} 天后到`] : d <= 30 ? ['green', `${d} 天后到`] : ['grey', `${d} 天后到`]; };
  const whCols = (nameLabel) => [
    { key: 'name', label: nameLabel, w: 150, sortable: false, render: (r) => <b>{r.name}</b> },
    { key: 'pcs', label: '现有 片', w: 100, type: 'number', value: (r) => r.t.pcs, render: (r) => qty(r.t.pcs) },
    { key: 'cost', label: `现有成本 ${s.cur}`, w: 140, type: 'money', value: (r) => r.t.cost, render: (r) => <>{X(r.t.cost)}{r.t.nocost > 0 && <span className="pill red" style={{ marginLeft: 4 }} title={`${qty(r.t.nocost)} 片没成本，没算进金额`}>缺</span>}</> },
    { key: 'c0', label: `0–${a1} 天`, w: 110, type: 'money', value: (r) => r.t.c0, render: (r) => X(r.t.c0) },
    { key: 'c1', label: `${a1 + 1}–${a2} 天`, w: 110, type: 'money', value: (r) => r.t.c1, render: (r) => (r.t.c1 ? <span className="amber-t">{X(r.t.c1)}</span> : X(0)) },
    { key: 'c2', label: `${a2} 天以上`, w: 110, type: 'money', value: (r) => r.t.c2, render: (r) => (r.t.c2 ? <span className="red-t2">{X(r.t.c2)}</span> : X(0)) },
    { key: 'gp', label: `预估毛利 ${s.cur}`, w: 130, type: 'money', value: (r) => est(r.t).w?.gp, render: (r) => { const x = est(r.t).w; return x ? X(x.gp) : <span className="muted">数据不足</span>; } },
    { key: 'pct', label: '预估毛利率', w: 100, type: 'number', value: (r) => est(r.t).w?.pct, render: (r) => { const x = est(r.t).w; return x ? <Pct p={x.pct} low={lowPct} /> : ''; } },
  ];
  const sumRow = (t) => { const x = est(t).w; return { name: '合计', pcs: qty(t.pcs), cost: X(t.cost), c0: X(t.c0), c1: X(t.c1), c2: X(t.c2), gp: x ? X(x.gp) : '', pct: x?.pct == null ? '' : `${x.pct.toFixed(1)}%` }; };
  const tierRows = [...e0.per.map((x) => ({ id: x.tk, tier: x.tk, ...x })), ...(e0.w ? [{ id: 'w', wt: 1, ...e0.w }] : [])];
  const mrows = stf ? models.filter((r) => r.st === stf) : models;
  const stTone = { 断货: 'red', 危机: 'red', 警惕: 'amber', 安全: 'green', 积压: 'amber' };
  const fobRows = data.st.filter((r) => r.wh_kind === 'fob').map((r) => ({ ...r, id: r.stock_item_id }));
  return (
    <div className="d2-sec">
      <DCard title="库存" sub="现有 + 在途 · 金额 = 到岸成本" to={['stock', '库存']} tog={<Tog s={s} />} gear={<RuleGear ids={['dash.age1', 'dash.age2', 'dash.cover_lo', 'dash.cover_hi']} title="库存看板的规则" />} open={o0 === 'st'} onFold={() => tg0('st')}
        foot={<><span>{calc.byWh.map((x) => x.name).join(' · ')} {calc.byWh.length} 个仓 · {allT.sku.size} 个编码</span>
          {e0.w ? <span data-tip="按现在的挂牌价把现有库存卖完，大概能赚多少。四档价按近 90 天各档出货片数占比加权。">按现价卖完预估毛利 <b className="ink">{X(e0.w.gp)}</b> <Pct p={e0.w.pct} low={lowPct} /></span> : <span data-tip="自己的出货不满 30 天，各档占比还不准">预估毛利：数据不足</span>}
          {allT.nocost > 0 && <button type="button" className="d2-warn" onClick={() => go('pricing')}>{qty(allT.nocost)} 片没成本</button>}
          {calc.oth.length > 0 && <button type="button" className="d2-link" onClick={() => { setTab('wh'); if (o0 !== 'st') tg0('st'); }}>待检 / 报废等 {qty(calc.oth.reduce((a, x) => a + x.t.pcs, 0))} 片 ›</button>}</>}>
        <div className="d2-hero">
          <Cell label="库存 + 在途" main cur={s.cur} tip="现有库存的到岸成本 + 在途采购单的成本（按现在的到岸成本估）。" onClick={() => go('stock')} sub={<>{qty(allT.pcs + tr.pcs)} 片{snapBase != null && <> · <Cmp now={allT.cost + tr.cost} base={snapBase} goodUp={false} f={X} what="比上月底" /></>}</>}>{X(allT.cost + tr.cost)}</Cell>
          <Cell label="现有" onClick={() => go('stock')} sub={`${qty(allT.pcs)} 片`}>{X(allT.cost)}</Cell>
          <Cell label="在途" onClick={() => go('po')} sub={<>{qty(tr.pcs)} 片 · {tr.n} 单{tr.late.length > 0 && <span className="pill red" style={{ marginLeft: 6 }} data-tip="预计到货日已经过了，还没收货">{tr.late.length} 单已到没取</span>}</>}>{X(tr.cost)}</Cell>
          <Cell label={`超 ${a2} 天`} tone={allT.c2 > 0 ? 'num-red' : ''} tip={`从我们收到货那天算，超过 ${a2} 天还没卖掉的库存成本（先进先出）。系统里没有入库记录的老货也算在这里。`} onClick={() => { setTab('wh'); if (o0 !== 'st') tg0('st'); }} sub={`${qty(allT.p2)} 片`}>{X(allT.c2)}</Cell>
        </div>
        {allT.cost > 0 && <><div className="d2-bar">{agep.map(([l, v, t]) => <i key={l} className={t} style={{ width: `${v / allT.cost * 100}%` }} data-tip={`${l} ${X(v)} ${s.cur}`} />)}</div>
          <div className="d2-barl">{agep.map(([l, v, t]) => <span key={l} className={t}>{l} {X(v)}</span>)}</div></>}
      </DCard>
      {o0 === 'st' && <Detail title="库存明细" right={<Seg value={tab} onChange={setTab} options={[['wh', '按仓'], ['tier', '按档位'], ['cat', '按种类'], ['tr', '在途'], ['line', '走势']]} />}>
        {tab === 'wh' && <><Grid id="d2-wh" noTools rows={calc.byWh} columns={whCols('仓')} foot={() => sumRow(allT)} />
          {calc.oth.length > 0 && <div style={{ marginTop: 10 }}><div className="small muted" style={{ marginBottom: 4 }}>不参与出货的仓（待检 / 报废 / 回收…），不算进上面的库存</div>
            <Grid id="d2-wh2" noTools rows={calc.oth} columns={whCols('仓').slice(0, 3)} /></div>}</>}
        {tab === 'tier' && <><Grid id="d2-tier" noTools rows={tierRows} rowClass={(r) => (r.wt ? 'd2-wrow' : '')} columns={[
          { key: 'tier', label: '档位', w: 220, sortable: false, render: (r) => (r.wt ? <b>按近 90 天出货占比加权</b> : <TierPill tier={r.tier} />) },
          { key: 'rev', label: `按这档价卖完 ${s.cur}`, w: 170, type: 'money', sortable: false, value: (r) => r.rev, render: (r) => (r.wt ? <b>{X(r.rev)}</b> : X(r.rev)) },
          { key: 'cost', label: `成本 ${s.cur}`, w: 150, type: 'money', sortable: false, value: (r) => r.cost, render: (r) => X(r.cost) },
          { key: 'gp', label: `预估毛利 ${s.cur}`, w: 150, type: 'money', sortable: false, value: (r) => r.gp, render: (r) => <span className={r.gp < 0 ? 'red-t2' : ''}>{r.wt ? <b>{X(r.gp)}</b> : X(r.gp)}</span> },
          { key: 'pct', label: '毛利率', w: 100, type: 'number', sortable: false, value: (r) => r.pct, render: (r) => <Pct p={r.pct} low={lowPct} /> },
          { key: 'share', label: '近 90 天出货占比', w: 150, sortable: false, value: (r) => (r.wt || !w.n ? null : (w.by[r.tier] || 0) / w.n * 100), render: (r) => (r.wt || !w.n ? '' : <Share p={(w.by[r.tier] || 0) / w.n * 100} />) }]} />
          <div className="small muted" style={{ marginTop: 6 }}>四档是四种卖法，同一批货只能按一种价卖，所以四行不能相加；最后一行按你近 90 天卖给各档的比例加权{e0.w ? '' : '（自己的出货不满 30 天，先不算）'}。只算有成本、有这一档价格的货。</div></>}
        {tab === 'cat' && <Grid id="d2-cat" noTools maxHeight={420} rows={calc.byCat} columns={whCols('种类')} foot={() => sumRow(allT)} />}
        {tab === 'tr' && <Grid id="d2-tr" noTools maxHeight={420} rows={data.tr.map((p) => ({ ...p, id: p.po_id }))} empty="没有在途的采购单" columns={[
          { key: 'po_no', label: '采购单', w: 170, render: (p) => <button type="button" className="linkbtn mono" onClick={() => go('po')}>{p.po_no}</button> },
          { key: 'mode', label: '方式', w: 80, value: (p) => ({ sea: '海运', air: '空运' })[p.mode] || p.mode || '' },
          { key: 'eta', label: '预计到货', w: 110, render: (p) => dDate(p.eta) },
          { key: 'st', label: '还有几天', w: 150, value: (p) => (p.eta ? daysBetween(today(), ymd(p.eta)) : 9999), render: (p) => { const [t, l] = etaTone(p); return <span className={`pill ${t}`}>{l}</span>; } },
          { key: 'pcs', label: '在途 片', w: 100, type: 'number', value: (p) => N(p.pcs), render: (p) => qty(p.pcs) },
          { key: 'fob_pcs', label: '其中 FOB 片', w: 110, type: 'number', value: (p) => N(p.fob_pcs), render: (p) => qty(p.fob_pcs) },
          { key: 'cost', label: `成本 ${s.cur}`, w: 140, type: 'money', value: (p) => N(p.cost_xof), render: (p) => <>{X(N(p.cost_xof))}{N(p.nocost_pcs) > 0 && <span className="pill red" style={{ marginLeft: 4 }} title={`${qty(p.nocost_pcs)} 片没成本`}>缺</span>}</> }]}
          foot={() => ({ po_no: '合计', pcs: qty(tr.pcs), fob_pcs: qty(tr.fob), cost: X(tr.cost) })} />}
        {tab === 'line' && <div className="rp-two"><div><div className="small muted">库存成本 {s.cur}（每周一个点）</div><Spark pts={weekly((data.hist || []).filter((x) => x.key === 'stock_cost').map((x) => [x.day, cv(N(x.value), s.cur)]))} fmt={(v) => fmtN(v, s.cur, true)} /></div>
          <div><div className="small muted">超 {a2} 天的库存成本 {s.cur}</div><Spark pts={weekly((data.hist || []).filter((x) => x.key === 'q120_cost').map((x) => [x.day, cv(N(x.value), s.cur)]))} fmt={(v) => fmtN(v, s.cur, true)} color="#dc2626" /></div></div>}
      </Detail>}
      <div className="d2-row">
        <DCard small title="本地备货" open={o1 === 'loc'} onFold={() => tg1('loc')} foot={<span>LA + 9S · {loc.sku.size} 个编码</span>}>
          <div className="d2-sub">
            <Cell label="现有" onClick={() => go('stock')} sub={`${qty(loc.pcs)} 片`}>{X(loc.cost)}</Cell>
            <Cell label="在途" onClick={() => go('po')} sub={`${qty(tr.pcs - tr.fob)} 片`}>{X(tr.pcs ? tr.cost * (tr.pcs - tr.fob) / tr.pcs : 0)}</Cell>
            <Cell label="可卖" unit="个月" tone={cover != null && cover < lo ? 'num-red' : ''} tip={`（可售 + 在途）÷ 近 3 个月月均销量。低于 ${lo} 个月危机，高于 ${hi} 个月积压。本地算在途，FOB 不算。`} onClick={() => { setStf(null); if (o1 !== 'loc') tg1('loc'); }}>{cover == null ? '—' : cover.toFixed(1)}</Cell>
            <Cell label="断货 · 危机" unit="个型号" tone={stN('断货') + stN('危机') > 0 ? 'num-red' : ''} onClick={() => { setStf(stN('断货') ? '断货' : '危机'); if (o1 !== 'loc') tg1('loc'); }} sub={stN('积压') > 0 ? `积压 ${stN('积压')} 个` : ''}>{stN('断货') + stN('危机')}</Cell>
          </div>
        </DCard>
        <DCard small title="FOB" open={o1 === 'fob'} onFold={() => tg1('fob')} foot={<span data-tip="FOB 是一客一单，货到了就等客户提，不算可卖月数">一客一单 · {fob.sku.size} 个编码</span>}>
          <div className="d2-sub">
            <Cell label="现有" onClick={() => go('fob')} sub={`${qty(fob.pcs)} 片`}>{X(fob.cost)}</Cell>
            <Cell label="在途" unit="片" onClick={() => go('po')}>{qty(tr.fob)}</Cell>
            <Cell label={`超 ${a2} 天`} tone={fob.c2 > 0 ? 'num-red' : ''} sub={`${qty(fob.p2)} 片`} onClick={() => { if (o1 !== 'fob') tg1('fob'); }}>{X(fob.c2)}</Cell>
            <Cell label={`超 ${a1} 天`} sub="到了还没提走" onClick={() => { if (o1 !== 'fob') tg1('fob'); }}>{X(fob.c1 + fob.c2)}</Cell>
          </div>
        </DCard>
      </div>
      {o1 === 'loc' && <Detail title="本地备货 · 每个型号还能卖多久" right={<span className="d2-seg">{[null, '断货', '危机', '警惕', '安全', '积压'].map((k) => <button type="button" key={k || 'all'} className={stf === k ? 'on' : ''} onClick={() => setStf(k)}>{k || '全部'} {k ? stN(k) : models.length}</button>)}</span>}>
        <Grid id="d2-models" noTools maxHeight={420} rows={mrows} empty="没有这种状态的型号" columns={[
          { key: 'model', label: '型号', w: 150, render: (r) => <ModelLink id={r.product_id} model={r.model || r.code} /> }, { key: 'category', label: '种类', w: 110 },
          { key: 'st', label: '状态', w: 80, render: (r) => <span className={`pill ${stTone[r.st]}`}>{r.st}</span> },
          { key: 'mo', label: '可卖 月', w: 90, type: 'number', value: (r) => r.mo ?? 999, render: (r) => (r.mo == null ? '没销量' : r.mo.toFixed(1)) },
          { key: 'available', label: '可售 片', w: 90, type: 'number', value: (r) => N(r.available), render: (r) => qty(r.available) },
          { key: 'in_transit', label: '在途 片', w: 90, type: 'number', value: (r) => N(r.in_transit), render: (r) => qty(r.in_transit) },
          { key: 'sold_30', label: '近 30 天卖 片', w: 110, type: 'number', value: (r) => N(r.sold_30), render: (r) => qty(r.sold_30) },
          { key: 'eta', label: '下一批到货', w: 110, render: (r) => dDate(r.eta) }]} />
      </Detail>}
      {o1 === 'fob' && <Detail title="FOB 仓 · 按型号">
        <Grid id="d2-fobst" noTools maxHeight={420} rows={fobRows} empty="FOB 仓现在没有货" columns={[
          { key: 'model', label: '型号', w: 150, render: (r) => <ModelLink id={r.product_id} model={r.model || r.product_code} /> }, { key: 'category', label: '种类', w: 110 },
          { key: 'qty', label: '现有 片', w: 100, type: 'number', value: (r) => N(r.qty), render: (r) => qty(r.qty) },
          { key: 'cost', label: `成本 ${s.cur}`, w: 140, type: 'money', value: (r) => N(r.qty) * N(r.unit_cost), render: (r) => (r.unit_cost == null ? <span className="pill red">缺</span> : X(N(r.qty) * N(r.unit_cost))) },
          { key: 'oldest_days', label: '最老 天', w: 90, type: 'number', value: (r) => N(r.oldest_days), render: (r) => (r.oldest_days == null ? '' : <span className={N(r.oldest_days) > a2 ? 'pill red' : N(r.oldest_days) > a1 ? 'pill amber' : ''}>{r.oldest_days}</span>) }]}
          foot={() => ({ model: '合计', qty: qty(fob.pcs), cost: X(fob.cost) })} />
      </Detail>}
    </div>);
}

// ───────────────────────── 账款 ─────────────────────────
export function AcctSec({ bal, rc, fobs, ship, from, to, label, onAlert }) {
  const { org, role, go, tick } = useApp();
  const fin = ['admin', 'finance'].includes(role);
  const s = useSec('acct', 'XOF'); const cv = useRates(); const rv = useRuleValues(DASH_RULES);
  const held = usePublicHeld(); const remits = useRemits(); const rules = useRemitRules();
  const [o0, tg0] = useSlot('a0'); const [o1, tg1] = useSlot('a1'); const [o2, tg2] = useSlot('a2');
  const [rcTab, setRcTab] = useLs('la9s.d2.acct.rctab', 'list');
  const [ageF, setAgeF] = useState(null);
  const arDays = ruleNum(rv, 'dash.ar_days'), arRed = ruleNum(rv, 'dash.ar_red'), rrLo = ruleNum(rv, 'dash.rr_lo'), rrHi = ruleNum(rv, 'dash.rr_hi');
  const { data } = useData(async () => {
    const [due, [ps], [acc], snap] = await Promise.all([
      q(`select d.deal_id, d.customer_id, c.name as customer_name, c.credit_days, d.due, d.first_shipped_at, dl.biz_no, e.short_name as owner
         from app.v_deal_due d join app.customers c on c.id = d.customer_id join app.deals dl on dl.id = d.deal_id left join app.employees e on e.id = c.owner_employee_id
         where d.org_id = $1 and d.currency = 'XOF' and d.due > 0`, [org]),
      q(`select rmb_per_xof, xof_per_usd from app.price_settings where org_id = $1`, [org]),
      q(`select count(*) as n from app.cash_accounts where org_id = $1 and active`, [org]),
      q(`select key, value from app.dash_snapshots where org_id = $1 and key = 'ar' and day = (select max(day) from app.dash_snapshots where org_id = $1 and key = 'ar' and day < date_trunc('month', current_date)::date)`, [org]).catch(() => [])]);
    return { due, ps, accN: N(acc?.n), arBase: snap[0] ? N(snap[0].value) : null };
  }, [org, tick]);
  const td = today();
  const due = useMemo(() => (data?.due || []).map((r) => {
    const shipped = ymd(r.first_shipped_at); const cd = r.credit_days == null ? arDays : N(r.credit_days);
    const dueDate = shipped ? shiftD(shipped, cd) : null; const over = dueDate ? Math.max(0, daysBetween(dueDate, td)) : 0; const left = dueDate ? daysBetween(td, dueDate) : null;
    return { ...r, id: r.deal_id, amt: N(r.due), shipped, cd, dueDate, over, left, seg: over === 0 ? 0 : over <= arRed ? 1 : 2 };
  }).sort((a, b) => b.over - a.over || b.amt - a.amt), [data, arDays, arRed, td]);
  const sum = (l) => l.reduce((a, r) => a + r.amt, 0);
  const seg = [0, 1, 2].map((i) => due.filter((r) => r.seg === i));
  const locAR = sum(due), overAR = sum(seg[1]) + sum(seg[2]);
  const due7 = sum(due.filter((r) => r.left != null && r.left >= 0 && r.left <= 7)), due30 = sum(due.filter((r) => r.left != null && r.left >= 0 && r.left <= 30));
  const pre = bal.filter((b) => N(b.balance) < 0); const preT = -pre.reduce((a, b) => a + N(b.balance), 0);
  // FOB: 订金还差 / 尾款未收 (各项目自己的币种, 按现在的汇率折 XOF)
  const fl = useMemo(() => (fobs || []).filter((f) => !['closed', 'cancelled'].includes(f.status)).map((f) => {
    const k = (x) => toXof(x, f.currency, data?.ps); const dep = N(f.total) * N(f.deposit_pct) / 100;
    return { ...f, dep: k(Math.max(0, dep - N(f.paid))), tail: k(Math.max(0, N(f.total) - Math.max(N(f.paid), dep))), paidX: k(N(f.paid)), totalX: k(N(f.total)) };
  }), [fobs, data]);
  const fobDep = fl.reduce((a, f) => a + f.dep, 0), fobTail = fl.reduce((a, f) => a + f.tail, 0), fobPaid = fl.reduce((a, f) => a + f.paidX, 0);
  const AR = locAR + fobDep + fobTail;
  // 按客户汇总 (账龄明细)
  const byCust = useMemo(() => { const m = new Map(); for (const r of due) { const x = m.get(r.customer_id) || { id: r.customer_id, name: r.customer_name, owner: r.owner, amt: 0, over: 0, overAmt: 0, d7: 0, oldest: null, dueDate: null, cd: r.cd, n: 0 }; x.amt += r.amt; x.n += 1; if (r.over > 0) x.overAmt += r.amt; if (r.over > x.over) x.over = r.over; if (r.left != null && r.left >= 0 && r.left <= 7) x.d7 += r.amt; if (!x.oldest || (r.shipped && r.shipped < x.oldest)) { x.oldest = r.shipped; x.dueDate = r.dueDate; } m.set(r.customer_id, x); } return [...m.values()].sort((a, b) => b.amt - a.amt); }, [due]);
  // 收款 (跟日期走)
  const live = rc.filter((r) => !r.voided_at);
  const amtX = (r) => { const c = r.account_currency || r.currency; const v = N(r.account_currency && r.account_currency !== r.currency ? r.converted : r.amount); return toXof(v, c, data?.ps); };
  const rcT = live.reduce((a, r) => a + amtX(r), 0); const rcXof = live.filter((r) => r.currency === 'XOF').reduce((a, r) => a + N(r.amount), 0);
  const pend = live.filter((r) => r.verify_status === 'pending');
  const rr = N(ship) > 0 ? rcXof / N(ship) * 100 : null; const rrTone = rr == null ? '' : rr < rrLo ? 'red' : rr < rrHi ? 'amber' : 'green';
  const byAcc = Object.values(live.reduce((a, r) => { const k = r.account_name || '没选账户'; const x = a[k] || (a[k] = { id: k, name: k, v: 0, n: 0, p: 0 }); x.v += amtX(r); x.n += 1; if (r.verify_status === 'pending') x.p += 1; return a; }, {})).sort((a, b) => b.v - a.v);
  const heldT = (held || []).reduce((a, x) => a + x.total, 0), heldN = (held || []).reduce((a, x) => a + x.owing.length, 0), heldOld = Math.max(0, ...(held || []).map((a) => a.oldest)); const heldLate = (held || []).filter((a) => a.late);
  const rem = (remits || []).filter((r) => r.status !== 'void'); const remP = rem.filter((r) => ymd(r.on_date) >= from && ymd(r.on_date) <= to); const remFlag = rem.filter((r) => remitFlag(r, rules));
  const X = (xof) => s.f(cv(xof, s.cur));
  useEffect(() => {
    if (!data) return;
    const al = [];
    const c2 = new Set(seg[2].map((r) => r.customer_id)).size;
    if (c2) al.push({ tone: 'red', text: `${c2} 个客户超期 ${arRed} 天以上 · ${X(sum(seg[2]))} ${s.cur}`, go: 'balances' });
    if (heldLate.length) al.push({ tone: 'red', text: `${heldLate.map((a) => a.holder).join(' / ')} 手里的钱压了 ${heldOld} 天`, go: 'cash' });
    if (fl.some((f) => f.dep > 0)) al.push({ tone: 'amber', text: `${fl.filter((f) => f.dep > 0).length} 个 FOB 订金没收齐`, go: 'fob' });
    if (pend.length) al.push({ tone: 'amber', text: `${pend.length} 笔收款待核对`, go: 'receipts' });
    if (remFlag.length) al.push({ tone: 'amber', text: `${remFlag.length} 笔回款要看`, go: 'cash' });
    onAlert?.('acct', al);
    if (role === 'admin') call(role, `select app.dash_snap($1,$2)`, [org, JSON.stringify({ ar: Math.round(AR) })]).catch(() => {});
  }, [data, due.length, heldLate.length, pend.length, remFlag.length, fl.length, s.cur, s.short]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="d2-sec"><div className="d2-card muted small">账款加载中…</div></div>;
  const agep = [['账期内', sum(seg[0]), 'green', 0], [`超期 1–${arRed} 天`, sum(seg[1]), 'amber', 1], [`超期 ${arRed} 天以上`, sum(seg[2]), 'red', 2]];
  const overPill = (o) => (o === 0 ? <span className="pill green">账期内</span> : <span className={`pill ${o > arRed ? 'red' : 'amber'}`}>超 {o} 天</span>);
  const openAge = (i) => { setAgeF(i); if (o1 !== 'loc') tg1('loc'); };
  const dueList = ageF == null ? due : ageF === 7 ? due.filter((r) => r.left != null && r.left >= 0 && r.left <= 7) : due.filter((r) => r.seg === ageF || (ageF === 12 && r.seg > 0));
  return (
    <div className="d2-sec">
      <DCard title="账款" sub="应收 · 现在的数，不跟日期走" to={['balances', '客户总账']} tog={<Tog s={s} />} gear={<RuleGear ids={['dash.ar_days', 'dash.ar_red', 'dash.rr_lo', 'dash.rr_hi']} title="账款看板的规则" />} open={o0 === 'ar'} onFold={() => tg0('ar')}
        foot={<span>{byCust.length} 个客户有欠款{due.length > 0 && ` · 最老一笔 ${Math.max(0, ...due.map((r) => (r.shipped ? daysBetween(r.shipped, td) : 0)))} 天`}</span>}>
        <div className="d2-hero">
          <Cell label="应收总额" main cur={s.cur} tip="所有客户现在欠我们的钱 = 本地欠款 + FOB 订金还差 + FOB 尾款未收。出库后增加，收款后减少；客户预付不在里面。" onClick={() => go('balances')} sub={data.arBase != null && <Cmp now={AR} base={data.arBase} goodUp={false} f={X} what="比上月底" />}>{X(AR)}</Cell>
          <Cell label="超账期" tone={overAR > 0 ? 'num-red' : ''} tip={`过了约定付款日还没付的部分。每张单从出库那天起算，按客户档案的账期（没填按 ${arDays} 天）算到期日，精确到天。`} onClick={() => openAge(12)} sub={`${new Set([...seg[1], ...seg[2]].map((r) => r.customer_id)).size} 个客户`}>{X(overAR)}</Cell>
          <Cell label="7 天内到期" tip="接下来 7 天要到付款日的钱，用来排这周先催谁。" onClick={() => openAge(7)} sub={`30 天内 ${X(due30)}`}>{X(due7)}</Cell>
          <Cell label="客户预付" tone={preT > 0 ? 'num-grn' : ''} tip="客户先打钱、货还没出完的部分，相当于我们欠客户的钱。" onClick={() => go('balances')} sub={`${pre.length} 个客户`}>{X(preT)}</Cell>
        </div>
        {locAR > 0 && <><div className="d2-bar">{agep.map(([l, v, t, i]) => <i key={l} className={t} style={{ width: `${v / locAR * 100}%` }} data-tip={`${l} ${X(v)} ${s.cur}`} onClick={() => openAge(i)} />)}</div>
          <div className="d2-barl">{agep.map(([l, v, t, i]) => <button type="button" key={l} className={t} onClick={() => openAge(i)}>{l} {X(v)}</button>)}</div></>}
      </DCard>
      {o0 === 'ar' && <Detail title="欠款账龄 · 按客户">
        <Grid id="d2-arc" noTools maxHeight={420} rows={byCust} empty="没有客户欠款 ✓" columns={[
          { key: 'name', label: '客户', w: 200, render: (b) => <CustLink id={b.id} name={b.name} /> }, { key: 'owner', label: '销售员', w: 90 },
          { key: 'amt', label: `欠款 ${s.cur}`, w: 130, type: 'money', value: (b) => b.amt, render: (b) => <b>{X(b.amt)}</b> },
          { key: 'overAmt', label: `其中超期 ${s.cur}`, w: 130, type: 'money', value: (b) => b.overAmt, render: (b) => (b.overAmt ? <span className="red-t2">{X(b.overAmt)}</span> : X(0)) },
          { key: 'oldest', label: '最老一笔出库', w: 120, render: (b) => dDate(b.oldest) }, { key: 'cd', label: '账期 天', w: 80, type: 'number' },
          { key: 'dueDate', label: '到期日', w: 110, render: (b) => dDate(b.dueDate) },
          { key: 'over', label: '超期', w: 100, type: 'number', value: (b) => b.over, render: (b) => overPill(b.over) },
          { key: 'd7', label: `7 天内到期 ${s.cur}`, w: 140, type: 'money', value: (b) => b.d7, render: (b) => X(b.d7) }, { key: 'n', label: '单', w: 60, type: 'number' }]}
          foot={() => ({ name: '合计', amt: X(locAR), overAmt: X(overAR), d7: X(due7), n: due.length })} />
      </Detail>}
      <div className="d2-row">
        <DCard small title="本地备货" sub="欠款与回款" open={o1 === 'loc'} onFold={() => { setAgeF(null); tg1('loc'); }} foot={<span>{label}出库 {X(N(ship))}</span>}>
          <div className="d2-sub">
            <Cell label="欠款" onClick={() => openAge(null)}>{X(locAR)}</Cell>
            <Cell label="超账期" tone={overAR > 0 ? 'num-red' : ''} onClick={() => openAge(12)}>{X(overAR)}</Cell>
            <Cell label={`${label}收款`} tip="这段时间有付款凭证的收款（现金也要拍照，没凭证不算）。" onClick={() => go('receipts')}>{X(rcT)}</Cell>
            <Cell label="回款率" block={rrTone} tip={`回款率 = 这段时间收到的钱 ÷ 这段时间出库的金额（只算 XOF）。100% = 卖多少收多少；低于 100% = 欠款在变多；高于 100% = 在收以前的老账。低于 ${rrLo}% 红，${rrLo}–${rrHi}% 黄，${rrHi}% 以上绿。`} onClick={() => go('receipts')}>{rr == null ? '—' : `${rr.toFixed(0)}%`}</Cell>
          </div>
        </DCard>
        <DCard small title="FOB" sub="订金与尾款" open={o1 === 'fob'} onFold={() => tg1('fob')} foot={<span>进行中 {fl.length} 单</span>}>
          <div className="d2-sub">
            <Cell label="订金还差" tone={fobDep > 0 ? 'num-red' : ''} tip="合同订金（默认 30%）− 已收。没收齐不放货。" onClick={() => go('fob')} sub={fobDep > 0 ? `${fl.filter((f) => f.dep > 0).length} 单没收齐` : ''}>{X(fobDep)}</Cell>
            <Cell label="尾款未收" tone={fobTail > 0 ? 'num-red' : ''} tip="合同总额 − 已收（订金那部分不重复算）。" onClick={() => go('fob')}>{X(fobTail)}</Cell>
            <Cell label="已收" onClick={() => go('fob')}>{X(fobPaid)}</Cell>
            <Cell label="进行中" unit="单" onClick={() => go('fob')}>{fl.length}</Cell>
          </div>
        </DCard>
      </div>
      {o1 === 'loc' && <Detail title="本地欠款 · 按单（精确到天）" right={<span className="d2-seg">{[[null, '全部'], [0, '账期内'], [1, `超期 1–${arRed} 天`], [2, `超期 ${arRed} 天以上`], [7, '7 天内到期']].map(([k, l]) => <button type="button" key={String(k)} className={ageF === k ? 'on' : ''} onClick={() => setAgeF(k)}>{l}</button>)}</span>}>
        <Grid id="d2-ard" noTools maxHeight={420} rows={dueList} empty="没有这样的欠款 ✓" columns={[
          { key: 'customer_name', label: '客户', w: 190, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
          { key: 'biz_no', label: '单号', w: 140, render: (r) => <DealLink id={r.deal_id} no={r.biz_no} /> }, { key: 'owner', label: '销售员', w: 90 },
          { key: 'amt', label: `欠款 ${s.cur}`, w: 130, type: 'money', value: (r) => r.amt, render: (r) => <b>{X(r.amt)}</b> },
          { key: 'shipped', label: '出库日', w: 110, render: (r) => dDate(r.shipped) }, { key: 'cd', label: '账期 天', w: 80, type: 'number' },
          { key: 'dueDate', label: '到期日', w: 110, render: (r) => dDate(r.dueDate) },
          { key: 'over', label: '超期', w: 110, type: 'number', value: (r) => r.over, render: (r) => (r.over ? overPill(r.over) : r.left != null ? <span className="pill green">还有 {r.left} 天</span> : '') }]}
          foot={() => ({ customer_name: '合计', amt: X(sum(dueList)) })} />
      </Detail>}
      {o1 === 'fob' && <Detail title="FOB 项目收款">
        <Grid id="d2-arf" noTools maxHeight={420} rows={fl} empty="没有进行中的 FOB 项目" columns={[
          { key: 'project_no', label: '项目', w: 170, value: (f) => f.project_no || f.biz_no, render: (f) => <button type="button" className="linkbtn mono" onClick={() => go('fob/' + f.id)}>{f.project_no || f.biz_no || '打开'}</button> },
          { key: 'customer_name', label: '客户', w: 180, render: (f) => <CustLink id={f.customer_id} name={f.customer_name} /> },
          { key: 'totalX', label: `总额 ${s.cur}`, w: 130, type: 'money', value: (f) => f.totalX, render: (f) => X(f.totalX) },
          { key: 'paidX', label: `已收 ${s.cur}`, w: 130, type: 'money', value: (f) => f.paidX, render: (f) => X(f.paidX) },
          { key: 'dep', label: `订金还差 ${s.cur}`, w: 140, type: 'money', value: (f) => f.dep, render: (f) => (f.dep ? <b className="red-t2">{X(f.dep)}</b> : X(0)) },
          { key: 'tail', label: `尾款未收 ${s.cur}`, w: 140, type: 'money', value: (f) => f.tail, render: (f) => (f.tail ? <b className="red-t2">{X(f.tail)}</b> : X(0)) },
          { key: 'status', label: '状态', w: 100 }]}
          foot={() => ({ project_no: '合计', totalX: X(fl.reduce((a, f) => a + f.totalX, 0)), paidX: X(fobPaid), dep: X(fobDep), tail: X(fobTail) })} />
      </Detail>}
      <div className="d2-row">
        <DCard small title="收款" sub={label} to={['receipts', '收款']} open={o2 === 'rc'} onFold={() => tg2('rc')} foot={<>{remP.length > 0 && <span>回款 {remP.length} 笔</span>}{remFlag.length > 0 && <button type="button" className="d2-warn" onClick={() => { setRcTab('remit'); if (o2 !== 'rc') tg2('rc'); }}>{remFlag.length} 笔回款要看</button>}</>}>
          <div className="d2-sub c3">
            <Cell label="收到" onClick={() => go('receipts')} sub={`${live.length} 笔 · ${new Set(live.map((r) => r.customer_id)).size} 位客户`}>{X(rcT)}</Cell>
            <Cell label="待核对" unit="笔" tone={pend.length ? 'num-amber' : ''} tip="员工已经录了、中方还没对过凭证的收款。" onClick={() => go('receipts')}>{pend.length}</Cell>
            <Cell label="资金账户" unit="个" onClick={() => { setRcTab('acc'); if (o2 !== 'rc') tg2('rc'); }}>{data.accN}</Cell>
          </div>
        </DCard>
        {fin && <DCard small title={`${held?.length ? [...new Set(held.map((a) => a.holder))].join(' / ') : '公户'} 手里的钱`} sub="收了还没交" gear={<RuleGear ids={['cash.held']} title="压款规则" />} open={o2 === 'held'} onFold={() => tg2('held')}>
          <div className="d2-sub c3">
            <Cell label="压着" tone={heldT > 0 ? 'num-red' : ''} tip="员工用公户 / 私人号收了客户的钱，还没交到公司账户。" onClick={() => go('cash')}>{X(heldT)}</Cell>
            <Cell label="压最久" unit="天" tone={heldLate.length ? 'num-red' : ''} onClick={() => go('cash')}>{heldOld}</Cell>
            <Cell label="没交" unit="笔" onClick={() => go('cash')}>{heldN}</Cell>
          </div>
        </DCard>}
      </div>
      {o2 === 'rc' && <Detail title="收款" right={<Seg value={rcTab} onChange={setRcTab} options={[['list', '明细'], ['acc', '按账户'], ...(fin ? [['remit', '回款国内']] : [])]} />}>
        {rcTab === 'list' && <Grid id="d2-rc" noTools maxHeight={360} rows={live} empty="这段时间没有收款" columns={[
          { key: 'received_on', label: '日期', w: 100, render: (r) => dDate(r.received_on) }, { key: 'customer_name', label: '客户', w: 190, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
          { key: 'amount', label: `金额 ${s.cur}`, w: 130, type: 'money', value: amtX, render: (r) => <b>{X(amtX(r))}</b> }, { key: 'account_name', label: '账户', w: 150 },
          { key: 'verify_status', label: '核对', w: 90, value: (r) => (r.verify_status === 'pending' ? '待核对' : '已核对'), render: (r) => (r.verify_status === 'pending' ? <span className="pill amber">待核对</span> : <span className="pill green">已核对</span>) },
          { key: 'rcv_no', label: '收款单号', w: 140 }]} foot={() => ({ received_on: '合计', amount: X(rcT) })} />}
        {rcTab === 'acc' && <Grid id="d2-rca" noTools rows={byAcc} empty="这段时间没有收款" columns={[
          { key: 'name', label: '账户', w: 220 }, { key: 'share', label: '占比', w: 140, sortable: false, value: (r) => (rcT ? r.v / rcT * 100 : 0), render: (r) => <Share p={rcT ? r.v / rcT * 100 : 0} /> },
          { key: 'v', label: `收到 ${s.cur}`, w: 140, type: 'money', value: (r) => r.v, render: (r) => X(r.v) }, { key: 'n', label: '笔', w: 70, type: 'number' },
          { key: 'p', label: '待核对 笔', w: 100, type: 'number', render: (r) => (r.p ? <span className="pill amber">{r.p}</span> : 0) }]} foot={() => ({ name: '合计', v: X(rcT), n: live.length, p: pend.length })} />}
        {rcTab === 'remit' && <Grid id="d2-remit" noTools maxHeight={340} rows={remP} empty="这段时间没有回款记录" columns={remitCols(rules)} />}
      </Detail>}
      {o2 === 'held' && <Detail title="手里的钱 · 每一笔">
        <Grid id="d2-held" noTools maxHeight={340} rows={(held || []).flatMap((a) => a.owing.map((r) => ({ ...r, acc: a.name, holder: a.holder })))} empty="公户里没有没交的钱 ✓" columns={[
          { key: 'on_date', label: '收到日期', w: 100, render: (r) => dDate(r.on_date) }, { key: 'holder', label: '谁手里', w: 100 }, { key: 'acc', label: '账户', w: 160 }, { key: 'customer', label: '客户', w: 180, value: (r) => r.customer || r.payer || '' },
          { key: 'amount', label: '收了 XOF', w: 120, type: 'money', value: (r) => N(r.amount), render: (r) => money(r.amount) }, { key: 'paid', label: '已交 XOF', w: 120, type: 'money', render: (r) => money(r.paid) },
          { key: 'left', label: '还欠 XOF', w: 120, type: 'money', render: (r) => <b className="red-t2">{money(r.left)}</b> },
          { key: 'd', label: '压了 天', w: 80, type: 'number', value: (r) => Math.floor((Date.now() - new Date(r.on_date).getTime()) / 864e5) }]} />
      </Detail>}
    </div>);
}

// ───────────────────────── 人员 ─────────────────────────
export function PeopleSec({ all, from, to, label, cards, cmp, onAlert }) {
  const { org, role, go, tick } = useApp(); const { lowPct } = useMarginRules();
  const admin = role === 'admin';
  const s = useSec('staff', 'XOF'); const rv = useRuleValues(DASH_RULES);
  const [o0, tg0] = useSlot('p0'); const [o1, tg1] = useSlot('p1'); const [o2, tg2] = useSlot('p2');
  const silentDays = ruleNum(rv, 'dash.silent'), perDay = ruleNum(rv, 'dash.visit'), pickT = ruleNum(rv, 'dash.pick');
  const td = today();
  const { data } = useData(async () => {
    const lead = ['admin', 'manager', 'sales_manager', 'finance'].includes(role);
    const [emps, ins, visits, calls, an, owners, custs] = await Promise.all([
      q(`select id, coalesce(short_name, full_name) as short_name, work_schedule from app.employees where org_id = $1 and active and coalesce(emp_no, '') <> '' and (joined_on is null or joined_on <= current_date)`, [org]),
      q(`select distinct on (employee_id) employee_id, late, at from app.attendance where org_id = $1 and kind = 'in' and (at at time zone 'Africa/Abidjan')::date = (now() at time zone 'Africa/Abidjan')::date order by employee_id, at`, [org]),
      q(`select (v.at at time zone 'Africa/Abidjan')::date as day, v.customer_id, v.employee_id, v.result, coalesce(e.short_name, e.full_name, '没填') as emp, coalesce(c.city, '') as city
         from app.visits v join app.customers c on c.id = v.customer_id left join app.employees e on e.id = v.employee_id
         where v.org_id = $1 and v.at >= $2::date and v.at < $3::date + 1`, [org, from, to]),
      q(`select h.result, h.staff_employee_id as employee_id, coalesce(e.short_name, e.full_name, '没填') as emp
         from app.hotline_calls h left join app.employees e on e.id = h.staff_employee_id
         where h.org_id = $1 and h.channel = 'call' and h.at >= $2::date and h.at < $3::date + 1`, [org, from, to]),
      lead ? call(role, `select * from app.attendance_anomalies($1,$2,$3)`, [org, from, to]).catch(() => []) : [],
      q(`select d.id, d.owner_employee_id as emp_id, coalesce(e.short_name, e.full_name) as emp from app.deals d left join app.employees e on e.id = d.owner_employee_id where d.org_id = $1`, [org]),
      q(`select c.id, c.owner_employee_id as emp_id, coalesce(e.short_name, e.full_name) as emp from app.customers c left join app.employees e on e.id = c.owner_employee_id where c.org_id = $1 and c.status = 'active'`, [org])]);
    return { emps, ins, visits, calls, an, owners: new Map(owners.map((o) => [o.id, o])), custs, lead };
  }, [org, role, from, to, tick]);
  const m = useMemo(() => ({ target: s.cur }), [s.cur]);
  const rank = useMemo(() => {
    if (!admin || !data || !all) return [];
    const custOwner = new Map(data.custs.map((c) => [c.id, c]));
    const by = new Map();
    for (const r of all) { const d = ymd(r.shipped_on); if (d < from || d > to) continue; const o = (r.deal_id && data.owners.get(r.deal_id)) || custOwner.get(r.customer_id) || {}; const k = o.emp_id || '-'; if (!by.has(k)) by.set(k, { id: k, emp_id: o.emp_id, emp: o.emp || '没有归属', rows: [] }); by.get(k).rows.push(r); }
    const silentBy = {}; const custN = {};
    for (const c of data.custs) { if (!c.emp_id) continue; custN[c.emp_id] = (custN[c.emp_id] || 0) + 1; }
    for (const c of cmp || []) { const o = custOwner.get(c.id); if (o?.emp_id && c.last_at && daysBetween(ymd(c.last_at), td) > silentDays) silentBy[o.emp_id] = (silentBy[o.emp_id] || 0) + 1; }
    return [...by.values()].map((x) => ({ ...x, t: total(x.rows, m), custs: custN[x.emp_id] || 0, silent: silentBy[x.emp_id] || 0 })).sort((a, b) => b.t.rev - a.t.rev);
  }, [admin, data, all, from, to, m, cmp, silentDays, td]);
  const silentAll = useMemo(() => (cmp || []).filter((c) => c.last_at && daysBetween(ymd(c.last_at), td) > silentDays), [cmp, silentDays, td]);
  useEffect(() => {
    if (!data) return; const wd = new Date().getDay();
    const due = data.emps.filter((e) => ((e.work_schedule || {})[wd] ?? (wd === 0 ? 'off' : 'full')) !== 'off'); const inS = new Set(data.ins.map((x) => x.employee_id));
    const miss = due.filter((e) => !inS.has(e.id));
    onAlert?.('people', miss.length ? [{ tone: 'red', text: miss.length <= 2 ? `${miss.map((e) => e.short_name).join('、')} 今天没打卡` : `${miss.length} 人今天没打卡`, go: 'attendance' }] : []);
  }, [data]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const wd = new Date().getDay();
  const due = data.emps.filter((e) => ((e.work_schedule || {})[wd] ?? (wd === 0 ? 'off' : 'full')) !== 'off');
  const inMap = new Map(data.ins.map((x) => [x.employee_id, x])); const missing = due.filter((e) => !inMap.has(e.id)); const late = due.filter((e) => inMap.get(e.id)?.late);
  const anN = (a) => N(a.late) + N(a.missing) + N(a.early); const bad = data.an.filter((a) => anN(a) >= 3).sort((a, b) => anN(b) - anN(a));
  const attRows = due.map((e) => { const x = inMap.get(e.id); return { id: e.id, name: e.short_name, st: !x ? '没打卡' : x.late ? '迟到' : '到岗', at: x?.at }; }).sort((a, b) => ['没打卡', '迟到', '到岗'].indexOf(a.st) - ['没打卡', '迟到', '到岗'].indexOf(b.st));
  // 热线
  const okR = (c) => !['no_answer', 'busy'].includes(c.result); const cOk = data.calls.filter(okR).length; const pick = data.calls.length ? cOk / data.calls.length * 100 : null;
  const cBy = Object.values(data.calls.reduce((a, c) => { (a[c.emp] = a[c.emp] || { id: c.emp, emp: c.emp, employee_id: c.employee_id, ok: 0, fail: 0 })[okR(c) ? 'ok' : 'fail'] += 1; return a; }, {})).sort((a, b) => b.ok + b.fail - a.ok - a.fail);
  // 拜访: 目标 = 每人每天 N 家 × 这段时间到今天为止的工作日 (周一到周六)
  const end = to < td ? to : td; let wdays = 0; for (let d = from; d <= end; d = shiftD(d, 1)) if (new Date(d + 'T00:00:00Z').getUTCDay() !== 0) wdays += 1;
  const reps = [...new Set(data.custs.map((c) => c.emp_id).filter(Boolean))];
  const vKey = (v) => `${ymd(v.day)}|${v.customer_id}`; const vN = new Set(data.visits.map(vKey)).size; const vTarget = reps.length * perDay * wdays; const vr = vTarget ? vN / vTarget * 100 : null;
  const vBy = Object.values(data.visits.reduce((a, v) => { const x = a[v.emp] || (a[v.emp] = { id: v.emp, emp: v.emp, employee_id: v.employee_id, s: new Set(), won: 0, city: new Set() }); x.s.add(vKey(v)); if (['order', 'quote'].includes(v.result)) x.won += 1; if (v.city) x.city.add(v.city); return a; }, {})).map((x) => ({ ...x, n: x.s.size, target: perDay * wdays })).sort((a, b) => b.n - a.n);
  const rT = total(rank.flatMap((x) => x.rows), m); const top = rank.find((x) => x.emp_id);
  return (
    <div className="d2-sec">
      <DCard title="人员" sub="今天到岗 · 打卡只看今天" tog={admin ? <Tog s={s} /> : null} open={o0 === 'att'} onFold={() => tg0('att')} foot={bad.length > 0 ? <button type="button" className="d2-warn" onClick={() => { if (o0 !== 'att') tg0('att'); }}>{label}异常满 3 次 {bad.length} 人</button> : <span>{label}没有人异常满 3 次</span>}>
        <div className="d2-hero">
          <Cell label="到岗" main unit={due.length ? '人' : null} onClick={() => go('attendance')}>{due.length ? `${due.length - missing.length}/${due.length}` : '今天休息'}</Cell>
          <Cell label="迟到" unit="人" tone={late.length ? 'num-amber' : ''} onClick={() => go('attendance')} sub={late.slice(0, 3).map((e) => e.short_name).join(' · ')}>{late.length}</Cell>
          <Cell label="没打卡" unit="人" tone={missing.length ? 'num-red' : ''} onClick={() => go('attendance')} sub={missing.slice(0, 3).map((e) => e.short_name).join(' · ')}>{missing.length}</Cell>
          <Cell label={`${label}异常满 3 次`} unit="人" tone={bad.length ? 'num-red' : ''} tip="迟到 + 没打卡 + 早退加起来满 3 次" onClick={() => { if (o0 !== 'att') tg0('att'); }}>{bad.length}</Cell>
        </div>
      </DCard>
      {o0 === 'att' && <Detail title="打卡">
        <Grid id="d2-att" noTools maxHeight={300} rows={attRows} empty="今天休息" columns={[
          { key: 'name', label: '员工', w: 160, render: (r) => <EmpLink id={r.id} name={r.name} /> },
          { key: 'st', label: '今天', w: 100, render: (r) => <span className={`pill ${r.st === '到岗' ? 'green' : r.st === '迟到' ? 'amber' : 'red'}`}>{r.st}</span> },
          { key: 'at', label: '打卡时间', w: 110, render: (r) => (r.at ? new Date(r.at).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Abidjan', hour: '2-digit', minute: '2-digit' }) : '') }]} />
        {data.lead && bad.length > 0 && <div style={{ marginTop: 10 }}><Grid id="d2-att2" noTools maxHeight={260} rows={bad.map((a) => ({ ...a, id: a.employee_id, n: anN(a) }))} columns={[
          { key: 'emp_no', label: '工号', w: 80 }, { key: 'short_name', label: '员工', w: 160, render: (a) => <EmpLink id={a.employee_id} name={a.short_name} /> },
          { key: 'late', label: '迟到 次', w: 90, type: 'number' }, { key: 'missing', label: '没打卡 次', w: 100, type: 'number' }, { key: 'early', label: '早退 次', w: 90, type: 'number' },
          { key: 'n', label: `${label}合计 次`, w: 110, type: 'number', render: (a) => <span className="pill red">{a.n}</span> }]} /></div>}
      </Detail>}
      {admin && <><div className="d2-row one">
        <DCard small title="销售员" sub={`${label} · 按出库时的归属`} gear={<RuleGear ids={['dash.silent']} title="沉默客户" />} open={o1 === 'rank'} onFold={() => tg1('rank')} foot={<span>{rank.filter((x) => x.emp_id).length} 位销售员 · 名下客户 {rank.reduce((a, x) => a + x.custs, 0)} 家</span>}>
          <div className="d2-sub">
            <Cell label="出库" onClick={() => { if (o1 !== 'rank') tg1('rank'); }}>{s.f(rT.rev)}</Cell>
            <Cell label="毛利率" block={pctTone(rT.pct, lowPct)} onClick={() => { if (o1 !== 'rank') tg1('rank'); }}>{rT.pct == null ? '—' : `${rT.pct.toFixed(1)}%`}</Cell>
            <Cell label="第一名" onClick={() => top?.emp_id && go('staff/' + top.emp_id)} sub={top ? s.f(top.t.rev) : ''}>{top?.emp || '—'}</Cell>
            <Cell label="沉默客户" unit="家" tone={silentAll.length ? 'num-red' : ''} tip={`超过 ${silentDays} 天没下单的客户，按客户现在归属的销售员算。`} onClick={() => { if (o1 !== 'rank') tg1('rank'); }}>{silentAll.length}</Cell>
          </div>
        </DCard></div>
      {o1 === 'rank' && <Detail title="销售员排名 · 从大到小">
        <Grid id="d2-rank" noTools maxHeight={420} rows={rank} empty="这个时间段还没有出库" columns={[
          { key: 'emp', label: '销售员', w: 150, render: (r) => (r.emp_id ? <EmpLink id={r.emp_id} name={r.emp} /> : <span className="muted">{r.emp}</span>) },
          { key: 'share', label: '占比', w: 150, sortable: false, value: (r) => (rT.rev ? r.t.rev / rT.rev * 100 : 0), render: (r) => <Share p={rT.rev ? r.t.rev / rT.rev * 100 : 0} /> },
          { key: 'rev', label: `出库 ${s.cur}`, w: 140, type: 'money', value: (r) => r.t.rev, render: (r) => <b>{s.f(r.t.rev)}</b> },
          { key: 'qty', label: '销量 片', w: 100, type: 'number', value: (r) => r.t.qty, render: (r) => qty(r.t.qty) },
          { key: 'profit', label: `利润 ${s.cur}`, w: 130, type: 'money', value: (r) => r.t.profit, render: (r) => s.f(r.t.profit) },
          { key: 'pct', label: '毛利率', w: 90, type: 'number', value: (r) => r.t.pct, render: (r) => <Pct p={r.t.pct} low={lowPct} /> },
          { key: 'custs', label: '客户 家', w: 90, type: 'number' },
          { key: 'silent', label: '沉默 家', w: 90, type: 'number', render: (r) => (r.silent ? <span className="pill red">{r.silent}</span> : 0) }]}
          foot={() => ({ emp: '合计', rev: s.f(rT.rev), qty: qty(rT.qty), profit: s.f(rT.profit), pct: rT.pct == null ? '—' : `${rT.pct.toFixed(1)}%` })} />
      </Detail>}</>}
      <div className="d2-row">
        <DCard small title="热线" sub={label} gear={<RuleGear ids={['dash.pick']} title="热线目标" />} open={o2 === 'hot'} onFold={() => tg2('hot')} foot={<span>拨了 {data.calls.length} 个 · 拨通 {cOk} 个</span>}>
          <div className="d2-sub">
            <Cell label="拨通率" block={pick == null ? '' : pick < pickT * 0.75 ? 'red' : pick < pickT ? 'amber' : 'green'} tip={`拨通的电话 ÷ 拨出的电话。目标 ${pickT}%。`} onClick={() => go('hotline')} sub={<span className="d2-tgt">目标 {pickT}%</span>}>{pick == null ? '—' : `${pick.toFixed(0)}%`}</Cell>
            <Cell label="拨了" unit="个" onClick={() => go('hotline')}>{data.calls.length}</Cell>
            <Cell label="过期没回访" unit="位" tone={N(cards?.follow_late) ? 'num-red' : ''} tip="约好了回访日期、日期过了还没回访的客户" onClick={() => go('hotline')}>{N(cards?.follow_late)}</Cell>
            <Cell label="今天要回访" unit="位" onClick={() => go('hotline')}>{N(cards?.follow_today)}</Cell>
          </div>
        </DCard>
        <DCard small title="拜访" sub={label} gear={<RuleGear ids={['dash.visit']} title="拜访目标" />} open={o2 === 'visit'} onFold={() => tg2('visit')} foot={<span>{reps.length} 位销售员 × 每天 {perDay} 家 × {wdays} 个工作日</span>}>
          <div className="d2-sub">
            <Cell label="拜访" unit="家" tone={vr != null && vr < 100 ? 'num-red' : ''} onClick={() => go('visits')} sub={<span className="d2-tgt">目标 {vTarget} 家</span>}>{vN}</Cell>
            <Cell label="达成" block={vr == null ? '' : vr < 80 ? 'red' : vr < 100 ? 'amber' : 'green'} tip={`拜访家数 ÷ 目标（每个销售员每天 ${perDay} 家 × 工作日）。`} onClick={() => go('visits')}>{vr == null ? '—' : `${vr.toFixed(0)}%`}</Cell>
            <Cell label="下单 / 报价" unit="次" tip="拜访时当场下单或要了报价的次数" onClick={() => go('visits')}>{data.visits.filter((v) => ['order', 'quote'].includes(v.result)).length}</Cell>
            <Cell label="城市" unit="个" onClick={() => go('visits')}>{new Set(data.visits.map((v) => v.city).filter(Boolean)).size}</Cell>
          </div>
        </DCard>
      </div>
      {o2 === 'hot' && <Detail title="热线 · 按人"><Grid id="d2-hot" noTools maxHeight={300} rows={cBy} empty="这段时间没有电话记录" columns={[
        { key: 'emp', label: '热线', w: 160, render: (r) => (r.employee_id ? <EmpLink id={r.employee_id} name={r.emp} /> : r.emp) },
        { key: 'ok', label: '拨通 个', w: 100, type: 'number', render: (r) => <span className="pill green">{r.ok}</span> }, { key: 'fail', label: '没拨通 个', w: 100, type: 'number', render: (r) => (r.fail ? <span className="pill red">{r.fail}</span> : 0) },
        { key: 'rate', label: '拨通率', w: 100, type: 'number', value: (r) => r.ok / (r.ok + r.fail) * 100, render: (r) => { const p = r.ok / (r.ok + r.fail) * 100; return <span className={`pill ${p < pickT * 0.75 ? 'red' : p < pickT ? 'amber' : 'green'}`}>{p.toFixed(0)}%</span>; } },
        { key: 't', label: '合计 个', w: 90, type: 'number', value: (r) => r.ok + r.fail }]} foot={() => ({ emp: '合计', ok: cOk, fail: data.calls.length - cOk, t: data.calls.length })} /></Detail>}
      {o2 === 'visit' && <Detail title={`拜访 · 按人（目标每人每天 ${perDay} 家）`}><Grid id="d2-visit" noTools maxHeight={300} rows={vBy} empty="这段时间没有拜访记录" columns={[
        { key: 'emp', label: '销售员', w: 160, render: (r) => (r.employee_id ? <EmpLink id={r.employee_id} name={r.emp} /> : r.emp) },
        { key: 'n', label: '拜访 家', w: 100, type: 'number', render: (r) => <span className={r.n < r.target ? 'red-t2' : ''}>{r.n}</span> }, { key: 'target', label: '目标 家', w: 100, type: 'number' },
        { key: 'rate', label: '达成', w: 100, type: 'number', value: (r) => (r.target ? r.n / r.target * 100 : 0), render: (r) => { const p = r.target ? r.n / r.target * 100 : 0; return <span className={`pill ${p < 80 ? 'red' : p < 100 ? 'amber' : 'green'}`}>{p.toFixed(0)}%</span>; } },
        { key: 'won', label: '下单 / 要报价 次', w: 140, type: 'number' }, { key: 'city', label: '城市', w: 200, value: (r) => [...r.city].join('、') }]}
        foot={() => ({ emp: '合计', n: vN, target: vTarget })} /></Detail>}
    </div>);
}

// 全页一行「要你注意的」: 只写异常, 没有就不显示
export function Attention({ alerts }) {
  const { go } = useApp();
  const list = ['ops', 'sale', 'stock', 'acct', 'people'].flatMap((k) => alerts[k] || []).sort((a, b) => (a.tone === 'red' ? 0 : 1) - (b.tone === 'red' ? 0 : 1)).slice(0, 6);
  if (!list.length) return null;
  return <div className="d2-attn"><b>要你注意的</b>{list.map((a, i) => <button type="button" key={i} className={`pill ${a.tone}`} onClick={() => go(a.go)}>{a.text}</button>)}</div>;
}
