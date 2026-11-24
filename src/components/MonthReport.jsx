// 待改 496 / 498 / 499 (Frank 11-23): 一键出月报 —— 以总数为主, 明细在下面; 口径照他的月报:
//   金额人民币「万元」截掉零头不四舍五入; 报告月取整月, 下个月取 1 号到今天前两天; 本地按 数量 + 金额, FOB 只给总数;
//   XOF 按这个月定的汇率折 (默认 0.011, 每个月存一次, 以后改汇率不动老月份); 超期 = 超 21 天, 严重超期 = 超 120 天;
//   库龄 7 段 (国内口径), 在途分海运 / 空运; 两条走势 = 每天记的库存快照.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, MonthPicker, MoneyIn, Assumed } from './ui.jsx';
import { RuleGear, useRuleValues, ruleNum } from './Rules.jsx';
import { money, qty, today, friendlyError } from '../lib/format.js';

const N = (v) => Number(v || 0);
const ymd = (v) => { if (!v) return ''; const x = v instanceof Date ? v : new Date(v); return isNaN(x) ? String(v).slice(0, 10) : x.toISOString().slice(0, 10); };
const wan = (cny) => Math.trunc(cny / 10000);                       // 万元, 截掉零头
const wan1 = (cny) => (Math.trunc(cny / 1000) / 10).toFixed(1);     // 万元, 留一位 (也是截)
const SEGS = [[0, 30], [31, 60], [61, 90], [91, 120], [121, 150], [151, 180], [181, 99999]];
const segName = ([a, b]) => (b > 9999 ? '180 天以上' : `${a}–${b} 天`);
const isScreen = (c) => /屏幕/.test(c || '') && !/显示屏/.test(c || '');
const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo, 1)); return d.toISOString().slice(0, 7); };
const shiftD = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// 小折线 (纯 SVG): 点 = [日期, 数]
export function Spark({ pts, fmt, h = 120, color = 'var(--brand)' }) {
  if (!pts || pts.length < 2) return <div className="small muted" style={{ padding: '18px 0' }}>快照还不够两天，过几天这里就有线了（系统每天记一次）。</div>;
  const W = 560, P = 26; const vs = pts.map((p) => p[1]); const mn = Math.min(...vs), mx = Math.max(...vs); const span = mx - mn || 1;
  const x = (i) => P + i * (W - 2 * P) / (pts.length - 1), y = (v) => h - P - (v - mn) / span * (h - 2 * P);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="rp-spark" role="img">
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts.map((p, i) => `${x(i)},${y(p[1])}`).join(' ')} />
      {pts.map((p, i) => (i === 0 || i === pts.length - 1 || pts.length <= 12) && <g key={i}><circle cx={x(i)} cy={y(p[1])} r="3" fill={color} />
        <text x={x(i)} y={y(p[1]) - 7} textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'} fontSize="11" fill="#334155">{fmt(p[1])}</text>
        <text x={x(i)} y={h - 6} textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'} fontSize="10" fill="#94a3b8">{p[0].slice(5)}</text></g>)}
    </svg>);
}
// 每周取最后一个点
export const weekly = (rows) => { const by = new Map(); for (const [d, v] of rows) { const x = new Date(d + 'T00:00:00Z'); const k = `${x.getUTCFullYear()}-${Math.floor((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / 6048e5)}`; by.set(k, [d, v]); } return [...by.values()]; };

