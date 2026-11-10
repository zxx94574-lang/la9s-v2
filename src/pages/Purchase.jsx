// 采购与物资申请 (Frank 10-30): 货和物资 (工服、工具…) 都从这里发起. 每张申请写清楚用途:
// 本地备货 / 某个 FOB 项目 / 物资 —— 从源头分开, 到货时不用再猜哪些是 FOB 的.
// 有期望发货日、预计到货日; 快到了 / 过了日子还没到, 待办里提醒.
// 国内录金蝶采购订单时, 请在备注里写上这里的申请单号 (PR-…), 系统收货时自动对上.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, DatePicker } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import ModelPicker from '../components/ModelPicker.jsx';
import { SimpleForm } from './Fob.jsx';
import { can } from '../lib/domain.js';
import { dDate, today, friendlyError } from '../lib/format.js';

export const PR_KIND = { stock: ['本地备货', 'blue'], fob: ['FOB 客户货', 'amber'], supplies: ['物资', 'gray'] };
const PR_ST = { draft: '草稿', submitted: '已申请', ordered: '国内已下单', shipped: '已发货', arrived: '已到', received: '已收货', cancelled: '已取消' };
const MODE = { sea: '海运', air: '空运', courier: '快递', other: '其他' };
const daysTo = (d) => (d ? Math.round((new Date(dDate(d)) - new Date(today())) / 864e5) : null);

export function etaPill(r) {
  if (['received', 'cancelled', 'arrived'].includes(r.status) || !r.eta) return null;
  const n = daysTo(r.eta);
  if (n < 0) return <Pill tone="red">过了 {-n} 天还没到</Pill>;
  if (n <= 5) return <Pill tone="amber">{n === 0 ? '今天' : `${n} 天后`}到</Pill>;
  return null;
}

