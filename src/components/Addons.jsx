// 398 / 400 / 402 (Frank 11-18): 出库前追加货 = 流程条第 3 步下面的一条分支 (3.2 / 3.3…), 单独走一遍小流程:
//   等安排找货 → 打勾找货 + 照片 → 销售单 -O2 → 客户确认 (截图) → 复检 → 并进原单一起出库.
// 原单已经确认 / 复检好的那批不动; 货一发出去就不能再开新的追加批.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, PhotoInput, Pill, Info, Assumed, FRow } from './ui.jsx';
import { OptChoice, OptNote, OptGear, useOptList, optName } from './Opts.jsx';
import PeoplePick, { staffOrder } from './PeoplePick.jsx';
import LineEntry, { finalizeLines } from './LineEntry.jsx';
import { DocActions, DocSheet, FitDoc } from './Doc.jsx';
import { EmpLink, ModelLink, DealLink } from './Archives.jsx';
import { NOTE_OPTIONS, CONFIRM_METHODS, dealPriceVisible, hasAny } from '../lib/domain.js';
import { qty, money, dt, friendlyError } from '../lib/format.js';

const N = (v) => Number(v || 0);
export const ADDON_STATUS = {
  assign: ['等安排找货', 'red'], picking: ['找货中', 'amber'], ordered: ['等客户确认', 'amber'], confirmed: ['等复检', 'amber'],
  reviewed: ['已并进原单', 'green'], cancelled: ['已取消', 'gray'] };
export const addonOpen = (a) => !['reviewed', 'cancelled'].includes(a.status);
export const canStartAddon = (deal, role, shipments) => ['picking', 'picked', 'ordered', 'confirmed', 'reviewed'].includes(deal.status) && !(shipments || []).some((s) => !s.voided_at)
  && hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline', 'sales']);

const ADDON_SQL = `select a.*, pe.short_name as picker_name, re.short_name as reviewer_name from app.deal_addons a
  left join app.employees pe on pe.id = a.picker_employee_id left join app.employees re on re.id = a.reviewer_employee_id where a.deal_id = $1 order by a.no`;
const LINES_SQL = `select l.*, p.code, p.model, p.variant, p.shared_models, c.name as category, w.code as warehouse, s.bin
  from app.addon_lines l join app.deal_addons a on a.id = l.addon_id join app.products p on p.id = l.product_id join app.categories c on c.id = p.category_id
  join app.stock_items s on s.id = l.stock_item_id join app.warehouses w on w.id = s.warehouse_id where a.deal_id = $1 order by a.no, l.seq`;
export function useAddons(dealId) {
  const { data } = useData(async () => { const [addons, lines] = await Promise.all([q(ADDON_SQL, [dealId]), q(LINES_SQL, [dealId])]); return addons.map((a) => ({ ...a, lines: lines.filter((l) => l.addon_id === a.id) })); }, [dealId]);
  return data || [];
}

// 流程条下面的小分支: 3.1 原单 / 3.2 追加 …
export function AddonBranch({ deal, addons, curKey, setView, mainLabel }) {
  if (!addons.length) return null;
  return (
    <div className="flow2-branch">
      <span className="small muted">第 3 步的分支</span>
      <button type="button" className={`br-chip ${!String(curKey).startsWith('addon:') ? 'on' : ''}`} onClick={() => setView(null)}><b>3.1 原单</b><span className="small">{mainLabel}</span></button>
      {addons.map((a) => { const [l, tone] = ADDON_STATUS[a.status]; return (
        <button type="button" key={a.id} className={`br-chip ${curKey === 'addon:' + a.id ? 'on' : ''} ${a.status === 'cancelled' ? 'off' : ''}`} onClick={() => setView('addon:' + a.id)}>
          <b>3.{a.no} 追加</b><span className={`pill ${tone}`}>{l}</span><span className="small muted">{a.lines.length} 个型号</span></button>); })}
      <Info>客户出库前又加的货单独走一遍：派人找货 → 找货拍照 → 这一批自己的销售单 → 客户确认 → 复检，然后并进原单一起出库。原单已经确认、打包好的那批不受影响。</Info>
    </div>);
}

