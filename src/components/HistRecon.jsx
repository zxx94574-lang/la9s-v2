// 11-26 Frank「直接改」：金蝶同步 → 「飞书 / 金蝶对账」
// ① 把金蝶导出的「…列表」和飞书 CI 销售表一起拖进来（一次可以拖很多个），系统自己认是哪种表
// ② 按客户对应收（时间差自动扣掉）、按销售订单对（客户挂错 / 只在金蝶 / 只在飞书 / 金额不同）
// ③ 每条差异选一个结论才算处理完；采购单 / 入库单导进来顺手建采购单、更新采购批次，并列出在途超期
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, FileDrop, Info, Assumed, Pill } from './ui.jsx';
import Grid from './Grid.jsx';
import { RuleGear, useRuleValues, ruleNum } from './Rules.jsx';
import { readFiles, normalize, feishuRows, poImportRows, poLogisticsRows, batchRows, KIND_L } from '../lib/kdImport.js';
import { applyPoRemarks } from '../lib/poApply.js';
import { money, dDate, friendlyError } from '../lib/format.js';

const VERDICT = [['time', '时间差，不用管'], ['sys', '系统 / 飞书要改'], ['kd', '金蝶要改（王振宇）'], ['known', '已知原因'], ['fixed', '已调平']];
const N = (v) => Number(v || 0);
const SHORT = { out: '销售出库', ret: '销售退货', receipt: '收款单', opening: '期初应收', ar: '应收单', customer: '客户', so: '销售订单', po: '采购订单', grn: '采购入库' };
const tone = (d, ok, warn) => (Math.abs(d) < ok ? 'green' : Math.abs(d) < warn ? 'amber' : 'red');

