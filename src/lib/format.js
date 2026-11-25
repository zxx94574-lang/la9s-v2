// 全站金额 / 数量统一千分位逗号 1,200,000 (Frank 第 5 组 + 11-07): XOF 无小数, CNY / USD 两位
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (v, cur = 'XOF') => {
  const n = Number(v || 0);
  return cur === 'XOF' ? nf0.format(n) : nf2.format(n);
};
export const qty = (v) => nf0.format(Number(v || 0));

export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const dt = (v) => { if (!v) return ''; const d = new Date(v); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dShort = (v) => { if (!v) return ''; const d = new Date(v); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const dDate = (v) => (v ? ymd(new Date(v)) : '');

// 本日/本周/本月/本季度/本年度
// 一个月里的周（Frank 11-25）：周一到周日，掐在这个月里；月初 / 月末不满 4 天的零头并进第一周 / 最后一周
// （例：2026-11 → 第 1 周 11-01–11-08、第 2 周 11-09–11-15 … 第 4 周 11-23–11-30）。周历、本周按钮、智能搜索「第几周」都用这一个。
export function monthWeeks(y, m) {   // m = 1–12；返回 [[开始 Date, 结束 Date], …]
  const last = new Date(y, m, 0); const w = [];
  for (let a = new Date(y, m - 1, 1); a <= last;) { const sun = new Date(a); sun.setDate(a.getDate() + ((7 - a.getDay()) % 7)); const b = sun > last ? last : sun; w.push([new Date(a), b]); a = new Date(b); a.setDate(b.getDate() + 1); }
  const len = (x) => Math.round((x[1] - x[0]) / 864e5) + 1;
  if (w.length > 1 && len(w[0]) < 4) { w[1][0] = w[0][0]; w.shift(); }
  if (w.length > 1 && len(w[w.length - 1]) < 4) { w[w.length - 2][1] = w[w.length - 1][1]; w.pop(); }
  return w;
}
export function weekOf(d) {   // 某天在它那个月的第几周 → { y, m, n, from, to }
  const y = d.getFullYear(), m = d.getMonth() + 1; const W = monthWeeks(y, m);
  const t = new Date(y, m - 1, d.getDate()); const i = Math.max(0, W.findIndex(([a, b]) => t >= a && t <= b));
  return { y, m, n: i + 1, from: W[i][0], to: W[i][1] };
}
export function periodRange(key, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  const day = new Date(y, m, now.getDate());
  const cap = (a, b) => [ymd(a), ymd(b > day ? day : b)];   // 本期只算到今天
  const k = String(key || '');
  if (k === 'all') return ['2000-01-01', ymd(day)];
  if (k.startsWith('d:')) return [k.slice(2), k.slice(2)];
  if (k.startsWith('w:')) { const [yy, mm, nn] = k.slice(2).split('-').map(Number); const W = monthWeeks(yy, mm); const w = W[Math.min(nn, W.length) - 1]; return cap(w[0], w[1]); }
  if (k.startsWith('m:')) { const [yy, mm] = k.slice(2).split('-').map(Number); return cap(new Date(yy, mm - 1, 1), new Date(yy, mm, 0)); }
  if (k.startsWith('q:')) { const [yy, qq] = k.slice(2).split('-').map(Number); return cap(new Date(yy, (qq - 1) * 3, 1), new Date(yy, qq * 3, 0)); }
  if (k.startsWith('y:')) { const yy = Number(k.slice(2)); return cap(new Date(yy, 0, 1), new Date(yy, 11, 31)); }
  switch (key) {
    case 'yesterday': { const s = new Date(day); s.setDate(day.getDate() - 1); return [ymd(s), ymd(s)]; }
    case 'lastweek': { const w = weekOf(day); const p = new Date(w.from); p.setDate(p.getDate() - 1); const v = weekOf(p); return [ymd(v.from), ymd(v.to)]; }
    case 'week': { const w = weekOf(day); return cap(w.from, w.to); }
    case 'month': return [ymd(new Date(y, m, 1)), ymd(day)];
    case 'quarter': return [ymd(new Date(y, Math.floor(m / 3) * 3, 1)), ymd(day)];
    case 'year': return [ymd(new Date(y, 0, 1)), ymd(day)];
    default: return [ymd(day), ymd(day)];
  }
}
export const PERIODS = [['day', '本日'], ['week', '本周'], ['month', '本月'], ['quarter', '本季度'], ['year', '本年度'], ['custom', '自定义']];
// 477 (Frank 11-20): 五个按钮各管一组; 11-25: 本日组 = 今天 / 日历里任意一天 (d:)，本周组 = 本周 / 周历里任意一周 (w:)
export const periodGroup = (k) => { const s = String(k || ''); if (s === 'all') return 'all'; if (s === 'day' || s === 'yesterday' || s.startsWith('d:')) return 'day'; if (s === 'week' || s === 'lastweek' || s.startsWith('w:')) return 'week'; if (s === 'month' || s.startsWith('m:')) return 'month'; if (s === 'quarter' || s.startsWith('q:')) return 'quarter'; if (s === 'year' || s.startsWith('y:')) return 'year'; return 'custom'; };
export function periodLabel(k, now = new Date()) {
  const s = String(k || ''); const y = now.getFullYear();
  const base = { day: '本日', yesterday: '昨天', week: '本周', lastweek: '上周', month: '本月', quarter: '本季度', year: '本年度', custom: '自定义', all: '全部' };
  if (base[s]) return base[s];
  if (s.startsWith('d:')) { const d = s.slice(2); if (d === ymd(now)) return '本日'; const yd = new Date(now); yd.setDate(now.getDate() - 1); if (d === ymd(yd)) return '昨天'; return Number(d.slice(0, 4)) === y ? d.slice(5) : d; }
  if (s.startsWith('w:')) { const [yy, mm, nn] = s.slice(2).split('-').map(Number); const w = weekOf(now); if (yy === w.y && mm === w.m && nn === w.n) return '本周'; return `${yy === y ? '' : yy + ' 年 '}${mm} 月第 ${nn} 周`; }
  if (s.startsWith('m:')) { const [yy, mm] = s.slice(2).split('-').map(Number); return yy === y && mm === now.getMonth() + 1 ? '本月' : `${yy === y ? '' : yy + ' 年 '}${mm} 月`; }
  if (s.startsWith('q:')) { const [yy, qq] = s.slice(2).split('-').map(Number); return yy === y && qq === Math.floor(now.getMonth() / 3) + 1 ? '本季度' : `${yy === y ? '' : yy + ' '}Q${qq}`; }
  if (s.startsWith('y:')) { const yy = Number(s.slice(2)); return yy === y ? '本年度' : `${yy} 年`; }
  return '';
}

export function friendlyError(e) {
  const m = String(e?.message || e);
  const rules = [
    [/PERMISSION_DENIED/, '当前岗位没有这个权限'],
    [/BAD_STATE: deal (\S+) is (\w+)/, '这张单已经不在这一步了，请刷新'],
    [/CONFIRM_REQUIRED/, '存在手动改价，需要二次确认'],
    [/quantity must be > 0/, '需求数量必须大于 0'],
    [/needs product or \(category \+ model\)/, '未建档需求必须先选种类，再填型号'],
    [/WAREHOUSE_SCOPE/, '本地单不能用 FOB / 待检 / 报废仓的货'],
    [/no lines/, '请至少添加一行物料'],
    [/customer has no price tier/, '该客户还没有价格档位，不能报价'],
    [/INVARIANT: reservation|qty_reserved|check constraint "stock_items/, '库存不足，无法预占'],
    [/INSUFFICIENT_STOCK: available (\d+), need (\d+)/, (x) => `库存不够：可售 ${x[1]}，需要 ${x[2]}`],
    [/SHIP_HOLD: (.+)/, (x) => `⛔ ${x[1]}`],
    [/TASK_BLOCK: (.+)/, (x) => `⛔ ${x[1]}`],
    [/LOSS_BLOCK: (.+)/, (x) => `⛔ ${x[1]}（卖价低于成本）`],
    [/DEBT_BLOCK: (.+)/, null],
    [/CREDIT_BLOCK: (.+)/, (x) => `⛔ ${x[1]}`],
    [/QTY_BLOCK: (.+)/, (x) => `⛔ ${x[1]}`],
    [/NEEDS_APPROVAL: (.+)/, null],
    [/CONFLICT: (.+)/, null],
    [/VALIDATION: (.+)/, null],
  ];
  for (const [re, msg] of rules) { const x = m.match(re); if (x) return typeof msg === 'function' ? msg(x) : msg || x[1]; }
  return m.replace(/^error: /i, '');
}
