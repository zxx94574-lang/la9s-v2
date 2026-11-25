import { CatFilterByName } from '../components/CatFilter.jsx';
import { RuleGear } from '../components/Rules.jsx';
import { DocPeek, DocNo } from '../components/DocPeek.jsx';
import React, { useEffect, useMemo, useState } from 'react';
import { sumMargin, MarginPill, useMarginRules } from '../components/Margin.jsx';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, Light, useApp, useData, Pill, DatePicker, useOutside, usePeriod, PeriodBar } from '../components/ui.jsx';
import { call } from '../db/client.js';
import { friendlyError, dDate, today } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink, DealLink, setPeekHighlight } from '../components/Archives.jsx';
import Grid from '../components/Grid.jsx';
import { MultiPick, Schemes } from '../components/FilterBar.jsx';
import Inquiry from './Inquiry.jsx';
import { OPEN_DRAFT } from './QuoteNew.jsx';
import { USERS } from '../db/bootstrap.js';
import { STATUS, TIERS, seesPrice, can, dealLight, stuckOf, LIGHT_LABEL, STEPS, reachedStep } from '../lib/domain.js';
import { money, qty, dt, periodRange, PERIODS } from '../lib/format.js';

const GROUPS = [['', '全部状态'], ['open', '进行中'], ['quoted,hotline_ok', '只报价'], ['picking,picked', '找货中'], ['ordered', '待客户确认'], ['confirmed,reviewed', '待复检 / 待出库'], ['partial,shipped', '已出库'], ['unpaid', '已出库未收清'], ['cancelled', '已作废']];

