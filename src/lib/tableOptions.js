// 每张表的「选项设置」(Frank 11-08 拍板): 自定义列 (单选 / 文本 / 日期 / 数字) 存 org_settings 'table_options:<表>',
// 值存 app.row_attrs (表, 行 id, {列key: 值}). Grid 传 table="xxx" 就自动长出这些列; 页面不用改查询.
import React from 'react';
import { q, call } from '../db/client.js';

// 单选选项颜色 (浅底小标, 同「已收清」): 不选 = 普通文字
export const OPT_TONES = [['', '无颜色'], ['green', '绿'], ['amber', '黄'], ['red', '红'], ['blue', '蓝'], ['gray', '灰']];
export const CUSTOM_TYPES = [['select', '单选'], ['text', '文本'], ['number', '数字'], ['date', '日期']];
export const emptyOptions = () => ({ custom: [] });
export const optLabel = (list, v) => (v == null || v === '' ? '' : (list || []).find((x) => x.v === v)?.l || v);
export const selOpts = (list, cur) => [['', '—'], ...(list || []).map((o) => [o.v, o.l]), ...(cur && !(list || []).some((o) => o.v === cur) ? [[cur, cur]] : [])];
export const newKey = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export async function loadTableOptions(org, table) {
  const [r] = await q(`select value from app.org_settings where org_id = $1 and key = $2`, [org, `table_options:${table}`]);
  const v = r?.value || {};
  return { custom: Array.isArray(v.custom) ? v.custom : [] };
}
export async function saveTableOptions(role, org, table, opts) {
  const clean = opts && { custom: (opts.custom || []).filter((c) => c.label?.trim()).map((c) => ({ key: c.key || newKey(), label: c.label.trim(), type: c.type || 'select', items: (c.items || []).filter((i) => i.v !== '' && i.v != null).map((i) => ({ v: String(i.v), l: i.l || String(i.v), ...(i.c ? { c: i.c } : {}) })) })) };
  await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `table_options:${table}`, clean ? JSON.stringify(clean) : null]);
  return clean;
}
export async function loadRowAttrs(org, table) {
  const rows = await q(`select row_id, attrs from app.row_attrs where org_id = $1 and tbl = $2`, [org, table]);
  return Object.fromEntries(rows.map((r) => [r.row_id, r.attrs || {}]));
}
export const saveRowAttrs = (role, org, table, rowId, patch) => call(role, `select app.set_row_attrs($1,$2,$3,$4)`, [org, table, rowId, JSON.stringify(patch)]);

// 把自定义列变成 Grid 列定义. attrsOf(row) → 该行的 {key: 值}; onSave(row, key, value, meta)
export function customColumns(opts, { attrsOf, canEdit, onSave }) {
  return (opts?.custom || []).map((cu) => {
    const get = (row) => attrsOf(row)?.[cu.key];
    const col = { key: `x_${cu.key}`, label: cu.label, w: cu.type === 'number' ? 100 : 120, custom: true, value: (row) => (cu.type === 'select' ? optLabel(cu.items, get(row)) : get(row) ?? '') };
    if (cu.type === 'select' && (cu.items || []).some((it) => it.c)) {
      col.render = (row) => { const v = get(row); if (v == null || v === '') return ''; const it = (cu.items || []).find((x) => x.v === v); return it?.c ? React.createElement('span', { className: `pill ${it.c}` }, it.l || v) : (it?.l || v); };
    }
    if (cu.type === 'number') { col.value = (row) => (get(row) == null || get(row) === '' ? null : Number(get(row))); col.render = (row) => (get(row) == null || get(row) === '' ? '' : Number(get(row)).toLocaleString('en-US')); }
    if (canEdit) col.edit = (row) => ({
      type: cu.type === 'select' ? 'select' : cu.type, value: get(row) ?? '',
      options: cu.type === 'select' ? selOpts(cu.items, get(row)) : undefined,
      onChange: (v, meta) => onSave(row, cu.key, v === '' ? null : v, meta),
    });
    return col;
  });
}
