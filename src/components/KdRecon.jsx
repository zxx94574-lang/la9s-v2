// 378 / 380 (Frank 11-18): ① 「待录金蝶」总表 —— 所有动库存 / 动钱的单据一张清单, 批量回填金蝶单号, 按金蝶单号反查;
// ② 「和金蝶对账」—— 金蝶导出的表拖进来, 自动认是哪种, 比出五类结果, 每次对账存一份.
// 系统不往金蝶写, 只记单号、对状态.
import { hasAny } from '../lib/domain.js';
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FileDrop, Info, Assumed, Choice, Pill } from './ui.jsx';
import Grid from './Grid.jsx';
import { DealLink, CustLink } from './Archives.jsx';
import { OptNote } from './Opts.jsx';
import { parseKdSheet, matchDocs, matchStock, KD_TYPES } from '../lib/kdRecon.js';
import { dt, dDate, qty, friendlyError } from '../lib/format.js';

const N = (v) => Number(v || 0);
const STATE = { todo: 'red', wait: 'amber', done: 'green', skip: 'gray' };

export function useKdTodoCount() {
  const { org } = useApp();
  return useData(() => q(`select count(*)::int as n from app.v_kingdee_all where org_id = $1 and state = 'todo'`, [org]), [org]).data?.[0]?.n || 0;
}

