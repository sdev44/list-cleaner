// List cleaner web page. Talks to the local server (src/server/app.ts).
const $ = id => document.getElementById(id);
const LABEL = { keep: 'Clean', review: 'Review', remove: 'Rejected', unchecked: 'Not checked' };
const KEY_FIELDS = ['name', 'website', 'category', 'address', 'phone', 'postal_code', 'state', 'business_status', 'search_term', 'search_location', 'maps_url', 'place_key'];
const PAGE = 100;

let S = null;                  // last /api/state
let view = { filter: 'all', q: '', offset: 0, total: 0 };
let polling = null, questionsSig = '', busy = false;

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}
let toastTimer;
function toast(text, error = false) {
  const t = $('toast'); t.textContent = text; t.hidden = false; t.classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3500);
}
async function act(fn, okText) {
  if (busy) return; busy = true;
  try { const r = await fn(); if (r && r.settings) { S = r; render(); } if (okText) toast(okText); return r; }
  catch (e) { toast(e.message, true); }
  finally { busy = false; }
}
const fmt = n => Number(n || 0).toLocaleString('en-GB');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- render ----------
function render() {
  const job = S.job;
  $('intro').hidden = !!job;
  $('drop').hidden = !!job;
  $('fileInfo').hidden = !job;
  for (const id of ['stepSetup', 'stepRun', 'stepResults']) $(id).hidden = true;
  if (!job) { stopPolling(); return; }

  // 1. list
  $('fileName').textContent = job.fileName;
  $('fileCount').textContent = `${fmt(job.businesses)} businesses`;
  renderColumns(job);
  if (job.message && !job.running) toast(job.message, /stopped|could not|rejected|failed/i.test(job.message));
  if (!job.mapping.name) { $('columns').open = true; return; }

  // 2. directory
  $('stepSetup').hidden = false;
  if (document.activeElement !== $('dirName')) $('dirName').value = job.directoryName || '';
  renderArea(job);
  $('buildRules').textContent = job.baseRules ? 'Rebuild rules' : 'Build rules';
  $('questionsBlock').hidden = !job.baseRules;
  if (job.baseRules) renderQuestions(job);

  // 3. clean
  if (!job.rules) return;
  $('stepRun').hidden = false;
  const c = job.counts, checked = c.keep + c.review + c.remove;
  const running = job.running;
  $('run').hidden = running;
  $('stop').hidden = !running;
  $('run').textContent = checked ? (c.unchecked ? `Check the rest (${fmt(c.unchecked)})` : 'All checked') : 'Start cleaning';
  $('run').disabled = !running && checked > 0 && !c.unchecked;
  $('runHint').textContent = !S.settings.hasKey
    ? 'No Jev key yet: businesses that need a judgment will go to Review. Add your key with Jev key at the top.'
    : checked ? 'Changing your answers above re-sorts the list straight away, without checking websites again.'
    : 'Websites are read and Jev is asked about businesses with evidence. Expect about 10–15 minutes for 2,000 businesses.';
  $('progress').hidden = !running;
  if (running) {
    const p = job.progress || { done: 0, total: 0 };
    $('progressFill').style.width = p.total ? `${Math.round(p.done / p.total * 100)}%` : '0';
    $('progressText').textContent = job.status === 'stopping' ? 'Stopping after the businesses in progress…' : `Checked ${fmt(p.done)} of ${fmt(p.total)}`;
  }

  // 4. results
  $('stepResults').hidden = checked === 0;
  if (checked) renderPiles(c);
  running || job.status === 'suggesting' ? startPolling() : stopPolling();
}

function renderColumns(job) {
  const box = $('colmap');
  const sig = job.headers.join('|') + JSON.stringify(job.mapping);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const fields = S.fields.filter(f => KEY_FIELDS.includes(f.key));
  box.innerHTML = fields.map(f => `<label>${esc(f.label)}<select data-key="${f.key}"><option value="">(none)</option>${job.headers.map(h => `<option ${job.mapping[f.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('');
  box.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
    const overrides = { ...job.mapOverrides };
    overrides[sel.dataset.key] = sel.value;
    act(() => api('/api/job/mapping', { method: 'PUT', body: { overrides } }), 'Columns updated.');
  }));
}

