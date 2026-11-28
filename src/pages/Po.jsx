import { showDone, DoneHost } from '../components/Done.jsx';
import { DocPeek, DocNo } from '../components/DocPeek.jsx';
// 采购单与到货 (Frank 2026-11-13, 待改 299 / 302) —— 国内初略版
// 规矩: 采购单分「本地备货」「FOB」(一张单只有一种); 国内发了货才有采购单 → 没下推入库的部分一律算在途;
// 到货时按箱勾「到了哪些箱」→ 一次下推一张采购入库单 (本地进 LA / 9S, FOB 进 FOB 仓); 少到的差额只有中方能关, 必须选结果 + 传凭证.
// 箱单 (飞书「98.箱单 › 科特」里那种 Excel) 直接拖进来: 按内容认页签 (页签名字不可靠), 读需求批次 / 入仓号 / 每箱型号数量 / 单价 / 金蝶料号.
import { OptChoice, OptNote } from '../components/Opts.jsx';
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Pill, Modal, Info, PhotoInput, FileDrop, Drawer, Thumb, DatePicker, Choice, ConfirmBtn } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ModelLink } from '../components/Archives.jsx';
import { can, hasAny } from '../lib/domain.js';
import { parsePackingBook } from '../lib/packingList.js';
import { InboundInput } from '../components/CodeInput.jsx';
import { ReceiveModal as LineReceive } from './Replenish.jsx';
import { dDate, dt, qty, money, today, friendlyError } from '../lib/format.js';
import { MetricStrip } from '../components/Metric.jsx';
import { periodRange } from '../lib/format.js';

const N = (v) => Number(v) || 0;
export const PURPOSE = { local: ['本地备货', 'blue'], fob: ['FOB', 'amber'], mixed: ['混装', 'amber'], supplies: ['物资', 'gray'], unknown: ['待定', 'gray'] };
const SOURCE = { kingdee: '金蝶导入', system: '系统建单', packing_list: '箱单导入' };
// 0106 物流进度 (Frank 11-27): 发货 → 到港 → 清关完 → 可提货 (有提货单) → 已提货 → 入库
export const MODE_L = { sea: '海运', air: '空运', other: '其他' };
export function stageOf(p) {
  if (p.status === 'closed') return ['已入库', 'green'];
  if (N(p.received) > 0) return ['部分入库', 'amber'];
  if (p.picked_on) return ['已提货', 'blue'];
  if (p.cleared_on) return p.has_pickup ? ['可提货', 'green'] : ['清关完 · 缺提货单', 'red'];
  if (p.arrived_on) return p.has_pickup ? ['到港 · 有提货单', 'blue'] : ['到港 · 缺提货单', 'red'];
  if (p.eta && dDate(p.eta) < today()) return ['过了预计还没到', 'red'];
  if (p.shipped_on) return ['在路上', 'blue'];
  return ['还没发货', 'gray'];
}
export const GAP_RESULTS = ['破损', '少发', '国内取消', '丢失', '补发中（另开单）', '其他'];

export const poListSql = `
select p.id, p.po_no, p.batch_name, p.warehouse_nos, p.purpose, p.fob_customer_codes, p.status, p.source, p.supplier, p.ordered_on, p.shipped_on, p.eta, p.mode, p.created_at,
  p.forwarder, p.tracking_no, p.container_no, p.weight_vol, p.freight_est, p.freight_none, p.arrived_on, p.cleared_on, p.picked_on, p.eta_first, p.eta_changes, p.boxes, p.pcs, p.note, p.remark,
  exists (select 1 from app.po_docs d where d.po_id = p.id and d.kind = 'pickup' and not d.removed) as has_pickup,
  (select count(*) from app.po_docs d where d.po_id = p.id and not d.removed)::int as docs_n,
  f.fob_no, (select coalesce(sum(l.qty),0) from app.po_lines l where l.po_id = p.id)::int as qty,
  (select coalesce(sum(l.qty_received),0) from app.po_lines l where l.po_id = p.id)::int as received,
  (select coalesce(sum(l.closed_qty),0) from app.po_lines l where l.po_id = p.id)::int as closed,
  (select count(*) from app.po_boxes b where b.po_id = p.id)::int as boxes_n,
  (select count(*) from app.po_boxes b where b.po_id = p.id and b.status = 'received')::int as boxes_in,
  (select count(*) from app.po_lines l where l.po_id = p.id and l.product_id is null)::int as unmatched_n,
  (select string_agg(distinct coalesce(pr.model, l.descr, l.model), ' / ') from app.po_lines l left join app.products pr on pr.id = l.product_id where l.po_id = p.id) as models,
  (select count(*) from app.po_lines l where l.po_id = p.id)::int as lines_n,
  (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) order by c.code), '[]') from app.customers c where c.org_id = p.org_id and c.code = any(coalesce(p.fob_customer_codes, '{}'))) as fob_customers,
  (select coalesce(jsonb_agg(jsonb_build_object('grn', r.grn_no, 'kd', r.kd_no, 'st', r.kd_status, 'at', r.created_at) order by r.created_at), '[]') from app.po_receipts r where r.po_id = p.id) as grns
from app.purchase_orders p left join app.fob_projects f on f.id = p.fob_project_id
where p.org_id = $1 order by coalesce(p.shipped_on, p.ordered_on, p.created_at::date) desc, p.po_no desc`;

// 372 (Frank 11-18): 按明细看 —— 一个型号一行 (一张单 10 个型号 = 10 行), 看「某个型号现在在途多少」
export const poLinesSql = `
select l.id, p.id as po_id, p.po_no, p.batch_name, p.warehouse_nos, p.purpose, p.status, p.shipped_on, p.eta, f.fob_no, p.fob_customer_codes,
  (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) order by c.code), '[]') from app.customers c where c.org_id = p.org_id and c.code = any(coalesce(p.fob_customer_codes, '{}'))) as fob_customers,
  l.product_id, pr.code, coalesce(pr.model, l.model) as model, coalesce(cat.name, '') as category, l.descr, l.qty, l.qty_received as received, coalesce(l.closed_qty, 0) as closed
from app.po_lines l join app.purchase_orders p on p.id = l.po_id left join app.fob_projects f on f.id = p.fob_project_id
left join app.products pr on pr.id = l.product_id left join app.categories cat on cat.id = pr.category_id
where p.org_id = $1 order by coalesce(p.shipped_on, p.ordered_on, p.created_at::date) desc, p.po_no desc, pr.code`;
const transitOf = (p) => N(p.qty) - N(p.received) - N(p.closed);
// 372: 客户列 = 客户姓名 (档案链接) + 灰色小字编码; FOB 项目号在前
function PoCust({ p }) {
  const { openArchive } = useApp();
  const cs = p.fob_customers || [];
  if (!p.fob_no && !cs.length) return p.purpose === 'fob' && (p.fob_customer_codes || []).length ? <span className="muted small">{(p.fob_customer_codes || []).join(', ')}</span> : '';
  return <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>{p.fob_no && <span className="mono small">{p.fob_no}</span>}{cs.map((c) => <span key={c.id}><button type="button" className="linkbtn" onClick={(e) => { e.stopPropagation(); openArchive({ kind: 'customer', id: c.id }); }}>{c.name}</button> <span className="small muted">{c.code}</span></span>)}</span>;
}
const custText = (p) => [p.fob_no, ...(p.fob_customers || []).map((c) => `${c.name} ${c.code}`), ...(!(p.fob_customers || []).length ? (p.fob_customer_codes || []) : [])].filter(Boolean).join(' ');
// 377: 金蝶状态 —— 每次到货对应金蝶一张采购入库单; 系统到了货但没填金蝶入库单号的要看得见
function kdState(p) {
  const g = p.grns || []; const miss = g.filter((x) => !x.kd).length;
  if (!g.length) return ['未入库', 'gray', ''];
  if (miss) return [`${miss} 次到货没填金蝶入库单号`, 'red', g.filter((x) => x.kd).map((x) => x.kd).join(' / ')];
  return [N(p.received) + N(p.closed) >= N(p.qty) ? '已入库' : '部分入库', N(p.received) + N(p.closed) >= N(p.qty) ? 'green' : 'amber', g.map((x) => x.kd).join(' / ')];
}
function poState(p) {
  if (p.status === 'closed') return N(p.closed) > 0 ? ['到齐（有差额已关）', 'green'] : ['已到齐', 'green'];
  if (N(p.received) > 0) return ['部分到货', 'amber'];
  return ['在途', 'blue'];
}

