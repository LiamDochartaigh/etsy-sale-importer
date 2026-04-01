/**
 * Etsy Sales Automation — content script
 * Runs on: https://www.etsy.com/your/shops/me/sales-discounts*
 *
 * CSV columns (see template.csv):
 *   sale_name           — alphanumeric only, max 20 chars, unique per CSV
 *   discount_type       — "percent" | "free_shipping"
 *   discount_percentage — integer 1–99 (only when discount_type = percent)
 *   region              — "Everywhere" or any country name from Etsy's list
 *   start_date          — DD/MM/YYYY  (the date you want the sale to START)
 *   end_date            — DD/MM/YYYY  (the date you want the sale to END)
 *                         ↑ Extension subtracts 1 day before inputting because
 *                           Etsy displays the entered date as "ends the day after".
 *   categories          — pipe-separated section names  e.g. Widgets|Emotes
 *
 * Modes:
 *   dry-run  — row 1 only, stops at the review page (no sale created)
 *   import   — all rows, clicks "Confirm and create sale" on each
 */

const SESSION_KEY  = 'eta_automation_active';
const SESSION_DATA = 'eta_automation_data';
// One-time token set just before each programmatic navigation and consumed
// immediately by init(). A page refresh won't have this token, so automation
// will not restart on F5.
const SESSION_NAV  = 'eta_nav_pending';
// Session data shape: { rows: Row[], index: number, mode: 'dry-run'|'import' }

const PROGRESS_STEPS = [
  'Opening sale dialog',
  'Filling sale details',
  'Submitting form',
  'Selecting listings',
  'Ready to review',
];

/* ─────────────────────────────────────────────
   CSV parsing
───────────────────────────────────────────── */

function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = parseCSVRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
    return row;
  });
}

/* ─────────────────────────────────────────────
   Validation  (per-row results)
───────────────────────────────────────────── */

function isValidDateStr(str) {
  if (!str) return false;
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 && d.getFullYear() === +m[3];
}

function validateRows(rows) {
  const seenNames = new Set();
  return rows.map(row => {
    const errors = [], warnings = [];

    const name = row.sale_name ?? '';
    if (!name) {
      errors.push('sale_name is required.');
    } else {
      if (!/^[a-zA-Z0-9]+$/.test(name))
        errors.push(`sale_name "${name}" — only letters and numbers allowed.`);
      if (name.length > 20)
        errors.push(`sale_name "${name}" exceeds 20 characters (${name.length}).`);
      if (seenNames.has(name.toUpperCase()))
        errors.push(`sale_name "${name}" is duplicated — each name must be unique.`);
      seenNames.add(name.toUpperCase());
    }

    if (!['percent', 'free_shipping'].includes(row.discount_type))
      errors.push(`discount_type must be "percent" or "free_shipping" (got "${row.discount_type}").`);

    if (row.discount_type === 'percent') {
      const pct = parseInt(row.discount_percentage, 10);
      if (isNaN(pct) || pct < 1 || pct > 99)
        errors.push(`discount_percentage must be 1–99 (got "${row.discount_percentage}").`);
    }

    if (!isValidDateStr(row.start_date))
      errors.push(`start_date "${row.start_date}" is not a valid DD/MM/YYYY date.`);
    if (!isValidDateStr(row.end_date))
      errors.push(`end_date "${row.end_date}" is not a valid DD/MM/YYYY date.`);

    if (isValidDateStr(row.start_date) && isValidDateStr(row.end_date)) {
      const [sd, sm, sy] = row.start_date.split('/').map(Number);
      const [ed, em, ey] = row.end_date.split('/').map(Number);
      const start = new Date(sy, sm - 1, sd);
      const end   = new Date(ey, em - 1, ed);
      if (end <= start)
        errors.push('end_date must be after start_date.');
      const diffDays = Math.round((end - start) / 86400000);
      if (diffDays > 30)
        warnings.push(`Sale duration is ${diffDays} days — Etsy caps sales at 30 days.`);
    }

    if (!row.categories || !row.categories.trim())
      warnings.push('categories is empty — no sections will be selected.');

    return { errors, warnings, valid: errors.length === 0 };
  });
}

/* ─────────────────────────────────────────────
   Date helpers
───────────────────────────────────────────── */

function subtractOneDay(dateStr) {
  const [d, m, y] = dateStr.split('/').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}

