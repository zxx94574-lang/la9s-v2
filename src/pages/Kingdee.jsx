// 金蝶同步 (Frank: 金蝶是和总部对账的依据, 但不把流程拴在金蝶上).
// 出库单: 客户签收 → 待录 → 保存 (填金蝶单号) → 提交 → 审核, 三步分开, 提交和审核不能是同一个人.
// 现在还没有金蝶接口 (要金蝶管理员开 API), 所以是「系统给出要录的明细 → 人在金蝶里录 → 回来点步骤」; 接口开了以后同一个队列自动跑.
// 库存对账: 把金蝶即时库存粘进来存成快照, 和系统库存逐行比, 差多少一眼看到.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, DatePicker } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { can } from '../lib/domain.js';
import { money, dDate, dt, today, friendlyError, qty } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink , DealLink} from '../components/Archives.jsx';

const ST = { await_receipt: ['待客户签收', 'gray'], ready: ['待录金蝶', 'amber'], saved: ['已保存', 'blue'], submitted: ['已提交 · 待审核', 'blue'], synced: ['已审核', 'green'], error: ['出错', 'red'], void: ['已撤销出库', 'gray'] };
// 没有金蝶接口时的退路（待改 118）：把「待录金蝶」的出库单按金蝶「销售出库单」引入的列导成 Excel，在金蝶里一次引入
async function exportKdSales(org, ids, toast) {
  const rows = await q(`select x.out_no, d.biz_no, x.shipped_at, x.customer_received_at, c.code as customer_code, c.name as customer, d.currency,
      p.code, cat.name as category, p.model, w.code as wh, sl.qty, sl.unit_price, sl.amount
    from app.shipments x join app.deals d on d.id = x.deal_id join app.customers c on c.id = d.customer_id
    join app.shipment_lines sl on sl.shipment_id = x.id join app.deal_lines l on l.id = sl.deal_line_id
    join app.products p on p.id = l.product_id join app.categories cat on cat.id = p.category_id
    left join app.stock_items si on si.id = l.stock_item_id left join app.warehouses w on w.id = si.warehouse_id
    where x.org_id = $1 and x.id = any($2::uuid[]) order by x.shipped_at, x.out_no, p.code`, [org, ids]);
  if (!rows.length) return toast('选中的单没有明细', 'err');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('销售出库单');
  ws.columns = [['单据日期', 12], ['客户编码', 12], ['客户名称', 22], ['发货仓库', 22], ['物料编码', 14], ['物料名称（种类 型号）', 26], ['实发数量', 10], ['含税单价', 12], ['价税合计', 14], ['结算币别', 8], ['系统出库单号', 18], ['系统业务号', 18]].map(([header, width]) => ({ header, width }));
  for (const r of rows) ws.addRow([dDate(r.customer_received_at || r.shipped_at), r.customer_code, r.customer, KD_WH[r.wh] || r.wh || '', r.code, `${r.category} ${r.model}`, Number(r.qty), Number(r.unit_price), Number(r.amount), r.currency, r.out_no, r.biz_no]);
  ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = `金蝶引入-销售出库-${today()}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`已导出 ${new Set(rows.map((r) => r.out_no)).size} 张单 ${rows.length} 行，在金蝶「销售出库单 → 引入」里用`);
}
const WH = { 'CI LA MATERIAL WH': 'LA', 'CI 9S MATERIAL WH': '9S', 'CI LA FOB MATERIAL WH': 'FOB', 'CI PENDING LIABILITY WH': 'PENDING', 'CI DEFECTIVE WH-LA': 'SCRAP', 'CI DEFECTIVE WH-9S': 'SCRAP', 'CI PCBA RECYCLE WH': 'RECYCLE', 'CI CHIP RECYCLE WH': 'RECYCLE' };

import { KdAll, KdRecon } from '../components/KdRecon.jsx';
export default function Kingdee() {
  const { org, role, toast, refresh, go } = useApp();
  const [tab, setTab] = useState('all');
  const [f, setF] = useState('ready');
  const [m, setM] = useState(null);
  const [asOf, setAsOf] = useState(null);
  const { data } = useData(async () => {
    const [rows, snaps, grn] = await Promise.all([q(Q.kdOutbox, [org]), q(Q.kdSnapshots, [org]), q(Q.poReceipts, [org])]);
    const d = asOf || (snaps[0] && dDate(snaps[0].as_of));
    const diff = d ? await q(Q.kdStockDiff, [org, d]) : [];
    return { rows, snaps, diff, d, grn };
  }, [org, asOf]);
  if (!data) return <div className="empty">加载中…</div>;
  const step = async (o, s, no) => { try { await call(role, `select app.kd_step($1,$2,$3)`, [o.id, s, no || null]); toast({ save: '已保存', submit: '已提交，等另一个人审核', audit: '已审核，和金蝶对齐了', back: '已退回上一步' }[s]); refresh(); setM(null); } catch (e) { toast(friendlyError(e), 'err'); } };
  const counts = Object.fromEntries(Object.keys(ST).map((k) => [k, data.rows.filter((r) => r.status === k).length]));
  const rows = data.rows.filter((r) => !f || r.status === f);
  const cols = [
    { key: 'out_no', label: '出库单', w: 130, render: (r) => <DealLink id={r.deal_id} no={r.out_no} /> },
    { key: 'customer_name', label: '客户', w: 150, value: (r) => `${r.customer_code} ${r.customer_name}`, render: (r) => <><span className="mono muted">{r.customer_code}</span> <CustLink id={r.customer_id} name={r.customer_name} /></> },
    { key: 'shipped_at', label: '出库', w: 110, render: (r) => dDate(r.shipped_at) },
    { key: 'customer_received_at', label: '客户签收', w: 110, render: (r) => dDate(r.customer_received_at) || <span className="muted">未签收</span> },
    { key: 'qty', label: '件数', w: 70, value: (r) => Number(r.qty || 0) },
    { key: 'amount', label: '金额', w: 110, value: (r) => Number(r.amount || 0), render: (r) => money(r.amount) },
    { key: 'status', label: '金蝶', w: 120, value: (r) => ST[r.status][0], render: (r) => <Pill tone={ST[r.status][1]}>{ST[r.status][0]}</Pill> },
    { key: 'remote_no', label: '金蝶单号', w: 130, render: (r) => <span className="mono">{r.remote_no}</span> },
    { key: 'act', label: '', w: 200, render: (r) => (
      <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
        {r.status === 'ready' && can(role, 'kd_save') && <button type="button" className="btn sm primary" onClick={() => setM({ t: 'save', r })}>录入并保存</button>}
        {r.status === 'saved' && can(role, 'kd_save') && <button type="button" className="btn sm primary" onClick={() => step(r, 'submit')}>已提交</button>}
        {r.status === 'submitted' && can(role, 'kd_audit') && <button type="button" className="btn sm primary" onClick={() => step(r, 'audit')}>已审核</button>}
        {['saved', 'submitted', 'synced'].includes(r.status) && can(role, 'kd_audit') && <button type="button" className="btn sm" onClick={() => step(r, 'back')}>退一步</button>}
      </span>) },
  ];
  const dCols = [
    { key: 'code', label: '编码', w: 100, render: (r) => <span className="mono">{r.code}</span> },
    { key: 'category', label: '种类', w: 90 }, { key: 'model', label: '型号', w: 120, render: (l) => <ModelLink id={l.product_id} model={l.model} /> },
    { key: 'warehouse', label: '仓库', w: 80 },
    { key: 'sys_qty', label: '系统', w: 80, value: (r) => Number(r.sys_qty) },
    { key: 'kd_qty', label: '金蝶', w: 80, value: (r) => Number(r.kd_qty) },
    { key: 'diff', label: '差（系统 − 金蝶）', w: 120, value: (r) => Number(r.diff), render: (r) => <b className={Number(r.diff) > 0 ? 'amber-t2' : 'red-t2'}>{Number(r.diff) > 0 ? '+' : ''}{Number(r.diff)}</b> },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Synchronisation Kingdee</div><h1>金蝶同步</h1>
        <div className="sub">客户签收后才录金蝶：保存（填金蝶单号）→ 提交 → 审核，三步分开，提交和审核不能是同一个人。金蝶接口还没开，现在是系统列出要录的明细、人在金蝶里录完回来点步骤。</div></div></div>
      <div className="card">
        <div className="tabs"><button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>待录金蝶（总表）</button>
          <button type="button" className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>出库单录金蝶 <span className="queue-n">{counts.ready || ''}</span></button>
          <button type="button" className={tab === 'grn' ? 'on' : ''} onClick={() => setTab('grn')}>采购入库 <span className="queue-n">{data.grn.filter((g) => g.kd_status === 'ready').length || ''}</span></button>
          <button type="button" className={tab === 'misc' ? 'on' : ''} onClick={() => setTab('misc')}>其他出入库 / 调拨 / 退货</button>
          <button type="button" className={tab === 'stock' ? 'on' : ''} onClick={() => setTab('stock')}>库存快照</button>
          <button type="button" className={tab === 'pool' ? 'on' : ''} onClick={() => setTab('pool')}>盘点编码顶替</button>
          {['admin', 'finance'].includes(role) && <button type="button" className={tab === 'recon' ? 'on' : ''} onClick={() => setTab('recon')}>和金蝶对账</button>}
          {['admin', 'finance'].includes(role) && <button type="button" className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>应收期初差异</button>}</div>
        {tab === 'all' && <div className="card-b"><KdAll /></div>}
        {tab === 'recon' && <div className="card-b"><KdRecon /></div>}
        {tab === 'grn' && <GrnList rows={data.grn} />}
        {tab === 'misc' && <MiscList />}
        {tab === 'pool' && <PoolList />}
        {tab === 'open' && <KdOpening />}
        {['grn', 'misc', 'all', 'recon', 'pool', 'open'].includes(tab) ? null : tab === 'queue' ? (
          <Grid id="kd-queue" table="kingdee_outbox" columns={cols} rows={rows} onRowClick={(r) => go('deal/' + r.deal_id)} empty="没有"
            tools={<div className="chips">{[['ready', '待录'], ['saved', '已保存'], ['submitted', '待审核'], ['synced', '已审核'], ['await_receipt', '待签收'], ['', '全部']].map(([k, l]) =>
              <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} {k ? counts[k] : data.rows.length}</button>)}
              {can(role, 'kd_save') && counts.ready > 0 && <button type="button" className="btn sm soft" title="金蝶接口没开之前的退路：导成金蝶「销售出库单」引入格式，在金蝶里一次引入；引入完回来点「录入并保存」填金蝶单号" onClick={() => exportKdSales(org, data.rows.filter((r) => r.status === 'ready').map((r) => r.shipment_id), toast).catch((e) => toast(friendlyError(e), 'err'))}>导出待录 {counts.ready} 张（金蝶引入 Excel）</button>}</div>} />
        ) : (<>
          <div className="card-b row" style={{ gap: 10, paddingTop: 0, flexWrap: 'wrap' }}>
            {data.snaps.length > 0 ? <select className="in" style={{ maxWidth: 220 }} value={data.d || ''} onChange={(e) => setAsOf(e.target.value)}>
              {data.snaps.map((s) => <option key={dDate(s.as_of)} value={dDate(s.as_of)}>金蝶快照 {dDate(s.as_of)}（{s.n} 行）</option>)}</select> : <span className="muted small">还没有金蝶库存快照</span>}
            {data.d && <Pill tone={data.diff.length ? 'amber' : 'green'}>{data.diff.length ? `${data.diff.length} 行对不上` : '全部对得上'}</Pill>}
            <span className="grow" />
            {can(role, 'kd_save') && <button type="button" className="btn sm primary" onClick={() => setM({ t: 'snap' })}>粘贴金蝶即时库存</button>}
          </div>
          {data.d && <Grid id="kd-diff" columns={dCols} rows={data.diff} rowKey={(r) => r.code + r.warehouse} empty="系统和金蝶完全一致 ✓" />}
        </>)}
      </div>
      {m?.t === 'save' && <SaveModal r={m.r} onClose={() => setM(null)} onOk={(no) => step(m.r, 'save', no)} />}
      {m?.t === 'snap' && <SnapModal onClose={() => setM(null)} onDone={(d) => { setAsOf(d); setTab('stock'); }} />}
    </>
  );
}

function SaveModal({ r, onClose, onOk }) {
  const { toast } = useApp();
  const [no, setNo] = useState('');
  const { data } = useData(() => q(Q.kdShipmentLines, [r.id]), [r.id]);
  const text = (data || []).map((l) => [l.kingdee_code || l.code, l.model, l.category, l.qty, Number(l.unit_price), Number(l.amount), l.warehouse].join('\t')).join('\n');
  return (
    <Modal wide title={`录金蝶 · ${r.out_no} · ${r.customer_code} ${r.customer_name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(text); toast('明细已复制，可以粘进金蝶'); } catch { toast('浏览器不让复制', 'err'); } }}>复制明细</button><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!no.trim()} onClick={() => onOk(no)}>已在金蝶保存</button></>}>
      <div className="stack">
        <div className="hint">在金蝶新建销售出库单：客户 {r.customer_code}，日期 {dDate(r.shipped_at)}，按下面明细录入并保存，把金蝶生成的单号填回来。</div>
        <Grid id="kd-so-lines" noTools rowKey={(l) => l._k} rows={(data || []).map((l, i) => ({ ...l, _k: String(i) }))} columns={[
          { key: 'code', label: '物料编码', w: 100, mono: true, value: (l) => l.kingdee_code || l.code },
          { key: 'model', label: '型号', w: 120, value: (l) => l.model, render: (l) => <ModelLink id={l.product_id} model={l.model} /> },
          { key: 'category', label: '种类', w: 110, value: (l) => l.category },
          { key: 'qty', label: '数量', w: 70, value: (l) => l.qty, render: (l) => qty(l.qty) },
          { key: 'price', label: '单价', w: 100, align: 'right', value: (l) => l.unit_price, render: (l) => money(l.unit_price) },
          { key: 'amount', label: '金额', w: 110, align: 'right', value: (l) => l.amount, render: (l) => money(l.amount) },
          { key: 'wh', label: '仓库', w: 70, value: (l) => l.warehouse },
        ]} />
        <div className="field req"><label>金蝶单号</label><input className="in mono" autoFocus value={no} onChange={(e) => setNo(e.target.value)} placeholder="XSCKD…" style={{ maxWidth: 260 }} /></div>
      </div>
    </Modal>
  );
}

