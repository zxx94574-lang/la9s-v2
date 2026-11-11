// 客户档案 (Frank 2026-10-29): 一个客户一张档案 —— 正式 / 潜客 / 回收 都在这里.
// 欠款上限和账期只预警不拦截 (THOMAS 这类有协议的大客户照常出货); 档位、正式编码、上限、账期只中方改.
import { normPhone, fmtPhone } from '../lib/phone.js';
import { ConfirmEdit, HistoryBlock } from '../components/ProductDrawer.jsx';
import React, { useMemo, useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, Light, useApp, useData, Pill, Modal, Drawer, Thumb, MonthPicker , PhoneInput, phoneValid} from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { CallModal, ProspectModal, ResultPill, KIND, custLabel } from '../components/Crm.jsx';
import { AccountPanel, ACC } from '../components/Account.jsx';
import { can, seesPrice, TIERS } from '../lib/domain.js';
import { money, dDate, dt, today, friendlyError } from '../lib/format.js';
import { SUPPLY, customerOptions, optLabel, selOpts } from '../lib/customerOptions.js';

// 页签 (Frank 11-08): 全部 / 本地备货客户 / FOB / 潜客回收 / 欠款预警 / 今天跟进 / 按销售员 (+ 中方的「选项设置」)
const TABS = [['all', '全部'], ['local', '本地备货客户'], ['fob', 'FOB'], ['prospect', '潜客回收'], ['warn', '欠款预警'], ['follow', '今天跟进'], ['byowner', '按销售员'], ['opts', '选项设置']];

export function creditWarn(c) {
  const w = [];
  if (c.over_limit) w.push(`超上限 ${money(c.balance - c.credit_limit)}`);
  if (c.over_days) w.push(`最老一笔 ${c.oldest_days} 天未付（账期 ${c.credit_days} 天）`);
  return w;
}

