// 0082 国内财务 (483 / 484): 每张采购单 (入仓号) 一行 —— 货款应付 / 已付 / 没付, 运费; 在行上记付款 (要凭证);
// 运费记进这批货的成本 (按件分摊, 和档案里「批次运费」同一个算法). 右上角放科特汇回国内的总额对着看.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Pill, Modal, Info, DatePicker, PhotoInput, MoneyIn, Choice } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { PoLink } from './Po.jsx';
import { money, qty, dDate, today, friendlyError } from '../lib/format.js';

const N = (v) => Number(v || 0);

export default function CnFinance() {
  const { org, tick } = useApp();
  const [pay, setPay] = useState(null);
  const { data } = useData(async () => {
    const [rows, remit, rates, avg] = await Promise.all([
      q(`select * from app.v_po_ledger where org_id = $1 order by coalesce(shipped_on, eta) desc nulls last, po_no`, [org]),
      q(`select currency, count(*)::int as n, sum(expected) as amt from app.remittances where org_id = $1 and status <> 'void' group by currency order by currency`, [org]).catch(() => []),
      q(`select po_id, sum(amount * xof_per_unit) / nullif(sum(amount), 0) as rate, bool_or(xof_per_unit is null) as some_blank from app.po_payments where org_id = $1 and kind = 'goods' group by po_id`, [org]).catch(() => []),
      q(`select sum(amount_out) / nullif(sum(expected), 0) as r from app.remittances where org_id = $1 and currency = 'CNY' and status <> 'void' and on_date >= current_date - 30`, [org]).catch(() => []),
    ]);
    return { rows: rows.map((r) => ({ ...r, ...(rates.find((x) => x.po_id === r.id) ? { pay_rate: rates.find((x) => x.po_id === r.id).rate, rate_blank: rates.find((x) => x.po_id === r.id).some_blank } : {}) })), remit, avgRate: Number(avg?.[0]?.r) || null };
  }, [org, tick]);
  if (!data) return <div className="empty">加载中…</div>;
  const { rows, remit, avgRate } = data;
  const goods = rows.reduce((a, r) => a + N(r.goods_cny), 0), paid = rows.reduce((a, r) => a + N(r.paid_cny), 0);
  const owe = rows.filter((r) => N(r.goods_cny) > N(r.paid_cny) + 0.5);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Finance Chine</div><h1>国内财务 <Info>每张采购单（入仓号）一行：货款应付多少、付了多少、还差多少，运费付了多少。付一笔就在那一行点「记付款」，要传银行回单或转账截图。运费记完自动按件分摊进这批货的成本。科特汇回国内的钱在右边对总数。</Info></h1></div></div>
      <div className="card">
        <div className="bigsum">
          <div><div className="k">货款应付（{rows.length} 张单）</div><div className="v">{money(goods, 'CNY')} <small>CNY</small></div></div>
          <div><div className="k">已付</div><div className="v">{money(paid, 'CNY')} <small>CNY</small></div></div>
          <div><div className="k">还没付</div><div className="v">{money(Math.max(0, goods - paid), 'CNY')} <small>CNY</small></div>{owe.length > 0 && <div><span className="pill red">{owe.length} 张单没付清</span></div>}</div>
          <div><div className="k">科特已汇回国内</div>{remit.length ? remit.map((x) => <div key={x.currency} className="v">{money(x.amt, x.currency)} <small>{x.currency} · {x.n} 笔</small></div>) : <div className="v muted">—</div>}</div>
        </div>
      </div>
      <div className="card">
        <Grid id="cn-po-ledger" rows={rows} empty="还没有采购单" rowActions={[{ label: '记付款', tone: 'primary', run: (r) => setPay(r) }]} columns={[
          { key: 'po_no', label: '采购单', w: 150, value: (r) => r.po_no, render: (r) => <PoLink id={r.id} no={r.po_no} /> },
          { key: 'inbound', label: '入仓号', w: 120, value: (r) => (r.warehouse_nos || []).join(' / ') },
          { key: 'purpose', label: '用途', w: 80, value: (r) => ({ local: '本地', fob: 'FOB', mixed: '混装' })[r.purpose] || '—' },
          { key: 'shipped_on', label: '发货', w: 100, value: (r) => dDate(r.shipped_on) },
          { key: 'pcs', label: '片数', w: 80, value: (r) => N(r.pcs), render: (r) => <>{qty(r.pcs)}{N(r.pcs_received) > 0 && <span className="small muted"> · 到 {qty(r.pcs_received)}</span>}</> },
          { key: 'goods_cny', label: '货款应付 CNY', w: 120, value: (r) => N(r.goods_cny), render: (r) => <>{money(r.goods_cny, 'CNY')}{N(r.unpriced) > 0 && <Pill tone="amber">{r.unpriced} 行没单价</Pill>}</> },
          { key: 'paid_cny', label: '已付 CNY', w: 110, value: (r) => N(r.paid_cny), render: (r) => money(r.paid_cny, 'CNY') },
          { key: 'due', label: '还差', w: 120, value: (r) => N(r.goods_cny) - N(r.paid_cny), render: (r) => { const d = N(r.goods_cny) - N(r.paid_cny); return d > 0.5 ? <Pill tone="red">差 {money(d, 'CNY')}</Pill> : d < -0.5 ? <Pill tone="amber">多付 {money(-d, 'CNY')}</Pill> : N(r.goods_cny) > 0 ? <Pill tone="green">付清</Pill> : ''; } },
          { key: 'pay_rate', label: '付款汇率', w: 120, value: (r) => N(r.pay_rate) || null, render: (r) => (N(r.paid_cny) <= 0 ? '' : N(r.pay_rate) > 0 ? <span title="1 CNY = ? 西法；这张单批次的成本按它算">{N(r.pay_rate).toFixed(2)}{r.rate_blank && <Pill tone="amber">有几笔没填</Pill>}</span> : <Pill tone="amber" title="付了货款但没填汇率：这批货的成本只能按现在的定价汇率估">没填</Pill>) },
          { key: 'freight_xof', label: '运费（折西法）', w: 120, value: (r) => N(r.freight_xof), render: (r) => (N(r.freight_xof) ? money(r.freight_xof) : <span className="muted">没记</span>) },
          { key: 'last_paid', label: '最近付款', w: 100, fill: true, value: (r) => dDate(r.last_paid) },
        ]} />
      </div>
      {pay && <PayPo po={pay} avgRate={avgRate} onClose={() => setPay(null)} />}
    </>
  );
}

