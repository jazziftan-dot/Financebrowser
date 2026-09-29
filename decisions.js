'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Phase 3 – Bessere Entscheidungen
//   Arbeitsstunden-Preis · Wunschliste mit Wartezeit · Projekt-Tags · Persönliche Teuerung
// ══════════════════════════════════════════════════════════════════════════

// ── Arbeitsstunden-Preis ──────────────────────────────────────────────────
// Netto-Stundenlohn = Netto-Einkommen/Monat ÷ (Stunden pro Woche × 4.33)
function netHourlyWage() {
  const h = state.settings.workHoursPerWeek || 42;
  const income = totalIncome();
  return income > 0 && h > 0 ? income / (h * 4.33) : 0;
}

function workTimeLabel(amount, force = false) {
  const s = state.settings;
  const wage = netHourlyWage();
  if (!s.workPriceEnabled || !wage || !(amount > 0)) return '';
  if (!force && amount < (s.workPriceThreshold ?? 50)) return '';
  const hours = amount / wage;
  const perDay = (s.workHoursPerWeek || 42) / 5;
  const nf = n => n.toLocaleString('de-CH', { maximumFractionDigits: 1, minimumFractionDigits: n < 10 ? 1 : 0 });
  return hours < perDay ? `≈ ${nf(hours)} Arbeitsstunde${hours >= 0.95 && hours < 1.05 ? '' : 'n'}` : `≈ ${nf(hours / perDay)} Arbeitstage`;
}

function updateWorkPrice() {
  const box = el('m-workprice');
  if (!box) return;
  const isExpense = !el('m-tx-type') || el('m-tx-type').value !== 'income';
  let amount = parseFloat(el('m-amount')?.value) || 0;
  // Regelmässige Ausgabe: pro Zahlung (bei Monatsbeträgen = Monatsbetrag)
  const label = isExpense ? workTimeLabel(amount) : '';
  box.textContent = label ? `⏱ ${label} für diese Ausgabe` : '';
}

const workPriceExtra = {
  html: () => '<div id="m-workprice" class="workprice"></div>',
  mounted: () => {
    el('m-amount')?.addEventListener('input', updateWorkPrice);
    el('m-tx-type')?.addEventListener('change', updateWorkPrice);
    updateWorkPrice();
  },
  read: () => {}
};

// ── Tags (#Projekte) ──────────────────────────────────────────────────────
// Nur Buchstaben, Ziffern und - _ . + & – keine Anführungszeichen (Tags landen in onclick-Handlern)
const normTag = t => t.replace(/^#+/, '').replace(/[^\p{L}\p{N}_\-.+&]/gu, '').trim();
function parseTags(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const t = normTag(raw);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t.slice(0, 30)); }
  }
  return out;
}
// Alle bisher verwendeten Tags (häufigste zuerst, Schreibweise der ersten Verwendung)
function allTags() {
  const count = new Map();
  for (const x of [...(state.transactions || []), ...state.expenses]) {
    for (const t of x.tags || []) {
      const k = t.toLowerCase();
      const cur = count.get(k) || { tag: t, n: 0 };
      cur.n++; count.set(k, cur);
    }
  }
  return [...count.values()].sort((a, b) => b.n - a.n).map(x => x.tag);
}
function tagChips(tags) {
  return `<div class="tag-chips">${tags.map(t => `<span class="tag-chip" onclick="event.stopPropagation();filterByTag('${esc(t)}')">#${esc(t)}</span>`).join('')}</div>`;
}

function tagFieldHtml(prefill) {
  return `
    <div class="field"><label>Tags / Projekte (optional)</label>
      <input id="m-tags" type="text" autocomplete="off" autocapitalize="off" placeholder="#Ferien #Auto"
             value="${esc((prefill?.tags || []).map(t => '#' + t).join(' '))}" oninput="renderTagSuggestions()">
      <div id="m-tag-suggest" class="tag-suggest"></div>
    </div>`;
}