export default function MonthReport({ all, onClose }) {
  const { org, role, toast, refresh, tick } = useApp();
  const td = today();
  const [month, setMonth] = useState(() => { const d = new Date(td + 'T00:00:00Z'); d.setUTCDate(0); return Number(td.slice(8)) <= 20 ? d.toISOString().slice(0, 7) : td.slice(0, 7); });
  const rv = useRuleValues(['dash.budget']);
  const { data } = useData(async () => {
    const [lay, tr, snap, [ar], rates, pend] = await Promise.all([
      call(role, `select * from app.dash_stock_layers($1)`, [org]), call(role, `select * from app.dash_transit($1)`, [org]),
      q(`select day::text as day, key, value from app.dash_snapshots where org_id = $1 and key in ('stock_cost', 'q120_cost', 'ar') order by day`, [org]),
      q(`select coalesce(sum(d.due), 0) as due, coalesce(sum(d.due) filter (where current_date - d.first_shipped_at::date > coalesce(c.credit_days, 30)), 0) as over
         from app.v_deal_due d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.currency = 'XOF' and d.due > 0`, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'report_rates'`, [org]),
      q(`select coalesce(sum(l.offer_qty), 0) as n from app.purchase_request_lines l join app.purchase_requests r on r.id = l.request_id where r.org_id = $1 and l.offer_qty is not null and r.status not in ('closed', 'cancelled', 'done')`, [org]).catch(() => [{ n: null }])]);
    return { lay, tr, snap, ar, rates: rates[0]?.value || {}, pendN: pend[0]?.n };
  }, [org, role, tick]);
  const [rateIn, setRateIn] = useState(null);
  const rate = N(rateIn ?? data?.rates?.[month] ?? 0.011);
  const saveRate = async () => { try { await call(role, `select app.set_org_setting($1,'report_rates',$2)`, [org, JSON.stringify({ ...(data?.rates || {}), [month]: rate })]); toast(`${month} 的汇率记下了：1 XOF = ${rate} CNY`); setRateIn(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const budget = ruleNum(rv, 'dash.budget');
  const R = useMemo(() => {
    if (!data || !all) return null;
    const cny = (xofRev) => xofRev * rate;
    // 销售: 一行的销售额换成 XOF (revenue 就是 XOF), 再按这个月定的汇率折人民币
    const pick = (a, b) => all.filter((r) => { const d = ymd(r.shipped_on); return d >= a && d <= b; });
    const sum = (rows) => { const t = { loc: { q: 0, v: 0 }, fob: { q: 0, v: 0 }, scr: 0, oth: 0, scrFob: 0 }; for (const r of rows) { const k = r.supply === 'fob' ? 'fob' : 'loc'; t[k].q += N(r.qty); t[k].v += cny(N(r.revenue)); if (isScreen(r.category)) { t.scr += N(r.qty); if (k === 'fob') t.scrFob += N(r.qty); } else t.oth += N(r.qty); } t.all = t.loc.v + t.fob.v; t.qty = t.loc.q + t.fob.q; return t; };
    const a = `${month}-01`, b = lastDay(month); const cur = sum(pick(a, b));
    const nm = nextMonth(month); const nb = shiftD(td, -2); const nxt = nm <= td.slice(0, 7) && nb >= `${nm}-01` ? { month: nm, to: nb < lastDay(nm) ? nb : lastDay(nm), ...sum(pick(`${nm}-01`, nb < lastDay(nm) ? nb : lastDay(nm))) } : null;
    const ld = Number(b.slice(8)); const cut = td < b ? td : b;
    const weeks = [[1, 8], [9, 15], [16, 22], [23, ld]].map(([x, y], i) => { const wa = `${month}-${String(x).padStart(2, '0')}`, wb = `${month}-${String(y).padStart(2, '0')}`; const w = sum(pick(wa, wb)); const acc = sum(pick(a, wb < cut ? wb : cut)); return { i: i + 1, x, y, started: wa <= td, ...w, acc: acc.all }; });
    // 库存: 7 段 (只算屏幕 + 全部两套)
    const seg = (rows) => SEGS.map(([lo, hi]) => { let n = 0, v = 0; for (const l of rows) { const age = l.age_days == null ? 99999 : N(l.age_days); if (age >= lo && age <= hi) { n += N(l.qty); v += N(l.qty) * N(l.unit_cost) * rate; } } return { name: segName([lo, hi]), n, v }; });
    const scr = data.lay.filter((l) => isScreen(l.category));
    const tot = (rows) => rows.reduce((t, l) => ({ n: t.n + N(l.qty), v: t.v + N(l.qty) * N(l.unit_cost) * rate }), { n: 0, v: 0 });
    const over = (rows, d) => rows.filter((l) => l.age_days == null || N(l.age_days) > d).reduce((t, l) => ({ n: t.n + N(l.qty), v: t.v + N(l.qty) * N(l.unit_cost) * rate }), { n: 0, v: 0 });
    const tr = { sea: { n: 0, v: 0 }, air: { n: 0, v: 0 } }; for (const p of data.tr) { const k = p.mode === 'air' ? 'air' : 'sea'; tr[k].n += N(p.pcs); tr[k].v += N(p.cost_xof) * rate; }
    const series = (k) => data.snap.filter((x) => x.key === k).map((x) => [x.day, N(x.value) * rate]);
    const monthEnd = (k) => { const prev = data.snap.filter((x) => x.key === k && x.day < a); return prev.length ? N(prev[prev.length - 1].value) * rate : null; };
    return { a, b, cur, nxt, weeks, segAll: seg(data.lay), segScr: seg(scr), totAll: tot(data.lay), totScr: tot(scr), o21: over(data.lay, 21), o120: over(data.lay, 120), o120s: over(scr, 120), tr,
      stockLine: weekly(series('stock_cost')), oldLine: weekly(series('q120_cost')), stockPrev: monthEnd('stock_cost'), ar: N(data.ar?.due) * rate, arOver: N(data.ar?.over) * rate };
  }, [data, all, month, rate, td]);
  const text = () => {
    if (!R) return '';
    const L = [];
    L.push(`【${month} 经营数据】汇率 1 XOF = ${rate} CNY，金额单位万元人民币（零头截掉）`);
    L.push(`一、销售：合计 ${wan(R.cur.all)} 万${budget > 0 ? `，预算 ${wan(budget)} 万，达成 ${Math.floor(R.cur.all / budget * 100)}%` : ''}`);
    L.push(`  本地：${qty(R.cur.loc.q)} 片 / ${wan(R.cur.loc.v)} 万；FOB：${qty(R.cur.fob.q)} 片 / ${wan(R.cur.fob.v)} 万`);
    L.push(`  屏幕 ${qty(R.cur.scr)} 片、屏以外 ${qty(R.cur.oth)} 片，其中屏幕 FOB 出库 ${qty(R.cur.scrFob)} 片`);
    if (R.nxt) L.push(`  ${R.nxt.month}（1 号到 ${R.nxt.to.slice(5)}）：本地 ${qty(R.nxt.loc.q)} 片 / ${wan(R.nxt.loc.v)} 万；FOB ${qty(R.nxt.fob.q)} 片 / ${wan(R.nxt.fob.v)} 万`);
    L.push(`二、按周：${R.weeks.filter((w) => w.started).map((w) => `第 ${w.i} 周（${w.x}–${w.y} 号）${wan1(w.all)} 万、累计 ${wan1(w.acc)} 万${budget > 0 ? `、达成 ${Math.floor(w.acc / budget * 100)}%` : ''}`).join('；')}`);
    L.push(`三、库存：现有 ${qty(R.totAll.n)} 片 / ${wan(R.totAll.v)} 万${R.stockPrev != null ? `（上月底 ${wan(R.stockPrev)} 万）` : ''}；在途 海运 ${qty(R.tr.sea.n)} 片 / ${wan(R.tr.sea.v)} 万、空运 ${qty(R.tr.air.n)} 片 / ${wan(R.tr.air.v)} 万；库存 + 在途 ${wan(R.totAll.v + R.tr.sea.v + R.tr.air.v)} 万`);
    L.push(`  超期（超 21 天）${qty(R.o21.n)} 片 / ${wan(R.o21.v)} 万；严重超期（超 120 天）${qty(R.o120.n)} 片 / ${wan(R.o120.v)} 万，其中屏幕 ${qty(R.o120s.n)} 片 / ${wan(R.o120s.v)} 万`);
    L.push(`  屏幕库龄：${R.segScr.map((s) => `${s.name} ${qty(s.n)} 片 / ${wan1(s.v)} 万`).join('；')}`);
    L.push(`四、应收：${wan(R.ar)} 万，其中超账期 ${wan(R.arOver)} 万`);
    return L.join('\n');
  };
  const copy = async () => { try { await navigator.clipboard.writeText(text()); toast('已复制，可以直接贴进飞书'); } catch { toast('复制不了，手动选中下面的文字', 'err'); } };
  const Row = ({ k, children }) => <tr><th>{k}</th>{children}</tr>;
  return (
    <Modal wide title="出月报" onClose={onClose} footer={<><button type="button" className="btn" onClick={() => window.print()}>打印</button><span className="grow" /><button type="button" className="btn" onClick={onClose}>关闭</button><button type="button" className="btn primary" disabled={!R} onClick={copy}>复制成文字</button></>}>
      <div className="rp">
        <div className="rp-bar">
          <MonthPicker value={month} onChange={(m) => { setMonth(m); setRateIn(null); }} label="报告月份" />
          <label className="row" style={{ gap: 6 }}><span className="small muted" data-tip="这个月的 XOF 折人民币汇率。记下以后这个月一直用它，以后改别的月不影响这个月。">1 XOF =</span>
            <MoneyIn className="in" style={{ width: 90 }} inputMode="decimal" value={String(rateIn ?? data?.rates?.[month] ?? 0.011)} onChange={(e) => setRateIn(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">CNY</span>
            {(rateIn != null || data?.rates?.[month] == null) && <button type="button" className="btn sm" onClick={saveRate}>记下这个月的汇率</button>}</label>
          <RuleGear ids={['dash.budget']} title="本月预算" />
          <Assumed>按你月报的口径先做的：万元截掉零头；报告月整月、下个月取 1 号到今天前两天；按周 = 1–8 / 9–15 / 16–22 / 23–月底；显示屏算屏以外。库龄从系统里有入库记录那天算，没记录的老货算进「180 天以上」。数字只来自系统里的出库和库存，没导进来的历史不在里面。</Assumed>
        </div>
        {!R ? <div className="muted small">加载中…</div> : <>
          <div className="rp-top">
            <div><span>销售合计</span><b>{wan(R.cur.all)}<small>万</small></b><em>{budget > 0 ? `预算 ${wan(budget)} 万 · 达成 ${Math.floor(R.cur.all / budget * 100)}%` : `${qty(R.cur.qty)} 片`}</em></div>
            <div><span>库存</span><b>{wan(R.totAll.v)}<small>万</small></b><em>{R.stockPrev != null ? `上月底 ${wan(R.stockPrev)} 万` : `${qty(R.totAll.n)} 片`}</em></div>
            <div><span>超 120 天</span><b className={R.o120.v > 0 ? 'red-t2' : ''}>{wan(R.o120.v)}<small>万</small></b><em>{qty(R.o120.n)} 片</em></div>
            <div><span>应收</span><b>{wan(R.ar)}<small>万</small></b><em>超账期 {wan(R.arOver)} 万</em></div>
          </div>
          <details className="rp-sec" open><summary>销售</summary>
            <table className="rp-t"><thead><tr><th /><th>数量 片</th><th>金额 万元</th></tr></thead><tbody>
              <Row k={`${month} 本地`}><td>{qty(R.cur.loc.q)}</td><td>{wan1(R.cur.loc.v)}</td></Row>
              <Row k={`${month} FOB`}><td>{qty(R.cur.fob.q)}</td><td>{wan1(R.cur.fob.v)}</td></Row>
              <Row k="合计"><td><b>{qty(R.cur.qty)}</b></td><td><b>{wan1(R.cur.all)}</b></td></Row>
              {R.nxt && <><Row k={`${R.nxt.month}（到 ${R.nxt.to.slice(5)}）本地`}><td>{qty(R.nxt.loc.q)}</td><td>{wan1(R.nxt.loc.v)}</td></Row>
                <Row k={`${R.nxt.month}（到 ${R.nxt.to.slice(5)}）FOB`}><td>{qty(R.nxt.fob.q)}</td><td>{wan1(R.nxt.fob.v)}</td></Row></>}
            </tbody></table>
            <div className="small muted">屏幕 {qty(R.cur.scr)} 片、屏以外 {qty(R.cur.oth)} 片，其中屏幕 FOB 出库 {qty(R.cur.scrFob)} 片</div>
          </details>
          <details className="rp-sec"><summary>按周达成</summary>
            <table className="rp-t"><thead><tr><th /><th>当周 万元</th><th>月累计 万元</th><th>预算 万元</th><th>达成率</th></tr></thead><tbody>
              {R.weeks.map((w) => <Row key={w.i} k={`第 ${w.i} 周（${w.x}–${w.y} 号）`}>{w.started ? <><td>{wan1(w.all)}</td><td>{wan1(w.acc)}</td><td>{budget > 0 ? wan(budget) : '—'}</td><td>{budget > 0 ? `${Math.floor(w.acc / budget * 100)}%` : '—'}</td></> : <td colSpan={4} className="muted">还没到</td>}</Row>)}
            </tbody></table>
          </details>
          <details className="rp-sec"><summary>库存与库龄</summary>
            <table className="rp-t"><thead><tr><th>库龄</th><th>屏幕 片</th><th>屏幕 万元</th><th>全部 片</th><th>全部 万元</th></tr></thead><tbody>
              {SEGS.map((sg, i) => <Row key={i} k={segName(sg)}><td>{qty(R.segScr[i].n)}</td><td>{wan1(R.segScr[i].v)}</td><td>{qty(R.segAll[i].n)}</td><td>{wan1(R.segAll[i].v)}</td></Row>)}
              <Row k="库存总计"><td><b>{qty(R.totScr.n)}</b></td><td><b>{wan1(R.totScr.v)}</b></td><td><b>{qty(R.totAll.n)}</b></td><td><b>{wan1(R.totAll.v)}</b></td></Row>
              <Row k="在途 · 海运"><td colSpan={2} /><td>{qty(R.tr.sea.n)}</td><td>{wan1(R.tr.sea.v)}</td></Row>
              <Row k="在途 · 空运"><td colSpan={2} /><td>{qty(R.tr.air.n)}</td><td>{wan1(R.tr.air.v)}</td></Row>
              <Row k="库存 + 在途"><td colSpan={2} /><td><b>{qty(R.totAll.n + R.tr.sea.n + R.tr.air.n)}</b></td><td><b>{wan1(R.totAll.v + R.tr.sea.v + R.tr.air.v)}</b></td></Row>
              {data.pendN != null && <Row k="国内待发（国内商务回复的可供数）"><td colSpan={2} /><td>{qty(data.pendN)}</td><td /></Row>}
              <Row k="超期（超 21 天）"><td colSpan={2} /><td>{qty(R.o21.n)}</td><td>{wan1(R.o21.v)}</td></Row>
              <Row k="严重超期（超 120 天）"><td>{qty(R.o120s.n)}</td><td>{wan1(R.o120s.v)}</td><td>{qty(R.o120.n)}</td><td>{wan1(R.o120.v)}</td></Row>
            </tbody></table>
          </details>
          <details className="rp-sec"><summary>走势（每周一个点）</summary>
            <div className="rp-two"><div><div className="small muted">库存金额 万元</div><Spark pts={R.stockLine} fmt={(v) => wan1(v)} /></div>
              <div><div className="small muted">超 120 天库存金额 万元</div><Spark pts={R.oldLine} fmt={(v) => wan1(v)} color="#dc2626" /></div></div>
          </details>
          <details className="rp-sec"><summary>文字版（复制进飞书）</summary><pre className="rp-pre">{text()}</pre></details>
        </>}
      </div>
    </Modal>);
}
