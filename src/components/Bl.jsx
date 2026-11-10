// BON DE LIVRAISON (Frank 2026-11-07): 严格照他给的 ChatGPT 样本, 不加列、不改编号规则.
// 发货文件 = BL ×2 (仓库备案 + 客户签字) + 海关 QUITTANCE (设置里上传的固定 PDF), 两个按钮分开打印.
// 客户签字后拍照回传 = 发货证明 (attach_bl_signature).
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { q, call, callValue, REAL } from '../db/client.js';
import * as Q from '../db/queries.js';
import { useApp, useData, Pill, PhotoInput, Thumb } from './ui.jsx';
import { friendlyError } from '../lib/format.js';
import { saveFile } from '../lib/saveFile.js';

export const GS_DEFAULT = {
  name: 'G&S ENT.', tagline: 'Votre partenaire de confiance',
  footer: 'G&S ENT SARL  •  Capital : 1 000 000 FCFA  •  RCCM : CI-ABJ-03-2023-B13-08899\nCocody Bonoumin, Abidjan  •  05 02 44 50 77  •  info@gohentreprises.com',
};
export const BL_SUGGEST_DEFAULT = { amount: 1000000, qty: 500 };

const fmtQty = (n) => Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ');
const fmtDate = (v) => { const d = new Date(v); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };

export function blRows(shipment, lines) {
  const by = Object.fromEntries(lines.map((l) => [l.id, l]));
  return (shipment.lines || []).map((x) => ({ ...x, l: by[x.deal_line_id] })).filter((x) => x.l && x.qty > 0)
    .map((x, i) => ({ n: String(i + 1).padStart(2, '0'), type: x.l.category || '', model: [x.l.model, x.l.variant].filter(Boolean).join(' '), qty: x.qty }));
}

export function BlSheet({ shipment, deal, lines, header = GS_DEFAULT, logo }) {
  const rows = blRows(shipment, lines);
  const total = rows.reduce((a, r) => a + Number(r.qty), 0);
  const city = deal.city || '';
  return (
    <div className="bl">
      <div className="bl-hd">
        {logo ? <img className="bl-logo" src={logo} alt="" /> : <div className="bl-logo-t">{header.name}<small>{header.tagline}</small></div>}
      </div>
      <div className="bl-title"><h1>BON DE LIVRAISON</h1><div>{[deal.customer_name, city].filter(Boolean).join(' - ').toUpperCase()}</div></div>
      <div className="bl-meta"><b>N° DOCUMENT :</b><span>{shipment.bl_no || '—'}</span><b>DATE :</b><span>{fmtDate(shipment.shipped_at)}</span></div>
      <div className="bl-sec">CLIENT / DESTINATAIRE</div>
      <div className="bl-cli">
        <div className="n">{deal.customer_name}</div><div>Ville : {city || '—'}</div>
        <div>Responsable : {deal.customer_contact || '—'}</div><div>Tel. : {deal.customer_phone || '—'}</div>
      </div>
      <div className="bl-ref">Reference proforma : {deal.quote_no || deal.biz_no}</div>
      <div className="bl-art">Articles - Page 1/1</div>
      <table className="bl-t"><thead><tr><th>N°</th><th>Type</th><th>Designation / modele</th><th className="r">Qte livree</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.n}><td>{r.n}</td><td>{r.type}</td><td>{r.model}</td><td className="r"><b>{fmtQty(r.qty)}</b></td></tr>)}</tbody></table>
      <div className="bl-tot"><span>Total des quantites renseignees</span><span>{fmtQty(total)} pieces</span></div>
      <div className="bl-sig"><div><h4>LIVRE PAR</h4><p>Nom : ______________________</p><p>Date, signature et cachet : _________________</p></div>
        <div><h4>RECU PAR</h4><p>Nom : ______________________</p><p>Date, signature et cachet : _________________</p></div></div>
      <div className="bl-ft">{logo ? <img src={logo} alt="" /> : <b>{header.name}</b>}<span>{String(header.footer || '').split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}</span></div>
    </div>
  );
}

