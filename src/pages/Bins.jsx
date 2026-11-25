// 510 (Frank 11-24): 库位与上架 —— 库位 = 房间 - 货架 - 层 (例 SS-A-1; LR / SLR 只有房间名); 布局 ⚙ 可改 (以后会加 / 减货架)
// 一个库位能放几个型号, 每个型号记片数; 出到 0 这个位置就空出来, 以前放过什么都留记录 (bin_log)
// 上架: 新到的 / 退回来的货 (没放到库位上的) 放到库位; 补货 = 同库位同型号再放; 挪位 = 从一个库位挪到另一个
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, Choice, Info, Assumed } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ModelLink } from '../components/Archives.jsx';
import { dt, qty, friendlyError } from '../lib/format.js';
import { CountPanel } from './Count.jsx';

export const DEFAULT_ROOMS = [{ room: 'TXI', name: 'Tecno / Infinix / itel', shelves: 'ABCDEFG', levels: 4 }, { room: 'AA', name: 'iPhone', shelves: 'ABCD', levels: 4 },
  { room: 'SS', name: '三星', shelves: 'ABCD', levels: 4 }, { room: 'LR', name: 'Living Room', shelves: '', levels: 0 }, { room: 'SLR', name: 'Small Living Room', shelves: '', levels: 0 }];
export function useRooms() {
  const { org } = useApp();
  return useData(async () => (await q(`select app.bin_rooms($1) as r`, [org]))[0]?.r || DEFAULT_ROOMS, [org]).data || DEFAULT_ROOMS;
}
export const allBinCodes = (rooms) => rooms.flatMap((r) => (r.shelves ? [...r.shelves].flatMap((s) => Array.from({ length: Number(r.levels) || 0 }, (_, i) => `${r.room}-${s}-${i + 1}`)) : [r.room]));
// 没选完的写成 SS- / SS-A- (binDone 不认), 选完 = SS-A-1 或 LR
const parse = (code) => { const m = String(code || '').match(/^([A-Z0-9]+)(?:-([A-Z])?(?:-(\d+)?)?)?$/); return m ? { room: m[1], shelf: m[2] || '', level: m[3] || '' } : { room: '', shelf: '', level: '' }; };

// 选库位: 房间 → 货架 → 层 (手机上点三下, 不用打字)
export function BinPick({ value, onChange }) {
  const rooms = useRooms();
  const p = parse(value); const r = rooms.find((x) => x.room === p.room);
  const set = (room, shelf, level) => { const rr = rooms.find((x) => x.room === room); if (!rr) return onChange(''); if (!rr.shelves) return onChange(rr.room); onChange(shelf && level ? `${room}-${shelf}-${level}` : shelf ? `${room}-${shelf}-` : `${room}-`); };
  return (
    <div className="binpick">
      <Choice value={p.room} onChange={(v) => set(v, '', '')} placeholder="房间" options={rooms.map((x) => [x.room, `${x.room} · ${x.name}`])} />
      {r?.shelves && <Choice value={p.shelf} onChange={(v) => set(p.room, v, p.level)} placeholder="货架" options={[...r.shelves].map((s) => [s, `货架 ${s}`])} />}
      {r?.shelves && <Choice value={p.level} onChange={(v) => set(p.room, p.shelf, v)} placeholder="层" options={Array.from({ length: Number(r.levels) || 0 }, (_, i) => [String(i + 1), `第 ${i + 1} 层`])} />}
      {binDone(value) && <b className="binpick-code">{value}</b>}
    </div>);
}
export const binDone = (code) => /^[A-Z0-9]+(-[A-Z]-\d+)?$/.test(code || '');

