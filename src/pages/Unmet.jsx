import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { qty, dDate } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink, DealLink } from '../components/Archives.jsx';

export default function Unmet() {
  const { org, go } = useApp();
  const { data } = useData(() => q(Q.unmet, [org]), [org]);
  const [kind, setKind] = useState('no_code');
  const rows = (data || []).filter((r) => r.kind === kind);
  // 汇总：同种类+型号合并，作为备货依据
  const summary = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.category}|${r.model}`;
      const x = m.get(k) || { key: k, category: r.category, model: r.model, qty: 0, customers: new Set(), times: 0 };
      x.qty += Number(r.qty_unmet); x.customers.add(r.customer_name); x.times++; m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.qty - a.qty);
  }, [rows]);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Demande non satisfaite</div><h1>未满足需求</h1>
        <div className="sub">两类分开统计：客户要了但我们没建档的型号；有货但不够（要 100 给 60 的 40）。每一条都留底：哪天、哪个客户（游客也记）、哪个销售员、从哪里来的，是备货的依据。</div></div>
        <div className="seg">
          <button type="button" className={kind === 'no_code' ? 'on' : ''} onClick={() => setKind('no_code')}>没建档的型号 {data && `(${data.filter((r) => r.kind === 'no_code').length})`}</button>
          <button type="button" className={kind === 'short' ? 'on' : ''} onClick={() => setKind('short')}>有货但不够 {data && `(${data.filter((r) => r.kind === 'short').length})`}</button>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>按型号汇总</h2></div>
        <Grid id={'unmet-sum-' + kind} rowKey={(r) => r.key} rows={summary} columns={[
          { key: 'category', label: '种类', w: 100 }, { key: 'model', label: '型号', w: 120, render: (r) => <b>{r.model}</b> },
          { key: 'qty', label: '缺口数量', w: 90, render: (r) => <b>{qty(r.qty)}</b> }, { key: 'times', label: '被问次数', w: 80 },
          { key: 'customers', label: '哪些客户要', w: 260, render: (r) => [...r.customers].join('、') },
        ]} foot={{ category: `${summary.length} 个型号`, qty: qty(summary.reduce((a, r) => a + r.qty, 0)) }} />
      </div>
      <div className="card">
        <div className="card-h"><h2>逐条来源</h2></div>
        <Grid id={'unmet-' + kind} rowKey={(r) => r.line_id} rows={rows} onRowClick={(r) => go('deal/' + r.deal_id)} columns={[
          { key: 'created_at', label: '日期', w: 100, render: (r) => dDate(r.created_at) },
          { key: 'biz_no', label: '订单', w: 150, render: (r) => <DealLink id={r.deal_id} no={r.biz_no} /> },
          { key: 'source', label: '来源', w: 90, value: (r) => ({ guest: '游客询价', portal: '客户下单端', staff: '员工建单' })[r.source] || r.source,
            render: (r) => <span className={`pill ${r.source === 'guest' ? 'amber' : r.source === 'portal' ? 'blue' : 'gray'}`}>{({ guest: '游客询价', portal: '客户下单端', staff: '员工建单' })[r.source] || r.source}</span> },
          { key: 'customer_name', label: '客户', w: 170, render: (r) => <><CustLink id={r.customer_id} name={r.customer_name} /> <span className="muted small">{r.cust_code} · {r.city}{r.customer_status === 'prospect' ? ' · 潜客' : ''}</span></> },
          { key: 'owner_name', label: '销售员', w: 100, value: (r) => [r.owner_no, r.owner_name].filter(Boolean).join(' · '), render: (r) => <EmpLink id={r.owner_employee_id} name={[r.owner_no, r.owner_name].filter(Boolean).join(' · ')} /> },
          { key: 'category', label: '种类', w: 100 }, { key: 'model', label: '型号', w: 110, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
          { key: 'qty_unmet', label: '缺口', w: 70, render: (r) => qty(r.qty_unmet) },
        ]} />
      </div>
    </>
  );
}
