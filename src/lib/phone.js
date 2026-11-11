// 电话固定格式 (Frank 11-11 211): 不管怎么输, 一律整理成 「+225 07 00 00 00 04」.
// 只认数字; 国家码默认科特 +225 (本地 10 位), 布基纳 / 多哥 / 马里 / 贝宁 / 塞内加尔 8 位.
export const PHONE_CC = [
  ['225', '科特 +225', 10], ['226', '布基纳 +226', 8], ['228', '多哥 +228', 8],
  ['223', '马里 +223', 8], ['229', '贝宁 +229', 10], ['221', '塞内加尔 +221', 9], ['233', '加纳 +233', 9], ['86', '中国 +86', 11],
];
const LEN = Object.fromEntries(PHONE_CC.map(([c, , n]) => [c, n]));

// 拆出 国家码 + 本地号码 (digits)
export function splitPhone(raw, defCc = '225') {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return { cc: defCc, local: '' };
  if (d.startsWith('00')) d = d.slice(2);
  const hasPlus = /^\s*\+/.test(String(raw || '')) || String(raw || '').trim().startsWith('00');
  for (const [cc] of PHONE_CC) {
    if (d.startsWith(cc) && (hasPlus || d.length === cc.length + LEN[cc])) return { cc, local: d.slice(cc.length) };
  }
  return { cc: defCc, local: d };
}
const pairs = (s) => s.replace(/(\d{2})(?=\d)/g, '$1 ');
// 一个格子里可能有两个号码 (用 / 隔开): 分别整理, 都对才算对
export function normPhone(raw, defCc = '225') {
  const parts = String(raw || '').split(/\s*[/,;]\s*/).filter((x) => x.trim());
  if (parts.length > 1) { const ns = parts.map((x) => normOne(x, defCc)); return { formatted: ns.map((n) => n.formatted).join(' / '), valid: ns.every((n) => n.valid), cc: ns[0].cc, local: ns[0].local, need: ns[0].need }; }
  return normOne(raw, defCc);
}
function normOne(raw, defCc = '225') {
  const { cc, local } = splitPhone(raw, defCc);
  if (!local) return { formatted: '', valid: true, empty: true, cc, local };
  const need = LEN[cc];
  const valid = need ? local.length === need : local.length >= 8 && local.length <= 12;
  return { formatted: `+${cc} ${pairs(local)}`, valid, cc, local, need };
}
// 显示用: 能整理就整理, 整理不了原样显示 (几个号码用 / 隔开的也分别整理)
export function fmtPhone(raw) {
  if (!raw) return '';
  return String(raw).split(/\s*[/,;]\s*/).map((p) => { const n = normPhone(p); return n.valid && !n.empty ? n.formatted : p.trim(); }).join(' / ');
}
export const telHref = (raw) => `tel:${String(raw || '').split(/[/,;]/)[0].replace(/[^\d+]/g, '')}`;
