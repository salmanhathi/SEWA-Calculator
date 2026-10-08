/* SEWA Bill Tracker — app logic. Everything lives in localStorage on this
   device only; nothing here sends data anywhere. */

const STORAGE_KEY = 'sewa_records_v1';
const TARIFF_KEY = 'sewa_tariff_v1';
const UTIL_KEYS = ['electricity', 'water', 'gas'];
const UTIL_LABEL = { electricity: 'Electricity', water: 'Water', gas: 'Gas' };
const DEFAULT_TARIFF = {
  electricity: { rate: 0.3, mf: 1, svcPerDay: 2.6667 },
  water: { rate: 0.035, mf: 220, svcPerDay: 0.6667 },
  gas: { rate: 2.15, mf: 1, svcPerDay: 0.6667 },
  vat: 5, sewerageRate: 0.015, hygienePerDay: 1
};

// ---------------- Storage ----------------
const Store = {
  all() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; } },
  save(all) { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); },
  upsert(rec) { const all = Store.all(); all[rec.monthKey] = rec; Store.save(all); },
  get(mk) { return Store.all()[mk]; },
  delete(mk) { const all = Store.all(); delete all[mk]; Store.save(all); },
  list() { return Object.values(Store.all()).sort((a, b) => monthKeySort(a.monthKey) - monthKeySort(b.monthKey)); }
};
function getTariff() {
  try { const t = JSON.parse(localStorage.getItem(TARIFF_KEY)); if (t) return t; } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_TARIFF));
}

// ---------------- Helpers ----------------
function monthKeySort(mk) {
  if (!mk) return 0;
  const [mon, yr] = mk.split('-');
  return Number(yr) * 12 + Math.max(0, SewaParser.MONTHS_SHORT.indexOf(mon));
}
const r2 = x => Math.round((x + 1e-9) * 100) / 100;
function fmtMoney(v) { return v == null || v === '' ? '—' : Number(v).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtNum(v) { return v == null || v === '' ? '—' : Number(v).toLocaleString('en-AE'); }
function numOrNull(v) { if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; }
function daysBetween(iso1, iso2) {
  if (!iso1 || !iso2) return null;
  const d1 = new Date(iso1), d2 = new Date(iso2);
  return isNaN(d1) || isNaN(d2) ? null : Math.round((d1 - d2) / 86400000);
}
function isoToDisplay(iso) { if (!iso) return null; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function monthKeyFromIso(iso) { const [y, m] = iso.split('-'); return `${SewaParser.MONTHS_SHORT[Number(m) - 1]}-${y}`; }
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? null : o[k]), obj); }
function setPath(obj, path, value) {
  const parts = path.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = value;
}
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------- Navigation ----------------
const RENDERERS = { dashboard: renderDashboard, add: renderAddBill, history: renderHistory, municipality: renderMunicipality, backup: renderBackup };
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('view-' + name).classList.add('active');
  RENDERERS[name]();
  window.scrollTo(0, 0);
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  showView(Store.list().length ? 'dashboard' : 'add');
});

// ---------------- Records ----------------
function emptyUtilRow() {
  return { currentReadingDate: null, previousReadingDate: null, consumption: null, rate: null, mf: null,
    currentReading: null, previousReading: null, meterNumber: null, previousBill: null, receipts: null,
    currentAmount: null, serviceCharges: null, adjustments: null, otherCharges: null, transformerCh: null,
    discounts: null, netTaxableAmount: null, vatRate: null, vatAmount: null, totalIncludingVAT: null,
    daysBetween: null, perDayCharges: null };
}
function blankRecord(monthKey) {
  const now = new Date();
  monthKey = monthKey || `${SewaParser.MONTHS_SHORT[now.getMonth()]}-${now.getFullYear()}`;
  return {
    monthKey, invoiceDate: null, dueDate: null, totalAmount: null, dueAmount: null, accountNo: null,
    utilities: { electricity: emptyUtilRow(), water: emptyUtilRow(), gas: emptyUtilRow() },
    municipality: { currentAmount: null, publicHygiene: null, total: null, actualBill: null },
    source: 'manual', format: null, updatedAt: new Date().toISOString()
  };
}
function recordFromParsed(parsed, source) {
  const rec = blankRecord(parsed.header.monthKey || undefined);
  const t = getTariff();
  rec.source = source; rec.format = parsed.format;
  ['invoiceDate', 'dueDate', 'totalAmount', 'dueAmount', 'accountNo'].forEach(f => { if (parsed.header[f] != null) rec[f] = parsed.header[f]; });
  UTIL_KEYS.forEach(k => { rec.utilities[k] = Object.assign(emptyUtilRow(), parsed.utilities[k] || {}); });
  (parsed.meters || []).forEach(m => {
    const u = rec.utilities[(m.utility || '').toLowerCase()];
    if (!u) return;
    Object.assign(u, { currentReadingDate: m.currentReadingDate, previousReadingDate: m.previousReadingDate,
      consumption: m.consumption, rate: m.rate, mf: m.mf, currentReading: m.currentReading,
      previousReading: m.previousReading, meterNumber: m.meterNumber });
  });
  // Newer bills don't print Rate / MF — fall back to saved tariff
  UTIL_KEYS.forEach(k => {
    const u = rec.utilities[k];
    if (u.rate == null) u.rate = t[k].rate;
    if (u.mf == null) u.mf = t[k].mf;
  });
  Object.assign(rec.municipality, parsed.municipality || {});
  return rec;
}
function finalizeDerived(rec) {
  UTIL_KEYS.forEach(k => {
    const u = rec.utilities[k];
    const d = daysBetween(u.currentReadingDate && u.currentReadingDate.iso, u.previousReadingDate && u.previousReadingDate.iso);
    if (d != null) u.daysBetween = d;
    u.perDayCharges = (u.totalIncludingVAT != null && u.daysBetween) ? r2(u.totalIncludingVAT / u.daysBetween) : null;
  });
}

