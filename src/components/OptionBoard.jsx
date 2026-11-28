// 选项设置 · 飞书式（Frank 11-28）：一列 = 一组选项；双击改名、点圆点改颜色、拖 ⋮⋮ 排序、× 删除、底下加一项；
// 改一处存一处、全站立即生效；每列底下写「用在哪」；引用别的组的列只勾「能用哪几项」。
// 数据源见 lib/optRegistry.js（opts:<key> 或某个档案设置里的一段）。表单旁的 ⚙ 打开的也是这一列。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, SortList, Choice, Info } from './ui.jsx';
import { applyOpts, loadAllOpts, norm, rowsToCfg, PLAIN_TONES, STATUS_TONES } from './Opts.jsx';
import { OPT_REG, groupsOf, refsTo } from '../lib/optRegistry.js';
import { SYS_ROLES } from '../lib/staffOptions.js';
import { ROLES } from '../lib/domain.js';
import { friendlyError } from '../lib/format.js';

async function getSetting(org, key) { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = $2`, [org, key]); return r?.value ?? null; }
const putSetting = (role, org, key, v) => call(role, `select app.set_org_setting($1,$2,$3)`, [org, key, v == null ? null : JSON.stringify(v)]);

// 读一组 → { rows, raw }；rows 每行 { v, l, c, sys, base, ...其他属性 }
async function readGroup(org, key) {
  const g = OPT_REG[key];
  if (g.ref) {
    const [own, par] = await Promise.all([getSetting(org, `opts:${key}`), getSetting(org, `opts:${g.ref}`)]);
    return { own: own || {}, parent: await readGroup(org, g.ref), par: par || {} };
  }
  if (g.kind === 'list') {
    const raw = (await getSetting(org, g.store)) || {};
    const list = Array.isArray(raw[g.path]) ? raw[g.path] : g.defaults();
    const sys = new Set(g.defaults().map((x) => String(x.v)));
    return { raw, rows: list.map((x) => ({ ...x, c: x.c || '', sys: sys.has(String(x.v)) })) };
  }
  const raw = (await getSetting(org, `opts:${key}`)) || {};
  const base = (g.options?.() || []).map(norm);
  const { all, hidden } = applyOpts(base, raw);
  const extras = (raw.extra || []).map((x) => (typeof x === 'string' ? { v: x, l: x } : x));
  return { raw, base, rows: all.filter(([v]) => !hidden.has(String(v))).map(([v, l]) => ({ v, l, c: raw.color?.[v] || '', sys: base.some(([b]) => String(b) === String(v)), base: extras.find((e) => e.v === v)?.base })) };
}
async function writeGroup(role, org, key, data, rows) {
  const g = OPT_REG[key];
  if (g.kind === 'list') {
    const clean = rows.map(({ sys, ...x }) => { const y = { ...x }; if (!y.c) delete y.c; return y; });   // eslint-disable-line no-unused-vars
    await putSetting(role, org, g.store, { ...data.raw, [g.path]: clean });
  } else {
    await putSetting(role, org, `opts:${key}`, rowsToCfg(rows, data.base, false, data.raw));
    await loadAllOpts(org);
  }
}

// 调色小按钮：点一下弹色板（普通色一排 + 状态色一排）
function ToneDot({ value, onPick }) {
  const [open, setOpen] = useState(false); const btn = useRef(null); const pop = useRef(null); const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const r = btn.current.getBoundingClientRect(); const w = 236;
    setPos({ left: Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8)), top: r.bottom + 6 > window.innerHeight - 150 ? r.top - 146 : r.bottom + 6, width: w });
    const out = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', out); return () => document.removeEventListener('pointerdown', out);
  }, [open]);
  const sw = ([t, n]) => <button type="button" key={t || 'none'} className={`ob-sw ${t || 'none'} ${value === t ? 'on' : ''}`} title={n} aria-label={n} onClick={() => { onPick(t); setOpen(false); }} />;
  return (<>
    <button ref={btn} type="button" className={`ob-dot ${value || 'none'}`} title="改颜色" aria-label="改颜色" onClick={() => setOpen((o) => !o)} />
    {open && pos && <div ref={pop} className="ob-pal" style={pos}>
      <div className="ob-pal-row">{PLAIN_TONES.map(sw)}</div>
      <div className="ob-pal-t">状态色（只给状态用）</div>
      <div className="ob-pal-row">{STATUS_TONES.map(sw)}</div>
    </div>}
  </>);
}

// 一个选项：圆点 + 名字（双击改）+ ×
function Item({ r, upper, locked, onChange, onDelete, extra }) {
  const [ed, setEd] = useState(false); const [txt, setTxt] = useState(r.l);
  useEffect(() => { if (!ed) setTxt(r.l); }, [r.l, ed]);
  const done = (ok) => { setEd(false); const t = txt.trim(); if (ok && t && t !== r.l) onChange({ l: upper ? t.toUpperCase() : t }); };
  return (
    <div className="ob-item">
      <ToneDot value={r.c} onPick={(c) => onChange({ c })} />
      {ed ? <input className="in ob-in" autoFocus value={txt} onChange={(e) => setTxt(upper ? e.target.value.toUpperCase() : e.target.value)} onBlur={() => done(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); }} />
        : <span className={`ob-name ${r.c ? `pill ${r.c}` : ''}`} title={locked ? '这一项固定，不能改' : '双击改名'} onDoubleClick={() => !locked && setEd(true)}>{r.l}</span>}
      {!locked && <button type="button" className="ob-x" title={`删掉「${r.l}」（用过它的老记录照样显示原来的名字）`} aria-label={`删掉 ${r.l}`} onClick={onDelete}>×</button>}
      {extra}
    </div>);
}

export function OptionColumn({ optKey, q: kw = '', wide }) {
  const { org, role, toast, refresh } = useApp();
  const g = OPT_REG[optKey];
  const [ver, setVer] = useState(0);
  const { data } = useData(() => readGroup(org, optKey), [org, optKey, ver]);
  const [rows, setRows] = useState(null);
  const [nw, setNw] = useState('');
  useEffect(() => { if (data && !g.ref) setRows(data.rows); }, [data, g.ref]);
  if (!data || (!g.ref && !rows)) return <div className="ob-col"><div className="ob-h"><b>{g.title}</b></div><div className="muted small">加载中…</div></div>;
  const commit = async (next, msg = '已保存，全站立即生效') => {
    const prev = rows; setRows(next);
    try { await writeGroup(role, org, optKey, data, next); toast(msg); refresh(); setVer((x) => x + 1); } catch (e) { setRows(prev); toast(friendlyError(e), 'err'); }
  };
  const used = <div className="ob-used">用在：{g.used.join('、')}</div>;
  const refs = refsTo(optKey).map((x) => <div key={x.key} className="ob-used">被「{x.title}」引用</div>);
  // ── 引用列：名字 / 颜色跟着被引用的组，这里只勾能用的 ──
  if (g.ref) {
    const parent = OPT_REG[g.ref]; const prow = data.parent.rows;
    const pick = new Set((data.own.pick || g.pick || prow.map((r) => r.v)).map(String));
    const toggle = async (v) => {
      const n = new Set(pick); if (n.has(String(v))) n.delete(String(v)); else n.add(String(v));
      if (!n.size) return toast('至少留一项', 'err');
      try { await putSetting(role, org, `opts:${optKey}`, { ...data.own, pick: prow.map((r) => String(r.v)).filter((v2) => n.has(v2)) }); await loadAllOpts(org); toast('已保存'); refresh(); setVer((x) => x + 1); } catch (e) { toast(friendlyError(e), 'err'); }
    };
    return (
      <div className={`ob-col ${wide ? 'wide' : ''}`}>
        <div className="ob-h"><b>{g.title}</b><span className="pill gray sm-pill">引用</span><span className="grow" /><span className="muted small">{pick.size} / {prow.length}</span></div>
        <div className="ob-reffrom">选项来自「{parent.title}」，勾上的才能选。改名字、改颜色去「{parent.title}」那一列。</div>
        {prow.map((r) => <label key={r.v} className="ob-item ob-pick"><input type="checkbox" checked={pick.has(String(r.v))} onChange={() => toggle(r.v)} /><span className={`ob-name ${r.c ? `pill ${r.c}` : ''}`}>{r.l}</span></label>)}
        {used}
      </div>);
  }
  const hit = (r) => !kw || r.l.toLowerCase().includes(kw.toLowerCase());
  const locked = (r) => g.note && r.v === '其他';
  const add = () => {
    const t = (g.upper ? nw.toUpperCase() : nw).trim(); if (!t) return;
    if (rows.some((r) => r.l === t || String(r.v) === t)) return toast('已经有这个选项了', 'err');
    const item = { v: t, l: t, c: '', sys: false, ...(g.attrs ? { dept: '', role: '' } : {}) };
    const oth = g.note ? rows.findIndex((r) => r.v === '其他') : -1;   // 快捷原因：「其他」永远最后
    commit(oth >= 0 ? [...rows.slice(0, oth), item, ...rows.slice(oth)] : [...rows, item], `已加「${t}」`); setNw('');
  };
  const depts = g.attrs ? OPT_REG.departments : null;
  return (
    <div className={`ob-col ${wide ? 'wide' : ''}`}>
      <div className="ob-h"><b>{g.title}</b><span className="grow" /><span className="muted small">{rows.length}</span></div>
      <SortList items={rows} keyOf={(r) => String(r.v)} gap={4} onChange={(n) => commit(n, '顺序已保存')} render={(r) => (
        <div className={hit(r) ? '' : 'ob-dim'}>
          <Item r={r} upper={g.upper} locked={locked(r)} onChange={(patch) => commit(rows.map((x) => (x.v === r.v ? { ...x, ...patch } : x)))}
            onDelete={() => { if (rows.length <= 1) return toast('至少留一项', 'err'); commit(rows.filter((x) => x.v !== r.v), `已删掉「${r.l}」`); }}
            extra={g.attrs && depts ? <PosAttrs r={r} org={org} onChange={(patch) => commit(rows.map((x) => (x.v === r.v ? { ...x, ...patch } : x)))} /> : null} />
        </div>)} />
      <div className="ob-add">
        <input className="in" placeholder="＋ 加一项，回车" value={nw} onChange={(e) => setNw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        {nw.trim() && <button type="button" className="btn sm primary" onClick={add}>加</button>}
      </div>
      {used}{refs}
      {(g.kind === 'list' ? Array.isArray(data.raw[g.path]) : Object.keys(data.raw || {}).some((k) => k !== 'pick')) &&
        <button type="button" className="btn sm ghost ob-reset" onClick={() => commit(g.kind === 'list' ? g.defaults().map((x) => ({ ...x, c: '', sys: true })) : data.base.map(([v, l]) => ({ v, l, c: '', sys: true })), '已恢复成系统默认')}>恢复成系统默认</button>}
    </div>);
}

// 职位：属于哪个部门（引用「部门」）+ 默认给什么系统岗位
function PosAttrs({ r, org, onChange }) {
  const { data } = useData(() => readGroup(org, 'departments'), [org]);
  const [open, setOpen] = useState(false);
  const deps = (data?.rows) || [];
  const dOpts = [['', '任何部门'], ...deps.map((d) => [d.v, d.l])];
  const rOpts = [['', '不登录'], ...SYS_ROLES.map((k) => [k, ROLES[k]?.label || k])];
  const dl = r.dept ? (deps.find((d) => d.v === r.dept)?.l || r.dept) : '任何部门';
  const rl = r.role ? (ROLES[r.role]?.label || r.role) : '不登录';
  if (!open) return <button type="button" className="ob-attr-t" title="改：属于哪个部门、默认给什么系统岗位" onClick={() => setOpen(true)}>{dl} · {rl}</button>;
  return (
    <div className="ob-attrs">
      <label className="small muted">部门<Choice flat={false} size="sm" value={r.dept || ''} options={dOpts} onChange={(v) => onChange({ dept: v })} /></label>
      <label className="small muted">系统岗位<Choice flat={false} size="sm" value={r.role || ''} options={rOpts} onChange={(v) => onChange({ role: v })} /></label>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>收起</button>
    </div>);
}

export default function OptionBoard({ home, q: kw = '' }) {
  const groups = groupsOf(home);
  const k = kw.trim().toLowerCase();
  const shown = k ? groups.filter((g) => g.title.toLowerCase().includes(k) || g.used.some((u) => u.toLowerCase().includes(k)) || (g.options?.() || g.defaults?.() || []).some((o) => String(norm(o)[1]).toLowerCase().includes(k))) : groups;
  return (
    <div className="ob-wrap">
      <div className="row small muted" style={{ gap: 6 }}>双击改名 · 点圆点改颜色 · 拖 ⋮⋮ 排序 · 改完自动保存
        <Info>改的是全站同一份：表单旁边的 ⚙ 打开的也是这里。删掉的选项以后不能再选，用过它的老记录照样显示原来的名字。标了「引用」的列，选项来自另一列，这里只勾哪几项能用。</Info></div>
      {shown.length ? <div className="ob-board">{shown.map((g) => <OptionColumn key={g.key} optKey={g.key} q={kw} />)}</div> : <div className="empty">没有找到「{kw}」</div>}
    </div>);
}
