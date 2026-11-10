// 识别国内采购员在金蝶采购订单「备注」里写的东西 (Frank 10-31: 他是有备注的, 看能不能自动识别).
// 真实写法举例:
//   科特9S-LA；LA9S-0807-20260407-总成海运-3；LA9S-0807-20260603-thomasFOB-2；32boxes 13210pcs
//   科特9S-LA；LA9S-260903-260810-TOGO PDG总成海运-1；14boxes；7508pcs；TG2600678L；FOB无物流费；汇率6.7809
//   科特9S-LA；LA9S-260817-20260715-KABRE海运29件；8710pcs；CG2601889A 苹果手机；无物流费 FOB和本地备货混装；汇率6.7898（含税报关）
// 规则: 用「；」切成段 → 每段里找「需求批次」(日期-名字-序号) → 名字里有 FOB 客户名或 FOB 字样 = FOB, 有「本地备货 / 9S / LA9 / 总成海运」= 本地;
//       整单写了「混装」或同时有 FOB 批次和本地批次 = 混装 (要按行分). 另外抽出 箱数、件数、入仓号、汇率、是否含税报关、是否有物流费.

const LOCAL_WORDS = /本地备货|9S总成|LA9S?总成|LA9总成|总成海运|电池海运|小板海运|拆机料|本地电池|研发赠送|OLED.*备货|耳机备货|平板试单|样品/i;
const FOB_WORDS = /FOB|F0B/i;

// fobCustomers: [{code, name, keys:[...]}] 用来认「THOMAS / KABRE / TOGO PDG / DIALLO / DAME」这种名字
export function parseRemark(remark, fobCustomers = []) {
  const raw = String(remark || '').trim();
  const r = { raw, batches: [], purpose: 'unknown', fob_customers: [], boxes: null, pcs: null, warehouse_no: [], fx: null, tax: /含税/.test(raw), no_freight: /无物流费|无运费/.test(raw), mixed_flag: /混装/.test(raw), not_local: /非本地备货/.test(raw) };
  if (!raw) return r;
  const m1 = raw.match(/(\d+)\s*boxes/i); if (m1) r.boxes = Number(m1[1]);
  const m2 = raw.match(/(\d[\d,]*)\s*pcs/i); if (m2) r.pcs = Number(m2[1].replace(/,/g, ''));
  const m3 = raw.match(/汇率\s*([\d.]+)/); if (m3) r.fx = Number(m3[1]);
  r.warehouse_no = [...new Set((raw.match(/\b(?:CG|LKY|LAY|TG)\d{6,}[A-Z]?\b|\b\d{9}Y\b/g) || []))];
  const segs = raw.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
  for (const s of segs) {
    // 批次: 「(LA9S-发货日-)需求日-名字-序号」或带「海运 / 空运」的段
    if (!/海运|空运|FOB|F0B|备货|定制|工具|TOOLS|装箱单|样品|试单|拆机料/i.test(s) || /^科特/.test(s) && !/海运|备货/.test(s)) continue;
    const name = s.replace(/^LA9S-/i, '').replace(/^\d{4,8}-/, '').replace(/^\d{6,8}-/, '').trim();
    const up = name.toUpperCase();
    const cust = fobCustomers.find((c) => c.keys.some((k) => k && up.includes(k)));
    const fob = !!cust || (FOB_WORDS.test(s) && !/无物流费|无运费/.test(s.replace(/FOB无物流费|FOB无运费|F0B无运费/gi, '')) && !/^FOB无/i.test(s));
    const local = !fob && LOCAL_WORDS.test(s);
    r.batches.push({ text: s, kind: fob ? 'fob' : local ? 'local' : 'unknown', customer: cust?.code || null, customer_name: cust?.name || null, final: /结单/.test(s) });
  }
  const kinds = new Set(r.batches.map((b) => b.kind));
  r.fob_customers = [...new Set(r.batches.filter((b) => b.customer).map((b) => b.customer))];
  if (r.mixed_flag || (kinds.has('fob') && kinds.has('local'))) r.purpose = 'mixed';
  else if (kinds.has('fob') || r.not_local) r.purpose = 'fob';
  else if (kinds.has('local') || /本地备货/.test(raw)) r.purpose = 'local';
  else if (/工具|工服|物资|样品|TOOLS/i.test(raw)) r.purpose = 'supplies';
  return r;
}

// 客户编码 + 名字 → 认名字用的关键字 (去掉 FOB 前缀和 /编号)
export function fobKeys(customers) {
  return customers.map((c) => {
    const n = String(c.name || '').toUpperCase().replace(/^FOB\s+/, '').replace(/\/\s*\d+$/, '').trim();
    const keys = [n, n.replace(/^JB\s+/, '')].filter((k) => k.length >= 4);
    return { code: c.code, name: c.name, keys: [...new Set(keys)] };
  });
}
