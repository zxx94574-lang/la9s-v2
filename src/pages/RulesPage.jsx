// 350 → 11-19 Frank: 规则参数分散到各页的 ⚙ 里改, 这一页只是总表 + 跳转. 只中方.
import React from 'react';
import { useApp, Info } from '../components/ui.jsx';
import { RulesIndex } from '../components/Rules.jsx';

export default function RulesPage() {
  const { role, go } = useApp();
  if (role !== 'admin') return <div className="card card-b muted">只有中方能看和改规则参数。</div>;
  return (
    <div className="stack">
      <div className="pagehead"><div><div className="eyebrow">Règles</div><h1>规则参数 <Info>全公司所有阈值、开关、权限表、发货文件都在这里。顶上一排是订单流程，第二排是流程以外的日常工作；点一个环节只看它的规则。值直接在这里改，改一格存一格、立即生效；用到它的页面旁边的 ⚙ 改的是同一个数。每条右边的 i 看三句：从哪来、作用在哪、触发后怎样；蓝色 ! = Claude 先定的、你还没拍板。</Info></h1></div>
        <span className="grow" /><button type="button" className="btn sm" onClick={() => go('pricing')}>特价表（促销价）›</button></div>
      <RulesIndex />
    </div>);
}
