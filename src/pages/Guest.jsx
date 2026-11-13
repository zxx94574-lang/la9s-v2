// 客户入口 (Frank 11-01): 一个总链接 → 登录页, 两种进入:
//  ① 账号登录: 账号 (默认手机号) + 密码, 可以「记住我」; 忘了 / 想改密码 → 手机验证码自己改, 改完自动生效, 中方收到通知
//  ② 游客: 自己选销售员 (员工编号 + 全名) → 选货 (只看有没有货, 不看价格) → 两个按钮:
//     「提交询价」要填电话 / 店名 / 城市 / 称呼 → 自动建潜客 (挂选的销售员) + 已报价单 → 热线马上跟进
//     「复制清单图片」什么都不用填 → 一张清单图 (带销售员编号和时间, 不带价格), 自己发 WhatsApp 给销售员
// 现在这版没有服务器: 登录在本浏览器里验证; 验证码没法真的发到手机, 演示时直接显示在页面上 (部署后改成 WhatsApp / 短信发).
import React, { useMemo, useRef, useState } from 'react';
import { toBlob } from 'html-to-image';
import { callAnon, setCustomerSession, getOrg, REAL } from '../db/client.js';
import { useApp, useData, Pill, Modal } from '../components/ui.jsx';
import { friendlyError, dt } from '../lib/format.js';

// 230 / 231 (Frank 11-11): 客户端只有两种 —— 有货 (绿) / 可预订 (不叫无货, 不显示少量和数量); 点了可预订的照样能下, 差的自动记进未满足需求
const BAND = { ok: ['有货 · En stock', 'green'], low: ['有货 · En stock', 'green'], none: ['可预订 · Sur commande', 'amber'] };
const T = (zh, fr) => <>{zh}<span className="fr"> · {fr}</span></>;

function Shell({ children, sub }) {
  return (
    <div className="gshell">
      <header className="ghead"><img src="./la9s-logo.png" alt="LA&9S" /><span>{sub}</span></header>
      <main className="gmain">{children}</main>
    </div>
  );
}

