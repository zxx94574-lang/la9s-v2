// 389 (Frank 11-18): 「没编码的新货」补全 —— 先种类 → 型号 (可选可输、自动大写、有相似的提示) → 区分 / 级别 (HD / QHD / OLED / 原装…) → 数量 → 备注.
// 同一个机型不同质量是两种货, 所以区分 / 级别单独一格. FOB / 采购 / 询单共用. onAdd({ category_id, category, model, grade, qty, note })
import React, { useMemo, useState } from 'react';
import { Choice, MoneyIn, useApp } from './ui.jsx';
import { OptChoice } from './Opts.jsx';

const GRADES = ['HD', 'QHD', 'OLED', 'INCELL', '原装', '高仿', '带框', '不带框'];
export default function FreeItem({ categories, catalog, onAdd, label = '没编码的新货' }) {
  const { toast } = useApp();
  const [f, setF] = useState({ cat: '', model: '', grade: '', qty: '', note: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const like = useMemo(() => { const m = f.model.trim(); if (m.length < 2) return []; return [...new Set((catalog || []).filter((p) => (!f.cat || p.category_id === f.cat) && (p.model.includes(m) || m.includes(p.model))).map((p) => `${p.model}${p.variant ? ` ${p.variant}` : ''}（${p.code}）`))].slice(0, 4); }, [f.model, f.cat, catalog]);
  const add = () => {
    if (!f.cat) return toast('先选种类', 'err');
    if (!f.model.trim()) return toast('写型号', 'err');
    if (!(Number(f.qty) > 0)) return toast('填数量', 'err');
    const c = (categories || []).find((x) => x.id === f.cat);
    onAdd({ category_id: f.cat, category: c?.name || '', model: f.model.trim().toUpperCase(), grade: f.grade, qty: f.qty, note: f.note.trim() });
    setF({ cat: f.cat, model: '', grade: '', qty: '', note: '' });
  };
  return (
    <div className="free-item">
      <div className="small muted free-t">{label}</div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Choice value={f.cat} onChange={(v) => set('cat', v)} options={(categories || []).map((c) => [c.id, c.name])} flat={false} placeholder="① 种类…" />
        <input className="in" style={{ width: 150 }} placeholder="② 型号" value={f.model} onChange={(e) => set('model', e.target.value.toUpperCase())} />
        <OptChoice optKey="item_grades" title="区分 / 级别" value={f.grade} onChange={(v) => set('grade', v)} options={GRADES} empty="③ 区分 / 级别（可不选）" flat={false} />
        <MoneyIn className="in" inputMode="numeric" style={{ width: 90 }} placeholder="④ 数量" value={f.qty} onChange={(e) => set('qty', e.target.value.replace(/\D/g, ''))} />
        <input className="in" style={{ flex: '1 1 140px', minWidth: 0 }} placeholder="备注（可不填）" value={f.note} onChange={(e) => set('note', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button type="button" className="btn sm" onClick={add}>＋ 加这一行</button>
      </div>
      {like.length > 0 && <div className="small amber-t" style={{ marginTop: 4 }}>已经有相似的编码：{like.join('、')} —— 是同一种货就直接在上面选，不要当新货。</div>}
    </div>);
}
