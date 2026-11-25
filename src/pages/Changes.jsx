// 116 (体检第 2 组): 变更记录 + 系统健康 —— 改了哪个设置、谁、什么时候、改前 → 改后; 系统里各类数据多少、最近一次动是什么时候
import React, { useMemo, useState } from 'react';
import { call } from '../db/client.js';
import { useApp, useData, Info, Choice } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { ExportPanel } from '../components/SettingsPanels.jsx';
import { dt, qty } from '../lib/format.js';

const KEY_NAME = { nav: '侧栏', bin_rooms: '库位布局', directive_jump: '指令跳转', report_rates: '月报汇率', opts: '选项', margin_rules: '毛利规则', price_settings: '汇率与取整', dash_rules: '经营总览规则', directive_rules: '指令规则', late_rules: '迟到规则', perm_matrix: '岗位权限', budget_months: '月度预算', nav_icons: '侧栏图标', doc_header_gs: 'G&S 抬头', bl_suggest: '大单建议打印', price_rules: '价格规则', rep_debt_rules: '员工欠款规则', grid_align: '表格对齐' };
const ACTION_NAME = { set_org_setting: '改设置', reset_setting: '恢复默认', set_org_file: '换文件', import_customers: '导入客户', import_products: '导入物料', import_stock: '导入库存', import_opening_items: '导入期初应收', import_packing_list: '导入箱单', import_purchase_orders: '导入采购单', import_sales_history: '导入历史销量', import_code_unify: '导入编码归一', set_code_unify: '编码归一', recompute_prices: '重算价格', lock_month: '锁月', unlock_month: '解锁月', transfer_customers: '移交客户', upsert_employee: '员工档案', add_employee_file: '员工证件', payroll_confirm: '确认工资', payroll_unconfirm: '撤回工资确认', cash_account: '资金账户', delete_category: '删种类', merge_category: '合并种类', rename_category: '种类改名', rename_model: '型号改名', edit_product_info: '改物料', set_usd_rate: '改美元汇率', set_attendance_rules: '打卡规则', set_work_schedule: '上班时间', set_block_on_debt: '欠款拦单', freeze_stock: '冻结库存', set_brand: '品牌', set_clearance: '清货标记', kd_opening_paste: '粘金蝶应收', kd_opening_clear: '期初差异调平', issue_directive: '下指令', issue_recurring: '定期任务', take_leave: '请假', receipt: '收款', create_prospect: '新潜客', archive_edit: '改档案', kingdee_fill: '回填金蝶单号', save_po: '采购单', set_po_info: '采购单信息', close_po_gap: '关采购差额', save_product_batch: '批次', delete_product_batch: '删批次', set_batch_freight: '批次运费', create_remittance: '汇回', report_issue: '报问题' };
const SETTING = (r) => ['set_org_setting', 'reset_setting', 'set_org_file'].includes(r.action);
const whatOf = (r) => { const k = r.detail?.key; if (k) return k.startsWith('opts:') ? `选项 · ${k.slice(5)}` : k.startsWith('filter_schemes:') ? `筛选方案 · ${k.slice(15)}` : (KEY_NAME[k] || k); return ACTION_NAME[r.action] || ACTION_NAME[r.action.replace(/_\w+$/, '_')] || r.action; };
const short = (v) => { if (v == null) return '（空）'; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 80 ? s.slice(0, 80) + '…' : s; };

export function Changes() {
  const { org, role } = useApp();
  const { data } = useData(() => call(role, `select * from app.change_log($1, 1000)`, [org]), [org, role]); const rows = useMemo(() => data || [], [data]);
  const [who, setWho] = useState('*'); const [kind, setKind] = useState('set');
  const people = useMemo(() => [...new Set(rows.map((r) => r.who))], [rows]);
  const shown = rows.filter((r) => (who === '*' || r.who === who) && (kind === '*' || (kind === 'set') === SETTING(r)));
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Journal</div><h1>变更记录 <Info>中方改过的设置（规则参数、选项、侧栏、库位布局、汇率…）都在这里：谁、什么时候、改前 → 改后。业务单据的改动在各张单的「操作记录」里。</Info></h1></div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><Choice value={kind} onChange={setKind} options={[['set', '设置'], ['op', '导入 / 档案 / 其他'], ['*', '全部']]} />
          <Choice value={who} onChange={setWho} options={[['*', '所有人'], ...people.map((p) => [p, p])]} /></div></div>
      <div className="card"><Grid id="changes" compactTools rows={shown} rowKey={(r) => r.id} empty="还没有改过设置" columns={[
        { key: 'at', label: '时间', w: 140, render: (r) => dt(r.at) }, { key: 'who', label: '谁', w: 90 },
        { key: 'what', label: '改了什么', w: 160, value: whatOf },
        { key: 'old', label: '改前', w: 260, value: (r) => (SETTING(r) ? short(r.detail?.old) : ''), render: (r) => <span className="small muted" title={JSON.stringify(r.detail?.old ?? '')}>{SETTING(r) ? short(r.detail?.old) : ''}</span> },
        { key: 'new', label: '改后 / 内容', w: 300, value: (r) => (r.action === 'reset_setting' ? '恢复默认' : SETTING(r) ? short(r.detail?.new) : short(r.detail)), render: (r) => { const v = r.action === 'reset_setting' ? '恢复默认' : SETTING(r) ? short(r.detail?.new) : short(r.detail); return <span className="small" title={JSON.stringify(SETTING(r) ? r.detail?.new ?? '' : r.detail ?? '')}>{v}</span>; } }]} /></div>
    </>);
}

export function Health() {
  const { org, role } = useApp();
  const h = useData(() => call(role, `select app.system_health($1) as h`, [org]).then((r) => r[0]?.h || {}), [org, role]).data;
  const days = (v) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 864e5) : null);
  const backup = h?.last_export; const bd = days(backup);
  const Row = ({ k, v, sub, tone }) => <div className="hl-row"><span>{k}</span><b className={tone || ''}>{v}</b><small>{sub}</small></div>;
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Santé</div><h1>系统健康 <Info>上线前数据只在这台电脑的浏览器里，「导出整库」是唯一备份，至少每周一次。上线后这里会显示服务器每天备份的时间。</Info></h1></div></div>
      {!h ? <div className="card"><div className="empty">加载中…</div></div> : <div className="card"><div className="card-b hl">
        <Row k="上次导出整库" v={backup ? dt(backup) : '从来没导过'} sub={bd == null ? '设置 → 导出整库' : `${bd} 天前`} tone={bd == null || bd > 7 ? 'red-t2' : ''} />
        <Row k="订单" v={qty(h.deals)} sub={h.last_deal ? `最近 ${dt(h.last_deal)}` : ''} />
        <Row k="出库单" v={qty(h.shipments)} sub={h.last_ship ? `最近 ${dt(h.last_ship)}` : ''} />
        <Row k="收款" v={qty(h.receipts)} sub={h.last_receipt ? `最近 ${dt(h.last_receipt)}` : ''} />
        <Row k="客户 / 物料" v={`${qty(h.customers)} / ${qty(h.products)}`} />
        <Row k="库存流水" v={qty(h.stock_moves)} sub="每一次进出库" />
        <Row k="看板快照" v={h.last_snapshot ? String(h.last_snapshot).slice(0, 10) : '没有'} sub="每天记一次，月报走势用" />
        <Row k="最近一次改设置" v={h.last_change ? dt(h.last_change) : '没有'} sub="见「变更记录」" />
      </div></div>}
      {h && <div className="card"><div className="card-h"><h2>现在就备份</h2></div><div className="card-b"><ExportPanel /></div></div>}
    </>);
}
