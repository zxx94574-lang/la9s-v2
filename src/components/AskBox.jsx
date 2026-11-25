// 智能搜索（Frank 11-25 14:00 改）：顶栏右上一个按钮 → 弹出搜索；一句话问 → 结论 + 一键跳转到对应清单（自动筛好）。
// 原来是：经营总览顶上一个框，用平常说话的方式问数，例「Koffi 昨天对应客户的销量」
// 不用外部 AI（数据不出这台电脑 / 服务器）：本地听懂「谁 / 哪个客户 / 哪个型号或种类 / 什么时候 / 看什么 / 按什么分」，
// 听懂的部分显示成一排小块，点 × 去掉、点分组换一种分法；结果是一张表 + 一句话，客户 / 型号 / 员工都能点开。
// 销量 = 出库（作废的不算，退货另列）；员工 = 订单上的归属销售员（激励也按这个算）；金额一律折成 XOF。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Choice } from './ui.jsx';
import { ordersJump } from '../lib/dirWork.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');
const norm = (s) => String(s || '').toUpperCase().replace(/[\s_\-·.]+/g, '');

// 时间：返回 [from, to, 说法]
export function parseWhen(t, now = new Date()) {
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mon = (d) => addD(d, -((d.getDay() + 6) % 7));
  let m;
  if (/前天|avant-hier/i.test(t)) { const d = addD(d0, -2); return [ymd(d), ymd(d), `前天 ${ymd(d).slice(5)}`]; }
  if (/昨天|昨日|yesterday|hier/i.test(t)) { const d = addD(d0, -1); return [ymd(d), ymd(d), `昨天 ${ymd(d).slice(5)}`]; }
  if (/今天|今日|today|aujourd/i.test(t)) return [ymd(d0), ymd(d0), '今天'];
  if ((m = t.match(/(?:最近|近|过去|last)\s*(\d+)\s*(?:天|日|days?|jours?)/i))) { const n = Number(m[1]); return [ymd(addD(d0, -(n - 1))), ymd(d0), `近 ${n} 天`]; }
  if (/上周|上个星期|last week/i.test(t)) { const a = addD(mon(d0), -7); return [ymd(a), ymd(addD(a, 6)), '上周']; }
  if (/本周|这周|这个星期|this week/i.test(t)) return [ymd(mon(d0)), ymd(d0), '本周'];
  if (/上个?月|last month/i.test(t)) { const a = new Date(d0.getFullYear(), d0.getMonth() - 1, 1); return [ymd(a), ymd(new Date(d0.getFullYear(), d0.getMonth(), 0)), '上月']; }
  if ((m = t.match(/(\d{1,2})\s*月份?/)) && !/个月/.test(t.slice(m.index, m.index + 4))) { const mm = Number(m[1]); if (mm >= 1 && mm <= 12) { const y = mm > d0.getMonth() + 1 ? d0.getFullYear() - 1 : d0.getFullYear(); return [ymd(new Date(y, mm - 1, 1)), ymd(new Date(y, mm, 0)), `${mm} 月`]; } }
  if (/今年|本年|this year/i.test(t)) return [`${d0.getFullYear()}-01-01`, ymd(d0), '今年'];
  if (/去年|last year/i.test(t)) return [`${d0.getFullYear() - 1}-01-01`, `${d0.getFullYear() - 1}-12-31`, '去年'];
  if (/所有|全部|一直|历史|从来|至今|tout/i.test(t)) return ['2000-01-01', ymd(d0), '全部时间'];
  return [ymd(new Date(d0.getFullYear(), d0.getMonth(), 1)), ymd(d0), '本月'];
}

const METRIC = [['qty', '销量（片）'], ['amount', '销售额'], ['recv', '收款'], ['ret', '退货'], ['ar', '欠款（现在）'], ['stock', '库存（现在）']];
const NOW = new Set(['ar', 'stock']);   // 这两个看的是「现在」，不看时间段
const GROUP = [['customer', '按客户'], ['model', '按型号'], ['category', '按种类'], ['employee', '按销售员'], ['day', '按天'], ['deal', '按订单']];

