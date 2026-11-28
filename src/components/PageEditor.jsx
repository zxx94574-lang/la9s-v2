// 页面编辑（Frank 11-28：「有些页面能调，有些调不了」→ 每一页都能调；外加全站字号）
// 不靠逐页改代码：打开后自动认出当前页面的板块（页面标题 / 页签固定在顶上，下面的卡片、分段 = 板块；
// 外面多包了一层的（我的待办、月报）再往里看一层），每块能 拖顺序 / 调宽度 / 隐藏 / 调大小。
// 全站字号：页面标题、板块标题、大数字、表格、侧栏、整体内容 各一个比例。
// 存法：本页 org_settings `layout2:<页面>`，全站字号 `ui_type`；保存后所有人一致；只中方能改。
// 经营总览原来那套页面内拖板块（components/Layout.jsx）照旧，跟着同一个开关打开。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, SortList, Info } from './ui.jsx';
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

// 认板块：返回 { box, items: [{ key, label, el }] }
function scan() {
  const m = document.querySelector('main.content'); if (!m) return null;
  let box = m;
  let kids = [...box.children].filter((e) => !e.matches(FIXED));
  if (kids.length === 1 && !kids[0].matches('.card, .lay-grid') && kids[0].children.length >= 3) { box = kids[0]; kids = [...box.children].filter((e) => !e.matches(FIXED)); }
  const seen = {};
  const items = kids.map((el) => {
    const txt = headText(el);
    const cls = [...el.classList].filter((c) => !['card', 'row', 'stack', 'pe-hl', 'pe-sel'].includes(c))[0] || el.tagName.toLowerCase();
    let key = `${cls}|${keyText(txt)}`; seen[key] = (seen[key] || 0) + 1; if (seen[key] > 1) key += `#${seen[key]}`;
    el.dataset.pe = key;
    const NAMED = { pgsum: '小总览', 'mt-strip': '指标条', 'd2-attn': '要你注意的', tabs: '页签', digest: '今日数字', 'rp-kpis': '关键数' };
    const label = el.matches('.lay-grid') ? '看板（里面的小板块在页面上直接拖）' : (NAMED[cls] || txt || cls);
    return { key, label, el };
  });
  box.dataset.peBox = '1';
  return { box, items };
}

