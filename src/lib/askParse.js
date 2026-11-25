// 智能搜索的「听懂」部分（纯函数，不碰界面和数据库）：一句话 → 时间 / 看什么 / 按什么分 / 谁。
// 改关键词只改这个文件：时间在 parseWhen，看什么 W_*，按什么分 G_*，回车算不算问题 QUESTION。
// 改完三件事：① tests/ask.test.mjs 加一条这句问法（npm test 会跑）② 更新项目资料「智能搜索关键词表」③ 发测试版。
import { monthWeeks, weekOf } from './format.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
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
  const cap = (a, b) => [ymd(a), ymd(b > d0 ? d0 : b)];   // 本期只算到今天
  const yOf = (mm) => (mm > M ? Y - 1 : Y);                 // 比现在月份大 = 去年
  let m;
  // ① 某一天：11月20日 / 11-20 / 20/11（法语日/月）/ 2026-11-20
  if ((m = t.match(/(?<![\w-])(20\d{2})-(\d{1,2})-(\d{1,2})(?![\d-])/)) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) { const d = new Date(+m[1], m[2] - 1, +m[3]); return [ymd(d), ymd(d), ymd(d), 'd:' + ymd(d)]; }
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
  return [ymd(new Date(Y, M - 1, 1)), ymd(d0), '本月', 'month', true];   // 第 5 个 = 话里没说时间，这是默认的
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

export const METRIC = [['qty', '销量（片）'], ['amount', '销售额'], ['recv', '收款'], ['ret', '退货'], ['ar', '欠款（现在）'], ['stock', '库存（现在）']];
export const NOW = new Set(['ar', 'stock']);   // 这两个看的是「现在」，不看时间段
export const GROUP = [['customer', '按客户'], ['model', '按型号'], ['category', '按种类'], ['employee', '按销售员'], ['day', '按天'], ['deal', '按订单']];

const W_QTY = /销量|卖|销售|出库|出货|多少片|片数|sales|sold|\bsell|ventes?|vendu|\bpcs\b|pi[èe]ces/i;
export function parse(text, dict, now = new Date()) {
  const t = String(text || ''); const T = norm(t); const low = t.toLowerCase();
  const [from, to, when, pk, whenDefault] = parseWhen(t, now);
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
  const metricSaid = metric !== 'qty' || W_QTY.test(t);
  let group = G_WHOM.test(t) ? 'customer' : G_DAY.test(t) ? 'day' : G_MODEL.test(t) && !model ? 'model' : G_CAT.test(t) && !cat ? 'category'
    : G_CUST.test(t) && !cust ? 'customer' : G_EMP.test(t) && !emp ? 'employee' : G_DEAL.test(t) ? 'deal' : null;
  // 问欠款 / 收款时光说「谁 / who / qui」指的是哪个客户，不是哪个销售员（除非点名说了销售员）
  if (group === 'employee' && ['ar', 'recv'].includes(metric) && !/销售员|员工|业务员|每个人|vendeu|commerci|employ|seller|salesm[ae]n|sales ?rep|\bstaff\b/i.test(t)) group = 'customer';
  const groupSaid = !!group;
  if (!group) group = emp && !cust ? 'customer' : cust ? 'model' : model ? 'customer' : 'employee';
  if (['recv', 'ar'].includes(metric) && ['model', 'category', 'day', 'deal'].includes(group)) group = metric === 'ar' && group === 'deal' ? 'deal' : 'customer';
  if (metric === 'stock' && !['model', 'category'].includes(group)) group = model ? 'model' : cat ? 'model' : 'category';
  // said：话里真的说到了哪几样（没说到的是默认值，界面上标「默认」）；blank = 一样都没听懂 → 界面直说没听懂，并记进「没听懂的问法」
  const said = { when: !whenDefault, metric: metricSaid, group: groupSaid, who: !!(emp || cust || cat || model) };
  return { from, to, when, pk, emp, cust, custAlt, cat, model, metric, group, said, blank: !said.when && !said.metric && !said.group && !said.who };
}


// 问话的样子（有时间 / 看什么 / 怎么分的词）→ 回车直接按问题理解
export const QUESTION = new RegExp([/今天|昨天|前天|本周|上周|本月|上个?月|今年|去年|近\s*\d|最近|所有|全部|\d{1,2}\s*月|[一二三四五六七八九十]+月|季度?|第\s*\S\s*周|\bQ[1-4]\b|销量|卖|销售|金额|多少|收款|回款|退货|欠|balance|余额|库存|还有|按|每|谁|清单/,
  /today|yesterday|this (?:week|month|year|quarter)|last (?:week|month|year|quarter|\d)|how (?:much|many)|\bsold\b|\bsales\b|aujourd|\bhier\b|cette (?:semaine|ann[ée]e)|ce (?:mois|trimestre)|derniers? jours|combien|vendu|ventes|trimestre|semaine|week of|\b(?:janvier|f[ée]vrier|mars|avril|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|june|july|august|september|october|november|december)\b|年度|\d{4}\s*年|\d{1,2}[-/]\d{1,2}|depuis|historique|all time|最后一周/,
  W_AR, W_STOCK, W_RECV, W_RET, W_AMT, G_DAY].map((r) => r.source).join('|'), 'i');


// 回车算不算「问题」：有问话的词，或者话里说了时间（「mois dernier」「l'an dernier」这种只有时间的也算）
export const looksLikeQuestion = (text) => QUESTION.test(text) || !parseWhen(text)[4];
