// 时效 / 准确率 → 工资（Frank 11-25）: 和「时效与准确率」页同一套算法，按员工算出这个月的奖扣
// 时效: 他经手的、有目标时限的段（报价确认 / 找货初检 / 出销售单 / 复检打包 / 出库），达标率 = 在时限内做完的 ÷ 做完的
// 准确: 找货人 = 复检时被改了数量的行 ÷ 他找的总行数（仓库发错已经在「仓库提成」里整单取消，这里不重复扣）
// 少于最少单数的不奖不扣（样本太少不公平）
import { q } from '../db/client.js';
import { workMinutes } from './worktime.js';
import { SEGS, KPI_TARGET } from '../pages/Kpi.jsx';

export const KPI_PAY_DEFAULT = { on: true, min_n: 10, good_rate: 90, good_amt: 10000, bad_rate: 70, bad_amt: 5000, acc_good_amt: 5000, acc_bad_per100: 5, acc_bad_amt: 5000 };
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

export async function kpiPayRows(org, month) {
  const from = `${month}-01`; const d = new Date(`${from}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); const to = d.toISOString().slice(0, 10);
  const [deals, events, emps, checks, tg, cfgRow] = await Promise.all([
    q(`select d.id, (select count(*) from app.deal_lines l where l.deal_id = d.id)::int as lines from app.deals d where d.org_id = $1 and d.kind = 'normal' and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to]),
    q(`select e.deal_id, e.at, e.action, e.detail, emp.short_name from app.deal_events e join app.deals d on d.id = e.deal_id
       left join app.members m on m.user_id = e.user_id and m.org_id = d.org_id left join app.employees emp on emp.id = m.employee_id
       where d.org_id = $1 and d.created_at >= $2::date and d.created_at < ($3::date + 1) order by e.at`, [org, from, to]),
    q(`select id, short_name from app.employees where org_id = $1`, [org]),
    q(`select d.picker_employee_id, count(*)::int as lines, count(*) filter (where l.review_changed or l.diff_reason like '复核%')::int as fix
       from app.deal_lines l join app.deals d on d.id = l.deal_id where d.org_id = $1 and d.created_at >= $2::date and d.created_at < ($3::date + 1) and d.picker_employee_id is not null group by 1`, [org, from, to]).catch(() => []),
    q(`select value from app.org_settings where org_id = $1 and key = 'kpi_targets'`, [org]),
    q(`select value from app.org_settings where org_id = $1 and key = 'kpi_pay'`, [org]),
  ]);
  const cfg = { ...KPI_PAY_DEFAULT, ...(cfgRow[0]?.value || {}) }; for (const k of Object.keys(KPI_PAY_DEFAULT)) if (k !== 'on') cfg[k] = Number(cfg[k]);
  const target = { ...KPI_TARGET, ...(tg[0]?.value || {}) };
  const nameOf = (id) => emps.find((e) => e.id === id)?.short_name; const idOf = (n) => emps.find((e) => e.short_name === n)?.id;
  const byDeal = {}; for (const e of events) (byDeal[e.deal_id] ||= []).push(e);
  const P = {}; const get = (id) => (P[id] ||= { employee_id: id, n: 0, ok: 0, lines: 0, fix: 0 });
  for (const dl of deals) {
    const ev = byDeal[dl.id] || [];
    SEGS.forEach(([, a, b, , who], i) => {
      const t = Number(target['s' + i]); if (!t) return;   // 客户的段没有目标，不算员工的
      const f0 = ev.find((x) => x.action === a); const t0 = f0 && ev.find((x) => x.action === b && new Date(x.at) >= new Date(f0.at)); if (!f0 || !t0) return;
      const id = idOf(who({ from: f0, to: t0 }, nameOf)); if (!id) return;
      const p = get(id); p.n += 1; if (workMinutes(f0.at, t0.at) <= t) p.ok += 1;
    });
  }
  for (const c of checks) { const p = get(c.picker_employee_id); p.lines += Number(c.lines); p.fix += Number(c.fix); }
  return { cfg, rows: Object.values(P).map((p) => {
    let amt = 0; const why = [];
    if (cfg.on) {
      if (p.n >= cfg.min_n) { const r = (p.ok / p.n) * 100;
        if (r >= cfg.good_rate) { amt += cfg.good_amt; why.push(`时效 ${r.toFixed(0)}%（${p.ok}/${p.n}）+${fmt(cfg.good_amt)}`); }
        else if (r < cfg.bad_rate) { amt -= cfg.bad_amt; why.push(`时效 ${r.toFixed(0)}%（${p.ok}/${p.n}）−${fmt(cfg.bad_amt)}`); }
        else why.push(`时效 ${r.toFixed(0)}%（${p.ok}/${p.n}）不奖不扣`); }
      else if (p.n) why.push(`时效 ${p.n} 段，不到 ${cfg.min_n} 不算`);
      if (p.lines >= cfg.min_n) { const per = (p.fix / p.lines) * 100;
        if (p.fix === 0) { amt += cfg.acc_good_amt; why.push(`找货 ${p.lines} 行复检 0 改 +${fmt(cfg.acc_good_amt)}`); }
        else if (per > cfg.acc_bad_per100) { amt -= cfg.acc_bad_amt; why.push(`找货每 100 行被改 ${per.toFixed(1)} −${fmt(cfg.acc_bad_amt)}`); }
        else why.push(`找货每 100 行被改 ${per.toFixed(1)} 不奖不扣`); }
    } else why.push('联动已关');
    return { ...p, amount: amt, note: why.join('；') };
  }) };
}
