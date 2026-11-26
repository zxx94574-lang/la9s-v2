// 11-13 批 (待改 277–290 + 财务 B1–B10) 的待办板块:
// MoneyUrgent —— 收款问题一律最优先: 付款申诉 (只中方) / 员工代收超过 1 天没交 / 账对不上 (每日自检)
// ChangeNotices —— 「变更通知」: 不按正常流程走的事一条条记, 中方点「已阅」才消失
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Pill, Info, Thumb, TierText } from './ui.jsx';
import Grid from './Grid.jsx';
import { CustLink, DealLink, EmpLink } from './Archives.jsx';
import { NoteModal } from '../pages/DealPanels.jsx';
import { EVENT_LABELS, STATUS, ROLES, TIERS, hasAny } from '../lib/domain.js';
import { money, qty, dt, friendlyError } from '../lib/format.js';

export function MoneyUrgent() {
  const { org, role, toast, refresh, go } = useApp();
  const [decide, setDecide] = useState(null);
  const admin = role === 'admin';
  const { data } = useData(async () => {
    const [[rule], appeals, held, diffs] = await Promise.all([
      q(`select value from app.org_settings where org_id = $1 and key = 'cash_rules'`, [org]),
      admin ? q(`select a.id, a.deal_id, a.note, a.proof, a.created_at, d.biz_no, c.id as customer_id, c.name as customer_name, coalesce(e.short_name, e.full_name) as by_name
        from app.payment_appeals a join app.deals d on d.id = a.deal_id join app.customers c on c.id = d.customer_id
        left join app.members m on m.user_id = a.created_by left join app.employees e on e.id = m.employee_id
        where a.org_id = $1 and a.status = 'open' order by a.created_at`, [org]) : [],
      hasAny(role, ['admin', 'finance', 'manager', 'sales_manager']) ? q(`select * from app.v_staff_held where org_id = $1 order by received_on`, [org]) : [],
      admin ? call(role, `select * from app.ledger_check($1)`, [org]).catch(() => []) : []]);
    const days = Number(rule?.value?.held_days ?? 1);
    return { appeals, held: held.filter((h) => Number(h.days) >= days), days, diffs };
  }, [org, role]);
  if (!data || (!data.appeals.length && !data.held.length && !data.diffs.length)) return null;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: '#f3b4b4' }}>
      <div className="card-h"><h2>收款问题 · 最优先</h2><Pill tone="red">{data.appeals.length + data.held.length + data.diffs.length} 件</Pill>
        <Info>收款的事一律排最前：客户说已付的申诉、员工手上超过 {data.days} 天没交的客户钱、账对不上。处理完自动消失。</Info></div>
      {data.appeals.length > 0 && <>
        <div className="grid-tools" style={{ borderBottom: 0 }}><b>付款申诉（客户说已经付了，等你核对）</b></div>
        <Grid id="todo-appeals" noTools rows={data.appeals} rowActions={[{ label: '核对到了 → 放行这张单', run: (a) => setDecide({ a, ok: true }) }, { label: '没查到 → 不放行', tone: 'soft-red', run: (a) => setDecide({ a, ok: false }) }]} columns={[
          { key: 'biz_no', label: '订单', w: 130, render: (a) => <DealLink id={a.deal_id} no={a.biz_no} /> },
          { key: 'customer_name', label: '客户', w: 120, render: (a) => <CustLink id={a.customer_id} name={a.customer_name} /> },
          { key: 'note', label: '申诉内容', w: 320 },
          { key: 'proof', label: '付款截图', w: 80, sortable: false, render: (a) => <Thumb src={a.proof} label="付款截图" size={30} /> },
          { key: 'by_name', label: '谁提的', w: 90 },
          { key: 'created_at', label: '什么时候', w: 130, render: (a) => dt(a.created_at) },
        ]} />
      </>}
      {data.held.length > 0 && <>
        <div className="grid-tools" style={{ borderBottom: 0 }}><b>员工手上的客户钱，超过 {data.days} 天还没交</b><span className="small muted">不管金额大小，当天收当天交；一直催到交为止</span>
          <span className="grow" /><button type="button" className="btn sm" onClick={() => go('cash')}>去「资金账户 → 员工代收」登记交款</button></div>
        <Grid id="todo-held" noTools rows={data.held} rowKey={(h) => h.receipt_id} columns={[
          { key: 'employee_name', label: '员工', w: 100, render: (h) => <EmpLink id={h.employee_id} name={h.employee_name} /> },
          { key: 'customer_name', label: '客户', w: 130, render: (h) => <CustLink id={h.customer_id} name={h.customer_name} /> },
          { key: 'rcv_no', label: '收款单', w: 130 },
          { key: 'amount', label: '金额', w: 110, type: 'money', render: (h) => `${money(h.landed ?? h.amount)} ${h.currency}` },
          { key: 'days', label: '在手上几天', w: 100, render: (h) => <Pill tone="red">{h.days} 天</Pill> },
        ]} />
      </>}
      {data.diffs.length > 0 && <>
        <div className="grid-tools" style={{ borderBottom: 0 }}><b>账对不上（系统自检）</b><Info>每个客户「各张单的欠款加起来 − 还没冲的预付」应该等于总账余额。对不上说明有一笔账记歪了，把这张表截图发给 Claude 查。</Info></div>
        <Grid id="todo-ledger" noTools rows={data.diffs} rowKey={(r) => r.customer_id + r.currency} columns={[
          { key: 'customer_name', label: '客户', w: 150, render: (r) => <CustLink id={r.customer_id} name={r.customer_name} /> },
          { key: 'currency', label: '币种', w: 60 },
          { key: 'balance', label: '总账余额', w: 120, type: 'money', render: (r) => money(r.balance) },
          { key: 'due_sum', label: '各单欠款合计', w: 120, type: 'money', render: (r) => money(r.due_sum) },
          { key: 'unallocated', label: '没冲的预付', w: 110, type: 'money', render: (r) => money(r.unallocated) },
          { key: 'diff', label: '差多少', w: 110, type: 'money', render: (r) => <b style={{ color: 'var(--red)' }}>{money(r.diff)}</b> },
        ]} />
      </>}
      {decide && <NoteModal title={`${decide.ok ? '放行' : '不放行'} ${decide.a.biz_no}（${decide.a.customer_name}）`} label="核对结果（必填：在哪查到 / 为什么没查到）" danger={!decide.ok} okText={decide.ok ? '查到了，放行这张单' : '没查到，不放行'}
        hint={decide.ok ? '放行只对这张单有效。钱到了记得去「收款」登记，欠款清了销售员名下的客户才会全部放开。' : undefined}
        onClose={() => setDecide(null)}
        onOk={async (note) => { try { await call(role, `select app.decide_payment_appeal($1,$2,$3)`, [decide.a.id, decide.ok, note]); toast(decide.ok ? '已放行' : '已驳回申诉'); setDecide(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }} />}
    </div>
  );
}

