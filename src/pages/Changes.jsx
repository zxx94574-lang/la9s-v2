// 116 (体检第 2 组): 变更记录 + 系统健康 —— 改了哪个设置、谁、什么时候、改前 → 改后; 系统里各类数据多少、最近一次动是什么时候
import React, { useMemo, useState } from 'react';
import { call } from '../db/client.js';
import { useApp, useData, Info, Choice } from '../components/ui.jsx';
import Grid from '../components/Grid.jsx';
import { dt, qty } from '../lib/format.js';

const KEY_NAME = { nav: '侧栏', bin_rooms: '库位布局', directive_jump: '指令跳转', report_rates: '月报汇率', opts: '选项', margin_rules: '毛利规则', price_settings: '汇率与取整', dash_rules: '经营总览规则', directive_rules: '指令规则', late_rules: '迟到规则' };
const short = (v) => { if (v == null) return '（空）'; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 80 ? s.slice(0, 80) + '…' : s; };

export function Changes() {
  const { org, role } = useApp();
  const { data } = useData(() => call(role, `select * from app.change_log($1, 1000)`, [org]), [org, role]); const rows = useMemo(() => data || [], [data]);
  const [who, setWho] = useState('*');
  const people = useMemo(() => [...new Set(rows.map((r) => r.who))], [rows]);
  const shown = rows.filter((r) => who === '*' || r.who === who);
  return (
    <>
      <div className="pagehead"><div><div className="eyebrow">Journal</div><h1>变更记录 <Info>中方改过的设置（规则参数、选项、侧栏、库位布局、汇率…）都在这里：谁、什么时候、改前 → 改后。业务单据的改动在各张单的「操作记录」里。</Info></h1></div>
        <Choice value={who} onChange={setWho} options={[['*', '所有人'], ...people.map((p) => [p, p])]} /></div>
      <div className="card"><Grid id="changes" compactTools rows={shown} rowKey={(r) => r.id} empty="还没有改过设置" columns={[
        { key: 'at', label: '时间', w: 140, render: (r) => dt(r.at) }, { key: 'who', label: '谁', w: 90 },
        { key: 'what', label: '改了什么', w: 160, value: (r) => KEY_NAME[r.detail?.key] || r.detail?.key || r.action },
        { key: 'old', label: '改前', w: 260, value: (r) => short(r.detail?.old), render: (r) => <span className="small muted" title={JSON.stringify(r.detail?.old ?? '')}>{short(r.detail?.old)}</span> },
        { key: 'new', label: '改后', w: 260, value: (r) => (r.action === 'reset_setting' ? '恢复默认' : short(r.detail?.new)), render: (r) => <span className="small" title={JSON.stringify(r.detail?.new ?? '')}>{r.action === 'reset_setting' ? '恢复默认' : short(r.detail?.new)}</span> }]} /></div>
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
    </>);
}
