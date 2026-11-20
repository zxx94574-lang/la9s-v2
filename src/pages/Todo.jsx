import { PurchaseTodo } from './Po.jsx';
import { DealLink, CustLink } from '../components/Archives.jsx';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Info, Modal, MultiChoice, Assumed } from '../components/ui.jsx';
import { IssueList } from '../components/IssueReport.jsx';
import TierCheck, { useTierCheck } from '../components/TierCheck.jsx';
import DirectiveBoard from '../components/Directives.jsx';
import { STATUS, ROLES } from '../lib/domain.js';
import { money, dt, dDate, today, friendlyError } from '../lib/format.js';

// who acts next on a deal in this status
const NEXT = {
  quoted: { roles: ['hotline', 'manager'], what: '联系客户确认，确认后下推找货' },
  hotline_ok: { roles: ['manager', 'hotline'], what: '客户已确认，下推找货（预占库存）' },
  picking: { roles: ['picker', 'manager', 'sales'], what: '主管先派人；被派的人按找货单逐行打勾（只集中放一堆，不打包），拍照提交，销售订单自动生成' },
  picked: { roles: ['manager'], what: '生成销售订单（定价）' },
  ordered: { roles: ['hotline'], what: '把销售订单发客户，确认后点「客户确认」' },
  confirmed: { roles: ['manager'], what: '复检抽检 + 打包，上传打包照片' },
  reviewed: { roles: ['manager'], what: '安排发货，填出库信息和凭证' },
  partial: { roles: ['manager'], what: '剩余部分待出库' },
};
export function shipAlert(d) {
  if (!d.planned_ship_date || !['confirmed', 'reviewed', 'partial'].includes(d.status)) return null;
  const p = dDate(d.planned_ship_date), t = today();
  return p < t ? { tone: 'red', text: `约定 ${p} 发货，已过期未出库` } : p === t ? { tone: 'amber', text: '今天该出库' } : { tone: 'gray', text: `约定 ${p} 发货` };
}
import { HoldsCard, VolumeShift } from '../components/Batch2.jsx';
import { MoneyUrgent, ChangeNotices } from '../components/Batch3.jsx';
import { InquiryTodo } from './Inquiry.jsx';
import { AddonTodo } from '../components/Addons.jsx';
import { AnomalyHub } from '../components/Anomalies.jsx';
import { useKdTodoCount } from '../components/KdRecon.jsx';
import PublicHeld from '../components/PublicHeld.jsx';
import { RemitTodo } from '../components/Remit.jsx';
import { PlanTodo, TaskBoard } from '../components/Tasks.jsx';
export function nextAction(d, role) {
  // 251: 新客户档位没定 → 这张报价是草稿; 申请了就卡在中方
  if (d.status === 'quoted' && d.tier_pending) return d.tier_requested_at ? { roles: ['admin'], what: '给这个新客户定档位（员工已申请，报价等着发给客户）' } : { roles: ['hotline', 'manager', 'sales', 'sales_manager'], what: '草稿：客户档位没定，点进去「申请定级」，中方定了再发给客户' };
  if (Number(d.appeal_n || 0) > 0) return { roles: ['admin'], what: '付款申诉：客户说已经付了，核对到了就放行这张单（收款问题最优先）' };
  if (Number(d.price_req_n || 0) > 0) return { roles: ['admin'], what: `有 ${d.price_req_n} 行改价等你批（批 / 不批都要写备注），批完才能发销售单` };
  if (quoteLate(d)) return { roles: ['hotline', 'manager', 'sales_manager', 'admin'], what: `报价建好已经 ${Math.round((Date.now() - new Date(d.created_at).getTime()) / 6e4)} 分钟，热线还没点开（规定 5 分钟内）：马上联系客户确认` };
  if (Number(d.frozen_n || 0) > 0 && !['shipped', 'cancelled'].includes(d.status)) return { roles: ['admin', 'manager'], what: `这单有 ${d.frozen_n} 个型号被暂停出库（问题库存），解冻前不能发` };
  if (d.status === 'ordered' && d.so_sent_at && Date.now() - new Date(d.so_sent_at).getTime() > 864e5) return { roles: ['hotline', 'manager', 'admin'], what: `销售单发出超过 1 天客户没回：必须联系上，要 / 不要都要有结果（不要就作废并写原因）` };
  // 236: 约定发货日没到 → 先放暂存位置, 不复检
  if (d.status === 'confirmed' && d.planned_ship_date && dDate(d.planned_ship_date) > today()) {
    return d.staged_at ? { roles: ['manager'], what: `等待发货 · 约 ${dDate(d.planned_ship_date)} · 货放在：${d.staged_note || '（没写）'}，到那天再复检打包` } : { roles: ['manager', 'picker'], what: `约 ${dDate(d.planned_ship_date)} 发货：先把货放到暂存位置（不打包），拍照` };
  }
  if (d.status === 'shipped' && Number(d.unsigned_n || 0) > 0) return { roles: ['hotline', 'manager'], what: `联系客户确认收货，${d.unsigned_n} 批待签收（传签收凭证）` };
  if (Number(d.freight_due_n || 0) > 0 && ['finance', 'admin'].includes(role)) return { roles: ['finance', 'admin'], what: `付 Yango 运费（${d.freight_due_n} 批，司机在等）：付完传支付截图，自动记流水` };
  if (d.status === 'shipped' && Number(d.open_disc_n || 0) > 0) return { roles: ['admin'], what: '客户反馈收货有差异（少了 / 发错）：查清是谁的问题、货在哪，定怎么处理' };
  if (d.status === 'shipped' && d.balance_pending) return { roles: ['hotline', 'finance'], what: '和客户对账：发 Balance，客户确认后传截图' };
  if (d.status === 'shipped' && Number(d.due) > 0) return { roles: ['finance'], what: `催收 / 登记收款，未付 ${money(d.due)}` };
  const a = shipAlert(d);
  if (a && a.tone !== 'gray') return { roles: ['manager'], what: `${a.text}：安排发货，填出库信息和凭证`, alert: a };
  if (d.status === 'quoted' && d.hotline_busy_at) return { ...NEXT.quoted, what: `客户之前说忙（${dt(d.hotline_busy_at)}），再联系一次确认`, alert: { tone: 'amber', text: '客户忙，稍后联系' } };
  return NEXT[d.status] || null;
}
export function todoFor(role, d) {
  const n = nextAction(d, role);
  if (!n) return false;
  return role === 'admin' ? !['shipped', 'cancelled'].includes(d.status) || Number(d.due) > 0 || Number(d.unsigned_n || 0) > 0 || !!d.balance_pending || Number(d.open_disc_n || 0) > 0 || Number(d.freight_due_n || 0) > 0 : n.roles.includes(role);
}

