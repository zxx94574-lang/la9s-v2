import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { PhotoInput, TierPill, Light, useApp, useData, Pill, Modal, OptionNote, BigNum } from '../components/ui.jsx';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';
import Grid from '../components/Grid.jsx';
import { BalanceCopy } from '../components/Doc.jsx';
import { DealDrawer, DealChip, BalanceLine } from '../components/ReceiptForm.jsx';
import { TIERS, seesPrice, balanceWords, can, NOTE_OPTIONS, RETURN_REASONS } from '../lib/domain.js';
import { money, qty, dt, dDate, friendlyError, pad } from '../lib/format.js';

const N = (v) => Number(v || 0);

export default function Balances() {
  const { org, go, role } = useApp();
  const { data } = useData(() => q(Q.balances, [org]), [org]);
  if (!seesPrice(role)) return <div className="card card-b lock">当前岗位看不到账款。</div>;
  const rows = data || [];
  const cols = [
    { key: 'code', label: '客户编码', w: 70, render: (r) => <b className="mono">{r.code}</b> },
    { key: 'name', label: '客户', w: 160, render: (r) => <><CustLink id={r.customer_id || r.id} name={r.name} /> <span className="muted small">{r.city}</span></> },
    { key: 'tier', label: '档位', w: 100, value: (r) => TIERS[r.tier], render: (r) => <TierPill tier={r.tier} /> },
    { key: 'owner', label: '归属销售', w: 80 },
    { key: 'total_sold', label: '累计购买', w: 120, render: (r) => money(r.total_sold) },
    { key: 'total_paid', label: '累计已付', w: 120, render: (r) => money(r.total_paid) },
    { key: 'total_returned', label: '累计退货', w: 90, render: (r) => money(r.total_returned) },
    { key: 'balance', label: '欠款 / 预付', w: 140, render: (r) => { const w = balanceWords(r.balance); return <b className={`${w.tone}-t2`}>{w.label === '已结清' ? '已结清' : `${w.label === '预付' ? '预付 ' : ''}${money(w.amount)}`}</b>; } },
    { key: 'last_shipped', label: '最近出库', w: 110, render: (r) => dDate(r.last_shipped) },
    // 账龄: 还欠的钱按单据 (出库 / 期初单) 日期分段
    ...[['a30', '30 天内', (r) => N(r.d0_30)], ['a90', '31–90 天', (r) => N(r.d31_60) + N(r.d61_90)], ['a90p', '90 天以上', (r) => N(r.d91_180) + N(r.d180)]].map(([k, l, f], i) => (
      { key: k, label: l, w: 95, value: f, render: (r) => (f(r) ? <span className={['', 'amber-t2', 'red-t2'][i]}>{money(f(r))}</span> : '') })),
    { key: 'oldest_days', label: '最老欠款', w: 105, value: (r) => N(r.oldest_days),
      render: (r) => (r.oldest_days == null ? '' : r.credit_days != null && r.oldest_days > r.credit_days ? <Pill tone="red">{r.oldest_days} 天 · 超账期</Pill> : `${r.oldest_days} 天`) },
  ];
  const debt = rows.reduce((a, r) => a + Math.max(0, N(r.balance)), 0), pre = rows.reduce((a, r) => a + Math.max(0, -N(r.balance)), 0);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Balance clients</div><h1>客户总账 Balance</h1>
        <div className="sub">总账只在出库后增加；收款、退货、抹零冲减。点一行看逐笔明细。</div></div></div>
      <div className="card">
        <Grid id="balances" table="customers" columns={cols} rows={rows} onRowClick={(r) => go('customer/' + r.id)}
          foot={(rs) => ({ code: `${rs.length} 位`, total_sold: money(rs.reduce((a, r) => a + N(r.total_sold), 0)), total_paid: money(rs.reduce((a, r) => a + N(r.total_paid), 0)),
            balance: `欠 ${money(rs.reduce((a, r) => a + Math.max(0, N(r.balance)), 0))} · 预付 ${money(rs.reduce((a, r) => a + Math.max(0, -N(r.balance)), 0))}` })} />
        <div className="card-b hint">全部客户：欠款合计 <b className="red-t2">{money(debt)} XOF</b>；预付合计 <b className="green-t2">{money(pre)} XOF</b>（预付在下次出库时自动抵扣）。</div>
      </div>
    </>
  );
}

