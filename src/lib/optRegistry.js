// 选项登记表（Frank 11-28「做得跟飞书一样」）：每组选项归哪一块、用在哪、引用谁。
//   home   = 放在哪一块的「选项设置」里；几块都用的放「通用」。
//   kind   = 'opts'：存 org_settings `opts:<key>`（和表单旁 ⚙ 同一份）；
//            'list'：存在某个档案自己的设置里（store 的 path 那一段，元素 { v, l, c, ... }）。
//   ref    = 引用另一组：名字 / 颜色跟着那一组走，这里只勾「能用其中哪几项」（存 opts:<key>.pick）。
//   pick   = 引用时默认勾哪几项；allow = 这里最多能勾哪几项（数据库只认这几种，别的灰掉）。
//   used   = 用在哪（选项表每列底下显示，改之前知道会影响哪些地方）。
//   sec    = 一块里再分段（订单那一块选项多，分 出库 · 签收 / 退货 / 快捷原因…）
//   note   = 快捷原因（一排词 +「其他」手填），「其他」固定在最后、不能删。
//   fixed  = 系统按它算账 / 算库存的固定类别：能改名、排序、调色，不能凭空新增（表单旁 ⚙ 的规矩一样）。
//   bases  = 新加的选项要选「按哪一类处理」（后台按那一类走，只是名字不同）。
// 默认值：写在这里（options），或者由定义它的文件加载时 regBase(key, () => 常量) 报到（避免 lib 反过来 import 页面）。
// 新做的选项组：在这里登记一行，表单里照常用 <OptChoice optKey=…>，选项设置页自动多一列。
import { CONTACT_ROLES, UNLOCK_REASONS, FOLLOW_RESULTS, CALL_CODES, VISIT_CODES } from './optBases.js';
import { DEFAULT_STAFF_OPTIONS } from './staffOptions.js';
import { DEFAULT_CUSTOMER_OPTIONS } from './customerOptions.js';
import { NOTE_OPTIONS, SHIP_METHODS, CONFIRM_METHODS, RETURN_REASONS, FREIGHT_BASES, RETURN_BASES } from './domain.js';

export const OPT_HOMES = [['common', '通用'], ['orders', '订单'], ['customers', '客户'], ['crm', '热线与拜访'], ['po', '备货与采购'], ['cash', '收款与总账'], ['materials', '物料与定价'], ['work', '待办与指令'], ['staff', '员工与工资']];

const ent = (o) => () => Object.entries(o);
const arr = (a) => () => a;
const N = (k) => () => NOTE_OPTIONS[k] || [];

