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
  settings: { inflationRate: 2, fireWithdrawalRate: 4, fireMonthlyExpenses: 0, taxEstimate: null, taxCanton: 'ZH' }
};

function migrateState(raw) {
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (typeof raw.balance === 'number' && !raw.accounts) {
    raw.accounts = raw.balance > 0
      ? [{ id: uid(), name: 'Girokonto', balance: raw.balance, type: 'checking' }]
      : [];
    delete raw.balance;
  }
  delete raw.portfolioHistory;
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
    ...raw,
    settings: { ...DEFAULT_STATE.settings, ...(raw.settings || {}) }
  };
}

const uid = () => Math.random().toString(36).slice(2, 9);

let state = (() => {
  try { return migrateState(JSON.parse(localStorage.getItem('finanzplaner'))); }
  catch { return migrateState(null); }
})();

let projectionChart = null;
let donutChartInst  = null;
let nwHistChartInst = null;
let editContext     = null;
let chartMode       = 'nominal';
let projectionYears = 10;

function saveState() { localStorage.setItem('finanzplaner', JSON.stringify(state)); }

// ── Formatierung ───────────────────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n) + ' ' + state.currency;
}
function fmtK(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M ' + state.currency;
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(0) + 'k ' + state.currency;
  return fmt(n);
}

// ── Berechnungen ───────────────────────────────────────────────────────────
const totalAccounts    = () => state.accounts.reduce((s, a) => s + a.balance, 0);
const totalIncome      = () => state.income.reduce((s, i) => s + i.amount, 0);
const monthlyAmt       = e => e.frequency === 'yearly' ? e.amount / 12 : e.amount;
const totalExpenses    = () => state.expenses.reduce((s, e) => s + monthlyAmt(e), 0);
const totalInvestments = () => state.investments.reduce((s, i) => s + i.amount, 0);
const totalDebtPay     = () => state.debts.reduce((s, d) => s + d.monthlyPayment, 0);
const totalDebt        = () => state.debts.reduce((s, d) => s + d.remainingAmount, 0);
const totalAssets      = () => totalAccounts() + state.portfolioValue;
const netWorth         = () => totalAssets() - totalDebt();
const monthlySavings   = () => totalIncome() - totalExpenses() - totalInvestments() - totalDebtPay();
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
  let p = state.portfolioValue;
  for (let m = 1; m <= 720; m++) { p = p * (1 + r) + totalInvestments(); if (p >= target) return m; }
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

function navigate(id) {
  PAGES.forEach(p => {
    document.getElementById('page-' + p).classList.toggle('active', p === id);
    document.getElementById('nav-'  + p).classList.toggle('active', p === id);
  });
  RENDERERS[id]?.();
}

