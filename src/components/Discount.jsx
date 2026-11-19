// 整单折扣 (待改 357): 中方和客户谈好一个总价 → 折扣摊进每个型号单价 (向上取整), 零头出库时自动抹掉, 应收正好 = 谈好的数.
import React, { useState } from 'react';
import { call } from '../db/client.js';
import { useApp, Modal, FRow, Assumed, Choice, MoneyIn } from './ui.jsx';
import { money, friendlyError } from '../lib/format.js';

const N = (v) => Number(v || 0);
export const canDiscount = (deal, role) => role === 'admin' && deal.kind === 'normal' && ['quoted', 'hotline_ok', 'picking', 'picked', 'ordered', 'confirmed', 'reviewed'].includes(deal.status);

export function DiscountModal({ deal, lines, onClose }) {
  const { role, toast, refresh } = useApp();
  const priced = lines.filter((l) => N(l.unit_price) > 0);
  const qtyOf = (l) => (N(l.qty_supply) > 0 ? N(l.qty_supply) : N(l.qty_req));
  const total = priced.reduce((a, l) => a + qtyOf(l) * N(l.unit_price), 0);
  const [mode, setMode] = useState('target'); const [val, setVal] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const has = deal.discount_amount != null;
  const target = mode === 'target' ? N(val) : total - N(val);
  const ok = N(val) > 0 && target > 0 && target < total;
  const unit = deal.currency === 'XOF' ? 1 : 0.01;
  const preview = ok ? priced.map((l) => ({ ...l, np: Math.ceil(N(l.unit_price) * target / total / unit - 1e-9) * unit })) : [];
  const newTotal = preview.reduce((a, l) => a + qtyOf(l) * l.np, 0);
  const run = async (sql, params, msg) => { setBusy(true); try { await call(role, sql, params); toast(msg); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); } };
  const reconfirm = ['confirmed', 'reviewed'].includes(deal.status);
  if (has) return (
    <Modal title="整单折扣" risk="red" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>关闭</button><button type="button" className="btn danger" disabled={busy} onClick={() => (note.trim() ? run(`select app.undo_deal_discount($1,$2)`, [deal.id, note.trim()], '已撤销折扣，单价回到折扣前') : toast('写撤销原因', 'err'))}>撤销这次折扣</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        <div>这张单已经打过整单折扣：<b>−{money(deal.discount_amount, deal.currency)}</b>，谈好的总价 <b>{money(deal.discount_target, deal.currency)}</b>。原因：{deal.discount_note}</div>
        <FRow label="撤销原因" req><input className="in" style={{ flex: '1 1 240px', minWidth: 0 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="为什么撤销" /></FRow>
        {reconfirm && <div className="banner info">客户已经确认过这张单：撤销后要客户重新确认。</div>}
      </div>
    </Modal>);
  return (
    <Modal title="整单折扣" wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn primary" disabled={busy || !ok} onClick={() => (note.trim() ? run(`select app.apply_deal_discount($1,$2,$3)`, [deal.id, target, note.trim()], `已打折：客户应收 ${money(target, deal.currency)}`) : toast('写折扣原因', 'err'))}>确认打折</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <div>现在的总价 <b>{money(total, deal.currency)}</b> {deal.currency}</div>
        <FRow label="怎么填"><Choice value={mode} onChange={(v) => { setMode(v); setVal(''); }} options={[['target', '填谈好的总价'], ['off', '填减多少']]} /></FRow>
        <FRow label={mode === 'target' ? '谈好的总价' : '减多少'} req><MoneyIn className="in" inputMode="decimal" style={{ width: 160, fontSize: 17, fontWeight: 700 }} value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.]/g, ''))} autoFocus />
          <span className="small muted">{deal.currency}</span>{ok && <span className="pill amber">−{money(total - target, deal.currency)}（{((total - target) / total * 100).toFixed(1)}%）</span>}</FRow>
        <FRow label="原因" req><input className="in" style={{ flex: '1 1 240px', minWidth: 0 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="为什么给这个折扣" /></FRow>
        {ok && <div className="disc-prev">
          <div className="small muted">折扣按金额比例摊进每个型号的单价（向上取整）<Assumed>单价向上取整后会比谈好的总价多出几块钱零头（这次 {money(newTotal - target, deal.currency)}），第一次出库时系统自动记一笔抹零，客户应收正好等于谈好的总价。金蝶按折后单价录。打过整单折扣的单，以后不当「上次成交价」。</Assumed></div>
          {preview.map((l) => <div key={l.id} className="disc-row"><span>{l.model || l.req_model}</span><span className="muted">{qtyOf(l)} 片</span><span>{money(l.unit_price, deal.currency)} → <b>{money(l.np, deal.currency)}</b></span></div>)}
          <div className="disc-row"><b>客户应收</b><span /><b>{money(target, deal.currency)}</b></div>
        </div>}
        {reconfirm && <div className="banner info">客户已经确认过这张单：打折后要把新的销售单发给客户重新确认。</div>}
      </div>
    </Modal>);
}
