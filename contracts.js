'use strict';
// ══════════════════════════════════════════════════════════════════════════
// Phase 2 – Verträge & Fristen
//   Kündigungsfristen-Tracker · Kalender-Export (.ics) · Garantie-Tracker mit Belegfotos
// ══════════════════════════════════════════════════════════════════════════

// ── Verträge ──────────────────────────────────────────────────────────────
const NOTICE_UNITS = { months: 'Monate', days: 'Tage' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const noticeLabel = c => c.noticeUnit === 'days' ? plural(c.noticeValue || 0, 'Tag', 'Tage') : plural(c.noticeValue || 0, 'Monat', 'Monate');

// Vertragsende und letzter Kündigungstermin (rollt bei automatischer Verlängerung weiter)
function contractDates(c) {
  if (!c.start || !(c.termMonths > 0)) return null;
  const today = midnight();
  let termStart = c.start;
  let end = addDays(parseISO(addMonthsISO(c.start, c.termMonths)), -1);
  const cancelBy = e => c.noticeUnit === 'days'
    ? addDays(e, -(c.noticeValue || 0))
    : parseISO(addMonthsISO(isoDate(e), -(c.noticeValue || 0)));
  let guard = 0;
  // Frist verpasst → nächste Laufzeit betrachten (nur bei automatischer Verlängerung)
  while (cancelBy(end) < today && c.renewMonths > 0 && guard++ < 600) {
    termStart = isoDate(addDays(end, 1));
    end = addDays(parseISO(addMonthsISO(termStart, c.renewMonths)), -1);
  }
  const by = cancelBy(end);
  const renews = c.renewMonths > 0;
  const expired = !renews && end < today;
  const missed = !renews && by < today;   // Frist vorbei, Vertrag endet ohnehin
  return { end, cancelBy: by, days: dayDiff(today, by), renews, expired, missed, termStart };
}

function contractStatus(c, d) {
  if (c.cancelled) return { cls: 'grey', label: 'Gekündigt' };
  if (!d) return { cls: 'grey', label: 'Daten fehlen' };
  if (d.expired) return { cls: 'grey', label: 'Abgelaufen' };
  if (d.missed) return { cls: 'grey', label: 'Läuft aus' };
  if (d.days < 28) return { cls: 'red', label: d.days < 0 ? 'Frist vorbei' : d.days === 0 ? 'Heute!' : plural(d.days, 'Tag', 'Tage') };
  if (d.days < 90) return { cls: 'yellow', label: `${Math.round(d.days / 7)} Wochen` };
  return { cls: 'green', label: `${Math.round(d.days / 30.4)} Monate` };
}

// Kosten: verknüpfte regelmässige Ausgabe hat Vorrang (keine Doppelerfassung)
function contractCost(c) {
  const e = c.expenseId && state.expenses.find(x => x.id === c.expenseId);
  return e ? { amount: e.amount, frequency: e.frequency, linked: e } : { amount: c.cost || 0, frequency: c.frequency || 'monthly', linked: null };
}

function sortedContracts() {
  return state.contracts
    .map(c => ({ c, d: contractDates(c) }))
    .sort((a, b) => {
      const inactive = x => x.c.cancelled || !x.d || x.d.expired || x.d.missed ? 1 : 0;
      return inactive(a) - inactive(b) || (a.d?.cancelBy || 0) - (b.d?.cancelBy || 0);
    });
}

function renderContracts() {
  const box = el('contracts-section');
  if (!box) return;
  const list = sortedContracts();
  box.innerHTML = `
    <div class="section-divider" style="margin-top:20px">
      <div class="sdiv-title">📑 Verträge</div>
      <div class="sdiv-line"></div>
    </div>
    ${list.length ? `<div class="item-list">${list.map(({ c, d }) => {
      const st = contractStatus(c, d);
      const cost = contractCost(c);
      return `
      <div class="contract">
        <div class="pot-head" style="margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div class="item-name">${esc(c.name)}${c.provider ? ` <span style="color:var(--text2);font-weight:400">· ${esc(c.provider)}</span>` : ''}</div>
            <div class="item-sub">${fmtExact(cost.amount)} ${CYCLE_LABEL[cost.frequency]?.toLowerCase() || ''}${cost.linked ? ' · 🔗 Ausgabe' : ''}</div>
          </div>
          <span class="status-badge badge-${st.cls}">${st.label}</span>
        </div>
        ${d && !c.cancelled ? `
        <div class="contract-dates">
          <div><span>Kündigen bis</span><strong ${st.cls === 'red' ? 'style="color:var(--red)"' : ''}>${fmtDate(d.cancelBy)}</strong></div>
          <div><span>${d.renews ? 'Laufzeit bis' : 'Vertragsende'}</span><strong>${fmtDate(d.end)}</strong></div>
          <div><span>Frist</span><strong>${noticeLabel(c)}</strong></div>
        </div>
        ${d.renews ? `<div class="pot-rate">Verlängert sich sonst um ${c.renewMonths} Monate</div>` : ''}` : ''}
        ${c.note ? `<div class="pot-rate">📝 ${esc(c.note)}</div>` : ''}
        <div class="pot-actions">
          <button class="btn btn-ghost" onclick="openContractModal('${c.id}')">✏️ Bearbeiten</button>
          <button class="btn btn-ghost" onclick="toggleContractCancelled('${c.id}')">${c.cancelled ? '↩︎ Aktiv' : '✓ Gekündigt'}</button>
          <button class="btn btn-danger btn-icon" style="width:40px;flex:0 0 40px" onclick="deleteContract('${c.id}')" aria-label="Löschen">🗑️</button>
        </div>
      </div>`;
    }).join('')}</div>` : emptyState('📑', 'Noch keine Verträge erfasst. Handy-Abo, Fitness, Versicherungen …')}
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="add-btn" style="flex:2" onclick="openContractModal()">+ Vertrag</button>
      <button class="add-btn transfer-btn" style="flex:1" onclick="openIcsModal()">📅 Kalender</button>
    </div>`;
}

function openContractModal(id = null) {
  const c = id ? state.contracts.find(x => x.id === id) : null;
  const expOpts = `<option value="">— keine —</option>` + state.expenses.map(e =>
    `<option value="${e.id}" ${c?.expenseId === e.id ? 'selected' : ''}>${esc(e.name)} (${fmt(e.amount)} ${CYCLE_LABEL[e.frequency].toLowerCase()})</option>`).join('');
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">${c ? 'Vertrag bearbeiten' : 'Vertrag erfassen'}</div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Name</label><input id="k-name" type="text" placeholder="z.B. Handy-Abo" value="${esc(c?.name)}"></div>
        <div class="field" style="flex:1"><label>Anbieter</label><input id="k-provider" type="text" placeholder="z.B. Swisscom" value="${esc(c?.provider)}"></div>
      </div>
      <div class="field"><label>Mit regelmässiger Ausgabe verknüpfen</label>
        <select id="k-expense" onchange="onContractExpenseChange()">${expOpts}</select>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Verknüpft: Kosten kommen aus der Ausgabe und werden nicht doppelt gezählt.</div>
      </div>
      <div id="k-cost-wrap">
        <div style="display:flex;gap:8px">
          <div class="field" style="flex:1"><label>Kosten (${state.currency})</label><input id="k-cost" type="number" inputmode="decimal" step="any" value="${c?.cost || ''}"></div>
          <div class="field" style="flex:1"><label>Rhythmus</label>
            <select id="k-freq">${Object.entries(CYCLE_LABEL).map(([k, l]) => `<option value="${k}" ${(c?.frequency || 'monthly') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        ${!c ? `<label class="check-row"><input id="k-create-exp" type="checkbox" checked><span>Auch als regelmässige Ausgabe erfassen</span></label>` : ''}
      </div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Vertragsbeginn</label><input id="k-start" type="date" value="${c?.start || ''}"></div>
        <div class="field" style="flex:1"><label>Laufzeit (Monate)</label><input id="k-term" type="number" inputmode="numeric" min="1" placeholder="z.B. 24" value="${c?.termMonths || ''}"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Verlängerung (Monate)</label><input id="k-renew" type="number" inputmode="numeric" min="0" placeholder="0 = keine" value="${c?.renewMonths ?? 12}"></div>
        <div class="field" style="flex:1"><label>Kündigungsfrist</label>
          <div style="display:flex;gap:6px"><input id="k-notice" type="number" inputmode="numeric" min="0" style="flex:1;min-width:0" value="${c?.noticeValue ?? 3}">
          <select id="k-notice-unit" style="flex:1;min-width:0">${Object.entries(NOTICE_UNITS).map(([k, l]) => `<option value="${k}" ${(c?.noticeUnit || 'months') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      </div>
      <div class="field"><label>Notiz (optional)</label><input id="k-note" type="text" placeholder="z.B. Kündigung per Einschreiben" value="${esc(c?.note)}"></div>
      <div id="k-preview" class="reserve-hint"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="saveContract(${c ? `'${c.id}'` : ''})">Speichern</button>
      </div>
    </div>
  </div>`);
  ['k-start', 'k-term', 'k-renew', 'k-notice', 'k-notice-unit'].forEach(i => el(i).addEventListener('input', updateContractPreview));
  onContractExpenseChange();
}

function readContractForm() {
  return {
    name: el('k-name').value.trim(), provider: el('k-provider').value.trim(),
    expenseId: el('k-expense').value || null,
    cost: parseFloat(el('k-cost').value) || 0, frequency: el('k-freq').value,
    start: el('k-start').value || null, termMonths: parseInt(el('k-term').value) || 0,
    renewMonths: Math.max(0, parseInt(el('k-renew').value) || 0),
    noticeValue: Math.max(0, parseInt(el('k-notice').value) || 0), noticeUnit: el('k-notice-unit').value,
    note: el('k-note').value.trim()
  };
}

function onContractExpenseChange() {
  el('k-cost-wrap').style.display = el('k-expense').value ? 'none' : '';
  updateContractPreview();
}

function updateContractPreview() {
  const d = contractDates(readContractForm());
  el('k-preview').innerHTML = d
    ? `Letzter Kündigungstermin: <strong>${fmtDate(d.cancelBy)}</strong> · ${d.renews ? 'Laufzeit bis' : 'Vertragsende'} ${fmtDate(d.end)}`
    : 'Vertragsbeginn und Laufzeit angeben, um die Fristen zu berechnen.';
}

function saveContract(id) {
  const f = readContractForm();
  if (!f.name) { toast('Name angeben'); return; }
  if (!f.start || !f.termMonths) { toast('Vertragsbeginn und Laufzeit angeben'); return; }
  if (!id && !f.expenseId && el('k-create-exp')?.checked && f.cost > 0) {
    const e = migrateExpense({ id: uid(), name: f.name, amount: f.cost, category: 'Ausgabe', frequency: f.frequency,
      budgetLimit: 0, note: f.provider ? `Vertrag bei ${f.provider}` : '' });
    if (isIrregular(e)) {  // Fälligkeit: nächster Jahrestag des Vertragsbeginns
      let due = f.start;
      while (parseISO(due) < midnight()) due = addMonthsISO(due, cycleOf(e), parseISO(f.start).getDate());
      e.nextDue = due; e.dueDay = parseISO(f.start).getDate();
    }
    state.expenses.push(e);
    f.expenseId = e.id;
  }
  if (id) Object.assign(state.contracts.find(x => x.id === id), f);
  else state.contracts.push({ id: uid(), cancelled: false, ...f });
  saveState(); closeModal(); toast('Vertrag gespeichert ✓'); refreshCurrent();
}

function toggleContractCancelled(id) {
  const c = state.contracts.find(x => x.id === id);
  c.cancelled = !c.cancelled;
  saveState(); refreshCurrent();
}

function deleteContract(id) {
  if (!confirm('Vertrag löschen? Eine verknüpfte Ausgabe bleibt bestehen.')) return;
  state.contracts = state.contracts.filter(x => x.id !== id);
  saveState(); toast('Gelöscht'); refreshCurrent();
}

// Übersicht: Kündigungsfristen < 4 Wochen
DASH_ALERTS.push(() => sortedContracts()
  .filter(({ c, d }) => !c.cancelled && d && !d.missed && !d.expired && d.days < 28)
  .map(({ c, d }) => `
    <div class="alert-row alert-red" onclick="navigate('ausgaben');setTimeout(()=>el('contracts-section')?.scrollIntoView({behavior:'smooth'}),50)">
      <span>📑</span><span><strong>${esc(c.name)}</strong> kündigen bis ${fmtDate(d.cancelBy)}
      <br><span class="alert-sub">${d.days < 0 ? 'Frist verpasst' : d.days === 0 ? 'Heute letzter Tag!' : `noch ${plural(d.days, 'Tag', 'Tage')}`} · sonst Verlängerung bis ${fmtDate(addDays(parseISO(addMonthsISO(isoDate(addDays(d.end, 1)), c.renewMonths || 0)), -1))}</span></span>
    </div>`).join(''));

// ── Kalender-Export (.ics) ────────────────────────────────────────────────
const ICS_KINDS = {
  contracts: 'Kündigungstermine (Erinnerung 4 Wochen + 1 Woche vorher)',
  payments:  'Jährliche/unregelmässige Zahlungen (Erinnerung 7 Tage vorher)',
  cards:     'Kreditkarten-Zahlungsfristen (Erinnerung 3 Tage vorher)'
};

function icsEscape(t) { return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
// Zeilen > 75 Bytes falten (RFC 5545)
function icsFold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = []; let cur = '', len = 0;
  for (const ch of line) {
    const l = new TextEncoder().encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const icsDate = d => isoDate(d).replace(/-/g, '');

function icsEvents(kinds) {
  const ev = [];
  if (kinds.contracts) for (const { c, d } of sortedContracts()) {
    if (c.cancelled || !d || d.missed || d.expired) continue;
    ev.push({ uid: `contract-${c.id}`, date: d.cancelBy, title: `Kündigungstermin: ${c.name}${c.provider ? ' (' + c.provider + ')' : ''}`,
      desc: `Letzter Tag, um ${c.name} zu kündigen. ${d.renews ? `Sonst Verlängerung um ${c.renewMonths} Monate.` : ''}`, alarms: ['-P28D', '-P7D'] });
  }
  if (kinds.payments) for (const e of state.expenses) {
    if (!isIrregular(e) || !e.nextDue) continue;
    // Wiederholung über RRULE; Tage > 28 ohne Regel (nicht jeder Monat hat sie)
    const rrule = parseISO(e.nextDue).getDate() <= 28
      ? (cycleOf(e) === 12 ? 'FREQ=YEARLY' : `FREQ=MONTHLY;INTERVAL=${cycleOf(e)}`) : null;
    ev.push({ uid: `payment-${e.id}`, date: parseISO(e.nextDue), title: `Zahlung fällig: ${e.name} (${fmt2(e.amount)})`,
      desc: `${CYCLE_LABEL[e.frequency]}e Zahlung${hasReserve(e) ? ' – aus Rückstellung' : ''}.`, alarms: ['-P7D'], rrule });
  }
  if (kinds.cards && typeof cardStatements === 'function') for (const card of state.accounts.filter(a => a.type === 'credit')) {
    const { open, running } = cardStatements(card);
    for (const s of [...open, ...(running && running.total > 0 ? [running] : [])]) {
      ev.push({ uid: `card-${card.id}-${s.statement}`, date: parseISO(s.due), title: `Kreditkarte ${card.name}: Abrechnung bezahlen (${fmt2(s.total)})`,
        desc: `Abrechnung per ${fmtDate(s.statement)}.`, alarms: ['-P3D'] });
    }
  }
  return ev;
}

function buildIcs(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  // Steigende SEQUENCE → Kalender aktualisiert bestehende Termine mit gleicher UID
  const seq = Math.floor((Date.now() - Date.UTC(2024, 0, 1)) / 60000);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FinanzPlaner//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:FinanzPlaner'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@finanzplaner.app`, `DTSTAMP:${stamp}`, `SEQUENCE:${seq}`,
      `DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(e.date, 1))}`,
      `SUMMARY:${icsEscape(e.title)}`, `DESCRIPTION:${icsEscape(e.desc)}`, 'TRANSP:TRANSPARENT');
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    for (const a of e.alarms) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.title)}`, `TRIGGER:${a}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function openIcsModal() {
  const counts = Object.fromEntries(Object.keys(ICS_KINDS).map(k => [k, icsEvents({ [k]: true }).length]));
  showModal(`
  <div class="modal-backdrop" id="modal-backdrop" onclick="handleBackdropClick(event)">
    <div class="modal">
      <div class="modal-title">📅 In Kalender exportieren</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Erneut exportieren aktualisiert die Termine, statt sie doppelt anzulegen.</div>
      ${Object.entries(ICS_KINDS).map(([k, l]) => `
        <label class="check-row"><input type="checkbox" id="ics-${k}" ${counts[k] ? 'checked' : 'disabled'}>
          <span>${l}<br><span style="font-size:12px;color:var(--text2)">${plural(counts[k], 'Termin', 'Termine')}</span></span></label>`).join('')}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
        <button class="btn btn-primary" onclick="exportIcs()">Exportieren</button>
      </div>
    </div>
  </div>`);
}

function exportIcs() {
  const kinds = Object.fromEntries(Object.keys(ICS_KINDS).map(k => [k, !!el('ics-' + k)?.checked]));
  const events = icsEvents(kinds);
  if (!events.length) { toast('Keine Termine ausgewählt'); return; }
  const blob = new Blob([buildIcs(events)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) {
    // iOS (Safari & Home-Bildschirm-App): Datei direkt öffnen → "Zum Kalender hinzufügen"
    window.location.href = url;
  } else {
    const a = document.createElement('a'); a.href = url; a.download = 'finanzplaner.ics'; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  closeModal(); toast(`${events.length} Termine exportiert ✓`);
}

// ── Belegfotos (IndexedDB) ────────────────────────────────────────────────
// Fotos sind zu gross für localStorage → eigene IndexedDB, Schlüssel = Beleg-ID
const ReceiptDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('finanzplaner-belege', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('receipts');
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('receipts', mode);
      const r = fn(t.objectStore('receipts'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  },
  put(id, blob) { return this.tx('readwrite', s => s.put(blob, id)); },
  get(id) { return this.tx('readonly', s => s.get(id)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); }
};

// Bild verkleinern (max. 1600 px) und als JPEG (~0.7) speichern
async function compressImage(file, max = 1600, quality = 0.7) {
  const src = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, max / Math.max(src.naturalWidth, src.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.naturalWidth * scale);
  canvas.height = Math.round(src.naturalHeight * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(src.src);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Formular-Zustand: bestehende + neu hinzugefügte Fotos
let receiptDraft = { keep: [], added: [] };

TX_MODAL_EXTRAS.push({
  html: prefill => `
    <details class="extra-section" ${prefill?.warrantyUntil || prefill?.receiptIds?.length ? 'open' : ''}>
      <summary>🧾 Beleg & Garantie</summary>
      <div class="receipt-thumbs" id="m-receipts"></div>
      <label class="add-btn" style="margin-bottom:12px">
        📷 Foto aufnehmen / wählen
        <input type="file" accept="image/*" capture="environment" multiple onchange="addReceiptPhotos(event)" style="display:none">
      </label>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>Garantie bis</label><input id="m-warranty" type="date" value="${prefill?.warrantyUntil || ''}"></div>
        <div class="field" style="flex:1"><label>oder Monate</label><input id="m-warranty-months" type="number" inputmode="numeric" min="0" placeholder="z.B. 24"></div>
      </div>
    </details>`,
  mounted: prefill => { receiptDraft = { keep: [...(prefill?.receiptIds || [])], added: [] }; renderReceiptDraft(); },
  read: data => {
    const months = parseInt(el('m-warranty-months')?.value);
    data.warrantyUntil = months > 0 ? addMonthsISO(data.date, months) : (el('m-warranty')?.value || null);
    data.receiptIds = [...receiptDraft.keep, ...receiptDraft.added.map(r => r.id)];
  },
  after: tx => {
    const removed = (tx._prevReceipts || []);
    delete tx._prevReceipts;
    removed.forEach(id => ReceiptDB.del(id).catch(() => {}));
    receiptDraft.added.forEach(r => ReceiptDB.put(r.id, r.blob).catch(() => toast('⚠️ Foto konnte nicht gespeichert werden')));
    receiptDraft = { keep: [], added: [] };
  }
});

// Beim Bearbeiten entfernte Fotos erst nach dem Speichern löschen
TX_MODAL_EXTRAS.push({
  html: () => '',
  read: (data, existing) => {
    if (existing) existing._prevReceipts = (existing.receiptIds || []).filter(id => !data.receiptIds.includes(id));
  }
});

async function addReceiptPhotos(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  for (const f of files) {
    try {
      const blob = await compressImage(f);
      receiptDraft.added.push({ id: 'r' + uid() + uid(), blob, url: URL.createObjectURL(blob) });
    } catch { toast('Foto konnte nicht gelesen werden'); }
  }
  renderReceiptDraft();
}

async function renderReceiptDraft() {
  const box = el('m-receipts');
  if (!box) return;
  const keep = await Promise.all(receiptDraft.keep.map(async id => {
    const blob = await ReceiptDB.get(id).catch(() => null);
    return { id, url: blob ? URL.createObjectURL(blob) : '' };
  }));
  box.innerHTML = [...keep, ...receiptDraft.added].map(r => `
    <div class="receipt-thumb">${r.url ? `<img src="${r.url}" alt="Beleg">` : '❓'}
      <button type="button" onclick="removeReceiptDraft('${r.id}')" aria-label="Foto entfernen">✕</button></div>`).join('');
}

function removeReceiptDraft(id) {
  receiptDraft.keep = receiptDraft.keep.filter(x => x !== id);
  receiptDraft.added = receiptDraft.added.filter(x => x.id !== id);
  renderReceiptDraft();
}

DELETE_HOOKS.push((type, item) => {
  if (type === 'transaction') (item?.receiptIds || []).forEach(id => ReceiptDB.del(id).catch(() => {}));
});

// Vollbild-Ansicht der Belege
async function showReceipts(txId, index = 0) {
  const tx = state.transactions.find(t => t.id === txId);
  const ids = tx?.receiptIds || [];
  if (!ids.length) return;
  const i = (index + ids.length) % ids.length;
  const blob = await ReceiptDB.get(ids[i]).catch(() => null);
  document.getElementById('receipt-viewer')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="receipt-viewer" class="receipt-viewer" onclick="if(event.target===this)this.remove()">
      ${blob ? `<img src="${URL.createObjectURL(blob)}" alt="Beleg ${esc(tx.name)}">` : '<div>Foto nicht gefunden</div>'}
      <div class="rv-bar">
        ${ids.length > 1 ? `<button onclick="showReceipts('${txId}',${i - 1})">◀</button>` : ''}
        <span>${esc(tx.name)} · ${i + 1}/${ids.length}</span>
        ${ids.length > 1 ? `<button onclick="showReceipts('${txId}',${i + 1})">▶</button>` : ''}
        <button onclick="document.getElementById('receipt-viewer').remove()">✕</button>
      </div>
    </div>`);
}

// ── Garantien ─────────────────────────────────────────────────────────────
function warranties() {
  return (state.transactions || []).filter(t => t.warrantyUntil)
    .map(t => ({ t, days: daysUntil(t.warrantyUntil) }))
    .sort((a, b) => a.t.warrantyUntil.localeCompare(b.t.warrantyUntil));
}

function remainingLabel(days) {
  if (days < 0) return 'abgelaufen';
  if (days < 60) return `noch ${days} Tage`;
  const m = Math.round(days / 30.4);
  return m < 24 ? `noch ${m} Monate` : `noch ${(days / 365).toFixed(1)} Jahre`;
}

function renderWarranties() {
  const box = el('warranty-section');
  if (!box) return;
  const list = warranties();
  const active = list.filter(w => w.days >= 0), expired = list.filter(w => w.days < 0);
  box.innerHTML = `
    <div class="section-divider" style="margin-top:20px">
      <div class="sdiv-title">🧾 Garantien</div>
      <div class="sdiv-line"></div>
    </div>
    ${list.length ? `<div class="item-list">${[...active, ...expired].map(({ t, days }) => `
      <div class="list-item${days < 0 ? ' muted' : ''}">
        <div class="item-left">
          <div class="item-icon" style="background:${days < 0 ? 'var(--surface)' : days <= 30 ? 'rgba(234,179,8,.18)' : 'rgba(16,185,129,.15)'}">${t.receiptIds?.length ? '🧾' : '🛡️'}</div>
          <div>
            <div class="item-name">${esc(t.name)}</div>
            <div class="item-sub">Gekauft ${fmtDate(t.date)} · bis ${fmtDate(t.warrantyUntil)}</div>
            <div class="item-sub" style="color:${days < 0 ? 'var(--text2)' : days <= 30 ? 'var(--yellow)' : 'var(--green)'}">${remainingLabel(days)}</div>
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          ${t.receiptIds?.length ? `<button class="btn btn-ghost btn-icon" onclick="showReceipts('${t.id}')" aria-label="Beleg anzeigen">🖼️</button>` : ''}
          <button class="btn btn-ghost btn-icon" onclick="openEdit('transaction','${t.id}')" aria-label="Bearbeiten">✏️</button>
        </div>
      </div>`).join('')}</div>`
    : `<div class="card" style="font-size:13px;color:var(--text2)">Hänge beim Erfassen einer Buchung unter „🧾 Beleg & Garantie“ ein Foto und das Garantie-Ende an – hier siehst du dann alle Garantien auf einen Blick.</div>`}`;
}

DASH_ALERTS.push(() => warranties().filter(w => w.days >= 0 && w.days <= 30).map(({ t, days }) => `
  <div class="alert-row alert-yellow" onclick="${t.receiptIds?.length ? `showReceipts('${t.id}')` : `navigate('ausgaben')`}">
    <span>🛡️</span><span>Garantie <strong>${esc(t.name)}</strong> läuft ${days === 0 ? 'heute' : `in ${days} Tagen`} ab (${fmtDate(t.warrantyUntil)})
    <br><span class="alert-sub">Defekte jetzt noch reklamieren${t.receiptIds?.length ? ' · Beleg antippen' : ''}</span></span>
  </div>`).join(''));

// Belege im Backup mitsichern (als Base64) und beim Import wiederherstellen
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
EXPORT_HOOKS.push(async payload => {
  const ids = (payload.transactions || []).flatMap(t => t.receiptIds || []);
  payload.receipts = {};
  for (const id of ids) { const b = await ReceiptDB.get(id).catch(() => null); if (b) payload.receipts[id] = await blobToDataURL(b); }
});
IMPORT_HOOKS.push(async parsed => {
  const receipts = parsed.receipts || {};
  delete parsed.receipts;
  for (const [id, dataUrl] of Object.entries(receipts)) {
    const blob = await (await fetch(dataUrl)).blob();
    await ReceiptDB.put(id, blob);
  }
});

PAGE_HOOKS.ausgaben.push(renderContracts, renderWarranties);
