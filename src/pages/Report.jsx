// 月报 (Frank 11-25: 不要在经营总览上放大按钮; 单独一页, 所有数据捞进来, 给老板一眼看明白)
// 口径照他自己的月报: 金额人民币「万元」截掉零头; 报告月取整月; XOF 按这个月定的汇率折 (默认 0.011, 每月存一次); 超期 = 超 21 天, 严重超期 = 超 120 天; 库龄 7 段
// 顺序 = 老板读报告的顺序: 一句话结论 → 8 个关键数 → 销售 (达成 / 结构 / 客户 / 销售员) → 毛利与净利 → 回款与应收 → 库存 (库龄 / 周转 / 在途 / 滞销) → 运营 → 走势 → 文字版
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, MonthPicker, MoneyIn, Assumed, Info } from '../components/ui.jsx';
import { RuleGear, useRuleValues, ruleNum } from '../components/Rules.jsx';
import { Spark, weekly } from '../components/MonthReport.jsx';
import { useDashAll } from '../components/DashBlocks.jsx';
import { useMarginRules } from '../components/Margin.jsx';
import { qty, today, friendlyError } from '../lib/format.js';
import { PAY_METHODS } from '../lib/domain.js';

const N = (v) => Number(v || 0);
const ymd = (v) => { if (!v) return ''; const x = v instanceof Date ? v : new Date(v); return isNaN(x) ? String(v).slice(0, 10) : x.toISOString().slice(0, 10); };
const wan = (cny) => Math.trunc(cny / 10000);
const wan1 = (cny) => (Math.trunc(cny / 1000) / 10).toFixed(1);
const pct = (a, b) => (b ? Math.floor((a / b) * 1000) / 10 : null);
const SEGS = [[0, 30], [31, 60], [61, 90], [91, 120], [121, 150], [151, 180], [181, 99999]];
const segName = ([a, b]) => (b > 9999 ? '180 天以上' : `${a}–${b} 天`);
const isScreen = (c) => /屏幕/.test(c || '') && !/显示屏/.test(c || '');
const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const addMonth = (m, k) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + k, 1)).toISOString().slice(0, 7); };
const TIER = { S: 'S', WHOLESALE: 'Wholesale', RETAIL: 'Retail', REPAIR: 'Repair' };
const Chg = ({ cur, base, label }) => { if (base == null || !base) return null; const d = Math.round(((cur - base) / Math.abs(base)) * 100); return <span className={`rp-chg ${d >= 0 ? 'up' : 'down'}`}>{label} {d >= 0 ? '▲' : '▼'}{Math.abs(d)}%</span>; };
const Pc = ({ p, lo = 15, hi = 25 }) => (p == null ? <span className="muted">—</span> : <span className={`pill ${p < lo ? 'red' : p < hi ? 'amber' : 'green'}`}>{p.toFixed(1)}%</span>);

function Bars({ data, fmt, h = 140 }) {
  const W = 560, P = 22; const mx = Math.max(1, ...data.map((d) => Math.max(d.a, d.b || 0)));
  const bw = (W - 2 * P) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="rp-spark" role="img">
      {data.map((d, i) => { const x = P + i * bw; const ha = ((h - 2 * P) * d.a) / mx; const hb = ((h - 2 * P) * (d.b || 0)) / mx; return (
        <g key={i}><rect x={x + bw * 0.15} y={h - P - ha} width={bw * 0.35} height={ha} fill="var(--brand)" rx="2" />
          {d.b != null && <rect x={x + bw * 0.52} y={h - P - hb} width={bw * 0.3} height={hb} fill="#16a34a" rx="2" />}
          <text x={x + bw * 0.32} y={h - P - ha - 4} textAnchor="middle" fontSize="10" fill="#334155">{fmt(d.a)}</text>
          <text x={x + bw / 2} y={h - 6} textAnchor="middle" fontSize="10" fill="#94a3b8">{d.k}</text></g>); })}
    </svg>);
}

