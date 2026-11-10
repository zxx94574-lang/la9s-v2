// 导入采购订单后: 用备注识别用途 (本地 / FOB / 混装) 并按行预分. exec(sql, params) 以中方身份执行.
import { parseRemark, fobKeys } from './poRemark.js';

export async function applyPoRemarks(exec, org, poRows) {
  const byNo = new Map();
  for (const r of poRows) if (r.po_no && r.remark && !byNo.has(r.po_no)) byNo.set(r.po_no, r.remark);
  if (!byNo.size) return 0;
  // FOB 客户: 名字里带 FOB 的, 加上有 FOB 记录的大客户 (THOMAS / KABRE / PDG / DAME …) —— 用客户名做关键字
  const cust = await exec(`select code, name from app.customers where org_id = $1 and code is not null`, [org]);
  const keys = fobKeys(cust.filter((c) => /FOB/i.test(c.name)).concat(cust.filter((c) => !/FOB/i.test(c.name) && cust.some((f) => /FOB/i.test(f.name) && f.name.toUpperCase().replace(/^FOB\s+(JB\s+)?/, '').includes(c.name.toUpperCase().replace(/^JB\s+/, ''))))));
  keys.push({ code: keys.find((k) => k.keys.some((x) => x.includes('DAME')))?.code, name: 'DAMEA', keys: ['DAMEA'] }, { code: keys.find((k) => k.keys.some((x) => x.includes('PDG')))?.code, name: 'TOGO PDG', keys: ['TOGO PDG', 'PDG'] });
  let n = 0;
  for (const [no, remark] of byNo) {
    const p = parseRemark(remark, keys.filter((k) => k.code));
    await exec(`select app.set_po_remark($1,$2,$3,$4)`, [org, no, remark, JSON.stringify(p)]);
    n++;
  }
  return n;
}
