import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { classifyEmailStyle, enrichCandidateTriage } from './email-triage.mjs';
import { CORE_RULES, POLICY_VERSION, retrieveRules, sourceRowId, terminalCoverage } from './therapist-rag.mjs';
import { evaluateTherapistContact, mergeIdentityEvidencePackets, normalizeIdentityName } from './therapist-identity-rag.mjs';
import { SharedLeadQueue } from './shared-queue.mjs';
import { llmStatus, draftEmail } from './llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = process.env.LEADKING_EXPORT_DIR || path.join(HERE, 'exports');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const PORT = Number(process.env.LEADKING_PORT || 4173);
const HOST = process.env.LEADKING_HOST || '127.0.0.1';
const DATA_DIR = process.env.LEADKING_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'LeadKingReplica');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const AUDIT_FILE = path.join(DATA_DIR, 'usage.jsonl');
const THERAPIST_FILE = path.join(DATA_DIR, 'therapist-research.jsonl');
const THERAPIST_LEARNING_FILE = path.join(DATA_DIR, 'therapist-learning.json');
const THERAPIST_RAG_FILE = path.join(DATA_DIR, 'therapist-rag-memory.json');
const MAX_BODY = 1024 * 1024;
const MAX_RESULTS = 50;
const MAX_PAGES_PER_SITE = 5;
const REQUEST_TIMEOUT_MS = 12000;
const EXPECTED_THERAPIST_CITIES = ['New York City', 'Los Angeles', 'Brooklyn', 'Chicago', 'Queens', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'Manhattan', 'San Diego', 'The Bronx', 'Dallas', 'Jacksonville', 'Fort Worth', 'San Jose', 'Glasgow', 'Manchester', 'Sheffield', 'Leeds', 'Toronto', 'Montréal', 'Calgary', 'Sydney'];
const OSM_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';
const GOOGLE_HOME = 'https://www.google.com/maps/search/';

const jobs = new Map();
const therapistRows = new Map();
const sharedLeadQueue = new SharedLeadQueue();
let therapistLearning = { runs: [], nextSettings: { concurrency: 2, delaySeconds: 1, pagesPerSite: 12 }, guardrails: 'fixed' };
let therapistRagMemory = { policyVersion: POLICY_VERSION, coreRules: CORE_RULES, lessons: [], importedBatches: [] };
let state = { runs: [], leads: [], settings: {} };
let lastOverpassAt = 0;
let lastPhotonAt = 0;
let lastGoogleMapsAt = 0;
let mapsBrowser = null;
let mapsContext = null;
let mapsPage = null;
const geoCache = new Map();
const robotsCache = new Map();
const hostLastRequest = new Map();
let therapistBrowser = null;

async function loadTherapistResearch() {
  const migratedRows = new Set();
  try {
    const contents = await fs.readFile(THERAPIST_FILE, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.row?.id) {
          for (const candidate of event.row.candidates || []) if (downgradeInvalidAutoApproval(candidate, event.row)) migratedRows.add(event.row.id);
          therapistRows.set(event.row.id, event.row);
        }
      } catch { /* tolerate a truncated final journal line */ }
    }
  } catch { /* first run */ }
  for (const id of migratedRows) await saveTherapistRow(therapistRows.get(id));
}
async function loadTherapistLearning() {
  try {
    const saved = JSON.parse(await fs.readFile(THERAPIST_LEARNING_FILE, 'utf8'));
    therapistLearning = { ...therapistLearning, ...saved };
  } catch { /* first run */ }
}
async function loadTherapistRagMemory() {
  try {
    const saved = JSON.parse(await fs.readFile(THERAPIST_RAG_FILE, 'utf8'));
    therapistRagMemory = { ...therapistRagMemory, ...saved, coreRules: CORE_RULES, policyVersion: POLICY_VERSION };
  } catch { /* initialize the durable memory from the current policy */ }
  await saveTherapistRagMemory();
}
async function saveTherapistRagMemory() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${THERAPIST_RAG_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(therapistRagMemory, null, 2), 'utf8');
  await fs.rename(temp, THERAPIST_RAG_FILE);
}
function therapistRagContext(query) {
  const core = retrieveRules(query, 8);
  const tokens = new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2));
  const lessons = (therapistRagMemory.lessons || []).map(lesson => {
    const text = `${lesson.rule || ''} ${lesson.lesson || ''}`;
    const score = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(token => tokens.has(token)).length;
    return { ...lesson, score };
  }).filter(lesson => lesson.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  return { policyVersion: POLICY_VERSION, retrievedAt: new Date().toISOString(), coreRules: core, priorLessons: lessons };
}
function summarizeIdentityRag(decision) {
  return {
    ok: Boolean(decision?.ok), status: decision?.status || 'needs_review',
    version: decision?.version || 'identity-rag', reasons: decision?.reasons || [],
    attributedNames: decision?.attributedNames || [],
    retrievedEvidenceCount: Number(decision?.retrievedEvidenceCount || 0)
  };
}
async function saveTherapistLearning() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${THERAPIST_LEARNING_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(therapistLearning, null, 2), 'utf8');
  await fs.rename(temp, THERAPIST_LEARNING_FILE);
}
async function writeEmailSenderHandoff(rows, runId) {
  const { contacts, conflicts } = dedupeApprovedContactPackets(rows.flatMap(row => (row.candidates || []).map(candidate => ({ row, candidate }))));
  const records = contacts.map(({ row, candidate, sourceRows, manualProfile, identity }) => {
    const contextExcerpt = identity.acceptedEvidence.contextExcerpt;
    const contextUrl = identity.acceptedEvidence.contextUrl;
    const emailKey = String(candidate.email || '').trim().toLowerCase();
    return {
      practitionerName: candidate.practitionerName,
      email: emailKey,
      publicContextExcerpt: contextExcerpt,
      contextEvidenceUrl: contextUrl,
      practitionerProfileUrl: manualProfile?.sourceUrl || candidate.practitionerProfileUrl || '',
      location: [row.address, row.city, row.country].filter(Boolean).join(', '),
      website: row.website || '',
      emailEvidenceExcerpt: identity.acceptedEvidence.emailExcerpt,
      emailEvidenceUrl: identity.acceptedEvidence.emailUrl,
      verificationStatus: candidate.soloEvidence || candidate.verification?.soloStatusEvidence ? 'approved_personal_direct_with_solo_evidence' : 'approved_personal_direct',
      soloPracticeEvidenceExcerpt: candidate.verification?.soloStatusEvidence || '',
      soloPracticeEvidenceUrl: candidate.verification?.soloEvidenceUrl || '',
      sourceRows,
      identityReview: { version: identity.version, status: identity.status, reasons: identity.reasons, retrievedEvidenceCount: identity.retrievedEvidenceCount }
    };
  });
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const fields = ['Practitioner name','Email','Public context/history excerpt','Context evidence URL','Practitioner profile URL','Location','Website','Email evidence excerpt','Email evidence URL','Verification status','Solo-practice evidence excerpt','Solo-practice evidence URL','Source rows','Identity RAG version','Identity review status'];
  const csv = [fields.map(quote).join(','), ...records.map(item => [item.practitionerName, item.email, item.publicContextExcerpt, item.contextEvidenceUrl, item.practitionerProfileUrl, item.location, item.website, item.emailEvidenceExcerpt, item.emailEvidenceUrl, item.verificationStatus, item.soloPracticeEvidenceExcerpt, item.soloPracticeEvidenceUrl, JSON.stringify(item.sourceRows), item.identityReview.version, item.identityReview.status].map(quote).join(','))].join('\r\n');
  const payload = { runId, createdAt: new Date().toISOString(), policyVersion: POLICY_VERSION, appRowCount: rows.length, rowCount: rows.length, recordCount: records.length, identityConflictCount: conflicts.length, identityConflicts: conflicts, instruction: 'Records have a person-specific bio and exact public email supported by an atomic evidence packet; conflicting identities for one email are omitted and listed for review. Solo-practice proof is optional and labeled separately. Generic/shared role inboxes are excluded. This is a data handoff, not authorization to schedule or send outreach.', records };
  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(EXPORT_DIR, 'latest-email-sender-handoff.json'), JSON.stringify(payload, null, 2), 'utf8'),
    fs.writeFile(path.join(EXPORT_DIR, 'latest-email-sender-handoff.csv'), `\uFEFF${csv}`, 'utf8'),
    fs.writeFile(path.join(EXPORT_DIR, `email-sender-handoff-${runId}.json`), JSON.stringify(payload, null, 2), 'utf8')
  ]);
  return { recordCount: records.length, csvPath: path.join(EXPORT_DIR, 'latest-email-sender-handoff.csv'), jsonPath: path.join(EXPORT_DIR, 'latest-email-sender-handoff.json') };
}
async function finalizeTherapistRun(job, rows) {
  if (job.learningFinalized) return job.learningSummary;
  const runRows = rows.filter(row => row.lastRunId === job.id);
  const statusCount = status => runRows.filter(row => row.status === status).length;
  const candidates = runRows.flatMap(row => row.candidates || []);
  const allRows = [...therapistRows.values()];
  for (const row of allRows) {
    let changed = false;
    for (const candidate of row.candidates || []) {
      if (isApprovedPersonalDirect(candidate, row) || candidate.inboxType === 'shared_or_role_inbox'
        || ['excluded','excluded_suggested','unresolved'].includes(candidate.disposition)) continue;
      candidate.disposition = 'unresolved';
      candidate.verificationAssessment = {
        status: 'unresolved_after_harvest',
        reasons: [...new Set([...(candidate.verificationAssessment?.reasons || []), 'no_qualifying_evidence_after_harvest'])]
      };
      changed = true;
    }
    if (changed) await saveTherapistRow(row);
  }
    const emailSenderHandoff = await writeEmailSenderHandoff([...therapistRows.values()], job.id);
  const presentCities = new Set(allRows.map(row => canonicalTherapistCity(row.city)));
  const missingCities = EXPECTED_THERAPIST_CITIES.filter(city => !presentCities.has(city));
  const allCandidateRecords = allRows.flatMap(row => (row.candidates || []).map(candidate => ({ rowId: row.id, candidate })));
  const duplicateCount = items => {
    const counts = new Map();
    for (const candidate of items) counts.set(candidate.email, (counts.get(candidate.email) || 0) + 1);
    return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  };
  const duplicateCandidateRecords = duplicateCount(candidates);
  const cumulativeDuplicateCandidateRecords = duplicateCount(allCandidateRecords.map(item => item.candidate));
  const verifiedCandidates = candidates.filter(isApprovedPersonalDirect);
  const unresolvedCandidates = candidates.filter(candidate => candidate.disposition === 'unresolved');
  const evidenceGaps = candidates.filter(candidate => !candidate.evidenceUrl || !candidate.emailEvidence || !candidate.practitionerName).length;
  const aboutVisited = runRows.filter(row => row.aboutSectionStatus === 'visited').length;
  const aboutNotReached = runRows.filter(row => row.aboutSectionStatus === 'not_reached').length;
  const aboutNotFound = runRows.filter(row => row.aboutSectionStatus === 'not_found').length;
  const descriptionRows = runRows.filter(row => Boolean(row.professionalDescription || row.candidates?.some(candidate => candidate.professionalDescription))).length;
  const capHits = runRows.filter(row => row.pageLimitReached).length;
  const settings = job.runConfig || { concurrency: 2, delaySeconds: 1, pagesPerSite: 12 };
  const hardExceptions = statusCount('blocked') + statusCount('failed') + runRows.filter(row => row.status === 'partial' && !row.pageLimitReached).length;
  const exceptionRate = runRows.length ? hardExceptions / runRows.length : 0;
  const next = { ...settings };
  const lessons = [];
  if (statusCount('blocked')) lessons.push(`${statusCount('blocked')} site(s) blocked or disallowed; do not retry around restrictions.`);
  if (statusCount('partial')) lessons.push(`${statusCount('partial')} site(s) had incomplete page coverage; keep them visible as exceptions.`);
  if (capHits) lessons.push(`${capHits} site(s) reached the page limit; deeper crawl may improve coverage, within the 20-page ceiling.`);
  if (!candidates.length) lessons.push('No email candidates were found; keep the exact-evidence review filter unchanged and prioritize contact/team pages on the next run.');
  if (missingCities.length) lessons.push(`${missingCities.length} expected cities have no imported leads yet: ${missingCities.join(', ')}.`);
  if (duplicateCandidateRecords) lessons.push(`${duplicateCandidateRecords} repeated candidate record(s) are present across rows; sender export deduplicates exact addresses.`);
  if (evidenceGaps) lessons.push(`${evidenceGaps} candidate record(s) lack a name, exact URL, or evidence excerpt and cannot be approved.`);
  if (aboutNotReached) lessons.push(`${aboutNotReached} site(s) had an About/bio page discovered but not reached; keep them open for a deeper review when the page cap permits.`);
  if (aboutNotFound) lessons.push(`${aboutNotFound} site(s) had no About/bio page found; solo status remains unverified until suitable evidence is located.`);
  if (runRows.length && descriptionRows < runRows.length) lessons.push(`${runRows.length - descriptionRows} site(s) had no usable professional-description snippet; retain them as missing-context exceptions rather than inventing a summary.`);
  if (exceptionRate >= 0.08) {
    next.concurrency = Math.max(1, Number(settings.concurrency) - 1);
    next.delaySeconds = Math.min(60, Math.max(2, Number(settings.delaySeconds) + 1));
    lessons.push('Reduced concurrency and increased delay to lower site load after a high exception rate.');
  } else if (capHits && Number(settings.pagesPerSite) < 20) {
    next.pagesPerSite = Math.min(20, Number(settings.pagesPerSite) + 2);
    lessons.push('Raised page depth by two because sites hit the previous limit; hard cap remains 20 pages per site.');
  } else if (exceptionRate < 0.02 && Number(settings.concurrency) < 6) {
    next.concurrency = Math.min(6, Number(settings.concurrency) + 1);
    lessons.push('Raised concurrency by one after a clean run; hard cap remains six sites at once.');
  }
  next.delaySeconds = Math.max(1, Number(next.delaySeconds) || 1);
  next.pagesPerSite = Math.max(1, Math.min(20, Number(next.pagesPerSite) || 12));
  next.concurrency = Math.max(1, Math.min(6, Number(next.concurrency) || 2));
  const pages = runRows.reduce((sum, row) => sum + (row.pagesVisited?.length || 0), 0);
  const summary = {
    id: job.id, completedAt: new Date().toISOString(), durationSeconds: Math.max(1, Math.round((Date.now() - job.startedAt) / 1000)),
    rows: runRows.length, pagesVisited: pages, averagePagesPerRow: runRows.length ? Number((pages / runRows.length).toFixed(1)) : 0,
    rowsPerMinute: Number((runRows.length / Math.max(1, (Date.now() - job.startedAt) / 60000)).toFixed(1)),
    statuses: Object.fromEntries(['review','complete_no_email','partial','blocked','failed','no_website'].map(status => [status, statusCount(status)])),
    candidateCount: candidates.length, uniqueCandidates: new Set(candidates.map(item => item.email)).size,
    approvedPersonalDirectEmails: new Set(verifiedCandidates.map(item => item.email)).size,
    optionalSoloEvidenceEmails: new Set(verifiedCandidates.filter(item => item.soloEvidence || item.verification?.soloStatusEvidence).map(item => item.email)).size,
    unresolvedEvidence: new Set(unresolvedCandidates.map(item => item.email)).size,
    candidateYieldRate: Number((runRows.length ? new Set(candidates.map(item => item.email)).size / runRows.length : 0).toFixed(3)),
    roleOrSharedCandidates: candidates.filter(item => item.inboxType === 'shared_or_role_inbox').length,
    aboutSection: { visited: aboutVisited, notReached: aboutNotReached, notFound: aboutNotFound },
    professionalDescription: {
      rowsWithSnippet: descriptionRows,
      rowsMissingSnippet: Math.max(0, runRows.length - descriptionRows),
      emailSenderHandoff
    },
    pagesLimitHits: capHits, exceptionRate: Number(exceptionRate.toFixed(3)), settings, nextSettings: next,
    missingExpectedCities: missingCities, duplicateCandidateRecords, cumulativeDuplicateCandidateRecords, candidateEvidenceGaps: evidenceGaps,
    remainingHumanReview: candidates.filter(candidate => candidate.disposition === 'needs_review').length,
    automaticallyUnqualifiedUnique: new Set(unresolvedCandidates.map(candidate => candidate.email)).size,
    rowsStillPartial: runRows.filter(row => row.status === 'partial').length,
    rowsBlockedOrFailed: runRows.filter(row => ['blocked','failed'].includes(row.status)).length,
    lessons, guardrailsUnchanged: true,
    coverage: terminalCoverage(allRows),
    rag: therapistRagContext('run completion approval evidence row count coverage duplicates sender personal direct solo bio'),
    policyVersion: POLICY_VERSION
  };
  therapistLearning.runs.unshift(summary);
  therapistLearning.runs = therapistLearning.runs.slice(0, 100);
  therapistLearning.nextSettings = next;
  therapistLearning.guardrails = 'fixed';
  await saveTherapistLearning();
  for (const lesson of lessons) therapistRagMemory.lessons.unshift({ runId: job.id, learnedAt: summary.completedAt, rule: 'Operational improvement only; never weaken evidence policy.', lesson });
  therapistRagMemory.lessons = therapistRagMemory.lessons.slice(0, 300);
  await saveTherapistRagMemory();
  job.learningSummary = summary;
  job.learningFinalized = true;
  return summary;
}
async function saveTherapistRow(row) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(THERAPIST_FILE, `${JSON.stringify({ at: new Date().toISOString(), row })}\n`, 'utf8');
  therapistRows.set(row.id, row);
}
const NON_PERSON_NAME_TERMS = new Set(['about','adults','alliance','anger','appointment','appointments','anxiety','approach','areas','available','availability','behavior','behavioral','bio','blog','book','booking','center','centre','clients','clinic','clinical','coaching','contact','consult','consultation','counseling','counselling','counselor','counsellor','counselors','counsellors','couples','depression','directory','eft','esteem','expertise','faq','family','find','functioning','geriatric','group','health','healing','help','high','home','individual','institute','journey','links','location','locations','low','meet','mental','misuse','mood','neuropsychological','now','nyc','office','our','out','practice','psychological','psychologist','psychology','psychotherapist','psychotherapy','psychiatry','quick','reach','relationships','say','self','sessions','services','specialties','specialty','start','staff','substance','support','team','the','therapy','therapist','therapists','virtual','what','wellness','women','youth']);
function isExplicitIndependentPracticeStatement(value) {
  return /\b(?:my\s+(?:own|private|independent|solo)\s+(?:(?:therapy|psychotherapy|counselling|counseling|clinical)\s+)?practice|I\s+(?:run|operate|own|founded|maintain)\s+(?:my|an?)\s+(?:own\s+)?(?:private|independent|solo)\s+(?:(?:therapy|psychotherapy|counselling|counseling|clinical)\s+)?practice|I\s+(?:am|work as)\s+(?:a|an)\s+(?:independent|solo|self-employed)\s+(?:therapist|psychotherapist|counsell?or|psychologist|clinician|practitioner)|I\s+practice\s+independently|(?:solo|independent)\s+practitioner|(?:is|works as|practices as)\s+(?:a|an)\s+private[- ]practice\s+(?:therapist|psychotherapist|counsell?or|psychologist|clinician|practitioner))\b/i.test(String(value || ''));
}
function isFirstPersonSinglePracticeStatement(value) {
  return /\bmy\s+(?:[\w-]+\s+){0,4}(?:(?:therapy|psychotherapy|counselling|counseling|clinical)\s+)?practice\b/i.test(String(value || ''));
}
function isQualifyingSoloEvidence(value, basis) {
  if (basis === 'explicit_independent_practice_statement') return isExplicitIndependentPracticeStatement(value);
  if (basis === 'first_person_practice_single_clinician_site') return isFirstPersonSinglePracticeStatement(value);
  return false;
}
function isPlausiblePractitionerName(value) {
  const name = therapistSearchNameCore(value);
  const tokens = name.match(/[\p{L}][\p{L}’'-]*/gu) || [];
  const blocked = tokens.some(token => NON_PERSON_NAME_TERMS.has(token.toLowerCase().replace(/[^a-z]/g, '')));
  if (tokens.length === 1) return tokens[0].length >= 3 && !blocked
    && !/^(?:basic|certified|training|licensed|registered|the|our|meet|welcome|eft)$/i.test(tokens[0]);
  return tokens.length >= 2 && tokens.length <= 5
    && tokens.filter(token => token.length > 1).length >= 1
    && !blocked
    && !/^(?:basic|certified|training|licensed|registered|the|our|meet|welcome|eft)$/i.test(tokens[0]);
}
function therapistSearchNameCore(value) {
  return String(value || '').normalize('NFKC').replace(/\([^)]*\)/g, ' ')
    .replace(/^(?:Dr\.?|Prof\.?|Mr\.?|Mrs\.?|Ms\.?)\s+/i, '')
    .split(/[|,]/, 1)[0].replace(/\s+/g, ' ').trim();
}
function normalizeTherapistPersonName(value) {
  return String(value || '').normalize('NFKC').replace(/^Dr\.?\s+/i, '')
    .replace(/\b(?:LCSW|LMSW|LMHC|LMFT|LCPC|LPC|LSW|CSW|PhD|PsyD|MD|DSW|MSW|MFT)\b/gi, ' ')
    .replace(/[,.]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}
function downgradeInvalidAutoApproval(candidate, row = null) {
  if (!['approved_personal_direct', 'approved_solo'].includes(candidate?.disposition)) return false;
  const identity = evaluateTherapistContact(candidate, row);
  candidate.identityRagAssessment = summarizeIdentityRag(identity);
  if (identity.ok) return false;
  candidate.disposition = 'needs_review';
  candidate.soloEvidence = false;
  candidate.inboxType = 'direct_candidate';
  candidate.verificationAssessment = {
    status: identity.status,
    reasons: [...new Set([...(candidate.verificationAssessment?.reasons || []), ...identity.reasons])]
  };
  return true;
}
function isApprovedPersonalDirect(candidate, row = null) {
  if (!['approved_personal_direct', 'approved_solo'].includes(candidate?.disposition)
    || candidate?.inboxType === 'shared_or_role_inbox'
    || candidate?.identityConflict
    || !isPlausiblePractitionerName(candidate?.practitionerName)) return false;
  return evaluateTherapistContact(candidate, row).ok;
}

function dedupeApprovedContactPackets(items) {
  const byEmail = new Map();
  for (const item of items) {
    const email = String(item.candidate.email || '').trim().toLowerCase();
    if (!email) continue;
    const identity = evaluateTherapistContact(item.candidate, item.row);
    const group = byEmail.get(email) || { items: [], names: new Set(), claims: new Set(), claimRows: [] };
    if (isApprovedPersonalDirect(item.candidate, item.row)) {
      const name = normalizeIdentityName(item.candidate.practitionerName);
      group.items.push({ ...item, identity });
      group.names.add(name || '');
    }
    for (const name of identity.attributedNames || []) if (name) {
      group.claims.add(name);
      group.claimRows.push({ sourceFile: item.row.sourceFile || '', sourceRow: item.row.sourceRow || 0, sourceIdentity: item.row.sourceIdentity || item.row.id });
    }
    byEmail.set(email, group);
  }
  const contacts = [];
  const conflicts = [];
  for (const [email, group] of byEmail) {
    const allNames = new Set([...group.names, ...group.claims]);
    if (allNames.size > 1 || (group.items.length && (group.names.size !== 1 || group.names.has('')))) {
      const conflictRows = [...group.items.map(item => ({ sourceFile: item.row.sourceFile || '', sourceRow: item.row.sourceRow || 0, sourceIdentity: item.row.sourceIdentity || item.row.id })), ...group.claimRows];
      const sourceRows = [...new Map(conflictRows.map(source => [source.sourceIdentity, source])).values()];
      conflicts.push({ email, names: [...allNames].filter(Boolean), sourceRows });
      continue;
    }
    if (!group.items.length) continue;
    const sourceRows = group.items.flatMap(item => [{ sourceFile: item.row.sourceFile || '', sourceRow: item.row.sourceRow || 0, sourceIdentity: item.row.sourceIdentity || item.row.id, city: item.row.city || '', website: item.row.website || '' }]);
    const ranked = group.items.map(item => {
      const manualProfile = (item.row.profileEnrichments || []).find(profile => profile.identityStatus === 'confirmed_public_profile'
        && normalizeTherapistPersonName(profile.practitionerName) === normalizeTherapistPersonName(item.candidate.practitionerName));
      const evidence = item.identity.acceptedEvidence;
      return { ...item, manualProfile, identity: item.identity, score: String(evidence?.contextExcerpt || '').length + String(evidence?.emailExcerpt || '').length };
    }).sort((a, b) => b.score - a.score);
    contacts.push({ ...ranked[0], sourceRows });
  }
  return { contacts, conflicts };
}

async function appendAudit(entry) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

async function loadState() {
  try { state = { ...state, ...JSON.parse(await fs.readFile(DATA_FILE, 'utf8')) }; }
  catch { /* first start */ }
}
async function saveState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, DATA_FILE);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
function ipv6Private(ip) {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice(7);
    return net.isIP(embedded) === 4 ? ipv4Private(embedded) : true;
  }
  // Publicly routable IPv6 unicast is currently within 2000::/3.
  return !(normalized.startsWith('2') || normalized.startsWith('3')) ||
    normalized.startsWith('2001:db8:') || normalized === '::' || normalized === '::1';
}
function assertSafeHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Only public website addresses are allowed.');
  const ipType = net.isIP(host);
  if (ipType === 4 && ipv4Private(host)) throw new Error('Private network addresses are blocked.');
  if (ipType === 6 && ipv6Private(host)) throw new Error('Private network addresses are blocked.');
  return host;
}
async function resolvePublic(hostname) {
  assertSafeHost(hostname);
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  let addresses;
  try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error(`Could not resolve ${hostname}.`); }
  if (!addresses.length || addresses.some(entry => entry.family === 4 ? ipv4Private(entry.address) : ipv6Private(entry.address))) throw new Error('The host does not resolve only to public addresses.');
  return addresses;
}

