import DebtBanner from '../components/DebtBanner.jsx';
import React, { useEffect, useState } from 'react';
import { q, call, callValue } from '../db/client.js';
import { USERS } from '../db/bootstrap.js';
import * as Q from '../db/queries.js';
import { useApp, useData, DatePicker, Modal, SortList, RateInput, Info, PageGear } from '../components/ui.jsx';
import ProductDrawer from '../components/ProductDrawer.jsx';
import { CustomerDrawer } from './Customers.jsx';
import { STEPS } from '../lib/domain.js';
import LineEntry, { lineTotals, finalizeLines, tierPrice } from '../components/LineEntry.jsx';
import CustomerSelect from '../components/CustomerSelect.jsx';
import { can, whoCan, seesPriceList } from '../lib/domain.js';
import { LayoutGrid, setLayoutEdit, useLayoutEdit } from '../components/Layout.jsx';
import { money, qty, today, friendlyError } from '../lib/format.js';

// 草稿 (Frank 11-13 294): 选了客户、填够 N 行 (规则参数 draft_rules.min_lines, 默认 5) 才自动存进系统; 一人一个客户只有一张;
// 订单总览「草稿」里能看到、点开接着做; 保存报价 = 草稿删掉, 单子进「进行中」; N 天没动自动删 (draft_rules.days).
export const OPEN_DRAFT = 'la9s.quote.openDraft';
const takeOpenDraft = () => { try { const v = sessionStorage.getItem(OPEN_DRAFT); sessionStorage.removeItem(OPEN_DRAFT); return v; } catch { return null; } };

