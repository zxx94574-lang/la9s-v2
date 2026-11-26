// 328 (Frank 11-16): 订单毛利 / 利润 —— 只中方看 (SQL 里 app.margin_rows 等也只给 admin, 前端只是不显示)
// 口径: 出库那一刻锁成本; 事后变动 (退货、差异冲减 / 抹零 / 核销、价格调整、我们出的运费、我们承担的手续费) 全扣;
//       毛利率 = 利润 ÷ 销售额, 汇总一律加权 (先加总再除); 没有成本的行不进毛利率, 单独标「成本缺失」.
import React, { useMemo } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Info } from './ui.jsx';
import Grid from './Grid.jsx';
import { money, qty } from '../lib/format.js';

const N = (v) => Number(v || 0);
export const TIER_LABEL = { S: 'S', WHOLESALE: 'Wholesale', RETAIL: 'Retail', REPAIR: 'Repair' };

// 规则参数: 毛利率低于多少算「要留意」(黄)，负数一律红
export function useMarginRules() {
  const { org, tick } = useApp();
  const { data } = useData(() => q(`select value from app.org_settings where org_id = $1 and key = 'margin_rules'`, [org]), [org, tick]);
  return { lowPct: Number(data?.[0]?.value?.low_pct ?? 10) };
}

// 一组行加起来 (加权): 有成本的才进毛利率
export function sumMargin(rows) {
  const t = { qty: 0, revenue: 0, cost: 0, profit: 0, revKnown: 0, missingRev: 0, missingQty: 0, sale: 0, returned: 0, adjust: 0, freight: 0, fee: 0, goods: 0, n: rows.length };
  for (const r of rows) {
    t.qty += N(r.qty); t.revenue += N(r.revenue); t.sale += N(r.sale); t.returned += N(r.returned); t.adjust += N(r.adjust);
    t.freight += N(r.freight); t.fee += N(r.fee);
    if (r.cost_missing) { t.missingRev += N(r.revenue); t.missingQty += N(r.qty); continue; }
    t.revKnown += N(r.revenue); t.cost += N(r.cost); t.profit += N(r.profit); t.goods += N(r.cost_goods);
  }
  t.pct = t.revKnown ? (t.profit / t.revKnown) * 100 : null;
  t.cover = t.revenue ? (t.revKnown / t.revenue) * 100 : null;
  return t;
}

// 毛利率小块: 负 = 红, 低于设定 = 黄, 其余绿 (Frank 三色规则)
export function MarginPill({ pct, lowPct = 10, missing, big }) {
  if (missing) return <span className="pill gray">成本缺失</span>;
  if (pct == null || !Number.isFinite(pct)) return <span className="muted small">—</span>;
  const tone = pct < 0 ? 'red' : pct < lowPct ? 'amber' : 'green';
  return big ? <span className={`pill dk-pct ${tone}`}>{pct.toFixed(1)}<small>%</small></span> : <span className={`pill ${tone}`}>{pct.toFixed(1)}%</span>;
}

export const marginCols = (lowPct) => [
  { key: 'qty', label: '数量', w: 80, type: 'number', render: (r) => qty(r.qty) },
  { key: 'revenue', label: '销售额', w: 120, type: 'number', render: (r) => money(r.revenue) },
  { key: 'cost', label: '成本', w: 120, type: 'number', value: (r) => (r.cost_missing ? null : r.cost), render: (r) => (r.cost_missing ? <span className="muted small">—</span> : money(r.cost)) },
  { key: 'profit', label: '利润', w: 120, type: 'number', value: (r) => (r.cost_missing ? null : r.profit), render: (r) => (r.cost_missing ? '' : <b className={N(r.profit) < 0 ? 'red-t2' : ''}>{money(r.profit)}</b>) },
  { key: 'pct', label: '毛利率', w: 100, type: 'number', value: (r) => (r.cost_missing || !N(r.revenue) ? null : (N(r.profit) / N(r.revenue)) * 100),
    render: (r) => <MarginPill missing={r.cost_missing} pct={N(r.revenue) ? (N(r.profit) / N(r.revenue)) * 100 : null} lowPct={lowPct} /> },
];

// 汇总那一排数字 (订单页 / 毛利页 / 看板共用)
export function MarginKpis({ t, lowPct, compact, freightOut }) {   // freightOut: 毛利分析页 —— 运费不在成本里, 算日常开支 (523)
  const cell = (k, v, sub) => (
    <div className={`mkpi ${compact ? 'sm' : ''}`}><div className="k">{k}</div><div className="v">{v}</div>{sub && <div className="s">{sub}</div>}</div>);
  return (
    <div className="mkpis">
      {cell('销售额', money(Math.round(t.revenue)), t.returned || t.adjust ? `原 ${money(Math.round(t.sale))}${t.returned ? ` · 退货 −${money(Math.round(t.returned))}` : ''}${t.adjust ? ` · 调整 / 核销 ${t.adjust < 0 ? '−' : '+'}${money(Math.abs(Math.round(t.adjust)))}` : ''}` : null)}
      {cell('成本', money(Math.round(t.cost)), t.freight || t.fee ? `货 ${money(Math.round(t.goods))}${t.freight ? (freightOut ? ` · 运费 ${money(Math.round(t.freight))} 算开支，没扣` : ` · 运费 ${money(Math.round(t.freight))}`) : ''}${t.fee ? ` · 手续费 ${money(Math.round(t.fee))}` : ''}` : null)}
      {cell('利润', <span className={t.profit < 0 ? 'red-t2' : ''}>{money(Math.round(t.profit))}</span>)}
      {cell('毛利率', <MarginPill pct={t.pct} lowPct={lowPct} big />, t.cover != null && t.cover < 99.5 ? `只算有成本的 ${t.cover.toFixed(0)}% 销售额` : null)}
      {cell('数量', qty(t.qty), t.missingQty ? `${qty(t.missingQty)} 片成本缺失` : null)}
    </div>
  );
}

