// 373 (Frank 11-18): 所有单号前都有「小眼睛」缩略预览 —— 一种单据配一份「头部 + 行 + 合计」的定义, 通用一个弹框.
// 销售订单的在 Archives.jsx (DealPeek, 老的不动); 这里是 采购单 / 出库单 / 收款单 / 退货单.
// 权限照旧: 找货员看不到价; 手机上弹框居中 (.peek 的手机样式).
import React, { useEffect, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp } from './ui.jsx';
import { seesPrice } from '../lib/domain.js';
import { money, qty, dDate, dt } from '../lib/format.js';

let OPEN = null;
const N = (v) => Number(v || 0);
const DEFS = {
  // 467 / 468: 「可预订」小框上看在途 —— 预计到货时间 · 片数 · 机型名; 不含 FOB; 后台只给中方 + 国内采购
  transit: {
    label: '看在途的货',
    load: async (id, { org, role }) => { const lines = await call(role, `select * from app.transit_peek($1,$2)`, [org, id]); return { h: { n: lines.length }, lines }; },
    head: () => ['在途的货', '不含 FOB', ''],
    cols: [['预计到货时间', (l) => (l.eta ? dDate(l.eta) : '还没定')], ['片数', (l) => qty(l.qty), 'r'], ['机型名', (l) => <b>{l.model}</b>]],
    foot: (ls) => [`${ls.length} 批`, qty(ls.reduce((a, l) => a + N(l.qty), 0)), ''],
    empty: '现在没有在途的货',
  },
  po: {
    label: '看这张采购单的明细',
    load: async (id) => { const [[h], lines] = await Promise.all([
      q(`select p.po_no, p.supplier, p.purpose, p.batch_name, p.note, p.shipped_on, p.status, c.name as customer from app.purchase_orders p left join app.fob_projects f on f.id = p.fob_project_id left join app.customers c on c.id = f.customer_id where p.id = $1`, [id]),
      q(`select coalesce(pr.model, l.model, l.descr) as model, cat.name as category, l.qty, l.qty_received, coalesce(l.closed_qty, 0) as closed from app.po_lines l left join app.products pr on pr.id = l.product_id left join app.categories cat on cat.id = pr.category_id where l.po_id = $1 order by 1`, [id])]);
      return { h, lines }; },
    head: (h) => [h.po_no, [h.purpose, h.customer, h.batch_name, h.supplier].filter(Boolean).join(' · '), h.shipped_on ? `发货 ${dDate(h.shipped_on)}` : ''],
    cols: [['型号', (l) => <b>{l.model}</b>], ['种类', (l) => l.category || ''], ['订了', (l) => qty(l.qty), 'r'], ['已到', (l) => qty(l.qty_received), 'r'], ['没到', (l) => { const n = N(l.qty) - N(l.qty_received) - N(l.closed); return n > 0 ? <b style={{ color: '#b26a00' }}>{qty(n)}</b> : '0'; }, 'r']],
    foot: (ls) => [`合计 ${ls.length} 行`, '', qty(ls.reduce((a, l) => a + N(l.qty), 0)), qty(ls.reduce((a, l) => a + N(l.qty_received), 0)), qty(ls.reduce((a, l) => a + Math.max(0, N(l.qty) - N(l.qty_received) - N(l.closed)), 0))],
  },
  shipment: {
    label: '看这张出库单的明细',
    load: async (id) => { const [[h], lines] = await Promise.all([
      q(`select s.out_no, s.shipped_at, s.method, s.method_label, s.customer_received_at, s.voided_at, d.biz_no, d.currency, c.name as customer from app.shipments s join app.deals d on d.id = s.deal_id join app.customers c on c.id = d.customer_id where s.id = $1`, [id]),
      q(`select p.model, cat.name as category, sl.qty, sl.unit_price, sl.amount from app.shipment_lines sl join app.deal_lines l on l.id = sl.deal_line_id join app.products p on p.id = l.product_id join app.categories cat on cat.id = p.category_id where sl.shipment_id = $1 order by l.seq`, [id])]);
      return { h, lines }; },
    head: (h) => [h.out_no, `${h.biz_no} · ${h.customer}`, `${dt(h.shipped_at)} · ${h.voided_at ? '已撤销' : h.customer_received_at ? '已签收' : '还没签收'}`],
    cols: [['型号', (l) => <b>{l.model}</b>], ['种类', (l) => l.category], ['出了', (l) => qty(l.qty), 'r'], ['单价', (l) => money(l.unit_price), 'r', true], ['金额', (l) => money(l.amount), 'r', true]],
    foot: (ls, h) => [`合计 ${ls.length} 行`, '', qty(ls.reduce((a, l) => a + N(l.qty), 0)), '', money(ls.reduce((a, l) => a + N(l.amount), 0), h.currency)],
  },
  receipt: {
    label: '看这笔收款冲到了哪',
    load: async (id) => { const [[h], lines] = await Promise.all([
      q(`select r.rcv_no, r.received_on, r.amount, r.currency, r.converted, r.account_currency, r.voided_at, c.name as customer, a.name as account, e.short_name as collector,
           r.converted - coalesce((select sum(x.amount) from app.receipt_allocations x where x.receipt_id = r.id), 0) as rest
         from app.receipts r join app.customers c on c.id = r.customer_id left join app.cash_accounts a on a.id = r.account_id left join app.employees e on e.id = r.collector_employee_id where r.id = $1`, [id]),
      q(`select d.biz_no, sum(x.amount) as amount from app.receipt_allocations x join app.deals d on d.id = x.deal_id where x.receipt_id = $1 group by d.biz_no order by 1`, [id])]);
      return { h, lines }; },
    head: (h) => [h.rcv_no, `${h.customer} · ${dDate(h.received_on)}`, `付了 ${money(h.amount, h.currency)} ${h.currency}${h.account ? ` → ${h.account}` : ''}${h.collector ? ` · ${h.collector} 代收` : ''}${h.voided_at ? ' · 已撤销' : ''}`],
    cols: [['冲到哪张单', (l) => <b className="mono">{l.biz_no}</b>], ['冲了多少', (l) => money(l.amount), 'r']],
    foot: (ls, h) => [`冲了 ${ls.length} 张单`, `还剩预付 ${money(Math.max(0, N(h.rest)), h.account_currency)}`],
    empty: '这笔还没冲到任何单（全是预付）',
  },
  ret: {
    label: '看这张退货单的明细',
    load: async (id) => { const [[h], lines] = await Promise.all([
      q(`select r.rt_no, r.status, r.reason, r.amount, r.requested_at, d.biz_no, d.currency, c.name as customer from app.returns r join app.deals d on d.id = r.deal_id join app.customers c on c.id = r.customer_id where r.id = $1`, [id]),
      q(`select p.model, cat.name as category, rl.qty, rl.unit_price, rl.qty_good, rl.qty_scrap from app.return_lines rl join app.deal_lines l on l.id = rl.deal_line_id join app.products p on p.id = l.product_id join app.categories cat on cat.id = p.category_id where rl.return_id = $1 order by l.seq`, [id])]);
      return { h, lines }; },
    head: (h) => [h.rt_no, `${h.biz_no} · ${h.customer}`, `${dDate(h.requested_at)} · ${{ requested: '等中方批', approved: '已批准', rejected: '已驳回', inspected: '已检验' }[h.status] || h.status} · ${h.reason}`],
    cols: [['型号', (l) => <b>{l.model}</b>], ['种类', (l) => l.category], ['退几片', (l) => qty(l.qty), 'r'], ['好 / 坏', (l) => `${qty(l.qty_good)} / ${qty(l.qty_scrap)}`, 'r'], ['金额', (l) => money(N(l.qty) * N(l.unit_price)), 'r', true]],
    foot: (ls, h) => [`合计 ${ls.length} 行`, '', qty(ls.reduce((a, l) => a + N(l.qty), 0)), '', money(h.amount, h.currency)],
  },
};

