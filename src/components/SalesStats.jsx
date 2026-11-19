// 384 (Frank 11-18): 物料档案里的「销量」—— 日 / 周 / 月 / 季 / 年 柱状图 + 表, 点某一段 → 哪些客户买了、各多少片、哪几张单.
// 数据 = 系统出库 (减退货按出库行算) + 导入的历史月销量 (标「历史导入」, 只有按月 / 季 / 年能接上).
// 383: useShare —— 客户在一段时间里的出货占全公司多少 (金额 / 片数).
import React, { useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Info, Assumed } from './ui.jsx';
import { DealLink, CustLink } from './Archives.jsx';
import { money, qty, dDate } from '../lib/format.js';
import { seesPrice } from '../lib/domain.js';

const N = (v) => Number(v || 0);
const GRAINS = [['day', '按天', 30], ['week', '按周', 16], ['month', '按月', 12], ['quarter', '按季', 8], ['year', '按年', 5]];
const label = (g, d) => { const s = String(d).slice(0, 10); if (g === 'day') return s.slice(5); if (g === 'week') return `${s.slice(5)} 那周`; if (g === 'month') return s.slice(0, 7); if (g === 'quarter') return `${s.slice(0, 4)} Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`; return s.slice(0, 4); };

export function ProductSales({ productId }) {
  const { org, role } = useApp();
  const [g, setG] = useState('month'); const [pick, setPick] = useState(null);
  const price = seesPrice(role);
  const n = GRAINS.find((x) => x[0] === g)[2];
  const { data } = useData(async () => {
    const sys = await q(`select date_trunc($3, sh.shipped_at)::date::text as p, sum(sl.qty - coalesce(l.qty_returned, 0) * sl.qty / nullif(l.qty_shipped, 0))::int as qty, sum(sl.amount * case when d.currency = 'XOF' then 1 else coalesce(d.fx_rate, 0) end) as amount
      from app.shipment_lines sl join app.shipments sh on sh.id = sl.shipment_id join app.deal_lines l on l.id = sl.deal_line_id join app.deals d on d.id = sh.deal_id
      where d.org_id = $1 and l.product_id = $2 and sh.voided_at is null group by 1 order by 1`, [org, productId, g]);
    const hist = ['month', 'quarter', 'year'].includes(g) ? await q(`select date_trunc($3, h.month)::date::text as p, sum(h.qty)::int as qty from app.sales_history h where h.org_id = $1 and h.product_id = $2
      and not exists (select 1 from app.shipment_lines sl join app.shipments sh on sh.id = sl.shipment_id join app.deal_lines l on l.id = sl.deal_line_id where l.product_id = h.product_id and sh.voided_at is null and date_trunc('month', sh.shipped_at)::date = h.month)
      group by 1 order by 1`, [org, productId, g]) : [];
    const m = new Map();
    for (const r of hist) m.set(String(r.p).slice(0, 10), { p: String(r.p).slice(0, 10), qty: N(r.qty), amount: 0, hist: N(r.qty) });
    for (const r of sys) { const k = String(r.p).slice(0, 10); const o = m.get(k) || { p: k, qty: 0, amount: 0, hist: 0 }; o.qty += N(r.qty); o.amount += N(r.amount); m.set(k, o); }
    return [...m.values()].sort((a, b) => a.p.localeCompare(b.p)).slice(-n);
  }, [org, productId, g]);
  const { data: detail } = useData(() => (pick ? q(`select d.id as deal_id, d.biz_no, c.id as customer_id, c.name as customer, sh.shipped_at, sl.qty, sl.unit_price, d.currency
      from app.shipment_lines sl join app.shipments sh on sh.id = sl.shipment_id join app.deal_lines l on l.id = sl.deal_line_id join app.deals d on d.id = sh.deal_id join app.customers c on c.id = d.customer_id
      where d.org_id = $1 and l.product_id = $2 and sh.voided_at is null and date_trunc($3, sh.shipped_at)::date = $4::date order by sh.shipped_at desc`, [org, productId, g, pick]) : Promise.resolve(null)), [org, productId, g, pick]);
  const rows = data || []; const max = Math.max(1, ...rows.map((r) => r.qty));
  const byCust = {}; for (const r of detail || []) { const o = byCust[r.customer_id] = byCust[r.customer_id] || { id: r.customer_id, name: r.customer, qty: 0, deals: [] }; o.qty += N(r.qty); if (!o.deals.some((x) => x.id === r.deal_id)) o.deals.push({ id: r.deal_id, no: r.biz_no }); }
  return (
    <section className="pd-sec">
      <div className="pd-h" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>销量 <Info>出库算销量（退货已减）。点一根柱子 → 看这一段哪些客户买了、哪几张单。灰色部分是导入的历史月销量（只有总数，没有客户明细）。</Info>
        <span className="al-seg">{GRAINS.map(([k, l]) => <button type="button" key={k} className={g === k ? 'on' : ''} onClick={() => { setG(k); setPick(null); }}>{l}</button>)}</span></div>
      {rows.length === 0 ? <div className="small muted">这个型号还没有出库记录。</div> : <>
        <div className="sales-bars">{rows.map((r) => (
          <button type="button" key={r.p} className={`sales-bar ${pick === r.p ? 'on' : ''}`} onClick={() => setPick(pick === r.p ? null : r.p)} title={`${label(g, r.p)}：${qty(r.qty)} 片${r.hist ? `（其中历史导入 ${qty(r.hist)}）` : ''}`}>
            <span className="n">{qty(r.qty)}</span>
            <span className="col"><i style={{ height: `${Math.max(2, (r.qty / max) * 100)}%` }}><em style={{ height: `${r.qty ? (r.hist / r.qty) * 100 : 0}%` }} /></i></span>
            <span className="l">{label(g, r.p)}</span>
          </button>))}</div>
        <div className="small muted">合计 {qty(rows.reduce((a, r) => a + r.qty, 0))} 片{price ? ` · ${money(rows.reduce((a, r) => a + r.amount, 0))} XOF（不含历史导入的）` : ''} · 最近 {rows.length} 个{GRAINS.find((x) => x[0] === g)[1].slice(1)}有销量</div>
        {pick && <div className="sales-detail"><b>{label(g, pick)}</b>{detail == null ? ' 加载中…' : detail.length === 0 ? <span className="small muted"> 这一段只有历史导入的总数，没有客户明细。</span> : <>
          <span className="small muted"> · {Object.keys(byCust).length} 个客户 · {qty(detail.reduce((a, r) => a + N(r.qty), 0))} 片</span>
          {Object.values(byCust).sort((a, b) => b.qty - a.qty).map((c) => <div key={c.id} className="todo-line"><CustLink id={c.id} name={c.name} /><b>{qty(c.qty)} 片</b><span className="grow" />{c.deals.map((d) => <DealLink key={d.id} id={d.id} no={d.no} />)}</div>)}</>}</div>}
      </>}
    </section>);
}

