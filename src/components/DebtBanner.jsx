// 欠款提醒 (Frank 11-09 15:08 / 15:42): 报价时就亮出客户欠多少, 当场决定做不做; 出库前再硬拦 (有欠款不出货的客户)
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, PhotoInput } from './ui.jsx';
import { CustLink, DealLink } from './Archives.jsx';
import { money, dt, friendlyError } from '../lib/format.js';

export default function DebtBanner({ customerId, deal, compact }) {
  const { org, role, toast, refresh } = useApp();
  const [rel, setRel] = useState(false);
  const { data } = useData(async () => {
    if (!customerId) return null;
    const [[c]] = await Promise.all([q(`select cr.balance, cr.oldest_days, cr.over_limit, cr.over_days, cr.credit_limit, cr.credit_days, cr.has_agreement, cu.block_on_debt, cu.name
      from app.customers cu left join app.v_customer_credit cr on cr.customer_id = cu.id where cu.id = $1`, [customerId])]);
    const own = deal ? (await q(`select coalesce(sum(due),0) as due from app.v_deal_due where deal_id = $1 and currency = 'XOF'`, [deal.id]))[0]?.due : 0;
    return { ...c, other: Number(c?.balance || 0) - Number(own || 0) };
  }, [customerId, deal?.id, deal?.status, org]);
  if (!data) return null;
  const debt = data.other;
  if (!(debt > 0) && !data.block_on_debt) return <RepBanner customerId={customerId} deal={deal} />;
  const blocked = data.block_on_debt && debt > 0;
  const released = deal?.debt_released_at;
  const parts = [debt > 0 ? `${deal ? '除这张单外' : '现在'}还欠 ${money(debt)} XOF` : '目前没有欠款',
    data.oldest_days > 0 && debt > 0 ? `最老一笔 ${data.oldest_days} 天没付` : null,
    data.over_limit ? `超上限（${money(data.credit_limit)}）` : null, data.over_days ? `超账期（${data.credit_days} 天）` : null].filter(Boolean);
  return (<>
    <RepBanner customerId={customerId} deal={deal} />
    <div className={`banner ${blocked && !released ? 'warn' : 'info'} row`} style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
      <span>💰 <b>{data.name}</b>：{parts.join('，')}。
        {blocked ? (released ? ` 中方已放行（${dt(released)}：${deal.debt_release_note}）。` : deal ? ' 「有欠款不出货」客户：先收款，或中方放行，才能出库。' : ' 「有欠款不出货」客户：这张报价会进中方审批；出库前还要先收款或中方放行。先跟客户谈好欠款再报价。')
          : data.block_on_debt ? ' （有欠款不出货客户，目前没欠款）' : data.has_agreement ? ' 有协议客户，只提醒。' : ' 只提醒，要不要做由你定。'}</span>
      <span className="grow" />
      {blocked && !released && deal && role === 'admin' && <button type="button" className="btn sm primary" onClick={() => setRel(true)}>放行这张单</button>}
      {rel && <ReleaseModal deal={deal} debt={debt} onClose={() => setRel(false)} onDone={() => { setRel(false); refresh(); }} role={role} toast={toast} />}
    </div>
  </>);
}

