'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  currency: 'CHF',
  accounts: [],
  income: [],
  expenses: [],
  investments: [],
  debts: [],
  goals: [],
  portfolioValue: 0,
  networthHistory: [],
  transactions: [],
  portfolioHistory: [],
  cardPayments: [],
  contracts: [],
  wishlist: [],
  tagBudgets: {},
  milestones: [],
  streak: { history: {}, startKey: null },
  settings: { inflationRate: 2, fireWithdrawalRate: 4, fireMonthlyExpenses: 0, taxEstimate: null, taxCanton: 'ZH',
              privacy: false, pinHash: null, pinLength: null, lastBackup: 0, backupSnooze: 0,
              // v2: Budgetmonat & Lohn
              monthMode: 'calendar', payday: 25, paydayWeekendShift: true, transfersDoneFor: null,
              payroll: { ahv: 5.3, alv: 1.1, alvCap: 148200, nbu: 1.0, bvgMonthly: 0 },
              grossCalc: { a: 0, b: 0, n: 12, compare: false },
              // v4: Entscheidungshilfen
              workPriceEnabled: true, workHoursPerWeek: 42, workPriceThreshold: 50,
              wishWaitDays: 30, likRate: null,
              // v5: Motivation
              savingsGoalType: 'pct', savingsGoalValue: 20, milestonesInit: false, hadDebt: false }
};

// Aktuelle Version des Datenmodells. Jede Erhöhung braucht einen Schritt in MIGRATIONS.
const SCHEMA_VERSION = 5;

// ── Kontotypen ─────────────────────────────────────────────────────────────
const ACCOUNT_TYPES = {
  liquid:  { label: 'Liquid (Privatkonto)', short: 'Liquid',      icon: '💳' },
  savings: { label: 'Sparkonto',            short: 'Sparkonto',   icon: '🏦' },
  credit:  { label: 'Kreditkarte',          short: 'Kreditkarte', icon: '💳' },
  bound:   { label: 'Gebunden (Depot, 3a, Kaution …)', short: 'Gebunden', icon: '🔒' }
};
const accTypeLabel = t => (ACCOUNT_TYPES[t] || ACCOUNT_TYPES.liquid).short;
const accTypeIcon  = t => t === 'credit' ? '🪪' : (ACCOUNT_TYPES[t] || ACCOUNT_TYPES.liquid).icon;

// ── Rhythmus & Datums-Helfer ───────────────────────────────────────────────
// Bewusst vor migrateState/state definiert: werden schon beim Laden der Daten gebraucht.
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
const CYCLE_LABEL  = { monthly: 'Monatlich', quarterly: 'Vierteljährlich', semiannual: 'Halbjährlich', yearly: 'Jährlich' };
const CYCLE_UNIT   = { monthly: 'Monat', quarterly: 'Quartal', semiannual: 'Halbjahr', yearly: 'Jahr' };

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Datum um n Monate verschieben; Tag wird auf Monatsende begrenzt (31. → 28./30.)
function addMonthsISO(iso, n, day) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1);
  const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day || d, dim));
  return isoDate(t);
}
// Anzahl Kalendermonate von heute bis zum Datum (gleicher Monat = 0, überfällig < 0)
function monthsUntil(iso) {
  const now = new Date(), d = parseISO(iso);
  return (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
}
// Datum im Schweizer Format TT.MM.JJJJ (akzeptiert ISO-String, Date oder Zeitstempel)
function fmtDate(x) {
  const d = typeof x === 'string' ? parseISO(x.slice(0, 10)) : new Date(x);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function daysUntil(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((parseISO(iso) - today) / 864e5);
}

// Alte Ausgaben ohne Rhythmus gelten als monatlich. Jährliche Ausgaben mit Tag+Monat
// erhalten ein konkretes Fälligkeitsdatum. Beträge und Rückstellung bleiben unverändert
// (Rückstellung ist für bestehende Einträge aus, bis man sie aktiviert).
function migrateExpense(e) {
  const out = { ...e };
  if (!CYCLE_MONTHS[out.frequency]) out.frequency = 'monthly';
  if (out.frequency === 'yearly' && !out.nextDue && out.dueDay && out.dueMonth) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const at = y => new Date(y, out.dueMonth - 1, Math.min(out.dueDay, new Date(y, out.dueMonth, 0).getDate()));
    let d = at(today.getFullYear());
    if (d < today) d = at(today.getFullYear() + 1);
    out.nextDue = isoDate(d);
  }
  if (typeof out.reserve !== 'boolean') out.reserve = false;
  if (typeof out.reserveSaved !== 'number') out.reserveSaved = 0;
  return out;
}

// Schrittweise Migrationen: Schlüssel = Zielversion. Laufen der Reihe nach ab der gespeicherten Version.
const MIGRATIONS = {
  // v2: neue Kontotypen (liquid | savings | credit | bound)
  2: st => {
    const map = { checking: 'liquid', savings: 'savings', depot: 'bound', other: 'bound' };
    st.accounts = (st.accounts || []).map(a => ({ ...a, type: map[a.type] || (ACCOUNT_TYPES[a.type] ? a.type : 'liquid') }));
    st.cardPayments = st.cardPayments || [];
  },
  // v3: Verträge (Kündigungsfristen); Belegfotos liegen in IndexedDB, Buchungen erhalten optional
  //     warrantyUntil + receiptIds
  3: st => { st.contracts = st.contracts || []; },
  // v4: Wunschliste, Projekt-Budgets pro Tag; Buchungen/Ausgaben erhalten optional tags[]
  4: st => { st.wishlist = st.wishlist || []; st.tagBudgets = st.tagBudgets || {}; },
  // v5: Spar-Serien (Auswertung pro abgeschlossenem Budgetmonat) und Meilensteine
  5: st => { st.milestones = st.milestones || []; st.streak = st.streak || { history: {}, startKey: null }; }
};

function migrateState(raw) {
  if (!raw) return { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), schemaVersion: SCHEMA_VERSION };
  if (typeof raw.balance === 'number' && !raw.accounts) {
    raw.accounts = raw.balance > 0
      ? [{ id: uid(), name: 'Girokonto', balance: raw.balance, type: 'checking' }]
      : [];
    delete raw.balance;
  }
  const st = {
    ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
    ...raw,
    settings: { ...JSON.parse(JSON.stringify(DEFAULT_STATE.settings)), ...(raw.settings || {}) }
  };
  st.settings.payroll = { ...DEFAULT_STATE.settings.payroll, ...(raw.settings?.payroll || {}) };
  st.expenses = (st.expenses || []).map(migrateExpense);
  for (let v = (raw.schemaVersion || 1) + 1; v <= SCHEMA_VERSION; v++) MIGRATIONS[v]?.(st);
  st.schemaVersion = SCHEMA_VERSION;
  return st;
}

const uid = () => Math.random().toString(36).slice(2, 9);

let state = (() => {
  let raw = null;
  try { raw = localStorage.getItem('finanzplaner'); } catch {}
  try { return migrateState(JSON.parse(raw)); }
  catch (err) {
    // Nie stillschweigend Daten verlieren: Rohdaten sichern, bevor leer gestartet wird
    console.error('Laden fehlgeschlagen', err);
    try { if (raw) localStorage.setItem('finanzplaner-rescue-' + Date.now(), raw); } catch {}
    return migrateState(null);
  }
})();

let projectionChart = null;
let donutChartInst  = null;
let nwHistChartInst = null;
let editContext     = null;
let chartMode       = 'nominal';
let projectionYears = 10;

function saveState() {
  try { localStorage.setItem('finanzplaner', JSON.stringify(state)); }
  catch { toast('⚠️ Speichern fehlgeschlagen (Speicher voll oder privater Modus)'); }
}

// Benutzereingaben sicher in HTML einsetzen (verhindert kaputtes Layout / XSS)
const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);

// ── Formatierung ───────────────────────────────────────────────────────────
const NUM_FMT = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
function fmt(n) { return NUM_FMT.format(n) + ' ' + state.currency; }
// Buchungen: Rappen/Cent anzeigen, falls vorhanden
const NUM_FMT2 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtExact(n) { return (Number.isInteger(n) ? NUM_FMT.format(n) : NUM_FMT2.format(n)) + ' ' + state.currency; }
// Immer mit Rappen (Tabellen, Abrechnungen): 1'234.50 CHF
function fmt2(n) { return NUM_FMT2.format(n) + ' ' + state.currency; }
function fmtK(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M ' + state.currency;
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(0) + 'k ' + state.currency;
  return fmt(n);
}

// ── Berechnungen ───────────────────────────────────────────────────────────
const totalAccounts    = () => state.accounts.reduce((s, a) => s + a.balance, 0);
const totalIncome      = () => state.income.reduce((s, i) => s + i.amount, 0);
const cycleOf          = e => CYCLE_MONTHS[e.frequency] || 1;
const isIrregular      = e => cycleOf(e) > 1;
// Monatsdurchschnitt – Basis für 50/30/20, Sparquote, FIRE und Sparziele
const monthlyAmt       = e => e.amount / cycleOf(e);
const totalExpenses    = () => state.expenses.reduce((s, e) => s + monthlyAmt(e), 0);
const totalInvestments = () => state.investments.reduce((s, i) => s + i.amount, 0);
const totalDebtPay     = () => state.debts.reduce((s, d) => s + d.monthlyPayment, 0);
const totalDebt        = () => state.debts.reduce((s, d) => s + d.remainingAmount, 0);
const totalAssets      = () => totalAccounts() + state.portfolioValue;
const netWorth         = () => totalAssets() - totalDebt();
const monthlySavings   = () => totalIncome() - totalExpenses() - totalInvestments() - totalDebtPay();

// ── Rückstellungen ("Sparkässeli" pro Ausgabe) ────────────────────────────
const hasReserve = e => e.reserve && isIrregular(e) && !!e.nextDue;
const reserveExpenses = () => state.expenses.filter(hasReserve);

// Soll-Stand, Monatsrate (inkl. Nachholbedarf) und Status eines Topfs
function reserveInfo(e) {
  const cycle  = cycleOf(e);
  const normal = e.amount / cycle;
  const saved  = e.reserveSaved || 0;
  const need   = Math.max(0, e.amount - saved);
  const until  = monthsUntil(e.nextDue);            // 0 = diesen Monat fällig
  const monthsLeft = Math.max(1, until);            // noch mögliche Einzahlungen
  // Soll heute: so viel, wie bei gleichmässigem Sparen seit der letzten Fälligkeit im Topf sein müsste
  const soll = Math.max(0, Math.min(e.amount, e.amount * (1 - Math.min(cycle, monthsLeft) / cycle)));
  const behind = saved < soll - 0.005;
  // Normalfall: Betrag/Zyklus · Nachholfall: Restbetrag verteilt auf die verbleibenden Monate
  const computed = need <= 0 ? 0 : behind ? need / monthsLeft : Math.min(normal, need);
  // Wurde die Einzahlung diesen Monat schon verbucht, bleibt die Monatsrate bis Monatsende fix
  const booked = e.reserveBookedMonth === monthKey();
  const rate = booked ? (e.reserveBookedAmount || 0) : computed;
  const ratio = soll > 0 ? saved / soll : 1;
  const status = ratio >= 0.95 ? 'green' : ratio >= 0.7 ? 'yellow' : 'red';
  const days = daysUntil(e.nextDue);
  // Warnung, wenn der Topf mit den regulären Einzahlungen bis zur Fälligkeit nicht voll wird
  // (vorsichtig gerechnet: die Einzahlung im Fälligkeitsmonat kommt evtl. zu spät)
  const depositsLeft = days < 0 ? 0 : (booked ? 0 : 1) + Math.max(0, until - 1);
  const projected = saved + Math.min(normal, need) * depositsLeft;   // mit der regulären Rate
  const shortfall = days <= 30 ? Math.max(0, e.amount - projected) : 0;
  return { cycle, normal, saved, need, until, monthsLeft, soll, rate, behind, status, days, booked,
           catchUp: behind && computed > normal + 0.005, shortfall: shortfall > 0.005 ? shortfall : 0 };
}

const totalReserveRate = () => reserveExpenses().reduce((s, e) => s + reserveInfo(e).rate, 0);
const totalReserved    = () => reserveExpenses().reduce((s, e) => s + (e.reserveSaved || 0), 0);
// Tatsächlicher Monatsbedarf: Töpfe mit ihrer (ggf. erhöhten) Rate, der Rest als Durchschnitt
const cashflowExpenses = () => state.expenses.reduce((s, e) => s + (hasReserve(e) ? reserveInfo(e).rate : monthlyAmt(e)), 0);
const cashflowFree     = () => totalIncome() - cashflowExpenses() - totalInvestments() - totalDebtPay();
const weightedReturn   = () => {
  const total = totalInvestments();
  if (!total) return 6;
  return state.investments.reduce((s, i) => s + i.amount * (i.returnRate || 6), 0) / total;
};

function emergencyMonths() {
  const costs = totalExpenses() + totalDebtPay();
  return costs > 0 ? totalAccounts() / costs : 0;
}
function emergencyStatus() {
  const m = emergencyMonths();
  if (m < 1) return { cls: 'badge-red',    icon: '🔴', label: `${m.toFixed(1)} Monate – Kritisch` };
  if (m < 3) return { cls: 'badge-orange', icon: '🟠', label: `${m.toFixed(1)} Monate – Zu wenig` };
  if (m < 6) return { cls: 'badge-yellow', icon: '🟡', label: `${m.toFixed(1)} Monate – Gut` };
  return         { cls: 'badge-green',  icon: '🟢', label: `${m.toFixed(1)} Monate – Sehr gut` };
}

const fireExpenses = () => state.settings.fireMonthlyExpenses || totalExpenses();
const fireNumber   = () => fireExpenses() * 12 / ((state.settings.fireWithdrawalRate || 4) / 100);
const fireProgress = () => { const fn = fireNumber(); return fn > 0 ? Math.min(100, state.portfolioValue / fn * 100) : 0; };

function fireETA() {
  const target = fireNumber();
  if (target <= 0 || totalInvestments() <= 0) return null;
  const r = weightedReturn() / 100 / 12;
  const pmt = totalInvestments();
  let p = state.portfolioValue;
  for (let m = 1; m <= 720; m++) { p = p * (1 + r) + pmt; if (p >= target) return m; }
  return null;
}

function debtPayoffMonths(d) {
  if (d.monthlyPayment <= 0) return null;
  const r = d.interestRate / 100 / 12;
  if (r === 0) return Math.ceil(d.remainingAmount / d.monthlyPayment);
  let rem = d.remainingAmount;
  for (let m = 1; m <= 720; m++) { rem = rem * (1 + r) - d.monthlyPayment; if (rem <= 0) return m; }
  return null;
}

function formatETA(months) {
  if (!months) return 'Rate zu gering';
  if (months <= 12) return months + ' Monat' + (months === 1 ? '' : 'e');
  const y = Math.floor(months / 12), m = months % 12;
  return y + 'J' + (m ? ' ' + m + 'Mt.' : '');
}

// ── 50/30/20 ───────────────────────────────────────────────────────────────
const NEEDS_CATS = ['Wohnen','Lebensmittel','Transport','Gesundheit','Versicherungen'];
const WANTS_CATS = ['Unterhaltung','Kleidung','Bildung','Haustiere','Freizeit','Ausgabe'];

function calc503020() {
  const income = totalIncome();
  if (income <= 0) return null;
  const needs   = state.expenses.filter(e => NEEDS_CATS.includes(e.category)).reduce((s, e) => s + monthlyAmt(e), 0);
  const wants   = state.expenses.filter(e => WANTS_CATS.includes(e.category)).reduce((s, e) => s + monthlyAmt(e), 0);
  const savings = totalInvestments() + Math.max(0, monthlySavings());
  return {
    needs:   { amount: needs,   pct: needs / income * 100,   target: 50, dir: 'max' },
    wants:   { amount: wants,   pct: wants / income * 100,   target: 30, dir: 'max' },
    savings: { amount: savings, pct: savings / income * 100, target: 20, dir: 'min' }
  };
}