function refreshCurrent() {
  const active = PAGES.find(p => document.getElementById('page-' + p).classList.contains('active'));
  if (active) navigate(active);
}

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
  el('dash-nw-breakdown').textContent = `Vermögen: ${fmtK(totalAssets())} · Schulden: ${fmtK(totalDebt())}`;
  el('dash-income').textContent       = fmt(income);
  el('dash-expenses').textContent     = fmt(exp + debtP);
  el('dash-investments').textContent  = fmt(invest);
  el('dash-savings').textContent      = fmt(savings);
  el('dash-savings').className = 'val ' + (savings >= 0 ? 'green' : 'red');

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
  if (!canvas || !legend) return;

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
    if (!canvas) return;
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
  if (!canvas) return;
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
  if (projectionChart) projectionChart.destroy();
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
        name: i.name, sub: i.category + (i.note ? ' · ' + i.note : ''),
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
  el('ausgaben-debt-row').innerHTML = dp > 0
    ? `<div class="info-row">🏦 Schuldentilgung <span>${fmt(dp)}/Mt.</span></div>` : '';

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
        const freqLabel = e.frequency === 'yearly'
          ? `<span class="freq-badge">Jährlich</span>`
          : '';
        return `
        <div class="list-item${over ? ' item-over' : ''}">
          <div class="item-left">
            <div class="item-icon" style="background:${colorFor(e.category)}22">${iconFor(e.category)}</div>
            <div style="min-width:0">
              <div class="item-name">${e.name} ${freqLabel}</div>
              <div class="item-sub">${e.category} · ${pct}% Einkomm.${hasLim ? ' · Limit ' + fmt(e.budgetLimit) : ''}</div>
              ${hasLim ? `<div class="budget-bar"><div class="budget-fill ${bCls}" style="width:${bpct}%"></div></div>` : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <div style="text-align:right">
              <div class="item-amount" style="color:var(--red)">${fmt(m)}</div>
              ${e.frequency === 'yearly' ? `<div style="font-size:10px;color:var(--text2)">${fmt(e.amount)}/Jahr</div>` : ''}
            </div>
            <div class="item-actions">
              <button class="btn btn-ghost btn-icon" onclick="openEdit('expense','${e.id}')">✏️</button>
              <button class="btn btn-danger btn-icon" onclick="deleteItem('expense','${e.id}')">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('')
    : emptyState('💸', 'Noch keine Ausgaben erfasst.');

  renderTransactions();
};

function renderTransactions() {
  const list = el('transactions-list');
  if (!list) return;
  const txs = state.transactions || [];
  if (!txs.length) { list.innerHTML = emptyState('📒', 'Noch keine einmaligen Buchungen.'); return; }
  const sorted = [...txs].sort((a, b) => b.date.localeCompare(a.date));
  list.innerHTML = sorted.map(t => `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:rgba(100,116,139,.15)">${t.type === 'income' ? '💰' : '💸'}</div>
        <div style="min-width:0">
          <div class="item-name">${t.name}</div>
          <div class="item-sub">${t.category || '–'} · ${new Date(t.date).toLocaleDateString('de-CH')}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="item-amount" style="color:${t.type === 'income' ? 'var(--green)' : 'var(--red)'}">
          ${t.type === 'income' ? '+' : '-'}${fmt(t.amount)}
        </span>
        <div class="item-actions">
          <button class="btn btn-danger btn-icon" onclick="deleteItem('transaction','${t.id}')">🗑️</button>
        </div>
      </div>
    </div>`).join('');
}

// ── Vermögen (Investitionen + Schulden) ────────────────────────────────────
RENDERERS.vermoegen = function renderVermoegen() {
  renderAccountsInVermoegen();
  renderVermoegenSummary();
  renderInvestSection();
  renderDebtSection();
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
        name: i.name, sub: i.category + ' · Ø ' + (i.returnRate || 6) + '% p.a.',
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
            <div class="strat-target">${byInterest.name} · ${byInterest.interestRate}% p.a.</div>
          </div>
        </div>
        <div class="strat-item">
          <div class="strat-icon">❄️</div>
          <div>
            <div class="strat-label">Snowball</div>
            <div class="strat-desc">Kleinste Schuld zuerst → motivierender</div>
            <div class="strat-target">${byAmount.name} · ${fmtK(byAmount.remainingAmount)}</div>
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
  if (!state.debts.length) {
    dlist.innerHTML = emptyState('🏦', 'Keine Schulden – sehr gut!');
    return;
  }
  if (strat) strat.style.display = 'block';

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
          <div class="item-name">${d.name}</div>
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
  const typeLabel = { checking:'Girokonto', savings:'Sparkonto', depot:'Depot', other:'Sonstiges' };
  const typeIcon  = { checking:'💳', savings:'🏦', depot:'📈', other:'💰' };
  container.innerHTML = state.accounts.map(a => `
    <div class="list-item" style="margin-bottom:8px">
      <div class="item-left">
        <div class="item-icon" style="background:rgba(99,102,241,.15)">${typeIcon[a.type] || '💳'}</div>
        <div>
          <div class="item-name">${a.name}</div>
          <div class="item-sub">${typeLabel[a.type] || a.type}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="item-amount" style="color:${a.balance >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(a.balance)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('account','${a.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('account','${a.id}');RENDERERS.vermoegen();RENDERERS.uebersicht()">🗑️</button>
        </div>
      </div>
    </div>`).join('');
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
          <div style="font-size:16px;font-weight:700">${g.icon || '🎯'} ${g.name}</div>
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
          <div style="font-size:16px;font-weight:700">${g.icon || '🎯'} ${g.name}</div>
          <div style="font-size:13px;color:var(--text2);margin-top:2px">${fmt(g.currentAmount)} von ${fmt(g.targetAmount)}</div>
        </div>
        <div style="display:flex;gap:5px">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('goal','${g.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('goal','${g.id}')">🗑️</button>
        </div>
      </div>

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
  state[key] = state[key].filter(x => x.id !== id);
  saveState(); toast('Gelöscht'); refreshCurrent();
}

// ── Modal-Basis ────────────────────────────────────────────────────────────
function closeModal() { el('modal-backdrop')?.remove(); editContext = null; }
function handleBackdropClick(e) { if (e.target.id === 'modal-backdrop') closeModal(); }

function showModal(html) {
  el('modal-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => document.querySelector('.modal input, .modal select')?.focus(), 50);
}

function openEdit(type, id) {
  const lists = { income:'income', expense:'expenses', investment:'investments', debt:'debts', goal:'goals', account:'accounts' };
  const item = state[lists[type]]?.find(x => x.id === id);
  if (!item) return;
  editContext = { type, id };
  ({ income: openIncomeModal, expense: openExpenseModal, investment: openInvestmentModal,
     debt: openDebtModal, goal: openGoalModal, account: openAccountItemModal })[type]?.(item);
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
                  ${{ checking:'💳', savings:'🏦', depot:'📈', other:'💰' }[a.type] || '💳'}
                </div>
                <div>
                  <div class="item-name">${a.name}</div>
                  <div class="item-sub">${{ checking:'Girokonto', savings:'Sparkonto', depot:'Depot', other:'Sonstiges' }[a.type] || a.type}</div>
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
        <input id="m-name" type="text" placeholder="z.B. Sparkonto Migros Bank" value="${prefill?.name || ''}">
      </div>
      <div class="field"><label>Kontotyp</label>
        <select id="m-type">
          <option value="checking" ${prefill?.type === 'checking' ? 'selected' : ''}>💳 Girokonto</option>
          <option value="savings"  ${prefill?.type === 'savings'  ? 'selected' : ''}>🏦 Sparkonto</option>
          <option value="depot"    ${prefill?.type === 'depot'    ? 'selected' : ''}>📈 Depot</option>
          <option value="other"    ${prefill?.type === 'other'    ? 'selected' : ''}>💰 Sonstiges</option>
        </select>
      </div>
      <div class="field"><label>Aktueller Saldo (${state.currency})</label>
        <input id="m-balance" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.balance ?? ''}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveAccount()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveAccount() {
  const name    = el('m-name')?.value.trim();
  const type    = el('m-type')?.value;
  const balance = parseFloat(el('m-balance')?.value) || 0;
  if (!name) { toast('Bitte Bezeichnung eingeben'); return; }
  if (editContext?.type === 'account') {
    Object.assign(state.accounts.find(x => x.id === editContext.id), { name, type, balance });
  } else {
    state.accounts.push({ id: uid(), name, type, balance });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  RENDERERS.uebersicht(); RENDERERS.vermoegen?.();
}

// ── Überweisung ────────────────────────────────────────────────────────────
function openTransferModal() {
  if (state.accounts.length < 2) { toast('Mindestens 2 Konten für eine Überweisung nötig'); return; }
  const opts = state.accounts.map(a => `<option value="${a.id}">${a.name} (${fmt(a.balance)})</option>`).join('');
  const opts2 = state.accounts.map((a, i) => `<option value="${a.id}" ${i === 1 ? 'selected' : ''}>${a.name} (${fmt(a.balance)})</option>`).join('');
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
  RENDERERS.vermoegen(); RENDERERS.uebersicht();
}

// ── Einkommen Modal ────────────────────────────────────────────────────────
function openIncomeModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Einnahme bearbeiten' : 'Einnahme hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Gehalt" value="${prefill?.name || ''}">
      </div>
      <div class="field"><label>Betrag pro Monat (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.amount || ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${['Lohn','Nebeneinkommen','Sonstiges'].map(c =>
            `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Notiz (optional)</label>
        <input id="m-note" type="text" value="${prefill?.note || ''}">
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
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) { Object.assign(state.income.find(x => x.id === editContext.id), { name, amount, category, note }); }
  else { state.income.push({ id: uid(), name, amount, category, note }); }
  saveState(); closeModal(); toast('Gespeichert ✓');
  RENDERERS.einkommen(); RENDERERS.uebersicht();
}

