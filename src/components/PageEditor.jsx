// 页面编辑（Frank 11-28：「有些页面能调，有些调不了」→ 每一页都能调；外加全站字号）
// 不靠逐页改代码：打开后自动认出当前页面的板块（页面标题 / 页签固定在顶上，下面的卡片、分段 = 板块；
// 外面多包了一层的（我的待办、月报）再往里看一层），每块能 拖顺序 / 调宽度 / 隐藏 / 调大小。
// 全站字号：页面标题、板块标题、大数字、表格、侧栏、整体内容 各一个比例。
// 存法：本页 org_settings `layout2:<页面>`，全站字号 `ui_type`；保存后所有人一致；只中方能改。
// 经营总览原来那套页面内拖板块（components/Layout.jsx）照旧，跟着同一个开关打开。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, Info, ConfirmBtn } from './ui.jsx';
import { setLayoutEdit, useLayoutEdit } from './Layout.jsx';
import { friendlyError } from '../lib/format.js';

const SPANS = [[12, '整行'], [8, '2/3'], [6, '一半'], [4, '1/3'], [3, '1/4']];
const SIZES = [[0.9, '小'], [1, '标准'], [1.15, '大'], [1.3, '特大']];
export const TYPE_CATS = [
  ['page', '整体内容', 'main.content', '页面里所有的字一起放大缩小'],
  ['h1', '页面标题', 'main.content .pagehead h1', '每页最上面的大标题'],
  ['h2', '板块标题', 'main.content .card-h, main.content .d2-h, main.content .rp-sec2 > h2, main.content .me-card-h', '每块卡片左上角的蓝色标题'],
  ['num', '大数字', 'main.content .kpi .v, main.content .d2-m .v, main.content .pgsum .v, main.content .b3 .v, main.content .bbig .v, main.content .dcard .big, main.content .bigsum .v, main.content .kpi-btn .v, main.content .rp-top b, main.content .bm-big b, main.content .rp-kpis b', '看板、小总览里的大数'],
  ['table', '表格', 'main.content .tw', '所有表格里的字'],
  ['side', '侧栏菜单', '.side', '左边的菜单'],
];
const pageKey = () => (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'dashboard');
const FIXED = '.hub-tabs, .pagehead, .viewas-bar, .lay-bar';
// 板块名：取标题里的字，去掉说明按钮（ⓘ）、灰字、数字
function headText(el) {
  const h = el.querySelector('.card-h, h1, h2, h3, .d2-h, .d2-title, summary, .sec-h') || el.querySelector('b');
  if (!h) return '';
  const c = h.cloneNode(true);
  c.querySelectorAll('button, .info-i, .info-tip, small, .muted, input, select').forEach((x) => x.remove());
  return (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
const keyText = (t) => t.replace(/[\d,.%·:：()（）\s]+/g, ' ').trim();

// 认板块：返回 { items: [{ key, label, el, parent, canSplit }] }
// 11-28：整页只有一张大卡片（员工与工资、选项设置…）→ 自动往卡片里面看一层；任何卡片也能在页面上点「拆开」把里面的小块分出来单独调
const FIXED_IN = `${FIXED}, .card-h, .tabs, .hub-tabs, .seg-bar`;
const NAMED = { pgsum: '小总览', 'mt-strip': '指标条', 'd2-attn': '要你注意的', tabs: '页签', digest: '今日数字', 'rp-kpis': '关键数' };
const realKids = (el, fixed) => [...el.children].filter((e) => !e.matches(fixed) && !e.matches('style, script, .pe-skip'));
function label(el, cls, txt) {
  if (el.matches('.lay-grid')) return '看板（里面的小板块在页面上直接拖）';
  if (NAMED[cls]) return NAMED[cls];
  if (txt && /[^\d\s,.%·:：()（）/+\-]/.test(txt)) return txt;
  if (el.querySelector('.period-bar')) return '日期按钮';
  if (el.matches('.banner, .of-bar')) return '筛选提示';
  if (el.querySelector('.tw')) return '表格';
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 14 ? `${t.slice(0, 14)}…` : t) : '一块';
}
function tag(box, fixed, prefix, seen, out, parent) {
  box.dataset.peBox = '1';
  realKids(box, fixed).forEach((el) => {
    const txt = headText(el);
    const cls = [...el.classList].filter((c) => !['card', 'row', 'stack', 'pe-hl', 'pe-sel', 'pe-split'].includes(c))[0] || el.tagName.toLowerCase();
    let key = `${prefix}${cls}|${keyText(txt)}`; seen[key] = (seen[key] || 0) + 1; if (seen[key] > 1) key += `#${seen[key]}`;
    el.dataset.pe = key;
    const inner = el.querySelector(':scope > .card-b') || el;
    const canSplit = el.matches('.card') && !inner.matches('.grid') && realKids(inner, FIXED_IN).filter((x) => !x.matches('.grid')).length >= 2;
    out.push({ key, label: label(el, cls, txt), el, parent, canSplit });
  });
}
function scan(split = []) {
  const m = document.querySelector('main.content'); if (!m) return null;
  document.querySelectorAll('[data-pe-box]').forEach((x) => { delete x.dataset.peBox; });
  let box = m;
  let kids = realKids(box, FIXED);
  if (kids.length === 1 && !kids[0].matches('.card, .lay-grid') && kids[0].children.length >= 3) { box = kids[0]; kids = realKids(box, FIXED); }
  const seen = {}; const items = [];
  tag(box, FIXED, '', seen, items, null);
  // 往里拆：设置里点过「拆开」的，或者整页就一张大卡片
  // 整页就一块：一层层往里找，直到里面有两块以上（碰到表格就停：一张表没什么可拆的）
  let autoInner = null;
  if (items.length === 1) {
    let el = items[0].el;
    for (let d = 0; d < 4; d += 1) {
      if (el.matches('.grid')) break;
      const inner = el.querySelector(':scope > .card-b') || el; const ks = realKids(inner, FIXED_IN);
      if (ks.length >= 2) { if (!inner.matches('.grid')) autoInner = inner; break; }
      if (ks.length !== 1 || ks[0].matches('.tw, table')) break;
      el = ks[0];
    }
    if (autoInner) items[0].canSplit = true;
  }
  const auto = autoInner ? [items[0].key] : [];
  [...new Set([...split, ...auto])].forEach((k) => {
    const it = items.find((x) => x.key === k); if (!it || !it.canSplit) return;
    const inner = auto.includes(k) && autoInner ? autoInner : (it.el.querySelector(':scope > .card-b') || it.el);
    it.el.classList.add('pe-split'); it.split = true; it.auto = auto.includes(k) && !split.includes(k);
    tag(inner, FIXED_IN, `${k}>`, seen, items, k);
  });
  const oneTable = items.length <= 1 && !!m.querySelector('.tw');
  return { items, oneTable };
}

function cssFor(cfg, type, edit) {
  const out = [];
  const t = type || {};
  TYPE_CATS.forEach(([k, , sel]) => { const z = Number(t[k] || 1); if (z && z !== 1) out.push(`${sel} { zoom: ${z}; }`); });
  const b = cfg?.blocks || {};
  const keys = Object.keys(b);
  const flow = edit || keys.some((k) => b[k].span && b[k].span !== 12) || Array.isArray(cfg?.order) || (cfg?.split || []).length > 0;
  if (flow) {
    out.push('[data-pe-box] { display: flex !important; flex-direction: row !important; flex-wrap: wrap !important; align-items: flex-start; gap: 16px; }');
    out.push('[data-pe-box] > * { flex: 0 0 100%; min-width: 0; margin-top: 0 !important; margin-bottom: 0 !important; }');
    out.push('[data-pe-box] > .hub-tabs, [data-pe-box] > .pagehead, [data-pe-box] > .viewas-bar, [data-pe-box] > .lay-bar, [data-pe-box] > .card-h, [data-pe-box] > .tabs { order: -100; }');
  }
  (cfg?.order || []).forEach((k, i) => out.push(`[data-pe="${CSS.escape(k)}"] { order: ${i}; }`));
  keys.forEach((k) => {
    const v = b[k]; const s = `[data-pe="${CSS.escape(k)}"]`;
    if (v.span && v.span !== 12) out.push(`${s} { flex-basis: calc(${v.span / 12 * 100}% - ${16 * (12 - v.span) / 12}px) !important; }`);
    if (v.size && v.size !== 1) out.push(`${s} { zoom: ${v.size}; }`);
    if (v.hidden) out.push(edit ? `${s} { opacity: .35; outline: 2px dashed #b6c2d2; outline-offset: 2px; }` : `${s} { display: none !important; }`);
  });
  if (flow) out.push('@media (max-width: 760px) { [data-pe-box] > * { flex-basis: 100% !important; } }');
  if (edit) out.push('[data-pe].pe-hl { outline: 2px dashed var(--brand) !important; outline-offset: 3px; border-radius: 12px; } [data-pe].pe-sel { outline: 2px solid var(--brand) !important; outline-offset: 3px; border-radius: 12px; } .pe-split > [data-pe] { outline: 1px dashed #c9d3e0; outline-offset: 2px; border-radius: 8px; }');
  return out.join('\n');
}

// 浮窗位置 / 收起（本机记住）
const POS_KEY = 'la9s.pe.win';
const readWin = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch { return {}; } };
const clampPos = (x, y, w, h) => [Math.max(8, Math.min(x, window.innerWidth - Math.min(w, window.innerWidth - 16) - 8)), Math.max(8, Math.min(y, window.innerHeight - Math.min(h, 60) - 8))];

