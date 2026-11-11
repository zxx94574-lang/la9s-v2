// The panels of one deal. Each workflow step has its own panel: the action when it is the current step,
// a read-only record once it has been pushed (待改 13). Every button calls exactly one SQL business function.
import PeoplePick from '../components/PeoplePick.jsx';
import { fmtPhone, telHref } from '../lib/phone.js';
import React, { useMemo, useRef, useState } from 'react';
import Grid from '../components/Grid.jsx';
import { call } from '../db/client.js';
import LineEntry, { newKey, finalizeLines, tierPrice } from '../components/LineEntry.jsx';
import { DocActions, DocSheet, BalanceCopy, BalancePreview } from '../components/Doc.jsx';
import { BlActions } from '../components/Bl.jsx';
import ReceiptForm, { BalanceLine, VoidReceiptModal } from '../components/ReceiptForm.jsx';
import { Modal, Shared, Pill, CopyButton, copyToClipboard, PhotoInput, Thumb, OptionNote, DatePicker, BigNum, useApp, useHistory, UndoBar, Info, FRow , PhoneInput, phoneValid} from '../components/ui.jsx';
import { can, whoCan, seesPrice, dealPriceVisible, NOTE_OPTIONS, SHIP_METHODS, PAY_METHODS, RETURN_REASONS, CONFIRM_METHODS, CHECK_RESULTS, priceLevel, getThresholds, balanceWords } from '../lib/domain.js';
import { money, qty, dt, dDate, today, pad, ymd } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';

const N = (v) => Number(v || 0);
const Blocked = ({ action }) => <span className="lock">当前岗位不能操作，需要：{whoCan(action)}</span>;
const evOf = (events, action) => [...events].reverse().find((e) => e.action === action);
const Who = ({ e }) => (e ? <span className="muted">{e.short_name || '—'} · {dt(e.at)}</span> : null);

