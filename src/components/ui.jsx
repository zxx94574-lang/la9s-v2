import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ymd, today, pad } from '../lib/format.js';
import { t } from '../lib/i18n.js';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

// ── toast ──
export function useToasts() {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === 'err' ? 4200 : 2400);
    if (tone === 'err' && navigator.vibrate) navigator.vibrate(30);
  }, []);
  const view = (
    <div className="toasts">{items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
  );
  return [push, view];
}

// ── modal ──
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-h"><h2>{title}</h2><button className="close-x" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

// 客户档位固定配色 (Frank 11-09, 同飞书): S 黄 / Wholesale 红 / Retail 蓝 / Repair 绿
export const TIER_TONE = { S: 'amber', WHOLESALE: 'red', RETAIL: 'blue', REPAIR: 'green' };
const TIER_NAME = { S: 'S', WHOLESALE: 'Wholesale shop', RETAIL: 'Retail shop', REPAIR: 'Repair shop' };
export const TierPill = ({ tier, empty = '没档位', suffix = '' }) => (tier ? <span className={`pill ${TIER_TONE[tier] || 'gray'}`}>{TIER_NAME[tier] || tier}{suffix}</span> : <span className="pill gray">{empty}</span>);
// 订单三色灯 (Frank 11-09 19:10): 红 = 已取消 / 黄 = 进行中 / 绿 = 已完成
export const LIGHT = { done: ['green', '已完成'], active: ['amber', '进行中'], cancelled: ['red', '已取消'] };
export const Light = ({ v }) => { const [tone, label] = LIGHT[v] || LIGHT.active; return <span className={`pill ${tone}`}>{label}</span>; };
export const Pill = ({ tone = 'gray', children }) => <span className={`pill ${tone}`}>{typeof children === 'string' ? t(children) : children}</span>;

// ── shared models: summary, hover (desktop) / tap (phone) for all ──
export function Shared({ list, show = 2 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const h = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', h); return () => document.removeEventListener('pointerdown', h);
  }, [open]);
  if (!list || !list.length) return <span className="muted">—</span>;
  const head = list.slice(0, show).join(' / ');
  return (
    <span ref={ref} className={`shared ${open ? 'open' : ''}`}>
      <span className="s-text">{head}</span>
      {list.length > show && <button type="button" className="more" onClick={() => setOpen(!open)}>+{list.length - show}</button>}
      {list.length > show && <span className="pop"><b>通用 {list.length} 个型号</b><br />{list.join(' / ')}</span>}
    </span>
  );
}

// ── date picker: year + month chosen separately, only that month's days shown ──
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
// 年份下拉: 2000 → 明年 (入职日期这类老日期也能选)
const yearList = (y) => { const out = []; const hi = Math.max(new Date().getFullYear() + 1, y || 0); for (let i = Math.min(2000, y || 2000); i <= hi; i++) out.push(i); return out; };

// 单独的日历面板 (表格格子里改日期用): 年下拉 / 月下拉 / 当月日历
export function DateCalendar({ value, onChange, onClose, style }) {
  const [ym, setYm] = useState(() => { const d = new Date(value || today()); return [d.getFullYear(), d.getMonth()]; });
  const [y, m] = ym;
  const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const t = today();
  return (
    <div className="dp-pop" style={{ position: 'static', ...style }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="dp-head">
        <select className="in" value={y} onChange={(e) => setYm([+e.target.value, m])}>{yearList(y).map((v) => <option key={v} value={v}>{v} 年</option>)}</select>
        <select className="in" value={m} onChange={(e) => setYm([y, +e.target.value])}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i}>{i + 1} 月</option>)}</select>
        {onClose && <button type="button" className="close-x" onClick={onClose} aria-label="关闭">×</button>}
      </div>
      <div className="dp-grid">
        {WEEK.map((w) => <div key={w} className="w">{w}</div>)}
        {Array.from({ length: lead }, (_, i) => <span key={'b' + i} />)}
        {Array.from({ length: days }, (_, i) => { const s = ymd(new Date(y, m, i + 1)); return <button type="button" key={s} className={`${s === t ? 'today' : ''} ${s === value ? 'on' : ''}`} onClick={() => onChange(s)}>{i + 1}</button>; })}
      </div>
      <div className="row" style={{ justifyContent: 'space-between', padding: '4px 6px 0' }}>
        <button type="button" className="btn sm ghost" onClick={() => onChange('')}>清空</button>
        <button type="button" className="btn sm ghost" onClick={() => onChange(t)}>今天</button>
      </div>
    </div>
  );
}

