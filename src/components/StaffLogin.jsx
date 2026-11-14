// 线上版登录 (工号 + 密码). 演示账号: admin / manager / picker / hotline / finance / sales / sales_manager / cn_support
import React, { useState } from 'react';
import { login, logout } from '../db/server.js';

export async function doLogout() { await logout(); location.reload(); }

export function StaffLogin({ noMember }) {
  const [id, setId] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await login(id, pw); location.reload(); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
      <form onSubmit={go} className="card card-b stack" style={{ width: '100%', maxWidth: 380 }}>
        <img src="./la9s-logo.png" alt="LA&9S" style={{ width: 180, margin: '8px auto' }} />
        <div className="muted small" style={{ textAlign: 'center' }}>科特迪瓦业务系统 · 线上测试环境</div>
        {noMember && <div className="banner warn">这个账号还没有加入公司，请联系中方。<button type="button" className="btn sm" onClick={doLogout}>换个账号</button></div>}
        <div className="field"><label>工号 / 账号</label><input className="in" autoFocus autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} /></div>
        <div className="field"><label>密码</label><input className="in" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        {err && <div className="banner warn">{err}</div>}
        <button type="submit" className="btn primary" disabled={busy || !id || !pw}>{busy ? '登录中…' : '登录'}</button>
        <div className="small muted">忘记密码请找中方重置。</div>
      </form>
    </div>
  );
}