// 选型号: 输编码 / 型号, 点一下选中
export function ProdPick({ products, value, onChange, autoFocus }) {
  const [t, setT] = useState('');
  const cur = products.find((p) => p.id === value);
  const hits = useMemo(() => { const k = t.trim().toUpperCase().replace(/\s+/g, ''); if (!k) return []; return products.filter((p) => [p.code, p.model, p.kingdee_code].some((x) => String(x || '').toUpperCase().replace(/\s+/g, '').includes(k))).slice(0, 8); }, [t, products]);
  if (cur) return <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="pill blue">{cur.category}</span><b>{cur.model}</b>{cur.variant && <span className="muted small">{cur.variant}</span>}<span className="muted small mono">{cur.code}</span><button type="button" className="btn sm ghost" onClick={() => { onChange(''); setT(''); }}>换</button></div>;
  return (
    <div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
      <input className="in" autoFocus={autoFocus} style={{ width: '100%' }} value={t} onChange={(e) => setT(e.target.value)} placeholder="输型号或编码，例 A10 / BG6M" />
      {hits.length > 0 && <div className="prodpick">{hits.map((p) => <button type="button" key={p.id} className="pp-row" onClick={() => { onChange(p.id); setT(''); }}><span className="pill blue">{p.category}</span><b>{p.model}</b>{p.variant && <span className="muted small">{p.variant}</span>}<span className="grow" /><span className="muted small mono">{p.code}</span></button>)}</div>}
      {t.trim() && !hits.length && <div className="small muted">没找到这个型号（新货先在物料里建档）</div>}
    </div>);
}
export const PRODUCTS_SQL = `select p.id, p.code, p.kingdee_code, p.model, p.variant, p.shared_models, c.id as category_id, c.name as category from app.products p join app.categories c on c.id = p.category_id where p.org_id = $1 and coalesce(p.active, true) order by c.sort, p.model`;

// 型号名前缀 = 品牌 (SS A05 → SS, ITEL A05 → ITEL); 没前缀的归「其他」
export const brandOf = (model) => (String(model || '').match(/^([A-Z]+)[\s_]/) || [])[1] || '其他';
export const roomBrands = (r) => String(r?.brands || '').toUpperCase().split(/[,，\s]+/).filter(Boolean);
export const shelvesOf = (rooms) => rooms.flatMap((r) => (r.shelves ? [...r.shelves].map((s) => `${r.room}-${s}`) : [r.room]));
export const binsOfShelf = (rooms, sh) => { const [room, s] = sh.split('-'); const r = rooms.find((x) => x.room === room); if (!r) return []; return r.shelves && s ? Array.from({ length: Number(r.levels) || 0 }, (_, i) => `${room}-${s}-${i + 1}`) : [room]; };

// 库位图 (Frank 11-24): 每个房间一行, 每个货架一列, 层号竖着往下排; 鼠标移上去看这层的型号 · 片数, 点开看明细
// mark(code) → 'done' | 'doing' | null (盘点时叠进度); items[code] = [{ product_id, model, category, qty }]
export function ShelfMap({ rooms, items, mark, onOpen }) {
  const tip = (code) => { const xs = items[code] || []; return xs.length ? `${code}\n${xs.map((x) => `${x.category || ''} ${x.model}  ${qty(x.qty)} 片`).join('\n')}` : `${code}：空`; };
  const cell = (code, label) => { const xs = items[code] || []; const tot = xs.reduce((a, x) => a + Number(x.qty || 0), 0); const m = mark ? mark(code) : null;
    return (<button type="button" key={code} className={`sm-cell ${xs.length ? 'has' : ''} ${m || ''}`} data-tip={tip(code)} onClick={() => onOpen && onOpen(code)}>
      <span className="sm-l">{label}{m === 'done' ? ' ✓' : m === 'doing' ? ' ◐' : ''}</span>
      {xs.length > 0 ? <span className="sm-m">{xs[0].model}{xs.length > 1 ? ` +${xs.length - 1}` : ''}</span> : <span className="sm-m muted">空</span>}
      {xs.length > 0 && <span className="sm-q">{qty(tot)}</span>}</button>); };
  return (
    <div className="sm-wrap">{rooms.map((r) => (
      <div key={r.room} className="sm-room">
        <div className="sm-rh"><b>{r.room}</b><span className="muted small">{r.name}</span></div>
        {r.shelves ? <div className="sm-shelves">{[...r.shelves].map((sh) => (
          <div key={sh} className="sm-col"><div className="sm-ch">{sh}</div>{Array.from({ length: Number(r.levels) || 0 }, (_, i) => cell(`${r.room}-${sh}-${i + 1}`, i + 1))}</div>))}</div>
          : <div className="sm-shelves"><div className="sm-col wide">{cell(r.room, r.room)}</div></div>}
      </div>))}</div>);
}
// 库位里放了什么 (库位图的数据): code → 型号列表
export function useBinItems(org) {
  return useData(async () => {
    const rs = await q(`select b.code, b.id as bin_id, i.product_id, i.qty, p.model, p.code as pcode, c.name as category from app.bins b join app.bin_items i on i.bin_id = b.id join app.products p on p.id = i.product_id
      join app.categories c on c.id = p.category_id where b.org_id = $1 and i.qty > 0 order by i.qty desc`, [org]);
    const by = {}; for (const r of rs) (by[r.code] ||= []).push(r); return by;
  }, [org]).data || {};
}

