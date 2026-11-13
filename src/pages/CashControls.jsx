// 资金账户 · 财务管控 (Frank 11-11 217–220): 待核对到账 / 员工代收 / 对账与盘点 / 账户互转在途 / 月结锁账 + 提醒
// 分工制衡做成三步 (登记 → 确认到账 → 对账), 现在中方一个人也能走完; 以后招了财务在权限配置里分出去.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, PhotoInput, DatePicker, FRow, Info, Thumb } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { CustLink } from '../components/Archives.jsx';
import { RcvStatus, verifyRcvAction } from '../components/ReceiptForm.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import { can } from '../lib/domain.js';
import { money, dDate, dt, today, friendlyError, ymd } from '../lib/format.js';

const N = (v) => Number(v || 0);
export const CASH_RULES_DEFAULT = { count_every_days: 7, close_by_day: 5, recon_every_days: 1 };
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return ymd(d).slice(0, 7) + '-01'; };

export function useControls() {
  const { org, role, tick } = useApp();
  const fin = can(role, 'receipt') || role === 'admin';
  const { data } = useData(async () => {
    if (!fin) return null;
    const run = (sql, args) => call(role, sql, args).catch(() => []);
    const [pendingRcv, held, checks, transit, locks, [rules], issues] = await Promise.all([
      run(`select r.id, r.rcv_no, r.received_on, r.amount, r.landed, r.currency, r.account_currency, r.method, r.fee, r.fee_bearer, r.payer, r.verify_status, r.collector_employee_id, r.handed_at, r.voided_at,
             r.proof_path, c.id as customer_id, c.name as customer_name, a.name as account_name, current_date - r.received_on as days
           from app.receipts r join app.customers c on c.id = r.customer_id left join app.cash_accounts a on a.id = r.account_id
           where r.org_id = $1 and r.voided_at is null and r.verify_status = 'pending' and r.collector_employee_id is null order by r.received_on`, [org]),
      run(`select * from app.v_staff_held where org_id = $1 order by received_on`, [org]),
      run(`select a.id as account_id, a.name, a.kind, a.currency, app.account_balance(a.id) as balance,
             (select row_to_json(x) from (select c.on_date, c.kind, c.diff, c.actual_balance, c.note from app.cash_checks c where c.account_id = a.id and c.kind = 'recon' order by c.on_date desc, c.created_at desc limit 1) x) as last_recon,
             (select row_to_json(x) from (select c.on_date, c.kind, c.diff, c.actual_balance, c.note from app.cash_checks c where c.account_id = a.id and c.kind = 'count' order by c.on_date desc, c.created_at desc limit 1) x) as last_count
           from app.cash_accounts a where a.org_id = $1 and a.active order by a.name`, [org]),
      run(`select m.id, m.amount, m.on_date, m.note, a.name as account, a.currency, current_date - m.on_date as days from app.cash_moves m join app.cash_accounts a on a.id = m.account_id
           where m.org_id = $1 and m.kind = 'transfer_in' and m.status = 'in_transit' order by m.on_date`, [org]),
      run(`select month::text as month, locked_at from app.period_locks where org_id = $1 order by month desc`, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'cash_rules'`, [org]).catch(() => []),
      run(`select * from app.month_close_issues($1, $2::date)`, [org, prevMonth()]),
    ]);
    return { pendingRcv, held, checks, transit, locks, issues, rules: { ...CASH_RULES_DEFAULT, ...(rules?.value || {}) } };
  }, [org, role, tick]);
  if (!data) return null;
  // 提醒: 红 = 肯定有问题 (超期), 黄 = 要处理
  const alerts = [];
  const r = data.rules;
  const lastMonth = prevMonth();
  const dayOfMonth = new Date().getDate();
  if (!data.locks.some((l) => l.month === lastMonth) && dayOfMonth > r.close_by_day) alerts.push({ tone: 'red', tab: 'close', msg: `${lastMonth.slice(0, 7)} 还没锁账（规则：每月 ${r.close_by_day} 号前锁上个月）` });
  else if (!data.locks.some((l) => l.month === lastMonth)) alerts.push({ tone: 'amber', tab: 'close', msg: `${lastMonth.slice(0, 7)} 还没锁账，${r.close_by_day} 号前锁` });
  for (const a of data.checks) {
    const lr = a.last_recon?.on_date; const lc = a.last_count?.on_date;
    const daysR = lr ? Math.floor((Date.now() - new Date(lr).getTime()) / 864e5) : Infinity;
    if (daysR > r.recon_every_days) alerts.push({ tone: 'amber', tab: 'checks', msg: `${a.name} ${lr ? `${daysR} 天没对账` : '还没对过账'}` });
    if (a.kind === 'cash') { const dc = lc ? Math.floor((Date.now() - new Date(lc).getTime()) / 864e5) : Infinity; if (dc > r.count_every_days) alerts.push({ tone: dc > r.count_every_days * 2 ? 'red' : 'amber', tab: 'checks', msg: `${a.name} ${lc ? `${dc} 天没盘点` : '还没盘点过'}（规则：每 ${r.count_every_days} 天）` }); }
  }
  if (data.pendingRcv.length) alerts.push({ tone: data.pendingRcv.some((x) => x.days > 3) ? 'red' : 'amber', tab: 'verify', msg: `${data.pendingRcv.length} 笔收款还没确认到账${data.pendingRcv.some((x) => x.days > 3) ? '（有超过 3 天的）' : ''}` });
  if (data.held.length) alerts.push({ tone: data.held.some((x) => x.days > 3) ? 'red' : 'amber', tab: 'staff', msg: `员工代收 ${data.held.length} 笔没交到公司，共 ${money(data.held.reduce((s, x) => s + N(x.landed || x.amount), 0))}` });
  if (data.transit.length) alerts.push({ tone: 'amber', tab: 'transit', msg: `${data.transit.length} 笔账户互转还在途` });
  return { ...data, alerts };
}

export const CONTROL_TABS = (ctl) => (!ctl ? [] : [
  ['verify', '待核对到账', ctl.pendingRcv.length], ['staff', '员工代收', ctl.held.length], ['checks', '对账与盘点', null], ['transit', '账户互转', ctl.transit.length], ['close', '月结锁账', null],
]);

export function ControlAlerts({ ctl, onGo }) {
  if (!ctl || !ctl.alerts.length) return null;
  return (
    <div className="card card-b" style={{ marginBottom: 12 }}>
      <div className="pd-h">财务提醒 <Info>按「资金账户 → 月结锁账 → 规则」里的设置提醒：多久对一次账、多久盘一次现金、每月几号前锁上个月。</Info></div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {ctl.alerts.map((a, i) => <button type="button" key={i} className={`pill ${a.tone}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => onGo(a.tab)}>{a.tone === 'red' ? '✕ ' : '⚠ '}{a.msg} →</button>)}
      </div>
    </div>
  );
}

export function ControlPanels({ tab, ctl, acc, classes }) {
  if (!ctl) return null;
  if (tab === 'verify') return <VerifyPanel ctl={ctl} />;
  if (tab === 'staff') return <StaffHeld ctl={ctl} acc={acc} />;
  if (tab === 'checks') return <ChecksPanel ctl={ctl} />;
  if (tab === 'transit') return <TransitPanel ctl={ctl} acc={acc} />;
  if (tab === 'close') return <ClosePanel ctl={ctl} classes={classes} />;
  return null;
}

function VerifyPanel({ ctl }) {
  const { refresh, role, toast } = useApp();
  return (
    <div className="card-b stack">
      <div className="hint">登记了、还没核对的收款：去 Wave / 银行 / 现金核对，钱确实到了就点「确认到账」；导入流水时金额对上的会自动确认。登记的人不能自己确认（中方除外）。</div>
      <Grid id="cash-verify" rows={ctl.pendingRcv} rowActions={can(role, 'receipt') ? [verifyRcvAction(role, toast, refresh)] : undefined} empty="没有待核对的收款 ✓" columns={[
        { key: 'rcv_no', label: '收款单号', w: 140, render: (r) => <b className="mono">{r.rcv_no}</b> },
        { key: 'received_on', label: '日期', w: 100, render: (r) => dDate(r.received_on) },
        { key: 'days', label: '几天了', w: 70, render: (r) => <span className={r.days > 3 ? 'red-t2' : ''}>{r.days} 天</span> },
        { key: 'customer_name', label: '客户', w: 150, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
        { key: 'landed', label: '到账金额', w: 120, render: (r) => <b>{money(r.landed ?? r.amount, r.currency)} {r.currency}</b> },
        { key: 'proof_path', label: '凭证', w: 80, sortable: false, filterable: false, render: (r) => (r.proof_path ? <Thumb src={r.proof_path} size={34} label={`${r.rcv_no} 收款凭证`} /> : <span className="pill red">缺凭证</span>) },
        { key: 'account_name', label: '账户', w: 110, render: (r) => r.account_name || <span className="pill amber">没选账户</span> },
        { key: 'state', label: '状态', w: 260, sortable: false, render: (r) => <RcvStatus r={r} onDone={refresh} /> },
      ]} />
    </div>
  );
}

function StaffHeld({ ctl, acc }) {
  const [hand, setHand] = useState(null);
  const byEmp = Object.values(ctl.held.reduce((m, x) => { const k = x.employee_name || '—'; (m[k] ||= { name: k, total: 0, n: 0, max: 0 }); m[k].total += N(x.landed || x.amount); m[k].n += 1; m[k].max = Math.max(m[k].max, x.days); return m; }, {}));
  return (
    <div className="card-b stack">
      <div className="hint">客户把现金给了员工：客户账已经冲掉，钱算员工欠公司。员工存进 Wave 转给公司（或当面交现金）后点「已交」，钱才进公司账户。</div>
      {byEmp.length > 0 && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{byEmp.map((e) => <span key={e.name} className={`pill ${e.max > 3 ? 'red' : 'amber'}`}>{e.name}：{e.n} 笔 · 共 {money(e.total)} · 最久 {e.max} 天</span>)}</div>}
      <Grid id="cash-held" rows={ctl.held} rowKey={(r) => r.receipt_id} rowActions={[{ label: '这笔已交给公司', run: (r) => setHand(r) }]} empty="没有员工代收没交的 ✓" columns={[
        { key: 'employee_name', label: '员工', w: 100 },
        { key: 'rcv_no', label: '收款单号', w: 140, render: (r) => <b className="mono">{r.rcv_no}</b> },
        { key: 'received_on', label: '收到日期', w: 100, render: (r) => dDate(r.received_on) },
        { key: 'days', label: '压了几天', w: 80, render: (r) => <span className={r.days > 3 ? 'red-t2' : ''}>{r.days} 天</span> },
        { key: 'customer_name', label: '客户', w: 150, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
        { key: 'landed', label: '金额', w: 120, render: (r) => <b>{money(r.landed ?? r.amount, r.currency)} {r.currency}</b> },
      ]} />
      {hand && <HandModal r={hand} acc={acc} onClose={() => setHand(null)} />}
    </div>
  );
}
function HandModal({ r, acc, onClose }) {
  const { role, toast, refresh } = useApp();
  const opts = acc.filter((a) => a.currency === r.currency);
  const [account, setAccount] = useState(opts.find((a) => a.kind === 'wave')?.account_id || opts[0]?.account_id || '');
  const [proof, setProof] = useState('');
  const go = async () => { try { await call(role, `select app.receipt_handed($1,$2,$3)`, [r.receipt_id, account, proof || null]); toast(`${r.employee_name} 已交 ${money(r.landed ?? r.amount)}，已进 ${opts.find((a) => a.account_id === account)?.name}`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`员工交款 · ${r.rcv_no}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!account || !proof} onClick={go}>确认收到</button></>}>
      <div className="stack">
        <FRow label="进哪个账户" req><select className="in" value={account} onChange={(e) => setAccount(e.target.value)}>{opts.map((a) => <option key={a.account_id} value={a.account_id}>{a.name}</option>)}</select></FRow>
        <FRow label="凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="Wave 转账截图 / 当面交现金照片" /></div></FRow>
      </div>
    </Modal>
  );
}

function ChecksPanel({ ctl }) {
  const [rec, setRec] = useState(null);
  const { org, role } = useApp();
  const { data: hist } = useData(() => call(role, `select c.*, a.name as account from app.cash_checks c join app.cash_accounts a on a.id = c.account_id where c.org_id = $1 order by c.on_date desc, c.created_at desc limit 60`, [org]).catch(() => []), [org, role, ctl]);
  return (
    <div className="card-b stack">
      <div className="hint">每个账户把系统余额和实际余额（Wave / 银行 App 里的余额、现金实点）对一遍，差额写原因；现金盘点要拍照。记录永久保留。</div>
      <Grid id="cash-checks" rows={ctl.checks} rowKey={(a) => a.account_id} rowActions={[{ label: '记对账', run: (a) => setRec({ a, kind: 'recon' }) }, { label: '记盘点', tone: '', when: (a) => a.kind === 'cash', run: (a) => setRec({ a, kind: 'count' }) }]} columns={[
        { key: 'name', label: '账户', w: 130, render: (a) => <b>{a.name}</b> },
        { key: 'balance', label: '系统余额', w: 130, render: (a) => money(a.balance, a.currency) },
        { key: 'last_recon', label: '上次对账', w: 200, sortable: false, render: (a) => (a.last_recon ? <>{dDate(a.last_recon.on_date)} {N(a.last_recon.diff) === 0 ? <span className="pill green">对上</span> : <span className="pill amber">差 {money(a.last_recon.diff)}</span>}</> : <span className="pill amber">还没对过</span>) },
        { key: 'last_count', label: '上次盘点', w: 200, sortable: false, render: (a) => (a.kind !== 'cash' ? <span className="muted small">不是现金账户</span> : a.last_count ? <>{dDate(a.last_count.on_date)} {N(a.last_count.diff) === 0 ? <span className="pill green">对上</span> : <span className="pill amber">差 {money(a.last_count.diff)}</span>}</> : <span className="pill amber">还没盘过</span>) },
      ]} />
      <div className="pd-h">历史记录</div>
      <Grid id="cash-check-hist" rows={hist || []} empty="还没有记录" columns={[
        { key: 'on_date', label: '日期', w: 100, render: (c) => dDate(c.on_date) },
        { key: 'account', label: '账户', w: 120 },
        { key: 'kind', label: '类型', w: 80, render: (c) => (c.kind === 'count' ? '盘点' : '对账') },
        { key: 'system_balance', label: '系统', w: 120, render: (c) => money(c.system_balance) },
        { key: 'actual_balance', label: '实际', w: 120, render: (c) => money(c.actual_balance) },
        { key: 'diff', label: '差额', w: 110, render: (c) => (N(c.diff) === 0 ? <span className="pill green">0</span> : <span className="pill red">{money(c.diff)}</span>) },
        { key: 'note', label: '原因', w: 220 },
      ]} />
      {rec && <CheckModal {...rec} onClose={() => setRec(null)} />}
    </div>
  );
}
function CheckModal({ a, kind, onClose }) {
  const { role, toast, refresh } = useApp();
  const [on, setOn] = useState(today());
  const [actual, setActual] = useState('');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState('');
  const diff = actual === '' ? null : N(actual) - N(a.balance);
  const ok = actual !== '' && (diff === 0 || note.trim()) && proof;
  const go = async () => { try { await call(role, `select app.record_cash_check($1,$2,$3,$4,$5,$6)`, [a.account_id, kind, on, N(actual), note || null, proof || null]); toast(diff === 0 ? '对上了 ✓' : `已记下，差 ${money(diff)}`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`${kind === 'count' ? '现金盘点' : '对账'} · ${a.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && actual !== '' && <span className="why">{diff !== 0 && !note.trim() ? '有差额，写原因' : kind === 'count' ? '盘点要拍照' : '截 App / 银行余额图'}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>记下</button></>}>
      <div className="stack">
        <FRow label="日期" req><DatePicker value={on} onChange={setOn} /></FRow>
        <FRow label="系统余额"><b>{money(a.balance, a.currency)} {a.currency}</b><Info>系统按流水算到今天的余额；日期选更早的，保存时按那天算。</Info></FRow>
        <FRow label={kind === 'count' ? '实点金额' : '实际余额'} req><input className="in" inputMode="decimal" style={{ width: 160 }} value={actual} onChange={(e) => setActual(e.target.value.replace(/[^\d.-]/g, ''))} placeholder={kind === 'count' ? '数出来多少' : 'App 里显示多少'} />
          {diff != null && (diff === 0 ? <span className="pill green">对上 ✓</span> : <span className="pill red">差 {money(diff)}</span>)}</FRow>
        <FRow label="原因" req={diff != null && diff !== 0}><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="有差额必须写" /></FRow>
        <FRow label={kind === 'count' ? '照片' : '余额截图'} req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label={kind === 'count' ? '现金照片' : 'App / 银行里的余额截图'} camera={kind === 'count'} /></div></FRow>
      </div>
    </Modal>
  );
}

function TransitPanel({ ctl, acc }) {
  const { role, toast, refresh } = useApp();
  const [nw, setNw] = useState(false);
  const arrived = async (m) => { try { await call(role, `select app.transfer_arrived($1)`, [m.id]); toast('已到账，在途清掉'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="card-b stack">
      <div className="row between"><div className="hint">账户之间转钱：转出那边马上减，转入这边「到了」才加；中间这段叫在途。</div><button type="button" className="btn" onClick={() => setNw(true)}>＋ 账户互转</button></div>
      <Grid id="cash-transit" rows={ctl.transit} rowActions={[{ label: '这笔钱到了', run: (m) => arrived(m) }]} empty="没有在途的转账 ✓" columns={[
        { key: 'on_date', label: '转出日期', w: 100, render: (m) => dDate(m.on_date) },
        { key: 'days', label: '几天了', w: 70, render: (m) => <span className={m.days > 2 ? 'red-t2' : ''}>{m.days} 天</span> },
        { key: 'account', label: '转入账户', w: 130 },
        { key: 'amount', label: '金额', w: 120, render: (m) => <b>{money(m.amount, m.currency)}</b> },
        { key: 'note', label: '说明', w: 220 },
      ]} />
      {nw && <TransferModal acc={acc} onClose={() => setNw(false)} />}
    </div>
  );
}
function TransferModal({ acc, onClose }) {
  const { role, toast, refresh } = useApp();
  const [from, setFrom] = useState(acc[0]?.account_id || '');
  const [to, setTo] = useState(acc[1]?.account_id || '');
  const [amt, setAmt] = useState(''); const [amtIn, setAmtIn] = useState(''); const [on, setOn] = useState(today()); const [note, setNote] = useState('');
  const A = acc.find((a) => a.account_id === from), B = acc.find((a) => a.account_id === to);
  const cross = A && B && A.currency !== B.currency;
  const go = async () => { try { await call(role, `select app.transfer_between($1,$2,$3,$4,$5,$6)`, [from, to, N(amt), on, note || null, cross ? N(amtIn) : null]); toast('已记转出，转入那边先算在途'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="账户互转" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!from || !to || from === to || !(N(amt) > 0) || (cross && !(N(amtIn) > 0))} onClick={go}>记下</button></>}>
      <div className="stack">
        <FRow label="从" req><select className="in" value={from} onChange={(e) => setFrom(e.target.value)}>{acc.map((a) => <option key={a.account_id} value={a.account_id}>{a.name}</option>)}</select></FRow>
        <FRow label="转到" req><select className="in" value={to} onChange={(e) => setTo(e.target.value)}>{acc.map((a) => <option key={a.account_id} value={a.account_id}>{a.name}</option>)}</select></FRow>
        <FRow label="金额" req><input className="in" inputMode="decimal" style={{ width: 150 }} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">{A?.currency}</span></FRow>
        {cross && <FRow label="到账金额" req><input className="in" inputMode="decimal" style={{ width: 150 }} value={amtIn} onChange={(e) => setAmtIn(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">{B?.currency}（两边币种不同）</span></FRow>}
        <FRow label="日期" req><DatePicker value={on} onChange={setOn} /></FRow>
        <FRow label="说明"><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 现金存进 Wave" /></FRow>
      </div>
    </Modal>
  );
}

function ClosePanel({ ctl, classes }) {
  const { org, role, toast, refresh } = useApp();
  const admin = role === 'admin';
  const [unlock, setUnlock] = useState(null);
  const [rules, setRules] = useState(ctl.rules);
  const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1 - i); return ymd(d).slice(0, 7) + '-01'; });
  const [sel, setSel] = useState(months[0]);
  const { data: issues } = useData(() => call(role, `select * from app.month_close_issues($1,$2::date)`, [org, sel]).catch(() => []), [org, role, sel, ctl]);
  const locked = (m) => ctl.locks.find((l) => l.month === m);
  const lock = async () => { try { await call(role, `select app.lock_month($1,$2::date)`, [org, sel]); toast(`${sel.slice(0, 7)} 已锁账`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const saveRules = async () => { try { await call(role, `select app.set_org_setting($1,'cash_rules',$2)`, [org, JSON.stringify({ count_every_days: N(rules.count_every_days), close_by_day: N(rules.close_by_day), recon_every_days: N(rules.recon_every_days) })]); toast('规则已保存'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="card-b stack">
      <div className="hint">每月锁一次账：锁之前这个月的收款都要确认到账、员工代收都要交、每个账户月底要对上、到账要认领、转账不能在途。锁了以后那个月的收款 / 流水 / 出库不能再改，错了在当月做调整。</div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{months.map((m) => <button type="button" key={m} className={`chip ${sel === m ? 'on' : ''}`} onClick={() => setSel(m)}>{m.slice(0, 7)} {locked(m) ? '🔒' : ''}</button>)}</div>
      <div className="pd-sec">
        <div className="pd-h">{sel.slice(0, 7)} {locked(sel) ? <span className="pill green">已锁账 · {dt(locked(sel).locked_at)}</span> : <span className="pill amber">没锁</span>}</div>
        {!locked(sel) && (issues?.length ? <div className="stack" style={{ gap: 4 }}>{issues.map((x) => <div key={x.issue} className="pill red" style={{ display: 'block', whiteSpace: 'normal' }}>✕ {x.issue}（{x.n}）</div>)}</div> : <div className="pill green">检查通过，可以锁账</div>)}
        {admin && <div className="actbar">{locked(sel) ? <button type="button" className="btn soft-red" onClick={() => setUnlock(sel)}>解锁（写原因）</button> : <button type="button" className="btn primary" disabled={!!issues?.length} onClick={lock}>锁账 {sel.slice(0, 7)}</button>}</div>}
      </div>
      {admin && (
        <div className="pd-sec">
          <div className="pd-h">提醒规则 <Info>到了时间没做，「财务提醒」和铃铛里会提醒。</Info></div>
          <FRow label="锁上个月">每月 <input className="in sm" style={{ width: 60 }} inputMode="numeric" value={rules.close_by_day} onChange={(e) => setRules({ ...rules, close_by_day: e.target.value.replace(/\D/g, '') })} /> 号前</FRow>
          <FRow label="对账">每 <input className="in sm" style={{ width: 60 }} inputMode="numeric" value={rules.recon_every_days} onChange={(e) => setRules({ ...rules, recon_every_days: e.target.value.replace(/\D/g, '') })} /> 天一次</FRow>
          <FRow label="现金盘点">每 <input className="in sm" style={{ width: 60 }} inputMode="numeric" value={rules.count_every_days} onChange={(e) => setRules({ ...rules, count_every_days: e.target.value.replace(/\D/g, '') })} /> 天一次</FRow>
          <div className="actbar"><button type="button" className="btn" onClick={saveRules}>保存规则</button></div>
        </div>
      )}
      {admin && classes && <ClassesEditor classes={classes} />}
      {unlock && <UnlockModal month={unlock} onClose={() => setUnlock(null)} />}
    </div>
  );
}
// 流水分类的选项 (业务类别 / 收支大类 / 一级科目), 一行一个
function ClassesEditor({ classes }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ biz: classes.biz.join('\n'), flow: classes.flow.join('\n'), subject: classes.subject.join('\n') });
  const save = async () => { const v = Object.fromEntries(Object.entries(f).map(([k, t]) => [k, t.split('\n').map((x) => x.trim()).filter(Boolean)])); try { await call(role, `select app.set_org_setting($1,'cash_classes',$2)`, [org, JSON.stringify(v)]); toast('分类选项已保存'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="pd-sec">
      <div className="pd-h">流水分类选项 <Info>「账户流水」里每条流水的 业务类别 / 收支大类 / 一级科目 从这里选，一行一个。</Info></div>
      <div className="cls-grid">{[['biz', '业务类别'], ['flow', '收支大类'], ['subject', '一级科目']].map(([k, l]) => <label key={k} className="stack" style={{ gap: 4 }}><span className="small muted">{l}</span><textarea className="in" rows={8} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}</div>
      <div className="actbar"><button type="button" className="btn" onClick={save}>保存选项</button></div>
    </div>
  );
}

// 219: 退款给客户 (只中方): 从哪个账户退、退多少、原因 + 凭证; 客户总账跟着加回来 (少了预付 / 多了欠款)
export function RefundModal({ acc, customers, onClose }) {
  const { role, toast, refresh } = useApp();
  const [cust, setCust] = useState(null);
  const [account, setAccount] = useState(acc[0]?.account_id || '');
  const [amt, setAmt] = useState(''); const [on, setOn] = useState(today()); const [reason, setReason] = useState(''); const [proof, setProof] = useState('');
  const A = acc.find((a) => a.account_id === account);
  const ok = cust && account && N(amt) > 0 && reason.trim() && proof;
  const go = async () => { try { await call(role, `select app.refund_customer($1,$2,$3,$4,$5,$6)`, [cust, account, N(amt), on, reason, proof]); toast(`已退款 ${money(amt, A?.currency)}，客户总账已更新`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="退款给客户" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">{!cust ? '选客户' : !(N(amt) > 0) ? '填金额' : !reason.trim() ? '写原因' : '传凭证'}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>确认退款</button></>}>
      <div className="stack">
        <div className="hint">客户多付了 / 预付不要了，把钱退回去。账户出一笔支出，客户总账加回这个数。</div>
        <FRow label="客户" req><div style={{ flex: 1, minWidth: 0 }}><CustomerSelect customers={customers} value={cust} onChange={setCust} allowCreate={false} /></div></FRow>
        <FRow label="从哪个账户退" req><select className="in" value={account} onChange={(e) => setAccount(e.target.value)}>{acc.map((a) => <option key={a.account_id} value={a.account_id}>{a.name}</option>)}</select></FRow>
        <FRow label="金额" req><input className="in" inputMode="decimal" style={{ width: 150 }} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">{A?.currency}</span></FRow>
        <FRow label="日期" req><DatePicker value={on} onChange={setOn} /></FRow>
        <FRow label="原因" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 多付了 / 不要预付了" /></FRow>
        <FRow label="凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="转账截图" camera={false} /></div></FRow>
      </div>
    </Modal>
  );
}
function UnlockModal({ month, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [reason, setReason] = useState('');
  const go = async () => { try { await call(role, `select app.unlock_month($1,$2::date,$3)`, [org, month, reason]); toast(`${month.slice(0, 7)} 已解锁（记录在审计里）`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`解锁 ${month.slice(0, 7)}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!reason.trim()} onClick={go}>解锁</button></>}>
      <FRow label="原因" req><input className="in" style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 补录漏掉的一笔收款" /></FRow>
    </Modal>
  );
}
