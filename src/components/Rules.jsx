// 规则参数分散到用到它的地方 (Frank 11-19 13:42):
//   每条规则在「用到它的那一页 / 那一步」旁边一个小 ⚙ 就地改 (只中方); 「规则参数」总页只是总表 + 跳转, 不用翻.
//   同一条规则可以出现在几处 (例: 指令几分钟收到 → 时效页 + 待办指令板块), 改的是同一个数.
//   home = 主位置: page = 页面路由 (总表「去设置 ›」跳过去并自动打开那里的 ⚙); step = 在每张订单的某一步 (没有固定页面, 总表里就地改).
import React, { useEffect, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, MoneyIn, usePopBus, useOutside, Info, Assumed } from './ui.jsx';
import { WorkMap, AREAS, AREA, goArea } from './WorkMap.jsx';
import { PermPanel, ExportPanel, DocSettings } from './SettingsPanels.jsx';
import { IconLibrary } from './Icons.jsx';
import { ITEMS as NAV_ITEMS } from './Nav.jsx';
import { friendlyError } from '../lib/format.js';

// [id, 存在 org_settings 的 key, 字段, 说明, 默认值, 单位, 类型 num|bool|text, home]
export const RULES = [
  ['kpi.s0', 'kpi_targets', 's0', '时效目标：建报价 → 联系上客户确认', 30, '分钟', 'num', { page: 'kpi', anchor: 'kpi-targets', where: '时效与准确率 · 每一步用了多久' }],
  ['kpi.s1', 'kpi_targets', 's1', '时效目标：下推找货 → 初检完成', 120, '分钟', 'num', { page: 'kpi', anchor: 'kpi-targets', where: '时效与准确率 · 每一步用了多久' }],
  ['kpi.s2', 'kpi_targets', 's2', '时效目标：初检完 → 出销售单', 30, '分钟', 'num', { page: 'kpi', anchor: 'kpi-targets', where: '时效与准确率 · 每一步用了多久' }],
  ['kpi.s4', 'kpi_targets', 's4', '时效目标：客户确认 → 复检打包完', 60, '分钟', 'num', { page: 'kpi', anchor: 'kpi-targets', where: '时效与准确率 · 每一步用了多久' }],
  ['kpi.s5', 'kpi_targets', 's5', '时效目标：打包完 → 出库', 60, '分钟', 'num', { page: 'kpi', anchor: 'kpi-targets', where: '时效与准确率 · 每一步用了多久' }],
  ['dir.ack', 'directive_rules', 'ack_minutes', '指令：下达后几分钟内必须点「收到」', 5, '分钟', 'num', { page: 'kpi', anchor: 'kpi-dir', where: '时效与准确率 · 中方指令' }],
  ['wh.comm', 'wh_commission', 'per_piece', '仓库提成：正确出货每片多少', 5, 'XOF', 'num', { page: 'kpi', anchor: 'kpi-wh', where: '时效与准确率 · 仓库提成' }],
  ['sales.comm', 'sales_comm', 'per_piece', '销售提成：每片多少钱（整单付清才算，自动带进工资单）', 17, 'XOF / 片', 'num', { page: 'kpi', anchor: 'sales-comm', where: '时效与准确率 · 销售提成' }],
  ['check.qty', 'check_rules', 'qty', '复检必抽检：一行数量超过多少片', 100, '片', 'num', { step: '每张单的「复检 + 打包」' }],
  ['check.price', 'check_rules', 'price', '复检必抽检：单价超过多少', 5000, 'XOF', 'num', { step: '每张单的「复检 + 打包」' }],
  ['check.total', 'check_rules', 'total', '复检必抽检：一行总价超过多少', 500000, 'XOF', 'num', { step: '每张单的「复检 + 打包」' }],
  ['disc.hours', 'discrepancy_window', 'hours', '收货差异 / 损坏退货：签收后多少小时内反馈算正常', 24, '小时', 'num', { step: '每张单的「客户签收」' }],
  ['wo.max', 'writeoff_rules', 'max_xof', '抹零：一张单最多抹多少', 100, 'XOF', 'num', { step: '每张单的「收款」' }],
  ['draft.lines', 'draft_rules', 'min_lines', '草稿：选了客户、填够几行才自动存', 5, '行', 'num', { page: 'orders', anchor: 'orders-drafts', where: '订单总览 · 草稿' }],
  ['draft.days', 'draft_rules', 'days', '草稿：几天没人动自动删', 7, '天', 'num', { page: 'orders', anchor: 'orders-drafts', where: '订单总览 · 草稿' }],
  ['po.eta_days', 'po_rules', 'eta_days', '采购单：预计到港前几天开始提醒仓库 / 国内采购', 7, '天', 'num', { page: 'po', where: '采购单与到货' }],
  ['want.days', 'want_rules', 'days', '想要：登记后几天还没到货就失效', 14, '天', 'num', { page: 'unmet', anchor: 'wants', where: '未满足需求 · 想要' }],
  ['price.warn', 'price_rules', 'warn_pct', '改价：单价偏离档位价超过多少标黄（要留意）', 5, '%', 'num', { page: 'pricing', anchor: 'pricing-rules', where: '物料与定价' }],
  ['price.odd', 'price_rules', 'odd_pct', '改价：单价偏离客户档位价超过多少算「异价单」', 10, '%', 'num', { page: 'pricing', anchor: 'pricing-rules', where: '物料与定价' }],
  ['bl.amount', 'bl_suggest', 'amount', '大单建议打印 BL：金额到多少', 1000000, 'XOF', 'num', { step: '每张单的「复检 + 打包」' }],
  ['bl.qty', 'bl_suggest', 'qty', '大单建议打印 BL：件数到多少', 500, '片', 'num', { step: '每张单的「复检 + 打包」' }],
  ['price.cny', 'price_rules', 'cny_only_s', '人民币报价只给 S 档客户（中方可以单张破例）', true, '', 'bool', { page: 'pricing', anchor: 'pricing-rules', where: '物料与定价' }],
  ['margin.low', 'margin_rules', 'low_pct', '毛利：毛利率低于多少标黄（要留意）；负数一律标红', 10, '%', 'num', { page: 'margin', anchor: 'margin-rules', where: '毛利分析' }],
  ['loss.on', 'loss_rules', 'on', '卖价低于到岸成本 → 这张单推不下去，中方批准 + 写原因才放行（亏钱拦截）', true, '', 'bool', { page: 'margin', anchor: 'margin-rules', where: '毛利分析' }],
  ['loss.nocost', 'loss_rules', 'no_cost', '有型号没有成本（算不出亏不亏）→ 也要中方批（默认关：没成本的编码还多）', false, '', 'bool', { page: 'margin', anchor: 'margin-rules', where: '毛利分析' }],
  ['credit.on', 'credit_gate', 'on', '出库那一刻客户超欠款上限 / 超账期 → 不能出库，中方在订单上放行 + 写原因', true, '', 'bool', { page: 'customers', anchor: 'cust-rules', where: '客户档案' }],
  ['rep.on', 'rep_debt_rules', 'on', '销售员名下有隔天没收回的欠款 → 他名下所有客户暂不出货（中方可对单放行）', true, '', 'bool', { page: 'customers', anchor: 'cust-rules', where: '客户档案' }],
  ['vol.pct', 'volume_shift', 'pct', '客户提货量月对比：涨跌超过多少算变化大', 50, '%', 'num', { page: 'customers', anchor: 'cust-rules', where: '客户档案' }],
  ['cash.held', 'cash_rules', 'held_days', '员工代收：钱在员工手上超过几天没交就进紧急', 1, '天', 'num', { page: 'cash', anchor: 'cash-rules', where: '资金账户' }],
  ['freight.acct', 'freight_rules', 'account', '我们出的运费记在哪个账户', 'Wave-XOF', '', 'text', { page: 'cash', anchor: 'cash-rules', where: '资金账户' }],
  ['remit.diff', 'remit_rules', 'diff_pct', '回款：实际到账比应到差多少要标红、核对时必须写原因', 2, '%', 'num', { page: 'cash', anchor: 'remit-rules', where: '资金账户 · 回款（汇回国内）' }],
  ['remit.days', 'remit_rules', 'transit_days', '回款：交出去几天还没到账要提醒', 3, '天', 'num', { page: 'cash', anchor: 'remit-rules', where: '资金账户 · 回款（汇回国内）' }],
];
const BY_ID = Object.fromEntries(RULES.map((r) => [r[0], r]));
// 每条规则在「工作地图」上的位置 + 三句说明 (Frank 11-20: 一眼知道从哪来、作用在哪、触发后怎样)
// area = WorkMap 的环节; short = 一行里显示的短名字; src / apply / effect = 悬停小图标看到的三行; me = Claude 先定的、Frank 没拍板
export const META = {
  'price.warn': { area: 'quote', short: '改价偏离 · 标黄', src: '物料档位价', apply: '建报价、改价时每一行', effect: '格子里标黄，只提醒', me: 1 },
  'price.odd': { area: 'quote', short: '改价偏离 · 异价单', src: '物料档位价', apply: '建报价、改价时每一行', effect: '标红 + 订单打「异价单」，员工改价要中方批' },
  'price.cny': { area: 'quote', short: '人民币报价只给 S 档', src: 'Frank 11-18 定', apply: '建报价选人民币时', effect: '非 S 档客户不让选，中方可单张破例' },
  'draft.lines': { area: 'quote', short: '草稿自动存 · 至少几行', src: '新订单页', apply: '选了客户、填够这么多行', effect: '自动存成草稿' },
  'draft.days': { area: 'quote', short: '草稿几天没动自动删', src: '订单总览 · 草稿', apply: '所有草稿', effect: '到天数自动删掉' },
  'po.eta_days': { area: 'po', short: '到港前几天提醒', src: '采购单预计到港日', apply: '没收完的采购单', effect: '进仓库主管 / 国内采购的待办' },
  'want.days': { area: 'po', short: '想要几天失效', src: '登记想要 / 下单没供够', apply: '每一条想要', effect: '过期不再算进备货，到货也不再问', me: true },
  'check.qty': { area: 'ship', short: '必抽检 · 一行数量 >', src: 'Claude 先定', apply: '复检时每一行', effect: '这一行必须选抽检结果才能勾', me: 1 },
  'check.price': { area: 'ship', short: '必抽检 · 单价 >', src: 'Claude 先定', apply: '复检时每一行', effect: '同上', me: 1 },
  'check.total': { area: 'ship', short: '必抽检 · 一行总价 >', src: 'Claude 先定', apply: '复检时每一行', effect: '同上', me: 1 },
  'loss.on': { area: 'ship', short: '亏钱拦截', src: 'Frank 11-17 定；成本取物料档案', apply: '下推每一步 + 出库那一下', effect: '拦住 → 中方批 + 写原因才放行；事后进异常的单' },
  'loss.nocost': { area: 'ship', short: '没成本的型号也要批', src: 'Claude 先定（默认关）', apply: '同上', effect: '没成本的行也拦住', me: 1 },
  'credit.on': { area: 'ship', short: '超欠款上限 / 超账期不出库', src: 'Frank 11-18 定；上限和账期在客户档案', apply: '出库那一下', effect: '拦住 → 中方在订单上放行 + 写原因' },
  'rep.on': { area: 'ship', short: '销售员名下欠款不出货', src: 'Frank 11-13 定', apply: '这个销售员名下所有客户出库', effect: '拦住 → 中方对单放行，销售员可申诉' },
  'bl.amount': { area: 'ship', short: '大单建议打印 BL · 金额 ≥', src: '设置（原来在发货文件里）', apply: '出库记录', effect: '标「大单 · 建议打印」，不强制' },
  'bl.qty': { area: 'ship', short: '大单建议打印 BL · 件数 ≥', src: '同上', apply: '出库记录', effect: '同上' },
  'disc.hours': { area: 'sign', short: '收货差异 / 损坏 · 几小时内', src: 'Frank 11-16 定', apply: '签收后客户反馈、退货', effect: '超时要认必须写破例原因' },
  'wo.max': { area: 'pay', short: '抹零 · 一张单最多', src: 'Frank 定', apply: '收款时抹零', effect: '超过不让抹，要走坏账核销' },
  'margin.low': { area: 'cust', short: '毛利率低于多少标黄', src: 'Claude 先定', apply: '毛利分析、订单毛利（只中方看）', effect: '标黄；负数一律标红', me: 1 },
  'vol.pct': { area: 'cust', short: '月提货量涨跌 · 算变化大', src: 'Claude 先定', apply: '客户每月提货量对比', effect: '进中方待办「拿货量变化」', me: 1 },
  'cash.held': { area: 'cash', short: '员工代收 · 几天没交算紧急', src: 'Frank 11-13 定', apply: '员工手上收的现金', effect: '进中方紧急待办' },
  'freight.acct': { area: 'cash', short: '我们出的运费记哪个账户', src: 'Frank 定', apply: '出库填运费「我们出」', effect: '自动记一笔本地物流费支出' },
  'remit.diff': { area: 'cash', short: '回款到账差 · 标红', src: 'Claude 先定', apply: '回款填到账时', effect: '标红 + 核对必须写原因', me: 1 },
  'remit.days': { area: 'cash', short: '回款几天没到 · 提醒', src: 'Claude 先定', apply: '在途的回款', effect: '进待办「回款要看一下」', me: 1 },
  'kpi.s0': { area: 'quote', short: '时效 · 建报价 → 确认', src: 'Claude 先定', apply: '时效页达标率', effect: '只显示不考核', me: 1 },
  'kpi.s1': { area: 'pick', short: '时效 · 下推 → 初检完', src: 'Claude 先定', apply: '时效页达标率', effect: '只显示不考核', me: 1 },
  'kpi.s2': { area: 'so', short: '时效 · 初检完 → 出销售单', src: 'Claude 先定', apply: '时效页达标率', effect: '只显示不考核', me: 1 },
  'kpi.s4': { area: 'ship', short: '时效 · 客户确认 → 复检完', src: 'Claude 先定', apply: '时效页达标率', effect: '只显示不考核', me: 1 },
  'kpi.s5': { area: 'ship', short: '时效 · 打包完 → 出库', src: 'Claude 先定', apply: '时效页达标率', effect: '只显示不考核', me: 1 },
  'dir.ack': { area: 'dir', short: '指令 · 几分钟内点「收到」', src: 'Frank 11-12 定', apply: '中方下的每条指令', effect: '超时点收到要写原因，时效页记一次' },
  'wh.comm': { area: 'staff', short: '仓库提成 · 每片', src: 'Frank 定', apply: '正确出货的片数（发错整单取消）', effect: '自动带进工资单' },
  'sales.comm': { area: 'staff', short: '销售提成 · 每片', src: 'Frank 11-18 定', apply: '整单付清的片数', effect: '自动带进工资单' },
};
// 「系统」里不是数字的设置: 直接放整块面板 (原来在右上角设置里)
function IconPanel() { const { org, role, toast, refresh } = useApp(); return <IconLibrary org={org} role={role} call={call} toast={toast} refresh={refresh} pageNames={Object.fromEntries(Object.entries(NAV_ITEMS).map(([k, v]) => [k, v[1]]))} />; }
const SYS_PANELS = [['perm', '权限表', PermPanel], ['docs', '发货文件（BL + 海关文件）', DocSettings], ['icons', '图标库', IconPanel], ['export', '导出整库', ExportPanel]];

