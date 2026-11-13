// 采购单与到货 (Frank 2026-11-13, 待改 299 / 302) —— 国内初略版
// 规矩: 采购单分「本地备货」「FOB」(一张单只有一种); 国内发了货才有采购单 → 没下推入库的部分一律算在途;
// 到货时按箱勾「到了哪些箱」→ 一次下推一张采购入库单 (本地进 LA / 9S, FOB 进 FOB 仓); 少到的差额只有中方能关, 必须选结果 + 传凭证.
// 箱单 (飞书「98.箱单 › 科特」里那种 Excel) 直接拖进来: 按内容认页签 (页签名字不可靠), 读需求批次 / 入仓号 / 每箱型号数量 / 单价 / 金蝶料号.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Pill, Modal, Info, PhotoInput, FileDrop, Drawer, Thumb, DatePicker } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ModelLink } from '../components/Archives.jsx';
import { can } from '../lib/domain.js';
import { parsePackingBook } from '../lib/packingList.js';
import { ReceiveModal as LineReceive } from './Replenish.jsx';
import { dDate, dt, qty, money, today, friendlyError } from '../lib/format.js';

const N = (v) => Number(v) || 0;
export const PURPOSE = { local: ['本地备货', 'blue'], fob: ['FOB', 'amber'], mixed: ['混装', 'amber'], supplies: ['物资', 'gray'], unknown: ['待定', 'gray'] };
const SOURCE = { kingdee: '金蝶导入', system: '系统建单', packing_list: '箱单导入' };
export const GAP_RESULTS = ['破损', '少发', '国内取消', '丢失', '补发中（另开单）', '其他'];

export const poListSql = `
select p.id, p.po_no, p.batch_name, p.warehouse_nos, p.purpose, p.fob_customer_codes, p.status, p.source, p.supplier, p.ordered_on, p.shipped_on, p.eta, p.mode, p.created_at,
  f.fob_no, (select coalesce(sum(l.qty),0) from app.po_lines l where l.po_id = p.id)::int as qty,
  (select coalesce(sum(l.qty_received),0) from app.po_lines l where l.po_id = p.id)::int as received,
  (select coalesce(sum(l.closed_qty),0) from app.po_lines l where l.po_id = p.id)::int as closed,
  (select count(*) from app.po_boxes b where b.po_id = p.id)::int as boxes_n,
  (select count(*) from app.po_boxes b where b.po_id = p.id and b.status = 'received')::int as boxes_in,
  (select count(*) from app.po_lines l where l.po_id = p.id and l.product_id is null)::int as unmatched_n,
  (select string_agg(distinct coalesce(pr.model, l.descr, l.model), ' / ') from app.po_lines l left join app.products pr on pr.id = l.product_id where l.po_id = p.id) as models
from app.purchase_orders p left join app.fob_projects f on f.id = p.fob_project_id
where p.org_id = $1 order by coalesce(p.shipped_on, p.ordered_on, p.created_at::date) desc, p.po_no desc`;

const transitOf = (p) => N(p.qty) - N(p.received) - N(p.closed);
function poState(p) {
  if (p.status === 'closed') return N(p.closed) > 0 ? ['到齐（有差额已关）', 'green'] : ['已到齐', 'green'];
  if (N(p.received) > 0) return ['部分到货', 'amber'];
  return ['在途', 'blue'];
}

export function PoLink({ id, no }) {
  const { openArchive } = useApp();
  if (!id) return <span className="mono">{no}</span>;
  return <button type="button" className="linkbtn mono" title={`打开采购单 ${no}`} onClick={(e) => { e.stopPropagation(); openArchive({ kind: 'po', id }); }}>{no}</button>;
}

