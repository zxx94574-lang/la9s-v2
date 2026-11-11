// FOB 项目 (Frank: 独立项目，一客一单). 申请 → 采购 → 在途 → 到货 → 放货 → 出库 → 结清.
// 科特迪瓦 = 仓库控货 (到货进 FOB 仓, 我们出库); 多哥等 = 物流控货 (货在物流手上, 放货 = 通知物流放).
// 常规 30% 订金 70% 尾款; 放货由中方人工决定, 没收齐也能放, 但要写原因.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, PhotoInput, DatePicker, Thumb, BigNum } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import ModelPicker from '../components/ModelPicker.jsx';
import { can, seesPrice, PAY_METHODS } from '../lib/domain.js';
import { money, dDate, dt, today, friendlyError } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';

const N = (v) => Number(v || 0);
export const FOB_STEPS = [['applied', '申请'], ['purchasing', '采购'], ['in_transit', '在途'], ['arrived', '到货'], ['released', '放货'], ['shipped', '出库'], ['closed', '结清']];
const ST = Object.fromEntries(FOB_STEPS);
const tone = (s) => ({ applied: 'amber', purchasing: 'blue', in_transit: 'blue', arrived: 'amber', released: 'green', shipped: 'green', closed: 'gray', cancelled: 'gray' })[s];
const ctrl = { warehouse: '仓库控货', logistics: '物流控货' };

export default function Fob({ id }) {
  return id ? <FobDetail id={id} /> : <FobList />;
}

function FobList() {
  const { org, role, go } = useApp();
  const [nw, setNw] = useState(false);
  const { data } = useData(() => q(Q.fobList, [org]), [org]);
  if (!data) return <div className="empty">加载中…</div>;
  const price = seesPrice(role);
  const cols = [
    { key: 'fob_no', label: 'FOB 单号', w: 130, render: (f) => <button type="button" className="linkbtn mono" onClick={(e) => { e.stopPropagation(); go('fob/' + f.id); }}>{f.fob_no}</button> },
    { key: 'customer_name', label: '客户', w: 160, value: (f) => `${f.customer_code} ${f.customer_name}`, render: (f) => <><span className="mono muted">{f.customer_code}</span> <b><CustLink id={f.customer_id} name={f.customer_name} /></b></> },
    { key: 'country', label: '国家', w: 60 },
    { key: 'control', label: '控货', w: 90, value: (f) => ctrl[f.control] },
    { key: 'status', label: '状态', w: 90, value: (f) => (f.status === 'cancelled' ? '已取消' : ST[f.status]), render: (f) => <Pill tone={tone(f.status)}>{f.status === 'cancelled' ? '已取消' : ST[f.status]}</Pill> },
    { key: 'qty', label: '件数', w: 80, value: (f) => N(f.qty) },
    ...(price ? [{ key: 'total', label: '金额', w: 120, value: (f) => N(f.total), render: (f) => (N(f.unpriced) ? <Pill tone="amber">{f.unpriced} 行待定价</Pill> : money(f.total, f.currency)) },
      { key: 'paid', label: '已收', w: 110, value: (f) => N(f.paid), render: (f) => money(f.paid, f.currency) },
      { key: 'due', label: '待收', w: 110, value: (f) => N(f.total) - N(f.paid), render: (f) => (N(f.total) - N(f.paid) > 0 ? <b className="red-t2">{money(N(f.total) - N(f.paid), f.currency)}</b> : '') }] : []),
    { key: 'eta', label: '预计到货', w: 100, render: (f) => dDate(f.eta) },
    { key: 'po_no', label: '采购单', w: 120 },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Projets FOB</div><h1>FOB 项目</h1>
        <div className="sub">一客一单：申请 → 中方定价 → 采购 → 在途 → 到货 → 放货 → 出库 → 收齐结清。科特迪瓦仓库控货（到货进 FOB 仓），多哥等物流控货。常规 30% 订金、70% 尾款，放货由中方决定。</div></div>
        {can(role, 'fob_create') && <button type="button" className="btn primary" onClick={() => setNw(true)}>＋ 新 FOB 申请</button>}
      </div>
      <div className="card"><Grid id="fob" table="fob_projects" columns={cols} rows={data} onRowClick={(f) => go('fob/' + f.id)} empty="还没有 FOB 项目" /></div>
      {nw && <NewFob onClose={() => setNw(false)} />}
    </>
  );
}

