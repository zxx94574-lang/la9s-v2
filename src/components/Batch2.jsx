// 11-12 第 2 批: 问题库存冻结 (266) · 打电话名单 (250) · 价格调整单 (262) · 销量月对比 (252)
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, PhotoInput, Thumb, Info, FileDrop } from './ui.jsx';
import Grid from './Grid.jsx';
import { ModelLink, CustLink, DealLink } from './Archives.jsx';
import { money, qty, dt, dDate, friendlyError } from '../lib/format.js';
const N = (v) => Number(v) || 0;

// ───────── 266: 暂停出库 (冻结) ─────────
export function useHolds() {
  const { org } = useApp();
  return useData(() => q(`select h.*, s.qty_on_hand, s.bin, w.code as wh, p.id as product_id, p.code, p.model, c.name as category,
      (select count(distinct dl.deal_id) from app.deal_lines dl join app.deals d on d.id = dl.deal_id where dl.stock_item_id = h.stock_item_id and d.status not in ('shipped','cancelled') and dl.qty_supply > 0)::int as deals_n
    from app.stock_holds h join app.stock_items s on s.id = h.stock_item_id join app.warehouses w on w.id = s.warehouse_id join app.products p on p.id = s.product_id left join app.categories c on c.id = p.category_id
    where h.org_id = $1 order by (h.status = 'active') desc, h.created_at desc limit 200`, [org]), [org]).data;
}
export function FreezeModal({ row, onClose }) {
  const { role, toast, refresh } = useApp();
  const [whole, setWhole] = useState(true); const [n, setN] = useState(''); const [reason, setReason] = useState(''); const [proof, setProof] = useState('');
  const why = !reason.trim() ? '写原因' : !proof ? '传凭证' : !whole && !(N(n) > 0) ? '填冻结多少片' : '';
  const go = async () => { try { await call(role, `select app.freeze_stock($1,$2,$3,$4)`, [row.stock_item_id, whole ? null : N(n), reason, proof]); toast('已暂停出库，可售已扣掉'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`暂停出库 · ${row.model}（${row.warehouse_name || row.warehouse} · 可售 ${qty(row.qty_available)}）`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{why && <span className="why">{why}</span>}<button type="button" className="btn primary" disabled={!!why} onClick={go}>暂停出库</button></>}>
      <div className="stack">
        <div className="hint">货还在原仓，实存不变、金蝶不用动；<b>可售立刻扣掉</b>，报价和找货都选不到。评估完再决定：没问题 → 解冻；有问题 → 转待检仓。</div>
        <FRow label="冻结多少" req><div className="chips"><button type="button" className={`chip ${whole ? 'on' : ''}`} onClick={() => setWhole(true)}>整个编码（已经给订单留的也不许发）</button><button type="button" className={`chip ${!whole ? 'on' : ''}`} onClick={() => setWhole(false)}>只冻一部分</button></div></FRow>
        {!whole && <FRow label="片数" req><input className="in" style={{ width: 120 }} inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} /></FRow>}
        <FRow label="原因" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 老库存软件没升级 / 客户反馈这批有亮点" /></FRow>
        <FRow label="凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="问题照片 / 客户反馈截图" /></div></FRow>
      </div>
    </Modal>
  );
}
function CloseHoldModal({ h, onClose }) {
  const { role, toast, refresh } = useApp();
  const [action, setAction] = useState(''); const [note, setNote] = useState(''); const [proof, setProof] = useState('');
  const why = !action ? '选怎么处理' : !note.trim() ? '写评估结论' : !proof ? '传凭证' : '';
  const go = async () => { try { await call(role, `select app.close_stock_hold($1,$2,$3,$4)`, [h.id, action, note, proof]); toast(action === 'release' ? '已解冻，恢复可售' : '已转入待检仓'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`处理冻结 · ${h.model} · ${qty(h.qty)} 片`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{why && <span className="why">{why}</span>}<button type="button" className="btn primary" disabled={!!why} onClick={go}>确定</button></>}>
      <div className="stack">
        <FRow label="评估结果" req><div className="chips"><button type="button" className={`chip ${action === 'release' ? 'on' : ''}`} onClick={() => setAction('release')}>没问题 → 解冻</button><button type="button" className={`chip ${action === 'to_pending' ? 'on' : ''}`} onClick={() => setAction('to_pending')}>有问题 → 转待检仓</button></div></FRow>
        <FRow label="评估结论" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 升级完成，抽检 10 片正常" /></FRow>
        <FRow label="凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label={action === 'to_pending' ? '货已搬到待检仓的照片' : '检测 / 升级完成的照片'} /></div></FRow>
        {action === 'to_pending' && <div className="hint">转待检仓是实物移动：货要真的搬过去，金蝶同步做一张调拨。之后在待检仓检验，好货回原仓、坏货进报废仓。</div>}
      </div>
    </Modal>
  );
}
export function HoldsCard({ compact }) {
  const { role } = useApp();
  const holds = useHolds(); const [open, setOpen] = useState(null);
  const active = (holds || []).filter((h) => h.status === 'active');
  if (!holds || (compact && !active.length)) return null;
  const canDo = ['admin', 'manager'].includes(role);
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: active.length ? '#f3c6c6' : undefined }}>
      <div className="card-h"><h2>暂停出库的货</h2>{active.length > 0 ? <span className="pill red">{active.length} 条冻结中</span> : <span className="pill green">没有</span>}
        <Info>发现问题先冻结：可售立刻扣掉，订单里有这个货的不能出库。评估完解冻或转待检仓，每一步都要凭证。</Info></div>
      <Grid id={compact ? 'holds-todo' : 'holds'} noTools={compact} rows={compact ? active : holds} rowActions={canDo ? [{ label: '解冻 / 转待检仓', when: (h) => h.status === 'active', run: (h) => setOpen(h) }] : undefined} empty="没有冻结记录" columns={[
        { key: 'status', label: '状态', w: 100, value: (h) => h.status, render: (h) => <span className={`pill ${h.status === 'active' ? 'red' : 'gray'}`}>{h.status === 'active' ? '冻结中' : h.status === 'released' ? '已解冻' : '已转待检仓'}</span> },
        { key: 'model', label: '型号', w: 120, render: (h) => <ModelLink id={h.product_id} model={h.model} /> },
        { key: 'category', label: '种类', w: 90 }, { key: 'wh', label: '仓', w: 60 },
        { key: 'qty', label: '冻结', w: 130, value: (h) => N(h.qty), render: (h) => <b>{qty(h.qty)} 片{h.whole ? ' · 整个编码' : ''}</b> },
        { key: 'deals_n', label: '卡住的单', w: 90, value: (h) => N(h.deals_n), render: (h) => (h.status === 'active' && h.whole && N(h.deals_n) > 0 ? <span className="pill red">{h.deals_n} 张</span> : '') },
        { key: 'reason', label: '原因', w: 220 },
        { key: 'proof', label: '凭证', w: 60, sortable: false, render: (h) => <Thumb src={h.proof} size={30} label="冻结凭证" /> },
        { key: 'created_at', label: '什么时候', w: 140, value: (h) => h.created_at, render: (h) => dt(h.created_at) },
        { key: 'close', label: '处理结果', w: 240, sortable: false, render: (h) => (h.status === 'active' ? <span className="muted small">{canDo ? '还冻着（点这行 → 上方处理）' : '等中方 / 主管评估'}</span> : <span className="small">{h.close_note} <Thumb src={h.close_proof} size={26} label="处理凭证" /></span>) },
      ]} />
      {open && <CloseHoldModal h={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ───────── 262: 价格调整单 ─────────
export function PriceAdjust({ deal }) {
  const { role, toast, refresh } = useApp();
  const list = useData(() => q(`select * from app.price_adjustments where deal_id = $1 order by created_at`, [deal.id]), [deal.id, deal.version]).data || [];
  const [open, setOpen] = useState(false); const [dir, setDir] = useState('less'); const [amt, setAmt] = useState(''); const [reason, setReason] = useState(''); const [proof, setProof] = useState('');
  if (!['partial', 'shipped'].includes(deal.status) || (role !== 'admin' && !list.length)) return null;
  const why = !(N(amt) > 0) ? '填金额' : !reason.trim() ? '写原因' : !proof ? '传凭证' : '';
  const go = async () => { try { await call(role, `select app.adjust_price($1,$2,$3,$4)`, [deal.id, dir === 'less' ? -N(amt) : N(amt), reason, proof]); toast('价格调整已记进客户总账'); setOpen(false); setAmt(''); setReason(''); setProof(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-h"><h2>价格调整 <Info>出库以后原单不直接改（钱和货都动过了）。价格 / 金额要改，开一张调整单：差额进客户总账，原单留着。数量不对走「收货差异」或「退货」。</Info></h2>
        {role === 'admin' && <button type="button" className="btn sm" onClick={() => setOpen(true)}>＋ 开价格调整单</button>}</div>
      {list.length > 0 && <div className="card-b stack" style={{ gap: 6 }}>{list.map((a) => <div key={a.id} className="row" style={{ gap: 10, flexWrap: 'wrap' }}><span className={`pill ${N(a.amount) < 0 ? 'amber' : 'red'}`}>{N(a.amount) < 0 ? '给客户减' : '客户要补'} {money(Math.abs(N(a.amount)), deal.currency)} {deal.currency}</span><span>{a.reason}</span><span className="small muted">{dt(a.created_at)}</span><Thumb src={a.proof} size={28} label="调整凭证" /></div>)}
        <div className="small muted">这些调整已经进了客户总账，Balance 里的欠款 / 预付是调整后的数。</div></div>}
      {open && <Modal title={`价格调整单 · ${deal.biz_no}`} onClose={() => setOpen(false)} footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>取消</button><span className="grow" />{why && <span className="why">{why}</span>}<button type="button" className="btn primary" disabled={!!why} onClick={go}>确定调整</button></>}>
        <div className="stack">
          <FRow label="方向" req><div className="chips"><button type="button" className={`chip ${dir === 'less' ? 'on' : ''}`} onClick={() => setDir('less')}>多算了 → 给客户减</button><button type="button" className={`chip ${dir === 'more' ? 'on' : ''}`} onClick={() => setDir('more')}>少算了 → 客户要补</button></div></FRow>
          <FRow label="金额" req><input className="in" style={{ width: 160 }} inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">{deal.currency}</span></FRow>
          <FRow label="原因" req><input className="in" style={{ width: '100%', maxWidth: 420 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 BG6M 单价按 3,300 算成了 3,600" /></FRow>
          <FRow label="凭证" req><div className="proofbox-wrap" style={{ flex: 1 }}><PhotoInput value={proof} onChange={setProof} label="客户同意的截图" /></div></FRow>
          <div className="hint">金蝶那边也要补录一张对应的调整。</div>
        </div>
      </Modal>}
    </div>
  );
}

// ───────── 250: 打电话名单 (热线回访页) ─────────
const CALL_RESULT = { yes: ['接通 · 愿意', 'green'], later: ['接通 · 以后再说', 'amber'], no: ['接通 · 不要', 'gray'], no_answer: ['没接', 'amber'], wrong_number: ['号码错', 'red'] };
export function CallLists() {
  const { org, role, toast, refresh } = useApp();
  const [sel, setSel] = useState(null); const [add, setAdd] = useState(false);
  const lists = useData(() => q(`select l.*, (select short_name from app.employees e where e.id = l.assignee_employee_id) as assignee,
      (select count(*) from app.call_list_rows r where r.list_id = l.id)::int as n, (select count(*) from app.call_list_rows r where r.list_id = l.id and r.result is not null)::int as done_n,
      (select count(*) from app.call_list_rows r where r.list_id = l.id and r.result = 'yes')::int as yes_n
    from app.call_lists l where l.org_id = $1 order by l.closed_at nulls first, l.created_at desc`, [org]), [org]).data;
  const cur = (lists || []).find((l) => l.id === sel) || (lists || [])[0];
  const rows = useData(() => (cur ? q(`select r.*, c.name as customer_name from app.call_list_rows r left join app.customers c on c.id = r.customer_id where r.list_id = $1 order by r.seq`, [cur.id]) : Promise.resolve([])), [cur?.id, lists]).data || [];
  const setRes = async (r, result, note) => { try { await call(role, `select app.set_call_result($1,$2,$3)`, [r.id, result, note ?? r.result_note ?? null]); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const toProspect = async (r) => { try { await call(role, `select app.call_row_to_prospect($1)`, [r.id]); toast(`${r.name} 已设为潜客，在客户档案里`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  if (!lists) return <div className="empty">加载中…</div>;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {role === 'admin' && <button type="button" className="btn primary" onClick={() => setAdd(true)}>＋ 加一张打电话名单</button>}
        {lists.map((l) => <button type="button" key={l.id} className={`chip ${cur?.id === l.id ? 'on' : ''}`} onClick={() => setSel(l.id)}>{l.title} <b>{l.done_n}/{l.n}</b>{l.closed_at ? ' · 已结束' : ''}</button>)}
      </div>
      {!cur ? <div className="card"><div className="empty">还没有名单。中方点「＋ 加一张打电话名单」，把 Excel 拖进来或粘贴进来，热线照着一个个打、一行行填结果。</div></div> : (
        <div className="card">
          <div className="card-h"><h2>{cur.title}</h2><span className={`pill ${cur.done_n >= cur.n ? 'green' : 'amber'}`}>打了 {cur.done_n} / {cur.n} · 愿意 {cur.yes_n}</span>
            {cur.assignee && <span className="small muted">给 {cur.assignee}</span>}{cur.note && <span className="small muted">{cur.note}</span>}</div>
          <Grid id="call-rows" rows={rows} rowActions={role === 'admin' ? [{ label: '设为潜客', when: (r) => !r.customer_id && r.result === 'yes', run: (r) => toProspect(r) }] : undefined} empty="名单是空的" columns={[
            { key: 'name', label: '名字', w: 160, render: (r) => <b>{r.name || '—'}</b> },
            { key: 'phone', label: '电话', w: 150, render: (r) => (r.phone ? <a className="linkbtn" href={`tel:${r.phone}`}>{r.phone}</a> : '') },
            { key: 'city', label: '城市', w: 100 }, { key: 'note', label: '备注', w: 160 },
            { key: 'result', label: '打电话的结果', w: 170, value: (r) => (r.result ? CALL_RESULT[r.result][0] : ''), render: (r) => (r.result ? <span className={`pill ${CALL_RESULT[r.result][1]}`}>{CALL_RESULT[r.result][0]}</span> : <span className="pill red">还没打</span>),
              edit: (r) => ({ type: 'select', value: r.result || '', options: [['', '—'], ...Object.entries(CALL_RESULT).map(([k, v]) => [k, v[0]])], onChange: (v) => v && setRes(r, v) }) },
            { key: 'result_note', label: '客户怎么说', w: 240, edit: (r) => ({ type: 'text', value: r.result_note || '', onChange: (v) => (r.result ? setRes(r, r.result, v) : toast('先选打电话的结果', 'err')) }) },
            { key: 'called_at', label: '几点打的', w: 130, value: (r) => r.called_at || '', render: (r) => (r.called_at ? dt(r.called_at) : '') },
            { key: 'cust', label: '潜客', w: 150, sortable: false, render: (r) => (r.customer_id ? <CustLink id={r.customer_id} name={r.customer_name} /> : '') },
          ]} />
        </div>)}
      {add && <AddCallList onClose={() => setAdd(false)} />}
    </div>
  );
}
function AddCallList({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [title, setTitle] = useState(''); const [text, setText] = useState(''); const [assignee, setAssignee] = useState('');
  const emps = useData(() => q(`select id, short_name from app.employees where org_id = $1 and active order by short_name`, [org]), [org]).data || [];
  const rows = useMemo(() => text.split(/\r?\n/).map((ln) => ln.split(/\t|,|;/).map((x) => x.trim())).filter((c) => c.some(Boolean)).map((c) => ({ name: c[0] || '', phone: c[1] || '', city: c[2] || '', note: c.slice(3).filter(Boolean).join(' ') })).filter((r) => !/^(名字|姓名|name|nom)$/i.test(r.name)), [text]);
  const go = async () => { try { await call(role, `select app.create_call_list($1,$2,$3,null,$4)`, [org, title, assignee || null, JSON.stringify(rows)]); toast(`名单已建，${rows.length} 个人`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const why = !title.trim() ? '给名单起个名字' : !rows.length ? '名单是空的' : '';
  return (
    <Modal wide title="加一张打电话名单" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{why && <span className="why">{why}</span>}<button type="button" className="btn primary" disabled={!!why} onClick={go}>建名单（{rows.length} 人）</button></>}>
      <div className="stack">
        <FRow label="名单叫什么" req><input className="in" style={{ width: '100%', maxWidth: 380 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如 Adjamé 新店摸排 11 月" /></FRow>
        <FRow label="给谁打"><select className="in" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">热线（不指定）</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.short_name}</option>)}</select></FRow>
        <FRow label="名单" req><div className="stack" style={{ flex: 1, gap: 6 }}>
          <FileDrop accept=".xlsx,.xls,.csv,.txt" label="把 Excel / CSV 拖进来，或者直接在下面粘贴" onFiles={async (fs) => { const f = fs[0]; if (!f) return; if (/\.(csv|txt)$/i.test(f.name)) { setText(await f.text()); return; } try { const X = await import('exceljs'); const wb = new X.Workbook(); await wb.xlsx.load(await f.arrayBuffer()); const out = []; wb.worksheets[0].eachRow((r) => out.push(r.values.slice(1).map((v) => (v && typeof v === 'object' ? (v.text || v.result || '') : v ?? '')).join('\t'))); setText(out.join('\n')); } catch (e) { toast('读不了这个文件：' + (e.message || e), 'err'); } }} />
          <textarea className="in" rows={7} style={{ width: '100%', fontFamily: 'inherit' }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'一行一个人，列的顺序：名字、电话、城市、备注（从 Excel 复制几列直接粘贴）\nKONE\t0711111111\tAdjamé\nBAMBA\t0722222222\tYopougon'} />
          <div className="small muted">认出 {rows.length} 个人{rows[0] ? `，第一个：${rows[0].name} ${rows[0].phone}` : ''}</div></div></FRow>
      </div>
    </Modal>
  );
}

// ───────── 252: 每月初对比上两个整月的提货量 → 涨跌特别大的客户着重跟进 ─────────
export function VolumeShift() {
  const { org } = useApp();
  const data = useData(async () => {
    const pct = N((await q(`select value from app.org_settings where org_id = $1 and key = 'volume_shift'`, [org]))[0]?.value?.pct) || 50;
    const rows = await q(`with m as (select d.customer_id, date_trunc('month', s.shipped_at) as mo, sum(sl.qty)::int as pcs, sum(sl.amount) as amt
        from app.shipments s join app.deals d on d.id = s.deal_id join app.shipment_lines sl on sl.shipment_id = s.id
        where d.org_id = $1 and s.voided_at is null and s.shipped_at >= date_trunc('month', now()) - interval '2 months' and s.shipped_at < date_trunc('month', now()) group by 1, 2)
      select c.id, c.name, c.city, c.tier, coalesce(a.pcs, 0) as prev_pcs, coalesce(b.pcs, 0) as last_pcs, coalesce(a.amt, 0) as prev_amt, coalesce(b.amt, 0) as last_amt
      from app.customers c left join m a on a.customer_id = c.id and a.mo = date_trunc('month', now()) - interval '2 months' left join m b on b.customer_id = c.id and b.mo = date_trunc('month', now()) - interval '1 month'
      where c.org_id = $1 and (a.pcs is not null or b.pcs is not null)`, [org]);
    return { pct, rows: rows.map((r) => ({ ...r, chg: N(r.prev_pcs) ? ((N(r.last_pcs) - N(r.prev_pcs)) / N(r.prev_pcs)) * 100 : 999 })).filter((r) => Math.abs(r.chg) >= pct).sort((x, y) => x.chg - y.chg) };
  }, [org]).data;
  if (!data || !data.rows.length) return null;
  const mo = (k) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return `${d.getUTCMonth() + 1} 月`; };
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>提货量变化大的客户</h2><span className="pill amber">{data.rows.length} 个 · 着重跟进</span>
        <Info>每月初自动对比上两个整月（{mo(2)} 和 {mo(1)}）的出库片数，涨或跌超过 {data.pct}% 的列在这里。跌得多的去问问原因，涨得多的看要不要调档位。这条线在「设置 → 规则参数」里可以调。</Info></div>
      <Grid id="vol-shift" noTools rows={data.rows} columns={[
        { key: 'name', label: '客户', w: 180, render: (r) => <CustLink id={r.id} name={r.name} /> },
        { key: 'city', label: '城市', w: 100 },
        { key: 'prev_pcs', label: `${mo(2)}（片）`, w: 100, type: 'number', render: (r) => qty(r.prev_pcs) },
        { key: 'last_pcs', label: `${mo(1)}（片）`, w: 100, type: 'number', render: (r) => <b>{qty(r.last_pcs)}</b> },
        { key: 'chg', label: '变化', w: 150, value: (r) => r.chg, render: (r) => (r.chg === 999 ? <span className="pill green">上个月新开始拿货</span> : <span className={`pill ${r.chg < 0 ? 'red' : 'green'}`}>{r.chg < 0 ? '跌' : '涨'} {Math.abs(r.chg).toFixed(0)}%</span>) },
        { key: 'last_amt', label: `${mo(1)} 金额`, w: 130, type: 'number', render: (r) => money(r.last_amt) },
      ]} />
    </div>
  );
}
