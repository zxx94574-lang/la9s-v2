// 227 ② (Frank 11-05 定稿): 中方指令 —— 中方给员工下达任务; 员工必须自己点「收到」、做完自己点「完成」并填结果 (文字 / 照片); 中方确认才关闭
// 没点「收到」的: 打开系统强制弹窗; 超过 4 小时 (可设) 没点收到 → 在中方待办里标红, 由中方打电话
import { RuleGear } from './Rules.jsx';
import { regBase } from '../lib/optRegistry.js';
import React, { useEffect, useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, Modal, FRow, Info, PhotoInput, Thumb, DatePicker, FileDrop, Choice, MoneyIn, MultiChoice, Assumed, ConfirmBtn, TierPill } from './ui.jsx';
import { EmpLink, DealLink } from './Archives.jsx';
import { dt, dDate, friendlyError } from '../lib/format.js';
import { OptChoice, OptNote, useOptList } from './Opts.jsx';
import { useRuleValues, ruleVal } from './Rules.jsx';
import OrderFlow, { FlowBadge } from './OrderFlow.jsx';
import CustomerSelect from './CustomerSelect.jsx';
import * as Q from '../db/queries.js';
import { JUMPS, JUMP_LABEL, NEEDS_CUST, jumpOf, startWork, getWork, setWork } from '../lib/dirWork.js';
import { staffOptions, optLabel } from '../lib/staffOptions.js';

const ST = { sent: ['还没点收到', 'red'], acked: ['已收到，在做', 'amber'], done: ['做完了，等中方确认', 'amber'], closed: ['已关闭', 'green'] };
const REPEAT = { daily: '每天', weekly: '每周', monthly: '每月' };
const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const tplWho = (d) => (d.tpl ? [d.tpl.dept && `部门 ${d.tpl.dept}（${d.tpl.report_mode === 'all' ? '全体汇报' : '指定人汇报'}）`, (d.tpl.assignees || []).length ? `${d.tpl.assignees.length} 个人` : ''].filter(Boolean).join(' + ') : d.assignee_name);
const tplWhen = (d) => (d.tpl ? `${d.tpl.freq === 'weekly' && (d.tpl.weekdays || []).length ? ' · ' + d.tpl.weekdays.map((x) => WD[x]).join(' ') : ''}${d.tpl.freq === 'monthly' && (d.tpl.month_days || []).length ? ' · 每月 ' + d.tpl.month_days.join('、') + ' 号' : ''}${d.tpl.at ? ' · 大概 ' + d.tpl.at : ''}` : '');
const hoursSince = (v) => (Date.now() - new Date(v).getTime()) / 36e5;
// 478: 指令类型 (⚙ 可加); 制单 = WhatsApp 下的单交给员工建, 交的时候必须选那张订单
export const DIR_TYPES = ['制单', '催款', '发货', '拜访', '回电话', '对账', '退货', '其他'];
const PROOF_KIND = { deal: '订单', receipt: '收款单', shipment: '出库单', visit: '拜访记录', call: '热线记录', return: '退货单' };
// 479: 期限 = 「还剩 / 超时多久」色块 + 下面一行小灰字时间 (红 = 超时, 黄 = 不到 2 小时, 灰 = 时间还够)
const dueAt = (d) => { if (d.due_at) return new Date(d.due_at); if (!d.due_on) return null; const x = new Date(d.due_on); if (Number.isNaN(x.getTime())) return null; x.setHours(23, 59, 0, 0); return x; };
const span = (ms) => { const m = Math.round(Math.abs(ms) / 6e4); return m < 60 ? `${m} 分钟` : m < 48 * 60 ? `${Math.round(m / 60)} 小时` : `${Math.round(m / 1440)} 天`; };
export function DueChip({ d }) {
  const t = dueAt(d);
  if (!t) return <span className="muted small">没设期限</span>;
  if (['done', 'closed'].includes(d.status)) return <span className="due-chip" data-tip={`截止 ${dt(t)}`}><span className="pill gray">已交</span></span>;
  const ms = t.getTime() - Date.now();
  const tone = ms < 0 ? 'red' : ms < 2 * 36e5 ? 'amber' : 'green';
  return <span className="due-chip" data-tip={`截止 ${dt(t)}`}><span className={`pill ${tone}`}>{ms < 0 ? `超时 ${span(ms)}` : `还剩 ${span(ms)}`}</span></span>;
}
// 503: 时间小方块 —— 同一种颜色, 前面小字标是什么; 「下达」写完整时间, 收到 / 完成写下达后多久
const TC = ({ k, tip, dim, children }) => <span className={`t2-tc ${dim ? 'dim' : ''}`} data-tip={tip || undefined}><i>{k}</i>{children}</span>;
const after = (a, b) => `+${span(new Date(b) - new Date(a))}`;
const SEL = `select d.*, e.short_name as assignee_name, ce.short_name as issuer_name from app.directives d left join app.employees e on e.id = d.assignee_employee_id
  left join app.members cm on cm.org_id = d.org_id and cm.user_id = d.created_by left join app.employees ce on ce.id = cm.employee_id`;

// 508: 一批客户的指令 —— 每位客户一项
const loadItems = async (rows) => {
  const ids = rows.filter((d) => d.batch).map((d) => d.id); if (!ids.length) return {};
  const rs = await q(`select i.*, c.name as customer_name, c.code as customer_code, c.tier, c.city from app.directive_items i join app.customers c on c.id = i.customer_id where i.directive_id = any($1::uuid[]) order by (i.status = 'todo') desc, c.name`, [ids]);
  const by = {}; for (const r of rs) (by[r.directive_id] = by[r.directive_id] || []).push(r); return by;
};
export function useJumpMap() {
  const { org } = useApp();
  return useData(async () => (await q(`select value from app.org_settings where org_id = $1 and key = 'directive_jump'`, [org]))[0]?.value || {}, [org]).data || {};
}
const isLate = (on) => !!on && dDate(on) < dDate(new Date());

function useMine() {
  const { org, role } = useApp();
  return useData(async () => {
    const [m] = await q(`select employee_id from app.members where org_id = $1 and user_id = $2`, [org, USERS[role]]);
    if (!m?.employee_id) return { emp: null, rows: [] };
    const rows = await q(`${SEL} where d.org_id = $1 and d.assignee_employee_id = $2 and not d.is_template and d.status <> 'closed' order by d.urgent desc, d.created_at`, [org, m.employee_id]);
    return { emp: m.employee_id, rows, items: await loadItems(rows) };
  }, [org, role]).data;
}