// 月份选择 (Frank 11-07: 没有「日」的地方就选年 + 月, 和日历一个样子, 不要裸输入框)
export function MonthPicker({ value, onChange, label, align }) {
  const [open, setOpen] = useState(false);
  const cur = value || today().slice(0, 7);
  const [y, setY] = useState(() => Number(cur.slice(0, 4)));
  const ref = useRef();
  useEffect(() => { if (!open) return undefined; const h = (e) => !ref.current?.contains(e.target) && setOpen(false); document.addEventListener('pointerdown', h); return () => document.removeEventListener('pointerdown', h); }, [open]);
  const tm = today().slice(0, 7);
  return (
    <span className="dp" ref={ref}>
      <button type="button" className="dp-btn" onClick={() => { setY(Number(cur.slice(0, 4))); setOpen(!open); }}>
        <span>▦</span>{label && <span className="muted small">{label}</span>}<b>{cur.slice(0, 4)} 年 {Number(cur.slice(5, 7))} 月</b>
      </button>
      {open && (
        <div className="dp-pop" style={align === 'right' ? { left: 'auto', right: 0 } : null}>
          <div className="dp-head">
            <select className="in" value={y} onChange={(e) => setY(+e.target.value)}>{yearList(y).map((v) => <option key={v} value={v}>{v} 年</option>)}</select>
            <button type="button" className="close-x" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </div>
          <div className="dp-months">
            {Array.from({ length: 12 }, (_, i) => { const v = `${y}-${pad(i + 1)}`; return <button type="button" key={v} className={`${v === cur ? 'on' : ''} ${v === tm ? 'today' : ''}`} onClick={() => { onChange(v); setOpen(false); }}>{i + 1} 月</button>; })}
          </div>
        </div>
      )}
    </span>
  );
}

