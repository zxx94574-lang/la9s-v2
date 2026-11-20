// 474 / 475 (Frank 11-20): 指标 = 一个数 + 一条门槛条 + ⚙ + ☰ 明细.
// 每个指标只定义一次 (怎么算 + 明细取哪些行), 时效页、各功能页、看板引用的都是同一个 → 数和明细处处一致.
// 门槛: 目标线 (到了 = 绿) / 警戒线 (过了 = 红) / 中间黄; 方向 越高越好 / 越低越好. 存 org_settings 'metric_cfg', 只中方改.
import React, { useMemo, useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { q, call } from '../db/client.js';
import { useApp, useData, Info, Choice, usePopBus } from './ui.jsx';
import Grid from './Grid.jsx';
import { Fold } from './DashBlocks.jsx';
import { DealLink, CustLink } from './Archives.jsx';
import { workMinutes, fmtMin } from '../lib/worktime.js';
import { friendlyError, money } from '../lib/format.js';

// 指标清单: [id, 环节, 名字, 单位, 方向, 目标, 警戒, 说明]
export const METRICS = [
  ['inq.win', 'inq', '询单 → 成单', '%', 'up', 30, 15, '这段时间的询单（不算无效的）里，最后成了订单的比例。'],
  ['inq.fast', 'inq', '30 分钟内出价', '%', 'up', 90, 70, '询单建好到中方出价（转成报价）在 30 分钟内的比例，只算上班时间。'],
  ['quote.pass', 'quote', '确认达标', '%', 'up', 90, 70, '报价 → 客户确认这一段在时效目标内做完的比例（目标在「每一步」⚙ 里改）。'],
  ['quote.open', 'quote', '5 分钟内点开', '%', 'up', 90, 70, '报价建好后 5 分钟内热线点开的比例，只算上班时间。'],
  ['pick.pass', 'pick', '找货达标', '%', 'up', 90, 70, '找货·初检这一段在时效目标内做完的比例。'],
  ['pick.err', 'pick', '找货出错率', '%', 'down', 1, 3, '复检时被改了数量的行 ÷ 找的总行数。'],
  ['so.pass', 'so', '出单达标', '%', 'up', 90, 70, '出销售单这一段在时效目标内做完的比例。'],
  ['ship.pass', 'ship', '复检出库达标', '%', 'up', 90, 70, '复检打包 + 出库两段在时效目标内做完的比例。'],
  ['ship.disc', 'ship', '收货差异', '张', 'down', 0, 3, '这段时间客户报了收货差异（少了 / 多了 / 发错）的出库单张数。'],
  ['sign.pass', 'sign', '签收对账达标', '%', 'up', 90, 70, '签收、对账两段在时效目标内的比例（这两段等客户，没设目标时显示灰）。'],
  ['pay.days', 'pay', '回款天数', '天', 'down', 7, 15, '这段时间付清的单：第一次出库 → 最后一笔冲账，平均几天。'],
  ['hotline.same', 'hotline', '当天确认', '%', 'up', 80, 60, '报价当天联系上客户确认的比例。'],
  ['hotline.follow', 'hotline', '回访完成', '%', 'up', 90, 70, '约好哪天再联系的，到那天当天或之前有再联系的比例。'],
  ['visit.conv', 'visit', '拜访转化', '%', 'up', 30, 15, '拜访结果是「下单」或「要报价」的比例。'],
  ['visit.n', 'visit', '拜访次数', '次', 'up', 20, 10, '这段时间记了几次拜访。'],
  ['cust.price', 'cust', '定价准确率', '%', 'up', 90, 75, '这段时间的单里，单价没有从档位价往下调的行占比。初始按高的定，后来降价的行越多，说明初始定价越不准。明细里有每行降了多少。'],
  ['cash.pending', 'cash', '待核对到账', '笔', 'down', 0, 5, '登记了收款、还没核对到账的笔数（现在，不按时间段）。'],
  ['po.late', 'po', '过期没到', '单', 'down', 0, 3, '预计到货日已过、还没收完的采购单（现在，不按时间段）。'],
  ['staff.ok', 'staff', '打卡正常率', '%', 'up', 95, 85, '1 −（迟到 + 缺卡 + 早退）÷ 应到人天。'],
  ['dir.ontime', 'dir', '指令按时收到', '%', 'up', 90, 70, '中方指令下达后在规定分钟内点「收到」的比例。'],
].map(([id, area, name, unit, dir, target, warn, info]) => ({ id, area, name, unit, dir, target, warn, info }));
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.id, m]));

