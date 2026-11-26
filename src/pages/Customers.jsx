// 客户档案 (Frank 2026-10-29): 一个客户一张档案 —— 正式 / 潜客 / 回收 都在这里.
// 欠款上限和账期只预警不拦截 (THOMAS 这类有协议的大客户照常出货); 档位、正式编码、上限、账期只中方改.
import { RuleGear } from '../components/Rules.jsx';
import { TaskModal, CustomerTasks } from '../components/Tasks.jsx';
import { ContactsCard } from '../components/Contacts.jsx';
import { OptChoice, OptNote, OptGear, optName, optSubmit } from '../components/Opts.jsx';
import { sumMargin, MarginPill, MarginKpis, useMarginRules } from '../components/Margin.jsx';
import { normPhone, fmtPhone } from '../lib/phone.js';
import { ConfirmEdit, HistoryBlock } from '../components/ProductDrawer.jsx';
import React, { useMemo, useState } from 'react';
import { ordersJump } from '../lib/dirWork.js';
import { useShare, SHARE_RANGES, shareRange, ShareNote } from '../components/SalesStats.jsx';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { TierPill, tierOpt, Light, useApp, useData, Pill, Modal, Drawer, Thumb, MonthPicker , PhoneInput, phoneValid, Info, Choice, MoneyIn, Assumed } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { CallModal, ProspectModal, ResultPill, KIND, custLabel } from '../components/Crm.jsx';
import { AccountPanel, ACC } from '../components/Account.jsx';
import { can, seesPrice, TIERS, STATUS, hasAny } from '../lib/domain.js';
import { DealLink, EmpLink } from '../components/Archives.jsx';
import { money, qty, dDate, dt, today, friendlyError } from '../lib/format.js';
import { SUPPLY, customerOptions, optLabel, selOpts } from '../lib/customerOptions.js';
import { optTag } from '../lib/tableOptions.js';
import { OptionRows } from '../components/TableOptions.jsx';

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
  const [shareK, setShareK] = useState('month'); const [sf, st] = shareRange(shareK); const share = useShare(sf, st);   // 383 订单占比
  const { data } = useData(async () => {
    const [rows, accs, emps, [optRow]] = await Promise.all([q(Q.customerProfiles, [org]), role === 'admin' ? q(Q.customerAccounts, [org]) : [], q(Q.employees, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'customer_options'`, [org])]);
    const by = Object.fromEntries(accs.map((a) => [a.customer_id, a]));
    return { rows: rows.map((c) => ({ ...c, acc: by[c.id] || null })), emps, opts: customerOptions(optRow?.value) };
  }, [org, role]);
  // 格子里直接改 (Frank 11-07): 中方 / 主管改名称、负责人、电话、城市、地址、归属; 档位只中方
  const canEdit = hasAny(role, ['admin', 'manager', 'sales_manager']);
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
    { key: 'city', label: '城市', w: 100, value: (c) => optLabel(O.cities, c.city), ...optTag(O.cities, (c) => c.city), edit: sel('city', O.cities) },
    { key: 'market', label: '市场', w: 100, hidden: true, value: (c) => optLabel(O.markets, c.market), ...optTag(O.markets, (c) => c.market), edit: sel('market', O.markets) },
    { key: 'shop_type', label: '店铺类型', w: 100, value: (c) => optLabel(O.shop_types, c.shop_type), ...optTag(O.shop_types, (c) => c.shop_type), edit: sel('shop_type', O.shop_types) },
    { key: 'follow_status', label: '跟进状态', w: 100, value: (c) => optLabel(O.follow_statuses, c.follow_status), ...optTag(O.follow_statuses, (c) => c.follow_status), edit: sel('follow_status', O.follow_statuses) },
    { key: 'contact_name', label: '收货人', w: 110, value: (c) => c.contact_name || '', edit: txt('contact_name') },
    { key: 'phone', label: '电话', w: 150, value: (c) => c.phone || '', render: (c) => (c.phone && !normPhone(c.phone).valid ? <span title="位数不对，出库时会卡住，点一下改">{fmtPhone(c.phone)} <span className="pill red">位数不对</span></span> : fmtPhone(c.phone)), edit: (c) => (canEdit ? { type: 'text', value: c.phone || '', onChange: (v, m) => { const n = normPhone(v); if (!n.valid) return toast(`电话位数不对：${v}（+${n.cc} 要 ${n.need} 位）`, 'err'); saveCell(c, 'phone', n.formatted, m); } } : null) },
    { key: 'address', label: '地址', w: 160, hidden: true, value: (c) => c.address || '', edit: txt('address') },
    { key: 'kind', label: '类型', w: 90, value: (c) => KIND[c.kind], render: (c) => (c.kind === 'spare' ? KIND.spare : <Pill tone="blue">{KIND[c.kind]}</Pill>) },
    { key: 'tier', label: '档位', w: 130, value: (c) => (c.status === 'prospect' ? '潜客' : TIERS[c.tier]),
      edit: (c) => (role === 'admin' && c.status === 'active' ? { type: 'select', value: c.tier || '', options: Object.entries(TIERS), onChange: (v, m) => saveCell(c, 'tier', v, m) } : null),
      render: (c) => (c.status === 'prospect' ? <Pill tone="gray">潜客</Pill> : <TierPill tier={c.tier} />) },
    { key: 'owner', label: '归属销售员', w: 110, value: (c) => c.owner || '',
      edit: (c) => (canEdit ? { type: 'select', value: c.owner_employee_id || '', options: [['', '（无归属）'], ...data.emps.map((e) => [e.id, e.short_name])], onChange: (v, m) => saveCell(c, 'owner_employee_id', v, m) } : null) },
    ...(role === 'admin' ? [{ key: 'acc', label: '下单账号', w: 150, value: (c) => (c.acc ? `${ACC[c.acc.status][0]} ${c.acc.login}` : '没开账号'),
      render: (c) => (c.acc ? <span className="row" style={{ gap: 4 }}><Pill tone={ACC[c.acc.status][1]}>{ACC[c.acc.status][0]}</Pill><span className="mono small">{c.acc.login}</span>{Number(c.acc.unacked) > 0 && <Pill tone="amber">改了密码</Pill>}</span> : <span className="muted small">没开</span>) }] : []),
    ...(price ? [{ key: 'share_amt', label: `订单占比（${SHARE_RANGES.find((x) => x[0] === shareK)[1]}）`, w: 130, type: 'number', value: (c) => (share[c.id] ? Number(share[c.id].amt_share) * 100 : null), render: (c) => (share[c.id] ? <b>{(Number(share[c.id].amt_share) * 100).toFixed(1)}%</b> : '') },
      { key: 'share_qty', label: '片数占比', w: 90, type: 'number', value: (c) => (share[c.id] ? Number(share[c.id].qty_share) * 100 : null), render: (c) => (share[c.id] ? `${(Number(share[c.id].qty_share) * 100).toFixed(1)}%` : '') }] : []),
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
      <div className="pagehead"><div><div className="eyebrow">Fiches clients</div><h1>客户档案 <RuleGear anchor="cust-rules" title="欠款 / 拿货量规则" ids={['credit.on', 'rep.on', 'vol.pct']} /></h1>
        <div className="sub">正式客户、潜客、回收客户都在这里。欠款超上限或超账期只提醒，不自动停货；档位、正式编码、上限和账期只有中方能改。</div></div>
        {can(role, 'prospect') && <button type="button" className="btn primary" onClick={() => setNewP(true)}>＋ 新潜客</button>}
      </div>
      <div className="card">
        <div className="tabs">{TABS.filter(([k]) => (price || !['warn', 'byowner'].includes(k)) && (k !== 'opts' || role === 'admin')).map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} {!['byowner', 'opts'].includes(k) && <span className="muted small">{n(k)}</span>}</button>)}</div>
        {tab === 'byowner' ? <ByOwner /> : tab === 'opts' ? <CustomerOptionsEditor opts={O} /> : <Grid id="customers2" table="customers" pin="name" columns={cols} rows={rows} onRowClick={(c) => setOpen(c.id)} empty="这一类没有客户" tools={seesPrice(role) ? <><span className="small muted">订单占比看</span><Choice size="sm" flat={false} width={120} value={shareK} onChange={setShareK} options={SHARE_RANGES} /><ShareNote /></> : null}
          tools={canEdit ? <Info>点一下选格子，再点一下改，改完自动保存；行号旁 ↗ 打开客户抽屉。城市 / 店铺类型 / 跟进状态等选项在「选项设置」里加，表头漏斗按它筛。</Info> : null} />}
      </div>
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
      {newP && <ProspectModal onClose={() => setNewP(false)} onDone={(c) => setOpen(c.id)} />}
    </>
  );
}

// 343: 档案知道「从哪来」—— 现在开着的是哪张订单 (网址 #/deal/<id>)
export const fromDealId = () => { const m = String(window.location.hash).match(/deal\/([0-9a-f-]{36})/); return m ? m[1] : null; };
// 507 (Frank 11-24): 客户档案里的单 —— 没走完的 (没出库 / 出库了还欠钱) 永远排最上面、不受日期影响; 日期只筛已完结的;
// 「共 N 张」点了跳订单总览、自动带上这个客户; 从某张单点开的 → 那张打「本单」排最前
const CD_RANGE = [['90', '近 3 个月'], ['365', '近一年'], ['all', '全部']];
function CustDeals({ customerId, fromDeal }) {
  const { role, go, openArchive } = useApp();
  const price = seesPrice(role);
  const [rg, setRg] = useState('90'); const [more, setMore] = useState(12);
  const { data } = useData(() => q(`select d.id, d.biz_no, d.status, d.created_at, d.currency, t.shipped_amount, t.due,
      (select coalesce(sum(coalesce(nullif(l.qty_supply, 0), l.qty_req)), 0)::int from app.deal_lines l where l.deal_id = d.id) as qty
    from app.deals d left join app.v_deal_due t on t.deal_id = d.id where d.customer_id = $1 and d.kind <> 'opening' order by d.created_at desc`, [customerId]), [customerId]);
  if (!data?.length) return null;
  const openOf = (d) => d.status !== 'cancelled' && (d.status !== 'shipped' || Number(d.due) > 0);
  const since = rg === 'all' ? 0 : Date.now() - Number(rg) * 864e5;
  const open = data.filter(openOf); const closed = data.filter((d) => !openOf(d) && new Date(d.created_at).getTime() >= since);
  const list = [...data.filter((d) => d.id === fromDeal), ...open.filter((d) => d.id !== fromDeal), ...closed.filter((d) => d.id !== fromDeal)];
  const toOrders = () => ordersJump(go, { cust: customerId }, openArchive);
  const line = (d) => (
    <div key={d.id} className={`todo-line ${d.id === fromDeal ? 'this-doc' : ''}`}>
      {d.id === fromDeal && <span className="pill blue">本单</span>}
      <DealLink id={d.id} no={d.biz_no} /><span className="small muted">{dDate(d.created_at)}</span>
      <span className={`pill ${STATUS[d.status]?.tone || 'gray'}`}>{STATUS[d.status]?.label || d.status}</span>
      <span className="grow" /><span className="small">{qty(d.qty)} 片</span>
      {price && <span className="small">{Number(d.shipped_amount) > 0 ? `出库 ${money(d.shipped_amount, d.currency)}` : ''}{Number(d.due) > 0 ? <b className="red-t2"> · 还欠 {money(d.due, d.currency)}</b> : ''}</span>}
    </div>);
  return (
    <div className="pd-sec">
      <div className="pd-h row" style={{ gap: 8, flexWrap: 'wrap' }}>这个客户的单 <button type="button" className="linkbtn small" data-tip="去订单总览，自动筛这个客户" onClick={toOrders}>共 {data.length} 张 ↗</button>
        <span className="grow" /><span className="seg sm">{CD_RANGE.map(([k, l]) => <button type="button" key={k} className={rg === k ? 'on' : ''} onClick={() => { setRg(k); setMore(12); }}>{l}</button>)}</span></div>
      {open.length > 0 && <div className="small muted" style={{ margin: '2px 0' }}>没走完的 {open.length} 张（一直显示，不受日期影响）</div>}
      {list.slice(0, Math.max(more, open.length + (fromDeal ? 1 : 0))).map(line)}
      {!closed.length && <div className="small muted">{CD_RANGE.find((x) => x[0] === rg)[1]}没有已完结的单{rg !== 'all' ? '，点「全部」看更早的' : ''}</div>}
      {list.length > more && list.length > open.length && <button type="button" className="btn sm ghost" onClick={() => setMore(more + 30)}>再看 {Math.min(30, list.length - more)} 张</button>}
    </div>);
}

export function CustomerDrawer({ id, onClose }) {
  const [taskOpen, setTaskOpen] = useState(false);
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
  const ownerPhone = (data.emps || []).find((e) => e.id === c.owner_employee_id)?.phone;
  const fromDeal = fromDealId();   // 从哪张单点开的 (档案永远是总览, 只是把这张单标出来、排最前)
  return (
    <Drawer title={<span className="arch-title"><span className="mono">{c.code || `${c.temp_code}（临时）`}</span><i>·</i><span>{c.name}</span><i>·</i><TierPill tier={c.tier} empty="档位没定" /></span>} onClose={onClose}
      actions={<>{hasAny(role, ['admin', 'manager', 'sales_manager', 'hotline']) && <button type="button" className="btn sm" onClick={() => setEdit('info')} title="解锁修改：保存前列出改了什么并自检">✎ 修改</button>}{can(role, 'prospect') && <button type="button" className="btn sm" onClick={() => setCallOpen(true)}>☎ 记回访</button>}
        {c.status === 'active' && can(role, 'quote') && <button type="button" className="btn sm" onClick={() => go('quote/new')}>＋ 报价</button>}
        {c.status === 'active' && price && <button type="button" className="btn sm" onClick={() => go('customer/' + c.id)}>总账</button>}
        {role === 'admin' && <button type="button" className="btn sm" onClick={() => setTaskOpen(true)}>派任务</button>}</>}>
      <div className="stack">
        {taskOpen && <TaskModal target={{ kind: 'customer', id: c.id, label: c.code || c.temp_code || c.name, customerName: c.name, ownerId: c.owner_employee_id }} onClose={() => setTaskOpen(false)} />}
        <CustomerTasks customerId={c.id} />
        {warn.length > 0 && <div className="banner warn">{warn.join('；')}{c.has_agreement ? '。有协议客户，照常出货，只提醒。' : '。只提醒，不自动停货；要不要继续给货由中方定。'}</div>}
        {/* 343 (Frank 11-17): 左右对半 —— 左 = 客户自己的信息, 右 = 我们给他定的; 窄屏自动变上下 */}
        <div className="arch-2">
          <div className="arch-col">
            <div className="arch-h">客户自己的信息</div>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              {c.shop_photo && <Thumb src={c.shop_photo} size={72} label="门店照片" />}
              <dl className="facts grow">
                <dt>城市 / 市场</dt><dd>{[c.city, c.market, c.zone].filter(Boolean).join(' · ') || '—'}</dd>
                <dt>店铺</dt><dd>{[c.shop_type, c.monthly_qty ? `月用量约 ${c.monthly_qty}` : null].filter(Boolean).join(' · ') || '—'}</dd>
                <dt>客户电话</dt><dd>{fmtPhone(c.phone) || '—'}</dd>
                <dt>收货人</dt><dd>{c.contact_name || '—'}</dd>
                <dt>收货地址</dt><dd>{c.address || '—'}</dd>
              </dl>
            </div>
          </div>
          <div className="arch-col">
            <div className="arch-h">我们给他定的</div>
            <dl className="facts">
              <dt>客户类别</dt><dd>{c.status === 'prospect' ? <Pill tone="amber">潜客</Pill> : c.status === 'active' ? <Pill tone="green">正式</Pill> : <Pill>停用</Pill>} {SUPPLY[c.supply] || SUPPLY.local} · {KIND[c.kind]}{c.recycle_type ? ` · ${c.recycle_type}` : ''}</dd>
              <dt>归属销售员</dt><dd>{c.owner_employee_id ? <EmpLink id={c.owner_employee_id} name={c.owner} /> : '—（待认领）'}{ownerPhone ? <span className="muted small">　{fmtPhone(ownerPhone)}</span> : null}</dd>
              {price && <><dt>欠款</dt><dd><b className={Number(c.balance) > 0 ? 'red-t2' : ''}>{Number(c.balance) < 0 ? `预付 ${money(-c.balance)}` : money(c.balance || 0)}</b>{c.oldest_days ? <span className="muted small">　最老一笔 {c.oldest_days} 天</span> : null}</dd>
                <dt>上限 / 账期</dt><dd>{c.credit_limit != null ? money(c.credit_limit) : '不限'} / {c.credit_days != null ? `${c.credit_days} 天` : '不限'}{c.has_agreement && <> <Pill tone="gray">有协议</Pill></>}{c.block_on_debt && <> <Pill tone="red">有欠款不出货</Pill></>}
                  {c.credit_limit != null && Number(c.credit_limit) > 0 && <LimitBar label="欠款 / 上限" v={Math.max(0, Number(c.balance || 0))} max={Number(c.credit_limit)} fmt={(x) => money(x)} />}
                  {c.credit_days != null && Number(c.credit_days) > 0 && <LimitBar label="最老一笔 / 账期" v={Number(c.oldest_days || 0)} max={Number(c.credit_days)} fmt={(x) => `${x} 天`} />}</dd></>}
              <dt>备注</dt><dd>{c.note || '—'}</dd>
            </dl>
          </div>
        </div>
        <CustDeals customerId={c.id} fromDeal={fromDeal} />
        {can(role, 'customer_terms') && (
          <div className="row" style={{ gap: 8 }}>
            {c.status === 'prospect' && <button type="button" className="btn primary sm" onClick={() => setEdit('activate')}>转正式客户（给编码 + 档位）</button>}
            <button type="button" className="btn sm" onClick={() => setEdit('terms')}>欠款上限 / 账期 / 归属</button>
            <button type="button" className="btn sm" onClick={() => setEdit('info')}>✎ 修改档案（收货人 / 电话 / 城市 / 地址{role === 'admin' ? ' / 档位' : ''}）</button>
          </div>)}
        <AccountPanel customer={c} />
        <ContactsCard customerId={c.id} />
        <OwnerLog customerId={c.id} />
        <CustSincerity customerId={c.id} />
        {role === 'admin' && c.status === 'active' && <CustMargin customerId={c.id} />}
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
        <div className="field req"><label>档位（决定价格）</label><Choice value={tier} onChange={(k) => setTier(k)} options={Object.entries(TIERS)} renderOpt={tierOpt} /></div>
        <div className="field"><label>归属销售（算激励用）</label><OptChoice optKey="emp_list" title="员工名单" data value={owner} onChange={setOwner} options={emps.map((e) => [e.id, e.short_name, e.department || ''])} empty="—" flat={false} style={{ width: 220 }} /></div>
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
          <div className="field"><label>欠款上限 XOF</label><MoneyIn className="in" inputMode="numeric" value={f.limit} onChange={num('limit')} placeholder="不限" /></div>
          <div className="field"><label>账期（天）</label><div className="row" style={{ gap: 6 }}><MoneyIn className="in" inputMode="numeric" value={f.days} onChange={num('days')} placeholder="不限" style={{ maxWidth: 90 }} />
            <div className="chips">{['7', '15', '30'].map((d) => <button type="button" key={d} className={`chip ${f.days === d ? 'on' : ''}`} onClick={() => setF({ ...f, days: d })}>{d}</button>)}</div></div></div>
        </div>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={f.agreement} onChange={(e) => setF({ ...f, agreement: e.target.checked })} />有协议的大客户（例 THOMAS）</label>
        <div className="field"><label>归属销售</label><OptChoice optKey="emp_list" title="员工名单" data value={f.owner} onChange={(v) => setF({ ...f, owner: v })} options={emps.map((e) => [e.id, e.short_name, e.department || ''])} empty="—" flat={false} style={{ width: 220 }} /></div>
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
  const LABEL = { name: '客户名称', contact_name: '收货人', phone: '电话', city: '城市', address: '地址', tier: '档位' };
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
        {inp('name', '客户名称（大写）')}{inp('contact_name', '收货人（客户那边接货的人，BL 上的 Responsable）', 'M. Moumouni')}
        <div className="field"><label>电话（BL 上要印）</label><PhoneInput value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} /></div>{inp('city', '城市（BL 上的 Ville）', 'Yamoussoukro')}
        {inp('address', '地址')}
        {'tier' in f && <div className="field"><label>客户档位（只中方）</label><Choice value={f.tier} onChange={(k) => setF({ ...f, tier: k })} options={Object.entries(TIERS)} renderOpt={tierOpt} /></div>}
      </div>
      {confirm && <ConfirmEdit c={confirm} title="确认修改客户档案" onBack={() => setConfirm(null)} onSave={go} />}
    </Modal>
  );
}

// 392: 归属历史 —— 这个客户先后由谁负责 (提成按出库那一刻的归属人算, 不受后来移交影响)
function OwnerLog({ customerId }) {
  const { tick } = useApp();
  const { data } = useData(() => q(`select l.at, l.note, f.short_name as from_name, t.short_name as to_name from app.customer_owner_log l left join app.employees f on f.id = l.from_employee_id left join app.employees t on t.id = l.to_employee_id where l.customer_id = $1 order by l.at desc limit 20`, [customerId]), [customerId, tick]);
  if (!data?.length) return null;
  return (<div className="pd-sec"><div className="pd-h">归属历史</div>
    {data.map((l, i) => <div key={i} className="small">· {dt(l.at)}：{l.from_name || '没有归属'} → <b>{l.to_name || '待认领'}</b>{l.note ? <span className="muted">（{l.note}）</span> : null}</div>)}</div>);
}

// 392: 一键移交 —— 把某个销售名下的客户 (全部 / 勾选的) 转给另一个人; 不选接手人 = 放进「待认领」
function TransferModal({ emps, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [note, setNote] = useState(''); const [sel, setSel] = useState(new Set()); const [all, setAll] = useState(true);
  const { data: list } = useData(() => (from ? q(`select c.id, coalesce(c.code, c.temp_code) as code, c.name, c.city, c.tier, c.status from app.customers c where c.org_id = $1 and c.owner_employee_id = $2 order by c.code`, [org, from]) : Promise.resolve([])), [org, from]);
  const n = all ? (list || []).length : sel.size;
  const go = async () => {
    if (!from) return toast('选从谁名下移交', 'err');
    if (!n) return toast('没有要移交的客户', 'err');
    try { const [{ n: done }] = await call(role, `select app.transfer_customers($1,$2,$3,$4,$5) as n`, [org, from, to || null, all ? null : [...sel], note || null]); toast(`已移交 ${done} 个客户`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const opts = (emps || []).filter((e) => e.active !== false).map((e) => [e.id, e.short_name, e.emp_no || '']);
  return (
    <Modal wide title="移交客户" risk="yellow" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" /><button type="button" className="btn primary" onClick={go}>移交 {n} 个客户</button></>}>
      <div className="stack" style={{ minHeight: 380 }}>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field req"><label>从谁名下</label><OptChoice optKey="emp_list" title="员工名单" data value={from} onChange={(v) => { setFrom(v); setSel(new Set()); }} options={(emps || []).map((e) => [e.id, `${e.short_name}${e.active === false ? '（已停用）' : ''}`, e.emp_no || ''])} flat={false} placeholder="选员工…" width={200} /></div>
          <div className="field"><label>交给谁</label><OptChoice optKey="emp_list" title="员工名单" data value={to} onChange={setTo} options={opts.filter(([id]) => id !== from)} flat={false} empty="先不给人（放进待认领）" width={230} /></div>
          <div className="field grow"><label>说明</label><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 Koffi 离职 / 调去负责 Yopougon" /></div>
        </div>
        {from && <><div className="row" style={{ gap: 8 }}><Choice value={all ? 'all' : 'pick'} onChange={(v) => setAll(v === 'all')} options={[['all', `名下全部（${(list || []).length} 个）`], ['pick', '只移交勾选的']]} /></div>
          <Grid id="transfer-list" noTools rows={list || []} maxHeight={300} empty="他名下没有客户" selectable={all ? undefined : { selected: sel, onChange: setSel }} columns={[
            { key: 'code', label: '编码', w: 90, mono: true }, { key: 'name', label: '客户', w: 200 }, { key: 'city', label: '城市', w: 110 }, { key: 'tier', label: '档位', w: 110 }, { key: 'status', label: '状态', w: 80, value: (c) => (c.status === 'active' ? '正式' : '潜客') }]} /></>}
        <div className="hint">移交以后：客户的归属销售换人，没结束的询单跟着走；<b>已经出库的单提成不变</b>（按出库那一刻的归属人算）。每个客户的档案里会留一条归属历史。</div>
      </div>
    </Modal>);
}

// 按销售员月汇总: 归属按出库当时的单据归属 (激励口径, 不随后来调换变)
function ByOwner() {
  const { org, role } = useApp();
  const [xfer, setXfer] = useState(false);
  const { data: emps } = useData(() => q(`select id, short_name, emp_no, active from app.employees where org_id = $1 order by active desc, (emp_no is null), emp_no, short_name`, [org]), [org]);
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
      {role === 'admin' && <button type="button" className="btn sm" onClick={() => setXfer(true)}>⇄ 移交客户</button>}
      <span className="hint">归属按出库当时的单据归属算（激励口径），后来把客户划给别人不影响历史。</span>
      {xfer && <TransferModal emps={emps} onClose={() => setXfer(false)} />}</>} />;
}

// 客户资料的选项 (Frank 11-08): 城市 / 市场 / 店铺类型 / 跟进状态 的可选项, 以及中方自己加的列 (例「种类」) —— 保存后客户表自动多一列单选, 表头漏斗能按它筛
function CustomerOptionsEditor({ opts }) {
  const { org, role, toast, refresh } = useApp();
  const [o, setO] = useState(() => structuredClone(opts));
  const upd = (path, v) => setO((x) => { const y = structuredClone(x); let t = y; for (let i = 0; i < path.length - 1; i++) t = t[path[i]]; t[path[path.length - 1]] = v; return y; });
  const save = async (v) => {
    try {
      const clean = v && { ...v, cities: v.cities.filter((x) => x.v), markets: v.markets.filter((x) => x.v), shop_types: v.shop_types.filter((x) => x.v), follow_statuses: v.follow_statuses.filter((x) => x.v),   // 颜色 c 跟着存
        custom: undefined };
      await call(role, `select app.set_org_setting($1,'customer_options',$2)`, [org, clean ? JSON.stringify(clean) : null]); toast(clean ? '选项已保存，客户表已更新' : '已恢复默认'); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const items = (list, get, setPath) => <OptionRows items={list} upper={!['cities', 'markets'].includes(setPath[0])} onChange={(v) => upd(setPath, v)} />;
  const block = (key, title) => <div className="stack" style={{ gap: 6 }}><b>{title}</b>{items(o[key], null, [key])}</div>;
  return (
    <div className="stack" style={{ padding: 14, gap: 18 }}>
      <div className="hint">左边代码（英文大写，存数据库 / 导出用），右边显示名。保存后客户表对应列的下拉就是这些项，表头漏斗按它们筛。供货方式只有「本地备货 / FOB」两种，不在这里改。要**自己加列**（例「种类」「来源」）：回到客户表，表格右上角的小 ⚙——每张表都有。</div>
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

// 396 (Frank 11-18): 下单诚意 —— 凡是「客户不要了」的动作都汇在这里: 作废的单 (原因)、拆出去以后没再要的、确认后又改少的、退货. 和实际成交放一起看.
function CustSincerity({ customerId }) {
  const { tick, org } = useApp();
  const [months, setMonths] = useState(3);
  const { data } = useData(async () => {
    const since = new Date(); since.setMonth(since.getMonth() - months); const from = since.toISOString().slice(0, 10);
    const [x] = await q(`select
        count(*) filter (where d.kind = 'normal')::int as n_all,
        count(*) filter (where d.status = 'cancelled')::int as n_cancel,
        count(*) filter (where d.status = 'cancelled' and d.split_from is not null)::int as n_split_cancel,
        count(*) filter (where d.status in ('ordered','confirmed','reviewed','partial','shipped'))::int as n_done,
        coalesce(sum((select sum(l.qty_req) from app.deal_lines l where l.deal_id = d.id)) filter (where d.status = 'cancelled'), 0)::int as q_cancel,
        coalesce(sum((select sum(l.qty_req * l.unit_price) from app.deal_lines l where l.deal_id = d.id)) filter (where d.status = 'cancelled'), 0) as amt_cancel
      from app.deals d where d.customer_id = $1 and d.created_at >= $2::date`, [customerId, from]);
    const why = await q(`select coalesce(nullif(e.detail->>'reason', ''), '没写原因') as reason, count(*)::int as n from app.deal_events e join app.deals d on d.id = e.deal_id
      where d.customer_id = $1 and e.action = 'cancelled' and e.at >= $2::date and d.status = 'cancelled' group by 1 order by 2 desc`, [customerId, from]);
    const [y] = await q(`select count(*) filter (where e.action = 'qty_changed' and (e.detail->>'to')::numeric < (e.detail->>'from')::numeric)::int as n_less,
        (select count(*) from app.returns r join app.deals d2 on d2.id = r.deal_id where d2.customer_id = $1 and r.requested_at >= $2::date)::int as n_ret
      from app.deal_events e join app.deals d on d.id = e.deal_id where d.customer_id = $1 and e.at >= $2::date`, [customerId, from]);
    const [r] = await q(`select value from app.org_settings where org_id = $1 and key = 'sincerity_rules'`, [org]);
    return { ...x, ...y, why, warn: Number(r?.value?.warn_pct ?? 30), bad: Number(r?.value?.bad_pct ?? 50) };
  }, [customerId, months, tick, org]);
  if (!data) return null;
  const pct = data.n_all ? Math.round((data.n_cancel / data.n_all) * 100) : 0;
  const tone = data.n_all >= 3 && pct >= data.bad ? 'red' : data.n_all >= 3 && pct >= data.warn ? 'amber' : 'green';
  return (
    <div className="pd-sec">
      <div className="pd-h">下单诚意 <span className="small muted" style={{ fontWeight: 400 }}>他下的单里有多少最后没要</span>
        <Assumed>作废率到 30% 标黄、到 50% 标红（下了 3 张单以上才标）；这两条线以后可以放进规则参数里调。只是给你判断用，不自动限制他下单。</Assumed>
        <span className="grow" /><Choice size="sm" value={months} onChange={setMonths} options={[[1, '近 1 个月'], [3, '近 3 个月'], [12, '近 1 年']]} /></div>
      <div className="kv-row">
        <span>下单 <b>{data.n_all}</b> 张</span><span>成了 <b>{data.n_done}</b> 张</span>
        <span>作废 <b>{data.n_cancel}</b> 张{data.n_cancel > 0 ? `（${qty(data.q_cancel)} 片 · ${money(data.amt_cancel)}）` : ''}</span>
        <span className={`pill ${tone}`}>作废率 {pct}%</span>
        {data.n_split_cancel > 0 && <span>拆单后没再要 <b>{data.n_split_cancel}</b> 张</span>}
        {data.n_less > 0 && <span>确认后又改少 <b>{data.n_less}</b> 次</span>}
        {data.n_ret > 0 && <span>退货 <b>{data.n_ret}</b> 次</span>}
      </div>
      {data.why.length > 0 && <div className="small muted" style={{ marginTop: 4 }}>作废原因：{data.why.map((w) => `${w.reason} ×${w.n}`).join('、')}</div>}
    </div>);
}

// 328: 这个客户的毛利 (只中方): 全部 + 按种类
function CustMargin({ customerId }) {
  const { org, role } = useApp();
  const { lowPct } = useMarginRules();
  const { data } = useData(() => call(role, `select * from app.margin_rows($1) where customer_id = $2`, [org, customerId]), [org, role, customerId]);
  if (!data?.length) return null;
  const by = {}; for (const r of data) (by[r.category || '（没种类）'] ||= []).push(r);
  const rows = Object.entries(by).map(([k, v]) => ({ id: k, category: k, ...sumMargin(v) })).sort((a, b) => b.revenue - a.revenue);
  return (
    <div className="pd-sec">
      <div className="pd-h">毛利（已出货） <span className="pill gray">只中方</span> <Info>出库时锁定的成本，退货 / 调整 / 运费 / 手续费已扣；毛利率 = 利润 ÷ 销售额，加权。细看去侧栏「毛利分析」</Info></div>
      <MarginKpis t={sumMargin(data)} lowPct={lowPct} compact />
      <Grid id="cust-margin" compactTools rows={rows} columns={[
        { key: 'category', label: '种类', w: 110 },
        { key: 'qty', label: '数量', w: 80, type: 'number', render: (r) => qty(r.qty) },
        { key: 'revenue', label: '销售额', w: 110, type: 'number', render: (r) => money(Math.round(r.revenue)) },
        { key: 'profit', label: '利润', w: 110, type: 'number', render: (r) => money(Math.round(r.profit)) },
        { key: 'pct', label: '毛利率', w: 90, type: 'number', render: (r) => <MarginPill pct={r.pct} lowPct={lowPct} missing={!r.revKnown} /> },
      ]} />
    </div>
  );
}

// 475 ④ (Frank 11-20): 欠款 / 上限、最老一笔 / 账期 画成门槛条 —— 上限、账期就是红线; 到 70% 变黄 (Claude 先定的)
function LimitBar({ label, v, max, fmt }) {
  const p = max ? (v / max) * 100 : 0; const tone = p >= 100 ? 'red' : p >= 70 ? 'amber' : 'green';
  const hi = Math.max(120, p * 1.05); const pos = (x) => `${Math.min(100, (x / hi) * 100)}%`;
  return (
    <div className={`lim-bar t-${tone}`} title={`${label}：${fmt(v)} / ${fmt(max)}（${p.toFixed(0)}%）。到 70% 变黄，到上限变红。`}>
      <span className="small muted">{label}</span><b>{p.toFixed(0)}%</b>
      <span className="mt-band" style={{ background: `linear-gradient(90deg, #dcfce7 0 ${pos(70)}, #fef3c7 ${pos(70)} ${pos(100)}, #fee2e2 ${pos(100)})` }}><i style={{ left: pos(Math.min(p, hi)) }} /></span>
    </div>);
}
