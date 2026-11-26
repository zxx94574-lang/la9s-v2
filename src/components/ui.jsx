import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ymd, today, pad, periodRange, PERIODS, periodGroup, periodLabel, monthWeeks, weekOf } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { normPhone } from '../lib/phone.js';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

// 408 (Frank 11-18, 全局): 点提交有没填 / 填错的 → 自动滚到第一个标红的那一项、放在屏幕中间, 光标落进去, 轻轻闪一下.
// 所有表单的必填都用同一批标红 class (err-in / err / invalid), 所以这里一处实现全站生效; 报错提示照样保留.
export function focusFirstError() {
  const scopes = [...document.querySelectorAll('.overlay .modal, .drawer')]; const scope = scopes.length ? scopes[scopes.length - 1] : document;
  const el = [...scope.querySelectorAll('.err-in, .chip.err, .proofbox.err, .cell-in.err, .in.invalid, [aria-invalid="true"], td.cell-err')].find((e) => e.offsetParent !== null);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const f = el.matches('input,textarea,button,select') ? el : el.querySelector('input,textarea,button');
  try { f?.focus({ preventScroll: true }); } catch { /* 不能聚焦就只滚过去 */ }
  el.classList.remove('err-flash'); void el.offsetWidth; el.classList.add('err-flash'); setTimeout(() => el.classList.remove('err-flash'), 1400);
}

// ── toast ──
export function useToasts() {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random();
    // 408: 同一句提示同时只显示一条 (连点两次不叠两条)
    setItems((x) => [...x.filter((i) => !(i.text === text && i.tone === tone)).slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === 'err' ? 4200 : 2400);
    if (tone === 'err' && navigator.vibrate) navigator.vibrate(30);
    if (tone === 'err') setTimeout(focusFirstError, 60);
  }, []);
  const view = (
    <div className="toasts">{items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
  );
  return [push, view];
}

// ── modal ──
// risk (11-18 Frank 第 7 点, 变动两级确认): 'red' = 大变动 (动钱 / 动库存 / 改客户已确认的东西) → 确认后自动通知中方; 'yellow' = 小变动, 再核对一次
export function Modal({ title, onClose, children, footer, wide, risk }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-h"><h2>{title}</h2><button className="close-x" onClick={onClose} aria-label="关闭">×</button></div>
        {risk && <div className={`risk-strip ${risk}`}>{risk === 'red' ? '大变动：确认之后会自动通知中方（红色事件），留在记录里。' : '小变动：确认前再核对一遍。'}</div>}
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

// 502 (Frank 11-23): 影响大 / 撤不回的操作一律先弹确认 —— 写清「点了会发生什么」. 用法和普通按钮一样, 多给 title + body.
export function ConfirmBtn({ className = 'btn sm', title, body, okText = '确认', risk = 'yellow', onOk, disabled, tip, children }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onOk(); } finally { setBusy(false); setOpen(false); } };
  return (<>
    <button type="button" className={className} disabled={disabled} title={tip} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{children}</button>
    {open && <Modal risk={risk} title={title} onClose={() => setOpen(false)} footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>先不动</button><button type="button" className="btn primary" disabled={busy} onClick={go}>{okText}</button></>}>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{body}</div>
    </Modal>}
  </>);
}

// 客户档位固定配色 (Frank 11-09, 同飞书): S 黄 / Wholesale 红 / Retail 蓝 / Repair 绿
export const TIER_TONE = { S: 'amber', WHOLESALE: 'red', RETAIL: 'blue', REPAIR: 'green' };
const TIER_NAME = { S: 'S', WHOLESALE: 'Wholesale shop', RETAIL: 'Retail shop', REPAIR: 'Repair shop' };
const TIER_SHORT = { S: 'S', WHOLESALE: 'Wholesale', RETAIL: 'Retail', REPAIR: 'Repair' };
// 473 (Frank 11-20): 凡出现档位一律这个色块 (S 黄 / Wholesale 红 / Retail 蓝 / Repair 绿); short = 窄处去掉 shop, 不缩成单字母 (Retail / Repair 都是 R)
export const TierPill = ({ tier, empty = '没档位', suffix = '', short }) => (tier ? <span className={`pill tierp ${TIER_TONE[tier] || 'gray'}`}>{(short ? TIER_SHORT : TIER_NAME)[tier] || tier}{suffix}</span> : <span className="pill gray">{empty}</span>);
export const tierOpt = (o) => <TierPill tier={o.v} />;
// 一句话里的档位名 (日志 / 提示是存成字的) → 显示时换成色块
const TIER_WORD = { 'Wholesale shop': 'WHOLESALE', 'Retail shop': 'RETAIL', 'Repair shop': 'REPAIR', Wholesale: 'WHOLESALE', Retail: 'RETAIL', Repair: 'REPAIR', S: 'S' };
const TIER_RE = /(Wholesale shop|Retail shop|Repair shop|Wholesale|Retail|Repair|(?<![A-Za-z0-9-])S(?![A-Za-z0-9-]))/g;
export const TierText = ({ children }) => {
  if (typeof children !== 'string') return children ?? null;
  const parts = children.split(TIER_RE);
  if (parts.length === 1) return children;
  return <>{parts.map((x, i) => (i % 2 ? <TierPill key={i} tier={TIER_WORD[x]} short={!x.endsWith('shop') && x !== 'S'} /> : x))}</>;
};
// 订单三色灯 (Frank 11-09 19:10): 红 = 已取消 / 黄 = 进行中 / 绿 = 已完成
export const LIGHT = { done: ['green', '已完成'], active: ['amber', '进行中'], cancelled: ['red', '已取消'] };
export const Light = ({ v }) => { const [tone, label] = LIGHT[v] || LIGHT.active; return <span className={`pill ${tone}`}>{label}</span>; };
export const Pill = ({ tone = 'gray', children }) => <span className={`pill ${tone}`}>{typeof children === 'string' ? t(children) : children}</span>;

// ── shared models: summary, hover (desktop) / tap (phone) for all ──
// 通用性 (Frank 11-13 283, 底层规则): 格子多宽就显示几个型号, 放不下的收成「+N」; 拖列宽实时重算.
// 「+N」电脑悬停 / 手机轻点 → 浮出全部 (浮层挂在 body 上, 不会被表格格子裁掉).
let _mc; const textW = (t, font) => { _mc = _mc || document.createElement('canvas').getContext('2d'); _mc.font = font; return _mc.measureText(t).width; };
export function Shared({ list }) {
  const ref = useRef(); const [n, setN] = useState(list?.length || 0); const [pop, setPop] = useState(null); const timer = useRef();
  const key = (list || []).join('|');
  useEffect(() => {
    const el = ref.current; if (!el || !list?.length) return undefined;
    const calc = () => {
      const host = el.closest('td') || el.parentElement; const cs = getComputedStyle(host);
      const W = host.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - 2;
      const font = getComputedStyle(el).font || '13px sans-serif';
      let k = list.length;
      for (; k > 1; k--) { const more = list.length - k; if (textW(list.slice(0, k).join(' / '), font) + (more ? 34 + String(more).length * 7 : 0) <= W) break; }
      if (k === 1 && list.length > 1 && textW(list[0], font) + 40 > W) k = 1;
      setN(k);
    };
    calc(); const ro = new ResizeObserver(calc); ro.observe(el.closest('td') || el.parentElement); return () => ro.disconnect();
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pop) return undefined;
    const off = (e) => { if (!ref.current?.contains(e.target) && !e.target.closest?.('.shared-pop')) setPop(null); };
    const sc = () => setPop(null);
    document.addEventListener('pointerdown', off); window.addEventListener('scroll', sc, true);
    return () => { document.removeEventListener('pointerdown', off); window.removeEventListener('scroll', sc, true); };
  }, [pop]);
  if (!list || !list.length) return <span className="muted">—</span>;
  const more = list.length - n;
  const open = () => { const r = ref.current.getBoundingClientRect(); const w = Math.min(340, window.innerWidth - 16); setPop({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), w, ...(window.innerHeight - r.bottom > 180 ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) }); };
  return (
    <span ref={ref} className="shared" onMouseEnter={() => { if (more > 0) { clearTimeout(timer.current); timer.current = setTimeout(open, 200); } }} onMouseLeave={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setPop(null), 250); }}>
      <span className="s-text">{list.slice(0, n).join(' / ')}</span>
      {more > 0 && <button type="button" className="more" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); clearTimeout(timer.current); if (pop) setPop(null); else open(); }}>+{more}</button>}
      {pop && createPortal(<span className="shared-pop" style={{ left: pop.left, width: pop.w, top: pop.top, bottom: pop.bottom }} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={() => setPop(null)}><b>通用 {list.length} 个型号</b><br />{list.join(' / ')}</span>, document.body)}
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

