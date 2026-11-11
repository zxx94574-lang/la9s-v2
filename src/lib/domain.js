// Labels and permission mirror of supabase/migrations/0003_functions.sql (the SQL is the real gate; this only drives the UI).

export const ROLES = {
  admin: { label: '中方', desc: '全部权限，唯一能改价、认领冲账、审批退货和支出' },
  manager: { label: '仓库主管', desc: '下推找货、出销售订单、复检打包、出库' },
  hotline: { label: '热线', desc: '接单报价、热线确认、客户确认、回访、发起退货' },
  picker: { label: '库管员', desc: '找货单、初拣（实际供货 + 照片）；看不到价格' },
  sales: { label: '销售', desc: '外出拜访、建潜客、记回访；看得到价格，不能改价' },
  sales_manager: { label: '销售主管', desc: '销售员能做的都能做（询单、拜访、回访、FOB 申请）；价格和钱的审批还是中方' },
  finance: { label: '财务', desc: '收款登记、Balance；公户到账与支出登记' },
  boss: { label: '客户老板', desc: '演示：客户 SOUMAHORO 的老板，用手机下单、看订单进度和对账、管自己的门店；看不到底价' },
  clerk: { label: '门店店员', desc: '演示：SOUMAHORO 的门店 ADJAMÉ 2，向自己老板下单' },
};

const P = {
  quote: ['manager', 'hotline'],
  hotline_confirm: ['hotline', 'manager', 'sales_manager'],
  start_picking: ['manager', 'hotline', 'sales_manager'],
  submit_pick: ['picker', 'manager'],
  review_pick: ['manager'],
  set_price: [],
  sales_order: ['manager'],
  add_lines: ['manager'],
  customer_confirm: ['hotline', 'manager'],
  ship: ['manager'],
  mark_received: ['hotline', 'manager'],
  balance_confirm: ['hotline', 'manager', 'sales_manager', 'finance'],
  cancel: ['manager'],
  receipt: ['finance'],
  request_return: ['hotline', 'manager'],
  decide_return: [],
  inspect_return: ['manager'],
  revert: ['manager'],          // 撤回到上一步
  change_qty: ['manager'],      // 销售订单解锁改数量
  void_shipment: ['manager'],   // 发货失败 / 退回
  restore: ['manager'],         // 作废恢复
  write_off: [],                // 抹零：涉及钱，只中方 (10-31)
  prospect: ['hotline', 'manager', 'sales'],   // 建潜客 / 记回访 / 记拜访
  customer_terms: [],
  cash_register: ['finance'],   // 登记到账 / 支出 / 交款 / 导入流水
  cash_decide: [],              // 认领到账、确认交款、批支出：只中方
  payment_notice: ['hotline', 'finance', 'manager', 'sales'],   // 客户说付了 (挂截图)           // 档位、正式编码、欠款上限、账期、协议：只中方
  import_data: [],
  receive_po: ['manager'],      // 采购到货入库              // 数据导入：只中方
  inquiry: ['sales', 'hotline', 'manager'],
  purchase_request: ['manager', 'finance', 'hotline', 'sales', 'picker'],
  purchase_advance: ['manager', 'finance'],
  fob_create: ['hotline', 'sales', 'manager'],
  fob_advance: ['manager'],
  fob_pay: ['finance'],
  kd_save: ['finance', 'manager'],
  kd_audit: ['manager'],
  rename_model: [],             // 物料名称管理：只中方
  settings_thresholds: [],      // 改价预警阈值：只中方
  quote_price: [],              // 11-09: 报价时直接改价 (不用审批, 手改留痕 + 提示): 只中方
  quote_price_request: ['hotline', 'manager', 'sales'],   // 11-09 13:51: 员工报价时申请改价 → 中方审批, 批了才能下推
  see_cost: [],                 // 11-09: 看成本 / 全部档位价格: 只中方
  see_tier_price: ['hotline', 'manager', 'sales', 'finance'],   // 11-09: 点型号看这单客户档位的价
  step_people: [],              // 11-09: 设置找货人 / 复核人候选
};
// 销售主管继承销售员 (SQL 里 app.has_role 同样处理)
export const roleSet = (role) => (role === 'sales_manager' ? ['sales_manager', 'sales'] : [role]);
export const hasAny = (role, list) => role === 'admin' || roleSet(role).some((r) => list.includes(r));
// 权限配置 (Frank 11-09 第 5 条): 每个动作谁能做, 中方在「设置 → 权限配置」里勾; 没配的用上面的默认. 存 org_settings 'perm_matrix' = {action: [roles]}
let PERM_OVERRIDE = {};
export const setPermOverride = (m) => { PERM_OVERRIDE = m && typeof m === 'object' ? m : {}; };
export const rolesFor = (action) => (Array.isArray(PERM_OVERRIDE[action]) ? PERM_OVERRIDE[action] : (P[action] || []));
export const can = (role, action) => hasAny(role, rolesFor(action));
export const PERM_DEFAULTS = P;
// 只做显示的岗位名 (回收线以后上, 先占岗位, 没有菜单; 不在右上角切换里)
export const ROLE_LABELS = { ...Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])), recycle_manager: '回收主管', recycler: '回收员', recycle_wh_manager: '回收仓库主管' };
export const whoCan = (action) => ['中方', ...rolesFor(action).map((r) => ROLES[r]?.label || ROLE_LABELS[r] || r)].join(' / ');
export const seesPrice = (role) => !['picker', 'boss', 'clerk'].includes(role);
// Frank 10-31: 员工看不到整张价格清单 (只有中方); 一张单批了 (自动通过或中方批) 以后, 员工才看得到这张单的价格, 发给客户
export const seesPriceList = (role) => role === 'admin';
export const dealPriceVisible = (role, deal) => seesPrice(role) && (role === 'admin' || ['auto', 'approved'].includes(deal?.approval));

