// 226 / 243 (Frank 11-11): 员工月打卡日历 —— 一眼看一个月; 绿 正常 / 黄 迟到 / 红 没打卡·异常 / 灰 休息·还没到·入职前
// 点某一天看当天明细 (几点上班下班、在哪), 有异议就在那一天直接申诉; 中方上面选员工, 还能给每个人设排班
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, Modal, FRow, Info } from './ui.jsx';
import { dDate, today, friendlyError, ymd } from '../lib/format.js';

export const DEFAULT_SCHEDULE = { 1: 'full', 2: 'full', 3: 'full', 4: 'full', 5: 'full', 6: 'am', 0: 'off' };
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const SHIFT = { full: '全天', am: '上午', off: '休息' };
const TZ = 'Africa/Abidjan';
const localDay = (v) => new Date(v).toLocaleDateString('en-CA', { timeZone: TZ });
const localHM = (v) => new Date(v).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

// 一天的判定: 颜色 + 一句话
export function dayStatus({ day, sched, punches, appeal, joined, resigned, st }) {
  const td = today();
  const shift = sched[new Date(day + 'T12:00:00').getDay()] || 'off';
  if (joined && day < joined) return { tone: 'gray', text: '入职前' };
  if (resigned && day > resigned) return { tone: 'gray', text: '已离职' };
  if (shift === 'off') return punches.length ? { tone: 'green', text: '休息日来上班' } : { tone: 'gray', text: '休息' };
  if (day > td) return { tone: 'gray', text: SHIFT[shift] };
  const ins = punches.filter((p) => p.kind === 'in');
  if (appeal?.status === 'approved') return { tone: 'green', text: '申诉已批准，算出勤' };
  if (!ins.length) {
    if (appeal?.status === 'pending') return { tone: 'amber', text: '没打卡 · 申诉中' };
    if (day === td) return { tone: 'amber', text: '今天还没打卡' };
    return { tone: 'red', text: appeal?.status === 'rejected' ? '没打卡 · 申诉被驳回' : '没打卡' };
  }
  const first = ins[ins.length - 1] && ins.reduce((a, b) => (new Date(a.at) < new Date(b.at) ? a : b));
  const lateBy = mins(localHM(first.at)) - mins(st.start_time);
  if (!first.ok) return { tone: 'red', text: `打卡地点不对（${localHM(first.at)}）${appeal?.status === 'pending' ? ' · 申诉中' : ''}` };
  if (lateBy > Number(st.late_absent_min ?? 120)) return { tone: 'red', text: `迟到 ${lateBy} 分钟，按缺勤${appeal?.status === 'pending' ? ' · 申诉中' : ''}` };
  if (lateBy > Number(st.grace_min ?? 10)) return { tone: 'amber', text: `迟到 ${lateBy} 分钟（${localHM(first.at)}）${appeal?.status === 'pending' ? ' · 申诉中' : ''}` };
  return { tone: 'green', text: `正常（${localHM(first.at)}）` };
}

