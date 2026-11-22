// 11-22 Frank: 审批页面 —— 员工动价格 / 库存 / 钱的事等中方批; 一眼看到「哪里要批（红）、为什么、批了有什么影响」.
// 只读汇总, 点「去批」进原来的审批入口 (订单页审批弹窗 / 改价 / 退货 / 资金账户), 不另做一套批的逻辑.
import { q } from '../db/client.js';
import { useApp, useData } from './ui.jsx';
import { money, qty, dt } from '../lib/format.js';

export const approvalInboxSql = `
select * from (
  select 'deal' as kind, d.id as ref, d.id as deal_id, d.biz_no, c.name as customer_name, d.created_at as at, d.approval_reasons as reasons, d.direct,
    (select coalesce(sum(l.qty_req * coalesce(l.requested_price, l.unit_price, 0)), 0) from app.deal_lines l where l.deal_id = d.id) as amount,
    coalesce((select sum(e.amount) from app.ar_entries e where e.customer_id = c.id and e.currency = 'XOF'), 0) as balance,
    (select count(*) from app.deal_lines l where l.deal_id = d.id and l.requested_price is not null) as hot_lines,
    d.currency, null::numeric as delta
  from app.deals d join app.customers c on c.id = d.customer_id
  where d.org_id = $1 and d.approval = 'pending' and d.status not in ('cancelled','shipped')
  union all
  select 'price', l.id, d.id, d.biz_no, c.name, l.price_req_at, array['员工改价：' || coalesce(l.price_req_note, '')], false,
    l.price_req * coalesce(l.qty_confirmed, l.qty_picked, l.qty_req), null, 1, d.currency,
    (l.price_req - coalesce(l.unit_price, 0)) * coalesce(l.qty_confirmed, l.qty_picked, l.qty_req)
  from app.deal_lines l join app.deals d on d.id = l.deal_id join app.customers c on c.id = d.customer_id
  where d.org_id = $1 and l.price_req is not null
  union all
  select 'return', r.id, r.deal_id, r.biz_no, r.customer_name, r.requested_at, array['退货：' || coalesce(r.reason, '没写原因')], false,
    null, null, 0, 'XOF', null
  from app.v_open_returns r where r.org_id = $1 and r.pending = 'decide'
  union all
  select 'cash', m.id, null, null, null, m.created_at,
    array[case m.kind when 'expense' then '支出：' when 'handover' then '交款：' else '资金：' end || coalesce(m.note, '')], false,
    m.amount, null, 0, 'XOF', null
  from app.cash_moves m where m.org_id = $1 and m.status = 'pending'
) x order by at`;

const KIND = { deal: '订单', price: '改价', return: '退货', cash: '资金' };

export default function ApprovalInbox() {
  const { org, go, tick } = useApp();
  const { data } = useData(() => q(approvalInboxSql, [org]), [org, tick]);
  if (!data?.length) return null;
  const open = (r) => go(r.kind === 'cash' ? 'cash' : 'deal/' + r.deal_id);
  return data.map((r) => {
    const after = r.kind === 'deal' && r.currency === 'XOF' ? Math.max(0, Number(r.balance)) + Number(r.amount || 0) : null;
    return (
      <div key={r.kind + r.ref} className="row between todo-row appr-row" onClick={() => open(r)}>
        <div className="stack" style={{ gap: 4, minWidth: 0 }}>
          <div><span className="pill gray">{KIND[r.kind]}{r.direct ? ' · 直接下单' : ''}</span> <b>{r.customer_name || '—'}</b> <span className="muted small">{r.biz_no || ''} · {dt(r.at)}</span></div>
          <div className="appr-why">{(r.reasons || []).map((x, i) => <span key={i} className="pill red">{x}</span>)}</div>
          <div className="small muted appr-imp">
            {r.amount != null && <span>金额 <b className="ink">{money(r.amount, r.currency)} {r.currency}</b></span>}
            {r.delta != null && <span>比现价 <b style={{ color: Number(r.delta) < 0 ? 'var(--red)' : undefined }}>{Number(r.delta) > 0 ? '+' : ''}{money(r.delta)}</b></span>}
            {after != null && <span>批了以后客户欠 <b style={{ color: after > 0 ? 'var(--red)' : undefined }}>{money(after)} XOF</b></span>}
            {Number(r.hot_lines) > 0 && r.kind === 'deal' && <span>{qty(r.hot_lines)} 行申请特价（订单里标红）</span>}
          </div>
        </div>
        <button type="button" className="btn sm primary" style={{ flexShrink: 0 }}>去批 ›</button>
      </div>);
  });
}

// 0080 每日收款汇总 (只中方): 今天 / 昨天 各收了多少, 按入账币种; 每一笔明细在「变更通知」里 (绿色「收款」)
export function ReceiptDigest() {
  const { org, role, go, tick } = useApp();
  const { data } = useData(() => q(`select received_on::text as d, account_currency as cur, count(*)::int as n, sum(converted) as amt
    from app.receipts where org_id = $1 and received_on >= current_date - 1 group by 1, 2 order by 1 desc, 2`, [org]), [org, tick]);
  if (role !== 'admin') return null;
  const td = new Date(); const ymd = (x) => x.toISOString().slice(0, 10);
  const yd = new Date(td.getTime() - 864e5);
  const day = (d) => (data || []).filter((r) => r.d === ymd(d));
  const show = (rows) => (rows.length ? rows.map((r) => <span key={r.cur}><b>{money(r.amt, r.cur)}</b> {r.cur}<span className="muted small"> · {r.n} 笔</span></span>) : <span className="muted">没有</span>);
  return (
    <div className="card digest" onClick={() => go('cash')}>
      <div className="digest-row"><span className="k">今天收款</span>{show(day(td))}</div>
      <div className="digest-row muted"><span className="k">昨天</span>{show(day(yd))}</div>
    </div>);
}
