// 241 (Frank 11-11): 只算上班时间 —— 周一到周五 9:00–17:30, 周六 9:00–12:00, 周日不算
// 11-12 Frank: 午休没有固定时段 (集体午休 1 小时、不打卡) → 一段时间跨过中午 12:00–14:00 就扣掉最多 60 分钟
const TZ = 'Africa/Abidjan';   // UTC+0, 没有夏令时 → 直接用 UTC 时分算
const WIN = (dow) => (dow === 0 ? [] : dow === 6 ? [[540, 720]] : [[540, 1050]]);
export function workMinutes(a, b) {
  const s = new Date(a), e = new Date(b); if (!(e > s)) return 0;
  let total = 0; const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  for (let i = 0; i < 400 && d <= e; i += 1, d.setUTCDate(d.getUTCDate() + 1)) {
    for (const [w0, w1] of WIN(d.getUTCDay())) {
      const x0 = Math.max(s.getTime(), d.getTime() + w0 * 60e3), x1 = Math.min(e.getTime(), d.getTime() + w1 * 60e3);
      if (x1 > x0) total += (x1 - x0) / 60e3;
    }
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) {   // 午休: 和 12:00–14:00 重叠的部分, 最多扣 60 分钟
      const l0 = Math.max(s.getTime(), d.getTime() + 720 * 60e3), l1 = Math.min(e.getTime(), d.getTime() + 840 * 60e3);
      if (l1 > l0) total -= Math.min((l1 - l0) / 60e3, 60);
    }
  }
  return Math.round(total);
}
export const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} 分钟` : m < 480 ? `${(m / 60).toFixed(1)} 小时` : `${(m / 480).toFixed(1)} 个工作日`);
export const WORKTIME_TZ = TZ;
