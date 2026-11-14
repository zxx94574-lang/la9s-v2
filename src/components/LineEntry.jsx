// 询单明细 (新报价 / 报价修改 / 出库前追加). 数量默认 0, 要往下推时 0 / 空标红.
// Frank 11-01 照飞书的录法:
//  · 搜索框选型号: 点一个不关, 可以接着点; 点「完成」/ Esc / 点外面才关
//  · 「选货清单」: 编码 | 种类 | 机型 | 通用性 | 可售, 勾选 + 填数量, 一次加进来
//  · 「加行」: 一次加 N 行空白行; 空白行可以填编码, 或者选种类 + 填机型 (机型边打边筛, 包含就出来)
//  · 整块粘贴: 从 Excel / 飞书 / 手写整理的清单粘进编码或机型那一列 (后面一列是数字就当数量), 一次几十上百行
//  · 编码带出一切; 种类 + 机型带出编码; 对上多个编码标黄让人挑; 没建档自动变「补录需求」(未满足需求)
//  · 勾选几行 → 「批量设种类」
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Grid from './Grid.jsx';
import ModelPicker, { avail, StockPill } from './ModelPicker.jsx';
import { Modal, Shared, useApp, useHistory, UndoBar, Bang, lowTip } from './ui.jsx';
import { money, qty } from '../lib/format.js';
import { makeResolver, normModel, pasteRows, isQty } from '../lib/resolve.js';

let seq = 0;
export const newKey = () => `n${Date.now().toString(36)}${seq++}`;

