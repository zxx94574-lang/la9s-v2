// 智能搜索关键词回归（纯函数，不起数据库）。加关键词 = 在下面加一行问法 + 期望；npm test 会跑。
// 一行：[问法, 时间按钮值 pk, 起, 止, 看什么 metric, 按什么分 group, 认出的人 / 型号 / 种类（可省）]；null = 不查这一格
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseWhen, looksLikeQuestion } from '../src/lib/askParse.js';
import { monthWeeks, periodRange, periodLabel } from '../src/lib/format.js';

const NOW = new Date(2026, 10, 25);   // 2026-11-25 周三
const dict = {
  emps: [{ id: 1, short_name: 'Koffi', full_name: 'Koffi Yao', emp_no: 'S004' }, { id: 2, short_name: '销售', full_name: '销售' }],
  custs: [{ id: 9, name: 'THOMAS AJM', code: 'CI0001' }, { id: 8, name: 'Kabre', code: 'CI0002' }, { id: 7, name: 'STOCK PHONE', code: 'CI0003' }],
  cats: [{ id: 3, name: '电池盖' }, { id: 4, name: 'LCD' }],
  models: ['BG6M', 'KL4', 'SS A10'],
};
const CASES = [
  // ── 时间：中文
  ['今天卖了多少', 'day', '2026-11-25', '2026-11-25', 'qty', 'employee'],
  ['昨天销量', 'yesterday', '2026-11-24', '2026-11-24', 'qty', null],
  ['前天销量', 'd:2026-11-23', '2026-11-23', '2026-11-23', null, null],
  ['11月20日 Thomas', 'd:2026-11-20', '2026-11-20', '2026-11-20', 'qty', 'model', 'THOMAS AJM'],
  ['11-20 销量', 'd:2026-11-20', '2026-11-20', '2026-11-20', null, null],
  ['12月3号销量', 'd:2025-12-03', '2025-12-03', '2025-12-03', null, null],
  ['近7天收款按客户', 'custom', '2026-11-19', '2026-11-25', 'recv', 'customer'],
  ['本周销量', 'week', '2026-11-23', '2026-11-25', null, null],
  ['上周销量', 'w:2026-11-3', '2026-11-16', '2026-11-22', null, null],
  ['这个月第一周销量', 'w:2026-11-1', '2026-11-01', '2026-11-08', null, null],
  ['这个月第二周销量', 'w:2026-11-2', '2026-11-09', '2026-11-15', null, null],
  ['10月第一周', 'w:2026-10-1', '2026-10-01', '2026-10-04', null, null],
  ['上个月最后一周', 'w:2026-10-5', '2026-10-26', '2026-10-31', null, null],
  ['本月最后一周', 'week', '2026-11-23', '2026-11-25', null, null],
  ['本月每个销售员卖了多少钱', 'month', '2026-11-01', '2026-11-25', 'amount', 'employee'],
  ['上个月收款', 'm:2026-10', '2026-10-01', '2026-10-31', 'recv', null],
  ['十月销量', 'm:2026-10', '2026-10-01', '2026-10-31', null, null],
  ['12月销量', 'm:2025-12', '2025-12-01', '2025-12-31', null, null],
  ['本季度每个销售员卖了多少钱', 'quarter', '2026-10-01', '2026-11-25', 'amount', 'employee'],
  ['上季度销量', 'q:2026-3', '2026-07-01', '2026-09-30', null, null],
  ['三季度销售额', 'q:2026-3', '2026-07-01', '2026-09-30', 'amount', null],
  ['Q4 销量', 'quarter', '2026-10-01', '2026-11-25', null, null],
  ['本年度销量', 'year', '2026-01-01', '2026-11-25', null, null],
  ['Thomas 今年所有销售清单', 'year', '2026-01-01', '2026-11-25', 'qty', 'model', 'THOMAS AJM'],
  ['去年销量', 'y:2025', '2025-01-01', '2025-12-31', null, null],
  ['2025 年销量', 'y:2025', '2025-01-01', '2025-12-31', null, null],
  ['Kabre 所有订单', 'custom', '2000-01-01', '2026-11-25', 'qty', 'deal', 'Kabre'],
  // ── 时间：英 / 法
  ['sales today', 'day', '2026-11-25', '2026-11-25', 'qty', null],
  ['ventes hier', 'yesterday', '2026-11-24', '2026-11-24', 'qty', null],
  ['20/11 ventes', 'd:2026-11-20', '2026-11-20', '2026-11-20', null, null],
  ['last 30 days revenue', 'custom', '2026-10-27', '2026-11-25', 'amount', null],
  ['les 7 derniers jours', 'custom', '2026-11-19', '2026-11-25', null, null],
  ['encaissements cette semaine', 'week', '2026-11-23', '2026-11-25', 'recv', null],
  ['sales last week', 'w:2026-11-3', '2026-11-16', '2026-11-22', null, null],
  ['première semaine de novembre', 'w:2026-11-1', '2026-11-01', '2026-11-08', null, null],
  ['first week of October', 'w:2026-10-1', '2026-10-01', '2026-10-04', null, null],
  ['ventes ce mois', 'month', '2026-11-01', '2026-11-25', null, null],
  ['mois dernier', 'm:2026-10', '2026-10-01', '2026-10-31', null, null],
  ['October sales', 'm:2026-10', '2026-10-01', '2026-10-31', 'qty', null],
  ['ventes novembre', 'month', '2026-11-01', '2026-11-25', null, null],
  ['ce trimestre', 'quarter', '2026-10-01', '2026-11-25', null, null],
  ['last quarter', 'q:2026-3', '2026-07-01', '2026-09-30', null, null],
  ['3e trimestre', 'q:2026-3', '2026-07-01', '2026-09-30', null, null],
  ['cette année', 'year', '2026-01-01', '2026-11-25', null, null],
  ["l'an dernier", 'y:2025', '2025-01-01', '2025-12-31', null, null],
  ['depuis toujours', 'custom', '2000-01-01', '2026-11-25', null, null],
  // ── 看什么 / 按什么分
  ['Thomas 的 balance', 'month', null, null, 'ar', 'customer', 'THOMAS AJM'],
  ['现在谁欠款最多', null, null, null, 'ar', 'customer'],
  ['谁还没给钱', null, null, null, 'ar', 'customer'],
  ['who owes the most', null, null, null, 'ar', 'customer'],
  ['qui doit le plus', null, null, null, 'ar', 'customer'],
  ['créances Kabre', null, null, null, 'ar', 'customer', 'Kabre'],
  ['unpaid orders', null, null, null, 'ar', 'deal'],
  ['impayés', null, null, null, 'ar', null],
  ['电池盖库存', null, null, null, 'stock', 'model', '电池盖'],
  ['stock BG6M', null, null, null, 'stock', 'model', 'BG6M'],
  ['KL4 dispo', null, null, null, 'stock', 'model', 'KL4'],
  ['KL4 还有多少', null, null, null, 'stock', 'model', 'KL4'],
  ['inventory by type', null, null, null, 'stock', 'category'],
  ['payments by customer', null, null, null, 'recv', 'customer'],
  ['Kabre 退货', null, null, null, 'ret', 'model', 'Kabre'],
  ['retours Kabre', null, null, null, 'ret', 'model', 'Kabre'],
  ["chiffre d'affaires par vendeur", null, null, null, 'amount', 'employee'],
  ['sales per day this week', 'week', null, null, 'qty', 'day'],
  ['ventes par modèle', null, null, null, 'qty', 'model'],
  ['Koffi 昨天对应客户的销量', 'yesterday', null, null, 'qty', 'customer', 'Koffi'],
  ['thomas sales today', 'day', null, null, 'qty', 'model', 'THOMAS AJM'],
  ['BG6M 卖给谁了', null, null, null, 'qty', 'customer', 'BG6M'],
];

