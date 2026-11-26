// 366 (Frank 11-18): 「异常的单」总入口 —— 亏钱 / 价格 / 数量 / 欠款拦截 / 账对不上 / 任务卡流程 统一收在这里, 按类型打小标, 每行能跳到那张单;
// 处理完自动从「待处理」消失, 转进「已处理记录」(当时的数字、谁、什么时候、怎么处理的), 记录不可改不可删.
// 371: 板块常驻 (没有也显示 0), Always = 给「没内容就不渲染」的老板块补一个一行的空态.
import { hasAny } from '../lib/domain.js';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Info, Assumed, DatePicker } from './ui.jsx';
import Grid from './Grid.jsx';
import { DealLink, CustLink, EmpLink } from './Archives.jsx';
import { dt, money, qty, today } from '../lib/format.js';

export const ANOM = {
  loss_block: ['亏钱', 'red'], loss_shipped: ['亏钱', 'red'], price_pending: ['价格', 'red'], price_req: ['价格', 'amber'], odd_price: ['价格', 'amber'],
  qty_over: ['数量', 'red'], discrepancy: ['数量', 'red'], partial: ['数量', 'amber'], credit: ['欠款', 'red'], debt_block: ['欠款', 'red'], rep_debt: ['欠款', 'red'],
  ledger: ['账', 'red'], task_block: ['任务', 'amber'] };
const GROUPS = ['亏钱', '价格', '数量', '欠款', '账', '任务'];
const N = (v) => Number(v || 0);
// 当时的数字 (只中方拿得到 detail)
const numbers = (a) => {
  const d = a.detail; if (!d) return '';
  if (a.kind === 'loss_shipped') return `卖 ${money(d.revenue)} · 成本 ${money(d.cost)} · 亏 ${money(-N(d.profit))}`;
  if (a.kind === 'loss_block') return (d.lines || []).slice(0, 3).map((l) => `卖 ${money(l.price)} / 成本 ${money(l.cost)}`).join('；') + ((d.lines || []).length > 3 ? ` …共 ${d.lines.length} 行` : '');
  if (a.kind === 'credit') return `现在欠 ${money(d.balance)} · 这张单 ${money(d.this)}${d.limit != null ? ` · 上限 ${money(d.limit)}` : ''}${d.oldest != null ? ` · 最老 ${d.oldest} 天` : ''}`;
  if (a.kind === 'qty_over') return (Array.isArray(d) ? d : []).map((l) => `${l.model} 客户确认 ${qty(l.confirmed)} → 现在 ${qty(l.now)}`).join('；');
  if (a.kind === 'ledger') return `总账 ${money(d.balance)} · 各单欠款 ${money(d.due_sum)} · 没冲预付 ${money(d.unallocated)} · 差 ${money(d.diff)}`;
  if (a.kind === 'discrepancy') return `值 ${money(d.amount)}${d.late ? ' · 超 24 小时才反馈' : ''}`;
  if (a.kind === 'debt_block') return `欠 ${money(d.balance)}`;
  if (a.kind === 'rep_debt') return `${d.deals} 张单 · 共欠 ${money(d.due)}`;
  if (a.kind === 'price_pending') return d.note || '';
  return '';
};
const Ref = ({ a }) => (a.deal_id ? <DealLink id={a.deal_id} no={a.ref_label} /> : a.employee_id ? <EmpLink id={a.employee_id} name={a.ref_label} /> : a.customer_id ? <CustLink id={a.customer_id} name={a.ref_label} /> : <b>{a.ref_label}</b>);

