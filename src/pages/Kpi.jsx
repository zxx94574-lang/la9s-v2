// 241 (Frank 11-11): 时效与准确率 —— 先只显示、不考核; 跑 2–4 周看到真实的中位数再定线
// 每张单按步骤分段计时 (只算上班时间), 谁的时间算谁的; 等客户的时间单独算; 速度和准确率成对看
import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, DatePicker, Info } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { DealLink } from '../components/Archives.jsx';
import { periodRange, PERIODS } from '../lib/format.js';
import { workMinutes, fmtMin } from '../lib/worktime.js';

// [段名, 起事件, 止事件, 算谁的, 人从哪来]
const SEGS = [
  ['建报价 → 联系上客户确认', 'quote_created', 'hotline_confirmed', '热线', (ev) => ev.to.short_name],
  ['下推找货 → 初检完成', 'picking_started', 'pick_submitted', '找货人', (ev, emp) => emp(ev.to.detail?.picker) || ev.to.short_name],
  ['初检完 → 出销售单（定价）', 'pick_submitted', 'sales_order_created', '中方', (ev) => ev.to.short_name],
  ['销售单发出 → 客户确认', 'sales_order_created', 'customer_confirmed', '客户', () => null],
  ['客户确认 → 复检打包完', 'customer_confirmed', 'pick_reviewed', '复核人', (ev, emp) => emp(ev.to.detail?.reviewer) || ev.to.short_name],
  ['打包完 → 出库', 'pick_reviewed', 'shipped', '仓库', (ev) => ev.to.short_name],
  ['出库 → 客户签收', 'shipped', 'customer_received', '客户 / 热线', (ev) => ev.to.short_name],
  ['签收 → 客户确认对账', 'customer_received', 'balance_confirmed', '客户 / 热线', (ev) => ev.to.short_name],
];
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export default function Kpi() {
  const { org } = useApp();
  const [period, setPeriod] = useState('month'); const [custom, setCustom] = useState(periodRange('month'));
  const [from, to] = period === 'custom' ? custom : periodRange(period);
  const { data } = useData(async () => {
    const [deals, events, emps, discs, checks] = await Promise.all([
      q(`select d.id, d.biz_no, d.created_at, d.status, c.name as customer_name, (select count(*) from app.deal_lines l where l.deal_id = d.id)::int as lines
         from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.kind = 'normal' and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to]),
      q(`select e.deal_id, e.at, e.action, e.detail, emp.short_name from app.deal_events e join app.deals d on d.id = e.deal_id
         left join app.members m on m.user_id = e.user_id and m.org_id = d.org_id left join app.employees emp on emp.id = m.employee_id
         where d.org_id = $1 and d.created_at >= $2::date and d.created_at < ($3::date + 1) order by e.at`, [org, from, to]),
      q(`select id, short_name from app.employees where org_id = $1`, [org]),
      q(`select r.deal_id, r.fault, r.decision, r.amount from app.receipt_discrepancies r join app.deals d on d.id = r.deal_id where r.org_id = $1 and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to]),
      q(`select d.picker_employee_id, d.reviewer_employee_id, count(*)::int as lines, count(*) filter (where l.review_changed or l.diff_reason like '复核%')::int as review_fix
         from app.deal_lines l join app.deals d on d.id = l.deal_id where d.org_id = $1 and d.created_at >= $2::date and d.created_at < ($3::date + 1) and d.picker_employee_id is not null group by 1, 2`, [org, from, to]).catch(() => []),
    ]);
    return { deals, events, emps, discs, checks };
  }, [org, from, to]);
  const calc = useMemo(() => {
    if (!data) return null;
    const emp = (id) => data.emps.find((e) => e.id === id)?.short_name;
    const byDeal = {}; for (const e of data.events) (byDeal[e.deal_id] ||= []).push(e);
    const seg = SEGS.map(([name, , , owner]) => ({ name, owner, mins: [] })); const person = {}; const rows = [];
    for (const d of data.deals) {
      const ev = byDeal[d.id] || []; const r = { ...d };
      SEGS.forEach(([, a, b, , who], i) => {
        const from0 = ev.find((x) => x.action === a); const to0 = from0 && ev.find((x) => x.action === b && new Date(x.at) >= new Date(from0.at));
        if (!from0 || !to0) return;
        const m = workMinutes(from0.at, to0.at); seg[i].mins.push(m); r['s' + i] = m;
        const p = who({ from: from0, to: to0 }, emp); if (p) { const k = p + '|' + SEGS[i][3]; (person[k] ||= { key: k, name: p, role: SEGS[i][3], mins: [], lines: 0 }); person[k].mins.push(m); person[k].lines += d.lines; }
      });
      const sh = ev.find((x) => x.action === 'shipped'); if (sh) r.total = workMinutes(d.created_at, sh.at);
      rows.push(r);
    }
    const fix = {}; for (const c of data.checks) { const p = emp(c.picker_employee_id); if (p) { (fix[p] ||= { lines: 0, fix: 0 }); fix[p].lines += c.lines; fix[p].fix += c.review_fix; } }
    return { seg, rows, fix, people: Object.values(person).map((p) => ({ ...p, n: p.mins.length, med: median(p.mins), avg: p.mins.reduce((a, b) => a + b, 0) / p.mins.length })) };
  }, [data]);
  if (!calc) return <div className="empty">加载中…</div>;
  const totals = calc.rows.filter((r) => r.total != null).map((r) => r.total);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Délais & qualité</div><h1 tabIndex={0}>时效与准确率</h1>
        <div className="sub">只算上班时间（周一到周五 9:00–17:30 扣午休 1 小时，周六 9:00–12:00）。现在只显示、不考核：等员工用自己的工号登录、跑 2–4 周后，再按真实的中位数定线。</div></div>
        <div className="row"><div className="seg">{PERIODS.map(([k, l]) => <button type="button" key={k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}</div>
          {period === 'custom' && <DatePicker range value={custom} onChange={setCustom} align="right" />}</div></div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="bigsum">
          <div><div className="k">这段时间开的单</div><div className="v">{calc.rows.length}</div></div>
          <div><div className="k">建单 → 出库（中位数）</div><div className="v">{fmtMin(median(totals))}</div></div>
          <div><div className="k">已出库</div><div className="v">{totals.length} <small>单</small></div></div>
          <div><div className="k">收货差异</div><div className="v" style={{ color: data.discs.length ? 'var(--red)' : undefined }}>{data.discs.length} <small>张</small></div></div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>每一步用了多久 <Info>中位数 = 一半的单比它快、一半比它慢，比平均数更能代表「正常要多久」。等客户的两段不算员工的。</Info></h2></div>
        <Grid id="kpi-seg" noTools rows={calc.seg.map((s, i) => ({ ...s, key: i, n: s.mins.length, med: median(s.mins), max: s.mins.length ? Math.max(...s.mins) : null }))} rowKey={(r) => r.key} columns={[
          { key: 'name', label: '这一段', w: 240, render: (r) => <b>{r.name}</b> },
          { key: 'owner', label: '算谁的', w: 110, render: (r) => <span className={`pill ${r.owner.startsWith('客户') ? 'gray' : 'blue'}`}>{r.owner}</span> },
          { key: 'n', label: '几单', w: 70, type: 'number' },
          { key: 'med', label: '中位数', w: 130, value: (r) => r.med ?? -1, render: (r) => <b>{fmtMin(r.med)}</b> },
          { key: 'max', label: '最慢的一单', w: 130, value: (r) => r.max ?? -1, render: (r) => fmtMin(r.max) },
        ]} />
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>按人看：速度和准确率放一起 <Info>速度 = 他经手那一段的中位数。准确率（找货人）= 复检时被改了数量的行数 ÷ 他找的总行数。只看速度会逼人乱点完成，只看准确率会磨洋工，所以两个数并排。</Info></h2></div>
        <Grid id="kpi-people" rows={calc.people} rowKey={(r) => r.key} empty="还没有数据（步骤要由员工自己的账号点，才算得到人头上）" columns={[
          { key: 'name', label: '谁', w: 120, render: (r) => <b>{r.name}</b> },
          { key: 'role', label: '哪一段', w: 110 },
          { key: 'n', label: '几单', w: 70, type: 'number' },
          { key: 'med', label: '速度（中位数）', w: 150, value: (r) => r.med, render: (r) => <b>{fmtMin(r.med)}</b> },
          { key: 'acc', label: '复检被改的行', w: 170, value: (r) => (r.role === '找货人' && calc.fix[r.name] ? calc.fix[r.name].fix : -1),
            render: (r) => { const f = r.role === '找货人' && calc.fix[r.name]; if (!f) return <span className="muted small">—</span>; const pct = f.lines ? (f.fix / f.lines) * 100 : 0; return <span className={`pill ${f.fix === 0 ? 'green' : pct > 5 ? 'red' : 'amber'}`}>{f.fix} / {f.lines} 行（每 100 行 {pct.toFixed(1)}）</span>; } },
        ]} />
      </div>
      <div className="card">
        <div className="card-h"><h2>每张单</h2></div>
        <Grid id="kpi-deals" rows={calc.rows} empty="这段时间没有单" columns={[
          { key: 'biz_no', label: '订单号', w: 150, render: (r) => <DealLink id={r.id} no={r.biz_no} /> },
          { key: 'customer_name', label: '客户', w: 150 },
          { key: 'lines', label: '型号数', w: 70, type: 'number' },
          { key: 'total', label: '建单 → 出库', w: 130, value: (r) => r.total ?? -1, render: (r) => <b>{fmtMin(r.total)}</b> },
          ...SEGS.map(([name], i) => ({ key: 's' + i, label: name.replace(' → ', '→'), w: 150, value: (r) => r['s' + i] ?? -1, render: (r) => (r['s' + i] == null ? '' : fmtMin(r['s' + i])) })),
        ]} />
      </div>
    </>
  );
}
