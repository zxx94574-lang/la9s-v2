// 338 / 339 (Frank 11-17): 挂在单据上的任务 —— 任何「要人去问 / 去核对」的事, 从这张单直接派出去, 自动带单号和客户;
// 类型: 问付款计划 (结果 = 哪天付多少 + 截图) / 对账事项 / 核对一件事 / 其他. 复用中方指令 (收到 → 完成填结果 → 中方确认).
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, Choice, DatePicker, Pill, Thumb, Info } from './ui.jsx';
import Grid from './Grid.jsx';
import { DealLink, CustLink, EmpLink } from './Archives.jsx';
import { money, friendlyError, dDate } from '../lib/format.js';

export const TASK_TYPES = [['payment_plan', '问付款计划'], ['recon', '对账事项'], ['check', '核对一件事'], ['other', '其他']];
const ST = { sent: ['还没点收到', 'red'], acked: ['在做', 'amber'], done: ['做完了，等中方确认', 'amber'], closed: ['已关闭', 'green'] };
const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const TITLES = { payment_plan: (c) => `问 ${c} 什么时候付清、分几次付`, recon: (c) => `和 ${c} 核对：`, check: () => '核对：', other: () => '' };

// target = { kind: 'deal' | 'customer' | 'shipment' | 'product' | 'po', id, label, customerName, ownerId }
export function TaskModal({ deal, target, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const tg = target || { kind: 'deal', id: deal.id, label: deal.biz_no, customerName: deal.customer_name, ownerId: deal.owner_employee_id };
  const who = tg.customerName || tg.label || '';
  const { data: emps } = useData(() => q(`select id, short_name, emp_no from app.employees where org_id = $1 and active order by short_name`, [org]), [org]);
  const [f, setF] = useState({ type: 'payment_plan', title: TITLES.payment_plan(who), body: '', assignee: tg.ownerId || '', due: plus(1), time: '12:00', urgent: false, blocks: false });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!f.title.trim()) return toast('写清楚要做什么', 'err'); if (!f.assignee) return toast('选交给谁', 'err');
    if (!/^\d{1,2}:\d{2}$/.test(f.time)) return toast('时间写成 12:00 这样', 'err');
    setBusy(true);
    try {
      await call(role, `select app.issue_task($1,$2)`, [org, JSON.stringify({ title: f.title.trim(), body: f.body.trim(), assignee: f.assignee, due_at: `${f.due}T${f.time.padStart(5, '0')}:00+00:00`, urgent: f.urgent, blocks: f.blocks, task_type: f.type, ref_kind: tg.kind, ref_id: tg.id, ref_label: tg.label })]);
      toast('任务已派出，对方打开系统会弹出来'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`派任务 · ${[tg.label, tg.customerName].filter(Boolean).join(' · ')}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy} onClick={go}>派出去</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <FRow label="什么事" req><Choice value={f.type} onChange={(v) => setF((x) => ({ ...x, type: v, title: TITLES[v](who) }))} options={TASK_TYPES} /></FRow>
        <FRow label="要做什么" req><input className="in" style={{ flex: '1 1 260px', minWidth: 0 }} value={f.title} onChange={(e) => set('title', e.target.value)} /></FRow>
        <FRow label="补充"><textarea className="in" rows={2} style={{ width: '100%' }} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder="经过、要注意什么（可不填）" /></FRow>
        <FRow label="交给谁" req><Choice value={f.assignee} onChange={(v) => set('assignee', v)} options={(emps || []).map((e) => [e.id, e.short_name, e.emp_no || ''])} placeholder="选员工…" flat={false} style={{ width: 200 }} /></FRow>
        <FRow label="期限"><DatePicker value={f.due} onChange={(v) => set('due', v)} /><input className="in" style={{ width: 84 }} value={f.time} onChange={(e) => set('time', e.target.value.replace(/[^\d:]/g, '').slice(0, 5))} placeholder="12:00" title="几点前（阿比让时间）" /><span className="small muted">前（默认明天 12:00）</span></FRow>
        <FRow label="紧急程度"><Choice value={f.urgent ? 'y' : 'n'} onChange={(v) => set('urgent', v === 'y')} options={[['n', '普通'], ['y', '紧急']]} /></FRow>
        {tg.kind === 'deal' && <FRow label="卡不卡流程"><Choice value={f.blocks ? 'y' : 'n'} onChange={(v) => set('blocks', v === 'y')} options={[['n', '不卡，照常走'], ['y', '做完才能往下走']]} flat />
          <Info>选「做完才能往下走」：这条任务做完、中方确认之前，这张单不能往下推，也不能出库。撤回和作废不受影响。</Info></FRow>}
        {f.type === 'payment_plan' && <div className="banner info">对方交结果时必须填「哪天付多少」并传客户答应的截图；到了日子钱没收够，会出现在中方待办里。</div>}
      </div>
    </Modal>);
}

// 订单页: 挂在这张单上的任务
const fmtDue = (t) => (t.due_at ? `${dDate(t.due_at)} ${String(new Date(t.due_at).getUTCHours()).padStart(2, '0')}:${String(new Date(t.due_at).getUTCMinutes()).padStart(2, '0')} 前` : t.due_on ? `${dDate(t.due_on)} 前` : '');
const isLate = (t) => ['sent', 'acked'].includes(t.status) && t.due_at && new Date(t.due_at) < new Date();
function TaskRows({ data, showRef }) {
  return data.map((t) => (
    <div key={t.id} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
      <Pill tone={isLate(t) ? 'red' : ST[t.status][1]}>{isLate(t) ? '过期没做' : ST[t.status][0]}</Pill>
      <span className="small"><b>{t.title}</b> · {t.assignee}{fmtDue(t) ? ` · ${fmtDue(t)}` : ''}{t.blocks && t.status !== 'closed' ? <> · <Pill tone="red">卡着流程</Pill></> : null}
        {showRef && t.ref_label ? <> · {t.ref_kind === 'deal' ? <DealLink id={t.ref_id} no={t.ref_label} /> : t.ref_label}</> : null}
        {Array.isArray(t.result) && t.result.length > 0 && <> · 付款计划：{t.result.map((r) => `${r.on} 付 ${money(r.amount)}`).join('；')}</>}
        {t.done_note && !(Array.isArray(t.result) && t.result.length) ? ` · 结果：${t.done_note}` : ''}</span>
      {t.done_photo ? <Thumb src={t.done_photo} size={32} /> : <span />}
    </div>));
}
const TASK_SEL = `select d.id, d.title, d.status, d.task_type, d.due_on, d.due_at, d.blocks, d.done_note, d.done_photo, d.result, d.created_at, d.ref_kind, d.ref_id, d.ref_label, e.short_name as assignee
  from app.directives d join app.employees e on e.id = d.assignee_employee_id`;

// 订单页: 挂在这张单上的任务
export function DealTasks({ deal }) {
  const { tick } = useApp();
  const { data } = useData(() => q(`${TASK_SEL} where d.ref_kind = 'deal' and d.ref_id = $1 and not d.is_template order by d.created_at desc`, [deal.id]), [deal.id, tick]);
  if (!data?.length) return null;
  const openN = data.filter((t) => t.status !== 'closed').length;
  const blocking = data.filter((t) => t.blocks && t.status !== 'closed');
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: blocking.length ? '#e9b4ae' : undefined }}>
      <div className="card-h"><h2>挂在这张单上的任务</h2><Pill tone={blocking.length ? 'red' : openN ? 'amber' : 'green'}>{blocking.length ? `${blocking.length} 件卡着流程` : openN ? `${openN} 件没关` : '都关了'}</Pill>
        {blocking.length > 0 && <span className="small muted">做完、中方确认后才能往下推 / 出库</span>}</div>
      <TaskRows data={data} />
    </div>);
}

// 客户档案: 这个客户身上的任务 (直接挂客户的 + 挂在他订单上的) + 付款计划
export function CustomerTasks({ customerId }) {
  const { tick } = useApp();
  const { data } = useData(() => q(`${TASK_SEL} where d.ref_customer_id = $1 and not d.is_template order by (d.status = 'closed'), d.created_at desc limit 30`, [customerId]), [customerId, tick]);
  if (!data?.length) return null;
  const plans = data.filter((t) => Array.isArray(t.result) && t.result.length);
  return (
    <div className="card">
      <div className="card-h"><h2>任务与付款计划</h2><Pill tone={data.some((t) => t.status !== 'closed') ? 'amber' : 'green'}>{data.filter((t) => t.status !== 'closed').length} 件没关</Pill></div>
      {plans.length > 0 && <div className="card-b small"><b>客户答应的付款计划：</b>{plans[0].result.map((r) => `${r.on} 付 ${money(r.amount)}`).join('；')}{plans[0].ref_label ? `（${plans[0].ref_label}）` : ''}</div>}
      <TaskRows data={data} showRef />
    </div>);
}

// 待办页 (中方): 任务总表 —— 所有挂在单据 / 客户上的任务, 可按负责人 / 客户 / 状态分组筛选
export function TaskBoard() {
  const { org, role, tick } = useApp();
  const [open, setOpen] = useState(false);
  const { data } = useData(() => (role === 'admin' ? call(role, `select * from app.task_board($1)`, [org]) : Promise.resolve(null)), [org, role, tick]);
  if (!data?.length) return null;
  const live = data.filter((t) => t.status !== 'closed'); const late = live.filter((t) => t.overdue);
  const TY = Object.fromEntries(TASK_TYPES);
  const cols = [
    { key: 'st', label: '状态', w: 130, value: (t) => (t.overdue ? '过期没做' : ST[t.status][0]), render: (t) => <Pill tone={t.overdue ? 'red' : ST[t.status][1]}>{t.overdue ? '过期没做' : ST[t.status][0]}</Pill> },
    { key: 'title', label: '要做什么', w: 260 },
    { key: 'type', label: '类型', w: 100, value: (t) => TY[t.task_type] || '其他' },
    { key: 'assignee', label: '负责人', w: 100, value: (t) => t.assignee, render: (t) => <EmpLink id={t.assignee_id} name={t.assignee} /> },
    { key: 'customer', label: '客户', w: 150, value: (t) => t.customer || '', render: (t) => (t.customer_id ? <CustLink id={t.customer_id} name={t.customer} /> : '') },
    { key: 'ref', label: '挂在', w: 130, value: (t) => t.ref_label || '', render: (t) => (t.ref_kind === 'deal' ? <DealLink id={t.ref_id} no={t.ref_label} /> : t.ref_label || '') },
    { key: 'due', label: '期限', w: 130, value: (t) => fmtDue(t).replace(' 前', '') },
    { key: 'blocks', label: '卡流程', w: 80, value: (t) => (t.blocks ? '卡' : '') },
    { key: 'done_note', label: '结果', w: 240 },
  ];
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <button type="button" className="card-h fold-h" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2>任务总表</h2><Pill tone={late.length ? 'red' : live.length ? 'amber' : 'green'}>{live.length} 件没关{late.length ? ` · ${late.length} 件过期` : ''}</Pill>
        <span className="muted small">挂在订单 / 客户上的任务；展开后可按负责人、客户、状态分组</span><span className="grow" /><span className="caret">{open ? '▾ 收起' : '▸ 展开'}</span>
      </button>
      {open && <Grid id="task-board" columns={cols} rows={data} rowKey={(t) => t.id} />}
    </div>);
}

// 待办: 付款计划到期了、钱还没收到
export function PlanTodo() {
  const { org, role, tick, openArchive } = useApp();
  const { data } = useData(() => (role === 'admin' ? call(role, `select * from app.overdue_payment_plans($1)`, [org]) : Promise.resolve(null)), [org, role, tick]);
  if (!data?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
      <div className="card-h"><h2>答应付款的日子过了，钱没收够</h2><Pill tone="red">{data.length} 笔</Pill>
        <Info>按金额核对：到这个计划日为止累计答应付多少，对比从客户答应那天起实际收到多少；没收够、客户又还有欠款，就列在这里。收够了自动消失。</Info></div>
      {data.map((r, i) => (
        <div key={r.directive_id + i} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }} onClick={() => openArchive?.({ kind: 'customer', id: r.customer_id })}>
          <span className="age red">过期</span>
          <span className="small"><b>{r.customer_name}</b> 答应 {dDate(r.plan_on)} 付 {money(r.amount)}{r.ref_label ? ` · ${r.ref_label}` : ''} · 到这天该付 {money(r.due_total)}，实收 {money(r.paid)} · 现在还欠 {money(r.balance)}</span>
          <b style={{ color: 'var(--red)' }}>差 {money(r.short)}</b>
        </div>))}
    </div>);
}