// 出库记录里每一批的按钮组: 打印 BL ×2 / 打印海关文件 / 签收照片
export function BlActions({ shipment, deal, lines, compact, pending }) {
  const { org, role, toast, refresh } = useApp();
  const ref = useRef();
  const fileRef = useRef();
  const [printing, setPrinting] = useState(false);
  const [sign, setSign] = useState('');
  const [signing, setSigning] = useState(false);
  const { data } = useData(async () => {
    const [[hdr], [logo], [customs], [sug]] = await Promise.all([
      q(`select value from app.org_settings where org_id = $1 and key = 'doc_header_gs'`, [org]),
      q(Q.orgFile, [org, 'logo_gs']), q(Q.orgFile, [org, 'customs']),
      q(`select value from app.org_settings where org_id = $1 and key = 'bl_suggest'`, [org])]);
    let logoSrc = null;
    if (logo) { const [f] = await q(Q.orgFileData, [org, 'logo_gs']); logoSrc = `data:${f.mime};base64,${f.data}`; }
    return { header: { ...GS_DEFAULT, ...(hdr?.value || {}) }, logo: logoSrc, customs, suggest: { ...BL_SUGGEST_DEFAULT, ...(sug?.value || {}) } };
  }, [org]);
  if (!data) return null;
  const big = Number(shipment.amount) >= Number(data.suggest.amount) || Number(shipment.qty) >= Number(data.suggest.qty);
  const printBl = async () => {
    try {
      if (!shipment.bl_no) { if (pending) { const no = await callValue(role, `select app.issue_bl_pending($1)`, [deal.id]); shipment.bl_no = no; } else await call(role, `select app.issue_bl($1)`, [shipment.id]); refresh(); }
      setPrinting(true);
      setTimeout(async () => {
        try { window.print(); if (!pending) await call(role, `select app.mark_bl_printed($1)`, [shipment.id]); } catch { toast('这个页面不允许打印，请用电脑浏览器打开', 'err'); }
        setPrinting(false); refresh();
      }, 80);
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  // 海关文件: 设置里上传的优先; 真实数据版没上传时用随版本带的 QUITTANCE (Frank 11-07 发的那份)
  const openPdf = async (blob, name) => {
    const w = window.open(URL.createObjectURL(blob), '_blank');
    if (w) return toast('海关文件已在新标签页打开，在那里点打印（⌘P）');
    // 弹窗被拦 (artifact 里常见) → 直接给文件
    const r = await saveFile(name || 'QUITTANCE.pdf', blob);
    toast(r === 'declined' ? '取消了下载' : '浏览器不让开新标签页，已把海关文件 PDF 给你，打开后打印', r === 'declined' ? 'err' : undefined);
  };
  const printCustoms = async () => {
    try {
      const [f] = await q(Q.orgFileData, [org, 'customs']);
      if (f) {
        const bin = atob(f.data); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return openPdf(new Blob([arr], { type: f.mime || 'application/pdf' }), f.name);
      }
      if (REAL) { toast('正在打开海关文件…'); const res = await fetch('./quittance.pdf'); if (!res.ok) throw new Error('海关文件没带上，请在 设置 → 随货附件 上传'); return openPdf(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }), 'QUITTANCE_POUR_TOUTE_LIVRAISON.pdf'); }
      if (role === 'admin') { toast('还没上传海关文件：选一个 PDF，上传后直接打开'); fileRef.current?.click(); }
      else toast('还没上传海关文件：请中方在 设置 → 随货附件 上传', 'err');
    } catch (e) { toast(e.message?.startsWith('海关') ? e.message : friendlyError(e), 'err'); }
  };
  const uploadCustoms = async (file) => {
    if (!file) return;
    try {
      const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(file); });
      await call(role, `select app.set_org_file($1,$2,$3,$4,$5,$6)`, [org, 'customs', file.name, file.type || 'application/pdf', b64, file.size]);
      toast(`海关文件已上传：${file.name}`); refresh(); printCustoms();
    } catch (e) { toast(friendlyError(e), 'err'); }
  };
  const saveSign = async () => {
    try { await call(role, `select app.attach_bl_signature($1,$2)`, [shipment.id, sign]); toast('签收照片已挂到这批出库单'); setSigning(false); setSign(''); refresh(); }
    catch (e) { toast(friendlyError(e), 'err'); }
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {big && !shipment.bl_printed_at && <Pill tone="amber" title={`金额 ≥ ${Number(data.suggest.amount).toLocaleString()} 或件数 ≥ ${data.suggest.qty}：建议打印发货文件随货走`}>大单 · 建议打印</Pill>}
      <button type="button" className={`btn ${pending ? '' : 'sm'} ${pending || (big && !shipment.bl_printed_at) ? 'primary' : ''}`} onClick={printBl} title="打印两张：一张仓库备案，一张客户签字">🖨 BL ×2{shipment.bl_no ? '' : '（生成编号）'}</button>
      <button type="button" className={`btn ${pending ? '' : 'sm'}`} onClick={printCustoms} title={data.customs ? `${data.customs.name} · ${Math.round(data.customs.bytes / 1024)} KB` : REAL ? 'QUITTANCE（随版本自带）' : '还没上传：点一下选 PDF 上传'}>🖨 海关文件{data.customs || REAL ? '' : '（未上传，点击上传）'}</button>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} onChange={(e) => { uploadCustoms(e.target.files?.[0]); e.target.value = ''; }} />
      {pending ? null : shipment.signed_photo ? <Thumb src={shipment.signed_photo} size={30} label={`${shipment.bl_no || shipment.out_no} 客户签字`} />
        : signing ? <span className="row" style={{ gap: 4 }}><PhotoInput value={sign} onChange={setSign} label="签字照片" /><button type="button" className="btn sm primary" disabled={!sign} onClick={saveSign}>挂上</button><button type="button" className="btn sm ghost" onClick={() => setSigning(false)}>×</button></span>
          : <button type="button" className="btn sm" onClick={() => setSigning(true)} title="客户在 BL 上签字后拍照回传，作为发货证明">＋ 签收照片</button>}
      {!compact && shipment.bl_no && <span className="mono small muted">{shipment.bl_no}</span>}
      {createPortal(<div className={`docwrap ${printing ? 'print-root' : ''}`} ref={ref}>
        <BlSheet shipment={shipment} deal={deal} lines={lines} header={data.header} logo={data.logo} />
        <BlSheet shipment={shipment} deal={deal} lines={lines} header={data.header} logo={data.logo} />
      </div>, document.body)}
    </span>
  );
}
