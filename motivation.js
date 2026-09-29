'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Phase 4 – Motivation
//   Spar-Serien · Meilensteine mit Konfetti · Jahresrückblick ("Wrapped")
// ══════════════════════════════════════════════════════════════════════════

// ── Spar-Serien ───────────────────────────────────────────────────────────
// Gespart in einem Budgetmonat = Investitionen + was vom freien Budget übrig blieb
// (gleiche Logik wie die Karte "Dieser Monat"; über "Bezahlt" erfasste Fixkosten nicht doppelt)
function periodSaved(key) {
  const { saldo, plannedExpense, txs } = monthTotals(key);
  return { saved: round2(totalInvestments() + cashflowFree() + saldo + plannedExpense), noData: txs.length === 0 };
}

function savingsTarget() {
  const s = state.settings;
  return round2(s.savingsGoalType === 'chf' ? (s.savingsGoalValue || 0) : totalIncome() * (s.savingsGoalValue || 0) / 100);
}

// Abgeschlossene Budgetmonate einmalig auswerten (beim Öffnen der App)
function evaluateStreaks() {
  const st = state.streak;
  const lastClosed = shiftKey(periodKeyOf(), -1);
  if (!st.startKey) {
    // Nachträglich ab dem ersten Monat mit Buchungen (max. 24), sonst ab jetzt
    const dates = (state.transactions || []).map(t => t.date).sort();
    const first = dates.length ? periodKeyOf(parseISO(dates[0])) : periodKeyOf();
    st.startKey = first < shiftKey(lastClosed, -23) ? shiftKey(lastClosed, -23) : first;
  }
  if (totalIncome() <= 0) return false;            // ohne Einkommen keine sinnvolle Auswertung
  let changed = false;
  for (let k = st.startKey; k <= lastClosed; k = shiftKey(k, 1)) {
    if (st.history[k]) continue;
    const { saved, noData } = periodSaved(k);
    const target = savingsTarget();
    st.history[k] = { saved, target, hit: saved >= target, noData };
    changed = true;
  }
  return changed;
}

function streakStats() {
  const h = state.streak.history;
  const keys = Object.keys(h).sort();
  let current = 0;
  for (let i = keys.length - 1; i >= 0 && h[keys[i]].hit; i--) current++;
  let longest = 0, run = 0;
  for (const k of keys) { run = h[k].hit ? run + 1 : 0; longest = Math.max(longest, run); }
  return { current, longest, keys };
}

