// 待改 503 (Frank 11-23): 待办里的「订单」—— 每张没走完的单一行: 整条流程都列出来, 卡在哪一步哪一步变红, 没做的灰;
// 点开看每一步谁做的、用了多久、目标多久; 超时的必须写原因. 时间只算上班时间, 目标和「时效与准确率」是同一份 (kpi_targets).
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData } from './ui.jsx';
import { CustLink, DealLink, EmpLink } from './Archives.jsx';
import { OptNote } from './Opts.jsx';
import { RuleGear } from './Rules.jsx';
import { workMinutes, fmtMin } from '../lib/worktime.js';
import { dt, money, friendlyError } from '../lib/format.js';

// [名字, 起事件 (没有就接上一步的结束), 止事件, 目标的 key, 算谁的]
const STEPS = [
  ['报价·确认', 'quote_created', 'hotline_confirmed', 's0', '热线'],
  ['找货·初检', 'picking_started', 'pick_submitted', 's1', '找货人'],
  ['销售订单', 'pick_submitted', 'sales_order_created', 's2', '中方'],
  ['客户确认', 'sales_order_created', 'customer_confirmed', null, '客户'],
  ['复检打包', 'customer_confirmed', 'pick_reviewed', 's4', '复核人'],
  ['出库', 'pick_reviewed', 'shipped', 's5', '仓库'],
  ['收款', 'shipped', null, null, '财务'],
];
const DEF = { s0: 30, s1: 120, s2: 30, s4: 60, s5: 60 };
const DELAY = ['客户没回', '缺货', '等主管', '系统 / 网络问题', '其他'];

function useFlow() {
  const { org, tick } = useApp();
  const { data } = useData(async () => {
    const deals = await q(`select d.id, d.biz_no, d.created_at, d.status, d.currency, c.id as customer_id, c.name as customer_name,
        coalesce(t.shipped_amount, 0) as shipped_amount, coalesce(t.due, 0) as due,
        (select coalesce(sum(l.qty_req * l.unit_price), 0) from app.deal_lines l where l.deal_id = d.id) as amount
      from app.deals d join app.customers c on c.id = d.customer_id left join app.v_deal_due t on t.deal_id = d.id
      where d.org_id = $1 and d.status <> 'cancelled' and d.created_at > now() - interval '120 days'
        and not (d.status = 'shipped' and coalesce(t.due, 0) <= 0)`, [org]);
    if (!deals.length) return { deals: [], events: [], target: DEF };
    const events = await q(`select e.deal_id, e.at, e.action, e.detail, emp.id as emp_id, emp.short_name
      from app.deal_events e left join app.members m on m.user_id = e.user_id and m.org_id = $1 left join app.employees emp on emp.id = m.employee_id
      where e.deal_id = any($2::uuid[]) and e.action = any($3) order by e.at`, [org, deals.map((d) => d.id), [...new Set(STEPS.flatMap((s) => [s[1], s[2]]).filter(Boolean)), 'delay_note']]);
    const tg = (await q(`select value from app.org_settings where org_id = $1 and key = 'kpi_targets'`, [org]))[0]?.value || {};
    return { deals, events, target: Object.fromEntries(Object.entries({ ...DEF, ...tg }).map(([k, v]) => [k, Number(v)])) };
  }, [org, tick]);
  return useMemo(() => {
    if (!data) return null;
    const by = {}; for (const e of data.events) (by[e.deal_id] = by[e.deal_id] || []).push(e);
    const now = new Date();
    return data.deals.map((d) => {
      const ev = by[d.id] || []; let prevEnd = null; let cur = -1;
      const lastDone = STEPS.reduce((a, s, i) => (s[2] && ev.some((x) => x.action === s[2]) ? i : a), -1);
      const steps = STEPS.map(([name, a, b, tk, owner], i) => {
        const fromE = ev.find((x) => x.action === a); const start = fromE ? new Date(fromE.at) : prevEnd;
        const toE = b ? ev.find((x) => x.action === b && (!start || new Date(x.at) >= start)) : null;
        const paid = i === 6 && d.status === 'shipped' && Number(d.due) <= 0;
        const skipped = !toE && !paid && i < lastDone;      // 后面的步骤做了, 这一步没有记录 (直接下单等)
        const end = toE ? new Date(toE.at) : null; const done = !!end || paid || skipped;
        const target = tk ? data.target[tk] : null;
        let used = null;
        if (start && end) used = workMinutes(start, end); else if (start && !done && cur < 0) used = workMinutes(start, now);
        const st = done ? 'done' : (cur < 0 && start ? 'now' : 'todo'); if (st === 'now') cur = i;
        if (end) prevEnd = end;
        const note = ev.filter((x) => x.action === 'delay_note' && Number(x.detail?.seg) === i).map((x) => x.detail?.reason).filter(Boolean).pop();
        return { i, name, owner, target, used, st, skipped, who: toE?.short_name, whoId: toE?.emp_id, note, over: target != null && used != null && used > target, far: target != null && used != null && used > target * 1.5, start, end };
      });
      if (cur < 0) { const k = steps.findIndex((x) => x.st !== 'done'); if (k >= 0) { steps[k].st = 'now'; cur = k; } }
      const c = steps[cur];
      return { ...d, steps, cur, c, stuck: !!c?.over, resp: steps[0].used, total: workMinutes(d.created_at, now), needNote: steps.filter((x) => x.over && !x.note).length };
    }).filter((d) => d.cur >= 0).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }, [data]);
}

