import { DealLink, CustLink } from '../components/Archives.jsx';
import React from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Info } from '../components/ui.jsx';
import { IssueList } from '../components/IssueReport.jsx';
import TierCheck, { useTierCheck } from '../components/TierCheck.jsx';
import DirectiveBoard from '../components/Directives.jsx';
import { STATUS, ROLES } from '../lib/domain.js';
import { money, dt, dDate, today, friendlyError } from '../lib/format.js';

// who acts next on a deal in this status
const NEXT = {
  quoted: { roles: ['hotline', 'manager'], what: '联系客户确认，确认后下推找货' },
  hotline_ok: { roles: ['manager', 'hotline'], what: '客户已确认，下推找货（预占库存）' },
  picking: { roles: ['picker'], what: '按找货单找货（只集中放一堆，不打包），拍照，填实际供货，提交初检' },
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
export function nextAction(d, role) {
  // 251: 新客户档位没定 → 这张报价是草稿; 申请了就卡在中方
  if (d.status === 'quoted' && d.tier_pending) return d.tier_requested_at ? { roles: ['admin'], what: '给这个新客户定档位（员工已申请，报价等着发给客户）' } : { roles: ['hotline', 'manager', 'sales', 'sales_manager'], what: '草稿：客户档位没定，点进去「申请定级」，中方定了再发给客户' };
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
  if (quoteLate(d)) return 'red';   // 报价建好超过 5 分钟热线还没点开
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
  const extras = [
    ['hotline', 'sales', 'manager', 'admin'].includes(role) && Number(extra?.follow) > 0 && ['hotline', `☎ 今天要回访 ${extra.follow} 位客户（约好今天或已过期的）`],
    role === 'admin' && Number(extra?.cash) > 0 && ['cash', `₣ 资金账户有 ${extra.cash} 笔要中方处理（认领到账 / 确认交款 / 批支出）`],
    ['hotline', 'finance'].includes(role) && Number(extra?.notices) > 0 && ['cash', `🔔 ${extra.notices} 笔「客户说付了」还没对上到账`],
    role === 'admin' && Number(extra?.pw_changed) > 0 && ['customers', `🔑 ${extra.pw_changed} 个客户自己改了下单密码，确认是不是本人（不是就冻结）`],
    ['hotline', 'manager', 'admin', 'sales_manager'].includes(role) && Number(extra?.guest_new) > 0 && ['orders', `🌐 ${extra.guest_new} 张游客询价还没跟进，马上联系报价`],
    role === 'admin' && Number(extra?.approvals) > 0 && ['orders', `✓ ${extra.approvals} 张询单等中方审批（新客户 / 特价 / 超欠款 / 没编码）`],
    ['admin', 'manager', 'finance'].includes(role) && Number(extra?.pr_eta) > 0 && ['purchase', `⇣ ${extra.pr_eta} 张采购 / 物资申请 5 天内到或已过期没到`],
    ['admin', 'manager', 'finance'].includes(role) && Number(extra?.pr_new) > 0 && ['purchase', `⇣ ${extra.pr_new} 张新的采购 / 物资申请还没下单`],
    ['finance', 'manager'].includes(role) && Number(extra?.grn_ready) > 0 && ['kingdee', `⇆ ${extra.grn_ready} 张收货单要录金蝶采购入库`],
    role === 'admin' && Number(extra?.fob_price) > 0 && ['fob', `◷ ${extra.fob_price} 个 FOB 申请等中方定价`],
    role === 'admin' && Number(extra?.fob_release) > 0 && ['fob', `◷ ${extra.fob_release} 个 FOB 已到货，等中方决定放货`],
    ['finance', 'manager'].includes(role) && Number(extra?.kd_ready) > 0 && ['kingdee', `⇆ ${extra.kd_ready} 张出库单客户已签收，要录金蝶`],
    ['manager', 'admin'].includes(role) && Number(extra?.kd_audit) > 0 && ['kingdee', `⇆ ${extra.kd_audit} 张金蝶单已提交，等审核`],
  ].filter(Boolean);
  // 客户要货日期到了 (今天或已过) 的排最前 (Frank 11-07: 明天要的到明天自动前移)
  const td = today();
  const wantDue = (d) => d.want_on && dDate(d.want_on) <= td && !['shipped', 'cancelled'].includes(d.status);
  const rank = (d) => (wantDue(d) ? -1 : nextAction(d, role)?.alert?.tone === 'red' ? 0 : nextAction(d, role)?.alert ? 1 : 2);
  const tierRows = useTierCheck();
  const list = (data || []).filter((d) => todoFor(role, d)).sort((a, b) => rank(a) - rank(b));
  // 227 (Frank 11-11): 待办分三个板块, 系统自动分 —— 红 紧急 / 黄 进行中 / 绿 不急; 中方可以手动把某张单提成紧急
  const groups = { red: [], amber: [], green: [] };
  for (const d of list) groups[todoLevel(d)].push(d);
  const urgent = async (e, d) => { e.stopPropagation(); try { await call(role, `select app.set_deal_urgent($1,$2)`, [d.id, !d.urgent]); toast(d.urgent ? '已取消紧急' : '已提成紧急'); refresh(); } catch (er) { toast(friendlyError(er), 'err'); } };
  const SEC = [['red', '紧急', '超过 24 小时没发货、客户今天要货、中方标了紧急的'], ['amber', '进行中', '正常在走、今天该推进的'], ['green', '不急', '还没到日子的、等客户付款的、联系 3 次客户都忙的']];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Mes tâches</div><h1 tabIndex={0}>我的待办</h1>
        <div className="sub">当前岗位：<b>{ROLES[role].label}</b>。下推一步，单子就自动出现在下一个人的待办里。</div></div></div>
      <DirectiveBoard />
      {['admin', 'manager', 'sales_manager'].includes(role) && <IssueList />}
      {['admin', 'manager'].includes(role) && <HoldsCard compact />}
      {role === 'admin' && <TierCheck rows={tierRows} />}
      {role === 'admin' && <VolumeShift />}
      {['admin', 'manager', 'sales_manager', 'hotline', 'finance'].includes(role) && <OpenReturns />}
      {extras.length > 0 && <div className="card" style={{ marginBottom: 12 }}>{extras.map(([to, text]) => (
        <div key={text} className="row between" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-2)', cursor: 'pointer' }} onClick={() => go(to)}><b>{text}</b><span className="muted">›</span></div>))}</div>}
      {!data ? <div className="card"><div className="empty">加载中…</div></div> : list.length === 0 ? <div className="card"><div className="empty">没有待办 ✓<br /><span className="small">右上角可以切换岗位，看其他人的待办</span></div></div> :
        SEC.map(([k, label, tip]) => (
          <div key={k} className={`card todo-sec todo-${k}`} style={{ marginBottom: 12 }}>
            <div className="card-h"><h2><span className={`pill ${k}`}>{label}</span> {groups[k].length} 单 <Info>{tip}</Info></h2></div>
            {groups[k].length === 0 ? <div className="empty small" style={{ padding: 14 }}>没有</div> : groups[k].map((d) => {
              const n = nextAction(d, role); const o = overdueOf(d);
              return (
                <div key={d.id} className="row between todo-row" onClick={() => go('deal/' + d.id)}>
                  <div className="stack" style={{ gap: 3, minWidth: 0 }}>
                    <div><b style={{ fontSize: 15 }}>{d.customer_name}</b> <span className="muted small">{d.city} · {d.customer_code}</span>{d.urgent && <span className="pill red" style={{ marginLeft: 6 }}>中方标紧急</span>}{o && <span className={`pill ${o.tier === 'amber' ? 'amber' : 'red'}`} style={{ marginLeft: 6 }}>下单 {o.label} 没发货</span>}{Number(d.busy_n) > 0 && <span className="pill gray" style={{ marginLeft: 6 }}>客户忙 ×{d.busy_n}</span>}</div>
                    <div className="small muted">{d.biz_no} · {dt(d.updated_at)} · {d.line_count} 个型号{d.want_on && !['shipped', 'cancelled'].includes(d.status) && <> · <Pill tone={wantDue(d) ? 'red' : 'blue'}>客户要货 {dDate(d.want_on)}</Pill></>}</div>
                    <div className="small">👉 {Number(d.busy_n) >= 3 && ['quoted', 'hotline_ok'].includes(d.status) ? '联系 3 次客户都忙：可以作废，或改天再联系' : n.what}{role === 'admin' && <span className="muted">（{n.roles.map((r) => ROLES[r].label).join('/')}）</span>}</div>
                  </div>
                  <div className="row" style={{ flexShrink: 0 }}>{role === 'admin' && <button type="button" className="btn sm ghost" onClick={(e) => urgent(e, d)}>{d.urgent ? '取消紧急' : '提成紧急'}</button>}<Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill><span className="muted">›</span></div>
                </div>
              );
            })}
          </div>
        ))}
    </>
  );
}

// 11-09 Frank 第 21 条: 退货没走完 (没批 / 没检验 / 没对账) 一直挂待办
function OpenReturns() {
  const { org, go } = useApp();
  const { data } = useData(() => q(Q.openReturns, [org]), [org]);
  if (!data?.length) return null;
  const P = { decide: ['等中方审批', 'amber'], inspect: ['待检验（好货 / 坏货）', 'amber'], reconcile: ['待和客户对账', 'blue'] };
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row between" style={{ padding: '10px 18px', borderBottom: '1px solid var(--line-2)' }}><b>↩ 没走完的退货 {data.length} 张</b></div>
      {data.map((r) => (
        <div key={r.id} className="row between" style={{ padding: '8px 18px', borderBottom: '1px solid var(--line-2)', gap: 10 }}>
          <span><b><DealLink id={r.deal_id} no={r.rt_no} /></b> · {r.customer_name} <span className="muted small">原单 {r.biz_no} · 收货 {r.received_at ? dt(r.received_at) : dt(r.requested_at)}</span></span>
          <Pill tone={P[r.pending]?.[1] || 'gray'}>{P[r.pending]?.[0] || r.pending}</Pill>
        </div>))}
    </div>
  );
}