export function AnomalyHub() {
  const { org, role, go, refresh } = useApp();
  const [tab, setTab] = useState('open'); const [g, setG] = useState('');
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }); const [to, setTo] = useState(today());
  const staff = hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline', 'finance', 'sales', 'picker']);
  useEffect(() => { if (org && staff) call(role, `select app.sync_anomalies($1)`, [org]).then((r) => { if (N(Object.values(r?.[0] || {})[0]) > 0) refresh(); }, () => {}); }, [org, role]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { data: open } = useData(() => (staff ? call(role, `select * from app.anomaly_list($1, true)`, [org]).catch(() => []) : Promise.resolve([])), [org, role]);
  const { data: hist } = useData(() => (staff && tab === 'hist' ? call(role, `select * from app.anomaly_list($1, false, $2, $3)`, [org, from, to]).catch(() => []) : Promise.resolve(null)), [org, role, tab, from, to]);
  if (!staff) return null;
  const rows = open || [];
  const cnt = (name) => rows.filter((a) => ANOM[a.kind]?.[0] === name).length;
  const shown = g ? rows.filter((a) => ANOM[a.kind]?.[0] === g) : rows;
  return (
    <div className={`card todo-sec ${rows.length ? 'todo-red' : ''}`} style={{ marginBottom: 12 }}>
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>异常的单 {rows.length} 条待处理 <Info>亏钱、价格、数量、欠款拦截、账对不上、任务卡流程，都收在这里。点「去处理」跳到那张单对应的地方；处理完自动从这里消失，转进「已处理记录」（留当时的数字、谁、什么时候、怎么处理的）。{role === 'admin' ? '' : '带成本的几类只有中方看得到。'}</Info>
          <Assumed>「异价单」「只发了一部分」没有单独的处理动作：出完库 / 发完剩下的就自动转成已处理。销售员欠款按人记一条，不按单。</Assumed></h2>
        <div className="al-seg"><button type="button" className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>待处理</button><button type="button" className={tab === 'hist' ? 'on' : ''} onClick={() => setTab('hist')}>已处理记录</button></div>
      </div>
      {tab === 'open' && <>
        <div className="card-b" style={{ paddingBottom: 6 }}><div className="chips">
          <button type="button" className={`chip ${!g ? 'on' : ''}`} onClick={() => setG('')}>全部 {rows.length}</button>
          {GROUPS.map((name) => <button type="button" key={name} className={`chip ${g === name ? 'on' : ''}`} onClick={() => setG(g === name ? '' : name)}>{name} {cnt(name)}</button>)}</div></div>
        {shown.length === 0 ? <div className="card-b small muted">没有待处理的异常 ✓</div> : shown.map((a) => (
          <div key={a.id} className="todo-line" style={{ padding: '8px 18px' }}>
            <span className={`pill ${ANOM[a.kind]?.[1] || 'gray'}`}>{ANOM[a.kind]?.[0] || a.kind}</span>
            <Ref a={a} />{a.deal_id && a.customer_name ? <span className="small muted">{a.customer_name}</span> : null}
            <span>{a.summary}</span>{numbers(a) && <span className="small muted">{numbers(a)}</span>}
            <span className="small muted">发现于 {dt(a.detected_at)}</span>
            <span className="grow" />
            {(a.deal_id || a.kind === 'ledger' || a.kind === 'rep_debt') && <button type="button" className="btn sm primary" onClick={() => go(a.deal_id ? 'deal/' + a.deal_id : a.kind === 'ledger' ? 'balances' : 'receipts')}>去处理 →</button>}
          </div>))}
      </>}
      {tab === 'hist' && <div className="card-b">
        <Grid id="anomaly-hist" rows={hist || []} rowKey={(a) => a.id} empty={hist ? '这段时间没有处理过的异常' : '加载中…'} maxHeight={420}
          tools={<><DatePicker value={from} onChange={setFrom} label="从" /><DatePicker value={to} onChange={setTo} label="到" /><span className="hint">按处理时间；可以筛选、分组、导出。记录不能改、不能删。</span></>}
          columns={[
            { key: 'type', label: '类型', w: 80, value: (a) => ANOM[a.kind]?.[0] || a.kind, render: (a) => <span className={`pill ${ANOM[a.kind]?.[1] || 'gray'}`}>{ANOM[a.kind]?.[0] || a.kind}</span> },
            { key: 'ref', label: '哪张单 / 谁', w: 150, value: (a) => a.ref_label, render: (a) => <Ref a={a} /> },
            { key: 'customer_name', label: '客户', w: 150, render: (a) => (a.customer_id ? <CustLink id={a.customer_id} name={a.customer_name} /> : '') },
            { key: 'summary', label: '什么异常', w: 260 },
            ...(role === 'admin' ? [{ key: 'nums', label: '当时的数字', w: 260, value: numbers }] : []),
            { key: 'detected_at', label: '发现', w: 130, type: 'date', render: (a) => dt(a.detected_at) },
            { key: 'resolved_at', label: '处理', w: 130, type: 'date', render: (a) => dt(a.resolved_at) },
            { key: 'resolved_by_name', label: '谁处理的', w: 100 },
            { key: 'resolution', label: '怎么处理的', w: 300 }]} />
      </div>}
    </div>);
}

// 371: 固定板块不许消失 —— 里面的老板块没内容时不渲染任何东西, 这里补一行空态 (标题 + 没有)
export function Always({ title, children }) {
  const ref = useRef(null); const [empty, setEmpty] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const chk = () => setEmpty(el.childElementCount === 0);
    chk(); const mo = new MutationObserver(chk); mo.observe(el, { childList: true }); return () => mo.disconnect();
  }, []);
  return (<>
    <div ref={ref} style={{ display: 'contents' }}>{children}</div>
    {empty && <div className="card todo-empty"><b>{title}</b><span className="pill gray">0 条</span><span className="small muted">没有</span></div>}
  </>);
}