function renderArea(job) {
  const sel = $('area');
  if (!sel.options.length) {
    const us = Object.entries(S.areas).filter(([k]) => k.length === 2).sort((a, b) => a[1].localeCompare(b[1]));
    const uk = Object.entries(S.areas).filter(([k]) => k.length !== 2);
    sel.innerHTML = '<option value="">No area check</option>'
      + `<optgroup label="United Kingdom">${uk.map(([k, v]) => `<option value="${k}">${esc(k === 'UK' ? 'United Kingdom (any nation)' : v)}</option>`).join('')}</optgroup>`
      + `<optgroup label="United States">${us.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</optgroup>`;
  }
  if (document.activeElement !== sel) sel.value = job.area || '';
  const g = job.areaGuess, total = Object.values(g.counts).reduce((a, b) => a + b, 0);
  $('areaHint').textContent = g.code ? `Most businesses with an address are in ${g.name} (${fmt(g.counts[g.code])} of ${fmt(total)}). Businesses outside the area you choose are checked for whether they serve it.` : 'No addresses found, so the area can’t be guessed.';
}

function renderQuestions(job) {
  // Suggestions
  const sp = job.suggestProgress;
  $('suggest').disabled = job.status === 'suggesting' || !S.settings.hasKey;
  $('suggest').textContent = job.suggestSummary ? 'Get suggestions again' : 'Get suggestions';
  $('suggestText').textContent = !S.settings.hasKey ? 'Add your Jev key (top of the page) and Jev can suggest what to keep and remove, from the Google categories in your list.'
    : job.suggestSummary ? 'Jev looked at the Google categories in your list. Its suggestions are in the questions below.'
    : 'Jev can look at the Google categories in your list and suggest what to keep and remove. It takes a minute and costs well under 1p.';
  $('suggestProgress').hidden = job.status !== 'suggesting';
  $('suggestProgress').textContent = sp && sp.total ? `Asking Jev about categories… ${sp.done} of ${sp.total}` : 'Asking Jev about categories…';
  $('suggestSummary').hidden = true;

  // Questions (rebuilt only when they change, so ticking doesn't lose focus)
  const sig = JSON.stringify(job.questions.map(q => [q.id, q.options.map(o => o.value)])) + (job.advancedRules ? 'adv' : '');
  const form = $('questions');
  if (sig !== questionsSig) {
    questionsSig = sig;
    form.innerHTML = job.questions.map(q => `
      <fieldset class="q" data-id="${q.id}" data-type="${q.type}" ${job.advancedRules ? 'disabled' : ''}>
        <legend>${esc(q.title)}</legend>
        ${q.help ? `<p class="hint">${esc(q.help)}</p>` : ''}
        <div class="options">${q.options.map(o => `
          <label class="opt"><input type="${q.type === 'multi' ? 'checkbox' : 'radio'}" name="q-${q.id}" value="${esc(o.value)}">
            <span class="label">${esc(o.label)}${o.count != null ? ` <span class="count">(${fmt(o.count)})</span>` : ''}</span>
            ${o.detail ? `<span class="detail">${esc(o.detail)}</span>` : ''}</label>`).join('')}
        </div>
      </fieldset>`).join('') || '<p class="hint">No questions for this list.</p>';
  }
  for (const q of job.questions) {
    const values = Array.isArray(q.value) ? q.value : [q.value];
    form.querySelectorAll(`[name="q-${q.id}"]`).forEach(i => { i.checked = values.includes(i.value); });
  }
  if (document.activeElement !== $('rulesJson')) $('rulesJson').value = JSON.stringify(job.rules, null, 2);
  $('resetRules').hidden = !job.advancedRules;
}

function renderPiles(c) {
  const parts = [['keep', c.keep], ['review', c.review], ['remove', c.remove], ['unchecked', c.unchecked]].filter(([, n]) => n > 0);
  const total = parts.reduce((a, [, n]) => a + n, 0) || 1;
  $('piles').innerHTML = parts.map(([k, n]) => `<div class="pile ${k}" style="flex-grow:${n}" title="${LABEL[k]}: ${fmt(n)}">${n / total > 0.06 ? fmt(n) : ''}</div>`).join('');
  $('piles').setAttribute('aria-label', parts.map(([k, n]) => `${LABEL[k]} ${fmt(n)}`).join(', '));
  $('pileLegend').innerHTML = parts.map(([k, n]) => `<span><span class="sw" style="background:var(--${k})"></span>${LABEL[k]} <b>${fmt(n)}</b></span>`).join('')
    + (c.overridden ? `<span>Set by you <b>${fmt(c.overridden)}</b></span>` : '');
  const tabs = [['all', 'All', c.keep + c.review + c.remove + c.unchecked], ['keep', 'Clean', c.keep], ['review', 'Review', c.review], ['remove', 'Rejected', c.remove]];
  if (c.unchecked) tabs.push(['unchecked', 'Not checked', c.unchecked]);
  $('tabs').innerHTML = tabs.map(([k, l, n]) => `<button type="button" role="tab" class="tab" data-f="${k}" aria-selected="${view.filter === k}">${l}<span class="c">${fmt(n)}</span></button>`).join('');
}

