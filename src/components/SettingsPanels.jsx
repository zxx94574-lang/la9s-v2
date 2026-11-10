// 设置里的两块 (第九版 11-07): ① 数据导出 (整库 JSON + Excel, 留记录不留文件)  ② 发货文件 (海关 PDF、G&S 抬头 / logo、大单阈值)
import React, { useState } from 'react';
import { q, call, REAL } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, FileDrop, Modal } from './ui.jsx';
import Grid from './Grid.jsx';
import { PERM_GROUPS, PERM_ROLES, defaultRoles } from '../lib/perm.js';
import { ROLE_LABELS, rolesFor } from '../lib/domain.js';
import { saveFile } from '../lib/saveFile.js';
import { friendlyError, dt } from '../lib/format.js';
import { GS_DEFAULT, BL_SUGGEST_DEFAULT } from './Bl.jsx';

export function ExportPanel() {
  const { org, role, toast } = useApp();
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);
  const { data: log } = useData(() => (role === 'admin' ? q(Q.exportLog, [org]) : Promise.resolve([])), [org, role, tick]);
  if (!['admin', 'manager'].includes(role)) return null;
  const run = async (kind) => {
    setBusy('正在读全部表…');
    try {
      const { dumpAll, toJsonBlob, toXlsxBlob, stamp } = await import('../lib/exportAll.js');
      const dump = await dumpAll((t) => setBusy(`正在读 ${t}…`));
      const rows = dump.stats.reduce((a, s) => a + s.rows, 0);
      const name = `LA9S-${REAL ? '真实' : '演示'}-整库-${stamp()}`;
      let bytes = 0;
      if (kind === 'json' || kind === 'both') { const b = toJsonBlob(dump, { real: REAL, org }); bytes += b.size; setBusy('正在下载 JSON…'); if ((await saveFile(`${name}.json`, b)) !== 'saved') { setBusy(''); return toast('已取消'); } }
      if (kind === 'xlsx' || kind === 'both') { setBusy('正在生成 Excel…'); const b = await toXlsxBlob(dump); bytes += b.size; if ((await saveFile(`${name}.xlsx`, b)) !== 'saved') { setBusy(''); return toast('已取消'); } }
      await call(role, `select app.log_export($1,$2,$3)`, [org, `full:${kind}`, JSON.stringify({ rows, bytes, tables: dump.stats })]);
      toast(`已导出 ${dump.stats.length} 张表、${rows.toLocaleString()} 行（${(bytes / 1048576).toFixed(1)} MB）。存到飞书云盘。`);
      setTick((x) => x + 1);
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(''); }
  };
  return (
    <div className="field"><label>数据导出（整库）{REAL && <Pill tone="amber">真实数据版：每周导一次存飞书云盘</Pill>}</label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => run('both')}>⇩ 导出整库（JSON + Excel）</button>
        <button type="button" className="btn sm" disabled={!!busy} onClick={() => run('json')}>只要 JSON</button>
        <button type="button" className="btn sm" disabled={!!busy} onClick={() => run('xlsx')}>只要 Excel</button>
        {busy && <span className="small muted">{busy}</span>}
      </div>
      <span className="hint">JSON 是完整备份（含证件照，以后能原样导回）；Excel 每张表一个工作表给人看。系统只记录谁、几点、导了多少行，不保存文件。</span>
      {role === 'admin' && log?.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>最近导出：{log.slice(0, 3).map((l) => `${dt(l.at)} ${l.who || ''} ${l.kind}${l.detail?.rows ? ` ${Number(l.detail.rows).toLocaleString()} 行` : ''}`).join('；')}</div>}
    </div>
  );
}

const readB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });

