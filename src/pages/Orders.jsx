import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, Light, useApp, useData, Pill, DatePicker, useOutside } from '../components/ui.jsx';
import { call } from '../db/client.js';
import { friendlyError, dDate, today } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';
import Grid from '../components/Grid.jsx';
import Inquiry from './Inquiry.jsx';
import { STATUS, TIERS, seesPrice, can, dealLight, stuckOf, LIGHT_LABEL } from '../lib/domain.js';
import { money, qty, dt, periodRange, PERIODS } from '../lib/format.js';

const GROUPS = [['', '全部状态'], ['open', '进行中'], ['quoted,hotline_ok', '只报价'], ['picking,picked', '找货中'], ['ordered', '待客户确认'], ['confirmed,reviewed', '待复检 / 待出库'], ['partial,shipped', '已出库'], ['unpaid', '已出库未收清'], ['cancelled', '已作废']];

export default function Orders() {
  const { org, go, role } = useApp();
  // 看板上点某个颜色跳过来: 带时间段 + 灯色 (一次性)
  const [jump] = useState(() => { try { const j = JSON.parse(sessionStorage.getItem('la9s.orders.jump')); sessionStorage.removeItem('la9s.orders.jump'); return j; } catch { return null; } });
  const [period, setPeriod] = useState(jump ? 'custom' : 'year');
  const [custom, setCustom] = useState(jump ? [jump.from, jump.to] : periodRange('month'));
  const [from, to] = period === 'custom' ? custom : periodRange(period);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [tier, setTier] = useState('');
  const [grp, setGrp] = useState('');
  const [light, setLight] = useState(jump?.light || '');   // 三色灯筛选
  const ref = useOutside(open, () => setOpen(false));
  const [tab, setTab] = useState('all');
  const { data } = useData(() => q(Q.orders, [org, from, to]), [org, from, to]);
  const voided = useData(() => q(Q.voidedDeals, [org]), [org]).data || [];
  const rows = useMemo(() => (data || []).filter((d) => {
    if (light) { if (dealLight(d) !== light) return false; } else if (d.status === 'cancelled' && grp !== 'cancelled') return false;   // 作废的单默认在「已作废」页签; 选了红灯就显示
    if (tier && d.tier !== tier) return false;
    if (grp === 'open' && ['shipped', 'cancelled'].includes(d.status)) return false;
    if (grp === 'unpaid' && !(['partial', 'shipped'].includes(d.status) && Number(d.due) > 0)) return false;
    if (grp && !['open', 'unpaid'].includes(grp) && !grp.split(',').includes(d.status)) return false;
    if (text) { const t = text.toUpperCase(); if (![d.biz_no, d.customer_name, d.customer_code, d.city, d.quote_no, d.so_no].some((x) => String(x || '').toUpperCase().includes(t))) return false; }
    return true;
  }), [data, text, tier, grp]);
  const price = seesPrice(role);
  const cols = [
    { key: 'biz_no', label: '订单号', w: 150, render: (d) => <b className="mono">{d.biz_no}</b> },
    { key: 'created_at', label: '创建时间', w: 130, render: (d) => dt(d.created_at) },
    { key: 'customer_code', label: '客户编码', w: 70 },
    { key: 'customer_name', label: '客户', w: 160, render: (d) => <><CustLink id={d.customer_id} name={d.customer_name} /> <span className="muted small">{d.city}</span></> },
    { key: 'tier', label: '档位', w: 100, value: (d) => TIERS[d.tier], render: (d) => <TierPill tier={d.tier} /> },
    { key: 'light', label: '订单状态', w: 96, value: (d) => LIGHT_LABEL[dealLight(d)], render: (d) => <Light v={dealLight(d)} /> },
    { key: 'stuck', label: '卡在哪一步', w: 170, value: (d) => stuckOf(d), render: (d) => <span className="small">{stuckOf(d)}</span> },
    { key: 'status', label: '单据阶段', w: 150, value: (d) => STATUS[d.status].label, render: (d) => <><Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill>{d.approval === 'pending' && d.status === 'quoted' && <Pill tone="amber">等审批</Pill>}{d.approval === 'rejected' && <Pill tone="red">没批</Pill>}
      {d.planned_ship_date && ['confirmed', 'reviewed', 'partial'].includes(d.status) && dDate(d.planned_ship_date) <= today() && <Pill tone={dDate(d.planned_ship_date) < today() ? 'red' : 'amber'}>{dDate(d.planned_ship_date) < today() ? '过期未出库' : '今天该出库'}</Pill>}</> },
    { key: 'models', label: '机型', w: 220, render: (d) => <span className="small" title={d.models || ''}>{d.models || ''}</span> },
    { key: 'line_count', label: '型号数', w: 60 },
    { key: 'qty', label: '件数', w: 70, render: (d) => qty(['quoted', 'hotline_ok'].includes(d.status) ? d.qty_req : d.qty_supply) },
    ...(price ? [
      { key: 'amount', label: '金额', w: 110, render: (d) => money(d.amount, d.currency) },
      { key: 'due', label: '未收', w: 110, render: (d) => (Number(d.due) > 0 ? <b style={{ color: 'var(--red)' }}>{money(d.due)}</b> : Number(d.shipped_amount) > 0 ? <Pill tone="green">已收清</Pill> : '') },
    ] : []),
  ];
  const active = text || tier || grp || light;
  const counts = useMemo(() => { const c = { done: 0, active: 0, cancelled: 0 }; for (const d of data || []) c[dealLight(d)] += 1; return c; }, [data]);
  return (
    <>
      <div className="pagehead">
        <div><div className="eyebrow">Commandes</div><h1>订单总览</h1><div className="sub">{from} — {to} · 一行一个业务号，点开看完整工作流</div></div>
        <div className="row">
          <div className="seg">{PERIODS.map(([k, l]) => <button type="button" key={k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}</div>
          {period === 'custom' && <DatePicker range value={custom} onChange={setCustom} align="right" />}
          {can(role, 'quote') || can(role, 'inquiry') ? <button type="button" className="btn primary" onClick={() => go('quote/new')}>＋ 新订单</button> : null}
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 0 }}>
        <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>订单</button>
        <button type="button" className={tab === 'ship' ? 'on' : ''} onClick={() => setTab('ship')}>出库单 / BL</button>
        {can(role, 'inquiry') && <button type="button" className={tab === 'inq' ? 'on' : ''} onClick={() => setTab('inq')}>询单审批</button>}
        <button type="button" className={tab === 'void' ? 'on' : ''} onClick={() => setTab('void')}>已作废 <span className="muted">{voided.length}</span></button>
      </div>
      {tab === 'ship' ? <ShipmentsList from={from} to={to} /> : tab === 'void' ? <VoidedList rows={voided} /> : tab === 'inq' ? <Inquiry embedded /> : <div className="card">
        <div className="row light-bar">
          {[['', '全部'], ['active', '进行中'], ['done', '已完成'], ['cancelled', '已取消']].map(([k, l]) => (
            <button type="button" key={k || 'all'} className={`chip ${light === k ? 'on' : ''}`} onClick={() => setLight(k)}>{k ? <Light v={k} /> : l} <b>{k ? counts[k] : (data || []).length}</b></button>))}
        </div>
        <Grid id="orders" table="deals" columns={cols} rows={rows} onRowClick={(d) => go('deal/' + d.id)} empty={!data ? '加载中…' : light ? `${custom && period === 'custom' ? `${custom[0]} 至 ${custom[1]} ` : '这个时间段'}没有「${LIGHT_LABEL[light]}」的订单` : (data.length ? '没有符合条件的订单' : '这个时间段还没有订单')}
          tools={(
            <span style={{ position: 'relative' }} ref={ref}>
              <button type="button" className={`btn sm ${active ? 'primary' : ''}`} onClick={() => setOpen(!open)}>⌕ 筛选{active ? ' · 已筛' : ''}</button>
              {open && (
                <div className="menu" style={{ left: 0, top: '115%', width: 300, padding: 12 }}>
                  <div className="stack">
                    <div className="field"><label>搜索：客户名 / 编码 / 城市 / 单号</label><input className="in" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="例如 CAMARA（两个城市会都列出来）" /></div>
                    <div className="field"><label>状态</label><select className="in" value={grp} onChange={(e) => setGrp(e.target.value)}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                    <div className="field"><label>客户档位</label><select className="in" value={tier} onChange={(e) => setTier(e.target.value)}><option value="">全部档位</option>{Object.entries(TIERS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                    <button type="button" className="btn sm" onClick={() => { setText(''); setTier(''); setGrp(''); }}>清除筛选</button>
                  </div>
                </div>
              )}
            </span>
          )}
          foot={(rows) => ({ biz_no: `合计 ${rows.length} 单`, qty: `${qty(rows.reduce((a, d) => a + Number(['quoted', 'hotline_ok'].includes(d.status) ? d.qty_req : d.qty_supply), 0))} 件`,
            amount: price ? money(rows.reduce((a, d) => a + Number(d.amount), 0)) : '', due: price ? money(rows.reduce((a, d) => a + Math.max(0, Number(d.due)), 0)) : '' })} />
      </div>}
    </>
  );
}

// 作废不是删除：一键恢复 (待改 16)
function VoidedList({ rows }) {
  const { role, toast, refresh, go } = useApp();
  return (
    <div className="card">
      <Grid id="orders-void" table="deals" rows={rows} onRowClick={(d) => go('deal/' + d.id)} empty="没有作废的订单" columns={[
        { key: 'biz_no', label: '订单号', w: 150, render: (d) => <b className="mono">{d.biz_no}</b> },
        { key: 'customer_name', label: '客户', w: 160 },
        { key: 'updated_at', label: '作废时间', w: 130, render: (d) => dt(d.updated_at) },
        { key: 'reason', label: '原因', w: 160 },
        { key: 'act', label: '', w: 120, sortable: false, filterable: false, render: (d) => (can(role, 'restore') ? <button type="button" className="btn sm" onClick={async (e) => {
          e.stopPropagation();
          try { await call(role, `select app.restore_deal($1)`, [d.id]); toast(`${d.biz_no} 已恢复为报价`); refresh(); } catch (er) { toast(friendlyError(er), 'err'); }
        }}>↺ 恢复</button> : '') },
      ]} />
      <div className="card-b hint">作废的单不删除：恢复后回到「已报价」，需要重新下推找货单（重新预占库存）。</div>
    </div>
  );
}

// 出库单总表: 表头漏斗任何列都能筛 (客户 / 单号 / BL 号 / 机型 / 状态), 点一行进订单
function ShipmentsList({ from, to }) {
  const { org, go, role } = useApp();
  const { data } = useData(() => q(Q.shipmentsAll, [org, from, to]), [org, from, to]);
  const price = seesPrice(role);
  const st = (s) => (s.voided_at ? '已撤销' : s.customer_received_at ? '已签收' : '待签收');
  const cols = [
    { key: 'out_no', label: '出库单号', w: 150, render: (s) => <b className={`mono ${s.voided_at ? 'strike' : ''}`}>{s.out_no}</b> },
    { key: 'bl_no', label: 'BL 号', w: 190, render: (s) => (s.bl_no ? <span className="mono">{s.bl_no}</span> : <span className="muted small">没生成</span>) },
    { key: 'shipped_at', label: '发货时间', w: 130, render: (s) => dt(s.shipped_at) },
    { key: 'customer_name', label: '客户', w: 170, render: (s) => <><CustLink id={s.customer_id} name={s.customer_name} /> <span className="muted small">{s.city}</span></> },
    { key: 'customer_code', label: '客户编码', w: 80 },
    { key: 'models', label: '机型', w: 240, render: (s) => <span className="small" title={s.models || ''}>{s.models || ''}</span> },
    { key: 'qty', label: '件数', w: 70, value: (s) => Number(s.qty), render: (s) => qty(s.qty) },
    ...(price ? [{ key: 'amount', label: '金额', w: 110, value: (s) => Number(s.amount), render: (s) => money(s.amount, s.currency) }] : []),
    { key: 'status', label: '状态', w: 100, value: st, render: (s) => <Pill tone={s.voided_at ? 'gray' : s.customer_received_at ? 'green' : 'amber'}>{st(s)}</Pill> },
    { key: 'docs', label: '发货文件', w: 150, value: (s) => [s.bl_printed_at && 'BL 已打', s.signed_at && '已签字回传'].filter(Boolean).join(' · '),
      render: (s) => <span className="row" style={{ gap: 4 }}>{s.bl_printed_at && <Pill tone="blue">BL 已打</Pill>}{s.signed_at && <Pill tone="green">签字回传</Pill>}</span> },
    { key: 'kingdee_status', label: '金蝶', w: 90, value: (s) => s.kingdee_status || '' },
    { key: 'biz_no', label: '订单号', w: 150, render: (s) => <span className="mono small">{s.biz_no}</span> },
  ];
  return (
    <div className="card">
      <Grid id="shipments-all" table="shipments" columns={cols} rows={data || []} onRowClick={(s) => go('deal/' + s.deal_id)} empty={data ? '这段时间没有出库' : '加载中…'}
        foot={(rs) => ({ out_no: `合计 ${rs.length} 张`, qty: `${qty(rs.reduce((a, s) => a + Number(s.qty), 0))} 件`, amount: price ? money(rs.filter((s) => !s.voided_at).reduce((a, s) => a + Number(s.amount), 0)) : '' })} />
      <div className="card-b hint">像飞书表格一样：点表头的漏斗按客户、单号、BL 号、机型、状态筛；点一行进订单，BL 打印和签收照片在订单的「出库记录」里。</div>
    </div>
  );
}
