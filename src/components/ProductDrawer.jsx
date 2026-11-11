// 物料档案 (点型号弹出; 订单里、物料与定价页都打开这一个, 以后档案怎么调各入口一起变).
// 员工: 基本信息 + 库存 + 这单客户档位的价. 中方 (see_cost):
//   分块 (Frank 11-11 206): ① 基本信息 ② 成本 (采购价 + 运费 = 到岸, 实际值 → 进位) ③ 利润 ④ 各档售价 ⑤ 采购批次 ⑥ 库存 ⑦ 修改记录
//   档案里直接改: 「✎ 修改」解锁一次 → 改几项 → 保存前列出 改前 → 改后 + 自检 (低于成本红 / 运费没填黄 / 档位倒挂黄 / 改动太大黄) → 确认后存 + 留记录, 自动锁回
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { TierPill, useApp, useData, Drawer, Pill, BigNum, DatePicker, Modal, Info } from './ui.jsx';
import { TIERS, can } from '../lib/domain.js';
import { money, qty, dDate, dt, friendlyError, today } from '../lib/format.js';

const N = (v) => Number(v || 0);
const FEE = { S: 'fee_s', WHOLESALE: 'fee_a', RETAIL: 'fee_b', REPAIR: 'fee_c' };
const TIER_ORDER = ['S', 'WHOLESALE', 'RETAIL', 'REPAIR'];
const ceilTo = (v, s) => Math.ceil(v / s) * s;
const BIG_CHANGE = 0.2;   // 改动超过 20% 黄色提醒

// 成本口径 (和数据库 app.landed_cost / app.batch_freight 一致): 到岸 = 采购价折西法 + 每片运费, 向上进到 round_to; 批次每片运费 = 总运费 ÷ 总片数 向上进 50
export function costModel(p, ps, batches = []) {
  const rate = N(ps?.rmb_per_xof) || 0.0107, usd = N(ps?.xof_per_usd) || 600, step = N(ps?.round_to) || 100;
  const defFreight = p.freight_xof != null && p.freight_xof !== '' ? N(p.freight_xof) : null;
  const rmb = p.rmb_cost != null && p.rmb_cost !== '' ? N(p.rmb_cost) : null;
  const rawXof = rmb != null ? rmb / rate : null;
  const raw = rmb != null ? rawXof + (defFreight ?? 0) : null;
  const landed = raw != null ? ceilTo(raw, step) : null;
  const toXof = (b) => (b.currency === 'USD' ? N(b.unit_price) * usd : b.currency === 'XOF' ? N(b.unit_price) : N(b.unit_price) / rate);
  const bFreight = (b) => (N(b.freight_total) > 0 && N(b.freight_pieces) > 0 ? { v: ceilTo(N(b.freight_total) / N(b.freight_pieces), 50), how: 'batch' }
    : b.freight_xof != null ? { v: N(b.freight_xof), how: 'piece' } : defFreight != null ? { v: defFreight, how: 'default' } : { v: 0, how: 'none' });
  const bRaw = (b) => toXof(b) + bFreight(b).v;
  const bLanded = (b) => ceilTo(bRaw(b), step);
  const maxB = batches.length ? batches.reduce((m, b) => (bLanded(b) > bLanded(m) ? b : m), batches[0]) : null;
  return { rate, usd, step, defFreight, rmb, rawXof, raw, landed, toXof, bFreight, bRaw, bLanded, maxB, maxCost: maxB ? bLanded(maxB) : null };
}

