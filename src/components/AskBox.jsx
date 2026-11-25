// 智能搜索（Frank 11-25 14:00 改）：顶栏右上一个按钮 → 弹出搜索；一句话问 → 结论 + 一键跳转到对应清单（自动筛好）。
// 原来是：经营总览顶上一个框，用平常说话的方式问数，例「Koffi 昨天对应客户的销量」
// 不用外部 AI（数据不出这台电脑 / 服务器）：本地听懂「谁 / 哪个客户 / 哪个型号或种类 / 什么时候 / 看什么 / 按什么分」，
// 听懂的部分显示成一排小块，点 × 去掉、点分组换一种分法；结果是一张表 + 一句话，客户 / 型号 / 员工都能点开。
// 销量 = 出库（作废的不算，退货另列）；员工 = 订单上的归属销售员（激励也按这个算）；金额一律折成 XOF。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { q } from '../db/client.js';
import { useApp, useData, Choice } from './ui.jsx';
import { ordersJump } from '../lib/dirWork.js';
import { ITEMS, visibleTo } from './Nav.jsx';
import { monthWeeks, weekOf } from '../lib/format.js';
import { presetPeriod } from './ui.jsx';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');
const norm = (s) => String(s || '').toUpperCase().replace(/[\s_\-·.]+/g, '');

// 时间：返回 [from, to, 说法, 页面日期按钮的值]（第 4 个 = 跳到清单页时直接点亮「本日 / 本周 / 本月 / 本季度 / 本年度」那一格，不是一段自定义日期）
// 中 / 英 / 法都认；先认具体的（某一天、第几周、某季度），再认笼统的；都没有 = 本月。
const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const MONTHS = [/janvier|january|\bjan\b/i, /f[ée]vrier|february|\bfeb\b/i, /\bmars\b|\bmarch\b/i, /avril|april/i, /\bmai\b|\bmay\b/i, /\bjuin\b|\bjune\b/i,
  /juillet|\bjuly\b/i, /\bao[uû]t\b|august/i, /septembre|september/i, /octobre|october/i, /novembre|november/i, /d[ée]cembre|december/i];
