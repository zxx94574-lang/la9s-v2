// 509 / 510 (Frank 11-24): 年前大盘点 —— 中方开盘点 (默认暂停出库) → 分任务 (谁盘哪几个货架) → 员工手机逐条录 库位 · 型号 · 数量 → 中方看差异 → 确认写进系统
// 差异: 同一组 (编码甄别里定了是同一种货) 里一个多一个少能抵消的 → 消耗池 (系统马上 = 实物; 金蝶以后出货时改记池里的编码, 慢慢对齐);
//       抵消不了的 → 盘亏 / 盘盈 (系统直接改, 金蝶要录盘亏 / 盘盈单)
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import { useApp, useData, FRow, Choice, Info, ConfirmBtn, Assumed } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ModelLink, EmpLink } from '../components/Archives.jsx';
import { dt, qty, friendlyError } from '../lib/format.js';
import { BinPick, ProdPick, PRODUCTS_SQL, binDone } from './Bins.jsx';

export default function Count() {
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
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Inventaire</div><h1>盘点 <Info>中方开盘点 → 分任务（谁盘哪几个货架）→ 大家用手机一条条录「库位 · 型号 · 数量」→ 中方看差异 → 确认写进系统。盘点期间出货暂停，盘完自动恢复。</Info></h1></div></div>
      {!data ? <div className="card"><div className="empty">加载中…</div></div> : c ? <Open c={c} me={data.me} admin={admin} boss={boss} /> : (
        <div className="card"><div className="card-b stack">
          {admin ? <>
            <b>现在没有在进行的盘点</b>
            <FRow label="名字"><input className="in" style={{ width: 260, maxWidth: '100%' }} value={title} onChange={(e) => setTitle(e.target.value)} /></FRow>
            <FRow label="出货"><Choice value={pause} onChange={setPause} options={[['y', '盘点期间暂停出货'], ['n', '不暂停']]} /></FRow>
            <div><ConfirmBtn className="btn primary" risk="red" title="开始盘点？" body={`开始后：${pause === 'y' ? '所有出库暂停（找货、报价照常），直到你确认盘点结果或取消。\n' : ''}大家就可以用手机录了。下一步给每个人分货架。`} okText="开始" onOk={start}>开始盘点</ConfirmBtn></div>
          </> : <span className="muted">现在没有在进行的盘点。中方开始盘点后，这里会出现录入框和你的任务。</span>}
        </div></div>)}
      {data?.hist?.length > 0 && <div className="card" style={{ marginTop: 12 }}>
        <div className="card-h"><h2>以前的盘点</h2></div>
        <Grid id="count-hist" compactTools rows={data.hist} rowKey={(r) => r.id} rowActions={[{ label: '看差异', run: (r) => setView(r) }]} columns={[
          { key: 'no', label: '编号', w: 130, render: (r) => <b className="mono">{r.no}</b> }, { key: 'title', label: '名字', w: 140 }, { key: 'started_at', label: '开始', w: 130, render: (r) => dt(r.started_at) },
          { key: 'closed_at', label: '结束', w: 130, render: (r) => (r.closed_at ? dt(r.closed_at) : '') }, { key: 'status', label: '结果', w: 80, value: (r) => (r.status === 'closed' ? '已确认' : '已取消') },
          { key: 'n', label: '录了几条', w: 80, type: 'number' }, { key: 'pool', label: '进池编码', w: 80, type: 'number' }, { key: 'loss', label: '盘亏（片）', w: 90, type: 'number' }, { key: 'gain', label: '盘盈（片）', w: 90, type: 'number' }]} />
      </div>}
      {view && <div className="card" style={{ marginTop: 12 }}><div className="card-h"><h2>{view.no} 的差异</h2><span className="grow" /><button type="button" className="btn sm ghost" onClick={() => setView(null)}>收起</button></div><Diffs countId={view.id} closed /></div>}
    </>
  );
}

