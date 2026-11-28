// 11-26 Frank：界面分层 —— 在上层（侧栏、弹窗、下拉、底部卡片、点中的表格）里上下滑，只滑这一层；
// 这一层滑到头了也不许带着后面的页面动。滑外面才滑页面。
// 做法：全局拦 wheel / touchmove，事件落在某一层里时，找这一层里（含这一层）还能往这个方向滚的元素；一个都没有就 preventDefault。
export const LAYERS = '.side, .scrim, .overlay, .menu, .per-menu, .msheet, .dp-pop, .cell-pop, .ask-veil, .tw-on, .drawer, .pe-body';

const canScroll = (el, dy) => {
  const st = getComputedStyle(el); if (!/(auto|scroll)/.test(st.overflowY)) return false;
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  return dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
};
function blocked(target, dy) {
  const layer = target?.closest?.(LAYERS); if (!layer || !dy) return false;
  for (let el = target; el; el = el.parentElement) { if (canScroll(el, dy)) return false; if (el === layer) break; }
  return true;
}

export function installScrollLayers() {
  let y0 = 0; let x0 = 0;
  const wheel = (e) => { if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; if (blocked(e.target, e.deltaY)) e.preventDefault(); };
  const ts = (e) => { y0 = e.touches[0]?.clientY || 0; x0 = e.touches[0]?.clientX || 0; };
  const tm = (e) => { if (e.touches.length !== 1) return; const y = e.touches[0].clientY; const dy = y0 - y; if (Math.abs(dy) < 2 || Math.abs(x0 - e.touches[0].clientX) > Math.abs(dy)) return; if (blocked(e.target, dy) && e.cancelable) e.preventDefault(); };
  window.addEventListener('wheel', wheel, { passive: false });
  window.addEventListener('touchstart', ts, { passive: true });
  window.addEventListener('touchmove', tm, { passive: false });
  return () => { window.removeEventListener('wheel', wheel); window.removeEventListener('touchstart', ts); window.removeEventListener('touchmove', tm); };
}
