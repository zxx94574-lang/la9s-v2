// 0076 熟客直接下单卡在欠款关 → 财务的紧急待办 (财务对完账、登记收款后自动下推找货, 这里自动消失)
import { hasAny } from '../lib/domain.js';
import React from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Pill, Info } from './ui.jsx';
import { money } from '../lib/format.js';

export function DirectHeld() {
  const { org, role, tick, go } = useApp();
  const { data } = useData(() => (hasAny(role, ['admin', 'finance']) ? q(`select * from app.v_direct_held where org_id = $1 order by created_at`, [org]) : Promise.resolve([])), [org, role, tick]);
  const rows = (data || []).filter((r) => (r.approval_reasons || []).every((x) => /超欠款上限|超账期|有欠款不出货/.test(x)));
  if (!rows.length) return null;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
      <div className="card-h"><h2>直接下单卡在欠款</h2><Pill tone="red">{rows.length} 张</Pill>
        <Info>熟客直接下单时客户超了欠款上限或账期，单子停在找货前。跟客户对完账、登记收款，够了就自动下推找货，这一行自动消失；中方也可以在订单里直接特批。</Info></div>
      {rows.map((r) => (
        <div key={r.deal_id} className="orow todo-row" style={{ gridTemplateColumns: 'auto 1fr auto' }} onClick={() => go('deal/' + r.deal_id)}>
          <span className="age red">欠款</span>
          <span className="small"><b>{r.customer_name}</b> · {r.biz_no} · 这单 {money(r.order_total)} · 现在欠 {money(r.balance)}{r.credit_limit != null ? `（上限 ${money(r.credit_limit)}）` : ''}{r.oldest_days != null ? ` · 最老一笔 ${r.oldest_days} 天${r.credit_days != null ? `（账期 ${r.credit_days} 天）` : ''}` : ''}</span>
          <b className="muted">去对账 ›</b>
        </div>))}
    </div>);
}
