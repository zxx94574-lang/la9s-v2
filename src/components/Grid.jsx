// Excel-like table used everywhere (Frank 待改 2,3,4,5,6,7,12):
//  · real grid lines (horizontal + vertical) · the column you must fill is tinted + ✎ and glows while you are in it
//  · Enter = next row same column · Tab = next cell · paste a block from Excel/WhatsApp · ⌘/Ctrl+D = fill down
//  · drag-select cells then ⌘/Ctrl+C · select several cells of a fill column → fill them with one value
//  · drag column grip to reorder (neighbours slide) · drag the header edge to resize, double-click it to auto-fit
//  · ▲▼ sort · funnel filter (text: 包含/不包含/等于/…; number: 等于/大于/小于/介于/…) · totals follow the filter
//  · alignment: money right, quantities centre, everything else left
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { useOutside, DateCalendar, useApp, copyToClipboard } from './ui.jsx';
import { loadTableOptions, loadRowAttrs, saveRowAttrs, customColumns } from '../lib/tableOptions.js';
import TableOptionsModal from './TableOptions.jsx';

const PORTAL_ROLES = new Set(['boss', 'clerk', 'guest']);

const p2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function loadLayout(id, cols) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('grid:' + id) || 'null'); } catch { /* storage blocked */ }
  const keys = cols.map((c) => c.key);
  const order = (saved?.order || []).filter((k) => keys.includes(k));
  for (const k of keys) if (!order.includes(k)) order.splice(Math.min(keys.indexOf(k), order.length), 0, k);
  const hidden = (saved?.hidden || cols.filter((c) => c.hidden).map((c) => c.key)).filter((k) => keys.includes(k));
  return { order, hidden, widths: saved?.widths || {}, rowOrder: saved?.rowOrder || [] };
}

const TEXT_OPS = [['contains', '包含'], ['not_contains', '不包含'], ['eq', '等于'], ['ne', '不等于'], ['starts', '以…开始'], ['ends', '以…结束'], ['empty', '为空'], ['not_empty', '不为空']];
const NUM_OPS = [['eq', '等于'], ['ne', '不等于'], ['gt', '大于'], ['lt', '小于'], ['between', '介于'], ['empty', '为空'], ['not_empty', '不为空']];
// alignment rule (待改 12): money right, quantities centre, everything else left — inferred from the label when a column does not say
const MONEY_RE = /单价|金额|价格|售价|底价|欠款|应收|实收|已收|待付|余额|合计金额|收款额|总额|预付|抹零|手续费|Balance|小计|总价|未付|未收|已冲|未冲|将冲|折合|累计|收款（|这笔收款|汇率/;
const QTY_RE = /数量|实存|预占|可售|已出库|已退|缺口|供货|找到|件数|行数|笔数|^需求$|复核数|可退|型号数|被问次数/;
const kindOf = (c) => c.type || (MONEY_RE.test(c.label) ? 'money' : QTY_RE.test(c.label) ? 'number' : 'text');
const isNumCol = (c) => kindOf(c) !== 'text';
const alignOf = (c) => c.align || (kindOf(c) === 'money' ? 'right' : kindOf(c) === 'number' ? 'center' : 'left');

