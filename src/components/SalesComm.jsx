// 334 (Frank 11-17): 销售提成 —— 按片; 整单付清才算; 只算有归属销售员的客户的单; 特价单照算; FOB 不算. 只中方看.
import React, { useState } from 'react';
import { call } from '../db/client.js';
import { useApp, useData, Info, Pill, Assumed } from './ui.jsx';
import Grid from './Grid.jsx';
import { EmpLink, DealLink } from './Archives.jsx';
import { money, qty, dDate } from '../lib/format.js';

export default function SalesComm({ from, to }) {
  const { org, role, tick, go } = useApp();
  const [open, setOpen] = useState(null);
  const { data } = useData(async () => {
    if (role !== 'admin') return null;
    const [sum, deals] = await Promise.all([call(role, `select * from app.sales_commission($1,$2,$3)`, [org, from, to]), call(role, `select * from app.sales_commission_deals($1,$2,$3)`, [org, from, to])]);
    return { sum, deals };
  }, [org, role, from, to, tick]);
  if (!data) return null;
  const pp = Number(data.sum[0]?.per_piece || 0);
  return (
    <div className="card">
      <div className="card-h"><h2>销售提成（按片）</h2>{pp > 0 ? <Pill tone="green">每片 {money(pp)} XOF</Pill> : <Pill tone="amber">每片金额还没定</Pill>}
        <Info>规则：按片算；一张单<b>整单付清</b>才算，付清那天落在所选时间段里就计入；只算有归属销售员的客户的单（按这张单建单时的归属人）；特价单照算；FOB 客户不算；片数 = 出库 − 退货。</Info>
        <Assumed>每片多少钱你还没定，现在是 {pp}（在「规则参数」里改）。这里只算数，暂时不会自动进工资单；「付清那天」按最后一笔冲账的日期算。</Assumed>
        <span className="grow" /><button type="button" className="btn sm ghost" onClick={() => go('rules')}>改每片金额 ›</button></div>
      {data.sum.length ? <Grid id="sales-comm" slimTools columns={[
        { key: 'short_name', label: '销售员', w: 140, render: (r) => <EmpLink id={r.employee_id} name={r.short_name} /> },
        { key: 'deals', label: '付清的单', w: 100, type: 'number' },
        { key: 'pieces', label: '片数', w: 110, type: 'number', render: (r) => <b>{qty(r.pieces)}</b> },
        { key: 'amount', label: '提成 XOF', w: 130, type: 'number', render: (r) => <b>{money(r.amount)}</b> },
      ]} rows={data.sum} rowKey={(r) => r.employee_id} rowActions={[{ label: '看是哪几张单', run: (r) => setOpen(open === r.employee_id ? null : r.employee_id) }]} />
        : <div className="card-b small muted">这段时间没有「整单付清」的单。</div>}
      {open && data.deals.filter((d) => d.employee_id === open).map((d) => (
        <div key={d.deal_id} className="orow" style={{ gridTemplateColumns: '1fr auto' }}>
          <span className="small"><DealLink id={d.deal_id} no={d.biz_no} /> · {d.customer_name} · {dDate(d.paid_on)} 付清{d.special ? ' · 有特价' : ''}</span><b>{qty(d.pieces)} 片</b>
        </div>))}
    </div>);
}
