// 智能搜索（Frank 11-25 14:00 改）：顶栏右上一个按钮 → 弹出搜索；一句话问 → 结论 + 一键跳转到对应清单（自动筛好）。
// 原来是：经营总览顶上一个框，用平常说话的方式问数，例「Koffi 昨天对应客户的销量」
// 不用外部 AI（数据不出这台电脑 / 服务器）：本地听懂「谁 / 哪个客户 / 哪个型号或种类 / 什么时候 / 看什么 / 按什么分」，
// 听懂的部分显示成一排小块，点 × 去掉、点分组换一种分法；结果是一张表 + 一句话，客户 / 型号 / 员工都能点开。
// 销量 = 出库（作废的不算，退货另列）；员工 = 订单上的归属销售员（激励也按这个算）；金额一律折成 XOF。
import { hasAny, dealLight, dealPay, reachedStep, STEPS } from '../lib/domain.js';
import { orders as ORDERS_SQL } from '../db/queries.js';
import { poListSql, poMatch, poJump, stageOf } from '../pages/Po.jsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Choice } from './ui.jsx';
import { ordersJump } from '../lib/dirWork.js';
import { ITEMS, visibleTo } from './Nav.jsx';
import { presetPeriod } from './ui.jsx';
import { periodRange, ymd, dDate } from '../lib/format.js';
import { parse, METRIC, NOW, GROUP, looksLikeQuestion, TIER_NAME, PAY_NAME, STEP_NAME, LIGHT_NAME, PO_STAGE_NAME } from '../lib/askParse.js';   // 关键词全在 lib/askParse.js（纯函数，tests/ask.test.mjs 回归）

const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');
const norm = (s) => String(s || '').toUpperCase().replace(/[\s_\-·.]+/g, '');