export function DatePicker({ value, onChange, range, label, align }) {
  // range mode: value = [from, to]. 按钮分成「开始 | 结束」两半, 点哪半就在选哪个日期, 正在选的那半高亮 (Frank 10-31)
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState('from');
  const [ym, setYm] = useState(() => { const d = new Date((range ? value?.[0] : value) || today()); return [d.getFullYear(), d.getMonth()]; });
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const h = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', h); return () => document.removeEventListener('pointerdown', h);
  }, [open]);
  const show = (sd) => {
    const v = range ? value?.[sd === 'from' ? 0 : 1] : value;
    const d = new Date(v || today()); setYm([d.getFullYear(), d.getMonth()]);
    if (!range) { setOpen(!open); return; }
    if (open && side === sd) { setOpen(false); return; }   // 再点同一半 = 收起
    setSide(sd); setOpen(true);
  };
  const [y, m] = ym;
  const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const t = today();
  const click = (d) => {
    const s = ymd(new Date(y, m, d));
    if (!range) { onChange(s); setOpen(false); return; }
    const [a, b] = value || [s, s];
    if (side === 'from') { onChange([s, b && b >= s ? b : s]); setSide('to'); return; }   // 选完开始, 自动切到结束
    onChange(s >= a ? [a, s] : [s, a]); setOpen(false);
  };
  const isOn = (s) => (range ? s === value?.[0] || s === value?.[1] : s === value);
  const inR = (s) => range && value && s > value[0] && s < value[1];
  const years = yearList(y);
  return (
    <span className="dp" ref={ref}>
      {range ? (
        <span className={`dp-range ${open ? 'open' : ''}`}>
          {label && <span className="muted small dp-lbl">{label}</span>}
          <button type="button" className={`dp-half ${open && side === 'from' ? 'on' : ''}`} onClick={() => show('from')}>
            <span className="dp-cap">开始</span><b>{value?.[0] || '—'}</b></button>
          <span className="dp-sep">→</span>
          <button type="button" className={`dp-half ${open && side === 'to' ? 'on' : ''}`} onClick={() => show('to')}>
            <span className="dp-cap">结束</span><b>{value?.[1] || '—'}</b></button>
        </span>
      ) : (
        <button type="button" className="dp-btn" onClick={() => show('from')}>
          <span>▦</span>{label && <span className="muted small">{label}</span>}<b>{value}</b>
        </button>)}
      {open && (
        <div className="dp-pop" style={align === 'right' ? { left: 'auto', right: 0 } : null}>
          <div className="dp-head">
            <select className="in" value={y} onChange={(e) => setYm([+e.target.value, m])}>{years.map((v) => <option key={v} value={v}>{v} 年</option>)}</select>
            <select className="in" value={m} onChange={(e) => setYm([y, +e.target.value])}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i}>{i + 1} 月</option>)}</select>
            <button type="button" className="close-x" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </div>
          {range && <div className={`dp-now ${side}`}>正在选：<b>{side === 'from' ? '开始日期' : '结束日期'}</b></div>}
          <div className="dp-grid">
            {WEEK.map((w) => <div key={w} className="w">{w}</div>)}
            {Array.from({ length: lead }, (_, i) => <span key={'b' + i} />)}
            {Array.from({ length: days }, (_, i) => {
              const s = ymd(new Date(y, m, i + 1));
              return <button type="button" key={s} className={`${s === t ? 'today' : ''} ${isOn(s) ? 'on' : ''} ${inR(s) ? 'inrange' : ''}`} onClick={() => click(i + 1)}>{i + 1}</button>;
            })}
          </div>
        </div>
      )}
    </span>
  );
}

// ── 通用附件框 (Frank 11-07 16:18: 所有附件都做成小框, 能拖进去也能点选, 图片还能 ⌘V 粘贴) ──
export function FileDrop({ accept = '*/*', multiple = false, onFiles, label = '把文件拖到这里，或点击选择', hint, compact, style }) {
  const [over, setOver] = useState(false);
  const inp = useRef();
  const ok = (f) => { if (!accept || accept === '*/*') return true; return accept.split(',').some((a) => { a = a.trim(); return a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : f.type === a; }); };
  const take = (list) => { const fs = [...(list || [])].filter(ok); if (!fs.length) return; onFiles(multiple ? fs : fs.slice(0, 1)); };
  return (
    <div className={`filedrop ${over ? 'over' : ''} ${compact ? 'compact' : ''}`} style={style} tabIndex={0} role="button"
      onClick={() => inp.current.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      onPaste={(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); take(fs); } }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.current.click(); } }}>
      <span className="fd-ico">⤓</span>
      <span className="fd-txt"><b>{label}</b>{hint && <span className="muted small"> · {hint}</span>}</span>
      <input ref={inp} type="file" accept={accept} multiple={multiple} hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