// 383: 每个客户在 [from, to] 的出货占比 (金额 / 片数); 本地客户和 FOB 客户分开算分母
export function useShare(from, to) {
  const { org } = useApp();
  const { data } = useData(() => (from && to ? q(`with x as (select d.customer_id, c.supply, sum(sl.amount * case when d.currency = 'XOF' then 1 else coalesce(d.fx_rate, 0) end) as amt, sum(sl.qty) as qty
      from app.shipment_lines sl join app.shipments sh on sh.id = sl.shipment_id join app.deals d on d.id = sh.deal_id join app.customers c on c.id = d.customer_id
      where d.org_id = $1 and sh.voided_at is null and sh.shipped_at::date between $2::date and $3::date group by 1, 2)
    select customer_id, amt, qty, amt / nullif(sum(amt) over (partition by supply), 0) as amt_share, qty / nullif(sum(qty) over (partition by supply), 0) as qty_share from x`, [org, from, to]) : Promise.resolve([])), [org, from, to]);
  return Object.fromEntries((data || []).map((r) => [r.customer_id, r]));
}
export const SHARE_RANGES = [['month', '本月'], ['quarter', '本季'], ['year', '本年'], ['w4', '最近 4 周'], ['w8', '最近 8 周'], ['w12', '最近 12 周']];
export const shareRange = (k) => { const t = new Date(); const iso = (d) => d.toISOString().slice(0, 10); const to = iso(t); const f = new Date(t);
  if (k === 'month') f.setDate(1); else if (k === 'quarter') { f.setMonth(Math.floor(f.getMonth() / 3) * 3, 1); } else if (k === 'year') f.setMonth(0, 1); else f.setDate(f.getDate() - Number(k.slice(1)) * 7 + 1);
  return [iso(f), to]; };
export const ShareNote = () => <Assumed>订单占比 = 这个客户这段时间的出库金额 ÷ 同期全公司出库金额（片数占比同理）。本地客户和 FOB 客户分开算分母。按出库算，不按报价。</Assumed>;
