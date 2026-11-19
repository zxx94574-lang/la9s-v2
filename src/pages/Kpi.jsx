// 241 (Frank 11-11): 时效与准确率 —— 先只显示、不考核; 跑 2–4 周看到真实的中位数再定线
// 每张单按步骤分段计时 (只算上班时间), 谁的时间算谁的; 等客户的时间单独算; 速度和准确率成对看
import SalesComm from '../components/SalesComm.jsx';
import HotlineKpi from '../components/HotlineKpi.jsx';
import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, DatePicker, Info, Assumed } from '../components/ui.jsx';
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
const qtyf = (n) => Number(n || 0).toLocaleString('en-US');
export const KPI_TARGET = { s0: 30, s1: 120, s2: 30, s4: 60, s5: 60 };   // 390: 每一段的目标时限 (分钟, 上班时间); 客户的两段没有目标
const pctl = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const MIN_N = 10;   // 少于 10 单的数字不看
const weekOf = (v) => { const d = new Date(v); const k = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); k.setUTCDate(k.getUTCDate() - ((k.getUTCDay() + 6) % 7)); return k.toISOString().slice(5, 10); };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export default function Kpi() {
  const { org } = useApp();
  const [lateSeg, setLateSeg] = useState(null);
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
    const [dirs, com, opens, rate] = await Promise.all([
      q(`select x.*, e.short_name, e.emp_no,
           (select count(*) from app.deal_events ev join app.members m on m.user_id = ev.user_id and m.org_id = x.org_id where m.employee_id = x.assignee_employee_id and ev.at between x.created_at and coalesce(x.ack_at, now()))::int as busy_ops
         from app.directives x join app.employees e on e.id = x.assignee_employee_id
         where x.org_id = $1 and not x.is_template and x.created_at >= $2::date and x.created_at < ($3::date + 1)`, [org, from, to]),
      q(`select v.*, e.short_name, e.emp_no from app.v_wh_commission v join app.employees e on e.id = v.employee_id where v.org_id = $1 and v.month >= to_char($2::date, 'YYYY-MM') and v.month <= to_char($3::date, 'YYYY-MM')`, [org, from, to]),
      q(`select d.id, d.biz_no, d.created_at, d.hotline_opened_at, c.name as customer_name, (select short_name from app.employees e join app.members m on m.employee_id = e.id where m.user_id = d.created_by and m.org_id = d.org_id limit 1) as creator
         from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 and d.kind = 'normal' and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to]),
      q(`select value from app.org_settings where org_id = $1 and key = 'wh_commission'`, [org]),
    ]);
    const tg = (await q(`select value from app.org_settings where org_id = $1 and key = 'kpi_targets'`, [org]))[0]?.value || {};
    return { deals, events, emps, discs, checks, dirs, com, opens, rate: Number(rate[0]?.value?.per_piece) || 5, target: Object.fromEntries(Object.entries({ ...KPI_TARGET, ...tg }).map(([k, v]) => [k, Number(v)])) };
  }, [org, from, to]);
  const calc = useMemo(() => {
    if (!data) return null;
    const emp = (id) => data.emps.find((e) => e.id === id)?.short_name;
    const byDeal = {}; for (const e of data.events) (byDeal[e.deal_id] ||= []).push(e);
    const seg = SEGS.map(([name, , , owner], i) => ({ name, owner, mins: [], target: data.target['s' + i] || null, items: [] })); const person = {}; const rows = [];
    for (const d of data.deals) {
      const ev = byDeal[d.id] || []; const r = { ...d };
      SEGS.forEach(([, a, b, , who], i) => {
        const from0 = ev.find((x) => x.action === a); const to0 = from0 && ev.find((x) => x.action === b && new Date(x.at) >= new Date(from0.at));
        if (!from0 || !to0) return;
        const m = workMinutes(from0.at, to0.at); seg[i].mins.push(m); r['s' + i] = m; seg[i].items.push({ id: d.id, no: d.biz_no, customer: d.customer_name, m, lines: d.lines, week: weekOf(to0.at) });
        const p = who({ from: from0, to: to0 }, emp); if (p) { const k = p + '|' + SEGS[i][3]; (person[k] ||= { key: k, name: p, role: SEGS[i][3], mins: [], lines: 0 }); person[k].mins.push(m); person[k].lines += d.lines; }
      });
      const sh = ev.find((x) => x.action === 'shipped'); if (sh) r.total = workMinutes(d.created_at, sh.at);
      rows.push(r);
    }
    // 指令: 下达 → 收到 (规定 5 分钟) → 完成; 超时的看他那段时间有没有在系统里操作
    const ACK = 5; const dp = {};
    for (const x of data.dirs) { const k = x.assignee_employee_id; (dp[k] ||= { key: k, name: x.short_name, emp_no: x.emp_no, n: 0, ack: [], done: [], late: 0, lateIdle: 0, unack: 0, rejects: 0 });
      const p = dp[k]; p.n += 1; p.rejects += Number(x.reject_count || 0);
      const am = workMinutes(x.created_at, x.ack_at || new Date()); if (x.ack_at) p.ack.push(am); else p.unack += 1;
      if (am > ACK) { p.late += 1; if (!Number(x.busy_ops)) p.lateIdle += 1; }
      if (x.ack_at && x.done_at) p.done.push(workMinutes(x.ack_at, x.done_at)); }
    const dirPeople = Object.values(dp).map((p) => ({ ...p, ackMed: median(p.ack), doneMed: median(p.done) }));
    // 提成: 正确出货的片数 × 每片单价; 出错的单取消
    const cp = {};
    for (const x of data.com) { const k = x.employee_id; (cp[k] ||= { key: k, name: x.short_name, emp_no: x.emp_no, deals: 0, pieces: 0, okPieces: 0, voided: [], lost: 0 });
      const p = cp[k]; p.deals += 1; p.pieces += Number(x.pieces); if (x.voided) { p.voided.push(x); p.lost += Number(x.pieces) * data.rate; } else p.okPieces += Number(x.pieces); }
    const comPeople = Object.values(cp).map((p) => ({ ...p, amount: p.okPieces * data.rate }));
    // 报价建好 → 热线点开 (规定 5 分钟)
    const openRows = data.opens.map((x) => ({ ...x, mins: workMinutes(x.created_at, x.hotline_opened_at || new Date()), opened: !!x.hotline_opened_at }));
    const openLate = openRows.filter((x) => x.mins > ACK);
    const fix = {}; for (const c of data.checks) { const p = emp(c.picker_employee_id); if (p) { (fix[p] ||= { lines: 0, fix: 0 }); fix[p].lines += c.lines; fix[p].fix += c.review_fix; } }
    return { dirPeople, comPeople, openRows, openLate, seg, rows, fix, people: Object.values(person).map((p) => ({ ...p, n: p.mins.length, med: median(p.mins), avg: p.mins.reduce((a, b) => a + b, 0) / p.mins.length })) };
  }, [data]);
  if (!calc) return <div className="empty">加载中…</div>;
  const totals = calc.rows.filter((r) => r.total != null).map((r) => r.total);
  const weeks = [...new Set(calc.seg.flatMap((x) => x.items.map((it) => it.week)))].sort();
  const segRows = calc.seg.map((x, i) => {
    const n = x.mins.length; const ok = x.target ? x.mins.filter((m) => m <= x.target).length : 0;
    const lines = x.items.reduce((a, it) => a + Number(it.lines || 0), 0);
    const w1 = weeks[weeks.length - 1]; const w0 = weeks[weeks.length - 2];
    const a1 = median(x.items.filter((it) => it.week === w1).map((it) => it.m)); const a0 = median(x.items.filter((it) => it.week === w0).map((it) => it.m));
    const tr = a1 != null && a0 != null && a0 > 0 ? (a1 - a0) / a0 : null;
    return { ...x, key: i, n, ok, rate: n && x.target ? (ok / n) * 100 : null, med: median(x.mins), p90: pctl(x.mins, 0.9), few: n < MIN_N, perLine: i === 1 || i === 4 ? (lines ? x.mins.reduce((a, b) => a + b, 0) / lines : null) : null,
      late: x.target ? x.items.filter((it) => it.m > x.target).sort((a, b) => b.m - a.m) : [], trendTxt: tr == null ? '' : Math.abs(tr) < 0.05 ? '差不多' : `${tr > 0 ? '慢了' : '快了'} ${Math.abs(tr * 100).toFixed(0)}%`, trendUp: tr > 0.05 };
  });
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Délais & qualité</div><h1 tabIndex={0}>时效与准确率</h1>
        <div className="sub">只算上班时间（周一到周五 9:00–17:30，中午集体午休自动扣 1 小时；周六 9:00–12:00）。现在只显示、不考核：等员工用自己的工号登录、跑 2–4 周后，再按真实的中位数定线。</div></div>
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
        <div className="card-h"><h2>每一步用了多久、达标了多少 <Info>达标率才是能评判的数；中位数 = 一般多久；「最慢 10%」= 十张单里最慢的那张要多久。最慢的单只当线索，点下面的单号进去看卡在哪。等客户的两段不算员工的。</Info></h2></div>
        <Grid id="kpi-seg" noTools rows={segRows} rowKey={(r) => r.key} columns={[
          { key: 'name', label: '这一段', w: 230, render: (r) => <b>{r.name}</b> },
          { key: 'owner', label: '算谁的', w: 100, render: (r) => <span className={`pill ${r.owner.startsWith('客户') ? 'gray' : 'blue'}`}>{r.owner}</span> },
          { key: 'n', label: '几单', w: 60, type: 'number' },
          { key: 'target', label: '目标', w: 90, value: (r) => r.target ?? -1, render: (r) => (r.target ? fmtMin(r.target) : <span className="muted small">不设</span>) },
          { key: 'rate', label: '达标率', w: 170, value: (r) => r.rate ?? -1, render: (r) => (r.target == null || !r.n ? <span className="muted small">—</span> : <span className={`pill ${r.few ? 'gray' : r.rate >= 90 ? 'green' : r.rate >= 70 ? 'amber' : 'red'}`}>{r.ok} / {r.n} 单 · {r.rate.toFixed(0)}%</span>) },
          { key: 'med', label: '一般多久（中位数）', w: 140, value: (r) => r.med ?? -1, render: (r) => <b className={r.few ? 'muted' : ''}>{fmtMin(r.med)}</b> },
          { key: 'p90', label: '最慢 10% 要多久', w: 130, value: (r) => r.p90 ?? -1, render: (r) => <span className={r.few ? 'muted' : ''}>{fmtMin(r.p90)}</span> },
          { key: 'perLine', label: '每个型号', w: 100, value: (r) => r.perLine ?? -1, render: (r) => (r.perLine == null ? '' : <span className={r.few ? 'muted' : ''}>{fmtMin(r.perLine)}</span>) },
          { key: 'trend', label: '这周比上周', w: 150, value: (r) => r.trendTxt || '', render: (r) => (r.trendTxt ? <span className={`pill ${r.trendUp ? 'red' : 'green'}`}>{r.trendTxt}</span> : <span className="muted small">—</span>) },
          { key: 'few', label: '', w: 150, value: (r) => (r.few ? '单数太少' : ''), render: (r) => (r.few && r.n ? <span className="pill gray">不到 {MIN_N} 单，先别看</span> : '') },
        ]} />
        <div className="card-b" style={{ paddingTop: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><b>超时的单（线索，不是评判）</b>
            <div className="chips">{segRows.filter((r) => r.target && r.late.length).map((r) => <button type="button" key={r.key} className={`chip ${lateSeg === r.key ? 'on' : ''}`} onClick={() => setLateSeg(lateSeg === r.key ? null : r.key)}>{r.name.split(' → ')[1] || r.name} {r.late.length}</button>)}</div>
            {segRows.every((r) => !r.target || !r.late.length) && <span className="small muted">没有超时的单 ✓</span>}</div>
          {lateSeg != null && segRows[lateSeg] && <div style={{ marginTop: 6 }}>{segRows[lateSeg].late.slice(0, 30).map((x) => <div key={x.id} className="todo-line"><DealLink id={x.id} no={x.no} /><span>{x.customer}</span><span className="small muted">{x.lines} 个型号</span><span className="grow" /><b className="red-t2">{fmtMin(x.m)}</b><span className="small muted">目标 {fmtMin(segRows[lateSeg].target)}</span></div>)}</div>}
          <div className="small muted" style={{ marginTop: 8 }}>达标率 = 这一段在目标时限内做完的单 ÷ 这一段做完的单。目标在「规则参数」里调。系统量的是「点按钮的时间」；现在员工还没在系统里干活，数字只当参考，不考核。<Assumed>目标先按 报价确认 30 分钟、找货初检 2 小时、出销售单 30 分钟、复检打包 1 小时、出库 1 小时 定的；客户确认、签收、对账是客户的时间，不设目标。不到 10 单的数字灰掉。</Assumed></div>
        </div>
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
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>中方指令：几点下的、几点收到、几点完成</h2><Info>规定下达后 5 分钟内点「收到」（只算上班时间）。超时的那几条，系统查了他那几分钟有没有在系统里操作订单：有 = 当时在忙；没有 = 没在看。</Info></div>
        <Grid id="kpi-dir" rows={calc.dirPeople} empty="这段时间没有下过指令" columns={[
          { key: 'emp_no', label: '工号', w: 80 }, { key: 'name', label: '谁', w: 120, render: (r) => <b>{r.name}</b> },
          { key: 'n', label: '收到几条', w: 90, type: 'number' },
          { key: 'ackMed', label: '下达 → 收到', w: 130, value: (r) => r.ackMed ?? -1, render: (r) => <b>{fmtMin(r.ackMed)}</b> },
          { key: 'late', label: '超过 5 分钟', w: 200, value: (r) => r.late, render: (r) => (r.late ? <span className="pill red">{r.late} 次{r.lateIdle ? `，其中 ${r.lateIdle} 次当时没在操作` : '，当时都在处理单'}</span> : <span className="pill green">0</span>) },
          { key: 'unack', label: '到现在没收到', w: 120, value: (r) => r.unack, render: (r) => (r.unack ? <span className="pill red">{r.unack} 条</span> : '') },
          { key: 'doneMed', label: '收到 → 完成', w: 130, value: (r) => r.doneMed ?? -1, render: (r) => fmtMin(r.doneMed) },
          { key: 'rejects', label: '被退回', w: 90, type: 'number', render: (r) => (r.rejects ? <span className="pill amber">{r.rejects} 次</span> : '0') },
        ]} />
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>报价建好 → 热线点开联系客户</h2>{calc.openLate.length > 0 ? <span className="pill red">{calc.openLate.length} 张超过 5 分钟</span> : <span className="pill green">都在 5 分钟内</span>}<Info>单一建好就该联系客户，规定 5 分钟内点开。客户不接不算他的错，但每次没接要在单里记「客户忙」。</Info></div>
        <Grid id="kpi-open" rows={calc.openLate} empty="没有超时的" columns={[
          { key: 'biz_no', label: '订单号', w: 150, render: (r) => <DealLink id={r.id} no={r.biz_no} /> }, { key: 'customer_name', label: '客户', w: 160 },
          { key: 'created_at', label: '几点建的', w: 140, render: (r) => String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at).slice(0, 16).replace('T', ' ') },
          { key: 'mins', label: '过了多久才点开', w: 170, value: (r) => r.mins, render: (r) => <span className="pill red">{fmtMin(r.mins)}{r.opened ? '' : ' · 到现在还没点开'}</span> },
        ]} />
      </div>
      <HotlineKpi from={from} to={to} />
      <SalesComm from={from} to={to} />
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>仓库准确绩效 · 提成（正确出货每片 {data.rate} XOF）</h2><Info>按出库的片数算给这张单的复核人（没有复核人就给找货人）。这张单被记了发错的责任（少发 / 多发 / 发错型号），整张单的提成取消，下面列出是哪几张。月底算工资照这张表。每片多少钱在「设置 → 规则参数」里可调。</Info></div>
        <Grid id="kpi-com" rows={calc.comPeople} empty="这段时间没有出库" columns={[
          { key: 'emp_no', label: '工号', w: 80 }, { key: 'name', label: '谁', w: 120, render: (r) => <b>{r.name}</b> },
          { key: 'deals', label: '经手几单', w: 90, type: 'number' }, { key: 'pieces', label: '出库片数', w: 100, type: 'number', render: (r) => qtyf(r.pieces) },
          { key: 'okPieces', label: '算提成的片数', w: 120, type: 'number', render: (r) => <b>{qtyf(r.okPieces)}</b> },
          { key: 'acc', label: '准确率（按片）', w: 120, type: 'number', value: (r) => (r.pieces ? Math.round(r.okPieces / r.pieces * 1000) / 10 : null), render: (r) => { if (!r.pieces) return ''; const v = Math.round(r.okPieces / r.pieces * 1000) / 10; return <span className={`pill ${v >= 99.5 ? 'green' : v >= 97 ? 'amber' : 'red'}`}>{v}%</span>; } },
          { key: 'amount', label: '提成 XOF', w: 120, type: 'number', render: (r) => <b>{qtyf(r.amount)}</b> },
          { key: 'voided', label: '发错被取消的单', w: 320, value: (r) => r.voided.length, render: (r) => (r.voided.length ? <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="pill red">{r.voided.length} 单 · 少拿 {qtyf(r.lost)}</span>{r.voided.map((v) => <DealLink key={v.deal_id} id={v.deal_id} no={v.biz_no} />)}</span> : <span className="pill green">0</span>) },
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
