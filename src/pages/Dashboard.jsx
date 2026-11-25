import React, { useCallback, useEffect, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, useApp, useData, Pill, usePeriod, PeriodBar } from '../components/ui.jsx';
import { useRuleValues, ruleNum, ruleVal } from '../components/Rules.jsx';
import Grid from '../components/Grid.jsx';
import { money, qty, dDate } from '../lib/format.js';
import { TIERS } from '../lib/domain.js';
import { LayoutGrid, setLayoutEdit, useLayoutEdit } from '../components/Layout.jsx';
import { useDashAll } from '../components/DashBlocks.jsx';
import { SalesSec, StockSec, AcctSec, PeopleSec, Attention } from '../components/Dash2.jsx';

const N = (v) => Number(v || 0);
const shift = (d, days) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
function prevRange(from, to) { const len = Math.round((new Date(to) - new Date(from)) / 864e5) + 1; return [shift(from, -len), shift(from, -1)]; }
function Delta({ cur, prev, money: isMoney }) {
  cur = N(cur); prev = N(prev);
  if (!prev && !cur) return <span className="muted">上一期也是 0</span>;
  if (!prev) return <span className="up">上一期 0 → 新增</span>;
  const pct = Math.round((cur - prev) / prev * 100);
  return <span className={pct >= 0 ? 'up' : 'down'}>{pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}%<span className="muted">（上一期 {isMoney ? money(prev) : prev}）</span></span>;
}

