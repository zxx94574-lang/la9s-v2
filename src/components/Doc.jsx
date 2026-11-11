// Printable / copy-as-image documents: 报价单, 找货单, 销售订单, 对账单 Balance, 退货对账单.
// One header for all (待改 11): logo top-left (big) · title centred · top-right: customer name (biggest) + date, doc no in grey.
// No address / phone / contact details anywhere. Client documents carry no 业务号 and no currency cell — the currency
// lives only inside the amounts. Alignment: price & amount right, quantities centre, everything else left.
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toBlob } from 'html-to-image';
import { money, qty, dDate, dt, today } from '../lib/format.js';
import { balanceWords } from '../lib/domain.js';
import { t } from '../lib/i18n.js';
import { useApp, useData, Info } from './ui.jsx';
import { q } from '../db/client.js';
import * as Q from '../db/queries.js';

const LOGO = './la9s-logo.png';
const N = (v) => Number(v || 0);
const sharedShort = (list, n = 3) => (!list?.length ? '' : list.slice(0, n).join(' / ') + (list.length > n ? ` 等${list.length}个` : ''));
const R = { textAlign: 'right' }, C = { textAlign: 'center' };
const TITLES = { quote: '报价单', pick: '找货单', so: '销售订单', balance: '对账单', return: '退货对账单' };

function Head({ kind, name, date, no, biz }) {
  return (
    <div className="doc-head2">
      <img src={LOGO} alt="LA&9S" />
      <div className="dh-title">{t(TITLES[kind])}</div>
      <div className="dh-cust">
        <div className="dh-name">{name}</div>
        <div className="dh-date">{date}</div>
        {no && <div className="dh-no">{no}</div>}
        {biz && <div className="dh-no">业务号 {biz}</div>}
      </div>
    </div>
  );
}

export function DocSheet({ kind, deal, lines, balance, ret }) {
  if (kind === 'balance') return <BalanceSheet balance={balance} deal={deal} />;
  if (kind === 'return') return <ReturnSheet deal={deal} ret={ret} />;
  const no = { quote: deal.quote_no, pick: deal.pick_no, so: deal.so_no }[kind];
  const cur = deal.currency || 'XOF';
  const qf = (l) => (kind === 'so' ? l.qty_supply : l.qty_req);
  // 234 (Frank 11-11): 销售单两列 —— 需求数量 (灰, 客户要多少) + 实际供货数量 / 单价 / 金额 (蓝色块, 按这个发货收钱); 没给够的写「本次未供 N」, 不印「预订」
  const so = kind === 'so';
  const rows = lines.filter((l) => (so ? (N(l.qty_supply) > 0 || (l.product_id && N(l.qty_req) > 0)) : true));
  const G = { ...C, color: '#8a94a6', whiteSpace: 'nowrap' };
  const totQ = rows.reduce((a, l) => a + N(qf(l)), 0);
  const totA = rows.reduce((a, l) => a + N(qf(l)) * N(l.unit_price), 0);
  // 销售订单 (Frank 11-08): 实际供货数量 / 单价 / 金额三列加品牌蓝浅底, 客户一眼看到按什么发货、按什么收钱
  const H = kind === 'so' ? { background: '#e4ecf9' } : {};
  const HC = { ...C, ...H, whiteSpace: 'nowrap' }; const HR = { ...R, ...H, whiteSpace: 'nowrap' };
  return (
    <div className="doc">
      <Head kind={kind} name={deal.customer_name} date={dDate(kind === 'so' ? deal.updated_at : deal.created_at)} no={no} biz={kind === 'pick' ? deal.biz_no : null} />
      <table>
        <thead><tr>
          <th style={C}>#</th><th>{t('编码')}</th><th>{t('种类')}</th><th>{t('型号')}</th><th>{t('通用性')}</th>
          {kind === 'pick' && <><th>{t('仓库')}</th><th>{t('库位')}</th></>}
          {so && <th style={G}>{t('需求数量')}</th>}
          <th style={HC}>{kind === 'pick' ? '需求' : so ? t('实际供货数量') : t('数量')}</th>
          {kind === 'pick' ? <><th style={C}>{t('预占')}</th><th style={C}>{t('实际供货')}</th></> : <><th style={HR}>{t('单价')} {cur}</th><th style={HR}>{t('金额')} {cur}</th></>}
        </tr></thead>
        <tbody>{rows.map((l, i) => (
          <tr key={l.id}>
            <td style={C}>{i + 1}</td><td>{l.code || '未建档'}</td><td>{l.category}</td><td><b>{l.model}</b></td><td>{sharedShort(l.shared_models)}</td>
            {kind === 'pick' && <><td>{l.warehouse}</td><td><b>{l.bin}</b></td></>}
            {so && <td style={G}>{qty(l.qty_req)}{N(l.qty_req) > N(l.qty_supply) && <div style={{ fontSize: 11, lineHeight: 1.2 }}>{t('本次未供')} {qty(N(l.qty_req) - N(l.qty_supply))}</div>}</td>}
            <td style={HC}>{qty(qf(l))}</td>
            {kind === 'pick' ? <><td style={C}>{qty(l.qty_supply)}</td><td style={{ width: 90 }} /></> : <><td style={HR}>{money(l.unit_price, cur)}</td><td style={HR}><b>{money(N(qf(l)) * N(l.unit_price), cur)}</b></td></>}
          </tr>))}</tbody>
        <tfoot><tr>
          <td colSpan={kind === 'pick' ? 7 : 5}>{t('合计')} · {rows.length} {t('个型号')}</td>
          {so && <td style={G}>{qty(rows.reduce((a, l) => a + N(l.qty_req), 0))}</td>}
          <td style={HC}>{qty(totQ)} {t('件')}</td>
          {kind === 'pick' ? <><td style={C}>{qty(rows.reduce((a, l) => a + N(l.qty_supply), 0))}</td><td /></> : <><td style={H} /><td style={HR}><b>{money(totA, cur)} {cur}</b></td></>}
        </tr></tfoot>
      </table>
      {kind === 'pick' && <div className="foot">找货人：__________　　照片已上传：□　　主管复核：__________</div>}
    </div>
  );
}