function SnapModal({ onClose, onDone }) {
  const { org, role, toast, refresh } = useApp();
  const [d, setD] = useState(today());
  const [text, setText] = useState('');
  const rows = [];
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length > 1) {
    const h = lines[0].split('\t').map((x) => x.trim());
    const ic = h.findIndex((x) => /^物料(编码)?$/.test(x)), iw = h.findIndex((x) => /仓库/.test(x)), iq = h.findIndex((x) => /库存数量|数量/.test(x));
    if (ic >= 0 && iw >= 0 && iq >= 0) for (const l of lines.slice(1)) {
      const c = l.split('\t'); const w = (c[iw] || '').trim().toUpperCase();
      if (c[ic]?.trim()) rows.push({ code: c[ic].trim(), warehouse: WH[w] || w, qty: Number(String(c[iq]).replace(/[\s,]/g, '')) || 0 });
    }
  }
  const go = async () => { try { const [{ n }] = await call(role, `select app.import_kd_snapshot($1,$2,$3) as n`, [org, d, JSON.stringify(rows)]); toast(`已存金蝶快照 ${n} 行`); refresh(); onDone(d); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal wide title="粘贴金蝶即时库存" onClose={onClose}
      footer={<><span className="small muted">识别到 {rows.length} 行。只存快照用来对账，不改系统库存。</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!rows.length} onClick={go}>保存快照</button></>}>
      <div className="stack">
        <DatePicker value={d} onChange={setD} label="金蝶导出日期" />
        <div className="hint">金蝶「即时库存」导出后，从表头那一行（序号 / 物料分类 / 物料 / … / 库存数量 / 仓库）开始整块复制，粘进来。仓库名自动对到 LA / 9S / FOB / 待检 / 回收 / 报废。</div>
        <textarea className="in mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
    </Modal>
  );
}

