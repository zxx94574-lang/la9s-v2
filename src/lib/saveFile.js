// 给用户一个文件: 在 claude.ai 链接里走 downloads 能力 (会弹确认), 本地 / 部署后直接下载.
export async function saveFile(filename, blob) {
  try {
    const c = typeof window !== 'undefined' ? window.claude : null;
    if (c?.use) {
      const d = await c.use('downloads');
      if (d) { await d.save({ filename, data: blob }); return 'saved'; }
    }
  } catch (e) {
    if (e?.code === 'declined') return 'declined';
    if (e?.code && e.code !== 'unavailable' && e.code !== 'not_granted') throw new Error(`下载没成功（${e.code}）`);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'saved';
}
