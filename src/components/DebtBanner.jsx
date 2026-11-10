// 欠款提醒 (Frank 11-09 15:08 / 15:42): 报价时就亮出客户欠多少, 当场决定做不做; 出库前再硬拦 (有欠款不出货的客户)
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal } from './ui.jsx';
import { money, dt, friendlyError } from '../lib/format.js';

export default function DebtBanner({ customerId, deal, compact }) {
  const { org, role, toast, refresh } = useApp();
  const [rel, setRel] = useState(false);
  const { data } = useData(async () => {
    if (!customerId) return null;
    const [[c]] = await Promise.all([q(`select cr.balance, cr.oldest_days, cr.over_limit, cr.over_days, cr.credit_limit, cr.credit_days, cr.has_agreement, cu.block_on_debt, cu.name
      from app.customers cu left join app.v_customer_credit cr on cr.customer_id = cu.id where cu.id = $1`, [customerId])]);
    const own = deal ? (await q(`select coalesce(sum(due),0) as due from app.v_deal_due where deal_id = $1 and currency = 'XOF'`, [deal.id]))[0]?.due : 0;
    return { ...c, other: Number(c?.balance || 0) - Number(own || 0) };
  }, [customerId, deal?.id, deal?.status, org]);
  if (!data) return null;
  const debt = data.other;
  if (!(debt > 0) && !data.block_on_debt) return null;
  const blocked = data.block_on_debt && debt > 0;
  const released = deal?.debt_released_at;
  const parts = [debt > 0 ? `${deal ? '除这张单外' : '现在'}还欠 ${money(debt)} XOF` : '目前没有欠款',
    data.oldest_days > 0 && debt > 0 ? `最老一笔 ${data.oldest_days} 天没付` : null,
    data.over_limit ? `超上限（${money(data.credit_limit)}）` : null, data.over_days ? `超账期（${data.credit_days} 天）` : null].filter(Boolean);
  return (
    <div className={`banner ${blocked && !released ? 'warn' : 'info'} row`} style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
      <span>💰 <b>{data.name}</b>：{parts.join('，')}。
        {blocked ? (released ? ` 中方已放行（${dt(released)}：${deal.debt_release_note}）。` : deal ? ' 「有欠款不出货」客户：先收款，或中方放行，才能出库。' : ' 「有欠款不出货」客户：这张报价会进中方审批；出库前还要先收款或中方放行。先跟客户谈好欠款再报价。')
          : data.block_on_debt ? ' （有欠款不出货客户，目前没欠款）' : data.has_agreement ? ' 有协议客户，只提醒。' : ' 只提醒，要不要做由你定。'}</span>
      <span className="grow" />
      {blocked && !released && deal && role === 'admin' && <button type="button" className="btn sm primary" onClick={() => setRel(true)}>放行这张单</button>}
      {rel && <ReleaseModal deal={deal} debt={debt} onClose={() => setRel(false)} onDone={() => { setRel(false); refresh(); }} role={role} toast={toast} />}
    </div>
  );
}

function ReleaseModal({ deal, debt, onClose, onDone, role, toast }) {
  const [note, setNote] = useState('答应这次付清');
  const go = async () => { try { await call(role, `select app.release_debt_block($1,$2)`, [deal.id, note.trim()]); toast('已放行，这张单可以出库'); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`放行 ${deal.biz_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>不放行</button><span className="grow" /><button type="button" className="btn primary" disabled={!note.trim()} onClick={go}>确认放行</button></>}>
      <div className="stack">
        <div className="hint">客户还欠 {money(debt)} XOF。放行后这张单可以出库，原因记进操作记录。</div>
        <div className="chips">{['答应这次付清', '已付款待到账', '老客户信得过', '先发一部分'].map((x) => <button type="button" key={x} className={`chip ${note === x ? 'on' : ''}`} onClick={() => setNote(x)}>{x}</button>)}</div>
        <input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="放行原因（必填）" />
      </div>
    </Modal>
  );
}