// 超期未发货 (Frank 11-01: 没人跟进, 十几天后才发现没发货, 客户就不理我们了):
// 下单 (建报价) 以后还没出库完的单, 按时长分级: 超过 24 小时黄、48 小时红、72 小时深红置顶闪.
// 规则先这样定, 阈值以后可以调. 报价没成交的单也算 —— 要么推进, 要么作废, 不能放着.
// 227: 一张单算哪一级 (系统自动分, 中方可手动提成紧急)
// 报价建好 → 热线最多 5 分钟要点开 (Frank 11-12, 和指令同一个分钟数; 页面不知道设置时按 5)
export const quoteLate = (d, minutes = 5) => d.status === 'quoted' && !d.tier_pending && d.approval !== 'pending' && !d.hotline_opened_at && !Number(d.busy_n || 0) && d.created_at && Date.now() - new Date(d.created_at).getTime() > minutes * 6e4;
export function todoLevel(d) {
  const td = today();
  if (d.urgent || Number(d.open_disc_n || 0) > 0 || Number(d.freight_due_n || 0) > 0) return 'red';
  // 11-12 Frank: 但凡卡单的一律紧急 —— 等中方审批 / 等中方定档位 / 货被冻结 / 销售单发出超过 1 天客户没回
  if (d.approval === 'pending' || (d.status === 'quoted' && d.tier_pending && d.tier_requested_at) || Number(d.frozen_n || 0) > 0) return 'red';
  if (d.status === 'ordered' && d.so_sent_at && Date.now() - new Date(d.so_sent_at).getTime() > 864e5) return 'red';
  if (Number(d.appeal_n || 0) > 0 || Number(d.price_req_n || 0) > 0) return 'red';   // 付款申诉 / 改价等中方批 = 卡单
  if (quoteLate(d)) return 'red';   // 报价建好超过 5 分钟热线还没点开
  if (d.status === 'picking' && !d.pick_assignee_employee_id) return 'red';   // 398: 等主管安排谁去找货 = 卡单
  if (Number(d.busy_n) >= 3 && ['quoted', 'hotline_ok'].includes(d.status)) return 'green';     // 联系 3 次都忙 = 这单没那么重要
  if (d.want_on && dDate(d.want_on) > td && !['shipped', 'cancelled'].includes(d.status)) return 'green';   // 客户约了明天以后
  if (d.status === 'confirmed' && d.planned_ship_date && dDate(d.planned_ship_date) > td) return 'green';   // 约定发货日还没到
  if (d.status === 'shipped' && !Number(d.unsigned_n) && !d.balance_pending && Number(d.due) > 0) return 'green';   // 只剩等客户付款
  if (overdueOf(d) || (d.want_on && dDate(d.want_on) <= td && !['shipped', 'cancelled'].includes(d.status))) return 'red';
  return 'amber';
}
export function overdueOf(d) {
  if (['shipped', 'cancelled'].includes(d.status) || !d.created_at) return null;
  const h = (Date.now() - new Date(d.created_at).getTime()) / 36e5;
  if (h < 24) return null;
  return { h, tier: h >= 72 ? 'crit' : h >= 48 ? 'red' : 'amber', label: h >= 48 ? `${Math.floor(h / 24)} 天` : `${Math.floor(h)} 小时` };
}
export const overdueList = (orders) => orders.map((d) => ({ d, o: overdueOf(d) })).filter((x) => x.o).sort((a, b) => b.o.h - a.o.h);