// 对账单 Balance — portrait for phones (待改 27 / 37): 本单 block, 总账（含本单） block with 当前欠款 the biggest, open orders
function BalanceSheet({ balance: b, deal }) {
  const cur = b.currency || 'XOF';
  const w = balanceWords(b.balance, cur);
  const open = (b.open || []).filter((o) => !deal || o.deal_id !== deal.id || true);
  const top = open.slice(0, 5), rest = open.slice(5);
  const has = deal && N(deal.shipped_amount) > 0;
  const rec = deal ? N(deal.shipped_amount) - N(deal.returned_amount) : 0;
  const pre = deal ? Math.min(N(deal.prepaid_used), N(deal.allocated_amount)) : 0;
  return (
    <div className="doc doc-portrait">
      <Head kind="balance" name={b.name} date={today()} />
      {has && (
        <div className="bsec">
          <div className="bsec-h"><span>{t('本单')}</span><span className="mono">{deal.biz_no}</span><span>出库 {dDate(deal.first_shipped_at || deal.updated_at)}</span></div>
          <div className="b3">
            <div><div className="k">{t('应收')}</div><div className="v">{money(rec, cur)}</div></div>
            <div><div className="k">{t(pre > 0 && pre >= N(deal.allocated_amount) ? '预付抵扣' : '实收')}</div><div className="v">{money(deal.allocated_amount, cur)}</div></div>
            <div><div className="k">{t('待付')}</div><div className={`v ${N(deal.due) > 0 ? 'red' : 'green'}`}>{N(deal.due) > 0 ? money(deal.due, cur) : t('已付清')}</div></div>
          </div>
          <div className="bunit">{t('金额单位')} {cur}</div>
          {/* 242 (Frank 11-11): 从预付款里扣的要写清楚, 不然客户以为这次又付了一笔 */}
          {pre > 0 && <div className="bpre">本单 <b>{money(pre, cur)}</b> 已从预付款扣除{N(deal.allocated_amount) - pre > 0 ? <>，本次另付 <b>{money(N(deal.allocated_amount) - pre, cur)}</b></> : ''}{w.label === '预付' && w.amount > 0 ? <> · 预付款还剩 <b>{money(w.amount, cur)} {cur}</b></> : ''}</div>}
        </div>
      )}
      <div className="bsec">
        <div className="bsec-h"><span>{has ? t('总账（含本单）') : t('总账')}</span></div>
        <div className="b3 small4">
          <div><div className="k">{t('累计购买')}</div><div className="v">{money(b.total_sold, cur)}</div></div>
          <div><div className="k">{t('累计已付')}</div><div className="v">{money(b.total_paid, cur)}</div></div>
          <div><div className="k">{t('累计退货')}</div><div className="v">{money(b.total_returned, cur)}</div></div>
        </div>
        <div className={`bbig ${w.tone}`}>
          <div className="k">{t(w.label === '预付' ? '当前客户无欠款，此为预付' : w.label)}</div>
          {w.amount > 0 && <div className="v">{money(w.amount, cur)} <small>{cur}</small></div>}
        </div>
        {has && <div className="bnote">以上总账已包含本单 {deal.biz_no}（{money(rec, cur)} {cur}）</div>}
        {N(b.total_writeoff) > 0 && <div className="bnote">其中抹零 {money(b.total_writeoff, cur)} {cur}</div>}
      </div>
      {open.length > 0 && (
        <div className="bsec">
          <div className="bsec-h"><span>{t('未结清订单')}</span></div>
          {top.map((o) => (
            <div key={o.deal_id} className="brow"><span className="mono">{o.kind === 'opening' ? '期初欠款' : o.biz_no}</span><span>{dDate(o.first_shipped_at) || '历史'}</span><b>{money(o.due, cur)}</b></div>
          ))}
          {rest.length > 0 && <div className="brow"><span>其余 {rest.length} 单合计</span><span /><b>{money(rest.reduce((a, o) => a + N(o.due), 0), cur)}</b></div>}
        </div>
      )}
      <div className="bgen">{t('生成时间')} {dt(new Date())} · LA&9S</div>
    </div>
  );
}