const KIND = { opening: ['期初', 'gray'], shipment: ['出库', 'blue'], receipt: ['收款', 'green'], return: ['退货', 'amber'], adjust: ['调整', 'gray'],
  void: ['撤销出库', 'red'], writeoff: ['抹零', 'gray'] };

export function CustomerLedger({ id }) {
  const { org, go, role } = useApp();
  const [drawer, setDrawer] = useState(null);
  const [cret, setCret] = useState(false);
  const { data } = useData(async () => {
    const [b] = (await q(Q.balances, [org])).filter((x) => x.id === id);
    const [ledger, open, returns] = await Promise.all([q(Q.customerLedger, [id, 'XOF']), q(Q.customerOpenDeals, [id, 'XOF']), q(Q.customerReturns, [id])]);
    return { b, ledger, open, returns };
  }, [id]);
  if (!data) return <div className="empty">加载中…</div>;
  const { b, ledger, open, returns } = data;
  if (!b) return <div className="card card-b">找不到这个客户（或不是正式客户）。</div>;
  const w = balanceWords(b.balance);
  return (
    <>
      <div className="pagehead">
        <div><div className="eyebrow">Balance · {b.code}</div><h1>{b.name} <span className="muted" style={{ fontSize: 16, fontWeight: 500 }}>{b.city} · <TierPill tier={b.tier} /></span></h1></div>
        <div className="row"><BalanceCopy customerId={id} label="复制 Balance 图片" primary hidePrint={false} />
          {can(role, 'request_return') && <button type="button" className="btn" onClick={() => setCret(true)}>↩ 按客户退货</button>}
          <button type="button" className="btn" onClick={() => go('receipts/' + id)}>＋ 登记收款</button></div>
      </div>
      <div className="kpis">
        <div className="kpi" style={{ cursor: 'default' }}><div className="t"><span>累计购买</span></div><BigNum size={26} className="kv-num">{money(b.total_sold)} <small>XOF</small></BigNum></div>
        <div className="kpi" style={{ cursor: 'default' }}><div className="t"><span>累计已付</span></div><BigNum size={26} className="kv-num">{money(b.total_paid)} <small>XOF</small></BigNum>
          <div className="f"><span>退货冲减 {money(b.total_returned)}{N(b.total_writeoff) > 0 && ` · 抹零 ${money(b.total_writeoff)}`}</span></div></div>
        <div className="kpi" style={{ cursor: 'default' }}><div className="t"><span className={`${w.tone}-t2`}>{w.label === '预付' ? '当前客户无欠款，此为预付' : w.label}</span></div>
          {w.amount > 0 ? <BigNum size={26} className={`kv-num ${w.tone}-t2`}>{money(w.amount)} <small>XOF</small></BigNum> : <BigNum size={26} className="kv-num green-t2">✓</BigNum>}</div>
      </div>
      <div className="card">
        <div className="card-h"><h2>未结清的单 <span className="muted small">收款默认按这个顺序冲（最老的先冲）</span></h2></div>
        <Grid id="cust-open" rowKey={(d) => d.deal_id} rows={open} empty="全部结清 ✓" columns={[
          { key: 'biz_no', label: '订单', w: 150, render: (d) => (d.kind === 'opening' ? <b>期初欠款</b> : <DealChip id={d.deal_id} no={d.biz_no} onOpen={setDrawer} />) },
          { key: 'first_shipped_at', label: '出库日期', w: 100, render: (d) => dDate(d.first_shipped_at) || '历史' },
          { key: 'shipped_amount', label: '出库金额', w: 110, render: (d) => money(d.shipped_amount) },
          { key: 'returned_amount', label: '退货', w: 90, render: (d) => money(d.returned_amount) },
          { key: 'allocated_amount', label: '已冲', w: 100, render: (d) => money(d.allocated_amount) },
          { key: 'due', label: '未付', w: 110, render: (d) => <b>{money(d.due)}</b> },
        ]} foot={(rs) => ({ biz_no: `${rs.length} 单`, due: money(rs.reduce((a, d) => a + N(d.due), 0)) })} />
      </div>
      <div className="card">
        <div className="card-h"><h2>逐笔流水</h2><span className="muted small">出库、收款、退货、撤销出库、抹零每一笔都在；单号可点开</span></div>
        <Grid id="cust-ledger" rowKey={(e) => e.id} rows={ledger} columns={[
          { key: 'at', label: '日期', w: 130, render: (e) => (e.kind === 'receipt' ? dDate(e.eff_at) : dt(e.eff_at)) },
          { key: 'kind', label: '类型', w: 90, render: (e) => <Pill tone={KIND[e.kind]?.[1] || 'gray'}>{KIND[e.kind]?.[0] || e.kind}</Pill> },
          { key: 'doc_no', label: '单据', w: 150, render: (e) => <span className="mono">{e.doc_no || e.note || ''}</span> },
          { key: 'biz_no', label: '订单', w: 150, render: (e) => (e.deal_id && e.biz_no ? <DealChip id={e.deal_id} no={e.biz_no} onOpen={setDrawer} /> : '') },
          { key: 'amount', label: '金额（+欠 / −减）', w: 140, render: (e) => <b style={{ color: N(e.amount) < 0 ? 'var(--green)' : '' }}>{N(e.amount) > 0 ? '+' : ''}{money(e.amount)}</b> },
          { key: 'running', label: '余额', w: 170, render: (e) => { const x = balanceWords(e.running); return <b className={`${x.tone}-t2`}>{x.label === '已结清' ? '已结清' : `${x.label === '预付' ? '预付 ' : '欠 '}${money(x.amount)}`}</b>; } },
        ]} />
      </div>
      {returns.length > 0 && (
        <div className="card">
          <div className="card-h"><h2>退货记录</h2><span className="muted small">点单号打开原单的「退货对账」</span></div>
          <Grid id="cust-returns" rowKey={(r) => r.id} rows={returns} columns={[
            { key: 'rt_no', label: '退货单号', w: 150, render: (r) => <b className="mono">{r.rt_no}</b> },
            { key: 'batch_no', label: '批次', w: 130 },
            { key: 'biz_no', label: '原订单', w: 150, render: (r) => <DealChip id={r.deal_id} no={r.biz_no} onOpen={setDrawer} /> },
            { key: 'requested_at', label: '日期', w: 100, render: (r) => dDate(r.requested_at) },
            { key: 'reason', label: '原因', w: 140, render: (r) => `${RETURN_REASONS[r.reason_type]} · ${r.reason}` },
            { key: 'amount', label: '金额', w: 110, render: (r) => money(r.amount) },
            { key: 'status', label: '状态', w: 120, render: (r) => <Pill tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'gray' : 'amber'}>{{ requested: '待审批', approved: '已批准 · 已冲账', rejected: '已驳回' }[r.status]}</Pill> },
          ]} />
        </div>
      )}
      {drawer && <DealDrawer id={drawer} onClose={() => setDrawer(null)} />}
      {cret && <CustomerReturnModal customerId={id} name={b.name} onClose={() => setCret(false)} />}
    </>
  );
}