export default function Customers() {
  const { org, role, toast, refresh } = useApp();
  const [tab, setTab] = useState('all');
  const [open, setOpen] = useState(null);
  const [newP, setNewP] = useState(false);
  const { data } = useData(async () => {
    const [rows, accs, emps, [optRow]] = await Promise.all([q(Q.customerProfiles, [org]), role === 'admin' ? q(Q.customerAccounts, [org]) : [], q(Q.employees, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'customer_options'`, [org])]);
    const by = Object.fromEntries(accs.map((a) => [a.customer_id, a]));
    return { rows: rows.map((c) => ({ ...c, acc: by[c.id] || null })), emps, opts: customerOptions(optRow?.value) };
  }, [org, role]);
  // 格子里直接改 (Frank 11-07): 中方 / 主管改名称、负责人、电话、城市、地址、归属; 档位只中方
  const canEdit = ['admin', 'manager', 'sales_manager'].includes(role);
  const saveCell = async (c, k, v, meta) => { try { await call(role, `select app.edit_customer_info($1,$2)`, [c.id, JSON.stringify({ [k]: v })]); if (!meta?.batch || meta.last) { toast(meta?.batch ? `已保存 ${meta.total} 格` : '已保存'); refresh(); } } catch (e) { toast(friendlyError(e), 'err'); } };
  const txt = (k) => (c) => (canEdit ? { type: 'text', value: c[k] || '', onChange: (v, m) => saveCell(c, k, v, m) } : null);
  // 单选列: 选项来自「选项设置」; 现值不在列表里也保留显示
  const sel = (k, list) => (c) => (canEdit ? { type: 'select', value: c[k] || '', options: selOpts(list, c[k]), onChange: (v, m) => saveCell(c, k, v, m) } : null);
  const td = today();
  const match = useMemo(() => ({
    all: () => true,
    local: (c) => c.status === 'active' && c.supply !== 'fob',
    fob: (c) => c.supply === 'fob',
    prospect: (c) => c.status === 'prospect' || c.kind !== 'spare',
    opts: () => true,
    warn: (c) => c.over_limit || c.over_days,
    follow: (c) => c.next_follow && dDate(c.next_follow) <= td,
    byowner: () => true,
  }), [td]);
  if (!data) return <div className="empty">加载中…</div>;
  const rows = data.rows.filter(match[tab]);
  const price = seesPrice(role);
  const O = data.opts;
  const cols = [
    { key: 'code', label: '编码', w: 90, value: (c) => c.code || c.temp_code, render: (c) => <span className="mono">{c.code || <span className="muted">{c.temp_code}</span>}</span> },
    { key: 'name', label: '客户', w: 180, value: (c) => c.name, edit: txt('name'), render: (c) => <b>{c.name}</b> },
    { key: 'supply', label: '供货方式', w: 90, value: (c) => SUPPLY[c.supply] || SUPPLY.local,
      edit: (c) => (canEdit ? { type: 'select', value: c.supply || 'local', options: Object.entries(SUPPLY), onChange: (v, m) => saveCell(c, 'supply', v, m) } : null),
      render: (c) => (c.supply === 'fob' ? <Pill tone="blue">FOB</Pill> : SUPPLY.local) },
    { key: 'city', label: '城市', w: 100, value: (c) => optLabel(O.cities, c.city), edit: sel('city', O.cities) },
    { key: 'market', label: '市场', w: 100, hidden: true, value: (c) => optLabel(O.markets, c.market), edit: sel('market', O.markets) },
    { key: 'shop_type', label: '店铺类型', w: 100, value: (c) => optLabel(O.shop_types, c.shop_type), edit: sel('shop_type', O.shop_types) },
    { key: 'follow_status', label: '跟进状态', w: 100, value: (c) => optLabel(O.follow_statuses, c.follow_status), edit: sel('follow_status', O.follow_statuses) },
    { key: 'contact_name', label: '负责人', w: 110, value: (c) => c.contact_name || '', edit: txt('contact_name') },
    { key: 'phone', label: '电话', w: 150, value: (c) => c.phone || '', render: (c) => fmtPhone(c.phone), edit: (c) => (canEdit ? { type: 'text', value: c.phone || '', onChange: (v, m) => { const n = normPhone(v); if (!n.valid) return toast(`电话位数不对：${v}（+${n.cc} 要 ${n.need} 位）`, 'err'); saveCell(c, 'phone', n.formatted, m); } } : null) },
    { key: 'address', label: '地址', w: 160, hidden: true, value: (c) => c.address || '', edit: txt('address') },
    { key: 'kind', label: '类型', w: 90, value: (c) => KIND[c.kind], render: (c) => (c.kind === 'spare' ? KIND.spare : <Pill tone="blue">{KIND[c.kind]}</Pill>) },
    { key: 'tier', label: '档位', w: 130, value: (c) => (c.status === 'prospect' ? '潜客' : TIERS[c.tier]),
      edit: (c) => (role === 'admin' && c.status === 'active' ? { type: 'select', value: c.tier || '', options: Object.entries(TIERS), onChange: (v, m) => saveCell(c, 'tier', v, m) } : null),
      render: (c) => (c.status === 'prospect' ? <Pill tone="gray">潜客</Pill> : <TierPill tier={c.tier} />) },
    { key: 'owner', label: '归属销售员', w: 110, value: (c) => c.owner || '',
      edit: (c) => (canEdit ? { type: 'select', value: c.owner_employee_id || '', options: [['', '（无归属）'], ...data.emps.map((e) => [e.id, e.short_name])], onChange: (v, m) => saveCell(c, 'owner_employee_id', v, m) } : null) },
    ...(role === 'admin' ? [{ key: 'acc', label: '下单账号', w: 150, value: (c) => (c.acc ? `${ACC[c.acc.status][0]} ${c.acc.login}` : '没开账号'),
      render: (c) => (c.acc ? <span className="row" style={{ gap: 4 }}><Pill tone={ACC[c.acc.status][1]}>{ACC[c.acc.status][0]}</Pill><span className="mono small">{c.acc.login}</span>{Number(c.acc.unacked) > 0 && <Pill tone="amber">改了密码</Pill>}</span> : <span className="muted small">没开</span>) }] : []),
    ...(price ? [{ key: 'balance', label: '欠款 XOF', w: 110, value: (c) => Number(c.balance || 0), render: (c) => (Number(c.balance) ? money(c.balance) : '—') },
      { key: 'warn', label: '预警', w: 170, value: (c) => creditWarn(c).join(' / '),
        render: (c) => { const w = creditWarn(c); return w.length ? <span className="row" style={{ gap: 4 }}>{w.map((x) => <Pill key={x} tone="red">{x}</Pill>)}{c.has_agreement && <Pill tone="gray">有协议</Pill>}</span> : c.has_agreement ? <Pill tone="gray">有协议</Pill> : ''; } }] : []),
    ...(price ? [{ key: 'block_on_debt', label: '有欠款不出货', w: 110, value: (c) => (c.block_on_debt ? '是' : ''),
      edit: (c) => (role === 'admin' ? { type: 'select', value: c.block_on_debt ? '1' : '', options: [['', '否（只提醒）'], ['1', '是（报价审批 + 出库拦）']],
        onChange: async (v) => { try { await call(role, `select app.set_block_on_debt($1,$2)`, [c.id, v === '1']); toast(v === '1' ? `${c.name}：有欠款就不出货（报价进审批、出库拦住）` : `${c.name}：改回只提醒`); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } } } : null),
      render: (c) => (c.block_on_debt ? <Pill tone="red">欠款不出货</Pill> : '') }] : []),
    { key: 'last_contact', label: '最近联系', w: 100, value: (c) => c.last_contact || '', render: (c) => (c.last_contact ? dDate(c.last_contact) : <span className="muted">从没联系</span>) },
    { key: 'next_follow', label: '下次跟进', w: 100, value: (c) => c.next_follow || '',
      render: (c) => (c.next_follow ? (dDate(c.next_follow) <= td ? <Pill tone="red">{dDate(c.next_follow)}</Pill> : dDate(c.next_follow)) : '') },
  ];
  const n = (k) => data.rows.filter(match[k]).length;
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Fiches clients</div><h1>客户档案</h1>
        <div className="sub">正式客户、潜客、回收客户都在这里。欠款超上限或超账期只提醒，不自动停货；档位、正式编码、上限和账期只有中方能改。</div></div>
        {can(role, 'prospect') && <button type="button" className="btn primary" onClick={() => setNewP(true)}>＋ 新潜客</button>}
      </div>
      <div className="card">
        <div className="tabs">{TABS.filter(([k]) => (price || !['warn', 'byowner'].includes(k)) && (k !== 'opts' || role === 'admin')).map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} {!['byowner', 'opts'].includes(k) && <span className="muted small">{n(k)}</span>}</button>)}</div>
        {tab === 'byowner' ? <ByOwner /> : tab === 'opts' ? <CustomerOptionsEditor opts={O} /> : <Grid id="customers2" table="customers" columns={cols} rows={rows} onRowClick={(c) => setOpen(c.id)} empty="这一类没有客户"
          tools={canEdit ? <span className="hint">点一下选格子，再点一下改，改完自动保存；行号旁 ↗ 打开客户抽屉。城市 / 店铺类型 / 跟进状态等选项在「选项设置」里加，表头漏斗按它筛。</span> : null} />}
      </div>
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
      {newP && <ProspectModal onClose={() => setNewP(false)} onDone={(c) => setOpen(c.id)} />}
    </>
  );
}

export function CustomerDrawer({ id, onClose }) {
  const { org, role, go } = useApp();
  const [callOpen, setCallOpen] = useState(false);
  const [edit, setEdit] = useState(null);
  const { data } = useData(async () => {
    const [all, contacts, emps] = await Promise.all([q(Q.customerProfiles, [org]), q(Q.customerContacts, [id]), q(Q.employees, [org])]);
    return { c: all.find((x) => x.id === id), contacts, emps };
  }, [org, id]);
  if (!data?.c) return null;
  const { c, contacts } = data;
  const price = seesPrice(role);
  const warn = creditWarn(c);
  return (
    <Drawer title={custLabel(c)} onClose={onClose}
      actions={<>{['admin', 'manager', 'sales_manager', 'hotline'].includes(role) && <button type="button" className="btn sm" onClick={() => setEdit('info')} title="解锁修改：保存前列出改了什么并自检">✎ 修改</button>}{can(role, 'prospect') && <button type="button" className="btn sm" onClick={() => setCallOpen(true)}>☎ 记回访</button>}
        {c.status === 'active' && can(role, 'quote') && <button type="button" className="btn sm" onClick={() => go('quote/new')}>＋ 报价</button>}
        {c.status === 'active' && price && <button type="button" className="btn sm" onClick={() => go('customer/' + c.id)}>总账</button>}</>}>
      <div className="stack">
        {warn.length > 0 && <div className="banner warn">{warn.join('；')}{c.has_agreement ? '。有协议客户，照常出货，只提醒。' : '。只提醒，不自动停货；要不要继续给货由中方定。'}</div>}
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          {c.shop_photo && <Thumb src={c.shop_photo} size={84} label="门店照片" />}
          <dl className="facts grow">
            <dt>编码</dt><dd className="mono">{c.code || `${c.temp_code}（临时）`}</dd>
            <dt>状态</dt><dd>{c.status === 'prospect' ? <Pill tone="amber">潜客</Pill> : c.status === 'active' ? <Pill tone="green">正式</Pill> : <Pill>停用</Pill>} {KIND[c.kind]}{c.recycle_type ? ` · ${c.recycle_type}` : ''}</dd>
            <dt>档位</dt><dd><TierPill tier={c.tier} empty="—（中方定）" /> · {SUPPLY[c.supply] || SUPPLY.local}</dd>
            <dt>负责人</dt><dd>{c.contact_name || '—'}</dd>
            <dt>电话</dt><dd>{fmtPhone(c.phone) || '—'}</dd>
            <dt>地址</dt><dd>{c.address || '—'}</dd>
            <dt>城市 / 市场</dt><dd>{[c.city, c.market, c.zone].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>店铺</dt><dd>{[c.shop_type, c.monthly_qty ? `月用量约 ${c.monthly_qty}` : null].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>归属销售员</dt><dd>{c.owner || '—'}</dd>
            {price && <><dt>欠款</dt><dd><b>{money(c.balance || 0)}</b>{c.oldest_days ? <span className="muted small">　最老一笔 {c.oldest_days} 天</span> : null}</dd>
              <dt>上限 / 账期</dt><dd>{c.credit_limit != null ? money(c.credit_limit) : '不限'} / {c.credit_days != null ? `${c.credit_days} 天` : '不限'}{c.has_agreement && <> <Pill tone="gray">有协议</Pill></>}</dd></>}
            {c.note && <><dt>备注</dt><dd>{c.note}</dd></>}
          </dl>
        </div>
        {can(role, 'customer_terms') && (
          <div className="row" style={{ gap: 8 }}>
            {c.status === 'prospect' && <button type="button" className="btn primary sm" onClick={() => setEdit('activate')}>转正式客户（给编码 + 档位）</button>}
            <button type="button" className="btn sm" onClick={() => setEdit('terms')}>欠款上限 / 账期 / 归属</button>
            <button type="button" className="btn sm" onClick={() => setEdit('info')}>✎ 修改档案（负责人 / 电话 / 城市 / 地址{role === 'admin' ? ' / 档位' : ''}）</button>
          </div>)}
        <AccountPanel customer={c} />
        {role === 'admin' && <CustHistory c={c} />}
        <h3 style={{ margin: '8px 0 0' }}>联系记录 <span className="muted small">{contacts.length} 次</span></h3>
        {contacts.length === 0 ? <div className="empty">还没有回访或拜访记录</div> : (
          <ul className="timeline">{contacts.map((x) => (
            <li key={x.id} className={x.src}>
              <div className="row" style={{ gap: 6 }}><b>{dt(x.at)}</b><span className="muted small">{x.src === 'visit' ? '上门拜访' : x.channel === 'whatsapp' ? 'WhatsApp' : '电话'}{x.line === 'recycle' ? ' · 回收' : ''} · {x.staff || '—'}</span>
                <ResultPill v={x.result} visit={x.src === 'visit'} />{x.photo && <Thumb src={x.photo} size={28} label="门店照片" />}</div>
              {x.note && <div className="small">{x.note}</div>}
              {x.next_follow_on && <div className="small muted">下次跟进 {dDate(x.next_follow_on)}</div>}
            </li>))}</ul>)}
      </div>
      {callOpen && <CallModal customer={c} onClose={() => setCallOpen(false)} />}
      {edit === 'activate' && <ActivateModal c={c} emps={data.emps} onClose={() => setEdit(null)} />}
      {edit === 'terms' && <TermsModal c={c} emps={data.emps} onClose={() => setEdit(null)} />}
      {edit === 'info' && <InfoModal c={c} onClose={() => setEdit(null)} />}
    </Drawer>
  );
}

function ActivateModal({ c, emps, onClose }) {
  const { role, toast, refresh } = useApp();
  const [code, setCode] = useState('');
  const [tier, setTier] = useState('');
  const [owner, setOwner] = useState(c.owner_employee_id || '');
  const go = async () => {
    try { await call(role, `select app.activate_customer($1,$2,$3,$4)`, [c.id, code, tier, owner || null]); toast(`${c.name} 已转正式：${code.toUpperCase()} · ${TIERS[tier]}`); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`转正式 · ${c.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!code.trim() || !tier} onClick={go}>转正式</button></>}>
      <div className="stack">
        <div className="field req"><label>正式编码（金蝶客户编码）</label><input className="in mono" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ maxWidth: 200 }} /></div>
        <div className="field req"><label>档位（决定价格）</label><div className="chips">{Object.entries(TIERS).map(([k, l]) => <button type="button" key={k} className={`chip ${tier === k ? 'on' : ''}`} onClick={() => setTier(k)}>{l}</button>)}</div></div>
        <div className="field"><label>归属销售（算激励用）</label><select className="in" value={owner} onChange={(e) => setOwner(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">—</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.short_name}{e.department ? ` · ${e.department}` : ''}</option>)}</select></div>
      </div>
    </Modal>
  );
}

function TermsModal({ c, emps, onClose }) {
  const { role, toast, refresh } = useApp();
  const [f, setF] = useState({ limit: c.credit_limit != null ? String(Number(c.credit_limit)) : '', days: c.credit_days != null ? String(c.credit_days) : '',
    agreement: !!c.has_agreement, owner: c.owner_employee_id || '' });
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^\d]/g, '') });
  const go = async () => {
    try { await call(role, `select app.set_customer_terms($1,$2,$3,$4,$5)`, [c.id, f.limit === '' ? null : Number(f.limit), f.days === '' ? null : Number(f.days), f.agreement, f.owner || null]);
      toast('已保存'); refresh(); onClose(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`欠款上限 / 账期 · ${c.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="hint">超上限或超账期只在订单、待办和这里提醒，不自动停货。空着 = 不限。</div>
        <div className="grid2">
          <div className="field"><label>欠款上限 XOF</label><input className="in" inputMode="numeric" value={f.limit} onChange={num('limit')} placeholder="不限" /></div>
          <div className="field"><label>账期（天）</label><div className="row" style={{ gap: 6 }}><input className="in" inputMode="numeric" value={f.days} onChange={num('days')} placeholder="不限" style={{ maxWidth: 90 }} />
            <div className="chips">{['7', '15', '30'].map((d) => <button type="button" key={d} className={`chip ${f.days === d ? 'on' : ''}`} onClick={() => setF({ ...f, days: d })}>{d}</button>)}</div></div></div>
        </div>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={f.agreement} onChange={(e) => setF({ ...f, agreement: e.target.checked })} />有协议的大客户（例 THOMAS）</label>
        <div className="field"><label>归属销售</label><select className="in" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} style={{ maxWidth: 220 }}>
          <option value="">—</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.short_name}{e.department ? ` · ${e.department}` : ''}</option>)}</select></div>
      </div>
    </Modal>
  );
}

// 客户基本资料 (Frank 11-07: 电话 / 负责人 / 城市要进客户表, BL 从这里取)
function InfoModal({ c, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const init = { name: c.name || '', contact_name: c.contact_name || '', phone: c.phone || '', city: c.city || '', address: c.address || '', ...(role === 'admin' && c.status === 'active' ? { tier: c.tier || '' } : {}) };
  const [f, setF] = useState(init);
  const [confirm, setConfirm] = useState(null);
  const inp = (k, l, ph) => <div className="field"><label>{l}</label><input className="in" value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>;
  const LABEL = { name: '客户名称', contact_name: '负责人', phone: '电话', city: '城市', address: '地址', tier: '档位' };
  // 206: 保存前列出改前 → 改后 + 自检 (电话位数红 / 和别的客户重号黄 / 改档位黄)
  const review = async () => {
    const rows = Object.keys(f).filter((k) => String(init[k] ?? '') !== String(f[k] ?? '')).map((k) => [LABEL[k], k === 'tier' ? (TIERS[init[k]] || '—') : (init[k] || '—'), k === 'tier' ? (TIERS[f[k]] || '—') : (f[k] || '—')]);
    if (!rows.length) { toast('没有改动'); return onClose(); }
    const checks = [];
    if (f.phone && !phoneValid(f.phone)) return toast(`电话位数不对：${f.phone}，改对了再存`, 'err');
    const digits = String(f.phone || '').replace(/\D/g, '').slice(-10);
    if (digits.length >= 8 && f.phone !== init.phone) {
      const dup = await q(`select name from app.customers where org_id = $1 and id <> $2 and right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $3 limit 3`, [org, c.id, digits]).catch(() => []);
      if (dup.length) checks.push({ tone: 'amber', msg: `这个电话别的客户也在用：${dup.map((d) => d.name).join('、')}` });
    }
    if (f.tier && f.tier !== init.tier) checks.push({ tone: 'amber', msg: `档位从 ${TIERS[init.tier] || '—'} 改成 ${TIERS[f.tier]}：以后新报价按新档位带价，已报的单不变` });
    setConfirm({ rows, checks });
  };
  const go = async (reason) => {
    try {
      const patch = Object.fromEntries(Object.keys(f).filter((k) => String(init[k] ?? '') !== String(f[k] ?? '')).map((k) => [k, f[k]]));
      await call(role, `select app.edit_customer_info($1,$2)`, [c.id, JSON.stringify(patch)]);
      await call(role, `select app.log_archive_edit($1,'customer',$2,$3,$4,$5)`, [org, c.id, JSON.stringify(Object.fromEntries(confirm.rows.map(([l, a, b]) => [l, [a, b]]))), JSON.stringify(confirm.checks.map((x) => `${x.tone === 'red' ? '红' : '黄'}：${x.msg}`)), reason || null]).catch(() => {});
      toast('客户档案已保存'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`修改档案 · ${c.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消修改</button><button type="button" className="btn primary" disabled={!f.name.trim()} onClick={review}>保存修改…</button></>}>
      <div className="grid2">
        {inp('name', '客户名称（大写）')}{inp('contact_name', '负责人（BL 上的 Responsable）', 'M. Moumouni')}
        <div className="field"><label>电话（BL 上要印）</label><PhoneInput value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} /></div>{inp('city', '城市（BL 上的 Ville）', 'Yamoussoukro')}
        {inp('address', '地址')}
        {'tier' in f && <div className="field"><label>客户档位（只中方）</label><div className="chips">{Object.entries(TIERS).map(([k, l]) => <button type="button" key={k} className={`chip ${f.tier === k ? 'on' : ''}`} onClick={() => setF({ ...f, tier: k })}>{l}</button>)}</div></div>}
      </div>
      {confirm && <ConfirmEdit c={confirm} title="确认修改客户档案" onBack={() => setConfirm(null)} onSave={go} />}
    </Modal>
  );
}

