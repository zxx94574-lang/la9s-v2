// 客户下单端 / 门店 (Frank: 客户向我们下单, 客户的门店向客户下单, 客户看得到我们有没有货, 我们看得到他们门店的数据).
// 客户老板手机上用: 下单 / 我的订单 / 我的对账 / 我的门店. 门店店员: 向老板下单 / 看自己的单.
// 客户端只显示「有货 / 少量 / 无货 / 在途」, 不显示精确库存, 不显示底价; 价格以热线发的报价单为准.
// 我们这边: 「客户门店」页看所有客户的门店和门店订单.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import { balanceWords } from '../lib/domain.js';
import { money, dDate, dt, friendlyError } from '../lib/format.js';

// 230 / 231 (Frank 11-11): 客户端只有两种 —— 有货 (绿) / 可预订 (不叫无货, 不显示少量和数量); 点了可预订的照样能下, 差的自动记进未满足需求
const BAND = { ok: ['有货 · En stock', 'green'], low: ['有货 · En stock', 'green'], none: ['可预订 · Sur commande', 'amber'] };
const PSTATUS = { quoted: '已收到，等热线确认 · Reçue', hotline_ok: '已确认，排队备货 · Confirmée', picking: '备货中 · En préparation', picked: '备货中 · En préparation',
  ordered: '销售单已出，请确认 · À confirmer', confirmed: '已确认，打包中 · Emballage', reviewed: '已打包，待发货 · Prête', partial: '部分已发货 · Livrée en partie', shipped: '已发货 · Livrée' };
const SOSTATUS = { submitted: ['待老板处理', 'amber'], accepted: ['老板自己发', 'blue'], rejected: ['已拒绝', 'gray'], forwarded: ['已转给 LA&9S', 'blue'], delivered: ['已送达', 'green'] };

function useMe() {
  const { role } = useApp();
  const { data } = useData(async () => (await call(role, `select * from app.portal_me()`))[0] || null, [role]);
  return data;
}

