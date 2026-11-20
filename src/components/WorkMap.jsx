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

// info(k) → { sub, tone } | null   tone: red / amber / green / gray
export function WorkMap({ value, onChange, info }) {
  const cell = (a, i, arr) => {
    const x = info?.(a.k) || null;
    return (
      <span key={a.k} className="wm-cell">
        <button type="button" className={`wm-step ${value === a.k ? 'on' : ''} ${x?.tone ? 't-' + x.tone : ''}`} onClick={() => onChange(value === a.k ? null : a.k)}>
          <b>{a.l}</b><span>{x?.sub ?? '—'}</span></button>
        {arr === FLOW && i < arr.length - 1 && <i className="wm-arrow" aria-hidden="true">›</i>}
      </span>);
  };
  return (
    <div className="wmap">
      <div className="wm-row wm-flow">{FLOW.map((a, i) => cell(a, i, FLOW))}</div>
      <div className="wm-row wm-other"><span className="wm-lab">流程以外</span>{OTHER.map((a, i) => cell(a, i, OTHER))}</div>
    </div>);
}
