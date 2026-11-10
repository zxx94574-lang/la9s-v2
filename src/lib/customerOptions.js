// 客户资料的选项 (Frank 11-08): 城市 / 店铺类型 / 市场 / 跟进状态 由中方在「客户档案 → 选项设置」里加, 表格里对应列就多一个可选项.
// 存在 org_settings 'customer_options'. 供货方式只有两种, 写死.
export const SUPPLY = { local: '本地备货', fob: 'FOB' };
export const DEFAULT_CUSTOMER_OPTIONS = {
  cities: ['Abidjan', 'Yamoussoukro', 'Bouaké', 'Daloa', 'San-Pédro', 'Korhogo', 'Man', 'Gagnoa', 'Anyama', 'Bingerville'].map((v) => ({ v, l: v })),
  markets: ['Adjamé', 'Yopougon', 'Abobo', 'Treichville', 'Koumassi', 'Marcory', 'Cocody', 'Port-Bouët'].map((v) => ({ v, l: v })),
  shop_types: [{ v: 'WHOLESALE', l: '批发店' }, { v: 'RETAIL', l: '零售店' }, { v: 'REPAIR', l: '维修店' }, { v: 'MIXED', l: '批零兼营' }],
  follow_statuses: [{ v: 'NEW', l: '新客' }, { v: 'FOLLOWING', l: '跟进中' }, { v: 'ACTIVE', l: '稳定成交' }, { v: 'SLEEPING', l: '沉默' }, { v: 'LOST', l: '流失' }],
  // 中方自己加的列: [{ key, label, items: [{v,l}] }] → 客户表自动多一列单选 (值存 customers.attrs[key])
  custom: [],
};
export function customerOptions(cfg) { return { ...DEFAULT_CUSTOMER_OPTIONS, ...(cfg || {}) }; }
export const optLabel = (list, v) => (v ? list.find((x) => x.v === v)?.l || v : '');
// 表格单选用: 现值不在列表里也要能显示 / 保留
export const selOpts = (list, cur) => [['', '—'], ...list.map((o) => [o.v, o.l]), ...(cur && !list.some((o) => o.v === cur) ? [[cur, cur]] : [])];
