import React from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill } from '../components/ui.jsx';
import { IssueList } from '../components/IssueReport.jsx';
import { STATUS, ROLES } from '../lib/domain.js';
import { money, dt, dDate, today } from '../lib/format.js';

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
export function nextAction(d) {
  if (d.status === 'shipped' && Number(d.due) > 0) return { roles: ['finance'], what: `催收 / 登记收款，未付 ${money(d.due)}` };
  const a = shipAlert(d);
  if (a && a.tone !== 'gray') return { roles: ['manager'], what: `${a.text}：安排发货，填出库信息和凭证`, alert: a };
  if (d.status === 'quoted' && d.hotline_busy_at) return { ...NEXT.quoted, what: `客户之前说忙（${dt(d.hotline_busy_at)}），再联系一次确认`, alert: { tone: 'amber', text: '客户忙，稍后联系' } };
  return NEXT[d.status] || null;
}
export function todoFor(role, d) {
  const n = nextAction(d);
  if (!n) return false;
  return role === 'admin' ? !['shipped', 'cancelled'].includes(d.status) || Number(d.due) > 0 : n.roles.includes(role);
}

// 超期未发货 (Frank 11-01: 没人跟进, 十几天后才发现没发货, 客户就不理我们了):
// 下单 (建报价) 以后还没出库完的单, 按时长分级: 超过 24 小时黄、48 小时红、72 小时深红置顶闪.
// 规则先这样定, 阈值以后可以调. 报价没成交的单也算 —— 要么推进, 要么作废, 不能放着.
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
            <span><b>{d.customer_name}</b> <span className="muted small">{d.biz_no}</span></span>
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
  const { org, role, go } = useApp();
  const { data } = useData(() => q(Q.orders, [org, '2000-01-01', '2999-12-31']), [org]);
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
  const rank = (d) => (wantDue(d) ? -1 : nextAction(d)?.alert?.tone === 'red' ? 0 : nextAction(d)?.alert ? 1 : 2);
  const list = (data || []).filter((d) => todoFor(role, d)).sort((a, b) => rank(a) - rank(b));
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Mes tâches</div><h1>我的待办</h1>
        <div className="sub">当前岗位：<b>{ROLES[role].label}</b>。下推一步，单子就自动出现在下一个人的待办里。</div></div></div>
      {data && ['admin', 'manager', 'hotline', 'sales_manager'].includes(role) && <div style={{ marginBottom: 12 }}><OverdueBar orders={data} go={go} /></div>}
      {['admin', 'manager', 'sales_manager'].includes(role) && <IssueList />}
      {['admin', 'manager', 'sales_manager', 'hotline', 'finance'].includes(role) && <OpenReturns />}
      {extras.length > 0 && <div className="card" style={{ marginBottom: 12 }}>{extras.map(([to, text]) => (
        <div key={text} className="row between" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-2)', cursor: 'pointer' }} onClick={() => go(to)}><b>{text}</b><span className="muted">›</span></div>))}</div>}
      <div className="card">
        {!data ? <div className="empty">加载中…</div> : list.length === 0 ? <div className="empty">没有待办 ✓<br /><span className="small">右上角可以切换岗位，看其他人的待办</span></div> :
          list.map((d) => {
            const n = nextAction(d);
            return (
              <div key={d.id} className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line-2)', cursor: 'pointer' }} onClick={() => go('deal/' + d.id)}>
                <div className="stack" style={{ gap: 3 }}>
                  <div><b style={{ fontSize: 15 }}>{d.customer_name}</b> <span className="muted small">{d.city} · {d.customer_code}</span></div>
                  <div className="small muted">{d.biz_no} · {dt(d.updated_at)} · {d.line_count} 个型号{d.want_on && !['shipped', 'cancelled'].includes(d.status) && <> · <Pill tone={wantDue(d) ? 'red' : 'blue'}>客户要货 {dDate(d.want_on)}{dDate(d.want_on) === td ? '（今天）' : ''}</Pill></>}</div>
                  <div className={`small ${n.alert?.tone === 'red' ? 'red-t' : ''}`}>{n.alert ? (n.alert.tone === 'red' ? '⏰ ' : '🔔 ') : '👉 '}{n.what}{role === 'admin' && <span className="muted">（{n.roles.map((r) => ROLES[r].label).join('/')}）</span>}</div>
                </div>
                <div className="row"><Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill><span className="muted">›</span></div>
              </div>
            );
          })}
      </div>
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
          <span><a style={{ cursor: 'pointer' }} onClick={() => go('deal/' + r.deal_id)}><b className="mono">{r.rt_no}</b> · {r.customer_name}</a> <span className="muted small">原单 {r.biz_no} · 收货 {r.received_at ? dt(r.received_at) : dt(r.requested_at)}</span></span>
          <Pill tone={P[r.pending]?.[1] || 'gray'}>{P[r.pending]?.[0] || r.pending}</Pill>
        </div>))}
    </div>
  );
}
