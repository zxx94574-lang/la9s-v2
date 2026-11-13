// 培训与 SOP: 每个岗位的操作规程, 每一步可以点进系统对应页面 (流程联动).
// 员工看完点「我已读懂」; 中方改了 SOP 自动升版本, 大家要重新确认. 中法双语.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal } from '../components/ui.jsx';
import { ITEMS } from '../components/Nav.jsx';
import { dt, friendlyError } from '../lib/format.js';

const DEPTS = ['全员', '热线', '仓库', '主管', '财务', '销售', '国内采购', '中方'];
const MINE = { hotline: ['热线'], picker: ['仓库'], manager: ['仓库', '主管'], finance: ['财务'], sales: ['销售'], cn_support: ['国内采购'], admin: [] };

export default function Sop() {
  const { org, role, toast, refresh, go } = useApp();
  const [dept, setDept] = useState(() => (MINE[role] ? MINE[role][0] : ''));
  const [edit, setEdit] = useState(null);
  const { data } = useData(() => q(Q.sopList, [org, USERS[role]]), [org, role]);
  if (!data) return <div className="empty">加载中…</div>;
  const rows = data.filter((d) => !dept || d.dept === dept || d.dept === '全员');
  const todo = data.filter((d) => !d.acked && (role === 'admin' || (MINE[role] || []).includes(d.dept) || d.dept === '全员')).length;
  const ack = async (d) => { try { await call(role, `select app.ack_sop($1)`, [d.id]); toast('已确认'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Formation & procédures</div><h1>培训与 SOP</h1>
        <div className="sub">每个岗位怎么做，一步一步写清楚；点步骤后面的「去操作」直接到系统对应页面。看完点「我已读懂」。中方改了内容会升版本，大家要重新确认。</div></div>
        {role === 'admin' && <button type="button" className="btn primary" onClick={() => setEdit({ dept: dept || '全员', title: '', steps: [] })}>＋ 新 SOP</button>}
      </div>
      <div className="card card-b row" style={{ gap: 10, marginBottom: 12 }}>
        <div className="chips"><button type="button" className={`chip ${!dept ? 'on' : ''}`} onClick={() => setDept('')}>全部</button>
          {DEPTS.map((d) => <button type="button" key={d} className={`chip ${dept === d ? 'on' : ''}`} onClick={() => setDept(d)}>{d}</button>)}</div>
        <span className="grow" />{todo > 0 && <Pill tone="amber">{todo} 份还没确认</Pill>}
      </div>
      <div className="stack">
        {rows.map((d) => (
          <div key={d.id} className="card card-b">
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <Pill tone="blue">{d.dept}</Pill><h3 style={{ margin: 0 }}>{d.title}</h3><span className="muted small">第 {d.version} 版 · {dt(d.updated_at)} · {d.ack_n} 人已确认</span>
              <span className="grow" />
              {role === 'admin' && <button type="button" className="btn sm" onClick={() => setEdit(d)}>编辑</button>}
              {d.acked ? <Pill tone="green">✓ 已读懂</Pill> : <button type="button" className="btn sm primary" onClick={() => ack(d)}>我已读懂 · J’ai compris</button>}
            </div>
            <ol className="sop-steps">{d.steps.map((s, i) => (
              <li key={i}><span>{s.text}</span>{s.route && ITEMS[s.route] && <button type="button" className="linkbtn" onClick={() => go(s.route)}>去操作：{ITEMS[s.route][1]} →</button>}</li>))}</ol>
            {d.body && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>}
          </div>))}
        {rows.length === 0 && <div className="empty">这个岗位还没有 SOP</div>}
      </div>
      {edit && <SopEdit d={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function SopEdit({ d, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ dept: d.dept, title: d.title, body: d.body || '', steps: d.steps.length ? d.steps : [{ text: '', route: '' }] });
  const setStep = (i, k, v) => setF((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const go = async () => {
    try { await call(role, `select app.upsert_sop($1,$2,$3,$4,$5,$6)`, [org, d.id || null, f.dept, f.title, JSON.stringify(f.steps.filter((s) => s.text.trim()).map((s) => ({ text: s.text.trim(), route: s.route || undefined }))), f.body || null]);
      toast(d.id ? '已保存，升了一个版本，大家要重新确认' : '已新建'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={d.id ? `编辑 SOP · ${d.title}` : '新 SOP'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!f.title.trim()} onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="chips">{DEPTS.map((x) => <button type="button" key={x} className={`chip ${f.dept === x ? 'on' : ''}`} onClick={() => setF({ ...f, dept: x })}>{x}</button>)}</div>
        <input className="in" placeholder="标题（中文 · Français）" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        {f.steps.map((s, i) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <b style={{ width: 22, paddingTop: 8 }}>{i + 1}.</b>
            <textarea className="in" rows={2} value={s.text} onChange={(e) => setStep(i, 'text', e.target.value)} />
            <select className="in" value={s.route || ''} style={{ maxWidth: 170 }} onChange={(e) => setStep(i, 'route', e.target.value)}>
              <option value="">不挂页面</option>{Object.entries(ITEMS).filter(([k]) => !k.startsWith('p/')).map(([k, v]) => <option key={k} value={k}>→ {v[1]}</option>)}</select>
            <button type="button" className="close-x" onClick={() => setF((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))}>×</button>
          </div>))}
        <div><button type="button" className="btn sm" onClick={() => setF((x) => ({ ...x, steps: [...x.steps, { text: '', route: '' }] }))}>＋ 加一步</button></div>
        <textarea className="in" rows={3} placeholder="补充说明（可选）" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      </div>
    </Modal>
  );
}