function Open({ c, me, admin, boss }) {
  const { org, role, toast, refresh } = useApp();
  const { data } = useData(async () => {
    const [lines, tasks, products, emps] = await Promise.all([
      q(`select l.*, b.code as bin, p.code, p.model, p.variant, cat.name as category, e.short_name as by_name, app.prod_group(l.product_id) as grp from app.count_lines l join app.bins b on b.id = l.bin_id
         join app.products p on p.id = l.product_id join app.categories cat on cat.id = p.category_id left join app.employees e on e.id = l.by_employee where l.count_id = $1 order by l.at desc`, [c.id]),
      q(`select t.*, e.short_name, e.emp_no from app.count_tasks t join app.employees e on e.id = t.employee_id where t.count_id = $1 order by t.created_at`, [c.id]),
      q(PRODUCTS_SQL, [org]),
      q(`select id, short_name, emp_no, department from app.employees where org_id = $1 and active order by emp_no nulls last, short_name`, [org])]);
    return { lines, tasks, products, emps };
  }, [c.id, org]);
  const lines = useMemo(() => data?.lines || [], [data]);
  const [bin, setBin] = useState(''); const [prod, setProd] = useState(''); const [n, setN] = useState(''); const [note, setNote] = useState('');
  const [tEmp, setTEmp] = useState(''); const [tScope, setTScope] = useState('');
  const [diff, setDiff] = useState(false); const [all, setAll] = useState(boss);
  const mine = data?.tasks.filter((t) => t.employee_id === me) || [];
  const run = async (msg, sql, args) => { try { await call(role, sql, args); if (msg) toast(msg); refresh(); return true; } catch (e) { toast(friendlyError(e), 'err'); return false; } };
  const add = async () => { if (await run(null, `select app.count_add($1,$2,$3,$4,$5)`, [c.id, bin, prod, Number(n), note || null])) { toast(`已记：${bin} · ${data.products.find((p) => p.id === prod)?.model} · ${n} 片`); setProd(''); setN(''); setNote(''); } };
  // 提醒: 这个型号别的库位也盘到 / 同一种货的别的编码也盘到 / 这个库位已经录过的
  const p = data?.products.find((x) => x.id === prod);
  const elsewhere = prod ? lines.filter((l) => l.product_id === prod && l.bin !== bin) : [];
  const sameGrp = prod && p ? lines.filter((l) => l.product_id !== prod && l.grp && l.grp.startsWith('U:') && l.grp === lines.find((x) => x.product_id === prod)?.grp) : [];
  const here = bin ? lines.filter((l) => l.bin === bin) : [];
  const dup = prod && here.find((l) => l.product_id === prod);
  const shownLines = all ? lines : lines.filter((l) => l.by_user === USERS[role]);
  const nBins = new Set(lines.map((l) => l.bin)).size;
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>{c.title} <span className="muted small mono">{c.no}</span></h2>
          {c.pause_ship ? <span className="pill red">出货已暂停</span> : <span className="pill gray">出货没暂停</span>}
          {admin && <ConfirmBtn className="btn sm ghost" title={c.pause_ship ? '恢复出货？' : '暂停出货？'} body={c.pause_ship ? '恢复后盘点期间又出的货会让盘到的数对不上，确定？' : '暂停后所有出库都会被拦住，直到确认盘点结果。'} onOk={() => run(c.pause_ship ? '已恢复出货' : '已暂停出货', `select app.count_set_freeze($1,$2)`, [c.id, !c.pause_ship])}>{c.pause_ship ? '恢复出货' : '暂停出货'}</ConfirmBtn>}
          <span className="grow" /><span className="small muted">开始 {dt(c.started_at)} · 已录 <b>{lines.length}</b> 条 · <b>{nBins}</b> 个库位</span></div>
        {mine.length > 0 && <div className="card-b stack" style={{ gap: 4, paddingBottom: 0 }}>{mine.map((t) => <div key={t.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="pill blue">我的任务</span><b>{t.scope}</b>{t.status === 'done' ? <span className="pill green">盘完了</span> : <button type="button" className="btn sm" onClick={() => run('已标记盘完，等主管看', `select app.count_task_done($1,true)`, [t.id])}>我盘完了</button>}</div>)}</div>}
        <div className="card-b count-form">
          <FRow label="库位" req><BinPick value={bin} onChange={setBin} /></FRow>
          {binDone(bin) && here.length > 0 && <div className="small muted">这个库位已经录了：{here.map((l) => `${l.model} ${qty(l.qty)}`).join('、')}</div>}
          <FRow label="型号" req><ProdPick products={data?.products || []} value={prod} onChange={setProd} /></FRow>
          {elsewhere.length > 0 && <div className="count-warn">这个型号在 <b>{elsewhere.map((l) => `${l.bin}（${qty(l.qty)} 片）`).join('、')}</b> 也盘到了，最后合在一起算。</div>}
          {sameGrp.length > 0 && <div className="count-warn">同一种货的别的编码也盘到了：{[...new Set(sameGrp.map((l) => `${l.code} @ ${l.bin}`))].join('、')}，算一类。</div>}
          {dup && <div className="count-warn">你在 {bin} 已经录过这个型号 {qty(dup.qty)} 片；再记一次 = 改成新的数。</div>}
          <FRow label="数量" req><input className="in qty" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} placeholder="片" /></FRow>
          <FRow label="备注"><input className="in" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="可不填，例 有 5 片碎屏" /></FRow>
          <div className="actbar">{!(binDone(bin) && prod && n !== '') && <span className="why">先选库位、型号，再填数量</span>}<button type="button" className="btn primary lg" disabled={!(binDone(bin) && prod && n !== '')} onClick={add}>记下</button></div>
        </div>
      </div>
      {boss && <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h"><h2>分任务 <span className="muted small">{data?.tasks.filter((t) => t.status === 'done').length || 0} / {data?.tasks.length || 0} 盘完</span> <Info>谁盘哪几个货架。员工打开盘点页就看到自己的任务；盘完点「我盘完了」，再给他派下一批。</Info></h2></div>
        <div className="card-b stack" style={{ gap: 6 }}>
          {(data?.tasks || []).map((t) => { const got = lines.filter((l) => l.by_employee === t.employee_id); return (
            <div key={t.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}><EmpLink id={t.employee_id} name={t.short_name} /><b>{t.scope}</b>
              <span className={`pill ${t.status === 'done' ? 'green' : 'amber'}`}>{t.status === 'done' ? '盘完了' : '在盘'}</span><span className="small muted">录了 {got.length} 条</span><span className="grow" />
              {t.status === 'done' && <button type="button" className="btn sm ghost" onClick={() => run('退回去重盘', `select app.count_task_done($1,false)`, [t.id])}>退回重盘</button>}
              <ConfirmBtn className="btn sm ghost" title="删掉这个任务？" body="他已经录的数不会删。" onOk={() => run('已删', `select app.count_task_del($1)`, [t.id])}>删</ConfirmBtn></div>); })}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Choice value={tEmp} onChange={setTEmp} placeholder="谁盘" options={(data?.emps || []).map((e) => [e.id, `${e.emp_no ? e.emp_no + ' ' : ''}${e.short_name}`])} />
            <input className="in" style={{ width: 220 }} value={tScope} onChange={(e) => setTScope(e.target.value.toUpperCase())} placeholder="盘哪些货架，例 SS-A, SS-B, LR" />
            <button type="button" className="btn" disabled={!tEmp || !tScope.trim()} onClick={async () => { if (await run('已派', `select app.count_task_set($1,$2,$3)`, [c.id, tEmp, tScope])) setTScope(''); }}>＋ 派任务</button></div>
        </div>
      </div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>录了什么</h2><span className="grow" />{boss && <Choice value={all ? 'all' : 'mine'} onChange={(v) => setAll(v === 'all')} options={[['mine', '只看我录的'], ['all', '全部']]} />}</div>
        <Grid id="count-lines" compactTools rows={shownLines} rowKey={(r) => r.id} empty="还没录" rowActions={[{ label: '删掉这条', danger: true, when: (r) => boss || r.by_user === USERS[role], run: (r) => run('已删', `select app.count_del($1)`, [r.id]) }]} columns={[
          { key: 'bin', label: '库位', w: 90, render: (r) => <b className="mono">{r.bin}</b> }, { key: 'category', label: '种类', w: 80 },
          { key: 'model', label: '型号', w: 140, render: (r) => <ModelLink id={r.product_id} model={r.model} /> }, { key: 'variant', label: '区分', w: 80 }, { key: 'code', label: '编码', w: 100 },
          { key: 'qty', label: '数量', w: 80, type: 'number', sum: true }, { key: 'by_name', label: '谁录的', w: 80 }, { key: 'at', label: '时间', w: 120, render: (r) => dt(r.at) }, { key: 'note', label: '备注', w: 140 }]} />
      </div>
      {admin && <div className="card">
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}><h2>差异 <Info>系统数 = LA + 9S 两个仓合计。同一种货（编码甄别里定过）一个编码多、一个编码少能抵消的进「消耗池」；抵消不了的是真盘亏 / 盘盈。没盘到的编码按实物 0 算。</Info></h2><span className="grow" />
          <button type="button" className="btn" onClick={() => setDiff(!diff)}>{diff ? '收起' : '看差异'}</button></div>
        {diff && <Diffs countId={c.id} />}
        <div className="card-b actbar">
          <ConfirmBtn className="btn ghost" title="取消这次盘点？" body="录的数都不算，系统库存不动，出货恢复。" onOk={() => run('已取消，出货恢复', `select app.count_cancel($1)`, [c.id])}>取消这次盘点</ConfirmBtn><span className="grow" />
          <ConfirmBtn className="btn primary" risk="red" title="确认盘点结果、写进系统？" okText="确认写进系统"
            body={'确认后：\n· 系统库存改成盘到的实物数（LA / 9S 按现有的仓分：多了加到数量多的仓，少了从数量多的仓扣）\n· 库位按这次盘到的重写，以前的记录保留\n· 同一种货能抵消的进消耗池，以后出货时金蝶改记池里的编码\n· 盘亏 / 盘盈的要去金蝶录盘亏 / 盘盈单\n· 出货恢复\n这一步撤不回。'}
            onOk={async () => { try { const [r] = await call(role, `select app.count_apply($1) as r`, [c.id]); const x = r?.r || {}; toast(`已写进系统：改了 ${x.adjusted} 个编码，进池 ${x.pool} 条，盘亏 ${qty(x.loss)} 片，盘盈 ${qty(x.gain)} 片`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } }}>确认写进系统</ConfirmBtn>
        </div>
      </div>}
    </>
  );
}

