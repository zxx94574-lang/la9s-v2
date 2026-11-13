// One business (业务号) = one page. Fixed workflow bar on top; every step has its own page:
// the current step shows its action, a finished step shows a read-only record (待改 13).
// Going back = 「撤回到上一步」 with a reason (待改 14); cancelled deals can be restored (待改 16).
import DebtBanner from '../components/DebtBanner.jsx';
import { dealLight, stuckOf } from '../lib/domain.js';
import React, { useEffect, useRef, useState } from 'react';
const N = (v) => Number(v) || 0;
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, Light, useApp, useData, Pill, Modal, OptionNote, Info } from '../components/ui.jsx';
import { STATUS, STEPS, LAST_STEP, reachedStep, EVENT_LABELS, ROLES, CONFIRM_METHODS, NOTE_OPTIONS, TIERS, can, seesPrice } from '../lib/domain.js';
import { money, qty, dt, dDate, today, friendlyError } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { CustomerDrawer } from './Customers.jsx';
import Grid from '../components/Grid.jsx';
import { IssueButton } from '../components/IssueReport.jsx';
import { QuotePanel, ConfirmBlock, PickPanel, SoPanel, ConfirmPanel, ShipStepPanel, SignPanel, PayPanel, ReturnPanel, discLineText, DISC_WHERE } from './DealPanels.jsx';
import { ModelLink, CustLink, EmpLink, DealLink } from '../components/Archives.jsx';

const STEP_KEYS = STEPS.map((s) => s.key);
const REVERT_LABEL = {
  hotline_ok: '撤回确认 → 回到报价', picking: '撤回找货 → 释放预占，回到报价·确认', picked: '撤回初检 → 回到找货中',
  ordered: '撤回销售订单 → 回到已初拣（可改价、追加）', confirmed: '撤回客户确认 → 回到待客户确认', reviewed: '撤回复检打包 → 回到待复检',
};
const short = (no) => (no ? '…' + String(no).slice(-4) : '');
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

// 操作记录每一条属于流程条的哪一步 (点了就回到那一步)
const EVENT_STEP = { quote_created: 'quote', deal_split: 'quote', split_created: 'quote', quote_edited: 'quote', hotline_confirmed: 'quote', hotline_busy: 'quote', quote_approved: 'quote', quote_rejected: 'quote', fx_set: 'quote', price_requested: 'quote',
  picking_started: 'pick', pick_submitted: 'pick', sales_order_created: 'so', price_set: 'so', customer_confirmed: 'so', lines_added: 'so', staged: 'ship', partial_reason: 'ship',
  pick_reviewed: 'ship', bl_issued: 'ship', shipped: 'ship', shipment_voided: 'ship', customer_received: 'sign', balance_confirmed: 'sign', receipt_discrepancy: 'sign', discrepancy_decided: 'sign', discrepancy_corrected: 'sign',
  prepayment_applied: 'pay', written_off: 'pay', receipt_voided: 'pay', bad_debt_written_off: 'pay', return_requested: 'return', return_approved: 'return', return_reconciled: 'return' };