function ReturnSheet({ deal, ret }) {
  const cur = deal.currency;
  return (
    <div className="doc">
      <Head kind="return" name={deal.customer_name} date={dDate(ret.decided_at || ret.requested_at)} no={ret.rt_no} />
      <div className="rs-sub">原订单 <b className="mono">{deal.so_no || deal.biz_no}</b>{ret.batch_no && <> · 批次 {ret.batch_no}</>} · {ret.statusText}</div>
      <table>
        <thead><tr><th style={C}>#</th><th>{t('编码')}</th><th>{t('种类')}</th><th>{t('型号')}</th><th style={C}>{t('退货数量')}</th><th style={R}>{t('单价')} {cur}</th><th style={R}>{t('金额')} {cur}</th></tr></thead>
        <tbody>{ret.lines.map((x, i) => (
          <tr key={x.id}><td style={C}>{i + 1}</td><td>{x.code}</td><td>{x.category}</td><td><b>{x.model}</b></td><td style={C}>{qty(x.qty)}</td>
            <td style={R}>{money(x.unit_price, cur)}</td><td style={R}>{money(N(x.qty) * N(x.unit_price), cur)}</td></tr>))}</tbody>
        <tfoot><tr><td colSpan={4}>合计</td><td style={C}>{qty(ret.lines.reduce((a, x) => a + N(x.qty), 0))} 件</td><td /><td style={R}>{money(ret.amount, cur)} {cur}</td></tr></tfoot>
      </table>
      {/* 11-09 Frank 第 21 条: 图表化 —— 本单 应收 → 退货 → 新应收; 总账 退货前 → 退货后 (最终对的是总欠款) */}
      <div className="rs-charts">
        <div className="rs-chart">
          <div className="k">{t('本单')} {deal.so_no || deal.biz_no}</div>
          <Bars cur={cur} rows={[['退货前应收', ret.recBefore, 'g'], ['本次退货', -ret.amount, 'r'], ['退货后应收', ret.recAfter, 'b']]} />
        </div>
        <div className="rs-chart">
          <div className="k">{t('客户总账')}（{t('退货前')} → {t('退货后')}）</div>
          <Bars cur={cur} rows={[['退货前', ret.balBefore, 'g'], ['本次退货', -ret.amount, 'r'], ['退货后', ret.balAfter, 'b']]} words />
          <div className="rs-final">{balanceWords(ret.balAfter, cur).text}</div>
        </div>
      </div>
      {ret.received_at && <div className="rs-sub" style={{ marginTop: 8 }}>{t('收到退货')} {dt(ret.received_at)}{ret.reconciled_at ? ` · ${t('对账完成')} ${dt(ret.reconciled_at)}` : ''}</div>}
    </div>
  );
}
// 简单横条: 按绝对值比例画, 负数 (退货) 画红
function Bars({ rows, cur, words }) {
  const max = Math.max(1, ...rows.map(([, v]) => Math.abs(N(v))));
  return (
    <div className="bars">{rows.map(([l, v, c]) => (
      <div key={l} className="bar-row">
        <span className="bar-l">{l}</span>
        <span className="bar-t"><span className={`bar ${c}`} style={{ width: `${Math.max(2, Math.abs(N(v)) / max * 100)}%` }} /></span>
        <span className="bar-v">{v < 0 ? '−' : ''}{words && v >= 0 && Math.abs(N(v)) > 0 && l !== '本次退货' ? (N(v) > 0 ? '欠 ' : '预付 ') : ''}{money(Math.abs(N(v)), cur)}</span>
      </div>))}</div>
  );
}

