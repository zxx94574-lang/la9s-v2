// 头像 =「我的」（Frank 11-28，第二版）：右上角点头像打开。只管自己的账号和个性化。
//   顶部：大头像（点一下 = 放大看 + 「更换头像」→ 拍照 / 相册 → 像微信一样拖动、缩放裁剪 → 确定）+ 名字 · 工号 · 岗位
//   两块卡片并排：我的资料（只看） | 个性化（语言、首页先看、提醒声音）
//   切换账号（只有中方）：一个下拉框，点开才出选项（可搜，按权限从大到小）；旁边「账号管理 ›」
//   底部：系统设置 ›（只有中方）· 退出登录
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { q, SERVER, serverMe, customerSession, setCustomerSession } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, Drawer, Modal, Choice } from './ui.jsx';
import { ROLES } from '../lib/domain.js';
import { t, LANGS } from '../lib/i18n.js';
import { fmtPhone } from '../lib/phone.js';
import { dDate } from '../lib/format.js';
import { getViewAs, setViewAs, rankOf } from '../lib/viewAs.js';
import { staffOptions, optLabel } from '../lib/staffOptions.js';

export function useViewAs() {
  const [v, setV] = useState(getViewAs);
  useEffect(() => { const f = () => setV(getViewAs()); window.addEventListener('la9s:viewas', f); const iv = setInterval(f, 15e3); return () => { window.removeEventListener('la9s:viewas', f); clearInterval(iv); }; }, []);
  return v;
}
export const currentUid = (role) => (role === 'boss' && customerSession()?.user_id) || USERS[role];
const avKey = (uid) => `la9s.avatar.${uid}`;
export function getAvatar(uid) { try { return localStorage.getItem(avKey(uid)) || ''; } catch { return ''; } }
function putAvatar(uid, d) { try { if (d) localStorage.setItem(avKey(uid), d); else localStorage.removeItem(avKey(uid)); } catch { /* 存不下 */ } window.dispatchEvent(new Event('la9s:avatar')); }

const ME_SQL = `
select m.roles, e.emp_no, e.full_name, e.short_name, e.department, e.position, e.email, e.phone, e.joined_on::text as joined, e.city,
  c.name as cust_name, c.code as cust_code
from app.members m
left join app.employees e on e.id = m.employee_id
left join app.customer_accounts a on a.user_id = m.user_id
left join app.customers c on c.id = a.customer_id
where m.user_id = $1 limit 1`;
export function useMe(uid) {
  const { data } = useData(() => (uid ? q(ME_SQL, [uid]) : Promise.resolve([])), [uid]);
  return data?.[0] || null;
}
export const meName = (me, role) => me?.short_name || me?.full_name || me?.cust_name || t(ROLES[role]?.label || '');

export function Avatar({ uid, name, size = 32, src, onClick }) {
  const s = src ?? getAvatar(uid);
  const ch = String(name || '?').trim().slice(0, 1).toUpperCase();
  const st = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  const inner = s ? <img className="av" src={s} alt={name} style={st} /> : <span className="av av-t" style={st} aria-label={name}>{ch}</span>;
  return onClick ? <button type="button" className="av-btn" onClick={onClick} title="看大图 / 更换头像">{inner}</button> : inner;
}

