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

  settings: { inflationRate: 2, fireWithdrawalRate: 4, fireMonthlyExpenses: 0 }
};

function migrateState(raw) {
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
  // Migrate single balance → accounts array
  if (typeof raw.balance === 'number' && !raw.accounts) {
    raw.accounts = raw.balance > 0
      ? [{ id: uid(), name: 'Girokonto', balance: raw.balance, type: 'checking' }]
      : [];
    delete raw.balance;
  }
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
let editContext = null;
let chartMode = 'nominal';

function saveState() { localStorage.setItem('finanzplaner', JSON.stringify(state)); }

// ── Formatierung ───────────────────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n) + ' ' + state.currency;
}
function fmtK(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M ' + state.currency;
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(0) + 'k ' + state.currency;
  return fmt(n);
}

// ── Berechnungen ───────────────────────────────────────────────────────────
const totalAccounts    = () => state.accounts.reduce((s, a) => s + a.balance, 0);
const totalIncome      = () => state.income.reduce((s, i) => s + i.amount, 0);
const totalExpenses    = () => state.expenses.reduce((s, e) => s + e.amount, 0);
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
  const pmt = totalInvestments();
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

// ── Lookup-Tabellen ────────────────────────────────────────────────────────
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

// ── Dashboard ──────────────────────────────────────────────────────────────
RENDERERS.uebersicht = function renderDashboard() {
  const income  = totalIncome();
  const exp     = totalExpenses();
  const invest  = totalInvestments();
  const debtP   = totalDebtPay();
  const savings = monthlySavings();
  const nw      = netWorth();
  const rate    = income > 0 ? Math.max(0, Math.min(100, (savings + invest) / income * 100)) : 0;

  // Nettovermögen
  el('dash-networth').textContent = fmt(nw);
  el('dash-nw-breakdown').textContent =
    `Vermögen: ${fmtK(totalAssets())} · Schulden: ${fmtK(totalDebt())}`;

  // Stats
  el('dash-income').textContent     = fmt(income);
  el('dash-expenses').textContent   = fmt(exp + debtP);
  el('dash-investments').textContent = fmt(invest);
  el('dash-savings').textContent    = fmt(savings);
  el('dash-savings').className = 'val ' + (savings >= 0 ? 'green' : 'red');

  // Notfallfonds
  const em = emergencyStatus();
  const emMonths = emergencyMonths();
  const emPct = Math.min(100, emMonths / 6 * 100);
  const emBarColor = em.cls.includes('green') ? 'var(--green)' : em.cls.includes('yellow') ? 'var(--yellow)' : em.cls.includes('orange') ? '#f97316' : 'var(--red)';
  el('dash-emergency').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="status-badge ${em.cls}">${em.icon} ${em.label}</span>
      <span style="font-size:12px;color:var(--text2)">Ziel: 3–6 Monate</span>
    </div>
    <div class="rate-bar" style="margin-top:8px">
      <div style="height:100%;width:${emPct}%;background:${emBarColor};border-radius:99px;transition:width .4s"></div>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:5px">6-Monats-Ziel: ${fmt(totalExpenses() * 6)}</div>`;

  // FIRE Mini-Widget
  const fn = fireNumber();
  const fp = fireProgress();
  const feta = fireETA();
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
    : `<div style="font-size:13px;color:var(--text2)">Erfasse Einkommen und Investitionen um den FIRE-Fortschritt zu sehen</div>`;

  // Sparquote
  el('dash-rate-pct').textContent  = rate.toFixed(0) + '%';
  el('dash-rate-fill').style.width = rate + '%';

  // Chart
  renderProjectionChart();
};