// ---------------- Dashboard ----------------
function emptyState(title, body) {
  return `<div class="empty-state"><div style="font-weight:600;color:var(--paper)">${title}</div><p>${body}</p>
    <button class="btn btn-primary" style="margin-top:14px" onclick="showView('add')">Add a bill</button></div>`;
}
function renderDashboard() {
  const el = document.getElementById('view-dashboard');
  const records = Store.list();
  if (!records.length) { el.innerHTML = emptyState('No bills yet', 'Upload a SEWA PDF, paste the SMS, or use the calculator. You can also import your existing Excel data from the Backup tab.'); return; }
  const latest = records[records.length - 1], prev = records.length > 1 ? records[records.length - 2] : null;
  const cards = UTIL_KEYS.map(k => {
    const u = latest.utilities[k], pu = prev ? prev.utilities[k] : {};
    const delta = u.consumption != null && pu.consumption != null ? u.consumption - pu.consumption : null;
    return `<div class="util-card ${k}"><div class="util-name">${UTIL_LABEL[k]}</div>
      <div class="big-figure">${fmtMoney(u.totalIncludingVAT)}<span class="unit">AED</span></div>
      <div class="sub-figure">${fmtNum(u.consumption)} units${delta != null ? ` · ${delta >= 0 ? '+' : ''}${r2(delta)} vs prev` : ''}</div></div>`;
  }).join('');
  const muni = latest.municipality || {};
  const trend = records.slice(-12), max = Math.max(...trend.map(r => r.totalAmount || 0), 1);
  const bars = trend.map(r => `<div class="trend-bar" style="height:${Math.max(3, Math.round((r.totalAmount || 0) / max * 44))}px" title="${r.monthKey}: ${fmtMoney(r.totalAmount)} AED"></div>`).join('');
  el.innerHTML = `
    <div class="section-head"><h1>${latest.monthKey}</h1><span class="meta">${latest.dueDate ? 'Due ' + (latest.dueDate.display || latest.dueDate.iso || '') : ''}</span></div>
    <div class="panel"><div class="panel-title">Total bill</div>
      <div class="big-figure" style="font-size:34px">${fmtMoney(latest.totalAmount)}<span class="unit">AED</span></div>
      <div class="trend-row">${bars}</div></div>
    <div class="card-grid">${cards}
      <div class="util-card municipality"><div class="util-name">Municipality</div>
        <div class="big-figure">${fmtMoney((muni.currentAmount || 0) + (muni.publicHygiene || 0))}<span class="unit">AED</span></div>
        <div class="sub-figure">Hygiene ${fmtMoney(muni.publicHygiene)}</div></div></div>
    <div class="btn-row"><button class="btn btn-primary" onclick="addSubTab='manual';showView('add')">+ Next bill</button>
      <button class="btn" onclick="showView('history')">History</button></div>`;
}

// ---------------- Add bill ----------------
let addSubTab = 'pdf';
let draftRecord = null;
let calcState = null;

