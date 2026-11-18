// 350 (Frank 11-17): 规则参数独立页 —— 系统里所有能调的门槛和开关都在这一页; 改了立即生效、留记录. 只中方.
import React from 'react';
import { useApp, Info } from '../components/ui.jsx';
import { RulesPanel } from '../components/SettingsPanels.jsx';

export default function RulesPage() {
  const { role, go } = useApp();
  if (role !== 'admin') return <div className="card card-b muted">只有中方能看和改规则参数。</div>;
  return (
    <div className="stack">
      <div className="pagehead"><div><div className="eyebrow">Règles</div><h1>规则参数 <Info>每一条都是「数字或开关 + 一句话说明」。改一格存一格，立即生效；谁在什么时候把什么从多少改成多少，都记在操作记录里。清仓价表在「物料与定价」页底部。</Info></h1></div>
        <span className="grow" /><button type="button" className="btn sm" onClick={() => go('pricing')}>清仓价表 ›</button></div>
      <RulesPanel />
    </div>);
}
