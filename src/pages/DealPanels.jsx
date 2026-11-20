import { RuleGear } from '../components/Rules.jsx';
import { DocSettings } from '../components/SettingsPanels.jsx';
import { showDone } from '../components/Done.jsx';
import { DocPeek, DocNo } from '../components/DocPeek.jsx';
// The panels of one deal. Each workflow step has its own panel: the action when it is the current step,
// a read-only record once it has been pushed (待改 13). Every button calls exactly one SQL business function.
import { OptChoice, OptNote, OptGear, optName, optSubmit } from '../components/Opts.jsx';
import PeoplePick from '../components/PeoplePick.jsx';
import { fmtPhone, telHref } from '../lib/phone.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Grid from '../components/Grid.jsx';
import { call, q } from '../db/client.js';
import LineEntry, { newKey, finalizeLines, tierPrice, PromoTag } from '../components/LineEntry.jsx';
import { DocActions, DocSheet, BalanceCopy, BalancePreview } from '../components/Doc.jsx';
import { BlActions } from '../components/Bl.jsx';
import { flagAnomaly } from '../components/IssueReport.jsx';
import ReceiptForm, { BalanceLine, VoidReceiptModal, RcvStatus , ReceiptDone } from '../components/ReceiptForm.jsx';
import { Modal, Shared, tierOpt, Pill, CopyButton, copyToClipboard, PhotoInput, Thumb, OptionNote, DatePicker, BigNum, useApp, useData, useHistory, UndoBar, Info, FRow , PhoneInput, phoneValid, Bang, lowTip, Choice, Assumed, MoneyIn, AcctImpact } from '../components/ui.jsx';
import { ImpactFor } from '../components/Impact.jsx';
import PickTicks, { AssignBar } from '../components/PickTicks.jsx';
import { ContactPick, useContacts, rememberContact, contactRole } from '../components/Contacts.jsx';
import { can, whoCan, seesPrice, dealPriceVisible, NOTE_OPTIONS, SHIP_METHODS, PAY_METHODS, RETURN_REASONS, RETURN_BASES, FREIGHT_BASES, CONFIRM_METHODS, CHECK_RESULTS, priceLevel, getThresholds, balanceWords, TIERS } from '../lib/domain.js';
import { money, qty, dt, dDate, today, pad, ymd } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';

const N = (v) => Number(v || 0);
const Blocked = ({ action }) => <span className="lock">当前岗位不能操作，需要：{whoCan(action)}</span>;
const evOf = (events, action) => [...events].reverse().find((e) => e.action === action);
const Who = ({ e }) => (e ? <span className="muted">{e.short_name || '—'} · {dt(e.at)}</span> : null);

