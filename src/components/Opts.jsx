// 360 (Frank 11-17, 底层): 凡是选项组都能在旁边小 ⚙ 里调 —— 改名 / 隐藏 / 排序; 自由选项还能新增. 只隐藏不删除. 只中方.
// 存 org_settings `opts:<key>` = { rename: {值: 显示名}, hidden: [值], order: [值], extra: [新增的选项] }
// coded = 这组选项的「值」后台认 (出库方式 / 退货类型…): 只能改名、隐藏、排序, 不能凭空新增 (新增会影响账和流程, 要我先定它按哪种处理)
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Choice, Modal, SortList, Assumed } from './ui.jsx';
import { friendlyError } from '../lib/format.js';

const norm = (o) => (Array.isArray(o) ? [o[0], String(o[1] ?? o[0])] : [o, String(o)]);
export function applyOpts(base, cfg, current) {
  const b = (base || []).map(norm); const c = cfg || {};
  const extra = (c.extra || []).filter((x) => !b.some(([v]) => v === x)).map((x) => [x, x]);
  let all = [...b, ...extra].map(([v, l]) => [v, c.rename?.[v] || l]);
  if (c.order?.length) all = [...c.order.map((v) => all.find((o) => o[0] === v)).filter(Boolean), ...all.filter((o) => !c.order.includes(o[0]))];
  const hidden = new Set(c.hidden || []);
  return { all, shown: all.filter(([v]) => !hidden.has(v) || v === current), hidden };
}
export function useOpts(optKey, base, current) {
  const { org } = useApp();
  const { data } = useData(async () => { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = $2`, [org, `opts:${optKey}`]); return r?.value || {}; }, [org, optKey]);
  return { cfg: data || {}, ...applyOpts(base, data, current) };
}

export function OptChoice({ optKey, options, coded = true, title, value, ...rest }) {
  const { role } = useApp();
  const { cfg, all, shown, hidden } = useOpts(optKey, options, value);
  const [edit, setEdit] = useState(false);
  return (<>
    <Choice value={value} options={shown} {...rest} />
    {role === 'admin' && <button type="button" className="opt-gear" title={`调整「${title || '这组选项'}」：${coded ? '隐藏、排序' : '新增、改名、隐藏、排序'}`} onClick={() => setEdit(true)}>⚙</button>}
    {edit && <OptEditor optKey={optKey} title={title} coded={coded} cfg={cfg} all={all} hidden={hidden} base={(options || []).map(norm)} onClose={() => setEdit(false)} />}
  </>);
}

function OptEditor({ optKey, title, coded, cfg, all, hidden, base, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [rows, setRows] = useState(() => all.map(([v, l]) => ({ v, l, hide: hidden.has(v), sys: base.some(([bv]) => bv === v) })));
  const [nw, setNw] = useState('');
  const upd = (v, patch) => setRows((rs) => rs.map((r) => (r.v === v ? { ...r, ...patch } : r)));
  const add = () => { const x = nw.trim(); if (!x) return; if (rows.some((r) => r.v === x || r.l === x)) return toast('已经有这个选项了', 'err'); setRows([...rows, { v: x, l: x, hide: false, sys: false }]); setNw(''); };
  const save = async () => {
    if (rows.filter((r) => !r.hide).length === 0) return toast('至少留一个没隐藏的选项', 'err');
    if (rows.some((r) => !r.l.trim())) return toast('选项名不能空', 'err');
    const val = { rename: Object.fromEntries(rows.filter((r) => r.sys && r.l.trim() !== (base.find(([v]) => v === r.v)?.[1])).map((r) => [r.v, r.l.trim()])),
      hidden: rows.filter((r) => r.hide).map((r) => r.v), order: rows.map((r) => r.v), extra: rows.filter((r) => !r.sys).map((r) => r.v) };
    try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `opts:${optKey}`, JSON.stringify(val)]); toast('选项已更新，全站立即生效'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`调整选项 · ${title || optKey}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={save}>保存</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="small muted">拖动排序；隐藏的选项以后不能再选，但已经用它的老记录照样显示。只隐藏、不删除。
          {coded && <Assumed>这组选项后台按固定的类别处理（会影响账或流程），名字在单据和别的页面上也在用，所以这里只能隐藏和排序，不能新增、不能改名；要加新的类别或改名告诉我，我要先定它按哪一类处理。</Assumed>}</div>
        <SortList items={rows} keyOf={(r) => r.v} onChange={setRows} render={(r) => (
          <div className="opt-row">
            <span className="grip">⋮⋮</span>
            <input className="in" value={r.l} onChange={(e) => upd(r.v, { l: e.target.value })} disabled={coded} title={coded ? '这组选项的名字在别的页面和单据上也用，暂时不能在这里改' : ''} />
            <button type="button" className={`chip ${r.hide ? 'on' : ''}`} onClick={() => upd(r.v, { hide: !r.hide })}>{r.hide ? '已隐藏' : '隐藏'}</button>
          </div>)} />
        {!coded && <div className="row" style={{ gap: 8 }}><input className="in" style={{ flex: 1, minWidth: 0 }} placeholder="新增一个选项…" value={nw} onChange={(e) => setNw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} /><button type="button" className="btn" onClick={add}>＋ 加</button></div>}
        {cfg && Object.keys(cfg).length > 0 && <div><button type="button" className="btn sm ghost" onClick={() => setRows(base.map(([v, l]) => ({ v, l, hide: false, sys: true })))}>恢复成系统默认</button></div>}
      </div>
    </Modal>);
}