function renderStreak() {
  const box = el('dash-streak');
  if (!box) return;
  if (totalIncome() <= 0) {
    box.innerHTML = `<div class="card"><div class="card-title">🔥 Spar-Serie</div>
      <div style="font-size:13px;color:var(--text2)">Erfasse dein Einkommen – danach wird jeder abgeschlossene Budgetmonat mit deinem Sparziel verglichen.</div></div>`;
    return;
  }
  const { current, longest } = streakStats();
  const s = state.settings;
  const goal = s.savingsGoalType === 'chf' ? fmt(s.savingsGoalValue) : `${s.savingsGoalValue}% vom Einkommen`;
  const lastKey = shiftKey(periodKeyOf(), -1);
  const cal = Array.from({ length: 12 }, (_, i) => shiftKey(lastKey, i - 11)).map(k => {
    const r = state.streak.history[k];
    return `<div class="streak-cell ${r ? (r.hit ? 'hit' : 'miss') : 'none'}" title="${periodLabel(k)}${r ? ` · gespart ${fmt(r.saved)} / Ziel ${fmt(r.target)}` : ''}">
      <span>${periodLabel(k, true).replace('.', '')}</span></div>`;
  }).join('');
  const now = periodSaved(periodKeyOf());
  box.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div class="card-title" style="margin-bottom:0">🔥 Spar-Serie</div>
      <button class="toggle-btn" onclick="openSettings()">Ziel: ${goal}</button>
    </div>
    <div class="streak-head">
      <div><div class="streak-num">${current}</div><div class="kpi-label">Monat${current === 1 ? '' : 'e'} in Folge</div></div>
      <div><div class="streak-num" style="color:var(--text2)">${longest}</div><div class="kpi-label">längste Serie</div></div>
      <div><div class="streak-num" style="font-size:18px;color:${now.saved >= savingsTarget() ? 'var(--green)' : 'var(--text)'}">${fmt(now.saved)}</div><div class="kpi-label">diesen Monat (Ziel ${fmt(savingsTarget())})</div></div>
    </div>
    <div class="streak-cal">${cal}</div>
    <div style="font-size:11px;color:var(--text2);margin-top:6px">Ausgewertet wird jeder abgeschlossene Budgetmonat: Investitionen + nicht ausgegebenes freies Budget.</div>
  </div>`;
}

// ── Meilensteine ──────────────────────────────────────────────────────────
const NW_STEPS = [1e3, 5e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7];

function currentAchievements() {
  const out = [];
  const nw = netWorth();
  for (const n of NW_STEPS) if (nw >= n) out.push({ id: `nw-${n}`, icon: '💎', label: `Nettovermögen ${fmt(n)}` });
  if (totalExpenses() + totalDebtPay() > 0) {
    const m = emergencyMonths();
    if (m >= 3) out.push({ id: 'emergency-50', icon: '🛟', label: 'Notfallfonds zu 50 % gefüllt (3 Monate)' });
    if (m >= 6) out.push({ id: 'emergency-100', icon: '🛟', label: 'Notfallfonds zu 100 % gefüllt (6 Monate)' });
  }
  if (totalInvestments() > 0 || state.portfolioValue > 0) out.push({ id: 'first-invest', icon: '📈', label: 'Erste Investition' });
  if (state.settings.hadDebt && totalDebt() <= 0) out.push({ id: 'debt-free', icon: '🕊️', label: 'Schuldenfrei!' });
  for (const g of state.goals) if (g.targetAmount > 0 && g.currentAmount >= g.targetAmount)
    out.push({ id: `goal-${g.id}`, icon: g.icon || '🎯', label: `Sparziel erreicht: ${g.name}` });
  return out;
}

// Neu erreichte Meilensteine speichern (einmalig – kein erneutes Feiern nach Rückfall)
function checkMilestones() {
  if (totalDebt() > 0 && !state.settings.hadDebt) state.settings.hadDebt = true;
  const known = new Set(state.milestones.map(m => m.id));
  const fresh = currentAchievements().filter(a => !known.has(a.id));
  if (!fresh.length && state.settings.milestonesInit) return;
  const initial = !state.settings.milestonesInit;   // erster Lauf nach Update: still übernehmen
  for (const a of fresh) state.milestones.push({ ...a, date: localISO(), initial });
  state.settings.milestonesInit = true;
  saveState();
  if (!initial && fresh.length) celebrate(fresh);
}

function celebrate(items) {
  confetti();
  document.getElementById('celebration')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="celebration" class="celebration" onclick="this.remove()">
      <div class="celebration-card">
        <div style="font-size:44px">🎉</div>
        <div style="font-size:13px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px">Neuer Meilenstein</div>
        ${items.map(i => `<div class="celebration-item">${i.icon} ${esc(i.label)}</div>`).join('')}
        <div style="font-size:12px;color:var(--text2);margin-top:10px">Tippen zum Schliessen</div>
      </div>
    </div>`);
  setTimeout(() => document.getElementById('celebration')?.remove(), 6000);
}

// Dezentes Konfetti (einmalig, ~2.5 s, respektiert "Bewegung reduzieren")
function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#eab308'];
  const parts = Array.from({ length: 110 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 80, y: innerHeight * .35,
    vx: (Math.random() - .5) * 11, vy: -Math.random() * 11 - 4, r: Math.random() * 6 + 4,
    rot: Math.random() * 6, vr: (Math.random() - .5) * .3, color: colors[Math.floor(Math.random() * colors.length)]
  }));
  const start = performance.now();
  (function frame(t) {
    const age = t - start;
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.globalAlpha = Math.max(0, 1 - age / 2600);
    for (const p of parts) {
      p.vy += .32; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.color; g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g.restore();
    }
    if (age < 2600) requestAnimationFrame(frame); else c.remove();
  })(start);
}