export function DocSettings() {
  const { org, role, toast, refresh } = useApp();
  const [tick, setTick] = useState(0);
  const { data } = useData(async () => {
    const [[customs], [logo], [hdr], [sug]] = await Promise.all([q(Q.orgFile, [org, 'customs']), q(Q.orgFile, [org, 'logo_gs']),
      q(`select value from app.org_settings where org_id = $1 and key = 'doc_header_gs'`, [org]), q(`select value from app.org_settings where org_id = $1 and key = 'bl_suggest'`, [org])]);
    return { customs, logo, header: { ...GS_DEFAULT, ...(hdr?.value || {}) }, suggest: { ...BL_SUGGEST_DEFAULT, ...(sug?.value || {}) } };
  }, [org, tick]);
  if (role !== 'admin' || !data) return null;
  const upload = async (key, file, okTypes, maxMb) => {
    if (!file) return;
    if (!okTypes.some((t) => file.type.startsWith(t))) return toast(`要 ${okTypes.join(' / ')} 文件`, 'err');
    if (file.size > maxMb * 1048576) return toast(`文件太大（${(file.size / 1048576).toFixed(1)} MB），限 ${maxMb} MB`, 'err');
    try { await call(role, `select app.set_org_file($1,$2,$3,$4,$5,$6)`, [org, key, file.name, file.type, await readB64(file), file.size]); toast('已上传'); setTick((x) => x + 1); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const setting = async (key, value, msg) => { try { await call(role, `select app.set_org_setting($1,$2,$3)`, [org, key, JSON.stringify(value)]); toast(msg || '已保存'); setTick((x) => x + 1); } catch (e) { toast(friendlyError(e), 'err'); } };
  const { customs, logo, header, suggest } = data;
  return (
    <div className="field"><label>发货文件（BL + 海关文件）</label>
      <div className="stack" style={{ gap: 8 }}>
        <div className="grid2">
          <div className="stack" style={{ gap: 4 }}><span className="small">随货附件（海关 PDF）{customs ? <> · 现在是 <b>{customs.name}</b>（{Math.round(customs.bytes / 1024)} KB，{dt(customs.uploaded_at)}）</> : <span className="muted"> · 还没上传</span>}</span>
            <FileDrop accept="application/pdf,.pdf" compact label={customs ? '拖新的 PDF 进来换掉' : '把海关 PDF 拖到这里，或点击选择'} onFiles={([f]) => upload('customs', f, ['application/pdf'], 12)} /></div>
          <div className="stack" style={{ gap: 4 }}><span className="small">G&amp;S logo 图片{logo ? <> · 现在是 <b>{logo.name}</b></> : <span className="muted"> · 没有，BL 上用文字抬头</span>}</span>
            <FileDrop accept="image/*" compact label={logo ? '拖新图片进来换掉' : '把 logo 图片拖到这里，或点击选择'} onFiles={([f]) => upload('logo_gs', f, ['image/'], 2)} /></div>
        </div>
        <div className="field"><label className="small">BL 页脚文字（G&amp;S 抬头，一行一段）</label>
          <textarea className="in" rows={2} defaultValue={header.footer} key={header.footer} onBlur={(e) => e.target.value !== header.footer && setting('doc_header_gs', { ...header, footer: e.target.value })} /></div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small">大单建议打印：金额 ≥</span><input className="in" style={{ width: 120 }} inputMode="numeric" defaultValue={suggest.amount} key={`a${suggest.amount}`} onBlur={(e) => Number(e.target.value) !== Number(suggest.amount) && setting('bl_suggest', { ...suggest, amount: Number(e.target.value) || 0 })} />
          <span className="small">XOF 或件数 ≥</span><input className="in" style={{ width: 90 }} inputMode="numeric" defaultValue={suggest.qty} key={`q${suggest.qty}`} onBlur={(e) => Number(e.target.value) !== Number(suggest.qty) && setting('bl_suggest', { ...suggest, qty: Number(e.target.value) || 0 })} />
        </div>
        <span className="hint">出库记录里每批都有「BL ×2」和「海关文件」两个按钮；到阈值的单会标「大单 · 建议打印」，小单不强制。海关文件换批次时在这里重传。</span>
      </div>
    </div>
  );
}

// ③ 权限配置 (Frank 11-09 第 5 条): 动作 × 岗位, 中方勾谁能做; 中方永远全开. 存 org_settings 'perm_matrix', 改完立即生效 (App 每次 refresh 重读)
export function PermPanel() {
  const { org, role, toast, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [m, setM] = useState(null);
  if (role !== 'admin') return null;
  const load = async () => { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = 'perm_matrix'`, [org]); setM(r?.value && typeof r.value === 'object' ? r.value : {}); setOpen(true); };
  const save = async (next) => {
    try { await call(role, `select app.set_org_setting($1,'perm_matrix',$2)`, [org, next ? JSON.stringify(next) : null]); setM(next || {}); toast(next ? '权限已保存，立即生效' : '已恢复默认'); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const rows = PERM_GROUPS.flatMap(([g, list]) => list.map(([k, l]) => ({ id: k, group: g, label: l })));
  const toggle = (k, r, on) => { const cur = new Set(m && Array.isArray(m[k]) ? m[k] : defaultRoles(k)); on ? cur.add(r) : cur.delete(r); save({ ...(m || {}), [k]: [...cur] }); };
  return (
    <div className="field"><label>权限配置</label>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" onClick={load}>打开权限表（动作 × 岗位）</button>
        <span className="hint">每个动作谁能做，你勾；中方永远全开。改完立即生效。</span>
      </div>
      {open && <Modal title="权限配置 · 动作 × 岗位" wide onClose={() => setOpen(false)}
        footer={<><button type="button" className="btn" onClick={() => save(null)}>恢复默认</button><span className="grow" /><button type="button" className="btn primary" onClick={() => setOpen(false)}>关闭</button></>}>
        <div className="hint" style={{ marginBottom: 8 }}>格子里点一下切换 ✓ / —，改一格存一格。「销售主管」自动包含「销售员」能做的事。看不见的页面在侧栏配置里关。</div>
        <Grid id="perm-matrix" noTools maxHeight={520} rows={rows} columns={[
          { key: 'group', label: '模块', w: 120, value: (r) => r.group },
          { key: 'label', label: '动作', w: 220, value: (r) => r.label, render: (r) => <><b>{r.label}</b> <span className="muted small mono">{r.id}</span></> },
          ...PERM_ROLES.map((pr) => ({ key: pr, label: ROLE_LABELS[pr] || pr, w: 90, align: 'center', value: (r) => (rolesFor(r.id).includes(pr) ? '✓' : ''),
            edit: (r) => ({ type: 'select', value: rolesFor(r.id).includes(pr) ? 'y' : 'n', options: [['y', '✓ 可以'], ['n', '— 不行']], onChange: (v) => toggle(r.id, pr, v === 'y') }) })),
        ]} />
      </Modal>}
    </div>
  );
}
