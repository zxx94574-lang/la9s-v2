// 11-18 (Frank 第 5 点): 热线的三个数是他的任务 KPI (指标), 不是激励 —— 只显示、不算钱. 激励以后再说.
//  ① 5 分钟内点开报价的比例  ② 报价当天联系上客户确认的比例  ③ 回访完成率 (约好哪天再联系, 到那天有没有再联系)
import React from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Info, Pill, Assumed } from './ui.jsx';
import { workMinutes } from '../lib/worktime.js';

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const tone = (p, good, ok) => (p == null ? 'gray' : p >= good ? 'green' : p >= ok ? 'amber' : 'red');

export default function HotlineKpi({ from, to }) {
  const { org, tick } = useApp();
  const { data } = useData(async () => {
    const [quotes, follows] = await Promise.all([
      q(`select d.id, d.created_at, d.hotline_opened_at,
           (select min(ev.at) from app.deal_events ev where ev.deal_id = d.id and ev.action = 'hotline_confirmed') as confirmed_at
         from app.deals d where d.org_id = $1 and d.kind = 'normal' and d.status <> 'cancelled' and d.created_at >= $2::date and d.created_at < ($3::date + 1)`, [org, from, to]),
      q(`select h.id, h.next_follow_on,
           exists (select 1 from app.hotline_calls h2 where h2.customer_id = h.customer_id and h2.at > h.at and h2.at::date <= h.next_follow_on) as done
         from app.hotline_calls h where h.org_id = $1 and h.next_follow_on between $2::date and least($3::date, current_date)`, [org, from, to]),
    ]);
    return { quotes, follows };
  }, [org, from, to, tick]);
  if (!data) return null;
  const n = data.quotes.length;
  const fast = data.quotes.filter((x) => x.hotline_opened_at && workMinutes(x.created_at, x.hotline_opened_at) <= 5).length;
  const sameDay = data.quotes.filter((x) => x.confirmed_at && new Date(x.confirmed_at).toDateString() === new Date(x.created_at).toDateString()).length;
  const fn = data.follows.length; const fd = data.follows.filter((x) => x.done).length;
  const blocks = [
    ['5 分钟内点开报价', pct(fast, n), `${fast} / ${n} 张`, 90, 70],
    ['当天联系上客户确认', pct(sameDay, n), `${sameDay} / ${n} 张`, 80, 60],
    ['回访完成（约好的日子有再联系）', pct(fd, fn), `${fd} / ${fn} 次`, 90, 70],
  ];
  return (
    <div className="card">
      <div className="card-h"><h2>热线 KPI</h2><Pill tone="gray">只是指标，不算钱</Pill>
        <Info>这三个数是热线的任务指标：报价建好后 5 分钟内点开（只算上班时间）、报价当天联系上客户确认、约好哪天再联系的到那天有没有再联系。按上面选的时间段算。</Info>
        <Assumed>达标线是我先定的：点开 ≥ 90% 绿 / ≥ 70% 黄；当天确认 ≥ 80% 绿 / ≥ 60% 黄；回访 ≥ 90% 绿 / ≥ 70% 黄。「回访完成」的算法 = 约好的日子当天或之前有新的回访记录。激励没做（你说以后再说）。</Assumed></div>
      <div className="numblocks">
        {blocks.map(([label, p, sub, good, ok]) => { const tn = tone(p, good, ok); return (
          <div key={label} className={`numblock ${tn === 'red' ? 'red' : tn === 'amber' ? 'amber' : ''}`} style={{ cursor: 'default' }} title={label}><b style={tn === 'green' ? { color: '#1e8e5a' } : undefined}>{p == null ? '—' : `${p}%`}</b><span>{label}</span><span>{sub}</span></div>); })}
      </div>
    </div>);
}