// ── proof image box (待改 26 / 35): paste a screenshot, drag one in, take a photo or pick one ──
// The image is downscaled (≤900px, jpeg .72). Where it came from + when is kept inside the data URL as media-type
// parameters (data:image/jpeg;src=camera;at=…;ft=…;by=…;base64,…) so every viewer can show it without another table.
const SRC_LABEL = { camera: '现场拍摄', gallery: '相册 / 文件选取', paste: '粘贴截图', drop: '拖入图片' };
export function proofMeta(v) {
  if (!v || !v.startsWith('data:')) return null;
  const head = v.slice(5, v.indexOf(',')).split(';');
  const m = {}; for (const kv of head.slice(1)) { const [k, x] = kv.split('='); if (x) m[k] = decodeURIComponent(x); }
  return { src: m.src, srcLabel: SRC_LABEL[m.src] || '未知来源', at: m.at, ft: m.ft, by: m.by };
}
async function encodeImage(file, src, by) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const s = Math.min(1, 900 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const b64 = c.toDataURL('image/jpeg', 0.72).split(',')[1];
  const enc = encodeURIComponent;
  return `data:image/jpeg;src=${src};at=${enc(new Date().toISOString())};ft=${enc(new Date(file.lastModified || Date.now()).toISOString())};by=${enc(by || '')};base64,${b64}`;
}
export function PhotoInput({ value, onChange, label = '拍照 / 上传', camera = true, invalid, onDup }) {
  const { org, role, toast } = useApp() || {};
  const cam = useRef(); const pick = useRef(); const box = useRef();
  const [dup, setDup] = useState([]);
  const [over, setOver] = useState(false);
  const take = async (file, src) => {
    if (!file || !file.type?.startsWith('image/')) return toast?.('请放入图片', 'err');
    const { ROLES } = await import('../lib/domain.js');
    const v = await encodeImage(file, src, ROLES[role]?.label);
    onChange(v);
    try {
      const { q } = await import('../db/client.js'); const Q = await import('../db/queries.js');
      const uses = await q(Q.proofUses, [org, v.split('base64,')[1]]);
      setDup(uses.map((u) => u.doc)); onDup?.(uses.map((u) => u.doc));
      if (uses.length) toast?.(`这张图片已用于 ${uses[0].doc}，请确认不是旧图`, 'err');
    } catch { setDup([]); onDup?.([]); }
  };
  const onPaste = (e) => {
    const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (f) { e.preventDefault(); take(f, 'paste'); }
  };
  return (
    <div className="proofbox-wrap">
      <div ref={box} tabIndex={0} className={`proofbox ${over ? 'over' : ''} ${invalid && !value ? 'err' : ''} ${value ? 'has' : ''}`}
        onPaste={onPaste} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0], 'drop'); }}
        onClick={(e) => { if (!e.target.closest('button,img')) box.current.focus(); }}>
        {value ? <Thumb src={value} size={56} /> : <span className="pb-ico">⧉</span>}
        <span className="pb-text">{value ? <><b>已上传</b><span className="small muted">{proofMeta(value)?.srcLabel || '演示凭证'} · 可再粘贴替换</span></>
          : <><b>{label}</b><span className="small muted">点这里后 ⌘/Ctrl+V 粘贴截图 · 拖进来</span></>}</span>
        {camera && <button type="button" className="btn sm" onClick={() => cam.current.click()}>📷 拍照</button>}
        <button type="button" className="btn sm" onClick={() => pick.current.click()}>选图</button>
        {value && <button type="button" className="btn sm ghost" onClick={() => { onChange(''); setDup([]); }} title="清除">×</button>}
        <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files[0], 'camera'); e.target.value = ''; }} />
        <input ref={pick} type="file" accept="image/*" hidden onChange={(e) => { take(e.target.files[0], 'gallery'); e.target.value = ''; }} />
      </div>
      {dup.length > 0 && <div className="pill red" style={{ marginTop: 4 }}>⚠ 这张图片已用于 {dup.join('、')}</div>}
    </div>
  );
}

