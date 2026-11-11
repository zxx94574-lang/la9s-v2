// 资金账户 / 公户 (Frank 2026-10-29)
// 公户在员工名下 → 到账先挂在账户上（不动客户欠款），中方认领到客户才冲账；热线报「客户说付了」自动找对得上的到账。
// 持有人最多压 500 万、最长 7 天（每个账户自己设）；交款要中方确认收到才算；支出超过审批线要中方批。
import { useControls, CONTROL_TABS, ControlPanels, ControlAlerts, RefundModal } from './CashControls.jsx';
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, PhotoInput, DatePicker, Thumb, BigNum } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import { can, PAY_METHODS } from '../lib/domain.js';
import { money, dDate, today, friendlyError, periodRange } from '../lib/format.js';

export const EXPENSE_CATS = ['交通费（出租车 / Yango）', '话费 / 网费', '运费 / 清关', '房租', '工资 / 补贴', '餐费', '水电', '办公用品', '采购付款', '其他'];
const KIND_L = { opening: '期初', deposit: '到账', handover: '交款', expense: '支出', bank_out: '流水出账', transfer_out: '互转转出', transfer_in: '互转转入', count_adjust: '盘点调整' };
// 220: 流水分类照 Frank「基本信息」表 (中方在 选项设置 改: org_settings cash_classes)
export const CASH_CLASSES = { biz: ['备件', '回收', '商企', '配件'], flow: ['运营费用', '采购支出', '账户互转-收款', '账户互转-付款', '回款HQ', '收客户货款'],
  subject: ['办公费', '差旅费', '业务招待费', '生活费', '租赁费', '福利费', '本地物流费', '国际物流费', '人工成本', '维修费', '物料消耗', '退款', '其他'] };
const STATUS_L = { unclaimed: ['待认领', 'amber'], claimed: ['已认领', 'green'], other_income: ['其他收入', 'gray'], pending: ['待中方确认', 'amber'],
  confirmed: ['已确认', 'green'], approved: ['已批', 'green'], rejected: ['不同意', 'red'], unexplained: ['待说明', 'amber'], in_transit: ['在途', 'amber'] };
const ACC_KIND = { bank: '银行公户', cash: '现金', wave: 'Wave', orange: 'Orange', other: '其他' };