// 差异表: 进行中 = 预览 (不落库); 确认后 = 存下来的那份
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
  const KIND = { ok: ['对上了', 'green'], pool: ['错码 · 进池', 'amber'], loss: ['盘亏', 'red'], gain: ['盘盈', 'amber'] };
  const shown = rows.filter((r) => (f === 'all' ? true : f === 'diff' ? r.kind !== 'ok' : r.kind === f));
  return (
    <div className="card-b stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="pill green">对上了 {rows.filter((r) => r.kind === 'ok').length} 个编码</span>
        <span className="pill amber">错码进池 {rows.filter((r) => Number(r.pool_plus) > 0 || Number(r.pool_minus) > 0).length} 个编码 · {qty(sum('pool_plus'))} 片</span>
        <span className="pill red">盘亏 {qty(sum('loss'))} 片</span><span className="pill amber">盘盈 {qty(sum('gain'))} 片</span>
        <Assumed>系统盘完马上改成实物数（销售看到的可售就是真的）；金蝶那边：错码靠以后出货时改记池里的编码慢慢对齐，盘亏 / 盘盈要录单。这是在你说的「消耗池」上改的一点：你原来的说法是系统也跟着金蝶慢慢捞。</Assumed>
        <span className="grow" /><Choice value={f} onChange={setF} options={[['diff', '只看有差的'], ['loss', '盘亏'], ['gain', '盘盈'], ['pool', '错码进池'], ['all', '全部']]} />
      </div>
      <Grid id={`count-diff-${closed ? 'c' : 'p'}`} compactTools rows={shown} rowKey={(r) => r.product_id} empty="没有差异 ✓" columns={[
        { key: 'code', label: '编码', w: 100 }, { key: 'category', label: '种类', w: 80 }, { key: 'model', label: '型号', w: 140, render: (r) => <ModelLink id={r.product_id} model={r.model} /> }, { key: 'variant', label: '区分', w: 80 },
        { key: 'kind', label: '结论', w: 100, value: (r) => KIND[r.kind][0], render: (r) => <span className={`pill ${KIND[r.kind][1]}`}>{KIND[r.kind][0]}</span> },
        { key: 'sys_qty', label: '系统', w: 80, type: 'number', sum: true }, { key: 'actual_qty', label: '实物', w: 80, type: 'number', sum: true },
        { key: 'diff', label: '系统多', w: 80, type: 'number', render: (r) => <span className={Number(r.diff) > 0 ? 'red-t2' : ''}>{qty(r.diff)}</span> },
        { key: 'pool_plus', label: '进池（没实物）', w: 100, type: 'number', sum: true }, { key: 'pool_minus', label: '进池（实物多）', w: 100, type: 'number', sum: true },
        { key: 'loss', label: '盘亏', w: 70, type: 'number', sum: true }, { key: 'gain', label: '盘盈', w: 70, type: 'number', sum: true }]} />
    </div>);
}