// 按客户退货 (待改 41): pick a model + total qty → split over this customer's shipped orders, newest first (editable)
function CustomerReturnModal({ customerId, name, onClose }) {
  const { role, toast, refresh } = useApp();
  const { data } = useData(() => q(Q.customerReturnable, [customerId]), [customerId]);
  const [prod, setProd] = useState('');
  const [total, setTotal] = useState('');
  const [split, setSplit] = useState({});
  const [type, setType] = useState('quality');
  const [reason, setReason] = useState(NOTE_OPTIONS.return[0]);
  const [typeNote, setTypeNote] = useState('');
  const [at, setAt] = useState(() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); });
  const [photo, setPhoto] = useState('');
  const [errs, setErrs] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => (data || []).filter((l) => l.product_id === prod), [data, prod]);
  const products = useMemo(() => { const m = new Map(); (data || []).forEach((l) => m.set(l.product_id, `${l.model} · ${l.category}`)); return [...m]; }, [data]);
  const maxOf = (l) => N(l.qty_shipped) - N(l.qty_returned) - N(l.qty_pending);
  const auto = (t, rs = rows) => { let left = N(t); const s = {}; for (const l of rs) { const x = Math.min(left, maxOf(l)); s[l.line_id] = x ? String(x) : ''; left -= x; } setSplit(s); };
  const sum = rows.reduce((a, l) => a + N(split[l.line_id]), 0);
  const cap = rows.reduce((a, l) => a + maxOf(l), 0);
  const submit = async () => {
    if (!prod || !(sum > 0)) return toast('请选型号并填数量', 'err');
    const over = rows.find((l) => N(split[l.line_id]) > maxOf(l)); if (over) return toast(`${over.biz_no} 最多可退 ${maxOf(over)}`, 'err');
    // 和按单退货同一规矩 (11-09 举一反三): 收到货才做, 收到时间 + 实物照片必填; 选「其他」要写清楚
    if (!reason?.trim()) return toast('请选择或填写退货原因', 'err');
    if (type === 'other' && !typeNote.trim()) { setErrs(true); return toast('选了「其他」要写清楚是什么', 'err'); }
    if (!photo) { setErrs(true); return toast('收到退货要拍实物照片（不是盒子）', 'err'); }
    const d = new Date(); const batch = `RB-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const byDeal = {}; rows.forEach((l) => { if (N(split[l.line_id]) > 0) (byDeal[l.deal_id] ||= []).push({ line_id: l.line_id, qty: N(split[l.line_id]) }); });
    setBusy(true); let n = 0;
    try {
      for (const [deal, ls] of Object.entries(byDeal)) { await call(role, `select app.request_return($1,$2,$3,$4,$5,$6,$7)`, [deal, type, type === 'other' ? `其他：${typeNote.trim()} · ${reason}` : reason, JSON.stringify(ls), batch, new Date(at).toISOString(), photo]); n++; }
      toast(`已提交 ${n} 张退货单（批次 ${batch}），等中方审批`); refresh(); onClose();
    } catch (e) { toast(`${n ? `已提交 ${n} 张，` : ''}${friendlyError(e)}`, 'err'); refresh(); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={`按客户退货 · ${name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy} onClick={submit}>提交退货申请（同一批次）</button></>}>
      {!data ? <div className="empty">加载中…</div> : (
        <div className="stack">
          <div className="hint">客户一次退的货分散在几张单里：选型号和总数量，系统按最近出库的单先分摊（可改），一次生成同一批次的几张退货单，各自挂原单原行。</div>
          <div className="row" style={{ gap: 14, alignItems: 'flex-end' }}>
            <div className="field req"><label>型号</label>
              <select className="in" value={prod} onChange={(e) => { setProd(e.target.value); const rs = (data || []).filter((l) => l.product_id === e.target.value); auto(total, rs); }}>
                <option value="">请选择</option>{products.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field req"><label>退货总数量</label><input className="in" inputMode="numeric" style={{ width: 120 }} value={total} onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); setTotal(v); auto(v); }} /></div>
            {prod && <span className="hint">该客户这个型号最多可退 {cap} 件</span>}
          </div>
          {prod && <Grid id="cret-split" noTools rowKey={(l) => l.line_id} rows={rows} columns={[
            { key: 'biz_no', label: '订单', w: 150, render: (l) => <b className="mono">{l.biz_no}</b> },
            { key: 'last_shipped', label: '出库日期', w: 100, render: (l) => dDate(l.last_shipped) },
            { key: 'qty_shipped', label: '出库数量', w: 80 },
            { key: 'unit_price', label: '单价', w: 90, render: (l) => money(l.unit_price, l.currency) },
            { key: 'rq', label: '本次退货数量', w: 120, edit: (l) => ({ type: 'number', value: split[l.line_id] || '', placeholder: '0', invalid: N(split[l.line_id]) > maxOf(l),
              hint: N(split[l.line_id]) > maxOf(l) ? <span className="red-t">最多可退 {maxOf(l)}</span> : null, onChange: (v) => setSplit({ ...split, [l.line_id]: v.replace(/\D/g, '') }) }) },
          ]} foot={() => ({ biz_no: '合计', rq: `${qty(sum)} 件${N(total) && sum !== N(total) ? `（总数 ${total}）` : ''}` })} />}
          <div className="row" style={{ gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field req"><label>收到退货的时间</label><input className="in" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></div>
            <div className="field req"><label>实物照片（不是盒子）</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs && !photo} label="拍退回的货" /></div>
          </div>
          <div className="field req"><label>退货类型</label><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><div className="chips">{Object.entries(RETURN_REASONS).map(([k, v]) => <button type="button" key={k} className={`chip ${type === k ? 'on' : ''}`} onClick={() => setType(k)}>{v}</button>)}</div>
            {type === 'other' && <input className={`in ${errs && !typeNote.trim() ? 'invalid' : ''}`} style={{ width: 260 }} autoFocus value={typeNote} onChange={(e) => setTypeNote(e.target.value)} placeholder="「其他」是什么？（必填）" />}</div></div>
          <div className="field req"><label>具体原因</label><OptionNote options={NOTE_OPTIONS.return} value={reason} onChange={setReason} /></div>
        </div>
      )}
    </Modal>
  );
}