// 销售员名下有隔天没收回的欠款 → 他名下所有客户暂不出货 (Frank 11-13, 按销售员名义; 吃过放账烂账的亏).
// 建报价 / 看订单时就亮出来; 出库时硬拦. 客户说已付还没核对 → 员工「申诉」(中方最优先处理); 中方可对这张单放行.
export function RepBanner({ customerId, deal }) {
  const { org, role, toast, refresh } = useApp();
  const [rel, setRel] = useState(false); const [appeal, setAppeal] = useState(false); const [note, setNote] = useState(''); const [proof, setProof] = useState('');
  const { data } = useData(async () => {
    if (!customerId) return null;
    const [[c], [rule]] = await Promise.all([q(`select cu.owner_employee_id, coalesce(e.short_name, e.full_name) as rep from app.customers cu left join app.employees e on e.id = cu.owner_employee_id where cu.id = $1`, [customerId]),
      q(`select value from app.org_settings where org_id = $1 and key = 'rep_debt_rules'`, [org])]);
    if (!c?.owner_employee_id || rule?.value?.on === false) return null;
    const rows = await call(role, `select * from app.rep_debt($1)`, [c.owner_employee_id]);
    const ap = deal ? await q(`select id, note, status, decision_note from app.payment_appeals where deal_id = $1 order by created_at desc limit 1`, [deal.id]) : [];
    return { rep: c.rep, rows, appeal: ap[0] || null };
  }, [customerId, deal?.id, deal?.status, deal?.debt_released_at, org]);
  if (!data || !data.rows.length) return null;
  const released = deal?.debt_released_at;
  const custs = [...new Map(data.rows.map((r) => [r.customer_id, r])).values()];
  const send = async () => { try { await call(role, `select app.appeal_payment($1,$2,$3)`, [deal.id, note.trim(), proof]); toast('申诉已提交，中方会优先核对'); setAppeal(false); setNote(''); setProof(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className={`banner ${released ? 'info' : 'warn'} row`} style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
      <span>⛔ 销售员 <b>{data.rep}</b> 名下还有 <b>{custs.length}</b> 个客户的货款没收回：
        {data.rows.slice(0, 4).map((r, i) => <span key={r.deal_id}>{i > 0 && '；'}<CustLink id={r.customer_id} name={r.customer_name} /> <DealLink id={r.deal_id} no={r.biz_no} peek={false} /> 欠 {money(r.due)} {r.currency}</span>)}{data.rows.length > 4 && ` …共 ${data.rows.length} 张单`}。
        {released ? ` 中方已放行这张单（${dt(released)}：${deal.debt_release_note}）。` : <b> 他名下的客户暂不出货：先把欠款收回并登记。</b>}
        {!released && data.appeal?.status === 'open' && <span className="pill amber" style={{ marginLeft: 6 }}>已申诉，等中方核对</span>}
        {!released && data.appeal?.status === 'rejected' && <span className="pill red" style={{ marginLeft: 6 }} title={data.appeal.decision_note}>申诉没通过：{data.appeal.decision_note}</span>}</span>
      <span className="grow" />
      {!released && deal && data.appeal?.status !== 'open' && role !== 'admin' && <button type="button" className="btn sm" onClick={() => setAppeal(true)}>客户说已经付了 → 申诉</button>}
      {!released && deal && role === 'admin' && <button type="button" className="btn sm primary" onClick={() => setRel(true)}>放行这张单</button>}
      {rel && <ReleaseModal deal={deal} debt={data.rows.reduce((a, r) => a + Number(r.due), 0)} onClose={() => setRel(false)} onDone={() => { setRel(false); refresh(); }} role={role} toast={toast} />}
      {appeal && (
        <Modal title={`申诉：${deal.biz_no} 客户说已经付了`} onClose={() => setAppeal(false)}
          footer={<><button type="button" className="btn" onClick={() => setAppeal(false)}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={!note.trim() || !proof} onClick={send}>提交申诉</button></>}>
          <div className="stack">
            <div className="hint">钱已经付了、只是我们还没核对登记时用。写清楚谁付的、付了多少、怎么付的，传付款截图。中方会优先处理，核对到了就放行这张单。</div>
            <div className="field req"><label>情况（必填）</label><textarea className="in" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：CAMARA 昨晚 Wave 付了 55,000，截图发在客户群" /></div>
            <div className="field req"><label>付款截图（必传）</label><PhotoInput value={proof} onChange={setProof} label="付款截图" /></div>
          </div>
        </Modal>)}
    </div>
  );
}

function ReleaseModal({ deal, debt, onClose, onDone, role, toast }) {
  const [note, setNote] = useState('答应这次付清');
  const go = async () => { try { await call(role, `select app.release_debt_block($1,$2)`, [deal.id, note.trim()]); toast('已放行，这张单可以出库'); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`放行 ${deal.biz_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>不放行</button><span className="grow" /><button type="button" className="btn primary" disabled={!note.trim()} onClick={go}>确认放行</button></>}>
      <div className="stack">
        <div className="hint">客户还欠 {money(debt)} XOF。放行后这张单可以出库，原因记进操作记录。</div>
        <div className="chips">{['答应这次付清', '已付款待到账', '老客户信得过', '先发一部分'].map((x) => <button type="button" key={x} className={`chip ${note === x ? 'on' : ''}`} onClick={() => setNote(x)}>{x}</button>)}</div>
        <input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="放行原因（必填）" />
      </div>
    </Modal>
  );
}