function NewFob({ onClose }) {
  const { org, role, toast, go } = useApp();
  const { data } = useData(async () => {
    const [customers, catalog, categories, countries] = await Promise.all([q(Q.customers, [org]), q(Q.catalog, [org]), q(Q.categories, [org]), q(`select code, name_zh from app.countries order by code`)]);
    return { customers, catalog, categories, countries };
  }, [org]);
  const [cust, setCust] = useState('');
  const [country, setCountry] = useState('CI');
  const [control, setControl] = useState('warehouse');
  const [lines, setLines] = useState([]);
  const [free, setFree] = useState({ model: '', qty: '' });
  const [note, setNote] = useState('');
  if (!data) return null;
  const add = (p) => setLines((l) => [...l, { product_id: p.id, model: p.model, category: p.category, code: p.code, qty: '' }]);
  const go2 = async () => {
    try {
      const [{ id }] = await call(role, `select app.create_fob($1,$2,$3,$4,'XOF',$5,$6) as id`, [org, cust, country, control,
        JSON.stringify(lines.filter((l) => Number(l.qty) > 0).map((l) => ({ product_id: l.product_id, model: l.model, qty: Number(l.qty) }))), note || null]);
      toast('FOB 申请已提交，等中方定价'); onClose(); go('fob/' + id);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title="新 FOB 申请" onClose={onClose} footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn primary" disabled={!cust || !lines.some((l) => Number(l.qty) > 0)} onClick={go2}>提交申请</button></>}>
      <div className="stack">
        <div className="grid2">
          <div className="field req"><label>客户</label><CustomerSelect customers={data.customers} value={cust} onChange={setCust} /></div>
          <div className="field req"><label>目的国</label><div className="row" style={{ gap: 6 }}>
            <select className="in" value={country} style={{ maxWidth: 160 }} onChange={(e) => { setCountry(e.target.value); setControl(e.target.value === 'CI' ? 'warehouse' : 'logistics'); }}>
              {data.countries.map((c) => <option key={c.code} value={c.code}>{c.code} {c.name_zh}</option>)}</select>
            <div className="seg">{Object.entries(ctrl).map(([k, l]) => <button type="button" key={k} className={control === k ? 'on' : ''} onClick={() => setControl(k)}>{l}</button>)}</div></div></div>
        </div>
        <ModelPicker catalog={data.catalog} categories={data.categories} onPick={add} showPrice={false} />
        <Grid id="fob-new-lines" noTools rowKey={(l) => l._k} rows={lines.map((l, i) => ({ ...l, _k: String(i) }))} onDelete={(l, i, rs) => { const ks = new Set((rs || [l]).map((y) => y._k)); setLines((x) => x.filter((_, j) => !ks.has(String(j)))); }} empty="从上面选型号，或在下面填没编码的新货" columns={[
          { key: 'code', label: '编码', w: 90, value: (l) => l.code || '—', mono: true },
          { key: 'category', label: '种类', w: 110, value: (l) => l.category || '—' },
          { key: 'model', label: '型号', w: 140, value: (l) => l.model, render: (l) => <ModelLink id={l.product_id} model={l.model} /> },
          { key: 'qty', label: '数量', w: 90, fill: true, value: (l) => l.qty, edit: (l) => ({ type: 'number', value: l.qty, onChange: (v) => setLines((x) => x.map((y, j) => (j === Number(l._k) ? { ...y, qty: String(v ?? '').replace(/\D/g, '') } : y))) }) },
        ]} />
        <div className="row" style={{ gap: 6, alignItems: 'center' }}><span className="muted small">没编码的新货</span>
          <input className="in" placeholder="型号" style={{ maxWidth: 160 }} value={free.model} onChange={(e) => setFree({ ...free, model: e.target.value.toUpperCase() })} />
          <input className="in" inputMode="numeric" placeholder="数量" value={free.qty} style={{ maxWidth: 100 }} onChange={(e) => setFree({ ...free, qty: e.target.value.replace(/\D/g, '') })} />
          <button type="button" className="btn sm" disabled={!free.model || !free.qty} onClick={() => { setLines((x) => [...x, { model: free.model, qty: free.qty }]); setFree({ model: '', qty: '' }); }}>加</button></div>
        <div className="field"><label>备注</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function FobDetail({ id }) {
  const { role, toast, refresh, go } = useApp();
  const [m, setM] = useState(null);
  const [prices, setPrices] = useState({});
  const { data } = useData(async () => {
    const [[f], lines, pays, events] = await Promise.all([q(Q.fobById, [id]), q(Q.fobLines, [id]), q(Q.fobPayments, [id]), q(Q.fobEvents, [id])]);
    return { f, lines, pays, events };
  }, [id]);
  if (!data) return <div className="empty">加载中…</div>;
  const { f, lines, pays, events } = data;
  if (!f) return <div className="card card-b">没有这个 FOB 项目</div>;
  const price = seesPrice(role), admin = role === 'admin';
  const act = async (msg, sql, p) => { try { await call(role, sql, p); toast(msg); refresh(); setM(null); } catch (e) { toast(friendlyError(e), 'err'); } };
  const cur = FOB_STEPS.findIndex(([k]) => k === f.status);
  const deposit = Math.round(N(f.total) * N(f.deposit_pct) / 100), due = N(f.total) - N(f.paid);
  const cols = [
    { key: 'code', label: '编码', w: 90, render: (l) => <span className="mono">{l.code || <Pill tone="amber">没编码</Pill>}</span> },
    { key: 'category', label: '种类', w: 90 },
    { key: 'model', label: '型号', w: 120, render: (l) => <ModelLink id={l.product_id} model={l.model} /> },
    { key: 'qty', label: '数量', w: 80, value: (l) => N(l.qty) },
    ...(price ? [{ key: 'unit_price', label: '单价', w: 110, value: (l) => N(prices[l.id] ?? l.unit_price),
      edit: admin && ['applied', 'purchasing'].includes(f.status) ? (l) => ({ type: 'number', value: prices[l.id] ?? (l.unit_price == null ? '' : String(Number(l.unit_price))), placeholder: '定价', onChange: (v) => setPrices((p) => ({ ...p, [l.id]: v.replace(/[^\d.]/g, '') })) }) : null,
      render: (l) => (l.unit_price == null ? <Pill tone="amber">待中方定价</Pill> : money(l.unit_price, f.currency)) },
      { key: 'amount', label: '金额', w: 120, value: (l) => N(l.qty) * N(l.unit_price), render: (l) => (l.unit_price == null ? '' : money(N(l.qty) * N(l.unit_price), f.currency)) }] : []),
    ...(f.control === 'warehouse' ? [{ key: 'qty_received', label: '已入 FOB 仓', w: 100, value: (l) => N(l.qty_received) }] : []),
    { key: 'qty_shipped', label: '已出', w: 80, value: (l) => N(l.qty_shipped) },
  ];
  const savePrices = async () => { for (const [lid, v] of Object.entries(prices)) if (v !== '') await call(role, `select app.set_fob_price($1,$2)`, [lid, Number(v)]); toast('已定价'); setPrices({}); refresh(); };
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow"><a href="#/fob">FOB 项目</a></div><h1 className="mono">{f.fob_no}</h1>
        <div className="sub"><b>{f.customer_code} {f.customer_name}</b> · {f.country} · {ctrl[f.control]}{f.po_no ? ` · 采购单 ${f.po_no}` : ''}{f.tracking ? ` · ${f.logistics || ''} ${f.tracking}` : ''}{f.eta ? ` · 预计 ${dDate(f.eta)} 到` : ''}</div></div>
        {f.status !== 'cancelled' && !['shipped', 'closed'].includes(f.status) && can(role, 'fob_advance') && <button type="button" className="btn" onClick={() => setM('cancel')}>取消项目</button>}
      </div>
      <div className="card card-b">
        <div className="flowline">{FOB_STEPS.map(([k, l], i) => <span key={k} className={`fl ${i < cur ? 'done' : i === cur ? 'cur' : ''}`}>{i < cur ? '✓ ' : `${i + 1} `}{l}</span>)}</div>
        {f.status === 'cancelled' && <div className="banner warn" style={{ marginTop: 8 }}>项目已取消</div>}
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {f.status === 'applied' && admin && Object.keys(prices).length > 0 && <button type="button" className="btn primary" onClick={savePrices}>保存定价</button>}
          {f.status === 'applied' && can(role, 'fob_advance') && <button type="button" className="btn primary" disabled={N(f.unpriced) > 0} onClick={() => setM('purchase')}>下采购 →</button>}
          {f.status === 'applied' && N(f.unpriced) > 0 && <span className="small muted">{f.unpriced} 行等中方定价，定完才能下采购</span>}
          {f.status === 'purchasing' && can(role, 'fob_advance') && <button type="button" className="btn primary" onClick={() => setM('transit')}>已发货（在途）→</button>}
          {f.status === 'in_transit' && can(role, 'fob_advance') && (f.control === 'warehouse'
            ? <button type="button" className="btn primary" onClick={() => setM('receive')}>到货入 FOB 仓 →</button>
            : <button type="button" className="btn primary" onClick={() => act('已到货', `select app.fob_advance($1,'arrived','{}')`, [f.id])}>货到目的国 →</button>)}
          {f.status === 'arrived' && admin && <button type="button" className="btn primary" onClick={() => setM('release')}>放货 →</button>}
          {f.status === 'arrived' && !admin && <span className="small muted">已到货，等中方决定放货</span>}
          {f.status === 'released' && can(role, 'fob_advance') && <button type="button" className="btn primary" onClick={() => setM('ship')}>{f.control === 'warehouse' ? '出库 →' : '已通知物流放货 →'}</button>}
          {!['cancelled', 'closed'].includes(f.status) && can(role, 'fob_pay') && <button type="button" className="btn" onClick={() => setM('pay')}>登记收款</button>}
        </div>
      </div>
      {price && (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
          {[['金额', money(f.total, f.currency)], [`订金 ${N(f.deposit_pct)}%`, money(deposit, f.currency)], ['已收', money(f.paid, f.currency)], ['待收', money(Math.max(due, 0), f.currency)]].map(([l, v], i) => (
            <div key={l} className="kpi" style={{ cursor: 'default' }}><div className="t" style={{ fontSize: 14 }}>{l}</div><BigNum size={22}>{v}</BigNum>
              {i === 1 && N(f.total) > 0 && (N(f.paid) >= deposit ? <Pill tone="green">订金已到</Pill> : <Pill tone="amber">订金还差 {money(deposit - N(f.paid), f.currency)}</Pill>)}</div>))}
        </div>)}
      <div className="card"><Grid id="fob-lines" columns={cols} rows={lines} foot={(rs) => ({ code: `${rs.length} 行`, qty: rs.reduce((a, l) => a + N(l.qty), 0) })} /></div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="card card-b"><h3 style={{ marginTop: 0 }}>收款</h3>
          {pays.length === 0 ? <div className="muted small">还没收款</div> : <Grid id="fob-pays" table="fob_payments" noTools rows={pays} columns={[
            { key: 'on', label: '日期', w: 100, value: (p) => dDate(p.on_date) },
            { key: 'kind', label: '类型', w: 70, value: (p) => ({ deposit: '订金', balance: '尾款', other: '其他' })[p.kind] },
            { key: 'method', label: '方式', w: 80, value: (p) => PAY_METHODS[p.method] },
            { key: 'amount', label: '金额', w: 110, align: 'right', value: (p) => (price ? N(p.amount) : null), render: (p) => (price ? money(p.amount, f.currency) : '—') },
            { key: 'proof', label: '凭证', w: 50, value: (p) => (p.proof ? '有' : ''), render: (p) => (p.proof ? <Thumb src={p.proof} size={26} /> : '') },
          ]} />}
        </div>
        <div className="card card-b"><h3 style={{ marginTop: 0 }}>操作记录</h3>
          <ul className="timeline">{events.map((e) => <li key={e.id}><b>{({ created: '申请', price: '定价', purchasing: '下采购', in_transit: '发货在途', arrived: '到货', received: '入 FOB 仓', payment: '收款', released: '放货', shipped: '出库', cancelled: '取消' })[e.action] || e.action}</b>
            <span className="muted small"> {dt(e.at)}</span>{e.action === 'released' && e.detail?.note && <div className="small">原因：{e.detail.note}</div>}</li>)}</ul>
        </div>
      </div>
      {m === 'purchase' && <SimpleForm title="下采购" fields={[['po_no', '采购单号（金蝶）', true]]} onClose={() => setM(null)} onOk={(v) => act('已下采购', `select app.fob_advance($1,'purchasing',$2)`, [f.id, JSON.stringify(v)])} />}
      {m === 'transit' && <SimpleForm title="已发货（在途）" fields={[['logistics', '物流公司'], ['tracking', '物流单号'], ['eta', '预计到货', false, 'date']]} onClose={() => setM(null)} onOk={(v) => act('已标记在途', `select app.fob_advance($1,'in_transit',$2)`, [f.id, JSON.stringify(v)])} />}
      {m === 'cancel' && <SimpleForm title="取消 FOB 项目" fields={[['note', '原因', true]]} onClose={() => setM(null)} onOk={(v) => act('已取消', `select app.fob_advance($1,'cancelled',$2)`, [f.id, JSON.stringify(v)])} />}
      {m === 'release' && <SimpleForm title={due > 0 ? `放货（还差 ${money(due, f.currency)} 没收）` : '放货'} fields={[['note', due > 0 ? '没收齐也放的原因' : '备注', due > 0]]} onClose={() => setM(null)} onOk={(v) => act('已放货', `select app.fob_release($1,$2)`, [f.id, v.note || ''])} />}
      {m === 'receive' && <ReceiveFob f={f} lines={lines} onClose={() => setM(null)} act={act} />}
      {m === 'ship' && <ShipFob f={f} onClose={() => setM(null)} act={act} />}
      {m === 'pay' && <PayFob f={f} deposit={deposit} due={due} onClose={() => setM(null)} act={act} />}
    </>
  );
}

export function SimpleForm({ title, fields, onClose, onOk }) {
  const [v, setV] = useState(Object.fromEntries(fields.map(([k, , , type]) => [k, type === 'date' ? today() : ''])));
  const ok = fields.every(([k, , req]) => !req || String(v[k] || '').trim());
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!ok} onClick={() => onOk(v)}>确定</button></>}>
      <div className="stack">{fields.map(([k, l, req, type]) => (
        <div key={k} className={`field ${req ? 'req' : ''}`}><label>{l}</label>
          {type === 'date' ? <DatePicker value={v[k]} onChange={(x) => setV({ ...v, [k]: x })} /> : <input className="in" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}</div>))}</div>
    </Modal>
  );
}

