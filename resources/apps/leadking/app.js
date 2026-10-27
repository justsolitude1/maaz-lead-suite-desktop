(() => {
  const KEY = 'leadking-replica-v1';
  const defaults = { leads: [], runs: [], settings: { theme: 'dark', concurrency: 2, delay: 1, timeout: 12, email: '' }, notice: true };
  let state;
  try { state = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { state = { ...defaults }; }
  state.settings = { ...defaults.settings, ...(state.settings || {}) };
  let activePage = 'search'; let activeRunFilter = null; let activeJobId = null; let activeJobKind = null; let paused = false; let toastTimer;
  const $ = id => document.getElementById(id);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = message => { const node = $('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3200); };
  async function api(url, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(url, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    let data; try { data = await response.json(); } catch { throw new Error(`Server returned HTTP ${response.status}.`); }
    if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    return data;
  }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ settings: state.settings, notice: state.notice })); } catch { toast('Could not save browser preferences.'); } refresh(); };
  const leadsForRun = runId => state.leads.filter(lead => lead.runId === runId);
  const pageNames = { search: 'Search', enrich: 'Enrich domains', therapist: 'Therapist emails', results: 'Lead results', history: 'Search history', settings: 'Settings' };
  function safeWebUrl(value) {
    try { const url = new URL(/^https?:\/\//i.test(value || '') ? value : `https://${value}`); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  }
  function go(page) {
    if (!pageNames[page]) return;
    activePage = page;
    document.querySelectorAll('.page').forEach(node => node.classList.toggle('active', node.id === `page-${page}`));
    document.querySelectorAll('.nav-button').forEach(node => node.classList.toggle('active', node.dataset.page === page));
    $('topTitle').textContent = pageNames[page];
    if (page === 'therapist') window.refreshTherapistQueue?.();
    if (page === 'results') renderResults(); if (page === 'history') renderHistory(); if (page === 'settings') loadSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function refresh() {
    const latest = state.runs[0]; const leads = latest ? leadsForRun(latest.id) : [];
    $('leadCount').textContent = state.leads.length; $('statBusinesses').textContent = leads.length;
    $('statEmails').textContent = leads.filter(x => x.emails?.length).length; $('statPhones').textContent = leads.filter(x => x.phones?.length).length;
    $('statRuns').textContent = state.runs.length; document.body.classList.toggle('light', state.settings.theme === 'light');
    document.querySelector('.notice').classList.toggle('hidden', !state.notice);
    if (activePage === 'results') renderResults(); if (activePage === 'history') renderHistory();
  }
  function showJobProgress(job, kind) {
    const prefix = kind === 'search' ? '' : 'enrich';
    const wrap = $(prefix ? 'enrichProgress' : 'progressWrap');
    const text = $(prefix ? 'enrichProgressText' : 'progressText');
    const pct = $(prefix ? 'enrichProgressPct' : 'progressPct');
    const bar = $(prefix ? 'enrichProgressBar' : 'progressBar');
    wrap.classList.remove('hidden'); text.textContent = job.progress?.message || 'Working…';
    pct.textContent = `${job.progress?.pct || 0}%`; bar.style.width = `${job.progress?.pct || 0}%`;
    if (kind === 'search') $('searchStatus').textContent = job.paused ? 'Paused. Requests will resume when you continue.' : job.progress?.message || 'Working…';
  }
  async function runJob(endpoint, payload, kind) {
    const start = await api(endpoint, payload); activeJobId = start.id; activeJobKind = kind; paused = false;
    let snapshot = start;
    while (true) {
      showJobProgress(snapshot, kind);
      if (snapshot.state === 'complete') {
        const results = [];
        for (let offset = 0; offset < (snapshot.resultCount || 0); offset += 200) {
          const batch = await api(`/api/jobs/${encodeURIComponent(activeJobId)}/results?offset=${offset}&limit=200`);
          results.push(...batch.results);
          if (kind === 'search') $('progressText').textContent = `Loading results: ${results.length} of ${snapshot.resultCount}…`;
        }
        snapshot.result = results;
        return snapshot;
      }
      if (snapshot.state === 'error' || snapshot.state === 'stopped') throw new Error(snapshot.error || (snapshot.state === 'stopped' ? 'Stopped by user.' : 'The crawl failed.'));
      await delay(650); snapshot = await api(`/api/jobs/${encodeURIComponent(activeJobId)}`);
    }
  }
  function makeSavedLeads(jobId, data) {
    return data.map((item, index) => {
      const emails = Array.isArray(item.emails) ? item.emails : item.email ? [{ value: item.email, status: 'Public', label: 'Public page' }] : [];
      const phones = Array.isArray(item.phones) ? item.phones : item.phone ? [{ value: item.phone, type: 'Business' }] : [];
      const sources = item.sources || (item.source ? [item.source] : []);
      const score = Number(item.score) || 0;
      return { ...item, id: `${jobId}-${index}`, runId: jobId, emails, phones, socials: item.socials || [], sources, score, score_level: item.score_level || (score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low'), score_reasons: item.score_reasons || [] };
    });
  }
  async function saveCompletedRun(job, query, location, source) {
    const leads = makeSavedLeads(job.id, job.result || []);
    const run = { id: job.id, query, location, startedAt: new Date().toISOString(), status: 'Complete', count: leads.length, source };
    let cloudSyncFailed = '';
    let cloudNotConnected = false;
    const saveBatch = async payload => {
      const result = await api('/api/save-run', payload);
      if (result.cloudSync?.status === 'failed') cloudSyncFailed = result.cloudSync.error || 'Supabase upload failed.';
      if (result.cloudSync?.status === 'not_connected') cloudNotConnected = true;
    };
    if (!leads.length) await saveBatch({ run, leads: [], final: true });
    for (let offset = 0; offset < leads.length; offset += 150) {
      await saveBatch({ run, leads: leads.slice(offset, offset + 150), append: offset > 0, final: offset + 150 >= leads.length });
    }
    state.runs.unshift(run); state.runs = state.runs.slice(0, 300); state.leads = [...leads, ...state.leads]; persist();
    return { run, leads, cloudSyncFailed, cloudNotConnected };
  }
  function downloadMapsWorkbook(leads, run) {
    if (!leads.length) return false;
    // Spreadsheet-friendly CSV opens directly in Excel and keeps the requested two columns.
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const text = '\uFEFF' + ['Company name,Website', ...leads.map(row => [quote(row.name), quote(row.website)].join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    const safeQuery = String(run.query || 'maps-leads').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48) || 'maps-leads';
    link.href = url; link.download = `google-maps-${safeQuery}-${new Date(run.startedAt).toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  function setBusy(kind, busy) {
    if (kind === 'search') { $('startSearch').disabled = busy; $('pauseSearch').disabled = !busy; $('stopSearch').disabled = !busy; }
    else { $('enrichButton').disabled = busy; $('cancelEnrich').disabled = !busy; }
  }
  async function startSearch() {
    const query = $('query').value.trim(); let location = $('location').value.trim();
    if (!query) { $('query').focus(); toast('Enter a keyword or search phrase first.'); return; }
    if (!location) { const match = query.match(/\bin\s+(.+)$/i); if (match) location = match[1].trim(); }
    if (!$('consent').checked) { toast('Please review and accept the responsible-use rules.'); $('consent').focus(); return; }
    if (!location && $('mapsSource').checked) { toast('Enter a target city, district, or area for Google Maps search.'); $('location').focus(); return; }
    if (!location) { toast('Add a city or district for a bounded OpenStreetMap search.'); $('location').focus(); return; }
    setBusy('search', true); $('progressBar').style.width = '1%'; $('progressPct').textContent = '1%'; $('progressWrap').classList.remove('hidden'); $('searchStatus').textContent = 'Starting live discovery…';
    try {
      const job = await runJob('/api/search', { query, location, maxResults: $('maxResults').value, pagesPerSite: $('pages').value, concurrency: $('concurrency').value, delay: $('settingDelay').value || 1, timeout: $('settingTimeout').value || 12, requireEmail: $('requireEmail').checked, requirePhone: $('requirePhone').checked, useGoogleMaps: $('mapsSource').checked }, 'search');
      const source = $('mapsSource').checked ? 'Google Maps' : 'OpenStreetMap';
      const { run, leads, cloudSyncFailed, cloudNotConnected } = await saveCompletedRun(job, query, location, source);
      const mapsExported = source === 'Google Maps' && downloadMapsWorkbook(leads, run);
      $('searchStatus').textContent = `Crawl complete. Saved ${job.result?.length || 0} live businesses locally.`;
      if (job.warning) toast(job.warning);
      else if (cloudSyncFailed) toast(`Saved locally. Supabase upload needs attention: ${cloudSyncFailed}`);
      else if (cloudNotConnected && leads.length) toast(`Saved ${leads.length} businesses locally. Sign in to Supabase to back them up to the cloud.`);
      else if (mapsExported) toast(`Saved ${leads.length} leads and downloaded the Excel-ready spreadsheet${leads.length ? ' · cloud backup complete' : ''}.`);
      else toast(`Live search complete. ${job.result?.length || 0} businesses saved${leads.length && !cloudNotConnected ? ' · cloud backup complete' : ''}.`);
      activeRunFilter = null; go('results');
    } catch (error) { $('searchStatus').textContent = error.message; toast(error.message); }
    finally { activeJobId = null; activeJobKind = null; setBusy('search', false); }
  }
  function normalizeDomain(input) {
    let raw = input.trim().replace(/^\uFEFF/, ''); if (!raw || raw.startsWith('#')) return '';
    try { if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`; const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) ? url.origin : ''; } catch { return ''; }
  }
  async function importDomains(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const first = (lines.shift() || '').replace(/^\uFEFF/, '');
    const headers = first.split(/[;,\t]/).map(x => x.replace(/^"|"$/g, '').trim().toLowerCase());
    let column = headers.findIndex(x => ['website', 'domain', 'url'].includes(x));
    if (column < 0) { lines.unshift(first); column = 0; }
    const domains = [...new Set(lines.map(line => normalizeDomain((line.split(/[;,\t]/)[column] || line.split(/[;,\t]/)[0] || '').replace(/^"|"$/g, ''))).filter(Boolean))].slice(0, 50);
    if (!domains.length) { toast('No valid public website domains found.'); return; }
    setBusy('enrich', true); $('enrichProgress').classList.remove('hidden');
    try {
      const job = await runJob('/api/enrich', { domains, pagesPerSite: $('pages')?.value || 3, concurrency: $('settingConcurrency').value || 2, delay: $('settingDelay').value || 1, timeout: $('settingTimeout').value || 12 }, 'enrich');
      const query = `Enriched ${domains.length} domain${domains.length === 1 ? '' : 's'}`;
      const saved = await saveCompletedRun(job, query, '', 'User-imported domains');
      $('domainText').value = ''; $('fileName').textContent = '';
      toast(saved.cloudSyncFailed ? `Crawled and saved locally; Supabase upload needs attention: ${saved.cloudSyncFailed}` : saved.cloudNotConnected ? 'Crawled and saved locally. Sign in to Supabase to back up to the cloud.' : `Crawled ${job.result?.length || 0} public websites${saved.leads.length ? ' · cloud backup complete' : ''}.`); go('results');
    } catch (error) { toast(error.message); $('enrichProgressText').textContent = error.message; }
    finally { activeJobId = null; activeJobKind = null; setBusy('enrich', false); }
  }
  async function controlJob(action) {
    if (!activeJobId) return;
    try { const result = await api(`/api/jobs/${encodeURIComponent(activeJobId)}/${action}`, {}); paused = result.paused; }
    catch (error) { toast(error.message); }
  }
  function renderResults() {
    const q = ($('resultSearch').value || '').toLowerCase().trim(); const emailFilter = $('emailFilter').value; const scoreFilter = $('scoreFilter').value;
    const rows = state.leads.filter(row => {
      if (activeRunFilter && row.runId !== activeRunFilter) return false;
      const haystack = [row.name, row.category, row.website, row.address, row.source, ...(row.emails || []).map(e => e.value), ...(row.phones || []).map(p => p.value)].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (emailFilter === 'email' && !row.emails?.length) return false;
      if (emailFilter === 'phone' && !row.phones?.length) return false;
      if (emailFilter === 'verified' && !(row.emails || []).some(e => e.status === 'Verified')) return false;
      if (scoreFilter === 'high' && row.score < 70) return false; if (scoreFilter === 'medium' && row.score < 40) return false;
      return true;
    });
    const mapsOnly = rows.length > 0 && rows.every(row => row.source === 'Google Maps' || (row.sources || []).includes('Google Maps'));
    $('resultsTable').classList.toggle('maps-results', mapsOnly);
    $('emailFilter').hidden = mapsOnly; $('scoreFilter').hidden = mapsOnly;
    $('emptyResults').classList.toggle('hidden', rows.length > 0);
    $('resultsBody').innerHTML = rows.map(row => {
      const email = (row.emails || []).map(e => e.value).join(', '); const phone = (row.phones || []).map(e => e.value).join(', '); const href = safeWebUrl(row.website);
      const scoreClass = row.score >= 70 ? '' : row.score >= 40 ? 'score-med' : 'score-low';
      const source = row.sources?.length ? [...new Set(row.sources)].join(', ') : row.source || '—';
      return `<tr><td><input type="checkbox" class="row-check" data-id="${esc(row.id)}" /></td><td><div class="biz-name">${esc(row.name)}</div><div class="biz-category">${esc(row.category || 'Business')}</div></td><td>${email ? `<div class="contact-line">✉ &nbsp;${esc(email)}</div>` : ''}${phone ? `<div class="contact-line">◉ &nbsp;${esc(phone)}</div>` : ''}${!email && !phone ? '<span class="biz-category">No contact found</span>' : ''}</td><td>${href ? `<a class="website" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(row.website)}</a>` : '<span class="biz-category">—</span>'}</td><td><span class="source-tag">${esc(source)}</span></td><td><span class="score ${scoreClass}">${Number(row.score) || 0}</span></td><td><button class="row-more" data-detail="${esc(row.id)}" aria-label="Open details">···</button></td></tr>`;
    }).join('');
    $('resultsCount').textContent = `${rows.length} business${rows.length === 1 ? '' : 'es'}`;
    $('selectAll').checked = rows.length > 0 && [...$('resultsBody').querySelectorAll('.row-check')].every(node => node.checked);
  }
  const csvFields = ['name', 'category', 'emails', 'phones', 'whatsapp', 'website', 'address', 'score', 'score_level', 'score_reasons', 'sources'];
  function exportCsv() {
    const selected = [...document.querySelectorAll('.row-check:checked')].map(node => node.dataset.id);
    const visible = [...$('resultsBody').querySelectorAll('tr')].map(row => row.querySelector('.row-check')?.dataset.id).filter(Boolean); const ids = selected.length ? selected : visible;
    const rows = state.leads.filter(row => ids.includes(row.id)); if (!rows.length) { toast('There are no visible results to export.'); return; }
    const fields = rows.every(row => row.source === 'Google Maps' || (row.sources || []).includes('Google Maps')) ? ['name', 'website'] : csvFields;
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const cell = (row, key) => key === 'emails' ? (row.emails || []).map(x => `${x.value}${x.status === 'Verified' ? ' (Verified)' : ''}`).join('; ') : key === 'phones' ? (row.phones || []).map(x => x.value).join('; ') : key === 'sources' ? (row.sources || []).join('; ') : key === 'score_reasons' ? (row.score_reasons || []).join('; ') : row[key] ?? '';
    const text = '\uFEFF' + [fields.join(','), ...rows.map(row => fields.map(key => quote(cell(row, key))).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'leadking-results.csv'; link.click(); URL.revokeObjectURL(url); toast(`${rows.length} results exported.`);
  }
  function showDetails(id) {
    const row = state.leads.find(item => item.id === id); if (!row) return;
    $('detailName').textContent = row.name;
    const emails = row.emails?.length ? row.emails.map(e => `${e.value} · ${e.status || 'Public'}`).join('<br>') : 'No public email found';
    const phones = row.phones?.length ? row.phones.map(p => p.value).join('<br>') : 'No public phone found';
    const socials = row.socials?.length ? row.socials.map(s => typeof s === 'string' ? s : s.value).join('<br>') : '—';
    $('detailBody').innerHTML = `<div class="detail-grid"><div class="detail-cell"><div class="detail-label">CATEGORY</div><div class="detail-value">${esc(row.category || 'Business')}</div></div><div class="detail-cell"><div class="detail-label">LEAD SCORE</div><div class="detail-value">${Number(row.score) || 0}/100 · ${esc(row.score_level || 'Low')}</div></div><div class="detail-cell wide"><div class="detail-label">EMAILS</div><div class="detail-value">${esc(emails)}</div></div><div class="detail-cell wide"><div class="detail-label">PHONES</div><div class="detail-value">${esc(phones)}</div></div><div class="detail-cell"><div class="detail-label">WEBSITE</div><div class="detail-value">${esc(row.website || '—')}</div></div><div class="detail-cell"><div class="detail-label">SOURCE</div><div class="detail-value">${esc((row.sources || [row.source]).filter(Boolean).join(', '))}</div></div><div class="detail-cell wide"><div class="detail-label">SOCIAL LINKS</div><div class="detail-value">${esc(socials)}</div></div><div class="detail-cell wide"><div class="detail-label">ADDRESS</div><div class="detail-value">${esc(row.address || row.city || '—')}</div></div><div class="detail-cell wide"><div class="detail-label">SCORING EVIDENCE</div><div class="detail-value">${esc((row.score_reasons || []).join(' · ') || 'No scoring evidence')}</div></div><div class="detail-cell wide"><div class="detail-label">SOURCE RECORD</div><div class="detail-value">${row.source_url ? `<a href="${esc(safeWebUrl(row.source_url) || '#')}" target="_blank" rel="noreferrer">${esc(row.source_url)}</a>` : '—'}</div></div></div>`;
    $('detailDialog').showModal();
  }
  function renderHistory() {
    $('historyCount').textContent = `${state.runs.length} RUN${state.runs.length === 1 ? '' : 'S'}`; $('emptyHistory').classList.toggle('hidden', state.runs.length > 0);
    $('historyList').innerHTML = state.runs.map(run => `<div class="history-item"><div><div class="history-query">${esc(run.query)}</div><div class="history-meta">${new Date(run.startedAt).toLocaleString()} · ${run.count} businesses · ${esc(run.status)}</div></div><span class="source-tag">${esc(run.source || 'Local crawl')}</span><div class="history-actions"><button class="secondary-button" data-open-run="${esc(run.id)}">Open results</button><button class="secondary-button" data-repeat-run="${esc(run.id)}">Run again</button><button class="secondary-button" data-delete-run="${esc(run.id)}">Delete run</button></div></div>`).join('');
  }
  function loadSettings() {
    $('settingConcurrency').value = state.settings.concurrency; $('settingDelay').value = state.settings.delay; $('settingTimeout').value = state.settings.timeout;
    $('settingEmail').value = state.settings.email || ''; $('settingTheme').value = state.settings.theme;
  }
  async function saveSettings() {
    state.settings = { ...state.settings, concurrency: Math.max(1, Math.min(3, Number($('settingConcurrency').value) || 2)), delay: Math.max(1, Number($('settingDelay').value) || 1), timeout: Math.max(5, Math.min(30, Number($('settingTimeout').value) || 12)), email: $('settingEmail').value.trim(), theme: $('settingTheme').value };
    try { await api('/api/settings', { settings: state.settings }); persist(); $('settingsStatus').textContent = 'Saved locally'; setTimeout(() => $('settingsStatus').textContent = '', 2200); toast('Settings saved on this device.'); }
    catch (error) { toast(error.message); }
  }
  async function bootstrap() {
    try {
      const server = await api('/api/state');
      state.runs = server.runs || []; state.leads = server.leads || []; state.settings = { ...state.settings, ...(server.settings || {}) }; persist();
    } catch { toast('Start the local server with “node server.mjs” to enable live searches.'); }
    refresh();
  }
  window.addEventListener('leadking:cloud-data-pulled', async () => {
    try {
      const server = await api('/api/state');
      state.runs = server.runs || []; state.leads = server.leads || [];
      state.settings = { ...state.settings, ...(server.settings || {}) };
      persist();
      if (activePage === 'history') renderHistory();
      if (activePage === 'results') renderResults();
    } catch (error) { toast(`Downloaded cloud data locally, but the screen could not refresh: ${error.message}`); }
  });

  document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => go(button.dataset.page)));
  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.go)));
  $('advancedToggle').addEventListener('click', () => { $('advancedPanel').classList.toggle('hidden'); $('advancedToggle').querySelector('span').textContent = $('advancedPanel').classList.contains('hidden') ? '+' : '−'; });
  $('startSearch').addEventListener('click', startSearch);
  const updateMapOptions = () => {
    const mapsEnabled = $('mapsSource').checked;
    for (const id of ['requireEmail', 'requirePhone']) {
      const input = $(id); input.disabled = mapsEnabled;
      input.closest('.check-row')?.classList.toggle('disabled-option', mapsEnabled);
    }
  };
  $('mapsSource').addEventListener('change', updateMapOptions); updateMapOptions();
  $('pauseSearch').addEventListener('click', async () => { if (!activeJobId || activeJobKind !== 'search') return; const next = paused ? 'resume' : 'pause'; await controlJob(next); $('pauseSearch').innerHTML = paused ? '▶ &nbsp; Resume' : 'Ⅱ &nbsp; Pause'; $('searchStatus').textContent = paused ? 'Paused. Requests will resume when you continue.' : 'Search resumed.'; });
  $('stopSearch').addEventListener('click', async () => { await controlJob('stop'); $('searchStatus').textContent = 'Stopping the current search…'; });
  $('cancelEnrich').addEventListener('click', async () => { await controlJob('stop'); $('enrichProgressText').textContent = 'Stopping the crawl…'; });
  $('query').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') startSearch(); });
  $('themeToggle').addEventListener('click', async () => { state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light'; persist(); try { await api('/api/settings', { settings: state.settings }); } catch { } });
  $('dismissNotice').addEventListener('click', () => { state.notice = false; persist(); });
  $('legalOpen').addEventListener('click', () => $('legalDialog').showModal()); $('footerLegal').addEventListener('click', () => $('legalDialog').showModal());
  $('legalClose').addEventListener('click', () => $('legalDialog').close()); $('legalAccept').addEventListener('click', () => { $('consent').checked = true; $('legalDialog').close(); });
  $('detailClose').addEventListener('click', () => $('detailDialog').close());
  $('chooseFile').addEventListener('click', () => $('domainFile').click());
  $('domainFile').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file) return; $('fileName').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`; $('domainText').value = await file.text(); });
  $('enrichButton').addEventListener('click', () => importDomains($('domainText').value));
  $('resultSearch').addEventListener('input', renderResults); $('emailFilter').addEventListener('change', renderResults); $('scoreFilter').addEventListener('change', renderResults);
  $('clearFilters').addEventListener('click', () => { $('resultSearch').value = ''; $('emailFilter').value = 'all'; $('scoreFilter').value = 'all'; activeRunFilter = null; renderResults(); });
  $('selectAll').addEventListener('change', () => document.querySelectorAll('.row-check').forEach(node => { node.checked = $('selectAll').checked; }));
  $('resultsBody').addEventListener('click', event => { const button = event.target.closest('[data-detail]'); if (button) showDetails(button.dataset.detail); });
  $('exportButton').addEventListener('click', exportCsv);
  $('historyList').addEventListener('click', async event => {
    const open = event.target.closest('[data-open-run]'); const repeat = event.target.closest('[data-repeat-run]'); const del = event.target.closest('[data-delete-run]');
    if (open) { const run = state.runs.find(item => item.id === open.dataset.openRun); if (run) { activeRunFilter = run.id; $('resultSearch').value = ''; go('results'); } }
    if (repeat) { const run = state.runs.find(item => item.id === repeat.dataset.repeatRun); if (run) { $('query').value = run.query; $('location').value = run.location || ''; go('search'); toast('Search details restored. Review the options and start a new live search.'); } }
    if (del) { const id = del.dataset.deleteRun; try { await api('/api/delete-run', { id }); state.runs = state.runs.filter(item => item.id !== id); state.leads = state.leads.filter(item => item.runId !== id); persist(); toast('Saved run removed from this device.'); } catch (error) { toast(error.message); } }
  });
  $('saveSettings').addEventListener('click', saveSettings);
  $('clearData').addEventListener('click', async () => { try { await api('/api/clear-data', {}); state.leads = []; state.runs = []; persist(); toast('Local crawl data cleared.'); } catch (error) { toast(error.message); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('detailDialog').close(); $('legalDialog').close(); } });
  document.addEventListener('click', event => { const link = event.target.closest('a.website'); if (link && link.href.includes('.example')) { event.preventDefault(); toast('Sample domains use reserved .example addresses.'); } });
  bootstrap();
})();
