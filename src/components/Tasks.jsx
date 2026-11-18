// 338 / 339 (Frank 11-17): 挂在单据上的任务 —— 任何「要人去问 / 去核对」的事, 从这张单直接派出去, 自动带单号和客户;
// 类型: 问付款计划 (结果 = 哪天付多少 + 截图) / 对账事项 / 核对一件事 / 其他. 复用中方指令 (收到 → 完成填结果 → 中方确认).
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, Choice, DatePicker, Pill, Thumb, Assumed } from './ui.jsx';
import { money, friendlyError, dDate } from '../lib/format.js';

export const TASK_TYPES = [['payment_plan', '问付款计划'], ['recon', '对账事项'], ['check', '核对一件事'], ['other', '其他']];
const ST = { sent: ['还没点收到', 'red'], acked: ['在做', 'amber'], done: ['做完了，等中方确认', 'amber'], closed: ['已关闭', 'green'] };
const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const TITLES = { payment_plan: (c) => `问 ${c} 什么时候付清、分几次付`, recon: (c) => `和 ${c} 核对：`, check: () => '核对：', other: () => '' };

export function TaskModal({ deal, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data: emps } = useData(() => q(`select id, short_name, emp_no from app.employees where org_id = $1 and active order by short_name`, [org]), [org]);
  const [f, setF] = useState({ type: 'payment_plan', title: TITLES.payment_plan(deal.customer_name), body: '', assignee: deal.owner_employee_id || '', due: plus(1), urgent: false });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!f.title.trim()) return toast('写清楚要做什么', 'err'); if (!f.assignee) return toast('选交给谁', 'err');
    setBusy(true);
    try {
      await call(role, `select app.issue_task($1,$2)`, [org, JSON.stringify({ title: f.title.trim(), body: f.body.trim(), assignee: f.assignee, due_on: f.due, urgent: f.urgent, task_type: f.type, ref_kind: 'deal', ref_id: deal.id, ref_label: deal.biz_no })]);
      toast('任务已派出，对方打开系统会弹出来'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`派任务 · ${deal.biz_no} · ${deal.customer_name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy} onClick={go}>派出去</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <FRow label="什么事" req><Choice value={f.type} onChange={(v) => setF((x) => ({ ...x, type: v, title: TITLES[v](deal.customer_name) }))} options={TASK_TYPES} /></FRow>
        <FRow label="要做什么" req><input className="in" style={{ flex: '1 1 260px', minWidth: 0 }} value={f.title} onChange={(e) => set('title', e.target.value)} /></FRow>
        <FRow label="补充"><textarea className="in" rows={2} style={{ width: '100%' }} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder="经过、要注意什么（可不填）" /></FRow>
        <FRow label="交给谁" req><Choice value={f.assignee} onChange={(v) => set('assignee', v)} options={(emps || []).map((e) => [e.id, e.short_name, e.emp_no || ''])} placeholder="选员工…" flat={false} style={{ width: 200 }} /></FRow>
        <FRow label="期限"><DatePicker value={f.due} onChange={(v) => set('due', v)} /><Assumed>默认期限是明天。你说的「第二天 12:00」系统现在只记到日期，没有记到几点。</Assumed></FRow>
        <FRow label="紧急程度"><Choice value={f.urgent ? 'y' : 'n'} onChange={(v) => set('urgent', v === 'y')} options={[['n', '普通'], ['y', '紧急']]} /></FRow>
        {f.type === 'payment_plan' && <div className="banner info">对方交结果时必须填「哪天付多少」并传客户答应的截图；到了日子没收到钱，会出现在中方待办里。</div>}
      </div>
    </Modal>);
}

// 订单页: 挂在这张单上的任务
export function DealTasks({ deal }) {
  const { tick } = useApp();
  const { data } = useData(() => q(`select d.id, d.title, d.status, d.task_type, d.due_on, d.done_note, d.done_photo, d.result, d.created_at, e.short_name as assignee
    from app.directives d join app.employees e on e.id = d.assignee_employee_id where d.ref_kind = 'deal' and d.ref_id = $1 and not d.is_template order by d.created_at desc`, [deal.id]), [deal.id, tick]);
  if (!data?.length) return null;
  const openN = data.filter((t) => t.status !== 'closed').length;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>挂在这张单上的任务</h2><Pill tone={openN ? 'amber' : 'green'}>{openN ? `${openN} 件没关` : '都关了'}</Pill></div>
      {data.map((t) => (
        <div key={t.id} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
          <Pill tone={ST[t.status][1]}>{ST[t.status][0]}</Pill>
          <span className="small"><b>{t.title}</b> · {t.assignee}{t.due_on ? ` · ${dDate(t.due_on)} 前` : ''}
            {Array.isArray(t.result) && t.result.length > 0 && <> · 付款计划：{t.result.map((r) => `${r.on} 付 ${money(r.amount)}`).join('；')}</>}
            {t.done_note && !(Array.isArray(t.result) && t.result.length) ? ` · 结果：${t.done_note}` : ''}</span>
          {t.done_photo ? <Thumb src={t.done_photo} size={32} /> : <span />}
        </div>))}
    </div>);
}

// 待办: 付款计划到期了、钱还没收到
export function PlanTodo() {
  const { org, role, tick, openArchive } = useApp();
  const { data } = useData(() => (role === 'admin' ? call(role, `select * from app.overdue_payment_plans($1)`, [org]) : Promise.resolve(null)), [org, role, tick]);
  if (!data?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
      <div className="card-h"><h2>答应付款的日子过了，钱没到</h2><Pill tone="red">{data.length} 笔</Pill>
        <Assumed>怎么算「没到」：计划日的前一天起，这个客户没有任何一笔收款，而且现在还有欠款。只要收到过一笔就不再列（不核对金额够不够）。</Assumed></div>
      {data.map((r, i) => (
        <div key={r.directive_id + i} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }} onClick={() => openArchive?.({ kind: 'customer', id: r.customer_id })}>
          <span className="age red">过期</span>
          <span className="small"><b>{r.customer_name}</b> 答应 {dDate(r.plan_on)} 付 {money(r.amount)}{r.ref_label ? ` · ${r.ref_label}` : ''} · 现在还欠 {money(r.balance)}</span>
          <span className="muted">›</span>
        </div>))}
    </div>);
}
