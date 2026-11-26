// 利润表 (522, Frank 11-26: 标准损益表 —— 项目一行一行往下算, 本地 / FOB / 合计 / 占销售额 / 上期 / 变化 横着排)
// 看板「销售 ☰ 利润表」和月报「二、毛利与净利」共用. 不用 Grid: 这是报表, 不是要编辑的表.
// c = { loc: {rev, cost, gp}, fob: {...}, all: {...} }, prev = {rev, cost, gp} | null,
// exps = [{ name, v, prev? }], expPrev = 上期开支合计 | null, gpPct = 毛利率 (成本缺的不算进分母), low = 毛利率黄线
import React from 'react';
import { Pct } from './DashBlocks.jsx';

// 11-26 16:03 Frank: 横纵对调 —— 业务 (本地备货 / FOB / 合计) 竖着排, 销售额 − 成本 = 毛利 − 开支 = 净利 横着算
const COLS = [['rev', '销售额'], ['cost', '减：货的成本'], ['gp', '毛利'], ['gpPct', '毛利率'], ['exp', '减：日常开支'], ['net', '净利'], ['netPct', '净利率']];

export default function PLTable({ c, prev, exps = [], expPrev = null, gpPct, low = 15, f, cur, note }) {
  const expT = exps.reduce((a, e) => a + e.v, 0);
  const pc = (a, b) => (b ? a / b * 100 : null);
  const row = (x, e, pct) => ({ rev: x.rev, cost: x.cost, gp: x.gp, gpPct: pct ?? pc(x.gp, x.rev), exp: e, net: e == null ? null : x.gp - e, netPct: e == null ? null : pc(x.gp - e, x.rev) });
  const all = row(c.all, expT, gpPct);
  const pv = prev ? row(prev, expPrev, null) : null;
  const expTip = exps.length ? exps.map((e) => `${e.name} ${f(e.v)}`).join('\n') : '这段时间没有记开支';
  const cell = (k, v, bold, x) => {
    if (k === 'gpPct') return <Pct p={v} low={low} />;
    if (k === 'netPct') return v == null ? <span className="muted">—</span> : <Pct p={v} low={0} />;
    if (v == null) return <span className="muted">—</span>;
    const t = f(v); const el = <span className={v < 0 ? 'red-t2' : ''}>{bold ? <b>{t}</b> : t}</span>;
    return k === 'exp' && x === 'all' ? <span data-tip={expTip} className="pl-tipc">{el}</span> : el;
  };
  const Chg = ({ k }) => {
    if (!pv || k === 'gpPct' || k === 'netPct') {
      if (pv && (k === 'gpPct' || k === 'netPct') && all[k] != null && pv[k] != null) { const d = all[k] - pv[k]; return Math.abs(d) < 0.05 ? <span className="muted">持平</span> : <span className={d > 0 ? 'pl-up' : 'pl-down'}>{d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)} 个点</span>; }
      return <span className="muted">—</span>;
    }
    const now = all[k]; const base = pv[k];
    if (base == null || !base || now == null) return <span className="muted">—</span>;
    const d = (now - base) / Math.abs(base) * 100; if (Math.abs(d) < 0.5) return <span className="muted">持平</span>;
    const up = d > 0; const good = (k === 'cost' || k === 'exp') ? !up : up;
    return <span className={good ? 'pl-up' : 'pl-down'}>{up ? '▲' : '▼'} {Math.abs(d) >= 999 ? '>999' : Math.abs(d).toFixed(0)}%</span>;
  };
  const rows = [
    ['loc', '本地备货', row(c.loc, null), ''],
    ['fob', 'FOB', row(c.fob, null), ''],
    ['all', '合计', all, 'pl-b pl-sep'],
  ];
  return (
    <div className="pl-wrap">
      <table className="pl-t">
        <thead><tr><th><small>{cur}</small></th>{COLS.map(([k, l]) => <th key={k} className={k === 'gp' || k === 'net' ? 'pl-key' : ''}>{l}</th>)}</tr></thead>
        <tbody>
          {rows.map(([id, name, r, cls]) => <tr key={id} className={cls}><th>{name}</th>{COLS.map(([k]) => <td key={k} className={k === 'gp' || k === 'net' ? 'pl-key' : ''}>{cell(k, r[k], id === 'all' || k === 'gp' || k === 'net', id)}</td>)}</tr>)}
          {pv && <tr className="pl-prev"><th>上期</th>{COLS.map(([k]) => <td key={k}>{k === 'gpPct' || k === 'netPct' ? (pv[k] == null ? '—' : `${pv[k].toFixed(1)}%`) : pv[k] == null ? '—' : f(pv[k])}</td>)}</tr>}
          {pv && <tr className="pl-chg"><th>比上期</th>{COLS.map(([k]) => <td key={k}><Chg k={k} /></td>)}</tr>}
        </tbody>
      </table>
      {exps.length > 1 && <div className="small muted pl-note">日常开支：{exps.map((e) => `${e.name} ${f(e.v)}`).join(' · ')}</div>}
      {note && <div className="small muted pl-note">{note}</div>}
    </div>
  );
}
