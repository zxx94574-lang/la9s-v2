// 员工档案的选项 (Frank 10-31: 部门、职位等能单选的都做成单选). 中方可以在「员工档案 → 选项」里改, 存在 org_settings 'staff_options'.
// 职位带默认系统岗位: 选了职位, 系统岗位自动带出 (可以再改).
export const DEFAULT_STAFF_OPTIONS = {
  departments: [
    { v: 'DIRECTION', l: '中方 Direction' },
    { v: 'SPARE PARTS', l: '备件 Spare parts' },
    { v: 'RECYCLING', l: '回收 Recycling' },
  ],
  positions: [
    { v: 'DIRECTION', l: '中方负责人', dept: 'DIRECTION', role: 'admin' },
    { v: 'FINANCE', l: '中方财务', dept: 'DIRECTION', role: 'admin' },
    { v: 'ACCOUNTANT', l: '本地财务（录入）', dept: 'DIRECTION', role: 'finance' },
    { v: 'SALES MANAGER', l: '销售主管', dept: 'SPARE PARTS', role: 'sales_manager' },
    { v: 'STOCK MANAGER', l: '仓库主管', dept: 'SPARE PARTS', role: 'manager' },
    { v: 'STOCK STAFF', l: '库管员', dept: 'SPARE PARTS', role: 'picker' },
    { v: 'SALES STAFF', l: '销售员', dept: 'SPARE PARTS', role: 'sales' },
    { v: 'HOTLINE STAFF', l: '热线', dept: 'SPARE PARTS', role: 'hotline' },
    { v: 'RECYCLING MANAGER', l: '回收主管', dept: 'RECYCLING', role: 'recycle_manager' },
    { v: 'RECYCLING STOCK MANAGER', l: '回收仓库主管', dept: 'RECYCLING', role: 'recycle_wh_manager' },
    { v: 'RECYCLING STAFF', l: '回收员', dept: 'RECYCLING', role: 'recycler' },
  ],
  sales_channels: [
    { v: 'RETAIL', l: '零售' },
    { v: 'WHOLESALE', l: '批发' },
    { v: 'ZONE', l: '区域' },
  ],
};
export const SYS_ROLES = ['admin', 'manager', 'sales_manager', 'picker', 'sales', 'hotline', 'finance', 'recycle_manager', 'recycle_wh_manager', 'recycler'];

export function staffOptions(cfg) {
  const o = { ...DEFAULT_STAFF_OPTIONS, ...(cfg || {}) };
  return o;
}
export const optLabel = (list, v) => (v ? list.find((x) => x.v === v)?.l || v : '');
