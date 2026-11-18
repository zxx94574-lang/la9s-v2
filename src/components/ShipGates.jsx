// 11-18 (Frank 第 6 点): 出库前新增的两道拦截, 都要中方放行 + 写原因 (规则在 0059)
//  · 欠款: 出了这张单就超欠款上限 / 最老欠款超账期
//  · 数量: 要发的数量超过客户确认过的数量
// 员工看到「被什么拦着、找谁」; 中方看到同一句 + 放行.
import React, { useState } from 'react';
import { call } from '../db/client.js';
import { useApp, useData } from './ui.jsx';
import { money, qty, friendlyError } from '../lib/format.js';

export function ShipGates({ deal }) {
  const { role, toast, refresh, tick } = useApp();
  const [note, setNote] = useState({ credit: '', qty: '' }); const [busy, setBusy] = useState(false);
  const { data } = useData(async () => {
    if (!deal || deal.kind !== 'normal' || ['shipped', 'cancelled', 'quoted'].includes(deal.status)) return null;
    const [r] = await call(role, `select app.ship_gate_state($1) as s`, [deal.id]);
    return r?.s || null;
  }, [deal?.id, deal?.status, deal?.version, tick]);
  if (!data) return null;
  const c = data.credit; const qs = data.qty || [];
  if (!c && !qs.length) return null;
  const admin = role === 'admin';
  const release = async (kind) => {
    if (!note[kind].trim()) { toast('放行要写原因', 'err'); return; }
    setBusy(true);
    try { await call(role, `select app.release_ship_gate($1,$2,$3)`, [deal.id, kind, note[kind].trim()]); toast('已放行，这张单可以出库了'); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const box = (kind, label) => admin && (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      <input className="in" style={{ flex: '1 1 240px', minWidth: 0 }} placeholder="放行原因（必填，比如：答应今天付清 / 客户电话里加的货）" value={note[kind]} onChange={(e) => setNote({ ...note, [kind]: e.target.value })} />
      <button type="button" className="btn danger" disabled={busy} onClick={() => release(kind)}>{label}</button>
    </div>);
  return (<>
    {c && <div className="banner warn loss-bar" style={{ marginBottom: 12 }}>
      <div><b>⛔ 欠款拦截：这张单现在不能出库。</b>{' '}
        {c.over_limit && <span>出了这张单就超欠款上限：现在欠 <b>{money(c.balance)}</b> + 这张单 <b>{money(c.this)}</b> ＞ 上限 <b>{money(c.limit)}</b>。</span>}{' '}
        {c.over_days && <span>最老的欠款已经 <b>{c.oldest}</b> 天，超过账期 <b>{c.days}</b> 天。</span>}{' '}
        {admin ? '先收款，或写原因放行。' : '先收款，或请中方放行。'}</div>
      {box('credit', '放行出库')}
    </div>}
    {qs.length > 0 && <div className="banner warn loss-bar" style={{ marginBottom: 12 }}>
      <div><b>⛔ 数量拦截：{qs.length} 行要发的数量超过客户确认的数量。</b>{' '}
        {qs.map((x) => `${x.model} 客户确认 ${qty(x.confirmed)}、现在 ${qty(x.now)}`).join('；')}。
        {admin ? ' 让客户重新确认，或写原因认下现在的数量。' : ' 让客户重新确认，或请中方放行。'}</div>
      {box('qty', '认下现在的数量')}
    </div>}
  </>);
}