/* ─────────────────────────────────────────────
   Utility helpers
───────────────────────────────────────────── */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForElement(selector, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const ob = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { ob.disconnect(); resolve(el); }
    });
    ob.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { ob.disconnect(); reject(new Error(`Timeout: "${selector}"`)); }, timeout);
  });
}

function waitForElementByText(selector, text, timeout = 12000) {
  const check = () =>
    [...document.querySelectorAll(selector)].find(el => el.textContent.trim().includes(text));
  return new Promise((resolve, reject) => {
    const found = check();
    if (found) return resolve(found);
    const ob = new MutationObserver(() => {
      const el = check();
      if (el) { ob.disconnect(); resolve(el); }
    });
    ob.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { ob.disconnect(); reject(new Error(`Timeout: "${selector}" / "${text}"`)); }, timeout);
  });
}

function setNativeInputValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setNativeSelectValue(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function typeDate(input, dateStr) {
  input.focus();
  await sleep(80);
  setNativeInputValue(input, '');
  await sleep(80);
  for (const char of dateStr) {
    input.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      .set.call(input, input.value + char);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await sleep(40);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
}

/* ─────────────────────────────────────────────
   Progress panel
───────────────────────────────────────────── */

function getProgressPanel() {
  let panel = document.getElementById('eta-progress');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'eta-progress';
    panel.innerHTML = `
      <div class="eta-prog-header">
        <span class="eta-prog-spinner"></span>
        <span class="eta-prog-title">Running automation…</span>
      </div>
      <ol class="eta-prog-steps">
        ${PROGRESS_STEPS.map((label, i) => `
          <li id="eta-step-${i}" class="eta-step eta-step-pending">
            <span class="eta-step-icon"></span>
            <span class="eta-step-label">${label}</span>
          </li>`).join('')}
      </ol>`;
    document.body.appendChild(panel);
  }
  return panel;
}

function setProgress(stepIndex, headerText = null) {
  const panel = getProgressPanel();
  panel.className = 'eta-prog-visible';
  panel.querySelector('.eta-prog-warnings')?.remove();

  const title   = panel.querySelector('.eta-prog-title');
  const spinner = panel.querySelector('.eta-prog-spinner');
  title.textContent   = headerText ?? 'Running automation…';
  spinner.className   = 'eta-prog-spinner';

  PROGRESS_STEPS.forEach((_, i) => {
    const li = document.getElementById(`eta-step-${i}`);
    if (i < stepIndex)        li.className = 'eta-step eta-step-done';
    else if (i === stepIndex) li.className = 'eta-step eta-step-active';
    else                      li.className = 'eta-step eta-step-pending';
  });
}

function warnStep(stepIndex, note) {
  const li = document.getElementById(`eta-step-${stepIndex}`);
  if (!li) return;
  li.className = 'eta-step eta-step-warn';
  if (note) {
    let noteEl = li.querySelector('.eta-step-note');
    if (!noteEl) { noteEl = document.createElement('span'); noteEl.className = 'eta-step-note'; li.appendChild(noteEl); }
    noteEl.textContent = note;
  }
}

function finishProgress(errorMsg = null, warnings = []) {
  const panel = document.getElementById('eta-progress');
  if (!panel) return;

  const title   = panel.querySelector('.eta-prog-title');
  const spinner = panel.querySelector('.eta-prog-spinner');
  panel.querySelector('.eta-prog-warnings')?.remove();

  if (errorMsg) {
    spinner.className = 'eta-prog-icon-err';
    title.textContent = errorMsg;
    PROGRESS_STEPS.forEach((_, i) => {
      const li = document.getElementById(`eta-step-${i}`);
      if (li.classList.contains('eta-step-active')) li.className = 'eta-step eta-step-error';
    });
    setTimeout(() => { panel.className = ''; }, 7000);

  } else if (warnings.length > 0) {
    spinner.className = 'eta-prog-icon-warn';
    title.textContent = 'Done — check warnings below';
    PROGRESS_STEPS.forEach((_, i) => {
      const li = document.getElementById(`eta-step-${i}`);
      if (!li.classList.contains('eta-step-warn')) li.className = 'eta-step eta-step-done';
    });
    const warnEl = document.createElement('ul');
    warnEl.className = 'eta-prog-warnings';
    warnings.forEach(w => { const li = document.createElement('li'); li.textContent = w; warnEl.appendChild(li); });
    panel.appendChild(warnEl);
    setTimeout(() => { panel.className = ''; }, 10000);

  } else {
    spinner.className = 'eta-prog-icon-ok';
    title.textContent = 'Done — review before publishing!';
    PROGRESS_STEPS.forEach((_, i) => {
      document.getElementById(`eta-step-${i}`).className = 'eta-step eta-step-done';
    });
    setTimeout(() => { panel.className = ''; }, 4000);
  }
}

/* Fallback toast for pre-run errors (e.g. link not found on page) */
function showStatus(msg, type = 'info') {
  let el = document.getElementById('eta-status');
  if (!el) { el = document.createElement('div'); el.id = 'eta-status'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `eta-visible${type !== 'info' ? ` eta-${type}` : ''}`;
  setTimeout(() => { el.className = ''; }, 5000);
}

/* ─────────────────────────────────────────────
   Floating trigger button
───────────────────────────────────────────── */

function injectTriggerButton() {
  if (document.getElementById('eta-trigger-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'eta-trigger-btn';
  btn.textContent = '⚡ Auto Sale';
  btn.addEventListener('click', openModal);
  document.body.appendChild(btn);
}

/* ─────────────────────────────────────────────
   Modal
───────────────────────────────────────────── */

let _parsedRows = [];
let _rowResults = [];

function openModal() {
  if (document.getElementById('eta-modal-backdrop')) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'eta-modal-backdrop';
  backdrop.innerHTML = `
    <div id="eta-modal">
      <div id="eta-modal-header">
        <h2>Etsy Sale Automation</h2>
        <p class="eta-subtitle">Upload a CSV — each row is one sale.</p>
      </div>

      <div id="eta-upload-area" class="eta-upload-area">
        <input type="file" id="eta-file-input" accept=".csv" />
        <label for="eta-file-input">
          <span id="eta-file-icon">📂</span>
          <span id="eta-file-text">Choose CSV file or drag &amp; drop</span>
        </label>
      </div>

      <div id="eta-rows-output"></div>

      <p class="eta-template-link">
        Need the template?
        <a id="eta-download-template" href="#" download="etsy-bulk-sale-template.csv">Download CSV template</a>
      </p>

      <div class="eta-btn-row">
        <button class="eta-btn" id="eta-btn-cancel">Cancel</button>
        <button class="eta-btn eta-btn-secondary" id="eta-btn-dry-run" disabled>Test Run</button>
        <button class="eta-btn eta-btn-primary"   id="eta-btn-import"  disabled>Import Sales</button>
      </div>
    </div>`;

  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);

  document.getElementById('eta-btn-cancel').addEventListener('click', closeModal);

  // Point the template download link at the bundled file inside the extension
  const templateLink = document.getElementById('eta-download-template');
  templateLink.href = chrome.runtime.getURL('example-template.csv');

  document.getElementById('eta-btn-dry-run').addEventListener('click', () => {
    if (_parsedRows.length && _rowResults[0]?.valid) {
      closeModal();
      startSession(_parsedRows, 'dry-run');
    }
  });

  document.getElementById('eta-btn-import').addEventListener('click', () => {
    if (_parsedRows.length && _rowResults.every(r => r.valid)) {
      closeModal();
      startSession(_parsedRows, 'import');
    }
  });

  const uploadArea = document.getElementById('eta-upload-area');
  uploadArea.addEventListener('dragover',  e => { e.preventDefault(); uploadArea.classList.add('eta-drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('eta-drag-over'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('eta-drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadCSVFile(file);
  });

  document.getElementById('eta-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadCSVFile(file);
  });
}

function closeModal() {
  document.getElementById('eta-modal-backdrop')?.remove();
}

function loadCSVFile(file) {
  document.getElementById('eta-file-text').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => processCSV(e.target.result);
  reader.readAsText(file);
}

function processCSV(text) {
  const outputEl   = document.getElementById('eta-rows-output');
  const dryRunBtn  = document.getElementById('eta-btn-dry-run');
  const importBtn  = document.getElementById('eta-btn-import');

  _parsedRows = parseCSV(text);
  _rowResults = [];
  outputEl.innerHTML = '';
  dryRunBtn.disabled = true;
  importBtn.disabled = true;

  if (_parsedRows.length === 0) {
    outputEl.innerHTML = `<div class="eta-error-block eta-block-gap">No data rows found in the CSV.</div>`;
    return;
  }

  _rowResults = validateRows(_parsedRows);

  const totalErrors   = _rowResults.filter(r => !r.valid).length;
  const totalWarnings = _rowResults.filter(r => r.valid && r.warnings.length > 0).length;
  const totalValid    = _rowResults.filter(r => r.valid).length;
  const allValid      = totalErrors === 0;
  const row1Valid     = _rowResults[0]?.valid;

  const summaryParts = [
    `<span class="eta-sum-total">${_parsedRows.length} row${_parsedRows.length !== 1 ? 's' : ''} loaded</span>`,
    totalValid    > 0 ? `<span class="eta-sum-ok">✓ ${totalValid} valid</span>`              : '',
    totalWarnings > 0 ? `<span class="eta-sum-warn">⚠ ${totalWarnings} with warnings</span>` : '',
    totalErrors   > 0 ? `<span class="eta-sum-err">✖ ${totalErrors} with errors</span>`      : '',
  ].filter(Boolean).join('');

  const tableRows = _parsedRows.map((row, idx) => {
    const result  = _rowResults[idx];
    const isFirst = idx === 0 && result.valid;

    const discount = row.discount_type === 'percent'
      ? `${row.discount_percentage || '?'}% off`
      : row.discount_type === 'free_shipping' ? 'Free delivery'
      : `<span class="eta-cell-err">${row.discount_type || '—'}</span>`;

    const endAdj  = isValidDateStr(row.end_date) ? subtractOneDay(row.end_date) : null;
    const endCell = endAdj
      ? `${row.end_date}<br><span class="eta-date-adj">→ ${endAdj} (Etsy)</span>`
      : `<span class="eta-cell-err">${row.end_date || '—'}</span>`;

    const startCell = isValidDateStr(row.start_date)
      ? row.start_date
      : `<span class="eta-cell-err">${row.start_date || '—'}</span>`;

    const cats     = (row.categories || '').split('|').map(c => c.trim()).filter(Boolean);
    const catsCell = cats.length
      ? cats.map(c => `<span class="eta-cat-tag">${c}</span>`).join('')
      : '<span class="eta-cell-muted">—</span>';

    const nameCell = isFirst
      ? `<strong>${row.sale_name}</strong> <span class="eta-badge-first">dry run</span>`
      : `<strong>${row.sale_name || '<span class="eta-cell-err">missing</span>'}</strong>`;

    const statusCell = result.valid
      ? (result.warnings.length
          ? `<span class="eta-status-warn" title="${result.warnings.join('\n')}">⚠</span>`
          : `<span class="eta-status-ok">✓</span>`)
      : `<span class="eta-status-err" title="${result.errors.join('\n')}">✖</span>`;

    const rowClass = result.valid
      ? (isFirst ? 'eta-tr eta-tr-first' : 'eta-tr eta-tr-valid')
      : 'eta-tr eta-tr-invalid';

    const allMessages = [
      ...result.errors.map(e   => `<span class="eta-msg-err">✖ ${e}</span>`),
      ...result.warnings.map(w => `<span class="eta-msg-warn">⚠ ${w}</span>`),
    ];
    const detailRow = allMessages.length
      ? `<tr class="eta-tr-detail"><td colspan="7">${allMessages.join('')}</td></tr>`
      : '';

    return `
      <tr class="${rowClass}">
        <td class="eta-tc eta-tc-num">${idx + 1}</td>
        <td class="eta-tc-name">${nameCell}</td>
        <td class="eta-tc-discount">${discount}</td>
        <td class="eta-tc-region">${row.region || 'Everywhere'}</td>
        <td class="eta-tc-date">${startCell}</td>
        <td class="eta-tc-date">${endCell}</td>
        <td class="eta-tc-cats">${catsCell}</td>
        <td class="eta-tc eta-tc-status">${statusCell}</td>
      </tr>${detailRow}`;
  }).join('');

  // Tooltip hints on buttons
  const importTitle = allValid
    ? `Run all ${_parsedRows.length} row${_parsedRows.length !== 1 ? 's' : ''} and create the sales`
    : `Fix ${totalErrors} error${totalErrors !== 1 ? 's' : ''} before importing`;

  outputEl.innerHTML = `
    <div class="eta-summary-bar eta-block-gap">${summaryParts}</div>
    <div class="eta-table-wrap">
      <table class="eta-table">
        <thead>
          <tr>
            <th>#</th><th>Sale name</th><th>Discount</th><th>Region</th>
            <th>Start</th><th>End date</th><th>Categories</th><th></th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    ${!allValid ? `<p class="eta-import-blocked">⚠ Fix all errors before using Import Sales. Dry Run is still available for row 1.</p>` : ''}`;

  dryRunBtn.disabled = !row1Valid;
  dryRunBtn.title    = row1Valid ? 'Run row 1 only — stops at review page, no sale created' : 'Row 1 has errors';

  importBtn.disabled = !allValid;
  importBtn.title    = importTitle;
}

/* ─────────────────────────────────────────────
   Session management
───────────────────────────────────────────── */

function getSession() {
  const raw = sessionStorage.getItem(SESSION_DATA);
  return raw ? JSON.parse(raw) : null;
}

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY,  'true');
  sessionStorage.setItem(SESSION_DATA, JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_DATA);
}

/* ─────────────────────────────────────────────
   Step 1 — Start session / navigate to createSale
───────────────────────────────────────────── */

function startSession(rows, mode) {
  const anchor = document.querySelector('a[href*="sales-discounts/step/createSale"]');
  if (!anchor) {
    showStatus('Could not find the "Set up" link on this page.', 'error');
    return;
  }
  saveSession({ rows, index: 0, mode });
  sessionStorage.setItem(SESSION_NAV, '1');
  setProgress(0);
  anchor.click();
}

function advanceToNextRow(session) {
  const anchor = document.querySelector('a[href*="sales-discounts/step/createSale"]');
  if (!anchor) {
    finishProgress('Could not find the "Set up" link to start the next sale.');
    clearSession();
    return;
  }
  const nextSession = { ...session, index: session.index + 1 };
  saveSession(nextSession);
  sessionStorage.setItem(SESSION_NAV, '1');
  setProgress(0, `Sale ${nextSession.index + 1} of ${nextSession.rows.length}…`);
  anchor.click();
}

/* ─────────────────────────────────────────────
   Step 2 — Fill "Customise your sale" form
───────────────────────────────────────────── */

async function fillCreateSaleForm(session) {
  const { rows, index, mode } = session;
  const row = rows[index];
  const label = mode === 'import' && rows.length > 1
    ? `Sale ${index + 1} of ${rows.length}…`
    : null;

  try {
    setProgress(0, label);
    await waitForElement('[role="dialog"][aria-label="creation overlay"]');
    await sleep(600);

    setProgress(1, label);

    // ── Discount type ────────────────────────────────────
    const discountTypeSelect = document.querySelector('select[name="reward_type"]');
    if (discountTypeSelect) { setNativeSelectValue(discountTypeSelect, row.discount_type); await sleep(400); }

    // ── Percentage → Custom ──────────────────────────────
    if (row.discount_type === 'percent') {
      const percentDropdown = document.querySelector('select[name="reward_type_percent_dropdown"]');
      if (percentDropdown) { setNativeSelectValue(percentDropdown, '1'); await sleep(600); }
      const customInput = await waitForElement('input[name="reward_type_percent_input"]', 6000).catch(() => null);
      if (customInput) { setNativeInputValue(customInput, row.discount_percentage); await sleep(300); }
    }

    // ── Region ───────────────────────────────────────────
    const regionSelect = document.querySelector('select[name="eligible_region_id"]');
    if (regionSelect) { setNativeSelectValue(regionSelect, resolveRegionValue(regionSelect, row.region)); await sleep(300); }

    // ── Start date ───────────────────────────────────────
    const startLabel = [...document.querySelectorAll('label.screen-reader-only')]
      .find(l => l.textContent.trim() === 'Duration Start Date');
    if (startLabel) {
      const startInput = document.getElementById(startLabel.getAttribute('for'));
      if (startInput) await typeDate(startInput, row.start_date);
    }
    await sleep(300);

    // ── End date (−1 day for Etsy's display offset) ──────
    const endLabel = [...document.querySelectorAll('label.screen-reader-only')]
      .find(l => l.textContent.trim() === 'Duration End Date');
    if (endLabel) {
      const endInput = document.getElementById(endLabel.getAttribute('for'));
      if (endInput) await typeDate(endInput, subtractOneDay(row.end_date));
    }
    await sleep(300);

    // ── Sale name ────────────────────────────────────────
    const saleNameInput = document.querySelector('input[name="promo_name"]');
    if (saleNameInput) { setNativeInputValue(saleNameInput, row.sale_name); await sleep(300); }

    // ── Continue ─────────────────────────────────────────
    const continueBtn = [...document.querySelectorAll('button.wt-btn--filled')]
      .find(b => b.textContent.trim() === 'Continue');
    if (!continueBtn) { finishProgress('Could not find the Continue button.'); return; }

    setProgress(2, label);
    continueBtn.click();
    await sleep(1800);

    await fillListingsStep(session);

  } catch (err) {
    console.error('[ETA] fillCreateSaleForm error:', err);
    finishProgress(err.message);
  }
}

function resolveRegionValue(selectEl, regionName) {
  if (!regionName || regionName.trim().toLowerCase() === 'everywhere') return '0';
  const option = [...selectEl.options].find(
    o => o.text.trim().toLowerCase() === regionName.trim().toLowerCase()
  );
  if (!option) { console.warn(`[ETA] Region "${regionName}" not found — defaulting to Everywhere.`); return '0'; }
  return option.value;
}

/* ─────────────────────────────────────────────
   Step 3 — Select listings by shop section
───────────────────────────────────────────── */

async function fillListingsStep(session) {
  const { rows, index, mode } = session;
  const row   = rows[index];
  const label = mode === 'import' && rows.length > 1
    ? `Sale ${index + 1} of ${rows.length}…`
    : null;

  try {
    setProgress(3, label);

    const selectListingsRadio = await waitForElement(
      'input[name="is-shopwide"][value="listings"]', 12000
    );
    selectListingsRadio.click();
    const radioLabel = document.querySelector(`label[for="${selectListingsRadio.id}"]`);
    if (radioLabel) radioLabel.click();
    await sleep(700);

    const dropdownBtn = await waitForElementByText(
      '[data-dropdown-button="true"]', 'Add listings by shop section', 10000
    );
    dropdownBtn.click();
    await sleep(600);

    const categories = (row.categories || '').split('|').map(c => c.trim()).filter(Boolean);
    const unmatched  = [];

    for (const category of categories) {
      const isOpen = () => {
        const container = dropdownBtn.closest('[data-dropdown-container="true"]');
        const menu = container?.querySelector('[data-dropdown-target="true"]');
        return menu && !menu.classList.contains('is-closed');
      };
      if (!isOpen()) { dropdownBtn.click(); await sleep(500); }

      const menuItems = document.querySelectorAll(
        '[data-dropdown-target="true"]:not(.is-closed) [role="menuitem"]'
      );
      let clicked = false;
      for (const item of menuItems) {
        const nameSpan = item.querySelector('[data-test-id="unsanitize"]');
        if (nameSpan && nameSpan.textContent.trim() === category && !item.classList.contains('disabled')) {
          item.click();
          clicked = true;
          await sleep(400);
          break;
        }
      }
      if (!clicked) { console.warn(`[ETA] Category not matched: "${category}"`); unmatched.push(category); }
    }

    await sleep(600);

    if (unmatched.length > 0) warnStep(3, `${unmatched.length} not found`);

    // ── Review and confirm ───────────────────────────────
    const reviewBtn = [...document.querySelectorAll('button.wt-btn--filled')]
      .find(b => b.textContent.trim() === 'Review and confirm');
    if (!reviewBtn) { finishProgress('Could not find "Review and confirm" button.'); return; }

    setProgress(4, label);
    reviewBtn.click();
    await sleep(1500);

    // Etsy shows a listing-selection confirmation overlay with a "Done" submit
    // button before landing on the final review page — click it to proceed.
    const doneBtn = await waitForElementByText(
      'button[type="submit"].wt-btn--filled', 'Done', 8000
    ).catch(() => null);
    if (doneBtn) {
      doneBtn.click();
      await sleep(1000);
    }

    if (mode === 'dry-run') {
      // ── Dry run stops here — sale not created ────────
      clearSession();
      const warnings = unmatched.map(c => `"${c}" — not found in your shop sections`);
      finishProgress(null, warnings);

    } else {
      // ── Import mode — click "Confirm and create sale" ─
      await confirmAndContinue(session, unmatched);
    }

  } catch (err) {
    console.error('[ETA] fillListingsStep error:', err);
    finishProgress(err.message);
  }
}

/* ─────────────────────────────────────────────
   Step 4 (import only) — Confirm and advance
───────────────────────────────────────────── */

async function confirmAndContinue(session, unmatchedCategories = []) {
  const { rows, index } = session;

  try {
    const confirmBtn = await waitForElementByText(
      'button.wt-btn--filled', 'Confirm and create sale', 10000
    ).catch(() => null);

    if (!confirmBtn) {
      finishProgress('Could not find "Confirm and create sale" button.');
      clearSession();
      return;
    }

    confirmBtn.click();

    // Etsy shows a "Your sale is scheduled!" success overlay — click its Done
    // button to dismiss it before the page navigates back to sales-discounts.
    const successDoneBtn = await waitForElementByText(
      '[aria-label="success overlay"] button[type="submit"].wt-btn--filled',
      'Done',
      12000
    ).catch(() => null);

    if (!successDoneBtn) {
      finishProgress('Could not find the Done button on the success overlay.');
      clearSession();
      return;
    }

    successDoneBtn.click();

    // Now wait for the URL to leave createSale
    await waitForUrlNotContaining('createSale', 12000).catch(() => {});
    await sleep(1000);

    const isLastRow     = index >= rows.length - 1;
    const saleWarnings  = unmatchedCategories.map(c => `Row ${index + 1} — "${c}" not found in shop sections`);

    if (isLastRow) {
      clearSession();
      finishProgress(null, saleWarnings.length ? saleWarnings : []);
      if (!saleWarnings.length) {
        // Replace generic done message with count
        const panel = document.getElementById('eta-progress');
        if (panel) panel.querySelector('.eta-prog-title').textContent =
          `${rows.length} sale${rows.length !== 1 ? 's' : ''} created!`;
      }
    } else {
      // Persist any unmatched warnings and move on
      if (saleWarnings.length) console.warn('[ETA]', saleWarnings.join('\n'));
      advanceToNextRow(session);
    }

  } catch (err) {
    console.error('[ETA] confirmAndContinue error:', err);
    finishProgress(err.message);
    clearSession();
  }
}

function waitForUrlNotContaining(fragment, timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!location.href.includes(fragment)) return resolve();
    const ob = new MutationObserver(() => {
      if (!location.href.includes(fragment)) { ob.disconnect(); resolve(); }
    });
    ob.observe(document, { subtree: true, childList: true });
    setTimeout(() => { ob.disconnect(); reject(new Error(`URL still contains "${fragment}" after ${timeout}ms`)); }, timeout);
  });
}