export function PortalShop() {
  const { role, toast, refresh, go } = useApp();
  const me = useMe();
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [cart, setCart] = useState({});
  const [free, setFree] = useState({ model: '', qty: '' });
  const [extra, setExtra] = useState([]);
  const [note, setNote] = useState('');
  const { data } = useData(async () => (me?.customer_id ? q(Q.portalCatalog, [me.customer_id]) : []), [me?.customer_id]);
  const cats = useMemo(() => [...new Map((data || []).map((p) => [p.category_id, p.category])).entries()], [data]);
  if (!me) return <div className="empty">加载中…</div>;
  if (!me.customer_id) return <div className="card card-b">这个账号还没有对上客户。</div>;
  const t = text.trim().toUpperCase();
  const list = (data || []).filter((p) => (!cat || p.category_id === cat) && (!t || p.model.includes(t) || p.code.includes(t) || p.shared_models.some((s) => s.includes(t))))
    .sort((a, b) => ({ ok: 0, low: 1, none: 2 }[a.band] ?? 3) - ({ ok: 0, low: 1, none: 2 }[b.band] ?? 3)).slice(0, 60);   // 230: 有货的排前面, 可预订的沉底
  const byId = Object.fromEntries((data || []).map((p) => [p.id, p]));
  const items = Object.entries(cart).filter(([, n]) => Number(n) > 0);
  const n = items.length + extra.length;
  const submit = async () => {
    const lines = [...items.map(([id, qty]) => ({ product_id: id, model: byId[id].model, category: byId[id].category, qty: Number(qty) })), ...extra];
    try {
      if (role === 'boss') await call(role, `select app.portal_order($1,$2)`, [JSON.stringify(lines), note]);
      else await call(role, `select app.store_order($1,$2)`, [JSON.stringify(lines), note]);
      toast(role === 'boss' ? '已发给 LA&9S，热线会确认数量和价格' : '已发给老板'); setCart({}); setExtra([]); setNote(''); refresh(); go('p/orders');
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="portal">
      <div className="pagehead"><div><div className="eyebrow">{role === 'boss' ? 'Commander à LA&9S' : 'Commander à mon patron'}</div><h1>下单</h1>
        <div className="sub">{role === 'boss' ? '选型号和数量发给 LA&9S，热线会确认数量和价格，价格以报价单为准。' : '向老板下单，老板有货自己发，没货转给 LA&9S。'}</div></div></div>
      <div className="card card-b stack" style={{ gap: 10 }}>
        <input className="in" placeholder="⌕ 型号 / 编码 · Modèle" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="chips"><button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>全部</button>
          {cats.map(([id, name]) => <button type="button" key={id} className={`chip ${cat === id ? 'on' : ''}`} onClick={() => setCat(id)}>{name}</button>)}</div>
      </div>
      <div className="plist">
        {list.map((p) => {
          const [bl, bt] = BAND[p.band];
          return (
            <div key={p.id} className={`pitem ${Number(cart[p.id]) > 0 ? 'on' : ''}`}>
              <div className="grow"><b>{p.model}</b><div className="small muted">{p.category} · {p.code}</div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}><Pill tone={bt}>{bl}</Pill>{p.coming && <Pill tone="blue">在途 · En route</Pill>}</div></div>
              <div className="qty-step">
                <button type="button" onClick={() => setCart((c) => ({ ...c, [p.id]: Math.max(0, Number(c[p.id] || 0) - 5) }))}>−</button>
                <input inputMode="numeric" value={cart[p.id] || ''} placeholder="0" onChange={(e) => setCart((c) => ({ ...c, [p.id]: e.target.value.replace(/\D/g, '') }))} />
                <button type="button" onClick={() => setCart((c) => ({ ...c, [p.id]: Number(c[p.id] || 0) + 5 }))}>＋</button>
              </div>
            </div>);
        })}
        {list.length === 0 && <div className="empty">没找到？在下面写型号 · Pas trouvé ? Écrivez le modèle ci-dessous</div>}
      </div>
      <div className="card card-b row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="small muted">没找到的型号</span>
        <input className="in" placeholder="型号 · Modèle" value={free.model} onChange={(e) => setFree({ ...free, model: e.target.value.toUpperCase() })} style={{ maxWidth: 180 }} />
        <input className="in" inputMode="numeric" placeholder="数量" value={free.qty} onChange={(e) => setFree({ ...free, qty: e.target.value.replace(/\D/g, '') })} style={{ maxWidth: 90 }} />
        <button type="button" className="btn sm" disabled={!free.model || !free.qty} onClick={() => { setExtra((x) => [...x, { model: free.model, category: cats.find(([id]) => id === cat)?.[1] || cats[0]?.[1], qty: Number(free.qty) }]); setFree({ model: '', qty: '' }); }}>加入</button>
        {extra.map((x, i) => <Pill key={i} tone="blue">{x.model} ×{x.qty}</Pill>)}
      </div>
      {n > 0 && (
        <div className="cartbar">
          <span><b>{n}</b> 个型号 · <b>{items.reduce((a, [, v]) => a + Number(v), 0) + extra.reduce((a, x) => a + x.qty, 0)}</b> 件</span>
          <input className="in" placeholder="备注 · Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn primary" onClick={submit}>{role === 'boss' ? '发给 LA&9S' : '发给老板'}</button>
        </div>)}
    </div>
  );
}