// ── 账号清单（「我的」下拉和「账号管理」页共用）：权限从大到小 ──
export async function loadAccounts(org) {
  const staff = await q(`select m.user_id, m.active, m.roles::text[] as roles, e.id as emp_id, e.short_name, e.full_name, e.emp_no, e.department, e.position, e.active as emp_active
    from app.members m left join app.employees e on e.id = m.employee_id where m.org_id = $1 and m.employee_id is not null`, [org]);
  const cust = await q(`select a.user_id, a.customer_id, a.login, a.status, a.last_login_at, c.name, c.code from app.customer_accounts a join app.customers c on c.id = a.customer_id where a.org_id = $1 order by c.name`, [org]).catch(() => []);
  const demoUids = new Set(Object.values(USERS));
  const s = staff.filter((x) => ROLES[x.roles?.[0]]).map((x) => {
    const role = x.roles[0];
    return { key: x.user_id, kind: role === 'admin' || role.startsWith('cn_') ? 'cn' : 'staff', role, roles: x.roles, emp_id: x.emp_id, name: x.short_name || x.full_name || t(ROLES[role].label), emp_no: x.emp_no || '', dept: x.department || '', active: x.active !== false && x.emp_active !== false, switchable: SERVER ? false : demoUids.has(x.user_id), sub: [x.emp_no, t(ROLES[role].label)].filter(Boolean).join(' · ') };
  });
  const c = cust.map((x) => ({ key: x.user_id, kind: 'customer', role: 'boss', name: x.name, code: x.code, login: x.login, customer_id: x.customer_id, uid: x.user_id, active: x.status !== 'frozen', last: x.last_login_at, switchable: !SERVER, sub: `${x.code || ''} · ${t(ROLES.boss.label)}${x.status === 'frozen' ? ' · 已冻结' : ''}` }));
  const demo = SERVER ? [] : [{ key: 'demo-boss', kind: 'customer', role: 'boss', name: '客户老板（演示）', sub: t(ROLES.boss.label), switchable: true, active: true }, { key: 'demo-clerk', kind: 'shop', role: 'clerk', name: '门店店员（演示）', sub: t(ROLES.clerk.label), switchable: true, active: true }];
  return [...s, ...c, ...demo].sort((a, b) => rankOf(a.role) - rankOf(b.role) || a.name.localeCompare(b.name));
}
// 切过去：默认只看；切回中方 = 回到自己
export function useSwitchAccount() {
  const { setRole, go, toast } = useApp();
  return useCallback((a) => {
    if (a.role === 'admin') { setViewAs(null); setCustomerSession(null); setRole('admin', true); toast('已切回你自己'); go('dashboard'); return; }
    setViewAs({ kind: a.kind, role: a.role, name: a.name, sub: a.sub, key: a.key, unlockUntil: 0 });
    if (a.uid) { setCustomerSession({ user_id: a.uid, customer_id: a.customer_id, login: a.login }, false); setRole('boss', true); go('p/shop'); }
    else { setCustomerSession(null); setRole(a.role, true); go(a.kind === 'customer' || a.kind === 'shop' ? (a.role === 'clerk' ? 'p/pos' : 'p/shop') : 'todo'); }
    toast(`正在以「${a.name}」的身份查看 · 只看`);
  }, [setRole, go, toast]);
}

// ── 头像：放大看 → 更换 → 裁剪（拖动 / 滚轮或双指缩放 / 滑杆）→ 确定 ──
function Cropper({ src, onCancel, onDone }) {
  const V = 280;
  const [img, setImg] = useState(null);
  const [st, setSt] = useState({ s: 1, x: 0, y: 0, min: 1 });
  const pts = useRef(new Map()); const last = useRef(null);
  useEffect(() => { const i = new Image(); i.onload = () => { const min = Math.max(V / i.width, V / i.height); setImg(i); setSt({ s: min, min, x: (V - i.width * min) / 2, y: (V - i.height * min) / 2 }); }; i.src = src; }, [src]);
  const clamp = (n, w, h) => ({ ...n, x: Math.min(0, Math.max(V - w * n.s, n.x)), y: Math.min(0, Math.max(V - h * n.s, n.y)) });
  const zoomTo = useCallback((s, cx = V / 2, cy = V / 2) => setSt((o) => { if (!img) return o; const ns = Math.max(o.min, Math.min(o.min * 5, s)); const k = ns / o.s; return clamp({ ...o, s: ns, x: cx - (cx - o.x) * k, y: cy - (cy - o.y) * k }, img.width, img.height); }), [img]);
  const down = (e) => { e.currentTarget.setPointerCapture(e.pointerId); pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); last.current = null; };
  const move = (e) => {
    if (!pts.current.has(e.pointerId) || !img) return;
    const prev = pts.current.get(e.pointerId); pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 1) setSt((o) => clamp({ ...o, x: o.x + e.clientX - prev.x, y: o.y + e.clientY - prev.y }, img.width, img.height));
    else if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (last.current) { const r = e.currentTarget.getBoundingClientRect(); zoomTo(st.s * (d / last.current), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); }
      last.current = d;
    }
  };
  const up = (e) => { pts.current.delete(e.pointerId); last.current = null; };
  const wheel = (e) => { const r = e.currentTarget.getBoundingClientRect(); zoomTo(st.s * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top); };
  const done = () => {
    const n = 256; const c = document.createElement('canvas'); c.width = n; c.height = n;
    c.getContext('2d').drawImage(img, -st.x / st.s, -st.y / st.s, V / st.s, V / st.s, 0, 0, n, n);
    onDone(c.toDataURL('image/jpeg', 0.88));
  };
  return (
    <div className="crop">
      <div className="crop-box" style={{ width: V, height: V }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
        {img && <img src={src} alt="" draggable={false} style={{ width: img.width * st.s, height: img.height * st.s, transform: `translate(${st.x}px, ${st.y}px)` }} />}
        <div className="crop-mask" />
      </div>
      <div className="crop-zoom"><span>－</span><input type="range" min={0} max={100} value={img ? Math.round(((st.s / st.min) - 1) / 4 * 100) : 0} onChange={(e) => zoomTo(st.min * (1 + Number(e.target.value) / 100 * 4))} aria-label="缩放" /><span>＋</span></div>
      <div className="small muted" style={{ textAlign: 'center' }}>拖动调位置，滚轮 / 双指 / 滑杆调大小</div>
      <div className="row crop-act"><button type="button" className="btn" onClick={onCancel}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={!img} onClick={done}>确定</button></div>
    </div>);
}
function AvatarViewer({ uid, name, editable, onClose }) {
  const { toast } = useApp();
  const [src, setSrc] = useState(() => getAvatar(uid));
  const [raw, setRaw] = useState(null); const [pick, setPick] = useState(false);
  const cam = useRef(null); const lib = useRef(null);
  const read = (e) => { const f = e.target.files?.[0]; e.target.value = ''; setPick(false); if (!f) return; const r = new FileReader(); r.onload = () => setRaw(r.result); r.onerror = () => toast('这张图读不出来，换一张试试', 'err'); r.readAsDataURL(f); };
  return createPortal(
    <Modal center title={raw ? '调整头像' : name} onClose={onClose}>
      {raw ? <Cropper src={raw} onCancel={() => setRaw(null)} onDone={(d) => { putAvatar(uid, d); setSrc(d); setRaw(null); toast('头像已换'); }} /> : (
        <div className="av-view">
          {src ? <img src={src} alt={name} className="av-big" /> : <span className="av-big av-t">{String(name || '?').slice(0, 1).toUpperCase()}</span>}
          {editable && (pick
            ? <div className="row" style={{ gap: 8, justifyContent: 'center' }}><button type="button" className="btn" onClick={() => cam.current?.click()}>拍照</button><button type="button" className="btn" onClick={() => lib.current?.click()}>从相册选</button><button type="button" className="btn ghost" onClick={() => setPick(false)}>取消</button></div>
            : <div className="row" style={{ gap: 8, justifyContent: 'center' }}><button type="button" className="btn primary" onClick={() => setPick(true)}>更换头像</button>{src && <button type="button" className="btn ghost" onClick={() => { putAvatar(uid, ''); setSrc(''); }}>去掉头像</button>}</div>)}
          <input ref={cam} type="file" accept="image/*" capture="user" hidden onChange={read} />
          <input ref={lib} type="file" accept="image/*" hidden onChange={read} />
        </div>)}
    </Modal>, document.body);
}