// plain text version for WhatsApp: paste and send, no screenshot (Frank 10-29)
export function docText({ kind, deal, lines, balance, ret }) {
  const cur = deal?.currency || balance?.currency || 'XOF';
  const m = (v) => `${money(v, cur)} ${cur}`;
  if (kind === 'balance') {
    const b = balance, w = balanceWords(b.balance, cur);
    const out = [`*${TITLES.balance}* · ${b.name} · ${today()}`];
    if (deal && N(deal.shipped_amount) > 0) out.push(`本单 ${deal.biz_no}：应收 ${m(N(deal.shipped_amount) - N(deal.returned_amount))} / 实收 ${m(deal.allocated_amount)} / 待付 ${N(deal.due) > 0 ? m(deal.due) : t('已付清')}`);
    out.push(`累计购买 ${m(b.total_sold)} / 累计已付 ${m(b.total_paid)} / 累计退货 ${m(b.total_returned)}`);
    out.push(`*${w.text}*`);
    (b.open || []).slice(0, 5).forEach((o) => out.push(`· ${o.kind === 'opening' ? '期初欠款' : o.biz_no}  ${dDate(o.first_shipped_at) || ''}  未付 ${m(o.due)}`));
    return out.join('\n');
  }
  if (kind === 'return') {
    return [`*${TITLES.return}* ${ret.rt_no} · ${deal.customer_name}`, ...ret.lines.map((x, i) => `${i + 1}. ${x.model} ${x.category} × ${x.qty} @ ${money(x.unit_price, cur)} = ${money(N(x.qty) * N(x.unit_price), cur)}`),
      `合计 ${m(ret.amount)}`, `客户总账：${balanceWords(ret.balAfter, cur).text}`].join('\n');
  }
  const qf = (l) => (kind === 'so' ? l.qty_supply : l.qty_req);
  const rows = lines.filter((l) => (kind === 'so' ? N(l.qty_supply) > 0 : true));
  const no = { quote: deal.quote_no, pick: deal.pick_no, so: deal.so_no }[kind];
  const out = [`*${TITLES[kind]}* ${no || ''} · ${deal.customer_name} · ${dDate(deal.updated_at || deal.created_at)}`];
  rows.forEach((l, i) => out.push(kind === 'pick'
    ? `${i + 1}. ${l.code || ''} ${l.model} ${l.category} × ${qty(qf(l))}  [${l.warehouse || ''} ${l.bin || ''}]`
    : `${i + 1}. ${l.model} ${l.category} × ${qty(qf(l))} @ ${money(l.unit_price, cur)} = ${money(N(qf(l)) * N(l.unit_price), cur)}${kind === 'so' && N(l.qty_req) > N(l.qty_supply) ? `（要 ${qty(l.qty_req)}，本次未供 ${qty(N(l.qty_req) - N(l.qty_supply))}）` : ''}`));
  const totQ = rows.reduce((a, l) => a + N(qf(l)), 0), totA = rows.reduce((a, l) => a + N(qf(l)) * N(l.unit_price), 0);
  out.push(kind === 'pick' ? `合计 ${qty(totQ)} 件` : `*合计 ${qty(totQ)} 件 · ${m(totA)}*`);
  return out.join('\n');
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok; } catch { return false; }
}