function renderAddBill() {
  const el = document.getElementById('view-add');
  const tab = (id, label) => `<button class="subtab-btn ${addSubTab === id ? 'active' : ''}" data-sub="${id}">${label}</button>`;
  el.innerHTML = `<div class="section-head"><h1>Add a bill</h1></div>
    <div class="subtabs">${tab('pdf', 'Upload PDF')}${tab('manual', 'Calculator')}${tab('sms', 'Paste SMS')}</div>
    <div id="add-body"></div>`;
  el.querySelectorAll('.subtab-btn').forEach(b => b.addEventListener('click', () => { addSubTab = b.dataset.sub; draftRecord = null; renderAddBill(); }));
  renderAddBody();
}
function renderAddBody() {
  const body = document.getElementById('add-body');
  body.oninput = null;
  if (draftRecord) return renderReviewForm(body);
  if (addSubTab === 'pdf') {
    body.innerHTML = `<label class="upload-zone"><div>Tap to choose a SEWA bill PDF</div>
      <div style="font-size:11.5px;margin-top:6px">Read on this device — the file never leaves your phone</div>
      <input type="file" id="pdf-input" accept="application/pdf"></label>
      <div id="pdf-status" style="margin-top:12px;color:var(--faint);font-size:12.5px"></div>`;
    document.getElementById('pdf-input').addEventListener('change', handlePdfUpload);
  } else if (addSubTab === 'sms') {
    body.innerHTML = `<div class="panel"><div class="panel-title">Paste the full SEWA SMS text</div>
      <div class="field"><textarea id="sms-text" placeholder="Dear Customer, Your Utility services bill for the account …"></textarea></div>
      <button class="btn btn-primary btn-block" id="sms-parse-btn">Read SMS</button></div>`;
    document.getElementById('sms-parse-btn').addEventListener('click', handleSmsParse);
  } else renderCalculator(body);
}
async function handlePdfUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  const status = document.getElementById('pdf-status');
  status.textContent = 'Reading PDF…';
  try {
    const parsed = await SewaParser.parsePdfFile(pdfjsLib, await file.arrayBuffer());
    draftRecord = recordFromParsed(parsed, 'pdf-' + parsed.format);
    renderAddBody();
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't read that PDF — use the Calculator tab to enter the readings by hand.";
  }
}
function handleSmsParse() {
  const text = document.getElementById('sms-text').value.trim();
  if (!text) { toast('Paste the SMS text first'); return; }
  const s = SewaParser.parseSms(text);
  if (s.totalOutstanding == null) { toast("That doesn't look like a SEWA SMS"); return; }
  const rec = blankRecord(s.monthKey || undefined);
  rec.source = 'sms'; rec.totalAmount = s.totalOutstanding; rec.accountNo = null;
  rec.dueDate = s.dueDate ? { iso: s.dueDate, display: isoToDisplay(s.dueDate) } : null;
  rec.utilities.electricity.totalIncludingVAT = s.electricity;
  rec.utilities.water.totalIncludingVAT = s.water;
  rec.utilities.gas.totalIncludingVAT = s.gas;
  rec.municipality.total = s.municipality;
  rec.municipality.actualBill = r2((s.electricity || 0) + (s.water || 0) + (s.gas || 0));
  draftRecord = rec; renderAddBody();
}

// Compare billed totals against the calculator's formula — flags misread PDFs
function calcMismatches(rec) {
  const t = getTariff(), out = [];
  UTIL_KEYS.forEach(k => {
    const u = rec.utilities[k];
    if (u.currentReading == null || u.previousReading == null || u.totalIncludingVAT == null) return;
    const days = daysBetween(u.currentReadingDate && u.currentReadingDate.iso, u.previousReadingDate && u.previousReadingDate.iso);
    if (!days) return;
    const cur = r2((u.currentReading - u.previousReading) * (u.mf || t[k].mf) * (u.rate || t[k].rate));
    const expected = r2((cur + r2(days * t[k].svcPerDay)) * (1 + t.vat / 100));
    if (Math.abs(expected - u.totalIncludingVAT) > 0.05) out.push(`${UTIL_LABEL[k]}: bill ${fmtMoney(u.totalIncludingVAT)}, calculator ${fmtMoney(expected)}`);
  });
  return out;
}