// 订单页: 整单毛利 + 每个型号的毛利. 出过库 = 实际 (锁定成本 + 事后变动); 还没出库 = 按现在成本预估
// 减法巡检 C2 (11-17): 平时只在订单头部显示一个小块 (毛利率), 点开才展开整张卡; 亏钱时自动展开 (Frank 344: 亏钱 = 重中之重)
export function useDealMargin(deal) {
  const { role, tick } = useApp();
  const { lowPct } = useMarginRules();
  const shipped = !!deal && ['partial', 'shipped'].includes(deal.status);
  const { data, error } = useData(() => (role !== 'admin' || !deal || deal.status === 'cancelled' ? Promise.resolve(null)
    : shipped ? call(role, `select * from app.margin_rows($1, $2)`, [deal.org_id, deal.id])
      : call(role, `select * from app.deal_margin_estimate($1)`, [deal.id])), [deal?.id, deal?.status, deal?.version, role, tick]);
  return useMemo(() => {
    if (role !== 'admin' || !data || error) return null;
    const rows = shipped ? data : data.map((r) => ({ ...r, id: r.deal_line_id, revenue: r.sale, cost_missing: r.unit_cost == null, cost_goods: r.cost }));
    if (!rows.length) return null;
    const t = sumMargin(rows);
    const byLine = {};   // 同一个型号分几次出库 → 合成一行
    for (const r of rows) {
      const k = `${r.category}|${r.model}`;
      const a = (byLine[k] ||= { id: k, model: r.model, category: r.category, qty: 0, revenue: 0, cost: 0, profit: 0, freight: 0, fee: 0, returned: 0, cost_missing: false, unit_cost: r.unit_cost });
      a.qty += N(r.qty); a.revenue += N(r.revenue); a.cost += N(r.cost); a.profit += N(r.profit); a.freight += N(r.freight); a.fee += N(r.fee); a.returned += N(r.returned);
      a.cost_missing = a.cost_missing || !!r.cost_missing;
    }
    const lines = Object.values(byLine);
    return { t, lines, shipped, lowPct, loss: t.revKnown > 0 && (t.profit < 0 || lines.some((l) => !l.cost_missing && l.profit < 0)) };
  }, [data, error, role, shipped, lowPct]);
}

// 订单头部的小块: 「毛利 12.3% ▸」; 亏了 = 红色「亏 −4,950」
export function DealMarginChip({ m, open, onToggle }) {
  if (!m) return null;
  const { t, lowPct, shipped } = m;
  return (
    <button type="button" className={`margin-chip ${m.loss ? 'loss' : ''}`} aria-expanded={open} onClick={onToggle}
      title={`${shipped ? '毛利（已出库）' : '毛利（预估）'} · 只有中方看得到 · 点开看每个型号`}>
      <span className="k">{shipped ? '毛利' : '毛利（预估）'}</span>
      <MarginPill pct={t.pct} lowPct={lowPct} missing={!t.revKnown} />
      {t.revKnown > 0 && <b className={t.profit < 0 ? 'red-t2' : ''}>{money(Math.round(t.profit))}</b>}
      {m.loss && t.profit >= 0 && <span className="pill red">有型号亏钱</span>}
      <span className="caret">{open ? '▾' : '▸'}</span>
    </button>
  );
}

export function DealMarginCard({ m }) {
  if (!m) return null;
  const { t, lines, shipped, lowPct } = m;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>{shipped ? '毛利（已出库）' : '毛利（预估）'}</h2><span className="pill gray">只有中方看得到</span>
        <Info>{shipped
          ? '成本在出库那一刻锁定（当时的到岸成本，含物流）。退货、收货差异冲减、抹零 / 核销、我们出的运费、我们承担的收款手续费都已经算进来；整单的运费 / 手续费按各型号销售额比例分摊。毛利率 = 利润 ÷ 销售额。'
          : '还没出库：按现在的到岸成本和单价预估，出库那一刻才锁定。有实际供货数量的按供货算，没有的按需求数量算。'}</Info></div>
      <div className="card-b">
        <MarginKpis t={t} lowPct={lowPct} compact />
        <Grid id="deal-margin" compactTools rows={lines} columns={[
          { key: 'model', label: '型号', w: 120, render: (r) => <b>{r.model}</b> },
          { key: 'category', label: '种类', w: 90 },
          ...marginCols(lowPct),
          { key: 'unit', label: '每片利润', w: 100, type: 'number', value: (r) => (r.cost_missing || !r.qty ? null : r.profit / r.qty), render: (r) => (r.cost_missing || !r.qty ? '' : money(Math.round(r.profit / r.qty))) },
        ]} />
      </div>
    </div>
  );
}