function AccountSwitch({ onPicked }) {
  const { org, go } = useApp();
  const va = useViewAs();
  const switchTo = useSwitchAccount();
  const { data } = useData(() => loadAccounts(org), [org]);
  const list = (data || []).filter((a) => a.switchable && a.active);
  const cur = va ? va.key : list.find((a) => a.role === 'admin')?.key;
  return (
    <div className="me-switch">
      <div className="me-card-h">切换账号 <span className="muted small">默认只看</span><span className="grow" /><button type="button" className="linkbtn small" onClick={() => { onPicked(); go('accounts'); }}>账号管理 ›</button></div>
      <Choice flat={false} value={cur || ''} placeholder={data ? '选一个账号…' : '加载中…'}
        options={list.map((a) => [a.key, a.name, a.sub])}
        renderOpt={(o) => { const a = list.find((x) => x.key === o.v); return <span className="acc-opt"><Avatar uid={a?.uid || o.v} name={o.l} size={22} />{o.l}</span>; }}
        onChange={(k) => { const a = list.find((x) => x.key === k); if (a && k !== cur) { switchTo(a); onPicked(); } }} />
    </div>);
}

export default function MePanel({ onClose, onSystem, lang, changeLang, homeOpts, homePref, setHomePref }) {
  const { org, role, go, setRole } = useApp();
  const va = useViewAs();
  const uid = currentUid(role);
  const me = useMe(uid);
  const so = staffOptions(useData(() => q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org]), [org]).data?.[0]?.value);
  const [view, setView] = useState(false);
  const [, setAvTick] = useState(0);
  useEffect(() => { const f = () => setAvTick((x) => x + 1); window.addEventListener('la9s:avatar', f); return () => window.removeEventListener('la9s:avatar', f); }, []);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('la9s.sound') !== 'off'; } catch { return true; } });
  const name = meName(me, role);
  const isAdminSelf = role === 'admin' && !va;
  const canSwitch = !SERVER && (isAdminSelf || !!va);
  const myRoles = SERVER ? (serverMe()?.roles || []).filter((r) => ROLES[r]) : [];
  const isCust = role === 'boss' || role === 'clerk';
  const kv = isCust
    ? [['客户编码', me?.cust_code || '—'], ['客户', me?.cust_name || name]]
    : [['工号', me?.emp_no || <span className="muted">还没编（员工档案里填）</span>], ['岗位', t(ROLES[role]?.label || '')], ['部门', me?.department ? optLabel(so.departments, me.department) : '—'], ['职位', me?.position ? optLabel(so.positions, me.position) : '—'],
      ['负责城市', me?.city || '—'], ['入职日期', me?.joined ? dDate(me.joined) : '—'], ['电话', me?.phone ? fmtPhone(me.phone) : '—'], ['邮箱', me?.email || (SERVER ? serverMe()?.email : '') || '—']];
  return (
    <Drawer title="我的" onClose={onClose}>
      <div className="me">
        <div className="me-head">
          <Avatar uid={uid} name={name} size={76} onClick={() => setView(true)} />
          <div className="me-id"><b>{name}</b>
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{!isCust && me?.emp_no && <span className="pill gray">{me.emp_no}</span>}<span className="pill blue">{t(ROLES[role]?.label || '')}</span>{me?.department && <span className="muted small">{optLabel(so.departments, me.department)}</span>}</span>
            {va && <span className="pill amber sm-pill">你正以这个身份查看 · 只看</span>}</div>
          {canSwitch && <AccountSwitch onPicked={onClose} />}
        </div>
        <div className="me-grid">
          <div className="me-card">
            <div className="me-card-h">我的资料 <span className="muted small">要改找中方</span></div>
            <div className="me-kv">{kv.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
          </div>
          <div className="me-card">
            <div className="me-card-h">个性化 <span className="muted small">只影响你自己</span></div>
            <div className="me-line"><span>语言</span><div className="seg sm">{LANGS.map(([k, l]) => <button type="button" key={k} className={lang === k ? 'on' : ''} onClick={() => changeLang(k)}>{l}</button>)}</div></div>
            {homeOpts.length > 1 && <div className="me-line"><span>首页先看</span><Choice flat={false} size="sm" value={homePref} options={homeOpts} onChange={setHomePref} /></div>}
            <div className="me-line"><span>提醒声音</span><div className="seg sm">{[[true, '开'], [false, '关']].map(([v, l]) => <button type="button" key={l} className={sound === v ? 'on' : ''} onClick={() => { setSound(v); try { localStorage.setItem('la9s.sound', v ? 'on' : 'off'); } catch { /* */ } }}>{l}</button>)}</div></div>
          </div>
          {myRoles.length > 1 && <div className="me-card me-wide"><div className="me-card-h">我的岗位 <span className="muted small">你这个账号有几个岗位</span></div>
            <Choice flat={false} value={role} options={[...myRoles].sort((a, b) => rankOf(a) - rankOf(b)).map((r) => [r, t(ROLES[r].label)])} onChange={(r) => { setRole(r); onClose(); }} /></div>}
        </div>
        <div className="me-foot">
          {isAdminSelf && <button type="button" className="me-link" onClick={onSystem}><span>系统设置</span><small className="muted">规则 · 选项 · 布局 · 导出整库</small><span className="muted">›</span></button>}
          {!va && <button type="button" className="me-link" onClick={() => { onClose(); go('login'); }}><span>退出登录</span><small className="muted">回登录页：员工 / 客户 / 游客</small><span className="muted">›</span></button>}
        </div>
      </div>
      {view && <AvatarViewer uid={uid} name={name} editable={!va} onClose={() => setView(false)} />}
    </Drawer>);
}

// 顶上那条：正在以 X 的身份查看
export function ViewAsBar({ onUnlock, onBack, onLock, peerLock }) {
  const va = useViewAs();
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick((x) => x + 1), 20e3); return () => clearInterval(iv); }, []);
  if (!va) return null;
  const unlocked = (va.unlockUntil || 0) > Date.now();
  return (
    <div className={`viewas-bar ${unlocked ? 'open' : ''}`}>
      <span className="va-t">{unlocked ? '🔓' : '👁'} 正在以 <b>{va.name}</b>（{va.sub}）的身份查看 · {unlocked ? <b>已解锁：改动记在你（中方）名下</b> : '只看'}{peerLock && <span className="pill gray sm-pill" style={{ marginLeft: 6 }}>他现在被下班锁着，你照样能看</span>}</span>
      <span className="grow" />
      {unlocked ? <button type="button" className="btn sm" onClick={onLock}>锁上</button> : <button type="button" className="btn sm" onClick={onUnlock}>🔓 解锁修改</button>}
      <button type="button" className="btn sm primary" onClick={onBack}>↩ 切回我自己</button>
    </div>);
}
