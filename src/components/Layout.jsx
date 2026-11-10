// 页面布局编辑 (Frank 2026-11-01): 每页拆成板块, 中方在「布局编辑」模式下调整:
//  · 板块顺序 (拖标题条, 或 ↑↓)、宽度 (12 列网格吸附: 3 / 4 / 6 / 8 / 12)、显示 / 隐藏、板块间距
//  · 每页单独保存在 org_settings 'layout:<页面>', 全员一致; 「锁定为正式版」后不能再改, 要先解锁
//  · 不做像素级自由拖动 (Frank 已接受); 颜色固定品牌蓝
//  · 手机: 窄板块 (≤ 4 列) 两个一排, 其余整行, 不会全部挤成一列
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp } from './ui.jsx';
import { friendlyError } from '../lib/format.js';

const EDIT_KEY = 'la9s.layoutEdit';
const readEdit = () => { try { return localStorage.getItem(EDIT_KEY) === '1'; } catch { return false; } };
const listeners = new Set();
export function setLayoutEdit(on) {
  try { on ? localStorage.setItem(EDIT_KEY, '1') : localStorage.removeItem(EDIT_KEY); } catch { /* 浏览器禁存储: 只在本页有效 */ }
  window.__la9sLayoutEdit = on; listeners.forEach((f) => f(on));
}
export function useLayoutEdit() {
  const { role } = useApp();
  const [on, setOn] = useState(() => window.__la9sLayoutEdit ?? readEdit());
  useEffect(() => { listeners.add(setOn); return () => listeners.delete(setOn); }, []);
  return role === 'admin' && on;
}

const SPANS = [3, 4, 6, 8, 12];
const Ctx = createContext(null);

// blocks: [{ id, title, span (默认宽度), render: () => node, locked (不能隐藏), hidden (默认隐藏) }]
export function LayoutGrid({ page, blocks, defaultGap = 16 }) {
  const { org, role, toast, tick } = useApp();
  const edit = useLayoutEdit();
  const [saved, setSaved] = useState(undefined);   // undefined = 加载中
  const [draft, setDraft] = useState(null);
  const [drag, setDrag] = useState(null);
  useEffect(() => {
    let alive = true;
    q(`select value from app.org_settings where org_id = $1 and key = $2`, [org, 'layout:' + page]).then((r) => alive && setSaved(r[0]?.value || null));
    return () => { alive = false; };
  }, [org, page, tick]);
  useEffect(() => { if (!edit) setDraft(null); }, [edit]);

  const cfg = draft || saved || {};
  const order = useMemo(() => {
    const ids = blocks.map((b) => b.id);
    const o = (cfg.order || []).filter((id) => ids.includes(id));
    for (const id of ids) if (!o.includes(id)) o.splice(Math.min(ids.indexOf(id), o.length), 0, id);   // 新板块按默认位置出现
    return o;
  }, [blocks, cfg.order]);
  const spanOf = (b) => cfg.span?.[b.id] ?? b.span ?? 12;
  const hiddenOf = (b) => !b.locked && (cfg.hidden?.[b.id] ?? !!b.hidden);
  const gap = cfg.gap ?? defaultGap;
  const locked = !!saved?.locked;
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  if (saved === undefined) return null;

  const mut = (f) => setDraft((d) => { const x = structuredClone(d || saved || {}); x.order = x.order || [...order]; f(x); return x; });
  const move = (id, to) => mut((x) => { const i = x.order.indexOf(id); if (i < 0 || to < 0 || to >= x.order.length) return; x.order.splice(i, 1); x.order.splice(to, 0, id); });
  const save = async (value, msg) => {
    try {
      await call(role, `select app.set_org_setting($1,$2,$3)`, [org, 'layout:' + page, value == null ? null : JSON.stringify(value)]);
      setSaved(value); setDraft(null); toast(msg);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const canEdit = edit && !locked;
  const visible = order.map((id) => byId[id]).filter((b) => b && (edit || !hiddenOf(b)));

  return (
    <Ctx.Provider value={{ page }}>
      {edit && (
        <div className="lay-bar">
          <b>布局编辑 · {page}</b>
          {locked ? <span className="pill green">已锁定为正式版</span> : <span className="small">拖板块标题条换位置；点宽度数字调宽（12 = 整行）；手机端会自动重排</span>}
          <span className="grow" />
          {!locked && <label className="small row" style={{ gap: 6 }}>板块间距
            <input type="range" min="6" max="32" step="2" value={gap} onChange={(e) => mut((x) => { x.gap = Number(e.target.value); })} /><b>{gap}px</b></label>}
          {!locked && <button type="button" className="btn sm" onClick={() => save(null, '这一页已恢复默认布局')}>恢复默认</button>}
          {!locked && <button type="button" className="btn sm primary" disabled={!draft} onClick={() => save({ ...cfg, order }, '布局已保存，所有人刷新后生效')}>保存</button>}
          {locked
            ? <button type="button" className="btn sm" onClick={() => save({ ...saved, locked: false }, '已解锁，可以再改')}>解锁</button>
            : <button type="button" className="btn sm" disabled={!!draft} title={draft ? '先保存' : ''} onClick={() => save({ ...cfg, order, locked: true }, '已锁定为正式版')}>锁定为正式版</button>}
          <button type="button" className="btn sm ghost" onClick={() => setLayoutEdit(false)}>退出编辑</button>
        </div>)}
      <div className="lay-grid" style={{ gap }}>
        {visible.map((b) => {
          const span = spanOf(b); const hid = hiddenOf(b); const i = order.indexOf(b.id);
          return (
            <section key={b.id} className={`lay-block s${span} ${span <= 4 ? 'narrow' : ''} ${edit ? 'editing' : ''} ${hid ? 'hid' : ''} ${drag === b.id ? 'dragging' : ''}`}
              style={{ gridColumn: `span ${span}` }}
              onDragOver={canEdit && drag ? (e) => e.preventDefault() : undefined}
              onDrop={canEdit && drag ? (e) => { e.preventDefault(); if (drag !== b.id) move(drag, i); setDrag(null); } : undefined}>
              {edit && (
                <div className="lay-head" draggable={canEdit} onDragStart={() => setDrag(b.id)} onDragEnd={() => setDrag(null)}>
                  <span className="grip">⠿</span><b>{b.title}</b>{b.locked && <span className="small muted">（常开）</span>}
                  <span className="grow" />
                  {canEdit && <>
                    <span className="spans">{SPANS.map((s) => <button type="button" key={s} className={s === span ? 'on' : ''} onClick={() => mut((x) => { x.span = { ...x.span, [b.id]: s }; })}>{s}</button>)}</span>
                    <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => move(b.id, i - 1)}>↑</button>
                    <button type="button" className="btn sm ghost" disabled={i === order.length - 1} onClick={() => move(b.id, i + 1)}>↓</button>
                    {!b.locked && <button type="button" className="btn sm ghost" onClick={() => mut((x) => { x.hidden = { ...x.hidden, [b.id]: !hid }; })}>{hid ? '显示' : '隐藏'}</button>}
                  </>}
                </div>)}
              {hid ? <div className="lay-hidden">已隐藏（只有布局编辑时看得到）</div> : b.render()}
            </section>);
        })}
      </div>
    </Ctx.Provider>
  );
}
export const useLayoutPage = () => useContext(Ctx)?.page;
