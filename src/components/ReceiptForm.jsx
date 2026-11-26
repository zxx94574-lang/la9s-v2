// One receipt form for both entries (待改 36): inside the deal (⑨ 收款, defaults to this deal) and on the finance page.
// 3 modes only (待改 28) · receipt currency → the order currency at a locked rate written one way only (待改 30)
// · live preview sentence + before/after (待改 31) · info bar next to the modes (待改 32) · orders open in a drawer (待改 34)
import { DealLink } from './Archives.jsx';
import { OptChoice, OptNote, OptGear, optName, optSubmit, useOptList } from './Opts.jsx';
import { ImpactFor } from './Impact.jsx';
const VOID_WHY = ['金额输错', '小数点输错', '客户 / 订单选错', '重复登记', '客户没付成功'];
import React, { useEffect, useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, DatePicker, PhotoInput, Drawer, BigNum, Modal, FRow, Info, RateInput, Choice, Assumed, MoneyIn, useKeep, clearKeep } from './ui.jsx';
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
  const [date, setDate] = useKeep(`rc.${lockDeal || 'free'}`, 'date', today());
  const [amount, setAmount] = useKeep(`rc.${lockDeal || 'free'}`, 'amount', '');   // Frank 11-09: 实收必须手填, 不带本单金额
  const [currency, setCurrency] = useKeep(`rc.${lockDeal || 'free'}`, 'currency', 'XOF');   // Frank 11-09 第 199 条: 币种下拉, 默认 XOF
  const [rate, setRate] = useKeep(`rc.${lockDeal || 'free'}`, 'rate', '');
  const [fee, setFee] = useKeep(`rc.${lockDeal || 'free'}`, 'fee', '');
  const [method, setMethod] = useKeep(`rc.${lockDeal || 'free'}`, 'method', 'cash');
  const [mode, setMode] = useState(lockDeal ? 'specific' : 'oldest');
  const [picked, setPicked] = useState(lockDeal ? [lockDeal] : []);
  const [proof, setProof] = useKeep(`rc.${lockDeal || 'free'}`, 'proof', '');
  const [busy, setBusy] = useState(false);
  const [rateOk, setRateOk] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [errs, setErrs] = useState(false);
  const [overOk, setOverOk] = useState(false);
  // 214 / 219 / 220: 进哪个账户、手续费谁出、别人代付、员工代收
  const [accountId, setAccountId] = useKeep(`rc.${lockDeal || 'free'}`, 'accountId', '');
  const [feeTouched, setFeeTouched] = useState(false);
  // 318 / 358 (Frank 11-15 / 11-17): 每笔一个开关「我们承担手续费」, 默认否; 开了默认 1% (到账 99%); 高于 1% 红色确认 + 写原因, 低于 1% 黄色确认
  const [feeOn, setFeeOn] = useKeep(`rc.${lockDeal || 'free'}`, 'feeOn', false); const [feeOk, setFeeOk] = useState(false); const [feeWhy, setFeeWhy] = useKeep(`rc.${lockDeal || 'free'}`, 'feeWhy', '');
  const [bearer, setBearer] = useKeep(`rc.${lockDeal || 'free'}`, 'bearer', '');
  const [payer, setPayer] = useKeep(`rc.${lockDeal || 'free'}`, 'payer', '');
  const [byStaff, setByStaff] = useState(false);
  const [collector, setCollector] = useState('');

  const { data } = useData(async () => {
    if (!customer) return null;
    const [open, [bal], last, accounts, staff, [feeCfg]] = await Promise.all([
      q(Q.customerOpenDeals, [customer, acc]), q(Q.customerBalance, [customer, acc]),
      q(`select currency, account_currency, rate from app.receipts where org_id = $1 and currency <> account_currency order by created_at desc limit 20`, [org]),
      q(`select a.id, a.name, a.kind, a.currency, a.holder_employee_id, a.is_public, a.fee_pct, (select e.short_name from app.employees e where e.id = a.holder_employee_id) as holder from app.cash_accounts a where a.org_id = $1 and a.active order by a.sort nulls last, a.name`, [org]).catch(() => []),
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
  // 414 (Frank 11-18): 一条公式 —— 这里填的是「客户付了多少」(= 冲客户账的数, 客户账永远按货款全额冲);
  // 手续费 (我们出) 按账户设置的费率带出, 可改; 账户里记 客户付的 − 手续费 = 实际到账. 现金没有手续费.
  const accFee = N((data?.accounts || []).find((x) => x.id === accountId)?.fee_pct);
  const r2 = (n) => Math.round(n * (currency === 'XOF' ? 1 : 100)) / (currency === 'XOF' ? 1 : 100);
  const feeDefault = method !== 'cash' && N(amount) > 0 ? r2(N(amount) * (accFee || 1) / 100) : 0;
  const feeV = !feeOn || method === 'cash' ? 0 : feeTouched ? N(fee) : feeDefault;
  const feeRate = feeV > 0 && N(amount) > 0 ? feeV / N(amount) * 100 : 0;   // 占客户付的总额的百分之几
  const stdFee = accFee || 1;
  const feeHigh = feeV > 0 && feeRate > stdFee * 1.05, feeLow = feeV > 0 && feeRate < stdFee * 0.95;
  const credit = N(amount);          // 冲客户账 = 客户付的
  const landed = r2(N(amount) - feeV);   // 实际到账 = 客户付的 − 我们出的手续费
  const conv = Math.round(credit * dbRate * (acc === 'XOF' ? 1 : 100)) / (acc === 'XOF' ? 1 : 100);
  // 356 / 314 (Frank 11-17): 只选「收到哪个账户」—— 收款方式和币种跟着账户走, 不再单独选
  const accAll = data?.accounts || [];
  const accSel = accountId;
  const accRow = accAll.find((a) => a.id === accountId) || null;
  const methodOf = (a) => (!a ? 'cash' : ['cash', 'wave', 'orange', 'bank'].includes(a.kind) ? a.kind : 'other');   // 415: 按账户设置里的类型, 不再按名字猜
  const pickAccount = (id) => { const a = accAll.find((x) => x.id === id); setAccountId(id); if (a) { setMethod(methodOf(a)); if (a.currency !== currency) { setCurrency(a.currency); setRate(''); setRateOk(false); } if (methodOf(a) !== 'cash') { setByStaff(false); setCollector(''); } setFee(''); setFeeTouched(false); setFeeOk(false); setFeeOn(methodOf(a) !== 'cash' && !!a.is_public && N(a.fee_pct) > 0); } };
  const isPublic = (a) => !!a?.is_public && !!a?.holder;   // 公司收款账户 (Roland 公户 · Wave / 银行): 钱在他手里, 交回公司前算他欠公司. 别的账户有保管人不算
  const heldBy = !byStaff && isPublic(accRow) ? accRow.holder : null;
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
    if (feeOn && method !== 'cash' && !(feeV > 0)) return toast('开了「我们承担手续费」就要填手续费；没被扣就把开关关掉', 'err');
    if (feeV >= N(amount) && feeV > 0) return toast('手续费不能比客户付的还多', 'err');
    if (feeHigh && !feeWhy.trim()) return toast(`手续费 ${feeRate.toFixed(2)}% 高于平常的 ${stdFee}%：要写原因`, 'err');
    if ((feeHigh || feeLow) && !feeOk) { setFeeOk(true); return toast(`手续费是 ${feeRate.toFixed(2)}%，${feeHigh ? '高于' : '低于'}平常的 ${stdFee}%。核对过再点一次「确认收款」`, 'err'); }
    if (!accountId) return toast('选钱收到了哪个账户', 'err');
    if (!proof) return toast(method === 'cash' ? '现金也要传凭证：在客户群里说「收到现金 XX」，客户回复确认后截图传上来' : `${PAY_METHODS[method]} 收款请上传付款截图`, 'err');
    if (mode === 'specific' && !picked.length) return toast('请点选要冲的单', 'err');
    if (byStaff && !collector) return toast('员工代收：选是哪位员工收的', 'err');
    setBusy(true);
    try {
      const [{ id: newId }] = await call(role, `select app.record_receipt2($1,$2) as id`, [org, JSON.stringify({ customer_id: customer, received_on: date, amount_landed: landed, currency, method, account_currency: acc, rate: dbRate,
        mode, targets: mode === 'specific' ? picked : [], proof: proof || null, fee: feeV, fee_bearer: feeV > 0 ? 'company' : null, payer: payer || null, note: feeHigh && feeWhy.trim() ? `手续费 ${feeRate.toFixed(2)}%：${feeWhy.trim()}` : null,
        account_id: byStaff ? null : (accSel || null), collector_employee_id: byStaff ? collector : null })]);
      clearKeep(`rc.${lockDeal || 'free'}`); toast(byStaff ? '收款已登记：客户账已冲，钱挂在员工名下（在途），交到公司再确认到账' : '收款已登记（待核对到账），客户总账已更新');
      const sum = { id: newId, amount: N(amount), currency, conv, acc, hits: hits.map(([id, v]) => [nameOf(id), v, id]), left: preview.left, fee: feeV, landed, account: accRow?.name, accountId: byStaff ? null : accSel, heldBy: byStaff ? (data.staff || []).find((e) => e.id === collector)?.short_name : heldBy, after: N(data.bal?.balance) - conv };
      setAmount(''); setProof(''); setFee(''); setFeeTouched(false); setFeeOn(false); setFeeOk(false); setFeeWhy(''); setBearer(''); setPayer(''); setByStaff(false); setAccountId(''); setCollector(''); setRate(''); setRateOk(false); setOverOk(false); setErrs(false); if (!lockDeal) setPicked([]);
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
        <div className="fgroups">
          <div className="fgroup"><div className="fgroup-t">① 谁付的</div>
            <div className="rgrid">
              <FRow label="收款日期" req><DatePicker value={date} onChange={setDate} /></FRow>
              <FRow label="付款人"><input className="in" style={{ width: 200 }} value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="别人代付时写（可不填）" /></FRow>
            </div></div>
          <div className="fgroup"><div className="fgroup-t">② 付了多少、收到哪个账户</div>
            <div className="rgrid">
              <FRow label="收到哪个账户" req>
                <OptChoice optKey="cash_accounts" title="资金账户" data value={accSel} onChange={pickAccount} options={accAll.map((a) => [a.id, a.name, isPublic(a) ? `${a.currency} · 在 ${a.holder} 手里` : a.currency])} placeholder="选账户…" err={errs && !accountId} flat={false} style={{ width: 230 }} />
                <Info>只选钱收到了哪个账户：现金、Wave 还是公司收款账户（Roland 的 Wave / 银行）。收款方式和币种跟着账户走，不用再选。<Assumed>账户清单 = 资金账户页里启用的全部账户；账户名带 Cash 算现金、带 Wave 算 Wave、银行账户算银行。</Assumed></Info>
              </FRow>
              <FRow label="客户付了多少" req>
            <MoneyIn className={`in ${errs && !(N(amount) > 0) ? 'err-in' : ''}`} inputMode="decimal" style={{ width: 150, fontSize: 17, fontWeight: 700 }} value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setOverOk(false); }} placeholder="0" />
            <span className="pill">{currency}</span>
            {lockDeal && defaultAmount != null && <Info>本单待付 {money(defaultAmount, acc)}，只作参考，实收请按客户实际付的手填。</Info>}
            {N(amount) > 0 && !foreign && (() => { const due = lockDeal && defaultAmount != null ? N(defaultAmount) : N(data.bal?.balance); const rest = due - conv; return <div className="small muted" style={{ flexBasis: '100%' }}>{rest > 0 ? `冲完这笔，${lockDeal ? '本单' : ''}还欠 ${money(rest, acc)}` : rest < 0 ? `多出 ${money(-rest, acc)} → 进预付` : `正好${lockDeal ? '结清本单' : '付清'}`}</div>; })()}
          </FRow>
              {foreign && (
            <FRow label="汇率" req>
              <RateInput a={foreign} b={base} value={rate} onChange={(v) => { setRate(v === '' ? '' : String(v)); setRateOk(false); }} placeholder={refRate ? String(+refRate.toFixed(4)) : undefined} />
              <Info>汇率登记后锁定，以后不变。{refRate ? `参考 1 ${foreign} = ${+refRate.toFixed(3)} ${base}。` : ''}偏差 ≥10% 确认时要再点一次。</Info>
              {N(rate) > 0 && dev >= 3 && <span className={`small ${dev >= 10 ? 'red-t' : 'amber-t'}`}>偏差 {dev.toFixed(1)}%</span>}
            </FRow>
          )}
              <FRow label="凭证" req><PhotoInput value={proof} onChange={setProof} label={method === 'cash' ? '群里客户确认收到现金的截图' : '付款截图'} camera invalid={errs && !proof} />{method === 'cash' && <Info>收现金：先在客户群里说「收到现金 XX」，客户回复没问题后，把这段聊天截图传上来。</Info>}</FRow>
              {method !== 'cash' && <FRow label="我们承担手续费">
            <Choice value={feeOn ? 'y' : 'n'} onChange={(v) => { setFeeOn(v === 'y'); setFeeOk(false); if (v !== 'y') { setFee(''); setFeeTouched(false); setFeeWhy(''); } }} options={[['n', '否'], ['y', '是']]} />
            {feeOn && <>
              <MoneyIn className={`in ${feeHigh ? 'err-in' : ''}`} inputMode="decimal" style={{ width: 100 }} value={feeTouched ? fee : (feeV ? String(feeV) : '')} onChange={(e) => { setFeeTouched(true); setFeeOk(false); setFee(e.target.value.replace(/[^\d.]/g, '')); }} placeholder="0" />
              <span className="small muted">{currency}</span>
              {feeV > 0 && <span className={`pill ${feeHigh ? 'red' : feeLow ? 'amber' : 'green'}`}>{feeRate.toFixed(2)}%</span>}
              <Assumed>费率按这个账户在「资金账户 → 账户设置」里填的手续费率带出（Wave 默认 1%）；比它高 5% 以上要写原因、低 5% 以上要再点一次确认。公户（Roland Wave）默认就是「是」，别的账户默认「否」。</Assumed>
              {feeHigh && <input className={`in ${errs && !feeWhy.trim() ? 'err-in' : ''}`} style={{ flex: '1 1 180px', minWidth: 0 }} placeholder="比平常高，写原因" value={feeWhy} onChange={(e) => setFeeWhy(e.target.value)} />}
            </>}
            <Info>上面填的是客户付了多少，客户账永远按这个数全额冲。钱到账时被 Wave / 银行扣了手续费（客户付 10,000，只到 9,900）才选「是」：手续费按账户的费率带出 100，可以改；账户里记 10,000 进、100 办公费出，净到账 9,900。客户自己多付了手续费、到账就是全额的，选「否」。现金没有手续费。</Info>
            {feeV > 0 && <div className="small muted" style={{ flexBasis: '100%' }}>客户账冲 {money(credit, currency)}；{heldBy ? `${heldBy} 欠公司` : '实际到账'} {money(landed, currency)}（客户付的 − 手续费 {money(feeV, currency)}）</div>}
          </FRow>}
            </div></div>
          <div className="fgroup"><div className="fgroup-t">③ 钱现在在谁手里</div>
            <div className="rgrid">
              <FRow label="在谁手里">
                {heldBy ? <span><b>{heldBy}</b> <span className="small muted">（公司收款账户：客户账照冲，{heldBy} 交回公司之前算他欠公司）</span></span>
                  : method === 'cash' ? <>
                    <Choice value={byStaff ? 'staff' : 'co'} onChange={(v) => { setByStaff(v === 'staff'); if (v !== 'staff') setCollector(''); }} options={[['co', '交到公司了'], ['staff', '员工代收']]} />
                    {byStaff && <OptChoice optKey="emp_list" title="员工名单" data value={collector} onChange={setCollector} options={(data.staff || []).map((e) => [e.id, e.short_name])} placeholder="选员工…" err={errs && !collector} flat={false} style={{ width: 170 }} />}
                  </> : <span>公司账户 <span className="small muted">（到账后中方在「资金账户」核对）</span></span>}
                <Info>{byStaff ? '客户把现金给了员工：客户账照冲，钱挂在员工名下（在途）；员工交到公司后，在「资金账户 → 员工代收」点「已交」。' : '登记后是「待核对到账」：中方在「资金账户 → 待核对到账」里对着账户余额确认。'}</Info>
              </FRow>
            </div></div>
        </div>
        {!lockDeal && (
          <div className="field"><label>冲账方式</label>
            <div className="row" style={{ gap: 10, alignItems: 'stretch' }}>
              <Choice value={mode} onChange={setMode} options={MODES} flat />
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
        <span className="hint">{method === 'cash' ? '现金也要拍照：数钱 / 收条的照片。' : '凭证可直接粘贴 WhatsApp 截图。'}</span>
        <button type="button" className="btn primary lg" disabled={busy || !can(role, 'receipt')} onClick={submit}>{busy ? '登记中…' : feeOk ? '手续费核对过，确认收款 →' : overOk ? '金额核对过，确认收款 →' : rateOk ? '汇率核对过，确认收款 →' : '确认收款 →'}</button>
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
  const { list: voidWhy } = useOptList('note_void_receipt', VOID_WHY);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await call(role, `select app.void_receipt($1,$2)`, [rc.id, why.trim()]); toast(`已撤销 ${rc.rcv_no}：冲账已收回，客户总账已恢复，可以重新登记`); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`撤销收款 ${rc.rcv_no}`} risk="red" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>不撤了</button><span className="grow" /><button type="button" className="btn danger" disabled={busy || !why.trim()} onClick={go}>确认撤销 {money(rc.amount, rc.currency)} {rc.currency}</button></>}>
      <div className="stack">
        <div className="hint">撤销后：这笔钱冲到各单的金额全部收回、客户总账加回去、公户认领退回「待认领」。收款单不删，标「已撤销」留记录。撤完在下面重新登记正确的金额。</div>
        <div className="chips">{voidWhy.map(([x]) => <button type="button" key={x} className={`chip ${why === x ? 'on' : ''}`} onClick={() => setWhy(x)}>{x}</button>)}<OptGear optKey="note_void_receipt" title="撤销收款的原因" options={VOID_WHY} /></div>
        <input className="in" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="撤销原因（必填）" />
        <ImpactFor customerId={rc.customer_id} cur={rc.currency} delta={N(rc.amount_base ?? rc.amount)} pending={`撤销收款 ＋${money(rc.amount, rc.currency)}（冲到各单的也一起收回）`} />
      </div>
    </Modal>
  );
}


// 收款三段状态 (Frank 11-11 219): 员工代收·在途 (黄) → 待核对到账 (黄) → 已到账 (绿); 撤销的灰
export const rcvState = (r) => (r.voided_at ? ['gray', '已撤销'] : r.collector_employee_id && !r.handed_at ? ['amber', `员工代收 · 在途${r.collector_name ? `（${r.collector_name}）` : ''}`]
  : r.verify_status === 'verified' ? ['green', '已到账'] : ['amber', '待核对到账']);
// 「确认到账」不放格子里 (Frank 11-12): 表格上方的行操作, 选中那一笔才出
export const canVerifyRcv = (r) => !r.voided_at && r.verify_status !== 'verified' && !(r.collector_employee_id && !r.handed_at);
export const verifyRcvAction = (role, toast, onDone) => ({ label: '确认到账（核对过钱确实到了）', when: canVerifyRcv, run: async (r) => { try { await call(role, `select app.verify_receipt($1)`, [r.id]); toast(`${r.rcv_no} 已确认到账`); onDone?.(); } catch (e) { toast(friendlyError(e), 'err'); } } });
export function RcvStatus({ r }) {
  const [tone, label] = rcvState(r);
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <span className={`pill ${tone}`}>{label}</span>
      {N(r.fee) > 0 && <span className="small muted">手续费 {money(r.fee, r.currency)}（{r.fee_bearer === 'company' ? '记办公费' : '客户出'}）</span>}
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
        <FRow label="从" req><Choice value={from} onChange={(v) => { setFrom(v); setTo(''); }} options={froms.map((x) => [x.id, x.label])} flat={false} /></FRow>
        <FRow label="挪到" req><Choice value={to} onChange={setTo} options={tos.map((x) => [x.id, x.label])} flat={false} /></FRow>
        <FRow label="金额" req><MoneyIn className="in" inputMode="decimal" style={{ width: 140 }} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} />{f && <button type="button" className="btn sm ghost" onClick={() => setAmt(String(Math.min(f.max, t?.max ?? Infinity)))}>全部</button>}</FRow>
        <FRow label="原因" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 客户说这笔付的是另一张单" /></FRow>
      </div>
    </Modal>
  );
}