export function OverdueBar({ orders, go, compact }) {
  const list = overdueList(orders || []);
  if (!list.length) return <div className="overdue clear"><div className="oh">✓ 没有超过 24 小时还没发货的单</div></div>;
  const n = (t) => list.filter((x) => x.o.tier === t).length;
  return (
    <div className="overdue">
      <div className="oh">⏰ {list.length} 张单下单超过 24 小时还没发货
        <span className="age crit">≥3 天 {n('crit')}</span><span className="age red">≥2 天 {n('red')}</span><span className="age amber">≥1 天 {n('amber')}</span>
        <span className="grow" /><span className="small" style={{ fontWeight: 500 }}>每一张都要有人推进：要么往下推，要么作废写原因</span></div>
      {list.slice(0, compact ? 5 : 100).map(({ d, o }) => {
        const nx = nextAction(d);
        return (
          <div key={d.id} className="orow" onClick={() => go('deal/' + d.id)}>
            <span className={`age ${o.tier}`}>{o.label}</span>
            <span><CustLink id={d.customer_id} name={d.customer_name} /> <span className="small"><DealLink id={d.id} no={d.biz_no} /></span></span>
            <span className="hm"><Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill></span>
            <span className="hm small">负责：<b>{nx ? nx.roles.map((r) => ROLES[r]?.label || r).join(' / ') : '—'}</b>{d.owner_name ? ` · 归属 ${d.owner_name}` : <span className="red-t"> · 没有归属销售</span>}</span>
            <span className="muted">›</span>
          </div>);
      })}
      {compact && list.length > 5 && <div className="orow" style={{ gridTemplateColumns: '1fr' }} onClick={() => go('todo')}><b className="red-t">还有 {list.length - 5} 张 → 全部看「我的待办」</b></div>}
    </div>
  );
}

