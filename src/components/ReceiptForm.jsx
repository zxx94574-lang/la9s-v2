// One receipt form for both entries (待改 36): inside the deal (⑨ 收款, defaults to this deal) and on the finance page.
// 3 modes only (待改 28) · receipt currency → the order currency at a locked rate written one way only (待改 30)
// · live preview sentence + before/after (待改 31) · info bar next to the modes (待改 32) · orders open in a drawer (待改 34)
import { DealLink } from './Archives.jsx';
import React, { useEffect, useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, DatePicker, PhotoInput, Drawer, BigNum, Modal, FRow, Info, RateInput } from './ui.jsx';
import Grid from './Grid.jsx';
import { can, whoCan, PAY_METHODS, balanceWords } from '../lib/domain.js';
import { money, today, dDate, friendlyError } from '../lib/format.js';
import Deal from '../pages/Deal.jsx';

const N = (v) => Number(v || 0);
export const MODES = [['oldest', '① 冲最老的单（默认）'], ['specific', '② 指定冲这一单 / 这几单'], ['none', '③ 先不冲，记为预付款']];
// reference rates: 1 unit = ? XOF (the last rate used for that currency wins)
const REF = { USD: 600, EUR: 655.957, CNY: 85 };

export function DealDrawer({ id, onClose }) {
  const { go } = useApp();
  return (
    <Drawer title="订单详情" onClose={onClose} actions={<button type="button" className="btn sm" onClick={() => { onClose(); go('deal/' + id); }}>在新页面打开 ↗</button>}>
      <Deal id={id} key={id} />
    </Drawer>
  );
}
export const DealChip = ({ id, no, onOpen }) => <DealLink id={id} no={no} onOpen={onOpen} />;   // 207: 和全站单号链接同一个样式