export function PoLink({ id, no }) {
  const { openArchive } = useApp();
  if (!id) return <span className="mono">{no}</span>;
  return <span className="deal-link"><DocPeek kind="po" id={id} /><button type="button" className="linkbtn mono" title={`打开采购单 ${no}`} onClick={(e) => { e.stopPropagation(); openArchive({ kind: 'po', id }); }}>{no}</button></span>;
}

export default function PoPage() {
  const { org, role } = useApp();
  const [f, setF] = useState('transit');
  const [imp, setImp] = useState(false);
  const [edit, setEdit] = useState(null);
  const [view, setView] = useState('po');   // 按订单看 / 按明细看
  const { data } = useData(() => q(poListSql, [org]), [org]);
  const { data: detail } = useData(() => (view === 'line' ? q(poLinesSql, [org]) : Promise.resolve(null)), [org, view]);
  if (!data) return <div className="empty">加载中…</div>;
  const rows = data.filter((p) => (f === 'transit' ? p.status !== 'closed' : f === 'done' ? p.status === 'closed' : f === 'fob' ? p.purpose === 'fob' : f === 'local' ? p.purpose !== 'fob' : true));
  const n = (k) => data.filter((p) => (k === 'transit' ? p.status !== 'closed' : k === 'done' ? p.status === 'closed' : k === 'fob' ? p.purpose === 'fob' : k === 'local' ? p.purpose !== 'fob' : true)).length;
  const cols = [
    { key: 'po_no', label: '采购单号', w: 190, render: (p) => <PoLink id={p.id} no={p.po_no} /> },
    { key: 'purpose', label: '用途', w: 90, value: (p) => PURPOSE[p.purpose || 'unknown'][0], render: (p) => <Pill tone={PURPOSE[p.purpose || 'unknown'][1]}>{PURPOSE[p.purpose || 'unknown'][0]}</Pill> },
    { key: 'fob_no', label: 'FOB 项目 / 客户', w: 220, value: custText, render: (p) => <PoCust p={p} /> },
    { key: 'batch_name', label: '需求批次', w: 200 },
    { key: 'inbound', label: '入仓号', w: 120, value: (p) => (p.warehouse_nos || []).join(' / ') },
    { key: 'models', label: '货', w: 150, value: (p) => p.models || '', render: (p) => (p.lines_n ? <span title={p.models}>{p.lines_n} 个型号 · 共 {qty(p.qty)} 片</span> : '') },
    { key: 'shipped_on', label: '发货日', w: 100, render: (p) => dDate(p.shipped_on) },
    { key: 'eta', label: '预计到', w: 130, render: (p) => <span className="row" style={{ gap: 4 }}>{dDate(p.eta)}{N(p.eta_changes) > 0 && <Pill tone="amber" title={`第一次定的 ${dDate(p.eta_first)}`}>延 {p.eta_changes} 次</Pill>}</span> },
    { key: 'stage', label: '物流进度', w: 150, value: (p) => stageOf(p)[0], render: (p) => <Pill tone={stageOf(p)[1]}>{stageOf(p)[0]}</Pill> },
    { key: 'forwarder', label: '物流公司', w: 110, value: (p) => [p.forwarder, MODE_L[p.mode]].filter(Boolean).join(' · ') },
    { key: 'tracking_no', label: '物流单号', w: 140, mono: true },
    { key: 'pickup', label: '提货单', w: 80, value: (p) => (p.has_pickup ? '有' : ''), render: (p) => (p.has_pickup ? <Pill tone="green">有</Pill> : p.arrived_on ? <Pill tone="red">缺</Pill> : '') },
    { key: 'qty', label: '采购数', w: 90, type: 'number', render: (p) => qty(p.qty) },
    { key: 'transit', label: '在途', w: 90, type: 'number', value: transitOf, render: (p) => (transitOf(p) > 0 ? <b>{qty(transitOf(p))}</b> : '') },
    { key: 'boxes', label: '箱（到 / 共）', w: 110, value: (p) => p.boxes_n, render: (p) => (p.boxes_n ? `${p.boxes_in} / ${p.boxes_n}` : <span className="muted small">没有箱单</span>) },
    { key: 'status', label: '状态', w: 140, value: (p) => poState(p)[0], render: (p) => <span className="row" style={{ gap: 4 }}><Pill tone={poState(p)[1]}>{poState(p)[0]}</Pill>{p.unmatched_n > 0 && <Pill tone="red">{p.unmatched_n} 行没对上编码</Pill>}</span> },
    { key: 'source', label: '来源', w: 90, value: (p) => SOURCE[p.source] || p.source },
    { key: 'kd', label: '金蝶状态', w: 170, value: (p) => kdState(p)[0], render: (p) => <Pill tone={kdState(p)[1]}>{kdState(p)[0]}</Pill> },
    { key: 'kd_no', label: '金蝶采购入库单号', w: 170, value: (p) => kdState(p)[2], render: (p) => <span className="mono small">{kdState(p)[2]}</span> },
  ];
  const filt = (p) => (f === 'transit' ? p.status !== 'closed' : f === 'done' ? p.status === 'closed' : f === 'fob' ? p.purpose === 'fob' : f === 'local' ? p.purpose !== 'fob' : true);
  const lineCols = [
    { key: 'po_no', label: '采购单号', w: 190, render: (l) => <PoLink id={l.po_id} no={l.po_no} /> },
    { key: 'purpose', label: '用途', w: 90, value: (l) => PURPOSE[l.purpose || 'unknown'][0], render: (l) => <Pill tone={PURPOSE[l.purpose || 'unknown'][1]}>{PURPOSE[l.purpose || 'unknown'][0]}</Pill> },
    { key: 'fob_no', label: 'FOB 项目 / 客户', w: 220, value: custText, render: (l) => <PoCust p={l} /> },
    { key: 'code', label: '编码', w: 90, mono: true, value: (l) => l.code || '' },
    { key: 'category', label: '种类', w: 110 },
    { key: 'model', label: '型号', w: 150, value: (l) => l.model || l.descr || '', render: (l) => (l.product_id ? <ModelLink id={l.product_id} model={l.model} /> : <span className="red-t2">{l.descr || l.model}（没对上编码）</span>) },
    { key: 'qty', label: '采购数', w: 90, type: 'number', render: (l) => qty(l.qty) },
    { key: 'received', label: '已到', w: 80, type: 'number', render: (l) => (N(l.received) ? qty(l.received) : '') },
    { key: 'transit', label: '在途', w: 80, type: 'number', value: (l) => (l.status === 'closed' ? 0 : transitOf(l)), render: (l) => (l.status !== 'closed' && transitOf(l) > 0 ? <b>{qty(transitOf(l))}</b> : '') },
    { key: 'closed', label: '没到（已关）', w: 100, type: 'number', render: (l) => (N(l.closed) ? qty(l.closed) : '') },
    { key: 'batch_name', label: '需求批次', w: 200 },
    { key: 'inbound', label: '入仓号', w: 120, value: (l) => (l.warehouse_nos || []).join(' / ') },
    { key: 'shipped_on', label: '发货日', w: 100, render: (l) => dDate(l.shipped_on) },
    { key: 'eta', label: '预计到', w: 100, render: (l) => dDate(l.eta) },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Commandes d’achat</div>
        <h1>采购单与到货 <Info>国内发了货才建采购单，没下推入库的部分一律算在途。到货时打开采购单，勾选到了哪些箱 → 下推采购入库单；少到的差额只有中方能关，必须选结果、传凭证。箱单 Excel 直接拖进来自动读。</Info></h1></div>
        <span className="grow" />
        {can(role, 'po_edit') && <button type="button" className="btn" onClick={() => setImp(true)}>⇪ 导入箱单</button>}
        {can(role, 'po_edit') && <button type="button" className="btn primary" onClick={() => setEdit({ purpose: 'local', lines: [] })}>＋ 新建采购单</button>}
      </div>
      <MetricStrip tag="本月" ids={['po.late']} from={periodRange('month')[0]} to={periodRange('month')[1]} />
      <div className="card">
        <div className="card-h" style={{ justifyContent: 'flex-end' }}><div className="seg"><button type="button" className={view === 'po' ? 'on' : ''} onClick={() => setView('po')}>按订单看</button><button type="button" className={view === 'line' ? 'on' : ''} onClick={() => setView('line')}>按明细看</button></div></div>
        {view === 'line' ? <Grid id="po-lines" columns={lineCols} rows={(detail || []).filter(filt)} empty={detail ? '没有明细' : '加载中…'}
          foot={(rs) => ({ po_no: `${rs.length} 行`, qty: qty(rs.reduce((a, l) => a + N(l.qty), 0)), received: qty(rs.reduce((a, l) => a + N(l.received), 0)), transit: qty(rs.reduce((a, l) => a + (l.status === 'closed' ? 0 : transitOf(l)), 0)) })}
          tools={<div className="chips">{[['transit', '在途 / 没到齐'], ['done', '已到齐'], ['local', '本地备货'], ['fob', 'FOB'], ['all', '全部']].map(([k, l]) => (
            <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} <b>{n(k)}</b></button>))}</div>} />
        : <Grid id="po-list" table="purchase_orders" columns={cols} rows={rows} empty="没有采购单"
          tools={<div className="chips">{[['transit', '在途 / 没到齐'], ['done', '已到齐'], ['local', '本地备货'], ['fob', 'FOB'], ['all', '全部']].map(([k, l]) => (
            <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} <b>{n(k)}</b></button>))}</div>} />}
      </div>
      {imp && <PackingImport onClose={() => setImp(false)} />}
      {edit && <PoForm init={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

// ───────────────────────── 采购单页 (抽屉) ─────────────────────────
export function PoDrawer({ id, onClose }) {
  const { org, role, toast, refresh, openArchive } = useApp();
  const [sel, setSel] = useState(new Set());
  const [recv, setRecv] = useState(false);
  const [gap, setGap] = useState(null);
  const [map, setMap] = useState(null);
  const [lineRecv, setLineRecv] = useState(false);
  const [info, setInfo] = useState(null);
  const [edit, setEdit] = useState(null);
  const { data } = useData(async () => {
    const [[po], lines, boxes, grns] = await Promise.all([
      q(`select p.*, f.fob_no from app.purchase_orders p left join app.fob_projects f on f.id = p.fob_project_id where p.id = $1`, [id]),
      q(`select l.*, pr.code, pr.model as pmodel, c.name as category from app.po_lines l left join app.products pr on pr.id = l.product_id left join app.categories c on c.id = pr.category_id where l.po_id = $1 order by l.qty desc`, [id]),
      q(`select b.*, coalesce(pr.model, l.descr, l.model) as model, pr.id as product_id from app.po_boxes b left join app.po_lines l on l.id = b.po_line_id left join app.products pr on pr.id = l.product_id where b.po_id = $1 order by b.box_no`, [id]),
      q(`select * from app.po_receipts where po_id = $1 order by created_at desc`, [id])]);
    const [docs, etaLog] = await Promise.all([
      q(`select id, kind, name, file, note, created_at from app.po_docs where po_id = $1 and not removed order by created_at desc`, [id]).catch(() => []),
      q(`select old_eta, new_eta, reason, created_at from app.po_eta_log where po_id = $1 order by created_at`, [id]).catch(() => [])]);
    return { po: { ...po, has_pickup: docs.some((d) => d.kind === 'pickup') }, lines, boxes, grns, docs, etaLog };
  }, [id, org]);
  if (!data?.po) return null;
  const { po, lines, boxes, grns, docs, etaLog } = data;
  const left = (l) => N(l.qty) - N(l.qty_received) - N(l.closed_qty);
  const transitBoxes = boxes.filter((b) => b.status === 'transit');
  const selBoxes = transitBoxes.filter((b) => sel.has(b.box_no));
  const selN = new Set(selBoxes.map((b) => b.box_no)).size;
  const lineCols = [
    { key: 'model', label: '型号', w: 160, value: (l) => l.pmodel || l.descr || l.model, render: (l) => (l.product_id ? <ModelLink id={l.product_id} model={l.pmodel} /> : <span className="row" style={{ gap: 4 }}>{l.descr || l.model}<Pill tone="red">没对上编码</Pill></span>) },
    { key: 'code', label: '编码', w: 100 },
    { key: 'category', label: '种类', w: 90 },
    { key: 'descr', label: '箱单写法', w: 200 },
    { key: 'qty', label: '采购数', w: 90, type: 'number', render: (l) => qty(l.qty) },
    { key: 'qty_received', label: '已入库', w: 90, type: 'number', render: (l) => qty(l.qty_received) },
    { key: 'left', label: '在途', w: 90, type: 'number', value: left, render: (l) => (left(l) > 0 ? <b>{qty(left(l))}</b> : '') },
    { key: 'closed_qty', label: '已关差额', w: 160, value: (l) => N(l.closed_qty), render: (l) => (N(l.closed_qty) ? <span className="row" style={{ gap: 4 }}>{qty(l.closed_qty)} <Pill tone="amber">{l.close_result}</Pill><Thumb src={l.close_proof} size={22} label="差额凭证" /></span> : '') },
    ...(role !== 'picker' ? [{ key: 'unit_price', label: '采购单价（参考）', w: 120, type: 'number', value: (l) => N(l.unit_price), render: (l) => (l.unit_price != null ? `${money(l.unit_price, l.currency)} ${l.currency}` : '') }] : []),
  ];
  // 一个箱号可能装了几种货 (拼箱): 按箱号合成一行, 勾一箱 = 这箱里所有货一起入
  const boxGroups = Object.values(boxes.reduce((a, b) => { const g = (a[b.box_no] = a[b.box_no] || { box_no: b.box_no, items: [], qty: 0, status: b.status }); g.items.push(b); g.qty += N(b.qty); if (b.status === 'transit') g.status = 'transit'; return a; }, {}));
  const boxCols = [
    { key: 'box_no', label: '箱号', w: 70, type: 'number' },
    { key: 'model', label: '箱里的货', w: 260, value: (g) => g.items.map((b) => `${b.model} ${b.qty}`).join(' + '), render: (g) => <span>{g.items.map((b, i) => <React.Fragment key={b.id}>{i > 0 && ' + '}{b.product_id ? <ModelLink id={b.product_id} model={b.model} /> : b.model} {qty(b.qty)}</React.Fragment>)}</span> },
    { key: 'qty', label: '片数', w: 90, type: 'number', render: (g) => qty(g.qty) },
    { key: 'status', label: '状态', w: 110, value: (g) => g.status, render: (g) => <Pill tone={g.status === 'received' ? 'green' : g.status === 'missing' ? 'red' : 'blue'}>{g.status === 'received' ? '已到' : g.status === 'missing' ? '没到（已关）' : '在途'}</Pill> },
  ];
  const grnCols = [
    { key: 'grn_no', label: '采购入库单', w: 150, render: (g) => <b className="mono">{g.grn_no}</b> },
    { key: 'created_at', label: '入库时间', w: 140, render: (g) => dt(g.created_at) },
    { key: 'lines', label: '入了什么', w: 280, value: (g) => (g.lines || []).map((x) => `${x.model} ${N(x.local_qty) + N(x.fob_qty)}${x.fob_qty ? '（FOB）' : ` → ${x.warehouse}`}`).join('，') },
    { key: 'photo', label: '照片', w: 60, sortable: false, render: (g) => <Thumb src={g.photo} size={26} label="入库照片" /> },
    { key: 'kd_status', label: '金蝶', w: 110, value: (g) => g.kd_status, render: (g) => <Pill tone={g.kd_status === 'synced' ? 'green' : g.kd_status === 'saved' ? 'blue' : 'amber'}>{g.kd_status === 'synced' ? '已审核' : g.kd_status === 'saved' ? `已录 ${g.kd_no || ''}` : '待录金蝶'}</Pill> },
  ];
  return (
    <Drawer title={<span className="row" style={{ gap: 8 }}>采购单 <span className="mono">{po.po_no}</span><Pill tone={PURPOSE[po.purpose || 'unknown'][1]}>{PURPOSE[po.purpose || 'unknown'][0]}</Pill>{po.fob_no && <Pill tone="amber">{po.fob_no}</Pill>}{!po.fob_no && po.purpose === 'fob' && (po.fob_customer_codes || []).length > 0 && <Pill tone="amber">{po.fob_customer_codes.join(',')}</Pill>}{role === 'admin' && <button type="button" className="btn sm soft" onClick={() => { try { localStorage.setItem('la9s.poProfit', po.po_no); } catch { /* */ } onClose(); window.location.hash = '#/poprofit'; }}>这单赚了多少 →</button>}</span>} onClose={onClose}>
      <DoneHost only={['grn']} />
      <div className="kv" style={{ marginBottom: 12 }}>
        <div><div className="k">需求批次</div><div className="v">{po.batch_name || '—'}</div></div>
        <div><div className="k">入仓号</div><div className="v mono">{(po.warehouse_nos || []).join(' / ') || '—'}</div></div>
        <div><div className="k">箱数 / 件数</div><div className="v">{po.boxes ?? boxes.length} 箱 · {qty(po.pcs ?? lines.reduce((a, l) => a + N(l.qty), 0))} 片</div></div>
        <div><div className="k">来源</div><div className="v">{SOURCE[po.source] || po.source}</div></div>
        {po.supplier && <div><div className="k">供应商</div><div className="v">{po.supplier}</div></div>}
        {po.note && <div><div className="k">备注</div><div className="v">{po.note}</div></div>}
      </div>
      {can(role, 'po_edit') && !lines.some((l) => N(l.qty_received) || N(l.closed_qty)) && po.source === 'system' && <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {<button type="button" className="btn sm ghost" onClick={() => setEdit({ id: po.id, mode: po.mode || 'sea', forwarder: po.forwarder || '', tracking_no: po.tracking_no || '', boxes: po.boxes ?? '', purpose: po.purpose, fob_project_id: po.fob_project_id || '', batch_name: po.batch_name || '', inbound_no: (po.warehouse_nos || [])[0] || '', shipped_on: dDate(po.shipped_on), eta: dDate(po.eta), supplier: po.supplier || '', lines: lines.map((l) => ({ product_id: l.product_id, descr: l.descr || l.pmodel || l.model, qty: l.qty, unit_price: l.unit_price ?? '' })) })}>改采购行</button>}
      </div>}
      <PoLogistics po={po} docs={docs} etaLog={etaLog} canEdit={can(role, 'po_edit')} onEdit={() => setInfo(true)} />
      <section className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>采购行</h2><Info>在途 = 采购数 − 已入库 − 已关差额。没对上编码的行不能入库：点中那一行 → 上方「对上编码」，挑一次系统就记住这种写法。</Info></div>
        <Grid id="po-lines" noTools rows={lines} columns={lineCols}
          rowActions={[
            ...(can(role, 'po_edit') ? [{ label: '对上编码', when: (l) => !l.product_id && N(l.qty_received) === 0, run: (l) => setMap(l) }] : []),
            ...(can(role, 'po_gap') ? [{ label: '关差额（少到）', tone: 'danger', when: (l) => left(l) > 0 && (N(l.qty_received) > 0 || po.status === 'open'), run: (l) => setGap(l) }] : []),
          ]} />
      </section>
      <section className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>箱号</h2><Pill tone="blue">{new Set(transitBoxes.map((b) => b.box_no)).size} 箱在途</Pill>
          <Info>货到了：勾选到了的箱 → 「到了选中的箱 → 下推入库」。没到的箱留着在途；确定不会到了，由中方在上面「关差额」。</Info>
          <span className="grow" />
          {can(role, 'receive_po') && <button type="button" className="btn sm primary" disabled={!selN} onClick={() => setRecv(true)}>到了选中的 {selN} 箱 → 下推入库</button>}</div>
        {boxes.length ? <Grid id="po-boxes" noTools rows={boxGroups} rowKey={(g) => g.box_no} columns={boxCols} selectable={can(role, 'receive_po') ? { selected: sel, onChange: (s) => setSel(new Set([...s].filter((x) => transitBoxes.some((b) => b.box_no === x)))) } : undefined} />
          : <div className="card-b row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="muted small">这张单没有箱单（老的金蝶采购单 / 国内还没导）。国内导入箱单后就能按箱收；急着收可以按行入库。</span>
              {can(role, 'receive_po') && po.status !== 'closed' && <button type="button" className="btn sm" onClick={() => setLineRecv(true)}>按行入库</button>}</div>}
      </section>
      <section className="card">
        <div className="card-h"><h2>采购入库单</h2><Info>每次到货下推一张，进金蝶「采购入库」待录（金蝶同步页 → 采购入库）。</Info></div>
        <Grid id="po-grns" noTools rows={grns} columns={grnCols} empty="还没有入库" />
      </section>
      {recv && <ReceiveModal po={po} boxes={selBoxes} onClose={() => setRecv(false)} onDone={() => { setRecv(false); setSel(new Set()); refresh(); }} />}
      {gap && <GapModal line={gap} left={left(gap)} onClose={() => setGap(null)} onDone={() => { setGap(null); refresh(); }} />}
      {lineRecv && <LineReceive po={{ ...po, lines: lines.map((l) => ({ id: l.id, product_id: l.product_id, model: l.pmodel || l.descr || l.model, category: l.category, qty: N(l.qty) - N(l.closed_qty), received: N(l.qty_received), fob_qty: l.fob_qty, fob_customer: l.fob_customer })) }} onClose={() => { setLineRecv(false); refresh(); }} />}
      {info && <LogiModal po={po} onClose={() => setInfo(null)} />}
      {edit && <PoForm init={edit} onClose={() => { setEdit(null); refresh(); }} />}
      {map && <MapModal line={map} onClose={() => setMap(null)} onDone={() => { setMap(null); refresh(); }} />}
    </Drawer>
  );
}

function ReceiveModal({ po, boxes, onClose, onDone }) {
  const { role, toast } = useApp();
  const [wh, setWh] = useState('LA'); const [photo, setPhoto] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const nBox = new Set(boxes.map((b) => b.box_no)).size;
  const byModel = Object.values(boxes.reduce((a, b) => { (a[b.model] = a[b.model] || { model: b.model, n: new Set(), pcs: 0 }); a[b.model].n.add(b.box_no); a[b.model].pcs += N(b.qty); return a; }, {}));
  const go = async () => {
    setBusy(true);
    try { await call(role, `select app.receive_boxes($1,$2,$3,$4,$5)`, [po.id, boxes.map((b) => b.id), wh, photo, note || null]); toast(`已下推采购入库单：${nBox} 箱进${po.purpose === 'fob' ? ' FOB 仓' : ` ${wh} 仓`}`); showDone({ kind: 'grn', po: po.id }); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`到货入库：${po.po_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={!photo || busy} onClick={go}>确认入库</button></>}>
      <div className="stack">
        <div className="hint">这次到了 {nBox} 箱：{byModel.map((m) => `${m.model} ${m.n.size} 箱 ${qty(m.pcs)} 片`).join('；')}。入库后这些数量变成即时库存，在途减少。</div>
        {po.purpose === 'fob' ? <div className="hint"><Pill tone="amber">FOB</Pill> FOB 的货只进 FOB 仓，不进本地可售。</div>
          : <div className="field"><label>进哪个仓（货权）</label><div className="chips">{['LA', '9S'].map((w) => <button type="button" key={w} className={`chip ${wh === w ? 'on' : ''}`} onClick={() => setWh(w)}>{w} 仓</button>)}</div></div>}
        <div className="field req"><label>到货照片（箱子 / 入仓单，必传）</label><PhotoInput value={photo} onChange={setPhoto} label="到货照片" /></div>
        <div className="field"><label>备注</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：外箱有一个压坏，里面数量对" /></div>
      </div>
    </Modal>
  );
}

function GapModal({ line, left, onClose, onDone }) {
  const { role, toast } = useApp();
  const [r, setR] = useState(''); const [proof, setProof] = useState(''); const [note, setNote] = useState('');
  const go = async () => { try { await call(role, `select app.close_po_gap($1,$2,$3,$4)`, [line.id, r, proof, note || null]); toast(`差额 ${left} 片已关：${r}`); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`关差额：${line.pmodel || line.descr} 还差 ${qty(left)} 片`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn danger" disabled={!r || !proof || (r === '其他' && !note.trim())} onClick={go}>确认关掉这 {qty(left)} 片</button></>}>
      <div className="stack">
        <div className="hint">关掉以后这 {qty(left)} 片不再算在途，备货看板也不再等它。只有中方能关；必须选结果、传凭证（国内确认的截图 / 破损照片…）。</div>
        <div className="field req"><label>结果</label><OptChoice optKey="po_gap_results" title="差额结果" coded={false} value={r} onChange={setR} options={GAP_RESULTS} /></div>
        <div className="field req"><label>凭证</label><PhotoInput value={proof} onChange={setProof} label="凭证" /></div>
        <div className="field"><label>说明{r === '其他' ? '（选「其他」必填）' : ''}</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

function MapModal({ line, onClose, onDone }) {
  const { org, role, toast } = useApp();
  const [qs, setQs] = useState(String(line.descr || line.model || '').split(/[\s/]/)[0] || '');
  const { data } = useData(() => q(`select p.id, p.code, p.model, c.name as category, p.shared_models from app.products p join app.categories c on c.id = p.category_id
    where p.org_id = $1 and p.active and (p.model ilike $2 or p.code ilike $2 or array_to_string(p.shared_models, ' ') ilike $2) order by p.model limit 40`, [org, `%${qs.trim()}%`]), [org, qs]);
  const pick = async (p) => { try { const n = (await call(role, `select app.map_descr($1,$2,$3) as n`, [org, line.descr || line.model, p.id]))[0].n; toast(`已对上 ${p.model}（${p.code}），以后这种写法自动对上；补上 ${n} 行`); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`对上编码：${line.descr || line.model}`} onClose={onClose}>
      <div className="stack">
        <input className="in" autoFocus value={qs} onChange={(e) => setQs(e.target.value)} placeholder="搜型号 / 编码 / 通用型号" />
        <Grid id="po-map" noTools rows={data || []} empty="没找到，换个词" onRowClick={pick} rowActions={[{ label: '就是这个，对上', run: pick }]} columns={[
          { key: 'code', label: '编码', w: 100 }, { key: 'category', label: '种类', w: 100 }, { key: 'model', label: '型号', w: 120, render: (p) => <b>{p.model}</b> },
          { key: 'shared', label: '通用型号', w: 220, value: (p) => (p.shared_models || []).join(' / ') }]} />
        <div className="small muted">点中一行 → 上方「就是这个，对上」。</div>
      </div>
    </Modal>
  );
}

// ───────────────────────── 新建 / 改采购单 (系统建单, 国内用) ─────────────────────────
export function PoForm({ init, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ purpose: 'local', batch_name: '', inbound_no: '', shipped_on: today(), eta: '', supplier: '', fob_project_id: '', request_id: '', mode: 'sea', forwarder: '', tracking_no: '', boxes: '', ...init });
  const [lines, setLines] = useState(() => [...(init.lines || []), ...Array.from({ length: Math.max(0, 5 - (init.lines || []).length) }, () => ({ descr: '', qty: '', unit_price: '' }))]);
  const { data: fobs } = useData(() => q(`select f.id, f.fob_no from app.fob_projects f where f.org_id = $1 and f.status not in ('closed','cancelled') order by f.fob_no`, [org]), [org]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setL = (i, k, v) => setLines((ls) => { const n = [...ls]; n[i] = { ...n[i], [k]: v, ...(k === 'descr' ? { product_id: null } : {}) }; if (i === n.length - 1 && String(v).trim()) n.push({ descr: '', qty: '', unit_price: '' }); return n; });
  const real = lines.filter((l) => String(l.descr || l.product_id || '').trim() && N(l.qty) > 0);
  const save = async () => {
    try {
      const [{ id: poId }] = await call(role, `select app.save_po($1,$2,$3,$4) as id`, [org, init.id || null, JSON.stringify(f), JSON.stringify(real.map((l) => ({ product_id: l.product_id || null, descr: l.descr, qty: N(l.qty), unit_price: l.unit_price === '' ? null : N(l.unit_price), currency: 'CNY' })))]);
      // 0106: 物流信息各进各的格子 (不再写进备注)
      await call(role, `select app.set_po_info2($1,$2)`, [poId || init.id, JSON.stringify({ mode: f.mode, forwarder: f.forwarder, tracking_no: f.tracking_no, boxes: f.boxes, warehouse_nos: f.inbound_no, batch_name: f.batch_name, shipped_on: f.shipped_on, ...(f.eta ? { eta: f.eta, eta_reason: init.id ? '改采购单' : '' } : {}) })]);
      toast('采购单已保存，算在途'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={init.id ? '改采购单' : '新建采购单'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><span className="small muted">{real.length} 行 · {qty(real.reduce((a, l) => a + N(l.qty), 0))} 片</span><button type="button" className="btn primary" disabled={!real.length || (f.purpose === 'fob' && !f.fob_project_id && !String(f.fob_customer || '').trim()) || !f.batch_name.trim() || !f.inbound_no.trim() || !f.forwarder || !f.mode || String(f.boxes || '') === '' || !f.shipped_on} title={!real.length ? '还差：至少一行型号和数量' : ''} onClick={save}>保存（算在途）</button></>}>
      <div className="stack">
        <div className="hint">国内发了货再建单：保存后这些货就算在途，本地看得到什么时候到。单价以国内实际录入为准。{init.request_id ? ' 这张单来自本地的物料申请，保存后申请自动变成「国内已下单」。' : ''}</div>
        <div className="rgrid">
          <div className="field req"><label>用途</label><Choice value={f.purpose} onChange={(k) => set('purpose', k)} options={[['local', '本地备货'], ['fob', 'FOB']]} /></div>
          {f.purpose === 'fob' && <div className="field"><label>FOB 项目（系统里有就选）</label><Choice value={f.fob_project_id} onChange={(v) => set('fob_project_id', v)} options={(fobs || []).map((x) => [x.id, x.fob_no])} empty="— 不挂项目 —" flat={false} /></div>}
          {f.purpose === 'fob' && !f.fob_project_id && <div className="field req"><label>FOB 客户（例 LA9S-KABRE）</label><input className="in" value={f.fob_customer || ''} onChange={(e) => set('fob_customer', e.target.value.toUpperCase())} /></div>}
          <div className="field req"><label>需求批次（例 20260715-KABRE海运-3批）</label><input className="in" value={f.batch_name} onChange={(e) => set('batch_name', e.target.value)} /></div>
          <div className="field req" style={{ gridColumn: '1 / -1' }}><label>入仓号（货代给的）</label><InboundInput value={String(f.inbound_no || '').split(/[\s/,;，；]+/).filter(Boolean)} onChange={(v) => set('inbound_no', v.join(' / '))} forwarder={f.forwarder} /></div>
          <div className="field req"><label>运输方式</label><OptChoice optKey="po_mode" title="运输方式" value={f.mode} onChange={(v) => set('mode', v)} options={[['sea', '海运'], ['air', '空运'], ['other', '其他']]} /></div>
          <div className="field req"><label>物流公司</label><OptChoice optKey="po_forwarder" title="物流公司" value={f.forwarder} onChange={(v) => set('forwarder', v)} options={[['赛时', '赛时'], ['捷道', '捷道'], ['古月', '古月'], ['速鹰', '速鹰'], ['利信达', '利信达']]} placeholder="选物流公司…" /></div>
          <div className="field req"><label>箱数</label><input className="in" inputMode="numeric" value={f.boxes} onChange={(e) => set('boxes', e.target.value.replace(/\D/g, ''))} /></div>
          <div className="field"><label>物流单号 / 提单号</label><input className="in mono" value={f.tracking_no} onChange={(e) => set('tracking_no', e.target.value.toUpperCase())} /></div>
          <div className="field half req"><label>发货日</label><DatePicker value={f.shipped_on} onChange={(v) => set('shipped_on', v)} /></div>
          <div className="field half"><label>预计到货（不填 = 发货日 + 2 个半月）</label><DatePicker value={f.eta} onChange={(v) => set('eta', v)} /></div>
          <div className="field"><label>供应商</label><input className="in" value={f.supplier} onChange={(e) => set('supplier', e.target.value)} /></div>
        </div>
        <Grid id="po-form-lines" noTools rows={lines.map((l, i) => ({ ...l, _i: i }))} rowKey={(l) => l._i} columns={[
          { key: 'descr', label: '型号（写法 / 编码）', w: 280, edit: (l) => ({ type: 'text', value: l.descr || '', onChange: (v) => setL(l._i, 'descr', v) }) },
          { key: 'qty', label: '数量', w: 110, type: 'number', edit: (l) => ({ type: 'number', value: l.qty, onChange: (v) => setL(l._i, 'qty', v) }) },
          { key: 'unit_price', label: '单价 CNY（参考）', w: 140, type: 'number', edit: (l) => ({ type: 'number', value: l.unit_price, onChange: (v) => setL(l._i, 'unit_price', v) }) }]} />
        <div className="small muted">型号写法和箱单上一样就行（例 BG6M LCD COMP）。对得上编码的自动对上，对不上的到货前在采购单里「对上编码」挑一次。</div>
      </div>
    </Modal>
  );
}

// ───────────────────────── 箱单 Excel 导入 ─────────────────────────
export function PackingImport({ onClose }) {
  const { org, role, toast, refresh, openArchive } = useApp();
  const [p, setP] = useState(null); const [busy, setBusy] = useState(false);
  const { data: fobs } = useData(() => q(`select f.id, f.fob_no, c.name from app.fob_projects f join app.customers c on c.id = f.customer_id where f.org_id = $1 and f.status not in ('closed','cancelled') order by f.fob_no`, [org]), [org]);
  const read = async (file) => {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const r = parsePackingBook(wb, XLSX, file.name);
      const guessFob = /FOB/i.test(r.batch_name) || (r.fwdCustomer && /LA-?9S-\w+/i.test(r.fwdCustomer) && !/LA-?9S-?LA|9S$/i.test(r.fwdCustomer))
        || (fobs || []).some((x) => x.name && new RegExp(x.name.split(/\s+/)[0], 'i').test(r.batch_name || ''));
      const fob = (fobs || []).find((x) => x.name && new RegExp(x.name.split(/\s+/)[0], 'i').test(`${r.batch_name} ${r.fwdCustomer || ''}`));
      setP({ ...r, file: file.name, purpose: guessFob ? 'fob' : 'local', fob_project_id: fob?.id || '' });
    } catch (e) { toast(`读不了这个文件：${e.message}`, 'err'); }
  };
  const go = async () => {
    setBusy(true);
    try {
      const res = (await call(role, `select app.import_packing_list($1,$2) as r`, [org, JSON.stringify({ batch_name: p.batch_name, date: p.date, inbound_no: p.inbound_no, purpose: p.purpose, fob_project_id: p.fob_project_id || null, fob_customer: p.purpose === 'fob' ? String(p.fwdCustomer || '').trim() : null, lines: p.lines, boxes: p.boxes })]))[0].r;
      toast(`已导入：${p.lines.length} 行 · ${res.boxes} 箱${res.unmatched.length ? `；${res.unmatched.length} 种写法没对上编码，进采购单「对上编码」` : ''}`);
      refresh(); onClose(); openArchive({ kind: 'po', id: res.po_id });
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal wide title="导入箱单" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{p && <button type="button" className="btn primary" disabled={busy || !p.lines.length || (p.purpose === 'fob' && !p.fob_project_id && !String(p.fwdCustomer || '').trim())} onClick={go}>确认导入（算在途）</button>}</>}>
      <div className="stack">
        {!p && <FileDrop accept=".xls,.xlsx" label="把箱单 Excel（.xls / .xlsx）拖进来，或点这里选" hint="飞书「98.箱单 › 科特」里那种：有 导出数据 / 装箱单 / 价格单 / 装箱清单 几个页签的" onFiles={(fs) => fs[0] && read(fs[0])} />}
        {p && <>
          <div className="small muted">{p.file}</div>
          {p.warnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
          <div className="rgrid">
            <div className="field"><label>需求批次</label><input className="in" value={p.batch_name} onChange={(e) => setP({ ...p, batch_name: e.target.value })} /></div>
            <div className="field"><label>入仓号</label><input className="in" value={p.inbound_no} onChange={(e) => setP({ ...p, inbound_no: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label>发货日</label><DatePicker value={p.date} onChange={(v) => setP({ ...p, date: v })} /></div>
            <div className="field req"><label>用途（系统猜的，请确认）</label><Choice value={p.purpose} onChange={(k) => setP({ ...p, purpose: k })} options={[['local', '本地备货'], ['fob', 'FOB']]} /></div>
            {p.purpose === 'fob' && <div className="field"><label>FOB 项目（系统里有就选）</label><Choice value={p.fob_project_id} onChange={(v) => setP({ ...p, fob_project_id: v })} options={(fobs || []).map((x) => [x.id, `${x.fob_no}${role === 'cn_support' ? '' : ` · ${x.name}`}`])} empty="— 不挂项目 —" flat={false} /></div>}
            {p.purpose === 'fob' && !p.fob_project_id && <div className="field req"><label>FOB 客户（箱单上的，例 LA9S-KABRE）</label><input className="in" value={p.fwdCustomer || ''} onChange={(e) => setP({ ...p, fwdCustomer: e.target.value.toUpperCase() })} /></div>}
          </div>
          <Grid id="pl-lines" noTools rows={p.lines} rowKey={(l) => l.descr} columns={[
            { key: 'descr', label: '型号（箱单写法）', w: 260 }, { key: 'code', label: '金蝶料号', w: 110 },
            { key: 'qty', label: '数量', w: 90, type: 'number', render: (l) => qty(l.qty) },
            { key: 'unit_price', label: '单价 CNY', w: 90, type: 'number' },
            { key: 'boxes', label: '箱号', w: 160, value: (l) => p.boxes.filter((b) => b.descr === l.descr).map((b) => b.box_no).join(', ') }]} />
          <div className="small muted">共 {p.lines.length} 行 · {qty(p.lines.reduce((a, l) => a + l.qty, 0))} 片 · {new Set(p.boxes.map((b) => b.box_no)).size} 箱。同一个需求批次 / 入仓号再导一次 = 覆盖（还没到货的才行）。</div>
        </>}
      </div>
    </Modal>
  );
}

// ───────────────────────── 采购 / 到货待办 (国内、仓库主管、中方) ─────────────────────────
// Frank 11-13: 「他只要看到他的待办事项，就知道他这一天就需要干些什么活」—— 每条写清楚做什么、哪张单, 点了直接去做.
export function fromRequest(r, lines) {
  return { purpose: r.kind === 'fob' ? 'fob' : 'local', fob_project_id: r.fob_project_id || '', request_id: r.id, batch_name: '', eta: r.eta || '',
    lines: lines.map((l) => ({ product_id: l.product_id, descr: l.code ? `${l.code}` : l.item, qty: l.qty, unit_price: '' })) };
}
export function PurchaseTodo() {
  const { org, role, openArchive, go, tick } = useApp();
  const [form, setForm] = useState(null); const [openG, setOpenG] = useState(null);
  const { data } = useData(async () => {
    const [pos, reqs] = await Promise.all([q(poListSql, [org]),
      q(`select r.*, (select coalesce(json_agg(json_build_object('product_id', l.product_id, 'item', l.item, 'qty', l.qty, 'code', p.code)), '[]') from app.purchase_request_lines l left join app.products p on p.id = l.product_id where l.request_id = r.id) as lines
         from app.purchase_requests r where r.org_id = $1 and r.status = 'submitted' and r.kind in ('stock','fob') order by r.need_by nulls last, r.created_at`, [org])]);
    return { pos, reqs };
  }, [org, tick]);
  if (!data) return null;
  const td = today(); const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const open = data.pos.filter((p) => p.status !== 'closed');
  const T = [];   // [谁, 紧急?, 做什么, 单子们, 点了干嘛]
  const cn = role === 'cn_support' || role === 'admin', wh = role === 'manager' || role === 'admin';
  if (cn) data.reqs.forEach((r) => T.push({ g: 'req',  red: r.need_by && dDate(r.need_by) <= in3, what: `本地申请 ${r.req_no}「${r.title}」等国内下单${r.need_by ? `（要在 ${dDate(r.need_by)} 前到）` : ''}`, btn: '建采购单', run: () => setForm(fromRequest(r, r.lines || [])) }));
  if (cn) open.filter((p) => !p.boxes_n).forEach((p) => T.push({ g: 'info',  what: `${p.po_no} 还没有箱单：发货后把箱单 Excel 导进来，本地才知道每箱是什么`, po: p }));
  if (cn) open.filter((p) => !p.eta).forEach((p) => T.push({ g: 'info',  what: `${p.po_no} 没填预计到货日：问货代后填上`, po: p }));
  if (cn || wh) open.filter((p) => p.unmatched_n > 0).forEach((p) => T.push({ g: 'code',  red: p.eta && dDate(p.eta) <= in3, what: `${p.po_no} 有 ${p.unmatched_n} 行没对上系统编码：到货前必须对上，不然不能入库`, po: p }));
  if (cn) open.filter((p) => p.eta && dDate(p.eta) < td && N(p.received) === 0 && !p.arrived_on).forEach((p) => T.push({ g: 'late',  red: true, what: `${p.po_no} 预计 ${dDate(p.eta)} 到，过了还没到：跟货代确认，在「改物流信息」里填新日期 + 原因${N(p.eta_changes) ? `（已经延了 ${p.eta_changes} 次）` : ''}`, po: p }));
  // 0106: 到期前 7 天提醒确认; 到港 / 清关完了还没有提货单 → 国内每天补
  const in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  if (cn) open.filter((p) => p.eta && dDate(p.eta) >= td && dDate(p.eta) <= in7 && !p.arrived_on && N(p.received) === 0).forEach((p) => T.push({ g: 'soon',  what: `${p.po_no} 预计 ${dDate(p.eta)} 到（7 天内）：跟货代确认船期，变了就改日期`, po: p }));
  if (cn || role === 'admin') open.filter((p) => (p.arrived_on || p.cleared_on) && !p.has_pickup && N(p.received) === 0).forEach((p) => T.push({ g: 'pickup',  red: true, what: `${p.po_no} ${p.cleared_on ? '清关完了' : '到港了'}，还没有提货单：拿到 PDF 马上传到采购单「文件」里`, po: p }));
  if (cn) open.filter((p) => p.shipped_on && !p.forwarder).forEach((p) => T.push({ g: 'info',  what: `${p.po_no} 发货了没填物流公司：在「改物流信息」里补上`, po: p }));
  if (wh) open.filter((p) => p.eta && dDate(p.eta) <= in3 && p.boxes_n > p.boxes_in).forEach((p) => T.push({ g: 'due',  red: dDate(p.eta) <= td, what: `${p.po_no} ${dDate(p.eta) <= td ? '应该到了' : `${dDate(p.eta)} 到`}（${p.boxes_n - p.boxes_in} 箱）：货到当天勾箱、拍照、下推入库`, po: p }));
  if (role === 'admin') open.filter((p) => N(p.received) > 0 && p.boxes_n > 0 && p.boxes_in === p.boxes_n && transitOf(p) > 0).forEach((p) => T.push({ g: 'gap',  red: true, what: `${p.po_no} 箱都到了还差 ${qty(transitOf(p))} 片：选结果 + 传凭证关差额`, po: p }));
  if (!T.length && role !== 'cn_support') return null;
  T.sort((a, b) => (b.red ? 1 : 0) - (a.red ? 1 : 0));
  // 311 (Frank 11-14 / 11-17 再强调): 看板 / 待办看总数, 不看明细 —— 一类事一个数字块, 点开才列出来
  const GROUPS = [['pickup', '缺提货单'], ['due', '该到货 / 快到'], ['late', '过期没到'], ['soon', '7 天内到'], ['code', '编码没对上'], ['info', '资料不全'], ['gap', '差额待关'], ['req', '本地申请等下单']];
  const blocks = GROUPS.map(([g, label]) => { const rows = T.filter((x) => x.g === g); return { g, label, rows, red: rows.some((x) => x.red) }; }).filter((b) => b.rows.length);
  const cur = blocks.find((b) => b.g === openG);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>采购与到货</h2>{T.length ? <Pill tone={T.some((x) => x.red) ? 'red' : 'amber'}>{T.length} 件</Pill> : <Pill tone="green">都做完了</Pill>}
        <Info>这里只看总数。点一个数字块才列出是哪几张单，再点一条直接打开那张单。做法见「SOP」→ 采购与到货。</Info><span className="grow" />
        <button type="button" className="btn sm ghost" onClick={() => go('po')}>全部采购单 ›</button></div>
      {blocks.length ? <div className="numblocks">
        {blocks.map((b) => (
          <button type="button" key={b.g} className={`numblock ${b.red ? 'red' : 'amber'} ${openG === b.g ? 'on' : ''}`} aria-expanded={openG === b.g} onClick={() => setOpenG(openG === b.g ? null : b.g)}>
            <b>{b.rows.length}</b><span>{b.label}</span>
          </button>))}
      </div> : <div className="card-b small muted">今天没有要做的采购事项。</div>}
      {cur && cur.rows.map((x, i) => (
        <div key={i} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }} onClick={() => (x.run ? x.run() : openArchive({ kind: 'po', id: x.po.id }))}>
          <span className={`age ${x.red ? 'red' : 'amber'}`}>{x.red ? '紧急' : '今天'}</span>
          <span className="small">{x.what}</span>
          {x.btn ? <button type="button" className="btn sm primary" onClick={(e) => { e.stopPropagation(); x.run(); }}>{x.btn}</button> : <span className="muted">›</span>}
        </div>))}
      {form && <PoForm init={form} onClose={() => setForm(null)} />}
    </div>
  );
}

// ───────────────────────── 0106 物流全程 + 文件 (Frank 11-27) ─────────────────────────
export const DOC_KINDS = [['packing', '装箱单'], ['invoice', '发票'], ['bl', '提单 / 电放'], ['pickup', '提货单'], ['customs', '海关文件'], ['other', '其他']];
const STEPS = [['shipped_on', '发货'], ['arrived_on', '到港'], ['cleared_on', '清关完'], ['pickup', '提货单'], ['picked_on', '已提货'], ['in', '入库']];
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
const dataToFile = async (d) => { const b = await (await fetch(d.file)).blob(); return new File([b], d.name || `${d.kind}.pdf`, { type: b.type }); };

function PoLogistics({ po, docs, etaLog, canEdit, onEdit }) {
  const { role, toast, refresh } = useApp();
  const [kind, setKind] = useState('pickup');
  const [busy, setBusy] = useState(false);
  const canDoc = hasAny(role, ['admin', 'manager', 'cn_support']);
  const done = (k) => (k === 'pickup' ? po.has_pickup : k === 'in' ? po.status === 'closed' : !!po[k]);
  const upload = async (files) => {
    setBusy(true);
    try { for (const f of files) await call(role, `select app.add_po_doc($1,$2,$3,$4)`, [po.id, kind, f.name, await readFile(f)]); toast(`已上传 ${files.length} 个文件`); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const share = async (d) => {   // 手机: 直接调起分享 (WhatsApp 等); 电脑: 下载
    try { const f = await dataToFile(d); if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: `${po.po_no} ${d.name || ''}` }); return; } } catch { /* 取消分享 */ }
    const a = document.createElement('a'); a.href = d.file; a.download = d.name || `${po.po_no}-${d.kind}`; a.click();
  };
  const kindL = (k) => (DOC_KINDS.find((x) => x[0] === k) || [k, k])[1];
  const late = po.eta && !po.arrived_on && dDate(po.eta) < today();
  return (
    <section className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>物流</h2>
        <Info>国内发货后填物流公司、单号；到港、清关完、提货各记一天。提货单（PDF）一拿到就传在下面「文件」里，没有提货单不能标「已提货」。预计到货没填时按发货日 + 2 个半月；改日期要写原因，每次都留记录。</Info>
        <span className="grow" />{canEdit && <button type="button" className="btn sm" onClick={onEdit}>改物流信息</button>}</div>
      <div className="card-b stack" style={{ gap: 12 }}>
        <div className="flowline">{STEPS.map(([k, l], i) => <span key={k} className={`fl ${done(k) ? 'done' : ''}`}>{done(k) ? '✓ ' : `${i + 1} `}{l}{k !== 'pickup' && k !== 'in' && po[k] ? ` ${dDate(po[k]).slice(5)}` : ''}</span>)}</div>
        <div className="kv">
          <div><div className="k">预计到货</div><div className="v">{dDate(po.eta) || '—'} {late && <Pill tone="red">过了还没到</Pill>} {N(po.eta_changes) > 0 && <Pill tone="amber">延 {po.eta_changes} 次</Pill>}</div></div>
          <div><div className="k">物流公司 · 方式</div><div className="v">{[po.forwarder, MODE_L[po.mode]].filter(Boolean).join(' · ') || <span className="red-t2">没填</span>}</div></div>
          <div><div className="k">物流单号 / 提单号</div><div className="v mono">{po.tracking_no || '—'}</div></div>
          <div><div className="k">柜号</div><div className="v mono">{po.container_no || '—'}</div></div>
          <div><div className="k">重量 / 体积</div><div className="v">{po.weight_vol || '—'}</div></div>
          <div><div className="k">预估物流费</div><div className="v">{po.freight_none ? '无物流费' : po.freight_est ? money(po.freight_est, 'CNY') : '—'}</div></div>
        </div>
        {etaLog.length > 0 && <div className="small"><b>延误记录</b>{etaLog.map((e, i) => <div key={i} className="muted">{dt(e.created_at).slice(0, 10)}：{dDate(e.old_eta)} → <b>{dDate(e.new_eta)}</b>（{e.reason}）</div>)}
          {po.eta_first && <div className="muted">第一次定的是 {dDate(po.eta_first)}，现在晚了 {Math.round((new Date(po.eta) - new Date(po.eta_first)) / 864e5)} 天</div>}</div>}
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}><b>文件</b>{po.arrived_on && !po.has_pickup && <Pill tone="red">到港了，还没有提货单</Pill>}</div>
          {docs.length ? <div className="stack" style={{ gap: 4 }}>{docs.map((d) => (
            <div key={d.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Pill tone={d.kind === 'pickup' ? 'green' : 'blue'}>{kindL(d.kind)}</Pill>
              <a className="linkbtn" href={d.file} download={d.name || undefined}>{d.name || '文件'}</a>
              <span className="small muted">{dt(d.created_at)}</span><span className="grow" />
              <button type="button" className="btn sm" onClick={() => share(d)}>发出去</button>
              {canDoc && <ConfirmBtn className="btn sm ghost" title="删掉这个文件？" body={`${kindL(d.kind)}「${d.name || ''}」从采购单上拿掉（留在操作记录里）。`} okText="删掉" onOk={async () => { try { await call(role, `select app.remove_po_doc($1)`, [d.id]); toast('已删'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }}>删</ConfirmBtn>}
            </div>))}</div> : <div className="small muted">还没有文件</div>}
          {canDoc && <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <OptChoice optKey="po_doc_kind" title="文件类型" value={kind} onChange={setKind} options={DOC_KINDS} />
            <FileDrop compact multiple accept=".pdf,image/*,.xls,.xlsx,.doc,.docx" label={busy ? '上传中…' : '把文件拖到这里，或点这里选（PDF / 图片 / Excel）'} onFiles={upload} style={{ flex: 1, minWidth: 220 }} />
          </div>}
        </div>
      </div>
    </section>
  );
}

function LogiModal({ po, onClose }) {
  const { role, toast, refresh } = useApp();
  const init = { mode: po.mode || 'sea', forwarder: po.forwarder || '', tracking_no: po.tracking_no || '', container_no: po.container_no || '', weight_vol: po.weight_vol || '',
    freight_est: po.freight_est ?? '', freight_none: !!po.freight_none, batch_name: po.batch_name || '', warehouse_nos: [...(po.warehouse_nos || [])], boxes: po.boxes ?? '', pcs: po.pcs ?? '',
    shipped_on: dDate(po.shipped_on), eta: dDate(po.eta), eta_reason: '', arrived_on: dDate(po.arrived_on), cleared_on: dDate(po.cleared_on), picked_on: dDate(po.picked_on), supplier: po.supplier || '', note: po.note || '' };
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const etaChanged = po.eta && f.eta !== dDate(po.eta);
  const ok = f.mode && f.forwarder.trim() && f.shipped_on && f.warehouse_nos.length > 0 && String(f.boxes) !== '' && (!etaChanged || f.eta_reason.trim()) && (!f.picked_on || po.has_pickup);
  const save = async () => {
    setBusy(true);
    try {
      const p = Object.fromEntries(Object.entries(f).filter(([k, v]) => k === 'eta_reason' || (k === 'warehouse_nos' ? v.join('/') !== init[k].join('/') : v !== init[k])));
      if (p.warehouse_nos) p.warehouse_nos = p.warehouse_nos.join(' / ');
      if (!etaChanged) delete p.eta_reason; if (!('eta' in p)) delete p.eta_reason;
      await call(role, `select app.set_po_info2($1,$2)`, [po.id, JSON.stringify(p)]);
      toast('已保存'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={`物流信息：${po.po_no}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={busy || !ok} title={f.picked_on && !po.has_pickup ? '还差：先在「文件」里传提货单' : ''} onClick={save}>保存</button></>}>
      <div className="rgrid">
        <div className="rsec">发货</div>
        <div className="field req"><label>运输方式</label><OptChoice optKey="po_mode" title="运输方式" value={f.mode} onChange={(v) => set('mode', v)} options={[['sea', '海运'], ['air', '空运'], ['other', '其他']]} /></div>
        <div className="field req"><label>物流公司</label><OptChoice optKey="po_forwarder" title="物流公司" value={f.forwarder} onChange={(v) => set('forwarder', v)} options={[['赛时', '赛时'], ['捷道', '捷道'], ['古月', '古月'], ['速鹰', '速鹰'], ['利信达', '利信达']]} placeholder="选物流公司…" /></div>
        <div className="field half req"><label>发货日</label><DatePicker value={f.shipped_on} onChange={(v) => set('shipped_on', v)} /></div>
        <div className="field half"><label>预计到货{!po.eta && f.shipped_on && !f.eta ? '（不填 = 发货日 + 2 个半月）' : ''}</label><DatePicker value={f.eta} onChange={(v) => set('eta', v)} /></div>
        {etaChanged && <div className="field req" style={{ gridColumn: '1 / -1' }}><label>为什么改预计到货</label><OptNote optKey="po_eta_reason" value={f.eta_reason} onChange={(v) => set('eta_reason', v)} options={['船晚开', '中转慢', '清关慢', '国内晚发', '货代没给准信']} placeholder="例：船晚开 5 天" /></div>}
        <div className="field req" style={{ gridColumn: '1 / -1' }}><label>入仓号</label><InboundInput value={f.warehouse_nos} onChange={(v) => set('warehouse_nos', v)} forwarder={f.forwarder} /></div>
        <div className="field half req"><label>箱数</label><input className="in" inputMode="numeric" value={f.boxes} onChange={(e) => set('boxes', e.target.value.replace(/\D/g, ''))} /></div>
        <div className="field half"><label>件数（片）</label><input className="in" inputMode="numeric" value={f.pcs} onChange={(e) => set('pcs', e.target.value.replace(/\D/g, ''))} /></div>
        <div className="rsec">单号与费用</div>
        <div className="field"><label>物流单号 / 提单号</label><input className="in mono" value={f.tracking_no} onChange={(e) => set('tracking_no', e.target.value.toUpperCase())} placeholder="MSKU1234567" /></div>
        <div className="field"><label>需求批次</label><input className="in" value={f.batch_name} onChange={(e) => set('batch_name', e.target.value)} placeholder="20261123-KABRE海运-1" /></div>
        <div className="field half"><label>柜号（+ 封条号）</label><input className="in mono" value={f.container_no} onChange={(e) => set('container_no', e.target.value.toUpperCase())} /></div>
        <div className="field half"><label>重量 / 体积</label><input className="in" value={f.weight_vol} onChange={(e) => set('weight_vol', e.target.value)} placeholder="820kg · 6.2方" /></div>
        <div className="field"><label>预估物流费 CNY</label><div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><input className="in" style={{ flex: 1, minWidth: 0 }} inputMode="decimal" disabled={f.freight_none} value={f.freight_none ? '' : f.freight_est} onChange={(e) => set('freight_est', e.target.value.replace(/[^\d.]/g, ''))} />
          <label className="row small" style={{ gap: 4, whiteSpace: 'nowrap' }}><input type="checkbox" checked={f.freight_none} onChange={(e) => set('freight_none', e.target.checked)} />无物流费</label></div></div>
        <div className="field"><label>供应商</label><input className="in" value={f.supplier} onChange={(e) => set('supplier', e.target.value)} /></div>
        <div className="rsec">到货进度 <span className="muted small">到了哪步填哪步</span></div>
        <div className="r3">
          <div className="field"><label>到港</label><DatePicker value={f.arrived_on} onChange={(v) => set('arrived_on', v)} /></div>
          <div className="field"><label>清关完</label><DatePicker value={f.cleared_on} onChange={(v) => set('cleared_on', v)} /></div>
          <div className="field"><label>已提货{!po.has_pickup ? '（要先传提货单）' : ''}</label><DatePicker value={f.picked_on} onChange={(v) => set('picked_on', v)} /></div>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>备注（只写说明，单号都有自己的格子）</label><input className="in" value={f.note} onChange={(e) => set('note', e.target.value)} /></div>
      </div>
    </Modal>
  );
}