export function CustomerLogin() {
  const { go, toast, setRole } = useApp();
  const [tab, setTab] = useState('acc');
  const [f, setF] = useState({ login: '', pw: '', remember: true });
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const login = async () => {
    setBusy(true);
    try {
      const [{ r }] = await callAnon(`select app.account_login($1,$2) as r`, [f.login, f.pw]);
      setCustomerSession({ ...r, login: f.login }, f.remember);
      setRole('boss', true);
      toast(r.must_change ? '登录成功。你用的是临时密码，请先改成自己的密码' : '登录成功');
      go(r.must_change ? 'login/change' : 'p/shop');
    } catch (e) { toast(friendlyError(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Shell sub="Commande client · 客户下单">
      <div className="gcard">
        <div className="seg" style={{ width: '100%' }}>
          <button type="button" className={tab === 'acc' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setTab('acc')}>账号登录 · Compte</button>
          <button type="button" className={tab === 'guest' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setTab('guest')}>游客 · Visiteur</button>
        </div>
        {tab === 'acc' ? (
          <div className="stack" style={{ gap: 10, marginTop: 14 }}>
            <div className="field"><label>{T('账号（手机号）', 'Téléphone / identifiant')}</label>
              <input className="in" autoComplete="username" inputMode="tel" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></div>
            <div className="field"><label>{T('密码', 'Mot de passe')}</label>
              <input className="in" type="password" autoComplete="current-password" value={f.pw} onChange={(e) => setF({ ...f, pw: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && login()} /></div>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.remember} onChange={(e) => setF({ ...f, remember: e.target.checked })} />{T('记住我，下次不用再登录', 'Rester connecté')}</label>
            <button type="button" className="btn primary lg" disabled={busy || !f.login || !f.pw} onClick={login}>{busy ? '…' : '登录 · Se connecter'}</button>
            <button type="button" className="btn ghost sm" onClick={() => setForgot(true)}>{T('忘记密码 / 改密码', 'Mot de passe oublié')}</button>
            <div className="hint">还没有账号？先用「游客」询价，成为我们的客户后，LA&9S 会给你开账号。</div>
            {!REAL && <div className="hint">演示账号：CAMARA <b className="mono">0700112233</b> / <b className="mono">demo1234</b></div>}
          </div>
        ) : (
          <div className="stack" style={{ gap: 10, marginTop: 14 }}>
            <p className="small">不用账号也能看我们有什么货、问价格。<br /><span className="muted">Sans compte : voir le stock et demander un prix.</span></p>
            <button type="button" className="btn primary lg" onClick={() => go('g')}>进入选货 · Entrer</button>
          </div>)}
      </div>
      {forgot && <ChangePassword initialLogin={f.login} onClose={() => setForgot(false)} />}
    </Shell>
  );
}

export function ChangePassword({ initialLogin = '', onClose, embedded }) {
  const { toast } = useApp();
  const [login, setLogin] = useState(initialLogin);
  const [demoCode, setDemoCode] = useState(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState(['', '']);
  const send = async () => {
    try { const [{ c }] = await callAnon(`select app.account_send_otp($1) as c`, [login]); setDemoCode(c); toast('验证码已发送'); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const save = async () => {
    if (pw[0] !== pw[1]) return toast('两次输入的新密码不一样', 'err');
    try { await callAnon(`select app.account_change_password($1,$2,$3)`, [login, code, pw[0]]); toast('密码已改好，下次用新密码登录'); onClose?.(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  const body = (
    <div className="stack" style={{ gap: 10 }}>
      <div className="field"><label>账号（手机号）</label><div className="row" style={{ gap: 6 }}>
        <input className="in" inputMode="tel" value={login} onChange={(e) => setLogin(e.target.value)} />
        <button type="button" className="btn" disabled={!login} onClick={send}>发验证码</button></div></div>
      {demoCode && <div className="banner info small">验证码会发到账号绑定的手机（部署后用 WhatsApp / 短信）。现在没有服务器发不出去，演示用：<b className="mono">{demoCode}</b>，5 分钟内有效。</div>}
      <div className="field"><label>验证码</label><input className="in mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></div>
      <div className="field"><label>新密码（至少 6 位）</label><input className="in" type="password" autoComplete="new-password" value={pw[0]} onChange={(e) => setPw([e.target.value, pw[1]])} /></div>
      <div className="field"><label>再输一次</label><input className="in" type="password" autoComplete="new-password" value={pw[1]} onChange={(e) => setPw([pw[0], e.target.value])} /></div>
      <div className="hint">改好马上生效；LA&9S 会收到通知，必要时会跟你确认是不是本人操作。</div>
      <button type="button" className="btn primary" disabled={code.length !== 6 || pw[0].length < 6} onClick={save}>改密码</button>
    </div>);
  return embedded ? body : <Modal title="忘记密码 / 改密码" onClose={onClose}>{body}</Modal>;
}

export function MustChange() {
  const { go } = useApp();
  return (
    <Shell sub="Changer le mot de passe · 改密码">
      <div className="gcard"><h3 style={{ marginTop: 0 }}>请先把临时密码改成你自己的密码</h3>
        <ChangePassword embedded initialLogin={JSON.parse(localStorage.getItem('la9s.cust') || sessionStorage.getItem('la9s.cust') || '{}').login || ''} onClose={() => go('p/shop')} />
        <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => go('p/shop')}>以后再改</button></div>
    </Shell>
  );
}

// ───────── 游客选货 ─────────
export function GuestShop() {
  const { toast } = useApp();
  const org = getOrg();
  const { data } = useData(async () => {
    const [sales, cat] = await Promise.all([callAnon(`select * from app.guest_sales($1)`, [org]), callAnon(`select * from app.guest_catalog($1) order by cat_sort, model`, [org])]);
    return { sales, cat };
  }, [org]);
  const [salesId, setSalesId] = useState(() => { try { return localStorage.getItem('la9s.guest.sales') || ''; } catch { return ''; } });
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [cart, setCart] = useState({});
  const [free, setFree] = useState({ model: '', category_id: '', qty: '' });
  const [extra, setExtra] = useState([]);
  const [submit, setSubmit] = useState(false);
  const [done, setDone] = useState(null);
  const sheet = useRef();
  const cats = useMemo(() => [...new Map((data?.cat || []).map((p) => [p.category_id, p.category])).entries()], [data]);
  if (!data) return <Shell sub="Visiteur · 游客"><div className="empty">加载中…</div></Shell>;
  const t = text.trim().toUpperCase();
  const list = data.cat.filter((p) => (!cat || p.category_id === cat) && (!t || p.model.includes(t) || String(p.code).includes(t) || (p.shared_models || []).some((s) => s.includes(t))))
    .sort((a, b) => ({ ok: 0, low: 1, none: 2 }[a.band] ?? 3) - ({ ok: 0, low: 1, none: 2 }[b.band] ?? 3)).slice(0, 80);   // 230: 有货的排前面, 可预订的沉底
  const byId = Object.fromEntries(data.cat.map((p) => [p.id, p]));
  const items = Object.entries(cart).filter(([, n]) => Number(n) > 0).map(([id, n]) => ({ p: byId[id], qty: Number(n) }));
  const n = items.length + extra.length;
  const sp = data.sales.find((s) => s.id === salesId);
  const pickSales = (v) => { setSalesId(v); try { localStorage.setItem('la9s.guest.sales', v); } catch { /* */ } };
  const lines = () => [...items.map((x) => ({ product_id: x.p.id, qty: x.qty })), ...extra.map((x) => ({ model: x.model, category_id: x.category_id, qty: x.qty }))];
  const copyImage = async () => {
    try {
      const blob = await toBlob(sheet.current, { pixelRatio: 2, backgroundColor: '#fff' });
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('清单图片已复制，去 WhatsApp 粘贴发给销售员'); }
      catch {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'LA9S-liste.png'; a.click();
        toast('浏览器不让复制，已改成保存图片，发给销售员');
      }
    } catch (e) { toast('生成图片失败', 'err'); }
  };
  if (done) return (
    <Shell sub="Visiteur · 游客"><div className="gcard"><h2 style={{ marginTop: 0 }}>✓ 已收到 · Reçu</h2>
      <p>询价单号 <b className="mono">{done}</b>。我们的热线会尽快用你留的电话 / WhatsApp 联系你报价。</p>
      <p className="muted small">Notre équipe vous contactera rapidement par téléphone / WhatsApp.</p>
      <button type="button" className="btn" onClick={() => { setDone(null); setCart({}); setExtra([]); }}>再问一单</button></div></Shell>);
  return (
    <Shell sub="Visiteur · 游客">
      <div className="gcard stack" style={{ gap: 10 }}>
        <div className="field"><label>{T('你的销售员', 'Votre commercial')}</label>
          <select className="in" value={salesId} onChange={(e) => pickSales(e.target.value)}>
            <option value="">— 选一个 · Choisir —</option>
            {data.sales.map((s) => <option key={s.id} value={s.id}>{s.emp_no ? `${s.emp_no} · ` : ''}{s.full_name}</option>)}
            <option value="none">没有 / 不知道 · Aucun</option></select></div>
        <input className="in" placeholder="⌕ 型号 / 编码 · Modèle" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="chips"><button type="button" className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>全部</button>
          {cats.map(([id, name]) => <button type="button" key={id} className={`chip ${cat === id ? 'on' : ''}`} onClick={() => setCat(id)}>{name}</button>)}</div>
      </div>
      <div className="plist">
        {list.map((p) => {
          const [bl, bt] = BAND[p.band];
          return (
            <div key={p.id} className={`pitem ${Number(cart[p.id]) > 0 ? 'on' : ''}`}>
              <div className="grow"><b>{p.model}</b><div className="small muted">{p.category} · {p.code}{p.shared_models?.length ? ` · ${p.shared_models.slice(0, 3).join(' / ')}` : ''}</div>
                <div style={{ marginTop: 4 }}><Pill tone={bt}>{bl}</Pill></div></div>
              <div className="qty-step">
                <button type="button" onClick={() => setCart((c) => ({ ...c, [p.id]: Math.max(0, Number(c[p.id] || 0) - 5) }))}>−</button>
                <input inputMode="numeric" value={cart[p.id] || ''} placeholder="0" onChange={(e) => setCart((c) => ({ ...c, [p.id]: e.target.value.replace(/\D/g, '') }))} />
                <button type="button" onClick={() => setCart((c) => ({ ...c, [p.id]: Number(c[p.id] || 0) + 5 }))}>＋</button>
              </div>
            </div>);
        })}
        {list.length === 0 && <div className="empty">没找到？在下面写型号 · Pas trouvé ? Écrivez le modèle ci-dessous</div>}
      </div>
      <div className="gcard row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="small muted">没找到的型号 · Autre modèle</span>
        <select className="in" style={{ maxWidth: 140 }} value={free.category_id} onChange={(e) => setFree({ ...free, category_id: e.target.value })}><option value="">种类 · Type</option>{cats.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <input className="in" placeholder="型号 · Modèle" value={free.model} onChange={(e) => setFree({ ...free, model: e.target.value.toUpperCase() })} style={{ maxWidth: 160 }} />
        <input className="in" inputMode="numeric" placeholder="数量" value={free.qty} onChange={(e) => setFree({ ...free, qty: e.target.value.replace(/\D/g, '') })} style={{ maxWidth: 80 }} />
        <button type="button" className="btn sm" disabled={!free.model || !free.qty || !free.category_id} onClick={() => { setExtra((x) => [...x, { ...free, category: cats.find(([id]) => id === free.category_id)?.[1], qty: Number(free.qty) }]); setFree({ model: '', category_id: free.category_id, qty: '' }); }}>加入</button>
        {extra.map((x, i) => <Pill key={i} tone="blue">{x.category} {x.model} ×{x.qty}</Pill>)}
      </div>
      {n > 0 && (
        <div className="cartbar">
          <span><b>{n}</b> 个型号 · <b>{items.reduce((a, x) => a + x.qty, 0) + extra.reduce((a, x) => a + x.qty, 0)}</b> 件</span>
          <button type="button" className="btn" onClick={copyImage}>复制清单图片 · Copier</button>
          <button type="button" className="btn primary" onClick={() => setSubmit(true)}>提交询价 · Envoyer</button>
        </div>)}
      {/* 复制成图片用的清单 (不带价格) */}
      <div style={{ position: 'fixed', left: -9999, top: 0 }}>
        <div ref={sheet} className="gsheet">
          <div className="row between"><b style={{ color: '#0447b0', fontSize: 18 }}>LA&9S</b><span className="small">Liste de besoins · 询价清单</span></div>
          <div className="small" style={{ margin: '6px 0 10px' }}>{dt(new Date())} · 销售员 Commercial：{sp ? `${sp.emp_no ? sp.emp_no + ' · ' : ''}${sp.full_name}` : '—'}</div>
          <table className="t"><thead><tr><th>#</th><th>编码</th><th>种类</th><th>型号</th><th style={{ textAlign: 'center' }}>数量</th></tr></thead>
            <tbody>{items.map((x, i) => <tr key={x.p.id}><td>{i + 1}</td><td className="mono">{x.p.code}</td><td>{x.p.category}</td><td><b>{x.p.model}</b></td><td style={{ textAlign: 'center' }}>{x.qty}</td></tr>)}
              {extra.map((x, i) => <tr key={'e' + i}><td>{items.length + i + 1}</td><td>—</td><td>{x.category}</td><td><b>{x.model}</b></td><td style={{ textAlign: 'center' }}>{x.qty}</td></tr>)}</tbody></table>
          <div className="small muted" style={{ marginTop: 8 }}>价格由 LA&9S 报价 · Prix communiqué par LA&9S</div>
        </div>
      </div>
      {submit && <SubmitModal org={org} salesId={salesId === 'none' ? '' : salesId} lines={lines()} onClose={() => setSubmit(false)} onDone={(no) => { setSubmit(false); setDone(no); }} />}
    </Shell>
  );
}

function SubmitModal({ org, salesId, lines, onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ phone: '', shop: '', city: '', contact: '', note: '' });
  const [err, setErr] = useState(false);
  const ok = f.phone.replace(/\D/g, '').length >= 8 && f.shop.trim() && f.city.trim() && f.contact.trim();
  const go = async () => {
    setErr(true); if (!ok) return;
    try {
      const [{ no }] = await callAnon(`select app.guest_inquiry($1,$2,$3,$4) as no`, [org, JSON.stringify({ ...f, sales_id: salesId || null }), JSON.stringify(lines), f.note]);
      onDone(no);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const inp = (k, zh, fr, o = {}) => (
    <div className={`field ${o.req ? 'req' : ''}`}><label>{zh} · {fr}{o.req && ' *'}</label>
      <input className={`in ${err && o.req && !String(f[k]).trim() ? 'err' : ''}`} inputMode={o.mode} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>);
  return (
    <Modal title="提交询价 · Demande de prix" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={go}>提交 · Envoyer</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        {inp('phone', '电话 / WhatsApp', 'Téléphone', { req: true, mode: 'tel' })}
        {inp('shop', '店名', 'Boutique', { req: true })}
        {inp('city', '城市 / 市场', 'Ville / marché', { req: true })}
        {inp('contact', '怎么称呼你', 'Votre nom', { req: true })}
        {inp('note', '备注', 'Note')}
        <div className="hint">提交后热线会马上联系你报价。只是先问问、不想留信息的话，关掉这个窗口，点「复制清单图片」发给销售员就行。</div>
      </div>
    </Modal>
  );
}
