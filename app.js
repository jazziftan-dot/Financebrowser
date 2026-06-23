'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  currency: 'CHF',
  balance: 0,
  income: [],
  expenses: [],
  investments: [],
  goals: []
};

let state = loadState();
let projectionChart = null;
let editContext = null; // { type, id } for edit modal

function loadState() {
  try {
    return JSON.parse(localStorage.getItem('finanzplaner')) || JSON.parse(JSON.stringify(DEFAULT_STATE));
  } catch { return JSON.parse(JSON.stringify(DEFAULT_STATE)); }
}

function saveState() {
  localStorage.setItem('finanzplaner', JSON.stringify(state));
}

// ── Helpers ────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

function fmt(n) {
  return new Intl.NumberFormat('de-CH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(n) + ' ' + state.currency;
}

function fmtShort(n) {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + 'k ' + state.currency;
  return fmt(n);
}

function totalIncome() { return state.income.reduce((s, i) => s + i.amount, 0); }
function totalExpenses() { return state.expenses.reduce((s, e) => s + e.amount, 0); }
function totalInvestments() { return state.investments.reduce((s, i) => s + i.amount, 0); }
function monthlySavings() { return totalIncome() - totalExpenses() - totalInvestments(); }

const COLORS = {
  Lohn: '#6366f1', Nebeneinkommen: '#8b5cf6', Sonstiges: '#a78bfa',
  Wohnen: '#ef4444', Lebensmittel: '#f97316', Transport: '#f59e0b',
  Unterhaltung: '#84cc16', Gesundheit: '#06b6d4', Versicherungen: '#3b82f6',
  Kleidung: '#ec4899', Bildung: '#14b8a6', Haustiere: '#a16207',
  Freizeit: '#8b5cf6', Ausgabe: '#64748b',
  ETF: '#10b981', Aktien: '#06b6d4', Krypto: '#f59e0b',
  Obligationen: '#3b82f6', Säule3a: '#6366f1', Investition: '#8b5cf6'
};

const ICONS = {
  Lohn: '💼', Nebeneinkommen: '💰', Sonstiges: '💵',
  Wohnen: '🏠', Lebensmittel: '🛒', Transport: '🚗',
  Unterhaltung: '🎬', Gesundheit: '💊', Versicherungen: '🛡️',
  Kleidung: '👕', Bildung: '📚', Haustiere: '🐾',
  Freizeit: '🎯', Ausgabe: '💸',
  ETF: '📈', Aktien: '📊', Krypto: '₿',
  Obligationen: '📄', Säule3a: '🏦', Investition: '💹'
};

function colorFor(cat) { return COLORS[cat] || '#6366f1'; }
function iconFor(cat) { return ICONS[cat] || '💰'; }

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ── Navigation ─────────────────────────────────────────────────────────────
const pages = ['uebersicht', 'einkommen', 'ausgaben', 'investitionen', 'ziele'];

function navigate(id) {
  pages.forEach(p => {
    document.getElementById('page-' + p).classList.toggle('active', p === id);
    document.getElementById('nav-' + p).classList.toggle('active', p === id);
  });
  if (id === 'uebersicht') renderDashboard();
  if (id === 'einkommen') renderEinkommen();
  if (id === 'ausgaben') renderAusgaben();
  if (id === 'investitionen') renderInvestitionen();
  if (id === 'ziele') renderZiele();
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const income = totalIncome();
  const expenses = totalExpenses();
  const investments = totalInvestments();
  const savings = monthlySavings();
  const rate = income > 0 ? Math.max(0, Math.min(100, (savings + investments) / income * 100)) : 0;

  // Balance card
  document.getElementById('dash-balance').textContent = fmt(state.balance);
  document.getElementById('dash-balance-sub').textContent =
    `Monatliche Sparrate: ${fmt(savings > 0 ? savings : 0)}`;

  // Stats
  document.getElementById('dash-income').textContent = fmt(income);
  document.getElementById('dash-expenses').textContent = fmt(expenses);
  document.getElementById('dash-investments').textContent = fmt(investments);
  document.getElementById('dash-savings').textContent = fmt(savings);
  document.getElementById('dash-savings').className = 'val ' + (savings >= 0 ? 'green' : 'red');

  // Savings rate bar
  document.getElementById('dash-rate-pct').textContent = rate.toFixed(0) + '%';
  document.getElementById('dash-rate-fill').style.width = rate + '%';

  // Chart
  renderProjectionChart();
}

function renderProjectionChart() {
  const canvas = document.getElementById('projection-chart');
  if (!canvas) return;

  const months = 60;
  const labels = [];
  const balanceData = [];
  const investmentData = [];
  const totalData = [];

  let bal = state.balance;
  let invTotal = 0; // total invested value

  const savings = Math.max(0, monthlySavings());
  const monthlyInvest = totalInvestments();

  // Weighted average return across investments
  const avgReturn = state.investments.length
    ? state.investments.reduce((s, i) => s + i.amount * (i.returnRate || 6), 0) / (monthlyInvest || 1)
    : 6;
  const monthlyReturn = avgReturn / 100 / 12;

  const now = new Date();
  for (let m = 0; m <= months; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    if (m % 6 === 0) {
      labels.push(d.toLocaleDateString('de-CH', { month: 'short', year: '2-digit' }));
    } else {
      labels.push('');
    }
    bal += savings;
    invTotal = invTotal * (1 + monthlyReturn) + monthlyInvest;
    balanceData.push(Math.round(bal));
    investmentData.push(Math.round(invTotal));
    totalData.push(Math.round(bal + invTotal));
  }

  if (projectionChart) projectionChart.destroy();

  projectionChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Konto',
          data: balanceData,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,.1)',
          fill: true,
          tension: .4,
          pointRadius: 0,
          borderWidth: 2
        },
        {
          label: 'Investitionen',
          data: investmentData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,.08)',
          fill: true,
          tension: .4,
          pointRadius: 0,
          borderWidth: 2
        },
        {
          label: 'Gesamt',
          data: totalData,
          borderColor: '#f59e0b',
          backgroundColor: 'transparent',
          fill: false,
          tension: .4,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [4, 3]
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 10 }
        },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y)
          },
          backgroundColor: '#1e293b',
          borderColor: '#334155',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8'
        }
      },
      scales: {
        x: {
          ticks: { color: '#475569', font: { size: 10 }, maxRotation: 0 },
          grid: { color: '#1e293b' }
        },
        y: {
          ticks: {
            color: '#475569', font: { size: 10 },
            callback: v => fmtShort(v)
          },
          grid: { color: '#273549' }
        }
      }
    }
  });
}