// 一条变更写成完整一句: 谁 / 什么时候 / 哪张单 / 改了什么 (改前 → 改后) / 原因
export function noticeText(n) {
  const d = n.detail || {}; const m = n.model ? `${n.model} ` : '';
  switch (n.kind) {
    case 'qty_changed': return `${m}数量 ${qty(d.from)} → ${qty(d.to)}${d.reason ? `（${d.reason}）` : ''}`;
    case 'price_set': return `${m}单价 ${money(d.from)} → ${money(d.to)}${d.reason ? `（${d.reason}）` : ''}`;
    case 'price_requested': return `申请改价：${m}${money(d.from)} → ${money(d.to)}（${d.reason || ''}）`;
    case 'price_decided': return `改价申请${d.ok ? '已批准' : '没批'}：${m}${money(d.from)} → ${money(d.to)}；中方备注：${d.note || ''}`;
    case 'lines_added': return `出库前追加了 ${d.count} 行货`;
    case 'step_reverted': return `撤回：${STATUS[d.from]?.label || d.from} → ${STATUS[d.to]?.label || d.to}${d.reason ? `（${d.reason}）` : ''}`;
    case 'shipment_voided': return `撤销出库 ${d.out_no || ''}，金额 ${money(d.amount)}${d.reason ? `（${d.reason}）` : ''}`;
    case 'deal_split': return `拆单：${d.lines} 行拆到 ${d.to_no || '新单'}${d.note ? `（${d.note}）` : ''}`;
    case 'quote_edited': return '客户确认之后又改了报价（增删行 / 改数量）';
    case 'receipt_voided': return `撤销收款${d.rcv_no ? ' ' + d.rcv_no : ''}${d.reason ? `（${d.reason}）` : ''}`;
    case 'price_adjusted': return `出库后调整价格 ${money(d.amount)}${d.reason ? `（${d.reason}）` : ''}`;
    case 'debt_released': return `中方放行欠款拦截（${d.note || ''}）`;
    case 'payment_appeal': return `付款申诉：${d.note || ''}`;
    case 'cancelled': return `找货之后取消订单${d.reason ? `（${d.reason}）` : ''}`;
    case 'partial_reason': return `只发了一部分：${d.reason || ''}`;
    case 'written_off': return `抹零 ${money(d.amount)}${d.reason ? `（${d.reason}）` : ''}`;
    case 'bad_debt_written_off': return `坏账核销 ${money(d.amount)}${d.reason ? `（${d.reason}）` : ''}`;
    case 'gate_released': return `中方放行出库（${d.kind === 'qty' ? '数量超过客户确认的' : '超欠款上限 / 账期'}）：${d.note || ''}`;
    case 'tier_changed': return `${d.customer || '客户'} 档位 ${TIERS[d.from] || d.from} → ${TIERS[d.to] || d.to}`;
    case 'fob_to_local': return `FOB ${d.fob_no || ''} 客户不要了：${d.qty} 片转进 ${d.warehouse} 仓（${d.reason || ''}）${Number(d.over) > 0 ? `，多收订金 ${money(d.over)} ${({ credit: '转预付', keep: '不退', refund: '要退' })[d.deposit] || ''}` : ''}`;
    case 'receipt_in': return `收款 ${d.rcv_no || ''}：${money(d.amount, d.currency)} ${d.currency}${d.currency !== d.account_currency ? `（折 ${money(d.converted, d.account_currency)} ${d.account_currency}）` : ''} · ${d.method || ''}`;
    case 'dup_photo': return `重复照片：「${d.where || '凭证'}」用的图已经用在 ${d.uses || '别处'}`;
    default: return EVENT_LABELS[n.kind] || n.kind;
  }
}
// 11-18 (Frank 第 7 点): 大变动 = 红 (撤销出库 / 撤销收款 / 确认后改数量改价 / 找货后作废 / 抹零核销 / 改档位); 其余黄
const KIND_TONE = { qty_changed: 'red', cancelled: 'red', written_off: 'red', bad_debt_written_off: 'red', tier_changed: 'red', quote_edited: 'red', price_set: 'red', price_requested: 'red', price_decided: 'red', price_adjusted: 'red', shipment_voided: 'red', receipt_voided: 'red', dup_photo: 'amber', receipt_in: 'green', fob_to_local: 'red' };