export function DatePicker({ value, onChange, range, label, align, ...rest }) {
  if (range) return <RangePicker value={value} onChange={onChange} label={label} {...rest} />;
  return <DatePicker1 value={value} onChange={onChange} label={label} align={align} />;
}
// 477 (Frank 11-20): 一段日期 = 一个框 + 一个日历, 点两下: 第一下是一头, 第二下是另一头 (往前点往后点自己排先后), 同一天点两下 = 那一天;
// 两下之间鼠标移到哪天, 中间那段先浅浅亮出来; 第一下点完就关 = 只选那一天; 翻月 / 翻年第一下记着. 年、月下拉保留.
export function RangePicker({ value, onChange, label, on, placeholder = '选日期' }) {
  const [open, setOpen] = useState(false); const [pick, setPick] = useState(null); const [hov, setHov] = useState(null);
  const [ym, setYm] = useState(() => { const d = new Date(value?.[1] || today()); return [d.getFullYear(), d.getMonth()]; });
  const btn = useRef(null); const pop = useRef(null); const [pos, setPos] = useState(null);
  usePopBus(open, () => setOpen(false));
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect(); if (!r) return; const w = Math.min(300, window.innerWidth - 16);
    const below = window.innerHeight - r.bottom; const up = below < 340 && r.top > below;
    setPos({ width: w, left: Math.max(8, Math.min(r.right - w, window.innerWidth - 8 - w)), ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  }, []);
  useLayoutEffect(() => {
    if (!open) return undefined; place();
    const out = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    const sc = (e) => { if (!pop.current?.contains(e.target)) place(); };
    document.addEventListener('pointerdown', out); window.addEventListener('resize', place); window.addEventListener('scroll', sc, true);
    return () => { document.removeEventListener('pointerdown', out); window.removeEventListener('resize', place); window.removeEventListener('scroll', sc, true); };
  }, [open, place]);
  useEffect(() => { if (!open) { setPick(null); setHov(null); } }, [open]);
  const toggle = () => { if (!open) { const d = new Date(value?.[1] || today()); setYm([d.getFullYear(), d.getMonth()]); } setOpen(!open); };
  const [y, m] = ym; const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate(); const lead = (first.getDay() + 6) % 7; const t = today();
  const click = (s) => {
    if (!pick) { setPick(s); setHov(s); onChange([s, s]); return; }
    onChange(pick <= s ? [pick, s] : [s, pick]); setOpen(false);
  };
  let [a, b] = value || [null, null];
  if (pick) { const o = hov || pick; [a, b] = pick <= o ? [pick, o] : [o, pick]; }
  const step = (d) => { const nd = new Date(y, m + d, 1); setYm([nd.getFullYear(), nd.getMonth()]); };
  return (
    <span className="dp">
      <button type="button" ref={btn} className={`rp-btn ${on ? 'on' : ''} ${open ? 'open' : ''}`} onClick={toggle} title={`自定义：点开日历，点两下选一段${value?.[0] ? `（现在 ${rangeText(value[0], value[1])}）` : ''}`}>
        {label && <span className="muted small">{label}</span>}<span className="rp-ico">▦</span><b>{value?.[0] ? rangeText(value[0], value[1]).replace(/ · \d+ 天$/, '') : placeholder}</b>
      </button>
      {open && pos && createPortal(
        <div className="dp-pop rp-pop" ref={pop} style={{ position: 'fixed', ...pos }}>
          <div className="dp-head">
            <button type="button" className="rp-arr" onClick={() => step(-1)} aria-label="上个月">‹</button>
            <select className="in" value={y} onChange={(e) => setYm([+e.target.value, m])}>{yearList(y).map((v) => <option key={v} value={v}>{v} 年</option>)}</select>
            <select className="in" value={m} onChange={(e) => setYm([y, +e.target.value])}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i}>{i + 1} 月</option>)}</select>
            <button type="button" className="rp-arr" onClick={() => step(1)} aria-label="下个月">›</button>
          </div>
          <div className="dp-now">{pick ? <>从 <b>{pick}</b> 起，再点一天（前后都行）</> : <>点第一天，再点另一天</>}</div>
          <div className="dp-grid" onMouseLeave={() => pick && setHov(pick)}>
            {WEEK.map((w) => <div key={w} className="w">{w}</div>)}
            {Array.from({ length: lead }, (_, i) => <span key={'b' + i} />)}
            {Array.from({ length: days }, (_, i) => {
              const s = ymd(new Date(y, m, i + 1));
              const cls = [s === t ? 'today' : '', s === a || s === b ? 'on' : '', a && s > a && s < b ? (pick ? 'inrange pv' : 'inrange') : '', s === a ? 'rs' : '', s === b ? 're' : ''].join(' ');
              return <button type="button" key={s} className={cls} onMouseEnter={() => pick && setHov(s)} onClick={() => click(s)}>{i + 1}</button>;
            })}
          </div>
          <div className="rp-foot"><b>{a ? rangeText(a, b) : ''}</b><span className="grow" /><button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>关闭</button></div>
        </div>, document.body)}
    </span>);
}
function DatePicker1({ value, onChange, range, label, align }) {
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
  return { src: m.src, srcLabel: SRC_LABEL[m.src] || '未知来源', at: m.at, ft: m.ft, et: m.et, by: m.by };
}
// EXIF DateTimeOriginal (0x9003) / DateTime (0x0132) from a JPEG, local time "YYYY:MM:DD HH:MM:SS" → ISO-ish; null if none
export async function exifTime(file) {
  try {
    if (!/jpe?g/i.test(file.type)) return null;
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      const mk = v.getUint16(o); const len = v.getUint16(o + 2);
      if (mk === 0xffe1 && v.getUint32(o + 4) === 0x45786966) {
        const t = o + 10; const le = v.getUint16(t) === 0x4949;
        const u16 = (x) => v.getUint16(x, le); const u32 = (x) => v.getUint32(x, le);
        const str = (x, n) => { let r = ''; for (let k = 0; k < n - 1; k++) r += String.fromCharCode(v.getUint8(x + k)); return r; };
        let found = null;
        const ifd = (off) => { const n = u16(t + off); for (let k = 0; k < n; k++) { const e = t + off + 2 + k * 12; const tag = u16(e);
          if (tag === 0x9003 || (tag === 0x0132 && !found)) found = str(t + u32(e + 8), 20);
          if (tag === 0x8769) ifd(u32(e + 8)); } };
        ifd(u32(t + 4));
        const m = found && found.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : null;
      }
      if ((mk & 0xff00) !== 0xff00) return null;
      o += 2 + len;
    }
  } catch { /* not readable */ }
  return null;
}
async function encodeImage(file, src, by) {
  const et = await exifTime(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const s = Math.min(1, 900 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const b64 = c.toDataURL('image/jpeg', 0.72).split(',')[1];
  const enc = encodeURIComponent;
  return `data:image/jpeg;src=${src};at=${enc(new Date().toISOString())};ft=${enc(new Date(file.lastModified || Date.now()).toISOString())};by=${enc(by || '')}${et ? `;et=${enc(et)}` : ''};base64,${b64}`;
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
      if (uses.length) {
        toast?.(`这张图片已用于 ${uses[0].doc}，请确认不是旧图（可以继续，会通知中方）`, 'err');
        // 290 (Frank 11-13): 全站所有凭证 —— 同一张图用在别处: 不拦、不审批, 记一条「变更通知」给中方
        const { call } = await import('../db/client.js'); const dealId = (location.hash.match(/deal\/([0-9a-f-]{36})/) || [])[1] || null;
        call(role, `select app.note_dup_photo($1,$2,$3,$4)`, [org, dealId, label, uses.map((u) => u.doc).join('、')]).catch(() => {});
      }
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
          : <><b>{label}</b><span className="small muted hide-touch">点这里后 ⌘/Ctrl+V 粘贴截图 · 拖进来</span></>}</span>
        {camera && <button type="button" className="btn sm" onClick={() => cam.current.click()}>📷 拍照</button>}
        <button type="button" className="btn sm" title="把刚截的图粘进来（截图后先在相册里「拷贝」，或截图时选「拷贝并删除」）" onClick={async () => {   // 11-26 Frank：截图后直接粘贴
          try {
            const items = await navigator.clipboard.read();
            for (const it of items) { const t = it.types.find((x) => x.startsWith('image/')); if (t) { const b = await it.getType(t); return take(new File([b], 'paste.png', { type: t }), 'paste'); } }
            toast?.('剪贴板里没有图片：截图后在相册里点「拷贝」，再回来点粘贴', 'err');
          } catch { box.current?.focus(); toast?.('这个浏览器不让按钮直接读剪贴板：长按框里「长按粘贴」那几个字，选「粘贴」', 'err'); }
        }}>📋 粘贴</button>
        <span className="pb-paste show-touch" contentEditable suppressContentEditableWarning onPaste={onPaste} onInput={(e) => { e.currentTarget.textContent = '长按粘贴'; }}>长按粘贴</span>
        <button type="button" className="btn sm" onClick={() => pick.current.click()}>选图</button>
        {value && <button type="button" className="btn sm ghost" onClick={() => { onChange(''); setDup([]); }} title="清除">×</button>}
        <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files[0], 'camera'); e.target.value = ''; }} />
        <input ref={pick} type="file" accept="image/*" hidden onChange={(e) => { take(e.target.files[0], 'gallery'); e.target.value = ''; }} />
      </div>
      {dup.length > 0 && <div className="dup-warn">⚠ 这张图片已用于 {dup.slice(0, 2).join('、')}{dup.length > 2 && <span title={dup.join('\n')}> 等 {dup.length} 处</span>}</div>}
    </div>
  );
}