export default function PageEditorHost() {
  const { org, role, toast } = useApp();
  const edit = useLayoutEdit();
  const [page, setPage] = useState(pageKey);
  const [saved, setSaved] = useState({});      // 本页
  const [type, setType] = useState({});         // 全站字号
  const [draft, setDraft] = useState(null);     // 编辑中的本页
  const [tdraft, setTdraft] = useState(null);   // 编辑中的字号
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState('blocks');
  const [sel, setSel] = useState(null);
  const [win, setWin] = useState(readWin);      // { x, y, min }
  const [tb, setTb] = useState(null);            // 选中板块上的小工具条位置
  const [oneTable, setOneTable] = useState(false);
  const styleEl = useRef(null); const winEl = useRef(null);
  useEffect(() => { const f = () => setPage(pageKey()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const load = useCallback(async () => {
    const rs = await q(`select key, value from app.org_settings where org_id = $1 and (key = $2 or key = 'ui_type')`, [org, `layout2:${page}`]);
    const m = Object.fromEntries(rs.map((r) => [r.key, r.value]));
    setSaved(m[`layout2:${page}`] || {}); setType(m.ui_type || {});
  }, [org, page]);
  useEffect(() => { load().catch(() => {}); setDraft(null); setSel(null); }, [load]);
  useEffect(() => { if (!edit) { setDraft(null); setTdraft(null); setSel(null); } }, [edit]);
  const putWin = (w) => { setWin(w); try { localStorage.setItem(POS_KEY, JSON.stringify(w)); } catch { /* ignore */ } };

  const cfg = draft || saved;
  const tcfg = tdraft || type;
  const splitKey = JSON.stringify(cfg.split || []);
  // 页面变了就重新认板块
  useEffect(() => {
    if (!edit) return undefined;
    let raf = 0;
    const split = JSON.parse(splitKey);
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const r = scan(split); if (r) setOneTable(r.oneTable); if (r) setItems((old) => { const n = r.items.map(({ key, label: l, parent, canSplit, split: sp, auto }) => ({ key, label: l, parent, canSplit, split: !!sp, auto: !!auto })); return JSON.stringify(old) === JSON.stringify(n) ? old : n; }); }); };
    run();
    const m = document.querySelector('main.content');
    const ob = new MutationObserver((ms) => { if (ms.some((x) => !x.target.closest?.('.pe-tb'))) run(); });
    if (m) ob.observe(m, { childList: true, subtree: true });
    return () => { ob.disconnect(); cancelAnimationFrame(raf); };
  }, [page, edit, splitKey]);

  useEffect(() => {
    if (!styleEl.current) { styleEl.current = document.createElement('style'); styleEl.current.id = 'pe-style'; document.head.appendChild(styleEl.current); }
    styleEl.current.textContent = edit ? cssFor(cfg, tcfg, true) : '';
  }, [cfg, tcfg, edit, items]);

  // 编辑时：鼠标停在板块上虚线框，点一下选中（页面上冒出小工具条，改了马上看到）
  useEffect(() => {
    if (!edit) return undefined;
    const inUi = (t) => t.closest?.('.pe-win, .pe-tb, .modal-back, .overlay');
    const pick = (t) => { const all = []; let x = t.closest?.('[data-pe]'); while (x) { all.push(x); x = x.parentElement?.closest('[data-pe]'); } return all[0] || null; };
    const over = (e) => { if (inUi(e.target)) return; const b = pick(e.target); document.querySelectorAll('[data-pe].pe-hl').forEach((x) => x !== b && x.classList.remove('pe-hl')); if (b) b.classList.add('pe-hl'); };
    const down = (e) => { if (inUi(e.target)) return; const b = pick(e.target); if (b) setSel(b.dataset.pe); };
    document.addEventListener('pointerover', over); document.addEventListener('pointerdown', down, true);
    return () => { document.removeEventListener('pointerover', over); document.removeEventListener('pointerdown', down, true); document.querySelectorAll('.pe-hl').forEach((x) => x.classList.remove('pe-hl')); };
  }, [edit]);
  // 选中的板块：描边 + 工具条跟着它（滚动 / 改宽度都跟）
  useEffect(() => {
    document.querySelectorAll('[data-pe].pe-sel').forEach((x) => x.classList.remove('pe-sel'));
    if (!edit || !sel) { setTb(null); return undefined; }
    const el = document.querySelector(`[data-pe="${CSS.escape(sel)}"]`); if (!el) { setTb(null); return undefined; }
    el.classList.add('pe-sel');
    document.querySelector(`.pe-row[data-k="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'nearest' });
    let raf = 0;
    const place = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const r = el.getBoundingClientRect(); const z = parseFloat(getComputedStyle(el).zoom) || 1;
      setTb((o) => { const n = { top: Math.max(64, r.top * (z !== 1 ? 1 : 1) - 44), left: Math.max(8, Math.min(r.left, window.innerWidth - 620)), w: r.width, off: r.bottom < 60 || r.top > window.innerHeight }; return o && o.top === n.top && o.left === n.left && o.off === n.off ? o : n; }); }); };
    place();
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    const ro = new ResizeObserver(place); ro.observe(el); ro.observe(document.body);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [sel, edit, items, cfg]);
  // Esc：先取消选中，再关编辑
  useEffect(() => {
    if (!edit) return undefined;
    const k = (e) => { if (e.key !== 'Escape' || e.defaultPrevented) return; if (document.querySelector('.modal-back, .overlay')) return; e.preventDefault(); if (sel) setSel(null); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [edit, sel]);

  if (!edit || role !== 'admin') return null;
  const blk = (k) => cfg.blocks?.[k] || {};
  const setBlk = (k, patch) => setDraft((d) => { const x = structuredClone(d || saved || {}); x.blocks = { ...(x.blocks || {}), [k]: { ...(x.blocks?.[k] || {}), ...patch } }; return x; });
  // 顺序：同一层（同一个外框）里排
  const orderOf = (list) => { const ks = list.map((i) => i.key); const o = (cfg.order || []).filter((k) => ks.includes(k)); ks.forEach((k) => { if (!o.includes(k)) o.splice(Math.min(ks.indexOf(k), o.length), 0, k); }); return o.map((k) => list.find((i) => i.key === k)); };
  const top = orderOf(items.filter((i) => !i.parent));
  const kidsOf = (k) => orderOf(items.filter((i) => i.parent === k));
  const setOrder = (list) => setDraft((d) => { const x = { ...(d || saved || {}) }; const keep = (x.order || []).filter((k) => !list.includes(k)); x.order = [...keep, ...list]; return x; });
  const move = (k, dir) => { const it = items.find((i) => i.key === k); if (!it) return; const sib = it.parent ? kidsOf(it.parent) : top; const i = sib.findIndex((x) => x.key === k); const j = i + dir; if (j < 0 || j >= sib.length) return; const n = sib.map((x) => x.key); [n[i], n[j]] = [n[j], n[i]]; setOrder(n); };
  const toggleSplit = (k) => setDraft((d) => { const x = { ...(d || saved || {}) }; const sp = new Set(x.split || []); if (sp.has(k)) sp.delete(k); else sp.add(k); x.split = [...sp]; return x; });
  const changes = (() => { let n = 0; if (draft) { const a = JSON.stringify(saved.order || []) !== JSON.stringify(draft.order || saved.order || []); n += a ? 1 : 0; Object.keys(draft.blocks || {}).forEach((k) => { if (JSON.stringify(draft.blocks[k]) !== JSON.stringify(saved.blocks?.[k] || {})) n += 1; }); if (JSON.stringify(draft.split || []) !== JSON.stringify(saved.split || [])) n += 1; } if (tdraft) n += TYPE_CATS.filter(([k]) => Number(tdraft[k] || 1) !== Number(type[k] || 1)).length; return n; })();
  const dirty = changes > 0;
  const save = async () => {
    try {
      if (draft) await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `layout2:${page}`, JSON.stringify(draft)]);
      if (tdraft) await call(role, `select app.set_org_setting($1,$2,$3)`, [org, 'ui_type', JSON.stringify(tdraft)]);
      await load(); setDraft(null); setTdraft(null); toast('已保存，所有人看到的都一样（变更记录里有）');
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const resetPage = async () => {
    try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `layout2:${page}`, null]); await load(); setDraft(null); toast('本页已恢复默认'); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const h1 = document.querySelector('main.content .pagehead h1');
  const title = (h1 ? [...h1.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '') || page;
  const selIt = items.find((i) => i.key === sel);
  const selLabel = selIt?.label || '';
  // 拖浮窗：按住标题栏拖
  const drag = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = winEl.current.getBoundingClientRect(); const dx = e.clientX - r.left; const dy = e.clientY - r.top;
    const mv = (ev) => { const [x, y] = clampPos(ev.clientX - dx, ev.clientY - dy, r.width, r.height); winEl.current.style.left = `${x}px`; winEl.current.style.top = `${y}px`; winEl.current.style.right = 'auto'; winEl.current.style.bottom = 'auto'; };
    const up = (ev) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); const [x, y] = clampPos(ev.clientX - dx, ev.clientY - dy, r.width, r.height); putWin({ ...win, x, y }); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const pos = win.x != null ? (() => { const [x, y] = clampPos(win.x, win.y, 320, 200); return { left: x, top: y }; })() : { right: 16, bottom: 16 };
  const b = sel ? blk(sel) : {};
  const sib = selIt ? (selIt.parent ? kidsOf(selIt.parent) : top) : [];
  const si = sib.findIndex((x) => x.key === sel);
  const Row = ({ r, depth }) => { const bb = blk(r.key); return (
    <div className={`pe-row ${sel === r.key ? 'on' : ''} ${bb.hidden ? 'off' : ''}`} data-k={r.key} style={depth ? { marginLeft: 14 } : null}
      onMouseEnter={() => document.querySelector(`[data-pe="${CSS.escape(r.key)}"]`)?.classList.add('pe-hl')} onMouseLeave={() => document.querySelector(`[data-pe="${CSS.escape(r.key)}"]`)?.classList.remove('pe-hl')}
      onClick={() => { setSel(r.key); document.querySelector(`[data-pe="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}>
      <span className="pe-row-n">{r.label}</span>
      {(bb.span && bb.span !== 12) ? <span className="pe-tag">{SPANS.find((x) => x[0] === bb.span)?.[1]}</span> : null}
      {(bb.size && bb.size !== 1) ? <span className="pe-tag">{SIZES.find((x) => x[0] === bb.size)?.[1]}</span> : null}
      <button type="button" className={`pe-eye ${bb.hidden ? 'off' : ''}`} title={bb.hidden ? '已隐藏，点一下显示' : '隐藏'} aria-label={bb.hidden ? '显示' : '隐藏'} onClick={(e) => { e.stopPropagation(); setBlk(r.key, { hidden: !bb.hidden }); }}>{bb.hidden ? '◌' : '●'}</button>
    </div>); };
  const tree = (list, depth = 0) => list.map((r) => <React.Fragment key={r.key}><Row r={r} depth={depth} />{r.split && tree(kidsOf(r.key), depth + 1)}</React.Fragment>);
  return (<>
    {tb && sel && !tb.off && <div className="pe-tb" style={{ top: tb.top, left: tb.left }} onPointerDown={(e) => e.stopPropagation()}>
      <b className="pe-tb-n" title={selLabel}>{selLabel}</b>
      <button type="button" className="btn xs" disabled={si <= 0} title="往前挪" onClick={() => move(sel, -1)}>↑</button>
      <button type="button" className="btn xs" disabled={si < 0 || si >= sib.length - 1} title="往后挪" onClick={() => move(sel, 1)}>↓</button>
      <span className="pe-tb-sep" />
      <div className="seg xs" title="宽度（手机上一律整行）">{SPANS.map(([v, l]) => <button type="button" key={v} className={(b.span || 12) === v ? 'on' : ''} onClick={() => setBlk(sel, { span: v })}>{l}</button>)}</div>
      <div className="seg xs" title="这一块的字和数字一起放大缩小">{SIZES.map(([v, l]) => <button type="button" key={v} className={(b.size || 1) === v ? 'on' : ''} onClick={() => setBlk(sel, { size: v })}>{l}</button>)}</div>
      <button type="button" className={`btn xs ${b.hidden ? 'primary' : ''}`} onClick={() => setBlk(sel, { hidden: !b.hidden })}>{b.hidden ? '显示' : '隐藏'}</button>
      {selIt?.canSplit && !selIt.auto && <button type="button" className="btn xs" title={selIt.split ? '里面的小块合回一整块' : '把这张卡片里面的小块分开，单独排 / 调宽 / 隐藏'} onClick={() => toggleSplit(sel)}>{selIt.split ? '合起来' : '拆开'}</button>}
      <button type="button" className="close-x sm" aria-label="取消选中" onClick={() => setSel(null)}>✕</button>
    </div>}
    <div ref={winEl} className={`pe-win ${win.min ? 'min' : ''}`} style={pos} role="dialog" aria-label="页面编辑">
      <div className="pe-h" onPointerDown={drag} title="按住这里可以拖到别处">
        <span className="pe-grip">⋮⋮</span><b>页面编辑</b><span className="muted small">{title}</span><span className="grow" />
        {dirty && <span className="pill amber">{changes} 处没保存</span>}
        <button type="button" className="pe-ic" aria-label={win.min ? '展开' : '收起'} title={win.min ? '展开' : '收起成一条，页面看得更全'} onClick={() => putWin({ ...win, min: !win.min })}>{win.min ? '▢' : '–'}</button>
        <button type="button" className="pe-ic" aria-label="关" title={dirty ? '关掉 = 没保存的改动不要了' : '关'} onClick={() => setLayoutEdit(false)}>✕</button></div>
      {!win.min && <>
        <div className="seg sm pe-tabs">{[['blocks', '本页板块'], ['type', '全站字号']].map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="pe-body">
          {tab === 'blocks' ? (<>
            <div className="small muted">在页面上点哪块，哪块上面就出小工具条，改了马上看到。 <Info>拖：按住这个小窗的标题栏拖到不挡的地方；「–」收起成一条。页面标题和顶上的页签固定不动；手机上所有板块都占整行。卡片里面还有小块的，点「拆开」就能把里面的分开调。改完点「保存」才对所有人生效，改动会进「变更记录」。</Info></div>
            {items.length <= 1 && <div className="empty">{oneTable ? <>这一页就是一张表，没有别的块可排。<br />表格的列：表格右上角「列」里显示 / 隐藏，表头拖动调顺序；字大小在上面「全站字号 → 表格」。</> : '这一页只有一块，没什么可排的。字号可以在「全站字号」里调。'}</div>}
            {items.length > 1 && <div className="pe-list">{tree(top)}</div>}
          </>) : (<>
            <div className="small muted">全站一起变，所有页面、所有人。</div>
            {TYPE_CATS.map(([k, l, , hint]) => { const v = Number(tcfg[k] || 1); return (
              <div key={k} className="pe-type">
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><b>{l}</b><span className="muted small pe-hint">{hint}</span><span className="grow" /><b className="pe-pct">{Math.round(v * 100)}%</b></div>
                <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <button type="button" className="btn xs" onClick={() => setTdraft({ ...tcfg, [k]: Math.max(0.8, +(v - 0.05).toFixed(2)) })}>A−</button>
                  <input type="range" min={80} max={150} step={5} value={Math.round(v * 100)} onChange={(e) => setTdraft({ ...tcfg, [k]: Number(e.target.value) / 100 })} style={{ flex: 1, minWidth: 0 }} aria-label={l} />
                  <button type="button" className="btn xs" onClick={() => setTdraft({ ...tcfg, [k]: Math.min(1.5, +(v + 0.05).toFixed(2)) })}>A＋</button>
                </div>
              </div>); })}
            <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setTdraft({})}>字号全部恢复 100%</button>
          </>)}
        </div>
        <div className="pe-foot">
          {tab === 'blocks' && <ConfirmBtn className="btn sm ghost" title="本页恢复默认？" body="这一页的顺序、宽度、隐藏、拆开全部回到原样，所有人一起变。" onOk={resetPage}>本页恢复默认</ConfirmBtn>}
          <span className="grow" />
          {dirty && <button type="button" className="btn sm" onClick={() => { setDraft(null); setTdraft(null); }}>不改了</button>}
          <button type="button" className="btn sm primary" disabled={!dirty} title={dirty ? '' : '还没改东西'} onClick={save}>保存（所有人）</button>
        </div>
      </>}
    </div>
  </>);
}

// 不在编辑时也要按保存的设置显示：PageEditorHost 只在编辑时出面板，样式另由 PageStyle 常驻
export function PageStyle() {
  const { org, tick } = useApp();
  const edit = useLayoutEdit();
  const [page, setPage] = useState(pageKey);
  const [state, setState] = useState({ cfg: {}, type: {} });
  const el = useRef(null);
  useEffect(() => { const f = () => setPage(pageKey()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => {
    if (edit) return;
    q(`select key, value from app.org_settings where org_id = $1 and (key = $2 or key = 'ui_type')`, [org, `layout2:${page}`]).then((rs) => {
      const m = Object.fromEntries(rs.map((r) => [r.key, r.value])); setState({ cfg: m[`layout2:${page}`] || {}, type: m.ui_type || {} });
    }).catch(() => {});
  }, [org, page, edit, tick]);
  const css = useMemo(() => cssFor(state.cfg, state.type, false), [state]);
  useEffect(() => {
    if (edit) { if (el.current) el.current.textContent = ''; return undefined; }
    if (!el.current) { el.current = document.createElement('style'); el.current.id = 'pe-style-live'; document.head.appendChild(el.current); }
    el.current.textContent = css;
    // 打 data-pe 标记（React 换页 / 刷新后重新打）
    let raf = 0; const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => scan(state.cfg?.split || [])); };
    run(); const m = document.querySelector('main.content'); const ob = new MutationObserver(run); if (m) ob.observe(m, { childList: true, subtree: true });
    return () => { ob.disconnect(); cancelAnimationFrame(raf); };
  }, [css, edit, page, state]);
  return null;
}
