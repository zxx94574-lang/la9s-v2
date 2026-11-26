// 11-26 Frank：手机底栏三个总按钮 —— 中间「＋」= 新建（要做的事），「订单」= 看单（各种单据），「更多」= 全部功能。
// 点一下铺满（底栏留着），大图标格、主次分明：最常用的两个做成大块，其余按分组排四列。
// 关：再点一次同一个按钮 / 点右上 ✕ / 点底栏别的按钮（直接跳过去）/ Esc。按岗位只列能做的（看权限表）。电脑上不出现。
import React, { useEffect } from 'react';
import { useApp } from './ui.jsx';
import { Icon, RouteIcon } from './Icons.jsx';
import { ITEMS, visibleTo, buildNav } from './Nav.jsx';
import { can, LOCAL_ROLES, hasAny } from '../lib/domain.js';
import { t } from '../lib/i18n.js';

// 跳过去以后要直接打开的弹窗 / 页签，页面挂载时读一次（readIntent）
export const setIntent = (k) => { try { sessionStorage.setItem('la9s.intent', k); } catch { /* ignore */ } };
export const readIntent = (k) => { try { if (sessionStorage.getItem('la9s.intent') === k) { sessionStorage.removeItem('la9s.intent'); return true; } } catch { /* ignore */ } return false; };
// 已经在这一页时（不会重新挂载）用事件通知：fn(key) 收到属于自己的意图
export function useIntent(keys, fn) {
  useEffect(() => { const h = () => { const k = keys.find((x) => readIntent(x)); if (k) fn(k); }; window.addEventListener('la9s-intent', h); return () => window.removeEventListener('la9s-intent', h); });
}

// {r 路由, l 名字, d 一句话（只给大块用）, ico 图标, i 意图, gate 看哪一页的权限, ok(role) 谁能做（看权限表）}
const staff = (role) => hasAny(role, LOCAL_ROLES);
const NEW = [
  ['卖货', [{ r: 'quote/new', l: '新订单', d: '选客户、选货、报价', ico: 'orders', ok: (ro) => can(ro, 'quote') || can(ro, 'direct_order') },
    { r: 'inquiry', l: '新询单', d: '客户问价，还不是订单', ico: 'inquiry', ok: (ro) => can(ro, 'inquiry') },
    { r: 'fob', l: '新 FOB 申请', d: '一客一单', ico: 'fob', ok: (ro) => can(ro, 'fob_create') }]],
  ['钱', [{ r: 'receipts', l: '登记收款', d: '收到钱 → 冲订单', ico: 'receipts', ok: (ro) => can(ro, 'receipt') },
    { r: 'cash', l: '客户说付了', d: '挂上客户的付款截图', ico: 'cash', i: 'notice', ok: (ro) => can(ro, 'payment_notice') && !can(ro, 'receipt') },
    { r: 'cash', l: '登记支出', d: '花了公司的钱', ico: 'cash', i: 'expense', ok: (ro) => can(ro, 'cash_register') },
    { r: 'cash', l: '交款', d: '手里的现金交给公司', ico: 'cash', i: 'handover', ok: (ro) => can(ro, 'cash_register') }]],
  ['客户', [{ r: 'visits', l: '记一次拜访', d: '新潜客也在这里', ico: 'visits', ok: (ro) => can(ro, 'prospect') },
    { r: 'hotline', l: '热线回访', d: '给客户打电话', ico: 'hotline' }]],
  ['仓库', [{ r: 'po', l: '到货收货', d: '采购单到了，按箱收', ico: 'po', ok: (ro) => can(ro, 'receive_po') },
    { r: 'count', l: '盘点', d: '领任务，一层一层点', ico: 'count', gate: 'bins', ok: (ro) => hasAny(ro, ['manager', 'picker']) },
    { r: 'purchase', l: '物资申请', d: '要买东西', ico: 'purchase', ok: (ro) => can(ro, 'purchase_request') }]],
  ['我自己', [{ r: 'attendance', l: '打卡', d: '上班 / 下班', ico: 'attendance', ok: staff }, { r: 'attendance', l: '请假', d: '半天 / 全天', ico: 'attendance', i: 'leave', ok: staff }]],
];
const VIEW = [
  ['单据', [{ r: 'orders', l: '订单', d: '所有订单，按状态看', ico: 'orders', i: 'o:all' }, { r: 'orders', l: '出库单 / BL', d: '发了哪些货', ico: 'po', i: 'o:ship' },
    { r: 'orders', l: '询单', d: '客户问过价的', ico: 'inquiry', i: 'o:inq', gate: 'inquiry' }, { r: 'fob', l: 'FOB 项目', d: '订金、尾款', ico: 'fob' }]],
  ['钱', [{ r: 'balances', l: '客户总账', d: '谁还欠多少', ico: 'balances' }, { r: 'receipts', l: '收款记录', d: '谁付了、冲了哪单', ico: 'receipts' }, { r: 'cash', l: '资金账户', d: '每个账户的钱', ico: 'cash' }]],
  ['其他', [{ r: 'orders', l: '已作废', d: '取消掉的订单', ico: 'orders', i: 'o:void' }, { r: 'kingdee', l: '金蝶同步', d: '哪些单还没录金蝶', ico: 'kingdee' }]],
];
// 每张卡最常用的两个（按这个顺序挑岗位能用的前两个）做成大块
const TOP = { new: ['新订单', '登记收款', '新询单', '记一次拜访', '到货收货', '登记支出', '盘点', '打卡'], view: ['订单', '客户总账', '收款记录', '出库单 / BL'] };

