// 上次成交价 + 历史价格 (Frank 2026-11-14)
// 场景: 和大客户谈好了某几个型号的价 (比档位价低), 员工下次报价按档位价报 → 乌龙.
// 做法: ① 报价时, 这个客户上次成交过、价格和现在不一样的型号 → 表上方黄条列出来, 一键沿用 (中方直接生效; 员工 = 申请价, 走审批);
//      ② 员工没沿用就保存 → 自动报给中方 (进待办「上报问题」), 订单页也一直挂着这条提示;
//      ③「历史价格」: 就地弹出这个客户以前每一笔的型号 / 数量 / 单价, 不用跳页.
// 「成交」= 已出销售订单之后的单 (ordered / confirmed / reviewed / partial / shipped), 报价阶段和作废的不算.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, Pill } from './ui.jsx';
import Grid from './Grid.jsx';
import { DealLink, ModelLink } from './Archives.jsx';
import { money, qty, dDate, friendlyError } from '../lib/format.js';

const DONE = `('ordered','confirmed','reviewed','partial','shipped')`;
const N = (v) => Number(v) || 0;

// 这个客户每个型号最近一次成交价 { product_id: { unit_price, currency, at, biz_no, deal_id, qty } }; before = 只看这张单之前的
export function useLastPrices(customerId, before = null, exceptDeal = null) {
  const { tick } = useApp();
  const { data } = useData(() => (customerId ? q(`
    select distinct on (l.product_id) l.product_id, l.unit_price, d.currency, d.created_at as at, d.biz_no, d.id as deal_id, l.qty_supply as qty, l.price_manual
    from app.deal_lines l join app.deals d on d.id = l.deal_id
    where d.customer_id = $1 and d.status in ${DONE} and l.product_id is not null and l.unit_price > 0 and d.discount_amount is null
      and ($2::timestamptz is null or d.created_at < $2::timestamptz) and ($3::uuid is null or d.id <> $3::uuid)
    order by l.product_id, d.created_at desc`, [customerId, before, exceptDeal]) : Promise.resolve([])), [customerId, before, exceptDeal, tick]);
  return useMemo(() => Object.fromEntries((data || []).map((r) => [r.product_id, r])), [data]);
}

// rows: [{ key, product_id, model, now }] → 和上次不一样的那些
export function diffRows(rows, last, currency) {
  return rows.map((r) => ({ ...r, last: last[r.product_id] })).filter((r) => r.last && r.last.currency === currency && N(r.last.unit_price) !== N(r.now));
}

export function LastPriceBar({ diffs, currency, onApply, applyLabel, onHistory, note }) {
  // 307 (Frank 11-14): 黄条改成一行轻提示, 点「看一下」才列出是哪些型号
  const [open, setOpen] = useState(false);
  if (!diffs.length) return null;
  return (
    <div className="lastprice slim">
      <div className="lp-h"><span className="small">这个客户有 <b>{diffs.length}</b> 个型号和上次成交价不一样{note ? `，${note}` : ''}</span>
        <button type="button" className="btn sm ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? '收起' : '看一下'}</button>
        <span className="grow" />
        {onApply && <button type="button" className="btn sm" onClick={onApply}>{applyLabel}</button>}
        {onHistory && <button type="button" className="btn sm" onClick={onHistory}>历史价格</button>}
      </div>
      {open && <div className="lp-list">
        {diffs.map((r) => (
          <span key={r.key} className="lp-item"><b>{r.model}</b>
            <span className="muted">上次</span> <b>{money(r.last.unit_price, currency)}</b>
            <span className="muted small">（{String(dDate(r.last.at)).slice(5)} · <DealLink id={r.last.deal_id} no={r.last.biz_no} />）</span>
            <span className="muted">现在</span> <span className={N(r.now) > N(r.last.unit_price) ? 'lp-up' : 'lp-down'}>{money(r.now, currency)}</span></span>))}
      </div>}
    </div>
  );
}

