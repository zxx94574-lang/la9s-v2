// 233 / 231 (Frank 11-11): 档位 × 提货量核对 + 新客户等中方定档. 只中方看得到, 放在待办里.
// 参考线 (月提货片数, 可在 org_settings tier_ranges 改): 维修工 0–100 / 零售 100–500 / 批发 500–10,000 / S > 10,000
// 只提醒, 不自动改档位. 中方两个选择: 立即确认 (以后不再提醒) / 先试一段时间 (到期再提醒)
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, Modal, FRow, Info, TierPill, Thumb } from './ui.jsx';
import { CustLink } from './Archives.jsx';
import { TIERS } from '../lib/domain.js';
import { qty, dDate, today, friendlyError } from '../lib/format.js';

export const TIER_RANGES = { REPAIR: [0, 100], RETAIL: [100, 500], WHOLESALE: [500, 10000], S: [10000, null] };
const fits = (tier, m, R) => { const [lo, hi] = R[tier] || [0, null]; return m >= lo && (hi == null || m < hi); };
const suggest = (m, R) => Object.keys(R).find((t) => fits(t, m, R));

export function useTierCheck() {
  const { org, role } = useApp();
  const { data } = useData(async () => {
    if (role !== 'admin') return [];
    const [rows, [set]] = await Promise.all([
      q(`select c.id, c.name, c.code, c.temp_code, c.city, c.status, c.tier, c.shop_type, c.shop_photo, c.created_at, c.tier_confirmed_at, c.tier_confirmed_by, c.tier_review_on, c.tier_note, c.tier_requested_at, c.tier_request_note, c.tier_request_deal, (select biz_no from app.deals rd where rd.id = c.tier_request_deal) as request_biz,
           v.pcs_90, v.pcs_all, v.first_ship_at, exists (select 1 from app.deals d where d.customer_id = c.id and d.status <> 'cancelled') as has_deal
         from app.customers c join app.v_customer_volume v on v.customer_id = c.id where c.org_id = $1 and c.status <> 'inactive' and coalesce(c.kind, 'spare') <> 'recycle'`, [org]).catch(() => []),
      q(`select value from app.org_settings where org_id = $1 and key = 'tier_ranges'`, [org]).catch(() => []),
    ]);
    const R = { ...TIER_RANGES, ...(set?.value || {}) }; const td = today(); const out = [];
    for (const c of rows) {
      const days = c.first_ship_at ? (Date.now() - new Date(c.first_ship_at).getTime()) / 864e5 : 0;
      const monthly = Math.round(Number(c.pcs_90) / Math.max(1, Math.min(3, days / 30)));
      const base = { ...c, monthly, sug: suggest(monthly, R) };
      // 没定过档的: 只提醒最近 30 天新建的、或者已经有单的 (老的潜客名单不刷屏)
      if (!c.tier_confirmed_at) { if (c.tier_requested_at) out.push({ ...base, why: 'new', text: `申请定级${c.request_biz ? `（订单 ${c.request_biz} 等着发给客户）` : ''}${c.tier_request_note ? '：' + c.tier_request_note : ''} · 现在按最贵档 Repair 报价` }); continue; }
      else if (c.tier_review_on && dDate(c.tier_review_on) <= td) out.push({ ...base, why: 'review', text: `试用期到了：月均提货 ${qty(monthly)} 片` });
      else if (!c.tier_confirmed_by && !c.tier_review_on && c.tier && days >= 30 && !fits(c.tier, monthly, R)) {
        out.push({ ...base, why: 'mismatch', text: `月均提货 ${qty(monthly)} 片，${monthly < R[c.tier][0] ? '低于' : '高于'}「${TIERS[c.tier]}」的参考线` });
      }
    }
    return out.sort((a, b) => (a.why === 'new' ? 0 : 1) - (b.why === 'new' ? 0 : 1));
  }, [org, role]);
  return data || [];
}