function requestOnce(url, { method = 'GET', body, headers = {}, signal, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_BODY } = {}) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { reject(new Error('Invalid URL.')); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { reject(new Error('Only HTTP and HTTPS websites are allowed.')); return; }
    let addresses;
    try { addresses = await resolvePublic(parsed.hostname); } catch (error) { reject(error); return; }
    if (signal?.aborted) { reject(new Error('Stopped by user.')); return; }
    const address = addresses[0];
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, {
      method,
      headers: { 'User-Agent': `LeadKingReplica/1.0 (public business research; contact: ${state.settings?.email || 'local-user'})`, 'Accept': 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
      timeout: timeoutMs,
      maxHeaderSize: 16 * 1024,
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family)
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(new Error('Response exceeded the size limit.')); return; } chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), url: parsed.href }));
    });
    const abort = () => req.destroy(new Error('Stopped by user.'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.on('close', () => signal?.removeEventListener('abort', abort));
    if (body) req.write(body);
    req.end();
  });
}
async function requestText(url, options = {}, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects.');
  const result = await requestOnce(url, options);
  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
    const next = new URL(result.headers.location, url).href;
    return requestText(next, options, redirectCount + 1);
  }
  return result;
}
async function waitJob(job) {
  while (job.paused && !job.stopped) await sleep(200);
  if (job.stopped) throw new Error('Stopped by user.');
}
function progress(job, pct, stage, message) {
  job.progress = { pct, stage, message, updatedAt: Date.now() };
}
function update(job, pct, stage, message) { progress(job, pct, stage, message); }

