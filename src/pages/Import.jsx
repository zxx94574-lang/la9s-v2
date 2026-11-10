// 数据导入 (中方) —— 初始导入: 物料 / 客户 / 库存+库龄 / 在途采购 / 应收期初. 不导历史销售订单和出库单.
// 流程: 选类型 → 从 Excel 复制整块 (带表头) 粘进来 → 看预览 (认出哪些列、哪些行有问题) → 导入 → 看结果 (退回的行原样列出).
import React, { useState } from 'react';
import { call } from '../db/client.js';
import { useApp, Pill, DatePicker, FileDrop } from '../components/ui.jsx';
import { KINDS, parse } from '../lib/importer.js';
import Grid from '../components/Grid.jsx';
import { applyPoRemarks } from '../lib/poApply.js';
import { can } from '../lib/domain.js';
import { today, friendlyError, money } from '../lib/format.js';

export default function Import() {
  const { org, role, toast, refresh } = useApp();
  const [k, setK] = useState('products');
  const [text, setText] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!can(role, 'import_data')) return <div className="card card-b lock">数据导入只有中方能做。</div>;
  const K = KINDS[k];
  const p = text.trim() ? parse(k, text) : null;
  const pick = (x) => { setK(x); setText(''); setRes(null); };
  // 模板: 复制到剪贴板, 打开 Excel 直接粘贴 (演示链接里不能下载文件)
  const copyTpl = async () => {
    try { await navigator.clipboard.writeText(K.sample.map((r) => r.join('\t')).join('\n')); toast('模板已复制：打开 Excel 粘贴，填好后整块复制回来'); }
    catch { setText(K.sample.map((r) => r.join('\t')).join('\n')); toast('浏览器不让复制，模板已放进下面的框里'); }
  };
  const go = async () => {
    setBusy(true); setRes(null);
    try {
      const sql = K.asOf ? `select app.${K.fn}($1,$2,$3) as r` : `select app.${K.fn}($1,$2) as r`;
      const [{ r }] = await call(role, sql, K.asOf ? [org, asOf, JSON.stringify(p.rows)] : [org, JSON.stringify(p.rows)]);
      if (k === 'po') { const n = await applyPoRemarks((sql2, p2) => call(role, sql2, p2), org, p.rows); if (n) toast(`已按国内备注识别 ${n} 张采购单的用途（本地 / FOB / 混装）`); }
      setRes(r); toast('导入完成'); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  const bad = res && (res.bad_rows || res.missing || []);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Import de données</div><h1>数据导入</h1>
        <div className="sub">初始导入只导主数据和期初：物料、客户、库存和库龄、在途采购、应收期初。历史销售订单和出库单不导。同一份数据重复导入不会重复（按编码 / 单号更新）。</div></div></div>
      <div className="banner info" style={{ marginBottom: 12 }}>这是演示版：这里导入的只是测试数据。真实的金蝶 / 飞书数据导进单独的私有版本，不放进演示链接。</div>
      <div className="card">
        <div className="tabs">{Object.entries(KINDS).map(([x, v]) => <button type="button" key={x} className={k === x ? 'on' : ''} onClick={() => pick(x)}>{v.label.split('（')[0]}</button>)}</div>
        <div className="card-b stack">
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <b>{K.label}</b><span className="muted small">必须有的列：{K.required.map((f) => K.fields[f][0][0]).join('、')}</span><span className="grow" />
            {K.asOf && <DatePicker value={asOf} onChange={setAsOf} label="库存日期" />}
            <button type="button" className="btn sm" onClick={copyTpl}>复制模板</button>
          </div>
          <FileDrop accept=".xlsx,.xls,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" compact label="把 Excel / CSV 文件拖到这里，或点击从电脑选" hint="读第一个工作表；也可以在下面直接粘贴"
            onFiles={async ([f]) => { try { setText(await fileToTsv(f)); setRes(null); toast(`已读入 ${f.name}`); } catch (e) { toast(e.message || '读不了这个文件', 'err'); } }} />
          <textarea className="in mono" rows={8} value={text} onChange={(e) => { setText(e.target.value); setRes(null); }}
            placeholder={`从 Excel 选中整块（第一行是表头）复制，粘到这里。\n\n例：\n${K.sample.map((r) => r.join('\t')).join('\n')}`} />
          {p && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span className="small">认出的列：</span>{p.cols.map((c) => <Pill key={c.key} tone="green">{c.label}{c.from !== c.label ? ` ← ${c.from}` : ''}</Pill>)}
                {p.ignored?.length > 0 && <span className="small muted">　忽略：{p.ignored.join('、')}</span>}
              </div>
              {p.missing.length > 0 && <div className="banner warn">缺必须的列：{p.missing.map((f) => K.fields[f][0][0]).join('、')}。改一下表头再粘。</div>}
              {p.problems.length > 0 && <div className="banner info">{p.problems.length} 行有问题，不会导入：{p.problems.slice(0, 8).map((x) => `第 ${x.line} 行${x.why}`).join('；')}{p.problems.length > 8 ? ' …' : ''}</div>}
              {p.rows.length > 0 && (
                <div>
                  <Grid id={`import-${k}`} maxHeight={280} rowKey={(r) => r._k} rows={p.rows.slice(0, 50).map((r, i) => ({ ...r, _k: String(i) }))}
                    columns={p.cols.map((c) => ({ key: c.key, label: c.label, w: 110, value: (r) => (Array.isArray(r[c.key]) ? r[c.key].join(' / ') : r[c.key] == null ? '' : typeof r[c.key] === 'number' ? r[c.key].toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(r[c.key])) }))} />
                  {p.rows.length > 50 && <div className="small muted" style={{ padding: 8 }}>只显示前 50 行，共 {p.rows.length} 行</div>}
                </div>)}
              <div className="row"><span className="grow" /><button type="button" className="btn primary" disabled={busy || p.missing.length > 0 || !p.rows.length} onClick={go}>{busy ? '导入中…' : `导入 ${p.rows.length} 行`}</button></div>
            </div>)}
          {res && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="banner info" style={{ background: 'var(--green-bg)', color: 'var(--green)' }}>
                {k === 'products' && `新建 ${res.new} 个物料，更新 ${res.updated} 个；有成本的已按公式出价。`}
                {k === 'customers' && `新建 ${res.new} 个客户，合并 ${res.updated} 个（同编码或同电话），跳过 ${res.skipped} 行。`}
                {k === 'stock' && `对齐了 ${res.n} 行库存。`}
                {k === 'po' && `导入 ${res.po} 张采购单 ${res.lines} 行；已在系统里收过货的 ${res.skipped} 张没覆盖。`}
                {k === 'opening' && `导入 ${res.n} 张期初单，合计 ${money(res.total)}。`}
                {k === 'sales' && `导入 ${res.n} 行月销量，备货看板的日均已更新。`}
              </div>
              {bad?.length > 0 && <div className="banner warn">{bad.length} 行没导进去：{bad.slice(0, 10).map((x) => `${x.code || x.customer_code || x.name || ''}${x.why ? `（${x.why}）` : ''}`).join('，')}{bad.length > 10 ? ' …' : ''}</div>}
            </div>)}
        </div>
      </div>
    </>
  );
}

// Excel / CSV 文件 → 制表符文本 (和粘贴走同一条解析路径)
async function fileToTsv(f) {
  const name = f.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    const t = await f.text();
    if (name.endsWith('.csv')) return t.replace(/\r/g, '').split('\n').map((l) => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').trim()).join('\t')).join('\n');
    return t;
  }
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await f.arrayBuffer());
  const ws = wb.worksheets[0]; if (!ws) throw new Error('文件里没有工作表');
  const lines = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = []; for (let c = 1; c <= ws.columnCount; c++) { const v = row.getCell(c).value; cells.push(v == null ? '' : typeof v === 'object' ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v))) : String(v)); }
    lines.push(cells.join('\t'));
  });
  return lines.join('\n');
}