export default function Deal({ id }) {
  const { org, role, toast, refresh, go: nav } = useApp();
  const [view, setView] = useState(null);
  const [approve, setApprove] = useState(false);
  const [revert, setRevert] = useState(false);
  const [custOpen, setCustOpen] = useState(false);
  const { data, error } = useData(async () => {
    const [deal] = await q(Q.dealById, [id]);
    if (!deal) return { deal: null };
    const [lines, events, shipments, returns, receipts, employees, catalog, categories, [credit]] = await Promise.all([
      q(Q.dealLines, [id]), q(Q.dealEvents, [id]), q(Q.dealShipments, [id]), q(Q.dealReturns, [id]), q(Q.dealReceipts, [id]),
      q(Q.employees, [org]), q(Q.catalog, [org]), q(Q.categories, [org]), q(`select * from app.v_customer_credit where customer_id = $1`, [deal.customer_id])]);
    // 239 ② (Frank 11-11): 订单之间联动 —— 这个客户别的单上还没办完的事, 在这张单里也看得到
    const others = await q(`select * from (select d.id, d.biz_no,
        (select count(*) from app.shipments sx where sx.deal_id = d.id and sx.voided_at is null and sx.customer_received_at is null)::int as unsigned_n,
        app.balance_pending(d.id) as balance_pending,
        (select count(*) from app.returns rx where rx.deal_id = d.id and (rx.status = 'requested' or (rx.status = 'approved' and rx.reconciled_at is null)))::int as open_returns_n
      from app.deals d where d.customer_id = $1 and d.id <> $2 and d.status <> 'cancelled' and d.kind = 'normal') x
      where unsigned_n > 0 or balance_pending or open_returns_n > 0 order by biz_no`, [deal.customer_id, id]);
    const discs = await q(`select * from app.receipt_discrepancies where deal_id = $1 order by reported_at`, [id]);
    return { deal, lines, events, shipments, returns, receipts, employees, catalog, categories, credit, others, discs };
  }, [id]);

  // 下推成功 (状态变了) → 回到当前这一步, 不停在刚才点开看的那一步
  const status = data?.deal?.status;
  useEffect(() => { setView(null); }, [status]);
  // 268 (Frank 11-12): 流程条吸顶, 往下滑后缩成一行 (只留「卡在哪 + 上报 / 撤回」), 回到顶部恢复完整; 高度用 margin 补回去, 页面不跳
  const sentRef = useRef(null); const stepsRef = useRef(null);
  const [stuck, setStuck] = useState(false); const [stepsH, setStepsH] = useState(0);
  const hasDeal = !!data?.deal;
  useEffect(() => {
    const el = sentRef.current; if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([en]) => { if (!en.isIntersecting && stepsRef.current) setStepsH(stepsRef.current.offsetHeight || 0); setStuck(!en.isIntersecting); }, { threshold: 0, rootMargin: '-66px 0px 0px 0px' });   // 顶栏高 60: 流程条贴到顶栏下面才算吸顶
    io.observe(el); return () => io.disconnect();
  }, [hasDeal, id]);

  if (error) return <div className="card card-b">读取失败：{String(error.message || error)}</div>;
  if (!data) return <div className="empty">加载中…</div>;
  if (!data.deal) return <div className="card card-b">没有找到这张单。</div>;
  const { deal } = data;
  const cancelled = deal.status === 'cancelled';
  const live = data.shipments.filter((s) => !s.voided_at);
  const reached = reachedStep(deal);                       // partial 在 REACHED 里 = 4 (出库这一步还没完)
  const current = cancelled ? -1 : Math.min(reached + 1, LAST_STEP);
  const allDone = reached >= LAST_STEP;
  // 212: 下一步换了岗位 (签收 → 收款 是财务的事; 出库 → 签收 是热线的事) 就停在自己刚做完的那一步, 不自动跳过去
  let defKey = cancelled ? 'quote' : allDone ? 'pay' : STEP_KEYS[current];
  const STEP_PERM = { sign: 'mark_received', pay: 'receipt' };
  for (let i = STEP_KEYS.indexOf(defKey); i > 0 && STEP_PERM[STEP_KEYS[i]] && !can(role, STEP_PERM[STEP_KEYS[i]]); i -= 1) defKey = STEP_KEYS[i - 1];
  // Frank 11-11 16:31: 签收完 (不管收没收款) 谁来看都停在「签收 · 对账」: 上面显示已签收, 下面接着和客户对账; 收款是财务在收款页做的, 要看点流程条「收款」
  if (defKey === 'pay' && !cancelled && live.length) defKey = 'sign';
  const curKey = view || defKey;
  const curIdx = STEP_KEYS.indexOf(curKey);
  // 261 (Frank 11-12): 「上报问题」「撤回」只在看当前这一步时出现; 回看已完成的步骤是纯只读
  const atNow = curKey === defKey || curIdx === current;
  const readOnly = curIdx >= 0 && curIdx <= reached && !['ship', 'sign', 'pay'].includes(curKey) && !(curKey === 'so' && ['ordered', 'confirmed', 'reviewed', 'partial'].includes(deal.status));

  const act = async (okMsg, sql, params, asRole = role) => {
    try { const r = await call(asRole, sql, params); toast(okMsg); refresh(); return r; }
    catch (e) { toast(friendlyError(e), 'err'); throw e; }
  };
  const ctx = { ...data, act, role, setView, readOnly };

  const docOf = (k) => ({
    quote: deal.quote_no, pick: deal.pick_no, so: deal.so_no, ship: live[0]?.out_no || deal.reviewer_name,
    sign: live.length ? (Number(deal.unsigned_n) > 0 ? `${deal.unsigned_n} 批待签收` : deal.balance_pending ? '已签收 · 待对账' : '已对账') : '',
    pay: Number(deal.shipped_amount) > 0 ? (Number(deal.due) > 0 ? `欠 ${money(deal.due, deal.currency)}` : '已结清') : '',
  }[k]);
  const nextLabel = current >= 0 && current < LAST_STEP ? STEPS[current + 1]?.label : null;
  const overdue = deal.planned_ship_date && ['confirmed', 'reviewed', 'partial'].includes(deal.status) && dDate(deal.planned_ship_date) < today();
  const dueToday = deal.planned_ship_date && ['confirmed', 'reviewed', 'partial'].includes(deal.status) && dDate(deal.planned_ship_date) === today();

  return (
    <>
      <div ref={sentRef} style={{ height: 1, marginBottom: -1 }} />
      <div className={`flow2 ${stuck ? 'stuck' : ''}`} style={stuck && stepsH ? { marginBottom: 12 + stepsH } : undefined}>
        <div className="flow2-steps" ref={stepsRef}>
          {STEPS.map((s, i) => {
            const done = !cancelled && i <= reached;
            const now = !cancelled && i === current && !allDone;
            const reachable = !cancelled ? i <= current : i === 0;
            const doc = docOf(s.key);
            const isDocNo = ['quote', 'pick', 'so'].includes(s.key) || (s.key === 'ship' && /^OUT/.test(doc || ''));
            return (
              <React.Fragment key={s.key}>
                {i > 0 && <span className={`flow2-line ${done ? 'done' : ''}`} />}
                <button type="button" className={`flow2-step ${done ? 'done' : ''} ${now ? 'now' : ''} ${curKey === s.key ? 'viewing' : ''}`}
                  disabled={!reachable} onClick={() => setView(s.key)} title={doc ? `${s.label}：${doc}` : s.label}>
                  <span className="c">{done ? '✓' : i + 1}</span>
                  <span className="l">{t(s.label)}</span>
                  <span className="d">{curKey === s.key ? (doc ? (isDocNo ? short(doc) : doc) : now ? '当前' : '') : now ? '当前' : ''}</span>
                </button>
              </React.Fragment>
            );
          })}
          {['partial', 'shipped'].includes(deal.status) && (
            <>
              <span className="flow2-line dash" />
              <button type="button" className={`flow2-step ret ${curKey === 'return' ? 'viewing' : ''}`} onClick={() => setView('return')} title="按原单退货">
                <span className="c">↩</span><span className="l">退货</span><span className="d">{data.returns.length ? `${data.returns.length} 张` : ''}</span>
              </button>
            </>
          )}
        </div>
        <div className="flow2-now">
          <Light v={dealLight(deal)} />
          <span>卡在：<b>{stuckOf(deal)}</b>{!cancelled && dealLight(deal) !== 'done' && nextLabel && <span className="muted"> · 下一步：{nextLabel}</span>}</span>
          {(overdue || dueToday) && <span className={`pill ${overdue ? 'red' : 'amber'}`}>约定 {dDate(deal.planned_ship_date)} 发货{overdue ? ' · 已过期未出库' : ' · 今天该出库'}</span>}
          <span className="grow" />
          {stuck && <button type="button" className="btn sm" title="回到顶部，展开全部步骤" onClick={() => sentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>正在看：{curKey === 'return' ? '退货' : STEPS[curIdx]?.label} · 全部步骤 ↑</button>}
          {!atNow && !cancelled && curKey !== 'return' && <><span className="pill gray">回看已完成的步骤 · 只读</span><button type="button" className="btn sm" onClick={() => setView(null)}>回到当前步 →</button></>}
          {atNow && !cancelled && <IssueButton deal={deal} step={STEPS[Math.min(current, STEPS.length - 1)]?.key} />}
          {atNow && REVERT_LABEL[deal.status] && can(role, 'revert') && <button type="button" className="btn sm soft-red" onClick={() => setRevert(true)}>↶ 撤回到上一步</button>}
          {cancelled && can(role, 'restore') && <button type="button" className="btn sm primary" onClick={() => act('已恢复为报价，可以重新下推', `select app.restore_deal($1)`, [deal.id]).catch(() => {})}>↺ 恢复这张单</button>}
        </div>
      </div>

      {/* 订单信息窄条 (11-09 196): 一行放完, 不占大块 */}
      <div className="card dealbar">
        <span className="big mono">{deal.biz_no}</span>
        {deal.status === 'quoted' && deal.tier_pending ? <Pill tone="amber">草稿 · 等中方定档位</Pill> : <Pill tone={STATUS[deal.status].tone}>{STATUS[deal.status].label}</Pill>}{deal.kind !== 'normal' && <Pill tone="gray">{deal.kind}</Pill>}
        <Info>订单号 {deal.biz_no}：{deal.biz_no.startsWith('BIZ-') ? '旧格式（年月 + 当月流水）。' : 'CI = 科特，中间 6 位 = 年月日，最后 = 当天第几单。'}同一张订单下面的单据都跟着这个号：-Q 报价单（Quotation）、-P 找货单（Picking）、-O 销售订单（Order）、-S1 / -S2 第 1 / 2 批出库（Shipment）。</Info>
        {deal.status === 'confirmed' && deal.planned_ship_date && dDate(deal.planned_ship_date) > today() && (deal.staged_at
          ? <span className="pill amber" title="到约定那天再复检打包">等待发货 · 约 {dDate(deal.planned_ship_date)} · 放在：{deal.staged_note || '（没写）'}</span>
          : <span className="pill red">约 {dDate(deal.planned_ship_date)} 发货 · 货还没放到暂存位置</span>)}
        <span className="muted">·</span>
        <span style={{ fontWeight: 650 }}><CustLink id={deal.customer_id} name={deal.customer_name} /></span>
        <span className="muted small">{deal.customer_code} · {deal.city}</span><TierPill tier={deal.tier} />
        <span className="grow" />
        {deal.currency !== 'XOF' && <span className="small">币种 <b>{deal.currency}</b>{deal.fx_rate ? ` · 1 ${deal.currency} = ${Number(deal.fx_rate)} XOF` : ''}</span>}
        <span className="small muted">{dDate(deal.created_at)} 建单</span>
      </div>

      {deal.source === 'guest' && (
        <div className="banner info row" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
          <span>🌐 <b>游客询价</b>：{deal.guest_info?.contact || ''} · {deal.guest_info?.phone || ''} · {deal.guest_info?.shop || ''} · {deal.guest_info?.city || ''}
            {deal.owner_name ? ` · 选的销售员 ${deal.owner_name}` : ' · 没选销售员'}。热线尽快打电话 / WhatsApp 报价；谈成了给他转正式客户、开下单账号。</span>
          <span className="grow" />
          <button type="button" className="btn sm" onClick={() => setCustOpen(true)}>客户档案 / 开账号</button>
        </div>)}
      {custOpen && <CustomerDrawer id={deal.customer_id} onClose={() => setCustOpen(false)} />}
      {!cancelled && seesPrice(role) && !['shipped'].includes(deal.status) && <DebtBanner customerId={deal.customer_id} deal={deal} />}
      {(deal.split_from || deal.split_children?.length > 0) && (
        <div className="card card-b other-pending"><span className="pill blue">拆单</span>
          {deal.split_from && <span>这张单是从 <DealLink id={deal.split_from} no={deal.split_from_no} /> 拆出来的{deal.want_on ? `，约定 ${dDate(deal.want_on)} 发` : ''}；价格锁在拆单时的价。</span>}
          {(deal.split_children || []).map((c) => <span key={c.id}>以后再发的那部分在 <DealLink id={c.id} no={c.biz_no} />{c.want_on ? `（${dDate(c.want_on)} 发，${STATUS[c.status]?.label || c.status}）` : ''}</span>)}
        </div>)}
      {data.others?.length > 0 && (
        <div className="card card-b other-pending">
          <b>{deal.customer_name} 还有：</b>
          {data.others.map((o) => (
            <button type="button" key={o.id} className="pill amber" onClick={() => nav('deal/' + o.id)} title="打开那张单">
              {o.biz_no} · {[o.unsigned_n > 0 && `${o.unsigned_n} 批没签收`, o.balance_pending && '待对账', o.open_returns_n > 0 && '退货没走完'].filter(Boolean).join('、')} →
            </button>))}
        </div>
      )}
      {!cancelled && deal.status === 'quoted' && deal.approval === 'pending' && (
        <div className="banner info row" style={{ marginBottom: 12, gap: 8 }}>
          <span>⏳ 等中方审批：{deal.approval_reasons.join('、')}。批了以后才看得到价格、才能往下推。</span><span className="grow" />
          {role === 'admin' && <button type="button" className="btn sm primary" onClick={() => setApprove(true)}>审批</button>}
        </div>)}
      {!cancelled && deal.approval === 'rejected' && deal.status === 'quoted' && <ResubmitBanner deal={deal} act={act} role={role} />}
      {!cancelled && deal.approval === 'approved' && deal.status === 'quoted' && <div className="small muted" style={{ marginBottom: 8 }}>✓ 中方已批{deal.approval_note ? `（${deal.approval_note}）` : ''}</div>}
      {cancelled && <div className="lock" style={{ marginBottom: 12 }}>这张单已作废（取消），预占的库存已释放。作废不是删除：点上面的「恢复这张单」可以恢复为报价。</div>}
      {readOnly && !cancelled && <div className="readonly-bar">🔒 这一步已下推，只读。要修改请先「撤回到上一步」（主管 / 中方，需选原因）。</div>}
      {curKey === 'quote' && <><QuotePanel {...ctx} />{!cancelled && <ConfirmBlock {...ctx} />}</>}
      {curKey === 'pick' && <PickPanel {...ctx} />}
      {curKey === 'so' && <><SoPanel {...ctx} />{deal.so_no && <ConfirmPanel {...ctx} />}</>}
      {curKey === 'ship' && <ShipStepPanel {...ctx} />}
      {curKey === 'sign' && <SignPanel {...ctx} />}
      {curKey === 'pay' && <PayPanel {...ctx} />}
      {curKey === 'return' && <ReturnPanel {...ctx} />}

      <div className="card">
        <div className="card-h"><h2>操作记录</h2><span className="muted small">谁、什么时候、做了什么</span></div>
        <div className="card-b">
          <ul className="timeline">
            {data.events.map((e, i) => {
              const stepKey = EVENT_STEP[e.action]; const line = e.detail?.line && data.lines.find((l) => l.id === e.detail.line);
              const emp = (id) => data.employees.find((x) => x.id === id)?.short_name;
              // 221 (Frank 11-11): 写清楚 —— 谁点的按钮、替谁做的 (找货人 / 复核人)、改的是哪个型号; 点这一条回到那一步看当时的记录 (只读)
              const doer = e.action === 'pick_submitted' ? ['找货人', emp(e.detail?.picker)] : e.action === 'pick_reviewed' ? ['复核人', emp(e.detail?.reviewer)] : null;
              return (
              <li key={i}><b>{stepKey ? <button type="button" className="linkbtn" title="回到这一步看当时的记录（只读）" onClick={() => { setView(stepKey); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{EVENT_LABELS[e.action] || e.action}</button> : (EVENT_LABELS[e.action] || e.action)}</b>
                {doer && doer[1] && <span> · {doer[0]}：<b>{doer[1]}</b></span>}
                {e.short_name && !(doer && doer[1] === e.short_name) && <span className="muted"> · {doer && doer[1] ? `${e.short_name} 代点` : e.short_name}{e.roles ? `（${e.roles.map((r) => ROLES[r]?.label || r).join('/')}）` : ''}</span>}
                {line && <span> · <b>{line.model || line.req_model}</b></span>}
                {e.detail?.method && <span> · {CONFIRM_METHODS[e.detail.method] || e.detail.method}</span>}
                {e.detail?.note && <span> · {e.detail.note}</span>}
                {e.detail?.reason && <span> · 原因：{e.detail.reason}</span>}
                {e.detail?.ship_date && <span> · 约定发货 {e.detail.ship_date}</span>}
                {e.action === 'step_reverted' && <span> · {STATUS[e.detail.from]?.label} → {STATUS[e.detail.to]?.label}</span>}
                {e.action === 'qty_changed' && <span> · {e.detail.from} → {e.detail.to}</span>}
                {e.action === 'price_set' && <span> · {money(e.detail.from)} → {money(e.detail.to)}</span>}
                {e.action === 'pick_submitted' && Array.isArray(e.detail?.changes) && e.detail.changes.length > 0 && <span> · {e.detail.changes.length} 行实际供货和需求不一样</span>}
                {(e.action === 'shipped' || e.action === 'shipment_voided') && <span> · {e.detail.out_no} · {money(e.detail.amount)}</span>}
                {['receipt_discrepancy', 'discrepancy_corrected', 'discrepancy_decided'].includes(e.action) && <span>
                  {Array.isArray(e.detail?.lines) && <> · {e.detail.lines.map(discLineText).join('；')}</>}
                  {e.action === 'discrepancy_decided' && <> · 处理：{{ credit: N(e.detail.amount) < 0 ? '认，把之前扣的冲回' : '认，从客户账上扣掉', reship: '认，补发', reject: '不认' }[e.detail.decision]} · 责任：{e.detail.fault}{e.detail.goods_where ? ` · 货：${DISC_WHERE[e.detail.goods_where]}` : ''}</>}
                  {N(e.detail?.amount) !== 0 && <> · {N(e.detail.amount) > 0 ? '金额' : '冲回'} {money(Math.abs(N(e.detail.amount)), deal.currency)} {deal.currency}</>}
                  {e.detail?.late && <> · 超过 24 小时才反馈</>}</span>}
                {(e.action === 'prepayment_applied' || e.action === 'written_off') && <span> · {money(e.detail.amount)}</span>}
                <div className="when">{dt(e.at)}</div></li>
              );
            })}
          </ul>
        </div>
      </div>

      {approve && <ApproveModal deal={deal} lines={data.lines} onClose={() => setApprove(false)} />}
      {revert && <RevertModal deal={deal} act={act} onClose={() => setRevert(false)} onDone={() => { setRevert(false); setView(null); }} />}
    </>
  );
}

function RevertModal({ deal, act, onClose, onDone }) {
  const [reason, setReason] = useState(NOTE_OPTIONS.revert[0]);
  return (
    <Modal title="撤回到上一步" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>不撤回</button>
        <button type="button" className="btn primary" disabled={!reason?.trim()} onClick={() => act('已撤回，可以修改后重新下推', `select app.revert_step($1,$2)`, [deal.id, reason]).then(onDone, () => {})}>确认撤回</button></>}>
      <div className="stack">
        <div className="lock">{REVERT_LABEL[deal.status]}</div>
        <div className="hint">只能一步一步往回撤；已出库的不能撤回（只能走退货或「发货失败」）。撤回会记入操作记录：谁、何时、原因。</div>
        <div className="field req"><label>原因</label><OptionNote options={NOTE_OPTIONS.revert} value={reason} onChange={setReason} /></div>
      </div>
    </Modal>
  );
}


// 中方审批询单: 新客户先转正式 (编码 + 档位); 可以顺手给特价 (默认填销售员申请的价)
function ApproveModal({ deal, lines, onClose }) {
  const { role, toast, refresh } = useApp();
  const prospect = deal.customer_status !== 'active' || !deal.tier;
  const [code, setCode] = useState(''); const [tier, setTier] = useState('');
  const [sp, setSp] = useState(() => Object.fromEntries(lines.filter((l) => l.requested_price != null).map((l) => [l.id, String(Number(l.requested_price))])));
  const [note, setNote] = useState('');
  const go = async (ok) => {
    try {
      if (ok && prospect) await call(role, `select app.activate_customer($1,$2,$3)`, [deal.customer_id, code, tier]);
      await call(role, `select app.approve_quote($1,$2,$3,$4)`, [deal.id, ok, note || null,
        JSON.stringify(Object.entries(sp).filter(([, v]) => v !== '').map(([line_id, price]) => ({ line_id, price: Number(price) })))]);
      toast(ok ? '已批，员工现在看得到价格，可以发报价单' : '已退回'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={`审批 · ${deal.biz_no} · ${deal.customer_code || deal.temp_code} ${deal.customer_name}`} onClose={onClose}
      footer={<><button type="button" className="btn" disabled={!note.trim()} onClick={() => go(false)}>不批（写原因）</button><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={prospect && (!code.trim() || !tier)} onClick={() => go(true)}>批准</button></>}>
      <div className="stack">
        <div className="hint">要审批的原因：{deal.approval_reasons.join('、')}</div>
        {prospect && <div className="grid2">
          <div className="field req"><label>新客户：正式编码</label><input className="in mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></div>
          <div className="field req"><label>档位（决定价格）</label><div className="chips">{Object.entries(TIERS).map(([k, l]) => <button type="button" key={k} className={`chip ${tier === k ? 'on' : ''}`} onClick={() => setTier(k)}>{l}</button>)}</div></div></div>}
        <Grid id="approve-lines" noTools rows={lines} columns={[
          { key: 'code', label: '编码', w: 90, value: (l) => l.code || '没编码', mono: true },
          { key: 'model', label: '型号', w: 150, value: (l) => l.model, render: (l) => <><ModelLink id={l.product_id} model={l.model} tier={deal.tier} /> <span className="muted small">{l.category}</span></> },
          { key: 'qty', label: '数量', w: 70, value: (l) => l.qty_req, render: (l) => qty(l.qty_req) },
          { key: 'tp', label: '档位价', w: 100, value: (l) => l.tier_price, render: (l) => (l.tier_price != null ? money(l.tier_price) : '—') },
          { key: 'rp', label: '销售员申请', w: 100, value: (l) => l.requested_price, render: (l) => (l.requested_price != null ? <b className="amber-t2">{money(l.requested_price)}</b> : '') },
          { key: 'ap', label: '批的价（空 = 按档位价）', w: 150, fill: true, value: (l) => sp[l.id] ?? '', render: (l) => (sp[l.id] ? money(sp[l.id]) : <span className="muted">按档位价</span>),
            edit: (l) => (l.product_id ? { type: 'number', value: sp[l.id] ?? '', onChange: (v) => setSp((x) => ({ ...x, [l.id]: String(v ?? '').replace(/[^\d.]/g, '') })) } : null) },
        ]} />
        <div className="field"><label>备注 / 不批的原因</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

// 191 驳回 ≠ 作废: 单子照常可用, 改好后「重新提交审批」; 客户还款后系统也会自动重新判断
function ResubmitBanner({ deal, act, role }) {
  const [note, setNote] = useState('');
  return (
    <div className="banner warn row" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
      <span>中方没批{deal.approval_note ? `：${deal.approval_note}` : ''}。单子还在，可以改报价、联系客户；客户付了款系统会自动重新判断。</span>
      <span className="grow" />
      {can(role, 'quote') && <>
        <input className="in sm" style={{ width: 220 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明（例：下午已付清 / 已改价）" />
        <button type="button" className="btn sm primary" onClick={() => act('已重新提交审批', `select app.resubmit_approval($1,$2)`, [deal.id, note || null]).then(() => setNote(''), () => {})}>重新提交审批</button>
      </>}
    </div>
  );
}
