// 问一句（Frank 11-25）：经营总览顶上一个框，用平常说话的方式问数，例「Koffi 昨天对应客户的销量」
// 不用外部 AI（数据不出这台电脑 / 服务器）：本地听懂「谁 / 哪个客户 / 哪个型号或种类 / 什么时候 / 看什么 / 按什么分」，
// 听懂的部分显示成一排小块，点 × 去掉、点分组换一种分法；结果是一张表 + 一句话，客户 / 型号 / 员工都能点开。
// 销量 = 出库（作废的不算，退货另列）；员工 = 订单上的归属销售员（激励也按这个算）；金额一律折成 XOF。
import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Choice } from './ui.jsx';
import Grid from './Grid.jsx';
import { CustLink, ModelLink, EmpLink } from './Archives.jsx';

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
  const emp = hit(dict.emps, (e) => [e.short_name, e.full_name, e.emp_no])[0] || null;
  const custs = hit(dict.custs, (c) => [c.name, c.code]).sort((a, b) => b.name.length - a.name.length);
  const cust = custs.find((c) => !emp || !String(emp.short_name).toLowerCase().includes(c.name.toLowerCase())) || null;
  const cat = hit(dict.cats, (c) => [c.name], false).sort((a, b) => b.name.length - a.name.length)[0] || null;
  let model = null;
  for (const p of dict.models) { const k = norm(p); if (k.length >= 3 && T.includes(k) && (!model || k.length > norm(model).length)) model = p; }
  const metric = /欠款|欠多少|应收|没付|impay|dette/i.test(t) ? 'ar' : /库存|还有多少|有货|剩多少|stock/i.test(t) ? 'stock' : /收款|回款|收了|进账|encaiss/i.test(t) ? 'recv' : /退货|退了|retour/i.test(t) ? 'ret' : /金额|销售额|营业额|多少钱|卖了多少钱|chiffre/i.test(t) ? 'amount' : 'qty';
  let group = /卖给了?谁|给谁|哪些客户|谁欠|谁买/.test(t) ? 'customer' : /每天|按天|每日|天天|par jour/i.test(t) ? 'day' : /型号|机型|modèle/i.test(t) && !model ? 'model' : /种类|类别/i.test(t) && !cat ? 'category'
    : /客户|client/i.test(t) && !cust ? 'customer' : /销售员|员工|谁|每个人|业务员|vendeur/i.test(t) && !emp ? 'employee' : /订单|单子|commande/i.test(t) ? 'deal' : null;
  if (!group) group = emp && !cust ? 'customer' : cust ? 'model' : model ? 'customer' : 'employee';
  if (['recv', 'ar'].includes(metric) && ['model', 'category', 'day', 'deal'].includes(group)) group = metric === 'ar' && group === 'deal' ? 'deal' : 'customer';
  if (metric === 'stock' && !['model', 'category'].includes(group)) group = model ? 'model' : cat ? 'model' : 'category';
  return { from, to, when, emp, cust, cat, model, metric, group };
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

const EX = ['Koffi 昨天对应客户的销量', '本月每个销售员卖了多少钱', '上周屏幕按型号', '近 7 天收款按客户', 'BG6M 本月卖给了谁', '现在谁欠款最多', '电池盖库存'];