const JUMP = 'la9s.rule.jump';

export function useRuleValues(ids) {
  const { org, tick } = useApp();
  const keys = [...new Set(ids.map((i) => BY_ID[i]?.[1]).filter(Boolean))];
  const { data } = useData(() => q(`select key, value from app.org_settings where org_id = $1 and key = any($2)`, [org, keys]), [org, keys.join(), tick]);
  return data;
}
const valOf = (data, r) => { const v = data?.find((x) => x.key === r[1])?.value?.[r[2]]; return v ?? r[4]; };
export const fmtRule = (data, id) => { const r = BY_ID[id]; const v = valOf(data, r); return r[6] === 'bool' ? (v ? '开' : '关') : r[6] === 'num' ? `${Number(v).toLocaleString('en-US')} ${r[5]}` : String(v); };

// 一组规则的编辑行 (改一格存一格, 立即生效)
export function RuleRows({ ids, short }) {
  const { org, role, toast, refresh } = useApp();
  const data = useRuleValues(ids);
  const [draft, setDraft] = useState({});
  if (!data) return <div className="small muted">加载中…</div>;
  const save = async (r, v) => {
    try {
      const old = data.find((x) => x.key === r[1])?.value || {};
      await call(role, `select app.set_org_setting($1,$2,$3)`, [org, r[1], JSON.stringify({ ...old, [r[2]]: v })]);
      toast(`已保存：${r[3].split('：')[0]}，立即生效`); refresh();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {ids.map((id) => {
        const r = BY_ID[id]; if (!r) return null;
        const v = valOf(data, r);
        const label = short && r[3].includes('：') ? r[3].slice(r[3].indexOf('：') + 1) : r[3];
        if (r[6] === 'bool') return (
          <label key={id} className="rule-row"><span className="grow">{label}</span>
            <input type="checkbox" checked={!!v} onChange={(e) => save(r, e.target.checked)} /></label>);
        if (r[6] === 'text') return (
          <div key={id} className="rule-row"><span className="grow">{label}</span>
            <input className="in" style={{ width: 130 }} value={draft[id] ?? v} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
              onBlur={(e) => { if (draft[id] != null && e.target.value.trim() && e.target.value.trim() !== v) save(r, e.target.value.trim()); }} /></div>);
        return (
          <div key={id} className="rule-row"><span className="grow">{label}</span>
            <MoneyIn className="in" style={{ width: 96 }} inputMode="numeric" value={draft[id] ?? String(v)}
              onChange={(e) => setDraft({ ...draft, [id]: String(e.target.value).replace(/[^\d.]/g, '') })}
              onBlur={(e) => { const n = Number(String(e.target.value).replace(/[^\d.]/g, '')); if (draft[id] != null && n > 0 && n !== Number(v)) save(r, n); }} />
            <span className="small muted rule-unit">{r[5]}</span></div>);
      })}
    </div>);
}

// 用到规则的地方旁边的小 ⚙ (只中方看得到); anchor = 总表跳过来时认的位置
export function RuleGear({ ids, anchor, title = '这里的规则' }) {
  const { role } = useApp();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const ref = useOutside(open, () => setOpen(false));
  const place = () => { const b = me.current?.getBoundingClientRect(); if (!b) return; const w = Math.min(460, window.innerWidth - 32);
    setPos({ top: Math.min(b.bottom + 6, window.innerHeight - 120), left: Math.max(16, Math.min(b.left - 12, window.innerWidth - w - 16)), width: w }); };
  useEffect(() => { if (!open) return undefined; place(); const f = () => place(); window.addEventListener('scroll', f, true); window.addEventListener('resize', f);
    return () => { window.removeEventListener('scroll', f, true); window.removeEventListener('resize', f); }; }, [open]);
  const me = useRef(null);
  usePopBus(open, () => setOpen(false));
  useEffect(() => {
    if (!anchor) return;
    let j = null; try { j = sessionStorage.getItem(JUMP); } catch { /* */ }
    if (j !== anchor) return;
    try { sessionStorage.removeItem(JUMP); } catch { /* */ }
    const t = setTimeout(() => { me.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); setOpen(true); }, 350);
    return () => clearTimeout(t);
  }, [anchor]);
  if (role !== 'admin') return null;
  return (
    <span ref={(el) => { ref.current = el; me.current = el; }} className="rule-gear" data-rule-anchor={anchor}>
      <button type="button" className={`gear-btn ${open ? 'on' : ''}`} title={title} aria-label={title} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>⚙</button>
      {open && pos && <div className="rule-pop" style={pos} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 8 }}><b>{title}</b><span className="small muted">改完立即生效</span></div>
        <RuleRows ids={ids} short />
      </div>}
    </span>);
}

