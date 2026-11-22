// 227 ② (Frank 11-05 定稿): 中方指令 —— 中方给员工下达任务; 员工必须自己点「收到」、做完自己点「完成」并填结果 (文字 / 照片); 中方确认才关闭
// 没点「收到」的: 打开系统强制弹窗; 超过 4 小时 (可设) 没点收到 → 在中方待办里标红, 由中方打电话
import { RuleGear } from './Rules.jsx';
import React, { useEffect, useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, Modal, FRow, Info, PhotoInput, Thumb, DatePicker, FileDrop, Choice, MoneyIn, MultiChoice, Assumed } from './ui.jsx';
import { EmpLink, DealLink } from './Archives.jsx';
import { dt, dDate, friendlyError } from '../lib/format.js';
import { OptChoice } from './Opts.jsx';
import CustomerSelect from './CustomerSelect.jsx';
import * as Q from '../db/queries.js';
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
  if (['done', 'closed'].includes(d.status)) return <span className="due-chip"><span className="pill gray">已交</span><small>{dt(t)}</small></span>;
  const ms = t.getTime() - Date.now();
  const tone = ms < 0 ? 'red' : ms < 2 * 36e5 ? 'amber' : 'gray';
  return <span className="due-chip"><span className={`pill ${tone}`}>{ms < 0 ? `超时 ${span(ms)}` : `还剩 ${span(ms)}`}</span><small>{dt(t)}</small></span>;
}
const SEL = `select d.*, e.short_name as assignee_name, ce.short_name as issuer_name from app.directives d left join app.employees e on e.id = d.assignee_employee_id
  left join app.members cm on cm.org_id = d.org_id and cm.user_id = d.created_by left join app.employees ce on ce.id = cm.employee_id`;