const KEY = { customer: ['c.id', 'c.name'], model: ['p.model', 'p.model'], category: ['cat.name', 'cat.name'], employee: ['e.id', "coalesce(e.short_name, '（无归属）')"], day: ['s.shipped_at::date', "to_char(s.shipped_at::date, 'MM-DD')"], deal: ['d.id', 'd.biz_no'] };
// 11-28: 带「档位 / 付款 / 卡在哪步 / 订单状态」的问法 → 按订单列（跟订单总览同一套口径，没出库的单也算）
export const orderMode = (P) => !P.subject && (!!(P.pay || P.step || P.light) || (!!P.tier && (P.group === 'deal' || !P.said?.metric)));
async function run(org, P) {
  if (P.subject === 'po') {   // 采购单：按下单日 + 到货进度 + 用途，跟采购单页同一个筛选函数
    const all = await q(poListSql, [org]);
    return all.filter((p) => poMatch(p, { from: P.from, to: P.to, stage: P.poStage, purpose: P.purpose }) && (!P.model || String(p.models || '').toUpperCase().includes(P.model.toUpperCase())))
      .map((p) => ({ k: p.id, poid: p.id, label: [p.po_no, p.batch_name].filter(Boolean).join(' · '), n: 1, qty: Number(p.qty) || 0, amount: Number(p.received) || 0, right: stageOf(p)[0], recv: Number(p.received) > 0 || p.status === 'closed' }));
  }
  if (orderMode(P)) {
    const ds = await q(ORDERS_SQL, [org, P.from, P.to]);
    const catIds = P.cat ? new Set((await q(`select distinct l.deal_id::text as id from app.deal_lines l join app.products p on p.id = l.product_id where p.category_id = $1`, [P.cat.id])).map((r) => r.id)) : null;
    return ds.filter((d) => (!P.tier || d.tier === P.tier) && (!P.cust || d.customer_id === P.cust.id) && (!P.emp || d.owner_employee_id === P.emp.id)
      && (!P.pay || dealPay(d) === P.pay) && (!P.light || dealLight(d) === P.light) && (!P.step || (d.status !== 'cancelled' && STEPS[reachedStep(d) + 1]?.key === P.step))
      && (!P.model || String(d.models || '').toUpperCase().split(' / ').includes(P.model.toUpperCase())) && (!catIds || catIds.has(String(d.id))))
      .map((d) => ({ k: d.id, did: d.id, cid: d.customer_id, label: `${d.biz_no} · ${d.customer_name}`, n: 1, qty: Number(d.qty_supply || d.qty_req) || 0, amount: d.currency === 'XOF' ? Number(d.amount) || 0 : 0, due: Math.max(0, Number(d.due) || 0) }));
  }
  const args = [org, P.from, P.to]; const w = [];
  const add = (sql, v) => { args.push(v); w.push(sql.replace('?', `$${args.length}`)); };
  if (P.emp) add('d.owner_employee_id = ?', P.emp.id);
  if (P.cust) add('d.customer_id = ?', P.cust.id);
  if (P.tier && P.metric !== 'stock') add('c.tier::text = ?', P.tier);
  if (P.cat && P.metric !== 'recv') add('p.category_id = ?', P.cat.id);
  if (P.model && P.metric !== 'recv') add('p.model = ?', P.model);
  const W = w.length ? ' and ' + w.join(' and ') : '';
  const xof = "case when d.currency = 'XOF' then 1 else coalesce(d.fx_rate, 1) end";
  if (P.metric === 'stock') {
    const k = P.group === 'category' ? ['cat.name', 'cat.name'] : ['p.model', 'p.model'];
    const a2 = [org]; const w2 = [];
    if (P.cat) { a2.push(P.cat.id); w2.push(`p.category_id = $${a2.length}`); }
    if (P.model) { a2.push(P.model); w2.push(`p.model = $${a2.length}`); }
    return q(`select ${k[0]} as k, ${k[1]} as label, max(p.id::text) as pid, count(distinct p.id)::int as n, sum(s.qty_on_hand)::int as qty, sum(s.qty_on_hand - s.qty_reserved)::int as amount
      from app.stock_items s join app.warehouses w on w.id = s.warehouse_id join app.products p on p.id = s.product_id join app.categories cat on cat.id = p.category_id
      where p.org_id = $1 and w.kind = 'local' ${w2.length ? 'and ' + w2.join(' and ') : ''} group by 1, 2 having sum(s.qty_on_hand) > 0 order by qty desc limit 3000`, a2);
  }
  if (P.metric === 'ar') {
    const k = P.group === 'employee' ? ['e.id', "coalesce(e.short_name, '（无归属）')"] : P.group === 'deal' ? ['d.id', 'd.biz_no'] : ['c.id', 'c.name'];
    const a2 = [org]; const w2 = [];
    if (P.emp) { a2.push(P.emp.id); w2.push(`c.owner_employee_id = $${a2.length}`); }
    if (P.cust) { a2.push(P.cust.id); w2.push(`c.id = $${a2.length}`); }
    if (P.tier) { a2.push(P.tier); w2.push(`c.tier::text = $${a2.length}`); }
    return q(`select ${k[0]}::text as k, ${k[1]} as label, max(c.id::text) as cid, max(e.id::text) as eid, count(*)::int as n, 0 as qty, sum(v.due * ${xof}) as amount
      from app.v_deal_due v join app.deals d on d.id = v.deal_id join app.customers c on c.id = v.customer_id left join app.employees e on e.id = c.owner_employee_id
      where v.org_id = $1 and v.due > 0 ${w2.length ? 'and ' + w2.join(' and ') : ''} group by 1, 2 order by amount desc limit 3000`, a2);
  }
  if (P.metric === 'recv') {
    const k = { customer: ['c.id', 'c.name'], employee: ['e.id', "coalesce(e.short_name, '（无归属）')"], day: ['r.received_on', "to_char(r.received_on, 'MM-DD')"], deal: ['c.id', 'c.name'], model: ['c.id', 'c.name'], category: ['c.id', 'c.name'] }[P.group];
    const W2 = W.replace(/d\.owner_employee_id/g, 'c.owner_employee_id').replace(/d\.customer_id/g, 'r.customer_id');
    return q(`select ${k[0]}::text as k, ${k[1]} as label, max(c.id::text) as cid, count(*)::int as n, 0 as qty,
        sum(case when r.currency = 'XOF' then r.amount when r.account_currency = 'XOF' then r.converted else r.amount * r.rate end) as amount
      from app.receipts r join app.customers c on c.id = r.customer_id left join app.employees e on e.id = c.owner_employee_id
      where r.org_id = $1 and r.voided_at is null and r.received_on between $2::date and $3::date ${W2} group by 1, 2 order by amount desc nulls last limit 3000`, args);
  }
  const k = KEY[P.group];
  if (P.metric === 'ret') {
    return q(`select ${k[0].replace('s.shipped_at', 'rt.created_at')}::text as k, ${k[1].replace('s.shipped_at', 'rt.created_at')} as label, max(c.id::text) as cid, max(p.id::text) as pid, max(e.id::text) as eid,
        count(distinct rt.id)::int as n, sum(rl.qty)::int as qty, sum(rl.qty * dl.unit_price * ${xof}) as amount
      from app.return_lines rl join app.returns rt on rt.id = rl.return_id join app.deal_lines dl on dl.id = rl.deal_line_id join app.deals d on d.id = rt.deal_id
      join app.customers c on c.id = d.customer_id join app.products p on p.id = dl.product_id join app.categories cat on cat.id = p.category_id left join app.employees e on e.id = d.owner_employee_id
      where d.org_id = $1 and rt.status not in ('requested','rejected') and rt.created_at::date between $2::date and $3::date ${W} group by 1, 2 order by qty desc limit 3000`, args);
  }
  return q(`select ${k[0]}::text as k, ${k[1]} as label, max(c.id::text) as cid, max(p.id::text) as pid, max(e.id::text) as eid, max(d.id::text) as did,
      count(distinct d.id)::int as n, sum(sl.qty)::int as qty, sum(sl.amount * ${xof}) as amount
    from app.shipment_lines sl join app.shipments s on s.id = sl.shipment_id join app.deals d on d.id = s.deal_id join app.deal_lines dl on dl.id = sl.deal_line_id
    join app.customers c on c.id = d.customer_id join app.products p on p.id = dl.product_id join app.categories cat on cat.id = p.category_id left join app.employees e on e.id = d.owner_employee_id
    where d.org_id = $1 and s.voided_at is null and s.shipped_at::date between $2::date and $3::date ${W} group by 1, 2 order by ${P.metric === 'amount' ? 'amount' : 'qty'} desc limit 3000`, args);
}

const EX = ['S 档本月的订单', '上个月的采购单，哪些已经入库', '待出库的订单', 'Thomas 今年所有销售清单', 'Thomas 的 balance', 'Koffi 昨天对应客户的销量', '本月每个销售员卖了多少钱', '现在谁欠款最多', '近 7 天收款按客户', '电池盖库存'];

