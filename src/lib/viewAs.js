// 中方快捷切换 = 以别人的身份查看（Frank 11-28）。存 sessionStorage（关掉网页就回到自己）。
//   { kind: 'staff' | 'customer', role, name, sub, unlockUntil }
// 只看 / 已解锁 由 db/client.js 的 setViewGuard 在写入口统一判断；15 分钟没动自动锁回去。
import { setViewGuard } from '../db/client.js';

const K = 'la9s.viewas';
export const UNLOCK_MIN = 15;
export function getViewAs() { try { return JSON.parse(sessionStorage.getItem(K) || 'null'); } catch { return null; } }
export function setViewAs(v) { try { if (v) sessionStorage.setItem(K, JSON.stringify(v)); else sessionStorage.removeItem(K); } catch { /* 没存上：只在本页有效 */ } window.dispatchEvent(new Event('la9s:viewas')); }
export const isUnlocked = (v = getViewAs()) => !!v && (v.unlockUntil || 0) > Date.now();
export function unlockView() { const v = getViewAs(); if (v) setViewAs({ ...v, unlockUntil: Date.now() + UNLOCK_MIN * 60e3 }); }
export function lockView() { const v = getViewAs(); if (v) setViewAs({ ...v, unlockUntil: 0 }); }
export function touchUnlock() { const v = getViewAs(); if (isUnlocked(v)) { v.unlockUntil = Date.now() + UNLOCK_MIN * 60e3; try { sessionStorage.setItem(K, JSON.stringify(v)); } catch { /* */ } } }
setViewGuard(() => { const v = getViewAs(); if (!v) return null; return isUnlocked(v) ? 'unlocked' : 'locked'; });

// 账号排序：权限从大到小
export const ROLE_RANK = ['admin', 'country_manager', 'sales_manager', 'manager', 'finance', 'hotline', 'sales', 'picker', 'cn_business', 'cn_finance', 'cn_support', 'boss', 'clerk'];
export const rankOf = (r) => { const i = ROLE_RANK.indexOf(r); return i < 0 ? 99 : i; };
