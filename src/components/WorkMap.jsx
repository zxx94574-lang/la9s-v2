import React from 'react';
// 工作地图 (Frank 11-20): 「规则参数」「时效与准确率」… 凡是按业务环节分的页面, 顶上都用这一条.
// 上面一排 = 订单流程 (询单 → 报价·确认 → … → 收款), 和订单页的流程条同一套环节;
// 下面一排 = 流程以外的日常工作 (热线回访 / 客户拜访 / 资金 / 采购 / 打卡工资 / 指令 / 客户定价 / 系统).
// 每个环节下面显示一行小字 (几条规则 / 达标率…), 点一下 = 只看这个环节, 再点一下 = 看全部.
export const FLOW = [
  { k: 'inq', l: '询单', page: 'inquiry' },
  { k: 'quote', l: '报价·确认', step: 'quote' },
  { k: 'pick', l: '找货·初检', step: 'pick' },
  { k: 'so', l: '销售单·确认', step: 'so' },
  { k: 'ship', l: '复检·出库', step: 'ship' },
  { k: 'sign', l: '签收·对账', step: 'sign' },
  { k: 'pay', l: '收款', step: 'pay' },
];
export const OTHER = [
  { k: 'hotline', l: '热线回访', page: 'hotline' },
  { k: 'visit', l: '客户拜访', page: 'visits' },
  { k: 'cust', l: '客户·定价', page: 'customers' },
  { k: 'cash', l: '资金·回款', page: 'cash' },
  { k: 'po', l: '采购·到货', page: 'po' },
  { k: 'staff', l: '打卡·工资·提成', page: 'staff' },
  { k: 'dir', l: '指令·任务', page: 'todo' },
  { k: 'sys', l: '系统', page: null },
];
export const AREAS = [...FLOW, ...OTHER];
export const AREA = Object.fromEntries(AREAS.map((a) => [a.k, a]));

// 跳到这个环节: 流程里的 → 订单总览只看「现在卡在这一步」的单; 流程外的 → 对应页面
export function goArea(k, go) {
  const a = AREA[k]; if (!a) return;
  if (a.step) { try { sessionStorage.setItem('la9s.orders.jump', JSON.stringify({ step: a.step })); } catch { /* */ } go('orders'); return; }
  if (a.page) go(a.page);
}

// info(k) → { val, sub, tone } | null   tone: red / amber / green / gray
// 474 (Frank 11-20): 和订单页流程条同一个样子 —— 流程里的环节 = 圆圈 + 连线, 流程以外 = 圆圈不连线;
// 圆圈里 = 这一环节的主数 (时效页: 主指标, 绿黄红; 规则参数页: 几条规则, 灰), 圆圈下 = 名字 + 一行小字.
export function WorkMap({ value, onChange, info }) {
  const node = (a, line) => {
    const x = info?.(a.k) || null;
    return (
      <React.Fragment key={a.k}>
        <button type="button" className={`wm-node ${value === a.k ? 'on' : ''} t-${x?.tone || 'gray'}`} onClick={() => onChange(value === a.k ? null : a.k)} title={x?.sub || ''}>
          <span className="wm-dot">{x?.val ?? '—'}</span><b>{a.l}</b>{x?.sub && <span className="wm-sub">{x.sub}</span>}</button>
        {line && <i className="wm-line" aria-hidden="true" />}
      </React.Fragment>);
  };
  return (
    <div className="wmap">
      <div className="wm-row wm-flow">{FLOW.map((a, i) => node(a, i < FLOW.length - 1))}</div>
      <div className="wm-row wm-other"><span className="wm-lab">流程以外</span>{OTHER.map((a) => node(a, false))}</div>
    </div>);
}