// renders the sheet off-screen; returns buttons for 复制图片 / 复制文字 / 打印
export function DocActions({ kind, deal, lines, balance, ret, printLabel = '打印', copyLabel = '复制图片', hidePrint, hideCopy, hideText, primary }) {
  const ref = useRef();
  const [printing, setPrinting] = useState(false);
  const { toast } = useApp();
  const copy = async () => {
    try {
      const blob = await toBlob(ref.current.firstChild, { pixelRatio: 2, backgroundColor: '#fff' });
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('图片已复制，可直接粘贴到 WhatsApp');
      } catch {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `${(ret?.rt_no || deal?.so_no || deal?.quote_no || balance?.code || 'LA9S')}.png`; a.click();
        toast('浏览器不允许直接复制，已下载图片');
      }
    } catch (e) { toast('生成图片失败：' + e.message, 'err'); }
  };
  const print = () => { setPrinting(true); setTimeout(() => { try { window.print(); } catch { toast('这个页面不允许打印，请用电脑浏览器打开本地版', 'err'); } setPrinting(false); }, 50); };
  return (
    <>
      {!hideCopy && <button type="button" className="btn primary" onClick={copy}>⧉ {copyLabel}</button>}
      {!hideText && <button type="button" className="btn" title="复制成一段文字，在 WhatsApp 直接粘贴发送" onClick={async () => toast((await copyText(docText({ kind, deal, lines, balance, ret }))) ? '文字已复制，到 WhatsApp 直接粘贴' : '浏览器不允许复制', 'ok')}>✎ 复制文字</button>}
      {!hidePrint && <button type="button" className={`btn ${primary === 'print' ? 'dark' : ''}`} onClick={print}>🖨 {printLabel}</button>}
      {createPortal(<div className={`docwrap ${printing ? 'print-root' : ''}`} ref={ref}><DocSheet kind={kind} deal={deal} lines={lines} balance={balance} ret={ret} /></div>, document.body)}
    </>
  );
}

// load a customer's balance + open orders and offer "复制 Balance 图片" (待改 43: after every money action)
export function BalanceCopy({ customerId, currency = 'XOF', deal, label = '复制 Balance 图片', primary = true, hidePrint = true }) {
  const { data } = useData(async () => {
    const [[b], open] = await Promise.all([q(Q.customerBalance, [customerId, currency]), q(Q.customerOpenDeals, [customerId, currency])]);
    let d = deal;
    if (deal) { const [fresh] = await q(Q.dealById, [deal.id]); d = fresh; }
    return { b: { ...b, currency, open }, d };
  }, [customerId, currency, deal?.id]);
  if (!data?.b) return <button type="button" className="btn" disabled>⧉ {label}</button>;
  return <DocActions kind="balance" balance={data.b} deal={data.d} copyLabel={label} primary={primary ? 'copy' : undefined} hidePrint={hidePrint} />;
}

// 11-09 Frank 第 20 条: 复制之前页面上就看到和复制出来一模一样的对账单 (所见即所得); 按钮在预览上方
export function BalancePreview({ customerId, currency = 'XOF', deal, title = '客户最新 Balance', extra }) {
  const { data } = useData(async () => {
    const [[b], open] = await Promise.all([q(Q.customerBalance, [customerId, currency]), q(Q.customerOpenDeals, [customerId, currency])]);
    let d = deal;
    if (deal) { const [fresh] = await q(Q.dealById, [deal.id]); d = fresh; }
    return { b: { ...b, currency, open }, d };
  }, [customerId, currency, deal?.id, deal?.updated_at]);
  if (!data?.b) return <div className="card card-b muted small">对账单生成中…</div>;
  return (
    <div className="card">
      <div className="card-h"><h2>{title} <Info>下面就是发给客户的那张图，实时更新</Info></h2>
        <div className="row" style={{ gap: 6 }}>{extra}<DocActions kind="balance" balance={data.b} deal={data.d} copyLabel="复制 Balance 图片（发客户群）" primary="copy" /></div></div>
      <div className="card-b doc-preview"><div className="doc-preview-in"><DocSheet kind="balance" balance={data.b} deal={data.d} /></div></div>
    </div>
  );
}
