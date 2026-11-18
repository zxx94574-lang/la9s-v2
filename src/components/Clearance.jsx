// 清仓价表 (Frank 11-17, 344 / 345): 唯一允许亏本卖的情况. 一条 = 型号 + 清仓价 + 起止日期 + 适用对象 + 原因. 只中方.
// 卖价不低于生效清仓价的行, 不再被「会亏」拦住 (规则在 0052).
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, Info, Choice, DatePicker, Pill } from './ui.jsx';
import Grid from './Grid.jsx';
import { ModelLink } from './Archives.jsx';
import { money, friendlyError, today, dDate } from '../lib/format.js';
import { TIERS } from '../lib/domain.js';

const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export default function ClearanceCard({ products }) {
  const { org, role, toast, refresh, tick } = useApp();
  const [form, setForm] = useState(null);
  const { data } = useData(() => (role !== 'admin' ? Promise.resolve(null) : q(`select cp.*, p.code, p.model, c.name as category,
      (select string_agg(cu.name, '、') from app.customers cu where cu.id = any(cp.customer_ids)) as customers
    from app.clearance_prices cp join app.products p on p.id = cp.product_id left join app.categories c on c.id = p.category_id
    where cp.org_id = $1 order by (cp.ended_at is null and cp.ends_on >= current_date) desc, cp.ends_on desc`, [org])), [org, role, tick]);
  const { data: custs } = useData(() => (form ? q(`select id, code, name from app.customers where org_id = $1 and status = 'active' order by name`, [org]) : Promise.resolve(null)), [org, !!form]);
  if (role !== 'admin' || !data) return null;
  const td = today();
  const state = (r) => (r.ended_at ? ['已提前结束', 'gray'] : dDate(r.ends_on) < td ? ['已过期', 'gray'] : dDate(r.starts_on) > td ? ['还没开始', 'amber'] : ['生效中', 'green']);
  const who = (r) => (r.customers ? `指定客户：${r.customers}` : r.tiers?.length ? `档位：${r.tiers.map((x) => TIERS[x] || x).join(' / ')}` : '所有客户');
  const cols = [
    { key: 'state', label: '状态', w: 90, value: (r) => state(r)[0], render: (r) => <Pill tone={state(r)[1]}>{state(r)[0]}</Pill> },
    { key: 'model', label: '型号', w: 120, value: (r) => r.model, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
    { key: 'category', label: '种类', w: 110 },
    { key: 'code', label: '编码', w: 90 },
    { key: 'price', label: '清仓价 XOF', w: 110, num: true, value: (r) => Number(r.price), render: (r) => <b>{money(r.price)}</b> },
    { key: 'starts_on', label: '开始', w: 100, value: (r) => dDate(r.starts_on) },
    { key: 'ends_on', label: '结束', w: 100, value: (r) => dDate(r.ends_on) },
    { key: 'who', label: '适用对象', w: 200, value: who },
    { key: 'note', label: '清仓原因', w: 220 },
  ];
  const end = async (r) => { try { await call(role, `select app.end_clearance($1)`, [r.id]); toast('已结束这条清仓价'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const f = form; const set = (k, v) => setForm((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.product) return toast('选型号', 'err'); if (!(Number(f.price) >= 0) || f.price === '') return toast('填清仓价', 'err');
    if (!f.note.trim()) return toast('写清仓原因（谁定的、为什么清）', 'err');
    if (f.scope === 'tier' && !f.tiers.length) return toast('选适用的档位', 'err'); if (f.scope === 'cust' && !f.custs.length) return toast('选适用的客户', 'err');
    try {
      await call(role, `select app.set_clearance($1,$2,$3,$4,$5,$6,$7,$8)`, [org, f.product, Number(f.price), f.range[0], f.range[1], f.scope === 'tier' ? f.tiers : null, f.scope === 'cust' ? f.custs : null, f.note.trim()]);
      toast('清仓价已生效'); setForm(null); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const live = data.filter((r) => state(r)[0] === '生效中').length;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-h"><h2>清仓价表</h2><Pill tone={live ? 'green' : 'gray'}>{live} 条生效中</Pill>
        <Info>不做亏钱的买卖，唯一的例外是清仓。在这里写下清仓决定：哪个型号、清仓价多少、从哪天到哪天、给谁。期间卖价不低于清仓价的单不会被「会亏」拦住；没有清仓决定的亏本价一律要中方逐单批。到期自动失效。</Info>
        <span className="grow" /><button type="button" className="btn sm primary" onClick={() => setForm({ product: '', price: '', range: [td, plus(30)], scope: 'all', tiers: [], custs: [], note: '' })}>＋ 加清仓价</button></div>
      {data.length ? <Grid id="clearance" columns={cols} rows={data} slimTools rowActions={[{ label: '提前结束', tone: 'danger', when: (r) => state(r)[0] === '生效中' || state(r)[0] === '还没开始', run: end }]} />
        : <div className="card-b small muted">还没有清仓决定。</div>}
      {f && <Modal title="加一条清仓价" onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>取消</button><button type="button" className="btn primary" onClick={save}>保存，立即生效</button></>}>
        <FRow label="型号" req><Choice value={f.product} onChange={(v) => set('product', v)} flat={false} placeholder="选型号（可搜编码 / 型号 / 种类）" style={{ width: 320 }}
          options={(products || []).map((p) => [p.id, `${p.model} · ${p.category || ''}`, p.code])} /></FRow>
        <FRow label="清仓价" req><input className="in" inputMode="numeric" style={{ width: 130 }} value={f.price} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">XOF / 片</span></FRow>
        <FRow label="起止日期" req><DatePicker range value={f.range} onChange={(v) => set('range', v)} /></FRow>
        <FRow label="给谁" req><Choice value={f.scope} onChange={(v) => set('scope', v)} options={[['all', '所有客户'], ['tier', '指定档位'], ['cust', '指定客户']]} /></FRow>
        {f.scope === 'tier' && <FRow label="档位" req><span className="chips">{Object.entries(TIERS).map(([k, v]) => <button type="button" key={k} className={`chip ${f.tiers.includes(k) ? 'on' : ''}`} onClick={() => set('tiers', f.tiers.includes(k) ? f.tiers.filter((x) => x !== k) : [...f.tiers, k])}>{v}</button>)}</span></FRow>}
        {f.scope === 'cust' && <FRow label="客户" req>
          <Choice value="" onChange={(v) => v && !f.custs.includes(v) && set('custs', [...f.custs, v])} flat={false} placeholder="＋ 加一个客户" style={{ width: 260 }} options={(custs || []).filter((c) => !f.custs.includes(c.id)).map((c) => [c.id, c.name, c.code])} />
          <span className="chips" style={{ flexBasis: '100%' }}>{f.custs.map((id) => <button type="button" key={id} className="chip on" title="点一下去掉" onClick={() => set('custs', f.custs.filter((x) => x !== id))}>{(custs || []).find((c) => c.id === id)?.name || id} ×</button>)}</span></FRow>}
        <FRow label="清仓原因" req><input className="in" style={{ flex: '1 1 260px', minWidth: 0 }} placeholder="谁定的、为什么清（老库存 / 滞销 / 有瑕疵…）" value={f.note} onChange={(e) => set('note', e.target.value)} /></FRow>
      </Modal>}
    </div>);
}
