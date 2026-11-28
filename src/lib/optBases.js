// 选项组的系统默认值放这里（11-28）：选项设置页（飞书式表）和表单里的下拉读同一份，不在各页面各写一份。
// 只放纯数据，不 import 页面，避免循环引用。
export const CONTACT_ROLES = [['boss', '老板'], ['staff', '店员'], ['driver', '运货员（收货人）'], ['sales', '销售员'], ['other', '其他人']];
export const UNLOCK_REASONS = ['今晚盘点', '急单要出', '补录今天的单', '其他'];
// 热线回访 + 客户拜访 共用一组「跟进结果」（Frank 11-28：都是对潜在 / 老客户的跟进）。代码不能改（数据库按代码存），名字、颜色、顺序在选项设置里调。
export const FOLLOW_RESULTS = [['order', '下单', 'green'], ['quote', '要报价', 'blue'], ['interested', '有兴趣', 'blue'], ['later', '以后再要', 'amber'],
  ['no_need', '暂不需要', 'gray'], ['not_interested', '没兴趣', 'gray'], ['no_answer', '没接', 'red'], ['busy', '忙 / 改天', 'amber'], ['other', '其他', 'gray']];
export const CALL_CODES = ['order', 'quote', 'later', 'no_need', 'no_answer', 'busy', 'other'];
export const VISIT_CODES = ['order', 'quote', 'interested', 'later', 'not_interested'];
