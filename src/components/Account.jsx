// 客户下单账号 (只中方): 开通 → 临时密码只显示一次; 重置 / 冻结 / 解冻 / 换账号 / 看登录记录; 改密码通知「知道了」.
// 系统里只存加密后的密码, 谁都看不到原文 (中方也不行): 客户忘了就重置.
import React, { useState } from 'react';
import { q, call } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, Modal, Choice, Assumed } from './ui.jsx';
import { copyText } from './Doc.jsx';
import { dt, friendlyError } from '../lib/format.js';

const EV = { opened: '开通', reset: '中方重置密码', frozen: '冻结', unfrozen: '解冻', login: '登录', login_failed: '密码输错', pw_changed: '客户自己改了密码', otp_sent: '发验证码', login_changed: '换账号' };
export const ACC = { none: ['没开账号', 'gray'], active: ['已开通', 'green'], frozen: ['已冻结', 'red'] };

export function AccountPanel({ customer }) {
  const { org, role, toast, refresh } = useApp();
  const [pw, setPw] = useState(null);
  const [login, setLogin] = useState('');
  const [chg, setChg] = useState(false);
  const [opening, setOpening] = useState(false);
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
        {!acc && <button type="button" className="btn sm primary" onClick={() => setOpening(true)}>开通账号…</button>}
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
      {!acc && <div className="hint small">没开账号 = 这个客户只能像游客一样看「有货 / 少量 / 可预订」，看不到片数和价格。开账号要先定好他能看什么、写清为什么给他开。</div>}
      {acc && <PortalPerms c={customer} />}
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
      {opening && <OpenAccount customer={customer} onClose={() => setOpening(false)} onDone={(p) => { setOpening(false); setPw(p); refresh(); }} />}
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

// 11-19 Frank: 「客户账号能看什么」是账号自己的权限 —— 没账号 = 游客, 不存在「能看什么」; 有账号才有.
// 开账号是有条件的: 开的那一刻就要把三项权限一项一项定好 (不给默认值), 并写清为什么给他开.
export const PERMS = [['stock', '看具体库存片数', '不看 = 只显示 有货 / 少量 / 可预订'], ['price', '老板看自己的价', '只看他自己档位的价（有促销价就看促销价），永远看不到成本、别的档位、别人的成交价'], ['clerk_price', '店员（门店公用账号）看价', '']];
export const permOf = (c) => { const o = c.portal_opts || {}; return { stock: o.stock ?? true, price: o.price ?? true, clerk_price: o.clerk_price ?? false }; };

function OpenAccount({ customer, onClose, onDone }) {
  const { role, toast } = useApp();
  const [login, setLogin] = useState('');
  const [p, setP] = useState({});
  const [why, setWhy] = useState('');
  const missing = PERMS.filter(([k]) => p[k] == null).map(([, l]) => l);
  const ok = !missing.length && why.trim().length >= 2;
  const go = async () => {
    try {
      const r = await call(role, `select app.account_open($1,$2) as pw`, [customer.id, login.trim() || null]);
      await call(role, `select app.set_portal_opts($1,$2)`, [customer.id, JSON.stringify({ ...p, open_note: why.trim() })]);
      toast('账号已开通'); onDone(r[0].pw);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <Modal title={`给 ${customer.name} 开下单账号`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><span className="grow" />
        {!ok && <span className="why">{missing.length ? `还没定：${missing.join('、')}` : '写一下为什么给他开'}</span>}
        <button type="button" className="btn primary" disabled={!ok} onClick={go}>开通</button></>}>
      <div className="stack">
        <div className="field"><label>账号</label>
          <input className="in" placeholder={customer.phone ? `不填 = 用客户电话 ${customer.phone.replace(/\D/g, '')}` : '客户没电话，自己填一个'} value={login} onChange={(e) => setLogin(e.target.value)} /></div>
        <div className="field req"><label>他能看什么 <span className="small muted">每一项都要点一下，不给默认</span></label>
          <div className="stack" style={{ gap: 8 }}>{PERMS.map(([k, l, tip]) => (
            <div key={k} className="row" style={{ gap: 10, flexWrap: 'wrap' }}><span style={{ minWidth: 170 }}>{l}</span>
              <Choice size="sm" value={p[k] == null ? '' : p[k] ? 'y' : 'n'} onChange={(x) => setP({ ...p, [k]: x === 'y' })} options={[['y', '看'], ['n', '不看']]} />
              {tip && <span className="small muted grow">{tip}</span>}</div>))}</div></div>
        <div className="field req"><label>为什么给他开</label>
          <input className="in" placeholder="例：S 档大客户，每周拿货；老板要自己看库存下单" value={why} onChange={(e) => setWhy(e.target.value)} />
          <span className="hint">会记在账号记录里。<Assumed>开号条件现在只要求「三项权限逐项定 + 写原因」，系统不按档位自动拦。你要是想定成「只有 S / Wholesale 档才能开」这类硬条件，告诉我就加。</Assumed></span></div>
        <div className="hint small">开通后系统给一个临时密码，只显示一次，发给客户；客户第一次登录要改成自己的密码。部署前这个账号只能在本浏览器里试登录。</div>
      </div>
    </Modal>);
}

function PortalPerms({ c }) {
  const { role, toast, refresh } = useApp();
  const v = permOf(c);
  const set = async (k, val) => { try { await call(role, `select app.set_portal_opts($1,$2)`, [c.id, JSON.stringify({ [k]: val })]); toast('已保存，客户账号下次打开就按这个'); refresh(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <div className="acc-perms">
      <div className="small muted">这个账号能看什么{c.portal_opts?.open_note ? <>　·　开号原因：{c.portal_opts.open_note}</> : null}</div>
      <div className="kv-row">{PERMS.map(([k, l]) => (
        <span key={k} className="row" style={{ gap: 6 }}>{l} <Choice size="sm" value={v[k] ? 'y' : 'n'} onChange={(x) => set(k, x === 'y')} options={[['y', '看'], ['n', '不看']]} /></span>))}</div>
    </div>);
}
