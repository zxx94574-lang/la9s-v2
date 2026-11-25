// 345 审批（Frank 11-17 21:55）：每类决定一种模式（自己定 / 知会 / 必须批准）+ 谁批 / 谁被知会；送批 = 一页纸报告，批准人可以直接改参数再批，批了立即执行
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Info, Choice, Modal, Pill, MoneyIn, Assumed } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { dt, money, friendlyError } from '../lib/format.js';
import { DECISION_KINDS, DECISION_MODES } from '../lib/decision.js';

const ST = { pending: ['等批', 'amber'], done: ['已生效', 'green'], rejected: ['退回', 'red'], cancelled: ['撤回', 'gray'] };
const val = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US') : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function Decisions() {
  const { org, role, toast, refresh, tick } = useApp();
  const [f, setF] = useState('mine'); const [open, setOpen] = useState(null);
  const { data } = useData(async () => {
    const [rows, [me], admins, [modes]] = await Promise.all([
      q(`select d.*, coalesce(e.short_name, '中方') as by_name, coalesce(e2.short_name, '') as decided_name,
           (select string_agg(x.short_name, '、') from app.employees x where x.id = any(d.who)) as who_names, app.decision_can_decide(d) as can, d.requested_by = app.uid() as mine_req
         from app.decisions d left join app.members m on m.user_id = d.requested_by and m.org_id = d.org_id left join app.employees e on e.id = m.employee_id
         left join app.members m2 on m2.user_id = d.decided_by and m2.org_id = d.org_id left join app.employees e2 on e2.id = m2.employee_id
         where d.org_id = $1 order by d.requested_at desc limit 300`, [org]),
      q(`select app.current_employee($1) as emp`, [org]),
      q(`select e.id, e.short_name from app.members m join app.employees e on e.id = m.employee_id where m.org_id = $1 and 'admin' = any(m.roles) order by e.short_name`, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'approval_modes'`, [org])]);
    return { rows, me: me?.emp, admins, modes: modes?.value || {} };
  }, [org, tick]);
  const rows = useMemo(() => data?.rows || [], [data]);
  if (!data) return <div className="card"><div className="empty">加载中…</div></div>;
  const mine = (d) => (d.mode === 'approve' && d.status === 'pending' && d.can) || (d.mode === 'notify' && (!d.who.length || d.who.includes(data.me)) && !d.acked.includes(data.me) && !d.mine_req);
  const shown = rows.filter((d) => (f === 'mine' ? mine(d) : f === 'pending' ? d.status === 'pending' : true));
  const setMode = async (kind, patch) => {
    const next = { ...data.modes, [kind]: { mode: 'self', who: [], ...(data.modes[kind] || {}), ...patch } };
    try { await call(role, `select app.set_org_setting($1,'approval_modes',$2)`, [org, JSON.stringify(next)]); toast(`${DECISION_KINDS[kind]}：${DECISION_MODES.find((m) => m[0] === next[kind].mode)[1]}`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Validation</div><h1>审批 <Info>重大的事要另一个人点头，但不是什么都走审批。每类决定选一种：<b>自己定</b>（中方谁定了都生效，留记录）/ <b>知会</b>（立即生效，同时推给指定的人「已阅」）/ <b>必须批准</b>（指定的人批了才生效，不能自己批自己）。批准人可以直接改报告里的数再批。</Info></h1></div>
        <Choice value={f} onChange={setF} options={[['mine', `要我处理 ${rows.filter(mine).length}`], ['pending', '所有等批'], ['all', '全部']]} /></div>
      <div className="card"><div className="card-h"><h2>每类决定怎么走</h2><Assumed>你 11-17 说清仓 / 改档位规则 / 核销坏账初始要汪波批准。我先全放成「自己定」：汪波还没账号的时候设成必须批准，事就卡住了。他开了账号你在这里点一下就行。</Assumed></div>
        <div className="card-b stack" style={{ gap: 8 }}>{Object.entries(DECISION_KINDS).map(([k, label]) => { const m = data.modes[k] || { mode: 'self', who: [] }; return (
          <div key={k} className="row" style={{ gap: 10, flexWrap: 'wrap' }}><b style={{ minWidth: 270 }}>{label}</b>
            <Choice value={m.mode} onChange={(v) => setMode(k, { mode: v })} options={DECISION_MODES} />
            {m.mode !== 'self' && <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="small muted">{m.mode === 'approve' ? '谁批' : '知会谁'}：</span>
              {data.admins.map((a) => <label key={a.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={(m.who || []).includes(a.id)} onChange={() => setMode(k, { who: (m.who || []).includes(a.id) ? m.who.filter((x) => x !== a.id) : [...(m.who || []), a.id] })} />{a.short_name}</label>)}
              {!(m.who || []).length && <span className="small muted">（不勾 = 除了提的人以外任何一位中方）</span>}</span>}
          </div>); })}</div></div>
      <div className="card"><Grid id="decisions" compactTools rows={shown} rowKey={(d) => d.id} onRowClick={(d) => setOpen(d)} empty={f === 'mine' ? '没有要你处理的' : '还没有'} columns={[
        { key: 'requested_at', label: '时间', w: 130, render: (d) => dt(d.requested_at) },
        { key: 'kind', label: '类型', w: 120, value: (d) => DECISION_KINDS[d.kind] || d.kind },
        { key: 'title', label: '要定什么', w: 320, render: (d) => <b>{d.title}</b> },
        { key: 'mode', label: '方式', w: 80, value: (d) => (d.mode === 'approve' ? '批准' : '知会') },
        { key: 'by_name', label: '谁提的', w: 80 }, { key: 'who_names', label: '批准 / 知会', w: 110, value: (d) => d.who_names || '任一中方' },
        { key: 'status', label: '状态', w: 90, value: (d) => ST[d.status][0], render: (d) => <Pill tone={ST[d.status][1]}>{ST[d.status][0]}</Pill> },
        { key: 'decided', label: '结果', w: 200, value: (d) => (d.decided_at ? `${d.decided_name} ${dt(d.decided_at)} ${d.note || ''}` : ''), render: (d) => (d.decided_at ? <span className="small">{d.decided_name} · {dt(d.decided_at)}{d.note ? ` · ${d.note}` : ''}</span> : null) },
      ]} /></div>
      {open && <Report d={open} me={data.me} onClose={() => setOpen(null)} />}
    </>);
}

// 一页纸报告：要定什么 / 关键数字 / 参数（批准人可以改价格、日期再批）
function Report({ d, me, onClose }) {
  const { role, toast, refresh } = useApp();
  const [args, setArgs] = useState(d.args); const [note, setNote] = useState('');
  const edited = JSON.stringify(args) !== JSON.stringify(d.args);
  const go = async (sql, params, msg) => { try { await call(role, sql, params); toast(msg); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const pending = d.status === 'pending' && d.mode === 'approve';
  const editable = pending && d.can && d.kind === 'promo';
  return (
    <Modal wide title={d.title} risk={pending ? 'yellow' : undefined} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>关闭</button><span className="grow" />
      {d.mode === 'notify' && !d.mine_req && !d.acked.includes(me) && <button type="button" className="btn primary" onClick={() => go(`select app.decision_ack($1)`, [d.id], '已阅')}>已阅</button>}
      {pending && (d.can || d.mine_req) && <button type="button" className="btn soft-red" disabled={!note.trim()} title={note.trim() ? '' : '先写意见'} onClick={() => go(`select app.decision_reject($1,$2)`, [d.id, note], d.can ? '已退回' : '已撤回')}>{d.can ? '退回' : '撤回'}</button>}
      {pending && d.can && <button type="button" className="btn primary" onClick={() => go(`select app.decision_approve($1,$2,$3)`, [d.id, note || null, edited ? JSON.stringify(args) : null], edited ? '已按改过的数批准，立即生效' : '已批准，立即生效')}>{edited ? '按改过的批准' : '批准'}</button>}</>}>
      <div className="stack">
        <div className="row" style={{ gap: 8 }}><Pill tone={ST[d.status][1]}>{ST[d.status][0]}</Pill><span className="small muted">{DECISION_KINDS[d.kind]} · {d.by_name} 提 · {dt(d.requested_at)}{d.who_names ? ` · ${d.mode === 'approve' ? '批准人' : '知会'} ${d.who_names}` : ''}</span></div>
        <div className="kv">{Object.entries(d.report || {}).map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v" style={{ fontSize: 15 }}>{val(v)}</div></div>)}</div>
        {editable && <div className="panel"><div className="small muted" style={{ marginBottom: 6 }}>可以直接改了再批（改了留痕）：</div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <label className="row" style={{ gap: 6 }}>价格<MoneyIn className="in" style={{ width: 110 }} value={String(args.price ?? '')} onChange={(e) => setArgs({ ...args, price: Number(String(e.target.value).replace(/[^\d.]/g, '')) || 0 })} /></label>
            <label className="row" style={{ gap: 6 }}>到哪天<input className="in" type="date" value={args.to || ''} onChange={(e) => setArgs({ ...args, to: e.target.value })} /></label>
            {edited && <span className="pill amber">改过（原价 {money(d.args.price)}，到 {d.args.to}）</span>}</div></div>}
        {d.note && <div className="hint">意见：{d.note}</div>}
        {pending && (d.can || d.mine_req) && <input className="in" style={{ width: '100%' }} placeholder={d.can ? '意见（退回必填，批准可不填）' : '撤回原因'} value={note} onChange={(e) => setNote(e.target.value)} />}
      </div>
    </Modal>);
}