export default function QuoteNew() {
  const { org, role, go, toast, refresh } = useApp();
  const edit = useLayoutEdit();
  const { data } = useData(async () => {
    const [customers, catalog, categories, [ord]] = await Promise.all([q(Q.customers, [org]), q(Q.catalog, [org]), q(Q.categories, [org]),
      q(`select value from app.org_settings where org_id = $1 and key = 'cat_order'`, [org])]);
    // 种类条顺序 (Frank 11-09 第 1 条): 中方排, 所有人同款; 没排的按原顺序接在后面
    const order = Array.isArray(ord?.value) ? ord.value : [];
    const sorted = [...categories].sort((a, b) => { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || 0; });
    return { customers, catalog, categories: sorted };
  }, [org]);

  const [date, setDate] = useState(today());
  const [customer, setCustomer] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [fxIn, setFxIn] = useState('');   // 外币报价: 汇率每张单手填 (1 CNY / USD = ? XOF), 不自动带
  const fx = currency !== 'XOF' && Number(fxIn) > 0 ? Number(fxIn) : null;
  const priced = currency === 'XOF' || !!fx;   // 外币没填汇率前不显示价格
  const [lines, setLines] = useState([]);
  const [priceOk, setPriceOk] = useState(false);   // 中方改价保存前提示过一次
  const [note, setNote] = useState('');
  const [errs, setErrs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState(null);        // 选了客户后发现有自己的草稿 → 问恢复不恢复
  const [draftId, setDraftId] = useState(null);
  const [openId] = useState(takeOpenDraft);              // 从订单总览「草稿」点进来的
  const [cellErrs, setCellErrs] = useState(null);     // {rowKey: {col: msg}} → 表格里红框 (Frank 11-09 第 4 条)
  const [prodOpen, setProdOpen] = useState(null);
  const [custOpen, setCustOpen] = useState(false);
  const [catOrderOpen, setCatOrderOpen] = useState(false);

  const realLines = lines.filter((l) => l.product || l.model);
  // 从「草稿」点进来: 直接摆回去
  useEffect(() => {
    if (!openId || !data) return;
    q(`select * from app.quote_drafts where id = $1`, [openId]).then(([d]) => { if (d) applyDraft(d); });
  }, [openId, !!data]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 选了客户: 看看自己有没有这个客户的草稿
  useEffect(() => {
    if (!customer || draftId || openId) return;
    let alive = true;
    q(`select * from app.quote_drafts where org_id = $1 and customer_id = $2 and user_id = $3`, [org, customer, USERS[role]]).then(([d]) => { if (alive) setRestore(d || null); });
    return () => { alive = false; };
  }, [customer, org, role, draftId, openId]);
  // 够行数就自动存 (停手 1.5 秒后)
  useEffect(() => {
    if (!customer || restore || realLines.length < 1) return;
    const h = setTimeout(() => {
      call(role, `select app.save_quote_draft($1,$2,$3) as id`, [org, customer, JSON.stringify({ date, currency, fxIn, note, lines: lines.map((l) => ({ ...l, product: l.product?.id || null })) })])
        .then((r) => { if (r?.[0]?.id) setDraftId(r[0].id); }).catch(() => {});
    }, 1500);
    return () => clearTimeout(h);
  }, [date, customer, currency, fxIn, note, lines, restore, org, role, realLines.length]);

  if (!data) return <div className="empty">加载中…</div>;
  const cust = data.customers.find((c) => c.id === customer);
  const tier = cust?.tier;
  const canPrice = can(role, 'quote_price');
  const priceMode = canPrice ? 'direct' : can(role, 'quote_price_request') ? 'request' : null;
  // 员工看不到价格清单, 但能看本单档位价 + 申请改价 (Frank 11-09: 他们也可以改, 要审批)
  const showPrice = seesPriceList(role) || (priceMode === 'request' && can(role, 'see_tier_price'));

  function applyDraft(d) {
    const byId = Object.fromEntries(data.catalog.map((p) => [p.id, p]));
    const v = d.data || {};
    setCustomer(d.customer_id); setDate(v.date || today()); setCurrency(v.currency || 'XOF'); setFxIn(v.fxIn || ''); setNote(v.note || '');
    setLines((v.lines || []).map((l) => ({ ...l, product: l.product ? byId[l.product] : null })).filter((l) => l.product || l.model || l.code_in));
    setDraftId(d.id); setRestore(null); toast('已打开草稿，接着做');
  }

  const submit = async () => {
    setErrs(true);
    if (!customer) return toast('请先选择客户', 'err');
    const fin = finalizeLines(lines);
    if (fin.error) return toast(fin.error, 'err');
    if (!fin.lines.length) return toast('请至少添加一行物料', 'err');
    if (currency !== 'XOF' && !fx) return toast(`外币报价要先填汇率：1 ${currency} = ? XOF`, 'err');
    const zero = fin.lines.filter((l) => !(Number(l.qty_req) > 0));
    if (zero.length) { setCellErrs(Object.fromEntries(zero.map((l) => [l.key, { qty_req: '数量不能为 0' }]))); return toast(`${zero.length} 行数量为 0（已标红）：填上数量，或选中行删掉`, 'err'); }
    // 本地先查 0 价: 有编码、没手给价、档位价为 0 → 直接标红, 不用等后端
    if (tier) {
      const noPrice = fin.lines.filter((l) => l.product && !(Number(l.unit_price) > 0) && !(Number(l.req_price) > 0) && !(Number(l.product.prices?.[tier]) > 0));
      if (noPrice.length) { setCellErrs(Object.fromEntries(noPrice.map((l) => [l.key, { price: `「${tier}」档没有价格` }]))); return toast(`${noPrice.length} 个型号在「${tier}」档没有价格（已标红）：${canPrice ? '在单价格子里直接给价，或' : ''}到「物料与定价」填价`, 'err'); }
    }
    setCellErrs(null);
    // 中方改价不用审批, 但保存前提示一次 (Frank 11-09 13:51)
    const manual = fin.lines.filter((l) => l.product && Number(l.unit_price) > 0 && Number(l.unit_price) !== tierPrice(l, tier, fx));
    if (manual.length && !priceOk) { setPriceOk(true); return toast(`有 ${manual.length} 行改了价：${manual.slice(0, 4).map((l) => `${l.product.model} ${money(tierPrice(l, tier, fx), currency)}→${money(l.unit_price, currency)}`).join('、')}${manual.length > 4 ? '…' : ''}。核对过再点一次保存`, 'err'); }
    setBusy(true);
    try {
      const payload = fin.lines.map((l) => (l.product
        ? { product_id: l.product.id, qty_req: Number(l.qty_req), stock_item_id: l.stock_item_id || null, note: l.note || null, ...(Number(l.unit_price) > 0 ? { unit_price: Number(l.unit_price) } : {}), ...(Number(l.req_price) > 0 ? { requested_price: Number(l.req_price) } : {}) }
        : { req_category_id: l.category_id, req_model: l.model, qty_req: Number(l.qty_req), note: l.note || null }));
      const id = await callValue(role, `select app.create_quote_fx($1,$2,$3,$4,$5,$6)`, [org, customer, currency, JSON.stringify(payload), note || null, fx]);
      if (draftId) await call(role, `select app.delete_quote_draft($1)`, [draftId]).catch(() => {});
      refresh(); setPriceOk(false);
      toast(fin.lines.some((l) => Number(l.req_price) > 0) ? '报价单已保存；有申请改价的行，已送中方审批，批了才能往下推' : '报价单已保存，下面接着联系客户确认');
      go('deal/' + id);
    } catch (e) {
      const msg = friendlyError(e);
      // 后端报的 0 价: 把涉及的型号格子标红
      const m = /报价单不能带 0：(.+?)。/.exec(msg);
      if (m) { const names = m[1].split('、').map((x) => x.trim()); const errs = {}; fin.lines.forEach((l) => { if (l.product && names.some((n) => n.endsWith(' ' + l.product.model) || n.startsWith(l.product.code + ' '))) errs[l.key] = { price: msg }; }); setCellErrs(errs); }
      toast(msg, 'err');
    } finally { setBusy(false); }
  };

  const t = lineTotals(lines, tier, showPrice, fx);
  // 板块 (11-01 布局编辑样板页): 中方可以调顺序 / 宽度 / 隐藏; 比如明细 8 + 合计和按钮 4 = 按钮放到右侧栏
  const blocks = [
    { id: 'head', title: '日期 · 客户 · 币种', span: 12, locked: true, render: () => (<>
      <div className="card card-b row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <DatePicker value={date} onChange={setDate} />
        <div className="grow" style={{ maxWidth: 460, minWidth: 220 }}><CustomerSelect customers={data.customers} value={customer} onChange={setCustomer} /></div>
        {cust && <button type="button" className="btn sm" onClick={() => setCustOpen(true)} title="客户档案">档案 ↗</button>}
        {cust && !cust.tier && <span className="pill amber" title="没档位报不了价：在档案里给档位，或建客户时选店铺类型">没档位</span>}
        <select className="in" style={{ width: 96 }} value={currency} onChange={(e) => { setCurrency(e.target.value); setPriceOk(false); }}>
          <option>XOF</option><option>CNY</option><option>USD</option></select>
        {currency !== 'XOF' && <span className="row" style={{ gap: 6 }}><span className="small">汇率</span>
          <RateInput a={currency} b="XOF" value={fxIn} onChange={(v) => setFxIn(v === '' ? '' : String(v))} invalid={!fx && errs} /></span>}
        <span className="pill gray" title="由账号决定，不能改">🇨🇮 科特迪瓦 · 账号固定</span>
      </div>
      {customer && <div style={{ marginTop: 10 }}><DebtBanner customerId={customer} /></div>}</>) },
    { id: 'lines', title: '询单明细', span: 12, locked: true, render: () => (
      <div className="card">
        <LineEntry id="quote-new" catalog={data.catalog} categories={data.categories} tier={tier} lines={lines} setLines={(v) => { setCellErrs(null); setPriceOk(false); setLines(v); }}
          showErrors={errs} showPrice={showPrice && !!tier && priced} currency={currency} canPrice={canPrice && !!tier && priced} priceMode={tier && priced ? priceMode : null} fx={fx}
          onProductOpen={(p) => setProdOpen(p)} errors={cellErrs} />
        {canPrice && tier && <div className="card-b hint" style={{ borderTop: '1px solid var(--line-2)' }}>单价格子里可以直接给价（谈好的价）：标 ✎ 手改、报价单上留痕；没给的按「{cust?.tier}」档位价。</div>}
        {currency !== 'XOF' && <div className="card-b hint">{fx ? `价格 = XOF 档位价 ÷ ${fx}（按你填的汇率，保留两位小数），保存时汇率锁在这张单上。` : `先在上面填汇率（1 ${currency} = ? XOF），价格才会显示。`}</div>}
      </div>) },
    { id: 'note', title: '整单备注', span: 12, render: () => (
      <div className="card card-b"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="整单备注（可选）" /></div>) },
    { id: 'sum', title: '合计', span: 12, render: () => (
      <div className="card"><div className="sumbar">
        <div className="s"><div className="k">型号数</div><div className="v">{t.n}</div></div>
        <div className="s"><div className="k">总件数</div><div className="v">{qty(t.pcs)}</div></div>
        {showPrice && tier && priced && <div className="s"><div className="k">报价金额（按 {cust.tier} 档{fx ? ` · 汇率 ${fx}` : ''}）</div><div className="v">{money(t.amt, currency)} {currency}</div></div>}
      </div></div>) },
    { id: 'actions', title: '操作按钮', span: 12, locked: true, render: () => (
      <div className="card"><div className="actionbar">
        <span className="hint">{can(role, 'quote') ? '保存后生成报价单号，可复制图片发客户群。' : `当前岗位不能报价（${whoCan('quote')}）`}</span>
        <button type="button" className="btn primary lg" disabled={busy || !can(role, 'quote')} onClick={submit}>{busy ? '保存中…' : priceOk ? '改价核对过，保存报价单 →' : '保存报价单 →'}</button>
      </div></div>) },
  ];
  return (
    <>
      {/* Frank 11-09 第 8 条: 不再是独立页, 就是新订单的第 1 步 (报价·确认) 编辑态; 保存即进流程, 下面接确认 */}
      <div className="flow2">
        <div className="flow2-steps">
          {STEPS.map((s, i) => (
            <React.Fragment key={s.key}>
              {i > 0 && <span className="flow2-line" />}
              <button type="button" className={`flow2-step ${i === 0 ? 'now viewing' : ''}`} disabled={i > 0}>
                <span className="c">{i + 1}</span><span className="l">{s.label}</span><span className="d">{i === 0 ? '新订单' : ''}</span>
              </button>
            </React.Fragment>))}
        </div>
        <div className="flow2-now">
          <span>新订单 · <b>第 1 步 报价</b> <Info>选客户、选货{canPrice ? '、给价' : ''} → 保存 → 下面接着联系客户确认。报价不预占库存，确认下推找货时才预占。选了客户、填够 5 行会自动存草稿（订单总览 →「草稿」里找得到，7 天没动自动删）。</Info>{draftId && <span className="small muted"> · 草稿已自动保存</span>}</span>
          <span className="grow" />
          {role === 'admin' && <PageGear items={[['种类顺序（所有人同款）', () => setCatOrderOpen(true)], [edit ? '退出调整版面' : '调整版面', () => setLayoutEdit(!edit)]]} />}
        </div>
      </div>
      {prodOpen && <ProductDrawer product={prodOpen} tier={tier} onClose={() => setProdOpen(null)} />}
      {custOpen && cust && <CustomerDrawer id={cust.id} onClose={() => setCustOpen(false)} />}
      {catOrderOpen && <CatOrderModal categories={data.categories} onClose={() => setCatOrderOpen(false)} />}

      {restore && (
        <div className="card card-b row between" style={{ background: 'var(--amber-bg)', borderColor: '#f3d9a8' }}>
          <span>这个客户有你上次没做完的报价草稿（{restore.n_lines} 行，{String(restore.updated_at || '').slice(0, 16).replace('T', ' ')}）</span>
          <span className="row"><button type="button" className="btn primary sm" onClick={() => applyDraft(restore)}>接着做</button>
            <button type="button" className="btn sm" onClick={async () => { await call(role, `select app.delete_quote_draft($1)`, [restore.id]).catch(() => {}); setRestore(null); }}>丢弃，重新开始</button></span>
        </div>
      )}
      <LayoutGrid page="quote" blocks={blocks} defaultGap={10} />
    </>
  );
}

// 种类条顺序 (Frank 11-09 第 1 条): 中方排一次, 所有人同款; 手机端一行横滑, 电脑端固定两行
function CatOrderModal({ categories, onClose }) {
  const { org, role, toast, refresh } = useApp();
  const [list, setList] = useState(categories);
  const save = async (v) => { try { await callValue(role, `select app.set_org_setting($1,'cat_order',$2)`, [org, v ? JSON.stringify(v.map((c) => c.id)) : null]); toast(v ? '种类顺序已保存' : '已恢复默认'); refresh(); onClose(); } catch (e) { toast(friendlyError(e), 'err'); } };
  return (
    <Modal title="种类条顺序" onClose={onClose} footer={<><button type="button" className="btn" onClick={() => save(null)}>恢复默认</button><span className="grow" /><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={() => save(list)}>保存</button></>}>
      <div className="hint" style={{ marginBottom: 8 }}>按住一行上下拖，常用的放前面。电脑端固定两行、手机端一行横滑；搜索框照旧"输型号出全部"，种类只是辅助筛选。</div>
      <SortList items={list} keyOf={(c) => c.id} onChange={setList} render={(c, i) => <><span className="mono muted small" style={{ width: 24 }}>{i + 1}</span><span className="grow">{c.name}</span></>} />
    </Modal>
  );
}