export default function Todo() {
  const { org, role, go, toast, refresh, tick } = useApp();
  const { data } = useData(() => q(Q.orders, [org, '2000-01-01', '2999-12-31']), [org, tick]);
  // 非订单的待办: 今天要回访的客户 (热线 / 销售), 待认领到账 + 待批交款支出 (中方)
  const { data: extra } = useData(async () => {
    const [[f]] = await Promise.all([q(`select
      (select count(*) from app.customers c where c.org_id = $1 and exists (select 1 from app.hotline_calls h where h.customer_id = c.id and h.next_follow_on <= current_date
         and h.at = (select max(at) from app.hotline_calls where customer_id = c.id and line = h.line))) as follow,
      (select count(*) from app.cash_moves m where m.org_id = $1 and m.status in ('unclaimed','pending','unexplained')) as cash,
      (select count(*) from app.payment_notices n where n.org_id = $1 and n.status = 'open') as notices,
      (select count(*) from app.v_fob f where f.org_id = $1 and f.status = 'applied' and f.unpriced > 0) as fob_price,
      (select count(*) from app.v_fob f where f.org_id = $1 and f.status = 'arrived') as fob_release,
      (select count(*) from app.kingdee_outbox k where k.org_id = $1 and k.status = 'ready') as kd_ready,
      (select count(*) from app.kingdee_outbox k where k.org_id = $1 and k.status = 'submitted') as kd_audit,
      (select count(*) from app.deals d where d.org_id = $1 and d.approval = 'pending' and d.status = 'quoted') as approvals,
      (select count(*) from app.purchase_requests r where r.org_id = $1 and r.status in ('ordered','shipped') and r.eta is not null and r.eta <= current_date + 5) as pr_eta,
      (select count(*) from app.purchase_requests r where r.org_id = $1 and r.status = 'submitted') as pr_new,
      (select count(*) from app.po_receipts g where g.org_id = $1 and g.kd_status = 'ready') as grn_ready,
      (select count(*) from app.account_events e join app.customer_accounts a on a.id = e.account_id where a.org_id = $1 and e.kind = 'pw_changed' and e.acked_at is null) as pw_changed,
      (select count(*) from app.deals d where d.org_id = $1 and d.source = 'guest' and d.status = 'quoted') as guest_new`, [org])]);
    return f;
  }, [org]);
  const kdTodo = useKdTodoCount();
  // 客户要货日期到了 (今天或已过) 的排最前 (Frank 11-07: 明天要的到明天自动前移)
  const td = today();
  const wantDue = (d) => d.want_on && dDate(d.want_on) <= td && !['shipped', 'cancelled'].includes(d.status);
  const rank = (d) => (wantDue(d) ? -1 : nextAction(d, role)?.alert?.tone === 'red' ? 0 : nextAction(d, role)?.alert ? 1 : 2);
  const tierRows = useTierCheck();
  const list = (data || []).filter((d) => todoFor(role, d)).sort((a, b) => rank(a) - rank(b));
  // 448 (Frank 11-19 22:07–22:22): 每个岗位的待办只有三段 —— 紧急 / 进行中 / 待跟进. 其他所有板块都变成这三段里的一行 (有事才出现, 点开才展开).
  // 中方另外多三块: 我下达的指令 / 定期任务 / 变更通知. 做完的自动消失 (进各自的记录).
  // 昨天以前就该推进、到今天还没动的「进行中」自动升成紧急 (等客户 / 等别人的不升).
  const groups = { red: [], amber: [], green: [] };
  const stale = (d) => d.updated_at && dt(d.updated_at).slice(0, 10) < td && !['ordered', 'shipped'].includes(d.status);
  for (const d of list) { const lv = todoLevel(d); const up = lv === 'amber' && stale(d); groups[up ? 'red' : lv].push(up ? { ...d, _stale: true } : d); }
  const urgent = async (e, d) => { e.stopPropagation(); try { await call(role, `select app.set_deal_urgent($1,$2)`, [d.id, !d.urgent]); toast(d.urgent ? '已取消紧急' : '已提成紧急'); refresh(); } catch (er) { toast(friendlyError(er), 'err'); } };
  const SEC = [['red', '紧急', '今天必须处理：异常的单、卡住的单、超过 24 小时没发货、客户今天要货、中方标了紧急的、昨天就该推进到今天还没动的'], ['amber', '进行中', '正常在走、今天该推进的'], ['green', '待跟进', '还没到日子的、等客户付款的、联系 3 次客户都忙的、要留意但不急的']];
  const admin = role === 'admin';
  const { data: routeSet } = useData(async () => (await q(`select value from app.org_settings where org_id = $1 and key = 'todo_route'`, [org]))[0]?.value || {}, [org, tick]);
  const [routeOpen, setRouteOpen] = useState(false);
  const mine = (id) => (routeSet?.[id] || SLOTS[id].roles).includes(role);
  const ex = (k) => Number(extra?.[k] || 0);
  const line = (id, to, text) => mine(id) && <div key={id} className="row between todo-row" onClick={() => go(to)}><b>{text}</b><span className="muted">›</span></div>;
  const slot = (id, node, open0) => mine(id) && <Slot key={id} title={SLOTS[id].label} open0={open0}>{node}</Slot>;
  const items = {
    red: [
      slot('anomaly', <AnomalyHub />, true),
      !admin && slot('directives', <DirectiveBoard />, true),
      slot('returns', <OpenReturns />, true),
      slot('money', <><PlanTodo /><PublicHeld urgentOnly /><RemitTodo /><MoneyUrgent /></>),
      slot('issues', <IssueList />),
      ex('approvals') > 0 && line('approvals', 'orders', `${ex('approvals')} 张单等中方审批`),
      ex('cash') > 0 && line('cash', 'cash', `资金账户 ${ex('cash')} 笔要处理（认领到账 / 确认交款 / 批支出）`),
      ex('guest_new') > 0 && line('guest', 'orders', `${ex('guest_new')} 张游客询价还没跟进`),
      ex('pw_changed') > 0 && line('pw', 'customers', `${ex('pw_changed')} 个客户改了下单密码，确认是不是本人`),
      ex('fob_release') > 0 && line('fob_release', 'fob', `${ex('fob_release')} 个 FOB 已到货，等决定放货`),
    ],
    amber: [
      slot('inquiry', <InquiryTodo />),
      slot('addons', <AddonTodo />),
      slot('tasks', <TaskBoard />),
      slot('purchase', <PurchaseTodo />),
      slot('holds', <HoldsCard compact />),
      ex('follow') > 0 && line('follow', 'hotline', `今天要回访 ${ex('follow')} 位客户`),
      ex('notices') > 0 && line('paynotice', 'cash', `${ex('notices')} 笔「客户说付了」还没对上到账`),
      ex('pr_new') > 0 && line('pr', 'purchase', `${ex('pr_new')} 张采购 / 物资申请还没下单`),
      ex('pr_eta') > 0 && line('pr', 'purchase', `${ex('pr_eta')} 张采购 / 物资申请 5 天内到或已过期`),
      ex('fob_price') > 0 && line('fob_price', 'fob', `${ex('fob_price')} 个 FOB 申请等定价`),
      kdTodo > 0 && line('kd', 'kingdee', `还没录金蝶 ${kdTodo} 张`),
      ex('grn_ready') > 0 && line('kd', 'kingdee', `${ex('grn_ready')} 张收货单要录金蝶采购入库`),
    ],
    green: [
      slot('tier', <TierCheck rows={tierRows} />),
      slot('volume', <VolumeShift />),
      ex('kd_audit') > 0 && line('kd_audit', 'kingdee', `${ex('kd_audit')} 张金蝶单已提交，等审核`),
    ],
  };
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Mes tâches</div><h1 tabIndex={0}>我的待办 <Info>当前岗位：{ROLES[role].label}。只有三段：紧急 / 进行中 / 待跟进。下推一步，单子自动出现在下一个人的待办里；做完的自动消失。</Info></h1></div>
        {admin && <div className="row"><button type="button" className="btn sm" onClick={() => setRouteOpen(true)}>⚙ 归谁</button></div>}</div>
      {!data ? <div className="card"><div className="empty">加载中…</div></div> : <div className="stack" style={{ gap: 12 }}>
        {SEC.map(([k, label, tip]) => (
          <div key={k} className={`card todo-sec todo-${k}`}>
            <div className="card-h"><h2><span className={`pill ${k}`}>{label}</span> {groups[k].length} 单 <Info>{tip}</Info></h2></div>
            {items[k].filter(Boolean)}
            {groups[k].map((d) => {
              const n = nextAction(d, role); const o = overdueOf(d);
              return (
                <div key={d.id} className="row between todo-row" onClick={() => go('deal/' + d.id)}>
                  <div className="stack" style={{ gap: 3, minWidth: 0 }}>
                    <div><b style={{ fontSize: 15 }}>{d.customer_name}</b> <span className="muted small">{d.city} · {d.customer_code}</span>{d.urgent && <span className="pill red" style={{ marginLeft: 6 }}>中方标紧急</span>}{d._stale && <span className="pill red" style={{ marginLeft: 6 }}>昨天没做完</span>}{o && <span className={`pill ${o.tier === 'amber' ? 'amber' : 'red'}`} style={{ marginLeft: 6 }}>下单 {o.label} 没发货</span>}{Number(d.busy_n) > 0 && <span className="pill gray" style={{ marginLeft: 6 }}>客户忙 ×{d.busy_n}</span>}</div>
                    <div className="small muted">{d.biz_no} · {dt(d.updated_at)} · {d.line_count} 个型号{d.want_on && !['shipped', 'cancelled'].includes(d.status) && <> · <Pill tone={wantDue(d) ? 'red' : 'blue'}>客户要货 {dDate(d.want_on)}</Pill></>}</div>
                    <div className="small">👉 {Number(d.busy_n) >= 3 && ['quoted', 'hotline_ok'].includes(d.status) ? '联系 3 次客户都忙：可以作废，或改天再联系' : n.what}{role === 'admin' && <span className="muted">（{n.roles.map((r) => ROLES[r].label).join('/')}）</span>}</div>
                  </div>
                  <div className="row" style={{ flexShrink: 0 }}>{role === 'admin' && <button type="button" className="btn sm ghost" onClick={(e) => urgent(e, d)}>{d.urgent ? '取消紧急' : '提成紧急'}</button>}<Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill><span className="muted">›</span></div>
                </div>
              );
            })}
            <div className="empty small sec-none">没有</div>
          </div>
        ))}
        {admin && <DirectiveBoard />}
        {admin && <ChangeNotices />}
      </div>}
      {routeOpen && <RouteModal cur={routeSet || {}} onClose={() => setRouteOpen(false)} />}
    </>
  );
}

