// 11-26 Frank：手机底栏三个总按钮 —— 中间「＋」= 新建（要做的事），「订单」= 看单（各种单据），「更多」= 全部功能（按分组的图标格）。
// 点一下从底部弹出一张卡，选一项直接到；按岗位只列看得到的。电脑上不出现（顶栏照旧有 ＋ 新建）。
import React, { useEffect } from 'react';
import { useApp } from './ui.jsx';
import { Icon, RouteIcon } from './Icons.jsx';
import { ITEMS, visibleTo, buildNav } from './Nav.jsx';
import { t } from '../lib/i18n.js';

// 跳过去以后要直接打开的弹窗 / 页签，页面挂载时读一次（readIntent）
export const setIntent = (k) => { try { sessionStorage.setItem('la9s.intent', k); } catch { /* ignore */ } };
export const readIntent = (k) => { try { if (sessionStorage.getItem('la9s.intent') === k) { sessionStorage.removeItem('la9s.intent'); return true; } } catch { /* ignore */ } return false; };
// 已经在这一页时（不会重新挂载）用事件通知：fn(key) 收到属于自己的意图
export function useIntent(keys, fn) {
  useEffect(() => { const h = () => { const k = keys.find((x) => readIntent(x)); if (k) fn(k); }; window.addEventListener('la9s-intent', h); return () => window.removeEventListener('la9s-intent', h); });
}

// [路由, 名字, 一句话, 图标路由, 意图]
const NEW = [
  ['卖货', [['quote/new', '新订单', '选客户、选货、报价', 'orders'], ['inquiry', '新询单', '客户问价，还不是订单', 'inquiry'], ['fob', '新 FOB 申请', '一客一单', 'fob']]],
  ['钱', [['receipts', '登记收款', '收到钱 → 冲订单', 'receipts'], ['cash', '登记支出', '花了公司的钱', 'cash', 'expense'], ['cash', '交款', '手里的现金交给公司', 'cash', 'handover']]],
  ['客户', [['visits', '记一次拜访', '新潜客也在这里', 'visits'], ['hotline', '热线回访', '给客户打电话', 'hotline']]],
  ['仓库', [['po', '到货收货', '采购单到了，按箱收', 'po'], ['count', '盘点', '领任务，一层一层点', 'count', null, 'bins'], ['purchase', '物资申请', '要买东西', 'purchase']]],
  ['我自己', [['attendance', '打卡', '上班 / 下班', 'attendance'], ['attendance', '请假', '半天 / 全天', 'attendance', 'leave']]],
];
const VIEW = [
  ['单据', [['orders', '订单', '所有订单，按状态看', 'orders', 'o:all'], ['orders', '出库单 / BL', '发了哪些货', 'po', 'o:ship'], ['orders', '询单', '客户问过价的', 'inquiry', 'o:inq', 'inquiry'],
    ['fob', 'FOB 项目', '一客一单，订金尾款', 'fob']]],
  ['钱', [['receipts', '收款记录', '谁付了多少、冲了哪单', 'receipts'], ['balances', '客户总账 Balance', '谁还欠多少', 'balances'], ['cash', '资金账户', '每个账户的钱', 'cash']]],
  ['其他', [['orders', '已作废的单', '取消掉的订单', 'orders', 'o:void'], ['kingdee', '金蝶同步', '哪些单还没录金蝶', 'kingdee']]],
];

function Sheet({ title, onClose, children }) {
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (<>
    <div className="msheet-scrim" onClick={onClose} />
    <div className="msheet" role="dialog" aria-label={title}>
      <div className="msheet-grab" onClick={onClose} />
      <div className="msheet-h"><b>{t(title)}</b><button type="button" className="msheet-x" onClick={onClose} aria-label="关闭">✕</button></div>
      <div className="msheet-b">{children}</div>
    </div>
  </>);
}

// 列表式（新建 / 看单）
export function ActionSheet({ kind, onClose }) {
  const { role, go } = useApp();
  const pick = (r, intent) => { onClose(); if (intent) setIntent(intent); go(r); if (intent) setTimeout(() => window.dispatchEvent(new Event('la9s-intent')), 60); };
  const groups = (kind === 'new' ? NEW : VIEW).map(([g, xs]) => [g, xs.filter(([r, , , , , gate]) => { const route = gate || (r === 'quote/new' ? 'orders' : r); return !ITEMS[route] || visibleTo(route, role); })]).filter(([, xs]) => xs.length);
  return (
    <Sheet title={kind === 'new' ? '新建' : '订单与单据'} onClose={onClose}>
      {groups.map(([g, xs]) => (
        <div key={g} className="msheet-g"><div className="msheet-gl">{t(g)}</div>
          <div className="msheet-list">{xs.map(([r, l, d, ico, intent]) => (
            <button type="button" key={l} className="msheet-row" onClick={() => pick(r, intent)}>
              <span className="msheet-ico"><RouteIcon route={ico} size={20} /></span>
              <span className="msheet-txt"><b>{t(l)}</b><small>{t(d)}</small></span><span className="msheet-go">›</span></button>))}</div></div>))}
    </Sheet>);
}

// 图标格（更多）：和侧栏同一份配置，中方调过的侧栏这里一起变
export function MoreSheet({ cfg, onClose, onSettings, onMenu }) {
  const { role, go } = useApp();
  const groups = buildNav(cfg, role);
  return (
    <Sheet title="全部功能" onClose={onClose}>
      {groups.map((g) => (
        <div key={g.id} className="msheet-g"><div className="msheet-gl">{t(g.label)}</div>
          <div className="msheet-grid">{g.items.map((it) => (
            <button type="button" key={it.route} className="msheet-cell" onClick={() => { onClose(); go(it.route); }}>
              <span className="msheet-ico"><RouteIcon route={it.hub || it.route} size={22} /></span><span>{t(it.label)}</span></button>))}</div></div>))}
      <div className="msheet-g"><div className="msheet-grid">
        <button type="button" className="msheet-cell" onClick={() => { onClose(); onSettings(); }}><span className="msheet-ico"><Icon name="sliders" size={22} /></span><span>{t('设置')}</span></button>
        {role === 'admin' && <button type="button" className="msheet-cell" onClick={() => { onClose(); onMenu(); }}><span className="msheet-ico"><Icon name="layout" size={22} /></span><span>{t('调整侧栏')}</span></button>}
      </div></div>
    </Sheet>);
}