// light similarity: same letters ignoring spaces/dashes, or edit distance ≤ 2
const norm = (s) => s.toUpperCase().replace(/[\s\-_.]/g, '');
function dist(a, b) {
  const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// 行的生效单价: 中方直接给的价 (unit_price, 手改) 优先, 否则档位价
// 档位价 (外币单: XOF 档位价 ÷ 单上手填汇率, 两位小数 —— Frank 11-09 190)
export const tierPrice = (l, tier, fx) => { if (!l.product) return 0; const x = Number(l.product.prices?.[tier] || 0); return fx > 0 ? Math.round((x / fx) * 100) / 100 : x; };
export const priceOf = (l, tier, fx) => (Number(l.unit_price) > 0 ? Number(l.unit_price) : tierPrice(l, tier, fx));
// 总价 / 合计用: 员工申请价显示申请值 (还没批, 以审批结果为准)
// 价格异常 (Frank 11-09 192b, 只给中方看): 低于成本 → 会亏; 低于 S 档 → 低于底价; 低于本档 → 低于档位
export function priceFlag(l, tier, fx) {
  if (!l.product) return null;
  const p = Number(l.req_price) > 0 ? Number(l.req_price) : Number(l.unit_price) > 0 ? Number(l.unit_price) : null;
  if (p == null) return null;
  const toX = (v) => (fx > 0 ? v * fx : v);   // 外币单折回 XOF 比
  const px = toX(p);
  if (Number(l.product.cost_xof) > 0 && px < Number(l.product.cost_xof)) return '会亏';
  const s = Number(l.product.prices?.S || 0); if (s > 0 && px < s) return '低于底价';
  const t = Number(l.product.prices?.[tier] || 0); if (t > 0 && px < t) return '低于档位';
  return null;
}
export const shownPrice = (l, tier, fx) => (Number(l.req_price) > 0 ? Number(l.req_price) : priceOf(l, tier, fx));
export function lineTotals(lines, tier, showPrice, fx = null) {
  const real = lines.filter((l) => l.product || (l.model && l.category_id));
  const n = real.length;
  const pcs = real.reduce((a, l) => a + (Number(l.qty_req) || 0), 0);
  const amt = showPrice ? real.reduce((a, l) => a + (Number(l.qty_req) || 0) * shownPrice(l, tier, fx), 0) : 0;
  return { n, pcs, amt };
}

// 非物料行的状态: blank 空白 / badcode 编码不存在 / needcat 要选种类 / multi 多个编码 / unmet 没建档 (= 补录需求)
export const lineStatus = (l) => (l.product ? 'ok' : l.status || (l.model && l.category_id ? 'unmet' : l.model ? 'needcat' : 'blank'));

// 保存前检查: 去掉空白行; 还没落定的行报出来
export function finalizeLines(lines) {
  const out = lines.filter((l) => lineStatus(l) !== 'blank');
  for (let i = 0; i < out.length; i++) {
    const s = lineStatus(out[i]); const n = i + 1;
    if (s === 'badcode') return { error: `第 ${n} 行编码 ${out[i].code_in} 不存在：改编码，或清空编码改填种类 + 机型` };
    if (s === 'needcat') return { error: `第 ${n} 行 ${out[i].model} 还没选种类` };
    if (s === 'multi') return { error: `第 ${n} 行 ${out[i].model} 对上了几个编码，请在黄色那格挑一个` };
  }
  const seen = new Map();
  for (let i = 0; i < out.length; i++) {
    const id = out[i].product?.id; if (!id) continue;
    if (seen.has(id)) return { error: `第 ${seen.get(id) + 1} 行和第 ${i + 1} 行是同一个编码 ${out[i].product.code}，合并数量后删掉一行` };
    seen.set(id, i);
  }
  return { lines: out };
}

// 同一个编码出现两次 (比如粘贴的清单里有明细已经有的型号): 数量加到前面那行, 后面那行去掉
function mergeDup(lines) {
  const first = new Map(); const out = []; let merged = 0;
  for (const l of lines) {
    const id = l.product?.id;
    if (id && first.has(id)) { const t = out[first.get(id)]; out[first.get(id)] = { ...t, qty_req: String((Number(t.qty_req) || 0) + (Number(l.qty_req) || 0)) }; merged++; continue; }
    if (id) first.set(id, out.length);
    out.push(l);
  }
  return [out, merged];
}

const BLANK = () => ({ key: newKey(), product: null, code_in: '', category_id: '', model: '', qty_req: '0', note: '' });

export default function LineEntry({ id, catalog, categories, tier, lines, setLines, showErrors, showPrice = true, currency = 'XOF', canPrice = false, priceMode = null, onProductOpen, errors, fx = null, extraTools = null }) {
  const { toast, openArchive } = useApp();
  const openP = onProductOpen || (openArchive ? (pr) => openArchive({ kind: 'product', product: pr, tier }) : null);
  const [unmet, setUnmet] = useState(false);
  const [pickList, setPickList] = useState(false);
  const [addN, setAddN] = useState('1');
  const [sel, setSel] = useState(new Set());
  const h = useHistory(lines, setLines);
  const scope = useRef();
  const latest = useRef(lines); latest.current = lines;
  const queue = useRef(null);
  const resolve = useMemo(() => makeResolver(catalog), [catalog]);
  const catByName = useMemo(() => new Map(categories.map((c) => [c.name.toUpperCase(), c.id])), [categories]);
  const nameOf = (l) => (l.product ? l.product.model : l.model || l.code_in || '空白行');
  const gid = `g-${id.replace(/[^a-z0-9]/gi, '')}`;

  // 同一刻的多次修改 (表格整列粘贴数量会一格一格调) 合成一次, 不会互相覆盖
  const patch = (key, p, what) => {
    if (!queue.current) {
      queue.current = { items: [], what };
      queueMicrotask(() => {
        const q = queue.current; queue.current = null;
        let next = latest.current;
        for (const [k, pp] of q.items) next = next.map((l) => (l.key === k ? { ...l, ...pp } : l));
        h.commit(next, q.items.length > 1 ? `改了 ${q.items.length} 格` : q.what);
      });
    }
    queue.current.items.push([key, p]);
  };
  // 一行重新落定: 编码 / 种类 + 机型 → 物料 / 多个 / 没建档
  const settle = (l) => {
    if (l.product) return l;
    const r = resolve({ code: l.code_in, category_id: l.category_id, model: l.model });
    if (r.product) {
      const st = [...r.product.stock].sort((a, b) => (b.on_hand - b.reserved) - (a.on_hand - a.reserved))[0];
      return { key: l.key, product: r.product, qty_req: l.qty_req || '0', stock_item_id: st?.stock_item_id || '', note: l.note || '' };
    }
    return { ...l, model: normModel(l.model), status: r.status === 'unmet' || r.status === 'blank' ? undefined : r.status, cands: r.cands, hint: r.hint };
  };

  const add = (p, quiet) => {
    const i = latest.current.findIndex((l) => l.product?.id === p.id);
    if (i >= 0) { if (!quiet) toast(`${p.model} ${p.category} 已在第 ${i + 1} 行，直接改数量即可`, 'err'); return false; }
    const st = [...p.stock].sort((a, b) => (b.on_hand - b.reserved) - (a.on_hand - a.reserved))[0];
    const next = [...latest.current, { key: newKey(), product: p, qty_req: '0', stock_item_id: st?.stock_item_id || '', note: '' }];
    latest.current = next;
    h.commit(next, `添加 ${p.model}`);
    if (!quiet) toast(`已添加 ${p.model} · ${p.category}（第 ${next.length} 行）`);
    return true;
  };
  const addMany = (items) => {   // [{product, qty}]
    let next = [...latest.current]; let n = 0, dup = 0;
    for (const { product: p, qty: q } of items) {
      if (next.some((l) => l.product?.id === p.id)) { dup++; continue; }
      const st = [...p.stock].sort((a, b) => (b.on_hand - b.reserved) - (a.on_hand - a.reserved))[0];
      next.push({ key: newKey(), product: p, qty_req: String(q || 0), stock_item_id: st?.stock_item_id || '', note: '' }); n++;
    }
    h.commit(next, `选货清单加 ${n} 行`);
    toast(`已加 ${n} 行${dup ? `，${dup} 个已经在明细里没重复加` : ''}`);
  };
  const addBlank = () => {
    const n = Math.min(500, Math.max(1, Number(addN) || 1));
    h.commit([...latest.current, ...Array.from({ length: n }, BLANK)], `加 ${n} 行`);
    setTimeout(() => document.querySelector(`#${gid} [data-code="${latest.current.length - n}"]`)?.focus({ preventScroll: true }), 50);
  };
  // 粘贴一块: 从第 i 行的「编码 / 种类 / 机型」格开始, 往下填 (后面的物料行跳过, 不够就加行)
  const pasteBlock = (startKey, col, text) => {
    const rows = pasteRows(text).filter((r) => r.some(Boolean));
    let next = [...latest.current];
    let i = next.findIndex((l) => l.key === startKey);
    const touched = [];
    for (const cells of rows) {
      while (i < next.length && next[i].product) i++;
      if (i >= next.length) next.push(BLANK());
      const l = { ...next[i], status: undefined, cands: undefined };
      const qtyCell = cells.find((c, j) => j > 0 && isQty(c));
      if (col === 'code') { l.code_in = cells[0].toUpperCase(); }
      else if (col === 'category') {
        const cid = catByName.get(String(cells[0]).toUpperCase());
        if (cid) l.category_id = cid;
        if (cells[1] && !isQty(cells[1])) l.model = cells[1];
      } else { l.model = cells[0]; }
      if (qtyCell) l.qty_req = String(Math.round(Number(String(qtyCell).replace(',', '.'))));
      next[i] = l; touched.push(i); i++;
    }
    next = next.map((l, j) => (touched.includes(j) ? settle(l) : l));
    const st = touched.map((j) => lineStatus(next[j]));
    const [m, merged] = mergeDup(next);
    h.commit(m, `粘贴 ${rows.length} 行`);
    const c = (s) => st.filter((x) => x === s).length;
    toast(`粘贴了 ${rows.length} 行：对上编码 ${c('ok')}${merged ? `（${merged} 行明细里已有，数量加到原来那行）` : ''}${c('needcat') ? ` · 要选种类 ${c('needcat')}` : ''}${c('multi') ? ` · 多个编码要挑 ${c('multi')}` : ''}${c('unmet') ? ` · 没建档转补录 ${c('unmet')}` : ''}${c('badcode') ? ` · 编码不存在 ${c('badcode')}` : ''}`);
  };
  const setDraft = (l, p, what) => {
    const [next, merged] = mergeDup(latest.current.map((x) => (x.key === l.key ? settle({ ...x, ...p, status: undefined, cands: undefined }) : x)));
    h.commit(next, `${nameOf(l)} ${what}`);
    if (merged) toast('这个型号明细里已经有了，数量已经加到原来那行');
  };
  const setCatSelected = (cid) => {
    const keys = sel; let n = 0;
    const [next, merged] = mergeDup(latest.current.map((l) => { if (!keys.has(l.key) || l.product) return l; n++; return settle({ ...l, category_id: cid, status: undefined, cands: undefined }); }));
    h.commit(next, `批量设种类 ${n} 行`); setSel(new Set());
    toast(n ? `已给 ${n} 行设种类，能对上的已经带出编码${merged ? `；${merged} 行明细里已有，数量加到原来那行` : ''}` : '勾选的行里没有要设种类的（已经对上编码的行不用设）');
  };

  // ── 飞书式: 格子里不放输入框, 白底黑字; 双击 / 回车 / 直接打字才打开编辑 (种类、型号是带搜索的下拉) ──
  const [editing, setEditing] = useState(null);   // {key, col, init}
  const selRange = useRef({ rows: [], cols: [] });
  const DRAFT_COLS = ['code', 'category', 'model'];
  const PLAIN_COLS = ['qty_req', 'note'];   // 每一行都能改 (Excel: 点一下选中, 直接打字就改, 双击 / 回车改原来的值)
  const gridApi = useRef(null);
  const catName = (cid) => categories.find((c) => c.id === cid)?.name || '';
  const applyCells = (keys, col, value, label) => {   // 一格或选中的一段格子一起改
    const ks = new Set(keys); let n = 0;
    const [next, merged] = mergeDup(latest.current.map((l) => {
      if (!ks.has(l.key) || l.product) return l; n++;
      const p = col === 'code' ? { code_in: String(value).trim().toUpperCase() } : col === 'category' ? { category_id: value } : { model: normModel(value), code_in: '' };
      return settle({ ...l, ...p, status: undefined, cands: undefined });
    }));
    if (!n) return;
    h.commit(next, n > 1 ? `${label} ${n} 行` : label);
    if (merged) toast(`${merged} 行明细里已经有了，数量已经加到原来那行`);
  };
  const priceEditable = canPrice || priceMode === 'request';
  const openCell = (row, col, ch) => {
    if (col === 'price') {   // 单价: 中方直接改 / 员工申请价 (11-09 修: 以前这一列根本进不了编辑)
      if (!priceEditable || !row.product) return;
      if (ch != null && !/[\d.]/.test(ch)) return;
      setEditing({ key: row.key, col, init: ch ?? null });
      return;
    }
    if (PLAIN_COLS.includes(col) || (DRAFT_COLS.includes(col) && !row.product)) {
      if (col === 'qty_req' && ch != null && !/\d/.test(ch)) return;
      setEditing({ key: row.key, col, init: ch ?? null });
    }
  };
  const commitCell = (row, col, value, how) => {
    setEditing(null);
    if (how === 'enter') setTimeout(() => gridApi.current?.select(row.key, col, 1), 0);   // 回车 = 跳到下一行同一列
    else setTimeout(() => gridApi.current?.select(row.key, col, 0), 0);
    if (value == null) return;
    const inSel = selRange.current.cols.includes(col) && selRange.current.rows.length > 1 && selRange.current.rows.some((r) => r.key === row.key);
    const keys = inSel ? selRange.current.rows.map((r) => r.key) : [row.key];
    if (col === 'price') {
      const v = String(value).replace(/[^\d.]/g, ''); const k = canPrice ? 'unit_price' : 'req_price';
      const ks = new Set(keys.filter((kk) => latest.current.find((l) => l.key === kk)?.product));
      h.commit(latest.current.map((l) => (ks.has(l.key) ? { ...l, [k]: v } : l)), `${nameOf(row)} 改价`);
      toast(!v ? '已清掉改价，回到档位价' : canPrice ? '已改价（中方直接生效，单上标「手改」，保存前会再提示一次）' : '已记申请价：保存后要中方审批，批了才能往下推');
      return;
    }
    if (PLAIN_COLS.includes(col)) {
      const v = col === 'qty_req' ? String(value).replace(/[^\d]/g, '') : value;
      const ks = new Set(keys);
      h.commit(latest.current.map((l) => (ks.has(l.key) ? { ...l, [col]: v } : l)), keys.length > 1 ? `改了 ${keys.length} 行${col === 'qty_req' ? '数量' : '备注'}` : `${nameOf(row)} 改${col === 'qty_req' ? '数量' : '备注'}`);
      return;
    }
    if (col === 'model' && lineStatus(row) === 'multi' && value.startsWith('#')) {   // 多个编码里挑一个
      const p = catalog.find((x) => x.id === value.slice(1));
      if (p) applyCells([row.key], 'code', p.code, `${row.model} 选编码 ${p.code}`);
      return;
    }
    applyCells(keys, col, value, { code: '填编码', category: '设种类', model: '填机型' }[col]);
  };
  const onPasteSel = (row, col, text, rows) => {
    const single = !/[\t\n]/.test(text.trim());
    if (DRAFT_COLS.includes(col)) {
      if (single && rows.length > 1) {   // 一个值粘到选中的一段 = 全部填这个值
        const v = col === 'category' ? (catByName.get(text.trim().toUpperCase()) || '') : text.trim();
        if (col === 'category' && !v) return toast(`没有「${text.trim()}」这个种类`, 'err');
        return applyCells(rows.map((r) => r.key), col, v, '粘贴');
      }
      return pasteBlock(row.key, col, text);
    }
    if (col === 'price' && priceEditable) {
      const vals = pasteRows(text).map((r) => String(r[0]).replace(/[^\d.]/g, ''));
      const keys = latest.current.map((l) => l.key); const i0 = keys.indexOf(row.key);
      const targets = single && rows.length > 1 ? rows.map((r) => r.key) : keys.slice(i0, i0 + vals.length);
      const k = canPrice ? 'unit_price' : 'req_price';
      h.commit(latest.current.map((l) => { const j = targets.indexOf(l.key); if (j < 0 || !l.product) return l; return { ...l, [k]: single ? vals[0] : vals[j] }; }), `粘贴单价 ${targets.length} 行`);
      return;
    }
    if (col === 'qty_req' || col === 'note') {
      const vals = pasteRows(text).map((r) => r[0]);
      const keys = latest.current.map((l) => l.key); const i0 = keys.indexOf(row.key);
      const targets = single && rows.length > 1 ? rows.map((r) => r.key) : keys.slice(i0, i0 + vals.length);
      const next = latest.current.map((l) => { const j = targets.indexOf(l.key); if (j < 0) return l; const v = single ? vals[0] : vals[j]; return { ...l, [col]: col === 'qty_req' ? String(v).replace(/[^\d]/g, '') : v }; });
      h.commit(next, `粘贴${col === 'qty_req' ? '数量' : '备注'} ${targets.length} 行`);
    }
  };
  const onClearSel = (rows, colKeys) => {
    const ks = new Set(rows.map((r) => r.key));
    const next = latest.current.map((l) => {
      if (!ks.has(l.key)) return l;
      let x = { ...l };
      if (colKeys.includes('qty_req')) x.qty_req = '0';
      if (!l.product && colKeys.some((c) => DRAFT_COLS.includes(c))) {
        if (colKeys.includes('code')) x.code_in = '';
        if (colKeys.includes('category')) x.category_id = '';
        if (colKeys.includes('model')) x.model = '';
        x = settle({ ...x, status: undefined, cands: undefined });
      }
      return x;
    });
    h.commit(next, '清空选中的格子');
  };
  const onSelChange = (rows, colKeys) => {
    selRange.current = { rows, cols: colKeys };
    if (drafts) setSel(new Set(rows.map((r) => r.key)));   // 选了格子 = 勾选这几行; 再点一次 = 取消
  };

  const cols = useMemo(() => {
    const cell = (l, col, text) => (editing?.key === l.key && editing.col === col
      ? <CellEditor kind={col} row={l} init={editing.init} categories={categories} catalog={catalog}
          onCommit={(v, how) => commitCell(l, col, v, how)} onCancel={() => { setEditing(null); setTimeout(() => gridApi.current?.select(l.key, col, 0), 0); }} />
      : <span className="cell-txt">{text}</span>);
    return [
      { key: 'code', label: '编码', w: 86, value: (l) => (l.product ? l.product.code : l.code_in || ''),
        render: (l) => (l.product ? <span className="mono">{l.product.code}</span> : cell(l, 'code', <span className="mono">{l.code_in || ''}</span>)) },
      { key: 'category', label: '种类', w: 110, value: (l) => (l.product ? l.product.category : catName(l.category_id)),
        render: (l) => (l.product ? l.product.category : cell(l, 'category', catName(l.category_id))) },
      { key: 'model', label: '型号', w: 130, value: (l) => (l.product ? l.product.model : l.model || ''), render: (l) => {
        if (l.product) return <><b style={{ fontSize: 14 }} className={openP ? 'linkbtn' : ''} title={openP ? '点开看物料档案（通用性 / 价格 / 库存）' : undefined} onClick={openP ? (e) => { e.stopPropagation(); openP(l.product); } : undefined}>{l.product.model}</b></>;
        return cell(l, 'model', <b style={{ fontSize: 14 }}>{l.model || ''}</b>);
      } },
      { key: 'shared', label: '通用性', w: 150, value: (l) => (l.product ? (l.product.shared_models || []).join(' / ') : ''), render: (l) => {
        if (l.product) return <Shared list={l.product.shared_models} />;
        const s = lineStatus(l);
        return s === 'unmet' ? <span className="pill amber" title="会记进「未满足需求」，用来备货">没建档 → 补录需求</span>
          : s === 'multi' ? <span className="pill amber" title="双击型号那格挑编码">{l.cands.length} 个编码，双击型号挑</span>
          : s === 'badcode' ? <span className="pill red">编码不存在</span>
          : s === 'needcat' ? <span className="pill red">要选种类</span> : null;
      } },
      { key: 'wh', label: '仓库 / 库位', w: 110, value: (l) => { if (!l.product) return ''; const st = l.product.stock.find((x) => x.stock_item_id === l.stock_item_id) || l.product.stock[0]; return st ? `${st.warehouse} · ${st.bin || ''}` : ''; }, render: (l) => {
        if (!l.product) return null;
        if (l.product.stock.length <= 1) { const s = l.product.stock[0]; return s ? `${s.warehouse} · ${s.bin || ''}` : <span className="pill red">无库存行</span>; }
        return <select className="cell-in" value={l.stock_item_id} onChange={(e) => patch(l.key, { stock_item_id: e.target.value }, `${nameOf(l)} 换仓`)}>
          {l.product.stock.map((s) => <option key={s.stock_item_id} value={s.stock_item_id}>{s.warehouse} · 可售 {s.on_hand - s.reserved}</option>)}</select>;
      } },
      { key: 'on_hand', label: '实存', w: 60, value: (l) => (l.product ? stockOf(l).on_hand : null), render: (l) => (l.product ? qty(stockOf(l).on_hand) : null) },
      { key: 'reserved', label: '预占', w: 60, value: (l) => (l.product ? stockOf(l).reserved : null), render: (l) => (l.product ? qty(stockOf(l).reserved) : null) },
      { key: 'avail', label: '可售', w: 120, value: (l) => (l.product ? stockOf(l).on_hand - stockOf(l).reserved : null), render: (l) => { if (!l.product) return null; const a = stockOf(l).on_hand - stockOf(l).reserved; const need = Number(l.qty_req) || 0; return <span><b style={{ color: a < need ? 'var(--red)' : '' }}>{qty(a)}</b>{need > Math.max(a, 0) && <span className="pill amber" style={{ marginLeft: 4 }} title="客户要的比库存多：需求数量照实填，差的自动记进未满足需求（备货依据）">缺 {qty(need - Math.max(a, 0))}</span>}</span>; } },
      { key: 'qty_req', label: '需求数量', w: 96, type: 'number', fill: true, value: (l) => Number(l.qty_req) || 0,
        render: (l) => cell(l, 'qty_req', <span className={showErrors && lineStatus(l) !== 'blank' && !(Number(l.qty_req) > 0) ? 'red-t' : ''}>{l.qty_req === '' ? '' : Number(l.qty_req) || 0}</span>) },
      ...(showPrice ? [
        { key: 'price', label: `单价 ${currency}`, w: 120, value: (l) => (l.product ? priceOf(l, tier, fx) : null),
          render: (l) => (!l.product ? null : cell(l, 'price', (() => { const fl = canPrice ? priceFlag(l, tier, fx) : null; return fl ? <span className={fl === '会亏' ? 'price-low' : 'price-warn'}>{money(shownPrice(l, tier, fx), currency)} <Bang tone={fl === '会亏' ? 'red' : 'amber'}>{lowTip({ fl, px: (fx > 0 ? fx : 1) * (Number(l.req_price) > 0 ? Number(l.req_price) : Number(l.unit_price)), cost: Number(l.product.cost_xof || 0), s: Number(l.product.prices?.S || 0), tier: Number(l.product.prices?.[tier] || 0) }, (v) => `${money(v)} XOF`)}</Bang>{Number(l.req_price) > 0 && <span className="pill amber">申请</span>}</span> : null; })() || (Number(l.req_price) > 0
            ? <span className="amber-t2" title={`员工申请价，等中方审批（档位价 ${money(tierPrice(l, tier, fx), currency)}）`}>{money(l.req_price, currency)} <span className="pill amber">申请 · 待批</span></span>
            : <span className={Number(l.unit_price) > 0 ? 'amber-t2' : ''} title={Number(l.unit_price) > 0 ? `手改价（档位价 ${money(tierPrice(l, tier, fx), currency)}）` : priceEditable ? '点一下选中，直接打数字改价' : ''}>{money(priceOf(l, tier, fx), currency)}{Number(l.unit_price) > 0 ? <span className="pill amber" style={{ marginLeft: 4 }}>手改</span> : ''}</span>))),
          tint: true, ...(priceEditable ? { type: 'number', fill: true } : {}) },   // 282: 需求数量 / 单价 / 总价 三列一个颜色
        { key: 'total', label: '总价', w: 100, tint: true, value: (l) => (l.product ? (Number(l.qty_req) || 0) * shownPrice(l, tier, fx) : null), render: (l) => (l.product ? <b>{money((Number(l.qty_req) || 0) * shownPrice(l, tier, fx), currency)}</b> : null) },
      ] : []),
      { key: 'note', label: '备注', w: 140, plain: true, value: (l) => l.note || '', render: (l) => cell(l, 'note', l.note || '') },
    ];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, tier, showErrors, showPrice, categories, catalog, editing, canPrice, priceMode, onProductOpen, fx, currency]);

  const t = lineTotals(lines, tier, showPrice, fx);
  const drafts = lines.filter((l) => !l.product).length;
  const selDrafts = lines.filter((l) => sel.has(l.key) && !l.product).length;
  const picked = useMemo(() => new Set(lines.filter((l) => l.product).map((l) => l.product.id)), [lines]);
  return (
    <>
      <div className="card-b sticky-pick" style={{ borderBottom: '1px solid var(--line-2)' }}>
        <ModelPicker catalog={catalog} categories={categories} tier={tier} onPick={(p) => add(p)} picked={picked} showPrice={showPrice}
          onUnpick={(p) => { const next = latest.current.filter((x) => x.product?.id !== p.id); latest.current = next; h.commit(next, `去掉 ${p.model}`); toast(`已去掉 ${p.model}`); }}
          extra={<>
            <button type="button" className="btn" onClick={() => setPickList(true)} title="大表格勾选，一次加很多">☰ 选货清单</button>
            <button type="button" className="btn" onClick={() => setUnmet(true)} title="客户要的型号我们没有建档 → 记录为未满足需求">＋ 补录需求</button>{extraTools}</>} />
      </div>
      <div ref={scope} id={gid}><Grid id={id}
        tools={<>
          <UndoBar h={h} scope={scope} />
          <span className="addrow">
            <button type="button" className="btn sm primary" onClick={addBlank} title="加空白行：填编码，或选种类 + 填机型；也可以整列粘贴">＋ 加行</button>
            <input className="in" inputMode="numeric" value={addN} onChange={(e) => setAddN(e.target.value.replace(/\D/g, ''))} onFocus={(e) => e.target.select()} title="一次加几行，默认 1 行" aria-label="加几行" />
            <span className="small muted">行</span>
          </span>
          {selDrafts > 0 && <select className="in" style={{ maxWidth: 170 }} value="" onChange={(e) => e.target.value && setCatSelected(e.target.value)}>
            <option value="">批量设种类（{selDrafts} 行）</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        </>}
        columns={cols} rows={lines} rowKey={(l) => l.key} selectable={drafts > 0 ? { selected: sel, onChange: setSel } : undefined} errors={errors}
        onCellOpen={openCell} onPasteSel={onPasteSel} onClearSel={onClearSel} onSelChange={onSelChange} api={gridApi}
        rowClass={(l) => (showErrors && lineStatus(l) !== 'blank' && !(Number(l.qty_req) > 0) ? 'warn' : '')}
        onDelete={(l, i, rs) => { const ks = new Set((rs || [l]).map((x) => x.key)); const n = ks.size; h.commit(latest.current.filter((x) => !ks.has(x.key)), n === 1 ? `删除 ${nameOf(l)}` : `删除 ${n} 行`); toast(n === 1 ? `已删除 ${nameOf(l)}，可点「← 撤销」恢复` : `已删除 ${n} 行，可点「← 撤销」恢复`); }}
        empty="用上面的搜索框或「选货清单」加型号；手写 / Excel 清单点「＋ 加行」后整列粘贴；客户要了但我们没建档的会自动变成补录需求"
        foot={{ code: '合计', model: `${t.n} 个型号`, qty_req: `${qty(t.pcs)} 件`, total: showPrice ? `${money(t.amt, currency)} ${currency}` : '' }} /></div>
      {drafts > 0 && <div className="hint small" style={{ padding: '6px 14px' }}>空白行像飞书一样用：点格子选中（按住往下拖选一段，再点一次取消），⌘C 复制、⌘V 粘贴（一个值粘到选中的一段 = 全部填这个值），双击 / 回车 / 直接打字开始填；种类、型号是带搜索的下拉；选中一段后直接打字或按回车选 = 这一段一起改；Delete 清空。</div>}
      {unmet && <UnmetModal catalog={catalog} categories={categories} onClose={() => setUnmet(false)}
        onUseProduct={(p) => { setUnmet(false); add(p); }}
        onAdd={(cat, model, n) => { setUnmet(false); h.commit([...latest.current, { key: newKey(), product: null, category_id: cat, model, qty_req: String(n || 0), note: '' }], `补录 ${model}`); toast(`已记录未建档需求 ${model}`); }} />}
      {pickList && <PickList catalog={catalog} categories={categories} picked={picked} onClose={() => setPickList(false)} onAdd={(items) => { addMany(items); setPickList(false); }} />}
    </>
  );
}

// 格子编辑: 编码 = 输入框; 种类 / 型号 = 带搜索的下拉 (白底黑字, 和上面搜索框一样); 型号可以填没建档的 (变补录需求)
function CellEditor({ kind, row, init, categories, catalog, onCommit, onCancel }) {
  const multi = kind === 'model' && lineStatus(row) === 'multi';
  const plain = ['code', 'qty_req', 'note', 'price'].includes(kind);
  const start = init ?? (kind === 'price' ? String((Number(row.req_price) > 0 ? row.req_price : row.unit_price) || '') : kind === 'code' ? row.code_in || '' : kind === 'qty_req' ? String(row.qty_req ?? '') : kind === 'note' ? row.note || '' : kind === 'category' ? '' : multi ? '' : row.model || '');
  const [text, setText] = useState(start);
  const [focus, setFocus] = useState(0);
  const ref = useRef(); const box = useRef();
  const [pos, setPos] = useState(null);
  useEffect(() => { ref.current?.focus(); if (init == null) ref.current?.select(); const r = box.current?.getBoundingClientRect(); if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 260) }); }, [init]);
  const T = text.trim().toUpperCase();
  const options = kind === 'category' ? categories.filter((c) => !T || c.name.toUpperCase().includes(T)).map((c) => ({ v: c.id, l: c.name }))
    : multi ? row.cands.map((id) => catalog.find((p) => p.id === id)).filter(Boolean).filter((p) => !T || `${p.code} ${p.model} ${p.variant || ''}`.toUpperCase().includes(T))
      .map((p) => ({ v: '#' + p.id, l: `${p.code} · ${p.model}${p.variant ? ' ' + p.variant : ''}`, r: `可售 ${avail(p)}` }))
    : kind === 'model' ? [...new Set(catalog.filter((p) => (!row.category_id || p.category_id === row.category_id) && (!T || p.model.includes(T) || p.shared_models.some((x) => x.includes(T)))).map((p) => p.model))]
      .sort((a, b) => (b.startsWith(T) - a.startsWith(T)) || a.localeCompare(b)).slice(0, 60).map((m) => ({ v: m, l: m }))
    : [];
  if (kind === 'model' && !multi && T && !options.some((o) => o.v === normModel(T))) options.push({ v: normModel(T), l: `「${normModel(T)}」没建档 → 记为补录需求`, muted: true });
  const committed = useRef(false);
  const done = (v, how) => { if (committed.current) return; committed.current = true; onCommit(v, how); };
  const enter = (how) => {
    if (plain) return done(text, how);
    if (options[focus]) return done(options[focus].v, how);
    committed.current = true; onCancel();
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); committed.current = true; onCancel(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); enter(e.key === 'Enter' ? 'enter' : 'tab'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => Math.min(f + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => Math.max(f - 1, 0)); }
  };
  return (
    <span ref={box} className="cell-pop" onPointerDown={(e) => e.stopPropagation()}>
      <input ref={ref} className="cell-in" value={text} inputMode={kind === 'qty_req' ? 'numeric' : kind === 'price' ? 'decimal' : undefined} placeholder={multi ? '挑一个编码' : ''}
        style={kind === 'qty_req' ? { textAlign: 'center' } : kind === 'price' ? { textAlign: 'right' } : null}
        onChange={(e) => { setText(kind === 'code' ? e.target.value.toUpperCase() : kind === 'qty_req' ? e.target.value.replace(/[^\d]/g, '') : kind === 'price' ? e.target.value.replace(/[^\d.]/g, '') : e.target.value); setFocus(0); }}
        onKeyDown={key} onBlur={() => setTimeout(() => { if (document.activeElement !== ref.current && !committed.current) { if (plain) done(text, 'blur'); else { committed.current = true; onCancel(); } } }, 150)} />
      {!plain && pos && createPortal(
        <div className="sugg cellsugg" style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, right: 'auto' }} onPointerDown={(e) => e.preventDefault()}>
          {options.length === 0 && <div className="empty small">{kind === 'model' ? (T ? `没有 ${T}，回车就按没建档记（补录需求）` : '输机型，包含就出来') : '没有这个种类'}</div>}
          {options.map((o, i) => (
            <button type="button" key={o.v} className={i === focus ? 'focus' : ''} onMouseEnter={() => setFocus(i)} onClick={() => done(o.v, 'click')}>
              <span className={o.muted ? 'muted' : 'm'}>{o.l}</span>{o.r && <span className="small muted">{o.r}</span>}</button>))}
        </div>, document.body)}
    </span>
  );
}