export function useMetricCfg() {
  const { org, tick } = useApp();
  const { data } = useData(() => q(`select value from app.org_settings where org_id = $1 and key = 'metric_cfg'`, [org]), [org, tick]);
  const raw = data?.[0]?.value || {};
  const get = (id) => ({ ...METRIC[id], ...(raw[id] || {}) });
  return { raw, get, ready: !!data };
}
export function metricTone(m, v) {
  if (v == null || !Number.isFinite(v)) return 'gray';
  const t = Number(m.target), w = Number(m.warn);
  if (m.dir === 'down') return v <= t ? 'green' : v <= w ? 'amber' : 'red';
  return v >= t ? 'green' : v >= w ? 'amber' : 'red';
}
export const fmtMetric = (m, v) => (v == null || !Number.isFinite(v) ? '—' : m.unit === '%' ? `${v.toFixed(v >= 10 || v === 0 ? 0 : 1)}%` : m.unit === '天' ? `${v.toFixed(v >= 10 ? 0 : 1)} 天` : `${Math.round(v).toLocaleString('en-US')} ${m.unit}`);

// ───────── 数据: 一次把这段时间要的数都取回来, 各页面共用 ─────────
const pct = (a, b) => (b ? (a / b) * 100 : null);
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d || ''));
export function useMetricData(from, to, extra = {}) {
  const { org, role, tick } = useApp();
  const admin = role === 'admin';
  const { data } = useData(async () => {
    const safe = (p) => p.catch(() => []);
    const [inq, quotes, follows, visits, lines, paid, pend, pos, att, anom] = await Promise.all([
      safe(q(`select i.id, i.iq_no, i.status, i.created_at, i.quoted_at, i.deal_id, coalesce(c.name, i.guest_info->>'contact', i.guest_info->>'shop') as who
        from app.inquiries i left join app.customers c on c.id = i.customer_id where i.org_id = $1 and i.status <> 'invalid' and i.created_at >= $2::date and i.created_at < ($3::date + 1)`, [org, from, to])),
      safe(q(`select d.id, d.biz_no, c.name as customer_name, d.created_at, d.hotline_opened_at,
          (select min(ev.at) from app.deal_events ev where ev.deal_id = d.id and ev.action = 'hotline_confirmed') as confirmed_at
        from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.kind = 'normal' and d.status <> 'cancelled' and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to])),
      safe(q(`select h.id, h.next_follow_on, c.id as customer_id, c.name as customer_name,
          exists (select 1 from app.hotline_calls h2 where h2.customer_id = h.customer_id and h2.at > h.at and h2.at::date <= h.next_follow_on) as done
        from app.hotline_calls h join app.customers c on c.id = h.customer_id where h.org_id = $1 and h.next_follow_on between $2::date and least($3::date, current_date)`, [org, from, to])),
      safe(q(`select v.id, v.at, v.result, c.id as customer_id, c.name as customer_name, coalesce(e.short_name, e.full_name) as emp
        from app.visits v join app.customers c on c.id = v.customer_id left join app.employees e on e.id = v.employee_id where v.org_id = $1 and v.at >= $2::date and v.at < ($3::date + 1)`, [org, from, to])),
      admin ? safe(call(role, `select l.id, d.id as deal_id, d.biz_no, c.id as customer_id, c.name as customer_name, p.model, l.unit_price, l.price_manual,
          app.tier_price(l.product_id, d.customer_id, 'XOF') as tier_price
        from app.deal_lines l join app.deals d on d.id = l.deal_id join app.customers c on c.id = d.customer_id join app.products p on p.id = l.product_id
        where d.org_id = $1 and d.kind = 'normal' and d.status <> 'cancelled' and coalesce(d.currency, 'XOF') = 'XOF' and l.unit_price > 0
          and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to])) : Promise.resolve([]),
      safe(q(`select t.deal_id, d.biz_no, c.id as customer_id, c.name as customer_name, t.first_shipped_at,
          (select max(a.at) from app.receipt_allocations a where a.deal_id = t.deal_id) as last_at
        from app.v_deal_due t join app.deals d on d.id = t.deal_id join app.customers c on c.id = d.customer_id
        where t.org_id = $1 and t.shipped_amount > 0 and t.due <= 0 and t.first_shipped_at is not null`, [org])),
      safe(q(`select r.id, r.rcv_no as receipt_no, r.received_on, r.amount, r.currency, c.name as customer_name from app.receipts r left join app.customers c on c.id = r.customer_id
        where r.org_id = $1 and r.verify_status = 'pending' and r.voided_at is null`, [org])),
      safe(q(`select po.id, po.po_no, po.eta, po.batch_name from app.purchase_orders po where po.org_id = $1 and po.status = 'open' and po.eta < current_date`, [org])),
      safe(q(`select count(distinct (employee_id, (at at time zone 'Africa/Abidjan')::date))::int as n from app.attendance where org_id = $1 and kind = 'in' and at >= $2::date and at < ($3::date + 1)`, [org, from, to])),
      safe(call(role, `select * from app.attendance_anomalies($1, $2::date, $3::date)`, [org, from, to])),
    ]);
    return { inq, quotes, follows, visits, lines, paid, pend, pos, att: att?.[0]?.n || 0, anom };
  }, [org, role, from, to, tick]);
  return useMemo(() => {
    if (!data) return null;
    const out = {};
    const put = (id, value, rows = [], cols = [], sub = '') => { out[id] = { value, rows, cols, sub }; };
    const dCol = { key: 'no', label: '单号', w: 150, render: (r) => (r.deal_id ? <DealLink id={r.deal_id} no={r.no} /> : r.no) };
    const cCol = { key: 'who', label: '客户', w: 160, render: (r) => (r.customer_id ? <CustLink id={r.customer_id} name={r.who} /> : r.who) };
    // 询单
    const iq = data.inq; const won = iq.filter((x) => x.status === 'converted' || x.deal_id);
    put('inq.win', pct(won.length, iq.length), iq.map((x) => ({ id: x.id, no: x.iq_no, deal_id: null, who: x.who, st: x.status === 'converted' || x.deal_id ? '成单' : x.status === 'lost' ? '没成交' : '跟进中' })),
      [{ key: 'no', label: '询单号', w: 150 }, { key: 'who', label: '谁', w: 160 }, { key: 'st', label: '结果', w: 100 }], `${won.length} / ${iq.length}`);
    const qd = iq.filter((x) => x.quoted_at).map((x) => ({ id: x.id, no: x.iq_no, who: x.who, m: workMinutes(x.created_at, x.quoted_at) }));
    put('inq.fast', pct(qd.filter((x) => x.m <= 30).length, qd.length), qd.sort((a, b) => b.m - a.m),
      [{ key: 'no', label: '询单号', w: 150 }, { key: 'who', label: '谁', w: 160 }, { key: 'm', label: '多久出价', w: 120, type: 'number', render: (r) => <span className={r.m > 30 ? 'red-t2' : ''}>{fmtMin(r.m)}</span> }], `${qd.filter((x) => x.m <= 30).length} / ${qd.length}`);
    // 报价点开 / 当天确认
    const qs = data.quotes.map((x) => ({ deal_id: x.id, no: x.biz_no, who: x.customer_name, m: x.hotline_opened_at ? workMinutes(x.created_at, x.hotline_opened_at) : workMinutes(x.created_at, new Date()), opened: !!x.hotline_opened_at,
      same: !!x.confirmed_at && new Date(x.confirmed_at).toDateString() === new Date(x.created_at).toDateString() }));
    put('quote.open', pct(qs.filter((x) => x.opened && x.m <= 5).length, qs.length), [...qs].sort((a, b) => b.m - a.m),
      [dCol, { key: 'who', label: '客户', w: 160 }, { key: 'm', label: '多久点开', w: 150, type: 'number', render: (r) => <span className={r.m > 5 ? 'red-t2' : ''}>{fmtMin(r.m)}{r.opened ? '' : ' · 还没点开'}</span> }], `${qs.filter((x) => x.opened && x.m <= 5).length} / ${qs.length}`);
    put('hotline.same', pct(qs.filter((x) => x.same).length, qs.length), qs.filter((x) => !x.same), [dCol, { key: 'who', label: '客户', w: 160 }], `${qs.filter((x) => x.same).length} / ${qs.length}`);
    const fo = data.follows; put('hotline.follow', pct(fo.filter((x) => x.done).length, fo.length), fo.map((x) => ({ id: x.id, customer_id: x.customer_id, who: x.customer_name, on: String(x.next_follow_on).slice(0, 10), done: x.done })).sort((a, b) => a.done - b.done),
      [cCol, { key: 'on', label: '约好哪天', w: 110 }, { key: 'done', label: '有没有再联系', w: 120, render: (r) => (r.done ? <span className="pill green">有</span> : <span className="pill red">没有</span>) }], `${fo.filter((x) => x.done).length} / ${fo.length}`);
    // 拜访
    const vs = data.visits; const RES = { order: '下单', quote: '要报价', interested: '有兴趣', not_interested: '没兴趣', later: '以后再说' };
    const vrows = vs.map((x) => ({ id: x.id, customer_id: x.customer_id, who: x.customer_name, emp: x.emp, on: iso(x.at).slice(0, 10), res: RES[x.result] || x.result, good: x.result === 'order' || x.result === 'quote' }));
    const vcols = [cCol, { key: 'emp', label: '谁去的', w: 100 }, { key: 'on', label: '哪天', w: 110 }, { key: 'res', label: '结果', w: 100, render: (r) => <span className={`pill ${r.good ? 'green' : 'gray'}`}>{r.res}</span> }];
    put('visit.conv', pct(vrows.filter((x) => x.good).length, vrows.length), vrows, vcols, `${vrows.filter((x) => x.good).length} / ${vrows.length}`);
    put('visit.n', vrows.length, vrows, vcols);
    // 定价准确率 (只中方)
    if (admin) {
      const ls = data.lines.filter((x) => Number(x.tier_price) > 0).map((x) => ({ id: x.id, deal_id: x.deal_id, no: x.biz_no, customer_id: x.customer_id, who: x.customer_name, model: x.model, tp: Number(x.tier_price), up: Number(x.unit_price), drop: Number(x.unit_price) < Number(x.tier_price) ? (1 - Number(x.unit_price) / Number(x.tier_price)) * 100 : 0 }));
      const low = ls.filter((x) => x.drop > 0);
      put('cust.price', ls.length ? 100 - pct(low.length, ls.length) : null, low.sort((a, b) => b.drop - a.drop),
        [dCol, cCol, { key: 'model', label: '型号', w: 110 }, { key: 'tp', label: '档位价', w: 100, type: 'money', render: (r) => money(r.tp) }, { key: 'up', label: '成交价', w: 100, type: 'money', render: (r) => money(r.up) },
          { key: 'drop', label: '降了', w: 90, type: 'number', render: (r) => <span className="red-t2">−{r.drop.toFixed(1)}%</span> }],
        low.length ? `${low.length} 行降过价 · 平均 −${(low.reduce((a, x) => a + x.drop, 0) / low.length).toFixed(1)}%` : `${ls.length} 行都按档位价`);
    }
    // 回款天数: 这段时间付清的单
    const pd = data.paid.filter((x) => x.last_at && iso(x.last_at).slice(0, 10) >= from && iso(x.last_at).slice(0, 10) <= to)
      .map((x) => ({ deal_id: x.deal_id, no: x.biz_no, customer_id: x.customer_id, who: x.customer_name, s: iso(x.first_shipped_at).slice(0, 10), e: iso(x.last_at).slice(0, 10), d: Math.max(0, (new Date(x.last_at) - new Date(x.first_shipped_at)) / 864e5) }));
    put('pay.days', pd.length ? pd.reduce((a, x) => a + x.d, 0) / pd.length : null, pd.sort((a, b) => b.d - a.d),
      [dCol, cCol, { key: 's', label: '出库', w: 110 }, { key: 'e', label: '收齐', w: 110 }, { key: 'd', label: '天数', w: 80, type: 'number', render: (r) => r.d.toFixed(0) }], `${pd.length} 张付清`);
    put('cash.pending', data.pend.length, data.pend.map((x) => ({ id: x.id, no: x.receipt_no, who: x.customer_name, on: iso(x.received_on).slice(0, 10), amt: `${money(x.amount, x.currency)} ${x.currency}` })),
      [{ key: 'no', label: '收款单', w: 150 }, { key: 'who', label: '客户', w: 160 }, { key: 'on', label: '哪天', w: 110 }, { key: 'amt', label: '金额', w: 140 }]);
    put('po.late', data.pos.length, data.pos.map((x) => ({ id: x.id, no: x.po_no, b: x.batch_name, eta: iso(x.eta).slice(0, 10), d: Math.round((Date.now() - new Date(x.eta)) / 864e5) })).sort((a, b) => b.d - a.d),
      [{ key: 'no', label: '采购单', w: 150 }, { key: 'b', label: '批次', w: 160 }, { key: 'eta', label: '预计到', w: 110 }, { key: 'd', label: '过了几天', w: 90, type: 'number' }]);
    const bad = data.anom.reduce((a, x) => a + Number(x.late || 0) + Number(x.missing || 0) + Number(x.early || 0), 0); const miss = data.anom.reduce((a, x) => a + Number(x.missing || 0), 0);
    put('staff.ok', data.att + miss ? 100 - pct(bad, data.att + miss) : null, data.anom.filter((x) => Number(x.late) + Number(x.missing) + Number(x.early || 0) > 0).map((x) => ({ id: x.employee_id, no: x.emp_no, who: x.short_name, late: x.late, missing: x.missing, early: x.early || 0 })),
      [{ key: 'no', label: '工号', w: 80 }, { key: 'who', label: '谁', w: 120 }, { key: 'late', label: '迟到', w: 70, type: 'number' }, { key: 'missing', label: '缺卡', w: 70, type: 'number' }, { key: 'early', label: '早退', w: 70, type: 'number' }], `${bad} 次异常`);
    Object.assign(out, extra);
    return out;
  }, [data, from, to, admin, extra]);   // eslint-disable-line react-hooks/exhaustive-deps
}

