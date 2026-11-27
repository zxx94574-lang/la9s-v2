import { AskButton, NewMenu } from './components/AskBox.jsx';
import { ActionSheet, MoreSheet } from './components/MobileSheet.jsx';
import { installScrollLayers } from './lib/scrollLayers.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openDb, resetDemo, q, call, isPersistent, REAL, TEST, SERVER, serverMe, setCustomerSession, customerSession } from './db/client.js';
import { logout } from './db/server.js';
import { StaffLogin, doLogout } from './components/StaffLogin.jsx';
import { CustomerLogin, GuestShop, MustChange } from './pages/Guest.jsx';
import * as Q from './db/queries.js';
import Kpi from './pages/Kpi.jsx';
import MarginPage from './pages/MarginPage.jsx';
import RulesPage from './pages/RulesPage.jsx';
import CodeReview from './pages/CodeReview.jsx';
import Report from './pages/Report.jsx';
import { Changes, Health } from './pages/Changes.jsx';
import Decisions from './pages/Decisions.jsx';
import PoProfit from './pages/PoProfit.jsx';
import Bins from './pages/Bins.jsx';
import { DirectiveGate, DirBar } from './components/Directives.jsx';
import { resetPeriods, Ctx, Modal, useToasts, Info, useStickyPagehead, useInstantTips, useExplainDisabled } from './components/ui.jsx';
import { ArchiveHost } from './components/Archives.jsx';
import { ExportPanel } from './components/SettingsPanels.jsx';
import { loadAllOpts } from './components/Opts.jsx';
import { RouteIcon, Icon, setIconOverride } from './components/Icons.jsx';
import { loadGridAlign } from './lib/gridPrefs.js';
import { ROLES, setPermOverride, setPriceRules, hasAny } from './lib/domain.js';
import { t, getLang, setLang as setLangStore, LANGS, domTranslate } from './lib/i18n.js';
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
import CnFinance from './pages/CnFinance.jsx';
import PoPage from './pages/Po.jsx';
import Attendance from './pages/Attendance.jsx';
import Staff from './pages/Staff.jsx';
import Sop from './pages/Sop.jsx';
import Kingdee from './pages/Kingdee.jsx';
import { StoresHq, PortalShop, PortalOrders, PortalBalance, PortalStores } from './pages/Portal.jsx';
import { ShopPos, ShopStock, CustomerAccounts } from './components/Shop.jsx';
import { buildNav, NavEditor, HubTabs, hubOf, ITEMS, visibleTo } from './components/Nav.jsx';

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
  useInstantTips();      // 442: 鼠标提示马上出
  useStickyPagehead();   // 426: 所有页面的表头往下滑时冻结
  const [role, setRoleState] = useState(() => store.get('la9s.role', 'admin'));
  const [tick, setTick] = useState(0);
  const [toast, toastView] = useToasts();
  useExplainDisabled(toast);   // 11-27: 点灰掉的主按钮 → 说还差什么
  const [settings, setSettings] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => store.get('la9s.navgroups3', {}));
  const [navCfg, setNavCfg] = useState(null);
  const [navEdit, setNavEdit] = useState(false);
  const [msheet, setMsheet] = useState(null);   // 11-26 手机底栏：new 新建 / view 看单 / more 全部功能
  const [sideW, setSideW] = useState(() => store.get('la9s.sidew', 236));
  const [todoCount, setTodoCount] = useState(0);
  const [overdueN, setOverdueN] = useState(0);
  const [lang, setLangState] = useState(getLang);
  useEffect(() => { domTranslate(); }, [lang]);
  useEffect(() => installScrollLayers(), []);   // 11-26 界面分层：上层里滑不带动后面

  useEffect(() => {
    openDb((msg) => setBoot((b) => ({ ...b, msg }))).then(({ org }) => {
      setOrg(org);
      if (SERVER) {   // 线上: 岗位只能是这个账号本身有的那几个
        const mine = serverMe().roles.filter((r) => ROLES[r]);
        setRoleState((cur) => { const r = mine.includes(cur) ? cur : mine[0] || 'viewer'; store.set('la9s.role', r); return r; });
      }
      setBoot({ ready: true });
    })
      .catch((e) => { console.error(e); setBoot({ ready: false, err: e.message || String(e), needLogin: !!e.needLogin, noMember: !!e.noMember }); });
  }, []);
  // 返回 / 前进 (Frank 11-12 260–262): 自己记一条「去过哪」的线, 每一站记 网址 + 滚到哪 + 当时开着哪张档案.
  // 返回 = 回到上一站, 档案和位置原样摆回去; 前进 = 回到刚才那一站. 浏览器 / 手机自带的返回键走同一套.
  const hist = useRef({ list: [{ hash: location.hash, y: 0, arch: null }], i: 0 });
  const archRef = useRef(null); const navIntent = useRef(0);
  const [navPos, setNavPos] = useState({ back: false, fwd: false });
  useEffect(() => {
    const f = () => {
      const h = hist.current; const cur = h.list[h.i]; const to = location.hash;
      if (cur.hash === to) return;
      cur.arch = archRef.current;   // 离开这一站时开着的档案 (y 由 scroll 监听随时记)
      let restore = null;
      const want = navIntent.current; navIntent.current = 0;   // 按的是我们的 返回 / 前进, 还是普通点链接 (浏览器自带的返回键当作返回)
      if (want !== 1 && h.i > 0 && h.list[h.i - 1].hash === to) { h.i -= 1; restore = h.list[h.i]; }
      else if (want === 1 && h.i < h.list.length - 1 && h.list[h.i + 1].hash === to) { h.i += 1; restore = h.list[h.i]; }
      else { h.list = h.list.slice(0, h.i + 1).slice(-60); h.list.push({ hash: to, y: 0, arch: null }); h.i = h.list.length - 1; }
      setNavPos({ back: h.i > 0, fwd: h.i < h.list.length - 1 });
      setRoute(parseHash()); setDrawer(false);
      setArch(restore?.arch || null);   // 260: 从档案里跳去别的页 → 档案自己关掉; 返回时再摆出来
      const y = restore?.y || 0; window.scrollTo({ top: y });
      if (y > 0) { let n = 0; const t = setInterval(() => { n += 1; if (Math.abs(window.scrollY - y) < 4 || n > 25 || hist.current.list[hist.current.i] !== restore) return clearInterval(t); window.scrollTo({ top: y }); }, 120); }   // 页面数据还没出来时够不着, 多试几下
    };
    let st; const sc = () => { clearTimeout(st); st = setTimeout(() => { const h = hist.current; if (h.list[h.i].hash === location.hash) h.list[h.i].y = window.scrollY; }, 120); };
    window.addEventListener('hashchange', f); window.addEventListener('scroll', sc, { passive: true });
    return () => { window.removeEventListener('hashchange', f); window.removeEventListener('scroll', sc); };
  }, []);
  const navBack = useCallback(() => { const h = hist.current; if (h.i > 0) { navIntent.current = -1; location.hash = h.list[h.i - 1].hash || '#/'; } }, []);
  const navFwd = useCallback(() => { const h = hist.current; if (h.i < h.list.length - 1) { navIntent.current = 1; location.hash = h.list[h.i + 1].hash || '#/'; } }, []);
  useEffect(() => store.set('la9s.navgroups3', openGroups), [openGroups]);
  useEffect(() => { if (org) q(`select value from app.org_settings where org_id = $1 and key = 'nav'`, [org]).then((r) => setNavCfg(r[0]?.value || null)); }, [org, tick]);
  // 权限配置 (11-09): 开局和每次 refresh 读一遍, can() 立即按新配置走
  const [permTick, setPermTick] = useState(0);
  useEffect(() => { if (org) q(`select value from app.org_settings where org_id = $1 and key = 'price_rules'`, [org]).then((r) => setPriceRules(r[0]?.value)).catch(() => {}); }, [org, tick]);
  useEffect(() => { if (org) q(`select value from app.org_settings where org_id = $1 and key = 'perm_matrix'`, [org]).then((r) => { setPermOverride(r[0]?.value || {}); setPermTick((x) => x + 1); }).catch(() => {}); Promise.all([loadAllOpts(org), loadGridAlign(org), q(`select value from app.org_settings where org_id = $1 and key = 'nav_icons'`, [org]).then((r) => setIconOverride(r[0]?.value || {})).catch(() => {})]).then(() => setPermTick((x) => x + 1)); }, [org, tick]);
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
      setOverdueN(hasAny(role, ['admin', 'manager', 'hotline', 'sales_manager']) ? overdueList(rows).length : 0);
    });
  }, [org, role, tick]);

  // 未处理报价提醒 (Frank 11-07): 没点开每 5 分钟、点开过每 10 分钟, 同一张单; 正在看的那张不提醒, 退出没完成继续
  const remindRef = useRef({});
  useEffect(() => {
    if (!org || !hasAny(role, ['hotline', 'manager', 'admin'])) return undefined;
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
        if (due.length) toast(`☎ ${due.length} 张报价等确认客户：${due.slice(0, 3).map((d) => d.customer_name).join('、')}${due.length > 3 ? '…' : ''}（打开「待办」处理）`, 'err');
      } catch { /* 数据库还没好 */ }
    };
    check(); const t = setInterval(check, 60e3); return () => clearInterval(t);
  }, [org, role, toast]);

  // 0106 (Frank 11-27): 下班卡后锁系统 —— 本地员工打了下班卡 / 过了晚上截止 / 早上开门前, 进不了系统; 每分钟查一次, 打卡后马上查
  const [lock, setLock] = useState(null);
  useEffect(() => {
    if (!org || !boot.ready || customerSession()) return undefined;
    let alive = true;
    const chk = async () => { try { const [{ s }] = await call(role, `select app.offhours_state($1) as s`, [org]); if (alive) setLock(s?.locked ? s : null); } catch { /* 迁移还没到 / 数据库没好 */ } };
    chk(); const t = setInterval(chk, 60e3); window.addEventListener('la9s:punched', chk);
    return () => { alive = false; clearInterval(t); window.removeEventListener('la9s:punched', chk); };
  }, [org, role, boot.ready]);
  useEffect(() => { if (lock && SERVER) logout().catch(() => {}); }, [lock]);   // 线上: 真的退出登录 (明天要重新登)
  const go = useCallback((path) => { location.hash = '#/' + path; }, []);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // quiet = 客户自己登录 (不清登录状态, 不弹提示); 右上角手动切岗位 = 演示身份, 退出客户登录
  const setRole = useCallback((r, quiet) => {
    if (!quiet) setCustomerSession(null);
    setRoleState(r); store.set('la9s.role', r);
    if (!quiet) toast(`已切换为「${ROLES[r].label}」岗位`);
    setTick((x) => x + 1);
  }, [toast]);
  const changeLang = (l) => { setLangStore(l); setLangState(l); toast(t('语言') + ' · ' + LANGS.find((x) => x[0] === l)[1]); };
  const [arch, setArch] = useState(null);   // 点名字出档案 (全站一个宿主)
  const openArchive = useCallback((a) => setArch(a), []);
  useEffect(() => { archRef.current = arch; }, [arch]);
  const ctx = useMemo(() => ({ org, role, go, refresh, tick, toast, lang, setRole, openArchive }), [org, role, go, refresh, tick, toast, lang, setRole, openArchive]);

  if (!boot.ready && SERVER && (boot.needLogin || boot.noMember)) return <StaffLogin noMember={boot.noMember} />;
  if (lock) return <LockScreen lock={lock} demoSwitch={!SERVER ? () => { setLock(null); setRole('admin'); } : null} />;
  if (!boot.ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', textAlign: 'center', padding: 20 }}>
        <div>
          <img src="./la9s-logo.png" alt="LA&9S" style={{ width: 200 }} />
          {boot.err ? (
            <div className="card card-b" style={{ marginTop: 16, maxWidth: 520 }}>
              <h3>{SERVER ? '连不上服务器' : '演示数据库没能启动'}</h3>
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
  // 中国支持: 打开不是给它的页 (订单 / 客户 / 钱) 一律回到待办
  if (role === 'cn_support' && !['todo', 'sop', 'stock', 'po', 'purchase', 'replenish'].includes(page)) page = 'todo';
  if (role === 'cn_business' && !['todo', 'sop', 'stock', 'purchase'].includes(page)) page = 'todo';
  // 11-26 配权限：打开（或首页按钮落到）自己岗位看不到的页 → 回到我的待办（库管员、销售员的首页就是待办）
  const home = !portal && ITEMS.dashboard && !visibleTo('dashboard', role, navCfg) ? 'todo' : 'dashboard';
  if (!portal && ITEMS[page] && !page.startsWith('p/') && !visibleTo(page, role, navCfg)) page = 'todo';
  if (role === 'cn_finance' && !['todo', 'sop', 'po', 'cnfin'].includes(page)) page = 'todo';
  let view;
  switch (page) {
    case 'fob': view = <Fob id={id} key={id || 'list'} />; break;
    case 'inquiry': view = <Inquiry />; break;
    case 'purchase': view = <Purchase />; break;
    case 'po': view = <PoPage />; break;
    case 'cnfin': view = <CnFinance />; break;
    case 'attendance': view = <Attendance />; break;
    case 'kpi': view = <Kpi />; break;
    case 'margin': view = <MarginPage />; break;
    case 'poprofit': view = <PoProfit />; break;
    case 'report': view = <Report />; break;
    case 'changes': view = <Changes />; break;
    case 'decisions': view = <Decisions />; break;
    case 'health': view = <Health />; break;
    case 'rules': view = <RulesPage />; break;
    case 'codes': view = <CodeReview />; break;
    case 'staff': view = <Staff />; break;
    case 'sop': view = <Sop />; break;
    case 'kingdee': view = <Kingdee />; break;
    case 'stores': view = <StoresHq />; break;
    case 'p/shop': view = <PortalShop />; break;
    case 'p/pos': view = <ShopPos />; break;
    case 'p/stock': view = <ShopStock />; break;
    case 'accounts': view = <CustomerAccounts />; break;
    case 'p/orders': view = <PortalOrders />; break;
    case 'p/balance': view = <PortalBalance />; break;
    case 'p/stores': view = <PortalStores />; break;
    case 'todo': view = <Todo />; break;
    case 'quote/new': view = <QuoteNew />; break;
    case 'orders': view = <Orders />; break;
    case 'deal': view = <Deal id={id} key={id} />; break;
    case 'receipts': view = <Receipts preset={id} key={id || 'r'} />; break;
    case 'balances': view = <Balances />; break;
    case 'customer': view = <CustomerLedger id={id} key={id} />; break;
    case 'stock': view = <Stock />; break;
    case 'count': view = <Bins tab="count" key="count" />; break;
    case 'bins': view = <Bins key="bins" />; break;
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
  const active = (p) => page === p || (p === 'orders' && page === 'deal') || (p === 'balances' && page === 'customer') || (hubOf(p) && hubOf(p) === hubOf(page === 'count' ? 'bins' : page === 'customer' ? 'balances' : page));
  // 客户下单端: 底部导航换成 下单 / 订单 / 对账

  return (
    <Ctx.Provider value={ctx}>
      <div className="app" style={{ gridTemplateColumns: `${sideW}px minmax(0, 1fr)` }}>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
        <aside className={`side ${drawer ? 'open' : ''}`}>
          <div className="logo-box" onClick={() => go(home)}>
            <img src="./la9s-logo.png" alt="LA&9S" />
            <small>科特迪瓦 · 中方管理</small>
          </div>
          {nav.map((g) => {
            const isOpen = openGroups[g.id] !== false;
            return (
              <div key={g.id} className={`nav-group ${isOpen ? 'open' : ''}`}>
                <button type="button" className="gh" onClick={() => setOpenGroups((o) => ({ ...o, [g.id]: !isOpen }))}>{t(g.label)}<span className="chev">⌄</span></button>
                {isOpen && g.items.map((it) => (
                  <button type="button" key={it.route} className={`nav-item ${active(it.route) ? 'active' : ''}`} onClick={() => { resetPeriods(); go(it.route); }}>
                    <span className="ico"><RouteIcon route={it.route} /></span><span>{t(it.label)}</span>
                    {it.route === 'todo' && (overdueN > 0 || todoCount > 0) && <span className={`pill red ${overdueN ? 'hotpill' : ''}`} style={{ marginLeft: 'auto' }} title={overdueN ? `${overdueN} 张超过 24 小时没发货` : ''}>{overdueN ? `⏰${overdueN} · ` : ''}{todoCount}</span>}
                  </button>
                ))}
              </div>);
          })}
          {role === 'admin' && <button type="button" className="nav-item" style={{ marginTop: 8, color: 'var(--muted)' }} onClick={() => setNavEdit(true)}><span className="ico">⚙</span><span>调整侧栏</span></button>}
          <div className="side-foot">{TEST ? '测试版 · 测试数据，和真实版分开' : REAL ? '真实数据快照版' : 'v2 浏览器演示版 · 数据全部虚构'}<br />规则 = 正式版同一套 SQL</div>
          <div className="side-drag hide-m" onPointerDown={dragSide} title="拖动调宽度" />
        </aside>

        <div className="main">
          <header className="top">
            <div className="row top-left" style={{ gap: 10 }}>
              <button type="button" className="btn ghost show-m" style={{ padding: 6 }} onClick={() => setDrawer(true)} aria-label="菜单">☰</button>
              <img className="mlogo" src="./la9s-logo.png" alt="LA&9S" onClick={() => go(home)} />
              <span className="brand">LA&9S<small>{portal ? 'Commande client · 客户下单' : '科特迪瓦 · 中方管理'}</small></span>{TEST && <span className="pill red" style={{ marginLeft: 8 }} title="这里的单据都是测试数据，和真实版完全分开">测试版</span>}
              {!portal && <span className="navhist">
                <button type="button" className="btn sm" disabled={!navPos.back} onClick={navBack} title="回到上一页（档案、滚到哪都照原样）">←<span className="nh-l"> 返回</span></button>
                <button type="button" className="btn sm hide-m" disabled={!navPos.fwd} onClick={navFwd} title="回到刚才那一页"><span className="nh-l">前进 </span>→</button>
              </span>}
            </div>
            {!portal && <AskButton />}
            <div className="top-actions">
              {cust && <button type="button" className="btn sm" onClick={() => { setCustomerSession(null); go('login'); setTick((x) => x + 1); }} title={cust.login}>退出登录</button>}
              {!portal && <NewMenu />}
              {!portal && <button type="button" className="btn icon-btn hide-m" onClick={() => go('todo')} aria-label="待办" title="我的待办">
                🔔{(overdueN > 0 || todoCount > 0) && <span className={`badge ${overdueN ? 'hot' : ''}`} title={overdueN ? `${overdueN} 张超过 24 小时没发货` : ''}>{overdueN || todoCount}</span>}
              </button>}
              <button type="button" className="set-btn" onClick={() => setSettings(true)} aria-label="设置" title="设置：语言、岗位、规则、导出、数据">⚙<span className="set-role">{t(ROLES[role]?.label || '')}</span></button>
            </div>
          </header>

          <main className="content">
            {/* Frank 11-11 (224 ⑤): 说明小字不占版面, 收进右上角 ⓘ; 只有「存不住数据」这种真问题才显示红条 */}
            {!isPersistent() && <div className="demo-banner"><span className="dot warn" /><span>浏览器禁止存储，关闭页面后数据会重置</span></div>}
            {org && !portal && <HubTabs page={page} role={role} cfg={navCfg} go={go} />}
            {org && !portal && page !== 'todo' && <DirBar />}
            {view}
            {org && !['boss', 'clerk'].includes(role) && <DirectiveGate />}
            <FlowPrompt role={role} />
          </main>
        </div>

        {portal ? (
        <nav className="mnav">
          <button type="button" className={page === 'p/shop' ? 'on' : ''} onClick={() => go('p/shop')}><b><RouteIcon route="p/shop" size={20} /></b>下单</button>
          <button type="button" className={page === 'p/orders' ? 'on' : ''} onClick={() => go('p/orders')}><b><RouteIcon route="p/orders" size={20} /></b>订单</button>
          <button type="button" className={page === 'p/pos' ? 'on' : ''} onClick={() => go('p/pos')}><b><RouteIcon route="p/pos" size={20} /></b>收银</button>
          {role === 'boss' && <button type="button" className={page === 'p/balance' ? 'on' : ''} onClick={() => go('p/balance')}><b><RouteIcon route="p/balance" size={20} /></b>对账</button>}
          {role === 'boss' && <button type="button" className={page === 'p/stores' ? 'on' : ''} onClick={() => go('p/stores')}><b><RouteIcon route="p/stores" size={20} /></b>门店</button>}
        </nav>) : (
        <nav className="mnav">
          <button type="button" className={page === home && !msheet ? 'on' : ''} onClick={() => { setMsheet(null); go(home); }}><b><RouteIcon route="dashboard" size={20} /></b>首页</button>
          <button type="button" className={page === 'todo' && !msheet ? 'on' : ''} onClick={() => { setMsheet(null); go('todo'); }}><b><RouteIcon route="todo" size={20} /></b>待办{(overdueN > 0 || todoCount > 0) && <span className={`badge ${overdueN ? 'hot' : ''}`}>{overdueN || todoCount}</span>}</button>
          <button type="button" className={`plus ${msheet === 'new' ? 'on' : ''}`} onClick={() => setMsheet(msheet === 'new' ? null : 'new')} aria-label="新建"><b><Icon name="plus" size={20} /></b>新建</button>
          <button type="button" className={msheet === 'view' || (!msheet && (active('orders') || active('fob') || active('receipts'))) ? 'on' : ''} onClick={() => setMsheet(msheet === 'view' ? null : 'view')}><b><RouteIcon route="orders" size={20} /></b>订单</button>
          <button type="button" className={msheet === 'more' ? 'on' : ''} onClick={() => setMsheet(msheet === 'more' ? null : 'more')}><b><Icon name="list" size={20} /></b>更多</button>
        </nav>)}
      </div>

      {settings && (
        <Modal title="设置" onClose={() => setSettings(false)}>
          <div className="stack">
            <div className="field"><label>语言 <Info>已翻译：导航、岗位、订单状态、流程步骤、给客户的单据（报价单、销售单、Balance）。其余页面文字还是中文，按页面陆续补。</Info></label>
              <div className="seg">{LANGS.map(([k, l]) => <button type="button" key={k} className={lang === k ? 'on' : ''} onClick={() => changeLang(k)}>{l}</button>)}</div>

            </div>
            {/* 11-25 Frank：语言、岗位从顶栏挪进设置，给智能搜索腾地方 */}
            <div className="field"><label>{SERVER ? '我的岗位' : '当前岗位（演示：切换看每个人能做什么）'}</label>
              {SERVER && <div className="small muted" style={{ marginBottom: 6 }}>{serverMe()?.email}</div>}
              <div className="role-grid">{Object.entries(ROLES).filter(([k]) => !SERVER || serverMe()?.roles.includes(k)).map(([k, r]) => (
                <button type="button" key={k} className={`role-opt ${k === role ? 'on' : ''}`} onClick={() => { setRole(k); setSettings(false); }}><b>{t(r.label)}</b><small>{r.desc}</small></button>))}</div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                {!SERVER && <button type="button" className="btn sm" onClick={() => { setSettings(false); go('login'); }}>客户入口（登录 / 游客）</button>}
                {SERVER && <button type="button" className="btn sm" onClick={doLogout}>退出登录</button>}</div>
            </div>
            <div className="small muted">{REAL ? '真实数据快照：在这里操作只存在本浏览器，不会写回金蝶 / 飞书。' : '演示版 · 虚构数据。'}数据保存在本浏览器，刷新不丢。</div>
            {role === 'admin' && <LayoutSwitch onDone={() => setSettings(false)} />}
            {role === 'admin' && <div className="field"><label>规则与系统参数 <Info>所有阈值、开关、权限表、发货文件都在这一页：顶上按订单流程和日常工作排好，点哪个环节只看那里的规则。</Info></label><div><button type="button" className="btn" onClick={() => { setSettings(false); go('rules'); }}>打开规则与系统参数 ›</button> <button type="button" className="btn" onClick={() => { try { sessionStorage.setItem('la9s.rules.area', 'sys'); } catch { /* */ } setSettings(false); go('rules'); }}>权限表 · 发货文件 ›</button></div></div>}
            <ExportPanel />
            {!SERVER && <>
            <div className="field"><label>演示数据 <Info>{isPersistent() ? '数据存在本浏览器（IndexedDB），换设备不同步。' : '当前浏览器不允许存储。'}</Info></label>
              <div className="row">
                <ResetButton onReset={async () => { const o = await resetDemo(); setOrg(o); setSettings(false); refresh(); go('dashboard'); toast('演示数据已重置'); }} />
              </div>
            </div></>}
          </div>
        </Modal>
      )}
      {msheet && msheet !== 'more' && <ActionSheet kind={msheet} onClose={() => setMsheet(null)} />}
      {msheet === 'more' && <MoreSheet cfg={navCfg} onClose={() => setMsheet(null)} onSettings={() => setSettings(true)} onMenu={() => setNavEdit(true)} />}
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

// 设置 → 布局编辑 (开发者级, 只中方): 打开后, 已接入的页面每个板块上方出现编辑条
function LayoutSwitch({ onDone }) {
  const on = useLayoutEdit();
  return (
    <div className="field"><label>布局编辑 <Info>只中方。调板块顺序、宽度（12 列对齐）、显示 / 隐藏、间距；每页单独保存，全员一致，定下来点「锁定为正式版」。现在接入：经营总览，其他页面陆续接。</Info></label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={`btn ${on ? '' : 'primary'}`} onClick={() => { setLayoutEdit(!on); onDone(); }}>{on ? '退出布局编辑' : '进入布局编辑'}</button>
      </div>
    </div>
  );
}

// 270 (Frank 11-12): 系统自动生成了一条流水 → 中方 / 财务问一句「要不要立即查看」; 本地员工只看到一句提示
function FlowPrompt({ role }) {
  const [msg, setMsg] = useState(null);
  useEffect(() => { const f = (e) => setMsg(e.detail); window.addEventListener('la9s:flow', f); return () => window.removeEventListener('la9s:flow', f); }, []);
  useEffect(() => { if (msg && !hasAny(role, ['admin', 'finance'])) { const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); } return undefined; }, [msg, role]);
  if (!msg) return null;
  if (!hasAny(role, ['admin', 'finance'])) return <div className="toast ok" style={{ position: 'fixed', left: '50%', bottom: 86, transform: 'translateX(-50%)', zIndex: 80 }}>{msg.text}</div>;
  return (
    <Modal title="已生成流水" onClose={() => setMsg(null)} footer={<><button type="button" className="btn" onClick={() => setMsg(null)}>不用，留在这里</button><span className="grow" /><button type="button" className="btn primary" onClick={() => { setMsg(null); window.location.hash = '#/' + msg.to; }}>立即查看 →</button></>}>
      <div>{msg.text}。是否立即查看？</div>
    </Modal>
  );
}

// 0106: 下班后锁屏 —— 线上会同时退出登录; 测试版留一个「切回中方」的口子 (不然演示时就卡住了)
function LockScreen({ lock, demoSwitch }) {
  const hm = lock.out_at ? new Date(lock.out_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' }) : '';
  const why = lock.reason === 'out' ? `你今天 ${hm} 已经打了下班卡`
    : lock.reason === 'late' ? `已经过了 ${lock.cutoff}，系统下班了` : '还没到上班时间';
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 20, textAlign: 'center' }}>
      <div className="card card-b stack" style={{ maxWidth: 380, gap: 14 }}>
        <img src="./la9s-logo.png" alt="LA&9S" style={{ width: 160, margin: '0 auto' }} />
        <h2 style={{ margin: 0 }}>{why}</h2>
        <div className="muted">明天 {lock.reopen || '06:00'} 以后再登录。<br />今晚确实还要用（盘点、急单），找中方在「打卡」页放行。</div>
        {SERVER ? <button type="button" className="btn primary" onClick={() => location.reload()}>好的</button>
          : demoSwitch && <button type="button" className="btn" onClick={demoSwitch}>测试版：切回中方看</button>}
      </div>
    </div>
  );
}
