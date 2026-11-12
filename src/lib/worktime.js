// 241 (Frank 11-11): 只算上班时间 —— 周一到周五 9:00–17:30 (中午 12:30–13:30 午休扣掉), 周六 9:00–12:00, 周日不算
const TZ = 'Africa/Abidjan';   // UTC+0, 没有夏令时 → 直接用 UTC 时分算
const WIN = (dow) => (dow === 0 ? [] : dow === 6 ? [[540, 720]] : [[540, 750], [810, 1050]]);
export function workMinutes(a, b) {
  const s = new Date(a), e = new Date(b); if (!(e > s)) return 0;
  let total = 0; const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  for (let i = 0; i < 400 && d <= e; i += 1, d.setUTCDate(d.getUTCDate() + 1)) {
    for (const [w0, w1] of WIN(d.getUTCDay())) {
      const x0 = Math.max(s.getTime(), d.getTime() + w0 * 60e3), x1 = Math.min(e.getTime(), d.getTime() + w1 * 60e3);
      if (x1 > x0) total += (x1 - x0) / 60e3;
    }
  }
  return Math.round(total);
}
export const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} 分钟` : m < 480 ? `${(m / 60).toFixed(1)} 小时` : `${(m / 480).toFixed(1)} 个工作日`);
export const WORKTIME_TZ = TZ;