export function FlowBadge() {
  const rows = useFlow();
  const n = (rows || []).filter((d) => d.stuck).length;
  return <>{rows ? ` ${rows.length}` : ''}{n > 0 && <span className="pill red" style={{ marginLeft: 6 }}>{n} 卡住</span>}</>;
}

export default function OrderFlow() {
  const { role, toast, refresh } = useApp();
  const rows = useFlow();
  const [open, setOpen] = useState(null); const [notes, setNotes] = useState({}); const [only, setOnly] = useState(false); const [lim, setLim] = useState(30);
  if (!rows) return <div className="card-b small muted">加载中…</div>;
  // 卡住的排最前, 其余从老到新; 一次先显示 30 张
  const full = (only ? rows.filter((d) => d.stuck) : rows).slice().sort((a, b) => (b.stuck ? 1 : 0) - (a.stuck ? 1 : 0) || new Date(a.created_at) - new Date(b.created_at)); const list = full.slice(0, lim);
  const save = async (d, s) => { const v = (notes[`${d.id}:${s.i}`] || '').trim(); if (!v) return; try { await call(role, `select app.deal_delay_note($1,$2,$3)`, [d.id, s.i, v]); toast('原因记下了'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const cls = (s) => (s.st === 'now' ? (s.over ? 'now' : 'nowok') : s.st === 'todo' ? 'todo' : s.skipped ? 'skip' : s.far ? 'late' : s.over ? 'slow' : 'ok');
  return (
    <div className="t2-list">
      <div className="t2-bar"><span className="d2-seg"><button type="button" className={only ? '' : 'on'} onClick={() => setOnly(false)}>全部 {rows.length}</button><button type="button" className={only ? 'on' : ''} onClick={() => setOnly(true)}>只看卡住的 {rows.filter((d) => d.stuck).length}</button></span>
        <span className="grow" /><RuleGear ids={['kpi.s0', 'kpi.s1', 'kpi.s2', 'kpi.s4', 'kpi.s5']} title="每一步的目标时间" /></div>
      {list.length === 0 && <div className="card-b small muted">{only ? '没有卡住的订单 ✓' : '没有没走完的订单'}</div>}
      {list.map((d) => {
        const on = open === d.id; const c = d.c;
        return (
          <div key={d.id} className={`t2-item ${on ? 'on' : ''}`}>
            <div className="t2-row" onClick={() => setOpen(on ? null : d.id)}>
              <div className="t2-main">
                <div className="t2-l1"><span onClick={(e) => e.stopPropagation()}><DealLink id={d.id} no={d.biz_no} /></span><span onClick={(e) => e.stopPropagation()}><CustLink id={d.customer_id} name={d.customer_name} /></span>
                  {['admin', 'finance', 'manager', 'sales_manager'].includes(role) && Number(d.amount) > 0 && <span className="muted">· {money(d.amount, d.currency)} {d.currency}</span>}
                  {d.needNote > 0 && <span className="pill red">{d.needNote} 步超时没写原因</span>}</div>
                <div className="t2-times"><span className="t2-tc"><i>下单</i>{dt(d.created_at)}</span>
                  {d.resp != null && <span className="t2-tc" data-tip="建报价到联系上客户确认，用了多久（只算上班时间）"><i>响应</i>{fmtMin(d.resp)}</span>}
                  <span className="t2-tc" data-tip="从下单到现在（只算上班时间）"><i>到现在</i>{fmtMin(d.total)}</span></div>
                <div className="t2-flow">{d.steps.map((s, i) => <React.Fragment key={i}>{i > 0 && <span className="ar">→</span>}
                  <span className={`t2-fs ${cls(s)}`} data-tip={`${s.name} · ${s.who || s.owner}${s.target ? ` · 目标 ${fmtMin(s.target)}` : ' · 不设目标'}${s.used != null ? ` · 用了 ${fmtMin(s.used)}` : ''}${s.note ? ` · 原因：${s.note}` : ''}`}>{s.name}{s.used != null && s.st !== 'todo' ? ` ${fmtMin(s.used)}` : ''}</span></React.Fragment>)}</div>
              </div>
              <div className="t2-right"><span className="due-chip" data-tip={`现在这步：${c.name} · ${c.owner}${c.target ? ` · 目标 ${fmtMin(c.target)}` : ' · 不设目标'}`}>
                {c.over ? <span className="pill red">卡 {fmtMin(c.used)}</span> : c.target ? <span className="pill green">按时</span> : <span className="pill gray">等{c.owner}</span>}</span></div>
            </div>
            {on && <div className="t2-exp"><div className="t2-box"><div className="t2-steps">
              {d.steps.map((s) => (
                <div key={s.i} className={`t2-st ${s.st === 'done' ? 'done' : s.st === 'now' ? 'now' : ''}`}><i />
                  <div><b>{s.name} <span className="muted" style={{ fontWeight: 400 }}>· {s.whoId ? <EmpLink id={s.whoId} name={s.who} /> : (s.who || s.owner)}</span></b>
                    <small>{s.skipped ? '这一步没有记录' : s.used != null ? `${fmtMin(s.used)}${s.target ? ` / 目标 ${fmtMin(s.target)}` : ''}` : '—'}{s.end ? ` · ${dt(s.end)}` : ''}</small>
                    {s.over && (s.note ? <small>原因：{s.note}</small>
                      : <div className="t2-why" onClick={(e) => e.stopPropagation()}><span className="pill red">写原因</span><OptNote optKey="flow.delay_reason" title="超时原因" options={DELAY} value={notes[`${d.id}:${s.i}`] || ''} onChange={(v) => setNotes((x) => ({ ...x, [`${d.id}:${s.i}`]: v }))} placeholder="为什么慢了" />
                        <button type="button" className="btn sm primary" disabled={!(notes[`${d.id}:${s.i}`] || '').trim()} onClick={() => save(d, s)}>记下</button></div>)}</div>
                  {s.used != null && s.target != null && <span className={`pill ${s.far ? 'red' : s.over ? 'amber' : 'green'}`}>{s.over ? `超 ${fmtMin(s.used - s.target)}` : '按时'}</span>}
                </div>))}
            </div></div></div>}
          </div>);
      })}
      {full.length > lim && <div style={{ textAlign: 'center', padding: 10 }}><button type="button" className="btn sm" onClick={() => setLim(lim + 30)}>再看 30 张（还有 {full.length - lim} 张）</button></div>}
    </div>);
}