export default function Purchase() {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState('open');
  const [edit, setEdit] = useState(null);
  const [adv, setAdv] = useState(null);
  const { data } = useData(() => q(Q.purchaseRequests, [org]), [org]);
  if (!data) return <div className="empty">加载中…</div>;
  const rows = data.filter((r) => (f === 'open' ? !['received', 'cancelled'].includes(r.status) : f === 'all' ? true : r.kind === f));
  const act = async (msg, sql, p) => { try { await call(role, sql, p); toast(msg); refresh(); setAdv(null); } catch (e) { toast(friendlyError(e), 'err'); } };
  const next = { submitted: ['ordered', '国内已下单'], ordered: ['shipped', '已发货'], shipped: ['arrived', '已到'], arrived: ['received', '收货完成'] };
  const cols = [
    { key: 'req_no', label: '申请单号', w: 130, render: (r) => <span className="mono">{r.req_no}</span> },
    { key: 'kind', label: '用途', w: 110, value: (r) => PR_KIND[r.kind][0], render: (r) => <><Pill tone={PR_KIND[r.kind][1]}>{PR_KIND[r.kind][0]}</Pill>{r.fob_no && <span className="mono small"> {r.fob_no}</span>}</> },
    { key: 'title', label: '申请什么', w: 200, render: (r) => <b>{r.title}</b> },
    { key: 'lines', label: '明细', w: 240, value: (r) => r.lines.map((l) => `${l.item}${l.spec ? ' ' + l.spec : ''} ×${l.qty}`).join('，') },
    { key: 'need_by', label: '要求到货', w: 100, render: (r) => dDate(r.need_by) },
    { key: 'planned_ship', label: '计划发货', w: 100, render: (r) => dDate(r.planned_ship) },
    { key: 'eta', label: '预计到货', w: 140, value: (r) => r.eta || '', render: (r) => <>{dDate(r.eta)} {etaPill(r)}</> },
    { key: 'status', label: '进度', w: 100, value: (r) => PR_ST[r.status], render: (r) => <Pill tone={r.status === 'received' ? 'green' : r.status === 'cancelled' ? 'gray' : 'blue'}>{PR_ST[r.status]}</Pill> },
    { key: 'po_no', label: '金蝶采购单 / 柜号', w: 150, value: (r) => [r.po_no, r.container, r.tracking].filter(Boolean).join(' · ') },
    { key: 'act', label: '', w: 160, render: (r) => <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
      {next[r.status] && can(role, 'purchase_advance') && <button type="button" className="btn sm primary" onClick={() => setAdv({ r, to: next[r.status][0], label: next[r.status][1] })}>{next[r.status][1]} →</button>}
      {['submitted', 'ordered'].includes(r.status) && can(role, 'purchase_advance') && <button type="button" className="btn sm" onClick={() => act('已取消', `select app.advance_purchase_request($1,'cancelled','{}')`, [r.id])}>取消</button>}</span> },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Demandes d’achat</div><h1>采购与物资申请</h1>
        <div className="sub">货和物资（工服、工具、办公用品）都在这里申请。每张写清楚用途：本地备货 / FOB 客户货 / 物资；填期望发货和预计到货，快到或者过期没到会提醒。请国内录金蝶采购订单时在备注写上申请单号（PR-…）。</div></div>
        {can(role, 'purchase_request') && <button type="button" className="btn primary" onClick={() => setEdit({})}>＋ 新申请</button>}
      </div>
      <div className="card">
        <Grid id="purchase-req" table="purchase_requests" columns={cols} rows={rows} onRowClick={(r) => ['draft', 'submitted'].includes(r.status) && setEdit(r)} empty="没有申请"
          tools={<div className="chips">{[['open', '进行中'], ['stock', '本地备货'], ['fob', 'FOB'], ['supplies', '物资'], ['all', '全部']].map(([k, l]) =>
            <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l}</button>)}</div>} />
      </div>
      {edit && <EditPR r={edit} onClose={() => setEdit(null)} />}
      {adv && <SimpleForm title={`${adv.r.req_no} · ${adv.label}`} onClose={() => setAdv(null)}
        fields={adv.to === 'ordered' ? [['po_no', '金蝶采购订单号', true], ['planned_ship', '计划发货日', false, 'date']]
          : adv.to === 'shipped' ? [['logistics', '物流公司'], ['tracking', '物流单号 / 入仓号'], ['container', '柜号 / 分柜说明'], ['eta', '预计到货', true, 'date']] : []}
        onOk={(v) => act(adv.label, `select app.advance_purchase_request($1,$2,$3)`, [adv.r.id, adv.to, JSON.stringify(v)])} />}
    </>
  );
}

