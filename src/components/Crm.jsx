// 客户档案 / 热线回访 / 销售拜访 shared pieces (Frank 2026-10-29).
// 回访结果用选项不手打; 下次跟进日期一键 (明天 / 3 天 / 一周 / 自选); 新潜客自动临时编码.
import React, { useState } from 'react';
import { call, q } from '../db/client.js';
import { useApp, Modal, Pill, PhotoInput, DatePicker , PhoneInput} from './ui.jsx';
import { friendlyError, ymd } from '../lib/format.js';

export const CALL_RESULTS = [['order', '下单', 'green'], ['quote', '要报价', 'blue'], ['later', '以后再要', 'amber'], ['no_need', '暂不需要', 'gray'],
  ['no_answer', '没接', 'red'], ['busy', '忙 / 改天', 'amber'], ['other', '其他', 'gray']];
export const VISIT_RESULTS = [['order', '当场下单', 'green'], ['quote', '要报价', 'blue'], ['interested', '有兴趣', 'blue'], ['later', '以后再说', 'amber'], ['not_interested', '没兴趣', 'gray']];
export const CHANNELS = [['call', '电话'], ['whatsapp', 'WhatsApp'], ['visit', '上门']];
export const KIND = { spare: '备件', recycle: '回收', both: '备件 + 回收' };
export const RECYCLE_TYPES = ['Techniciens', 'Wholesale Shop', 'Recycleurs'];
const lab = (list, k) => list.find((x) => x[0] === k) || [k, k, 'gray'];
export const ResultPill = ({ v, visit }) => { const [, l, tone] = lab(visit ? VISIT_RESULTS : CALL_RESULTS, v); return <Pill tone={tone}>{l}</Pill>; };
export const custLabel = (c) => `${c.code || c.temp_code || ''} ${c.name}${c.city ? ' · ' + c.city : ''}`.trim();

const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

export function FollowDate({ value, onChange }) {
  const opts = [['', '不用跟'], [plusDays(1), '明天'], [plusDays(3), '3 天后'], [plusDays(7), '一周后'], [plusDays(30), '一个月后']];
  const preset = opts.some(([v]) => v === (value || ''));
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <div className="chips">{opts.map(([v, l]) => <button type="button" key={l} className={`chip ${(value || '') === v ? 'on' : ''}`} onClick={() => onChange(v)}>{l}</button>)}</div>
      <DatePicker value={!preset && value ? value : plusDays(14)} onChange={onChange} label={!preset && value ? '' : '自选'} />
    </div>
  );
}

// 记一次回访 (热线 / 销售 / 主管)
export function CallModal({ customer, onClose, onDone }) {
  const { role, toast, refresh } = useApp();
  const [f, setF] = useState({ line: customer.kind === 'recycle' ? 'recycle' : 'spare', channel: 'call', result: '', note: '', next: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const needNext = ['no_answer', 'busy', 'later', 'quote'].includes(f.result);
  const save = async () => {
    if (f.result === 'other' && !String(f.note || '').trim()) return toast('结果选了「其他」，备注里写清楚是什么', 'err');
    try {
      await call(role, `select app.log_call($1,$2,$3,$4,$5,$6)`, [customer.id, f.line, f.channel, f.result, f.note, f.next || null]);
      toast(`已记录：${custLabel(customer)} · ${lab(CALL_RESULTS, f.result)[1]}`); refresh(); onDone?.(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`回访 · ${custLabel(customer)}`} onClose={onClose}
      footer={<><span className="small muted">{customer.phone}</span><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!f.result} onClick={save}>保存</button></>}>
      <div className="stack">
        {customer.kind === 'both' && <div className="field"><label>回访线</label><div className="seg">{[['spare', '备件'], ['recycle', '回收']].map(([v, l]) =>
          <button type="button" key={v} className={f.line === v ? 'on' : ''} onClick={() => set('line')(v)}>{l}</button>)}</div></div>}
        <div className="field"><label>方式</label><div className="seg">{CHANNELS.map(([v, l]) => <button type="button" key={v} className={f.channel === v ? 'on' : ''} onClick={() => set('channel')(v)}>{l}</button>)}</div></div>
        <div className="field req"><label>结果</label><div className="chips">{CALL_RESULTS.map(([v, l]) =>
          <button type="button" key={v} className={`chip ${f.result === v ? 'on' : ''}`} onClick={() => set('result')(v)}>{l}</button>)}</div></div>
        {f.result === 'order' && <div className="hint">客户要下单：保存后去「新建询单 / 报价」开单，单子会跟这个客户挂在一起。</div>}
        <div className="field"><label>说明（要什么型号、多少、为什么不要）</label><input className="in" value={f.note} onChange={(e) => set('note')(e.target.value)} placeholder="例：要 BG6M 盖子 20 个 / 嫌价格高" /></div>
        <div className="field"><label>下次跟进{needNext && <span className="muted small">（建议填）</span>}</label><FollowDate value={f.next} onChange={set('next')} /></div>
      </div>
    </Modal>
  );
}

// 新潜客 (热线 / 销售): 店名 + 电话必填, 自动临时编码 T-…
export function ProspectModal({ onClose, onDone, kind = 'spare' }) {
  const { org, role, toast, refresh } = useApp();
  const [f, setF] = useState({ name: '', phone: '', city: '', market: '', shop_type: '', kind });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target ? e.target.value : e }));
  const save = async () => {
    try {
      const [{ id }] = await call(role, `select app.create_prospect($1,$2,$3,$4,$5) as id`, [org, f.name, f.phone || '', f.city,
        JSON.stringify({ market: f.market || null, shop_type: f.shop_type || null, kind: f.kind, source: 'hotline' })]);
      const [c] = await q(`select id, code, temp_code, name, city, phone, kind, tier, status from app.customers where id = $1`, [id]);
      toast(`已建潜客 ${c.temp_code} ${c.name}`); refresh(); onDone?.(c); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title="新潜客" onClose={onClose}
      footer={<><span className="small muted">保存后自动给临时编码 T-…，转正式编码和定档位归中方</span><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={!f.name.trim()} onClick={save}>建档</button></>}>
      <div className="grid2">
        <div className="field req"><label>客户名（人名 / 店名）</label><input className="in" autoFocus value={f.name} onChange={set('name')} /></div>
        <div className="field"><label>电话（可以先不填）</label><PhoneInput value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} /></div>
        <div className="field"><label>城市 / 区</label><input className="in" value={f.city} onChange={set('city')} placeholder="Adjamé / Yopougon …" /></div>
        <div className="field"><label>市场</label><input className="in" value={f.market} onChange={set('market')} placeholder="Roxy / Siporex …" /></div>
        <div className="field"><label>客户类型</label><div className="seg">{Object.entries(KIND).map(([v, l]) => <button type="button" key={v} className={f.kind === v ? 'on' : ''} onClick={() => set('kind')(v)}>{l}</button>)}</div></div>
        <div className="field"><label>店铺类型（决定估价档位）</label><div className="chips">{[['WHOLESALE', '批发店 → Wholesale 档'], ['RETAIL', '零售店 → Retail 档'], ['REPAIR', '维修店 → Repair 档']].map(([v, l]) =>
          <button type="button" key={v} className={`chip ${f.shop_type === v ? 'on' : ''}`} onClick={() => set('shop_type')(f.shop_type === v ? '' : v)}>{l}</button>)}</div>
          <span className="hint">选了店铺类型就能按对应档位报价；没选就是没档位，报价前要中方给。转正式编码、定正式档位还是在客户档案里。</span></div>
      </div>
    </Modal>
  );
}
