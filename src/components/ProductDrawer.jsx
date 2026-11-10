// 物料档案 (点型号弹出; 订单里、物料与定价页都打开这一个, 以后档案怎么调各入口一起变).
// 员工: 基本信息 + 库存 + 这单客户档位的价. 中方 (see_cost) — Frank 11-09 13:41 / 14:45:
//   ① 机型信息 + 成本 (人民币 / 西法都显示)  ② 各档利润与加价  ③ 各档售价  一眼看清 成本 / 利润 / 最低底价 (= S 档)
//   ④ 采购批次: 每批单价按设置里「最新」汇率折成西法, 看哪批成本最高, 报价不亏
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { TierPill, useApp, useData, Drawer, Pill, BigNum, DatePicker } from './ui.jsx';
import { TIERS, can } from '../lib/domain.js';
import { money, qty, dDate, friendlyError, today } from '../lib/format.js';

const N = (v) => Number(v || 0);
const FEE = { S: 'fee_s', WHOLESALE: 'fee_a', RETAIL: 'fee_b', REPAIR: 'fee_c' };
const TIER_ORDER = ['S', 'WHOLESALE', 'RETAIL', 'REPAIR'];

export default function ProductDrawer({ product, tier, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const seeAll = can(role, 'see_cost');
  const seeTier = can(role, 'see_tier_price');
  const [tick, setTick] = useState(0);
  const { data } = useData(async () => {
    if (!product?.id) return null;
    const [[p], recent, batches, [ps]] = await Promise.all([
      q(`select p.*, c.name as category,
           coalesce((select jsonb_object_agg(pp.tier, jsonb_build_object('price', pp.price, 'locked', pp.locked)) from app.product_prices pp where pp.product_id = p.id and pp.currency = 'XOF'), '{}') as prices,
           coalesce((select jsonb_agg(jsonb_build_object('warehouse', w.code, 'bin', s.bin, 'on_hand', s.qty_on_hand, 'reserved', s.qty_reserved) order by w.code)
             from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = p.id), '[]') as stock
         from app.products p join app.categories c on c.id = p.category_id where p.id = $1`, [product.id]),
      seeAll ? q(`select d.biz_no, cu.name as customer, cu.tier, dl.unit_price, dl.qty_supply, d.created_at
                  from app.deal_lines dl join app.deals d on d.id = dl.deal_id join app.customers cu on cu.id = d.customer_id
                  where dl.product_id = $1 and d.status in ('shipped','partial') order by d.created_at desc limit 8`, [product.id]) : [],
      seeAll ? q(`select * from app.product_batches where product_id = $1 order by ordered_on desc nulls last, created_at desc`, [product.id]) : [],
      seeAll ? q(`select * from app.price_settings where org_id = $1`, [org]) : [null],
    ]);
    return { p, recent, batches, ps: ps || { rmb_per_xof: 0.0107, xof_per_usd: 600, round_to: 100 } };
  }, [product?.id, org, tick]);
  if (!product) return null;
  const p = data?.p || product;
  const stock = Array.isArray(p.stock) ? p.stock : [];
  const avail = stock.filter((s) => ['LA', '9S'].includes(s.warehouse)).reduce((a, s) => a + (N(s.on_hand) - N(s.reserved)), 0);
  const priceOf = (t) => { const v = p.prices?.[t]; return v == null ? null : typeof v === 'object' ? N(v.price) : N(v); };
  const lockedOf = (t) => !!(p.prices?.[t] && typeof p.prices[t] === 'object' && p.prices[t].locked);

  return (
    <Drawer title={<span>{p.model} <span className="muted small mono">{p.code}</span></span>} onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="kv">
          <div><div className="k">种类</div><div className="v">{p.category}</div></div>
          <div><div className="k">品牌 / 区分</div><div className="v">{p.brand || '—'}{p.variant ? ` · ${p.variant}` : ''}</div></div>
          <div><div className="k">金蝶名称</div><div className="v small">{p.kingdee_name || '—'}</div></div>
          <div><div className="k">通用性</div><div className="v">{(p.shared_models || []).length ? (p.shared_models || []).join(' / ') : '—'}</div></div>
        </div>
        {seeAll && data ? <CostBlocks p={p} ps={data.ps} batches={data.batches} tier={tier} priceOf={priceOf} lockedOf={lockedOf}
          onChanged={() => { setTick((x) => x + 1); refresh(); }} toast={toast} role={role} />
          : seeTier && tier ? (
            <div className="kv"><div><div className="k">本单客户档位价（{TIERS[tier]}）</div><div className="v" style={{ fontSize: 18 }}>{priceOf(tier) != null ? `${money(priceOf(tier))} XOF` : <Pill tone="amber">没定价，等中方</Pill>}</div></div></div>
          ) : <div className="hint">价格只有中方看得到。</div>}
        <div>
          <div className="pd-h">库存 <span className="muted small">LA / 9S 可售 <b>{qty(avail)}</b></span></div>
          <table className="t"><thead><tr><th>仓库</th><th>库位</th><th style={{ textAlign: 'right' }}>实存</th><th style={{ textAlign: 'right' }}>预占</th><th style={{ textAlign: 'right' }}>可售</th></tr></thead>
            <tbody>{stock.length === 0 ? <tr><td colSpan={5} className="muted">没有库存记录</td></tr> : stock.map((s, i) => <tr key={i}><td>{s.warehouse}</td><td className="mono">{s.bin || ''}</td><td style={{ textAlign: 'right' }}>{qty(s.on_hand)}</td><td style={{ textAlign: 'right' }}>{qty(s.reserved)}</td><td style={{ textAlign: 'right' }}><b>{qty(N(s.on_hand) - N(s.reserved))}</b></td></tr>)}</tbody></table>
        </div>
        {seeAll && data?.recent?.length > 0 && (
          <div>
            <div className="pd-h">最近成交（出库）</div>
            <table className="t"><thead><tr><th>日期</th><th>客户</th><th>档</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>单价</th></tr></thead>
              <tbody>{data.recent.map((r, i) => <tr key={i}><td>{dDate(r.created_at)}</td><td>{r.customer}</td><td><TierPill tier={r.tier} /></td><td style={{ textAlign: 'right' }}>{qty(r.qty_supply)}</td><td style={{ textAlign: 'right' }}>{money(r.unit_price)}</td></tr>)}</tbody></table>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function CostBlocks({ p, ps, batches, tier, priceOf, lockedOf, onChanged, toast, role }) {
  const rate = N(ps.rmb_per_xof) || 0.0107, usd = N(ps.xof_per_usd) || 600, step = N(ps.round_to) || 100;
  const freight = N(p.freight_xof);
  const rmb = p.rmb_cost != null ? N(p.rmb_cost) : null;
  const rawXof = rmb != null ? rmb / rate : null;
  const landed = rmb != null ? Math.round((rawXof + freight) / step) * step : null;   // 和定价公式一致
  const toXof = (b) => (b.currency === 'USD' ? N(b.unit_price) * usd : b.currency === 'XOF' ? N(b.unit_price) : N(b.unit_price) / rate);
  const bLanded = (b) => Math.round((toXof(b) + (b.freight_xof != null ? N(b.freight_xof) : freight)) / step) * step;
  const maxB = batches.length ? batches.reduce((m, b) => (bLanded(b) > bLanded(m) ? b : m), batches[0]) : null;
  const maxCost = maxB ? bLanded(maxB) : null;
  const worst = Math.max(landed ?? 0, maxCost ?? 0) || null;      // 最贵的成本 (当前 vs 各批次)
  const floor = priceOf('S');
  const floorLoss = floor != null && worst != null && floor < worst;
  const [adding, setAdding] = useState(null);

  return (
    <>
      {/* 一眼看清: 成本 / 利润 / 最低底价 */}
      <div className="pd-sum">
        <div><div className="k">到岸成本</div><BigNum size={24}>{landed != null ? <>{money(landed)} <small>XOF</small></> : <span className="muted">缺成本</span>}</BigNum>
          <div className="small muted">{rmb != null ? <>¥{rmb} ÷ {rate} ≈ {money(Math.round(rawXof))} + 运费 {money(freight)}</> : '去「物料与定价」填人民币成本'}</div></div>
        <div><div className="k">最低底价（S 档）</div><BigNum size={24} style={{ color: floorLoss ? 'var(--red)' : undefined }}>{floor != null ? <>{money(floor)} <small>XOF</small></> : <span className="muted">没定价</span>}</BigNum>
          <div className="small muted">{floor != null && landed != null ? <>比成本多赚 <b>{money(floor - landed)}</b>{floorLoss ? '，但低于最贵一批成本，会亏' : ''}</> : ''}</div></div>
        <div><div className="k">最贵一批成本</div><BigNum size={24}>{maxCost != null ? <>{money(maxCost)} <small>XOF</small></> : <span className="muted">没有批次</span>}</BigNum>
          <div className="small muted">{maxB ? `${maxB.po_no || '手录'} · ${dDate(maxB.ordered_on) || ''}` : '下面「采购批次」里加'}</div></div>
      </div>
      {floorLoss && <div className="banner warn">S 档价 {money(floor)} 低于最贵一批的成本 {money(worst)}：按这批货卖会亏，考虑调高加价或锁一口价。</div>}

      {/* ② 各档利润与加价 */}
      <div>
        <div className="pd-h">各档利润与加价 <span className="muted small">利润 = 售价 − 到岸成本；括号里是按最贵一批算</span></div>
        <table className="t"><thead><tr><th>档位</th><th style={{ textAlign: 'right' }}>加价（FEE）</th><th style={{ textAlign: 'right' }}>利润</th><th style={{ textAlign: 'right' }}>利润率</th></tr></thead>
          <tbody>{TIER_ORDER.map((t) => {
            const pr = priceOf(t); const prof = pr != null && landed != null ? pr - landed : null; const profW = pr != null && maxCost != null ? pr - maxCost : null;
            return (<tr key={t} className={tier === t ? 'pd-cur' : ''}><td><TierPill tier={t} />{tier === t ? ' ← 本单' : ''}</td>
              <td style={{ textAlign: 'right' }}>{p[FEE[t]] != null ? money(p[FEE[t]]) : '—'}</td>
              <td style={{ textAlign: 'right' }}>{prof != null ? <b className={prof < 0 ? 'red-t2' : ''}>{money(prof)}</b> : '—'}{profW != null && profW !== prof && <span className={`small ${profW < 0 ? 'red-t2' : 'muted'}`}>（{money(profW)}）</span>}</td>
              <td style={{ textAlign: 'right' }}>{prof != null && landed ? `${(prof / landed * 100).toFixed(1)}%` : '—'}</td></tr>);
          })}</tbody></table>
      </div>

      {/* ③ 各档售价 */}
      <div>
        <div className="pd-h">各档售价 <span className="muted small">= 到岸成本 + 加价；🔒 = 一口价，不跟成本变</span></div>
        <table className="t"><thead><tr>{TIER_ORDER.map((t) => <th key={t} style={{ textAlign: 'right' }}><TierPill tier={t} />{tier === t ? ' ←本单' : ''}</th>)}</tr></thead>
          <tbody><tr>{TIER_ORDER.map((t) => <td key={t} style={{ textAlign: 'right', fontWeight: tier === t ? 700 : 400, fontSize: 16 }}>{priceOf(t) != null ? <>{lockedOf(t) && '🔒 '}{money(priceOf(t))}</> : <span className="muted">没定价</span>}</td>)}</tr></tbody></table>
        <div className="small muted" style={{ marginTop: 4 }}>{p.cost_updated_at ? `成本更新 ${dDate(p.cost_updated_at)} · ` : ''}汇率 1 XOF = {rate} RMB · 1 USD = {money(usd)} XOF（在「物料与定价 → 汇率与取整」改）</div>
      </div>

      {/* ④ 采购批次 */}
      <div>
        <div className="pd-h row between"><span>采购批次 <span className="muted small">每批单价按最新汇率折成西法；金蝶采购单是美元</span></span>
          {role === 'admin' && !adding && <button type="button" className="btn sm" onClick={() => setAdding({ po_no: '', ordered_on: today(), qty: '', currency: 'CNY', unit_price: '', freight_xof: '' })}>＋ 加一批</button>}</div>
        <table className="t"><thead><tr><th>采购单号</th><th>日期</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>采购单价</th><th style={{ textAlign: 'right' }}>折合 XOF</th><th style={{ textAlign: 'right' }}>到岸（+运费）</th><th style={{ textAlign: 'right' }}>比当前成本</th>{role === 'admin' && <th />}</tr></thead>
          <tbody>
            {batches.length === 0 && !adding && <tr><td colSpan={8} className="muted">还没有批次。点「＋ 加一批」，或在「数据导入 → 采购批次」导金蝶采购订单。</td></tr>}
            {batches.map((b) => { const L = bLanded(b); const d = landed != null ? L - landed : null; return (
              <tr key={b.id} className={maxB && b.id === maxB.id && batches.length > 1 ? 'pd-max' : ''}>
                <td className="mono">{b.po_no || '—'}{b.source === 'kingdee' && <span className="muted small"> 金蝶</span>}</td><td>{dDate(b.ordered_on) || '—'}</td>
                <td style={{ textAlign: 'right' }}>{qty(b.qty)}</td>
                <td style={{ textAlign: 'right' }}>{b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : ''}{+N(b.unit_price).toFixed(b.currency === 'USD' ? 4 : 2)}</td>
                <td style={{ textAlign: 'right' }}>{money(Math.round(toXof(b)))}</td>
                <td style={{ textAlign: 'right' }}><b>{money(L)}</b>{maxB && b.id === maxB.id && batches.length > 1 && <span className="small red-t2"> 最贵</span>}</td>
                <td style={{ textAlign: 'right' }} className={d > 0 ? 'red-t2' : d < 0 ? 'green-t2' : ''}>{d == null ? '—' : d === 0 ? '持平' : `${d > 0 ? '+' : ''}${money(d)}`}</td>
                {role === 'admin' && <td><button type="button" className="btn sm ghost" title="删掉这批" onClick={async () => { try { await call(role, `select app.delete_product_batch($1)`, [b.id]); toast('已删掉这批'); onChanged(); } catch (e) { toast(friendlyError(e), 'err'); } }}>删</button></td>}
              </tr>); })}
            {adding && <BatchForm p={p} f={adding} setF={setAdding} role={role} toast={toast} onDone={() => { setAdding(null); onChanged(); }} />}
          </tbody></table>
      </div>
    </>
  );
}

function BatchForm({ p, f, setF, role, toast, onDone }) {
  const set = (k) => (e) => setF({ ...f, [k]: typeof e === 'string' ? e : e.target.value });
  const save = async () => {
    try { await call(role, `select app.save_product_batch($1,null,$2)`, [p.id, JSON.stringify({ ...f, qty: Number(f.qty), unit_price: Number(f.unit_price), freight_xof: f.freight_xof === '' ? null : Number(f.freight_xof) })]); toast('这批已记下'); onDone(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <tr className="pd-add">
      <td><input className="in sm" value={f.po_no} onChange={set('po_no')} placeholder="PO…" /></td>
      <td><DatePicker value={f.ordered_on} onChange={set('ordered_on')} /></td>
      <td><input className="in sm" inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} style={{ width: 70 }} /></td>
      <td><span className="row" style={{ gap: 4 }}><select className="in sm" value={f.currency} onChange={set('currency')}><option value="CNY">¥</option><option value="USD">$</option><option value="XOF">XOF</option></select>
        <input className="in sm" inputMode="decimal" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value.replace(/[^\d.]/g, '') })} style={{ width: 80 }} /></span></td>
      <td colSpan={2}><input className="in sm" inputMode="decimal" value={f.freight_xof} onChange={(e) => setF({ ...f, freight_xof: e.target.value.replace(/[^\d.]/g, '') })} placeholder={`每件运费（空=${p.freight_xof ?? 0}）`} /></td>
      <td colSpan={2}><span className="row" style={{ gap: 4 }}><button type="button" className="btn sm primary" disabled={!(Number(f.qty) > 0) || f.unit_price === ''} onClick={save}>记下</button><button type="button" className="btn sm ghost" onClick={() => setF(null)}>取消</button></span></td>
    </tr>
  );
}