// 去哪看（一键跳转，到了自动筛好）：每种问法给一个主按钮，必要时再给一两个
function jumpsOf(P, rows) {
  const J = [];
  const day = (x) => x.slice(5);
  const range = P.from === '2000-01-01' ? '全部时间' : `${day(P.from)} – ${day(P.to)}`;
  const ordersJ = { kind: 'orders', j: { cust: P.cust?.id, model: P.model, cat: P.cat?.name, emp: P.emp?.id, from: P.from, to: P.to, pk: P.pk === 'all' ? 'custom' : P.pk, ask: true, tier: P.tier, pay: P.pay, step: P.step, light: P.light } };
  const filtTxt = [P.tier && `${TIER_NAME[P.tier]} 档`, P.pay && PAY_NAME[P.pay], P.step && STEP_NAME[P.step], P.light && LIGHT_NAME[P.light]].filter(Boolean);
  if (P.subject === 'po') {
    const what = [P.purpose === 'fob' ? 'FOB' : P.purpose === 'local' ? '本地备货' : '', P.poStage ? PO_STAGE_NAME[P.poStage] : ''].filter(Boolean).join(' · ');
    J.push({ kind: 'po', j: { from: P.from, to: P.to, pk: P.pk, stage: P.poStage || 'all', purpose: P.purpose || '' }, label: `打开采购单与到货${what ? `：${what}` : ''}`, sub: `已筛好 · ${range}（按下单日）；到了每张单的物流进度都在表里` });
    if (P.poStage === 'recv') J.push({ kind: 'po', j: { from: P.from, to: P.to, pk: P.pk, stage: 'transit', purpose: P.purpose || '' }, label: '同一段时间还没到齐的', sub: '在途 / 部分入库' });
    else if (P.poStage !== 'transit') J.push({ kind: 'po', j: { from: P.from, to: P.to, pk: P.pk, stage: 'recv', purpose: P.purpose || '' }, label: '只看已入库的', sub: '含部分入库' });
    return J;
  }
  if (filtTxt.length) {   // 说了档位 / 付款 / 卡在哪步 → 订单总览筛好放第一个
    const who = [P.cust?.name, P.emp ? `${P.emp.short_name} 名下` : null, P.cat?.name, P.model, ...filtTxt].filter(Boolean).join(' · ');
    J.push({ ...ordersJ, label: `打开订单总览：${who}`, sub: `已筛好 · ${range}（按下单日期）；到了还能一键清除` });
    if (P.metric === 'ar' && !P.cust) J.push({ kind: 'go', to: 'balances', label: '客户欠款清单', sub: '全部客户的 Balance' });
    return J;
  }
  if (P.metric === 'ar') {
    if (P.cust) J.push({ ...{ kind: 'go', to: `customer/${P.cust.id}` }, label: `打开 ${P.cust.name} 的总账`, sub: '看 Balance、发对账单、把收款冲到订单' });
    else if (rows?.length === 1 && rows[0].cid) J.push({ kind: 'go', to: `customer/${rows[0].cid}`, label: `打开 ${rows[0].label} 的总账`, sub: '看 Balance、冲订单' });
    else J.push({ kind: 'go', to: 'balances', label: '打开客户欠款清单', sub: '全部客户的 Balance；点客户进总账冲单' });
    if (P.cust) J.push({ ...ordersJ, j: { ...ordersJ.j, from: '2000-01-01', pk: 'custom', model: null, cat: null }, label: `${P.cust.name} 的全部订单`, sub: '订单总览，已筛好这个客户' });
  } else if (P.metric === 'recv') {
    J.push({ kind: 'go', period: ['receipts', P.pk, [P.from, P.to]], to: P.cust ? `receipts/${P.cust.id}` : 'receipts', label: P.cust ? `打开 ${P.cust.name} 的收款` : '打开收款与总账', sub: P.cust ? '收款记录，已选好这个客户' : '登记 / 查收款' });
    if (P.cust) J.push({ kind: 'go', to: `customer/${P.cust.id}`, label: `${P.cust.name} 的总账`, sub: '看 Balance、冲订单' });
  } else if (P.metric === 'stock') {
    J.push({ kind: 'stock', q: P.model || P.cat?.name || '', label: '打开库存', sub: P.model || P.cat ? `已按「${P.model || P.cat.name}」筛好` : '全部库存' });
  } else {
    const who = [P.cust?.name, P.emp ? `${P.emp.short_name} 名下客户` : null, P.cat?.name, P.model].filter(Boolean).join(' · ');
    J.push({ ...ordersJ, label: `打开订单总览${who ? `：${who}` : ''}`, sub: `已筛好 · ${range}（按下单日期）；到了还能一键清除、改选别的客户` });
    if (P.cust) J.push({ kind: 'go', to: `customer/${P.cust.id}`, label: `${P.cust.name} 的总账`, sub: 'Balance / 冲订单' });
  }
  return J;
}

