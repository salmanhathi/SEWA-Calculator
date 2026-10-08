/* SEWA Bill Tracker — parsing logic
   Handles two known SEWA PDF layouts:
   - v1 (older): single matrix table with Gas | Water | Electricity columns
   - v2 (newer): separate stacked panels per utility + a SEWERAGE / SANITATION page
   Also parses the monthly SMS text. Nothing here touches the network. */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function num(str) {
  if (str === undefined || str === null) return null;
  const cleaned = String(str).replace(/,/g, '').trim();
  if (cleaned === '' || isNaN(Number(cleaned))) return null;
  return Number(cleaned);
}

function monthKeyFromName(monthName, year) {
  const idx = MONTHS_SHORT.findIndex(m => m.toLowerCase() === monthName.slice(0, 3).toLowerCase());
  return idx === -1 ? null : `${MONTHS_SHORT[idx]}-${year}`;
}

// "21/08/2026" | "Sep 21, 2026" | "2026-09-21" -> { iso, display }
function normalizeDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  let m;
  if ((m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return { iso: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, display: raw };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { iso: raw, display: raw };
  if ((m = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const idx = MONTHS.findIndex(x => x.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
    if (idx === -1) return { iso: null, display: raw };
    return { iso: `${m[3]}-${String(idx + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`, display: raw };
  }
  return { iso: null, display: raw };
}

// Group pdf.js text items into lines by y-proximity, keeping pdf.js's own item
// order (verified on real SEWA bills: panels/columns are drawn one at a time).
async function linearizePdf(pdfjsLib, arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let lastY = null, line = '';
    const lines = [];
    for (const it of content.items) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
      line += it.str + ' ';
      lastY = y;
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines);
  }
  return pages;
}

function isNumericLine(line) { return /^-?\d[\d,]*\.\d{2}$/.test(line.trim()); }
function findLineStartingWith(lines, label) {
  return lines.find(l => l.trim().toLowerCase().startsWith(label.toLowerCase()));
}
function numbersInLine(line) {
  return (line.match(/-?\d[\d,]*\.\d{2}/g) || []).map(num);
}

const UTIL_LABELS = ['Previous Bill','Receipts','Current Amount','Service Charges','Adjustments',
  'Other Charges','Transformer Maintenance Ch.','Discounts','Net Taxable Amount','VAT Rate %','VAT Amount','Total Including VAT'];
const LABEL_TO_KEY = {
  'Previous Bill': 'previousBill', 'Receipts': 'receipts', 'Current Amount': 'currentAmount',
  'Service Charges': 'serviceCharges', 'Adjustments': 'adjustments', 'Other Charges': 'otherCharges',
  'Transformer Maintenance Ch.': 'transformerCh', 'Discounts': 'discounts', 'Net Taxable Amount': 'netTaxableAmount',
  'VAT Rate %': 'vatRate', 'VAT Amount': 'vatAmount', 'Total Including VAT': 'totalIncludingVAT'
};

function emptyUtilBlock() {
  const b = {};
  Object.values(LABEL_TO_KEY).forEach(k => { b[k] = null; });
  return b;
}

// Water/Gas panels omit rows that don't apply (e.g. Transformer Maintenance is
// electricity-only), so values are paired with the labels actually present.
function utilBlockFromLabelsAndValues(labels, vals) {
  const b = emptyUtilBlock();
  labels.forEach((label, i) => {
    const key = LABEL_TO_KEY[label];
    if (key && vals[i] !== undefined) b[key] = vals[i];
  });
  return b;
}

// ---------- v1 (older, matrix layout) ----------
function parseV1(allLines) {
  const result = { format: 'v1', header: {}, utilities: {}, meters: [], municipality: {} };

  const invLine = findLineStartingWith(allLines, 'Invoice No&Date');
  if (invLine) {
    const m = invLine.match(/Invoice No&Date\s+(\S+)\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
    if (m) { result.header.invoiceNo = m[1]; result.header.invoiceDate = normalizeDate(m[2]); }
  }
  const dueLine = findLineStartingWith(allLines, 'Due Date');
  if (dueLine) {
    const m = dueLine.match(/Due Date\s+(\d{2}\/\d{2}\/\d{4})/);
    if (m) result.header.dueDate = normalizeDate(m[1]);
  }
  const billingLine = findLineStartingWith(allLines, 'Billing Period');
  if (billingLine) {
    const m = billingLine.match(/Billing Period\s+([A-Za-z]+)\s+(\d{4})/);
    if (m) { result.header.billingMonth = m[1]; result.header.billingYear = m[2]; result.header.monthKey = monthKeyFromName(m[1], m[2]); }
  }
  const acctLine = findLineStartingWith(allLines, 'Account No');
  if (acctLine) { const m = acctLine.match(/Account No\.?\s+(\d+)/); if (m) result.header.accountNo = m[1]; }
  const totalLine = findLineStartingWith(allLines, 'TOTAL AMOUNT');
  if (totalLine) { const n = numbersInLine(totalLine); if (n.length) result.header.totalAmount = n[0]; }
  const dueAmtLine = findLineStartingWith(allLines, 'DUE AMOUNT');
  if (dueAmtLine) { const n = numbersInLine(dueAmtLine); if (n.length) result.header.dueAmount = n[0]; }

  // Matrix rows: label, then [gas, water, electricity]
  const gas = emptyUtilBlock(), water = emptyUtilBlock(), electricity = emptyUtilBlock();
  for (const [label, key] of Object.entries(LABEL_TO_KEY)) {
    const line = allLines.find(l => l.startsWith(label));
    if (!line) continue;
    const n = numbersInLine(line);
    if (n.length >= 3) { gas[key] = n[0]; water[key] = n[1]; electricity[key] = n[2]; }
  }
  result.utilities = { electricity, water, gas };

  const meterRe = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\w-]+)\s+(?:3 Phase-)?(Electricity|Water|Gas)/;
  for (const line of allLines) {
    const m = line.match(meterRe);
    if (m) result.meters.push({
      currentReadingDate: normalizeDate(m[1]), previousReadingDate: normalizeDate(m[2]),
      consumption: num(m[3]), rate: num(m[4]), mf: num(m[5]),
      currentReading: num(m[6]), previousReading: num(m[7]), meterNumber: m[8], utility: m[9]
    });
  }

  const muniMap = { 'Arrears':'arrears', 'Receipts':'receipts', 'Current Amount':'currentAmount', 'Adjustments':'adjustments',
    'Public Hygiene Charges':'publicHygiene', 'Total':'total' };
  const muniStart = allLines.findIndex(l => l.startsWith('Sharjah Municipality'));
  const muniLines = muniStart >= 0 ? allLines.slice(muniStart, muniStart + 8) : [];
  for (const [label, key] of Object.entries(muniMap)) {
    const line = muniLines.find(l => l.startsWith(label));
    if (line) { const n = numbersInLine(line); if (n.length) result.municipality[key] = n[0]; }
  }
  return result;
}

