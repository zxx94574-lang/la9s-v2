// 点名字就出档案 (Frank 11-09 192a): 型号 → 物料档案, 客户名 → 客户档案, 员工名 → 员工档案. 全站同一套, 由 App 里的宿主统一弹出.
import React, { useEffect, useRef, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, TierPill, Pill } from './ui.jsx';
import { STATUS, seesPrice } from '../lib/domain.js';
import { money, qty } from '../lib/format.js';
import ProductDrawer from './ProductDrawer.jsx';
import { CustomerDrawer } from '../pages/Customers.jsx';
import { EmpModal } from '../pages/Staff.jsx';
import { staffOptions } from '../lib/staffOptions.js';

const stop = (fn) => (e) => { e.stopPropagation(); e.preventDefault(); fn(); };

export function ModelLink({ id, model, tier, children, className = '' }) {
  const { openArchive } = useApp();
  if (!id || !openArchive) return <b className={className}>{children ?? model}</b>;
  return <button type="button" className={`linkbtn ${className}`} title="打开物料档案" onClick={stop(() => openArchive({ kind: 'product', product: { id, model }, tier }))}><b>{children ?? model}</b></button>;
}
export function CustLink({ id, name, children }) {
  const { openArchive } = useApp();
  if (!id || !openArchive) return <>{children ?? name}</>;
  return <button type="button" className="linkbtn" title="打开客户档案" onClick={stop(() => openArchive({ kind: 'customer', id }))}>{children ?? name}</button>;
}
export function EmpLink({ id, name, children }) {
  const { openArchive, role } = useApp();
  if (!id || !openArchive || !['admin', 'sales_manager'].includes(role)) return <>{children ?? name}</>;   // 员工档案 (含证件照) 只中方 / 销售主管
  return <button type="button" className="linkbtn" title="打开员工档案" onClick={stop(() => openArchive({ kind: 'employee', id }))}>{children ?? name}</button>;
}