export function AskButton() {
  const { role } = useApp();
  const [open, setOpen] = useState(false);
  const ok = hasAny(role, ['admin', 'manager', 'finance', 'sales_manager']);
  useEffect(() => {
    if (!ok) return undefined;
    const k = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [ok]);
  if (!ok) return null;
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
  return (<>
    <button type="button" className="ask-bar" onClick={() => setOpen(true)} title="智能搜索：搜型号 / 编码 / 通用型号、客户、单号、员工、页面；或者问一句（例「Thomas 的 balance」），问完一键跳到筛好的清单">
      <span className="ask-ico">⌕</span><span className="ask-ph">智能搜索 · 型号 / 客户 / 单号，或问一句</span><kbd className="ask-kbd">{mac ? '⌘K' : 'Ctrl K'}</kbd></button>
    {open && <AskPanel onClose={() => setOpen(false)} />}
  </>);
}

// 顶栏「＋ 新建」：最常用的几件事一键到（按岗位只列看得到的）
export function NewMenu() {
  const { role, go } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => { if (!open) return undefined; const f = (e) => { if (!box.current?.contains(e.target)) setOpen(false); }; document.addEventListener('pointerdown', f); return () => document.removeEventListener('pointerdown', f); }, [open]);
  const items = [['quote/new', '新订单', '选客户、选货、报价', 'quote'], ['inquiry', '新询单', '客户问价，还不是订单', 'inquiry'], ['receipts', '登记收款', '收到钱 → 冲订单', 'receipts'], ['fob', '新 FOB 申请', '一客一单', 'fob'], ['visits', '记一次拜访', '新潜客也在这里', 'visits']]
    .filter(([r]) => { const route = r.split('/')[0] === 'quote' ? 'orders' : r; return !ITEMS[route] || visibleTo(route, role); });
  if (!items.length) return null;
  return (
    <span className="new-wrap hide-m" ref={box}>
      <button type="button" className="new-btn" onClick={() => setOpen(!open)} title="新建：订单、询单、收款、FOB、拜访">＋<span className="new-l"> 新建</span></button>
      {open && <div className="menu new-menu">{items.map(([r, l, d]) => <button type="button" key={r} className="mi" onClick={() => { setOpen(false); go(r); }}><div><b>{l}</b><div className="small muted">{d}</div></div></button>)}</div>}
    </span>);
}

const PROD_SQL = `select p.id, p.code, p.model, p.variant, p.shared_models, c.name as category,
  coalesce((select sum(s.qty_on_hand - s.qty_reserved) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = p.id and w.kind = 'local'), 0)::int as avail
  from app.products p join app.categories c on c.id = p.category_id where p.org_id = $1 and coalesce(p.active, true)`;
// 没听懂的问法（一样关键词都没认出来的）记在这台电脑上，最多 60 条；中方在搜索框空着时能看到、一键复制，发给 Claude 加关键词。
const MISS_KEY = 'la9s.ask.miss';
const readMiss = () => { try { return JSON.parse(localStorage.getItem(MISS_KEY)) || []; } catch { return []; } };
const logMiss = (t) => { const txt = String(t).trim().slice(0, 80); const l = [{ t: txt, d: new Date().toISOString().slice(0, 10) }, ...readMiss().filter((x) => x.t !== txt)].slice(0, 60); try { localStorage.setItem(MISS_KEY, JSON.stringify(l)); } catch { /* ignore */ } return l; };
// 时间小块能点开换（和页面日期按钮同一套口径）
const WHEN_OPTS = [['day', '今天'], ['yesterday', '昨天'], ['week', '本周'], ['lastweek', '上周'], ['month', '本月'], ['lastmonth', '上月'], ['quarter', '本季度'], ['year', '今年'], ['all', '全部时间']];
const whenPatch = (k) => {
  const d = new Date(); const lm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const pk = k === 'lastmonth' ? `m:${lm.getFullYear()}-${lm.getMonth() + 1}` : k === 'all' ? 'custom' : k;
  const [from, to] = periodRange(k === 'lastmonth' ? pk : k);
  return { from, to, pk, when: WHEN_OPTS.find((x) => x[0] === k)[1], said: null };
};
const whenKey = (P) => (P.from === '2000-01-01' ? 'all' : WHEN_OPTS.find(([k]) => { const w = whenPatch(k); return w.from === P.from && w.to === P.to; })?.[0] || '');