export function ChangeNotices() {
  const { org, role, toast, refresh } = useApp();
  const [sel, setSel] = useState(new Set());
  const { data } = useData(() => q(`select n.id, n.kind, n.detail, n.at, n.deal_id, d.biz_no, c.id as customer_id, c.name as customer_name,
      coalesce(e.short_name, e.full_name) as by_name, to_jsonb(m.roles::text[]) as roles,
      (select coalesce(p.model, l.req_model) from app.deal_lines l left join app.products p on p.id = l.product_id where l.id::text = n.detail->>'line') as model
    from app.change_notices n left join app.deals d on d.id = n.deal_id left join app.customers c on c.id = coalesce(d.customer_id, nullif(n.detail->>'customer_id', '')::uuid)
    left join app.members m on m.user_id = n.by_user left join app.employees e on e.id = m.employee_id
    where n.org_id = $1 and n.read_at is null order by n.at desc limit 200`, [org]), [org]);
  // 371 (Frank 11-18): 板块永远在 (没有就显示 0 条); 已阅不是没了, 进「已阅记录」可回看; 已阅必须先勾选 (表头可全选), 没有不选就能点的「全部已阅」
  const [hist, setHist] = useState(false);
  const { data: read } = useData(() => (hist ? q(`select n.id, n.kind, n.detail, n.at, n.read_at, n.deal_id, d.biz_no, c.id as customer_id, c.name as customer_name,
      coalesce(e.short_name, e.full_name) as by_name, coalesce(re.short_name, re.full_name, '中方') as read_name,
      (select coalesce(p.model, l.req_model) from app.deal_lines l left join app.products p on p.id = l.product_id where l.id::text = n.detail->>'line') as model
    from app.change_notices n left join app.deals d on d.id = n.deal_id left join app.customers c on c.id = coalesce(d.customer_id, nullif(n.detail->>'customer_id', '')::uuid)
    left join app.members m on m.user_id = n.by_user left join app.employees e on e.id = m.employee_id
    left join app.members rm on rm.user_id = n.read_by and rm.org_id = n.org_id left join app.employees re on re.id = rm.employee_id
    where n.org_id = $1 and n.read_at is not null order by n.read_at desc limit 500`, [org]) : Promise.resolve([])), [org, hist]);
  if (role !== 'admin') return null;
  const list = data || [];
  const ack = async (ids) => { try { await call(role, `select app.ack_change_notices($1)`, [ids]); toast(`已阅 ${ids.length} 条`); setSel(new Set()); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>变更通知</h2>{list.some((n) => KIND_TONE[n.kind] === 'red') && <Pill tone="red">{list.filter((n) => KIND_TONE[n.kind] === 'red').length} 条大变动</Pill>}<Pill tone={list.length ? 'amber' : 'gray'}>{list.length} 条没看</Pill>
        <Info>不按正常流程走的事都记在这里：确认后改数量、改价和审批结果、撤回、撤销出库 / 收款、拆单、重复照片…… 数量改动不用审批，只通知。看过的先勾选（表头可以全选）再点「已阅」；已阅的进「已阅记录」，随时能回看。</Info>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={!sel.size} title={sel.size ? '' : '先勾选要标已阅的（表头可以全选）'} onClick={() => ack([...sel])}>已阅选中的 {sel.size} 条</button>
        <button type="button" className={`btn sm ${hist ? 'primary' : ''}`} onClick={() => setHist(!hist)}>已阅记录</button></div>
      {!list.length && !hist && <div className="card-b small muted">没有没看的变更通知。</div>}
      {hist && <Grid id="todo-notices-read" rows={read || []} empty="还没有已阅的通知" maxHeight={420} columns={[
        { key: 'read_at', label: '什么时候阅的', w: 130, render: (n) => dt(n.read_at) },
        { key: 'read_name', label: '谁阅的', w: 90 },
        { key: 'at', label: '什么时候发生', w: 130, render: (n) => dt(n.at) },
        { key: 'by_name', label: '谁做的', w: 90, value: (n) => n.by_name || '' },
        { key: 'biz_no', label: '订单', w: 130, render: (n) => (n.deal_id ? <DealLink id={n.deal_id} no={n.biz_no} /> : '—') },
        { key: 'customer_name', label: '客户', w: 120, render: (n) => (n.customer_id ? <CustLink id={n.customer_id} name={n.customer_name} /> : '') },
        { key: 'kind', label: '类型', w: 110, value: (n) => (n.kind === 'receipt_in' ? '收款' : n.kind === 'fob_to_local' ? 'FOB 转本地' : EVENT_LABELS[n.kind] || (n.kind === 'dup_photo' ? '重复照片' : n.kind)), render: (n) => <Pill tone="gray">{n.kind === 'dup_photo' ? '重复照片' : n.kind === 'price_decided' ? '改价审批' : n.kind === 'payment_appeal' ? '付款申诉' : n.kind === 'receipt_in' ? '收款' : EVENT_LABELS[n.kind] || n.kind}</Pill> },
        { key: 'text', label: '改了什么', w: 420, value: noticeText, render: (n) => (n.kind === 'tier_changed' ? <TierText>{noticeText(n)}</TierText> : noticeText(n)) },
      ]} />}
      {!hist && list.length > 0 && <>      <Grid id="todo-notices" noTools rows={[...list].sort((a, b) => (KIND_TONE[b.kind] === 'red') - (KIND_TONE[a.kind] === 'red'))} selectable={{ selected: sel, onChange: setSel }} columns={[
        { key: 'at', label: '什么时候', w: 120, render: (n) => dt(n.at) },
        { key: 'by_name', label: '谁', w: 110, value: (n) => n.by_name || '', render: (n) => <>{n.by_name || '—'} <span className="small muted">{(n.roles || []).map((r) => ROLES[r]?.label || r).join(' / ')}</span></> },
        { key: 'biz_no', label: '订单', w: 130, render: (n) => (n.deal_id ? <DealLink id={n.deal_id} no={n.biz_no} /> : '—') },
        { key: 'customer_name', label: '客户', w: 120, render: (n) => (n.customer_id ? <CustLink id={n.customer_id} name={n.customer_name} /> : '') },
        { key: 'kind', label: '类型', w: 110, value: (n) => EVENT_LABELS[n.kind] || (n.kind === 'dup_photo' ? '重复照片' : n.kind), render: (n) => <Pill tone={KIND_TONE[n.kind] || 'amber'}>{n.kind === 'dup_photo' ? '重复照片' : n.kind === 'price_decided' ? '改价审批' : n.kind === 'payment_appeal' ? '付款申诉' : EVENT_LABELS[n.kind] || n.kind}</Pill> },
        { key: 'text', label: '改了什么', w: 420, value: noticeText, render: (n) => (n.kind === 'tier_changed' ? <TierText>{noticeText(n)}</TierText> : noticeText(n)) },
      ]} /></>}
    </div>
  );
}
