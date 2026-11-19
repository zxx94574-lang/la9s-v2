// 规则参数分散到用到它的地方 (Frank 11-19 13:42):
//   每条规则在「用到它的那一页 / 那一步」旁边一个小 ⚙ 就地改 (只中方); 「规则参数」总页只是总表 + 跳转, 不用翻.
//   同一条规则可以出现在几处 (例: 指令几分钟收到 → 时效页 + 待办指令板块), 改的是同一个数.
//   home = 主位置: page = 页面路由 (总表「去设置 ›」跳过去并自动打开那里的 ⚙); step = 在每张订单的某一步 (没有固定页面, 总表里就地改).
import React, { useEffect, useRef, useState } from 'react';
import { q, call } from '../db/client.js';
import { useApp, useData, MoneyIn, usePopBus, useOutside } from './ui.jsx';
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
  ['price.odd', 'price_rules', 'odd_pct', '改价：单价偏离客户档位价超过多少算「异价单」', 10, '%', 'num', { page: 'pricing', anchor: 'pricing-rules', where: '物料与定价' }],
  ['price.cny', 'price_rules', 'cny_only_s', '人民币报价只给 S 档客户（中方可以单张破例）', true, '', 'bool', { page: 'pricing', anchor: 'pricing-rules', where: '物料与定价' }],
  ['margin.low', 'margin_rules', 'low_pct', '毛利：毛利率低于多少标黄（要留意）；负数一律标红', 10, '%', 'num', { page: 'margin', anchor: 'margin-rules', where: '毛利分析' }],
  ['loss.on', 'loss_rules', 'on', '卖价低于到岸成本 → 这张单推不下去，中方批准 + 写原因才放行（亏钱拦截）', true, '', 'bool', { page: 'margin', anchor: 'margin-rules', where: '毛利分析' }],
  ['loss.nocost', 'loss_rules', 'no_cost', '有型号没有成本（算不出亏不亏）→ 也要中方批（默认关：没成本的编码还多）', false, '', 'bool', { page: 'margin', anchor: 'margin-rules', where: '毛利分析' }],
  ['credit.on', 'credit_gate', 'on', '出库那一刻客户超欠款上限 / 超账期 → 不能出库，中方在订单上放行 + 写原因', true, '', 'bool', { page: 'customers', anchor: 'cust-rules', where: '客户档案' }],
  ['rep.on', 'rep_debt_rules', 'on', '销售员名下有隔天没收回的欠款 → 他名下所有客户暂不出货（中方可对单放行）', true, '', 'bool', { page: 'customers', anchor: 'cust-rules', where: '客户档案' }],
  ['vol.pct', 'volume_shift', 'pct', '客户提货量月对比：涨跌超过多少算变化大', 50, '%', 'num', { page: 'customers', anchor: 'cust-rules', where: '客户档案' }],
  ['cash.held', 'cash_rules', 'held_days', '员工代收：钱在员工手上超过几天没交就进紧急', 1, '天', 'num', { page: 'cash', anchor: 'cash-rules', where: '资金账户' }],
  ['freight.acct', 'freight_rules', 'account', '我们出的运费记在哪个账户', 'Wave-XOF', '', 'text', { page: 'cash', anchor: 'cash-rules', where: '资金账户' }],
  ['guest.low', 'guest_rules', 'low', '游客 / 客户账号：可售少于多少片显示「少量」', 50, '片', 'num', { page: 'inquiry', anchor: 'inquiry-rules', where: '询单' }],
];
const BY_ID = Object.fromEntries(RULES.map((r) => [r[0], r]));
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

// 总表: 按「在哪里设置」分组, 一行 = 规则 + 现在的值 + 去设置 ›
export function RulesIndex() {
  const { go } = useApp();
  const data = useRuleValues(RULES.map((r) => r[0]));
  const groups = [];
  for (const r of RULES) {
    const w = r[7].where || r[7].step; let g = groups.find((x) => x.w === w);
    if (!g) groups.push(g = { w, home: r[7], ids: [] });
    g.ids.push(r[0]);
  }
  const jump = (home) => { try { sessionStorage.setItem(JUMP, home.anchor); } catch { /* */ } go(home.page); };
  return (
    <div className="stack" style={{ gap: 12 }}>
      {groups.map((g) => (
        <div key={g.w} className="card">
          <div className="card-h"><h2>{g.w}</h2>
            {g.home.page ? <button type="button" className="btn sm" onClick={() => jump(g.home)}>去那里设置 ›</button>
              : <span className="small muted">在每张订单的这一步旁边 ⚙ 也能改；这里直接改也一样</span>}</div>
          <div className="card-b">
            {g.home.page
              ? <div className="stack" style={{ gap: 6 }}>{g.ids.map((id) => (
                <div key={id} className="rule-row click" onClick={() => jump(g.home)}><span className="grow">{BY_ID[id][3]}</span><b>{data ? fmtRule(data, id) : '…'}</b><span className="muted">›</span></div>))}</div>
              : <RuleRows ids={g.ids} />}
          </div>
        </div>))}
    </div>);
}
