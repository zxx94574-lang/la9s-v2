// 员工与工资 (只中方). Frank 10-31:
//  表 1「员工档案」: 全名 / 工作名 / 邮箱 / 电话 / 部门 / 职位 / 入职 / 状态 / 证件照, 能单选的都单选, 日期用日期选择.
//  表 2「工资发放记录」: 每月一张, 列和 8 月 Excel 一样, 能导出同样式的 Excel; 中方批准、中方标记已付, 付了就锁死永久留底.
//  真实员工以飞书 STAFF INF 为准 (真实数据版开局导入), Excel 只是参考模板.
import { normPhone, fmtPhone } from '../lib/phone.js';
import { ConfirmEdit, HistoryBlock } from '../components/ProductDrawer.jsx';
import React, { useMemo, useRef, useState } from 'react';
import AttCalendar from '../components/AttCalendar.jsx';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, Drawer, DatePicker, MonthPicker, Thumb, FileDrop , PhoneInput, phoneValid} from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ROLE_LABELS } from '../lib/domain.js';
import { staffOptions, optLabel, SYS_ROLES } from '../lib/staffOptions.js';
import { money, today, ymd, dDate, friendlyError } from '../lib/format.js';
import { saveFile } from '../lib/saveFile.js';

const N = (v) => Number(v || 0);
const ym = (d) => d.slice(0, 7);
const STATUS = { draft: ['草稿', 'amber'], approved: ['已批准 · 待付', 'blue'], paid: ['已付 · 已锁定', 'green'] };

export default function Staff() {
  const { org, role } = useApp();
  const [tab, setTab] = useState(role === 'sales_manager' ? 'pay' : 'staff');
  const { data } = useData(async () => {
    const [staff, opt] = await Promise.all([q(Q.staffList, [org]), q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org])]);
    return { staff, opts: staffOptions(opt[0]?.value) };
  }, [org]);
  const payrollOnly = role === 'sales_manager';   // 罗兰 (国家经理): 只看工资单, 起草 + 初审
  if (role !== 'admin' && !payrollOnly) return <div className="card card-b lock">员工与工资只有中方能看。</div>;
  if (!data) return <div className="empty">加载中…</div>;
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Personnel & salaires</div><h1>员工与工资</h1>
        <div className="sub">只有中方能看。员工信息以飞书 STAFF INF 为准；工资每月一张记录，中方批准、中方标记已付，付了就锁定，永久留底。</div></div></div>
      <div className="card">
        <div className="tabs">
          {(payrollOnly ? [['pay', '工资单']] : [['staff', '员工档案'], ['pay', '工资单'], ['opts', '选项设置']]).map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'staff' && <StaffTable staff={data.staff} opts={data.opts} />}
        {tab === 'pay' && <Payroll staff={data.staff} opts={data.opts} />}
        {tab === 'opts' && <OptionsEditor opts={data.opts} />}
      </div>
    </>
  );
}

