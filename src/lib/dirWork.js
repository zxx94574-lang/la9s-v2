// 508 (Frank 11-24): 指令一键去做 —— 每种类型挂「跳到哪」; 员工点「去做」带上客户跳过去, 办完在那页顶上的条点「提交指令」
// 正在办的那条存在 sessionStorage, 换页也在; 交了 / 点「先不交」就清掉
const K = 'la9s.dirWork';
export const JUMPS = [['quote', '新建报价（带上客户）'], ['ledger', '客户总账（明细 / 发账单 / 核销）'], ['orders', '这个客户的订单'], ['hotline', '热线记录（带上客户）'],
  ['visits', '拜访表（带上客户）'], ['receipts', '收款登记'], ['pricing', '定价'], ['none', '不跳（手动交结果）']];
export const JUMP_LABEL = Object.fromEntries(JUMPS.map(([k, l]) => [k, l.replace(/（.*）/, '')]));
export const JUMP_DEFAULT = { 制单: 'quote', 催款: 'ledger', 对账: 'ledger', 发货: 'orders', 退货: 'orders', 回电话: 'hotline', 拜访: 'visits', 其他: 'none' };
// 跳过去要先有客户的页面
export const NEEDS_CUST = ['quote', 'ledger', 'orders', 'hotline', 'visits'];
export const jumpOf = (type, map) => (map && map[type]) || JUMP_DEFAULT[type] || 'none';

export function getWork() { try { return JSON.parse(sessionStorage.getItem(K)) || null; } catch { return null; } }
export function setWork(w) { try { if (w) sessionStorage.setItem(K, JSON.stringify(w)); else sessionStorage.removeItem(K); } catch { /* ignore */ } window.dispatchEvent(new Event('la9s-dirwork')); }

// 去做: 记下正在办哪条, 返回要跳的页面 (hash 不带 #/)
export function startWork(w) {
  setWork(w);
  const c = w.cust;
  switch (w.target) {
    case 'quote': try { sessionStorage.setItem('la9s.quote.customer', c); } catch { /* ignore */ } return 'quote/new';
    case 'ledger': return `customer/${c}`;
    case 'orders': if (w.deal) return `deal/${w.deal}`; try { sessionStorage.setItem('la9s.orders.jump', JSON.stringify({ cust: c, from: '2000-01-01', to: new Date().toISOString().slice(0, 10) })); } catch { /* ignore */ } setTimeout(() => window.dispatchEvent(new Event('la9s-orders-jump')), 50); return 'orders';
    case 'hotline': return 'hotline';
    case 'visits': return 'visits';
    case 'receipts': return c ? `receipts/${c}` : 'receipts';
    case 'pricing': return 'pricing';
    default: return 'todo';
  }
}
// 目标页打开时问一句: 是不是从指令跳过来、要不要自动带客户 (只给一次)
export function takeWorkCust(target) { const w = getWork(); if (!w || w.target !== target || w.used) return null; setWork({ ...w, used: true }); return w.cust || null; }

// 507: 跳订单总览并带筛选 (客户 / 机型); 已经在订单总览也能生效 (发事件)
export function ordersJump(go, j, openArchive) {
  try { sessionStorage.setItem('la9s.orders.jump', JSON.stringify({ from: '2000-01-01', to: new Date().toISOString().slice(0, 10), ...j })); } catch { /* ignore */ }
  if (openArchive) openArchive(null);
  go('orders'); setTimeout(() => window.dispatchEvent(new Event('la9s-orders-jump')), 50);
}