function render503020(containerId) {
  const data = calc503020();
  const el2 = document.getElementById(containerId);
  if (!el2) return;
  if (!data) { el2.innerHTML = '<div style="font-size:13px;color:var(--text2)">Erfasse Einkommen für die Auswertung.</div>'; return; }
  const items = [
    { label: 'Fixkosten · Ziel ≤50%', ...data.needs,   color: '#3b82f6' },
    { label: 'Variabel · Ziel ≤30%',  ...data.wants,   color: '#f59e0b' },
    { label: 'Sparen · Ziel ≥20%',    ...data.savings, color: '#10b981' }
  ];
  el2.innerHTML = items.map(item => {
    const ok = item.dir === 'min' ? item.pct >= item.target : item.pct <= item.target;
    return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
        <span style="color:var(--text2)">${item.label}</span>
        <span style="font-weight:700;color:${ok ? 'var(--green)' : 'var(--red)'}">
          ${item.pct.toFixed(0)}% ${ok ? '✓' : (item.dir === 'min' ? '↓' : '↑')}
        </span>
      </div>
      <div class="rate-bar" style="height:8px">
        <div style="height:100%;width:${Math.min(100, item.pct)}%;background:${ok ? item.color : 'var(--red)'};border-radius:99px;transition:width .4s"></div>
      </div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">${fmt(item.amount)} / Monat</div>
    </div>`;
  }).join('');
}

// ── Schweizer Steuer-Schätzung ─────────────────────────────────────────────
const CANTON_RATES = {
  'AG':25,'AI':18,'AR':20,'BE':29,'BL':26,'BS':30,'FR':27,'GE':32,
  'GL':22,'GR':21,'JU':28,'LU':22,'NE':28,'NW':18,'OW':19,'SG':23,
  'SH':22,'SO':25,'SZ':16,'TG':23,'TI':24,'UR':18,'VD':30,'VS':24,'ZG':15,'ZH':27
};

function estimateTax(grossAnnual, canton) {
  const rate = (CANTON_RATES[canton] || 27) / 100;
  const yearly = grossAnnual * rate;
  return { yearly, monthly: yearly / 12, rate: rate * 100, netto: grossAnnual - yearly, nettoMonthly: (grossAnnual - yearly) / 12 };
}

// ── Schulden-Simulation ────────────────────────────────────────────────────
function simulateDebtPayoff(sortedDebts, extraBudget) {
  const debts = sortedDebts.map(d => ({ ...d, remaining: d.remainingAmount }));
  let months = 0, totalInterest = 0;
  while (debts.some(d => d.remaining > 0) && months < 720) {
    months++;
    let extra = extraBudget;
    for (const d of debts) {
      if (d.remaining <= 0) continue;
      const interest = d.remaining * d.interestRate / 100 / 12;
      totalInterest += interest;
      d.remaining = d.remaining + interest - d.monthlyPayment;
      if (d.remaining < 0) { extra += Math.abs(d.remaining); d.remaining = 0; }
    }
    for (const d of debts) {
      if (d.remaining > 0) { d.remaining = Math.max(0, d.remaining - extra); break; }
    }
  }
  return { months, totalInterest };
}

// ── Lookup ─────────────────────────────────────────────────────────────────
const COLORS = {
  Lohn:'#6366f1', Nebeneinkommen:'#8b5cf6', Sonstiges:'#a78bfa',
  Wohnen:'#ef4444', Lebensmittel:'#f97316', Transport:'#f59e0b',
  Unterhaltung:'#84cc16', Gesundheit:'#06b6d4', Versicherungen:'#3b82f6',
  Kleidung:'#ec4899', Bildung:'#14b8a6', Haustiere:'#a16207',
  Freizeit:'#8b5cf6', Ausgabe:'#64748b',
  ETF:'#10b981', Aktien:'#06b6d4', Krypto:'#f59e0b',
  Obligationen:'#3b82f6', 'Säule3a':'#6366f1', Investition:'#8b5cf6',
  Kredit:'#dc2626', Hypothek:'#b91c1c', 'Auto-Leasing':'#ef4444',
  Studentenkredit:'#f97316', Kreditkarte:'#e11d48', Schulden:'#ef4444'
};
const ICONS = {
  Lohn:'💼', Nebeneinkommen:'💰', Sonstiges:'💵',
  Wohnen:'🏠', Lebensmittel:'🛒', Transport:'🚗',
  Unterhaltung:'🎬', Gesundheit:'💊', Versicherungen:'🛡️',
  Kleidung:'👕', Bildung:'📚', Haustiere:'🐾',
  Freizeit:'🎯', Ausgabe:'💸',
  ETF:'📈', Aktien:'📊', Krypto:'₿',
  Obligationen:'📄', 'Säule3a':'🏦', Investition:'💹',
  Kredit:'🏦', Hypothek:'🏠', 'Auto-Leasing':'🚗',
  Studentenkredit:'🎓', Kreditkarte:'💳', Schulden:'💸'
};
const colorFor = c => COLORS[c] || '#6366f1';
const iconFor  = c => ICONS[c]  || '💰';

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// ── Navigation ─────────────────────────────────────────────────────────────
const PAGES = ['uebersicht','einkommen','ausgaben','vermoegen','ziele'];
const RENDERERS = {};
// Erweiterungen (liquidity.js, contracts.js, …) hängen sich hier ein
const PAGE_HOOKS = { uebersicht: [], einkommen: [], ausgaben: [], vermoegen: [], ziele: [], txMonthChanged: [], boot: [] };
const SETTINGS_SECTIONS = [];   // { title, html(), save() } – erscheinen unter ⚙️
// Zusatzfelder in Formularen: { html(prefill), mounted?(prefill), read(data, prefill) → false = abbrechen, after?(item) }
const TX_MODAL_EXTRAS = [];
const EXPENSE_MODAL_EXTRAS = [];
const DELETE_HOOKS = [];        // (type, item) nach dem Löschen
const EXPORT_HOOKS = [];        // async (payload) – Zusatzdaten ins Backup schreiben
const IMPORT_HOOKS = [];        // async (parsed) – Zusatzdaten aus dem Backup übernehmen
const DASH_ALERTS = [];         // () → HTML-Schnipsel für Hinweise in der Übersicht
function renderPage(id) {
  RENDERERS[id]?.();
  PAGE_HOOKS[id]?.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
}

let currentPage = null;

function navigate(id, { push = true } = {}) {
  if (!PAGES.includes(id)) id = 'uebersicht';
  const changed = id !== currentPage;
  currentPage = id;
  PAGES.forEach(p => {
    document.getElementById('page-' + p).classList.toggle('active', p === id);
    document.getElementById('nav-'  + p).classList.toggle('active', p === id);
  });
  // Browser-Verlauf: Zurück-Taste (Android) wechselt Seiten statt die App zu schliessen
  if (push && changed && location.hash !== '#' + id) history.pushState({ page: id }, '', '#' + id);
  if (changed) {
    window.scrollTo(0, 0);
    document.getElementById('page-' + id).scrollTop = 0;
  }
  renderPage(id);
}

// Nur die sichtbare Seite neu zeichnen – versteckte Seiten werden beim Öffnen gerendert
function refreshCurrent() {
  if (currentPage) renderPage(currentPage);
}

const pageFromHash = () => (location.hash || '').slice(1);

const el = id => document.getElementById(id);

// ── Dashboard ──────────────────────────────────────────────────────────────
RENDERERS.uebersicht = function() {
  const income  = totalIncome();
  const exp     = totalExpenses();
  const invest  = totalInvestments();
  const debtP   = totalDebtPay();
  const savings = monthlySavings();
  const nw      = netWorth();
  const rate    = income > 0 ? Math.max(0, Math.min(100, (savings + invest) / income * 100)) : 0;

  el('dash-networth').textContent = fmt(nw);
  const reserved = totalReserved();
  el('dash-nw-breakdown').textContent = `Vermögen: ${fmtK(totalAssets())} · Schulden: ${fmtK(totalDebt())}`
    + (reserved > 0 ? ` · davon reserviert: ${fmtK(reserved)}` : '');
  // Ausgaben/Frei pro Monat mit tatsächlicher Rückstellungsrate (inkl. Nachholbedarf)
  const cashExp = cashflowExpenses(), reserveRate = totalReserveRate(), free = cashflowFree();
  el('dash-income').textContent       = fmt(income);
  el('dash-expenses').textContent     = fmt(cashExp + debtP);
  el('dash-expenses-sub').textContent = reserveRate > 0 ? `davon Rückstellungen: ${fmt(reserveRate)}` : '';
  el('dash-investments').textContent  = fmt(invest);
  el('dash-savings').textContent      = fmt(free);
  el('dash-savings').className = 'val ' + (free >= 0 ? 'green' : 'red');

  renderDashMonth();
  renderBackupHint();
  const alerts = DASH_ALERTS.map(fn => { try { return fn(); } catch (err) { console.error(err); return ''; } }).join('');
  el('dash-alerts').innerHTML = alerts;

  // Notfallfonds
  const em = emergencyStatus();
  const emPct = Math.min(100, emergencyMonths() / 6 * 100);
  const emColor = em.cls.includes('green') ? 'var(--green)' : em.cls.includes('yellow') ? 'var(--yellow)' : em.cls.includes('orange') ? '#f97316' : 'var(--red)';
  el('dash-emergency').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="status-badge ${em.cls}">${em.icon} ${em.label}</span>
      <span style="font-size:12px;color:var(--text2)">Ziel: 3–6 Monate</span>
    </div>
    <div class="rate-bar" style="margin-top:8px">
      <div style="height:100%;width:${emPct}%;background:${emColor};border-radius:99px;transition:width .4s"></div>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:5px">6-Monats-Ziel: ${fmt(totalExpenses() * 6)}</div>`;

  // 50/30/20
  render503020('dash-budget-rule');

  // Donut
  renderDonutChart();

  // FIRE
  const fn = fireNumber(), fp = fireProgress(), feta = fireETA();
  el('dash-fire').innerHTML = fn > 0 && income > 0 ? `
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
      <span style="color:var(--text2)">${fmtK(state.portfolioValue)} / ${fmtK(fn)}</span>
      <span style="font-weight:700;color:var(--primary-light)">${fp.toFixed(1)}%</span>
    </div>
    <div class="rate-bar" style="height:8px">
      <div style="height:100%;width:${fp}%;background:linear-gradient(90deg,var(--primary),var(--primary-light));border-radius:99px;transition:width .5s"></div>
    </div>
    ${feta ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">🎯 Finanzielle Freiheit in ca. <strong style="color:var(--text)">${formatETA(feta)}</strong></div>`
           : `<div style="font-size:12px;color:var(--text2);margin-top:6px">Trage deinen Depotwert ein für die Prognose</div>`}`
    : `<div style="font-size:13px;color:var(--text2)">Erfasse Einkommen und Investitionen für den FIRE-Fortschritt</div>`;

  // Sparquote
  el('dash-rate-pct').textContent  = rate.toFixed(0) + '%';
  el('dash-rate-fill').style.width = rate + '%';

  // Nettovermögen-Verlauf
  renderNetworthHistoryChart();

  // Prognose
  renderProjectionChart();
};

// ── Donut Chart ────────────────────────────────────────────────────────────
function renderDonutChart() {
  const canvas = el('donut-chart');
  const legend = el('dash-donut-legend');
  if (!canvas || !legend || !window.Chart) return;

  const catMap = {};
  state.expenses.forEach(e => { catMap[e.category] = (catMap[e.category] || 0) + monthlyAmt(e); });
  const entries = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    legend.innerHTML = '<span style="color:var(--text2)">Noch keine Ausgaben erfasst</span>';
    if (donutChartInst) { donutChartInst.destroy(); donutChartInst = null; }
    return;
  }

  const labels = entries.map(([k]) => k);
  const data   = entries.map(([, v]) => v);
  const colors = labels.map(l => colorFor(l));
  const total  = data.reduce((a, b) => a + b, 0);

  if (donutChartInst) donutChartInst.destroy();
  donutChartInst = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
    options: {
      responsive: false, cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)} (${(ctx.raw/total*100).toFixed(0)}%)` } }
      }
    }
  });

  legend.innerHTML = entries.slice(0, 6).map(([k, v]) => `
    <div style="display:flex;align-items:center;gap:5px">
      <div style="width:8px;height:8px;border-radius:50%;background:${colorFor(k)};flex-shrink:0"></div>
      <span style="color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${k}</span>
      <span style="font-weight:600;white-space:nowrap">${(v/total*100).toFixed(0)}%</span>
    </div>`).join('');
}

// ── Nettovermögen-Verlauf ──────────────────────────────────────────────────
function saveNetworthSnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  const nw = netWorth();
  const idx = state.networthHistory.findIndex(h => h.date === today);
  if (idx >= 0) state.networthHistory[idx].networth = nw;
  else state.networthHistory.push({ date: today, networth: nw });
  state.networthHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveState();
  renderNetworthHistoryChart();
  toast('Snapshot gespeichert ✓');
}

function renderNetworthHistoryChart() {
  const container = el('dash-nw-history');
  if (!container) return;
  const history = state.networthHistory;
  if (!history?.length) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text2)">Klicke "+ Snapshot" um den heutigen Stand zu speichern.</div>';
    return;
  }

  container.innerHTML = `
    <div class="chart-wrap" style="height:150px"><canvas id="nw-hist-canvas"></canvas></div>
    <div style="font-size:11px;color:var(--text2);margin-top:6px;text-align:right">${history.length} Snapshots · Letzter: ${fmt(history[history.length-1].networth)}</div>`;

  setTimeout(() => {
    const canvas = el('nw-hist-canvas');
    if (!canvas || !window.Chart) return;
    if (nwHistChartInst) nwHistChartInst.destroy();
    nwHistChartInst = new Chart(canvas, {
      type: 'line',
      data: {
        labels: history.map(h => new Date(h.date).toLocaleDateString('de-CH', { month: 'short', year: '2-digit' })),
        datasets: [{ label: 'Nettovermögen', data: history.map(h => h.networth),
          borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.12)',
          fill: true, tension: .4, pointRadius: 3, borderWidth: 2, pointBackgroundColor: '#6366f1' }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
            callbacks: { label: ctx => ' ' + fmt(ctx.parsed.y) } } },
        scales: {
          x: { ticks: { color: '#475569', font: { size: 10 } }, grid: { color: '#1e293b' } },
          y: { ticks: { color: '#475569', font: { size: 10 }, callback: v => fmtK(v) }, grid: { color: '#273549' } }
        }
      }
    });
  }, 0);
}

function renderProjectionChart() {
  const canvas = el('projection-chart');
  if (!canvas || !window.Chart) return;
  const months = projectionYears * 12, labels = [], balData = [], invData = [], totalData = [];
  let bal = totalAccounts(), inv = state.portfolioValue;
  const sav = Math.max(0, monthlySavings()), pmt = totalInvestments();
  const r = weightedReturn() / 100 / 12, inf = (state.settings.inflationRate || 2) / 100 / 12;
  const now = new Date();
  const labelEvery = projectionYears <= 10 ? 6 : projectionYears <= 20 ? 12 : 24;
  for (let m = 0; m <= months; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    labels.push(m % labelEvery === 0 ? d.toLocaleDateString('de-CH', { month: 'short', year: '2-digit' }) : '');
    bal += sav; inv = inv * (1 + r) + pmt;
    const adj = chartMode === 'real' ? Math.pow(1 + inf, m) : 1;
    balData.push(Math.round(bal / adj)); invData.push(Math.round(inv / adj)); totalData.push(Math.round((bal + inv) / adj));
  }
  if (projectionChart) {
    // Bestehenden Chart aktualisieren statt neu aufzubauen (schneller, kein Flackern)
    projectionChart.data.labels = labels;
    [balData, invData, totalData].forEach((d, i) => { projectionChart.data.datasets[i].data = d; });
    projectionChart.update();
    return;
  }
  projectionChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Konto',  data: balData,   borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)',  fill: true, tension: .4, pointRadius: 0, borderWidth: 2 },
      { label: 'Depot',  data: invData,   borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.08)', fill: true, tension: .4, pointRadius: 0, borderWidth: 2 },
      { label: 'Gesamt', data: totalData, borderColor: '#f59e0b', backgroundColor: 'transparent', fill: false, tension: .4, pointRadius: 0, borderWidth: 2, borderDash: [4,3] }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          titleColor: '#f1f5f9', bodyColor: '#94a3b8',
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) } }
      },
      scales: {
        x: { ticks: { color: '#475569', font: { size: 10 }, maxRotation: 0 }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#475569', font: { size: 10 }, callback: v => fmtK(v) }, grid: { color: '#273549' } }
      }
    }
  });
}

function setChartMode(mode) {
  chartMode = mode;
  el('btn-nominal').classList.toggle('active', mode === 'nominal');
  el('btn-real').classList.toggle('active', mode === 'real');
  renderProjectionChart();
}

function setProjectionYears(years) {
  projectionYears = years;
  [5, 10, 20, 40].forEach(y => el('btn-proj-' + y)?.classList.toggle('active', y === years));
  renderProjectionChart();
}

// ── Einkommen ──────────────────────────────────────────────────────────────
RENDERERS.einkommen = function() {
  el('einkommen-total').textContent = fmt(totalIncome());
  renderTaxDisplay();
  const list = el('einkommen-list');
  list.innerHTML = state.income.length
    ? state.income.map(i => listItem({
        icon: iconFor(i.category), color: colorFor(i.category),
        name: esc(i.name), sub: i.category + (i.dueDay ? ` · am ${i.dueDay}.` : '') + (i.note ? ' · ' + esc(i.note) : ''),
        amount: fmt(i.amount), amountColor: 'var(--green)', id: i.id, type: 'income'
      })).join('')
    : emptyState('💼', 'Noch keine Einnahmen erfasst.');
};