// 按销售员月汇总: 归属按出库当时的单据归属 (激励口径, 不随后来调换变)
function ByOwner() {
  const { org } = useApp();
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data } = useData(() => q(Q.salesByOwner, [org, month + '-01']), [org, month]);
  const cols = [
    { key: 'owner', label: '销售员', w: 140, render: (r) => <b>{r.owner}</b> },
    { key: 'emp_no', label: '工号', w: 70 },
    { key: 'customers', label: '成交客户数', w: 100, type: 'number', value: (r) => Number(r.customers) },
    { key: 'shipments', label: '出库单数', w: 90, type: 'number', value: (r) => Number(r.shipments) },
    { key: 'qty', label: '件数', w: 90, type: 'number', value: (r) => Number(r.qty) },
    { key: 'amount', label: '金额 XOF', w: 130, type: 'money', value: (r) => Number(r.amount), render: (r) => <b>{money(r.amount)}</b> },
    { key: 'customer_names', label: '客户', w: 420 },
  ];
  return <Grid id="salesByOwner" columns={cols} rows={data || []} empty="这个月还没有出库"
    foot={(rs) => ({ owner: `${rs.length} 人`, qty: rs.reduce((a, r) => a + Number(r.qty || 0), 0), amount: money(rs.reduce((a, r) => a + Number(r.amount || 0), 0)) })}
    tools={<><MonthPicker value={month} onChange={setMonth} label="月份" />
      <span className="hint">归属按出库当时的单据归属算（激励口径），后来把客户划给别人不影响历史。</span></>} />;
}

