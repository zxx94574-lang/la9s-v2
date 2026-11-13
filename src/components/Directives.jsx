// 227 ② (Frank 11-05 定稿): 中方指令 —— 中方给员工下达任务; 员工必须自己点「收到」、做完自己点「完成」并填结果 (文字 / 照片); 中方确认才关闭
// 没点「收到」的: 打开系统强制弹窗; 超过 4 小时 (可设) 没点收到 → 在中方待办里标红, 由中方打电话
import React, { useEffect, useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, Modal, FRow, Info, PhotoInput, Thumb, DatePicker, FileDrop } from './ui.jsx';
import { EmpLink } from './Archives.jsx';
import { dt, dDate, friendlyError } from '../lib/format.js';

const ST = { sent: ['还没点收到', 'red'], acked: ['已收到，在做', 'amber'], done: ['做完了，等中方确认', 'amber'], closed: ['已关闭', 'green'] };
const REPEAT = { daily: '每天', weekly: '每周', monthly: '每月' };
const hoursSince = (v) => (Date.now() - new Date(v).getTime()) / 36e5;
const SEL = `select d.*, e.short_name as assignee_name, ce.short_name as issuer_name from app.directives d join app.employees e on e.id = d.assignee_employee_id
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
  const un = (mine?.rows || []).filter((d) => d.status === 'sent');
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
  const [nw, setNw] = useState(false); const [done, setDone] = useState(null); const [rej, setRej] = useState(null); const [showTpl, setShowTpl] = useState(false);
  useEffect(() => { if (org) call(role, `select app.spawn_directives($1)`, [org]).then((r) => { if (Number(Object.values(r?.[0] || {})[0]) > 0) refresh(); }, () => {}); }, [org]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { data: issued } = useData(async () => (admin ? { open: await q(`${SEL} where d.org_id = $1 and not d.is_template and d.status <> 'closed' order by (d.status = 'done') desc, d.urgent desc, d.created_at`, [org]),
    tpl: await q(`${SEL} where d.org_id = $1 and d.is_template and d.active order by d.created_at`, [org]) } : null), [org, role]);
  const run = async (msg, sql, args) => { try { await call(role, sql, args); toast(msg); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const my = mine?.rows || [];
  if (!admin && !my.length) return null;
  return (
    <>
      {my.length > 0 && (
        <div className={`card todo-sec ${my.some((d) => d.urgent) ? 'todo-red' : 'todo-amber'}`} style={{ marginBottom: 12 }}>
          <div className="card-h"><h2>中方给我的指令 {my.length} 条 <Info>每一条都要自己点「收到」，做完自己点「完成」并填结果；中方确认后才算完。</Info></h2></div>
          {my.map((d) => (
            <div key={d.id} className="row between todo-row" style={{ cursor: 'default', flexWrap: 'wrap' }}>
              <div className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
                <div>{d.urgent && <span className="pill red" style={{ marginRight: 6 }}>紧急</span>}<b>{d.title}</b> <span className={`pill ${ST[d.status][1]}`}>{ST[d.status][0]}</span></div>
                {d.body && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>}
                <AttList items={d.attachments} />
                <div className="small muted">{dt(d.created_at)}{d.due_on ? ` · 要在 ${dDate(d.due_on)} 前做完` : ''}{d.require_photo ? ' · 要拍照' : ''}</div>
                {d.status === 'acked' && d.confirm_note && <div className="pill red" style={{ whiteSpace: 'normal' }}>中方退回：{d.confirm_note}</div>}
              </div>
              <div className="row" style={{ flexShrink: 0 }}>
                {d.status === 'sent' && <button type="button" className="btn primary" onClick={() => run('已收到', `select app.ack_directive2($1,$2)`, [d.id, lateMin(d) >= ACK_MIN ? '在待办页点的收到' : null])}>收到</button>}
                {['sent', 'acked'].includes(d.status) && <button type="button" className="btn" onClick={() => setDone(d)}>做完了，填结果</button>}
              </div>
            </div>))}
        </div>)}
      {admin && (
        <div className="card todo-sec" style={{ marginBottom: 12 }}>
          <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>我下达的指令 {issued?.open.length || 0} 条没关 <Info>员工点「完成」后，这里点「确认」才关闭；做得不行就「退回」并写哪里不行。超过 4 小时没点「收到」的标红，建议直接打电话。</Info></h2>
            <div className="row"><button type="button" className="btn sm" onClick={() => setShowTpl(!showTpl)}>定期任务（{issued?.tpl.length || 0}）</button><button type="button" className="btn primary" onClick={() => setNw(true)}>＋ 给员工下指令</button></div></div>
          {showTpl && (issued?.tpl.length ? issued.tpl.map((d) => (
            <div key={d.id} className="row between todo-row" style={{ cursor: 'default' }}><div><span className="pill blue">{REPEAT[d.repeat]}</span> <b>{d.title}</b> <span className="muted small">→ {d.assignee_name}{d.require_photo ? ' · 要拍照' : ''}</span></div>
              <button type="button" className="btn sm" onClick={() => run('已停掉这个定期任务', `select app.stop_directive($1)`, [d.id])}>停掉</button></div>)) : <div className="card-b small muted">还没有定期任务。下指令时选「重复」就是定期任务。</div>)}
          {(issued?.open || []).length === 0 ? <div className="card-b small muted">没有没关的指令</div> : issued.open.map((d) => {
            const late = d.status === 'sent' && hoursSince(d.created_at) > 4;
            return (
              <div key={d.id} className="row between todo-row" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                <div className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
                  <div>{d.urgent && <span className="pill red" style={{ marginRight: 6 }}>紧急</span>}<b>{d.title}</b> <span className="muted small">→ </span><EmpLink id={d.assignee_employee_id} name={d.assignee_name} /> <span className={`pill ${late ? 'red' : ST[d.status][1]}`}>{late ? `${Math.floor(hoursSince(d.created_at))} 小时没点收到 · 打电话` : ST[d.status][0]}</span></div>
                  <div className="small muted">下达 {dt(d.created_at)}{d.ack_at ? ` · 收到 ${dt(d.ack_at)}（${Math.max(0, Math.round((new Date(d.ack_at) - new Date(d.created_at)) / 60e3))} 分钟）` : ''}{d.ack_reason ? ` · 晚收到的原因：${d.ack_reason}` : ''}{d.done_at ? ` · 完成 ${dt(d.done_at)}` : ''}{d.reject_count ? ` · 退回过 ${d.reject_count} 次` : ''}</div>
                  {d.status === 'done' && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="small">结果：{d.done_note || '（只传了照片）'}</span>{d.done_photo && <Thumb src={d.done_photo} size={44} label="完成照片" />}</div>}
                </div>
                <div className="row" style={{ flexShrink: 0 }}>
                  {d.status === 'done' && <><button type="button" className="btn primary" onClick={() => run('已确认，这条关闭', `select app.confirm_directive($1,true,null)`, [d.id])}>确认</button><button type="button" className="btn" onClick={() => setRej(d)}>退回</button></>}
                  {d.status !== 'done' && <button type="button" className="btn sm ghost" onClick={() => run('已撤销', `select app.stop_directive($1)`, [d.id])}>撤销</button>}
                </div>
              </div>); })}
        </div>)}
      {nw && <NewDirective onClose={() => setNw(false)} />}
      {done && <DoneModal d={done} onClose={() => setDone(null)} />}
      {rej && <RejectModal d={rej} onClose={() => setRej(null)} />}
    </>
  );
}

function NewDirective({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data: emps } = useData(() => q(`select id, short_name, emp_no, department from app.employees where org_id = $1 and active order by emp_no nulls last, short_name`, [org]), [org]);
  const [f, setF] = useState({ title: '', body: '', assignee: [], urgent: false, require_photo: false, due_on: '', repeat: '', attachments: [] });
  const ok = f.title.trim() && f.assignee.length;
  const go = async () => { try { for (const a of f.assignee) await call(role, `select app.issue_directive($1,$2)`, [org, JSON.stringify({ ...f, assignee: a })]); toast(`已下达给 ${f.assignee.length} 个人`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const tog = (id) => setF((x) => ({ ...x, assignee: x.assignee.includes(id) ? x.assignee.filter((y) => y !== id) : [...x.assignee, id] }));
  return (
    <Modal title="给员工下指令" wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">还差：{[!f.title.trim() && '做什么', !f.assignee.length && '给谁'].filter(Boolean).join('、')}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>下达</button></>}>
      <div className="stack">
        <FRow label="做什么" req><input className="in" style={{ width: '100%' }} autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="一句话，例如 今天下班前把 A 架盘点一遍" /></FRow>
        <FRow label="说明"><textarea className="in" rows={2} style={{ width: '100%' }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="要注意什么、做到什么算完成" /></FRow>
        <FRow label="附件"><Attach value={f.attachments} onChange={(v) => setF({ ...f, attachments: v })} /></FRow>
        <FRow label="给谁" req><div className="chips">{(emps || []).map((e) => <button type="button" key={e.id} className={`chip ${f.assignee.includes(e.id) ? 'on' : ''}`} onClick={() => tog(e.id)}>{e.emp_no ? `${e.emp_no} ` : ''}{e.short_name}</button>)}</div></FRow>
        <FRow label="紧急程度"><div className="chips"><button type="button" className={`chip ${!f.urgent ? 'on' : ''}`} onClick={() => setF({ ...f, urgent: false })}>普通</button><button type="button" className={`chip ${f.urgent ? 'on' : ''}`} onClick={() => setF({ ...f, urgent: true })}>紧急</button></div></FRow>
        <FRow label="结果要求"><div className="chips"><button type="button" className={`chip ${!f.require_photo ? 'on' : ''}`} onClick={() => setF({ ...f, require_photo: false })}>文字或照片都行</button><button type="button" className={`chip ${f.require_photo ? 'on' : ''}`} onClick={() => setF({ ...f, require_photo: true })}>必须拍照</button></div></FRow>
        <FRow label="什么时候前做完"><DatePicker value={f.due_on} onChange={(v) => setF({ ...f, due_on: v })} /></FRow>
        <FRow label="重复"><div className="chips">{[['', '只这一次'], ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月']].map(([k, l]) => <button type="button" key={k} className={`chip ${f.repeat === k ? 'on' : ''}`} onClick={() => setF({ ...f, repeat: k })}>{l}</button>)}</div></FRow>
        {f.repeat && <div className="hint">定期任务：系统{REPEAT[f.repeat]}自动给他生成一条（每天的周日不生成），每条都要他点收到、完成，你确认。</div>}
      </div>
    </Modal>
  );
}
function DoneModal({ d, onClose }) {
  const { role, toast, refresh } = useApp();
  const [note, setNote] = useState(''); const [photo, setPhoto] = useState('');
  const ok = (note.trim() || photo) && (!d.require_photo || photo);
  const go = async () => { try { await call(role, `select app.complete_directive($1,$2,$3)`, [d.id, note || null, photo || null]); toast('已交，等中方确认'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`做完了：${d.title}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">{d.require_photo && !photo ? '这条要求拍照' : '填结果（文字或照片）'}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>完成</button></>}>
      <div className="stack">
        <FRow label="结果" req={!d.require_photo}><textarea className="in" rows={3} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="做了什么、结果怎么样" /></FRow>
        <FRow label="照片" req={d.require_photo}><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={photo} onChange={setPhoto} label="拍结果" /></div></FRow>
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