// thumbnail: hover = bigger preview, click = full viewer (←/→ through the group, who / when / how it was taken)
export function Thumb({ src, size = 40, group, label }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  if (!src.startsWith('data:')) return <span className="pill green" title="演示数据里的占位凭证">✓ {label || '凭证'}（演示）</span>;
  const list = (group || [{ src, label }]).filter((x) => x.src?.startsWith('data:'));
  return (
    <>
      <span className="thumb" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <img src={src} alt={label || '凭证'} style={{ height: size, width: size }} />
        <span className="thumb-pop"><img src={src} alt="" /></span>
      </span>
      {open && <Lightbox list={list} start={Math.max(0, list.findIndex((x) => x.src === src))} onClose={() => setOpen(false)} />}
    </>
  );
}
function Lightbox({ list, start, onClose }) {
  const [i, setI] = useState(start);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') setI((x) => Math.min(list.length - 1, x + 1)); if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1)); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [list.length, onClose]);
  const cur = list[i]; const m = proofMeta(cur.src) || {};
  const f = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <div className="lb-body" onClick={(e) => e.stopPropagation()}>
        <div className="lb-img" onClick={() => setZoom(!zoom)} style={{ cursor: zoom ? 'zoom-out' : 'zoom-in' }}>
          <img src={cur.src} alt="" style={zoom ? { maxWidth: 'none', maxHeight: 'none', width: '160%' } : null} />
        </div>
        <div className="lb-meta">
          <b>{cur.label || '凭证'}</b>
          <span>来源：<b className={m.src === 'camera' ? 'green-t' : ''}>{m.srcLabel || '—'}</b></span>
          <span>上传：{m.by || '—'} · {f(m.at)}</span>
          <span>{m.src === 'camera' ? '拍摄时间' : '文件时间'}：{f(m.ft)}</span>
          <span className="grow" />
          {list.length > 1 && <><button type="button" className="btn sm" disabled={i === 0} onClick={() => setI(i - 1)}>←</button><span>{i + 1}/{list.length}</span>
            <button type="button" className="btn sm" disabled={i === list.length - 1} onClick={() => setI(i + 1)}>→</button></>}
          <button type="button" className="btn sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>, document.body);
}

// big number that never wraps: shrinks its font until it fits the box (待改 45)
export function BigNum({ children, size = 26, min = 13, style, className }) {
  const ref = useRef(); const [fs, setFs] = useState(size);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => { let f = size; el.style.fontSize = f + 'px'; while (el.scrollWidth > el.clientWidth + 1 && f > min) { f -= 1; el.style.fontSize = f + 'px'; } setFs(f); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [children, size, min]);
  return <div ref={ref} className={`bignum ${className || ''}`} style={{ ...style, fontSize: fs }}>{children}</div>;
}

// right-side drawer that keeps the page underneath (and its form state) alive (待改 34)
export function Drawer({ title, onClose, children, actions }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return createPortal(
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-h"><h2>{title}</h2><span className="grow" />{actions}<button type="button" className="close-x" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="drawer-b">{children}</div>
      </aside>
    </div>, document.body);
}

// select from preset options, "其他" reveals a text box
export function OptionNote({ options, value, onChange, placeholder = '补充说明' }) {
  const isPreset = options.includes(value);
  const [other, setOther] = useState(!isPreset && !!value);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="chips">
        {options.map((o) => (
          <button type="button" key={o} className={`chip ${(o === value && !other) || (o === '其他' && other) ? 'on' : ''}`}
            onClick={() => { if (o === '其他') { setOther(true); onChange(''); } else { setOther(false); onChange(o); } }}>{o}</button>
        ))}
      </div>
      {other && <input className={`in ${!value?.trim() ? 'invalid' : ''}`} autoFocus placeholder={`「其他」是什么？（必填）${placeholder && placeholder !== '补充说明' ? ` · ${placeholder}` : ''}`} value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export function useOutside(open, close) {
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const h = (e) => !ref.current?.contains(e.target) && close();
    document.addEventListener('pointerdown', h); return () => document.removeEventListener('pointerdown', h);
  }, [open, close]);
  return ref;
}

