// 备货看板 (Frank 2026-10-29): 一张表看清 —— 本地可售 + 在途、卖得多快、能撑几天、欠客户多少、建议补多少.
// 建议补货 = 日均出库 × 备货天数 + 欠客户的缺口 − 可售 − 在途 (日均取近 30 天和近 90 天里大的那个).
// 积压 = 库龄 180 天以上还有货. 没编码的需求单独列, 给中方决定要不要建编码进货.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { can } from '../lib/domain.js';
import { qty, dDate, friendlyError } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';

const N = (v) => Number(v || 0);
export const PURPOSE = { local: ['本地备货', 'blue'], fob: ['FOB 客户货', 'amber'], mixed: ['混装：要人工分', 'red'], supplies: ['物资 / 工具', 'gray'], unknown: ['认不出（没写清楚）', 'gray'] };
const FILTERS = [['need', '要补货'], ['short', '欠客户的'], ['out', '断货'], ['aged', '积压（库龄 180+）'], ['all', '全部']];

export default function Replenish() {
  const { org, role } = useApp();
  const [tab, setTab] = useState('board');
  const [f, setF] = useState('need');
  const [cat, setCat] = useState('');
  const [recv, setRecv] = useState(null);
  const [set, setSet] = useState(false);
  const { data } = useData(async () => {
    const [rows, [s], pos, nocode] = await Promise.all([q(Q.replenish, [org]), q(Q.replenishSettings, [org]), q(Q.openPOs, [org]), q(Q.unmetNoCode, [org])]);
    return { rows, s: s || { cover_days: 60, sea_days: 45, air_days: 10 }, pos, nocode };
  }, [org]);
  const cats = useMemo(() => [...new Set((data?.rows || []).map((r) => r.category))], [data]);
  if (!data) return <div className="empty">加载中…</div>;
  const match = { need: (r) => N(r.suggest) > 0, short: (r) => N(r.short_qty) > 0, out: (r) => N(r.available) <= 0 && (N(r.sold_90) > 0 || N(r.short_qty) > 0), aged: (r) => N(r.aged_180) > 0, all: () => true };
  const rows = data.rows.filter((r) => match[f](r) && (!cat || r.category === cat));
  const s = data.s;
  const cols = [
    { key: 'code', label: '编码', w: 80, render: (r) => <span className="mono">{r.code}</span> },
    { key: 'category', label: '种类', w: 100 },
    { key: 'model', label: '型号', w: 110, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
    { key: 'available', label: '可售', w: 70, value: (r) => N(r.available), render: (r) => (N(r.available) <= 0 ? <span className="red-t2">{qty(r.available)}</span> : qty(r.available)) },
    { key: 'reserved', label: '预占', w: 70, value: (r) => N(r.reserved) },
    { key: 'in_transit', label: '在途', w: 80, value: (r) => N(r.in_transit), render: (r) => (N(r.in_transit) ? <>{qty(r.in_transit)}{r.eta && <span className="muted small"> {dDate(r.eta).slice(5)}到</span>}</> : '') },
    { key: 'sold_30', label: '近 30 天出库', w: 100, value: (r) => N(r.sold_30) },
    { key: 'sold_90', label: '近 90 天出库', w: 100, value: (r) => N(r.sold_90) },
    { key: 'hist_3m', label: '前 3 个月出库（导入）', w: 130, value: (r) => N(r.hist_3m), render: (r) => (N(r.hist_3m) ? qty(r.hist_3m) : '') },
    { key: 'daily', label: '日均', w: 70, value: (r) => N(r.daily), render: (r) => (N(r.daily) ? Number(r.daily).toFixed(1) : '') },
    { key: 'days_left', label: '能撑几天', w: 90, value: (r) => (r.days_left == null ? 9999 : N(r.days_left)),
      render: (r) => (r.days_left == null ? <span className="muted">没出过</span> : N(r.days_left) < s.sea_days ? <Pill tone="red">{r.days_left} 天</Pill> : `${r.days_left} 天`) },
    { key: 'short_qty', label: '欠客户', w: 90, value: (r) => N(r.short_qty), render: (r) => (N(r.short_qty) ? <span className="red-t2">{qty(r.short_qty)}<span className="muted small"> · {r.short_customers} 家</span></span> : '') },
    { key: 'aged_180', label: '库龄 180+', w: 90, value: (r) => N(r.aged_180), render: (r) => (N(r.aged_180) ? <Pill tone="amber">{qty(r.aged_180)}</Pill> : '') },
    { key: 'suggest', label: '建议补', w: 90, value: (r) => N(r.suggest), render: (r) => (N(r.suggest) ? <b className="brand-t">{qty(r.suggest)}</b> : '') },
  ];
  const ncCols = [
    { key: 'category', label: '种类', w: 100 }, { key: 'model', label: '客户要的型号', w: 160, render: (r) => <b>{r.model}</b> },
    { key: 'qty', label: '要的数量', w: 90, value: (r) => N(r.qty) }, { key: 'customers', label: '几家客户要', w: 90, value: (r) => N(r.customers) },
    { key: 'last_at', label: '最近一次', w: 110, render: (r) => dDate(r.last_at) },
  ];
  const poCols = [
    { key: 'po_no', label: '采购单号', w: 120, render: (p) => <span className="mono">{p.po_no}</span> },
    { key: 'purpose', label: '用途（按备注识别）', w: 170, value: (p) => PURPOSE[p.purpose || 'unknown'][0],
      render: (p) => <span title={p.remark || '没有备注'}><Pill tone={PURPOSE[p.purpose || 'unknown'][1]}>{PURPOSE[p.purpose || 'unknown'][0]}</Pill>{p.fob_customer_codes?.length ? <span className="mono small"> {p.fob_customer_codes.join(',')}</span> : ''}</span> },
    { key: 'boxes', label: '箱 / 件', w: 100, value: (p) => [p.boxes && `${p.boxes} 箱`, p.pcs && `${p.pcs} 件`].filter(Boolean).join(' · ') },
    { key: 'remark', label: '国内备注', w: 220, render: (p) => <span className="small muted">{p.remark}</span> },
    { key: 'supplier', label: '供应商', w: 120 },
    { key: 'mode', label: '方式', w: 70, value: (p) => ({ sea: '海运', air: '空运', other: '其他' })[p.mode] },
    { key: 'ordered_on', label: '下单', w: 100, render: (p) => dDate(p.ordered_on) },
    { key: 'eta', label: '预计到', w: 100, render: (p) => (p.eta && dDate(p.eta) < dDate(new Date()) ? <Pill tone="red">{dDate(p.eta)} 已过</Pill> : dDate(p.eta)) },
    { key: 'lines', label: '货', w: 280, value: (p) => p.lines.map((l) => l.model).join(' '),
      render: (p) => <span className="small">{p.lines.slice(0, 4).map((l) => `${l.model}${l.category ? ' ' + l.category : ''} ×${l.qty - l.received}`).join('，')}{p.lines.length > 4 ? ` 等 ${p.lines.length} 行` : ''}</span> },
    { key: 'remaining', label: '在途件数', w: 90, value: (p) => N(p.remaining) },
    { key: 'act', label: '', w: 100, render: (p) => can(role, 'receive_po') && <button type="button" className="btn sm primary" onClick={(e) => { e.stopPropagation(); setRecv(p); }}>到货入库</button> },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Réassort</div><h1>备货看板</h1>
        <div className="sub">建议补 = 日均出库（系统近 30 / 90 天和导入的前 3 个月取大的）× {s.cover_days} 天 + 欠客户的缺口 − 可售 − 在途。能撑天数少于海运周期（{s.sea_days} 天）标红，来不及海运的考虑空运（{s.air_days} 天）。</div></div>
        {can(role, 'settings_thresholds') && <button type="button" className="btn" onClick={() => setSet(true)}>备货天数</button>}
      </div>
      <div className="card">
        <div className="tabs">
          <button type="button" className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>备货建议 <span className="queue-n">{data.rows.filter(match.need).length}</span></button>
          <button type="button" className={tab === 'po' ? 'on' : ''} onClick={() => setTab('po')}>在途采购 <span className="muted small">{data.pos.length}</span></button>
          <button type="button" className={tab === 'nocode' ? 'on' : ''} onClick={() => setTab('nocode')}>没编码的需求 <span className="muted small">{data.nocode.length}</span></button>
        </div>
        {tab === 'board' && <>
          <Grid id="replenish" table="products" columns={cols} rows={rows} rowKey={(r) => r.product_id} empty="这一类没有物料"
            tools={<><div className="chips">{FILTERS.map(([k, l]) => <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} {data.rows.filter(match[k]).length}</button>)}</div>
              <select className="in" value={cat} onChange={(e) => setCat(e.target.value)} style={{ maxWidth: 150 }}><option value="">全部种类</option>{cats.map((c) => <option key={c}>{c}</option>)}</select></>}
            foot={(rs) => ({ code: `${rs.length} 个`, suggest: qty(rs.reduce((a, r) => a + N(r.suggest), 0)), short_qty: qty(rs.reduce((a, r) => a + N(r.short_qty), 0)), in_transit: qty(rs.reduce((a, r) => a + N(r.in_transit), 0)) })} />
        </>}
        {tab === 'po' && <Grid id="pos" table="purchase_orders" columns={poCols} rows={data.pos} empty="没有在途的采购单（金蝶采购订单导入后显示在这里）" />}
        {tab === 'nocode' && <><div className="card-b hint" style={{ paddingTop: 0 }}>近 90 天客户要了、但我们没有编码的型号。要不要建编码进货由中方定。</div>
          <Grid id="nocode" columns={ncCols} rows={data.nocode} rowKey={(r) => r.category + r.model} empty="没有" /></>}
      </div>
      {recv && <ReceiveModal po={recv} onClose={() => setRecv(null)} />}
      {set && <SettingsModal s={s} onClose={() => setSet(false)} />}
    </>
  );
}

