// 头像 =「我的」（Frank 11-28）：右上角点头像打开。只管自己的账号和个性化，不放系统层面的东西。
//   ① 头像（拍照 / 相册）+ 名字 · 工号 · 岗位 · 部门
//   ② 我的资料（只看）
//   ③ 个性化：语言、首页先看、提醒声音
//   ④ 切换账号（只有中方）：一条列表，可搜、可筛，按权限从大到小；切过去默认只看，改东西先解锁
//   ⑤ 系统设置 ›（只有中方）· 退出登录（回登录页：员工登录 / 客户登录 / 游客都在那）
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { q, SERVER, REAL, serverMe, customerSession, setCustomerSession } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, Drawer } from './ui.jsx';
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

// 一个人的资料（员工 = 员工档案；客户 = 客户档案）
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

export function Avatar({ uid, name, size = 32, src }) {
  const s = src ?? getAvatar(uid);
  const ch = String(name || '?').trim().slice(0, 1).toUpperCase();
  return s ? <img className="av" src={s} alt={name} style={{ width: size, height: size }} />
    : <span className="av av-t" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-label={name}>{ch}</span>;
}

// 头像图片缩到 192 方，存本机
function shrink(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => { const n = 192; const c = document.createElement('canvas'); c.width = n; c.height = n; const k = Math.min(img.width, img.height); c.getContext('2d').drawImage(img, (img.width - k) / 2, (img.height - k) / 2, k, k, 0, 0, n, n); res(c.toDataURL('image/jpeg', 0.85)); }; img.onerror = rej; img.src = r.result; };
    r.onerror = rej; r.readAsDataURL(file);
  });
}

function AccountList({ onPicked }) {
  const { org, setRole, go, toast } = useApp();
  const [kw, setKw] = useState(''); const [kind, setKind] = useState('all');
  const { data } = useData(async () => {
    const staff = await q(`select m.user_id, m.roles[1]::text as role, e.short_name, e.full_name, e.emp_no, e.department, e.position from app.members m left join app.employees e on e.id = m.employee_id where m.org_id = $1 and m.active and m.employee_id is not null`, [org]);
    const cust = await q(`select a.user_id, a.customer_id, a.login, a.status, c.name, c.code from app.customer_accounts a join app.customers c on c.id = a.customer_id where a.org_id = $1 order by c.name`, [org]).catch(() => []);
    const demoUids = new Set(Object.values(USERS));
    const s = staff.filter((x) => demoUids.has(x.user_id) && ROLES[x.role]).map((x) => ({ key: x.user_id, kind: 'staff', role: x.role, name: x.short_name || x.full_name || t(ROLES[x.role].label), sub: [x.emp_no, t(ROLES[x.role].label)].filter(Boolean).join(' · ') }));
    const c = cust.map((x) => ({ key: x.user_id, kind: 'customer', role: 'boss', name: x.name, sub: `${x.code || ''} · 客户老板${x.status === 'frozen' ? ' · 已冻结' : ''}`, uid: x.user_id, customer_id: x.customer_id, login: x.login }));
    const demo = [{ key: 'demo-boss', kind: 'customer', role: 'boss', name: '客户老板（演示）', sub: t(ROLES.boss.label) }, { key: 'demo-clerk', kind: 'customer', role: 'clerk', name: '门店店员（演示）', sub: t(ROLES.clerk.label) }];
    return [...s, ...c, ...demo].sort((a, b) => rankOf(a.role) - rankOf(b.role) || a.name.localeCompare(b.name));
  }, [org]);
  const va = getViewAs();
  const k = kw.trim().toLowerCase();
  const rows = (data || []).filter((a) => (kind === 'all' || a.kind === kind) && (!k || `${a.name} ${a.sub}`.toLowerCase().includes(k)));
  const pick = (a) => {
    if (a.kind === 'staff' && a.role === 'admin') { setViewAs(null); setCustomerSession(null); setRole('admin', true); toast('已切回你自己'); go('dashboard'); onPicked(); return; }
    setViewAs({ kind: a.kind, role: a.role, name: a.name, sub: a.sub, key: a.key, unlockUntil: 0 });
    if (a.uid) { setCustomerSession({ user_id: a.uid, customer_id: a.customer_id, login: a.login }, false); setRole('boss', true); go('p/shop'); }
    else { setCustomerSession(null); setRole(a.role, true); go(a.kind === 'customer' ? (a.role === 'clerk' ? 'p/pos' : 'p/shop') : 'todo'); }
    toast(`正在以「${a.name}」的身份查看 · 只看`); onPicked();
  };
  return (
    <div className="me-sec">
      <div className="me-sec-h">切换账号 <span className="muted small">切过去默认只看</span></div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input className="in" style={{ flex: 1, minWidth: 0 }} placeholder="⌕ 搜名字 / 工号 / 岗位 / 客户" value={kw} onChange={(e) => setKw(e.target.value)} />
        <div className="seg sm">{[['all', '全部'], ['staff', '员工'], ['customer', '客户']].map(([x, l]) => <button type="button" key={x} className={kind === x ? 'on' : ''} onClick={() => setKind(x)}>{l}</button>)}</div>
      </div>
      <div className="acc-list">
        {!data && <div className="muted small">加载中…</div>}
        {rows.map((a) => {
          const on = va ? va.key === a.key : a.role === 'admin';
          return (
            <button type="button" key={a.key} className={`acc-row ${on ? 'on' : ''}`} onClick={() => !on && pick(a)}>
              <Avatar uid={a.uid || a.key} name={a.name} size={30} />
              <span className="acc-t"><b>{a.name}</b><small>{a.sub}</small></span>
              {on ? <span className="pill blue sm-pill">{va ? '正在看' : '我自己'}</span> : <span className="muted">›</span>}
            </button>);
        })}
        {data && !rows.length && <div className="muted small">没有找到「{kw}」</div>}
      </div>
    </div>);
}

