// 权限配置的动作清单 (给「设置 → 权限配置」页用). 分组 + 中文说明; 默认值在 domain.js P 里.
import { PERM_DEFAULTS } from './domain.js';

export const PERM_ROLES = ['manager', 'sales_manager', 'hotline', 'sales', 'picker', 'finance'];   // admin 永远全开, 不在表里
export const PERM_GROUPS = [
  ['报价 · 确认', [['quote', '建报价'], ['quote_price', '报价时直接改价（不用审批，会提示）'], ['quote_price_request', '报价时申请改价（要中方审批）'], ['see_tier_price', '点型号看本单档位价'], ['see_cost', '看成本和全部档位价格'], ['hotline_confirm', '确认客户要货'], ['start_picking', '下推找货（预占库存）'], ['inquiry', '替客户询单'], ['prospect', '建潜客 / 快速加客户']]],
  ['找货 · 销售订单', [['submit_pick', '提交初检'], ['review_pick', '复检打包'], ['sales_order', '生成销售订单'], ['set_price', '销售订单改价'], ['add_lines', '出库前追加货'], ['change_qty', '销售订单解锁改数量'], ['customer_confirm', '客户最终确认'], ['step_people', '设置找货人 / 复核人候选']]],
  ['出库 · 收款', [['ship', '出库'], ['void_shipment', '发货失败 / 退回'], ['mark_received', '客户签收'], ['receipt', '登记收款'], ['write_off', '抹零'], ['payment_notice', '客户说付了（挂截图）'], ['cash_register', '资金账户登记'], ['cash_decide', '认领到账 / 批支出']]],
  ['退货 · 作废', [['request_return', '发起退货'], ['decide_return', '审批退货'], ['inspect_return', '退货检验入库'], ['cancel', '作废订单'], ['restore', '作废恢复'], ['revert', '撤回到上一步']]],
  ['客户 · 采购 · FOB · 金蝶', [['customer_terms', '客户欠款上限 / 账期'], ['purchase_request', '采购 / 物资申请'], ['purchase_advance', '采购单推进'], ['receive_po', '到货入库'], ['fob_create', '建 FOB 项目'], ['fob_advance', 'FOB 推进'], ['fob_pay', 'FOB 收款'], ['kd_save', '金蝶录单'], ['kd_audit', '金蝶审核'], ['rename_model', '物料名称管理'], ['import_data', '数据导入'], ['settings_thresholds', '规则参数']]],
];
export const PERM_ACTIONS = PERM_GROUPS.flatMap(([, list]) => list.map(([k]) => k));
export const defaultRoles = (action) => PERM_DEFAULTS[action] || [];
