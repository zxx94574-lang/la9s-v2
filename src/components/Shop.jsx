// 0077 客户店里的收银 + 店里库存 (客户老板 / 店员手机上用) + 我们中方的「客户账号」页
// 收银越简单越好: 点货 → 数量 → (价格默认是他定的零售价) → 收钱 → 一单就完, 进今天的流水. 以后接扫码枪.
// 他店里的账和我们的应收 / 资金账户完全分开; 他看不到我们的价格和成本.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Pill, Info, Modal, MoneyIn, Drawer, usePeriod, PeriodBar } from './ui.jsx';
import Grid from './Grid.jsx';
import { OptChoice, optName } from './Opts.jsx';
import { CustLink } from './Archives.jsx';
import { money, qty, dt, friendlyError } from '../lib/format.js';

const PAYS = [['cash', '现金 · Espèces'], ['wave', 'Wave'], ['orange', 'Orange Money'], ['other', '其他']];
const QUALITIES = ['LA&9S', '其他 · A 货', '其他 · 普通'];
const todayIso = () => new Date().toISOString().slice(0, 10);

function useShop(tick) {
  const { role } = useApp();
  return useData(async () => {
    const [me] = await call(role, `select * from app.portal_me()`);
    if (!me?.customer_id) return { me: null };
    const [items, sales] = await Promise.all([
      q(`select * from app.shop_items where customer_id = $1 order by model, quality`, [me.customer_id]),
      q(`select s.*, (select json_agg(json_build_object('model', i.model, 'quality', i.quality, 'qty', l.qty, 'price', l.price)) from app.shop_sale_lines l join app.shop_items i on i.id = l.item_id where l.sale_id = s.id) lines
         from app.shop_sales s where s.customer_id = $1 and s.sold_at > now() - interval '31 days' order by s.sold_at desc`, [me.customer_id])]);
    return { me, items, sales };
  }, [role, tick]);
}