function renderMilestones() {
  const box = el('milestones-section');
  if (!box) return;
  const list = [...state.milestones].sort((a, b) => b.date.localeCompare(a.date));
  const next = NW_STEPS.find(n => netWorth() < n);
  box.innerHTML = `
    <div class="section-divider">
      <div class="sdiv-title">🏆 Meilensteine</div>
      <div class="sdiv-line"></div>
    </div>
    <div class="card">
      ${next ? `<div style="font-size:12px;color:var(--text2);margin-bottom:6px">Nächster: Nettovermögen ${fmt(next)} (noch ${fmt(next - netWorth())})</div>
        <div class="rate-bar" style="margin-bottom:${list.length ? 12 : 0}px"><div class="rate-fill" style="width:${Math.max(0, Math.min(100, netWorth() / next * 100))}%;background:linear-gradient(90deg,var(--primary),var(--primary-light))"></div></div>` : ''}
      ${list.length ? list.map(m => `
        <div class="milestone-line"><span>${m.icon}</span><span style="flex:1">${esc(m.label)}</span>
          <span class="alert-sub">${m.initial ? 'bereits erreicht' : fmtDate(m.date)}</span></div>`).join('')
      : '<div style="font-size:13px;color:var(--text2)">Noch keine Meilensteine – der erste kommt bestimmt!</div>'}
    </div>`;
}

// ── Jahresrückblick ("Wrapped") ───────────────────────────────────────────
function yearStats(year) {
  const Y = String(year);
  const txs = (state.transactions || []).filter(t => t.date?.startsWith(Y));
  const now = new Date();
  const months = year < now.getFullYear() ? 12 : year === now.getFullYear() ? now.getMonth() + 1 : 0;
  const incTx = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expTx = txs.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  // Fehlen gebuchte Einnahmen, gelten die Planwerte (Lohn wird oft nicht als Buchung erfasst)
  const earned = incTx || totalIncome() * months;
  const planned = !incTx;
  const fixed = planned ? (totalExpenses() + totalDebtPay()) * months : 0;
  const spent = expTx + fixed;
  const invested = totalInvestments() * months;
  const saved = earned - spent;
  const rate = earned > 0 ? saved / earned : 0;
  const cats = y => {
    const c = {};
    for (const t of (state.transactions || []).filter(t => t.date?.startsWith(String(y)) && t.type !== 'income')) c[t.category] = (c[t.category] || 0) + t.amount;
    return c;
  };
  const catsNow = cats(year), catsPrev = cats(year - 1);
  const top = Object.entries(catsNow).sort((a, b) => b[1] - a[1])[0];
  const topCat = top ? { cat: top[0], amount: top[1], prev: catsPrev[top[0]] || 0 } : null;
  // Bester / schwächster Monat: Einnahmen − Ausgaben pro Kalendermonat
  const perMonth = Array.from({ length: months }, (_, m) => {
    const k = `${Y}-${String(m + 1).padStart(2, '0')}`;
    const mt = txs.filter(t => t.date.startsWith(k));
    const inc = mt.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0) || (planned ? totalIncome() : 0);
    const exp = mt.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0) + (planned ? totalExpenses() + totalDebtPay() : 0);
    return { k, saved: inc - exp, hasTx: mt.length > 0 };
  }).filter(m => m.hasTx);
  const best = perMonth.length ? perMonth.reduce((a, b) => b.saved > a.saved ? b : a) : null;
  const worst = perMonth.length > 1 ? perMonth.reduce((a, b) => b.saved < a.saved ? b : a) : null;
  // Vermögenszuwachs aus Snapshots
  const snaps = state.networthHistory.filter(h => h.date.startsWith(Y));
  const before = [...state.networthHistory].filter(h => h.date < `${Y}-01-01`).pop();
  const nwStart = before || snaps[0], nwEnd = snaps[snaps.length - 1];
  const nwGrowth = nwStart && nwEnd && nwEnd !== nwStart ? nwEnd.networth - nwStart.networth : null;
  // Teuerstes Projekt
  const proj = {};
  for (const t of txs) for (const tag of t.tags || []) proj[tag] = (proj[tag] || 0) + (t.type === 'income' ? -t.amount : t.amount);
  const topProj = Object.entries(proj).sort((a, b) => b[1] - a[1])[0];
  // Serie & Meilensteine im Jahr
  const hist = state.streak.history;
  let longest = 0, run = 0;
  for (const k of Object.keys(hist).sort().filter(k => k.startsWith(Y))) { run = hist[k].hit ? run + 1 : 0; longest = Math.max(longest, run); }
  const milestones = state.milestones.filter(m => !m.initial && m.date.startsWith(Y));
  return { year, months, earned, spent, invested, saved, rate, planned, topCat, best, worst, nwGrowth,
           topProj: topProj ? { tag: topProj[0], amount: topProj[1] } : null,
           waited: typeof savedByWaiting === 'function' ? savedByWaiting(year) : 0, longest, milestones, txCount: txs.length };
}