function renderTaxDisplay() {
  const display = el('tax-estimate-display');
  if (!display) return;
  const t = state.settings.taxEstimate;
  if (!t) { display.innerHTML = '<div style="font-size:13px;color:var(--text2)">Tippe "Berechnen" für eine vereinfachte Steuerschätzung.</div>'; return; }
  display.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-item"><div class="kpi-label">Steuern/Monat</div><div class="kpi-value red">${fmt(t.monthly)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Netto/Monat</div><div class="kpi-value green">${fmt(t.nettoMonthly)}</div></div>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:8px">
      Eff. Steuersatz: ~${t.rate.toFixed(0)}% · Kanton ${state.settings.taxCanton}
      <button class="toggle-btn" style="margin-left:8px" onclick="openTaxCalculator()">Anpassen</button>
    </div>`;
}

// ── Ausgaben ───────────────────────────────────────────────────────────────
RENDERERS.ausgaben = function() {
  el('ausgaben-total').textContent = fmt(totalExpenses());
  const dp = totalDebtPay();
  const rr = totalReserveRate();
  el('ausgaben-debt-row').innerHTML = (dp > 0
    ? `<div class="info-row">🏦 Schuldentilgung <span>${fmt(dp)}/Mt.</span></div>` : '')
    + (reserveExpenses().length
    ? `<div class="info-row">🐷 Rückstellungen diesen Monat <span>${fmtExact(round2(rr))}</span></div>` : '');

  render503020('ausgaben-budget-rule');

  const income = totalIncome();
  const list = el('ausgaben-list');
  list.innerHTML = state.expenses.length
    ? state.expenses.map(e => {
        const m = monthlyAmt(e);
        const pct = income > 0 ? (m / income * 100).toFixed(0) : 0;
        const hasLim = e.budgetLimit > 0;
        const over = hasLim && m > e.budgetLimit;
        const bpct = hasLim ? Math.min(100, m / e.budgetLimit * 100) : 0;
        const bCls = over ? 'budget-over' : bpct > 80 ? 'budget-warn' : 'budget-ok';
        const irregular = isIrregular(e);
        const freqLabel = irregular ? `<span class="freq-badge">${CYCLE_LABEL[e.frequency]}${hasReserve(e) ? ' 🐷' : ''}</span>` : '';
        const dueInfo = irregular
          ? (e.nextDue ? ` · fällig ${fmtDate(e.nextDue)}` : ' · Fälligkeit fehlt')
          : (e.dueDay ? ` · am ${e.dueDay}.` : '');
        return `
        <div class="list-item${over ? ' item-over' : ''}">
          <div class="item-left">
            <div class="item-icon" style="background:${colorFor(e.category)}22">${iconFor(e.category)}</div>
            <div style="min-width:0">
              <div class="item-name">${esc(e.name)} ${freqLabel}</div>
              ${e.tags?.length && typeof tagChips === 'function' ? tagChips(e.tags) : ''}
              <div class="item-sub">${e.category}${dueInfo} · ${pct}% Einkomm.${hasLim ? ' · Limit ' + fmt(e.budgetLimit) : ''}</div>
              ${hasLim ? `<div class="budget-bar"><div class="budget-fill ${bCls}" style="width:${bpct}%"></div></div>` : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <div style="text-align:right">
              <div class="item-amount" style="color:var(--red)">${fmt(m)}</div>
              ${irregular ? `<div style="font-size:10px;color:var(--text2)">${fmt(e.amount)}/${CYCLE_UNIT[e.frequency]}</div>` : ''}
            </div>
            <div class="item-actions">
              <button class="btn btn-ghost btn-icon" onclick="openEdit('expense','${e.id}')">✏️</button>
              <button class="btn btn-danger btn-icon" onclick="deleteItem('expense','${e.id}')">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('')
    : emptyState('💸', 'Noch keine Ausgaben erfasst.');

  renderReserveSection();
  renderCashflowPreview();
  renderTransactions();
  renderReport();
};

// ── Buchungen pro Monat ────────────────────────────────────────────────────
const monthKey   = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = key => { const [y, m] = key.split('-'); return new Date(y, m - 1, 1).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' }); };
const localISO   = (d = new Date()) => `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

// ── Budgetmonat: Kalendermonat oder Lohnzyklus ─────────────────────────────
// Schlüssel bleibt 'YYYY-MM' = Monat, in dem die Periode beginnt.
// Lohnzyklus: vom Lohntag bis zum Tag vor dem nächsten Lohntag.
const usePayday = () => state.settings.monthMode === 'payday';

// Lohntag eines Monats (m 0-basiert); auf Wochenende → vorheriger Freitag (optional)
function paydayDate(y, m) {
  const day = Math.min(state.settings.payday || 25, new Date(y, m + 1, 0).getDate());
  const d = new Date(y, m, day);
  if (state.settings.paydayWeekendShift !== false) {
    if (d.getDay() === 6) d.setDate(d.getDate() - 1);
    else if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  }
  return d;
}
function shiftKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}
function periodStart(key) {
  const [y, m] = key.split('-').map(Number);
  return usePayday() ? paydayDate(y, m - 1) : new Date(y, m - 1, 1);
}
function periodRange(key) {
  const end = periodStart(shiftKey(key, 1));
  end.setDate(end.getDate() - 1);
  return { start: isoDate(periodStart(key)), end: isoDate(end) };
}
function periodKeyOf(date = new Date()) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const k = monthKey(d);
  if (!usePayday()) return k;
  return d >= periodStart(k) ? k : shiftKey(k, -1);
}
function periodLabel(key, short = false) {
  if (!usePayday()) {
    const [y, m] = key.split('-');
    return new Date(y, m - 1, 1).toLocaleDateString('de-CH', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
  }
  const { start, end } = periodRange(key);
  const dm = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
  return short ? dm(start) : `${dm(start)} – ${dm(end)}${end.slice(0, 4)}`;
}

let txMonth = periodKeyOf();

const txOfMonth = key => {
  const { start, end } = periodRange(key);
  return (state.transactions || []).filter(t => t.date && t.date >= start && t.date <= end);
};

function monthTotals(key) {
  const txs = txOfMonth(key);
  const income  = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  // Aus Rückstellung bezahlt bzw. geplante Fixkosten-Zahlung (über "Bezahlt" erfasst)
  const reserveExpense = txs.filter(t => t.fromReserve && t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  const plannedExpense = txs.filter(t => t.expenseId && t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  return { txs, income, expense, saldo: income - expense, reserveExpense, plannedExpense };
}

// Budget-Limit pro Kategorie = Summe der Limits aller regelmässigen Ausgaben dieser Kategorie
function categoryLimits() {
  const lim = {};
  for (const e of state.expenses) if (e.budgetLimit > 0) lim[e.category] = (lim[e.category] || 0) + e.budgetLimit;
  return lim;
}

function readDueDay(id) {
  const d = parseInt(el(id)?.value);
  return d >= 1 && d <= 31 ? d : null;
}

// Nächste Fälligkeiten: monatliche Posten per Fälligkeitstag (14 Tage),
// Quartals-/Halbjahres-/Jahreszahlungen per Datum (30 Tage Vorlauf, inkl. überfällige)
function upcomingPayments(days = 14, irregularDays = 30) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(today); end.setDate(end.getDate() + days);
  const at = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  const out = [];
  const addMonthly = (item, type) => {
    if (!item.dueDay) return;
    const y = today.getFullYear(), m = today.getMonth();
    const date = [at(y, m, item.dueDay), at(y, m + 1, item.dueDay)].find(d => d >= today);
    if (date && date <= end) out.push({ name: item.name, amount: item.amount, category: item.category, type, date,
      days: Math.round((date - today) / 864e5) });
  };
  state.income.forEach(i => addMonthly(i, 'income'));
  state.expenses.forEach(e => {
    if (!isIrregular(e)) { addMonthly(e, 'expense'); return; }
    if (!e.nextDue) return;
    const d = daysUntil(e.nextDue);
    if (d > irregularDays) return;
    out.push({ name: e.name, amount: e.amount, category: e.category, type: 'expense', date: parseISO(e.nextDue),
      days: d, expenseId: e.id, irregular: true, shortfall: hasReserve(e) ? reserveInfo(e).shortfall : 0, reserve: hasReserve(e) });
  });
  if (typeof cardUpcoming === 'function') out.push(...cardUpcoming(irregularDays));
  return out.sort((a, b) => a.date - b.date);
}

function renderDashMonth() {
  const key = periodKeyOf();
  const { income, expense, saldo, txs, plannedExpense } = monthTotals(key);
  el('dash-month-title').textContent = periodLabel(key);
  const { start, end } = periodRange(key);
  const periodDays = (parseISO(end) - parseISO(start)) / 864e5 + 1;
  const elapsed = Math.min(100, (-daysUntil(start) + 1) / periodDays * 100);
  // Frei verfügbar = Überschuss nach Fixkosten, Rückstellungen, Investitionen und Raten + Saldo der Buchungen.
  // Über "Bezahlt" erfasste Fixkosten/Jahreszahlungen sind schon eingeplant → nicht doppelt abziehen.
  const plannedFree = cashflowFree();
  const free = plannedFree + saldo + plannedExpense;
  const base = Math.max(1, plannedFree + income);
  const usedPct = Math.max(0, Math.min(100, (expense - plannedExpense) / base * 100));
  el('dash-month').innerHTML = `
    <div class="kpi-grid kpi-grid-3">
      <div class="kpi-item"><div class="kpi-label">Einnahmen</div><div class="kpi-value green">${fmtK(income)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Ausgaben</div><div class="kpi-value red">${fmtK(expense)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Noch frei</div><div class="kpi-value ${free >= 0 ? 'green' : 'red'}">${fmtK(free)}</div></div>
    </div>
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:4px">
        <span>Freies Budget verbraucht: ${usedPct.toFixed(0)}%</span><span>Monat: ${elapsed.toFixed(0)}%</span>
      </div>
      <div class="rate-bar" style="position:relative">
        <div style="height:100%;width:${usedPct}%;background:${usedPct > elapsed + 10 ? 'var(--orange)' : 'var(--green)'};border-radius:99px"></div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:6px">${txs.length ? `${txs.length} Buchung${txs.length === 1 ? '' : 'en'} diesen Monat` : 'Erfasse Einkäufe & Extras als Buchung, um deinen Monat zu verfolgen.'}${plannedExpense > 0 ? ` · ${fmt(plannedExpense)} geplante Zahlungen (aus Rückstellung/Fixkosten) nicht doppelt gezählt` : ''}</div>`;

  el('dash-upcoming').innerHTML = renderUpcomingList(upcomingPayments(), 8);
}

function renderUpcomingList(up, max) {
  if (!up.length) return '<div style="font-size:13px;color:var(--text2)">Keine Zahlungen in den nächsten Tagen. Tipp: Trage bei Einkommen und Ausgaben einen Fälligkeitstag bzw. die nächste Fälligkeit ein.</div>';
  return `<div class="item-list">${up.slice(0, max).map(p => `
    <div class="upcoming-row${p.irregular ? ' upcoming-irregular' : ''}">
      <span class="upcoming-when" ${p.days < 0 ? 'style="color:var(--red)"' : ''}>${p.days < 0 ? 'Überfällig' : p.days === 0 ? 'Heute' : p.days === 1 ? 'Morgen' : 'in ' + p.days + ' T.'}</span>
      <span class="upcoming-name">${iconFor(p.category)} ${esc(p.name)}${p.reserve ? ' 🐷' : ''}
        ${p.shortfall > 0 ? `<br><span class="upcoming-warn">⚠️ Es fehlen ${fmtExact(round2(p.shortfall))}</span>` : ''}</span>
      <span style="font-weight:600;color:${p.type === 'income' ? 'var(--green)' : 'var(--red)'}">${p.type === 'income' ? '+' : '−'}${fmt(p.amount)}</span>
      ${p.irregular ? `<button class="toggle-btn" onclick="openPaidModal('${p.expenseId}')">Bezahlt</button>` : ''}
      ${p.cardId && p.payable ? `<button class="toggle-btn" onclick="openCardPayModal('${p.cardId}','${p.statement}')">Bezahlt</button>` : ''}
    </div>`).join('')}</div>`;
}

// Einmal pro Monat automatisch den Stand des Nettovermögens festhalten
function autoNetworthSnapshot() {
  const key = monthKey();
  const hasData = state.accounts.length || state.portfolioValue || state.debts.length;
  if (!hasData || state.networthHistory.some(h => h.date.startsWith(key))) return;
  state.networthHistory.push({ date: localISO(), networth: netWorth() });
  state.networthHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveState();
}

function shiftTxMonth(delta) {
  const [y, m] = txMonth.split('-').map(Number);
  txMonth = monthKey(new Date(y, m - 1 + delta, 1));
  renderTransactions();
  PAGE_HOOKS.txMonthChanged.forEach(fn => fn());
}

// Buchung wirkt sich auf verknüpftes Konto aus (sign = +1 anwenden, -1 rückgängig machen)
function applyTxToAccount(tx, sign) {
  if (!tx?.accountId || tx.noBalance) return;
  const acc = state.accounts.find(a => a.id === tx.accountId);
  if (acc) acc.balance += sign * (tx.type === 'income' ? tx.amount : -tx.amount);
}

function renderTransactions() {
  const list = el('transactions-list');
  if (!list) return;
  el('tx-month-label').textContent = periodLabel(txMonth);

  const { txs, income, expense, saldo } = monthTotals(txMonth);
  el('tx-month-summary').innerHTML = `
    <div class="kpi-grid kpi-grid-3" style="margin-bottom:10px">
      <div class="kpi-item"><div class="kpi-label">Einnahmen</div><div class="kpi-value green">${fmtK(income)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Ausgaben</div><div class="kpi-value red">${fmtK(expense)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Saldo</div><div class="kpi-value ${saldo >= 0 ? 'green' : 'red'}">${saldo >= 0 ? '+' : ''}${fmtK(saldo)}</div></div>
    </div>`;

  // Ausgaben nach Kategorie, verglichen mit dem Budget-Limit
  const byCat = {};
  txs.filter(t => t.type !== 'income').forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
  const limits = categoryLimits();
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxAmt = cats.length ? cats[0][1] : 0;
  el('tx-category-breakdown').innerHTML = cats.length ? `
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Ausgaben nach Kategorie</div>
      ${cats.map(([cat, amt]) => {
        const lim = limits[cat];
        const pct = lim ? Math.min(100, amt / lim * 100) : amt / maxAmt * 100;
        const cls = !lim ? '' : amt > lim ? 'budget-over' : amt > lim * .8 ? 'budget-warn' : 'budget-ok';
        return `
        <div style="margin-bottom:9px">
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span>${iconFor(cat)} ${esc(cat)}</span>
            <span style="font-weight:600;${lim && amt > lim ? 'color:var(--red)' : ''}">${fmt(amt)}${lim ? ` <span style="color:var(--text2);font-weight:400">/ ${fmt(lim)}</span>` : ''}</span>
          </div>
          <div class="budget-bar" style="height:5px"><div class="budget-fill ${cls}" style="width:${pct}%;${cls ? '' : 'background:' + colorFor(cat)}"></div></div>
        </div>`;
      }).join('')}
      ${Object.keys(limits).length ? '' : '<div style="font-size:11px;color:var(--text2)">Tipp: Setze bei einer Ausgabe ein Budget-Limit, um es hier zu vergleichen.</div>'}
    </div>` : '';

  // Suche durchsucht alle Monate, sonst nur den gewählten Monat
  const query = (el('tx-search')?.value || '').trim().toLowerCase();
  const typeFilter = el('tx-type-filter')?.value || 'all';
  let shown = query
    ? (state.transactions || []).filter(t => query.startsWith('#')
        ? (t.tags || []).some(tag => tag.toLowerCase() === query.slice(1))
        : `${t.name} ${t.category} ${t.note || ''} ${(t.tags || []).map(x => '#' + x).join(' ')}`.toLowerCase().includes(query))
    : txs;
  if (typeFilter !== 'all') shown = shown.filter(t => (t.type === 'income') === (typeFilter === 'income'));

  if (!shown.length) {
    list.innerHTML = emptyState('📒', query ? `Keine Treffer für „${esc(query)}“.` : `Keine Buchungen im Zeitraum ${periodLabel(txMonth)}.`);
    return;
  }
  const accName = id => state.accounts.find(a => a.id === id)?.name;
  const sorted = [...shown].sort((a, b) => b.date.localeCompare(a.date));
  const LIMIT = 200; // grosse Listen begrenzen, damit es auf dem Handy flüssig bleibt
  const hitsInfo = query
    ? `<div style="font-size:12px;color:var(--text2);margin-bottom:2px">${sorted.length} Treffer · Summe ${fmtExact(sorted.reduce((s, t) => s + (t.type === 'income' ? t.amount : -t.amount), 0))}</div>`
    : '';
  list.innerHTML = hitsInfo + sorted.slice(0, LIMIT).map(t => {
    const acc = accName(t.accountId);
    return `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:${colorFor(t.category)}22">${iconFor(t.category)}</div>
        <div>
          <div class="item-name">${esc(t.name)}${t.fromReserve ? ' <span class="freq-badge">🐷 aus Rückstellung</span>' : ''}${t.receiptIds?.length ? ` <span class="receipt-link" onclick="showReceipts('${t.id}')">🧾</span>` : ''}</div>
          <div class="item-sub">${esc(t.category || '–')} · ${fmtDate(t.date)}${acc ? ' · ' + esc(acc) : ''}</div>
          ${t.tags?.length && typeof tagChips === 'function' ? tagChips(t.tags) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="item-amount" style="color:${t.type === 'income' ? 'var(--green)' : 'var(--red)'}">
          ${t.type === 'income' ? '+' : '−'}${fmtExact(t.amount)}
        </span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('transaction','${t.id}')" aria-label="Bearbeiten">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('transaction','${t.id}')" aria-label="Löschen">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('') + (sorted.length > LIMIT ? `<div style="font-size:12px;color:var(--text2);text-align:center">… ${sorted.length - LIMIT} weitere – Suche verfeinern</div>` : '');
}

// ── Rückstellungs-Töpfe ────────────────────────────────────────────────────
const STATUS_LABEL = { green: 'Auf Kurs', yellow: 'Leicht hinten', red: 'Reicht nicht' };
const STATUS_COLOR = { green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)' };

function renderReserveSection() {
  const box = el('reserve-section');
  if (!box) return;
  const pots = reserveExpenses().sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const candidates = state.expenses.filter(e => isIrregular(e) && !hasReserve(e));
  if (!pots.length && !candidates.length) { box.innerHTML = ''; return; }
  const doneThisMonth = state.settings.reserveDepositMonth === monthKey();
  box.innerHTML = `
    <div class="section-divider" style="margin-top:20px">
      <div class="sdiv-title">🐷 Rückstellungen</div>
      <div class="sdiv-line"></div>
    </div>
    ${pots.length ? `
    <div class="card">
      <div class="kpi-grid" style="margin-bottom:12px">
        <div class="kpi-item"><div class="kpi-label">Reserviert total</div><div class="kpi-value">${fmtExact(round2(totalReserved()))}</div></div>
        <div class="kpi-item"><div class="kpi-label">Einzahlung diesen Monat</div><div class="kpi-value" style="color:var(--orange)">${fmtExact(round2(totalReserveRate()))}</div></div>
      </div>
      <button class="btn ${doneThisMonth ? 'btn-ghost' : 'btn-primary'}" style="width:100%" onclick="bookMonthlyReserve()">
        ${doneThisMonth ? `✓ Einzahlung ${monthLabel(monthKey())} verbucht` : '💰 Monatliche Einzahlung verbucht'}
      </button>
      <div style="font-size:11px;color:var(--text2);margin-top:8px">Überweise den Betrag z.B. per Dauerauftrag aufs Sparkonto und tippe dann auf den Knopf – alle Töpfe werden um ihre Monatsrate gefüllt.</div>
    </div>
    <div class="item-list">${pots.map(renderPot).join('')}</div>` : ''}
    ${candidates.length ? `
    <div class="card" style="margin-top:10px">
      <div class="card-title">Ohne Rückstellung</div>
      ${candidates.map(e => `
        <div class="upcoming-row" style="margin-bottom:6px">
          <span class="upcoming-name">${iconFor(e.category)} ${esc(e.name)}
            <br><span style="font-size:11px;color:var(--text2)">${fmt(e.amount)} ${CYCLE_LABEL[e.frequency].toLowerCase()}${e.nextDue ? ' · fällig ' + fmtDate(e.nextDue) : ' · Fälligkeit fehlt'}</span></span>
          <button class="toggle-btn" onclick="openEdit('expense','${e.id}')">Einrichten</button>
        </div>`).join('')}
    </div>` : ''}`;
}

function renderPot(e) {
  const i = reserveInfo(e);
  const pct = e.amount > 0 ? Math.min(100, i.saved / e.amount * 100) : 0;
  const sollPct = e.amount > 0 ? Math.min(100, i.soll / e.amount * 100) : 0;
  const acc = e.reserveAccountId && state.accounts.find(a => a.id === e.reserveAccountId);
  const when = i.days < 0 ? `<span style="color:var(--red)">überfällig seit ${-i.days} T.</span>`
    : i.days === 0 ? 'heute fällig'
    : i.days <= 60 ? `in ${i.days} Tagen` : `in ${i.until} Mt.`;
  return `
  <div class="pot">
    <div class="pot-head">
      <div class="item-icon" style="background:${colorFor(e.category)}22">${iconFor(e.category)}</div>
      <div style="flex:1;min-width:0">
        <div class="item-name">${esc(e.name)}</div>
        <div class="item-sub">${fmtDate(e.nextDue)} · ${when}${acc ? ' · ' + esc(acc.name) : ''}</div>
      </div>
      <span class="status-badge badge-${i.status}">${STATUS_LABEL[i.status]}</span>
    </div>
    <div class="pot-bar" title="Strich = Soll-Stand heute">
      <div class="pot-fill" style="width:${pct}%;background:${STATUS_COLOR[i.status]}"></div>
      <div class="pot-soll" style="left:${sollPct}%"></div>
    </div>
    <div class="pot-nums">
      <span><strong>${fmtExact(round2(i.saved))}</strong> von ${fmtExact(e.amount)}</span>
      <span>Soll heute ${fmtExact(round2(i.soll))}</span>
    </div>
    <div class="pot-rate">Rate <strong>${fmtExact(round2(i.rate))}</strong>/Mt.${i.booked ? ' <span style="color:var(--green)">✓ verbucht</span>' : ''}${i.catchUp ? ` <span style="color:var(--orange)">· Nachholbedarf (normal ${fmtExact(round2(i.normal))})</span>` : ''}</div>
    ${i.shortfall > 0 ? `<div class="pot-warn">⚠️ Es fehlen ${fmtExact(round2(i.shortfall))} bis zur Fälligkeit</div>` : ''}
    <div class="pot-actions">
      <button class="btn btn-ghost" onclick="openPotCorrection('${e.id}')">✏️ Stand</button>
      <button class="btn btn-primary" onclick="openPaidModal('${e.id}')">✓ Bezahlt</button>
    </div>
  </div>`;
}

function bookMonthlyReserve() {
  const pots = reserveExpenses();
  if (!pots.length) return;
  if (state.settings.reserveDepositMonth === monthKey()
      && !confirm('Die Einzahlung für diesen Monat ist bereits verbucht. Nochmals verbuchen?')) return;
  // Raten zuerst berechnen, dann gutschreiben
  // Bei erneutem Verbuchen im selben Monat wird die frisch berechnete Rate verwendet
  const rates = pots.map(e => { const i = reserveInfo({ ...e, reserveBookedMonth: null }); return round2(i.need <= 0 ? 0 : i.rate); });
  pots.forEach((e, i) => {
    e.reserveSaved = round2((e.reserveSaved || 0) + rates[i]);
    const again = e.reserveBookedMonth === monthKey();
    e.reserveBookedAmount = round2((again ? e.reserveBookedAmount || 0 : 0) + rates[i]);
    e.reserveBookedMonth = monthKey();
  });
  state.settings.reserveDepositMonth = monthKey();
  saveState();
  toast(`${fmtExact(round2(rates.reduce((a, b) => a + b, 0)))} auf ${pots.length} Töpfe verteilt ✓`);
  refreshCurrent();
}

function openPotCorrection(id) {
  const e = state.expenses.find(x => x.id === id);
  if (!e) return;
  const i = reserveInfo(e);
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🐷 ${esc(e.name)}</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:12px">Soll-Stand heute: ${fmtExact(round2(i.soll))} · Ziel ${fmtExact(e.amount)}</div>
      <div class="field"><label>Aktuell zurückgelegt (${state.currency})</label>
        <input id="m-pot" type="number" inputmode="decimal" step="any" value="${round2(i.saved)}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="savePotCorrection('${e.id}')">Speichern</button>
      </div>
    </div>
  </div>`);
}

function savePotCorrection(id) {
  const e = state.expenses.find(x => x.id === id);
  const v = parseFloat(el('m-pot')?.value);
  if (!e || isNaN(v) || v < 0) { toast('Gültigen Betrag angeben'); return; }
  e.reserveSaved = round2(v);
  saveState(); closeModal(); toast('Stand angepasst ✓'); refreshCurrent();
}

// "Bezahlt": Buchung mit vollem Betrag, Topf leeren, nächste Fälligkeit +1 Zyklus
function openPaidModal(id) {
  const e = state.expenses.find(x => x.id === id);
  if (!e) return;
  const reserve = hasReserve(e);
  const saved = e.reserveSaved || 0;
  const next = addMonthsISO(e.nextDue || localISO(), cycleOf(e), e.dueDay);
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">✓ ${esc(e.name)} bezahlt</div>
      ${reserve && saved < e.amount ? `<div class="pot-warn" style="margin-bottom:12px">⚠️ Im Topf sind erst ${fmtExact(round2(saved))} – es fehlen ${fmtExact(round2(e.amount - saved))}. Der Rest geht zulasten des freien Budgets.</div>` : ''}
      <div class="field"><label>Bezahlter Betrag (${state.currency})</label>
        <input id="m-paid-amount" type="number" inputmode="decimal" step="any" value="${e.amount}">
      </div>
      <div class="field"><label>Datum</label>
        <input id="m-paid-date" type="date" value="${localISO()}">
      </div>
      ${state.accounts.length ? `
      <div class="field"><label>Von Konto (Saldo wird angepasst)</label>
        <select id="m-account">${accountOptions(e.reserveAccountId)}</select>
      </div>` : ''}
      <div style="font-size:12px;color:var(--text2)">
        ${reserve ? `Der Topf wird um den Betrag geleert${saved > e.amount ? ' (Überschuss bleibt drin)' : ''}. ` : ''}Nächste Fälligkeit: <strong style="color:var(--text)">${fmtDate(next)}</strong>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="savePaid('${e.id}')">Bezahlt ✓</button>
      </div>
    </div>
  </div>`);
}

function savePaid(id) {
  const e = state.expenses.find(x => x.id === id);
  const amount = parseFloat(el('m-paid-amount')?.value);
  const date = el('m-paid-date')?.value || localISO();
  if (!e || isNaN(amount) || amount <= 0) { toast('Betrag angeben'); return; }
  const reserve = hasReserve(e);
  const tx = { id: uid(), name: e.name, type: 'expense', amount: round2(amount), category: e.category, date,
    note: reserve ? 'Aus Rückstellung bezahlt' : '', accountId: el('m-account')?.value || null,
    expenseId: e.id, fromReserve: reserve };
  if (!state.transactions) state.transactions = [];
  state.transactions.push(tx);
  applyTxToAccount(tx, +1);
  if (reserve) e.reserveSaved = round2(Math.max(0, (e.reserveSaved || 0) - amount));
  e.nextDue = addMonthsISO(e.nextDue || date, cycleOf(e), e.dueDay);
  saveState(); closeModal();
  toast(`Bezahlt ✓ · nächste Fälligkeit ${fmtDate(e.nextDue)}`);
  refreshCurrent();
}

// ── Cashflow-Vorschau: tatsächlich fällige Zahlungen der nächsten 12 Monate ─
let cashflowChartInst = null;

function cashflowPreview() {
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() + i, 1)));
  const idx = Object.fromEntries(months.map((k, i) => [k, i]));
  const running = new Array(12).fill(0);
  const oneOff = new Array(12).fill(0);
  const items = months.map(() => []);
  // Laufend: monatliche Ausgaben + Schuldenraten + nicht-monatliche ohne Datum (als Durchschnitt)
  const base = state.expenses.reduce((s, e) => s + (!isIrregular(e) || !e.nextDue ? monthlyAmt(e) : 0), 0) + totalDebtPay();
  running.fill(base);
  const endKey = months[11];
  for (const e of state.expenses) {
    if (!isIrregular(e) || !e.nextDue) continue;
    let d = e.nextDue, guard = 0;
    while (d.slice(0, 7) <= endKey && guard++ < 40) {
      const k = d.slice(0, 7) < months[0] ? months[0] : d.slice(0, 7); // Überfälliges im aktuellen Monat
      oneOff[idx[k]] += e.amount;
      items[idx[k]].push(e);
      d = addMonthsISO(d, cycleOf(e), e.dueDay);
    }
  }
  const avg = totalExpenses() + totalDebtPay();
  return { months, running, oneOff, items, avg };
}

function renderCashflowPreview() {
  const card = el('cashflow-card');
  if (!card) return;
  if (!state.expenses.length && !state.debts.length) {
    if (cashflowChartInst) { cashflowChartInst.destroy(); cashflowChartInst = null; }
    card.innerHTML = '<div style="font-size:13px;color:var(--text2)">Erfasse regelmässige Ausgaben, um die Vorschau zu sehen.</div>';
    return;
  }
  const { months, running, oneOff, items, avg } = cashflowPreview();
  const totals = running.map((r, i) => r + oneOff[i]);
  const peak = Math.max(...totals);
  const peakIdx = totals.indexOf(peak);
  const label = k => { const [y, m] = k.split('-'); return new Date(y, m - 1, 1).toLocaleDateString('de-CH', { month: 'short', year: '2-digit' }); };
  const peakMonths = months.map((k, i) => ({ k, i })).filter(x => items[x.i].length);
  card.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:12px">
      <div class="kpi-item"><div class="kpi-label">Ø pro Monat</div><div class="kpi-value">${fmt(avg)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Spitzenmonat</div><div class="kpi-value red">${fmt(peak)}</div><div style="font-size:11px;color:var(--text2)">${monthLabel(months[peakIdx])}</div></div>
    </div>
    <div class="chart-wrap" style="height:190px"><canvas id="cashflow-chart"></canvas></div>
    ${peakMonths.length ? `
    <div class="card-title" style="margin:14px 0 8px">Einmalzahlungen</div>
    ${peakMonths.map(({ k, i }) => `
      <div class="cf-row">
        <span class="cf-month">${label(k)}</span>
        <span class="cf-items">${items[i].map(e => `${esc(e.name)}${hasReserve(e) ? ' 🐷' : ''}`).join(', ')}</span>
        <strong>${fmt(oneOff[i])}</strong>
      </div>`).join('')}
    <div style="font-size:11px;color:var(--text2);margin-top:6px">🐷 = durch Rückstellung gedeckt · Linie = gleichmässiger Durchschnitt</div>` : ''}`;

  if (!window.Chart) return;
  if (cashflowChartInst) cashflowChartInst.destroy();
  cashflowChartInst = new Chart(el('cashflow-chart'), {
    type: 'bar',
    data: {
      labels: months.map(k => { const [y, m] = k.split('-'); return new Date(y, m - 1, 1).toLocaleDateString('de-CH', { month: 'short' }); }),
      datasets: [
        { label: 'Laufend', data: running, backgroundColor: '#475569', stack: 'x', borderRadius: 3, order: 2 },
        { label: 'Einmalzahlungen', data: oneOff, backgroundColor: '#f97316', stack: 'x', borderRadius: 3, order: 2 },
        { label: 'Ø Monat', data: months.map(() => avg), type: 'line', stack: 'avg', borderColor: '#818cf8', borderDash: [5, 4],
          borderWidth: 2, pointRadius: 0, fill: false, order: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) } }
      },
      scales: {
        x: { stacked: true, ticks: { color: '#475569', font: { size: 10 }, maxRotation: 0 }, grid: { display: false } },
        y: { stacked: true, ticks: { color: '#475569', font: { size: 10 }, callback: v => fmtK(v) }, grid: { color: '#273549' } }
      }
    }
  });
}

// ── 12-Monats-Bericht ──────────────────────────────────────────────────────
let reportChartInst = null;

function renderReport() {
  const card = el('report-card');
  if (!card) return;
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => shiftKey(periodKeyOf(now), i - 11));
  const totals = months.map(k => monthTotals(k));
  const active = totals.filter(t => t.txs.length);
  if (!active.length) {
    if (reportChartInst) { reportChartInst.destroy(); reportChartInst = null; }
    card.innerHTML = '<div style="font-size:13px;color:var(--text2)">Sobald du Buchungen erfasst oder importierst, siehst du hier deinen Verlauf.</div>';
    return;
  }
  const avgExp = active.reduce((s, t) => s + t.expense - t.reserveExpense, 0) / active.length;
  const reserveTotal = totals.reduce((s, t) => s + t.reserveExpense, 0);
  const avgInc = active.reduce((s, t) => s + t.income, 0) / active.length;
  const byCat = {};
  totals.forEach(t => t.txs.filter(x => x.type !== 'income').forEach(x => { byCat[x.category] = (byCat[x.category] || 0) + x.amount; }));
  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const catTotal = Object.values(byCat).reduce((a, b) => a + b, 0) || 1;

  card.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:12px">
      <div class="kpi-item"><div class="kpi-label">Ø Einnahmen/Mt.</div><div class="kpi-value green">${fmtK(avgInc)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Ø Ausgaben/Mt.</div><div class="kpi-value red">${fmtK(avgExp)}</div>${reserveTotal > 0 ? `<div style="font-size:11px;color:var(--text2)">ohne Rückstellungen</div>` : ''}</div>
    </div>
    <div class="chart-wrap" style="height:180px"><canvas id="report-chart"></canvas></div>
    ${reserveTotal > 0 ? `<div style="font-size:11px;color:var(--text2);margin-top:6px">🐷 ${fmt(reserveTotal)} aus Rückstellungen bezahlt – im Monat der Zahlung separat dargestellt, das Geld war bereits zurückgelegt.</div>` : ''}
    <div class="card-title" style="margin:14px 0 8px">Top-Kategorien (12 Mt.)</div>
    ${topCats.map(([cat, amt]) => `
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
        <span>${iconFor(cat)} ${esc(cat)}</span>
        <span><strong>${fmt(amt)}</strong> <span style="color:var(--text2)">${(amt / catTotal * 100).toFixed(0)}%</span></span>
      </div>`).join('')}
    <div style="font-size:11px;color:var(--text2);margin-top:6px">Basis: ${active.length} Monat${active.length === 1 ? '' : 'e'} mit Buchungen</div>`;

  if (!window.Chart) return;
  if (reportChartInst) reportChartInst.destroy();
  reportChartInst = new Chart(el('report-chart'), {
    type: 'bar',
    data: {
      labels: months.map(k => periodLabel(k, true)),
      datasets: [
        { label: 'Einnahmen', data: totals.map(t => t.income),  backgroundColor: '#10b981', borderRadius: 4, stack: 'in' },
        { label: 'Ausgaben',  data: totals.map(t => t.expense - t.reserveExpense), backgroundColor: '#ef4444', borderRadius: 4, stack: 'out' },
        ...(reserveTotal > 0 ? [{ label: 'Aus Rückstellung', data: totals.map(t => t.reserveExpense), backgroundColor: '#f59e0b88',
            borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4, stack: 'out' }] : [])
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) } }
      },
      scales: {
        x: { stacked: true, ticks: { color: '#475569', font: { size: 10 }, maxRotation: 0 }, grid: { display: false } },
        y: { stacked: true, ticks: { color: '#475569', font: { size: 10 }, callback: v => fmtK(v) }, grid: { color: '#273549' } }
      }
    }
  });
}

// ── Bank-CSV-Import ────────────────────────────────────────────────────────
// Schlüsselwörter für die automatische Kategorisierung (Kleinbuchstaben)
const CATEGORY_RULES = [
  ['Lebensmittel',   ['migros', 'coop', 'denner', 'aldi', 'lidl', 'spar ', 'volg', 'rewe', 'edeka', 'landi', 'bäckerei', 'baeckerei']],
  ['Transport',      ['sbb', 'zvv', 'bls', 'tpg', 'postauto', 'shell', 'avia', 'tamoil', 'esso', 'bp ', 'agrola', 'parking', 'parkhaus', 'uber', 'mobility', 'tankstelle']],
  ['Versicherungen', ['css', 'helsana', 'swica', 'sanitas', 'visana', 'concordia', 'groupe mutuel', 'assura', 'kpt', 'axa', 'mobiliar', 'allianz', 'generali', 'baloise', 'helvetia', 'krankenkasse', 'versicherung']],
  ['Gesundheit',     ['apotheke', 'amavita', 'sunstore', 'pharmacie', 'arzt', 'zahnarzt', 'praxis', 'spital', 'drogerie']],
  ['Wohnen',         ['miete', 'mietzins', 'verwaltung', 'ewz', 'ekz', 'strom', 'serafe', 'swisscom', 'sunrise', 'salt', 'ikea']],
  ['Unterhaltung',   ['netflix', 'spotify', 'disney', 'youtube', 'kino', 'pathe', 'steam', 'playstation', 'nintendo', 'apple.com', 'google play']],
  ['Kleidung',       ['zalando', 'h&m', 'zara', 'c&a', 'uniqlo', 'globus', 'bershka', 'snipes', 'ochsner']],
  ['Freizeit',       ['restaurant', 'mcdonald', 'burger king', 'starbucks', 'cafe', 'café', 'bar ', 'fitness', 'kfc', 'pizza']],
  ['Bildung',        ['orell', 'ex libris', 'udemy', 'schule', 'kurs', 'universität', 'hochschule']],
  ['Haustiere',      ['fressnapf', 'qualipet', 'tierarzt']],
  ['Lohn',           ['lohn', 'salär', 'salaer', 'salary', 'gehalt']]
];

function guessCategory(text, type) {
  const t = ` ${text.toLowerCase()} `;
  // 1. Gleiche Bezeichnung schon einmal erfasst → deren Kategorie übernehmen (lernt von deinen Korrekturen)
  const prev = [...(state.transactions || [])].reverse().find(x => x.name.toLowerCase() === text.toLowerCase() && x.type === type);
  if (prev) return prev.category;
  for (const [cat, words] of CATEGORY_RULES) {
    if (words.some(w => t.includes(w))) {
      if (type === 'income') return cat === 'Lohn' ? 'Lohn' : 'Sonstiges';
      if (cat !== 'Lohn') return cat;
    }
  }
  return type === 'income' ? 'Sonstiges' : 'Ausgabe';
}

// Bank-Exporte sind oft Windows-1252 kodiert (Umlaute) – bei Fehlern neu dekodieren
async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

let bankImport = null;

function detectColumns(header) {
  const find = re => header.findIndex(h => re.test(String(h).toLowerCase()));
  return {
    date:   find(/datum|date|valuta|abschluss/),
    text:   find(/buchungstext|beschreibung|text|description|details|empfänger|empfaenger|mitteilung|zahlungszweck|verwendungszweck/),
    amount: find(/^betrag|amount|betrag in|umsatz/),
    debit:  find(/belastung|soll|debit|ausgang|lastschrift/),
    credit: find(/gutschrift|haben|credit|eingang/)
  };
}

async function handleBankImport(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const rows = parseCSV(await readTextSmart(file)).filter(r => r.some(c => c));
    // Erste Datenzeile = erste Zeile mit Datum; Kopfzeile = Zeile davor
    const first = rows.findIndex(r => r.some(c => parseDate(c)) && r.some(c => /\d/.test(c) && !parseDate(c) && !isNaN(parseNumber(c))));
    if (first < 0) { toast('Keine Buchungen in der Datei erkannt'); return; }
    const header = first > 0 ? rows[first - 1] : rows[first].map((_, i) => `Spalte ${i + 1}`);
    const data = rows.slice(first).filter(r => r.length >= 2);
    bankImport = { header, data, cols: detectColumns(header) };
    openBankImportModal();
  } catch {
    toast('Datei konnte nicht gelesen werden');
  }
}

function bankImportParse() {
  const { data } = bankImport;
  const col = id => { const v = el(id)?.value; return v === '' || v == null ? -1 : +v; };
  const c = { date: col('bi-date'), text: col('bi-text'), amount: col('bi-amount'), debit: col('bi-debit'), credit: col('bi-credit') };
  const out = [];
  for (const r of data) {
    const date = parseDate(r[c.date]);
    if (!date) continue;
    let value;
    if (c.amount >= 0) value = parseNumber(r[c.amount]);
    else {
      const d = parseNumber(r[c.debit]), cr = parseNumber(r[c.credit]);
      value = (isNaN(cr) ? 0 : Math.abs(cr)) - (isNaN(d) ? 0 : Math.abs(d));
    }
    if (isNaN(value) || value === 0) continue;
    const name = (String(r[c.text] ?? '').replace(/\s+/g, ' ').trim() || 'Buchung').slice(0, 80);
    const type = value > 0 ? 'income' : 'expense';
    out.push({ date, name, type, amount: Math.round(Math.abs(value) * 100) / 100, category: guessCategory(name, type) });
  }
  const isDup = t => (state.transactions || []).some(x => x.date === t.date && x.amount === t.amount && x.type === t.type && x.name === t.name);
  return { items: out.filter(t => !isDup(t)), dups: out.filter(isDup).length };
}

function updateBankImportPreview() {
  const { items, dups } = bankImportParse();
  const inc = items.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const exp = items.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  el('bi-preview').innerHTML = items.length ? `
    <div style="font-size:13px;margin-bottom:6px"><strong>${items.length}</strong> Buchungen erkannt${dups ? ` · ${dups} Duplikate übersprungen` : ''}</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:8px">Einnahmen <span style="color:var(--green)">${fmt(inc)}</span> · Ausgaben <span style="color:var(--red)">${fmt(exp)}</span></div>
    ${items.slice(0, 4).map(t => `<div class="upcoming-row" style="margin-bottom:4px">
      <span class="upcoming-name">${iconFor(t.category)} ${esc(t.name)}</span>
      <span style="font-weight:600;color:${t.type === 'income' ? 'var(--green)' : 'var(--red)'}">${t.type === 'income' ? '+' : '−'}${fmtExact(t.amount)}</span></div>`).join('')}`
    : dups
      ? `<div style="font-size:13px;color:var(--text2)">Alle ${dups} Buchungen sind bereits vorhanden – nichts Neues zu importieren.</div>`
      : `<div style="font-size:13px;color:var(--red)">Keine gültigen Buchungen – prüfe die Spaltenzuordnung.</div>`;
  el('bi-split-wrap').style.display = el('bi-amount').value === '' ? '' : 'none';
}

function openBankImportModal() {
  const { header, cols } = bankImport;
  const opts = (sel, allowNone) => (allowNone ? `<option value="">— keine —</option>` : '') +
    header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || 'Spalte ' + (i + 1))}</option>`).join('');
  const hasSplit = cols.amount < 0 && (cols.debit >= 0 || cols.credit >= 0);
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🏦 Bank-CSV importieren</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Ordne die Spalten zu. Kategorien werden automatisch vergeben und lernen aus deinen Korrekturen.</div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Datum</label><select id="bi-date" onchange="updateBankImportPreview()">${opts(Math.max(0, cols.date))}</select></div>
        <div class="field" style="flex:1"><label>Beschreibung</label><select id="bi-text" onchange="updateBankImportPreview()">${opts(Math.max(0, cols.text))}</select></div>
      </div>
      <div class="field"><label>Betrag (eine Spalte, +/−)</label>
        <select id="bi-amount" onchange="updateBankImportPreview()">${opts(hasSplit ? -1 : cols.amount, true)}</select>
      </div>
      <div id="bi-split-wrap" style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Belastung</label><select id="bi-debit" onchange="updateBankImportPreview()">${opts(cols.debit, true)}</select></div>
        <div class="field" style="flex:1"><label>Gutschrift</label><select id="bi-credit" onchange="updateBankImportPreview()">${opts(cols.credit, true)}</select></div>
      </div>
      ${state.accounts.length ? `
      <div class="field"><label>Konto zuordnen (optional)</label>
        <select id="m-account">${accountOptions(null)}</select>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Der Kontosaldo wird dabei nicht verändert – er stammt ja bereits von der Bank.</div>
      </div>` : ''}
      <div id="bi-preview" style="margin:6px 0 4px"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="confirmBankImport()">Importieren</button>
      </div>
    </div>
  </div>`);
  updateBankImportPreview();
}

function confirmBankImport() {
  const { items } = bankImportParse();
  if (!items.length) { toast('Nichts zu importieren'); return; }
  const accountId = el('m-account')?.value || null;
  if (!state.transactions) state.transactions = [];
  for (const t of items) state.transactions.push({ id: uid(), ...t, note: '', accountId, noBalance: !!accountId });
  txMonth = periodKeyOf(parseISO(items.map(t => t.date).sort().pop()));
  bankImport = null;
  saveState(); closeModal(); toast(`${items.length} Buchungen importiert ✓`);
  refreshCurrent();
}

// ── Vermögen (Investitionen + Schulden) ────────────────────────────────────
RENDERERS.vermoegen = function renderVermoegen() {
  renderAccountsInVermoegen();
  renderVermoegenSummary();
  renderInvestSection();
  renderDebtSection();
  renderDepotSection();
};

function renderVermoegenSummary() {
  const nw     = netWorth();
  const assets = totalAssets();
  const debt   = totalDebt();
  const nwColor = nw >= 0 ? 'var(--green)' : 'var(--red)';
  const nwIcon  = nw >= 0 ? '▲' : '▼';
  el('vermoegen-summary').innerHTML = `
  <div class="card nw-summary-card">
    <div class="card-title" style="margin-bottom:12px">Übersicht Nettovermögen</div>
    <div class="nw-sum-row">
      <div class="nw-sum-item">
        <div class="nw-sum-label">💰 Vermögen</div>
        <div class="nw-sum-val green">${fmtK(assets)}</div>
      </div>
      <div class="nw-sum-op">−</div>
      <div class="nw-sum-item">
        <div class="nw-sum-label">🏦 Schulden</div>
        <div class="nw-sum-val red">${fmtK(debt)}</div>
      </div>
      <div class="nw-sum-op">=</div>
      <div class="nw-sum-item">
        <div class="nw-sum-label">📊 Netto</div>
        <div class="nw-sum-val" style="color:${nwColor}">${nwIcon} ${fmtK(Math.abs(nw))}</div>
      </div>
    </div>
  </div>`;
}

function renderInvestSection() {
  el('invest-total').textContent    = fmt(totalInvestments());
  el('portfolio-display').textContent = fmt(state.portfolioValue);

  // Aufteilung nach Kategorie
  const allocEl = el('invest-alloc-section');
  if (state.investments.length) {
    const total = totalInvestments();
    const cats  = {};
    for (const i of state.investments) cats[i.category] = (cats[i.category] || 0) + i.amount;
    const bars  = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    allocEl.innerHTML = `
    <div class="alloc-wrap">
      <div class="alloc-bar">
        ${bars.map(([cat, amt]) =>
          `<div class="alloc-seg" style="width:${(amt/total*100).toFixed(1)}%;background:${colorFor(cat)}" title="${cat}: ${fmt(amt)}/Mt."></div>`
        ).join('')}
      </div>
      <div class="alloc-legend">
        ${bars.map(([cat, amt]) => `
        <span class="alloc-badge">
          <span class="alloc-dot" style="background:${colorFor(cat)}"></span>
          <span class="alloc-cat">${cat}</span>
          <span class="alloc-pct">${(amt/total*100).toFixed(0)}%</span>
        </span>`).join('')}
      </div>
    </div>`;
  } else {
    allocEl.innerHTML = '';
  }

  // Investitionsliste
  const ilist = el('invest-list');
  ilist.innerHTML = state.investments.length
    ? state.investments.map(i => listItem({
        icon: iconFor(i.category), color: colorFor(i.category),
        name: esc(i.name), sub: i.category + ' · Ø ' + (i.returnRate || 6) + '% p.a.',
        amount: fmt(i.amount) + '/Mt.', amountColor: 'var(--blue)', id: i.id, type: 'investment'
      })).join('')
    : emptyState('📈', 'Noch keine Investitionen erfasst.');
}

function renderDebtSection() {
  el('debt-total').textContent     = fmt(totalDebt());
  el('debt-pay-total').textContent = fmt(totalDebtPay()) + '/Mt.';

  // Tilgungsstrategie
  const stratEl = el('debt-strategy');
  if (state.debts.length >= 2) {
    const byInterest = [...state.debts].sort((a, b) => b.interestRate - a.interestRate)[0];
    const byAmount   = [...state.debts].sort((a, b) => a.remainingAmount - b.remainingAmount)[0];
    const totalMonths = state.debts.reduce((s, d) => {
      const m = debtPayoffMonths(d); return s + (m || 0);
    }, 0);
    stratEl.innerHTML = `
    <div class="strat-box">
      <div class="card-title" style="margin-bottom:8px">💡 Tilgungsstrategie</div>
      <div class="strat-row">
        <div class="strat-item">
          <div class="strat-icon">⚡</div>
          <div>
            <div class="strat-label">Avalanche</div>
            <div class="strat-desc">Höchste Zinsen zuerst zahlen → spart am meisten</div>
            <div class="strat-target">${esc(byInterest.name)} · ${byInterest.interestRate}% p.a.</div>
          </div>
        </div>
        <div class="strat-item">
          <div class="strat-icon">❄️</div>
          <div>
            <div class="strat-label">Snowball</div>
            <div class="strat-desc">Kleinste Schuld zuerst → motivierender</div>
            <div class="strat-target">${esc(byAmount.name)} · ${fmtK(byAmount.remainingAmount)}</div>
          </div>
        </div>
      </div>
    </div>`;
  } else {
    stratEl.innerHTML = '';
  }

  // Schuldenliste
  const dlist = el('debt-list');
  const strat = el('debt-strategy-section');
  if (strat) strat.style.display = state.debts.length ? 'block' : 'none';
  if (!state.debts.length) {
    dlist.innerHTML = emptyState('🏦', 'Keine Schulden – sehr gut!');
    return;
  }

  dlist.innerHTML = state.debts.map(d => {
    const months = debtPayoffMonths(d);
    const pct    = d.originalAmount > 0
      ? Math.max(0, Math.min(100, (1 - d.remainingAmount / d.originalAmount) * 100))
      : 0;
    return `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:rgba(239,68,68,.15)">${iconFor(d.category)}</div>
        <div style="min-width:0">
          <div class="item-name">${esc(d.name)}</div>
          <div class="item-sub">${d.category} · ${d.interestRate}% Zins · ${fmt(d.monthlyPayment)}/Mt.</div>
          <div style="margin-top:6px">
            <div class="budget-bar"><div class="budget-fill budget-ok" style="width:${pct}%"></div></div>
            <div style="font-size:11px;color:var(--text2);margin-top:3px">
              ${pct.toFixed(0)}% abgezahlt ·
              <span class="payoff-chip">${months ? 'Frei in ' + formatETA(months) : '⚠️ Rate erhöhen!'}</span>
            </div>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="item-amount" style="color:var(--red)">${fmt(d.remainingAmount)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('debt','${d.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('debt','${d.id}')">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderAccountsInVermoegen() {
  const container = el('accounts-vermoegen-list');
  if (!container) return;
  if (!state.accounts.length) { container.innerHTML = emptyState('💳', 'Noch keine Konten erfasst.'); return; }
  container.innerHTML = state.accounts.map(a => `
    <div class="list-item" style="margin-bottom:8px">
      <div class="item-left">
        <div class="item-icon" style="background:rgba(99,102,241,.15)">${accTypeIcon(a.type)}</div>
        <div>
          <div class="item-name">${esc(a.name)}</div>
          <div class="item-sub">${accTypeLabel(a.type)}${(() => { const r = reserveExpenses().filter(e => e.reserveAccountId === a.id).reduce((s, e) => s + (e.reserveSaved || 0), 0); return r > 0 ? ` · 🐷 ${fmtExact(round2(r))} reserviert` : ''; })()}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="item-amount" style="color:${a.balance >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(a.balance)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('account','${a.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('account','${a.id}')">🗑️</button>
        </div>
      </div>
    </div>${a.type === 'credit' && typeof renderCardDetails === 'function' ? renderCardDetails(a) : ''}`).join('');
}

// ── Depot-Import (CSV / Excel) ─────────────────────────────────────────────
let depotChartInst = null;
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

// Excel-Bibliothek erst bei Bedarf laden – spart ~900 KB beim App-Start
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_URL; s.async = true;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('XLSX konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
}

// Akzeptiert 12'345.50 · 12.345,50 · 12,345.50 · CHF 1 234
function parseNumber(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d.,\-]/g, '');
  if (!s) return NaN;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return parseFloat(s);
}

// Akzeptiert 2024-01-31 · 31.01.2024 · 31/01/24 · Excel-Seriennummern · Date-Objekte
function parseDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

// CSV mit Anführungszeichen (z.B. "Coop, Zürich") korrekt zerlegen
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  // Trennzeichen anhand der ersten Zeilen erkennen (Bank-Exporte haben oft Kopfzeilen davor)
  const sample = text.split(/\r?\n/, 10).join('\n');
  const delim = [';', '\t', ','].reduce((best, d) => sample.split(d).length > sample.split(best).length ? d : best, ';');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some(c => c)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(c => c)) rows.push(row);
  return rows;
}