const TABS = [['map', '库位图'], ['unb', '待上架'], ['count', '盘点']];
export default function Bins({ tab: tab0 }) {
  const { org, role } = useApp();
  const admin = role === 'admin';
  const rooms = useRooms();
  const items = useBinItems(org);
  const openCount = useData(async () => (await q(`select id from app.counts where org_id = $1 and status = 'open' limit 1`, [org]))[0] || null, [org]).data;
  const [tab, setTab] = useState(tab0 || null);
  const cur = tab || (openCount && !['admin', 'manager'].includes(role) ? 'count' : 'map');
  const [put, setPut] = useState(null); const [mv, setMv] = useState(null); const [hist, setHist] = useState(null); const [lay, setLay] = useState(false); const [open, setOpen] = useState(null);
  const { data: unb } = useData(async () => q(`select u.product_id, u.on_hand, u.binned, u.on_hand - u.binned as free, p.code, p.model, p.variant, c.name as category from app.v_unbinned u join app.products p on p.id = u.product_id join app.categories c on c.id = p.category_id
         where u.org_id = $1 and u.on_hand > u.binned order by c.name, p.model`, [org]), [org]);
  const can = ['admin', 'manager', 'picker'].includes(role);
  const all = allBinCodes(rooms); const used = all.filter((c) => (items[c] || []).length).length;
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Emplacements</div><h1>库位与盘点 <Info>库位 = 房间-货架-层（例 SS-A-1）；LR / SLR 只写房间名。鼠标移到格子上看放了什么，点开看明细。</Info></h1></div>
        {admin && <button type="button" className="btn" onClick={() => setLay(true)}>⚙ 库位布局</button>}</div>
      <div className="tabs" style={{ marginBottom: 12 }}>{TABS.map(([k, l]) => <button type="button" key={k} className={cur === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'unb' && (unb || []).length > 0 ? <span className="pill amber" style={{ marginLeft: 6 }}>{unb.length}</span> : null}{k === 'count' && openCount ? <span className="pill red" style={{ marginLeft: 6 }}>进行中</span> : null}</button>)}</div>
      {cur === 'map' && <div className="card"><div className="card-h"><h2>库位图 <span className="muted small">{all.length} 个库位，有货 {used} 个，空 {all.length - used} 个</span></h2></div>
        <div className="card-b"><ShelfMap rooms={rooms} items={items} onOpen={setOpen} /></div></div>}
      {cur === 'unb' && <div className="card">
        <div className="card-h"><h2>待上架 <span className="muted small">{(unb || []).length} 个型号，{qty((unb || []).reduce((a, r) => a + Number(r.free), 0))} 片还没放到库位上</span> <Info>新到的货、退货检验好回原仓的货、出库作废退回的货，系统里有但还没放到库位上。选中一行点「上架」。</Info></h2></div>
        <Grid id="bins-unbinned" compactTools rows={unb || []} rowKey={(r) => r.product_id} empty="没有待上架的货 ✓" rowActions={can ? [{ label: '上架', run: (r) => setPut({ product_id: r.product_id, max: Number(r.free), label: `${r.category} ${r.model}` }) }] : undefined} columns={[
          { key: 'code', label: '编码', w: 100 }, { key: 'category', label: '种类', w: 90 }, { key: 'model', label: '型号', w: 150, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
          { key: 'variant', label: '区分', w: 90 }, { key: 'on_hand', label: '实存', w: 80, type: 'number' }, { key: 'binned', label: '已上架', w: 80, type: 'number' }, { key: 'free', label: '待上架', w: 80, type: 'number', sum: true, render: (r) => <b>{qty(r.free)}</b> }]} />
      </div>}
      {cur === 'count' && <CountPanel rooms={rooms} items={items} />}
      {open && <BinModal code={open} rows={items[open] || []} can={can} onClose={() => setOpen(null)} onMove={(r) => { setOpen(null); setMv({ from: open, product_id: r.product_id, max: Number(r.qty), label: `${r.category} ${r.model}` }); }} onHist={(r) => { setOpen(null); setHist({ code: open, bin_id: r?.bin_id }); }} />}
      {put && <PutModal init={put} onClose={() => setPut(null)} />}
      {mv && <MoveModal init={mv} onClose={() => setMv(null)} />}
      {hist && <HistModal bin={hist} onClose={() => setHist(null)} />}
      {lay && <LayoutModal rooms={rooms} onClose={() => setLay(false)} />}
    </>
  );
}
function BinModal({ code, rows, can, onClose, onMove, onHist }) {
  const { org } = useApp();
  const binId = useData(async () => (await q(`select id from app.bins where org_id = $1 and code = $2`, [org, code]))[0]?.id || null, [org, code]).data;
  return (
    <Modal title={`库位 ${code}`} onClose={onClose} footer={binId ? <button type="button" className="btn" onClick={() => onHist({ bin_id: binId })}>看这个库位的记录</button> : null}>
      {rows.length ? <div className="stack" style={{ gap: 6 }}>{rows.map((r) => <div key={r.product_id} className="row" style={{ gap: 8 }}>
        <span className="muted small" style={{ width: 60 }}>{r.category}</span><ModelLink id={r.product_id} model={r.model} /><span className="muted small mono">{r.pcode}</span><span className="grow" /><b>{qty(r.qty)} 片</b>
        {can && <button type="button" className="btn sm ghost" onClick={() => onMove(r)}>挪</button>}</div>)}
        <div className="small muted">点型号看物料档案（通用机型、价格、在哪些库位）。</div></div> : <div className="muted">这个库位现在是空的。</div>}
    </Modal>);
}

