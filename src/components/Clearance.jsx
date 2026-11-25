// 特价表 (Frank 11-17 清仓价表 → 11-18 改: 大部分叫「促销价」, 名字中方自己定义). 一条 = 名字 + 型号 + 价 + 起止日期 + 适用对象 + 原因. 只中方.
// 生效期间: ① 自动成为适用客户的单价 (比档位价低才生效, 规则在 0059 tier_price)  ② 卖价不低于它的行不被「会亏」拦住 (0052).
// 卖价不低于生效清仓价的行, 不再被「会亏」拦住 (规则在 0052).
import { submitDecision } from '../lib/decision.js';
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, Info, Choice, DatePicker, Pill, Assumed, MoneyIn, TierPill } from './ui.jsx';
import Grid from './Grid.jsx';
import { ModelLink } from './Archives.jsx';
import { money, friendlyError, today, dDate } from '../lib/format.js';
import { TIERS } from '../lib/domain.js';
import { OptChoice } from './Opts.jsx';

const NAMES = ['促销价', '清仓价'];

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
    { key: 'label', label: '名称', w: 90, value: (r) => r.label, render: (r) => <Pill tone="blue">{r.label}</Pill> },
    { key: 'model', label: '型号', w: 120, value: (r) => r.model, render: (r) => <ModelLink id={r.product_id} model={r.model} /> },
    { key: 'category', label: '种类', w: 110 },
    { key: 'code', label: '编码', w: 90 },
    { key: 'price', label: '特价 XOF', w: 110, num: true, value: (r) => Number(r.price), render: (r) => <b>{money(r.price)}</b> },
    { key: 'starts_on', label: '开始', w: 100, value: (r) => dDate(r.starts_on) },
    { key: 'ends_on', label: '结束', w: 100, value: (r) => dDate(r.ends_on) },
    { key: 'who', label: '适用对象', w: 200, value: who, render: (r) => (r.tiers?.length && !r.customers ? <span>档位：{r.tiers.map((x) => <TierPill key={x} tier={x} short />)}</span> : who(r)) },
    { key: 'note', label: '原因', w: 220 },
  ];
  const end = async (r) => { try { await call(role, `select app.end_clearance($1)`, [r.id]); toast('已结束这条特价'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  const f = form; const set = (k, v) => setForm((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.product) return toast('选型号', 'err'); if (!(Number(f.price) >= 0) || f.price === '') return toast('填价格', 'err');
    if (!f.note.trim()) return toast('写原因（谁定的、为什么给这个价）', 'err');
    if (f.scope === 'tier' && !f.tiers.length) return toast('选适用的档位', 'err'); if (f.scope === 'cust' && !f.custs.length) return toast('选适用的客户', 'err');
    try {
      const [pm] = await q(`select p.code, p.model, c.name as category from app.products p join app.categories c on c.id = p.category_id where p.id = $1`, [f.product]);
      await submitDecision(role, org, 'promo', `${f.label || '促销价'}：${pm ? `${pm.category || ''} ${pm.model}` : '型号'} ${Number(f.price).toLocaleString('en-US')}（${f.range[0]} → ${f.range[1]}）`,
        { 型号: pm ? `${pm.code || ''} ${pm.category || ''} ${pm.model}` : f.product, 价格: Number(f.price), 名字: f.label || '促销价', 起止: `${f.range[0]} → ${f.range[1]}`, 适用: f.scope === 'tier' ? f.tiers.join(' / ') : f.scope === 'cust' ? `${f.custs.length} 个客户` : '所有客户', 原因: f.note.trim() },
        { product: f.product, price: Number(f.price), from: f.range[0], to: f.range[1], tiers: f.scope === 'tier' ? f.tiers : null, customers: f.scope === 'cust' ? f.custs : null, note: f.note.trim(), label: f.label || '促销价' },
        toast, `${f.label || '促销价'}已生效，适用客户的报价会自动带出这个价`);
      setForm(null); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const live = data.filter((r) => state(r)[0] === '生效中').length;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-h"><h2>特价表（促销价 / 清仓价…）</h2><Pill tone={live ? 'green' : 'gray'}>{live} 条生效中</Pill>
        <Info>在这里定特价：哪个型号、什么价、从哪天到哪天、给谁、叫什么名字（促销价 / 清仓价，名字可以自己加）。生效期间：适用客户的报价<b>自动带出</b>这个价（比他的档位价低才用），行上标名字；卖价不低于它的单不会被「会亏」拦住。到期自动失效。没有特价背书的亏本价仍然要中方逐单批。</Info>
        <Assumed>多条同时生效取最低的那条；已经建好的报价不会自动改价（点「获取价格」才更新）；外币单按单上汇率折算。这三点是我按建议定的。</Assumed><span className="grow" /><button type="button" className="btn sm primary" onClick={() => setForm({ product: '', price: '', range: [td, plus(30)], scope: 'all', tiers: [], custs: [], note: '', label: '促销价' })}>＋ 加特价</button></div>
      {data.length ? <Grid id="clearance" columns={cols} rows={data} slimTools rowActions={[{ label: '提前结束', danger: true, describe: (r) => `${r.model || r.code || ''} · ${r.label || '促销价'} · ${r.price}`, warn: '结束以后这条特价马上失效（报价回到档位价），不能恢复，只能重新加一条。要结束的是：', when: (r) => state(r)[0] === '生效中' || state(r)[0] === '还没开始', run: end }]} />
        : <div className="card-b small muted">还没有特价。</div>}
      {f && <Modal title="加一条特价" onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>取消</button><button type="button" className="btn primary" onClick={save}>保存，立即生效</button></>}>
        <FRow label="名称" req><OptChoice optKey="promo_names" title="特价的名称" coded={false} value={f.label} onChange={(v) => set('label', v)} options={NAMES} /></FRow>
        <FRow label="型号" req><Choice value={f.product} onChange={(v) => set('product', v)} flat={false} placeholder="选型号（可搜编码 / 型号 / 种类）" style={{ width: 320 }}
          options={(products || []).map((p) => [p.id, `${p.model} · ${p.category || ''}`, p.code])} /></FRow>
        <FRow label="价格" req><MoneyIn className="in" inputMode="numeric" style={{ width: 130 }} value={f.price} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} /><span className="small muted">XOF / 片</span></FRow>
        <FRow label="起止日期" req><DatePicker range value={f.range} onChange={(v) => set('range', v)} /></FRow>
        <FRow label="给谁" req><Choice value={f.scope} onChange={(v) => set('scope', v)} options={[['all', '所有客户'], ['tier', '指定档位'], ['cust', '指定客户']]} /></FRow>
        {f.scope === 'tier' && <FRow label="档位" req><span className="chips">{Object.entries(TIERS).map(([k, v]) => <button type="button" key={k} className={`chip ${f.tiers.includes(k) ? 'on' : ''}`} onClick={() => set('tiers', f.tiers.includes(k) ? f.tiers.filter((x) => x !== k) : [...f.tiers, k])}>{<TierPill tier={k} />}</button>)}</span></FRow>}
        {f.scope === 'cust' && <FRow label="客户" req>
          <Choice value="" onChange={(v) => v && !f.custs.includes(v) && set('custs', [...f.custs, v])} flat={false} placeholder="＋ 加一个客户" style={{ width: 260 }} options={(custs || []).filter((c) => !f.custs.includes(c.id)).map((c) => [c.id, c.name, c.code])} />
          <span className="chips" style={{ flexBasis: '100%' }}>{f.custs.map((id) => <button type="button" key={id} className="chip on" title="点一下去掉" onClick={() => set('custs', f.custs.filter((x) => x !== id))}>{(custs || []).find((c) => c.id === id)?.name || id} ×</button>)}</span></FRow>}
        <FRow label="原因" req><input className="in" style={{ flex: '1 1 260px', minWidth: 0 }} placeholder="谁定的、为什么给这个价（月度促销 / 老库存 / 滞销…）" value={f.note} onChange={(e) => set('note', e.target.value)} /></FRow>
      </Modal>}
    </div>);
}