const UTIL_FIELDS = [
  ['currentReadingDate.iso', 'Current reading date', 'date'], ['previousReadingDate.iso', 'Previous reading date', 'date'],
  ['consumption', 'Consumption', 'number'], ['rate', 'Rate', 'number'], ['mf', 'MF', 'number'],
  ['currentReading', 'Current reading', 'number'], ['previousReading', 'Previous reading', 'number'],
  ['meterNumber', 'Meter number', 'text'], ['currentAmount', 'Current amount', 'number'],
  ['serviceCharges', 'Service charges', 'number'], ['netTaxableAmount', 'Net taxable amount', 'number'],
  ['vatRate', 'VAT rate %', 'number'], ['vatAmount', 'VAT amount', 'number'], ['totalIncludingVAT', 'Total (inc VAT)', 'number']
];
function renderReviewForm(body) {
  const r = draftRecord, existing = Store.get(r.monthKey), mism = calcMismatches(r);
  const banners = [existing ? `<div class="review-banner warn">A bill for ${r.monthKey} already exists. Saving will overwrite it.</div>` : `<div class="review-banner">Check the figures read from the bill, correct anything that looks off, then save.</div>`];
  if (mism.length) banners.push(`<div class="review-banner warn">Doesn't match the calculator — worth a second look:<br>${mism.join('<br>')}</div>`);
  const dueIso = r.dueDate ? (r.dueDate.iso || '') : '';
  body.innerHTML = `${banners.join('')}
    <div class="panel"><div class="panel-title">Bill details</div>
      <div class="field-row"><div class="field"><label>Month</label><input id="f-monthKey" value="${r.monthKey || ''}"></div>
        <div class="field"><label>Total amount (AED)</label><input id="f-totalAmount" type="number" step="0.01" value="${r.totalAmount ?? ''}"></div></div>
      <div class="field"><label>Due date</label><input id="f-dueDate" type="date" value="${dueIso}"></div></div>
    ${UTIL_KEYS.map(k => `<div class="panel"><div class="panel-title" style="color:var(--${k})">${UTIL_LABEL[k]}</div><div class="field-row">
      ${UTIL_FIELDS.map(([path, label, type]) => `<div class="field"><label>${label}</label>
        <input data-util="${k}" data-path="${path}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${getPath(r.utilities[k], path) ?? ''}"></div>`).join('')}
      </div></div>`).join('')}
    <div class="panel"><div class="panel-title" style="color:var(--municipality)">Sharjah Municipality</div><div class="field-row">
      ${[['currentAmount', 'Sewerage (current amount)'], ['publicHygiene', 'Public hygiene'], ['total', 'Municipality total'], ['actualBill', 'Actual bill (utilities)']]
        .map(([p, l]) => `<div class="field"><label>${l}</label><input data-muni="${p}" type="number" step="0.01" value="${r.municipality[p] ?? ''}"></div>`).join('')}
    </div></div>
    <div class="btn-row"><button class="btn btn-primary" id="save-record-btn">Save bill</button><button class="btn btn-ghost" id="cancel-record-btn">Cancel</button></div>`;
  document.getElementById('save-record-btn').addEventListener('click', saveDraftRecord);
  document.getElementById('cancel-record-btn').addEventListener('click', () => { draftRecord = null; renderAddBody(); });
}
function saveDraftRecord() {
  const r = draftRecord;
  r.monthKey = document.getElementById('f-monthKey').value.trim();
  if (!r.monthKey) { toast('Enter a month like Sep-2026'); return; }
  r.totalAmount = numOrNull(document.getElementById('f-totalAmount').value);
  const due = document.getElementById('f-dueDate').value;
  r.dueDate = due ? { iso: due, display: isoToDisplay(due) } : null;
  document.querySelectorAll('[data-util]').forEach(inp => {
    const k = inp.dataset.util, path = inp.dataset.path;
    if (path.endsWith('.iso')) setPath(r.utilities[k], path.replace('.iso', ''), inp.value ? { iso: inp.value, display: isoToDisplay(inp.value) } : null);
    else setPath(r.utilities[k], path, inp.type === 'number' ? numOrNull(inp.value) : (inp.value.trim() || null));
  });
  document.querySelectorAll('[data-muni]').forEach(inp => { r.municipality[inp.dataset.muni] = numOrNull(inp.value); });
  finalizeDerived(r);
  r.updatedAt = new Date().toISOString();
  Store.upsert(r);
  toast(`Saved ${r.monthKey}`);
  draftRecord = null; showView('history');
}