function EditPR({ r, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data } = useData(async () => {
    const [catalog, categories, fobs] = await Promise.all([q(Q.catalog, [org]), q(Q.categories, [org]), q(Q.fobList, [org])]);
    return { catalog, categories, fobs: fobs.filter((x) => !['closed', 'cancelled', 'shipped'].includes(x.status)) };
  }, [org]);
  const [f, setF] = useState({ kind: r.kind || 'stock', fob_project_id: r.fob_project_id || '', title: r.title || '', description: r.description || '',
    need_by: r.need_by ? dDate(r.need_by) : '', planned_ship: r.planned_ship ? dDate(r.planned_ship) : '', mode: r.mode || 'sea' });
  const [lines, setLines] = useState(r.lines ? r.lines.map((l) => ({ ...l, qty: String(l.qty) })) : []);
  const [free, setFree] = useState({ item: '', spec: '', qty: '' });
  if (!data) return null;
  const save = async () => {
    try { await call(role, `select app.save_purchase_request($1,$2,$3,$4)`, [org, r.id || null, JSON.stringify(f), JSON.stringify(lines.filter((l) => Number(l.qty) > 0).map((l) => ({ ...l, qty: Number(l.qty) })))]);
      toast(r.id ? '已保存' : '申请已提交'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={r.id ? `申请 ${r.req_no}` : '新采购 / 物资申请'} onClose={onClose}
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!f.title.trim() || !lines.length || (f.kind === 'fob' && !f.fob_project_id)} onClick={save}>{r.id ? '保存' : '提交申请'}</button></>}>
      <div className="stack">
        <div className="field req"><label>用途（从源头分开，到货不用再猜）</label><div className="seg">{Object.entries(PR_KIND).map(([k, [l]]) => <button type="button" key={k} className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>{l}</button>)}</div></div>
        {f.kind === 'fob' && <div className="field req"><label>哪个 FOB 项目</label><select className="in" value={f.fob_project_id} onChange={(e) => setF({ ...f, fob_project_id: e.target.value })} style={{ maxWidth: 360 }}>
          <option value="">选 FOB 项目</option>{data.fobs.map((x) => <option key={x.id} value={x.id}>{x.fob_no} · {x.customer_code} {x.customer_name}</option>)}</select></div>}
        <div className="grid2">
          <div className="field req"><label>申请什么（标题）</label><input className="in" value={f.title} placeholder={f.kind === 'supplies' ? '例：仓库工服 30 套' : '例：10 月屏幕补货'} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div className="field"><label>运输方式</label><div className="seg">{Object.entries(MODE).map(([k, l]) => <button type="button" key={k} className={f.mode === k ? 'on' : ''} onClick={() => setF({ ...f, mode: k })}>{l}</button>)}</div></div>
          <div className="field"><label>要求到货日</label><DatePicker value={f.need_by || today()} onChange={(v) => setF({ ...f, need_by: v })} /></div>
          <div className="field"><label>期望发货日</label><DatePicker value={f.planned_ship || today()} onChange={(v) => setF({ ...f, planned_ship: v })} /></div>
        </div>
        <div className="field"><label>具体描述（尺码、颜色、怎么装箱、分柜要求…）</label><textarea className="in" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        {f.kind !== 'supplies' && <ModelPicker catalog={data.catalog} categories={data.categories} showPrice={false}
          onPick={(p) => setLines((l) => [...l, { product_id: p.id, item: p.model, spec: [p.category, p.variant].filter(Boolean).join(' '), qty: '' }])} />}
        <Grid id="pr-new-lines" noTools rowKey={(l) => l._k} rows={lines.map((l, i) => ({ ...l, _k: String(i) }))} onDelete={(l, i, rs) => { const ks = new Set((rs || [l]).map((y) => y._k)); setLines((x) => x.filter((_, j) => !ks.has(String(j)))); }} empty="从上面选型号，或在下面填没编码的货 / 物资" columns={[
          { key: 'item', label: '货 / 物资', w: 160, value: (l) => l.item, render: (l) => <b>{l.item}</b>, edit: (l) => (l.product_id ? null : { type: 'text', value: l.item, onChange: (v) => setLines((x) => x.map((y, j) => (j === Number(l._k) ? { ...y, item: v } : y))) }) },
          { key: 'spec', label: '规格', w: 160, value: (l) => l.spec || '', edit: (l) => ({ type: 'text', value: l.spec || '', onChange: (v) => setLines((x) => x.map((y, j) => (j === Number(l._k) ? { ...y, spec: v } : y))) }) },
          { key: 'qty', label: '数量', w: 90, fill: true, value: (l) => l.qty, edit: (l) => ({ type: 'number', value: l.qty, onChange: (v) => setLines((x) => x.map((y, j) => (j === Number(l._k) ? { ...y, qty: String(v ?? '').replace(/\D/g, '') } : y))) }) },
        ]} />
        <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="in" style={{ maxWidth: 200 }} placeholder={f.kind === 'supplies' ? '物资名称（例：工服）' : '没编码的型号'} value={free.item} onChange={(e) => setFree({ ...free, item: e.target.value })} />
          <input className="in" style={{ maxWidth: 180 }} placeholder="规格（例：L 码 蓝色）" value={free.spec} onChange={(e) => setFree({ ...free, spec: e.target.value })} />
          <input className="in" inputMode="numeric" placeholder="数量" value={free.qty} style={{ maxWidth: 90 }} onChange={(e) => setFree({ ...free, qty: e.target.value.replace(/\D/g, '') })} />
          <button type="button" className="btn sm" disabled={!free.item || !free.qty} onClick={() => { setLines((x) => [...x, { ...free }]); setFree({ item: '', spec: '', qty: '' }); }}>加</button></div>
      </div>
    </Modal>
  );
}
