// 上班打卡 (Frank 10-31): 带定位, 不拍照. 销售看是不是在市场; 办公室 / 仓库员工看是不是在仓库地址.
// 手机打开 → 点「上班打卡 / 下班打卡」→ 浏览器给定位 → 系统找最近的工作地点, 记「在 / 不在」, 第一次上班卡超过上班时间算迟到.
// 中方: 今天谁打了卡、在不在地方; 每月汇总 (出勤天数、迟到、不在地方); 维护工作地点 (仓库 / 办公室 / 各个市场, 可以站在那里点「用我现在的位置」).
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, DatePicker, MonthPicker } from '../components/ui.jsx';
import { EmpLink } from '../components/Archives.jsx';
import Grid from '../components/Grid.jsx';
import { dt, today, friendlyError } from '../lib/format.js';

const mapUrl = (lat, lng) => `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
const MapLink = ({ lat, lng }) => (lat == null ? null : <a href={mapUrl(lat, lng)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="在地图上看">地图 ↗</a>);

const KIND = { warehouse: '仓库', office: '办公室', market: '市场' };
const hm = (v) => (v ? new Date(v).toTimeString().slice(0, 5) : '');

function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) { rej(new Error('这个浏览器不支持定位')); return; }
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => rej(new Error(e.code === 1 ? '没允许定位：手机设置里给浏览器打开定位权限' : '拿不到定位，到窗边或室外再试')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

export default function Attendance() {
  const { org, role, toast, refresh } = useApp();
  const [tab, setTab] = useState('me');
  const [day, setDay] = useState(today());
  const [month, setMonth] = useState(today().slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(null);
  const [site, setSite] = useState(null);
  const [appeal, setAppeal] = useState(null);
  const admin = role === 'admin';
  const canName = ['admin', 'manager', 'sales_manager'].includes(role);
  const { data } = useData(async () => {
    const since = new Date(); since.setMonth(since.getMonth() - 2);
    const [mine, sites, dayRows, monthRows, [st], myAp, allAp] = await Promise.all([q(Q.attendanceMine, [org, USERS[role]]), q(Q.workSites, [org]),
      admin ? q(Q.attendanceDay, [org, day]) : [], admin ? q(Q.attendanceMonth, [org, month]) : [], q(Q.attendanceSettings, [org]),
      q(Q.myAppeals, [org, USERS[role]]), admin ? q(Q.appeals, [org, since.toISOString().slice(0, 10)]) : []]);
    return { mine, sites, dayRows, monthRows, st, myAp, allAp };
  }, [org, role, day, month]);
  if (!data) return <div className="empty">加载中…</div>;
  const clock = async (kind, pos) => {
    setBusy(true); setFail(null);
    try {
      const p = pos || await locate();
      const [{ r }] = await call(role, `select app.clock($1,$2,$3,$4,$5) as r`, [org, kind, p.lat, p.lng, p.acc]);
      toast(r.new_site ? `已打卡 · 新地点（第一次来，等中方起名）${r.late ? ' · 迟到' : ''}` : r.ok ? `${kind === 'in' ? '上班' : '下班'}打卡成功 · ${r.site}（${r.distance} 米）${r.late ? ' · 迟到' : ''}` : `已打卡，但不在规定地点（最近：${r.site || '没设地点'} ${r.distance ?? ''} 米）`, r.ok ? undefined : 'err');
      refresh();
    } catch (e) { setFail(e.message); toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const todayMine = data.mine.filter((a) => dt(a.at).slice(0, 10) === today());
  const dCols = [
    { key: 'short_name', label: '员工', w: 100, render: (a) => <b><EmpLink id={a.employee_id} name={a.short_name || '—'} /></b> }, { key: 'department', label: '部门', w: 80 },
    { key: 'kind', label: '', w: 60, value: (a) => (a.kind === 'in' ? '上班' : '下班') },
    { key: 'at', label: '时间', w: 80, render: (a) => hm(a.at) },
    { key: 'site_name', label: '地点', w: 170, value: (a) => `${a.site_name || '—'}${a.distance_m != null ? ` · ${a.distance_m} 米` : ''}`,
      render: (a) => <span className="row" style={{ gap: 4 }}>{a.site_name || '—'}{a.site_named === false && <Pill tone="amber">待起名</Pill>}{a.distance_m > 0 && <span className="muted small">{a.distance_m} 米</span>}</span> },
    { key: 'ok', label: '在不在', w: 90, value: (a) => (a.ok ? '在' : '不在'), render: (a) => (a.ok ? <Pill tone="green">在</Pill> : <Pill tone="red">不在</Pill>) },
    { key: 'late', label: '迟到', w: 70, value: (a) => (a.late ? '迟到' : ''), render: (a) => a.late && <Pill tone="amber">迟到</Pill> },
    { key: 'emp_city', label: '负责城市', w: 90 },
    { key: 'usual_dist', label: '离常去点', w: 100, value: (a) => (a.usual_dist == null ? '' : `${a.usual_dist} 米`), render: (a) => (a.usual_dist == null ? <span className="muted small">—</span> : a.usual_dist > 2000 ? <Pill tone="amber">{(a.usual_dist / 1000).toFixed(1)} 公里</Pill> : `${a.usual_dist} 米`) },
    { key: 'acc', label: '定位精度', w: 90, value: (a) => (a.accuracy_m ? `±${Math.round(a.accuracy_m)} 米` : '') },
    { key: 'map', label: '', w: 60, render: (a) => <MapLink lat={a.lat} lng={a.lng} /> },
  ];
  const apCols = [
    { key: 'day', label: '日期', w: 100, value: (a) => String(a.day).slice(0, 10) },
    ...(admin ? [{ key: 'short_name', label: '员工', w: 110, render: (a) => <b><EmpLink id={a.employee_id} name={a.short_name} /></b> }] : []),
    { key: 'reason', label: '理由', w: 300 },
    { key: 'status', label: '状态', w: 100, value: (a) => ({ pending: '待处理', approved: '已批准', rejected: '不通过' })[a.status], render: (a) => <Pill tone={{ pending: 'amber', approved: 'green', rejected: 'red' }[a.status]}>{{ pending: '待处理', approved: '已批准', rejected: '不通过' }[a.status]}</Pill> },
    { key: 'decision_note', label: '中方说明', w: 200 },
    ...(admin ? [{ key: 'act', label: '', w: 170, render: (a) => a.status === 'pending' && <span className="row" style={{ gap: 4 }}>
      <button type="button" className="btn sm primary" onClick={(e) => { e.stopPropagation(); decide(a.id, true); }}>批准</button>
      <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); decide(a.id, false); }}>不通过</button></span> }] : []),
  ];
  const decide = async (id, ok) => { try { await call(role, `select app.decide_appeal($1,$2)`, [id, ok]); toast(ok ? '已批准，那天算出勤' : '已记为不通过'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const mCols = [
    { key: 'short_name', label: '员工', w: 100, render: (e) => <b><EmpLink id={e.employee_id || e.id} name={e.short_name} /></b> }, { key: 'department', label: '部门', w: 80 },
    { key: 'days', label: '出勤天数', w: 90, value: (e) => Number(e.days) }, { key: 'late', label: '迟到次数', w: 90, value: (e) => Number(e.late), render: (e) => (Number(e.late) ? <span className="amber-t2">{e.late}</span> : 0) },
    { key: 'off_site', label: '不在地点次数', w: 110, value: (e) => Number(e.off_site), render: (e) => (Number(e.off_site) ? <span className="red-t2">{e.off_site}</span> : 0) },
  ];
  const sCols = [
    { key: 'name', label: '地点', w: 200, render: (s) => <span className="row" style={{ gap: 6 }}><b>{s.name}</b>{!s.named && <Pill tone="amber">待起名</Pill>}</span> }, { key: 'kind', label: '类型', w: 80, value: (s) => KIND[s.kind] },
    { key: 'pos', label: '坐标', w: 190, value: (s) => `${Number(s.lat).toFixed(5)}, ${Number(s.lng).toFixed(5)}` }, { key: 'radius_m', label: '范围（米）', w: 90, value: (s) => s.radius_m },
    { key: 'auto', label: '来源', w: 90, value: (s) => (s.auto ? '打卡自动' : '手动') },
    { key: 'active', label: '', w: 70, value: (s) => (s.active ? '启用' : '停用') },
    { key: 'map', label: '', w: 60, render: (s) => <MapLink lat={s.lat} lng={s.lng} /> },
  ];
  const unnamed = data.sites.filter((s) => !s.named);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Pointage</div><h1>上班打卡</h1>
        <div className="sub">用手机打卡，要允许定位，不用拍照。销售看是不是在市场；办公室和仓库员工看是不是在仓库地址。上班时间 {data.st?.start_time?.slice(0, 5) || '08:30'}，晚 {data.st?.grace_min ?? 10} 分钟以上算迟到。</div></div></div>
      <div className="tabs" style={{ padding: 0 }}>{[['me', '我打卡'], ...(admin ? [['day', '今天'], ['month', '月汇总']] : []), ['appeals', admin ? `申诉${data.allAp.filter((a) => a.status === 'pending').length ? ` · ${data.allAp.filter((a) => a.status === 'pending').length} 待处理` : ''}` : '我的申诉'], ...(canName ? [['sites', `工作地点${unnamed.length ? ` · ${unnamed.length} 待起名` : ''}`]] : [])].map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'me' && (
        <div className="portal">
          <div className="card card-b stack" style={{ textAlign: 'center', gap: 14 }}>
            <div style={{ fontSize: 34, fontWeight: 800 }}>{new Date().toTimeString().slice(0, 5)}</div>
            <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
              <button type="button" className="btn primary lg" style={{ minWidth: 140, minHeight: 56, fontSize: 18 }} disabled={busy} onClick={() => clock('in')}>上班打卡</button>
              <button type="button" className="btn lg" style={{ minWidth: 140, minHeight: 56, fontSize: 18 }} disabled={busy} onClick={() => clock('out')}>下班打卡</button>
            </div>
            {busy && <div className="muted small">正在拿定位…</div>}
            {fail && <div className="banner warn">{fail}</div>}
            {fail && data.sites.length > 0 && <div className="small muted">演示链接里浏览器不给定位。演示用：
              {data.sites.slice(0, 3).map((s) => <button type="button" key={s.id} className="linkbtn" onClick={() => clock('in', { lat: Number(s.lat) + 0.0002, lng: Number(s.lng), acc: 25 })}>假装在 {s.name}</button>)}</div>}
            <div className="stack" style={{ gap: 6, textAlign: 'left' }}>
              {todayMine.length === 0 && <div className="muted small" style={{ textAlign: 'center' }}>今天还没打卡</div>}
              {todayMine.map((a) => <div key={a.id} className="row" style={{ gap: 8 }}><b>{a.kind === 'in' ? '上班' : '下班'}</b><span>{hm(a.at)}</span><span className="muted small">{a.site_name} {a.distance_m != null ? `${a.distance_m} 米` : ''}</span>
                <span className="grow" />{a.ok ? <Pill tone="green">在地点</Pill> : <Pill tone="red">不在地点</Pill>}{a.late && <Pill tone="amber">迟到</Pill>}</div>)}
            </div>
          </div>
        </div>)}
      {tab === 'day' && <div className="card"><Grid id="att-day" table="attendance" columns={dCols} rows={data.dayRows} empty="这一天没人打卡" tools={<DatePicker value={day} onChange={setDay} />} /></div>}
      {tab === 'month' && <div className="card"><Grid id="att-month" columns={mCols} rows={data.monthRows} tools={<MonthPicker value={month} onChange={setMonth} label="月份" />} /></div>}
      {tab === 'appeals' && <div className="card">
        {!admin && <div className="row" style={{ padding: '10px 14px', gap: 10 }}><span className="small muted">哪天忘了打卡、迟到有原因，写清楚理由；中方批准后那天算出勤。</span><span className="grow" /><button type="button" className="btn sm primary" onClick={() => setAppeal({})}>＋ 申诉某一天</button></div>}
        <Grid id="att-appeals" columns={apCols} rows={admin ? data.allAp : data.myAp} empty={admin ? '最近两个月没有申诉' : '没有申诉记录'} /></div>}
      {tab === 'sites' && <div className="card">
        {unnamed.length > 0 && <div className="banner info small" style={{ margin: 10 }}>有 {unnamed.length} 个销售打卡自动记下的新地点等你起名。起一次名，以后落在 {data.st?.cluster_m ?? 200} 米内的打卡都自动叫这个名字。</div>}
        <Grid id="att-sites2" table="sites" columns={sCols} rows={data.sites} onRowClick={(s) => setSite(s)} empty="还没设工作地点"
        tools={<>{admin && <button type="button" className="btn sm primary" onClick={() => setSite({})}>＋ 新地点</button>}{admin && <button type="button" className="btn sm" onClick={() => setSite('rules')}>打卡规则</button>}</>} /></div>}
      {site && site !== 'rules' && (admin ? <SiteModal s={site} onClose={() => setSite(null)} /> : <NameModal s={site} onClose={() => setSite(null)} />)}
      {appeal && <AppealModal onClose={() => setAppeal(null)} />}
      {site === 'rules' && <RulesModal st={data.st} onClose={() => setSite(null)} />}
    </>
  );
}

function SiteModal({ s, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ name: s.name || '', kind: s.kind || 'market', lat: s.lat != null ? String(s.lat) : '', lng: s.lng != null ? String(s.lng) : '', radius: String(s.radius_m || 150), active: s.active !== false });
  const here = async () => { try { const p = await locate(); setF((x) => ({ ...x, lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) })); toast(`已取当前位置（±${Math.round(p.acc)} 米）`); } catch (e) { toast(e.message, 'err'); } };
  const go = async () => { try {
    await call(role, `select app.upsert_site($1,$2,$3,$4,$5,$6,$7,$8)`, [org, s.id || null, f.name, f.kind, Number(f.lat), Number(f.lng), Number(f.radius), f.active]);
    if (s.named === false) await call(role, `select app.name_site($1,$2)`, [s.id, f.name]);
    toast('已保存'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={s.id ? `地点 · ${s.name}` : '新工作地点'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!f.name.trim() || !f.lat || !f.lng} onClick={go}>保存</button></>}>
      <div className="stack">
        {s.named === false && <div className="banner info small">这是销售打卡自动记下的地点，改个名字保存就行；坐标是第一次打卡的位置。</div>}
        <div className="field req"><label>名字</label><input className="in" autoFocus={s.named === false} value={f.name} placeholder="例：LA 仓 / Adjamé Roxy 市场" onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label>类型（销售只认市场，其他人只认仓库 / 办公室）</label><div className="seg">{Object.entries(KIND).map(([k, l]) => <button type="button" key={k} className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>{l}</button>)}</div></div>
        <div className="row" style={{ gap: 6 }}><input className="in" placeholder="纬度" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /><input className="in" placeholder="经度" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} />
          <button type="button" className="btn sm" onClick={here}>⌖ 用我现在的位置</button></div>
        <div className="hint">站在仓库或市场里点「用我现在的位置」最准；也可以从谷歌地图复制坐标粘进来。</div>
        <div className="field"><label>范围（米）· 市场一般 300，仓库 100–150</label><div className="chips">{['100', '150', '300', '500'].map((r) => <button type="button" key={r} className={`chip ${f.radius === r ? 'on' : ''}`} onClick={() => setF({ ...f, radius: r })}>{r}</button>)}</div></div>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />启用</label>
      </div>
    </Modal>
  );
}

function RulesModal({ st, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ start_time: st?.start_time?.slice(0, 5) || '08:30', end_time: st?.end_time?.slice(0, 5) || '18:00', grace_min: String(st?.grace_min ?? 10), late_absent_min: String(st?.late_absent_min ?? 120), cluster_m: String(st?.cluster_m ?? 200) });
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') });
  const go = async () => { try { await call(role, `select app.set_attendance_rules($1,$2)`, [org, JSON.stringify(f)]); toast('已保存'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="打卡规则（随时可调，立即生效）" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={go}>保存</button></>}>
      <div className="grid2">
        <div className="field"><label>上班</label><input type="time" className="in" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></div>
        <div className="field"><label>下班</label><input type="time" className="in" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} /></div>
        <div className="field"><label>晚几分钟内不算迟到</label><input className="in" inputMode="numeric" value={f.grace_min} onChange={num('grace_min')} /></div>
        <div className="field"><label>迟到超过几分钟按旷工（当天不算出勤）</label><input className="in" inputMode="numeric" value={f.late_absent_min} onChange={num('late_absent_min')} /></div>
        <div className="field"><label>市场打卡多少米内算同一个地点</label><input className="in" inputMode="numeric" value={f.cluster_m} onChange={num('cluster_m')} /></div>
      </div>
      <div className="hint">工资的实到工作日 = 当月有上班打卡的天（迟到超过上面分钟数的那天不算）+ 批准的申诉天。</div>
    </Modal>
  );
}

// 主管 / 销售主管只能起名, 不能改坐标
function NameModal({ s, onClose }) {
  const { role, toast, refresh } = useApp();
  const [name, setName] = useState(s.named ? s.name : '');
  const go = async () => { try { await call(role, `select app.name_site($1,$2)`, [s.id, name]); toast('已起名'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="给地点起名" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!name.trim()} onClick={go}>保存</button></>}>
      <div className="stack"><div className="field req"><label>名字</label><input className="in" autoFocus value={name} placeholder="例：Adjamé Roxy 市场" onChange={(e) => setName(e.target.value)} /></div>
        <div className="small muted">坐标 {Number(s.lat).toFixed(5)}, {Number(s.lng).toFixed(5)} · <MapLink lat={s.lat} lng={s.lng} /></div></div>
    </Modal>
  );
}

function AppealModal({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [day, setDay] = useState(today());
  const [reason, setReason] = useState('');
  const go = async () => { try { await call(role, `select app.appeal_attendance($1,$2,$3)`, [org, day, reason]); toast('已提交，等中方处理'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="申诉某一天" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!reason.trim()} onClick={go}>提交</button></>}>
      <div className="stack">
        <div className="field req"><label>哪一天</label><DatePicker value={day} onChange={setDay} /></div>
        <div className="field req"><label>理由（写清楚，中方看了才好批）</label><textarea className="in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：早上先去 Diallo 店里送货，到市场晚了" /></div>
      </div>
    </Modal>
  );
}