function Sheet({ title, onClose, children }) {
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="msheet" role="dialog" aria-label={title}>
      <div className="msheet-h"><b>{t(title)}</b><button type="button" className="msheet-x" onClick={onClose} aria-label="关闭">✕</button></div>
      <div className="msheet-b">{children}</div>
    </div>);
}
const Cell = ({ ico, label, onClick, big, sub }) => (
  <button type="button" className={big ? 'msheet-big' : 'msheet-cell'} onClick={onClick}>
    <span className="msheet-ico">{typeof ico === 'string' ? <RouteIcon route={ico} size={big ? 26 : 24} /> : ico}</span>
    <span className="msheet-l">{t(label)}</span>{big && sub && <small>{t(sub)}</small>}</button>);

export function ActionSheet({ kind, onClose }) {
  const { role, go } = useApp();
  const pick = (x) => { onClose(); if (x.i) setIntent(x.i); go(x.r); if (x.i) setTimeout(() => window.dispatchEvent(new Event('la9s-intent')), 60); };
  const allowed = (x) => { const route = x.gate || (x.r === 'quote/new' ? 'orders' : x.r); return (!ITEMS[route] || visibleTo(route, role)) && (!x.ok || x.ok(role)); };
  const groups = (kind === 'new' ? NEW : VIEW).map(([g, xs]) => [g, xs.filter(allowed)]);
  const flat = groups.flatMap(([, xs]) => xs);
  const top = TOP[kind].map((l) => flat.find((x) => x.l === l)).filter(Boolean).slice(0, 2);
  const rest = groups.map(([g, xs]) => [g, xs.filter((x) => !top.includes(x))]).filter(([, xs]) => xs.length);
  return (
    <Sheet title={kind === 'new' ? '新建' : '订单与单据'} onClose={onClose}>
      {top.length > 0 && <div className="msheet-top">{top.map((x) => <Cell key={x.l} big ico={x.ico} label={x.l} sub={x.d} onClick={() => pick(x)} />)}</div>}
      {rest.map(([g, xs]) => (
        <div key={g} className="msheet-g"><div className="msheet-gl">{t(g)}</div>
          <div className="msheet-grid">{xs.map((x) => <Cell key={x.l} ico={x.ico} label={x.l} onClick={() => pick(x)} />)}</div></div>))}
      {!flat.length && <div className="empty">{t('你的岗位这里没有要做的')}</div>}
    </Sheet>);
}

// 全部功能：和侧栏同一份配置，中方调过的侧栏这里一起变
export function MoreSheet({ cfg, onClose, onSettings, onMenu }) {
  const { role, go } = useApp();
  const groups = buildNav(cfg, role);
  return (
    <Sheet title="全部功能" onClose={onClose}>
      {groups.map((g) => (
        <div key={g.id} className="msheet-g"><div className="msheet-gl">{t(g.label)}</div>
          <div className="msheet-grid">{g.items.map((it) => <Cell key={it.route} ico={it.hub || it.route} label={it.label} onClick={() => { onClose(); go(it.route); }} />)}</div></div>))}
      <div className="msheet-g"><div className="msheet-gl">{t('设置')}</div><div className="msheet-grid">
        <Cell ico={<Icon name="sliders" size={24} />} label="设置" onClick={() => { onClose(); onSettings(); }} />
        {role === 'admin' && <Cell ico={<Icon name="layout" size={24} />} label="调整侧栏" onClick={() => { onClose(); onMenu(); }} />}
      </div></div>
    </Sheet>);
}
