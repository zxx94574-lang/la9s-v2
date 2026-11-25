// 种类筛选 —— 全站同一个（Frank 11-25：订单、询单、盘点、选货…都一样，不要一处一个样）
// 常卖的几个（屏幕 / 电池盖 / 电池 / 小板…）放外面一排点；其余收进「更多 ▾」（带搜索）；不卖的种类「隐藏」——
// 只是选货 / 报价 / 询单里不出现，库存、盘点、物料里照样在（不是删除）。顺序、放外面、隐藏都在 ⚙ 里，中方定、所有人同款。
// 设置存 org_settings：cat_order（顺序，原来就有）/ cat_main（放外面的）/ cat_hidden（不卖的）。
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Modal, SortList, Choice } from './ui.jsx';
import { friendlyError } from '../lib/format.js';

const MAIN_DEFAULT = 4;
// 没设过「放外面」时：Frank 11-25 说的卖得多的四个；没有这几个名字就拿顺序前 4 个
const MAIN_NAMES = ['屏幕', '电池盖', '电池', '小板'];
const defaultMain = (list) => { const by = MAIN_NAMES.map((n) => list.find((c) => c.name === n)).filter(Boolean); return (by.length ? by : list.slice(0, MAIN_DEFAULT)).map((c) => c.id); };
export function useCatPrefs() {
  const { org, tick } = useApp();
  const { data } = useData(() => q(`select key, value from app.org_settings where org_id = $1 and key in ('cat_order','cat_main','cat_hidden')`, [org]), [org, tick]);
  return useMemo(() => {
    const v = (k) => (data || []).find((x) => x.key === k)?.value;
    return { order: Array.isArray(v('cat_order')) ? v('cat_order') : [], main: Array.isArray(v('cat_main')) ? v('cat_main') : null, hidden: Array.isArray(v('cat_hidden')) ? v('cat_hidden') : [], ready: !!data };
  }, [data]);
}
export function sortCats(categories, order) {
  return [...(categories || [])].sort((a, b) => { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
}
// 页面拿到的种类列表 → 排好序、（选货场景）去掉不卖的
export function useCats(categories, { forSale = true } = {}) {
  const p = useCatPrefs();
  return useMemo(() => {
    const all = sortCats(categories, p.order);
    const list = forSale ? all.filter((c) => !p.hidden.includes(c.id)) : all;
    const mainIds = p.main || defaultMain(list);
    return { all, list, main: list.filter((c) => mainIds.includes(c.id)), more: list.filter((c) => !mainIds.includes(c.id)), prefs: p };
  }, [categories, p, forSale]);
}

// value: '' = 全部；onChange(id)；only = 只列这些种类 id（比如这批货里有的）
export default function CatFilter({ categories, value, onChange, forSale = true, only, allLabel = '全部', compact }) {
  const { role } = useApp();
  const c = useCats(categories, { forSale });
  const [gear, setGear] = useState(false);
  const has = (x) => !only || only.has(x.id);
  const main = c.main.filter(has); const more = c.more.filter(has);
  const inMore = more.find((x) => x.id === value);
  return (
    <div className={`chips cats catf ${compact ? 'sm' : ''}`}>
      <button type="button" className={`chip ${!value ? 'on' : ''}`} onClick={() => onChange('')}>{allLabel}</button>
      {main.map((x) => <button type="button" key={x.id} className={`chip ${value === x.id ? 'on' : ''}`} onClick={() => onChange(value === x.id ? '' : x.id)}>{x.name}</button>)}
      {more.length > 0 && <span className={`catf-more ${inMore ? 'on' : ''}`}>
        <Choice value={inMore ? inMore.id : '*'} onChange={(v) => onChange(v === '*' ? '' : v)} flat={false}
          options={[['*', `更多 ${more.length} 种`], ...more.map((x) => [x.id, x.name])]} /></span>}
      {role === 'admin' && <button type="button" className="gear-btn" title="种类：顺序、哪些放外面、哪些不卖（隐藏）——所有人同款" onClick={() => setGear(true)}>⚙</button>}
      {gear && <CatPrefsModal categories={c.all} prefs={c.prefs} onClose={() => setGear(false)} />}
    </div>
  );
}

function CatPrefsModal({ categories, prefs, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [list, setList] = useState(categories);
  const [main, setMain] = useState(() => new Set(prefs.main || defaultMain(categories.filter((x) => !prefs.hidden.includes(x.id)))));
  const [hidden, setHidden] = useState(() => new Set(prefs.hidden));
  const tog = (set, setS, id) => { const s = new Set(set); s.has(id) ? s.delete(id) : s.add(id); setS(s); };
  const save = async () => {
    try {
      for (const [k, v] of [['cat_order', list.map((x) => x.id)], ['cat_main', list.filter((x) => main.has(x.id) && !hidden.has(x.id)).map((x) => x.id)], ['cat_hidden', [...hidden]]])
        await call(role, `select app.set_org_setting($1,$2,$3)`, [org, k, JSON.stringify(v)]);
      toast('种类设置已保存，所有人同款'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="种类：顺序 / 放外面 / 不卖" onClose={onClose} footer={<><span className="small muted">放外面 {[...main].filter((id) => !hidden.has(id)).length} 个 · 不卖 {hidden.size} 个</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={save}>保存</button></>}>
      <div className="hint" style={{ marginBottom: 8 }}>按住一行上下拖调顺序。<b>放外面</b> = 常卖的，一排直接点；其余收进「更多」。<b>不卖</b> = 选货、报价、询单里不出现（库存、盘点、物料里照样有，随时可以改回来）。</div>
      <SortList items={list} keyOf={(x) => x.id} onChange={setList} render={(x, i) => (
        <><span className="mono muted small" style={{ width: 24 }}>{i + 1}</span><span className="grow" style={{ opacity: hidden.has(x.id) ? 0.45 : 1 }}>{x.name}</span>
          <label className="row small" style={{ gap: 4 }}><input type="checkbox" disabled={hidden.has(x.id)} checked={main.has(x.id) && !hidden.has(x.id)} onChange={() => tog(main, setMain, x.id)} />放外面</label>
          <label className="row small" style={{ gap: 4, marginLeft: 10 }}><input type="checkbox" checked={hidden.has(x.id)} onChange={() => tog(hidden, setHidden, x.id)} />不卖</label></>)} />
    </Modal>
  );
}

// 页面里只有种类名字（物料与定价、备货建议…）：按名字筛，样式 / 顺序 / 放外面跟全站同一套
export function CatFilterByName({ names, value, onChange, allLabel }) {
  const { org } = useApp();
  const { data } = useData(() => q(Q.categories, [org]), [org]);
  const cats = useMemo(() => { const set = new Set(names); const base = (data || []).filter((c) => set.has(c.name)); for (const n of set) if (!base.some((c) => c.name === n)) base.push({ id: `name:${n}`, name: n }); return base; }, [data, names]);
  const idOf = (n) => cats.find((c) => c.name === n)?.id || '';
  return <CatFilter categories={cats} forSale={false} allLabel={allLabel} value={idOf(value)} onChange={(id) => onChange(id ? cats.find((c) => c.id === id)?.name || '' : '')} />;
}
