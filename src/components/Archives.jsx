// 点名字就出档案 (Frank 11-09 192a): 型号 → 物料档案, 客户名 → 客户档案, 员工名 → 员工档案. 全站同一套, 由 App 里的宿主统一弹出.
import React from 'react';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData } from './ui.jsx';
import ProductDrawer from './ProductDrawer.jsx';
import { CustomerDrawer } from '../pages/Customers.jsx';
import { EmpModal } from '../pages/Staff.jsx';
import { staffOptions } from '../lib/staffOptions.js';

const stop = (fn) => (e) => { e.stopPropagation(); e.preventDefault(); fn(); };

export function ModelLink({ id, model, tier, children, className = '' }) {
  const { openArchive } = useApp();
  if (!id || !openArchive) return <b className={className}>{children ?? model}</b>;
  return <button type="button" className={`linkbtn ${className}`} title="打开物料档案" onClick={stop(() => openArchive({ kind: 'product', product: { id, model }, tier }))}><b>{children ?? model}</b></button>;
}
export function CustLink({ id, name, children }) {
  const { openArchive } = useApp();
  if (!id || !openArchive) return <>{children ?? name}</>;
  return <button type="button" className="linkbtn" title="打开客户档案" onClick={stop(() => openArchive({ kind: 'customer', id }))}>{children ?? name}</button>;
}
export function EmpLink({ id, name, children }) {
  const { openArchive, role } = useApp();
  if (!id || !openArchive || !['admin', 'sales_manager'].includes(role)) return <>{children ?? name}</>;   // 员工档案 (含证件照) 只中方 / 销售主管
  return <button type="button" className="linkbtn" title="打开员工档案" onClick={stop(() => openArchive({ kind: 'employee', id }))}>{children ?? name}</button>;
}

function EmpArchive({ id, onClose }) {
  const { org } = useApp();
  const { data } = useData(async () => {
    const [staff, opt] = await Promise.all([q(Q.staffList, [org]), q(`select value from app.org_settings where org_id = $1 and key = 'staff_options'`, [org])]);
    return { e: staff.find((x) => x.id === id), opts: staffOptions(opt[0]?.value) };
  }, [org, id]);
  if (!data?.e) return null;
  return <EmpModal e={data.e} opts={data.opts} onClose={onClose} />;
}

export function ArchiveHost({ arch, onClose }) {
  if (!arch) return null;
  if (arch.kind === 'product') return <ProductDrawer product={arch.product} tier={arch.tier} onClose={onClose} />;
  if (arch.kind === 'customer') return <CustomerDrawer id={arch.id} onClose={onClose} />;
  if (arch.kind === 'employee') return <EmpArchive id={arch.id} onClose={onClose} />;
  return null;
}