const stockOf = (l) => l.product.stock.find((s) => s.stock_item_id === l.stock_item_id) || { on_hand: 0, reserved: 0 };

// 选货清单: 编码 | 种类 | 机型 | 通用性 | 可售 (不放价格: 价格跟客户档位走), 勾选 + 数量, 点「加入」才关
export function PickList({ catalog, categories, picked, onClose, onAdd, stockLabel }) {
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState({});   // id → qty string
  const t = text.trim().toUpperCase();
  const all = catalog.filter((p) => (!cat || p.category_id === cat) && (!t || p.model.includes(t) || String(p.code).toUpperCase().includes(t) || (p.shared_models || []).some((s) => s.includes(t))));
  // 230: 库存多的排前面 (客户端按 有货 → 可预订)
  const rk = (p) => (p.band ? { ok: 1e9, low: 1e8, none: 0 }[p.band] : avail(p));
  const list = [...all].sort((a, b) => rk(b) - rk(a)).slice(0, 300);
  const n = Object.keys(chosen).length;
  const toggle = (p) => setChosen((c) => { const x = { ...c }; if (p.id in x) delete x[p.id]; else x[p.id] = ''; return x; });
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <Modal wide title="选货清单" onClose={onClose}
      footer={<><span className="small muted">已选 {n} 个型号；数量可以先空着，加进去再填</span><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>关闭</button>
        <button type="button" className="btn primary" disabled={!n} onClick={() => onAdd(Object.entries(chosen).map(([id, q]) => ({ product: catalog.find((p) => p.id === id), qty: Number(q) || 0 })))}>加入（{n}）</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="chips"><button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>全部</button>
          {categories.map((c) => <button type="button" key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}</div>
        <input className="in" autoFocus placeholder="⌕ 机型 / 编码 / 通用机型，包含就出来" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="picklist">
          <Grid id="picklist" noTools maxHeight={420} rows={list} rowClass={(p) => (p.id in chosen ? 'on' : picked?.has(p.id) ? 'done' : '')}
            selectable={{ selected: new Set([...Object.keys(chosen), ...list.filter((p) => picked?.has(p.id)).map((p) => p.id)]), onChange: (set) => setChosen((c) => { const x = {}; for (const id of set) if (!picked?.has(id)) x[id] = c[id] ?? ''; return x; }) }}
            columns={[
              { key: 'code', label: '编码', w: 90, mono: true, value: (p) => p.code },
              { key: 'category', label: '种类', w: 110, value: (p) => p.category },
              { key: 'model', label: '机型', w: 140, value: (p) => p.model, render: (p) => <><b>{p.model}</b></> },
              { key: 'shared', label: '通用性', w: 160, value: (p) => (p.shared_models || []).join(' / '), render: (p) => <Shared list={p.shared_models} /> },
              { key: 'avail', label: stockLabel || '可售', w: 80, align: 'center', value: (p) => (p.band ? { ok: '有货', low: '有货', none: '可预订' }[p.band] : avail(p)),
                render: (p) => (p.band ? <span className={`pill ${{ ok: 'green', low: 'green', none: 'amber' }[p.band]}`}>{{ ok: '有货', low: '有货', none: '可预订' }[p.band]}</span> : <StockPill n={avail(p)} />) },
              { key: 'qty', label: '数量', w: 90, fill: true, value: (p) => (picked?.has(p.id) ? '已在明细' : chosen[p.id] ?? ''), render: (p) => (picked?.has(p.id) ? <span className="small muted">已在明细</span> : p.id in chosen ? (chosen[p.id] || <span className="muted">数量</span>) : ''),
                edit: (p) => (picked?.has(p.id) ? null : { type: 'number', value: chosen[p.id] ?? '', onChange: (v) => setChosen((c) => ({ ...c, [p.id]: String(v ?? '').replace(/\D/g, '') })) }) },
            ]} />
          {all.length > list.length && <div className="hint" style={{ padding: 8 }}>一共 {all.length} 个，只显示前 {list.length} 个，选种类或搜索缩小范围</div>}
          {!all.length && <div className="empty">没有匹配的物料</div>}
        </div>
      </div>
    </Modal>
  );
}

// 补录需求：先选种类，再选/输型号，自动大写，有相似的提示
function UnmetModal({ catalog, categories, onClose, onAdd, onUseProduct }) {
  const [cat, setCat] = useState('');
  const [model, setModel] = useState('');
  const [n, setN] = useState('');
  const typed = model.toUpperCase();
  const M = typed.trim().replace(/\s+/g, ' ');
  const inCat = catalog.filter((p) => p.category_id === cat);
  const exact = inCat.find((p) => p.model === M);
  const similar = M.length >= 2 ? inCat.filter((p) => p.model !== M && (norm(p.model) === norm(M) || norm(p.model).includes(norm(M)) || dist(norm(p.model), norm(M)) <= 2)).slice(0, 6) : [];
  const otherCat = M ? catalog.filter((p) => p.category_id !== cat && p.model === M) : [];
  return (
    <Modal title="补录客户需求（我们没有的型号）" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!cat || !M || !!exact} onClick={() => onAdd(cat, M, Number(n) || 0)}>记录为未建档需求</button></>}>
      <div className="stack">
        <div className="field req"><label>① 先选种类</label>
          <div className="chips">{categories.map((c) => <button type="button" key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}</div></div>
        <div className="field req"><label>② 再填型号（自动转大写）</label>
          <input className="in" disabled={!cat} value={typed} onChange={(e) => setModel(e.target.value)} placeholder={cat ? '例如 SPARK 30 PRO' : '请先选种类'} list="unmet-models" />
          <datalist id="unmet-models">{inCat.map((p) => <option key={p.id} value={p.model} />)}</datalist></div>
        {exact && <div className="lock">这个型号已经建档（编码 {exact.code}，可售 {avail(exact)}）。<button type="button" className="btn sm" onClick={() => onUseProduct(exact)}>直接用它</button></div>}
        {!exact && similar.length > 0 && <div className="lock">有相似型号，是不是这些？{similar.map((p) => <button type="button" key={p.id} className="btn sm" style={{ margin: '4px 4px 0 0' }} onClick={() => onUseProduct(p)}>{p.model}（{p.code}）</button>)}</div>}
        {!exact && otherCat.length > 0 && <div className="hint">提示：{M} 在其他种类有货：{otherCat.map((p) => p.category).join('、')}。客户要的种类没有，就记录在这里，用于备货。</div>}
        <div className="field"><label>③ 客户要的数量</label><input className="in" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} placeholder="0" style={{ maxWidth: 160 }} /></div>
        <div className="hint">记录后：报价单上该行单价为 0，不会出货；这条需求自动进入「未满足需求」，作为备货申请的依据。</div>
      </div>
    </Modal>
  );
}
