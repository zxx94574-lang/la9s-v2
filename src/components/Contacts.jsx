// 406 / 409 / 410 (Frank 11-18): 客户联系人 —— 凡是跟这个客户有关的人 (老板 / 店员 / 运货员 / 销售员…), 只要 身份 + 名字 + 电话.
// ContactPick: 出库「联系人」、签收「跟谁确认的」共用的带搜索下拉 (按名字 / 电话 / 身份搜); 选中带出名字 + 电话; 新的人直接填, 提交后自动进客户档案.
// ContactsCard: 客户档案里的联系人小表 (加 / 改 / 停用).
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, PhoneInput, phoneValid, Assumed } from './ui.jsx';
import { OptChoice, optName } from './Opts.jsx';
import Grid from './Grid.jsx';
import { fmtPhone } from '../lib/phone.js';
import { friendlyError } from '../lib/format.js';

export const CONTACT_ROLES = [['boss', '老板'], ['staff', '店员'], ['driver', '运货员（收货人）'], ['sales', '销售员'], ['other', '其他人']];
const ROLE_MAP = Object.fromEntries(CONTACT_ROLES);
export const contactRole = (r) => optName('contact_roles', r, ROLE_MAP);
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// 一个客户能选的人: 档案主联系人 (老板) + 联系人表里没停用的 + 归属销售员
export function useContacts(customerId) {
  const { tick } = useApp();
  const { data } = useData(async () => {
    if (!customerId) return [];
    const [c] = await q(`select c.name, c.contact_name, c.phone, c.contacts, e.short_name as owner, e.phone as owner_phone from app.customers c left join app.employees e on e.id = c.owner_employee_id where c.id = $1`, [customerId]);
    if (!c) return [];
    const list = [];
    if (c.phone || c.contact_name) list.push({ key: 'main', role: 'boss', name: c.contact_name || c.name, phone: c.phone || '', main: true });
    for (const x of (c.contacts || [])) if (!x.off && !(c.phone && digits(x.phone) === digits(c.phone))) list.push({ key: x.id || x.phone || x.name, id: x.id, role: x.role || 'other', name: x.name, phone: x.phone || '' });
    if (c.owner) list.push({ key: 'owner', role: 'sales', name: c.owner, phone: c.owner_phone || '', owner: true });
    return list;
  }, [customerId, tick]);
  return data || [];
}
// 提交时把新的人存进客户档案 (已有的不重复加; 销售员不是客户的人, 不存)
export async function rememberContact(role, customerId, who) {
  if (!customerId || !who?.name?.trim() || who.role === 'sales' || who.main || who.owner || who.id) return;
  try { await call(role, `select app.save_customer_contact($1,$2)`, [customerId, JSON.stringify({ name: who.name.trim(), phone: who.phone || '', role: who.role || 'other' })]); } catch { /* 存不上不挡流程 */ }
}

// value: { role, name, phone, key? }. roles: 只列哪些身份 (不给 = 全部). needPhone: 电话是不是必填.
export function ContactPick({ customerId, value, onChange, errs, needPhone, askRole = true, newRole = '', placeholder = '选联系人（可以搜名字 / 电话）' }) {
  const list = useContacts(customerId);
  const v = value || {}; const [fresh, setFresh] = useState(false);
  const pick = (k) => { if (k === '__new') { setFresh(true); onChange({ role: newRole, name: '', phone: '' }); return; } /* 525: 新的人不再沿用上一个人的身份 (以前收货人被存成老板) */ const c = list.find((x) => x.key === k); if (c) { setFresh(false); onChange({ ...c, phone: c.phone ? fmtPhone(c.phone) : '' }); } };
  const cur = !fresh && v.key ? v.key : '';
  const typing = fresh || (!!v.name && !v.key) || !list.length;
  return (
    <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
      {list.length > 0 && <OptChoice value={cur} onChange={pick} flat={false} placeholder={placeholder} err={errs && !v.name?.trim()}
        options={[...list.map((c) => [c.key, `${c.name} · ${contactRole(c.role)}`, c.phone ? fmtPhone(c.phone) : '没留电话']), ['__new', '＋ 新的人（不在上面）', '']]} />}
      {typing && <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {askRole && <OptChoice optKey="contact_roles" title="联系人身份" value={v.role || ''} onChange={(r) => onChange({ ...v, role: r, key: undefined })} options={CONTACT_ROLES} flat={false} placeholder="身份…" err={errs && !v.role} />}
        <input className={`in ${errs && !v.name?.trim() ? 'err-in' : ''}`} style={{ width: 160 }} value={v.name || ''} onChange={(e) => onChange({ ...v, name: e.target.value, key: undefined })} placeholder="名字" />
        <PhoneInput value={v.phone || ''} onChange={(p) => onChange({ ...v, phone: p, key: undefined })} invalid={errs && needPhone && !(v.phone?.trim() && phoneValid(v.phone))} style={{ width: 170 }} placeholder={needPhone ? '电话' : '电话（可不填）'} />
      </div>}
      {!typing && v.name && <div className="small muted">{v.name} · {contactRole(v.role)}{v.phone ? ` · ${v.phone}` : ' · 没留电话'}</div>}
      {!typing && v.phone && !phoneValid(v.phone) && <div className="small" style={{ color: 'var(--red)' }}>这个人档案里的电话位数不对（{v.phone}）：选「＋ 新的人」重填，或去客户档案改</div>}
    </div>);
}

