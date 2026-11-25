// 345 审批底层：每类决定按设置走 自己定 / 知会 / 必须批准（后端 app.decision_submit 决定怎么走）
import { call } from '../db/client.js';
export const DECISION_KINDS = { promo: '特价 / 清仓价', writeoff: '核销坏账', price_rules: '改价规则（档位偏离 / 人民币报价）' };
export const DECISION_MODES = [['self', '自己定'], ['notify', '知会'], ['approve', '必须批准']];
// 返回 { mode, id, result }; okText = 直接生效时的提示
export async function submitDecision(role, org, kind, title, report, args, toast, okText) {
  const r = (await call(role, `select app.decision_submit($1,$2,$3,$4,$5) as r`, [org, kind, title, JSON.stringify(report || {}), JSON.stringify(args || {})]))[0].r;
  if (toast) toast(r.mode === 'approve' ? `已送批：${title}（批准人点了才生效，在「审批」里看进度）` : r.mode === 'notify' ? `${okText || '已生效'}，已知会相关的人` : (okText || '已生效'));
  return r;
}
