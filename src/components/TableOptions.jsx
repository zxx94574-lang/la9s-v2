// 每张表右上角「⚙ 选项设置」(Frank 11-08): 自己加列 (单选 / 文本 / 数字 / 日期), 单选列把选项填上, 保存后表里立刻多一列, 表头漏斗能筛.
import React, { useState } from 'react';
import { useApp, Modal } from './ui.jsx';
import { saveTableOptions, CUSTOM_TYPES, OPT_TONES, newKey } from '../lib/tableOptions.js';
import { friendlyError } from '../lib/format.js';

export default function TableOptionsModal({ table, opts, builtin = [], onClose, onSaved }) {
  const { org, role, toast } = useApp();
  const [custom, setCustom] = useState(() => structuredClone(opts?.custom || []));
  const [busy, setBusy] = useState(false);
  const upd = (i, patch) => setCustom((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const updItem = (i, k, patch) => upd(i, { items: custom[i].items.map((it, m) => (m === k ? { ...it, ...patch } : it)) });
  const save = async () => {
    setBusy(true);
    try { await saveTableOptions(role, org, table, { custom }); toast('已保存，表里已经多出这些列'); onSaved?.(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="这张表的选项设置" onClose={onClose} wide
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy} onClick={save}>保存</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="hint">这里加的列是你自己的资料列，所有人在表里能看、能在格子里选 / 填，表头漏斗能按它筛。系统自带的列（{builtin.slice(0, 8).join('、')}{builtin.length > 8 ? '…' : ''}）不在这里改：它们的选项在各自页面的「选项设置」页签（员工 / 客户），金额和数量列进金蝶对账，不能改成自定义。</div>
        {custom.map((c, i) => (
          <div key={c.key || i} className="card" style={{ padding: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <span className="small">列名</span><input className="in" style={{ maxWidth: 180 }} value={c.label} placeholder="例：种类" onChange={(e) => upd(i, { label: e.target.value })} autoFocus={!c.label} />
              <span className="small">类型</span>
              <div className="row" style={{ gap: 4 }}>{CUSTOM_TYPES.map(([v, l]) => <button type="button" key={v} className={`chip ${(c.type || 'select') === v ? 'on' : ''}`} onClick={() => upd(i, { type: v })}>{l}</button>)}</div>
              <span className="grow" /><button type="button" className="btn sm ghost" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>× 删这列</button>
            </div>
            {(c.type || 'select') === 'select' && (
              <div className="stack" style={{ gap: 6 }}>
                {(c.items || []).map((it, k) => (
                  <div key={k} className="row" style={{ gap: 6 }}>
                    <input className="in mono" style={{ maxWidth: 160 }} value={it.v} placeholder="代码" onChange={(e) => updItem(i, k, { v: e.target.value.toUpperCase() })} title="代码（存进数据库 / 导出用）" />
                    <input className="in" style={{ maxWidth: 200 }} value={it.l} placeholder="显示名" onChange={(e) => updItem(i, k, { l: e.target.value })} />
                    {/* 选项颜色 (Frank 11-09: 手加的单选也要红黄绿灯) */}
                    <span className="row" style={{ gap: 3 }} title="颜色">{OPT_TONES.map(([tn, nm]) => <button type="button" key={tn || 'none'} className={`tone-dot ${tn || 'none'} ${(it.c || '') === tn ? 'on' : ''}`} title={nm} onClick={() => updItem(i, k, { c: tn })} />)}</span>
                    {it.l || it.v ? <span className={`pill ${it.c || 'gray'}`}>{it.l || it.v}</span> : null}
                    <button type="button" className="btn sm ghost" onClick={() => upd(i, { items: c.items.filter((_, m) => m !== k) })}>×</button>
                  </div>))}
                <div><button type="button" className="btn sm" onClick={() => upd(i, { items: [...(c.items || []), { v: '', l: '' }] })}>＋ 加一个选项</button></div>
              </div>)}
          </div>))}
        <div><button type="button" className="btn sm primary" onClick={() => setCustom([...custom, { key: newKey(), label: '', type: 'select', items: [{ v: '', l: '' }] }])}>＋ 加一列</button></div>
        {custom.length === 0 && <div className="small muted">还没有自己加的列。点「＋ 加一列」，起个名、选类型，单选就把选项填上。</div>}
      </div>
    </Modal>
  );
}
