import React, { useMemo, useState } from 'react';
import { useOutside, useApp, TierPill } from './ui.jsx';
import { TIERS, can } from '../lib/domain.js';
import { ProspectModal } from './Crm.jsx';

// one box: type code / name / city; same-name customers in different cities show as separate choices
// Frank 11-09: 潜客也能选 (估价档位报价), 没档案的在这里「＋ 新客户」几秒建一个潜客, 以后到客户档案完善
export default function CustomerSelect({ customers, value, onChange, onlyActive = false, allowCreate = true }) {
  const { role } = useApp() || {};
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(0);
  const ref = useOutside(open, () => setOpen(false));
  const cur = customers.find((c) => c.id === value);
  // 同名提醒 (Frank 11-09: 客户重名充错人): 同名的都标红 + 显示电话, 选之前看清是哪个
  const dupN = useMemo(() => { const m = new Map(); for (const c of customers) { const k = String(c.name || '').trim().toUpperCase(); m.set(k, (m.get(k) || 0) + 1); } return m; }, [customers]);
  const dupOf = (c) => dupN.get(String(c?.name || '').trim().toUpperCase()) || 0;
  const DupPill = ({ c }) => (dupOf(c) > 1 ? <span className="pill red" style={{ marginLeft: 6 }} title="有同名客户，看清编码 / 城市 / 电话">同名 {dupOf(c)} 个</span> : null);
  const list = useMemo(() => {
    const t = text.trim().toUpperCase();
    return customers.filter((c) => (!onlyActive || c.status === 'active') &&
      (!t || [c.code, c.temp_code, c.name, c.city, c.phone].some((x) => String(x || '').toUpperCase().includes(t)) || (/\d{3,}/.test(t) && String(c.phone || '').replace(/\D/g, '').includes(t.replace(/\D/g, '')))))
      .sort((a, b) => (a.status === 'prospect') - (b.status === 'prospect')).slice(0, 40);
  }, [customers, text, onlyActive]);
  const pick = (c) => { onChange(c.id); setOpen(false); setText(''); };
  return (
    <div className="picker" ref={ref} style={{ minWidth: 240 }}>
      <button type="button" className="dp-btn" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setOpen(!open)}>
        {cur ? <span><b>{cur.code || cur.temp_code}</b> · {cur.name} <span className="muted small">{cur.city}{dupOf(cur) > 1 && cur.phone ? ` · ${cur.phone}` : ''}</span><DupPill c={cur} />{cur.status === 'prospect' && <span className="pill amber" style={{ marginLeft: 6 }}>潜客</span>}{cur.supply === 'fob' && <span className="pill blue" style={{ marginLeft: 6 }}>FOB</span>}</span> : <span className="muted">选择客户…</span>}
        {cur && <TierPill tier={cur.tier} suffix={cur.status === 'prospect' ? '（估）' : ''} />}
      </button>
      {open && (
        <div className="sugg" style={{ minWidth: 320 }}>
          <div style={{ padding: 8 }}>
            <input className="in" autoFocus placeholder="⌕ 编码 / 名字 / 城市" value={text} onChange={(e) => { setText(e.target.value); setFocus(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => Math.min(f + 1, list.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => Math.max(f - 1, 0)); }
                if (e.key === 'Enter' && list[focus]) { e.preventDefault(); pick(list[focus]); }
              }} />
          </div>
          {list.map((c, i) => (
            <button type="button" key={c.id} className={i === focus ? 'focus' : ''} style={{ gridTemplateColumns: '60px 1fr auto' }} onMouseEnter={() => setFocus(i)} onClick={() => pick(c)}>
              <span className="mono muted">{c.code || c.temp_code}</span><span><span className="m">{c.name}</span> <span className="muted small">{c.city}{dupOf(c) > 1 && c.phone ? ` · ${c.phone}` : ''}</span><DupPill c={c} />{c.status === 'prospect' && <span className="pill amber" style={{ marginLeft: 6 }}>潜客</span>}</span><TierPill tier={c.tier} />
            </button>
          ))}
          {list.length === 0 && <div className="empty">没有匹配的客户</div>}
          {allowCreate && can(role, 'prospect') && <div style={{ padding: 8, borderTop: '1px solid var(--line-2)' }}><button type="button" className="btn sm primary" style={{ width: '100%' }} onClick={() => { setOpen(false); setCreating(true); }}>＋ 新客户（名字 / 城市 / 市场 / 店铺类型，几秒建好）</button></div>}
        </div>
      )}
      {creating && <ProspectModal onClose={() => setCreating(false)} onDone={(c) => onChange(c.id)} />}
    </div>
  );
}
