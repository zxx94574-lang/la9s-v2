// 入仓号输入 (Frank 11-27): 单号有固定格式的就做成模板 —— 前缀 / 后缀固定在框里, 只填中间的数字; 格式按金蝶采购订单里真实出现过的整理.
// 模板可以选 (也能「自由填」), 中方在 ⚙ 里加 / 改 / 删 (org_settings inbound_formats). 粘贴一整串会自动认出是哪个模板.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal } from './ui.jsx';
import { hasAny } from '../lib/domain.js';

// 11-27 从 159 张金蝶采购订单的备注 / 物流单号里数出来的: CG…A 19 次 (捷道)、LKY…Y 13 次 (赛时)、LAY…Y 4、TG…L 4、9 位数字…Y 4 (赛时)
export const DEFAULT_FMTS = [
  { id: 'lky', prefix: 'LKY', digits: 6, suffix: 'Y', forwarder: '赛时' },
  { id: 'lay', prefix: 'LAY', digits: 6, suffix: 'Y', forwarder: '赛时' },
  { id: 'n9y', prefix: '', digits: 9, suffix: 'Y', forwarder: '赛时' },
  { id: 'cg', prefix: 'CG', digits: 7, suffix: 'A', forwarder: '捷道' },
  { id: 'tg', prefix: 'TG', digits: 7, suffix: 'L', forwarder: '' },
];
const FREE = { id: 'free', prefix: '', digits: 0, suffix: '' };
const sample = (f) => (f.id === 'free' ? '自由填' : `${f.prefix}${'0'.repeat(f.digits)}${f.suffix}`);
const reOf = (f) => new RegExp(`^${f.prefix}(\\d{${f.digits}})${f.suffix}$`);
export const fmtOf = (code, fmts) => fmts.find((f) => f.digits && reOf(f).test(code)) || null;

export function useInboundFmts() {
  const { org, tick } = useApp();
  const { data } = useData(() => q(`select value from app.org_settings where org_id = $1 and key = 'inbound_formats'`, [org]).then((r) => r[0]?.value?.list).catch(() => null), [org, tick]);
  return Array.isArray(data) && data.length ? data : DEFAULT_FMTS;
}

// value: 入仓号数组; forwarder: 选了物流公司 → 默认用它常用的格式
export function InboundInput({ value = [], onChange, forwarder }) {
  const { role } = useApp();
  const fmts = useInboundFmts();
  const pick = useMemo(() => fmts.find((f) => forwarder && f.forwarder === forwarder) || fmts[0] || FREE, [fmts, forwarder]);
  const [fid, setFid] = useState(null);
  const f = fmts.find((x) => x.id === fid) || (fid === 'free' ? FREE : pick);
  const [mid, setMid] = useState('');
  const [open, setOpen] = useState(false); const [gear, setGear] = useState(false);
  const inp = useRef(null); const box = useRef(null);
  useEffect(() => { if (!open) return undefined; const h = (e) => !box.current?.contains(e.target) && setOpen(false); document.addEventListener('pointerdown', h); return () => document.removeEventListener('pointerdown', h); }, [open]);
  const full = f.id === 'free' ? mid.trim().toUpperCase() : (mid.length === f.digits ? `${f.prefix}${mid}${f.suffix}` : '');
  const add = (code) => { const c = String(code || '').trim().toUpperCase(); if (!c || value.includes(c)) { setMid(''); return; } onChange([...value, c]); setMid(''); };
  const type = (raw) => {
    const s = String(raw).toUpperCase().replace(/\s+/g, '');
    const hit = fmtOf(s, fmts);                               // 粘贴 / 打了一整串 → 认出模板直接加
    if (hit && s.length > (f.digits || 0)) { setFid(hit.id); add(s); return; }
    if (f.id === 'free') { setMid(s); return; }
    const d = s.replace(/\D/g, '').slice(0, f.digits);
    setMid(d);
    if (d.length === f.digits) setTimeout(() => add(`${f.prefix}${d}${f.suffix}`), 0);   // 数字填满 → 自动加上, 接着填下一个
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{value.map((c) => (
        <span key={c} className={`code-chip ${fmtOf(c, fmts) ? '' : 'odd'}`} title={fmtOf(c, fmts) ? '' : '和常用格式对不上，确认一下有没有填错'}>
          <span className="mono">{c}</span><button type="button" aria-label="删" onClick={() => onChange(value.filter((x) => x !== c))}>×</button></span>))}</div>}
      <div className="row" style={{ gap: 6, alignItems: 'stretch' }} ref={box}>
        <div className={`codein ${f.id !== 'free' && mid && mid.length < f.digits ? 'part' : ''}`} onClick={() => inp.current?.focus()}>
          <button type="button" className="codein-fmt" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} title="换格式（下拉里看所有常用格式）">格式<span>▾</span></button>
          {f.prefix && <span className="codein-fix">{f.prefix}</span>}
          <input ref={inp} className="codein-in mono" value={mid} inputMode={f.id === 'free' ? 'text' : 'numeric'} placeholder={f.id === 'free' ? '整串填' : '0'.repeat(f.digits)}
            style={f.id === 'free' ? { flex: 1 } : { width: `${f.digits * 1.15 + 0.6}ch` }}
            onChange={(e) => type(e.target.value)} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); type(t); } }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (full) add(full); } else if (e.key === 'Backspace' && !mid && value.length) onChange(value.slice(0, -1)); }}
            onBlur={() => { if (full) add(full); }} />
          {f.suffix && <span className="codein-fix">{f.suffix}</span>}
          {f.id !== 'free' && <span className="codein-n small muted">{mid.length}/{f.digits}</span>}
          {open && <div className="codein-pop" onClick={(e) => e.stopPropagation()}>
            {[...fmts, FREE].map((x) => <button type="button" key={x.id} className={x.id === f.id ? 'on' : ''} onClick={() => { setFid(x.id); setMid(''); setOpen(false); setTimeout(() => inp.current?.focus(), 0); }}>
              <span className="mono">{sample(x)}</span>{x.forwarder && <span className="small muted">{x.forwarder}</span>}</button>)}
          </div>}
        </div>
        {hasAny(role, ['admin']) && <button type="button" className="opt-gear" title="改常用格式" onClick={() => setGear(true)}>⚙</button>}
      </div>
      {gear && <FmtEditor fmts={fmts} onClose={() => setGear(false)} />}
    </div>
  );
}