// common read-only columns
function baseCols({ price, cur, extra = [] }) {
  return [
    { key: 'code', label: '编码', w: 64, render: (l) => (l.code ? <span className="mono">{l.code}</span> : <Pill tone="amber">未建档</Pill>) },
    { key: 'category', label: '种类', w: 100 },
    { key: 'model', label: '型号', w: 100, render: (l) => <><ModelLink id={l.product_id} model={l.model} /></> },
    { key: 'shared', label: '通用性', w: 150, render: (l) => <Shared list={l.shared_models} /> },
    ...extra,
    ...(price ? [{ key: 'unit_price', label: `单价 ${cur}`, w: 130, render: (l) => <span className="row" style={{ gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>{money(l.unit_price, cur)}<LowTag l={l} />{l.price_manual && <span className="pill amber">手改</span>}<PromoTag l={l} />{l.requested_price != null && <span className="pill amber">申请 {money(l.requested_price, cur)}</span>}</span> }] : []),
  ];
}

// ───────────────────────── ① 报价 ─────────────────────────
export function QuotePanel({ deal, lines, catalog, categories, act, role }) {
  const { toast } = useApp();
  const [edit, setEdit] = useState(null);
  const [errs, setErrs] = useState(false);
  const [priceOk, setPriceOk] = useState(false);
  const price = dealPriceVisible(role, deal);
  const priceMode = can(role, 'quote_price') ? 'direct' : can(role, 'quote_price_request') ? 'request' : null;
  const fxD = deal.currency !== 'XOF' && Number(deal.fx_rate) > 0 ? Number(deal.fx_rate) : null;   // 外币单锁定的汇率
  const pricedD = deal.currency === 'XOF' || !!fxD;
  const cur = deal.currency;
  const editable = ['quoted', 'hotline_ok'].includes(deal.status);
  // 打开这一步就记时间: 未处理报价提醒从 5 分钟一次变 10 分钟一次 (Frank 11-07)
  React.useEffect(() => { if (deal.status === 'quoted' && can(role, 'hotline_confirm')) call(role, `select app.mark_hotline_opened($1)`, [deal.id]).catch(() => {}); }, [deal.id, deal.status, role]);
  const cols = baseCols({ price, cur, extra: [
    { key: 'qty_available', label: '可售', w: 120, render: (l) => (l.product_id ? <span><b style={{ color: N(l.qty_available) < N(l.qty_req) && editable ? 'var(--red)' : '' }}>{qty(l.qty_available)}</b>{editable && N(l.qty_req) > Math.max(N(l.qty_available), 0) && <span className="pill amber" style={{ marginLeft: 4 }} title="差的已自动记进未满足需求">缺 {qty(N(l.qty_req) - Math.max(N(l.qty_available), 0))}</span>}</span> : '—') },
    { key: 'qty_req', label: '需求数量', w: 80, render: (l) => <b>{qty(l.qty_req)}</b> },
  ] });
  if (price) cols.push({ key: 'amount', label: `金额 ${cur}`, w: 110, value: (l) => N(l.qty_req) * N(l.unit_price), render: (l) => <b>{money(N(l.qty_req) * N(l.unit_price), cur)}</b> });
  cols.push({ key: 'note', label: '备注', w: 120 });

  const startEdit = () => {
    const byId = Object.fromEntries(catalog.map((p) => [p.id, p]));
    setEdit(lines.map((l) => ({ key: newKey(), product: l.product_id ? byId[l.product_id] : null, category_id: l.req_category_id, model: l.req_model,
      qty_req: String(l.qty_req), stock_item_id: l.stock_item_id || '', note: l.note || '',
      // 带上原来的手改价 / 申请价, 改单不丢 (以前改单会把中方手改价冲掉)
      unit_price: l.price_manual ? String(N(l.unit_price)) : '', req_price: l.requested_price != null ? String(N(l.requested_price)) : '' })));
    setPriceOk(false);
  };
  const saveEdit = async () => {
    setErrs(true);
    const fin = finalizeLines(edit);
    if (fin.error) return toast(fin.error, 'err');
    if (!fin.lines.length) return toast('至少保留一行；不要了请用「作废订单」', 'err');
    if (fin.lines.some((l) => !(N(l.qty_req) > 0))) return toast('有数量为 0 的行：填数量或删掉', 'err');
    // 中方改价不用审批但要提示; 员工改的是申请价 → 审批
    const changed = fin.lines.filter((l) => l.product && N(l.unit_price) > 0 && N(l.unit_price) !== tierPrice(l, deal.tier, fxD));
    if (changed.length && !priceOk) { setPriceOk(true); return toast(`有 ${changed.length} 行是手改价：${changed.slice(0, 4).map((l) => `${l.product.model} ${money(l.unit_price, cur)}`).join('、')}${changed.length > 4 ? '…' : ''}。核对过再点一次「保存修改」`, 'err'); }
    const payload = fin.lines.map((l) => (l.product ? { product_id: l.product.id, qty_req: N(l.qty_req), stock_item_id: l.stock_item_id || null, note: l.note || null,
        ...(N(l.unit_price) > 0 ? { unit_price: N(l.unit_price) } : {}), ...(N(l.req_price) > 0 ? { requested_price: N(l.req_price) } : {}) }
      : { req_category_id: l.category_id, req_model: l.model, qty_req: N(l.qty_req), note: l.note || null }));
    const req = fin.lines.some((l) => N(l.req_price) > 0 && !(N(l.unit_price) > 0));
    await act(req ? '报价已修改；申请改价已送中方审批，批了才能往下推' : '报价已修改', `select app.edit_quote_fx($1,$2,$3,$4)`, [deal.id, JSON.stringify(payload), lines.map((l) => l.id), fxD]);
    setEdit(null); setErrs(false);
  };

  if (edit) {
    return (
      <div className="card">
        <div className="card-h"><h2>修改报价 <span className="muted small">{deal.quote_no}</span></h2><span className="hint">在原单上增删行、改数量，不用重新开单</span></div>
        <LineEntry id="quote-edit" catalog={catalog} categories={categories} tier={deal.tier} lines={edit} setLines={(v) => { setPriceOk(false); setEdit(v); }} showErrors={errs} showPrice={(price || priceMode === 'request') && pricedD} currency={cur} fx={fxD}
          canPrice={priceMode === 'direct' && pricedD} priceMode={pricedD && deal.status === 'quoted' ? priceMode : priceMode === 'direct' && pricedD ? 'direct' : null} />
        <div className="actionbar"><button type="button" className="btn" onClick={() => setEdit(null)}>放弃修改</button>
          <button type="button" className="btn primary lg" onClick={() => saveEdit().catch(() => {})}>{priceOk ? '改价核对过，保存修改' : '保存修改'}</button></div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-h">
        {/* Frank 11-09 13:42: 改单的放左边标题后, 往外发的 (图片 / 文字 / 打印) 放右边 */}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <h2>报价 · 确认 <span className="muted small mono">{deal.quote_no}</span></h2>
          {editable && can(role, 'quote') && <button type="button" className="btn" onClick={startEdit}>✎ 修改报价（增删行）</button>}
        </div>
        <div className="row">
          {price && (deal.approval === 'pending' && (deal.approval_reasons || []).some((x) => String(x).startsWith('申请特价'))
            ? <span className="why">改价等中方批完，才能复制报价图片</span>
            : <DocActions kind="quote" deal={deal} lines={lines} copyLabel="复制报价图片" primary="copy" />)}
        </div>
      </div>
      <Grid id="deal-quote" slimTools table="deal_lines" columns={cols} rows={lines} rowClass={(l) => (!l.product_id ? 'manual' : '')}
        foot={(rows) => ({ code: '合计', model: `${rows.length} 个型号`, qty_req: `${qty(rows.reduce((a, l) => a + N(l.qty_req), 0))} 件`,
          amount: `${money(rows.reduce((a, l) => a + N(l.qty_req) * N(l.unit_price), 0), cur)} ${cur}` })} />
      {lines.some((l) => !l.product_id) && <div className="card-b hint">黄色行 = 我们没建档的型号：单价 0、不会出货，已自动记入「未满足需求」。</div>}
      {editable && <div className="card-b hint" style={{ borderTop: '1px solid var(--line-2)' }}>下推找货之前都可以在原单上改；下推之后这一页只读，要改请先「撤回到上一步」。</div>}
    </div>
  );
}

// 减法巡检 C4 (11-17): 作废不再是页面上的红色大按钮, 入口在订单页流程条的「⋯ 更多」里
export function CancelModal({ deal, act, onClose }) {
  const [reason, setReason] = useState('客户不要了');
  return (
    <Modal title={`作废 ${deal.biz_no}`} risk={deal.pick_no ? 'red' : 'yellow'} onClose={onClose}
        footer={<><button type="button" className="btn" onClick={onClose}>不作废</button>
          <button type="button" className="btn primary" onClick={() => act(['picked', 'ordered', 'confirmed', 'reviewed'].includes(deal.status) ? '已作废：请把已拿出的货放回原库位（预占已释放）' : '订单已作废，预占已释放（可在「订单总览 → 已作废」恢复）', `select app.cancel_deal($1,$2)`, [deal.id, reason]).then(onClose, () => {})}>确认作废</button></>}>
        <div className="stack">
          <div className="hint">作废不是删除：单子进「已作废」列表，随时可以恢复。</div>
          <OptNote optKey="note_cancel" title="作废原因" options={['客户不要了', '价格谈不拢', '重复下单', '没货', '其他']} value={reason} onChange={setReason} />
        </div>
      </Modal>
  );
}

// ───────────────────────── ① 下半: 确认 (Frank 11-08: 报价 + 热线确认合为一步; 谁能建报价谁能确认, 主管兼热线) ─────────────────────────
// 客户信息卡 (确认 / 签收共用, Frank 11-09: 签收也要有电话方便打)
export function CustomerInfo({ deal }) {
  // 左栏客户信息竖排 (11-09 195): 打电话前一眼看全
  const { role } = useApp();
  const phone = deal.customer_phone || '';
  const tel = (p) => (p ? <span className="tel"><a href={telHref(p)}>{fmtPhone(p)}</a><CopyButton text={fmtPhone(p)} what="电话" /></span> : <span className="muted">—</span>);
  const contacts = (Array.isArray(deal.customer_contacts) ? deal.customer_contacts : []).filter((c) => c?.phone && String(c.phone).replace(/\D/g, '') !== String(phone).replace(/\D/g, '')).slice(0, 3);
  return (
    <div className="panel info">
      {/* 340 (Frank 11-17): 四小块 —— 客户 / 收货人 (客户那边接货的人) / 销售员 (我们的人) / 欠款; 三个电话分开, 各自可复制 */}
      <div className="info4">
        <div className="info4-b"><div className="info4-t">客户</div>
          <div><CustLink id={deal.customer_id} name={deal.customer_name} /> <span className="mono muted small">{deal.customer_code || deal.temp_code}</span></div>
          <div className="small muted">{deal.city || '—'}</div>
          <div>{tel(phone)}</div>
          {deal.source === 'guest' && <div><Pill tone="amber">游客询价</Pill> {deal.guest_info?.shop || ''}</div>}
        </div>
        <div className="info4-b"><div className="info4-t">收货人</div>
          <div>{deal.customer_contact || <span className="muted">—</span>}</div>
          {contacts.map((c) => <div key={c.phone} className="small">{c.name ? `${c.name} · ` : ''}{tel(c.phone)}</div>)}
          {!contacts.length && !deal.customer_contact && <div className="small muted">档案里还没填</div>}
        </div>
        <div className="info4-b"><div className="info4-t">销售员</div>
          <div>{deal.owner_name || <span className="muted">没有归属</span>}</div>
          {deal.owner_phone && <div>{tel(deal.owner_phone)}</div>}
        </div>
        {seesPrice(role) && <div className="info4-b"><div className="info4-t">客户欠款</div>
          <div style={{ color: Number(deal.customer_balance) > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 700 }}>{Number(deal.customer_balance) > 0 ? `${money(deal.customer_balance)} XOF` : '没有欠款'}</div>
        </div>}
      </div>
    </div>);
}

export function ConfirmBlock({ deal, events, act, role, lines }) {
  const { go: nav } = useApp();
  const [split, setSplit] = useState(false);
  const [method, setMethod] = useState('');
  const [when, setWhen] = useState('');          // today / tomorrow / date
  const [date, setDate] = useState('');
  const [note, setNote] = useState(NOTE_OPTIONS.hotline[0]);
  const [proof, setProof] = useState('');
  const [errs, setErrs] = useState(false);
  const e = evOf(events, 'hotline_confirmed');
  const phone = deal.customer_phone || '';
  const info = <CustomerInfo deal={deal} />;
  if (deal.status !== 'quoted') {
    const canPush = deal.status === 'hotline_ok' && can(role, 'start_picking');
    return (
      <div className="card">
        <div className="card-h"><h2>客户确认记录</h2><Who e={e} /></div>
        <div className="card-b kv">
          <div><div className="k">确认方式</div><div className="v">{CONFIRM_METHODS[deal.hotline_method] || '（未记录）'}</div></div>
          <div><div className="k">客户什么时候要</div><div className="v">{deal.want_on ? dDate(deal.want_on) : '—'}</div></div>
          <div><div className="k">备注</div><div className="v" style={{ fontSize: 15 }}>{e?.detail?.note || '—'}</div></div>
          <div><div className="k">截图（可选）</div><div className="v">{deal.hotline_proof ? <Thumb src={deal.hotline_proof} size={56} label="确认截图" /> : <span className="muted small">未传</span>}</div></div>
        </div>
        {deal.status === 'hotline_ok' && (
          <div className="actionbar"><span className="hint">客户已确认，还没下推找货。{deal.want_on ? `客户要货日期 ${dDate(deal.want_on)}，到那天待办会自动前移。` : ''}</span>
            {canPush && (lines || []).length > 1 && <button type="button" className="btn" onClick={() => setSplit(true)}>拆单：一部分以后再发</button>}
            {canPush ? <button type="button" className="btn primary lg" onClick={() => act('已下推找货，库存已预占', `select app.start_picking($1)`, [deal.id]).catch(() => {})}>下推找货 · 初检 →</button> : <Blocked action="start_picking" />}</div>)}
        {split && <SplitModal deal={deal} lines={lines} act={act} onClose={() => setSplit(false)} />}
      </div>
    );
  }
  if (deal.status === 'quoted' && deal.tier_pending) return <TierGate deal={deal} info={info} act={act} role={role} />;
  if (deal.approval === 'pending') return <div className="card"><div className="card-h"><h2>联系客户确认</h2></div><div className="card-b two">{info}<div className="panel"><span className="why">等中方审批（上面黄条），批了才能确认、下推找货</span></div></div></div>;
  const wantOn = when === 'today' ? today() : when === 'tomorrow' ? ymd(new Date(Date.now() + 864e5)) : when === 'date' ? date : null;
  const go = async () => {
    setErrs(true);
    if (!method || !when || (when === 'date' && !date)) return;
    const push = when === 'today';
    await act(push ? '已确认并下推找货，库存已预占' : '已确认，到客户要货那天待办会前移', `select app.quote_confirm($1,$2,$3,$4,$5,$6)`, [deal.id, note || null, method, proof || null, wantOn, push]).then(() => { if (!push) nav('todo'); }, () => {});   // 235: 改天要的先放一放 → 回待办
  };
  return (
    <div className="card">
      <div className="card-h"><h2>联系客户确认 <Info>报价单在上面，核对好了再打。今天要 → 确认的同时预占库存、下推找货；明天 / 改天 → 先记下，到那天待办自动前移，再点「下推找货」。客户不要了 → 上面「作废订单」。这里截图不强制，真正要凭证的是「客户最终确认」。</Info></h2>
        {deal.hotline_busy_at && <span className="small muted">上次 {dt(deal.hotline_busy_at)} 记过「客户忙」{deal.hotline_busy_note ? `：${deal.hotline_busy_note}` : ''}</span>}</div>
      <div className="card-b two">
        {info}
        {can(role, 'hotline_confirm') ? (
          <div className="panel">
            <div className="fgrid">
              <FRow label="确认方式" req><OptChoice optKey="confirm_methods" title="确认方式" value={method} onChange={(k) => setMethod(k)} options={Object.entries(CONFIRM_METHODS)} err={errs && !method} /></FRow>
              <FRow label="什么时候要" req><Choice value={when} onChange={(k) => setWhen(k)} options={[['today', '今天要'], ['tomorrow', '明天要'], ['date', '改天']]} err={errs && !when} />
                {when === 'date' && <DatePicker value={date || null} onChange={setDate} label={date ? '' : '选日期'} />}</FRow>
              <FRow label="结果"><OptNote optKey="note_hotline" title="确认结果" options={NOTE_OPTIONS.hotline} value={note} onChange={setNote} /></FRow>
              <FRow label="截图"><PhotoInput value={proof} onChange={setProof} label="WhatsApp 截图（可选）" /></FRow>
            </div>
            <div className="actbar">
              <button type="button" className="btn" title="客户现在忙、没法确认：单子留在这一步、进待办，提醒照旧" onClick={() => act(`已记下：${deal.customer_name} 这张单稍后再联系（30 分钟后提醒）`, `select app.hotline_busy($1,$2)`, [deal.id, note || null]).then(() => nav('todo'), () => {})}>客户现在忙，稍后再联系</button>
              <button type="button" className="btn primary lg" onClick={go}>{when === 'today' ? '确认 → 下推找货' : '确认 →'}</button>
            </div>
          </div>
        ) : <div className="panel"><Blocked action="hotline_confirm" /></div>}
      </div>
    </div>
  );
}

// ───────────────────────── ② 找货 · 初检 (Frank 11-08 合为一步: 预占在确认时已做, 找货人进来就填实际供货 + 拍照 + 提交) ─────────────────────────
export function PickPanel({ deal, lines, employees, events, act, role }) {
  const part = 'picked';
  const { toast, org } = useApp();
  const before = ['quoted', 'hotline_ok'].includes(deal.status);
  const picking = deal.status === 'picking';
  // 找货人候选: 中方在 ⚙ 里勾 (Frank 11-09 第 12 条), 不自动匹配
  const [picker, setPicker] = useState('');
  const [photo, setPhoto] = useState('');
  const [dup, setDup] = useState([]);
  const [actual, setActual] = useState({}); // line_id -> {qty, reason}
  const h = useHistory(actual, setActual);
  const scope = useRef();
  const [errs, setErrs] = useState(false);
  const real = lines.filter((l) => l.product_id);
  const get = (l) => actual[l.id] || { qty: String(l.qty_supply), reason: '' };
  const set = (l, patch, what) => h.commit({ ...actual, [l.id]: { ...get(l), ...patch } }, `${l.model} ${what}`);

  if (before) {
    return (
      <div className="card">
        <div className="card-h"><h2>找货 · 初检</h2></div>
        <div className="card-b hint">还没下推：先在「报价 · 确认」里确认客户要货并下推，库存预占后找货人在这里填实际供货、拍照、提交初检。</div>
      </div>
    );
  }

  // 398 / 399: 找货中 = 派人 + 打勾找货 (手机 / 电脑同一个页面); 提交后销售订单自动生成 (397)
  if (picking) {
    return (
      <div className="card">
        <div className="card-h"><h2>找货 · 初检 <span className="muted small mono">{deal.pick_no}</span></h2>
          <div className="row"><DocActions kind="pick" deal={deal} lines={real} hideCopy printLabel="打印找货单" /></div></div>
        <AssignBar deal={deal} employees={employees} role={role} />
        <PickTicks deal={deal} lines={lines} employees={employees} role={role} act={act} />
      </div>);
  }
  const showPicked = !picking;
  const cols = [
    ...baseCols({ price: false }),
    { key: 'warehouse', label: '仓库', w: 50 },
    { key: 'bin', label: '库位', w: 70, render: (l) => <b>{l.bin}</b> },
    { key: 'qty_req', label: '需求数量', w: 70, render: (l) => qty(l.qty_req) },
    { key: 'qty_reserved_line', label: '预占数量', w: 70, value: (l) => (picking ? l.qty_supply : l.qty_picked ?? l.qty_supply), render: (l) => qty(picking ? l.qty_supply : (l.qty_picked ?? l.qty_supply)) },
    { key: 'qty_supply', label: '实际供货', w: 100, ...(picking && part === 'picked'
      ? { edit: (l) => ({ type: 'number', value: get(l).qty, invalid: errs && (N(get(l).qty) > N(l.qty_supply)), onChange: (v) => set(l, { qty: v.replace(/\D/g, '') }, '改实际供货') }) }
      : { value: (l) => (showPicked ? l.qty_picked ?? l.qty_supply : l.qty_supply), render: (l) => { const v = showPicked ? l.qty_picked ?? l.qty_supply : null; return v == null ? '' : <b style={{ color: N(v) < N(l.qty_req) ? 'var(--red)' : 'var(--green)' }}>{qty(v)}</b>; } }) },
    { key: 'diff', label: '差异原因', w: 150, ...(picking && part === 'picked'
      ? { edit: (l) => (N(get(l).qty) < N(l.qty_supply) ? { type: 'select', value: get(l).reason, invalid: errs && !get(l).reason,
          options: [['', '请选原因'], ...NOTE_OPTIONS.diff.map((x) => [x, x])], onChange: (v) => set(l, { reason: v }, '选差异原因') } : null), render: () => '' }
      : { render: (l) => (showPicked ? l.diff_reason || (N(l.qty_supply) < N(l.qty_req) ? '库存不足' : '') : '') }) },
  ];
  const submit = async () => {
    setErrs(true);
    if (!picker) return toast('请选择找货人', 'err');
    if (!photo) return toast('请拍一张找货现场照片', 'err');
    const changes = [];
    for (const l of real) {
      const a = get(l);
      if (N(a.qty) > N(l.qty_supply)) return toast(`${l.model} 实际供货不能超过预占；要加货请走「出库前追加」`, 'err');
      if (N(a.qty) < N(l.qty_supply)) { if (!a.reason) return toast(`${l.model} 少了 ${N(l.qty_supply) - N(a.qty)} 件，请选差异原因`, 'err'); changes.push({ line_id: l.id, qty: N(a.qty), reason: a.reason }); }
    }
    await act('初检已提交，可以出销售订单', `select app.submit_pick($1,$2,$3,$4)`, [deal.id, picker, photo, JSON.stringify(changes)]).then(() => dup.length && flagAnomaly(role, org, deal.id, 'pick', `找货照片和 ${dup.join('、')} 是同一张图，请核实是不是拍了旧图`), () => {});
  };
  const e = evOf(events, 'pick_submitted');

  return (
    <div className="card" ref={scope}>
      <div className="card-h">
        <h2>找货 · 初检 <span className="muted small mono">{deal.pick_no}</span></h2>
        <div className="row">{picking && part === 'picked' && <UndoBar h={h} scope={scope} />}<DocActions kind="pick" deal={deal} lines={real} hideCopy printLabel="打印找货单" primary="print" /></div>
      </div>
      <Grid id="deal-pick" slimTools table="deal_lines" columns={cols} rows={real} rowClass={(l) => (N(l.qty_supply) < N(l.qty_req) ? 'warn' : '')}
        foot={(rows) => ({ code: '合计', model: `${rows.length} 个型号`, qty_req: `${qty(rows.reduce((a, l) => a + N(l.qty_req), 0))} 件`,
          qty_supply: picking && part === 'picked' ? `${qty(rows.reduce((a, l) => a + N(get(l).qty), 0))} 件` : showPicked ? `${qty(rows.reduce((a, l) => a + N(l.qty_picked ?? l.qty_supply), 0))} 件` : '' })} />
      {picking && part === 'picked' && (
        <div className="card-b" style={{ borderTop: '1px solid var(--line-2)' }}>
          {can(role, 'submit_pick') ? (
            <div className="row" style={{ gap: 18, alignItems: 'flex-end' }}>
              <PeoplePick step="pick" label="找货人" employees={employees} value={picker} onChange={setPicker} errs={errs} />
              <div className="field req"><label>找货照片（货摆在地上拍；相机坏了可从图库选或粘贴 WhatsApp 截图）</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs} label="拍找货照片" onDup={setDup} /></div>
              <span className="grow" />
              <button type="button" className="btn primary lg" onClick={submit}>初检完成，出销售订单 →</button>
            </div>
          ) : <Blocked action="submit_pick" />}
          <div className="hint" style={{ marginTop: 8 }}>库存已预占。按库位拿货，<b>只集中放一堆、不打包</b>（打包在主管复检那步）；实际供货默认 = 预占数量，少了就改数字并选原因，多出来的预占会自动释放。</div>
        </div>
      )}
      {showPicked && deal.picker_name && (
        <div className="card-b row" style={{ borderTop: '1px solid var(--line-2)', gap: 16 }}>
          <span>找货人：<b><EmpLink id={deal.picker_employee_id} name={deal.picker_name} /></b></span>
          <Thumb src={deal.pick_photo_path} size={64} label={`${deal.biz_no} 找货照片`} group={[{ src: deal.pick_photo_path, label: '找货照片' }, { src: deal.review_photo_path, label: '复核照片' }]} />
          <Who e={e} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── ⑤ 主管复核（复核人 + 照片 + 复核数量 + 抽检）─────────────────────────
export function ReviewPanel({ deal, lines, employees, events, act, role }) {
  const { toast, org, go: navTo } = useApp();
  const real = lines.filter((l) => l.product_id && N(l.qty_supply) > 0);
  const reviewing = deal.status === 'confirmed';
  // 236 (Frank 11-11): 约定发货日还没到 → 先不复检打包 (免得客户第二天加货白打包), 仓管把货放暂存位置; 到那天再从头检到尾
  const hold = reviewing && deal.planned_ship_date && dDate(deal.planned_ship_date) > today();
  const [early, setEarly] = useState(false);
  const [stagePhoto, setStagePhoto] = useState(''); const [stageNote, setStageNote] = useState('');
  const [reviewer, setReviewer] = useState('');   // 复核人候选: 中方在 ⚙ 里勾 (第 15 条)
  const [photo, setPhoto] = useState('');
  const [dup, setDup] = useState([]);
  const [rv, setRv] = useState({}); // line -> {qty, reason, check, note}
  const [numFor, setNumFor] = useState(null); const [numVal, setNumVal] = useState('');
  const h = useHistory(rv, setRv);
  const scope = useRef();
  const [errs, setErrs] = useState(false);
  const get = (l) => rv[l.id] || { qty: String(l.qty_supply), reason: '', check: '', note: '', act: '', fphoto: '' };
  const set = (l, patch, what) => h.commit({ ...rv, [l.id]: { ...get(l), ...patch } }, `${l.model} ${what}`);
  // 403 / 404 (Frank 11-18): 复检数量 = 复核人实点数 (可以比该有的多, 也可以少). 不一样的行必须当场处理完才能完成:
  //   多了 → 放回货架 + 拍照; 少了 → 补上 + 拍照, 或真没货 → 少发 (原因, 客户重新确认). 最终打包数系统算, 出库就按它.
  const diffOf = (l) => N(get(l).qty) - N(l.qty_supply);
  const finalOf = (l) => { const a = get(l); const dq = diffOf(l); return dq > 0 ? N(l.qty_supply) : dq < 0 && a.act === 'less' ? N(a.qty) : N(l.qty_supply); };
  const fixOk = (l) => { const a = get(l); const dq = diffOf(l); return dq === 0 || (dq > 0 ? !!a.fphoto : a.act === 'refill' ? !!a.fphoto : a.act === 'less' ? !!a.reason : false); };
  // suggested spot checks: biggest quantities, highest value, or every line when this picker made mistakes lately
  const suggest = useMemo(() => {
    const s = new Map();
    const byQty = [...real].sort((a, b) => N(b.qty_supply) - N(a.qty_supply)).slice(0, 2);
    const byVal = [...real].sort((a, b) => N(b.qty_supply) * N(b.unit_price || b.tier_price) - N(a.qty_supply) * N(a.unit_price || a.tier_price)).slice(0, 1);
    byQty.forEach((l) => N(l.qty_supply) >= 20 && s.set(l.id, '数量大'));
    byVal.forEach((l) => s.set(l.id, s.has(l.id) ? s.get(l.id) + ' · 金额高' : '金额高'));
    if (N(deal.picker_errors) > 0) real.forEach((l) => !s.has(l.id) && s.set(l.id, `找货员近 30 天错 ${deal.picker_errors} 次`));
    return s;
  }, [real, deal.picker_errors]);
  // 347 (Frank 11-17): 必抽检 —— 一行 数量 > 100 片 / 单价 > 5,000 / 总价 > 500,000 (三个数在规则参数里调) → 必须选抽检结果才能完成
  const { data: ck } = useData(async () => { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = 'check_rules'`, [org]); return { qty: 100, price: 5000, total: 500000, ...(r?.value || {}) }; }, [org]);
  const must = useMemo(() => {
    const m = new Map(); if (!ck) return m;
    const k = deal.currency === 'XOF' ? 1 : N(deal.fx_rate) || 0;
    real.forEach((l) => { const n = N(l.qty_supply), pr = N(l.unit_price || l.tier_price) * k; const why = [];
      if (n > N(ck.qty)) why.push('数量大'); if (k && pr > N(ck.price)) why.push('单价高'); if (k && n * pr > N(ck.total)) why.push('金额高');
      if (why.length && n > 0) m.set(l.id, why.join(' · ')); });
    return m;
  }, [real, ck, deal.currency, deal.fx_rate]);

  const e = evOf(events, 'pick_reviewed');
  const cols = [
    ...baseCols({ price: false }),
    { key: 'bin', label: '库位', w: 70 },
    { key: 'qty_picked', label: '订单数量', w: 80, value: (l) => l.qty_supply, render: (l) => qty(l.qty_supply) },
    { key: 'rqty', label: reviewing ? '实点数' : '复检数量', w: 100, ...(reviewing
      ? { edit: (l) => ({ type: 'number', value: get(l).qty, invalid: errs && !fixOk(l), title: '实点数和该有的不一样，在表格下面处理', onChange: (v) => set(l, { qty: v.replace(/\D/g, ''), act: '', fphoto: '', reason: '' }, '改实点数') }) }
      : { value: (l) => l.qty_supply, render: (l) => <b style={{ color: N(l.qty_supply) < N(l.qty_picked ?? l.qty_supply) ? 'var(--red)' : 'var(--green)' }}>{qty(l.qty_supply)}</b> }) },
    ...(reviewing ? [{ key: 'rfinal', label: '最终打包数', w: 100, type: 'number', value: (l) => finalOf(l), render: (l) => { const dq = diffOf(l); return <b style={{ color: !fixOk(l) ? 'var(--red)' : dq !== 0 ? '#b45309' : 'var(--green)' }}>{fixOk(l) ? qty(finalOf(l)) : '要处理'}</b>; } }]
      : [{ key: 'rreason', label: '复检差异原因', w: 130, render: (l) => (l.diff_reason?.startsWith('复') ? l.diff_reason : '') }]),
    { key: 'suggest', label: '抽检', w: 120, render: (l) => (must.has(l.id) ? <Pill tone="red">必抽检 · {must.get(l.id)}</Pill> : suggest.has(l.id) ? <Pill tone="amber">建议 · {suggest.get(l.id)}</Pill> : '') },
    { key: 'check', label: '抽检结果', w: 130, ...(reviewing
      ? { edit: (l) => ({ type: 'select', value: get(l).check, invalid: errs && ((must.has(l.id) && !get(l).check) || (get(l).check && get(l).check !== 'ok' && !get(l).note && N(get(l).qty) === N(l.qty_supply))),
          options: [['', '未抽检'], ...Object.entries(CHECK_RESULTS)], onChange: (v) => set(l, { check: v }, '抽检') }) }
      : { render: (l) => (l.checks?.length ? l.checks.map((c, i) => <Pill key={i} tone={c.result === 'ok' ? 'green' : 'red'}>{CHECK_RESULTS[c.result]}{c.note ? ` · ${c.note}` : ''}</Pill>) : <span className="muted small">未抽检</span>) }) },
    ...(reviewing ? [{ key: 'cnote', label: '抽检说明', w: 140, edit: (l) => (get(l).check && get(l).check !== 'ok' ? { type: 'text', value: get(l).note, placeholder: '有问题必写', onChange: (v) => set(l, { note: v }, '抽检说明') } : null), render: () => '' }] : []),
  ];
  const submit = async () => {
    setErrs(true);
    if (!reviewer) return toast('请选复核人', 'err');
    if (!photo) return toast('请拍打包照片', 'err');
    const fixes = []; const checks = []; let less = 0;
    for (const l of real) {
      const a = get(l); const dq = diffOf(l);
      if (a.qty === '') return toast(`${l.model} 实点数没填`, 'err');
      if (!a.seen && dq === 0) return toast(`还有没核的行：${real.filter((x) => !get(x).seen && diffOf(x) === 0).slice(0, 4).map((x) => x.model).join('、')}（点整行 = 数过了）`, 'err');
      if (!fixOk(l)) return toast(dq > 0 ? `${l.model} 多了 ${dq} 片：放回货架并拍照` : `${l.model} 少了 ${-dq} 片：选「补上」（拍照）还是「少发」（写原因）`, 'err');
      if (dq !== 0) { fixes.push({ line_id: l.id, counted: N(a.qty), action: dq > 0 ? 'put_back' : a.act, photo: a.fphoto || null, reason: a.reason || null }); if (dq < 0 && a.act === 'less') less += 1; }
      if (must.has(l.id) && N(a.qty) > 0 && !a.check) return toast(`${l.model} 必须抽检（${must.get(l.id)}）：抽 2–3 盒，选抽检结果`, 'err');
      if (a.check) {
        if (a.check !== 'ok' && !a.note && dq === 0) return toast(`${l.model} 抽检有问题：改实点数或写说明`, 'err');
        checks.push({ line_id: l.id, result: a.check, note: a.note || null });
      }
    }
    await act(less ? '复检有少发：已退回，请客户重新确认变动的行' : '复检打包完成，可以出库', `select app.review_pick_fixed($1,$2,$3,$4,$5)`, [deal.id, reviewer, photo, JSON.stringify(fixes), JSON.stringify(checks)]).then(() => dup.length && flagAnomaly(role, org, deal.id, 'ship', `打包照片和 ${dup.join('、')} 是同一张图，请核实`), () => {});
  };
  if (hold && !early) {
    return (
      <div className="card">
        <div className="card-h"><h2>复检 + 打包 <Info>约定发货日还没到的单不提前打包：客户第二天可能加货。到了那天再从头检到尾。</Info> <RuleGear title="必抽检的线" ids={['check.qty', 'check.price', 'check.total']} /></h2>
          <span className="pill amber">约 {dDate(deal.planned_ship_date)} 发货 · 先不打包</span></div>
        <div className="card-b stack">
          {deal.staged_at ? (
            <div className="kv">
              <div><div className="k">暂存位置</div><div className="v"><span className="pill green">已放好</span> {dt(deal.staged_at)}</div></div>
              <div><div className="k">放在哪</div><div className="v" style={{ fontSize: 15 }}>{deal.staged_note || '—'}</div></div>
              <div><div className="k">照片</div><div className="v">{deal.staged_photo && <Thumb src={deal.staged_photo} size={56} label="暂存位置照片" />}</div></div>
            </div>
          ) : can(role, 'review_pick') || role === 'picker' ? (
            <div className="panel">
              <div className="hint">把这单的货集中放到暂存位置，<b>不要打包</b>。放好后拍一张照片，写一下放在哪。</div>
              <div className="fgrid">
                <FRow label="放在哪" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={stageNote} onChange={(ev) => setStageNote(ev.target.value)} placeholder="例如 门口第二排架子（交接的人靠这句话找货）" /></FRow>
                <FRow label="照片" req><PhotoInput value={stagePhoto} onChange={setStagePhoto} label="拍放好的那一堆货" /></FRow>
              </div>
              <div className="actbar">{(!stagePhoto || !stageNote.trim()) && <span className="why">还差：{[!stageNote.trim() && '放在哪', !stagePhoto && '照片'].filter(Boolean).join('、')}</span>}<button type="button" className="btn primary" disabled={!stagePhoto || !stageNote.trim()} onClick={() => act('已记：货放在暂存位置，等发货那天复检', `select app.mark_staged($1,$2,$3)`, [deal.id, stagePhoto, stageNote.trim()]).then(() => navTo('todo'), () => {})}>已放到暂存位置 ✓</button></div>
            </div>
          ) : <div className="hint">等仓管把货放到暂存位置。</div>}
          {can(role, 'review_pick') && <div className="row"><span className="small muted">客户改主意要提前发？</span><button type="button" className="btn sm" onClick={() => setEarly(true)}>现在就复检打包</button></div>}
        </div>
      </div>
    );
  }
  return (
    <div className="card" ref={scope}>
      <div className="card-h"><h2>复检 + 打包 <Info>客户确认后由主管抽检、打包；打完包出发货文件，再出库</Info> <RuleGear title="必抽检的线" ids={['check.qty', 'check.price', 'check.total']} /></h2>
        <div className="row">{reviewing ? <UndoBar h={h} scope={scope} /> : <Who e={e} />}</div></div>
      {reviewing && can(role, 'review_pick') ? (
        <div className="card-b ticks">
          {/* 399 (Frank 11-18): 复检和找货同一套手机操作 —— 整行就是按钮, 点一下 = 数过了、数量对; 不对就按 − / ＋ 改成实点数; 必抽检的行单独标红, 不选抽检结果勾不上 */}
          <div className="ticks-top"><div className="ticks-prog"><i style={{ width: `${real.length ? (real.filter((l) => get(l).seen).length / real.length) * 100 : 0}%` }} /></div>
            <b>已核 {real.filter((l) => get(l).seen).length} / {real.length} 行</b><span className="grow" />
            <Info>点整行 = 这一行数过了、数量对（变绿），再点一下取消。数量不对就按 − / ＋ 改成你实际数到的数（可以比该有的多），下面会出现怎么处理。红色「必抽检」的行要先选抽检结果才勾得上。</Info></div>
          {[...real].sort((x, y) => (!!get(x).seen - !!get(y).seen) || (must.has(y.id) - must.has(x.id)) || String(x.bin || '~').localeCompare(String(y.bin || '~'), 'zh-CN', { numeric: true })).map((l) => { const a = get(l); const dq = diffOf(l); const mu = must.has(l.id); const sg = suggest.has(l.id); const bad = a.check && a.check !== 'ok';
            const tap = () => { if (a.seen) return set(l, { seen: false }, '取消已核'); if (a.qty === '') return toast(`${l.model} 实点数没填`, 'err'); if (mu && N(a.qty) > 0 && !a.check) return toast(`${l.model} 必须抽检（${must.get(l.id)}）：抽 2–3 盒，先选抽检结果`, 'err'); if (navigator.vibrate) navigator.vibrate(15); set(l, { seen: true }, '已核'); };
            const step = (d) => set(l, { qty: String(Math.max(0, N(a.qty) + d)), act: '', fphoto: '', reason: '', seen: false }, '改实点数');
            return (
              <div key={l.id} className={`tick-row ${a.seen ? 'done' : ''} ${dq !== 0 ? 'short' : ''} ${mu && !a.seen ? 'must' : ''}`}>
                <button type="button" className="tick-main" onClick={tap} aria-pressed={!!a.seen}>
                  <span className="tick-box">{a.seen ? '✓' : ''}</span>
                  <span className="tick-info"><b className="tick-model">{l.model}</b><span className="tick-sub">{l.category} · {l.code} · 该有 {qty(l.qty_supply)} 片{dq !== 0 ? ` · ${dq > 0 ? '多' : '少'} ${qty(Math.abs(dq))}` : ''}</span></span>
                  <span className="tick-bin">{l.warehouse}<b>{l.bin || '—'}</b></span>
                </button>
                <span className="tick-qty">
                  <button type="button" className="step" disabled={N(a.qty) <= 0} onClick={() => step(-1)} aria-label="少一片">−</button>
                  <button type="button" className="num" title="点这里直接输入实点数" onClick={() => setNumFor(l)}>{qty(a.qty)}<small>/ {qty(l.qty_supply)}</small></button>
                  <button type="button" className="step" onClick={() => step(1)} aria-label="多一片">＋</button>
                </span>
                {(mu || sg || a.check) && <div className="tick-why">
                  <span className={`pill ${mu ? 'red' : 'amber'}`}>{mu ? `必抽检 · ${must.get(l.id)}` : sg ? `建议抽检 · ${suggest.get(l.id)}` : '抽检'}</span>
                  {Object.entries(CHECK_RESULTS).map(([k, n]) => <button type="button" key={k} className={`chip ${a.check === k ? 'on' : ''} ${errs && mu && !a.check ? 'err' : ''}`} onClick={() => set(l, { check: a.check === k ? '' : k, seen: false }, '抽检')}>{n}</button>)}
                  {bad && <input className={`in ${errs && !a.note && dq === 0 ? 'err-in' : ''}`} style={{ flex: '1 1 160px', minWidth: 0 }} value={a.note} onChange={(ev) => set(l, { note: ev.target.value }, '抽检说明')} placeholder="哪里有问题（必写）" />}
                </div>}
              </div>); })}
          {numFor && <Modal title={`${numFor.model} 实际数到几片`} onClose={() => setNumFor(null)} footer={<><button type="button" className="btn" onClick={() => setNumFor(null)}>取消</button><button type="button" className="btn primary" onClick={() => { set(numFor, { qty: String(N(numVal)), act: '', fphoto: '', reason: '', seen: false }, '改实点数'); setNumFor(null); setNumVal(''); }}>好</button></>}>
            <div className="stack"><input className="in" inputMode="numeric" autoFocus style={{ fontSize: 28, fontWeight: 700, textAlign: 'center', height: 64 }} value={numVal} onChange={(ev) => setNumVal(ev.target.value.replace(/\D/g, ''))} placeholder={String(get(numFor).qty)} />
              <div className="small muted" style={{ textAlign: 'center' }}>该有 {qty(numFor.qty_supply)} 片；数到多少填多少（多了少了下面会让你处理）</div></div>
          </Modal>}
        </div>
      ) : (
      <Grid id="deal-review" slimTools table="deal_lines" columns={cols} rows={real} rowClass={(l) => (suggest.has(l.id) && reviewing ? 'suggest' : '')}
        foot={(rows) => ({ code: '合计', qty_picked: `${qty(rows.reduce((a, l) => a + N(l.qty_picked ?? l.qty_supply), 0))} 件`,
          rqty: `${qty(rows.reduce((a, l) => a + N(reviewing ? get(l).qty : l.qty_supply), 0))} 件` })} />)}
      {reviewing && real.some((l) => diffOf(l) !== 0) && (
        <div className="card-b fix-list" style={{ borderTop: '1px solid var(--line-2)' }}>
          <div className="pd-h" style={{ marginBottom: 2 }}>数量不对的行：当场处理完才能完成 <Info>多了就原路放回货架；少了就去拿来补上；真没货才少发（客户要重新确认）。每一笔都要拍照 / 写原因，记在这张单的复检记录里，并记一次找货出错。</Info></div>
          {real.filter((l) => diffOf(l) !== 0).map((l) => { const a = get(l); const dq = diffOf(l); return (
            <div key={l.id} className={`fix-row ${fixOk(l) ? 'ok' : ''}`}>
              <div className="fix-h"><b>{l.model}</b> <span className="small muted">{l.category} · 该有 {qty(l.qty_supply)} · 实点 {qty(a.qty)}</span> <span className={`pill ${dq > 0 ? 'amber' : 'red'}`}>{dq > 0 ? `多了 ${qty(dq)} 片` : `少了 ${qty(-dq)} 片`}</span>{fixOk(l) && <span className="pill green">最终打包 {qty(finalOf(l))} 片</span>}</div>
              {dq > 0 ? (
                <div className="fix-b"><span className="small">把多的 <b>{qty(dq)}</b> 片原路放回货架（{l.bin || '原库位'}），拍一张放回去的照片：</span><PhotoInput value={a.fphoto} onChange={(v) => set(l, { fphoto: v }, '放回照片')} invalid={errs && !a.fphoto} label="拍放回货架的照片" /></div>
              ) : (
                <div className="fix-b">
                  <Choice value={a.act} onChange={(v) => set(l, { act: v, fphoto: '', reason: '' }, '选处理方式')} err={errs && !a.act} options={[['refill', `去拿 ${qty(-dq)} 片补上`], ['less', '真没货，少发']]} />
                  {a.act === 'refill' && <><span className="small">补进包里以后拍照确认：</span><PhotoInput value={a.fphoto} onChange={(v) => set(l, { fphoto: v }, '补货照片')} invalid={errs && !a.fphoto} label="拍补上的货" /></>}
                  {a.act === 'less' && <><OptChoice optKey="note_review_diff" title="少发的原因" value={a.reason} onChange={(v) => set(l, { reason: v }, '选原因')} options={NOTE_OPTIONS.review_diff} flat={false} placeholder="原因…" err={errs && !a.reason} /><span className="small muted">这一行会按 {qty(a.qty)} 片发；单子退回去让客户重新确认变动的行。</span></>}
                </div>)}
            </div>); })}
        </div>)}
      {reviewing ? (
        <div className="card-b" style={{ borderTop: '1px solid var(--line-2)' }}>
          {can(role, 'review_pick') ? (
            <div className="row" style={{ gap: 18, alignItems: 'flex-end' }}>
              <PeoplePick step="review" label={<>复核人 <Info>找货人和复核人不能是同一个人：发错货要过两个人的手。只有一个仓管在岗时，由中方来复检。</Info></>} employees={role === 'admin' ? employees : employees.filter((e) => e.id !== deal.picker_employee_id)} value={reviewer} onChange={setReviewer} errs={errs} />
              <div className="field req"><label>最终打包照片（都处理完以后拍）</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs} label="拍打包照片" onDup={setDup} /></div>
              <span className="grow" />
              <button type="button" className="btn primary lg" onClick={submit}>复检打包完成 →</button>
            </div>
          ) : <Blocked action="review_pick" />}
          <div className="hint" style={{ marginTop: 8 }}>不用每盒拆：红色「必抽检」的行必须抽 2–3 盒并选结果，黄色「建议」的行最好也抽。<Assumed>必抽检现在只在这个界面上拦，后台没有硬拦；三个门槛（100 片 / 单价 5,000 / 一行 50 万）点「复检 + 打包」标题旁的 ⚙ 改。</Assumed>「实点数」和该有的不一样 → 在上面当场处理（放回 / 补上 / 少发）；最终打包数系统算，出库就按它，不能再改。少发的单子会退回热线，只让客户重新确认变动的行。</div>
        </div>
      ) : deal.reviewer_name && (
        <div className="card-b row" style={{ borderTop: '1px solid var(--line-2)', gap: 16 }}>
          <span>复检人：<b><EmpLink id={deal.reviewer_employee_id} name={deal.reviewer_name} /></b></span>
          <Thumb src={deal.review_photo_path} size={64} label={`${deal.biz_no} 打包照片`} group={[{ src: deal.pick_photo_path, label: '找货照片' }, { src: deal.review_photo_path, label: '打包照片' }]} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── ⑥ 销售订单（定价 + 偏差预警 + 解锁改行）─────────────────────────
// 价格低了 → 浅红小字块 (Frank 11-09 192b): 会亏 (只中方看) / 低于底价 (S 档) / 低于档位
export const lowFlag = (l, role) => {
  if (role !== 'admin') return null;   // 264: 员工什么标记都不出 (出了等于告诉他这个价低于成本 / 底价)
  if (!l.product_id || !(Number(l.unit_price) > 0)) return null;
  const px = Number(l.unit_price) * (Number(l.fx_rate) > 0 ? Number(l.fx_rate) : 1);
  if (Number(l.cost_xof) > 0 && px < Number(l.cost_xof)) return '会亏';
  if (Number(l.s_xof) > 0 && px < Number(l.s_xof)) return '低于底价';
  if (Number(l.tier_xof) > 0 && px < Number(l.tier_xof)) return '低于档位';
  return null;
};
// 208 三色: 会亏 = 红 (肯定有问题); 低于底价 / 低于档位 = 黄 (没亏, 要留意)
export const flagTone = (fl) => (fl === '会亏' ? 'red' : 'amber');
const lowBang = (l, fl) => <Bang tone={flagTone(fl)}>{lowTip({ fl, px: Number(l.unit_price) * (Number(l.fx_rate) > 0 ? Number(l.fx_rate) : 1), cost: Number(l.cost_xof), s: Number(l.s_xof), tier: Number(l.tier_xof) }, (v) => `${money(v)} XOF`)}</Bang>;
const LowTag = ({ l }) => { const { role } = useApp(); const fl = lowFlag(l, role); return fl ? lowBang(l, fl) : null; };
const PriceTag = ({ l, cur }) => {
  const { role } = useApp();
  const { level, pct } = priceLevel(l.unit_price, l.tier_price);
  if (!l.product_id) return null;
  if (level === 4) return <Pill tone="red">单价 0</Pill>;
  const fl = lowFlag(l, role);
  if (fl) return lowBang(l, fl);
  if (!level || role !== 'admin') return null;
  return <span className={`dev dev${level}`} title={`档位价 ${money(l.tier_price, cur)}`}>{pct < 0 ? '低' : '高'} {Math.abs(pct).toFixed(0)}%</span>;
};
export function SoPanel({ deal, lines, catalog, categories, act, role, events, openAddon }) {
  const { toast } = useApp();
  const [sel, setSel] = useState(new Set());
  const [priceLine, setPriceLine] = useState(null);
  const [confirmSo, setConfirmSo] = useState(false);
  const [adding, setAdding] = useState(null);
  const [unlock, setUnlock] = useState(null);       // line being unlocked (reason modal)
  const [open, setOpen] = useState({});              // line -> {reason, qty}
  const price = seesPrice(role);
  const cur = deal.currency;
  const pricing = deal.status === 'picked';
  const afterSo = ['ordered', 'confirmed', 'reviewed', 'partial'].includes(deal.status);
  const real = lines.filter((l) => l.qty_supply > 0 || l.product_id);
  const th = getThresholds();
  const canQty = afterSo && can(role, 'change_qty');
  const canReqPrice = ['manager', 'hotline', 'sales', 'sales_manager', 'finance'].includes(role);
  // 288 (Frank 11-13): 改完不在格子里点保存 —— 改动先列在表格下面 (改前 → 改后), 一次「提交改动」; 数量提交后直接生效并发变更通知, 价格走中方审批
  const pend = real.filter((l) => open[l.id]).map((l) => ({ l, o: open[l.id], changed: open[l.id].qty !== '' && N(open[l.id].qty) !== N(l.qty_supply) }));
  const reqs = real.filter((l) => l.price_req != null);
  const locked = pend.length > 0 || reqs.length > 0;
  const [decide, setDecide] = useState(null);
  const dropOpen = (id) => setOpen((x) => { const n = { ...x }; delete n[id]; return n; });
  const submitQty = async () => {
    const todo = pend.filter((x) => x.changed);
    if (pend.some((x) => x.o.qty === '')) return toast('有数量没填', 'err');
    if (!todo.length) { setOpen({}); return toast('没有改动，已重新锁上'); }
    for (const { l, o } of todo) {
      const ok = await act(`${l.model} 数量 ${l.qty_supply} → ${o.qty}${N(o.qty) === 0 ? '（预占已释放）' : ''}，已记进变更通知`, `select app.change_line_qty($1,$2,$3)`, [l.id, N(o.qty), o.reason]).then(() => true, () => false);
      if (!ok) return;
      dropOpen(l.id);
    }
    setOpen({});
  };
  const cols = [
    ...baseCols({ price: false }),
    { key: 'qty_req', label: '需求数量', w: 70, render: (l) => qty(l.qty_req) },
    { key: 'qty_supply', label: '供货数量', w: 110, ...(canQty ? {
      edit: (l) => (open[l.id] ? { type: 'number', value: open[l.id].qty, title: `原因：${open[l.id].reason}`, onChange: (v) => setOpen((o) => ({ ...o, [l.id]: { ...o[l.id], qty: String(v).replace(/\D/g, '') } })) } : null),
      render: (l) => <span className="row" style={{ gap: 6, justifyContent: 'center' }}><b>{qty(l.qty_supply)}</b>{N(l.qty_shipped) > 0 && <span className="small muted">已出 {l.qty_shipped}</span>}{l.added_after_pick && <Pill tone="blue">追加</Pill>}</span> }
      : { render: (l) => <b>{qty(l.qty_supply)}</b> }) },
    ...(price ? [
      { key: 'unit_price', label: `单价 ${cur}`, w: 170, render: (l) => (
        <span className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>{money(l.unit_price, cur)}<PriceTag l={l} cur={cur} />{l.price_manual && <span className="pill amber sm-pill">手改</span>}
          {l.price_req != null && <span className="pill amber sm-pill" title={`申请改成 ${money(l.price_req, cur)}：${l.price_req_note || ''}（等中方批）`}>申请 {money(l.price_req, cur)} · 待批</span>}
          {(pricing || afterSo) && l.product_id && l.price_req == null && (can(role, 'set_price')
            ? <button type="button" className="cell-ico" title="改价（中方直接生效，要写原因，留痕）" onClick={(e) => { e.stopPropagation(); setPriceLine(l); }}>✎</button>
            : canReqPrice ? <button type="button" className="cell-ico" title="申请改价（写原因 → 中方批了才生效）" onClick={(e) => { e.stopPropagation(); setPriceLine({ ...l, _req: true }); }}>✎</button> : null)}</span>) },
      { key: 'amount', label: `金额 ${cur}`, w: 120, value: (l) => N(l.qty_supply) * N(l.unit_price), render: (l) => <b>{money(N(l.qty_supply) * N(l.unit_price), cur)}</b> },
    ] : []),
  ];
  const totQ = real.reduce((a, l) => a + N(l.qty_supply), 0), totA = real.reduce((a, l) => a + N(l.qty_supply) * N(l.unit_price), 0);
  const manual = real.filter((l) => l.price_manual);
  const risky = real.filter((l) => l.product_id && N(l.qty_supply) > 0 && priceLevel(l.unit_price, l.tier_price, th).level >= 3);
  const zero = real.filter((l) => l.product_id && N(l.qty_supply) > 0 && N(l.unit_price) === 0 && !l.price_manual);
  const create = async () => {
    if (zero.length) return toast(`${zero.map((l) => l.model).join('、')} 单价为 0：请中方改价并选「赠品 / 样品」`, 'err');
    if ((manual.length || risky.length) && !confirmSo) { setConfirmSo(true); return; }
    await act('销售订单已生成', `select app.create_sales_order($1,$2)`, [deal.id, true]).catch(() => {});
    setConfirmSo(false);
  };
  const canAdd = ['picked', 'ordered', 'confirmed', 'reviewed', 'partial'].includes(deal.status) && can(role, 'add_lines');

  return (
    <div className="card">
      <div className="card-h">
        {/* 209: 改单类 (追加货 / 获取价格) 在左, 往外发的在右 */}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <h2>销售订单 <span className="muted small mono">{deal.so_no || '（初检后生成）'}</span> <Info>出了单把图发群，下面接客户确认</Info></h2>
          {openAddon && <button type="button" className="btn" onClick={openAddon}>＋ 出库前追加货</button>}
        </div>
        <div className="row">
          {deal.so_no && price && (locked ? <span className="why">{pend.length ? '先「提交改动」，才能复制销售单' : '改价等中方批完，才能复制销售单'}</span> : <DocActions kind="so" deal={deal} lines={lines} copyLabel="复制销售单图片" primary="copy" />)}
        </div>
      </div>
      {pricing && price && (
        <div className="grid-tools" style={{ borderBottom: 0 }}>
          <button type="button" className="btn sm" disabled={!sel.size} onClick={async () => {
            const r = await act('已按档位重新带价（手改价不覆盖）', `select app.refresh_prices($1,$2)`, [deal.id, [...sel]]).catch(() => null);
            if (r) setSel(new Set());
          }}>↻ 获取价格（选中 {sel.size} 行）</button>{!sel.size && <span className="why">先勾选要重新带价的行</span>}
          <Info>先勾选行再获取；手改价不会被覆盖。改价只有中方能操作；和档位价偏差 ≥{th[0]}% 标黄、≥{th[1]}% 标红（= 异价单），两个线在「规则参数 · 报价·确认」里改。</Info>
        </div>
      )}
      <Grid id="deal-so" slimTools table="deal_lines" columns={cols} rows={real}
        rowActions={afterSo && canQty ? [{ label: '🔒 解锁改数量', tone: '', when: (l) => !open[l.id], run: (l) => (l.added_after_pick ? setOpen((o) => ({ ...o, [l.id]: { qty: String(l.qty_supply), reason: '追加行改数量' } })) : setUnlock(l)) }] : undefined} rowClass={(l) => (l.review_changed ? 'changed' : priceLevel(l.unit_price, l.tier_price, th).level >= 3 && l.product_id ? 'warn' : l.price_manual ? 'manual' : '')}
        selectable={pricing && price ? { selected: sel, onChange: setSel } : null}
        foot={(rows) => ({ code: '合计', model: `${rows.filter((l) => N(l.qty_supply) > 0).length} 个型号`, qty_supply: `${qty(rows.reduce((a, l) => a + N(l.qty_supply), 0))} 件`,
          amount: price ? `${money(rows.reduce((a, l) => a + N(l.qty_supply) * N(l.unit_price), 0), cur)} ${cur}` : '' })} />
      {(pend.length > 0 || reqs.length > 0) && (
        <div className="chg-box">
          {pend.length > 0 && <>
            <div className="chg-h"><b>本次改动（还没提交）</b><span className="grow" />
              <button type="button" className="btn sm" onClick={() => setOpen({})}>放弃</button>
              <button type="button" className="btn sm primary" onClick={submitQty}>提交改动</button></div>
            {pend.map(({ l, o, changed }) => (
              <div className="chg-row" key={l.id}><span className="mono muted">#{real.indexOf(l) + 1}</span> <b>{l.model}</b> 数量 {changed ? <><span className="chg-old">{qty(l.qty_supply)}</span> → <b className="chg-new">{o.qty === '' ? '?' : qty(o.qty)}</b></> : <span className="muted">{qty(l.qty_supply)}（已解锁，还没改：在「供货数量」那格直接打数字）</span>}
                <span className="small muted"> · 原因：{o.reason}</span><button type="button" className="linkbtn small" style={{ marginLeft: 8 }} onClick={() => dropOpen(l.id)}>撤掉这条</button></div>))}
            <div className="small muted">提交后数量直接生效（不用审批），同时记一条「变更通知」给中方。</div>
          </>}
          {reqs.length > 0 && <>
            <div className="chg-h"><b>改价申请 · 等中方审批</b><Pill tone="amber">批完才能复制销售单 / 往下走</Pill></div>
            {reqs.map((l) => (
              <div className="chg-row" key={l.id}><span className="mono muted">#{real.indexOf(l) + 1}</span> <b>{l.model}</b> 单价 <span className="chg-old">{money(l.unit_price, cur)}</span> → <b className="chg-new">{money(l.price_req, cur)}</b> {cur}
                <span className="small muted"> · 档位价 {money(l.tier_price, cur)} · 原因：{l.price_req_note}</span>
                {role === 'admin' && <span style={{ marginLeft: 8 }}><button type="button" className="btn sm primary" onClick={() => setDecide({ l, ok: true })}>批准</button> <button type="button" className="btn sm" onClick={() => setDecide({ l, ok: false })}>不批</button></span>}</div>))}
          </>}
        </div>
      )}
      {decide && <NoteModal title={`${decide.ok ? '批准' : '不批'}改价：${decide.l.model} ${money(decide.l.unit_price, cur)} → ${money(decide.l.price_req, cur)} ${cur}`} label="备注（为什么给 / 不给这个价，必填）" danger={!decide.ok} okText={decide.ok ? '批准，按这个价' : '不批，价格不变'}
        onClose={() => setDecide(null)} onOk={(note) => act(decide.ok ? '已批准改价' : '已驳回改价申请', `select app.decide_line_price($1,$2,$3)`, [decide.l.id, decide.ok, note]).then(() => setDecide(null), () => {})} />}
      {price && (
        <div className="sumbar">
          <div className="s"><div className="k">共发</div><div className="v">{qty(totQ)} 件</div></div>
          <div className="s"><div className="k">订单金额</div><BigNum size={22}>{money(totA, cur)} {cur}</BigNum></div>
        </div>
      )}
      {pricing && (
        <div className="actionbar">
          <span className="hint">{zero.length ? <b className="red-t">有 {zero.length} 行单价为 0，不能下推</b> : risky.length ? <b className="red-t">{risky.length} 行价格偏差 ≥{th[2]}%，下推时会再提醒</b> : manual.length ? `有 ${manual.length} 行手动改价，生成前会再确认一次。` : '价格按客户档位自动带出。'}</span>
          {can(role, 'sales_order') ? <button type="button" className="btn primary lg" disabled={locked} title={locked ? '有改动没提交 / 改价等中方批' : undefined} onClick={create}>生成销售订单 →</button> : <Blocked action="sales_order" />}
        </div>
      )}
      {priceLine && <PriceModal line={priceLine} cur={cur} request={!!priceLine._req} onClose={() => setPriceLine(null)}
        onSave={(p, r) => (priceLine._req
          ? act('改价申请已提交，等中方审批', `select app.request_line_price($1,$2,$3)`, [priceLine.id, p, r])
          : act('已改价，已标记「手改」', `select app.set_line_price($1,$2,$3)`, [priceLine.id, p, r])).then(() => setPriceLine(null), () => {})} />}
      {unlock && <UnlockModal line={unlock} onClose={() => setUnlock(null)} onOk={(reason) => {
        setOpen({ ...open, [unlock.id]: { qty: reason === '客户不要了' ? '0' : String(unlock.qty_supply), reason } }); setUnlock(null);
        toast(`已解锁 ${unlock.model}：在「供货数量」那格改好，再点表格下面的「提交改动」`);
      }} />}
      {confirmSo && (
        <Modal title="二次确认：下推销售订单" onClose={() => setConfirmSo(false)}
          footer={<><button type="button" className="btn" onClick={() => setConfirmSo(false)}>再看看</button><button type="button" className="btn primary" onClick={create}>确认，生成销售订单</button></>}>
          {risky.length > 0 && <><p className="red-t"><b>价格偏差 ≥{th[2]}%：</b></p>
            <ul>{risky.map((l) => <li key={l.id}><b>{l.model} {l.category}</b>：档位价 {money(l.tier_price, cur)} → <b>{money(l.unit_price, cur)}</b> {cur}（{priceLevel(l.unit_price, l.tier_price, th).pct.toFixed(0)}%）</li>)}</ul></>}
          {manual.length > 0 && <><p>手动改过价的行：</p><ul>{manual.map((l) => <li key={l.id}><b>{l.model} {l.category}</b>：{money(l.unit_price, cur)} {cur}</li>)}</ul></>}
        </Modal>
      )}
      {adding && (
        <Modal wide title="出库前追加货（不重走流程）" onClose={() => setAdding(null)}
          footer={<><button type="button" className="btn" onClick={() => setAdding(null)}>取消</button>
            <button type="button" className="btn primary" onClick={async () => {
              const fin = finalizeLines(adding); if (fin.error) return toast(fin.error, 'err');
              if (!fin.lines.length || fin.lines.some((l) => !(N(l.qty_req) > 0) || !l.product)) return toast('请加已建档的型号并填数量（追加不能用没建档的型号）', 'err');
              await act('已追加并预占；客户需要重新确认', `select app.add_lines_before_ship($1,$2)`, [deal.id,
                JSON.stringify(fin.lines.map((l) => ({ product_id: l.product.id, qty_req: N(l.qty_req), stock_item_id: l.stock_item_id || null })))]).then(() => setAdding(null), () => {});
            }}>追加并预占</button></>}>
          <p className="hint">客户临时加货：直接挂在原单上，立即预占库存。已确认或已打包的单会回到「待客户确认」，新加的货确认后要重新复检打包。</p>
          <LineEntry id="deal-add" catalog={catalog} categories={categories} tier={deal.tier} lines={adding} setLines={setAdding} showPrice={price} currency={cur} />
        </Modal>
      )}
    </div>
  );
}

export function NoteModal({ title, label, okText = '确定', danger, onClose, onOk, hint }) {
  const [v, setV] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!v.trim()} onClick={() => onOk(v.trim())}>{okText}</button></>}>
      {hint && <p className="hint">{hint}</p>}
      <div className="field req"><label>{label}</label><textarea className="in" rows={3} autoFocus value={v} onChange={(e) => setV(e.target.value)} /></div>
    </Modal>
  );
}

function UnlockModal({ line, onClose, onOk }) {
  const [r, setR] = useState(NOTE_OPTIONS.unlock[0]);
  return (
    <Modal title={`解锁修改：${line.model} ${line.category}`} risk="red" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!r?.trim()} onClick={() => onOk(r)}>解锁</button></>}>
      <div className="stack">
        <div className="hint">改完自动锁回，并记录「谁、何时、从多少改成多少、原因」。「客户不要了」= 数量改为 0，预占释放。已确认的单改完要客户重新确认。</div>
        <OptNote optKey="note_unlock" title="解锁改数量的原因" options={NOTE_OPTIONS.unlock} value={r} onChange={setR} placeholder="其他原因（必填）" />
      </div>
    </Modal>
  );
}

function PriceModal({ line, cur, onClose, onSave, request }) {
  const [p, setP] = useState(String(N(line.unit_price)));
  const [r, setR] = useState('');
  const [ok, setOk] = useState(false);
  const { level, pct } = priceLevel(p === '' ? NaN : N(p), line.tier_price);
  const opts = level === 4 ? ['赠品', '样品'] : NOTE_OPTIONS.price;
  const qtyN = N(line.qty_supply);
  const needOk = level >= 2 && level < 4;
  const disabled = p === '' || !(N(p) >= 0) || !r?.trim() || (needOk && !ok) || (level === 4 && !['赠品', '样品'].includes(r));
  return (
    <Modal title={`${request ? '申请改价' : '改价'}：${line.model} ${line.category}`} risk={request ? 'yellow' : 'red'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className={`btn ${level >= 3 ? 'danger' : 'primary'}`} disabled={disabled} onClick={() => onSave(N(p), r)}>{request ? '提交申请（等中方批）' : '确认改价'}</button></>}>
      <div className="stack">
        <div className="hint">档位价 <b>{money(line.tier_price, cur)} {cur}</b>。{request ? '价格只有中方能定：你填想要的价和原因，中方批了才生效；批之前这张单不能复制销售单、不能往下走。' : '改价只有中方能做，必须写原因；改后标记「手改」，偏离档位价超过设定比例的单会标「异价单」。'}</div>
        <div className="field req"><label>新单价 {cur}</label><MoneyIn className="in" inputMode="decimal" autoFocus value={p} onChange={(e) => { setP(e.target.value.replace(/[^\d.]/g, '')); setOk(false); }} style={{ maxWidth: 200, fontSize: 18, fontWeight: 700 }} /></div>
        {level === 1 && <div className="dev-box dev1">比档位价{pct < 0 ? '低' : '高'} {Math.abs(pct).toFixed(1)}%</div>}
        {level >= 2 && level < 4 && (
          <div className={`dev-box dev${level}`}>
            <b>{level === 3 ? '⚠ 偏差很大，请确认不是输错' : '偏差较大'}：比档位价{pct < 0 ? '低' : '高'} {Math.abs(pct).toFixed(1)}%</b>
            <div>档位价 {money(line.tier_price, cur)} → 新价 {money(p, cur)}，每件差 {money(N(p) - N(line.tier_price), cur)}；整行 {qtyN} 件：{money(qtyN * N(line.tier_price), cur)} → <b>{money(qtyN * N(p), cur)}</b> {cur}</div>
            <label className="row" style={{ gap: 6, marginTop: 6 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />确认这个价格</label>
          </div>
        )}
        {level === 4 && <div className="dev-box dev3"><b>单价 0：</b>只有选「赠品」或「样品」才能下推。</div>}
        <div className="field req"><label>原因</label><OptionNote options={opts} value={r} onChange={setR} /></div>
      </div>
    </Modal>
  );
}

// ───────────────────────── ⑦ 客户最终确认（先发图，再确认：方式 + 截图必传 + 发货日期）─────────────────────────
export function ConfirmPanel({ deal, lines, events, act, role }) {
  const { go: nav2 } = useApp();
  const [method, setMethod] = useState('');
  const [proof, setProof] = useState('');
  const [when, setWhen] = useState('today');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [errs, setErrs] = useState(false);
  const price = seesPrice(role);
  const e = evOf(events, 'customer_confirmed');
  const changed = lines.filter((l) => l.review_changed);
  if (deal.status !== 'ordered') {
    return (
      <div className="card">
        <div className="card-h"><h2>客户最终确认</h2><Who e={e} /></div>
        <div className="card-b kv">
          <div><div className="k">确认方式</div><div className="v">{CONFIRM_METHODS[deal.confirm_method] || '—'}</div></div>
          <div><div className="k">确认截图</div><div className="v">{deal.confirm_proof ? <Thumb src={deal.confirm_proof} size={64} label="客户确认截图" /> : '—'}</div></div>
          <div><div className="k">约定发货日期</div><div className="v">{dDate(deal.planned_ship_date) || '—'}</div></div>
          <div><div className="k">备注</div><div className="v" style={{ fontSize: 15 }}>{e?.detail?.note || '—'}</div></div>
        </div>
      </div>
    );
  }
  const shipDate = when === 'today' ? today() : when === 'tomorrow' ? ymd(new Date(Date.now() + 864e5)) : date;
  const go = () => {
    setErrs(true);
    if (!method || !proof) return;
    const later = shipDate > today();   // 236 (Frank 11-11): 约定发货日不是今天 → 不提前复检打包, 回待办; 仓管先把货放暂存位置
    act(deal.reviewed_at ? '客户已重新确认，可以出库' : later ? `客户已确认，约 ${shipDate} 发货：先不打包，通知仓管把货放到暂存位置` : '客户已确认，请主管复检打包', `select app.customer_confirm($1,$2,$3,$4,$5)`, [deal.id, note || null, method, proof, shipDate]).then(() => { if (later && !deal.reviewed_at && !(can(role, 'review_pick') || role === 'picker')) nav2('todo'); }, () => {});
  };
  return (
    <div className="card">
      <div className="card-h"><h2>客户最终确认 <Info>确认的是销售单上的数量和价格；确认后主管复检打包，再出库</Info></h2></div>
      <div className="card-b stack">
        {changed.length > 0 && <div className="lock">复检后有变动，只需要客户重新确认这几行：{changed.map((l) => `${l.model} ${l.category} → ${l.qty_supply} 件`).join('；')}</div>}
        <div className="substep"><span className="sn">1</span><div className="grow"><b>把销售单图片发到客户群</b> <Info>没发也能确认（当面给客户看过），但一般先发再确认。</Info></div>
          {price && <DocActions kind="so" deal={deal} lines={lines} copyLabel="复制销售单图片" primary="copy" />}</div>
        <div className="substep"><span className="sn">2</span><div className="grow stack">
          <b>客户确认</b>
          {can(role, 'customer_confirm') ? (
            <>
              {/* 210: 电脑上「标签：选项」一行一项, 手机自动上下 */}
              <FRow label="确认方式" req><OptChoice optKey="confirm_methods" title="确认方式" value={method} onChange={(k) => setMethod(k)} options={Object.entries(CONFIRM_METHODS)} err={errs && !method} /></FRow>
              <FRow label="确认截图" req><div className="proofbox-wrap" style={{ flex: 1, minWidth: 0 }}><PhotoInput value={proof} onChange={setProof} label="客户回复 OK 的截图" invalid={errs} /></div><Info>电话确认的：先在群里补发一句确认文字，再截那一句。以后有「我没同意这个价」的纠纷靠这张。</Info></FRow>
              <FRow label="约定发货" req>
                <div className="seg">{[['today', '今天'], ['tomorrow', '明天'], ['date', '指定日期']].map(([k, l]) => <button type="button" key={k} className={when === k ? 'on' : ''} onClick={() => setWhen(k)}>{l}</button>)}</div>
                {when === 'date' && <DatePicker value={date} onChange={setDate} />}
                <span className="muted small">= {shipDate}</span><Info>到期没出库，会在待办和铃铛里提醒</Info>
              </FRow>
              <FRow label="备注"><input className="in" style={{ maxWidth: 420, width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="可不填，例如 客户下午 3 点后在店" /></FRow>
              <div className="actbar">{(!method || !proof) && <span className="why">还差：{[!method && '确认方式', !proof && '确认截图'].filter(Boolean).join('、')}</span>}<button type="button" className="btn primary lg" onClick={go}>客户已确认 →</button></div>
            </>
          ) : <Blocked action="customer_confirm" />}
        </div></div>
      </div>
    </div>
  );
}

// ───────────────────────── ⑧ 出库（整单 / 分批，每批独立）─────────────────────────
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function ShipPanel(props) {
  const { deal, shipments, role } = props;
  const open = ['reviewed', 'partial'].includes(deal.status);
  const live = shipments.filter((s) => !s.voided_at);
  return (
    <>
      {open && (can(role, 'ship') ? <ShipForm key={`${live.length}-${deal.updated_at}`} {...props} /> : <div className="card card-b"><Blocked action="ship" /></div>)}
      <ShipmentsCard {...props} />
    </>
  );
}
function ShipForm({ deal, lines, shipments, act }) {
  const { toast, role, refresh } = useApp();
  const [date, setDate] = useState(today());
  const [time, setTime] = useState(nowTime());
  const [method, setMethod] = useState('');
  const [phone, setPhone] = useState('');
  // 406 (Frank 11-18): 收货地址和联系人分开 —— 地址从选项里选 (⚙ 中方维护, 默认带出客户所在城市), 联系人从客户档案的联系人里选 (能搜名字 / 电话), 新的人提交后自动进档案
  const OTHER_PLACE = '其他（手填）';
  const placeBase = useMemo(() => [...new Set([deal.city, 'Adjamé 市场', 'Abobo', 'Yopougon', 'Treichville', 'Cocody', '交通站（外区客户）', '客户到仓库自取'].filter(Boolean))].concat([OTHER_PLACE]), [deal.city]);
  const [place, setPlace] = useState(deal.city || ''); const [placeNote, setPlaceNote] = useState('');
  const [contact, setContact] = useState({ role: '', name: '', phone: '' });
  const placeText = place === OTHER_PLACE ? placeNote.trim() : place;
  const addrText = [placeText, contact?.name?.trim() && `${contact.name.trim()}${contact.role ? `（${contactRole(contact.role)}）` : ''}`, contact?.phone?.trim()].filter(Boolean).join(' · ');
  const addr = addrText;
  const [proof, setProof] = useState('');
  const [partial, setPartial] = useState(false);
  const [preason, setPreason] = useState('');
  const [askPartial, setAskPartial] = useState(false);
  const [items, setItems] = useState({});
  const [errs, setErrs] = useState(false);
  // 232 (Frank 11-11): 运费谁出 —— S 档默认我们出; 阿比让以外默认我们出一段 (仓库 → Adjamé 交通站); 其他默认客户出; 仓库可以改
  const [bearerRaw, setBearer] = useState('customer'); const bearer = optSubmit('freight_bearer', bearerRaw).base;   // 270 (Frank 11-12): 默认客户出
  const [freight, setFreight] = useState('');
  const [summary, setSummary] = useState(null);
  const left = lines.filter((l) => N(l.qty_supply) > N(l.qty_shipped));
  const remain = (l) => N(l.qty_supply) - N(l.qty_shipped);
  const now = (l) => (partial ? N(items[l.id] ?? remain(l)) : remain(l));
  const prev = shipments.filter((s) => !s.voided_at).at(-1);
  const cols = [
    ...baseCols({ price: false }),
    { key: 'qty_supply', label: '订单数量', w: 70, render: (l) => qty(l.qty_supply) },
    { key: 'qty_shipped', label: '已出库', w: 70, render: (l) => qty(l.qty_shipped) },
    { key: 'ship_now', label: '本次出库', w: 100, value: now, ...(partial ? { edit: (l) => ({ type: 'number', value: items[l.id] ?? String(remain(l)),
      invalid: N(items[l.id]) > remain(l), hint: N(items[l.id]) > remain(l) ? `最多 ${remain(l)}` : null, onChange: (v) => setItems({ ...items, [l.id]: v.replace(/\D/g, '') }) }) } : { render: (l) => <b>{qty(remain(l))}</b> }) },
  ];
  const total = left.reduce((a, l) => a + N(l.qty_supply), 0) + lines.filter((l) => N(l.qty_supply) <= N(l.qty_shipped)).reduce((a, l) => a + N(l.qty_supply), 0);
  const shippedBefore = lines.reduce((a, l) => a + N(l.qty_shipped), 0);
  const thisTime = left.reduce((a, l) => a + now(l), 0);
  const check = () => {
    setErrs(true);
    const miss = [!date && '日期', !time && '时间', !method && '发货方式', !phone.trim() && '电话', phone.trim() && !phoneValid(phone) && '电话位数不对', !placeText && '收货地址', !contact?.name?.trim() && '联系人', contact?.phone?.trim() && !phoneValid(contact.phone) && '联系人电话位数不对', !proof && '发货凭证截图', partial && !preason.trim() && '只发一部分的原因', bearer !== 'customer' && !(N(freight) > 0) && '实际付了多少运费'].filter(Boolean);
    if (miss.length) return toast(`出库必填：${miss.join('、')}`, 'err');
    if (left.some((l) => now(l) > remain(l))) return toast('本次出库超过剩余数量', 'err');
    if (!(thisTime > 0)) return toast('本次出库数量为 0', 'err');
    const same = prev && (prev.contact_phone === phone.trim() || (proof && prev.proof_path === proof));
    setSummary({ same });
  };
  const submit = async () => {
    const at = new Date(`${date}T${time}:00`).toISOString();
    const payload = partial ? left.map((l) => ({ line_id: l.id, qty: now(l) })).filter((x) => x.qty > 0) : null;
    const mth = optSubmit('ship_methods', method), bear = optSubmit('freight_bearer', bearerRaw);   // 401: ⚙ 里自己加的选项 → 后台按它挂的那一类处理, 名字另存
    const LAST = `(select id from app.shipments where deal_id = $1 and voided_at is null order by created_at desc limit 1)`;
    await act('已出库，客户总账已更新', `select app.ship($1,$2,$3,$4,$5,$6,$7)`, [deal.id, at, mth.base, phone.trim(), addrText, proof, payload && JSON.stringify(payload)])
      .then(() => { showDone({ kind: 'shipment', deal: deal.id }); return rememberContact(role, deal.customer_id, contact); })
      .then(() => (mth.label || bear.label ? call(role, `select app.set_opt_label('ship_method', ${LAST}, $2), app.set_opt_label('ship_freight', ${LAST}, $3)`, [deal.id, mth.label, bear.label]).catch(() => {}) : null))
      .then(() => call(role, `select app.record_ship_freight((select id from app.shipments where deal_id = $1 and voided_at is null order by created_at desc limit 1), $2, $3, $4) as mv`, [deal.id, bearer, bearer === 'customer' ? null : N(freight), proof])
        .then((r) => { if (bearer !== 'customer' && r?.[0]?.mv) window.dispatchEvent(new CustomEvent('la9s:flow', { detail: { text: `运费 ${money(N(freight))} XOF 已记一笔支出流水（本地物流费 · Wave-XOF）`, to: 'cash' } })); refresh(); }, (e) => toast('运费没记上：' + (e?.message || e), 'err')))
      .then(() => (partial && preason.trim() ? call(role, `select app.set_partial_reason((select id from app.shipments where deal_id = $1 and voided_at is null order by created_at desc limit 1), $2)`, [deal.id, preason.trim()]).then(() => refresh(), () => {}) : null))
      .then(() => setSummary(null), () => {});
  };
  return (
    <div className="card">
      <div className="card-h"><h2>出库单 {shippedBefore > 0 && <span className="pill amber">第 {shipments.filter((s) => !s.voided_at).length + 1} 批</span>}</h2>
        <span className="hint">司机真正把货拉走时再点「确认出库」；只叫了车、约了明天的先别登记</span></div>
      <div className="card-b stack">
        {/* 352 (Frank 11-17): 出库表单分三块 —— ① 发货 ② 时间与收货 ③ 运费; 「这次发多少」和明细在下面 */}
        <div className="fgroups">
          <div className="fgroup"><div className="fgroup-t">① 发货</div>
            <div className="row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field req grow"><label>发货方式</label>
            <OptChoice optKey="ship_methods" title="发货方式" bases={Object.entries(SHIP_METHODS)} value={method} onChange={(k) => setMethod(k)} options={Object.entries(SHIP_METHODS)} err={errs && !method} /></div>
              <div className="field req" style={{ width: 220 }}><label>{optSubmit('ship_methods', method).base.startsWith('yango') ? 'Yango 司机电话' : optSubmit('ship_methods', method).base === 'customer_pickup' ? '取货人电话' : '联系电话'}</label>
            <PhoneInput value={phone} onChange={setPhone} invalid={errs && !phone.trim()} /></div>
              <div className="field req"><label>发货凭证（Yango 截图 / 现场照片）</label><PhotoInput value={proof} onChange={setProof} label="司机 / 车辆截图" invalid={errs} /></div>
            </div></div>
          <div className="fgroup"><div className="fgroup-t">② 时间与收货</div>
            <div className="row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field req"><label>发货日期</label><DatePicker value={date} onChange={setDate} /></div>
              <div className="field req"><label>时间</label><input className="in" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 120 }} /></div>
              <div className="field req"><label>收货地址</label>
                <OptChoice optKey="ship_places" title="收货地址" value={place} onChange={setPlace} options={placeBase} flat={false} placeholder="选地址…" err={errs && !placeText} />
                {place === OTHER_PLACE && <input className={`in ${errs && !placeNote.trim() ? 'err-in' : ''}`} style={{ marginTop: 6, width: 220 }} value={placeNote} onChange={(e) => setPlaceNote(e.target.value)} placeholder="写清楚送到哪" />}</div>
              <div className="field req grow"><label>联系人（收货的人）</label>
                <ContactPick customerId={deal.customer_id} value={contact} onChange={setContact} errs={errs} /></div>
            </div></div>
          <div className="fgroup"><div className="fgroup-t">③ 运费</div>
            <div className="row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field req"><label>运费谁出 <Info>默认客户出。S 档大客户：我们出。外区客户：我们只出仓库到 Adjamé 交通站这一段。选了我们出：填实际付的钱（照 Yango 截图上的价格），出库时自动记一笔支出流水（本地物流费，Wave-XOF 账户）。只进我们自己的流水，不动客户的账。</Info></label>
            <OptChoice optKey="freight_bearer" title="运费谁出" bases={FREIGHT_BASES} value={bearerRaw} onChange={(k) => setBearer(k)} options={FREIGHT_BASES} /></div>
              {bearer !== 'customer' && <div className="field req" style={{ width: 220 }}><label>实际付了多少（照截图上的价格）</label><MoneyIn className={`in ${errs && !(N(freight) > 0) ? 'err-in' : ''}`} inputMode="numeric" value={freight} onChange={(e) => setFreight(e.target.value.replace(/\D/g, ''))} placeholder="XOF" /></div>}
            </div></div>
        </div>
      </div>
      <div className="grid-tools">
        <div className="shipmode">
          <span className="small"><b>这次发多少：</b></span>
          <div className="seg">
            <button type="button" className={!partial ? 'on' : ''} onClick={() => { setPartial(false); setItems({}); }}>全部一次发完</button>
            <button type="button" className={partial ? 'on' : ''} onClick={() => !partial && setAskPartial(true)}>只发一部分（分批）</button>
          </div>
          {partial && <span className="small">「本次出库」列可改；不发的行填 0，下一批会自动回到剩余数量</span>}
          {partial && <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}><b className="small">为什么只发一部分 <span style={{ color: 'var(--red)' }}>*</span></b>
            {['车装不下', '货还没齐', '客户只要先拿一部分', '客户钱没到齐'].map((r) => <button type="button" key={r} className={`chip ${preason === r ? 'on' : ''} ${errs && !preason.trim() ? 'err' : ''}`} onClick={() => setPreason(r)}>{r}</button>)}
            <input className={`in ${errs && !preason.trim() ? 'err-in' : ''}`} style={{ width: 200 }} value={preason} onChange={(e) => setPreason(e.target.value)} placeholder="或者自己写" /></span>}
        </div>
      </div>
      <Grid id="deal-ship" slimTools table="deal_lines" columns={cols} rows={left} foot={(rows) => ({ code: '合计', model: `${rows.length} 个型号`, ship_now: `${qty(rows.reduce((a, l) => a + now(l), 0))} 件` })} />
      <div className="actionbar"><span className="hint">本次发 <b>{qty(thisTime)}</b> 件 · 订单共 {qty(total)} 件 · 剩 <b>{qty(total - shippedBefore - thisTime)}</b> 件下次发</span>
        <button type="button" className="btn primary lg" onClick={check}>确认出库 →</button></div>
      {askPartial && (
        <Modal title="改为分批出库？" onClose={() => setAskPartial(false)}
          footer={<><button type="button" className="btn" onClick={() => setAskPartial(false)}>不，整单出库</button><button type="button" className="btn primary" onClick={() => { setPartial(true); setAskPartial(false); }}>是，本次只发一部分</button></>}>
          本次只发一部分，剩下的留着下次发？切换后「本次出库」这一列才能改。
        </Modal>
      )}
      {summary && (
        <Modal title="确认出库" onClose={() => setSummary(null)}
          footer={<><button type="button" className="btn" onClick={() => setSummary(null)}>再看看</button><button type="button" className="btn primary" onClick={submit}>确认出库</button></>}>
          <div className="stack">
            <div className="ship-sum">本次发 <b>{qty(thisTime)}</b> 件 · 订单共 <b>{qty(total)}</b> 件 · 剩 <b>{qty(total - shippedBefore - thisTime)}</b> 件下次发</div>
            <div>{optName('ship_methods', method, SHIP_METHODS)} · {phone} · {addr} · {date} {time}</div>
            {summary.same && <div className="lock">⚠ 和上一批（{prev.out_no}）的{prev.contact_phone === phone.trim() ? '司机电话' : '凭证图片'}相同，确认是另一辆车 / 另一次发货？</div>}
            <div className="hint">出库后客户总账立即增加；如果客户有预付款，会自动抵扣这一单。</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// 232: 这批运费谁出 / 付了没有; 财务或中方付完传截图 → 自动记一笔「本地物流费」支出, 截图挂在这批出库上
const BEARER = { customer: '客户出', company: '我们出', company_part: '我们出一段' };
function FreightCell({ s, role, act }) {
  const [pay, setPay] = useState(false);
  if (!s.freight_bearer) return <span className="muted small">没填</span>;
  if (s.freight_bearer === 'customer') return <span className="pill gray">客户出</span>;
  if (s.freight_paid_at) return <span className="row" style={{ gap: 6 }}><span className="pill green">{optName('freight_bearer', s.freight_bearer, BEARER, s.freight_label)} · 已付 {money(s.freight_amount)}</span><Thumb src={s.freight_proof} size={30} label={`${s.out_no} 运费支付截图`} /></span>;
  return (<span className="row" style={{ gap: 6 }}><span className="pill red">{optName('freight_bearer', s.freight_bearer, BEARER, s.freight_label)} · 没付{s.freight_est ? ` 约 ${money(s.freight_est)}` : ''}</span>
    {(can(role, 'receipt') || role === 'admin') && <button type="button" className="btn sm primary" onClick={() => setPay(true)}>付运费</button>}
    {pay && <FreightModal s={s} act={act} onClose={() => setPay(false)} />}</span>);
}
function FreightModal({ s, act, onClose }) {
  const { org } = useApp();
  const { data: acc } = useData(() => q(`select id, name, currency from app.cash_accounts where org_id = $1 and active order by name`, [org]), [org]);
  const [account, setAccount] = useState(''); const [amt, setAmt] = useState(s.freight_est ? String(N(s.freight_est)) : ''); const [proof, setProof] = useState('');
  const ok = account && N(amt) > 0 && proof;
  return (
    <Modal title={`付运费 · ${s.out_no}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">还差：{[!account && '账户', !(N(amt) > 0) && '金额', !proof && '支付截图'].filter(Boolean).join('、')}</span>}
      <button type="button" className="btn primary" disabled={!ok} onClick={() => act(`运费 ${money(amt)} 已付，已记一笔本地物流费支出`, `select app.pay_ship_freight($1,$2,$3,$4)`, [s.id, account, N(amt), proof]).then(onClose, () => {})}>已付，记账</button></>}>
      <div className="stack">
        {acc && !acc.length && <div className="pill red" style={{ whiteSpace: 'normal' }}>还没有资金账户：先到「资金账户 → 账户设置」建 Wave / 现金账户</div>}
        <FRow label="从哪个账户付" req><OptChoice optKey="cash_accounts" title="资金账户" data value={account} onChange={setAccount} options={(acc || []).map((a) => [a.id, a.name])} placeholder="选账户…" flat={false} /></FRow>
        <FRow label="实际金额" req><MoneyIn className="in" inputMode="numeric" style={{ width: 150 }} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">XOF{s.freight_est ? `（仓库填的大概 ${money(s.freight_est)}）` : ''}</span></FRow>
        <FRow label="支付截图" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="Wave / Orange 支付截图" /></div></FRow>
      </div>
    </Modal>
  );
}
function ShipmentsCard({ deal, lines, shipments, act, role }) {
  const [voiding, setVoiding] = useState(null);
  const [justVoided, setJustVoided] = useState(false);
  if (!shipments.length) return null;
  const group = shipments.map((s) => ({ src: s.proof_path, label: `${s.out_no} 出库凭证` }));
  const cols = [
    { key: 'out_no', label: '出库单号', w: 150, render: (s) => <DocNo kind="shipment" id={s.id} no={s.out_no} strike={!!s.voided_at} /> },
    { key: 'shipped_at', label: '发货时间', w: 130, render: (s) => dt(s.shipped_at) },
    { key: 'method', label: '方式', w: 110, render: (s) => optName('ship_methods', s.method, SHIP_METHODS, s.method_label) },
    { key: 'contact_phone', label: '电话', w: 120 },
    { key: 'address', label: '地址', w: 140 },
    { key: 'qty', label: '件数', w: 60, render: (s) => qty(s.qty) },
    { key: 'amount', label: `金额 ${deal.currency}`, w: 110, render: (s) => (seesPrice(role) ? <b className={s.voided_at ? 'strike' : ''}>{money(s.amount, deal.currency)}</b> : '—') },
    { key: 'proof', label: '凭证', w: 70, sortable: false, filterable: false, render: (s) => <Thumb src={s.proof_path} size={34} label={`${s.out_no} 出库凭证`} group={group} /> },
    { key: 'freight', label: '运费', w: 210, sortable: false, filterable: false, render: (s) => (s.voided_at ? null : <FreightCell s={s} role={role} act={act} />) },
    { key: 'docs', label: '发货文件', w: 420, sortable: false, filterable: false, render: (s) => (s.voided_at ? null : <BlActions shipment={s} deal={deal} lines={lines} />) },
    { key: 'recv', label: '签收 / 金蝶', w: 260, sortable: false, render: (s) => {
      if (s.voided_at) return <span className="pill gray" title={dt(s.voided_at)}>已撤销 · {s.void_reason}</span>;
      if (s.customer_received_at) return <Pill tone="green">已签收 · 金蝶可补录</Pill>;
      return (
        <span className="row" style={{ gap: 6 }}>
          <Pill tone="amber">待签收 · 到「签收 · 对账」步</Pill>
          {can(role, 'void_shipment') && <button type="button" className="btn sm danger" onClick={() => setVoiding(s)}>发货失败 / 退回</button>}
        </span>);
    } },
  ];
  return (
    <div className="card">
      <div className="card-h"><h2>出库记录</h2></div>
      {justVoided && <div className="card-b lock">已撤销出库。如果已经把这笔的 Balance 发给客户，请到「签收 · 对账」重新复制一张发过去。</div>}
      <Grid id="deal-shipments" slimTools table="shipments" columns={cols} rows={shipments} rowClass={(s) => (s.voided_at ? 'voided' : '')} />
      <div className="card-b hint">发货文件：「BL」点开预览、预览里打印（一次两张：仓库联留底、客户联给客户签字），「海关文件」同样先预览再打印（上传的固定 PDF，在「发货文件」标题旁 ⚙ 或「规则参数 → 系统」里换）；大单（金额或件数到规则参数里的阈值）会提示建议打印，小单不强制。客户签字后拍照挂上就是发货证明。「发货失败 / 退回」只用于货没到客户手上（Yango 去不了、改期、我方隔天发）：货回原仓位并重新预占、应收冲回、订单回到待出库，作废的出库单留痕。客户签收后只能走退货。金蝶写入暂未接入。</div>
      {voiding && <VoidModal s={voiding} onClose={() => setVoiding(null)} onOk={(r) => act(`${voiding.out_no} 已撤销，货已回库并重新预占`, `select app.void_shipment($1,$2)`, [voiding.id, r]).then(() => { setVoiding(null); setJustVoided(true); }, () => {})} />}
    </div>
  );
}
function VoidModal({ s, onClose, onOk }) {
  const [r, setR] = useState(NOTE_OPTIONS.void_ship[0]);
  return (
    <Modal title={`发货失败 / 退回：${s.out_no}`} risk="red" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn danger" disabled={!r?.trim()} onClick={() => onOk(r)}>确认撤销这次出库</button></>}>
      <div className="stack">
        <div className="hint">不是客户退货：货没离开我们的控制，不进待检仓、不需要中方审批。撤销后重新约日期再发。</div>
        <OptNote optKey="note_void_ship" title="撤销出库的原因" options={NOTE_OPTIONS.void_ship} value={r} onChange={setR} placeholder="其他原因（必填）" />
        <ImpactFor dealId={s.deal_id} delta={-N(s.amount)} note={`撤销出库 −${money(N(s.amount))}`} />
      </div>
    </Modal>
  );
}

// ───────────────────────── ⑨ 收款（本单直接收款，不跳页）─────────────────────────
export function PayPanel({ deal, receipts, shipments, act, role }) {
  const { refresh } = useApp();
  const cur = deal.currency;
  const [done, setDone] = useState(null);
  const [wo, setWo] = useState(false);
  const [voidRc, setVoidRc] = useState(null);
  const [bad, setBad] = useState(false);
  const [pick, setPick] = useState(new Set());
  if (!seesPrice(role)) return <div className="card card-b"><Blocked action="receipt" /></div>;
  const rec = N(deal.shipped_amount) - N(deal.returned_amount);
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>本单收款 <RuleGear title="抹零上限" ids={['wo.max']} /></h2>
          <div className="row">
            {can(role, 'write_off') && N(deal.due) > 0 && N(deal.due) <= (cur === 'XOF' ? 100 : 1) && <button type="button" className="btn" onClick={() => setWo(true)}>抹零 {money(deal.due, cur)}</button>}
            {role === 'admin' && N(deal.due) > (cur === 'XOF' ? 100 : 1) && <button type="button" className="btn soft-red" onClick={() => setBad(true)}>坏账核销</button>}
            {can(role, 'receipt') && receipts.length > 0 && (() => { const r = receipts.find((x) => pick.has(x.rcv_no + x.at)); const one = pick.size === 1 && r; return <button type="button" className="btn soft-red" disabled={!one} title={one ? '' : '先在下面勾选一笔收款（一次只能撤一笔）'} onClick={() => setVoidRc({ id: r.receipt_id, rcv_no: r.rcv_no, amount: r.receipt_amount, currency: r.currency })}>↶ 撤销选中的收款</button>; })()}
          </div></div>
        <div className="card-b paygrid">
          <div><div className="k">本单应收</div><BigNum size={22}>{money(rec, cur)} <small>{cur}</small></BigNum><div className="small muted">出库 {money(deal.shipped_amount, cur)}{N(deal.returned_amount) > 0 && ` − 退货 ${money(deal.returned_amount, cur)}`}</div></div>
          <div><div className="k">实收（冲到本单）</div><BigNum size={22}>{money(deal.allocated_amount, cur)} <small>{cur}</small></BigNum>{N(deal.disc_credit) !== 0 && <div className="small muted">收货差异扣减 {money(deal.disc_credit, cur)}</div>}{N(deal.writeoff_amount) - N(deal.disc_credit) > 0 && <div className="small muted">另抹零 / 核销 {money(N(deal.writeoff_amount) - N(deal.disc_credit), cur)}</div>}</div>
          <div><div className="k">本单待付</div><BigNum size={26} style={{ color: N(deal.due) > 0 ? 'var(--red)' : 'var(--green)' }}>{N(deal.due) > 0 ? <>{money(deal.due, cur)} <small>{cur}</small></> : '已结清 ✓'}</BigNum></div>
        </div>
        {!shipments.some((s) => !s.voided_at) && <div className="card-b hint">还没出库：客户总账只在出库后增加。现在收的钱会记为预付，出库时自动抵扣。</div>}
        {receipts.length > 0 && <Grid id="deal-receipts" slimTools columns={[
          { key: 'seq', label: '第几笔', w: 70, sortable: false, render: (r) => `第 ${receipts.indexOf(r) + 1} 笔` },
          { key: 'rcv_no', label: '收款单号', w: 140, render: (r) => <DocNo kind="receipt" id={r.id} no={r.rcv_no} /> },
          { key: 'received_on', label: '收款日期', w: 100, render: (r) => dDate(r.received_on) },
          { key: 'method', label: '方式', w: 100, render: (r) => PAY_METHODS[r.method] },
          { key: 'src', label: '来源', w: 130, sortable: false, render: (r) => (r.from_prepaid ? <span className="pill blue" title={`客户 ${dDate(r.received_on)} 付的钱，当时记成预付，出库时自动抵到这张单`}>预付抵扣</span> : <span className="muted small">这张单收的</span>) },
          { key: 'receipt_amount', label: '这笔收款', w: 130, render: (r) => `${money(r.receipt_amount, r.currency)} ${r.currency}` },
          { key: 'amount', label: `冲到本单 ${cur}`, w: 120, render: (r) => <b>{money(r.amount, cur)}</b> },
          // 217: 一单付几次, 每笔冲完还欠多少一行一行列清楚
          { key: 'left', label: '冲完还欠', w: 120, sortable: false, render: (r) => { const i = receipts.indexOf(r); const paid = receipts.slice(0, i + 1).reduce((a, x) => a + N(x.amount), 0); const left = rec - N(deal.writeoff_amount) - paid; return left > 0 ? money(left, cur) : <span className="green-t2">结清 ✓</span>; } },
          { key: 'proof', label: '凭证', w: 80, sortable: false, filterable: false, render: (r) => (r.proof_path ? <Thumb src={r.proof_path} size={34} label={`${r.rcv_no} 收款凭证`} /> : r.from_prepaid ? <span className="pill gray" title="这是以前收的预付款，当时那笔收款没传凭证">原收款无凭证</span> : <span className="pill red">缺凭证</span>) },
        ]} rows={receipts} rowKey={(r) => r.rcv_no + r.at} selectable={can(role, 'receipt') ? { selected: pick, onChange: setPick } : undefined} />}
        {receipts.length > 0 && <div className="card-b hint" style={{ borderTop: '1px solid var(--line-2)' }}>钱到没到账不在这里确认：统一到「资金账户 → 待核对到账」核对，避免出错。</div>}
        {voidRc && <VoidReceiptModal rc={voidRc} onClose={() => { setVoidRc(null); setPick(new Set()); }} />}
      </div>
      {can(role, 'receipt') && N(deal.due) > 0 && (
        <div className="card">
          <div className="card-h"><h2>登记收款 <Info>客户当场付款；隔天付、一次付多单请到「收款与冲账」</Info></h2></div>
          <ReceiptForm customer={deal.customer_id} accountCurrency={cur} lockDeal={deal.id} defaultAmount={N(deal.due)} compact onDone={setDone} />
        </div>
      )}
      {done && <><ReceiptDone sum={done} onClose={() => setDone(null)} /><div className="small muted" style={{ margin: '4px 2px 10px' }}>下面的 Balance 已更新，复制发给客户。</div></>}
      <BalancePreview customerId={deal.customer_id} currency={cur} deal={deal} title={`客户最新 Balance · ${deal.customer_name}`} />
      {wo && <WriteOffModal deal={deal} act={act} onClose={() => setWo(false)} />}
      {bad && <BadDebtModal deal={deal} act={act} onClose={() => setBad(false)} />}
    </>
  );
}
// 219: 坏账核销 (只中方): 欠款确认收不回来 → 写原因 + 凭证, 冲掉应收但永不删除, 客户流水和坏账记录里都看得到
// 238 (Frank 11-11 23:08): 事先就知道要分开发的 → 勾出「以后再发」的型号拆成另一张单, 各有各的销售单、各自签收; 价格锁在拆单这一刻
// 396 (Frank 11-18): 拆单能按数量拆 —— 每一行填「以后发几片」(例: BE6 100 片, 这次发 50、以后发 50); 填满 = 整行以后发.
function SplitModal({ deal, lines, act, onClose }) {
  const [later, setLater] = useState({}); const [date, setDate] = useState(''); const [note, setNote] = useState('');
  const L = (l) => Math.max(0, Math.min(N(l.qty_req), N(later[l.id])));
  const moved = lines.filter((l) => L(l) > 0); const allGone = lines.every((l) => L(l) >= N(l.qty_req));
  const why = !moved.length ? '填哪几个型号以后发、发几片' : allGone ? '不能全部拆走，这次至少发一点' : !date ? '选以后哪天发' : '';
  const setQ = (l, v) => setLater((x) => ({ ...x, [l.id]: Math.max(0, Math.min(N(l.qty_req), Number(v) || 0)) }));
  return (
    <Modal wide title={`拆单：${deal.biz_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{why && <span className="why">{why}</span>}
        <button type="button" className="btn primary" disabled={!!why} onClick={() => act(`已拆成两张单：${moved.length} 个型号（共 ${qty(moved.reduce((a, l) => a + L(l), 0))} 片）以后发`, `select app.split_deal_qty($1,$2,$3,$4)`, [deal.id, JSON.stringify(moved.map((l) => ({ line_id: l.id, qty: L(l) }))), date, note.trim() || null]).then(onClose).catch(() => {})}>拆成两张单</button></>}>
      <div className="stack" style={{ minHeight: 440 }}>
        <div className="hint">每个型号填「以后发几片」：填的那部分搬到一张新单（新单号），到你选的那天再下推找货；剩下的留在这张单，现在就可以下推。两张单各出各的销售单、各自签收。拆出去的价格锁在现在这个价，以后只有中方能改。以后不要了，那张新单可以作废（要选原因，记进客户档案的「下单诚意」）。</div>
        <FRow label="以后哪天发" req><DatePicker value={date || null} onChange={setDate} label={date ? '' : '选日期'} /></FRow>
        <div className="split-list">{lines.map((l) => { const q = L(l); const all = q >= N(l.qty_req); return (
          <div key={l.id} className={`split-row ${q > 0 ? 'on' : ''}`}>
            <span className="grow"><b>{l.model || l.req_model}</b> <span className="muted small">{l.category || ''}</span></span>
            <span className="small muted">共 {qty(l.qty_req)} 片</span>
            <span className="small">这次发 <b>{qty(N(l.qty_req) - q)}</b></span>
            <span className="row" style={{ gap: 4 }}><span className="small">以后发</span><MoneyIn className="in" inputMode="numeric" style={{ width: 84 }} value={q || ''} placeholder="0" onChange={(e) => setQ(l, e.target.value)} /></span>
            <button type="button" className={`chip ${all ? 'on' : ''}`} onClick={() => setQ(l, all ? 0 : l.qty_req)}>{all ? '整行以后发 ✓' : '整行以后发'}</button>
          </div>); })}</div>
        <FRow label="备注"><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 等下周到货 / 客户分两次付款" /></FRow>
      </div>
    </Modal>
  );
}
// 251 / 259 (Frank 11-12): 客户档位中方还没确认 → 报价按最贵档 (Repair) 先存成草稿, 不能发给客户;
// 员工点「申请定级」→ 中方待办紧急段; 中方在这里直接定档 → 报价自动按新档位重算, 才能联系客户确认
function TierGate({ deal, info, act, role }) {
  const { org } = useApp();
  const [tier, setTier] = useState(''); const [note, setNote] = useState(''); const [code, setCode] = useState('');
  const asked = !!deal.tier_requested_at;
  const prospect = deal.customer_status !== 'active';
  const nextNo = useData(() => (prospect && role === 'admin' ? q(`select coalesce(max(substring(code from '[0-9]+')::int), 0) + 1 as n from app.customers where org_id = $1 and code ~ '^CI[0-9]+$'`, [org]) : Promise.resolve([])), [org, prospect, role]).data;
  useEffect(() => { if (!code && nextNo?.[0]?.n) setCode('CI' + String(nextNo[0].n).padStart(4, '0')); }, [nextNo]);   // eslint-disable-line react-hooks/exhaustive-deps
  const setIt = async () => {
    try {
      if (prospect) await act('已转成正式客户', `select app.activate_customer($1,$2,$3,null)`, [deal.customer_id, code.trim().toUpperCase(), tier]);
      await act('档位已定，报价已按新档位重算', `select app.confirm_customer_tier($1,$2,'confirm',null,$3)`, [deal.customer_id, tier, note || null]);
      if (deal.approval === 'pending') await act('新客户这张单也一并批了', `select app.approve_quote($1,true,$2)`, [deal.id, '新客户，已定档位']);
    } catch { /* act 已经提示 */ }
  };
  return (
    <div className="card">
      <div className="card-h"><h2>联系客户确认</h2><span className="pill amber">草稿 · 等中方定档位</span></div>
      <div className="card-b two">{info}
        <div className="panel stack">
          <div className="hint">这个客户的档位中方还没确认，报价现在按<b>最贵档（Repair）</b>显示，<b>先不要发给客户</b>。中方定了档位，价格会自动重算，才能联系客户确认。超过 7 天没人动的草稿会自动作废（可恢复）。</div>
          {role === 'admin' ? (<>
            <FRow label="定档位" req><Choice value={tier} onChange={(k) => setTier(k)} options={Object.entries(TIERS)} renderOpt={tierOpt} /></FRow>
            <FRow label="备注"><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 看了店铺照片，按零售店" /></FRow>
            {deal.tier_request_note && <div className="small muted">员工说：{deal.tier_request_note}</div>}
            {prospect && <FRow label="客户编码" req><input className="in" style={{ width: 140 }} value={code} onChange={(e) => setCode(e.target.value)} /><span className="small muted">潜客定档 = 转成正式客户，系统给了下一个号，可改（和金蝶 / 飞书一致）</span></FRow>}
            <div className="actbar">{(!tier || (prospect && !code.trim())) && <span className="why">{!tier ? '选一个档位' : '填客户编码'}</span>}<button type="button" className="btn primary" disabled={!tier || (prospect && !code.trim())} onClick={setIt}>确认档位 ✓</button></div>
          </>) : asked ? (
            <div><span className="pill amber">已申请定级 · {dt(deal.tier_requested_at)}</span> <span className="small muted">中方的待办紧急段已经有这一条，定了你的待办会收到。</span></div>
          ) : (<>
            <FRow label="给中方的话"><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 客户在 Adjamé 有两个档口，量不小" /></FRow>
            <div className="actbar"><button type="button" className="btn primary" onClick={() => act('已申请定级，中方会在待办里看到', `select app.request_tier($1,$2,$3)`, [deal.customer_id, deal.id, note || null]).catch(() => {})}>申请定级 →</button></div>
          </>)}
        </div>
      </div>
    </div>
  );
}
function BadDebtModal({ deal, act, onClose }) {
  const [amt, setAmt] = useState(String(N(deal.due)));
  const [reason, setReason] = useState('');
  const [proof, setProof] = useState('');
  const ok = N(amt) > 0 && N(amt) <= N(deal.due) && reason.trim() && proof;
  return (
    <Modal title={`坏账核销：${deal.biz_no}`} risk="red" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">{!reason.trim() ? '写原因' : !proof ? '传凭证' : `金额 1 – ${money(deal.due, deal.currency)}`}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={() => act(`已核销坏账 ${money(amt, deal.currency)}`, `select app.write_off_bad_debt($1,$2,$3,$4)`, [deal.id, N(amt), reason, proof || null]).then(onClose, () => {})}>确认核销</button></>}>
      <div className="stack">
        <div className="hint">确认这笔钱收不回来才核销。核销后客户总账减少，但记录永久保留（谁、什么时候、多少、为什么），以后客户又付了照常登记收款。</div>
        <FRow label="核销金额" req><MoneyIn className="in" inputMode="decimal" style={{ width: 150 }} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">{deal.currency}，本单还欠 {money(deal.due, deal.currency)}</span></FRow>
        <FRow label="原因" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 客户跑路、店已关" /></FRow>
        <FRow label="凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="聊天记录 / 照片" camera={false} /></div></FRow>
        <ImpactFor dealId={deal.id} delta={-N(amt)} note={`坏账核销 −${money(N(amt), deal.currency)}`} />
      </div>
    </Modal>
  );
}
function WriteOffModal({ deal, act, onClose }) {
  const [r, setR] = useState(NOTE_OPTIONS.writeoff[0]);
  return (
    <Modal title={`抹零：${deal.biz_no}`} risk="red" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!r?.trim()} onClick={() => act('已抹零，本单结清', `select app.write_off($1,$2,$3)`, [deal.id, N(deal.due), r]).then(onClose, () => {})}>确认抹零 {money(deal.due, deal.currency)} {deal.currency}</button></>}>
      <div className="stack"><div className="hint">只限尾差（≤ 100 XOF）；会记入客户流水，客户对账看得到。</div><OptNote optKey="note_writeoff" title="抹零原因" options={NOTE_OPTIONS.writeoff} value={r} onChange={setR} /><ImpactFor dealId={deal.id} delta={-N(deal.due)} note={`抹零 −${money(deal.due, deal.currency)}`} /></div>
    </Modal>
  );
}

// ───────────────────────── 退货（按原单原行）+ 退货对账 ─────────────────────────
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const RT_STATUS = (r) => (r.status === 'requested' ? ['待中方审批', 'amber'] : r.status === 'rejected' ? ['已驳回', 'gray']
  : r.lines.every((x) => N(x.qty_good) + N(x.qty_scrap) >= N(x.qty)) ? ['已批准 · 已冲账 · 已检验入库', 'green'] : ['已批准 · 已冲账 · 待检验', 'blue']);
export function ReturnPanel({ deal, lines, returns, act, role }) {
  const { toast } = useApp();
  const [form, setForm] = useState(null);
  const cur = deal.currency;
  const pendingQty = (l) => returns.filter((r) => r.status === 'requested').flatMap((r) => r.lines).filter((x) => x.deal_line_id === l.id).reduce((a, x) => a + N(x.qty), 0);
  const maxOf = (l) => N(l.qty_shipped) - N(l.qty_returned) - pendingQty(l);
  const returnable = lines.filter((l) => maxOf(l) > 0);
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>退货 <Info>必须挂原订单、原行；审批后才生效</Info></h2>
          <div className="row">{can(role, 'request_return') ? <>{!returnable.length && <span className="why">这张单还没有可退的出库行</span>}<button type="button" className="btn primary" disabled={!returnable.length} onClick={() => setForm({ type: 'quality', reason: NOTE_OPTIONS.return[0], q: {}, at: localNow(), photo: '' })}>＋ 收到退货，发起退货</button></> : <Blocked action="request_return" />}</div></div>
        {returns.length === 0 && <div className="empty">这张单还没有退货。一次退多张单的货，请到「客户总账」→「按客户退货」。</div>}
      </div>
      {returns.map((r) => <ReturnRecon key={r.id} r={r} deal={deal} act={act} role={role} />)}
      {form && (
        <Modal wide title={`按原单退货 · ${deal.biz_no}`} onClose={() => setForm(null)}
          footer={<><button type="button" className="btn" onClick={() => setForm(null)}>取消</button>
            <button type="button" className="btn primary" onClick={async () => {
              const ls = Object.entries(form.q).filter(([, v]) => N(v) > 0).map(([line_id, v]) => ({ line_id, qty: N(v) }));
              if (!ls.length) return toast('请填写至少一行退货数量', 'err');
              const over = returnable.find((l) => N(form.q[l.id]) > maxOf(l));
              if (over) return toast(`${over.model} 最多可退 ${maxOf(over)}`, 'err');
              if (!form.reason) return toast('请选择或填写退货原因', 'err');
              if (form.type === 'other' && !form.typeNote?.trim()) { setForm({ ...form, errs: true }); return toast('选了「其他」要写清楚是什么', 'err'); }
              if (!form.photo) { setForm({ ...form, errs: true }); return toast('收到退货要拍实物照片（不是盒子）', 'err'); }
              const ty = optSubmit('return_types', form.type); await act('退货已登记，等中方审批', `select app.set_opt_label('return_reason', app.request_return($1,$2,$3,$4,null,$5,$6), $7)`, [deal.id, ty.base, form.type === 'other' ? `其他：${form.typeNote.trim()} · ${form.reason}` : form.reason, JSON.stringify(ls), new Date(form.at).toISOString(), form.photo, ty.label]).then(() => { showDone({ kind: 'ret', deal: deal.id }); setForm(null); }, () => {});
            }}>提交退货申请</button></>}>
          <div className="stack">
            <div className="card card-b" style={{ background: 'var(--amber-bg)' }}><b>① 收到退货</b> <span className="small muted">收到货才做退货单；没收到不做</span>
              <div className="row" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="field req"><label>收到退货的时间</label><input className="in" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} /></div>
                <div className="field req"><label>实物照片（不是盒子；少量要看得清几片，多量拍整体）</label><PhotoInput value={form.photo} onChange={(v) => setForm({ ...form, photo: v })} invalid={form.errs && !form.photo} label="拍退回的货" /></div>
              </div></div>
            <b>② 退的什么、为什么</b>
            <div className="field req"><label>退货类型</label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><OptChoice optKey="return_types" title="退货类型" bases={RETURN_BASES} value={form.type} onChange={(k) => setForm({ ...form, type: k })} options={Object.entries(RETURN_REASONS)} />
                {form.type === 'other' && <input className={`in ${form.errs && !form.typeNote?.trim() ? 'invalid' : ''}`} style={{ width: 260 }} autoFocus value={form.typeNote || ''} onChange={(e) => setForm({ ...form, typeNote: e.target.value })} placeholder="「其他」是什么？（必填）" />}</div></div>
            <div className="field req"><label>具体原因</label><OptNote optKey="note_return" title="退货的具体原因" options={NOTE_OPTIONS.return} value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} /></div>
            <Grid id="return-form" noTools columns={[
              { key: 'code', label: '编码', w: 60 }, { key: 'category', label: '种类', w: 90 }, { key: 'model', label: '型号', w: 100, render: (l) => <ModelLink id={l.product_id} model={l.model} /> },
              { key: 'qty_shipped', label: '出库数量', w: 70, render: (l) => qty(l.qty_shipped) },
              { key: 'rq', label: '本次退货数量', w: 120, edit: (l) => ({ type: 'number', value: form.q[l.id] || '', placeholder: '0',
                invalid: N(form.q[l.id]) > maxOf(l), hint: N(form.q[l.id]) > maxOf(l) ? <span className="red-t">最多可退 {maxOf(l)}</span> : (maxOf(l) < N(l.qty_shipped) ? `最多可退 ${maxOf(l)}` : null),
                onChange: (v) => setForm({ ...form, q: { ...form.q, [l.id]: v.replace(/\D/g, '') } }) }) },
            ]} rows={returnable} />
            <div className="hint">批准后：货先进待检仓、客户总账冲减退货金额（已付过的转成预付款）。检验后好货回原仓，坏货进报废仓。不做换货：要新货请另开新单。</div>
          </div>
        </Modal>
      )}
    </>
  );
}

// 退货对账（单独一块）：明细 + 对本单的影响 + 客户总账前后 + 复制图片 / 打印 / 导出 (待改 42)
function ReturnRecon({ r, deal, act, role }) {
  const { toast } = useApp();
  const [reconProof, setReconProof] = useState('');
  const cur = deal.currency;
  const [st, tone] = RT_STATUS(r);
  const amt = r.lines.reduce((a, x) => a + N(x.qty) * N(x.unit_price), 0);
  const approved = r.status === 'approved';
  const recNow = N(deal.shipped_amount) - N(deal.returned_amount);
  const recBefore = approved ? recNow + amt : recNow;
  const recAfter = recBefore - amt;
  const balNow = N(deal.customer_balance);
  const balBefore = approved ? balNow + amt : balNow;
  const balAfter = balBefore - amt;
  const exportCsv = async () => {
    const rows = [['编码', '种类', '型号', '退货数量', `单价 ${cur}`, `金额 ${cur}`], ...r.lines.map((x) => [x.code, x.category, x.model, x.qty, x.unit_price, N(x.qty) * N(x.unit_price)]), ['合计', '', '', r.lines.reduce((a, x) => a + N(x.qty), 0), '', amt]];
    const tsv = rows.map((x) => x.join('\t')).join('\n');
    try {
      const blob = new Blob(['﻿' + rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${r.rt_no}.csv`; a.click();
      const okc = await copyToClipboard(tsv);
      toast(okc ? '已导出 CSV（Excel 可直接打开），表格也已复制，可直接粘贴进 Excel' : '已导出 CSV（Excel 可直接打开）；浏览器没让复制表格');
    } catch { toast('导出失败', 'err'); }
  };
  const [decide, setDecide] = useState(null);
  const allInspected = r.lines.every((x) => N(x.qty_good) + N(x.qty_scrap) >= N(x.qty));
  const doneRecon = !!r.reconciled_at;
  const stepTone = (ok, cur) => (ok ? 'green' : cur ? 'amber' : 'gray');
  return (
    <div className="card">
      <div className="card-h">
        <h2>退货单 <span className="mono">{r.rt_no}</span>{r.batch_no && <span className="muted small"> · 批次 {r.batch_no}</span>}</h2>
        <div className="row" style={{ gap: 6 }}>
          <Pill tone={stepTone(true)}>① 已收货</Pill><Pill tone={stepTone(approved && allInspected, approved || r.status === 'requested')}>② 对账 · 核验</Pill><Pill tone={stepTone(doneRecon, approved)}>③ 客户对账</Pill>
          {r.status === 'rejected' && <Pill tone="gray">已驳回</Pill>}
        </div>
      </div>
      {/* ① 收到退货 */}
      <div className="card-b" style={{ borderBottom: '1px solid var(--line-2)' }}>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <b>① 收到退货</b>
          <span className="small">收到时间 <b>{r.received_at ? dt(r.received_at) : '—（旧单没记）'}</b></span>
          {r.received_photo ? <Thumb src={r.received_photo} size={40} label={`${r.rt_no} 退回实物`} /> : <span className="small muted">没有实物照片</span>}
          <span className="small muted">{optName('return_types', r.reason_type, RETURN_REASONS, r.reason_label)} · {r.reason} · 登记 {dt(r.requested_at)}</span>
          <span className="grow" />
          <Pill tone={tone}>{st}</Pill>
          {r.status === 'requested' && (can(role, 'decide_return') ? <>
            <button type="button" className="btn sm" onClick={() => setDecide('reject')}>驳回</button>
            <button type="button" className="btn sm primary" onClick={() => setDecide('approve')}>批准</button></> : <Blocked action="decide_return" />)}
        </div>
        {(r.late || r.reason_type === 'customer_damage' || r.decide_note) && <div className="row small" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          {r.late && <Pill tone="amber">签收后 {Math.round((new Date(r.received_at) - new Date(r.signed_ref)) / 36e5)} 小时才反馈（超过 24 小时）</Pill>}
          {r.reason_type === 'customer_damage' && r.status === 'requested' && <Pill tone="amber">人为损坏，原则上不认</Pill>}
          {r.decide_note && <span className="muted">{r.status === 'rejected' ? '驳回原因' : '中方说明'}：{r.decide_note}</span>}
        </div>}
        {decide && <ReturnDecide r={r} mode={decide} act={act} onClose={() => setDecide(null)} />}
      </div>
      {/* ② 对账 + 核验 */}
      <div className="card-b" style={{ paddingBottom: 0 }}><b>② 对账 + 核验</b> <span className="small muted">金额按原单价冲；检验好货回原仓、坏货报废</span></div>
      <Grid id="deal-return-lines" noTools columns={[
        { key: 'code', label: '编码', w: 60 }, { key: 'category', label: '种类', w: 90 }, { key: 'model', label: '型号', w: 100, render: (x) => <ModelLink id={x.product_id} model={x.model} /> },
        { key: 'qty', label: '退货数量', w: 70 }, { key: 'unit_price', label: `单价 ${cur}`, w: 90, render: (x) => money(x.unit_price, cur) },
        { key: 'amt', label: `金额 ${cur}`, w: 110, value: (x) => N(x.qty) * N(x.unit_price), render: (x) => <b>{money(N(x.qty) * N(x.unit_price), cur)}</b> },
        { key: 'qty_good', label: '检验：好货回原仓', w: 120 }, { key: 'qty_scrap', label: '检验：坏货报废', w: 110 },
        { key: 'inspect', label: '', w: 170, render: (x) => (approved && N(x.qty_good) + N(x.qty_scrap) < N(x.qty) && can(role, 'inspect_return') ? <InspectButtons x={x} act={act} /> : '') },
      ]} rows={r.lines} foot={(rows) => ({ code: '合计', qty: `${qty(rows.reduce((a, x) => a + N(x.qty), 0))} 件`, amt: `${money(amt, cur)} ${cur}` })} />
      <div className="card-b"><AcctImpact fmt={(n) => `${money(n, cur)} ${cur}`} docLabel="本单应收（退货前 → 退货后）" doc={{ before: recBefore, after: recAfter }} ledger={{ before: balBefore, after: balAfter }} note={`退货 −${money(amt, cur)}`} ledgerNote={approved ? `退货 −${money(amt, cur)}` : '审批通过后才生效'} /></div>
      {/* ③ 和客户对账: 所见即所得 + 一个按钮 (退货对账 + Balance 合一) */}
      <div className="card-b" style={{ borderTop: '1px solid var(--line-2)' }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <span><b>③ 和客户对账</b> <span className="small muted">下面就是发客户群的那张图（本单 + 总欠款前后）</span></span>
          <span className="row" style={{ gap: 6 }}>
            <DocActions kind="return" deal={deal} ret={{ ...r, amount: amt, recBefore, recAfter, balBefore, balAfter, statusText: st }} copyLabel="复制退货对账图片（含总账）" primary="copy" />
            <button type="button" className="btn" onClick={exportCsv}>⇩ 导出 Excel</button>
          </span>
        </div>
        <div className="doc-preview"><div className="doc-preview-in"><DocSheet kind="return" deal={deal} ret={{ ...r, amount: amt, recBefore, recAfter, balBefore, balAfter, statusText: st }} /></div></div>
      </div>
      {/* ④ 客户对账凭证 → 对账完成 (Frank 11-09 14:03: 先发对账单, 客户对完给凭证, 截图放这里, 最后才点完成) */}
      {approved && (
        <div className="card-b" style={{ borderTop: '1px solid var(--line-2)' }}>
          <div style={{ marginBottom: 8 }}><b>④ 客户对账凭证 → 对账完成</b> <span className="small muted">把上面的图发给客户；客户认没认要有记录：通话截图或 WhatsApp 截图放这里，再点「对账完成」</span></div>
          {doneRecon ? (
            <div className="row" style={{ gap: 10 }}>{r.reconciled_proof ? <Thumb src={r.reconciled_proof} size={48} label={`${r.rt_no} 客户对账凭证`} /> : <span className="small muted">（旧单，没有凭证）</span>}<Pill tone="green">对账完成 {dt(r.reconciled_at)}</Pill></div>
          ) : can(role, 'mark_received') ? (
            <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field req"><label>客户确认凭证（通话截图 / WhatsApp 截图）</label><PhotoInput value={reconProof} onChange={setReconProof} label="放客户确认截图" /></div>
              <span className="grow" />
              {!reconProof && <span className="why">还差：客户确认凭证 ←</span>}
              <button type="button" className="btn primary lg" disabled={!reconProof}
                title={!reconProof ? '先放客户确认凭证' : ''}
                onClick={() => act('退货对账完成，这张退货单结束', `select app.return_reconciled($1,$2)`, [r.id, reconProof]).then(() => setReconProof(''), () => {})}>对账完成 ✓</button>
            </div>
          ) : <div className="hint">等热线 / 主管放客户对账凭证并点对账完成。</div>}
          {!doneRecon && <div className="hint" style={{ marginTop: 6 }}>对完账这张退货单才算完成，没对完会一直挂在待办里。{!allInspected ? '还有没检验完的行：不影响对账完成，会单独挂在仓库待办里。' : ''}</div>}
          {doneRecon && !allInspected && <div className="why" style={{ marginTop: 6 }}>账已对完；还有行没检验 → 到上面 ② 的「检验」里填好货 / 坏货数量</div>}
        </div>
      )}
    </div>
  );
}

function InspectButtons({ x, act }) {
  const left = N(x.qty) - N(x.qty_good) - N(x.qty_scrap);
  const [g, setG] = useState(String(left));
  return (
    <span className="row" style={{ gap: 4 }}>
      好<input className="cell-in" style={{ width: 54, border: '1px solid var(--line)' }} value={g} onChange={(e) => setG(e.target.value.replace(/\D/g, ''))} />
      <button type="button" className="btn sm" onClick={() => act('检验完成', `select app.inspect_return_line($1,$2,$3)`, [x.id, Math.min(N(g), left), left - Math.min(N(g), left)]).catch(() => {})}>检验</button>
    </span>
  );
}


// ───────────────────────── ④ 复检打包 · 发货文件 · 出库 (Frank 11-09 第 19 条: 三块一步, 顺序 复检 → 打印文件 → 出库) ─────────────────────────
export function ShipStepPanel(props) {
  const { deal, lines, role } = props;
  const docsOpen = ['reviewed', 'partial', 'shipped'].includes(deal.status);
  return (
    <>
      <ReviewPanel {...props} />
      {docsOpen && <DocsBlock deal={deal} lines={lines} role={role} />}
      <ShipPanel {...props} />
    </>
  );
}
function DocsBlock({ deal, lines, role }) {
  const left = lines.filter((l) => l.product_id && N(l.qty_supply) > N(l.qty_shipped));
  const pending = ['reviewed', 'partial'].includes(deal.status) && left.length > 0;
  const pseudo = pending ? { id: null, bl_no: deal.next_bl_no, shipped_at: new Date(), lines: left.map((l) => ({ deal_line_id: l.id, qty: N(l.qty_supply) - N(l.qty_shipped) })), qty: left.reduce((a, l) => a + N(l.qty_supply) - N(l.qty_shipped), 0), amount: left.reduce((a, l) => a + (N(l.qty_supply) - N(l.qty_shipped)) * N(l.unit_price), 0) } : null;
  const [setOpen, setSetOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-h"><h2>发货文件 <Info>打包完先打印，随货走；BL 编号出库时自动落到出库单上。海关 PDF、G&S logo、单据名称在旁边 ⚙ 里换（同一份也在「规则参数 → 系统」）。</Info></h2>
        {role === 'admin' && <button type="button" className="gear-btn" title="发货文件设置：海关 PDF / logo / 单据名称" onClick={() => setSetOpen(true)}>⚙</button>}</div>
      {setOpen && <Modal title="发货文件设置" onClose={() => setSetOpen(false)} footer={<button type="button" className="btn" onClick={() => setSetOpen(false)}>关闭</button>}><DocSettings /></Modal>}
      <div className="card-b stack" style={{ gap: 8 }}>
        {pending ? (
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small">这批待出库 <b>{qty(pseudo.qty)}</b> 件{deal.next_bl_no ? <> · BL 编号 <b className="mono">{deal.next_bl_no}</b></> : <span className="muted"> · 还没出 BL 编号（点「BL ×2」自动出）</span>}</span>
            <BlActions shipment={pseudo} deal={deal} lines={lines} pending />
          </div>
        ) : <div className="hint">{deal.status === 'shipped' ? '全部出库完。每批的 BL / 海关文件在下面出库记录里可以重打。' : '复检打包完成后，这里出 BL ×2 和海关文件。'}</div>}
        <div className="hint">「BL」点开预览再打印，一次两张 = 一张仓库备案、一张客户签字（客户签字那张拍照回传，在「签收 · 对账」步挂上）；「海关文件」= 上传的固定 PDF（标题旁 ⚙ 换）。大单（金额或件数到规则参数里的阈值）会提示建议打印，小单不强制。</div>
      </div>
    </div>
  );
}

// ───────────────────────── ⑤ 签收 · 对账 (Frank 11-09 第 18 条: 出库后不直接到收款; 客户签收 (时间 + 照片) + Balance 发群, 全部签收才到收款) ─────────────────────────
export function SignPanel({ deal, shipments, events, act, role, others, discs = [], lines = [] }) {
  const live = shipments.filter((s) => !s.voided_at);
  const unsigned = live.filter((s) => !s.customer_received_at);
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>① 客户签收 <Info>出库后打电话或发 WhatsApp 问客户收到货没有；客户发了照片就传照片，没有就传 WhatsApp 聊天截图或通话截图。签收后接着做下面的 ② 和客户对账。</Info> <RuleGear title="收货差异时限" ids={['disc.hours']} /></h2>
          {unsigned.length ? <span className={`pill ${unsigned.length < live.length ? 'amber' : 'red'}`}>还有 {unsigned.length} 批没签收</span> : live.length ? <span className="pill green">已签收</span> : <span className="muted small">还没出库</span>}</div>
        <div className="card-b two">
          <CustomerInfo deal={deal} />
          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            {live.length === 0 ? <div className="card-b muted small">还没出库</div> : live.map((s) => <SignRow key={s.id} s={s} act={act} role={role}  discs={discs.filter((x) => x.shipment_id === s.id)} lines={lines} deal={deal} />)}
          </div>
        </div>
      </div>
      {live.length > 0 && <BalancePreview customerId={deal.customer_id} currency={deal.currency} deal={deal} title={`② 和客户对账 · ${deal.customer_name}`} />}
      {live.length > 0 && <BalanceConfirm deal={deal} events={events} act={act} role={role} unsigned={unsigned.length} others={(others || []).filter((o) => o.balance_pending)} openDisc={discs.filter((x) => x.status === 'open').length} />}
    </>
  );
}
// ③ 客户确认对账 (Frank 11-11 16:34, 迁移 0036): 跟报价确认 / 退货对账一样 —— 客户信息 + 确认方式 + 确认截图; 之后又签收了新一批要重新对
function BalanceConfirm({ deal, events, act, role, unsigned, others = [], openDisc = 0 }) {
  const [also, setAlso] = useState(() => new Set(others.map((o) => o.id)));   // 238: Balance 是按客户出的 → 一张截图可以同时勾掉这个客户所有待对账的单
  const [method, setMethod] = useState('');
  const [proof, setProof] = useState('');
  const [note, setNote] = useState('');
  const [errs, setErrs] = useState(false);
  const e = evOf(events || [], 'balance_confirmed');
  const done = deal.balance_confirmed_at && !deal.balance_pending;
  const go = async () => {
    setErrs(true); if (!method || !proof) return;
    const ids = [deal.id, ...others.filter((o) => also.has(o.id)).map((o) => o.id)];
    await act(ids.length > 1 ? `客户已确认对账 ✓（${ids.length} 张单一起）` : '客户已确认对账 ✓', `select app.confirm_balance(x, $2, $3, $4) from unnest($1::uuid[]) x`, [`{${ids.join(',')}}`, method, proof, note || null]).catch(() => {});
  };
  return (
    <div className="card">
      <div className="card-h"><h2>③ 客户确认对账 <Info>把上面的 Balance 发客户群，客户回复确认（或电话确认）后，选确认方式、传截图。之后又签收了新的一批，要重新对一次。</Info></h2>
        {done ? <span className="row" style={{ gap: 6 }}><span className="pill green">已对账</span><Who e={e} /></span> : unsigned ? <span className="pill amber">先签收</span> : <span className="pill red">待对账</span>}</div>
      {done ? (
        <div className="card-b kv">
          <div><div className="k">确认方式</div><div className="v">{CONFIRM_METHODS[deal.balance_method] || '（以前的单，默认已对账）'}</div></div>
          <div><div className="k">时间</div><div className="v" style={{ fontSize: 15 }}>{dt(deal.balance_confirmed_at)}</div></div>
          <div><div className="k">备注</div><div className="v" style={{ fontSize: 15 }}>{deal.balance_note || '—'}</div></div>
          <div><div className="k">截图</div><div className="v">{deal.balance_proof ? <Thumb src={deal.balance_proof} size={56} label="对账截图" /> : <span className="muted small">未传</span>}</div></div>
        </div>
      ) : (
        <div className="card-b two">
          <CustomerInfo deal={deal} />
          {unsigned ? <div className="panel"><span className="why">还有 {unsigned} 批没签收，签收完再对账</span></div>
            : openDisc ? <div className="panel"><span className="pill red">有 {openDisc} 张收货差异等中方处理，处理完才能对账</span></div>
            : can(role, 'balance_confirm') ? (
              <div className="panel">
                {deal.balance_confirmed_at && <div className="pill amber" style={{ marginBottom: 8 }}>上次对账后又签收了新的一批，要重新对一次</div>}
                <div className="fgrid">
                  <FRow label="确认方式" req><OptChoice optKey="confirm_methods" title="确认方式" value={method} onChange={(k) => setMethod(k)} options={Object.entries(CONFIRM_METHODS)} err={errs && !method} /></FRow>
                  <FRow label="确认截图" req><PhotoInput value={proof} onChange={setProof} invalid={errs && !proof} label="客户回复确认的 WhatsApp / 通话截图" /></FRow>
                  <FRow label="备注"><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="例如 客户说月底一起付" /></FRow>
                  {others.length > 0 && <FRow label="一起对掉"><div className="stack" style={{ gap: 4 }}>
                    <span className="small muted">这个客户还有 {others.length} 张单待对账。Balance 上是他所有的单，客户这次确认的就是全部 —— 勾上的一起记成已对账：</span>
                    {others.map((o) => <label key={o.id} className="row" style={{ gap: 6 }}><input type="checkbox" checked={also.has(o.id)} onChange={() => { const n = new Set(also); n.has(o.id) ? n.delete(o.id) : n.add(o.id); setAlso(n); }} /><span className="mono">{o.biz_no}</span></label>)}
                  </div></FRow>}
                </div>
                <div className="actbar">{(!method || !proof) && <span className="why">还差：{[!method && '确认方式', !proof && '确认截图'].filter(Boolean).join('、')}</span>}<button type="button" className="btn primary lg" onClick={go}>客户已确认对账 ✓</button></div>
              </div>
            ) : <div className="panel"><Blocked action="balance_confirm" /></div>}
        </div>
      )}
    </div>
  );
}
const DISC_KIND = { short: '少了', over: '多了', wrong: '发错型号', damaged: '破损' };
const DISC_DECISION = { credit: '认了，已从账上扣', reship: '认了，补发', reject: '不认' };
export const DISC_WHERE = { in_warehouse: '还在仓库（少发了）', lost: '丢了 / 找不到', with_customer: '在客户那里', unknown: '还没查清' };
// 273 (Frank 11-12): 每个机型只有一个「客户最终收到几片」; 这批已经处理过差异的机型, 再报 = 在上次认定的数上修正 (只中方), 账只动差额
export const discBase = (discs, lineId, shipped) => { const hit = [...(discs || [])].filter((d) => d.status === 'decided' && ['credit', 'reship'].includes(d.decision)).sort((x, y) => new Date(y.decided_at) - new Date(x.decided_at)).map((d) => d.lines.find((l) => l.deal_line_id === lineId)).find(Boolean); return hit ? N(hit.received) : N(shipped); };
function DiscModal({ s, lines, act, onClose, discs = [], role }) {
  const mine = (s.lines || []).map((sl) => ({ ...sl, line: lines.find((l) => l.id === sl.deal_line_id), base: discBase(discs, sl.deal_line_id, sl.qty) })).filter((x) => x.line);
  const fixing = mine.some((x) => x.base !== N(x.qty));
  const [kind, setKind] = useState('short');
  const [recv, setRecv] = useState(() => Object.fromEntries(mine.filter((x) => x.base !== N(x.qty)).map((x) => [x.deal_line_id, String(x.base)])));
  const [proof, setProof] = useState(''); const [note, setNote] = useState('');
  const changed = mine.filter((x) => recv[x.deal_line_id] !== undefined && recv[x.deal_line_id] !== '' && (N(recv[x.deal_line_id]) !== x.base || (x.base === N(x.qty) && ['wrong', 'damaged'].includes(kind))));
  const fixHit = changed.some((x) => x.base !== N(x.qty));
  const why = fixHit && role !== 'admin' ? '这个机型的差异已经处理过，要改只能中方来改' : !changed.length ? (fixing ? '把「客户最终收到」改成正确的数' : '填客户实际收到多少') : !proof ? '传客户给的凭证' : fixHit && !note.trim() ? '修正要写原因' : '';
  const go = () => act(fixHit ? '已记下修正，等中方确认' : '已记下收货差异，等中方处理', `select app.report_discrepancy($1,$2,$3,$4,$5)`, [s.id, kind, JSON.stringify(changed.map((x) => ({ deal_line_id: x.deal_line_id, received: N(recv[x.deal_line_id]) }))), proof, note || null]).then(onClose, () => {});
  return (
    <Modal title={`${fixing ? '收货差异 · 修正' : '收货差异'} · ${s.out_no}`} wide onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{why && <span className="why">{why}</span>}<button type="button" className="btn primary" disabled={!!why} onClick={go}>{fixHit ? '提交修正' : '报给中方'}</button></>}>
      <div className="stack">
        <div className="hint">原来的出库单不改。这里记下客户<b>最终</b>实际收到多少，<b>差一片也要中方处理</b>。{fixing && <> 标黄的机型之前已经处理过：直接把数改成正确的，系统只补扣或冲回<b>差的那部分</b>，之前的记录都留着。</>}</div>
        <FRow label="类型" req><OptChoice optKey="disc_kind" title="差异类型" fixed value={kind} onChange={(k) => setKind(k)} options={Object.entries(DISC_KIND)} /></FRow>
        <Grid id="disc-lines" noTools rows={mine} rowKey={(x) => x.deal_line_id} columns={[
          { key: 'model', label: '型号', w: 150, render: (x) => <b>{x.line.model}</b> },
          { key: 'category', label: '种类', w: 90, render: (x) => x.line.category },
          { key: 'qty', label: '出库数量', w: 90, render: (x) => qty(x.qty) },
          ...(fixing ? [{ key: 'base', label: '现在认定收到', w: 120, render: (x) => (x.base !== N(x.qty) ? <span className="pill amber">{qty(x.base)}（已处理过）</span> : qty(x.base)) }] : []),
          { key: 'recv', label: fixing ? '客户最终收到' : '客户实收', w: 120, edit: (x) => ({ type: 'number', value: recv[x.deal_line_id] ?? '', onChange: (v) => setRecv((r) => ({ ...r, [x.deal_line_id]: String(v ?? '').replace(/\D/g, '') })) }) },
          { key: 'diff', label: fixing ? '这次变化' : '差', w: 130, render: (x) => { const r = recv[x.deal_line_id]; if (r === undefined || r === '') return ''; const d = N(r) - x.base; if (d === 0) return <span className="pill gray">没变</span>; return x.base !== N(x.qty) ? <span className={`pill ${d < 0 ? 'red' : 'amber'}`}>{d < 0 ? `再少 ${-d} → 补扣` : `多回 ${d} → 冲回`}</span> : <span className="pill red">{d > 0 ? '多 ' : '少 '}{Math.abs(d)}</span>; } },
        ]} />
        <FRow label="客户凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="开箱照片 / 视频截图 / 聊天截图" /></div></FRow>
        <FRow label={fixHit ? '修正原因' : '说明'} req={fixHit}><input className="in" style={{ width: '100%', maxWidth: 460 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={fixHit ? '例如 客户重新数了 / 客户在另一个箱子里找到了' : '客户怎么说的'} /></FRow>
      </div>
    </Modal>
  );
}
// 一行差异怎么念: 第一次 = 发 11 收 10; 修正 = 认定收到 10 → 9
export const discLineText = (l) => (l.base != null && N(l.base) !== N(l.shipped) ? `${l.model} 认定收到 ${l.base} → ${l.received}（发 ${l.shipped}）` : `${l.model} 发 ${l.shipped} 收 ${l.received}`);
export const discMoneyText = (x, cur) => (N(x.amount) > 0 ? `${x.corrects ? '补扣' : '值'} ${money(x.amount, cur)} ${cur || ''}` : N(x.amount) < 0 ? `冲回 ${money(-N(x.amount), cur)} ${cur || ''}` : '');
// 272 (Frank 11-12): 认 / 不认 分两块; 只要发错就记复检人 (默认带出这张单的复检人), 别的责任方要中方自己改
function DiscDecide({ x, s, deal, act, onClose }) {
  const fix = !!x.corrects;
  const reviewer = deal.reviewer_name || '';
  const dflt = `复检没查出来${reviewer ? `（复检人 ${reviewer}）` : ''}`;
  const [decision, setDecision] = useState(''); const [fault, setFault] = useState(dflt); const [where, setWhere] = useState(''); const [note, setNote] = useState('');
  const other = fault.trim() && fault !== dflt;
  const lateNeed = x.late && decision && decision !== 'reject' && !note.trim();
  const ok = decision && fault.trim() && where && (decision !== 'reject' || note.trim()) && (!other || decision === 'reject' || note.trim()) && !lateNeed;
  const go = () => act('收货差异已处理', `select app.decide_discrepancy($1,$2,$3,$4,$5)`, [x.id, decision, fault, where, note || null]).then(onClose, () => {});
  const Chip = ({ k, children }) => <button type="button" className={`chip ${decision === k ? 'on' : ''}`} onClick={() => setDecision(k)}>{children}</button>;
  return (
    <Modal title={`处理收货差异${fix ? '（修正）' : ''} · ${s.out_no}`} wide onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!ok && <span className="why">还差：{[!decision && '怎么处理', !fault.trim() && '谁的问题', !where && '货在哪', decision === 'reject' && !note.trim() && '不认的原因', other && decision !== 'reject' && !note.trim() && '不算复检人的理由', lateNeed && '超过 24 小时的破例原因'].filter(Boolean).join('、')}</span>}<button type="button" className="btn primary" disabled={!ok} onClick={go}>确定</button></>}>
      <div className="stack">
        <div className="pd-sec disc-say"><div className="pd-h">{fix ? '这次修正' : '客户说的'} {x.late && <span className="pill amber">超过 24 小时才反馈，属于特批</span>}</div>
          <div>{DISC_KIND[x.kind]}：{x.lines.map((l) => <span key={l.deal_line_id} className="pill red" style={{ marginRight: 6 }}>{discLineText(l)}</span>)} {N(x.amount) !== 0 && <b>{discMoneyText(x, deal.currency)}</b>}</div>
          {x.note && <div className="small muted">{x.note}</div>}</div>
        <div className="pd-sec"><div className="pd-h">对照片 <Info>左边是我们每一步拍的，右边是客户给的。先看照片再定。</Info></div>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {[['初检', deal.pick_photo_path], ['复检打包', deal.review_photo_path], ['发货', s.proof_path], ['签收', s.signed_photo], ['客户凭证', x.proof]].map(([l, src]) => <div key={l} className="stack" style={{ gap: 4, alignItems: 'center' }}><span className="small muted">{l}</span>{src ? <Thumb src={src} size={84} label={l} /> : <span className="pill gray">没有</span>}</div>)}
          </div></div>
        <div className="disc-choice">
          <div className={`disc-box yes ${['credit', 'reship'].includes(decision) ? 'on' : ''}`}><div className="disc-box-h">认</div>
            <div className="chips"><Chip k="credit">{N(x.amount) < 0 ? '认：把之前扣的冲回去' : '从客户账上扣掉'}</Chip>{!fix && <Chip k="reship">补发</Chip>}</div></div>
          <div className={`disc-box no ${decision === 'reject' ? 'on' : ''}`}><div className="disc-box-h">不认</div>
            <div className="chips"><Chip k="reject">不认</Chip></div></div>
        </div>
        <FRow label="谁的问题" req><div className="stack" style={{ gap: 6, flex: 1 }}>
          <div className="chips"><button type="button" className={`chip ${fault === dflt ? 'on' : ''}`} onClick={() => setFault(dflt)}>{dflt}</button>
            {['找货少数 / 拿错', '运输途中丢 / 坏', '客户自己的问题', '工厂原盒就少', '还没查清'].map((v) => <button type="button" key={v} className={`chip ${fault === v ? 'on' : ''}`} onClick={() => setFault(v)}>{v}</button>)}</div>
          <input className="in" style={{ width: '100%', maxWidth: 460 }} value={fault} onChange={(e) => setFault(e.target.value)} placeholder="写清楚是哪个环节、谁" />
          <div className="small muted">规矩：只要发错（少发 / 多发 / 发错型号），默认记复检人的责任。要算到别处，在下面「说明」里写清理由。</div></div></FRow>
        <FRow label="货现在在哪" req><OptChoice optKey="disc_where" title="货在哪" fixed value={where} onChange={(k) => setWhere(k)} options={Object.entries(DISC_WHERE)} /></FRow>
        {where === 'in_warehouse' && decision !== 'reject' && N(x.amount) > 0 && <div className="hint">选「还在仓库」：系统会把少发的数量加回库存。</div>}
        {decision === 'reject' && <div className="chips">{RETURN_REJECT.map((v) => <button type="button" key={v} className={`chip ${note === v ? 'on' : ''}`} onClick={() => setNote(v)}>{v}</button>)}</div>}
        {x.late && <div className="hint">签收超过 24 小时才反馈，原则上不认；要认必须在「说明」里写破例原因。</div>}
        <FRow label="说明" req={decision === 'reject' || (other && decision !== 'reject') || (x.late && decision && decision !== 'reject')}><input className="in" style={{ width: '100%', maxWidth: 460 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={decision === 'reject' ? '不认必须写原因' : other ? '为什么不算复检人的责任' : '补充说明（会记进操作记录）'} /></FRow>
      </div>
    </Modal>
  );
}
/* Q7 (Frank 11-16): 损坏反馈 24 小时 —— 超时 / 人为损坏原则上不认, 中方破例必须写原因; 驳回也必须写原因 */
const RETURN_REJECT = ['人为摔坏 / 压坏（裂痕、变形）', '装过机（拆装痕迹、胶印）', '拿不出照片 / 视频', '和我们发的批次 / 标签对不上', '签收超过 24 小时才反馈'];
function ReturnDecide({ r, mode, act, onClose }) {
  const [note, setNote] = useState('');
  const needs = mode === 'reject' || r.late || r.reason_type === 'customer_damage';
  const why = r.reason_type === 'customer_damage' ? '人为损坏原则上不认' : r.late ? '签收超过 24 小时才反馈，原则上不认' : '';
  const go = () => { if (needs && !note.trim()) return; act(mode === 'approve' ? '已批准：货进待检仓，总账已冲减' : '已驳回', `select app.decide_return($1,$2,$3)`, [r.id, mode === 'approve', note.trim() || null]).then(onClose, () => {}); };
  return (
    <Modal title={`${mode === 'approve' ? '批准' : '驳回'}退货 ${r.rt_no}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className={`btn ${mode === 'approve' ? 'primary' : ''}`} disabled={needs && !note.trim()} onClick={go}>{mode === 'approve' ? (why ? '破例批准' : '批准') : '驳回'}</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="small">{optName('return_types', r.reason_type, RETURN_REASONS, r.reason_label)} · {r.reason}{r.received_at && <> · 收到 {dt(r.received_at)}</>}{r.signed_ref && <> · 签收 {dt(r.signed_ref)}</>}</div>
        {mode === 'approve' && why && <div className="hint">{why}。要批准，写清楚为什么破例（例：老板出差，货先到、只说收到没点数，回来点货才发现）。</div>}
        {mode === 'approve' && !why && <div className="small muted">批准后：货进待检仓，客户账减掉退货金额。</div>}
        {mode === 'reject' && <div className="chips">{RETURN_REJECT.map((v) => <button type="button" key={v} className={`chip ${note === v ? 'on' : ''}`} onClick={() => setNote(v)}>{v}</button>)}</div>}
        <FRow label={mode === 'reject' ? '驳回原因' : '说明'} req={needs}><input className="in" style={{ width: '100%', maxWidth: 460 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'reject' ? '选上面一条或自己写' : why ? '破例原因（必填）' : '补充说明（可不填）'} /></FRow>
      </div>
    </Modal>
  );
}
const CONFIRM_ROLE = { boss: '老板', staff: '店员', sales: '销售员', driver: '运货员', other: '其他人' };
const SIGN_ROLES = [['boss', '老板'], ['staff', '店员'], ['sales', '销售员'], ['other', '其他人']];   // 409: 顺序 Frank 定
const normDigits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
function SignRow({ s, act, role, discs = [], lines = [], deal }) {
  const [disc, setDisc] = useState(false); const [decide, setDecide] = useState(null);
  const [photo, setPhoto] = useState('');
  const [at, setAt] = useState(() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); });
  const [errs, setErrs] = useState(false);
  /* Q7 (Frank 11-16) + 409 (11-18): 谁收的货就跟谁确认 —— 先选身份 (老板 / 店员 / 销售员 / 其他人), 再从客户联系人里选人 (名字电话自动带出);
     选「销售员」= 自动带出这个客户的归属销售员. 电话不再强制 (填了要位数对), 确认人 + 签收凭证就够. 新的人签收后自动进客户联系人. */
  const { toast } = useApp();
  const [who, setWho] = useState({ role: '', name: '', phone: '' });
  const known = useContacts(!s.customer_received_at ? deal?.customer_id : null);
  const setRoleOf = (r) => { const hit = known.filter((c) => c.role === r); setWho(hit.length === 1 ? { ...hit[0], phone: hit[0].phone ? fmtPhone(hit[0].phone) : '' } : { role: r, name: '', phone: '' }); };
  const phoneBad = !!who.phone?.trim() && !phoneValid(who.phone);
  const missing = [!who.role && '跟谁确认的（身份）', !who.name?.trim() && '确认人名字', phoneBad && '电话位数不对', !photo && !s.signed_photo && '签收凭证'].filter(Boolean);
  const go = (withDisc) => { setErrs(true); if (missing.length) return toast(`签收还差：${missing.join('、')}`, 'err'); act(`${s.out_no} 已签收`, `select app.sign_receipt($1,$2,$3,$4,$5,$6)`, [s.id, photo || null, new Date(at).toISOString(), who.name.trim(), who.phone || '', who.role]).then(() => { rememberContact(role, deal?.customer_id, who); if (withDisc === true) setDisc(true); }, () => {}); };
  const hours = s.customer_received_at ? (Date.now() - new Date(s.customer_received_at).getTime()) / 36e5 : 0;
  return (
    <div className="signrow">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <b className="mono">{s.out_no}</b>{s.bl_no && <span className="muted small">{s.bl_no}</span>}
        <span className="small muted">出库 {dt(s.shipped_at)} · {optName('ship_methods', s.method, SHIP_METHODS, s.method_label)} · {qty(s.qty)} 件</span>
        {s.customer_received_at && <><Pill tone="green">已签收 {dt(s.customer_received_at)}</Pill>{s.signed_photo && <Thumb src={s.signed_photo} size={34} label={`${s.out_no} 签收凭证`} />}
          {s.confirm_name && <span className="small muted">跟 <b>{s.confirm_name}</b>（{optName('sign_roles', s.confirm_role, CONFIRM_ROLE)}{s.confirm_phone ? <> · <a href={telHref(s.confirm_phone)}>{fmtPhone(s.confirm_phone)}</a></> : null}）确认过数量</span>}</>}
      </div>
      {!s.customer_received_at && (can(role, 'mark_received') ? (
        <>
          <div className="fgrid" style={{ marginTop: 8 }}>
            <FRow label="签收时间" req><input className="in" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ width: 210 }} /></FRow>
            <FRow label="跟谁确认的" req><div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <OptChoice optKey="sign_roles" title="跟谁确认的（身份）" value={who.role} onChange={setRoleOf} options={SIGN_ROLES} flat={false} placeholder="选身份：老板 / 店员 / 销售员…" err={errs && !who.role} />
              {who.role && <ContactPick customerId={deal?.customer_id} value={who} onChange={(c) => setWho({ ...c, role: c.role || who.role })} errs={errs} askRole={false} placeholder="选是哪一位（可以搜名字 / 电话）" />}
              <div className="small muted">谁收的货就跟谁确认数量；老板不在国内，就跟店员确认。电话可以不填；新的人会自动存进客户档案的联系人。</div></div></FRow>
            <FRow label="签收凭证" req><PhotoInput value={photo} onChange={setPhoto} invalid={errs && !photo} label="客户照片 / WhatsApp / 通话截图" /></FRow>
          </div>
          <div className="actbar">{missing.length > 0 && <span className="why">还差：{missing.join('、')}</span>}<button type="button" className="btn soft-amber" onClick={() => go(true)}>⚠ 收到了，但客户说数量 / 型号不对…</button><button type="button" className="btn primary" onClick={() => go(false)}>客户已签收（全部收到）→</button></div>
        </>) : <Blocked action="mark_received" />)}
      {/* 240 (Frank 11-11): 客户说少了 / 发错了 → 记一张收货差异单, 差一片也必须中方处理; 原出库单不改 */}
      {discs.map((x) => (
        <div key={x.id} className={`disc-row ${x.status === 'open' ? 'open' : ''}`}>
          <span className={`pill ${x.status === 'open' ? 'red' : x.decision === 'reject' ? 'gray' : 'amber'}`}>{x.corrects ? '修正 · ' : '收货差异 · '}{x.status === 'open' ? '等中方处理' : N(x.amount) < 0 && x.decision === 'credit' ? '认了，已冲回' : DISC_DECISION[x.decision]}</span>
          <span className="small">{DISC_KIND[x.kind]}：{x.lines.map(discLineText).join('；')}{N(x.amount) !== 0 && <> · <b>{discMoneyText(x, deal?.currency)}</b></>}</span>
          {x.late && <span className="pill amber">超过 24 小时才反馈</span>}
          <Thumb src={x.proof} size={34} label="客户给的凭证" />
          {x.status === 'decided' && <span className="small muted">责任：{x.fault} · 货：{DISC_WHERE[x.goods_where]}{x.decide_note ? ` · ${x.decide_note}` : ''}</span>}
          {x.status === 'open' && role === 'admin' && <button type="button" className="btn sm primary" onClick={() => setDecide(x)}>处理</button>}
        </div>))}
      {s.customer_received_at && can(role, 'mark_received') && !discs.some((x) => x.status === 'open') && (
        <div className="row" style={{ marginTop: 6 }}><button type="button" className="btn sm soft-amber" onClick={() => setDisc(true)}>{discs.some((x) => x.status === 'decided' && x.decision !== 'reject') ? '⚠ 收到的数量还要再改（修正）' : '⚠ 客户说收到的不对（少了 / 多了 / 发错 / 破损）'}</button>{hours > 24 && <span className="small muted">已过 24 小时，报上去要中方特批</span>}</div>)}
      {disc && <DiscModal s={s} lines={lines} act={act} discs={discs} role={role} onClose={() => setDisc(false)} />}
      {decide && <DiscDecide x={decide} s={s} deal={deal} act={act} onClose={() => setDecide(null)} />}
    </div>
  );
}
