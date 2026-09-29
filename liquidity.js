'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Phase 1 – Liquidität & Alltag
//   Lohnzyklus-Einstellungen · Safe to spend · Brutto-Netto-Rechner · Kreditkarten
// Nutzt die globalen Helfer aus app.js (state, fmt, esc, showModal, …).
// ══════════════════════════════════════════════════════════════════════════

const midnight = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays  = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff  = (a, b) => Math.round((midnight(b) - midnight(a)) / 864e5);
const liquidAccounts = () => state.accounts.filter(a => a.type === 'liquid');
const isLiquidAccount = id => liquidAccounts().some(a => a.id === id);

// Nächster Lohntag strikt nach heute (ist heute Lohntag, zählt der nächste Monat)
function nextPayday(today = midnight()) {
  let d = paydayDate(today.getFullYear(), today.getMonth());
  if (d <= today) d = paydayDate(today.getFullYear(), today.getMonth() + 1);
  return d;
}
function lastPayday(today = midnight()) {
  let d = paydayDate(today.getFullYear(), today.getMonth());
  if (d > today) d = paydayDate(today.getFullYear(), today.getMonth() - 1);
  return d;
}

// ── Kreditkarten ──────────────────────────────────────────────────────────
function cardClosing(card, y, m) {
  return new Date(y, m, Math.min(card.statementDay || 1, new Date(y, m + 1, 0).getDate()));
}

// Abrechnungen einer Karte: abgeschlossene (seit Erfassung der Karte) + laufende Periode
function cardStatements(card) {
  const today = midnight();
  const since = card.trackingSince ? parseISO(card.trackingSince) : today;
  const txs = (state.transactions || []).filter(t => t.accountId === card.id);
  const closings = [];
  for (let d = new Date(since.getFullYear(), since.getMonth() - 1, 1); d <= addDays(today, 62); d.setMonth(d.getMonth() + 1)) {
    closings.push(cardClosing(card, d.getFullYear(), d.getMonth()));
  }
  const closed = [];
  let running = null;
  for (let i = 1; i < closings.length; i++) {
    const from = isoDate(closings[i - 1]), to = isoDate(closings[i]);
    if (closings[i] < since) continue;
    const items = txs.filter(t => t.date > from && t.date <= to);
    const total = round2(items.reduce((s, t) => s + (t.type === 'income' ? -t.amount : t.amount), 0));
    const st = { cardId: card.id, statement: to, from, total, count: items.length,
                 due: isoDate(addDays(closings[i], card.paymentTermDays ?? 20)) };
    if (closings[i] > today) { if (!running) running = st; continue; }
    st.payment = (state.cardPayments || []).find(p => p.cardId === card.id && p.statement === to);
    closed.push(st);
  }
  const open = closed.filter(s => !s.payment && s.total > 0.005);
  return { closed, open, running };
}

function cardOwed(card) { return Math.max(0, -(card.balance || 0)); }

// Offene Abrechnungen (und die laufende, falls bald fällig) für "Anstehende Zahlungen"
function cardUpcoming(days = 30) {
  const out = [];
  for (const card of state.accounts.filter(a => a.type === 'credit')) {
    const { open, running } = cardStatements(card);
    for (const s of open) {
      const d = daysUntil(s.due);
      if (d <= days) out.push({ name: `${card.name} · Abrechnung ${fmtDate(s.statement)}`, amount: s.total, category: 'Kreditkarte',
        type: 'expense', date: parseISO(s.due), days: d, cardId: card.id, statement: s.statement, payable: true });
    }
    if (running && running.total > 0.005 && daysUntil(running.due) <= days) {
      out.push({ name: `${card.name} · laufende Abrechnung (per ${fmtDate(running.statement)})`, amount: running.total,
        category: 'Kreditkarte', type: 'expense', date: parseISO(running.due), days: daysUntil(running.due), cardId: card.id });
    }
  }
  return out;
}

