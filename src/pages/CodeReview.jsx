// 编码甄别 (Frank 11-18 第 9 点; §3b 第 1 组): 同种类 + 同型号下有多个编码的, 一组一组定「是同一种货 / 不是同一种货」.
// 系统不自动合并; 没定的留「待定」. 这里只记结论: 库存、出库、金蝶仍然按各自的料号走.
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Info, Pill, Modal, Choice, Assumed, Shared, FRow } from '../components/ui.jsx';
import { ModelLink } from '../components/Archives.jsx';
import { qty, friendlyError } from '../lib/format.js';
import { pasteRows } from '../lib/resolve.js';

const ST = { same: ['同一种货', 'green'], diff: ['不是同一种', 'gray'], todo: ['待定', 'amber'] };

export default function CodeReview() {
  const { org, role, toast, refresh, tick } = useApp();
  const [tab, setTab] = useState('todo'); const [qs, setQs] = useState(''); const [imp, setImp] = useState(false); const [ask, setAsk] = useState(null);
  const { data } = useData(() => (role !== 'admin' ? Promise.resolve(null) : q(`
    select p.id, p.code, p.model, p.variant, p.kingdee_name, p.shared_models, p.unify_code, p.unify_status, p.unify_note, c.name as category, p.category_id,
      coalesce((select sum(s.qty_on_hand) from app.stock_items s where s.product_id = p.id), 0)::int as stock
    from app.products p left join app.categories c on c.id = p.category_id
    where p.org_id = $1 and exists (select 1 from app.products p2 where p2.org_id = p.org_id and p2.category_id is not distinct from p.category_id and upper(p2.model) = upper(p.model) and p2.id <> p.id)
    order by c.name, p.model, p.code`, [org])), [org, role, tick]);
  const groups = useMemo(() => {
    if (!data) return [];
    const m = new Map();
    for (const p of data) { const k = `${p.category_id}|${String(p.model).toUpperCase()}`; if (!m.has(k)) m.set(k, { key: k, category: p.category, model: p.model, items: [] }); m.get(k).items.push(p); }
    return [...m.values()].map((g) => { const sts = new Set(g.items.map((x) => x.unify_status || 'todo'));
      const sharedSame = new Set(g.items.map((x) => [...(x.shared_models || [])].sort().join('|'))).size === 1;
      return { ...g, status: sts.has('todo') ? 'todo' : sts.has('same') ? 'same' : 'diff', sharedSame }; });
  }, [data]);
  if (role !== 'admin') return <div className="card card-b muted">只有中方能做编码甄别。</div>;
  if (!data) return <div className="empty">加载中…</div>;
  const cnt = (s) => groups.filter((g) => g.status === s).length;
  const shown = groups.filter((g) => (tab === 'all' || g.status === tab) && (!qs || `${g.model} ${g.category} ${g.items.map((x) => x.code).join(' ')}`.toLowerCase().includes(qs.toLowerCase())));
  const decide = async (g, verdict, main, note) => {
    try { await call(role, `select app.set_code_unify($1,$2,$3,$4,$5)`, [org, g.items.map((x) => x.id), verdict, main || null, note || null]);
      toast(verdict === 'same' ? `${g.model}：已定为同一种货` : verdict === 'diff' ? `${g.model}：已定为不是同一种货` : `${g.model}：已退回待定`); setAsk(null); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="stack">
      <div className="pagehead"><div><div className="eyebrow">Codes</div><h1>编码甄别 <Info>同一个种类、同一个型号下面有不止一个编码的，都列在这里，一组一组定：<b>是同一种货</b>（选一个主编码，其余算它的别名）还是<b>不是同一种货</b>（各管各的）。系统不会自己合并。通用性不一样的按规矩是两种货，硬要归成一种得写原因。</Info>
        <Assumed>这一页现在只记「结论」，给以后的搜索合并显示和补货用；库存、出库、金蝶仍然按各自的编码走，一个数都不会动。合并显示库存还没做。</Assumed></h1>
        <div className="sub">共 {groups.length} 组同型号多编码：待定 {cnt('todo')} · 同一种货 {cnt('same')} · 不是同一种 {cnt('diff')}</div></div>
        <button type="button" className="btn" onClick={() => setImp(true)}>按清单批量导入</button></div>
      <div className="card">
        <div className="card-b row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Choice value={tab} onChange={setTab} options={[['todo', `待定 ${cnt('todo')}`], ['same', `同一种货 ${cnt('same')}`], ['diff', `不是同一种 ${cnt('diff')}`], ['all', `全部 ${groups.length}`]]} flat />
          <span className="grow" /><input className="in" style={{ width: 220, maxWidth: '100%' }} placeholder="搜型号 / 种类 / 编码" value={qs} onChange={(e) => setQs(e.target.value)} /></div>
        {shown.length === 0 ? <div className="card-b muted small">{groups.length ? '这一类没有了。' : '没有「同种类同型号、多个编码」的情况。'}</div>
          : <div className="code-groups">{shown.slice(0, 200).map((g) => (
            <div key={g.key} className="code-group">
              <div className="cg-h"><b>{g.model}</b><span className="muted">{g.category}</span><Pill tone={ST[g.status][1]}>{ST[g.status][0]}</Pill>
                {!g.sharedSame && <Pill tone="amber" title="这几个编码的通用机型不一样：按规矩是两种货">通用性不一样</Pill>}
                <span className="grow" />
                {g.status !== 'same' && <button type="button" className="btn sm primary" onClick={() => setAsk({ g, verdict: 'same', main: [...g.items].sort((a, b) => b.stock - a.stock)[0].id, note: '' })}>是同一种货</button>}
                {g.status !== 'diff' && <button type="button" className="btn sm" onClick={() => decide(g, 'diff')}>不是同一种货</button>}
                {g.status !== 'todo' && <button type="button" className="btn sm ghost" onClick={() => decide(g, 'reset')}>退回待定</button>}</div>
              <div className="cg-rows">{g.items.map((p) => (
                <div key={p.id} className="cg-row">
                  <span className="mono cg-code">{p.code}{p.unify_status === 'same' && p.unify_code === p.code && <span className="pill blue" style={{ marginLeft: 6 }}>主编码</span>}</span>
                  <span className="cg-name"><ModelLink id={p.id} model={p.variant ? `${p.model} · ${p.variant}` : p.model} />{p.kingdee_name && <span className="small muted"> {p.kingdee_name}</span>}</span>
                  <span className="cg-shared"><Shared list={p.shared_models} /></span>
                  <span className="cg-stock">库存 <b>{qty(p.stock)}</b></span>
                </div>))}</div>
              {g.items[0].unify_note && g.status !== 'todo' && <div className="small muted" style={{ padding: '0 12px 8px' }}>备注：{g.items[0].unify_note}</div>}
            </div>))}{shown.length > 200 && <div className="card-b small muted">只显示前 200 组，用搜索缩小范围。</div>}</div>}
      </div>
      {ask && <Modal title={`${ask.g.model}：定为同一种货`} risk="yellow" onClose={() => setAsk(null)}
        footer={<><button type="button" className="btn" onClick={() => setAsk(null)}>取消</button><button type="button" className="btn primary" onClick={() => decide(ask.g, 'same', ask.main, ask.note.trim())}>确定</button></>}>
        <FRow label="主编码" req><Choice value={ask.main} onChange={(v) => setAsk({ ...ask, main: v })} options={ask.g.items.map((p) => [p.id, `${p.code}（库存 ${qty(p.stock)}）`])} /></FRow>
        <FRow label={ask.g.sharedSame ? '备注' : '原因'} req={!ask.g.sharedSame}><input className="in" style={{ flex: '1 1 240px', minWidth: 0 }} placeholder={ask.g.sharedSame ? '可不填' : '通用性不一样还要归成一种，写一句为什么'} value={ask.note} onChange={(e) => setAsk({ ...ask, note: e.target.value })} /></FRow>
        <div className="hint">其余 {ask.g.items.length - 1} 个编码算主编码的别名。库存、出库、金蝶仍按各自编码，不会合并数字。</div>
      </Modal>}
      {imp && <ImportModal org={org} onClose={() => setImp(false)} />}
    </div>);
}

function ImportModal({ org, onClose }) {
  const { role, toast, refresh } = useApp();
  const [text, setText] = useState(''); const [res, setRes] = useState(null);
  const rows = text.trim() ? pasteRows(text).filter((r) => r[0] && !/编码|code/i.test(r[0])).map((r) => ({ code: r[0], main_code: r[1] || '' })) : [];
  const go = async () => { try { const [x] = await call(role, `select app.import_code_unify($1,$2) as r`, [org, JSON.stringify(rows)]); setRes(x.r); toast(`已导入 ${x.r.ok} 行`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="按清单批量导入甄别结果" wide onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>关闭</button><button type="button" className="btn primary" disabled={!rows.length} onClick={go}>导入 {rows.length} 行</button></>}>
      <div className="hint">从 Excel 复制两列粘到下面：<b>编码</b>、<b>主编码</b>。主编码空着 = 它自己就是主编码；主编码写「-」= 定为「不是同一种货」。</div>
      <textarea className="in" rows={10} style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }} placeholder={'10052\t10051\n10051\n10060\t-'} value={text} onChange={(e) => { setText(e.target.value); setRes(null); }} />
      {res && <div className={`banner ${res.bad?.length ? 'warn' : 'info'}`} style={{ marginTop: 10 }}>导入了 {res.ok} 行。{res.bad?.length ? `有 ${res.bad.length} 行编码系统里找不到，没导：${res.bad.slice(0, 20).join('、')}${res.bad.length > 20 ? '…' : ''}` : ''}</div>}
    </Modal>);
}
