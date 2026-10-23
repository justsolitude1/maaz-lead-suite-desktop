import { createHash } from 'node:crypto';

// Local, auditable retrieval memory. Rules are versioned and never inferred from
// run outcomes; only evidence/operational lessons are learned from completed runs.
export const POLICY_VERSION = 'personal-direct-v1.5-identity-rag-v2';
export const CORE_RULES = [
  { id: 'scope', text: 'Research or enrichment never resumes automatically when credits return, after a heartbeat, or after a restart. Start a new discovery, crawl, enrichment, or retry only after an explicit user request for that work.', tags: ['scope','objective','resume','start','crawl','research'] },
  { id: 'existing-person-profile-enrichment', text: 'If a saved therapist website crawl finds no About/bio or professional context, the Playwright fallback revisits the existing practice website, follows its About/team/clinician links and any linked public professional-directory pages, then checks up to five relevant pages for an already identified therapist. Save context only from a page that contains the exact full therapist name and relevant professional details, with that exact page URL. Honor robots.txt and stop on CAPTCHA, rate limit, or access block; never bypass. Namesake ambiguity stays unresolved. This enriches existing rows only and never adds leads or changes email approval.', tags: ['profile','enrichment','practice website','linked profiles','first five','existing therapist','namesake','identity','playwright','bio'] },
  { id: 'email-attribution', text: 'A candidate is approved_personal_direct only when an atomic source-row packet ties the exact published email to the exact named therapist and that same person has a substantive mental-health bio/context at its cited URL. Require an individualized bio/approach/history signal plus a clinical role and clinical detail; credential/contact-only blocks, practice-wide service copy, organization/location labels, and address-only matches do not pass. For public email evidence, require the full name and exact address in the same structured person record or a tightly scoped local excerpt, not unrelated page-wide mentions. Require the exact source identity, source file, and row. Never use mailbox-name resemblance, a lone page-wide name mention, a different person card, generic navigation, or a page-wide bio as attribution. On team/directory pages, require same-card proof for every person. If the source does not prove the full name-email-context match, keep the candidate in needs_review and do not export it as approved.', tags: ['email','name','attribution','evidence','direct','person-level','same-card','identity','bio'] },
  { id: 'identity-conflicts-and-dedupe', text: 'Deduplicate exact email addresses only after comparing the named person identity. If the same address is associated with different normalized practitioner names or conflicting identity evidence across source rows, omit the address from approved exports and report an identity conflict for review. Never select the longest biography from another row or combine a name, email, evidence, and context packet across records. Only collapse repeated rows when they resolve to the same verified individual; preserve the evidence packet from one matching source row.', tags: ['duplicate','dedupe','conflict','same email','source row','identity','bio','export'] },
  { id: 'atomic-evidence-packet', text: 'Identity review retrieves one atomic evidence packet at a time. The exact email, full clinician name, professional context, source URL, and source-row identity must be supported by that packet; never assemble approval by combining unrelated cards, pages, candidates, or the longest bio found for an address. A matching email username, same practice website, page-wide name list, or nonempty excerpt is not proof.', tags: ['atomic','packet','same-card','cross-person','mismatch','evidence','identity','email','context'] },
  { id: 'email-conflict-quarantine', text: 'If an exact email is linked by public evidence to more than one named clinician, quarantine the address and all associated records for review. Deduplicate by exact email only after identity checks; do not pick one name or bio as the winning record.', tags: ['conflict','quarantine','duplicate','email','names','identity'] },
  { id: 'bio-context-quality', text: 'An approved record must carry a person-specific professional context of useful substance, with the same full clinician name and its own public source URL. Never fill missing context from a practice-wide description, an unrelated candidate, name evidence, email evidence, navigation text, or an invented fallback sentence.', tags: ['bio','context','quality','professional','url','person-specific'] },
  { id: 'role-inboxes', text: 'Exclude generic/shared role inboxes such as info, hello, contact, office, frontoffice, frontdesk, team, booking, intake, reception, billing, referrals, location, or support from personal-direct contacts, including variants embedded in a location-prefixed local part. Username shape is a signal only; it cannot prove person attribution.', tags: ['role','shared','generic','hello','info','frontoffice','email'] },
  { id: 'solo-separate', text: 'Solo-practice proof is optional and is never an approval gate. approved_solo is a legacy label only; current approval and handoff status is approved_personal_direct, with any solo evidence kept in a separate optional field.', tags: ['solo','status','approval','approved_solo'] },
  { id: 'context', text: 'For an approved named therapist contact, preserve the public About/bio, expertise, credentials, or another concise truthful professional snippet and its exact URL. If none was captured, state that; never infer identity or invent biography from an email username.', tags: ['bio','about','context','snippet','url'] },
  { id: 'accounting', text: 'Keep every imported source row separately identified even when multiple rows describe the same canonical practice. Reconcile source rows, unique email addresses, review-queue candidates, and approved contacts as separate counts. A review-queue item is not an approved contact; an approved-contact count is not a source-row completion count. Never infer totals from a partial export.', tags: ['count','row','source','duplicate','coverage','complete','reconcile'] },
  { id: 'sender', text: 'A sender handoff may contain only approved_personal_direct contacts with evidence URLs and location, preserving any public context and source rows. Handoff is not permission to schedule or send. Do not schedule or send outreach under the current manager instruction.', tags: ['sender','handoff','send','outreach','schedule'] },
  { id: 'privacy', text: 'Use public professional contact details responsibly; do not guess emails, bypass access controls, or treat a personal-looking address as independently verified without public attribution evidence.', tags: ['public','privacy','guess','verification'] }
];

const words = value => new Set(String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(word => word.length > 2));
export function retrieveRules(query, limit = 5) {
  const q = words(query);
  return CORE_RULES.map(rule => {
    const haystack = words(`${rule.text} ${rule.tags.join(' ')}`);
    const overlap = [...q].filter(token => haystack.has(token)).length;
    const tagHits = rule.tags.filter(tag => q.has(tag)).length;
    return { ...rule, score: overlap + tagHits * 2 };
  }).filter(rule => rule.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
    .map(({ id, text, score }) => ({ id, text, score }));
}
export function sourceRowId(sourceFile, sourceRow, identity) {
  return createHash('sha256').update(`${String(sourceFile || '').trim().toLowerCase()}|${Number(sourceRow) || 0}|${String(identity || '').trim().toLowerCase()}`).digest('hex').slice(0, 24);
}
export function terminalCoverage(rows) {
  const terminal = new Set(['complete_no_email','review','no_website','duplicate','out_of_scope','excluded']);
  // approved_solo is accepted here only as a legacy terminal state; it is not an approval or export gate.
  const emailTerminal = new Set(['approved_personal_direct','approved_solo','excluded','excluded_suggested','unresolved']);
  const done = rows.filter(row => terminal.has(row.status)).length;
  const candidates = rows.flatMap(row => row.candidates || []);
  const emailDone = candidates.filter(candidate => emailTerminal.has(candidate.disposition)).length;
  const emailPending = candidates.length - emailDone;
  const blockedOrFailed = rows.filter(row => ['blocked','failed','partial','pending','researching'].includes(row.status)).length;
  return { sourceRows: rows.length, terminalRows: done, pendingRows: rows.length - done, candidateRecords: candidates.length, candidateTerminal: emailDone, candidatePending: emailPending, blockedOrFailed, complete: rows.length > 0 && done === rows.length && emailPending === 0 && blockedOrFailed === 0 };
}
