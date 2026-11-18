// 344 (Frank 11-17): 亏钱 = 重中之重.
// 事前 LossGate: 有卖价低于成本的行 → 这张单推不下去; 员工只看到「这几行价格要中方批」(不出成本), 中方看到每行亏多少 + 批准 (必须写原因).
// 事后 LossReview: 已出库整单亏的 → 中方必须选结论 + 写原因才能关; LossTodo: 待办最顶上的数字块.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Choice, Pill, Assumed } from './ui.jsx';
import { DealLink } from './Archives.jsx';
import { money, qty, friendlyError, dDate } from '../lib/format.js';

const N = (v) => Number(v || 0);
const WHY_OK = ['清仓（有清仓决定）', '老库存 / 滞销处理', '有瑕疵的货', '维护大客户', '成本录错了（实际不亏）', '其他'];
export const LOSS_CONCLUSIONS = ['价格给低了', '成本录错 / 成本没更新', '汇率变了', '运费 / 手续费吃掉了', '退货 / 差异扣减', '清仓（有清仓决定）', '其他'];

export function LossGate({ deal, margin }) {
  const { role, toast, refresh, tick } = useApp();
  const [why, setWhy] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const { data } = useData(async () => {
    if (!deal || deal.kind !== 'normal' || ['shipped', 'cancelled'].includes(deal.status)) return null;
    const [r] = await call(role, `select app.deal_loss_state($1) as s`, [deal.id]);
    const s = r?.s; if (!s?.lines?.length) return null;
    const lines = await q(`select l.id, l.seq, coalesce(p.model, l.req_model) as model, c.name as category from app.deal_lines l left join app.products p on p.id = l.product_id
      left join app.categories c on c.id = coalesce(p.category_id, l.req_category_id) where l.id = any($1::uuid[]) order by l.seq`, [s.lines]);
    return { ...s, rows: lines };
  }, [deal?.id, deal?.status, deal?.version, tick]);
  if (!data) return null;
  const names = data.rows.map((l) => `${l.model}${l.category ? `（${l.category}）` : ''}`).join('、');
  if (data.approved) return (
    <div className="banner info" style={{ marginBottom: 12 }}><b>中方已批准亏本出货</b>：{names} · 原因：{data.note}</div>);
  if (!data.blocked) return null;
  if (role !== 'admin') return (
    <div className="banner warn loss-bar" style={{ marginBottom: 12 }}>
      <b>⛔ 这张单有 {data.rows.length} 行的价格要中方批准，批了才能往下走：</b>{names}。请联系中方。
    </div>);
  const est = (margin?.lines || []).filter((l) => !l.cost_missing && l.profit < 0);
  const submit = async () => {
    const text = [why, note.trim()].filter(Boolean).join('：');
    if (!why || !text.trim()) { toast('先选原因', 'err'); return; }
    if ((why === '其他' || why.startsWith('成本录错')) && !note.trim()) { toast('这个原因要再写一句说明', 'err'); return; }
    setBusy(true);
    try { await call(role, `select app.approve_loss($1,$2,$3)`, [deal.id, text, why.startsWith('清仓') ? 'clearance' : 'other']); toast('已批准，这张单可以往下走了'); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="banner warn loss-bar" style={{ marginBottom: 12 }}>
      <div><b>⛔ 会亏：{data.rows.length} 行卖价低于到岸成本，这张单现在推不下去。</b> 要么把价格改上去，要么写原因批准。<Assumed>批准时可选的原因（清仓 / 老库存 / 有瑕疵 / 维护大客户 / 成本录错 / 其他）是我列的；批的是「这几行 + 这几个价」，之后再改价要重新批。</Assumed></div>
      {est.length > 0 && <div className="loss-lines">{est.map((l) => (
        <span key={l.id} className="loss-line"><b>{l.model}</b> <span className="muted">{l.category}</span> · {qty(l.qty)} 片 · 卖 {money(Math.round(l.revenue / (l.qty || 1)))} / 成本 {money(Math.round(N(l.unit_cost)))} · <b>亏 {money(Math.round(-l.profit))}</b></span>))}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Choice value={why} onChange={setWhy} options={WHY_OK} placeholder="为什么要亏本卖…" flat={false} style={{ width: 220 }} />
        <input className="in" style={{ flex: '1 1 220px', minWidth: 0 }} placeholder="补充说明（谁定的、哪次清仓…）" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn danger" disabled={busy} onClick={submit}>批准亏本出货</button>
      </div>
    </div>);
}

// 事后: 已出库, 整单亏了, 还没下结论
export function LossReview({ deal, margin }) {
  const { role, toast, refresh } = useApp();
  const [c, setC] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  if (role !== 'admin' || !margin?.shipped || !(margin.t.profit < 0)) return null;
  if (deal.loss_review_at) return <div className="banner info" style={{ marginBottom: 12 }}><b>这张单亏了 {money(Math.round(-margin.t.profit))}，已下结论</b>：{deal.loss_review_conclusion} · {deal.loss_review_note}</div>;
  const sum = (k) => margin.lines.reduce((a, l) => a + N(l[k]), 0);
  const parts = [['货本身（卖价 − 成本）', sum('revenue') + sum('returned') - (sum('cost') - sum('freight') - sum('fee'))], ['我们出的运费', -sum('freight')], ['我们承担的手续费', -sum('fee')], ['退货 / 扣减', -sum('returned')]].filter(([, v]) => Math.round(v) !== 0);
  const worst = [...parts].sort((a, b) => a[1] - b[1])[0];
  const submit = async () => {
    if (!c) { toast('先选结论', 'err'); return; } if (!note.trim()) { toast('写清楚原因和以后怎么避免', 'err'); return; }
    setBusy(true);
    try { await call(role, `select app.close_loss_review($1,$2,$3)`, [deal.id, c, note.trim()]); toast('已记录结论'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="banner warn loss-bar" style={{ marginBottom: 12 }}>
      <div><b>⛔ 这张单亏了 {money(Math.round(-margin.t.profit))} XOF。</b> 必须找到原因、选结论才能关。{deal.loss_ok_note ? <> 出库前批准的原因：{deal.loss_ok_note}</> : <> <b>出库前没有人批准过亏本。</b></>}</div>
      <div className="loss-lines">{parts.map(([l, v]) => <span key={l} className="loss-line">{l} <b>{v < 0 ? '−' : '+'}{money(Math.abs(Math.round(v)))}</b></span>)}
        {worst && worst[1] < 0 && <span className="loss-line"><span className="muted">最可能的原因：</span><b>{worst[0]}</b></span>}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Choice value={c} onChange={setC} options={LOSS_CONCLUSIONS} placeholder="结论：为什么亏…" flat={false} style={{ width: 220 }} />
        <input className="in" style={{ flex: '1 1 220px', minWidth: 0 }} placeholder="原因 + 以后怎么避免" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>记录结论</button>
      </div>
    </div>);
}

// 待办最顶: 中方看「亏钱的单 N 张」, 点开才列出来
export function LossTodo() {
  const { org, role, tick } = useApp();
  const [open, setOpen] = useState(false);
  const { data } = useData(() => (role === 'admin' ? call(role, `select * from app.loss_deals($1)`, [org]) : Promise.resolve(null)), [org, role, tick]);
  if (!data?.length) return null;
  const total = data.reduce((a, r) => a + N(r.profit), 0);
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
      <button type="button" className="card-h fold-h" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2>亏钱的单</h2><Pill tone="red">{data.length} 张 · 共亏 {money(Math.round(-total))}</Pill><span className="muted small">已出库、整单毛利为负、还没下结论</span><span className="grow" /><span className="caret">{open ? '▾ 收起' : '▸ 展开'}</span>
      </button>
      {open && data.map((r) => (
        <div key={r.deal_id} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
          <span className="age red">亏</span>
          <span className="small"><DealLink id={r.deal_id} no={r.biz_no} /> · {r.customer_name} · {dDate(r.shipped_on)} 出库 · 卖 {money(Math.round(N(r.revenue)))} / 成本 {money(Math.round(N(r.cost)))}{r.approved_note ? ` · 出库前批过：${r.approved_note}` : ' · 出库前没批过'}</span>
          <b className="red-t2">−{money(Math.round(-N(r.profit)))}</b>
        </div>))}
    </div>);
}