export function parse(text, dict) {
  const t = String(text || ''); const T = norm(t); const low = t.toLowerCase();
  const [from, to, when] = parseWhen(t);
  // 问话里常用的词不当人名 / 客户名（演示数据里有叫「销售」「客户」的）
  const STOP = new Set(['销售', '客户', '员工', '仓库', '热线', '财务', '主管', '中方', '收款', '型号', '种类', '本月', '今天', '昨天']);
  const hit = (arr, keys, stop = true) => arr.filter((x) => keys(x).some((k) => k && String(k).length >= 2 && !(stop && STOP.has(String(k).trim())) && low.includes(String(k).toLowerCase())));
  // 整个名字出现在话里优先；没有就按单词找（打「thomas」也能找到「THOMAS AJM」），多个候选让人点着换
  const words = (low.match(/[a-zà-ÿ0-9]{3,}/g) || []).filter((w) => !/^(xof|cny|usd|balance|pcs|the)$/.test(w));
  const fuzzy = (arr, keys) => arr.filter((x) => keys(x).some((k) => k && words.some((w) => String(k).toLowerCase().split(/[\s\-_.·]+/).some((part) => part.startsWith(w)))));
  const emps = hit(dict.emps, (e) => [e.short_name, e.full_name, e.emp_no]);
  const emp = emps[0] || (/(销售员|员工|业务员|名下|负责)/.test(t) ? fuzzy(dict.emps, (e) => [e.short_name, e.full_name])[0] : null) || null;
  let custs = hit(dict.custs, (c) => [c.name, c.code]).sort((a, b) => b.name.length - a.name.length).filter((c) => !emp || !String(emp.short_name).toLowerCase().includes(c.name.toLowerCase()));
  if (!custs.length) custs = fuzzy(dict.custs, (c) => [c.name, c.code]).filter((c) => !emp || !fuzzy([emp], (e) => [e.short_name]).length || !String(c.name).toLowerCase().includes(String(emp.short_name).toLowerCase()));
  const cust = custs[0] || null; const custAlt = custs.slice(1, 6);
  const cat = hit(dict.cats, (c) => [c.name], false).sort((a, b) => b.name.length - a.name.length)[0] || null;
  let model = null;
  for (const p of dict.models) { const k = norm(p); if (k.length >= 3 && T.includes(k) && (!model || k.length > norm(model).length)) model = p; }
  const metric = /欠款|欠多少|应收|没付|balance|余额|对账|impay|dette|solde/i.test(t) ? 'ar' : /库存|还有多少|有货|剩多少|stock/i.test(t) ? 'stock' : /收款|回款|收了|进账|encaiss/i.test(t) ? 'recv' : /退货|退了|retour/i.test(t) ? 'ret' : /金额|销售额|营业额|多少钱|卖了多少钱|chiffre/i.test(t) ? 'amount' : 'qty';
  let group = /卖给了?谁|给谁|哪些客户|谁欠|谁买/.test(t) ? 'customer' : /每天|按天|每日|天天|par jour/i.test(t) ? 'day' : /型号|机型|modèle/i.test(t) && !model ? 'model' : /种类|类别/i.test(t) && !cat ? 'category'
    : /客户|client/i.test(t) && !cust ? 'customer' : /销售员|员工|谁|每个人|业务员|vendeur/i.test(t) && !emp ? 'employee' : /订单|单子|commande/i.test(t) ? 'deal' : null;
  if (!group) group = emp && !cust ? 'customer' : cust ? 'model' : model ? 'customer' : 'employee';
  if (['recv', 'ar'].includes(metric) && ['model', 'category', 'day', 'deal'].includes(group)) group = metric === 'ar' && group === 'deal' ? 'deal' : 'customer';
  if (metric === 'stock' && !['model', 'category'].includes(group)) group = model ? 'model' : cat ? 'model' : 'category';
  return { from, to, when, emp, cust, custAlt, cat, model, metric, group };
}

