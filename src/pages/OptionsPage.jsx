// 选项设置（Frank 11-28）：页签 = 各块；「通用」放几块都用的（城市、联系人身份…）。
// 各块自己的档案页里也有同一张表（员工与工资 → 选项设置），两边是同一份。搜索框 = 总表：搜选项名 / 组名 / 用在哪。
import React, { useState } from 'react';
import { useApp } from '../components/ui.jsx';
import OptionBoard from '../components/OptionBoard.jsx';
import { OPT_HOMES, groupsOf } from '../lib/optRegistry.js';

export default function OptionsPage() {
  const { role } = useApp();
  const [tab, setTab] = useState(() => { try { return sessionStorage.getItem('la9s.opttab') || 'common'; } catch { return 'common'; } });
  const [kw, setKw] = useState('');
  if (role !== 'admin') return <div className="card card-b lock">选项设置只有中方能改。</div>;
  const pick = (k) => { setTab(k); try { sessionStorage.setItem('la9s.opttab', k); } catch { /* 没存上就算了 */ } };
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Options</div><h1>选项设置</h1></div></div>
      <div className="card">
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="tabs">{OPT_HOMES.map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{l} <span className="muted small">{groupsOf(k).length}</span></button>)}</div>
          <span className="grow" />
          <input className="in" style={{ width: 220, maxWidth: '100%' }} placeholder="⌕ 搜选项 / 用在哪" value={kw} onChange={(e) => setKw(e.target.value)} />
        </div>
        <div className="card-b"><OptionBoard home={tab} q={kw} /></div>
      </div>
    </>);
}
