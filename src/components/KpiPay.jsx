// 时效与准确率页里的「联动工资」预览（Frank 11-25）: 这个月按现在的规则每人会奖 / 扣多少；建工资单时自动带进「时效准确奖扣」
import React from 'react';
import { useApp, useData, Info } from './ui.jsx';
import Grid from './Grid.jsx';
import { RuleGear } from './Rules.jsx';
import { EmpLink } from './Archives.jsx';
import { kpiPayRows } from '../lib/kpiPay.js';
import { q } from '../db/client.js';

export default function KpiPay({ month }) {
  const { org, tick } = useApp();
  const { data } = useData(() => kpiPayRows(org, month), [org, month, tick]);
  const { data: emps } = useData(() => q(`select id, short_name, emp_no from app.employees where org_id = $1`, [org]), [org]);
  const name = (id) => emps?.find((e) => e.id === id);
  const rows = (data?.rows || []).filter((r) => r.n || r.lines);
  const c = data?.cfg;
  return (
    <div className="card" style={{ marginBottom: 12 }} id="kpi-pay">
      <div className="card-h"><h2>联动工资 <span className="small muted">{month}</span> <RuleGear anchor="kpi-pay" title="时效 / 准确率联动工资" ids={['kpi.pay_on', 'kpi.pay_min', 'kpi.pay_good', 'kpi.pay_good_amt', 'kpi.pay_bad', 'kpi.pay_bad_amt', 'kpi.pay_acc_amt', 'kpi.pay_acc_bad', 'kpi.pay_acc_bad_amt']} /></h2>
        <Info>按这页同一套算法：时效 = 他经手、有目标时限的段在时限内做完的比例；找货准确 = 复检时被改的行。{c ? `现在的规则：达标率 ≥ ${c.good_rate}% 奖 ${c.good_amt.toLocaleString('en-US')}，< ${c.bad_rate}% 扣 ${c.bad_amt.toLocaleString('en-US')}；找货复检 0 改奖 ${c.acc_good_amt.toLocaleString('en-US')}，每 100 行被改超过 ${c.acc_bad_per100} 扣 ${c.acc_bad_amt.toLocaleString('en-US')}；不到 ${c.min_n} 段 / 行不奖不扣。` : ''}发错货已经在「仓库提成」里整单取消，这里不重复扣。建工资单时自动带进「时效准确奖扣」，手改过的重算不覆盖。</Info></div>
      {c && !c.on && <div className="card-b"><span className="pill gray">联动已关（⚙ 里打开）</span></div>}
      <Grid id="kpi-pay" compactTools rows={rows} rowKey={(r) => r.employee_id} empty="这个月还没有算到人头上的段（要员工用自己的账号点步骤）" columns={[
        { key: 'emp_no', label: '工号', w: 70, value: (r) => name(r.employee_id)?.emp_no || '' },
        { key: 'name', label: '谁', w: 110, value: (r) => name(r.employee_id)?.short_name || '', render: (r) => <EmpLink id={r.employee_id} name={name(r.employee_id)?.short_name || '—'} /> },
        { key: 'rate', label: '时效达标', w: 120, value: (r) => (r.n ? r.ok / r.n : -1), render: (r) => (r.n ? <span className={`pill ${r.n < (c?.min_n || 10) ? 'gray' : r.ok / r.n * 100 >= (c?.good_rate || 90) ? 'green' : r.ok / r.n * 100 < (c?.bad_rate || 70) ? 'red' : 'amber'}`}>{r.ok} / {r.n} · {Math.round(r.ok / r.n * 100)}%</span> : '') },
        { key: 'acc', label: '找货被改', w: 120, value: (r) => (r.lines ? r.fix / r.lines : -1), render: (r) => (r.lines ? `${r.fix} / ${r.lines} 行` : '') },
        { key: 'amount', label: '奖扣 XOF', w: 110, type: 'number', sum: true, render: (r) => <b className={r.amount < 0 ? 'red-t' : ''}>{r.amount > 0 ? '+' : ''}{r.amount.toLocaleString('en-US')}</b> },
        { key: 'note', label: '怎么算的', w: 380, value: (r) => r.note },
      ]} />
    </div>);
}
