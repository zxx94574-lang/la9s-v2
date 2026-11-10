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
export function periodRange(key, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  const day = new Date(y, m, now.getDate());
  switch (key) {
    case 'week': { const s = new Date(day); s.setDate(day.getDate() - ((day.getDay() + 6) % 7)); return [ymd(s), ymd(day)]; }
    case 'month': return [ymd(new Date(y, m, 1)), ymd(day)];
    case 'quarter': return [ymd(new Date(y, Math.floor(m / 3) * 3, 1)), ymd(day)];
    case 'year': return [ymd(new Date(y, 0, 1)), ymd(day)];
    default: return [ymd(day), ymd(day)];
  }
}
export const PERIODS = [['day', '本日'], ['week', '本周'], ['month', '本月'], ['quarter', '本季度'], ['year', '本年度'], ['custom', '自定义']];

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
    [/DEBT_BLOCK: (.+)/, null],
    [/NEEDS_APPROVAL: (.+)/, null],
    [/CONFLICT: (.+)/, null],
    [/VALIDATION: (.+)/, null],
  ];
  for (const [re, msg] of rules) { const x = m.match(re); if (x) return typeof msg === 'function' ? msg(x) : msg || x[1]; }
  return m.replace(/^error: /i, '');
}