function cssFor(cfg, type, edit) {
  const out = [];
  const t = type || {};
  TYPE_CATS.forEach(([k, , sel]) => { const z = Number(t[k] || 1); if (z && z !== 1) out.push(`${sel} { zoom: ${z}; }`); });
  const b = cfg?.blocks || {};
  const keys = Object.keys(b);
  const flow = edit || keys.some((k) => b[k].span && b[k].span !== 12) || Array.isArray(cfg?.order);
  if (flow) {
    out.push('[data-pe-box] { display: flex !important; flex-direction: row !important; flex-wrap: wrap !important; align-items: flex-start; gap: 16px; }');
    out.push('[data-pe-box] > * { flex: 0 0 100%; min-width: 0; margin-top: 0 !important; margin-bottom: 0 !important; }');
    out.push('[data-pe-box] > .hub-tabs, [data-pe-box] > .pagehead, [data-pe-box] > .viewas-bar, [data-pe-box] > .lay-bar { order: -100; }');
  }
  (cfg?.order || []).forEach((k, i) => out.push(`[data-pe="${CSS.escape(k)}"] { order: ${i}; }`));
  keys.forEach((k) => {
    const v = b[k]; const s = `[data-pe="${CSS.escape(k)}"]`;
    if (v.span && v.span !== 12) out.push(`${s} { flex-basis: calc(${v.span / 12 * 100}% - ${16 * (12 - v.span) / 12}px) !important; }`);
    if (v.size && v.size !== 1) out.push(`${s} { zoom: ${v.size}; }`);
    if (v.hidden) out.push(edit ? `${s} { opacity: .35; outline: 2px dashed #b6c2d2; outline-offset: 2px; }` : `${s} { display: none !important; }`);
  });
  if (flow) out.push('@media (max-width: 760px) { [data-pe-box] > * { flex-basis: 100% !important; } }');
  if (edit) out.push('[data-pe].pe-hl, [data-pe].pe-sel { outline: 2px solid var(--brand) !important; outline-offset: 3px; border-radius: 12px; }');
  return out.join('\n');
}

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
  const styleEl = useRef(null);
  useEffect(() => { const f = () => setPage(pageKey()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const load = useCallback(async () => {
    const rs = await q(`select key, value from app.org_settings where org_id = $1 and (key = $2 or key = 'ui_type')`, [org, `layout2:${page}`]);
    const m = Object.fromEntries(rs.map((r) => [r.key, r.value]));
    setSaved(m[`layout2:${page}`] || {}); setType(m.ui_type || {});
  }, [org, page]);
  useEffect(() => { load().catch(() => {}); setDraft(null); setSel(null); }, [load]);
  useEffect(() => { if (!edit) { setDraft(null); setTdraft(null); } document.body.classList.toggle('pe-editing', !!edit && role === 'admin'); return () => document.body.classList.remove('pe-editing'); }, [edit, role]);

  // 页面变了就重新认板块
  useEffect(() => {
    if (!edit) return undefined;
    let raf = 0;
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const r = scan(); if (r) setItems((old) => { const n = r.items.map(({ key, label }) => ({ key, label })); return JSON.stringify(old) === JSON.stringify(n) ? old : n; }); }); };
    run();
    const m = document.querySelector('main.content');
    const ob = new MutationObserver(run);
    if (m) ob.observe(m, { childList: true, subtree: true });
    return () => { ob.disconnect(); cancelAnimationFrame(raf); };
  }, [page, edit]);

  const cfg = draft || saved;
  const tcfg = tdraft || type;
  useEffect(() => {
    if (!styleEl.current) { styleEl.current = document.createElement('style'); styleEl.current.id = 'pe-style'; document.head.appendChild(styleEl.current); }
    styleEl.current.textContent = edit ? cssFor(cfg, tcfg, true) : '';
  }, [cfg, tcfg, edit, items]);

  // 编辑时：鼠标停在板块上 / 点板块，在面板里对上
  useEffect(() => {
    if (!edit) return undefined;
    const over = (e) => { const b = e.target.closest?.('[data-pe]'); document.querySelectorAll('[data-pe].pe-hl').forEach((x) => x !== b && x.classList.remove('pe-hl')); if (b && !e.target.closest('.pe-dock')) b.classList.add('pe-hl'); };
    const down = (e) => { if (e.target.closest('.pe-dock')) return; const b = e.target.closest?.('[data-pe]'); if (b) setSel(b.dataset.pe); };
    document.addEventListener('pointerover', over); document.addEventListener('pointerdown', down, true);
    return () => { document.removeEventListener('pointerover', over); document.removeEventListener('pointerdown', down, true); document.querySelectorAll('.pe-hl').forEach((x) => x.classList.remove('pe-hl')); };
  }, [edit]);
  useEffect(() => {
    document.querySelectorAll('[data-pe].pe-sel').forEach((x) => x.classList.remove('pe-sel'));
    if (edit && sel) { const el = document.querySelector(`[data-pe="${CSS.escape(sel)}"]`); el?.classList.add('pe-sel'); document.querySelector(`.pe-row[data-k="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  }, [sel, edit, items]);

  if (!edit || role !== 'admin') return null;
  const order = (() => { const ks = items.map((i) => i.key); const o = (cfg.order || []).filter((k) => ks.includes(k)); ks.forEach((k) => { if (!o.includes(k)) o.splice(Math.min(ks.indexOf(k), o.length), 0, k); }); return o; })();
  const rows = order.map((k) => items.find((i) => i.key === k)).filter(Boolean);
  const blk = (k) => cfg.blocks?.[k] || {};
  const setBlk = (k, patch) => setDraft((d) => { const x = structuredClone(d || saved || {}); x.blocks = { ...(x.blocks || {}), [k]: { ...(x.blocks?.[k] || {}), ...patch } }; return x; });
  const dirty = !!draft || !!tdraft;
  const save = async () => {
    try {
      if (draft) await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `layout2:${page}`, JSON.stringify(draft)]);
      if (tdraft) await call(role, `select app.set_org_setting($1,$2,$3)`, [org, 'ui_type', JSON.stringify(tdraft)]);
      await load(); setDraft(null); setTdraft(null); toast('已保存，所有人看到的都一样');
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const resetPage = async () => {
    try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `layout2:${page}`, null]); await load(); setDraft(null); toast('本页已恢复默认'); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const h1 = document.querySelector('main.content .pagehead h1');
  const title = (h1 ? [...h1.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '') || page;
  return (
    <div className="pe-dock" role="dialog" aria-label="页面编辑">
      <div className="pe-h"><b>页面编辑</b><span className="muted small">{title}</span><span className="grow" /><button type="button" className="close-x sm" aria-label="关" onClick={() => setLayoutEdit(false)}>✕</button></div>
      <div className="seg sm pe-tabs">{[['blocks', '本页板块'], ['type', '全站字号']].map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="pe-body">
        {tab === 'blocks' ? (<>
          <div className="small muted">拖 ⋮⋮ 调顺序；页面上点哪块，这里就对上哪块。 <Info>页面标题和顶上的页签固定不动。手机上所有板块都占整行。改完点下面「保存」才对所有人生效；不保存关掉就作废。</Info></div>
          {rows.length <= 1 && <div className="empty">这一页只有一块，没什么可排的。字号可以在「全站字号」里调。</div>}
          {rows.length > 1 && <SortList items={rows} keyOf={(r) => r.key} gap={6} onChange={(n) => setDraft((d) => ({ ...(d || saved || {}), order: n.map((r) => r.key) }))} render={(r) => {
            const b = blk(r.key);
            return (
              <div className={`pe-row ${sel === r.key ? 'on' : ''} ${b.hidden ? 'off' : ''}`} data-k={r.key} onMouseEnter={() => document.querySelector(`[data-pe="${CSS.escape(r.key)}"]`)?.classList.add('pe-hl')} onMouseLeave={() => document.querySelector(`[data-pe="${CSS.escape(r.key)}"]`)?.classList.remove('pe-hl')} onClick={() => { setSel(r.key); document.querySelector(`[data-pe="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}>
                <div className="pe-row-h"><b>{r.label}</b><span className="grow" />
                  <button type="button" className={`btn sm ${b.hidden ? '' : 'ghost'}`} onClick={(e) => { e.stopPropagation(); setBlk(r.key, { hidden: !b.hidden }); }}>{b.hidden ? '已隐藏 · 点开' : '隐藏'}</button></div>
                <div className="pe-row-c" onClick={(e) => e.stopPropagation()}>
                  <span className="muted small">宽</span><div className="seg xs">{SPANS.map(([v, l]) => <button type="button" key={v} className={(b.span || 12) === v ? 'on' : ''} onClick={() => setBlk(r.key, { span: v })}>{l}</button>)}</div>
                  <span className="muted small">大小</span><div className="seg xs">{SIZES.map(([v, l]) => <button type="button" key={v} className={(b.size || 1) === v ? 'on' : ''} onClick={() => setBlk(r.key, { size: v })}>{l}</button>)}</div>
                </div>
              </div>);
          }} />}
        </>) : (<>
          <div className="small muted">全站一起变，所有页面、所有人。</div>
          {TYPE_CATS.map(([k, l, , hint]) => { const v = Number(tcfg[k] || 1); return (
            <div key={k} className="pe-type">
              <div className="row" style={{ gap: 6 }}><b>{l}</b><span className="muted small">{hint}</span><span className="grow" /><b className="pe-pct">{Math.round(v * 100)}%</b></div>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <button type="button" className="btn sm" onClick={() => setTdraft({ ...tcfg, [k]: Math.max(0.8, +(v - 0.05).toFixed(2)) })}>A−</button>
                <input type="range" min={80} max={150} step={5} value={Math.round(v * 100)} onChange={(e) => setTdraft({ ...tcfg, [k]: Number(e.target.value) / 100 })} style={{ flex: 1 }} aria-label={l} />
                <button type="button" className="btn sm" onClick={() => setTdraft({ ...tcfg, [k]: Math.min(1.5, +(v + 0.05).toFixed(2)) })}>A＋</button>
              </div>
            </div>); })}
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setTdraft({})}>字号全部恢复 100%</button>
        </>)}
      </div>
      <div className="pe-foot">
        {tab === 'blocks' && <button type="button" className="btn sm ghost" onClick={resetPage}>本页恢复默认</button>}
        <span className="grow" />
        {dirty && <button type="button" className="btn sm" onClick={() => { setDraft(null); setTdraft(null); }}>不改了</button>}
        <button type="button" className="btn sm primary" disabled={!dirty} title={dirty ? '' : '还没改东西'} onClick={save}>保存（所有人）</button>
      </div>
    </div>);
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
    let raf = 0; const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(scan); };
    run(); const m = document.querySelector('main.content'); const ob = new MutationObserver(run); if (m) ob.observe(m, { childList: true, subtree: true });
    return () => { ob.disconnect(); cancelAnimationFrame(raf); };
  }, [css, edit, page]);
  return null;
}