// ───────── 表 1 员工档案 (Frank 11-07: 像飞书一样, 点一下选格子、再点进编辑, 改一格存一格; 也能点 ↗ 打开完整档案) ─────────
const daysSince = (d) => (d ? Math.max(0, Math.floor((new Date(today()) - new Date(String(d).slice(0, 10))) / 864e5)) : null);
function StaffTable({ staff, opts }) {
  const { org, role, toast, refresh } = useApp();
  const [show, setShow] = useState('active');
  const [edit, setEdit] = useState(null);
  const people = staff.filter((e) => !e.is_account);
  const accounts = staff.filter((e) => e.is_account);
  const rows = people.filter((e) => (show === 'all' ? true : show === 'active' ? e.active : !e.active));
  const orig = (e, k) => (k === 'joined_on' ? (e.joined || '') : k === 'resigned_on' ? (e.resigned || '') : e[k] == null ? '' : String(e[k]));
  const cur = orig;
  // 改一格存一格: 把这一行其他字段原样带上 (upsert_employee 是整行写)
  // 同一批里同一个人改了几格 (比如粘贴一整行): 后面的保存要带上前面刚改的值, 不然互相覆盖
  const pend = useRef({});
  const saveCell = async (e, k, v, meta) => {
    pend.current[e.id] = { ...(pend.current[e.id] || {}), [k]: v };
    const mine = pend.current[e.id];
    const payload = {};
    for (const f of ['emp_no', 'short_name', 'full_name', 'phone', 'email', 'feishu_name', 'city', 'address', 'department', 'position', 'sys_role', 'sales_channel', 'joined_on', 'resigned_on', 'base_salary', 'allowance', 'incentive_rate', 'incentive_per_piece', 'note']) payload[f] = f in mine ? mine[f] : orig(e, f);
    payload.active = e.active;
    if (!meta?.batch || meta.last) setTimeout(() => { pend.current = {}; }, 0);
    try { await call(role, `select app.upsert_employee($1,$2,$3)`, [org, e.id, JSON.stringify(payload)]); if (!meta?.batch || meta.last) { toast(meta?.batch ? `已保存 ${meta.total} 格` : '已保存'); refresh(); } }
    catch (err) { toast(friendlyError(err), 'err'); }
  };
  const txt = (k) => (e) => ({ type: 'text', value: cur(e, k), onChange: (v, m) => saveCell(e, k, v, m) });
  const sel = (k, options) => (e) => ({ type: 'select', value: cur(e, k), onChange: (v, m) => saveCell(e, k, v, m), options: [['', '—'], ...options.map((o) => [o.v, o.l]), ...(cur(e, k) && !options.some((o) => o.v === cur(e, k)) ? [[cur(e, k), cur(e, k)]] : [])] });
  // 列照 Frank 11-07 定的顺序: 工号、全称、简称、部门、职位、入职日期、负责城市、电话、邮箱、住址、身份证照片. 拖表头可以调顺序, 定下来就不动.
  const cols = [
    { key: 'emp_no', label: '工号', w: 80, value: (e) => cur(e, 'emp_no'), edit: txt('emp_no') },
    { key: 'full_name', label: '全称', w: 230, value: (e) => cur(e, 'full_name'), edit: txt('full_name') },
    { key: 'short_name', label: '简称', w: 100, value: (e) => cur(e, 'short_name'), edit: txt('short_name') },
    { key: 'department', label: '部门', w: 120, value: (e) => optLabel(opts.departments, cur(e, 'department')), edit: sel('department', opts.departments) },
    { key: 'position', label: '职位', w: 130, value: (e) => optLabel(opts.positions, cur(e, 'position')), edit: sel('position', opts.positions) },
    { key: 'joined_on', label: '入职日期', w: 110, value: (e) => cur(e, 'joined_on'), edit: (e) => ({ type: 'date', value: cur(e, 'joined_on'), onChange: (v, m) => saveCell(e, 'joined_on', v, m) }) },
    { key: 'tenure', label: '在职天数', w: 90, type: 'number', value: (e) => daysSince(e.active ? e.joined : null) ?? (e.joined && e.resigned ? Math.floor((new Date(e.resigned) - new Date(e.joined)) / 864e5) : null), render: (e) => { const d = e.active ? daysSince(e.joined) : (e.joined && e.resigned ? Math.floor((new Date(e.resigned) - new Date(e.joined)) / 864e5) : null); return d == null ? '' : <span title={e.active ? '从入职日期算到今天' : '入职到离职'}>{d.toLocaleString('en-US')}</span>; } },
    { key: 'city', label: '负责城市', w: 100, value: (e) => cur(e, 'city'), edit: txt('city') },
    { key: 'phone', label: '电话', w: 150, value: (e) => cur(e, 'phone'), render: (e) => fmtPhone(cur(e, 'phone')), edit: (e) => ({ type: 'text', value: cur(e, 'phone'), onChange: (v, m) => { const n = normPhone(v); if (!n.valid) return toast(`电话位数不对：${v}（+${n.cc} 要 ${n.need} 位）`, 'err'); saveCell(e, 'phone', n.formatted, m); } }) },
    { key: 'email', label: '邮箱', w: 190, value: (e) => cur(e, 'email'), edit: txt('email') },
    { key: 'address', label: '住址', w: 200, value: (e) => cur(e, 'address'), edit: txt('address') },
    { key: 'files', label: '身份证照片', w: 90, value: (e) => N(e.files), render: (e) => (N(e.files) ? <Pill tone="blue">{N(e.files)} 张</Pill> : <span className="muted small">没有</span>) },
    { key: 'active', label: '状态', w: 80, value: (e) => (e.active ? '在职' : '离职'), render: (e) => (e.active ? <Pill tone="green">在职</Pill> : <Pill>离职{e.resigned ? ` ${e.resigned.slice(5)}` : ''}</Pill>) },
    { key: 'base_salary', label: '底薪', w: 110, hidden: true, type: 'money', value: (e) => N(cur(e, 'base_salary')), edit: (e) => ({ type: 'number', value: cur(e, 'base_salary'), onChange: (v, m) => saveCell(e, 'base_salary', v.replace(/[^\d.]/g, ''), m) }) },
    { key: 'sales_channel', label: '销售渠道', w: 100, hidden: true, value: (e) => optLabel(opts.sales_channels, e.sales_channel) },
    { key: 'sys_role', label: '系统岗位', w: 100, hidden: true, value: (e) => ROLE_LABELS[e.sys_role] || '' },
    { key: 'feishu_name', label: '飞书账号', w: 150, hidden: true },
    { key: 'missing', label: '缺什么', w: 130, value: (e) => [!cur(e, 'emp_no') && '工号', !cur(e, 'department') && '部门', !cur(e, 'position') && '职位', !cur(e, 'joined_on') && '入职日期', !cur(e, 'phone') && '电话'].filter(Boolean).join('、'),
      render: (e) => { const m = [!cur(e, 'emp_no') && '工号', !cur(e, 'department') && '部门', !cur(e, 'position') && '职位', !cur(e, 'joined_on') && '入职日期', !cur(e, 'phone') && '电话'].filter(Boolean); return m.length ? <span className="pill amber">缺 {m.join('、')}</span> : ''; } },
  ];
  return (
    <>
      <Grid id="staff4" table="employees" columns={cols} rows={rows} onRowClick={(e) => setEdit(e)} empty="没有员工"
        foot={(rs) => ({ short_name: `${rs.length} 人` })}
        tools={<>
          <div className="chips">{[['active', `在职 ${people.filter((e) => e.active).length}`], ['inactive', `离职 ${people.filter((e) => !e.active).length}`], ['all', '全部']].map(([k, l]) =>
            <button type="button" key={k} className={`chip ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{l}</button>)}</div>
          <button type="button" className="btn sm" onClick={() => setEdit({})}>＋ 新员工</button>
          <span className="hint">点一下选格子，再点一下改，改完自动保存；行号旁 ↗ 打开完整档案（证件照在里面）。</span></>} />
      {accounts.length > 0 && <div className="small muted" style={{ padding: '8px 14px' }}>另有 {accounts.length} 个系统岗位账号（{accounts.map((a) => a.short_name).join('、')}），只用来右上角切换岗位演示，不算员工。</div>}
      {edit && <EmpModal e={edit} opts={opts} onClose={() => setEdit(null)} />}
    </>
  );
}

async function compress(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const s = Math.min(1, 1000 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { data: c.toDataURL('image/jpeg', 0.8).split(',')[1], w: c.width, h: c.height, name: file.name || 'photo.jpg' };
}

function Select({ value, onChange, options, placeholder = '— 选择 —' }) {
  return (
    <select className="in" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

export function EmpModal({ e, opts, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const s = (v) => (v == null || v === '' ? '' : String(Number(v)));
  const [f, setF] = useState({
    emp_no: e.emp_no || '', short_name: e.short_name || '', full_name: e.full_name || '', phone: e.phone || '', email: e.email || '', feishu_name: e.feishu_name || '',
    city: e.city || '', address: e.address || '',
    department: e.department || '', position: e.position || '', sys_role: e.sys_role || '', sales_channel: e.sales_channel || '',
    joined_on: e.joined || '', resigned_on: e.resigned || '', active: e.active !== false,
    base_salary: s(e.base_salary), allowance: s(e.allowance), incentive_rate: s(e.incentive_rate), incentive_per_piece: s(e.incentive_per_piece), note: e.note || '',
  });
  const [kind, setKind] = useState('id_front');
  const [queued, setQueued] = useState([]);
  // 206: 已有员工的档案先锁着, 点「✎ 修改」解锁; 保存前列出改前 → 改后 + 自检, 确认后存并留记录
  const [f0] = useState(() => f);
  const [locked, setLocked] = useState(!!e.id);
  const [confirm, setConfirm] = useState(null);
  const { data: hist } = useData(() => (e.id && role === 'admin' ? call(role, `select * from app.archive_history($1,'employee',$2)`, [org, e.id]) : Promise.resolve([])), [e.id, org]);
  const { data: files } = useData(() => (e.id ? q(Q.employeeFiles, [e.id]) : Promise.resolve([])), [e.id]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const setPos = (v) => { const p = opts.positions.find((x) => x.v === v); setF((x) => ({ ...x, position: v, sys_role: p?.role || x.sys_role, department: x.department || p?.dept || '', sales_channel: /SALES STAFF/.test(v) ? x.sales_channel : '' })); };
  const posOpts = opts.positions.filter((p) => !f.department || !p.dept || p.dept === f.department || p.v === f.position);
  const inp = (k, l, o = {}) => <div className="field"><label>{l}</label><input className="in" inputMode={o.num ? 'decimal' : o.mode} value={f[k]} placeholder={o.ph}
    onChange={(x) => set(k)(o.num ? x.target.value.replace(/[^\d.]/g, '') : x.target.value)} /></div>;
  const emailBad = f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email);
  const LABEL = { emp_no: '工号', short_name: '简称', full_name: '全称', phone: '电话', email: '邮箱', feishu_name: '飞书账号', city: '负责城市', address: '住址', department: '部门', position: '职位', sys_role: '系统岗位', sales_channel: '销售类型', joined_on: '入职日期', resigned_on: '离职日期', active: '在职', base_salary: '合同底薪', allowance: '每月补贴', incentive_rate: '奖金 %', incentive_per_piece: '奖金 每件', note: '备注' };
  const review = () => {
    if (!e.id) return go();
    const rows = Object.keys(LABEL).filter((k) => String(f0[k] ?? '') !== String(f[k] ?? '')).map((k) => [LABEL[k], k === 'active' ? (f0[k] ? '在职' : '离职') : (f0[k] || '—'), k === 'active' ? (f[k] ? '在职' : '离职') : (f[k] || '—')]);
    if (!rows.length && !queued.length) { setLocked(true); return toast('没有改动，已锁回'); }
    const checks = [];
    if (f.phone && !phoneValid(f.phone)) return toast(`电话位数不对：${f.phone}，改对了再存`, 'err');
    for (const k of ['base_salary', 'allowance']) {
      const a = Number(f0[k] || 0), b = Number(f[k] || 0);
      if (b < 0) checks.push({ tone: 'red', msg: `${LABEL[k]}不能是负数` });
      else if (a > 0 && Math.abs(b - a) / a > 0.1) checks.push({ tone: 'amber', msg: `${LABEL[k]}从 ${a.toLocaleString('en-US')} 改到 ${b.toLocaleString('en-US')}，变动超过 10%` });
    }
    if (f0.active && !f.active) checks.push({ tone: 'amber', msg: '改成离职：名下客户要重新分配，未完成的单要转给主管' });
    setConfirm({ rows: rows.length ? rows : [['证件照', '—', `新加 ${queued.length} 张`]], checks });
  };
  const go = async (reason) => {
    try {
      const [{ id }] = await call(role, `select app.upsert_employee($1,$2,$3) as id`, [org, e.id || null, JSON.stringify(f)]);
      for (const p of queued) await call(role, `select app.add_employee_file($1,$2,$3,$4,'image/jpeg',$5,$6,$7)`, [org, id, p.kind, p.name, p.data, p.w, p.h]);
      if (e.id && confirm) await call(role, `select app.log_archive_edit($1,'employee',$2,$3,$4,$5)`, [org, e.id, JSON.stringify(Object.fromEntries(confirm.rows.map(([l, a, b]) => [l, [a, b]]))), JSON.stringify(confirm.checks.map((c) => `${c.tone === 'red' ? '红' : '黄'}：${c.msg}`)), reason || null]).catch(() => {});
      toast(e.id ? '已保存，档案已锁回' : '已保存'); refresh(); onClose();
    } catch (x) { toast(friendlyError(x), 'err'); }
  };
  const addFile = async (file) => { if (!file?.type?.startsWith('image/')) return toast('请选图片', 'err'); const p = await compress(file); setQueued((x) => [...x, { ...p, kind }]); };
  const removeFile = async (id) => { try { await call(role, `select app.remove_employee_file($1)`, [id]); toast('已移除（记录还在审计里）'); refresh(); } catch (x) { toast(friendlyError(x), 'err'); } };
  const KIND = { id_front: '身份证正面', id_back: '身份证反面', id: '证件', contract: '合同', other: '其他' };
  const all = [...(files || []).map((x) => ({ ...x, src: `data:${x.mime};base64,${x.data}`, saved: true })), ...queued.map((x, i) => ({ ...x, i, src: `data:image/jpeg;base64,${x.data}` }))];
  return (
    <Modal wide title={e.id ? `员工 · ${e.short_name}` : '新员工'} onClose={onClose}
      footer={locked ? <><button type="button" className="btn" onClick={onClose}>关闭</button>{['admin', 'sales_manager'].includes(role) && <button type="button" className="btn primary" onClick={() => setLocked(false)}>✎ 修改</button>}</>
        : <><button type="button" className="btn" onClick={() => (e.id ? (setF(f0), setQueued([]), setLocked(true)) : onClose())}>{e.id ? '取消修改' : '取消'}</button><button type="button" className="btn primary" disabled={!f.short_name.trim() || emailBad} onClick={review}>{e.id ? '保存修改…' : '保存'}</button></>}>
      {locked && <div className="banner info" style={{ marginBottom: 10 }}>档案已锁住，点右下角「✎ 修改」解锁；保存前会列出改了什么并自检，存完自动锁回。</div>}
      <fieldset className="lockset" disabled={locked}>
      <div className="grid2">
        {inp('emp_no', '工号（S + 三位数字，比如 S001；你自己编，离职不回收）', { ph: 'S001' })}{inp('full_name', '全称（大写，和证件一致）')}{inp('short_name', '简称 *（比如 Grace）')}
        <div className="field"><label>电话</label><PhoneInput value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} /></div>{inp('city', '负责城市', { ph: 'Abidjan' })}{inp('address', '住址')}
        <div className="field"><label>邮箱</label><input className={`in ${emailBad ? 'err' : ''}`} inputMode="email" value={f.email} onChange={(x) => set('email')(x.target.value.trim())} />{emailBad && <span className="small red-t">格式不对</span>}</div>
        <div className="field"><label>部门</label><Select value={f.department} onChange={(v) => setF((x) => ({ ...x, department: v, position: opts.positions.find((p) => p.v === x.position && (!p.dept || p.dept === v)) ? x.position : '' }))} options={opts.departments} /></div>
        <div className="field"><label>职位</label><Select value={f.position} onChange={setPos} options={posOpts} /></div>
        {/SALES STAFF/.test(f.position) && <div className="field"><label>销售类型</label><div className="chips">{opts.sales_channels.map((c) =>
          <button type="button" key={c.v} className={`chip ${f.sales_channel === c.v ? 'on' : ''}`} onClick={() => set('sales_channel')(f.sales_channel === c.v ? '' : c.v)}>{c.l}</button>)}</div></div>}
        <div className="field"><label>系统岗位（登录后能做什么；选职位会自动带出）</label>
          <Select value={f.sys_role} onChange={set('sys_role')} options={SYS_ROLES.map((r) => ({ v: r, l: ROLE_LABELS[r] }))} placeholder="— 不登录系统 —" /></div>
        <div className="field"><label>入职日期</label><DatePicker value={f.joined_on || null} onChange={set('joined_on')} label={f.joined_on ? '' : '选日期'} /></div>
        <div className="field"><label>状态</label><div className="row" style={{ gap: 8 }}>
          <div className="chips">{[[true, '在职'], [false, '离职']].map(([v, l]) => <button type="button" key={l} className={`chip ${f.active === v ? 'on' : ''}`} onClick={() => set('active')(v)}>{l}</button>)}</div>
          {!f.active && <DatePicker value={f.resigned_on || null} onChange={set('resigned_on')} label="离职日期" />}</div></div>
        {inp('feishu_name', '飞书账号（显示名）')}
        {inp('base_salary', '合同底薪 XOF（满勤）', { num: true })}{inp('allowance', '每月补贴 XOF', { num: true })}
        {inp('incentive_rate', '个人奖金：归属客户出库金额 %（待对规则）', { num: true })}{inp('incentive_per_piece', '个人奖金：每件 XOF（待对规则）', { num: true })}
        {inp('note', '备注')}
      </div>
      </fieldset>
      <div className="stack" style={{ marginTop: 14, gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><b>证件照</b><span className="small muted">只有中方能看。存在系统里，不会删除（移除只是隐藏，审计里有记录）。</span><span className="grow" />
          <span className="small">这张是</span><select className="in" style={{ maxWidth: 140 }} value={kind} onChange={(x) => setKind(x.target.value)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <FileDrop accept="image/*" multiple compact label="把身份证照片拖到这里，或点击从电脑选" hint="可一次拖多张，按上面选的类型归档；也可以 ⌘V 粘贴截图" onFiles={(fs) => fs.forEach((f) => addFile(f))} />
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {all.length === 0 && <span className="muted small">还没有照片</span>}
          {all.map((p, i) => (
            <div key={p.id || `q${p.i}`} className="stack" style={{ gap: 4, alignItems: 'center' }}>
              <Thumb src={p.src} size={96} group={all.map((x) => ({ src: x.src, label: KIND[x.kind] }))} label={KIND[p.kind]} />
              <span className="small">{KIND[p.kind] || p.kind}{p.saved ? '' : '（保存后上传）'}</span>
              {p.saved ? <button type="button" className="btn sm ghost" onClick={() => removeFile(p.id)}>移除</button>
                : <button type="button" className="btn sm ghost" onClick={() => setQueued((x) => x.filter((_, j) => j !== p.i))}>×</button>}
            </div>))}
        </div>
      </div>
      {e.id && role === 'admin' && <div style={{ marginTop: 12 }}><HistoryBlock hist={hist} title="修改记录" /></div>}
      {confirm && <ConfirmEdit c={confirm} title="确认修改员工档案" onBack={() => setConfirm(null)} onSave={(r) => go(r)} />}
    </Modal>
  );
}

// ───────── 表 2 本月工资单 (Frank 11-07 15:35 重做) ─────────
// · 一个月一张单: 月份选年 + 月 → 草稿 (可改) → 「确认发放」(只中方) → 已确认发放 (锁定, 不再改)
// · 不要审批流 (制表 / 主管 / 财务 / 审批人): 罗兰起草和初审, 中方拍板
// · 社保公司承担: 不进实发, 公司成本 = 实发 + 社保; 不再提供开关
// · 列: 工号 / 员工 (全称 + 简称一格) / 部门 / 职位 / 实到工作日 / 合同底薪 / 预计基本工资 / 补贴 / 个人奖金 / 团队奖金 / 社保 / 扣款 / 实发 / 公司成本 / 备注
// · 删行: 选中行后工具栏「从本月去掉」, 不用每行小叉
const STATUS2 = { draft: ['草稿', 'amber'], approved: ['草稿（已初审）', 'amber'], paid: ['已确认发放', 'green'] };
function Payroll({ staff, opts }) {
  const { org, role, toast, refresh } = useApp();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [dept, setDept] = useState('');
  const [history, setHistory] = useState(false);
  const [selRows, setSelRows] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const [unconfirm, setUnconfirm] = useState(false);
  const [profile, setProfile] = useState(null);     // 点名字 → 完整档案
  const [attOf, setAttOf] = useState(null);         // 点打卡情况 → 该员工本月打卡明细
  const [ack, setAck] = useState(false);
  const { data } = useData(async () => {
    const [months, head, lines, comm, rate] = await Promise.all([q(Q.payrollMonths, [org]), q(Q.payrollHeader, [org, month + '-01']), q(Q.payroll, [org, month + '-01']),
      q(`select employee_id, count(*) filter (where not voided)::int as ok_n, coalesce(sum(pieces) filter (where not voided), 0)::int as ok_pcs, count(*) filter (where voided)::int as void_n, coalesce(sum(pieces) filter (where voided), 0)::int as void_pcs
         from app.v_wh_commission where org_id = $1 and month = $2 group by employee_id`, [org, month]).catch(() => []),
      q(`select value from app.org_settings where org_id = $1 and key = 'wh_commission'`, [org]).catch(() => [])]);
    // 仓库提成 (Frank 11-12): 正确出货每片 N XOF (设置里可调, 默认 5); 出错被记责任的那张单整单提成取消
    return { months, head: head[0] || null, lines, comm: Object.fromEntries(comm.map((c) => [c.employee_id, c])), rate: Number(rate[0]?.value?.per_piece ?? 5) };
  }, [org, month]);
  const byEmp = useMemo(() => Object.fromEntries(staff.map((e) => [e.id, e])), [staff]);
  if (!data) return <div className="empty">加载中…</div>;
  const h = data.head; const draft = h && h.status !== 'paid'; const admin = role === 'admin';
  const run = async (msg, sql, p) => { try { await call(role, sql, p); toast(msg); refresh(); return true; } catch (e) { toast(friendlyError(e), 'err'); return false; } };
  const fixe = (l) => Math.round(Math.min(N(l.contract_salary), N(l.contract_salary) / (h?.days_base || 25) * N(l.days_worked)));
  const net = (l) => fixe(l) + N(l.allowance) + N(l.incentive) + N(l.prime_team) - N(l.deduction);
  const cost = (l) => net(l) + N(l.cnps);
  const saveLine = async (emp, patch, meta) => { try { await call(role, `select app.payroll_set_line($1,$2,$3,$4)`, [org, month + '-01', emp, JSON.stringify(patch)]); if (!meta?.batch || meta.last) { toast(meta?.batch ? `已保存 ${meta.total} 格` : '已保存'); refresh(); } } catch (e) { toast(friendlyError(e), 'err'); } };
  const editNum = (k) => (l) => (draft ? { type: 'number', value: String(N(l[k])), onChange: (v, m) => saveLine(l.employee_id, { [k]: v.replace(/[^\d.]/g, '') || '0' }, m) } : null);
  const lines = data.lines.filter((l) => !dept || l.snap_dept === dept);
  const dev = (v, auto) => { if (auto == null) return null; const a = N(auto), x = N(v); if (a === 0 ? x === 0 : Math.abs(x - a) / a <= 0.1) return null; return a; };
  const withDev = (k, autoK, fmt) => (l) => { const a = dev(l[k], l[autoK]); return <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>{fmt(l[k])}{a != null && <Pill tone="red" title={`自动算出来是 ${fmt(a)}，手改偏差超过 10%`}>自动 {fmt(a)}</Pill>}</span>; };
  const emp = (l) => byEmp[l.employee_id] || {};
  const cols = [
    { key: 'emp_no', label: '工号', w: 70, value: (l) => emp(l).emp_no || '', render: (l) => <span className="mono">{emp(l).emp_no || ''}</span> },
    { key: 'snap_name', label: '全称', w: 230, value: (l) => l.snap_name, render: (l) => <button type="button" className="linkbtn" style={{ fontWeight: 700 }} title="打开完整档案" onClick={(e) => { e.stopPropagation(); if (emp(l).id) setProfile(emp(l)); }}>{l.snap_name}</button> },
    { key: 'short_name', label: '简称', w: 100, value: (l) => l.short_name || '' },
    { key: 'snap_dept', label: '部门', w: 110, value: (l) => optLabel(opts.departments, l.snap_dept) },
    { key: 'snap_position', label: '职位', w: 120, value: (l) => optLabel(opts.positions, l.snap_position) },
    { key: 'att', label: '打卡情况', w: 120, value: (l) => N(l.days_auto), render: (l) => <button type="button" className="linkbtn" title="看他这个月每天的打卡时间、地点、迟到、申诉" onClick={(e) => { e.stopPropagation(); setAttOf(l); }}>{l.days_auto == null ? '查看' : `到岗 ${N(l.days_auto)} 天 ›`}</button> },
    { key: 'days_worked', label: '实到工作日', w: 110, type: 'number', value: (l) => N(l.days_worked), edit: editNum('days_worked'), render: withDev('days_worked', 'days_auto', (v) => String(N(v))) },
    { key: 'contract_salary', label: '合同底薪', w: 110, type: 'money', value: (l) => N(l.contract_salary), edit: editNum('contract_salary'), render: (l) => money(l.contract_salary) },
    { key: 'base', label: '预计基本工资', w: 120, type: 'money', value: fixe, render: (l) => money(fixe(l)) },
    { key: 'allowance', label: '补贴', w: 90, type: 'money', value: (l) => N(l.allowance), edit: editNum('allowance'), render: (l) => money(l.allowance) },
    { key: 'incentive', label: '个人奖金', w: 120, type: 'money', value: (l) => N(l.incentive), edit: editNum('incentive'), render: withDev('incentive', 'incentive_auto', money) },
    { key: 'wh_comm', label: '仓库提成（算好的）', w: 170, type: 'money', value: (l) => (data.comm[l.employee_id] ? data.comm[l.employee_id].ok_pcs * data.rate : 0),
      render: (l) => { const c = data.comm[l.employee_id]; if (!c) return ''; const amt = c.ok_pcs * data.rate; const inB = N(l.incentive) >= amt && amt > 0;
        return <span title={`正确出货 ${c.ok_n} 张单 ${c.ok_pcs} 片 × ${data.rate} XOF = ${amt}；出错取消 ${c.void_n} 张单 ${c.void_pcs} 片。这个数不会自动进实发：填进「个人奖金」才算。`}><b>{money(amt)}</b> <span className="small muted">{c.ok_pcs} 片 × {data.rate}{c.void_n > 0 ? ` · 取消 ${c.void_n} 单` : ''}</span>{amt > 0 && <span className={`pill ${inB ? 'green' : 'amber'}`} style={{ marginLeft: 4 }}>{inB ? '已含在个人奖金' : '还没填进个人奖金'}</span>}</span>; } },
    { key: 'prime_team', label: '团队奖金', w: 90, type: 'money', value: (l) => N(l.prime_team), edit: editNum('prime_team'), render: (l) => money(l.prime_team) },
    { key: 'cnps', label: '社保（公司交）', w: 110, type: 'money', value: (l) => N(l.cnps), edit: editNum('cnps'), render: (l) => money(l.cnps) },
    { key: 'deduction', label: '扣款', w: 90, type: 'money', value: (l) => N(l.deduction), edit: editNum('deduction'), render: (l) => money(l.deduction) },
    { key: 'net', label: '实发工资', w: 120, type: 'money', value: net, render: (l) => <b>{money(net(l))}</b> },
    { key: 'cost', label: '公司成本', w: 110, type: 'money', value: cost, render: (l) => money(cost(l)) },
    { key: 'note', label: '备注', w: 160, value: (l) => l.note || '', edit: (l) => (draft ? { type: 'text', value: l.note || '', onChange: (v, m) => saveLine(l.employee_id, { note: v }, m) } : null) },
  ];
  const exportXlsx = async () => {
    try {
      const { payrollWorkbook, payrollFileName } = await import('../lib/payrollXlsx.js');
      const ls = lines.map((l) => ({ ...l, base: fixe(l), net: net(l) }));
      const blob = await payrollWorkbook({ month, header: { ...h, cnps_in_net: false, dept_label: dept || h.dept_label }, lines: ls });
      const r = await saveFile(payrollFileName(month, dept), blob);
      if (r === 'saved') { toast('Excel 已导出'); call(role, `select app.log_export($1,$2,$3)`, [org, 'payroll', JSON.stringify({ month, rows: ls.length })]).catch(() => {}); } else toast('已取消下载');
    } catch (e) { toast(e.message || '导出失败', 'err'); }
  };
  const tot = (f) => lines.reduce((a, l) => a + f(l), 0);
  const dropSel = async () => {
    const ids = [...new Set(selRows.map((l) => l.employee_id))]; if (!ids.length) return;
    try { for (const id of ids) await call(role, `select app.payroll_drop_line($1,$2,$3)`, [org, month + '-01', id]); setSelRows([]); refresh();
      toast(`已从本月去掉 ${ids.length} 人（误删点「加入新员工」会加回来）`); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const isCur = month === today().slice(0, 7);
  const label = `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;
  return (
    <div className="stack" style={{ padding: 12, gap: 10 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <MonthPicker value={month} onChange={(v) => { setMonth(v); setHistory(false); }} label="工资月份" />
        {h && <Pill tone={STATUS2[h.status][1]}>{STATUS2[h.status][0]}</Pill>}
        {h?.paid_on && <span className="small muted">确认发放：{h.paid_on}</span>}
        {h?.status === 'paid' && admin && <button type="button" className="btn sm ghost" onClick={() => setUnconfirm(true)} title="误点了确认发放？撤回要写原因，会留记录">撤回确认</button>}
        <span className="grow" />
        <button type="button" className={`btn sm ${history ? 'primary' : ''}`} onClick={() => setHistory(!history)}>历史工资发放记录{data.months.length ? ` · ${data.months.length} 个月` : ''}</button>
      </div>
      {history && (
        <div className="card">
          <Grid id="payroll-history" columns={[
            { key: 'month', label: '月份', w: 110, render: (m) => <b>{ym(m.month)}</b> },
            { key: 'status', label: '状态', w: 130, value: (m) => STATUS2[m.status][0], render: (m) => <Pill tone={STATUS2[m.status][1]}>{STATUS2[m.status][0]}</Pill> },
            { key: 'n', label: '人数', w: 80, type: 'number', value: (m) => Number(m.n) },
            { key: 'net', label: '实发合计', w: 140, type: 'money', value: (m) => Number(m.net), render: (m) => <b>{money(m.net)}</b> },
            { key: 'paid_on', label: '确认发放日期', w: 130, value: (m) => m.paid_on || '' },
          ]} rows={data.months} rowKey={(m) => m.month} onRowClick={(m) => { setMonth(ym(m.month)); setHistory(false); }} empty="还没有工资记录"
            tools={<span className="hint">已确认发放的月份锁定，只能看和导出；点一行打开。</span>} />
        </div>
      )}
      {!h ? (
        <div className="card card-b row" style={{ gap: 10 }}>{label}还没有工资单。<span className="grow" />
          {(admin || role === 'sales_manager') && <button type="button" className="btn primary" onClick={() => run(`${label}工资单已建好，在职员工都加进来了`, `select app.payroll_open($1,$2)`, [org, month + '-01'])}>建 {label}工资单</button>}</div>
      ) : (
        <>
          {h.reopen_count > 0 && h.status !== 'paid' && <div className="banner warn">⚠ 这个月之前已经「确认发放」过 {h.reopen_count} 次（最近一次 {dDate(h.last_confirmed_at)}，撤回原因：{h.last_reopen_reason}）。再次确认前先核实钱有没有付出去，别发两次。</div>}
          <div className="card card-b row" style={{ gap: 24, flexWrap: 'wrap' }}>
            <div><div className="small muted">人数</div><div style={{ fontSize: 20, fontWeight: 700 }}>{lines.length}</div></div>
            <div><div className="small muted">实发合计</div><div style={{ fontSize: 20, fontWeight: 700 }}>{money(tot(net))}</div></div>
            <div><div className="small muted">社保（公司交保险局）</div><div style={{ fontSize: 20, fontWeight: 700 }}>{money(tot((l) => N(l.cnps)))}</div></div>
            <div><div className="small muted">公司成本</div><div style={{ fontSize: 20, fontWeight: 700 }}>{money(tot(cost))}</div></div>
            <div><div className="small muted">当月工作日（周一至周六）</div><div style={{ fontSize: 20, fontWeight: 700 }}>{h.days_base}</div></div>
            <span className="grow" />
            <div className="small muted" style={{ maxWidth: 420 }}>基本工资 = 月薪 ÷ {h.days_base} × 实到工作日；实到工作日按打卡自动算{isCur ? '（本月还没结束，是到今天为止的）' : ''}，可手改，偏差超 10% 标红。社保公司承担，不进实发。</div>
          </div>
          <Grid id="payroll3" table="payroll" columns={cols} rows={lines} rowKey={(l) => l.employee_id} empty="这个月没有人" onSelChange={(rs) => setSelRows(rs)}
            foot={(rs) => ({ snap_name: `${rs.length} 人`, base: money(tot(fixe)), net: money(tot(net)), cnps: money(tot((l) => N(l.cnps))), cost: money(tot(cost)) })}
            tools={<>
              <select className="in" style={{ maxWidth: 160 }} value={dept} onChange={(e) => setDept(e.target.value)}><option value="">全部部门</option>{opts.departments.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}</select>
              {draft && selRows.length > 0 && <button type="button" className="btn sm" onClick={dropSel}>从本月去掉 {new Set(selRows.map((l) => l.employee_id)).size} 人</button>}
              {draft && <button type="button" className="btn sm" onClick={() => run('已把新入职的人加进来（已有的行不动）', `select app.payroll_open($1,$2)`, [org, month + '-01'])}>加入新员工</button>}
              {draft && (selRows.length > 0
                ? <button type="button" className="btn sm" title="只重算选中的人，按打卡天数覆盖" onClick={() => run(`已按打卡重算选中的 ${new Set(selRows.map((l) => l.employee_id)).size} 人`, `select app.payroll_refresh_auto($1,$2,$3)`, [org, month + '-01', [...new Set(selRows.map((l) => l.employee_id))]])}>按打卡重算（选中 {new Set(selRows.map((l) => l.employee_id)).size} 人）</button>
                : <button type="button" className="btn sm" title="全表按打卡重算；手改过的行不覆盖。想只算某几个人：先点行号选中他们" onClick={() => run('已按打卡重算（手改过的不动）', `select app.payroll_refresh_auto($1,$2)`, [org, month + '-01'])}>按打卡重算（全部）</button>)}
              <button type="button" className="btn sm" onClick={exportXlsx}>⇩ 导出 Excel</button>
              {draft && admin && <button type="button" className="btn sm primary" onClick={() => setConfirm(true)}>✓ 确认发放</button>}
              {draft && !admin && <span className="hint">改好后由中方点「确认发放」</span>}</>} />
        </>)}
      {confirm && h && (
        <Modal title={`确认发放 ${label}工资`} onClose={() => setConfirm(false)}
          footer={<><button type="button" className="btn" onClick={() => setConfirm(false)}>再看看</button>
            <button type="button" className="btn primary" disabled={h.reopen_count > 0 && !ack} onClick={async () => { setConfirm(false); if (await run(`${label}工资已确认发放，记录锁定`, `select app.payroll_confirm($1,$2,null,$3)`, [org, month + '-01', ack])) exportXlsx(); setAck(false); }}>确认发放并导出 Excel</button></>}>
          <div className="stack">
            <div className="row" style={{ gap: 24 }}>
              <div><div className="small muted">人数</div><b style={{ fontSize: 18 }}>{lines.length}</b></div>
              <div><div className="small muted">实发合计</div><b style={{ fontSize: 18 }}>{money(tot(net))}</b></div>
              <div><div className="small muted">社保（交保险局）</div><b style={{ fontSize: 18 }}>{money(tot((l) => N(l.cnps)))}</b></div>
              <div><div className="small muted">公司成本</div><b style={{ fontSize: 18 }}>{money(tot(cost))}</b></div>
            </div>
            {h.reopen_count > 0 && <label className="banner warn row" style={{ gap: 8, cursor: 'pointer' }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />这个月之前确认过 {h.reopen_count} 次（{dDate(h.last_confirmed_at)}）。我已核实上次没有付款 / 这次不会重复付款。</label>}
            <div className="banner info small">确认后这个月锁定；误点可以「撤回确认」，但要写原因并留记录。确认完自动导出 Excel（模板照 8 月表）。</div>
          </div>
        </Modal>)}
      {profile && <EmpModal e={profile} opts={opts} onClose={() => setProfile(null)} />}
      {attOf && <AttendanceDrawer line={attOf} month={month} draft={draft} onClose={() => setAttOf(null)} onApply={async () => { if (await run(`已按打卡更新 ${attOf.short_name || attOf.snap_name} 的实到工作日`, `select app.payroll_refresh_auto($1,$2,$3)`, [org, month + '-01', [attOf.employee_id]])) setAttOf(null); }} />}
      {unconfirm && h && <UnconfirmModal label={label} onClose={() => setUnconfirm(false)} onGo={(reason) => run(`${label}已撤回确认，可以再改；记录里留了原因`, `select app.payroll_unconfirm($1,$2,$3)`, [org, month + '-01', reason]).then((ok) => ok && setUnconfirm(false))} />}
    </div>
  );
}

// 某员工某月的打卡情况 (Frank 11-07 16:49): 每天的时间 / 地点 / 迟到、申诉, 顶上汇总, 一键用打卡天数更新工资
function AttendanceDrawer({ line, month, draft, onClose, onApply }) {
  const { org } = useApp();
  const { data } = useData(async () => {
    const [rows, aps, [st]] = await Promise.all([q(Q.attendanceOfEmp, [org, line.employee_id, month + '-01']), q(Q.appealsOfEmp, [org, line.employee_id, month + '-01']), q(Q.attendanceRules, [org])]);
    return { rows, aps, st };
  }, [org, line.employee_id, month]);
  if (!data) return <Drawer title="打卡情况" onClose={onClose}><div className="empty">加载中…</div></Drawer>;
  const lateAbsent = data.st?.late_absent_min ?? 120; const start = data.st?.start_time?.slice(0, 5) || '08:30';
  const byDay = {};
  for (const r of data.rows) { const d = byDay[r.day] || (byDay[r.day] = { day: r.day, ins: [], outs: [] }); (r.kind === 'in' ? d.ins : d.outs).push(r); }
  const approved = new Set(data.aps.filter((a) => a.status === 'approved').map((a) => a.day));
  const tooLate = (hm) => { const [h1, m1] = start.split(':').map(Number); const [h2, m2] = hm.split(':').map(Number); return (h2 * 60 + m2) - (h1 * 60 + m1) > lateAbsent; };
  // 本月周一到周六, 到今天 (或月底) 为止
  const y = Number(month.slice(0, 4)), mo = Number(month.slice(5, 7)) - 1; const last = new Date(y, mo + 1, 0); const until = new Date() < last ? new Date() : last;
  const days = []; for (let d = new Date(y, mo, 1); d <= until; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0) days.push(ymd(d));
  const rowsOut = days.map((day) => {
    const d = byDay[day]; const first = d?.ins[0]; const lastOut = d?.outs[d.outs.length - 1];
    const status = approved.has(day) ? '申诉补回' : !first ? '缺勤' : tooLate(first.hm) ? '迟到太久（算旷工）' : first.late ? '迟到' : '到岗';
    return { day, inHm: first?.hm || '', outHm: lastOut?.hm || '', site: first?.site_name || '', named: first?.site_named, lat: first?.lat, lng: first?.lng, status, counted: status === '到岗' || status === '迟到' || status === '申诉补回' };
  });
  const n = (f) => rowsOut.filter(f).length;
  const sum = { counted: n((r) => r.counted), late: n((r) => r.status === '迟到'), absent: n((r) => r.status === '缺勤' || r.status.startsWith('迟到太久')), appeal: n((r) => r.status === '申诉补回') };
  const cols = [
    { key: 'day', label: '日期', w: 100, render: (r) => <b>{r.day.slice(5)}</b> },
    { key: 'inHm', label: '上班打卡', w: 90 }, { key: 'outHm', label: '下班打卡', w: 90 },
    { key: 'site', label: '地点', w: 160, render: (r) => <span className="row" style={{ gap: 4 }}>{r.site || (r.inHm ? '—' : '')}{r.named === false && <Pill tone="amber">待起名</Pill>}{r.lat != null && <a href={`https://www.google.com/maps?q=${Number(r.lat).toFixed(6)},${Number(r.lng).toFixed(6)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>地图 ↗</a>}</span> },
    { key: 'status', label: '当天', w: 150, render: (r) => <Pill tone={r.status === '到岗' ? 'green' : r.status === '申诉补回' ? 'blue' : r.status === '迟到' ? 'amber' : 'red'}>{r.status}</Pill> },
  ];
  return (
    <Drawer title={`${line.snap_name} · ${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月打卡`} onClose={onClose}
      actions={draft && <button type="button" className="btn primary" onClick={onApply} title="把工资单里他的实到工作日改成打卡算出来的天数">用打卡天数更新工资（{sum.counted} 天）</button>}>
      <div className="stack" style={{ gap: 12 }}>
        <AttCalendar employeeId={line.employee_id} month={month} compact />
        <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
          <div><div className="small muted">到岗</div><b style={{ fontSize: 20 }}>{sum.counted}</b> <span className="small muted">天</span></div>
          <div><div className="small muted">其中迟到</div><b style={{ fontSize: 20 }}>{sum.late}</b></div>
          <div><div className="small muted">缺勤 / 旷工</div><b style={{ fontSize: 20 }}>{sum.absent}</b></div>
          <div><div className="small muted">申诉补回</div><b style={{ fontSize: 20 }}>{sum.appeal}</b></div>
          <div><div className="small muted">工资单上现在</div><b style={{ fontSize: 20 }}>{N(line.days_worked)}</b> <span className="small muted">天</span></div>
        </div>
        <div className="small muted">按周一至周六算到{until.toISOString().slice(0, 10) === ymd(last) ? '月底' : '今天'}；上班时间 {start}，迟到超过 {lateAbsent} 分钟按旷工。</div>
        <Grid id="att-emp" columns={cols} rows={rowsOut} rowKey={(r) => r.day} noTools empty="这个月没有打卡" />
        <div><b>请假</b><div className="small muted">请假记录功能还没做（待改 132）；做了以后请假天自动算进出勤。</div></div>
        {data.aps.length > 0 && <div><b>申诉</b>{data.aps.map((a) => <div key={a.day} className="small">{a.day.slice(5)} · {a.reason} · <Pill tone={{ pending: 'amber', approved: 'green', rejected: 'red' }[a.status]}>{{ pending: '待处理', approved: '已批准', rejected: '不通过' }[a.status]}</Pill>{a.decision_note ? ` · ${a.decision_note}` : ''}</div>)}</div>}
      </div>
    </Drawer>
  );
}

function UnconfirmModal({ label, onClose, onGo }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`撤回 ${label}的确认发放`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={reason.trim().length < 2} onClick={() => onGo(reason.trim())}>撤回确认</button></>}>
      <div className="stack">
        <div className="banner warn small">撤回只是让这个月回到可改状态，<b>钱有没有付出去系统不知道</b>。撤回会留记录，再次确认时会提醒你核实，避免发两次。</div>
        <div className="field req"><label>为什么撤回</label><input className="in" autoFocus value={reason} placeholder="例：误点 / 有人天数算错要改" onChange={(e) => setReason(e.target.value)} /></div>
      </div>
    </Modal>
  );
}

// ───────── 选项设置 (部门 / 职位 / 销售类型) ─────────
function OptionsEditor({ opts }) {
  const { org, role, toast, refresh } = useApp();
  const [o, setO] = useState(() => structuredClone(opts));
  const upd = (list, i, k, v) => setO((x) => { const y = structuredClone(x); y[list][i][k] = v; return y; });
  const add = (list, item) => setO((x) => ({ ...x, [list]: [...x[list], item] }));
  const del = (list, i) => setO((x) => ({ ...x, [list]: x[list].filter((_, j) => j !== i) }));
  const save = async (v) => { try { await call(role, `select app.set_org_setting($1,'staff_options',$2)`, [org, v == null ? null : JSON.stringify(v)]); toast(v ? '选项已保存' : '已恢复默认'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const block = (list, title, extra) => (
    <div className="stack" style={{ gap: 6 }}>
      <b>{title}</b>
      {o[list].map((x, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input className="in mono" style={{ maxWidth: 200 }} value={x.v} onChange={(e) => upd(list, i, 'v', e.target.value.toUpperCase())} title="代码（存进数据库、导出 Excel 用）" />
          <input className="in" style={{ maxWidth: 180 }} value={x.l} onChange={(e) => upd(list, i, 'l', e.target.value)} title="显示名" />
          {extra?.(x, i)}
          <button type="button" className="btn sm ghost" onClick={() => del(list, i)}>×</button>
        </div>))}
      <div><button type="button" className="btn sm" onClick={() => add(list, list === 'positions' ? { v: '', l: '', dept: '', role: '' } : { v: '', l: '' })}>＋ 加一项</button></div>
    </div>);
  return (
    <div className="stack" style={{ padding: 14, gap: 16 }}>
      <div className="hint">左边是代码（存进数据库、导出 Excel 时用，英文大写），右边是显示名。职位可以指定属于哪个部门、默认给什么系统岗位。已经用掉的代码改了，旧记录不会跟着改。</div>
      {block('departments', '部门')}
      {block('positions', '职位', (x, i) => <>
        <select className="in" style={{ maxWidth: 150 }} value={x.dept || ''} onChange={(e) => upd('positions', i, 'dept', e.target.value)}><option value="">任何部门</option>{o.departments.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}</select>
        <select className="in" style={{ maxWidth: 140 }} value={x.role || ''} onChange={(e) => upd('positions', i, 'role', e.target.value)}><option value="">不登录</option>{SYS_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></>)}
      {block('sales_channels', '销售类型（销售员细分）')}
      <div className="row"><button type="button" className="btn" onClick={() => save(null)}>恢复默认</button><span className="grow" />
        <button type="button" className="btn primary" onClick={() => save({ ...o, departments: o.departments.filter((x) => x.v), positions: o.positions.filter((x) => x.v), sales_channels: o.sales_channels.filter((x) => x.v) })}>保存选项</button></div>
    </div>
  );
}