export default function Cash() {
  const { org, role, toast, refresh } = useApp();
  const [tab, setTab] = useState('open');
  const [range, setRange] = useState(() => periodRange('month'));
  const [modal, setModal] = useState(null);
  const { data } = useData(async () => {
    const [acc, open, notices, moves, customers, [cls]] = await Promise.all([q(Q.cashHoldings, [org]), q(Q.cashOpen, [org]), q(Q.paymentNotices, [org]),
      q(Q.cashMoves, [org, range[0], range[1]]), q(Q.customers, [org]), q(`select value from app.org_settings where org_id = $1 and key = 'cash_classes'`, [org])]);
    return { acc, open, notices, moves, customers, classes: { ...CASH_CLASSES, ...(cls?.value || {}) } };
  }, [org, range[0], range[1]]);
  const ctl = useControls();   // 220: 待核对到账 / 员工代收 / 对账盘点 / 月结 / 在途
  const custName = useMemo(() => Object.fromEntries((data?.customers || []).map((c) => [c.id, `${c.code || c.temp_code} ${c.name}`])), [data]);
  if (!data) return <div className="empty">加载中…</div>;
  const reg = can(role, 'cash_register'), dec = can(role, 'cash_decide'), notice = can(role, 'payment_notice');
  const openNotices = data.notices.filter((n) => n.status === 'open');
  const unclaimed = data.open.filter((m) => m.status === 'unclaimed');
  const pending = data.open.filter((m) => m.status === 'pending' || m.status === 'unexplained');
  const st = (s) => { const [l, tone] = STATUS_L[s] || [s, 'gray']; return <Pill tone={tone}>{l}</Pill>; };

  const openCols = [
    { key: 'on_date', label: '日期', w: 100, render: (m) => dDate(m.on_date) },
    { key: 'account', label: '账户', w: 130 },
    { key: 'amount', label: '金额', w: 120, value: (m) => Number(m.amount), render: (m) => <b>{money(m.amount, m.currency)}</b> },
    { key: 'payer', label: '付款人（流水上）', w: 150 },
    { key: 'ref', label: '流水号', w: 110, render: (m) => <span className="mono small">{m.source === 'statement' && m.ref?.length === 32 ? '—' : m.ref}</span> },
    { key: 'proof', label: '凭证', w: 60, render: (m) => m.proof && <Thumb src={m.proof} size={30} /> },
    { key: 'match', label: '自动配对', w: 200, value: (m) => (m.matches || []).map((x) => custName[x.customer_id]).join(' / '),
      render: (m) => (m.matches?.length ? <span className="row" style={{ gap: 4 }}>{m.matches.map((x) => <Pill key={x.notice_id} tone={x.n > 1 ? 'amber' : 'green'}>{custName[x.customer_id]}{x.gap ? ` ±${x.gap}天` : ''}</Pill>)}</span> : <span className="muted small">没有对得上的付款通知</span>) },
    { key: 'act', label: '', w: 230, render: (m) => dec && <span className="row" style={{ gap: 4 }}>
      <button type="button" className="btn sm primary" onClick={() => setModal({ t: 'claim', m })}>认领到客户</button>
      <button type="button" className="btn sm" onClick={() => setModal({ t: 'other', m })}>不是客户的钱</button></span> },
  ];
  const pendCols = [
    { key: 'on_date', label: '日期', w: 100, render: (m) => dDate(m.on_date) },
    { key: 'kind', label: '类型', w: 90, value: (m) => KIND_L[m.kind], render: (m) => KIND_L[m.kind] },
    { key: 'account', label: '账户', w: 130 },
    { key: 'amount', label: '金额', w: 120, value: (m) => Number(m.amount), render: (m) => <b>{money(m.amount, m.currency)}</b> },
    { key: 'category', label: '科目', w: 140 },
    { key: 'note', label: '说明', w: 200 },
    { key: 'proof', label: '凭证', w: 60, render: (m) => m.proof && <Thumb src={m.proof} size={30} /> },
    { key: 'status', label: '状态', w: 100, render: (m) => st(m.status) },
    { key: 'act', label: '', w: 210, render: (m) => dec && (m.status === 'unexplained'
      ? <button type="button" className="btn sm primary" onClick={() => setModal({ t: 'explain', m })}>说明这笔出账</button>
      : <span className="row" style={{ gap: 4 }}><button type="button" className="btn sm primary" onClick={() => decide(m, true)}>{m.kind === 'handover' ? '确认收到' : '同意'}</button>
        <button type="button" className="btn sm" onClick={() => setModal({ t: 'reject', m })}>不同意</button></span>) },
  ];
  const noticeCols = [
    { key: 'paid_on', label: '客户说哪天付', w: 110, render: (n) => dDate(n.paid_on) },
    { key: 'name', label: '客户', w: 180, value: (n) => `${n.code} ${n.name}`, render: (n) => <><span className="mono muted">{n.code}</span> <b>{n.name}</b></> },
    { key: 'amount', label: '金额', w: 120, value: (n) => Number(n.amount), render: (n) => money(n.amount, n.currency) },
    { key: 'method', label: '方式', w: 80, value: (n) => PAY_METHODS[n.method] || n.method, render: (n) => PAY_METHODS[n.method] || n.method },
    { key: 'proof', label: '截图', w: 60, render: (n) => n.proof && <Thumb src={n.proof} size={30} /> },
    { key: 'note', label: '说明', w: 160 },
    { key: 'status', label: '状态', w: 140, render: (n) => (n.status === 'matched' ? <Pill tone="green">已认领</Pill> : Number(n.candidates) ? <Pill tone="blue">有对得上的到账</Pill> : <Pill tone="amber">还没看到到账</Pill>) },
  ];
  const moveCols = [
    { key: 'on_date', label: '日期', w: 100, render: (m) => dDate(m.on_date) },
    { key: 'account', label: '账户', w: 130 },
    { key: 'kind', label: '类型', w: 80, value: (m) => KIND_L[m.kind], render: (m) => KIND_L[m.kind] },
    { key: 'in', label: '进', w: 110, value: (m) => (m.sign > 0 ? Number(m.amount) : 0), render: (m) => (m.sign > 0 ? money(m.amount, m.currency) : '') },
    { key: 'out', label: '出', w: 110, value: (m) => (m.sign < 0 ? Number(m.amount) : 0), render: (m) => (m.sign < 0 ? money(m.amount, m.currency) : m.sign === 0 && m.kind !== 'deposit' ? <span className="muted">{money(m.amount, m.currency)}（未生效）</span> : '') },
    { key: 'who', label: '客户 / 付款人', w: 200, value: (m) => m.customer || m.payer || '',
      render: (m) => (m.customer ? <><span className="mono muted">{m.code}</span> {m.customer} <span className="muted small">{m.rcv_no}</span></> : m.payer) },
    { key: 'note', label: '说明', w: 180, value: (m) => [m.note, m.decide_note].filter(Boolean).join(' · ') },
    { key: 'biz_type', label: '业务类别', w: 100, edit: cls('biz_type', 'biz') },
    { key: 'flow_class', label: '收支大类', w: 130, edit: cls('flow_class', 'flow') },
    { key: 'category', label: '一级科目', w: 120, edit: cls('category', 'subject') },
    { key: 'status', label: '状态', w: 100, render: (m) => st(m.status) },
    { key: 'proof', label: '凭证', w: 60, render: (m) => m.proof && <Thumb src={m.proof} size={30} /> },
  ];
  function cls(k, list) {
    return (m) => (can(role, 'receipt') || role === 'admin' ? { type: 'select', value: m[k] || '', options: [['', '—'], ...data.classes[list].map((o) => [o, o]), ...(m[k] && !data.classes[list].includes(m[k]) ? [[m[k], m[k]]] : [])],
      onChange: async (v, meta) => { const n = { biz_type: m.biz_type, flow_class: m.flow_class, category: m.category, [k]: v };
        try { await call(role, `select app.classify_move($1,$2,$3,$4)`, [m.id, n.biz_type || '', n.flow_class || '', n.category || '']); m[k] = v; if (!meta?.batch || meta.last) { toast('已保存'); refresh(); } } catch (e) { toast(friendlyError(e), 'err'); } } } : null);
  }
  const decide = async (m, ok) => {
    try { const [{ s }] = await call(role, `select app.decide_move($1,$2,null) as s`, [m.id, ok]); toast(s === 'confirmed' ? '已确认收到交款' : '已同意'); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };

  const TABS = [['open', '待认领到账', unclaimed.length], ['pending', '待中方处理', pending.length], ['notices', '付款通知', openNotices.length], ['moves', '账户流水', null], ...CONTROL_TABS(ctl)];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Comptes de trésorerie</div><h1>资金账户</h1>
        <div className="sub">到账先挂在账户上，不动客户欠款；中方认领到客户才冲账。持有人压款超上限或超天数会标红；交款要中方确认收到才算交了。</div></div>
        <div className="row" style={{ gap: 6 }}>
          {notice && <button type="button" className="btn" onClick={() => setModal({ t: 'notice' })}>客户说付了</button>}
          {reg && <><button type="button" className="btn" onClick={() => setModal({ t: 'deposit' })}>＋ 登记到账</button>
            <button type="button" className="btn" onClick={() => setModal({ t: 'expense' })}>登记支出</button>
            <button type="button" className="btn" onClick={() => setModal({ t: 'handover' })}>交款</button>
            <button type="button" className="btn" onClick={() => setModal({ t: 'import' })}>导入流水</button></>}
          {role === 'admin' && <button type="button" className="btn" onClick={() => setModal({ t: 'refund' })}>退款给客户</button>}
          {dec && <button type="button" className="btn" onClick={() => setModal({ t: 'account' })}>账户设置</button>}
        </div>
      </div>
      <div className="kpis" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(data.acc.length, 1), 4)}, minmax(0,1fr))` }}>
        {data.acc.length === 0 && <div className="card card-b muted">还没有账户。中方点「账户设置」先建公户。</div>}
        {data.acc.map((a) => {
          const held = a.oldest_held_on ? Math.floor((Date.now() - new Date(a.oldest_held_on).getTime()) / 864e5) : 0;
          return (
            <div key={a.account_id} className={`kpi ${a.over_limit || a.over_days ? 'bad' : ''}`} style={{ cursor: 'default' }}>
              <div className="t"><span>{a.name}</span><span className="small muted">{ACC_KIND[a.kind]}</span></div>
              <BigNum size={26}>{money(a.balance, a.currency)}</BigNum>
              <div className="small muted">{a.holder ? `在 ${a.holder} 手上` : '—'}{a.hold_limit ? ` · 上限 ${money(a.hold_limit, a.currency)}` : ''}{a.hold_days ? ` · 最长 ${a.hold_days} 天` : ''}</div>
              <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                {a.over_limit && <Pill tone="red">超上限 {money(a.balance - a.hold_limit, a.currency)}，要马上交</Pill>}
                {a.over_days && <Pill tone="red">最早一笔压了 {held} 天</Pill>}
                {!a.over_days && Number(a.balance) > 0 && a.oldest_held_on && <Pill tone="gray">最早一笔 {held} 天</Pill>}
                {Number(a.unclaimed_n) > 0 && <Pill tone="amber">{a.unclaimed_n} 笔待认领 {money(a.unclaimed_amount, a.currency)}</Pill>}
                {Number(a.handover_pending) > 0 && <Pill tone="blue">交款待确认 {money(a.handover_pending, a.currency)}</Pill>}
              </div>
            </div>);
        })}
      </div>
      <ControlAlerts ctl={ctl} onGo={setTab} />
      <div className="card">
        <div className="tabs">{TABS.map(([k, l, n]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{n ? <span className="queue-n"> {n}</span> : null}</button>)}</div>
        {tab === 'open' && <Grid id="cash-open" table="cash_moves" columns={openCols} rows={unclaimed} empty="没有待认领的到账" />}
        {tab === 'pending' && <Grid id="cash-pending" table="cash_moves" columns={pendCols} rows={pending} empty="没有要中方处理的交款 / 支出" />}
        {tab === 'notices' && <Grid id="cash-notices" table="payment_notices" columns={noticeCols} rows={data.notices} empty="没有付款通知" />}
        {tab === 'moves' && <Grid id="cash-moves" table="cash_moves" columns={moveCols} rows={data.moves} tools={<DatePicker range value={range} onChange={setRange} />} empty="这段时间没有流水" />}
        <ControlPanels tab={tab} ctl={ctl} acc={data.acc} classes={data.classes} />
      </div>
      {modal?.t === 'claim' && <ClaimModal m={modal.m} customers={data.customers} notices={openNotices} onClose={() => setModal(null)} />}
      {modal?.t === 'other' && <NoteModal title="不是客户的钱" label="是什么钱（例：内部转入 / 退款）" sql="select app.mark_other_income($1,$2)" id={modal.m.id} onClose={() => setModal(null)} />}
      {modal?.t === 'reject' && <NoteModal title="不同意" label="原因" sql="select app.decide_move($1,false,$2)" id={modal.m.id} onClose={() => setModal(null)} />}
      {modal?.t === 'explain' && <ExplainModal m={modal.m} onClose={() => setModal(null)} />}
      {['deposit', 'expense', 'handover'].includes(modal?.t) && <MoveModal t={modal.t} acc={data.acc} onClose={() => setModal(null)} />}
      {modal?.t === 'notice' && <NoticeModal customers={data.customers} onClose={() => setModal(null)} />}
      {modal?.t === 'import' && <ImportModal acc={data.acc} onClose={() => setModal(null)} />}
      {modal?.t === 'refund' && <RefundModal acc={data.acc} customers={data.customers} onClose={() => setModal(null)} />}
      {modal?.t === 'account' && <AccountModal acc={data.acc} onClose={() => setModal(null)} />}
    </>
  );
}

function ClaimModal({ m, customers, notices, onClose }) {
  const { role, toast, refresh } = useApp();
  const first = (m.matches || []).length === 1 ? m.matches[0] : null;
  const [cust, setCust] = useState(first?.customer_id || '');
  const [mode, setMode] = useState('oldest');
  const notice = notices.find((n) => n.customer_id === cust && Number(n.amount) === Number(m.amount));
  const go = async () => {
    try { await call(role, `select app.claim_deposit($1,$2,$3,'[]',$4)`, [m.id, cust, mode, notice?.id || null]); toast('已认领，收款和冲账已生成'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`认领到账 · ${money(m.amount, m.currency)} · ${dDate(m.on_date)}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!cust} onClick={go}>认领</button></>}>
      <div className="stack">
        <div className="hint">流水上的付款人：<b>{m.payer || '—'}</b>{m.ref ? ` · ${m.ref}` : ''}{first ? '。已按付款通知自动选好客户，核对一下。' : ''}</div>
        <div className="field req"><label>是哪个客户的钱</label><CustomerSelect customers={customers} value={cust} onChange={setCust} /></div>
        {notice && <div className="small"><Pill tone="green">对上付款通知</Pill> 客户 {dDate(notice.paid_on)} 报的 {money(notice.amount, notice.currency)}，认领后通知一起关掉。</div>}
        <div className="field"><label>冲账</label><div className="seg">{[['oldest', '冲最老的单'], ['none', '先挂预付，不冲']].map(([v, l]) =>
          <button type="button" key={v} className={mode === v ? 'on' : ''} onClick={() => setMode(v)}>{l}</button>)}</div>
          <div className="hint">要指定冲某几单：先挂预付，再去「收款与冲账」里分配。</div></div>
      </div>
    </Modal>
  );
}