export default function TierCheck({ rows }) {
  const [act, setAct] = useState(null);
  if (!rows.length) return null;
  return (
    <div className="card todo-sec todo-red" style={{ marginBottom: 12 }}>
      <div className="card-h"><h2><span className="pill red">档位要确认</span> {rows.length} 个客户 <Info>参考线（月提货片数）：维修工 0–100、零售 100–500、批发 500–10,000、S 档 10,000 以上，按最近 3 个月的月均算。只提醒，不会自动改档位。</Info></h2></div>
      {rows.map((c) => (
        <div key={c.id} className="row between todo-row" style={{ cursor: 'default' }}>
          <div className="stack" style={{ gap: 3, minWidth: 0 }}>
            <div><CustLink id={c.id} name={c.name} /> <span className="muted small">{c.city} · {c.code || c.temp_code || '潜客'}</span> <TierPill tier={c.tier} />{c.shop_type && <span className="pill gray" style={{ marginLeft: 6 }}>员工填：{c.shop_type}</span>}</div>
            <div className="small">{c.why === 'mismatch' ? '⚠ ' : '👉 '}{c.text}{c.sug && c.sug !== c.tier && c.why !== 'new' && <span className="muted">（按提货量对应「{TIERS[c.sug]}」）</span>}</div>
          </div>
          <div className="row" style={{ flexShrink: 0 }}>{c.shop_photo && <Thumb src={c.shop_photo} size={34} label="店铺照片" />}<button type="button" className="btn sm primary" onClick={() => setAct(c)}>定档位</button></div>
        </div>))}
      {act && <TierModal c={act} onClose={() => setAct(null)} />}
    </div>
  );
}

function TierModal({ c, onClose }) {
  const { role, toast, refresh } = useApp();
  const [tier, setTier] = useState(c.tier || 'REPAIR'); const [mode, setMode] = useState(''); const [months, setMonths] = useState('2'); const [note, setNote] = useState('');
  const go = async () => { try { await call(role, `select app.confirm_customer_tier($1,$2,$3,$4,$5)`, [c.id, tier, mode, Number(months) || 2, note || null]); toast(mode === 'trial' ? `已定为 ${TIERS[tier]}，${months} 个月后再提醒` : `已确认 ${TIERS[tier]}，以后不再提醒`); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title={`定档位 · ${c.name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />{!mode && <span className="why">选 立即确认 / 先试一段时间</span>}<button type="button" className="btn primary" disabled={!mode} onClick={go}>确定</button></>}>
      <div className="stack">
        <div className="kv">
          <div><div className="k">最近 3 个月月均提货</div><div className="v">{qty(c.monthly)} 片</div></div>
          <div><div className="k">累计提货</div><div className="v">{qty(c.pcs_all)} 片</div></div>
          <div><div className="k">员工填的店铺类型</div><div className="v" style={{ fontSize: 15 }}>{c.shop_type || '—'}</div></div>
          <div><div className="k">店铺照片</div><div className="v">{c.shop_photo ? <Thumb src={c.shop_photo} size={64} label="店铺照片" /> : <span className="muted small">没传</span>}</div></div>
        </div>
        <FRow label="档位" req><div className="chips">{Object.entries(TIERS).map(([k, v]) => <button type="button" key={k} className={`chip ${tier === k ? 'on' : ''}`} onClick={() => setTier(k)}>{v}</button>)}</div></FRow>
        <FRow label="怎么确认" req><div className="chips">
          <button type="button" className={`chip ${mode === 'confirm' ? 'on' : ''}`} onClick={() => setMode('confirm')}>立即确认（以后不再提醒）</button>
          <button type="button" className={`chip ${mode === 'trial' ? 'on' : ''}`} onClick={() => setMode('trial')}>先用这个档位试一段时间</button></div></FRow>
        {mode === 'trial' && <FRow label="试多久"><input className="in sm" style={{ width: 60 }} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} /> 个月，到期提货量还对不上就再提醒</FRow>}
        <FRow label="备注"><input className="in" style={{ width: '100%', maxWidth: 420 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如 提供资源的特殊客户" /></FRow>
      </div>
    </Modal>
  );
}
