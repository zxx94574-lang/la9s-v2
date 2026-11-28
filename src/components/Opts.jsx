// 选项可调 (Frank 11-17 定底层; 11-18 / 11-19 反复强调: 全站每一个业务选项组都必须带 ⚙, 新页面默认带).
// ⚙ 里能: 新增 / 改名 / 删除 / 隐藏 / 拖动排序 / 颜色. 只中方. 存 org_settings `opts:<key>`:
//   { rename: {值: 显示名}, hidden: [值], order: [值], extra: [{ v, l, base? }] (老格式是纯字符串, 照样认), color: {值: 色} }
// 三种选项组:
//   · 自由的 (默认): 值就是名字, 后台不认死值 → 随便加.
//   · bases 给了 = 这组选项后台按固定类别处理 (发货方式 / 退货类型 / 运费谁出): 新增时要选「按哪一类处理」, 值 = `x:名字`, 提交时用 optBase() 换回后台认的类别, 名字另存.
//   · data = 选项来自数据 (账户 / 员工…): 不能新增改名 (去各自的页面加), 只调「常用的排前面」+ 隐藏.
// 「删除」(Frank 11-20): 能加就能删, 不再有「隐藏」按钮. 自己加的 → 真删; 系统自带的 → 从清单里拿掉 (存进 hidden, 「恢复成系统默认」可找回).
//   已经用过它的老记录照样显示原来的名字. data 组 (账户 / 员工) 不是这里加的, 只能「不显示」.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Choice, Modal, SortList, OptionNote } from './ui.jsx';
import { friendlyError } from '../lib/format.js';
import { OPT_REG, baseOf } from '../lib/optRegistry.js';
import { OptionColumn } from './OptionBoard.jsx';

export const norm = (o) => (Array.isArray(o) ? [o[0], String(o[1] ?? o[0]), o[2]] : (o && typeof o === 'object' ? [o.v ?? o.value ?? o.id, String(o.l ?? o.label ?? o.name ?? ''), o.hint] : [o, String(o)]));
const normExtra = (x) => (typeof x === 'string' ? { v: x, l: x } : x);
// 11-28 飞书式调色：普通色（浅底深字，给选项分类用）+ 状态色（红黄绿只表示状态）
export const PLAIN_TONES = [['', '不上色'], ['blue', '蓝'], ['t-sky', '天蓝'], ['t-teal', '青'], ['t-lime', '青柠'], ['t-orange', '橙'], ['t-pink', '粉'], ['t-purple', '紫'], ['t-indigo', '靛'], ['gray', '灰']];
export const STATUS_TONES = [['red', '红 · 紧急 / 有问题'], ['amber', '黄 · 留意'], ['green', '绿 · 没问题']];
export const TONES = [...PLAIN_TONES, ...STATUS_TONES];
export function applyOpts(base, cfg, current) {
  const b = (base || []).map(norm); const c = cfg || {};
  const extra = (c.extra || []).map(normExtra).filter((x) => !b.some(([v]) => v === x.v)).map((x) => [x.v, x.l]);
  let all = [...b, ...extra].map(([v, l, h]) => [v, c.rename?.[v] || l, h]);
  if (c.order?.length) all = [...c.order.map((v) => all.find((o) => String(o[0]) === String(v))).filter(Boolean), ...all.filter((o) => !c.order.some((v) => String(v) === String(o[0])))];
  const hidden = new Set((c.hidden || []).map(String));
  return { all, shown: all.filter(([v]) => !hidden.has(String(v)) || String(v) === String(current ?? '')), hidden };
}
// 引用（11-28）：ref 组的名字 / 颜色 / 顺序跟着被引用的那一组，自己只存 pick = 能用哪几项
export function applyRef(optKey, ownCfg, parentCfg, current) {
  const reg = OPT_REG[optKey]; const p = applyOpts(baseOf(reg.ref), parentCfg, current);
  const pick = new Set((ownCfg?.pick || reg.pick || p.all.map(([v]) => v)).map(String));
  const allow = reg.allow ? new Set(reg.allow.map(String)) : null;
  const all = p.all.filter(([v]) => (pick.has(String(v)) && (!allow || allow.has(String(v)))) || String(v) === String(current ?? ''));
  return { cfg: { color: parentCfg?.color || {} }, all, shown: all.filter(([v]) => !p.hidden.has(String(v)) || String(v) === String(current ?? '')), hidden: p.hidden };
}
export function useOpts(optKey, base, current) {
  const { org } = useApp();
  const ref = OPT_REG[optKey]?.ref;
  const { data } = useData(async () => {
    if (!optKey) return {};
    const rs = await q(`select key, value from app.org_settings where org_id = $1 and (key = $2 or key = $3)`, [org, `opts:${optKey}`, `opts:${ref || optKey}`]);
    const m = Object.fromEntries(rs.map((r) => [r.key, r.value || {}]));
    return { own: m[`opts:${optKey}`] || {}, par: m[`opts:${ref || optKey}`] || {} };
  }, [org, optKey, ref]);
  if (ref) return applyRef(optKey, data?.own, data?.par, current);
  return { cfg: data?.own || {}, ...applyOpts(base ?? baseOf(optKey), data?.own, current) };
}
// 后台按固定类别处理的选项组: 自己加的选项 → { base: 后台认的类别, label: 名字 }; 系统自带的 → { base: 值, label: null }
export function optBase(cfg, value) {
  const x = (cfg?.extra || []).map(normExtra).find((e) => e.v === value);
  return x ? { base: x.base ?? value, label: x.l } : { base: value, label: null };
}
// 显示用: 值 → 现在的名字 (改过名的用新名; 自己加的用它的名字)
export function optLabel(cfg, base, value, fallback) {
  if (value == null || value === '') return fallback ?? '';
  const hit = applyOpts(base, cfg, value).all.find(([v]) => String(v) === String(value));
  return hit ? hit[1] : (String(value).startsWith('x:') ? String(value).slice(2) : (fallback ?? String(value)));
}

