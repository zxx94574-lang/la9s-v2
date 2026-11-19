// 374 (Frank 11-18): 表格对齐方式. 金额 / 价格 / 数量固定右对齐 (不可调); 其余列默认按公司设置 (左 / 中 / 右), 每一列还能单独设.
// 存 org_settings `grid_align` = { text: 'left', cols: { '<表>:<列>': 'center' } }, 只中方能改, 改了所有人所有表生效.
import { q, call } from '../db/client.js';
let ALIGN = { text: 'left', cols: {} };
export async function loadGridAlign(org) { try { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = 'grid_align'`, [org]); ALIGN = { text: r?.value?.text || 'left', cols: r?.value?.cols || {} }; } catch { /* 读不到用默认 */ } }
export const gridAlign = () => ALIGN;
export const colAlign = (gridId, key) => ALIGN.cols[`${gridId}:${key}`] || null;
export async function saveGridAlign(role, org, next) { ALIGN = { text: next.text || 'left', cols: next.cols || {} }; await call(role, `select app.set_org_setting($1,'grid_align',$2)`, [org, JSON.stringify(ALIGN)]); }
