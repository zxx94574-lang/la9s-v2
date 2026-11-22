// 0078 想要 + 到货分配: 客户只登记想要 (型号 + 大概多少), 有效期默认 14 天; 货到了热线先问「还要吗」, 还要的才进分配; 中方填每人分多少 → 热线电话名单
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Info, Modal, MoneyIn } from './ui.jsx';
import Grid from './Grid.jsx';
import CustomerSelect from './CustomerSelect.jsx';
import { ModelLink, CustLink } from './Archives.jsx';
import { RuleGear } from './Rules.jsx';
import { qty, dDate, friendlyError } from '../lib/format.js';

const ST = { open: ['还没问', 'gray'], yes: ['还要', 'green'], no_answer: ['联系不上', 'amber'] };
const SRC = { manual: '登记的', order_short: '下单没供够', inquiry: '询单', call: '回访' };

export function WantsBoard() {
  const { org, role, toast, tick, refresh } = useApp();
  const admin = role === 'admin';
  const staff = ['hotline', 'sales', 'manager', 'sales_manager'].includes(role);
  const [adding, setAdding] = useState(false);
  const [check, setCheck] = useState(null);
  const [alloc, setAlloc] = useState(false);
  const { data } = useData(async () => {
    await call(role, `select app.sync_wants($1)`, [org]).catch(() => {});
    const [open, lost] = await Promise.all([q(`select * from app.v_open_wants where org_id = $1 order by (avail > 0) desc, model, created_at`, [org]), q(`select * from app.v_want_lost where org_id = $1 order by checked_at desc`, [org])]);
    return { open, lost };
  }, [org, role, tick]);
  if (!data) return <div className="empty">加载中…</div>;
  const arrived = data.open.filter((w) => Number(w.avail) > 0);
  const yes = data.open.filter((w) => w.status === 'yes');
  const act = async (sql, p, msg) => { try { await call(role, sql, p); toast(msg); refresh(); return true; } catch (e) { toast(friendlyError(e), 'err'); return false; } };
  return (<>
    <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
      <div className="kpi"><div className="k">开着的想要</div><div className="v">{data.open.length}</div></div>
      <div className="kpi"><div className="k">现在有货了（要问还要吗）</div><div className="v">{arrived.filter((w) => w.status !== 'yes').length}</div></div>
      <div className="kpi"><div className="k">确认还要、等分配</div><div className="v">{yes.length}</div></div>
      <div className="kpi"><div className="k">不要了（找别人买了）</div><div className="v">{data.lost.length}</div></div>
    </div>
    <div className="card">
      <div className="card-h"><h2>想要</h2><Info>客户要的货现在没有，就登记一条想要（型号 + 大概多少），不是预订、不占货。登记超过有效期还没到货就自动失效，不再算进备货。下单时没供够的部分也会自动变成想要。货到了：先问还要吗，还要的中方再分。</Info>
        <RuleGear ids={['want.days']} anchor="wants" /><span className="grow" />
        {staff && <button type="button" className="btn" onClick={() => setAdding(true)}>＋ 登记想要</button>}
        {admin && <button type="button" className="btn primary" disabled={!yes.length} onClick={() => setAlloc(true)}>分配到货（{yes.length}）</button>}</div>
      <Grid id="wants-open" rows={data.open} empty="没有开着的想要"
        rowActions={staff ? [{ label: '问过了 → 记结果', when: (w) => w.status !== 'yes' || true, run: (w) => setCheck(w) }] : undefined}
        columns={[
          { key: 'customer_name', label: '客户', w: 150, render: (w) => <CustLink id={w.customer_id} name={w.customer_name} /> },
          { key: 'model', label: '型号', w: 130, render: (w) => (w.product_id ? <ModelLink id={w.product_id} model={w.model} /> : <>{w.model} <span className="pill amber">没编码</span></>) },
          { key: 'qty', label: '大概要', w: 80, num: true },
          { key: 'avail', label: '现在可售', w: 90, num: true, render: (w) => (Number(w.avail) > 0 ? <span className="pill green">{qty(w.avail)}</span> : <span className="muted">0</span>) },
          { key: 'status', label: '问了没', w: 90, render: (w) => <span className={`pill ${ST[w.status]?.[1]}`}>{ST[w.status]?.[0]}</span> },
          { key: 'days_left', label: '还剩', w: 80, render: (w) => (w.days_left < 0 ? <span className="pill gray">过期</span> : <span className={`pill ${w.days_left <= 3 ? 'amber' : 'gray'}`}>{w.days_left} 天</span>) },
          { key: 'source', label: '从哪来', w: 100, render: (w) => SRC[w.source] || w.source },
          { key: 'created_at', label: '登记', w: 100, render: (w) => dDate(w.created_at) },
          { key: 'note', label: '备注', w: 160 },
        ]} />
    </div>
    <div className="card">
      <div className="card-h"><h2>不要了（缺货丢单）</h2><Info>货到了打电话，客户说不要了——多半是等不及找了别人。这里能看出哪些型号缺货让我们丢了单。</Info></div>
      <Grid id="wants-lost" rows={data.lost} empty="还没有" columns={[
        { key: 'checked_at', label: '问的时间', w: 110, render: (w) => dDate(w.checked_at) },
        { key: 'customer_name', label: '客户', w: 150, render: (w) => <CustLink id={w.customer_id} name={w.customer_name} /> },
        { key: 'model', label: '型号', w: 130 }, { key: 'qty', label: '当时要', w: 80, num: true }, { key: 'check_note', label: '客户怎么说', w: 220 }]} />
    </div>
    {adding && <AddWant onClose={() => setAdding(false)} />}
    {check && <CheckWant w={check} onClose={() => setCheck(null)} onOk={(r, note) => act(`select app.want_check($1,$2,$3)`, [check.id, r, note || null], '已记下').then((ok) => ok && setCheck(null))} />}
    {alloc && <Allocate rows={yes} onClose={() => setAlloc(false)} onOk={(rows, note) => act(`select app.allocate_wants($1,$2,$3)`, [org, JSON.stringify(rows), note || null], '已分配，热线电话名单已生成').then((ok) => ok && setAlloc(false))} />}
  </>);
}