// 规则参数总页 (Frank 11-20): 顶上工作地图 → 选一个环节只看它; 每条规则一行 = 短名字 · 现在的值 (直接改) · ⓘ 三句说明 · 去这一步 ›
export function RulesIndex() {
  const { go } = useApp();
  const [sel, setSel] = useState(() => { try { const v = sessionStorage.getItem('la9s.rules.area'); sessionStorage.removeItem('la9s.rules.area'); return v || null; } catch { return null; } });
  const data = useRuleValues(RULES.map((r) => r[0]));
  // 一个环节里: 拦截 / 开关在前, 数字阈值在中间, 时效目标在后
  const rank = (id) => (id.startsWith('kpi.') ? 2 : BY_ID[id][6] === 'bool' ? 0 : 1);
  const by = {}; for (const r of RULES) { const m = META[r[0]]; if (m) (by[m.area] ||= []).push(r[0]); }
  for (const k of Object.keys(by)) by[k].sort((a, b) => rank(a) - rank(b));
  const info = (k) => { const n = (by[k] || []).length + (k === 'sys' ? SYS_PANELS.length : 0); return { val: n || '—', sub: n ? `${n} 条规则` : '没有规则', tone: 'gray' }; };
  const shown = AREAS.filter((a) => (sel ? a.k === sel : (by[a.k] || []).length || a.k === 'sys'));
  return (
    <div className="stack" style={{ gap: 12 }}>
      <WorkMap value={sel} onChange={setSel} info={info} />
      {shown.map((a) => (
        <div key={a.k} className="card" id={`rules-${a.k}`}>
          <div className="card-h"><h2>{a.l}</h2>{(a.step || a.page) && <button type="button" className="btn sm ghost" onClick={() => goArea(a.k, go)}>{a.step ? '看卡在这一步的单 ›' : '去这一页 ›'}</button>}</div>
          <div className="card-b">
            {(by[a.k] || []).length ? <RuleLines ids={by[a.k]} data={data} /> : a.k !== 'sys' && <div className="small muted">这一环节还没有可调的规则。</div>}
            {a.k === 'sys' && <div className="stack" style={{ gap: 14 }}>{SYS_PANELS.map(([k, , C]) => <C key={k} />)}</div>}
          </div>
        </div>))}
    </div>);
}