const PAY_LABEL = { paid: '已付清', partial: '付了一部分', unpaid: '没付', none: '还没出库' };
export default function Orders() {
  const { org, go, role } = useApp();
  // 看板上点某个颜色跳过来: 带时间段 + 灯色 (一次性)
  const [jump] = useState(() => { try { const j = JSON.parse(sessionStorage.getItem('la9s.orders.jump')); sessionStorage.removeItem('la9s.orders.jump'); return j; } catch { return null; } });
  const P = usePeriod('orders', 'year', jump?.from ? { period: 'custom', custom: [jump.from, jump.to] } : null);
  const [stepF, setStepF] = useState(jump?.step || '');   // 11-20: 规则参数「看卡在这一步的单」跳过来
  const { period, custom, setPeriod, setCustom } = P;
  const { from, to } = P;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [tier, setTier] = useState('');
  const [grp, setGrp] = useState('');
  const [light, setLight] = useState(jump?.light || '');   // 三色灯筛选
  const ref = useOutside(open, () => setOpen(false));
  const [tab, setTab] = useState('all');
  const { data } = useData(async () => { await call(role, `select app.void_stale_drafts($1)`, [org]).catch(() => {}); return q(Q.orders, [org, from, to]); }, [org, from, to]);   // 259: 放太久的草稿顺手作废
  // 229 (Frank 11-11): 筛选条 —— 客户 / 档位 / 机型 / 付款, 可叠加; 「按机型看」给出片数和金额; 可存成筛选方案
  const olinesRaw = useData(() => q(Q.orderLines, [org, from, to]), [org, from, to]).data;
  const olines = useMemo(() => olinesRaw || [], [olinesRaw]);
  const [fcust, setFcust] = useState(jump?.cust ? [jump.cust] : []); const [ftier, setFtier] = useState([]); const [fmodel, setFmodel] = useState(jump?.model ? [jump.model] : []); const [fpay, setFpay] = useState([]); const [fcat, setFcat] = useState('');   // 507: 档案「共 N 张」/ 指令「去做」跳过来带客户 / 机型
  // 507: 已经在订单总览, 又从档案「共 N 张」/ 指令跳过来 → 照样换筛选
  useEffect(() => { const f = () => { let j = null; try { j = JSON.parse(sessionStorage.getItem('la9s.orders.jump')); sessionStorage.removeItem('la9s.orders.jump'); } catch { /* ignore */ } if (!j) return;
    if (j.cust) setFcust([j.cust]); if (j.model) setFmodel([j.model]); if (j.from) { setPeriod('custom'); setCustom([j.from, j.to]); } };
    window.addEventListener('la9s-orders-jump', f); return () => window.removeEventListener('la9s-orders-jump', f); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState('orders');
  const [gridShown, setGridShown] = useState(null);   // 表格里筛出来的行 + 机型条件 → 「按机型看」跟着同一套筛选
  const curFilter = { period, custom: period === 'custom' ? custom : null, light, fcust, ftier, fmodel, fpay, mode, text };
  const applyScheme = (f) => { if (f.period) setPeriod(f.period); if (f.period === 'custom' && f.custom) setCustom(f.custom); setLight(f.light || ''); setFcust(f.fcust || []); setFtier(f.ftier || []); setFmodel(f.fmodel || []); setFpay(f.fpay || []); setMode(f.mode || 'orders'); setText(f.text || ''); setTier(''); setGrp(''); };
  const payOf = (d) => (!(Number(d.shipped_amount) > 0) ? 'none' : Number(d.due) <= 0 ? 'paid' : Number(d.allocated_amount) > 0 ? 'partial' : 'unpaid');
  const voided = useData(() => q(Q.voidedDeals, [org]), [org]).data || [];
  const catDeals = useMemo(() => new Set(olines.filter((l) => l.category === fcat).map((l) => l.deal_id)), [olines, fcat]);
  const catNames = useMemo(() => [...new Set(olines.map((l) => l.category).filter(Boolean))], [olines]);
  const modelDeals = useMemo(() => new Set(olines.filter((l) => fmodel.includes(l.model)).map((l) => l.deal_id)), [olines, fmodel]);
  const rows = useMemo(() => (data || []).filter((d) => {
    if (stepF) { if (d.status === 'cancelled' || STEPS[reachedStep(d) + 1]?.key !== stepF) return false; }
    if (light) { if (dealLight(d) !== light) return false; } else if (d.status === 'cancelled' && grp !== 'cancelled') return false;   // 作废的单默认在「已作废」页签; 选了红灯就显示
    if (tier && d.tier !== tier) return false;
    if (fcust.length && !fcust.includes(d.customer_id)) return false;
    if (ftier.length && !ftier.includes(d.tier)) return false;
    if (fpay.length && !fpay.includes(payOf(d))) return false;
    if (fmodel.length && !modelDeals.has(d.id)) return false;
    if (fcat && !catDeals.has(d.id)) return false;
    if (grp === 'open' && ['shipped', 'cancelled'].includes(d.status)) return false;
    if (grp === 'unpaid' && !(['partial', 'shipped'].includes(d.status) && Number(d.due) > 0)) return false;
    if (grp && !['open', 'unpaid'].includes(grp) && !grp.split(',').includes(d.status)) return false;
    if (text) { const t = text.toUpperCase(); if (![d.biz_no, d.customer_name, d.customer_code, d.city, d.quote_no, d.so_no].some((x) => String(x || '').toUpperCase().includes(t))) return false; }
    return true;
  }), [data, text, tier, grp, light, fcust, ftier, fpay, fmodel, modelDeals, stepF, fcat, catDeals]);
  const price = seesPrice(role);
  const mRows = useData(() => (role === 'admin' ? call(role, `select deal_id, qty, revenue, cost, profit, cost_missing, cost_goods, sale, returned, adjust, freight, fee from app.margin_rows($1)`, [org]) : Promise.resolve([])), [org, role]).data;
  const margins = useMemo(() => { const by = {}; for (const r of mRows || []) (by[r.deal_id] ||= []).push(r); return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, sumMargin(v)])); }, [mRows]);
  const { lowPct: mLow } = useMarginRules();
  const catsOf = useMemo(() => { const m = new Map(); for (const l of olines) { if (!l.category) continue; const set = m.get(l.deal_id) || new Set(); set.add(l.category); m.set(l.deal_id, set); } return new Map([...m].map(([k, v]) => [k, [...v].join(' / ')])); }, [olines]);
  const cols = [
    { key: 'biz_no', label: '订单号', w: 150, render: (d) => <b><DealLink id={d.id} no={d.biz_no} /></b> },
    { key: 'created_at', label: '创建时间', w: 130, render: (d) => dt(d.created_at) },
    { key: 'customer_code', label: '客户编码', w: 70 },
    { key: 'customer_name', label: '客户', w: 160, render: (d) => <><CustLink id={d.customer_id} name={d.customer_name} /> <span className="muted small">{d.city}</span></> },
    { key: 'city', label: '城市', w: 100, hidden: true },
    { key: 'tier', label: '档位', w: 100, value: (d) => TIERS[d.tier], render: (d) => <TierPill tier={d.tier} /> },
    { key: 'light', label: '订单状态', w: 96, value: (d) => LIGHT_LABEL[dealLight(d)], render: (d) => <Light v={dealLight(d)} /> },
    { key: 'stuck', label: '卡在哪一步', w: 170, value: (d) => stuckOf(d), render: (d) => <span className="small">{stuckOf(d)}</span> },
    { key: 'odd', label: '异价', w: 70, hidden: true, value: (d) => (d.odd_price ? '异价单' : '正常') },
    { key: 'status', label: '单据阶段', w: 150, value: (d) => (d.status === 'quoted' && d.tier_pending ? '等中方定档' : STATUS[d.status].label) + (d.odd_price ? ' 异价单' : ''), render: (d) => <>{d.status === 'quoted' && d.tier_pending ? <Pill tone="red">等中方定档</Pill> : <Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill>}{d.odd_price && <Pill tone="amber" title="有行的单价偏离档位价超过设定比例（比例在「物料与定价」标题旁 ⚙ 里改）。原因和中方备注在操作记录里。">异价单</Pill>}{Number(d.price_req_n) > 0 && <Pill tone="red">改价待批</Pill>}{d.approval === 'pending' && d.status === 'quoted' && <Pill tone="amber">等审批</Pill>}{d.approval === 'rejected' && <Pill tone="red">没批</Pill>}
      {d.planned_ship_date && ['confirmed', 'reviewed', 'partial'].includes(d.status) && dDate(d.planned_ship_date) <= today() && <Pill tone={dDate(d.planned_ship_date) < today() ? 'red' : 'amber'}>{dDate(d.planned_ship_date) < today() ? '过期未出库' : '今天该出库'}</Pill>}</> },
    { key: 'cats', label: '种类', w: 130, value: (d) => catsOf.get(d.id) || '', render: (d) => <span className="small">{catsOf.get(d.id) || ''}</span> },
    { key: 'models', label: '机型', w: 220, value: (d) => d.models || '', render: (d) => <span className="small" title={d.models || ''}>{d.models || ''}</span> },
    { key: 'pay', label: '付款', w: 100, value: (d) => PAY_LABEL[payOf(d)], render: (d) => { const k = payOf(d); return k === 'none' ? <span className="muted small">还没出库</span> : <Pill tone={k === 'paid' ? 'green' : k === 'partial' ? 'amber' : 'red'}>{PAY_LABEL[k]}</Pill>; } },
    { key: 'line_count', label: '型号数', w: 60 },
    { key: 'qty', label: '件数', w: 70, render: (d) => qty(['quoted', 'hotline_ok'].includes(d.status) ? d.qty_req : d.qty_supply) },
    ...(price ? [
      { key: 'amount', label: '金额', w: 110, render: (d) => money(d.amount, d.currency) },
      { key: 'due', label: '未收', w: 110, render: (d) => (Number(d.due) > 0 ? <b style={{ color: 'var(--red)' }}>{money(d.due)}</b> : Number(d.shipped_amount) > 0 ? <Pill tone="green">已收清</Pill> : '') },
    ] : []),
    // 328: 毛利只中方看 (已出库的才有; 成本出库时锁定, 事后变动已扣)
    ...(role === 'admin' ? [
      { key: 'm_profit', label: '毛利', w: 110, type: 'number', sum: true, value: (d) => margins[d.id]?.profit ?? null, render: (d) => { const m = margins[d.id]; return m && m.revKnown ? <span className={m.profit < 0 ? 'red-t2' : ''}>{money(Math.round(m.profit))}</span> : ''; } },
      { key: 'm_pct', label: '毛利率', w: 90, type: 'number', value: (d) => margins[d.id]?.pct ?? null, render: (d) => { const m = margins[d.id]; return m ? <MarginPill pct={m.pct} lowPct={mLow} missing={!m.revKnown} /> : ''; } },
    ] : []),
  ];
  const active = text || tier || grp || light;
  const anyF = fcust.length || ftier.length || fmodel.length || fpay.length || text;
  const custOpts = useMemo(() => { const m = new Map(); for (const d of data || []) m.set(d.customer_id, `${d.customer_name}${d.city ? ' · ' + d.city : ''}`); return [...m].sort((a, b) => a[1].localeCompare(b[1])); }, [data]);
  const modelOpts = useMemo(() => [...new Set(olines.map((l) => l.model).filter(Boolean))].sort().map((m) => [m, m]), [olines]);
  // 按机型看: 筛出来的这些单里, 每个机型卖了多少片、多少钱 (已出库 − 已退货, 按成交价)
  const byModel = useMemo(() => {
    const base = gridShown?.rows || rows; const fm = gridShown?.models || [];
    const ok = new Map(base.map((d) => [d.id, d])); const m = new Map();
    for (const l of olines) { const d = ok.get(l.deal_id); if (!d || !l.model) continue; if (fm.length && !fm.includes(String(l.model).toUpperCase())) continue; if (fcat && l.category !== fcat) continue;
      const pcs = Number(l.qty_shipped) - Number(l.qty_returned); const k = l.model + '|' + (l.category || '');
      const r = m.get(k) || { key: k, model: l.model, category: l.category, product_id: l.product_id, pcs: 0, amount: 0, req: 0, deals: new Set(), custs: new Set() };
      r.pcs += pcs; r.amount += pcs * Number(l.unit_price || 0); r.req += Number(l.qty_req); r.deals.add(l.deal_id); r.custs.add(d.customer_id); m.set(k, r); }
    return [...m.values()].map((r) => ({ ...r, deal_n: r.deals.size, cust_n: r.custs.size })).sort((a, b) => b.pcs - a.pcs);
  }, [rows, olines, gridShown, fcat]);
  const counts = useMemo(() => { const c = { done: 0, active: 0, cancelled: 0 }; for (const d of data || []) c[dealLight(d)] += 1; return c; }, [data]);
  const drafts = useData(() => q(`select qd.*, c.name as customer_name, c.code as customer_code, coalesce(e.short_name, e.full_name) as by_name from app.quote_drafts qd join app.customers c on c.id = qd.customer_id left join app.members m on m.user_id = qd.user_id and m.org_id = qd.org_id left join app.employees e on e.id = m.employee_id where qd.org_id = $1 ${role === 'admin' ? '' : 'and qd.user_id = $2'} order by qd.updated_at desc`, role === 'admin' ? [org] : [org, USERS[role]]), [org, role]).data || [];
  return (
    <>
      <div className="pagehead">
        <div><div className="eyebrow">Commandes</div><h1>订单总览</h1><div className="sub">一行一个业务号，点开看完整工作流</div></div>
        <div className="row">
          {can(role, 'quote') || can(role, 'inquiry') ? <button type="button" className="btn primary lg" onClick={() => go('quote/new')}>＋ 新订单</button> : null}
          <PeriodBar p={P} />
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 0 }}>
        <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>订单</button>
        <button type="button" className={tab === 'ship' ? 'on' : ''} onClick={() => setTab('ship')}>出库单 / BL</button>
        {can(role, 'inquiry') && <button type="button" className={tab === 'inq' ? 'on' : ''} onClick={() => setTab('inq')}>询单</button>}
        <button type="button" className={tab === 'void' ? 'on' : ''} onClick={() => setTab('void')}>已作废 <span className="muted">{voided.length}</span></button>
      </div>
      {tab === 'ship' ? <ShipmentsList from={from} to={to} /> : tab === 'void' ? <VoidedList rows={voided} /> : tab === 'inq' ? <Inquiry embedded /> : <div className="card">
        <div className="fbar">
          <CatFilterByName names={catNames} value={fcat} onChange={setFcat} allLabel="全部种类" />
          <span className="grow" />
          <div className="seg"><button type="button" className={mode === 'orders' ? 'on' : ''} onClick={() => setMode('orders')}>按订单看</button><button type="button" className={mode === 'models' ? 'on' : ''} onClick={() => setMode('models')}>按机型看</button></div>
        </div>
        <div className="row light-bar">
          {[['', '全部'], ['active', '进行中'], ['draft', '草稿'], ['done', '已完成'], ['cancelled', '已取消']].map(([k, l]) => (
            <button type="button" key={k || 'all'} className={`chip ${light === k ? 'on' : ''}`} onClick={() => setLight(k)}>{k === 'draft' ? <span className="pill amber">草稿</span> : k ? <Light v={k} /> : l} <b>{k === 'draft' ? drafts.length : k ? counts[k] : (data || []).length}</b></button>))}
          <RuleGear anchor="orders-drafts" title="草稿规则" ids={['draft.lines', 'draft.days']} />
        </div>
        {light === 'draft' ? <DraftList rows={drafts} /> : mode === 'models' ? (
          <>
            <div className="bigsum">
              <div><div className="k">总片数（已出库 − 已退货）</div><div className="v">{qty(byModel.reduce((a, r) => a + r.pcs, 0))} <small>片</small></div></div>
              {price && <div><div className="k">总金额（按成交价）</div><div className="v">{money(byModel.reduce((a, r) => a + r.amount, 0))} <small>XOF</small></div></div>}
              <div><div className="k">机型</div><div className="v">{byModel.length}</div></div>
              <div><div className="k">订单</div><div className="v">{rows.length}</div></div>
            </div>
            <Grid id="orders-models" rows={byModel} rowKey={(r) => r.key} empty="这些条件下没有机型" columns={[
              { key: 'model', label: '机型', w: 170, render: (r) => <b>{r.product_id ? <ModelLink id={r.product_id} model={r.model} /> : r.model}</b> },
              { key: 'category', label: '种类', w: 110 },
              { key: 'pcs', label: '出库片数', w: 100, type: 'number', value: (r) => r.pcs, render: (r) => <b>{qty(r.pcs)}</b> },
              ...(price ? [{ key: 'amount', label: '金额 XOF', w: 130, type: 'money', value: (r) => r.amount, render: (r) => <b>{money(r.amount)}</b> }] : []),
              { key: 'req', label: '客户要的', w: 100, type: 'number', value: (r) => r.req, render: (r) => <span className={r.req > r.pcs ? 'amber-t2' : ''}>{qty(r.req)}</span> },
              { key: 'deal_n', label: '几张单', w: 80, type: 'number' },
              { key: 'cust_n', label: '几个客户', w: 90, type: 'number' },
            ]} foot={(rs) => ({ model: '合计', pcs: `${qty(rs.reduce((a, r) => a + r.pcs, 0))} 片`, ...(price ? { amount: money(rs.reduce((a, r) => a + r.amount, 0)) } : {}) })} />
          </>
        ) : null}
        {(fcust.length > 0 || fmodel.length > 0) && <div className="banner" style={{ marginBottom: 8 }}>只看{fcust.length > 0 && <> 客户 <b>{fcust.map((c) => (custOpts.find((x) => x[0] === c)?.[1] || '').split(' · ')[0]).join('、')}</b></>}{fmodel.length > 0 && <> 机型 <b>{fmodel.join('、')}</b></>} 的单（{rows.length} 张） <button type="button" className="btn sm ghost" onClick={() => { setFcust([]); setFmodel([]); }}>看全部</button></div>}
        {stepF && <div className="banner" style={{ marginBottom: 8 }}>只看现在卡在「{STEPS.find((x) => x.key === stepF)?.label}」这一步的单（{rows.length} 张） <button type="button" className="btn sm ghost" onClick={() => setStepF('')}>看全部 ×</button></div>}
        {light !== 'draft' && mode === 'orders' && <Grid id="orders" table="deals" columns={cols} rows={rows} onShown={(rs, conds, qq) => { const ms = conds.filter((c) => c.key === 'models').flatMap((c) => (c.op === 'in' ? c.vals || [] : c.op === 'contains' ? [c.a] : [])).map((v) => String(v || '').toUpperCase()).filter(Boolean); setPeekHighlight([...ms, qq]); setGridShown({ rows: rs, models: (conds.find((c) => c.key === 'models' && c.op === 'in')?.vals || []).map((v) => String(v).toUpperCase()) }); }} onRowClick={(d) => go('deal/' + d.id)} empty={!data ? '加载中…' : light ? `${custom && period === 'custom' ? `${custom[0]} 至 ${custom[1]} ` : '这个时间段'}没有「${LIGHT_LABEL[light]}」的订单` : (data.length ? '没有符合条件的订单' : '这个时间段还没有订单')}
          foot={(rows) => ({ biz_no: `合计 ${rows.length} 单`, qty: `${qty(rows.reduce((a, d) => a + Number(['quoted', 'hotline_ok'].includes(d.status) ? d.qty_req : d.qty_supply), 0))} 件`,
            amount: price ? money(rows.reduce((a, d) => a + Number(d.amount), 0)) : '', due: price ? money(rows.reduce((a, d) => a + Math.max(0, Number(d.due)), 0)) : '' })} />}
      </div>}
    </>
  );
}