function rowsToHistory(rows) {
  const out = [];
  for (const r of rows) {
    const date = parseDate(r[0]);
    const value = parseNumber(r[1]);
    if (!date || isNaN(value)) continue; // Kopfzeile oder ungültige Zeile
    const invested = parseNumber(r[2]);
    out.push({ date, value, invested: isNaN(invested) ? null : invested });
  }
  const byDate = new Map(out.map(h => [h.date, h]));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function handlePortfolioUpload(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    let rows;
    if (/\.csv$/i.test(file.name)) {
      rows = parseCSV(await file.text());
    } else {
      toast('Lade Excel-Import…');
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    }
    const history = rowsToHistory(rows);
    if (!history.length) { toast('Keine gültigen Zeilen gefunden (A = Datum, B = Wert)'); return; }
    state.portfolioHistory = history;
    state.portfolioValue = history[history.length - 1].value;
    saveState();
    toast(`${history.length} Einträge importiert ✓`);
    refreshCurrent();
  } catch (err) {
    toast(navigator.onLine ? 'Datei konnte nicht gelesen werden' : 'Excel-Import braucht Internet – nutze CSV');
  } finally {
    input.value = ''; // gleiche Datei erneut wählbar
  }
}

function clearPortfolioHistory() {
  if (!confirm('Importierte Depot-Historie löschen?')) return;
  state.portfolioHistory = [];
  saveState(); toast('Gelöscht'); refreshCurrent();
}