// 413 (Frank 11-18): 登记收款后当场给一张结果卡 —— 生成的收款单号 + 冲到了哪几单 + 冲完客户还欠多少 + 钱进了哪个账户 (那笔流水) / 在谁手里、他一共还欠公司多少.
// 每个号都能点开核对, 不再只弹一句「已登记」就没了.
export function ReceiptDone({ sum, onClose }) {
  const { tick, go } = useApp();
  const { data } = useData(async () => {
    if (!sum?.id) return null;
    const [r] = await q(`select r.rcv_no, r.verify_status, r.account_id, a.name as account, a.is_public, a.currency as acur, e.short_name as holder,
        (select m.id from app.cash_moves m where m.receipt_id = r.id and m.kind = 'deposit' limit 1) as move_id
      from app.receipts r left join app.cash_accounts a on a.id = r.account_id left join app.employees e on e.id = a.holder_employee_id where r.id = $1`, [sum.id]);
    let held = null;
    if (r?.is_public && r.account_id) {
      const [b] = await q(`select coalesce(sum(m.amount * app.move_sign(m)), 0) as bal, min(m.on_date) filter (where app.move_sign(m) > 0) as first from app.cash_moves m where m.account_id = $1`, [r.account_id]);
      const [p] = await q(`select coalesce(sum(coalesce(x.landed, x.amount)), 0) as amt, count(*)::int as n from app.receipts x where x.account_id = $1 and x.voided_at is null and x.verify_status = 'pending'`, [r.account_id]);
      held = { bal: N(b?.bal), pending: N(p?.amt), n: p?.n || 0 };
    }
    return { r, held };
  }, [sum?.id, tick]);
  if (!sum) return null;
  const w = balanceWords(sum.after, sum.acc);
  return (
    <div className="card done-card">
      <div className="card-h"><h2>✓ 收款已登记</h2><span className="grow" /><button type="button" className="btn sm ghost" onClick={onClose}>知道了</button></div>
      <div className="card-b done-grid">
        <div className="done-cell"><div className="k">收款单</div><div className="v mono">{data?.r?.rcv_no || '…'}</div>
          <div className="small muted">客户付 {money(sum.amount, sum.currency)} {sum.currency}{sum.fee > 0 ? ` · 手续费 ${money(sum.fee, sum.currency)} · 净 ${money(sum.landed, sum.currency)}` : ''}</div>
          <button type="button" className="btn sm ghost" onClick={() => go('receipts')}>到收款记录里看这一笔 →</button></div>
        <div className="done-cell"><div className="k">冲到了哪</div>
          {sum.hits.length ? sum.hits.map(([n, v, id]) => <div key={n} className="small">{id && !String(n).includes('期初') ? <DealLink id={id} no={n} /> : <b>{n}</b>} <b>{money(v, sum.acc)}</b></div>) : <div className="small muted">没有未付的单</div>}
          {sum.left > 0 && <div className="small green-t2">剩 {money(sum.left, sum.acc)} 记为预付</div>}</div>
        <div className="done-cell"><div className="k">冲完以后，客户总账</div><div className={`v ${w.tone}-t2`}>{w.text}</div></div>
        <div className="done-cell"><div className="k">钱在哪</div>
          {sum.heldBy && !data?.r?.is_public ? <div className="small"><b>{sum.heldBy}</b> 代收，在途；交到公司后在「资金账户 → 员工代收」点已交</div>
            : data?.r?.is_public ? <>
              <div className="small">这笔在 <b>{data.r.holder}</b> 手里（{data.r.account}）</div>
              {data.held && <div className="small">他这个账户现在一共欠公司 <b className="red-t2">{money(data.held.bal + data.held.pending, data.r.acur)}</b>{data.held.n ? `（其中 ${data.held.n} 笔 ${money(data.held.pending, data.r.acur)} 还没核对）` : ''}</div>}
            </> : <div className="small">进 <b>{sum.account || data?.r?.account || '—'}</b>，{data?.r?.verify_status === 'verified' ? '已核对到账' : '待中方核对到账（核对后才进余额）'}</div>}
          <button type="button" className="btn sm ghost" onClick={() => go('cash')}>到资金账户核对 →</button></div>
      </div>
    </div>);
}