// ---------- v2 (newer, stacked-panel layout) ----------
function parseV2(pages) {
  const page1 = pages[0] || [];
  const page2 = pages[1] || [];
  const result = { format: 'v2', header: {}, utilities: {}, meters: [], municipality: {} };

  const summaryIdx = page1.findIndex(l => /^\d[\d,]*\.\d{2}(\s+-?\d[\d,]*\.\d{2}){2,}$/.test(l.trim()));
  if (summaryIdx >= 0) {
    const n = numbersInLine(page1[summaryIdx]);
    if (n.length) { result.header.totalAmount = n[0]; result.header.currentAmt = n[n.length - 1]; }
  }

  // Header labels and values are separate blocks, paired positionally
  const labelSeq = ['SEWA TRN NO','Personal ID','Account No.','Customer class','Invoice No&Date','Premise ID','Due Date','Billing Period','Last Receipt Date'];
  const labelIdx = page1.findIndex(l => l.startsWith('SEWA TRN NO'));
  if (labelIdx >= 0) {
    const valStart = page1.findIndex((l, i) => i > labelIdx && /^\d{15}$/.test(l.trim()));
    if (valStart >= 0) {
      const vals = page1.slice(valStart, valStart + labelSeq.length);
      const rec = {};
      labelSeq.forEach((lab, i) => { rec[lab] = vals[i]; });
      if (rec['Account No.']) result.header.accountNo = rec['Account No.'];
      if (rec['Invoice No&Date']) {
        const m = rec['Invoice No&Date'].match(/(\S+)\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
        if (m) { result.header.invoiceNo = m[1]; result.header.invoiceDate = normalizeDate(m[2]); }
      }
      if (rec['Due Date']) result.header.dueDate = normalizeDate(rec['Due Date']);
      if (rec['Billing Period']) {
        const m = rec['Billing Period'].match(/([A-Za-z]+)\s+(\d{4})/);
        if (m) { result.header.billingMonth = m[1]; result.header.billingYear = m[2]; result.header.monthKey = monthKeyFromName(m[1], m[2]); }
      }
    }
  }

  function parseUtilPanel(startLabel) {
    const startIdx = page1.findIndex(l => l.startsWith(startLabel));
    if (startIdx === -1) return null;
    const nextHeaders = ['Electricity','Water','Gas','Meter & Reading Details'].filter(h => h !== startLabel);
    let endIdx = page1.length;
    for (let i = startIdx + 1; i < page1.length; i++) {
      if (nextHeaders.some(h => page1[i].startsWith(h))) { endIdx = i; break; }
    }
    const block = page1.slice(startIdx + 1, endIdx);
    // A label or value can share a line with stray Arabic text or the next
    // label, so match leniently across the block.
    const labels = [], values = [];
    block.forEach(l => {
      const hit = UTIL_LABELS.find(u => l.includes(u));
      if (hit) labels.push(hit);
      numbersInLine(l).forEach(v => values.push(v));
    });
    return utilBlockFromLabelsAndValues(labels, values);
  }
  result.utilities.electricity = parseUtilPanel('Electricity') || emptyUtilBlock();
  result.utilities.water = parseUtilPanel('Water') || emptyUtilBlock();
  result.utilities.gas = parseUtilPanel('Gas') || emptyUtilBlock();

  // v2 meter table has no Rate / MF columns
  const meterRe = /([A-Za-z]{3}\s+\d{1,2},\s*\d{4})\s+([A-Za-z]{3}\s+\d{1,2},\s*\d{4})\s+(\d+)\s+(\d+)\s+(\d+)\s+([\w-]+)\s+(?:3 Phase-)?(Electricity|Water|Gas)/;
  for (const line of page1) {
    const m = line.match(meterRe);
    if (m) result.meters.push({
      currentReadingDate: normalizeDate(m[1]), previousReadingDate: normalizeDate(m[2]),
      consumption: num(m[3]), rate: null, mf: null,
      currentReading: num(m[4]), previousReading: num(m[5]), meterNumber: m[6], utility: m[7]
    });
  }

  // Sewerage / Sanitation rows: first number = Total, last = Current Amt
  function firstLast(lines, headerLabel) {
    const h = lines.findIndex(l => l.includes(headerLabel));
    if (h === -1) return null;
    for (let i = h; i < Math.min(h + 4, lines.length); i++) {
      const n = numbersInLine(lines[i]);
      if (n.length >= 2) return { total: n[0], current: n[n.length - 1] };
    }
    return null;
  }
  const sewerage = firstLast(page2, 'SEWERAGE');
  const sanitation = firstLast(page2, 'SANITATION');
  if (sewerage) result.municipality.currentAmount = sewerage.current;
  if (sanitation) result.municipality.publicHygiene = sanitation.current;

  // Final split: SEWA Amount, Municipality Amount, Total Amount
  const splitIdx = page2.findIndex(l => /^\d[\d,]*\.\d{2}\s+\d[\d,]*\.\d{2}\s+\d[\d,]*\.\d{2}$/.test(l.trim()));
  if (splitIdx >= 0) {
    const n = numbersInLine(page2[splitIdx]);
    if (n.length === 3) {
      result.header.sewaAmount = n[0];
      result.municipality.total = n[1];
      result.header.totalAmount = n[2];
    }
  }
  return result;
}

async function parsePdfFile(pdfjsLib, arrayBuffer) {
  const pages = await linearizePdf(pdfjsLib, arrayBuffer);
  const allLines = pages.flat();
  const parsed = allLines.some(l => l.includes('SEWERAGE')) ? parseV2(pages) : parseV1(allLines);
  // "Actual Bill" = sum of the three utilities' Total Including VAT (matches the user's sheet)
  const u = parsed.utilities;
  const actual = ['electricity', 'water', 'gas'].reduce((s, k) => s + ((u[k] && u[k].totalIncludingVAT) || 0), 0);
  parsed.municipality.actualBill = Math.round(actual * 100) / 100;
  return parsed;
}

// SMS: "...billed on 2026-08-05 - 2026-09-05 Sharjah Municipality: 62.70  Gas: 47.13 ... Total Outstanding: 716.00  Due Date : 2026-09-21 ..."
function parseSms(text) {
  const get = re => { const m = text.match(re); return m ? m[1].trim() : null; };
  const result = {
    accountNo: get(/account\s+(\S+)/i),
    periodStart: get(/billed on\s+(\d{4}-\d{2}-\d{2})/i),
    periodEnd: get(/billed on\s+\d{4}-\d{2}-\d{2}\s*-\s*(\d{4}-\d{2}-\d{2})/i),
    municipality: num(get(/Sharjah Municipality:\s*([\d,]+\.\d{2})/i)),
    gas: num(get(/\bGas:\s*([\d,]+\.\d{2})/i)),
    electricity: num(get(/\bElectricity:\s*([\d,]+\.\d{2})/i)),
    water: num(get(/\bWater:\s*([\d,]+\.\d{2})/i)),
    vat: num(get(/\bVAT:\s*([\d,]+\.\d{2})/i)),
    others: num(get(/\bOthers:\s*([\d,]+\.\d{2})/i)),
    arrears: num(get(/\bArrears:\s*([\d,]+\.\d{2})/i)),
    totalOutstanding: num(get(/Total Outstanding:\s*([\d,]+\.\d{2})/i)),
    dueDate: get(/Due Date\s*:\s*(\d{4}-\d{2}-\d{2})/i),
    billLink: get(/view bill\s+(https?:\/\/\S+)/i),
    quickpayLink: get(/QUICKPAY,?\s*click here\s+(https?:\/\/\S+)/i)
  };
  if (result.periodEnd) {
    const [y, m] = result.periodEnd.split('-');
    result.monthKey = `${MONTHS_SHORT[Number(m) - 1]}-${y}`;
  }
  return result;
}

window.SewaParser = { parsePdfFile, parseSms, linearizePdf, normalizeDate, monthKeyFromName, MONTHS, MONTHS_SHORT };
