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
  portfolioHistory: [],
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
  renderDepotSection();
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
        amount: fmt(i.amount) + '/Mt.', amountColor: 'var(--blue)',
        id: i.id, type: 'investment'
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

// ── Ziele ──────────────────────────────────────────────────────────────────
RENDERERS.ziele = function renderZiele() {
  renderFIRE();
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
  });

  list.innerHTML = [...renderActive, ...renderDone].join('');
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

// ── Portfolio-Upload ───────────────────────────────────────────────────────
let depotChart = null;

function handlePortfolioUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const isExcel = /\.(xlsx|xls|ods)$/i.test(file.name);
  const reader = new FileReader();

  reader.onload = e => {
    try {
      let rows;
      if (isExcel) {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      } else {
        // CSV
        const text = e.target.result;
        const sep = text.includes(';') ? ';' : ',';
        rows = text.trim().split('\n').map(l => l.split(sep).map(v => v.trim().replace(/^["']|["']$/g, '')));
      }
      const parsed = processHistoryRows(rows);
      if (parsed.length < 2) { toast('Zu wenig Daten – mind. 2 Zeilen mit Datum & Wert'); return; }
      state.portfolioHistory = parsed;
      state.portfolioValue = parsed[parsed.length - 1].value;
      saveState();
      renderDepotSection();
      toast(`${parsed.length} Datenpunkte importiert ✓`);
      if (el('page-vermoegen').classList.contains('active')) RENDERERS.uebersicht?.();
    } catch (err) {
      console.error(err);
      toast('Datei konnte nicht gelesen werden');
    }
  };
  isExcel ? reader.readAsArrayBuffer(file) : reader.readAsText(file);
}

function processHistoryRows(rows) {
  if (!rows?.length) return [];
  // Skip header row if first numeric column is not a number
  let start = 0;
  if (rows[0] && isNaN(parseFloat(String(rows[0][1]).replace(/[,\s]/g, '.')))) start = 1;

  const result = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;
    const dateStr  = String(row[0]).trim();
    const valStr   = String(row[1]).replace(/[''\s]/g, '').replace(',', '.');
    const invStr   = row[2] ? String(row[2]).replace(/[''\s]/g, '').replace(',', '.') : '';
    const value    = parseFloat(valStr);
    const invested = parseFloat(invStr) || 0;
    if (isNaN(value) || value <= 0) continue;
    const date = parseFlexDate(dateStr);
    if (!date) continue;
    result.push({ date, value, invested });
  }
  return result.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function parseFlexDate(s) {
  if (!s) return null;
  s = s.trim();
  const de  = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (de)  return `${de[3]}-${de[2].padStart(2,'0')}-${de[1].padStart(2,'0')}`;
  const de2 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (de2) return `20${de2[3]}-${de2[2].padStart(2,'0')}-${de2[1].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}$/.test(s))      return s + '-01';
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us)  return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function renderDepotSection() {
  const section = el('depot-chart-section');
  if (!section) return;
  const history = state.portfolioHistory;
  if (!history?.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const first = history[0];
  const last  = history[history.length - 1];
  const hasInv = history.some(h => h.invested > 0);
  const base  = hasInv ? (last.invested || first.value) : first.value;
  const gain  = last.value - base;
  const gainPct = base > 0 ? gain / base * 100 : 0;
  const isPos = gain >= 0;

  // Key stats
  const msApart = new Date(last.date) - new Date(first.date);
  const years   = msApart / (1000 * 60 * 60 * 24 * 365.25);
  const paReturn = years > 0.08 ? ((Math.pow(last.value / (base || 1), 1 / years) - 1) * 100) : gainPct;

  // Max drawdown
  let maxDD = 0, peak = history[0].value;
  for (const h of history) {
    if (h.value > peak) peak = h.value;
    const dd = peak > 0 ? (peak - h.value) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  el('depot-stats').innerHTML = `
    <div class="depot-gain-card" style="background:${isPos ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)'};border-color:${isPos ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}">
      <div style="font-size:12px;color:var(--text2);margin-bottom:4px">Gesamtgewinn / -verlust</div>
      <div style="font-size:30px;font-weight:800;color:${isPos ? 'var(--green)' : 'var(--red)'}">
        ${isPos ? '+' : ''}${fmt(gain)}
      </div>
      <div style="font-size:15px;font-weight:600;color:${isPos ? 'var(--green)' : 'var(--red)'};margin-top:2px">
        ${isPos ? '▲' : '▼'} ${Math.abs(gainPct).toFixed(2)}%
      </div>
    </div>
    <div class="kpi-grid" style="margin-top:10px">
      <div class="kpi-item">
        <div class="kpi-label">Ø Rendite p.a.</div>
        <div class="kpi-value${paReturn >= 0 ? ' green' : ' red'}">${paReturn >= 0 ? '+' : ''}${paReturn.toFixed(1)}%</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Max. Rückgang</div>
        <div class="kpi-value red">-${maxDD.toFixed(1)}%</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Startwert</div>
        <div class="kpi-value">${fmt(first.value)}</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">Aktueller Wert</div>
        <div class="kpi-value">${fmt(last.value)}</div>
      </div>
    </div>`;

  // Chart
  const labels   = history.map((h, i) => {
    const d = new Date(h.date);
    const skip = history.length > 60 ? Math.ceil(history.length / 12) : history.length > 24 ? 3 : 1;
    return i % skip === 0 ? d.toLocaleDateString('de-CH', { month: 'short', year: '2-digit' }) : '';
  });
  const values   = history.map(h => h.value);
  const invested = hasInv ? history.map(h => h.invested || 0) : null;

  if (depotChart) depotChart.destroy();
  const datasets = [{
    label: 'Depotwert',
    data: values,
    borderColor: isPos ? '#10b981' : '#ef4444',
    backgroundColor: isPos ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
    fill: true, tension: .35, pointRadius: 0, borderWidth: 2
  }];
  if (invested) datasets.push({
    label: 'Eingesetzt',
    data: invested,
    borderColor: 'rgba(148,163,184,.5)',
    backgroundColor: 'transparent',
    fill: false, tension: .35, pointRadius: 0, borderWidth: 1.5, borderDash: [5, 4]
  });

  depotChart = new Chart(el('depot-chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
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

function clearPortfolioHistory() {
  state.portfolioHistory = [];
  saveState();
  el('depot-chart-section').style.display = 'none';
  toast('Upload gelöscht');
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigate('uebersicht');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
