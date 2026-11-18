// 先出库、价格以后再定 (Q8③, Frank 11-16 / 11-17): 很少用、必须是急单、只中方批. 没定价不能对账; 从出库起挂在中方待办最顶上.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, PhotoInput, Pill, Assumed } from './ui.jsx';
import { DealLink } from './Archives.jsx';
import { money, friendlyError, dDate } from '../lib/format.js';

const N = (v) => Number(v || 0);
export const canAllowUnpriced = (deal, role) => role === 'admin' && deal.kind === 'normal' && !deal.price_pending && !['shipped', 'cancelled'].includes(deal.status);

export function AllowUnpricedModal({ deal, onClose }) {
  const { role, toast, refresh } = useApp();
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => { if (!note.trim()) return toast('写为什么急着先发', 'err'); setBusy(true); try { await call(role, `select app.allow_ship_unpriced($1,$2)`, [deal.id, note.trim()]); toast('已批准：这张单可以先出库，价格以后定'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); } };
  return (
    <Modal title="先出库、价格以后再定" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn danger" disabled={busy} onClick={go}>批准先出库</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <div>这是特例，只给急单用。批准以后：</div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>价格没谈定也能出库，出库时先按单上现在的价记账（没价就是 0）。</li>
          <li>出库那一刻起，这张单挂在中方待办最顶上，直到定价。</li>
          <li>签收照常跟客户确认数量；<b>价格没定之前不能确认对账</b>。</li>
          <li>定价时填最终单价 + 客户同意的截图，差额自动进客户的账。<Assumed>「先按单上现在的价记账、定价时补差额」是我定的做法：这样客户总账从出库起就有数，不会漏；定下来的价如果低于成本，定价那一刻照样要先有亏本批准。</Assumed></li>
        </ul>
        <FRow label="为什么急" req><input className="in" style={{ flex: '1 1 260px', minWidth: 0 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：客户今天开业急要，价格明天谈" autoFocus /></FRow>
      </div>
    </Modal>);
}

export function PricePendingBar({ deal, lines }) {
  const { role, toast, refresh } = useApp();
  const [open, setOpen] = useState(false);
  if (!deal.price_pending) return null;
  const shipped = ['partial', 'shipped'].includes(deal.status);
  const cancel = async () => { try { await call(role, `select app.cancel_price_pending($1)`, [deal.id]); toast('已取消「价格待定」'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="banner warn loss-bar" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span><b>⚠ 价格待定：</b>中方批准这张单先出库、价格以后再定（{deal.price_pending_note}）。{shipped ? <b>货已经发了，价格没定之前不能确认对账。</b> : '还没出库。'}</span>
        <span className="grow" />
        {role === 'admin' && shipped && <button type="button" className="btn sm primary" onClick={() => setOpen(true)}>定价</button>}
        {role === 'admin' && !shipped && <><button type="button" className="btn sm" onClick={() => setOpen(true)}>现在就定价</button><button type="button" className="btn sm" onClick={cancel}>取消「价格待定」</button></>}
      </div>
      {open && <SettleModal deal={deal} lines={lines} onClose={() => setOpen(false)} />}
    </div>);
}

function SettleModal({ deal, lines, onClose }) {
  const { role, toast, refresh } = useApp();
  const real = lines.filter((l) => N(l.qty_supply) > 0 || N(l.qty_req) > 0);
  const [p, setP] = useState(() => Object.fromEntries(real.map((l) => [l.id, N(l.unit_price) > 0 ? String(N(l.unit_price)) : ''])));
  const [note, setNote] = useState(''); const [proof, setProof] = useState(''); const [busy, setBusy] = useState(false); const [errs, setErrs] = useState(false);
  const qtyOf = (l) => (N(l.qty_supply) > 0 ? N(l.qty_supply) : N(l.qty_req));
  const total = real.reduce((a, l) => a + qtyOf(l) * N(p[l.id]), 0);
  const old = real.reduce((a, l) => a + qtyOf(l) * N(l.unit_price), 0);
  const go = async () => {
    setErrs(true);
    if (real.some((l) => p[l.id] === '' || !(N(p[l.id]) >= 0))) return toast('每一行都要填最终单价', 'err');
    if (!note.trim()) return toast('写一句怎么谈定的', 'err'); if (!proof) return toast('传客户同意价格的截图', 'err');
    setBusy(true);
    try { await call(role, `select app.settle_pending_price($1,$2,$3,$4)`, [deal.id, JSON.stringify(real.map((l) => ({ line_id: l.id, price: N(p[l.id]) }))), note.trim(), proof]); toast('价格已定，差额已进客户的账'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`定价 · ${deal.biz_no}`} wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy} onClick={go}>确认定价</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="disc-prev">
          {real.map((l) => <div key={l.id} className="disc-row" style={{ alignItems: 'center' }}><span>{l.model || l.req_model} <span className="muted small">{l.category || ''}</span></span><span className="muted">{qtyOf(l)} 片 · 原 {money(l.unit_price, deal.currency)}</span>
            <input className={`in ${errs && p[l.id] === '' ? 'err-in' : ''}`} inputMode="decimal" style={{ width: 110 }} value={p[l.id]} onChange={(e) => setP({ ...p, [l.id]: e.target.value.replace(/[^\d.]/g, '') })} placeholder="最终单价" /></div>)}
          <div className="disc-row"><b>定价后总额</b><span className="muted">原 {money(old, deal.currency)}</span><b>{money(total, deal.currency)} {deal.currency}</b></div>
        </div>
        <FRow label="怎么谈定的" req><input className="in" style={{ flex: '1 1 260px', minWidth: 0 }} value={note} onChange={(e) => setNote(e.target.value)} /></FRow>
        <FRow label="客户同意的截图" req><PhotoInput value={proof} onChange={setProof} label="聊天截图" invalid={errs && !proof} /></FRow>
      </div>
    </Modal>);
}

// 待办最顶: 货发了、价还没定的单
export function PricePendingTodo() {
  const { org, role, tick } = useApp();
  const { data } = useData(() => (role === 'admin' ? q(`select d.id, d.biz_no, d.price_pending_note, d.price_pending_at, c.name as customer, (select min(s.shipped_at) from app.shipments s where s.deal_id = d.id and s.voided_at is null) as shipped_at
    from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.price_pending and d.status in ('partial','shipped') order by d.price_pending_at`, [org]) : Promise.resolve(null)), [org, role, tick]);
  if (!data?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
      <div className="card-h"><h2>货发了、价格还没定</h2><Pill tone="red">{data.length} 张</Pill><span className="muted small">定价之前不能对账</span></div>
      {data.map((r) => (
        <div key={r.id} className="orow" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <span className="age red">紧急</span>
          <span className="small"><DealLink id={r.id} no={r.biz_no} /> · {r.customer} · {r.shipped_at ? `${dDate(r.shipped_at)} 出库` : ''} · {r.price_pending_note}</span>
        </div>))}
    </div>);
}