// 打开系统就弹: 还没点「收到」的指令 (不点收到关不掉, 点了才继续)
// 248 / 250 (Frank 11-12): 附件 (可多个) —— 存成 data URL 跟着指令走; 图片直接看, 其他文件点了下载
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, size: f.size, data: r.result }); r.onerror = rej; r.readAsDataURL(f); });
export function Attach({ value, onChange, label = '把附件拖到这里，可以放多个（表格 / 图片 / PDF）' }) {
  const { toast } = useApp();
  const add = async (fs) => { const big = fs.filter((f) => f.size > 4e6); if (big.length) toast(`${big.map((f) => f.name).join('、')} 超过 4MB，没加`, 'err'); const out = await Promise.all(fs.filter((f) => f.size <= 4e6).map(readFile)); onChange([...(value || []), ...out]); };
  return (<div className="stack" style={{ gap: 6, flex: 1 }}><FileDrop multiple compact label={label} onFiles={add} />
    {(value || []).length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{value.map((a, i) => <span key={i} className="pill blue">{a.name} <button type="button" className="x-mini" title="去掉" onClick={() => onChange(value.filter((_, k) => k !== i))}>×</button></span>)}</div>}</div>);
}
export function AttList({ items }) {
  if (!items?.length) return null;
  return <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="small muted">附件：</span>{items.map((a, i) => (String(a.type || '').startsWith('image/') ? <Thumb key={i} src={a.data} size={40} label={a.name} /> : <a key={i} className="pill blue" href={a.data} download={a.name} title="点了下载">📎 {a.name}</a>))}</div>;
}
const ACK_MIN = 5;
const lateMin = (d) => Math.floor((Date.now() - new Date(d.created_at).getTime()) / 60e3);
const beep = () => { try { if (localStorage.getItem('la9s.sound') === 'off') return; const C = window.AudioContext || window.webkitAudioContext; const c = new C(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.08; o.start(); o.stop(c.currentTime + 0.35); } catch { /* 浏览器不让响就算了 */ } };
export function DirectiveGate() {
  const { role, toast, refresh } = useApp();
  const mine = useMine();
  const un = (mine?.rows || []).filter((d) => d.status === 'sent' && !d.parent_id);   // 368: 定期任务比指令轻, 不弹窗挡操作, 只在待办里常驻
  const [why, setWhy] = useState({});
  useEffect(() => { if (un.length) beep(); }, [un.length]);
  // 227 (第 6 组): 收到了但没做完的 —— 紧急的每小时提醒一次, 普通的每天 9:30 (规则参数可调) 提醒一次; 点「知道了」关, 到点再弹
  const [remind, setRemind] = useState(null);
  const rv = useRuleValues(['dir.remind_at']); const at = String(ruleVal(rv, 'dir.remind_at') || '09:30');
  useEffect(() => {
    const check = () => {
      const open = (mine?.rows || []).filter((d) => d.status === 'acked' && d.reporter !== false);
      if (!open.length) return;
      const now = new Date(); const hhmm = now.toTimeString().slice(0, 5); const day = now.toISOString().slice(0, 10);
      let last = {}; try { last = JSON.parse(localStorage.getItem('la9s.dirRemind') || '{}'); } catch { /* ignore */ }
      const urg = open.filter((d) => d.urgent);
      if (urg.length && Date.now() - (last.urgent || 0) > 3600e3) { setRemind({ kind: 'urgent', rows: urg }); last.urgent = Date.now(); }
      else if (hhmm >= at && last.daily !== day) { setRemind({ kind: 'daily', rows: open }); last.daily = day; }
      try { localStorage.setItem('la9s.dirRemind', JSON.stringify(last)); } catch { /* ignore */ }
    };
    check(); const t = setInterval(check, 60e3); return () => clearInterval(t);
  }, [mine, at]);
  if (!un.length) return remind ? (
    <Modal center title={remind.kind === 'urgent' ? `紧急指令还没做完（${remind.rows.length} 条）· 每小时提醒` : `今天要做完的指令（${remind.rows.length} 条）`} onClose={() => setRemind(null)}
      footer={<><span className="small muted">做完到「我的待办」点「去做」或「做完了」</span><span className="grow" /><button type="button" className="btn primary" onClick={() => setRemind(null)}>知道了</button></>}>
      <div className="stack" style={{ gap: 6 }}>{remind.rows.map((d) => <div key={d.id} className="row" style={{ gap: 8 }}>{d.no && <span className="t2-no">{d.no}</span>}{d.urgent && <span className="pill red">紧急</span>}<b>{d.title}</b><span className="grow" /><DueChip d={d} /></div>)}</div>
    </Modal>) : null;
  const ack = async (d) => { try { await call(role, `select app.ack_directive2($1,$2)`, [d.id, why[d.id] || null]); toast('已收到，做完到「我的待办」点完成'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal center title={`中方给你的指令（${un.length} 条没点收到）`} onClose={() => {}} footer={<span className="small muted">每一条都要点「收到」；规定 {ACK_MIN} 分钟内收到，超了要写原因。做完后到「我的待办」点完成、填结果。</span>}>
      <div className="stack">{un.map((d) => { const late = lateMin(d) >= ACK_MIN; return (
        <div key={d.id} className="pd-sec">
          <div className="pd-h">{d.urgent && <span className="pill red">紧急</span>} {d.title}</div>
          {d.body && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>}
          <AttList items={d.attachments} />
          <div className="small muted">{d.issuer_name || '中方'} · {dt(d.created_at)}{d.due_on ? ` · 要在 ${dDate(d.due_on)} 前做完` : ''}{d.require_photo ? ' · 要拍照' : ''}</div>
          {late && <div className="stack" style={{ gap: 6 }}><span className="pill red">已经过了 {lateMin(d)} 分钟（规定 {ACK_MIN} 分钟内）· 写原因</span>
            <div className="chips">{['在接客户电话', '在处理订单', '不在座位', '系统没开着'].map((r) => <button type="button" key={r} className={`chip ${why[d.id] === r ? 'on' : ''}`} onClick={() => setWhy({ ...why, [d.id]: r })}>{r}</button>)}
              <input className="in" style={{ width: 200 }} value={why[d.id] || ''} onChange={(e) => setWhy({ ...why, [d.id]: e.target.value })} placeholder="或者自己写" /></div></div>}
          <div className="actbar">{late && !String(why[d.id] || '').trim() && <span className="why">先写为什么这么晚才看到</span>}<button type="button" className="btn primary" disabled={late && !String(why[d.id] || '').trim()} onClick={() => ack(d)}>收到</button></div>
        </div>); })}</div>
    </Modal>
  );
}

// 503 / 508: 「当初怎么下的 + 经过」—— 中方和员工两边点开都是这一块
function DirDetail({ d, g, late, items }) {
  const who = d.target_dept ? `部门 ${d.target_dept}` : '单人';
  return (
    <div className="t2-exp"><div className="t2-cols">
          <div className="t2-box"><h4>当初怎么下的</h4><div className="t2-kv">
            <span>编号</span><span>{d.no || '—'}</span><span>分类</span><span>{d.dir_type || '其他'}</span><span>下达人</span><span>{d.issuer_name || '中方'}</span>
            <span>截止</span><span>{dueAt(d) ? <>{dt(dueAt(d))}<span className="muted">（下达后 {span(dueAt(d) - new Date(d.created_at))} 内做完）</span></> : '没设期限'}{d.urgent && <span className="pill red" style={{ marginLeft: 6 }}>紧急 · 每小时提醒</span>}</span>
            <span>给谁</span><span>{who} · <EmpLink id={d.assignee_employee_id} name={d.assignee_name} /></span>
            <span>谁汇报</span><span>{d.reporter === false ? '只需点收到，不用交结果' : g ? `这次 ${g.length} 人都要交` : '本人交结果'}</span>
            <span>要交</span><span>{[d.require_photo && '照片', d.dir_type === '制单' && '订单'].filter(Boolean).join(' + ') || '文字结果'}</span>
            {d.ref_label && <><span>{d.ref_kind === 'customer' || d.batch ? '客户' : '挂在'}</span><span>{d.ref_kind === 'deal' ? <DealLink id={d.ref_id} no={d.ref_label} /> : d.ref_label}</span></>}
            <span>内容</span><span style={{ whiteSpace: 'pre-wrap' }}>{d.body || '—'}</span></div><AttList items={d.attachments} /></div>
          <div className="t2-box"><h4>经过</h4><div className="t2-steps">
            <div className="t2-st done"><i /><div><b>下达</b><small>{dt(d.created_at)}</small></div></div>
            <div className={`t2-st ${d.ack_at ? 'done' : 'now'}`}><i /><div><b>收到</b><small>{d.ack_at ? `${dt(d.ack_at)}（下达后 ${span(new Date(d.ack_at) - new Date(d.created_at))}）` : '还没点收到'}</small>{d.ack_reason && <small>晚收到的原因：{d.ack_reason}</small>}</div>{late && <span className="pill red">超 4 小时没收到，打电话</span>}</div>
            <div className={`t2-st ${d.done_at ? 'done' : d.ack_at ? 'now' : ''}`}><i /><div><b>完成</b><small>{d.done_at ? `${dt(d.done_at)}（下达后 ${span(new Date(d.done_at) - new Date(d.created_at))}）` : '—'}</small>{d.done_note && <small>结果：{d.done_note}</small>}{d.done_photo && <Thumb src={d.done_photo} size={56} label="完成照片" />}</div></div>
            {d.promise_on && <div className={`t2-st ${isLate(d.promise_on) ? 'now' : 'done'}`}><i /><div><b>客户说 {dDate(d.promise_on)} 付</b>{d.promise_note && <small>{d.promise_note}</small>}</div>{isLate(d.promise_on) && <span className="pill red">过了没付 · 已转紧急</span>}</div>}
            <div className={`t2-st ${d.status === 'done' ? 'now' : ''}`}><i /><div><b>中方确认</b><small>{d.status === 'done' ? '等你确认' : '—'}</small>{d.confirm_note && <small>上次退回：{d.confirm_note}</small>}</div></div>
          </div></div>
    </div>
    {items?.length > 0 && <ItemTable items={items} />}
    </div>);
}
const IST = { todo: ['还没交', 'gray'], done: ['已交', 'green'], promised: ['客户说会付', 'amber'] };
function ItemTable({ items }) {
  return (<div className="t2-box" style={{ marginTop: 10 }}><h4>每位客户 · 已交 {items.filter((i) => i.status !== 'todo').length} / {items.length}</h4>
    <div className="t2-items">{items.map((i) => <div key={i.id} className="t2-it"><b>{i.customer_name}</b><span className="muted small">{i.city || ''}</span>
      <span className={`pill ${i.status === 'promised' && isLate(i.promise_on) ? 'red' : IST[i.status][1]}`}>{i.status === 'promised' ? `客户说 ${dDate(i.promise_on)} 付` : IST[i.status][0]}</span>
      <span className="small">{i.proof_id ? <>{PROOF_KIND[i.proof_kind] || '记录'} {i.proof_kind === 'deal' ? <DealLink id={i.proof_id} no={i.proof_label} /> : i.proof_label}</> : i.note || ''}</span>
      {i.done_at && <span className="muted small">{dt(i.done_at)}</span>}</div>)}</div></div>);
}

export default function DirectiveBoard() {
  const { org, role, toast, refresh, go } = useApp();
  const admin = role === 'admin';
  const mine = useMine();
  const [nw, setNw] = useState(false); const [done, setDone] = useState(null); const [rej, setRej] = useState(null); const [tab, setTab] = useState('dir');
  const [openId, setOpenId] = useState(null); const [stop, setStop] = useState(null); const [shut, setShut] = useState({});
  const lateN = (list) => list.filter((d) => { const t = dueAt(d); return t && t < new Date() && !['done', 'closed'].includes(d.status); }).length;
  useEffect(() => { if (org) Promise.all([call(role, `select app.spawn_directives($1)`, [org]), call(role, `select app.directive_sweep($1)`, [org])]).then((rs) => { if (rs.some((r) => Number(Object.values(r?.[0] || {})[0]) > 0)) refresh(); }, () => {}); }, [org]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { data: issued } = useData(async () => { if (!admin) return null; const open = await q(`${SEL} where d.org_id = $1 and not d.is_template and d.status <> 'closed' order by (d.status = 'done') desc, d.urgent desc, d.created_at`, [org]);
    return { open, items: await loadItems(open), tpl: await q(`${SEL} where d.org_id = $1 and d.is_template and d.active order by d.created_at`, [org]) }; }, [org, role]);
  const jmap = useJumpMap();
  const [mOpen, setMOpen] = useState(null); const [prom, setProm] = useState(null);
  const doIt = (d, it) => { const target = jumpOf(d.dir_type, jmap); go(startWork({ id: d.id, item: it?.id || null, cust: it?.customer_id || d.ref_customer_id || null, cname: it?.customer_name || d.ref_label || '', deal: d.ref_kind === 'deal' ? d.ref_id : null, type: d.dir_type, no: d.no, title: d.title, target })); };
  const run = async (msg, sql, args) => { try { await call(role, sql, args); toast(msg); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const allMine = mine?.rows || [];
  const my = allMine.filter((d) => !d.parent_id); const myRec = allMine.filter((d) => d.parent_id);
  // 370: 同一次下达 (多人 / 部门) 合成一组看: 已交 x / 共 y, 谁没交
  const groups = {}; for (const d of issued?.open || []) { const k = d.group_id || d.id; (groups[k] = groups[k] || []).push(d); }
  const grp = (d) => { const g = (groups[d.group_id || d.id] || []).filter((x) => x.reporter !== false); return g.length > 1 ? g : null; };
  const openDir = (issued?.open || []).filter((d) => !d.parent_id); const openRec = (issued?.open || []).filter((d) => d.parent_id);
  const issuedRow = (d) => {
    const g = grp(d);
    const late = d.status === 'sent' && hoursSince(d.created_at) > 4;
    const on = openId === d.id;
    const who = d.target_dept ? `部门 ${d.target_dept}` : '单人';
    return (
      <div key={d.id} className={`t2-item ${on ? 'on' : ''}`}>
        <div className="t2-row" onClick={() => setOpenId(on ? null : d.id)}>
          <div className="t2-main">
            <div className="t2-l1">{d.no && <span className="t2-no" data-tip="T = Tâche / Task（法语、英语都是 T）· 月日 · 当天第几条">{d.no}</span>}{d.urgent && <span className="pill red">紧急</span>}<b className="t2-ttl">{d.title}</b>
              {d.ref_label && d.ref_kind === 'customer' && <span className="muted">· {d.ref_label}</span>}<span className="muted">→</span><span onClick={(e) => e.stopPropagation()}><EmpLink id={d.assignee_employee_id} name={d.assignee_name} /></span>
              {d.target_dept && <span className="muted">（{d.target_dept}）</span>}{d.reporter === false && <span className="pill gray">只需收到</span>}
              <span className={`pill ${late ? 'red' : ST[d.status][1]}`}>{late ? `${Math.floor(hoursSince(d.created_at))} 小时没点收到 · 打电话` : ST[d.status][0]}</span></div>
            {g && <div className="small">这一次下给 {g.length} 人要汇报：<b>已交 {g.filter((x) => ['done', 'closed'].includes(x.status)).length} / 共 {g.length}</b>{g.some((x) => !['done', 'closed'].includes(x.status)) ? <span className="red-t2"> · 没交：{g.filter((x) => !['done', 'closed'].includes(x.status)).map((x) => x.assignee_name).join('、')}</span> : null}</div>}
            <div className="t2-times"><TC k="下达">{dt(d.created_at)}</TC>
              {d.ack_at ? <TC k="收到" tip={`下达后多久点了收到 · ${dt(d.ack_at)}`}>{after(d.created_at, d.ack_at)}</TC> : <TC k="收到" dim>还没</TC>}
              {d.done_at && <TC k="完成" tip={`下达后多久交了结果 · ${dt(d.done_at)}`}>{after(d.created_at, d.done_at)}</TC>}
              {d.reject_count > 0 && <span className="pill amber">退回过 {d.reject_count} 次</span>}
              {d.status === 'done' && <span className="pill green" onClick={(e) => e.stopPropagation()}>✓ {d.proof_id ? <>交了{PROOF_KIND[d.proof_kind] || '单据'} {d.proof_kind === 'deal' ? <DealLink id={d.proof_id} no={d.proof_label} /> : d.proof_label}</> : (d.done_note || '传了照片')}</span>}</div>
          </div>
          <div className="t2-right" onClick={(e) => e.stopPropagation()}>
            <DueChip d={d} />
            {d.status === 'done' && <><button type="button" className="btn primary" onClick={() => run('已确认，这条关闭', `select app.confirm_directive($1,true,null)`, [d.id])}>确认</button><button type="button" className="btn" onClick={() => setRej(d)}>退回</button></>}
            {d.status !== 'done' && <button type="button" className="btn sm ghost" onClick={() => setStop(d)}>撤销</button>}
          </div>
        </div>
        {on && <DirDetail d={d} g={g} late={late} items={issued?.items?.[d.id]} />}
      </div>);
  };
  // 503: 同一类放一组, 组里从老到新
  const grouped = (list) => {
    const by = {}; for (const d of list) (by[d.dir_type || '其他'] = by[d.dir_type || '其他'] || []).push(d);
    const keys = [...DIR_TYPES.filter((k) => by[k]), ...Object.keys(by).filter((k) => !DIR_TYPES.includes(k))];
    return keys.map((k) => {
      const items = by[k].slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); const ln = lateN(items);
      return (<div key={k} className="t2-grp">
        <button type="button" className={`t2-gh ${shut[k] ? 'shut' : ''}`} onClick={() => setShut((x) => ({ ...x, [k]: !x[k] }))} data-tip="组里从老到新排"><b>{k}</b><span className="c">{items.length}</span>{ln > 0 && <span className="pill red">{ln} 超时</span>}<span className="ar">▾</span></button>
        {!shut[k] && items.map(issuedRow)}
      </div>);
    });
  };
  // 508: 员工这边也能点开看「当初怎么下的 + 经过」; 按类型「去做」直接跳过去, 办完在那页顶上点「提交指令」; 系统里没对应页面的才手动交
  const mineRow = (d) => {
    const on = mOpen === d.id; const target = jumpOf(d.dir_type, jmap); const its = mine?.items?.[d.id] || [];
    const canGo = d.reporter !== false && ['sent', 'acked'].includes(d.status) && target !== 'none' && (!NEEDS_CUST.includes(target) || d.ref_customer_id || d.batch || (target === 'orders' && d.ref_kind === 'deal'));
    const promLate = isLate(d.promise_on);
    return (
      <div key={d.id} className={`t2-item ${on ? 'on' : ''}`}>
        <div className="t2-row" onClick={() => setMOpen(on ? null : d.id)}>
          <div className="t2-main">
            <div className="t2-l1">{d.no && <span className="t2-no">{d.no}</span>}{d.urgent && <span className="pill red">紧急</span>}{d.dir_type && d.dir_type !== '其他' && <span className="pill blue">{d.dir_type}</span>}<b className="t2-ttl">{d.title}</b>
              {d.ref_label && <span className="muted" onClick={(e) => e.stopPropagation()}>· {d.ref_kind === 'deal' ? <DealLink id={d.ref_id} no={d.ref_label} /> : d.ref_label}</span>}
              <span className={`pill ${ST[d.status][1]}`}>{ST[d.status][0]}</span>
              {d.promise_on && <span className={`pill ${promLate ? 'red' : 'amber'}`}>{promLate ? `客户说 ${dDate(d.promise_on)} 付，过了没到 · 再反馈一次` : `进行中 · 客户说 ${dDate(d.promise_on)} 付`}</span>}
              {d.batch && its.length > 0 && <span className="pill gray">已交 {its.filter((i) => i.status !== 'todo').length} / {its.length}</span>}</div>
            <div className="t2-times"><TC k="下达" tip={d.issuer_name ? `${d.issuer_name} 下的` : undefined}>{dt(d.created_at)}</TC>{d.require_photo && <span className="muted small">要拍照</span>}
              {d.reporter === false && <span className="muted small">这条只要点「收到」，不用交结果</span>}
              {d.status === 'acked' && d.confirm_note && <span className="pill red" style={{ whiteSpace: 'normal' }}>中方退回：{d.confirm_note}</span>}</div>
          </div>
          <div className="t2-right" onClick={(e) => e.stopPropagation()}>
            <DueChip d={d} />
            {d.status === 'sent' && <button type="button" className="btn" onClick={() => run('已收到', `select app.ack_directive2($1,$2)`, [d.id, lateMin(d) >= ACK_MIN ? '在待办页点的收到' : null])}>收到</button>}
            {canGo && !d.batch && <button type="button" className="btn primary" data-tip={`跳到「${JUMP_LABEL[target]}」，办完在那页顶上点「提交指令」就交了`} onClick={() => doIt(d)}>去做 →</button>}
            {canGo && !d.batch && d.dir_type === '催款' && <button type="button" className="btn" onClick={() => setProm({ d })}>客户说哪天付</button>}
            {d.reporter !== false && ['sent', 'acked'].includes(d.status) && !d.batch && <button type="button" className={`btn ${canGo ? 'ghost sm' : ''}`} onClick={() => setDone(d)}>{canGo ? '手动交' : '做完了，填结果'}</button>}
          </div>
        </div>
        {d.batch && its.length > 0 && <div className="t2-subs">{its.map((i) => {
          const pl = i.status === 'promised' && isLate(i.promise_on);
          return (<div key={i.id} className={`t2-sub ${i.status !== 'todo' ? 'done' : ''}`}>
            <b>{i.customer_name}</b><TierPill tier={i.tier} short empty='' /><span className="muted small">{i.city || ''}</span>
            {i.status === 'done' && <span className="pill green">已交</span>}{i.status === 'promised' && <span className={`pill ${pl ? 'red' : 'amber'}`}>客户说 {dDate(i.promise_on)} 付</span>}
            <span className="small muted">{i.proof_label || i.note || ''}</span><span className="grow" />
            {i.status === 'todo' && canGo && <><button type="button" className="btn primary sm" onClick={() => doIt(d, i)}>去做 →</button>{d.dir_type === '催款' && <button type="button" className="btn sm" onClick={() => setProm({ d, it: i })}>客户说哪天付</button>}</>}
          </div>); })}</div>}
        {on && <DirDetail d={d} g={null} late={false} items={d.batch ? its : null} />}
      </div>);
  };
  return (
    <>
      {(!admin || my.length > 0) && (
        <div className={`card todo-sec ${my.some((d) => d.urgent) ? 'todo-red' : my.length ? 'todo-amber' : ''}`} style={{ marginBottom: 12 }}>
          <div className="card-h"><h2>中方给我的指令 {my.length} 条 <Info>每一条都要自己点「收到」。点「去做」直接跳到要办的页面，办完在那页顶上点「提交指令」就交了；中方确认后才算完。</Info></h2></div>
          {my.length === 0 ? <div className="card-b small muted">没有没做完的指令。</div> : <div className="t2-list">{my.map(mineRow)}</div>}
        </div>)}
      {!admin && (
        <div className={`card todo-sec ${myRec.length ? 'todo-amber' : ''}`} style={{ marginBottom: 12 }}>
          <div className="card-h"><h2>我的定期任务 {myRec.length} 条没做 <Info>到日子自动出现（打扫、整理、回访这类）。做完要拍照交上来；没做完就一直挂在这里。</Info></h2></div>
          {myRec.length === 0 ? <div className="card-b small muted">今天没有没做的定期任务。</div> : <div className="t2-list">{myRec.map(mineRow)}</div>}
        </div>)}
      {admin && (
        <div className="card todo-sec" style={{ marginBottom: 12 }}>
          <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>我下达的指令 <Info>指令：临时下达、必须完成；员工交了这里点「确认」才关闭，做得不行就「退回」写哪里不行；超过 4 小时没点「收到」标红，直接打电话。定期任务：打扫、整理、回访这类到日子自动生成，完成必须拍照，和指令分开算完成率。</Info> <RuleGear title="指令规则" ids={['dir.ack']} /></h2>
            <span className="grow" /><div className="row"><button type="button" className="btn primary" onClick={() => setNw(true)}>＋ 下指令</button><button type="button" className="btn" onClick={() => setNw('rec')}>＋ 定期任务</button></div></div>
          <div className="tabs" style={{ padding: '0 12px' }}>
            <button type="button" className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>指令 {openDir.length}{lateN(openDir) > 0 && <span className="pill red" style={{ marginLeft: 6 }}>{lateN(openDir)} 超时</span>}</button>
            <button type="button" className={tab === 'flow' ? 'on' : ''} onClick={() => setTab('flow')}>订单<FlowBadge /></button>
            <button type="button" className={tab === 'rec' ? 'on' : ''} onClick={() => setTab('rec')}>定期任务 {issued?.tpl.length || 0}{openRec.length > 0 && <span className="pill amber" style={{ marginLeft: 6 }}>{openRec.length} 条没做完</span>}</button>
          </div>
          {tab === 'dir' && (openDir.length === 0 ? <div className="card-b small muted">没有没关的指令</div> : <div className="t2-list">{grouped(openDir)}</div>)}
          {tab === 'flow' && <OrderFlow />}
          {tab === 'rec' && <>
            {(issued?.tpl.length ? issued.tpl.map((d) => (
              <div key={d.id} className="row between todo-row" style={{ cursor: 'default' }}><div><span className="pill blue">{REPEAT[d.repeat]}</span> <b>{d.title}</b> <span className="muted small">→ {tplWho(d)}{tplWhen(d)}{d.require_photo ? ' · 要拍照' : ''}</span></div>
                <ConfirmBtn title={`停掉定期任务「${d.title}」？`} body={'以后不再自动生成这个任务。\n已经生成、还没做完的那几条不受影响，要撤得一条条撤。'} okText="确认停掉" onOk={() => run('已停掉这个定期任务', `select app.stop_directive($1)`, [d.id])}>停掉</ConfirmBtn></div>)) : <div className="card-b small muted">还没有定期任务。点「＋ 定期任务」建一个（打扫卫生、整理仓库、客户回访这类）。</div>)}
            {openRec.length > 0 && <div className="card-b small muted" style={{ paddingBottom: 0 }}>生成了、还没做完的：</div>}
            <div className="t2-list">{openRec.map(issuedRow)}</div>
          </>}
        </div>)}
      {nw && <NewDirective recurring={nw === 'rec'} onClose={() => setNw(false)} />}
      {done && <DoneModal d={done} onClose={() => setDone(null)} />}
      {rej && <RejectModal d={rej} onClose={() => setRej(null)} />}
      {stop && <StopModal d={stop} onClose={() => setStop(null)} />}
      {prom && <PromiseModal d={prom.d} it={prom.it} onClose={() => setProm(null)} />}
    </>
  );
}

// 367 / 368 (Frank 11-18): 「给谁」排第一、带搜索的多选下拉; 指令 = 临时下达、必须完成、没有「重复」, 只有中方手动关.
// 定期任务 = 单独一个入口 (recurring): 多一项「多久一次」, 其余一样.
function NewDirective({ onClose, recurring }) {
  const { org, role, toast, refresh } = useApp();
  const { data } = useData(async () => {
    const [emps, opt, customers] = await Promise.all([q(`select id, short_name, full_name, emp_no, department, position, sys_role from app.employees where org_id = $1 and active order by (emp_no is null), emp_no, short_name`, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org]), q(Q.customers, [org])]);
    return { emps, opts: staffOptions(opt[0]?.value), customers };
  }, [org]);
  const emps = data?.emps || [];
  const depts = [...new Set(emps.map((e) => e.department).filter(Boolean))];
  const deptName = (v) => optLabel(data?.opts.departments || [], v) || v;
  const jmap = useJumpMap(); const [jg, setJg] = useState(false); const [many, setMany] = useState(false); const [batch, setBatch] = useState([]);
  const [f, setF] = useState({ dir_type: (() => { try { return localStorage.getItem('la9s.dir.lastType') || '其他'; } catch { return '其他'; } })(), customer_id: '', title: '', body: '', who: [], urgent: false, require_photo: !!recurring, due_on: '', attachments: [], report_mode: 'named', reporters: [], freq: 'daily', weekdays: [1], month_days: [1], at: '' });
  const [errs, setErrs] = useState(false);
  const dept = f.who.map(String).find((v) => v.startsWith('dept:'))?.slice(5) || '';
  const people = f.who.filter((v) => !String(v).startsWith('dept:'));
  const members = emps.filter((e) => e.department === dept);
  // 369 / 370: 下给部门默认由主管汇报 (可改); 部门里没有主管就要自己点名
  const boss = (list) => list.filter((e) => ['manager', 'sales_manager', 'recycle_manager', 'recycle_wh_manager'].includes(e.sys_role) || /MANAGER|主管/i.test(e.position || '')).map((e) => e.id);
  const setWho = (v) => {
    const ds = v.map(String).filter((x) => x.startsWith('dept:'));
    const keep = ds.length > 1 ? v.filter((x) => !String(x).startsWith('dept:') || x === ds[ds.length - 1]) : v;   // 一次只下给一个部门
    const nd = keep.map(String).find((x) => x.startsWith('dept:'))?.slice(5) || '';
    setF((x) => ({ ...x, who: keep, reporters: nd && nd !== dept ? boss(emps.filter((e) => e.department === nd)) : nd ? x.reporters : [] }));
  };
  const needRep = dept && f.report_mode === 'named' && !f.reporters.length;
  const target = jumpOf(f.dir_type, jmap); const custy = !recurring && NEEDS_CUST.includes(target); const useBatch = custy && many;
  const ok = f.title.trim() && f.who.length && !(f.dir_type === '制单' && !recurring && !f.customer_id && !useBatch) && !(useBatch && !batch.length) && !needRep && (!recurring || f.freq !== 'weekly' || f.weekdays.length) && (!recurring || f.freq !== 'monthly' || f.month_days.length);
  const go = async () => {
    if (!ok) { setErrs(true); return toast(`还差：${[!f.who.length && '给谁', !recurring && f.dir_type === '制单' && !f.customer_id && !useBatch && '客户', useBatch && !batch.length && '挑客户', !f.title.trim() && '做什么', needRep && '谁来汇报', recurring && f.freq === 'weekly' && !f.weekdays.length && '每周几', recurring && f.freq === 'monthly' && !f.month_days.length && '每月几号'].filter(Boolean).join('、')}`, 'err'); }
    const p = { dir_type: recurring ? null : f.dir_type, customer_id: recurring || useBatch ? null : f.customer_id || null, customers: useBatch ? batch : undefined, title: f.title, body: f.body, urgent: f.urgent, require_photo: f.require_photo, due_on: f.due_on, attachments: f.attachments, assignees: people, dept: dept || null, report_mode: f.report_mode, reporters: f.reporters,
      ...(recurring ? { recurring: { freq: f.freq, weekdays: f.weekdays, month_days: f.month_days, at: f.at || null } } : {}) };
    try { await call(role, `select app.${recurring ? 'issue_directive2' : 'issue_directive4'}($1,$2)`, [org, JSON.stringify(p)]); if (!recurring) { try { localStorage.setItem('la9s.dir.lastType', f.dir_type); } catch { /* ignore */ } } toast(recurring ? '定期任务已建，到日子自动生成' : `已下达${dept ? `给 ${deptName(dept)} 全员` : `给 ${people.length} 个人`}${useBatch ? `，挂了 ${batch.length} 位客户` : ''}`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const whoOpts = [...depts.map((d) => ({ v: `dept:${d}`, l: `部门 · ${deptName(d)}`, hint: `${emps.filter((e) => e.department === d).length} 人，全员收到通知`, group: '部门' })),
    ...emps.map((e) => ({ v: e.id, l: `${e.emp_no ? `${e.emp_no} ` : ''}${e.short_name}`, hint: [e.full_name !== e.short_name ? e.full_name : '', deptName(e.department)].filter(Boolean).join(' · '), group: '员工' }))];
  return (
    <Modal title={recurring ? '新建定期任务' : '给员工下指令'} wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={go}>{recurring ? '建好' : '下达'}</button></>}>
      <div className="stack">
        <FRow label="给谁" req><MultiChoice value={f.who} onChange={setWho} err={errs} style={{ width: '100%' }} placeholder="点开选部门或选人，可以搜工号 / 名字，可多选" options={whoOpts} /></FRow>
        {dept && <FRow label="谁来汇报" req><div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
          <Choice value={f.report_mode} onChange={(k) => setF({ ...f, report_mode: k })} options={[['named', '指定人汇报'], ['all', '全体都要汇报']]} />
          {f.report_mode === 'named' && <MultiChoice value={f.reporters} onChange={(v) => setF({ ...f, reporters: v })} err={errs && needRep} style={{ width: '100%' }} placeholder="从这个部门里点名（默认带出主管）"
            options={members.map((e) => ({ v: e.id, l: `${e.emp_no ? `${e.emp_no} ` : ''}${e.short_name}`, hint: e.position || '' }))} />}
          <div className="small muted">{deptName(dept)} 的 {members.length} 个人都会收到通知、要点「收到」；{f.report_mode === 'all' ? '每个人各交一份结果，全部交齐才算完成。' : '只有点名的人要交结果。'}{f.report_mode === 'named' && !boss(members).length ? ' 这个部门里没找到主管，请自己点名。' : ''}</div>
        </div></FRow>}
        {!recurring && <FRow label="类型"><div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}><OptChoice optKey="directive_type" title="指令类型" value={f.dir_type} onChange={(v) => setF({ ...f, dir_type: v })} options={DIR_TYPES} />
          <div className="small muted row" style={{ gap: 6 }}>{target === 'none' ? '这类在系统里没有对应页面，员工手动交结果' : <>员工点「去做」跳到：<b>{JUMP_LABEL[target]}</b>，办完在那页点「提交指令」就交了</>}<button type="button" className="gear-mini" title="每种类型跳到哪" onClick={() => setJg(true)}>⚙</button></div></div></FRow>}
        {!recurring && <FRow label="客户" req={f.dir_type === '制单'}><div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
          {custy && <Choice value={many ? 'y' : 'n'} onChange={(v) => setMany(v === 'y')} options={[['n', '一个客户'], ['y', '一批客户']]} />}
          {useBatch ? <BatchPick value={batch} onChange={setBatch} /> : <CustomerSelect customers={data?.customers || []} value={f.customer_id} onChange={(v) => setF({ ...f, customer_id: v })} />}
          {f.dir_type === '制单' && !useBatch && <div className="small muted">员工点「去做」直接进这个客户的新建报价；客户在群里发的截图贴到下面附件。</div>}</div></FRow>}
        <FRow label="做什么" req><input className={`in ${errs && !f.title.trim() ? 'err-in' : ''}`} style={{ width: '100%' }} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={recurring ? '一句话，例如 打扫仓库卫生' : '一句话，例如 今天下班前把 A 架盘点一遍'} /></FRow>
        <FRow label="说明"><textarea className="in" rows={2} style={{ width: '100%' }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="要注意什么、做到什么算完成" /></FRow>
        <FRow label="附件"><Attach value={f.attachments} onChange={(v) => setF({ ...f, attachments: v })} /></FRow>
        {recurring && <FRow label="多久一次" req><div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
          <Choice value={f.freq} onChange={(k) => setF({ ...f, freq: k })} options={[['daily', '每天'], ['weekly', '每周'], ['monthly', '每月']]} />
          {f.freq === 'weekly' && <MultiChoice value={f.weekdays} onChange={(v) => setF({ ...f, weekdays: [...v].sort() })} err={errs} style={{ width: '100%' }} placeholder="每周几（可多选）" options={WD.slice(1, 7).map((l, i) => ({ v: i + 1, l }))} />}
          {f.freq === 'monthly' && <MultiChoice value={f.month_days} onChange={(v) => setF({ ...f, month_days: [...v].sort((a, b) => a - b) })} err={errs} style={{ width: '100%' }} placeholder="每月几号（可多选）" options={Array.from({ length: 28 }, (_, i) => ({ v: i + 1, l: `${i + 1} 号` }))} />}
        </div></FRow>}
        {recurring && <FRow label="大概什么时候"><input className="in" type="time" style={{ width: 130 }} value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></FRow>}
        {!recurring && <FRow label="紧急程度"><Choice value={f.urgent ? 'y' : 'n'} onChange={(v) => setF({ ...f, urgent: v === 'y' })} options={[['n', '普通'], ['y', '紧急']]} /></FRow>}
        {!recurring && <FRow label="结果要求"><Choice value={f.require_photo ? 'y' : 'n'} onChange={(v) => setF({ ...f, require_photo: v === 'y' })} options={[['n', '文字或照片都行'], ['y', '必须拍照']]} /></FRow>}
        {!recurring && <FRow label="什么时候前做完"><DatePicker value={f.due_on} onChange={(v) => setF({ ...f, due_on: v })} /></FRow>}
        <div className="hint">{recurring ? '到日子系统自动生成（每天的周日不生成）；完成必须拍照交凭证；没点完成就一直挂在待办里，直到做完或你停掉这个定期任务。' : '一下达就必须完成：员工做完交结果，你确认才关闭；不会自己结束。'}</div>
      </div>
      {jg && <JumpGear onClose={() => setJg(false)} />}
    </Modal>
  );
}
// 508: 每种指令类型跳到哪 (存 org_settings directive_jump; 新加的类型也在这里挑)
function JumpGear({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const jmap = useJumpMap(); const { list } = useOptList('directive_type', DIR_TYPES);
  const [m, setM] = useState(null); const cur = m || Object.fromEntries(list.map(([v]) => [v, jumpOf(v, jmap)]));
  const save = async () => { try { await call(role, `select app.set_org_setting($1,'directive_jump',$2)`, [org, JSON.stringify(cur)]); toast('已保存，立即生效'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="每种指令类型，员工点「去做」跳到哪" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={save}>保存</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        {list.map(([v, l]) => <div key={v} className="row" style={{ gap: 10 }}><b style={{ width: 90 }}>{l}</b><select className="in" style={{ flex: 1, minWidth: 0 }} value={cur[v]} onChange={(e) => setM({ ...cur, [v]: e.target.value })}>{JUMPS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>)}
        <div className="small muted">类型本身（新增 / 改名 / 删除）还在「类型」旁边的 ⚙ 里改；这里只定跳到哪。选「不跳」的，员工还是手动交结果。</div>
      </div>
    </Modal>
  );
}
// 508: 一批客户 —— 粗略只点档位; 要细再加 多少天没下单 / 归哪个销售员 / 城市 / 欠款; 人数实时变, 不要的取消勾选
const TIERS4 = ['S', 'WHOLESALE', 'RETAIL', 'REPAIR'];
function BatchPick({ value, onChange }) {
  const { org } = useApp();
  const all = useData(() => q(Q.customerProfiles, [org]), [org]).data || [];
  const [tiers, setTiers] = useState(['S', 'WHOLESALE']); const [quiet, setQuiet] = useState('0'); const [owner, setOwner] = useState('*'); const [city, setCity] = useState('*'); const [debt, setDebt] = useState('*');
  const [off, setOff] = useState([]);
  const days = (v) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 864e5) : null);
  const hit = all.filter((c) => c.status === 'active' && (!tiers.length || tiers.includes(c.tier)) && (quiet === '0' || (days(c.last_deal) ?? 9999) >= Number(quiet))
    && (owner === '*' || c.owner === owner) && (city === '*' || c.city === city) && (debt === '*' || (debt === 'due' ? Number(c.balance) > 0 : Number(c.over_days) > 0)));
  const ids = hit.map((c) => c.id).filter((id) => !off.includes(id));
  const key = ids.join(',');
  useEffect(() => { if (key !== value.join(',')) onChange(ids); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const owners = [...new Set(all.map((c) => c.owner).filter(Boolean))].sort(); const cities = [...new Set(all.map((c) => c.city).filter(Boolean))].sort();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="batch-f">
        <div><span>档位</span><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{TIERS4.map((t) => <button type="button" key={t} className={`chip tierchip ${tiers.includes(t) ? 'on' : ''}`} onClick={() => setTiers(tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t])}><TierPill tier={t} short /></button>)}</div></div>
        <div><span>多少天没下单</span><Choice value={quiet} onChange={setQuiet} options={[['0', '不限'], ['15', '超过 15 天'], ['30', '超过 30 天'], ['60', '超过 60 天'], ['90', '超过 90 天']]} /></div>
        <div><span>归哪个销售员</span><Choice value={owner} onChange={setOwner} options={[['*', '全部'], ...owners.map((o) => [o, o])]} /></div>
        <div><span>城市</span><Choice value={city} onChange={setCity} options={[['*', '全部'], ...cities.map((o) => [o, o])]} /></div>
        <div><span>欠款</span><Choice value={debt} onChange={setDebt} options={[['*', '不限'], ['due', '有欠款'], ['over', '超账期']]} /></div>
      </div>
      <div className="small">符合 <b className="brand-t">{hit.length}</b> 位，挂上 <b className="brand-t">{ids.length}</b> 位 <span className="muted">（每位一项，员工逐个去做、逐个提交；不要的取消勾选）</span></div>
      <div className="batch-list">{hit.map((c) => { const d = days(c.last_deal); return (
        <label key={c.id} className="batch-it"><input type="checkbox" checked={!off.includes(c.id)} onChange={() => setOff(off.includes(c.id) ? off.filter((x) => x !== c.id) : [...off, c.id])} />
          <b>{c.name}</b><TierPill tier={c.tier} short empty="" /><span className="muted small">{c.city || ''}{c.owner ? ` · ${c.owner}` : ''} · {d == null ? '没下过单' : `${d} 天没下单`}{Number(c.balance) > 0 ? ` · 欠 ${Number(c.balance).toLocaleString('en-US')}` : ''}</span></label>); })}
        {!hit.length && <div className="small muted">没有符合的客户，放宽一点条件。</div>}</div>
    </div>
  );
}
function DoneModal({ d, onClose }) {
  const { role, toast, refresh } = useApp();
  const [note, setNote] = useState(''); const [photo, setPhoto] = useState('');
  // 338: 问付款计划的任务 —— 结果必须填「哪天付多少」(可以多行) + 截图
  const plan = d.task_type === 'payment_plan';
  const [rows, setRows] = useState([{ on: '', amount: '' }]);
  // 480: 凭证 = 系统里的记录 —— 同一客户、指令下达后建的单据, 最新那条自动挂上, 能换; 制单这种必须选单据
  const { org } = useApp();
  const { data: cand } = useData(async () => (plan ? null : {
    rows: await call(role, `select * from app.directive_candidates($1)`, [d.id]).catch(() => []),
    rule: (await call(role, `select app.directive_proof_rule($1,$2) as r`, [org, d.dir_type || '']).catch(() => [{ r: {} }]))[0]?.r || {} }), [d.id, role, org]);
  const [pick, setPick] = useState(undefined);
  const cands = cand?.rows || []; const must = !!cand?.rule?.required;
  const chosen = pick === undefined ? cands[0] || null : pick;
  const rowsOk = rows.filter((r) => r.on && Number(r.amount) > 0);
  const ok = plan ? rowsOk.length > 0 && rowsOk.length === rows.filter((r) => r.on || r.amount).length && !!photo : chosen ? true : !must && (note.trim() || photo) && (!d.require_photo || photo);
  const go = async () => {
    try {
      if (d.task_type) await call(role, `select app.complete_task($1,$2,$3,$4)`, [d.id, JSON.stringify(plan ? rowsOk.map((r) => ({ on: r.on, amount: Number(r.amount) })) : null), note || null, photo || null]);
      else await call(role, `select app.complete_directive2($1,$2,$3,$4,$5)`, [d.id, note || null, photo || null, chosen?.kind || null, chosen?.id || null]);
      toast('已交，等中方确认'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`做完了：${d.title}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">{plan ? '填哪天付多少，并传截图' : must && !chosen ? `「${d.dir_type}」要选你做好的单据` : d.require_photo && !photo ? '这条要求拍照' : '填结果（文字或照片），或选一张单据'}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>完成</button></>}>
      <div className="stack">
        {plan && <FRow label="付款计划" req><div className="stack" style={{ gap: 6, flex: 1 }}>
          {rows.map((r, i) => <div key={i} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <DatePicker value={r.on} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, on: v } : x)))} label={r.on ? '' : '哪天付'} />
            <MoneyIn className="in" inputMode="numeric" style={{ width: 130 }} placeholder="付多少" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/\D/g, '') } : x)))} />
            {rows.length > 1 && <button type="button" className="btn sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>去掉</button>}
          </div>)}
          <div><button type="button" className="btn sm" onClick={() => setRows([...rows, { on: '', amount: '' }])}>＋ 分几次付就加一行</button></div>
        </div></FRow>}
        {!plan && (cands.length > 0 || must) && <FRow label="凭证" req={must}><div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
          {cands.map((c) => <button type="button" key={c.kind + c.id} className={`opt-row ${chosen?.id === c.id ? 'on' : ''}`} onClick={() => setPick(chosen?.id === c.id && !must ? null : c)}>
            <span className="pill blue">{PROOF_KIND[c.kind]}</span><b>{c.label}</b><span className="small muted">{c.detail || ''} · {dt(c.at)}</span></button>)}
          {!cands.length && <div className="small red-t2">这个客户在指令下达以后还没有{(cand?.rule?.kinds || []).map((k) => PROOF_KIND[k]).join(' / ') || '单据'}：先去建好，再回来交。</div>}
          {cands.length > 0 && <div className="small muted">{pick === undefined ? '系统自动挂上了最新的一条；' : ''}点别的可以换{must ? '' : '，再点一下取消改交照片 / 文字'}。</div>}
        </div></FRow>}
        <FRow label={plan ? '补充说明' : '结果'} req={!plan && !d.require_photo && !chosen}><textarea className="in" rows={plan ? 2 : 3} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={plan ? '客户原话 / 谁答应的' : '做了什么、结果怎么样'} /></FRow>
        <FRow label={plan ? '客户答应的截图' : '照片'} req={plan || d.require_photo}><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={photo} onChange={setPhoto} label={plan ? '聊天截图' : '拍结果'} /></div></FRow>
      </div>
    </Modal>
  );
}

// 502: 撤销先确认 —— 写清会发生什么, 必须选 / 写原因 (员工能看到)
const STOP_REASONS = ['下错人', '不用做了', '重新下', '其他'];
function StopModal({ d, onClose }) {
  const { role, toast, refresh } = useApp();
  const [note, setNote] = useState('');
  const go = async () => { try { await call(role, `select app.stop_directive2($1,$2)`, [d.id, note]); toast('已撤销，记进操作记录了'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal risk="yellow" title={`撤销 ${d.no || ''}「${d.title}」？`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>不撤了</button><button type="button" className="btn primary" disabled={!note.trim()} onClick={go}>确认撤销</button></>}>
      <div className="stack">
        <div className="small">这条会从 <b>{d.assignee_name}</b> 的待办里消失；撤销后不能恢复，还要做就得重新下。</div>
        <FRow label="原因" req><OptNote optKey="dir.stop_reason" title="撤销原因" options={STOP_REASONS} value={note} onChange={setNote} placeholder="为什么撤（他能看到）" /></FRow>
      </div>
    </Modal>
  );
}
function RejectModal({ d, onClose }) {
  const { role, toast, refresh } = useApp();
  const [note, setNote] = useState('');
  const go = async () => { try { await call(role, `select app.confirm_directive($1,false,$2)`, [d.id, note]); toast('已退回，他要重做'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`退回：${d.title}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!note.trim()} onClick={go}>退回重做</button></>}>
      <FRow label="哪里不行" req><input className="in" style={{ width: '100%' }} autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></FRow>
    </Modal>
  );
}

// 508: 催款反馈 —— 客户说哪天付; 到那天前算进行中, 过了还没到自动变紧急、回到你手里再反馈一次
function PromiseModal({ d, it, onClose }) {
  const { role, toast, refresh } = useApp();
  const [on, setOn] = useState(''); const [note, setNote] = useState('');
  const go = async () => { try { await call(role, `select app.directive_promise($1,$2,$3,$4)`, [d.id, it?.id || null, on, note || null]); toast(`已反馈：客户说 ${dDate(on)} 付`); setWork(null); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`客户说哪天付 · ${it?.customer_name || d.ref_label || ''}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={!on} onClick={go}>一键反馈</button></>}>
      <div className="stack">
        <FRow label="哪天付" req><DatePicker value={on} onChange={setOn} /></FRow>
        <FRow label="客户原话"><OptNote optKey="dir.promise_note" title="催款快捷原话" options={['这周五付', '等货卖完再付', '月底统一付', '先付一半']} value={note} onChange={setNote} placeholder="可不填" /></FRow>
        <div className="small muted">到那天之前这条显示「进行中」；过了那天钱还没到，自动变紧急，要你再反馈一次。当场付了就去「收款登记」登记，回来点「提交指令」。</div>
      </div>
    </Modal>
  );
}

// 508: 正在办的指令 —— 从待办「去做」跳过来后, 每一页顶上都有这条; 办完点「提交指令」= 自动挂上这次建的单 / 记录, 不用再回去传凭证
const RECORD_TARGETS = { quote: '报价单', hotline: '热线记录', visits: '拜访记录', orders: '出库 / 退货记录' };
export function DirBar() {
  const { role, toast, refresh, go } = useApp();
  const [w, setW] = useState(getWork);
  const [busy, setBusy] = useState(false); const [prom, setProm] = useState(false);
  useEffect(() => { const f = () => setW(getWork()); window.addEventListener('la9s-dirwork', f); return () => window.removeEventListener('la9s-dirwork', f); }, []);
  if (!w) return null;
  const done = (msg) => { setWork(null); toast(msg); refresh(); go('todo'); };
  const submit = async () => {
    setBusy(true);
    try {
      const cands = w.cust ? await call(role, `select * from app.directive_candidates2($1,$2)`, [w.id, w.cust]) : [];
      const x = (w.type === '催款' ? cands.filter((c) => c.kind === 'receipt') : cands)[0];
      if (x) {
        if (w.item) await call(role, `select app.directive_item_done($1,$2,$3,null)`, [w.item, x.kind, x.id]);
        else await call(role, `select app.complete_directive2($1,null,null,$2,$3)`, [w.id, x.kind, x.id]);
        return done(`已交：${PROOF_KIND[x.kind] || '记录'} ${x.label}，等中方确认`);
      }
      if (RECORD_TARGETS[w.target] || w.type === '催款') { setBusy(false); return toast(w.type === '催款' ? '还没登记这位客户的收款：当场付了先去登记；没付就点「客户说哪天付」' : `指令下达以后还没找到 ${w.cname || '这位客户'} 的新${RECORD_TARGETS[w.target]}：先在这页做完、保存，再点提交`, 'err'); }
      const note = `在「${JUMP_LABEL[w.target]}」页办完了`;
      if (w.item) await call(role, `select app.directive_item_done($1,null,null,$2)`, [w.item, note]);
      else await call(role, `select app.complete_directive2($1,$2,null)`, [w.id, note]);
      done('已交，等中方确认');
    } catch (e) { setBusy(false); toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="dirbar">
      <span className="pill blue">正在办指令</span>{w.no && <span className="t2-no">{w.no}</span>}{w.type && <b>{w.type}</b>}{w.cname && <span>· {w.cname}</span>}<span className="muted dirbar-t">{w.title}</span>
      <span className="grow" />
      {w.type === '催款' && <button type="button" className="btn sm" onClick={() => setProm(true)}>客户说哪天付</button>}
      <button type="button" className="btn primary sm" disabled={busy} data-tip={RECORD_TARGETS[w.target] ? `自动挂上指令下达后这位客户最新的${RECORD_TARGETS[w.target]}` : '直接算交了'} onClick={submit}>提交指令</button>
      <button type="button" className="btn ghost sm" onClick={() => { setWork(null); go('todo'); }}>先不交，回待办</button>
      {prom && <PromiseModal d={{ id: w.id, ref_label: w.cname }} it={w.item ? { id: w.item, customer_name: w.cname } : null} onClose={() => { setProm(false); if (!getWork()) go('todo'); }} />}
    </div>
  );
}
// 选项设置页读默认值（11-28）
regBase('directive_type', () => DIR_TYPES);
