// 413 (Frank 11-18): 凡是「提交后会生成单据」的动作, 提交后给一张结果卡 —— 生成的单号 (带缩略预览) + 账 / 库存变了什么 + 下一步, 不只弹一句提示.
// 收款的结果卡在 ReceiptForm.jsx (ReceiptDone); 这里是 出库 / 退货 / 采购到货. 用法: 提交成功后 showDone({ kind, ... }); 页面上放一个 <DoneHost />.
import React, { useEffect, useRef, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData } from './ui.jsx';
import { DocNo } from './DocPeek.jsx';
import { seesPrice } from '../lib/domain.js';
import { money, qty, dt } from '../lib/format.js';

const N = (v) => Number(v || 0);
let CUR = null;
export function showDone(x) { CUR = { ...x, t: Date.now() }; window.dispatchEvent(new Event('la9s:done')); }
const LOAD = {
  shipment: async (x) => { const [r] = await q(`select s.id, s.out_no, s.shipped_at, s.amount, d.currency, d.customer_id, c.name as customer, s.bl_no,
        (select coalesce(sum(sl.qty), 0)::int from app.shipment_lines sl where sl.shipment_id = s.id) as qty,
        (select coalesce(sum(l.qty_supply - l.qty_shipped), 0)::int from app.deal_lines l where l.deal_id = s.deal_id) as rest,
        (select balance from app.v_customer_credit v where v.customer_id = d.customer_id) as balance
      from app.shipments s join app.deals d on d.id = s.deal_id join app.customers c on c.id = d.customer_id where s.deal_id = $1 and s.voided_at is null order by s.created_at desc limit 1`, [x.deal]); return r; },
  ret: async (x) => { const [r] = await q(`select r.id, r.rt_no, r.status, r.amount, d.currency, c.name as customer, (select coalesce(sum(rl.qty), 0)::int from app.return_lines rl where rl.return_id = r.id) as qty
      from app.returns r join app.deals d on d.id = r.deal_id join app.customers c on c.id = r.customer_id where r.deal_id = $1 order by r.requested_at desc limit 1`, [x.deal]); return r; },
  grn: async (x) => { const [r] = await q(`select g.id, g.grn_no, g.created_at, p.po_no, p.id as po_id,
        (select coalesce(sum(coalesce((y->>'local_qty')::int, 0) + coalesce((y->>'fob_qty')::int, 0)), 0)::int from jsonb_array_elements(g.lines) y) as qty,
        (select string_agg(distinct y->>'warehouse', ' / ') from jsonb_array_elements(g.lines) y) as wh
      from app.po_receipts g join app.purchase_orders p on p.id = g.po_id where g.po_id = $1 order by g.created_at desc limit 1`, [x.po]); return r; },
};

export function DoneHost({ only }) {
  const { role, go } = useApp();
  const [x, setX] = useState(CUR && Date.now() - CUR.t < 5000 ? CUR : null);
  useEffect(() => { const f = () => setX(CUR); window.addEventListener('la9s:done', f); return () => window.removeEventListener('la9s:done', f); }, []);
  const show = x && (!only || only.includes(x.kind)) ? x : null;
  const { data: r } = useData(() => (show ? LOAD[show.kind](show).catch(() => null) : Promise.resolve(null)), [show?.t]);
  const box = useRef(null);
  useEffect(() => { if (show && r && box.current) box.current.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [show?.t, !!r]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!show || !r) return null;
  const price = seesPrice(role);
  const close = () => { CUR = null; setX(null); };
  const Cell = ({ k, children, sub }) => <div className="done-cell"><div className="k">{k}</div><div className="v">{children}</div>{sub && <div className="small muted">{sub}</div>}</div>;
  return (
    <div className="card done-card" ref={box}>
      <div className="card-h"><h2>✓ {{ shipment: '已出库', ret: '退货已登记', grn: '采购入库单已生成' }[show.kind]}</h2><span className="grow" /><button type="button" className="btn sm ghost" onClick={close}>知道了</button></div>
      <div className="card-b done-grid">
        {show.kind === 'shipment' && <>
          <Cell k="出库单" sub={`${dt(r.shipped_at)} · ${qty(r.qty)} 片${price ? ` · ${money(r.amount, r.currency)} ${r.currency}` : ''}`}><DocNo kind="shipment" id={r.id} no={r.out_no} /></Cell>
          <Cell k="发货文件" sub="在下面「出库记录」里打印 BL ×2 / 海关文件">{r.bl_no ? <span className="mono">BL {r.bl_no}</span> : 'BL 还没出号'}</Cell>
          {price && <Cell k="客户总账" sub="出库那一刻才记进客户欠款">{r.customer} 现在{N(r.balance) > 0 ? `欠 ${money(r.balance)}` : N(r.balance) < 0 ? `预付 ${money(-N(r.balance))}` : '结清'}</Cell>}
          <Cell k="下一步" sub="签收后这张出库单才进「待录金蝶」">{N(r.rest) > 0 ? `还有 ${qty(r.rest)} 片没发 · ` : ''}跟客户确认数量 → 签收</Cell>
        </>}
        {show.kind === 'ret' && <>
          <Cell k="退货单" sub={`${r.customer} · ${qty(r.qty)} 片${price ? ` · ${money(r.amount, r.currency)} ${r.currency}` : ''}`}><DocNo kind="ret" id={r.id} no={r.rt_no} /></Cell>
          <Cell k="现在的状态" sub="批了以后才冲减客户欠款；货先进待检仓">等中方批</Cell>
          <Cell k="下一步">中方批 → 和客户对账 → 检验（好货回原仓 / 坏货进报废仓）</Cell>
        </>}
        {show.kind === 'grn' && <>
          <Cell k="收货单" sub={`采购单 ${r.po_no} · ${dt(r.created_at)}`}><span className="mono">{r.grn_no}</span></Cell>
          <Cell k="进了哪个仓" sub="库存已经加上，可售跟着变">{qty(r.qty)} 片 → {r.wh || '—'}</Cell>
          <Cell k="金蝶" sub="在金蝶做采购入库，回来填单号"><button type="button" className="linkbtn" onClick={() => go('kingdee')}>待录金蝶 →</button></Cell>
        </>}
      </div>
    </div>);
}