// 历史价格: 就地弹出, 不跳页
// 386 (Frank 11-18): 默认「按型号看」—— 这张单每个型号一行: 本单现在的价 · 上次成交价 · 最低 / 最高 / 几次 · 差多少 · 勾选;
// 点一行展开这个型号过去每一次的成交, 可以点其中任意一次的价; 底部「用选中的 N 个型号的历史价」只改勾上的行.
// current: [{ key, product_id, model, category, qty, now }]; onApply(list [{ key, product_id, price, from_no }]) 返回 promise; applyLabel / applyNote 由页面给 (中方 = 直接改, 员工 = 申请)
export function PriceHistory({ customerId, customerName, productIds = [], current = null, currency = 'XOF', onApply, applyLabel = '用选中的历史价', applyNote, onClose }) {
  const { role } = useApp();
  const [tab, setTab] = useState(current?.length ? 'model' : productIds.length ? 'only' : 'all');
  const [sel, setSel] = useState(new Set()); const [pickPrice, setPickPrice] = useState({}); const [open, setOpen] = useState(null); const [busy, setBusy] = useState(false);
  const { data } = useData(() => q(`
    select l.id, d.id as deal_id, d.biz_no, d.created_at, d.status, d.currency, p.id as product_id, p.model, p.code, c.name as category,
      l.qty_req, l.qty_supply, l.qty_shipped, l.unit_price, l.price_manual, d.discount_amount is not null as discounted
    from app.deal_lines l join app.deals d on d.id = l.deal_id join app.products p on p.id = l.product_id join app.categories c on c.id = p.category_id
    where d.customer_id = $1 and d.status in ${DONE} and l.unit_price > 0
    order by d.created_at desc, p.model limit 800`, [customerId]), [customerId]);
  const admin = role === 'admin';
  const { data: costs } = useData(() => (admin && current?.length ? q(`select p.id, app.landed_cost(p.rmb_cost, p.freight_xof, ps) as cost from app.products p join app.price_settings ps on ps.org_id = p.org_id where p.id = any($1::uuid[]) and p.rmb_cost > 0`, [current.map((c) => c.product_id)]).catch(() => []) : Promise.resolve([])), [customerId, admin]);
  const costOf = Object.fromEntries((costs || []).map((c) => [c.id, c.cost == null ? null : N(c.cost)]));
  const set = useMemo(() => new Set(productIds), [productIds]);
  const rows = (data || []).filter((r) => tab !== 'only' || set.has(r.product_id));
  const firstOf = useMemo(() => { const m = new Map(); for (const r of data || []) if (!m.has(r.product_id)) m.set(r.product_id, r.id); return m; }, [data]);
  // 按型号: 同币种、没打过整单折扣的成交才能拿来用
  const hist = useMemo(() => { const m = {}; for (const r of data || []) if (r.currency === currency && !r.discounted) (m[r.product_id] ||= []).push(r); return m; }, [data, currency]);
  const models = (current || []).map((c) => { const h = hist[c.product_id] || []; const ps = h.map((x) => N(x.unit_price)); const chosen = pickPrice[c.key] ? h.find((x) => x.id === pickPrice[c.key]) : h[0];
    return { ...c, h, last: h[0], chosen, min: ps.length ? Math.min(...ps) : null, max: ps.length ? Math.max(...ps) : null, diff: chosen ? N(chosen.unit_price) - N(c.now) : null, loss: currency === 'XOF' && chosen && costOf[c.product_id] != null && N(chosen.unit_price) < costOf[c.product_id] }; });
  const usable = models.filter((m) => m.chosen && N(m.chosen.unit_price) !== N(m.now));
  const picked = usable.filter((m) => sel.has(m.key));
  const toggle = (k) => { const n = new Set(sel); if (n.has(k)) n.delete(k); else n.add(k); setSel(n); };
  const apply = async () => { setBusy(true); try { await onApply(picked.map((m) => ({ key: m.key, product_id: m.product_id, price: N(m.chosen.unit_price), from_no: m.chosen.biz_no }))); onClose(); } catch { /* 页面自己提示 */ } finally { setBusy(false); } };
  return (
    <Modal wide title={`历史价格${customerName ? ` · ${customerName}` : ''}`} onClose={onClose}
      footer={tab === 'model' && onApply ? <><span className="small muted">{applyNote}</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>关闭</button><button type="button" className="btn primary" disabled={!picked.length || busy} title={picked.length ? '' : '先勾选要用历史价的型号'} onClick={apply}>{applyLabel}（{picked.length} 个型号）</button></> : undefined}>
      <div className="stack">
        <div className="chips">
          {current?.length > 0 && <button type="button" className={`chip ${tab === 'model' ? 'on' : ''}`} onClick={() => setTab('model')}>按型号看（这张单）</button>}
          {productIds.length > 0 && <button type="button" className={`chip ${tab === 'only' ? 'on' : ''}`} onClick={() => setTab('only')}>这张单里型号的每一笔</button>}
          <button type="button" className={`chip ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>这个客户全部成交</button></div>
        {tab === 'model' ? <div className="ph-list">
          <div className="ph-row ph-head"><span /><span>型号</span><span className="r">本单数量</span><span className="r">本单现在的价</span><span className="r">要用的历史价</span><span className="r">差多少</span><span>最低 / 最高 · 几次</span></div>
          {!data ? <div className="small muted" style={{ padding: 10 }}>加载中…</div> : models.map((m) => (
            <React.Fragment key={m.key}>
              <div className={`ph-row ${open === m.key ? 'open' : ''} ${m.h.length ? '' : 'none'}`} onClick={() => m.h.length && setOpen(open === m.key ? null : m.key)}>
                <span onClick={(e) => e.stopPropagation()}>{onApply && <input type="checkbox" aria-label={`用 ${m.model} 的历史价`} disabled={!m.chosen || N(m.chosen.unit_price) === N(m.now)} checked={sel.has(m.key)} onChange={() => toggle(m.key)} />}</span>
                <span><b>{m.model}</b> <span className="small muted">{m.category}</span></span>
                <span className="r">{qty(m.qty)}</span>
                <span className="r">{N(m.now) > 0 ? money(m.now, currency) : <span className="muted">—</span>}</span>
                <span className="r">{m.chosen ? <><b>{money(m.chosen.unit_price, currency)}</b>{m.loss && <span className="pill red" style={{ marginLeft: 4 }} title="低于现在的到岸成本，用了会亏（亏钱拦截照样管）">会亏</span>}<div className="small muted">{String(dDate(m.chosen.created_at)).slice(2)} · {m.chosen.biz_no}{m.chosen.id === m.last.id ? ' · 最近' : ''}</div></> : <span className="muted small">没有成交记录</span>}</span>
                <span className="r">{m.diff == null ? '' : m.diff === 0 ? <span className="muted small">一样</span> : <b className={m.diff > 0 ? 'lp-up' : 'lp-down'}>{m.diff > 0 ? '+' : '−'}{money(Math.abs(m.diff), currency)}</b>}</span>
                <span className="small">{m.h.length ? <>{money(m.min, currency)} / {money(m.max, currency)} · {m.h.length} 次 <span className="muted">{open === m.key ? '▴' : '▾'}</span></> : ''}</span>
              </div>
              {open === m.key && <div className="ph-sub">{m.h.map((x) => (
                <button type="button" key={x.id} className={`ph-pick ${m.chosen?.id === x.id ? 'on' : ''}`} onClick={() => { setPickPrice({ ...pickPrice, [m.key]: x.id }); if (onApply && N(x.unit_price) !== N(m.now)) setSel(new Set([...sel, m.key])); }}>
                  <span>{dDate(x.created_at)}</span><span className="mono">{x.biz_no}</span><span>{qty(N(x.qty_shipped) || N(x.qty_supply) || N(x.qty_req))} 片</span><b>{money(x.unit_price, currency)}</b>{x.price_manual && <span className="pill amber">手改</span>}{m.chosen?.id === x.id && <span className="pill blue">用这次的</span>}</button>))}</div>}
            </React.Fragment>))}
          <div className="small muted" style={{ marginTop: 6 }}>点一行 = 展开这个型号过去每一次成交，可以点其中任意一次的价（默认最近一次）。只改勾上的行，其余不动。只列同币种、没打过整单折扣的成交。</div>
        </div> : <>
        <Grid id="price-history" rows={rows} empty={data ? '这个客户还没有成交记录' : '加载中…'} compactTools columns={[
          { key: 'created_at', label: '日期', w: 96, value: (r) => dDate(r.created_at) },
          { key: 'biz_no', label: '订单', w: 150, render: (r) => <DealLink id={r.deal_id} no={r.biz_no} /> },
          { key: 'category', label: '种类', w: 100 },
          { key: 'model', label: '型号', w: 110, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
          { key: 'qty', label: '数量', w: 70, type: 'number', value: (r) => N(r.qty_shipped) || N(r.qty_supply) || N(r.qty_req), render: (r) => qty(N(r.qty_shipped) || N(r.qty_supply) || N(r.qty_req)) },
          { key: 'unit_price', label: '成交单价', w: 150, type: 'number', value: (r) => N(r.unit_price), render: (r) => <span className="row" style={{ gap: 4 }}><b>{money(r.unit_price, r.currency)}</b> <span className="muted small">{r.currency}</span>{firstOf.get(r.product_id) === r.id && <Pill tone="green">最近</Pill>}{r.price_manual && <Pill tone="amber">手改</Pill>}</span> },
        ]} />
        <div className="small muted">只列已出销售订单的成交（报价阶段和作废的不算）。点单号可以打开那张单；可以按型号分组。</div></>}
      </div>
    </Modal>
  );
}

// 订单页用: 这张单的价和这个客户更早的成交价不一样 → 一直挂着, 谁打开都看得到
export function DealLastPrice({ deal, lines }) {
  const { role, toast, refresh } = useApp();
  const [hist, setHist] = useState(false);
  const last = useLastPrices(deal.customer_id, deal.created_at, deal.id);
  const real = lines.filter((l) => l.product_id);
  const nowOf = (l) => (N(l.price_req) > 0 ? N(l.price_req) : N(l.requested_price) > 0 ? N(l.requested_price) : N(l.unit_price));
  const diffs = diffRows(real.filter((l) => N(l.unit_price) > 0).map((l) => ({ key: l.id, product_id: l.product_id, model: l.model, now: nowOf(l) })), last, deal.currency);
  const ids = real.map((l) => l.product_id);
  const admin = role === 'admin';
  const canAdmin = admin && ['quoted', 'hotline_ok', 'picking', 'picked', 'ordered', 'confirmed', 'reviewed'].includes(deal.status);
  const canReq = !admin && ['manager', 'hotline', 'sales', 'sales_manager', 'finance'].includes(role) && ['picked', 'ordered', 'confirmed', 'reviewed'].includes(deal.status);
  const apply = async (list) => {
    try {
      for (const x of list) await call(role, admin ? `select app.set_line_price($1,$2,$3)` : `select app.request_line_price($1,$2,$3)`, [x.key, x.price, `沿用 ${x.from_no} 历史价`]);
      toast(admin ? `已把 ${list.length} 个型号改成历史价（标了手改，留了记录）` : `已提交 ${list.length} 个型号的改价申请，中方批了才生效`); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); refresh(); throw e; }
  };
  return (<>
    <LastPriceBar diffs={diffs} currency={deal.currency} onHistory={() => setHist(true)} note="核对一下是不是该沿用谈好的价" />
    {!diffs.length && <div style={{ textAlign: 'right', margin: '-4px 0 8px' }}><button type="button" className="btn sm ghost" onClick={() => setHist(true)}>历史价格</button></div>}
    {hist && <PriceHistory customerId={deal.customer_id} customerName={deal.customer_name} productIds={ids} currency={deal.currency} onClose={() => setHist(false)}
      current={real.map((l) => ({ key: l.id, product_id: l.product_id, model: l.model, category: l.category, qty: N(l.qty_supply) || N(l.qty_req), now: nowOf(l) }))}
      onApply={canAdmin || canReq ? apply : null} applyLabel={admin ? '用选中的历史价' : '申请用选中的历史价'}
      applyNote={canAdmin ? (['confirmed', 'reviewed'].includes(deal.status) ? '客户已确认过：改了价要客户重新确认' : '中方直接改，标「手改」留记录') : canReq ? '员工点「用」= 改价申请，中方批了才生效' : admin ? '这一步不能再改价' : '报价阶段员工改价：在「修改报价」里填申请价'} />}
  </>);
}
