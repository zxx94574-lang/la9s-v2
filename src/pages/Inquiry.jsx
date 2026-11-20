// 询单 (Frank 11-18 391–394, 方案 docs/整合方案-接单询单账号.md): 没有定价权的人的统一前门.
// 游客 / 客户账号 / 外跑销售 → 询单 (IQ-年月日-序号, 不带价) → 中方看一眼定价、转成报价 → 通知建单的人 → 后面流程不变.
// 这个页面: 员工建询单 (销售只列自己名下的客户) + 询单列表 (中方: 转成报价; 大家: 标已联系 / 没成交).
// 游客和客户账号用的是同一个询单表, 入口在 Guest.jsx / Portal.jsx.
import { RuleGear } from '../components/Rules.jsx';
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, Info, Assumed, MoneyIn, DatePicker, Shared, TierPill } from '../components/ui.jsx';
import { AvailPill } from '../components/DocPeek.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import ModelPicker from '../components/ModelPicker.jsx';
import FreeItem from '../components/FreeItem.jsx';
import { OptNote, OptChoice } from '../components/Opts.jsx';
import { ProspectModal } from '../components/Crm.jsx';
import { dt, dDate, qty, money, friendlyError } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink, DealLink } from '../components/Archives.jsx';
import { fmtPhone } from '../lib/phone.js';
import { GUEST_LEVELS } from './Guest.jsx';
import { MetricStrip } from '../components/Metric.jsx';
import { periodRange } from '../lib/format.js';

export const INQ_STATUS = { new: ['新询单', 'red'], contacted: ['已联系', 'amber'], quoted: ['已报价', 'blue'], converted: ['已转订单', 'green'], lost: ['没成交', 'gray'], invalid: ['无效', 'gray'] };
export const INQ_SOURCE = { guest: ['游客', 'amber'], customer: ['客户账号', 'blue'], staff: ['员工', 'gray'] };
const LOST = ['客户不想要了', '价格谈不拢', '没货', '联系不上'];
const INVALID = ['恶意刷单', '重复的', '测试', '填错了'];
const YANGO = [{ v: 'customer', l: '客户付' }, { v: 'us', l: '我们付' }, { v: 'pickup', l: '自己来拿' }];
const WAVE = [{ v: '', l: '没说' }, { v: 'customer', l: '客户付' }, { v: 'us', l: '我们付' }];
const N = (v) => Number(v || 0);
export const inqListSql = `
select i.*, c.name as customer_name, c.code, c.temp_code, c.tier, c.status as cust_status, e.short_name as owner_name, d.biz_no, d.status as deal_status,
  (select coalesce(m.employee_id::text, '') from app.members m where m.user_id = i.created_by and m.org_id = i.org_id limit 1) as creator_emp
from app.inquiries i left join app.customers c on c.id = i.customer_id left join app.employees e on e.id = i.owner_employee_id left join app.deals d on d.id = i.deal_id
where i.org_id = $1 order by i.created_at desc limit 500`;
const whoOf = (i) => (i.customer_id ? i.customer_name : `${i.guest_info?.contact || ''}${i.guest_info?.shop ? ` · ${i.guest_info.shop}` : ''}`);

