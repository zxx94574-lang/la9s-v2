// 436 (Frank 11-19): 回款记录 —— 把钱通过回款公司汇回国内 (9S 人民币 / LA 人民币 / 9S 香港美金).
//  登记一笔 → 马上从交出钱的账户里扣; 到账由我们跟国内确认完再填 (只中方, 截图必传, 可分几次); 核对完算结束.
//  应到 − 实到 = 这笔回款的全部成本, 系统拆成: 汇率上付的 (对比参考汇率) / 回款公司声明的手续费 / 说不清的差额.
//  记录永远保留: 不能删, 录错只能作废 + 写原因 (钱加回原账户).
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, DatePicker, MoneyIn, PhotoInput, Thumb, Assumed, Pill, Info } from './ui.jsx';
import { OptChoice } from './Opts.jsx';
import { RuleGear, useRuleValues } from './Rules.jsx';
import Grid from './Grid.jsx';
import { money, today, dDate, friendlyError } from '../lib/format.js';

const N = (v) => Number(v || 0);
export const REMIT_ST = { sent: ['amber', '在途'], arrived: ['blue', '已到账 · 待核对'], checked: ['green', '已核对'], void: ['gray', '已作废'] };
const f6 = (v) => (v == null ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 5 }));

export function useRemits(from, to) {
  const { org, role, tick } = useApp();
  const ok = ['admin', 'finance'].includes(role);
  const { data } = useData(async () => (ok ? q(`select * from app.v_remittances where org_id = $1 ${from ? 'and on_date between $2::date and $3::date' : ''} order by on_date desc, created_at desc`, from ? [org, from, to] : [org]) : null), [org, role, tick, from, to]);
  return data;
}
export const useRemitRules = () => { const d = useRuleValues(['remit.diff', 'remit.days']); const v = d?.find((x) => x.key === 'remit_rules')?.value || {}; return { diffPct: N(v.diff_pct ?? 2), days: N(v.transit_days ?? 3) }; };
// 这一笔要不要标红: 在途太久, 或到账比应到差太多
export const remitFlag = (r, rules) => (r.status === 'sent' && N(r.days_out) > rules.days ? `在途 ${r.days_out} 天` : r.status === 'arrived' && N(r.expected) && Math.abs(N(r.expected) - N(r.arrived)) / N(r.expected) * 100 > rules.diffPct ? `到账差 ${(Math.abs(N(r.expected) - N(r.arrived)) / N(r.expected) * 100).toFixed(1)}%` : null);

export const remitCols = (rules) => [
  { key: 'remit_no', label: '回款单号', w: 150, render: (r) => <b className="mono">{r.remit_no}</b> },
  { key: 'on_date', label: '交出日期', w: 100, render: (r) => dDate(r.on_date) },
  { key: 'st', label: '状态', w: 130, value: (r) => REMIT_ST[r.status][1], render: (r) => { const fl = remitFlag(r, rules); return <><Pill tone={REMIT_ST[r.status][0]}>{REMIT_ST[r.status][1]}</Pill>{fl && <span className="pill red" style={{ marginLeft: 4 }}>{fl}</span>}</>; } },
  { key: 'from_account', label: '从哪个账户', w: 110 },
  { key: 'amount_out', label: '交出金额', w: 130, type: 'money', value: (r) => N(r.amount_out), render: (r) => `${money(r.amount_out, r.out_currency)} ${r.out_currency}` },
  { key: 'company', label: '回款公司', w: 110 },
  { key: 'to_account', label: '回到哪个账户', w: 130 },
  { key: 'rate', label: '约定汇率', w: 120, type: 'number', value: (r) => N(r.rate), render: (r) => `1 ${r.currency} = ${f6(r.rate)}` },
  { key: 'expected', label: '应到', w: 120, type: 'money', value: (r) => N(r.expected), render: (r) => `${money(r.expected, r.currency)} ${r.currency}` },
  { key: 'arrived', label: '实际到账', w: 120, type: 'money', value: (r) => (r.arrivals ? N(r.arrived) : null), render: (r) => (r.arrivals ? <b>{money(r.arrived, r.currency)} {r.currency}</b> : <span className="muted">还没填</span>) },
  { key: 'fx_cost', label: '汇率上付的', w: 120, type: 'money', value: (r) => (r.fx_cost == null ? null : N(r.fx_cost)), render: (r) => (r.fx_cost == null ? '' : `${money(r.fx_cost, r.currency)} ${r.currency}`) },
  { key: 'fee_declared', label: '声明的手续费', w: 110, type: 'money', value: (r) => N(r.fee_declared), render: (r) => (N(r.fee_declared) ? `${money(r.fee_declared, r.currency)} ${r.currency}` : '') },
  { key: 'short', label: '说不清的差额', w: 120, type: 'money', value: (r) => (r.short == null ? null : N(r.short)), render: (r) => (r.short == null ? '' : <span className={N(r.short) > 0.004 ? 'red-t2' : ''}>{money(r.short, r.currency)} {r.currency}</span>) },
  { key: 'proof', label: '凭证', w: 70, sortable: false, filterable: false, render: (r) => r.proof && <Thumb src={r.proof} size={28} label={`${r.remit_no} 回款凭证`} /> },
  { key: 'note', label: '说明', w: 180, value: (r) => [r.note, r.check_note, r.void_note && `作废：${r.void_note}`].filter(Boolean).join(' · ') },
];