function wrappedYears() {
  const now = new Date();
  const ys = new Set((state.transactions || []).map(t => +t.date.slice(0, 4)).filter(y => y < now.getFullYear()));
  if (now.getMonth() === 11) ys.add(now.getFullYear());   // ab 1. Dezember
  return [...ys].sort((a, b) => b - a);
}

function renderWrappedEntry() {
  const dash = el('dash-wrapped');
  const now = new Date();
  if (dash) dash.innerHTML = now.getMonth() === 11 ? `
    <div class="card wrapped-teaser" onclick="openWrapped(${now.getFullYear()})">
      <div style="font-size:28px">✨</div>
      <div><div style="font-weight:700">Dein Jahresrückblick ${now.getFullYear()}</div>
      <div style="font-size:12px;color:rgba(255,255,255,.75)">Was du dieses Jahr erreicht hast – tippen zum Ansehen</div></div>
    </div>` : '';
}

function renderWrappedSection() {
  const box = el('wrapped-section');
  if (!box) return;
  const years = wrappedYears();
  box.innerHTML = `
    <div class="section-divider">
      <div class="sdiv-title">✨ Jahresrückblick</div>
      <div class="sdiv-line"></div>
    </div>
    <div class="card">
      ${years.length ? `<div class="toggle-group" style="flex-wrap:wrap">${years.map(y => `<span class="toggle-btn" onclick="openWrapped(${y})">${y} ansehen</span>`).join('')}</div>`
        : '<div style="font-size:13px;color:var(--text2)">Ab dem 1. Dezember gibt es hier deinen Rückblick aufs Jahr – vergangene Jahre, sobald Buchungen vorhanden sind.</div>'}
    </div>`;
}

let wrapped = null;
const pctFmt = v => `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(0)} %`;