// ── 收银 ──
export function ShopPos() {
  const { role, toast, tick, refresh } = useApp();
  const { data } = useShop(tick);
  const [text, setText] = useState('');
  const [cart, setCart] = useState([]);     // [{item, qty, price}]
  const [pay, setPay] = useState('cash');
  const [buyer, setBuyer] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const shown = useMemo(() => { const items = data?.items || []; const t = text.trim().toUpperCase(); return items.filter((i) => i.qty > 0 && (!t || `${i.model} ${i.category} ${i.quality}`.toUpperCase().includes(t))).slice(0, 40); }, [data, text]);
  if (!data) return <div className="empty">加载中…</div>;
  if (!data.me) return <div className="empty">客户账号才能用收银。</div>;
  const today = data.sales.filter((s) => !s.voided_at && new Date(s.sold_at).toISOString().slice(0, 10) === todayIso());
  const todayTotal = today.reduce((a, s) => a + Number(s.total), 0);
  const total = cart.reduce((a, c) => a + c.qty * (Number(c.price) || 0), 0);
  const add = (i) => { setDone(null); setCart((cs) => { const ex = cs.find((c) => c.item.id === i.id); return ex ? cs.map((c) => (c.item.id === i.id ? { ...c, qty: Math.min(c.qty + 1, i.qty) } : c)) : [...cs, { item: i, qty: 1, price: i.price ?? '' }]; }); };
  const setLine = (id, k, v) => setCart((cs) => cs.map((c) => (c.item.id === id ? { ...c, [k]: v } : c)).filter((c) => k !== 'qty' || c.qty > 0));
  const sell = async () => {
    if (!cart.length) return toast('还没选货', 'err');
    const noPrice = cart.find((c) => !(Number(c.price) >= 0) || c.price === '');
    if (noPrice) return toast(`${noPrice.item.model} 还没价格：填上，或让老板在「店里库存」定零售价`, 'err');
    setBusy(true);
    try {
      const no = (await call(role, `select app.shop_sell($1,$2,$3) as n`, [JSON.stringify(cart.map((c) => ({ item_id: c.item.id, qty: c.qty, price: Number(c.price) }))), pay, buyer || null]))[0].n;
      setDone({ no, total }); setCart([]); setBuyer(''); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="pos">
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <div className="kpi"><div className="k">今天收了 · Aujourd'hui</div><div className="v">{money(todayTotal)} <small>XOF</small></div></div>
        <div className="kpi"><div className="k">今天卖了几单</div><div className="v">{today.length}</div></div>
      </div>
      {done && <div className="banner ok" style={{ margin: '10px 0' }}><b>{done.no}</b> 收了 {money(done.total)} XOF，这一单完了。</div>}
      <div className="pos-grid">
        <div className="card">
          <div className="card-h"><h2>选货</h2><Info>点一下加 1 个，再点再加。只列店里还有库存的货。以后接扫码枪，扫一下就加进来。</Info></div>
          <div className="card-b"><input className="in" placeholder="⌕ 型号 / 种类" value={text} onChange={(e) => setText(e.target.value)} /></div>
          <div className="pos-items">
            {shown.map((i) => (
              <button type="button" key={i.id} className="pos-item" onClick={() => add(i)}>
                <b>{i.model}</b><span className="small muted">{i.category} · {i.quality}</span>
                <span className="row between"><span className="small">剩 {qty(i.qty)}</span><b>{i.price != null ? money(i.price) : <span className="pill amber">没定价</span>}</b></span>
              </button>))}
            {!shown.length && <div className="empty">没有找到。货不在店里库存的，先到「店里库存」补录。</div>}
          </div>
          {cart.length > 0 && <div className="pos-sticky show-m"><span>{cart.reduce((a, c) => a + c.qty, 0)} 件 · <b>{money(total)} XOF</b></span>
            <button type="button" className="btn primary" onClick={() => document.getElementById('pos-cart')?.scrollIntoView({ behavior: 'smooth' })}>去收钱 ↓</button></div>}
        </div>
        <div className="card" id="pos-cart">
          <div className="card-h"><h2>这一单</h2>{cart.length > 0 && <Pill tone="blue">{cart.length} 种</Pill>}</div>
          {cart.map((c) => (
            <div key={c.item.id} className="pos-line">
              <span className="grow"><b>{c.item.model}</b> <span className="small muted">{c.item.quality}</span></span>
              <button type="button" className="btn sm" onClick={() => setLine(c.item.id, 'qty', c.qty - 1)}>−</button>
              <b style={{ minWidth: 28, textAlign: 'center' }}>{c.qty}</b>
              <button type="button" className="btn sm" onClick={() => setLine(c.item.id, 'qty', Math.min(c.qty + 1, c.item.qty))}>＋</button>
              <MoneyIn className="in" style={{ width: 96 }} value={c.price} onChange={(e) => setLine(c.item.id, 'price', e.target.value)} />
            </div>))}
          {!cart.length && <div className="empty">点左边的货加进来</div>}
          <div className="card-b" style={{ borderTop: '1px solid var(--line-2)' }}>
            <div className="field"><label>怎么付的</label><OptChoice optKey="shop_pay" title="收银付款方式" value={pay} onChange={setPay} options={PAYS} /></div>
            <div className="field"><label>客人（可不填）</label><input className="in" value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="零售客人不用填；批发客户写名字" /></div>
            <div className="row between" style={{ marginTop: 10 }}><span>合计</span><b style={{ fontSize: 22 }}>{money(total)} XOF</b></div>
            <button type="button" className="btn primary lg" style={{ width: '100%', marginTop: 10 }} disabled={busy || !cart.length} onClick={sell}>{busy ? '…' : '收钱 · Encaisser'}</button>
          </div>
        </div>
      </div>
      <ShopSales sales={data.sales} boss={data.me.role === 'boss'} />
    </div>);
}

function ShopSales({ sales, boss }) {
  const { role, toast, refresh } = useApp();
  const [voiding, setVoiding] = useState(null);
  const [why, setWhy] = useState('');
  return (<>
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-h"><h2>最近的单</h2></div>
      <Grid id="shop-sales" rows={sales} empty="还没卖过" rowActions={boss ? [{ label: '撤销这一单', tone: 'soft-red', when: (s) => !s.voided_at, run: (s) => setVoiding(s) }] : undefined} columns={[
        { key: 'sale_no', label: '单号', w: 130 },
        { key: 'sold_at', label: '时间', w: 130, render: (s) => dt(s.sold_at) },
        { key: 'lines', label: '卖了什么', w: 260, render: (s) => (s.lines || []).map((l) => `${l.model}×${l.qty}`).join('、') },
        { key: 'total', label: '金额', w: 110, num: true, render: (s) => (s.voided_at ? <span className="pill gray">已撤销</span> : money(s.total)) },
        { key: 'pay_method', label: '付款', w: 100, render: (s) => optName('shop_pay', s.pay_method, Object.fromEntries(PAYS)) },
        { key: 'buyer', label: '客人', w: 120, render: (s) => s.buyer || <span className="muted">零售客人</span> },
      ]} />
    </div>
    {voiding && <Modal title={`撤销 ${voiding.sale_no}`} risk="yellow" onClose={() => setVoiding(null)} footer={<><button type="button" className="btn" onClick={() => setVoiding(null)}>取消</button>
      <button type="button" className="btn primary" disabled={!why.trim()} onClick={async () => { try { await call(role, `select app.shop_void_sale($1,$2)`, [voiding.id, why]); toast('已撤销，货回到库存'); setVoiding(null); setWhy(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }}>撤销</button></>}>
      <div className="field req"><label>为什么撤销</label><input className="in" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="客人退回 / 打错了…" /></div>
    </Modal>}
  </>);
}

// ── 店里库存 ──
export function ShopStock() {
  const { role, toast, tick, refresh } = useApp();
  const { data } = useShop(tick);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ model: '', category: '', quality: QUALITIES[1], qty: '', price: '' });
  if (!data) return <div className="empty">加载中…</div>;
  if (!data.me) return <div className="empty">客户账号才能看店里库存。</div>;
  const boss = data.me.role === 'boss';
  const save = async () => {
    try { await call(role, `select app.shop_stock_in($1,$2,$3,$4,$5)`, [f.model, f.category, f.quality, Number(f.qty), f.price === '' ? null : Number(f.price)]); toast('已入库'); setAdding(false); setF({ model: '', category: '', quality: QUALITIES[1], qty: '', price: '' }); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const pcs = data.items.reduce((a, i) => a + i.qty, 0);
  return (<>
    <div className="pagehead"><h1>店里库存</h1><Info>从 LA&9S 拿的货，我们出库那一刻自动加进来（标 LA&9S）。别家进的货点「＋ 别家的货进店」自己录，选品质：同一个型号、同一个品质算一份库存，品质不同分开算，各有各的零售价。</Info><span className="grow" />
      <button type="button" className="btn primary" onClick={() => setAdding(true)}>＋ 别家的货进店</button></div>
    <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
      <div className="kpi"><div className="k">货的种类</div><div className="v">{data.items.filter((i) => i.qty > 0).length}</div></div>
      <div className="kpi"><div className="k">一共多少片</div><div className="v">{qty(pcs)}</div></div>
      <div className="kpi"><div className="k">其中 LA&9S 的</div><div className="v">{qty(data.items.filter((i) => i.quality === 'LA&9S').reduce((a, i) => a + i.qty, 0))}</div></div>
    </div>
    <div className="card"><Grid id="shop-items" rows={data.items} empty="店里还没有货" columns={[
      { key: 'model', label: '型号', w: 140 },
      { key: 'category', label: '种类', w: 110 },
      { key: 'quality', label: '来源 / 品质', w: 130, render: (i) => <span className={`pill ${i.quality === 'LA&9S' ? 'blue' : 'gray'}`}>{i.quality}</span> },
      { key: 'qty', label: '库存', w: 90, num: true },
      { key: 'price', label: '零售价', w: 110, num: true, edit: boss ? (i) => ({ type: 'number', value: i.price ?? '', onChange: async (v, meta) => { try { await call(role, `select app.shop_set_price($1,$2)`, [i.id, Number(v)]); if (!meta?.batch || meta.last) toast('已保存'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } } }) : undefined,
        render: (i) => (i.price != null ? money(i.price) : <span className="pill amber">没定价</span>) },
    ]} /></div>
    {adding && <Modal title="别家的货进店" onClose={() => setAdding(false)} footer={<><button type="button" className="btn" onClick={() => setAdding(false)}>取消</button><button type="button" className="btn primary" onClick={save}>入库</button></>}>
      <div className="field req"><label>型号</label><input className="in" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value.toUpperCase() })} /></div>
      <div className="field"><label>种类</label><input className="in" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="屏幕 / 电池…" /></div>
      <div className="field req"><label>来源 / 品质</label><OptChoice optKey="shop_quality" title="店里货的品质" value={f.quality} onChange={(v) => setF({ ...f, quality: v })} options={QUALITIES.filter((x) => x !== 'LA&9S')} /></div>
      <div className="field req"><label>数量</label><MoneyIn className="in" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
      {boss && <div className="field"><label>零售价（XOF）</label><MoneyIn className="in" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></div>}
    </Modal>}
  </>);
}

// ── 我们中方: 客户账号 ──
export function CustomerAccounts() {
  const { org, role, tick } = useApp();
  const [open, setOpen] = useState(null);
  const { data } = useData(() => call(role, `select * from app.customer_accounts_overview($1)`, [org]), [org, role, tick]);
  if (role !== 'admin') return <div className="empty">只有中方能看。</div>;
  if (!data) return <div className="empty">加载中…</div>;
  const S = (k) => data.reduce((a, r) => a + Number(r[k] || 0), 0);
  return (<>
    <div className="pagehead"><h1>客户账号</h1><Info>开了下单账号的客户，每个一行：账号状态、他能看什么、名下几个店；左边是我们卖给他的（30 天），右边是他店里自己的收银和库存。点一行看明细。他店里的账和我们的应收完全分开。</Info></div>
    <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
      <div className="kpi"><div className="k">开了账号的客户</div><div className="v">{data.length}</div></div>
      <div className="kpi"><div className="k">30 天我们卖给他们</div><div className="v">{money(S('our_30d'))}</div></div>
      <div className="kpi"><div className="k">他们店里今天收银</div><div className="v">{money(S('pos_today'))}</div></div>
      <div className="kpi"><div className="k">他们店里 30 天收银</div><div className="v">{money(S('pos_30d'))}</div></div>
    </div>
    <div className="card"><Grid id="cust-accounts" rows={data} rowKey={(r) => r.customer_id} onRowClick={(r) => setOpen(r)} empty="还没有客户开账号（客户档案里给客户开下单账号）" columns={[
      { key: 'name', label: '客户', w: 150, render: (r) => <CustLink id={r.customer_id} name={r.name} /> },
      { key: 'account_status', label: '账号', w: 90, render: (r) => (r.account_status === 'frozen' ? <span className="pill red">冻结</span> : r.account_status ? <span className="pill green">正常</span> : <span className="pill gray">门店账号</span>) },
      { key: 'last_login_at', label: '最近登录', w: 120, render: (r) => (r.last_login_at ? dt(r.last_login_at) : <span className="muted">—</span>) },
      { key: 'portal_opts', label: '能看什么', w: 150, render: (r) => ['stock', 'price', 'inquiry'].filter((k) => r.portal_opts?.[k] !== false).map((k) => ({ stock: '库存', price: '价格', inquiry: '询单' }[k])).join(' · ') || '—' },
      { key: 'stores', label: '店', w: 60, num: true },
      { key: 'our_30d', label: '30 天拿货', w: 120, num: true, sum: true, render: (r) => money(r.our_30d) },
      { key: 'balance', label: '欠我们', w: 110, num: true, sum: true, render: (r) => money(r.balance) },
      { key: 'pos_today', label: '店里今天收', w: 110, num: true, sum: true, render: (r) => money(r.pos_today) },
      { key: 'pos_30d', label: '店里 30 天收', w: 120, num: true, sum: true, render: (r) => money(r.pos_30d) },
      { key: 'shop_pcs', label: '店里库存（片）', w: 120, num: true, render: (r) => <>{qty(r.shop_pcs)} <span className="small muted">LA&9S {qty(r.shop_la9s_pcs)}</span></> },
    ]} /></div>
    {open && <AccountDrawer r={open} onClose={() => setOpen(null)} />}
  </>);
}

function AccountDrawer({ r, onClose }) {
  const { role, tick } = useApp();
  const { data } = useData(async () => {
    const [items, sales, stores] = await Promise.all([
      q(`select * from app.shop_items where customer_id = $1 order by qty desc`, [r.customer_id]),
      q(`select s.*, st.name as store from app.shop_sales s left join app.portal_stores st on st.id = s.store_id where s.customer_id = $1 order by s.sold_at desc limit 200`, [r.customer_id]),
      q(`select * from app.portal_stores where customer_id = $1 order by name`, [r.customer_id])]);
    return { items, sales, stores };
  }, [r.customer_id, role, tick]);
  return (
    <Drawer title={`${r.code || ''} · ${r.name}`} onClose={onClose}>
      {!data ? <div className="empty">加载中…</div> : <>
        <div className="card"><div className="card-h"><h2>名下的店</h2><Pill>{data.stores.length}</Pill></div>
          {data.stores.map((s) => <div key={s.id} className="orow" style={{ gridTemplateColumns: '1fr auto' }}><b>{s.name}</b><span className="small muted">{s.city} · {s.manager || '—'}</span></div>)}
          {!data.stores.length && <div className="empty">没有门店</div>}</div>
        <div className="card"><div className="card-h"><h2>店里库存</h2></div>
          <Grid id="acc-items" rows={data.items} noTools columns={[{ key: 'model', label: '型号', w: 120 }, { key: 'quality', label: '品质', w: 110 }, { key: 'qty', label: '库存', w: 80, num: true }, { key: 'price', label: '他的零售价', w: 110, num: true, render: (i) => (i.price != null ? money(i.price) : '—') }]} /></div>
        <div className="card"><div className="card-h"><h2>店里收银</h2></div>
          <Grid id="acc-sales" rows={data.sales} noTools columns={[{ key: 'sale_no', label: '单号', w: 120 }, { key: 'sold_at', label: '时间', w: 120, render: (s) => dt(s.sold_at) }, { key: 'store', label: '店', w: 100 },
            { key: 'total', label: '金额', w: 100, num: true, render: (s) => (s.voided_at ? <span className="pill gray">已撤销</span> : money(s.total)) }, { key: 'buyer', label: '客人', w: 110, render: (s) => s.buyer || '零售' }]} /></div>
      </>}
    </Drawer>);
}