function renderDepotSection() {
  const section = el('depot-chart-section');
  const hist = state.portfolioHistory || [];
  if (!section) return;
  if (!hist.length) {
    section.style.display = 'none';
    if (depotChartInst) { depotChartInst.destroy(); depotChartInst = null; }
    return;
  }
  section.style.display = 'block';

  const first = hist[0], last = hist[hist.length - 1];
  const invested = last.invested;
  const gain = invested != null ? last.value - invested : last.value - first.value;
  const base = invested != null ? invested : first.value;
  const gainPct = base ? gain / base * 100 : 0;
  const up = gain >= 0;
  const col = up ? 'var(--green)' : 'var(--red)';
  el('depot-stats').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-item"><div class="kpi-label">Aktueller Wert</div><div class="kpi-value">${fmtK(last.value)}</div></div>
      <div class="kpi-item"><div class="kpi-label">${invested != null ? 'Gewinn/Verlust' : 'Veränderung'}</div>
        <div class="kpi-value" style="color:${col}">${up ? '+' : ''}${fmtK(gain)} <span style="font-size:12px">(${up ? '+' : ''}${gainPct.toFixed(1)}%)</span></div></div>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:6px">${hist.length} Einträge · ${fmtDate(first.date)} – ${fmtDate(last.date)}</div>`;

  const canvas = el('depot-chart');
  if (!canvas || !window.Chart) return;
  const labels = hist.map(h => new Date(h.date).toLocaleDateString('de-CH', { month: 'short', year: '2-digit' }));
  const datasets = [{ label: 'Depotwert', data: hist.map(h => h.value), borderColor: '#10b981',
    backgroundColor: 'rgba(16,185,129,.1)', fill: true, tension: .3, pointRadius: hist.length > 40 ? 0 : 2, borderWidth: 2 }];
  if (hist.some(h => h.invested != null)) {
    datasets.push({ label: 'Eingesetzt', data: hist.map(h => h.invested), borderColor: '#6366f1',
      backgroundColor: 'transparent', fill: false, tension: .3, pointRadius: 0, borderWidth: 2, borderDash: [4, 3], spanGaps: true });
  }
  if (depotChartInst) depotChartInst.destroy();
  depotChartInst = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) } }
      },
      scales: {
        x: { ticks: { color: '#475569', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#475569', font: { size: 10 }, callback: v => fmtK(v) }, grid: { color: '#273549' } }
      }
    }
  });
}

// ── Ziele ──────────────────────────────────────────────────────────────────
RENDERERS.ziele = function() {
  renderFIRE();
  renderKaufkraft();
  renderGoals();
};