// 426–437 (Frank 11-19): 经营总览重做 —— 紧急待办一行 → 总览 → 本地 → FOB → 账款 → 人 → 更多. 大板块和板块里的小卡片顺序中方可调 (437).
export default function Dashboard() {
  const { org, go, role, tick } = useApp();
  const P = usePeriod('dash'); const { from, to } = P;
  const [pf, pt] = prevRange(from, to);
  const edit = useLayoutEdit();
  const admin = role === 'admin';
  const all = useDashAll();
  const [alerts, setAlerts] = useState({});
  const onAlert = useCallback((k, list) => setAlerts((a) => (JSON.stringify(a[k] || []) === JSON.stringify(list) ? a : { ...a, [k]: list })), []);
  // 11-25: 仓库 / 盘点这条链上要注意的也进「要你注意的」(盘点进行中、盘点金蝶待录、找货选了库位但库位空了 → 先不做)
  const { data: ops } = useData(async () => q(`select (select count(*) from app.counts where org_id = $1 and status = 'open')::int as open_cnt,
      (select count(*) from app.counts c where c.org_id = $1 and c.status = 'closed' and c.kd_done_at is null and exists (select 1 from app.count_diffs d where d.count_id = c.id and d.diff <> 0))::int as kd_cnt,
      (select r.rate from app.remittances r where r.org_id = $1 and r.currency = 'CNY' and r.on_date >= current_date - 60 order by r.on_date desc, r.created_at desc limit 1) as remit_rate,
      (select r.on_date from app.remittances r where r.org_id = $1 and r.currency = 'CNY' and r.on_date >= current_date - 60 order by r.on_date desc, r.created_at desc limit 1) as remit_on,
      (select sum(r.amount_out) / nullif(sum(r.expected), 0) from app.remittances r where r.org_id = $1 and r.currency = 'CNY' and r.on_date >= current_date - 30) as remit_avg30,
      (select rmb_per_xof from app.price_settings where org_id = $1) as rmb_per_xof`, [org]).then((r) => r[0]).catch(() => null), [org, tick]);
  const rvD = useRuleValues(['price.rate_drift', 'price.rate_basis']); const driftLim = ruleNum(rvD, 'price.rate_drift'); const basis = ruleVal(rvD, 'price.rate_basis');
  // 329: 定价汇率 (1 CNY = 1/rmb_per_xof XOF) 和最近一笔汇回的实际汇率差太多 → 提醒调定价 (实际更贵 = 定价按旧汇率会少赚)
  const priceRate = Number(ops?.rmb_per_xof) > 0 ? 1 / Number(ops.rmb_per_xof) : 0; const lastRate = Number(ops?.remit_rate) || 0; const avgRate = Number(ops?.remit_avg30) || 0; const realRate = (basis === 'last' ? lastRate : avgRate || lastRate);
  const drift = priceRate && realRate ? ((realRate - priceRate) / priceRate) * 100 : 0;
  useEffect(() => { if (!ops) return; onAlert('ops', [...(Math.abs(drift) >= driftLim && driftLim > 0 ? [{ tone: drift > 0 ? 'red' : 'amber', text: `汇率变了 ${drift > 0 ? '+' : ''}${drift.toFixed(1)}%：定价 1 CNY = ${priceRate.toFixed(1)} XOF，最近一笔 ${lastRate ? lastRate.toFixed(1) : '—'} · 30 天平均 ${avgRate ? avgRate.toFixed(1) : '—'}（按${basis === 'last' ? '最近一笔' : '平均'}比）`, go: 'pricing' }] : []), ...(ops.open_cnt ? [{ tone: 'red', text: '正在盘点 · 出货暂停', go: 'count' }] : []), ...(ops.kd_cnt ? [{ tone: 'amber', text: `${ops.kd_cnt} 次盘点金蝶没录完`, go: 'count' }] : [])]); }, [ops, onAlert, drift, driftLim, realRate, priceRate, lastRate, avgRate, basis]);
  const { data } = useData(async () => {
    const [[k], rc, bal, [cards], cmp, fobs] = await Promise.all([q(Q.dashboard, [org, from, to]), q(Q.receipts, [org, from, to]), q(Q.balances, [org]),
      q(Q.dashCards, [org, from, to, pf, pt]), q(Q.customerCompare, [org]), q(Q.fobList, [org]).catch(() => [])]);
    return { k, rc, bal, cards, cmp, fobs };
  }, [org, from, to]);
  const k = data?.k; const c = data?.cards;
  const jumpCompare = () => document.getElementById('cust-compare')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const transit = (data?.fobs || []).filter((f) => ['applied', 'purchasing', 'in_transit', 'arrived', 'released'].includes(f.status));
  const fobTransit = { n: transit.length, paid: transit.filter((f) => N(f.paid) > 0).length };   // 438: 紧急待办那行不放了 (进待办看); FOB 在途挪进 FOB 板块的小方框
  const more = !data ? [] : [
    { id: 'c_sales', title: '销售工作', span: 3, render: () => (
      <div className="dcard">
        <div className="h"><span>销售工作</span><button type="button" className="btn sm ghost" onClick={() => go('visits')}>拜访 →</button></div>
        <div className="big">{c.visits}<small>次拜访</small></div>
        <div className="cmp"><Delta cur={c.visits} prev={c.visits_prev} /></div>
        <div className="rows"><span>当场下单 / 要报价<b>{c.visits_won}</b></span><span>有兴趣<b>{c.visits_interested}</b></span>
          <span>转化率<b>{N(c.visits) ? Math.round(N(c.visits_won) / N(c.visits) * 100) + '%' : '—'}</b></span></div>
        <div className="warn"><button type="button" className={N(c.late_today) + N(c.offsite_today) ? '' : 'ok'} onClick={() => go('attendance')}>
          今天打卡 {c.clock_today} 人{N(c.late_today) ? ` · 迟到 ${c.late_today}` : ''}{N(c.offsite_today) ? ` · 不在规定地点 ${c.offsite_today}` : ''}{!N(c.late_today) && !N(c.offsite_today) ? ' · 没有异常' : ''} →</button></div>
      </div>) },
    { id: 'c_hot', title: '热线工作', span: 3, render: () => (
      <div className="dcard">
        <div className="h"><span>热线</span><button type="button" className="btn sm ghost" onClick={() => go('hotline')}>回访 →</button></div>
        <div className="big">{c.calls}<small>次联系</small></div>
        <div className="cmp"><Delta cur={c.calls} prev={c.calls_prev} /></div>
        <div className="rows"><span>促成下单<b>{c.calls_order}</b></span><span>没接 / 占线<b>{c.calls_missed}</b></span><span>今天要回访<b>{c.follow_today}</b></span></div>
        <div className="warn"><button type="button" className={N(c.follow_late) ? '' : 'ok'} onClick={() => go('hotline')}>{N(c.follow_late) ? `⚠ ${c.follow_late} 位客户约好回访但过期没回 →` : '✓ 没有过期没回访的客户'}</button></div>
      </div>) },
    { id: 'c_cust', title: '客户销售', span: 3, render: () => (
      <div className="dcard">
        <div className="h"><span>客户</span><button type="button" className="btn sm ghost" onClick={() => go('customers')}>客户档案 →</button></div>
        <div className="big">{c.buyers}<small>位客户有出库</small></div>
        <div className="cmp"><Delta cur={c.buyers} prev={c.buyers_prev} /></div>
        <div className="rows"><span>出库金额<b>{money(c.sales)}</b></span><span className="cmp" style={{ justifyContent: 'flex-end' }}><Delta cur={c.sales} prev={c.sales_prev} money /></span></div>
        <div className="warn"><button type="button" className={N(c.cust_down) + N(c.cust_silent) ? '' : 'ok'} onClick={jumpCompare}>
          {N(c.cust_down) + N(c.cust_silent) ? `⚠ 掉量 ≥30%：${c.cust_down} 位 · 30 天没下单：${c.cust_silent} 位 →` : '✓ 没有掉量的老客户'}</button></div>
      </div>) },
  ];
  const blocks = !data ? [] : [
    ...(admin ? [
      { id: 'ov', title: '销售', span: 12, render: () => (all ? <SalesSec all={all} from={from} to={to} transit={fobTransit} onAlert={onAlert} /> : <div className="d2-card muted small">加载中…</div>) },
      { id: 'stock', title: '库存', span: 12, render: () => <StockSec all={all} onAlert={onAlert} /> },
    ] : [
      // 员工看不到成本 / 利润: 只有销售额和件数
      { id: 'ov', title: '销售', span: 12, render: () => (
        <div className="d2-sec"><div className="d2-card"><div className="d2-h"><span className="t">销售</span><span className="s">已经出库的</span></div>
          <div className="d2-hero"><div className="d2-m main"><span className="k">销售额</span><span className="v"><b>{money(k.sales_amount)}</b><u>XOF</u></span><span className="d">{qty(k.sales_qty)} 片 · {k.order_count} 单</span></div></div>
          <div className="d2-foot"><div className="f" /></div></div></div>) }]),
    { id: 'money', title: '账款', span: 12, render: () => <AcctSec bal={data.bal} rc={data.rc} fobs={data.fobs} ship={c.sales} from={from} to={to} label={P.label} onAlert={onAlert} /> },
    { id: 'people', title: '人员', span: 12, render: () => <PeopleSec all={all} from={from} to={to} label={P.label} cards={c} cmp={data.cmp} onAlert={onAlert} /> },
    { id: 'more', title: '更多（销售工作 / 热线 / 客户）', span: 12, render: () => (
      <details className="more-box"><summary>更多：销售工作 · 热线 · 客户对比</summary>
        <div className="more-grid">{more.map((m) => <React.Fragment key={m.id}>{m.render()}</React.Fragment>)}</div>
        <div style={{ marginTop: 12 }}><CustomerCompare rows={data.cmp} go={go} /></div>
      </details>) },
  ];
  return (
    <>
      <div className="pagehead">
        <div><div className="eyebrow">LA&9S / Votre partenaire</div><h1>经营总览</h1></div>
        <PeriodBar p={P}>
          {admin && <button type="button" className={`btn sm ${edit ? 'primary' : ''}`} onClick={() => setLayoutEdit(!edit)} title="大板块和板块里小卡片的顺序、宽度、显示不显示（全员一样）">⚙ 配置看板</button>}
        </PeriodBar>
      </div>
      {data && <Attention alerts={alerts} />}
      {!data ? <div className="empty">加载中…</div> : <LayoutGrid page="dash" blocks={blocks} />}
    </>
  );
}

