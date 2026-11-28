// 选项登记表（Frank 11-28「做得跟飞书一样」）：每组选项归哪一块、用在哪、引用谁。
//   home   = 放在哪一块的「选项设置」里；几块都用的放「通用」。
//   kind   = 'opts'：存 org_settings `opts:<key>`（和表单旁 ⚙ 同一份）；
//            'list'：存在某个档案自己的设置里（store 的 path 那一段，元素 { v, l, c, ... }）。
//   ref    = 引用另一组：名字 / 颜色跟着那一组走，这里只勾「能用其中哪几项」（存 opts:<key>.pick）。
//   pick   = 引用时默认勾哪几项。
//   used   = 用在哪（选项表每列底下显示，改之前知道会影响哪些地方）。
// 新做的选项组：在这里登记一行，表单里照常用 <OptChoice optKey=…>，选项设置页自动多一列。
import { CONTACT_ROLES, UNLOCK_REASONS } from './optBases.js';
import { DEFAULT_STAFF_OPTIONS } from './staffOptions.js';
import { DEFAULT_CUSTOMER_OPTIONS } from './customerOptions.js';

export const OPT_HOMES = [['common', '通用'], ['staff', '员工与工资']];

export const OPT_REG = {
  // ── 通用：几块都用的 ──
  cities: { title: '城市', home: 'common', kind: 'list', store: 'customer_options', path: 'cities', defaults: () => DEFAULT_CUSTOMER_OPTIONS.cities, used: ['客户档案 · 城市', '员工档案 · 负责城市'] },
  contact_roles: { title: '联系人身份', home: 'common', kind: 'opts', options: () => CONTACT_ROLES, used: ['客户联系人', '签收 · 跟谁确认的（引用）'] },
  // ── 员工与工资 ──
  departments: { title: '部门', home: 'staff', kind: 'list', store: 'staff_options', path: 'departments', defaults: () => DEFAULT_STAFF_OPTIONS.departments, used: ['员工档案', '工资单', '打卡', '指令 · 派给哪个部门'], upper: true },
  positions: { title: '职位', home: 'staff', kind: 'list', store: 'staff_options', path: 'positions', defaults: () => DEFAULT_STAFF_OPTIONS.positions, used: ['员工档案', '工资单'], upper: true, attrs: true },
  sales_channels: { title: '销售类型', home: 'staff', kind: 'list', store: 'staff_options', path: 'sales_channels', defaults: () => DEFAULT_STAFF_OPTIONS.sales_channels, used: ['员工档案 · 销售员细分'], upper: true },
  unlock_reason: { title: '下班放行原因', home: 'staff', kind: 'opts', options: () => UNLOCK_REASONS, used: ['打卡 · 放行今天'], note: true },
  // ── 引用（选项放在被引用的那一组，这里只勾能用哪几项）──
  sign_roles: { title: '签收 · 跟谁确认的', home: 'common', kind: 'opts', ref: 'contact_roles', pick: ['boss', 'staff', 'sales', 'other'], used: ['订单 · 签收'] },
};

export const regOf = (key) => OPT_REG[key];
export const groupsOf = (home) => Object.entries(OPT_REG).filter(([, g]) => g.home === home).map(([key, g]) => ({ key, ...g }));
// 被谁引用（列底下显示「签收 · 跟谁确认的 引用了 4 项」）
export const refsTo = (key) => Object.entries(OPT_REG).filter(([, g]) => g.ref === key).map(([k, g]) => ({ key: k, ...g }));