// 全站选项设置的缓存 (App 每次刷新读一遍): 显示单据 / 表格时同步取「现在的名字」, 不用每处各查一次
let ALL_OPTS = {};
export async function loadAllOpts(org) { try { const rs = await q(`select key, value from app.org_settings where org_id = $1 and key like 'opts:%'`, [org]); ALL_OPTS = Object.fromEntries(rs.map((r) => [r.key.slice(5), r.value || {}])); } catch { /* 读不到就用系统默认名 */ } }
export const optCfg = (optKey) => ALL_OPTS[optKey] || {};
// 显示名: 记录上另存了名字 (自己加的选项) 用它; 否则系统值 → 现在的名字 (⚙ 里改过名的用新名)
export function optName(optKey, value, baseMap, label) {
  if (label) return label;
  if (value == null || value === '') return '';
  const k = OPT_REG[optKey]?.ref || optKey;
  const c = ALL_OPTS[k] || {};
  if (!baseMap && OPT_REG[k]) baseMap = Object.fromEntries(baseOf(k).map(norm).map(([v, l]) => [v, l]));
  if (c.rename?.[value]) return c.rename[value];
  const x = (c.extra || []).map(normExtra).find((e) => e.v === value); if (x) return x.l;
  return (baseMap && baseMap[value]) || String(value).replace(/^x:/, '');
}
// 提交时: 选的值 → { base: 后台认的类别, label: 自己加的选项的名字 (系统自带的 = null) }
export const optSubmit = (optKey, value) => optBase(ALL_OPTS[OPT_REG[optKey]?.ref || optKey], value);

export function OptChoice({ optKey, options, title, value, bases, data, fixed, coded, style, className = '', ...rest }) {   // coded: 旧写法, 不再用 (都能加了)
  const { role } = useApp();
  const reg = OPT_REG[optKey];
  const { cfg, all, shown, hidden } = useOpts(optKey, options, value);
  const [edit, setEdit] = useState(false);
  const tone = cfg?.color?.[value];
  if (edit && reg) return (
    <span className={`choice-wrap ${className}`} style={style}>
      <Choice value={value} options={shown} className={tone ? `tone-${tone}` : ''} {...rest} />
      <OptColumnModal optKey={optKey} onClose={() => setEdit(false)} />
    </span>);
  return (
    <span className={`choice-wrap ${className}`} style={style}>
      <Choice value={value} options={shown} className={tone ? `tone-${tone}` : ''} {...rest} />
      {role === 'admin' && optKey && <button type="button" className="opt-gear" title={`调整「${title || '这组选项'}」：${data ? '排序、隐藏' : fixed ? '改名、隐藏、排序、颜色' : '新增、改名、删除、隐藏、排序、颜色'}`} aria-label={`调整选项：${title || optKey}`} onClick={() => setEdit(true)}>⚙</button>}
      {edit && <OptEditor optKey={optKey} title={title} bases={bases} data={data} fixed={fixed} cfg={cfg} all={all} hidden={hidden} base={(options || []).map(norm)} onClose={() => setEdit(false)} />}
    </span>);
}
// 登记过的选项组：⚙ 打开的就是「选项设置」里那一列（同一份，两边改的是同一个东西）
export function OptColumnModal({ optKey, onClose }) {
  const reg = OPT_REG[optKey];
  return <Modal title={`选项 · ${reg.title}`} onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>好了</button>}><OptionColumn optKey={optKey} wide /></Modal>;
}

