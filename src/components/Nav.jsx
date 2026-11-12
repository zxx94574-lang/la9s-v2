// 左侧任务栏 (Frank 2026-10-29「要可调整，我要结合实际情况调」):
// 中方点「调整侧栏」→ 改分组名、分组顺序、每一项的名字 / 顺序 / 放在哪个分组 / 给哪些岗位看 / 隐藏; 存在数据库, 全员生效.
// 侧栏宽度每个人自己拖 (存本浏览器). 新功能上线时, 配置里没有的项自动出现在它默认的分组里, 不会丢.
import React, { useState } from 'react';
import { call } from '../db/client.js';
import { useApp, Modal, SortList } from './ui.jsx';
import { ROLES, hasAny } from '../lib/domain.js';
import { t } from '../lib/i18n.js';
import { friendlyError } from '../lib/format.js';

const STAFF = ['admin', 'manager', 'sales_manager', 'hotline', 'picker', 'finance', 'sales'];

// route → [图标, 默认名字, 默认分组, 默认能看的岗位 (空 = 全员)]
export const ITEMS = {
  dashboard: ['◫', '经营总览', 'work', []],
  todo: ['◉', '我的待办', 'work', []],
  sop: ['▣', '培训与 SOP', 'work', []],
  attendance: ['⏱', '上班打卡', 'work', STAFF],
  kpi: ['⏲', '时效与准确率', 'work', ['admin']],
  // 11-09 Frank 第 8 条: 「新建询单 / 报价」「销售询单」不再是独立页; 建单 = 订单总览「＋ 新订单」, 询单审批 = 订单总览页签
  orders: ['≡', '订单总览', 'sales', []],
  fob: ['◷', 'FOB 项目', 'sales', ['admin', 'manager', 'hotline', 'sales', 'finance']],
  customers: ['♧', '客户档案', 'cust', ['admin', 'manager', 'hotline', 'sales', 'finance']],
  hotline: ['☎', '热线回访', 'cust', ['admin', 'manager', 'hotline', 'sales']],
  visits: ['⌖', '销售拜访', 'cust', ['admin', 'manager', 'hotline', 'sales']],
  stores: ['⌂', '客户门店', 'cust', ['admin', 'manager', 'hotline', 'sales']],
  receipts: ['↙', '收款与冲账', 'fin', ['admin', 'finance', 'manager']],
  balances: ['₣', '客户总账 Balance', 'fin', ['admin', 'finance', 'manager', 'hotline', 'sales']],
  cash: ['⇄', '资金账户', 'fin', ['admin', 'finance', 'hotline', 'manager', 'sales']],
  kingdee: ['⇆', '金蝶同步', 'fin', ['admin', 'finance', 'manager']],
  stock: ['▦', '库存（实存/预占/可售）', 'wh', []],
  replenish: ['⇡', '备货看板', 'wh', ['admin', 'manager', 'picker']],
  unmet: ['◇', '未满足需求', 'wh', []],
  purchase: ['⇣', '采购与物资申请', 'wh', STAFF],
  pricing: ['¥', '物料与定价', 'cn', ['admin']],
  materials: ['✎', '物料名称管理（中方）', 'cn', ['admin']],
  staff: ['♙', '员工与工资', 'cn', ['admin', 'sales_manager']],
  import: ['⇩', '数据导入', 'cn', ['admin']],
  // 客户下单端 (客户老板 / 门店店员)
  'p/shop': ['＋', '下单', 'portal', ['boss', 'clerk']],
  'p/orders': ['≡', '我的订单', 'portal', ['boss', 'clerk']],
  'p/balance': ['₣', '我的对账', 'portal', ['boss']],
  'p/stores': ['⌂', '我的门店', 'portal', ['boss']],
};
export const DEFAULT_GROUPS = [
  { id: 'work', label: '工作台' }, { id: 'sales', label: '销售主链' }, { id: 'cust', label: '客户' }, { id: 'fin', label: '财务' },
  { id: 'wh', label: '仓库' }, { id: 'cn', label: '中方' }, { id: 'portal', label: '客户下单端' },
];

// 配置 + 默认 → 当前岗位看到的侧栏 [{id, label, items:[{route, ico, label}]}]
export function buildNav(cfg, role) {
  const groups = (cfg?.groups?.length ? cfg.groups : DEFAULT_GROUPS.map((g) => ({ ...g, items: null })))
    .map((g) => ({ id: g.id, label: g.label, items: [...(g.items || Object.keys(ITEMS).filter((r) => ITEMS[r][2] === g.id))] }));
  const placed = new Set(groups.flatMap((g) => g.items));
  for (const r of Object.keys(ITEMS)) {               // 新功能: 放进默认分组 (分组被删了就放最后一组)
    if (placed.has(r)) continue;
    (groups.find((g) => g.id === ITEMS[r][2]) || groups[groups.length - 1]).items.push(r);
  }
  const hidden = new Set(cfg?.hidden || []);
  return groups.map((g) => ({
    ...g,
    items: g.items.filter((r) => ITEMS[r] && !hidden.has(r) && visibleTo(r, role, cfg))
      .map((r) => ({ route: r, ico: ITEMS[r][0], label: cfg?.labels?.[r] || ITEMS[r][1] })),
  })).filter((g) => g.items.length);
}
export function visibleTo(route, role, cfg) {
  const roles = cfg?.roles?.[route] || ITEMS[route][3];
  const portal = route.startsWith('p/');
  if (['boss', 'clerk'].includes(role)) return portal && (!roles.length || roles.includes(role));
  if (portal) return false;
  return !roles.length || hasAny(role, roles);
}