function useMine() {
  const { org, role } = useApp();
  return useData(async () => {
    const [m] = await q(`select employee_id from app.members where org_id = $1 and user_id = $2`, [org, USERS[role]]);
    if (!m?.employee_id) return { emp: null, rows: [] };
    const rows = await q(`${SEL} where d.org_id = $1 and d.assignee_employee_id = $2 and not d.is_template and d.status <> 'closed' order by d.urgent desc, d.created_at`, [org, m.employee_id]);
    return { emp: m.employee_id, rows };
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
const beep = () => { try { const C = window.AudioContext || window.webkitAudioContext; const c = new C(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.08; o.start(); o.stop(c.currentTime + 0.35); } catch { /* 浏览器不让响就算了 */ } };
export function DirectiveGate() {
  const { role, toast, refresh } = useApp();
  const mine = useMine();
  const un = (mine?.rows || []).filter((d) => d.status === 'sent' && !d.parent_id);   // 368: 定期任务比指令轻, 不弹窗挡操作, 只在待办里常驻
  const [why, setWhy] = useState({});
  useEffect(() => { if (un.length) beep(); }, [un.length]);
  if (!un.length) return null;
  const ack = async (d) => { try { await call(role, `select app.ack_directive2($1,$2)`, [d.id, why[d.id] || null]); toast('已收到，做完到「我的待办」点完成'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`中方给你的指令（${un.length} 条没点收到）`} onClose={() => {}} footer={<span className="small muted">每一条都要点「收到」；规定 {ACK_MIN} 分钟内收到，超了要写原因。做完后到「我的待办」点完成、填结果。</span>}>
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

export default function DirectiveBoard() {
  const { org, role, toast, refresh } = useApp();
  const admin = role === 'admin';
  const mine = useMine();
  const [nw, setNw] = useState(false); const [done, setDone] = useState(null); const [rej, setRej] = useState(null); const [tab, setTab] = useState('dir');
  const lateN = (list) => list.filter((d) => { const t = dueAt(d); return t && t < new Date() && !['done', 'closed'].includes(d.status); }).length;
  useEffect(() => { if (org) call(role, `select app.spawn_directives($1)`, [org]).then((r) => { if (Number(Object.values(r?.[0] || {})[0]) > 0) refresh(); }, () => {}); }, [org]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { data: issued } = useData(async () => (admin ? { open: await q(`${SEL} where d.org_id = $1 and not d.is_template and d.status <> 'closed' order by (d.status = 'done') desc, d.urgent desc, d.created_at`, [org]),
    tpl: await q(`${SEL} where d.org_id = $1 and d.is_template and d.active order by d.created_at`, [org]) } : null), [org, role]);
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
            return (
              <div key={d.id} className="row between todo-row" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                <div className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
                  <div>{d.urgent && <span className="pill red" style={{ marginRight: 6 }}>紧急</span>}{d.dir_type && d.dir_type !== '其他' && <span className="pill blue" style={{ marginRight: 6 }}>{d.dir_type}</span>}<b>{d.title}</b>{d.ref_label && d.ref_kind === 'customer' && <span className="muted small"> · {d.ref_label}</span>}{d.target_dept && <span className="pill blue" style={{ marginLeft: 6 }}>部门 {d.target_dept}</span>}{d.reporter === false && <span className="pill gray" style={{ marginLeft: 6 }}>只需收到</span>} <span className="muted small">→ </span><EmpLink id={d.assignee_employee_id} name={d.assignee_name} /> <span className={`pill ${late ? 'red' : ST[d.status][1]}`}>{late ? `${Math.floor(hoursSince(d.created_at))} 小时没点收到 · 打电话` : ST[d.status][0]}</span></div>
                  {g && <div className="small">这一次下给 {g.length} 人要汇报：<b>已交 {g.filter((x) => ['done', 'closed'].includes(x.status)).length} / 共 {g.length}</b>{g.some((x) => !['done', 'closed'].includes(x.status)) ? <span className="red-t2"> · 没交：{g.filter((x) => !['done', 'closed'].includes(x.status)).map((x) => x.assignee_name).join('、')}</span> : null}</div>}
                  <div className="small muted">下达 {dt(d.created_at)}{d.ack_at ? ` · 收到 ${dt(d.ack_at)}（${Math.max(0, Math.round((new Date(d.ack_at) - new Date(d.created_at)) / 60e3))} 分钟）` : ''}{d.ack_reason ? ` · 晚收到的原因：${d.ack_reason}` : ''}{d.done_at ? ` · 完成 ${dt(d.done_at)}` : ''}{d.reject_count ? ` · 退回过 ${d.reject_count} 次` : ''}</div>
                  {d.status === 'done' && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="small">结果：{d.proof_id ? <>交了{PROOF_KIND[d.proof_kind] || '单据'} {d.proof_kind === 'deal' ? <DealLink id={d.proof_id} no={d.proof_label} /> : <b>{d.proof_label}</b>}{d.done_note ? ` · ${d.done_note}` : ''}</> : (d.done_note || '（只传了照片）')}</span>{d.done_photo && <Thumb src={d.done_photo} size={44} label="完成照片" />}</div>}
                </div>
                <div className="row" style={{ flexShrink: 0 }}>
                  <DueChip d={d} />
                  {d.status === 'done' && <><button type="button" className="btn primary" onClick={() => run('已确认，这条关闭', `select app.confirm_directive($1,true,null)`, [d.id])}>确认</button><button type="button" className="btn" onClick={() => setRej(d)}>退回</button></>}
                  {d.status !== 'done' && <button type="button" className="btn sm ghost" onClick={() => run('已撤销', `select app.stop_directive($1)`, [d.id])}>撤销</button>}
                </div>
              </div>);
  };
  const mineRow = (d) => (
            <div key={d.id} className="row between todo-row" style={{ cursor: 'default', flexWrap: 'wrap' }}>
              <div className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
                <div>{d.urgent && <span className="pill red" style={{ marginRight: 6 }}>紧急</span>}{d.dir_type && d.dir_type !== '其他' && <span className="pill blue" style={{ marginRight: 6 }}>{d.dir_type}</span>}<b>{d.title}</b> <span className={`pill ${ST[d.status][1]}`}>{ST[d.status][0]}</span></div>
                {d.body && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>}
                {d.ref_label && <div className="small">{d.ref_kind === 'customer' ? '客户：' : '挂在：'}{d.ref_kind === 'deal' ? <DealLink id={d.ref_id} no={d.ref_label} /> : <b>{d.ref_label}</b>}</div>}
                <AttList items={d.attachments} />
                <div className="small muted">{dt(d.created_at)}{d.require_photo ? ' · 要拍照' : ''}{d.at_time ? ` · 大概 ${d.at_time} 做` : ''}{d.target_dept ? ` · 下给部门：${d.target_dept}` : ''}</div>
                {d.reporter === false && <div className="small muted">这条你只要点「收到」，不用交结果。</div>}
                {d.status === 'acked' && d.confirm_note && <div className="pill red" style={{ whiteSpace: 'normal' }}>中方退回：{d.confirm_note}</div>}
              </div>
              <div className="row" style={{ flexShrink: 0 }}>
                <DueChip d={d} />
                {d.status === 'sent' && <button type="button" className="btn primary" onClick={() => run('已收到', `select app.ack_directive2($1,$2)`, [d.id, lateMin(d) >= ACK_MIN ? '在待办页点的收到' : null])}>收到</button>}
                {d.reporter !== false && ['sent', 'acked'].includes(d.status) && <button type="button" className="btn" onClick={() => setDone(d)}>做完了，填结果</button>}
              </div>
            </div>);
  return (
    <>
      {!admin && (
        <div className={`card todo-sec ${my.some((d) => d.urgent) ? 'todo-red' : my.length ? 'todo-amber' : ''}`} style={{ marginBottom: 12 }}>
          <div className="card-h"><h2>中方给我的指令 {my.length} 条 <Info>每一条都要自己点「收到」，做完自己点「完成」并填结果；中方确认后才算完。</Info></h2></div>
          {my.length === 0 ? <div className="card-b small muted">没有没做完的指令。</div> : my.map(mineRow)}
        </div>)}
      {!admin && (
        <div className={`card todo-sec ${myRec.length ? 'todo-amber' : ''}`} style={{ marginBottom: 12 }}>
          <div className="card-h"><h2>我的定期任务 {myRec.length} 条没做 <Info>到日子自动出现（打扫、整理、回访这类）。做完要拍照交上来；没做完就一直挂在这里。</Info></h2></div>
          {myRec.length === 0 ? <div className="card-b small muted">今天没有没做的定期任务。</div> : myRec.map(mineRow)}
        </div>)}
      {admin && (
        <div className="card todo-sec" style={{ marginBottom: 12 }}>
          <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>我下达的指令 <Info>指令：临时下达、必须完成；员工交了这里点「确认」才关闭，做得不行就「退回」写哪里不行；超过 4 小时没点「收到」标红，直接打电话。定期任务：打扫、整理、回访这类到日子自动生成，完成必须拍照，和指令分开算完成率。</Info> <RuleGear title="指令规则" ids={['dir.ack']} /></h2>
            <span className="grow" /><div className="row"><button type="button" className="btn primary" onClick={() => setNw(true)}>＋ 下指令</button><button type="button" className="btn" onClick={() => setNw('rec')}>＋ 定期任务</button></div></div>
          <div className="tabs" style={{ padding: '0 12px' }}>
            <button type="button" className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}>指令 {openDir.length}{lateN(openDir) > 0 && <span className="pill red" style={{ marginLeft: 6 }}>{lateN(openDir)} 超时</span>}</button>
            <button type="button" className={tab === 'rec' ? 'on' : ''} onClick={() => setTab('rec')}>定期任务 {issued?.tpl.length || 0}{openRec.length > 0 && <span className="pill amber" style={{ marginLeft: 6 }}>{openRec.length} 条没做完</span>}</button>
          </div>
          {tab === 'dir' && (openDir.length === 0 ? <div className="card-b small muted">没有没关的指令</div> : openDir.map(issuedRow))}
          {tab === 'rec' && <>
            {(issued?.tpl.length ? issued.tpl.map((d) => (
              <div key={d.id} className="row between todo-row" style={{ cursor: 'default' }}><div><span className="pill blue">{REPEAT[d.repeat]}</span> <b>{d.title}</b> <span className="muted small">→ {tplWho(d)}{tplWhen(d)}{d.require_photo ? ' · 要拍照' : ''}</span></div>
                <button type="button" className="btn sm" onClick={() => run('已停掉这个定期任务', `select app.stop_directive($1)`, [d.id])}>停掉</button></div>)) : <div className="card-b small muted">还没有定期任务。点「＋ 定期任务」建一个（打扫卫生、整理仓库、客户回访这类）。</div>)}
            {openRec.length > 0 && <div className="card-b small muted" style={{ paddingBottom: 0 }}>生成了、还没做完的：</div>}
            {openRec.map(issuedRow)}
          </>}
        </div>)}
      {nw && <NewDirective recurring={nw === 'rec'} onClose={() => setNw(false)} />}
      {done && <DoneModal d={done} onClose={() => setDone(null)} />}
      {rej && <RejectModal d={rej} onClose={() => setRej(null)} />}
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
  const [f, setF] = useState({ dir_type: '其他', customer_id: '', title: '', body: '', who: [], urgent: false, require_photo: !!recurring, due_on: '', attachments: [], report_mode: 'named', reporters: [], freq: 'daily', weekdays: [1], month_days: [1], at: '' });
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
  const ok = f.title.trim() && f.who.length && !(f.dir_type === '制单' && !recurring && !f.customer_id) && !needRep && (!recurring || f.freq !== 'weekly' || f.weekdays.length) && (!recurring || f.freq !== 'monthly' || f.month_days.length);
  const go = async () => {
    if (!ok) { setErrs(true); return toast(`还差：${[!f.who.length && '给谁', !recurring && f.dir_type === '制单' && !f.customer_id && '客户', !f.title.trim() && '做什么', needRep && '谁来汇报', recurring && f.freq === 'weekly' && !f.weekdays.length && '每周几', recurring && f.freq === 'monthly' && !f.month_days.length && '每月几号'].filter(Boolean).join('、')}`, 'err'); }
    const p = { dir_type: recurring ? null : f.dir_type, customer_id: recurring ? null : f.customer_id || null, title: f.title, body: f.body, urgent: f.urgent, require_photo: f.require_photo, due_on: f.due_on, attachments: f.attachments, assignees: people, dept: dept || null, report_mode: f.report_mode, reporters: f.reporters,
      ...(recurring ? { recurring: { freq: f.freq, weekdays: f.weekdays, month_days: f.month_days, at: f.at || null } } : {}) };
    try { await call(role, `select app.${recurring ? 'issue_directive2' : 'issue_directive3'}($1,$2)`, [org, JSON.stringify(p)]); toast(recurring ? '定期任务已建，到日子自动生成' : `已下达${dept ? `给 ${deptName(dept)} 全员` : `给 ${people.length} 个人`}`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
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
        {!recurring && <FRow label="类型"><OptChoice optKey="directive_type" title="指令类型" value={f.dir_type} onChange={(v) => setF({ ...f, dir_type: v })} options={DIR_TYPES} /></FRow>}
        {!recurring && <FRow label="客户" req={f.dir_type === '制单'}><div style={{ flex: 1, minWidth: 0 }}><CustomerSelect customers={data?.customers || []} value={f.customer_id} onChange={(v) => setF({ ...f, customer_id: v })} />
          {f.dir_type === '制单' && <div className="small muted" style={{ marginTop: 4 }}>员工建好这个客户的单，交的时候直接选那张单；客户在群里发的截图贴到下面附件。</div>}</div></FRow>}
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
    </Modal>
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