// ---------------- Calculator ----------------
function initCalcState() {
  const t = getTariff(), last = Store.list().slice(-1)[0];
  const st = { monthKey: '', svcOverride: {}, utils: {}, vat: t.vat, sewerageRate: t.sewerageRate, hygienePerDay: t.hygienePerDay };
  UTIL_KEYS.forEach(k => {
    const lu = last ? last.utilities[k] : {};
    st.utils[k] = {
      prevDate: (lu.currentReadingDate && lu.currentReadingDate.iso) || '', curDate: '',
      prevReading: lu.currentReading != null ? lu.currentReading : '', consumption: '',
      mf: lu.mf != null ? lu.mf : t[k].mf, rate: lu.rate != null ? lu.rate : t[k].rate, svcPerDay: t[k].svcPerDay
    };
  });
  return st;
}
function renderCalculator(body) {
  if (!calcState) calcState = initCalcState();
  const st = calcState;
  const f = (k, field, label, type = 'number', step = 'any') =>
    `<div class="field"><label>${label}</label><input data-calc="${k}.${field}" type="${type}" ${type === 'number' ? `step="${step}"` : ''} value="${st.utils[k][field]}"></div>`;
  const hasPrev = k => !!st.utils[k].prevDate;
  body.innerHTML = `
    <div class="review-banner">Enter the reading date and the consumption for each meter — everything else is worked out as you type. The previous date and reading come from your last saved bill.</div>
    <div class="panel"><div class="field" style="margin:0"><label>Month (defaults to the electricity reading month)</label><input id="calc-monthKey" value="${st.monthKey}"></div></div>
    ${UTIL_KEYS.map(k => `<div class="panel"><div class="panel-title" style="color:var(--${k})">${UTIL_LABEL[k]}</div>
      ${hasPrev(k) ? '' : `<div class="field-row">${f(k, 'prevDate', 'Previous reading date', 'date')}${f(k, 'prevReading', 'Previous reading (optional)')}</div>`}
      <div class="field-row">${f(k, 'curDate', 'Current reading date', 'date')}${f(k, 'consumption', 'Consumption (billed units)')}</div>
      <details style="margin-bottom:10px"><summary style="cursor:pointer;color:var(--faint);font-size:12.5px">Tariff for ${UTIL_LABEL[k].toLowerCase()}</summary>
        <div class="field-row" style="margin-top:10px">${f(k, 'mf', 'MF')}${f(k, 'rate', 'Rate', 'number', '0.0001')}</div>
        <div class="field-row">${f(k, 'svcPerDay', 'Service charge per day', 'number', '0.0001')}
          <div class="field"><label>Service charge override</label><input data-calc-svc="${k}" type="number" step="0.01" placeholder="auto" value="${st.svcOverride[k] ?? ''}"></div></div></details>
      <div id="res-${k}"></div></div>`).join('')}
    <div class="panel"><div class="panel-title" style="color:var(--municipality)">Sharjah Municipality and total</div>
      <details style="margin-bottom:10px"><summary style="cursor:pointer;color:var(--faint);font-size:12.5px">Municipality tariff and VAT</summary>
        <div class="field-row" style="margin-top:10px"><div class="field"><label>VAT %</label><input id="calc-vat" type="number" step="0.01" value="${st.vat}"></div>
          <div class="field"><label>Sewerage per water unit</label><input id="calc-sew" type="number" step="0.0001" value="${st.sewerageRate}"></div></div>
        <div class="field"><label>Hygiene per day</label><input id="calc-hyg" type="number" step="0.01" value="${st.hygienePerDay}"></div></details>
      <div id="res-muni"></div></div>
    <div class="btn-row"><button class="btn btn-primary" id="calc-save-btn">Save bill</button><button class="btn btn-ghost" id="calc-reset-btn">Reset</button></div>`;
  body.oninput = e => {
    const t = e.target;
    if (t.dataset.calc) { const [k, field] = t.dataset.calc.split('.'); st.utils[k][field] = t.value; }
    else if (t.dataset.calcSvc) st.svcOverride[t.dataset.calcSvc] = t.value === '' ? null : Number(t.value);
    else if (t.id === 'calc-monthKey') st.monthKey = t.value.trim();
    else if (t.id === 'calc-vat') st.vat = Number(t.value);
    else if (t.id === 'calc-sew') st.sewerageRate = Number(t.value);
    else if (t.id === 'calc-hyg') st.hygienePerDay = Number(t.value);
    updateCalcResults();
  };
  document.getElementById('calc-save-btn').addEventListener('click', saveCalcRecord);
  document.getElementById('calc-reset-btn').addEventListener('click', () => { calcState = null; renderAddBody(); });
  updateCalcResults();
}
function computeCalc() {
  const st = calcState, out = { utils: {} };
  UTIL_KEYS.forEach(k => {
    const u = st.utils[k];
    const days = daysBetween(u.curDate, u.prevDate);
    const cons = u.consumption === '' ? null : Number(u.consumption);
    const row = { days, consumption: null, curReading: null, currentAmount: null, svc: null, net: null, vat: null, total: null, perDay: null };
    if (cons !== null && !isNaN(cons)) {
      row.consumption = cons;
      if (u.prevReading !== '' && Number(u.mf)) row.curReading = Math.round((Number(u.prevReading) + cons / Number(u.mf)) * 1000) / 1000;
      row.currentAmount = r2(row.consumption * Number(u.rate));
      const ov = st.svcOverride[k];
      row.svc = ov != null ? ov : (days ? r2(days * Number(u.svcPerDay)) : null);
      if (row.svc !== null) {
        row.net = r2(row.currentAmount + row.svc);
        row.vat = r2(row.net * st.vat / 100);
        row.total = r2(row.net * (1 + st.vat / 100));
        row.perDay = days ? r2(row.total / days) : null;
      }
    }
    out.utils[k] = row;
  });
  const e = out.utils.electricity, w = out.utils.water, g = out.utils.gas;
  if ([e, w, g].every(x => x.total !== null)) {
    out.actual = r2(e.total + w.total + g.total);
    out.sewerage = r2(w.consumption * st.sewerageRate);
    out.hygiene = e.days ? r2(e.days * st.hygienePerDay) : null;
    out.grand = out.hygiene !== null ? Math.ceil(r2(out.actual + out.sewerage + out.hygiene)) : null;
  }
  return out;
}
function updateCalcResults() {
  const st = calcState, c = computeCalc();
  const line = (l, v, bold) => `<div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:13px;padding:2px 0;${bold ? 'font-weight:600;color:var(--paper)' : 'color:var(--muted)'}"><span>${l}</span><span>${v}</span></div>`;
  UTIL_KEYS.forEach(k => {
    const r = c.utils[k], el = document.getElementById('res-' + k);
    if (!el) return;
    el.innerHTML = r.total === null ? `<div style="color:var(--faint);font-size:12.5px">Enter the reading date and consumption to see the charges.</div>` :
      `<hr class="hairline">${line('Days', r.days)}${line('Consumption', fmtNum(r.consumption))}${r.curReading != null ? line('Current reading', fmtNum(r.curReading)) : ''}${line('Current amount', fmtMoney(r.currentAmount))}${line('Service charges', fmtMoney(r.svc))}${line('VAT ' + st.vat + '%', fmtMoney(r.vat))}${line('Total (inc VAT)', fmtMoney(r.total), true)}${line('Per day', fmtMoney(r.perDay))}`;
  });
  const m = document.getElementById('res-muni');
  if (m) m.innerHTML = c.grand == null ? `<div style="color:var(--faint);font-size:12.5px">Complete all three utilities to see municipality charges and the grand total.</div>` :
    `${line('Actual bill (utilities)', fmtMoney(c.actual))}${line('Sewerage', fmtMoney(c.sewerage))}${line('Public hygiene', fmtMoney(c.hygiene))}<hr class="hairline">${line('Total (rounded up)', fmtMoney(c.grand), true)}`;
}
function saveCalcRecord() {
  const st = calcState, c = computeCalc();
  if (c.grand == null) { toast('Enter the date and consumption for all three utilities'); return; }
  const monthKey = st.monthKey || monthKeyFromIso(st.utils.electricity.curDate);
  if (Store.get(monthKey) && !confirm(`A bill for ${monthKey} already exists. Overwrite it?`)) return;
  const last = Store.list().filter(r => r.monthKey !== monthKey).slice(-1)[0];
  const rec = blankRecord(monthKey);
  rec.source = 'calculator';
  UTIL_KEYS.forEach(k => {
    const u = st.utils[k], r = c.utils[k], t = rec.utilities[k];
    Object.assign(t, {
      currentReadingDate: { iso: u.curDate, display: isoToDisplay(u.curDate) },
      previousReadingDate: { iso: u.prevDate, display: isoToDisplay(u.prevDate) },
      consumption: r.consumption, rate: Number(u.rate), mf: Number(u.mf),
      currentReading: r.curReading, previousReading: u.prevReading === '' ? null : Number(u.prevReading),
      meterNumber: last ? last.utilities[k].meterNumber : null,
      currentAmount: r.currentAmount, serviceCharges: r.svc, netTaxableAmount: r.net, vatRate: st.vat,
      vatAmount: r.vat, totalIncludingVAT: r.total, daysBetween: r.days, perDayCharges: r.perDay
    });
  });
  Object.assign(rec.municipality, { actualBill: c.actual, currentAmount: c.sewerage, publicHygiene: c.hygiene, total: r2(c.sewerage + c.hygiene) });
  rec.totalAmount = c.grand;
  Store.upsert(rec);
  const tariff = { vat: st.vat, sewerageRate: st.sewerageRate, hygienePerDay: st.hygienePerDay };
  UTIL_KEYS.forEach(k => { tariff[k] = { rate: Number(st.utils[k].rate), mf: Number(st.utils[k].mf), svcPerDay: Number(st.utils[k].svcPerDay) }; });
  localStorage.setItem(TARIFF_KEY, JSON.stringify(tariff));
  calcState = null; toast(`Saved ${monthKey}`); showView('history');
}