// ── Ausgaben Modal ─────────────────────────────────────────────────────────
const EXPENSE_CATS = ['Wohnen','Lebensmittel','Transport','Unterhaltung','Gesundheit',
                      'Versicherungen','Kleidung','Bildung','Haustiere','Freizeit','Ausgabe'];

function openExpenseModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Ausgabe bearbeiten' : 'Ausgabe hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Miete" value="${prefill?.name || ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${EXPENSE_CATS.map(c => `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Häufigkeit</label>
        <select id="m-freq">
          <option value="monthly" ${prefill?.frequency !== 'yearly' ? 'selected' : ''}>📅 Monatlich</option>
          <option value="yearly"  ${prefill?.frequency === 'yearly'  ? 'selected' : ''}>📆 Jährlich (wird auf Monate umgerechnet)</option>
        </select>
      </div>
      <div class="field"><label id="m-amount-label">Betrag (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0" value="${prefill?.amount || ''}" oninput="updateExpenseAmountLabel()">
        <div id="m-amount-hint" style="font-size:12px;color:var(--text2);margin-top:4px"></div>
      </div>
      <div class="field"><label>Budget-Limit/Monat (${state.currency}, optional)</label>
        <input id="m-limit" type="number" inputmode="decimal" step="any" placeholder="0 = kein Limit" value="${prefill?.budgetLimit || ''}">
      </div>
      <div class="field"><label>Notiz (optional)</label>
        <input id="m-note" type="text" value="${prefill?.note || ''}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveExpense()">Speichern</button>
      </div>
    </div>
  </div>`);
  setTimeout(updateExpenseAmountLabel, 0);
}

function updateExpenseAmountLabel() {
  const freq = el('m-freq')?.value;
  const amount = parseFloat(el('m-amount')?.value) || 0;
  const hint = el('m-amount-hint');
  const label = el('m-amount-label');
  if (!hint || !label) return;
  if (freq === 'yearly') {
    label.textContent = `Betrag pro Jahr (${state.currency})`;
    hint.textContent = amount > 0 ? `= ${fmt(amount / 12)} pro Monat` : 'Jährlicher Betrag – wird durch 12 geteilt';
  } else {
    label.textContent = `Betrag pro Monat (${state.currency})`;
    hint.textContent = '';
  }
}

function saveExpense() {
  const name        = el('m-name')?.value.trim();
  const amount      = parseFloat(el('m-amount')?.value);
  const category    = el('m-cat')?.value;
  const frequency   = el('m-freq')?.value || 'monthly';
  const budgetLimit = parseFloat(el('m-limit')?.value) || 0;
  const note        = el('m-note')?.value.trim();
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) {
    Object.assign(state.expenses.find(x => x.id === editContext.id), { name, amount, category, frequency, budgetLimit, note });
  } else {
    state.expenses.push({ id: uid(), name, amount, category, frequency, budgetLimit, note });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  RENDERERS.ausgaben(); RENDERERS.uebersicht();
}

// ── Einmalige Buchung Modal ────────────────────────────────────────────────
function openTransactionModal() {
  const today = new Date().toISOString().slice(0, 10);
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">📝 Einmalige Buchung</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Zahnarzt, Bonus">
      </div>
      <div class="field"><label>Typ</label>
        <select id="m-tx-type">
          <option value="expense">💸 Ausgabe</option>
          <option value="income">💰 Einnahme</option>
        </select>
      </div>
      <div class="field"><label>Betrag (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" step="any" placeholder="0">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${EXPENSE_CATS.map(c => `<option value="${c}">${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Datum</label>
        <input id="m-date" type="date" value="${today}">
      </div>
      <div class="field"><label>Notiz (optional)</label>
        <input id="m-note" type="text">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveTransaction()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveTransaction() {
  const name = el('m-name')?.value.trim(), type = el('m-tx-type')?.value;
  const amount = parseFloat(el('m-amount')?.value), category = el('m-cat')?.value;
  const date = el('m-date')?.value, note = el('m-note')?.value.trim();
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (!state.transactions) state.transactions = [];
  state.transactions.push({ id: uid(), name, type, amount, category, date, note });
  saveState(); closeModal(); toast('Buchung gespeichert ✓');
  RENDERERS.ausgaben();
}

// ── Investitions-Modal ─────────────────────────────────────────────────────
const INVEST_CATS = ['ETF','Aktien','Krypto','Obligationen','Säule3a','Investition'];

function openInvestmentModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Investition bearbeiten' : 'Investition hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. MSCI World ETF" value="${prefill?.name || ''}">
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
  RENDERERS.vermoegen(); RENDERERS.uebersicht();
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
  RENDERERS.vermoegen(); RENDERERS.uebersicht();
  if (el('page-ziele').classList.contains('active')) RENDERERS.ziele();
}

// ── Schulden-Modal ─────────────────────────────────────────────────────────
const DEBT_CATS = ['Kredit','Hypothek','Auto-Leasing','Studentenkredit','Kreditkarte','Schulden'];

function openDebtModal(prefill = null) {
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Schuld bearbeiten' : 'Schuld hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Autokredit" value="${prefill?.name || ''}">
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
  RENDERERS.vermoegen(); RENDERERS.uebersicht();
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
          <span style="flex:1">${d.name}</span>
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
  RENDERERS.einkommen();
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
        <input id="m-name" type="text" placeholder="z.B. Traumurlaub" value="${prefill?.name || ''}">
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
  RENDERERS.ziele();
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
  RENDERERS.ziele(); RENDERERS.uebersicht();
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
      <div style="height:1px;background:var(--border);margin:14px 0"></div>
      <div class="card-title" style="margin-bottom:10px">Daten-Backup</div>
      <button class="btn btn-ghost btn-full" onclick="exportData()">⬇️ Exportieren (JSON)</button>
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
  saveState(); closeModal(); toast('Gespeichert ✓'); refreshCurrent();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'finanzplaner-backup.json'; a.click();
  URL.revokeObjectURL(url); toast('Exportiert ✓');
}

function importData(e) {
  const file = e.target.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try { state = migrateState(JSON.parse(ev.target.result)); saveState(); closeModal(); toast('Importiert ✓'); navigate('uebersicht'); }
    catch { toast('Fehler beim Importieren'); }
  };
  reader.readAsText(file);
}

function resetData() {
  if (!confirm('Wirklich alle Daten löschen? Nicht rückgängig machbar.')) return;
  state = migrateState(null); saveState(); closeModal(); toast('Daten gelöscht'); navigate('uebersicht');
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigate('uebersicht');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
