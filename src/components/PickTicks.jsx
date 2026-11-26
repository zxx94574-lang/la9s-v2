// 398 / 399 (Frank 11-18): 主管派人找货 + 手机打勾找货 (无纸化). 电脑上也是同一个页面.
// 设计按「一只手、防误触」: 整行就是按钮 (≥ 56px 高, 全宽), 点一下打勾变绿、再点取消; 改数量用大号 − / ＋, 不用找格子打字;
// 少于要的数自动出原因; 找完的沉到下面; 顶上固定进度; 最后「提交」才是不能撤的那一步, 放在底部、和别的按钮隔开.
import React, { useMemo, useState } from 'react';
import { call } from '../db/client.js';
import { useApp, Modal, PhotoInput, Assumed, Info } from './ui.jsx';
import { OptChoice, OptGear, useOptList } from './Opts.jsx';
import { EmpLink } from './Archives.jsx';
import { NOTE_OPTIONS, can, hasAny } from '../lib/domain.js';
import { qty, dt, friendlyError } from '../lib/format.js';
import { flagAnomaly } from './IssueReport.jsx';

const N = (v) => Number(v || 0);

export function AssignBar({ deal, employees, role }) {
  const { toast, refresh } = useApp();
  const [open, setOpen] = useState(false); const [emp, setEmp] = useState(deal.pick_assignee_employee_id || ''); const [note, setNote] = useState('');
  const canAssign = hasAny(role, ['admin', 'manager', 'sales_manager']);
  const who = (employees || []).find((e) => e.id === deal.pick_assignee_employee_id);
  const go = async () => {
    if (!emp) return toast('选一个人去找货', 'err');
    try { await call(role, `select app.assign_picker($1,$2,$3)`, [deal.id, emp, note || null]); toast(who ? '已改派' : '已派人，他的待办里会出现这张找货单'); setOpen(false); setNote(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className={`assign-bar ${who ? '' : 'todo'}`}>
      {who ? <span>找货派给了 <b><EmpLink id={who.id} name={who.short_name} /></b>{deal.pick_assigned_at ? <span className="small muted"> · {dt(deal.pick_assigned_at)} 派的</span> : null}</span>
        : <span><b>等安排找货</b><span className="small muted"> · 主管选一个人去找（仓管员、销售都可以）</span></span>}
      <span className="grow" />
      {canAssign && <button type="button" className={`btn ${who ? 'sm' : 'primary'}`} onClick={() => { setEmp(deal.pick_assignee_employee_id || ''); setOpen(true); }}>{who ? '改派' : '派人去找'}</button>}
      {open && <Modal title={who ? `改派 · ${deal.pick_no || deal.biz_no}` : `派人去找货 · ${deal.pick_no || deal.biz_no}`} onClose={() => setOpen(false)} footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>取消</button><button type="button" className="btn primary" onClick={go}>{who ? '确认改派' : '派给他'}</button></>}>
        <div className="stack">
          <div className="field req"><label>谁去找</label><OptChoice optKey="emp_list" title="员工名单" data value={emp} onChange={setEmp} flat={false} placeholder="选员工…" err={!emp}
            options={(employees || []).filter((e) => e.active !== false).map((e) => [e.id, e.short_name, [e.emp_no, e.department].filter(Boolean).join(' · ')])} /></div>
          {who && <div className="field"><label>为什么改派（选填）</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 上午的人下午放假" /></div>}
          <div className="hint">{who ? '已经打过勾的行会保留，新的人接着找没找的。改派留记录。' : '派了以后，他的待办里会出现这张找货单；随时可以改派。'}</div>
        </div>
      </Modal>}
    </div>);
}

export default function PickTicks({ deal, lines, employees, role, act }) {
  const { toast, refresh, org } = useApp();
  const real = lines.filter((l) => l.product_id && N(l.qty_supply) > 0);
  const none = lines.filter((l) => l.product_id && N(l.qty_supply) === 0);
  const [local, setLocal] = useState({});    // line → { qty, reason } 没打勾时暂存的数
  const [busy, setBusy] = useState(null);
  const [byBin, setByBin] = useState(true);
  const [photo, setPhoto] = useState(''); const [dup, setDup] = useState([]); const [errs, setErrs] = useState(false);
  const [numFor, setNumFor] = useState(null);
  const { list: reasons } = useOptList('note_diff', NOTE_OPTIONS.diff);
  const ticked = (l) => l.pick_tick_qty != null;
  const cur = (l) => (ticked(l) ? { qty: N(l.pick_tick_qty), reason: l.pick_tick_reason || '' } : { qty: N(l.qty_supply), reason: '', ...(local[l.id] || {}) });
  const sorted = useMemo(() => { const k = (l) => (byBin ? String(l.bin || '~') : String(l.seq).padStart(4, '0')); return [...real].sort((a, b) => (ticked(a) - ticked(b)) || k(a).localeCompare(k(b), 'zh-CN', { numeric: true })); }, [real, byBin]);   // eslint-disable-line react-hooks/exhaustive-deps
  const done = real.filter(ticked).length;
  const mine = can(role, 'submit_pick') || ['sales', 'sales_manager', 'hotline'].includes(role);
  const save = async (l, q, reason) => {
    setBusy(l.id);
    try { await call(role, `select app.pick_tick($1,$2,$3)`, [l.id, q, reason || null]); if (navigator.vibrate) navigator.vibrate(15); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(null); }
  };
  const tap = (l) => {
    if (!mine || busy) return;
    if (ticked(l)) return save(l, null, null);            // 再点一下 = 取消
    const c = cur(l);
    if (c.qty < N(l.qty_supply) && !c.reason) { setLocal((x) => ({ ...x, [l.id]: { ...c, ask: true } })); return toast(`${l.model} 找到的比要的少，先点一个原因`, 'err'); }
    save(l, c.qty, c.reason);
  };
  const step = (l, d) => { const c = cur(l); const q = Math.max(0, Math.min(N(l.qty_supply), c.qty + d)); if (ticked(l)) { if (q < N(l.qty_supply) && !c.reason) { save(l, null, null); setLocal((x) => ({ ...x, [l.id]: { qty: q, reason: '', ask: true } })); } else save(l, q, q < N(l.qty_supply) ? c.reason : null); } else setLocal((x) => ({ ...x, [l.id]: { ...c, qty: q, ask: q < N(l.qty_supply) } })); };
  const setQty = (l, q) => { const c = cur(l); const v = Math.max(0, Math.min(N(l.qty_supply), q)); if (ticked(l)) save(l, null, null); setLocal((x) => ({ ...x, [l.id]: { ...c, qty: v, ask: v < N(l.qty_supply) } })); };
  const pickReason = (l, r) => { const c = cur(l); setLocal((x) => ({ ...x, [l.id]: { ...c, reason: r } })); save(l, c.qty, r); };
  const submit = async () => {
    setErrs(true);
    const left = real.filter((l) => !ticked(l));
    if (left.length) { document.querySelector(`[data-tick="${left[0].id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return toast(`还有 ${left.length} 行没打勾：${left.slice(0, 4).map((l) => l.model).join('、')}${left.length > 4 ? '…' : ''}`, 'err'); }
    if (!photo) return toast('请拍一张找货现场照片', 'err');
    await act('找货完成，销售订单已自动生成', `select app.submit_pick_ticks($1,$2)`, [deal.id, photo]).then(() => dup.length && flagAnomaly(role, org, deal.id, 'pick', `找货照片和 ${dup.join('、')} 是同一张图，请核实是不是拍了旧图`), () => {});
  };
  return (
    <div className="ticks">
      <div className="ticks-top">
        <div className="ticks-prog"><i style={{ width: `${real.length ? (done / real.length) * 100 : 0}%` }} /></div>
        <b>已找 {done} / {real.length} 行</b>
        <span className="grow" />
        <span className="al-seg"><button type="button" className={byBin ? 'on' : ''} onClick={() => setByBin(true)}>按库位排</button><button type="button" className={!byBin ? 'on' : ''} onClick={() => setByBin(false)}>按单子顺序</button></span>
        <Info>同一个架子的排在一起，少走路。点整行 = 找到了（变绿），再点一下 = 取消。少了就按 − 改数量，再点原因。找完的自动排到下面。</Info>
      </div>
      {sorted.map((l) => { const c = cur(l); const t = ticked(l); const short = c.qty < N(l.qty_supply); return (
        <div key={l.id} data-tick={l.id} className={`tick-row ${t ? 'done' : ''} ${short ? 'short' : ''} ${busy === l.id ? 'busy' : ''}`}>
          <button type="button" className="tick-main" onClick={() => tap(l)} disabled={!mine} aria-pressed={t}>
            <span className="tick-box">{t ? '✓' : ''}</span>
            <span className="tick-info"><b className="tick-model">{l.model}</b><span className="tick-sub"><span className="tick-binl">{l.bin || '—'}<small>{l.warehouse}</small></span>{l.category} · {l.code}{l.variant ? ` · ${l.variant}` : ''}</span></span>
            <span className="tick-bin">{l.warehouse}<b>{l.bin || '—'}</b></span>
          </button>
          <span className="tick-side">
          <span className="tick-qty">
            <button type="button" className="step" disabled={!mine || c.qty <= 0} onClick={() => step(l, -1)} aria-label="少一片">−</button>
            <button type="button" className="num" disabled={!mine} onClick={() => setNumFor(l)} title="点这里直接输入数量">{qty(c.qty)}<small>/ {qty(l.qty_supply)}</small></button>
            <button type="button" className="step" disabled={!mine || c.qty >= N(l.qty_supply)} onClick={() => step(l, 1)} aria-label="多一片">＋</button>
          </span></span>
          {short && <div className="tick-why">{t ? <span className="pill amber">少 {qty(N(l.qty_supply) - c.qty)} 片 · {c.reason}</span> : <>
            <span className="small">少 {qty(N(l.qty_supply) - c.qty)} 片，原因：</span>
            {reasons.map(([v, n]) => <button type="button" key={v} className={`chip ${c.reason === v ? 'on' : ''} ${c.ask && !c.reason ? 'err' : ''}`} onClick={() => pickReason(l, v)}>{n}</button>)}<OptGear optKey="note_diff" title="找少了的原因" options={NOTE_OPTIONS.diff} /></>}</div>}
        </div>); })}
      {none.length > 0 && <div className="hint" style={{ margin: '6px 0' }}>没货、不用找的 {none.length} 行：{none.map((l) => l.model).join('、')}（缺口已记进「未满足需求」）</div>}
      {mine && <div className="ticks-foot">
        <div className="field req" style={{ flex: '1 1 260px', minWidth: 0 }}><label>找货照片（货摆在地上拍）</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs && !photo} label="拍找货照片" onDup={setDup} /></div>
        <button type="button" className="btn primary lg ticks-submit" onClick={submit}>提交（已找 {done} / 共 {real.length} 行）→</button>
      </div>}
      <div className="hint" style={{ marginTop: 8 }}>库存已预占。按库位拿货，<b>只集中放一堆、不打包</b>（打包在复检那步）。提交以后销售订单自动生成，发给客户确认。<Assumed>没货的行（预占 0）不用打勾；找到 0 片也要点原因再打勾，这样每一行都有交代才能提交。</Assumed></div>
      {numFor && <NumModal l={numFor} init={cur(numFor).qty} onClose={() => setNumFor(null)} onOk={(q) => { setQty(numFor, q); setNumFor(null); }} />}
    </div>);
}

function NumModal({ l, init, onClose, onOk }) {
  const [v, setV] = useState(String(init));
  return (
    <Modal title={`${l.model} 找到几片`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={() => onOk(Number(v || 0))}>好</button></>}>
      <div className="stack"><input className="in" inputMode="numeric" autoFocus style={{ fontSize: 28, fontWeight: 700, textAlign: 'center', height: 64 }} value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') onOk(Number(v || 0)); }} />
        <div className="small muted" style={{ textAlign: 'center' }}>要 {qty(l.qty_supply)} 片；找到的不能比它多（加货走「出库前追加」）</div></div>
    </Modal>);
}
