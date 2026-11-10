// 销售询单 (Frank 10-30/31): 中小客户不开账号, 销售员 / 热线替客户在系统里询单.
// 员工看不到价格清单; 老客户按公式价、没超欠款的单自动通过 → 马上看到价格、能发报价单;
// 新客户 / 申请特价 / 超欠款上限 / 超账期 / 有没编码的型号 → 等中方一键审批.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import ModelPicker, { avail } from '../components/ModelPicker.jsx';
import { ProspectModal } from '../components/Crm.jsx';
import { STATUS } from '../lib/domain.js';
import { dt, friendlyError , money} from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';

const AP = { auto: ['自动通过', 'green'], pending: ['等中方审批', 'amber'], approved: ['中方已批', 'green'], rejected: ['没批', 'red'] };

export default function Inquiry({ embedded } = {}) {
  const { org, role, toast, refresh, go } = useApp();
  const [cust, setCust] = useState('');
  const [lines, setLines] = useState([]);
  const [free, setFree] = useState({ model: '', qty: '' });
  const [note, setNote] = useState('');
  const [newP, setNewP] = useState(false);
  const { data } = useData(async () => {
    const [customers, catalog, categories, mine] = await Promise.all([q(Q.customers, [org]), q(Q.catalog, [org]), q(Q.categories, [org]), q(Q.myInquiries, [org, USERS[role]])]);
    return { customers: customers.map((c) => ({ ...c, code: c.code || c.temp_code })), catalog, categories, mine };
  }, [org, role]);
  if (!data) return <div className="empty">加载中…</div>;
  const c = data.customers.find((x) => x.id === cust);
  const add = (p) => setLines((l) => (l.some((x) => x.product_id === p.id) ? l : [...l, { product_id: p.id, code: p.code, model: p.model, variant: p.variant, category: p.category, category_id: p.category_id, avail: avail(p), qty: '', price: '' }]));
  const set = (i, k, v) => setLines((l) => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const ok = cust && lines.some((l) => Number(l.qty) > 0);
  const submit = async () => {
    try {
      const [{ id }] = await call(role, `select app.create_inquiry($1,$2,$3,$4) as id`, [org, cust, JSON.stringify(lines.filter((l) => Number(l.qty) > 0).map((l) => (l.product_id
        ? { product_id: l.product_id, qty_req: Number(l.qty), requested_price: l.price ? Number(l.price) : null }
        : { req_category_id: l.category_id || data.categories[0]?.id, req_model: l.model, qty_req: Number(l.qty) }))), note || null]);
      const [d] = await q(`select approval, approval_reasons from app.deals where id = $1`, [id]);
      toast(d.approval === 'auto' ? '询单已建，自动通过：现在看得到价格，可以发报价单' : `询单已建，等中方审批（${d.approval_reasons.join('、')}）`);
      setLines([]); setNote(''); refresh(); go('deal/' + id);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const mCols = [
    { key: 'biz_no', label: '单号', w: 130, render: (d) => <span className="mono">{d.biz_no}</span> },
    { key: 'customer_name', label: '客户', w: 170, value: (d) => `${d.code || d.temp_code} ${d.customer_name}`, render: (d) => <><span className="mono muted">{d.code || d.temp_code}</span> <CustLink id={d.customer_id} name={d.customer_name} /></> },
    { key: 'created_at', label: '时间', w: 130, render: (d) => dt(d.created_at) },
    { key: 'lines', label: '型号数', w: 70, value: (d) => Number(d.lines) },
    { key: 'approval', label: '审批', w: 110, value: (d) => AP[d.approval][0], render: (d) => <span title={d.approval_reasons.join('、')}><Pill tone={AP[d.approval][1]}>{AP[d.approval][0]}</Pill></span> },
    { key: 'status', label: '进度', w: 140, value: (d) => STATUS[d.status]?.label, render: (d) => <Pill tone={STATUS[d.status]?.tone}>{STATUS[d.status]?.label}</Pill> },
  ];
  return (
    <>
      {!embedded && <div className="pagehead"><div><div className="eyebrow">Demande de prix</div><h1>销售询单</h1>
        <div className="sub">替客户询单。看不到价格清单：老客户按档位价、没超欠款的自动通过，马上看得到价格发给客户；新客户、要特价、超欠款、有没编码的型号要等中方审批。</div></div>
        <button type="button" className="btn" onClick={() => setNewP(true)}>＋ 新客户（潜客）</button>
      </div>}
      {embedded && <div className="card card-b row between"><span className="hint">员工替客户询单 + 中方审批。看不到价格清单：老客户按档位价、没超欠款的自动通过；新客户、要特价、超欠款、有没编码的型号等中方审批。</span><button type="button" className="btn sm" onClick={() => setNewP(true)}>＋ 新客户（潜客）</button></div>}
      <div className="card">
        <div className="card-b row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="grow" style={{ maxWidth: 460 }}><CustomerSelect onlyActive={false} customers={data.customers} value={cust} onChange={setCust} /></div>
          {c && (c.status === 'active' ? <Pill tone="blue">老客户</Pill> : <Pill tone="amber">新客户：要中方定档位</Pill>)}
        </div>
        <div className="card-b" style={{ paddingTop: 0 }}><ModelPicker catalog={data.catalog} categories={data.categories} onPick={add} showPrice={false} /></div>
        <Grid id="inq-lines" noTools rowKey={(l) => l._k} rows={lines.map((l, i) => ({ ...l, _k: String(i) }))} onDelete={(l, i, rs) => { const ks = new Set((rs || [l]).map((y) => y._k)); setLines((x) => x.filter((_, j) => !ks.has(String(j)))); }} empty="上面选型号，或在下面填客户要的没编码的型号" columns={[
          { key: 'code', label: '编码', w: 90, mono: true, value: (l) => l.code || '没编码', render: (l) => l.code || <Pill tone="amber">没编码</Pill> },
          { key: 'category', label: '种类', w: 110, value: (l) => l.category || '' },
          { key: 'model', label: '型号', w: 150, value: (l) => l.model, render: (l) => <><ModelLink id={l.product_id} model={l.model} />{l.variant && <span className="muted small"> {l.variant}</span>}</> },
          { key: 'avail', label: '可售', w: 70, value: (l) => (l.product_id ? l.avail : null), render: (l) => (l.product_id ? (l.avail > 0 ? l.avail : <Pill tone="red">无货</Pill>) : '—') },
          { key: 'qty', label: '数量', w: 90, fill: true, value: (l) => l.qty, edit: (l) => ({ type: 'number', value: l.qty, onChange: (v) => set(Number(l._k), 'qty', String(v ?? '').replace(/\D/g, '')) }) },
          { key: 'price', label: '客户想要的价（填了 = 申请特价）', w: 170, value: (l) => l.price || '', render: (l) => (l.product_id ? (l.price ? money(l.price) : <span className="muted">按档位价</span>) : ''), edit: (l) => (l.product_id ? { type: 'number', value: l.price || '', onChange: (v) => set(Number(l._k), 'price', String(v ?? '').replace(/\D/g, '')) } : null) },
        ]} />
        <div className="card-b row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingTop: 6 }}><span className="small muted">客户要的但我们没编码</span>
          <input className="in" style={{ maxWidth: 160 }} placeholder="型号" value={free.model} onChange={(e) => setFree({ ...free, model: e.target.value.toUpperCase() })} />
          <input className="in" inputMode="numeric" placeholder="数量" value={free.qty} style={{ maxWidth: 90 }} onChange={(e) => setFree({ ...free, qty: e.target.value.replace(/\D/g, '') })} />
          <button type="button" className="btn sm" disabled={!free.model || !free.qty} onClick={() => { setLines((x) => [...x, { model: free.model, qty: free.qty }]); setFree({ model: '', qty: '' }); }}>加</button></div>
        <div className="card-b row" style={{ gap: 8 }}>
          <input className="in grow" placeholder="备注（客户要什么时候、怎么拿货…）" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn primary" disabled={!ok} onClick={submit}>提交询单</button>
        </div>
      </div>
      <h3>我的询单</h3>
      <div className="card"><Grid id="my-inquiries" table="deals" columns={mCols} rows={data.mine} onRowClick={(d) => go('deal/' + d.id)} empty="还没有询单" /></div>
      {newP && <ProspectModal onClose={() => setNewP(false)} onDone={(x) => setCust(x.id)} />}
    </>
  );
}