export function NavEditor({ cfg, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const init = () => {
    const base = buildNavAll(cfg);
    return { groups: base, labels: { ...(cfg?.labels || {}) }, hidden: [...(cfg?.hidden || [])], roles: { ...(cfg?.roles || {}) } };
  };
  const [d, setD] = useState(init);
  const [open, setOpen] = useState(null);   // route whose role chips are open
  const mut = (f) => setD((x) => { const y = structuredClone(x); f(y); return y; });
  const move = (arr, i, j) => { if (j < 0 || j >= arr.length) return; const [v] = arr.splice(i, 1); arr.splice(j, 0, v); };
  const save = async (value) => {
    try { await call(role, `select app.set_org_setting($1,'nav',$2)`, [org, value == null ? null : JSON.stringify(value)]); toast(value ? '侧栏已保存，所有人刷新后生效' : '侧栏已恢复默认'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const staffGroups = d.groups.filter((g) => g.id !== 'portal');
  return (
    <Modal wide title="调整侧栏（只中方，全员生效）" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={() => save(null)}>恢复默认</button><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" onClick={() => save({ groups: d.groups.map((g) => ({ id: g.id, label: g.label, items: g.items })), labels: d.labels, hidden: d.hidden, roles: d.roles })}>保存</button></>}>
      <div className="stack">
        <div className="hint">改名字直接在框里改；按住空白处上下拖调顺序（分组整块拖、组里的项单独拖）；「放到」换分组；「谁能看」选岗位（中方永远都能看）；「隐藏」后所有人都看不到这一项。宽度在侧栏右边缘拖。</div>
        <SortList items={d.groups} keyOf={(g) => g.id} gap={10} onChange={(n) => mut((y) => { const by = Object.fromEntries(y.groups.map((g) => [g.id, g])); y.groups = n.map((g) => by[g.id]); })} render={(g) => { const gi = d.groups.indexOf(g); return (
          <div className="navedit-group" style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}>
              <input className="in" value={g.label} onChange={(e) => mut((y) => { y.groups[gi].label = e.target.value; })} style={{ maxWidth: 200, fontWeight: 700 }} />
              {g.items.length === 0 && <button type="button" className="btn sm" onClick={() => mut((y) => { y.groups.splice(gi, 1); })}>删除空分组</button>}
              {g.id === 'portal' && <span className="small muted">客户老板 / 门店店员看到的</span>}
            </div>
            <SortList items={g.items} keyOf={(r) => r} gap={4} onChange={(n) => mut((y) => { y.groups[gi].items = n; })} render={(r) => { const ii = g.items.indexOf(r);
              const roles = d.roles[r] || ITEMS[r][3]; const hid = d.hidden.includes(r); const portal = r.startsWith('p/');
              const opts = portal ? ['boss', 'clerk'] : STAFF.filter((x) => x !== 'admin');
              return (
                <div key={r} className={`navedit-item ${hid ? 'hid' : ''}`}>
                  <span className="ico">{ITEMS[r][0]}</span>
                  <input className="in" value={d.labels[r] ?? ITEMS[r][1]} onChange={(e) => mut((y) => { y.labels[r] = e.target.value; })} />
                  {!portal && <select className="in" value={g.id} style={{ maxWidth: 120 }} onChange={(e) => mut((y) => { y.groups[gi].items.splice(ii, 1); y.groups.find((x) => x.id === e.target.value).items.push(r); })}>
                    {staffGroups.map((x) => <option key={x.id} value={x.id}>放到：{x.label}</option>)}</select>}
                  <button type="button" className="btn sm" onClick={() => setOpen(open === r ? null : r)}>谁能看：{roles.length ? roles.map((x) => ROLES[x]?.label || (x === 'boss' ? '客户老板' : '门店店员')).join('、') : '全员'}</button>
                  <label className="small row" style={{ gap: 4 }}><input type="checkbox" checked={hid} onChange={() => mut((y) => { y.hidden = hid ? y.hidden.filter((x) => x !== r) : [...y.hidden, r]; })} />隐藏</label>
                  {open === r && (
                    <div className="chips" style={{ flexBasis: '100%', paddingLeft: 28 }}>
                      {!portal && <button type="button" className={`chip ${!roles.length ? 'on' : ''}`} onClick={() => mut((y) => { y.roles[r] = []; })}>全员</button>}
                      {opts.map((x) => (
                        <button type="button" key={x} className={`chip ${roles.includes(x) ? 'on' : ''}`}
                          onClick={() => mut((y) => { const cur = y.roles[r] || ITEMS[r][3]; y.roles[r] = cur.includes(x) ? cur.filter((z) => z !== x) : [...cur, x]; })}>
                          {ROLES[x]?.label || (x === 'boss' ? '客户老板' : '门店店员')}</button>))}
                    </div>)}
                </div>);
            }} />
          </div>); }} />
        <div><button type="button" className="btn sm" onClick={() => mut((y) => { y.groups.splice(y.groups.length - 1, 0, { id: 'g' + Date.now().toString(36), label: '新分组', items: [] }); })}>＋ 新分组</button></div>
      </div>
    </Modal>
  );
}
// 编辑器里要看到全部项 (包括隐藏的), 不按岗位过滤
function buildNavAll(cfg) {
  const groups = (cfg?.groups?.length ? cfg.groups : DEFAULT_GROUPS.map((g) => ({ ...g, items: null })))
    .map((g) => ({ id: g.id, label: g.label, items: [...(g.items || Object.keys(ITEMS).filter((r) => ITEMS[r][2] === g.id))].filter((r) => ITEMS[r]) }));
  const placed = new Set(groups.flatMap((g) => g.items));
  for (const r of Object.keys(ITEMS)) if (!placed.has(r)) (groups.find((g) => g.id === ITEMS[r][2]) || groups[groups.length - 1]).items.push(r);
  return groups;
}
export const navLabel = (s) => t(s);
