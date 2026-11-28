// 账号管理（Frank 11-28）：中方 / 员工 / 客户 · 门店 的账号都在这一页；名字点了去档案；中方可以一键「以他身份看」（只看）。
// 客户 · 门店 那一页签就是原来的「客户账号」（开号、冻结、重置密码都在里面）。
import React, { useState } from 'react';
import { useApp, useData } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { EmpLink } from '../components/Archives.jsx';
import { CustomerAccounts } from '../components/Shop.jsx';
import { ROLE_LABELS } from '../lib/domain.js';
import { loadAccounts, useSwitchAccount, Avatar, useViewAs } from '../components/MePanel.jsx';
import { staffOptions, optLabel } from '../lib/staffOptions.js';
import { q } from '../db/client.js';

export default function AccountsPage() {
  const { org, role, tick } = useApp();
  const va = useViewAs();
  const [tab, setTab] = useState(() => { try { return sessionStorage.getItem('la9s.acctab') || 'cn'; } catch { return 'cn'; } });
  const { data } = useData(async () => ({ list: await loadAccounts(org), so: staffOptions((await q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org]))[0]?.value) }), [org, tick]);
  const switchTo = useSwitchAccount();
  if (role !== 'admin' && !va) return <div className="card card-b lock">账号管理只有中方能看。</div>;
  const pick = (k) => { setTab(k); try { sessionStorage.setItem('la9s.acctab', k); } catch { /* */ } };
  const list = data?.list || [];
  const n = (k) => list.filter((a) => (k === 'cust' ? a.kind === 'customer' || a.kind === 'shop' : a.kind === k)).length;
  const rows = list.filter((a) => a.kind === tab);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Comptes</div><h1>账号管理</h1></div></div>
      <div className="card">
        <div className="card-h"><div className="tabs">{[['cn', '中方'], ['staff', '员工'], ['cust', '客户 · 门店']].map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{l} <span className="muted small">{data ? n(k) : ''}</span></button>)}</div></div>
        {tab === 'cust' ? <div className="card-b"><CustomerAccounts /></div> : !data ? <div className="empty">加载中…</div> : (
          <Grid id={`accounts-${tab}`} noTools rowKey={(a) => a.key} rows={rows} columns={[
            { key: 'name', label: '账号', w: 200, value: (a) => a.name, render: (a) => <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar uid={a.key} name={a.name} size={24} />{a.emp_id ? <EmpLink id={a.emp_id} name={a.name} /> : a.name}</span> },
            { key: 'emp_no', label: '工号', w: 80, render: (a) => a.emp_no || <span className="pill amber">没编</span> },
            { key: 'roles', label: '岗位', w: 160, value: (a) => (a.roles || [a.role]).map((r) => ROLE_LABELS[r] || r).join(' · ') },
            { key: 'dept', label: '部门', w: 140, value: (a) => optLabel(data.so.departments, a.dept) },
            { key: 'active', label: '状态', w: 80, value: (a) => (a.active ? '在用' : '停用'), render: (a) => <span className={`pill ${a.active ? 'green' : 'gray'}`}>{a.active ? '在用' : '停用'}</span> },
            { key: 'go', label: '', w: 130, plain: true, render: (a) => (a.switchable && a.active && a.role !== 'admin' && (!va || va.key !== a.key) ? <button type="button" className="btn sm" onClick={() => switchTo(a)}>以他身份看 ›</button> : (va?.key === a.key ? <span className="pill blue">正在看</span> : '')) },
          ]} />)}
      </div>
    </>);
}