export default function PoPage() {
  const { org, role } = useApp();
  const [f, setF] = useState('transit');
  const [imp, setImp] = useState(false);
  const [edit, setEdit] = useState(null);
  const { data } = useData(() => q(poListSql, [org]), [org]);
  if (!data) return <div className="empty">加载中…</div>;
  const rows = data.filter((p) => (f === 'transit' ? p.status !== 'closed' : f === 'done' ? p.status === 'closed' : f === 'fob' ? p.purpose === 'fob' : f === 'local' ? p.purpose !== 'fob' : true));
  const n = (k) => data.filter((p) => (k === 'transit' ? p.status !== 'closed' : k === 'done' ? p.status === 'closed' : k === 'fob' ? p.purpose === 'fob' : k === 'local' ? p.purpose !== 'fob' : true)).length;
  const cols = [
    { key: 'po_no', label: '采购单号', w: 190, render: (p) => <PoLink id={p.id} no={p.po_no} /> },
    { key: 'purpose', label: '用途', w: 90, value: (p) => PURPOSE[p.purpose || 'unknown'][0], render: (p) => <Pill tone={PURPOSE[p.purpose || 'unknown'][1]}>{PURPOSE[p.purpose || 'unknown'][0]}</Pill> },
    { key: 'fob_no', label: 'FOB 项目 / 客户', w: 130, value: (p) => p.fob_no || (p.purpose === 'fob' ? (p.fob_customer_codes || []).join(',') : '') },
    { key: 'batch_name', label: '需求批次', w: 200 },
    { key: 'inbound', label: '入仓号', w: 120, value: (p) => (p.warehouse_nos || []).join(' / ') },
    { key: 'models', label: '货', w: 220 },
    { key: 'shipped_on', label: '发货日', w: 100, render: (p) => dDate(p.shipped_on) },
    { key: 'eta', label: '预计到', w: 100, render: (p) => dDate(p.eta) },
    { key: 'qty', label: '采购数', w: 90, type: 'number', render: (p) => qty(p.qty) },
    { key: 'transit', label: '在途', w: 90, type: 'number', value: transitOf, render: (p) => (transitOf(p) > 0 ? <b>{qty(transitOf(p))}</b> : '') },
    { key: 'boxes', label: '箱（到 / 共）', w: 110, value: (p) => p.boxes_n, render: (p) => (p.boxes_n ? `${p.boxes_in} / ${p.boxes_n}` : <span className="muted small">没有箱单</span>) },
    { key: 'status', label: '状态', w: 140, value: (p) => poState(p)[0], render: (p) => <span className="row" style={{ gap: 4 }}><Pill tone={poState(p)[1]}>{poState(p)[0]}</Pill>{p.unmatched_n > 0 && <Pill tone="red">{p.unmatched_n} 行没对上编码</Pill>}</span> },
    { key: 'source', label: '来源', w: 90, value: (p) => SOURCE[p.source] || p.source },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Commandes d’achat</div>
        <h1>采购单与到货 <Info>国内发了货才建采购单，没下推入库的部分一律算在途。到货时打开采购单，勾选到了哪些箱 → 下推采购入库单；少到的差额只有中方能关，必须选结果、传凭证。箱单 Excel 直接拖进来自动读。</Info></h1></div>
        <span className="grow" />
        {can(role, 'po_edit') && <button type="button" className="btn" onClick={() => setImp(true)}>⇪ 导入箱单</button>}
        {can(role, 'po_edit') && <button type="button" className="btn primary" onClick={() => setEdit({ purpose: 'local', lines: [] })}>＋ 新建采购单</button>}
      </div>
      <div className="card">
        <Grid id="po-list" table="purchase_orders" columns={cols} rows={rows} empty="没有采购单"
          tools={<div className="chips">{[['transit', '在途 / 没到齐'], ['done', '已到齐'], ['local', '本地备货'], ['fob', 'FOB'], ['all', '全部']].map(([k, l]) => (
            <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} <b>{n(k)}</b></button>))}</div>} />
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
    return { po, lines, boxes, grns };
  }, [id, org]);
  if (!data?.po) return null;
  const { po, lines, boxes, grns } = data;
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
    <Drawer title={<span className="row" style={{ gap: 8 }}>采购单 <span className="mono">{po.po_no}</span><Pill tone={PURPOSE[po.purpose || 'unknown'][1]}>{PURPOSE[po.purpose || 'unknown'][0]}</Pill>{po.fob_no && <Pill tone="amber">{po.fob_no}</Pill>}{!po.fob_no && po.purpose === 'fob' && (po.fob_customer_codes || []).length > 0 && <Pill tone="amber">{po.fob_customer_codes.join(',')}</Pill>}</span>} onClose={onClose}>
      <div className="kv" style={{ marginBottom: 12 }}>
        <div><div className="k">需求批次</div><div className="v">{po.batch_name || '—'}</div></div>
        <div><div className="k">入仓号</div><div className="v mono">{(po.warehouse_nos || []).join(' / ') || '—'}</div></div>
        <div><div className="k">发货日 / 预计到</div><div className="v">{dDate(po.shipped_on) || '—'} → {dDate(po.eta) || '—'}</div></div>
        <div><div className="k">箱数 / 件数</div><div className="v">{po.boxes ?? boxes.length} 箱 · {qty(po.pcs ?? lines.reduce((a, l) => a + N(l.qty), 0))} 片</div></div>
        <div><div className="k">来源</div><div className="v">{SOURCE[po.source] || po.source}</div></div>
        {po.supplier && <div><div className="k">供应商</div><div className="v">{po.supplier}</div></div>}
        {po.note && <div><div className="k">备注</div><div className="v">{po.note}</div></div>}
      </div>
      {can(role, 'po_edit') && <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <button type="button" className="btn sm" onClick={() => setInfo({ eta: dDate(po.eta), shipped_on: dDate(po.shipped_on), supplier: po.supplier || '', note: po.note || '' })}>改预计到货 / 备注</button>
        {!lines.some((l) => N(l.qty_received) || N(l.closed_qty)) && po.source === 'system' && <button type="button" className="btn sm ghost" onClick={() => setEdit({ id: po.id, purpose: po.purpose, fob_project_id: po.fob_project_id || '', batch_name: po.batch_name || '', inbound_no: (po.warehouse_nos || [])[0] || '', shipped_on: dDate(po.shipped_on), eta: dDate(po.eta), supplier: po.supplier || '', lines: lines.map((l) => ({ product_id: l.product_id, descr: l.descr || l.pmodel || l.model, qty: l.qty, unit_price: l.unit_price ?? '' })) })}>改采购行</button>}
      </div>}
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
      {info && <Modal title={`改资料：${po.po_no}`} onClose={() => setInfo(null)}
        footer={<><button type="button" className="btn" onClick={() => setInfo(null)}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={async () => { try { await call(role, `select app.set_po_info($1,$2)`, [po.id, JSON.stringify(info)]); toast('已保存'); setInfo(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }}>保存</button></>}>
        <div className="rgrid">
          <div className="field"><label>预计到货</label><DatePicker value={info.eta} onChange={(v) => setInfo({ ...info, eta: v })} /></div>
          <div className="field"><label>发货日</label><DatePicker value={info.shipped_on} onChange={(v) => setInfo({ ...info, shipped_on: v })} /></div>
          <div className="field"><label>供应商</label><input className="in" value={info.supplier} onChange={(e) => setInfo({ ...info, supplier: e.target.value })} /></div>
          <div className="field"><label>备注（写给另一边看：为什么改日期、哪箱有问题…）</label><input className="in" value={info.note} onChange={(e) => setInfo({ ...info, note: e.target.value })} /></div>
        </div>
      </Modal>}
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
    try { await call(role, `select app.receive_boxes($1,$2,$3,$4,$5)`, [po.id, boxes.map((b) => b.id), wh, photo, note || null]); toast(`已下推采购入库单：${nBox} 箱进${po.purpose === 'fob' ? ' FOB 仓' : ` ${wh} 仓`}`); onDone(); } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
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
        <div className="field req"><label>结果</label><div className="chips">{GAP_RESULTS.map((x) => <button type="button" key={x} className={`chip ${r === x ? 'on' : ''}`} onClick={() => setR(x)}>{x}</button>)}</div></div>
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
  const [f, setF] = useState({ purpose: 'local', batch_name: '', inbound_no: '', shipped_on: today(), eta: '', supplier: '', fob_project_id: '', request_id: '', ...init });
  const [lines, setLines] = useState(() => [...(init.lines || []), ...Array.from({ length: Math.max(0, 5 - (init.lines || []).length) }, () => ({ descr: '', qty: '', unit_price: '' }))]);
  const { data: fobs } = useData(() => q(`select f.id, f.fob_no from app.fob_projects f where f.org_id = $1 and f.status not in ('closed','cancelled') order by f.fob_no`, [org]), [org]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setL = (i, k, v) => setLines((ls) => { const n = [...ls]; n[i] = { ...n[i], [k]: v, ...(k === 'descr' ? { product_id: null } : {}) }; if (i === n.length - 1 && String(v).trim()) n.push({ descr: '', qty: '', unit_price: '' }); return n; });
  const real = lines.filter((l) => String(l.descr || l.product_id || '').trim() && N(l.qty) > 0);
  const save = async () => {
    try {
      await call(role, `select app.save_po($1,$2,$3,$4)`, [org, init.id || null, JSON.stringify(f), JSON.stringify(real.map((l) => ({ product_id: l.product_id || null, descr: l.descr, qty: N(l.qty), unit_price: l.unit_price === '' ? null : N(l.unit_price), currency: 'CNY' })))]);
      toast('采购单已保存，算在途'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal wide title={init.id ? '改采购单' : '新建采购单'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><span className="small muted">{real.length} 行 · {qty(real.reduce((a, l) => a + N(l.qty), 0))} 片</span><button type="button" className="btn primary" disabled={!real.length || (f.purpose === 'fob' && !f.fob_project_id && !String(f.fob_customer || '').trim())} onClick={save}>保存（算在途）</button></>}>
      <div className="stack">
        <div className="hint">国内发了货再建单：保存后这些货就算在途，本地看得到什么时候到。单价以国内实际录入为准。{init.request_id ? ' 这张单来自本地的物料申请，保存后申请自动变成「国内已下单」。' : ''}</div>
        <div className="rgrid">
          <div className="field req"><label>用途</label><div className="chips">{[['local', '本地备货'], ['fob', 'FOB']].map(([k, l]) => <button type="button" key={k} className={`chip ${f.purpose === k ? 'on' : ''}`} onClick={() => set('purpose', k)}>{l}</button>)}</div></div>
          {f.purpose === 'fob' && <div className="field"><label>FOB 项目（系统里有就选）</label><select className="in" value={f.fob_project_id} onChange={(e) => set('fob_project_id', e.target.value)}><option value="">— 不挂项目 —</option>{(fobs || []).map((x) => <option key={x.id} value={x.id}>{x.fob_no}</option>)}</select></div>}
          {f.purpose === 'fob' && !f.fob_project_id && <div className="field req"><label>FOB 客户（例 LA9S-KABRE）</label><input className="in" value={f.fob_customer || ''} onChange={(e) => set('fob_customer', e.target.value.toUpperCase())} /></div>}
          <div className="field"><label>需求批次（例 20260715-KABRE海运-3批）</label><input className="in" value={f.batch_name} onChange={(e) => set('batch_name', e.target.value)} /></div>
          <div className="field"><label>入仓号（货代给的，例 CG2601995A）</label><input className="in" value={f.inbound_no} onChange={(e) => set('inbound_no', e.target.value.toUpperCase())} /></div>
          <div className="field"><label>发货日</label><DatePicker value={f.shipped_on} onChange={(v) => set('shipped_on', v)} /></div>
          <div className="field"><label>预计到货</label><DatePicker value={f.eta} onChange={(v) => set('eta', v)} /></div>
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
            <div className="field req"><label>用途（系统猜的，请确认）</label><div className="chips">{[['local', '本地备货'], ['fob', 'FOB']].map(([k, l]) => <button type="button" key={k} className={`chip ${p.purpose === k ? 'on' : ''}`} onClick={() => setP({ ...p, purpose: k })}>{l}</button>)}</div></div>
            {p.purpose === 'fob' && <div className="field"><label>FOB 项目（系统里有就选）</label><select className="in" value={p.fob_project_id} onChange={(e) => setP({ ...p, fob_project_id: e.target.value })}><option value="">— 不挂项目 —</option>{(fobs || []).map((x) => <option key={x.id} value={x.id}>{x.fob_no}{role === 'cn_support' ? '' : ` · ${x.name}`}</option>)}</select></div>}
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
  const [form, setForm] = useState(null);
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
  if (cn) data.reqs.forEach((r) => T.push({ red: r.need_by && dDate(r.need_by) <= in3, what: `本地申请 ${r.req_no}「${r.title}」等国内下单${r.need_by ? `（要在 ${dDate(r.need_by)} 前到）` : ''}`, btn: '建采购单', run: () => setForm(fromRequest(r, r.lines || [])) }));
  if (cn) open.filter((p) => !p.boxes_n).forEach((p) => T.push({ what: `${p.po_no} 还没有箱单：发货后把箱单 Excel 导进来，本地才知道每箱是什么`, po: p }));
  if (cn) open.filter((p) => !p.eta).forEach((p) => T.push({ what: `${p.po_no} 没填预计到货日：问货代后填上`, po: p }));
  if (cn || wh) open.filter((p) => p.unmatched_n > 0).forEach((p) => T.push({ red: p.eta && dDate(p.eta) <= in3, what: `${p.po_no} 有 ${p.unmatched_n} 行没对上系统编码：到货前必须对上，不然不能入库`, po: p }));
  if (cn) open.filter((p) => p.eta && dDate(p.eta) < td && N(p.received) === 0).forEach((p) => T.push({ red: true, what: `${p.po_no} 预计 ${dDate(p.eta)} 到，过了还没到：跟货代确认，改预计到货日`, po: p }));
  if (wh) open.filter((p) => p.eta && dDate(p.eta) <= in3 && p.boxes_n > p.boxes_in).forEach((p) => T.push({ red: dDate(p.eta) <= td, what: `${p.po_no} ${dDate(p.eta) <= td ? '应该到了' : `${dDate(p.eta)} 到`}（${p.boxes_n - p.boxes_in} 箱）：货到当天勾箱、拍照、下推入库`, po: p }));
  if (role === 'admin') open.filter((p) => N(p.received) > 0 && p.boxes_n > 0 && p.boxes_in === p.boxes_n && transitOf(p) > 0).forEach((p) => T.push({ red: true, what: `${p.po_no} 箱都到了还差 ${qty(transitOf(p))} 片：选结果 + 传凭证关差额`, po: p }));
  if (!T.length && role !== 'cn_support') return null;
  T.sort((a, b) => (b.red ? 1 : 0) - (a.red ? 1 : 0));
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2>采购与到货</h2>{T.length ? <Pill tone={T.some((x) => x.red) ? 'red' : 'amber'}>{T.length} 件</Pill> : <Pill tone="green">都做完了</Pill>}
        <Info>每条都写了做什么。点一下直接打开那张单。做法见「SOP」→ 采购与到货。</Info><span className="grow" />
        <button type="button" className="btn sm ghost" onClick={() => go('po')}>全部采购单 ›</button></div>
      {T.length ? T.map((x, i) => (
        <div key={i} className="orow" style={{ gridTemplateColumns: 'auto 1fr auto' }} onClick={() => (x.run ? x.run() : openArchive({ kind: 'po', id: x.po.id }))}>
          <span className={`age ${x.red ? 'red' : 'amber'}`}>{x.red ? '紧急' : '今天'}</span>
          <span className="small">{x.what}</span>
          {x.btn ? <button type="button" className="btn sm primary" onClick={(e) => { e.stopPropagation(); x.run(); }}>{x.btn}</button> : <span className="muted">›</span>}
        </div>)) : <div className="card-b small muted">今天没有要做的采购事项。国内发了货 → 导入箱单；本地提了申请 → 这里会出现「建采购单」。</div>}
      {form && <PoForm init={form} onClose={() => setForm(null)} />}
    </div>
  );
}