// 开一个追加批
export function AddonStartModal({ deal, catalog, categories, onClose, onDone }) {
  const { role, toast, refresh } = useApp();
  const [lines, setLines] = useState([]); const [note, setNote] = useState('');
  const price = dealPriceVisible(role, deal);
  const go = async () => {
    const fin = finalizeLines(lines); if (fin.error) return toast(fin.error, 'err');
    if (!fin.lines.length || fin.lines.some((l) => !(N(l.qty_req) > 0) || !l.product)) return toast('请加已建档的型号并填数量（没编码的型号先去补录需求）', 'err');
    try {
      const [{ id }] = await call(role, `select app.start_addon($1,$2,$3) as id`, [deal.id, JSON.stringify(fin.lines.map((l) => ({ product_id: l.product.id, qty: N(l.qty_req), stock_item_id: l.stock_item_id || null }))), note || null]);
      toast('已开一个追加批并预占库存，等主管派人去找'); refresh(); onDone?.(id); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={`出库前追加货 · ${deal.biz_no}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={go}>开追加批并预占</button></>}>
      <div className="stack">
        <div className="hint">追加的货<b>单独走一遍</b>：主管派人找 → 找货拍照 → 这一批自己的销售单（-O2 / -O3…）→ 客户确认 → 复检 → 和原来那批一起出库。原单已经确认、已经打包好的那批<b>不用重来</b>。<Assumed>货发出去以后就不能再追加，给客户开新单。追加只能选有编码的型号；价格按客户档位带出，要特价的并进原单后在原单上走改价。</Assumed></div>
        <LineEntry id="deal-addon" catalog={catalog} categories={categories} tier={deal.tier} lines={lines} setLines={setLines} showPrice={price} currency={deal.currency} />
        <div className="field"><label>备注（选填）</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 客户下午又加了 2 个型号" /></div>
      </div>
    </Modal>);
}

function Assign({ addon, employees }) {
  const { role, toast, refresh } = useApp();
  const [open, setOpen] = useState(false); const [emp, setEmp] = useState(''); const [tried, setTried] = useState(false);
  const canAssign = hasAny(role, ['admin', 'manager']);
  const go = async () => {
    setTried(true); if (!emp) return toast('选一个人去找货', 'err');
    try { await call(role, `select app.assign_addon($1,$2)`, [addon.id, emp]); toast(addon.picker_employee_id ? '已改派' : '已派人，他的待办里会出现这一批'); setOpen(false); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className={`assign-bar ${addon.picker_employee_id ? '' : 'todo'}`}>
      {addon.picker_employee_id ? <span>这一批派给了 <b><EmpLink id={addon.picker_employee_id} name={addon.picker_name} /></b>{addon.assigned_at ? <span className="small muted"> · {dt(addon.assigned_at)} 派的</span> : null}</span>
        : <span><b>等安排找货（追加）</b><span className="small muted"> · 主管选一个人去找，不自动派给上次那个人</span></span>}
      <span className="grow" />
      {canAssign && <button type="button" className={`btn ${addon.picker_employee_id ? 'sm' : 'primary'}`} onClick={() => { setEmp(addon.picker_employee_id || ''); setOpen(true); }}>{addon.picker_employee_id ? '改派' : '派人去找'}</button>}
      {open && <Modal title={`派人找追加的货 · 3.${addon.no}`} onClose={() => setOpen(false)} footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>取消</button><button type="button" className="btn primary" onClick={go}>确定</button></>}>
        <div className="stack" style={{ minHeight: 260 }}>
          <div className="field req"><label>谁去找</label><OptChoice optKey="emp_list" title="员工名单" data value={emp} onChange={setEmp} flat={false} placeholder="选员工…" err={tried && !emp} width={240}
            options={staffOrder((employees || []).filter((e) => e.active !== false && e.status !== 'left')).map((e) => [e.id, e.short_name, [e.emp_no, e.department].filter(Boolean).join(' · ')])} /></div>
        </div>
      </Modal>}
    </div>);
}

// 打勾找货 (本机先记, 提交时一次交): 整行是按钮, − / ＋ 改数量, 少了点原因
function Pick({ addon, role }) {
  const { toast, refresh } = useApp();
  const [st, setSt] = useState({});     // line → { on, qty, reason }
  const [photo, setPhoto] = useState(''); const [errs, setErrs] = useState(false);
  const { list: reasons } = useOptList('note_diff', NOTE_OPTIONS.diff);
  const cur = (l) => ({ on: false, qty: N(l.qty_req), reason: '', ...(st[l.id] || {}) });
  const set = (l, p) => setSt((x) => ({ ...x, [l.id]: { ...cur(l), ...p } }));
  const done = addon.lines.filter((l) => cur(l).on).length;
  const sorted = useMemo(() => [...addon.lines].sort((a, b) => (cur(a).on - cur(b).on) || String(a.bin || '~').localeCompare(String(b.bin || '~'), 'zh-CN', { numeric: true })), [addon.lines, st]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tap = (l) => { const c = cur(l); if (c.on) return set(l, { on: false }); if (c.qty < N(l.qty_req) && !c.reason) { set(l, { ask: true }); return toast(`${l.model} 找到的比要的少，先点一个原因`, 'err'); } if (navigator.vibrate) navigator.vibrate(15); set(l, { on: true }); };
  const step = (l, d) => { const c = cur(l); const v = Math.max(0, Math.min(N(l.qty_req), c.qty + d)); set(l, { qty: v, on: v < N(l.qty_req) && !c.reason ? false : c.on, ask: v < N(l.qty_req) && !c.reason }); };
  const submit = async () => {
    setErrs(true);
    const left = addon.lines.filter((l) => !cur(l).on);
    if (left.length) return toast(`还有 ${left.length} 行没打勾：${left.slice(0, 4).map((l) => l.model).join('、')}`, 'err');
    if (!photo) return toast('请拍一张找货现场照片', 'err');
    try { await call(role, `select app.addon_pick_submit($1,$2,$3)`, [addon.id, JSON.stringify(addon.lines.map((l) => ({ line_id: l.id, qty: cur(l).qty, reason: cur(l).reason || null }))), photo]); toast(`找货完成，这一批的销售单已生成`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="ticks">
      <div className="ticks-top"><div className="ticks-prog"><i style={{ width: `${addon.lines.length ? (done / addon.lines.length) * 100 : 0}%` }} /></div><b>已找 {done} / {addon.lines.length} 行</b><span className="grow" />
        <Info>点整行 = 找到了（变绿），再点一下 = 取消。少了就按 − 改数量，再点原因。</Info></div>
      {sorted.map((l) => { const c = cur(l); const short = c.qty < N(l.qty_req); return (
        <div key={l.id} className={`tick-row ${c.on ? 'done' : ''} ${short ? 'short' : ''}`}>
          <button type="button" className="tick-main" onClick={() => tap(l)} aria-pressed={c.on}>
            <span className="tick-box">{c.on ? '✓' : ''}</span>
            <span className="tick-info"><b className="tick-model">{l.model}</b><span className="tick-sub">{l.category} · {l.code}{l.variant ? ` · ${l.variant}` : ''}</span></span>
            <span className="tick-bin">{l.warehouse}<b>{l.bin || '—'}</b></span>
          </button>
          <span className="tick-qty">
            <button type="button" className="step" disabled={c.qty <= 0} onClick={() => step(l, -1)} aria-label="少一片">−</button>
            <span className="num">{qty(c.qty)}<small>/ {qty(l.qty_req)}</small></span>
            <button type="button" className="step" disabled={c.qty >= N(l.qty_req)} onClick={() => step(l, 1)} aria-label="多一片">＋</button>
          </span>
          {short && <div className="tick-why">{c.on ? <span className="pill amber">少 {qty(N(l.qty_req) - c.qty)} 片 · {c.reason}</span> : <>
            <span className="small">少 {qty(N(l.qty_req) - c.qty)} 片，原因：</span>
            {reasons.map(([v, n]) => <button type="button" key={v} className={`chip ${c.reason === v ? 'on' : ''} ${c.ask && !c.reason ? 'err' : ''}`} onClick={() => set(l, { reason: v, on: true, ask: false })}>{n}</button>)}<OptGear optKey="note_diff" title="找少了的原因" options={NOTE_OPTIONS.diff} /></>}</div>}
        </div>); })}
      <div className="ticks-foot">
        <div className="field req" style={{ flex: '1 1 260px', minWidth: 0 }}><label>找货照片（货摆在地上拍）</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs && !photo} label="拍找货照片" /></div>
        <button type="button" className="btn primary lg ticks-submit" onClick={submit}>提交（已找 {done} / 共 {addon.lines.length} 行）→</button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>库存已预占。追加的货<b>和原来那批放在一起、先不打包</b>；提交以后这一批的销售单自动生成，发给客户确认。</div>
    </div>);
}

function Confirm({ addon }) {
  const { role, toast, refresh } = useApp();
  const [method, setMethod] = useState('whatsapp'); const [proof, setProof] = useState(''); const [note, setNote] = useState(''); const [errs, setErrs] = useState(false);
  const go = async () => {
    setErrs(true);
    if (!proof) return toast('客户确认要传截图', 'err');
    try { await call(role, `select app.addon_confirm($1,$2,$3,$4)`, [addon.id, method, proof, note || null]); toast('客户已确认这一批，等复检'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="card-b stack">
      <div className="rgrid">
        <FRow label="确认方式" req><OptChoice optKey="confirm_methods" title="确认方式" value={method} onChange={setMethod} options={Object.entries(CONFIRM_METHODS)} err={errs && !method} /></FRow>
        <FRow label="备注"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="选填" /></FRow>
      </div>
      <div className="field req"><label>客户确认的截图（把这一批的销售单发群，客户回了再截）</label><PhotoInput value={proof} onChange={setProof} invalid={errs && !proof} label="传确认截图" /></div>
      <div className="row"><span className="grow" /><button type="button" className="btn primary" onClick={go}>客户已确认这一批 →</button></div>
    </div>);
}

function Review({ addon, employees }) {
  const { role, toast, refresh } = useApp();
  const [reviewer, setReviewer] = useState(''); const [photo, setPhoto] = useState(''); const [errs, setErrs] = useState(false);
  const [cnt, setCnt] = useState({}); const [why, setWhy] = useState({});
  const real = addon.lines.filter((l) => N(l.qty_picked) > 0);
  const c = (l) => (cnt[l.id] ?? N(l.qty_picked));
  const go = async () => {
    setErrs(true);
    if (!reviewer) return toast('选复核人', 'err');
    const bad = real.find((l) => c(l) < N(l.qty_picked) && !why[l.id]);
    if (bad) return toast(`${bad.model} 少了要写原因`, 'err');
    if (!photo) return toast('复检要拍打包照片', 'err');
    try { await call(role, `select app.addon_review($1,$2,$3,$4)`, [addon.id, reviewer, photo, JSON.stringify(real.filter((l) => c(l) !== N(l.qty_picked)).map((l) => ({ line_id: l.id, counted: c(l), reason: why[l.id] || null })))]); toast('复检完成，这一批已并进原单，可以一起出库'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  if (!hasAny(role, ['admin', 'manager'])) return <div className="card-b hint">客户已确认这一批，等主管复检打包。</div>;
  return (
    <div className="card-b stack">
      {real.map((l) => (
        <div key={l.id} className={`tick-row ${c(l) < N(l.qty_picked) ? 'short' : 'done'}`}>
          <span className="tick-main" style={{ cursor: 'default' }}><span className="tick-box">{c(l) < N(l.qty_picked) ? '!' : '✓'}</span><span className="tick-info"><b className="tick-model">{l.model}</b><span className="tick-sub">{l.category} · {l.code} · 找货交了 {qty(l.qty_picked)} 片</span></span><span className="tick-bin">{l.warehouse}<b>{l.bin || '—'}</b></span></span>
          <span className="tick-qty">
            <button type="button" className="step" disabled={c(l) <= 0} onClick={() => setCnt({ ...cnt, [l.id]: c(l) - 1 })} aria-label="少一片">−</button>
            <span className="num">{qty(c(l))}<small>/ {qty(l.qty_picked)}</small></span>
            <button type="button" className="step" disabled={c(l) >= N(l.qty_picked)} onClick={() => setCnt({ ...cnt, [l.id]: c(l) + 1 })} aria-label="多一片">＋</button>
          </span>
          {c(l) < N(l.qty_picked) && <div className="tick-why"><span className="small">实点少 {qty(N(l.qty_picked) - c(l))} 片，原因：</span><OptNote optKey="note_review_less" title="少发的原因" options={['货损', '数错了', '型号拿错']} value={why[l.id] || ''} onChange={(v) => setWhy({ ...why, [l.id]: v })} err={errs && !why[l.id]} /></div>}
        </div>))}
      <div className="rgrid">
        <div><PeoplePick step="review" label={<>复核人 <Info>复核人不能是找货的那个人（中方除外）。</Info></>} employees={role === 'admin' ? employees : employees.filter((e) => e.id !== addon.picker_employee_id)} value={reviewer} onChange={setReviewer} errs={errs} /></div>
        <div className="field req"><label>打包照片</label><PhotoInput value={photo} onChange={setPhoto} invalid={errs && !photo} label="拍打包照片" /></div>
      </div>
      <div className="hint">实点数只能等于或少于找货交的数；多出来的放回货架。少了的按实点数发，销售单上这一行跟着变。<Assumed>追加批的复检是简化版：只核对数量 + 拍照，不单独做必抽检和「补上 / 放回」记录。</Assumed></div>
      <div className="row"><span className="grow" /><button type="button" className="btn primary" onClick={go}>复检完成，并进原单 →</button></div>
    </div>);
}

// 一个追加批自己的页面 (只显示这一批的型号)
export function AddonPanel({ deal, addon, employees }) {
  const { role, toast, refresh } = useApp();
  const [cancel, setCancel] = useState(false); const [reason, setReason] = useState('');
  const price = dealPriceVisible(role, deal);
  const [label, tone] = ADDON_STATUS[addon.status];
  const meEmp = useData(() => q(`select app.current_employee($1) as e`, [deal.org_id]).catch(() => [{ e: null }]), [deal.org_id]).data?.[0]?.e;
  const canPick = hasAny(role, ['admin', 'manager']) || (meEmp && meEmp === addon.picker_employee_id);
  const soLines = addon.lines.map((l) => ({ ...l, qty_supply: l.qty_final ?? l.qty_picked ?? 0 }));
  const soDeal = { ...deal, so_no: addon.so_no, updated_at: addon.picked_at || deal.updated_at };
  const total = soLines.reduce((a, l) => a + N(l.qty_supply) * N(l.unit_price), 0);
  const doCancel = async () => {
    if (!reason.trim()) return toast('取消要写原因', 'err');
    try { await call(role, `select app.cancel_addon($1,$2)`, [addon.id, reason]); toast('这一批已取消，预占的库存放掉了'); setCancel(false); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="card">
      <div className="card-h">
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}><h2>3.{addon.no} 追加货 <span className="muted small mono">{addon.so_no || '（找货提交后出销售单号）'}</span></h2><span className={`pill ${tone}`}>{label}</span>
          {addon.note && <span className="small muted">{addon.note}</span>}</div>
        <div className="row">
          {addon.so_no && price && addon.status !== 'cancelled' && <DocActions kind="so" deal={soDeal} lines={soLines} copyLabel="复制这一批的销售单图片" hidePrint />}
          {addonOpen(addon) && hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline', 'sales']) && <button type="button" className="btn sm" onClick={() => { setReason(''); setCancel(true); }}>取消这一批</button>}
        </div>
      </div>
      {addon.status === 'cancelled' && <div className="card-b"><div className="lock">这一批已取消：{addon.cancel_reason}（{dt(addon.cancelled_at)}）。预占的库存已放掉。</div></div>}
      {['assign', 'picking'].includes(addon.status) && <div className="card-b stack">
        <Assign addon={addon} employees={employees} />
        {addon.status === 'picking' && (canPick ? <Pick addon={addon} role={role} /> : <div className="hint">等 {addon.picker_name} 找货。</div>)}
        {addon.status === 'assign' && <AddonLines addon={addon} price={price} cur={deal.currency} />}
      </div>}
      {addon.status === 'ordered' && <>
        <div className="card-b"><div className="doc-preview"><FitDoc><DocSheet kind="so" deal={soDeal} lines={soLines} /></FitDoc></div>
          <div className="small muted" style={{ marginTop: 6 }}>找货：<b>{addon.picker_name}</b> · {dt(addon.picked_at)} · 这一批合计 {price ? `${money(total, deal.currency)} ${deal.currency}` : `${qty(soLines.reduce((a, l) => a + N(l.qty_supply), 0))} 片`}</div></div>
        {hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline', 'sales']) ? <Confirm addon={addon} /> : <div className="card-b hint">等热线 / 销售跟客户确认这一批。</div>}
      </>}
      {addon.status === 'confirmed' && <>
        <div className="card-b small">客户已确认（{optName('confirm_methods', addon.confirm_method, CONFIRM_METHODS) || '—'} · {dt(addon.confirmed_at)}）{addon.confirm_note ? ` · ${addon.confirm_note}` : ''}</div>
        <Review addon={addon} employees={employees} />
      </>}
      {addon.status === 'reviewed' && <div className="card-b stack">
        <div className="banner good">这一批已复检（复核人 <b>{addon.reviewer_name}</b> · {dt(addon.reviewed_at)}），<b>已并进原单</b>，和原来那批一起出库。出库、签收、对账、收款都在原单上做。</div>
        <AddonLines addon={addon} price={price} cur={deal.currency} />
      </div>}
      {cancel && <Modal title={`取消追加批 3.${addon.no}？`} risk="yellow" onClose={() => setCancel(false)} footer={<><button type="button" className="btn" onClick={() => setCancel(false)}>不取消</button><button type="button" className="btn danger" onClick={doCancel}>取消这一批</button></>}>
        <div className="stack"><div className="field req"><label>为什么取消</label><OptNote optKey="note_addon_cancel" title="取消追加批的原因" options={['客户不要了', '没货', '加错了', '改成开新单']} value={reason} onChange={setReason} err={!reason.trim()} /></div>
          <div className="hint">取消以后预占的库存放掉，这一批留记录不删。原单不受影响。</div></div>
      </Modal>}
    </div>);
}

function AddonLines({ addon, price, cur }) {
  return (
    <table className="mini-t"><thead><tr><th>型号</th><th>种类</th><th>库位</th><th className="r">要几片</th><th className="r">找到</th><th className="r">复检后</th>{price && <th className="r">单价</th>}</tr></thead>
      <tbody>{addon.lines.map((l) => (
        <tr key={l.id}><td><ModelLink id={l.product_id} model={l.model} /> <span className="small muted">{l.code}</span></td><td>{l.category}</td><td>{l.warehouse} {l.bin || ''}</td>
          <td className="r">{qty(l.qty_req)}</td><td className="r">{l.qty_picked == null ? '—' : qty(l.qty_picked)}{l.pick_reason ? <span className="small muted"> · {l.pick_reason}</span> : null}</td>
          <td className="r">{l.qty_final == null ? '—' : qty(l.qty_final)}</td>{price && <td className="r">{money(l.unit_price, cur)}</td>}</tr>))}</tbody></table>);
}

// 待办: 没走完的追加批 (主管: 等安排 / 等复检; 被派的人: 找货; 热线 / 销售: 等客户确认)
export function AddonTodo() {
  const { org, role, go } = useApp();
  const { data } = useData(async () => {
    const [{ e: me }] = await q(`select app.current_employee($1) as e`, [org]).catch(() => [{ e: null }]);
    const rows = await q(`select * from app.v_open_addons where org_id = $1 order by created_at`, [org]);
    return { me, rows };
  }, [org]);
  if (!data) return null;
  const boss = hasAny(role, ['admin', 'manager']);
  const mine = data.rows.filter((a) => (a.status === 'assign' && boss) || (a.status === 'picking' && (a.picker_employee_id === data.me || boss))
    || (a.status === 'ordered' && (hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline']) || (role === 'sales' && a.owner_employee_id === data.me))) || (a.status === 'confirmed' && boss));
  if (!hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline', 'sales', 'picker'])) return null;
  const open = (a) => { try { sessionStorage.setItem('la9s.addon', a.id); } catch { /* */ } go('deal/' + a.deal_id); };
  return (
    <div className="card">
      <div className="card-h"><h2>追加的货 <Info>客户出库前又加的货：单独派人找、单独发销售单给客户确认、单独复检，然后并进原单一起出库。</Info></h2><span className={`pill ${mine.length ? 'red' : 'gray'}`}>{mine.length} 批要处理</span></div>
      <div className="card-b">{mine.length === 0 ? <div className="small muted">没有要处理的追加批。</div> : mine.map((a) => (
        <div key={a.id} className="todo-line">
          <span className={`pill ${ADDON_STATUS[a.status][1]}`}>{a.status === 'assign' ? '等安排找货（追加）' : a.status === 'picking' ? `找货中${a.picker ? ' · ' + a.picker : ''}` : ADDON_STATUS[a.status][0]}</span>
          <DealLink id={a.deal_id} no={a.biz_no} /><b>3.{a.no}</b><span>{a.customer}</span><span className="small muted">{a.lines} 个型号 · {qty(a.qty)} 片 · {dt(a.created_at)} 加的</span>
          <span className="grow" /><button type="button" className="btn sm primary" onClick={() => open(a)}>去处理 →</button>
        </div>))}</div>
    </div>);
}
