import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openDb, resetDemo, q, isPersistent, REAL, setCustomerSession, customerSession } from './db/client.js';
import { CustomerLogin, GuestShop, MustChange } from './pages/Guest.jsx';
import * as Q from './db/queries.js';
import Kpi from './pages/Kpi.jsx';
import { DirectiveGate } from './components/Directives.jsx';
import { Ctx, Modal, useToasts, useOutside, Info } from './components/ui.jsx';
import { ArchiveHost } from './components/Archives.jsx';
import { ExportPanel, DocSettings, PermPanel } from './components/SettingsPanels.jsx';
import { ROLES, can, getThresholds, setThresholds, DEFAULT_THRESHOLDS, setPermOverride } from './lib/domain.js';
import { t, getLang, setLang as setLangStore, LANGS } from './lib/i18n.js';
import Dashboard from './pages/Dashboard.jsx';
import QuoteNew from './pages/QuoteNew.jsx';
import Deal from './pages/Deal.jsx';
import Orders from './pages/Orders.jsx';
import Todo, { todoFor, overdueList } from './pages/Todo.jsx';
import { setLayoutEdit, useLayoutEdit } from './components/Layout.jsx';
import Receipts from './pages/Receipts.jsx';
import Balances, { CustomerLedger } from './pages/Balances.jsx';
import Stock from './pages/Stock.jsx';
import Unmet from './pages/Unmet.jsx';
import Materials from './pages/Materials.jsx';
import Pricing from './pages/Pricing.jsx';
import Customers from './pages/Customers.jsx';
import Hotline from './pages/Hotline.jsx';
import Visits from './pages/Visits.jsx';
import Cash from './pages/Cash.jsx';
import Replenish from './pages/Replenish.jsx';
import Import from './pages/Import.jsx';
import Fob from './pages/Fob.jsx';
import Inquiry from './pages/Inquiry.jsx';
import Purchase from './pages/Purchase.jsx';
import Attendance from './pages/Attendance.jsx';
import Staff from './pages/Staff.jsx';
import Sop from './pages/Sop.jsx';
import Kingdee from './pages/Kingdee.jsx';
import { StoresHq, PortalShop, PortalOrders, PortalBalance, PortalStores } from './pages/Portal.jsx';
import { buildNav, NavEditor } from './components/Nav.jsx';

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

function parseHash() {
  const h = (location.hash || '#/dashboard').slice(2);
  const [page, id] = h.split('/');
  if (page === 'quote') return { page: 'quote/new', id: null };
  if (page === 'login') return { page: id === 'change' ? 'login/change' : 'login', id: null };
  if (page === 'p') { const [, sub, pid] = h.split('/'); return { page: 'p/' + (sub || 'shop'), id: pid || null }; }
  return { page: page || 'dashboard', id: id || null };
}