export const OPT_REG = {
  // ── 通用：几块都用的 ──
  cities: { title: '城市', home: 'common', kind: 'list', store: 'customer_options', path: 'cities', defaults: () => DEFAULT_CUSTOMER_OPTIONS.cities, used: ['客户档案 · 城市', '员工档案 · 负责城市'] },
  contact_roles: { title: '联系人身份', home: 'common', kind: 'opts', options: arr(CONTACT_ROLES), used: ['客户联系人', '签收 · 跟谁确认的（引用）'] },

  // ── 订单 ──
  ship_methods: { title: '发货方式', sec: '出库 · 签收', home: 'orders', kind: 'opts', options: ent(SHIP_METHODS), used: ['出库', '签收', '发货单'] },
  freight_bearer: { title: '运费谁出', sec: '出库 · 签收', home: 'orders', kind: 'opts', options: arr(FREIGHT_BASES), bases: arr(FREIGHT_BASES), used: ['出库'] },
  sign_roles: { title: '签收 · 跟谁确认的', sec: '出库 · 签收', home: 'orders', kind: 'opts', ref: 'contact_roles', pick: ['boss', 'staff', 'sales', 'other'], used: ['订单 · 签收'] },
  confirm_methods: { title: '客户确认方式', sec: '出库 · 签收', home: 'orders', kind: 'opts', options: ent(CONFIRM_METHODS), used: ['报价确认', '客户确认对账', '追加'] },
  disc_kind: { title: '收货差异 · 类型', sec: '出库 · 签收', home: 'orders', kind: 'opts', fixed: true, used: ['签收 · 客户说收到的不对'] },
  disc_where: { title: '收货差异 · 货在哪', sec: '出库 · 签收', home: 'orders', kind: 'opts', fixed: true, used: ['签收 · 差异处理'] },
  return_types: { title: '退货类型', sec: '退货', home: 'orders', kind: 'opts', options: ent(RETURN_REASONS), bases: arr(RETURN_BASES), used: ['按原单退货', '按客户退货'] },
  note_return: { title: '退货 · 具体原因', sec: '退货', home: 'orders', kind: 'opts', options: N('return'), note: true, used: ['按原单退货', '按客户退货'] },
  note_hotline: { title: '热线确认 · 快捷话', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('hotline'), note: true, used: ['报价 · 确认'] },
  note_diff: { title: '找货少了 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('diff'), note: true, used: ['找货', '追加'] },
  note_review_diff: { title: '复检不一致 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('review_diff'), note: true, used: ['复检打包'] },
  note_review_less: { title: '追加复检少了 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: arr(['货损', '数错了', '型号拿错']), note: true, used: ['追加 · 复检'] },
  note_cancel: { title: '作废订单 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: arr(['客户不要了', '价格谈不拢', '重复下单', '没货', '其他']), note: true, used: ['订单作废'] },
  note_addon_cancel: { title: '取消追加 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: arr(['客户不要了', '没货', '加错了', '改成开新单']), note: true, used: ['追加'] },
  note_revert: { title: '退回上一步 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('revert'), note: true, used: ['订单退回'] },
  note_unlock: { title: '解锁订单 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('unlock'), note: true, used: ['订单解锁修改'] },
  note_void_ship: { title: '作废出库 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('void_ship'), note: true, used: ['出库作废'] },
  note_writeoff: { title: '抹零 / 核销 · 原因', sec: '各步快捷原因', home: 'orders', kind: 'opts', options: N('writeoff'), note: true, used: ['收款'] },
  item_grades: { title: '赠品 · 等级', sec: '赠品 · 亏损', home: 'orders', kind: 'opts', used: ['订单赠品'] },
  loss_conclusions: { title: '亏损 · 结论', sec: '赠品 · 亏损', home: 'orders', kind: 'opts', used: ['亏损诊断'] },
  loss_ok_reasons: { title: '亏损 · 可以接受的原因', sec: '赠品 · 亏损', home: 'orders', kind: 'opts', used: ['亏损诊断'] },
  inq_invalid: { title: '询单 · 无效原因', sec: '询单', home: 'orders', kind: 'opts', used: ['询单'] },
  inq_lost: { title: '询单 · 没成交原因', sec: '询单', home: 'orders', kind: 'opts', used: ['询单'] },
  inq_wave: { title: '询单 · Wave 付款', sec: '询单', home: 'orders', kind: 'opts', used: ['询单'] },
  inq_yango: { title: '询单 · Yango', sec: '询单', home: 'orders', kind: 'opts', used: ['询单'] },

  // ── 客户 ──
  markets: { title: '市场', sec: '客户档案', home: 'customers', kind: 'list', store: 'customer_options', path: 'markets', defaults: () => DEFAULT_CUSTOMER_OPTIONS.markets, used: ['客户档案 · 市场'] },
  shop_types: { title: '店铺类型', sec: '客户档案', home: 'customers', kind: 'list', store: 'customer_options', path: 'shop_types', defaults: () => DEFAULT_CUSTOMER_OPTIONS.shop_types, used: ['客户档案 · 店铺类型'], upper: true },
  follow_statuses: { title: '跟进状态', sec: '客户档案', home: 'customers', kind: 'list', store: 'customer_options', path: 'follow_statuses', defaults: () => DEFAULT_CUSTOMER_OPTIONS.follow_statuses, used: ['客户档案 · 跟进状态'], upper: true },
  shop_pay: { title: '门店收银 · 付款方式', sec: '客户门店', home: 'customers', kind: 'opts', used: ['客户门店 · 收银'] },
  shop_quality: { title: '门店 · 品质档', sec: '客户门店', home: 'customers', kind: 'opts', used: ['客户门店 · 店里库存'] },

  // ── 热线与拜访 ──
  follow_results: { title: '跟进结果', home: 'crm', kind: 'opts', options: arr(FOLLOW_RESULTS), fixed: true, used: ['热线回访（引用）', '客户拜访（引用）'] },
  call_results: { title: '热线回访 · 结果', home: 'crm', kind: 'opts', ref: 'follow_results', pick: CALL_CODES, allow: CALL_CODES, used: ['热线回访'] },
  visit_results: { title: '客户拜访 · 结果', home: 'crm', kind: 'opts', ref: 'follow_results', pick: VISIT_CODES, allow: VISIT_CODES, used: ['客户拜访'] },
  visit_activity: { title: '拜访 · 店铺做什么', home: 'crm', kind: 'opts', options: arr(['Réparation', 'Vente détail', 'Grossiste', 'Recyclage']), used: ['客户拜访'] },
  visit_transport: { title: '拜访 · 平时怎么拿货', home: 'crm', kind: 'opts', options: arr(['Yango moto', 'Taxi', 'Vient lui-même', 'Livreur']), used: ['客户拜访'] },

  // ── 备货与采购 ──
  po_mode: { title: '运输方式', home: 'po', kind: 'opts', options: arr([['sea', '海运'], ['air', '空运'], ['other', '其他']]), used: ['采购单 · 物流'] },
  po_forwarder: { title: '物流公司', home: 'po', kind: 'opts', options: arr([['赛时', '赛时'], ['捷道', '捷道'], ['古月', '古月'], ['速鹰', '速鹰'], ['利信达', '利信达']]), used: ['采购单 · 物流', '入仓号格式'] },
  po_eta_reason: { title: '改预计到货 · 原因', home: 'po', kind: 'opts', options: arr(['船晚开', '中转慢', '清关慢', '国内晚发', '货代没给准信']), note: true, used: ['采购单 · 物流'] },
  po_doc_kind: { title: '采购单文件类型', home: 'po', kind: 'opts', used: ['采购单 · 文件'] },
  po_gap_results: { title: '到货差异 · 结论', home: 'po', kind: 'opts', used: ['采购单 · 到货对数'] },

  // ── 收款与总账 ──
  expense_cats: { title: '支出科目', home: 'cash', kind: 'opts', used: ['资金账户 · 记支出'] },
  note_void_receipt: { title: '作废收款 · 原因', home: 'cash', kind: 'opts', note: true, used: ['收款作废'] },
  note_kd_recon: { title: '金蝶对不上 · 结论', home: 'cash', kind: 'opts', options: arr(['金蝶还没录，已安排补录', '系统漏做单据，已补', '金蝶录错，已让财务改', '发错编码，已做编码更正', '已盘点调整', '其他']), note: true, used: ['金蝶同步 · 对账'] },

  // ── 物料与定价 ──
  note_rename: { title: '改物料名 · 原因', home: 'materials', kind: 'opts', options: N('rename'), note: true, used: ['物料名称管理'] },
  promo_names: { title: '促销名称', home: 'materials', kind: 'opts', used: ['清库存促销'] },

  // ── 待办与指令 ──
  directive_type: { title: '指令类型', home: 'work', kind: 'opts', used: ['中方指令'] },
  task_types: { title: '定期任务类型', home: 'work', kind: 'opts', used: ['定期任务'] },

  // ── 员工与工资 ──
  departments: { title: '部门', home: 'staff', kind: 'list', store: 'staff_options', path: 'departments', defaults: () => DEFAULT_STAFF_OPTIONS.departments, used: ['员工档案', '工资单', '打卡', '指令 · 派给哪个部门'], upper: true },
  positions: { title: '职位', home: 'staff', kind: 'list', store: 'staff_options', path: 'positions', defaults: () => DEFAULT_STAFF_OPTIONS.positions, used: ['员工档案', '工资单'], upper: true, attrs: true },
  sales_channels: { title: '销售类型', home: 'staff', kind: 'list', store: 'staff_options', path: 'sales_channels', defaults: () => DEFAULT_STAFF_OPTIONS.sales_channels, used: ['员工档案 · 销售员细分'], upper: true },
  unlock_reason: { title: '下班放行 · 原因', home: 'staff', kind: 'opts', options: arr(UNLOCK_REASONS), note: true, used: ['打卡 · 放行今天'] },
};

// 定义常量的文件加载时报到默认值（lib 不 import 页面，免得绕圈）
const BASES = {};
export const regBase = (key, fn) => { BASES[key] = fn; };
export const baseOf = (key) => { try { return (OPT_REG[key]?.options || BASES[key])?.() || []; } catch { return []; } };
export const regOf = (key) => OPT_REG[key];
export const groupsOf = (home) => Object.entries(OPT_REG).filter(([, g]) => g.home === home).map(([key, g]) => ({ key, ...g }));
// 被谁引用（列底下显示「被签收 · 跟谁确认的 引用」）
export const refsTo = (key) => Object.entries(OPT_REG).filter(([, g]) => g.ref === key).map(([k, g]) => ({ key: k, ...g }));