function ReceiveFob({ f, lines, onClose, act }) {
  const open = lines.filter((l) => l.qty > l.qty_received);
  const [v, setV] = useState(Object.fromEntries(open.map((l) => [l.id, String(l.qty - l.qty_received)])));
  return (
    <Modal title="到货入 FOB 仓" onClose={onClose} footer={<><span className="small muted">没编码的行先让中方建编码</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn primary" onClick={() => act('已入 FOB 仓', `select app.fob_receive($1,$2)`, [f.id, JSON.stringify(open.filter((l) => l.product_id && Number(v[l.id]) > 0).map((l) => ({ line_id: l.id, qty: Number(v[l.id]) })))])}>入库</button></>}>
      <Grid id="fob-receive" noTools rows={open} columns={[
        { key: 'model', label: '型号', w: 160, value: (l) => l.model, render: (l) => <><ModelLink id={l.product_id} model={l.model} /> {!l.product_id && <Pill tone="amber">没编码</Pill>}</> },
        { key: 'left', label: '还没到', w: 80, value: (l) => l.qty - l.qty_received },
        { key: 'now', label: '这次到了', w: 100, fill: true, value: (l) => v[l.id], edit: (l) => ({ type: 'number', value: v[l.id] ?? '', disabled: !l.product_id, onChange: (x) => setV((o) => ({ ...o, [l.id]: String(x ?? '').replace(/\D/g, '') })) }) },
      ]} />
    </Modal>
  );
}

function ShipFob({ f, onClose, act }) {
  const [proof, setProof] = useState(''); const [note, setNote] = useState('');
  return (
    <Modal title={f.control === 'warehouse' ? '出库（从 FOB 仓扣）' : '通知物流放货'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!proof} onClick={() => act('已出库', `select app.fob_ship($1,$2,$3)`, [f.id, proof, note || null])}>确认</button></>}>
      <div className="stack"><div className="field req"><label>凭证（提货单 / 物流放货截图）</label><PhotoInput value={proof} onChange={setProof} /></div>
        <div className="field"><label>备注</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div></div>
    </Modal>
  );
}

