// 销售拜访 (Frank 2026-10-29): 照飞书 Fiche de visite 的字段. 新店现场建潜客 (临时编码), 门店照片必拍.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Modal, PhotoInput, DatePicker, Thumb } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import { ResultPill, FollowDate, VISIT_RESULTS } from '../components/Crm.jsx';
import { CustomerDrawer } from './Customers.jsx';
import { can } from '../lib/domain.js';
import { dDate, dt, today, friendlyError } from '../lib/format.js';

export default function Visits() {
  const { org, role } = useApp();
  const [range, setRange] = useState(() => { const f = new Date(); f.setDate(f.getDate() - 30); return [dDate(f), today()]; });
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  const { data } = useData(() => q(Q.visitsList, [org, range[0], range[1]]), [org, range[0], range[1]]);
  if (!data) return <div className="empty">加载中…</div>;
  const cols = [
    { key: 'at', label: '时间', w: 130, value: (r) => r.at, render: (r) => dt(r.at) },
    { key: 'photo', label: '照片', w: 60, render: (r) => r.photo && <Thumb src={r.photo} size={32} group="visits" label={r.name} /> },
    { key: 'name', label: '客户', w: 180, value: (r) => `${r.code || r.temp_code} ${r.name}`,
      render: (r) => <><span className="mono muted">{r.code || r.temp_code}</span> <b>{r.name}</b>{r.status === 'prospect' && <span className="muted small"> 潜客</span>}</> },
    { key: 'city', label: '城市', w: 90 },
    { key: 'result', label: '结果', w: 90, value: (r) => (VISIT_RESULTS.find((x) => x[0] === r.result) || [])[1], render: (r) => <ResultPill v={r.result} visit /> },
    { key: 'products_wanted', label: '想要的货', w: 160 },
    { key: 'monthly_qty', label: '月用量', w: 70 },
    { key: 'buys_from', label: '现在从哪买', w: 110 },
    { key: 'note', label: '说明', w: 180 },
    { key: 'next_follow_on', label: '下次跟进', w: 100, render: (r) => dDate(r.next_follow_on) },
    { key: 'staff', label: '销售', w: 80 },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Visites commerciales</div><h1>销售拜访</h1>
        <div className="sub">每次上门填一张：门店照片必拍，新店直接建潜客（自动临时编码），转正式和定档位归中方。</div></div>
        {can(role, 'prospect') && <button type="button" className="btn primary" onClick={() => setForm(true)}>＋ 记一次拜访</button>}
      </div>
      <div className="card">
        <Grid id="visits" table="visits" columns={cols} rows={data} onRowClick={(r) => setOpen(r.customer_id)} empty="这段时间没有拜访记录"
          tools={<><DatePicker range value={range} onChange={setRange} /><span className="small muted">{data.length} 次拜访 · {new Set(data.map((r) => r.customer_id)).size} 家店</span></>} />
      </div>
      {form && <VisitModal onClose={() => setForm(false)} />}
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function VisitModal({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [mode, setMode] = useState('new');
  const [cust, setCust] = useState('');
  const [p, setP] = useState({ name: '', phone: '', city: '', market: '', shop_type: '' });
  const [f, setF] = useState({ photo: '', location: '', activity: '', products_wanted: '', monthly_qty: '', buys_from: '', transport: '', nearby_suppliers: '', result: '', note: '', next_follow_on: '' });
  const [busy, setBusy] = useState(false);
  const { data: customers } = useData(() => q(Q.customers, [org]), [org]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const setPv = (k) => (e) => setP((x) => ({ ...x, [k]: e.target ? e.target.value : e }));
  const locate = () => navigator.geolocation?.getCurrentPosition(
    (pos) => setF((x) => ({ ...x, location: `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}` })),
    () => toast('拿不到定位，可以手写地标', 'err'), { timeout: 8000 });
  const okCust = mode === 'old' ? !!cust : p.name.trim() && p.phone.trim();
  const save = async () => {
    setBusy(true);
    try {
      let id = cust;
      if (mode === 'new') {
        [{ id }] = await call(role, `select app.create_prospect($1,$2,$3,$4,$5) as id`, [org, p.name, p.phone, p.city,
          JSON.stringify({ market: p.market || null, shop_type: p.shop_type || null, source: 'visit', location: f.location || null })]);
      }
      await call(role, `select app.log_visit($1,$2,$3)`, [id, f.result, JSON.stringify(f)]);
      toast(mode === 'new' ? `已建潜客并记录拜访：${p.name.toUpperCase()}` : '已记录拜访'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal wide title="记一次拜访 · Fiche de visite" onClose={onClose}
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={busy || !okCust || !f.photo || !f.result} onClick={save}>{busy ? '保存中…' : '保存'}</button></>}>
      <div className="stack">
        <div className="seg">{[['new', '新店（建潜客）'], ['old', '老客户 / 已有潜客']].map(([v, l]) => <button type="button" key={v} className={mode === v ? 'on' : ''} onClick={() => setMode(v)}>{l}</button>)}</div>
        {mode === 'old' ? (
          <div className="field req"><label>客户</label>{customers && <CustomerSelect onlyActive={false} customers={customers.map((c) => ({ ...c, code: c.code || c.temp_code }))} value={cust} onChange={setCust} />}</div>
        ) : (
          <div className="grid2">
            <div className="field req"><label>店名 Nom de la boutique</label><input className="in" value={p.name} onChange={setPv('name')} /></div>
            <div className="field req"><label>电话 Téléphone</label><input className="in" inputMode="tel" value={p.phone} onChange={setPv('phone')} placeholder="+225 …" /></div>
            <div className="field"><label>城市 / 区 Commune</label><input className="in" value={p.city} onChange={setPv('city')} /></div>
            <div className="field"><label>市场 Marché</label><input className="in" value={p.market} onChange={setPv('market')} /></div>
            <div className="field"><label>店铺类型</label><div className="chips">{['Wholesale shop', 'Retail shop', 'Repair shop'].map((v) =>
              <button type="button" key={v} className={`chip ${p.shop_type === v ? 'on' : ''}`} onClick={() => setPv('shop_type')(p.shop_type === v ? '' : v)}>{v}</button>)}</div></div>
          </div>)}
        <div className="grid2">
          <div className="field req"><label>门店照片 Photo</label><PhotoInput value={f.photo} onChange={set('photo')} label="拍门店" invalid={!f.photo} /></div>
          <div className="field"><label>位置 Localisation</label><div className="row" style={{ gap: 6 }}><input className="in" value={f.location} onChange={set('location')} placeholder="地标 / 坐标" /><button type="button" className="btn sm" onClick={locate}>⌖ 定位</button></div></div>
          <div className="field"><label>主营 Activité</label><div className="chips">{['Réparation', 'Vente détail', 'Grossiste', 'Recyclage'].map((v) =>
            <button type="button" key={v} className={`chip ${f.activity === v ? 'on' : ''}`} onClick={() => set('activity')(f.activity === v ? '' : v)}>{v}</button>)}</div></div>
          <div className="field"><label>想要的货 Produits recherchés</label><input className="in" value={f.products_wanted} onChange={set('products_wanted')} placeholder="LCD TECNO / BATTERY …" /></div>
          <div className="field"><label>月用量（件）Quantité / mois</label><input className="in" inputMode="numeric" value={f.monthly_qty} onChange={(e) => set('monthly_qty')(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 120 }} /></div>
          <div className="field"><label>现在从哪买 Fournisseur actuel</label><input className="in" value={f.buys_from} onChange={set('buys_from')} placeholder="Adjamé / 某某批发" /></div>
          <div className="field"><label>怎么拿货 Transport</label><div className="chips">{['Yango moto', 'Taxi', 'Vient lui-même', 'Livreur'].map((v) =>
            <button type="button" key={v} className={`chip ${f.transport === v ? 'on' : ''}`} onClick={() => set('transport')(f.transport === v ? '' : v)}>{v}</button>)}</div></div>
          <div className="field"><label>附近同行 Concurrents proches</label><input className="in" value={f.nearby_suppliers} onChange={set('nearby_suppliers')} /></div>
        </div>
        <div className="field req"><label>结果 Résultat</label><div className="chips">{VISIT_RESULTS.map(([v, l]) =>
          <button type="button" key={v} className={`chip ${f.result === v ? 'on' : ''}`} onClick={() => set('result')(v)}>{l}</button>)}</div></div>
        <div className="field"><label>说明 Remarque</label><input className="in" value={f.note} onChange={set('note')} /></div>
        <div className="field"><label>下次跟进</label><FollowDate value={f.next_follow_on} onChange={set('next_follow_on')} /></div>
      </div>
    </Modal>
  );
}