export default function AttCalendar({ employeeId: fixed, pick = false, month: m0, compact }) {
  const { org, role, toast, refresh } = useApp();
  const admin = role === 'admin';
  const [month, setMonth] = useState(m0 || today().slice(0, 7));
  const [emp, setEmp] = useState(fixed || null);
  const [sel, setSel] = useState(null);
  const [appeal, setAppeal] = useState(null);
  const [editSched, setEditSched] = useState(false);
  const { data } = useData(async () => {
    const [mine] = await q(`select m.employee_id from app.members m where m.org_id = $1 and m.user_id = $2`, [org, USERS[role]]);
    const myId = mine?.employee_id || null;
    const id = emp || fixed || myId;
    const [emps, [st]] = await Promise.all([
      pick && ['admin', 'manager', 'sales_manager'].includes(role) ? q(`select id, short_name, full_name, emp_no, department from app.employees where org_id = $1 and active order by emp_no nulls last, short_name`, [org]) : [],
      q(`select start_time::text, end_time::text, grace_min, late_absent_min, half_day_end::text from app.attendance_settings where org_id = $1`, [org])]);
    if (!id) return { myId, id: null, emps, st: st || {} };
    const [[e], punches, appeals] = await Promise.all([
      q(`select id, short_name, full_name, joined_on, resigned_on, work_schedule from app.employees where id = $1`, [id]),
      q(`select a.kind, a.at, a.ok, a.late, a.distance_m, a.lat, a.lng, w.name as site from app.attendance a left join app.work_sites w on w.id = a.site_id
         where a.org_id = $1 and a.employee_id = $2 and a.at >= ($3 || '-01')::date - 1 and a.at < (($3 || '-01')::date + interval '1 month' + interval '1 day') order by a.at`, [org, id, month]),
      q(`select day, status, reason, decision_note from app.attendance_appeals where org_id = $1 and employee_id = $2 and day >= ($3 || '-01')::date and day < (($3 || '-01')::date + interval '1 month')`, [org, id, month])]);
    return { myId, id, e, punches, appeals, emps, st: st || { start_time: '09:00', grace_min: 10, late_absent_min: 120 } };
  }, [org, role, month, emp, fixed]);
  if (!data) return <div className="empty">加载中…</div>;
  const isMe = data.id && data.id === data.myId;
  const sched = { ...DEFAULT_SCHEDULE, ...(data.e?.work_schedule || {}) };
  const [y, mo] = month.split('-').map(Number);
  const n = new Date(y, mo, 0).getDate();
  const days = Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const info = data.id ? Object.fromEntries(days.map((d) => {
    const punches = data.punches.filter((p) => localDay(p.at) === d);
    const ap = data.appeals.find((a) => dDate(a.day) === d);
    return [d, { punches, appeal: ap, ...dayStatus({ day: d, sched, punches, appeal: ap, joined: dDate(data.e.joined_on), resigned: dDate(data.e.resigned_on), st: data.st }) }];
  })) : {};
  const count = (t) => days.filter((d) => info[d]?.tone === t).length;
  const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7;      // 周一开头
  const shift = (k) => { const d = new Date(y, mo - 1 + k, 1); setMonth(ymd(d).slice(0, 7)); setSel(null); };
  const cur = sel && info[sel];
  return (
    <div className="attcal">
      {pick && data.emps.length > 0 && (
        <div className="chips" style={{ marginBottom: 10 }}>{data.emps.map((e) => <button type="button" key={e.id} className={`chip ${data.id === e.id ? 'on' : ''}`} onClick={() => { setEmp(e.id); setSel(null); }}>{e.emp_no ? `${e.emp_no} ` : ''}{e.short_name}</button>)}</div>)}
      {!data.id ? <div className="empty">{pick ? '点上面的员工看他的打卡日历' : '这个账号没有绑定员工档案，没有打卡日历'}</div> : (
        <>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <div className="row" style={{ gap: 6 }}><button type="button" className="btn sm" onClick={() => shift(-1)}>‹</button><b style={{ fontSize: 16, minWidth: 96, textAlign: 'center' }}>{y} 年 {mo} 月</b><button type="button" className="btn sm" onClick={() => shift(1)}>›</button>
              {!compact && <b style={{ marginLeft: 8 }}>{data.e.short_name}</b>}</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="pill green">正常 {count('green')}</span><span className="pill amber">迟到 / 待处理 {count('amber')}</span><span className="pill red">没打卡 / 异常 {count('red')}</span>
              <Info>上班 {data.st.start_time?.slice(0, 5)}，迟到超过 {data.st.grace_min} 分钟标黄，超过 {data.st.late_absent_min} 分钟按缺勤标红。排班：{[1, 2, 3, 4, 5, 6, 0].map((k) => `${WD[k]}${SHIFT[sched[k]]}`).join('、')}。午休 1 小时不打卡。</Info>
              {admin && <button type="button" className="btn sm" onClick={() => setEditSched(true)}>排班</button>}
            </div>
          </div>
          <div className="attgrid">
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => <div key={w} className="atthead">周{w}</div>)}
            {Array.from({ length: lead }, (_, i) => <div key={'x' + i} />)}
            {days.map((d) => (
              <button type="button" key={d} className={`attday ${info[d].tone} ${sel === d ? 'sel' : ''} ${d === today() ? 'today' : ''}`} onClick={() => setSel(d)} title={info[d].text}>
                <span className="n">{Number(d.slice(8))}</span>
                <span className="t">{info[d].punches.find((p) => p.kind === 'in') ? localHM(info[d].punches.find((p) => p.kind === 'in').at) : info[d].tone === 'gray' ? '' : '—'}</span>
              </button>))}
          </div>
          {cur && (
            <div className="pd-sec" style={{ marginTop: 10 }}>
              <div className="pd-h">{sel} {WD[new Date(sel + 'T12:00:00').getDay()]} <span className={`pill ${cur.tone}`}>{cur.text}</span></div>
              {cur.punches.length ? cur.punches.map((p, i) => (
                <div key={i} className="row" style={{ gap: 10, flexWrap: 'wrap' }}><b>{p.kind === 'in' ? '上班' : '下班'} {localHM(p.at)}</b><span className="small">{p.site || '新地点（待起名）'}{p.distance_m != null ? ` · ${p.distance_m} 米` : ''}</span>
                  {!p.ok && <span className="pill red">地点不对</span>}{p.lat != null && <a className="small" href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">在地图上看</a>}</div>)) : <div className="small muted">这一天没有打卡记录</div>}
              {cur.appeal && <div className="small" style={{ marginTop: 6 }}>申诉：{cur.appeal.reason} · <span className={`pill ${cur.appeal.status === 'approved' ? 'green' : cur.appeal.status === 'rejected' ? 'red' : 'amber'}`}>{{ pending: '等中方处理', approved: '已批准', rejected: '被驳回' }[cur.appeal.status]}</span>{cur.appeal.decision_note ? ` · ${cur.appeal.decision_note}` : ''}</div>}
              {isMe && !cur.appeal && ['red', 'amber'].includes(cur.tone) && sel <= today() && <div className="actbar"><button type="button" className="btn primary" onClick={() => setAppeal(sel)}>对这一天有异议，申诉</button></div>}
            </div>)}
        </>)}
      {appeal && <DayAppeal day={appeal} onClose={() => setAppeal(null)} onDone={() => { toast('已提交，等中方处理'); refresh(); setAppeal(null); }} />}
      {editSched && <SchedModal e={data.e} sched={sched} onClose={() => setEditSched(false)} />}
    </div>
  );
}

function DayAppeal({ day, onClose, onDone }) {
  const { org, role, toast } = useApp();
  const [reason, setReason] = useState('');
  const go = async () => { try { await call(role, `select app.appeal_attendance($1,$2,$3)`, [org, day, reason]); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`申诉 ${day}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!reason.trim()} onClick={go}>提交</button></>}>
      <div className="field req"><label>理由（写清楚，中方看了才好批）</label><textarea className="in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：早上先去客户店里送货，到了才打卡" /></div>
    </Modal>
  );
}

function SchedModal({ e, sched, onClose }) {
  const { role, toast, refresh } = useApp();
  const [s, setS] = useState(sched);
  const go = async (v) => { try { await call(role, `select app.set_work_schedule($1,$2)`, [e.id, v ? JSON.stringify(v) : null]); toast(v ? `${e.short_name} 的排班已保存` : `${e.short_name} 改回公司默认排班`); refresh(); onClose(); } catch (er) { toast(friendlyError(er), 'err'); } };
  return (
    <Modal title={`排班 · ${e.short_name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={() => go(null)}>用公司默认</button><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={() => go(s)}>保存</button></>}>
      <div className="stack">
        <div className="hint">公司默认：周一到周五全天、周六上午、周日休息。个别人不一样的在这里改（例：主管周五上午、周六全天；热线周六休息）。半天班上满算 1 天出勤。</div>
        {[1, 2, 3, 4, 5, 6, 0].map((k) => <FRow key={k} label={WD[k]}><div className="chips">{Object.entries(SHIFT).map(([v, l]) => <button type="button" key={v} className={`chip ${s[k] === v ? 'on' : ''}`} onClick={() => setS({ ...s, [k]: v })}>{l}</button>)}</div></FRow>)}
      </div>
    </Modal>
  );
}