function PayFob({ f, deposit, due, onClose, act }) {
  const [v, setV] = useState({ kind: N(f.paid) < deposit ? 'deposit' : 'balance', amount: String(Math.max(N(f.paid) < deposit ? deposit - N(f.paid) : due, 0)), date: today(), method: 'bank', proof: '', note: '' });
  return (
    <Modal title="登记 FOB 收款" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!(Number(v.amount) > 0)}
        onClick={() => act('已登记收款', `select app.record_fob_payment($1,$2,$3,$4,$5,$6,$7)`, [f.id, v.kind, Number(v.amount), v.date, v.method, v.proof || null, v.note || null])}>保存</button></>}>
      <div className="stack">
        <div className="seg">{[['deposit', '订金'], ['balance', '尾款'], ['other', '其他']].map(([k, l]) => <button type="button" key={k} className={v.kind === k ? 'on' : ''} onClick={() => setV({ ...v, kind: k })}>{l}</button>)}</div>
        <div className="grid2"><div className="field req"><label>金额 {f.currency}</label><input className="in" inputMode="numeric" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value.replace(/[^\d.]/g, '') })} /></div>
          <div className="field"><label>日期</label><DatePicker value={v.date} onChange={(x) => setV({ ...v, date: x })} /></div></div>
        <div className="seg">{Object.entries(PAY_METHODS).map(([k, l]) => <button type="button" key={k} className={v.method === k ? 'on' : ''} onClick={() => setV({ ...v, method: k })}>{l}</button>)}</div>
        <div className="field"><label>凭证</label><PhotoInput value={v.proof} onChange={(x) => setV({ ...v, proof: x })} /></div>
      </div>
    </Modal>
  );
}