function NoteModal({ title, label, sql, id, onClose }) {
  const { role, toast, refresh } = useApp();
  const [v, setV] = useState('');
  const go = async () => { try { await call(role, sql, [id, v]); toast('已保存'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!v.trim()} onClick={go}>确定</button></>}>
      <div className="field req"><label>{label}</label><input className="in" autoFocus value={v} onChange={(e) => setV(e.target.value)} /></div>
    </Modal>
  );
}

function ExplainModal({ m, onClose }) {
  const { role, toast, refresh } = useApp();
  const [as, setAs] = useState('expense');
  const [cat, setCat] = useState('');
  const [note, setNote] = useState(m.note || '');
  const go = async () => { if (as === 'expense' && cat === '其他' && !note.trim()) return toast('科目选了「其他」，说明里写清楚是什么', 'err'); try { await call(role, `select app.explain_bank_out($1,$2,$3,$4)`, [m.id, as, cat || null, note]); toast('已说明'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`流水出账 · ${money(m.amount, m.currency)} · ${dDate(m.on_date)}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={as === 'expense' && !cat} onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="seg">{[['expense', '是支出'], ['handover', '是交给公司的钱']].map(([v, l]) => <button type="button" key={v} className={as === v ? 'on' : ''} onClick={() => setAs(v)}>{l}</button>)}</div>
        {as === 'expense' && <div className="field req"><label>科目</label><div className="chips">{EXPENSE_CATS.map((c) => <button type="button" key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}</div></div>}
        <div className={`field ${as === 'expense' && cat === '其他' ? 'req' : ''}`}><label>说明{as === 'expense' && cat === '其他' ? '（选了「其他」必填）' : ''}</label><input className={`in ${as === 'expense' && cat === '其他' && !note.trim() ? 'invalid' : ''}`} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function MoveModal({ t, acc, onClose }) {
  const { role, toast, refresh } = useApp();
  const [f, setF] = useState({ account: acc[0]?.account_id || '', date: today(), amount: '', payer: '', ref: '', cat: '', proof: '', note: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const a = acc.find((x) => x.account_id === f.account);
  const title = { deposit: '登记到账', expense: '登记支出', handover: '交款给公司' }[t];
  const ok = f.account && Number(f.amount) > 0 && (t !== 'expense' || f.cat) && (t !== 'handover' || f.proof);
  const go = async () => {
    if (t === 'expense' && f.cat === '其他' && !f.note.trim()) return toast('科目选了「其他」，说明里写清楚是什么', 'err');
    try {
      if (t === 'deposit') { await call(role, `select app.record_deposit($1,$2,$3,$4,$5,$6,$7)`, [f.account, f.date, Number(f.amount), f.payer, f.ref, f.proof || null, f.note || null]); toast('已登记到账，等中方认领'); }
      if (t === 'expense') { const [{ s }] = await call(role, `select app.record_expense($1,$2,$3,$4,$5,$6) as s`, [f.account, Number(f.amount), f.date, f.cat, f.proof || null, f.note]); toast(s === 'approved' ? '支出已记账' : '支出已提交，等中方批'); }
      if (t === 'handover') { await call(role, `select app.request_handover($1,$2,$3,$4,$5)`, [f.account, Number(f.amount), f.date, f.proof, f.note || null]); toast('交款已提交，中方确认收到后才从账户里减掉'); }
      refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!ok} onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="field req"><label>账户</label><div className="chips">{acc.map((x) => <button type="button" key={x.account_id} className={`chip ${f.account === x.account_id ? 'on' : ''}`} onClick={() => set('account')(x.account_id)}>{x.name}</button>)}</div></div>
        <div className="grid2">
          <div className="field req"><label>日期</label><DatePicker value={f.date} onChange={set('date')} /></div>
          <div className="field req"><label>金额 {a?.currency}</label><input className="in" inputMode="numeric" value={f.amount} onChange={(e) => set('amount')(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          {t === 'deposit' && <><div className="field"><label>付款人（流水上的名字）</label><input className="in" value={f.payer} onChange={set('payer')} /></div>
            <div className="field"><label>流水号</label><input className="in" value={f.ref} onChange={set('ref')} /></div></>}
        </div>
        {t === 'expense' && <div className="field req"><label>科目</label><div className="chips">{EXPENSE_CATS.map((c) => <button type="button" key={c} className={`chip ${f.cat === c ? 'on' : ''}`} onClick={() => set('cat')(c)}>{c}</button>)}</div></div>}
        <div className={`field ${t === 'handover' ? 'req' : ''}`}><label>{t === 'handover' ? '交款凭证（转账截图 / 收条）' : '凭证'}</label><PhotoInput value={f.proof} onChange={set('proof')} /></div>
        <div className={`field ${t === 'expense' && f.cat === '其他' ? 'req' : ''}`}><label>说明{t === 'expense' && f.cat === '其他' ? '（选了「其他」必填）' : ''}</label><input className={`in ${t === 'expense' && f.cat === '其他' && !f.note.trim() ? 'invalid' : ''}`} value={f.note} onChange={set('note')} /></div>
        {t === 'expense' && <div className="hint">{Number(a?.approval_over) > 0 ? `超过 ${money(a.approval_over)} 要中方批，以下直接记账。` : '目前所有支出都要中方批（审批线待中方定）。'}</div>}
      </div>
    </Modal>
  );
}

function NoticeModal({ customers, onClose }) {
  const { role, toast, refresh } = useApp();
  const [f, setF] = useState({ cust: '', amount: '', currency: 'XOF', method: 'bank', date: today(), proof: '', note: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const go = async () => {
    try { await call(role, `select app.record_payment_notice($1,$2,$3,$4,$5,$6,$7)`, [f.cust, Number(f.amount), f.currency, f.method, f.date, f.proof, f.note || null]);
      toast('已挂上，到账来了会自动配对'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="客户说已经付了" onClose={onClose}
      footer={<><span className="small muted">只是挂个通知，不动欠款；钱到账、中方认领后才冲账</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!f.cust || !(Number(f.amount) > 0) || !f.proof} onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="field req"><label>客户</label><CustomerSelect customers={customers} value={f.cust} onChange={set('cust')} /></div>
        <div className="grid2">
          <div className="field req"><label>金额</label><div className="row" style={{ gap: 6 }}><input className="in" inputMode="numeric" value={f.amount} onChange={(e) => set('amount')(e.target.value.replace(/[^\d.]/g, ''))} />
            <div className="seg">{['XOF', 'CNY', 'USD'].map((c) => <button type="button" key={c} className={f.currency === c ? 'on' : ''} onClick={() => set('currency')(c)}>{c}</button>)}</div></div></div>
          <div className="field req"><label>客户说哪天付的</label><DatePicker value={f.date} onChange={set('date')} /></div>
        </div>
        <div className="field"><label>方式</label><div className="seg">{Object.entries(PAY_METHODS).map(([k, l]) => <button type="button" key={k} className={f.method === k ? 'on' : ''} onClick={() => set('method')(k)}>{l}</button>)}</div></div>
        <div className="field req"><label>付款截图</label><PhotoInput value={f.proof} onChange={set('proof')} invalid={!f.proof} /></div>
        <div className="field"><label>说明</label><input className="in" value={f.note} onChange={set('note')} /></div>
      </div>
    </Modal>
  );
}

// 从 Excel / 银行网页复制几列粘进来: 日期  金额(进正出负, 或 进 / 出 两列)  流水号  付款人  摘要
export function parseStatement(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split('\t').map((x) => x.trim());
    if (c.length < 2) continue;
    const m = c[0].match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/) || c[0].match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!m) continue;
    const date = m[1].length === 4 ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const n = (s) => { const v = Number(String(s || '').replace(/[\s,  ]/g, '')); return Number.isFinite(v) ? v : 0; };
    rows.push({ date, amount: n(c[1]), ref: c[2] || '', payer: c[3] || '', desc: c[4] || '' });
  }
  return rows;
}

function ImportModal({ acc, onClose }) {
  const { role, toast, refresh } = useApp();
  const [account, setAccount] = useState(acc.find((a) => a.kind === 'bank')?.account_id || acc[0]?.account_id || '');
  const [text, setText] = useState('');
  const rows = parseStatement(text);
  const go = async () => {
    try { const [{ r }] = await call(role, `select app.import_statement($1,$2) as r`, [account, JSON.stringify(rows)]);
      const n = Number((await call(role, `select app.auto_verify_receipts($1) as n`, [account]))[0].n);   // 220: 流水和登记的收款自动配对 → 确认到账
      toast(`导入完成：进账 ${r.in} 笔，其中 ${n} 笔和已登记的收款对上、自动确认到账；出账 ${r.out} 笔（待说明），重复跳过 ${r.dup} 笔`); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title="导入银行流水" onClose={onClose}
      footer={<><span className="small muted">识别到 {rows.length} 行；同一笔重复导入会自动跳过</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!account || !rows.length} onClick={go}>导入</button></>}>
      <div className="stack">
        <div className="field req"><label>账户</label><div className="chips">{acc.map((x) => <button type="button" key={x.account_id} className={`chip ${account === x.account_id ? 'on' : ''}`} onClick={() => setAccount(x.account_id)}>{x.name}</button>)}</div></div>
        <div className="hint">从 Excel 复制这几列粘进来（顺序固定）：日期 ｜ 金额（进账正数，出账负数）｜ 流水号 ｜ 付款人 ｜ 摘要</div>
        <textarea className="in mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'2026-10-20\t250000\tFT2610201\tKONE ADAMA\tVIREMENT\n2026-10-21\t-200000\tFT2610215\t\tRETRAIT'} />
        {rows.length > 0 && <div className="small">进账 {rows.filter((r) => r.amount > 0).length} 笔 {money(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0))}；出账 {rows.filter((r) => r.amount < 0).length} 笔 {money(-rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0))}</div>}
      </div>
    </Modal>
  );
}

function AccountModal({ acc, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const { data: emps } = useData(() => q(Q.employees, [org]), [org]);
  const [sel, setSel] = useState(acc[0]?.account_id || 'new');
  const cur = acc.find((a) => a.account_id === sel);
  const [f, setF] = useState(() => init(cur));
  const [over, setOver] = useState(String(Number(acc[0]?.approval_over || 0)));
  function init(a) { return { name: a?.name || '', kind: a?.kind || 'bank', currency: a?.currency || 'XOF', holder: a?.holder_employee_id || '', limit: a?.hold_limit != null ? String(Number(a.hold_limit)) : '5000000', days: a?.hold_days != null ? String(a.hold_days) : '7' }; }
  const pick = (id) => { setSel(id); setF(init(acc.find((a) => a.account_id === id))); };
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const go = async () => {
    try {
      await call(role, `select app.upsert_cash_account($1,$2,$3,$4,$5,$6,$7,$8)`, [org, cur ? sel : null, f.name, f.kind, f.currency, f.holder || null, f.limit === '' ? null : Number(f.limit), f.days === '' ? null : Number(f.days)]);
      await call(role, `select app.set_cash_settings($1,$2,3)`, [org, Number(over || 0)]);
      toast('已保存'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="账户设置（只中方）" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!f.name.trim()} onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="chips">{acc.map((a) => <button type="button" key={a.account_id} className={`chip ${sel === a.account_id ? 'on' : ''}`} onClick={() => pick(a.account_id)}>{a.name}</button>)}
          <button type="button" className={`chip ${sel === 'new' ? 'on' : ''}`} onClick={() => pick('new')}>＋ 新账户</button></div>
        <div className="grid2">
          <div className="field req"><label>账户名</label><input className="in" value={f.name} onChange={set('name')} placeholder="公户 · 员工名" /></div>
          <div className="field"><label>类型</label><div className="seg">{Object.entries(ACC_KIND).map(([k, l]) => <button type="button" key={k} className={f.kind === k ? 'on' : ''} onClick={() => set('kind')(k)}>{l}</button>)}</div></div>
          <div className="field"><label>币种</label><select className="in" style={{ width: 90 }} disabled={!!cur} value={f.currency} onChange={(e) => set('currency')(e.target.value)}>{['XOF', 'CNY', 'USD'].map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>在谁手上 / 谁名下</label><select className="in" value={f.holder} onChange={set('holder')}><option value="">—</option>{(emps || []).map((e) => <option key={e.id} value={e.id}>{e.short_name}</option>)}</select></div>
          <div className="field"><label>最多压多少（超了要马上交）</label><input className="in" inputMode="numeric" value={f.limit} onChange={(e) => set('limit')(e.target.value.replace(/\D/g, ''))} placeholder="不限" /></div>
          <div className="field"><label>最长压几天</label><input className="in" inputMode="numeric" value={f.days} onChange={(e) => set('days')(e.target.value.replace(/\D/g, ''))} placeholder="不限" /></div>
        </div>
        <div className="field"><label>支出审批线（超过这个数要中方批；0 = 全部要批）</label><input className="in" inputMode="numeric" value={over} onChange={(e) => setOver(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 200 }} /></div>
      </div>
    </Modal>
  );
}
