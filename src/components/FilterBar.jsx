// 229 (Frank 11-11): 像飞书多维表格一样的筛选条 —— 常用筛选项直接摆出来, 可以叠加; 选中的亮蓝色并写出内容; 可存成「筛选方案」
// 全站通用: 订单总览先用, 以后收款 / 客户 / 出库这些表都用同一套
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, useOutside, Modal } from './ui.jsx';
import { friendlyError } from '../lib/format.js';

// 多选下拉 (带搜索). options: [[value, label]]; value: 数组
export function MultiPick({ label, options, value = [], onChange, single = false }) {
  const [open, setOpen] = useState(false); const [t, setT] = useState('');
  const ref = useOutside(open, () => setOpen(false));
  const on = value.length > 0;
  const text = on ? options.filter(([v]) => value.includes(v)).map(([, l]) => l).slice(0, 2).join('、') + (value.length > 2 ? ` 等 ${value.length} 个` : '') : '';
  const list = options.filter(([, l]) => !t || String(l).toUpperCase().includes(t.toUpperCase())).slice(0, 80);
  const tog = (v) => { if (single) { onChange(value.includes(v) ? [] : [v]); setOpen(false); } else onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]); };
  return (
    <span className="fpick" ref={ref}>
      <button type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => setOpen(!open)}>{label}{on ? `：${text}` : ''} ▾</button>
      {open && (
        <div className="menu fpick-menu">
          {options.length > 8 && <input className="in sm" autoFocus placeholder="查找…" value={t} onChange={(e) => setT(e.target.value)} />}
          <div className="fpick-list">
            {list.map(([v, l]) => <button type="button" key={v} className={`mi ${value.includes(v) ? 'focus' : ''}`} onClick={() => tog(v)}><span>{value.includes(v) ? '✓ ' : ''}{l}</span></button>)}
            {!list.length && <div className="hint" style={{ padding: 8 }}>没有匹配的</div>}
          </div>
          {on && <button type="button" className="btn sm" onClick={() => { onChange([]); setOpen(false); }}>清掉这一项</button>}
        </div>)}
    </span>
  );
}

// 筛选方案: 全公司共用一套 (org_settings filter_schemes:<表>); 谁都能用, 只有中方能存 / 改名 / 删
export function Schemes({ table, current, onApply }) {
  const { org, role, toast, refresh } = useApp();
  const admin = role === 'admin';
  const [open, setOpen] = useState(false); const [edit, setEdit] = useState(null);
  const ref = useOutside(open, () => setOpen(false));
  const { data } = useData(async () => { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = $2`, [org, 'filter_schemes:' + table]); return Array.isArray(r?.value) ? r.value : []; }, [org, table]);
  const list = data || [];
  const save = async (next, msg) => { try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, 'filter_schemes:' + table, JSON.stringify(next)]); toast(msg); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <span className="fpick" ref={ref}>
      <button type="button" className="chip" onClick={() => setOpen(!open)}>☆ 筛选方案{list.length ? `（${list.length}）` : ''} ▾</button>
      {open && (
        <div className="menu fpick-menu" style={{ width: 300 }}>
          {!list.length && <div className="hint" style={{ padding: 8 }}>还没有方案。先把上面的筛选条件选好，再点下面「把现在的筛选存成方案」。</div>}
          <div className="fpick-list">{list.map((s, i) => (
            <div key={i} className="row" style={{ gap: 4 }}>
              <button type="button" className="mi grow" onClick={() => { onApply(s.f); setOpen(false); toast(`已套用「${s.name}」`); }}><span>{s.name}</span></button>
              {admin && <button type="button" className="btn sm ghost" title="改名" onClick={() => setEdit({ i, name: s.name })}>✎</button>}
              {admin && <button type="button" className="btn sm ghost" title="删除" onClick={() => save(list.filter((_, j) => j !== i), `已删除「${s.name}」`)}>🗑</button>}
            </div>))}</div>
          {admin ? <button type="button" className="btn sm primary" onClick={() => setEdit({ i: -1, name: '' })}>＋ 把现在的筛选存成方案</button> : <div className="hint" style={{ padding: 6 }}>新建 / 改名 / 删除方案由中方操作</div>}
        </div>)}
      {edit && (
        <Modal title={edit.i < 0 ? '存成筛选方案' : '方案改名'} onClose={() => setEdit(null)}
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>取消</button><button type="button" className="btn primary" disabled={!edit.name.trim()}
            onClick={() => { const next = edit.i < 0 ? [...list, { name: edit.name.trim(), f: current }] : list.map((s, j) => (j === edit.i ? { ...s, name: edit.name.trim() } : s)); save(next, edit.i < 0 ? `已存成方案「${edit.name.trim()}」` : '已改名'); setEdit(null); setOpen(false); }}>保存</button></>}>
          <div className="stack">
            <div className="field req"><label>方案名字</label><input className="in" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="例如 查看单机型销量以及销售额" /></div>
            {edit.i < 0 && <div className="hint">存的是现在选好的筛选条件；没选的项保持空白，套用后可以自己再填。时间段存的是「本月」这种说法，下个月点它自动就是下个月。</div>}
          </div>
        </Modal>)}
    </span>
  );
}