async function loadRows() {
  if (!S?.job || $('stepResults').hidden) return;
  const { total, rows } = await api(`/api/job/rows?filter=${view.filter}&q=${encodeURIComponent(view.q)}&offset=${view.offset}&limit=${PAGE}`);
  view.total = total;
  $('bulkCount').textContent = fmt(total);
  $('pageText').textContent = total ? `${fmt(view.offset + 1)}–${fmt(Math.min(total, view.offset + PAGE))} of ${fmt(total)}` : '';
  $('prev').disabled = view.offset === 0; $('next').disabled = view.offset + PAGE >= total;
  const opt = (v, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''} ${v === 'unchecked' ? 'disabled' : ''}>${LABEL[v]}</option>`;
  $('rows').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td class="biz"><span class="name">${r.mapsUrl ? `<a href="${esc(r.mapsUrl)}" target="_blank" rel="noopener" style="color:inherit">${esc(r.name)}</a>` : esc(r.name)}</span>
        <div class="sub">${esc(r.category)}${r.website ? ` · <a href="${esc(/^https?:/i.test(r.website) ? r.website : 'http://' + r.website)}" target="_blank" rel="noopener">website</a>` : ''}</div></td>
      <td class="where">${esc(r.area || '—')}${r.miles !== '' && r.miles !== 0 && r.miles != null ? `<br>${fmt(r.miles)} miles out` : ''}</td>
      <td><select class="result ${r.result}" data-i="${r.i}" aria-label="Result for ${esc(r.name)}">${['keep', 'review', 'remove', 'unchecked'].map(v => opt(v, r.result)).join('')}</select>
        ${r.overridden ? `<span class="mine">Your decision · <a href="#" data-undo="${r.i}">undo</a></span>` : ''}</td>
      <td class="why">${esc(r.reason)}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="empty">${view.q ? 'Nothing matches that search.' : 'No businesses here.'}</td></tr>`;
}

// ---------- polling ----------
function startPolling() {
  if (polling) return;
  let n = 0;
  polling = setInterval(async () => {
    try { S = await api('/api/state'); render(); if (++n % 3 === 0 || !S.job?.running) loadRows(); } catch { /* server restarting */ }
  }, 1000);
}
function stopPolling() { if (polling) { clearInterval(polling); polling = null; loadRows(); } }

// ---------- events ----------
async function upload(file) {
  if (!file) return;
  toast(`Reading ${file.name}…`);
  await act(() => api('/api/upload', { method: 'POST', body: file, headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } }));
  view = { filter: 'all', q: '', offset: 0, total: 0 }; questionsSig = '';
  loadRows();
}
$('file').addEventListener('change', e => upload(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); });

$('newList').addEventListener('click', () => {
  if (S?.job && !confirm('Start a new list? Download your results first if you need them: this list, its results and settings will be cleared from the page.')) return;
  act(() => api('/api/job/new', { method: 'POST' })).then(() => { $('file').value = ''; questionsSig = ''; $('area').innerHTML = ''; });
});

$('buildRules').addEventListener('click', () => {
  const had = !!S.job?.baseRules;
  if (had && !confirm('Rebuild the rules from scratch? Your answers and any suggestions will be reset.')) return;
  questionsSig = '';
  act(() => api('/api/job/setup', { method: 'PUT', body: { name: $('dirName').value, area: $('area').value } }), had ? 'Rules rebuilt.' : 'Rules built. Get suggestions, then check the questions.');
});
$('area').addEventListener('change', () => {
  if (!S.job?.baseRules) return;
  act(() => api('/api/job/setup', { method: 'PUT', body: { name: $('dirName').value, area: $('area').value } }), 'Area changed: rules rebuilt.');
});