// 系统收货 → 金蝶采购入库: FOB 那部分入 FOB 仓, 本地入 LA / 9S 仓 —— 这样金蝶也能分清 FOB 和本地备货
export const KD_WH = { LA: 'CI LA Material WH', '9S': 'CI 9S Material WH', FOB: 'CI LA FOB Material WH' };
function GrnList({ rows }) {
  const { role, toast, refresh } = useApp();
  const [no, setNo] = useState({});
  const step = async (g, s) => { try { await call(role, `select app.kd_grn_step($1,$2,$3)`, [g.id, s, no[g.id] || null]); toast(s === 'save' ? '已记金蝶入库单号' : '已完成'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  if (!rows.length) return <div className="empty">还没有收货单。到货在「备货看板 → 在途采购 → 到货入库」收。</div>;
  return (
    <div className="card-b stack">
      <div className="hint">按仓库分好了，照着在金蝶「采购入库单」里录（关联原采购订单）：FOB 部分入 <b>CI LA FOB Material WH</b>，本地部分入 LA / 9S 仓。录完填金蝶单号。</div>
      {rows.map((g) => {
        const parts = [];
        for (const l of g.lines) {
          if (l.local_qty) parts.push({ wh: KD_WH[l.warehouse] || l.warehouse, code: l.code, model: l.model, qty: l.local_qty, cust: '' });
          if (l.fob_qty) parts.push({ wh: KD_WH.FOB, code: l.code, model: l.model, qty: l.fob_qty, cust: l.fob_customer || '' });
        }
        const text = parts.map((x) => [x.code, x.model, x.qty, x.wh, x.cust].join('\t')).join('\n');
        return (
          <div key={g.id} className="card card-b">
            <div className="row" style={{ gap: 8 }}><b className="mono">{g.grn_no}</b><span className="muted small">采购单 {g.po_no} · {dt(g.created_at)}</span><span className="grow" />
              <Pill tone={g.kd_status === 'synced' ? 'green' : g.kd_status === 'saved' ? 'blue' : 'amber'}>{({ ready: '待录金蝶', saved: '已录 ' + (g.kd_no || ''), synced: '已完成' })[g.kd_status]}</Pill></div>
            <div style={{ marginTop: 8 }}><Grid id={`kd-grn-${g.id}`} noTools rowKey={(x) => x._k} rows={parts.map((x, i) => ({ ...x, _k: String(i) }))} columns={[
              { key: 'wh', label: '金蝶仓库', w: 160, value: (x) => x.wh },
              { key: 'code', label: '物料编码', w: 100, mono: true, value: (x) => x.code },
              { key: 'model', label: '型号', w: 120, value: (x) => x.model, render: (x) => <ModelLink id={x.product_id} model={x.model} /> },
              { key: 'qty', label: '数量', w: 70, value: (x) => x.qty, render: (x) => qty(x.qty) },
              { key: 'cust', label: 'FOB 客户', w: 90, value: (x) => x.cust || '' },
            ]} /></div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <button type="button" className="btn sm" onClick={async () => { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('浏览器不让复制', 'err'); } }}>复制明细</button>
              {g.kd_status === 'ready' && can(role, 'kd_save') && <><input className="in mono" placeholder="金蝶入库单号" value={no[g.id] || ''} onChange={(e) => setNo({ ...no, [g.id]: e.target.value })} style={{ maxWidth: 200 }} />
                <button type="button" className="btn sm primary" disabled={!no[g.id]} onClick={() => step(g, 'save')}>已在金蝶录入</button></>}
              {g.kd_status === 'saved' && can(role, 'kd_audit') && <button type="button" className="btn sm primary" onClick={() => step(g, 'done')}>金蝶已审核</button>}
            </div>
          </div>);
      })}
    </div>
  );
}


// 11-13: 销售出库以外会动库存的事 (收货差异补扣 / 冲回、冻结转待检、退货入库、检验分流) → 都列成金蝶待录, 录完填金蝶单号
const MISC_REASON = { discrepancy_back: '收货差异：货回仓', discrepancy_fix: '收货差异：修正', hold_to_pending: '问题库存转待检仓', inspect_good: '退货检验：好货回原仓', inspect_scrap: '退货检验：坏货进报废仓', return_in: '客户退货入待检仓', adjust: '手工调整' };
function MiscList() {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState('ready'); const [sel, setSel] = useState(new Set()); const [no, setNo] = useState('');
  const { data } = useData(() => q(`select k.*, p.code, p.model, c.name as category, p.id as product_id, w.code as warehouse, s.bin
    from app.kingdee_misc k join app.stock_items s on s.id = k.stock_item_id join app.products p on p.id = s.product_id
    join app.categories c on c.id = p.category_id join app.warehouses w on w.id = s.warehouse_id
    where k.org_id = $1 order by k.at desc limit 500`, [org]), [org]);
  if (!data) return <div className="card-b muted">加载中…</div>;
  const rows = data.filter((r) => !f || r.status === f);
  const done = async (skip) => { try { const n = (await call(role, `select app.kingdee_misc_done($1,$2,$3) as n`, [[...sel], no, skip]))[0].n; toast(skip ? `${n} 条标成不用录` : `${n} 条已录金蝶 ${no}`); setSel(new Set()); setNo(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Grid id="kd-misc" rows={rows} selectable={['admin', 'manager', 'finance'].includes(role) ? { selected: sel, onChange: setSel } : undefined} empty="没有要录的"
      tools={<><div className="chips">{[['ready', '待录'], ['done', '已录'], ['skip', '不用录'], ['', '全部']].map(([k, l]) => <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} {k ? data.filter((r) => r.status === k).length : data.length}</button>)}</div>
        {sel.size > 0 && <span className="row" style={{ gap: 6 }}><input className="in" style={{ width: 150 }} placeholder="金蝶单号" value={no} onChange={(e) => setNo(e.target.value)} />
          <button type="button" className="btn sm primary" disabled={!no.trim()} onClick={() => done(false)}>选中的 {sel.size} 条已录金蝶</button><button type="button" className="btn sm" onClick={() => done(true)}>不用录</button></span>}</>}
      columns={[
        { key: 'at', label: '什么时候', w: 130, value: (r) => r.at, render: (r) => dt(r.at) },
        { key: 'doc_type', label: '金蝶单据', w: 120, render: (r) => <b>{r.doc_type}</b> },
        { key: 'reason', label: '怎么来的', w: 190, value: (r) => MISC_REASON[r.reason] || r.reason },
        { key: 'warehouse', label: '仓库', w: 80 }, { key: 'code', label: '编码', w: 100 }, { key: 'category', label: '种类', w: 90 },
        { key: 'model', label: '型号', w: 110, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
        { key: 'qty', label: '数量（+ 进 / − 出）', w: 130, type: 'number', render: (r) => <b style={{ color: r.qty < 0 ? 'var(--red)' : undefined }}>{r.qty > 0 ? '+' : ''}{qty(r.qty)}</b> },
        { key: 'status', label: '状态', w: 90, value: (r) => r.status, render: (r) => <Pill tone={r.status === 'ready' ? 'amber' : r.status === 'done' ? 'green' : 'gray'}>{r.status === 'ready' ? '待录' : r.status === 'done' ? '已录' : '不用录'}</Pill> },
        { key: 'remote_no', label: '金蝶单号', w: 130 },
      ]} />
  );
}

// 盘点后「消耗池」：实物出的是 A 编码、金蝶该扣的是同一种货的 B 编码（盘盈的那个）—— 财务录金蝶出库时照「金蝶出库编码」录
function PoolList() {
  const { org } = useApp();
  const { data } = useData(() => Promise.all([
    q(`select u.id, u.at, u.qty, x.out_no, x.deal_id, d.biz_no, cu.name as customer,
         a.code as ship_code, a.model as ship_model, a.id as ship_id, b.code as kd_code, b.model as kd_model, b.id as kd_id
       from app.pool_uses u left join app.stock_moves m on m.id = u.move_id left join app.shipments x on x.id = m.ref_id
       left join app.deals d on d.id = x.deal_id left join app.customers cu on cu.id = d.customer_id
       join app.products a on a.id = u.ship_product join app.products b on b.id = u.kd_product
       where u.org_id = $1 order by u.at desc limit 500`, [org]),
    q(`select p.side, sum(p.qty_left)::int as left_, count(*)::int as n from app.stock_pool p where p.org_id = $1 and p.qty_left > 0 group by p.side`, [org]),
  ]), [org]);
  if (!data) return <div className="card-b muted">加载中…</div>;
  const [rows, pool] = data;
  const left = (k) => pool.find((x) => x.side === k)?.left_ || 0;
  return (
    <div className="card-b stack" style={{ gap: 8 }}>
      <div className="hint">盘点后同一种货（编码甄别里定成同一组的）有的编码盘盈、有的盘亏：系统先不改金蝶，出货时<b>实物出 A、金蝶扣 B</b>，慢慢把差异消化掉。财务录金蝶销售出库时，这些行照「金蝶出库编码」录。
        现在池子里还剩：盘盈待消化 <b>{qty(left('+'))}</b> 片 · 盘亏待消化 <b>{qty(left('-'))}</b> 片。</div>
      <Grid id="kd-pool" rows={rows} empty="还没有顶替（盘点确认后、出到盘亏的编码时才会有）" columns={[
        { key: 'at', label: '什么时候', w: 130, value: (r) => r.at, render: (r) => dt(r.at) },
        { key: 'out_no', label: '出库单', w: 130, render: (r) => <DealLink id={r.deal_id} no={r.out_no || r.biz_no || '—'} /> },
        { key: 'customer', label: '客户', w: 130 },
        { key: 'ship_code', label: '实物出的编码', w: 120, render: (r) => <><span className="mono">{r.ship_code}</span> <ModelLink id={r.ship_id} model={r.ship_model} /></> },
        { key: 'kd_code', label: '金蝶出库编码', w: 140, render: (r) => <><b className="mono">{r.kd_code}</b> <ModelLink id={r.kd_id} model={r.kd_model} /></> },
        { key: 'qty', label: '片数', w: 80, type: 'number', sum: true },
      ]} />
    </div>
  );
}

// 应收期初差异表（§3b 第 3 组）：期间客户 Balance 以系统（= 飞书）为准；金蝶差多少记在这里，不进日常账；跑通后中方逐个调平
function KdOpening() {
  const { org, role, toast, refresh } = useApp();
  const [asOf, setAsOf] = useState(null); const [paste, setPaste] = useState(false); const [txt, setTxt] = useState(''); const [day, setDay] = useState(today());
  const [clr, setClr] = useState(null); const [note, setNote] = useState(''); const [f, setF] = useState('open');
  const { data } = useData(async () => {
    const days = await q(`select distinct as_of from app.kd_opening_diff where org_id = $1 order by as_of desc`, [org]);
    const d = asOf || (days[0] && dDate(days[0].as_of));
    const rows = d ? await q(`select o.*, c.name as customer, c.id as cid from app.kd_opening_diff o left join app.customers c on c.id = o.customer_id where o.org_id = $1 and o.as_of = $2 order by abs(o.sys_amount - o.kd_amount) desc`, [org, d]) : [];
    return { days, d, rows };
  }, [org, asOf]);
  if (!data) return <div className="card-b muted">加载中…</div>;
  // 从 Excel 复制 = 制表符分隔；金额里的千分位逗号不能当分隔符
  const parsed = txt.split(/\r?\n/).map((l) => (l.includes('\t') ? l.split('\t') : l.split(/;|\s{2,}/)).map((x) => x.trim())).filter((c) => c[0] && /\d/.test(c[1] || ''))
    .map((c) => ({ code: c[0], amount: Number(String(c[1]).replace(/[^\d.-]/g, '')) || 0, currency: /^[A-Za-z]{3}$/.test(c[2] || '') ? c[2].toUpperCase() : 'XOF' }));
  const save = async () => { try { const n = (await call(role, `select app.kd_opening_paste($1,$2,$3) as n`, [org, day, JSON.stringify(parsed)]))[0].n; toast(`已按 ${day} 比对 ${n} 个客户`); setPaste(false); setTxt(''); setAsOf(day); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const clear = async () => { try { await call(role, `select app.kd_opening_clear($1,$2)`, [clr.id, note]); toast('已记成调平'); setClr(null); setNote(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const diff = (r) => Number(r.sys_amount) - Number(r.kd_amount);
  const all = data.rows.filter((r) => diff(r) !== 0);
  const rows = all.filter((r) => (f === 'open' ? !r.cleared_at : f === 'done' ? r.cleared_at : true));
  const sumOpen = all.filter((r) => !r.cleared_at).reduce((a, r) => a + diff(r), 0);
  return (
    <div className="card-b stack" style={{ gap: 8 }}>
      <div className="hint">金蝶「应收款余额表」导出后，把<b>客户编码、余额（、币别）</b>两三列复制粘进来，系统按那天比对每个客户。<b>这里的差额不进客户 Balance</b>（期间以系统 = 飞书为准）；跑通后中方逐个调平、写怎么调的，最后以金蝶为准。</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {data.days.length ? <select className="in" style={{ maxWidth: 200 }} value={data.d || ''} onChange={(e) => setAsOf(e.target.value)}>{data.days.map((x) => <option key={dDate(x.as_of)} value={dDate(x.as_of)}>比对日 {dDate(x.as_of)}</option>)}</select> : <span className="muted small">还没粘过金蝶应收</span>}
        {data.d && <><Pill tone={all.some((r) => !r.cleared_at) ? 'amber' : 'green'}>{all.filter((r) => !r.cleared_at).length} 个客户没调平 · 合计差 {money(sumOpen)}</Pill>
          <div className="chips">{[['open', '没调平'], ['done', '已调平'], ['', '全部']].map(([k, l]) => <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l}</button>)}</div></>}
        <span className="grow" />
        <button type="button" className="btn sm primary" onClick={() => setPaste(true)}>粘贴金蝶应收余额</button>
      </div>
      {data.d && <Grid id="kd-opening" rows={rows} empty={f === 'open' ? '全部调平了 ✓' : '没有'} columns={[
        { key: 'customer_code', label: '客户编码', w: 100, render: (r) => <span className="mono">{r.customer_code}</span> },
        { key: 'customer', label: '客户', w: 160, render: (r) => (r.cid ? <CustLink id={r.cid} name={r.customer} /> : <span className="pill red">系统里没有这个编码</span>) },
        { key: 'currency', label: '币别', w: 60 },
        { key: 'sys_amount', label: '系统（= 飞书）', w: 130, type: 'number', value: (r) => Number(r.sys_amount), render: (r) => money(r.sys_amount, r.currency) },
        { key: 'kd_amount', label: '金蝶', w: 130, type: 'number', value: (r) => Number(r.kd_amount), render: (r) => money(r.kd_amount, r.currency) },
        { key: 'diff', label: '差（系统 − 金蝶）', w: 140, type: 'number', sum: true, value: diff, render: (r) => <b className={diff(r) > 0 ? 'amber-t2' : 'red-t2'}>{diff(r) > 0 ? '+' : ''}{money(diff(r), r.currency)}</b> },
        { key: 'st', label: '状态', w: 260, value: (r) => (r.cleared_at ? '已调平' : '没调平'), render: (r) => (r.cleared_at ? <span className="small"><Pill tone="green">已调平</Pill> {r.clear_note}</span>
          : role === 'admin' ? <button type="button" className="btn sm" onClick={() => setClr(r)}>记成已调平…</button> : <Pill tone="amber">没调平</Pill>) },
      ]} />}
      {paste && <Modal title="粘贴金蝶应收余额" wide onClose={() => setPaste(false)} footer={<><button type="button" className="btn" onClick={() => setPaste(false)}>取消</button><span className="grow" />
        <button type="button" className="btn primary" disabled={!parsed.length} onClick={save}>比对 {parsed.length} 个客户</button></>}>
        <div className="stack">
          <div className="row" style={{ gap: 8 }}><span className="small">金蝶余额是哪天的：</span><DatePicker value={day} onChange={setDay} /></div>
          <textarea className="in" rows={10} style={{ width: '100%', fontFamily: 'monospace' }} placeholder={'CI0001\t2,350,000\nCI0002\t-150,000\tXOF'} value={txt} onChange={(e) => setTxt(e.target.value)} />
          <div className="small muted">认到 {parsed.length} 行。系统里有余额、金蝶表里没有的客户也会列出来（金蝶记 0）。同一天再粘一次会覆盖没调平的行。</div>
        </div></Modal>}
      {clr && <Modal title={`记成已调平 · ${clr.customer_code}`} onClose={() => setClr(null)} footer={<><button type="button" className="btn" onClick={() => setClr(null)}>取消</button><button type="button" className="btn primary" disabled={!note.trim()} onClick={clear}>确认</button></>}>
        <div className="stack"><div>差 <b>{money(diff(clr), clr.currency)}</b>。写一下怎么调平的（例如 金蝶补录了 SO-xxx / 飞书那笔是重复的已删）：</div>
          <input className="in" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} /></div></Modal>}
    </div>
  );
}