// async data hook bound to the global refresh tick
export function useData(fn, deps) {
  const { tick } = useApp();
  const [state, set] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    fn().then((data) => alive && set({ data, loading: false, error: null }), (error) => alive && set({ data: null, loading: false, error }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return state;
}

// ── undo / redo for an editing layer (待改 16) ──
// wraps a value + setter; every change carries a short label so the ← / → buttons can say what they will undo.
// consecutive changes with the same label within 1s merge (typing "120" is one step, not three).
export function useHistory(value, setValue) {
  const past = useRef([]); const future = useRef([]); const last = useRef({ label: '', t: 0 });
  const [, bump] = useState(0);
  const commit = useCallback((next, label = '修改') => {
    const now = Date.now();
    if (!(last.current.label === label && now - last.current.t < 1000 && past.current.length)) past.current.push({ v: value, label });
    if (past.current.length > 100) past.current.shift();
    last.current = { label, t: now };
    future.current = [];
    setValue(next); bump((x) => x + 1);
  }, [value, setValue]);
  const undo = useCallback(() => {
    const p = past.current.pop(); if (!p) return null;
    future.current.push({ v: value, label: p.label }); last.current = { label: '', t: 0 };
    setValue(p.v); bump((x) => x + 1); return p.label;
  }, [value, setValue]);
  const redo = useCallback(() => {
    const f = future.current.pop(); if (!f) return null;
    past.current.push({ v: value, label: f.label }); last.current = { label: '', t: 0 };
    setValue(f.v); bump((x) => x + 1); return f.label;
  }, [value, setValue]);
  const reset = useCallback(() => { past.current = []; future.current = []; bump((x) => x + 1); }, []);
  return { commit, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0,
    undoLabel: past.current.at(-1)?.label, redoLabel: future.current.at(-1)?.label };
}

// ← / → buttons + ⌘Z / ⇧⌘Z (Ctrl on Windows) while focus is inside `scope`
export function UndoBar({ h, scope }) {
  const { toast } = useApp();
  useEffect(() => {
    const k = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const el = scope?.current; if (el && !el.contains(document.activeElement) && document.activeElement !== document.body) return;
      e.preventDefault();
      const l = e.shiftKey ? h.redo() : h.undo();
      if (l) toast(`${e.shiftKey ? '已重做' : '已撤销'}：${l}`);
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [h, scope, toast]);
  return (
    <span className="row undo-bar" style={{ gap: 4 }}>
      <button type="button" className="btn sm" disabled={!h.canUndo} title={h.canUndo ? `撤销：${h.undoLabel}（⌘/Ctrl+Z）` : '没有可撤销的操作'}
        onClick={() => { const l = h.undo(); if (l) toast(`已撤销：${l}`); }}>← 撤销{h.canUndo ? `「${h.undoLabel}」` : ''}</button>
      <button type="button" className="btn sm" disabled={!h.canRedo} title={h.canRedo ? `重做：${h.redoLabel}（⇧⌘Z / Ctrl+Shift+Z）` : '没有可重做的操作'}
        onClick={() => { const l = h.redo(); if (l) toast(`已重做：${l}`); }}>重做 →</button>
    </span>
  );
}

// 复制到剪贴板 (iframe 里 clipboard API 可能被拦 → 退回 execCommand). 返回是否成功.
export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try { const t2 = document.createElement('textarea'); t2.value = text; t2.style.position = 'fixed'; t2.style.opacity = '0'; document.body.appendChild(t2); t2.select(); const ok = document.execCommand('copy'); t2.remove(); return ok; } catch { return false; }
}

// 小复制按钮 (Frank 11-09: 点了要有反馈): 按钮变「✓ 已复制」1.5 秒 + 顶部提示; 失败也说出来.
export function CopyButton({ text, label = '复制', done = '已复制', className = 'btn sm', what }) {
  const { toast } = useApp();
  const [st, setSt] = useState(null);
  const tm = useRef();
  useEffect(() => () => clearTimeout(tm.current), []);
  const go = async (e) => {
    e.stopPropagation();
    const ok = await copyToClipboard(String(text ?? ''));
    setSt(ok ? 'ok' : 'err');
    toast(ok ? `${what ? `${what} ` : ''}已复制：${String(text).length > 40 ? `${String(text).slice(0, 40)}…` : text}` : '浏览器不让复制，请长按 / 选中手动复制', ok ? undefined : 'err');
    clearTimeout(tm.current); tm.current = setTimeout(() => setSt(null), 1500);
  };
  return <button type="button" className={`${className} copy-btn${st === 'ok' ? ' copied' : ''}`} onClick={go}>{st === 'ok' ? `✓ ${done}` : st === 'err' ? '复制失败' : label}</button>;
}

// 拖拽排序列表 (Frank 11-09: 凡是调顺序一律能拖 + 有动画, 不要只给上下箭头)
// items: 数组; keyOf(item) → 唯一 key; render(item, i) → 行内容; onChange(新数组)
// 按住 ⋮⋮ (或整行) 上下拖, 其他行实时让位 (FLIP 动画); 手机触屏同样能拖.
export function SortList({ items, keyOf, render, onChange, gap = 6, className = '' }) {
  const box = useRef(null);
  const rects = useRef(new Map());
  const [drag, setDrag] = useState(null);       // { key, dy, startY, startIdx }
  const order = useRef(items);
  order.current = items;
  // FLIP: 每次顺序变了, 其他行从旧位置平滑滑到新位置
  React.useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const now = new Map();
    for (const c of el.children) now.set(c.dataset.k, c.getBoundingClientRect().top);
    for (const c of el.children) {
      const k = c.dataset.k; if (drag && k === drag.key) continue;
      const before = rects.current.get(k), after = now.get(k);
      if (before != null && after != null && Math.abs(before - after) > 1) {
        c.style.transition = 'none'; c.style.transform = `translateY(${before - after}px)`;
        requestAnimationFrame(() => { c.style.transition = 'transform .18s ease'; c.style.transform = ''; });
      }
    }
    rects.current = now;
  });
  const down = (e, it) => {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest('button,input,select,textarea,a,label')) return;
    e.preventDefault(); e.stopPropagation();   // 嵌套列表只拖最里面那层
    const k = String(keyOf(it));
    setDrag({ key: k, dy: 0, startY: e.clientY });
    const move = (ev) => {
      const el = box.current; if (!el) return;
      setDrag((d) => d && { ...d, dy: ev.clientY - d.startY });
      const kids = [...el.children];
      const me = kids.find((c) => c.dataset.k === k); if (!me) return;
      const myRect = me.getBoundingClientRect(); const mid = myRect.top + myRect.height / 2;
      const cur = order.current; const i = cur.findIndex((x) => String(keyOf(x)) === k);
      let j = i;
      const prev = kids[i - 1], next = kids[i + 1];
      if (prev && mid < prev.getBoundingClientRect().top + prev.getBoundingClientRect().height / 2) j = i - 1;
      else if (next && mid > next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2) j = i + 1;
      if (j !== i) {
        const n = [...cur]; const [x] = n.splice(i, 1); n.splice(j, 0, x);
        const shift = (j > i ? 1 : -1) * ((j > i ? next : prev).getBoundingClientRect().height + gap);
        setDrag((d) => d && { ...d, startY: d.startY + shift, dy: ev.clientY - (d.startY + shift) });
        onChange(n);
      }
    };
    const up = () => { setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  return (
    <div ref={box} className={`sortlist ${className}`} style={{ display: 'flex', flexDirection: 'column', gap }}>
      {items.map((it, i) => {
        const k = String(keyOf(it)); const me = drag?.key === k;
        return (
          <div key={k} data-k={k} className={`sort-row${me ? ' dragging' : ''}`} onPointerDown={(e) => down(e, it)}
            style={me ? { transform: `translateY(${drag.dy}px) scale(1.02)`, zIndex: 5, position: 'relative' } : undefined}>
            <span className="sort-handle" aria-label="拖动排序">⋮⋮</span>
            <div className="sort-body">{render(it, i)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ⓘ 长说明收进来, 悬停 / 点开看 (11-09 196)
export const Info = ({ children }) => (children ? <span className="info-i" tabIndex={0}>i<span className="info-tip">{children}</span></span> : null);
// 表单一行: 「标签：[控件]」
export const FRow = ({ label, req, children, style }) => (
  <div className="frow" style={style}><span className={`fl ${req ? 'req' : ''}`}>{label}</span><div className="fc">{children}</div></div>
);