// 一行一条: 短名字 | 值 (直接改, 改一格存一格) | ⓘ (从哪来 / 作用在哪 / 触发后) | 蓝色 ! (Claude 先定的)
function RuleLines({ ids, data }) {
  const { org, role, toast, refresh } = useApp();
  const [draft, setDraft] = useState({});
  if (!data) return <div className="small muted">加载中…</div>;
  const save = async (r, v) => {
    try { const old = data.find((x) => x.key === r[1])?.value || {}; await call(role, `select app.set_org_setting($1,$2,$3)`, [org, r[1], JSON.stringify({ ...old, [r[2]]: v })]); toast(`已保存：${META[r[0]]?.short || r[3]}，立即生效`); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="rl">{ids.map((id) => {
      const r = BY_ID[id]; const m = META[id] || {}; const v = valOf(data, r);
      const ctl = r[6] === 'bool'
        ? <button type="button" className={`pill ${v ? 'green' : 'gray'} rl-tog`} onClick={() => save(r, !v)}>{v ? '开' : '关'}</button>
        : r[6] === 'text'
          ? <input className="in rl-in" value={draft[id] ?? v} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })} onBlur={(e) => { const x = e.target.value.trim(); if (draft[id] != null && x && x !== v) save(r, x); }} />
          : <span className="rl-num"><MoneyIn className="in rl-in" inputMode="numeric" value={draft[id] ?? String(v)} onChange={(e) => setDraft({ ...draft, [id]: String(e.target.value).replace(/[^\d.]/g, '') })}
              onBlur={(e) => { const n = Number(String(e.target.value).replace(/[^\d.]/g, '')); if (draft[id] != null && n > 0 && n !== Number(v)) save(r, n); }} /><span className="small muted">{r[5]}</span></span>;
      return (
        <div key={id} className="rl-row">
          <span className="rl-name">{m.short || r[3]}</span>
          {ctl}
          <span className="rl-ico"><Info><div className="rl-tip"><i>从哪来</i><span>{m.src || '—'}</span><i>作用在哪</i><span>{m.apply || '—'}</span><i>触发后</i><span>{m.effect || r[3]}</span></div></Info>{m.me ? <Assumed>这个值是 Claude 先按建议定的，Frank 还没逐条拍板；改了就算你定的。</Assumed> : null}</span>
        </div>);
    })}</div>);
}