const ORD = /(?:第\s*([1-5一二三四五])\s*(?:周|个星期|星期)|(最后一\s*(?:周|个?星期))|\b(premi[eè]re|1(?:re|ère)|deuxi[eè]me|2e|troisi[eè]me|3e|quatri[eè]me|4e|derni[eè]re)\s+semaine|\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+week\s+of)/i;
const ordN = (m) => { if (m[1]) return CN[m[1]] || Number(m[1]); if (m[2]) return 9; const w = (m[3] || m[4]).toLowerCase(); return /^(premi|1|first)/.test(w) ? 1 : /^(deux|2|second)/.test(w) ? 2 : /^(trois|3|third)/.test(w) ? 3 : /^(quatr|4|fourth)/.test(w) ? 4 : 9; };
export function parseWhen(t, now = new Date()) {
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const Y = d0.getFullYear(); const M = d0.getMonth() + 1; const Q = Math.floor(d0.getMonth() / 3) + 1;
  const mon = (d) => addD(d, -((d.getDay() + 6) % 7));
  const cap = (a, b) => [ymd(a), ymd(b > d0 ? d0 : b)];   // 本期只算到今天
  const yOf = (mm) => (mm > M ? Y - 1 : Y);                 // 比现在月份大 = 去年
  let m;
  // ① 某一天：11月20日 / 11-20 / 20/11（法语日/月）/ 2026-11-20
  if ((m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) { const d = new Date(+m[1], m[2] - 1, +m[3]); return [ymd(d), ymd(d), ymd(d), 'd:' + ymd(d)]; }
  if ((m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)) || (m = t.match(/(?<![\d-])(\d{1,2})-(\d{1,2})(?![\d-])/))) { const mm = +m[1], dd = +m[2]; if (mm <= 12 && dd <= 31) { const d = new Date(yOf(mm), mm - 1, dd); return [ymd(d), ymd(d), ymd(d).slice(5), 'd:' + ymd(d)]; } }
  if ((m = t.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) { const dd = +m[1], mm = +m[2]; if (mm <= 12 && dd <= 31) { const d = new Date(yOf(mm), mm - 1, dd); return [ymd(d), ymd(d), ymd(d).slice(5), 'd:' + ymd(d)]; } }
  if (/前天|avant-hier|day before yesterday/i.test(t)) { const d = addD(d0, -2); return [ymd(d), ymd(d), `前天 ${ymd(d).slice(5)}`, 'd:' + ymd(d)]; }
  if (/昨天|昨日|yesterday|\bhier\b/i.test(t)) { const d = addD(d0, -1); return [ymd(d), ymd(d), `昨天 ${ymd(d).slice(5)}`, 'yesterday']; }
  if (/今天|今日|当天|today|aujourd|ce jour/i.test(t)) return [ymd(d0), ymd(d0), '今天', 'day'];
  // ② 近 N 天 / last 7 days / 7 derniers jours
  if ((m = t.match(/(?:最近|近|过去|last|past)\s*(\d+)\s*(?:天|日|days?|jours?)/i)) || (m = t.match(/(\d+)\s*derniers?\s*jours/i))) { const n = Number(m[1]); return [ymd(addD(d0, -(n - 1))), ymd(d0), `近 ${n} 天`, 'custom']; }
  // ③ 某月第几周（周一到周日，掐在这个月里）：这个月第一周 / 10月第二周 / première semaine de novembre / first week of October
  if ((m = t.match(ORD))) {
    const n = ordN(m); let mm = M;
    const mc = t.match(/(\d{1,2})\s*月份?|(十[一二]?|[一二三四五六七八九])\s*月/); if (mc) mm = mc[1] ? +mc[1] : CN[mc[2]];
    else { const i = MONTHS.findIndex((r) => r.test(t)); if (i >= 0) mm = i + 1; else if (/上个?月|mois dernier|last month/i.test(t)) mm = M === 1 ? 12 : M - 1; }
    // 第几周 = 按日期切：1–7 号第 1 周、8–14 号第 2 周、15–21、22–28、29 号到月底第 5 周（不跟星期几走，免得出现只有一两天的「第一周」）
    // 一个月里的周 = 周历里那一行（周一到周日，月初 / 月末不满 4 天的零头并进第一 / 最后一周，lib/format.js monthWeeks）
    const yy = mm > M ? Y - 1 : Y; const W = monthWeeks(yy, mm);
    let k = n === 9 ? W.length : Math.min(n, W.length);
    if (W[k - 1][0] > d0 && yy === Y && mm === M) k = weekOf(d0).n;   // 这个月还没走到的周 → 本周
    const [a, b] = W[k - 1];
    if (a <= d0) { const tw = weekOf(d0); const [x, y] = cap(a, b); return [x, y, `${mm} 月第 ${k} 周`, tw.y === yy && tw.m === mm && tw.n === k ? 'week' : `w:${yy}-${mm}-${k}`]; }
  }
  if (/上周|上个星期|上星期|last week|semaine (?:derni[eè]re|pass[ée]e)/i.test(t)) { const w = weekOf(d0); const v = weekOf(addD(w.from, -1)); return [ymd(v.from), ymd(v.to), '上周', `w:${v.y}-${v.m}-${v.n}`]; }
  if (/本周|这周|这个星期|这星期|this week|cette semaine/i.test(t)) { const w = weekOf(d0); return [ymd(w.from), ymd(d0), '本周', 'week']; }
  // ④ 季度：本季度 / 上季度 / Q3 / 第三季度 / 三季度 / ce trimestre / 3e trimestre
  if (/上个?季度?(?!度)|上一季|last quarter|trimestre (?:dernier|pr[ée]c[ée]dent)|dernier trimestre/i.test(t) && /季|quarter|trimestre/i.test(t)) { const qq = Q === 1 ? 4 : Q - 1; const yy = Q === 1 ? Y - 1 : Y; return [...cap(new Date(yy, (qq - 1) * 3, 1), new Date(yy, qq * 3, 0)), `${yy === Y ? '' : yy + ' '}Q${qq}`, `q:${yy}-${qq}`]; }
  if ((m = t.match(/\bQ\s*([1-4])\b|第?\s*([1-4一二三四])\s*季度?(?=度|$|[^月])|(?:\b([1-4])(?:er|e|ème)\s+trimestre)|(first|second|third|fourth)\s+quarter/i)) && /Q\s*[1-4]|季|trimestre|quarter/i.test(t)) {
    const qq = m[1] ? +m[1] : m[2] ? (CN[m[2]] || +m[2]) : m[3] ? +m[3] : ['first', 'second', 'third', 'fourth'].indexOf(m[4].toLowerCase()) + 1;
    const yy = qq > Q ? Y - 1 : Y; return [...cap(new Date(yy, (qq - 1) * 3, 1), new Date(yy, qq * 3, 0)), `${yy === Y ? '' : yy + ' '}Q${qq}`, yy === Y && qq === Q ? 'quarter' : `q:${yy}-${qq}`];
  }
  if (/本季度?|这个?季度|this quarter|ce trimestre/i.test(t)) return [ymd(new Date(Y, (Q - 1) * 3, 1)), ymd(d0), '本季度', 'quarter'];
  // ⑤ 月：上月 / 11 月 / 十一月 / novembre / October
  if (/上个?月|last month|mois (?:dernier|pass[ée])/i.test(t)) { const a = new Date(Y, M - 2, 1); return [ymd(a), ymd(new Date(Y, M - 1, 0)), '上月', `m:${a.getFullYear()}-${a.getMonth() + 1}`]; }
  let mm = 0;
  if ((m = t.match(/(\d{1,2})\s*月份?/)) && !/个月/.test(t.slice(m.index, m.index + 4))) mm = +m[1];
  else if ((m = t.match(/(十[一二]?|[一二三四五六七八九])\s*月份?/)) && !/个月/.test(t.slice(m.index, m.index + 4))) mm = CN[m[1]];
  else { const i = MONTHS.findIndex((r) => r.test(t)); if (i >= 0) mm = i + 1; }
  if (mm >= 1 && mm <= 12) { const yy = yOf(mm); return [...cap(new Date(yy, mm - 1, 1), new Date(yy, mm, 0)), `${yy === Y ? '' : yy + ' 年 '}${mm} 月`, yy === Y && mm === M ? 'month' : `m:${yy}-${mm}`]; }
  if (/本月|这个月|this month|ce mois/i.test(t)) return [ymd(new Date(Y, M - 1, 1)), ymd(d0), '本月', 'month'];
  // ⑥ 年
  if (/去年|上一年|last year|ann[ée]e (?:derni[eè]re|pass[ée]e)|l'an dernier|l’an dernier/i.test(t)) return [`${Y - 1}-01-01`, `${Y - 1}-12-31`, '去年', `y:${Y - 1}`];
  if (/今年|本年度?|this year|cette ann[ée]e|year to date|\bytd\b/i.test(t)) return [`${Y}-01-01`, ymd(d0), '今年', 'year'];
  if ((m = t.match(/\b(20\d{2})\s*(?:年|year|ann[ée]e)?/i)) && +m[1] <= Y) { const yy = +m[1]; return [...cap(new Date(yy, 0, 1), new Date(yy, 11, 31)), `${yy} 年`, yy === Y ? 'year' : `y:${yy}`]; }
  if (/所有|全部|一直|历史|从来|至今|all time|ever|depuis (?:le d[ée]but|toujours)|historique|\btout\b|\btoutes?\b/i.test(t)) return ['2000-01-01', ymd(d0), '全部时间', 'custom'];
  return [ymd(new Date(Y, M - 1, 1)), ymd(d0), '本月', 'month'];
}

// ── 看什么 / 按什么分：中 + 英 + 法（常用的业务说法，不追求全；按顺序判断，先命中先算）── 改词改这里，同步更新项目资料「智能搜索关键词表」
const W_AR = /欠款|欠多少|欠了|欠钱|应收|没付|未付|没给钱|赊账|balance|余额|对账|outstanding|receivable|unpaid|\bowe[sd]?\b|owing|\bdebts?\b|impay|dette|solde|cr[ée]ances?|reste [àa] payer|\bqui doit\b/i;
const W_STOCK = /库存|还有多少|有货|有没有货|剩多少|现货|stock|inventory|on hand|inventaire|disponib|\bdispo\b/i;
const W_RECV = /收款|回款|收了|收到|进账|到账|收钱|encaiss|paiement|versement|recouvrement|\bpay[ée]s?\b|\bpaid\b|payments?|collect(?:ed|ion)?|received/i;
const W_RET = /退货|退了|退回|retour|retourn|\brendu|returns?\b|returned|refund/i;
const W_AMT = /金额|销售额|营业额|多少钱|卖了多少钱|业绩|chiffre|montant|revenue|turnover|amount|\bvaleur\b/i;
const G_WHOM = /卖给了?谁|给谁|哪些客户|谁欠|谁买|谁没付|to whom|which (?:customers?|clients?)|who (?:owes|bought)|[àa] qui|quels clients|qui doit|qui a achet/i;
const G_DAY = /每天|按天|每日|天天|逐日|par jour|chaque jour|quotidien|daily|per day|by day/i;
const G_MODEL = /型号|机型|mod[èe]les?|\bmodels?\b|r[ée]f[ée]rences?/i;
const G_CAT = /种类|类别|分类|cat[ée]gor|\bfamilles?\b|\bpar type\b|by type/i;
const G_CUST = /客户|client|customer/i;
const G_EMP = /销售员|员工|谁|每个人|业务员|vendeur|vendeuse|commerci|employ|seller|salesm[ae]n|sales ?rep|\bstaff\b|\bwho\b|\bqui\b/i;
const G_DEAL = /订单|单子|commande|\border|facture|invoice/i;
// 按单词找人名 / 客户名时，这些问话常用词不当名字（否则打「stock」会去找叫 STOCK… 的客户）
const STOPW = /^(xof|cny|usd|fcfa|cfa|pcs|the|and|for|all|par|pour|les|des|une|qui|who|how|much|many|what|combien|balance|solde|stock|sales?|ventes?|vendu|sold|clients?|customers?|orders?|commandes?|today|yesterday|week|month|year|quarter|semaine|mois|ann[ée]e|trimestre|jours?|days?|last|past|this|cette|dernier|derni[eè]re|aujourd|hier|tout|toutes?|montant|amount|revenue|payments?|paid|paiement|retours?|returns?|stocks?|inventory|dispo|model|models|mod[eè]les?|daily|chaque|each|per|par|jour|vendeur|seller|staff|outstanding|unpaid|impay[ée]s?|dettes?|cr[ée]ances?|first|second|third|fourth|premi[eè]re|deuxi[eè]me|troisi[eè]me|quatri[eè]me)$/i;

const METRIC = [['qty', '销量（片）'], ['amount', '销售额'], ['recv', '收款'], ['ret', '退货'], ['ar', '欠款（现在）'], ['stock', '库存（现在）']];
const NOW = new Set(['ar', 'stock']);   // 这两个看的是「现在」，不看时间段
const GROUP = [['customer', '按客户'], ['model', '按型号'], ['category', '按种类'], ['employee', '按销售员'], ['day', '按天'], ['deal', '按订单']];

export function parse(text, dict) {
  const t = String(text || ''); const T = norm(t); const low = t.toLowerCase();
  const [from, to, when, pk] = parseWhen(t);
  // 问话里常用的词不当人名 / 客户名（演示数据里有叫「销售」「客户」的）
  const STOP = new Set(['销售', '客户', '员工', '仓库', '热线', '财务', '主管', '中方', '收款', '型号', '种类', '本月', '今天', '昨天']);
  const hit = (arr, keys, stop = true) => arr.filter((x) => keys(x).some((k) => k && String(k).length >= 2 && !(stop && STOP.has(String(k).trim())) && low.includes(String(k).toLowerCase())));
  // 整个名字出现在话里优先；没有就按单词找（打「thomas」也能找到「THOMAS AJM」），多个候选让人点着换
  const words = (low.match(/[a-zà-ÿ0-9]{3,}/g) || []).filter((w) => !STOPW.test(w));
  const fuzzy = (arr, keys) => arr.filter((x) => keys(x).some((k) => k && words.some((w) => String(k).toLowerCase().split(/[\s\-_.·]+/).some((part) => part.startsWith(w)))));
  const emps = hit(dict.emps, (e) => [e.short_name, e.full_name, e.emp_no]);
  const emp = emps[0] || (/(销售员|员工|业务员|名下|负责)/.test(t) ? fuzzy(dict.emps, (e) => [e.short_name, e.full_name])[0] : null) || null;
  let custs = hit(dict.custs, (c) => [c.name, c.code]).sort((a, b) => b.name.length - a.name.length).filter((c) => !emp || !String(emp.short_name).toLowerCase().includes(c.name.toLowerCase()));
  if (!custs.length) custs = fuzzy(dict.custs, (c) => [c.name, c.code]).filter((c) => !emp || !fuzzy([emp], (e) => [e.short_name]).length || !String(c.name).toLowerCase().includes(String(emp.short_name).toLowerCase()));
  const cust = custs[0] || null; const custAlt = custs.slice(1, 6);
  const cat = hit(dict.cats, (c) => [c.name], false).sort((a, b) => b.name.length - a.name.length)[0] || null;
  let model = null;
  for (const p of dict.models) { const k = norm(p); if (k.length >= 3 && T.includes(k) && (!model || k.length > norm(model).length)) model = p; }
  const metric = W_AR.test(t) ? 'ar' : W_STOCK.test(t) ? 'stock' : W_RECV.test(t) ? 'recv' : W_RET.test(t) ? 'ret' : W_AMT.test(t) ? 'amount' : 'qty';
  let group = G_WHOM.test(t) ? 'customer' : G_DAY.test(t) ? 'day' : G_MODEL.test(t) && !model ? 'model' : G_CAT.test(t) && !cat ? 'category'
    : G_CUST.test(t) && !cust ? 'customer' : G_EMP.test(t) && !emp ? 'employee' : G_DEAL.test(t) ? 'deal' : null;
  if (!group) group = emp && !cust ? 'customer' : cust ? 'model' : model ? 'customer' : 'employee';
  if (['recv', 'ar'].includes(metric) && ['model', 'category', 'day', 'deal'].includes(group)) group = metric === 'ar' && group === 'deal' ? 'deal' : 'customer';
  if (metric === 'stock' && !['model', 'category'].includes(group)) group = model ? 'model' : cat ? 'model' : 'category';
  return { from, to, when, pk, emp, cust, custAlt, cat, model, metric, group };
}

const KEY = { customer: ['c.id', 'c.name'], model: ['p.model', 'p.model'], category: ['cat.name', 'cat.name'], employee: ['e.id', "coalesce(e.short_name, '（无归属）')"], day: ['s.shipped_at::date', "to_char(s.shipped_at::date, 'MM-DD')"], deal: ['d.id', 'd.biz_no'] };
async function run(org, P) {
  const args = [org, P.from, P.to]; const w = [];
  const add = (sql, v) => { args.push(v); w.push(sql.replace('?', `$${args.length}`)); };
  if (P.emp) add('d.owner_employee_id = ?', P.emp.id);
  if (P.cust) add('d.customer_id = ?', P.cust.id);
  if (P.cat && P.metric !== 'recv') add('p.category_id = ?', P.cat.id);
  if (P.model && P.metric !== 'recv') add('p.model = ?', P.model);
  const W = w.length ? ' and ' + w.join(' and ') : '';
  const xof = "case when d.currency = 'XOF' then 1 else coalesce(d.fx_rate, 1) end";
  if (P.metric === 'stock') {
    const k = P.group === 'category' ? ['cat.name', 'cat.name'] : ['p.model', 'p.model'];
    const a2 = [org]; const w2 = [];
    if (P.cat) { a2.push(P.cat.id); w2.push(`p.category_id = $${a2.length}`); }
    if (P.model) { a2.push(P.model); w2.push(`p.model = $${a2.length}`); }
    return q(`select ${k[0]} as k, ${k[1]} as label, max(p.id::text) as pid, count(distinct p.id)::int as n, sum(s.qty_on_hand)::int as qty, sum(s.qty_on_hand - s.qty_reserved)::int as amount
      from app.stock_items s join app.warehouses w on w.id = s.warehouse_id join app.products p on p.id = s.product_id join app.categories cat on cat.id = p.category_id
      where p.org_id = $1 and w.kind = 'local' ${w2.length ? 'and ' + w2.join(' and ') : ''} group by 1, 2 having sum(s.qty_on_hand) > 0 order by qty desc limit 3000`, a2);
  }
  if (P.metric === 'ar') {
    const k = P.group === 'employee' ? ['e.id', "coalesce(e.short_name, '（无归属）')"] : P.group === 'deal' ? ['d.id', 'd.biz_no'] : ['c.id', 'c.name'];
    const a2 = [org]; const w2 = [];
    if (P.emp) { a2.push(P.emp.id); w2.push(`c.owner_employee_id = $${a2.length}`); }
    if (P.cust) { a2.push(P.cust.id); w2.push(`c.id = $${a2.length}`); }
    return q(`select ${k[0]}::text as k, ${k[1]} as label, max(c.id::text) as cid, max(e.id::text) as eid, count(*)::int as n, 0 as qty, sum(v.due * ${xof}) as amount
      from app.v_deal_due v join app.deals d on d.id = v.deal_id join app.customers c on c.id = v.customer_id left join app.employees e on e.id = c.owner_employee_id
      where v.org_id = $1 and v.due > 0 ${w2.length ? 'and ' + w2.join(' and ') : ''} group by 1, 2 order by amount desc limit 3000`, a2);
  }
  if (P.metric === 'recv') {
    const k = { customer: ['c.id', 'c.name'], employee: ['e.id', "coalesce(e.short_name, '（无归属）')"], day: ['r.received_on', "to_char(r.received_on, 'MM-DD')"], deal: ['c.id', 'c.name'], model: ['c.id', 'c.name'], category: ['c.id', 'c.name'] }[P.group];
    const W2 = W.replace(/d\.owner_employee_id/g, 'c.owner_employee_id').replace(/d\.customer_id/g, 'r.customer_id');
    return q(`select ${k[0]}::text as k, ${k[1]} as label, max(c.id::text) as cid, count(*)::int as n, 0 as qty,
        sum(case when r.currency = 'XOF' then r.amount when r.account_currency = 'XOF' then r.converted else r.amount * r.rate end) as amount
      from app.receipts r join app.customers c on c.id = r.customer_id left join app.employees e on e.id = c.owner_employee_id
      where r.org_id = $1 and r.voided_at is null and r.received_on between $2::date and $3::date ${W2} group by 1, 2 order by amount desc nulls last limit 3000`, args);
  }
  const k = KEY[P.group];
  if (P.metric === 'ret') {
    return q(`select ${k[0].replace('s.shipped_at', 'rt.created_at')}::text as k, ${k[1].replace('s.shipped_at', 'rt.created_at')} as label, max(c.id::text) as cid, max(p.id::text) as pid, max(e.id::text) as eid,
        count(distinct rt.id)::int as n, sum(rl.qty)::int as qty, sum(rl.qty * dl.unit_price * ${xof}) as amount
      from app.return_lines rl join app.returns rt on rt.id = rl.return_id join app.deal_lines dl on dl.id = rl.deal_line_id join app.deals d on d.id = rt.deal_id
      join app.customers c on c.id = d.customer_id join app.products p on p.id = dl.product_id join app.categories cat on cat.id = p.category_id left join app.employees e on e.id = d.owner_employee_id
      where d.org_id = $1 and rt.status not in ('requested','rejected') and rt.created_at::date between $2::date and $3::date ${W} group by 1, 2 order by qty desc limit 3000`, args);
  }
  return q(`select ${k[0]}::text as k, ${k[1]} as label, max(c.id::text) as cid, max(p.id::text) as pid, max(e.id::text) as eid, max(d.id::text) as did,
      count(distinct d.id)::int as n, sum(sl.qty)::int as qty, sum(sl.amount * ${xof}) as amount
    from app.shipment_lines sl join app.shipments s on s.id = sl.shipment_id join app.deals d on d.id = s.deal_id join app.deal_lines dl on dl.id = sl.deal_line_id
    join app.customers c on c.id = d.customer_id join app.products p on p.id = dl.product_id join app.categories cat on cat.id = p.category_id left join app.employees e on e.id = d.owner_employee_id
    where d.org_id = $1 and s.voided_at is null and s.shipped_at::date between $2::date and $3::date ${W} group by 1, 2 order by ${P.metric === 'amount' ? 'amount' : 'qty'} desc limit 3000`, args);
}

const EX = ['Thomas 今年所有销售清单', 'Thomas 的 balance', 'Koffi 昨天对应客户的销量', '本月每个销售员卖了多少钱', '现在谁欠款最多', '近 7 天收款按客户', '电池盖库存'];

// 去哪看（一键跳转，到了自动筛好）：每种问法给一个主按钮，必要时再给一两个
function jumpsOf(P, rows) {
  const J = [];
  const day = (x) => x.slice(5);
  const range = P.from === '2000-01-01' ? '全部时间' : `${day(P.from)} – ${day(P.to)}`;
  const ordersJ = { kind: 'orders', j: { cust: P.cust?.id, model: P.model, cat: P.cat?.name, emp: P.emp?.id, from: P.from, to: P.to, pk: P.pk, ask: true } };
  if (P.metric === 'ar') {
    if (P.cust) J.push({ ...{ kind: 'go', to: `customer/${P.cust.id}` }, label: `打开 ${P.cust.name} 的总账`, sub: '看 Balance、发对账单、把收款冲到订单' });
    else if (rows?.length === 1 && rows[0].cid) J.push({ kind: 'go', to: `customer/${rows[0].cid}`, label: `打开 ${rows[0].label} 的总账`, sub: '看 Balance、冲订单' });
    else J.push({ kind: 'go', to: 'balances', label: '打开客户欠款清单', sub: '全部客户的 Balance；点客户进总账冲单' });
    if (P.cust) J.push({ ...ordersJ, j: { ...ordersJ.j, from: '2000-01-01', pk: 'custom', model: null, cat: null }, label: `${P.cust.name} 的全部订单`, sub: '订单总览，已筛好这个客户' });
  } else if (P.metric === 'recv') {
    J.push({ kind: 'go', period: ['receipts', P.pk, [P.from, P.to]], to: P.cust ? `receipts/${P.cust.id}` : 'receipts', label: P.cust ? `打开 ${P.cust.name} 的收款` : '打开收款与总账', sub: P.cust ? '收款记录，已选好这个客户' : '登记 / 查收款' });
    if (P.cust) J.push({ kind: 'go', to: `customer/${P.cust.id}`, label: `${P.cust.name} 的总账`, sub: '看 Balance、冲订单' });
  } else if (P.metric === 'stock') {
    J.push({ kind: 'stock', q: P.model || P.cat?.name || '', label: '打开库存', sub: P.model || P.cat ? `已按「${P.model || P.cat.name}」筛好` : '全部库存' });
  } else {
    const who = [P.cust?.name, P.emp ? `${P.emp.short_name} 名下客户` : null, P.cat?.name, P.model].filter(Boolean).join(' · ');
    J.push({ ...ordersJ, label: `打开订单总览${who ? `：${who}` : ''}`, sub: `已筛好 · ${range}（按下单日期）；到了还能一键清除、改选别的客户` });
    if (P.cust) J.push({ kind: 'go', to: `customer/${P.cust.id}`, label: `${P.cust.name} 的总账`, sub: 'Balance / 冲订单' });
  }
  return J;
}

export function AskButton() {
  const { role } = useApp();
  const [open, setOpen] = useState(false);
  const ok = ['admin', 'manager', 'finance', 'sales_manager'].includes(role);
  useEffect(() => {
    if (!ok) return undefined;
    const k = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [ok]);
  if (!ok) return null;
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
  return (<>
    <button type="button" className="ask-bar" onClick={() => setOpen(true)} title="智能搜索：搜型号 / 编码 / 通用型号、客户、单号、员工、页面；或者问一句（例「Thomas 的 balance」），问完一键跳到筛好的清单">
      <span className="ask-ico">⌕</span><span className="ask-ph">智能搜索 · 型号 / 客户 / 单号，或问一句</span><kbd className="ask-kbd">{mac ? '⌘K' : 'Ctrl K'}</kbd></button>
    {open && <AskPanel onClose={() => setOpen(false)} />}
  </>);
}

// 顶栏「＋ 新建」：最常用的几件事一键到（按岗位只列看得到的）
export function NewMenu() {
  const { role, go } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => { if (!open) return undefined; const f = (e) => { if (!box.current?.contains(e.target)) setOpen(false); }; document.addEventListener('pointerdown', f); return () => document.removeEventListener('pointerdown', f); }, [open]);
  const items = [['quote/new', '新订单', '选客户、选货、报价', 'quote'], ['inquiry', '新询单', '客户问价，还不是订单', 'inquiry'], ['receipts', '登记收款', '收到钱 → 冲订单', 'receipts'], ['fob', '新 FOB 申请', '一客一单', 'fob'], ['visits', '记一次拜访', '新潜客也在这里', 'visits']]
    .filter(([r]) => { const route = r.split('/')[0] === 'quote' ? 'orders' : r; return !ITEMS[route] || visibleTo(route, role); });
  if (!items.length) return null;
  return (
    <span className="new-wrap" ref={box}>
      <button type="button" className="new-btn" onClick={() => setOpen(!open)} title="新建：订单、询单、收款、FOB、拜访">＋<span className="new-l"> 新建</span></button>
      {open && <div className="menu new-menu">{items.map(([r, l, d]) => <button type="button" key={r} className="mi" onClick={() => { setOpen(false); go(r); }}><div><b>{l}</b><div className="small muted">{d}</div></div></button>)}</div>}
    </span>);
}

const PROD_SQL = `select p.id, p.code, p.model, p.variant, p.shared_models, c.name as category,
  coalesce((select sum(s.qty_on_hand - s.qty_reserved) from app.stock_items s join app.warehouses w on w.id = s.warehouse_id where s.product_id = p.id and w.kind = 'local'), 0)::int as avail
  from app.products p join app.categories c on c.id = p.category_id where p.org_id = $1 and coalesce(p.active, true)`;
// 问话的样子（有时间 / 看什么 / 怎么分的词）→ 回车直接按问题理解
const QUESTION = new RegExp([/今天|昨天|前天|本周|上周|本月|上个?月|今年|去年|近\s*\d|最近|所有|全部|\d{1,2}\s*月|[一二三四五六七八九十]+月|季度?|第\s*\S\s*周|\bQ[1-4]\b|销量|卖|销售|金额|多少|收款|回款|退货|欠|balance|余额|库存|还有|按|每|谁|清单/,
  /today|yesterday|this (?:week|month|year|quarter)|last (?:week|month|year|quarter|\d)|how (?:much|many)|\bsold\b|\bsales\b|aujourd|\bhier\b|cette (?:semaine|ann[ée]e)|ce (?:mois|trimestre)|derniers? jours|combien|vendu|ventes|trimestre|semaine|week of|\b(?:janvier|f[ée]vrier|mars|avril|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|june|july|august|september|october|november|december)\b|年度|\d{4}\s*年|\d{1,2}[-/]\d{1,2}|depuis|historique|all time|最后一周/,
  W_AR, W_STOCK, W_RECV, W_RET, W_AMT, G_DAY].map((r) => r.source).join('|'), 'i');

function AskPanel({ onClose }) {
  const { org, go, openArchive, role } = useApp();
  const { data: dict } = useData(async () => {
    const [emps, custs, cats, prods, deals] = await Promise.all([q(`select id, short_name, full_name, emp_no from app.employees where org_id = $1`, [org]),
      q(`select c.id, c.name, coalesce(c.code, c.temp_code) as code, c.city from app.customers c where c.org_id = $1`, [org]), q(`select id, name from app.categories where org_id = $1`, [org]),
      q(PROD_SQL, [org]),
      q(`select d.id, d.biz_no, d.so_no, d.quote_no, d.status, d.created_at, c.name as customer from app.deals d join app.customers c on c.id = d.customer_id where d.org_id = $1 order by d.created_at desc limit 5000`, [org])]);
    return { emps, custs, cats, prods, deals, models: [...new Set(prods.map((p) => p.model).filter(Boolean))] };
  }, [org]);
  const [text, setText] = useState(() => { try { return sessionStorage.getItem('la9s.ask.last') || ''; } catch { return ''; } });
  const [P, setP] = useState(null); const [asked, setAsked] = useState(''); const [rows, setRows] = useState(null); const [busy, setBusy] = useState(false); const [hi, setHi] = useState(-1);
  const inp = useRef(null); const list = useRef(null);
  useEffect(() => { setTimeout(() => inp.current?.select(), 30); }, []);
  const ask = async (t = text, over) => {
    if (!dict || !String(t).trim()) return;
    try { sessionStorage.setItem('la9s.ask.last', t); } catch { /* ignore */ }
    const p = over || parse(t, dict); setP(p); setAsked(t); setBusy(true); setHi(-1);
    try { setRows(await run(org, p)); } catch (e) { setRows([]); console.warn(e); } finally { setBusy(false); }
  };
  const tweak = (patch) => ask(asked, { ...P, ...patch });
  const doJump = (J) => {
    try { sessionStorage.setItem('la9s.ask.last', text); } catch { /* ignore */ }
    onClose();
    if (J.kind === 'orders') ordersJump(go, J.j);
    else if (J.kind === 'stock') { try { sessionStorage.setItem('la9s.stock.q', J.q); } catch { /* ignore */ } go('stock'); setTimeout(() => window.dispatchEvent(new Event('la9s-stock-q')), 50); }
    else if (J.kind === 'arch') openArchive(J.a);
    else { if (J.period) presetPeriod(J.period[0], J.period[1] || 'custom', J.period[2]); go(J.to); }   // 11-25: 收款页也把时间带过去
  };
  // ── 一边打一边出：单号 / 客户 / 型号（型号、编码、通用型号，跟下单选货同一套）/ 员工 / 页面
  const hits = useMemo(() => {
    const t = text.trim(); if (!dict || !t) return null;
    const T = norm(t); const low = t.toLowerCase();
    const deals = T.length >= 3 ? dict.deals.filter((d) => [d.biz_no, d.so_no, d.quote_no].some((x) => x && norm(x).includes(T))).slice(0, 5) : [];
    const custs = dict.custs.filter((c) => String(c.name || '').toLowerCase().includes(low) || norm(c.code).includes(T)).sort((a, b) => String(a.name).toLowerCase().startsWith(low) ? -1 : String(b.name).toLowerCase().startsWith(low) ? 1 : 0).slice(0, 5);
    // 打分：型号里有一个词正好是它（SS A10 ← A10）> 型号开头 > 某个词开头 > 型号里有 > 编码 / 规格 / 通用型号；同分库存多的先
    const words = (m) => String(m || '').toUpperCase().split(/[\s_\-/()（）]+/).filter(Boolean);
    const sc = (p) => { const m = norm(p.model); const ws = words(p.model);
      return ws.includes(T) || m === T ? 5 : m.startsWith(T) ? 4 : ws.some((w) => w.startsWith(T)) ? 3 : m.includes(T) ? 2 : norm(p.code).includes(T) || norm(p.variant).includes(T) ? 1.5 : (p.shared_models || []).some((x) => norm(x).includes(T)) ? 1 : 0; };
    const prods = T.length >= 2 ? dict.prods.map((p) => [p, sc(p)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (b[0].avail - a[0].avail)).slice(0, 8).map(([p]) => p) : [];
    const emps = ['admin', 'sales_manager'].includes(role) ? dict.emps.filter((e) => [e.short_name, e.full_name, e.emp_no].some((x) => x && String(x).toLowerCase().includes(low))).slice(0, 3) : [];
    const pages = Object.entries(ITEMS).filter(([r, v]) => String(v[1]).includes(t) && visibleTo(r, role)).slice(0, 4);
    return { deals, custs, prods, emps, pages };
  }, [text, dict, role]);
  const jumps = P && rows ? jumpsOf(P, rows) : [];
  // 键盘上下走的顺序：问题的跳转 → 单号 → 客户 → 型号 → 员工 → 页面
  const flat = useMemo(() => {
    const f = [];
    if (P && rows && asked === text) jumps.forEach((J) => f.push(() => doJump(J)));
    if (hits) {
      hits.deals.forEach((d) => f.push(() => doJump({ kind: 'go', to: `deal/${d.id}` })));
      hits.custs.forEach((c) => f.push(() => doJump({ kind: 'arch', a: { kind: 'customer', id: c.id } })));
      hits.prods.forEach((p) => f.push(() => doJump({ kind: 'arch', a: { kind: 'product', product: { id: p.id, model: p.model } } })));
      hits.emps.forEach((e) => f.push(() => doJump({ kind: 'arch', a: { kind: 'employee', id: e.id } })));
      hits.pages.forEach(([r]) => f.push(() => doJump({ kind: 'go', to: r })));
    }
    return f;
  }, [hits, P, rows, asked, text]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { list.current?.querySelector('.ask-hi')?.scrollIntoView({ block: 'nearest' }); }, [hi]);
  const looksQ = QUESTION.test(text);
  const enter = () => {
    if (hi >= 0 && flat[hi]) return flat[hi]();
    if (P && rows && asked === text && jumps[0]) return doJump(jumps[0]);
    const nothing = hits && !hits.deals.length && !hits.custs.length && !hits.prods.length && !hits.emps.length && !hits.pages.length;
    if (looksQ || nothing) return ask();
    if (flat[0]) return flat[0]();
    return ask();
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
    else if (e.key === 'Escape') onClose();
  };
  let idx = (P && rows && asked === text) ? jumps.length : 0;
  const cls = (i) => (i === hi ? 'ask-hi' : '');
  const tot = useMemo(() => (rows || []).reduce((a, r) => ({ qty: a.qty + Number(r.qty || 0), amount: a.amount + Number(r.amount || 0), n: a.n + Number(r.n || 0) }), { qty: 0, amount: 0, n: 0 }), [rows]);
  const say = P && rows ? (() => {
    const who = [P.emp ? `${P.emp.short_name}${P.metric === 'ar' || P.group === 'customer' ? ' 名下' : ''}` : null, P.cust?.name, P.cat?.name, P.model].filter(Boolean).join(' · ') || '全公司';
    const g = GROUP.find((x) => x[0] === P.group)?.[1].replace('按', '') || '';
    if (!rows.length) return `${who} ${NOW.has(P.metric) ? '现在' : P.when}：没有${({ recv: '收款', ret: '退货', ar: '欠款', stock: '库存' })[P.metric] || '出库'}。`;
    if (P.metric === 'recv') return `${who} ${P.when}：收款 ${fmt(tot.amount)} XOF，${tot.n} 笔。`;
    if (P.metric === 'ar') return P.cust ? `${P.cust.name} 现在欠 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清。` : `${who} 现在：欠款 ${fmt(tot.amount)} XOF，${tot.n} 张单没收清，${rows.length} 个${g}；最多 ${rows[0].label}（${fmt(rows[0].amount)}）。`;
    if (P.metric === 'stock') return `${who} 现在：本地库存 ${fmt(tot.qty)} 片（可售 ${fmt(tot.amount)}），${rows.length} 个${g}。`;
    return `${who} ${P.when}：${P.metric === 'ret' ? '退货' : '出库'} ${fmt(tot.qty)} 片 · ${fmt(tot.amount)} XOF · ${tot.n} 单${rows.length > 1 ? `，最多 ${rows[0].label}（${fmt(P.metric === 'amount' ? rows[0].amount : rows[0].qty)}${P.metric === 'amount' ? ' XOF' : ' 片'}）` : ''}。`;
  })() : '';
  const rowJump = (r) => {
    const base = { cust: P.cust?.id, model: P.model, cat: P.cat?.name, emp: P.emp?.id, from: P.from, to: P.to, ask: true };
    if (P.metric === 'stock') return doJump({ kind: 'stock', q: r.label });
    if (P.group === 'deal') return doJump({ kind: 'go', to: `deal/${r.did || r.k}` });
    if (['ar', 'recv'].includes(P.metric)) return r.cid && P.group === 'customer' ? doJump({ kind: 'go', to: `customer/${r.cid}` }) : doJump({ kind: 'go', to: 'balances' });
    if (P.group === 'customer') return doJump({ kind: 'orders', j: { ...base, cust: r.cid } });
    if (P.group === 'model') return doJump({ kind: 'orders', j: { ...base, model: r.label } });
    if (P.group === 'category') return doJump({ kind: 'orders', j: { ...base, cat: r.label } });
    if (P.group === 'employee') return r.eid ? doJump({ kind: 'orders', j: { ...base, emp: r.eid } }) : null;
    if (P.group === 'day') return doJump({ kind: 'orders', j: { ...base, from: `${P.from.slice(0, 4)}-${r.label}`, to: `${P.from.slice(0, 4)}-${r.label}` } });
    return null;
  };
  const chip = (txt, onX) => <span className="ask-chip">{txt}{onX && <button type="button" aria-label="去掉" onClick={onX}>×</button>}</span>;
  const top = (rows || []).slice(0, 6);
  const showQ = P && rows && asked === text;
  const sec = (title, n) => n > 0 && <div className="ask-sec">{title}</div>;
  return (
    <div className="ask-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ask-pop" role="dialog" aria-label="智能搜索">
        <form className="ask-row" onSubmit={(e) => { e.preventDefault(); enter(); }}>
          <span className="ask-ico big">⌕</span>
          <input ref={inp} className="ask-in" value={text} onChange={(e) => { setText(e.target.value); setHi(-1); }} onKeyDown={key} placeholder="搜型号 / 编码 / 通用型号、客户、单号、员工；或问一句「Thomas 的 balance」" />
          {looksQ && !showQ && <button type="button" className="btn soft sm" onClick={() => ask()} disabled={!dict}>按问题理解 ↵</button>}
          <button type="button" className="btn ghost sm" onClick={onClose}>Esc</button>
        </form>
        <div className="ask-body" ref={list}>
          {!text.trim() && <div className="ask-ex">{EX.map((x) => <button type="button" key={x} className="ask-exb" onClick={() => { setText(x); ask(x); }}>{x}</button>)}
            <div className="small muted" style={{ marginTop: 8 }}>打字就出：型号（型号 / 编码 / 通用型号都行）、客户、单号、员工、页面，↑↓ 选、回车打开。像问题的话（带时间、销量、欠款、库存…）回车就按问题理解，给一句结论 + 跳到筛好的清单。</div></div>}
          {showQ && <div className="ask-ans">
            <div className="ask-chips">
              <span className="small muted">听懂的：</span>
              {NOW.has(P.metric) ? chip('现在') : chip(`${P.when}${P.from === '2000-01-01' ? '' : `（${P.from.slice(5)}${P.to !== P.from ? ' – ' + P.to.slice(5) : ''}）`}`)}
              {P.emp && chip(`销售员 ${P.emp.short_name}`, () => tweak({ emp: null }))}
              {P.cust && chip(`客户 ${P.cust.name}`, () => tweak({ cust: null, custAlt: [] }))}
              {P.cat && chip(`种类 ${P.cat.name}`, () => tweak({ cat: null }))}
              {P.model && chip(`型号 ${P.model}`, () => tweak({ model: null }))}
              <Choice size="sm" value={P.metric} onChange={(v) => tweak({ metric: v })} flat={false} options={METRIC} />
              <Choice size="sm" value={P.group} onChange={(v) => tweak({ group: v })} flat={false} options={GROUP.filter(([k]) => (P.metric === 'stock' ? ['model', 'category'].includes(k) : P.metric === 'ar' ? ['customer', 'employee', 'deal'].includes(k) : P.metric !== 'recv' || !['model', 'category', 'deal'].includes(k)))} />
            </div>
            {P.custAlt?.length > 0 && <div className="small muted">不是这个客户？{P.custAlt.map((c) => <button type="button" key={c.id} className="linkbtn small" style={{ marginLeft: 6 }} onClick={() => tweak({ cust: c, custAlt: [P.cust, ...P.custAlt.filter((x) => x.id !== c.id)] })}>{c.name}</button>)}</div>}
            {say && <div className="ask-say">{say}</div>}
            {jumps.length > 0 && <div className="ask-jumps">{jumps.map((J, i) => (
              <button type="button" key={i} className={`ask-jump ${i === 0 ? 'main' : ''} ${cls(i)}`} onClick={() => doJump(J)}><b>{J.label} →</b><small>{J.sub}</small></button>))}</div>}
            {top.length > 1 && <div className="ask-top">{top.map((r) => (
              <button type="button" key={r.k} className="ask-tr" title="点了直接打开" onClick={() => rowJump(r)}>
                <span className="ask-tl">{r.label}</span><span className="grow" />{!['recv', 'ar'].includes(P.metric) && <span className="muted small">{fmt(r.qty)} 片</span>}<b>{fmt(r.amount)}</b></button>))}
              {rows.length > top.length && <div className="small muted" style={{ padding: '4px 8px' }}>还有 {rows.length - top.length} 个，跳过去看全部</div>}</div>}
          </div>}
          {busy && <div className="small muted">算一下…</div>}
          {hits && <>
            {sec('单号', hits.deals.length)}{hits.deals.map((d) => { const i = idx++; return (
              <button type="button" key={d.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}><b className="mono">{d.biz_no}</b><span className="muted small">{d.customer}</span><span className="grow" /><span className="small muted">{String(d.created_at).slice(0, 10)}</span></button>); })}
            {sec('客户', hits.custs.length)}{hits.custs.map((c) => { const i = idx++; return (
              <div key={c.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} role="button" tabIndex={-1} onClick={() => flat[i]()}>
                <b>{c.name}</b><span className="muted small mono">{c.code}</span><span className="muted small">{c.city}</span><span className="grow" />
                <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); doJump({ kind: 'orders', j: { cust: c.id, from: '2000-01-01', to: ymd(new Date()), ask: true } }); }}>订单</button>
                <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); doJump({ kind: 'go', to: `customer/${c.id}` }); }}>总账</button>
                <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); doJump({ kind: 'go', to: `receipts/${c.id}` }); }}>收款</button></div>); })}
            {sec('型号（型号 / 编码 / 通用型号）', hits.prods.length)}{hits.prods.map((p) => { const i = idx++; return (
              <button type="button" key={p.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}>
                <b>{p.model}</b><span className="muted small">{p.category}{p.variant ? ` · ${p.variant}` : ''}</span><span className="mono small muted">{p.code}</span>
                <span className="grow" /><span className={`pill ${p.avail > 0 ? 'green' : 'gray'}`}>{p.avail > 0 ? `可售 ${fmt(p.avail)}` : '没货'}</span>
                {(p.shared_models || []).length > 0 && <span className="small muted ask-sh">通用 {p.shared_models.slice(0, 3).join(' / ')}{p.shared_models.length > 3 ? ' …' : ''}</span>}</button>); })}
            {sec('员工', hits.emps.length)}{hits.emps.map((e) => { const i = idx++; return (
              <button type="button" key={e.id} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}><b>{e.short_name}</b><span className="muted small">{e.emp_no || ''} {e.full_name && e.full_name !== e.short_name ? e.full_name : ''}</span></button>); })}
            {sec('页面', hits.pages.length)}{hits.pages.map(([r, v]) => { const i = idx++; return (
              <button type="button" key={r} className={`ask-hit ${cls(i)}`} onMouseEnter={() => setHi(i)} onClick={() => flat[i]()}><span>{v[0]}</span><b>{v[1]}</b></button>); })}
            {!showQ && !hits.deals.length && !hits.custs.length && !hits.prods.length && !hits.emps.length && !hits.pages.length && <div className="small muted" style={{ padding: 8 }}>没有直接对上的。回车按问题理解。</div>}
          </>}
        </div>
      </div>
    </div>);
}
