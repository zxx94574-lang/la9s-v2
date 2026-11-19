// 350 → 11-19 Frank: 规则参数分散到各页的 ⚙ 里改, 这一页只是总表 + 跳转. 只中方.
import React from 'react';
import { useApp, Info } from '../components/ui.jsx';
import { RulesIndex } from '../components/Rules.jsx';

export default function RulesPage() {
  const { role, go } = useApp();
  if (role !== 'admin') return <div className="card card-b muted">只有中方能看和改规则参数。</div>;
  return (
    <div className="stack">
      <div className="pagehead"><div><div className="eyebrow">Règles</div><h1>规则参数 <Info>总表：每条规则都在用到它的那一页旁边的 ⚙ 里改（例：时效目标在「时效与准确率」）。这里按「在哪里设置」分组列出现在的值，点一行就跳过去、自动打开那里的 ⚙。只在订单某一步用到的（必抽检、签收时限、抹零），没有固定页面，就在这里直接改。</Info></h1></div>
        <span className="grow" /><button type="button" className="btn sm" onClick={() => go('pricing')}>特价表（促销价）›</button></div>
      <RulesIndex />
    </div>);
}