// 自检: 红 = 肯定有问题, 黄 = 可能有问题 (Frank 11-11 208 三色)
export function priceChecks(prices, cm, old = {}) {
  const out = [];
  const worst = Math.max(cm.landed ?? 0, cm.maxCost ?? 0) || null;
  if (cm.defFreight == null) out.push({ tone: 'amber', msg: '每片运费没填，成本里没算运费（不当 0 算）' });
  for (const t of TIER_ORDER) {
    const v = prices[t]; if (v == null || v === '') continue;
    if (worst != null && N(v) < worst) out.push({ tone: 'red', msg: `${TIERS[t]} ${money(v)} 低于成本 ${money(worst)}（实际 ${money(Math.round(Math.max(cm.raw ?? 0, cm.maxB ? cm.bRaw(cm.maxB) : 0)))}），会亏` });
    if (old[t] != null && N(old[t]) > 0 && Math.abs(N(v) - N(old[t])) / N(old[t]) > BIG_CHANGE) out.push({ tone: 'amber', msg: `${TIERS[t]} 从 ${money(old[t])} 改到 ${money(v)}，变动超过 ${BIG_CHANGE * 100}%` });
  }
  for (let i = 1; i < TIER_ORDER.length; i += 1) {
    const a = prices[TIER_ORDER[i - 1]], b = prices[TIER_ORDER[i]];
    if (a != null && b != null && a !== '' && b !== '' && N(b) < N(a)) out.push({ tone: 'amber', msg: `档位倒挂：${TIERS[TIER_ORDER[i]]} ${money(b)} 比 ${TIERS[TIER_ORDER[i - 1]]} ${money(a)} 还便宜` });
  }
  return out;
}

