import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, Light, Info, useApp, useData, DatePicker, Pill, useOutside } from '../components/ui.jsx';
import { ModelLink, CustLink, EmpLink , DealLink} from '../components/Archives.jsx';
import Grid from '../components/Grid.jsx';
import { money, qty, dt, dDate, periodRange, PERIODS, today } from '../lib/format.js';
import { SHIP_METHODS, PAY_METHODS, TIERS, STATUS, dealLight, stuckOf } from '../lib/domain.js';
import { balanceWords } from '../lib/domain.js';
import { todoFor, OverdueBar } from './Todo.jsx';
import { LayoutGrid, setLayoutEdit, useLayoutEdit } from '../components/Layout.jsx';

const N = (v) => Number(v || 0);
// 本地日期 (阿比让 = UTC)
const ymd = (v) => { if (!v) return ''; const x = v instanceof Date ? v : new Date(v); return isNaN(x) ? String(v).slice(0, 10) : x.toISOString().slice(0, 10); };
const shift = (d, days) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
function prevRange(from, to) { const len = Math.round((new Date(to) - new Date(from)) / 864e5) + 1; return [shift(from, -len), shift(from, -1)]; }
function Delta({ cur, prev, money: isMoney }) {
  cur = N(cur); prev = N(prev);
  if (!prev && !cur) return <span className="muted">上一期也是 0</span>;
  if (!prev) return <span className="up">上一期 0 → 新增</span>;
  const pct = Math.round((cur - prev) / prev * 100);
  return <span className={pct >= 0 ? 'up' : 'down'}>{pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}%<span className="muted">（上一期 {isMoney ? money(prev) : prev}）</span></span>;
}

const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };

