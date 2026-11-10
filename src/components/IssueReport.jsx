// 上报问题 (Frank 11-08 晚): 每个环节都能上报 (文字 + 照片), 立刻进中方待办; 中方处理时写一句回复.
// 事项分类先用默认列表, 等「每张表的选项设置」(待改 145) 做好后并进去.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Modal, Pill, PhotoInput } from './ui.jsx';
import { friendlyError, dt } from '../lib/format.js';
import { STEPS, ROLES } from '../lib/domain.js';

export const ISSUE_CATS_DEFAULT = ['库存和系统对不上', '价格有问题', '客户临时改需求', '货有质量问题', '系统 / 操作问题', '其他'];
const stepLabel = (k) => STEPS.find((s) => s.key === k)?.label || k || '';

export function IssueButton({ deal, step, small = true }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn soft-red ${small ? 'sm' : ''}`} title="做单遇到问题？写一句，马上进中方待办" onClick={() => setOpen(true)}>⚠ 上报问题</button>
      {open && <IssueModal deal={deal} step={step} onClose={() => setOpen(false)} />}
    </>
  );
}

export function IssueModal({ deal, step, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: cats } = useData(async () => { const [r] = await q(`select value from app.org_settings where org_id = $1 and key = 'issue_options'`, [org]); return Array.isArray(r?.value) && r.value.length ? r.value : ISSUE_CATS_DEFAULT; }, [org]);
  const send = async () => {
    if (!text.trim()) return toast('写一句出了什么问题', 'err');
    setBusy(true);
    try {
      await call(role, `select app.report_issue($1,$2,$3,$4,$5,$6)`, [org, deal?.id || null, step || null, cat || null, text.trim(), photo || null]);
      toast('已上报，中方待办里马上能看到'); refresh(); onClose();
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`上报问题${deal ? ` · ${deal.biz_no || ''} ${deal.customer_name || ''}` : ''}${step ? ` · ${stepLabel(step)}` : ''}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={send}>上报给中方</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="field"><label>是哪类问题</label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{(cats || ISSUE_CATS_DEFAULT).map((c) => <button type="button" key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>{c}</button>)}</div></div>
        <div className="field"><label>出了什么问题 <span className="req">*</span></label><textarea className="in" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="一两句说清楚：哪个型号 / 哪一步 / 差多少" /></div>
        <div className="field"><label>照片（可选）</label><PhotoInput value={photo} onChange={setPhoto} label="拍照 / 截图" /></div>
        <div className="hint">上报后这张单照常往下走，不会卡住；中方处理完会在这里留回复。</div>
      </div>
    </Modal>
  );
}

// 中方待办里的上报列表
export function IssueList({ onlyOpen = true }) {
  const { org, role, toast, go, refresh } = useApp();
  const [tick, setTick] = useState(0);
  const [closing, setClosing] = useState(null);
  const [reply, setReply] = useState('');
  const { data } = useData(() => q(Q.issues, [org, onlyOpen ? 'open' : null]), [org, tick, onlyOpen]);
  if (!data?.length) return null;
  const close = async () => {
    try { await call(role, `select app.close_issue($1,$2)`, [closing.id, reply || null]); toast('已处理'); setClosing(null); setReply(''); setTick((x) => x + 1); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row between" style={{ padding: '10px 18px', borderBottom: '1px solid var(--line-2)' }}><b>⚠ 员工上报的问题 {data.filter((i) => i.status === 'open').length} 条</b></div>
      {data.map((i) => (
        <div key={i.id} className="row between" style={{ padding: '10px 18px', borderBottom: '1px solid var(--line-2)', gap: 10, alignItems: 'flex-start' }}>
          <div className="stack" style={{ gap: 3, flex: 1 }}>
            <div className="small muted">{dt(i.reported_at)} · <b>{i.by_name || '—'}</b>{i.by_roles?.length ? `（${i.by_roles.map((r) => ROLES[r]?.label || r).join('/')}）` : ''}{i.deal_id && <> · <a onClick={() => go('deal/' + i.deal_id)} style={{ cursor: 'pointer' }}>{i.biz_no} {i.customer_name}</a></>}{i.step && ` · ${stepLabel(i.step)}`}</div>
            <div>{i.category && <Pill tone="amber">{i.category}</Pill>} {i.text}</div>
            {i.photo && <img src={i.photo} alt="" style={{ maxHeight: 120, borderRadius: 6, border: '1px solid var(--line-2)' }} />}
            {i.status === 'closed' && <div className="small muted">✓ 已处理 {dt(i.closed_at)}{i.reply && ` · 回复：${i.reply}`}</div>}
          </div>
          {i.status === 'open' && role === 'admin' && <button type="button" className="btn sm primary" onClick={() => setClosing(i)}>处理</button>}
        </div>))}
      {closing && <Modal title="处理这条上报" onClose={() => setClosing(null)}
        footer={<><button type="button" className="btn" onClick={() => setClosing(null)}>取消</button><button type="button" className="btn primary" onClick={close}>标为已处理</button></>}>
        <div className="stack" style={{ gap: 8 }}><div>{closing.text}</div>
          <div className="field"><label>回复（员工在单子的操作记录里能看到）</label><textarea className="in" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="例：库存已盘，按 60 只发" /></div></div>
      </Modal>}
    </div>
  );
}

// 11-09 Frank 第 13 条: 系统发现的异常 (例: 仓库员用了同一张照片) 自动记成一条上报 → 进单据记录 + 主管 / 中方待办, 由他们点一下确认是不是乱来
export async function flagAnomaly(role, org, dealId, step, text) {
  try { await call(role, `select app.report_issue($1,$2,$3,$4,$5,$6)`, [org, dealId || null, step || null, '系统发现 · 待核实', text, null]); } catch { /* 异常上报失败不挡业务 */ }
}