// Autovervollständigung: Vorschläge passend zum aktuell getippten Wort
function renderTagSuggestions() {
  const input = el('m-tags'), box = el('m-tag-suggest');
  if (!input || !box) return;
  const typed = input.value.split(/[\s,;]+/);
  const current = normTag(typed[typed.length - 1] || '').toLowerCase();
  const used = new Set(parseTags(input.value).map(t => t.toLowerCase()));
  const sugg = allTags().filter(t => !used.has(t.toLowerCase()) || t.toLowerCase() === current)
    .filter(t => !current || (t.toLowerCase().startsWith(current) && t.toLowerCase() !== current)).slice(0, 8);
  box.innerHTML = sugg.map(t => `<button type="button" class="tag-chip" onclick="pickTag('${esc(t)}')">#${esc(t)}</button>`).join('');
}

function pickTag(tag) {
  const input = el('m-tags');
  const parts = input.value.split(/([\s,;]+)/);
  const last = parts[parts.length - 1];
  if (last && !/^[\s,;]+$/.test(last)) parts[parts.length - 1] = '#' + tag;   // angefangenes Wort ersetzen
  else parts.push('#' + tag);
  input.value = parts.join('').trim() + ' ';
  input.focus();
  renderTagSuggestions();
}

const tagExtra = {
  html: tagFieldHtml,
  mounted: () => renderTagSuggestions(),
  read: data => { data.tags = parseTags(el('m-tags')?.value); }
};

function filterByTag(tag) {
  closeModal();
  navigate('ausgaben');
  const s = el('tx-search');
  if (s) { s.value = '#' + tag; renderTransactions(); setTimeout(() => s.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); }
}

// ── Wunschliste mit Wartezeit ─────────────────────────────────────────────
let wishIdInModal = null;
const wishReady = w => w.status === 'waiting' && daysUntil(w.waitUntil) <= 0;
const safeLink = url => /^https?:\/\//i.test(url || '') ? url : '';

function savedByWaiting(year = null) {
  return state.wishlist.filter(w => w.status === 'dropped' && (!year || (w.decidedAt || '').startsWith(String(year))))
    .reduce((s, w) => s + (w.price || 0), 0);
}

function renderWishlist() {
  const box = el('wishlist-section');
  if (!box) return;
  const waiting = state.wishlist.filter(w => w.status === 'waiting').sort((a, b) => a.waitUntil.localeCompare(b.waitUntil));
  const decided = state.wishlist.filter(w => w.status !== 'waiting').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));
  const year = new Date().getFullYear();
  box.innerHTML = `
    <div class="section-divider">
      <div class="sdiv-title">🛍️ Wunschliste</div>
      <div class="sdiv-line"></div>
    </div>
    ${savedByWaiting() > 0 ? `
    <div class="card wish-saved">
      <div><div class="kpi-label">Durch Warten gespart</div><div class="kpi-value green">${fmt2(savedByWaiting())}</div></div>
      <div style="text-align:right"><div class="kpi-label">davon ${year}</div><div class="kpi-value">${fmt2(savedByWaiting(year))}</div></div>
    </div>` : ''}
    ${waiting.length ? `<div class="item-list">${waiting.map(w => {
      const total = Math.max(1, dayDiff(parseISO(w.added), parseISO(w.waitUntil)));
      const left = Math.max(0, daysUntil(w.waitUntil));
      const pct = Math.min(100, (total - left) / total * 100);
      const link = safeLink(w.link);
      return `
      <div class="pot">
        <div class="pot-head" style="margin-bottom:8px">
          <div class="item-icon" style="background:rgba(99,102,241,.15)">🛍️</div>
          <div style="flex:1;min-width:0">
            <div class="item-name">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener" class="wish-link">${esc(w.name)} ↗</a>` : esc(w.name)}</div>
            <div class="item-sub">${fmt2(w.price)}${workTimeLabel(w.price, true) ? ' · ' + workTimeLabel(w.price, true) : ''}</div>
          </div>
          <button class="btn btn-danger btn-icon" onclick="deleteWish('${w.id}')" aria-label="Löschen">🗑️</button>
        </div>
        <div class="pot-bar"><div class="pot-fill" style="width:${pct}%;background:var(--primary)"></div></div>
        <div class="pot-nums"><span>Hinzugefügt ${fmtDate(w.added)}</span>
          <span>${left > 0 ? `noch <strong>${left} Tag${left === 1 ? '' : 'e'}</strong> warten` : '<strong style="color:var(--green)">Wartezeit vorbei</strong>'}</span></div>
        ${left <= 0 ? wishDecisionButtons(w) : ''}
      </div>`;
    }).join('')}</div>` : ''}
    <div style="margin-top:8px"><button class="add-btn" onclick="openWishModal()">+ Wunsch hinzufügen</button></div>
    ${decided.length ? `
    <details class="extra-section" style="margin-top:10px">
      <summary>Entschieden (${decided.length})</summary>
      ${decided.map(w => `<div class="safe-row"><span>${w.status === 'bought' ? '🛒' : '💚'} ${esc(w.name)} <span style="color:var(--text2)">· ${fmtDate(w.decidedAt)}</span></span>
        <strong style="color:${w.status === 'dropped' ? 'var(--green)' : 'var(--text2)'}">${w.status === 'dropped' ? 'gespart ' : ''}${fmt2(w.price)}</strong></div>`).join('')}
    </details>` : ''}`;
}

function wishDecisionButtons(w) {
  return `<div class="wish-actions">
    <button class="btn btn-primary" onclick="buyWish('${w.id}')">Kaufen</button>
    <button class="btn btn-ghost" onclick="dropWish('${w.id}')">Nicht mehr</button>
    <button class="btn btn-ghost" onclick="waitWish('${w.id}')">Weiter warten</button>
  </div>`;
}

function openWishModal() {
  const days = state.settings.wishWaitDays || 30;
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">🛍️ Wunsch hinzufügen</div>
      <div class="field"><label>Was möchtest du kaufen?</label><input id="w-name" type="text" placeholder="z.B. Kopfhörer"></div>
      <div class="field"><label>Preis (${state.currency})</label><input id="w-price" type="number" inputmode="decimal" step="any" oninput="el('w-work').textContent = workTimeLabel(parseFloat(this.value), true)"></div>
      <div id="w-work" class="workprice"></div>
      <div class="field"><label>Link (optional)</label><input id="w-link" type="url" inputmode="url" placeholder="https://…"></div>
      <div class="field"><label>Wartezeit (Tage)</label><input id="w-days" type="number" inputmode="numeric" min="1" value="${days}"></div>
      <div style="font-size:12px;color:var(--text2)">Nach Ablauf fragt dich die App in der Übersicht, ob du es noch willst.</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveWish()">Speichern</button>
      </div>
    </div>
  </div>`);
}