// ── Einkommen ──────────────────────────────────────────────────────────────
function renderEinkommen() {
  const list = document.getElementById('einkommen-list');
  const total = document.getElementById('einkommen-total');
  total.textContent = fmt(totalIncome());

  if (!state.income.length) {
    list.innerHTML = `<div class="empty"><div class="emoji">💼</div><p>Noch keine Einnahmen erfasst.</p></div>`;
    return;
  }

  list.innerHTML = state.income.map(i => `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:${colorFor(i.category)}22">
          ${iconFor(i.category)}
        </div>
        <div>
          <div class="item-name">${i.name}</div>
          <div class="item-sub">${i.category}${i.note ? ' · ' + i.note : ''}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="item-amount" style="color:var(--green)">${fmt(i.amount)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('income','${i.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('income','${i.id}')">🗑️</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Ausgaben ───────────────────────────────────────────────────────────────
function renderAusgaben() {
  const list = document.getElementById('ausgaben-list');
  const total = document.getElementById('ausgaben-total');
  total.textContent = fmt(totalExpenses());

  if (!state.expenses.length) {
    list.innerHTML = `<div class="empty"><div class="emoji">💸</div><p>Noch keine Ausgaben erfasst.</p></div>`;
    return;
  }

  list.innerHTML = state.expenses.map(e => `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:${colorFor(e.category)}22">
          ${iconFor(e.category)}
        </div>
        <div>
          <div class="item-name">${e.name}</div>
          <div class="item-sub">${e.category}${e.note ? ' · ' + e.note : ''}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="item-amount" style="color:var(--red)">${fmt(e.amount)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('expense','${e.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('expense','${e.id}')">🗑️</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Investitionen ──────────────────────────────────────────────────────────
function renderInvestitionen() {
  const list = document.getElementById('invest-list');
  const total = document.getElementById('invest-total');
  total.textContent = fmt(totalInvestments());

  if (!state.investments.length) {
    list.innerHTML = `<div class="empty"><div class="emoji">📈</div><p>Noch keine Investitionen erfasst.</p></div>`;
    return;
  }

  list.innerHTML = state.investments.map(i => `
    <div class="list-item">
      <div class="item-left">
        <div class="item-icon" style="background:${colorFor(i.category)}22">
          ${iconFor(i.category)}
        </div>
        <div>
          <div class="item-name">${i.name}</div>
          <div class="item-sub">${i.category} · Ø ${i.returnRate || 6}% p.a.</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="item-amount" style="color:var(--blue)">${fmt(i.amount)}</span>
        <div class="item-actions">
          <button class="btn btn-ghost btn-icon" onclick="openEdit('investment','${i.id}')">✏️</button>
          <button class="btn btn-danger btn-icon" onclick="deleteItem('investment','${i.id}')">🗑️</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Ziele ──────────────────────────────────────────────────────────────────
function renderZiele() {
  const list = document.getElementById('ziele-list');
  const savings = Math.max(0, monthlySavings());

  if (!state.goals.length) {
    list.innerHTML = `<div class="empty"><div class="emoji">🎯</div><p>Noch keine Sparziele festgelegt.</p></div>`;
    return;
  }

  list.innerHTML = state.goals.map(g => {
    const remaining = Math.max(0, g.targetAmount - g.currentAmount);
    const pct = g.targetAmount > 0 ? Math.min(100, g.currentAmount / g.targetAmount * 100) : 0;
    let eta = '–';
    if (savings > 0 && remaining > 0) {
      const months = Math.ceil(remaining / savings);
      if (months <= 12) eta = months + ' Monat' + (months === 1 ? '' : 'e');
      else {
        const y = Math.floor(months / 12), m = months % 12;
        eta = y + ' Jahr' + (y === 1 ? '' : 'e') + (m ? ' ' + m + ' Mt.' : '');
      }
    } else if (remaining === 0) {
      eta = 'Erreicht! 🎉';
    } else if (savings <= 0) {
      eta = 'Kein Geld frei';
    }

    return `
      <div class="card goal-card">
        <div class="goal-header">
          <div>
            <div class="goal-name">${g.icon || '🎯'} ${g.name}</div>
            <div class="goal-amounts">${fmt(g.currentAmount)} von ${fmt(g.targetAmount)}</div>
          </div>
          <div style="text-align:right">
            <div class="goal-eta">${eta}</div>
            <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
              <button class="btn btn-ghost btn-icon" style="font-size:13px" onclick="openEdit('goal','${g.id}')">✏️</button>
              <button class="btn btn-danger btn-icon" style="font-size:13px" onclick="deleteItem('goal','${g.id}')">🗑️</button>
            </div>
          </div>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-top:6px">
          <span>${pct.toFixed(0)}% erreicht</span>
          <span>Noch ${fmt(remaining)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── Delete ─────────────────────────────────────────────────────────────────
function deleteItem(type, id) {
  if (type === 'income') state.income = state.income.filter(i => i.id !== id);
  else if (type === 'expense') state.expenses = state.expenses.filter(e => e.id !== id);
  else if (type === 'investment') state.investments = state.investments.filter(i => i.id !== id);
  else if (type === 'goal') state.goals = state.goals.filter(g => g.id !== id);
  saveState();
  toast('Gelöscht');
  refreshCurrent();
}

function refreshCurrent() {
  const active = pages.find(p => document.getElementById('page-' + p).classList.contains('active'));
  if (active) navigate(active);
}

// ── Modals ─────────────────────────────────────────────────────────────────
function closeModal() {
  const bd = document.getElementById('modal-backdrop');
  if (bd) bd.remove();
  editContext = null;
}

function openEdit(type, id) {
  let item;
  if (type === 'income') item = state.income.find(i => i.id === id);
  else if (type === 'expense') item = state.expenses.find(e => e.id === id);
  else if (type === 'investment') item = state.investments.find(i => i.id === id);
  else if (type === 'goal') item = state.goals.find(g => g.id === id);
  if (!item) return;
  editContext = { type, id };

  if (type === 'income') openIncomeModal(item);
  else if (type === 'expense') openExpenseModal(item);
  else if (type === 'investment') openInvestmentModal(item);
  else if (type === 'goal') openGoalModal(item);
}

// Income modal
function openIncomeModal(prefill = null) {
  const title = prefill ? 'Einnahme bearbeiten' : 'Einnahme hinzufügen';
  const html = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
      <div class="modal">
        <div class="modal-title">${title}</div>
        <div class="field">
          <label>Bezeichnung</label>
          <input id="m-name" type="text" placeholder="z.B. Gehalt" value="${prefill?.name || ''}">
        </div>
        <div class="field">
          <label>Betrag pro Monat (${state.currency})</label>
          <input id="m-amount" type="number" inputmode="decimal" placeholder="0" value="${prefill?.amount || ''}">
        </div>
        <div class="field">
          <label>Kategorie</label>
          <select id="m-cat">
            ${['Lohn','Nebeneinkommen','Sonstiges'].map(c =>
              `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${c}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label>Notiz (optional)</label>
          <input id="m-note" type="text" placeholder="" value="${prefill?.note || ''}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
          <button class="btn btn-primary" onclick="saveIncome()">Speichern</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('m-name').focus();
}

function saveIncome() {
  const name = document.getElementById('m-name').value.trim();
  const amount = parseFloat(document.getElementById('m-amount').value);
  const category = document.getElementById('m-cat').value;
  const note = document.getElementById('m-note').value.trim();
  if (!name || isNaN(amount) || amount <= 0) { toast('Bitte Name und Betrag angeben'); return; }

  if (editContext) {
    const i = state.income.find(x => x.id === editContext.id);
    Object.assign(i, { name, amount, category, note });
  } else {
    state.income.push({ id: uid(), name, amount, category, note });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  renderEinkommen(); renderDashboard();
}

// Expense modal
function openExpenseModal(prefill = null) {
  const cats = ['Wohnen','Lebensmittel','Transport','Unterhaltung','Gesundheit',
                 'Versicherungen','Kleidung','Bildung','Haustiere','Freizeit','Ausgabe'];
  const html = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
      <div class="modal">
        <div class="modal-title">${prefill ? 'Ausgabe bearbeiten' : 'Ausgabe hinzufügen'}</div>
        <div class="field">
          <label>Bezeichnung</label>
          <input id="m-name" type="text" placeholder="z.B. Miete" value="${prefill?.name || ''}">
        </div>
        <div class="field">
          <label>Betrag pro Monat (${state.currency})</label>
          <input id="m-amount" type="number" inputmode="decimal" placeholder="0" value="${prefill?.amount || ''}">
        </div>
        <div class="field">
          <label>Kategorie</label>
          <select id="m-cat">
            ${cats.map(c =>
              `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label>Notiz (optional)</label>
          <input id="m-note" type="text" placeholder="" value="${prefill?.note || ''}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
          <button class="btn btn-primary" onclick="saveExpense()">Speichern</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('m-name').focus();
}

function saveExpense() {
  const name = document.getElementById('m-name').value.trim();
  const amount = parseFloat(document.getElementById('m-amount').value);
  const category = document.getElementById('m-cat').value;
  const note = document.getElementById('m-note').value.trim();
  if (!name || isNaN(amount) || amount <= 0) { toast('Bitte Name und Betrag angeben'); return; }

  if (editContext) {
    const e = state.expenses.find(x => x.id === editContext.id);
    Object.assign(e, { name, amount, category, note });
  } else {
    state.expenses.push({ id: uid(), name, amount, category, note });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  renderAusgaben(); renderDashboard();
}

// Investment modal
function openInvestmentModal(prefill = null) {
  const cats = ['ETF','Aktien','Krypto','Obligationen','Säule3a','Investition'];
  const html = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
      <div class="modal">
        <div class="modal-title">${prefill ? 'Investition bearbeiten' : 'Investition hinzufügen'}</div>
        <div class="field">
          <label>Bezeichnung</label>
          <input id="m-name" type="text" placeholder="z.B. MSCI World ETF" value="${prefill?.name || ''}">
        </div>
        <div class="field">
          <label>Monatlicher Betrag (${state.currency})</label>
          <input id="m-amount" type="number" inputmode="decimal" placeholder="0" value="${prefill?.amount || ''}">
        </div>
        <div class="field">
          <label>Kategorie</label>
          <select id="m-cat">
            ${cats.map(c =>
              `<option value="${c}" ${prefill?.category === c ? 'selected' : ''}>${iconFor(c)} ${c}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label>Erwartete Rendite pro Jahr (%)</label>
          <input id="m-return" type="number" inputmode="decimal" placeholder="6" min="0" max="50" value="${prefill?.returnRate ?? 6}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
          <button class="btn btn-primary" onclick="saveInvestment()">Speichern</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('m-name').focus();
}

function saveInvestment() {
  const name = document.getElementById('m-name').value.trim();
  const amount = parseFloat(document.getElementById('m-amount').value);
  const category = document.getElementById('m-cat').value;
  const returnRate = parseFloat(document.getElementById('m-return').value) || 6;
  if (!name || isNaN(amount) || amount <= 0) { toast('Bitte Name und Betrag angeben'); return; }

  if (editContext) {
    const i = state.investments.find(x => x.id === editContext.id);
    Object.assign(i, { name, amount, category, returnRate });
  } else {
    state.investments.push({ id: uid(), name, amount, category, returnRate });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  renderInvestitionen(); renderDashboard();
}

// Goal modal
function openGoalModal(prefill = null) {
  const icons = ['🎯','🚗','🏠','✈️','💻','📱','👶','💍','🎓','🏖️','🛥️','⌚'];
  const html = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
      <div class="modal">
        <div class="modal-title">${prefill ? 'Ziel bearbeiten' : 'Sparziel festlegen'}</div>
        <div class="field">
          <label>Icon</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
            ${icons.map(ic =>
              `<button type="button" class="btn btn-ghost" style="font-size:22px;padding:6px 8px;${prefill?.icon === ic || (!prefill && ic === '🎯') ? 'border:2px solid var(--primary)' : ''}" onclick="selectGoalIcon(this,'${ic}')">${ic}</button>`
            ).join('')}
          </div>
          <input type="hidden" id="m-icon" value="${prefill?.icon || '🎯'}">
        </div>
        <div class="field">
          <label>Bezeichnung</label>
          <input id="m-name" type="text" placeholder="z.B. Neues Auto" value="${prefill?.name || ''}">
        </div>
        <div class="field">
          <label>Zielbetrag (${state.currency})</label>
          <input id="m-target" type="number" inputmode="decimal" placeholder="0" value="${prefill?.targetAmount || ''}">
        </div>
        <div class="field">
          <label>Bereits gespart (${state.currency})</label>
          <input id="m-current" type="number" inputmode="decimal" placeholder="0" value="${prefill?.currentAmount || 0}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
          <button class="btn btn-primary" onclick="saveGoal()">Speichern</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('m-name').focus();
}

function selectGoalIcon(btn, icon) {
  document.querySelectorAll('[onclick^="selectGoalIcon"]').forEach(b => b.style.border = '');
  btn.style.border = '2px solid var(--primary)';
  document.getElementById('m-icon').value = icon;
}

function saveGoal() {
  const name = document.getElementById('m-name').value.trim();
  const targetAmount = parseFloat(document.getElementById('m-target').value);
  const currentAmount = parseFloat(document.getElementById('m-current').value) || 0;
  const icon = document.getElementById('m-icon').value;
  if (!name || isNaN(targetAmount) || targetAmount <= 0) { toast('Bitte Name und Zielbetrag angeben'); return; }

  if (editContext) {
    const g = state.goals.find(x => x.id === editContext.id);
    Object.assign(g, { name, targetAmount, currentAmount, icon });
  } else {
    state.goals.push({ id: uid(), name, targetAmount, currentAmount, icon });
  }
  saveState(); closeModal(); toast('Gespeichert ✓');
  renderZiele();
}

// Balance modal
function openBalanceModal() {
  const html = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
      <div class="modal">
        <div class="modal-title">Kontostand anpassen</div>
        <div class="field">
          <label>Aktueller Kontostand (${state.currency})</label>
          <input id="m-balance" type="number" inputmode="decimal" placeholder="0" value="${state.balance}">
        </div>
        <div class="field">
          <label>Währung</label>
          <select id="m-currency">
            ${['CHF','EUR','USD','GBP'].map(c =>
              `<option value="${c}" ${state.currency === c ? 'selected' : ''}>${c}</option>`
            ).join('')}
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
          <button class="btn btn-primary" onclick="saveBalance()">Speichern</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('m-balance').focus();
  document.getElementById('m-balance').select();
}

function saveBalance() {
  const bal = parseFloat(document.getElementById('m-balance').value) || 0;
  const cur = document.getElementById('m-currency').value;
  state.balance = bal;
  state.currency = cur;
  saveState(); closeModal(); toast('Gespeichert ✓');
  renderDashboard();
}

function handleBackdropClick(e) {
  if (e.target.id === 'modal-backdrop') closeModal();
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  navigate('uebersicht');

  // Keyboard enter submit
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
});
