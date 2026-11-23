// 图标 (11-22 Frank: 侧栏那些字符图标有的怪怪的 → 统一一套线条图标, 同粗细同大小; 设置里有「图标库」能看每个用在哪、能换)
// 24×24 线条, 圆角端点, 颜色跟文字走. 新加图标在 ICONS 里加一条 path 就行.
import React from 'react';

export const ICONS = {
  grid: ['总览', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
  checklist: ['待办', 'M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17'],
  book: ['培训', 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6'],
  clock: ['打卡', 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v4l3 2'],
  gauge: ['时效', 'M12 7a7 7 0 1 0 0 14a7 7 0 1 0 0-14M12 11v3M10 3h4M18.5 6.5l1-1'],
  percent: ['毛利', 'M19 5L5 19M7 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4M17 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4'],
  sliders: ['规则', 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4'],
  barcode: ['编码', 'M4 6v12M7 6v12M10.5 6v12M14 6v12M16.5 6v12M20 6v12'],
  clipboard: ['订单', 'M9 3.5h6v3H9zM9 5H6v16h12V5h-3M9 11h6M9 15h6'],
  ask: ['询单', 'M4 5h16v11H10l-5 4v-4H4zM10 8.6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2M12 13.5v.01'],
  ship: ['FOB', 'M3 16l2 4h14l2-4zM6 16v-5h12v5M12 4v7M9 7h6'],
  badge: ['账号', 'M4 6h16v12H4zM9 9a2 2 0 1 0 0 4a2 2 0 1 0 0-4M6 16c.6-1.3 1.7-2 3-2s2.4.7 3 2M14 10h4M14 13h3'],
  users: ['客户', 'M9 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M3 20c0-3 2.7-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c1.8.5 3 2 3 5'],
  phone: ['热线', 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2'],
  pin: ['拜访', 'M12 8a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11'],
  store: ['门店', 'M3 9l2-5h14l2 5M3 9h18M5 9v11h14V9M9 20v-6h6v6'],
  cash: ['收款', 'M3 7h18v10H3zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4M6 10v4M18 10v4'],
  invoice: ['对账', 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h4'],
  wallet: ['资金', 'M4 7h14a2 2 0 0 1 2 2v10H4zM4 7l12-3v3M16 13h2'],
  sync: ['金蝶', 'M4 12a8 8 0 0 1 14-5.3L20 9M20 12a8 8 0 0 1-14 5.3L4 15M20 4v5h-5M4 20v-5h5'],
  box: ['库存', 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5'],
  truck: ['采购', 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4M17 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4'],
  trend: ['备货', 'M4 18l5-6 4 3 7-8M15 7h5v5'],
  alert: ['缺口', 'M12 4l9 16H3zM12 10v4M12 17v.01'],
  cart: ['申请', 'M3 4h2l2 11h11l2-8H6M9 19a1 1 0 1 0 0 2a1 1 0 1 0 0-2M17 19a1 1 0 1 0 0 2a1 1 0 1 0 0-2'],
  tag: ['定价', 'M3 12V4h8l10 10-8 8zM7.5 7.5v.01'],
  pencil: ['名称', 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4'],
  person: ['员工', 'M12 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M6 20c0-3 2.7-5 6-5s6 2 6 5'],
  upload: ['导入', 'M12 16V4M7 9l5-5 5 5M4 20h16'],
  layout: ['侧栏', 'M4 4h16v16H4zM9 4v16M9 10h11'],
  calc: ['收银', 'M6 3h12v18H6zM9 7h6M9 11h.01M12 11h.01M15 11h.01M9 14h.01M12 14h.01M15 14h.01M9 17h.01M12 17h.01M15 17h.01'],
  plus: ['下单', 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v8M8 12h8'],
  list: ['列表', 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01'],
  gear: ['设置', 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8'],
};

// 每一页默认用哪个图标 (中方可以在「图标库」里换, 存 org_settings nav_icons)
export const ROUTE_ICON = {
  dashboard: 'grid', todo: 'checklist', sop: 'book', attendance: 'clock', kpi: 'gauge', margin: 'percent', rules: 'sliders', codes: 'barcode',
  orders: 'clipboard', inquiry: 'ask', fob: 'ship', accounts: 'badge', customers: 'users', hotline: 'phone', visits: 'pin', stores: 'store',
  receipts: 'cash', balances: 'invoice', cash: 'wallet', kingdee: 'sync', stock: 'box', po: 'truck', cnfin: 'wallet', replenish: 'trend', unmet: 'alert', purchase: 'cart',
  pricing: 'tag', materials: 'pencil', staff: 'person', import: 'upload', nav: 'layout',
  'p/shop': 'plus', 'p/orders': 'list', 'p/pos': 'calc', 'p/stock': 'box', 'p/balance': 'invoice', 'p/stores': 'store',
};
let OVERRIDE = {};
export const setIconOverride = (m) => { OVERRIDE = m && typeof m === 'object' ? m : {}; };
export const iconFor = (route) => OVERRIDE[route] || ROUTE_ICON[route] || 'list';

export function Icon({ name, size = 18, className = '' }) {
  const d = (ICONS[name] || ICONS.list)[1];
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>);
}
export const RouteIcon = ({ route, size }) => <Icon name={iconFor(route)} size={size} />;

// 图标库 (规则参数 → 系统): 每个图标用在哪; 点一页 → 点一个图标 = 给这一页换图标 (只中方, 全公司一样)
export function IconLibrary({ role, org, call, toast, refresh, pageNames = {} }) {
  const [route, setRoute] = React.useState('');
  const used = {}; for (const [r] of Object.entries(ROUTE_ICON)) (used[iconFor(r)] ||= []).push(r);
  const save = async (name) => {
    if (!route) return toast('先在下面选一页，再点要换成的图标', 'err');
    const next = { ...OVERRIDE, [route]: name };
    try { await call(role, `select app.set_org_setting($1,'nav_icons',$2)`, [org, JSON.stringify(next)]); setIconOverride(next); toast(`「${pageNames[route] || route}」换成了「${ICONS[name][0]}」`); refresh(); } catch (e) { toast(String(e.message || e), 'err'); }
  };
  return (
    <div className="card">
      <div className="card-h"><h2>图标库</h2><span className="small muted">{route ? `正在给「${pageNames[route] || route}」选图标` : '侧栏和手机底栏用的图标；先选一页，再点图标就换'}</span></div>
      <div className="card-b">
        <div className="chips" style={{ marginBottom: 10 }}>{Object.keys(ROUTE_ICON).map((r) => <button type="button" key={r} className={`chip ${route === r ? 'on' : ''}`} onClick={() => setRoute(route === r ? '' : r)}><Icon name={iconFor(r)} size={14} /> {pageNames[r] || r}</button>)}</div>
        <div className="icon-lib">{Object.entries(ICONS).map(([k, [label]]) => (
          <button type="button" key={k} className={`il ${route && iconFor(route) === k ? 'on' : ''}`} onClick={() => role === 'admin' && save(k)}>
            <Icon name={k} size={24} /><b className="small">{label}</b><small>{(used[k] || []).map((r) => pageNames[r] || r).join('、') || '没用到'}</small>
          </button>))}</div>
      </div>
    </div>);
}