// ① 待录金蝶总表
export function KdAll() {
  const { org, role, toast, refresh } = useApp();
  const [show, setShow] = useState('todo'); const [kind, setKind] = useState(''); const [sel, setSel] = useState(new Set()); const [fill, setFill] = useState(null);
  const { data } = useData(() => q(`select * from app.v_kingdee_all where org_id = $1 order by (state = 'todo') desc, at desc`, [org]), [org]);
  const all = data || [];
  const kinds = [...new Set(all.map((r) => r.kind_name))];
  const todoN = (k) => all.filter((r) => r.state === 'todo' && (!k || r.kind_name === k)).length;
  const rows = all.filter((r) => (show === 'all' || r.state === show || (show === 'todo' && r.state === 'wait')) && (!kind || r.kind_name === kind));
  const can = hasAny(role, ['admin', 'finance', 'manager']);
  const picked = rows.filter((r) => sel.has(`${r.kind}:${r.row_id}`) && r.state !== 'done' && r.state !== 'skip');
  const go = async () => {
    const list = fill.rows.map((r) => ({ kind: r.kind, row_id: r.row_id, no: (fill.same ? fill.no : fill.nos[`${r.kind}:${r.row_id}`]) || '' }));
    if (list.some((x) => !x.no.trim())) return toast('每一张都要填金蝶单号', 'err');
    try { const [{ n }] = await call(role, `select app.kingdee_fill($1,$2) as n`, [org, JSON.stringify(list)]); toast(`已回填 ${n} 张的金蝶单号`); setFill(null); setSel(new Set()); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="stack">
      <div className="kpis" style={{ gridTemplateColumns: `repeat(${Math.max(2, Math.min(6, kinds.length + 1))}, minmax(0, 1fr))` }}>
        <button type="button" className={`kpi kpi-btn ${!kind ? 'on' : ''}`} onClick={() => setKind('')}><div className="k">还没录金蝶</div><div className={`v ${todoN('') ? 'red-t2' : ''}`}>{todoN('')}</div><div className="s">全部类型</div></button>
        {kinds.map((k) => <button type="button" key={k} className={`kpi kpi-btn ${kind === k ? 'on' : ''}`} onClick={() => setKind(kind === k ? '' : k)}><div className="k">{k}</div><div className={`v ${todoN(k) ? 'red-t2' : ''}`}>{todoN(k)}</div><div className="s">张待录</div></button>)}
      </div>
      <Grid id="kd-all" rows={rows} rowKey={(r) => `${r.kind}:${r.row_id}`} empty="没有" maxHeight={520} selectable={can ? { selected: sel, onChange: setSel } : undefined}
        tools={<><div className="al-seg"><button type="button" className={show === 'todo' ? 'on' : ''} onClick={() => setShow('todo')}>待录</button><button type="button" className={show === 'done' ? 'on' : ''} onClick={() => setShow('done')}>已录</button><button type="button" className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>全部</button></div>
          {can && <button type="button" className="btn sm primary" disabled={!picked.length} title={picked.length ? '' : '先勾选要填单号的行'} onClick={() => setFill({ rows: picked, same: false, no: '', nos: {} })}>填金蝶单号（{picked.length}）</button>}
          <span className="hint">在金蝶里录完，回来勾选 → 填单号。搜索框里输金蝶单号可以反查是系统哪张单。<Assumed>价格调整单、冻结 / 解冻不进这张表（之前定的不录金蝶）。出库单也可以照旧在「出库单录金蝶」页签里走 保存 → 提交 → 审核 三步。</Assumed></span></>}
        columns={[
          { key: 'kind_name', label: '类型', w: 110 },
          { key: 'label', label: '系统单据', w: 220, render: (r) => (r.deal_id ? <DealLink id={r.deal_id} no={r.label} /> : r.label) },
          { key: 'customer_name', label: '客户 / 供应商', w: 160, render: (r) => (r.customer_id ? <CustLink id={r.customer_id} name={r.customer_name} /> : r.customer_name) },
          { key: 'at', label: '日期', w: 110, type: 'date', render: (r) => dDate(r.at) },
          { key: 'qty', label: '数量', w: 80, type: 'number', value: (r) => (r.qty == null ? null : N(r.qty)), render: (r) => (r.qty == null ? '' : qty(r.qty)) },
          { key: 'state_name', label: '金蝶状态', w: 130, render: (r) => <Pill tone={STATE[r.state]}>{r.state_name}</Pill> },
          { key: 'kd_no', label: '金蝶单号', w: 150, mono: true }]} />
      {fill && <Modal wide title={`填金蝶单号 · ${fill.rows.length} 张`} onClose={() => setFill(null)} footer={<><button type="button" className="btn" onClick={() => setFill(null)}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={go}>保存</button></>}>
        <div className="stack">
          {fill.rows.length > 1 && <Choice value={fill.same ? 'y' : 'n'} onChange={(v) => setFill({ ...fill, same: v === 'y' })} options={[['n', '每张各填一个单号'], ['y', '这几张在金蝶里是同一张单']]} />}
          {fill.same ? <div className="field req"><label>金蝶单号</label><input className="in mono" style={{ maxWidth: 260 }} value={fill.no} onChange={(e) => setFill({ ...fill, no: e.target.value })} placeholder="例如 XSCKD000123" /></div>
            : fill.rows.map((r) => { const k = `${r.kind}:${r.row_id}`; return (
              <div key={k} className="row" style={{ gap: 10, flexWrap: 'wrap' }}><span className="pill gray">{r.kind_name}</span><b style={{ minWidth: 160 }}>{r.label}</b><span className="small muted">{r.customer_name || ''} · {dDate(r.at)}</span><span className="grow" />
                <input className="in mono" style={{ width: 200 }} value={fill.nos[k] || ''} onChange={(e) => setFill({ ...fill, nos: { ...fill.nos, [k]: e.target.value } })} placeholder="金蝶单号" /></div>); })}
          <div className="hint">只是把金蝶生成的单号记回系统这张单上，系统不会去改金蝶。填了 = 这张单算「已录」。</div>
        </div>
      </Modal>}
    </div>);
}

// ② 和金蝶对账
const CAT = { kd_only: ['金蝶有、系统没有', 'red'], sys_only: ['系统有、金蝶没有', 'amber'], diff: ['两边都有但不一样', 'red'], suspect: ['疑似是这张（没填单号）', 'amber'], stock: ['库存差', 'red'], ok: ['对上了', 'green'] };
const STOCK_CLS = { explained: ['已解释', 'green'], swap: ['疑似发错编码', 'amber'], unknown: ['无法解释，要盘点', 'red'] };
const sysDocsSql = {
  outbound: `select 'outbound' as kind, k.id as row_id, sh.out_no as label, d.id as deal_id, sh.shipped_at::date::text as date, c.name as party, c.code as party_code, k.remote_no as kd_no,
      (select jsonb_object_agg(code, n) from (select coalesce(p.kingdee_code, p.code) as code, sum(sl.qty)::int as n from app.shipment_lines sl join app.deal_lines l on l.id = sl.deal_line_id join app.products p on p.id = l.product_id where sl.shipment_id = sh.id group by 1) t) as lines
    from app.kingdee_outbox k join app.shipments sh on sh.id = k.shipment_id join app.deals d on d.id = sh.deal_id join app.customers c on c.id = d.customer_id where k.org_id = $1 and sh.voided_at is null`,
  grn: `select 'grn' as kind, g.id as row_id, g.grn_no as label, null::uuid as deal_id, g.created_at::date::text as date, p.supplier as party, null as party_code, g.kd_no,
      (select jsonb_object_agg(code, n) from (select x->>'code' as code, sum(coalesce((x->>'local_qty')::int, 0) + coalesce((x->>'fob_qty')::int, 0))::int as n from jsonb_array_elements(g.lines) x where x->>'code' is not null group by 1) t) as lines
    from app.po_receipts g join app.purchase_orders p on p.id = g.po_id where g.org_id = $1`,
  po: `select 'po' as kind, p.id as row_id, p.po_no as label, null::uuid as deal_id, coalesce(p.shipped_on, p.created_at::date)::text as date, p.supplier as party, null as party_code, p.po_no as kd_no,
      (select jsonb_object_agg(code, n) from (select coalesce(pr.kingdee_code, pr.code) as code, sum(l.qty)::int as n from app.po_lines l join app.products pr on pr.id = l.product_id where l.po_id = p.id group by 1) t) as lines
    from app.purchase_orders p where p.org_id = $1`,
};
sysDocsSql.so = sysDocsSql.outbound;

export function KdRecon() {
  const { org, role, toast, refresh } = useApp();
  const [files, setFiles] = useState([]); const [busy, setBusy] = useState(false); const [runId, setRunId] = useState(null); const [cat, setCat] = useState(''); const [note, setNote] = useState(null);
  const { data: runs } = useData(() => q(`select r.*, (select count(*)::int from app.kd_recon_items i where i.run_id = r.id and i.status = 'open') as open_n from app.kd_recon_runs r where r.org_id = $1 order by r.at desc limit 30`, [org]), [org]);
  const cur = runId || runs?.[0]?.id || null;
  const { data: items } = useData(() => (cur ? q(`select * from app.kd_recon_items where run_id = $1 order by cat, kd_no nulls last`, [cur]) : Promise.resolve([])), [cur]);
  const add = async (fs) => {
    const XLSX = await import('xlsx'); const out = [];
    for (const f of fs) {
      try { const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
        for (const name of wb.SheetNames) { const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }); if (rows.length < 2) continue;
          const p = parseKdSheet(rows); out.push({ name: wb.SheetNames.length > 1 ? `${f.name} › ${name}` : f.name, rows, ...p }); }
      } catch (e) { toast(`${f.name} 读不了：${e.message}`, 'err'); }
    }
    setFiles((x) => [...x, ...out]);
  };
  const setType = (i, t) => setFiles((x) => x.map((f, k) => (k === i ? { ...f, ...parseKdSheet(f.rows, t) } : f)));
  const ready = files.filter((f) => f.type && !f.missing.length && f.lines.length);
  const run = async () => {
    setBusy(true);
    try {
      let all = [];
      for (const f of ready) {
        if (f.type === 'stock') {
          const [stock, pend] = await Promise.all([q(`select coalesce(p.kingdee_code, v.code) as code, v.warehouse, v.qty_on_hand as qty, v.category, v.model from app.v_stock v join app.products p on p.id = v.product_id where v.org_id = $1`, [org]),
            q(`select code, sum(n)::int as n from (
                 select coalesce(p.kingdee_code, p.code) as code, -sum(sl.qty) as n from app.kingdee_outbox k join app.shipments sh on sh.id = k.shipment_id join app.shipment_lines sl on sl.shipment_id = sh.id join app.deal_lines l on l.id = sl.deal_line_id join app.products p on p.id = l.product_id
                   where k.org_id = $1 and k.status not in ('synced', 'void') and sh.voided_at is null group by 1
                 union all select x->>'code', sum(coalesce((x->>'local_qty')::int, 0) + coalesce((x->>'fob_qty')::int, 0)) from app.po_receipts g, jsonb_array_elements(g.lines) x where g.org_id = $1 and g.kd_status <> 'synced' group by 1) t where code is not null group by code`, [org])]);
          all = all.concat(matchStock(f.lines, stock, Object.fromEntries(pend.map((r) => [r.code, N(r.n)]))));
        } else {
          const sys = (await q(sysDocsSql[f.type], [org])).map((s) => ({ ...s, lines: s.lines || {} }));
          all = all.concat(matchDocs(f.type, f.lines, sys));
        }
      }
      const [{ id }] = await call(role, `select app.save_kd_recon($1,$2,$3) as id`, [org, JSON.stringify(ready.map((f) => ({ name: f.name, type: f.type, rows: f.lines.length }))), JSON.stringify(all)]);
      toast(`对完了：${all.filter((x) => x.cat !== 'ok').length} 条要看，${all.filter((x) => x.cat === 'ok').length} 条对上了`); setFiles([]); setRunId(id); setCat(''); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const handle = async (it, n, fillNo) => { try { await call(role, `select app.handle_kd_item($1,$2,$3)`, [it.id, n || null, !!fillNo]); toast(fillNo ? '已确认是同一张，金蝶单号已回填' : '已标成处理过'); setNote(null); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const list = (items || []); const cnt = (c) => list.filter((i) => i.cat === c).length; const openN = (c) => list.filter((i) => i.cat === c && i.status === 'open').length;
  const shown = list.filter((i) => (cat ? i.cat === cat : i.cat !== 'ok'));
  const lineTxt = (i) => (i.cat === 'stock' ? `系统 ${qty(i.info.sys)} · 金蝶 ${qty(i.info.kd)} · 差 ${i.info.diff > 0 ? '+' : ''}${qty(i.info.diff)}${i.info.why ? ` · ${i.info.why}` : ''}`
    : (i.info?.lines || []).slice(0, 4).map((l) => `${l.code}：金蝶 ${qty(l.kd)} / 系统 ${qty(l.sys)}`).join('；') + ((i.info?.lines || []).length > 4 ? ` …共 ${i.info.lines.length} 个编码` : '') || (i.info?.why || ''));
  const trend = useMemo(() => [...(runs || [])].reverse().map((r) => ({ at: r.at, n: Object.entries(r.counts || {}).filter(([k]) => k !== 'ok').reduce((a, [, v]) => a + N(v), 0) })), [runs]);
  const tmax = Math.max(1, ...trend.map((t) => t.n));
  return (
    <div className="stack">
      <div className="hint">从金蝶导出这几张表，直接拖进来（可以一次拖多张）：<b>销售出库单、采购入库单、采购订单、销售订单、即时库存</b>。系统按列名认是哪张表；先按金蝶单号对，没填单号的按「日期差 1 天以内 + 客户 + 编码数量」找最像的。只读，不碰金蝶。
        <Assumed>列名按金蝶云星空常见的中文导出写的（单据编号 / 日期 / 客户 / 物料编码 / 实发数量 / 实收数量 / 采购数量 / 库存量 / 仓库）。<b>还没拿你真实的金蝶导出文件试过</b>；认不出来的表可以手动选类型，还是不行把文件给 Claude 调列名。销售订单先按出库单的口径比。</Assumed></div>
      <FileDrop multiple accept=".xls,.xlsx,.csv" label="把金蝶导出的 Excel 拖到这里，或点这里选（可多个）" onFiles={add} />
      {files.length > 0 && <div className="card card-b stack" style={{ gap: 8 }}>
        {files.map((f, i) => (
          <div key={i} className="row" style={{ gap: 10, flexWrap: 'wrap' }}><b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{f.name}</b>
            <Choice size="sm" flat={false} value={f.type || ''} onChange={(t) => setType(i, t)} options={Object.entries(KD_TYPES)} placeholder="选是哪种表" width={150} />
            {f.missing.length ? <span className="pill red">缺：{f.missing.join('、')}</span> : <span className="pill green">{f.lines.length} 行 · {new Set(f.lines.map((l) => l.no)).size} 张单</span>}
            <span className="grow" /><button type="button" className="btn sm" onClick={() => setFiles(files.filter((_, k) => k !== i))}>去掉</button></div>))}
        <div className="row"><span className="grow" /><button type="button" className="btn primary" disabled={!ready.length || busy} onClick={run}>{busy ? '正在比…' : `开始对账（${ready.length} 张表）`}</button></div>
      </div>}
      {(runs || []).length === 0 ? <div className="card card-b small muted">还没对过账。建议每周一早上对一次（可以在待办里建一个「每周一 · 和金蝶对账」的定期任务提醒自己）。</div> : <>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field"><label>看哪一次对账</label><Choice flat={false} width={300} value={cur} onChange={setRunId} options={(runs || []).map((r) => [r.id, `${dt(r.at)} · ${(r.files || []).length} 张表 · 还有 ${r.open_n} 条没处理`])} /></div>
          {trend.length > 1 && <div className="field"><label>每次对账的差异条数（越来越少才对）</label>
            <svg width={Math.min(360, trend.length * 28 + 10)} height="44" role="img" aria-label="差异条数趋势">{trend.map((t, i) => <g key={i}><rect x={i * 28 + 4} y={40 - (t.n / tmax) * 34} width="18" height={Math.max(1, (t.n / tmax) * 34)} fill={i === trend.length - 1 ? '#0447b0' : '#b9c7de'} rx="2"><title>{dt(t.at)}：{t.n} 条</title></rect></g>)}</svg></div>}
        </div>
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          {['ok', 'kd_only', 'sys_only', 'diff', 'suspect', 'stock'].map((c) => <button type="button" key={c} className={`kpi kpi-btn ${cat === c ? 'on' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>
            <div className="k">{CAT[c][0]}</div><div className={`v ${c !== 'ok' && openN(c) ? 'red-t2' : ''}`}>{cnt(c)}</div><div className="s">{c === 'ok' ? '条' : `${openN(c)} 条没处理`}</div></button>)}
        </div>
        <Grid id="kd-recon" rows={shown} empty={cat ? '这一类没有' : '没有差异 ✓'} maxHeight={480}
          rowActions={[
            { label: '确认是这张 → 回填金蝶单号', tone: 'primary', when: (i) => i.cat === 'suspect' && i.status === 'open', run: (i) => handle(i, null, true) },
            { label: '写原因，标成处理过', when: (i) => i.status === 'open' && i.cat !== 'ok', run: (i) => setNote({ i, v: '' }) }]}
          columns={[
            { key: 'cat', label: '结果', w: 170, value: (i) => CAT[i.cat][0], render: (i) => <span className={`pill ${CAT[i.cat][1]}`}>{CAT[i.cat][0]}</span> },
            { key: 'doc_kind', label: '哪种表', w: 100, value: (i) => KD_TYPES[i.doc_kind] || i.doc_kind },
            { key: 'kd_no', label: '金蝶单号', w: 140, mono: true },
            { key: 'sys_label', label: '系统单据', w: 170, render: (i) => (i.deal_id ? <DealLink id={i.deal_id} no={i.sys_label} /> : i.sys_label) },
            { key: 'who', label: '日期 · 客户 / 供应商', w: 220, value: (i) => (i.cat === 'stock' ? `${i.info.model || ''} ${i.info.category || ''}` : `${i.info?.date || i.info?.sys_date || ''} ${i.info?.party || i.info?.sys_party || ''}`) },
            { key: 'lines', label: '哪里不一样', w: 380, value: lineTxt, render: (i) => (i.cat === 'stock' ? <><span className={`pill ${STOCK_CLS[i.info.cls][1]}`}>{STOCK_CLS[i.info.cls][0]}</span> {lineTxt(i)}</> : lineTxt(i)) },
            { key: 'status', label: '处理', w: 240, value: (i) => (i.status === 'handled' ? `已处理：${i.handle_note || ''}` : '没处理'), render: (i) => (i.status === 'handled' ? <span className="small">✓ {i.handle_note}</span> : <span className="pill amber">没处理</span>) }]} />
      </>}
      {note && <Modal title="这一条是怎么回事" onClose={() => setNote(null)} footer={<><button type="button" className="btn" onClick={() => setNote(null)}>取消</button><button type="button" className="btn primary" disabled={!note.v.trim()} onClick={() => handle(note.i, note.v, false)}>标成处理过</button></>}>
        <div className="field req"><label>原因 / 怎么处理的</label><OptNote optKey="note_kd_recon" title="对账差异的原因" options={['金蝶还没录，已安排补录', '系统漏做单据，已补', '金蝶录错，已让财务改', '发错编码，已做编码更正', '已盘点调整', '其他']} value={note.v} onChange={(v) => setNote({ ...note, v })} /></div>
      </Modal>}
    </div>);
}