$('suggest').addEventListener('click', async () => {
  $('suggest').disabled = true; questionsSig = '';
  startPolling();
  await act(() => api('/api/job/suggest', { method: 'POST' }), 'Suggestions added to the questions.');
});

const sendAnswer = debounce((id, value) => act(() => api('/api/job/answers', { method: 'PUT', body: { answers: { [id]: value } } })).then(() => loadRows()), 350);
$('questions').addEventListener('change', e => {
  const fs = e.target.closest('fieldset.q'); if (!fs) return;
  const inputs = [...fs.querySelectorAll('input')];
  const value = fs.dataset.type === 'multi' ? inputs.filter(i => i.checked).map(i => i.value) : (inputs.find(i => i.checked)?.value ?? '');
  sendAnswer(fs.dataset.id, value);
});

$('saveRules').addEventListener('click', () => {
  let rules; try { rules = JSON.parse($('rulesJson').value); } catch { return toast('Those rules aren’t valid JSON.', true); }
  questionsSig = '';
  act(() => api('/api/job/rules', { method: 'PUT', body: { rules } }), 'Advanced rules saved.').then(() => loadRows());
});
$('resetRules').addEventListener('click', () => { questionsSig = ''; act(() => api('/api/job/rules', { method: 'PUT', body: { rules: null } }), 'Using your answers again.').then(() => loadRows()); });

$('run').addEventListener('click', () => act(() => api('/api/job/run', { method: 'POST' })).then(() => startPolling()));
$('stop').addEventListener('click', () => act(() => api('/api/job/stop', { method: 'POST' }), 'Stopping. Progress is saved.'));

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  view.filter = b.dataset.f; view.offset = 0;
  $('tabs').querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t === b));
  loadRows();
});
$('search').addEventListener('input', debounce(() => { view.q = $('search').value; view.offset = 0; loadRows(); }, 250));
$('prev').addEventListener('click', () => { view.offset = Math.max(0, view.offset - PAGE); loadRows(); });
$('next').addEventListener('click', () => { view.offset += PAGE; loadRows(); });

$('rows').addEventListener('change', async e => {
  const sel = e.target.closest('select.result'); if (!sel) return;
  await act(() => api(`/api/job/rows/${sel.dataset.i}`, { method: 'PUT', body: { outcome: sel.value } }));
  S = await api('/api/state'); render(); loadRows();
});
$('rows').addEventListener('click', async e => {
  const a = e.target.closest('[data-undo]'); if (!a) return;
  e.preventDefault();
  await act(() => api(`/api/job/rows/${a.dataset.undo}`, { method: 'PUT', body: { outcome: null } }));
  S = await api('/api/state'); render(); loadRows();
});
$('bulkTo').addEventListener('change', async () => {
  const to = $('bulkTo').value; $('bulkTo').value = ''; if (!to) return;
  const what = to === 'clear' ? 'clear your decisions for' : `set ${LABEL[to]} for`;
  if (!confirm(`This will ${what} all ${fmt(view.total)} businesses matching this tab and search (not just this page). Go ahead?`)) return;
  const r = await act(() => api('/api/job/bulk', { method: 'POST', body: { filter: view.filter, q: view.q, outcome: to === 'clear' ? null : to } }));
  if (r) toast(`${fmt(r.changed)} businesses updated.`);
  S = await api('/api/state'); render(); loadRows();
});

// Settings
$('openSettings').addEventListener('click', () => {
  $('keyStatus').textContent = S.settings.hasKey ? (S.settings.keyFrom === 'env' ? 'A key is set in your .env file. Paste one here to use it instead.' : 'A key is saved.') : 'No key saved yet.';
  $('settings').showModal();
});
$('saveKey').addEventListener('click', async () => {
  const key = $('jevKey').value.trim();
  if (!key) { $('keyStatus').textContent = 'Paste a key first.'; return; }
  $('keyStatus').textContent = 'Testing…';
  try {
    S = await api('/api/settings', { method: 'PUT', body: { jevKey: key } }); render();
    const t = await api('/api/settings/test', { method: 'POST' });
    $('keyStatus').textContent = t.message; $('jevKey').value = '';
  } catch (e) { $('keyStatus').textContent = e.message; }
});

// Start
(async () => {
  try { S = await api('/api/state'); render(); loadRows(); }
  catch { toast('Can’t reach the list cleaner. Is the window running it still open?', true); }
})();