export default function HistRecon() {
  const { org, role, toast, refresh, tick } = useApp();
  const [files, setFiles] = useState([]); const [busy, setBusy] = useState(false); const [log, setLog] = useState([]);
  const [show, setShow] = useState('open'); const [soCat, setSoCat] = useState('');
  const rv = useRuleValues(['recon.ok', 'recon.warn', 'recon.po_days']);
  const OK = ruleNum(rv, 'recon.ok'), WARN = ruleNum(rv, 'recon.warn'), PODAYS = ruleNum(rv, 'recon.po_days');
  const { data, error } = useData(async () => {
    const [st, hs, ar, so, po] = await Promise.all([
      q(`select kind, count(*)::int n, count(distinct doc_no)::int docs, min(d)::text d0, max(d)::text d1, max(imported_at) as last_at from app.kd_lines where org_id = $1 group by kind`, [org]),
      q(`select count(*)::int n, count(*) filter (where status = 'Done')::int done, count(*) filter (where status = 'Done' and qty = 0 and ret_qty > 0)::int ret0,
           count(*) filter (where status = 'NotShipped')::int ns, min(d)::text d0, max(d)::text d1, max(imported_at) as last_at from app.hist_sales where org_id = $1`, [org]),
      call(role, `select * from app.recon_ar($1)`, [org]).catch(() => []),
      call(role, `select * from app.recon_so($1)`, [org]).catch(() => []),
      q(`select p.po_no, p.supplier, p.ordered_on::text d, (current_date - p.ordered_on)::int age, sum(l.qty - l.qty_received - coalesce(l.closed_qty, 0))::int left_qty
           from app.purchase_orders p join app.po_lines l on l.po_id = p.id where p.org_id = $1 and p.status = 'open' and p.ordered_on is not null
           group by p.po_no, p.supplier, p.ordered_on having sum(l.qty - l.qty_received - coalesce(l.closed_qty, 0)) > 0 order by p.ordered_on`, [org])]);
    return { st, hs: hs[0], ar, so, po };
  }, [org, tick]);

  const add = async (fs) => { try { const got = await readFiles(fs); setFiles((x) => [...x, ...got]); if (!got.length) toast('这几个文件里没认出能用的表', 'err'); } catch (e) { toast(friendlyError(e), 'err'); } };
  const run = async () => {
    setBusy(true); const out = [];
    try {
      for (const f of files.filter((x) => x.kind !== 'skip')) {
        if (f.kind === 'feishu') {
          const rows = feishuRows(f.rows);
          const [{ r }] = await call(role, `select app.hist_sales_load($1,$2) as r`, [org, JSON.stringify(rows)]);
          out.push(`飞书销售表：${r.n.toLocaleString('en-US')} 行（销量按月更新了 ${r.months} 条）`);
          continue;
        }
        for (const part of normalize(f.kind, f.rows)) {
          if (!part.rows.length) continue;
          const [{ r }] = await call(role, `select app.kd_lines_load($1,$2,$3) as r`, [org, part.kind, JSON.stringify(part.rows)]);
          out.push(`${KIND_L[f.kind]}${part.kind === 'ret' ? '（退货部分）' : ''}：${r.n.toLocaleString('en-US')} 行`);
          if (part.kind === 'po' && role === 'admin') {
            const rows = poImportRows(part.rows);
            const [{ r: p }] = await call(role, `select app.import_purchase_orders($1,$2) as r`, [org, JSON.stringify(rows)]);
            const n = await applyPoRemarks((s, a) => call(role, s, a), org, rows);
            await call(role, `select app.set_po_logistics_bulk($1,$2)`, [org, JSON.stringify(poLogisticsRows(part.rows))]).catch(() => {});   // 0106 物流公司 / 物流单号 / 件数…进对应格子
            out.push(`　→ 采购单 ${p.po ?? ''} 张建好 / 更新${p.skipped ? `，${p.skipped} 张系统里已经收过货的没动` : ''}${n ? `，${n} 张按备注认了本地 / FOB` : ''}`);
          }
          if (part.kind === 'grn' && role === 'admin') {
            const rows = batchRows(part.rows);
            const [{ r: b }] = await call(role, `select app.import_product_batches($1,$2) as r`, [org, JSON.stringify(rows)]);
            out.push(`　→ 采购批次 新增 ${b.inserted}、更新 ${b.updated}${b.bad_rows?.length ? `，${b.bad_rows.length} 条编码不在物料库（没进）` : ''}`);
          }
        }
      }
      setLog(out); setFiles([]); toast('导入好了，下面的对账已经按新数据重算'); refresh();
    } catch (e) { setLog([...out, `出错：${friendlyError(e)}`]); toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const mark = (key, cat) => async (v) => { try { await call(role, `select app.recon_mark($1,$2,$3,$4,$5)`, [org, key, cat, v ? VERDICT.find((x) => x[0] === v)?.[1] || v : '', null]); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const note = (key, cat, verdict) => async (v) => { if (!verdict) return toast('先选结论，再写说明', 'err'); try { await call(role, `select app.recon_mark($1,$2,$3,$4,$5)`, [org, key, cat, verdict, v]); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const vKey = (label) => VERDICT.find((x) => x[1] === label)?.[0] || '';

  const ar = useMemo(() => (data?.ar || []).map((r) => ({ ...r, st: Math.abs(N(r.diff)) < OK ? '对上' : Math.abs(N(r.diff)) < WARN ? '小差' : '要查' })), [data, OK, WARN]);
  const arRows = ar.filter((r) => (show === 'all' ? true : show === 'done' ? r.verdict : r.st !== '对上' && !r.verdict)).sort((a, b) => Math.abs(N(b.diff)) - Math.abs(N(a.diff)));
  const so = (data?.so || []).filter((r) => r.cat !== '一致');
  const soRows = so.filter((r) => (!soCat || r.cat === soCat) && (show === 'all' ? true : show === 'done' ? r.verdict : !r.verdict && (r.cat !== '金额不同' || Math.abs(N(r.diff)) >= OK)));
  const cnt = (c) => so.filter((r) => r.cat === c && !r.verdict).length;
  const has = data && (data.st.length || data.hs?.n);
  const cut = ar[0]?.cutoff;

  return (
    <div className="stack">
      <div className="card card-b">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><b>导入</b>
          <Info>把金蝶里导出的「销售出库单列表、收款单列表、财务应收单列表（含期初）、客户列表、销售订单列表、采购订单列表、采购入库单列表」和飞书「CI销售表」一起拖进来，系统自己认是哪种表。同一张单再导一次会整张换掉，不会重复。飞书销售表每次整张换掉。</Info>
          <RuleGear ids={['recon.ok', 'recon.warn', 'recon.po_days']} /></div>
        <FileDrop multiple accept=".xlsx,.xls" onFiles={add} label="把金蝶导出的表、飞书 CI 销售表拖到这里（可以一次拖多个）" style={{ marginTop: 8 }} />
        {files.length > 0 && <div className="stack" style={{ marginTop: 10, gap: 6 }}>
          {files.map((f, i) => <div key={i} className="row" style={{ gap: 8, flexWrap: 'wrap' }}><Pill tone={f.kind === 'skip' ? 'gray' : 'green'}>{KIND_L[f.kind]}</Pill><span className="small">{f.file}{f.sheet ? ` › ${f.sheet}` : ''}</span><span className="small muted">{(f.rows.length - 1).toLocaleString('en-US')} 行</span>
            <button type="button" className="btn sm ghost" onClick={() => setFiles((x) => x.filter((_, k) => k !== i))}>去掉</button></div>)}
          <div className="row" style={{ gap: 8 }}><button type="button" className="btn primary" disabled={busy || !files.some((f) => f.kind !== 'skip')} onClick={run}>{busy ? '导入中…' : `导入 ${files.filter((f) => f.kind !== 'skip').length} 张表`}</button>
            {role !== 'admin' && files.some((f) => ['feishu', 'po', 'grn'].includes(f.kind)) && <span className="small red-t2">飞书销售表、采购单 / 入库单要中方导</span>}</div></div>}
        {log.length > 0 && <div className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{log.join('\n')}</div>}
        {has && <div className="small muted" style={{ marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {data.hs?.n > 0 && <span>飞书 {data.hs.n.toLocaleString('en-US')} 行（{data.hs.d0} → {data.hs.d1}）· Done {data.hs.done.toLocaleString('en-US')} · 退货调成 0 的 {data.hs.ret0} · 当初没发货标了 Done 的 {data.hs.ns}（不算）</span>}
          {data.st.map((s) => <span key={s.kind}>金蝶{SHORT[s.kind] || s.kind} {s.docs.toLocaleString('en-US')} 张{s.d0 ? `（${s.d0} → ${s.d1}）` : ''}</span>)}
        </div>}
        {error && <div className="small red-t2" style={{ marginTop: 8 }}>读对账数据出错：{friendlyError(error)}</div>}
      </div>

      {has && <>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="al-seg">{[['open', '要处理的'], ['done', '已处理'], ['all', '全部']].map(([k, l]) => <button type="button" key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{l}</button>)}</div>
          <Assumed>差额 {OK.toLocaleString('en-US')} 以内算对上，{WARN.toLocaleString('en-US')} 以内标黄，再大标红（⚙ 可调）。金蝶收款录到 {cut ? dDate(cut) : '—'}，这天以后飞书收的钱、飞书还没金蝶单号的单都算时间差，已经扣掉。</Assumed>
        </div>

        <div className="card"><div className="card-h"><h2>按客户对应收 <Info>金蝶 = 期初（2025-12-31）+ 出库 − 退货 − 收款（销售回款，人民币按当时汇率折西法）。飞书 = Done 行的待付，扣掉时间差。差 = 金蝶 − 飞书。FOB 客户不比（飞书销售表里没有）。</Info></h2>
          <span className="small muted">{ar.filter((r) => r.st === '对上').length} 对上 · {ar.filter((r) => r.st === '小差').length} 小差 · <b className="red-t2">{ar.filter((r) => r.st === '要查' && !r.verdict).length} 要查</b></span></div>
          <Grid id="recon-ar" rows={arRows} rowKey={(r) => r.code} maxHeight={520} empty={show === 'open' ? '没有要处理的客户' : '没有'}
            columns={[
              { key: 'code', label: '客户', w: 170, value: (r) => `${r.code} ${r.name || ''}`, render: (r) => <><span className="mono muted">{r.code}</span> {r.name}</> },
              { key: 'st', label: '状态', w: 80, render: (r) => <Pill tone={tone(N(r.diff), OK, WARN)}>{r.st}</Pill> },
              { key: 'diff', label: '差（金蝶 − 飞书）', w: 130, type: 'number', value: (r) => N(r.diff), render: (r) => <b className={Math.abs(N(r.diff)) >= WARN ? 'red-t2' : ''}>{money(r.diff)}</b> },
              { key: 'kd_ar', label: '金蝶应收', w: 115, type: 'number', value: (r) => N(r.kd_ar), render: (r) => money(r.kd_ar) },
              { key: 'fs_adj', label: '飞书（扣时间差）', w: 125, type: 'number', value: (r) => N(r.fs_adj), render: (r) => money(r.fs_adj) },
              { key: 'kd_open', label: '金蝶期初', w: 105, type: 'number', value: (r) => N(r.kd_open), render: (r) => money(r.kd_open) },
              { key: 'kd_out', label: '金蝶出库', w: 115, type: 'number', value: (r) => N(r.kd_out), render: (r) => money(r.kd_out) },
              { key: 'kd_ret', label: '金蝶退货', w: 100, type: 'number', value: (r) => N(r.kd_ret), render: (r) => money(r.kd_ret) },
              { key: 'kd_recv', label: '金蝶收款', w: 115, type: 'number', value: (r) => N(r.kd_recv), render: (r) => money(r.kd_recv) },
              { key: 'fs_due', label: '飞书待付', w: 110, type: 'number', value: (r) => N(r.fs_due), render: (r) => money(r.fs_due) },
              { key: 'fs_late', label: '金蝶没录到的收款', w: 125, type: 'number', value: (r) => N(r.fs_late), render: (r) => money(r.fs_late) },
              { key: 'fs_nokd', label: '没录金蝶的单', w: 110, type: 'number', value: (r) => N(r.fs_nokd), render: (r) => money(r.fs_nokd) },
              { key: 'sys_ar', label: '系统现在', w: 110, type: 'number', value: (r) => (r.sys_ar == null ? null : N(r.sys_ar)), render: (r) => (r.sys_ar == null ? '' : money(r.sys_ar)) },
              { key: 'verdict', label: '结论', w: 170, value: (r) => r.verdict || '', edit: (r) => ({ type: 'select', value: vKey(r.verdict), onChange: mark('ar:' + r.code, 'ar'), options: [['', '—'], ...VERDICT] }) },
              { key: 'note', label: '说明', w: 200, value: (r) => r.note || '', edit: (r) => ({ type: 'text', value: r.note || '', onChange: note('ar:' + r.code, 'ar', r.verdict) }) }]} />
        </div>

        <div className="card"><div className="card-h"><h2>按销售订单对 <Info>同一个销售订单号，飞书 Done 的金额（已扣退货）和金蝶出库 − 退货比。飞书写的是出库单号的，先换成它的销售订单号。「客户不同」= 两边挂在不同客户名下，最要紧。</Info></h2>
            <div className="al-seg">{[['', '全部'], ['客户不同', `客户不同 ${cnt('客户不同')}`], ['只在金蝶', `只在金蝶 ${cnt('只在金蝶')}`], ['只在飞书', `只在飞书 ${cnt('只在飞书')}`], ['金额不同', `金额不同 ${cnt('金额不同')}`]].map(([k, l]) => <button type="button" key={k} className={soCat === k ? 'on' : ''} onClick={() => setSoCat(k)}>{l}</button>)}</div></div>
          <Grid id="recon-so" rows={soRows} rowKey={(r) => r.so_no} maxHeight={520} empty="没有"
            columns={[
              { key: 'so_no', label: '销售订单号', w: 150, mono: true },
              { key: 'cat', label: '哪种', w: 95, render: (r) => <Pill tone={r.cat === '客户不同' || r.cat === '只在金蝶' ? 'red' : 'amber'}>{r.cat}</Pill> },
              { key: 'diff', label: '差（金蝶 − 飞书）', w: 130, type: 'number', value: (r) => N(r.diff), render: (r) => money(r.diff) },
              { key: 'fs', label: '飞书', w: 200, value: (r) => `${r.fs_cust || ''} ${r.fs_name || ''}`, render: (r) => (r.fs_cust ? <><span className="mono muted">{r.fs_cust}</span> {r.fs_name} · {money(r.fs_amount)}</> : <span className="muted">没有</span>) },
              { key: 'fs_date', label: '飞书日期', w: 100, render: (r) => dDate(r.fs_date) },
              { key: 'kd', label: '金蝶', w: 200, value: (r) => `${r.kd_cust || ''} ${r.kd_name || ''}`, render: (r) => (r.kd_cust ? <><span className="mono muted">{r.kd_cust}</span> {r.kd_name} · {money(r.kd_amount)}{N(r.kd_ret) ? ` / 退 ${money(r.kd_ret)}` : ''}</> : <span className="muted">没有</span>) },
              { key: 'kd_date', label: '金蝶出库', w: 100, render: (r) => dDate(r.kd_date) },
              { key: 'verdict', label: '结论', w: 170, value: (r) => r.verdict || '', edit: (r) => ({ type: 'select', value: vKey(r.verdict), onChange: mark('so:' + r.so_no, r.cat), options: [['', '—'], ...VERDICT] }) },
              { key: 'note', label: '说明', w: 200, value: (r) => r.note || '', edit: (r) => ({ type: 'text', value: r.note || '', onChange: note('so:' + r.so_no, r.cat, r.verdict) }) }]} />
        </div>

        {data.po.length > 0 && <div className="card"><div className="card-h"><h2>采购在途 <Info>系统里还没收完的采购单（金蝶导进来的 + 系统建的），按下单日期排。超过 {PODAYS} 天的标红：要么货早到了没录入库，要么该关没关。</Info></h2>
          <span className="small muted">{data.po.length} 张 · <b className="red-t2">{data.po.filter((p) => p.age > PODAYS).length} 张超期</b></span></div>
          <Grid id="recon-po" rows={data.po} rowKey={(r) => r.po_no} maxHeight={420} empty="没有"
            columns={[{ key: 'po_no', label: '采购单', w: 140, mono: true }, { key: 'supplier', label: '供应商', w: 200 }, { key: 'd', label: '下单', w: 100, render: (r) => dDate(r.d) },
              { key: 'age', label: '天数', w: 80, type: 'number', render: (r) => <Pill tone={r.age > PODAYS ? 'red' : 'green'}>{r.age} 天</Pill> },
              { key: 'left_qty', label: '还没到（片）', w: 110, type: 'number', value: (r) => N(r.left_qty), render: (r) => N(r.left_qty).toLocaleString('en-US') }]} />
        </div>}
      </>}
    </div>);
}
