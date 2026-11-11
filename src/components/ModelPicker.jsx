// Fast line entry: category chips switch instantly (屏幕 ↔ 电池盖 ↔ 屏幕…), then type model / code / 通用型号.
// Arrow keys + Enter or mouse. Frank 11-01: 点一个不关, 可以接着点 (点过的打 ✓); 「完成」/ Esc / 点外面才关.
import React, { useMemo, useRef, useState } from 'react';
import { money, qty } from '../lib/format.js';
import { useOutside } from './ui.jsx';

export const avail = (p) => p.stock.reduce((a, s) => a + s.on_hand - s.reserved, 0);
// 内部看库存 (230): 直接给数量 + 颜色 —— 充足绿 / 快没了黄 (< 20) / 0 红; 全站同一个
export const StockPill = ({ n }) => <span className={`pill ${n >= 20 ? 'green' : n > 0 ? 'amber' : 'red'}`}>{qty(n)} 片</span>;

export default function ModelPicker({ catalog, categories, tier, onPick, onUnpick, showPrice = true, extra, picked }) {
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
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="chips cats">
        <button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => { setCat(''); input.current?.focus(); }}>全部</button>
        {categories.filter((c) => !catalog || catalog.some((x) => x.category_id === c.id)).map((c) => <button type="button" key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => { setCat(c.id); setOpen(true); input.current?.focus(); }}>{c.name}</button>)}
      </div>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className="picker grow" ref={box}>
          <input ref={input} className="in" value={text} placeholder="⌕ 加一行：输入型号 / 编码 / 通用型号，↑↓ 选择，Enter 添加"
            onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); setFocus(0); }} onKeyDown={key} />
          {open && (
            <div className="sugg">
              <div className="sugg-h"><span className="small muted">点一个加一行，可以接着点；数量在下面明细里填</span>
                <button type="button" className="btn sm primary" onClick={() => setOpen(false)}>完成</button></div>
              {list.length === 0 && <div className="empty">没有匹配的物料。客户要的型号我们没建档？用右边「＋ 补录需求」记下来。</div>}
              {list.map((p, i) => (
                <button type="button" key={p.id} className={`${i === focus ? 'focus' : ''} ${picked?.has(p.id) ? 'picked' : ''}`} onMouseEnter={() => setFocus(i)} onClick={() => pick(p)}>
                  <span className="muted mono">{picked?.has(p.id) ? '✓ ' : ''}{p.code}</span>
                  <span>{p.category}</span>
                  <span><span className="m">{p.model}</span>{p.variant && <span className="pill blue" style={{ marginLeft: 4 }}>{p.variant}</span>} <span className="muted small">{p.shared_models.slice(0, 3).join(' / ')}{p.shared_models.length > 3 ? ' …' : ''}</span></span>
                  <span className="small mono"><StockPill n={avail(p)} />{showPrice && tier ? <span className="muted"> · {money(p.prices[tier])} XOF</span> : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {extra}
      </div>
    </div>
  );
}
