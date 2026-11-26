import SumBar from '../components/SumBar.jsx';
import { hasAny } from '../lib/domain.js';
import React, { useEffect, useMemo, useState } from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Shared, Pill } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { qty } from '../lib/format.js';
import { ModelLink, CustLink, EmpLink } from '../components/Archives.jsx';

import { HoldsCard, FreezeModal } from '../components/Batch2.jsx';
export default function Stock() {
  const { org } = useApp();
  const { data } = useData(() => q(Q.stock, [org]), [org]);
  const [wh, setWh] = useState('local');
  const [text, setText] = useState(() => { try { const v = sessionStorage.getItem('la9s.stock.q'); sessionStorage.removeItem('la9s.stock.q'); return v || ''; } catch { return ''; } });
  // 智能搜索跳过来（已经在库存页也生效）
  useEffect(() => { const f = () => { try { const v = sessionStorage.getItem('la9s.stock.q'); sessionStorage.removeItem('la9s.stock.q'); if (v != null) setText(v); } catch { /* ignore */ } };
    window.addEventListener('la9s-stock-q', f); return () => window.removeEventListener('la9s-stock-q', f); }, []);
  const [pick, setPick] = useState(new Set()); const [freeze, setFreeze] = useState(null);
  const { role } = useApp();
  const [sf, setSf] = useState('');   // 11-25 顶上小总览点了筛：预占的 / 断货的
  const rows0 = useMemo(() => (data || []).filter((r) => (wh === 'all' || (wh === 'local' ? r.warehouse_kind === 'local' : r.warehouse_kind !== 'local'))
    && (!text || [r.code, r.model, r.category, r.bin, ...(r.shared_models || [])].some((x) => String(x || '').toUpperCase().includes(text.toUpperCase())))), [data, wh, text]);
  const SF = { res: (r) => Number(r.qty_reserved) > 0, out: (r) => Number(r.qty_available) <= 0 };
  const rows = useMemo(() => (sf ? rows0.filter(SF[sf]) : rows0), [rows0, sf]);   // eslint-disable-line react-hooks/exhaustive-deps
  const s0 = (f) => rows0.reduce((a, r) => a + Number(r[f]), 0);
  const s = (f) => rows.reduce((a, r) => a + Number(r[f]), 0);
  const cols = [
    { key: 'warehouse', label: '仓库', w: 70, render: (r) => <Pill tone={r.warehouse_kind === 'local' ? 'blue' : 'gray'}>{r.warehouse_name}</Pill> },
    { key: 'bin', label: '库位 · 片数', w: 150, value: (r) => r.bins || r.bin || '', render: (r) => <span className="small" data-tip={r.bins ? `放在：${r.bins}` : undefined}><b>{r.bins || r.bin || ''}</b></span> },   // 11-25: 盘点 / 上架后的真实库位
    { key: 'code', label: '编码', w: 64, render: (r) => <span className="mono">{r.code}</span> },
    { key: 'category', label: '种类', w: 100 },
    { key: 'model', label: '型号', w: 90, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
    { key: 'shared', label: '通用性', w: 160, render: (r) => <Shared list={r.shared_models} /> },
    { key: 'qty_on_hand', label: '实存', w: 70, render: (r) => qty(r.qty_on_hand) },
    { key: 'qty_reserved', label: '预占', w: 70, render: (r) => (Number(r.qty_reserved) ? <b style={{ color: 'var(--amber)' }}>{qty(r.qty_reserved)}</b> : '0') },
    { key: 'qty_available', label: '可售', w: 70, render: (r) => <b style={{ color: Number(r.qty_available) <= 0 ? 'var(--red)' : '' }}>{qty(r.qty_available)}</b> },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Stock</div><h1>库存</h1>
        <div className="sub">可售 = 实存 − 预占。本地出货只用 LA / 9S；FOB、待检、报废仓永不自动参与匹配。库存变动只能由出库、退货检验、采购入库产生。</div></div>
        <div className="row">
          <div className="seg">{[['local', 'LA + 9S 本地仓'], ['other', 'FOB / 待检 / 报废'], ['all', '全部']].map(([k, l]) => <button type="button" key={k} className={wh === k ? 'on' : ''} onClick={() => setWh(k)}>{l}</button>)}</div>
          <input className="in" style={{ width: 220 }} placeholder="⌕ 型号 / 编码 / 库位 / 通用型号" value={text} onChange={(e) => setText(e.target.value)} />{text && <button type="button" className="btn sm" onClick={() => setText('')}>清除筛选</button>}
        </div>
      </div>
      <SumBar items={[
        { k: '编码', v: qty(new Set(rows0.map((r) => r.product_id)).size), unit: '个', sub: `${rows0.length} 行（同一编码在几个仓算几行）` },
        { k: '实存', v: qty(s0('qty_on_hand')), unit: '片' },
        { k: '可售', v: qty(s0('qty_available')), unit: '片', sub: '实存 − 预占' },
        { k: '预占（已有单要走）', v: qty(s0('qty_reserved')), unit: '片', sub: `${rows0.filter(SF.res).length} 行`, tone: 'amber', on: sf === 'res', onClick: () => setSf(sf === 'res' ? '' : 'res') },
        { k: '可售为 0', v: qty(rows0.filter(SF.out).length), unit: '行', sub: '断货或全被预占', tone: rows0.some(SF.out) ? 'red' : null, on: sf === 'out', onClick: () => setSf(sf === 'out' ? '' : 'out') },
      ]} />
      <HoldsCard />
      <div className="card">
        {hasAny(role, ['admin', 'manager']) && <div className="card-h"><h2>库存</h2><button type="button" className="btn sm soft-red" disabled={pick.size !== 1} title={pick.size === 1 ? '' : '先在下面勾选一行'} onClick={() => setFreeze(rows.find((r) => pick.has(r.stock_item_id)))}>⏸ 暂停出库（问题库存）</button></div>}
        {freeze && <FreezeModal row={freeze} onClose={() => { setFreeze(null); setPick(new Set()); }} />}
        <Grid id="stock" table="stock_items" columns={cols} rows={rows} rowKey={(r) => r.stock_item_id} selectable={hasAny(role, ['admin', 'manager']) ? { selected: pick, onChange: setPick } : undefined} rowClass={(r) => (Number(r.qty_available) <= 0 ? 'warn' : '')}
          foot={{ warehouse: `${rows.length} 行`, qty_on_hand: qty(s('qty_on_hand')), qty_reserved: qty(s('qty_reserved')), qty_available: qty(s('qty_available')) }} />
      </div>
    </>
  );
}