async function geocodePhoton(query, job) {
  const key = query.trim().toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const wait = Math.max(0, 2500 - (Date.now() - lastPhotonAt));
  if (wait) await sleep(wait);
  await waitJob(job);
  lastPhotonAt = Date.now();
  const url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(query)}&limit=1&lang=en`;
  const response = await requestText(url, { headers: { Accept: 'application/json' }, signal: job.controller.signal });
  if (response.status !== 200) throw new Error(`Location lookup returned HTTP ${response.status}.`);
  let data;
  try { data = JSON.parse(response.body); } catch { throw new Error('Location lookup returned invalid JSON.'); }
  const feature = data.features?.[0];
  if (!feature?.geometry?.coordinates) throw new Error(`Could not find “${query}”. Try a city or district name.`);
  const [lon, lat] = feature.geometry.coordinates;
  const props = feature.properties || {};
  const result = { lat, lon, name: [props.name, props.city, props.state, props.country].filter(Boolean).join(', '), extent: props.extent };
  geoCache.set(key, result);
  return result;
}
function clausesFor(query) {
  const q = query.toLowerCase();
  if (/dent|dental|orthodont/.test(q)) return [['amenity', 'dentist']];
  if (/cafe|coffee|restaurant|food|bakery/.test(q)) return [['amenity', 'cafe|restaurant|fast_food'], ['shop', 'bakery']];
  if (/hotel|hostel|lodg/.test(q)) return [['tourism', 'hotel|guest_house|hostel']];
  if (/pharmacy|chemist/.test(q)) return [['amenity', 'pharmacy']];
  if (/gym|fitness/.test(q)) return [['leisure', 'fitness_centre|sports_centre']];
  if (/salon|hair|beauty/.test(q)) return [['shop', 'hairdresser|beauty']];
  if (/lawyer|attorney/.test(q)) return [['office', 'lawyer']];
  if (/real estate|realtor|property/.test(q)) return [['office', 'estate_agent']];
  if (/plumb/.test(q)) return [['craft', 'plumber']];
  if (/electric/.test(q)) return [['craft', 'electrician']];
  if (/doctor|clinic|medical/.test(q)) return [['amenity', 'doctors|clinic']];
  return [['amenity', 'cafe|restaurant|pharmacy|dentist|clinic|doctors'], ['shop', 'bakery|hairdresser|beauty'], ['office', 'lawyer|estate_agent']];
}
async function discoverOsm(query, place, job, maxResults) {
  const delay = Math.max(0, 5000 - (Date.now() - lastOverpassAt));
  if (delay) await sleep(delay);
  await waitJob(job);
  lastOverpassAt = Date.now();
  const radius = 3500;
  const clauses = clausesFor(query).map(([key, values]) => `  nwr(around:${radius},${place.lat},${place.lon})["${key}"~"^(${values})$"];`).join('\n');
  const overpassQuery = `[out:json][timeout:25];\n(\n${clauses}\n);\nout center tags ${Math.min(maxResults * 2, 100)};`;
  const response = await requestText(OSM_ENDPOINT, { method: 'POST', body: `data=${encodeURIComponent(overpassQuery)}`, headers: { Accept: 'application/json' }, signal: job.controller.signal, timeoutMs: 35000, maxBytes: 6 * 1024 * 1024 });
  if (response.status === 429) throw new Error('OpenStreetMap search is rate limited. Wait a few minutes before trying again.');
  if (response.status !== 200) throw new Error(`OpenStreetMap search returned HTTP ${response.status}.`);
  let data;
  try { data = JSON.parse(response.body); } catch { throw new Error('OpenStreetMap returned invalid data.'); }
  return (data.elements || []).map(element => {
    const tags = element.tags || {};
    const coords = element.center || element;
    const website = tags.website || tags['contact:website'] || '';
    const email = tags.email || tags['contact:email'] || '';
    const phone = tags.phone || tags['contact:phone'] || '';
    const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'] || tags['addr:town'], tags['addr:postcode']].filter(Boolean).join(' ');
    const category = tags.amenity || tags.shop || tags.office || tags.craft || tags.tourism || tags.leisure || 'Business';
    return { id: `osm-${element.type}-${element.id}`, name: tags.name || tags['name:en'] || '', category: category.replaceAll('_', ' '), website, email, phone, address, city: tags['addr:city'] || tags['addr:town'] || '', lat: coords.lat, lon: coords.lon, source: 'OpenStreetMap', source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`, emails: email ? [{ value: email.split(/[;,]/)[0].trim(), status: 'Public', label: 'Public listing', source_url: `https://www.openstreetmap.org/${element.type}/${element.id}` }] : [], phones: phone ? [{ value: phone.split(/[;,]/)[0].trim(), type: 'Business', source_url: `https://www.openstreetmap.org/${element.type}/${element.id}` }] : [], sources: ['OpenStreetMap'], socials: [], whatsapp: '', score: website ? 25 : 10, score_reasons: [website ? 'Business website listed in OpenStreetMap' : 'Business listed in OpenStreetMap'] };
  }).filter(item => item.name).slice(0, maxResults);
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function plainText(html) { return decodeHtml(html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function extractFromHtml(html, pageUrl, lead) {
  const emails = new Set(lead.emails.map(e => e.value.toLowerCase()));
  const phones = new Set(lead.phones.map(e => e.value));
  const socials = new Set(lead.socials || []);
  const addEmail = raw => { const value = decodeHtml(raw).replace(/^mailto:/i, '').split(/[?;,\s]/)[0].trim().toLowerCase(); if (/^[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+$/.test(value) && !/\.(png|jpe?g|gif|svg|webp)$/i.test(value)) emails.add(value); };
  const addPhone = raw => { const value = decodeHtml(raw).replace(/^tel:/i, '').split(/[;,?]/)[0].trim(); const digits = value.replace(/\D/g, ''); if (digits.length >= 7 && digits.length <= 18) phones.add(value); };
  for (const match of html.matchAll(/href\s*=\s*["']mailto:([^"']+)["']/gi)) addEmail(match[1]);
  for (const match of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) addPhone(match[1]);
  for (const match of html.matchAll(/(?<![\w.+-])[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+(?![\w.-])/g)) addEmail(match[0]);
  const text = plainText(html);
  for (const match of text.matchAll(/(?<!\w)(?:\+?\d[\d\s()./-]{6,}\d)(?!\w)/g)) addPhone(match[0]);
  for (const match of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    try { const u = new URL(decodeHtml(match[1]), pageUrl); if (['facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'x.com', 'twitter.com', 'tiktok.com'].some(d => u.hostname === d || u.hostname.endsWith(`.${d}`))) socials.add(u.href); } catch { }
  }
  lead.emails = [...emails].map(value => ({ value, status: 'Public', label: 'Found on public page', source_url: pageUrl }));
  lead.phones = [...phones].map(value => ({ value, type: 'Business', source_url: pageUrl }));
  lead.socials = [...socials].map(url => ({ value: url, source_url: pageUrl }));
  if (!lead.website) lead.website = new URL(pageUrl).origin;
}
function linkTargets(html, baseUrl) {
  const urls = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const url = new URL(decodeHtml(match[2]), baseUrl);
      if (url.origin !== new URL(baseUrl).origin || !['http:', 'https:'].includes(url.protocol)) continue;
      if (/contact|about|impressum|legal|team|staff|company|reach|location/i.test(url.pathname) && !urls.includes(url.href)) urls.push(url.href);
    } catch { }
  }
  return urls;
}
function robotsRules(text, userAgent) {
  const groups = []; let group = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const name = line.slice(0, i).trim().toLowerCase(); const value = line.slice(i + 1).trim();
    if (name === 'user-agent') {
      if (!group || group.hasDirectives) { group = { agents: [], rules: [], delay: 0, hasDirectives: false }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      group.hasDirectives = true;
      if (name === 'allow' || name === 'disallow') group.rules.push({ name, value });
      if (name === 'crawl-delay' && Number.isFinite(Number(value))) group.delay = Math.max(group.delay, Number(value));
    }
  }
  const matching = groups.filter(g => g.agents.some(a => a !== '*' && userAgent.toLowerCase().includes(a)));
  const selected = matching.length ? matching : groups.filter(g => g.agents.includes('*'));
  return { rules: selected.flatMap(g => g.rules), delay: Math.max(0, ...selected.map(g => g.delay)) };
}
async function getRobots(origin, job) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const response = await requestText(`${origin}/robots.txt`, { signal: job.controller.signal, timeoutMs: 8000, maxBytes: 128 * 1024 });
  // RFC-style: a missing robots file permits crawling; server errors are treated as a block.
  const result = response.status >= 500 ? { rules: [{ name: 'disallow', value: '/' }], delay: 2 } : robotsRules(response.status >= 400 ? '' : response.body, 'LeadKingReplica');
  robotsCache.set(origin, result);
  return result;
}
function allowedByRobots(url, rules) {
  const pathOnly = new URL(url).pathname + new URL(url).search;
  const matched = rules.rules.filter(rule => rule.value && pathOnly.startsWith(rule.value)).sort((a, b) => b.value.length - a.value.length)[0];
  return !matched || matched.name === 'allow';
}
async function delayHost(host, seconds, job) {
  const now = Date.now(); const last = hostLastRequest.get(host) || 0;
  const wait = Math.max(0, last + Math.max(1, seconds) * 1000 - now);
  if (wait) await sleep(wait);
  await waitJob(job); hostLastRequest.set(host, Date.now());
}
async function crawlWebsite(lead, job, pagesLimit, delaySeconds = 1, timeoutSeconds = 12) {
  if (!lead.website) return;
  let start;
  try { start = new URL(/^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`); } catch { return; }
  if (!['http:', 'https:'].includes(start.protocol)) return;
  const origin = start.origin;
  let rules;
  try { rules = await getRobots(origin, job); } catch { return; }
  const queue = [start.href]; const visited = new Set(); const pages = Math.max(1, Math.min(MAX_PAGES_PER_SITE, pagesLimit || 3));
  while (queue.length && visited.size < pages) {
    await waitJob(job);
    const url = queue.shift(); if (visited.has(url) || !allowedByRobots(url, rules)) continue;
    visited.add(url);
    try {
      await delayHost(start.hostname, Math.max(1, rules.delay, Number(delaySeconds) || 1), job);
      const response = await requestText(url, { signal: job.controller.signal, headers: { Accept: 'text/html,application/xhtml+xml' }, timeoutMs: Math.min(30, Math.max(5, Number(timeoutSeconds) || 12)) * 1000, maxBytes: 1024 * 1024 });
      if (new URL(response.url).origin !== origin) continue;
      if (response.status < 200 || response.status >= 300) continue;
      const type = String(response.headers['content-type'] || ''); if (!/html|xml/i.test(type)) continue;
      extractFromHtml(response.body, response.url, lead);
      if (visited.size < pages) for (const link of linkTargets(response.body, response.url)) if (!visited.has(link) && !queue.includes(link)) queue.push(link);
      lead.website_live = true;
      lead.sources = [...new Set([...(lead.sources || []), 'Business website'])];
    } catch (error) {
      if (/Stopped by user/.test(error.message)) throw error;
    }
  }
  lead.score = Math.min(100, (lead.score || 0) + (lead.emails.length ? 10 : 0) + (lead.phones.length ? 20 : 0) + (lead.website_live ? 15 : 0) + (lead.address ? 10 : 0) + ((lead.socials || []).length ? 5 : 0));
  lead.score_level = lead.score >= 70 ? 'High' : lead.score >= 40 ? 'Medium' : 'Low';
  lead.score_reasons = [lead.website_live ? 'Website responded successfully' : 'Website not crawled', ...(lead.emails.length ? ['Public email found'] : []), ...(lead.phones.length ? ['Public business phone'] : []), ...(lead.address ? ['Business address available'] : [])];
}

function looksBlocked(text, url) {
  return /unusual traffic|automated quer(?:y|ies)|not a robot|recaptcha|captcha|before you continue|consent\.google\.com/i.test(`${text}\n${url}`);
}
async function getPersistentMapsPage() {
  if (mapsBrowser?.isConnected() && mapsPage && !mapsPage.isClosed()) return { browser: mapsBrowser, context: mapsContext, page: mapsPage };
  mapsBrowser = null; mapsContext = null; mapsPage = null;
  try { mapsBrowser = await chromium.launch({ headless: false, channel: 'msedge' }); }
  catch { try { mapsBrowser = await chromium.launch({ headless: false }); } catch { throw new Error('No Playwright browser is installed. Run npx playwright install chromium.'); } }
  mapsContext = await mapsBrowser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1440, height: 900 } });
  mapsPage = await mapsContext.newPage();
  mapsPage.setDefaultNavigationTimeout(25000);
  return { browser: mapsBrowser, context: mapsContext, page: mapsPage };
}
async function scrapeGoogleMaps(query, location, job, gl = '') {
  if (!chromium) throw new Error('Google Maps search needs Playwright. Run npm install in the project root, then install its Chromium browser with npx playwright install chromium.');
  const cooldown = Math.max(0, 30000 - (Date.now() - lastGoogleMapsAt));
  if (cooldown) await sleep(cooldown);
  await waitJob(job);
  lastGoogleMapsAt = Date.now();
  const { browser, context, page } = await getPersistentMapsPage();
  try {
    const searchText = location && !query.toLowerCase().includes(location.toLowerCase()) ? `${query} in ${location}` : query;
    const params = new URLSearchParams({ hl: 'en' });
    if (/^[a-z]{2}$/i.test(gl)) params.set('gl', gl.toLowerCase());
    const url = `${GOOGLE_HOME}${encodeURIComponent(searchText)}?${params}`;
    progress(job, 32, 'Google Maps', 'Opening the requested Maps search…');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (response && response.status() === 429) throw new Error('Google Maps returned a rate limit. Stop and try again later.');
    const feed = page.locator('div[role="feed"]');
    await feed.waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);
    const text = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    if (looksBlocked(text, page.url())) throw new Error('Google Maps displayed a CAPTCHA, consent wall, or automated-traffic block. Search stopped; this app does not bypass those pages.');
    if (!await feed.count()) throw new Error('Google Maps did not show a results feed. It may be unavailable or require user consent.');
    const cardsByUrl = new Map(); let stableAtEnd = 0; let scrollPasses = 0; let stopReason = 'still-scrolling';
    await feed.hover();
    while (stableAtEnd < 10) {
      await waitJob(job);
      const before = cardsByUrl.size;
      const batch = await feed.locator('a.hfpxzc').evaluateAll(nodes => nodes.map(a => {
        const card = a.closest('[role="article"]') || a.parentElement?.parentElement;
        const websiteLink = card?.querySelector('a[data-item-id="authority"], a[aria-label*="Website" i], a[data-tooltip*="Website" i]');
        const website = websiteLink?.href || '';
        return { name: a.getAttribute('aria-label') || '', url: a.href, website };
      }));
      for (const card of batch) {
        const key = card.url || card.name.trim().toLowerCase();
        if (key && !cardsByUrl.has(key) && card.name.trim()) cardsByUrl.set(key, card);
      }
      const noNewListings = cardsByUrl.size === before;
      const reachedFeedEnd = await feed.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 8);
      if (noNewListings && reachedFeedEnd) stableAtEnd++; else stableAtEnd = 0;
      if (stableAtEnd >= 10) { stopReason = 'feed-bottom-stable'; break; }
      progress(job, 32, 'Google Maps', `Collected ${cardsByUrl.size} unique listings; checking for more in this area…`);
      const scrollDistance = await feed.evaluate(el => Math.max(550, Math.round(el.clientHeight * 0.85)));
      await page.mouse.wheel(0, scrollDistance);
      await page.waitForTimeout(500);
      scrollPasses++;
      if (scrollPasses % 4 === 0) {
        const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        if (looksBlocked(bodyText, page.url())) throw new Error('Google Maps started showing a block or CAPTCHA. Search stopped without trying to bypass it.');
        if (/you(?:'|’)ve reached the end|no more results|end of list/i.test(bodyText)) { stopReason = 'end-marker'; break; }
      }
    }
    const cards = [...cardsByUrl.values()];
    const out = []; const seen = new Set();
    for (const card of cards) {
      const name = card.name.trim(); const listingKey = card.url || name.toLowerCase(); if (!name || seen.has(listingKey)) continue;
      seen.add(listingKey);
      const website = (() => { try { const parsed = new URL(card.website); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''; } catch { return ''; } })();
      const businessUrl = (() => { try { return new URL(card.url).href; } catch { return url; } })();
      out.push({ id: `google-${out.length}-${Date.now()}`, name, website, source: 'Google Maps', source_url: businessUrl });
    }
    progress(job, 42, 'Google Maps', `Collected ${out.length} company names and visible website links.`);
    job.mapsCoverage = {
      searchText, region: /^[a-z]{2}$/i.test(gl) ? gl.toLowerCase() : '',
      observedListings: out.length, listingsWithWebsite: out.filter(item => item.website).length,
      missingWebsite: out.filter(item => !item.website).length,
      scrollPasses, stableBottomPasses: stableAtEnd, stopReason,
      feedStopped: stopReason === 'feed-bottom-stable' || stopReason === 'end-marker',
      coverageNote: 'Observed Google Maps feed results; this does not prove every matching business was returned.'
    };
    if (!out.length) throw new Error('Google Maps returned no readable business cards.');
    return out;
  } finally {
    // Keep the single headed Maps browser open and reuse its tab for the next query.
    if (!browser.isConnected()) { mapsBrowser = null; mapsContext = null; mapsPage = null; }
  }
}

function dedupeLeads(leads) {
  const map = new Map();
  for (const lead of leads) {
    const key = lead.source === 'Google Maps' && lead.source_url ? `google:${lead.source_url}` : (lead.website || lead.name).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (!key) continue;
    if (!map.has(key)) { map.set(key, lead); continue; }
    const existing = map.get(key);
    existing.emails = [...new Map([...existing.emails, ...lead.emails].map(e => [e.value.toLowerCase(), e])).values()];
    existing.phones = [...new Map([...existing.phones, ...lead.phones].map(p => [p.value, p])).values()];
    existing.sources = [...new Set([...existing.sources, ...lead.sources])];
    if (!existing.website) existing.website = lead.website;
    if (!existing.address) existing.address = lead.address;
    if (lead.score > existing.score) { existing.score = lead.score; existing.score_level = lead.score_level; }
  }
  return [...map.values()];
}
function makeJob(kind, work) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { id, kind, startedAt: Date.now(), state: 'running', progress: { pct: 1, stage: 'Starting', message: 'Preparing live search…' }, paused: false, stopped: false, controller: new AbortController(), result: null, error: null };
  jobs.set(id, job);
  work(job).then(async result => {
    if (kind === 'therapist') await finalizeTherapistRun(job, result);
    job.result = result; job.state = 'complete'; progress(job, 100, 'Complete', kind === 'therapist'
      ? job.audit?.sharedQueue ? (result.length ? `Saved ${result.length} row result(s) from the shared queue.` : 'No shared leads were available; the other computer may already be working on them.') : `Processed ${result.length} saved therapist lead rows.`
      : kind === 'therapist-profile-enrichment' ? `Updated profile context on ${result.length} existing saved rows.` : `Found ${result.length} businesses.`);
    void appendAudit({ event: 'completed', jobId: id, kind, query: job.audit?.query, location: job.audit?.location, googleMaps: job.audit?.googleMaps, businesses: result.length, warning: job.warning || '' }).catch(() => {});
  }).catch(error => {
    if (kind === 'therapist' && job.runConfig && !job.learningFinalized) {
      void finalizeTherapistRun(job, [...therapistRows.values()]).catch(() => {});
    }
    job.error = job.error || error.message; job.state = job.stopped ? 'stopped' : 'error'; progress(job, job.state === 'stopped' ? job.progress.pct : 100, job.state, job.error);
    void appendAudit({ event: job.state, jobId: id, kind, query: job.audit?.query, location: job.audit?.location, googleMaps: job.audit?.googleMaps, error: error.message }).catch(() => {});
  });
  return job;
}
async function runLiveSearch(payload, job) {
  const query = String(payload.query || '').trim().slice(0, 200);
  const location = String(payload.location || '').trim().slice(0, 160);
  const maxResults = Math.max(1, Math.min(MAX_RESULTS, Number(payload.maxResults) || 25));
  if (!query) throw new Error('Enter a keyword or search phrase.');
  if (!location && !payload.useGoogleMaps) throw new Error('Add a city or district so the live OpenStreetMap search stays local and bounded.');
  let osmLeads = []; let osmWarning = '';
  if (location && !payload.useGoogleMaps) {
    try {
      update(job, 8, 'Location', `Finding ${location}…`);
      const place = await geocodePhoton(location, job);
      update(job, 18, 'OpenStreetMap', `Searching near ${place.name}…`);
      osmLeads = await discoverOsm(query, place, job, maxResults);
    } catch (error) {
      if (!payload.useGoogleMaps) throw error;
      osmWarning = error.message;
    }
  }
  let googleLeads = []; let googleWarning = '';
  if (payload.useGoogleMaps) {
    try { googleLeads = await scrapeGoogleMaps(query, location, job, String(payload.gl || '')); }
    catch (error) { googleWarning = error.message; if (!osmLeads.length) throw error; }
  }
  const blended = [];
  for (let i = 0; i < Math.max(osmLeads.length, googleLeads.length); i++) {
    if (osmLeads[i]) blended.push(osmLeads[i]);
    if (googleLeads[i]) blended.push(googleLeads[i]);
  }
  const candidates = payload.useGoogleMaps ? googleLeads : dedupeLeads(blended).slice(0, maxResults);
  if (payload.useGoogleMaps) {
    update(job, 95, 'Google Maps', `Finished collecting ${candidates.length} company names and visible website links.`);
  } else {
    update(job, 55, 'Crawl', `Checking public business pages for ${candidates.length} businesses…`);
    let done = 0; let next = 0;
    const concurrency = Math.max(1, Math.min(3, Number(payload.concurrency) || 2));
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (next < candidates.length) {
        const index = next++; const lead = candidates[index]; await waitJob(job);
        await crawlWebsite(lead, job, payload.pagesPerSite, payload.delay, payload.timeout);
        done++; progress(job, 55 + Math.round((done / Math.max(candidates.length, 1)) * 40), 'Crawl', `Checked ${done} of ${candidates.length} business websites.`);
      }
    }));
  }
  const filtered = payload.useGoogleMaps ? candidates : candidates.filter(item => (!payload.requireEmail || item.emails.length) && (!payload.requirePhone || item.phones.length));
  if (googleWarning || osmWarning) job.warning = [osmWarning, googleWarning].filter(Boolean).join(' ');
  return filtered;
}

function normalizedSite(value) {
  try {
    const raw = String(value || '').trim();
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
function therapistRowFromImport(input, rowNumber, sourceFile) {
  const website = normalizedSite(input.website || input.url || input.domain || input.site);
  const name = String(input.name || input.business || input.company || input.practice || input.therapist || '').trim().slice(0, 240);
  const city = String(input.city || input.location || '').trim().slice(0, 160);
  const country = String(input.country || '').trim().slice(0, 100);
  const meaningful = Boolean(website || name || city || input.email || input.address);
  const canonicalKey = `${name.toLowerCase()}|${website ? new URL(website).hostname.toLowerCase() : ''}|${city.toLowerCase()}`;
  const sourceName = String(sourceFile || 'unnamed-import').slice(0, 240);
  const sourceIdentity = sourceRowId(sourceName, rowNumber, canonicalKey || JSON.stringify(input));
  // Source-row identity is deliberately distinct from canonical lead identity:
  // repeated practices can share research, but no source row disappears from coverage.
  return { id: sourceIdentity, sourceIdentity, canonicalLeadKey: createHash('sha256').update(canonicalKey).digest('hex').slice(0, 24), name, website, city, country, address: String(input.address || '').trim().slice(0, 240), sourceUrl: String(input.source_url || input.sourceUrl || '').trim().slice(0, 1000), sourceFile: sourceName, sourceRow: Number(rowNumber) || 0, status: meaningful ? (website ? 'pending' : 'no_website') : 'out_of_scope', sourceDisposition: meaningful ? (website ? 'pending' : 'no_website') : 'empty_source_row', candidates: [], pagesVisited: [], lastError: meaningful ? '' : 'Blank source row retained for reconciliation.', importedAt: new Date().toISOString() };
}
function canonicalTherapistCity(value) {
  const raw = String(value || '').trim();
  const first = raw.split(',')[0].trim();
  const key = first.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (['nyc','new york','new york city'].includes(key)) return 'New York City';
  if (['bronx','the bronx'].includes(key)) return 'The Bronx';
  return EXPECTED_THERAPIST_CITIES.find(city => city.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === key) || (first || 'Unassigned');
}
function extractVisibleEmails(text) {
  const found = new Set();
  for (const match of String(text || '').matchAll(/(?<![\w.+-])[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+(?![\w.-])/g)) {
    const value = match[0].trim().replace(/[.,;:!?)}\]]+$/, '').toLowerCase();
    const [local, domain, ...extra] = value.split('@');
    const digits = local?.replace(/\D/g, '') || '';
    const validLocal = local && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
    const labels = domain?.split('.') || [];
    const tld = labels.at(-1) || '';
    const validDomain = domain && !extra.length && domain.length <= 253 && labels.length >= 2 && tld.length >= 2 && labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
    const phoneLike = digits.length >= 8 && (digits.length / Math.max(1, local.length)) > 0.42;
    if (value.length < 255 && validLocal && validDomain && !phoneLike && !/\.(?:png|jpe?g|gif|svg|webp|css|js)$/i.test(value)) found.add(value);
  }
  return [...found];
}
function isSharedInbox(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[._+-]/g, ' ');
  return /\b(info|contact|hello|admin|office|support|booking|bookings|appointment|appointments|enquir(?:y|ies)|intake|reception|team|care|clinic|practice|general|mail|help|connect|service|services|sales|marketing|careers|jobs|hr|privacy|billing)\b/.test(local);
}
function emailUsernameMatchesName(email, name) {
  let local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const suffix of ['psychotherapy','counseling','counselling','therapist','therapy','psychology','psych','counselor','counsellor','emdr','nyc']) {
    if (local.endsWith(suffix) && local.length - suffix.length >= 4) local = local.slice(0, -suffix.length);
  }
  const tokens = (String(name || '').toLowerCase().match(/[a-z]+/g) || []).filter(token => token.length > 1);
  if (!local || tokens.length < 2) return false;
  const first = tokens[0], last = tokens.at(-1);
  return local === `${first}${last}` || local === `${first[0]}${last}`
    || new RegExp(`^${first[0]}[a-z]{0,2}${last}$`).test(local) || local === first || local === last;
}
function nameCandidates(headings, pageText, structured, row = null) {
  const candidates = new Map();
  const genericNameTerms = new Set(['about','alliance','anger','appointment','appointments','areas','available','blog','center','centre','clients','clinic','clinical','contact','connect','content','counseling','counselling','counselor','counsellor','counselors','counsellors','director','dog','faq','featured','frequently','group','healing','help','here','home','how','individual','information','institute','license','licensed','links','loss','management','media','meet','mental','more','news','nyc','office','our','overview','practice','psychodynamic','psychological','psychologist','psychology','psychotherapist','psychotherapy','questions','quick','read','relationships','say','services','seen','specialties','specialty','start','state','team','the','therapy','therapeutic','therapist','therapists','weight','welcome','wellness','what','york']);
  const add = (name, evidence, title = '') => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim()
      .split(/\s+(?:\||—|–|•)\s+/)[0]
      .replace(/,\s*(?:LCSW(?:-R)?|LMHC|LMFT|LPC|LCPC|LICSW|PsyD|PhD|MSW|MA|MHC|Clinical Psychologist|Psychologist|Psychotherapist|Therapist|Counsel+or).*$/i, '')
      .replace(/^(?:meet|about)\s+/i, '').replace(/^dr\.?\s+/i, '').trim();
    if (!/^(?:[A-Z][A-Za-z’'-]+|[A-Z]\.?)(?:\s+(?:[A-Z][A-Za-z’'-]+|[A-Z]\.)){1,3}$/.test(clean) || clean.length > 100) return;
    if (/^(?:About Us|Meet Our Team|Our Therapists|Our Team|Contact Us|The Team|Therapy Services|As Featured In|As Seen On|Individual Therapy|Couples Therapy|Start Here|Book A Session|Welcome)$/i.test(clean)) return;
    if (clean.split(/\s+/).some(token => genericNameTerms.has(token.replace(/[^A-Za-z]/g, '').toLowerCase()))) return;
    const key = clean.toLowerCase();
    const existing = candidates.get(key);
    candidates.set(key, { name: clean, title: title || existing?.title || '', evidence: evidence || existing?.evidence || 'Page heading', soloEvidence: false });
  };
  for (const item of structured || []) add(item.name, 'Schema.org Person', item.jobTitle || item.type || '');
  for (const heading of headings || []) {
    const clean = String(heading || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 100) continue;
    const position = pageText.toLowerCase().indexOf(clean.toLowerCase());
    const nearby = position >= 0 ? pageText.slice(Math.max(0, position - 220), Math.min(pageText.length, position + clean.length + 300)) : clean;
    if (/therap|psycholog|counsell?or|psychotherap|clinical|LMFT|LCSW|LICSW|LPCC|social worker|licensed|private practice|contact\s/i.test(nearby)) add(clean, 'Named page heading', nearby.slice(0, 240));
  }
  for (const match of pageText.matchAll(/\b(?:Dr\.?\s+)?((?:[A-Z][A-Za-z’'-]+|[A-Z]\.)(?:\s+(?:[A-Z][A-Za-z’'-]+|[A-Z]\.)){1,2})\s*,?\s+(?:LCSW(?:-R)?|LMHC|LMFT|LPC|LCPC|LICSW|PsyD|PhD|MSW|psychotherapist|psychologist|therapist)\b/gi)) add(match[1], 'Practitioner name with professional credential', match[0]);
  for (const match of pageText.matchAll(/\b(?:meet|about|I am|I'm|my name is)\s+(?:Dr\.?\s+)?([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){1,2})/g)) add(match[1], 'Practitioner introduction', match[0]);
  if (row?.name) {
    let leadName = String(row.name).replace(/^(?:psychotherapist|therapist|counsel+or|counsell+or|clinical psychologist)\s+/i, '')
      .split(/\s+(?:\||—|–|-|:|•)\s+/)[0]
      .replace(/,\s*(?:LCSW(?:-R)?|LMHC|LMFT|LPC|LCPC|LICSW|PsyD|PhD|MSW).*$/i, '').trim();
    const tokens = leadName.split(/\s+/);
    while (tokens.length > 2 && genericNameTerms.has(tokens.at(-1).replace(/[^A-Za-z]/g, '').toLowerCase())) tokens.pop();
    leadName = tokens.join(' ');
    const compactName = leadName.toLowerCase().replace(/[^a-z]/g, '');
    let compactHost = '';
    try { compactHost = new URL(row.website).hostname.toLowerCase().replace(/^www\./, '').replace(/[^a-z]/g, ''); } catch { }
    const text = String(pageText || '');
    const fullNameOnPage = leadName.length > 0 && text.toLowerCase().includes(leadName.toLowerCase());
    const firstName = tokens[0] || '';
    const firstNameOnPage = firstName.length > 2 && new RegExp(`\\b${firstName}\\b`, 'i').test(text);
    const professionalContext = /\b(?:therapist|psychotherapist|counsell?or|psycholog(?:ist|y)|licensed|clinical|mental health|clients?|counselling|counseling)\b/i.test(text);
    if (isPlausiblePractitionerName(leadName) && (fullNameOnPage || (compactName && compactHost.includes(compactName) && firstNameOnPage && professionalContext))) {
      add(leadName, fullNameOnPage ? 'Named practitioner on first-party page' : 'Named personal domain and first-person identification', '');
    }
  }
  // Large practitioner directories can contain hundreds of independent cards.
  // Truncating at 30 silently made later names impossible to associate with
  // their own email addresses on the same page.
  return [...candidates.values()].slice(0, 1000);
}
async function getTherapistBrowser() {
  if (!chromium) throw new Error('Playwright is unavailable. Install Playwright and its Chromium browser, then restart the app.');
  if (therapistBrowser?.isConnected()) return therapistBrowser;
  try { therapistBrowser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  catch { therapistBrowser = await chromium.launch({ headless: true }); }
  return therapistBrowser;
}
function allowedProfessionalDirectory(url) {
  try {
    const parsed = new URL(url); const host = parsed.hostname.toLowerCase();
    const trustedProfileDomains = ['thepracticerooms.co.uk','counselling-directory.org.uk','psychologytoday.com','therapyroute.com','bacp.co.uk','itsgoodtotalk.org.uk','goodtherapy.org','therapytribe.com','therapyden.com','inclusive-therapists.com'];
    const trusted = trustedProfileDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
    return trusted && /therap|counsell|psycholog|practitioner|profile|member|\/(?:p|t)\//i.test(`${parsed.pathname} ${parsed.search}`);
  } catch { return false; }
}
function sameWebsiteHost(left, right) {
  try {
    const a = new URL(left); const b = new URL(right);
    if (!['http:','https:'].includes(a.protocol) || !['http:','https:'].includes(b.protocol)) return false;
    const hostA = a.hostname.toLowerCase().replace(/^www\./, '');
    const hostB = b.hostname.toLowerCase().replace(/^www\./, '');
    return hostA === hostB && ['', '80', '443'].includes(a.port) && ['', '80', '443'].includes(b.port);
  } catch { return false; }
}
function canonicalTherapistUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.href;
  } catch { return String(url || ''); }
}
function isMalformedTherapistLink(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    // Some directory pages render bare text such as "www.example.com" as a
    // relative anchor. Playwright resolves it to /directory/www.example.com,
    // which is not a real same-site profile and should not consume a page slot.
    return /\/(?:www\.)?[a-z0-9-]+\.(?:com|org|net|co\.uk)(?:\/|$)/i.test(pathname);
  } catch { return true; }
}
function isLowValueTherapistContent(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    return /(?:^|\/)(?:blog(?:[-_][^/]+)?|tags?(?:[-_][^/]+)?|categories?(?:[-_][^/]+)?|news(?:[-_][^/]+)?|articles?|insights?|resources?|events?)(?:\/|$)/i.test(pathname)
      && !/(?:^|\/)(?:about|about-me|about-us|contact|bio|biography|profile|team|staff|people|therapist|practitioner)(?:\/|$)/i.test(pathname);
  } catch { return true; }
}
function therapistPagePriority(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname).toLowerCase().replace(/[-_]+/g, ' ');
    if (isLowValueTherapistContent(url)) return 0;
    if (/\babout\b|about me|about us|our story|biograph|\bbio\b|meet (?:the|your|our) (?:therapist|practitioner)|practice overview|licensing info/i.test(path)) return 10;
    if (/\bcontact\b|get in touch/i.test(path)) return 8;
    if (/therap|practitioner|counsell?or|psycholog|clinician|profile/i.test(path)) return 7;
    if (/\bteam\b|staff|people|our therapists/i.test(path)) return 5;
    return 1;
  } catch { return 1; }
}
function isAboutEvidencePage(url, headings = []) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase().replace(/[-_]+/g, ' ').replace(/\/+$/, '');
    if (!pathname) return false;
    if (isLowValueTherapistContent(url)) return false;
    const aboutPath = /(?:^|\/)(?:about(?: me| us)?|bio(?:graphy)?|my story|our story|meet(?: the| your| our)?(?: therapist| practitioner)?)(?:\s+[\p{L}][\p{L}'’ .-]+)?(?:\/|$)/iu.test(pathname);
    const knownBioLanding = /(?:^|\/)(?:new york therapy|practice overview|licensing info)(?:\/|$)/i.test(pathname);
    const aboutHeading = (headings || []).some(heading => /^(?:about(?: me| us)?|my story|our story|biography|bio|practice overview(?: and licensing info)?|meet (?:dr\.?\s+)?[\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){1,3}|about\s+[\p{L}][\p{L}'’.-]+(?:\s+[\p{L}][\p{L}'’.-]+){1,3})$/iu.test(String(heading || '').trim().replace(/,?\s+(?:LCSW(?:-R)?|LMHC|LMFT|LPC|LCPC|LICSW|PsyD|PhD|MSW)\b.*$/i, '')));
    return aboutPath || knownBioLanding || (aboutHeading && pathname.split('/').filter(Boolean).length <= 2);
  } catch { return false; }
}
function extractAboutEvidenceExcerpt(body, headings = []) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const navigation = /^(?:home|about(?: me| us)?|contact(?: me| us)?|services?|specialties|specialty areas|blog|resources|faqs?|menu|let's connect|privacy policy|terms)$/i;
  const sentences = text.split(/(?<=[.!?])\s+|\s*\|\s*/).map(part => part.trim()).filter(part => part.length >= 35 && part.length <= 480 && !navigation.test(part));
  const relevant = sentences.filter(sentence => /\b(?:I am|I’m|I'm|my name is|licensed|therapist|psychotherapist|counsell?or|psychologist|art therapist|social worker|speciali[sz]e|experience|years|training|degree|approach|clients?|trauma|anxiety|depression|relationships?)\b/i.test(sentence));
  if (relevant.length) return relevant.slice(0, 5).join(' ').slice(0, 1500);
  const heading = (headings || []).map(value => String(value || '').trim()).find(value => value && !navigation.test(value));
  return `${heading ? `${heading}. ` : ''}${text}`.slice(0, 1500);
}
function extractExplicitSoloPracticeEvidence(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const signals = [
    /\bmy\s+(?:(?:own|private|independent|solo)\s+)(?:(?:therapy|psychotherapy|counselling|counseling|clinical)\s+)?practice\b/i,
    /\bI\s+(?:run|operate|own|founded|maintain)\s+(?:my|an?)\s+(?:own\s+)?(?:private|independent|solo)\s+(?:(?:therapy|psychotherapy|counselling|counseling|clinical)\s+)?practice\b/i,
    /\bI\s+(?:am|work as)\s+(?:a|an)\s+(?:independent|solo|self-employed)\s+(?:therapist|psychotherapist|counsell?or|psychologist|clinician|practitioner)\b/i,
    /\b(?:is|works as|practices as)\s+(?:a|an)\s+private[- ]practice\s+(?:therapist|psychotherapist|counsell?or|psychologist|clinician|practitioner)\b/i,
    /\bI\s+practice\s+independently\b/i,
    /\b(?:solo|independent)\s+practitioner\b/i
  ];
  for (const signal of signals) {
    const match = signal.exec(text);
    if (!match) continue;
    const start = Math.max(0, text.lastIndexOf('.', match.index) + 1);
    const nextStop = text.slice(match.index).search(/[.!?](?:\s|$)/);
    const end = nextStop < 0 ? Math.min(text.length, match.index + 420) : Math.min(text.length, match.index + nextStop + 1);
    const excerpt = text.slice(start, Math.min(end, start + 600)).trim();
    if (excerpt.length >= 25) return excerpt;
  }
  return '';
}
function extractFirstPersonClinicianEvidence(body) {
  const sentences = String(body || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (sentence.length < 25 || sentence.length > 520) continue;
    if (/\b(?:I am|I’m|I'm|my name is)\b/i.test(sentence)
      && /\b(?:licensed|clinical|therapist|psychotherapist|counsell?or|psychologist|art therapist|social worker|practitioner)\b/i.test(sentence)) return sentence.trim();
  }
  return '';
}
function extractFirstPersonPracticeEvidence(body) {
  const sentences = String(body || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  return sentences.find(sentence => sentence.length >= 25 && sentence.length <= 520 && isFirstPersonSinglePracticeStatement(sentence))?.trim() || '';
}
function extractProfessionalDescription(body, headings = [], url = '', metaDescription = '', practitionerName = '') {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const professional = /\b(?:therap(?:y|ist|eutic)|psychotherap(?:y|ist)|counsell?ing|counsell?or|psycholog(?:y|ist|ical)|clinical|mental health|trauma|anxiety|depression|relationships?|couples?|famil(?:y|ies)|children|adolescents|adults|grief|addiction|stress|private practice|clients?|patients?|approach|speciali[sz]e|support|treatment|licensed|LCSW|LMHC|LMFT|LPC|LCPC|LICSW)\b/i;
  const navigation = /^(?:home|about(?: me| us)?|contact(?: us)?|services|therapy services|blog|resources|privacy policy|terms|book now|schedule|appointments?|login|search|menu|learn more|read more)$/i;
  const coreName = therapistSearchNameCore(practitionerName);
  const nameTokens = coreName.toLowerCase().split(/[^\p{L}]+/u).filter(token => token.length > 2);
  const normalizedCoreName = coreName.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const candidates = [];
  const sentences = text.split(/(?<=[.!?])\s+(?=[\p{Lu}\d“"'])|\s*\|\s*/u).map(value => value.trim());
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    if (sentence.length < 35 || sentence.length > 420 || navigation.test(sentence)) continue;
    let score = professional.test(sentence) ? 3 : 0;
    if (/\b(?:I work|I help|I support|my practice|my approach|I specialize|I specialise|I offer|my work|clients? (?:come|seek|work)|we provide)\b/i.test(sentence)) score += 2;
    const normalizedSentence = sentence.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (normalizedCoreName.length >= 5 && normalizedSentence.includes(normalizedCoreName)) score += 4;
    else if (nameTokens.length >= 3 && nameTokens.filter(token => normalizedSentence.includes(token)).length >= 2) score += 1;
    if (/\b(?:licensed|LCSW|LMHC|LMFT|LPC|LCPC|LICSW|psychologist|psychotherapist|therapist|counsell?or)\b/i.test(sentence)) score += 1;
    if (score >= 3) candidates.push({ index, score, sentence });
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  let excerpt = '';
  if (candidates.length) excerpt = candidates.slice(0, 3).sort((a, b) => a.index - b.index).map(item => item.sentence).join(' ').slice(0, 900);
  const cleanMeta = String(metaDescription || '').replace(/\s+/g, ' ').trim();
  if (!excerpt && cleanMeta.length >= 40 && professional.test(cleanMeta)) excerpt = cleanMeta.slice(0, 700);
  if (!excerpt) {
    const heading = (headings || []).find(value => professional.test(String(value)) && String(value).trim().length > 20);
    if (heading) excerpt = String(heading).replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  if (!excerpt) return null;
  const pagePath = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  const source = /about|bio|story|meet/i.test(pagePath) ? 'about_or_bio_page'
    : /therap|practitioner|counsell|psycholog|profile|clinician/i.test(pagePath) ? 'practitioner_or_profile_page'
      : /service|specialt|approach|treatment/i.test(pagePath) ? 'services_or_approach_page'
        : pagePath === '/' || !pagePath ? 'homepage' : 'public_page_snippet';
  return { excerpt, source, score: candidates.length ? Math.max(...candidates.map(item => item.score)) : (professional.test(cleanMeta) ? 2 : 1) };
}
async function sitemapCandidates(origin, rules, job) {
  const sitemapUrl = `${origin}/sitemap.xml`;
  if (!allowedByRobots(sitemapUrl, rules)) return [];
  try {
    const response = await requestText(sitemapUrl, { signal: job.controller.signal, timeoutMs: 7000, maxBytes: 1024 * 1024, headers: { Accept: 'application/xml,text/xml,text/plain' } });
    if (response.status !== 200 || !/xml|text/i.test(String(response.headers['content-type'] || ''))) return [];
    const found = [];
    for (const match of response.body.matchAll(/<loc[^>]*>\s*([^<]+)\s*<\/loc>/gi)) {
      try {
        const target = new URL(decodeHtml(match[1].trim()));
        if (target.origin !== origin || !['http:', 'https:'].includes(target.protocol) || !allowedByRobots(target.href, rules)) continue;
        if (isLowValueTherapistContent(target.href) || !/contact|about|team|staff|people|therap|practitioner|counsell|psycholog|profile|clinician|service/i.test(target.pathname)) continue;
        found.push(canonicalTherapistUrl(target.href));
      } catch { }
      if (found.length >= 40) break;
    }
    return [...new Set(found)].sort((a, b) => therapistPagePriority(b) - therapistPagePriority(a));
  } catch { return []; }
}
function parseStructuredPeople(jsonStrings) {
  const people = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
    const title = String(value.jobTitle || type || '');
    if (value.name && /person|therap|psycholog|counsell?or|physician|medical|doctor/i.test(title)) people.push({ name: String(value.name), jobTitle: title, email: String(value.email || '') });
    for (const [key, nested] of Object.entries(value)) if (key !== '@context') walk(nested);
  };
  for (const raw of jsonStrings) { try { walk(JSON.parse(raw)); } catch { } }
  return people;
}
async function researchTherapistLead(row, job, options) {
  const ragDecision = therapistRagContext('approve personal direct therapist email named clinician exact public email attribution role inbox bio about optional solo evidence');
  if (!row.website) return { ...row, status: 'no_website', lastError: 'No public website supplied.' };
  let start;
  try { start = new URL(row.website); assertSafeHost(start.hostname); await resolvePublic(start.hostname); }
  catch (error) { return { ...row, status: 'failed', lastError: error.message }; }
  const origin = start.origin;
  let rules;
  try { rules = await getRobots(origin, job); }
  catch (error) {
    if (job.stopped || /Stopped by user/.test(error.message)) return { ...row, status: 'pending', lastError: '' };
    return { ...row, status: 'blocked', lastError: `Could not read robots.txt safely: ${error.message}` };
  }
  if (!allowedByRobots(start.href, rules)) return { ...row, status: 'blocked', lastError: 'robots.txt disallows the supplied home page.' };
  const pagesLimit = Math.max(1, Math.min(20, Number(options.pagesPerSite) || 12));
  const visited = new Set();
  const sitemapUrls = await sitemapCandidates(origin, rules, job);
  const queue = [{ url: canonicalTherapistUrl(start.href), priority: 0 }, ...sitemapUrls.filter(url => !isAboutEvidencePage(url)).map(url => ({ url, priority: therapistPagePriority(url) === 10 ? 6 : therapistPagePriority(url) })).filter(item => item.priority > 0)];
  const deferredAboutUrls = new Map(sitemapUrls.filter(url => isAboutEvidencePage(url)).map(url => [url, { url, priority: 10 }]));
  const aboutDiscoveredUrls = new Set(sitemapUrls.filter(url => isAboutEvidencePage(url)));
  const aboutPagesVisited = [];
  let aboutEvidenceExcerpt = '';
  let aboutEvidenceUrl = '';
  let soloStatusEvidence = '';
  let soloStatusEvidenceUrl = '';
  let soloEvidencePractitionerName = '';
  let firstPersonClinicianEvidence = '';
  let firstPersonClinicianEvidenceUrl = '';
  let firstPersonPracticeEvidence = '';
  let firstPersonPracticeEvidenceUrl = '';
  let professionalDescription = '';
  let professionalDescriptionUrl = '';
  let professionalDescriptionSource = '';
  let professionalDescriptionScore = 0;
  let groupPracticeDetected = false;
  let directoryCardsCaptured = false;
  let personalEmailAndNamedPractitionerFound = false;
  const candidates = new Map((row.candidates || []).map(item => [item.email, item]));
  const peopleFound = new Map();
  const pageErrors = [];
  let robotsSkipped = 0;
  const browser = await getTherapistBrowser();
  const context = await browser.newContext({ javaScriptEnabled: true, acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(Math.max(5000, Math.min(25000, Number(options.timeoutSeconds) * 1000 || 15000)));
  page.setDefaultTimeout(6000);
  const checkedHosts = new Set();
  let currentOrigin = origin;
  await page.route('**/*', async route => {
    try {
      if (['image','font','media'].includes(route.request().resourceType())) return route.abort();
      const raw = route.request().url();
      if (/^(?:data|blob|about):/i.test(raw)) return route.continue();
      const target = new URL(raw);
      if (!['http:', 'https:'].includes(target.protocol) || (target.origin !== currentOrigin && !sameWebsiteHost(raw, currentOrigin))) return route.abort();
      if (!checkedHosts.has(target.hostname)) { await resolvePublic(target.hostname); checkedHosts.add(target.hostname); }
      return route.continue();
    } catch { return route.abort(); }
  });
  try {
    while (queue.length && visited.size < pagesLimit) {
      await waitJob(job);
      const queueItem = queue.shift();
      const url = typeof queueItem === 'string' ? queueItem : queueItem.url;
      let urlOrigin;
      try { urlOrigin = new URL(url).origin; } catch { continue; }
      if (urlOrigin !== origin && !allowedProfessionalDirectory(url)) continue;
      let pageRules = rules;
      if (urlOrigin !== origin) {
        try { pageRules = await getRobots(urlOrigin, job); } catch (error) { if (job.stopped || /Stopped by user/.test(error.message)) throw error; continue; }
      }
      if (visited.has(url)) continue;
      if (!allowedByRobots(url, pageRules)) { robotsSkipped++; continue; }
      visited.add(url);
      currentOrigin = urlOrigin;
      await delayHost(new URL(url).hostname, Math.max(1, Number(options.delaySeconds) || 1, pageRules.delay), job);
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, Math.min(25000, Number(options.timeoutSeconds) * 1000 || 15000)) });
        if (response && [403, 429, 503].includes(response.status())) {
          if (urlOrigin === origin) return { ...row, status: 'blocked', pagesVisited: [...visited], candidates: [...candidates.values()], lastError: `Website returned HTTP ${response.status()}; stopped instead of retrying around the restriction.` };
          pageErrors.push(`${url}: external profile directory returned HTTP ${response.status()}; skipped`);
          continue;
        }
        if (!response) { pageErrors.push(`${url}: navigation returned no response`); continue; }
        if (response.status() < 200 || response.status() >= 400) { pageErrors.push(`${url}: HTTP ${response.status()}`); continue; }
        if (!sameWebsiteHost(page.url(), url)) { pageErrors.push(`${url}: navigation left the supplied website host`); continue; }
        await page.waitForTimeout(400);
        const body = await page.locator('body').innerText({ timeout: 4000 }).catch(() => '');
        if (/captcha|unusual traffic|automated queries|access denied|request blocked/i.test(body.slice(0, 12000))) {
          return { ...row, status: 'blocked', pagesVisited: [...visited], candidates: [...candidates.values()], lastError: 'Site presented a bot challenge or access block; stopped without retrying around it.' };
        }
        const headings = await page.locator('h1,h2,h3,h4').allInnerTexts().catch(() => []);
        const pageTitle = await page.title().catch(() => '');
        const isAboutPage = isAboutEvidencePage(page.url(), headings);
        if (isAboutPage) {
          if (!aboutPagesVisited.includes(canonicalTherapistUrl(page.url()))) aboutPagesVisited.push(canonicalTherapistUrl(page.url()));
          aboutEvidenceExcerpt = extractAboutEvidenceExcerpt(body, headings);
          aboutEvidenceUrl = canonicalTherapistUrl(page.url());
        }
        const jsonStrings = await page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []);
        const people = parseStructuredPeople(jsonStrings);
        const names = nameCandidates([...headings, pageTitle], body, people, row);
        if (/\b(?:group practice|team of therapists|team of clinicians|our therapists|our clinicians|clinical team|multiple therapists|multiple practitioners|our providers|meet (?:the|our) (?:therapists|clinicians|providers)|multi[- ]disciplinary team|staff therapists)\b/i.test(body)) groupPracticeDetected = true;
        for (const person of names) if (isPlausiblePractitionerName(person.name)) peopleFound.set(person.name.toLowerCase(), person);
        // Several human-like headings can be navigation or article references.
        // Require explicit team language or distinct structured clinician profiles.
        if (people.length > 1 && new Set(people.map(person => person.name.toLowerCase())).size > 1) groupPracticeDetected = true;
        const firstPartyPage = sameWebsiteHost(row.website, page.url());
        const pageSoloEvidence = firstPartyPage ? extractExplicitSoloPracticeEvidence(body) : '';
        if (pageSoloEvidence) {
          soloStatusEvidence = pageSoloEvidence;
          soloStatusEvidenceUrl = page.url();
          soloEvidencePractitionerName = names.length === 1 ? names[0].name : '';
        }
        const pageFirstPersonEvidence = firstPartyPage ? extractFirstPersonClinicianEvidence(body) : '';
        if (pageFirstPersonEvidence) { firstPersonClinicianEvidence = pageFirstPersonEvidence; firstPersonClinicianEvidenceUrl = page.url(); }
        const pagePracticeEvidence = firstPartyPage ? extractFirstPersonPracticeEvidence(body) : '';
        if (pagePracticeEvidence) { firstPersonPracticeEvidence = pagePracticeEvidence; firstPersonPracticeEvidenceUrl = page.url(); }
        const pageMetaDescription = await page.locator('meta[name="description"],meta[property="og:description"]').first().getAttribute('content').catch(() => '') || '';
        const namedForDescription = names.find(person => person.title || /therap|psycholog|counsell|clinical/i.test(person.evidence || ''))?.name || names[0]?.name || '';
        const pageDescription = !groupPracticeDetected ? extractProfessionalDescription(body, headings, page.url(), pageMetaDescription, namedForDescription) : null;
        if (pageDescription && pageDescription.score + (isAboutPage ? 1 : 0) > professionalDescriptionScore) {
          professionalDescription = pageDescription.excerpt;
          professionalDescriptionUrl = page.url();
          professionalDescriptionSource = pageDescription.source;
          professionalDescriptionScore = pageDescription.score + (isAboutPage ? 1 : 0);
        }
        const mailtos = await page.locator('a[href^="mailto:"]').evaluateAll(nodes => nodes.map(node => {
          let best = null;
          let bestNode = null;
          const targetEmail = String(node.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
          let current = node;
          for (let depth = 0; current && depth < 12; depth++, current = current.parentElement) {
            const text = String(current.innerText || '').replace(/\s+/g, ' ').trim();
            if (text.length < 55 || text.length > 7000 || !text.toLowerCase().includes(targetEmail)) continue;
            const headings = [...current.querySelectorAll('h1,h2,h3,h4,h5,[itemprop="name"]')]
              .map(item => String(item.innerText || '').replace(/\s+/g, ' ').trim())
              .filter(value => value.split(/\s+/).length >= 2 && value.split(/\s+/).length <= 6
                && !/availability|certified|therapist|supervisor|specialties|specialities|contact|about|meet|team|staff|services|practice/i.test(value));
            const heading = headings.length === 1 ? headings[0] : '';
            const emails = [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(value => value.toLowerCase()))];
            if (!heading || emails.length !== 1 || emails[0] !== targetEmail) continue;
            const profileMarker = /therapist|clinician|provider|practitioner|psych|counsel|counsell|profile|member|staff|team|author-element-detail/i.test(`${current.className || ''} ${current.id || ''} ${current.getAttribute('role') || ''}`);
            if (!profileMarker && !current.matches('article,li,[role="listitem"]')) continue;
            // Prefer the largest enclosing single-person card so specialties,
            // availability, payment and license fields are retained together.
            const candidate = { text: text.slice(0, 5000), heading, depth, score: text.length - depth * 3 };
            if (!best || candidate.score > best.score) { best = candidate; bestNode = current; }
          }
          const profileLink = bestNode ? [...bestNode.querySelectorAll('a[href]')]
            .map(link => link.href).find(href => /therapist|clinician|provider|practitioner|profile|member/i.test(href)) || '' : '';
          return { href: node.getAttribute('href') || '', label: (node.innerText || node.getAttribute('aria-label') || '').trim(), profileText: best?.text || '', profileHeading: best?.heading || '', profileUrl: profileLink, profileHeadingCount: best ? 1 : 0, profileEmailCount: best ? 1 : 0 };
        })).catch(() => []);
        const visibleEmailText = body.replace(/\s*(?:\[at\]|\(at\)|\{at\})\s*/gi, '@').replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi, '.');
        const mailtoEmails = mailtos.flatMap(item => extractVisibleEmails(decodeURIComponent(item.href.replace(/^mailto:/i, '').split('?')[0])).map(email => ({ email, label: item.label, profileText: item.profileText, profileHeading: item.profileHeading, profileUrl: item.profileUrl })));
        const emails = new Set([...extractVisibleEmails(visibleEmailText), ...mailtoEmails.map(item => item.email), ...people.flatMap(person => extractVisibleEmails(person.email))]);
        let pageLinkedEmailCards = 0;
        for (const email of emails) {
          const lower = email.toLowerCase();
          const evidenceText = visibleEmailText;
          const at = evidenceText.toLowerCase().indexOf(lower);
          const schemaMatch = people.find(person => person.email.replace(/^mailto:/i, '').toLowerCase() === lower);
          const mailtoMatch = mailtoEmails.find(item => item.email === lower);
          let profileText = String(mailtoMatch?.profileText || schemaMatch?.description || '').replace(/\s+/g, ' ').trim();
          let profileHeading = String(mailtoMatch?.profileHeading || schemaMatch?.name || '').trim();
          let profileNames = profileText ? nameCandidates(profileHeading ? [profileHeading] : [], profileText, [], row) : [];
          let snippet = at >= 0 ? evidenceText.slice(Math.max(0, at - 180), Math.min(evidenceText.length, at + lower.length + 180)).replace(/\s+/g, ' ').trim() : schemaMatch ? `Public structured profile data lists ${schemaMatch.name} with contact email ${lower}.` : mailtoMatch ? `Public mailto link publishes ${lower}${mailtoMatch.label ? ` with link label “${mailtoMatch.label.slice(0, 120)}”` : ''}.` : '';
          const linked = names.filter(person => snippet.toLowerCase().includes(person.name.toLowerCase()));
          const localMatches = names.filter(person => emailUsernameMatchesName(lower, person.name));
          let profileLocalMatches = profileNames.filter(person => emailUsernameMatchesName(lower, person.name));
          let profileLinked = profileNames.filter(person => profileText.toLowerCase().includes(person.name.toLowerCase()));
          let attributed = schemaMatch ? names.find(person => person.name.toLowerCase() === schemaMatch.name.toLowerCase()) || schemaMatch
            : profileLocalMatches.length === 1 ? profileLocalMatches[0]
            : profileLinked.length === 1 ? profileLinked[0]
            : linked.length === 1 ? linked[0] : localMatches.length === 1 ? localMatches[0] : null;
          if (mailtoMatch && attributed?.name && at >= 0 && !profileText.toLowerCase().includes(lower)) {
            const lowerBody = body.toLowerCase();
            const emailIndex = lowerBody.indexOf(lower);
            const nameIndex = lowerBody.lastIndexOf(attributed.name.toLowerCase(), emailIndex);
            if (nameIndex >= 0) {
              const nextNames = names.map(person => String(person.name || '').trim())
                .filter(name => name && name.toLowerCase() !== attributed.name.toLowerCase())
                .map(name => ({ name, index: lowerBody.indexOf(name.toLowerCase(), emailIndex + lower.length) }))
                .filter(person => person.index > emailIndex);
              const endIndex = nextNames.length ? Math.min(...nextNames.map(person => person.index)) : body.length;
              const segment = body.slice(nameIndex, endIndex).replace(/\s+/g, ' ').trim();
              const segmentEmails = [...new Set(extractVisibleEmails(segment).map(value => value.toLowerCase()))];
              if (segment.length >= 80 && segment.length <= 9000 && segmentEmails.length === 1 && segmentEmails[0] === lower) {
                profileText = segment.slice(0, 5000);
                profileHeading = attributed.name;
                snippet = profileText.slice(0, 2200);
                profileNames = nameCandidates([profileHeading], profileText, [], row);
                profileLocalMatches = profileNames.filter(person => emailUsernameMatchesName(lower, person.name));
                profileLinked = profileNames.filter(person => profileText.toLowerCase().includes(person.name.toLowerCase()));
                if (profileNames.some(person => person.name.toLowerCase() === attributed.name.toLowerCase())) attributed = profileNames.find(person => person.name.toLowerCase() === attributed.name.toLowerCase());
              }
            }
          }
          const shared = isSharedInbox(lower);
          const profileSoloEvidence = profileText ? extractExplicitSoloPracticeEvidence(profileText) : '';
          // A directory can contain many therapists, each with their own email and
          // independent-practice statement. Never apply a page-wide statement from
          // one clinician to every address on that page.
          const singlePersonPageEvidence = attributed && names.length === 1
            && names[0].name.toLowerCase() === attributed.name.toLowerCase()
            ? (pageSoloEvidence || (soloEvidencePractitionerName.toLowerCase() === attributed.name.toLowerCase() ? soloStatusEvidence : ''))
            : '';
          const applicableSoloEvidence = profileSoloEvidence || singlePersonPageEvidence;
          const schemaNameLinked = Boolean(schemaMatch && attributed && schemaMatch.name.toLowerCase() === attributed.name.toLowerCase());
          const profileNameLinked = Boolean(mailtoMatch && attributed && (profileLocalMatches.length === 1 || profileLinked.length === 1));
          const textNameLinked = Boolean(attributed && linked.length === 1 && linked[0].name.toLowerCase() === attributed.name.toLowerCase());
          // Do not infer person-to-email identity from a similar mailbox name or
          // from a lone name somewhere on a page. Require a same-person record.
          const uniqueProfileMailto = Boolean(mailtoMatch?.profileText && attributed && names.length === 1
            && profileText.toLowerCase().includes(attributed.name.toLowerCase()) && profileText.toLowerCase().includes(lower));
          const exactPersonEmailLink = schemaNameLinked || profileNameLinked || textNameLinked || uniqueProfileMailto;
          const emailAttributionMethod = schemaNameLinked ? 'structured_person_email' : profileNameLinked ? 'email_and_name_matched_within_profile_card' : textNameLinked ? 'name_and_exact_email_in_public_contact_text' : '';
          const profileBio = profileText ? extractProfessionalDescription(profileText, profileHeading ? [profileHeading] : [], page.url(), '', attributed?.name || '') : null;
          // Keep the whole clinician-specific card where available: directories often
          // publish credentials, specialties, availability, locations, languages,
          // insurance, and licence jurisdictions together with the contact address.
          const profileHasPersonAndEmail = Boolean(attributed?.name
            && ((profileText.toLowerCase().includes(attributed.name.toLowerCase()) && profileText.toLowerCase().includes(lower))
              || (schemaNameLinked && profileText.length >= 40)));
          const singlePersonPageBio = Boolean(names.length === 1 && attributed && names[0].name.toLowerCase() === attributed.name.toLowerCase() && !groupPracticeDetected);
          const personBio = (profileHasPersonAndEmail && profileText.length >= 40 ? profileText.slice(0, 2200) : '')
            || (singlePersonPageBio ? profileBio?.excerpt : '') || (singlePersonPageBio ? (attributed?.title || '') : '');
          const personBioUrl = page.url();
          const automatedDirectContactEvidence = attributed && snippet
            ? `${attributed.evidence || `Named clinician ${attributed.name} appears on this page.`} Published contact: ${snippet}`
            : '';
          // Person-to-email proof is the approval gate; solo practice is an optional,
          // separate annotation and must not suppress a named clinician's direct email.
          const personContextEvidence = profileHasPersonAndEmail ? profileText.slice(0, 2200)
            : textNameLinked ? snippet : schemaNameLinked ? `Structured person record for ${attributed?.name} publishes ${lower}.` : '';
          const autoVerified = Boolean(!shared && (firstPartyPage || Boolean(profileSoloEvidence))
            && isPlausiblePractitionerName(attributed?.name) && exactPersonEmailLink && personContextEvidence && personBio && lower
            && String(snippet || '').toLowerCase().includes(lower));
          const verification = autoVerified ? {
            directContactEvidence: automatedDirectContactEvidence,
            directEvidenceUrl: page.url(),
            soloStatusEvidence: applicableSoloEvidence,
            soloEvidenceUrl: profileSoloEvidence ? personBioUrl : pageSoloEvidence ? page.url() : soloStatusEvidenceUrl,
            verificationMethod: 'harvest_person_email_rules_v3',
            namedPractitionerEvidence: attributed?.evidence || '',
            personContextName: attributed?.name || '',
            personContextEvidence: personContextEvidence || '',
            personContextEvidenceUrl: personContextEvidence ? page.url() : '',
            emailAttributionMethod,
            soloPracticeBasis: applicableSoloEvidence ? (profileSoloEvidence ? 'explicit_independent_practice_statement_in_profile' : 'explicit_independent_practice_statement') : '',
            confidence: 'high',
            verifiedAt: new Date().toISOString()
          } : undefined;
          const reviewReasons = [];
          if (!shared && (!attributed?.name || !isPlausiblePractitionerName(attributed?.name))) reviewReasons.push('named_practitioner_not_confidently_identified');
          if (!shared && attributed?.name && !exactPersonEmailLink) reviewReasons.push('email_not_explicitly_linked_to_named_practitioner');
          if (!shared && !personBio) reviewReasons.push('person_specific_context_not_verified');
          if (!shared && !applicableSoloEvidence) reviewReasons.push('solo_status_not_assessed_or_not_public');
          if (groupPracticeDetected && !exactPersonEmailLink) reviewReasons.push('group_or_multiple_practitioner_signals_need_person_email_link');
          if (!firstPartyPage) reviewReasons.push('evidence_is_not_from_practitioner_website');
          const candidate = {
            email: lower,
            practitionerName: attributed?.name || '',
            nameEvidence: attributed?.evidence || (names.length ? 'Name appears on same page; attribution unconfirmed' : ''),
            emailEvidence: snippet,
            evidenceUrl: page.url(),
            emailAttributionMethod,
            practitionerBio: personBio,
            practitionerBioUrl: personBio ? personBioUrl : '',
            practitionerProfileUrl: mailtoMatch?.profileUrl || '',
            practitionerProfileExcerpt: profileText.slice(0, 2200),
            practitionerProfileEvidenceUrl: mailtoMatch ? page.url() : '',
            practitionerBioSource: profileText ? 'public clinician contact/profile card (full published context)' : profileBio?.source || (attributed?.title ? 'public clinician page context' : ''),
            pageDepth: visited.size,
            soloEvidence: Boolean(autoVerified && applicableSoloEvidence),
            inboxType: shared ? 'shared_or_role_inbox' : autoVerified ? 'direct_person_confirmed_by_harvest_evidence' : 'direct_candidate',
            disposition: shared ? 'excluded_suggested' : autoVerified ? 'approved_personal_direct' : 'needs_review',
            verification,
            verificationAssessment: { status: autoVerified ? 'verified_during_harvest' : shared ? 'excluded_shared_or_role' : 'needs_review', reasons: reviewReasons },
            policyVersion: POLICY_VERSION,
            decisionTrace: { ruleIds: ragDecision.coreRules.map(rule => rule.id), policyVersion: POLICY_VERSION, evaluatedAt: ragDecision.retrievedAt }
          };
          const atomicEmailExcerpt = schemaNameLinked
            ? `Structured Person record: ${schemaMatch.name}; ${schemaMatch.email}; ${schemaMatch.jobTitle || schemaMatch.description || ''}`
            : profileText && attributed?.name && profileText.toLowerCase().includes(attributed.name.toLowerCase()) && profileText.toLowerCase().includes(lower)
              ? profileText.slice(0, 2200) : snippet;
          candidate.identityEvidencePackets = [{
            practitionerName: candidate.practitionerName,
            email: candidate.email,
            emailExcerpt: atomicEmailExcerpt,
            emailUrl: page.url(),
            contextExcerpt: candidate.practitionerBio || '',
            contextUrl: candidate.practitionerBioUrl || '',
            personContextName: candidate.verification?.personContextName || candidate.practitionerName,
            personContextEvidence: candidate.verification?.personContextEvidence || '',
            personContextEvidenceUrl: candidate.verification?.personContextEvidenceUrl || '',
            attributionMethod: candidate.verification?.emailAttributionMethod || candidate.emailAttributionMethod,
            structuredPersonRecord: Boolean(schemaMatch && schemaNameLinked),
            structuredRecordName: schemaMatch?.name || '',
            structuredRecordEmail: schemaMatch?.email || '',
            sourceReference: { sourceIdentity: row.sourceIdentity || row.id, sourceFile: row.sourceFile || '', sourceRow: row.sourceRow || 0 },
            evidenceType: schemaMatch && schemaNameLinked ? 'structured_person' : profileNameLinked ? 'person_profile_card' : 'scoped_public_contact_text'
          }];
          const identityDecision = evaluateTherapistContact(candidate, row);
          candidate.identityRagAssessment = summarizeIdentityRag(identityDecision);
          if (autoVerified && !identityDecision.ok) {
            candidate.disposition = 'needs_review';
            candidate.inboxType = 'direct_candidate';
            candidate.soloEvidence = false;
            candidate.verificationAssessment = {
              status: identityDecision.status,
              reasons: [...new Set([...reviewReasons, ...identityDecision.reasons])]
            };
          }
          if (profileText.toLowerCase().includes(lower) && isPlausiblePractitionerName(attributed?.name)
            && profileText.toLowerCase().includes(attributed.name.toLowerCase())) pageLinkedEmailCards++;
          const personLinkedOnPage = Boolean(schemaNameLinked || profileNameLinked || textNameLinked || uniqueProfileMailto);
          if (!shared && personLinkedOnPage && exactPersonEmailLink && isPlausiblePractitionerName(attributed?.name) && !groupPracticeDetected) {
            personalEmailAndNamedPractitionerFound = true;
          }
          const existingCandidate = candidates.get(lower);
          const existingName = normalizeTherapistPersonName(existingCandidate?.practitionerName);
          const currentName = normalizeTherapistPersonName(candidate.practitionerName);
          if (existingCandidate && existingName && currentName && existingName !== currentName) {
            existingCandidate.identityEvidencePackets = mergeIdentityEvidencePackets(existingCandidate.identityEvidencePackets || [], candidate.identityEvidencePackets || []);
            const conflictNames = [...new Set([...(existingCandidate.identityConflictNames || [existingCandidate.practitionerName]), candidate.practitionerName])];
            existingCandidate.disposition = 'needs_review';
            existingCandidate.inboxType = 'direct_candidate';
            existingCandidate.verification = undefined;
            existingCandidate.identityConflict = true;
            existingCandidate.identityConflictNames = conflictNames;
            existingCandidate.verificationAssessment = {
              status: 'needs_review',
              reasons: [...new Set([...(existingCandidate.verificationAssessment?.reasons || []), 'one_email_attributed_to_multiple_practitioners'])]
            };
            candidates.set(lower, existingCandidate);
            continue;
          }
          if (existingCandidate?.identityConflict) {
            existingCandidate.identityEvidencePackets = mergeIdentityEvidencePackets(existingCandidate.identityEvidencePackets || [], candidate.identityEvidencePackets || []);
            existingCandidate.identityConflictNames = [...new Set([...(existingCandidate.identityConflictNames || []), candidate.practitionerName].filter(Boolean))];
            candidates.set(lower, existingCandidate);
            continue;
          }
          if (!existingCandidate || (!isApprovedPersonalDirect(existingCandidate, row) && !['excluded','unresolved'].includes(existingCandidate.disposition))
            || (identityDecision.ok && !isApprovedPersonalDirect(existingCandidate, row))) {
            candidates.set(lower, candidate);
          } else if (existingCandidate) {
            existingCandidate.identityEvidencePackets = mergeIdentityEvidencePackets(existingCandidate.identityEvidencePackets || [], candidate.identityEvidencePackets || []);
            existingCandidate.identityRagAssessment = summarizeIdentityRag(evaluateTherapistContact(existingCandidate, row));
          }
        }
        if (/\/find[-_]a[-_](?:therapist|counsell?or)(?:\/|$)|\/directory(?:\/|$)/i.test(new URL(page.url()).pathname)
          && pageLinkedEmailCards >= 20) {
          directoryCardsCaptured = true;
          break;
        }
        if (visited.size < pagesLimit) {
          const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => ({ href: node.href, text: node.innerText || node.getAttribute('aria-label') || '' }))).catch(() => []);
          const scoreLink = link => isLowValueTherapistContent(link.href) ? 0 : /find[-_/ ]?a[-_/ ]?(?:therapist|counsell?or)|\/directory\//i.test(`${link.href} ${link.text}`) ? 11 : /about|biograph|\bbio\b|our story|meet (?:the|your|our)|practice overview|licensing info/i.test(`${link.href} ${link.text}`) ? 10 : /contact|get in touch/i.test(`${link.href} ${link.text}`) ? 8 : /therap|practitioner|counsell|psycholog|clinician|profile/i.test(`${link.href} ${link.text}`) ? 7 : /team|staff|people/i.test(`${link.href} ${link.text}`) ? 5 : /service|faq/i.test(`${link.href} ${link.text}`) ? 3 : /privacy|legal/i.test(`${link.href} ${link.text}`) ? 1 : 0;
          const selected = links.filter(link => {
            try { const target = new URL(link.href); return !isMalformedTherapistLink(target.href) && ((target.origin === urlOrigin && scoreLink(link) > 0) || (urlOrigin === origin && allowedProfessionalDirectory(target.href))); } catch { return false; }
          }).map(link => ({ url: canonicalTherapistUrl(link.href), priority: scoreLink(link) })).sort((a, b) => b.priority - a.priority);
          for (const link of selected) {
            if (isAboutEvidencePage(link.href)) {
              aboutDiscoveredUrls.add(link.url);
              if (!visited.has(link.url)) deferredAboutUrls.set(link.url, link);
              continue;
            }
            const eligibleLink = link.priority === 10 ? { ...link, priority: 6 } : link;
            if (!visited.has(link.url) && !queue.some(item => (typeof item === 'string' ? item : item.url) === link.url)) queue.push(eligibleLink);
          }
          if (personalEmailAndNamedPractitionerFound && !groupPracticeDetected) {
            for (const aboutLink of deferredAboutUrls.values()) if (!visited.has(aboutLink.url) && !queue.some(item => (typeof item === 'string' ? item : item.url) === aboutLink.url)) queue.push({ ...aboutLink, priority: 9.5 });
            deferredAboutUrls.clear();
          }
          queue.sort((a, b) => (typeof b === 'string' ? therapistPagePriority(b) : b.priority) - (typeof a === 'string' ? therapistPagePriority(a) : a.priority));
        }
      } catch (error) {
        if (/Stopped by user/.test(error.message)) throw error;
        pageErrors.push(`${url}: ${String(error.message || error).slice(0, 180)}`);
      }
    }
    let soloPracticeBasis = soloStatusEvidence ? 'explicit_independent_practice_statement' : '';
    const unvisitedQueued = queue.some(candidate => !visited.has(typeof candidate === 'string' ? candidate : candidate.url));
    const allDiscoveredAboutVisited = [...aboutDiscoveredUrls].every(url => visited.has(url));
    const siteScanComplete = !unvisitedQueued && allDiscoveredAboutVisited && !pageErrors.length && !robotsSkipped;
    // Identity on a named domain or a first-person bio is not proof of solo practice.
    // A first-person statement about the clinician's own practice can qualify only
    // after the About page was visited and the eligible same-site queue completed.
    if (!soloStatusEvidence && !groupPracticeDetected && siteScanComplete && aboutPagesVisited.length > 0
      && peopleFound.size === 1 && firstPersonPracticeEvidence) {
      soloStatusEvidence = firstPersonPracticeEvidence;
      soloStatusEvidenceUrl = firstPersonPracticeEvidenceUrl;
      soloPracticeBasis = 'first_person_practice_single_clinician_site';
    }
    // Multiple clinicians on a directory or association page do not establish
    // that every listed therapist is a group-practice contact. Keep candidates
    // in review unless their own email/profile evidence proves the classification.
    if (!groupPracticeDetected && soloStatusEvidence) for (const candidate of candidates.values()) {
      if (candidate.inboxType === 'shared_or_role_inbox' || candidate.verification?.verificationMethod === 'harvest_evidence_rules_v2') continue;
      const exactProof = String(candidate.emailEvidence || '').toLowerCase().includes(String(candidate.email || '').toLowerCase());
      if (!isPlausiblePractitionerName(candidate.practitionerName) || !candidate.emailAttributionMethod
        || !candidate.verification?.personContextEvidence || !candidate.verification?.personContextEvidenceUrl
        || !exactProof || !candidate.practitionerBio || !sameWebsiteHost(row.website, candidate.evidenceUrl)) continue;
      candidate.disposition = 'approved_personal_direct';
      candidate.inboxType = 'direct_person_confirmed_by_harvest_evidence';
      candidate.soloEvidence = Boolean(soloStatusEvidence);
      candidate.verification = {
        directContactEvidence: `${candidate.nameEvidence || `Named clinician ${candidate.practitionerName} appears on this first-party site.`} Published contact: ${candidate.emailEvidence}`,
        directEvidenceUrl: candidate.evidenceUrl,
        soloStatusEvidence: soloStatusEvidence || '',
        soloEvidenceUrl: soloStatusEvidence ? soloStatusEvidenceUrl : '',
        namedPractitionerEvidence: candidate.nameEvidence || candidate.practitionerName,
        personContextName: candidate.practitionerName,
        personContextEvidence: candidate.verification.personContextEvidence,
        personContextEvidenceUrl: candidate.verification.personContextEvidenceUrl,
        emailAttributionMethod: candidate.emailAttributionMethod,
        soloPracticeBasis: soloStatusEvidence ? soloPracticeBasis : '',
        verificationMethod: 'harvest_person_email_rules_v3',
        confidence: 'high',
        verifiedAt: new Date().toISOString()
      };
      candidate.verificationAssessment = { status: 'verified_during_harvest', reasons: [] };
    }
    const pageLimitReached = !directoryCardsCaptured && visited.size >= pagesLimit && (queue.some(candidate => !visited.has(typeof candidate === 'string' ? candidate : candidate.url)) || (deferredAboutUrls.size > 0 && personalEmailAndNamedPractitionerFound && !groupPracticeDetected));
    const enrichedCandidates = [...candidates.values()].map(candidate => {
      const candidateKey = normalizeIdentityName(candidate.practitionerName);
      const aboutKey = normalizeIdentityName(aboutEvidenceExcerpt);
      const aboutBelongsToCandidate = Boolean(candidateKey && aboutKey.includes(candidateKey));
      const descriptionText = String(candidate.professionalDescription || professionalDescription || '');
      const descriptionBelongsToCandidate = Boolean(candidateKey && normalizeIdentityName(descriptionText).includes(candidateKey));
      const enriched = {
        ...candidate,
        aboutEvidence: aboutBelongsToCandidate ? aboutEvidenceExcerpt : '',
        aboutEvidenceUrl: aboutBelongsToCandidate ? aboutEvidenceUrl : '',
        professionalDescription: descriptionBelongsToCandidate ? descriptionText : '',
        professionalDescriptionUrl: descriptionBelongsToCandidate ? candidate.professionalDescriptionUrl || professionalDescriptionUrl : '',
        professionalDescriptionSource: descriptionBelongsToCandidate ? candidate.professionalDescriptionSource || professionalDescriptionSource : ''
      };
      const identityDecision = evaluateTherapistContact(enriched, row);
      enriched.identityRagAssessment = summarizeIdentityRag(identityDecision);
      if (candidate.verification?.verificationMethod === 'harvest_person_email_rules_v3' && identityDecision.ok) {
        enriched.disposition = 'approved_personal_direct';
        enriched.inboxType = 'direct_person_confirmed_by_harvest_evidence';
        enriched.verificationAssessment = { status: 'verified_during_harvest', reasons: [] };
      } else if (['approved_personal_direct', 'approved_solo'].includes(enriched.disposition) && !identityDecision.ok) {
        enriched.disposition = 'needs_review';
        enriched.inboxType = 'direct_candidate';
        enriched.soloEvidence = false;
        enriched.verificationAssessment = { status: identityDecision.status, reasons: identityDecision.reasons };
      }
      return enriched;
    });
    const partial = pageErrors.length > 0 || robotsSkipped > 0 || pageLimitReached;
    const aboutSectionStatus = aboutPagesVisited.length ? 'visited' : groupPracticeDetected ? 'skipped_group_practice' : aboutDiscoveredUrls.size && personalEmailAndNamedPractitionerFound ? 'not_reached' : aboutDiscoveredUrls.size ? 'deferred_until_personal_practitioner_found' : 'not_found';
    const lastError = [pageErrors.length ? `${pageErrors.length} page(s) could not be read: ${pageErrors.slice(0, 3).join(' | ')}` : '', robotsSkipped ? `${robotsSkipped} candidate page(s) were disallowed by robots.txt and were not visited.` : '', pageLimitReached ? `Page limit reached with additional same-site pages still queued.` : '', aboutSectionStatus === 'not_reached' ? 'An About/bio page was found but not reached within the page limit.' : ''].filter(Boolean).join(' ');
    return { ...row, status: partial ? 'partial' : candidates.size ? 'review' : 'complete_no_email', pagesVisited: [...visited], aboutPagesDiscovered: aboutDiscoveredUrls.size, aboutPagesVisited, aboutSectionStatus, professionalDescription, professionalDescriptionUrl, professionalDescriptionSource, pageLimitReached, candidates: enrichedCandidates, practitionerNames: [...peopleFound.values()], lastError };
  } finally { await context.close().catch(() => {}); }
}
function therapistNameAppearsOnPage(name, text, url = '', headings = [], title = '') {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const core = therapistSearchNameCore(name);
  const wanted = normalize(core);
  const pageText = ` ${normalize(text)} `;
  const tokens = wanted.split(' ').filter(Boolean);
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.length < 3) return false;
    const headingAndTitle = ` ${normalize(`${title} ${(headings || []).join(' ')}`)} `;
    const normalizedUrl = ` ${normalize(url.replace(/[-_]/g, ' '))} `;
    const credentialNearName = new RegExp(`\\b${token}\\b.{0,100}\\b(?:therapist|psychotherapist|counsell?or|psychologist|clinician|LCSW|LMHC|LMFT|LPC|PsyD|PhD)\\b|\\b(?:therapist|psychotherapist|counsell?or|psychologist|clinician|LCSW|LMHC|LMFT|LPC|PsyD|PhD)\\b.{0,100}\\b${token}\\b`, 'i');
    return headingAndTitle.includes(` ${token} `) || normalizedUrl.includes(` ${token} `) || credentialNearName.test(text);
  }
  return wanted.length >= 5 && pageText.includes(` ${wanted} `);
}
function unwrapGoogleResultUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'google.com' || parsed.hostname.endsWith('.google.com')) {
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (target) return new URL(target, parsed.origin).href;
    }
    return parsed.href;
  } catch { return ''; }
}
function namedTherapistCandidates(row) {
  const names = new Map();
  if (isPlausiblePractitionerName(row.name)) names.set(normalizeTherapistPersonName(row.name), row.name.trim());
  for (const person of row.practitionerNames || []) if (isPlausiblePractitionerName(person.name)) names.set(normalizeTherapistPersonName(person.name), person.name.trim());
  for (const candidate of row.candidates || []) if (isPlausiblePractitionerName(candidate.practitionerName)) names.set(normalizeTherapistPersonName(candidate.practitionerName), candidate.practitionerName.trim());
  return names;
}
function therapistNamesMissingContext(row) {
  const names = namedTherapistCandidates(row);
  return [...names.entries()].filter(([key]) => {
    const personCandidates = (row.candidates || []).filter(candidate => normalizeTherapistPersonName(candidate.practitionerName) === key);
    const personContext = personCandidates.some(candidate => candidate.practitionerBio || candidate.practitionerProfileExcerpt || candidate.aboutEvidence);
    const singlePersonContext = names.size === 1 && Boolean(row.professionalDescription || personCandidates.some(candidate => candidate.professionalDescription));
    const priorProfile = [...(row.profileEnrichments || [])].reverse().find(item => normalizeTherapistPersonName(item.practitionerName) === key);
    const alreadySearched = priorProfile?.reviewMethod === 'playwright_site_name_search_v3'
      && ['confirmed_public_profile','no_match','ambiguous_unresolved','blocked','robots_disallowed'].includes(priorProfile.identityStatus);
    return !personContext && !singlePersonContext && !alreadySearched;
  });
}
function rowNeedsGenericEmailProfileSearch(row) {
  return (row.candidates || []).some(candidate => isSharedInbox(candidate.email)) && therapistNamesMissingContext(row).length > 0;
}
async function searchTherapistProfileFallback(row, job, options) {
  const names = namedTherapistCandidates(row);
  if (!names.size) return { ...row, profileSearchStatus: 'skipped_no_named_therapist' };

  // A general site snippet is not automatically a bio for every person on a
  // multi-clinician page. Search each named person whose own context is absent.
  const namesToSearch = new Map(therapistNamesMissingContext(row));
  if (!namesToSearch.size) return { ...row, profileSearchStatus: 'existing_named_context_found' };

  const enrichments = Array.isArray(row.profileEnrichments) ? [...row.profileEnrichments] : [];
  const existingByName = new Map(enrichments.map(item => [normalizeTherapistPersonName(item.practitionerName), item]));
  const browser = await getTherapistBrowser();
  const context = await browser.newContext({ javaScriptEnabled: true, acceptDownloads: false });
  const page = await context.newPage();
  const timeout = Math.max(5000, Math.min(12000, Number(options.timeoutSeconds) * 1000 || 10000));
  page.setDefaultNavigationTimeout(timeout);
  page.setDefaultTimeout(Math.min(timeout, 8000));
  const safeHosts = new Set();
  await page.route('**/*', async route => {
    try {
      const raw = route.request().url();
      if (/^(?:data|blob|about):/i.test(raw)) return route.continue();
      const target = new URL(raw);
      if (!['http:', 'https:'].includes(target.protocol)) return route.abort();
      if (!safeHosts.has(target.hostname)) {
        assertSafeHost(target.hostname);
        await resolvePublic(target.hostname);
        safeHosts.add(target.hostname);
      }
      return route.continue();
    } catch { return route.abort(); }
  });
  const attemptedUrls = [];
  const results = [];
  let searchBlocked = '';
  const city = String(row.city || '').replace(/\s+/g, ' ').trim();
  try {
    for (const [key, practitionerName] of [...namesToSearch.entries()].slice(0, 3)) {
      await waitJob(job);
      const prior = existingByName.get(key);
      if (prior?.identityStatus === 'confirmed_public_profile') continue;
      if (prior?.reviewMethod === 'playwright_ddg_fallback' && ['no_match','ambiguous_unresolved','blocked','robots_disallowed'].includes(prior.identityStatus)) continue;

      const searchQuery = `"${practitionerName}" therapist${city ? ` "${city}"` : ''}`;
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      let searchRules;
      try { searchRules = await getRobots('https://html.duckduckgo.com', job); }
      catch (error) { searchBlocked = `DuckDuckGo search unavailable: ${String(error.message || error).slice(0, 160)}`; break; }
      if (!allowedByRobots(searchUrl, searchRules)) {
        searchBlocked = 'DuckDuckGo robots.txt disallows the search results path; no automated search was made.';
        const item = { practitionerName, searchQuery, searchUrl, searchResultsReviewed: 0, identityStatus: 'robots_disallowed', publicDetails: '', sourceUrl: '', sourceUrlsReviewed: [], reviewNote: searchBlocked, reviewedAt: new Date().toISOString(), reviewMethod: 'playwright_ddg_fallback' };
        enrichments.push(item); existingByName.set(key, item); break;
      }

      try {
        await delayHost('html.duckduckgo.com', Math.max(2, Number(options.delaySeconds) || 1, searchRules.delay), job);
        const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
        if (!response || [403, 429, 503].includes(response.status())) {
          searchBlocked = `DuckDuckGo search stopped on HTTP ${response?.status() || 'no response'}; no retries were made.`;
          break;
        }
        if (response.status() < 200 || response.status() >= 400) {
          searchBlocked = `DuckDuckGo search returned HTTP ${response.status()}; no retries were made.`;
          break;
        }
        const searchText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        if (/unusual traffic|automated queries|captcha|sorry\/|our systems have detected|anomaly modal/i.test(searchText.slice(0, 14000))) {
          searchBlocked = 'DuckDuckGo showed an automation challenge; search stopped without retrying or bypassing it.';
          break;
        }
        const resultLinks = await page.locator('a.result__a').evaluateAll(anchors => anchors.flatMap(anchor => {
          const href = anchor.href || '';
          const title = (anchor.innerText || '').trim();
          const container = anchor.closest('.result') || anchor.parentElement?.parentElement;
          const snippet = (container?.querySelector('.result__snippet')?.innerText || container?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900);
          return title && href ? [{ href, title, snippet }] : [];
        }));
        const uniqueResults = [];
        const seenResultUrls = new Set();
        for (const result of resultLinks) {
          let href = unwrapGoogleResultUrl(result.href);
          let parsed;
          try { parsed = new URL(href); } catch { continue; }
          if (parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com')) {
            const target = parsed.searchParams.get('uddg');
            if (target) { try { href = new URL(target).href; parsed = new URL(href); } catch { continue; } }
          }
          if (!['http:', 'https:'].includes(parsed.protocol) || /(^|\.)duckduckgo\./i.test(parsed.hostname)) continue;
          // Preserve query parameters: therapist directories often identify a
          // clinician with a URL such as /therapist/?id=123.
          parsed.hash = '';
          const canonical = parsed.href;
          if (seenResultUrls.has(canonical)) continue;
          seenResultUrls.add(canonical);
          uniqueResults.push({ ...result, href: canonical });
          if (uniqueResults.length >= 5) break;
        }
        const reviewed = [];
        let matched = null;
        for (const result of uniqueResults) {
          await waitJob(job);
          let target;
          try { target = new URL(result.href); assertSafeHost(target.hostname); await resolvePublic(target.hostname); }
          catch { reviewed.push({ url: result.href, status: 'unsafe_or_unresolvable_host' }); continue; }
          let rules;
          try { rules = await getRobots(target.origin, job); }
          catch { reviewed.push({ url: result.href, status: 'robots_unavailable' }); continue; }
          if (!allowedByRobots(result.href, rules)) { reviewed.push({ url: result.href, status: 'robots_disallowed' }); continue; }
          try {
            await delayHost(target.hostname, Math.max(1, Number(options.delaySeconds) || 1, rules.delay), job);
            const profileResponse = await page.goto(result.href, { waitUntil: 'domcontentloaded', timeout });
            if (!profileResponse || [403, 429, 503].includes(profileResponse.status())) {
              reviewed.push({ url: result.href, status: `http_${profileResponse?.status() || 'no_response'}` });
              continue;
            }
            if (profileResponse.status() < 200 || profileResponse.status() >= 400) { reviewed.push({ url: result.href, status: `http_${profileResponse.status()}` }); continue; }
            const body = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 50000);
            if (/captcha|unusual traffic|automated queries|access denied|request blocked/i.test(body.slice(0, 10000))) { reviewed.push({ url: result.href, status: 'access_challenge' }); continue; }
            const title = await page.title().catch(() => '');
            const headings = await page.locator('h1,h2,h3,h4').allInnerTexts().catch(() => []);
            const metaDescription = await page.locator('meta[name="description"],meta[property="og:description"]').first().getAttribute('content').catch(() => '') || '';
            const evidenceText = `${title} ${headings.join(' ')} ${body} ${metaDescription}`;
            const exactName = therapistNameAppearsOnPage(practitionerName, evidenceText);
            const professionalEvidence = extractProfessionalDescription(body, headings, result.href, metaDescription, practitionerName);
            if (exactName && professionalEvidence) {
              matched = { url: result.href, details: professionalEvidence.excerpt, source: professionalEvidence.source, title };
              reviewed.push({ url: result.href, status: 'named_professional_match' });
              break;
            }
            reviewed.push({ url: result.href, status: exactName ? 'name_found_but_no_professional_context' : 'name_not_confirmed' });
          } catch (error) {
            if (/Stopped by user/.test(String(error.message || error))) throw error;
            reviewed.push({ url: result.href, status: 'page_unavailable' });
          }
        }
        const item = {
          practitionerName, searchQuery, searchUrl,
          searchResultCount: uniqueResults.length,
          searchResultsReviewed: reviewed.length,
          identityStatus: matched ? 'confirmed_public_profile' : 'no_match',
          publicDetails: matched?.details || '', sourceUrl: matched?.url || '',
          publicContextSource: matched?.source || '', sourceUrlsReviewed: reviewed,
          reviewNote: matched ? 'Exact therapist name and professional context were found on this public result page. Search-result snippets were used only to find the page.' : searchBlocked || 'No matching public professional page was confirmed in the first five search results.',
          reviewedAt: new Date().toISOString(), reviewMethod: 'playwright_google_fallback'
        };
        item.reviewMethod = 'playwright_ddg_fallback';
        enrichments.push(item); existingByName.set(key, item);
        attemptedUrls.push(...reviewed.map(entry => entry.url));
        results.push(item);
      } catch (error) {
        if (/Stopped by user/.test(String(error.message || error))) throw error;
        searchBlocked = String(error.message || error).slice(0, 200);
      }
      if (searchBlocked) break;
    }
  } finally { await context.close().catch(() => {}); }

  const confirmed = enrichments.filter(item => ['playwright_google_fallback','playwright_ddg_fallback'].includes(item.reviewMethod)
    && item.identityStatus === 'confirmed_public_profile'
    && namesToSearch.has(normalizeTherapistPersonName(item.practitionerName)));
  const singlePerson = confirmed.length === 1 && namesToSearch.size === 1;
  return {
    ...row,
    profileEnrichments: enrichments,
    profileSearchStatus: confirmed.length ? 'matched_public_profile' : searchBlocked ? 'search_blocked_or_unavailable' : results.length ? 'no_match_in_first_five_results' : 'already_checked_or_no_results',
    profileSearchError: searchBlocked,
    profileSearchUrlsReviewed: [...new Set([...(row.profileSearchUrlsReviewed || []), ...attemptedUrls])].slice(0, 30),
    ...(singlePerson ? {
      professionalDescription: row.professionalDescription || confirmed[0].publicDetails,
      professionalDescriptionUrl: row.professionalDescriptionUrl || confirmed[0].sourceUrl,
      professionalDescriptionSource: row.professionalDescriptionSource || `google_result_${confirmed[0].publicContextSource || 'public_profile'}`
    } : {})
  };
}
async function searchTherapistProfileOnSavedSites(row, job, options) {
  const namesToSearch = new Map(therapistNamesMissingContext(row));
  if (!namesToSearch.size) return { ...row, profileSearchStatus: 'skipped_no_named_therapist' };
  let start;
  try {
    const practice = new URL(row.website);
    let preferred = null;
    try { preferred = row.sourceUrl ? new URL(row.sourceUrl, practice) : null; } catch { }
    start = preferred && (sameWebsiteHost(preferred.href, practice.href) || allowedProfessionalDirectory(preferred.href)) ? preferred : practice;
    assertSafeHost(start.hostname); await resolvePublic(start.hostname);
  }
  catch (error) { return { ...row, profileSearchStatus: 'site_unavailable', profileSearchError: String(error.message || error).slice(0, 180) }; }
  const origin = start.origin;
  let siteRules;
  try { siteRules = await getRobots(origin, job); }
  catch (error) { return { ...row, profileSearchStatus: 'search_blocked_or_unavailable', profileSearchError: `Practice-site robots rules unavailable: ${String(error.message || error).slice(0, 150)}` }; }
  if (!allowedByRobots(start.href, siteRules)) return { ...row, profileSearchStatus: 'search_blocked_or_unavailable', profileSearchError: 'Practice-site robots.txt disallows its supplied home page.' };

  const enrichments = Array.isArray(row.profileEnrichments) ? [...row.profileEnrichments] : [];
  const browser = await getTherapistBrowser();
  const context = await browser.newContext({ javaScriptEnabled: true, acceptDownloads: false });
  const page = await context.newPage();
  const timeout = Math.max(5000, Math.min(25000, Number(options.timeoutSeconds) * 1000 || 15000));
  page.setDefaultNavigationTimeout(timeout);
  page.setDefaultTimeout(Math.min(timeout, 8000));
  const safeHosts = new Set();
  let currentOrigin = origin;
  await page.route('**/*', async route => {
    try {
      const raw = route.request().url();
      if (/^(?:data|blob|about):/i.test(raw)) return route.continue();
      const target = new URL(raw);
      if (!['http:', 'https:'].includes(target.protocol)) return route.abort();
      if (target.origin !== origin && !sameWebsiteHost(raw, origin) && target.origin !== currentOrigin && !sameWebsiteHost(raw, currentOrigin) && !allowedProfessionalDirectory(raw)) return route.abort();
      if (!safeHosts.has(target.hostname)) { assertSafeHost(target.hostname); await resolvePublic(target.hostname); safeHosts.add(target.hostname); }
      return route.continue();
    } catch { return route.abort(); }
  });

  const attempted = [];
  const confirmed = [];
  const failures = [];
  const city = String(row.city || '').replace(/\s+/g, ' ').trim();
  try {
    await waitJob(job);
    await delayHost(start.hostname, Math.max(1, Number(options.delaySeconds) || 1, siteRules.delay), job);
    const home = await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout });
    if (!home || [403, 429, 503].includes(home.status())) throw new Error(`Practice site returned HTTP ${home?.status() || 'no response'}; stopped without retry.`);
    if (home.status() < 200 || home.status() >= 400) throw new Error(`Practice site returned HTTP ${home.status()}; stopped without retry.`);
    const homeBody = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 50000);
    if (/captcha|unusual traffic|automated queries|access denied|request blocked|confirm .*human/i.test(homeBody.slice(0, 10000))) throw new Error('Practice site presented an access challenge; stopped without retry.');
    const anchors = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => ({
      href: node.href || '', text: `${node.innerText || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.replace(/\s+/g, ' ').trim()
    })).filter(item => item.href));
    const sitemap = await sitemapCandidates(origin, siteRules, job);
    const pages = new Map();
    const addPage = (url, label = '') => {
      try {
        const target = new URL(url, start.href);
        if (!['http:', 'https:'].includes(target.protocol) || (target.origin !== origin && !sameWebsiteHost(target.href, origin) && !allowedProfessionalDirectory(target.href))) return;
        target.hash = '';
        const canonical = target.href;
        const searchable = `${canonical} ${label}`.toLocaleLowerCase();
        const nameHit = [...namesToSearch.values()].some(name => {
          const tokens = normalizeTherapistPersonName(name).split(/\s+/).filter(token => token.length > 2);
          return tokens.length >= 2 && tokens.every(token => searchable.includes(token));
        });
        const profilePath = /about|bio|team|staff|people|therap|clinician|provider|psycholog|counsell|profile|practitioner|directory|meet/i.test(`${target.pathname} ${label}`);
        if (canonical !== canonicalTherapistUrl(start.href) && !nameHit && !profilePath) return;
        const priority = (nameHit ? 20 : 0) + therapistPagePriority(canonical) + (profilePath ? 3 : 0);
        if (!pages.has(canonical) || pages.get(canonical).priority < priority) pages.set(canonical, { url: canonical, priority });
      } catch { }
    };
    for (const item of anchors) addPage(item.href, item.text);
    for (const url of sitemap) addPage(url, 'sitemap');
    // Visit the existing practice home page plus the best-linked person/about/team pages.
    // External profile sites are considered only if the practice page links to them.
    const pageQueue = [{ url: start.href, priority: 1 }, ...[...pages.values()].sort((a, b) => b.priority - a.priority).slice(0, 24)];

    const targets = [...namesToSearch.entries()].slice(0, 3).filter(([key]) => {
      const prior = [...enrichments].reverse().find(item => normalizeTherapistPersonName(item.practitionerName) === key && item.reviewMethod === 'playwright_site_name_search_v3');
      return !prior || !['confirmed_public_profile','no_match','ambiguous_unresolved','blocked','robots_disallowed'].includes(prior.identityStatus);
    });
    const matches = new Map();
    const reviewedByName = new Map(targets.map(([key]) => [key, []]));
    const pageLimit = pageQueue.slice(0, 5);
    for (const target of pageLimit) {
      if (matches.size === targets.length) break;
      await waitJob(job);
      let targetUrl;
      try { targetUrl = new URL(target.url); } catch { continue; }
      const external = !sameWebsiteHost(targetUrl.href, origin);
      let rules = siteRules;
      if (external) {
        if (!allowedProfessionalDirectory(targetUrl.href)) continue;
        try { rules = await getRobots(targetUrl.origin, job); } catch { for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: 'robots_unavailable' }); continue; }
      }
      if (!allowedByRobots(target.url, rules)) { for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: 'robots_disallowed' }); continue; }
      try {
        currentOrigin = targetUrl.origin;
        await delayHost(targetUrl.hostname, Math.max(1, Number(options.delaySeconds) || 2, rules.delay), job);
        const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout });
        if (!response || [403, 429, 503].includes(response.status())) { for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: `http_${response?.status() || 'no_response'}` }); continue; }
        if (response.status() < 200 || response.status() >= 400) { for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: `http_${response.status()}` }); continue; }
        if (!sameWebsiteHost(page.url(), target.url) && !allowedProfessionalDirectory(page.url())) { for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: 'redirected_outside_linked_profile' }); continue; }
        const body = (await page.locator('body').innerText({ timeout: 4000 }).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 50000);
        if (/captcha|unusual traffic|automated queries|access denied|request blocked|confirm .*human/i.test(body.slice(0, 10000))) { for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: 'access_challenge' }); failures.push('A linked page presented an access challenge; it was skipped.'); continue; }
        const title = await page.title().catch(() => '');
        const headings = await page.locator('h1,h2,h3,h4').allInnerTexts().catch(() => []);
        const meta = await page.locator('meta[name="description"],meta[property="og:description"]').first().getAttribute('content').catch(() => '') || '';
        const evidenceText = `${title} ${headings.join(' ')} ${body} ${meta}`;
        for (const [key, practitionerName] of targets) {
          if (matches.has(key)) continue;
          const exactName = therapistNameAppearsOnPage(practitionerName, evidenceText, target.url, headings, title);
          const professional = exactName ? extractProfessionalDescription(body, headings, target.url, meta, practitionerName) : null;
          if (professional?.excerpt) {
            matches.set(key, { practitionerName, details: professional.excerpt, url: target.url, source: professional.source });
            reviewedByName.get(key).push({ url: target.url, status: 'named_professional_match' });
          } else reviewedByName.get(key).push({ url: target.url, status: exactName ? 'name_found_but_no_professional_context' : 'name_not_confirmed' });
        }
        attempted.push(target.url);
      } catch (error) {
        if (/Stopped by user/.test(String(error.message || error))) throw error;
        for (const [key] of targets) reviewedByName.get(key).push({ url: target.url, status: 'page_unavailable' });
      }
    }
    for (const [key, practitionerName] of targets) {
      const match = matches.get(key);
      const reviewed = reviewedByName.get(key) || [];
      const searchQuery = `search saved practice site and linked pages for "${practitionerName}"${city ? ` in ${city}` : ''}`;
      const item = {
        practitionerName, searchQuery, searchUrl: start.href, searchResultCount: pageLimit.length,
        searchResultsReviewed: new Set(reviewed.map(entry => entry.url)).size, identityStatus: match ? 'confirmed_public_profile' : 'no_match',
        publicDetails: match?.details || '', sourceUrl: match?.url || '', publicContextSource: match?.source || '',
        sourceUrlsReviewed: reviewed,
        reviewNote: match ? 'Named clinician and professional context were found on the supplied practice site or a profile linked from it.' : 'No named professional context was confirmed on the practice site or its first five relevant linked pages.',
        reviewedAt: new Date().toISOString(), reviewMethod: 'playwright_site_name_search_v3'
      };
      enrichments.push(item);
      if (match) confirmed.push(item);
      attempted.push(...reviewed.map(entry => entry.url));
    }
  } catch (error) {
    if (/Stopped by user/.test(String(error.message || error))) throw error;
    failures.push(String(error.message || error).slice(0, 180));
  } finally { currentOrigin = origin; await context.close().catch(() => {}); }

  const singlePerson = confirmed.length === 1 && namesToSearch.size === 1;
  return {
    ...row, profileEnrichments: enrichments,
    profileSearchStatus: confirmed.length ? 'matched_public_profile' : failures.length ? 'search_blocked_or_unavailable' : 'no_match_in_first_five_results',
    profileSearchError: failures.join(' ').slice(0, 400),
    profileSearchUrlsReviewed: [...new Set([...(row.profileSearchUrlsReviewed || []), ...attempted])].slice(0, 40),
    ...(singlePerson ? { professionalDescription: row.professionalDescription || confirmed[0].publicDetails, professionalDescriptionUrl: row.professionalDescriptionUrl || confirmed[0].sourceUrl, professionalDescriptionSource: row.professionalDescriptionSource || `linked_practice_profile_${confirmed[0].publicContextSource || 'public_profile'}` } : {})
  };
}
async function runExistingGenericProfileSearch(rowIds, job, options, includeAllNamedContacts = false) {
  const selected = rowIds.map(id => therapistRows.get(id)).filter(row => row && (includeAllNamedContacts
    ? row.website && therapistNamesMissingContext(row).length > 0
    : rowNeedsGenericEmailProfileSearch(row)));
  if (!selected.length) throw new Error(includeAllNamedContacts
    ? 'No imported contacts with a named therapist, saved practice website, and missing profile context were found.'
    : 'No existing generic-email rows with a named therapist and missing professional context were found.');
  job.audit ||= {};
  job.audit.query = includeAllNamedContacts ? 'Imported named therapist contacts missing profile context' : 'Existing generic-email rows missing therapist context';
  job.audit.rowIds = selected.map(row => row.id);
  job.runConfig = { concurrency: options.concurrency, delaySeconds: options.delaySeconds, profileSearchFallback: true, websiteRecrawl: false, includeAllNamedContacts };
  let next = 0;
  let done = 0;
  const concurrency = Math.max(1, Math.min(6, options.concurrency));
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      await waitJob(job);
      const row = selected[next++];
      const updated = await searchTherapistProfileOnSavedSites(row, job, options);
      updated.profileEnrichmentRunId = job.id;
      await saveTherapistRow(updated);
      await appendAudit({ event: includeAllNamedContacts ? 'therapist_imported_contact_profile_search' : 'therapist_existing_profile_search', jobId: job.id, rowId: row.id, sourceFile: row.sourceFile || '', sourceRow: row.sourceRow || 0, city: row.city || '', status: updated.profileSearchStatus || '', profileSearchError: updated.profileSearchError || '', policyVersion: POLICY_VERSION, rag: therapistRagContext('saved therapist contact profile context search public bio Playwright') });
      done++;
      const matched = selected.filter(item => therapistRows.get(item.id)?.profileSearchStatus === 'matched_public_profile').length;
      progress(job, Math.round((done / selected.length) * 100), 'Playwright therapist profile search', `Checked ${done} of ${selected.length} saved rows; ${matched} now have a matched public-profile snippet.`);
    }
  }));
  return selected.map(row => therapistRows.get(row.id));
}
async function runTherapistResearch(payload, job) {
  const retryFailures = Boolean(payload.retryFailures);
  const deepenExisting = Boolean(payload.deepenExisting);
  const requestedRowIds = Array.isArray(payload.rowIds) && payload.rowIds.length ? new Set(payload.rowIds.map(String)) : null;
  const selected = [...therapistRows.values()].filter(row => {
    if (requestedRowIds) return requestedRowIds.has(row.id);
    if (row.status === 'pending' || (retryFailures && row.status === 'failed')) return true;
    if (!deepenExisting) return row.status === 'partial';
    const hasProfessionalDescription = Boolean(row.professionalDescription || row.candidates?.some(candidate => candidate.professionalDescription));
    const alreadyHasAbout = row.aboutSectionStatus === 'visited' && row.candidates?.some(candidate => candidate.aboutEvidence);
    const groupSkipped = row.aboutSectionStatus === 'skipped_group_practice';
    const hasUnverifiedCandidate = row.candidates?.some(candidate => !isApprovedPersonalDirect(candidate, row)
      && !['excluded','excluded_suggested','unresolved'].includes(candidate.disposition)
      && candidate.inboxType !== 'shared_or_role_inbox');
    const missingContext = !hasProfessionalDescription && !alreadyHasAbout;
    return ['partial','review','complete_no_email'].includes(row.status) && !groupSkipped && (hasUnverifiedCandidate || missingContext);
  });
  if (!selected.length) throw new Error('No pending therapist rows. Import a CSV or enable retry for failed rows.');
  const concurrency = Math.max(1, Math.min(6, Number(payload.concurrency) || 2));
  const settings = { pagesPerSite: Math.max(1, Math.min(20, Number(payload.pagesPerSite) || 12)), concurrency, delaySeconds: Math.max(1, Math.min(60, Number(payload.delaySeconds) || 1)), profileSearchFallback: payload.profileSearchFallback !== false };
  job.audit ||= {};
  job.runConfig = settings;
  job.audit.config = settings;
  job.audit.rowIds = selected.map(row => row.id);
  let next = 0; let done = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      await waitJob(job);
      const index = next++;
      const input = { ...selected[index], candidates: (selected[index].candidates || []).map(candidate => candidate.disposition === 'unresolved' ? { ...candidate, disposition: 'needs_review' } : candidate) };
      let result = await researchTherapistLead(input, job, settings).catch(error => ({ ...input, status: /Stopped by user/.test(error.message) ? 'pending' : 'failed', lastError: error.message }));
      if (settings.profileSearchFallback && !job.stopped) {
        progress(job, Math.round(done / selected.length * 100), 'Playwright therapist name search', 'When context is missing, checking up to five relevant pages linked from the saved practice website.');
        result = await searchTherapistProfileOnSavedSites(result, job, settings).catch(error => {
          if (/Stopped by user/.test(error.message)) return { ...result, status: 'pending', lastError: '' };
          return { ...result, profileSearchStatus: 'search_failed', profileSearchError: String(error.message || error).slice(0, 200) };
        });
      }
      const latestProfiles = therapistRows.get(input.id)?.profileEnrichments || [];
      if (latestProfiles.length) {
        result.profileEnrichments = Array.isArray(result.profileEnrichments) ? result.profileEnrichments : [];
        for (const enrichment of latestProfiles) {
          const profileIndex = result.profileEnrichments.findIndex(item => normalizeTherapistPersonName(item.practitionerName) === normalizeTherapistPersonName(enrichment.practitionerName));
          if (profileIndex >= 0) result.profileEnrichments[profileIndex] = enrichment;
          else result.profileEnrichments.push(enrichment);
        }
      }
      result.lastRunId = job.id;
      if (result.status !== 'pending') await saveTherapistRow(result);
      done++;
      progress(job, Math.round(done / selected.length * 100), 'Playwright website research', `Researched ${done} of ${selected.length} lead websites; ${[...therapistRows.values()].filter(row => row.candidates?.length).length} rows have email candidates.`);
    }
  }));
  return selected.map(row => therapistRows.get(row.id)).filter(Boolean);
}
async function runSharedTherapistResearch(payload, job) {
  if (!sharedLeadQueue.connected()) throw new Error('Sign in to the shared Supabase queue first.');
  const concurrency = Math.max(1, Math.min(6, Number(payload.concurrency) || 2));
  const settings = { pagesPerSite: Math.max(1, Math.min(20, Number(payload.pagesPerSite) || 12)), concurrency, delaySeconds: Math.max(1, Math.min(60, Number(payload.delaySeconds) || 1)), profileSearchFallback: payload.profileSearchFallback !== false };
  job.runConfig = settings; job.audit ||= {}; job.audit.sharedQueue = true;
  let claimed = 0; let done = 0; let exhausted = false;
  const touchedRows = new Map();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!job.stopped) {
      await waitJob(job);
      if (exhausted) return;
      const lease = await sharedLeadQueue.claim();
      if (!lease) { exhausted = true; return; }
      claimed++;
      const input = lease.payload;
      if (!input?.id || !input?.sourceIdentity || input.status !== 'pending' || !input.website) {
        await sharedLeadQueue.release(lease);
        continue;
      }
      let leaseLost = false;
      const renewTimer = setInterval(async () => {
        try {
          if (!await sharedLeadQueue.renew(lease)) throw new Error('Lease no longer belongs to this computer.');
        } catch {
          leaseLost = true; job.stopped = true; job.paused = false;
          job.error = 'Lost connection to the shared queue. This lead was not marked complete and will be available again after its lease expires.';
          job.controller.abort();
        }
      }, 60_000);
      renewTimer.unref?.();
      try {
        const normalizedInput = { ...input, candidates: (input.candidates || []).map(candidate => candidate.disposition === 'unresolved' ? { ...candidate, disposition: 'needs_review' } : candidate) };
        let result = await researchTherapistLead(normalizedInput, job, settings).catch(error => ({ ...normalizedInput, status: /Stopped by user/.test(error.message) ? 'pending' : 'failed', lastError: error.message }));
        if (settings.profileSearchFallback && !job.stopped) {
          progress(job, done ? Math.floor(done / Math.max(claimed, done + 1) * 99) : 1, 'Playwright therapist name search', 'Checking the claimed website and relevant public therapist pages.');
          result = await searchTherapistProfileOnSavedSites(result, job, settings).catch(error => /Stopped by user/.test(error.message) ? { ...result, status: 'pending', lastError: '' } : { ...result, profileSearchStatus: 'search_failed', profileSearchError: String(error.message || error).slice(0, 200) });
        }
        const latestProfiles = therapistRows.get(input.id)?.profileEnrichments || [];
        if (latestProfiles.length) {
          result.profileEnrichments = Array.isArray(result.profileEnrichments) ? result.profileEnrichments : [];
          for (const enrichment of latestProfiles) {
            const profileIndex = result.profileEnrichments.findIndex(item => normalizeTherapistPersonName(item.practitionerName) === normalizeTherapistPersonName(enrichment.practitionerName));
            if (profileIndex >= 0) result.profileEnrichments[profileIndex] = enrichment; else result.profileEnrichments.push(enrichment);
          }
        }
        result.lastRunId = job.id;
        if (job.stopped || leaseLost || result.status === 'pending') {
          if (!leaseLost) await sharedLeadQueue.release(lease);
          if (!job.stopped && result.status === 'pending') { await saveTherapistRow(result); touchedRows.set(result.id, result); }
          if (job.stopped) return;
          continue;
        }
        if (!await sharedLeadQueue.complete(lease, result)) {
          job.stopped = true; job.error = 'The shared lease expired before saving this lead. It was not marked complete; sync and retry it after checking its status.';
          job.paused = false; job.controller.abort();
          return;
        }
        await saveTherapistRow(result); touchedRows.set(result.id, result);
        done++;
        progress(job, Math.min(99, done * 3), 'Shared queue research', `Completed ${done} lead(s) on this computer; ${claimed - done} currently leased by this computer. Other computers share the same queue.`);
      } finally { clearInterval(renewTimer); }
    }
  }));
  await syncSharedQueueRows([...therapistRows.values()]);
  if (job.stopped) throw new Error(job.error || 'Stopped by user.');
  const summary = await sharedLeadQueue.status();
  progress(job, 99, 'Shared queue', `This run completed ${done} lead(s). Shared queue: ${summary.counts?.pending || 0} waiting, ${summary.counts?.leased || 0} leased, ${summary.counts?.complete || 0} complete.`);
  return [...touchedRows.values()];
}
async function syncSharedQueueRows(rows) {
  const { attempted } = await sharedLeadQueue.enqueueRows(rows);
  return { attempted };
}
async function runDomainEnrich(payload, job) {
  const domains = [...new Set((payload.domains || []).map(value => String(value).trim()).filter(Boolean))].slice(0, MAX_RESULTS);
  if (!domains.length) throw new Error('Provide at least one public business domain.');
  const leads = domains.map((domain, i) => {
    let url; try { url = new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { id: `domain-${i}-${Date.now()}`, name: url.hostname.replace(/^www\./, ''), category: 'Imported website', website: url.href, address: '', emails: [], phones: [], socials: [], sources: ['User-imported domain'], source: 'User-imported domain', score: 5, score_reasons: [] };
  }).filter(Boolean);
  let done = 0; let next = 0; const concurrency = Math.max(1, Math.min(3, Number(payload.concurrency) || 2));
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, async () => {
    while (next < leads.length) {
      const index = next++; await waitJob(job);
      await crawlWebsite(leads[index], job, payload.pagesPerSite, payload.delay, payload.timeout);
      done++; progress(job, Math.round((done / leads.length) * 95), 'Crawl', `Checked ${done} of ${leads.length} websites.`);
    }
  }));
  return leads;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('Request body is too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('Invalid JSON request.'); }
}
function jobView(job) { return { id: job.id, kind: job.kind, state: job.state, paused: job.paused, progress: job.progress, resultCount: job.state === 'complete' ? job.result?.length || 0 : undefined, error: job.error, warning: job.warning, mapsCoverage: job.mapsCoverage, learningSummary: job.learningSummary }; }
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
async function serveStatic(res, pathname) {
  let name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (name.includes('..') || name.includes('\\') || name.startsWith('.')) { res.writeHead(404); res.end('Not found'); return; }
  const full = path.join(HERE, name);
  try { const data = await fs.readFile(full); res.writeHead(200, { 'Content-Type': contentTypes[path.extname(full)] || 'application/octet-stream', 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(data); }
  catch { res.writeHead(404); res.end('Not found'); }
}
const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) && !/^localhost(?::\d+)?$/i.test(host)) { json(res, 403, { error: 'Local requests only.' }); return; }
  const url = new URL(req.url || '/', `http://${host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, state); return; }
    if (req.method === 'GET' && url.pathname === '/api/shared/status') { json(res, 200, await sharedLeadQueue.status()); return; }
    if (req.method === 'POST' && url.pathname === '/api/shared/config') {
      const payload = await readJson(req);
      json(res, 200, await sharedLeadQueue.configure({ url: payload.url, anonKey: payload.anonKey })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/login') {
      const payload = await readJson(req);
      json(res, 200, await sharedLeadQueue.signIn(payload.email, payload.password)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/worker') {
      const payload = await readJson(req);
      json(res, 200, await sharedLeadQueue.registerWorker(payload.displayName)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/assign') {
      const payload = await readJson(req);
      const assigned = await sharedLeadQueue.assign(payload.workerId, payload.city, payload.limit);
      json(res, 200, { assigned, ...(await sharedLeadQueue.status()) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/logout') {
      await readJson(req); sharedLeadQueue.signOut(); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/sync-local') {
      await readJson(req);
      const { attempted } = await syncSharedQueueRows([...therapistRows.values()]);
      json(res, 200, { attempted, ...(await sharedLeadQueue.status()) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shared/pull-results') {
      await readJson(req);
      const { synced } = await sharedLeadQueue.pullCompleted(saveTherapistRow);
      json(res, 200, { synced, ...(await sharedLeadQueue.status()) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      const payload = await readJson(req);
        if (payload.useGoogleMaps && !String(payload.location || '').trim()) { json(res, 400, { error: 'Enter a city, district, or other target area for Google Maps search.' }); return; }
      if (payload.useGoogleMaps && [...jobs.values()].some(job => job.kind === 'search' && job.audit?.googleMaps && job.state === 'running')) { json(res, 429, { error: 'A Google Maps search is already running. Wait for it to finish before starting another.' }); return; }
      const job = makeJob('search', j => runLiveSearch(payload, j));
      job.audit = { query: String(payload.query || '').slice(0, 200), location: String(payload.location || '').slice(0, 160), googleMaps: Boolean(payload.useGoogleMaps), gl: String(payload.gl || '').slice(0, 2) };
      void appendAudit({ event: 'started', jobId: job.id, ...job.audit }).catch(() => {});
      json(res, 202, jobView(job)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/therapist/import') {
      const payload = await readJson(req);
      if (!Array.isArray(payload.rows)) { json(res, 400, { error: 'Provide a rows array from a CSV file.' }); return; }
      if (payload.rows.length > 100) { json(res, 413, { error: 'Import rows in batches of 100 or fewer.' }); return; }
      const added = [];
      let empty = 0;
      for (let i = 0; i < payload.rows.length; i++) {
        const row = therapistRowFromImport(payload.rows[i], Number(payload.rows[i]?.sourceRow) || (payload.rowOffset ? Number(payload.rowOffset) + i : i + 1), payload.sourceFile);
        if (!row) { empty++; continue; }
        if (therapistRows.has(row.id)) continue;
        added.push(row);
      }
      if (added.length) {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.appendFile(THERAPIST_FILE, added.map(row => JSON.stringify({ at: new Date().toISOString(), row })).join('\n') + '\n', 'utf8');
        for (const row of added) therapistRows.set(row.id, row);
      }
      const batch = { importedAt: new Date().toISOString(), sourceFile: String(payload.sourceFile || 'unnamed-import').slice(0, 240), submittedRows: payload.rows.length, addedRows: added.length, duplicateSourceRows: payload.rows.length - added.length - empty, emptyRows: empty, canonicalLeadKeys: [...new Set(added.map(row => row.canonicalLeadKey))].length };
      if (added.length && sharedLeadQueue.connected()) await sharedLeadQueue.enqueueRows(added);
      therapistRagMemory.importedBatches.unshift(batch);
      therapistRagMemory.importedBatches = therapistRagMemory.importedBatches.slice(0, 200);
      await saveTherapistRagMemory();
      json(res, 200, { added: added.length, skipped: payload.rows.length - added.length, duplicateSourceRows: batch.duplicateSourceRows, emptyRows: empty, uniqueCanonicalLeadsInBatch: batch.canonicalLeadKeys, totalSourceRows: therapistRows.size, rag: therapistRagContext('import source rows duplicates coverage reconciliation') }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/therapist/rag') {
      const query = String(url.searchParams.get('q') || 'therapist email personal direct evidence rows duplicates bio sender').slice(0, 500);
      json(res, 200, { query, memoryPath: THERAPIST_RAG_FILE, ...therapistRagContext(query), importedBatchCount: therapistRagMemory.importedBatches.length }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/therapist/rows') {
      const all = [...therapistRows.values()];
      const statusFilter = String(url.searchParams.get('status') || '');
      const triageInfo = enrichCandidateTriage(all);
      const triageFilter = String(url.searchParams.get('triage') || '');
      const emailStyleFilter = String(url.searchParams.get('emailStyle') || '');
      const statusFiltered = statusFilter ? all.filter(row => row.status === statusFilter) : all;
      const filtered = statusFiltered.filter(row => {
        const candidates = triageInfo.candidatesByRow.get(row.id) || [];
        return (!triageFilter || candidates.some(candidate => candidate.triage?.category === triageFilter))
          && (!emailStyleFilter || candidates.some(candidate => candidate.emailStyle?.category === emailStyleFilter));
      });
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit')) || 150));
      const counts = Object.fromEntries(['pending','researching','review','complete_no_email','partial','failed','blocked','no_website','out_of_scope'].map(status => [status, all.filter(row => row.status === status).length]));
      const approved = new Map();
      const candidateByEmail = new Map();
      const enrichedByEmail = new Map();
      for (const row of all) for (const candidate of triageInfo.candidatesByRow.get(row.id) || []) {
        const current = candidateByEmail.get(candidate.email) || [];
        current.push(candidate);
        candidateByEmail.set(candidate.email, current);
        enrichedByEmail.set(candidate.email, (enrichedByEmail.get(candidate.email) || []).concat(candidate));
        if (isApprovedPersonalDirect(candidate, row)) approved.set(candidate.email, candidate);
      }
      const safeApprovedResult = dedupeApprovedContactPackets(all.flatMap(row => (triageInfo.candidatesByRow.get(row.id) || []).map(candidate => ({ row, candidate }))));
      const safeApprovedContacts = safeApprovedResult.contacts;
      approved.clear();
      for (const item of safeApprovedContacts) approved.set(String(item.candidate.email || '').trim().toLowerCase(), item.candidate);
      const safeApprovedEmails = new Set(approved.keys());
      const unresolvedEvidence = [...candidateByEmail.entries()].filter(([email, items]) => !safeApprovedEmails.has(String(email || '').trim().toLowerCase())
        && !items.every(item => ['excluded','excluded_suggested'].includes(item.disposition) || item.inboxType === 'shared_or_role_inbox')).length;
      const candidateCounts = {
        uniqueCandidates: candidateByEmail.size,
        unresolvedEvidence,
        needsHumanVerification: 0,
        roleOrShared: [...candidateByEmail.values()].filter(items => items.some(item => item.inboxType === 'shared_or_role_inbox')).length,
        personalStyleCandidates: [...enrichedByEmail.values()].filter(items => items.some(item => ['personal_name_style','human_name_shape','personal_username_style'].includes(item.emailStyle?.category))).length,
        personAttributedUnique: [...candidateByEmail.values()].filter(items => items.some(item => isPlausiblePractitionerName(item.practitionerName)
          && item.evidenceUrl && item.emailEvidence && String(item.emailEvidence).toLowerCase().includes(item.email)
          && ['structured_person_email', 'email_and_name_matched_within_profile_card', 'name_and_exact_email_in_public_contact_text'].includes(item.emailAttributionMethod))).length,
        personContextUnique: [...candidateByEmail.values()].filter(items => items.some(item => isPlausiblePractitionerName(item.practitionerName)
          && Boolean(item.practitionerProfileExcerpt || item.practitionerBio || item.professionalDescription))).length,
        approvedUnique: safeApprovedEmails.size,
        approvedPersonalDirectUnique: safeApprovedEmails.size,
        identityConflictEmails: safeApprovedResult.conflicts.length,
        optionalSoloEvidenceUnique: safeApprovedContacts.filter(item => item.candidate.soloEvidence || item.candidate.verification?.soloStatusEvidence).length
      };
      const activeJob = [...jobs.values()].find(job => ['therapist','therapist-profile-enrichment'].includes(job.kind) && job.state === 'running');
      const cityGroups = new Map();
      for (const row of all) {
        const city = canonicalTherapistCity(row.city);
        const group = cityGroups.get(city) || { city, total: 0, researched: 0, pending: 0, partial: 0, blocked: 0, failed: 0, needsEmailReview: 0, approvedUnique: new Set() };
        group.total++;
        if (['review','complete_no_email','no_website'].includes(row.status)) group.researched++;
        if (row.status === 'pending') group.pending++;
        if (row.status === 'partial') group.partial++;
        if (row.status === 'blocked') group.blocked++;
        if (row.status === 'failed') group.failed++;
        if ((row.candidates || []).some(candidate => !isApprovedPersonalDirect(candidate, row) && !['excluded','excluded_suggested','unresolved'].includes(candidate.disposition) && candidate.inboxType !== 'shared_or_role_inbox')) group.needsEmailReview++;
        for (const candidate of row.candidates || []) if (safeApprovedEmails.has(String(candidate.email || '').trim().toLowerCase())) group.approvedUnique.add(candidate.email);
        cityGroups.set(city, group);
      }
      const cityCoverage = EXPECTED_THERAPIST_CITIES.map(city => cityGroups.get(city) || { city, total: 0, researched: 0, pending: 0, partial: 0, blocked: 0, failed: 0, needsEmailReview: 0, approvedUnique: new Set() });
      for (const [city, group] of cityGroups) if (!EXPECTED_THERAPIST_CITIES.includes(city)) cityCoverage.push(group);
      const cleanCities = cityCoverage.map(group => ({ ...group, approvedUnique: group.approvedUnique.size, approvedPersonalDirectUnique: group.approvedUnique.size, researchComplete: group.total > 0 && group.researched === group.total }));
      const newlyApproved = new Set();
      for (const row of all) for (const candidate of row.candidates || []) if (isApprovedPersonalDirect(candidate, row) && Date.parse(candidate.reviewedAt || candidate.verification?.verifiedAt || '') >= Date.now() - 25 * 60 * 1000) newlyApproved.add(candidate.email);
      const coverage = terminalCoverage(all);
      const canonicalGroups = new Map();
      for (const row of all) canonicalGroups.set(row.canonicalLeadKey || row.id, (canonicalGroups.get(row.canonicalLeadKey || row.id) || 0) + 1);
      const duplicateSourceRows = [...canonicalGroups.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
      const rag = therapistRagContext('dashboard counts source row coverage gaps duplicates email approval direct personal email optional solo bio location');
      json(res, 200, { total: all.length, sourceRows: all.length, uniqueCanonicalLeads: canonicalGroups.size, duplicateSourceRows, coverage, filteredTotal: filtered.length, offset, limit, counts, candidateCounts, triageCounts: triageInfo.counts, emailTriageIsNotVerification: true, verificationMode: POLICY_VERSION, approvedUnique: approved.size, approvedPersonalDirectUnique: approved.size, approvedUniqueLast25Minutes: newlyApproved.size, cityCoverage: cleanCities, rag, activeJob: activeJob ? jobView(activeJob) : null, learning: therapistLearning, rows: filtered.slice(offset, offset + limit).map(row => ({ ...row, candidates: triageInfo.candidatesByRow.get(row.id) || [] })) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/therapist/profile-enrichment/start') {
      const payload = await readJson(req);
      if (payload.consent !== true) { json(res, 400, { error: 'Confirm the public-business research notice before searching existing therapist profiles.' }); return; }
      if ([...jobs.values()].some(job => ['therapist','therapist-profile-enrichment'].includes(job.kind) && job.state === 'running')) {
        json(res, 429, { error: 'Another therapist research or profile-enrichment run is active.' }); return;
      }
      const importedContacts = payload.includeAllNamedContacts === true;
      const sourceFile = String(payload.sourceFile || '').trim().slice(0, 240);
      const targetProfileStatus = String(payload.targetProfileStatus || '').trim();
      if (importedContacts && !sourceFile) { json(res, 400, { error: 'sourceFile is required when searching all named imported contacts.' }); return; }
      const selected = [...therapistRows.values()].filter(row => importedContacts
        ? row.sourceFile === sourceFile && row.website && (!targetProfileStatus || row.profileSearchStatus === targetProfileStatus) && therapistNamesMissingContext(row).length > 0
        : rowNeedsGenericEmailProfileSearch(row));
      if (!selected.length) { json(res, 200, { ok: true, targetRows: 0, message: importedContacts ? 'No imported named contacts with saved practice websites and missing profile context need a search.' : 'No saved generic-email rows with a named therapist and missing context need a profile search.' }); return; }
      const options = { concurrency: Math.max(1, Math.min(6, Number(payload.concurrency) || 2)), delaySeconds: Math.max(1, Math.min(60, Number(payload.delaySeconds) || 1)), timeoutSeconds: 10 };
      const rowIds = selected.map(row => row.id);
      const job = makeJob('therapist-profile-enrichment', j => runExistingGenericProfileSearch(rowIds, j, options, importedContacts));
      job.audit = { query: importedContacts ? 'Imported named contacts missing profile context' : 'Existing generic-email rows missing therapist context', location: '', googleMaps: false, rowIds };
      job.ragContext = therapistRagContext('existing saved generic email row missing therapist bio search public profile Playwright');
      void appendAudit({ event: 'started', jobId: job.id, kind: job.kind, queuedRows: rowIds.length, config: options, websiteRecrawl: false, includeAllNamedContacts: importedContacts, sourceFile, rag: job.ragContext }).catch(() => {});
      json(res, 202, { ...jobView(job), targetRows: rowIds.length }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/therapist/start') {
      const payload = await readJson(req);
      if (payload.consent !== true) { json(res, 400, { error: 'Confirm the public-business research guardrail before starting.' }); return; }
      if ([...jobs.values()].some(job => job.kind === 'therapist' && job.state === 'running')) { json(res, 429, { error: 'Therapist research is already running.' }); return; }
      const learned = therapistLearning.nextSettings || {};
      const effectivePayload = {
        ...payload,
        pagesPerSite: Math.max(1, Math.min(20, Number(payload.pagesPerSite) || learned.pagesPerSite || 12)),
        concurrency: Math.max(1, Math.min(6, Number(payload.concurrency) || learned.concurrency || 2)),
        delaySeconds: Math.max(1, Math.min(60, Number(payload.delaySeconds) || learned.delaySeconds || 1))
      };
      if (effectivePayload.useSharedQueue) {
        if (!sharedLeadQueue.connected()) { json(res, 400, { error: 'Connect the Shared queue before starting a shared run.' }); return; }
        await syncSharedQueueRows([...therapistRows.values()]);
      }
      const job = makeJob('therapist', j => effectivePayload.useSharedQueue ? runSharedTherapistResearch(effectivePayload, j) : runTherapistResearch(effectivePayload, j));
      job.audit = { query: 'Therapist email research', location: '', googleMaps: false, sharedQueue: Boolean(effectivePayload.useSharedQueue) };
      job.ragContext = therapistRagContext('harvest exact therapist email named person direct evidence generic inbox about bio solo status rows');
      void appendAudit({ event: 'started', jobId: job.id, kind: 'therapist', queuedRows: job.audit.rowIds?.length || 0, config: job.runConfig, learningBaseline: therapistLearning.runs[0]?.id || null, rag: job.ragContext }).catch(() => {});
      json(res, 202, jobView(job)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/therapist/finalize-assessment') {
      if ([...jobs.values()].some(job => job.kind === 'therapist' && job.state === 'running')) { json(res, 409, { error: 'Wait for therapist research to finish before final assessment.' }); return; }
      let updatedRows = 0;
      for (const row of therapistRows.values()) {
        let changed = false;
        for (const candidate of row.candidates || []) {
          if (isApprovedPersonalDirect(candidate, row) || candidate.inboxType === 'shared_or_role_inbox'
            || ['excluded','excluded_suggested','unresolved'].includes(candidate.disposition)) continue;
          candidate.disposition = 'unresolved';
          candidate.verificationAssessment = {
            status: 'unresolved_after_harvest',
            reasons: [...new Set([...(candidate.verificationAssessment?.reasons || []), 'no_qualifying_evidence_after_harvest'])]
          };
          changed = true;
        }
        if (changed) { await saveTherapistRow(row); updatedRows++; }
      }
      const handoff = await writeEmailSenderHandoff([...therapistRows.values()], `assessment-${Date.now()}`);
      const stats = { rows: therapistRows.size, updatedRows, candidates: [...therapistRows.values()].flatMap(row => row.candidates || []), handoff };
      stats.verifiedUnique = new Set(stats.candidates.filter(isApprovedPersonalDirect).map(candidate => candidate.email)).size;
      stats.unresolvedUnique = new Set(stats.candidates.filter(candidate => candidate.disposition === 'unresolved').map(candidate => candidate.email)).size;
      stats.excludedUnique = new Set(stats.candidates.filter(candidate => ['excluded','excluded_suggested'].includes(candidate.disposition) || candidate.inboxType === 'shared_or_role_inbox').map(candidate => candidate.email)).size;
      delete stats.candidates;
      json(res, 200, stats); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/therapist/review') {
      const payload = await readJson(req);
      const row = therapistRows.get(String(payload.rowId || ''));
      if (!row) { json(res, 404, { error: 'Research row was not found.' }); return; }
      const allowed = new Set(['approved_personal_direct','excluded','unresolved']);
      if (!allowed.has(payload.disposition)) { json(res, 400, { error: 'Choose approve personal direct, exclude, or unresolved.' }); return; }
      const email = String(payload.email || '').trim().toLowerCase();
      const candidate = (row.candidates || []).find(item => item.email === email);
      if (!candidate) { json(res, 404, { error: 'Email candidate was not found on this row.' }); return; }
      if (payload.disposition === 'approved_personal_direct') {
        if (['shared_or_role_inbox'].includes(candidate.inboxType) || isSharedInbox(email)) { json(res, 400, { error: 'Generic/shared role inboxes cannot be approved as personal-direct therapist contacts.' }); return; }
        const verification = payload.verification || {};
        const practitionerName = String(verification.practitionerName || '').replace(/\s+/g, ' ').trim();
        const directContactEvidence = String(verification.directContactEvidence || '').trim().slice(0, 1200);
        const namedPractitionerEvidence = String(verification.namedPractitionerEvidence || '').trim().slice(0, 1200);
        const directEvidenceUrl = String(verification.directEvidenceUrl || '').trim();
        const validName = /^(?:[\p{L}][\p{L}'’.-]*\s+){1,3}[\p{L}][\p{L}'’.-]*$/u.test(practitionerName);
        const validEvidenceUrl = value => {
          try {
            const parsed = new URL(value);
            if (!['http:','https:'].includes(parsed.protocol)) return false;
            if (sameWebsiteHost(row.website, parsed.href) || allowedProfessionalDirectory(parsed.href)) return true;
            // Directory-sourced leads may link to a clinician's own site. Accept that
            // external evidence host only when the saved candidate evidence itself
            // contains the exact URL/host, preserving a traceable source-to-site link.
            const linkedSourceText = `${candidate.emailEvidence || ''} ${candidate.nameEvidence || ''} ${candidate.aboutEvidence || ''} ${candidate.aboutEvidenceUrl || ''}`.toLowerCase();
            const normalizedHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
            return normalizedHost.includes('.') && linkedSourceText.includes(normalizedHost);
          } catch { return false; }
        };
        if (!payload.confirmedDirectMatch || !validName || !directContactEvidence.toLowerCase().includes(email) || !directContactEvidence.toLowerCase().includes(practitionerName.toLowerCase()) || directContactEvidence.length < 20 || namedPractitionerEvidence.length < 8 || !validEvidenceUrl(directEvidenceUrl)) {
          json(res, 400, { error: 'Approval needs a named therapist, one public excerpt connecting that name to this exact email, and the source URL. Solo-practice evidence is optional.' }); return;
        }
        const reviewedVerification = { directContactEvidence, directEvidenceUrl, namedPractitionerEvidence, emailAttributionMethod: 'user_evidence_review', verificationMethod: 'user_evidence_review', soloStatusEvidence: String(verification.soloStatusEvidence || '').trim().slice(0, 1200), soloEvidenceUrl: String(verification.soloEvidenceUrl || '').trim(), verifiedAt: new Date().toISOString() };
        const proposedCandidate = { ...candidate, practitionerName, verification: reviewedVerification };
        const identityRagAssessment = evaluateTherapistContact(proposedCandidate, row);
        if (!identityRagAssessment.ok) {
          json(res, 400, { error: 'The cited evidence did not pass the same-person identity review. Approval requires the exact name and address in one public person record plus person-specific professional context and URL.', identityReview: identityRagAssessment }); return;
        }
        candidate.practitionerName = practitionerName;
        candidate.verification = reviewedVerification;
        candidate.identityRagAssessment = summarizeIdentityRag(identityRagAssessment);
        candidate.soloEvidence = Boolean(candidate.verification.soloStatusEvidence && candidate.verification.soloEvidenceUrl);
      }
      candidate.disposition = payload.disposition;
      candidate.reviewedAt = new Date().toISOString();
      if (payload.disposition === 'approved_personal_direct') candidate.inboxType = 'direct_person_confirmed_by_user';
      await saveTherapistRow(row);
      await appendAudit({ event: 'therapist_email_review', rowId: row.id, email, disposition: payload.disposition, evidenceUrl: candidate.evidenceUrl, verification: payload.disposition === 'approved_personal_direct' ? candidate.verification : undefined, policyVersion: POLICY_VERSION, rag: therapistRagContext('personal direct email named clinician attribution generic inbox optional solo evidence') });
      json(res, 200, { ok: true, row }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/therapist/profile-enrichment') {
      const payload = await readJson(req);
      const row = therapistRows.get(String(payload.rowId || ''));
      if (!row) { json(res, 404, { error: 'Saved therapist row was not found.' }); return; }
      const personName = String(payload.practitionerName || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const requestedKey = normalizeTherapistPersonName(personName);
      const knownNames = [
        ...(isPlausiblePractitionerName(row.name) ? [row.name] : []),
        ...(row.practitionerNames || []).map(person => person.name),
        ...(row.candidates || []).map(candidate => candidate.practitionerName),
        ...(row.profileEnrichments || []).map(item => item.practitionerName)
      ].filter(Boolean);
      if (!isPlausiblePractitionerName(personName) || !knownNames.some(name => normalizeTherapistPersonName(name) === requestedKey)) {
        json(res, 400, { error: 'Profile enrichment is limited to therapist names already identified on this saved row.' }); return;
      }
      const identityStatus = String(payload.identityStatus || '');
      if (!['confirmed_public_profile','ambiguous_unresolved','no_match'].includes(identityStatus)) {
        json(res, 400, { error: 'Choose confirmed profile, ambiguous, or no match.' }); return;
      }
      const resultsReviewed = Number(payload.searchResultsReviewed);
      if (!Number.isInteger(resultsReviewed) || resultsReviewed < 1 || resultsReviewed > 5 || payload.confirmedResultsReviewed !== true) {
        json(res, 400, { error: 'Record a number from 1 to 5 of Google results reviewed before confirming a profile.' }); return;
      }
      const city = String(row.city || '').replace(/\s+/g, ' ').trim();
      const searchQuery = `"${personName}"${city ? ` "${city}"` : ''}`;
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
      const reviewNote = String(payload.reviewNote || '').trim().slice(0, 800);
      let details = '';
      let sourceUrl = '';
      if (identityStatus === 'confirmed_public_profile') {
        details = String(payload.publicDetails || '').trim().slice(0, 3000);
        sourceUrl = String(payload.sourceUrl || '').trim().slice(0, 2048);
        let parsed;
        try { parsed = new URL(sourceUrl); } catch { parsed = null; }
        let publicHost = false;
        try { if (parsed) { assertSafeHost(parsed.hostname); publicHost = true; } } catch { publicHost = false; }
        if (!details || details.length < 10 || !parsed || !['http:','https:'].includes(parsed.protocol)
          || parsed.username || parsed.password || !publicHost) {
          json(res, 400, { error: 'A confirmed profile needs public professional details and an exact HTTP(S) evidence URL.' }); return;
        }
      }
      const enrichment = {
        practitionerName: knownNames.find(name => normalizeTherapistPersonName(name) === requestedKey) || personName,
        searchQuery, searchUrl, searchResultsReviewed: resultsReviewed,
        identityStatus, publicDetails: details, sourceUrl, reviewNote,
        reviewedAt: new Date().toISOString(), reviewMethod: 'manual_google_results_review'
      };
      row.profileEnrichments = Array.isArray(row.profileEnrichments) ? row.profileEnrichments : [];
      const priorIndex = row.profileEnrichments.findIndex(item => normalizeTherapistPersonName(item.practitionerName) === requestedKey);
      if (priorIndex >= 0) row.profileEnrichments[priorIndex] = enrichment;
      else row.profileEnrichments.push(enrichment);
      await saveTherapistRow(row);
      const rag = therapistRagContext('existing therapist name search Google first five results profile enrichment source identity exact URL no new leads');
      await appendAudit({ event: 'therapist_profile_enrichment', rowId: row.id, sourceFile: row.sourceFile || '', sourceRow: row.sourceRow || 0, practitionerName: enrichment.practitionerName, identityStatus, searchUrl, searchResultsReviewed: resultsReviewed, sourceUrl, policyVersion: POLICY_VERSION, rag });
      json(res, 200, { ok: true, profileEnrichment: enrichment, rag }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/therapist/export') {
      const { contacts, conflicts } = dedupeApprovedContactPackets([...therapistRows.values()].flatMap(row => (row.candidates || []).map(candidate => ({ row, candidate }))));
      const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const lines = ['Practitioner name,Email,City,Country,Website,Public context/history,Context URL,Direct email evidence URL,Direct email evidence excerpt,Verification status,Solo evidence URL,Solo evidence excerpt,Source rows,Identity RAG version,Identity review status'];
      for (const { row, candidate, sourceRows, manualProfile, identity } of contacts) {
        const evidence = identity.acceptedEvidence;
        lines.push([candidate.practitionerName, candidate.email, row.city, row.country, row.website, evidence.contextExcerpt, evidence.contextUrl, evidence.emailUrl, evidence.emailExcerpt, candidate.soloEvidence || candidate.verification?.soloStatusEvidence ? 'approved_personal_direct_with_solo_evidence' : 'approved_personal_direct', candidate.verification?.soloEvidenceUrl || '', candidate.verification?.soloStatusEvidence || '', JSON.stringify(sourceRows), identity.version, identity.status].map(quote).join(','));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="therapist-email-research.csv"', 'X-Content-Type-Options': 'nosniff', 'X-Identity-Conflict-Count': String(conflicts.length) });
      if (conflicts.length) void appendAudit({ event: 'therapist_export_identity_conflicts', conflictCount: conflicts.length, conflicts, policyVersion: POLICY_VERSION });
      res.end(`\uFEFF${lines.join('\r\n')}`); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/therapist/candidates-export') {
      const rows = [...therapistRows.values()];
      const { candidatesByRow } = enrichCandidateTriage(rows);
      const unique = new Map();
      for (const row of rows) for (const candidate of candidatesByRow.get(row.id) || []) {
        if (isApprovedPersonalDirect(candidate, row)) continue;
        const prior = unique.get(candidate.email);
        if (!prior || (candidate.triage?.priority || 0) > (prior.candidate.triage?.priority || 0)) unique.set(candidate.email, { row, candidate });
      }
      const priority = { person_name_match_needs_evidence: 3, person_name_fragment_needs_evidence: 2.5, direct_unmatched_needs_attribution: 2, person_named_group_context: 1, shared_or_role: 0, malformed_capture: 0 };
      const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const lines = ['Email style category,Email style label,Email style reason,Triage category,Priority,Triage reasons,Email,Lead name,Practitioner name,Email attribution method,Practitioner bio/context,Clinician profile excerpt,Clinician profile URL,Clinician profile evidence URL,City,Website,Email evidence URL,Email evidence excerpt,About evidence URL,About evidence excerpt,Professional description URL,Professional description excerpt,Description source,Current disposition,Inbox classification,Solo evidence URL,Solo evidence excerpt,Source file,Source row'];
      const items = [...unique.values()].sort((a, b) => (priority[b.candidate.triage?.category] || 0) - (priority[a.candidate.triage?.category] || 0));
      for (const { row, candidate } of items) {
        const nameKey = value => String(value || '').replace(/^Dr\.?\s+/i, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
        const manualProfile = (row.profileEnrichments || []).find(item => item.identityStatus === 'confirmed_public_profile' && normalizeTherapistPersonName(item.practitionerName) === normalizeTherapistPersonName(candidate.practitionerName));
        lines.push([
        candidate.emailStyle?.category, candidate.emailStyle?.label, candidate.emailStyle?.reason, candidate.triage?.category, candidate.triage?.priority, (candidate.triage?.reasons || []).join(' '), candidate.email, row.name,
        candidate.practitionerName || '', candidate.emailAttributionMethod || '', candidate.practitionerBio || '', manualProfile?.publicDetails || candidate.practitionerProfileExcerpt || '', manualProfile?.sourceUrl || candidate.practitionerProfileUrl || '', manualProfile?.sourceUrl || candidate.practitionerProfileEvidenceUrl || '', row.city, row.website, candidate.evidenceUrl, candidate.emailEvidence,
        candidate.aboutEvidenceUrl, candidate.aboutEvidence, candidate.professionalDescriptionUrl || row.professionalDescriptionUrl,
        candidate.professionalDescription || row.professionalDescription, candidate.professionalDescriptionSource || row.professionalDescriptionSource,
        candidate.disposition || 'needs_review', candidate.inboxType || '', candidate.verification?.soloEvidenceUrl || '', candidate.verification?.soloStatusEvidence || '', row.sourceFile, row.sourceRow
        ].map(quote).join(','));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="therapist-email-candidate-triage.csv"', 'X-Content-Type-Options': 'nosniff' });
      res.end(`\uFEFF${lines.join('\r\n')}`); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/enrich') { const payload = await readJson(req); const job = makeJob('enrich', j => runDomainEnrich(payload, j)); json(res, 202, jobView(job)); return; }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)(?:\/(pause|resume|stop|results))?$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]); if (!job) { json(res, 404, { error: 'Search job not found.' }); return; }
      const action = jobMatch[2];
      if (req.method === 'GET' && action === 'results') {
        if (job.state !== 'complete') { json(res, 409, { error: 'Search results are not ready yet.' }); return; }
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const limit = Math.max(1, Math.min(250, Number(url.searchParams.get('limit')) || 200));
        json(res, 200, { offset, total: job.result.length, results: job.result.slice(offset, offset + limit) }); return;
      }
      if (req.method === 'POST' && action) {
        await readJson(req);
        if (action === 'pause' && job.state === 'running') job.paused = true;
        if (action === 'resume' && job.state === 'running') job.paused = false;
        if (action === 'stop' && job.state === 'running') { job.stopped = true; job.paused = false; job.controller.abort(); }
        json(res, 200, jobView(job)); return;
      }
      if (req.method === 'GET' && !action) { json(res, 200, jobView(job)); return; }
    }
    if (req.method === 'POST' && url.pathname === '/api/save-run') {
      const payload = await readJson(req); const run = payload.run; const leads = payload.leads;
      if (!run || !Array.isArray(leads)) { json(res, 400, { error: 'Invalid run data.' }); return; }
      if (payload.append) {
        if (!state.runs.some(saved => saved.id === run.id)) { json(res, 404, { error: 'Saved run not found for this result batch.' }); return; }
        const firstOther = state.leads.findIndex(lead => lead.runId !== run.id);
        state.leads.splice(firstOther < 0 ? state.leads.length : firstOther, 0, ...leads);
      } else {
        state.runs.unshift(run); state.runs = state.runs.slice(0, 300);
        state.leads = [...leads, ...state.leads];
      }
      await saveState();
      if (payload.final) { const job = jobs.get(run.id); if (job?.state === 'complete') job.result = []; }
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/delete-run') {
      const { id } = await readJson(req); state.runs = state.runs.filter(run => run.id !== id); state.leads = state.leads.filter(lead => lead.runId !== id); await saveState(); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-data') { state = { runs: [], leads: [], settings: {} }; await saveState(); json(res, 200, { ok: true }); return; }
    if (req.method === 'POST' && url.pathname === '/api/settings') { const { settings } = await readJson(req); state.settings = settings || {}; await saveState(); json(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && url.pathname === '/api/llm') { json(res, 200, await llmStatus()); return; }
    if (req.method === 'POST' && url.pathname === '/api/llm/draft') {
      // Drafts only. The handoff is explicit that it is not authorization to
      // send, and nothing here sends - the draft comes back for you to read.
      const payload = await readJson(req);
      const lead = payload.lead || {};
      try {
        json(res, 200, await draftEmail(lead, { tie: payload.tie, noticed: payload.noticed }));
      } catch (e) {
        // A missing slot is the caller's to fix, not a server fault: say which.
        if (e.missing) { json(res, 422, { error: e.message, missing: e.missing }); return; }
        json(res, 502, { error: e.message });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Unknown API route.' }); return; }
    if (req.method === 'GET') { await serveStatic(res, url.pathname); return; }
    json(res, 405, { error: 'Method not allowed.' });
  } catch (error) { json(res, 500, { error: error.message || 'Unexpected server error.' }); }
});

await loadState();
await loadTherapistResearch();
await loadTherapistLearning();
await loadTherapistRagMemory();
await sharedLeadQueue.load();
server.listen(PORT, HOST, () => {
  console.log(`LeadKing replica ready at http://127.0.0.1:${PORT}`);
  console.log(`Local data: ${DATA_FILE}`);
  console.log(`Google Maps source: ${chromium ? 'available (Playwright)' : 'Playwright missing; install it in the project root'}`);
});
