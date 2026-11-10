// 客户下单账号 (只中方): 开通 → 临时密码只显示一次; 重置 / 冻结 / 解冻 / 换账号 / 看登录记录; 改密码通知「知道了」.
// 系统里只存加密后的密码, 谁都看不到原文 (中方也不行): 客户忘了就重置.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal } from './ui.jsx';
import { copyText } from './Doc.jsx';
import { dt, friendlyError } from '../lib/format.js';

const EV = { opened: '开通', reset: '中方重置密码', frozen: '冻结', unfrozen: '解冻', login: '登录', login_failed: '密码输错', pw_changed: '客户自己改了密码', otp_sent: '发验证码', login_changed: '换账号' };
export const ACC = { none: ['没开账号', 'gray'], active: ['已开通', 'green'], frozen: ['已冻结', 'red'] };

export function AccountPanel({ customer }) {
  const { org, role, toast, refresh } = useApp();
  const [pw, setPw] = useState(null);
  const [login, setLogin] = useState('');
  const [chg, setChg] = useState(false);
  const { data } = useData(async () => {
    const acc = (await q(Q.customerAccounts, [org])).find((a) => a.customer_id === customer.id) || null;
    return { acc, ev: acc ? await q(Q.accountEvents, [acc.id]) : [] };
  }, [org, customer.id]);
  if (role !== 'admin' || !data) return null;
  const { acc, ev } = data;
  const run = async (msg, sql, p, show) => {
    try { const r = await call(role, sql, p); if (show) setPw(Object.values(r[0])[0]); toast(msg); refresh(); } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const msg = (p) => `LA&9S · Votre compte de commande / 你的下单账号\nLien / 链接 : ${location.origin}${location.pathname}#/login\nIdentifiant / 账号 : ${acc?.login || login || customer.phone}\nMot de passe provisoire / 临时密码 : ${p}\nMerci de le changer à la première connexion / 第一次登录请改成自己的密码.`;
  return (
    <div className="acc-box">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <b>下单账号</b>
        {acc ? <><Pill tone={ACC[acc.status][1]}>{ACC[acc.status][0]}</Pill><span className="mono">{acc.login}</span>
          <span className="small muted">{acc.last_login_at ? `最近登录 ${dt(acc.last_login_at)}` : '还没登录过'}{acc.must_change ? ' · 还在用临时密码' : ''}</span></>
          : <Pill>没开账号</Pill>}
        <span className="grow" />
        {!acc && <>
          <input className="in" style={{ maxWidth: 170 }} placeholder={customer.phone ? `默认 ${customer.phone.replace(/\D/g, '')}` : '账号（没电话就自己填）'} value={login} onChange={(e) => setLogin(e.target.value)} />
          <button type="button" className="btn sm primary" onClick={() => run('账号已开通', `select app.account_open($1,$2)`, [customer.id, login || null], true)}>开通账号</button></>}
        {acc && <>
          <button type="button" className="btn sm" onClick={() => run('已重置，新临时密码只显示这一次', `select app.account_reset($1)`, [acc.id], true)}>重置密码</button>
          {acc.status === 'active'
            ? <button type="button" className="btn sm" onClick={() => run('已冻结，这个账号马上用不了', `select app.account_set_status($1,'frozen',null)`, [acc.id])}>冻结</button>
            : <button type="button" className="btn sm primary" onClick={() => run('已解冻', `select app.account_set_status($1,'active',null)`, [acc.id])}>解冻</button>}
          <button type="button" className="btn sm ghost" onClick={() => setChg(true)}>换账号</button></>}
      </div>
      {acc && ev.filter((e) => e.kind === 'pw_changed' && !e.acked_at).map((e) => (
        <div key={e.id} className="banner warn small row" style={{ gap: 8 }}>客户 {dt(e.at)} 自己改了密码。确认是本人操作就点「知道了」；不是本人就点「冻结」。
          <span className="grow" /><button type="button" className="btn sm" onClick={() => run('已确认', `select app.account_ack($1)`, [e.id])}>知道了</button></div>))}
      {acc && ev.length > 0 && <details className="small"><summary>账号记录（{ev.length}）</summary>
        <ul className="plain">{ev.map((e) => <li key={e.id}>{dt(e.at)} · {EV[e.kind] || e.kind}{e.note ? ` · ${e.note}` : ''}</li>)}</ul></details>}
      {!acc && <div className="hint small">账号默认用客户手机号。开通后系统给一个临时密码，只显示一次，发给客户；客户第一次登录要改成自己的密码。部署前这个账号只能在本浏览器里试登录。</div>}
      {pw && (
        <Modal title="临时密码（只显示这一次）" onClose={() => setPw(null)}
          footer={<><button type="button" className="btn" onClick={() => setPw(null)}>我记下了</button>
            <button type="button" className="btn primary" onClick={async () => { await copyText(msg(pw)); toast('通知消息已复制，去 WhatsApp 发给客户'); }}>复制通知消息</button></>}>
          <div className="stack">
            <div className="pwbig mono">{pw}</div>
            <div className="hint">关掉这个窗口就再也看不到了（系统只存加密后的密码）。客户忘了就再点「重置密码」。部署后可以直接用 WhatsApp 自动发给客户。</div>
            <pre className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--gray-bg)', padding: 10, borderRadius: 8 }}>{msg(pw)}</pre>
          </div>
        </Modal>)}
      {chg && (
        <Modal title="换账号" onClose={() => setChg(false)}
          footer={<><button type="button" className="btn" onClick={() => setChg(false)}>取消</button>
            <button type="button" className="btn primary" disabled={!login.trim()} onClick={async () => { await run('账号已改', `select app.account_set_login($1,$2)`, [acc.id, login]); setChg(false); }}>保存</button></>}>
          <div className="field"><label>新账号（手机号或别的）</label><input className="in" value={login} onChange={(e) => setLogin(e.target.value)} /></div>
          <div className="hint">换账号等于换人在用这个客户的账、看他的欠款，所以只有中方能换。密码不变。</div>
        </Modal>)}
    </div>
  );
}