export function ContactsCard({ customerId }) {
  const { role, toast, refresh, tick } = useApp();
  const { data } = useData(() => q(`select contacts from app.customers where id = $1`, [customerId]).then((r) => r[0]?.contacts || []), [customerId, tick]);
  const [nw, setNw] = useState({ role: 'staff', name: '', phone: '' }); const [errs, setErrs] = useState(false);
  const canEdit = !['boss', 'clerk', 'viewer', 'cn_support'].includes(role);
  const save = async (c, patch) => { try { await call(role, `select app.save_customer_contact($1,$2)`, [customerId, JSON.stringify({ ...c, ...patch })]); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const add = async () => {
    setErrs(true);
    if (!nw.name.trim()) return toast('写名字', 'err');
    if (nw.phone && !phoneValid(nw.phone)) return toast('电话位数不对', 'err');
    try { await call(role, `select app.save_customer_contact($1,$2)`, [customerId, JSON.stringify({ ...nw, phone: nw.phone })]); setNw({ role: 'staff', name: '', phone: '' }); setErrs(false); toast('已加进联系人'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const rows = data || [];
  return (
    <div className="pd-sec">
      <div className="pd-h">联系人 <span className="small muted" style={{ fontWeight: 400 }}>老板、店员、运货员…跟这个客户有关的人。出库 / 签收时填过的人会自动加进来。</span>
        <Assumed>停用 = 以后选不到，历史单据上照样显示；同一个电话不会加两次。和客户门店挂钩（某个联系人属于哪家店）还没做。</Assumed></div>
      <Grid id="cust-contacts" noTools rows={rows} rowKey={(c) => c.id || c.phone || c.name} empty="还没有联系人" columns={[
        { key: 'role', label: '身份', w: 130, value: (c) => contactRole(c.role), ...(canEdit ? { edit: (c) => (c.id ? { type: 'select', value: c.role, options: CONTACT_ROLES, onChange: (v) => save(c, { role: v }) } : null) } : {}), render: (c) => contactRole(c.role) },
        { key: 'name', label: '名字', w: 160, ...(canEdit ? { edit: (c) => (c.id ? { value: c.name, onChange: (v) => v.trim() && save(c, { name: v.trim() }) } : null) } : {}) },
        { key: 'phone', label: '电话', w: 150, value: (c) => (c.phone ? fmtPhone(c.phone) : ''), ...(canEdit ? { edit: (c) => (c.id ? { value: c.phone ? fmtPhone(c.phone) : '', invalid: !!c.phone && !phoneValid(c.phone), onChange: (v) => (phoneValid(v) ? save(c, { phone: v }) : toast('电话位数不对，没保存', 'err')) } : null) } : {}), render: (c) => (c.phone ? fmtPhone(c.phone) : <span className="muted">—</span>) },
        { key: 'off', label: '状态', w: 80, value: (c) => (c.off ? '停用' : '在用'), render: (c) => <span className={`pill ${c.off ? 'gray' : 'green'}`}>{c.off ? '停用' : '在用'}</span> },
      ]} rowActions={canEdit ? [{ label: '停用', tone: '', when: (c) => c.id && !c.off, run: (c) => save(c, { off: true }) }, { label: '恢复使用', tone: '', when: (c) => c.id && c.off, run: (c) => save(c, { off: false }) }] : undefined} />
      {canEdit && <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-start' }}>
        <OptChoice optKey="contact_roles" title="联系人身份" value={nw.role} onChange={(r) => setNw({ ...nw, role: r })} options={CONTACT_ROLES} flat={false} />
        <input className={`in ${errs && !nw.name.trim() ? 'err-in' : ''}`} style={{ width: 160 }} placeholder="名字" value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
        <PhoneInput value={nw.phone} onChange={(p) => setNw({ ...nw, phone: p })} style={{ width: 170 }} placeholder="电话（可不填）" />
        <button type="button" className="btn" onClick={add}>＋ 加联系人</button>
      </div>}
    </div>);
}