export default function ProductDrawer({ product, tier, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const seeAll = can(role, 'see_cost');
  const seeTier = can(role, 'see_tier_price');
  const [tick, setTick] = useState(0);
  const { data } = useData(async () => {
    if (!product?.id) return null;
    const [[p], recent, batches, [ps], cats, hist] = await Promise.all([
      q(`select p.*, c.name as category,
           coalesce((select jsonb_object_agg(pp.tier, jsonb_build_object('price', pp.price, 'locked', pp.locked)) from app.product_prices pp where pp.product_id = p.id and pp.currency = 'XOF'), '{}') as prices,
           coalesce((select jsonb_agg(jsonb_build_object('warehouse', w.code, 'bin', s.bin, 'on_hand', s.qty_on_hand, 'reserved', s.qty_reserved) order by w.code)
             from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = p.id), '[]') as stock
         from app.products p join app.categories c on c.id = p.category_id where p.id = $1`, [product.id]),
      seeAll ? q(`select d.biz_no, d.id as deal_id, cu.name as customer, cu.tier, dl.unit_price, dl.qty_supply, d.created_at
                  from app.deal_lines dl join app.deals d on d.id = dl.deal_id join app.customers cu on cu.id = d.customer_id
                  where dl.product_id = $1 and d.status in ('shipped','partial') order by d.created_at desc limit 8`, [product.id]) : [],
      seeAll ? q(`select * from app.product_batches where product_id = $1 order by ordered_on desc nulls last, created_at desc`, [product.id]) : [],
      seeAll ? q(`select * from app.price_settings where org_id = $1`, [org]) : [null],
      role === 'admin' ? q(`select id, name from app.categories where org_id = $1 order by sort_order nulls last, name`, [org]).catch(() => q(`select id, name from app.categories where org_id = $1 order by name`, [org])) : [],
      seeAll ? call(role, `select * from app.archive_history($1,'product',$2)`, [org, product.id]).catch(() => []) : [],
    ]);
    return { p, recent, batches, cats, hist, ps: ps || { rmb_per_xof: 0.0107, xof_per_usd: 600, round_to: 100 } };
  }, [product?.id, org, tick]);
  const [ed, setEd] = useState(null);       // 解锁后的草稿
  const [confirm, setConfirm] = useState(null);
  if (!product) return null;
  const p = data?.p || product;
  const stock = Array.isArray(p.stock) ? p.stock : [];
  const avail = stock.filter((s) => ['LA', '9S'].includes(s.warehouse)).reduce((a, s) => a + (N(s.on_hand) - N(s.reserved)), 0);
  const priceOf = (t) => { const v = p.prices?.[t]; return v == null ? null : typeof v === 'object' ? N(v.price) : N(v); };
  const lockedOf = (t) => !!(p.prices?.[t] && typeof p.prices[t] === 'object' && p.prices[t].locked);
  const canEdit = role === 'admin' && !!data;
  const changed = () => { setTick((x) => x + 1); refresh(); };

  const unlock = () => setEd({
    category_id: p.category_id, brand: p.brand || '', variant: p.variant || '', shared: (p.shared_models || []).join(' / '),
    rmb_cost: p.rmb_cost ?? '', freight_xof: p.freight_xof ?? '', fee_s: p.fee_s ?? '', fee_a: p.fee_a ?? '', fee_b: p.fee_b ?? '', fee_c: p.fee_c ?? '',
    prices: Object.fromEntries(TIER_ORDER.map((t) => [t, priceOf(t) ?? ''])),
  });
  // 保存前: 改前 → 改后 + 自检
  const review = () => {
    const rows = [];
    const cat = (id) => data.cats.find((c) => c.id === id)?.name || p.category;
    const cmp = (label, a, b, fmt = (x) => (x === '' || x == null ? '—' : String(x))) => { if (String(a ?? '') !== String(b ?? '')) rows.push([label, fmt(a), fmt(b)]); };
    cmp('种类', p.category, cat(ed.category_id));
    cmp('品牌', p.brand || '', ed.brand); cmp('区分', p.variant || '', ed.variant); cmp('通用性', (p.shared_models || []).join(' / '), ed.shared);
    cmp('人民币成本', p.rmb_cost ?? '', ed.rmb_cost); cmp('每片运费', p.freight_xof ?? '', ed.freight_xof);
    for (const t of TIER_ORDER) cmp(`${TIERS[t]} 加价`, p[FEE[t]] ?? '', ed[FEE[t]]);
    for (const t of TIER_ORDER) cmp(`${TIERS[t]} 售价`, priceOf(t) ?? '', ed.prices[t], (x) => (x === '' || x == null ? '—' : money(x)));
    if (!rows.length) { setEd(null); return toast('没有改动，已锁回'); }
    const cm = costModel({ ...p, rmb_cost: ed.rmb_cost, freight_xof: ed.freight_xof }, data.ps, data.batches);
    // 售价: 手填的 = 一口价; 没手改的跟新公式 (到岸 + 加价)
    const next = Object.fromEntries(TIER_ORDER.map((t) => {
      const manual = String(ed.prices[t]) !== String(priceOf(t) ?? '');
      const formula = cm.landed != null && ed[FEE[t]] !== '' ? cm.landed + N(ed[FEE[t]]) : priceOf(t);
      return [t, manual ? ed.prices[t] : lockedOf(t) ? priceOf(t) : formula];
    }));
    setConfirm({ rows, checks: priceChecks(next, cm, Object.fromEntries(TIER_ORDER.map((t) => [t, priceOf(t)]))), next });
  };
  const save = async (reason) => {
    const { rows, checks } = confirm;
    try {
      const info = {};
      if (ed.category_id !== p.category_id) info.category_id = ed.category_id;
      if ((p.brand || '') !== ed.brand) info.brand = ed.brand;
      if ((p.variant || '') !== ed.variant) info.variant = ed.variant;
      if ((p.shared_models || []).join(' / ') !== ed.shared) info.shared_models = ed.shared.split(/[/,，、]/).map((x) => x.trim()).filter(Boolean);
      if (Object.keys(info).length) await call(role, `select app.edit_product_info($1,$2)`, [p.id, JSON.stringify(info)]);
      const costKeys = ['rmb_cost', 'freight_xof', 'fee_s', 'fee_a', 'fee_b', 'fee_c'];
      if (costKeys.some((k) => String(p[k] ?? '') !== String(ed[k] ?? ''))) {
        const nn = (k) => (ed[k] === '' ? null : Number(ed[k]));
        await call(role, `select app.set_product_cost($1,$2,$3,$4,$5,$6,$7)`, [p.id, nn('rmb_cost'), nn('freight_xof'), nn('fee_s'), nn('fee_a'), nn('fee_b'), nn('fee_c')]);
      }
      for (const t of TIER_ORDER) {
        if (String(ed.prices[t]) !== String(priceOf(t) ?? '') && ed.prices[t] !== '') await call(role, `select app.set_tier_price($1,$2,$3,true)`, [p.id, t, Number(ed.prices[t])]);
      }
      await call(role, `select app.log_archive_edit($1,'product',$2,$3,$4,$5)`, [org, p.id, JSON.stringify(Object.fromEntries(rows.map(([l, a, b]) => [l, [a, b]]))), JSON.stringify(checks.map((c) => `${c.tone === 'red' ? '红' : '黄'}：${c.msg}`)), reason || null]);
      toast(`已保存 ${rows.length} 项，档案已锁回`); setConfirm(null); setEd(null); changed();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };

  return (
    <Drawer title={<span>{p.model} <span className="muted small mono">{p.code}</span></span>} onClose={onClose}
      actions={canEdit && seeAll ? (ed ? <><button type="button" className="btn sm" onClick={() => setEd(null)}>取消修改</button><button type="button" className="btn sm primary" onClick={review}>保存修改…</button></>
        : <button type="button" className="btn sm" onClick={unlock} title="解锁后可以在档案里直接改；保存前会列出改了什么并自检">✎ 修改</button>) : null}>
      <div className="stack" style={{ gap: 12 }}>
        {ed && <div className="banner info">已解锁：改完点右上角「保存修改…」，会先列出改了什么、做自检，确认后才存；存完自动锁回。</div>}
        {/* ① 基本信息 */}
        <section className="pd-sec">
          <div className="pd-h">① 基本信息</div>
          {ed ? (
            <div className="pd-form">
              <label>种类<select className="in" value={ed.category_id} onChange={(e) => setEd({ ...ed, category_id: e.target.value })}>{data.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>品牌<input className="in" value={ed.brand} onChange={(e) => setEd({ ...ed, brand: e.target.value.toUpperCase() })} placeholder="TECNO / ITEL / SS…" /></label>
              <label>区分<input className="in" value={ed.variant} onChange={(e) => setEd({ ...ed, variant: e.target.value })} /></label>
              <label className="wide">通用性（用 / 隔开）<input className="in" value={ed.shared} onChange={(e) => setEd({ ...ed, shared: e.target.value.toUpperCase() })} /></label>
            </div>
          ) : (
            <div className="kv">
              <div><div className="k">种类</div><div className="v">{p.category}</div></div>
              <div><div className="k">品牌 / 区分</div><div className="v">{p.brand || '—'}{p.variant ? ` · ${p.variant}` : ''}</div></div>
              <div><div className="k">金蝶名称</div><div className="v small">{p.kingdee_name || '—'}</div></div>
              <div><div className="k">通用性</div><div className="v">{(p.shared_models || []).length ? (p.shared_models || []).join(' / ') : '—'}</div></div>
            </div>
          )}
        </section>
        {seeAll && data ? <CostBlocks p={p} ps={data.ps} batches={data.batches} tier={tier} priceOf={priceOf} lockedOf={lockedOf} ed={ed} setEd={setEd}
          onChanged={changed} toast={toast} role={role} />
          : seeTier && tier ? (
            <section className="pd-sec"><div className="kv"><div><div className="k">本单客户档位价（{TIERS[tier]}）</div><div className="v" style={{ fontSize: 18 }}>{priceOf(tier) != null ? `${money(priceOf(tier))} XOF` : <Pill tone="amber">没定价，等中方</Pill>}</div></div></div></section>
          ) : <div className="hint">价格只有中方看得到。</div>}
        {/* ⑥ 库存 */}
        <section className="pd-sec">
          <div className="pd-h">⑥ 库存 <span className="muted small">LA / 9S 可售 <b>{qty(avail)}</b></span></div>
          <table className="t"><thead><tr><th>仓库</th><th>库位</th><th style={{ textAlign: 'right' }}>实存</th><th style={{ textAlign: 'right' }}>预占</th><th style={{ textAlign: 'right' }}>可售</th></tr></thead>
            <tbody>{stock.length === 0 ? <tr><td colSpan={5} className="muted">没有库存记录</td></tr> : stock.map((s, i) => <tr key={i}><td>{s.warehouse}</td><td className="mono">{s.bin || ''}</td><td style={{ textAlign: 'right' }}>{qty(s.on_hand)}</td><td style={{ textAlign: 'right' }}>{qty(s.reserved)}</td><td style={{ textAlign: 'right' }}><b>{qty(N(s.on_hand) - N(s.reserved))}</b></td></tr>)}</tbody></table>
        </section>
        {seeAll && data?.recent?.length > 0 && (
          <section className="pd-sec">
            <div className="pd-h">最近成交（出库）</div>
            <table className="t"><thead><tr><th>日期</th><th>客户</th><th>档</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>单价</th></tr></thead>
              <tbody>{data.recent.map((r, i) => <tr key={i}><td>{dDate(r.created_at)}</td><td>{r.customer}</td><td><TierPill tier={r.tier} /></td><td style={{ textAlign: 'right' }}>{qty(r.qty_supply)}</td><td style={{ textAlign: 'right' }}>{money(r.unit_price)}</td></tr>)}</tbody></table>
          </section>
        )}
        {seeAll && data && <HistoryBlock hist={data.hist} />}
      </div>
      {confirm && <ConfirmEdit c={confirm} onBack={() => setConfirm(null)} onSave={save} />}
    </Drawer>
  );
}

// 保存前确认: 改前 → 改后 + 自检; 有红色的必须写原因
export function ConfirmEdit({ c, onBack, onSave, title = '确认修改档案' }) {
  const [reason, setReason] = useState('');
  const red = c.checks.some((x) => x.tone === 'red');
  return (
    <Modal title={title} onClose={onBack}
      footer={<><button type="button" className="btn" onClick={onBack}>回去再改</button><span className="grow" />{red && !reason.trim() && <span className="why">有红色报警，写原因才能存</span>}
        <button type="button" className="btn primary" disabled={red && !reason.trim()} onClick={() => onSave(reason.trim())}>确认保存</button></>}>
      <div className="stack">
        <table className="t"><thead><tr><th>项目</th><th>改前</th><th>改后</th></tr></thead>
          <tbody>{c.rows.map(([l, a, b]) => <tr key={l}><td>{l}</td><td className="muted">{a}</td><td><b>{b}</b></td></tr>)}</tbody></table>
        <div className="pd-h">自检 {c.checks.length === 0 && <span className="pill green">没发现问题</span>}</div>
        {c.checks.map((x, i) => <div key={i} className={`pill ${x.tone}`} style={{ display: 'block', whiteSpace: 'normal' }}>{x.tone === 'red' ? '✕ ' : '⚠ '}{x.msg}</div>)}
        <label className="field"><span>原因{red ? '（必填）' : '（可不填）'}</span><input className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 新批次到货，成本变了" /></label>
      </div>
    </Modal>
  );
}

export function HistoryBlock({ hist, title = '⑦ 修改记录' }) {
  const [all, setAll] = useState(false);
  const rows = (hist || []).filter((h) => h.action === 'archive_edit' || h.action === 'save_product_batch');
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <section className="pd-sec">
      <div className="pd-h">{title} <span className="muted small">{rows.length} 次</span></div>
      {rows.length === 0 ? <div className="muted small">还没有修改记录</div> : (
        <div className="stack" style={{ gap: 6 }}>
          {shown.map((h, i) => (
            <div key={i} className="hist-row">
              <div className="small muted">{dt(h.at)} · <b>{h.by_name}</b>{h.detail?.reason ? ` · 原因：${h.detail.reason}` : ''}</div>
              {h.action === 'save_product_batch' ? <div className="small">记了一批采购 {h.detail?.po_no || ''}</div>
                : Object.entries(h.detail?.changes || {}).map(([k, [a, b]]) => <div key={k} className="small">{k}：<span className="muted">{a}</span> → <b>{b}</b></div>)}
              {(h.detail?.warnings || []).map((w, j) => <div key={j} className={`small ${w.startsWith('红') ? 'red-t2' : 'amber-t'}`}>{w}</div>)}
            </div>
          ))}
          {rows.length > 5 && <button type="button" className="btn sm ghost" onClick={() => setAll(!all)}>{all ? '收起' : `看全部 ${rows.length} 次`}</button>}
        </div>
      )}
    </section>
  );
}

function CostBlocks({ p, ps, batches, tier, priceOf, lockedOf, ed, setEd, onChanged, toast, role }) {
  const cm = costModel(ed ? { ...p, rmb_cost: ed.rmb_cost, freight_xof: ed.freight_xof } : p, ps, batches);
  const { rate, usd, rmb, rawXof, raw, landed, defFreight, maxB, maxCost } = cm;
  const worst = Math.max(landed ?? 0, maxCost ?? 0) || null;
  const floor = priceOf('S');
  const floorLoss = floor != null && worst != null && floor < worst;
  const [adding, setAdding] = useState(null);
  const numIn = (k, w = 90) => <input className="in sm" inputMode="decimal" style={{ width: w }} value={ed[k]} onChange={(e) => setEd({ ...ed, [k]: e.target.value.replace(/[^\d.]/g, '') })} />;

  return (
    <>
      {/* ② 成本 */}
      <section className="pd-sec">
        <div className="pd-h">② 成本 <Info>到岸成本 = 人民币采购价 ÷ 汇率 + 每片运费，向上进到 {cm.step}（417 → 500）。批次运费 = 这批总运费 ÷ 总片数，每片向上进 50。</Info></div>
        {ed && (
          <div className="pd-form">
            <label>人民币成本 ¥{numIn('rmb_cost')}</label>
            <label>每片运费 XOF{numIn('freight_xof')}</label>
          </div>
        )}
        <div className="pd-sum">
          <div><div className="k">到岸成本</div><BigNum size={24}>{landed != null ? <>{money(landed)} <small>XOF</small></> : <span className="muted">缺成本</span>}</BigNum>
            <div className="small muted">{rmb != null ? <>¥{rmb} ÷ {rate} ≈ {money(Math.round(rawXof))} + 运费 {defFreight != null ? money(defFreight) : <span className="pill amber">没填</span>}</> : '去「物料与定价」填人民币成本'}</div>
            {raw != null && <div className="small">实际 <b>{money(Math.round(raw))}</b> → 进到 <b>{money(landed)}</b>（+{money(landed - Math.round(raw))}）</div>}</div>
          <div><div className="k">最低底价（S 档）</div><BigNum size={24} style={{ color: floorLoss ? 'var(--red)' : undefined }}>{floor != null ? <>{money(floor)} <small>XOF</small></> : <span className="muted">没定价</span>}</BigNum>
            <div className="small muted">{floor != null && landed != null ? <>比成本多赚 <b>{money(floor - landed)}</b>{floorLoss ? '，但低于最贵一批成本，会亏' : ''}</> : ''}</div></div>
          <div><div className="k">最贵一批成本</div><BigNum size={24}>{maxCost != null ? <>{money(maxCost)} <small>XOF</small></> : <span className="muted">没有批次</span>}</BigNum>
            <div className="small muted">{maxB ? <>{maxB.po_no || '手录'} · {dDate(maxB.ordered_on) || ''} · 实际 {money(Math.round(cm.bRaw(maxB)))}{cm.bFreight(maxB).how === 'none' && <span className="pill amber">运费没填</span>}</> : '下面「采购批次」里加'}</div></div>
        </div>
        {defFreight == null && <div className="pill amber" style={{ display: 'block', whiteSpace: 'normal', marginTop: 6 }}>⚠ 每片运费没填：成本里没算运费，售价可能偏低</div>}
        {floorLoss && <div className="pill red" style={{ display: 'block', whiteSpace: 'normal', marginTop: 6 }}>✕ S 档价 {money(floor)} 低于最贵一批的成本 {money(worst)}：按这批货卖会亏</div>}
      </section>

      {/* ③ 利润 */}
      <section className="pd-sec">
        <div className="pd-h">③ 各档利润与加价 <Info>利润 = 售价 − 到岸成本；括号里是按最贵一批算</Info></div>
        <table className="t"><thead><tr><th>档位</th><th style={{ textAlign: 'right' }}>加价（FEE）</th><th style={{ textAlign: 'right' }}>利润</th><th style={{ textAlign: 'right' }}>利润率</th></tr></thead>
          <tbody>{TIER_ORDER.map((t) => {
            const pr = priceOf(t); const prof = pr != null && landed != null ? pr - landed : null; const profW = pr != null && maxCost != null ? pr - maxCost : null;
            return (<tr key={t} className={tier === t ? 'pd-cur' : ''}><td><TierPill tier={t} />{tier === t ? ' ← 本单' : ''}</td>
              <td style={{ textAlign: 'right' }}>{ed ? numIn(FEE[t], 80) : p[FEE[t]] != null ? money(p[FEE[t]]) : '—'}</td>
              <td style={{ textAlign: 'right' }}>{prof != null ? <b className={prof < 0 ? 'red-t2' : ''}>{money(prof)}</b> : '—'}{profW != null && profW !== prof && <span className={`small ${profW < 0 ? 'red-t2' : 'muted'}`}>（{money(profW)}）</span>}</td>
              <td style={{ textAlign: 'right' }}>{prof != null && landed ? `${(prof / landed * 100).toFixed(1)}%` : '—'}</td></tr>);
          })}</tbody></table>
      </section>

      {/* ④ 各档售价 */}
      <section className="pd-sec">
        <div className="pd-h">④ 各档售价 <Info>= 到岸成本 + 加价；🔒 = 一口价，不跟成本变。解锁后直接填售价 = 锁成一口价。</Info></div>
        <table className="t"><thead><tr>{TIER_ORDER.map((t) => <th key={t} style={{ textAlign: 'right' }}><TierPill tier={t} />{tier === t ? ' ←本单' : ''}</th>)}</tr></thead>
          <tbody><tr>{TIER_ORDER.map((t) => <td key={t} style={{ textAlign: 'right', fontWeight: tier === t ? 700 : 400, fontSize: 16 }}>
            {ed ? <input className="in sm" inputMode="decimal" style={{ width: 90, textAlign: 'right' }} value={ed.prices[t]} onChange={(e) => setEd({ ...ed, prices: { ...ed.prices, [t]: e.target.value.replace(/[^\d.]/g, '') } })} />
              : priceOf(t) != null ? <>{lockedOf(t) && '🔒 '}{money(priceOf(t))}{worst != null && priceOf(t) < worst && <span className="pill red">会亏</span>}</> : <span className="muted">没定价</span>}</td>)}</tr></tbody></table>
        <div className="small muted" style={{ marginTop: 4 }}>{p.cost_updated_at ? `成本更新 ${dDate(p.cost_updated_at)} · ` : ''}汇率 1 XOF = {rate} RMB · 1 USD = {money(usd)} XOF（在「物料与定价 → 汇率与取整」改）</div>
      </section>

      {/* ⑤ 采购批次 */}
      <section className="pd-sec">
        <div className="pd-h row between"><span>⑤ 采购批次 <Info>每批单价按最新汇率折成西法（金蝶采购单是美元）；每片运费 = 这批总运费 ÷ 总片数，向上进 50</Info></span>
          {role === 'admin' && !adding && <button type="button" className="btn sm" onClick={() => setAdding({ po_no: '', ordered_on: today(), qty: '', currency: 'CNY', unit_price: '', freight_total: '', freight_pieces: '' })}>＋ 加一批</button>}</div>
        <div className="tscroll">
        <table className="t"><thead><tr><th>采购单号</th><th>日期</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>采购单价</th><th style={{ textAlign: 'right' }}>折合 XOF</th><th style={{ textAlign: 'right' }}>每片运费</th><th style={{ textAlign: 'right' }}>到岸</th><th style={{ textAlign: 'right' }}>比当前成本</th>{role === 'admin' && <th />}</tr></thead>
          <tbody>
            {batches.length === 0 && !adding && <tr><td colSpan={9} className="muted">还没有批次。点「＋ 加一批」，或在「数据导入 → 采购批次」导金蝶采购订单。</td></tr>}
            {batches.map((b) => { const L = cm.bLanded(b); const d = landed != null ? L - landed : null; const fr = cm.bFreight(b); return (
              <tr key={b.id} className={maxB && b.id === maxB.id && batches.length > 1 ? 'pd-max' : ''}>
                <td className="mono">{b.po_no || '—'}{b.source === 'kingdee' && <span className="muted small"> 金蝶</span>}</td><td>{dDate(b.ordered_on) || '—'}</td>
                <td style={{ textAlign: 'right' }}>{qty(b.qty)}</td>
                <td style={{ textAlign: 'right' }}>{b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : ''}{+N(b.unit_price).toFixed(b.currency === 'USD' ? 4 : 2)}</td>
                <td style={{ textAlign: 'right' }}>{money(Math.round(cm.toXof(b)))}</td>
                <td style={{ textAlign: 'right' }} title={fr.how === 'batch' ? `${money(b.freight_total)} ÷ ${qty(b.freight_pieces)} 片 = ${money(N(b.freight_total) / N(b.freight_pieces))} → 进到 ${money(fr.v)}` : ''}>
                  {fr.how === 'none' ? <span className="pill amber">没填</span> : <>{money(fr.v)}{fr.how === 'default' && <span className="small muted"> 默认</span>}</>}</td>
                <td style={{ textAlign: 'right' }}><b>{money(L)}</b><div className="small muted">实际 {money(Math.round(cm.bRaw(b)))}</div>{maxB && b.id === maxB.id && batches.length > 1 && <span className="small red-t2"> 最贵</span>}</td>
                <td style={{ textAlign: 'right' }} className={d > 0 ? 'red-t2' : d < 0 ? 'green-t2' : ''}>{d == null ? '—' : d === 0 ? '持平' : `${d > 0 ? '+' : ''}${money(d)}`}</td>
                {role === 'admin' && <td><span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  <button type="button" className="btn sm ghost" title="填这批的总运费和总片数" onClick={() => setAdding({ ...b, id: b.id, freight_total: b.freight_total ?? '', freight_pieces: b.freight_pieces ?? '', unit_price: String(b.unit_price), qty: String(b.qty) })}>运费</button>
                  <button type="button" className="btn sm ghost" title="删掉这批" onClick={async () => { try { await call(role, `select app.delete_product_batch($1)`, [b.id]); toast('已删掉这批'); onChanged(); } catch (e) { toast(friendlyError(e), 'err'); } }}>删</button></span></td>}
              </tr>); })}
            {adding && <BatchForm p={p} f={adding} setF={setAdding} role={role} toast={toast} onDone={() => { setAdding(null); onChanged(); }} />}
          </tbody></table>
        </div>
      </section>
    </>
  );
}

function BatchForm({ p, f, setF, role, toast, onDone }) {
  const set = (k) => (e) => setF({ ...f, [k]: typeof e === 'string' ? e : e.target.value });
  const num = (k, re = /[^\d.]/g) => (e) => setF({ ...f, [k]: e.target.value.replace(re, '') });
  const per = N(f.freight_total) > 0 && N(f.freight_pieces) > 0 ? ceilTo(N(f.freight_total) / N(f.freight_pieces), 50) : null;
  const save = async () => {
    const payload = { po_no: f.po_no, ordered_on: f.ordered_on ? String(f.ordered_on).slice(0, 10) : '', qty: Number(f.qty), currency: f.currency, unit_price: Number(f.unit_price),
      freight_xof: f.freight_xof === '' || f.freight_xof == null ? null : Number(f.freight_xof), freight_total: f.freight_total === '' ? null : Number(f.freight_total), freight_pieces: f.freight_pieces === '' ? null : Number(f.freight_pieces), note: f.note || '' };
    try { await call(role, `select app.save_product_batch($1,$2,$3)`, [p.id, f.id || null, JSON.stringify(payload)]); toast(f.id ? '这批已更新' : '这批已记下'); onDone(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <tr className="pd-add">
      <td><input className="in sm" value={f.po_no || ''} onChange={set('po_no')} placeholder="PO…" /></td>
      <td><DatePicker value={f.ordered_on ? String(f.ordered_on).slice(0, 10) : ''} onChange={set('ordered_on')} /></td>
      <td><input className="in sm" inputMode="numeric" value={f.qty} onChange={num('qty', /\D/g)} style={{ width: 70 }} /></td>
      <td><span className="row" style={{ gap: 4 }}><select className="in sm" value={f.currency} onChange={set('currency')}><option value="CNY">¥</option><option value="USD">$</option><option value="XOF">XOF</option></select>
        <input className="in sm" inputMode="decimal" value={f.unit_price} onChange={num('unit_price')} style={{ width: 80 }} /></span></td>
      <td colSpan={3}><span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <input className="in sm" inputMode="decimal" value={f.freight_total} onChange={num('freight_total')} placeholder="这批总运费" style={{ width: 100 }} />÷
        <input className="in sm" inputMode="numeric" value={f.freight_pieces} onChange={num('freight_pieces', /\D/g)} placeholder="总片数" style={{ width: 80 }} />
        {per != null ? <span className="small">= 每片 <b>{money(per)}</b></span> : <span className="small muted">空 = 用默认 {p.freight_xof ?? '（没填）'}</span>}</span></td>
      <td colSpan={2}><span className="row" style={{ gap: 4 }}><button type="button" className="btn sm primary" disabled={!(Number(f.qty) > 0) || f.unit_price === ''} onClick={save}>{f.id ? '保存' : '记下'}</button><button type="button" className="btn sm ghost" onClick={() => setF(null)}>取消</button></span></td>
    </tr>
  );
}