function AskPanel({ onClose }) {
  const { org, go, openArchive, role } = useApp();
  const { data: dict } = useData(async () => {
    const [emps, custs, cats, prods, deals, pos] = await Promise.all([q(`select id, short_name, full_name, emp_no from app.employees where org_id = $1`, [org]),
      q(`select c.id, c.name, coalesce(c.code, c.temp_code) as code, c.city from app.customers c where c.org_id = $1`, [org]), q(`select id, name from app.categories where org_id = $1`, [org]),
      q(PROD_SQL, [org]),
      q(`select d.id, d.biz_no, d.so_no, d.quote_no, d.status, d.created_at, c.name as customer from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 order by d.created_at desc limit 5000`, [org]),
      // 11-27 Frank: 搜几个数字也要能找到采购单 —— 采购单号 / 入仓号 / 物流单号 / 柜号 / 需求批次 / 金蝶入库单号
      q(`select p.id, p.po_no, p.batch_name, p.warehouse_nos, p.tracking_no, p.container_no, p.forwarder, p.eta, p.status,
           (select string_agg(coalesce(r.kd_no, '') || ' ' || coalesce(r.grn_no, ''), ' ') from app.po_receipts r where r.po_id = p.id) as grn_nos
         from app.purchase_orders p where p.org_id = $1 order by coalesce(p.shipped_on, p.ordered_on) desc nulls last limit 3000`, [org]).catch(() => [])]);
    return { emps, custs, cats, prods, deals, pos, models: [...new Set(prods.map((p) => p.model).filter(Boolean))] };
  }, [org]);
  const [text, setText] = useState(() => { try { return sessionStorage.getItem('la9s.ask.last') || ''; } catch { return ''; } });
  const [P, setP] = useState(null); const [asked, setAsked] = useState(''); const [rows, setRows] = useState(null); const [busy, setBusy] = useState(false); const [hi, setHi] = useState(-1);
  const inp = useRef(null); const list = useRef(null);
  const [miss, setMiss] = useState(readMiss); const [missOpen, setMissOpen] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => { setTimeout(() => inp.current?.select(), 30); }, []);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);   // 焦点不在输入框里 Esc 也能关
  const ask = async (t = text, over) => {
    if (!dict || !String(t).trim()) return;
    try { sessionStorage.setItem('la9s.ask.last', t); } catch { /* ignore */ }
    const p = over || parse(t, dict); setP(p); setAsked(t); setBusy(true); setHi(-1);
    if (!over && p.blank) setMiss(logMiss(t));
    try { setRows(await run(org, p)); } catch (e) { setRows([]); console.warn(e); } finally { setBusy(false); }
  };
  const tweak = (patch) => ask(asked, { ...P, ...patch, blank: false, said: patch.said === null ? { ...(P.said || {}), when: true } : P.said });
  const doJump = (J) => {
    try { sessionStorage.setItem('la9s.ask.last', text); } catch { /* ignore */ }
    onClose();
    if (J.kind === 'orders') ordersJump(go, J.j);
    else if (J.kind === 'po') poJump(go, J.j);
    else if (J.kind === 'stock') { try { sessionStorage.setItem('la9s.stock.q', J.q); } catch { /* ignore */ } go('stock'); setTimeout(() => window.dispatchEvent(new Event('la9s-stock-q')), 50); }
    else if (J.kind === 'arch') openArchive(J.a);
    else { if (J.period) presetPeriod(J.period[0], J.period[1] || 'custom', J.period[2]); go(J.to); }   // 11-25: 收款页也把时间带过去
  };
  // ── 一边打一边出：单号 / 客户 / 型号（型号、编码、通用型号，跟下单选货同一套）/ 员工 / 页面
  const hits = useMemo(() => {
    const t = text.trim(); if (!dict || !t) return null;
    const T = norm(t); const low = t.toLowerCase();
    const deals = T.length >= 3 ? dict.deals.filter((d) => [d.biz_no, d.so_no, d.quote_no].some((x) => x && norm(x).includes(T))).slice(0, 5) : [];
    const custs = dict.custs.filter((c) => String(c.name || '').toLowerCase().includes(low) || norm(c.code).includes(T)).sort((a, b) => String(a.name).toLowerCase().startsWith(low) ? -1 : String(b.name).toLowerCase().startsWith(low) ? 1 : 0).slice(0, 5);
    // 打分：型号里有一个词正好是它（SS A10 ← A10）> 型号开头 > 某个词开头 > 型号里有 > 编码 / 规格 / 通用型号；同分库存多的先
    const words = (m) => String(m || '').toUpperCase().split(/[\s_\-/()（）]+/).filter(Boolean);
    const sc = (p) => { const m = norm(p.model); const ws = words(p.model);
      return ws.includes(T) || m === T ? 5 : m.startsWith(T) ? 4 : ws.some((w) => w.startsWith(T)) ? 3 : m.includes(T) ? 2 : norm(p.code).includes(T) || norm(p.variant).includes(T) ? 1.5 : (p.shared_models || []).some((x) => norm(x).includes(T)) ? 1 : 0; };
    const prods = T.length >= 2 ? dict.prods.map((p) => [p, sc(p)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (b[0].avail - a[0].avail)).slice(0, 8).map(([p]) => p) : [];
    const emps = hasAny(role, ['admin', 'sales_manager']) ? dict.emps.filter((e) => [e.short_name, e.full_name, e.emp_no].some((x) => x && String(x).toLowerCase().includes(low))).slice(0, 3) : [];
    const pages = Object.entries(ITEMS).filter(([r, v]) => String(v[1]).includes(t) && visibleTo(r, role)).slice(0, 4);
    // 采购单: 打字母数字都行; 只打数字时也去掉单号里的字母再比 (搜 300649 → LKY300649Y)
    const dig = /^\d{3,}$/.test(T) ? T : '';
    const poHit = (p) => {
      const F = [['入仓号', ...(p.warehouse_nos || [])], ['物流单号', p.tracking_no], ['柜号', p.container_no], ['采购单号', p.po_no], ['需求批次', p.batch_name], ['金蝶入库', ...String(p.grn_nos || '').split(' ')]];
      for (const [lab, ...vals] of F) for (const v of vals) { if (!v) continue; const n = norm(v); if (n.includes(T) || (dig && n.replace(/\D/g, '').includes(dig))) return { lab, v }; }
      return null;
    };
    const pos = T.length >= 3 && dict.pos ? dict.pos.map((p) => [p, poHit(p)]).filter(([, h]) => h).slice(0, 5).map(([p, h]) => ({ ...p, hit: h })) : [];
    return { deals, pos, custs, prods, emps, pages };
  }, [text, dict, role]);
  const jumps = P && rows ? jumpsOf(P, rows) : [];
  // 键盘上下走的顺序：问题的跳转 → 单号 → 客户 → 型号 → 员工 → 页面
  const flat = useMemo(() => {
    const f = [];
    if (P && rows && asked === text) jumps.forEach((J) => f.push(() => doJump(J)));
    if (hits) {
      hits.deals.forEach((d) => f.push(() => doJump({ kind: 'go', to: `deal/${d.id}` })));
      hits.pos.forEach((p) => f.push(() => doJump({ kind: 'arch', a: { kind: 'po', id: p.id } })));
      hits.custs.forEach((c) => f.push(() => doJump({ kind: 'arch', a: { kind: 'customer', id: c.id } })));
      hits.prods.forEach((p) => f.push(() => doJump({ kind: 'arch', a: { kind: 'product', product: { id: p.id, model: p.model } } })));
      hits.emps.forEach((e) => f.push(() => doJump({ kind: 'arch', a: { kind: 'employee', id: e.id } })));
      hits.pages.forEach(([r]) => f.push(() => doJump({ kind: 'go', to: r })));
    }
    return f;
  }, [hits, P, rows, asked, text]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { list.current?.querySelector('.ask-hi')?.scrollIntoView({ block: 'nearest' }); }, [hi]);
  const looksQ = looksLikeQuestion(text) && !hits?.deals.length && !hits?.pos.length;   // 打的是单号（搜到了单）就不当问题：单号里的「18-01」长得像日期
  const enter = () => {
    if (hi >= 0 && flat[hi]) return flat[hi]();
    if (P && rows && asked === text && jumps[0]) return doJump(jumps[0]);
    const nothing = hits && !hits.deals.length && !hits.pos.length && !hits.custs.length && !hits.prods.length && !hits.emps.length && !hits.pages.length;
    if (looksQ || nothing) return ask();
    if (flat[0]) return flat[0]();
    return ask();
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
  };
  let idx = (P && rows && asked === text) ? jumps.length : 0;
  const cls = (i) => (i === hi ? 'ask-hi' : '');
  const tot = useMemo(() => (rows || []).reduce((a, r) => ({ qty: a.qty + Number(r.qty || 0), amount: a.amount + Number(r.amount || 0), n: a.n + Number(r.n || 0) }), { qty: 0, amount: 0, n: 0 }), [rows]);
  const say = P && rows ? (() => {
    const who = [P.emp ? `${P.emp.short_name}${P.metric === 'ar' || P.group === 'customer' ? ' 名下' : ''}` : null, P.cust?.name, P.cat?.name, P.model].filter(Boolean).join(' · ') || '全公司';
    const g = GROUP.find((x) => x[0] === P.group)?.[1].replace('按', '') || '';
    if (P.subject === 'po') { const st = P.poStage ? PO_STAGE_NAME[P.poStage] : ''; const pu = P.purpose === 'fob' ? 'FOB ' : P.purpose === 'local' ? '本地备货 ' : '';
      if (!rows.length) return `${P.when}（按下单日）：没有${pu}${st ? `「${st}」的` : ''}采购单。`;
      const rc = rows.filter((r) => r.recv).length;
      return `${P.when}（按下单日）：${pu}${st ? `「${st}」` : ''}采购单 ${rows.length} 张，共 ${fmt(tot.qty)} 片${P.poStage ? '' : `；已入库（含部分）${rc} 张，没入库 ${rows.length - rc} 张`}。`; }
    if (orderMode(P)) { const ft = [P.tier && `${TIER_NAME[P.tier]} 档`, P.pay && PAY_NAME[P.pay], P.step && STEP_NAME[P.step], P.light && LIGHT_NAME[P.light]].filter(Boolean).join(' · ');
      const w2 = [P.emp ? `${P.emp.short_name} 名下` : null, P.cust?.name, P.cat?.name, P.model].filter(Boolean).join(' · ');
      if (!rows.length) return `${w2 ? w2 + ' ' : ''}${P.when}：没有「${ft}」的订单。`;
      const due = rows.reduce((a, r) => a + (r.due || 0), 0);
      return `${w2 ? w2 + ' ' : ''}${P.when}「${ft}」订单 ${rows.length} 张 · ${fmt(tot.qty)} 片 · ${fmt(tot.amount)} XOF${due > 0 ? `，还欠 ${fmt(due)}` : ''}。`; }
    if (!rows.length) return `${who} ${NOW.has(P.metric) ? '现在' : P.when}：没有${({ recv: '收款', ret: '退货', ar: '欠款', stock: '库存' })[P.metric] || '出库'}。`;
    if (P.metric === 'recv') return `${who} ${P.when}：收款 ${fmt(tot.amount)} XOF，${tot.n} 笔。`;
    if (P.metric === 'ar') return P.cust ? `${P.cust.name} 现在欠 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清。` : `${who} 现在：欠款 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清，${rows.length} 个${g}；最多 ${rows[0].label}（${fmt(rows[0].amount)}）。`;
    if (P.metric === 'stock') return `${who} 现在：本地库存 ${fmt(tot.qty)} 片（可售 ${fmt(tot.amount)}），${rows.length} 个${g}。`;
    return `${who} ${P.when}：${P.metric === 'ret' ? '退货' : '出库'} ${fmt(tot.qty)} 片 · ${fmt(tot.amount)} XOF · ${tot.n} 单${rows.length > 1 ? `，最多 ${rows[0].label}（${fmt(P.metric === 'amount' ? rows[0].amount : rows[0].qty)}${P.metric === 'amount' ? ' XOF' : ' 片'}）` : ''}。`;
  })() : '';
  const rowJump = (r) => {
    const base = { cust: P.cust?.id, model: P.model, cat: P.cat?.name, emp: P.emp?.id, from: P.from, to: P.to, pk: P.pk === 'all' ? 'custom' : P.pk, ask: true, tier: P.tier };
    if (r.poid) return doJump({ kind: 'arch', a: { kind: 'po', id: r.poid } });
    if (orderMode(P) && r.did) return doJump({ kind: 'go', to: `deal/${r.did}` });
    if (P.metric === 'stock') return doJump({ kind: 'stock', q: r.label });
    if (P.group === 'deal') return doJump({ kind: 'go', to: `deal/${r.did || r.k}` });
    if (['ar', 'recv'].includes(P.metric)) return r.cid && P.group === 'customer' ? doJump({ kind: 'go', to: `customer/${r.cid}` }) : doJump({ kind: 'go', to: 'balances' });
    if (P.group === 'customer') return doJump({ kind: 'orders', j: { ...base, cust: r.cid } });
    if (P.group === 'model') return doJump({ kind: 'orders', j: { ...base, model: r.label } });
    if (P.group === 'category') return doJump({ kind: 'orders', j: { ...base, cat: r.label } });
    if (P.group === 'employee') return r.eid ? doJump({ kind: 'orders', j: { ...base, emp: r.eid } }) : null;
    if (P.group === 'day') { const d = `${(r.label > P.to.slice(5) ? P.from : P.to).slice(0, 4)}-${r.label}`; return doJump({ kind: 'orders', j: { ...base, from: d, to: d, pk: `d:${d}` } }); }
    return null;
  };
  const chip = (txt, onX) => <span className="ask-chip">{txt}{onX && <button type="button" aria-label="去掉" onClick={onX}>×</button>}</span>;
  const top = (rows || []).slice(0, 6);
  const showQ = P && rows && asked === text;
  const sec = (title, n) => n > 0 && <div className="ask-sec">{title}</div>;
  return (
    <div className="ask-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ask-pop" role="dialog" aria-label="智能搜索">
        <form className="ask-row" onSubmit={(e) => { e.preventDefault(); enter(); }}>
          <span className="ask-ico big">⌕</span>
          <input ref={inp} className="ask-in" value={text} onChange={(e) => { setText(e.target.value); setHi(-1); }} onKeyDown={key} placeholder="搜型号 / 编码 / 通用型号、客户、单号、员工；或问一句「Thomas 的 balance」" />
          {looksQ && !showQ && <button type="button" className="btn soft sm" onClick={() => ask()} disabled={!dict}>按问题理解 ↵</button>}
          <button type="button" className="btn ghost sm" onClick={onClose}>Esc</button>
        </form>
        <div className="ask-body" ref={list}>
          {!text.trim() && <div className="ask-ex">{EX.map((x) => <button type="button" key={x} className="ask-exb" onClick={() => { setText(x); ask(x); }}>{x}</button>)}
            <div className="small muted" style={{ marginTop: 8 }}>打字就出：型号（型号 / 编码 / 通用型号都行）、客户、单号、员工、页面，↑↓ 选、回车打开。像问题的话（带时间、销量、欠款、库存…）回车就按问题理解，给一句结论 + 跳到筛好的清单。中文、英语、法语都行。</div>
            {role === 'admin' && miss.length > 0 && <div className="ask-misslist">
              <button type="button" className="linkbtn small" onClick={() => setMissOpen(!missOpen)}>没听懂的问法 {miss.length} 条 {missOpen ? '▴' : '▾'}</button>
              {missOpen && <><div className="ask-missrows">{miss.map((x) => <div key={x.t} className="small"><span className="muted">{x.d.slice(5)}</span> {x.t}</div>)}</div>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn sm" onClick={() => { navigator.clipboard?.writeText(miss.map((x) => x.t).join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? '已复制' : '复制全部'}</button>
                  <button type="button" className="btn sm ghost" onClick={() => { try { localStorage.removeItem(MISS_KEY); } catch { /* ignore */ } setMiss([]); setMissOpen(false); }}>清空</button>
                  <span className="small muted">复制后发给 Claude，加进关键词</span></div></>}
            </div>}</div>}
          {showQ && <div className="ask-ans">
            <div className="ask-chips">
              <span className="small muted">听懂的：</span>
              {NOW.has(P.metric) && !P.subject && !orderMode(P) ? chip('现在') : <>
                {whenKey(P) ? <Choice size="sm" value={whenKey(P)} onChange={(v) => tweak(whenPatch(v))} flat={false} options={WHEN_OPTS} /> : <span className="ask-chip" title="点右边的 × 回到本月">{P.when}<button type="button" aria-label="回到本月" onClick={() => tweak(whenPatch('month'))}>×</button></span>}
                <span className="small muted ask-range">{P.from === '2000-01-01' ? '' : `${P.from.slice(5)}${P.to !== P.from ? ' – ' + P.to.slice(5) : ''}`}{P.said && !P.said.when ? (P.from === '2000-01-01' ? ' · 没说时间，看全部' : ' · 没说时间，按本月') : ''}</span></>}
              {P.emp && chip(`销售员 ${P.emp.short_name}`, () => tweak({ emp: null }))}
              {P.cust && chip(`客户 ${P.cust.name}`, () => tweak({ cust: null, custAlt: [] }))}
              {P.cat && chip(`种类 ${P.cat.name}`, () => tweak({ cat: null }))}
              {P.model && chip(`型号 ${P.model}`, () => tweak({ model: null }))}
              {P.subject === 'po' && chip('采购单', () => tweak({ subject: null, poStage: null, purpose: null }))}
              {P.poStage && chip(PO_STAGE_NAME[P.poStage], () => tweak({ poStage: null }))}
              {P.purpose && chip(P.purpose === 'fob' ? 'FOB' : '本地备货', () => tweak({ purpose: null }))}
              {P.tier && chip(`档位 ${TIER_NAME[P.tier]}`, () => tweak({ tier: null }))}
              {P.pay && chip(PAY_NAME[P.pay], () => tweak({ pay: null }))}
              {P.step && chip(STEP_NAME[P.step], () => tweak({ step: null }))}
              {P.light && chip(LIGHT_NAME[P.light], () => tweak({ light: null }))}
              {!P.subject && !orderMode(P) && <><Choice size="sm" value={P.metric} onChange={(v) => tweak({ metric: v })} flat={false} options={METRIC} />
              <Choice size="sm" value={P.group} onChange={(v) => tweak({ group: v })} flat={false} options={GROUP.filter(([k]) => (P.metric === 'stock' ? ['model', 'category'].includes(k) : P.metric === 'ar' ? ['customer', 'employee', 'deal'].includes(k) : P.metric !== 'recv' || !['model', 'category', 'deal'].includes(k)))} /></>}
            </div>
            {P.custAlt?.length > 0 && <div className="small muted">不是这个客户？{P.custAlt.map((c) => <button type="button" key={c.id} className="linkbtn small" style={{ marginLeft: 6 }} onClick={() => tweak({ cust: c, custAlt: [P.cust, ...P.custAlt.filter((x) => x.id !== c.id)] })}>{c.name}</button>)}</div>}
            {P.blank && <div className="ask-miss">没听懂「{asked}」。下面是默认的：本月 · 销量 · 按销售员；点上面的小块可以改，或者换个说法。这句话已经记下来，方便以后加关键词。</div>}
            {say && <div className="ask-say">{say}</div>}
            {jumps.length > 0 && <div className="ask-jumps">{jumps.map((J, i) => (
              <button type="button" key={i} className={`ask-jump ${i === 0 ? 'main' : ''} ${cls(i)}`} onClick={() => doJump(J)}><b>{J.label} →</b><small>{J.sub}</small></button>))}</div>}
            {top.length > (P.subject || orderMode(P) ? 0 : 1) && <div className="ask-top">{top.map((r) => (
              <button type="button" key={r.k} className="ask-tr" title="点了直接打开" onClick={() => rowJump(r)}>
                <span className="ask-tl">{r.label}</span><span className="grow" />{r.right ? <><span className="muted small">{fmt(r.qty)} 片</span><span className="small">{r.right}</span></> : <>{!['recv', 'ar'].includes(P.metric) && <span className="muted small">{fmt(r.qty)} 片</span>}<b>{fmt(r.amount)}</b></>}</button>))}
              {rows.length > top.length && <div className="small muted" style={{ padding: '4px 8px' }}>还有 {rows.length - top.length} 个，跳过去看全部</div>}</div>}
          </div>}
          {busy && <div className="small muted">算一下…</div>}
          {hits && <>
            {sec('单号', hits.deals.length)}{hits.deals.map((d) => { const i = idx++; return (
              <button type="button" key={d.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}><b className="mono">{d.biz_no}</b><span className="muted small">{d.customer}</span><span className="grow" /><span className="small muted">{String(d.created_at).slice(0, 10)}</span></button>); })}
            {sec('采购单', hits.pos.length)}{hits.pos.map((p) => { const i = idx++; return (
              <div key={p.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} role="button" tabIndex={-1} onClick={() => flat[i]()}>
                <span className="small muted">{p.hit.lab}</span><b className="mono">{p.hit.v}</b><span className="muted small">{p.po_no}{p.forwarder ? ` · ${p.forwarder}` : ''}{p.eta ? ` · 预计 ${dDate(p.eta)}` : ''}</span><span className="grow" />
                <button type="button" className="btn sm" title="复制这个号，直接粘贴去用" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(p.hit.v); e.currentTarget.textContent = '已复制'; }}>复制</button>
              </div>); })}
            {sec('客户', hits.custs.length)}{hits.custs.map((c) => { const i = idx++; return (
              <div key={c.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} role="button" tabIndex={-1} onClick={() => flat[i]()}>
                <b>{c.name}</b><span className="muted small mono">{c.code}</span><span className="muted small">{c.city}</span><span className="grow" />
                <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); doJump({ kind: 'orders', j: { cust: c.id, from: '2000-01-01', to: ymd(new Date()), ask: true } }); }}>订单</button>
                <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); doJump({ kind: 'go', to: `customer/${c.id}` }); }}>总账</button>
                <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); doJump({ kind: 'go', to: `receipts/${c.id}` }); }}>收款</button></div>); })}
            {sec('型号（型号 / 编码 / 通用型号）', hits.prods.length)}{hits.prods.map((p) => { const i = idx++; return (
              <button type="button" key={p.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}>
                <b>{p.model}</b><span className="muted small">{p.category}{p.variant ? ` · ${p.variant}` : ''}</span><span className="mono small muted">{p.code}</span>
                <span className="grow" /><span className={`pill ${p.avail > 0 ? 'green' : 'gray'}`}>{p.avail > 0 ? `可售 ${fmt(p.avail)}` : '没货'}</span>
                {(p.shared_models || []).length > 0 && <span className="small muted ask-sh">通用 {p.shared_models.slice(0, 3).join(' / ')}{p.shared_models.length > 3 ? ' …' : ''}</span>}</button>); })}
            {sec('员工', hits.emps.length)}{hits.emps.map((e) => { const i = idx++; return (
              <button type="button" key={e.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}><b>{e.short_name}</b><span className="muted small">{e.emp_no || ''} {e.full_name && e.full_name !== e.short_name ? e.full_name : ''}</span></button>); })}
            {sec('页面', hits.pages.length)}{hits.pages.map(([r, v]) => { const i = idx++; return (
              <button type="button" key={r} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}><span>{v[0]}</span><b>{v[1]}</b></button>); })}
            {!showQ && !hits.deals.length && !hits.pos.length && !hits.custs.length && !hits.prods.length && !hits.emps.length && !hits.pages.length && <div className="small muted" style={{ padding: 8 }}>没有直接对上的。回车按问题理解。</div>}
          </>}
        </div>
      </div>
    </div>);
}