// 资金账户页里的「回款」板块
export default function RemitCard({ accounts }) {
  const { role } = useApp();
  const rows = useRemits(); const rules = useRemitRules();
  const [m, setM] = useState(null);
  if (!rows) return null;
  const admin = role === 'admin';
  const live = rows.filter((r) => r.status !== 'void');
  const transit = live.filter((r) => r.status === 'sent');
  return (
    <div className="card" style={{ marginBottom: 12 }} id="remit">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>回款 <Info>把钱通过回款公司汇回国内。登记后马上从交出的账户里扣；到账后回来填到账。</Info> <RuleGear anchor="remit-rules" title="回款规则" ids={['remit.diff', 'remit.days']} />
          <Assumed>到账由中方跟国内确认完再填（Frank 11-19 定）。先定成只有中方能填到账 / 核对 / 作废，财务能登记回款；要放给财务填到账告诉 Claude。参考汇率没填就用记账汇率。</Assumed></h2>
        {transit.length > 0 && <Pill tone="amber">在途 {transit.length} 笔</Pill>}
        <span className="grow" />
        <button type="button" className="btn primary sm" onClick={() => setM({ t: 'new' })}>＋ 记一笔回款</button>
      </div>
      <Grid id="remit" columns={remitCols(rules)} rows={rows} slimTools rowClass={(r) => (r.status === 'void' ? 'row-void' : '')}
        empty="还没有回款记录。把钱交给回款公司汇回国内时，点「＋ 记一笔回款」。"
        rowActions={admin ? [
          { label: '填到账', when: (r) => ['sent', 'arrived'].includes(r.status), run: (r) => setM({ t: 'arrive', r }) },
          { label: '核对完', when: (r) => r.status === 'arrived', run: (r) => setM({ t: 'check', r }) },
          { label: '作废这笔', tone: 'danger', when: (r) => r.status === 'sent', run: (r) => setM({ t: 'void', r }) },
        ] : undefined} />
      {m?.t === 'new' && <RemitForm accounts={accounts} onClose={() => setM(null)} />}
      {m?.t === 'arrive' && <ArriveForm r={m.r} onClose={() => setM(null)} />}
      {m?.t === 'check' && <NoteForm r={m.r} title={`核对完 · ${m.r.remit_no}`} sql="select app.remit_check($1,$2)" rules={rules} onClose={() => setM(null)} />}
      {m?.t === 'void' && <NoteForm r={m.r} title={`作废 · ${m.r.remit_no}`} sql="select app.void_remittance($1,$2)" voiding onClose={() => setM(null)} />}
    </div>);
}