function PutModal({ init, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [bin, setBin] = useState(''); const [n, setN] = useState(String(init.max));
  const go = async () => { try { await call(role, `select app.bin_putaway($1,$2,$3,$4,null)`, [org, bin, init.product_id, Number(n)]); toast(`已上架：${init.label} ${n} 片 → ${bin}`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`上架 · ${init.label}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={!binDone(bin) || !(Number(n) > 0)} onClick={go}>上架</button></>}>
      <div className="stack">
        <FRow label="放到哪" req><BinPick value={bin} onChange={setBin} /></FRow>
        <FRow label="多少片" req><input className="in" inputMode="numeric" style={{ width: 120 }} value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} /><span className="small muted">最多 {qty(init.max)}</span></FRow>
        <div className="small muted">放进已经有这个型号的库位 = 补货；空库位 = 新上架。</div>
      </div>
    </Modal>);
}
function MoveModal({ init, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [to, setTo] = useState(''); const [n, setN] = useState(String(init.max));
  const go = async () => { try { await call(role, `select app.bin_move($1,$2,$3,$4,$5)`, [org, init.from, to, init.product_id, Number(n)]); toast(`已挪：${init.from} → ${to} ${n} 片`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`挪库位 · ${init.label}（从 ${init.from}）`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" disabled={!binDone(to) || !(Number(n) > 0)} onClick={go}>挪过去</button></>}>
      <div className="stack">
        <FRow label="挪到" req><BinPick value={to} onChange={setTo} /></FRow>
        <FRow label="多少片" req><input className="in" inputMode="numeric" style={{ width: 120 }} value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} /><span className="small muted">这里有 {qty(init.max)}</span></FRow>
      </div>
    </Modal>);
}
const LOG_KIND = { count: '盘点', putaway: '上架', refill: '补货', move_out: '挪走', move_in: '挪来', ship: '出库', adjust: '调整' };
function HistModal({ bin, onClose }) {
  const rows = useData(() => q(`select l.*, p.model, c.name as category from app.bin_log l left join app.products p on p.id = l.product_id left join app.categories c on c.id = p.category_id where l.bin_id = $1 order by l.at desc limit 200`, [bin.bin_id]), [bin.bin_id]).data || [];
  return (
    <Modal title={`${bin.code} 的记录`} wide onClose={onClose}>
      <Grid id="bin-hist" compactTools rows={rows} rowKey={(r) => r.id} empty="还没有记录" columns={[
        { key: 'at', label: '时间', w: 140, render: (r) => dt(r.at) }, { key: 'kind', label: '动作', w: 70, value: (r) => LOG_KIND[r.kind] || r.kind },
        { key: 'model', label: '型号', w: 160, render: (r) => <>{r.category} <ModelLink id={r.product_id} model={r.model} /></> },
        { key: 'change', label: '变动', w: 80, type: 'number', render: (r) => <span className={r.change < 0 ? 'red-t2' : ''}>{r.change > 0 ? '+' : ''}{qty(r.change)}</span> },
        { key: 'qty_after', label: '之后', w: 70, type: 'number' }, { key: 'note', label: '说明', w: 160 }]} />
    </Modal>);
}
// 库位布局: 房间 / 名字 / 货架字母 / 层数 (以后加减货架就在这里改)
function LayoutModal({ rooms, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [rs, setRs] = useState(rooms.map((r) => ({ ...r })));
  const up = (i, k, v) => setRs(rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    const clean = rs.filter((r) => r.room.trim()).map((r) => ({ room: r.room.trim().toUpperCase(), name: r.name.trim(), shelves: String(r.shelves || '').toUpperCase().replace(/[^A-Z]/g, ''), levels: r.shelves ? Number(r.levels) || 1 : 0, brands: String(r.brands || '').toUpperCase() }));
    try { await call(role, `select app.set_org_setting($1,'bin_rooms',$2)`, [org, JSON.stringify(clean)]); toast('库位布局已保存'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="库位布局" wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={save}>保存</button></>}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="lay-row small muted"><span>房间</span><span>名字</span><span>货架（字母）</span><span>层数</span><span>品牌（型号前缀）</span><span /></div>
        {rs.map((r, i) => <div key={i} className="lay-row">
          <input className="in" value={r.room} onChange={(e) => up(i, 'room', e.target.value.toUpperCase())} />
          <input className="in" value={r.name} onChange={(e) => up(i, 'name', e.target.value)} />
          <input className="in" value={r.shelves} placeholder="没货架就空着" onChange={(e) => up(i, 'shelves', e.target.value.toUpperCase())} />
          <input className="in" inputMode="numeric" value={r.levels || ''} disabled={!r.shelves} onChange={(e) => up(i, 'levels', e.target.value.replace(/\D/g, ''))} />
          <input className="in" value={r.brands || ''} placeholder="例 SS,SAMSUNG" onChange={(e) => up(i, 'brands', e.target.value.toUpperCase())} />
          <button type="button" className="btn sm ghost danger opt-del" onClick={() => setRs(rs.filter((_, j) => j !== i))}>删除</button></div>)}
        <div><button type="button" className="btn sm" onClick={() => setRs([...rs, { room: '', name: '', shelves: '', levels: 4, brands: '' }])}>＋ 加一个房间</button></div>
        <div className="small muted">例：TXI · Tecno / Infinix / itel · ABCDEFG · 4 层 → 库位 TXI-A-1 … TXI-G-4。删掉的房间 / 货架，已经记过的库位和记录照样保留。<Assumed>「T/X/I」我理解成一个房间 TXI（Tecno、Infinix、itel 放一起）。如果其实是 T、X、I 三个房间，在这里改成三行。</Assumed></div>
      </div>
    </Modal>);
}