function AddWant({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data } = useData(async () => { const [customers, catalog] = await Promise.all([q(Q.customers, [org]), q(Q.catalog, [org])]); return { customers, catalog }; }, [org]);
  const [c, setC] = useState(''); const [pt, setPt] = useState(''); const [pid, setPid] = useState(''); const [n, setN] = useState(''); const [note, setNote] = useState('');
  if (!data) return null;
  const hits = pt.trim() ? data.catalog.filter((p) => `${p.code} ${p.model} ${p.category}`.toUpperCase().includes(pt.trim().toUpperCase())).slice(0, 8) : [];
  const save = async () => {
    try { await call(role, `select app.add_want($1,$2,$3,$4,$5)`, [c, pid || null, pid ? null : pt, Number(n), note || null]); toast('已登记想要'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="登记想要" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!c || !(pid || pt.trim()) || !(Number(n) > 0)} onClick={save}>登记</button></>}>
      <div className="field req"><label>客户</label><CustomerSelect customers={data.customers} value={c} onChange={setC} /></div>
      <div className="field req"><label>型号</label><input className="in" value={pt} onChange={(e) => { setPt(e.target.value); setPid(''); }} placeholder="编码 / 型号；没编码的直接写" />
        {hits.length > 0 && !pid && <div className="sugg">{hits.map((p) => <button type="button" key={p.id} className="sugg-i" onClick={() => { setPid(p.id); setPt(`${p.category} ${p.model}`); }}>{p.category} · <b>{p.model}</b> <span className="muted small">{p.code}</span></button>)}</div>}</div>
      <div className="field req"><label>大概要多少</label><MoneyIn className="in" value={n} onChange={(e) => setN(e.target.value)} /></div>
      <div className="field"><label>备注</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>);
}

function CheckWant({ w, onClose, onOk }) {
  const [r, setR] = useState(''); const [note, setNote] = useState('');
  return (
    <Modal title={`${w.customer_name} · ${w.model} 还要吗`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!r || (r === 'no' && !note.trim())} onClick={() => onOk(r, note)}>记下</button></>}>
      <div className="seg" style={{ marginBottom: 10 }}>{[['yes', '还要'], ['no', '不要了'], ['no_answer', '联系不上']].map(([k, l]) => <button type="button" key={k} className={r === k ? 'on' : ''} onClick={() => setR(k)}>{l}</button>)}</div>
      <div className={`field ${r === 'no' ? 'req' : ''}`}><label>{r === 'no' ? '为什么不要了' : '备注'}</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder={r === 'no' ? '找别人买了 / 不做这个型号了…' : ''} /></div>
    </Modal>);
}

function Allocate({ rows, onClose, onOk }) {
  const [v, setV] = useState(() => Object.fromEntries(rows.map((w) => [w.id, String(Math.min(w.qty, Number(w.avail) || 0) || '')])));
  const [note, setNote] = useState('');
  const by = {}; for (const w of rows) (by[w.model] ||= []).push(w);
  return (
    <Modal wide title="分配到货" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn primary" onClick={() => onOk(rows.filter((w) => Number(v[w.id]) > 0).map((w) => ({ want_id: w.id, qty: Number(v[w.id]) })), note)}>确认分配，生成电话名单</button></>}>
      <div className="hint" style={{ marginBottom: 8 }}>只列热线已经问过「还要」的。按型号看：现在可售多少、每个客户分多少。分完自动生成一张给热线的电话名单（告诉客户给他留了多少）。分配不占货，客户来下单时照常走流程。</div>
      {Object.entries(by).map(([model, ws]) => {
        const left = Number(ws[0].avail) - ws.reduce((a, w) => a + (Number(v[w.id]) || 0), 0);
        return (<div key={model} className="card" style={{ marginBottom: 8 }}>
          <div className="card-h"><h2>{model}</h2><span className="small muted">可售 {qty(ws[0].avail)}</span><span className="grow" /><Pill tone={left < 0 ? 'red' : 'gray'}>{left < 0 ? `超了 ${qty(-left)}` : `还剩 ${qty(left)}`}</Pill></div>
          {ws.map((w) => <div key={w.id} className="orow" style={{ gridTemplateColumns: '1fr auto auto' }}><span><b>{w.customer_name}</b> <span className="small muted">要 {qty(w.qty)}</span></span><span className="small">分</span>
            <MoneyIn className="in" style={{ width: 90 }} value={v[w.id]} onChange={(e) => setV({ ...v, [w.id]: e.target.value })} /></div>)}
        </div>);
      })}
      <div className="field"><label>备注</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>);
}

// 热线待办: 现在有货了的想要 (要问还要吗)
export function WantsTodo() {
  const { org, role, tick, go } = useApp();
  const { data } = useData(() => (['hotline', 'sales', 'manager', 'sales_manager', 'admin'].includes(role) ? q(`select count(*) filter (where avail > 0 and status <> 'yes')::int n from app.v_open_wants where org_id = $1`, [org]) : Promise.resolve([{ n: 0 }])), [org, role, tick]);
  const n = data?.[0]?.n || 0;
  if (!n) return null;
  return <div className="row between todo-row" onClick={() => go('unmet')}><b>{n} 条想要现在有货了，打电话问还要吗</b><span className="muted">›</span></div>;
}