export function OptEditor({ optKey, title, bases, data, fixed, cfg, all, hidden, base, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const extras = (cfg?.extra || []).map(normExtra);
  const [rows, setRows] = useState(() => all.filter(([v]) => data || !hidden.has(String(v))).map(([v, l]) => ({ v, l, hide: hidden.has(String(v)), sys: base.some(([bv]) => String(bv) === String(v)), base: extras.find((e) => e.v === v)?.base, color: cfg?.color?.[v] || '' })));
  const [nw, setNw] = useState(''); const [nb, setNb] = useState(bases?.[bases.length - 1]?.[0] ?? '');
  const upd = (v, patch) => setRows((rs) => rs.map((r) => (r.v === v ? { ...r, ...patch } : r)));
  const add = () => { const x = nw.trim(); if (!x) return; if (rows.some((r) => r.l === x || r.v === x || r.v === `x:${x}`)) return toast('已经有这个选项了', 'err'); setRows([...rows, { v: bases ? `x:${x}` : x, l: x, hide: false, sys: false, base: bases ? nb : undefined, color: '' }]); setNw(''); };
  const save = async () => {
    if (rows.filter((r) => !r.hide).length === 0) return toast(data ? '至少留一个显示的选项' : '至少留一个选项', 'err');
    if (rows.some((r) => !String(r.l).trim())) return toast('选项名不能空', 'err');
    const val = { rename: Object.fromEntries(rows.filter((r) => r.sys && String(r.l).trim() !== (base.find(([v]) => String(v) === String(r.v))?.[1])).map((r) => [r.v, String(r.l).trim()])),
      hidden: [...rows.filter((r) => r.hide).map((r) => r.v), ...(data ? [] : base.filter(([v]) => !rows.some((r) => String(r.v) === String(v))).map(([v]) => v))], order: rows.map((r) => r.v),
      extra: rows.filter((r) => !r.sys).map((r) => (bases ? { v: r.v, l: String(r.l).trim(), base: r.base } : { v: r.v, l: String(r.l).trim() })),
      color: Object.fromEntries(rows.filter((r) => r.color).map((r) => [r.v, r.color])) };
    try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, `opts:${optKey}`, JSON.stringify(val)]); await loadAllOpts(org); toast('选项已更新，全站立即生效'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const baseName = (b) => bases?.find(([v]) => v === b)?.[1] || b;
  return (
    <Modal title={`调整选项 · ${title || optKey}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={save}>保存</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="small muted">{data ? '这组选项来自档案（要新增 / 改名 / 删除去对应的页面）。这里只调顺序——常用的拖到前面——和「不显示」。' : '拖动排序，可以新增、改名、设颜色、删除。删掉的选项以后不能再选，用过它的老记录照样显示原来的名字。点「保存」才生效。'}</div>
        <SortList items={rows} keyOf={(r) => String(r.v)} onChange={setRows} render={(r) => (
          <div className={`opt-row ${data ? 'data' : ''}`}>
            {data ? <span className="opt-name">{r.l}</span> : <input className="in" value={r.l} onChange={(e) => upd(r.v, { l: e.target.value })} />}
            {!data && <select className="in opt-color" value={r.color} title="颜色" onChange={(e) => upd(r.v, { color: e.target.value })}>{TONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
            {!r.sys && bases ? <span className="small muted opt-base" title="后台按这一类处理">按「{baseName(r.base)}」</span> : null}
            {data
              ? <button type="button" className={`chip opt-del ${r.hide ? 'on' : ''}`} onClick={() => upd(r.v, { hide: !r.hide })}>{r.hide ? '不显示' : '显示'}</button>
              : <button type="button" className="btn sm ghost danger opt-del" title="删掉这个选项（用过它的老记录照样显示原来的名字）" onClick={() => setRows((rs) => rs.filter((x) => x.v !== r.v))}>删除</button>}
          </div>)} />
        {fixed && <div className="small muted">这几项是系统按它来算库存 / 算账的固定类别，可以改名、删除、排序，不能凭空新增；要加新的类别告诉 Claude。</div>}
        {!data && !fixed && <div className="opt-add">
          <input className="in" placeholder="新增一个选项…" value={nw} onChange={(e) => setNw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          {bases && <label className="row small opt-addbase" style={{ gap: 6 }}>按哪一类处理<select className="in" value={nb} onChange={(e) => setNb(e.target.value)}>{bases.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
          <button type="button" className="btn opt-del" onClick={add}>＋ 加</button></div>}
        {bases && <div className="small muted">这组选项会影响账或流程：新加的选项要选它「按哪一类处理」，系统就按那一类的规则走，只是名字不同。需要全新的算法告诉 Claude 加。</div>}
        {cfg && Object.keys(cfg).length > 0 && <div><button type="button" className="btn sm ghost" onClick={() => setRows(base.map(([v, l]) => ({ v, l, hide: false, sys: true, color: '' })))}>恢复成系统默认（删掉的系统选项回来）</button></div>}
      </div>
    </Modal>);
}

// 选项组不是下拉、而是一排快捷词 (快捷原因 chips) 时用: 只出一个 ⚙ + 给出调整后的清单
export function useOptList(optKey, base) { const { cfg, shown } = useOpts(optKey, base); return { cfg, list: shown.map(([v, l]) => [v, l]) }; }
export function OptGear({ optKey, options, title, bases, data, fixed }) {
  const { role } = useApp();
  const { cfg, all, hidden } = useOpts(optKey, options);
  const [edit, setEdit] = useState(false);
  if (role !== 'admin') return null;
  return (<>
    <button type="button" className="opt-gear" title={`调整「${title || '这组选项'}」`} aria-label={`调整选项：${title || optKey}`} onClick={() => setEdit(true)}>⚙</button>
    {edit && OPT_REG[optKey] && <OptColumnModal optKey={optKey} onClose={() => setEdit(false)} />}
    {edit && !OPT_REG[optKey] && <OptEditor optKey={optKey} title={title} bases={bases} data={data} fixed={fixed} cfg={cfg} all={all} hidden={hidden} base={(options || []).map(norm)} onClose={() => setEdit(false)} />}
  </>);
}

// 快捷原因 (一排词 + 「其他」手填): 带 ⚙ 的版本. 「其他」永远在最后、不能删 (它是手填的入口).
export function OptNote({ optKey, title, options: opt0, value, onChange, placeholder }) {
  const options = opt0 || baseOf(optKey);
  const { list } = useOptList(optKey, options);
  const names = list.map(([, l]) => l); const rest = names.filter((x) => x !== '其他');
  return (<div className="optnote"><OptionNote options={[...rest, ...(options.includes('其他') ? ['其他'] : [])]} value={value} onChange={onChange} placeholder={placeholder} /><OptGear optKey={optKey} options={options} title={title} /></div>);
}

// 选项表 / ⚙ 共用：一行行 { v, l, c, sys, base } → 存进 opts:<key> 的格式
export function rowsToCfg(rows, base, withBases, prev) {
  return { ...(prev?.pick ? { pick: prev.pick } : {}),
    rename: Object.fromEntries(rows.filter((r) => r.sys && String(r.l).trim() !== (base.find(([v]) => String(v) === String(r.v))?.[1])).map((r) => [r.v, String(r.l).trim()])),
    hidden: base.filter(([v]) => !rows.some((r) => String(r.v) === String(v))).map(([v]) => v),
    order: rows.map((r) => r.v),
    extra: rows.filter((r) => !r.sys).map((r) => (withBases ? { v: r.v, l: String(r.l).trim(), base: r.base } : { v: r.v, l: String(r.l).trim() })),
    color: Object.fromEntries(rows.filter((r) => r.c).map((r) => [r.v, r.c])) };
}