// Zusatzzeilen unter einer Kreditkarte in "Konten & Guthaben"
function renderCardDetails(card) {
  const { open, running } = cardStatements(card);
  const owed = cardOwed(card);
  const pct = card.limit > 0 ? Math.min(100, owed / card.limit * 100) : 0;
  const col = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : 'var(--green)';
  return `
  <div class="card-detail">
    <div class="pot-nums"><span>Offen <strong>${fmtExact(round2(owed))}</strong>${card.limit ? ` von ${fmt(card.limit)}` : ''}</span>
      ${card.limit ? `<span>${pct.toFixed(0)}% der Limite</span>` : ''}</div>
    ${card.limit ? `<div class="pot-bar" style="margin-top:4px"><div class="pot-fill" style="width:${pct}%;background:${col}"></div></div>` : ''}
    ${open.map(s => `
      <div class="card-stmt">
        <span>Abrechnung ${fmtDate(s.statement)} · <strong>${fmt2(s.total)}</strong><br>
          <span style="color:${daysUntil(s.due) < 0 ? 'var(--red)' : 'var(--text2)'}">fällig ${fmtDate(s.due)}</span></span>
        <button class="toggle-btn" onclick="openCardPayModal('${card.id}','${s.statement}')">Abrechnung bezahlt</button>
      </div>`).join('')}
    ${running ? `<div class="pot-rate">Nächste Abrechnung ${fmtDate(running.statement)}: bisher ${fmtExact(running.total)} (${running.count} Käufe) · fällig ${fmtDate(running.due)}</div>` : ''}
  </div>`;
}

