// 253 / 256 (Frank 11-12): 飞书多维表格式筛选 —— 一个筛选图标, 面板里一行一个条件 (字段 + 关系 + 值), 可叠加, 符合所有 / 任一;
// 选值的下拉: 第一行冻结搜索框, 点一下选中、再点取消, 可多选; 条件只影响自己 (存在本机这个岗位下); 筛选方案按个人存, 中方可推公司共用
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { q, call } from '../db/client.js';
import { useApp, useData, SortList } from './ui.jsx';
import { friendlyError } from '../lib/format.js';

export const OPS_PICK = [['in', '等于（其中之一）'], ['not_in', '不等于'], ['contains', '包含'], ['not_contains', '不包含'], ['empty', '为空'], ['not_empty', '不为空']];
export const OPS_NUM = [['eq', '等于'], ['ne', '不等于'], ['gt', '大于'], ['lt', '小于'], ['between', '介于'], ['empty', '为空'], ['not_empty', '不为空']];
const NO_VAL = ['empty', 'not_empty'];
export const condReady = (f) => !!f.key && (NO_VAL.includes(f.op) || (['in', 'not_in'].includes(f.op) ? (f.vals || []).length > 0 : String(f.a ?? '') !== ''));
let SEQ = 1; export const newCond = (key = '', num = false) => ({ id: 'c' + Date.now() + (SEQ += 1), key, op: num ? 'gt' : 'in', a: '', b: '', vals: [] });
// 一格可能有几个值 (例: 一张单的机型「BF7 / BG6M」) → 拆开当选项
export const splitVals = (raw) => String(raw ?? '').split(/\s+\/\s+|\s*[、;]\s*/).map((x) => x.trim()).filter(Boolean);

