// Fast line entry: category chips switch instantly (屏幕 ↔ 电池盖 ↔ 屏幕…), then type model / code / 通用型号.
// Arrow keys + Enter or mouse. Frank 11-01: 点一个不关, 可以接着点 (点过的打 ✓); 「完成」/ Esc / 点外面才关.
import CatFilter, { useCatPrefs } from './CatFilter.jsx';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { money, qty } from '../lib/format.js';
import { useOutside } from './ui.jsx';
import { AvailPill } from './DocPeek.jsx';

export const avail = (p) => p.stock.reduce((a, s) => a + s.on_hand - s.reserved, 0);
// 内部看库存 (230): 直接给数量 + 颜色 —— 充足绿 / 快没了黄 (< 20) / 0 红; 全站同一个
// 464: 改成全站统一的 可售 (绿, 带片数) / 可预订 (黄)
export const StockPill = ({ n, pid }) => <AvailPill n={n} pid={pid} />;

export default function ModelPicker({ catalog: catalogAll, categories, tier, onPick, onUnpick, showPrice = true, extra, picked, forSale = true, placeholder }) {
  // 种类筛选全站同一个 CatFilter；选货场景（forSale）里「不卖」的种类连型号一起不出现
  const cp = useCatPrefs();
  const catalog = useMemo(() => (forSale && cp.hidden.length ? catalogAll.filter((p) => !cp.hidden.includes(p.category_id)) : catalogAll), [catalogAll, cp.hidden, forSale]);
  const present = useMemo(() => new Set(catalog.map((x) => x.category_id)), [catalog]);
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const input = useRef();
  const box = useOutside(open, () => setOpen(false));

  const list = useMemo(() => {
    const t = text.trim().toUpperCase();
    return catalog.filter((p) => (!cat || p.category_id === cat) && (!t || p.model.includes(t) || p.code.includes(t) || (p.variant || '').toUpperCase().includes(t) || p.shared_models.some((s) => s.includes(t))))
      // Frank 11-11 (230): 库存多的排前面 (搜索时: 型号开头匹配的优先, 再按库存), 不要一打开全是没货的
      .sort((a, b) => (t ? (b.model.startsWith(t) - a.model.startsWith(t)) : 0) || (avail(b) - avail(a)) || a.model.localeCompare(b.model)).slice(0, 60);
  }, [catalog, cat, text]);

  const pick = (p) => {
    // Frank 11-09: 已选的再点一下 = 取消 (从明细里拿掉), 不是提示"已选中"
    if (picked?.has(p.id) && onUnpick) onUnpick(p); else onPick(p);
    input.current?.focus();   // 不关、不清空搜索词, 接着点下一个
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setFocus((f) => Math.min(f + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => Math.max(f - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[focus]) pick(list[focus]); }
    else if (e.key === 'Escape') setOpen(false);
  };
  // 337 (Frank 11-17): 下拉宽度不跟输入框走 —— 自己有最小宽度 (CSS), 右边放不下就往左挪
  const sugg = useRef(null); const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setShift(0); return undefined; }
    const fit = () => { const b = box.current?.getBoundingClientRect(); const w = sugg.current?.offsetWidth || 0; if (!b || !w) return; setShift(Math.max(0, Math.min(b.left - 8, Math.ceil(b.left + w - (window.innerWidth - 8))))); };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, [open, box]);
  // 336: 完整信息 —— 电脑悬停 0.45 秒 / 手机长按 0.5 秒
  const [tip, setTip] = useState(null); const timer = useRef(null); const pressed = useRef(false);
  const show = (p, el) => { const r = el.getBoundingClientRect(); setTip({ p, top: r.bottom + 190 > window.innerHeight ? Math.max(8, r.top - 150) : r.bottom + 2, left: Math.max(8, Math.min(r.left + 160, window.innerWidth - 288)) }); };
  const hover = (p, el) => { clearTimeout(timer.current); timer.current = setTimeout(() => show(p, el), 450); };
  const unhover = () => { clearTimeout(timer.current); setTip(null); };
  const press = (p, el) => { clearTimeout(timer.current); pressed.current = false; timer.current = setTimeout(() => { pressed.current = true; show(p, el); }, 500); };
  const unpress = () => { clearTimeout(timer.current); if (pressed.current) setTimeout(() => setTip(null), 2500); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!open) setTip(null); }, [open]);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <CatFilter categories={categories} value={cat} forSale={forSale} only={present} onChange={(v) => { setCat(v); if (v) setOpen(true); input.current?.focus(); }} />
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className={`picker grow ${open ? 'open' : ''}`} ref={box}>
          <input ref={input} className="in" value={text} placeholder={placeholder || "⌕ 加一行：输入型号 / 编码 / 通用型号，↑↓ 选择，Enter 添加"}
            onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); setFocus(0); }} onKeyDown={key} />
          {open && (
            <div className="sugg" ref={sugg} style={shift ? { left: -shift, right: 'auto' } : null}>
              <div className="sugg-h"><span className="small muted sugg-h-t">点一个加一行，可以接着点</span>
                <button type="button" className="btn sm primary" onClick={() => setOpen(false)}>完成</button></div>
              {list.length === 0 && <div className="empty">没有匹配的物料。客户要的型号我们没有？点右边「＋ 没建档的型号」记下来。</div>}
              {/* 336 (Frank 11-17): 每行只显示 种类 · 机型（下面小字编码）· 库存 · 价格; 放不下一律省略, 不许串行; 完整信息电脑悬停 / 手机长按 */}
              {list.map((p, i) => (
                <button type="button" key={p.id} className={`pk-row ${i === focus ? 'focus' : ''} ${picked?.has(p.id) ? 'picked' : ''}`}
                  onMouseEnter={(e) => { setFocus(i); hover(p, e.currentTarget); }} onMouseLeave={unhover}
                  onTouchStart={(e) => press(p, e.currentTarget)} onTouchEnd={unpress} onTouchMove={unpress} onContextMenu={(e) => e.preventDefault()}
                  onClick={() => { if (pressed.current) { pressed.current = false; return; } pick(p); }}>
                  <span className="pk-main">
                    <span className="pk-l1"><span className="m">{picked?.has(p.id) ? '✓ ' : ''}{p.model}</span><span className="muted small">{p.category}</span></span>
                    <span className="pk-l2 muted small"><span className="mono">{p.code}</span>{p.variant ? ` · ${p.variant}` : ''}{p.shared_models.length ? ` · 通用 ${p.shared_models.length}` : ''}</span>
                  </span>
                  <span className="pk-c"><StockPill n={avail(p)} pid={p.id} />{showPrice && (tier ? <span className="small muted">{money(p.prices[tier])} XOF</span> : <span className="small muted">先选客户</span>)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {extra}
      </div>
      {tip && createPortal(
        <div className="pk-tip" style={{ top: tip.top, left: tip.left }}>
          <div><b>{tip.p.model}</b> <span className="muted">{tip.p.category}</span></div>
          <div className="small"><span className="muted">编码</span> <span className="mono">{tip.p.code}</span></div>
          {tip.p.variant && <div className="small"><span className="muted">区分</span> {tip.p.variant}</div>}
          {tip.p.shared_models.length > 0 && <div className="small"><span className="muted">通用机型</span> {tip.p.shared_models.join(' / ')}</div>}
          <div className="small"><span className="muted">可售</span> {avail(tip.p)} 片{showPrice && tier ? <> · <span className="muted">单价</span> {money(tip.p.prices[tier])} XOF</> : null}</div>
        </div>, document.body)}
    </div>
  );
}