const KEY = { customer: ['c.id', 'c.name'], model: ['p.model', 'p.model'], category: ['cat.name', 'cat.name'], employee: ['e.id', "coalesce(e.short_name, '（无归属）')"], day: ['s.shipped_at::date', "to_char(s.shipped_at::date, 'MM-DD')"], deal: ['d.id', 'd.biz_no'] };
async function run(org, P) {
  const args = [org, P.from, P.to]; const w = [];
  const add = (sql, v) => { args.push(v); w.push(sql.replace('?', `$${args.length}`)); };
  if (P.emp) add('d.owner_employee_id = ?', P.emp.id);
  if (P.cust) add('d.customer_id = ?', P.cust.id);
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

const EX = ['Thomas 今年所有销售清单', 'Thomas 的 balance', 'Koffi 昨天对应客户的销量', '本月每个销售员卖了多少钱', '现在谁欠款最多', '近 7 天收款按客户', '电池盖库存'];

// 去哪看（一键跳转，到了自动筛好）：每种问法给一个主按钮，必要时再给一两个
function jumpsOf(P, rows) {
  const J = [];
  const day = (x) => x.slice(5);
  const range = P.from === '2000-01-01' ? '全部时间' : `${day(P.from)} – ${day(P.to)}`;
  const ordersJ = { kind: 'orders', j: { cust: P.cust?.id, model: P.model, cat: P.cat?.name, emp: P.emp?.id, from: P.from, to: P.to, ask: true } };
  if (P.metric === 'ar') {
    if (P.cust) J.push({ ...{ kind: 'go', to: `customer/${P.cust.id}` }, label: `打开 ${P.cust.name} 的总账`, sub: '看 Balance、发对账单、把收款冲到订单' });
    else if (rows?.length === 1 && rows[0].cid) J.push({ kind: 'go', to: `customer/${rows[0].cid}`, label: `打开 ${rows[0].label} 的总账`, sub: '看 Balance、冲订单' });
    else J.push({ kind: 'go', to: 'balances', label: '打开客户欠款清单', sub: '全部客户的 Balance；点客户进总账冲单' });
    if (P.cust) J.push({ ...ordersJ, j: { ...ordersJ.j, from: '2000-01-01', model: null, cat: null }, label: `${P.cust.name} 的全部订单`, sub: '订单总览，已筛好这个客户' });
  } else if (P.metric === 'recv') {
    J.push({ kind: 'go', to: P.cust ? `receipts/${P.cust.id}` : 'receipts', label: P.cust ? `打开 ${P.cust.name} 的收款` : '打开收款与总账', sub: P.cust ? '收款记录，已选好这个客户' : '登记 / 查收款' });
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
  const ok = ['admin', 'manager', 'finance', 'sales_manager'].includes(role);
  useEffect(() => {
    if (!ok) return undefined;
    const k = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [ok]);
  if (!ok) return null;
  return (<>
    <button type="button" className="ask-btn" onClick={() => setOpen(true)} title="智能搜索：用一句话问数，问完一键跳到对应清单（已自动筛好）。快捷键 ⌘K / Ctrl+K">
      <span className="ask-ico">⌕</span><span className="ask-l">智能搜索</span></button>
    {open && <AskPanel onClose={() => setOpen(false)} />}
  </>);
}

function AskPanel({ onClose }) {
  const { org, go } = useApp();
  const { data: dict } = useData(async () => {
    const [emps, custs, cats, models] = await Promise.all([q(`select id, short_name, full_name, emp_no from app.employees where org_id = $1`, [org]),
      q(`select id, name, code from app.customers where org_id = $1`, [org]), q(`select id, name from app.categories where org_id = $1`, [org]),
      q(`select distinct model from app.products where org_id = $1 and model is not null`, [org])]);
    return { emps, custs, cats, models: models.map((m) => m.model) };
  }, [org]);
  const [text, setText] = useState(() => { try { return sessionStorage.getItem('la9s.ask.last') || ''; } catch { return ''; } });
  const [P, setP] = useState(null); const [rows, setRows] = useState(null); const [busy, setBusy] = useState(false);
  const inp = useRef(null);
  useEffect(() => { setTimeout(() => inp.current?.select(), 30); }, []);
  const ask = async (t = text, over) => {
    if (!dict || !String(t).trim()) return;
    try { sessionStorage.setItem('la9s.ask.last', t); } catch { /* ignore */ }
    const p = over || parse(t, dict); setP(p); setBusy(true);
    try { setRows(await run(org, p)); } catch (e) { setRows([]); console.warn(e); } finally { setBusy(false); }
  };
  const tweak = (patch) => ask(text, { ...P, ...patch });
  const jumps = P && rows ? jumpsOf(P, rows) : [];
  const doJump = (J) => {
    onClose();
    if (J.kind === 'orders') ordersJump(go, J.j);
    else if (J.kind === 'stock') { try { sessionStorage.setItem('la9s.stock.q', J.q); } catch { /* ignore */ } go('stock'); setTimeout(() => window.dispatchEvent(new Event('la9s-stock-q')), 50); }
    else go(J.to);
  };
  // 点预览里的一行：销量类 → 订单总览筛这个客户 / 型号 / 销售员；欠款 / 收款 → 客户总账；库存 → 库存
  const rowJump = (r) => {
    const base = { cust: P.cust?.id, model: P.model, cat: P.cat?.name, emp: P.emp?.id, from: P.from, to: P.to, ask: true };
    if (P.metric === 'stock') return doJump({ kind: 'stock', q: r.label });
    if (P.group === 'deal') return doJump({ kind: 'go', to: `deal/${r.did || r.k}` });
    if (['ar', 'recv'].includes(P.metric)) return r.cid && P.group === 'customer' ? doJump({ kind: 'go', to: `customer/${r.cid}` }) : P.group === 'employee' && r.eid ? doJump({ kind: 'go', to: 'balances' }) : null;
    if (P.group === 'customer') return doJump({ kind: 'orders', j: { ...base, cust: r.cid } });
    if (P.group === 'model') return doJump({ kind: 'orders', j: { ...base, model: r.label } });
    if (P.group === 'category') return doJump({ kind: 'orders', j: { ...base, cat: r.label } });
    if (P.group === 'employee') return r.eid ? doJump({ kind: 'orders', j: { ...base, emp: r.eid } }) : null;
    if (P.group === 'day') return doJump({ kind: 'orders', j: { ...base, from: `${P.from.slice(0, 4)}-${r.label}`, to: `${P.from.slice(0, 4)}-${r.label}` } });
    return null;
  };
  const tot = useMemo(() => (rows || []).reduce((a, r) => ({ qty: a.qty + Number(r.qty || 0), amount: a.amount + Number(r.amount || 0), n: a.n + Number(r.n || 0) }), { qty: 0, amount: 0, n: 0 }), [rows]);
  const say = P && rows ? (() => {
    const who = [P.emp ? `${P.emp.short_name}${P.metric === 'ar' || P.group === 'customer' ? ' 名下' : ''}` : null, P.cust?.name, P.cat?.name, P.model].filter(Boolean).join(' · ') || '全公司';
    const g = GROUP.find((x) => x[0] === P.group)?.[1].replace('按', '') || '';
    if (!rows.length) return `${who} ${NOW.has(P.metric) ? '现在' : P.when}：没有${({ recv: '收款', ret: '退货', ar: '欠款', stock: '库存' })[P.metric] || '出库'}。`;
    if (P.metric === 'recv') return `${who} ${P.when}：收款 ${fmt(tot.amount)} XOF，${tot.n} 笔。`;
    if (P.metric === 'ar') return P.cust ? `${P.cust.name} 现在欠 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清。` : `${who} 现在：欠款 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清，${rows.length} 个${g}；最多 ${rows[0].label}（${fmt(rows[0].amount)}）。`;
    if (P.metric === 'stock') return `${who} 现在：本地库存 ${fmt(tot.qty)} 片（可售 ${fmt(tot.amount)}），${rows.length} 个${g}。`;
    return `${who} ${P.when}：${P.metric === 'ret' ? '退货' : '出库'} ${fmt(tot.qty)} 片 · ${fmt(tot.amount)} XOF · ${tot.n} 单${rows.length > 1 ? `，最多 ${rows[0].label}（${fmt(P.metric === 'amount' ? rows[0].amount : rows[0].qty)}${P.metric === 'amount' ? ' XOF' : ' 片'}）` : ''}。`;
  })() : '';
  const chip = (txt, onX) => <span className="ask-chip">{txt}{onX && <button type="button" aria-label="去掉" onClick={onX}>×</button>}</span>;
  const top = (rows || []).slice(0, 6);
  return (
    <div className="ask-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ask-pop" role="dialog" aria-label="智能搜索">
        <form className="ask-row" onSubmit={(e) => { e.preventDefault(); if (P && rows && jumps[0] && text === (sessionStorage.getItem('la9s.ask.last') || '')) doJump(jumps[0]); else ask(); }}>
          <span className="ask-ico big">⌕</span>
          <input ref={inp} className="ask-in" value={text} onChange={(e) => { setText(e.target.value); }} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} placeholder="一句话问，例「Thomas 的 balance」「Koffi 本月客户销量」" />
          <button type="submit" className="btn primary" disabled={!dict || !text.trim() || busy}>{busy ? '…' : '搜'}</button>
        </form>
        {!P && <div className="ask-ex">{EX.map((x) => <button type="button" key={x} className="ask-exb" onClick={() => { setText(x); ask(x); }}>{x}</button>)}
          <div className="small muted" style={{ marginTop: 8 }}>问完给你一句结论 + 一个跳转按钮，到了对应清单已经自动筛好（再按一次回车也是跳转）。⌘K / Ctrl+K 随时打开。</div></div>}
        {P && <>
          <div className="ask-chips">
            <span className="small muted">听懂的：</span>
            {NOW.has(P.metric) ? chip('现在') : chip(`${P.when}${P.from === '2000-01-01' ? '' : `（${P.from.slice(5)}${P.to !== P.from ? ' – ' + P.to.slice(5) : ''}）`}`)}
            {P.emp && chip(`销售员 ${P.emp.short_name}`, () => tweak({ emp: null }))}
            {P.cust && chip(`客户 ${P.cust.name}`, () => tweak({ cust: null, custAlt: [] }))}
            {P.cat && chip(`种类 ${P.cat.name}`, () => tweak({ cat: null }))}
            {P.model && chip(`型号 ${P.model}`, () => tweak({ model: null }))}
            <Choice size="sm" value={P.metric} onChange={(v) => tweak({ metric: v })} flat={false} options={METRIC} />
            <Choice size="sm" value={P.group} onChange={(v) => tweak({ group: v })} flat={false} options={GROUP.filter(([k]) => (P.metric === 'stock' ? ['model', 'category'].includes(k) : P.metric === 'ar' ? ['customer', 'employee', 'deal'].includes(k) : P.metric !== 'recv' || !['model', 'category', 'deal'].includes(k)))} />
          </div>
          {P.custAlt?.length > 0 && <div className="small muted">不是这个客户？{P.custAlt.map((c) => <button type="button" key={c.id} className="linkbtn small" style={{ marginLeft: 6 }} onClick={() => tweak({ cust: c, custAlt: [P.cust, ...P.custAlt.filter((x) => x.id !== c.id)] })}>{c.name}</button>)}</div>}
          {say && <div className="ask-say">{say}</div>}
          {jumps.length > 0 && <div className="ask-jumps">{jumps.map((J, i) => (
            <button type="button" key={i} className={`ask-jump ${i === 0 ? 'main' : ''}`} onClick={() => doJump(J)}><b>{J.label} →</b><small>{J.sub}</small></button>))}</div>}
          {top.length > 1 && <div className="ask-top">{top.map((r) => (
            <button type="button" key={r.k} className="ask-tr" title="点了直接打开" onClick={() => rowJump(r)}>
              <span className="ask-tl">{r.label}</span><span className="grow" />{!['recv', 'ar'].includes(P.metric) && <span className="muted small">{fmt(r.qty)} 片</span>}<b>{fmt(r.amount)}</b></button>))}
            {rows.length > top.length && <div className="small muted" style={{ padding: '4px 8px' }}>还有 {rows.length - top.length} 个，跳过去看全部</div>}</div>}
        </>}
      </div>
    </div>);
}