function PayPo({ po, avgRate, onClose }) {
  const { role, toast, refresh } = useApp();
  const due = Math.max(0, N(po.goods_cny) - N(po.paid_cny));
  const [v, setV] = useState({ kind: due > 0 ? 'goods' : 'freight', amount: due > 0 ? String(due) : '', currency: 'CNY', xof_per_unit: due > 0 && avgRate ? String(Math.round(avgRate * 100) / 100) : '', on_date: today(), proof: '', note: '' });
  const set = (k) => (x) => setV((y) => ({ ...y, [k]: x }));
  const needRate = v.kind === 'freight' && v.currency !== 'XOF';
  const ok = Number(v.amount) > 0 && v.proof && (!needRate || Number(v.xof_per_unit) > 0);
  const go = async () => { try { await call(role, `select app.record_po_payment($1,$2)`, [po.id, JSON.stringify(v)]); toast(v.kind === 'freight' ? '已记运费，这批货的成本已更新' : '已记货款'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`记付款 · ${po.po_no}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={!ok} onClick={go}>保存</button></>}>
      <div className="stack">
        <div className="field req"><label>付的是</label><Choice value={v.kind} onChange={set('kind')} flat options={[['goods', '货款（付工厂）'], ['freight', '运费（付货代）']]} /></div>
        <div className="grid2">
          <div className="field req"><label>金额</label><MoneyIn className="in" inputMode="decimal" value={v.amount} onChange={(e) => set('amount')(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          <div className="field req"><label>币种</label><Choice value={v.currency} onChange={set('currency')} flat options={[['CNY', 'CNY'], ['USD', 'USD'], ['XOF', 'XOF']]} /></div>
        </div>
        <div className="grid2">
          {v.currency !== 'XOF' && <div className={`field ${needRate ? 'req' : ''}`}><label>汇率：1 {v.currency} = ? 西法{v.kind === 'goods' && <span className="small muted">（填了，这批货的成本就按它算；默认 = 最近 30 天科特汇回的平均汇率）</span>}</label><input className="in" inputMode="decimal" value={v.xof_per_unit} onChange={(e) => set('xof_per_unit')(e.target.value.replace(/[^\d.]/g, ''))} placeholder={v.currency === 'CNY' ? '例 85' : '例 600'} /></div>}
          <div className="field"><label>付款日期</label><DatePicker value={v.on_date} onChange={set('on_date')} /></div>
        </div>
        <div className="field req"><label>凭证（银行回单 / 转账截图）</label><PhotoInput value={v.proof} onChange={set('proof')} /></div>
        <div className="field"><label>备注</label><input className="in" value={v.note} onChange={(e) => set('note')(e.target.value)} /></div>
        {v.kind === 'freight' && <div className="hint">运费记完：这张单所有运费合计 ÷ 总片数 = 每片运费（向上进 50），直接进这批货的到岸成本。</div>}
      </div>
    </Modal>);
}