export default function App() {
  const [boot, setBoot] = useState({ ready: false, msg: '正在启动…', err: null });
  const [org, setOrg] = useState(null);
  const [route, setRoute] = useState(parseHash);
  const [role, setRoleState] = useState(() => store.get('la9s.role', 'admin'));
  const [tick, setTick] = useState(0);
  const [toast, toastView] = useToasts();
  const [settings, setSettings] = useState(false);
  const [roleMenu, setRoleMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => store.get('la9s.navgroups3', {}));
  const [navCfg, setNavCfg] = useState(null);
  const [navEdit, setNavEdit] = useState(false);
  const [sideW, setSideW] = useState(() => store.get('la9s.sidew', 236));
  const [todoCount, setTodoCount] = useState(0);
  const [overdueN, setOverdueN] = useState(0);
  const [lang, setLangState] = useState(getLang);
  const [askLang, setAskLang] = useState(null);
  const langRef = useOutside(!!askLang, () => setAskLang(null));
  const roleRef = useOutside(roleMenu, () => setRoleMenu(false));

  useEffect(() => {
    openDb((msg) => setBoot((b) => ({ ...b, msg }))).then(({ org }) => { setOrg(org); setBoot({ ready: true }); })
      .catch((e) => { console.error(e); setBoot({ ready: false, err: e.message || String(e) }); });
  }, []);
  useEffect(() => {
    const f = () => { setRoute(parseHash()); setDrawer(false); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f);
  }, []);
  useEffect(() => store.set('la9s.navgroups3', openGroups), [openGroups]);
  useEffect(() => { if (org) q(`select value from app.org_settings where org_id = $1 and key = 'nav'`, [org]).then((r) => setNavCfg(r[0]?.value || null)); }, [org, tick]);
  // 权限配置 (11-09): 开局和每次 refresh 读一遍, can() 立即按新配置走
  const [permTick, setPermTick] = useState(0);
  useEffect(() => { if (org) q(`select value from app.org_settings where org_id = $1 and key = 'perm_matrix'`, [org]).then((r) => { setPermOverride(r[0]?.value || {}); setPermTick((x) => x + 1); }).catch(() => {}); }, [org, tick]);
  // 侧栏宽度: 拖右边缘 (180–380), 每个人自己的
  const dragSide = (e) => {
    e.preventDefault(); const x0 = e.clientX, w0 = sideW;
    const mv = (ev) => setSideW(Math.max(180, Math.min(380, w0 + ev.clientX - x0)));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setSideW((w) => { store.set('la9s.sidew', w); return w; }); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    if (!org) return;
    q(Q.orders, [org, '2000-01-01', '2999-12-31']).then((rows) => {
      setTodoCount(rows.filter((d) => todoFor(role, d)).length);
      setOverdueN(['admin', 'manager', 'hotline', 'sales_manager'].includes(role) ? overdueList(rows).length : 0);
    });
  }, [org, role, tick]);

  // 未处理报价提醒 (Frank 11-07): 没点开每 5 分钟、点开过每 10 分钟, 同一张单; 正在看的那张不提醒, 退出没完成继续
  const remindRef = useRef({});
  useEffect(() => {
    if (!org || !['hotline', 'manager', 'admin'].includes(role)) return undefined;
    const check = async () => {
      try {
        const rows = await q(`select d.id, d.created_at, d.hotline_opened_at, d.hotline_busy_at, (select count(*) from app.deal_events ev where ev.deal_id = d.id and ev.action = 'hotline_busy')::int as busy_n, c.name as customer_name from app.deals d join app.customers c on c.id = d.customer_id
          where d.org_id = $1 and d.status = 'quoted' and d.kind = 'normal' and d.approval <> 'pending' and d.approval <> 'rejected'`, [org]);
        const cur = location.hash.match(/deal\/([\w-]+)/)?.[1];
        const now = Date.now(); const due = [];
        for (const d of rows) {
          if (d.id === cur) { remindRef.current[d.id] = now; continue; }
          if (d.busy_n >= 3) continue;                    // 235: 联系 3 次客户都忙 → 不再吵, 在待办绿色板块里等人决定
          // 235 (Frank 11-11): 点过「客户忙」的, 从那一刻起 30 分钟后再提醒一次, 不按 5 / 10 分钟
          const busyAt = d.hotline_busy_at ? new Date(d.hotline_busy_at).getTime() : 0;
          const iv = (busyAt ? 30 : d.hotline_opened_at ? 10 : 5) * 60e3;
          const last = Math.max(remindRef.current[d.id] ?? new Date(d.created_at).getTime(), busyAt);
          if (now - last >= iv) { due.push(d); remindRef.current[d.id] = now; }
        }
        if (due.length) toast(`☎ ${due.length} 张报价等热线确认：${due.slice(0, 3).map((d) => d.customer_name).join('、')}${due.length > 3 ? '…' : ''}（打开「待办」处理）`, 'err');
      } catch { /* 数据库还没好 */ }
    };
    check(); const t = setInterval(check, 60e3); return () => clearInterval(t);
  }, [org, role, toast]);

  const go = useCallback((path) => { location.hash = '#/' + path; }, []);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // quiet = 客户自己登录 (不清登录状态, 不弹提示); 右上角手动切岗位 = 演示身份, 退出客户登录
  const setRole = useCallback((r, quiet) => {
    if (!quiet) setCustomerSession(null);
    setRoleState(r); store.set('la9s.role', r); setRoleMenu(false);
    if (!quiet) toast(`已切换为「${ROLES[r].label}」岗位`);
    setTick((x) => x + 1);
  }, [toast]);
  const changeLang = (l) => { setLangStore(l); setLangState(l); setAskLang(null); toast(t('语言') + ' · ' + LANGS.find((x) => x[0] === l)[1]); };
  const [arch, setArch] = useState(null);   // 点名字出档案 (全站一个宿主)
  const openArchive = useCallback((a) => setArch(a), []);
  const ctx = useMemo(() => ({ org, role, go, refresh, tick, toast, lang, setRole, openArchive }), [org, role, go, refresh, tick, toast, lang, setRole, openArchive]);

  if (!boot.ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', textAlign: 'center', padding: 20 }}>
        <div>
          <img src="./la9s-logo.png" alt="LA&9S" style={{ width: 200 }} />
          {boot.err ? (
            <div className="card card-b" style={{ marginTop: 16, maxWidth: 520 }}>
              <h3>演示数据库没能启动</h3>
              <p className="muted small">{boot.err}</p>
              <p className="small">请用电脑或手机上的 Chrome / Safari 最新版打开。</p>
            </div>
          ) : <p className="muted" style={{ marginTop: 16 }}>{boot.msg}</p>}
        </div>
      </div>
    );
  }

  // 客户入口 (登录页 / 游客选货): 不要侧栏, 单独一页
  if (['login', 'login/change', 'g'].includes(route.page)) {
    return <Ctx.Provider value={ctx}>{route.page === 'login' ? <CustomerLogin /> : route.page === 'g' ? <GuestShop /> : <MustChange />}{toastView}</Ctx.Provider>;
  }
  const portal = ['boss', 'clerk'].includes(role);
  const cust = role === 'boss' ? customerSession() : null;
  const nav = buildNav(navCfg, role);
  let { page, id } = route;
  if (portal && !page.startsWith('p/')) page = 'p/shop';
  let view;
  switch (page) {
    case 'fob': view = <Fob id={id} key={id || 'list'} />; break;
    case 'inquiry': view = <Inquiry />; break;
    case 'purchase': view = <Purchase />; break;
    case 'attendance': view = <Attendance />; break;
    case 'kpi': view = <Kpi />; break;
    case 'staff': view = <Staff />; break;
    case 'sop': view = <Sop />; break;
    case 'kingdee': view = <Kingdee />; break;
    case 'stores': view = <StoresHq />; break;
    case 'p/shop': view = <PortalShop />; break;
    case 'p/orders': view = <PortalOrders />; break;
    case 'p/balance': view = <PortalBalance />; break;
    case 'p/stores': view = <PortalStores />; break;
    case 'todo': view = <Todo />; break;
    case 'quote/new': view = <QuoteNew />; break;
    case 'orders': view = <Orders />; break;
    case 'deal': view = <Deal id={id} key={id} />; break;
    case 'receipts': view = <Receipts preset={id} />; break;
    case 'balances': view = <Balances />; break;
    case 'customer': view = <CustomerLedger id={id} key={id} />; break;
    case 'stock': view = <Stock />; break;
    case 'unmet': view = <Unmet />; break;
    case 'materials': view = <Materials />; break;
    case 'pricing': view = <Pricing />; break;
    case 'customers': view = <Customers />; break;
    case 'hotline': view = <Hotline />; break;
    case 'visits': view = <Visits />; break;
    case 'cash': view = <Cash />; break;
    case 'replenish': view = <Replenish />; break;
    case 'import': view = <Import />; break;
    default: view = <Dashboard />;
  }
  const active = (p) => page === p || (p === 'orders' && page === 'deal') || (p === 'balances' && page === 'customer');
  // 客户下单端: 底部导航换成 下单 / 订单 / 对账

  return (
    <Ctx.Provider value={ctx}>
      <div className="app" style={{ gridTemplateColumns: `${sideW}px minmax(0, 1fr)` }}>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
        <aside className={`side ${drawer ? 'open' : ''}`}>
          <div className="logo-box" onClick={() => go('dashboard')}>
            <img src="./la9s-logo.png" alt="LA&9S" />
            <small>科特迪瓦 · 中方管理</small>
          </div>
          {nav.map((g) => {
            const isOpen = openGroups[g.id] !== false;
            return (
              <div key={g.id} className={`nav-group ${isOpen ? 'open' : ''}`}>
                <button type="button" className="gh" onClick={() => setOpenGroups((o) => ({ ...o, [g.id]: !isOpen }))}>{t(g.label)}<span className="chev">⌄</span></button>
                {isOpen && g.items.map((it) => (
                  <button type="button" key={it.route} className={`nav-item ${active(it.route) ? 'active' : ''}`} onClick={() => go(it.route)}>
                    <span className="ico">{it.ico}</span><span>{t(it.label)}</span>
                    {it.route === 'todo' && (overdueN > 0 || todoCount > 0) && <span className={`pill red ${overdueN ? 'hotpill' : ''}`} style={{ marginLeft: 'auto' }} title={overdueN ? `${overdueN} 张超过 24 小时没发货` : ''}>{overdueN ? `⏰${overdueN} · ` : ''}{todoCount}</span>}
                  </button>
                ))}
              </div>);
          })}
          {role === 'admin' && <button type="button" className="nav-item" style={{ marginTop: 8, color: 'var(--muted)' }} onClick={() => setNavEdit(true)}><span className="ico">⚙</span><span>调整侧栏</span></button>}
          <div className="side-foot">{REAL ? '真实数据快照版' : 'v2 浏览器演示版 · 数据全部虚构'}<br />规则 = 正式版同一套 SQL</div>
          <div className="side-drag hide-m" onPointerDown={dragSide} title="拖动调宽度" />
        </aside>

        <div className="main">
          <header className="top">
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn ghost show-m" style={{ padding: 6 }} onClick={() => setDrawer(true)} aria-label="菜单">☰</button>
              <img className="mlogo" src="./la9s-logo.png" alt="LA&9S" onClick={() => go('dashboard')} />
              <span className="brand">LA&9S<small>{portal ? 'Commande client · 客户下单' : '科特迪瓦 · 中方管理'}</small></span>
            </div>
            <div className="top-actions">
              <span style={{ position: 'relative' }} ref={langRef} className="lang-switch">
                <span className="seg sm">{LANGS.map(([k, l]) => <button type="button" key={k} className={lang === k ? 'on' : ''} title={l} onClick={() => k !== lang && setAskLang(k)}>{k === 'zh' ? '中' : k.toUpperCase()}</button>)}</span>
                {askLang && (
                  <div className="menu" style={{ right: 0, top: '115%', width: 230, padding: 10 }}>
                    <div className="small" style={{ marginBottom: 8 }}>切换到 <b>{LANGS.find((x) => x[0] === askLang)[1]}</b>？当前页面和填写内容不会丢。</div>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}><button type="button" className="btn sm" onClick={() => setAskLang(null)}>取消</button><button type="button" className="btn sm primary" onClick={() => changeLang(askLang)}>切换</button></div>
                  </div>
                )}
              </span>
              <span style={{ position: 'relative' }} ref={roleRef}>
                <button type="button" className="role-pill" onClick={() => setRoleMenu(!roleMenu)} title="演示用：切换岗位体验不同权限">
                  <span className="hide-m">{t('岗位')}：</span>{t(ROLES[role].label)} ▾
                </button>
                {roleMenu && (
                  <div className="menu" style={{ right: 0, top: '115%', width: 290 }}>
                    <div className="hint" style={{ padding: '6px 10px' }}>演示用：切换岗位，看每个人能做什么</div>
                    <button type="button" className="mi" onClick={() => { setRoleMenu(false); go('login'); }}><div><b>客户入口（登录 / 游客）</b><div className="small muted">销售员发给客户的那个总链接打开就是这一页</div></div></button>
                    {Object.entries(ROLES).map(([k, r]) => (
                      <button type="button" key={k} className={`mi ${k === role ? 'focus' : ''}`} onClick={() => setRole(k)}>
                        <div><b>{r.label}</b><div className="small muted">{r.desc}</div></div>
                      </button>
                    ))}
                  </div>
                )}
              </span>
              {cust && <button type="button" className="btn sm" onClick={() => { setCustomerSession(null); go('login'); setTick((x) => x + 1); }} title={cust.login}>退出登录</button>}
              {!portal && <button type="button" className="btn icon-btn" onClick={() => go('todo')} aria-label="待办" title="我的待办">
                🔔{(overdueN > 0 || todoCount > 0) && <span className={`badge ${overdueN ? 'hot' : ''}`} title={overdueN ? `${overdueN} 张超过 24 小时没发货` : ''}>{overdueN || todoCount}</span>}
              </button>}
              <Info>{REAL ? '真实数据快照（金蝶 10-19 库存 / 在途，飞书物料与客户；应收还没导）。在这里操作只存在本浏览器，不会写回金蝶 / 飞书。' : '演示版 · 虚构数据。'}数据保存在本浏览器，刷新不丢。未连接金蝶 / WhatsApp。</Info>
              <button type="button" className="btn icon-btn" onClick={() => setSettings(true)} aria-label="设置" title="设置">⚙</button>
            </div>
          </header>

          <main className="content">
            {/* Frank 11-11 (224 ⑤): 说明小字不占版面, 收进右上角 ⓘ; 只有「存不住数据」这种真问题才显示红条 */}
            {!isPersistent() && <div className="demo-banner"><span className="dot warn" /><span>浏览器禁止存储，关闭页面后数据会重置</span></div>}
            {view}
            {org && !['boss', 'clerk'].includes(role) && <DirectiveGate />}
          </main>
        </div>

        {portal ? (
        <nav className="mnav">
          <button type="button" className={page === 'p/shop' ? 'on' : ''} onClick={() => go('p/shop')}><b>＋</b>下单</button>
          <button type="button" className={page === 'p/orders' ? 'on' : ''} onClick={() => go('p/orders')}><b>≡</b>订单</button>
          {role === 'boss' && <button type="button" className={page === 'p/balance' ? 'on' : ''} onClick={() => go('p/balance')}><b>₣</b>对账</button>}
          {role === 'boss' && <button type="button" className={page === 'p/stores' ? 'on' : ''} onClick={() => go('p/stores')}><b>⌂</b>门店</button>}
        </nav>) : (
        <nav className="mnav">
          <button type="button" className={page === 'dashboard' ? 'on' : ''} onClick={() => go('dashboard')}><b>◫</b>首页</button>
          <button type="button" className={page === 'todo' ? 'on' : ''} onClick={() => go('todo')}><b>◉</b>待办{(overdueN > 0 || todoCount > 0) && <span className={`badge ${overdueN ? 'hot' : ''}`}>{overdueN || todoCount}</span>}</button>
          <button type="button" className="plus" onClick={() => go('quote/new')}><b>＋</b>报价</button>
          <button type="button" className={active('orders') ? 'on' : ''} onClick={() => go('orders')}><b>≡</b>订单</button>
          <button type="button" onClick={() => setDrawer(true)}><b>☰</b>更多</button>
        </nav>)}
      </div>

      {settings && (
        <Modal title="设置" onClose={() => setSettings(false)}>
          <div className="stack">
            <div className="field"><label>语言</label>
              <div className="seg">{LANGS.map(([k, l]) => <button type="button" key={k} className={lang === k ? 'on' : ''} onClick={() => changeLang(k)}>{l}</button>)}</div>
              <span className="hint">已翻译：导航、岗位、订单状态、流程步骤、给客户的单据（报价单、销售单、Balance）。其余页面文字还是中文，按页面陆续补。</span>
            </div>
            {role === 'admin' && <LayoutSwitch onDone={() => setSettings(false)} />}
            <Thresholds role={role} toast={toast} />
            <PermPanel />
            <ExportPanel />
            <DocSettings />
            <div className="field"><label>当前岗位（演示）</label>
              <select className="in" value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(ROLES).map(([k, r]) => <option key={k} value={k}>{r.label} — {r.desc}</option>)}</select>
            </div>
            <div className="field"><label>演示数据</label>
              <div className="row">
                <ResetButton onReset={async () => { const o = await resetDemo(); setOrg(o); setSettings(false); refresh(); go('dashboard'); toast('演示数据已重置'); }} />
                <span className="hint">{isPersistent() ? '数据存在本浏览器（IndexedDB），换设备不同步。' : '当前浏览器不允许存储。'}</span>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {navEdit && <NavEditor cfg={navCfg} onClose={() => setNavEdit(false)} />}
      <ArchiveHost arch={arch} onClose={() => setArch(null)} />
      {toastView}
    </Ctx.Provider>
  );
}

