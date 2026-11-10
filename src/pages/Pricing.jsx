// 物料与定价 (中方): the 飞书 Material Information formula, kept in the system.
// 到岸成本 = round(人民币成本 ÷ 汇率 + 运费, 百位); S / Wholesale / Retail / Repair = 到岸 + 各档 FEE.
// Edit cost / freight / FEE in the grid (columns highlighted), save → prices recomputed; a locked tier price (一口价) is never overwritten.
import React, { useMemo, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import ProductDrawer from '../components/ProductDrawer.jsx';
import { can, seesPrice } from '../lib/domain.js';
import { money, friendlyError, dt } from '../lib/format.js';

const N = (v) => (v === '' || v == null ? null : Number(v));
const TIERS4 = [['S', 'S', 'fee_s'], ['WHOLESALE', 'Wholesale', 'fee_a'], ['RETAIL', 'Retail', 'fee_b'], ['REPAIR', 'Repair', 'fee_c']];

export default function Pricing() {
  const { org, role, toast, refresh } = useApp();
  const admin = can(role, 'settings_thresholds');
  const [draft, setDraft] = useState({});        // product id -> partial edits
  const [cat, setCat] = useState('');
  const [openP, setOpenP] = useState(null);   // 点型号 → 物料档案 (和订单里同一个)
  const [busy, setBusy] = useState(false);
  const [lock, setLock] = useState(null);        // {p, tier, label}
  const [rates, setRates] = useState(null);
  const { data } = useData(async () => {
    const [rows, [s]] = await Promise.all([q(Q.productsPricing, [org]), q(Q.priceSettings, [org])]);
    return { rows, s: s || { rmb_per_xof: 0.0107, rmb_per_xof_fob: 0.01135, round_to: 100 } };
  }, [org]);
  const cats = useMemo(() => [...new Set((data?.rows || []).map((r) => r.category))], [data]);
  const pend = useRef({});
  if (role !== 'admin') return <div className="card card-b lock">价格清单只有中方能看。员工在订单批了以后能看到那一张单的价格。</div>;
  if (!data) return <div className="empty">加载中…</div>;
  const s = data.s;
  const rate = Number(s.rmb_per_xof), step = Number(s.round_to);
  const val = (r, k) => (draft[r.id] && k in draft[r.id] ? draft[r.id][k] : r[k]);
  const landed = (r) => { const c = N(val(r, 'rmb_cost')); return c == null ? null : Math.round((c / rate + (N(val(r, 'freight_xof')) || 0)) / step) * step; };
  const set = (r, k, v) => setDraft((d) => ({ ...d, [r.id]: { ...(d[r.id] || {}), [k]: v.replace(/[^\d.]/g, '') } }));
  const changed = Object.keys(draft);
  const rows = data.rows.filter((r) => !cat || r.category === cat);
  // 改一格存一格 (Frank 11-07): 带上这一行其他现值, 价格按公式立即重算
  const saveCell = async (r, k, v, meta) => {
    pend.current[r.id] = { ...(pend.current[r.id] || {}), [k]: v.replace(/[^\d.]/g, '') };
    const row = { ...r, ...pend.current[r.id] };
    if (!meta?.batch || meta.last) setTimeout(() => { pend.current = {}; }, 0);
    try { await call(role, `select app.set_product_cost($1,$2,$3,$4,$5,$6,$7)`, [r.id, N(row.rmb_cost), N(row.freight_xof), N(row.fee_s), N(row.fee_a), N(row.fee_b), N(row.fee_c)]); if (!meta?.batch || meta.last) { toast(meta?.batch ? `已保存 ${meta.total} 格，价格已重算` : '已保存，价格已重算'); refresh(); } }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const ed = (k) => (r) => (admin ? { type: 'number', value: r[k] ?? '', onChange: (v, m) => saveCell(r, k, v, m) } : null);
  const cols = [
    { key: 'code', label: '编码', w: 80, render: (r) => <span className="mono">{r.code}</span> },
    { key: 'category', label: '种类', w: 100 },
    { key: 'brand', label: '品牌', w: 80 },
    { key: 'model', label: '型号', w: 110, render: (r) => <button type="button" className="linkbtn" title="打开物料档案" onClick={(e) => { e.stopPropagation(); setOpenP(r); }}><b>{r.model}</b></button> },
    { key: 'variant', label: '区分', w: 120, render: (r) => (r.variant ? <span className="small">{r.variant}</span> : '') },
    { key: 'on_hand', label: '实存', w: 60 },
    { key: 'rmb_cost', label: '人民币成本', w: 100, edit: ed('rmb_cost'), render: (r) => r.rmb_cost ?? '—' },
    { key: 'freight_xof', label: '运费 XOF', w: 90, edit: ed('freight_xof'), render: (r) => r.freight_xof ?? '—' },
    { key: 'landed', label: '到岸成本 XOF', w: 110, value: landed, render: (r) => (landed(r) == null ? <span className="muted">缺成本</span> : <b>{money(landed(r))}</b>) },
    ...TIERS4.map(([tier, label, fk]) => ({ key: fk, label: `${label} FEE`, w: 90, edit: ed(fk), render: (r) => r[fk] ?? '—' })),
    ...TIERS4.map(([tier, label, fk]) => ({ key: `p_${tier}`, label: `${label} 价`, w: 120, value: (r) => r.prices[tier]?.price,
      render: (r) => {
        const cur = r.prices[tier]; const l = landed(r); const fee = N(val(r, fk));
        const calc = l != null && fee != null ? l + fee : null;
        const shown = cur?.locked ? Number(cur.price) : calc ?? (cur ? Number(cur.price) : null);
        return (
          <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            <b>{shown == null ? '—' : money(shown)}</b>
            {cur?.locked && <Pill tone="amber">一口价</Pill>}
            {admin && <button type="button" className="linkbtn" title={cur?.locked ? '解锁，跟公式走' : '锁定一口价'} onClick={() => setLock({ p: r, tier, label, cur })}>{cur?.locked ? '解锁' : '锁'}</button>}
          </span>);
      } })),
  ];
  const save = async () => {
    setBusy(true); let n = 0;
    try {
      for (const id of changed) {
        const r = data.rows.find((x) => x.id === id);
        await call(role, `select app.set_product_cost($1,$2,$3,$4,$5,$6,$7)`, [id, N(val(r, 'rmb_cost')), N(val(r, 'freight_xof')), N(val(r, 'fee_s')), N(val(r, 'fee_a')), N(val(r, 'fee_b')), N(val(r, 'fee_c'))]);
        n++;
      }
      toast(`已保存 ${n} 个物料，价格已按公式重算（一口价不动）`); setDraft({}); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const missing = data.rows.filter((r) => r.rmb_cost == null).length;
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Articles & prix</div><h1>物料与定价</h1>
        <div className="sub">规则照飞书 Material Information：到岸成本 = 人民币成本 ÷ {rate} + 运费，取整到 {step}；四档价 = 到岸成本 + 各档 FEE。改成本、运费、FEE 后保存，价格自动重算；锁定的一口价不跟公式走。</div></div>
        {admin && <button type="button" className="btn" onClick={() => setRates({ rate: String(s.rmb_per_xof), fob: String(s.rmb_per_xof_fob), round: String(s.round_to), usd: String(s.xof_per_usd ?? 600) })}>汇率与取整</button>}
      </div>
      <div className="card">
        <div className="card-b row" style={{ gap: 10 }}>
          <div className="chips"><button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>全部 {data.rows.length}</button>
            {cats.map((c) => <button type="button" key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}</div>
          <span className="grow" />
          {missing > 0 && <Pill tone="amber">{missing} 个物料缺人民币成本，算不出价格</Pill>}
          <span className="small muted">汇率更新：{s.updated_at ? dt(s.updated_at) : '默认值'}</span>
        </div>
        <Grid id="pricing" table="products" columns={cols} rows={rows} tools={admin ? <span className="hint">点一下选格子，再点一下改成本 / 运费 / FEE，改完自动保存并重算价格。</span> : null} />
        {!admin && <div className="card-b hint">只有中方能改成本、运费、FEE 和汇率。</div>}
      </div>
      {lock && <LockModal lock={lock} onClose={() => setLock(null)} />}
      {openP && <ProductDrawer product={openP} onClose={() => setOpenP(null)} />}
      {rates && <RatesModal org={org} rates={rates} setRates={setRates} onClose={() => setRates(null)} />}
    </>
  );
}

function LockModal({ lock, onClose }) {
  const { role, toast, refresh } = useApp();
  const [p, setP] = useState(lock.cur ? String(Number(lock.cur.price)) : '');
  const go = async (on) => {
    try { await call(role, `select app.set_tier_price($1,$2,$3,$4)`, [lock.p.id, lock.tier, on ? Number(p) : null, on]); toast(on ? `已锁定 ${lock.p.model} ${lock.label} 一口价 ${money(p)}` : '已解锁，跟公式走'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`${lock.p.model} ${lock.p.category} · ${lock.label} 价`} onClose={onClose}
      footer={<>{lock.cur?.locked && <button type="button" className="btn" onClick={() => go(false)}>解锁（跟公式走）</button>}<span className="grow" />
        <button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!(Number(p) >= 0) || p === ''} onClick={() => go(true)}>锁定一口价</button></>}>
      <div className="stack">
        <div className="hint">一口价（比如电池盖统一 700）锁定后，改成本或汇率都不会动它。</div>
        <input className="in" inputMode="decimal" autoFocus value={p} onChange={(e) => setP(e.target.value.replace(/[^\d.]/g, ''))} style={{ maxWidth: 200, fontSize: 18 }} />
      </div>
    </Modal>
  );
}

function RatesModal({ org, rates, setRates, onClose }) {
  const { role, toast, refresh } = useApp();
  const save = async () => {
    try { const n = (await call(role, `select app.set_price_settings($1,$2,$3,$4) as n`, [org, Number(rates.rate), Number(rates.fob), Number(rates.round)]))[0].n; if (Number(rates.usd) > 0) await call(role, `select app.set_usd_rate($1,$2)`, [org, Number(rates.usd)]); toast(`已保存，重算了 ${n} 个价格`); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="汇率与取整（只中方）" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={save}>保存并重算全部价格</button></>}>
      <div className="stack">
        <div className="field"><label>本地价汇率：1 XOF = ? RMB（飞书公式里的 0.0107）</label><input className="in" inputMode="decimal" value={rates.rate} onChange={(e) => setRates({ ...rates, rate: e.target.value })} style={{ maxWidth: 160 }} /></div>
        <div className="field"><label>FOB 成本汇率：1 XOF = ? RMB（飞书里的 0.01135）</label><input className="in" inputMode="decimal" value={rates.fob} onChange={(e) => setRates({ ...rates, fob: e.target.value })} style={{ maxWidth: 160 }} /></div>
        <div className="field"><label>美元汇率：1 USD = ? XOF（金蝶采购单是美元，物料档案里批次单价按它折西法）</label><input className="in" inputMode="decimal" value={rates.usd} onChange={(e) => setRates({ ...rates, usd: e.target.value })} style={{ maxWidth: 160 }} /></div>
        <div className="field"><label>到岸成本取整到</label><div className="seg">{['10', '50', '100', '500'].map((v) => <button type="button" key={v} className={rates.round === v ? 'on' : ''} onClick={() => setRates({ ...rates, round: v })}>{v}</button>)}</div></div>
        <div className="hint">汇率一改，所有有成本的物料都按新汇率重算；一口价不动。改之前想清楚：已经报出去、还没出销售订单的价格不会自动变，要在单子里点「获取价格」。</div>
      </div>
    </Modal>
  );
}