function wrappedCards(y) {
  const c = [];
  const monthName = k => { const [yy, m] = k.split('-'); return new Date(yy, m - 1, 1).toLocaleDateString('de-CH', { month: 'long' }); };
  c.push({ bg: 'g1', html: `<div class="w-kicker">Dein Jahr</div><div class="w-huge">${y.year}</div><div class="w-sub">in Zahlen – tippe rechts für weiter</div>` });
  c.push({ bg: 'g2', html: `<div class="w-kicker">Verdient</div><div class="w-big">${fmt(y.earned)}</div>
    <div class="w-kicker" style="margin-top:22px">Ausgegeben</div><div class="w-big">${fmt(y.spent)}</div>
    ${y.planned ? '<div class="w-sub">Einnahmen & Fixkosten aus deinen Planwerten, variable Ausgaben aus Buchungen</div>' : ''}` });
  c.push({ bg: 'g3', html: `<div class="w-kicker">Gespart</div><div class="w-big">${fmt(y.saved)}</div>
    <div class="w-kicker" style="margin-top:22px">davon investiert (geplant)</div><div class="w-big">${fmt(y.invested)}</div>
    <div class="w-kicker" style="margin-top:22px">Sparquote</div><div class="w-huge">${pctFmt(y.rate)}</div>` });
  if (y.topCat) {
    const diff = y.topCat.prev ? y.topCat.amount / y.topCat.prev - 1 : null;
    c.push({ bg: 'g4', html: `<div class="w-kicker">Grösste Ausgabenkategorie</div><div class="w-emoji">${iconFor(y.topCat.cat)}</div>
      <div class="w-big">${esc(y.topCat.cat)}</div><div class="w-sub">${fmt(y.topCat.amount)}${diff != null ? ` · ${diff >= 0 ? '+' : '−'}${Math.abs(diff * 100).toFixed(0)} % vs. ${y.year - 1}` : ''}</div>` });
  }
  if (y.best) c.push({ bg: 'g5', html: `<div class="w-kicker">Bester Sparmonat</div><div class="w-big">${monthName(y.best.k)}</div><div class="w-sub">${fmt(y.best.saved)}</div>
    ${y.worst && y.worst.k !== y.best.k ? `<div class="w-kicker" style="margin-top:22px">Schwächster Monat</div><div class="w-big">${monthName(y.worst.k)}</div><div class="w-sub">${fmt(y.worst.saved)}</div>` : ''}` });
  if (y.nwGrowth != null) c.push({ bg: 'g2', html: `<div class="w-kicker">Vermögenszuwachs</div><div class="w-huge">${y.nwGrowth >= 0 ? '+' : ''}${fmtK(y.nwGrowth)}</div><div class="w-sub">laut deinen Nettovermögen-Snapshots</div>` });
  if (y.topProj) c.push({ bg: 'g4', html: `<div class="w-kicker">Teuerstes Projekt</div><div class="w-big">#${esc(y.topProj.tag)}</div><div class="w-sub">${fmt(y.topProj.amount)}</div>` });
  if (y.waited > 0) c.push({ bg: 'g3', html: `<div class="w-kicker">Durch Warten gespart</div><div class="w-emoji">🛍️</div><div class="w-big">${fmt(y.waited)}</div><div class="w-sub">Dinge, die du dann doch nicht wolltest</div>` });
  if (y.milestones.length || y.longest) c.push({ bg: 'g5', html: `<div class="w-kicker">Erfolge</div>
    ${y.longest ? `<div class="w-big">🔥 ${y.longest} Monat${y.longest === 1 ? '' : 'e'}</div><div class="w-sub">längste Spar-Serie</div>` : ''}
    ${y.milestones.map(m => `<div class="w-line">${m.icon} ${esc(m.label)}</div>`).join('')}` });
  c.push({ bg: 'g1', last: true, html: `<div class="w-kicker">${y.year} – Zusammenfassung</div>
    <div class="w-grid">
      <div><span>Sparquote</span><strong>${pctFmt(y.rate)}</strong></div>
      <div><span>Gespart</span><strong class="w-amt">${fmtK(y.saved)}</strong></div>
      ${y.longest ? `<div><span>Längste Serie</span><strong>🔥 ${y.longest}</strong></div>` : ''}
      <div><span>Meilensteine</span><strong>🏆 ${y.milestones.length}</strong></div>
    </div>
    <label class="w-check" onclick="event.stopPropagation()"><input type="checkbox" id="w-hide" onchange="wrapped.hide=this.checked"> Beträge ausblenden (nur Prozente)</label>
    <button class="btn btn-primary" onclick="event.stopPropagation();shareWrapped()">📤 Als Bild teilen / speichern</button>` });
  return c;
}