// ───────── 一张指标卡 ─────────
export function MetricCard({ id, d, cfg, tag }) {
  const { role } = useApp();
  const m = cfg.get(id); const v = d?.value ?? null; const tone = metricTone(m, v);
  const [open, setOpen] = useState(false); const [gear, setGear] = useState(false); const btn = useRef(null);
  if (m.hidden) return null;
  const isPct = m.unit === '%';
  const lo = 0; const hi = isPct ? 100 : Math.max(Number(m.warn) * 1.6, Number(m.target) * 2, (v || 0) * 1.15, 1);
  const pos = (x) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100))}%`;
  const t = Number(m.target), w = Number(m.warn);
  const bg = m.dir === 'down'
    ? `linear-gradient(90deg, var(--mt-g) 0 ${pos(t)}, var(--mt-a) ${pos(t)} ${pos(w)}, var(--mt-r) ${pos(w)})`
    : `linear-gradient(90deg, var(--mt-r) 0 ${pos(w)}, var(--mt-a) ${pos(w)} ${pos(t)}, var(--mt-g) ${pos(t)})`;
  return (
    <div className={`mt-card t-${tone}`}>
      <div className="mt-h">{tag && <span className="mt-tag">{tag}</span>}<span className="mt-name">{m.name}</span><Info>{m.info}</Info><span className="grow" />
        {role === 'admin' && <button type="button" ref={btn} className="gear-btn" title="门槛：目标线 / 警戒线 / 方向" onClick={() => setGear(!gear)}>⚙</button>}</div>
      <div className="mt-v">{fmtMetric(m, v)}</div>
      <div className="mt-band" style={{ background: bg }}>{v != null && Number.isFinite(v) && <i style={{ left: pos(Math.min(v, hi)) }} />}</div>
      <div className="mt-line"><span>{m.dir === 'down' ? `目标 ${fmtMetric(m, t)} · 警戒 ${fmtMetric(m, w)} · 越低越好` : `警戒 ${fmtMetric(m, w)} · 目标 ${fmtMetric(m, t)} · 越高越好`}</span>
        <span className="grow" />{d?.sub && <span className="mt-sub">{d.sub}</span>}{d?.rows?.length > 0 && <Fold open={open} onClick={() => setOpen(!open)} />}</div>
      {open && d?.rows?.length > 0 && <div style={{ marginTop: 8 }}><Grid id={`mt-${id}`} noTools maxHeight={320} rows={d.rows.map((r, i) => ({ ...r, _k: i }))} rowKey={(r) => r._k} columns={d.cols} /></div>}
      {gear && <MetricGear id={id} anchor={btn.current} onClose={() => setGear(false)} cfg={cfg} />}
    </div>);
}
function MetricGear({ id, anchor, onClose, cfg }) {
  const { org, role, toast, refresh } = useApp();
  const m = cfg.get(id); const [f, setF] = useState({ name: m.name, target: m.target, warn: m.warn, dir: m.dir });
  const pop = useRef(null); const [pos, setPos] = useState(null);
  usePopBus(true, onClose);
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect(); if (r) { const w = Math.min(280, window.innerWidth - 16); setPos({ width: w, top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - 8 - w)) }); }
    const out = (e) => { if (!pop.current?.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', out); return () => document.removeEventListener('pointerdown', out);
  }, [anchor, onClose]);
  const save = async (patch) => {
    try { const raw = { ...cfg.raw, [id]: { ...(cfg.raw[id] || {}), ...patch } }; await call(role, `select app.set_org_setting($1,'metric_cfg',$2)`, [org, JSON.stringify(raw)]); toast('已保存，所有页面一起变'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const bad = f.dir === 'down' ? Number(f.warn) < Number(f.target) : Number(f.warn) > Number(f.target);
  return createPortal(
    <div className="menu mt-gear" ref={pop} style={{ position: 'fixed', ...(pos || { visibility: 'hidden' }) }}>
      <div className="field"><label>名字</label><input className="in" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label>方向</label><Choice value={f.dir} onChange={(v) => setF({ ...f, dir: v })} options={[['up', '越高越好'], ['down', '越低越好']]} /></div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}><label>目标线（绿）</label><input className="in num-in" inputMode="decimal" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value.replace(/[^\d.]/g, '') })} /></div>
        <div className="field" style={{ flex: 1 }}><label>警戒线（红）</label><input className="in num-in" inputMode="decimal" value={f.warn} onChange={(e) => setF({ ...f, warn: e.target.value.replace(/[^\d.]/g, '') })} /></div>
      </div>
      {bad && <div className="small red-t2">{f.dir === 'down' ? '越低越好时，警戒线要比目标线大' : '越高越好时，警戒线要比目标线小'}</div>}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button type="button" className="btn sm ghost" onClick={() => save({ hidden: true })}>不显示这个指标</button><span className="grow" />
        <button type="button" className="btn sm" onClick={onClose}>取消</button>
        <button type="button" className="btn sm primary" disabled={bad || !f.name.trim()} onClick={() => save({ name: f.name.trim(), target: Number(f.target), warn: Number(f.warn), dir: f.dir })}>保存</button></div>
      {Object.keys(cfg.raw[id] || {}).length > 0 && <button type="button" className="btn sm ghost" style={{ marginTop: 4 }} onClick={async () => { const raw = { ...cfg.raw }; delete raw[id]; try { await call(role, `select app.set_org_setting($1,'metric_cfg',$2)`, [org, JSON.stringify(raw)]); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } }}>恢复默认</button>}
    </div>, document.body);
}

// 一排指标卡 (各页面顶上用): ids = 这一页要的几个
export function MetricStrip({ ids, from, to, extra }) {
  const cfg = useMetricCfg(); const data = useMetricData(from, to, extra);
  const { role } = useApp();
  const list = ids.filter((id) => METRIC[id] && !cfg.get(id).hidden && (id !== 'cust.price' || role === 'admin'));
  if (!data || !cfg.ready || !list.length) return null;
  return <div className="mt-strip">{list.map((id) => <MetricCard key={id} id={id} d={data[id]} cfg={cfg} />)}</div>;
}
// 隐藏了的指标列出来, 中方可以点回来
export function HiddenMetrics({ area }) {
  const { org, role, refresh } = useApp(); const cfg = useMetricCfg();
  const hid = METRICS.filter((m) => (!area || m.area === area) && cfg.get(m.id).hidden);
  if (role !== 'admin' || !hid.length) return null;
  const show = async (id) => { const raw = { ...cfg.raw, [id]: { ...(cfg.raw[id] || {}), hidden: false } }; await call(role, `select app.set_org_setting($1,'metric_cfg',$2)`, [org, JSON.stringify(raw)]); refresh(); };
  return <div className="small muted" style={{ marginTop: 6 }}>没显示的：{hid.map((m) => <button type="button" key={m.id} className="chip" style={{ marginLeft: 6 }} onClick={() => show(m.id)}>＋ {cfg.get(m.id).name}</button>)}</div>;
}