export const STATUS = {
  quoted: { label: '已报价', tone: 'gray' },
  hotline_ok: { label: '热线已确认', tone: 'blue' },
  picking: { label: '找货中 · 已预占', tone: 'amber' },
  picked: { label: '已初拣 · 待出销售订单', tone: 'blue' },
  ordered: { label: '待客户确认', tone: 'blue' },
  confirmed: { label: '待复检打包', tone: 'amber' },
  reviewed: { label: '已打包 · 待出库', tone: 'amber' },
  partial: { label: '部分出库', tone: 'amber' },
  shipped: { label: '已出库', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
};

// 11-09 Frank (第 14 / 18 / 19 条): 6 步. 底层状态不变.
//   报价·确认 → 找货·初检 → 销售订单·客户确认 → 复检打包·发货文件·出库 → 签收·对账 → 收款 (+ 退货)
export const STEPS = [
  { key: 'quote', label: '报价 · 确认', doc: 'quote_no' },
  { key: 'pick', label: '找货 · 初检', doc: 'pick_no' },
  { key: 'so', label: '销售订单 · 客户确认', doc: 'so_no' },
  { key: 'ship', label: '复检打包 · 发货文件 · 出库' },
  { key: 'sign', label: '签收 · 对账' },
  { key: 'pay', label: '收款' },
];
export const LAST_STEP = STEPS.length - 1;   // 5
// 每个状态 = 最后一个已完成步骤的下标 (-1 = 第一步还在做); shipped 看签收情况 (reachedStep 里算)
const REACHED = { quoted: -1, hotline_ok: -1, picking: 0, picked: 1, ordered: 1, confirmed: 2, reviewed: 2, partial: 2, shipped: 3, cancelled: -2 };
export function reachedStep(deal) {
  let r = REACHED[deal.status] ?? -1;
  // 全部签收 + 客户确认过对账 (0036) → 签收·对账完成, 收款当前
  if (deal.status === 'shipped' && Number(deal.unsigned_n ?? 1) === 0 && !deal.balance_pending) r = 4;
  if (deal.status === 'shipped' && Number(deal.unsigned_n ?? 1) === 0 && !deal.balance_pending && Number(deal.due) <= 0 && Number(deal.shipped_amount) > 0) r = LAST_STEP;
  return r;
}

export const SHIP_METHODS = {
  yango_moto: 'Yango 摩托车', yango_car: 'Yango 小汽车', yango_truck: 'Yango 货车',
  customer_pickup: '客户自取', staff_delivery: '员工送货',
};
export const PAY_METHODS = { cash: '现金', wave: 'Wave', orange: 'Orange Money', bank: '银行', other: '其他' };
export const RETURN_REASONS = { quality: '产品质量问题', customer_damage: '客户损坏', logistics: '物流损坏', other: '其他' };
export const TIERS = { S: 'S', WHOLESALE: 'Wholesale shop', RETAIL: 'Retail shop', REPAIR: 'Repair shop' };

// preset options instead of typing (Frank: 尽量用选项代替手打)
export const NOTE_OPTIONS = {
  hotline: ['客户确认数量', '客户要求改数量', '客户只问价，暂不要货', '客户明天再确认'],
  diff: ['实物不足', '找不到货', '货损', '客户临时减少', '其他'],
  price: ['老客户特价', '大单折扣', '清库存', '先发货后谈价', '其他'],
  confirm: ['客户已确认，可发货', '客户确认，明天发货', '客户已确认，到店自取'],
  return: ['屏幕不显示', '触摸失灵', '型号不匹配', '外观破损', '其他'],
  revert: ['客户改数量', '客户改型号', '录错了', '价格要重谈', '其他'],
  unlock: ['客户改数量', '客户不要了', '录错了', '价格谈判', '其他'],
  void_ship: ['Yango 去不了', '客户改期', '我方安排隔天发', '其他'],
  review_diff: ['点数少了', '型号不对', '货损', '其他'],
  rename: ['统一写法', '品牌前缀', '录错了', '其他'],
  writeoff: ['尾差抹零', '折算零头', '其他'],
};

// how the customer confirmed (待改 15)
export const CONFIRM_METHODS = { whatsapp: 'WhatsApp 消息', phone: '电话', in_store: '到店' };
// 抽检结果 (待改 17)
export const CHECK_RESULTS = { ok: '数量对 · 型号对', qty_wrong: '数量不对', model_wrong: '型号不对', problem: '其他问题' };

// 欠款说法 (待改 38)：never show a negative balance
export function balanceWords(b, cur = 'XOF') {
  const n = Number(b || 0);
  if (n > 0.004) return { tone: 'red', label: '当前欠款', amount: n, text: `当前欠款 ${fmt(n, cur)} ${cur}` };
  if (n < -0.004) return { tone: 'green', label: '预付', amount: -n, text: `当前客户无欠款，此为预付 ${fmt(-n, cur)} ${cur}` };
  return { tone: 'green', label: '已结清', amount: 0, text: '已结清' };
}
const fmt = (n, cur) => new Intl.NumberFormat('en-US', { maximumFractionDigits: cur === 'XOF' ? 0 : 2, minimumFractionDigits: cur === 'XOF' ? 0 : 2 }).format(n);

// 改价偏差预警阈值 (待改 18): stored per browser in the demo; admin only
export const DEFAULT_THRESHOLDS = [5, 10, 20];
export function getThresholds() {
  try { const v = JSON.parse(localStorage.getItem('la9s.priceThresholds')); if (Array.isArray(v) && v.length === 3) return v.map(Number); } catch { /* ignore */ }
  return DEFAULT_THRESHOLDS;
}
export function setThresholds(v) { try { localStorage.setItem('la9s.priceThresholds', JSON.stringify(v)); } catch { /* ignore */ } }
// deviation level of a price vs the tier price: 0 none, 1 yellow, 2 orange, 3 red, 4 zero price
export function priceLevel(price, tierPrice, th = getThresholds()) {
  const p = Number(price), t = Number(tierPrice);
  if (p === 0) return { level: 4, pct: -100 };
  if (!(t > 0)) return { level: 0, pct: 0 };
  const pct = ((p - t) / t) * 100, a = Math.abs(pct);
  return { level: a >= th[2] ? 3 : a >= th[1] ? 2 : a >= th[0] ? 1 : 0, pct };
}

export const EVENT_LABELS = {
  quote_approved: '中方批准', quote_rejected: '中方没批', approval_resubmitted: '重新提交审批', approval_auto_cleared: '客户付款后自动通过审批',
  debt_released: '中方放行（欠款）', fx_set: '设定汇率', price_requested: '员工申请改价',
  hotline_busy: '客户忙，稍后再联系', bl_issued: '出 BL 编号', customer_received: '客户签收', balance_confirmed: '客户确认对账', issue_reported: '⚠ 上报问题', issue_closed: '✓ 中方处理了上报',
  quote_created: '创建报价', quote_edited: '修改报价', price_set: '中方改价', hotline_confirmed: '热线确认',
  picking_started: '下推找货单（预占库存）', pick_submitted: '初拣完成', pick_reviewed: '主管复检打包',
  sales_order_created: '生成销售订单', lines_added: '出库前追加货', customer_confirmed: '客户确认',
  shipped: '出库', cancelled: '作废（取消）', return_requested: '发起退货', return_approved: '退货审批通过', receipt_voided: '撤销收款', return_reconciled: '退货对账完成',
  qty_changed: '解锁改数量', prepayment_applied: '预付自动抵扣', shipment_voided: '发货失败 · 撤销出库',
  step_reverted: '撤回到上一步', restored: '恢复作废单', written_off: '抹零',
};

// 订单三色灯 + 卡在哪一步 (Frank 11-09 19:10): 红 = 已取消, 黄 = 进行中, 绿 = 已完成 (全部出库 + 全部签收 + 收清 + 退货都对完账)
export const LIGHT_LABEL = { done: '已完成', active: '进行中', cancelled: '已取消' };
export function dealLight(d) {
  if (!d) return 'active';
  if (d.status === 'cancelled') return 'cancelled';
  if (d.status === 'shipped' && Number(d.unsigned_n || 0) === 0 && Number(d.due || 0) <= 0 && Number(d.open_returns_n || 0) === 0 && !d.balance_pending) return 'done';
  return 'active';
}
export function stuckOf(d) {
  if (!d) return '';
  const s = d.status;
  if (s === 'cancelled') return '已作废';
  if (s === 'quoted') {
    if (d.approval === 'pending') return '① 等中方审批';
    if (d.approval === 'rejected') return '① 中方没批 · 改单后重新提交';
    if (d.hotline_busy_at) return '① 等客户确认（客户忙）';
    return '① 待联系客户确认';
  }
  if (s === 'hotline_ok') return '② 待下推找货';
  if (s === 'picking') return '② 找货 · 初检中';
  if (s === 'picked') return '③ 待出销售订单';
  if (s === 'ordered') return '③ 等客户确认销售单';
  if (s === 'confirmed') return '④ 待复检打包';
  if (s === 'reviewed') return '④ 待出库';
  if (s === 'partial') return '④ 部分出库 · 还有货要发';
  if (Number(d.unsigned_n || 0) > 0) return '⑤ 等客户确认收货';
  if (d.balance_pending) return '⑤ 待和客户对账';
  if (Number(d.due || 0) > 0) return '⑥ 等客户付款';
  if (Number(d.open_returns_n || 0) > 0) return '退货 · 还没对完账';
  return '已完成';
}