for (const [text, pk, from, to, metric, group, who] of CASES) {
  test(`问法：${text}`, () => {
    const p = parse(text, dict, NOW);
    if (pk) assert.equal(p.pk, pk, '时间按钮');
    if (from) assert.equal(p.from, from, '起');
    if (to) assert.equal(p.to, to, '止');
    if (metric) assert.equal(p.metric, metric, '看什么');
    if (group) assert.equal(p.group, group, '按什么分');
    if (who) assert.ok([p.cust?.name, p.emp?.short_name, p.model, p.cat?.name].includes(who), `应认出 ${who}`);
    assert.equal(p.blank, false, '不应算「没听懂」');
    assert.ok(looksLikeQuestion(text) || p.said.who, '回车应按问题理解');
  });
}

test('问话常用词不当客户名：stock / sales 不去匹配叫 STOCK PHONE 的客户', () => {
  assert.equal(parse('stock', dict, NOW).cust, null);
  assert.equal(parse('sales this month', dict, NOW).cust, null);
  assert.equal(parse('stock phone balance', dict, NOW).cust?.name, 'STOCK PHONE');   // 整个名字出现还是认
});
test('演示数据里叫「销售」的员工不被「销售额」带出来', () => { assert.equal(parse('本月销售额', dict, NOW).emp, null); });
test('一样都没听懂 → blank（界面直说没听懂，并记下来）', () => {
  for (const t of ['asdf qwer', '你好', 'bonjour']) assert.equal(parse(t, dict, NOW).blank, true, t);
});
test('没说时间 = 默认本月，并标出是默认的', () => { const p = parse('Thomas 销量', dict, NOW); assert.equal(p.pk, 'month'); assert.equal(p.said.when, false); });
test('单号、型号不被当成日期', () => {
  assert.equal(parseWhen('CI-261118-01', NOW)[4], true);
  assert.equal(parseWhen('SO-2611-18-01', NOW)[4], true);
  assert.equal(parseWhen('iPhone 11', NOW)[4], true);
  assert.equal(parseWhen('A2025 屏幕', NOW)[4], true);
});
test('周：周一到周日掐在当月，不满 4 天的零头并进第一 / 最后一周', () => {
  const f = (y, m) => monthWeeks(y, m).map(([a, b]) => `${a.getDate()}-${b.getDate()}`).join(' ');
  assert.equal(f(2026, 11), '1-8 9-15 16-22 23-30');
  assert.equal(f(2026, 10), '1-4 5-11 12-18 19-25 26-31');
  assert.equal(f(2026, 12), '1-6 7-13 14-20 21-27 28-31');
  assert.equal(f(2026, 2), '1-8 9-15 16-22 23-28');
  assert.equal(f(2027, 2), '1-7 8-14 15-21 22-28');
  for (let y = 2024; y <= 2030; y++) for (let m = 1; m <= 12; m++) {   // 每个月：首尾相接、不漏天、4–5 周
    const W = monthWeeks(y, m); const last = new Date(y, m, 0).getDate();
    assert.equal(W[0][0].getDate(), 1); assert.equal(W[W.length - 1][1].getDate(), last);
    for (let i = 1; i < W.length; i++) assert.equal(W[i][0].getDate(), W[i - 1][1].getDate() + 1);
    assert.ok(W.length >= 4 && W.length <= 5, `${y}-${m} ${W.length} 周`);
  }
});
test('日期按钮：本周 / 上周 / 某周 / 某天 的起止和按钮上的字', () => {
  assert.deepEqual(periodRange('week', NOW), ['2026-11-23', '2026-11-25']);
  assert.deepEqual(periodRange('lastweek', NOW), ['2026-11-16', '2026-11-22']);
  assert.deepEqual(periodRange('w:2026-11-1', NOW), ['2026-11-01', '2026-11-08']);
  assert.deepEqual(periodRange('d:2026-11-10', NOW), ['2026-11-10', '2026-11-10']);
  assert.equal(periodLabel('w:2026-11-4', NOW), '本周');
  assert.equal(periodLabel('w:2026-11-1', NOW), '11 月第 1 周');
  assert.equal(periodLabel('d:2026-11-24', NOW), '昨天');
  assert.equal(periodLabel('d:2026-11-10', NOW), '11-10');
  assert.equal(periodLabel('d:2026-11-25', NOW), '本日');
  // 月初：1 号是周一的月份，上周落在上个月最后一周
  assert.deepEqual(periodRange('lastweek', new Date(2026, 5, 3)), ['2026-05-25', '2026-05-31']);
});