function renderProjectionChart() {
  const canvas = el('projection-chart');
  if (!canvas) return;

  const months = 60;
  const labels = [], balData = [], invData = [], totalData = [];
  let bal = totalAccounts(), inv = state.portfolioValue;
  const sav = Math.max(0, monthlySavings());
  const pmt = totalInvestments();
  const r   = weightedReturn() / 100 / 12;
  const inf = (state.settings.inflationRate || 2) / 100 / 12;
  const now = new Date();

  for (let m = 0; m <= months; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    labels.push(m % 6 === 0 ? d.toLocaleDateString('de-CH', { month: 'short', year: '2-digit' }) : '');
    bal += sav;
    inv  = inv * (1 + r) + pmt;
    const adj = chartMode === 'real' ? Math.pow(1 + inf, m) : 1;
    balData.push(Math.round(bal / adj));
    invData.push(Math.round(inv / adj));
    totalData.push(Math.round((bal + inv) / adj));
  }

  if (projectionChart) projectionChart.destroy();
  projectionChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Konto',      data: balData,   borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)',  fill: true, tension: .4, pointRadius: 0, borderWidth: 2 },
        { label: 'Depot',      data: invData,   borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.08)', fill: true, tension: .4, pointRadius: 0, borderWidth: 2 },
        { label: 'Gesamt',     data: totalData, borderColor: '#f59e0b', backgroundColor: 'transparent', fill: false, tension: .4, pointRadius: 0, borderWidth: 2, borderDash: [4, 3] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: {
          backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          titleColor: '#f1f5f9', bodyColor: '#94a3b8',
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) }
        }
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

// ── Einkommen ──────────────────────────────────────────────────────────────
RENDERERS.einkommen = function renderEinkommen() {
  el('einkommen-total').textContent = fmt(totalIncome());
  const list = el('einkommen-list');
  if (!state.income.length) {
    list.innerHTML = emptyState('💼', 'Noch keine Einnahmen erfasst.');
    return;
  }
  list.innerHTML = state.income.map(i => listItem({
    icon: iconFor(i.category), color: colorFor(i.category),
    name: i.name, sub: i.category + (i.note ? ' · ' + i.note : ''),
    amount: fmt(i.amount), amountColor: 'var(--green)',
    id: i.id, type: 'income'
  })).join('');
};