function saveWish() {
  const name = el('w-name').value.trim(), price = parseFloat(el('w-price').value);
  if (!name || !(price > 0)) { toast('Name und Preis angeben'); return; }
  const days = Math.max(1, parseInt(el('w-days').value) || state.settings.wishWaitDays || 30);
  state.wishlist.push({ id: uid(), name, price: round2(price), link: safeLink(el('w-link').value.trim()),
    added: localISO(), waitUntil: isoDate(addDays(midnight(), days)), status: 'waiting' });
  saveState(); closeModal(); toast(`Gemerkt – in ${days} Tagen fragen wir nach ✓`); refreshCurrent();
}

function buyWish(id) {
  const w = state.wishlist.find(x => x.id === id);
  if (!w) return;
  openTransactionModal({ name: w.name, amount: w.price, type: 'expense', category: 'Ausgabe', note: w.link || '', wishId: w.id });
}
function dropWish(id) {
  const w = state.wishlist.find(x => x.id === id);
  Object.assign(w, { status: 'dropped', decidedAt: localISO() });
  saveState(); toast(`💚 ${fmt2(w.price)} durch Warten gespart`); refreshCurrent();
}
function waitWish(id) {
  const w = state.wishlist.find(x => x.id === id);
  w.waitUntil = isoDate(addDays(midnight(), state.settings.wishWaitDays || 30));
  saveState(); toast('Okay, wir fragen später nochmals'); refreshCurrent();
}
function deleteWish(id) {
  if (!confirm('Wunsch löschen?')) return;
  state.wishlist = state.wishlist.filter(x => x.id !== id);
  saveState(); refreshCurrent();
}

// Kauf über die Wunschliste: nach dem Speichern der Buchung als gekauft markieren
const wishPurchaseExtra = {
  html: () => '',
  mounted: prefill => { wishIdInModal = prefill?.wishId || null; },
  read: () => {},
  after: tx => {
    const w = wishIdInModal && state.wishlist.find(x => x.id === wishIdInModal);
    if (w) Object.assign(w, { status: 'bought', decidedAt: localISO(), txId: tx.id });
    wishIdInModal = null;
  }
};

