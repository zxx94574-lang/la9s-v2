// 利润表 (522, Frank 11-26: 标准损益表 —— 项目一行一行往下算, 本地 / FOB / 合计 / 占销售额 / 上期 / 变化 横着排)
// 看板「销售 ☰ 利润表」和月报「二、毛利与净利」共用. 不用 Grid: 这是报表, 不是要编辑的表.
// c = { loc: {rev, cost, gp}, fob: {...}, all: {...} }, prev = {rev, cost, gp} | null,
// exps = [{ name, v, prev? }], expPrev = 上期开支合计 | null, gpPct = 毛利率 (成本缺的不算进分母), low = 毛利率黄线
import React, { useEffect, useState } from 'react';
import { Pct } from './DashBlocks.jsx';

const Chg = ({ now, base, bad }) => {
  if (base == null || !Number.isFinite(base) || base === 0 || now == null) return <span className="muted">—</span>;
  const d = (now - base) / Math.abs(base) * 100;
  if (Math.abs(d) < 0.5) return <span className="muted">持平</span>;
  const up = d > 0; const good = bad ? !up : up;
  return <span className={good ? 'pl-up' : 'pl-down'}>{up ? '▲' : '▼'} {Math.abs(d) >= 999 ? '>999' : Math.abs(d).toFixed(0)}%</span>;
};

const useNarrow = () => {
  const [n, set] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => { const h = () => set(window.innerWidth < 640); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);
  return n;
};
const HEAD = { loc: '本地备货', fob: 'FOB', all: '合计', pct: '占销售额', prev: '上期', chg: '变化' };

export default function PLTable({ c, prev, exps = [], expPrev = null, gpPct, low = 15, f, cur, note }) {
  // 手机上先看合计: 合计 / 占销售额 紧跟项目, 本地 / FOB 往右滑
  const order = useNarrow() ? ['all', 'pct', 'loc', 'fob', 'prev', 'chg'] : ['loc', 'fob', 'all', 'pct', 'prev', 'chg'];
  const expT = exps.reduce((a, e) => a + e.v, 0);
  const R = c.all.rev || 0;
  const share = (v) => <span className="muted">{R ? `${(v / R * 100).toFixed(1)}%` : '—'}</span>;
  const net = c.all.gp - expT; const netPrev = prev && expPrev != null ? prev.gp - expPrev : null;
  const netPct = R ? net / R * 100 : null;
  const num = (v, bold) => { const t = v == null ? '—' : f(v); const red = v != null && v < 0; return <span className={red ? 'red-t2' : ''}>{bold ? <b>{t}</b> : t}</span>; };
  const dash = <span className="muted">—</span>;
  const rows = [
    { k: 'rev', name: '销售额', cls: 'pl-b', loc: num(c.loc.rev, 1), fob: num(c.fob.rev, 1), all: num(R, 1), pct: <span className="muted">100%</span>, prev: num(prev?.rev), chg: <Chg now={R} base={prev?.rev} /> },
    { k: 'cost', name: '减：货的成本', cls: 'pl-ind', loc: num(c.loc.cost), fob: num(c.fob.cost), all: num(c.all.cost), pct: share(c.all.cost), prev: num(prev?.cost), chg: <Chg now={c.all.cost} base={prev?.cost} bad /> },
    { k: 'gp', name: '毛利', cls: 'pl-b pl-sep', loc: num(c.loc.gp, 1), fob: num(c.fob.gp, 1), all: num(c.all.gp, 1), pct: <Pct p={gpPct} low={low} />, prev: num(prev?.gp), chg: <Chg now={c.all.gp} base={prev?.gp} /> },
    { k: 'exp', name: '减：日常开支', cls: 'pl-ind', loc: dash, fob: dash, all: num(expT), pct: share(expT), prev: num(expPrev), chg: <Chg now={expT} base={expPrev} bad /> },
    ...exps.map((e) => ({ k: 'e:' + e.name, name: e.name, cls: 'pl-ind2', loc: null, fob: null, all: num(e.v), pct: share(e.v), prev: e.prev == null ? null : num(e.prev), chg: e.prev == null ? null : <Chg now={e.v} base={e.prev} bad /> })),
    { k: 'net', name: '净利', cls: 'pl-b pl-sep2', loc: dash, fob: dash, all: num(net, 1), pct: <Pct p={netPct} low={0} />, prev: num(netPrev), chg: <Chg now={net} base={netPrev} /> },
  ];
  return (
    <div className="pl-wrap">
      <table className="pl-t">
        <thead><tr><th>项目 <small>{cur}</small></th>{order.map((k) => <th key={k}>{HEAD[k]}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.k} className={r.cls}><th>{r.name}</th>{order.map((k) => <td key={k}>{r[k]}</td>)}</tr>)}</tbody>
      </table>
      {note && <div className="small muted pl-note">{note}</div>}
    </div>
  );
}