function usePop(open, onClose) {
  const ref = useRef();
  useEffect(() => { if (!open) return undefined; const h = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.gf-keep')) onClose(); }; const t = setTimeout(() => document.addEventListener('pointerdown', h), 0); return () => { clearTimeout(t); document.removeEventListener('pointerdown', h); }; }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}
// 多选值: 搜索框冻结在最上面
export function ValuePick({ options, value = [], onChange, placeholder = '选值' }) {
  const [open, setOpen] = useState(false); const [t, setT] = useState(''); const [at, setAt] = useState(null); const btn = useRef();
  const ref = usePop(open, () => setOpen(false));
  const list = useMemo(() => { const u = t.trim().toUpperCase(); return options.filter((o) => !u || o.toUpperCase().includes(u)); }, [options, t]);
  const tog = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const show = () => { const r = btn.current.getBoundingClientRect(); const w = Math.max(240, r.width); setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: Math.min(r.bottom + 4, window.innerHeight - 340), width: w }); setOpen(true); };
  return (<>
    <button type="button" ref={btn} className={`gf-val ${value.length ? 'on' : ''}`} onClick={() => (open ? setOpen(false) : show())} title={value.join('、')}>
      {value.length === 0 ? <span className="muted">{placeholder}</span> : value.length <= 2 ? value.map((v) => <span key={v} className="pill blue">{v}</span>) : <><span className="pill blue">{value[0]}</span><span className="pill blue">等 {value.length} 个</span></>}<span className="gf-caret">▾</span></button>
    {open && at && createPortal(
      <div className="menu gf-pick gf-keep" ref={ref} style={{ position: 'fixed', left: at.left, top: at.top, width: at.width, zIndex: 420 }}>
        <div className="gf-pick-search"><input className="in sm" autoFocus placeholder="⌕ 搜索" value={t} onChange={(e) => setT(e.target.value)} />
          <span className="small muted">{value.length ? `已选 ${value.length}` : `${list.length} 项`}</span>{value.length > 0 && <button type="button" className="btn sm ghost" onClick={() => onChange([])}>清空</button>}</div>
        <div className="gf-pick-list">{list.slice(0, 300).map((v) => <button type="button" key={v} className={`mi ${value.includes(v) ? 'focus' : ''}`} onClick={() => tog(v)}><span className="gf-check">{value.includes(v) ? '✓' : ''}</span><span>{v}</span></button>)}
          {!list.length && <div className="hint" style={{ padding: 8 }}>没有匹配的</div>}{list.length > 300 && <div className="hint" style={{ padding: 8 }}>还有 {list.length - 300} 项，再输几个字缩小范围</div>}</div>
      </div>, document.body)}
  </>);
}

export function FilterPanel({ at, cols, isNum, optionsOf, conds, setConds, any, setAny, onClose, schemes }) {
  const ref = usePop(true, onClose);
  const upd = (id, patch) => setConds(conds.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const colOf = (k) => cols.find((c) => c.key === k);
  return createPortal(
    <div className="menu gf-panel gf-keep" ref={ref} style={{ position: 'fixed', left: at.left, top: at.top, zIndex: 400, maxHeight: `calc(100vh - ${at.top + 12}px)` }} onClick={(e) => e.stopPropagation()}>
      <div className="gf-head"><b>设置筛选条件</b><span className="grow" /><button type="button" className="btn sm ghost" onClick={onClose}>✕</button></div>
      <div className="gf-mode">符合以下 <select className="in sm" value={any ? 'any' : 'all'} onChange={(e) => setAny(e.target.value === 'any')}><option value="all">所有</option><option value="any">任一</option></select> 条件</div>
      <div className="gf-rows">{conds.map((f) => { const c = colOf(f.key); const num = c && isNum(c); const ops = num ? OPS_NUM : OPS_PICK; return (
        <div key={f.id} className="gf-row">
          <select className="in sm gf-col" value={f.key} onChange={(e) => { const nc = colOf(e.target.value); const n = nc && isNum(nc); upd(f.id, { key: e.target.value, op: n ? 'gt' : 'in', a: '', b: '', vals: [] }); }}>
            <option value="">选字段…</option>{cols.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
          <select className="in sm gf-op" value={f.op} disabled={!c} onChange={(e) => upd(f.id, { op: e.target.value })}>{ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <span className="gf-value">{!c || NO_VAL.includes(f.op) ? null : ['in', 'not_in'].includes(f.op) ? <ValuePick options={optionsOf(c)} value={f.vals || []} onChange={(v) => upd(f.id, { vals: v })} />
            : <><input className="in sm" value={f.a ?? ''} inputMode={num ? 'decimal' : undefined} placeholder={f.op === 'between' ? '从' : '输入'} onChange={(e) => upd(f.id, { a: e.target.value })} />{f.op === 'between' && <input className="in sm" value={f.b ?? ''} inputMode="decimal" placeholder="到" onChange={(e) => upd(f.id, { b: e.target.value })} />}</>}</span>
          <button type="button" className="gf-x" title="删掉这一行条件" onClick={() => setConds(conds.filter((x) => x.id !== f.id))}>✕</button>
        </div>); })}</div>
      <div className="gf-foot"><button type="button" className="btn sm" onClick={() => setConds([...conds, newCond()])}>＋ 添加条件</button>
        {conds.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setConds([])}>全部清掉</button>}<span className="grow" />{schemes}</div>
    </div>, document.body);
}

// 筛选方案: 自己的存在本机 (这个岗位下), 可改名 / 拖动排序 / 置顶; 中方可以把自己的某个方案推成「公司共用」(所有人能用、不能改)
export function Schemes({ id, current, onApply }) {
  const { org, role, toast, refresh } = useApp() || {};
  const key = `la9s.gs.${role}.${id}`;
  const [mine, setMine] = useState(() => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } });
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [ren, setRen] = useState(null); const [at, setAt] = useState(null); const btn = useRef();
  const ref = usePop(open, () => setOpen(false));
  const shared = useData(async () => { if (!org) return []; const [r] = await q(`select value from app.org_settings where org_id = $1 and key = $2`, [org, 'filter_schemes:' + id]); return Array.isArray(r?.value) ? r.value.filter((s) => s.conds) : []; }, [org, id]).data || [];
  const save = (next) => { setMine(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 存不了就只在这次有效 */ } };
  const sorted = [...mine].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0));
  const share = async (s, on) => { try { const next = on ? [...shared.filter((x) => x.name !== s.name), { name: s.name, conds: s.conds, any: s.any, q: s.q }] : shared.filter((x) => x.name !== s.name); await call(role, `select app.set_org_setting($1,$2,$3)`, [org, 'filter_schemes:' + id, JSON.stringify(next)]); toast(on ? `「${s.name}」已推给所有人` : `已取消共用「${s.name}」`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const show = () => { const r = btn.current.getBoundingClientRect(); setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 348)), top: r.bottom + 4 }); setOpen(true); };
  const has = (current.conds || []).some(condReady) || current.q;
  return (<>
    <button type="button" ref={btn} className="btn sm gf-keep" onClick={() => (open ? setOpen(false) : show())}>☆ 筛选方案{mine.length + shared.length ? `（${mine.length + shared.length}）` : ''}</button>
    {open && at && createPortal(
      <div className="menu gf-schemes gf-keep" ref={ref} style={{ position: 'fixed', left: at.left, top: at.top, width: 340, zIndex: 430 }}>
        {shared.length > 0 && <><div className="gf-sub">公司共用</div>{shared.map((s) => <div key={'s' + s.name} className="row" style={{ gap: 4 }}><button type="button" className="mi grow" onClick={() => { onApply(s); setOpen(false); }}><span>🏢 {s.name}</span></button>{role === 'admin' && <button type="button" className="btn sm ghost" title="取消共用" onClick={() => share(s, false)}>✕</button>}</div>)}</>}
        <div className="gf-sub">我的方案 <span className="muted">（拖动调顺序）</span></div>
        {!mine.length && <div className="hint" style={{ padding: 8 }}>还没有。先把筛选条件选好，再在下面起个名字存起来。</div>}
        <SortList items={sorted} keyOf={(s) => s.name} onChange={(next) => save(next)} render={(s) => (
          <div className="row" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            {ren === s.name ? <input className="in sm" autoFocus defaultValue={s.name} style={{ flex: 1 }} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) save(mine.map((x) => (x.name === s.name ? { ...x, name: v } : x))); setRen(null); }} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
              : <button type="button" className="mi grow" style={{ minWidth: 0 }} onClick={() => { onApply(s); setOpen(false); }}><span>{s.pin ? '📌 ' : ''}{s.name}</span></button>}
            <button type="button" className="btn sm ghost" title={s.pin ? '取消置顶' : '置顶'} onClick={() => save(mine.map((x) => (x.name === s.name ? { ...x, pin: !x.pin } : x)))}>{s.pin ? '📌' : '📍'}</button>
            <button type="button" className="btn sm ghost" title="改名" onClick={() => setRen(s.name)}>✎</button>
            {role === 'admin' && <button type="button" className="btn sm ghost" title="推给所有人（公司共用）" onClick={() => share(s, true)}>🏢</button>}
            <button type="button" className="btn sm ghost" title="删除" onClick={() => save(mine.filter((x) => x.name !== s.name))}>🗑</button>
          </div>)} />
        <div className="row" style={{ gap: 6, padding: '8px 6px 4px', borderTop: '1px solid var(--line-2)' }}>
          <input className="in sm" style={{ flex: 1 }} placeholder={has ? '给现在的筛选起个名字' : '先选好筛选条件'} disabled={!has} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn sm primary" disabled={!has || !name.trim()} onClick={() => { save([...mine.filter((x) => x.name !== name.trim()), { name: name.trim(), conds: current.conds.filter(condReady), any: current.any, q: current.q }]); setName(''); toast?.(`已存成方案「${name.trim()}」`); }}>存成方案</button></div>
      </div>, document.body)}
  </>);
}