export default function Report() {
  const { org, role, toast, refresh, tick } = useApp();
  const td = today();
  const [month, setMonth] = useState(() => { const d = new Date(td + 'T00:00:00Z'); d.setUTCDate(0); return Number(td.slice(8)) <= 20 ? d.toISOString().slice(0, 7) : td.slice(0, 7); });
  const all = useDashAll();
  const rv = useRuleValues(['dash.budget']); const { lowPct } = useMarginRules();
  const a = `${month}-01`, b = lastDay(month);
  const { data } = useData(async () => {
    const [lay, tr, snap, ar, rates, rcpt, exps, pay, custs, rets, dirs, deals, pend, prods] = await Promise.all([
      call(role, `select * from app.dash_stock_layers($1)`, [org]), call(role, `select * from app.dash_transit($1)`, [org]),
      q(`select day::text as day, key, value from app.dash_snapshots where org_id = $1 and key in ('stock_cost', 'q120_cost', 'ar') order by day`, [org]),
      q(`select d.customer_id, c.name, coalesce(sum(d.due), 0) as due, max(current_date - d.first_shipped_at::date) as age, coalesce(c.credit_days, 30) as credit
         from app.v_deal_due d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.currency = 'XOF' and d.due > 0 group by 1, 2, c.credit_days`, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'report_rates'`, [org]),
      q(`select r.method::text as method, r.currency, sum(r.amount) as amount, count(*) as n from app.receipts r where r.org_id = $1 and r.received_on between $2::date and $3::date and r.voided_at is null group by 1, 2`, [org, a, b]),
      q(`select coalesce(m.category, '没选科目') as category, a.currency, sum(m.amount) as amount from app.cash_moves m join app.cash_accounts a on a.id = m.account_id
         where m.org_id = $1 and m.kind = 'expense' and m.status in ('approved', 'confirmed') and m.on_date between $2::date and $3::date
           and not (coalesce(m.category, '') = '本地物流费' and coalesce(m.note, '') like '运费 %') and m.receipt_id is null and coalesce(m.category, '') not like '%退款%' group by 1, 2`, [org, a, b]).catch(() => []),
      q(`select coalesce(sum(coalesce(p.net, 0) + coalesce(p.cnps, 0)), 0) as v, count(*) as n from app.payroll p where p.org_id = $1 and p.month = $2::date`, [org, a]).catch(() => [{ v: 0, n: 0 }]),
      q(`select c.id, c.name, c.created_at, e.short_name as owner from app.customers c left join app.employees e on e.id = c.owner_employee_id where c.org_id = $1`, [org]).catch(() => q(`select id, name, created_at, null as owner from app.customers where org_id = $1`, [org])),
      q(`select count(*) as n, coalesce(sum(amount), 0) as amount from app.returns where org_id = $1 and requested_at::date between $2::date and $3::date`, [org, a, b]),
      q(`select count(*) filter (where status in ('done', 'closed')) as done, count(*) filter (where status in ('done', 'closed') and (due_on is null or done_at::date <= due_on)) as ontime, count(*) as n
         from app.directives where org_id = $1 and not is_template and created_at::date between $2::date and $3::date`, [org, a, b]).catch(() => [{}]),
      q(`select count(*) as n, avg(extract(epoch from (s.first_ship - d.created_at)) / 86400) as days from app.deals d
         join lateral (select min(x.created_at) as first_ship from app.shipments x where x.deal_id = d.id and x.voided_at is null) s on true
         where d.org_id = $1 and s.first_ship::date between $2::date and $3::date`, [org, a, b]).catch(() => [{}]),
      q(`select coalesce(sum(l.offer_qty), 0) as n from app.purchase_request_lines l join app.purchase_requests r on r.id = l.request_id where r.org_id = $1 and l.offer_qty is not null and r.status not in ('closed', 'cancelled', 'done')`, [org]).catch(() => [{ n: null }]),
      q(`select id, model from app.products where org_id = $1`, [org]),
    ]);
    return { lay, tr, snap, ar, rates: rates[0]?.value || {}, rcpt, exps, pay: pay[0], custs, rets: rets[0], dirs: dirs[0] || {}, deals: deals[0] || {}, pendN: pend[0]?.n, model: Object.fromEntries(prods.map((p) => [p.id, p.model])) };
  }, [org, role, tick, a, b]);
  const [rateIn, setRateIn] = useState(null);
  const rate = N(rateIn ?? data?.rates?.[month] ?? 0.011);
  const saveRate = async () => { try { await call(role, `select app.set_org_setting($1,'report_rates',$2)`, [org, JSON.stringify({ ...(data?.rates || {}), [month]: rate })]); toast(`${month} 的汇率记下了：1 XOF = ${rate} CNY`); setRateIn(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const budget = ruleNum(rv, 'dash.budget'); const mLo = lowPct; const mHi = lowPct + 10;

  const R = useMemo(() => {
    if (!data || !all) return null;
    const c = (xof) => xof * rate;
    const pick = (x, y) => all.filter((r) => { const d = ymd(r.shipped_on); return d >= x && d <= y; });
    const agg = (rows) => { const t = { q: 0, v: 0, cost: 0, pf: 0, miss: 0, loc: { q: 0, v: 0, pf: 0 }, fob: { q: 0, v: 0, pf: 0 }, deals: new Set(), cus: new Set(), loss: 0, lossV: 0 };
      for (const r of rows) { const k = r.supply === 'fob' ? 'fob' : 'loc'; const v = c(N(r.revenue)); const pf = c(N(r.profit));
        t.q += N(r.qty); t.v += v; t[k].q += N(r.qty); t[k].v += v; if (r.cost_missing) t.miss += N(r.qty); else { t.pf += pf; t[k].pf += pf; t.cost += c(N(r.cost)); if (N(r.profit) < 0) { t.loss += 1; t.lossV += -pf; } }
        t.deals.add(r.deal_id); t.cus.add(r.customer_id); }
      return t; };
    const cur = agg(pick(a, b)); const prev = agg(pick(`${addMonth(month, -1)}-01`, lastDay(addMonth(month, -1))));
    const avg3 = [1, 2, 3].map((k) => agg(pick(`${addMonth(month, -k)}-01`, lastDay(addMonth(month, -k))))); const av = (f) => (avg3.some((x) => f(x)) ? avg3.reduce((s, x) => s + f(x), 0) / 3 : null);
    const rows = pick(a, b);
    const groupBy = (key) => { const by = {}; for (const r of rows) { const k = key(r) || '其他'; const x = (by[k] ||= { k, q: 0, v: 0, pf: 0, cost: 0 }); x.q += N(r.qty); x.v += c(N(r.revenue)); if (!r.cost_missing) { x.pf += c(N(r.profit)); x.cost += c(N(r.cost)); } } return Object.values(by).sort((p1, p2) => p2.v - p1.v); };
    const byCat = groupBy((r) => r.category); const byTier = groupBy((r) => TIER[r.tier] || r.tier);
    const owner = Object.fromEntries((data.custs || []).map((x) => [x.id, x.owner]));
    const bySales = groupBy((r) => owner[r.customer_id] || '没归属');
    const prevCus = {}; for (const r of pick(`${addMonth(month, -1)}-01`, lastDay(addMonth(month, -1)))) prevCus[r.customer_id] = (prevCus[r.customer_id] || 0) + c(N(r.revenue));
    const byCus = groupBy((r) => r.customer_id).map((x) => ({ ...x, name: rows.find((r) => r.customer_id === x.k)?.customer_name, prev: prevCus[x.k] || 0 }));
    const newCus = (data.custs || []).filter((x) => ymd(x.created_at) >= a && ymd(x.created_at) <= b).length;
    const lost = Object.keys(prevCus).filter((k) => !cur.cus.has(k)).length;
    const ld = Number(b.slice(8)); const cut = td < b ? td : b;
    const weeks = [[1, 8], [9, 15], [16, 22], [23, ld]].map(([x, y], i) => { const wa = `${month}-${String(x).padStart(2, '0')}`, wb = `${month}-${String(y).padStart(2, '0')}`; return { i: i + 1, x, y, started: wa <= cut, w: agg(pick(wa, wb)).v, acc: agg(pick(a, wb < cut ? wb : cut)).v }; });
    // 毛利 → 净利
    const expBy = {}; for (const e of data.exps || []) { const xof = e.currency === 'XOF' ? N(e.amount) : e.currency === 'CNY' ? N(e.amount) / rate : N(e.amount) * 600; expBy[e.category] = (expBy[e.category] || 0) + c(xof); }
    const hasPay = N(data.pay?.n) > 0; const payV = c(N(data.pay?.v));
    const expList = Object.entries(expBy).filter(([k]) => !(hasPay && /工资|薪|salaire|CNPS|社保/i.test(k))).map(([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v);
    if (hasPay) expList.unshift({ k: '工资（工资表，公司成本）', v: payV });
    const expT = expList.reduce((s, e) => s + e.v, 0);
    // 回款与应收
    const rc = { by: {}, t: 0 }; for (const x of data.rcpt || []) { const xof = x.currency === 'XOF' ? N(x.amount) : x.currency === 'CNY' ? N(x.amount) / rate : N(x.amount) * 600; const v = c(xof); rc.by[x.method] = (rc.by[x.method] || 0) + v; rc.t += v; }
    const arRows = (data.ar || []).map((x) => ({ ...x, v: c(N(x.due)), over: N(x.age) > N(x.credit) }));
    const arT = arRows.reduce((s, x) => s + x.v, 0); const arOver = arRows.filter((x) => x.over).reduce((s, x) => s + x.v, 0);
    const arSeg = [[0, 30], [31, 60], [61, 99999]].map(([lo, hi]) => arRows.filter((x) => N(x.age) >= lo && N(x.age) <= hi).reduce((s, x) => s + x.v, 0));
    // 库存
    const seg = (ls) => SEGS.map(([lo, hi]) => { let n = 0, v = 0; for (const l of ls) { const age = l.age_days == null ? 99999 : N(l.age_days); if (age >= lo && age <= hi) { n += N(l.qty); v += c(N(l.qty) * N(l.unit_cost)); } } return { n, v }; });
    const local = data.lay.filter((l) => l.wh_kind === 'local' || l.wh_kind === 'fob' || !l.wh_kind);
    const scr = local.filter((l) => isScreen(l.category));
    const tot = (ls) => ls.reduce((t, l) => ({ n: t.n + N(l.qty), v: t.v + c(N(l.qty) * N(l.unit_cost)) }), { n: 0, v: 0 });
    const over = (ls, d) => tot(ls.filter((l) => l.age_days == null || N(l.age_days) > d));
    const stockT = tot(local); const o120 = over(local, 120); const o21 = over(local, 21);
    const tr = { sea: { n: 0, v: 0 }, air: { n: 0, v: 0 } }; for (const p of data.tr) { const k = p.mode === 'air' ? 'air' : 'sea'; tr[k].n += N(p.pcs); tr[k].v += c(N(p.cost_xof)); }
    const cogs3 = av((x) => x.cost); const cover = cogs3 ? stockT.v / cogs3 : null;
    const slowBy = {}; for (const l of local.filter((x) => x.age_days == null || N(x.age_days) > 120)) { const x = (slowBy[l.product_id] ||= { id: l.product_id, cat: l.category, n: 0, v: 0, age: 0 }); x.n += N(l.qty); x.v += c(N(l.qty) * N(l.unit_cost)); x.age = Math.max(x.age, l.age_days == null ? 999 : N(l.age_days)); }
    const slow = Object.values(slowBy).sort((x, y) => y.v - x.v).slice(0, 10);
    const series = (k) => data.snap.filter((x) => x.key === k).map((x) => [x.day, c(N(x.value))]);
    const monthEnd = (k) => { const p = data.snap.filter((x) => x.key === k && x.day < a); return p.length ? c(N(p[p.length - 1].value)) : null; };
    const trend = [5, 4, 3, 2, 1, 0].map((k) => { const m = addMonth(month, -k); const t = agg(pick(`${m}-01`, lastDay(m))); return { k: m.slice(2).replace('-', '/'), a: t.v, b: t.pf }; });
    return { cur, prev, av, byCat, byTier, bySales, byCus, newCus, lost, weeks, expList, expT, rc, arRows, arT, arOver, arSeg, stockT, scrT: tot(scr), segAll: seg(local), segScr: seg(scr), o120, o21, o120s: over(scr, 120), tr, cover, slow, trend,
      stockPrev: monthEnd('stock_cost'), stockLine: weekly(series('stock_cost')), oldLine: weekly(series('q120_cost')) };
  }, [data, all, month, rate, a, b, td]);

  const mg = R ? pct(R.cur.pf, R.cur.v) : null;
  const net = R ? R.cur.pf - R.expT : 0;
  const ach = R && budget > 0 ? pct(R.cur.v, budget) : null;
  const points = !R ? [] : [
    `销售 ${wan(R.cur.v)} 万${ach != null ? `，预算达成 ${ach}%` : ''}${R.av((x) => x.v) ? `，比近 3 个月平均${R.cur.v >= R.av((x) => x.v) ? '多' : '少'} ${Math.abs(Math.round(((R.cur.v - R.av((x) => x.v)) / R.av((x) => x.v)) * 100))}%` : ''}（本地 ${wan(R.cur.loc.v)} 万 / FOB ${wan(R.cur.fob.v)} 万）`,
    `毛利 ${wan(R.cur.pf)} 万，毛利率 ${mg != null ? mg + '%' : '—'}；扣掉开支 ${wan(R.expT)} 万，净利 ${wan(net)} 万${R.cur.loss ? `；有 ${R.cur.loss} 行卖亏了（亏 ${wan1(R.cur.lossV)} 万）` : ''}`,
    `回款 ${wan(R.rc.t)} 万；应收 ${wan(R.arT)} 万，其中超账期 ${wan(R.arOver)} 万`,
    `库存 ${wan(R.stockT.v)} 万${R.stockPrev != null ? `（上月底 ${wan(R.stockPrev)} 万）` : ''}，够卖 ${R.cover ? R.cover.toFixed(1) : '—'} 个月；超 120 天 ${wan(R.o120.v)} 万（占 ${pct(R.o120.v, R.stockT.v) ?? 0}%）；在途 ${wan(R.tr.sea.v + R.tr.air.v)} 万`,
    `成交客户 ${R.cur.cus.size} 家（新客户 ${R.newCus}，上月买了这月没买 ${R.lost}），订单 ${R.cur.deals.size} 张`,
  ];
  const text = () => R ? [`【${month} 经营月报】汇率 1 XOF = ${rate} CNY，金额万元人民币（零头截掉）`, ...points.map((p, i) => `${'一二三四五六'[i]}、${p}`),
    `按周：${R.weeks.filter((w) => w.started).map((w) => `第 ${w.i} 周 ${wan1(w.w)} 万（累计 ${wan1(w.acc)}${budget > 0 ? `，达成 ${pct(w.acc, budget)}%` : ''}）`).join('；')}`,
    `种类：${R.byCat.slice(0, 6).map((x) => `${x.k} ${qty(x.q)} 片 / ${wan1(x.v)} 万`).join('；')}`,
    `前五客户：${R.byCus.slice(0, 5).map((x) => `${x.name} ${wan1(x.v)} 万`).join('；')}`,
    `屏幕库龄：${R.segScr.map((s, i) => `${segName(SEGS[i])} ${qty(s.n)} 片 / ${wan1(s.v)} 万`).join('；')}`].join('\n') : '';
  const copy = async () => { try { await navigator.clipboard.writeText(text()); toast('已复制，可以直接贴进飞书'); } catch { toast('复制不了，在页面最下面手动选中文字', 'err'); } };
  const T = ({ head, rows, foot }) => <table className="rp-t"><thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{rows}</tbody>{foot && <tfoot>{foot}</tfoot>}</table>;

  return (
    <div className="rp-page">
      <div className="pagehead"><div><div className="eyebrow">Rapport mensuel</div><h1>月报 <Info>给老板的月度报告：所有数从系统里现捞，金额按这个月定的汇率折成人民币万元（零头截掉）。打印就是一份完整报告；「复制文字版」可以直接贴进飞书。</Info></h1></div>
        <div className="row rp-acts" style={{ gap: 8, flexWrap: 'wrap' }}>
          <MonthPicker value={month} onChange={(m) => { setMonth(m); setRateIn(null); }} label="报告月份" />
          <label className="row" style={{ gap: 6 }}><span className="small muted" data-tip="这个月的 XOF 折人民币汇率。记下以后这个月一直用它，改别的月不影响">1 XOF =</span>
            <MoneyIn className="in" style={{ width: 84 }} inputMode="decimal" value={String(rateIn ?? data?.rates?.[month] ?? 0.011)} onChange={(e) => setRateIn(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">CNY</span>
            {(rateIn != null || data?.rates?.[month] == null) && <button type="button" className="btn sm" onClick={saveRate}>记下</button>}</label>
          <RuleGear ids={['dash.budget']} title="本月预算" />
          <button type="button" className="btn sm" onClick={copy}>复制文字版</button>
          <button type="button" className="btn sm primary" onClick={() => window.print()}>打印 / 存 PDF</button>
        </div></div>
      {!R ? <div className="card"><div className="empty">加载中…</div></div> : <>
        <div className="card rp-sum"><div className="card-h"><h2>{month} 一句话 <Assumed>超期 = 超 21 天、严重超期 = 超 120 天；按周 = 1–8 / 9–15 / 16–22 / 23–月底；回款按收款日期；净利 = 毛利 − 这个月的开支（工资按工资表公司成本，订单运费已在毛利里扣过）；够卖几个月 = 库存成本 ÷ 近 3 个月月均出库成本。</Assumed></h2></div>
          <ol className="rp-points">{points.map((p, i) => <li key={i}>{p}</li>)}</ol></div>
        <div className="rp-kpis">
          <div><span>销售额</span><b>{wan(R.cur.v)}<small>万</small></b>{ach != null ? <em className={ach < 100 ? 'red-t2' : ''}>预算 {wan(budget)} 万 · 达成 {ach}%</em> : <em>{qty(R.cur.q)} 片</em>}<Chg cur={R.cur.v} base={R.av((x) => x.v)} label="比近3月均" /></div>
          <div><span>毛利</span><b className={R.cur.pf < 0 ? 'red-t2' : ''}>{wan(R.cur.pf)}<small>万</small></b><em>毛利率 <Pc p={mg} lo={mLo} hi={mHi} /></em><Chg cur={R.cur.pf} base={R.prev.pf} label="比上月" /></div>
          <div><span>净利</span><b className={net < 0 ? 'red-t2' : ''}>{wan(net)}<small>万</small></b><em>开支 {wan(R.expT)} 万</em></div>
          <div><span>回款</span><b>{wan(R.rc.t)}<small>万</small></b><em>出库 {wan(R.cur.v)} 万</em></div>
          <div><span>应收</span><b>{wan(R.arT)}<small>万</small></b><em className={R.arOver > 0 ? 'red-t2' : ''}>超账期 {wan(R.arOver)} 万</em></div>
          <div><span>库存</span><b>{wan(R.stockT.v)}<small>万</small></b><em>够卖 {R.cover ? R.cover.toFixed(1) : '—'} 个月</em><Chg cur={R.stockT.v} base={R.stockPrev} label="比上月底" /></div>
          <div><span>超 120 天</span><b className={R.o120.v > 0 ? 'red-t2' : ''}>{wan(R.o120.v)}<small>万</small></b><em>占库存 {pct(R.o120.v, R.stockT.v) ?? 0}%</em></div>
          <div><span>在途</span><b>{wan(R.tr.sea.v + R.tr.air.v)}<small>万</small></b><em>{qty(R.tr.sea.n + R.tr.air.n)} 片</em></div>
        </div>

        <section className="card rp-sec2"><div className="card-h"><h2>一、销售</h2></div><div className="card-b rp-grid">
          <div><h4>业务</h4><T head={['', '数量 片', '金额 万元', '毛利率', '比上月']} rows={[['本地', R.cur.loc, R.prev.loc], ['FOB', R.cur.fob, R.prev.fob]].map(([k, x, p]) => <tr key={k}><th>{k}</th><td>{qty(x.q)}</td><td>{wan1(x.v)}</td><td><Pc p={pct(x.pf, x.v)} lo={mLo} hi={mHi} /></td><td><Chg cur={x.v} base={p.v} label="" /></td></tr>)}
            foot={<tr><th>合计</th><td>{qty(R.cur.q)}</td><td>{wan1(R.cur.v)}</td><td><Pc p={mg} lo={mLo} hi={mHi} /></td><td><Chg cur={R.cur.v} base={R.prev.v} label="" /></td></tr>} /></div>
          <div><h4>按周达成</h4><T head={['', '当周', '月累计', '达成率']} rows={R.weeks.map((w) => <tr key={w.i}><th>第 {w.i} 周（{w.x}–{w.y}）</th>{w.started ? <><td>{wan1(w.w)}</td><td>{wan1(w.acc)}</td><td>{budget > 0 ? `${pct(w.acc, budget)}%` : '—'}</td></> : <td colSpan={3} className="muted">还没到</td>}</tr>)} /></div>
          <div><h4>种类</h4><T head={['', '片', '万元', '占比', '毛利率']} rows={R.byCat.slice(0, 10).map((x) => <tr key={x.k}><th>{x.k}</th><td>{qty(x.q)}</td><td>{wan1(x.v)}</td><td>{pct(x.v, R.cur.v)}%</td><td><Pc p={pct(x.pf, x.v)} lo={mLo} hi={mHi} /></td></tr>)} /></div>
          <div><h4>客户档位</h4><T head={['', '片', '万元', '占比', '毛利率']} rows={R.byTier.map((x) => <tr key={x.k}><th>{x.k}</th><td>{qty(x.q)}</td><td>{wan1(x.v)}</td><td>{pct(x.v, R.cur.v)}%</td><td><Pc p={pct(x.pf, x.v)} lo={mLo} hi={mHi} /></td></tr>)} /></div>
          <div><h4>前十客户 <span className="muted small">成交 {R.cur.cus.size} 家 · 新客户 {R.newCus} · 上月买了这月没买 {R.lost}</span></h4><T head={['', '万元', '占比', '比上月']} rows={R.byCus.slice(0, 10).map((x) => <tr key={x.k}><th>{x.name}</th><td>{wan1(x.v)}</td><td>{pct(x.v, R.cur.v)}%</td><td>{x.prev ? <Chg cur={x.v} base={x.prev} label="" /> : <span className="pill blue">上月没买</span>}</td></tr>)} /></div>
          <div><h4>销售员（按客户归属）</h4><T head={['', '片', '万元', '占比', '毛利率']} rows={R.bySales.map((x) => <tr key={x.k}><th>{x.k}</th><td>{qty(x.q)}</td><td>{wan1(x.v)}</td><td>{pct(x.v, R.cur.v)}%</td><td><Pc p={pct(x.pf, x.v)} lo={mLo} hi={mHi} /></td></tr>)} /></div>
        </div></section>

        <section className="card rp-sec2"><div className="card-h"><h2>二、毛利与净利</h2></div><div className="card-b rp-grid">
          <div><h4>利润表</h4><T head={['', '万元']} rows={<>
            <tr><th>销售额</th><td>{wan1(R.cur.v)}</td></tr><tr><th>销售成本</th><td>{wan1(R.cur.cost)}</td></tr>
            <tr><th>毛利</th><td><b>{wan1(R.cur.pf)}</b>　<Pc p={mg} lo={mLo} hi={mHi} /></td></tr>
            {R.expList.map((e) => <tr key={e.k}><th className="rp-ind">− {e.k}</th><td>{wan1(e.v)}</td></tr>)}
            <tr><th>净利</th><td><b className={net < 0 ? 'red-t2' : ''}>{wan1(net)}</b></td></tr></>} /></div>
          <div><h4>要注意</h4><ul className="rp-warn">
            {R.cur.loss > 0 && <li className="red-t2">{R.cur.loss} 行卖亏了，共亏 {wan1(R.cur.lossV)} 万（订单总览 → 亏损诊断）</li>}
            {R.cur.miss > 0 && <li>{qty(R.cur.miss)} 片没有成本，没算进毛利</li>}
            {mg != null && mg < mLo && <li className="red-t2">毛利率 {mg}% 低于 {mLo}%</li>}
            {!R.cur.loss && !R.cur.miss && (mg == null || mg >= mLo) && <li className="muted">没有卖亏的单，成本都齐</li>}</ul></div>
        </div></section>

        <section className="card rp-sec2"><div className="card-h"><h2>三、回款与应收</h2></div><div className="card-b rp-grid">
          <div><h4>本月收款（按方式）</h4><T head={['', '万元']} rows={Object.entries(R.rc.by).map(([k, v]) => <tr key={k}><th>{PAY_METHODS[k] || k}</th><td>{wan1(v)}</td></tr>)} foot={<tr><th>合计</th><td>{wan1(R.rc.t)}</td></tr>} /></div>
          <div><h4>应收账龄</h4><T head={['', '万元', '占比']} rows={['0–30 天', '31–60 天', '60 天以上'].map((k, i) => <tr key={k}><th>{k}</th><td className={i === 2 && R.arSeg[2] > 0 ? 'red-t2' : ''}>{wan1(R.arSeg[i])}</td><td>{pct(R.arSeg[i], R.arT) ?? 0}%</td></tr>)} foot={<tr><th>合计</th><td>{wan1(R.arT)}</td><td>超账期 {wan1(R.arOver)}</td></tr>} /></div>
          <div><h4>欠款前十</h4><T head={['', '万元', '最老欠了', '']} rows={[...R.arRows].sort((x, y) => y.v - x.v).slice(0, 10).map((x) => <tr key={x.customer_id}><th>{x.name}</th><td>{wan1(x.v)}</td><td>{x.age} 天</td><td>{x.over ? <span className="pill red">超账期</span> : <span className="pill green">账期内</span>}</td></tr>)} /></div>
        </div></section>

        <section className="card rp-sec2"><div className="card-h"><h2>四、库存</h2></div><div className="card-b rp-grid">
          <div><h4>库龄（7 段）</h4><T head={['', '屏幕 片', '屏幕 万元', '全部 片', '全部 万元']} rows={SEGS.map((sg, i) => <tr key={i}><th>{segName(sg)}</th><td>{qty(R.segScr[i].n)}</td><td>{wan1(R.segScr[i].v)}</td><td>{qty(R.segAll[i].n)}</td><td className={i >= 4 && R.segAll[i].v > 0 ? 'red-t2' : ''}>{wan1(R.segAll[i].v)}</td></tr>)}
            foot={<tr><th>合计</th><td>{qty(R.scrT.n)}</td><td>{wan1(R.scrT.v)}</td><td>{qty(R.stockT.n)}</td><td>{wan1(R.stockT.v)}</td></tr>} /></div>
          <div><h4>库存 + 在途</h4><T head={['', '片', '万元']} rows={<>
            <tr><th>现有库存</th><td>{qty(R.stockT.n)}</td><td>{wan1(R.stockT.v)}</td></tr>
            <tr><th>在途 · 海运</th><td>{qty(R.tr.sea.n)}</td><td>{wan1(R.tr.sea.v)}</td></tr><tr><th>在途 · 空运</th><td>{qty(R.tr.air.n)}</td><td>{wan1(R.tr.air.v)}</td></tr>
            {data.pendN != null && <tr><th>国内待发</th><td>{qty(data.pendN)}</td><td /></tr>}
            <tr><th>超期（超 21 天）</th><td>{qty(R.o21.n)}</td><td>{wan1(R.o21.v)}</td></tr>
            <tr><th>严重超期（超 120 天）</th><td>{qty(R.o120.n)}</td><td className="red-t2">{wan1(R.o120.v)}</td></tr>
            <tr><th>其中屏幕</th><td>{qty(R.o120s.n)}</td><td>{wan1(R.o120s.v)}</td></tr></>} /></div>
          <div><h4>滞销前十（超 120 天，按金额）</h4><T head={['', '片', '万元', '最老']} rows={R.slow.map((x) => { return <tr key={x.id}><th>{x.cat} {data.model[x.id] || ''}</th><td>{qty(x.n)}</td><td>{wan1(x.v)}</td><td>{x.age >= 999 ? '没记录' : `${x.age} 天`}</td></tr>; })} /></div>
        </div></section>

        <section className="card rp-sec2"><div className="card-h"><h2>五、运营</h2></div><div className="card-b">
          <div className="rp-kpis sm">
            <div><span>订单</span><b>{R.cur.deals.size}</b><em>张出库</em></div>
            <div><span>询单到出库</span><b>{data.deals?.days != null ? N(data.deals.days).toFixed(1) : '—'}</b><em>天（平均）</em></div>
            <div><span>退货</span><b>{N(data.rets?.n)}</b><em>{wan1(c0(N(data.rets?.amount), rate))} 万</em></div>
            <div><span>中方指令</span><b>{N(data.dirs?.done)} / {N(data.dirs?.n)}</b><em>按时 {pct(N(data.dirs?.ontime), N(data.dirs?.done)) ?? '—'}%</em></div>
          </div></div></section>

        <section className="card rp-sec2"><div className="card-h"><h2>六、走势</h2></div><div className="card-b rp-grid">
          <div><h4>近 6 个月 销售额 / 毛利（万元）<span className="rp-leg"><i style={{ background: 'var(--brand)' }} />销售额 <i style={{ background: '#16a34a' }} />毛利</span></h4><Bars data={R.trend} fmt={(v) => wan1(v)} /></div>
          <div><h4>库存金额（万元，每周一个点）</h4><Spark pts={R.stockLine} fmt={(v) => wan1(v)} /></div>
          <div><h4>超 120 天库存（万元）</h4><Spark pts={R.oldLine} fmt={(v) => wan1(v)} color="#dc2626" /></div>
        </div></section>

        <details className="card rp-sec2 rp-noprint"><summary className="card-h"><h2>文字版（复制进飞书）</h2></summary><pre className="rp-pre">{text()}</pre></details>
      </>}
    </div>);
}
const c0 = (xof, rate) => xof * rate;