// 到货入库 (分开收): 每行「本地数」进 LA / 9S, 「FOB 数」进 FOB 仓; 按采购备注已经预分好, 混装的单在这里人工分.
// 收完生成一张收货单, 金蝶那边按它录采购入库 (FOB 部分入 CI LA FOB Material WH).
function ReceiveModal({ po, onClose }) {
  const { role, toast, refresh } = useApp();
  const open = po.lines.filter((l) => l.qty > l.received);
  const [v, setV] = useState(() => Object.fromEntries(open.map((l) => {
    const left = l.qty - l.received, fob = Math.min(Math.max(N(l.fob_qty) - 0, 0), left);
    return [l.id, { fob: String(fob), local: String(left - fob), wh: 'LA', cust: l.fob_customer || (po.fob_customer_codes || [])[0] || '' }];
  })));
  const set = (id, k, x) => setV((s) => ({ ...s, [id]: { ...s[id], [k]: x } }));
  const go = async () => {
    try {
      const rows = open.filter((l) => l.product_id && N(v[l.id].local) + N(v[l.id].fob) > 0)
        .map((l) => ({ line_id: l.id, local_qty: N(v[l.id].local), fob_qty: N(v[l.id].fob), warehouse: v[l.id].wh, fob_customer: v[l.id].cust }));
      await call(role, `select app.receive_po_split($1,$2)`, [po.id, JSON.stringify(rows)]);
      toast(`已入库：本地 ${rows.reduce((a, r) => a + r.local_qty, 0)} 件，FOB ${rows.reduce((a, r) => a + r.fob_qty, 0)} 件。金蝶入库在「金蝶同步 → 采购入库」`); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const mixed = po.purpose === 'mixed' || po.purpose === 'unknown' || !po.purpose;
  return (
    <Modal wide title={`到货入库 · ${po.po_no}`} onClose={onClose} footer={<><span className="small muted">没编码的行先让中方建编码</span><span className="grow" />
      <button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={go}>入库</button></>}>
      <div className="stack">
        <div className={`banner ${mixed ? 'warn' : 'info'}`}>{mixed ? `${po.purpose === 'mixed' ? 'FOB 和本地混装' : '国内备注认不出用途'}${po.fob_customer_codes?.length ? `（FOB 客户 ${po.fob_customer_codes.join(',')}）` : ''}：每行填本地多少、FOB 多少。` : `${PURPOSE[po.purpose][0]}${po.fob_customer_codes?.length ? `（${po.fob_customer_codes.join(',')}）` : ''}：已经按国内备注预分好了，核对实际到的数就行。`}<div className="small" style={{ fontWeight: 400 }}>国内备注：{po.remark || '没有'}</div></div>
        <Grid id="po-receive" noTools rows={open} columns={[
          { key: 'model', label: '型号', w: 150, value: (l) => l.model, render: (l) => <><ModelLink id={l.product_id} model={l.model} />{!l.product_id && <Pill tone="amber">没编码</Pill>}</> },
          { key: 'category', label: '种类', w: 110, value: (l) => l.category },
          { key: 'left', label: '还没到', w: 80, value: (l) => l.qty - l.received },
          { key: 'local', label: '本地备货', w: 90, fill: true, value: (l) => v[l.id].local, edit: (l) => ({ type: 'number', value: v[l.id].local, disabled: !l.product_id, onChange: (x) => set(l.id, 'local', String(x ?? '').replace(/\D/g, '')) }) },
          { key: 'wh', label: '进哪个仓', w: 90, value: (l) => v[l.id].wh, edit: (l) => ({ type: 'select', value: v[l.id].wh, options: [['LA', 'LA'], ['9S', '9S']], onChange: (x) => set(l.id, 'wh', x) }) },
          { key: 'fob', label: 'FOB', w: 80, fill: true, value: (l) => v[l.id].fob, edit: (l) => ({ type: 'number', value: v[l.id].fob, disabled: !l.product_id, onChange: (x) => set(l.id, 'fob', String(x ?? '').replace(/\D/g, '')) }) },
          { key: 'cust', label: 'FOB 客户', w: 100, mono: true, value: (l) => v[l.id].cust, edit: (l) => ({ type: 'text', value: v[l.id].cust, onChange: (x) => set(l.id, 'cust', String(x ?? '').toUpperCase()) }) },
        ]} />
      </div>
    </Modal>
  );
}

function SettingsModal({ s, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ cover: String(s.cover_days), sea: String(s.sea_days), air: String(s.air_days) });
  const go = async () => { try { await call(role, `select app.set_replenish_settings($1,$2,$3,$4)`, [org, Number(f.cover), Number(f.sea), Number(f.air)]); toast('已保存'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const inp = (k, l) => <div className="field"><label>{l}</label><input className="in" inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') })} style={{ maxWidth: 120 }} /></div>;
  return (
    <Modal title="备货天数（只中方）" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={go}>保存</button></>}>
      <div className="stack">{inp('cover', '备够几天的货')}{inp('sea', '海运到货要几天')}{inp('air', '空运到货要几天')}</div>
    </Modal>
  );
}
