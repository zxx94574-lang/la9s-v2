// 417 (Frank 11-19, 全站): 凡是动账的动作, 确认前都用同一个样子告诉人「账会怎么变」—— 两张独立小卡片: 本单应收 改前 → 改后 / 客户总账 改前 → 改后.
// delta = 这次动作让「客户欠我们的钱」变多少 (正 = 欠得更多, 负 = 欠得更少). deal 可以不给 (只动客户总账的动作, 例如预付退款).
import React from 'react';
import { q } from '../db/client.js';
import { useApp, useData, AcctImpact } from './ui.jsx';
import { money } from '../lib/format.js';

export function ImpactFor({ dealId, customerId, cur = 'XOF', delta = 0, note, docLabel, pending }) {
  const { tick } = useApp();
  const { data } = useData(async () => {
    const [d] = dealId ? await q(`select due, customer_id, currency from app.v_deal_due where deal_id = $1`, [dealId]) : [null];
    const cid = customerId || d?.customer_id; const c = d?.currency || cur;
    const [b] = cid ? await q(`select balance from app.v_customer_balance where customer_id = $1 and currency = $2`, [cid, c]) : [null];
    return { due: d ? Number(d.due) : null, bal: Number(b?.balance || 0), cur: c };
  }, [dealId, customerId, cur, tick]);
  if (!data || (!dealId && !customerId)) return null;
  const f = (n) => `${money(n, data.cur)} ${data.cur}`; const x = Number(delta) || 0;
  return <AcctImpact fmt={f} docLabel={docLabel} doc={data.due == null ? null : { before: data.due, after: data.due + x }} ledger={{ before: data.bal, after: data.bal + x }} note={note} ledgerNote={pending} />;
}
