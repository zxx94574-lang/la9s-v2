// 509 / 510 / 512 / 513 (Frank 11-24): 盘点 —— 放在「库位与盘点」页的「盘点」页签
// 中方: ① 现状 → ② 派任务 (谁 · 货架 · 种类; 一个货架只派一个人) → ③ 库位图叠进度 → ④ 差异 → 确认写进系统 (出货恢复) → 金蝶要录的单 (财务录完点「金蝶已录完」)
// 员工: 只有「我的任务 → 一层一层盘 → 搜型号 → 填片数」+「这一层录了 / 我录的」；报盘完后可以自己再领一批（0100，只能盘派给自己的）
// 盘点只记「在哪个库位找到多少」, 不在盘点时挪货; 挪位放到盘完后 (库位图里「挪」)
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, FRow, Choice, MultiChoice, Info, ConfirmBtn, Assumed, Modal } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import CatFilter from '../components/CatFilter.jsx';
import { ModelLink, EmpLink } from '../components/Archives.jsx';
import { dt, qty, friendlyError } from '../lib/format.js';
import { BinPick, PRODUCTS_SQL, binDone, ShelfMap, shelvesOf, binsOfShelf, allBinCodes } from './Bins.jsx';

export function CountPanel({ rooms, items }) {
  const { org, role, toast, refresh } = useApp();
  const admin = role === 'admin'; const boss = ['admin', 'manager'].includes(role);
  const { data } = useData(async () => {
    const [[c], [me], hist] = await Promise.all([q(`select * from app.counts where org_id = $1 and status = 'open' order by started_at desc limit 1`, [org]),
      q(`select employee_id from app.members where org_id = $1 and user_id = $2`, [org, USERS[role]]),
      q(`select c.*, (select count(*) from app.count_lines l where l.count_id = c.id)::int as n, (select coalesce(sum(loss),0) from app.count_diffs d where d.count_id = c.id)::int as loss,
           (select coalesce(sum(gain),0) from app.count_diffs d where d.count_id = c.id)::int as gain, (select count(*) from app.count_diffs d where d.count_id = c.id and (pool_plus > 0 or pool_minus > 0))::int as pool
         from app.counts c where c.org_id = $1 and c.status <> 'open' order by c.started_at desc limit 20`, [org])]);
    return { c, me: me?.employee_id, hist };
  }, [org, role]);
  const [view, setView] = useState(null);
  const [title, setTitle] = useState('年前大盘点'); const [pause, setPause] = useState('y');
  const c = data?.c;
  const start = async () => { try { await call(role, `select app.count_start($1,$2,$3)`, [org, title, pause === 'y']); toast(pause === 'y' ? '盘点开始了，出货已暂停' : '盘点开始了'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const kdTodo = (data?.hist || []).filter((h) => h.status === 'closed' && !h.kd_done_at && (h.loss || h.gain || h.pool));
  if (!data) return <div className="card"><div className="empty">加载中…</div></div>;
  return (
    <>
      {c ? <Open c={c} me={data.me} admin={admin} boss={boss} rooms={rooms} items={items} /> : (
        <div className="card"><div className="card-b stack">
          {admin ? <>
            <b>现在没有在进行的盘点</b>
            <FRow label="名字"><input className="in" style={{ width: 260, maxWidth: '100%' }} value={title} onChange={(e) => setTitle(e.target.value)} /></FRow>
            <FRow label="出货"><Choice value={pause} onChange={setPause} options={[['y', '盘点期间暂停出货'], ['n', '不暂停']]} /></FRow>
            <div><ConfirmBtn className="btn primary" risk="red" title="开始盘点？" body={`开始后：${pause === 'y' ? '所有出库暂停（找货、报价照常），直到你确认盘点结果或取消。\n' : ''}下一步给每个人派货架。`} okText="开始" onOk={start}>开始盘点</ConfirmBtn></div>
          </> : <span className="muted">现在没有在进行的盘点。中方开始盘点、给你派了货架后，这里会出现你的任务。</span>}
        </div></div>)}
      {kdTodo.length > 0 && ['admin', 'finance'].includes(role) && <div className="banner" style={{ marginTop: 12 }}>{kdTodo.map((h) => h.no).join('、')} 还有盘亏 / 盘盈 / 错码要录金蝶 <button type="button" className="btn sm" onClick={() => setView(kdTodo[0])}>去看</button></div>}
      {(boss || role === 'finance') && data.hist.length > 0 && <div className="card" style={{ marginTop: 12 }}>
        <div className="card-h"><h2>以前的盘点</h2></div>
        <Grid id="count-hist" compactTools rows={data.hist} rowKey={(r) => r.id} rowActions={[{ label: '看差异 / 金蝶要录的', run: (r) => setView(r) }]} columns={[
          { key: 'no', label: '编号', w: 130, render: (r) => <b className="mono">{r.no}</b> }, { key: 'title', label: '名字', w: 140 }, { key: 'started_at', label: '开始', w: 130, render: (r) => dt(r.started_at) },
          { key: 'status', label: '结果', w: 80, value: (r) => (r.status === 'closed' ? '已确认' : '已取消') },
          { key: 'kd', label: '金蝶', w: 90, value: (r) => (r.status !== 'closed' ? '' : r.kd_done_at ? '已录完' : (r.loss || r.gain || r.pool) ? '待录' : '不用录'), render: (r) => (r.status !== 'closed' ? '' : r.kd_done_at ? <span className="pill green">已录完</span> : (r.loss || r.gain || r.pool) ? <span className="pill amber">待录</span> : <span className="pill gray">不用录</span>) },
          { key: 'n', label: '录了几条', w: 80, type: 'number' }, { key: 'pool', label: '错码编码', w: 80, type: 'number' }, { key: 'loss', label: '盘亏（片）', w: 90, type: 'number' }, { key: 'gain', label: '盘盈（片）', w: 90, type: 'number' }]} />
      </div>}
      {view && <Modal wide title={`${view.no} · 差异和金蝶要录的`} onClose={() => setView(null)} footer={view.status === 'closed' && !view.kd_done_at && ['admin', 'finance'].includes(role) ? <ConfirmBtn className="btn primary" title="金蝶那边都录完了？" body="盘亏 / 盘盈 / 错码改记都在金蝶录好了。点了这次盘点就算三方一致、关闭。" onOk={async () => { try { await call(role, `select app.count_kd_done($1)`, [view.id]); toast('已标记金蝶录完'); refresh(); setView(null); } catch (e) { toast(friendlyError(e), 'err'); } }}>金蝶已录完</ConfirmBtn> : null}>
        <Diffs countId={view.id} closed />
      </Modal>}
    </>
  );
}

function Open({ c, me, admin, boss, rooms, items }) {
  const { org, role, toast, refresh } = useApp();
  const { data } = useData(async () => {
    const [lines, tasks, products, emps, cats] = await Promise.all([
      q(`select l.*, b.code as bin, p.code, p.model, p.variant, cat.name as category, e.short_name as by_name from app.count_lines l join app.bins b on b.id = l.bin_id
         join app.products p on p.id = l.product_id join app.categories cat on cat.id = p.category_id left join app.employees e on e.id = l.by_employee where l.count_id = $1 order by l.at desc`, [c.id]),
      q(`select t.*, e.short_name, e.emp_no, cat.name as category from app.count_tasks t join app.employees e on e.id = t.employee_id left join app.categories cat on cat.id = t.category_id where t.count_id = $1 order by t.created_at`, [c.id]),
      q(PRODUCTS_SQL, [org]),
      q(`select id, short_name, emp_no from app.employees where org_id = $1 and active order by emp_no nulls last, short_name`, [org]),
      q(`select id, name from app.categories where org_id = $1 order by sort, name`, [org])]);
    return { lines, tasks, products, emps, cats };
  }, [c.id, org]);
  const lines = useMemo(() => data?.lines || [], [data]);
  const tasks = useMemo(() => data?.tasks || [], [data]);
  const counted = useMemo(() => { const by = {}; for (const l of lines) (by[l.bin] ||= []).push({ product_id: l.product_id, model: l.model, category: l.category, qty: l.qty }); return by; }, [lines]);
  const taskBins = (t) => (t.shelves || []).flatMap((sh) => binsOfShelf(rooms, sh));
  const inTask = useMemo(() => { const m = {}; for (const t of tasks) for (const b of (t.shelves || []).flatMap((sh) => binsOfShelf(rooms, sh))) m[b] = t; return m; }, [tasks, rooms]);
  const mine = tasks.filter((t) => t.employee_id === me);
  const [diff, setDiff] = useState(false); const [selfOpen, setSelfOpen] = useState(false); const [open, setOpen] = useState(null);
  const run = async (msg, sql, args) => { try { await call(role, sql, args); if (msg) toast(msg); refresh(); return true; } catch (e) { toast(friendlyError(e), 'err'); return false; } };
  const allBins = allBinCodes(rooms);
  const nBins = Object.keys(counted).length;
  const multi = useMemo(() => { const by = {}; for (const l of lines) (by[l.product_id] ||= new Set()).add(l.bin); return Object.values(by).filter((s) => s.size > 1).length; }, [lines]);
  const header = (
    <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>{c.title} <span className="muted small mono">{c.no}</span></h2>
      {c.pause_ship ? <span className="pill red">出货已暂停</span> : <span className="pill gray">出货没暂停</span>}
      {admin && <ConfirmBtn className="btn sm ghost" title={c.pause_ship ? '恢复出货？' : '暂停出货？'} body={c.pause_ship ? '恢复后盘点期间又出的货会让盘到的数对不上，确定？' : '暂停后所有出库都会被拦住，直到确认盘点结果。'} onOk={() => run(c.pause_ship ? '已恢复出货' : '已暂停出货', `select app.count_set_freeze($1,$2)`, [c.id, !c.pause_ship])}>{c.pause_ship ? '恢复出货' : '暂停出货'}</ConfirmBtn>}
      <span className="grow" /><span className="small muted">开始 {dt(c.started_at)}</span></div>);
  if (!boss) return (
    <div className="card">{header}<div className="card-b">
      {mine.length > 0 && <Entry c={c} tasks={mine} rooms={rooms} lines={lines} products={data?.products || []} cats={data?.cats || []} items={items} />}
      {!mine.some((t) => t.status !== 'done') && <div style={{ marginTop: mine.length ? 14 : 0 }}>{!mine.length && <div className="muted" style={{ marginBottom: 8 }}>还没给你派货架：等主管派，或者自己领。</div>}<Claim c={c} rooms={rooms} tasks={tasks} cats={data?.cats || []} again={mine.length > 0} /></div>}
    </div></div>);
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>{header}
        <div className="ct-kpis">
          <div className="ct-k"><span>已盘库位</span><b className="big">{nBins}</b><small> / {allBins.length}</small></div>
          <div className="ct-k"><span>已录</span><b>{lines.length}</b><small> 条</small></div>
          <div className="ct-k"><span>任务盘完</span><b>{tasks.filter((t) => t.status === 'done').length} / {tasks.length}</b></div>
          <div className="ct-k" data-tip="同一个编码在两个以上库位盘到 —— 最后合在一起算，看看是不是放乱了"><span>同型号在几处</span><b className={multi ? 'amber-t' : ''}>{multi}</b></div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>派任务 <Info>先选人，再选他盘的货架和种类。一个货架只能派给一个人；盘点只记在哪个库位找到多少，不在盘点时挪货。他盘完点「我盘完了」，再派下一批。全盘就一次把所有货架派完。</Info></h2></div>
        <div className="card-b">
          {tasks.map((t) => { const bs = taskBins(t); const done = bs.filter((b) => counted[b]).length; return (
            <div key={t.id} className="ct-row"><EmpLink id={t.employee_id} name={t.short_name} /><span>{t.category || '全部种类'}</span><b>{t.scope}</b>
              <span className="small"><span className="ct-bar"><i style={{ width: `${bs.length ? (done / bs.length) * 100 : 0}%` }} /></span>{done} / {bs.length} 层</span>
              <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>{t.status === 'done' ? <><span className="pill green">盘完</span><button type="button" className="btn sm ghost" onClick={() => run('退回去重盘', `select app.count_task_done($1,false)`, [t.id])}>退回</button></> : done ? <span className="pill amber">在盘</span> : <span className="pill gray">没开始</span>}
                <ConfirmBtn className="btn sm ghost" title="删掉这个任务？" body="他已经录的数不会删。" onOk={() => run('已删', `select app.count_task_del($1)`, [t.id])}>删</ConfirmBtn></span></div>); })}
          <NewTask c={c} rooms={rooms} tasks={tasks} emps={data?.emps || []} cats={data?.cats || []} />
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>库位 <span className="muted small">绿 ✓ 盘了 · 黄 ◐ 派了还没盘 · 灰 没派</span></h2></div>
        <div className="card-b"><ShelfMap rooms={rooms} items={counted} mark={(b) => (counted[b] ? 'done' : inTask[b] ? 'doing' : null)} onOpen={setOpen} /></div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>我也来录</h2><span className="grow" /><button type="button" className="btn sm" onClick={() => setSelfOpen(!selfOpen)}>{selfOpen ? '收起' : '展开'}</button></div>
        {selfOpen && <div className="card-b"><Entry c={c} tasks={mine} rooms={rooms} lines={lines} products={data?.products || []} cats={data?.cats || []} free={!mine.length} items={items} /></div>}
      </div>
      {admin && <div className="card">
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>差异 <Info>系统数 = LA + 9S 两个仓合计。同一种货（编码甄别里定过）一个编码多、一个编码少能抵消的是「错码」；抵消不了的是真盘亏 / 盘盈。没盘到的编码按实物 0 算。确认后系统 = 实物、出货恢复；金蝶要录的单在「以前的盘点」里，财务录完点「金蝶已录完」。</Info></h2><span className="grow" />
          <button type="button" className="btn" onClick={() => setDiff(!diff)}>{diff ? '收起' : '看差异'}</button></div>
        {diff && <Diffs countId={c.id} />}
        <div className="card-b actbar">
          <ConfirmBtn className="btn ghost" title="取消这次盘点？" body="录的数都不算，系统库存不动，出货恢复。" onOk={() => run('已取消，出货恢复', `select app.count_cancel($1)`, [c.id])}>取消这次盘点</ConfirmBtn><span className="grow" />
          <ConfirmBtn className="btn primary" risk="red" title="确认盘点结果、写进系统？" okText="确认写进系统"
            body={'确认后：\n· 系统库存改成盘到的实物数（LA / 9S：多了加到数量多的仓，少了从数量多的仓扣）\n· 库位按这次盘到的重写，以前的记录保留\n· 同一种货能抵消的进消耗池，以后出货时金蝶改记池里的编码\n· 盘亏 / 盘盈 / 错码列进「金蝶要录的」，财务去录\n· 出货马上恢复\n这一步撤不回。'}
            onOk={async () => { try { const [r] = await call(role, `select app.count_apply($1) as r`, [c.id]); const x = r?.r || {}; toast(`已写进系统：改了 ${x.adjusted} 个编码，错码 ${x.pool} 条，盘亏 ${qty(x.loss)} 片，盘盈 ${qty(x.gain)} 片；出货已恢复`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }}>确认写进系统</ConfirmBtn>
        </div>
      </div>}
      {open && <Modal title={`${open} 盘到的`} onClose={() => setOpen(null)}>
        <div className="small muted" style={{ marginBottom: 6 }}>{inTask[open] ? `派给 ${inTask[open].short_name}` : '还没派'}</div>
        {lines.filter((l) => l.bin === open).map((l) => <div key={l.id} className="row" style={{ gap: 8 }}><span className="muted small">{l.category}</span><ModelLink id={l.product_id} model={l.model} /><span className="grow" /><b>{qty(l.qty)}</b><span className="muted small">{l.by_name}</span></div>)}
        {!lines.some((l) => l.bin === open) && <div className="muted">还没录。库位上原来记着：{(items[open] || []).map((x) => `${x.model} ${qty(x.qty)}`).join('、') || '空'}</div>}
      </Modal>}
    </>
  );
}

function NewTask({ c, rooms, tasks, emps, cats }) {
  const { role, toast, refresh } = useApp();
  const [emp, setEmp] = useState(''); const [shs, setShs] = useState([]); const [cat, setCat] = useState('*');
  const taken = new Set(tasks.flatMap((t) => t.shelves || []));
  const opts = shelvesOf(rooms).filter((s) => !taken.has(s)).map((s) => ({ v: s, l: s, group: s.split('-')[0] }));
  const go = async () => { try { await call(role, `select app.count_task_set2($1,$2,$3,$4)`, [c.id, emp, shs, cat === '*' ? null : cat]); toast('已派'); setShs([]); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
      <Choice value={emp} onChange={setEmp} placeholder="谁盘" options={emps.map((e) => [e.id, `${e.emp_no ? e.emp_no + ' ' : ''}${e.short_name}`])} />
      <div style={{ minWidth: 220, flex: 1 }}><MultiChoice value={shs} onChange={setShs} placeholder={opts.length ? '盘哪些货架（可多选）' : '货架都派完了'} options={opts} style={{ width: '100%' }} /></div>
      <CatFilter categories={cats} value={cat === '*' ? '' : cat} onChange={(v) => setCat(v || '*')} forSale={false} allLabel="全部种类" compact />
      <button type="button" className="btn primary" disabled={!emp || !shs.length} onClick={go}>＋ 派</button>
    </div>);
}

// 领任务（Frank 11-25）: 手上的报盘完了，自己再领一批没派出去的货架；主管 / 中方在「派任务」里随时派
function Claim({ c, rooms, tasks, cats, again }) {
  const { role, toast, refresh } = useApp();
  const [shs, setShs] = useState([]); const [cat, setCat] = useState('');
  const taken = new Set(tasks.flatMap((t) => t.shelves || []));
  const opts = shelvesOf(rooms).filter((x) => !taken.has(x)).map((x) => ({ v: x, l: x, group: x.split('-')[0] }));
  const go = async () => { try { await call(role, `select app.count_task_claim($1,$2,$3)`, [c.id, shs, cat || null]); toast(`领了 ${shs.join('、')}`); setShs([]); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  if (!opts.length) return <div className="small muted">货架都派完了。还有要盘的找主管。</div>;
  return (
    <div className="ce-claim stack" style={{ gap: 8 }}>
      <b>{again ? '再领一批' : '自己领一批'} <span className="muted small">（没派出去的货架；一个货架只给一个人）</span></b>
      <MultiChoice value={shs} onChange={setShs} placeholder="盘哪些货架（可多选）" options={opts} style={{ width: '100%' }} />
      <CatFilter categories={cats} value={cat} onChange={setCat} forSale={false} allLabel="全部种类" compact />
      <div><button type="button" className="btn primary" disabled={!shs.length} onClick={go}>＋ 领这批</button></div>
    </div>);
}

// 录入（Frank 11-25 改）: 任务 → 库位一层一层走 → 搜型号（型号 / 编码 / 通用型号，跟下单一样）→ 片数
// 不再把所有型号平铺；没搜的时候只给「这一层上次放的」几个快捷，点了直接填数。只能录在派给自己的货架和种类里（后台也拦）。
// free = 中方 / 主管自己录：随便选库位、种类
function Entry({ c, tasks, rooms, lines, products, cats, free, items = {} }) {
  const { role, toast, refresh } = useApp();
  const open = tasks.filter((x) => x.status !== 'done');
  const [tid, setTid] = useState((open[0] || tasks[0])?.id || '');
  const t = tasks.find((x) => x.id === tid) || open[0] || tasks[0];
  const bins = useMemo(() => (t ? (t.shelves || []).flatMap((sh) => binsOfShelf(rooms, sh)) : []), [t, rooms]);
  const [ix, setIx] = useState(0); const [freeBin, setFreeBin] = useState(''); const [freeCat, setFreeCat] = useState('');
  const bin = t && !free ? bins[Math.min(ix, bins.length - 1)] : freeBin;
  const catId = t && !free ? t.category_id : freeCat || null;
  const [sel, setSel] = useState(''); const [n, setN] = useState(''); const [kw, setKw] = useState(''); const [hi, setHi] = useState(0);
  const here = lines.filter((l) => l.bin === bin);
  const norm = (x) => String(x || '').toUpperCase().replace(/[\s_-]+/g, '');
  const pool = useMemo(() => products.filter((p) => !catId || p.category_id === catId), [products, catId]);
  const hits = useMemo(() => {
    const k = norm(kw); if (!k) return [];
    const score = (p) => (norm(p.model) === k ? 4 : norm(p.model).startsWith(k) ? 3 : norm(p.model).includes(k) ? 2 : [p.code, p.kingdee_code, p.variant].some((x) => norm(x).includes(k)) ? 1.5 : (p.shared_models || []).some((x) => norm(x).includes(k)) ? 1 : 0);
    return pool.map((p) => [p, score(p)]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1] || a[0].model.localeCompare(b[0].model)).slice(0, 40).map(([p]) => p);
  }, [pool, kw]);
  // 没搜的时候: 这一层系统里记着的型号（只给型号不给数，免得照抄）+ 这层已经录过的
  const quick = useMemo(() => { const ids = new Set([...(items[bin] || []).map((x) => x.product_id), ...here.map((l) => l.product_id)]); return pool.filter((p) => ids.has(p.id)); }, [items, bin, here, pool]);
  const done = bins.filter((b) => lines.some((l) => l.bin === b)).length;
  const P = (id) => products.find((p) => p.id === id);
  const choose = (p) => { const d = here.find((l) => l.product_id === p.id); setSel(p.id); setN(d ? String(d.qty) : ''); };
  const rec = async () => { try { await call(role, `select app.count_add($1,$2,$3,$4,null)`, [c.id, bin, sel, Number(n)]); toast(`${bin} · ${P(sel)?.model} · ${n} 片`); setSel(''); setN(''); setKw(''); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const elsewhere = sel ? lines.filter((l) => l.product_id === sel && l.bin !== bin) : [];
  const my = lines.filter((l) => l.by_user === USERS[role]);
  const row = (p, i) => { const d = here.find((l) => l.product_id === p.id); return (
    <button type="button" key={p.id} className={`ce-hit ${sel === p.id ? 'on' : ''} ${i === hi ? 'hi' : ''} ${d ? 'done' : ''}`} onClick={() => choose(p)} onMouseEnter={() => setHi(i)}>
      <b>{p.model}</b><span className="muted small">{p.category}{p.variant ? ` · ${p.variant}` : ''}</span><span className="mono small muted">{p.code}</span>
      {(p.shared_models || []).length > 0 && <span className="small muted ce-sh">通用 {(p.shared_models || []).slice(0, 4).join(' / ')}{p.shared_models.length > 4 ? ' …' : ''}</span>}
      <span className="grow" />{d ? <span className="pill green">{qty(d.qty)} 片 ✓</span> : null}</button>); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && hits[hi]) { e.preventDefault(); choose(hits[hi]); }
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      {t && !free ? <>
        {tasks.length > 1 && <Choice value={t.id} onChange={(v) => { setTid(v); setIx(0); setSel(''); }} options={tasks.map((x) => [x.id, `${x.category || '全部'} · ${x.scope}${x.status === 'done' ? '（已报盘完）' : ''}`])} />}
        <div className="ce-task"><div><small>我的任务</small><br /><b>{t.category || '全部种类'} · {t.scope}</b></div>
          <div style={{ textAlign: 'right' }}><small>{done} / {bins.length} 层</small><div className="ce-prog"><i style={{ width: `${bins.length ? (done / bins.length) * 100 : 0}%` }} /></div>
            {t.status !== 'done' ? <ConfirmBtn className="btn sm" title="这批货架都盘完了？" body={`${t.scope}：${done} / ${bins.length} 层录过。点了中方会看到你盘完了；你可以马上再领下一批。`} onOk={async () => { try { await call(role, `select app.count_task_done($1,true)`, [t.id]); toast('已报盘完，可以再领一批'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }}>我盘完了</ConfirmBtn> : <span className="pill green">已报盘完</span>}</div></div>
        <div className="ce-bin"><b>{bin}</b><span className="grow" />
          <button type="button" className="btn" disabled={ix <= 0} onClick={() => { setIx(ix - 1); setSel(''); setKw(''); }}>← 上一层</button>
          <button type="button" className="btn primary" disabled={ix >= bins.length - 1} onClick={() => { setIx(ix + 1); setSel(''); setKw(''); }}>这层盘完，下一层 →</button></div>
      </> : <>
        <FRow label="库位" req><BinPick value={freeBin} onChange={setFreeBin} /></FRow>
        <FRow label="种类"><CatFilter categories={cats} value={freeCat} onChange={setFreeCat} forSale={false} allLabel="全部种类" compact /></FRow>
      </>}
      {binDone(bin) && <>
        {sel && <div className="ce-qty sticky"><b>{P(sel)?.model}</b><span className="muted small">{P(sel)?.category}</span><input className="in" autoFocus inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} placeholder="片" onKeyDown={(e) => { if (e.key === 'Enter' && n !== '') rec(); if (e.key === 'Escape') setSel(''); }} /><button type="button" className="btn primary lg" disabled={n === ''} onClick={rec}>记下</button></div>}
        <input className="in" style={{ width: '100%' }} value={kw} autoFocus={!sel} onChange={(e) => { setKw(e.target.value); setHi(0); }} onKeyDown={key}
          placeholder={`⌕ 搜型号 / 编码 / 通用型号${catId ? `（只在「${cats.find((x) => x.id === catId)?.name || ''}」里）` : ''}，例 A10`} />
        {kw.trim() ? <div className="ce-hits">{hits.map(row)}{!hits.length && <div className="small muted" style={{ padding: 8 }}>没有「{kw.trim()}」{catId ? '（这个任务只盘这个种类；别的种类找主管）' : ''}</div>}</div>
          : quick.length > 0 && <div className="ce-hits"><div className="small muted" style={{ padding: '2px 4px' }}>这一层上次放的（点了填数；别的型号上面搜）</div>{quick.map(row)}</div>}
        {elsewhere.length > 0 && <div className="count-warn">这个型号在 {elsewhere.map((l) => `${l.bin}（${qty(l.qty)}）`).join('、')} 也盘到了，最后合在一起算。</div>}
        <div className="small"><span className="muted">这一层录了：</span>{here.length ? here.map((l) => `${l.model} ${qty(l.qty)}`).join(' · ') : <span className="muted">还没录</span>}</div>
      </>}
      <details><summary className="small muted">我录的 {my.length} 条</summary>
        <Grid id="count-my" compactTools rows={my} rowKey={(r) => r.id} empty="还没录" rowActions={[{ label: '删掉这条', danger: true, run: async (r) => { try { await call(role, `select app.count_del($1)`, [r.id]); toast('已删'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } } }]} columns={[
          { key: 'bin', label: '库位', w: 90, render: (r) => <b className="mono">{r.bin}</b> }, { key: 'category', label: '种类', w: 80 }, { key: 'model', label: '型号', w: 140, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
          { key: 'qty', label: '数量', w: 80, type: 'number', sum: true }, { key: 'at', label: '时间', w: 120, render: (r) => dt(r.at) }]} />
      </details>
    </div>);
}

// 差异表: 进行中 = 预览 (不落库); 确认后 = 存下来的那份 (= 金蝶要录的)
function Diffs({ countId, closed }) {
  const { org } = useApp();
  const { data } = useData(async () => {
    const rows = closed ? await q(`select * from app.count_diffs where count_id = $1`, [countId]) : await q(`select * from app.count_preview($1)`, [countId]);
    const ids = rows.map((r) => r.product_id);
    const ps = ids.length ? await q(`select p.id, p.code, p.model, p.variant, c.name as category from app.products p join app.categories c on c.id = p.category_id where p.id = any($1::uuid[])`, [ids]) : [];
    const by = Object.fromEntries(ps.map((p) => [p.id, p]));
    return rows.map((r) => ({ ...r, ...(by[r.product_id] || {}), kind: Number(r.diff) === 0 ? 'ok' : Number(r.loss) > 0 ? 'loss' : Number(r.gain) > 0 ? 'gain' : 'pool' }));
  }, [countId, closed, org]);
  const rows = data || [];
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const [f, setF] = useState('diff');
  const KIND = { ok: ['对上了', 'green'], pool: ['错码', 'amber'], loss: ['盘亏', 'red'], gain: ['盘盈', 'amber'] };
  const shown = rows.filter((r) => (f === 'all' ? true : f === 'diff' ? r.kind !== 'ok' : r.kind === f));
  return (
    <div className="card-b stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="pill green">对上了 {rows.filter((r) => r.kind === 'ok').length} 个编码</span>
        <span className="pill amber">错码 {rows.filter((r) => Number(r.pool_plus) > 0 || Number(r.pool_minus) > 0).length} 个编码 · {qty(sum('pool_plus'))} 片</span>
        <span className="pill red">盘亏 {qty(sum('loss'))} 片</span><span className="pill amber">盘盈 {qty(sum('gain'))} 片</span>
        <Assumed>确认后系统马上改成实物数（销售看到的可售就是真的），出货恢复；金蝶那边：错码靠以后出货时改记池里的编码慢慢对齐，盘亏 / 盘盈要录单。</Assumed>
        <span className="grow" /><Choice value={f} onChange={setF} options={[['diff', '只看有差的'], ['loss', '盘亏'], ['gain', '盘盈'], ['pool', '错码'], ['all', '全部']]} />
      </div>
      <Grid id={`count-diff-${closed ? 'c' : 'p'}`} compactTools rows={shown} rowKey={(r) => r.product_id} empty="没有差异 ✓" columns={[
        { key: 'code', label: '编码', w: 100 }, { key: 'category', label: '种类', w: 80 }, { key: 'model', label: '型号', w: 140, render: (r) => <ModelLink id={r.product_id} model={r.model} /> }, { key: 'variant', label: '区分', w: 80 },
        { key: 'kind', label: '结论', w: 80, value: (r) => KIND[r.kind][0], render: (r) => <span className={`pill ${KIND[r.kind][1]}`}>{KIND[r.kind][0]}</span> },
        { key: 'sys_qty', label: '系统', w: 80, type: 'number', sum: true }, { key: 'actual_qty', label: '实物', w: 80, type: 'number', sum: true },
        { key: 'diff', label: '系统多', w: 80, type: 'number', render: (r) => <span className={Number(r.diff) > 0 ? 'red-t2' : ''}>{qty(r.diff)}</span> },
        { key: 'pool_plus', label: '错码（没实物）', w: 100, type: 'number', sum: true }, { key: 'pool_minus', label: '错码（实物多）', w: 100, type: 'number', sum: true },
        { key: 'loss', label: '盘亏', w: 70, type: 'number', sum: true }, { key: 'gain', label: '盘盈', w: 70, type: 'number', sum: true }]} />
    </div>);
}