function RemitForm({ accounts, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data: tos } = useData(async () => { await call(role, `select app.ensure_remit_accounts($1)`, [org]); return q(`select id, name, currency from app.remit_accounts where org_id = $1 and active order by sort`, [org]); }, [org]);
  const { data: ps } = useData(() => q(`select rmb_per_xof, xof_per_usd from app.price_settings where org_id = $1`, [org]), [org]);
  const accs = (accounts || []).filter((a) => a.active !== false && !a.is_public);
  const [f, setF] = useState({ from: accs.find((a) => a.currency === 'XOF')?.account_id || accs[0]?.account_id || '', date: today(), amount: '', company: '', to: '', rate: '', ref: '', fee: '', proof: '', note: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const a = accs.find((x) => x.account_id === f.from); const t = (tos || []).find((x) => x.id === f.to);
  const refDefault = t && a?.currency === 'XOF' && ps?.[0] ? (t.currency === 'USD' ? N(ps[0].xof_per_usd) : t.currency === 'CNY' && N(ps[0].rmb_per_xof) ? Math.round(1 / N(ps[0].rmb_per_xof) * 1000) / 1000 : '') : '';
  const ref = f.ref || refDefault;
  const expected = N(f.amount) > 0 && N(f.rate) > 0 ? N(f.amount) / N(f.rate) : null;
  const fx = expected != null && N(ref) > 0 ? N(f.amount) / N(ref) - expected : null;
  const miss = { from: !f.from, amount: !(N(f.amount) > 0), company: !f.company, to: !f.to, rate: !(N(f.rate) > 0), proof: !f.proof };
  const ok = !Object.values(miss).some(Boolean);
  const go = async () => {
    try {
      await call(role, `select app.create_remittance($1,$2)`, [org, JSON.stringify({ from_account_id: f.from, on_date: f.date, amount_out: N(f.amount), company: f.company, to_account_id: f.to, rate: N(f.rate), ref_rate: N(ref) || null, fee_declared: N(f.fee) || 0, proof: f.proof, note: f.note })]);
      toast(`已记回款，${a.name} 里已经扣掉 ${money(f.amount, a.currency)} ${a.currency}`); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="记一笔回款" risk="red" wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!ok} onClick={go}>确认回款</button></>}>
      <div className="stack">
        <div className="grid2">
          <div className="field req"><label>从哪个账户交出去</label><OptChoice optKey="cash_accounts" title="资金账户" data value={f.from} onChange={set('from')} options={accs.map((x) => [x.account_id, x.name, `${x.currency} · 余额 ${money(x.balance, x.currency)}`])} err={miss.from} flat={false} /></div>
          <div className="field req"><label>交出日期</label><DatePicker value={f.date} onChange={set('date')} /></div>
          <div className="field req"><label>交出多少 {a?.currency}</label><MoneyIn className={`in ${miss.amount ? 'err-in' : ''}`} value={f.amount} onChange={(e) => set('amount')(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          <div className="field req"><label>回款公司</label><OptChoice optKey="remit_companies" title="回款公司" value={f.company} onChange={set('company')} options={[]} placeholder="选回款公司…（⚙ 里加）" err={miss.company} flat={false} /></div>
          <div className="field req"><label>回到哪个账户</label><OptChoice optKey="remit_accounts" title="回款收款账户" data value={f.to} onChange={set('to')} options={(tos || []).map((x) => [x.id, x.name, x.currency])} err={miss.to} flat={false} /></div>
          <div className="field req"><label>约定汇率：1 {t?.currency || '外币'} = 多少 {a?.currency || 'XOF'}</label><MoneyIn className={`in ${miss.rate ? 'err-in' : ''}`} inputMode="decimal" value={f.rate} onChange={(e) => set('rate')(e.target.value.replace(/[^\d.]/g, ''))} placeholder="回款公司给的数，例 615" /></div>
          <div className="field"><label>参考汇率（当天真实价，可不填）</label><MoneyIn className="in" inputMode="decimal" value={f.ref} onChange={(e) => set('ref')(e.target.value.replace(/[^\d.]/g, ''))} placeholder={refDefault ? `不填就用记账汇率 ${refDefault}` : ''} /></div>
          <div className="field"><label>回款公司另收的手续费 {t?.currency}（没有就空着）</label><MoneyIn className="in" inputMode="decimal" value={f.fee} onChange={(e) => set('fee')(e.target.value.replace(/[^\d.]/g, ''))} /></div>
        </div>
        {expected != null && t && <div className="banner" style={{ display: 'block' }}>
          应到 <b>{money(expected, t.currency)} {t.currency}</b>（{money(f.amount, a?.currency)} ÷ {f.rate}）
          {fx != null && Math.abs(fx) > 0.004 && <span className="small"> · 对比参考汇率 {ref}，汇率上{fx > 0 ? '付了' : '赚了'} <b>{money(Math.abs(fx), t.currency)} {t.currency}</b>（{(Math.abs(fx) / (expected + fx) * 100).toFixed(2)}%）</span>}
        </div>}
        <div className="field req"><label>回款凭证（交钱的收条 / 转账截图）</label><PhotoInput value={f.proof} onChange={set('proof')} invalid={miss.proof} /></div>
        <div className="field"><label>说明</label><input className="in" value={f.note} onChange={set('note')} /></div>
        <div className="hint">确认后马上从「{a?.name}」里扣掉这笔钱。到账以后回来点「填到账」。记录不能删，录错了只能作废。</div>
      </div>
    </Modal>);
}

function ArriveForm({ r, onClose }) {
  const { role, toast, refresh } = useApp();
  const left = Math.max(0, N(r.expected) - N(r.arrived) - N(r.fee_declared));
  const [f, setF] = useState({ amount: left ? String(left) : '', date: today(), proof: '', note: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const ok = N(f.amount) > 0 && f.proof;
  const go = async () => { try { await call(role, `select app.remit_arrive($1,$2,$3,$4,$5)`, [r.id, N(f.amount), f.date, f.proof, f.note]); toast('到账已记'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`填到账 · ${r.remit_no}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!ok} onClick={go}>保存到账</button></>}>
      <div className="stack">
        <div className="small muted">{r.to_account} · 应到 <b>{money(r.expected, r.currency)} {r.currency}</b>{r.arrivals > 0 && <> · 已经到了 {money(r.arrived, r.currency)} {r.currency}（{r.arrivals} 次）</>}。跟国内确认完再填；一笔分几次到就填几次。</div>
        <div className="grid2">
          <div className="field req"><label>这次到了多少 {r.currency}</label><MoneyIn className={`in ${N(f.amount) > 0 ? '' : 'err-in'}`} inputMode="decimal" value={f.amount} onChange={(e) => set('amount')(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          <div className="field req"><label>到账日期</label><DatePicker value={f.date} onChange={set('date')} /></div>
        </div>
        <div className="field req"><label>到账截图（国内发来的银行截图）</label><PhotoInput value={f.proof} onChange={set('proof')} invalid={!f.proof} /></div>
        <div className="field"><label>说明</label><input className="in" value={f.note} onChange={set('note')} /></div>
      </div>
    </Modal>);
}

function NoteForm({ r, title, sql, voiding, rules, onClose }) {
  const { role, toast, refresh } = useApp();
  const [note, setNote] = useState('');
  const pct = N(r.expected) ? Math.abs(N(r.expected) - N(r.arrived)) / N(r.expected) * 100 : 0;
  const need = voiding || (rules && pct > rules.diffPct);
  const go = async () => { try { await call(role, sql, [r.id, note]); toast(voiding ? '已作废，钱已加回原账户' : '已核对'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={title} risk={voiding ? 'red' : 'yellow'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>不动</button><button type="button" className={`btn ${voiding ? 'danger' : 'primary'}`} disabled={need && !note.trim()} onClick={go}>{voiding ? '作废这笔回款' : '核对完'}</button></>}>
      <div className="stack">
        {voiding ? <div className="small">作废 <b>{r.remit_no}</b>：{money(r.amount_out, r.out_currency)} {r.out_currency} 加回「{r.from_account}」。这条记录不会删，会标成「已作废」留底。</div>
          : <div className="small">应到 <b>{money(r.expected, r.currency)} {r.currency}</b> · 实到 <b>{money(r.arrived, r.currency)} {r.currency}</b> · 差 <b className={pct > (rules?.diffPct ?? 2) ? 'red-t2' : ''}>{money(N(r.expected) - N(r.arrived), r.currency)} {r.currency}（{pct.toFixed(1)}%）</b></div>}
        <div className={`field ${need ? 'req' : ''}`}><label>{voiding ? '为什么作废' : need ? `差超过 ${rules.diffPct}%，写清楚差在哪` : '说明（可不填）'}</label><input className={`in ${need && !note.trim() ? 'err-in' : ''}`} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </Modal>);
}

// 待办 (只中方 / 财务): 回款在途太久没到账, 或到账比应到差太多还没核对
export function RemitTodo() {
  const { go } = useApp();
  const rows = useRemits(); const rules = useRemitRules();
  const bad = (rows || []).filter((r) => remitFlag(r, rules));
  if (!bad.length) return null;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#e9b4ae' }}>
      <div className="card-h"><h2>回款要看一下</h2><Pill tone="red">{bad.length} 笔</Pill><span className="small muted">到「资金账户 → 回款」处理</span></div>
      {bad.map((r) => <div key={r.id} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto', cursor: 'pointer' }} onClick={() => go('cash')}>
        <span className="age red">{remitFlag(r, rules)}</span><span className="small"><b>{r.remit_no}</b> · {r.company} → {r.to_account} · {dDate(r.on_date)} 交出</span><b>{money(r.amount_out, r.out_currency)} {r.out_currency}</b></div>)}
    </div>);
}
