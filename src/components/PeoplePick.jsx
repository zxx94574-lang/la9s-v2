// 找货人 / 复核人 候选 (Frank 11-09 第 12 / 15 条): 不自动匹配, 中方点 ⚙ 勾谁能选, 实时生效. 存 org_settings 'step_people' = {pick:[员工id], review:[...]}
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal } from './ui.jsx';
import { can } from '../lib/domain.js';
import { friendlyError } from '../lib/format.js';

export function useStepPeople(step) {
  const { org } = useApp();
  const { data } = useData(async () => { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = 'step_people'`, [org]); return r?.value || {}; }, [org]);
  return { ids: Array.isArray(data?.[step]) ? data[step] : null, all: data };
}

export default function PeoplePick({ step, label, employees, value, onChange, errs }) {
  const { org, role, toast, refresh } = useApp();
  const { ids, all } = useStepPeople(step);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(null);
  const active = employees.filter((e) => e.status !== 'left' && e.status !== 'inactive');
  const list = ids ? active.filter((e) => ids.includes(e.id)) : [];
  const canSet = can(role, 'step_people');
  const save = async () => {
    try { await call(role, `select app.set_org_setting($1,'step_people',$2)`, [org, JSON.stringify({ ...(all || {}), [step]: sel })]); toast('已保存，大家马上能选'); setOpen(false); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="field req"><label>{label} {canSet && <button type="button" className="btn sm" style={{ marginLeft: 6 }} title={`设置哪些人可以当${label}`} onClick={() => { setSel(ids || []); setOpen(true); }}>⚙</button>}</label>
      {list.length ? <div className="chips">{list.map((x) => <button type="button" key={x.id} className={`chip ${value === x.id ? 'on' : ''} ${errs && !value ? 'err' : ''}`} onClick={() => onChange(x.id)}>{x.short_name}</button>)}</div>
        : <div className="hint" style={{ color: errs ? 'var(--red)' : undefined }}>{ids ? `还没有勾选可以当${label}的人` : `${label}候选还没设置`}{canSet ? '：点上面 ⚙ 勾选' : '：请中方在 ⚙ 里设置'}</div>}
      {open && <Modal title={`谁可以当${label}`} onClose={() => setOpen(false)} footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>取消</button><button type="button" className="btn primary" onClick={save}>保存</button></>}>
        <div className="hint" style={{ marginBottom: 8 }}>从员工档案里勾。勾选顺序 = 显示顺序；离职的自动不显示。</div>
        <div className="stack" style={{ gap: 4 }}>{active.map((e) => <label key={e.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={sel?.includes(e.id)} onChange={(ev) => setSel((s) => (ev.target.checked ? [...s, e.id] : s.filter((x) => x !== e.id)))} />
          <b>{e.short_name}</b><span className="muted small">{e.full_name} · {e.position || ''}{e.emp_no ? ` · ${e.emp_no}` : ''}</span></label>)}</div>
      </Modal>}
    </div>
  );
}
