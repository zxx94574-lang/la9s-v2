// 上次成交价 + 历史价格 (Frank 2026-11-14)
// 场景: 和大客户谈好了某几个型号的价 (比档位价低), 员工下次报价按档位价报 → 乌龙.
// 做法: ① 报价时, 这个客户上次成交过、价格和现在不一样的型号 → 表上方黄条列出来, 一键沿用 (中方直接生效; 员工 = 申请价, 走审批);
//      ② 员工没沿用就保存 → 自动报给中方 (进待办「上报问题」), 订单页也一直挂着这条提示;
//      ③「历史价格」: 就地弹出这个客户以前每一笔的型号 / 数量 / 单价, 不用跳页.
// 「成交」= 已出销售订单之后的单 (ordered / confirmed / reviewed / partial / shipped), 报价阶段和作废的不算.
import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Modal, Pill } from './ui.jsx';
import Grid from './Grid.jsx';
import { DealLink, ModelLink } from './Archives.jsx';
import { money, qty, dDate } from '../lib/format.js';

const DONE = `('ordered','confirmed','reviewed','partial','shipped')`;
const N = (v) => Number(v) || 0;

// 这个客户每个型号最近一次成交价 { product_id: { unit_price, currency, at, biz_no, deal_id, qty } }; before = 只看这张单之前的
export function useLastPrices(customerId, before = null, exceptDeal = null) {
  const { tick } = useApp();
  const { data } = useData(() => (customerId ? q(`
    select distinct on (l.product_id) l.product_id, l.unit_price, d.currency, d.created_at as at, d.biz_no, d.id as deal_id, l.qty_supply as qty, l.price_manual
    from app.deal_lines l join app.deals d on d.id = l.deal_id
    where d.customer_id = $1 and d.status in ${DONE} and l.product_id is not null and l.unit_price > 0
      and ($2::timestamptz is null or d.created_at < $2::timestamptz) and ($3::uuid is null or d.id <> $3::uuid)
    order by l.product_id, d.created_at desc`, [customerId, before, exceptDeal]) : Promise.resolve([])), [customerId, before, exceptDeal, tick]);
  return useMemo(() => Object.fromEntries((data || []).map((r) => [r.product_id, r])), [data]);
}

// rows: [{ key, product_id, model, now }] → 和上次不一样的那些
export function diffRows(rows, last, currency) {
  return rows.map((r) => ({ ...r, last: last[r.product_id] })).filter((r) => r.last && r.last.currency === currency && N(r.last.unit_price) !== N(r.now));
}

export function LastPriceBar({ diffs, currency, onApply, applyLabel, onHistory, note }) {
  if (!diffs.length) return null;
  return (
    <div className="lastprice">
      <div className="lp-h"><Pill tone="amber">和上次成交价不一样</Pill><span className="small">这个客户有 <b>{diffs.length}</b> 个型号上次成交的价和现在不一样{note ? `，${note}` : ''}</span>
        <span className="grow" />
        {onApply && <button type="button" className="btn sm primary" onClick={onApply}>{applyLabel}</button>}
        {onHistory && <button type="button" className="btn sm" onClick={onHistory}>历史价格</button>}
      </div>
      <div className="lp-list">
        {diffs.map((r) => (
          <span key={r.key} className="lp-item"><b>{r.model}</b>
            <span className="muted">上次</span> <b>{money(r.last.unit_price, currency)}</b>
            <span className="muted small">（{String(dDate(r.last.at)).slice(5)} · <DealLink id={r.last.deal_id} no={r.last.biz_no} />）</span>
            <span className="muted">现在</span> <span className={N(r.now) > N(r.last.unit_price) ? 'lp-up' : 'lp-down'}>{money(r.now, currency)}</span></span>))}
      </div>
    </div>
  );
}

