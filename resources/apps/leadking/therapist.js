(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
  const pageSize = 150;
  let offset = 0;
  let importRows = [];
  let sourceFile = '';
  let activeJobId = '';
  let pollTimer = null;
  let learnedSettingsLoaded = false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function api(url, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(url, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    let data; try { data = await response.json(); } catch { throw new Error(`Server returned HTTP ${response.status}.`); }
    if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    return data;
  }
  function toast(message) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message; node.classList.add('show');
    clearTimeout(toast._timer); toast._timer = setTimeout(() => node.classList.remove('show'), 3800);
  }
  function parseCsv(text) {
    const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
    let quote = false; const counts = { ',': 0, ';': 0, '\t': 0 };
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === '"') { if (quote && firstLine[i + 1] === '"') i++; else quote = !quote; }
      else if (!quote && Object.hasOwn(counts, firstLine[i])) counts[firstLine[i]]++;
    }
    const delimiter = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = []; let cell = ''; quote = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quote && text[i + 1] === '"') { cell += '"'; i++; }
        else quote = !quote;
      } else if (!quote && char === delimiter) { row.push(cell); cell = ''; }
      else if (!quote && (char === '\n' || char === '\r')) {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
      } else cell += char;
    }
    row.push(cell); if (row.some(value => value.trim())) rows.push(row);
    if (rows.length < 2) throw new Error('The CSV needs a header row and at least one lead row.');
    const headers = rows.shift().map(value => value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[ _-]+/g, ' '));
    const find = aliases => headers.findIndex(header => aliases.includes(header));
    const indexes = {
      name: find(['name', 'business', 'company', 'practice', 'therapist', 'business name', 'company name', 'practice name']),
      website: find(['website', 'website url', 'url', 'domain', 'site', 'web']),
      city: find(['city', 'location', 'locality', 'town']),
      country: find(['country', 'country code']),
      address: find(['address', 'street address', 'full address']),
      source_url: find(['source url', 'source_url', 'listing url', 'profile url'])
    };
    if (indexes.website < 0) throw new Error('Could not find a website column. Use a header such as website, URL, or domain.');
    const get = (values, index) => index >= 0 ? String(values[index] || '').trim() : '';
    return rows.map((values, index) => ({ name: get(values, indexes.name), website: get(values, indexes.website), city: get(values, indexes.city), country: get(values, indexes.country), address: get(values, indexes.address), source_url: get(values, indexes.source_url), _row: index + 2 })).filter(row => row.website || row.name || row.city);
  }
  function renderStats(data) {
    $('therapistTotal').textContent = Number(data.total || 0).toLocaleString();
    $('therapistPending').textContent = Number(data.counts?.pending || 0).toLocaleString();
    $('therapistReview').textContent = Number(data.counts?.review || 0).toLocaleString();
    $('therapistUnverified').textContent = Number(data.candidateCounts?.unresolvedEvidence ?? data.candidateCounts?.needsHumanVerification ?? 0).toLocaleString();
    $('therapistPersonalStyle').textContent = Number(data.candidateCounts?.personalStyleCandidates || 0).toLocaleString();
    $('therapistApproved').textContent = Number(data.approvedUnique || 0).toLocaleString();
    $('therapistRate').textContent = Number(data.approvedUniqueLast25Minutes || 0).toLocaleString();
    renderCityCoverage(data.cityCoverage || []);
    renderLearning(data.learning || {}, data.rag || {}, data.coverage || {});
    if (!learnedSettingsLoaded && data.learning?.nextSettings) {
      const settings = data.learning.nextSettings;
      $('therapistPages').value = settings.pagesPerSite || 12;
      $('therapistConcurrency').value = settings.concurrency || 2;
      $('therapistDelay').value = settings.delaySeconds || 1;
      learnedSettingsLoaded = true;
    }
  }
  function renderCityCoverage(groups) {
    $('therapistCityCoverage').innerHTML = groups.map(group => {
      const noLeads = !group.total;
      const state = noLeads ? 'No leads imported' : group.researchComplete ? 'Research complete' : `${group.researched}/${group.total} researched`;
      const className = noLeads ? 'empty' : group.researchComplete ? 'complete' : 'incomplete';
      const details = noLeads ? 'Missing city rows' : `${group.pending} waiting · ${group.partial || 0} partial · ${group.needsEmailReview} unresolved candidates · ${group.blocked} blocked · ${group.failed} failed · ${group.approvedPersonalDirectUnique ?? group.approvedUnique} approved personal-direct`;
      return `<div class="city-coverage-item ${className}"><div class="city-coverage-top"><b>${esc(group.city)}</b><span>${esc(state)}</span></div><small>${esc(details)}</small></div>`;
    }).join('');
  }
  function renderLearning(learning, rag = {}, coverage = {}) {
    const runs = learning.runs || [];
    const latest = runs[0] || {};
    const next = latest.nextSettings || learning.nextSettings || {};
    const lessons = latest.lessons?.length ? latest.lessons : ['No completed run lessons yet. Rules are active from local RAG memory.'];
    const about = latest.aboutSection || {};
    const descriptions = latest.professionalDescription || {};
    const retrieved = rag.coreRules || [];
    $('therapistLearning').innerHTML = `<div class="learning-summary"><div class="learning-metrics"><span><b>${Number(coverage.sourceRows || 0).toLocaleString()}</b> source rows</span><span><b>${Number(coverage.terminalRows || 0).toLocaleString()}</b> row dispositions</span><span><b>${Number(coverage.pendingRows || 0).toLocaleString()}</b> rows not terminal</span><span><b>${Number(coverage.candidatePending || 0).toLocaleString()}</b> email candidates not terminal</span><span><b>${Number(latest.uniqueCandidates || 0).toLocaleString()}</b> candidate addresses, latest run</span><span><b>${Number(latest.approvedPersonalDirectEmails || 0).toLocaleString()}</b> approved personal-direct, latest run</span><span><b>${Number(coverage.identityConflictEmails || 0).toLocaleString()}</b> identity-conflict emails held from export</span><span><b>${Number(latest.optionalSoloEvidenceEmails || 0).toLocaleString()}</b> with optional solo evidence</span><span><b>${Number(latest.rowsPerMinute || 0)}</b> rows/min, latest run</span><span><b>${Number(about.visited || 0)}</b> About/bio pages visited</span><span><b>${Number(descriptions.rowsWithSnippet || 0)}</b> public context snippets</span></div><p class="therapist-copy"><b>Next settings:</b> ${Number(next.concurrency || 2)} concurrent sites · ${Number(next.delaySeconds || 1)} sec/domain · ${Number(next.pagesPerSite || 12)} pages/site. Full coverage is shown only when source rows and candidate dispositions reconcile; blocked/failed rows remain visible exceptions.</p><ul class="learning-lessons">${lessons.map(item => `<li>${esc(item)}</li>`).join('')}</ul><details open><summary>Retrieved current rules · ${esc(rag.policyVersion || 'personal-direct-v1')}</summary><ul class="learning-lessons">${retrieved.map(rule => `<li><b>${esc(rule.id)}:</b> ${esc(rule.text)}</li>`).join('') || '<li>Rules load from the local RAG policy.</li>'}</ul></details><details><summary>${runs.length} run learning log${runs.length === 1 ? '' : 's'} saved locally</summary><div class="learning-history">${runs.slice(0, 12).map(run => `<div><b>${esc(new Date(run.completedAt).toLocaleString())}</b> · ${Number(run.rows || 0)} rows · ${Number(run.rowsPerMinute || 0)} rows/min · ${Number(run.uniqueCandidates || 0)} candidates · ${Number(run.approvedPersonalDirectEmails || 0)} approved personal-direct · ${Number(run.optionalSoloEvidenceEmails || 0)} with solo evidence · ${Number(run.aboutSection?.visited || 0)} About/bio pages · ${Number(run.professionalDescription?.rowsWithSnippet || 0)} context snippets · ${Number(run.exceptionRate || 0) * 100}% exceptions</div>`).join('')}</div></details></div>`;
  }
  function badge(status) {
    const labels = { pending: 'Waiting', researching: 'Researching', review: 'Candidates found', partial: 'Partial / retry needed', complete_no_email: 'No public email', failed: 'Failed', blocked: 'Blocked', no_website: 'No website' };
    return `<span class="research-status ${esc(status)}">${esc(labels[status] || status)}</span>`;
  }
  function renderCandidate(row, candidate) {
    const isRole = candidate.inboxType === 'shared_or_role_inbox';
    const identityReview = candidate.identityRagAssessment || {};
    const approved = ['approved_personal_direct','approved_solo'].includes(candidate.disposition)
      && Boolean(candidate.verification?.directContactEvidence && candidate.verification?.directEvidenceUrl)
      && identityReview.ok === true && !candidate.identityConflict && !isRole;
    const verifiedDuringHarvest = approved && ['harvest_evidence_rules_v2','harvest_person_email_rules_v3'].includes(candidate.verification?.verificationMethod);
    const sourceUrl = safeUrl(candidate.evidenceUrl);
    const profileUrl = safeUrl(candidate.practitionerProfileUrl);
    const verification = candidate.verification || {};
    const triageLabels = { person_name_match_needs_evidence: 'Named-person contact · check evidence', person_name_fragment_needs_evidence: 'Possible personal contact · check name match', direct_unmatched_needs_attribution: 'Person-looking · attribution needed', person_named_group_context: 'Personal contact · check independent practice', shared_or_role: 'Shared / role inbox', malformed_capture: 'Malformed capture' };
    const triage = candidate.triage || {};
    const emailStyle = candidate.emailStyle || {};
    const displayDisposition = verifiedDuringHarvest ? 'personal-direct · verified during harvest' : approved ? 'personal-direct · verified with evidence' : ['unresolved','needs_review','candidate_solo_evidence'].includes(candidate.disposition) || (['approved_solo','approved_personal_direct'].includes(candidate.disposition) && !approved) ? 'evidence incomplete · not exported' : String(candidate.disposition || 'needs_review').replaceAll('_', ' ');
    return `<article class="candidate-card ${approved ? 'approved' : ''}">
      <div class="candidate-main"><div><div class="candidate-email">${esc(candidate.email)} ${isRole ? '<span class="research-status excluded">shared / role inbox</span>' : ''}</div><div class="candidate-practitioner">${esc(candidate.practitionerName || 'Practitioner not confidently identified')} · ${verifiedDuringHarvest ? 'linked by public page evidence' : 'candidate attribution'}</div>${emailStyle.label ? `<div class="candidate-triage ${emailStyle.category === 'personal_name_style' ? 'priority' : ''}">${esc(emailStyle.label)}</div>` : ''}${triageLabels[triage.category] ? `<div class="candidate-triage">${esc(triageLabels[triage.category])}</div>` : ''}</div><span class="candidate-disposition">${esc(displayDisposition)}</span></div>
      ${triage.reasons?.length ? `<div class="candidate-evidence"><b>Triage note:</b> ${esc(triage.reasons.join(' '))}</div>` : ''}
      ${candidate.verificationAssessment?.reasons?.length ? `<div class="candidate-evidence"><b>Automated assessment:</b> ${esc(candidate.verificationAssessment.reasons.join('; ').replaceAll('_', ' '))}</div>` : ''}
      ${identityReview.reasons?.length ? `<div class="candidate-evidence"><b>Identity RAG hold (${esc(identityReview.version || 'identity-rag')}):</b> ${esc(identityReview.reasons.join('; ').replaceAll('_', ' '))}</div>` : ''}
      ${verifiedDuringHarvest ? `<div class="candidate-evidence"><b>Harvest verification:</b> Exact public email and named-practitioner attribution matched. Solo-practice status is recorded separately and is not required.</div>` : ''}
      ${candidate.nameEvidence ? `<div class="candidate-evidence"><b>Name evidence:</b> ${esc(candidate.nameEvidence)}</div>` : ''}
      ${candidate.emailEvidence ? `<blockquote>${esc(candidate.emailEvidence)}</blockquote>` : ''}
      ${candidate.practitionerBio ? `<blockquote><b>Clinician bio/context (${esc(candidate.practitionerBioSource || 'public profile')}):</b> ${esc(candidate.practitionerBio)}${safeUrl(candidate.practitionerBioUrl) ? ` <a href="${esc(safeUrl(candidate.practitionerBioUrl))}" target="_blank" rel="noreferrer">Evidence page</a>` : ''}${profileUrl ? ` · <a href="${esc(profileUrl)}" target="_blank" rel="noreferrer">Clinician profile</a>` : ''}</blockquote>` : ''}
      ${candidate.aboutSectionStatus ? `<div class="candidate-evidence"><b>About/bio crawl:</b> ${esc(candidate.aboutSectionStatus)} · ${Number(candidate.aboutPagesVisited?.length || 0)} page(s) visited${candidate.aboutPagesDiscovered ? ` · ${Number(candidate.aboutPagesDiscovered)} discovered` : ''}</div>` : ''}
      ${candidate.aboutEvidence ? `<blockquote><b>About/bio excerpt:</b> ${esc(candidate.aboutEvidence)}</blockquote>` : ''}
      ${candidate.professionalDescription ? `<blockquote><b>What this clinician does · public-page snippet (${esc(candidate.professionalDescriptionSource || 'website')}):</b> ${esc(candidate.professionalDescription)}${safeUrl(candidate.professionalDescriptionUrl) ? ` <a href="${esc(safeUrl(candidate.professionalDescriptionUrl))}" target="_blank" rel="noreferrer">Source page</a>` : ''}</blockquote>` : ''}
      <div class="candidate-source">Evidence: ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">${esc(sourceUrl)}</a>` : '<span>Unavailable or invalid URL</span>'}</div>
      ${candidate.soloEvidence || verification.soloStatusEvidence ? '<div class="candidate-evidence">Optional solo-practice evidence recorded separately.</div>' : ''}
      <div class="candidate-actions">${approved ? '<span class="research-status complete">Approved personal-direct contact</span>' : '<span class="research-status excluded">Not approved: named-person email evidence is incomplete or the inbox is shared</span>'}</div>
    </article>`;
  }
  function renderProfileEnrichment(row) {
    const people = new Map();
    const organizationTerms = new Set(['about','appointment','booking','center','centre','clinic','contact','counseling','counselling','group','institute','office','practice','psychology','therapy','therapist','wellness']);
    const personKey = value => String(value || '').normalize('NFKC').replace(/^Dr\.?\s+/i, '').replace(/\b(?:LCSW|LMSW|LMHC|LMFT|LCPC|LPC|LSW|CSW|PhD|PsyD|MD|DSW|MSW|MFT)\b/gi, ' ').replace(/[,.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const personLike = value => {
      const tokens = String(value || '').replace(/^Dr\.?\s+/i, '').trim().split(/\s+/).filter(Boolean);
      return tokens.length >= 2 && tokens.length <= 5 && !tokens.some(token => organizationTerms.has(token.toLowerCase().replace(/[^a-z]/g, '')));
    };
    if (personLike(row.name)) people.set(personKey(row.name), String(row.name).trim());
    for (const person of row.practitionerNames || []) {
      const name = String(person.name || '').trim();
      if (name) people.set(personKey(name), name);
    }
    for (const candidate of row.candidates || []) {
      const name = String(candidate.practitionerName || '').trim();
      if (name && name !== 'Name needs review' && name !== 'Practitioner not confidently identified') {
        people.set(personKey(name), name);
      }
    }
    if (!people.size) return '';
    const city = String(row.city || '').trim();
    return `<div class="profile-enrichment-list"><div class="profile-enrichment-heading"><b>Therapist profile search</b><span>Existing named therapists only · no new leads</span></div>${[...people.values()].map(name => {
      const saved = (row.profileEnrichments || []).find(item => personKey(item.practitionerName) === personKey(name));
      const automatic = saved?.reviewMethod === 'playwright_site_name_search';
      const status = saved?.identityStatus === 'confirmed_public_profile' ? 'Profile matched' : saved?.identityStatus === 'ambiguous_unresolved' ? 'Ambiguous · unresolved' : saved?.identityStatus === 'no_match' ? 'No match in first five' : saved?.identityStatus === 'robots_disallowed' ? 'Search disallowed' : saved?.identityStatus === 'blocked' ? 'Search blocked' : 'Not checked';
      const source = safeUrl(saved?.sourceUrl);
      return `<details class="profile-enrichment" data-profile-name="${esc(name)}" data-profile-city="${esc(city)}" data-profile-site="${esc(safeUrl(row.website))}" data-profile-row="${esc(row.id)}">
        <summary><b>${esc(name)}</b><span class="profile-enrichment-status">${esc(status)}</span></summary>
        ${saved?.identityStatus === 'confirmed_public_profile' ? `<blockquote><b>Public profile details:</b> ${esc(saved.publicDetails)}${source ? ` <a href="${esc(source)}" target="_blank" rel="noreferrer">Evidence page</a>` : ''}<small>${automatic ? 'Playwright checked' : 'Reviewed'} ${Number(saved.searchResultsReviewed || 0)} linked practice/profile page(s) · ${esc(saved.reviewedAt || '')}</small></blockquote>` : ''}
        ${saved?.reviewNote ? `<p class="profile-review-note">${esc(saved.reviewNote)}</p>` : ''}
        <p class="profile-enrichment-help">When the website crawl has no bio/context, Playwright revisits the saved practice website, follows its About, team, and clinician links, and checks up to five relevant linked pages. It saves details only from a page that contains the full name and professional context.</p>
        <button type="button" class="secondary-button profile-google-search" data-profile-action="search">Open practice website for ${esc(name)}${city ? ` · ${esc(city)}` : ''}</button>
        <div class="profile-enrichment-form hidden">
          <label>Linked practice/profile pages reviewed (maximum 5)<select class="profile-results-reviewed"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></label>
          <label class="profile-identity-confirm"><input type="checkbox" class="profile-confirm-results" /> I reviewed this many relevant linked pages</label>
          <label>Matching public profile URL<input type="url" class="profile-source-url" placeholder="https://…" /></label>
          <label class="profile-details-label">Public professional details / expertise<textarea class="profile-details" maxlength="3000" placeholder="Short quote or faithful summary from the matching profile page"></textarea></label>
          <label>Review note (optional)<input class="profile-review-note-input" maxlength="800" placeholder="Why the match is uncertain, or what you checked" /></label>
          <label class="profile-identity-confirm"><input type="checkbox" class="profile-confirm-identity" /> I confirmed this source page belongs to this named therapist</label>
          <div class="profile-enrichment-actions"><button type="button" class="primary-button" data-profile-action="save">Save verified profile details</button><button type="button" class="secondary-button" data-profile-action="ambiguous">Mark ambiguous</button><button type="button" class="secondary-button" data-profile-action="no-match">Mark no match</button></div>
        </div>
      </details>`;
    }).join('')}</div>`;
  }
  function renderRows(data) {
    renderStats(data);
    const start = data.total ? data.offset + 1 : 0;
    const end = Math.min(data.offset + data.rows.length, data.filteredTotal);
    $('therapistPageLabel').textContent = `${start}–${end} of ${data.filteredTotal.toLocaleString()}`;
    $('therapistPrev').disabled = data.offset <= 0;
    $('therapistNext').disabled = data.offset + data.limit >= data.filteredTotal;
    if (data.activeJob) {
      activeJobId = data.activeJob.id;
      showProgress(data.activeJob);
      setButtons(true);
      beginPolling();
    }
    if (!data.rows.length) {
      $('therapistRows').innerHTML = `<div class="empty-state"><h3>${data.total ? 'No leads on this page' : 'No leads in the queue'}</h3><p>${data.total ? 'Change page or refresh.' : 'Import a CSV to get started.'}</p></div>`;
      return;
    }
    $('therapistRows').innerHTML = data.rows.map(row => `<section class="research-row">
      <div class="research-row-head"><div><div class="research-lead-name">${esc(row.name || (row.website ? new URL(row.website).hostname : 'Unnamed lead'))}</div><div class="research-lead-meta">${esc([row.city, row.country].filter(Boolean).join(', ') || 'Location not supplied')} · ${safeUrl(row.website) ? `<a href="${esc(safeUrl(row.website))}" target="_blank" rel="noreferrer">${esc(row.website)}</a>` : 'No website supplied'}</div></div>${badge(row.status)}</div>
      ${row.lastError ? `<div class="research-error">${esc(row.lastError)}</div>` : ''}
      ${row.aboutSectionStatus ? `<div class="research-row-foot">About/bio pages: ${esc(row.aboutSectionStatus)} · ${Number(row.aboutPagesVisited?.length || 0)} visited${row.aboutPagesDiscovered ? ` · ${Number(row.aboutPagesDiscovered)} discovered` : ''}</div>` : ''}
      ${row.profileSearchStatus ? `<div class="research-row-foot">Playwright name search: ${esc(String(row.profileSearchStatus).replaceAll('_', ' '))}${row.profileSearchUrlsReviewed?.length ? ` · ${Number(row.profileSearchUrlsReviewed.length)} public result page(s) checked` : ''}${row.profileSearchError ? ` · ${esc(row.profileSearchError)}` : ''}</div>` : ''}
      ${row.professionalDescription ? `<blockquote class="candidate-evidence"><b>Professional description snippet (${esc(row.professionalDescriptionSource || 'website')}):</b> ${esc(row.professionalDescription)}${safeUrl(row.professionalDescriptionUrl) ? ` <a href="${esc(safeUrl(row.professionalDescriptionUrl))}" target="_blank" rel="noreferrer">Source page</a>` : ''}</blockquote>` : ''}
      ${row.practitionerNames?.length ? `<div class="practitioner-tags">${row.practitionerNames.map(person => `<span title="${esc(person.evidence)}">${esc(person.name)} · name suggestion</span>`).join('')}</div>` : ''}
      ${renderProfileEnrichment(row)}
      ${row.candidates?.length ? `<div class="candidate-list">${row.candidates.map(candidate => renderCandidate(row, candidate)).join('')}</div>` : (row.status === 'review' ? '<p class="muted no-candidate-note">Email candidates need review.</p>' : '')}
      <div class="research-row-foot">Source row ${Number(row.sourceRow) || '—'} · ${row.pagesVisited?.length || 0} pages checked · ${row.sourceFile ? esc(row.sourceFile) : 'imported CSV'}</div>
    </section>`).join('');
  }
  async function refreshQueue() {
    try {
      const triage = $('therapistTriage')?.value || '';
      const emailStyle = $('therapistStyle')?.value || '';
      const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize) });
      if (triage) params.set('triage', triage);
      if (emailStyle) params.set('emailStyle', emailStyle);
      const data = await api(`/api/therapist/rows?${params}`);
      renderRows(data);
      return data;
    } catch (error) { toast(error.message); }
  }
  function setButtons(busy) {
    $('therapistStart').disabled = busy;
    $('therapistProfileSearchSaved').disabled = busy;
    $('therapistPause').disabled = !busy;
    $('therapistStop').disabled = !busy;
  }
  function showProgress(job) {
    $('therapistProgress').classList.remove('hidden');
    $('therapistProgressText').textContent = job.progress?.message || 'Research in progress…';
    const pct = Number(job.progress?.pct || 0);
    $('therapistProgressPct').textContent = `${pct}%`;
    $('therapistProgressBar').style.width = `${pct}%`;
  }
  function beginPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!activeJobId) return;
      try {
        const job = await api(`/api/jobs/${encodeURIComponent(activeJobId)}`);
        showProgress(job);
        if (job.state !== 'running') {
          clearInterval(pollTimer); pollTimer = null; activeJobId = '';
          setButtons(false);
          const refreshed = await refreshQueue();
          if (job.state === 'complete' && refreshed?.learning?.nextSettings) {
            const settings = refreshed.learning.nextSettings;
            $('therapistPages').value = settings.pagesPerSite || 12;
            $('therapistConcurrency').value = settings.concurrency || 2;
            $('therapistDelay').value = settings.delaySeconds || 1;
          }
          const lesson = job.learningSummary?.lessons?.[0];
          const handoff = job.learningSummary?.professionalDescription?.emailSenderHandoff;
          toast(job.state === 'complete'
            ? job.kind === 'therapist-profile-enrichment'
              ? `Profile search complete. Updated context on ${job.resultCount || 0} existing rows; email statuses were not changed.`
              : `Run saved. ${handoff?.recordCount || 0} contact record(s) prepared for Email sender.${lesson ? ` Next-run adjustment: ${lesson}` : ''}`
            : job.error || 'Research stopped. Completed rows are saved.');
        }
      } catch (error) { clearInterval(pollTimer); pollTimer = null; setButtons(false); toast(error.message); }
    }, 900);
  }
  async function startResearch() {
    if (!$('therapistConsent').checked) { toast('Confirm the public-business research guardrail before starting.'); $('therapistConsent').focus(); return; }
    try {
      const job = await api('/api/therapist/start', { pagesPerSite: $('therapistPages').value, concurrency: $('therapistConcurrency').value, delaySeconds: $('therapistDelay').value, timeoutSeconds: 15, retryFailures: $('therapistRetryFailures').checked, deepenExisting: $('therapistDeepenExisting').checked, profileSearchFallback: $('therapistProfileSearchFallback').checked, useSharedQueue: $('therapistUseSharedQueue').checked, consent: true });
      activeJobId = job.id; showProgress(job); setButtons(true); beginPolling();
    } catch (error) { toast(error.message); }
  }
  async function searchSavedGenericProfiles() {
    if (!$('therapistConsent').checked) { toast('Confirm the public-business research guardrail before starting.'); $('therapistConsent').focus(); return; }
    try {
      const job = await api('/api/therapist/profile-enrichment/start', { consent: true, concurrency: $('therapistConcurrency').value, delaySeconds: $('therapistDelay').value });
      if (!job.id) { toast(job.message || 'No saved rows need profile lookup.'); return; }
      activeJobId = job.id; showProgress(job); setButtons(true); beginPolling();
    } catch (error) { toast(error.message); }
  }
  async function control(action) {
    if (!activeJobId) return;
    try { const result = await api(`/api/jobs/${encodeURIComponent(activeJobId)}/${action}`, {}); showProgress(result); }
    catch (error) { toast(error.message); }
  }
  async function importCsv() {
    if (!importRows.length) return;
    $('therapistImportButton').disabled = true;
    let added = 0; let skipped = 0;
    try {
      for (let offset = 0; offset < importRows.length; offset += 100) {
        const chunk = importRows.slice(offset, offset + 100).map(row => { const { _row, ...item } = row; return item; });
        const result = await api('/api/therapist/import', { rows: chunk, sourceFile, rowOffset: importRows[offset]._row || offset + 2 });
        added += result.added; skipped += result.skipped;
        $('therapistImportPreview').textContent = `Queueing… ${Math.min(offset + chunk.length, importRows.length)} / ${importRows.length}`;
      }
      toast(`Added ${added.toLocaleString()} new rows; skipped ${skipped.toLocaleString()} duplicates or invalid URLs.`);
      importRows = []; $('therapistCsv').value = ''; $('therapistImportPreview').classList.add('hidden'); $('therapistFileName').textContent = 'No file selected';
      offset = 0; await refreshQueue();
    } catch (error) { toast(error.message); }
    finally { $('therapistImportButton').disabled = !importRows.length; }
  }

  async function refreshSharedStatus() {
    try {
      const status = await api('/api/shared/status');
      $('sharedQueueStatus').textContent = status.connected
        ? `${status.email} · ${status.counts.pending} waiting · ${status.counts.leased} active · ${status.counts.complete} complete`
        : status.configured ? 'Project saved · sign in to connect' : 'Not configured';
      $('therapistUseSharedQueue').disabled = !status.connected;
      $('sharedDisconnect').disabled = !status.connected;
      $('sharedSyncLocal').disabled = !status.connected;
      $('sharedPullResults').disabled = !status.connected;
      return status;
    } catch (error) { $('sharedQueueStatus').textContent = error.message; return null; }
  }
  async function sharedAction(buttonId, endpoint, successText) {
    const button = $(buttonId); button.disabled = true;
    try {
      const data = await api(endpoint, {});
      await refreshSharedStatus();
      await refreshQueue();
      toast(typeof successText === 'function' ? successText(data) : successText);
    } catch (error) { toast(error.message); }
    finally { await refreshSharedStatus(); }
  }

  $('sharedSaveConfig').addEventListener('click', async () => {
    try {
      const status = await api('/api/shared/config', { url: $('sharedSupabaseUrl').value, anonKey: $('sharedSupabaseAnonKey').value });
      $('sharedSupabaseAnonKey').value = '';
      toast('Supabase project settings saved on this computer.');
      await refreshSharedStatus();
    } catch (error) { toast(error.message); }
  });
  $('sharedConnect').addEventListener('click', async () => {
    const button = $('sharedConnect'); button.disabled = true;
    try {
      const status = await api('/api/shared/login', { email: $('sharedSupabaseEmail').value, password: $('sharedSupabasePassword').value });
      $('sharedSupabasePassword').value = '';
      $('therapistUseSharedQueue').checked = true;
      await refreshSharedStatus();
      toast(`Connected as ${status.email}.`);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  $('sharedDisconnect').addEventListener('click', async () => {
    try { await api('/api/shared/logout', {}); $('therapistUseSharedQueue').checked = false; await refreshSharedStatus(); toast('Signed out of the shared queue on this computer.'); }
    catch (error) { toast(error.message); }
  });
  $('sharedSyncLocal').addEventListener('click', () => sharedAction('sharedSyncLocal', '/api/shared/sync-local', data => `Uploaded ${data.attempted.toLocaleString()} local source rows for de-duplicated shared queue sync.`));
  $('sharedPullResults').addEventListener('click', () => sharedAction('sharedPullResults', '/api/shared/pull-results', data => `Downloaded ${data.synced.toLocaleString()} completed row result(s) into this PC's local research file.`));

  $('therapistCsv').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    sourceFile = file.name; $('therapistFileName').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    try {
      const text = await file.text();
      importRows = parseCsv(text);
      $('therapistImportPreview').classList.remove('hidden');
      $('therapistImportPreview').innerHTML = `<b>${importRows.length.toLocaleString()}</b> rows contain a website URL. Preview: ${importRows.slice(0, 3).map(row => esc(`${row.name || 'Unnamed'} — ${row.city || 'no city'} — ${row.website}`)).join(' · ')}`;
      $('therapistImportButton').disabled = false;
    } catch (error) { importRows = []; $('therapistImportButton').disabled = true; $('therapistImportPreview').classList.remove('hidden'); $('therapistImportPreview').textContent = error.message; }
  });
  $('therapistImportButton').addEventListener('click', importCsv);
  $('therapistStart').addEventListener('click', startResearch);
  $('therapistProfileSearchSaved').addEventListener('click', searchSavedGenericProfiles);
  $('therapistPause').addEventListener('click', () => control('pause'));
  $('therapistStop').addEventListener('click', () => control('stop'));
  $('therapistRefresh').addEventListener('click', refreshQueue);
  $('therapistTriage').addEventListener('change', () => { offset = 0; refreshQueue(); });
  $('therapistStyle').addEventListener('change', () => { offset = 0; refreshQueue(); });
  $('therapistTriageExport').addEventListener('click', () => { window.location.href = '/api/therapist/candidates-export'; });
  $('therapistCoverageRefresh').addEventListener('click', refreshQueue);
  $('therapistPrev').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); refreshQueue(); });
  $('therapistNext').addEventListener('click', () => { offset += pageSize; refreshQueue(); });
  refreshSharedStatus();
  $('therapistExport').addEventListener('click', () => { window.location.href = '/api/therapist/export'; });
  $('therapistRows').addEventListener('click', async event => {
    const profileButton = event.target.closest('[data-profile-action]');
    if (profileButton) {
      const card = profileButton.closest('.profile-enrichment');
      const action = profileButton.dataset.profileAction;
      if (!card) return;
      if (action === 'search') {
        const name = card.dataset.profileName || '';
        const city = card.dataset.profileCity || '';
        const searchUrl = safeUrl(card.dataset.profileSite);
        if (!searchUrl) { toast('No saved practice website is available for this therapist.'); return; }
        window.open(searchUrl, '_blank', 'noopener,noreferrer');
        card.querySelector('.profile-enrichment-form')?.classList.remove('hidden');
        toast('Review the practice website and its linked clinician pages, then save the exact public profile evidence.');
        return;
      }
      profileButton.disabled = true;
      try {
        const form = card.querySelector('.profile-enrichment-form');
        const identityStatus = action === 'save' ? 'confirmed_public_profile' : action === 'ambiguous' ? 'ambiguous_unresolved' : action === 'no-match' ? 'no_match' : '';
        if (!form.querySelector('.profile-confirm-results').checked) throw new Error('Confirm that you reviewed the selected number of linked practice/profile pages.');
        if (identityStatus === 'confirmed_public_profile' && !form.querySelector('.profile-confirm-identity').checked) throw new Error('Confirm the matching therapist on the public profile page before saving.');
        if (identityStatus === 'confirmed_public_profile' && !form.querySelector('.profile-source-url').value.trim()) throw new Error('Add the exact public profile URL used as evidence.');
        if (identityStatus === 'confirmed_public_profile' && !form.querySelector('.profile-details').value.trim()) throw new Error('Add a short public details or expertise snippet.');
        await api('/api/therapist/profile-enrichment', {
          rowId: card.dataset.profileRow,
          practitionerName: card.dataset.profileName,
          identityStatus,
          searchResultsReviewed: Number(form.querySelector('.profile-results-reviewed').value),
          confirmedResultsReviewed: form.querySelector('.profile-confirm-results').checked,
          sourceUrl: form.querySelector('.profile-source-url').value.trim(),
          publicDetails: form.querySelector('.profile-details').value.trim(),
          reviewNote: form.querySelector('.profile-review-note-input').value.trim()
        });
        await refreshQueue();
        toast(identityStatus === 'confirmed_public_profile' ? 'Profile details saved to the existing therapist row.' : 'Unresolved profile result saved to the existing therapist row.');
      } catch (error) { profileButton.disabled = false; toast(error.message); }
      return;
    }
    const button = event.target.closest('[data-review]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await api('/api/therapist/review', { rowId: button.dataset.row, email: button.dataset.email, disposition: button.dataset.review });
      await refreshQueue(); toast('Review decision saved locally.');
    } catch (error) { button.disabled = false; toast(error.message); }
  });
  window.refreshTherapistQueue = refreshQueue;
  refreshQueue();
})();