DASH_ALERTS.push(() => state.wishlist.filter(wishReady).map(w => `
  <div class="alert-row alert-blue">
    <span>🛍️</span><span style="flex:1"><strong>Willst du „${esc(w.name)}“ noch?</strong>
      <br><span class="alert-sub">${fmt2(w.price)} · seit ${fmtDate(w.added)} auf der Wunschliste${workTimeLabel(w.price, true) ? ' · ' + workTimeLabel(w.price, true) : ''}</span>
      ${wishDecisionButtons(w)}</span>
  </div>`).join(''));

// ── Projekte (Tags) ───────────────────────────────────────────────────────
let projectRange = 'all';
const PROJECT_RANGES = { all: 'Alle', year: 'Dieses Jahr', last12: '12 Monate' };

function projectStats() {
  const today = localISO();
  const from = projectRange === 'year' ? `${today.slice(0, 4)}-01-01`
    : projectRange === 'last12' ? isoDate(addDays(parseISO(addMonthsISO(today, -12)), 1)) : '0000';
  const map = new Map();
  for (const t of state.transactions || []) {
    if (!t.tags?.length || t.date < from) continue;
    for (const tag of t.tags) {
      const k = tag.toLowerCase();
      const p = map.get(k) || { tag, total: 0, count: 0, first: t.date, last: t.date, cats: {} };
      const v = t.type === 'income' ? -t.amount : t.amount;
      p.total += v; p.count++;
      if (t.date < p.first) p.first = t.date;
      if (t.date > p.last) p.last = t.date;
      if (t.type !== 'income') p.cats[t.category] = (p.cats[t.category] || 0) + t.amount;
      map.set(k, p);
    }
  }
  // Regelmässige Ausgaben mit Tag: Monatsdurchschnitt separat ausweisen
  for (const e of state.expenses) for (const tag of e.tags || []) {
    const k = tag.toLowerCase();
    const p = map.get(k) || { tag, total: 0, count: 0, first: null, last: null, cats: {} };
    p.recurring = (p.recurring || 0) + monthlyAmt(e);
    map.set(k, p);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function renderProjects() {
  const box = el('projects-section');
  if (!box) return;
  const list = projectStats();
  box.innerHTML = `
    <div class="section-divider">
      <div class="sdiv-title">🏷️ Projekte</div>
      <div class="sdiv-line"></div>
    </div>
    <div class="toggle-group" style="margin-bottom:10px">
      ${Object.entries(PROJECT_RANGES).map(([k, l]) => `<span class="toggle-btn ${projectRange === k ? 'active' : ''}" onclick="projectRange='${k}';renderProjects()">${l}</span>`).join('')}
    </div>
    ${list.length ? `<div class="item-list">${list.map(p => {
      const budget = state.tagBudgets[p.tag.toLowerCase()];
      const pct = budget ? Math.min(100, p.total / budget * 100) : 0;
      const cats = Object.entries(p.cats).sort((a, b) => b[1] - a[1]);
      const catSum = cats.reduce((s, [, v]) => s + v, 0) || 1;
      return `
      <div class="pot">
        <div class="pot-head" style="margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div class="item-name">#${esc(p.tag)}</div>
            <div class="item-sub">${p.count} Buchung${p.count === 1 ? '' : 'en'}${p.first ? ` · ${fmtDate(p.first)}${p.last !== p.first ? ' – ' + fmtDate(p.last) : ''}` : ''}</div>
          </div>
          <div style="text-align:right"><div class="item-amount">${fmt2(p.total)}</div>
            ${p.recurring ? `<div style="font-size:10px;color:var(--text2)">+ ${fmt2(p.recurring)}/Mt. regelmässig</div>` : ''}</div>
        </div>
        ${budget ? `<div class="pot-bar"><div class="pot-fill" style="width:${pct}%;background:${p.total > budget ? 'var(--red)' : pct > 80 ? 'var(--yellow)' : 'var(--green)'}"></div></div>
          <div class="pot-nums"><span>Budget ${fmt2(budget)}</span><span>${p.total > budget ? `<strong style="color:var(--red)">${fmt2(p.total - budget)} drüber</strong>` : `noch ${fmt2(budget - p.total)}`}</span></div>` : ''}
        ${cats.length ? `<div class="alloc-bar" style="margin-top:8px">${cats.map(([c, v]) => `<div class="alloc-seg" style="width:${(v / catSum * 100).toFixed(1)}%;background:${colorFor(c)}" title="${esc(c)}"></div>`).join('')}</div>
          <div class="alloc-legend">${cats.slice(0, 4).map(([c, v]) => `<span class="alloc-badge"><span class="alloc-dot" style="background:${colorFor(c)}"></span><span class="alloc-cat">${esc(c)}</span><span class="alloc-pct">${(v / catSum * 100).toFixed(0)}%</span></span>`).join('')}</div>` : ''}
        <div class="pot-actions">
          <button class="btn btn-ghost" onclick="openTagBudget('${esc(p.tag)}')">💰 Budget</button>
          <button class="btn btn-ghost" onclick="filterByTag('${esc(p.tag)}')">📒 Buchungen</button>
        </div>
      </div>`;
    }).join('')}</div>`
    : `<div class="card" style="font-size:13px;color:var(--text2)">Gib Buchungen Tags wie <strong>#Ferien</strong> oder <strong>#Auto</strong> – hier siehst du dann, was jedes Projekt gekostet hat.</div>`}`;
}

function openTagBudget(tag) {
  const cur = state.tagBudgets[tag.toLowerCase()] || '';
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">Budget für #${esc(tag)}</div>
      <div class="field"><label>Budget (${state.currency}, leer = keines)</label><input id="tb-amount" type="number" inputmode="decimal" step="any" value="${cur}"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveTagBudget('${esc(tag)}')">Speichern</button>
      </div>
    </div>
  </div>`);
}
function saveTagBudget(tag) {
  const v = parseFloat(el('tb-amount').value);
  if (v > 0) state.tagBudgets[tag.toLowerCase()] = round2(v); else delete state.tagBudgets[tag.toLowerCase()];
  saveState(); closeModal(); refreshCurrent();
}

// ── Persönliche Teuerung ──────────────────────────────────────────────────
// Ausgaben pro Kategorie der letzten 12 abgeschlossenen Budgetmonate vs. die 12 davor,
// gewichtet nach Anteil am aktuellen Budget.
function personalInflation() {
  const expenses = (state.transactions || []).filter(t => t.type !== 'income');
  if (!expenses.length) return { months: 0 };
  const firstKey = periodKeyOf(parseISO(expenses.reduce((m, t) => t.date < m ? t.date : m, expenses[0].date)));
  const lastClosed = shiftKey(periodKeyOf(), -1);
  let months = 0;
  for (let k = firstKey; k <= lastClosed && months < 1000; k = shiftKey(k, 1)) months++;
  if (months < 13) return { months };
  const sumCats = keys => {
    const c = {};
    for (const k of keys) for (const t of txOfMonth(k)) if (t.type !== 'income') c[t.category] = (c[t.category] || 0) + t.amount;
    return c;
  };
  const recentKeys = Array.from({ length: 12 }, (_, i) => shiftKey(lastClosed, -i));
  const prevN = Math.min(12, months - 12);
  const prevKeys = Array.from({ length: prevN }, (_, i) => shiftKey(lastClosed, -12 - i));
  const A = sumCats(recentKeys), B = sumCats(prevKeys);
  const cats = Object.keys(A).filter(c => B[c] > 0).map(c => {
    const now = A[c] / 12, before = B[c] / prevN;
    return { cat: c, now, before, change: now / before - 1 };
  });
  const totalNow = cats.reduce((s, x) => s + x.now, 0);
  const rate = totalNow ? cats.reduce((s, x) => s + (x.now / totalNow) * x.change, 0) : 0;
  return { months, rate, cats: cats.sort((a, b) => b.change - a.change), prevN };
}

function renderInflation() {
  const box = el('inflation-section');
  if (!box) return;
  const r = personalInflation();
  const lik = state.settings.likRate;
  const pct = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} %`;
  box.innerHTML = `
    <div class="section-divider" style="margin-top:20px">
      <div class="sdiv-title">📈 Persönliche Teuerung</div>
      <div class="sdiv-line"></div>
    </div>
    <div class="card">
    ${r.months < 13 ? `
      <div style="font-size:13px;color:var(--text2)">Noch zu wenig Daten (${r.months} von 13 Monaten). Die Auswertung vergleicht deine Ausgaben der letzten 12 Monate mit den 12 Monaten davor.</div>
      <div class="rate-bar" style="margin-top:10px"><div class="rate-fill" style="width:${Math.min(100, r.months / 13 * 100)}%;background:var(--primary)"></div></div>` : `
      <div class="kpi-grid" style="margin-bottom:12px">
        <div class="kpi-item"><div class="kpi-label">Deine persönliche Teuerung</div><div class="kpi-value ${r.rate > (lik ?? 0) / 100 ? 'red' : 'green'}">${pct(r.rate)}</div></div>
        <div class="kpi-item"><div class="kpi-label">LIK (Landesindex)</div><div class="kpi-value">${lik != null && lik !== '' ? pct(lik / 100) : '–'}</div>
          ${lik == null || lik === '' ? '<div style="font-size:10px;color:var(--text2)">unter ⚙️ eintragen</div>' : ''}</div>
      </div>
      <div class="card-title" style="margin-bottom:6px">Am stärksten gestiegen</div>
      ${r.cats.slice(0, 5).map(c => `
        <div class="safe-row"><span>${iconFor(c.cat)} ${esc(c.cat)} <span style="color:var(--text2)">${fmt(c.before)} → ${fmt(c.now)}/Mt.</span></span>
          <strong style="color:${c.change > 0 ? 'var(--red)' : 'var(--green)'}">${pct(c.change)}</strong></div>`).join('')}
      <div style="font-size:11px;color:var(--text2);margin-top:8px;line-height:1.5">Basis: Ø pro Monat, letzte 12 vs. ${r.prevN} Monate davor, gewichtet nach Anteil am Budget.
        Hinweis: Mehr Ausgaben bedeuten nicht nur höhere Preise, sondern oft auch mehr Konsum.</div>`}
    </div>`;
}

// ── Einstellungen ─────────────────────────────────────────────────────────
SETTINGS_SECTIONS.push({
  title: 'Entscheidungshilfen',
  html: () => {
    const s = state.settings;
    return `
      <label class="check-row"><input id="set-workprice" type="checkbox" ${s.workPriceEnabled ? 'checked' : ''}>
        <span>Preis in Arbeitsstunden anzeigen<br><span style="font-size:12px;color:var(--text2)">Netto-Stundenlohn aktuell: ${netHourlyWage() ? fmt2(netHourlyWage()) : '– (Einkommen erfassen)'}</span></span></label>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Arbeitsstunden/Woche</label><input id="set-hours" type="number" inputmode="decimal" step="0.5" value="${s.workHoursPerWeek}"></div>
        <div class="field" style="flex:1"><label>Ab Betrag (${state.currency})</label><input id="set-wp-threshold" type="number" inputmode="decimal" value="${s.workPriceThreshold}"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Wartezeit Wunschliste (Tage)</label><input id="set-wish-days" type="number" inputmode="numeric" min="1" value="${s.wishWaitDays}"></div>
        <div class="field" style="flex:1"><label>Teuerung LIK (%)</label><input id="set-lik" type="number" inputmode="decimal" step="0.1" placeholder="z.B. 0.7" value="${s.likRate ?? ''}"></div>
      </div>`;
  },
  save: () => {
    const s = state.settings;
    s.workPriceEnabled = el('set-workprice').checked;
    s.workHoursPerWeek = Math.max(1, parseFloat(el('set-hours').value) || 42);
    s.workPriceThreshold = Math.max(0, parseFloat(el('set-wp-threshold').value) || 0);
    s.wishWaitDays = Math.max(1, parseInt(el('set-wish-days').value) || 30);
    const lik = el('set-lik').value.trim();
    s.likRate = lik === '' ? null : parseFloat(lik);
  }
});

TX_MODAL_EXTRAS.unshift(workPriceExtra, tagExtra, wishPurchaseExtra);
EXPENSE_MODAL_EXTRAS.unshift(workPriceExtra, tagExtra);
PAGE_HOOKS.ziele.push(renderWishlist, renderProjects);
PAGE_HOOKS.ausgaben.push(renderInflation);