// ── Ausgaben ───────────────────────────────────────────────────────────────
RENDERERS.ausgaben = function renderAusgaben() {
  el('ausgaben-total').textContent = fmt(totalExpenses());
  const dp = totalDebtPay();
  el('ausgaben-debt-row').innerHTML = dp > 0
    ? `<div class="info-row">🏦 Schuldentilgung <span>${fmt(dp)}/Mt.</span></div>` : '';

  const list = el('ausgaben-list');
  const income = totalIncome();
  if (!state.expenses.length) {
    list.innerHTML = emptyState('💸', 'Noch keine Ausgaben erfasst.');
    return;
  }
  list.innerHTML = state.expenses.map(e => {
    const pct = income > 0 ? (e.amount / income * 100).toFixed(0) : 0;
    const hasLim = e.budgetLimit > 0;
    const over = hasLim && e.amount > e.budgetLimit;
    const bpct = hasLim ? Math.min(100, e.amount / e.budgetLimit * 100) : 0;
    const bCls = over ? 'budget-over' : bpct > 80 ? 'budget-warn' : 'budget-ok';
    return `
    <div class="list-item${over ? ' item-over' : ''}">
      <div class="item-left">
        <div class="item-icon" style="background:${colorFor(e.category)}22">${iconFor(e.category)}</div>
        <div style="min-width:0">
          <div class="item-name">${e.name}</div>
          <div class="item-sub">${e.category} · ${pct}% Einkomm.${hasLim ? ' · Limit ' + fmt(e.budgetLimit) : ''}</div>
          ${hasLim ? `<div class="budget-bar"><div class="budget-fill ${bCls}" style="width:${bpct}%"></div></div>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="item-amount" style="color:${over ? 'var(--red)' : 'var(--red)'}">${fmt(e.amount)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('expense','${e.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('expense','${e.id}')">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('');
};

// ── Vermögen (Investitionen + Schulden) ────────────────────────────────────
RENDERERS.vermoegen = function renderVermoegen() {
  // Investitionen
  el('invest-total').textContent = fmt(totalInvestments());
  el('portfolio-display').textContent = fmt(state.portfolioValue);

  const ilist = el('invest-list');
  ilist.innerHTML = state.investments.length
    ? state.investments.map(i => listItem({
        icon: iconFor(i.category), color: colorFor(i.category),
        name: i.name, sub: i.category + ' · Ø ' + (i.returnRate || 6) + '% p.a.',
        amount: fmt(i.amount) + '/Mt.', amountColor: 'var(--blue)',
        id: i.id, type: 'investment'
      })).join('')
    : emptyState('📈', 'Noch keine Investitionen.');

  // Schulden
  el('debt-total').textContent    = fmt(totalDebt());
  el('debt-pay-total').textContent = fmt(totalDebtPay()) + '/Mt.';

  const dlist = el('debt-list');
  if (!state.debts.length) {
    dlist.innerHTML = emptyState('🏦', 'Keine Schulden – super!');
    return;
  }
  dlist.innerHTML = state.debts.map(d => {
    const months = debtPayoffMonths(d);
    const pct = d.originalAmount > 0 ? Math.max(0, Math.min(100, (1 - d.remainingAmount / d.originalAmount) * 100)) : 0;
    return `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:rgba(239,68,68,.15)">${iconFor(d.category)}</div>
        <div style="min-width:0">
          <div class="item-name">${d.name}</div>
          <div class="item-sub">${d.category} · ${d.interestRate}% Zins · ${fmt(d.monthlyPayment)}/Mt.</div>
          <div style="margin-top:5px">
            <div class="budget-bar"><div class="budget-fill budget-ok" style="width:${pct}%"></div></div>
            <div style="font-size:11px;color:var(--text2);margin-top:3px">
              ${pct.toFixed(0)}% abgezahlt ·
              <span class="payoff-chip">${months ? 'Frei in ' + formatETA(months) : 'Rate erhöhen!'}</span>
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
};

// ── Ziele ──────────────────────────────────────────────────────────────────
RENDERERS.ziele = function renderZiele() {
  renderFIRE();
  renderGoals();
};

function renderFIRE() {
  const fn = fireNumber();
  const fp = fireProgress();
  const feta = fireETA();
  const fexp = fireExpenses();
  const remaining = Math.max(0, fn - state.portfolioValue);

  el('fire-card').innerHTML = `
    <div class="card-title" style="margin-bottom:6px">FIRE-Rechner</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:14px">Finanzielle Freiheit bei ${state.settings.fireWithdrawalRate}% Entnahmerate (${state.settings.fireWithdrawalRate === 4 ? 'Trinity-Studie' : 'angepasst'})</div>
    <div class="kpi-grid">
      <div class="kpi-item">
        <div class="kpi-label">FIRE-Zahl</div>
        <div class="kpi-value">${fmtK(fn)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Depotwert</div>
        <div class="kpi-value green">${fmtK(state.portfolioValue)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Ruhestand/Mt.</div>
        <div class="kpi-value">${fmtK(fexp)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Noch benötigt</div>
        <div class="kpi-value red">${fmtK(remaining)}</div>
      </div>
    </div>
    <div style="margin:14px 0 6px;display:flex;justify-content:space-between;font-size:13px">
      <span style="color:var(--text2)">Fortschritt</span>
      <strong>${fp.toFixed(1)}%</strong>
    </div>
    <div class="rate-bar" style="height:10px">
      <div style="height:100%;width:${fp}%;background:linear-gradient(90deg,var(--primary),var(--primary-light));border-radius:99px;transition:width .6s"></div>
    </div>
    <div style="margin-top:12px;padding:12px;background:var(--surface2);border-radius:var(--radius-sm);text-align:center;font-size:14px">
      ${feta
        ? `🎯 Finanzielle Freiheit in ca. <strong>${formatETA(feta)}</strong>`
        : fn > 0
          ? `<span style="color:var(--text2)">Trage monatliche Investitionen ein für Zeitprognose</span>`
          : `<span style="color:var(--text2)">Erfasse Einkommen und Ausgaben für die Berechnung</span>`}
    </div>
    <button class="btn btn-ghost btn-full" style="margin-top:10px;font-size:13px" onclick="openFIRESettings()">⚙️ FIRE-Einstellungen anpassen</button>`;
}

function renderGoals() {
  const list = el('ziele-list');
  const sav = Math.max(0, monthlySavings());
  if (!state.goals.length) {
    list.innerHTML = emptyState('🎯', 'Noch keine Sparziele festgelegt.');
    return;
  }
  list.innerHTML = state.goals.map(g => {
    const rem = Math.max(0, g.targetAmount - g.currentAmount);
    const pct = g.targetAmount > 0 ? Math.min(100, g.currentAmount / g.targetAmount * 100) : 0;

    let etaLabel = '–';
    let etaMonths = null;
    if (rem === 0) {
      etaLabel = 'Erreicht! 🎉';
    } else if (sav > 0) {
      etaMonths = Math.ceil(rem / sav);
      const targetDate = new Date();
      targetDate.setMonth(targetDate.getMonth() + etaMonths);
      const dateStr = targetDate.toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
      etaLabel = `${formatETA(etaMonths)} · ${dateStr}`;
    }

    // "What-if" insights
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

      <!-- Progress bar -->
      <div class="progress-bar" style="height:10px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-top:5px;margin-bottom:12px">
        <span><strong style="color:var(--text)">${pct.toFixed(0)}%</strong> erreicht</span>
        <span>Noch <strong style="color:var(--text)">${fmt(rem)}</strong></span>
      </div>

      <!-- ETA highlight -->
      ${etaMonths ? `
      <div class="goal-eta-box">
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">⏱ Zieldatum bei aktuellem Sparpotenzial</div>
        <div style="font-size:15px;font-weight:700;color:var(--primary-light)">${etaLabel}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:2px">${fmt(sav)}/Mt. frei · ${fmt(rem)} noch benötigt</div>
      </div>` : sav <= 0 ? `
      <div class="goal-eta-box" style="border-color:var(--red)">
        <div style="font-size:13px;color:var(--red)">⚠️ Kein freies Kapital – überprüfe deine Ausgaben</div>
      </div>` : ''}

      <!-- Insights -->
      ${insights.length ? `
      <div style="margin-top:10px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:6px">💡 Spar-Szenarien</div>
        <div class="insight-list">
          ${insights.map(i => `
          <div class="insight-row">
            <span class="insight-bonus">+${i.bonus} ${state.currency}/Mt.</span>
            <span class="insight-arrow">→</span>
            <span class="insight-saving">${i.savedLabel} früher</span>
            <span class="insight-date">${i.newDate}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}
    </div>`;
  }).join('');
}

function goalInsights(remaining, savingsPerMonth, currentMonths) {
  if (!currentMonths || remaining <= 0) return [];
  const bonuses = [50, 100, 200, 500, 1000, 2000];
  const insights = [];
  for (const bonus of bonuses) {
    const newSav = savingsPerMonth + bonus;
    const newMonths = Math.ceil(remaining / newSav);
    const saved = currentMonths - newMonths;
    if (saved < 1) continue;
    const newDate = new Date();
    newDate.setMonth(newDate.getMonth() + newMonths);
    insights.push({
      bonus,
      savedLabel: formatETA(saved),
      newDate: newDate.toLocaleDateString('de-CH', { month: 'short', year: 'numeric' })
    });
    if (insights.length >= 4) break;
  }
  return insights;
}

// ── Hilfsfunktionen für Rendering ──────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function emptyState(emoji, text) {
  return `<div class="empty"><div class="emoji">${emoji}</div><p>${text}</p></div>`;
}

function listItem({ icon, color, name, sub, amount, amountColor, id, type }) {
  return `
  <div class="list-item">
    <div class="item-left">
      <div class="item-icon" style="background:${color}22">${icon}</div>
      <div>
        <div class="item-name">${name}</div>
        <div class="item-sub">${sub}</div>
      </div>
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
  const map = { income:'income', expense:'expenses', investment:'investments', debt:'debts', goal:'goals', account:'accounts' };
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
                  ${a.type === 'savings' ? '🏦' : a.type === 'depot' ? '📈' : '💳'}
                </div>
                <div>
                  <div class="item-name">${a.name}</div>
                  <div class="item-sub">${{ checking:'Girokonto', savings:'Sparkonto', depot:'Depot', other:'Sonstiges' }[a.type] || a.type}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                <span class="item-amount">${fmt(a.balance)}</span>
                <button class="btn btn-ghost btn-icon" onclick="closeModal();editContext={type:'account',id:'${a.id}'};openAccountItemModal(${JSON.stringify(a).split('"').join("'")})">✏️</button>
                <button class="btn btn-danger btn-icon" onclick="deleteItem('account','${a.id}');closeModal();openAccountsModal()">🗑️</button>
              </div>
            </div>`).join('')
          : emptyState('💳', 'Noch keine Konten erfasst.')}
      </div>
      <button class="add-btn" style="margin:8px 0" onclick="closeModal();openAccountItemModal()">+ Konto hinzufügen</button>
      <button class="btn btn-ghost btn-full" style="margin-top:4px" onclick="closeModal()">Schliessen</button>
    </div>
  </div>`);
}

function openAccountItemModal(prefill = null) {
  if (prefill && typeof prefill === 'string') { try { prefill = JSON.parse(prefill.split("'").join('"')); } catch {} }
  if (!editContext && prefill?.id) editContext = { type: 'account', id: prefill.id };
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${prefill ? 'Konto bearbeiten' : 'Konto hinzufügen'}</div>
      <div class="field"><label>Bezeichnung</label>
        <input id="m-name" type="text" placeholder="z.B. Girokonto" value="${prefill?.name || ''}">
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
        <input id="m-balance" type="number" inputmode="decimal" placeholder="0" value="${prefill?.balance ?? ''}">
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
  RENDERERS.uebersicht();
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
        <input id="m-amount" type="number" inputmode="decimal" placeholder="0" value="${prefill?.amount || ''}">
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
  const name     = el('m-name')?.value.trim();
  const amount   = parseFloat(el('m-amount')?.value);
  const category = el('m-cat')?.value;
  const note     = el('m-note')?.value.trim();
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) {
    Object.assign(state.income.find(x => x.id === editContext.id), { name, amount, category, note });
  } else {
    state.income.push({ id: uid(), name, amount, category, note });
  }
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
      <div class="field"><label>Betrag pro Monat (${state.currency})</label>
        <input id="m-amount" type="number" inputmode="decimal" placeholder="0" value="${prefill?.amount || ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${EXPENSE_CATS.map(c =>
            `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Budget-Limit/Monat (${state.currency}, optional)</label>
        <input id="m-limit" type="number" inputmode="decimal" placeholder="0 = kein Limit" value="${prefill?.budgetLimit || ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Zeigt Warnung wenn Betrag das Limit übersteigt</div>
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
}

function saveExpense() {
  const name        = el('m-name')?.value.trim();
  const amount      = parseFloat(el('m-amount')?.value);
  const category    = el('m-cat')?.value;
  const budgetLimit = parseFloat(el('m-limit')?.value) || 0;
  const note        = el('m-note')?.value.trim();
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) {
    Object.assign(state.expenses.find(x => x.id === editContext.id), { name, amount, category, budgetLimit, note });
  } else {
    state.expenses.push({ id: uid(), name, amount, category, budgetLimit, note });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  RENDERERS.ausgaben(); RENDERERS.uebersicht();
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
        <input id="m-amount" type="number" inputmode="decimal" placeholder="0" value="${prefill?.amount || ''}">
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="m-cat">
          ${INVEST_CATS.map(c =>
            `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Erwartete Rendite p.a. (%)</label>
        <input id="m-return" type="number" inputmode="decimal" placeholder="6" min="0" max="50" value="${prefill?.returnRate ?? 6}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveInvestment()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveInvestment() {
  const name       = el('m-name')?.value.trim();
  const amount     = parseFloat(el('m-amount')?.value);
  const category   = el('m-cat')?.value;
  const returnRate = parseFloat(el('m-return')?.value) || 6;
  if (!name || isNaN(amount) || amount <= 0) { toast('Name und Betrag angeben'); return; }
  if (editContext) {
    Object.assign(state.investments.find(x => x.id === editContext.id), { name, amount, category, returnRate });
  } else {
    state.investments.push({ id: uid(), name, amount, category, returnRate });
  }
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
        <input id="m-portfolio" type="number" inputmode="decimal" placeholder="0" value="${state.portfolioValue || ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Den Wert findest du in deiner Broker-App oder im e-Banking.</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="savePortfolioValue()">Speichern</button>
      </div>
    </div>
  </div>`);
  setTimeout(() => { el('m-portfolio')?.select(); }, 80);
}

function savePortfolioValue() {
  state.portfolioValue = parseFloat(el('m-portfolio')?.value) || 0;
  saveState(); closeModal(); toast('Gespeichert ✓');
  RENDERERS.vermoegen(); RENDERERS.uebersicht(); if (el('page-ziele').classList.contains('active')) RENDERERS.ziele();
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
          ${DEBT_CATS.map(c =>
            `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Restschuld (${state.currency})</label>
        <input id="m-remaining" type="number" inputmode="decimal" placeholder="0" value="${prefill?.remainingAmount ?? ''}">
      </div>
      <div class="field"><label>Ursprünglicher Kreditbetrag (${state.currency})</label>
        <input id="m-original" type="number" inputmode="decimal" placeholder="0" value="${prefill?.originalAmount ?? ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Für Fortschrittsanzeige (optional)</div>
      </div>
      <div class="field"><label>Monatliche Rate (${state.currency})</label>
        <input id="m-payment" type="number" inputmode="decimal" placeholder="0" value="${prefill?.monthlyPayment ?? ''}">
      </div>
      <div class="field"><label>Zinssatz pro Jahr (%)</label>
        <input id="m-rate" type="number" inputmode="decimal" placeholder="0" min="0" value="${prefill?.interestRate ?? ''}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveDebt()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveDebt() {
  const name           = el('m-name')?.value.trim();
  const category       = el('m-cat')?.value;
  const remainingAmount = parseFloat(el('m-remaining')?.value) || 0;
  const originalAmount  = parseFloat(el('m-original')?.value) || remainingAmount;
  const monthlyPayment  = parseFloat(el('m-payment')?.value) || 0;
  const interestRate    = parseFloat(el('m-rate')?.value) || 0;
  if (!name || remainingAmount <= 0) { toast('Name und Restschuld angeben'); return; }
  if (editContext) {
    Object.assign(state.debts.find(x => x.id === editContext.id),
      { name, category, remainingAmount, originalAmount, monthlyPayment, interestRate });
  } else {
    state.debts.push({ id: uid(), name, category, remainingAmount, originalAmount, monthlyPayment, interestRate });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  RENDERERS.vermoegen(); RENDERERS.uebersicht();
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
        <input id="m-target" type="number" inputmode="decimal" placeholder="0" value="${prefill?.targetAmount || ''}">
      </div>
      <div class="field"><label>Bereits gespart (${state.currency})</label>
        <input id="m-current" type="number" inputmode="decimal" placeholder="0" value="${prefill?.currentAmount || 0}">
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
  const name          = el('m-name')?.value.trim();
  const targetAmount  = parseFloat(el('m-target')?.value);
  const currentAmount = parseFloat(el('m-current')?.value) || 0;
  const icon          = el('m-icon')?.value || '🎯';
  if (!name || isNaN(targetAmount) || targetAmount <= 0) { toast('Name und Zielbetrag angeben'); return; }
  if (editContext) {
    Object.assign(state.goals.find(x => x.id === editContext.id), { name, targetAmount, currentAmount, icon });
  } else {
    state.goals.push({ id: uid(), name, targetAmount, currentAmount, icon });
  }
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
        <input id="m-fire-exp" type="number" inputmode="decimal" placeholder="${totalExpenses()}" value="${state.settings.fireMonthlyExpenses || ''}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Leer = aktuelle Ausgaben (${fmt(totalExpenses())})</div>
      </div>
      <div class="field"><label>Entnahmerate (%)</label>
        <input id="m-fire-rate" type="number" inputmode="decimal" min="1" max="10" step="0.5" value="${state.settings.fireWithdrawalRate}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Standard: 4% (Trinity-Studie, historisch sicher)</div>
      </div>
      <div class="field"><label>Inflationsrate (%)</label>
        <input id="m-inflation" type="number" inputmode="decimal" min="0" max="20" step="0.5" value="${state.settings.inflationRate}">
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Für den Realmodus des Prognose-Charts</div>
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
          ${['CHF','EUR','USD','GBP','JPY'].map(c =>
            `<option ${state.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
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
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'finanzplaner-backup.json'; a.click();
  URL.revokeObjectURL(url); toast('Exportiert ✓');
}

function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      state = migrateState(JSON.parse(ev.target.result));
      saveState(); closeModal(); toast('Importiert ✓'); navigate('uebersicht');
    } catch { toast('Fehler beim Importieren'); }
  };
  reader.readAsText(file);
}

function resetData() {
  if (!confirm('Wirklich alle Daten löschen? Diese Aktion kann nicht rückgängig gemacht werden.')) return;
  state = migrateState(null); saveState(); closeModal(); toast('Daten gelöscht'); navigate('uebersicht');
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigate('uebersicht');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
