// 物料名称管理 (待改 9 / 10, 只中方): search a keyword across models, shared models and 未建档需求,
// rename / merge with a preview, set the brand. Codes never change, so history follows the new name automatically.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, OptionNote, Shared } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { can, NOTE_OPTIONS } from '../lib/domain.js';
import { friendlyError } from '../lib/format.js';

const BRANDS = ['SAMSUNG', 'ITEL', 'TECNO', 'INFINIX', 'XIAOMI', 'HUAWEI', 'APPLE'];
const PREFIX = { SS: 'SAMSUNG', ITEL: 'ITEL', TECNO: 'TECNO', INFINIX: 'INFINIX', XIAOMI: 'XIAOMI', HUAWEI: 'HUAWEI', IPHONE: 'APPLE', IP: 'APPLE' };
const norm = (s) => String(s || '').toUpperCase().trim().replace(/\s+/g, ' ');
const guessBrand = (m) => PREFIX[norm(m).split(' ')[0]] || '';   // 型号前缀带出品牌：SS A05 → SAMSUNG

export default function Materials() {
  const { org, role, toast, refresh } = useApp();
  const [kw, setKw] = useState('');
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState(new Set());
  const [rename, setRename] = useState(null);   // {to, reason}
  const [brand, setBrand] = useState(null);
  const [catMgr, setCatMgr] = useState(false);
  const { data } = useData(async () => {
    const [rows, categories] = await Promise.all([q(Q.materialSearch, [org, norm(kw)]), q(Q.categories, [org])]);
    return { rows: rows.map((r) => ({ ...r, key: `${r.src}:${r.id || r.category_id + r.model}` })), categories };
  }, [org, kw]);
  const rows = useMemo(() => (data?.rows || []).filter((r) => !cat || r.category_id === cat), [data, cat]);
  if (!can(role, 'rename_model')) return <div className="card card-b lock">物料名称管理只有中方能用（改名会影响所有历史单据的显示）。</div>;
  if (!data) return <div className="empty">加载中…</div>;
  const chosen = rows.filter((r) => sel.has(r.key));
  const groups = [...new Map(chosen.map((r) => [`${r.category_id}|${r.model}`, r])).values()];

  const doRename = async () => {
    const to = norm(rename.to);
    if (!to) return toast('请填新名称', 'err');
    let n = 0;
    try {
      for (const g of groups) if (norm(g.model) !== to) n += Number((await call(role, `select app.rename_model($1,$2,$3,$4,$5) as n`, [org, g.category_id, g.model, to, rename.reason]))[0].n);
      toast(`已改名 ${n} 处：订单都挂在编码上，历史单据自动显示新名字`); setRename(null); setSel(new Set()); refresh();
    } catch (e) { toast(friendlyError(e).replace(/^CONFLICT: /, ''), 'err'); refresh(); }
  };
  const doBrand = async () => {
    const ids = chosen.filter((r) => r.src === 'product').map((r) => r.id);
    if (!ids.length) return toast('未建档需求没有品牌列；请选已建档物料', 'err');
    try { await call(role, `select app.set_brand($1,$2,$3)`, [org, ids, brand]); toast(`已把 ${ids.length} 个物料的品牌设为 ${brand || '（空）'}`); setBrand(null); setSel(new Set()); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const cols = [
    { key: 'src', label: '来源', w: 90, render: (r) => (r.src === 'product' ? <Pill tone="blue">物料</Pill> : <Pill tone="amber">未建档需求</Pill>) },
    { key: 'code', label: '编码', w: 70, render: (r) => <span className="mono">{r.code || '—'}</span> },
    { key: 'category', label: '种类', w: 100 },
    // 11-07: 格子里直接改 (品牌选项 / 型号文本), 改一格存一格; 批量改还是用上面的按钮
    { key: 'brand', label: '品牌', w: 100, value: (r) => r.brand || '',
      edit: (r) => (r.src === 'product' ? { type: 'select', value: r.brand || '', options: [['', '（空）'], ...BRANDS.map((b) => [b, b]), ...(r.brand && !BRANDS.includes(r.brand) ? [[r.brand, r.brand]] : [])],
        onChange: async (v) => { try { await call(role, `select app.set_brand($1,$2,$3)`, [org, [r.id], v || null]); toast('已保存'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } } } : null),
      render: (r) => r.brand || (guessBrand(r.model) ? <span className="muted">{guessBrand(r.model)}?</span> : '') },
    { key: 'model', label: '型号', w: 150, value: (r) => r.model,
      edit: (r) => ({ type: 'text', value: r.model, onChange: async (v) => { const to = norm(v); if (!to || to === norm(r.model)) return; try { const n = Number((await call(role, `select app.rename_model($1,$2,$3,$4,$5) as n`, [org, r.category_id, r.model, to, '表格里直接改名']))[0].n); toast(`已改名 ${n} 处，历史单据自动显示新名字`); refresh(); } catch (e) { toast(friendlyError(e).replace(/^CONFLICT: /, ''), 'err'); refresh(); } } }),
      render: (r) => <b style={{ fontSize: 14 }}>{r.model}</b> },
    { key: 'shared', label: '通用型号', w: 180, render: (r) => <Shared list={r.shared_models} /> },
    { key: 'asked', label: '被问次数', w: 80 },
  ];
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Articles</div><h1>物料名称管理</h1>
        <div className="sub">只中方。按关键词搜型号、通用型号、未建档需求，勾选后统一改名 / 合并写法 / 设品牌。编码不变，账不受影响。</div></div>
        <button type="button" className="btn" onClick={() => setCatMgr(true)}>种类管理</button></div>
      <div className="card">
        <div className="card-b row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ minWidth: 260 }}><label>关键词（例如 A05）</label><input className="in" autoFocus value={kw} onChange={(e) => { setKw(e.target.value); setSel(new Set()); }} placeholder="型号 / 通用型号 / 未建档写法" /></div>
          <div className="field"><label>种类</label><div className="chips"><button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>全部</button>
            {data.categories.map((c) => <button type="button" key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}</div></div>
        </div>
        <Grid id="materials" table="products" columns={cols} rows={rows} rowKey={(r) => r.key} selectable={{ selected: sel, onChange: setSel }} empty={kw ? '没有含这个词的型号' : '输入关键词搜索'}
          tools={<>
            <button type="button" className="btn sm primary" disabled={!sel.size} onClick={() => setRename({ to: groups[0]?.model || '', reason: NOTE_OPTIONS.rename[0] })}>✎ 统一改名 / 合并（{sel.size}）</button>
            <button type="button" className="btn sm" disabled={!sel.size} onClick={() => setBrand(guessBrand(chosen[0]?.model) || 'SAMSUNG')}>设品牌</button>
          </>} />
        <div className="card-b hint">品牌单独一列，型号名称保留品牌前缀（SS A05 / ITEL A05 不会撞）；搜索时直接输 A05 两个都出来，输 SS A05 只出三星。未建档需求里写法不同的同一型号（SSA05S / SS A05S）改成同一个名字就合并成一条，备货统计才准。</div>
      </div>
      {rename && (
        <Modal title="统一改名 / 合并" onClose={() => setRename(null)}
          footer={<><button type="button" className="btn" onClick={() => setRename(null)}>取消</button><button type="button" className="btn primary" disabled={!norm(rename.to) || !rename.reason} onClick={doRename}>确认改名</button></>}>
          <div className="stack">
            <div className="field req"><label>改成（自动大写，多个空格并成一个）</label><input className="in" autoFocus value={rename.to} onChange={(e) => setRename({ ...rename, to: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label>将改动</label>
              <ul className="preview-list">{groups.map((g) => <li key={g.key}><Pill tone={g.src === 'product' ? 'blue' : 'amber'}>{g.category}</Pill> <s>{g.model}</s> → <b>{norm(rename.to) || '…'}</b>{norm(g.model) === norm(rename.to) && <span className="muted small">（不变）</span>}</li>)}</ul></div>
            <div className="field req"><label>原因</label><OptionNote options={NOTE_OPTIONS.rename} value={rename.reason} onChange={(v) => setRename({ ...rename, reason: v })} /></div>
            <div className="hint">同一种类下已经有目标名称的「物料」不能直接合并（编码不同），系统会拦下；未建档需求可以合并。每次改名都留记录。</div>
          </div>
        </Modal>
      )}
      {catMgr && <CategoryManager onClose={() => setCatMgr(false)} />}
      {brand !== null && (
        <Modal title="设品牌" onClose={() => setBrand(null)}
          footer={<><button type="button" className="btn" onClick={() => setBrand(null)}>取消</button><button type="button" className="btn primary" onClick={doBrand}>确认</button></>}>
          <div className="stack">
            <div className="chips">{BRANDS.map((b) => <button type="button" key={b} className={`chip ${brand === b ? 'on' : ''}`} onClick={() => setBrand(b)}>{b}</button>)}</div>
            <input className="in" value={brand} onChange={(e) => setBrand(e.target.value.toUpperCase())} placeholder="其他品牌" />
          </div>
        </Modal>
      )}
    </>
  );
}

// 种类管理 (Frank 11-09 13:17): 种类跟物料表联动 —— 导入物料出现新种类自动加; 没物料的种类不出现在选货种类条里;
// 这里改名 / 合并 / 删空种类 (只中方, 留痕)
function CategoryManager({ onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [tick, setTick] = useState(0);
  const { data } = useData(() => q(`select c.id, c.name, (select count(*) from app.products p where p.category_id = c.id)::int as n,
      (select count(*) from app.deal_lines l where l.req_category_id = c.id)::int as used
    from app.categories c where c.org_id = $1 order by c.sort, c.name`, [org]), [org, tick]);
  const run = async (msg, sql, args) => { try { await call(role, sql, args); toast(msg); setTick((x) => x + 1); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal wide title="种类管理（只中方）" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>关闭</button>}>
      <div className="stack">
        <div className="hint">种类跟着物料表走：导入物料时出现新种类会自动加上；一个种类下面没有物料了，就不会出现在选货的种类条里。名字写错了在这里改；两个种类其实是一样的就「合并到」另一个（物料和补录需求一起搬过去）；空种类可以删。</div>
        <table className="t"><thead><tr><th>种类</th><th style={{ textAlign: 'right' }}>物料数</th><th>合并到</th><th /></tr></thead>
          <tbody>{(data || []).map((c) => (
            <tr key={c.id} className={c.n === 0 ? 'muted' : ''}>
              <td><input className="in sm" defaultValue={c.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.name) run(`已改名：${c.name} → ${v}`, `select app.rename_category($1,$2)`, [c.id, v]); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} style={{ maxWidth: 200 }} />{c.n === 0 && <span className="small muted"> 空（选货里不显示）</span>}</td>
              <td style={{ textAlign: 'right' }}>{c.n}</td>
              <td><select className="in sm" value="" onChange={(e) => { const to = (data || []).find((x) => x.id === e.target.value); if (to) run(`已把「${c.name}」并到「${to.name}」`, `select app.merge_category($1,$2)`, [c.id, to.id]); }} style={{ maxWidth: 180 }}>
                <option value="">合并到…</option>{(data || []).filter((x) => x.id !== c.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
              <td>{c.n === 0 && c.used === 0 && <button type="button" className="btn sm soft-red" onClick={() => run(`已删掉空种类「${c.name}」`, `select app.delete_category($1)`, [c.id])}>删</button>}</td>
            </tr>))}</tbody></table>
      </div>
    </Modal>
  );
}