function renderFIRE() {
  const fn        = fireNumber();
  const fp        = fireProgress();
  const feta      = fireETA();
  const fexp      = fireExpenses();
  const remaining = Math.max(0, fn - state.portfolioValue);
  const inv       = totalInvestments();

  // Meilensteine
  const milestones = [25, 50, 75, 100];
  const milestonesHTML = fn > 0 ? `
  <div class="milestone-row">
    ${milestones.map(m => {
      const reached = fp >= m;
      return `<div class="milestone-item ${reached ? 'ms-reached' : ''}">
        <div class="milestone-dot">${reached ? '✓' : ''}</div>
        <div class="milestone-pct">${m}%</div>
      </div>`;
    }).join('')}
  </div>` : '';

  // Szenarien: wie viel müsste ich monatlich investieren?
  const scenariosHTML = fn > 0 && fn > state.portfolioValue ? (() => {
    const r  = weightedReturn() / 100 / 12;
    const pv = state.portfolioValue;
    const yrs = [10, 15, 20, 30];
    const items = yrs.map(y => {
      const n    = y * 12;
      const fvPv = pv * Math.pow(1 + r, n);
      if (fn <= fvPv) return { y, label: 'Schon erreicht!', ok: true };
      const pmt = r > 0
        ? (fn - fvPv) * r / (Math.pow(1 + r, n) - 1)
        : (fn - fvPv) / n;
      const needed = Math.max(0, Math.ceil(pmt));
      const diff   = needed - inv;
      return { y, label: fmt(needed) + '/Mt.', diff, ok: false };
    });
    return `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <div class="card-title" style="margin-bottom:8px">📅 Monatliche Investition zum Ziel</div>
      <div class="kpi-grid">
        ${items.map(s => `
        <div class="kpi-item">
          <div class="kpi-label">In ${s.y} Jahren</div>
          <div class="kpi-value" style="font-size:14px;color:${s.ok ? 'var(--green)' : 'var(--text)'}">${s.label}</div>
          ${!s.ok && s.diff !== undefined && inv > 0
            ? `<div style="font-size:11px;margin-top:2px;color:${s.diff > 0 ? 'var(--red)' : 'var(--green)'}">
                ${s.diff > 0 ? '+' + fmt(s.diff) + ' mehr' : '✓ Im Plan'}
               </div>` : ''}
        </div>`).join('')}
      </div>
    </div>`;
  })() : '';

  el('fire-card').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
      <div>
        <div style="font-size:17px;font-weight:700">🔥 FIRE-Rechner</div>
        <div style="font-size:12px;color:var(--text2);margin-top:2px">
          ${state.settings.fireWithdrawalRate}% Entnahmerate ·
          ${state.settings.fireWithdrawalRate === 4 ? 'Trinity-Studie' : 'angepasst'}
        </div>
      </div>
      <button class="btn btn-ghost btn-icon" onclick="openFIRESettings()" title="Einstellungen">⚙️</button>
    </div>

    <div class="kpi-grid" style="margin-bottom:14px">
      <div class="kpi-item">
        <div class="kpi-label">FIRE-Zahl</div>
        <div class="kpi-value">${fmtK(fn)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Depotwert</div>
        <div class="kpi-value green">${fmtK(state.portfolioValue)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Ruhestand / Mt.</div>
        <div class="kpi-value">${fmtK(fexp)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Noch benötigt</div>
        <div class="kpi-value red">${remaining > 0 ? fmtK(remaining) : '✓ Erreicht!'}</div>
      </div>
    </div>

    ${milestonesHTML}

    <div style="margin:12px 0 6px;display:flex;justify-content:space-between;font-size:13px">
      <span style="color:var(--text2)">Fortschritt</span>
      <strong>${fp.toFixed(1)}%</strong>
    </div>
    <div class="rate-bar" style="height:10px">
      <div style="height:100%;width:${Math.min(100, fp)}%;background:linear-gradient(90deg,var(--primary),var(--primary-light));border-radius:99px;transition:width .6s"></div>
    </div>

    <div style="margin-top:12px;padding:12px;background:var(--surface2);border-radius:var(--radius-sm);text-align:center;font-size:14px">
      ${fp >= 100
        ? `🎉 <strong style="color:var(--green)">FIRE erreicht!</strong> Du bist finanziell frei.`
        : feta
          ? `🎯 Finanzielle Freiheit in ca. <strong>${formatETA(feta)}</strong>`
          : inv > 0 && fn > 0
            ? `<span style="color:var(--text2)">Portfolio wächst – Prognose überschreitet 720 Monate</span>`
            : fn > 0
              ? `<span style="color:var(--text2)">Trage monatliche Investitionen ein für die Prognose</span>`
              : `<span style="color:var(--text2)">Erfasse Einkommen und Ausgaben für die Berechnung</span>`}
    </div>

    ${scenariosHTML}`;
}

function renderKaufkraft() {
  const inflEl = el('inflation-display');
  if (inflEl) inflEl.textContent = (state.settings.inflationRate || 2) + '%';
  const lbl = el('kk-amount-label');
  if (lbl) lbl.textContent = `Betrag (${state.currency})`;
  updateKaufkraft();
}

function updateKaufkraft() {
  const amount = parseFloat(el('kk-amount')?.value);
  const years  = parseInt(el('kk-years')?.value) || 10;
  const result = el('kk-result');
  if (!result) return;
  if (!amount || amount <= 0) {
    result.innerHTML = '<div style="font-size:13px;color:var(--text2)">Betrag eingeben um die Kaufkraft zu berechnen.</div>';
    return;
  }
  const inf = (state.settings.inflationRate || 2) / 100;
  const realValue = amount / Math.pow(1 + inf, years);
  const lossPct = (1 - realValue / amount) * 100;
  const step = years <= 10 ? 1 : 5;
  let rows = '';
  for (let y = step; y <= years; y += step) {
    const v = amount / Math.pow(1 + inf, y);
    rows += `<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text2)">In ${y} Jahr${y !== 1 ? 'en' : ''}</span>
      <span style="font-weight:600">${fmt(v)}</span>
      <span style="color:var(--red)">-${fmt(amount - v)}</span>
    </div>`;
  }
  result.innerHTML = `
    <div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px">
      <div style="font-size:12px;color:var(--text2)">Kaufkraftverlust nach ${years} Jahren</div>
      <div style="font-size:26px;font-weight:800;color:var(--red)">-${lossPct.toFixed(1)}%</div>
      <div style="font-size:13px;margin-top:2px">${fmt(amount)} → <strong>${fmt(realValue)}</strong></div>
    </div>
    ${rows}
    <div style="font-size:11px;color:var(--text2);margin-top:8px">Inflationsrate: ${state.settings.inflationRate || 2}% · Einstellbar unter ⚙️ → FIRE-Einstellungen</div>`;
}

function renderGoals() {
  const list = el('ziele-list');
  const sav  = Math.max(0, monthlySavings());
  if (!state.goals.length) {
    list.innerHTML = emptyState('🎯', 'Noch keine Sparziele festgelegt.');
    return;
  }

  const active = state.goals.filter(g => g.currentAmount < g.targetAmount);
  const done   = state.goals.filter(g => g.currentAmount >= g.targetAmount);

  const renderDone = done.map(g => {
    const pct = Math.min(100, g.currentAmount / g.targetAmount * 100);
    return `
    <div class="card goal-card-done">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:700">${g.icon || '🎯'} ${esc(g.name)}</div>
          <div style="font-size:13px;color:var(--green);margin-top:3px;font-weight:600">🎉 Ziel erreicht · ${fmt(g.currentAmount)}</div>
        </div>
        <div style="display:flex;gap:5px">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('goal','${g.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('goal','${g.id}')">🗑️</button>
        </div>
      </div>
      <div class="progress-bar" style="height:6px;margin-top:12px">
        <div style="height:100%;width:100%;border-radius:99px;background:var(--green);transition:width .4s"></div>
      </div>
    </div>`;
  });

  const renderActive = active.map(g => {
    const rem = Math.max(0, g.targetAmount - g.currentAmount);
    const pct = g.targetAmount > 0 ? Math.min(100, g.currentAmount / g.targetAmount * 100) : 0;

    let etaLabel  = '–';
    let etaMonths = null;
    if (sav > 0 && rem > 0) {
      etaMonths = Math.ceil(rem / sav);
      const d = new Date();
      d.setMonth(d.getMonth() + etaMonths);
      etaLabel = `${formatETA(etaMonths)} · ${d.toLocaleDateString('de-CH', { month: 'long', year: 'numeric' })}`;
    }

    const insights = goalInsights(rem, sav, etaMonths);
    return `
    <div class="card goal-card-new">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-size:16px;font-weight:700">${g.icon || '🎯'} ${esc(g.name)}</div>
          <div style="font-size:13px;color:var(--text2);margin-top:2px">${fmt(g.currentAmount)} von ${fmt(g.targetAmount)}</div>
        </div>
        <div style="display:flex;gap:5px">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('goal','${g.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('goal','${g.id}')">🗑️</button>
        </div>
      </div>

      <button class="btn btn-primary" style="width:100%;margin-bottom:12px" onclick="openGoalDepositModal('${g.id}')">💰 Einzahlen</button>

      <div class="progress-bar" style="height:10px">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-top:5px;margin-bottom:12px">
        <span><strong style="color:var(--text)">${pct.toFixed(0)}%</strong> erreicht</span>
        <span>Noch <strong style="color:var(--text)">${fmt(rem)}</strong></span>
      </div>

      ${etaMonths ? `
      <div class="goal-eta-box">
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">⏱ Zieldatum bei aktuellem Sparpotenzial</div>
        <div style="font-size:15px;font-weight:700;color:var(--primary-light)">${etaLabel}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:3px">${fmt(sav)}/Mt. verfügbar · ${fmt(rem)} noch benötigt</div>
      </div>` : sav <= 0 ? `
      <div class="goal-eta-box" style="border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.06)">
        <div style="font-size:13px;color:var(--red)">⚠️ Kein freies Kapital – überprüfe deine Ausgaben</div>
      </div>` : ''}

      ${insights.length ? `
      <div style="margin-top:10px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:6px">💡 Spar-Szenarien</div>
        <div class="insight-list">${insights.map(i => `
          <div class="insight-row">
            <span class="insight-bonus">+${i.bonus} ${state.currency}/Mt.</span>
            <span class="insight-arrow">→</span>
            <span class="insight-saving">${i.savedLabel} früher</span>
            <span class="insight-date">${i.newDate}</span>
          </div>`).join('')}</div>
      </div>` : ''}
    </div>`;
  });

  list.innerHTML = [...renderActive, ...renderDone].join('');
}

function goalInsights(remaining, savingsPerMonth, currentMonths) {
  if (!currentMonths || remaining <= 0) return [];
  const bonuses = [50,100,200,500,1000,2000], insights = [];
  for (const bonus of bonuses) {
    const newSav = savingsPerMonth + bonus;
    const newMonths = Math.ceil(remaining / newSav);
    const saved = currentMonths - newMonths;
    if (saved < 1) continue;
    const d = new Date(); d.setMonth(d.getMonth() + newMonths);
    insights.push({ bonus, savedLabel: formatETA(saved), newDate: d.toLocaleDateString('de-CH', { month: 'short', year: 'numeric' }) });
    if (insights.length >= 4) break;
  }
  return insights;
}

// ── Hilfs-Render ───────────────────────────────────────────────────────────
function emptyState(emoji, text) {
  return `<div class="empty"><div class="emoji">${emoji}</div><p>${text}</p></div>`;
}

function listItem({ icon, color, name, sub, amount, amountColor, id, type }) {
  return `
  <div class="list-item">
    <div class="item-left">
      <div class="item-icon" style="background:${color}22">${icon}</div>
      <div><div class="item-name">${name}</div><div class="item-sub">${sub}</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
      <span class="item-amount" style="color:${amountColor}">${amount}</span>
      <div class="item-actions">
        <button class="btn btn-ghost btn-icon" onclick="openEdit('${type}','${id}')">✏️</button>
        <button class="btn btn-danger btn-icon" onclick="deleteItem('${type}','${id}')">🗑️</button>
      </div>
    </div>
  </div>`;
}

// ── Löschen ────────────────────────────────────────────────────────────────
function deleteItem(type, id) {
  const map = { income:'income', expense:'expenses', investment:'investments', debt:'debts', goal:'goals', account:'accounts', transaction:'transactions' };
  const key = map[type];
  if (!key) return;
  const item = state[key].find(x => x.id === id);
  if (type === 'transaction') applyTxToAccount(item, -1);
  state[key] = state[key].filter(x => x.id !== id);
  DELETE_HOOKS.forEach(fn => fn(type, item));
  saveState(); toast('Gelöscht'); refreshCurrent();
}

// ── Modal-Basis ────────────────────────────────────────────────────────────
const isTouch = window.matchMedia('(pointer: coarse)').matches;
let ignoreNextPop = false;

function removeModal() {
  el('modal-backdrop')?.remove();
  document.body.classList.remove('modal-open');
  editContext = null;
}

function closeModal() {
  removeModal();
  // Verlaufseintrag des Modals entfernen – verzögert, da oft direkt ein neues Modal folgt
  setTimeout(() => {
    if (!el('modal-backdrop') && history.state?.modal) { ignoreNextPop = true; history.back(); }
  }, 0);
}
function handleBackdropClick(e) { if (e.target.id === 'modal-backdrop') closeModal(); }

function showModal(html) {
  el('modal-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  document.body.classList.add('modal-open');
  if (!history.state?.modal) history.pushState({ modal: true, page: currentPage }, '', location.hash);
  // Auf dem Handy nicht automatisch fokussieren – sonst springt sofort die Tastatur auf
  if (!isTouch) setTimeout(() => document.querySelector('.modal input:not([type=hidden]), .modal select')?.focus(), 50);
}

function openEdit(type, id) {
  const lists = { income:'income', expense:'expenses', investment:'investments', debt:'debts', goal:'goals', account:'accounts', transaction:'transactions' };
  const item = state[lists[type]]?.find(x => x.id === id);
  if (!item) return;
  editContext = { type, id };
  ({ income: openIncomeModal, expense: openExpenseModal, investment: openInvestmentModal,
     debt: openDebtModal, goal: openGoalModal, account: openAccountItemModal,
     transaction: openTransactionModal })[type]?.(item);
}

// ── Konten ─────────────────────────────────────────────────────────────────
function openAccountsModal() {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">Konten & Vermögen</div>
      <div id="accounts-in-modal">
        ${state.accounts.length
          ? state.accounts.map(a => `
            <div class="list-item" style="margin-bottom:8px">
              <div class="item-left">
                <div class="item-icon" style="background:rgba(99,102,241,.15)">
                  ${accTypeIcon(a.type)}
                </div>
                <div>
                  <div class="item-name">${esc(a.name)}</div>
                  <div class="item-sub">${accTypeLabel(a.type)}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                <span class="item-amount">${fmt(a.balance)}</span>
                <button class="btn btn-ghost btn-icon" onclick="closeModal();editContext={type:'account',id:'${a.id}'};openAccountItemModal(state.accounts.find(x=>x.id==='${a.id}'))">✏️</button>
                <button class="btn btn-danger btn-icon" onclick="deleteItem('account','${a.id}');closeModal();openAccountsModal()">🗑️</button>
              </div>
            </div>`).join('')
          : emptyState('💳', 'Noch keine Konten erfasst.')}
      </div>
      <div style="display:flex;gap:8px;margin:8px 0">
        <button class="add-btn" style="flex:1" onclick="closeModal();openAccountItemModal()">+ Konto</button>
        ${state.accounts.length >= 2 ? `<button class="add-btn" style="flex:1;color:var(--primary-light);border-color:rgba(99,102,241,.4)" onclick="closeModal();openTransferModal()">↔ Überweisung</button>` : ''}
      </div>
      <button class="btn btn-ghost btn-full" style="margin-top:4px" onclick="closeModal()">Schliessen</button>
    </div>
  </div>`);
}

function openAccountItemModal(prefill = null) {
  if (!editContext && prefill?.id) editContext = { type: 'account', id: prefill.id };
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Konto bearbeiten' : 'Konto hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Sparkonto Migros Bank" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Kontotyp</label>
        <select id="m-type" onchange="onAccountTypeChange()">
          ${Object.entries(ACCOUNT_TYPES).map(([k, t]) => `<option value="${k}" ${(prefill?.type || 'liquid') === k ? 'selected' : ''}>${accTypeIcon(k)} ${t.label}</option>`).join('')}
        </select>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Nur „Liquid“-Konten zählen für „Safe to spend“.</div>
      </div>
      <div class="field"><label id="m-balance-label">Aktueller Saldo (${state.currency})</label>
        <input id="m-balance" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.balance ?? ''}">
      </div>
      <div id="m-credit-wrap">
        <div style="display:flex;gap:8px">
          <div class="field" style="flex:1"><label>Abrechnungstag</label>
            <input id="m-stmt-day" type="number" inputmode="numeric" min="1" max="31" placeholder="z.B. 20" value="${prefill?.statementDay || ''}">
          </div>
          <div class="field" style="flex:1"><label>Zahlungsfrist (Tage)</label>
            <input id="m-term" type="number" inputmode="numeric" min="0" max="90" placeholder="20" value="${prefill?.paymentTermDays ?? ''}">
          </div>
        </div>
        <div class="field"><label>Limite (${state.currency})</label>
          <input id="m-limit" type="number" inputmode="decimal" step="any" placeholder="z.B. 5000" value="${prefill?.limit || ''}">
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveAccount()">Speichern</button>
      </div>
    </div>
  </div>`);
  onAccountTypeChange();
}

function onAccountTypeChange() {
  const credit = el('m-type')?.value === 'credit';
  el('m-credit-wrap').style.display = credit ? '' : 'none';
  el('m-balance-label').textContent = credit
    ? `Aktuell offener Betrag (${state.currency}, als Minus erfassen)`
    : `Aktueller Saldo (${state.currency})`;
}

function saveAccount() {
  const name    = el('m-name')?.value.trim();
  const type    = el('m-type')?.value;
  const balance = parseFloat(el('m-balance')?.value) || 0;
  if (!name) { toast('Bitte Bezeichnung eingeben'); return; }
  const data = { name, type, balance };
  if (type === 'credit') {
    const day = parseInt(el('m-stmt-day')?.value);
    if (!(day >= 1 && day <= 31)) { toast('Abrechnungstag (1–31) angeben'); return; }
    data.statementDay = day;
    data.paymentTermDays = Math.max(0, parseInt(el('m-term')?.value) || 20);
    data.limit = parseFloat(el('m-limit')?.value) || 0;
    // Karten-Buchungen erst ab jetzt zu Abrechnungen zusammenfassen (alte Käufe gelten als erledigt)
    if (balance > 0) data.balance = -balance;
  }
  if (editContext?.type === 'account') {
    const acc = state.accounts.find(x => x.id === editContext.id);
    if (type === 'credit' && !acc.trackingSince) data.trackingSince = localISO();
    Object.assign(acc, data);
  } else {
    state.accounts.push({ id: uid(), ...data, ...(type === 'credit' ? { trackingSince: localISO() } : {}) });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Überweisung ────────────────────────────────────────────────────────────
function openTransferModal() {
  if (state.accounts.length < 2) { toast('Mindestens 2 Konten für eine Überweisung nötig'); return; }
  const opts = state.accounts.map(a => `<option value="${a.id}">${esc(a.name)} (${fmt(a.balance)})</option>`).join('');
  const opts2 = state.accounts.map((a, i) => `<option value="${a.id}" ${i === 1 ? 'selected' : ''}>${esc(a.name)} (${fmt(a.balance)})</option>`).join('');
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">↔ Überweisung zwischen Konten</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:14px">Verschiebe Geld zwischen deinen Konten. Keine echte Banküberweisung.</div>
      <div class="field"><label>Von Konto</label><select id="m-from">${opts}</select></div>
      <div class="field"><label>Auf Konto</label><select id="m-to">${opts2}</select></div>
      <div class="field"><label>Betrag (${state.currency})</label>
        <input id="m-transfer-amount" type="number" inputmode="decimal" step="any" placeholder="0">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="executeTransfer()">Überweisen ✓</button>
      </div>
    </div>
  </div>`);
}

function executeTransfer() {
  const fromId = el('m-from')?.value;
  const toId   = el('m-to')?.value;
  const amount = parseFloat(el('m-transfer-amount')?.value) || 0;
  if (fromId === toId) { toast('Gleiche Konten gewählt'); return; }
  if (amount <= 0)     { toast('Betrag angeben'); return; }
  const from = state.accounts.find(a => a.id === fromId);
  const to   = state.accounts.find(a => a.id === toId);
  if (!from || !to) return;
  from.balance -= amount;
  to.balance   += amount;
  saveState();
  closeModal();
  toast(`${fmt(amount)} von "${from.name}" → "${to.name}" ✓`);
  refreshCurrent();
}

// ── Einkommen Modal ────────────────────────────────────────────────────────
function openIncomeModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Einnahme bearbeiten' : 'Einnahme hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Gehalt" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Betrag pro Monat (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.amount || ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${INCOME_CATS.map(c =>
            `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Zahltag (Tag im Monat, optional)</label>
        <input id="m-due" type="number" inputmode="numeric" min="1" max="31" placeholder="z.B. 25" value="${prefill?.dueDay || ''}">
      </div>
      <div class="field"><label>Notiz (optional)</label>
        <input id="m-note" type="text" value="${esc(prefill?.note)}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveIncome()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveIncome() {
  const name = el('m-name')?.value.trim(), amount = parseFloat(el('m-amount')?.value);
  const category = el('m-cat')?.value, note = el('m-note')?.value.trim();
  const dueDay = readDueDay('m-due');
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) { Object.assign(state.income.find(x => x.id === editContext.id), { name, amount, category, note, dueDay }); }
  else { state.income.push({ id: uid(), name, amount, category, note, dueDay }); }
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Ausgaben Modal ─────────────────────────────────────────────────────────
const EXPENSE_CATS = ['Wohnen','Lebensmittel','Transport','Unterhaltung','Gesundheit',
                      'Versicherungen','Kleidung','Bildung','Haustiere','Freizeit','Ausgabe'];

function openExpenseModal(prefill = null) {
  const freq = prefill?.frequency || 'monthly';
  // Neue jährliche/halbjährliche Ausgaben: Rückstellung standardmässig an
  const reserveDefault = prefill ? !!prefill.reserve : null;
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Ausgabe bearbeiten' : 'Ausgabe hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Miete, Autoversicherung" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${EXPENSE_CATS.map(c => `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Rhythmus</label>
        <select id="m-freq" onchange="onExpenseFreqChange()">
          ${Object.entries(CYCLE_LABEL).map(([k, l]) => `<option value="${k}" ${freq === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label id="m-amount-label">Betrag (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.amount || ''}" oninput="updateExpenseAmountLabel()">
        <div id="m-amount-hint" style="font-size:12px;color:var(--text2);margin-top:4px"></div>
      </div>
      <div class="field" id="m-due-wrap"><label>Fällig am Tag (optional)</label>
        <input id="m-due" type="number" inputmode="numeric" min="1" max="31" placeholder="z.B. 1" value="${prefill?.dueDay || ''}">
      </div>
      <div id="m-irregular-wrap">
        <div class="field"><label>Nächste Fälligkeit</label>
          <input id="m-next-due" type="date" value="${prefill?.nextDue || ''}" oninput="updateExpenseAmountLabel()">
        </div>
        <label class="check-row">
          <input id="m-reserve" type="checkbox" ${reserveDefault ? 'checked' : ''} data-touched="${prefill ? '1' : ''}"
                 onchange="this.dataset.touched='1';updateExpenseAmountLabel()">
          <span><strong>Rückstellung bilden</strong><br><span style="font-size:12px;color:var(--text2)">Jeden Monat einen Teil zurücklegen, damit der Betrag bei Fälligkeit bereit ist</span></span>
        </label>
        <div id="m-reserve-wrap">
          <div class="field"><label>Bereits zurückgelegt (${state.currency})</label>
            <input id="m-reserve-saved" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.reserveSaved || ''}" oninput="updateExpenseAmountLabel()">
          </div>
          ${state.accounts.length ? `
          <div class="field"><label>Liegt auf Konto (optional)</label>
            <select id="m-reserve-account">${accountOptions(prefill?.reserveAccountId)}</select>
          </div>` : ''}
          <div id="m-reserve-hint" class="reserve-hint"></div>
        </div>
      </div>
      <div class="field"><label>Budget-Limit/Monat (${state.currency}, optional)</label>
        <input id="m-limit" type="number" inputmode="decimal" step="any" placeholder="0 = kein Limit" value="${prefill?.budgetLimit || ''}">
      </div>
      <div class="field"><label>Notiz (optional)</label>
        <input id="m-note" type="text" value="${esc(prefill?.note)}">
      </div>
      ${EXPENSE_MODAL_EXTRAS.map(x => x.html(prefill)).join('')}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveExpense()">Speichern</button>
      </div>
    </div>
  </div>`);
  onExpenseFreqChange();
  EXPENSE_MODAL_EXTRAS.forEach(x => x.mounted?.(prefill));
}

function onExpenseFreqChange() {
  const freq = el('m-freq')?.value;
  const cb = el('m-reserve');
  // Standard (solange nicht selbst angeklickt): an bei jährlich/halbjährlich
  if (cb && !cb.dataset.touched) cb.checked = freq === 'yearly' || freq === 'semiannual';
  updateExpenseAmountLabel();
}

// Formularwerte als (vorläufige) Ausgabe lesen – für Live-Vorschau und Speichern
function readExpenseForm() {
  const frequency = el('m-freq')?.value || 'monthly';
  const irregular = frequency !== 'monthly';
  return {
    frequency,
    amount: parseFloat(el('m-amount')?.value) || 0,
    nextDue: irregular ? (el('m-next-due')?.value || null) : null,
    reserve: irregular && !!el('m-reserve')?.checked,
    reserveSaved: irregular ? Math.max(0, parseFloat(el('m-reserve-saved')?.value) || 0) : 0,
    reserveAccountId: irregular ? (el('m-reserve-account')?.value || null) : null
  };
}

function updateExpenseAmountLabel() {
  const hint = el('m-amount-hint'), label = el('m-amount-label');
  if (!hint || !label) return;
  const f = readExpenseForm();
  const irregular = f.frequency !== 'monthly';
  el('m-irregular-wrap').style.display = irregular ? '' : 'none';
  el('m-due-wrap').style.display = irregular ? 'none' : '';
  el('m-reserve-wrap').style.display = f.reserve ? '' : 'none';
  if (!irregular) {
    label.textContent = `Betrag pro Monat (${state.currency})`;
    hint.textContent = '';
    return;
  }
  label.textContent = `Betrag pro Zahlung (${state.currency})`;
  hint.textContent = f.amount > 0 ? `= ${fmtExact(round2(f.amount / CYCLE_MONTHS[f.frequency]))} pro Monat im Durchschnitt` : `Wird pro ${CYCLE_UNIT[f.frequency]} bezahlt`;
  const rh = el('m-reserve-hint');
  if (!f.reserve) { rh.innerHTML = ''; return; }
  if (!f.nextDue || f.amount <= 0) { rh.innerHTML = 'Gib Betrag und nächste Fälligkeit an, um die Monatsrate zu berechnen.'; return; }
  const info = reserveInfo(f);
  rh.innerHTML = `Monatliche Rückstellung: <strong>${fmtExact(round2(info.rate))}</strong>` +
    (info.catchUp ? ` <span style="color:var(--orange)">(Nachholbedarf – normal ${fmtExact(round2(info.normal))})</span>` : '') +
    `<br>Soll-Stand heute: ${fmtExact(round2(info.soll))} · fällig in ${info.days} Tagen`;
}

const round2 = n => Math.round(n * 100) / 100;

function saveExpense() {
  const name        = el('m-name')?.value.trim();
  const amount      = parseFloat(el('m-amount')?.value);
  const category    = el('m-cat')?.value;
  const budgetLimit = parseFloat(el('m-limit')?.value) || 0;
  const note        = el('m-note')?.value.trim();
  const f           = readExpenseForm();
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (f.reserve && !f.nextDue) { toast('Für die Rückstellung die nächste Fälligkeit angeben'); return; }
  const irregular = f.frequency !== 'monthly';
  // Bei nicht-monatlichen Ausgaben bestimmt das Fälligkeitsdatum den Tag (verhindert "Wandern" beim Weiterschalten)
  const dueDay = irregular ? (f.nextDue ? parseISO(f.nextDue).getDate() : null) : readDueDay('m-due');
  const data = { name, amount, category, budgetLimit, note, dueDay, dueMonth: null, ...f };
  const existing = editContext && state.expenses.find(x => x.id === editContext.id);
  for (const x of EXPENSE_MODAL_EXTRAS) if (x.read(data, existing) === false) return;
  let item = existing;
  if (existing) Object.assign(existing, data);
  else { item = { id: uid(), ...data }; state.expenses.push(item); }
  EXPENSE_MODAL_EXTRAS.forEach(x => x.after?.(item));
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Einmalige Buchung Modal ────────────────────────────────────────────────
const INCOME_CATS = ['Lohn','Nebeneinkommen','Sonstiges'];

function txCategoryOptions(type, selected) {
  const cats = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  return cats.map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('');
}

function updateTxCategories() {
  const type = el('m-tx-type')?.value;
  el('m-cat').innerHTML = txCategoryOptions(type, type === 'income' ? 'Sonstiges' : 'Ausgabe');
}

function accountOptions(selectedId) {
  return `<option value="">— Kein Konto —</option>` + state.accounts.map(a =>
    `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${accTypeIcon(a.type)} ${esc(a.name)} (${fmt(a.balance)})</option>`).join('');
}

function openTransactionModal(prefill = null) {
  const type = prefill?.type || 'expense';
  // Neue Buchung im gerade angezeigten Monat vorbelegen (heute, falls aktueller Monat)
  const date = prefill?.date || (txMonth === periodKeyOf() ? localISO() : periodRange(txMonth).start);
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill?.id ? '✏️ Buchung bearbeiten' : '📝 Buchung erfassen'}</div>
      <div class="field"><label>Typ</label>
        <select id="m-tx-type" onchange="updateTxCategories()">
          <option value="expense" ${type === 'expense' ? 'selected' : ''}>💸 Ausgabe</option>
          <option value="income"  ${type === 'income'  ? 'selected' : ''}>💰 Einnahme</option>
        </select>
      </div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Wocheneinkauf, Zahnarzt, Bonus" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Betrag (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.amount ?? ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">${txCategoryOptions(type, prefill?.category || (type === 'income' ? 'Sonstiges' : 'Ausgabe'))}</select>
      </div>
      <div class="field"><label>Datum</label>
        <input id="m-date" type="date" value="${date}">
      </div>
      ${state.accounts.length ? `
      <div class="field"><label>Zahlungsmittel (optional – Saldo wird angepasst)</label>
        <select id="m-account">${accountOptions(prefill?.accountId)}</select>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Kreditkarte wählen: zählt am Kaufdatum, bezahlt wird mit der Monatsabrechnung.</div>
      </div>` : ''}
      <div class="field"><label>Notiz (optional)</label>
        <input id="m-note" type="text" value="${esc(prefill?.note)}">
      </div>
      ${TX_MODAL_EXTRAS.map(x => x.html(prefill)).join('')}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveTransaction()">Speichern</button>
      </div>
    </div>
  </div>`);
  TX_MODAL_EXTRAS.forEach(x => x.mounted?.(prefill));
}

function saveTransaction() {
  const name = el('m-name')?.value.trim(), type = el('m-tx-type')?.value;
  const amount = parseFloat(el('m-amount')?.value), category = el('m-cat')?.value;
  const date = el('m-date')?.value || localISO(), note = el('m-note')?.value.trim();
  const accountId = el('m-account')?.value || null;
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (!state.transactions) state.transactions = [];
  const data = { name, type, amount, category, date, note, accountId };
  const existing = editContext?.type === 'transaction' && state.transactions.find(x => x.id === editContext.id);
  for (const x of TX_MODAL_EXTRAS) if (x.read(data, existing) === false) return;
  let tx;
  if (existing) {
    applyTxToAccount(existing, -1);
    Object.assign(existing, data);
    applyTxToAccount(existing, +1);
    tx = existing;
  } else {
    tx = { id: uid(), ...data };
    state.transactions.push(tx);
    applyTxToAccount(tx, +1);
  }
  txMonth = periodKeyOf(parseISO(date)); // zum Budgetmonat der Buchung springen
  TX_MODAL_EXTRAS.forEach(x => x.after?.(tx));
  saveState(); closeModal(); toast('Buchung gespeichert ✓');
  refreshCurrent();
}

// ── Investitions-Modal ─────────────────────────────────────────────────────
const INVEST_CATS = ['ETF','Aktien','Krypto','Obligationen','Säule3a','Investition'];

function openInvestmentModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Investition bearbeiten' : 'Investition hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. MSCI World ETF" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Monatlicher Betrag (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.amount || ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${INVEST_CATS.map(c => `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Erwartete Rendite p.a. (%)</label>
        <input id="m-return" type="number" inputmode="decimal" step="any" placeholder="6" min="0" max="50" value="${prefill?.returnRate ?? 6}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveInvestment()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveInvestment() {
  const name = el('m-name')?.value.trim(), amount = parseFloat(el('m-amount')?.value);
  const category = el('m-cat')?.value, returnRate = parseFloat(el('m-return')?.value) || 6;
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) { Object.assign(state.investments.find(x => x.id === editContext.id), { name, amount, category, returnRate }); }
  else { state.investments.push({ id: uid(), name, amount, category, returnRate }); }
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Depotwert Modal ────────────────────────────────────────────────────────
function openPortfolioModal() {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">Aktueller Depotwert</div>
      <div class="field"><label>Gesamtwert deines Portfolios (${state.currency})</label>
        <input id="m-portfolio" type="number" inputmode="decimal" step="any" placeholder="0" value="${state.portfolioValue || ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Den Wert findest du in deiner Broker-App oder im e-Banking.</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="savePortfolioValue()">Speichern</button>
      </div>
    </div>
  </div>`);
  setTimeout(() => el('m-portfolio')?.select(), 80);
}

function savePortfolioValue() {
  state.portfolioValue = parseFloat(el('m-portfolio')?.value) || 0;
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Schulden-Modal ─────────────────────────────────────────────────────────
const DEBT_CATS = ['Kredit','Hypothek','Auto-Leasing','Studentenkredit','Kreditkarte','Schulden'];

function openDebtModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Schuld bearbeiten' : 'Schuld hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Autokredit" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${DEBT_CATS.map(c => `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Restschuld (${state.currency})</label>
        <input id="m-remaining" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.remainingAmount ?? ''}">
      </div>
      <div class="field"><label>Ursprünglicher Kreditbetrag (${state.currency})</label>
        <input id="m-original" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.originalAmount ?? ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Für Fortschrittsanzeige (optional)</div>
      </div>
      <div class="field"><label>Monatliche Rate (${state.currency})</label>
        <input id="m-payment" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.monthlyPayment ?? ''}">
      </div>
      <div class="field"><label>Zinssatz pro Jahr (%)</label>
        <input id="m-rate" type="number" inputmode="decimal" step="any" placeholder="0" min="0" value="${prefill?.interestRate ?? ''}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveDebt()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveDebt() {
  const name            = el('m-name')?.value.trim(), category = el('m-cat')?.value;
  const remainingAmount = parseFloat(el('m-remaining')?.value) || 0;
  const originalAmount  = parseFloat(el('m-original')?.value) || remainingAmount;
  const monthlyPayment  = parseFloat(el('m-payment')?.value) || 0;
  const interestRate    = parseFloat(el('m-rate')?.value) || 0;
  if (!name || remainingAmount <= 0) { toast('Name und Restschuld angeben'); return; }
  if (editContext) {
    Object.assign(state.debts.find(x => x.id === editContext.id), { name, category, remainingAmount, originalAmount, monthlyPayment, interestRate });
  } else {
    state.debts.push({ id: uid(), name, category, remainingAmount, originalAmount, monthlyPayment, interestRate });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Tilgungsstrategie Modal ────────────────────────────────────────────────
function openDebtStrategyModal() {
  if (!state.debts.length) { toast('Keine Schulden erfasst'); return; }
  const extra = Math.max(0, monthlySavings());
  const avalanche = simulateDebtPayoff([...state.debts].sort((a, b) => b.interestRate - a.interestRate), extra);
  const snowball  = simulateDebtPayoff([...state.debts].sort((a, b) => a.remainingAmount - b.remainingAmount), extra);
  const saved = snowball.totalInterest - avalanche.totalInterest;

  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">⚡ Tilgungsstrategie-Vergleich</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:14px">
        Extrabudget: <strong style="color:var(--text)">${fmt(extra)}/Mt.</strong>
        (freier Cashflow nach Ausgaben & Investitionen)
      </div>
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi-item" style="border:1px solid rgba(16,185,129,.3)">
          <div class="kpi-label">🏔 Avalanche</div>
          <div class="kpi-value green">${formatETA(avalanche.months)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:3px">Zinsen: ${fmt(avalanche.totalInterest)}</div>
        </div>
        <div class="kpi-item" style="border:1px solid rgba(99,102,241,.3)">
          <div class="kpi-label">⛄ Snowball</div>
          <div class="kpi-value" style="color:var(--primary-light)">${formatETA(snowball.months)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:3px">Zinsen: ${fmt(snowball.totalInterest)}</div>
        </div>
      </div>
      <div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:var(--radius-sm);padding:12px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">💡 Empfehlung: Avalanche</div>
        <div style="font-size:12px;color:var(--text2)">
          Höchsten Zinssatz zuerst tilgen spart
          <strong style="color:var(--green)">${fmt(Math.max(0, saved))}</strong> an Zinskosten gegenüber der Snowball-Methode.
        </div>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Reihenfolge Avalanche (höchster Zins zuerst)</div>
      ${[...state.debts].sort((a, b) => b.interestRate - a.interestRate).map((d, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px">
          <div style="width:24px;height:24px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${i+1}</div>
          <span style="flex:1">${esc(d.name)}</span>
          <span style="color:var(--red);font-weight:600">${d.interestRate}% Zins</span>
          <span style="color:var(--text2);font-size:11px">${fmt(d.remainingAmount)}</span>
        </div>`).join('')}
      <button class="btn btn-ghost btn-full" style="margin-top:6px" onclick="closeModal()">Schliessen</button>
    </div>
  </div>`);
}

// ── Steuer-Rechner Modal ───────────────────────────────────────────────────
let _lastTax = null;

function openTaxCalculator() {
  const grossAnnual = Math.round(totalIncome() * 12);
  const canton = state.settings.taxCanton || 'ZH';
  const cantonOpts = Object.entries(CANTON_RATES)
    .map(([k]) => `<option value="${k}" ${k === canton ? 'selected' : ''}>${k}</option>`).join('');

  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🧾 Steuer-Schätzung (CH)</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.5">
        Vereinfachte Schätzung auf Basis effektiver Durchschnittssätze (inkl. Kantons- und Gemeindesteuer).
        Ohne Gewähr – für exakte Zahlen bitte Steuerberater kontaktieren.
      </div>
      <div class="field"><label>Brutto-Einkommen pro Jahr (${state.currency})</label>
        <input id="m-gross" type="number" inputmode="decimal" step="any" value="${grossAnnual}" oninput="updateTaxPreview()">
      </div>
      <div class="field"><label>Kanton</label>
        <select id="m-canton" onchange="updateTaxPreview()">${cantonOpts}</select>
      </div>
      <div id="tax-preview" style="margin:12px 0"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Schliessen</button>
        <button class="btn btn-primary" onclick="applyTaxEstimate()">Speichern & Anzeigen</button>
      </div>
    </div>
  </div>`);
  setTimeout(updateTaxPreview, 0);
}

function updateTaxPreview() {
  const gross  = parseFloat(el('m-gross')?.value) || 0;
  const canton = el('m-canton')?.value || 'ZH';
  const preview = el('tax-preview');
  if (!preview) return;
  if (!gross) { preview.innerHTML = ''; return; }
  _lastTax = { ...estimateTax(gross, canton), canton };
  preview.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:8px">
      <div class="kpi-item"><div class="kpi-label">Steuern/Jahr</div><div class="kpi-value red">${fmt(_lastTax.yearly)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Steuern/Monat</div><div class="kpi-value red">${fmt(_lastTax.monthly)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Netto/Jahr</div><div class="kpi-value green">${fmt(_lastTax.netto)}</div></div>
      <div class="kpi-item"><div class="kpi-label">Netto/Monat</div><div class="kpi-value green">${fmt(_lastTax.nettoMonthly)}</div></div>
    </div>
    <div style="font-size:12px;color:var(--text2)">Eff. Steuersatz: ~${_lastTax.rate.toFixed(0)}% · Kanton ${canton}</div>`;
}

function applyTaxEstimate() {
  if (!_lastTax) { toast('Zuerst berechnen'); return; }
  state.settings.taxEstimate = _lastTax;
  state.settings.taxCanton   = _lastTax.canton;
  saveState(); closeModal(); toast('Steuer-Schätzung gespeichert ✓');
  refreshCurrent();
}

// ── Sparziel-Modal ─────────────────────────────────────────────────────────
const GOAL_ICONS = ['🎯','🚗','🏠','✈️','💻','📱','👶','💍','🎓','🏖️','🛥️','⌚','🎸','🐕','🌍'];

function openGoalModal(prefill = null) {
  const sel = prefill?.icon || '🎯';
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Ziel bearbeiten' : 'Sparziel festlegen'}</div>
      <div class="field"><label>Icon</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
          ${GOAL_ICONS.map(ic =>
            `<button type="button" class="btn btn-ghost icon-pick${ic === sel ? ' icon-sel' : ''}" onclick="pickGoalIcon(this,'${ic}')">${ic}</button>`
          ).join('')}
        </div>
        <input type="hidden" id="m-icon" value="${sel}">
      </div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Traumurlaub" value="${esc(prefill?.name)}">
      </div>
      <div class="field"><label>Zielbetrag (${state.currency})</label>
        <input id="m-target" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.targetAmount || ''}">
      </div>
      <div class="field"><label>Bereits gespart (${state.currency})</label>
        <input id="m-current" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.currentAmount || 0}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveGoal()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function openGoalDepositModal(goalId) {
  const g = state.goals.find(x => x.id === goalId);
  if (!g) return;
  const rem = Math.max(0, g.targetAmount - g.currentAmount);
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${g.icon || '🎯'} In „${esc(g.name)}“ einzahlen</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:12px">Noch ${fmt(rem)} bis zum Ziel</div>
      <div class="field"><label>Betrag (${state.currency})</label>
        <input id="m-deposit" type="number" inputmode="decimal" step="any" placeholder="0">
      </div>
      ${state.accounts.length ? `
      <div class="field"><label>Von Konto abbuchen (optional)</label>
        <select id="m-account">${accountOptions(null)}</select>
      </div>` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveGoalDeposit('${g.id}')">Einzahlen ✓</button>
      </div>
    </div>
  </div>`);
}

function saveGoalDeposit(goalId) {
  const g = state.goals.find(x => x.id === goalId);
  const amount = parseFloat(el('m-deposit')?.value);
  if (!g || isNaN(amount) || amount === 0) { toast('Betrag angeben'); return; }
  const accId = el('m-account')?.value;
  const acc = accId && state.accounts.find(a => a.id === accId);
  if (acc) acc.balance -= amount;
  const wasDone = g.currentAmount >= g.targetAmount;
  g.currentAmount = Math.max(0, g.currentAmount + amount);
  saveState(); closeModal();
  toast(!wasDone && g.currentAmount >= g.targetAmount ? `🎉 Ziel „${g.name}“ erreicht!` : `${fmt(amount)} eingezahlt ✓`);
  refreshCurrent();
}

function pickGoalIcon(btn, icon) {
  document.querySelectorAll('.icon-pick').forEach(b => b.classList.remove('icon-sel'));
  btn.classList.add('icon-sel');
  el('m-icon').value = icon;
}

function saveGoal() {
  const name = el('m-name')?.value.trim(), targetAmount = parseFloat(el('m-target')?.value);
  const currentAmount = parseFloat(el('m-current')?.value) || 0, icon = el('m-icon')?.value || '🎯';
  if (!name || isNaN(targetAmount) || targetAmount <= 0) { toast('Name und Zielbetrag angeben'); return; }
  if (editContext) { Object.assign(state.goals.find(x => x.id === editContext.id), { name, targetAmount, currentAmount, icon }); }
  else { state.goals.push({ id: uid(), name, targetAmount, currentAmount, icon }); }
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── FIRE-Einstellungen ─────────────────────────────────────────────────────
function openFIRESettings() {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🔥 FIRE-Einstellungen</div>
      <div class="field"><label>Monatliche Ausgaben im Ruhestand (${state.currency})</label>
        <input id="m-fire-exp" type="number" inputmode="decimal" step="any" placeholder="${totalExpenses()}" value="${state.settings.fireMonthlyExpenses || ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Leer = aktuelle Ausgaben (${fmt(totalExpenses())})</div>
      </div>
      <div class="field"><label>Entnahmerate (%)</label>
        <input id="m-fire-rate" type="number" inputmode="decimal" step="0.5" min="1" max="10" value="${state.settings.fireWithdrawalRate}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Standard: 4% (Trinity-Studie)</div>
      </div>
      <div class="field"><label>Inflationsrate (%)</label>
        <input id="m-inflation" type="number" inputmode="decimal" step="0.5" min="0" max="20" value="${state.settings.inflationRate}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Für Kaufkraft-Rechner & Realmodus</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveFIRESettings()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveFIRESettings() {
  state.settings.fireMonthlyExpenses = parseFloat(el('m-fire-exp')?.value) || 0;
  state.settings.fireWithdrawalRate  = parseFloat(el('m-fire-rate')?.value) || 4;
  state.settings.inflationRate       = parseFloat(el('m-inflation')?.value) || 2;
  saveState(); closeModal(); toast('Gespeichert ✓');
  refreshCurrent();
}

// ── Einstellungen ──────────────────────────────────────────────────────────
function openSettings() {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">⚙️ Einstellungen</div>
      <div class="field"><label>Währung</label>
        <select id="m-currency">
          ${['CHF','EUR','USD','GBP','JPY'].map(c => `<option ${state.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      ${SETTINGS_SECTIONS.map(sec => `
      <div style="height:1px;background:var(--border);margin:14px 0"></div>
      <div class="card-title" style="margin-bottom:10px">${sec.title}</div>
      ${sec.html()}`).join('')}
      <div style="height:1px;background:var(--border);margin:14px 0"></div>
      <div class="card-title" style="margin-bottom:10px">Sicherheit</div>
      <button class="btn btn-ghost btn-full" onclick="openPinSetup()">🔒 ${state.settings.pinHash ? 'PIN ändern / entfernen' : 'App-Sperre mit PIN einrichten'}</button>
      <div style="height:1px;background:var(--border);margin:14px 0"></div>
      <div class="card-title" style="margin-bottom:10px">Daten-Backup</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">Deine Daten liegen nur auf diesem Gerät. Letztes Backup: <strong style="color:var(--text)">${state.settings.lastBackup ? fmtDate(state.settings.lastBackup) : 'noch nie'}</strong></div>
      <button class="btn btn-ghost btn-full" onclick="exportData()">⬇️ Exportieren (JSON)</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="exportTransactionsCSV()">📊 Buchungen als CSV (Excel)</button>
      <div style="margin-top:8px">
        <label class="btn btn-ghost btn-full" style="cursor:pointer">
          ⬆️ Importieren (JSON)
          <input type="file" accept=".json" onchange="importData(event)" style="display:none">
        </label>
      </div>
      <div style="height:1px;background:var(--border);margin:14px 0"></div>
      <button class="btn btn-full" style="background:rgba(239,68,68,.15);color:var(--red)" onclick="resetData()">🗑️ Alle Daten löschen</button>
      <div class="modal-actions" style="margin-top:12px">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveSettings()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveSettings() {
  state.currency = el('m-currency')?.value || 'CHF';
  for (const sec of SETTINGS_SECTIONS) if (sec.save() === false) return;   // Validierungsfehler → offen lassen
  txMonth = periodKeyOf();
  saveState(); closeModal(); toast('Gespeichert ✓'); refreshCurrent();
}

async function exportData() {
  const payload = JSON.parse(JSON.stringify(state));
  for (const hook of EXPORT_HOOKS) { try { await hook(payload); } catch (err) { console.error(err); } }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `finanzplaner-backup-${localISO()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.settings.lastBackup = Date.now();
  state.settings.backupSnooze = 0;
  saveState(); toast('Backup gespeichert ✓');
  if (currentPage === 'uebersicht') renderBackupHint();
}

// ── Backup-Erinnerung ──────────────────────────────────────────────────────
function renderBackupHint() {
  const box = el('dash-backup-hint');
  if (!box) return;
  const items = state.accounts.length + state.income.length + state.expenses.length + (state.transactions || []).length + state.goals.length;
  const last = state.settings.lastBackup || 0;
  const due = items >= 5 && Date.now() - last > 30 * 864e5 && Date.now() > (state.settings.backupSnooze || 0);
  box.innerHTML = due ? `
    <div class="card backup-hint">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px">💾 Zeit für ein Backup</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">${last ? 'Dein letztes Backup ist über 30 Tage alt.' : 'Du hast noch nie ein Backup gemacht.'} Deine Daten liegen nur auf diesem Gerät – geht es verloren, sind sie weg.</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="exportData()">Jetzt sichern</button>
        <button class="btn btn-ghost" onclick="snoozeBackup()">Später</button>
      </div>
    </div>` : '';
}

function snoozeBackup() {
  state.settings.backupSnooze = Date.now() + 7 * 864e5;
  saveState(); renderBackupHint();
}

// ── Privatsphäre-Modus (Beträge verbergen) ─────────────────────────────────
function applyPrivacy() {
  document.body.classList.toggle('privacy', !!state.settings.privacy);
  const btn = el('privacy-btn');
  if (btn) { btn.textContent = state.settings.privacy ? '🙈' : '👁'; btn.setAttribute('aria-pressed', !!state.settings.privacy); }
}

function togglePrivacy() {
  state.settings.privacy = !state.settings.privacy;
  saveState(); applyPrivacy();
  toast(state.settings.privacy ? 'Beträge verborgen' : 'Beträge sichtbar');
}

// ── App-Sperre (PIN) ───────────────────────────────────────────────────────
// Hinweis: schützt vor neugierigen Blicken, verschlüsselt die Daten aber nicht.
async function hashPin(pin) {
  const data = new TextEncoder().encode('finanzplaner:' + pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function openPinSetup() {
  const has = !!state.settings.pinHash;
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🔒 App-Sperre</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.5">
        Die App fragt beim Öffnen und nach 1 Minute im Hintergrund nach der PIN.
        Schutz vor neugierigen Blicken – die Daten selbst werden nicht verschlüsselt.
      </div>
      <div class="field"><label>Neue PIN (4–8 Ziffern)</label>
        <input id="m-pin1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
      </div>
      <div class="field"><label>PIN wiederholen</label>
        <input id="m-pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
      </div>
      ${has ? `<button class="btn btn-danger btn-full" onclick="removePin()">PIN entfernen</button>` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="savePin()">PIN speichern</button>
      </div>
    </div>
  </div>`);
}

async function savePin() {
  const p1 = el('m-pin1').value, p2 = el('m-pin2').value;
  if (!/^\d{4,8}$/.test(p1)) { toast('PIN muss 4–8 Ziffern haben'); return; }
  if (p1 !== p2) { toast('PINs stimmen nicht überein'); return; }
  state.settings.pinHash = await hashPin(p1);
  state.settings.pinLength = p1.length;
  saveState(); closeModal(); toast('App-Sperre aktiviert 🔒');
}

function removePin() {
  if (!confirm('App-Sperre wirklich entfernen?')) return;
  state.settings.pinHash = null;
  state.settings.pinLength = null;
  saveState(); closeModal(); toast('App-Sperre entfernt');
}

let pinEntry = '';
let pinFails = 0;

function showLockScreen() {
  if (!state.settings.pinHash || el('lock-screen')) return;
  pinEntry = '';
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  document.body.insertAdjacentHTML('beforeend', `
  <div id="lock-screen" class="lock-screen" role="dialog" aria-label="App gesperrt">
    <div style="font-size:40px">🔒</div>
    <div style="font-size:18px;font-weight:700;margin-top:8px">FinanzPlaner</div>
    <div style="font-size:13px;color:var(--text2);margin-top:4px" id="lock-msg">PIN eingeben</div>
    <div class="pin-dots" id="pin-dots"></div>
    <div class="pin-pad">
      ${keys.map(k => k ? `<button class="pin-key" onclick="pinKey('${k}')">${k}</button>` : '<span></span>').join('')}
    </div>
  </div>`);
  document.body.classList.add('modal-open');
  updatePinDots();
}

function updatePinDots() {
  const dots = el('pin-dots');
  if (dots) dots.innerHTML = Array.from({ length: state.settings.pinLength || 4 }, (_, i) => `<span class="${i < pinEntry.length ? 'on' : ''}"></span>`).join('');
}

async function pinKey(k) {
  if (k === '⌫') pinEntry = pinEntry.slice(0, -1);
  else if (pinEntry.length < 8) pinEntry += k;
  updatePinDots();
  if (pinEntry.length < (state.settings.pinLength || 4)) return;
  if (await hashPin(pinEntry) === state.settings.pinHash) {
    pinFails = 0;
    el('lock-screen')?.remove();
    if (!el('modal-backdrop')) document.body.classList.remove('modal-open');
  } else {
    pinWrong();
  }
}

function pinWrong() {
  pinFails++;
  pinEntry = '';
  updatePinDots();
  const msg = el('lock-msg');
  if (msg) msg.textContent = 'Falsche PIN' + (pinFails >= 3 ? ' – vergessen? Daten nur per Backup wiederherstellbar' : '');
  el('pin-dots')?.classList.add('shake');
  setTimeout(() => el('pin-dots')?.classList.remove('shake'), 400);
}

function exportTransactionsCSV() {
  const txs = [...(state.transactions || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!txs.length) { toast('Keine Buchungen vorhanden'); return; }
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const accName = id => state.accounts.find(a => a.id === id)?.name || '';
  const rows = [['Datum', 'Typ', 'Bezeichnung', 'Kategorie', 'Betrag', 'Konto', 'Notiz']]
    .concat(txs.map(t => [t.date, t.type === 'income' ? 'Einnahme' : 'Ausgabe', t.name, t.category,
      (t.type === 'income' ? t.amount : -t.amount).toFixed(2), accName(t.accountId), t.note]));
  // Semikolon + BOM: öffnet direkt korrekt in Excel (CH/DE)
  const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `buchungen-${localISO()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV exportiert ✓');
}

function importData(e) {
  const file = e.target.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      for (const hook of IMPORT_HOOKS) await hook(parsed);
      state = migrateState(parsed); saveState(); closeModal(); applyPrivacy(); toast('Importiert ✓'); navigate('uebersicht');
    }
    catch (err) { console.error(err); toast('Fehler beim Importieren'); }
  };
  reader.readAsText(file);
}

function resetData() {
  if (!confirm('Wirklich alle Daten löschen? Nicht rückgängig machbar.')) return;
  state = migrateState(null); saveState(); closeModal(); applyPrivacy(); toast('Daten gelöscht'); navigate('uebersicht');
}

// ── Boot ───────────────────────────────────────────────────────────────────
function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (window.Chart) {
    Chart.defaults.animation.duration = isTouch ? 250 : 400;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  }
  applyPrivacy();
  showLockScreen();
  // Browser bitten, die Daten nicht automatisch zu löschen (wichtig v.a. auf iOS/Safari)
  navigator.storage?.persist?.().catch(() => {});
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 60e3) showLockScreen();
  });
  autoNetworthSnapshot();
  PAGE_HOOKS.boot.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
  const start = PAGES.includes(pageFromHash()) ? pageFromHash() : 'uebersicht';
  history.replaceState({ page: start }, '', '#' + start);
  navigate(start, { push: false });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  window.addEventListener('popstate', () => {
    if (ignoreNextPop) { ignoreNextPop = false; return; }
    if (el('modal-backdrop')) { removeModal(); return; }
    navigate(pageFromHash() || 'uebersicht', { push: false });
  });
}

// Erst starten, wenn alle (deferred) Skripte geladen sind – Erweiterungen registrieren sich vorher
if (document.readyState === 'complete') boot();
else document.addEventListener('DOMContentLoaded', boot);