export default function Inquiry({ embedded } = {}) {
  const { org, role, toast, refresh, tick } = useApp();
  const [tab, setTab] = useState(role === 'admin' ? 'list' : 'new');
  const [cust, setCust] = useState(''); const [lines, setLines] = useState([]); const [note, setNote] = useState('');
  const [wantOn, setWantOn] = useState(''); const [yango, setYango] = useState('customer'); const [wave, setWave] = useState(''); const [inv, setInv] = useState(null);
  const [newP, setNewP] = useState(false); const [done, setDone] = useState(null);
  const [conv, setConv] = useState(null); const [lost, setLost] = useState(null); const [mineOnly, setMineOnly] = useState(role === 'sales');
  const { data } = useData(async () => {
    const [customers, cat, categories, list, [me]] = await Promise.all([q(Q.customers, [org]), call(role, `select * from app.inquiry_catalog($1) order by cat_sort, model`, [org]), q(Q.categories, [org]),
      q(inqListSql, [org]), call(role, `select app.current_employee($1) as id`, [org]).catch(() => [{}])]);
    const catalog = cat.map((p) => ({ ...p, stock: [{ on_hand: N(p.avail), reserved: 0 }], prices: {}, shared_models: p.shared_models || [] }));
    return { customers: customers.map((c) => ({ ...c, code: c.code || c.temp_code })), catalog, categories, list, me: me?.id || null };
  }, [org, role, tick]);
  const stats = useMemo(() => { const m = new Date().toISOString().slice(0, 7); const l = (data?.list || []).filter((i) => String(i.created_at).slice(0, 7) === m && i.status !== 'invalid'); const dn = l.filter((i) => i.status === 'converted').length; const end = l.filter((i) => ['converted', 'lost'].includes(i.status)).length; return { n: l.length, dn, lost: l.filter((i) => i.status === 'lost').length, open: l.filter((i) => ['new', 'contacted'].includes(i.status)).length, rate: end ? Math.round((dn / end) * 100) : null }; }, [data]);
  if (!data) return <div className="empty">加载中…</div>;
  // 销售只列自己名下的客户 (+ 还没归属的潜客); 主管 / 热线 / 中方看全部
  const own = role === 'sales' && data.me ? data.customers.filter((c) => c.owner_employee_id === data.me || (c.status === 'prospect' && !c.owner_employee_id)) : data.customers;
  const add = (p) => setLines((l) => (l.some((x) => x.product_id === p.id) ? l : [...l, { product_id: p.id, code: p.code, model: p.model, category: p.category, shared_models: p.shared_models, band: p.band, qty: '' }]));
  const set = (i, k, v) => setLines((l) => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const ok = cust && lines.some((l) => N(l.qty) > 0);
  const submit = async () => {
    if (!cust) return toast('先选客户', 'err');
    if (!lines.some((l) => N(l.qty) > 0)) return toast('至少一行要填数量', 'err');
    try {
      const [{ id }] = await call(role, `select app.submit_inquiry($1,$2,$3,$4) as id`, [org, cust, JSON.stringify(lines.filter((l) => N(l.qty) > 0).map((l) => (l.product_id ? { product_id: l.product_id, qty: N(l.qty) } : { category_id: l.category_id, model: l.model, grade: l.grade, qty: N(l.qty), note: l.free_note }))), note || null]);
      await call(role, `select app.inquiry_extra($1,$2,$3,$4)`, [id, wantOn || null, yango, wave]);
      const [r] = await q(`select iq_no from app.inquiries where id = $1`, [id]);
      setDone(r.iq_no); setLines([]); setNote(''); setCust(''); setWantOn(''); setYango('customer'); setWave(''); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const mark = async (i, st, reason) => { try { await call(role, `select app.inquiry_mark($1,$2,$3)`, [i.id, st, reason || null]); toast(st === 'contacted' ? '已标记：联系过客户了' : '已记为没成交'); setLost(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const voidInq = async (i, act, reason) => { try { await call(role, `select app.inquiry_void($1,$2,$3)`, [i.id, act, reason || null]); toast(act === 'restore' ? '已恢复' : '已标无效，不算进转化率'); setInv(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const rows = data.list.filter((i) => !mineOnly || !data.me || i.owner_employee_id === data.me || i.creator_emp === data.me);
  const cols = [
    { key: 'iq_no', label: '询单号', w: 130, mono: true },
    { key: 'status', label: '状态', w: 100, value: (i) => INQ_STATUS[i.status][0], render: (i) => <Pill tone={INQ_STATUS[i.status][1]}>{INQ_STATUS[i.status][0]}</Pill> },
    { key: 'source', label: '谁建的', w: 90, value: (i) => INQ_SOURCE[i.source][0], render: (i) => <Pill tone={INQ_SOURCE[i.source][1]}>{INQ_SOURCE[i.source][0]}</Pill> },
    { key: 'who', label: '客户', w: 200, value: whoOf, render: (i) => (i.customer_id ? <><CustLink id={i.customer_id} name={i.customer_name} /> <span className="small muted">{i.code || i.temp_code}</span></> : <span>{whoOf(i)} <span className="small muted">{i.guest_info?.phone ? fmtPhone(i.guest_info.phone) : ''}</span></span>) },
    { key: 'lines', label: '要什么', w: 130, value: (i) => (i.lines || []).length, render: (i) => `${(i.lines || []).length} 个型号 · ${qty((i.lines || []).reduce((a, l) => a + N(l.qty), 0))} 片` },
    { key: 'owner_name', label: '跟单销售', w: 100, render: (i) => (i.owner_employee_id ? <EmpLink id={i.owner_employee_id} name={i.owner_name} /> : <span className="muted">—</span>) },
    { key: 'created_at', label: '什么时候', w: 130, render: (i) => dt(i.created_at) },
    { key: 'biz_no', label: '订单', w: 140, render: (i) => (i.deal_id ? <DealLink id={i.deal_id} no={i.biz_no} /> : '') },
    { key: 'want_on', label: '什么时候要', w: 110, render: (i) => (i.want_on ? dDate(i.want_on) : '') },
    { key: 'lost_reason', label: '没成交 / 无效原因', w: 150, value: (i) => i.lost_reason || i.invalid_reason || '' },
    { key: 'note', label: '备注', w: 180 },
  ];
  return (
    <>
      {!embedded && <div className="pagehead"><div><div className="eyebrow">Demandes</div>
        <h1>询单 <Info>询单 = 客户想要什么、还没定价。游客、开了账号的大客户、外跑销售都从这里进；中方看一眼价格、点「转成报价」才变成订单（单号 CI-…），之后流程和现在一样。销售只能给自己名下的客户建询单；价格只有中方定。</Info> <RuleGear anchor="inquiry-rules" title="询单规则" ids={['guest.low']} /></h1></div>
        <span className="grow" /><button type="button" className="btn" onClick={() => setNewP(true)}>＋ 新客户（潜客）</button></div>}
      {!embedded && <MetricStrip ids={['inq.win', 'inq.fast']} from={periodRange('month')[0]} to={periodRange('month')[1]} />}
      <div className="tabs"><button type="button" className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>＋ 建询单</button>
        <button type="button" className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>询单列表 <b>{data.list.filter((i) => ['new', 'contacted'].includes(i.status)).length}</b></button></div>
      {tab === 'new' && <div className="card">
        {done && <div className="card-b" style={{ background: 'var(--green-bg)' }}>✓ 询单已提交，单号 <b className="mono">{done}</b>。中方定好价会转成报价，到时这里和你的待办里都会显示「价格出来了」。<button type="button" className="btn sm ghost" onClick={() => { setDone(null); setTab('list'); }}>看询单列表 →</button></div>}
        <div className="card-b row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="grow" style={{ maxWidth: 460 }}><CustomerSelect onlyActive={false} customers={own} value={cust} onChange={setCust} /></div>
          {role === 'sales' && <span className="small muted">只列你名下的客户和还没归属的潜客；别人的客户只能看、不能接。</span>}
        </div>
        <div className="card-b" style={{ paddingTop: 0 }}><ModelPicker catalog={data.catalog} categories={data.categories} onPick={add} picked={new Set(lines.filter((l) => l.product_id).map((l) => l.product_id))} onUnpick={(p) => setLines((l) => l.filter((x) => x.product_id !== p.id))} showPrice={false} /></div>
        <Grid id="inq-lines" noTools rowKey={(l) => l._k} rows={lines.map((l, i) => ({ ...l, _k: String(i) }))} onDelete={(l, i, rs) => { const ks = new Set((rs || [l]).map((y) => y._k)); setLines((x) => x.filter((_, j) => !ks.has(String(j)))); }} empty="上面选型号，或在下面填客户要的没编码的货" columns={[
          { key: 'category', label: '种类', w: 110, value: (l) => l.category || '' },
          { key: 'model', label: '型号', w: 150, value: (l) => l.model, render: (l) => (l.product_id ? <ModelLink id={l.product_id} model={l.model} /> : <b>{l.model}</b>) },
          { key: 'shared', label: '通用性', w: 240, value: (l) => (l.shared_models || []).join(' / '), render: (l) => <Shared list={l.shared_models} /> },
          { key: 'band', label: '状态', w: 90, align: 'center', value: (l) => (['ok', 'low'].includes(l.band) ? '可售' : '可预订'), render: (l) => <AvailPill band={l.product_id ? l.band : 'none'} pid={l.product_id} /> },
          { key: 'qty', label: '需求数量', w: 100, fill: true, value: (l) => l.qty, edit: (l) => ({ type: 'number', value: l.qty, onChange: (v) => set(Number(l._k), 'qty', String(v ?? '').replace(/\D/g, '')) }) },
        ]} />
        <div className="card-b" style={{ paddingTop: 8 }}><FreeItem label="客户要的、但我们没编码的货" categories={data.categories} catalog={data.catalog} onAdd={(x) => setLines((l) => [...l, { model: x.model, category: x.category, category_id: x.category_id, grade: x.grade, qty: x.qty, free_note: x.note }])} /></div>
        <div className="card-b form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: '10px 18px', alignItems: 'end' }}>
          <div className="field"><label>什么时候要</label><DatePicker value={wantOn} onChange={setWantOn} /></div>
          <div className="field"><label>Yango 运费 <Info>默认客户付。只有单特别大才由我们付；客户自己来拿就没有运费。</Info></label><OptChoice optKey="inq_yango" title="Yango 运费谁付" options={YANGO} value={yango} onChange={setYango} /></div>
          <div className="field"><label>Wave 手续费</label><OptChoice optKey="inq_wave" title="Wave 手续费谁付" options={WAVE} value={wave} onChange={setWave} /></div>
          <div className="field"><label>备注</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="field"><button type="button" className="btn primary" disabled={!ok} onClick={submit}>提交询单</button></div>
        </div>
        <div className="card-b small muted" style={{ paddingTop: 0 }}>询单不带价、不预占库存。提交后进中方待办；中方定价转成报价后，你对自己名下的客户可以接着「确认客户 → 下推找货 → 发销售单给客户确认」。</div>
      </div>}
      {tab === 'list' && <div className="card">
        <Grid id="inquiries" columns={cols} rows={rows} empty="还没有询单"
          tools={<label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />只看我跟的</label>}
          rowActions={[
            { label: '转成报价（定价）', tone: 'primary', when: (i) => role === 'admin' && ['new', 'contacted'].includes(i.status), run: (i) => setConv(i) },
            { label: '看要什么', when: (i) => role !== 'admin' || !['new', 'contacted'].includes(i.status), run: (i) => setConv({ ...i, view: true }) },
            { label: '联系过了', when: (i) => i.status === 'new', run: (i) => mark(i, 'contacted') },
            { label: '没成交', when: (i) => ['new', 'contacted', 'quoted'].includes(i.status), run: (i) => setLost({ i, reason: '' }) },
            { label: '无效', when: (i) => role === 'admin' && ['new', 'contacted', 'lost'].includes(i.status), run: (i) => setInv({ i, reason: '' }) },
            { label: '恢复', when: (i) => role === 'admin' && ['invalid', 'lost'].includes(i.status) && !i.deal_id, run: (i) => voidInq(i, 'restore') },
          ]} />
      </div>}
      {conv && <ConvertModal inq={conv} catalog={data.catalog} categories={data.categories} onClose={() => setConv(null)} />}
      {lost && <Modal title={`没成交 · ${lost.i.iq_no}`} onClose={() => setLost(null)} footer={<><button type="button" className="btn" onClick={() => setLost(null)}>取消</button><button type="button" className="btn primary" onClick={() => (lost.reason ? mark(lost.i, 'lost', lost.reason) : toast('选一个原因', 'err'))}>记为没成交</button></>}>
        <div className="stack"><div className="small muted">为什么没成？以后看「询单转化」和客户档案用。{lost.i.status === 'quoted' ? '已经转成报价的，请到订单里作废那张单（这里会自动跟着变成没成交）。' : ''}</div>
          <OptNote optKey="inq_lost" title="询单没成交的原因" options={LOST} value={lost.reason} onChange={(v) => setLost({ ...lost, reason: v })} /></div>
      </Modal>}
      {inv && <Modal title={`无效 · ${inv.i.iq_no}`} risk="yellow" onClose={() => setInv(null)} footer={<><button type="button" className="btn" onClick={() => setInv(null)}>取消</button><button type="button" className="btn primary" onClick={() => (inv.reason ? voidInq(inv.i, 'invalid', inv.reason) : toast('选一个原因', 'err'))}>标成无效</button></>}>
        <div className="stack"><div className="small muted">无效 = 这张根本不算询单（刷单、重复、测试、填错），不算进转化率。真想买但没成的，用「没成交」。标错了可以恢复。</div>
          <OptNote optKey="inq_invalid" title="询单无效的原因" options={INVALID} value={inv.reason} onChange={(v) => setInv({ ...inv, reason: v })} /></div>
      </Modal>}
      {newP && <ProspectModal onClose={() => setNewP(false)} onDone={(x) => { setCust(x.id); setTab('new'); }} />}
    </>
  );
}

// 中方: 看一眼询单, 价格已按客户档位 / 促销价带好, 可改 → 转成报价. 游客的询单这一步才建成潜客.
function ConvertModal({ inq, catalog, categories, onClose }) {
  const { org, role, toast, refresh, go } = useApp();
  const byId = useMemo(() => Object.fromEntries(catalog.map((p) => [p.id, p])), [catalog]);
  const { data: auto } = useData(async () => {
    if (!inq.customer_id) return {};
    const ids = (inq.lines || []).map((l) => l.product_id).filter(Boolean);
    if (!ids.length) return {};
    const rs = await call(role, `select p.id, app.tier_price(p.id, $1, 'XOF') as price from app.products p where p.id = any($2::uuid[])`, [inq.customer_id, ids]).catch(() => []);
    return Object.fromEntries(rs.map((r) => [r.id, r.price == null ? null : Number(r.price)]));
  }, [inq.id, org]);
  const [px, setPx] = useState({});
  const view = !!inq.view;
  const rows = (inq.lines || []).map((l, i) => ({ ...l, _i: i, p: byId[l.product_id], cat: l.product_id ? byId[l.product_id]?.category : (categories.find((c) => c.id === l.category_id)?.name || '') }));
  const priceOf = (r) => (px[r._i] !== undefined ? px[r._i] : (auto?.[r.product_id] ?? ''));
  const total = rows.reduce((a, r) => a + N(priceOf(r)) * N(r.qty), 0);
  const goConv = async () => {
    try {
      const prices = rows.filter((r) => px[r._i] !== undefined && px[r._i] !== '' && N(px[r._i]) !== N(auto?.[r.product_id])).map((r) => ({ idx: r._i, price: N(px[r._i]), note: '询单定价' }));
      const [{ id }] = await call(role, `select app.inquiry_convert($1,$2) as id`, [inq.id, JSON.stringify(prices)]);
      toast('已转成报价，建单的人会看到「价格出来了」'); refresh(); onClose(); go('deal/' + id);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={`${view ? '询单' : '转成报价'} · ${inq.iq_no}`} onClose={onClose} footer={view ? <button type="button" className="btn" onClick={onClose}>关闭</button> : <><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><span className="small muted">合计 {money(total)} XOF</span><button type="button" className="btn primary" onClick={goConv}>转成报价</button></>}>
      <div className="stack">
        <div className="kv-row"><span><Pill tone={INQ_SOURCE[inq.source][1]}>{INQ_SOURCE[inq.source][0]}</Pill></span><span>客户 <b>{whoOf(inq)}</b>{!inq.customer_id && inq.guest_info?.phone ? ` · ${fmtPhone(inq.guest_info.phone)}` : ''}{inq.guest_info?.city ? ` · ${inq.guest_info.city}` : ''}</span>
          {inq.customer_id ? <span className="small muted">档位 <TierPill tier={inq.tier} empty="没定" /></span> : <span className="pill amber">游客自报：{GUEST_LEVELS.find((x) => x.v === inq.guest_info?.level)?.l.split(' · ')[0] || '没填'} → 转报价时建成潜客，先按 <TierPill tier={inq.guest_info?.level === 'REPAIR' ? 'REPAIR' : 'RETAIL'} />（系统默认 · 未确认），档位要你定</span>}<span className="small muted">{dt(inq.created_at)}</span></div>
        {inq.note && <div className="hint">备注：{inq.note}</div>}
        <Grid id="inq-conv" noTools rows={rows} rowKey={(r) => String(r._i)} columns={[
          { key: 'code', label: '编码', w: 80, mono: true, value: (r) => r.p?.code || '没编码', render: (r) => r.p?.code || <Pill tone="amber">没编码</Pill> },
          { key: 'cat', label: '种类', w: 100 },
          { key: 'model', label: '型号', w: 150, value: (r) => r.p?.model || r.model, render: (r) => (r.p ? <><ModelLink id={r.product_id} model={r.p.model} />{r.p.variant ? <span className="pill blue" style={{ marginLeft: 6 }}>{r.p.variant}</span> : null}</> : <span>{r.model}{r.grade ? ` · ${r.grade}` : ''}{r.note ? <span className="small muted"> · {r.note}</span> : null}</span>) },
          { key: 'qty', label: '要几片', w: 70, type: 'number', render: (r) => qty(r.qty) },
          { key: 'avail', label: '可售', w: 70, type: 'number', value: (r) => (r.p ? N(r.p.avail) : null), render: (r) => (r.p ? (N(r.p.avail) >= N(r.qty) ? qty(r.p.avail) : <span className="red-t2">{qty(r.p.avail)}</span>) : '—') },
          ...(role === 'admin' ? [
            { key: 'price', label: '单价', w: 120, type: 'money', value: (r) => priceOf(r), render: (r) => (r.p ? (priceOf(r) !== '' ? <>{money(priceOf(r))}{px[r._i] !== undefined && N(px[r._i]) !== N(auto?.[r.product_id]) ? <span className="pill amber" style={{ marginLeft: 6 }}>中方改价</span> : null}</> : <span className="muted">没价（客户没档位）</span>) : <span className="muted">没编码，转成报价后再处理</span>),
              ...(view ? {} : { edit: (r) => (r.p ? { type: 'number', value: priceOf(r), onChange: (v) => setPx((x) => ({ ...x, [r._i]: String(v ?? '').replace(/[^\d.]/g, '') })) } : null) }) }] : []),
        ]} />
        {!view && <div className="small muted">点「转成报价」= 生成一张报价（订单号 CI-…），价格按上面的；欠款 / 亏钱 / 新客户这些审批照旧会拦。之后热线、主管或这个客户的归属销售接着确认客户、下推找货。<Assumed>客户账号自己下的询单也先到这里过你一眼（方案 A）；没编码的行会带进报价里当「补录需求」，不算钱。</Assumed></div>}
      </div>
    </Modal>);
}

// 待办里的两块: 中方「新询单」; 建单的人「价格出来了」
export function InquiryTodo() {
  const { org, role, go, tick, refresh } = useApp();
  const { data } = useData(async () => {
    const [me] = await call(role, `select app.current_employee($1) as id`, [org]).catch(() => [{}]);
    const list = await q(`select i.id, i.iq_no, i.status, i.source, i.created_at, i.deal_id, i.seen_at, i.owner_employee_id, i.guest_info, c.name as customer_name, d.biz_no,
        (select m.employee_id from app.members m where m.user_id = i.created_by and m.org_id = i.org_id limit 1) as creator_emp
      from app.inquiries i left join app.customers c on c.id = i.customer_id left join app.deals d on d.id = i.deal_id
      where i.org_id = $1 and (i.status in ('new','contacted') or (i.status = 'quoted' and i.seen_at is null)) order by i.created_at`, [org]);
    return { list, me: me?.id || null };
  }, [org, role, tick]);
  if (!data || !['admin', 'manager', 'sales_manager', 'hotline', 'sales'].includes(role)) return null;
  const fresh = data.list.filter((i) => ['new', 'contacted'].includes(i.status));
  const priced = data.list.filter((i) => i.status === 'quoted' && (role === 'sales' ? (!data.me || i.owner_employee_id === data.me || i.creator_emp === data.me) : role !== 'admin'));
  const seen = async (i) => { await call(role, `select app.inquiry_mark($1,'seen')`, [i.id]).catch(() => {}); refresh(); go('deal/' + i.deal_id); };
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>询单</h2><Pill tone={fresh.length ? 'red' : 'gray'}>{fresh.length} 张等{role === 'admin' ? '你定价' : '中方定价'}</Pill>{priced.length > 0 && <Pill tone="blue">{priced.length} 张价格出来了</Pill>}
        <span className="grow" /><button type="button" className="btn sm" onClick={() => go('inquiry')}>去询单页 →</button></div>
      {(fresh.length > 0 || priced.length > 0) ? <div className="card-b stack" style={{ gap: 4 }}>
        {priced.map((i) => <div key={i.id} className="row small" style={{ gap: 8 }}><Pill tone="blue">价格出来了</Pill><b className="mono">{i.iq_no}</b><span>{i.customer_name || i.guest_info?.contact}</span><span className="grow" /><button type="button" className="btn sm primary" onClick={() => seen(i)}>打开报价 {i.biz_no} →</button></div>)}
        {fresh.slice(0, 6).map((i) => <div key={i.id} className="row small" style={{ gap: 8 }}><Pill tone={INQ_STATUS[i.status][1]}>{INQ_STATUS[i.status][0]}</Pill><b className="mono">{i.iq_no}</b><Pill tone={INQ_SOURCE[i.source][1]}>{INQ_SOURCE[i.source][0]}</Pill><span>{i.customer_name || i.guest_info?.contact}</span><span className="muted">{dt(i.created_at)}</span></div>)}
        {fresh.length > 6 && <div className="small muted">…还有 {fresh.length - 6} 张，去询单页看</div>}
      </div> : <div className="card-b small muted">没有等处理的询单。</div>}
    </div>);
}