export default function Dashboard() {
  const { org, go, role } = useApp();
  const [period, setPeriodS] = useState(() => store.get('la9s.dash.period', 'month'));
  const [custom, setCustom] = useState(() => store.get('la9s.dash.custom', [today(), today()]));
  const [panel, setPanelS] = useState(() => store.get('la9s.dash.panel', 'sales'));
  const setPeriod = (p) => { setPeriodS(p); store.set('la9s.dash.period', p); };
  const setPanel = (p) => { setPanelS(p); store.set('la9s.dash.panel', p); };
  const [from, to] = period === 'custom' ? custom : periodRange(period);

  const [pf, pt] = prevRange(from, to);
  const edit = useLayoutEdit();
  const { data } = useData(async () => {
    const [k] = await q(Q.dashboard, [org, from, to]);
    const [sales, wh, rc, bal, orders, [cards], cmp] = await Promise.all([q(Q.dashSales, [org, from, to]), q(Q.dashWarehouse, [org, from, to]),
      q(Q.receipts, [org, from, to]), q(Q.balances, [org]), q(Q.orders, [org, '2000-01-01', '2999-12-31']), q(Q.dashCards, [org, from, to, pf, pt]), q(Q.customerCompare, [org])]);
    return { k, sales, wh, rc, bal, orders, cards, cmp };
  }, [org, from, to]);

  const k = data?.k; const c = data?.cards;
  const periodLabel = PERIODS.find((p) => p[0] === period)[1];
  const lightN = { active: 0, done: 0, cancelled: 0 };
  for (const d of (data?.orders || [])) { const cd = ymd(d.created_at); if (cd >= from && cd <= to) lightN[dealLight(d)] += 1; }
  const jumpCompare = () => document.getElementById('cust-compare')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const blocks = !data ? [] : [
    { id: 'overdue', title: '超期未发货（常开）', span: 12, locked: true, render: () => <OverdueBar orders={data.orders} go={go} compact /> },
    { id: 'kpis', title: '四个数：销售 / 收款 / 欠款 / 订单状态', span: 12, render: () => (
      <div className="kpis k4">
        <button type="button" className="kpi" onClick={() => go('orders')}>
          <div className="t"><span>销售（出库金额）</span><span>↗</span></div>
          <div className="v">{money(k.sales_amount)}<small>XOF</small></div>
          <div className="f"><span>出库 <b>{qty(k.sales_qty)}</b> 件 · <b>{k.order_count}</b> 单</span><Delta cur={c.sales} prev={c.sales_prev} money /></div>
        </button>
        <button type="button" className="kpi" onClick={() => go('receipts')}>
          <div className="t"><span>收款</span><span>↙</span></div>
          <div className="v">{money(k.receipts_amount)}<small>XOF</small></div>
          <div className="f"><span><b>{data.rc.length}</b> 笔</span><span>收款与冲账 →</span></div>
        </button>
        <button type="button" className="kpi" onClick={() => go('balances')}>
          <div className="t"><span>客户欠款（全部历史）</span><span>!</span></div>
          <div className="v">{money(k.debt_total)}<small>XOF</small></div>
          <div className="f"><span><b>{k.debtor_count}</b> 位客户欠款</span><span>客户总账 →</span></div>
        </button>
        <div className="kpi">
          <div className="t"><span>订单状态</span><Info>只数这个时间段里开的单。进行中 = 还没走完；已完成 = 已出库、已签收、已收清、没有没对完账的退货；已取消 = 作废。点颜色到订单总览看这些单。</Info></div>
          <div className="lights">{['active', 'done', 'cancelled'].map((v) => (
            <button type="button" key={v} onClick={() => { try { sessionStorage.setItem('la9s.orders.jump', JSON.stringify({ light: v, from, to })); } catch { /* */ } go('orders'); }}>
              <Light v={v} /><b>{lightN[v]}</b></button>))}</div>
          <div className="f"><span>共 <b>{lightN.active + lightN.done + lightN.cancelled}</b> 单</span><span>点颜色看单 →</span></div>
        </div>
      </div>) },
    { id: 'mine', title: '要你处理的', span: 6, render: () => <TodoStrip orders={data.orders} role={role} go={go} /> },
    { id: 'trend', title: '销售趋势', span: 6, render: () => <Trend rows={data.sales} from={from} to={to} /> },
    { id: 'more', title: '更多（仓库 / 销售工作 / 热线 / 客户）', span: 12, render: () => (
      <details className="more-box"><summary>更多：仓库 · 销售工作 · 热线 · 客户对比</summary>
        <div className="more-grid">{more.map((m) => <React.Fragment key={m.id}>{m.render()}</React.Fragment>)}</div>
        <div style={{ marginTop: 12 }}><CustomerCompare rows={data.cmp} go={go} /></div>
      </details>) },
  ];
  const more = !data ? [] : [
    { id: 'c_wh', title: '仓库经营', span: 3, render: () => (
      <div className="dcard">
        <div className="h"><span>仓库</span><button type="button" className="btn sm ghost" onClick={() => go('stock')}>库存 →</button></div>
        <div className="big">{role === 'admin' && N(c.stock_value) ? money(c.stock_value) : qty(c.stock_pcs)}<small>{role === 'admin' && N(c.stock_value) ? 'XOF 成本' : '件在库'}</small></div>
        <div className="cmp">LA + 9S 在库 <b>{qty(c.stock_pcs)}</b> 件 · <b>{c.stock_sku}</b> 个编码{role === 'admin' && N(c.stock_pcs_nocost) > 0 && N(c.stock_value) > 0 ? <span className="muted">（{qty(c.stock_pcs_nocost)} 件没成本，没算进金额）</span> : ''}</div>
        <div className="rows"><span>待出库 / 找货中<b>{c.to_ship} / {c.in_picking}</b></span>
          <span>呆滞（库龄 180 天以上）<b>{c.aging_as_of ? `${qty(c.stale_pcs)} 件` : '没导库龄'}</b></span></div>
        <div className="warn"><button type="button" onClick={() => go('replenish')}>⚠ 库存危机：判定规则还没定 → 先看备货看板</button></div>
      </div>) },
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
  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">LA&9S / Votre partenaire</div>
          <h1>经营总览</h1>
          <div className="sub">{from === to ? from : `${from} — ${to}`} · {periodLabel}<span className="muted">（对比上一期 {pf} — {pt}）</span></div>
        </div>
        <div className="row">
          <div className="seg">
            {PERIODS.map(([key, label]) => <button type="button" key={key} className={period === key ? 'on' : ''} onClick={() => setPeriod(key)}>{label}</button>)}
          </div>
          {period === 'custom' && <DatePicker range value={custom} align="right" onChange={(v) => { setCustom(v); store.set('la9s.dash.custom', v); }} />}
          {role === 'admin' && <button type="button" className={`btn sm ${edit ? 'primary' : ''}`} onClick={() => setLayoutEdit(!edit)} title="选看板上出现哪些模块、顺序、宽度">⚙ 配置看板</button>}
        </div>
      </div>
      {!data ? <div className="empty">加载中…</div> : <LayoutGrid page="dashboard" blocks={blocks} />}
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

function TodoStrip({ orders, role, go }) {
  const all = orders.filter((d) => todoFor(role, d)); const list = all.slice(0, 8);
  return (
    <div className="card">
      <div className="card-h"><h2>要你处理的 <span className="muted small">{all.length} 单</span></h2><button type="button" className="btn sm" onClick={() => go('todo')}>全部待办 →</button></div>
      {list.length === 0 ? <div className="empty">当前岗位没有待办 ✓</div> : list.map((d) => (
        <div key={d.id} className="row between" style={{ padding: '10px 18px', borderBottom: '1px solid var(--line-2)', cursor: 'pointer' }} onClick={() => go('deal/' + d.id)}>
          <div><CustLink id={d.customer_id} name={d.customer_name} /> <span className="muted small">{d.city} · </span><DealLink id={d.id} no={d.biz_no} /></div>
          <div className="row"><span className="small muted">卡在：{stuckOf(d)}</span><span className="muted">›</span></div>
        </div>
      ))}
    </div>
  );
}

// 销售趋势: 期内每天出库金额 (一张图, 11-09 看板重做)
function Trend({ rows, from, to }) {
  const days = []; for (let d = from; d <= to && days.length < 400; d = shift(d, 1)) days.push(d);
  const by = {}; for (const r of rows) { const d = ymd(r.shipped_at); by[d] = (by[d] || 0) + N(r.amount); }
  const step = days.length > 62 ? 7 : 1;   // 超过两个月按周合并
  const pts = []; for (let i = 0; i < days.length; i += step) pts.push({ d: days[i], v: days.slice(i, i + step).reduce((a, x) => a + (by[x] || 0), 0) });
  const max = Math.max(1, ...pts.map((p) => p.v)); const W = 600, H = 150, bw = W / Math.max(1, pts.length);
  const [hov, setHov] = useState(null);
  return (
    <div className="card">
      <div className="card-h"><h2>销售趋势 <span className="muted small">每{step === 7 ? '周' : '天'}出库金额 XOF</span></h2>{hov && <span className="small"><b>{hov.d}</b>{step === 7 ? ' 起一周' : ''} · {money(hov.v)} XOF</span>}</div>
      <div className="card-b">
        {rows.length === 0 ? <div className="muted small">这个时间段还没有出库</div> : (
          <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: 180 }} onMouseLeave={() => setHov(null)}>
            <line x1="0" x2={W} y1={H} y2={H} stroke="#e3e8ef" />
            {pts.map((p, i) => { const h = p.v / max * (H - 8); return (
              <rect key={p.d} x={i * bw + bw * 0.15} y={H - h} width={Math.max(1, bw * 0.7)} height={h} rx="2" fill={hov?.d === p.d ? '#1f5fd1' : '#8fb0e8'} onMouseEnter={() => setHov(p)} />); })}
            <text x="0" y={H + 14} fontSize="11" fill="#8a94a6">{pts[0]?.d}</text>
            <text x={W} y={H + 14} fontSize="11" fill="#8a94a6" textAnchor="end">{pts[pts.length - 1]?.d}</text>
            <text x="0" y="10" fontSize="11" fill="#8a94a6">{money(max)}</text>
          </svg>)}
      </div>
    </div>
  );
}