function openCardPayModal(cardId, statement) {
  const card = state.accounts.find(a => a.id === cardId);
  const s = card && cardStatements(card).closed.find(x => x.statement === statement);
  if (!s) return;
  const from = liquidAccounts()[0]?.id;
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🪪 ${esc(card.name)} – Abrechnung bezahlt</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:12px">Abrechnung per ${fmtDate(s.statement)} · ${s.count} Käufe · fällig ${fmtDate(s.due)}.
        Die Käufe sind bereits am Kaufdatum als Ausgaben erfasst – die Zahlung ist nur ein Übertrag und wird nicht doppelt gezählt.</div>
      <div class="field"><label>Betrag (${state.currency})</label>
        <input id="m-card-amount" type="number" inputmode="decimal" step="any" value="${s.total}">
      </div>
      <div class="field"><label>Bezahlt von Konto</label>
        <select id="m-card-from">${state.accounts.filter(a => a.id !== card.id).map(a =>
          `<option value="${a.id}" ${a.id === from ? 'selected' : ''}>${accTypeIcon(a.type)} ${esc(a.name)} (${fmt(a.balance)})</option>`).join('')}</select>
      </div>
      <div class="field"><label>Datum</label><input id="m-card-date" type="date" value="${localISO()}"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveCardPayment('${card.id}','${s.statement}')">Bezahlt ✓</button>
      </div>
    </div>
  </div>`);
}

function saveCardPayment(cardId, statement) {
  const card = state.accounts.find(a => a.id === cardId);
  const from = state.accounts.find(a => a.id === el('m-card-from')?.value);
  const amount = round2(parseFloat(el('m-card-amount')?.value));
  if (!card || !from || !(amount > 0)) { toast('Betrag und Konto angeben'); return; }
  state.cardPayments.push({ id: uid(), cardId, statement, amount, date: el('m-card-date')?.value || localISO(), fromAccountId: from.id });
  card.balance = round2((card.balance || 0) + amount);
  from.balance = round2(from.balance - amount);
  saveState(); closeModal(); toast(`Abrechnung bezahlt ✓ (${fmtExact(amount)} von ${from.name})`); refreshCurrent();
}

// ── Safe to spend bis zum Lohntag ─────────────────────────────────────────
function safeToSpend() {
  const today = midnight();
  const payday = nextPayday(today);
  const daysLeft = Math.max(1, dayDiff(today, payday));
  const inWindow = d => d >= today && d < payday;
  const liquid = liquidAccounts().reduce((s, a) => s + a.balance, 0);
  const rows = [];
  const add = (group, label, amount, extra = {}) => { if (amount > 0.005) rows.push({ group, label, amount: round2(amount), ...extra }); };
  const at = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));

  // 1. Monatliche Fixkosten mit Fälligkeitstag bis zum Lohntag
  const noDueDay = [];
  for (const e of state.expenses) {
    if (isIrregular(e)) continue;
    if (!e.dueDay) { noDueDay.push(e); continue; }
    for (let i = 0; i <= 1; i++) {
      const d = at(today.getFullYear(), today.getMonth() + i, e.dueDay);
      if (inWindow(d)) add('Fixkosten', `${e.name} (${fmtDate(d)})`, e.amount);
    }
  }
  // 2. Jahres-/Halbjahres-/Quartalszahlungen im Zeitraum (Topf auf nicht-liquidem Konto deckt einen Teil)
  const coveredPots = new Set();
  for (const e of state.expenses) {
    if (!isIrregular(e) || !e.nextDue) continue;
    const d = parseISO(e.nextDue);
    if (!(d < payday)) continue;                       // inkl. überfällige
    let amount = e.amount;
    if (hasReserve(e)) {
      coveredPots.add(e.id);
      if (!isLiquidAccount(e.reserveAccountId)) amount = Math.max(0, e.amount - (e.reserveSaved || 0));
    }
    add('Rechnungen', `${e.name} (${fmtDate(d)})${amount < e.amount ? ' – Rest nach Rückstellung' : ''}`, amount);
  }
  // 3. Kreditkarten-Abrechnungen, die bis zum Lohntag fällig werden
  for (const card of state.accounts.filter(a => a.type === 'credit')) {
    const { open, running } = cardStatements(card);
    for (const s of open) if (parseISO(s.due) < payday) add('Kreditkarte', `${card.name} · Abrechnung ${fmtDate(s.statement)}`, s.total);
    if (running && parseISO(running.due) < payday) add('Kreditkarte', `${card.name} · laufend, fällig ${fmtDate(running.due)}`, running.total);
  }
  // 4. Investitionen, Sparüberträge und Kreditraten dieses Budgetmonats (bis als erledigt markiert)
  const transfersDone = state.settings.transfersDoneFor === isoDate(lastPayday(today));
  const transfers = totalInvestments() + totalDebtPay();
  if (!transfersDone) add('Überträge', 'Investitionen, Sparüberträge & Kreditraten', transfers, { toggle: true });
  // 5. Rückstellungen: noch nicht verbuchte Monatsrate + reserviertes Geld auf liquiden Konten
  for (const e of reserveExpenses()) {
    const i = reserveInfo(e);
    if (!i.booked && !coveredPots.has(e.id)) add('Rückstellungen', `${e.name}: Monatsrate`, i.rate);
    if (isLiquidAccount(e.reserveAccountId) && !coveredPots.has(e.id)) add('Rückstellungen', `${e.name}: reserviert auf Konto`, e.reserveSaved || 0);
  }

  const deductions = round2(rows.reduce((s, r) => s + r.amount, 0));
  const free = round2(liquid - deductions);
  return { liquid, rows, deductions, free, perDay: free / daysLeft, daysLeft, payday, noDueDay,
           transfersDone, transfers, hasLiquid: liquidAccounts().length > 0 };
}

let safeOpen = false;
function renderSafeToSpend() {
  const box = el('dash-safe');
  if (!box) return;
  const s = safeToSpend();
  if (!s.hasLiquid) {
    box.innerHTML = `<div class="card safe-card safe-yellow">
      <div class="safe-label">Safe to spend</div>
      <div style="font-size:13px;margin-top:6px">Erfasse ein Konto vom Typ <strong>„Liquid“</strong> (z.B. Privatkonto), um zu sehen, wie viel du bis zum Lohntag ausgeben kannst.</div>
      <button class="btn btn-ghost" style="margin-top:10px" onclick="openAccountsModal()">Konten verwalten</button></div>`;
    return;
  }
  const cls = s.free < 0 ? 'safe-red' : s.perDay > 20 ? 'safe-green' : 'safe-yellow';
  const groups = [...new Set(s.rows.map(r => r.group))];
  box.innerHTML = `
  <div class="card safe-card ${cls}">
    <div class="safe-label">Safe to spend bis Lohntag</div>
    <div class="safe-amount">${fmt2(s.perDay)}<span> / Tag</span></div>
    ${s.free < 0 ? `<div class="safe-warn">⚠️ Es fehlen ${fmtExact(round2(-s.free))} bis zum Lohntag</div>` : ''}
    <div class="safe-meta">
      <span>Total frei <strong>${fmt2(s.free)}</strong></span>
      <span><strong>${s.daysLeft}</strong> Tag${s.daysLeft === 1 ? '' : 'e'} bis Lohn (${fmtDate(s.payday)})</span>
    </div>
    <details class="safe-details" ${safeOpen ? 'open' : ''} ontoggle="safeOpen=this.open">
      <summary>Aufschlüsselung</summary>
      <div class="safe-row"><span>Liquide Konten</span><strong>${fmt2(s.liquid)}</strong></div>
      ${groups.map(g => `
        <div class="safe-group">${g}</div>
        ${s.rows.filter(r => r.group === g).map(r => `<div class="safe-row"><span>${esc(r.label)}</span><strong>−${fmt2(r.amount)}</strong></div>`).join('')}`).join('')}
      <div class="safe-row safe-total"><span>Frei bis Lohntag</span><strong>${fmt2(s.free)}</strong></div>
      ${s.transfers > 0 ? `<button class="toggle-btn" style="margin-top:8px" onclick="toggleTransfersDone()">${s.transfersDone ? '↩︎ Überträge wieder abziehen' : '✓ Investitionen & Überträge sind erledigt'}</button>` : ''}
      ${s.noDueDay.length ? `<div class="safe-hint">ℹ️ ${s.noDueDay.length} monatliche Ausgabe${s.noDueDay.length === 1 ? '' : 'n'} ohne Fälligkeitstag (${s.noDueDay.slice(0, 3).map(e => esc(e.name)).join(', ')}${s.noDueDay.length > 3 ? ' …' : ''}) gelten als nach dem Lohn bezahlt und werden nicht abgezogen. Trage einen Fälligkeitstag ein, damit sie berücksichtigt werden.</div>` : ''}
    </details>
  </div>`;
}

function toggleTransfersDone() {
  const key = isoDate(lastPayday());
  state.settings.transfersDoneFor = state.settings.transfersDoneFor === key ? null : key;
  saveState(); safeOpen = true; renderSafeToSpend();
}

// ── Brutto-Netto-Rechner (CH) ─────────────────────────────────────────────
function grossToNet(grossMonthly, n) {
  const p = state.settings.payroll;
  const annual = grossMonthly * n;
  const capped = Math.min(annual, p.alvCap || 148200);
  const rows = [
    { label: `AHV/IV/EO ${p.ahv}%`, value: annual * p.ahv / 100 },
    { label: `ALV ${p.alv}% (bis ${fmt(p.alvCap)})`, value: capped * p.alv / 100 },
    { label: `NBU ${p.nbu}%`, value: capped * p.nbu / 100 },
    { label: 'BVG (Pensionskasse)', value: (p.bvgMonthly || 0) * 12 }
  ].map(r => ({ ...r, value: round2(r.value) }));
  const deductions = round2(rows.reduce((s, r) => s + r.value, 0));
  const netAnnual = round2(annual - deductions);
  return { annual, rows, deductions, netAnnual, netPerPay: round2(netAnnual / n), netAvgMonth: round2(netAnnual / 12) };
}

function renderGrossNet() {
  const box = el('grossnet-section');
  if (!box) return;
  const g = state.settings.grossCalc;
  box.innerHTML = `
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div class="card-title" style="margin-bottom:0">🧮 Brutto-Netto-Rechner (CH)</div>
      <button class="toggle-btn ${g.compare ? 'active' : ''}" onclick="toggleGrossCompare()">Vergleich</button>
    </div>
    <div class="gn-inputs">
      <div class="field"><label>${g.compare ? 'A: ' : ''}Brutto/Monat</label>
        <input id="gn-a" type="number" inputmode="decimal" step="any" placeholder="z.B. 6500" value="${g.a || ''}" oninput="updateGrossNet()"></div>
      ${g.compare ? `<div class="field"><label>B: Brutto/Monat</label>
        <input id="gn-b" type="number" inputmode="decimal" step="any" placeholder="Angebot" value="${g.b || ''}" oninput="updateGrossNet()"></div>` : ''}
      <div class="field"><label>Monatslöhne</label>
        <select id="gn-n" onchange="updateGrossNet()"><option ${g.n === 12 ? 'selected' : ''}>12</option><option ${g.n === 13 ? 'selected' : ''}>13</option></select></div>
    </div>
    <div id="gn-result"></div>
    <div style="font-size:11px;color:var(--text2);margin-top:8px;line-height:1.5">⚠️ Werte vom eigenen Lohnausweis prüfen – BVG und NBU sind je nach Arbeitgeber unterschiedlich.
      Sätze unter ⚙️ → Lohnabzüge anpassen. Quellensteuer/Steuern sind nicht enthalten.</div>
  </div>`;
  updateGrossNet(false);
}

function updateGrossNet(persist = true) {
  const g = state.settings.grossCalc;
  g.a = parseFloat(el('gn-a')?.value) || 0;
  if (g.compare) g.b = parseFloat(el('gn-b')?.value) || 0;
  g.n = parseInt(el('gn-n')?.value) || 12;
  if (persist) saveState();
  const res = el('gn-result');
  if (!g.a) { res.innerHTML = '<div style="font-size:13px;color:var(--text2)">Bruttolohn eingeben, um die Abzüge zu sehen.</div>'; return; }
  const cols = [grossToNet(g.a, g.n), ...(g.compare && g.b ? [grossToNet(g.b, g.n)] : [])];
  const two = cols.length === 2;
  const cell = v => `<td>${fmt2(v)}</td>`;
  res.innerHTML = `
    <table class="gn-table">
      ${two ? '<tr><th></th><th>A</th><th>B</th></tr>' : ''}
      <tr><td>Brutto/Jahr</td>${cols.map(c => cell(c.annual)).join('')}</tr>
      ${cols[0].rows.map((r, i) => `<tr class="gn-ded"><td>− ${r.label}</td>${cols.map(c => cell(c.rows[i].value)).join('')}</tr>`).join('')}
      <tr class="gn-sum"><td>Abzüge total</td>${cols.map(c => cell(c.deductions)).join('')}</tr>
      <tr class="gn-net"><td>Netto/Jahr</td>${cols.map(c => cell(c.netAnnual)).join('')}</tr>
      <tr class="gn-net"><td>Netto pro Monatslohn</td>${cols.map(c => cell(c.netPerPay)).join('')}</tr>
      ${g.n === 13 ? `<tr><td>Ø Netto/Monat (÷12)</td>${cols.map(c => cell(c.netAvgMonth)).join('')}</tr>` : ''}
      ${two ? `<tr class="gn-diff"><td>Differenz B − A</td><td></td><td>${cols[1].netAnnual - cols[0].netAnnual >= 0 ? '+' : ''}${fmt2(round2(cols[1].netAnnual - cols[0].netAnnual))}/J.</td></tr>` : ''}
    </table>
    <button class="btn btn-ghost" style="width:100%;margin-top:10px" onclick="applyGrossAsIncome()">Als Einkommen übernehmen (${fmtExact(cols[0].netAvgMonth)}/Mt.)</button>`;
}

function toggleGrossCompare() {
  state.settings.grossCalc.compare = !state.settings.grossCalc.compare;
  saveState(); renderGrossNet();
}

function applyGrossAsIncome() {
  const g = state.settings.grossCalc;
  const net = grossToNet(g.a, g.n).netAvgMonth;
  const existing = state.income.find(i => i.category === 'Lohn');
  if (existing) {
    if (!confirm(`„${existing.name}“ von ${fmtExact(existing.amount)} auf ${fmtExact(net)} pro Monat ändern?`)) return;
    existing.amount = net;
    existing.note = `Netto aus ${fmt(g.a)} brutto × ${g.n}${g.n === 13 ? ' (13. ML auf 12 Mt. verteilt)' : ''}`;
  } else {
    state.income.push({ id: uid(), name: 'Lohn (netto)', amount: net, category: 'Lohn', dueDay: state.settings.payday,
      note: `Netto aus ${fmt(g.a)} brutto × ${g.n}` });
  }
  saveState(); toast('Einkommen übernommen ✓'); refreshCurrent();
}

// ── Einstellungen ─────────────────────────────────────────────────────────
SETTINGS_SECTIONS.push({
  title: 'Budgetmonat & Lohn',
  html: () => {
    const s = state.settings;
    return `
      <div class="field"><label>Monatsansichten</label>
        <select id="set-month-mode">
          <option value="calendar" ${s.monthMode !== 'payday' ? 'selected' : ''}>Kalendermonat (1. – Monatsende)</option>
          <option value="payday" ${s.monthMode === 'payday' ? 'selected' : ''}>Lohnzyklus (Lohntag – Tag vor nächstem Lohntag)</option>
        </select></div>
      <div class="field"><label>Lohntag (1–31)</label>
        <input id="set-payday" type="number" inputmode="numeric" min="1" max="31" value="${s.payday || 25}"></div>
      <label class="check-row"><input id="set-weekend" type="checkbox" ${s.paydayWeekendShift !== false ? 'checked' : ''}>
        <span>Fällt der Lohntag auf ein Wochenende → vorheriger Freitag</span></label>`;
  },
  save: () => {
    const day = parseInt(el('set-payday')?.value);
    if (!(day >= 1 && day <= 31)) { toast('Lohntag muss zwischen 1 und 31 liegen'); return false; }
    state.settings.payday = day;
    state.settings.monthMode = el('set-month-mode').value;
    state.settings.paydayWeekendShift = el('set-weekend').checked;
  }
});

SETTINGS_SECTIONS.push({
  title: 'Lohnabzüge (Brutto-Netto)',
  html: () => {
    const p = state.settings.payroll;
    const f = (id, label, v, step = '0.05') => `<div class="field" style="flex:1"><label>${label}</label>
      <input id="${id}" type="number" inputmode="decimal" step="${step}" value="${v}"></div>`;
    return `
      <div style="display:flex;gap:8px">${f('set-ahv', 'AHV/IV/EO %', p.ahv)}${f('set-alv', 'ALV %', p.alv)}</div>
      <div style="display:flex;gap:8px">${f('set-nbu', 'NBU %', p.nbu)}${f('set-bvg', 'BVG CHF/Mt.', p.bvgMonthly, 'any')}</div>
      ${f('set-alvcap', 'ALV-Höchstlohn CHF/Jahr', p.alvCap, '100')}`;
  },
  save: () => {
    const p = state.settings.payroll;
    const num = (id, def) => { const v = parseFloat(el(id)?.value); return isNaN(v) || v < 0 ? def : v; };
    p.ahv = num('set-ahv', 5.3); p.alv = num('set-alv', 1.1); p.nbu = num('set-nbu', 1.0);
    p.bvgMonthly = num('set-bvg', 0); p.alvCap = num('set-alvcap', 148200) || 148200;
  }
});

PAGE_HOOKS.uebersicht.push(renderSafeToSpend);
PAGE_HOOKS.einkommen.push(renderGrossNet);
