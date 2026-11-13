// 热线回访 (Frank 2026-10-29): 热线每天打开就看到「今天要打谁」，打完点一下记结果，不用再录飞书.
// 今天要打 = 约好今天或更早跟进的 + 正式客户 14 天没联系也没下单的 (沉睡). 备件、回收分开.
import { fmtPhone, telHref } from '../lib/phone.js';
import React, { useMemo, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, DatePicker } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { CallModal, ProspectModal, ResultPill, KIND, CALL_RESULTS } from '../components/Crm.jsx';
import { CustomerDrawer } from './Customers.jsx';
import { can } from '../lib/domain.js';
import { dDate, dt, today, periodRange } from '../lib/format.js';

const SLEEP_DAYS = 14;
const daysSince = (v) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 864e5) : null);

import { CallLists } from '../components/Batch2.jsx';
export default function Hotline() {
  const { org, role } = useApp();
  const [tab, setTab] = useState('queue');
  const [line, setLine] = useState('spare');
  const [range, setRange] = useState(() => { const [, to] = periodRange('day'); const f = new Date(); f.setDate(f.getDate() - 30); return [dDate(f), to]; });
  const [callFor, setCallFor] = useState(null);
  const [open, setOpen] = useState(null);
  const [newP, setNewP] = useState(false);
  const { data } = useData(async () => {
    const [cust, calls] = await Promise.all([q(Q.customerProfiles, [org]), q(Q.hotlineCalls, [org, range[0], range[1]])]);
    return { cust, calls };
  }, [org, range[0], range[1]]);
  const td = today();
  const queue = useMemo(() => {
    if (!data) return [];
    return data.cust.filter((c) => c.status !== 'inactive' && (line === 'spare' ? c.kind !== 'recycle' : c.kind !== 'spare' || c.next_recycle)).map((c) => {
      // 每条线各算各的: 备件看备件回访 + 拜访约的日期, 回收只看回收回访
      const next = line === 'spare' ? [c.next_spare, c.next_follow].filter(Boolean).sort()[0] : c.next_recycle;
      const due = next && dDate(next) <= td;
      const quiet = daysSince(line === 'spare' ? c.last_contact : c.last_recycle), idle = daysSince(c.last_deal);
      const sleep = c.status === 'active' && (quiet == null || quiet >= SLEEP_DAYS) && (line === 'recycle' || idle == null || idle >= SLEEP_DAYS);
      const why = due ? `约了 ${dDate(next)} 跟进` : sleep ? `${quiet == null ? '从没回访' : `${quiet} 天没联系`}${line === 'recycle' ? '' : idle == null ? '、没下过单' : `、${idle} 天没下单`}` : null;
      return why ? { ...c, why, next, rank: due ? 0 : 1 } : null;
    }).filter(Boolean).sort((a, b) => a.rank - b.rank || String(a.next || '').localeCompare(String(b.next || '')));
  }, [data, line, td]);
  if (!data) return <div className="empty">加载中…</div>;
  const todayCalls = data.calls.filter((c) => dDate(c.at) === td);
  const qCols = [
    { key: 'code', label: '编码', w: 90, value: (c) => c.code || c.temp_code, render: (c) => <span className="mono">{c.code || c.temp_code}</span> },
    { key: 'name', label: '客户', w: 170, render: (c) => <b>{c.name}</b> },
    { key: 'city', label: '城市', w: 90 },
    { key: 'phone', label: '电话', w: 140, render: (c) => (c.phone ? <a href={telHref(c.phone)} onClick={(e) => e.stopPropagation()}>{fmtPhone(c.phone)}</a> : '—') },
    { key: 'why', label: '为什么要打', w: 200, render: (c) => (c.rank === 0 ? <Pill tone="red">{c.why}</Pill> : <span className="muted">{c.why}</span>) },
    { key: 'kind', label: '类型', w: 90, value: (c) => (c.status === 'prospect' ? '潜客' : KIND[c.kind]), render: (c) => (c.status === 'prospect' ? <Pill tone="amber">潜客</Pill> : KIND[c.kind]) },
  ];
  const lCols = [
    { key: 'at', label: '时间', w: 130, value: (r) => r.at, render: (r) => dt(r.at) },
    { key: 'name', label: '客户', w: 170, value: (r) => `${r.code || r.temp_code} ${r.name}`, render: (r) => <><span className="mono muted">{r.code || r.temp_code}</span> <b>{r.name}</b></> },
    { key: 'line', label: '线', w: 60, value: (r) => (r.line === 'recycle' ? '回收' : '备件') },
    { key: 'channel', label: '方式', w: 80, value: (r) => ({ call: '电话', whatsapp: 'WhatsApp', visit: '上门' })[r.channel] },
    { key: 'result', label: '结果', w: 100, value: (r) => (CALL_RESULTS.find((x) => x[0] === r.result) || [])[1], render: (r) => <ResultPill v={r.result} /> },
    { key: 'note', label: '说明', w: 240 },
    { key: 'next_follow_on', label: '下次跟进', w: 100, render: (r) => dDate(r.next_follow_on) },
    { key: 'staff', label: '回访人', w: 80 },
  ];
  const byResult = Object.fromEntries(CALL_RESULTS.map(([k]) => [k, todayCalls.filter((c) => c.result === k).length]));
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Suivi hotline</div><h1>热线回访</h1>
        <div className="sub">今天要打：约了今天（或更早）跟进的，加上 {SLEEP_DAYS} 天没联系也没下单的正式客户。打完点「记结果」，选一下结果就行。</div></div>
        {can(role, 'prospect') && <button type="button" className="btn" onClick={() => setNewP(true)}>＋ 新潜客</button>}
      </div>
      <div className="card">
        <div className="tabs">
          <button type="button" className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>今天要打 <span className="queue-n">{queue.length}</span></button>
          <button type="button" className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>回访记录</button>
          <button type="button" className={tab === 'lists' ? 'on' : ''} onClick={() => setTab('lists')}>打电话名单</button>
          <span className="grow" />
          <span className="small muted" style={{ alignSelf: 'center' }}>今天已打 <b>{todayCalls.length}</b>{todayCalls.length > 0 && <>：下单 {byResult.order}，要报价 {byResult.quote}，没接 {byResult.no_answer}</>}</span>
        </div>
        {tab === 'lists' ? <div className="card-b"><CallLists /></div> : tab === 'queue' ? (<>
          <Grid id="hotline-queue" table="deals" columns={qCols} rows={queue} onRowClick={(c) => setOpen(c.id)} rowActions={can(role, 'prospect') ? [{ label: '☎ 记这通电话的结果', run: (c) => setCallFor(c) }] : undefined} empty="今天没有要打的 👍"
            tools={<div className="seg">{[['spare', '备件'], ['recycle', '回收']].map(([v, l]) => <button type="button" key={v} className={line === v ? 'on' : ''} onClick={() => setLine(v)}>{l}</button>)}</div>} />
        </>) : (<>
          <Grid id="hotline-log" table="hotline_calls" columns={lCols} rows={data.calls} onRowClick={(r) => setOpen(r.customer_id)} empty="这段时间没有回访记录"
            tools={<DatePicker range value={range} onChange={setRange} />} />
        </>)}
      </div>
      {callFor && <CallModal customer={callFor} onClose={() => setCallFor(null)} />}
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
      {newP && <ProspectModal kind={line} onClose={() => setNewP(false)} onDone={(c) => setOpen(c.id)} />}
    </>
  );
}
