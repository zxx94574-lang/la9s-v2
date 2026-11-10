// 把「编码」或「种类 + 机型」落到唯一物料 (Frank 11-01, 照飞书的用法):
//  · 只要有编码: 编码带出种类 / 机型 / 通用性 / 库存
//  · 种类 + 机型: 先找机型名完全一样的; 没有再找「通用机型」里有这个名字的 (同一个配件两个叫法)
//  · 一个都对不上 → 没建档 → 自动变「补录需求」(进未满足需求)
//  · 对上好几个 → 标黄, 让人从这几个编码里挑
export const normModel = (s) => String(s || '').toUpperCase().trim().replace(/\s+/g, ' ');

export function makeResolver(catalog) {
  const byCode = new Map(catalog.map((p) => [String(p.code).toUpperCase(), p]));
  return function resolve({ code, category_id, model }) {
    const C = String(code || '').trim().toUpperCase();
    if (C) { const p = byCode.get(C); return p ? { product: p } : { status: 'badcode' }; }
    const M = normModel(model);
    if (!M) return { status: 'blank' };
    if (!category_id) {
      const cats = [...new Set(catalog.filter((p) => p.model === M || p.shared_models.includes(M)).map((p) => p.category))];
      return { status: 'needcat', hint: cats };
    }
    const inCat = catalog.filter((p) => p.category_id === category_id);
    let c = inCat.filter((p) => p.model === M || `${p.model} ${p.variant || ''}`.trim() === M);
    if (!c.length) c = inCat.filter((p) => p.shared_models.includes(M));
    if (c.length === 1) return { product: c[0] };
    if (c.length > 1) return { status: 'multi', cands: c.map((p) => p.id) };
    return { status: 'unmet' };
  };
}

// 一块粘贴文字 → 行 [[cell, cell…]]
export const pasteRows = (text) => text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((l) => l.split('\t').map((x) => x.trim()));
export const isQty = (s) => /^\d+([.,]\d+)?$/.test(String(s || '').trim());