// 客户资料的选项 (Frank 11-08): 城市 / 市场 / 店铺类型 / 跟进状态 的可选项, 以及中方自己加的列 (例「种类」) —— 保存后客户表自动多一列单选, 表头漏斗能按它筛
function CustomerOptionsEditor({ opts }) {
  const { org, role, toast, refresh } = useApp();
  const [o, setO] = useState(() => structuredClone(opts));
  const upd = (path, v) => setO((x) => { const y = structuredClone(x); let t = y; for (let i = 0; i < path.length - 1; i++) t = t[path[i]]; t[path[path.length - 1]] = v; return y; });
  const save = async (v) => {
    try {
      const clean = v && { ...v, cities: v.cities.filter((x) => x.v), markets: v.markets.filter((x) => x.v), shop_types: v.shop_types.filter((x) => x.v), follow_statuses: v.follow_statuses.filter((x) => x.v),
        custom: undefined };
      await call(role, `select app.set_org_setting($1,'customer_options',$2)`, [org, clean ? JSON.stringify(clean) : null]); toast(clean ? '选项已保存，客户表已更新' : '已恢复默认'); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const items = (list, get, setPath) => (
    <div className="stack" style={{ gap: 6 }}>
      {list.map((x, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input className="in mono" style={{ maxWidth: 180 }} value={x.v} placeholder="代码" onChange={(e) => upd([...setPath, i, 'v'], ['cities', 'markets'].includes(setPath[0]) ? e.target.value : e.target.value.toUpperCase())} title="代码（存进数据库、导出用）" />
          <input className="in" style={{ maxWidth: 180 }} value={x.l} placeholder="显示名" onChange={(e) => upd([...setPath, i, 'l'], e.target.value)} />
          <button type="button" className="btn sm ghost" onClick={() => upd(setPath, list.filter((_, j) => j !== i))}>×</button>
        </div>))}
      <div><button type="button" className="btn sm" onClick={() => upd(setPath, [...list, { v: '', l: '' }])}>＋ 加一项</button></div>
    </div>);
  const block = (key, title) => <div className="stack" style={{ gap: 6 }}><b>{title}</b>{items(o[key], null, [key])}</div>;
  return (
    <div className="stack" style={{ padding: 14, gap: 18 }}>
      <div className="hint">左边代码（英文大写，存数据库 / 导出用），右边显示名。保存后客户表对应列的下拉就是这些项，表头漏斗按它们筛。供货方式只有「本地备货 / FOB」两种，不在这里改。要**自己加列**（例「种类」「来源」）：回到客户表，右上角「⚙ 选项设置」——每张表都有。</div>
      <div className="grid2">{block('cities', '城市')}{block('markets', '市场')}{block('shop_types', '店铺类型')}{block('follow_statuses', '跟进状态')}</div>
      <div className="row"><button type="button" className="btn" onClick={() => save(null)}>恢复默认</button><span className="grow" />
        <button type="button" className="btn primary" onClick={() => save(o)}>保存选项</button></div>
    </div>
  );
}

function CustHistory({ c }) {
  const { org, role, tick } = useApp();
  const { data } = useData(() => call(role, `select * from app.archive_history($1,'customer',$2)`, [org, c.id]).catch(() => []), [org, role, c.id, tick]);
  return <HistoryBlock hist={data || []} title="修改记录" />;
}
