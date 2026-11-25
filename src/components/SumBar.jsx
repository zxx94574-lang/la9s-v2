// 清单页顶上的小总览（Frank 11-25 14:12）：订单总览 / 客户总账 / 库存 / FOB… 每个「总」页先给几个最基本的总数，
// 跟着下面的筛选一起变（联动）；能点的数点了就把下面的表筛成那一类，再点一下取消。样式同 FOB 页的总数条（.bigsum）。
// items: [{ k: 标题, v: 主数, unit, sub: 下面一行小字, tone: 'red'|'amber'|'green', on: 正在筛, onClick }]
import React from 'react';
import { Info } from './ui.jsx';

export default function SumBar({ items, note }) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="card pgsum">
      <div className="bigsum">{list.map((it) => {
        return (
          <div key={it.k} role={it.onClick ? 'button' : undefined} tabIndex={it.onClick ? 0 : undefined} onKeyDown={it.onClick ? (e) => { if (e.key === 'Enter') it.onClick(); } : undefined} className={`sb-i ${it.onClick ? '' : 'static'} ${it.on ? 'on' : ''}`} onClick={it.onClick} title={it.onClick ? (it.on ? '再点一下取消筛选' : '点了筛下面的表') : undefined}>
            <div className="k">{it.k}{it.tip && <Info>{it.tip}</Info>}{it.on ? ' · 正在筛 ×' : ''}</div>
            <div className={`v ${it.tone ? `${it.tone}-t2` : ''}`}>{it.v}{it.unit && <small> {it.unit}</small>}</div>
            {it.sub && <div className="sb-sub">{it.sub}</div>}
          </div>);
      })}</div>
      {note && <div className="card-b small muted" style={{ paddingTop: 6, paddingBottom: 8 }}>{note}</div>}
    </div>);
}