export default function ReceiptForm({ customer, accountCurrency = 'XOF', lockDeal, defaultAmount, onDone, compact }) {
  const { org, role, toast, refresh } = useApp();
  const acc = accountCurrency;
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');   // Frank 11-09: 实收必须手填, 不带本单金额
  const [currency, setCurrency] = useState('XOF');   // Frank 11-09 第 199 条: 币种下拉, 默认 XOF
  const [rate, setRate] = useState('');
  const [fee, setFee] = useState('');
  const [method, setMethod] = useState('cash');
  const [mode, setMode] = useState(lockDeal ? 'specific' : 'oldest');
  const [picked, setPicked] = useState(lockDeal ? [lockDeal] : []);
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);
  const [rateOk, setRateOk] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [errs, setErrs] = useState(false);
  const [overOk, setOverOk] = useState(false);
  // 214 / 219 / 220: 进哪个账户、手续费谁出、别人代付、员工代收
  const [accountId, setAccountId] = useState('');
  const [feeTouched, setFeeTouched] = useState(false);
  const [bearer, setBearer] = useState('');
  const [payer, setPayer] = useState('');
  const [byStaff, setByStaff] = useState(false);
  const [collector, setCollector] = useState('');

  const { data } = useData(async () => {
    if (!customer) return null;
    const [open, [bal], last, accounts, staff, [feeCfg]] = await Promise.all([
      q(Q.customerOpenDeals, [customer, acc]), q(Q.customerBalance, [customer, acc]),
      q(`select currency, account_currency, rate from app.receipts where org_id = $1 and currency <> account_currency order by created_at desc limit 20`, [org]),
      q(`select id, name, kind, currency from app.cash_accounts where org_id = $1 and active order by name`, [org]).catch(() => []),
      q(`select id, short_name from app.employees where org_id = $1 and active order by short_name`, [org]).catch(() => []),
      q(`select value from app.org_settings where org_id = $1 and key = 'fee_rates'`, [org]).catch(() => [])]);
    return { open, bal, last, accounts, staff, feeRates: { wave: 1, ...(feeCfg?.value || {}) } };
  }, [customer, acc]);

  // rate is always typed as "1 <foreign> = ? XOF" (or ? <acc> when the order is not XOF)
  const foreign = currency !== acc ? (currency === 'XOF' ? acc : currency) : null;
  const base = foreign ? (currency === 'XOF' ? 'XOF' : acc) : null;          // the side expressed per 1 foreign unit
  const refRate = useMemo(() => {
    if (!foreign || !data) return null;
    const hit = data.last.find((r) => (r.currency === foreign && r.account_currency === base) || (r.currency === base && r.account_currency === foreign));
    if (hit) return hit.currency === foreign ? N(hit.rate) : 1 / N(hit.rate);
    return base === 'XOF' ? REF[foreign] : null;
  }, [foreign, base, data]);
  const dbRate = !foreign ? 1 : currency === foreign ? N(rate) : (N(rate) > 0 ? 1 / N(rate) : 0);
  const feePct = N(data?.feeRates?.[method]);
  const feeV = feeTouched ? N(fee) : (feePct > 0 && N(amount) > 0 ? Math.round(N(amount) * feePct / (100 - feePct) * (currency === 'XOF' ? 1 : 100)) / (currency === 'XOF' ? 1 : 100) : 0);
  const credit = N(amount) + (bearer === 'company' ? feeV : 0);   // 冲客户账 = 到账 (+ 我方出的手续费)
  const conv = Math.round(credit * dbRate * (acc === 'XOF' ? 1 : 100)) / (acc === 'XOF' ? 1 : 100);
  const accOpts = (data?.accounts || []).filter((a) => a.currency === currency);
  const accAuto = accOpts.find((a) => a.kind === method) || (accOpts.length === 1 ? accOpts[0] : null);
  const accSel = accountId || accAuto?.id || '';
  const dev = foreign && refRate && N(rate) > 0 ? Math.abs(N(rate) - refRate) / refRate * 100 : 0;

  const preview = useMemo(() => {
    if (!data) return null;
    let left = conv; const out = {};
    const order = mode === 'oldest' ? data.open.map((d) => d.deal_id) : mode === 'specific' ? picked : [];
    for (const id of order) { const d = data.open.find((x) => x.deal_id === id); const t = Math.min(left, N(d?.due)); if (t > 0) { out[id] = t; left -= t; } }
    return { out, left: Math.max(left, 0) };
  }, [data, conv, mode, picked]);

  if (!customer) return <div className="card-b hint">先选客户。</div>;
  if (!data) return <div className="empty">加载中…</div>;
  const before = balanceWords(data.bal?.balance, acc);
  const after = balanceWords(N(data.bal?.balance) - conv, acc);
  const nameOf = (id) => { const d = data.open.find((x) => x.deal_id === id); return d?.kind === 'opening' ? '期初欠款' : d?.biz_no; };
  const hits = Object.entries(preview.out);

  const submit = async () => {
    setErrs(true);
    if (!(N(amount) > 0)) return toast('请填收款金额', 'err');
    if (foreign && !(N(rate) > 0)) return toast(`请填汇率：1 ${foreign} = ? ${base}`, 'err');
    if (dev >= 10 && !rateOk) { setRateOk(true); return toast(`汇率和参考值差 ${dev.toFixed(1)}%，再点一次「确认收款」表示核对过`, 'err'); }
    // 多收 (常见是多打了位数 / 小数点): 再点一次才算数
    const dueAll = data.open.reduce((a, d) => a + N(d.due), 0);
    const cap = lockDeal && defaultAmount != null ? N(defaultAmount) : dueAll;
    if (cap > 0 && conv > cap && !overOk) { setOverOk(true); return toast(`实收 ${money(conv, acc)} 比${lockDeal ? '本单待付' : '全部欠款'} ${money(cap, acc)} 多 ${money(conv - cap, acc)}，多出的记为预付。核对过金额再点一次「确认收款」`, 'err'); }
    if (!proof) return toast(method === 'cash' ? '现金也要传凭证：在客户群里说「收到现金 XX」，客户回复确认后截图传上来' : `${PAY_METHODS[method]} 收款请上传付款截图`, 'err');
    if (mode === 'specific' && !picked.length) return toast('请点选要冲的单', 'err');
    if (feeV > 0 && !bearer) return toast('有手续费，请选谁出（客户出 / 我方出）', 'err');
    if (byStaff && !collector) return toast('员工代收：选是哪位员工收的', 'err');
    setBusy(true);
    try {
      await call(role, `select app.record_receipt2($1,$2)`, [org, JSON.stringify({ customer_id: customer, received_on: date, amount_landed: N(amount), currency, method, account_currency: acc, rate: dbRate,
        mode, targets: mode === 'specific' ? picked : [], proof: proof || null, fee: feeV, fee_bearer: feeV > 0 ? bearer : null, payer: payer || null,
        account_id: byStaff ? null : (accSel || null), collector_employee_id: byStaff ? collector : null })]);
      toast(byStaff ? '收款已登记：客户账已冲，钱挂在员工名下（在途），交到公司再确认到账' : '收款已登记（待核对到账），客户总账已更新');
      const sum = { amount: N(amount), currency, conv, acc, hits: hits.map(([id, v]) => [nameOf(id), v]), left: preview.left };
      setAmount(''); setProof(''); setFee(''); setFeeTouched(false); setBearer(''); setPayer(''); setByStaff(false); setCollector(''); setRate(''); setRateOk(false); setOverOk(false); setErrs(false); if (!lockDeal) setPicked([]);
      refresh(); onDone?.(sum);
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };

  const cols = [
    { key: 'biz_no', label: '订单', w: 150, render: (d) => (d.kind === 'opening' ? <b>期初欠款</b> : <DealChip id={d.deal_id} no={d.biz_no} onOpen={setDrawer} />) },
    { key: 'first_shipped_at', label: '出库日期', w: 96, render: (d) => dDate(d.first_shipped_at) || '历史' },
    { key: 'receivable', label: `应收 ${acc}`, w: 110, value: (d) => N(d.shipped_amount) - N(d.returned_amount), render: (d) => money(N(d.shipped_amount) - N(d.returned_amount), acc) },
    { key: 'allocated_amount', label: '已付', w: 100, render: (d) => money(d.allocated_amount, acc) },
    { key: 'due', label: '未付', w: 110, render: (d) => <b>{money(d.due, acc)}</b> },
    ...(mode === 'specific' && !lockDeal ? [{ key: 'pick', label: '冲这单（按点选顺序）', w: 150, sortable: false, filterable: false, render: (d) => {
      const i = picked.indexOf(d.deal_id);
      return <button type="button" className={`btn sm ${i >= 0 ? 'primary' : ''}`} onClick={() => setPicked(i >= 0 ? picked.filter((x) => x !== d.deal_id) : [...picked, d.deal_id])}>{i >= 0 ? `第 ${i + 1} 顺位 ✓` : '选'}</button>;
    } }] : []),
    { key: 'after', label: '冲完后', w: 190, sortable: false, filterable: false, render: (d) => {
      const take = preview.out[d.deal_id] || 0; const rec = N(d.shipped_amount) - N(d.returned_amount);
      const paid = rec - N(d.due) + take; const pct = rec > 0 ? Math.min(100, (paid / rec) * 100) : 0;
      return (
        <span className="after">
          <span className="bar"><i style={{ width: `${pct}%` }} className={take ? 'hit' : ''} /></span>
          {!take ? <span className="muted small">不动</span> : take >= N(d.due) ? <b className="green-t2">结清 ✓</b> : <span>部分 · 还欠 {money(N(d.due) - take, acc)}</span>}
        </span>);
    } },
  ];

  return (
    <div className="rform">
      {!can(role, 'receipt') && <div className="card-b"><span className="lock">当前岗位不能登记收款（{whoCan('receipt')}）</span></div>}
      <div className="card-b stack">
        <div className="rgrid">
          <FRow label="收款日期" req><DatePicker value={date} onChange={setDate} /></FRow>
          <FRow label="收款方式" req><div className="chips">{['cash', 'wave', 'orange', 'bank'].map((k) => <button type="button" key={k} className={`chip ${method === k ? 'on' : ''}`} onClick={() => setMethod(k)}>{PAY_METHODS[k]}</button>)}</div></FRow>
          <FRow label="到账金额" req>
            <input className={`in ${errs && !(N(amount) > 0) ? 'err-in' : ''}`} inputMode="decimal" style={{ width: 150, fontSize: 17, fontWeight: 700 }} value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setOverOk(false); }} placeholder="0" />
            <select className="in" style={{ width: 84 }} value={currency} onChange={(e) => { setCurrency(e.target.value); setRate(''); setRateOk(false); }}>{[...new Set(['XOF', acc, 'USD', 'CNY', 'EUR'])].map((c) => <option key={c} value={c}>{c}</option>)}</select>
            {lockDeal && defaultAmount != null && <Info>本单待付 {money(defaultAmount, acc)}，只作参考，实收请按到账手填。</Info>}
          </FRow>
          <FRow label="凭证" req><PhotoInput value={proof} onChange={setProof} label={method === 'cash' ? '群里客户确认收到现金的截图' : '付款截图'} camera invalid={errs && !proof} />{method === 'cash' && <Info>收现金：先在客户群里说「收到现金 XX」，客户回复没问题后，把这段聊天截图传上来。</Info>}</FRow>
          {foreign && (
            <FRow label="汇率" req>
              <RateInput a={foreign} b={base} value={rate} onChange={(v) => { setRate(v === '' ? '' : String(v)); setRateOk(false); }} placeholder={refRate ? String(+refRate.toFixed(4)) : undefined} />
              <Info>汇率登记后锁定，以后不变。{refRate ? `参考 1 ${foreign} = ${+refRate.toFixed(3)} ${base}。` : ''}偏差 ≥10% 确认时要再点一次。</Info>
              {N(rate) > 0 && dev >= 3 && <span className={`small ${dev >= 10 ? 'red-t' : 'amber-t'}`}>偏差 {dev.toFixed(1)}%</span>}
            </FRow>
          )}
          <FRow label="手续费">
            <input className="in" inputMode="decimal" style={{ width: 100 }} value={feeTouched ? fee : (feeV ? String(feeV) : '')} onChange={(e) => { setFeeTouched(true); setFee(e.target.value.replace(/[^\d.]/g, '')); }} placeholder="0" />
            <span className="small muted">{currency}{feePct > 0 && !feeTouched ? `（${PAY_METHODS[method]} 默认 ${feePct}%）` : ''}</span>
            {feeV > 0 && <span className="chips">{[['customer', '客户出'], ['company', '我方出']].map(([k, l]) => <button type="button" key={k} className={`chip ${bearer === k ? 'on' : ''} ${errs && !bearer ? 'err' : ''}`} onClick={() => setBearer(k)}>{l}</button>)}</span>}
            <Info>客户出：客户多付了手续费（欠 10,000 付 10,100），冲客户账 = 到账金额。我方出：客户只付了 9,900，冲客户账 = 到账 + 手续费，差的记成我方手续费支出。手续费不算客户欠款。</Info>
          </FRow>
          <FRow label="进哪个账户">
            {method === 'cash' && <span className="chips"><button type="button" className={`chip ${!byStaff ? 'on' : ''}`} onClick={() => setByStaff(false)}>交到公司</button><button type="button" className={`chip ${byStaff ? 'on' : ''}`} onClick={() => setByStaff(true)}>员工代收</button></span>}
            {byStaff ? <select className={`in ${errs && !collector ? 'err-in' : ''}`} style={{ width: 160 }} value={collector} onChange={(e) => setCollector(e.target.value)}><option value="">选员工…</option>{(data.staff || []).map((e) => <option key={e.id} value={e.id}>{e.short_name}</option>)}</select>
              : <select className="in" style={{ width: 170 }} value={accSel} onChange={(e) => setAccountId(e.target.value)}><option value="">（先不选账户）</option>{accOpts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
            <Info>{byStaff ? '客户把现金给了员工：客户账照冲，钱挂在员工名下（在途）；员工存进 Wave 转给公司后，在「资金账户 → 员工代收」点「已交」才进账户。' : '选了账户：核对到账（或导入流水自动配对）后，这笔钱记进这个账户的流水，分类「收客户货款」。'}</Info>
          </FRow>
          <FRow label="付款人"><input className="in" style={{ width: 200 }} value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="别人代付时写（可不填）" /></FRow>
        </div>
        {!lockDeal && (
          <div className="field"><label>冲账方式</label>
            <div className="row" style={{ gap: 10, alignItems: 'stretch' }}>
              <div className="chips">{MODES.map(([k, l]) => <button type="button" key={k} className={`chip ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{l}</button>)}</div>
              <div className="infobar">ⓘ 收款立即进客户总账；冲到哪一单只影响单据「未付」，不影响总欠款。没冲完的部分记为预付，下次出库自动抵扣。</div>
            </div>
          </div>
        )}
        {lockDeal && <div className="infobar">ⓘ 默认把这笔钱冲到本单；多出来的记为客户预付，下次出库自动抵扣。要一次付多单，请到「收款与冲账」页。</div>}

        <div className="preview" key={`${conv}-${mode}-${picked.join()}`}>
          {!(N(amount) > 0) ? <span className="muted">填金额后，这里显示这笔钱冲到哪几单、冲完后客户欠款变成多少。</span> : (
            <>
              <div className="pv-line">
                收 <b>{money(amount, currency)} {currency}</b>{foreign && <> （折 {money(conv, acc)} {acc}）</>}
                {hits.map(([id, v]) => { const d = data.open.find((x) => x.deal_id === id); return <span key={id}> → 冲 <b className="mono">{nameOf(id)}</b> <b>{money(v, acc)}</b>{v >= N(d.due) ? '（结清）' : `（还欠 ${money(N(d.due) - v, acc)}）`}</span>; })}
                {preview.left > 0 && <> → 剩 <b className="green-t2">{money(preview.left, acc)} {acc} 记为预付</b></>}
              </div>
              <div className="pv-ba">客户总账：<span className={`${before.tone}-t2`}>{before.text}</span> <span className="arrow">→</span> <b className={`${after.tone}-t2`}>{after.text}</b></div>
            </>
          )}
        </div>
      </div>
      {!compact && (
        <>
          <div className="grid-tools" style={{ borderTop: '1px solid var(--line-2)' }}>
            <b style={{ color: 'var(--ink)' }}>未结清订单（{acc}）</b><span>单号可点开，在右侧查看，不离开本页</span>
          </div>
          <Grid id={`rcv-open-${acc}`} columns={cols} rows={data.open} rowKey={(d) => d.deal_id} empty="这个客户没有未付的单；现在收款会记为预付款"
            foot={(rows) => ({ biz_no: `${rows.length} 单`, due: money(rows.reduce((a, d) => a + N(d.due), 0), acc) })} />
        </>
      )}
      <div className="actionbar">
        <span className="hint">{method === 'cash' ? '门店现金当面收款可以不传凭证。' : '凭证可直接粘贴 WhatsApp 截图。'}</span>
        <button type="button" className="btn primary lg" disabled={busy || !can(role, 'receipt')} onClick={submit}>{busy ? '登记中…' : overOk ? '金额核对过，确认收款 →' : rateOk ? '汇率核对过，确认收款 →' : '确认收款 →'}</button>
      </div>
      {drawer && <DealDrawer id={drawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}

// balance block shown after any money action (待改 38 / 43 / 45)
export function BalanceLine({ balance, currency = 'XOF', size = 24 }) {
  const w = balanceWords(balance, currency);
  return (
    <div className={`balline ${w.tone}`}>
      <span className="k">{w.label === '预付' ? '当前客户无欠款，此为预付' : w.label}</span>
      {w.amount > 0 && <BigNum size={size}>{money(w.amount, currency)} <small>{currency}</small></BigNum>}
    </div>
  );
}

// 撤销收款 (Frank 11-09 14:01): 点错 / 小数点输错能撤; 必填原因; 冲账收回、总账反冲、留痕. 撤完重新登记一笔正确的.
export function VoidReceiptModal({ rc, onClose }) {
  const { role, toast, refresh } = useApp();
  const [why, setWhy] = useState('金额输错');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await call(role, `select app.void_receipt($1,$2)`, [rc.id, why.trim()]); toast(`已撤销 ${rc.rcv_no}：冲账已收回，客户总账已恢复，可以重新登记`); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`撤销收款 ${rc.rcv_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>不撤了</button><span className="grow" /><button type="button" className="btn danger" disabled={busy || !why.trim()} onClick={go}>确认撤销 {money(rc.amount, rc.currency)} {rc.currency}</button></>}>
      <div className="stack">
        <div className="hint">撤销后：这笔钱冲到各单的金额全部收回、客户总账加回去、公户认领退回「待认领」。收款单不删，标「已撤销」留记录。撤完在下面重新登记正确的金额。</div>
        <div className="chips">{['金额输错', '小数点输错', '客户 / 订单选错', '重复登记', '客户没付成功'].map((x) => <button type="button" key={x} className={`chip ${why === x ? 'on' : ''}`} onClick={() => setWhy(x)}>{x}</button>)}</div>
        <input className="in" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="撤销原因（必填）" />
      </div>
    </Modal>
  );
}


// 收款三段状态 (Frank 11-11 219): 员工代收·在途 (黄) → 待核对到账 (黄) → 已到账 (绿); 撤销的灰
export const rcvState = (r) => (r.voided_at ? ['gray', '已撤销'] : r.collector_employee_id && !r.handed_at ? ['amber', `员工代收 · 在途${r.collector_name ? `（${r.collector_name}）` : ''}`]
  : r.verify_status === 'verified' ? ['green', '已到账'] : ['amber', '待核对到账']);
export function RcvStatus({ r, onDone }) {
  const { role, toast } = useApp();
  const [tone, label] = rcvState(r);
  const can2 = can(role, 'receipt') && !r.voided_at;
  const verify = async () => { try { await call(role, `select app.verify_receipt($1)`, [r.id]); toast(`${r.rcv_no} 已确认到账`); onDone?.(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <span className={`pill ${tone}`}>{label}</span>
      {can2 && r.verify_status !== 'verified' && !(r.collector_employee_id && !r.handed_at) && <button type="button" className="btn sm" onClick={verify} title="核对过 Wave / 银行 / 现金，钱确实到了">确认到账</button>}
      {N(r.fee) > 0 && <span className="small muted">手续费 {money(r.fee, r.currency)}（{r.fee_bearer === 'company' ? '我方出' : '客户出'}）</span>}
      {r.payer && <span className="small muted">付款人 {r.payer}</span>}
    </span>
  );
}

// 改冲账 (Frank 11-11 217): 把这笔钱从 A 单挪到 B 单 / 挪成预付; 收款本身不动; 只财务 / 中方; 原因必填, 留记录
export function ReallocModal({ r, onClose, onDone }) {
  const { role, toast } = useApp();
  const { data } = useData(() => q(Q.customerOpenDeals, [r.customer_id, r.account_currency]), [r.customer_id, r.account_currency]);
  const froms = [...r.allocations.map((a) => ({ id: a.deal_id, label: `${a.biz_no}（冲了 ${money(a.amount, r.account_currency)}）`, max: N(a.amount) })), ...(N(r.unallocated) > 0 ? [{ id: '', label: `预付（${money(r.unallocated, r.account_currency)}）`, max: N(r.unallocated) }] : [])];
  const [from, setFrom] = useState(froms[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  const f = froms.find((x) => x.id === from);
  const tos = [...(data || []).filter((d) => d.deal_id !== from && d.kind !== 'opening' && N(d.due) > 0).map((d) => ({ id: d.deal_id, label: `${d.biz_no}（还欠 ${money(d.due, r.account_currency)}）`, max: N(d.due) })), ...(from ? [{ id: 'prepay', label: '改成预付', max: Infinity }] : [])];
  const t = tos.find((x) => x.id === to);
  const ok = f && t && N(amt) > 0 && N(amt) <= f.max && N(amt) <= t.max && reason.trim();
  const go = async () => {
    try { await call(role, `select app.reallocate_receipt($1,$2,$3,$4,$5)`, [r.id, from || null, N(amt), to === 'prepay' ? null : to, reason.trim()]); toast('已改冲账，两张单的未付都已更新'); onDone?.(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`改冲账 · ${r.rcv_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">{!reason.trim() ? '要写原因' : f && N(amt) > f.max ? `最多挪 ${money(f.max)}` : t && N(amt) > t.max ? `目标单只欠 ${money(t.max)}` : '选好挪出 / 挪入和金额'}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>确认改冲账</button></>}>
      <div className="stack">
        <div className="hint">收款本身不动（金额、日期、凭证都不变），只改「这笔钱算在哪张单」。客户总欠款不变。</div>
        <FRow label="从" req><select className="in" value={from} onChange={(e) => { setFrom(e.target.value); setTo(''); }}>{froms.map((x) => <option key={x.id || 'pre'} value={x.id}>{x.label}</option>)}</select></FRow>
        <FRow label="挪到" req><select className="in" value={to} onChange={(e) => setTo(e.target.value)}><option value="">请选择</option>{tos.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></FRow>
        <FRow label="金额" req><input className="in" inputMode="decimal" style={{ width: 140 }} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} />{f && <button type="button" className="btn sm ghost" onClick={() => setAmt(String(Math.min(f.max, t?.max ?? Infinity)))}>全部</button>}</FRow>
        <FRow label="原因" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 客户说这笔付的是另一张单" /></FRow>
      </div>
    </Modal>
  );
}
