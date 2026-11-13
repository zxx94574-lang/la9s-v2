// 工资发放记录 → Excel, 照 Frank 发的 8 月表 (SALARY PAYMENT MONTH OF AUGUST) 的样式:
// 深蓝标题条 / 浅蓝月份行 / 深蓝表头 15 列 / 明细 (至少 30 行编号) / 月度财务汇总 / 异常说明 / 签字栏.
// 和原表的两处不同 (已在系统里说明): 「团队奖金合计」原表误加的是社保列, 这里加的是团队奖金列, 另起一行「社保合计」;
// 实发工资原表没减扣款, 这里减了.
const MOIS = ['JANVIER', 'FÉVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOÛT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DÉCEMBRE'];
const FCFA = '#,##0\\ "FCFA"';
const N = (v) => Number(v || 0);

export async function payrollWorkbook({ month, header, lines }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LA&9S';
  const ws = wb.addWorksheet('Paie mensuelle 月度工资', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const widths = { A: 8, B: 38.5, C: 18, D: 40, E: 15.3, F: 25.7, G: 15.3, H: 19.6, I: 17, J: 22, K: 23.7, L: 18.5, M: 20.7, N: 17.5, O: 16 };
  for (const [k, w] of Object.entries(widths)) ws.getColumn(k).width = w;
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const [y, m] = month.split('-').map(Number);

  ws.mergeCells('A1:O1');
  Object.assign(ws.getCell('A1'), { value: 'G&S ENT – SUIVI MENSUEL DES SALAIRES, PRIMES ET PERFORMANCE / 员工月度工资、奖金及绩效跟踪表' });
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = fill('FF17365D'); ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 26;

  for (const [c, v] of [['A3', 'Mois / 月份'], ['B3', MOIS[m - 1]], ['D3', y], ['F3', 'Département / 部门'], ['G3', header.dept_label || 'TOUS / 全部']]) ws.getCell(c).value = v;
  for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) { ws.getCell(`${c}3`).fill = fill('FFD9EAF7'); ws.getCell(`${c}3`).font = { bold: true, size: 11 }; }

  const heads = ['N°', 'Salarié / 员工', 'DEPARTMENT/部门', 'Poste / 职位', 'Jours travaillés\n出勤天数', 'Salaire fixe\n基本工资', 'Indemnité\n补贴', 'Prime individuelle\n个人奖金',
    'Prime équipe\n团队奖金', 'COTISATION SOCIALE CNPS/公司承担的社保费', 'Retenue\n扣款', 'Net à payer\n实发工资', 'Statut paiement\n付款状态', 'Date paiement\n付款日期', 'Approbation\n审批'];
  const hr = ws.getRow(5); hr.height = 44;
  heads.forEach((h, i) => {
    const c = hr.getCell(i + 1); c.value = h;
    c.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }; c.fill = fill('FF1F4E78');
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  const first = 6; const n = Math.max(30, lines.length); const last = first + n - 1;
  const paid = header.status === 'paid'; const approved = header.status !== 'draft';
  for (let i = 0; i < n; i++) {
    const r = ws.getRow(first + i); const l = lines[i];
    r.getCell(1).value = i + 1;
    if (l) {
      r.getCell(2).value = l.snap_name; r.getCell(3).value = l.snap_dept || ''; r.getCell(4).value = l.snap_position || '';
      r.getCell(5).value = N(l.days_worked);
      [[6, l.base], [7, l.allowance], [8, N(l.incentive) + N(l.wh_comm)],   /* 仓库提成并进「个人奖金」这一栏 (表样不加列) */ [9, l.prime_team], [10, l.cnps], [11, l.deduction]].forEach(([c, v]) => { if (N(v)) r.getCell(c).value = N(v); });
      r.getCell(13).value = paid ? 'PAYÉ / 已付' : 'EN ATTENTE / 待付';
      if (l.paid_on || header.paid_on) { r.getCell(14).value = new Date(`${(l.paid_on || header.paid_on).slice(0, 10)}T00:00:00Z`); r.getCell(14).numFmt = 'yyyy-mm-dd'; }
      r.getCell(15).value = approved ? 'APPROUVÉ / 已批' : '';
    }
    const R = first + i;
    r.getCell(12).value = { formula: `F${R}+G${R}+H${R}+I${R}${header.cnps_in_net ? `+J${R}` : ''}-K${R}`, result: l ? N(l.net) : 0 };
    r.getCell(12).font = { bold: true };
    for (let c = 6; c <= 12; c++) r.getCell(c).numFmt = FCFA;
  }

  const sum = (col) => lines.reduce((a, l) => a + N(l[col]), 0);
  let r0 = last + 3;
  ws.mergeCells(`A${r0}:O${r0}`);
  ws.getCell(`A${r0}`).value = 'RÉSUMÉ FINANCIER DU MOIS / 月度财务汇总';
  ws.getCell(`A${r0}`).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getCell(`A${r0}`).fill = fill('FF17365D'); ws.getCell(`A${r0}`).alignment = { horizontal: 'center' };
  const tot = [
    ['Total salaires fixes / 基本工资合计', 'F', sum('base')],
    ['Total indemnités / 补贴合计', 'G', sum('allowance')],
    ['Total primes individuelles / 个人奖金合计', 'H', sum('incentive')],
    ['Total primes équipe / 团队奖金合计', 'I', sum('prime_team')],
    ['Total CNPS (part patronale) / 公司承担社保合计', 'J', sum('cnps')],
    ['Total retenues / 扣款合计', 'K', sum('deduction')],
    ['TOTAL NET À PAYER / 实发工资总额', 'L', sum('net')],
  ];
  tot.forEach(([label, col, v], i) => {
    const rr = r0 + 1 + i; const bold = i === tot.length - 1;
    ws.mergeCells(`A${rr}:F${rr}`); ws.mergeCells(`G${rr}:J${rr}`);
    ws.getCell(`A${rr}`).value = label; ws.getCell(`A${rr}`).fill = fill('FFF2F4F7'); ws.getCell(`A${rr}`).font = { bold };
    ws.getCell(`G${rr}`).value = { formula: `SUM(${col}${first}:${col}${last})`, result: v };
    ws.getCell(`G${rr}`).numFmt = FCFA; ws.getCell(`G${rr}`).fill = fill('FFF2F4F7'); ws.getCell(`G${rr}`).font = { bold };
  });
  r0 += tot.length + 2;
  ws.mergeCells(`A${r0}:O${r0 + 2}`);
  ws.getCell(`A${r0}`).value = `Remarques / Anomalies / 异常说明 : ${header.remarks || ''}`;
  ws.getCell(`A${r0}`).fill = fill('FFF2F4F7'); ws.getCell(`A${r0}`).alignment = { vertical: 'top', wrapText: true };
  r0 += 4;
  const sign = [['A', 'Préparé par / 制表人'], ['B', header.prepared_by || ''], ['D', 'Superviseur / 主管'], ['E', header.supervisor || ''], ['F', 'Contrôle finance / 财务审核'], ['G', header.finance_check || ''],
    ['H', 'Approbateur / 审批人'], ['I', header.approver || ''], ['K', 'Date paiement / 付款日期'], ['L', header.paid_on ? new Date(`${String(header.paid_on).slice(0, 10)}T00:00:00Z`) : '']];
  for (const [c, v] of sign) { const cell = ws.getCell(`${c}${r0}`); cell.value = v; cell.font = { bold: true, color: { argb: 'FF17365D' } }; if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd'; }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export const payrollFileName = (month, dept) => `SALARY PAYMENT ${MOIS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}${dept ? ' ' + dept : ''}.xlsx`;