// 客户购买对比 (Frank 11-01): 本月 / 上月 / 月均, 掉量 ≥30% 和 30 天没下单的标出来
function CustomerCompare({ rows, go }) {
  const [only, setOnly] = useState(false);
  const flag = (r) => { const d30 = N(r.d30), a = N(r.avg3); const silent = r.last_at && new Date(r.last_at) < new Date(Date.now() - 30 * 864e5);
    return silent ? 'silent' : a > 0 && d30 < a * 0.7 ? 'down' : a > 0 && d30 > a * 1.3 ? 'up' : ''; };
  const list = only ? rows.filter((r) => ['silent', 'down'].includes(flag(r))) : rows;
  const cols = [
    { key: 'code', label: '客户编码', w: 80 },
    { key: 'name', label: '客户', w: 180, render: (r) => <>{r.name} <span className="muted small">{r.city}</span></> },
    { key: 'tier', label: '档位', w: 90, value: (r) => TIERS[r.tier] || '', render: (r) => <TierPill tier={r.tier} /> },
    { key: 'this_month', label: '本月金额', w: 110, type: 'money', value: (r) => N(r.this_month), render: (r) => money(r.this_month) },
    { key: 'last_month', label: '上月金额', w: 110, type: 'money', value: (r) => N(r.last_month), render: (r) => money(r.last_month) },
    { key: 'avg3', label: '前 3 个月月均', w: 120, type: 'money', value: (r) => N(r.avg3), render: (r) => money(Math.round(N(r.avg3))) },
    { key: 'd30', label: '近 30 天金额', w: 110, type: 'money', value: (r) => N(r.d30), render: (r) => <b>{money(r.d30)}</b> },
    { key: 'chg', label: '近 30 天 vs 月均', w: 120, type: 'number', value: (r) => (N(r.avg3) ? Math.round((N(r.d30) - N(r.avg3)) / N(r.avg3) * 100) : null),
      render: (r) => (N(r.avg3) ? <span className={N(r.d30) >= N(r.avg3) ? 'up' : 'down'}>{N(r.d30) >= N(r.avg3) ? '▲' : '▼'} {Math.abs(Math.round((N(r.d30) - N(r.avg3)) / N(r.avg3) * 100))}%</span> : <span className="muted">新客户</span>) },
    { key: 'last_at', label: '最近出库', w: 100, render: (r) => dDate(r.last_at) },
    { key: 'flag', label: '提醒', w: 120, value: (r) => ({ silent: '30 天没下单', down: '掉量 ≥30%', up: '涨 ≥30%' })[flag(r)] || '',
      render: (r) => ({ silent: <Pill tone="red">30 天没下单</Pill>, down: <Pill tone="amber">掉量 ≥30%</Pill>, up: <Pill tone="green">涨 ≥30%</Pill> })[flag(r)] || '' },
  ];
  return (
    <div className="card" id="cust-compare">
      <div className="card-h"><h2>客户购买对比 <span className="muted small">只算系统里的出库（XOF）；月均 = 30 天前往回 3 个月</span></h2>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />只看要关注的</label></div>
      <Grid id="dash-cmp" columns={cols} rows={list} onRowClick={(r) => go('customer/' + r.id)} maxHeight={420}
        empty={rows.length ? '没有要关注的客户 ✓' : '系统里还没有客户出库记录（金蝶历史只有按编码的月销量，没有按客户的，所以这里先空着）'} />
    </div>
  );
}
