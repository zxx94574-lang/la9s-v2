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
const WH = { 'CI LA MATERIAL WH': 'LA', 'CI 9S MATERIAL WH': '9S', 'CI LA FOB MATERIAL WH': 'FOB', 'CI PENDING LIABILITY WH': 'PENDING', 'CI DEFECTIVE WH-LA': 'SCRAP', 'CI DEFECTIVE WH-9S': 'SCRAP', 'CI PCBA RECYCLE WH': 'RECYCLE', 'CI CHIP RECYCLE WH': 'RECYCLE' };

export default function Kingdee() {
  const { org, role, toast, refresh, go } = useApp();
  const [tab, setTab] = useState('queue');
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
        <div className="tabs"><button type="button" className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>出库单录金蝶 <span className="queue-n">{counts.ready || ''}</span></button>
          <button type="button" className={tab === 'grn' ? 'on' : ''} onClick={() => setTab('grn')}>采购入库 <span className="queue-n">{data.grn.filter((g) => g.kd_status === 'ready').length || ''}</span></button>
          <button type="button" className={tab === 'stock' ? 'on' : ''} onClick={() => setTab('stock')}>库存对账</button></div>
        {tab === 'grn' && <GrnList rows={data.grn} />}
        {tab === 'grn' ? null : tab === 'queue' ? (
          <Grid id="kd-queue" table="kingdee_outbox" columns={cols} rows={rows} onRowClick={(r) => go('deal/' + r.deal_id)} empty="没有"
            tools={<div className="chips">{[['ready', '待录'], ['saved', '已保存'], ['submitted', '待审核'], ['synced', '已审核'], ['await_receipt', '待签收'], ['', '全部']].map(([k, l]) =>
              <button type="button" key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l} {k ? counts[k] : data.rows.length}</button>)}</div>} />
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