// 448: 待办里除了订单以外的每一类事 —— 归哪些岗位 (默认值; 中方在「⚙ 归谁」里改, 存 org_settings todo_route)
const L = ['admin', 'manager', 'sales_manager'];
export const SLOTS = {
  anomaly: { label: '异常的单', roles: ['admin', 'manager', 'sales_manager', 'hotline', 'finance', 'sales', 'picker'] },
  directives: { label: '中方给我的指令 / 定期任务', roles: ['manager', 'sales_manager', 'hotline', 'finance', 'sales', 'picker', 'cn_support'] },
  returns: { label: '退货没走完', roles: ['admin', 'manager', 'sales_manager', 'hotline', 'finance'] },
  money: { label: '钱要跟进的', roles: ['admin', 'finance'] },
  issues: { label: '员工上报的问题', roles: L },
  approvals: { label: '等审批的单', roles: ['admin'] },
  cash: { label: '资金账户要处理的', roles: ['admin'] },
  guest: { label: '游客询价', roles: ['hotline', 'manager', 'admin', 'sales_manager'] },
  pw: { label: '客户改了密码', roles: ['admin'] },
  fob_release: { label: 'FOB 等放货', roles: ['admin'] },
  inquiry: { label: '询单', roles: ['admin', 'hotline', 'sales', 'sales_manager', 'manager'] },
  addons: { label: '追加的货', roles: ['admin', 'manager', 'picker', 'hotline', 'sales_manager'] },
  tasks: { label: '派出去的任务', roles: ['admin', 'manager', 'sales_manager', 'hotline', 'finance', 'sales', 'picker'] },
  purchase: { label: '采购与到货', roles: ['manager', 'cn_support'] },
  holds: { label: '冻结的库存', roles: ['admin', 'manager'] },
  follow: { label: '今天要回访的客户', roles: ['hotline', 'sales', 'manager'] },
  paynotice: { label: '客户说付了、还没对上', roles: ['hotline', 'finance'] },
  pr: { label: '采购 / 物资申请', roles: ['manager', 'finance'] },
  fob_price: { label: 'FOB 等定价', roles: ['admin'] },
  kd: { label: '录金蝶', roles: ['finance'] },
  kd_audit: { label: '金蝶等审核', roles: ['manager', 'finance'] },
  tier: { label: '客户档位要核对', roles: ['admin'] },
  volume: { label: '客户拿货量变化', roles: ['admin'] },
};

