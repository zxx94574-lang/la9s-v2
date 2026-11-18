// 317 (Frank 11-15 / 11-17): 公司收款账户 (Roland 公户 · Wave / 银行) —— 客户付到这里, 客户账照冲, 但钱在他手里, 交回公司之前算他欠公司.
// 这里直接看: 每个公户现在欠公司多少 + 每一笔 (客户、日期、金额、已交、还欠、压了几天). 交回 (交款 / 转出) 按先进先出冲最老的一笔.
import React, { useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Pill, Assumed } from './ui.jsx';
import { money, dDate, today } from '../lib/format.js';

const N = (v) => Number(v || 0);
const days = (d) => Math.max(0, Math.round((new Date(today()) - new Date(dDate(d))) / 864e5));

export default function PublicHeld({ urgentOnly }) {
  const { org, role, tick } = useApp();
  const [open, setOpen] = useState(null);
  const { data } = useData(async () => {
    if (!['admin', 'finance'].includes(role)) return null;
    const accs = await q(`select a.id, a.name, a.currency, a.hold_days, a.hold_limit, e.short_name as holder from app.cash_accounts a join app.employees e on e.id = a.holder_employee_id
      where a.org_id = $1 and a.active and a.name like '%公户%' order by a.name`, [org]);
    if (!accs.length) return [];
    const moves = await q(`select m.id, m.account_id, m.amount, m.on_date, m.kind, m.payer, app.move_sign(m) as sign, c.name as customer
      from app.cash_moves m left join app.customers c on c.id = m.customer_id where m.account_id = any($1::uuid[]) order by m.on_date, m.created_at`, [accs.map((a) => a.id)]);
    return accs.map((a) => {
      const mine = moves.filter((m) => m.account_id === a.id);
      let out = mine.filter((m) => N(m.sign) < 0).reduce((s, m) => s + N(m.amount), 0);
      const rows = mine.filter((m) => N(m.sign) > 0).map((m) => { const paid = Math.min(out, N(m.amount)); out -= paid; return { ...m, paid, left: N(m.amount) - paid }; });
      const owing = rows.filter((r) => r.left > 0.004);
      const oldest = owing.length ? days(owing[0].on_date) : 0;
      return { ...a, rows, owing, total: owing.reduce((s, r) => s + r.left, 0), oldest, late: a.hold_days != null && oldest > N(a.hold_days) };
    });
  }, [org, role, tick]);
  if (!data?.length) return null;
  // 待办页只在有人压款超期时出现 (317: 压款超 N 天进中方紧急待办)
  if (urgentOnly) {
    const late = data.filter((a) => a.late);
    if (!late.length) return null;
    return (
      <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
        <div className="card-h"><h2>公司的钱压在个人手里太久</h2><Pill tone="red">{late.length} 个账户</Pill><span className="small muted">到「资金账户」看每一笔</span></div>
        {late.map((a) => <div key={a.id} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
          <span className="age red">{a.oldest} 天</span><span className="small"><b>{a.holder}</b> · {a.name} · 最老一笔压了 {a.oldest} 天（上限 {a.hold_days} 天）</span><b>{money(a.total, a.currency)}</b></div>)}
      </div>);
  }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>公司收款账户：谁欠公司多少</h2>
        <Assumed>「交回」怎么对到每一笔：我按先进先出算（交回的钱先冲最老的那笔收款）。交回时到账比应交少的差额就是手续费，目前要你在交款时另记一笔办公费，系统还没自动拆。</Assumed>
        <span className="small muted">客户付到这些账户：客户的账已经冲了，钱还在持有人手里</span></div>
      <div className="numblocks">
        {data.map((a) => (
          <button type="button" key={a.id} className={`numblock ${a.late ? 'red' : a.total > 0 ? 'amber' : ''} ${open === a.id ? 'on' : ''}`} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
            <b>{money(a.total, a.currency)}</b><span>{a.holder} · {a.name}{a.total > 0 ? ` · 最老 ${a.oldest} 天` : ' · 都交回了'}</span>
          </button>))}
      </div>
      {data.filter((a) => a.id === open).map((a) => (
        <div key={a.id}>
          {a.owing.length ? a.owing.map((r) => (
            <div key={r.id} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
              <span className={`age ${a.hold_days != null && days(r.on_date) > N(a.hold_days) ? 'red' : 'amber'}`}>{days(r.on_date)} 天</span>
              <span className="small">{dDate(r.on_date)} · {r.customer || r.payer || (r.kind === 'opening' ? '期初' : '没挂客户')} · 收 {money(r.amount, a.currency)}{r.paid > 0 ? ` · 已交 ${money(r.paid, a.currency)}` : ''}</span>
              <b>{money(r.left, a.currency)}</b>
            </div>)) : <div className="card-b small muted">这个账户收到的钱都交回公司了。</div>}
          {a.late && <div className="card-b"><Pill tone="red">最老一笔压了 {a.oldest} 天，超过 {a.hold_days} 天的上限</Pill></div>}
        </div>))}
    </div>);
}