function ResetButton({ onReset }) {
  const [arm, setArm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!arm) return; const t = setTimeout(() => setArm(false), 4000); return () => clearTimeout(t); }, [arm]);
  return (
    <button type="button" className={`btn ${arm ? 'primary' : 'danger'}`} disabled={busy}
      onClick={async () => { if (!arm) { setArm(true); return; } setBusy(true); await onReset(); setBusy(false); setArm(false); }}>
      {busy ? '正在重置…' : arm ? '再点一次确认重置' : '↺ 重置演示数据'}
    </button>
  );
}

// 改价偏差预警阈值 (待改 18)：只有中方能改
function Thresholds({ role, toast }) {
  const [v, setV] = useState(getThresholds().map(String));
  const ok = can(role, 'settings_thresholds');
  const save = () => {
    const n = v.map(Number);
    if (!(n[0] > 0 && n[0] < n[1] && n[1] < n[2] && n[2] <= 100)) return toast('请按 黄 < 橙 < 红 填写百分比', 'err');
    setThresholds(n); toast('改价预警阈值已保存');
  };
  return (
    <div className="field"><label>改价偏差预警（和档位价比，%）</label>
      <div className="row" style={{ gap: 6 }}>
        {['黄', '橙', '红'].map((l, i) => <span key={l} className="row" style={{ gap: 4 }}>{l} ≥<input className="in" style={{ width: 64 }} disabled={!ok} inputMode="numeric" value={v[i]} onChange={(e) => { const x = [...v]; x[i] = e.target.value.replace(/\D/g, ''); setV(x); }} />%</span>)}
        {ok ? <><button type="button" className="btn sm primary" onClick={save}>保存</button><button type="button" className="btn sm" onClick={() => { setV(DEFAULT_THRESHOLDS.map(String)); setThresholds(DEFAULT_THRESHOLDS); }}>恢复 5/10/20</button></>
          : <span className="hint">只有中方能改</span>}
      </div>
      <span className="hint">单价为 0 一律红色拦住，只有选「赠品 / 样品」才放行。</span>
    </div>
  );
}

// 设置 → 布局编辑 (开发者级, 只中方): 打开后, 已接入的页面每个板块上方出现编辑条
function LayoutSwitch({ onDone }) {
  const on = useLayoutEdit();
  return (
    <div className="field"><label>布局编辑（只中方）</label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={`btn ${on ? '' : 'primary'}`} onClick={() => { setLayoutEdit(!on); onDone(); }}>{on ? '退出布局编辑' : '进入布局编辑'}</button>
        <span className="hint">调板块顺序、宽度（12 列对齐）、显示 / 隐藏、间距；每页单独保存，全员一致，定下来点「锁定为正式版」。颜色固定品牌蓝。现在接入：经营总览、新建询单 / 报价，其他页面陆续接。</span>
      </div>
    </div>
  );
}