export default function AskBox() {
  const { org } = useApp();
  const { data: dict } = useData(async () => {
    const [emps, custs, cats, models] = await Promise.all([q(`select id, short_name, full_name, emp_no from app.employees where org_id = $1`, [org]),
      q(`select id, name, code from app.customers where org_id = $1`, [org]), q(`select id, name from app.categories where org_id = $1`, [org]),
      q(`select distinct model from app.products where org_id = $1 and model is not null`, [org])]);
    return { emps, custs, cats, models: models.map((m) => m.model) };
  }, [org]);
  const [text, setText] = useState(''); const [P, setP] = useState(null); const [rows, setRows] = useState(null); const [busy, setBusy] = useState(false); const [all, setAll] = useState(false);
  const go = async (t = text, over) => {
    if (!dict || !String(t).trim()) return;
    const p = over || parse(t, dict); setP(p); setBusy(true); setAll(false);
    try { setRows(await run(org, p)); } catch (e) { setRows([]); console.warn(e); } finally { setBusy(false); }
  };
  const tweak = (patch) => go(text, { ...P, ...patch });
  const tot = useMemo(() => (rows || []).reduce((a, r) => ({ qty: a.qty + Number(r.qty || 0), amount: a.amount + Number(r.amount || 0), n: a.n + Number(r.n || 0) }), { qty: 0, amount: 0, n: 0 }), [rows]);
  const say = P && rows ? (() => {
    const who = [P.emp?.short_name, P.cust?.name, P.cat?.name, P.model].filter(Boolean).join(' · ') || '全公司';
    const g = GROUP.find((x) => x[0] === P.group)?.[1].replace('按', '') || '';
    if (!rows.length) return `${who} ${NOW.has(P.metric) ? '现在' : P.when}：没有${({ recv: '收款', ret: '退货', ar: '欠款', stock: '库存' })[P.metric] || '出库'}。`;
    if (P.metric === 'recv') return `${who} ${P.when}：收款 ${fmt(tot.amount)} XOF，${tot.n} 笔，${rows.length} 个${g}。`;
    if (P.metric === 'ar') return `${who} 现在：欠款 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清，${rows.length} 个${g}${rows[0] ? `；最多的是 ${rows[0].label}（${fmt(rows[0].amount)} XOF）` : ''}。`;
    if (P.metric === 'stock') return `${who} 现在：本地库存 ${fmt(tot.qty)} 片（可售 ${fmt(tot.amount)}），${rows.length} 个${g}。`;
    return `${who} ${P.when}：${P.metric === 'ret' ? '退货' : '出库'} ${fmt(tot.qty)} 片 · ${fmt(tot.amount)} XOF · ${tot.n} 单，分 ${rows.length} 个${g}${rows[0] ? `；最多的是 ${rows[0].label}（${fmt(P.metric === 'amount' ? rows[0].amount : rows[0].qty)}${P.metric === 'amount' ? ' XOF' : ' 片'}）` : ''}。`;
  })() : '';
  const labelCell = (r) => (P.group === 'deal' && P.metric === 'ar' ? <b>{r.label}</b> : P.group === 'customer' || (P.metric === 'recv' && ['deal', 'model', 'category'].includes(P.group)) ? <CustLink id={r.cid} name={r.label} />
    : P.group === 'model' ? <ModelLink id={r.pid} model={r.label} /> : P.group === 'employee' && r.eid ? <EmpLink id={r.eid} name={r.label} /> : <b>{r.label}</b>);
  const chip = (txt, onX) => <span className="ask-chip">{txt}{onX && <button type="button" aria-label="去掉" onClick={onX}>×</button>}</span>;
  return (
    <div className="card ask-box" style={{ marginBottom: 12 }}>
      <div className="card-b stack" style={{ gap: 8 }}>
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); go(); }}>
          <input className="in grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={`问一句，例「${EX[0]}」`} />
          <button type="submit" className="btn primary" disabled={!dict || !text.trim() || busy}>{busy ? '…' : '问'}</button>
          {P && <button type="button" className="btn ghost" onClick={() => { setP(null); setRows(null); setText(''); }}>清空</button>}
        </form>
        {!P && <div className="row small muted" style={{ gap: 6, flexWrap: 'wrap' }}>试试：{EX.map((x) => <button type="button" key={x} className="linkbtn small" onClick={() => { setText(x); go(x); }}>{x}</button>)}</div>}
        {P && <div className="row ask-chips" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small muted">我听懂的：</span>
          {NOW.has(P.metric) ? chip('现在') : chip(`${P.when}（${P.from.slice(5)}${P.to !== P.from ? ' – ' + P.to.slice(5) : ''}）`)}
          {P.emp && chip(`销售员 ${P.emp.short_name}`, () => tweak({ emp: null }))}
          {P.cust && chip(`客户 ${P.cust.name}`, () => tweak({ cust: null }))}
          {P.cat && chip(`种类 ${P.cat.name}`, () => tweak({ cat: null }))}
          {P.model && chip(`型号 ${P.model}`, () => tweak({ model: null }))}
          <Choice size="sm" value={P.metric} onChange={(v) => tweak({ metric: v })} flat={false} options={METRIC} />
          <Choice size="sm" value={P.group} onChange={(v) => tweak({ group: v })} flat={false} options={GROUP.filter(([k]) => (P.metric === 'stock' ? ['model', 'category'].includes(k) : P.metric === 'ar' ? ['customer', 'employee', 'deal'].includes(k) : P.metric !== 'recv' || !['model', 'category', 'deal'].includes(k)))} />
        </div>}
        {say && <div className="ask-say"><b>{say}</b></div>}
        {P && rows && rows.length > 0 && <Grid id="ask" compactTools maxHeight={360} rows={all ? rows : rows.slice(0, 10)} rowKey={(r) => r.k} columns={[
          { key: 'label', label: GROUP.find((x) => x[0] === P.group)?.[1].replace('按', '') || '', w: 180, value: (r) => r.label, render: labelCell },
          ...(['recv', 'ar'].includes(P.metric) ? [] : [{ key: 'qty', label: P.metric === 'ret' ? '退货片数' : P.metric === 'stock' ? '实存' : '片数', w: 90, type: 'number', sum: true, render: (r) => fmt(r.qty) }]),
          { key: 'amount', label: ({ recv: '收款 XOF', ar: '欠款 XOF', stock: '可售' })[P.metric] || '金额 XOF', w: 130, type: 'number', sum: true, value: (r) => Math.round(Number(r.amount || 0)), render: (r) => fmt(r.amount) },
          { key: 'n', label: ({ recv: '笔数', ar: '没收清的单', stock: '编码数' })[P.metric] || '单数', w: 90, type: 'number', sum: true },
          ...(!['recv', 'ar', 'stock'].includes(P.metric) ? [{ key: 'share', label: '占比', w: 80, value: (r) => { const base = P.metric === 'amount' ? tot.amount : tot.qty; const v = P.metric === 'amount' ? Number(r.amount) : Number(r.qty); return base ? `${Math.round(v / base * 100)}%` : ''; } }] : []),
        ]} />}
        {P && rows && rows.length > 10 && <div><button type="button" className="btn sm ghost" onClick={() => setAll(!all)}>{all ? '只看前 10' : `看全部 ${rows.length} 个（上面那句话是全部的合计）`}</button></div>}
        {P && <div className="small muted">销量 = 出库（作废的不算）；销售员 = 订单上的归属销售员（欠款按客户的归属销售员）；库存 = LA + 9S；金额折成 XOF。没听懂的词就去掉了，可以换个说法，或者用上面两个下拉换看法。</div>}
      </div>
    </div>);
}