// 历史价格: 就地弹出, 不跳页
export function PriceHistory({ customerId, customerName, productIds = [], onClose }) {
  const [only, setOnly] = useState(productIds.length > 0);
  const { data } = useData(() => q(`
    select l.id, d.id as deal_id, d.biz_no, d.created_at, d.status, d.currency, p.id as product_id, p.model, p.code, c.name as category,
      l.qty_req, l.qty_supply, l.qty_shipped, l.unit_price, l.price_manual
    from app.deal_lines l join app.deals d on d.id = l.deal_id join app.products p on p.id = l.product_id join app.categories c on c.id = p.category_id
    where d.customer_id = $1 and d.status in ${DONE} and l.unit_price > 0
    order by d.created_at desc, p.model limit 800`, [customerId]), [customerId]);
  const set = useMemo(() => new Set(productIds), [productIds]);
  const rows = (data || []).filter((r) => !only || set.has(r.product_id));
  // 同一个型号: 最近一次标「最近」
  const firstOf = useMemo(() => { const m = new Map(); for (const r of data || []) if (!m.has(r.product_id)) m.set(r.product_id, r.id); return m; }, [data]);
  return (
    <Modal wide title={`历史价格${customerName ? ` · ${customerName}` : ''}`} onClose={onClose}>
      <div className="stack">
        {productIds.length > 0 && <div className="chips">
          <button type="button" className={`chip ${only ? 'on' : ''}`} onClick={() => setOnly(true)}>只看这张单里的型号</button>
          <button type="button" className={`chip ${!only ? 'on' : ''}`} onClick={() => setOnly(false)}>这个客户全部成交</button></div>}
        <Grid id="price-history" rows={rows} empty={data ? '这个客户还没有成交记录' : '加载中…'} compactTools columns={[
          { key: 'created_at', label: '日期', w: 96, value: (r) => dDate(r.created_at) },
          { key: 'biz_no', label: '订单', w: 150, render: (r) => <DealLink id={r.deal_id} no={r.biz_no} /> },
          { key: 'category', label: '种类', w: 100 },
          { key: 'model', label: '型号', w: 110, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
          { key: 'qty', label: '数量', w: 70, type: 'number', value: (r) => N(r.qty_shipped) || N(r.qty_supply) || N(r.qty_req), render: (r) => qty(N(r.qty_shipped) || N(r.qty_supply) || N(r.qty_req)) },
          { key: 'unit_price', label: '成交单价', w: 150, type: 'number', value: (r) => N(r.unit_price), render: (r) => <span className="row" style={{ gap: 4 }}><b>{money(r.unit_price, r.currency)}</b> <span className="muted small">{r.currency}</span>{firstOf.get(r.product_id) === r.id && <Pill tone="green">最近</Pill>}{r.price_manual && <Pill tone="amber">手改</Pill>}</span> },
        ]} />
        <div className="small muted">只列已出销售订单的成交（报价阶段和作废的不算）。点单号可以打开那张单。</div>
      </div>
    </Modal>
  );
}

// 订单页用: 这张单的价和这个客户更早的成交价不一样 → 一直挂着, 谁打开都看得到
export function DealLastPrice({ deal, lines }) {
  const [hist, setHist] = useState(false);
  const last = useLastPrices(deal.customer_id, deal.created_at, deal.id);
  const diffs = diffRows(lines.filter((l) => l.product_id && N(l.unit_price) > 0).map((l) => ({ key: l.id, product_id: l.product_id, model: l.model, now: N(l.requested_price) > 0 ? N(l.requested_price) : N(l.unit_price) })), last, deal.currency);
  const ids = lines.filter((l) => l.product_id).map((l) => l.product_id);
  return (<>
    <LastPriceBar diffs={diffs} currency={deal.currency} onHistory={() => setHist(true)} note="核对一下是不是该沿用谈好的价" />
    {!diffs.length && <div style={{ textAlign: 'right', margin: '-4px 0 8px' }}><button type="button" className="btn sm ghost" onClick={() => setHist(true)}>历史价格</button></div>}
    {hist && <PriceHistory customerId={deal.customer_id} customerName={deal.customer_name} productIds={ids} onClose={() => setHist(false)} />}
  </>);
}
