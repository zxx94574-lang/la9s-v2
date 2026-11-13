// 收款与冲账 (finance page, 待改 28–39): pick a customer → 未结清 / 已结清 tabs → same receipt form as inside the deal.
// Receipt records are titled clearly, their 冲到 numbers open the order in a drawer, and 冲账情况 is one sentence.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Thumb } from '../components/ui.jsx';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import { BalanceCopy } from '../components/Doc.jsx';
import ReceiptForm, { DealDrawer, DealChip, BalanceLine, VoidReceiptModal, RcvStatus, rcvState, ReallocModal, verifyRcvAction } from '../components/ReceiptForm.jsx';
import { can, PAY_METHODS } from '../lib/domain.js';
import { money, dDate, friendlyError, periodRange } from '../lib/format.js';

const N = (v) => Number(v || 0);

export default function Receipts({ preset }) {
  const { org, role, toast, refresh, go } = useApp();
  const [customer, setCustomer] = useState(preset || '');
  const [acc, setAcc] = useState('XOF');
  const [tab, setTab] = useState('open');
  const [done, setDone] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [voidRc, setVoidRc] = useState(null);
  const [realloc, setRealloc] = useState(null);
  const [from, to] = periodRange('year');

  const { data } = useData(async () => {
    const [customers, list] = await Promise.all([q(Q.customers, [org]), q(Q.receipts, [org, from, to])]);
    let extra = {};
    if (customer) {
      const [curs, settled, [bal]] = await Promise.all([q(Q.customerCurrencies, [customer]), q(Q.customerSettledDeals, [customer, acc]), q(Q.customerBalance, [customer, acc])]);
      extra = { curs: curs.map((c) => c.currency), settled, bal };
    }
    return { customers, list, ...extra };
  }, [org, customer, acc]);
  if (!data) return <div className="empty">加载中…</div>;

  const sentence = (r) => {
    if (r.voided_at) return `已撤销：${r.void_reason || ''}`;
    const parts = r.allocations.map((a) => `${a.biz_no} ${money(a.amount, r.account_currency)}`);
    if (!parts.length) return N(r.unallocated) > 0 ? `还没冲到订单，${money(r.unallocated, r.account_currency)} 作为预付` : '—';
    if (N(r.unallocated) <= 0) return r.allocations.length === 1 ? `全部冲到 ${r.allocations[0].biz_no}` : `冲 ${parts.join('、')}`;
    return `冲 ${parts.join('、')}，剩 ${money(r.unallocated, r.account_currency)} 作为预付`;
  };
  const listCols = [
    { key: 'rcv_no', label: '收款单号', w: 140, render: (r) => <b className="mono">{r.rcv_no}</b> },
    { key: 'received_on', label: '日期', w: 100, render: (r) => dDate(r.received_on) },
    { key: 'customer_name', label: '客户', w: 150, render: (r) => <><CustLink id={r.customer_id} name={r.customer_name} /> <span className="muted small">{r.customer_code}</span></> },
    { key: 'method', label: '方式', w: 90, render: (r) => PAY_METHODS[r.method] },
    { key: 'amount', label: '收款（原币）', w: 130, render: (r) => `${money(r.amount, r.currency)} ${r.currency}` },
    { key: 'rate', label: '锁定汇率', w: 120, hidden: !data.list.some((r) => r.currency !== r.account_currency), render: (r) => (r.currency === r.account_currency ? '—' : N(r.rate) >= 1 ? `1 ${r.currency} = ${+N(r.rate).toFixed(3)} ${r.account_currency}` : `1 ${r.account_currency} = ${+(1 / N(r.rate)).toFixed(3)} ${r.currency}`) },
    { key: 'converted', label: '入账金额', w: 120, render: (r) => <b>{money(r.converted, r.account_currency)} {r.account_currency}</b> },
    { key: 'vstate', label: '到账状态', w: 200, value: (r) => rcvState(r)[1], render: (r) => <RcvStatus r={r} onDone={refresh} /> },
    { key: 'account_name', label: '账户', w: 110, render: (r) => r.account_name || (r.collector_name ? `员工 ${r.collector_name}` : '—') },
    { key: 'alloc', label: '冲到', w: 200, render: (r) => r.allocations.map((a) => <DealChip key={a.deal_id} id={a.deal_id} no={a.biz_no} onOpen={setDrawer} />) },
    { key: 'status', label: '冲账情况', w: 300, value: sentence, render: (r) => (
      <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <span style={{ whiteSpace: 'normal' }}>{sentence(r)}</span>
      </span>) },
    { key: 'undo', label: '撤销', w: 70, sortable: false, filterable: false, render: (r) => (r.voided_at ? <Pill tone="gray">已撤销</Pill> : '') },
    { key: 'proof', label: '凭证', w: 80, sortable: false, filterable: false, render: (r) => (r.proof_path ? <Thumb src={r.proof_path} size={30} label={`${r.rcv_no} 收款凭证`} /> : r.voided_at ? null : <span className="pill red">缺凭证</span>) },
  ];
  const settledCols = [
    { key: 'biz_no', label: '订单', w: 150, render: (d) => (d.kind === 'opening' ? '期初欠款' : <DealChip id={d.deal_id} no={d.biz_no} onOpen={setDrawer} />) },
    { key: 'first_shipped_at', label: '出库日期', w: 100, render: (d) => dDate(d.first_shipped_at) || '历史' },
    { key: 'rec', label: `应收 ${acc}`, w: 120, value: (d) => N(d.shipped_amount) - N(d.returned_amount), render: (d) => money(N(d.shipped_amount) - N(d.returned_amount), acc) },
    { key: 'allocated_amount', label: '已付', w: 120, render: (d) => money(d.allocated_amount, acc) },
    { key: 'writeoff_amount', label: '抹零', w: 80, render: (d) => (N(d.writeoff_amount) ? money(d.writeoff_amount, acc) : '') },
    { key: 'st', label: '状态', w: 90, render: () => <Pill tone="green">已结清</Pill> },
  ];
  const mine = customer ? data.list.filter((r) => r.customer_id === customer) : data.list;

  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Encaissements</div><h1>收款与冲账</h1>
        <div className="sub">隔天付款、一次付多单在这里收；客户当场付款直接在订单的「⑨ 收款」里收。两边是同一个收款功能。</div></div></div>

      <div className="card">
        <div className="card-h">
          <div className="row" style={{ gap: 14, alignItems: 'flex-end' }}>
            <div className="field req" style={{ minWidth: 300 }}><label>客户</label><CustomerSelect customers={data.customers} value={customer} onChange={(c) => { setCustomer(c); setDone(null); setAcc('XOF'); setTab('open'); }} /></div>
            {customer && data.curs?.length > 1 && <div className="field"><label>账户币种（订单币种，分开记账）</label>
              <div className="seg">{data.curs.map((c) => <button type="button" key={c} className={acc === c ? 'on' : ''} onClick={() => setAcc(c)}>{c}</button>)}</div></div>}
          </div>
          {customer && data.bal && <div className="row" style={{ gap: 12 }}><BalanceLine balance={data.bal.balance} currency={acc} size={22} />
            <button type="button" className="btn sm" onClick={() => go('customer/' + customer)}>客户总账 →</button></div>}
        </div>
        {customer && (
          <>
            <div className="tabs">
              <button type="button" className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>未结清订单 · 收款冲账</button>
              <button type="button" className={tab === 'settled' ? 'on' : ''} onClick={() => setTab('settled')}>已结清订单 <span className="muted">{data.settled?.length || 0}</span></button>
            </div>
            {tab === 'open' ? <ReceiptForm key={customer + acc} customer={customer} accountCurrency={acc} onDone={setDone} />
              : <Grid id="rcv-settled" columns={settledCols} rows={data.settled || []} rowKey={(d) => d.deal_id} empty="还没有已结清的订单" />}
            {done && (
              <div className="card-b row between" style={{ background: 'var(--green-bg)' }}>
                <span>✓ 已登记 {money(done.amount, done.currency)} {done.currency}{done.hits.map(([n, v]) => ` → ${n} ${money(v, done.acc)}`).join('')}{done.left > 0 && `，剩 ${money(done.left, done.acc)} 记为预付`}</span>
                <BalanceCopy customerId={customer} currency={acc} label="复制 Balance 图片" primary />
              </div>
            )}
          </>
        )}
        {!customer && <div className="card-b hint">先选客户：下面会列出这个客户未结清 / 已结清的订单，直接在这里收款冲账。</div>}
      </div>

      <div className="card">
        <div className="card-h"><h2>收款记录（每一笔进账）{customer && <span className="muted small"> · 只看这个客户</span>}</h2><span className="hint">单号可点开查看；「冲账情况」写清这笔钱去了哪</span></div>
        <Grid id="rcv-list2" table="receipts" columns={listCols} rows={mine} rowActions={can(role, 'receipt') ? [verifyRcvAction(role, toast, refresh), { label: '改冲账', tone: '', when: (r) => !r.voided_at && (r.allocations.length > 0 || N(r.unallocated) > 0), run: (r) => setRealloc(r) },
            { label: '把预付冲到订单', tone: '', when: (r) => !r.voided_at && N(r.unallocated) > 0, run: async (r) => { try { await call(role, `select app.apply_unallocated($1,'oldest','[]')`, [r.id]); toast('预付已冲到最老的未付单'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } } },
            { label: '↶ 撤销这笔收款', tone: 'soft-red', when: (r) => !r.voided_at, run: (r) => setVoidRc(r) }] : undefined} empty="本年还没有收款"
          foot={(rows) => ({ rcv_no: `合计 ${rows.filter((r) => !r.voided_at).length} 笔`, converted: `${money(rows.filter((r) => !r.voided_at && r.account_currency === 'XOF').reduce((a, r) => a + N(r.converted), 0))} XOF` })} />
      </div>
      {drawer && <DealDrawer id={drawer} onClose={() => setDrawer(null)} />}
      {voidRc && <VoidReceiptModal rc={voidRc} onClose={() => setVoidRc(null)} />}
      {realloc && <ReallocModal r={realloc} onClose={() => setRealloc(null)} onDone={refresh} />}
    </>
  );
}