// 一类事 = 一行: 有事才出现, 点一下展开看明细 / 处理. 里面没东西时整行不出现.
const ITEM = '.todo-row, .todo-line, tbody tr[data-row]';
const BUSY = ITEM + ', .card-h .pill.red, .card-h .pill.amber, .card-h .pill.blue';   // 常驻的板块 (空着也画一张卡) 靠这个判断「里面有没有事」
function Slot({ title, children, open0 }) {
  const ref = useRef(null); const [n, setN] = useState(0); const [has, setHas] = useState(false); const [open, setOpen] = useState(!!open0);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const chk = () => { setHas(!!el.querySelector(BUSY)); setN(el.querySelectorAll(ITEM).length); };
    chk(); const mo = new MutationObserver(chk); mo.observe(el, { childList: true, subtree: true }); return () => mo.disconnect();
  }, []);
  return (
    <div className="slot" style={has ? null : { display: 'none' }}>
      {has && <div className="row between todo-row slot-h" onClick={() => setOpen(!open)}><span><b>{title}</b>{n > 0 && <span className="pill gray" style={{ marginLeft: 8 }}>{n} 条</span>}</span><span className={`fold-btn ico-only ${open ? 'on' : ''}`} style={{ alignSelf: 'center' }} title={open ? '收起' : '明细'}><i className="fold-ico">☰</i></span></div>}
      <div ref={ref} className="todo-merge slot-b" style={open ? null : { display: 'none' }}>{children}</div>
    </div>);
}