function FmtEditor({ fmts, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [rows, setRows] = useState(() => fmts.map((f) => ({ ...f })));
  const set = (i, k, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const ok = rows.every((r) => Number(r.digits) > 0 && /^[A-Z]*$/.test(r.prefix) && /^[A-Z]*$/.test(r.suffix));
  const save = async () => {
    try { await call(role, `select app.set_org_setting($1,'inbound_formats',$2)`, [org, JSON.stringify({ list: rows.map((r, i) => ({ ...r, id: r.id || `f${Date.now()}${i}`, digits: Number(r.digits) })) })]); toast('已保存，入仓号格式立即生效'); refresh(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="入仓号常用格式" onClose={onClose}
      footer={<><button type="button" className="btn ghost" onClick={() => setRows(DEFAULT_FMTS.map((f) => ({ ...f })))}>恢复成系统默认</button><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!ok} title={ok ? '' : '还差：前缀 / 后缀只写大写字母，位数要大于 0'} onClick={save}>保存</button></>}>
      <div className="small muted" style={{ marginBottom: 8 }}>填入仓号时前缀、后缀固定在框里，只填中间的数字；选了物流公司就先用它常用的那个。</div>
      <div className="fmt-grid"><b>前缀</b><b>数字位数</b><b>后缀</b><b>常用的物流公司</b><b>样子</b><span />
        {rows.map((r, i) => <React.Fragment key={r.id || i}>
          <input className="in mono" value={r.prefix} onChange={(e) => set(i, 'prefix', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} placeholder="LKY" />
          <input className="in" inputMode="numeric" value={r.digits} onChange={(e) => set(i, 'digits', e.target.value.replace(/\D/g, ''))} />
          <input className="in mono" value={r.suffix} onChange={(e) => set(i, 'suffix', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} placeholder="Y" />
          <input className="in" value={r.forwarder || ''} onChange={(e) => set(i, 'forwarder', e.target.value)} placeholder="赛时" />
          <span className="mono small">{sample({ ...r, digits: Number(r.digits) || 0 })}</span>
          <button type="button" className="btn sm ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>删除</button>
        </React.Fragment>)}
      </div>
      <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setRows((x) => [...x, { id: '', prefix: '', digits: 6, suffix: '', forwarder: '' }])}>＋ 加一个格式</button>
    </Modal>
  );
}