function openWrapped(year) {
  const y = yearStats(year);
  wrapped = { year, y, cards: wrappedCards(y), i: 0, hide: false };
  document.getElementById('wrapped')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div id="wrapped" class="wrapped"></div>`);
  document.body.classList.add('modal-open');
  const box = document.getElementById('wrapped');
  let x0 = null;
  box.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) { wrappedGo(dx < 0 ? 1 : -1); e.preventDefault(); }
  });
  renderWrappedCard();
}

function renderWrappedCard() {
  const box = document.getElementById('wrapped');
  if (!box || !wrapped) return;
  const card = wrapped.cards[wrapped.i];
  box.className = `wrapped w-${card.bg}`;
  box.innerHTML = `
    <div class="w-progress">${wrapped.cards.map((_, i) => `<span class="${i <= wrapped.i ? 'on' : ''}"></span>`).join('')}</div>
    <button class="w-close" onclick="closeWrapped()" aria-label="Schliessen">✕</button>
    <div class="w-tap w-prev" onclick="wrappedGo(-1)"></div>
    <div class="w-tap w-next" onclick="wrappedGo(1)"></div>
    <div class="w-content">${card.html}</div>`;
  const hide = document.getElementById('w-hide');
  if (hide) hide.checked = wrapped.hide;
}

function wrappedGo(d) {
  if (!wrapped) return;
  const i = wrapped.i + d;
  if (i < 0) return;
  if (i >= wrapped.cards.length) { closeWrapped(); return; }
  wrapped.i = i; renderWrappedCard();
}

function closeWrapped() {
  document.getElementById('wrapped')?.remove();
  if (!el('modal-backdrop')) document.body.classList.remove('modal-open');
  wrapped = null;
}

// Zusammenfassung als PNG (1080×1350) – optional nur Prozente
async function shareWrapped() {
  const { y, hide } = wrapped;
  const W = 1080, H = 1350;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#312e81'); grad.addColorStop(1, '#0f172a');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const font = (w, s) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  g.fillStyle = 'rgba(255,255,255,.7)'; g.font = font(600, 38); g.fillText('MEIN FINANZJAHR', 90, 170);
  g.fillStyle = '#fff'; g.font = font(800, 150); g.fillText(String(y.year), 84, 320);
  const rows = [['Sparquote', pctFmt(y.rate)]];
  if (!hide) rows.push(['Gespart', fmt(y.saved)], ['Investiert', fmt(y.invested)]);
  if (y.topCat) {
    const diff = y.topCat.prev ? y.topCat.amount / y.topCat.prev - 1 : null;
    rows.push(['Grösste Kategorie', `${y.topCat.cat}${hide ? (diff != null ? ` (${diff >= 0 ? '+' : '−'}${Math.abs(diff * 100).toFixed(0)} %)` : '') : ` · ${fmt(y.topCat.amount)}`}`]);
  }
  if (y.longest) rows.push(['Längste Spar-Serie', `${y.longest} Monat${y.longest === 1 ? '' : 'e'}`]);
  rows.push(['Neue Meilensteine', String(y.milestones.length)]);
  let ty = 470;
  for (const [label, value] of rows) {
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = font(500, 34); g.fillText(label, 90, ty);
    g.fillStyle = '#fff'; g.font = font(800, 64); g.fillText(value, 90, ty + 74);
    ty += 150;
  }
  g.fillStyle = 'rgba(255,255,255,.45)'; g.font = font(500, 30); g.fillText('FinanzPlaner', 90, H - 80);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], `finanzjahr-${y.year}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Mein Finanzjahr ${y.year}` }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Bild gespeichert ✓');
}

// ── Einstellungen ─────────────────────────────────────────────────────────
SETTINGS_SECTIONS.push({
  title: 'Monatliches Sparziel (Spar-Serie)',
  html: () => {
    const s = state.settings;
    return `
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Art</label>
          <select id="set-goal-type"><option value="pct" ${s.savingsGoalType !== 'chf' ? 'selected' : ''}>% vom Einkommen</option>
          <option value="chf" ${s.savingsGoalType === 'chf' ? 'selected' : ''}>${state.currency} pro Monat</option></select></div>
        <div class="field" style="flex:1"><label>Ziel (inkl. Investitionen)</label>
          <input id="set-goal-value" type="number" inputmode="decimal" step="any" value="${s.savingsGoalValue}"></div>
      </div>`;
  },
  save: () => {
    state.settings.savingsGoalType = el('set-goal-type').value;
    state.settings.savingsGoalValue = Math.max(0, parseFloat(el('set-goal-value').value) || 0);
  }
});

PAGE_HOOKS.boot.push(() => { if (evaluateStreaks()) saveState(); });
PAGE_HOOKS.uebersicht.push(checkMilestones, renderStreak, renderWrappedEntry);
PAGE_HOOKS.ziele.unshift(checkMilestones);
PAGE_HOOKS.ziele.push(renderMilestones, renderWrappedSection);