// 254 (Frank 11-12): 单号前面一只小眼睛 → 不用点进去就看到这张单要了什么、多少片、什么价. 全站单号都带.
// 订单总览里正在搜 / 筛的机型, 在预览里用蓝圈圈出来 (PEEK_HL 由表格的筛选告诉这里).
let PEEK_HL = [];
export const setPeekHighlight = (words) => { PEEK_HL = (words || []).map((w) => String(w || '').trim().toUpperCase()).filter(Boolean); };
function DealPeek({ id }) {
  const { role } = useApp();
  const [at, setAt] = useState(null); const [d, setD] = useState(null); const btn = useRef(); const timer = useRef(); const pinned = useRef(false);
  const open = () => {
    const r = btn.current.getBoundingClientRect(); const w = Math.min(460, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)); const below = window.innerHeight - r.bottom > 260 || r.top < 260;
    setAt({ left, w, ...(below ? { top: r.bottom + 6, maxH: window.innerHeight - r.bottom - 16 } : { bottom: window.innerHeight - r.top + 6, maxH: r.top - 16 }) });
    if (!d) q(Q.dealPeek, [id]).then((x) => setD(x[0] || { lines: [] })).catch(() => setD({ lines: [] }));
  };
  const close = () => { pinned.current = false; setAt(null); };
  useEffect(() => {
    if (!at) return undefined;
    const off = (e) => { if (!e.target.closest?.('.peek') && e.target !== btn.current) close(); };
    const sc = (e) => { if (!e.target.closest?.('.peek')) close(); };
    document.addEventListener('mousedown', off); window.addEventListener('scroll', sc, true);
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('scroll', sc, true); };
  }, [at]);
  const price = seesPrice(role);
  const early = d && ['quoted', 'hotline_ok', 'picking', 'pick_submitted'].includes(d.status);
  const hit = (l) => PEEK_HL.some((w) => String(l.model || '').toUpperCase().includes(w) || String(l.code || '').toUpperCase() === w);
  return (
    <>
      <button type="button" ref={btn} className="peek-eye" title="预览这张单（不用点进去）" aria-label="预览这张单"
        onMouseEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(open, 250); }}
        onMouseLeave={() => { clearTimeout(timer.current); if (!pinned.current) timer.current = setTimeout(() => setAt(null), 200); }}
        onClick={stop(() => { clearTimeout(timer.current); if (at && pinned.current) close(); else { pinned.current = true; open(); } })}>👁</button>
      {at && (
        <div className="peek" style={{ left: at.left, width: at.w, top: at.top, bottom: at.bottom, maxHeight: Math.max(180, at.maxH) }} onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={() => { if (!pinned.current) setAt(null); }}>
          {!d ? <div className="muted small" style={{ padding: 10 }}>加载中…</div> : (
            <>
              <div className="peek-h"><b className="mono">{d.biz_no}</b>{d.status && <Pill tone={STATUS[d.status]?.tone}>{STATUS[d.status]?.label}</Pill>}<span className="grow" />
                <span className="small">{d.customer_name}{d.city ? ' · ' + d.city : ''}</span>{d.tier && <TierPill tier={d.tier} />}</div>
              <table className="peek-t">
                <thead><tr><th>#</th><th>种类</th><th>机型</th><th className="r">要</th>{!early && <th className="r">给</th>}{price && <th className="r">单价</th>}{price && <th className="r">金额</th>}</tr></thead>
                <tbody>{d.lines.map((l, i) => { const n = Number(early ? l.qty_req : l.qty_supply); return (
                  <tr key={i}><td className="muted">{i + 1}</td><td className="small">{l.category || ''}</td>
                    <td><span className={hit(l) ? 'peek-hit' : ''}><b>{l.model}</b></span></td>
                    <td className="r">{qty(l.qty_req)}</td>{!early && <td className="r">{Number(l.qty_supply) < Number(l.qty_req) ? <b style={{ color: 'var(--red)' }}>{qty(l.qty_supply)}</b> : qty(l.qty_supply)}</td>}
                    {price && <td className="r">{money(l.unit_price)}</td>}{price && <td className="r">{money(n * Number(l.unit_price))}</td>}</tr>); })}
                  {!d.lines.length && <tr><td colSpan={7} className="muted">这张单没有行</td></tr>}</tbody>
                <tfoot><tr><td colSpan={3}><b>合计 {d.lines.length} 行</b></td><td className="r"><b>{qty(d.lines.reduce((a, l) => a + Number(l.qty_req), 0))}</b></td>
                  {!early && <td className="r"><b>{qty(d.lines.reduce((a, l) => a + Number(l.qty_supply), 0))}</b></td>}
                  {price && <td />}{price && <td className="r"><b>{money(d.lines.reduce((a, l) => a + Number(early ? l.qty_req : l.qty_supply) * Number(l.unit_price), 0), d.currency)}</b></td>}</tr></tfoot>
              </table>
            </>)}
        </div>)}
    </>
  );
}

// 单号 → 打开那张单 (Frank 11-11 207, 底层统一): 有 onOpen 就在抽屉里看, 没有就跳到订单页. peek=false 关掉小眼睛 (单据标题这种地方)
export function DealLink({ id, no, onOpen, children, peek = true }) {
  const { go } = useApp();
  if (!id) return <span className="mono">{children ?? no}</span>;
  return <span className="deal-link">{peek && <DealPeek id={id} />}<button type="button" className="linkbtn mono" title={`打开 ${no}`} onClick={stop(() => (onOpen ? onOpen(id) : go('deal/' + id)))}>{children ?? no}</button></span>;
}

function EmpArchive({ id, onClose }) {
  const { org } = useApp();
  const { data } = useData(async () => {
    const [staff, opt] = await Promise.all([q(Q.staffList, [org]), q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org])]);
    return { e: staff.find((x) => x.id === id), opts: staffOptions(opt[0]?.value) };
  }, [org, id]);
  if (!data?.e) return null;
  return <EmpModal e={data.e} opts={data.opts} onClose={onClose} />;
}

export function ArchiveHost({ arch, onClose }) {
  if (!arch) return null;
  if (arch.kind === 'product') return <ProductDrawer product={arch.product} tier={arch.tier} onClose={onClose} />;
  if (arch.kind === 'customer') return <CustomerDrawer id={arch.id} onClose={onClose} />;
  if (arch.kind === 'employee') return <EmpArchive id={arch.id} onClose={onClose} />;
  return null;
}