// ---------------- History ----------------
function renderHistory() {
  const el = document.getElementById('view-history'), records = Store.list();
  if (!records.length) { el.innerHTML = emptyState('No bills recorded', 'Each bill appears here as one row per utility, like your spreadsheet.'); return; }
  const dt = d => d ? (d.display || d.iso || '—') : '—';
  const rows = [];
  records.forEach(r => UTIL_KEYS.forEach(k => { const u = r.utilities[k]; if (u.consumption != null || u.totalIncludingVAT != null) rows.push([r.monthKey, k, u]); }));
  el.innerHTML = `<div class="section-head"><h1>History</h1><span class="meta">${records.length} bills</span></div>
    <div class="table-wrap"><table><thead><tr><th>Month</th><th>Utility</th><th>Current reading date</th><th>Previous reading date</th><th>Consumption</th><th>Rate</th><th>MF</th><th>Current reading</th><th>Previous reading</th><th>Meter number</th><th>Days</th><th>Current amount</th><th>Service charges</th><th>Total (inc VAT)</th><th>Per day</th><th></th></tr></thead><tbody>
    ${rows.map(([mk, k, u]) => `<tr><td class="month-cell">${mk}</td><td class="util-tag ${k}">${UTIL_LABEL[k]}</td>
      <td>${dt(u.currentReadingDate)}</td><td>${dt(u.previousReadingDate)}</td><td>${fmtNum(u.consumption)}</td><td>${u.rate ?? '—'}</td><td>${u.mf ?? '—'}</td>
      <td>${fmtNum(u.currentReading)}</td><td>${fmtNum(u.previousReading)}</td><td>${u.meterNumber || '—'}</td><td>${u.daysBetween ?? '—'}</td>
      <td>${fmtMoney(u.currentAmount)}</td><td>${fmtMoney(u.serviceCharges)}</td><td>${fmtMoney(u.totalIncludingVAT)}</td><td>${fmtMoney(u.perDayCharges)}</td>
      <td><button class="btn btn-sm" onclick="editRecord('${mk}')">Edit</button> <button class="btn btn-sm btn-danger" onclick="deleteRecordConfirm('${mk}')">Delete</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
function editRecord(mk) {
  const r = Store.get(mk); if (!r) return;
  draftRecord = JSON.parse(JSON.stringify(r)); addSubTab = 'pdf'; showView('add');
}
function deleteRecordConfirm(mk) {
  if (confirm(`Delete the bill for ${mk}? This can't be undone.`)) { Store.delete(mk); toast(`Deleted ${mk}`); renderHistory(); }
}

// ---------------- Municipality ----------------
function renderMunicipality() {
  const el = document.getElementById('view-municipality'), records = Store.list();
  if (!records.length) { el.innerHTML = emptyState('No municipality data yet', 'Municipality charges come from the same bill you add.'); return; }
  el.innerHTML = `<div class="section-head"><h1>Sharjah Municipality</h1><span class="meta">${records.length} months</span></div>
    <div class="table-wrap"><table><thead><tr><th>Billing period</th><th>Total</th><th>Actual bill</th><th>Current amount</th><th>Public hygiene charges</th></tr></thead><tbody>
    ${records.map(r => `<tr><td class="month-cell">${r.monthKey}</td><td>${fmtMoney(r.totalAmount)}</td><td>${fmtMoney(r.municipality.actualBill)}</td><td>${fmtMoney(r.municipality.currentAmount)}</td><td>${fmtMoney(r.municipality.publicHygiene)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---------------- Backup / export / import ----------------
function renderBackup() {
  const el = document.getElementById('view-backup'), n = Store.list().length;
  el.innerHTML = `<div class="section-head"><h1>Backup and import</h1></div>
    <div class="panel"><div class="panel-title">Stored on this device only</div>
      <p style="margin:0;color:var(--muted);font-size:13px">${n} bill${n === 1 ? '' : 's'} saved in this browser. Nothing is uploaded anywhere. Export a backup before clearing browser data or changing phones.</p></div>
    <div class="panel"><div class="panel-title">Export</div><div class="btn-row">
      <button class="btn btn-primary" id="export-xlsx-btn">Export to Excel</button><button class="btn" id="export-json-btn">Export JSON backup</button></div></div>
    <div class="panel"><div class="panel-title">Restore from JSON backup</div><input type="file" id="import-json-input" accept="application/json"></div>
    <div class="panel"><div class="panel-title">Import your utility sheet</div>
      <p style="margin:0 0 10px;color:var(--muted);font-size:12.5px">Copy the rows from Excel (header row included) and paste them here.</p>
      <div class="field"><textarea id="legacy-paste"></textarea></div><button class="btn" id="legacy-import-btn">Import utility rows</button></div>
    <div class="panel"><div class="panel-title">Import your municipality sheet</div>
      <p style="margin:0 0 10px;color:var(--muted);font-size:12.5px">Paste Billing Period, Total, Actual Bill, Current Amount and Public Hygiene Charges. Months without a year are taken as 2026.</p>
      <div class="field"><textarea id="muni-paste"></textarea></div><button class="btn" id="muni-import-btn">Import municipality rows</button></div>`;
  document.getElementById('export-xlsx-btn').addEventListener('click', exportXlsx);
  document.getElementById('export-json-btn').addEventListener('click', () => { downloadBlob(JSON.stringify(Store.all(), null, 2), 'sewa-tracker-backup.json', 'application/json'); toast('Backup exported'); });
  document.getElementById('import-json-input').addEventListener('change', importJson);
  document.getElementById('legacy-import-btn').addEventListener('click', importLegacyPaste);
  document.getElementById('muni-import-btn').addEventListener('click', importMuniPaste);
}
function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function importJson(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { const inc = JSON.parse(reader.result); Store.save(Object.assign(Store.all(), inc)); toast(`Restored ${Object.keys(inc).length} bills`); renderBackup(); }
    catch (err) { toast("Couldn't read that file"); }
  };
  reader.readAsText(file);
}
function exportXlsx() {
  const records = Store.list();
  if (!records.length) { toast('Nothing to export yet'); return; }
  const dt = d => d ? (d.display || d.iso || '') : '';
  const util = [];
  records.forEach(r => UTIL_KEYS.forEach(k => {
    const u = r.utilities[k]; if (u.consumption == null && u.totalIncludingVAT == null) return;
    util.push({ Month: r.monthKey, 'Current Reading Date': dt(u.currentReadingDate), 'Previous Reading Date': dt(u.previousReadingDate),
      Consumption: u.consumption, Rate: u.rate, MF: u.mf, 'Current Reading': u.currentReading, 'Previous Reading': u.previousReading,
      'Meter Number': u.meterNumber, 'Consumer Number': k === 'electricity' ? '3 Phase-Electricity' : UTIL_LABEL[k],
      'Days between Bills': u.daysBetween, 'Current Amount': u.currentAmount, 'Service Charges': u.serviceCharges,
      'Total (Inc VAT)': u.totalIncludingVAT, 'Per Day Charges': u.perDayCharges });
  }));
  const muni = records.map(r => ({ 'Billing Period': r.monthKey, Total: r.totalAmount, 'Actual Bill': r.municipality.actualBill,
    'Current Amount': r.municipality.currentAmount, 'Public Hygiene Charges': r.municipality.publicHygiene }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(util), 'Utilities');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(muni), 'Municipality');
  XLSX.writeFile(wb, 'sewa-bill-tracker.xlsx'); toast('Excel file downloaded');
}

function mkDate(raw) {
  if (!raw || !raw.trim()) return null;
  const n = SewaParser.normalizeDate(raw.trim());
  return n || { iso: null, display: raw.trim() };
}
function normalizeMonthKey(raw, defaultYear) {
  const m = raw.trim().match(/^([A-Za-z]{3,9})(?:[- ]?(\d{4}))?$/);
  if (!m) return null;
  const idx = SewaParser.MONTHS_SHORT.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
  return idx === -1 ? null : `${SewaParser.MONTHS_SHORT[idx]}-${m[2] || defaultYear}`;
}
function importLegacyPaste() {
  const text = document.getElementById('legacy-paste').value.trim();
  if (!text) { toast('Paste some rows first'); return; }
  const lines = text.split('\n').map(l => l.replace(/\r$/, '').split('\t'));
  const header = lines[0].map(h => h.replace(/\s+/g, ' ').trim().toLowerCase());
  const idx = name => { const n = name.toLowerCase(); const e = header.indexOf(n); return e !== -1 ? e : header.findIndex(h => h.startsWith(n)); };
  const svcDay = header.findIndex(h => h.includes('service charges') && h.includes('day'));
  const col = { month: idx('month'), crd: idx('current reading date'), prd: idx('previous reading date'), cons: idx('consumption'),
    rate: idx('rate'), mf: idx('mf'), cr: idx('current reading'), pr: idx('previous reading'), meter: idx('meter number'),
    days: idx('days between bills'), curAmt: idx('current amount'), svc: svcDay !== -1 ? svcDay : idx('service charges'),
    total: idx('total (inc vat)'), perDay: idx('per day charges') };
  if (col.month === -1 || col.meter === -1) { toast("Couldn't find the Month and Meter Number columns"); return; }
  let imported = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i];
    const mk = c[col.month] && normalizeMonthKey(c[col.month], '2026');
    const meter = (c[col.meter] || '').trim();
    const k = meter.startsWith('E-') ? 'electricity' : meter.startsWith('W-') ? 'water' : meter.startsWith('G-') ? 'gas' : null;
    if (!mk || !k) continue;
    const rec = Store.get(mk) || blankRecord(mk);
    if (rec.source === 'manual') rec.source = 'import';
    Object.assign(rec.utilities[k], {
      currentReadingDate: mkDate(c[col.crd]), previousReadingDate: mkDate(c[col.prd]), consumption: numOrNull(c[col.cons]),
      rate: numOrNull(c[col.rate]), mf: numOrNull(c[col.mf]), currentReading: numOrNull(c[col.cr]), previousReading: numOrNull(c[col.pr]),
      meterNumber: meter, daysBetween: numOrNull(c[col.days]), currentAmount: numOrNull(c[col.curAmt]),
      serviceCharges: numOrNull(c[col.svc]), totalIncludingVAT: numOrNull(c[col.total]), perDayCharges: numOrNull(c[col.perDay])
    });
    rec.municipality.actualBill = r2(UTIL_KEYS.reduce((s, x) => s + (rec.utilities[x].totalIncludingVAT || 0), 0));
    Store.upsert(rec); imported++;
  }
  toast(`Imported ${imported} rows`);
  document.getElementById('legacy-paste').value = '';
}
function importMuniPaste() {
  const text = document.getElementById('muni-paste').value.trim();
  if (!text) { toast('Paste some rows first'); return; }
  let imported = 0;
  text.split('\n').forEach(line => {
    const c = line.replace(/\r$/, '').split('\t').map(x => x.trim());
    const mk = c[0] && normalizeMonthKey(c[0], '2026');
    if (!mk) return;
    const rec = Store.get(mk) || blankRecord(mk);
    if (rec.source === 'manual') rec.source = 'import';
    rec.totalAmount = numOrNull(c[1]);
    rec.municipality.actualBill = numOrNull(c[2]);
    rec.municipality.currentAmount = numOrNull(c[3]);
    rec.municipality.publicHygiene = numOrNull(c[4]);
    Store.upsert(rec); imported++;
  });
  toast(`Imported ${imported} months`);
  document.getElementById('muni-paste').value = '';
}