function RouteModal({ cur, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [v, setV] = useState(() => Object.fromEntries(Object.entries(SLOTS).map(([k, x]) => [k, cur[k] || x.roles])));
  const staff = Object.entries(ROLES).filter(([k]) => !['boss', 'clerk'].includes(k)).map(([k, x]) => ({ v: k, l: x.label }));
  const save = async () => { try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, 'todo_route', JSON.stringify(v)]); toast('已保存，所有人的待办马上按这个来'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="待办里每类事归谁" wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={save}>保存</button></>}>
      <div className="hint">订单按流程自动走到下一个人，不用在这里设。这里只管订单以外的事：归哪个岗位，就只出现在哪个岗位的待办里。<Assumed>现在只能按岗位分（例：录金蝶 → 财务）。按具体的人分（例：只给王振宇）要等工号登录做好，一人一个账号以后才分得出来。</Assumed></div>
      <div className="route-grid">{Object.entries(SLOTS).map(([k, x]) => (
        <div key={k} className="field"><label>{x.label}</label><MultiChoice value={v[k]} onChange={(nv) => setV({ ...v, [k]: nv })} options={staff} /></div>))}</div>
    </Modal>);
}

// 11-09 Frank 第 21 条: 退货没走完 (没批 / 没检验 / 没对账) 一直挂待办
function OpenReturns() {
  const { org, role } = useApp();
  const { data } = useData(() => q(Q.openReturns, [org]), [org]);
  if (!data?.length || !['admin', 'manager', 'sales_manager', 'hotline', 'finance'].includes(role)) return null;
  const P = { decide: ['退货等中方审批', 'amber'], inspect: ['退货待检验（好货 / 坏货）', 'amber'], reconcile: ['退货待和客户对账', 'blue'] };
  return data.map((r) => (
    <div key={r.id} className="row between todo-row" style={{ cursor: 'default' }}>
      <div className="stack" style={{ gap: 3, minWidth: 0 }}>
        <div><span className="pill red">↩ 退货没走完</span> <b style={{ fontSize: 15 }}>{r.customer_name}</b></div>
        <div className="small muted"><DealLink id={r.deal_id} no={r.rt_no} /> · 原单 {r.biz_no} · 收货 {r.received_at ? dt(r.received_at) : dt(r.requested_at)}</div>
      </div>
      <Pill tone={P[r.pending]?.[1] || 'gray'}>{P[r.pending]?.[0] || r.pending}</Pill>
    </div>));
}