// 作废不是删除：一键恢复 (待改 16)
function VoidedList({ rows }) {
  const { role, toast, refresh, go } = useApp();
  return (
    <div className="card">
      <Grid id="orders-void" table="deals" rows={rows} onRowClick={(d) => go('deal/' + d.id)} empty="没有作废的订单"
        rowActions={can(role, 'restore') ? [{ label: '↺ 恢复这张单', tone: '', run: async (d) => { try { await call(role, `select app.restore_deal($1)`, [d.id]); toast(`${d.biz_no} 已恢复为报价`); refresh(); } catch (er) { toast(friendlyError(er), 'err'); } } }] : undefined} columns={[
        { key: 'biz_no', label: '订单号', w: 150, render: (d) => <b><DealLink id={d.id} no={d.biz_no} /></b> },
        { key: 'customer_name', label: '客户', w: 160 },
        { key: 'updated_at', label: '作废时间', w: 130, render: (d) => dt(d.updated_at) },
        { key: 'reason', label: '原因', w: 160 },
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
    { key: 'out_no', label: '出库单号', w: 150, render: (s) => <b className={s.voided_at ? 'strike' : ''}><span className="deal-link"><DocPeek kind="shipment" id={s.id} /><DealLink id={s.deal_id} no={s.out_no} peek={false} /></span></b> },
    { key: 'bl_no', label: 'BL 号', w: 190, render: (s) => (s.bl_no ? <DealLink id={s.deal_id} no={s.bl_no} /> : <span className="muted small">没生成</span>) },
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
    { key: 'biz_no', label: '订单号', w: 150, render: (s) => <DealLink id={s.deal_id} no={s.biz_no} /> },
  ];
  return (
    <div className="card">
      <Grid id="shipments-all" table="shipments" columns={cols} rows={data || []} onRowClick={(s) => go('deal/' + s.deal_id)} empty={data ? '这段时间没有出库' : '加载中…'}
        foot={(rs) => ({ out_no: `合计 ${rs.length} 张`, qty: `${qty(rs.reduce((a, s) => a + Number(s.qty), 0))} 件`, amount: price ? money(rs.filter((s) => !s.voided_at).reduce((a, s) => a + Number(s.amount), 0)) : '' })} />
      <div className="card-b hint">像飞书表格一样：点表头的漏斗按客户、单号、BL 号、机型、状态筛；点一行进订单，BL 打印和签收照片在订单的「出库记录」里。</div>
    </div>
  );
}

// 报价草稿 (Frank 11-13 294): 选了客户、填够 5 行自动存的; 点开接着做, 保存报价就从这里消失
function DraftList({ rows }) {
  const { role, go, toast, refresh } = useApp();
  return <Grid id="quote-drafts" rows={rows} empty="没有草稿。新订单里选了客户、填够 5 行会自动存在这里；7 天没动自动删。"
    onRowClick={(d) => { try { sessionStorage.setItem(OPEN_DRAFT, d.id); } catch { /* */ } go('quote/new'); }}
    rowActions={[{ label: '接着做', run: (d) => { try { sessionStorage.setItem(OPEN_DRAFT, d.id); } catch { /* */ } go('quote/new'); } },
      { label: '删掉草稿', danger: true, describe: (d) => `${d.customer_name} · ${d.n_lines} 行 · ${d.by_name || ''}`, warn: '草稿删了就没了，找不回来。要删的是：', run: async (d) => { try { await call(role, `select app.delete_quote_draft($1)`, [d.id]); toast('草稿已删'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } } }]}
    columns={[
      { key: 'customer_name', label: '客户', w: 200, render: (d) => <CustLink id={d.customer_id} name={d.customer_name} /> },
      { key: 'n_lines', label: '行数', w: 70, type: 'number' },
      { key: 'by_name', label: '谁的草稿', w: 120 },
      { key: 'updated_at', label: '最后改动', w: 140, render: (d) => dt(d.updated_at) },
    ]} />;
}
