// 销售明细 = 按业务 + 利润表 合成一张 (523, Frank 11-26 16:13–16:22 定)
// 行 = 本地备货 / FOB / 合计 / 较平均 (月报 = 较上月); 列 = 销售额 · 占比 · 销量 · 成本 · 毛利 · 毛利率 ┃ 日常开支 · 净利 · 净利率
// 中间粗竖线 + 上面一行小标题「毛利」「扣掉开支后」, 开支不会看成成本. 前 3 期平均不单列一行: 鼠标移到「较平均」的红绿小字上看平均数、哪几期、算法.
// 每个数都能点开到明细 (links). 看板「销售 ☰」和月报「二、毛利与净利」共用. 不用 Grid: 这是报表, 不是要编辑的表.
import React from 'react';
import { Pct } from './DashBlocks.jsx';

const COLS = [
  ['rev', '销售额'], ['share', '占比'], ['qty', '销量'], ['cost', '成本'], ['gp', '毛利'], ['gpPct', '毛利率'],
  ['exp', '日常开支'], ['net', '净利'], ['netPct', '净利率'],
];
const BAD_UP = { cost: 1, exp: 1 };      // 这几样涨了是坏事 (红)
const RATE = { gpPct: 1, netPct: 1 };    // 比率: 比的是差几个点, 不是涨跌百分比

// rows = { loc, fob, all }: { rev, qty, cost, gp, gpPct, exp?, net?, netPct? }
// cmp = { label: '较平均', baseName: '前 3 期平均', base: {同上的 key}, parts: { key: [['8 月', v], ...] } }
// links = { rev: { loc, fob, all }, qty: {...}, cost: fn, gp: fn, exp: fn }
export default function PLTable({ rows, cmp, f, qtyF = (v) => String(v), cur, low = 15, links = {}, expTip, note }) {
  const R = rows.all.rev || 0;
  const val = (r, k) => (k === 'share' ? (R ? r.rev / R * 100 : null) : r[k]);
  const fmt = (k, v) => (v == null ? null : k === 'qty' ? qtyF(v) : f(v));
  const link = (k, id) => { const x = links[k]; return typeof x === 'function' ? x : x?.[id]; };
  const cell = (k, r, id) => {
    const v = val(r, k);
    if ((k === 'exp' || k === 'net' || k === 'netPct') && id !== 'all') return <span className="muted">—</span>;
    if (k === 'gpPct') return <Pct p={v} low={low} />;
    if (k === 'netPct') return <Pct p={v} low={0} />;
    if (k === 'share') return v == null ? <span className="muted">—</span> : <span className="muted">{v.toFixed(0)}%</span>;
    if (v == null) return <span className="muted">—</span>;
    const t = fmt(k, v); const el = <span className={v < 0 ? 'red-t2' : ''}>{id === 'all' || k === 'gp' || k === 'net' ? <b>{t}</b> : t}</span>;
    const go = link(k, id);
    const tip = k === 'exp' ? expTip : undefined;
    return go ? <button type="button" className="pl-lk" onClick={go} data-tip={tip}>{el}</button> : tip ? <span data-tip={tip} className="pl-tipc">{el}</span> : el;
  };
  const chg = (k) => {
    if (!cmp || k === 'share') return null;
    const now = rows.all[k]; const base = cmp.base?.[k];
    if (now == null || base == null || !Number.isFinite(base)) return <span className="muted">—</span>;
    const parts = (cmp.parts?.[k] || []).map(([l, v]) => `${l} ${v == null ? '—' : RATE[k] ? `${v.toFixed(1)}%` : fmt(k, v)}`).join(' · ');
    const name = COLS.find((c) => c[0] === k)[1];
    const baseTxt = RATE[k] ? `${base.toFixed(1)}%` : fmt(k, base);
    const nowTxt = RATE[k] ? `${now.toFixed(1)}%` : fmt(k, now);
    let txt; let good;
    if (RATE[k]) {
      const d = now - base; if (Math.abs(d) < 0.05) return <span className="muted" data-tip={`${cmp.baseName}：${baseTxt}`}>持平</span>;
      txt = `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} 点`; good = d > 0;
    } else {
      if (!base) return <span className="muted" data-tip={`${cmp.baseName}：0，没法算涨跌`}>—</span>;
      const d = (now - base) / Math.abs(base) * 100; if (Math.abs(d) < 0.5) return <span className="muted" data-tip={`${cmp.baseName}：${baseTxt}`}>持平</span>;
      txt = `${d > 0 ? '▲' : '▼'} ${Math.abs(d) >= 999 ? '>999' : Math.abs(d).toFixed(0)}%`; good = BAD_UP[k] ? d < 0 : d > 0;
    }
    const many = (cmp.parts?.[k] || []).length > 1;
    const tip = `${name} ${cmp.label} ${txt}\n${cmp.baseName}：${baseTxt}${parts ? `（${parts}${many ? ' 的平均' : ''}）` : ''}\n本期：${nowTxt}\n算法：${RATE[k] ? '本期 − 平均（差几个百分点）' : `(本期 − ${many ? '平均' : cmp.baseName}) ÷ ${many ? '平均' : cmp.baseName}`}`;
    return <span className={good ? 'pl-up' : 'pl-down'} data-tip={tip}>{txt}</span>;
  };
  const sep = (k) => (k === 'exp' ? 'pl-vs' : '');
  const key = (k) => (k === 'gp' || k === 'net' ? 'pl-key' : '');
  return (
    <div className="pl-wrap">
      <table className="pl-t">
        <thead>
          <tr className="pl-grp"><th /><th colSpan={6}>毛利</th><th colSpan={3} className="pl-vs">扣掉开支后</th></tr>
          <tr><th><small>{cur}</small></th>{COLS.map(([k, l]) => <th key={k} className={`${key(k)} ${sep(k)}`}>{l}</th>)}</tr>
        </thead>
        <tbody>
          {[['loc', '本地备货', ''], ['fob', 'FOB', ''], ['all', '合计', 'pl-b pl-sep']].map(([id, name, cls]) => (
            <tr key={id} className={cls}><th>{name}</th>{COLS.map(([k]) => <td key={k} className={`${key(k)} ${sep(k)}`}>{cell(k, rows[id], id)}</td>)}</tr>))}
          {cmp && <tr className="pl-chg"><th>{cmp.label}</th>{COLS.map(([k]) => <td key={k} className={sep(k)}>{chg(k)}</td>)}</tr>}
        </tbody>
      </table>
      {note && <div className="small muted pl-note">{note}</div>}
    </div>
  );
}