export function DocPeek({ kind, id, trigger }) {
  const { role, org } = useApp();
  const def = DEFS[kind];
  const [at, setAt] = useState(null); const [d, setD] = useState(null); const btn = useRef(); const timer = useRef();
  const shut = useRef(); shut.current = () => { clearTimeout(timer.current); setAt(null); };
  useEffect(() => () => { clearTimeout(timer.current); if (OPEN === shut) OPEN = null; }, []);
  useEffect(() => {
    if (!at) return undefined;
    const off = (e) => { if (!e.target.closest?.('.peek') && !btn.current?.contains(e.target)) shut.current(); };
    const sc = (e) => { if (!e.target.closest?.('.peek')) shut.current(); };
    document.addEventListener('mousedown', off); window.addEventListener('scroll', sc, true);
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('scroll', sc, true); };
  }, [at]);
  if (!def || !id) return null;
  const open = () => {
    if (!btn.current) return;
    if (OPEN && OPEN !== shut) OPEN.current(); OPEN = shut;
    const r = btn.current.getBoundingClientRect(); const w = Math.min(440, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)); const below = window.innerHeight - r.bottom > 260 || r.top < 260;
    setAt({ left, w, ...(below ? { top: r.bottom + 6, maxH: window.innerHeight - r.bottom - 16 } : { bottom: window.innerHeight - r.top + 6, maxH: r.top - 16 }) });
    if (!d) def.load(id, { org, role }).then((x) => setD(x.h ? x : { h: null, lines: [] })).catch(() => setD({ h: null, lines: [] }));
  };
  const price = seesPrice(role);
  const cols = def.cols.filter((c) => !c[3] || price);
  const keep = def.cols.map((c) => !c[3] || price);
  return (
    <>
      <button type="button" ref={btn} className={trigger ? 'peek-trig' : 'peek-eye'} aria-label={def.label}
        onMouseEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(open, 120); }}
        onMouseLeave={() => { clearTimeout(timer.current); timer.current = setTimeout(() => shut.current(), 150); }}
        onClick={(e) => { e.stopPropagation(); clearTimeout(timer.current); if (at) shut.current(); else open(); }}>{trigger || '☰'}</button>
      {at && (
        <div className="peek" style={{ left: at.left, width: at.w, top: at.top, bottom: at.bottom, maxHeight: Math.max(180, at.maxH) }} onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={() => shut.current()}>
          {!d ? <div className="muted small" style={{ padding: 10 }}>加载中…</div> : !d.h ? <div className="muted small" style={{ padding: 10 }}>没找到这张单</div> : (() => { const [no, sub, sub2] = def.head(d.h); const foot = def.foot(d.lines, d.h).filter((_, i) => keep[i] ?? true); return (
            <>
              <div className="peek-h" style={{ display: 'block' }}><div><b className="mono">{no}</b> <span className="small">{sub}</span></div>{sub2 && <div className="small muted">{sub2}</div>}</div>
              <table className="peek-t">
                <thead><tr>{cols.map((c) => <th key={c[0]} className={c[2] || ''}>{c[0]}</th>)}</tr></thead>
                <tbody>{d.lines.map((l, i) => <tr key={i}>{cols.map((c) => <td key={c[0]} className={c[2] || ''}>{c[1](l)}</td>)}</tr>)}
                  {!d.lines.length && <tr><td colSpan={cols.length} className="muted">{def.empty || '没有行'}</td></tr>}</tbody>
                <tfoot><tr>{foot.map((x, i) => <td key={i} className={cols[i]?.[2] || ''}><b>{x}</b></td>)}</tr></tfoot>
              </table>
            </>); })()}
        </div>)}
    </>);
}
// 单号 + 小眼睛 (不带跳转的地方用)
export const DocNo = ({ kind, id, no, strike }) => <span className="deal-link"><DocPeek kind={kind} id={id} /><b className={`mono ${strike ? 'strike' : ''}`}>{no}</b></span>;

// 464 / 467: 选货的地方全站只有两个状态 —— 可售 (绿) / 可预订 (黄), 对内对外同一个词.
// n 给了数字 (有权看库存的人) → 可售带片数; 可预订的小框: 中方 / 国内采购 悬停或点一下看在途 (别人只是一个黄框).
export function AvailPill({ n, band, pid }) {
  const { role } = useApp();
  const ok = n != null ? Number(n) > 0 : band === 'ok' || band === 'low';
  if (ok) return <span className="pill green">{n != null ? `可售 ${qty(n)}` : '可售'}</span>;
  const pill = <span className="pill amber">可预订</span>;
  return pid && ['admin', 'cn_support'].includes(role) ? <DocPeek kind="transit" id={pid} trigger={pill} /> : pill;
}