// thumbnail: hover = bigger preview, click = full viewer (←/→ through the group, who / when / how it was taken)
const DUP_CACHE = new Map();
function useDupUses(src) {
  const { org } = useApp() || {}; const [uses, setUses] = useState(null);
  useEffect(() => {
    if (!src?.startsWith?.('data:') || !org) return undefined;
    const b = src.split('base64,')[1]; if (!b) return undefined; const k = b.length + ':' + b.slice(-80);
    if (DUP_CACHE.has(k)) { setUses(DUP_CACHE.get(k)); return undefined; }
    let live = true;
    const t = setTimeout(async () => {
      try { const { q } = await import('../db/client.js'); const Q = await import('../db/queries.js'); const u = (await q(Q.proofUses, [org, b])).map((x) => x.doc); DUP_CACHE.set(k, u); if (live) setUses(u); } catch { /* 查不到就不标 */ }
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [src, org]);
  return uses && uses.length > 1 ? uses : null;
}
export function Thumb({ src, size = 40, group, label }) {
  const [open, setOpen] = useState(false);
  const dupUses = useDupUses(src);
  if (!src) return null;
  if (!src.startsWith('data:')) return <span className="pill green" title="演示数据里的占位凭证">✓ {label || '凭证'}（演示）</span>;
  const list = (group || [{ src, label }]).filter((x) => x.src?.startsWith('data:'));
  return (
    <>
      <span className="thumb" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <img src={src} alt={label || '凭证'} style={{ height: size, width: size }} />
        <span className="thumb-pop"><img src={src} alt="" /></span>
        {dupUses && <span className="thumb-dup" title={`同一张图用在 ${dupUses.length} 个地方：${dupUses.join('、')}`}>!</span>}
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
          {m.et ? <span>照片拍摄（EXIF）：<b>{f(m.et)}</b>{m.at && Math.abs(new Date(m.at) - new Date(m.et)) > 864e5 && <span className="pill amber" style={{ marginLeft: 6 }}>比上传早 {Math.round((new Date(m.at) - new Date(m.et)) / 864e5)} 天</span>}</span>
            : <span>{m.src === 'camera' ? '拍摄时间' : '文件时间'}：{f(m.ft)}{m.src !== 'camera' && <span className="muted"> （照片里没有拍摄时间，可能是截图）</span>}</span>}
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
// 11-26 Frank：填到一半被弹出去 / 闪退 / 断网，回来还在 —— 每改一下就存在这台手机上（3 天），交上去以后清掉。
// 用法：把 useState(初值) 换成 useKeep('出库.<单号>', '电话', 初值)；成功后 clearKeep('出库.<单号>')
const KEEP = 'la9s.keep.';
try { for (const k of Object.keys(localStorage)) if (k.startsWith(KEEP)) { const o = JSON.parse(localStorage.getItem(k) || 'null'); if (!o || Date.now() - o.t > 3 * 864e5) localStorage.removeItem(k); } } catch { /* ignore */ }
export function useKeep(scope, field, init) {
  const k = scope ? `${KEEP}${scope}|${field}` : null;
  const [v, setV] = useState(() => {
    if (k) { try { const o = JSON.parse(localStorage.getItem(k) || 'null'); if (o && Date.now() - o.t < 3 * 864e5) return o.v; } catch { /* ignore */ } }
    return typeof init === 'function' ? init() : init;
  });
  const set = useCallback((x) => setV((old) => { const nv = typeof x === 'function' ? x(old) : x; if (k) { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v: nv })); } catch { /* 存不下（图片太大）就算了 */ } } return nv; }), [k]);
  return [v, set];
}
export function clearKeep(scope) { try { for (const k of Object.keys(localStorage)) if (k.startsWith(`${KEEP}${scope}|`)) localStorage.removeItem(k); } catch { /* ignore */ } }

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
  // FLIP: 每次顺序变了, 其他行从旧位置平滑滑到新位置.
  // 11-19 修闪屏: 量位置一律用 offsetTop (不受动画里的 transform 影响); 只在顺序真的变了才做动画;
  // 判断换不换位也按布局位置算, 不按正在动画中的位置算 (否则两行来回换 = 一闪一闪).
  const sig = items.map((x) => String(keyOf(x))).join('|');
  const lastSig = useRef(sig);
  React.useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const now = new Map();
    for (const c of el.children) now.set(c.dataset.k, c.offsetTop);
    if (lastSig.current !== sig) {
      for (const c of el.children) {
        const k = c.dataset.k; if (drag && k === drag.key) continue;
        const before = rects.current.get(k), after = now.get(k);
        if (before != null && after != null && Math.abs(before - after) > 1) {
          c.style.transition = 'none'; c.style.transform = `translateY(${before - after}px)`;
          void c.offsetHeight;
          c.style.transition = 'transform .18s ease'; c.style.transform = '';
        }
      }
      lastSig.current = sig;
    }
    rects.current = now;
  }, [sig]);   // eslint-disable-line react-hooks/exhaustive-deps
  const down = (e, it) => {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest('button,input,select,textarea,a,label')) return;
    e.preventDefault(); e.stopPropagation();   // 嵌套列表只拖最里面那层
    const k = String(keyOf(it));
    let startY = e.clientY;
    setDrag({ key: k, dy: 0, startY });
    const move = (ev) => {
      const el = box.current; if (!el) return;
      const dy = ev.clientY - startY;
      setDrag((d) => d && { ...d, dy });
      const kids = [...el.children];
      const cur = order.current; const i = cur.findIndex((x) => String(keyOf(x)) === k);
      const me = kids[i]; if (!me) return;
      const mid = me.offsetTop + me.offsetHeight / 2 + dy;
      const prev = kids[i - 1], next = kids[i + 1];
      let j = i;
      if (prev && mid < prev.offsetTop + prev.offsetHeight / 2) j = i - 1;
      else if (next && mid > next.offsetTop + next.offsetHeight / 2) j = i + 1;
      if (j !== i) {
        const n = [...cur]; const [x] = n.splice(i, 1); n.splice(j, 0, x);
        const shift = (j > i ? 1 : -1) * ((j > i ? next : prev).offsetHeight + gap);
        startY += shift;
        setDrag((d) => d && { ...d, startY, dy: ev.clientY - startY });
        onChange(n);
      }
    };
    const up = () => { setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  return (
    <div ref={box} className={`sortlist ${className}`} style={{ display: "flex", flexDirection: "column", gap, position: "relative" }}>
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
// 264 (Frank 11-12): 核对类提醒只给中方一个感叹号 (红 = 低于成本, 黄 = 低于底价 / 档位), 不写字; 鼠标移上去 / 点一下才显示细节
// 「这条是 Claude 按建议定的」小标记 (Frank 11-18: 不确定的按你的建议, 做完用小感叹号标出来说明). 蓝色小感叹号, 悬停 / 点一下看说明.
export const Assumed = ({ children }) => <span className="info-i bang assumed" tabIndex={0}>!<span className="info-tip"><b>这条是 Claude 按建议先定的，你没逐条拍过板：</b>{children} 觉得不对告诉我改。</span></span>;
export const Bang = ({ tone = 'red', children }) => <span className={`info-i bang ${tone}`} tabIndex={0} title={typeof children === 'string' ? children : undefined}>!<span className="info-tip">{children}</span></span>;
export const lowTip = ({ fl, px, cost, s, tier }, f) => (fl === '会亏' ? `低于到岸成本：成本 ${f(cost)}，这个价 ${f(px)}，每片低 ${f(cost - px)}` : fl === '低于底价' ? `低于 S 档底价：S 档 ${f(s)}，这个价 ${f(px)}` : `低于这个客户的档位价：档位价 ${f(tier)}，这个价 ${f(px)}`);
// 表单一行: 「标签：[控件]」
export const FRow = ({ label, req, children, style }) => (
  <div className="frow" style={style}><span className={`fl ${req ? 'req' : ''}`}>{label}</span><div className="fc">{children}</div></div>
);

// 电话输入 (Frank 11-11 211): 全站同一个. 打字随意, 离开格子自动整理成 +225 07 00 00 00 04; 位数不对标红并写原因.
export function PhoneInput({ value, onChange, invalid, placeholder = '例如 07 00 00 00 04', style, autoFocus }) {
  const [txt, setTxt] = React.useState(value || '');
  React.useEffect(() => { setTxt(value || ''); }, [value]);
  const n = normPhone(txt);
  const bad = !n.empty && !n.valid;
  const done = () => { if (!n.empty && n.valid) { setTxt(n.formatted); onChange?.(n.formatted); } else onChange?.(n.empty ? '' : txt); };
  return (
    <span className="phone-in" style={style}>
      <input className={`in ${bad || invalid ? 'err-in' : ''}`} inputMode="tel" autoFocus={autoFocus} value={txt} placeholder={placeholder}
        onChange={(e) => setTxt(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />
      {bad && <span className="why">{n.need ? `已输 ${n.local.length} / ${n.need} 位${n.local.length > n.need ? '，多了' : ''}` : '位数不对'}</span>}
    </span>
  );
}
export const phoneValid = (v) => { const n = normPhone(v); return n.empty || n.valid; };

// 汇率输入 (Frank 11-11 213): 两种写法随时切 (⇄)。value 永远是「1 a = value b」(例 1 CNY = 93.46 XOF), 只存这一个数, 不会存反。
// 算人民币习惯「1 XOF = 0.0107 CNY」, 算美元习惯「1 USD = 600 XOF」; 每个币种记住上次用的写法; 旁边实时显示另一种写法防填反。
const RATE_MODE_KEY = 'la9s.rateMode';
const readMode = (a, b) => { try { return JSON.parse(localStorage.getItem(RATE_MODE_KEY) || '{}')[`${a}/${b}`]; } catch { return null; } };
const saveMode = (a, b, m) => { try { const o = JSON.parse(localStorage.getItem(RATE_MODE_KEY) || '{}'); o[`${a}/${b}`] = m; localStorage.setItem(RATE_MODE_KEY, JSON.stringify(o)); } catch { /* 浏览器不让存就算了 */ } };
const trimNum = (n, d) => (n > 0 && Number.isFinite(n) ? String(+n.toFixed(d)) : '');
export function RateInput({ a, b = 'XOF', value, onChange, placeholder, invalid, width = 110 }) {
  const [mode, setMode] = useState(() => readMode(a, b) || (a === 'CNY' ? 'inv' : 'per'));   // per: 1 a = ? b ; inv: 1 b = ? a
  useEffect(() => { setMode(readMode(a, b) || (a === 'CNY' ? 'inv' : 'per')); }, [a, b]);
  const v = Number(value) || 0;
  const shown = (m) => (m === 'per' ? trimNum(v, 4) : trimNum(v ? 1 / v : 0, 6));
  const [txt, setTxt] = useState(shown(mode));
  useEffect(() => { setTxt((t) => { const n = Number(t); const cur = mode === 'per' ? n : (n ? 1 / n : 0); return Math.abs(cur - v) > 1e-9 ? shown(mode) : t; }); }, [value, mode]);   // eslint-disable-line react-hooks/exhaustive-deps
  const type = (s) => { const t = s.replace(/[^\d.]/g, ''); setTxt(t); const n = Number(t); onChange?.(n > 0 ? (mode === 'per' ? n : 1 / n) : ''); };
  const flip = () => { const m = mode === 'per' ? 'inv' : 'per'; setMode(m); saveMode(a, b, m); setTxt(shown(m)); };
  const [l, r] = mode === 'per' ? [a, b] : [b, a];
  const other = v > 0 ? (mode === 'per' ? `1 ${b} ≈ ${trimNum(1 / v, 6)} ${a}` : `1 ${a} ≈ ${trimNum(v, 2)} ${b}`) : '';
  return (
    <span className="rate-in">
      <span className="rate-l">1 {l} =</span>
      <input className={`in ${invalid ? 'err-in' : ''}`} inputMode="decimal" style={{ width }} value={txt} placeholder={placeholder != null ? (mode === 'per' ? placeholder : (Number(placeholder) ? trimNum(1 / Number(placeholder), 6) : '')) : '手填'} onChange={(e) => type(e.target.value)} />
      <span className="rate-l">{r}</span>
      <button type="button" className="btn sm ghost" title="换一种写法" onClick={flip}>⇄</button>
      {other && <span className="small muted">（{other}）</span>}
    </span>
  );
}

// 「⋯ 更多」(减法巡检 C4, 11-17): 不常用 / 危险的操作收在这里, 不在页面上放红色大按钮. items = [[label, run, tone?]]
// ── Choice: 全站单选控件 (Frank 11-17 定, 352 / 354 / 360) ──
// 选项 ≤ 3 个且字短 → 一排平铺按钮; ≥ 4 个 → 下拉, 第一行永远是搜索 (包含即匹配, 不分大小写).
// 平铺和下拉同高同圆角. options: ['a', 'b'] 或 [[值, 显示名, 右侧小字?]]. empty = 「不选」那一项的名字 (给了才有).
const sv = (x) => (x == null ? '' : String(x));
const normOpts = (options) => (options || []).filter((o) => o != null).map((o) => (Array.isArray(o) ? { v: o[0], l: String(o[1] ?? o[0]), hint: o[2] } : (typeof o === 'object' ? { v: o.v ?? o.value ?? o.id, l: String(o.l ?? o.label ?? o.name ?? ''), hint: o.hint } : { v: o, l: String(o) })));
export function Choice({ value, onChange, options, empty, placeholder = '请选择', err, disabled, flat, width, style, className = '', size, renderOpt }) {
  const show = (o) => (renderOpt && !o.empty ? renderOpt(o) : o.l);
  const opts = normOpts(options);
  // 11-26 Frank：手机屏幕窄，一排放不下就变成下拉（只占一格）；放得下（最多 3 个、字加起来不长）才平铺
  const phone = typeof window !== 'undefined' && window.innerWidth < 640;
  const totalLen = opts.reduce((n, o) => n + String(o.l || '').length, 0) + (empty ? String(empty).length : 0);
  const asFlat = flat ?? (opts.length + (empty ? 1 : 0) <= 3 && opts.every((o) => o.l.length <= 12) && (!phone || totalLen <= 12));
  const [open, setOpen] = useState(false); const [kw, setKw] = useState(''); const [hi, setHi] = useState(0); const [pos, setPos] = useState(null);
  const btn = useRef(null); const pop = useRef(null); const qin = useRef(null);
  usePopBus(open, () => setOpen(false));
  const all = empty ? [{ v: '', l: empty, empty: true }, ...opts] : opts;
  const k = kw.trim().toLowerCase();
  const list = k ? all.filter((o) => o.l.toLowerCase().includes(k) || String(o.hint || '').toLowerCase().includes(k)) : all;
  const cur = opts.find((o) => sv(o.v) === sv(value));
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect(); if (!r) return;
    const w = Math.min(Math.max(r.width, 240), window.innerWidth - 16);
    const h = Math.min(360, window.innerHeight - 16);
    const below = window.innerHeight - r.bottom - 8, up = below < Math.min(h, 220) && r.top > below;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)), width: w, maxHeight: Math.max(160, Math.min(h, (up ? r.top : below) - 4)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, []);
  useLayoutEffect(() => {
    if (!open) return undefined;
    place(); setKw(''); setHi(Math.max(0, all.findIndex((o) => sv(o.v) === sv(value))));
    const t = setTimeout(() => { if (window.innerWidth > 760) qin.current?.focus(); }, 0);
    const out = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    const sc = (e) => { if (!pop.current?.contains(e.target)) place(); };
    document.addEventListener('pointerdown', out); window.addEventListener('resize', place); window.addEventListener('scroll', sc, true);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', out); window.removeEventListener('resize', place); window.removeEventListener('scroll', sc, true); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place]);
  useEffect(() => { pop.current?.querySelector('.opt.hi')?.scrollIntoView({ block: 'nearest' }); }, [hi, open]);
  const pick = (o) => { onChange(o.v); setOpen(false); btn.current?.focus(); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) pick(list[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
  };
  if (asFlat) return (
    <span className={`choice-flat ${size === 'sm' ? 'sm' : ''} ${className}`} style={style} role="radiogroup">
      {all.map((o) => { const on = sv(o.v) === sv(value); return (
        <button type="button" key={sv(o.v)} role="radio" aria-checked={on} disabled={disabled} className={`chip ${on ? 'on' : ''} ${err && !cur && !empty ? 'err' : ''}`} onClick={() => onChange(o.v)}>{show(o)}</button>); })}
    </span>);
  return (
    <>
      <button type="button" ref={btn} disabled={disabled} className={`in choice-btn ${size === 'sm' ? 'sm' : ''} ${err && !cur ? 'err-in' : ''} ${className}`} style={{ width, ...style }} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); } }}>
        <span className={`choice-v ${cur ? '' : 'ph'}`}>{cur ? show(cur) : (empty && (value ?? '') === '' ? empty : placeholder)}</span><span className="choice-caret">▾</span>
      </button>
      {open && pos && createPortal(
        <div className="menu choice-pop" ref={pop} style={{ position: 'fixed', ...pos }} role="listbox" onKeyDown={key}>
          <input ref={qin} className="in choice-q" placeholder="搜索…" value={kw} onChange={(e) => { setKw(e.target.value); setHi(0); }} />
          <div className="choice-list">
            {list.map((o, i) => { const on = sv(o.v) === sv(value); return (
              <button type="button" key={sv(o.v)} role="option" aria-selected={on} className={`opt ${i === hi ? 'hi' : ''} ${on ? 'on' : ''} ${o.empty ? 'muted' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
                <span className="opt-l">{show(o)}</span>{o.hint ? <span className="opt-h">{o.hint}</span> : null}{on ? <span className="tick">✓</span> : null}
              </button>); })}
            {!list.length && <div className="small muted" style={{ padding: 10 }}>没有匹配的选项</div>}
          </div>
        </div>, document.body)}
    </>);
}

export function MoreMenu({ items, label = '⋯ 更多', title = '更多操作' }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  usePopBus(open, () => setOpen(false));
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" className="btn sm" title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className="menu more-menu" role="menu">
        {list.map(([l, run, tone]) => <button type="button" key={l} role="menuitem" className={`mi ${tone === 'danger' ? 'danger' : ''}`} onClick={() => { setOpen(false); run(); }}>{l}</button>)}
      </div>}
    </span>
  );
}

// 页面设置 (Frank 11-13 293): 每页标题旁一个小 ⚙, 收这页自己的设置 (种类顺序 / 调整版面 / 选项设置…); 右上角的 ⚙ 只放系统级的
export function PageGear({ items, title = '这一页的设置' }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  usePopBus(open, () => setOpen(false));
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" className="gear-btn" title={title} aria-label={title} onClick={() => setOpen((o) => !o)}>⚙</button>
      {open && <div className="menu" style={{ right: 0, top: '100%', marginTop: 4, minWidth: 200 }}>
        {list.map(([label, run]) => <button type="button" key={label} className="mi" onClick={() => { setOpen(false); run(); }}>{label}</button>)}
      </div>}
    </span>
  );
}


// ── NumInput: 全站金额 / 数量输入框 (Frank 11-18 412) ── 边输边加千分位 (300000 → 300,000), 右对齐, 光标不乱跳; 存的是纯数字.
// decimals: XOF 0 位 (不许小数), CNY / USD 2 位; 也可以直接给 cur. value: 数字或 ''. onChange(数字 或 '').
const groupNum = (t) => { const [a, b] = t.split('.'); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b != null ? `.${b}` : ''); };
export function NumInput({ value, onChange, cur, decimals, invalid, className = '', style, placeholder, disabled, autoFocus, onEnter, title, width }) {
  const d = decimals ?? (cur && cur !== 'XOF' ? 2 : 0);
  const clean = (raw) => { let t = String(raw ?? '').replace(/[^\d.]/g, ''); if (d === 0) t = t.replace(/\./g, ''); else { const i = t.indexOf('.'); if (i >= 0) t = t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, '').slice(0, d); } return t.replace(/^0+(?=\d)/, ''); };
  const [txt, setTxt] = useState(() => (value === '' || value == null ? '' : clean(value)));
  const ref = useRef(null); const caret = useRef(null);
  useEffect(() => { setTxt((t) => (value === '' || value == null ? (t === '' ? t : '') : (Number(t) === Number(value) ? t : clean(value)))); }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (caret.current == null || !ref.current) return; const shown = ref.current.value; let n = caret.current, i = 0; while (i < shown.length && n > 0) { if (shown[i] !== ',') n -= 1; i += 1; } try { ref.current.setSelectionRange(i, i); } catch { /* 手机上有的键盘不让设光标 */ } caret.current = null; });
  const type = (e) => { const raw = e.target.value; const pos = e.target.selectionStart ?? raw.length; caret.current = raw.slice(0, pos).replace(/[^\d.]/g, '').length; const t = clean(raw); setTxt(t); onChange?.(t === '' || t === '.' ? '' : Number(t)); };
  return <input ref={ref} className={`in num-in ${invalid ? 'err-in' : ''} ${className}`} style={{ width, ...style }} inputMode={d ? 'decimal' : 'numeric'} value={groupNum(txt)} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} title={title}
    onChange={type} onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }} />;
}

// ── MultiChoice: 带搜索的多选下拉 (Frank 11-18 367: 选人 / 选部门不许平铺一大片) ──
// options: [{ v, l, hint?, group? }]; value: [v…]. 选中的显示成小标, 点 × 去掉; 点开第一行搜索 (包含即匹配, 不分大小写), 可以连着勾.
export function MultiChoice({ value, onChange, options, placeholder = '请选择（可多选）', err, style, max }) {
  const [open, setOpen] = useState(false); const [kw, setKw] = useState(''); const [pos, setPos] = useState(null);
  const btn = useRef(null); const pop = useRef(null); const qin = useRef(null);
  usePopBus(open, () => setOpen(false));
  const vals = value || []; const opts = options || [];
  const k = kw.trim().toLowerCase();
  const list = k ? opts.filter((o) => `${o.l} ${o.hint || ''}`.toLowerCase().includes(k)) : opts;
  const place = useCallback(() => { const r = btn.current?.getBoundingClientRect(); if (!r) return; const w = Math.min(Math.max(r.width, 280), window.innerWidth - 16); const below = window.innerHeight - r.bottom - 8; const up = below < 220 && r.top > below;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)), width: w, maxHeight: Math.max(180, Math.min(380, (up ? r.top : below) - 4)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) }); }, []);
  useLayoutEffect(() => {
    if (!open) return undefined; place(); setKw('');
    const t = setTimeout(() => { if (window.innerWidth > 760) qin.current?.focus(); }, 0);
    const out = (e) => { if (!btn.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    const sc = (e) => { if (!pop.current?.contains(e.target)) place(); };
    document.addEventListener('pointerdown', out); window.addEventListener('resize', place); window.addEventListener('scroll', sc, true);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', out); window.removeEventListener('resize', place); window.removeEventListener('scroll', sc, true); };
  }, [open, place]);
  useLayoutEffect(() => { if (open) place(); }, [vals.length, open, place]);
  const toggle = (v) => { const on = vals.some((x) => sv(x) === sv(v)); if (!on && max && vals.length >= max) return; onChange(on ? vals.filter((x) => sv(x) !== sv(v)) : [...vals, v]); };
  let lastG = null;
  return (<>
    <div ref={btn} role="button" tabIndex={0} className={`in multi-btn ${err && !vals.length ? 'err-in' : ''}`} style={style} aria-haspopup="listbox" aria-expanded={open}
      onClick={(e) => { if (!e.target.closest('.multi-x')) setOpen((o) => !o); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      {vals.length ? vals.map((v) => { const o = opts.find((x) => sv(x.v) === sv(v)); return <span key={sv(v)} className="multi-tag">{o?.l || sv(v)}<button type="button" className="multi-x" aria-label="去掉" onClick={() => toggle(v)}>×</button></span>; }) : <span className="choice-v ph">{placeholder}</span>}
      <span className="choice-caret">▾</span>
    </div>
    {open && pos && createPortal(
      <div className="menu choice-pop" ref={pop} style={{ position: 'fixed', ...pos }} role="listbox" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
        <input ref={qin} className="in choice-q" placeholder="搜索名字 / 工号…" value={kw} onChange={(e) => setKw(e.target.value)} />
        <div className="choice-list">
          {list.map((o) => { const on = vals.some((x) => sv(x) === sv(o.v)); const head = o.group && o.group !== lastG ? o.group : null; lastG = o.group || lastG; return (
            <React.Fragment key={sv(o.v)}>
              {head && <div className="choice-group">{head}</div>}
              <button type="button" role="option" aria-selected={on} className={`opt ${on ? 'on picked' : ''}`} onClick={() => toggle(o.v)}>
                <span className={`multi-box ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span><span className="opt-l">{o.l}</span>{o.hint ? <span className="opt-h">{o.hint}</span> : null}
              </button>
            </React.Fragment>); })}
          {!list.length && <div className="small muted" style={{ padding: 10 }}>没有匹配的</div>}
        </div>
        <div className="row" style={{ justifyContent: 'space-between', padding: '6px 4px 0' }}><span className="small muted">已选 {vals.length}</span><button type="button" className="btn sm primary" onClick={() => setOpen(false)}>选好了</button></div>
      </div>, document.body)}
  </>);
}

// ── AcctImpact: 动账的地方统一两个独立小卡片 (Frank 11-19 417) ── ① 本单 改前 → 改后 + 一行说明; ② 客户总账 改前欠款 → 改后欠款.
// 退货 / 收货差异 / 价格调整 / 整单折扣 / 抹零 / 撤销 / 收款 / 退款 都用它. 负数欠款写成「预付」. fmt(n) = 带币种的金额.
const owe = (n, fmt) => (n < 0 ? `预付 ${fmt(-n)}` : fmt(n));
export function AcctImpact({ docLabel = '本单应收', doc, ledger, fmt, note, ledgerNote, style }) {
  const Card = ({ title, a, b, sub }) => { const diff = (b ?? 0) - (a ?? 0); return (
    <div className="impact-card">
      <div className="impact-t">{title}</div>
      <div className="impact-v"><span className="impact-a">{owe(a, fmt)}</span><span className="impact-arrow">→</span><b className={`impact-b ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`}>{owe(b, fmt)}</b></div>
      <div className="impact-s">{sub || (diff === 0 ? '没有变化' : `${diff > 0 ? '＋' : '−'}${fmt(Math.abs(diff))}`)}</div>
    </div>); };
  return (
    <div className="impact" style={style}>
      {doc && <Card title={docLabel} a={doc.before} b={doc.after} sub={note} />}
      {ledger && <Card title="客户总账（欠款）" a={ledger.before} b={ledger.after} sub={ledgerNote} />}
    </div>);
}

// MoneyIn: <input> 的直接替身 (412) —— 用法和原来的 input 一模一样 (value 是字符串或数字, onChange 收到的 e.target.value 是不带逗号的纯数字串),
// 只是显示时边输边加千分位 + 右对齐. inputMode="decimal" 允许小数, 否则只收整数. 全站金额 / 数量框统一用它.
export function MoneyIn({ value: valueProp, defaultValue, onChange: onChangeProp, onBlur, className = '', inputMode = 'numeric', ...rest }) {
  // 没传 value (只给 defaultValue) = 自己记着输入的数; onBlur 拿到的是去掉逗号的数
  const [own, setOwn] = useState(defaultValue ?? ''); const free = valueProp === undefined;
  const value = free ? own : valueProp; const onChange = (e) => { if (free) setOwn(e.target.value); onChangeProp?.(e); };
  const dec = inputMode === 'decimal';
  const clean = (raw) => { let t = String(raw ?? '').replace(/[^\d.]/g, ''); if (!dec) t = t.replace(/\./g, ''); else { const i = t.indexOf('.'); if (i >= 0) t = t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, ''); } return t; };
  const ref = useRef(null); const caret = useRef(null);
  useLayoutEffect(() => { if (caret.current == null || !ref.current) return; const shown = ref.current.value; let n = caret.current, i = 0; while (i < shown.length && n > 0) { if (shown[i] !== ',') n -= 1; i += 1; } try { ref.current.setSelectionRange(i, i); } catch { /* 有的手机键盘不让设光标 */ } caret.current = null; });
  const type = (e) => { const raw = e.target.value; const pos = e.target.selectionStart ?? raw.length; caret.current = raw.slice(0, pos).replace(/[^\d.]/g, '').length; onChange?.({ target: { value: clean(raw) }, currentTarget: e.currentTarget }); };
  return <input ref={ref} {...rest} className={`${className} num-in`} inputMode={inputMode} value={groupNum(clean(value))} onChange={type} onBlur={onBlur ? (e) => onBlur({ target: { value: clean(e.target.value) }, currentTarget: e.currentTarget }) : undefined} />;
}

// 361 (Frank 11-18, 全站): 同一时间只开一个弹层 —— 工具栏上的筛选 / 分组 / 筛选方案 / 下拉 / 更多菜单, 点开一个, 别的自动关.
// 弹层里面再弹的小框 (选值、日历) 不算, 不参加.
export function usePopBus(open, close) {
  const id = useRef(Math.random()); const fn = useRef(close); fn.current = close;
  useEffect(() => {
    if (!open) return undefined;
    window.dispatchEvent(new CustomEvent('la9s:pop', { detail: id.current }));
    const h = (e) => { if (e.detail !== id.current) fn.current?.(); };
    window.addEventListener('la9s:pop', h); return () => window.removeEventListener('la9s:pop', h);
  }, [open]);
}


// 426 / 427 (Frank 11-19, 全站): 页面的日期大筛选 —— 本日 / 本周 / 本月 / 本季度 / 本年度 / 自定义, 旁边永远写出真实的起止日期和天数.
// usePeriod(页面名): 选了什么记在本机 (每页各记各的); <PeriodBar p={…} /> 放进 .pagehead 右边, 表头冻结以后也一直看得到.
// 11-25 Frank：从侧栏 / 页签点进来一律是本月（不再长期记住上次选的）；同一次打开里，从详情返回清单保持刚才选的（存 sessionStorage）。
// 智能搜索跳过来：presetPeriod(页面名, 值, [from, to]) 先写好，再跳；页面已经开着就收 'la9s-period' 事件当场换。
const pstore = { get: (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
export function resetPeriods() { try { Object.keys(sessionStorage).filter((k) => k.startsWith('la9s.period.')).forEach((k) => sessionStorage.removeItem(k)); } catch { /* */ } }
export function presetPeriod(key, period, custom) {
  pstore.set(`la9s.period.${key}`, period); if (custom) pstore.set(`la9s.period.${key}.custom`, custom);
  setTimeout(() => window.dispatchEvent(new CustomEvent('la9s-period', { detail: { key, period, custom } })), 60);
}
export function usePeriod(key, def = 'month', init = null) {
  const [period, setP] = useState(() => init?.period || pstore.get(`la9s.period.${key}`, def));
  const [custom, setC] = useState(() => init?.custom || pstore.get(`la9s.period.${key}.custom`, [today(), today()]));
  const setPeriod = (v) => { setP(v); pstore.set(`la9s.period.${key}`, v); };
  const setCustom = (v) => { setC(v); pstore.set(`la9s.period.${key}.custom`, v); };
  useEffect(() => {
    const f = (e) => { if (e.detail?.key !== key) return; if (e.detail.custom) setC(e.detail.custom); setP(e.detail.period); };
    window.addEventListener('la9s-period', f); return () => window.removeEventListener('la9s-period', f);
  }, [key]);
  const [from, to] = period === 'custom' ? custom : periodRange(period);
  const label = periodLabel(period);
  return { period, setPeriod, custom, setCustom, from, to, label };
}
export const rangeText = (from, to) => {
  const n = Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
  const sameY = String(from).slice(0, 4) === String(to).slice(0, 4) && String(to).slice(0, 4) === String(new Date().getFullYear());
  const f = (d) => (sameY ? String(d).slice(5) : d);
  return from === to ? `${f(from)} · 1 天` : `${f(from)} → ${f(to)} · ${n} 天`;
};
export function PeriodBar({ p, children, all }) {
  // 477 (Frank 11-20): 五个按钮 —— 点一下 = 本期; 已经亮着的再点一下 (或点蓝色小 ▾) = 出这一组的选项; 日期框 = 自定义 (点两下选一段)
  // 11-25: 本日 → 日历选任意一天；本周 → 周历选任意一周（一个月里的周，月初月末零头并进第一 / 最后一周）。all = 前面多一个「全部」（客户流水用）
  const g = periodGroup(p.period);
  const [menu, setMenu] = useState(null);
  const btns = useRef({});
  const click = (k) => { if (g === k) setMenu(menu === k ? null : k); else { p.setPeriod(k); setMenu(null); } };
  return (
    <div className="row period-bar">
      {children}
      <div className="seg per-seg">{all && <button type="button" className={g === 'all' ? 'on' : ''} onClick={() => { p.setPeriod('all'); setMenu(null); }}>全部</button>}
        {[['day', '本日'], ['week', '本周'], ['month', '本月'], ['quarter', '本季度'], ['year', '本年度']].map(([k, l]) => (
        <button type="button" key={k} ref={(el) => { btns.current[k] = el; }} className={g === k ? 'on' : ''} onClick={() => click(k)} aria-haspopup="menu" aria-expanded={menu === k}>
          {g === k ? periodLabel(p.period) : l}<i className="per-caret" onClick={(e) => { e.stopPropagation(); if (g !== k) p.setPeriod(k); setMenu(menu === k ? null : k); }}>▾</i>
        </button>))}</div>
      {g !== 'all' && <RangePicker value={[p.from, p.to]} on={p.period === 'custom'} onChange={(v) => { p.setCustom(v); p.setPeriod('custom'); }} />}
      {menu && <PeriodMenu k={menu} anchor={btns.current[menu]} cur={p.period} from={p.from} onPick={(v) => { p.setPeriod(v); setMenu(null); }} onClose={() => setMenu(null)} />}
    </div>);
}
const WK = ['一', '二', '三', '四', '五', '六', '日'];
function PeriodMenu({ k, anchor, cur, from, onPick, onClose }) {
  const now = new Date(); const Y = now.getFullYear(); const M = now.getMonth() + 1; const Q = Math.floor(now.getMonth() / 3) + 1; const T = today();
  const curY = Number(String(cur).match(/^[mqy]:(\d{4})/)?.[1]) || Y;
  const [yy, setYy] = useState(curY);
  const [ym, setYm] = useState(() => { const d = new Date(from || T); return [d.getFullYear(), d.getMonth() + 1]; });   // 日历 / 周历看的是哪个月
  const pop = useRef(null); const [pos, setPos] = useState(null); const [hw, setHw] = useState(null);
  usePopBus(true, onClose);
  useLayoutEffect(() => {
    const place = () => { const r = anchor?.getBoundingClientRect(); if (!r) return; const w = Math.min(k === 'month' || k === 'day' || k === 'week' ? 270 : 200, window.innerWidth - 16); setPos({ width: w, top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) }); };
    place();
    const out = (e) => { if (!pop.current?.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', key); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', key); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, k, onClose]);
  const item = (v, l, dis) => <button type="button" key={v} disabled={dis} className={`per-it ${cur === v || (v === 'month' && cur === `m:${Y}-${M}`) ? 'on' : ''}`} onClick={() => onPick(v)}>{l}</button>;
  const yearNav = <div className="per-yr"><button type="button" onClick={() => setYy(yy - 1)} aria-label="上一年">‹</button><b>{yy}</b><button type="button" disabled={yy >= Y} onClick={() => setYy(yy + 1)} aria-label="下一年">›</button></div>;
  const [cy, cm] = ym;
  const step = (d) => { const nd = new Date(cy, cm - 1 + d, 1); setYm([nd.getFullYear(), nd.getMonth() + 1]); };
  const monthNav = <div className="per-yr"><button type="button" onClick={() => step(-1)} aria-label="上个月">‹</button><b>{cy} 年 {cm} 月</b><button type="button" disabled={cy > Y || (cy === Y && cm >= M)} onClick={() => step(1)} aria-label="下个月">›</button></div>;
  let body;
  if (k === 'day') {
    const sel = cur === 'day' ? T : cur === 'yesterday' ? from : String(cur).startsWith('d:') ? String(cur).slice(2) : null;
    const lead = (new Date(cy, cm - 1, 1).getDay() + 6) % 7; const days = new Date(cy, cm, 0).getDate();
    body = <>{monthNav}<div className="dp-grid per-cal">{WK.map((w) => <div key={w} className="w">{w}</div>)}{Array.from({ length: lead }, (_, i) => <span key={'b' + i} />)}
      {Array.from({ length: days }, (_, i) => { const s = ymd(new Date(cy, cm - 1, i + 1)); return <button type="button" key={s} disabled={s > T} className={`${s === T ? 'today' : ''} ${s === sel ? 'on' : ''}`} onClick={() => onPick(s === T ? 'day' : `d:${s}`)}>{i + 1}</button>; })}</div></>;
  } else if (k === 'week') {
    // 11-25 Frank：周历长得和日历一样，但一整周一整块地选——鼠标移到哪一天，它那一周整块亮起来；下面一行写「第几周 · 起 → 止 · 几天」
    const W = monthWeeks(cy, cm); const tw = weekOf(now);
    const selKey = cur === 'week' ? `w:${tw.y}-${tw.m}-${tw.n}` : cur === 'lastweek' ? (() => { const v = weekOf(new Date(tw.from.getFullYear(), tw.from.getMonth(), tw.from.getDate() - 1)); return `w:${v.y}-${v.m}-${v.n}`; })() : cur;
    const selI = W.findIndex((_, i) => selKey === `w:${cy}-${cm}-${i + 1}`);
    const lead = (new Date(cy, cm - 1, 1).getDay() + 6) % 7; const days = new Date(cy, cm, 0).getDate();
    const wi = (d) => W.findIndex(([a, b]) => d >= a.getDate() && d <= b.getDate());
    const f = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const show = hw != null ? hw : selI;
    const pick = (i) => { const isNow = cy === tw.y && cm === tw.m && i + 1 === tw.n; onPick(isNow ? 'week' : `w:${cy}-${cm}-${i + 1}`); };
    body = <>{monthNav}<div className="dp-grid per-cal per-wkcal" onMouseLeave={() => setHw(null)}>{WK.map((w) => <div key={w} className="w">{w}</div>)}{Array.from({ length: lead }, (_, i) => <span key={'b' + i} />)}
      {Array.from({ length: days }, (_, i) => { const d = i + 1; const s = ymd(new Date(cy, cm - 1, d)); const x = wi(d); const [a, b] = W[x]; const dis = ymd(a) > T;
        const cls = [s === T ? 'today' : '', x === selI ? 'sel' : '', x === hw && !dis ? 'hov' : '', d === a.getDate() ? 'rs' : '', d === b.getDate() ? 're' : ''].join(' ');
        return <button type="button" key={s} disabled={dis} className={cls} onMouseEnter={() => !dis && setHw(x)} onFocus={() => !dis && setHw(x)} onClick={() => pick(x)}>{d}</button>; })}</div>
      <div className="rp-foot per-wkfoot">{show >= 0 && show != null ? <b>第 {show + 1} 周 · {f(W[show][0])} → {f(W[show][1])} · {Math.round((W[show][1] - W[show][0]) / 864e5) + 1} 天{cy === tw.y && cm === tw.m && show + 1 === tw.n ? ' · 本周' : ''}</b> : <span className="muted">点哪一周选哪一周</span>}</div></>;
  } else if (k === 'month') body = <>{yearNav}<div className="per-grid m">{Array.from({ length: 12 }, (_, i) => { const mm = i + 1; const v = yy === Y && mm === M ? 'month' : `m:${yy}-${mm}`; return item(v, `${mm} 月`, yy > Y || (yy === Y && mm > M)); })}</div></>;
  else if (k === 'quarter') body = <>{yearNav}<div className="per-grid q">{[1, 2, 3, 4].map((qq) => item(yy === Y && qq === Q ? 'quarter' : `q:${yy}-${qq}`, `Q${qq}`, yy > Y || (yy === Y && qq > Q)))}</div></>;
  else body = <div className="per-list">{Array.from({ length: 5 }, (_, i) => Y - i).map((v) => item(v === Y ? 'year' : `y:${v}`, `${v} 年`))}</div>;
  return createPortal(<div className="menu per-menu" ref={pop} role="menu" style={{ position: 'fixed', ...(pos || { visibility: 'hidden' }) }}>{body}</div>, document.body);
}

// 426: 每一页的表头 (.pagehead) 往下滑时冻结在顶栏下面. 滑下去以后: 小字那行收起、标题小一号, 右边 (日期 / 按钮) 整块不动.
// 在 App 里挂一次 useStickyPagehead(), 所有页面自动有; 表头变矮的那一截用 margin 补回去, 页面内容不跳.
export function useStickyPagehead() {
  useEffect(() => {
    let stuck = false; let el = null; let pad0 = 0;
    const on = () => {
      const cur = document.querySelector('.content > .pagehead, .content .pagehead');
      if (cur !== el) { if (el) { el.classList.remove('stuck'); el.style.marginBottom = ''; } el = cur; stuck = false; }
      if (!el) return;
      const y = window.scrollY;
      if (!stuck && y > 36) {
        const h0 = el.offsetHeight; el.classList.add('stuck'); const h1 = el.offsetHeight;
        pad0 = Math.max(0, h0 - h1); el.style.marginBottom = `calc(var(--ph-mb, 12px) + ${pad0}px)`; stuck = true;
      } else if (stuck && y < 6) { el.classList.remove('stuck'); el.style.marginBottom = ''; stuck = false; }
    };
    window.addEventListener('scroll', on, { passive: true }); window.addEventListener('hashchange', on);
    const t = setInterval(on, 600);   // 换页 / 数据出来以后表头换了一个, 重新认一下
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('hashchange', on); clearInterval(t); };
  }, []);
}

// 442 (Frank 11-19): 鼠标放上去要马上出提示. 浏览器自带的 title 提示固定要等 1 秒多 → 全站接管:
// 鼠标移到任何带 title / data-tip 的东西上, 立刻出我们自己的小黑框 (挂一次, 所有页面自动有). 手机不启用 (没有悬停).
export function useInstantTips() {
  // 11-20: 全站 ⓘ / ! 小图标的说明框 —— 放到屏幕坐标上 (position: fixed), 靠右 / 靠下放不下就往回挪, 不会被卡片裁掉、不超出屏幕
  useEffect(() => {
    const place = (e) => {
      const ic = e.target instanceof Element ? e.target.closest('.info-i') : null; if (!ic) return;
      const tip = ic.querySelector(':scope > .info-tip'); if (!tip) return;
      tip.style.position = 'fixed'; tip.style.left = '0px'; tip.style.top = '0px'; tip.style.right = 'auto'; tip.style.bottom = 'auto';
      requestAnimationFrame(() => {
        const r = ic.getBoundingClientRect(); const w = tip.offsetWidth; const h = tip.offsetHeight;
        let left = r.left; if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
        let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        tip.style.left = `${left}px`; tip.style.top = `${top}px`;
      });
    };
    document.addEventListener('mouseover', place, true); document.addEventListener('focusin', place, true);
    return () => { document.removeEventListener('mouseover', place, true); document.removeEventListener('focusin', place, true); };
  }, []);
  useEffect(() => {
    if (window.matchMedia?.('(hover: none)').matches) return undefined;
    const tip = document.createElement('div'); tip.className = 'cell-tip itip'; tip.style.display = 'none'; document.body.appendChild(tip);
    let cur = null;
    const hide = () => { tip.style.display = 'none'; cur = null; };
    const over = (e) => {
      const el = e.target instanceof Element ? e.target.closest('[title], [data-tip]') : null;
      if (!el || el.tagName === 'IFRAME') { if (cur && !(e.target instanceof Element && cur.contains(e.target))) hide(); return; }
      const t = el.getAttribute('title');
      if (t) { el.setAttribute('data-tip', t); el.removeAttribute('title'); if (!el.getAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t); }
      const text = el.getAttribute('data-tip'); if (!text) { hide(); return; }
      if (cur === el && tip.style.display !== 'none') return;
      cur = el; tip.textContent = text; tip.style.display = 'block';
      const r = el.getBoundingClientRect(); const w = tip.offsetWidth; const h = tip.offsetHeight;
      let top = r.bottom + 6; if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 6);
      const left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2));
      tip.style.top = `${top}px`; tip.style.left = `${left}px`;
    };
    const out = (e) => { if (cur && !(e.relatedTarget instanceof Element && cur.contains(e.relatedTarget))) hide(); };
    document.addEventListener('mouseover', over, true); document.addEventListener('mouseout', out, true);
    document.addEventListener('mousedown', hide, true); window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('mouseover', over, true); document.removeEventListener('mouseout', out, true); document.removeEventListener('mousedown', hide, true); window.removeEventListener('scroll', hide, true); tip.remove(); };
  }, []);
}