export default function MePanel({ onClose, onSystem, lang, changeLang, homeOpts, homePref, setHomePref }) {
  const { role, go, toast, setRole } = useApp();
  const va = useViewAs();
  const uid = currentUid(role);
  const me = useMe(uid);
  const [av, setAv] = useState(() => getAvatar(uid));
  useEffect(() => setAv(getAvatar(uid)), [uid]);
  const cam = useRef(null); const lib = useRef(null);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('la9s.sound') !== 'off'; } catch { return true; } });
  const name = meName(me, role);
  const isAdminSelf = role === 'admin' && !va;
  const canSwitch = !SERVER && (isAdminSelf || !!va);
  const myRoles = SERVER ? (serverMe()?.roles || []).filter((r) => ROLES[r]) : [];
  const pickFile = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    try { const d = await shrink(f); localStorage.setItem(avKey(uid), d); setAv(d); window.dispatchEvent(new Event('la9s:avatar')); toast('头像已换'); } catch { toast('这张图读不出来，换一张试试', 'err'); }
  };
  const { org } = useApp();
  const so = staffOptions(useData(() => q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org]), [org]).data?.[0]?.value);
  const rows = [['工号', me?.emp_no], ['部门', me?.department && optLabel(so.departments, me.department)], ['职位', me?.position && optLabel(so.positions, me.position)], ['负责城市', me?.city], ['电话', me?.phone && fmtPhone(me.phone)], ['邮箱', me?.email || (SERVER ? serverMe()?.email : '')], ['入职日期', me?.joined && dDate(me.joined)], ['客户编码', me?.cust_code]].filter(([, v]) => v);
  return (
    <Drawer title="我的" onClose={onClose}>
      <div className="me">
        <div className="me-head">
          <div className="me-av">
            <Avatar uid={uid} name={name} size={64} src={av} />
            {!va && <span className="me-av-btns">
              <button type="button" className="btn sm" onClick={() => cam.current?.click()}>拍照</button>
              <button type="button" className="btn sm" onClick={() => lib.current?.click()}>相册</button>
              {av && <button type="button" className="btn sm ghost" onClick={() => { localStorage.removeItem(avKey(uid)); setAv(''); window.dispatchEvent(new Event('la9s:avatar')); }}>去掉</button>}
            </span>}
            <input ref={cam} type="file" accept="image/*" capture="user" hidden onChange={pickFile} />
            <input ref={lib} type="file" accept="image/*" hidden onChange={pickFile} />
          </div>
          <div className="me-id"><b>{name}</b><span className="muted">{[me?.emp_no, t(ROLES[role]?.label || '')].filter(Boolean).join(' · ')}</span>
            {va && <span className="pill amber sm-pill">你正以这个身份查看 · 只看</span>}</div>
        </div>

        {rows.length > 0 && <div className="me-sec">
          <div className="me-sec-h">我的资料 <span className="muted small">要改找中方</span></div>
          <div className="me-kv">{rows.map(([k, v]) => <React.Fragment key={k}><span>{k}</span><b>{v}</b></React.Fragment>)}</div>
        </div>}

        <div className="me-sec">
          <div className="me-sec-h">个性化 <span className="muted small">只影响你自己</span></div>
          <div className="me-line"><span>语言</span><div className="seg sm">{LANGS.map(([k, l]) => <button type="button" key={k} className={lang === k ? 'on' : ''} onClick={() => changeLang(k)}>{l}</button>)}</div></div>
          {homeOpts.length > 1 && <div className="me-line"><span>首页先看</span><div className="seg sm">{homeOpts.map(([k, l]) => <button type="button" key={k} className={homePref === k ? 'on' : ''} onClick={() => setHomePref(k)}>{l}</button>)}</div></div>}
          <div className="me-line"><span>提醒声音</span><div className="seg sm">{[[true, '开'], [false, '关']].map(([v, l]) => <button type="button" key={l} className={sound === v ? 'on' : ''} onClick={() => { setSound(v); try { localStorage.setItem('la9s.sound', v ? 'on' : 'off'); } catch { /* */ } }}>{l}</button>)}</div></div>
        </div>

        {canSwitch && <AccountList onPicked={onClose} />}
        {myRoles.length > 1 && <div className="me-sec"><div className="me-sec-h">我的岗位 <span className="muted small">你这个账号有几个岗位</span></div>
          <div className="seg sm" style={{ flexWrap: 'wrap' }}>{myRoles.sort((a, b) => rankOf(a) - rankOf(b)).map((r) => <button type="button" key={r} className={r === role ? 'on' : ''} onClick={() => { setRole(r); onClose(); }}>{t(ROLES[r].label)}</button>)}</div></div>}

        <div className="me-sec me-foot">
          {isAdminSelf && <button type="button" className="me-link" onClick={onSystem}><span>系统设置</span><small className="muted">规则 · 选项 · 布局 · 导出整库{REAL || SERVER ? '' : ' · 演示数据'}</small><span className="muted">›</span></button>}
          {!va && <button type="button" className="me-link" onClick={() => { onClose(); go('login'); }}><span>退出登录</span><small className="muted">回登录页：员工 / 客户 / 游客</small><span className="muted">›</span></button>}
        </div>
      </div>
    </Drawer>);
}

// 顶上那条：正在以 X 的身份查看
export function ViewAsBar({ onUnlock, onBack, onLock, peerLock }) {
  const va = useViewAs();
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick((x) => x + 1), 20e3); return () => clearInterval(iv); }, []);
  const unlocked = useMemo(() => !!va && (va.unlockUntil || 0) > Date.now(), [va, tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!va) return null;
  return (
    <div className={`viewas-bar ${unlocked ? 'open' : ''}`}>
      <span className="va-t">{unlocked ? '🔓' : '👁'} 正在以 <b>{va.name}</b>（{va.sub}）的身份查看 · {unlocked ? <b>已解锁：改动记在你（中方）名下</b> : '只看'}{peerLock && <span className="pill gray sm-pill" style={{ marginLeft: 6 }}>他现在被下班锁着，你照样能看</span>}</span>
      <span className="grow" />
      {unlocked ? <button type="button" className="btn sm" onClick={onLock}>锁上</button> : <button type="button" className="btn sm" onClick={onUnlock}>🔓 解锁修改</button>}
      <button type="button" className="btn sm primary" onClick={onBack}>↩ 切回我自己</button>
    </div>);
}