/* ─────────────────────────────────────────────
   Init + SPA navigation watcher
───────────────────────────────────────────── */

// Matches only the exact base sales page, not sub-paths like /step/createSale
// Valid pages: exact sales-discounts base (optional trailing slash/query),
// or any /step/ sub-page. Pages like /details-stats are excluded.
// createSale is already caught first in the if-else chain.
const BASE_SALES_RE = /\/your\/shops\/me\/sales-discounts(\/step\/.*|[?#].*|\/?)$/;

function init() {
  const url = location.href;

  if (url.includes('/step/createSale')) {
    document.getElementById('eta-trigger-btn')?.remove();

    if (sessionStorage.getItem(SESSION_KEY) === 'true') {
      // Consume the one-time nav token — if missing the user refreshed, so abort
      if (!sessionStorage.getItem(SESSION_NAV)) {
        clearSession();
        return;
      }
      sessionStorage.removeItem(SESSION_NAV);

      const session = getSession();
      if (session) fillCreateSaleForm(session);
    }

  } else if (BASE_SALES_RE.test(url)) {
    if (sessionStorage.getItem(SESSION_KEY) === 'true') {
      // Consume nav token — if missing the user refreshed, so abort
      if (!sessionStorage.getItem(SESSION_NAV)) {
        clearSession();
        injectTriggerButton();
        return;
      }
      sessionStorage.removeItem(SESSION_NAV);

      // Navigated back mid-import — continue with next row
      const session = getSession();
      if (session && session.index < session.rows.length) {
        sleep(800).then(() => advanceToNextRow({ ...session, index: session.index - 1 }));
        return; // don't inject trigger button while automation is running
      }
    }
    injectTriggerButton();

  } else {
    document.getElementById('eta-trigger-btn')?.remove();
  }
}

let _lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastUrl) { _lastUrl = location.href; init(); }
}).observe(document, { subtree: true, childList: true });

init();