export function PortalOrders() {
  const { role, toast, refresh } = useApp();
  const me = useMe();
  const [tab, setTab] = useState('mine');
  const { data } = useData(async () => {
    if (!me?.customer_id) return null;
    const [deals, sorders] = await Promise.all([role === 'boss' ? q(Q.portalOrders, [me.customer_id]) : [], q(Q.storeOrders, [me.customer_id, role === 'clerk' ? me.store_id : null])]);
    return { deals, sorders };
  }, [me?.customer_id, role]);
  if (!data) return <div className="empty">加载中…</div>;
  const decide = async (o, s) => {
    try {
      if (s === 'forward') await call(role, `select app.portal_order($1,$2,$3)`, [JSON.stringify(o.lines), `门店 ${o.store} ${o.order_no}`, o.id]);
      else await call(role, `select app.store_order_decide($1,$2)`, [o.id, s]);
      toast(s === 'forward' ? '已转给 LA&9S' : '已更新'); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const openStore = data.sorders.filter((o) => o.status === 'submitted').length;
  return (
    <div className="portal">
      <div className="pagehead"><div><div className="eyebrow">Mes commandes</div><h1>我的订单</h1></div></div>
      {role === 'boss' && <div className="tabs" style={{ padding: 0 }}><button type="button" className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>向 LA&9S 下的单</button>
        <button type="button" className={tab === 'store' ? 'on' : ''} onClick={() => setTab('store')}>门店的单 {openStore > 0 && <span className="queue-n">{openStore}</span>}</button></div>}
      {role === 'boss' && tab === 'mine' ? (
        <div className="plist">{data.deals.map((d) => (
          <div key={d.id} className="pitem"><div className="grow"><b className="mono">{d.biz_no}</b>{d.source === 'portal' && <Pill tone="blue">手机下单</Pill>}{d.store && <Pill>{d.store}</Pill>}
            <div className="small muted">{dt(d.created_at)} · {d.lines} 个型号 · 要 {d.qty_req} 件{Number(d.qty_shipped) ? ` · 已发 ${d.qty_shipped} 件` : ''}{d.planned_ship_date ? ` · 约定 ${dDate(d.planned_ship_date)} 发货` : ''}</div></div>
            <Pill tone={d.status === 'shipped' ? 'green' : d.status === 'ordered' ? 'amber' : 'blue'}>{PSTATUS[d.status] || d.status}</Pill></div>))}
          {data.deals.length === 0 && <div className="empty">还没有订单</div>}</div>
      ) : (
        <div className="plist">{data.sorders.map((o) => (
          <div key={o.id} className="pitem" style={{ flexWrap: 'wrap' }}><div className="grow"><b className="mono">{o.order_no}</b> <span className="muted small">{o.store} · {dt(o.created_at)}</span>
            <div className="small">{o.lines.map((l) => `${l.model} ×${l.qty}`).join('，')}{o.note ? ` · ${o.note}` : ''}</div>
            {o.biz_no && <div className="small muted">LA&9S 单号 {o.biz_no}</div>}</div>
            <Pill tone={SOSTATUS[o.status][1]}>{SOSTATUS[o.status][0]}</Pill>
            {role === 'boss' && o.status === 'submitted' && <div className="row" style={{ gap: 4, flexBasis: '100%', justifyContent: 'flex-end' }}>
              <button type="button" className="btn sm" onClick={() => decide(o, 'rejected')}>拒绝</button>
              <button type="button" className="btn sm" onClick={() => decide(o, 'accepted')}>我自己发</button>
              <button type="button" className="btn sm primary" onClick={() => decide(o, 'forward')}>转给 LA&9S</button></div>}
            {role === 'boss' && o.status === 'accepted' && <button type="button" className="btn sm" onClick={() => decide(o, 'delivered')}>已送达</button>}
          </div>))}
          {data.sorders.length === 0 && <div className="empty">没有门店订单</div>}</div>)}
    </div>
  );
}

export function PortalBalance() {
  const me = useMe();
  const { data } = useData(async () => {
    if (!me?.customer_id) return null;
    const [[b], open] = await Promise.all([q(Q.customerBalance, [me.customer_id, 'XOF']), q(Q.customerOpenDeals, [me.customer_id, 'XOF'])]);
    return { b, open };
  }, [me?.customer_id]);
  if (!data) return <div className="empty">加载中…</div>;
  const w = balanceWords(data.b.balance);
  return (
    <div className="portal">
      <div className="pagehead"><div><div className="eyebrow">Mon relevé</div><h1>我的对账</h1></div></div>
      <div className="card card-b" style={{ textAlign: 'center' }}>
        <div className="muted small">{data.b.code} {data.b.name}</div>
        <div style={{ fontSize: 30, fontWeight: 800, margin: '8px 0' }} className={`${w.tone}-t2`}>{w.label === '已结清' ? '已结清 · Soldé' : money(w.amount)}</div>
        <div className="small">{w.label === '当前欠款' ? '当前欠款 · Montant dû (XOF)' : w.label === '预付' ? '预付 · Avance (XOF)' : ''}</div>
        <div className="row" style={{ justifyContent: 'center', gap: 18, marginTop: 10 }} >
          <span className="small">累计购买 <b>{money(data.b.total_sold)}</b></span><span className="small">累计已付 <b>{money(data.b.total_paid)}</b></span></div>
      </div>
      <h3>未结清订单 · Commandes non soldées</h3>
      <div className="plist">{data.open.map((d) => (
        <div key={d.deal_id} className="pitem"><div className="grow"><b className="mono">{d.biz_no}</b><div className="small muted">{d.kind === 'opening' ? '期初 · Solde initial' : dDate(d.first_shipped_at)}</div></div><b className="red-t2">{money(d.due)}</b></div>))}
        {data.open.length === 0 && <div className="empty">没有未结清的单</div>}</div>
    </div>
  );
}

export function PortalStores() {
  const me = useMe();
  const { data } = useData(async () => (me?.customer_id ? q(Q.storesHq, [(await q(`select org_id from app.customers where id = $1`, [me.customer_id]))[0].org_id]) : null), [me?.customer_id]);
  if (!data) return <div className="empty">加载中…</div>;
  const mine = data.filter((s) => s.customer_id === me.customer_id);
  return (
    <div className="portal">
      <div className="pagehead"><div><div className="eyebrow">Mes magasins</div><h1>我的门店</h1><div className="sub">要开新门店账号找 LA&9S 热线。</div></div></div>
      <div className="plist">{mine.map((s) => (
        <div key={s.id} className="pitem"><div className="grow"><b>{s.name}</b><div className="small muted">{s.city} · {s.manager}</div></div>
          <span className="small">{s.orders} 张单{Number(s.open_orders) ? ` · ${s.open_orders} 张待处理` : ''}</span></div>))}</div>
    </div>
  );
}

// 我们这边: 所有客户的门店 + 门店订单 (Frank: 我们能看到他们门店的数据)
export function StoresHq() {
  const { org, role } = useApp();
  const [nw, setNw] = useState(false);
  const { data } = useData(async () => {
    const [stores, orders] = await Promise.all([q(Q.storesHq, [org]), q(Q.storeOrders, [null, null])]);
    return { stores, orders };
  }, [org]);
  if (!data) return <div className="empty">加载中…</div>;
  const sCols = [
    { key: 'customer_name', label: '客户', w: 150, value: (s) => `${s.customer_code} ${s.customer_name}`, render: (s) => <><span className="mono muted">{s.customer_code}</span> <b>{s.customer_name}</b></> },
    { key: 'name', label: '门店', w: 150 }, { key: 'city', label: '城市', w: 100 }, { key: 'manager', label: '店长', w: 110 },
    { key: 'orders', label: '门店单', w: 80, value: (s) => Number(s.orders) }, { key: 'open_orders', label: '待老板处理', w: 100, value: (s) => Number(s.open_orders) },
    { key: 'last_order', label: '最近下单', w: 110, render: (s) => dDate(s.last_order) },
    { key: 'org_id', label: '账号', w: 90, value: (s) => (s.org_id ? '已开通' : '未开通'), render: (s) => (s.org_id ? <Pill tone="green">已开通</Pill> : <Pill>未开通</Pill>) },
  ];
  const oCols = [
    { key: 'order_no', label: '门店单号', w: 130, render: (o) => <span className="mono">{o.order_no}</span> },
    { key: 'customer_name', label: '客户', w: 130 }, { key: 'store', label: '门店', w: 130 },
    { key: 'created_at', label: '时间', w: 130, render: (o) => dt(o.created_at) },
    { key: 'lines', label: '要的货', w: 260, value: (o) => o.lines.map((l) => `${l.model} ×${l.qty}`).join('，') },
    { key: 'status', label: '状态', w: 110, value: (o) => SOSTATUS[o.status][0], render: (o) => <Pill tone={SOSTATUS[o.status][1]}>{SOSTATUS[o.status][0]}</Pill> },
    { key: 'biz_no', label: '转成我们的单', w: 140, render: (o) => o.biz_no && <a href={`#/deal/${o.deal_id}`} className="mono">{o.biz_no}</a> },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Magasins des clients</div><h1>客户门店</h1>
        <div className="sub">大客户的门店向客户老板下单，老板自己发或者转给我们。这里看所有门店和门店订单，用来判断客户的真实销量。</div></div>
        {role === 'admin' && <button type="button" className="btn primary" onClick={() => setNw(true)}>＋ 给客户开门店</button>}
      </div>
      <div className="card" style={{ marginBottom: 12 }}><Grid id="stores-hq" table="stores" columns={sCols} rows={data.stores} empty="还没有客户门店" /></div>
      <div className="card"><div className="card-b" style={{ paddingBottom: 0 }}><b>门店订单</b></div><Grid id="store-orders" columns={oCols} rows={data.orders} empty="还没有门店订单" /></div>
      {nw && <NewStore onClose={() => setNw(false)} />}
    </>
  );
}

function NewStore({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data: customers } = useData(() => q(Q.customers, [org]), [org]);
  const [f, setF] = useState({ cust: '', name: '', city: '', manager: '' });
  const go = async () => { try { await call(role, `select app.create_store($1,$2,$3,$4)`, [f.cust, f.name, f.city, f.manager]); toast('门店已建；登录账号上线时一起开'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="给客户开门店" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!f.cust || !f.name.trim()} onClick={go}>建门店</button></>}>
      <div className="stack">
        <div className="field req"><label>客户</label>{customers && <CustomerSelect customers={customers} value={f.cust} onChange={(v) => setF({ ...f, cust: v })} />}</div>
        <div className="grid2">{[['name', '门店名 *'], ['city', '城市'], ['manager', '店长']].map(([k, l]) => <div key={k} className="field"><label>{l}</label><input className="in" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>)}</div>
      </div>
    </Modal>
  );
}
