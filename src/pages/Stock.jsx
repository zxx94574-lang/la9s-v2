import React, { useMemo, useState } from 'react';
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
  const [text, setText] = useState('');
  const [pick, setPick] = useState(new Set()); const [freeze, setFreeze] = useState(null);
  const { role } = useApp();
  const rows = useMemo(() => (data || []).filter((r) => (wh === 'all' || (wh === 'local' ? r.warehouse_kind === 'local' : r.warehouse_kind !== 'local'))
    && (!text || [r.code, r.model, r.category, r.bin, ...(r.shared_models || [])].some((x) => String(x || '').toUpperCase().includes(text.toUpperCase())))), [data, wh, text]);
  const s = (f) => rows.reduce((a, r) => a + Number(r[f]), 0);
  const cols = [
    { key: 'warehouse', label: '仓库', w: 70, render: (r) => <Pill tone={r.warehouse_kind === 'local' ? 'blue' : 'gray'}>{r.warehouse_name}</Pill> },
    { key: 'bin', label: '库位', w: 70, render: (r) => <b>{r.bin}</b> },
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
          <input className="in" style={{ width: 220 }} placeholder="⌕ 型号 / 编码 / 库位 / 通用型号" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      </div>
      <HoldsCard />
      <div className="card">
        {['admin', 'manager'].includes(role) && <div className="card-h"><h2>库存</h2><button type="button" className="btn sm soft-red" disabled={pick.size !== 1} title={pick.size === 1 ? '' : '先在下面勾选一行'} onClick={() => setFreeze(rows.find((r) => pick.has(r.stock_item_id)))}>⏸ 暂停出库（问题库存）</button></div>}
        {freeze && <FreezeModal row={freeze} onClose={() => { setFreeze(null); setPick(new Set()); }} />}
        <Grid id="stock" table="stock_items" columns={cols} rows={rows} rowKey={(r) => r.stock_item_id} selectable={['admin', 'manager'].includes(role) ? { selected: pick, onChange: setPick } : undefined} rowClass={(r) => (Number(r.qty_available) <= 0 ? 'warn' : '')}
          foot={{ warehouse: `${rows.length} 行`, qty_on_hand: qty(s('qty_on_hand')), qty_reserved: qty(s('qty_reserved')), qty_available: qty(s('qty_available')) }} />
      </div>
    </>
  );
}