// common read-only columns
function baseCols({ price, cur, extra = [] }) {
  return [
    { key: 'seq', label: '#', w: 34 },
    { key: 'code', label: '编码', w: 64, render: (l) => (l.code ? <span className="mono">{l.code}</span> : <Pill tone="amber">未建档</Pill>) },
    { key: 'category', label: '种类', w: 100 },
    { key: 'model', label: '型号', w: 100, render: (l) => <><ModelLink id={l.product_id} model={l.model} />{l.variant && <span className="muted small"> {l.variant}</span>}</> },
    { key: 'shared', label: '通用性', w: 150, render: (l) => <Shared list={l.shared_models} /> },
    ...extra,
    ...(price ? [{ key: 'unit_price', label: `单价 ${cur}`, w: 130, render: (l) => <span className="row" style={{ gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>{money(l.unit_price, cur)}<LowTag l={l} />{l.price_manual && <span className="pill amber">手改</span>}{l.requested_price != null && <span className="pill amber">申请 {money(l.requested_price, cur)}</span>}</span> }] : []),
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
    { key: 'qty_available', label: '可售', w: 60, render: (l) => (l.product_id ? <b style={{ color: N(l.qty_available) < N(l.qty_req) && editable ? 'var(--red)' : '' }}>{qty(l.qty_available)}</b> : '—') },
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
          <h2>① 报价 · 确认 <span className="muted small mono">{deal.quote_no}</span></h2>
          {editable && can(role, 'quote') && <button type="button" className="btn" onClick={startEdit}>✎ 修改报价（增删行）</button>}
          {editable && can(role, 'cancel') && <CancelButton deal={deal} act={act} />}
        </div>
        <div className="row">
          {price && <DocActions kind="quote" deal={deal} lines={lines} copyLabel="复制报价图片" primary="copy" />}
        </div>
      </div>
      <Grid id="deal-quote" table="deal_lines" columns={cols} rows={lines} rowClass={(l) => (!l.product_id ? 'manual' : '')}
        foot={(rows) => ({ code: '合计', model: `${rows.length} 个型号`, qty_req: `${qty(rows.reduce((a, l) => a + N(l.qty_req), 0))} 件`,
          amount: `${money(rows.reduce((a, l) => a + N(l.qty_req) * N(l.unit_price), 0), cur)} ${cur}` })} />
      {lines.some((l) => !l.product_id) && <div className="card-b hint">黄色行 = 我们没建档的型号：单价 0、不会出货，已自动记入「未满足需求」。</div>}
      {editable && <div className="card-b hint" style={{ borderTop: '1px solid var(--line-2)' }}>下推找货之前都可以在原单上改；下推之后这一页只读，要改请先「撤回到上一步」。</div>}
    </div>
  );
}

function CancelButton({ deal, act }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('客户不要了');
  return (
    <>
      <button type="button" className="btn danger" onClick={() => setOpen(true)}>作废订单</button>
      {open && <Modal title={`作废 ${deal.biz_no}`} onClose={() => setOpen(false)}
        footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>不作废</button>
          <button type="button" className="btn primary" onClick={() => act(['picked', 'ordered', 'confirmed', 'reviewed'].includes(deal.status) ? '已作废：请把已拿出的货放回原库位（预占已释放）' : '订单已作废，预占已释放（可在「订单总览 → 已作废」恢复）', `select app.cancel_deal($1,$2)`, [deal.id, reason]).then(() => setOpen(false), () => {})}>确认作废</button></>}>
        <div className="stack">
          <div className="hint">作废不是删除：单子进「已作废」列表，随时可以恢复。</div>
          <OptionNote options={['客户不要了', '价格谈不拢', '重复下单', '其他']} value={reason} onChange={setReason} />
        </div>
      </Modal>}
    </>
  );
}

// ───────────────────────── ① 下半: 确认 (Frank 11-08: 报价 + 热线确认合为一步; 谁能建报价谁能确认, 主管兼热线) ─────────────────────────
// 客户信息卡 (确认 / 签收共用, Frank 11-09: 签收也要有电话方便打)
export function CustomerInfo({ deal }) {
  // 左栏客户信息竖排 (11-09 195): 打电话前一眼看全
  const { role } = useApp();
  const phone = deal.customer_phone || '';
  return (
    <div className="panel info">
      <dl className="infolist">
        <dt>客户</dt><dd><CustLink id={deal.customer_id} name={deal.customer_name} /> <span className="mono muted small">{deal.customer_code || deal.temp_code}</span></dd>
        <dt>负责人</dt><dd>{deal.customer_contact || '—'}</dd>
        <dt>电话</dt><dd>{phone ? <><a href={telHref(phone)}>{fmtPhone(phone)}</a><CopyButton text={fmtPhone(phone)} what="电话" /></> : '—'}</dd>
        <dt>城市</dt><dd>{deal.city || '—'}</dd>
        <dt>销售员</dt><dd>{deal.owner_name || '—'}</dd>
        {Number(deal.customer_balance) > 0 && seesPrice(role) && <><dt>欠款</dt><dd style={{ color: 'var(--red)' }}>{money(deal.customer_balance)} XOF</dd></>}
        {deal.source === 'guest' && <><dt>来源</dt><dd><Pill tone="amber">游客询价</Pill> {deal.guest_info?.shop || ''}</dd></>}
      </dl>
    </div>);
}

export function ConfirmBlock({ deal, events, act, role }) {
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
            {canPush ? <button type="button" className="btn primary lg" onClick={() => act('已下推找货，库存已预占', `select app.start_picking($1)`, [deal.id]).catch(() => {})}>下推找货 · 初检 →</button> : <Blocked action="start_picking" />}</div>)}
      </div>
    );
  }
  if (deal.approval === 'pending') return <div className="card"><div className="card-h"><h2>联系客户确认</h2></div><div className="card-b two">{info}<div className="panel"><span className="why">等中方审批（上面黄条），批了才能确认、下推找货</span></div></div></div>;
  const wantOn = when === 'today' ? today() : when === 'tomorrow' ? ymd(new Date(Date.now() + 864e5)) : when === 'date' ? date : null;
  const go = async () => {
    setErrs(true);
    if (!method || !when || (when === 'date' && !date)) return;
    const push = when === 'today';
    await act(push ? '已确认并下推找货，库存已预占' : '已确认，到客户要货那天待办会前移', `select app.quote_confirm($1,$2,$3,$4,$5,$6)`, [deal.id, note || null, method, proof || null, wantOn, push]).catch(() => {});
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
              <FRow label="确认方式" req><div className="chips">{Object.entries(CONFIRM_METHODS).map(([k, v]) => <button type="button" key={k} className={`chip ${method === k ? 'on' : ''} ${errs && !method ? 'err' : ''}`} onClick={() => setMethod(k)}>{v}</button>)}</div></FRow>
              <FRow label="什么时候要" req><div className="chips">{[['today', '今天要'], ['tomorrow', '明天要'], ['date', '改天']].map(([k, l]) => <button type="button" key={k} className={`chip ${when === k ? 'on' : ''} ${errs && !when ? 'err' : ''}`} onClick={() => setWhen(k)}>{l}</button>)}</div>
                {when === 'date' && <DatePicker value={date || null} onChange={setDate} label={date ? '' : '选日期'} />}</FRow>
              <FRow label="结果"><OptionNote options={NOTE_OPTIONS.hotline} value={note} onChange={setNote} /></FRow>
              <FRow label="截图"><PhotoInput value={proof} onChange={setProof} label="WhatsApp 截图（可选）" /></FRow>
            </div>
            <div className="actbar">
              <button type="button" className="btn" title="客户现在忙、没法确认：单子留在这一步、进待办，提醒照旧" onClick={() => act('已记：客户稍后再联系，这张单留在待办里', `select app.hotline_busy($1,$2)`, [deal.id, note || null]).catch(() => {})}>客户现在忙，稍后再联系</button>
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
        <div className="card-h"><h2>② 找货 · 初检</h2></div>
        <div className="card-b hint">还没下推：先在「① 报价 · 确认」里确认客户要货并下推，库存预占后找货人在这里填实际供货、拍照、提交初检。</div>
      </div>
    );
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
        <h2>② 找货 · 初检 <span className="muted small mono">{deal.pick_no}</span></h2>
        <div className="row">{picking && part === 'picked' && <UndoBar h={h} scope={scope} />}<DocActions kind="pick" deal={deal} lines={real} hideCopy printLabel="打印找货单" primary="print" /></div>
      </div>
      <Grid id="deal-pick" table="deal_lines" columns={cols} rows={real} rowClass={(l) => (N(l.qty_supply) < N(l.qty_req) ? 'warn' : '')}
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
  const { toast, org } = useApp();
  const real = lines.filter((l) => l.product_id && N(l.qty_supply) > 0);
  const reviewing = deal.status === 'confirmed';
  const [reviewer, setReviewer] = useState('');   // 复核人候选: 中方在 ⚙ 里勾 (第 15 条)
  const [photo, setPhoto] = useState('');
  const [dup, setDup] = useState([]);
  const [rv, setRv] = useState({}); // line -> {qty, reason, check, note}
  const h = useHistory(rv, setRv);
  const scope = useRef();
  const [errs, setErrs] = useState(false);
  const get = (l) => rv[l.id] || { qty: String(l.qty_supply), reason: '', check: '', note: '' };
  const set = (l, patch, what) => h.commit({ ...rv, [l.id]: { ...get(l), ...patch } }, `${l.model} ${what}`);
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

  const e = evOf(events, 'pick_reviewed');
  const cols = [
    ...baseCols({ price: false }),
    { key: 'bin', label: '库位', w: 70 },
    { key: 'qty_picked', label: '订单数量', w: 80, value: (l) => l.qty_supply, render: (l) => qty(l.qty_supply) },
    { key: 'rqty', label: '复检数量', w: 100, ...(reviewing
      ? { edit: (l) => ({ type: 'number', value: get(l).qty, invalid: errs && N(get(l).qty) > N(l.qty_supply), onChange: (v) => set(l, { qty: v.replace(/\D/g, '') }, '改复检数量') }) }
      : { value: (l) => l.qty_supply, render: (l) => <b style={{ color: N(l.qty_supply) < N(l.qty_picked ?? l.qty_supply) ? 'var(--red)' : 'var(--green)' }}>{qty(l.qty_supply)}</b> }) },
    { key: 'rreason', label: '复检差异原因', w: 130, ...(reviewing
      ? { edit: (l) => (N(get(l).qty) < N(l.qty_supply) ? { type: 'select', value: get(l).reason, invalid: errs && !get(l).reason, options: [['', '请选原因'], ...NOTE_OPTIONS.review_diff.map((x) => [x, x])], onChange: (v) => set(l, { reason: v }, '选原因') } : null), render: () => '' }
      : { render: (l) => (l.diff_reason?.startsWith('复核') ? l.diff_reason : '') }) },
    { key: 'suggest', label: '建议抽检', w: 110, render: (l) => (suggest.has(l.id) ? <Pill tone="amber">{suggest.get(l.id)}</Pill> : '') },
    { key: 'check', label: '抽检结果', w: 130, ...(reviewing
      ? { edit: (l) => ({ type: 'select', value: get(l).check, invalid: errs && get(l).check && get(l).check !== 'ok' && !get(l).note && N(get(l).qty) === N(l.qty_supply),
          options: [['', '未抽检'], ...Object.entries(CHECK_RESULTS)], onChange: (v) => set(l, { check: v }, '抽检') }) }
      : { render: (l) => (l.checks?.length ? l.checks.map((c, i) => <Pill key={i} tone={c.result === 'ok' ? 'green' : 'red'}>{CHECK_RESULTS[c.result]}{c.note ? ` · ${c.note}` : ''}</Pill>) : <span className="muted small">未抽检</span>) }) },
    ...(reviewing ? [{ key: 'cnote', label: '抽检说明', w: 140, edit: (l) => (get(l).check && get(l).check !== 'ok' ? { type: 'text', value: get(l).note, placeholder: '有问题必写', onChange: (v) => set(l, { note: v }, '抽检说明') } : null), render: () => '' }] : []),
  ];
  const submit = async () => {
    setErrs(true);
    if (!reviewer) return toast('请选复核人', 'err');
    if (!photo) return toast('请拍打包照片', 'err');
    const actual = []; const checks = [];
    for (const l of real) {
      const a = get(l);
      if (N(a.qty) > N(l.qty_supply)) return toast(`${l.model} 复检数量不能超过订单数量`, 'err');
      if (N(a.qty) < N(l.qty_supply)) { if (!a.reason) return toast(`${l.model} 复检少了，请选原因`, 'err'); actual.push({ line_id: l.id, qty: N(a.qty), reason: a.reason }); }
      if (a.check) {
        if (a.check !== 'ok' && !a.note && N(a.qty) === N(l.qty_supply)) return toast(`${l.model} 抽检有问题：改复检数量或写说明`, 'err');
        checks.push({ line_id: l.id, result: a.check, note: a.note || null });
      }
    }
    await act(actual.length ? '复检有变动：已退回热线，请客户重新确认变动的行' : '复检打包完成，可以出库', `select app.review_pick($1,$2,$3,$4,$5)`, [deal.id, reviewer, photo, JSON.stringify(actual), JSON.stringify(checks)]).then(() => dup.length && flagAnomaly(role, org, deal.id, 'ship', `打包照片和 ${dup.join('、')} 是同一张图，请核实`), () => {});
  };
  return (
    <div className="card" ref={scope}>
      <div className="card-h"><h2>④-1 复检 + 打包 <Info>客户确认后由主管抽检、打包；打完包出发货文件，再出库</Info></h2>
        <div className="row">{reviewing ? <UndoBar h={h} scope={scope} /> : <Who e={e} />}</div></div>
      <Grid id="deal-review" table="deal_lines" columns={cols} rows={real} rowClass={(l) => (suggest.has(l.id) && reviewing ? 'suggest' : '')}
        foot={(rows) => ({ code: '合计', qty_picked: `${qty(rows.reduce((a, l) => a + N(l.qty_picked ?? l.qty_supply), 0))} 件`,
          rqty: `${qty(rows.reduce((a, l) => a + N(reviewing ? get(l).qty : l.qty_supply), 0))} 件` })} />
      {reviewing ? (
        <div className="card-b" style={{ borderTop: '1px solid var(--line-2)' }}>
          {can(role, 'review_pick') ? (
            <div className="row" style={{ gap: 18, alignItems: 'flex-end' }}>
              <PeoplePick step="review" label="复核人" employees={employees} value={reviewer} onChange={setReviewer} errs={errs} />
              <div className="field req"><label>打包照片（打包好的货）</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs} label="拍打包照片" onDup={setDup} /></div>
              <span className="grow" />
              <button type="button" className="btn primary lg" onClick={submit}>复检打包完成 →</button>
            </div>
          ) : <Blocked action="review_pick" />}
          <div className="hint" style={{ marginTop: 8 }}>不用每盒拆：黄色「建议抽检」的行抽 2–3 盒，选结果即可。少了就改「复检数量」并选原因：单子会退回热线，只让客户重新确认变动的行。</div>
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
  if (!l.product_id || !(Number(l.unit_price) > 0)) return null;
  const px = Number(l.unit_price) * (Number(l.fx_rate) > 0 ? Number(l.fx_rate) : 1);
  if (role === 'admin' && Number(l.cost_xof) > 0 && px < Number(l.cost_xof)) return '会亏';
  if (Number(l.s_xof) > 0 && px < Number(l.s_xof)) return '低于底价';
  if (Number(l.tier_xof) > 0 && px < Number(l.tier_xof)) return '低于档位';
  return null;
};
// 208 三色: 会亏 = 红 (肯定有问题); 低于底价 / 低于档位 = 黄 (没亏, 要留意)
export const flagTone = (fl) => (fl === '会亏' ? 'red' : 'amber');
const LowTag = ({ l }) => { const { role } = useApp(); const fl = lowFlag(l, role); return fl ? <span className={`pill ${flagTone(fl)}`}>{fl}</span> : null; };
const PriceTag = ({ l, cur }) => {
  const { role } = useApp();
  const { level, pct } = priceLevel(l.unit_price, l.tier_price);
  if (!l.product_id) return null;
  if (level === 4) return <Pill tone="red">单价 0</Pill>;
  const fl = lowFlag(l, role);
  if (fl) return <span className={`pill ${flagTone(fl)}`} title={`本档 ${money(l.tier_xof)} · S 档 ${money(l.s_xof)} XOF${role === 'admin' && l.cost_xof ? ` · 成本 ${money(l.cost_xof)}` : ''}`}>{fl}</span>;
  if (!level) return null;
  return <span className={`dev dev${level}`} title={`档位价 ${money(l.tier_price, cur)}`}>{pct < 0 ? '低' : '高'} {Math.abs(pct).toFixed(0)}%</span>;
};
export function SoPanel({ deal, lines, catalog, categories, act, role, events }) {
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
  const saveQty = async (l) => {
    const o = open[l.id];
    if (!(N(o.qty) >= 0) || o.qty === '') return toast('请填数量', 'err');
    await act(`${l.model} 数量已改为 ${o.qty}${N(o.qty) === 0 ? '（预占已释放）' : ''}`, `select app.change_line_qty($1,$2,$3)`, [l.id, N(o.qty), o.reason]).catch(() => null);
    setOpen((x) => { const n = { ...x }; delete n[l.id]; return n; });
  };
  const cols = [
    ...baseCols({ price: false }),
    { key: 'qty_req', label: '需求数量', w: 70, render: (l) => qty(l.qty_req) },
    { key: 'qty_supply', label: '供货数量', w: 110, ...(canQty ? {
      edit: (l) => (open[l.id] ? { type: 'number', value: open[l.id].qty, title: `原因：${open[l.id].reason}`, onChange: (v) => setOpen({ ...open, [l.id]: { ...open[l.id], qty: v.replace(/\D/g, '') } }),
        hint: <span className="row" style={{ gap: 4 }}><button type="button" className="linkbtn" onClick={() => saveQty(l)}>保存</button><button type="button" className="linkbtn" onClick={() => setOpen((x) => { const n = { ...x }; delete n[l.id]; return n; })}>取消</button></span> } : null),
      render: (l) => <span className="row" style={{ gap: 6, justifyContent: 'center' }}><b>{qty(l.qty_supply)}</b>{N(l.qty_shipped) > 0 && <span className="small muted">已出 {l.qty_shipped}</span>}</span> }
      : { render: (l) => <b>{qty(l.qty_supply)}</b> }) },
    ...(price ? [
      { key: 'unit_price', label: `单价 ${cur}`, w: 170, render: (l) => (
        <span className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>{money(l.unit_price, cur)}<PriceTag l={l} cur={cur} />{l.price_manual && <span className="pill amber sm-pill">手改</span>}
          {(pricing || afterSo) && can(role, 'set_price') && l.product_id && <button type="button" className="btn sm icon-btn" title="改价（中方直接生效，留痕）" onClick={() => setPriceLine(l)}>✎</button>}</span>) },
      { key: 'amount', label: `金额 ${cur}`, w: 120, value: (l) => N(l.qty_supply) * N(l.unit_price), render: (l) => <b>{money(N(l.qty_supply) * N(l.unit_price), cur)}</b> },
    ] : []),
    { key: 'lock', label: '', w: 110, sortable: false, filterable: false, render: (l) => {
      if (!canQty || open[l.id]) return l.added_after_pick ? <Pill tone="blue">追加</Pill> : '';
      if (l.added_after_pick) return <button type="button" className="btn sm" onClick={() => setOpen({ ...open, [l.id]: { qty: String(l.qty_supply), reason: '追加行改数量' } })}>✎ 改数量</button>;
      return <button type="button" className="btn sm" title="已有的行默认锁住；选原因后才能改" onClick={() => setUnlock(l)}>🔒 解锁修改</button>;
    } },
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
          <h2>③ 销售订单 <span className="muted small mono">{deal.so_no || '（初检后生成）'}</span> <Info>出了单把图发群，下面接客户确认</Info></h2>
          {canAdd && <button type="button" className="btn" onClick={() => setAdding([])}>＋ 出库前追加货</button>}
        </div>
        <div className="row">
          {deal.so_no && price && <DocActions kind="so" deal={deal} lines={lines} copyLabel="复制销售单图片" primary="copy" />}
        </div>
      </div>
      {pricing && price && (
        <div className="grid-tools" style={{ borderBottom: 0 }}>
          <button type="button" className="btn sm" disabled={!sel.size} onClick={async () => {
            const r = await act('已按档位重新带价（手改价不覆盖）', `select app.refresh_prices($1,$2)`, [deal.id, [...sel]]).catch(() => null);
            if (r) setSel(new Set());
          }}>↻ 获取价格（选中 {sel.size} 行）</button>{!sel.size && <span className="why">先勾选要重新带价的行</span>}
          <Info>先勾选行再获取；手改价不会被覆盖。改价只有中方能操作；和档位价偏差 ≥{th[0]}% 黄、≥{th[1]}% 橙、≥{th[2]}% 红。</Info>
        </div>
      )}
      {afterSo && canQty && <div className="grid-tools" style={{ borderBottom: 0 }}><span className="small muted">已有行默认锁住</span><Info>点「🔒 解锁修改」选原因后才能改数量（改完自动锁回、留记录）；出库前追加的新行可直接改。</Info></div>}
      <Grid id="deal-so" table="deal_lines" columns={cols} rows={real} rowClass={(l) => (l.review_changed ? 'changed' : priceLevel(l.unit_price, l.tier_price, th).level >= 3 && l.product_id ? 'warn' : l.price_manual ? 'manual' : '')}
        selectable={pricing && price ? { selected: sel, onChange: setSel } : null}
        foot={(rows) => ({ code: '合计', model: `${rows.filter((l) => N(l.qty_supply) > 0).length} 个型号`, qty_supply: `${qty(rows.reduce((a, l) => a + N(l.qty_supply), 0))} 件`,
          amount: price ? `${money(rows.reduce((a, l) => a + N(l.qty_supply) * N(l.unit_price), 0), cur)} ${cur}` : '' })} />
      {price && (
        <div className="sumbar">
          <div className="s"><div className="k">共发</div><div className="v">{qty(totQ)} 件</div></div>
          <div className="s"><div className="k">订单金额</div><BigNum size={22}>{money(totA, cur)} {cur}</BigNum></div>
        </div>
      )}
      {pricing && (
        <div className="actionbar">
          <span className="hint">{zero.length ? <b className="red-t">有 {zero.length} 行单价为 0，不能下推</b> : risky.length ? <b className="red-t">{risky.length} 行价格偏差 ≥{th[2]}%，下推时会再提醒</b> : manual.length ? `有 ${manual.length} 行手动改价，生成前会再确认一次。` : '价格按客户档位自动带出。'}</span>
          {can(role, 'sales_order') ? <button type="button" className="btn primary lg" onClick={create}>生成销售订单 →</button> : <Blocked action="sales_order" />}
        </div>
      )}
      {priceLine && <PriceModal line={priceLine} cur={cur} onClose={() => setPriceLine(null)}
        onSave={(p, r) => act('已改价，已标记「手改」', `select app.set_line_price($1,$2,$3)`, [priceLine.id, p, r]).then(() => setPriceLine(null), () => {})} />}
      {unlock && <UnlockModal line={unlock} onClose={() => setUnlock(null)} onOk={(reason) => {
        setOpen({ ...open, [unlock.id]: { qty: reason === '客户不要了' ? '0' : String(unlock.qty_supply), reason } }); setUnlock(null);
        toast(`已解锁 ${unlock.model}：改好数量点「保存」`);
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

function UnlockModal({ line, onClose, onOk }) {
  const [r, setR] = useState(NOTE_OPTIONS.unlock[0]);
  return (
    <Modal title={`解锁修改：${line.model} ${line.category}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!r?.trim()} onClick={() => onOk(r)}>解锁</button></>}>
      <div className="stack">
        <div className="hint">改完自动锁回，并记录「谁、何时、从多少改成多少、原因」。「客户不要了」= 数量改为 0，预占释放。已确认的单改完要客户重新确认。</div>
        <OptionNote options={NOTE_OPTIONS.unlock} value={r} onChange={setR} placeholder="其他原因（必填）" />
      </div>
    </Modal>
  );
}

function PriceModal({ line, cur, onClose, onSave }) {
  const [p, setP] = useState(String(N(line.unit_price)));
  const [r, setR] = useState('');
  const [ok, setOk] = useState(false);
  const { level, pct } = priceLevel(p === '' ? NaN : N(p), line.tier_price);
  const opts = level === 4 ? ['赠品', '样品'] : NOTE_OPTIONS.price;
  const qtyN = N(line.qty_supply);
  const needOk = level >= 2 && level < 4;
  const disabled = p === '' || !(N(p) >= 0) || !r?.trim() || (needOk && !ok) || (level === 4 && !['赠品', '样品'].includes(r));
  return (
    <Modal title={`改价：${line.model} ${line.category}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className={`btn ${level >= 3 ? 'danger' : 'primary'}`} disabled={disabled} onClick={() => onSave(N(p), r)}>确认改价</button></>}>
      <div className="stack">
        <div className="hint">档位价 <b>{money(line.tier_price, cur)} {cur}</b>。改价只有中方能做，改后标记「手改」，生成销售订单前再确认一次。</div>
        <div className="field req"><label>新单价 {cur}</label><input className="in" inputMode="decimal" autoFocus value={p} onChange={(e) => { setP(e.target.value.replace(/[^\d.]/g, '')); setOk(false); }} style={{ maxWidth: 200, fontSize: 18, fontWeight: 700 }} /></div>
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
        <div className="card-h"><h2>③ 客户最终确认</h2><Who e={e} /></div>
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
    act(deal.reviewed_at ? '客户已重新确认，可以出库' : '客户已确认，请主管复检打包', `select app.customer_confirm($1,$2,$3,$4,$5)`, [deal.id, note || null, method, proof, shipDate]).catch(() => {});
  };
  return (
    <div className="card">
      <div className="card-h"><h2>③ 客户最终确认 <Info>确认的是销售单上的数量和价格；确认后主管复检打包，再出库</Info></h2></div>
      <div className="card-b stack">
        {changed.length > 0 && <div className="lock">复检后有变动，只需要客户重新确认这几行：{changed.map((l) => `${l.model} ${l.category} → ${l.qty_supply} 件`).join('；')}</div>}
        <div className="substep"><span className="sn">1</span><div className="grow"><b>把销售单图片发到客户群</b> <Info>没发也能确认（当面给客户看过），但一般先发再确认。</Info></div>
          {price && <DocActions kind="so" deal={deal} lines={lines} copyLabel="复制销售单图片" primary="copy" />}</div>
        <div className="substep"><span className="sn">2</span><div className="grow stack">
          <b>客户确认</b>
          {can(role, 'customer_confirm') ? (
            <>
              {/* 210: 电脑上「标签：选项」一行一项, 手机自动上下 */}
              <FRow label="确认方式" req><div className="chips">{Object.entries(CONFIRM_METHODS).map(([k, v]) => <button type="button" key={k} className={`chip ${method === k ? 'on' : ''} ${errs && !method ? 'err' : ''}`} onClick={() => setMethod(k)}>{v}</button>)}</div></FRow>
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
  const { toast } = useApp();
  const [date, setDate] = useState(today());
  const [time, setTime] = useState(nowTime());
  const [method, setMethod] = useState('');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [proof, setProof] = useState('');
  const [partial, setPartial] = useState(false);
  const [askPartial, setAskPartial] = useState(false);
  const [items, setItems] = useState({});
  const [errs, setErrs] = useState(false);
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
    const miss = [!date && '日期', !time && '时间', !method && '发货方式', !phone.trim() && '电话', phone.trim() && !phoneValid(phone) && '电话位数不对', !addr.trim() && '收货地址 / 联系人', !proof && '发货凭证截图'].filter(Boolean);
    if (miss.length) return toast(`出库必填：${miss.join('、')}`, 'err');
    if (left.some((l) => now(l) > remain(l))) return toast('本次出库超过剩余数量', 'err');
    if (!(thisTime > 0)) return toast('本次出库数量为 0', 'err');
    const same = prev && (prev.contact_phone === phone.trim() || (proof && prev.proof_path === proof));
    setSummary({ same });
  };
  const submit = async () => {
    const at = new Date(`${date}T${time}:00`).toISOString();
    const payload = partial ? left.map((l) => ({ line_id: l.id, qty: now(l) })).filter((x) => x.qty > 0) : null;
    await act('已出库，客户总账已更新', `select app.ship($1,$2,$3,$4,$5,$6,$7)`, [deal.id, at, method, phone.trim(), addr.trim(), proof, payload && JSON.stringify(payload)]).then(() => setSummary(null), () => {});
  };
  return (
    <div className="card">
      <div className="card-h"><h2>④-3 出库单 {shippedBefore > 0 && <span className="pill amber">第 {shipments.filter((s) => !s.voided_at).length + 1} 批</span>}</h2>
        <span className="hint">司机真正把货拉走时再点「确认出库」；只叫了车、约了明天的先别登记</span></div>
      <div className="card-b stack">
        <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
          <div className="field req"><label>发货日期</label><DatePicker value={date} onChange={setDate} /></div>
          <div className="field req"><label>时间</label><input className="in" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 120 }} /></div>
          <div className="field req grow"><label>发货方式</label>
            <div className="chips">{Object.entries(SHIP_METHODS).map(([k, v]) => <button type="button" key={k} className={`chip ${method === k ? 'on' : ''} ${errs && !method ? 'err' : ''}`} onClick={() => setMethod(k)}>{v}</button>)}</div></div>
        </div>
        <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
          <div className="field req" style={{ width: 220 }}><label>{method.startsWith('yango') ? 'Yango 司机电话' : method === 'customer_pickup' ? '取货人电话' : '联系电话'}</label>
            <PhoneInput value={phone} onChange={setPhone} invalid={errs && !phone.trim()} /></div>
          <div className="field req grow"><label>收货地址 / 联系人</label>
            <input className={`in ${errs && !addr.trim() ? 'err-in' : ''}`} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="例如 Adjamé 市场 · 店主本人" /></div>
          <div className="field req"><label>发货凭证（Yango 截图 / 现场照片）</label><PhotoInput value={proof} onChange={setProof} label="司机 / 车辆截图" invalid={errs} /></div>
        </div>
        <div className="hint">下一版：上传 Yango 截图后自动读出司机名字、电话、时间，人只核对（现在先手填）。</div>
      </div>
      <div className="grid-tools">
        <div className="shipmode">
          <span className="small"><b>这次发多少：</b></span>
          <div className="seg">
            <button type="button" className={!partial ? 'on' : ''} onClick={() => { setPartial(false); setItems({}); }}>全部一次发完</button>
            <button type="button" className={partial ? 'on' : ''} onClick={() => !partial && setAskPartial(true)}>只发一部分（分批）</button>
          </div>
          {partial && <span className="small">「本次出库」列可改；不发的行填 0，下一批会自动回到剩余数量</span>}
        </div>
      </div>
      <Grid id="deal-ship" table="deal_lines" columns={cols} rows={left} foot={(rows) => ({ code: '合计', model: `${rows.length} 个型号`, ship_now: `${qty(rows.reduce((a, l) => a + now(l), 0))} 件` })} />
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
            <div>{SHIP_METHODS[method]} · {phone} · {addr} · {date} {time}</div>
            {summary.same && <div className="lock">⚠ 和上一批（{prev.out_no}）的{prev.contact_phone === phone.trim() ? '司机电话' : '凭证图片'}相同，确认是另一辆车 / 另一次发货？</div>}
            <div className="hint">出库后客户总账立即增加；如果客户有预付款，会自动抵扣这一单。</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ShipmentsCard({ deal, lines, shipments, act, role }) {
  const [voiding, setVoiding] = useState(null);
  const [justVoided, setJustVoided] = useState(false);
  if (!shipments.length) return null;
  const group = shipments.map((s) => ({ src: s.proof_path, label: `${s.out_no} 出库凭证` }));
  const cols = [
    { key: 'out_no', label: '出库单号', w: 150, render: (s) => <span className={s.voided_at ? 'strike' : ''}><b className="mono">{s.out_no}</b></span> },
    { key: 'shipped_at', label: '发货时间', w: 130, render: (s) => dt(s.shipped_at) },
    { key: 'method', label: '方式', w: 110, render: (s) => SHIP_METHODS[s.method] },
    { key: 'contact_phone', label: '电话', w: 120 },
    { key: 'address', label: '地址', w: 140 },
    { key: 'qty', label: '件数', w: 60, render: (s) => qty(s.qty) },
    { key: 'amount', label: `金额 ${deal.currency}`, w: 110, render: (s) => (seesPrice(role) ? <b className={s.voided_at ? 'strike' : ''}>{money(s.amount, deal.currency)}</b> : '—') },
    { key: 'proof', label: '凭证', w: 70, sortable: false, filterable: false, render: (s) => <Thumb src={s.proof_path} size={34} label={`${s.out_no} 出库凭证`} group={group} /> },
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
      <Grid id="deal-shipments" table="shipments" columns={cols} rows={shipments} rowClass={(s) => (s.voided_at ? 'voided' : '')} />
      <div className="card-b hint">发货文件：「BL ×2」生成编号并打印两张（一张仓库备案、一张客户签字），「海关文件」打开设置里上传的固定 PDF；大单（金额或件数到设置的阈值）会提示建议打印，小单不强制。客户签字后拍照挂上就是发货证明。「发货失败 / 退回」只用于货没到客户手上（Yango 去不了、改期、我方隔天发）：货回原仓位并重新预占、应收冲回、订单回到待出库，作废的出库单留痕。客户签收后只能走退货。金蝶写入暂未接入。</div>
      {voiding && <VoidModal s={voiding} onClose={() => setVoiding(null)} onOk={(r) => act(`${voiding.out_no} 已撤销，货已回库并重新预占`, `select app.void_shipment($1,$2)`, [voiding.id, r]).then(() => { setVoiding(null); setJustVoided(true); }, () => {})} />}
    </div>
  );
}
function VoidModal({ s, onClose, onOk }) {
  const [r, setR] = useState(NOTE_OPTIONS.void_ship[0]);
  return (
    <Modal title={`发货失败 / 退回：${s.out_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn danger" disabled={!r?.trim()} onClick={() => onOk(r)}>确认撤销这次出库</button></>}>
      <div className="stack">
        <div className="hint">不是客户退货：货没离开我们的控制，不进待检仓、不需要中方审批。撤销后重新约日期再发。</div>
        <OptionNote options={NOTE_OPTIONS.void_ship} value={r} onChange={setR} placeholder="其他原因（必填）" />
      </div>
    </Modal>
  );
}

// ───────────────────────── ⑨ 收款（本单直接收款，不跳页）─────────────────────────
export function PayPanel({ deal, receipts, shipments, act, role }) {
  const cur = deal.currency;
  const [done, setDone] = useState(null);
  const [wo, setWo] = useState(false);
  const [voidRc, setVoidRc] = useState(null);
  if (!seesPrice(role)) return <div className="card card-b"><Blocked action="receipt" /></div>;
  const rec = N(deal.shipped_amount) - N(deal.returned_amount);
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>⑥ 本单收款</h2>
          <div className="row">
            {can(role, 'write_off') && N(deal.due) > 0 && N(deal.due) <= (cur === 'XOF' ? 100 : 1) && <button type="button" className="btn" onClick={() => setWo(true)}>抹零 {money(deal.due, cur)}</button>}
          </div></div>
        <div className="card-b paygrid">
          <div><div className="k">本单应收</div><BigNum size={22}>{money(rec, cur)} <small>{cur}</small></BigNum><div className="small muted">出库 {money(deal.shipped_amount, cur)}{N(deal.returned_amount) > 0 && ` − 退货 ${money(deal.returned_amount, cur)}`}</div></div>
          <div><div className="k">实收（冲到本单）</div><BigNum size={22}>{money(deal.allocated_amount, cur)} <small>{cur}</small></BigNum>{N(deal.writeoff_amount) > 0 && <div className="small muted">另抹零 {money(deal.writeoff_amount, cur)}</div>}</div>
          <div><div className="k">本单待付</div><BigNum size={26} style={{ color: N(deal.due) > 0 ? 'var(--red)' : 'var(--green)' }}>{N(deal.due) > 0 ? <>{money(deal.due, cur)} <small>{cur}</small></> : '已结清 ✓'}</BigNum></div>
        </div>
        {!shipments.some((s) => !s.voided_at) && <div className="card-b hint">还没出库：客户总账只在出库后增加。现在收的钱会记为预付，出库时自动抵扣。</div>}
        {receipts.length > 0 && <Grid id="deal-receipts" columns={[
          { key: 'rcv_no', label: '收款单号', w: 140, render: (r) => <b className="mono">{r.rcv_no}</b> },
          { key: 'received_on', label: '收款日期', w: 100, render: (r) => dDate(r.received_on) },
          { key: 'method', label: '方式', w: 100, render: (r) => PAY_METHODS[r.method] },
          { key: 'receipt_amount', label: '这笔收款', w: 130, render: (r) => `${money(r.receipt_amount, r.currency)} ${r.currency}` },
          { key: 'amount', label: `冲到本单 ${cur}`, w: 120, render: (r) => <b>{money(r.amount, cur)}</b> },
          ...(can(role, 'receipt') ? [{ key: 'undo', label: '', w: 90, sortable: false, filterable: false, render: (r) => <button type="button" className="btn sm soft-red" onClick={() => setVoidRc({ id: r.receipt_id, rcv_no: r.rcv_no, amount: r.receipt_amount, currency: r.currency })}>↶ 撤销</button> }] : []),
        ]} rows={receipts} rowKey={(r) => r.rcv_no + r.at} />}
        {voidRc && <VoidReceiptModal rc={voidRc} onClose={() => setVoidRc(null)} />}
      </div>
      {can(role, 'receipt') && N(deal.due) > 0 && (
        <div className="card">
          <div className="card-h"><h2>登记收款 <Info>客户当场付款；隔天付、一次付多单请到「收款与冲账」</Info></h2></div>
          <ReceiptForm customer={deal.customer_id} accountCurrency={cur} lockDeal={deal.id} defaultAmount={N(deal.due)} compact onDone={setDone} />
        </div>
      )}
      {done && <div className="card card-b" style={{ background: 'var(--green-bg)' }}>✓ 已登记 {money(done.amount, done.currency)} {done.currency}{done.hits.map(([n, v]) => ` → ${n} ${money(v, done.acc)}`).join('')}{done.left > 0 && `，剩 ${money(done.left, done.acc)} 记为预付`}。下面的 Balance 已更新，复制发给客户。</div>}
      <BalancePreview customerId={deal.customer_id} currency={cur} deal={deal} title={`客户最新 Balance · ${deal.customer_name}`} />
      {wo && <WriteOffModal deal={deal} act={act} onClose={() => setWo(false)} />}
    </>
  );
}
function WriteOffModal({ deal, act, onClose }) {
  const [r, setR] = useState(NOTE_OPTIONS.writeoff[0]);
  return (
    <Modal title={`抹零：${deal.biz_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!r?.trim()} onClick={() => act('已抹零，本单结清', `select app.write_off($1,$2,$3)`, [deal.id, N(deal.due), r]).then(onClose, () => {})}>确认抹零 {money(deal.due, deal.currency)} {deal.currency}</button></>}>
      <div className="stack"><div className="hint">只限尾差（≤ 100 XOF）；会记入客户流水，客户对账看得到。</div><OptionNote options={NOTE_OPTIONS.writeoff} value={r} onChange={setR} /></div>
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
              await act('退货已登记，等中方审批', `select app.request_return($1,$2,$3,$4,null,$5,$6)`, [deal.id, form.type, form.type === 'other' ? `其他：${form.typeNote.trim()} · ${form.reason}` : form.reason, JSON.stringify(ls), new Date(form.at).toISOString(), form.photo]).then(() => setForm(null), () => {});
            }}>提交退货申请</button></>}>
          <div className="stack">
            <div className="card card-b" style={{ background: 'var(--amber-bg)' }}><b>① 收到退货</b> <span className="small muted">收到货才做退货单；没收到不做</span>
              <div className="row" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="field req"><label>收到退货的时间</label><input className="in" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} /></div>
                <div className="field req"><label>实物照片（不是盒子；少量要看得清几片，多量拍整体）</label><PhotoInput value={form.photo} onChange={(v) => setForm({ ...form, photo: v })} invalid={form.errs && !form.photo} label="拍退回的货" /></div>
              </div></div>
            <b>② 退的什么、为什么</b>
            <div className="field req"><label>退货类型</label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><div className="chips">{Object.entries(RETURN_REASONS).map(([k, v]) => <button type="button" key={k} className={`chip ${form.type === k ? 'on' : ''}`} onClick={() => setForm({ ...form, type: k })}>{v}</button>)}</div>
                {form.type === 'other' && <input className={`in ${form.errs && !form.typeNote?.trim() ? 'invalid' : ''}`} style={{ width: 260 }} autoFocus value={form.typeNote || ''} onChange={(e) => setForm({ ...form, typeNote: e.target.value })} placeholder="「其他」是什么？（必填）" />}</div></div>
            <div className="field req"><label>具体原因</label><OptionNote options={NOTE_OPTIONS.return} value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} /></div>
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
          <span className="small muted">{RETURN_REASONS[r.reason_type]} · {r.reason} · 登记 {dt(r.requested_at)}</span>
          <span className="grow" />
          <Pill tone={tone}>{st}</Pill>
          {r.status === 'requested' && (can(role, 'decide_return') ? <>
            <button type="button" className="btn sm" onClick={() => act('已驳回', `select app.decide_return($1,false)`, [r.id]).catch(() => {})}>驳回</button>
            <button type="button" className="btn sm primary" onClick={() => act('已批准：货进待检仓，总账已冲减', `select app.decide_return($1,true)`, [r.id]).catch(() => {})}>批准</button></> : <Blocked action="decide_return" />)}
        </div>
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
      <div className="card-b recon">
        <div><div className="k">对本单的影响（应收）</div><div className="ba">{money(recBefore, cur)} <span className="arrow">→</span> <b>{money(recAfter, cur)}</b> {cur}</div><div className="small muted">退货 −{money(amt, cur)}</div></div>
        <div><div className="k">客户总账（退货前 → 退货后）</div><div className="ba"><span>{balanceWords(balBefore, cur).text}</span> <span className="arrow">→</span> <b className={`${balanceWords(balAfter, cur).tone}-t2`}>{balanceWords(balAfter, cur).text}</b></div>
          {!approved && <div className="small muted">审批通过后才生效</div>}</div>
      </div>
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
  return (
    <div className="card">
      <div className="card-h"><h2>④-2 发货文件 <Info>打包完先打印，随货走；BL 编号出库时自动落到出库单上</Info></h2></div>
      <div className="card-b stack" style={{ gap: 8 }}>
        {pending ? (
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small">这批待出库 <b>{qty(pseudo.qty)}</b> 件{deal.next_bl_no ? <> · BL 编号 <b className="mono">{deal.next_bl_no}</b></> : <span className="muted"> · 还没出 BL 编号（点「BL ×2」自动出）</span>}</span>
            <BlActions shipment={pseudo} deal={deal} lines={lines} pending />
          </div>
        ) : <div className="hint">{deal.status === 'shipped' ? '全部出库完。每批的 BL / 海关文件在下面出库记录里可以重打。' : '复检打包完成后，这里出 BL ×2 和海关文件。'}</div>}
        <div className="hint">「BL ×2」= 一张仓库备案、一张客户签字（客户签字那张拍照回传，在「签收 · 对账」步挂上）；「海关文件」= 设置里上传的固定 PDF。大单（金额或件数到设置的阈值）会提示建议打印，小单不强制。</div>
      </div>
    </div>
  );
}

// ───────────────────────── ⑤ 签收 · 对账 (Frank 11-09 第 18 条: 出库后不直接到收款; 客户签收 (时间 + 照片) + Balance 发群, 全部签收才到收款) ─────────────────────────
export function SignPanel({ deal, shipments, act, role }) {
  const live = shipments.filter((s) => !s.voided_at);
  const unsigned = live.filter((s) => !s.customer_received_at);
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>⑤ 联系客户确认收货 <Info>出库后打电话或发 WhatsApp 问客户收到货没有；客户发了照片就传照片，没有就传 WhatsApp 聊天截图或通话截图。签收后再把下面的 Balance 发客户群。</Info></h2>
          <span className="muted small">{unsigned.length ? `还有 ${unsigned.length} 批没签收` : live.length ? '全部签收 ✓' : '还没出库'}</span></div>
        <div className="card-b two">
          <CustomerInfo deal={deal} />
          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            {live.length === 0 ? <div className="card-b muted small">还没出库</div> : live.map((s) => <SignRow key={s.id} s={s} act={act} role={role} />)}
          </div>
        </div>
      </div>
      {live.length > 0 && <BalancePreview customerId={deal.customer_id} currency={deal.currency} deal={deal} title={`和客户对账 · ${deal.customer_name}`} />}
    </>
  );
}
function SignRow({ s, act, role }) {
  const [photo, setPhoto] = useState('');
  const [at, setAt] = useState(() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); });
  const [errs, setErrs] = useState(false);
  const go = () => { setErrs(true); if (!photo && !s.signed_photo) return; act(`${s.out_no} 已签收`, `select app.sign_receipt($1,$2,$3)`, [s.id, photo || null, new Date(at).toISOString()]).catch(() => {}); };
  return (
    <div className="signrow">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <b className="mono">{s.out_no}</b>{s.bl_no && <span className="muted small">{s.bl_no}</span>}
        <span className="small muted">出库 {dt(s.shipped_at)} · {SHIP_METHODS[s.method]} · {qty(s.qty)} 件</span>
        {s.customer_received_at && <><Pill tone="green">已签收 {dt(s.customer_received_at)}</Pill>{s.signed_photo && <Thumb src={s.signed_photo} size={34} label={`${s.out_no} 签收凭证`} />}</>}
      </div>
      {!s.customer_received_at && (can(role, 'mark_received') ? (
        <>
          <div className="fgrid" style={{ marginTop: 8 }}>
            <FRow label="签收时间" req><input className="in" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ width: 210 }} /></FRow>
            <FRow label="签收凭证" req><PhotoInput value={photo} onChange={setPhoto} invalid={errs && !photo} label="客户照片 / WhatsApp / 通话截图" /></FRow>
          </div>
          <div className="actbar">{!photo && <span className="why">还差：签收凭证</span>}<button type="button" className="btn primary" onClick={go}>客户已签收 →</button></div>
        </>) : <Blocked action="mark_received" />)}
    </div>
  );
}