// 只写了 render、没写 value 的列 (比如询单的 实存 / 预占 / 可售): 排序和筛选用「格子里显示的字」, 数字列再转成数字
// (11-02 Frank: 点排序没反应、筛选大于以后整张表空了, 就是这个原因)
const textCache = new WeakMap();
function renderedText(c, row) {
  let m = textCache.get(row); if (!m) { m = new Map(); textCache.set(row, m); }
  if (!m.has(c)) {
    let t = '';
    try { t = renderToStaticMarkup(React.createElement(React.Fragment, null, c.render(row))); } catch { /* 用到页面状态的格子渲染不了, 当空 */ }
    t = t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
    m.set(c, t.replace(/\s+/g, ' ').trim());
  }
  return m.get(c);
}
const toNum = (t) => { const s = String(t ?? '').replace(/[\s\u00a0\u202f]/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'); return s === '' || s === '-' ? null : Number(s); };
function cellValue(c, row) {
  if (c.value) return c.value(row);
  const v = row[c.key];
  if (v instanceof Date) return fmtDate(v);
  if (v === undefined && c.render) { const t = renderedText(c, row); return isNumCol(c) ? toNum(t) : t; }
  return v;
}
function passes(c, row, f) {
  const raw = cellValue(c, row);
  const empty = raw === null || raw === undefined || raw === '';
  if (f.op === 'empty') return empty;
  if (f.op === 'not_empty') return !empty;
  if (f.op === 'in' || f.op === 'not_in') {   // 253: 多选值; 一格里有几个值 (BF7 / BG6M) 时, 中一个就算
    const mine = splitVals(raw).map((x) => x.toUpperCase()); const want = (f.vals || []).map((x) => String(x).toUpperCase());
    if (!want.length) return true;
    const hit = mine.some((x) => want.includes(x)) || want.includes(String(raw ?? '').trim().toUpperCase());
    return f.op === 'in' ? hit : !hit;
  }
  if (f.op === 'contains' || f.op === 'not_contains') { const q0 = String(f.a ?? '').toUpperCase(); if (!q0) return true; const h = String(raw ?? '').toUpperCase().includes(q0); return f.op === 'contains' ? h : !h; }
  if (isNumCol(c)) {
    const v = Number(raw), a = Number(String(f.a).replace(',', '.')), b = Number(String(f.b ?? '').replace(',', '.'));
    if (f.a === '' || f.a === undefined || Number.isNaN(a)) return true;
    if (empty || Number.isNaN(v)) return false;
    switch (f.op) {
      case 'eq': return v === a; case 'ne': return v !== a; case 'gt': return v > a; case 'lt': return v < a;
      case 'between': return f.b === '' || f.b === undefined ? v >= a : v >= Math.min(a, b) && v <= Math.max(a, b);
      default: return true;
    }
  }
  const s = String(raw ?? '').toUpperCase(), q = String(f.a ?? '').toUpperCase();
  if (!q) return true;
  switch (f.op) {
    case 'contains': return s.includes(q); case 'not_contains': return !s.includes(q); case 'eq': return s === q; case 'ne': return s !== q;
    case 'starts': return s.startsWith(q); case 'ends': return s.endsWith(q); default: return true;
  }
}

// 11-01 飞书式选格 (LineEntry 用): onSelChange(rows, colKeys) 选中范围变化; onPasteSel(row, colKey, text) 选中格上 ⌘V;
// onCellOpen(row, colKey, char?) 双击 / 回车 / 直接打字 → 打开这一格的编辑; onClearSel(rows, colKeys) 选中后按 Delete
//
// 11-07 Frank 定的全局规则 (所有表): 列上写 edit(row) → {type:'text'|'number'|'select'|'date', value, options?, onChange(v)} 的格子
//  · 平时显示成普通格子, 点一下 = 选中, 再点一下 / 回车 / 直接打字 = 进编辑 (Esc 放弃, 回车保存并下移, Tab 右移)
//  · 单选列进编辑弹「查找选项」的白底选择框; 日期列弹日历 (年 / 月 / 日)
//  · onChange 在「保存」时才调一次 (不是每敲一个字), 页面在 onChange 里直接写库 = 改一格存一格
//  · ⌘C 复制选中那块 (制表符表格); ⌘V 只填进选中区域: 选一格 → 从这格铺整块, 选一片 → 只填这一片, 剪贴板不够就重复铺满
//  · Delete 清空选中的可编辑格; 点行号选整行; onReorder(fromRow, toRow) 时左侧出现 ⋮⋮ 拖动手柄
import { FilterPanel, Schemes, newCond, condReady, splitVals } from './GridFilter.jsx';
const LAST_COPY = { out: '', raw: '' };   // 最近一次从表格复制的内容: out = 带行号 (给 Excel), raw = 不带 (表格内粘贴)
export default function Grid({ id, columns: baseColumns, rows, rowKey = (r) => r.id, rowClass, onRowClick, onDelete, selectable, foot, tools, empty = '暂无数据', maxHeight, noTools,
  onSelChange, onPasteSel, onCellOpen, onClearSel, onReorder, api, table, attrsEditable, errors, onShown, compactTools, rowActions }) {
  // ── 每张表的自定义列 (Frank 11-08): 传 table="xxx" 就自动长出「选项设置」里加的列, 值存 row_attrs ──
  const app = useApp() || {};
  const [tbl, setTbl] = useState({ opts: null, attrs: {} });
  const [optOpen, setOptOpen] = useState(false);
  const [tblTick, setTblTick] = useState(0);
  useEffect(() => {
    if (!table || !app.org) return undefined;
    let on = true;
    Promise.all([loadTableOptions(app.org, table), loadRowAttrs(app.org, table)]).then(([opts, attrs]) => on && setTbl({ opts, attrs })).catch(() => {});
    return () => { on = false; };
  }, [table, app.org, app.tick, tblTick]);
  const canEditAttrs = attrsEditable ?? !PORTAL_ROLES.has(app.role);
  const columns = useMemo(() => {
    if (!table || !tbl.opts?.custom?.length) return baseColumns;
    const saveAttr = async (row, key, v, meta) => {
      const rid = rowKey(row);
      if (!rid || !/^[0-9a-f-]{36}$/i.test(String(rid))) return app.toast?.('这一行还没有正式记录，存不了自定义列', 'err');
      setTbl((t) => ({ ...t, attrs: { ...t.attrs, [rid]: { ...(t.attrs[rid] || {}), [key]: v } } }));
      try { await saveRowAttrs(app.role, app.org, table, rid, { [key]: v }); if (!meta?.batch || meta.last) app.toast?.('已保存'); }
      catch (e) { app.toast?.(e.message, 'err'); setTblTick((x) => x + 1); }
    };
    return [...baseColumns, ...customColumns(tbl.opts, { attrsOf: (row) => tbl.attrs[rowKey(row)], canEdit: canEditAttrs, onSave: saveAttr })];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseColumns, table, tbl, canEditAttrs]);
  const [layout, setLayout] = useState(() => loadLayout(id, columns));
  useEffect(() => { setLayout(loadLayout(id, columns)); // eslint-disable-next-line
  }, [id, columns.map((c) => c.key).join()]);
  useEffect(() => { try { localStorage.setItem('grid:' + id, JSON.stringify(layout)); } catch { /* ignore */ } }, [id, layout]);

  // a column without a label (buttons / actions) gets no sort or filter
  const byKey = useMemo(() => Object.fromEntries(columns.map((c) => [c.key, c.label ? c : { ...c, sortable: false, filterable: false }])), [columns]);
  const vis = layout.order.filter((k) => !layout.hidden.includes(k) && byKey[k]).map((k) => byKey[k]);
  const tableRef = useRef();
  const gid = 'g-' + id.replace(/[^a-z0-9]/gi, '');

  // ── sort + filter ──
  const [sort, setSort] = useState(null); // {key, dir}
  // 253 (Frank 11-12): 飞书式筛选 —— 条件数组 + 符合所有 / 任一 + 全表搜索; 只影响自己: 存在本机这个岗位下 (关掉标签页就清)
  const gfKey = `la9s.gf.${app.role || 'x'}.${id || 'grid'}`;
  const [gf, setGf] = useState(() => { try { return JSON.parse(sessionStorage.getItem(gfKey) || 'null') || { conds: [], any: false, q: '' }; } catch { return { conds: [], any: false, q: '' }; } });
  useEffect(() => { try { sessionStorage.setItem(gfKey, JSON.stringify(gf)); } catch { /* 无痕模式存不了就算了 */ } }, [gf, gfKey]);
  const filters = gf.conds; const setFilters = (v) => setGf((g) => ({ ...g, conds: typeof v === 'function' ? v(g.conds) : Array.isArray(v) ? v : [] }));
  const liveConds = filters.filter((f) => condReady(f) && byKey[f.key]);
  const shown = useMemo(() => {
    const live = filters.filter((f) => condReady(f) && byKey[f.key]);
    const words = String(gf.q || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    const cols = Object.values(byKey).filter((c) => c.label);
    let out = rows.filter((r) => (!live.length || (gf.any ? live.some((f) => passes(byKey[f.key], r, f)) : live.every((f) => passes(byKey[f.key], r, f))))
      && (!words.length || words.every((w) => cols.some((c) => String(cellValue(c, r) ?? '').toUpperCase().includes(w)))));
    if (sort && byKey[sort.key]) {
      const c = byKey[sort.key];
      const num = isNumCol(c);
      const blank = (v) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));
      out = [...out].sort((a, b) => {
        const x = cellValue(c, a), y = cellValue(c, b);
        // 空白永远排最后, 不管升序降序 (Frank 11-07)
        const bx = blank(x), by = blank(y);
        if (bx || by) return bx && by ? 0 : bx ? 1 : -1;
        const r = num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'zh-CN', { numeric: true });
        return sort.dir === 'asc' ? r : -r;
      });
    }
    // 手动拖过行的表: 没排序时按拖出来的顺序 (记在本机)
    if (!sort && layout.rowOrder?.length) {
      const pos = new Map(layout.rowOrder.map((k, i) => [k, i]));
      out = [...out].map((r, i) => [r, i]).sort((a, b) => (pos.get(rowKey(a[0])) ?? 1e9 + a[1]) - (pos.get(rowKey(b[0])) ?? 1e9 + b[1])).map((x) => x[0]);
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, gf, sort, byKey, layout.rowOrder]);
  // 只在「筛出来的行」或条件真的变了才通知页面 (按内容比, 不按引用: 页面每次渲染给新数组也不会转圈)
  const shownSig = useRef('');
  useEffect(() => {
    if (!onShown) return;
    const sig = shown.map(rowKey).join('|') + '§' + JSON.stringify(liveConds);
    if (sig === shownSig.current) return;
    shownSig.current = sig; onShown(shown, liveConds, gf.q || '');
  }, [shown, gf]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [dragRow, setDragRow] = useState(null);   // {from, over}
  const startRowDrag = (e, from) => {
    let state = { from, over: from }; setDragRow(state);
    const move = (ev) => { const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('tr[data-row]'); if (el) { const over = +el.dataset.row; if (over !== state.over) { state = { ...state, over }; setDragRow(state); } } };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragRow(null); moveRow(state.from, state.over); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const moveRow = (from, to) => {
    if (from === to) return;
    if (onReorder) { onReorder(from, to, shown); return; }
    const keys = shown.map(rowKey); const [k] = keys.splice(from, 1); keys.splice(to, 0, k);
    setLayout((l) => ({ ...l, rowOrder: keys })); setSort(null);
    if (navigator.vibrate) navigator.vibrate(8);
  };
  const nFilters = liveConds.length + (String(gf.q || '').trim() ? 1 : 0);
  const [toolsOpen, setToolsOpen] = useState(false);   // 265: 档案里的小表, 工具栏收成一个小图标
  const [panel, setPanel] = useState(null);   // 筛选面板的位置
  const panelBtn = useRef(null);
  const openPanel = (preset) => { const r = panelBtn.current?.getBoundingClientRect(); const left = r ? Math.max(8, Math.min(r.left, window.innerWidth - 640)) : 16; const top = r ? r.bottom + 6 : 120; if (preset) setFilters((cs) => (cs.some((c) => c.key === preset.key) ? cs : [...cs.filter(condReady), newCond(preset.key, isNumCol(preset))])); else if (!filters.length) setFilters([newCond()]); setPanel({ left, top }); };
  const optionsOf = (c) => { const set = new Set(); for (const r of rows) for (const v of splitVals(cellValue(c, r))) set.add(v); return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })); };
  const filterCols = vis.concat(layout.order.filter((k) => layout.hidden.includes(k) && byKey[k]).map((k) => byKey[k])).filter((c) => c.label && c.filterable !== false);
  const toggleSort = (k) => setSort((s) => (!s || s.key !== k ? { key: k, dir: 'asc' } : s.dir === 'asc' ? { key: k, dir: 'desc' } : null));

  const editFor = (r, ci) => vis[ci]?.edit?.(shown[r], r);
  // ── 格子编辑状态 (11-07): editing = {r, c, draft} ──
  const [editing, setEditing] = useState(null);
  const editRef = useRef(null);
  const openEdit = (r, c, initChar) => {
    const ed = editFor(r, c); if (!ed || ed.disabled) return false;
    const base = ed.type === 'select' ? (ed.value ?? '') : (ed.value ?? '');
    setEditing({ r, c, draft: initChar != null ? initChar : String(base ?? ''), type: ed.type || 'text', typed: initChar != null });
    return true;
  };
  const editingRef = useRef(null); editingRef.current = editing;
  // ── 撤销 / 重做 (Frank 11-07: 一步一步退回到最开始): 记 {rowKey, colKey, prev, next}, 撤销 = 把 prev 再写回去 (照样自动存)
  const [undo, setUndo] = useState([]); const [redo, setRedo] = useState([]);
  const push = (changes) => { if (changes.length) { setUndo((u) => [...u.slice(-99), changes]); setRedo([]); } };
  const applyChange = (ch, dir, meta) => {
    const r = shown.findIndex((x) => rowKey(x) === ch.rowK); const c = vis.findIndex((x) => x.key === ch.colK);
    let ed;
    if (r < 0 || c < 0) { const row = rows.find((x) => rowKey(x) === ch.rowK); const col = byKey[ch.colK]; ed = row && col?.edit?.(row, -1); } else ed = editFor(r, c);
    if (ed && !ed.disabled) ed.onChange(dir === 'undo' ? ch.prev : ch.next, meta);
  };
  const applyAll = (list, dir) => { const n = list.length; list.forEach((ch, i) => applyChange(ch, dir, { batch: n > 1, index: i, total: n, last: i === n - 1 })); };
  const doUndo = () => { const last = undo[undo.length - 1]; if (!last) return; setUndo((u) => u.slice(0, -1)); setRedo((x) => [...x, last]); applyAll([...last].reverse(), 'undo'); flash(`已撤销 ${last.length} 格`); };
  const doRedo = () => { const nxt = redo[redo.length - 1]; if (!nxt) return; setRedo((x) => x.slice(0, -1)); setUndo((u) => [...u, nxt]); applyAll(nxt, 'redo'); flash(`已重做 ${nxt.length} 格`); };
  // 一次批量操作 (粘贴 / 清空 / 填入 / 撤销) = 一步: 先收集要改的格, 再统一写; onChange(v, meta) 的 meta = {batch, index, total, last}, 页面据此只提示一次
  const setCell = (r, c, v, batch) => { const ed = editFor(r, c); if (!ed || ed.disabled) return false; const prev = ed.value ?? ''; if (String(prev) === String(v ?? '')) return false; batch.push({ rowK: rowKey(shown[r]), colK: vis[c].key, prev, next: v, ed }); return true; };
  const flush = (batch) => { const n = batch.length; batch.forEach((ch, i) => { ch.ed.onChange(ch.next, { batch: n > 1, index: i, total: n, last: i === n - 1 }); delete ch.ed; }); };
  const commitEdit = (value, move) => {
    const e = editingRef.current; if (!e) return;
    editingRef.current = null; setEditing(null);
    const ed = editFor(e.r, e.c);
    const v = value === undefined ? e.draft : value;
    if (ed && !ed.disabled && String(v ?? '') !== String(ed.value ?? '')) { const b = []; setCell(e.r, e.c, v, b); flush(b); push(b); }
    if (move) {
      const nr = e.r + (move === 'down' ? 1 : move === 'up' ? -1 : 0), nc = e.c + (move === 'right' ? 1 : move === 'left' ? -1 : 0);
      if (shown[nr] && vis[nc]) { setSel({ a: [nr, nc], b: [nr, nc] }); anchor.current = [nr, nc]; }
    }
  };
  const cancelEdit = () => { editingRef.current = null; setEditing(null); };
  useEffect(() => { if (editing && editRef.current) { const el = editRef.current; el.focus(); if (editing.type !== 'select' && editing.type !== 'date') { if (editing.typed) { const n = el.value.length; el.setSelectionRange?.(n, n); } else el.select?.(); } } // eslint-disable-next-line
  }, [editing?.r, editing?.c]);
  // 老式键盘导航 (TEXTAREA / 页面自己渲染的 input 还会用到)
  const onKeyDown = (e) => {
    const t = e.target;
    if (t.dataset.r === undefined) return;
    if (e.key === 'Enter' && t.tagName !== 'TEXTAREA') { e.preventDefault(); commitEdit(undefined, e.shiftKey ? 'up' : 'down'); }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit(undefined, e.shiftKey ? 'left' : 'right'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  };
  // 粘贴一块 (制表符 / 换行): 只填进选中的区域 (Frank 11-07); 选一格 = 从这格铺整块; 选一片 = 只填这片, 剪贴板不够就重复
  const pasteBlock = (text) => {
    if (!range) return 0;
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const single = range.r0 === range.r1 && range.c0 === range.c1;
    const batch = [];
    const r1 = single ? Math.min(shown.length - 1, range.r0 + grid.length - 1) : range.r1;
    const c1 = single ? Math.min(vis.length - 1, range.c0 + Math.max(...grid.map((g) => g.length)) - 1) : range.c1;
    let n = 0;
    for (let r = range.r0; r <= r1; r++) for (let c = range.c0; c <= c1; c++) {
      const line = grid[(r - range.r0) % grid.length]; const v = line[(c - range.c0) % line.length];
      if (v === undefined) continue;
      const ed = editFor(r, c);
      if (ed && !ed.disabled) { const val = v.trim(); if (ed.type === 'select') { const hit = (ed.options || []).find(([ov, ol]) => ov === val || String(ol) === val); if (!hit) continue; if (setCell(r, c, hit[0], batch)) n++; } else if (setCell(r, c, val, batch)) n++; }
    }
    flush(batch); push(batch);
    if (!single || grid.length > 1 || grid[0].length > 1) setSel({ a: [range.r0, range.c0], b: [r1, c1] });
    flash(`已粘贴 ${n} 格`);
    return n;
  };
  const onPaste = () => {};

  // ── range selection + copy + batch fill ──
  const [sel, setSel] = useState(null); // {a:[r,c], b:[r,c]}
  const anchor = useRef(null);
  const selecting = useRef(false);
  const range = sel && { r0: Math.min(sel.a[0], sel.b[0]), r1: Math.max(sel.a[0], sel.b[0]), c0: Math.min(sel.a[1], sel.b[1]), c1: Math.max(sel.a[1], sel.b[1]) };
  const inSel = (r, c) => range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
  const cellDown = (e, r, c) => {
    if (e.target.closest('input,select,textarea')) {
      if (e.shiftKey && anchor.current) { e.preventDefault(); setSel({ a: anchor.current, b: [r, c] }); }
      else anchor.current = [r, c];
      return;
    }
    if (e.target.closest('button,a,.cell-pop,.dp-pop,.cell-sel')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();   // 拖选格子时不要浏览器自己的「选文字」(会把整张表涂蓝)
    if (editing && (editing.r !== r || editing.c !== c)) commitEdit();
    // 再点一下已选中的那一格 = 进编辑 (飞书; Frank 11-07); 已经在编辑这一格就不动
    if (!e.shiftKey && sel && sel.a[0] === r && sel.a[1] === c && sel.b[0] === r && sel.b[1] === c) {
      if (editing && editing.r === r && editing.c === c) return;
      if (onCellOpen) onCellOpen(shown[r], vis[c].key); else openEdit(r, c);
      return;
    }
    if (e.shiftKey && sel) setSel({ a: sel.a, b: [r, c] }); else setSel({ a: [r, c], b: [r, c] });
    anchor.current = [r, c];
    selecting.current = true;
  };
  const cellEnter = (r, c) => { if (selecting.current) setSel((s) => s && { a: s.a, b: [r, c] }); };
  useEffect(() => { const up = () => { selecting.current = false; }; window.addEventListener('pointerup', up); return () => window.removeEventListener('pointerup', up); }, []);
  const [msg, setMsg] = useState('');
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 1800); };
  const copySel = useCallback(async (withHead) => {
    if (!range) return 0;
    const lines = [];
    if (withHead) lines.push(vis.slice(range.c0, range.c1 + 1).map((c) => c.label).join('\t'));
    for (let r = range.r0; r <= range.r1; r++) {
      const cells = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const ed = editFor(r, c);
        if (ed && !ed.disabled && editing?.r !== r) { cells.push(ed.type === 'select' ? String((ed.options || []).find(([v]) => v === ed.value)?.[1] ?? ed.value ?? '') : String(ed.value ?? '')); continue; }
        const td = tableRef.current.querySelector(`td[data-cr="${r}"][data-cc="${c}"]`);
        const inp = td?.querySelector('input,select');
        cells.push(inp ? (inp.tagName === 'SELECT' ? inp.selectedOptions[0]?.text : inp.value) : (td?.innerText || '').replace(/\s+/g, ' ').trim());
      }
      lines.push(cells.join('\t'));
    }
    // 263 (Frank 11-12): 只要复制就带行号 (贴到 Excel 第一列是序号); 表格里自己粘贴用不带行号的原块, 免得错一列
    const raw = lines.join('\n');
    const out = lines.map((ln, i) => (withHead && i === 0 ? '#' : String(range.r0 + i + (withHead ? 0 : 1))) + '\t' + ln).join('\n');
    if (!(await copyToClipboard(out))) return -1;
    LAST_COPY.out = out; LAST_COPY.raw = raw;
    return range.r1 - range.r0 + 1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, vis, shown, editing]);
  useEffect(() => {
    const k = async (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && sel && !e.target.closest?.('input,textarea')) {
        if (!tableRef.current?.isConnected) return;
        e.preventDefault(); const n = await copySel(false); flash(n < 0 ? '浏览器不让复制' : `已复制 ${n} 行`);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !editing && undo.length + redo.length > 0 && tableRef.current?.isConnected && !e.target.closest?.('input,textarea,select,[contenteditable]')) {
        e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return;
      }
      if (e.key === 'Escape' && !editing) setSel(null);
      if (!sel || editing || !tableRef.current?.isConnected || e.target.closest?.('input,textarea,select,[contenteditable]')) return;
      if (e.key === 'Enter' || (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey)) {
        const [r, c] = sel.a;
        if (shown[r] && vis[c]) {
          if (onCellOpen) { e.preventDefault(); onCellOpen(shown[r], vis[c].key, e.key === 'Enter' ? null : e.key); }
          else if (editFor(r, c)) { e.preventDefault(); openEdit(r, c, e.key === 'Enter' ? null : e.key); }
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && range) {
        if (onClearSel) { e.preventDefault(); onClearSel(shown.slice(range.r0, range.r1 + 1), vis.slice(range.c0, range.c1 + 1).map((c) => c.key)); }
        else {
          let n = 0; const batch = [];
          for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) { if (setCell(r, c, '', batch)) n++; }
          flush(batch); push(batch);
          if (n) { e.preventDefault(); flash(`已清空 ${n} 格`); }
        }
      }
      // 方向键移动选中格
      const dir = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[e.key];
      if (dir) { const [r, c] = sel.b; const nr = r + dir[0], nc = c + dir[1]; if (shown[nr] && vis[nc]) { e.preventDefault(); if (e.shiftKey) setSel({ a: sel.a, b: [nr, nc] }); else { setSel({ a: [nr, nc], b: [nr, nc] }); anchor.current = [nr, nc]; } } }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, editing, copySel, onCellOpen, onClearSel, shown, vis, range, undo, redo]);
  // 选中格子上 ⌘V: 页面接管 (onPasteSel, LineEntry) 或表格自己只填选中区域
  useEffect(() => {
    const p = (e) => {
      if (!sel || editing || !tableRef.current?.isConnected || e.target.closest?.('input,textarea,select')) return;
      let text = e.clipboardData?.getData('text/plain'); if (!text) return;
      if (LAST_COPY.out && text.replace(/\r/g, '') === LAST_COPY.out) text = LAST_COPY.raw;
      const r = range.r0, c = range.c0;
      if (!shown[r] || !vis[c]) return;
      e.preventDefault();
      if (onPasteSel) onPasteSel(shown[r], vis[c].key, text, shown.slice(range.r0, range.r1 + 1)); else pasteBlock(text);
    };
    window.addEventListener('paste', p); return () => window.removeEventListener('paste', p);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, editing, range, shown, vis, onPasteSel]);
  // 选中范围变了 → 告诉页面 (飞书: 选了格子 = 选了这几行)
  const selKey = range ? `${range.r0}-${range.r1}-${range.c0}-${range.c1}` : '';
  useEffect(() => {
    if (!onSelChange) return;
    onSelChange(range ? shown.slice(range.r0, range.r1 + 1) : [], range ? vis.slice(range.c0, range.c1 + 1).map((c) => c.key) : []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);
  const fillTargets = range ? (() => {
    const out = [];
    for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) { const ed = editFor(r, c); if (ed && !ed.disabled && ed.type !== 'select') out.push(ed); }
    return out;
  })() : [];
  const [fillVal, setFillVal] = useState('');

  // ── column drag with live neighbour shifting ──
  const [drag, setDrag] = useState(null);
  const startDrag = (e, key) => {
    e.preventDefault(); e.stopPropagation();
    const ths = [...tableRef.current.querySelectorAll('thead th[data-ck]')];
    const widths = ths.map((th) => th.getBoundingClientRect().width);
    const lefts = ths.map((th) => th.getBoundingClientRect().left);
    const from = vis.findIndex((c) => c.key === key);
    const x0 = e.clientX;
    let state = { key, from, to: from, dx: 0, widths, lefts };
    setDrag(state);
    const move = (ev) => {
      const dx = ev.clientX - x0;
      const center = lefts[from] + widths[from] / 2 + dx;
      const mid = (i) => lefts[i] + widths[i] / 2;
      let to = from;
      for (let i = from + 1; i < lefts.length; i++) if (center > mid(i)) to = i;
      for (let i = from - 1; i >= 0; i--) if (center < mid(i)) to = i;
      state = { ...state, dx, to };
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (state.to !== state.from) {
        const keys = vis.map((c) => c.key);
        const [k] = keys.splice(state.from, 1); keys.splice(state.to, 0, k);
        setLayout((l) => ({ ...l, order: [...keys, ...l.order.filter((x) => !keys.includes(x))] }));
        if (navigator.vibrate) navigator.vibrate(8);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const dragCss = useMemo(() => {
    if (!drag) return '';
    const { from, to, dx, widths } = drag;
    const rules = [`#${gid} [data-ck]{transition:transform .22s cubic-bezier(.2,.8,.2,1)}`];
    vis.forEach((c, i) => {
      let x = 0;
      if (i === from) x = dx;
      else if (from < to && i > from && i <= to) x = -widths[from];
      else if (from > to && i < from && i >= to) x = widths[from];
      if (x) rules.push(`#${gid} [data-ck="${c.key}"]{transform:translateX(${x}px)}`);
    });
    rules.push(`#${gid} [data-ck="${vis[from].key}"]{transition:none;position:relative;z-index:6;background:#e3ecf9!important;box-shadow:0 6px 18px #0f2a5230}`);
    return rules.join('\n');
  }, [drag, vis, gid]);

  // ── column resize + double-click auto-fit ──
  const startResize = (e, key) => {
    e.preventDefault(); e.stopPropagation();
    const th = e.currentTarget.parentElement;
    const w0 = th.getBoundingClientRect().width, x0 = e.clientX;
    const move = (ev) => setLayout((l) => ({ ...l, widths: { ...l.widths, [key]: Math.max(48, Math.round(w0 + ev.clientX - x0)) } }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const autoFit = (e, key) => {
    e.preventDefault(); e.stopPropagation();
    const cells = [...tableRef.current.querySelectorAll(`[data-ck="${key}"]`)];
    let w = 48;
    for (const el of cells) {
      const inp = el.querySelector('input,select');
      const content = inp ? (inp.value || inp.placeholder || '').length * 9 + 40 : el.scrollWidth;
      const inner = el.firstElementChild?.scrollWidth || 0;
      w = Math.max(w, content, inner + 24);
    }
    setLayout((l) => ({ ...l, widths: { ...l.widths, [key]: Math.min(520, Math.ceil(w)) } }));
  };

  // ── which fill column is active (glow) ──
  const [activeCol, setActiveCol] = useState(null);

  // ── column menu / filter popover ──
  const [menu, setMenu] = useState(false);
  const menuRef = useOutside(menu, () => setMenu(false));
  const [fpop, setFpop] = useState(null); // key of open filter
  const [fpopAt, setFpopAt] = useState({ left: 0, top: 0 });
  const fRef = useOutside(!!fpop, () => setFpop(null));
  const toggleCol = (k) => setLayout((l) => ({ ...l, hidden: l.hidden.includes(k) ? l.hidden.filter((x) => x !== k) : [...l.hidden, k] }));

  const allSel = selectable && shown.length > 0 && shown.every((r) => selectable.selected.has(rowKey(r)));
  // 删行 (Frank 11-09): 不再有行尾小叉; 勾选的行优先, 否则是点行号 / 拖出来的选区覆盖的行
  // 行操作 (Frank 11-12 「操作按钮不放格子里」): 页面给 rowActions=[{label, tone, when(row), run(row)}], 点中一行 (或只勾一行) → 表格上方出这一行能做的按钮
  const actRow = !rowActions?.length ? null : selectable?.selected?.size === 1 ? shown.find((r) => selectable.selected.has(rowKey(r))) : (range && range.r0 === range.r1 ? shown[range.r0] : null);
  const actList = actRow ? rowActions.filter((a) => !a.when || a.when(actRow)) : [];
  const delRows = useMemo(() => {
    if (!onDelete) return [];
    if (selectable?.selected?.size) return shown.filter((r) => selectable.selected.has(rowKey(r)));
    if (sel && range) return shown.slice(range.r0, range.r1 + 1);
    return [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDelete, selectable?.selected, sel, shown]);
  const colIdx = Object.fromEntries(vis.map((c, i) => [c.key, i]));
  const footObj = typeof foot === 'function' ? foot(shown) : foot;
  const isFill = (c) => c.fill || (!!c.edit && shown.some((r, i) => { const ed = c.edit(r, i); return ed && !ed.disabled; }));
  // 有可编辑列的表: 点格子 = 选格子, 不再整行打开; 打开走行号旁的 ↗ (飞书的「查看」)
  const hasEdit = vis.some((c) => !!c.edit);
  // 11-11 Frank 207 (底层统一): 点格子 = 选中, 永远不整行打开; 打开走单号 / 名字链接或行号旁 ↗
  const rowOpen = null;
  // 页面可以让表格选中某一格 (Excel: 回车后跳到下一行同一列)
  if (api) api.current = { select: (rowK, colK, dr = 0) => { const r = shown.findIndex((x) => rowKey(x) === rowK) + dr; const c = vis.findIndex((x) => x.key === colK); if (r >= 0 && r < shown.length && c >= 0) { setSel({ a: [r, c], b: [r, c] }); anchor.current = [r, c]; } } };
  // Frank 11-09 16:15 定: 鼠标滚轮 = 上下滚页面 (不动表格左右); 按住 Shift 滚轮 = 表格左右滚; 触控板横滑照旧
  const twRef = useRef(null);
  useEffect(() => {
    const w = twRef.current; if (!w) return undefined;
    const onWheel = (e) => {
      if (!e.shiftKey) return;                                   // 不按 Shift: 交给浏览器, 照常上下滚
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;       // 系统已经把 Shift 滚轮转成横向 (Mac): 浏览器自己处理
      if (w.scrollWidth <= w.clientWidth + 2) return;
      const before = w.scrollLeft; w.scrollLeft += e.deltaY; if (w.scrollLeft !== before) e.preventDefault();
    };
    w.addEventListener('wheel', onWheel, { passive: false });
    return () => w.removeEventListener('wheel', onWheel);
  }, []);
  const widthStyle = (c) => { const w = layout.widths[c.key]; return w ? { width: w, minWidth: w, maxWidth: w } : { minWidth: c.w, maxWidth: Math.max(c.w * 2.5, 220) }; };

  return (
    <div id={gid} className="grid" onKeyDown={onKeyDown} onPaste={onPaste}>
      <style>{dragCss}</style>
      {panel && <FilterPanel at={panel} cols={filterCols} isNum={isNumCol} optionsOf={optionsOf} conds={filters} setConds={setFilters} any={gf.any} setAny={(v) => setGf((g) => ({ ...g, any: v }))} onClose={() => setPanel(null)} />}
      {optOpen && <TableOptionsModal table={table} opts={tbl.opts} builtin={baseColumns.filter((c) => c.label).map((c) => c.label)} onClose={() => setOptOpen(false)} onSaved={() => { setOptOpen(false); setTblTick((x) => x + 1); }} />}
      {noTools && onDelete && delRows.length > 0 && (
        <div className="grid-tools" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn sm danger" onClick={() => { const rs = delRows; setSel(null); if (selectable?.onChange) selectable.onChange(new Set()); onDelete(rs[0], shown.indexOf(rs[0]), rs); }}>🗑 删 {delRows.length} 行</button>
        </div>)}
      {noTools && rowActions?.length > 0 && (
        <div className="grid-tools">{actRow ? (
          <span className="row-acts"><span className="small">第 {shown.indexOf(actRow) + 1} 行：</span>
            {actList.map((a) => <button type="button" key={a.label} className={`btn sm ${a.tone || 'primary'}`} onClick={() => a.run(actRow)}>{a.label}</button>)}
            {!actList.length && <span className="small muted">这一行现在没有要做的</span>}</span>
        ) : <span className="small muted row-acts-hint">点中一行 → 这里出现能做的操作（{rowActions.map((a) => a.label).join(' / ')}）</span>}</div>)}
      {!noTools && compactTools && !toolsOpen && (
        <div className="grid-tools mini"><span className="grow" />{nFilters > 0 && <span className="pill blue">筛出 {shown.length}/{rows.length} 行</span>}<button type="button" className="btn sm ghost" title="筛选 / 搜索 / 显示哪些列" onClick={() => setToolsOpen(true)}>⏷ ☷</button></div>)}
      {!noTools && (!compactTools || toolsOpen) && (
        <div className="grid-tools">
          {tools}
          <button type="button" ref={panelBtn} className={`btn sm gf-keep ${liveConds.length ? 'primary' : ''}`} onClick={() => (panel ? setPanel(null) : openPanel())} title="筛选：可以叠加多个条件">⏷ 筛选{liveConds.length ? ` ${liveConds.length}` : ''}</button>
          {liveConds.map((f) => <span key={f.id} className="pill blue gf-chip gf-keep" onClick={() => openPanel()} title="点开修改">{byKey[f.key].label}{f.op === 'in' ? '：' : f.op === 'not_in' ? ' 不是：' : f.op === 'empty' ? ' 为空' : f.op === 'not_empty' ? ' 不为空' : f.op === 'contains' ? ' 包含 ' : f.op === 'not_contains' ? ' 不包含 ' : { eq: ' = ', ne: ' ≠ ', gt: ' > ', lt: ' < ', between: ' 介于 ' }[f.op] || ' '}{['in', 'not_in'].includes(f.op) ? ((f.vals || []).length > 2 ? `${f.vals.length} 个` : (f.vals || []).join('、')) : ['empty', 'not_empty'].includes(f.op) ? '' : f.op === 'between' ? `${f.a}–${f.b}` : f.a}
            <button type="button" className="x-mini" title="去掉这个条件" onClick={(e) => { e.stopPropagation(); setFilters((cs) => cs.filter((c) => c.id !== f.id)); }}>×</button></span>)}
          <input className="in sm gf-search" placeholder="⌕ 搜这张表（单号、名字、机型…）" value={gf.q || ''} onChange={(e) => setGf((g) => ({ ...g, q: e.target.value }))} />
          <Schemes id={id || 'grid'} current={gf} onApply={(s2) => setGf({ conds: (s2.conds || []).map((c) => ({ ...c })), any: !!s2.any, q: s2.q || '' })} />
          {nFilters > 0 && <span className="pill blue">筛出 {shown.length}/{rows.length} 行</span>}
          {(nFilters > 0 || sort) && <button type="button" className="btn sm" onClick={() => { setGf({ conds: [], any: false, q: '' }); setSort(null); }} title="清掉所有筛选和排序，回到最初的样子">↺ 清空</button>}

          {rowActions?.length > 0 && (actRow ? (
            <span className="row-acts"><span className="small">第 {shown.indexOf(actRow) + 1} 行：</span>
              {actList.map((a) => <button type="button" key={a.label} className={`btn sm ${a.tone || 'primary'}`} onClick={() => a.run(actRow)}>{a.label}</button>)}
              {!actList.length && <span className="small muted">这一行现在没有要做的</span>}</span>
          ) : <span className="small muted row-acts-hint">点中一行 → 这里出现能做的操作（{rowActions.map((a) => a.label).join(' / ')}）</span>)}
          <span className="grow" />
          {msg && <span className="pill green">{msg}</span>}
          {fillTargets.length > 1 && (
            <span className="row" style={{ gap: 4 }}>
              <span>把选中的 {fillTargets.length} 格填为</span>
              <input className="in" style={{ width: 80, minHeight: 30, padding: '3px 8px' }} value={fillVal} inputMode="numeric" onChange={(e) => setFillVal(e.target.value)} />
              <button type="button" className="btn sm primary" onClick={() => { const b = []; for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) { const ed = editFor(r, c); if (ed && !ed.disabled && ed.type !== 'select') setCell(r, c, fillVal, b); } flush(b); push(b); flash(`已填 ${b.length} 格`); }}>填入</button>
            </span>
          )}
          {(undo.length > 0 || redo.length > 0) && <span className="row" style={{ gap: 4 }}>
            <button type="button" className="btn sm" disabled={!undo.length} onClick={doUndo} title="⌘Z · 一步一步退回到最开始">↶ 撤销{undo.length ? ` ${undo.length}` : ''}</button>
            <button type="button" className="btn sm" disabled={!redo.length} onClick={doRedo} title="⌘⇧Z">↷ 重做</button></span>}
          {sel && <button type="button" className="btn sm" onClick={async () => { const n = await copySel(true); flash(n < 0 ? '浏览器不让复制' : `已复制 ${n} 行（含表头）`); }}>复制所选</button>}
          {onDelete && delRows.length > 0 && <button type="button" className="btn sm danger" title="删掉选中的行（勾选的行，或点行号选中的行）；删错了可撤销" onClick={() => { const rs = delRows; setSel(null); if (selectable?.onChange) selectable.onChange(new Set()); onDelete(rs[0], shown.indexOf(rs[0]), rs); }}>🗑 删 {delRows.length} 行</button>}
          {vis.some(isFill) && <span className="hide-m small">⌘/Ctrl+V 粘贴整列 · ⌘/Ctrl+D 向下填充 · 拖表头边线调宽、双击自适应</span>}
          <span style={{ position: 'relative' }} ref={menuRef}>
            <button type="button" className="btn sm" onClick={() => setMenu(!menu)}>☷ 列</button>
            {menu && (
              <div className="menu" style={{ right: 0, top: '110%' }}>
                {layout.order.map((k) => byKey[k] && (
                  <label key={k}><input type="checkbox" checked={!layout.hidden.includes(k)} onChange={() => toggleCol(k)} />{byKey[k].label}</label>
                ))}
                <button type="button" className="mi" onClick={() => setLayout({ order: columns.map((c) => c.key), hidden: columns.filter((c) => c.hidden).map((c) => c.key), widths: {}, rowOrder: [] })}>↺ 恢复默认（列顺序、宽度、行顺序）</button>
              </div>
            )}
          </span>
          {table && app.role === 'admin' && <button type="button" className="btn sm" title="给这张表加自己的列（单选 / 文本 / 日期 / 数字）和选项" onClick={() => setOptOpen(true)}>⚙ 选项设置</button>}
        </div>
      )}
      <div className="tw" ref={twRef} style={maxHeight ? { maxHeight } : null}>
        <table className="t" ref={tableRef}>
          <thead>
            <tr>
              <th className="rowhead" style={{ width: selectable ? 64 : 40 }}>{selectable ? <label className="selall" title="全选 / 全不选"><input type="checkbox" checked={allSel} onChange={() => selectable.onChange(allSel ? new Set() : new Set(shown.map(rowKey)))} />全选</label> : <span className="muted">#</span>}</th>
              {vis.map((c) => {
                const fill = isFill(c);
                const f = liveConds.some((x) => x.key === c.key);
                return (
                  <th key={c.key} data-ck={c.key} style={{ ...widthStyle(c), textAlign: alignOf(c) }}
                    className={`${fill || c.tint ? 'fill-col' : ''} ${activeCol === c.key ? 'fill-active' : ''}`}>
                    <span className="th-inner" style={{ justifyContent: alignOf(c) === 'right' ? 'flex-end' : alignOf(c) === 'center' ? 'center' : 'flex-start' }}>
                      <span className="grip" onPointerDown={(e) => startDrag(e, c.key)} title="拖动调整列顺序">⠿</span>
                      {fill && <span className="pen" title="这一列要填">✎</span>}
                      <span className="th-label" onClick={() => c.sortable !== false && toggleSort(c.key)} title="点击排序">{c.label}</span>
                      {c.sortable !== false && <span className={`sort ${sort?.key === c.key ? 'on' : ''}`} onClick={() => toggleSort(c.key)}>{sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>}
                      {c.filterable !== false && (
                        <button type="button" className={`funnel gf-keep ${f ? 'on' : ''}`} title="按这一列筛选" onClick={(e) => { e.stopPropagation(); openPanel(c); }}>⏷</button>
                      )}
                    </span>
                    <span className="resizer" onPointerDown={(e) => startResize(e, c.key)} onDoubleClick={(e) => autoFit(e, c.key)} title="拖动调宽，双击自适应" />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={vis.length + 3} className="empty"><span className="sticky-left">{rows.length ? <>筛选以后没有符合条件的行 <button type="button" className="btn sm" onClick={() => setGf({ conds: [], any: false, q: '' })}>清除筛选</button></> : empty}</span></td></tr>}
            {shown.map((row, r) => {
              const k = rowKey(row);
              return (
                <tr key={k} data-row={r} className={`${rowClass?.(row) || ''} ${rowOpen ? 'click' : ''} ${dragRow ? (dragRow.from === r ? 'dragging' : dragRow.over === r ? (dragRow.over > dragRow.from ? 'drop-below' : 'drop-above') : '') : ''}`} onClick={rowOpen ? (e) => !e.target.closest('input,select,button,.shared,.thumb,.rowhead,.cell-pop') && rowOpen(row) : undefined}>
                  <td className={`rowhead ${range && range.r0 <= r && r <= range.r1 ? 'sel' : ''}`} onPointerDown={(e) => { if (e.target.closest('input,.rgrip,.ropen')) return; e.preventDefault(); if (editing) commitEdit(); if (e.shiftKey && sel) setSel({ a: [sel.a[0], 0], b: [r, vis.length - 1] }); else { setSel({ a: [r, 0], b: [r, vis.length - 1] }); anchor.current = [r, 0]; } }} title="点行号选中整行，Shift 点选多行">
                    <span className="rgrip" title="按住拖动，上下挪行" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); startRowDrag(e, r); }}>⋮⋮</span>
                    {selectable && <input type="checkbox" checked={selectable.selected.has(k)} onChange={() => { const s = new Set(selectable.selected); s.has(k) ? s.delete(k) : s.add(k); selectable.onChange(s); }} />}
                    <span className="rnum">{r + 1}</span>
                    {onRowClick && <button type="button" className="ropen" title="打开" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRowClick(row); }}>↗</button>}
                  </td>
                  {vis.map((c, ci) => {
                    const ed = c.edit?.(row, r);
                    let inner;
                    const isEditing = editing && editing.r === r && editing.c === ci;
                    if (ed && !ed.disabled && isEditing) {
                      const type = ed.type || 'text';
                      if (type === 'select') {
                        inner = <><span className="cell-txt">{(ed.options || []).find(([v]) => v === ed.value)?.[1] ?? ed.value ?? ''}</span>
                          <CellSelect options={ed.options || []} value={ed.value} td={() => tableRef.current?.querySelector(`td[data-cr="${r}"][data-cc="${ci}"]`)} onPick={(v) => commitEdit(v)} onClose={cancelEdit} initChar={editing.draft !== String(ed.value ?? '') ? editing.draft : ''} /></>;
                      } else if (type === 'date') {
                        inner = <><span className="cell-txt">{ed.value || ''}</span>
                          <CellPop td={() => tableRef.current?.querySelector(`td[data-cr="${r}"][data-cc="${ci}"]`)} onClose={cancelEdit}><DateCalendar value={ed.value || ''} onChange={(v) => commitEdit(v)} onClose={cancelEdit} /></CellPop></>;
                      } else {
                        inner = <input ref={editRef} data-r={r} data-c={ci} className={`cell-in on ${ed.invalid ? 'err' : ''}`} value={editing.draft}
                          onChange={(e) => setEditing((x) => x && { ...x, draft: type === 'number' ? e.target.value.replace(/[^\d.,-]/g, '') : e.target.value })}
                          onBlur={() => commitEdit()} inputMode={type === 'number' ? 'decimal' : undefined} style={{ textAlign: alignOf(c) }} />;
                      }
                    } else if (ed && !ed.disabled) {
                      const shownV = ed.type === 'select' ? ((ed.options || []).find(([v]) => v === ed.value)?.[1] ?? ed.value ?? '') : ed.display ?? (ed.type === 'number' && ed.value !== '' && ed.value != null && kindOf(c) === 'money' ? Number(ed.value).toLocaleString('en-US') : ed.value ?? '');
                      inner = <span className={`cell-txt ${ed.invalid ? 'err' : ''}`} title={ed.title}>{shownV === '' || shownV == null ? <span className="cell-ph">{ed.placeholder || ''}</span> : shownV}</span>;
                      if (ed.hint) inner = <>{inner}<div className="cell-hint">{ed.hint}</div></>;
                    } else {
                      inner = c.render ? c.render(row, r) : c.value ? c.value(row) : row[c.key];
                      if (inner instanceof Date) inner = fmtDate(inner);
                      else if (inner !== null && typeof inner === 'object' && !React.isValidElement(inner) && !Array.isArray(inner)) inner = String(inner);
                    }
                    const fillCell = c.plain ? false : ((ed && !ed.disabled) || c.fill || c.tint);   // tint = 只上底色 (一组金额列同色), plain = 能改也不上色
                    const errMsg = errors?.[k]?.[c.key] || (ed?.invalid ? (ed.title || '有问题') : null);
                    return <td key={c.key} data-ck={c.key} data-cr={r} data-cc={ci} style={{ textAlign: alignOf(c), ...widthStyle(c) }} title={errMsg || undefined}
                      className={`${errMsg ? 'cell-err' : ''} ${inSel(r, ci) ? 'sel' : ''} ${sel && sel.a[0] === r && sel.a[1] === ci && range.r0 === range.r1 && range.c0 === range.c1 ? 'sel-a' : ''} ${isEditing ? 'editing' : ''} ${fillCell ? 'fill-col' : ''} ${fillCell && activeCol === c.key ? 'fill-active' : ''}`}
                      onPointerDown={(e) => cellDown(e, r, ci)} onPointerEnter={() => cellEnter(r, ci)}
                      onDoubleClick={isEditing ? undefined : onCellOpen ? () => onCellOpen(row, c.key) : (ed && !ed.disabled ? () => openEdit(r, ci) : undefined)}>{inner}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
          {footObj && shown.length > 0 && (
            <tfoot><tr>
              <td className="rowhead" />
              {vis.map((c) => <td key={c.key} data-ck={c.key} style={{ textAlign: alignOf(c) }}>{footObj[c.key] ?? ''}</td>)}
            </tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function FilterPop({ col, at, value, onChange, onClose }) {
  const ops = isNumCol(col) ? NUM_OPS : TEXT_OPS;
  const [op, setOp] = useState(value?.op || ops[0][0]);
  const [a, setA] = useState(value?.a ?? '');
  const [b, setB] = useState(value?.b ?? '');
  const needs = !['empty', 'not_empty'].includes(op);
  const apply = () => { onChange({ op, a, b }); onClose(); };
  return (
    <div className="menu fpop" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: at.top, left: Math.max(8, at.left), width: 220, padding: 8, zIndex: 300, maxHeight: `calc(100vh - ${at.top + 12}px)`, overflow: 'auto' }}>
      <div className="small muted" style={{ padding: '2px 6px 6px' }}>筛选「{col.label}」</div>
      {ops.map(([k, l]) => (
        <button type="button" key={k} className={`mi ${op === k ? 'focus' : ''}`} onClick={() => setOp(k)}>{l}{op === k ? ' ✓' : ''}</button>
      ))}
      {needs && (
        <div className="row" style={{ gap: 6, padding: 6 }}>
          <input className="in" autoFocus value={a} onChange={(e) => setA(e.target.value)} inputMode={isNumCol(col) ? 'decimal' : undefined}
            placeholder={op === 'between' ? '从' : '输入值'} onKeyDown={(e) => e.key === 'Enter' && apply()} style={{ flex: 1 }} />
          {op === 'between' && <input className="in" value={b} onChange={(e) => setB(e.target.value)} inputMode="decimal" placeholder="到" onKeyDown={(e) => e.key === 'Enter' && apply()} style={{ flex: 1 }} />}
        </div>
      )}
      <div className="row" style={{ gap: 6, padding: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn sm" onClick={() => { onChange(null); onClose(); }}>清除</button>
        <button type="button" className="btn sm primary" onClick={apply}>确定</button>
      </div>
    </div>
  );
}

// 格子浮层: 跟着格子定位 (portal), 点外面关闭
function CellPop({ td, onClose, children, width = 240 }) {
  const ref = useRef();
  const [at, setAt] = useState(null);
  useEffect(() => { const el = td(); if (!el) return; const r = el.getBoundingClientRect(); const left = Math.min(r.left, window.innerWidth - width - 8); const below = window.innerHeight - r.bottom; setAt({ left: Math.max(8, left), top: below > 320 ? r.bottom + 2 : null, bottom: below > 320 ? null : window.innerHeight - r.top + 2 }); // eslint-disable-next-line
  }, []);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); }; const t = setTimeout(() => document.addEventListener('pointerdown', h), 0); return () => { clearTimeout(t); document.removeEventListener('pointerdown', h); }; }, [onClose]);
  if (!at) return null;
  return createPortal(<div ref={ref} className="cell-pop" style={{ position: 'fixed', left: at.left, top: at.top ?? 'auto', bottom: at.bottom ?? 'auto', width, zIndex: 320 }} onPointerDown={(e) => e.stopPropagation()}>{children}</div>, document.body);
}

// 单选列的选择框: 白底黑字、一项一个框 (Frank 11-07), 顶部「查找选项」, 回车选第一项, Esc 关
function CellSelect({ options, value, td, onPick, onClose, initChar }) {
  const [qs, setQs] = useState(initChar || '');
  const [hi, setHi] = useState(0);
  const list = options.filter(([v, l]) => !qs || String(l).toUpperCase().includes(qs.toUpperCase()) || String(v).toUpperCase().includes(qs.toUpperCase()));
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) onPick(list[hi][0]); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    e.stopPropagation();
  };
  return (
    <CellPop td={td} onClose={onClose}>
      <input className="in cell-sel-q" autoFocus value={qs} placeholder="查找选项" onChange={(e) => { setQs(e.target.value); setHi(0); }} onKeyDown={key} />
      <div className="cell-sel">
        {list.length === 0 && <div className="muted small" style={{ padding: 8 }}>没有匹配的选项</div>}
        {list.map(([v, l], i) => <button type="button" key={String(v)} className={`opt ${i === hi ? 'hi' : ''} ${v === value ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => onPick(v)}>{l === '' || l == null ? <span className="muted">（空）</span> : l}{v === value ? <span className="tick">✓</span> : null}</button>)}
      </div>
    </CellPop>
  );
}
