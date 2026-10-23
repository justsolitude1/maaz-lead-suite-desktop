// Deterministic retrieval-augmented identity review for therapist contacts.
// Evidence stays in atomic records: text from different people/pages is never
// concatenated to make a name-email match.

export const IDENTITY_RAG_VERSION = 'therapist-identity-rag-v2';

const THERAPIST_ROLE = /\b(?:therapist|psychotherapist|psychologist|mental health counselor|professional counselor|clinical social worker|social worker|counselor|counsellor|lcsw|lmhc|lmft|lpc|lpcc|licsw|psyd|psy\.d|mft)\b/i;
const PERSONAL_BIO_CUE = /\b(?:i am (?:a|an) (?:licensed )?(?:clinical )?(?:therapist|psychotherapist|psychologist|mental health counselor|professional counselor|clinical social worker|social worker|counselor|counsellor)|i work as (?:a|an) (?:therapist|psychotherapist|psychologist|counselor|counsellor)|i specialize in|i specialise in|i work with|i help clients|i support clients|i have worked|i have been trained|i have been in the seat|my (?:clinical |therapeutic )?approach|my background|my experience|my training|i offer (?:individual|online|in-person|therapy|counseling|counselling)|i practice as)\b/i;
const CLINICAL_DETAIL = /\b(?:approach|modalit(?:y|ies)|trained|training|experience|background|speciali[sz]|focus(?:es)?|clients? (?:with|who)|cbt|cognitive behavioral|attachment|person[- ]centered|gestalt|somatic|trauma|anxiety|depression|ptsd|relationships?|families|couples|children|adolescents)\b/i;
const ALLOWED_ATTRIBUTION = new Set([
  'structured_person_email',
  'email_and_name_matched_within_profile_card',
  'name_and_exact_email_in_public_contact_text',
  'user_evidence_review'
]);
const NON_PERSON_NAME_TERMS = new Set(['about','appointment','center','centre','clinic','contact','counseling','counselling','directory','group','health','institute','city','canada','vital','response','medical','student','network','team','therapy','therapist','wellness','psychology','office','practice','services','support','counselor','counsellor','massage','spa','frontoffice','frontdesk']);
const NON_PERSON_NAME_PHRASES = new Set(['new york city','new york','brooklyn','manhattan','the bronx','bronx','los angeles','chicago','houston','phoenix','philadelphia','san antonio','san diego','san jose','dallas','jacksonville','fort worth','glasgow','manchester','sheffield','leeds','toronto','montreal','calgary','sydney']);

export function normalizeIdentityText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

export function normalizeIdentityName(value) {
  const raw = String(value || '').replace(/^(?:Dr\.?|Prof\.?)\s+/i, '').replace(/,\s*MA\s*$/i, '');
  const tokens = normalizeIdentityText(raw).split(/\s+/).filter(Boolean);
  const credentials = new Set(['lcsw','lmhc','lmft','lpc','lcpc','licsw','lsw','csw','phd','psyd','md','dsw','msw','mft']);
  while (tokens.length > 1 && credentials.has(tokens.at(-1))) tokens.pop();
  return tokens.join(' ');
}

function nameTokens(name) {
  return normalizeIdentityName(name).split(/\s+/).filter(token => token.length > 1);
}

function exactNamePresent(text, name) {
  const normalizedText = ` ${normalizeIdentityText(text)} `;
  const tokens = nameTokens(name);
  if (tokens.length < 2) return false;
  const phrase = ` ${tokens.join(' ')} `;
  return normalizedText.includes(phrase);
}

function plausibleIdentityName(value) {
  const tokens = nameTokens(value);
  const normalized = normalizeIdentityName(value);
  return tokens.length >= 2 && tokens.length <= 5 && !NON_PERSON_NAME_PHRASES.has(normalized)
    && !tokens.some(token => NON_PERSON_NAME_TERMS.has(token));
}

function validPublicUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname.includes('.'));
  } catch {
    return false;
  }
}

function hasExactEmail(text, email) {
  const needle = String(email || '').trim().toLowerCase();
  return Boolean(needle && String(text || '').toLowerCase().includes(needle));
}

function isRoleInbox(email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[._+-]+/g, ' ');
  return /\b(?:info|contact|hello|admin|office|front\s*office|front\s*desk|support|booking|appointments?|enquiries|inquiries|intake|reception|team|care|clinic|practice|general|mail|help|connect|service|services|sales|marketing|careers|jobs|hr|privacy|billing|patient\s*relations|provider\s*relations|locations?)\b/.test(local);
}

function sourceRefMatches(packet, row) {
  if (!packet?.sourceReference || !row) return false;
  const ref = packet.sourceReference;
  const rowIdentity = String(row.sourceIdentity || row.id || '');
  return Boolean(ref.sourceIdentity && ref.sourceFile && Number(ref.sourceRow) > 0)
    && ref.sourceIdentity === rowIdentity
    && ref.sourceFile === String(row.sourceFile || '')
    && Number(ref.sourceRow) === Number(row.sourceRow || 0);
}

function nameAndEmailNear(text, name, email, radius = 360) {
  const source = String(text || '');
  const address = String(email || '').trim();
  if (!address) return false;
  const lower = source.toLowerCase();
  const needle = address.toLowerCase();
  let from = 0;
  while (true) {
    const index = lower.indexOf(needle, from);
    if (index < 0) return false;
    const snippet = source.slice(Math.max(0, index - radius), Math.min(source.length, index + needle.length + radius));
    if (exactNamePresent(snippet, name)) return true;
    from = index + needle.length;
  }
}

function organizationHeadingWithoutBio(text, name) {
  const context = normalizeIdentityText(text);
  const normalizedName = normalizeIdentityName(name);
  if (!context.startsWith(`${normalizedName} `)) return false;
  const afterName = context.slice(normalizedName.length).trim().split(/\s+/).slice(0, 3).join(' ');
  const brandWords = /\b(?:therapy|therapist|psychotherapy|psychology|counseling|counselling|wellness|clinic|center|centre|massage|spa|practice|collective|group|services|health)\b/i;
  return brandWords.test(afterName) && !PERSONAL_BIO_CUE.test(String(text || ''));
}

function directEmailExcerpt(candidate, proof, name, email) {
  if (proof?.verificationMethod === 'user_evidence_review') return proof.directContactEvidence || '';
  const profile = String(candidate?.practitionerProfileExcerpt || '');
  if (hasExactEmail(profile, email) && exactNamePresent(profile, name)) return profile;
  return candidate?.emailEvidence || '';
}

function candidatePackets(candidate, row) {
  const savedPackets = Array.isArray(candidate?.identityEvidencePackets) ? candidate.identityEvidencePackets : [];
  const manualProfiles = (row?.profileEnrichments || []).filter(profile => profile.identityStatus === 'confirmed_public_profile'
    && normalizeIdentityName(profile.practitionerName) === normalizeIdentityName(candidate?.practitionerName)
    && String(profile.publicDetails || '').trim().length >= 80
    && exactNamePresent(profile.publicDetails, candidate?.practitionerName)
    && validPublicUrl(profile.sourceUrl));
  const profilePackets = manualProfiles.map(profile => ({
    practitionerName: candidate?.practitionerName || '',
    email: String(candidate?.email || '').trim().toLowerCase(),
    emailExcerpt: directEmailExcerpt(candidate, candidate?.verification, candidate?.practitionerName, candidate?.email),
    emailUrl: candidate?.verification?.directEvidenceUrl || candidate?.evidenceUrl || '',
    contextExcerpt: profile.publicDetails,
    contextUrl: profile.sourceUrl,
    attributionMethod: candidate?.verification?.emailAttributionMethod || candidate?.emailAttributionMethod || '',
    personContextName: profile.practitionerName,
    personContextEvidence: profile.publicDetails,
    personContextEvidenceUrl: profile.sourceUrl,
    sourceReference: { sourceIdentity: row?.sourceIdentity || row?.id || '', sourceFile: row?.sourceFile || '', sourceRow: row?.sourceRow || 0 },
    manualProfile: true
  }));
  const aboutText = String(candidate?.aboutEvidence || '').trim();
  const aboutUrl = String(candidate?.aboutEvidenceUrl || '').trim();
  const aboutPackets = aboutText.length >= 80 && exactNamePresent(aboutText, candidate?.practitionerName) && validPublicUrl(aboutUrl)
    ? [{
      practitionerName: candidate?.practitionerName || '',
      email: String(candidate?.email || '').trim().toLowerCase(),
      emailExcerpt: directEmailExcerpt(candidate, candidate?.verification, candidate?.practitionerName, candidate?.email),
      emailUrl: candidate?.verification?.directEvidenceUrl || candidate?.evidenceUrl || '',
      contextExcerpt: aboutText,
      contextUrl: aboutUrl,
      attributionMethod: candidate?.verification?.emailAttributionMethod || candidate?.emailAttributionMethod || '',
      personContextName: candidate?.practitionerName || '',
      personContextEvidence: aboutText,
      personContextEvidenceUrl: aboutUrl,
      sourceReference: { sourceIdentity: row?.sourceIdentity || row?.id || '', sourceFile: row?.sourceFile || '', sourceRow: row?.sourceRow || 0 },
      aboutPage: true
    }]
    : [];
  if (savedPackets.length) {
    return [...savedPackets.map(packet => ({ ...packet, sourceReference: packet.sourceReference || {
      sourceIdentity: row?.sourceIdentity || row?.id || '', sourceFile: row?.sourceFile || '', sourceRow: row?.sourceRow || 0
    } })), ...profilePackets, ...aboutPackets];
  }
  const proof = candidate?.verification || {};
  const name = candidate?.practitionerName || '';
  const email = String(candidate?.email || '').trim().toLowerCase();
  const emailExcerpt = directEmailExcerpt(candidate, proof, name, email);
  const emailUrl = proof.directEvidenceUrl || candidate?.evidenceUrl || '';
  const contextCandidates = [
    { text: proof.personContextEvidence, url: proof.personContextEvidenceUrl, kind: 'saved_person_context' },
    { text: candidate?.practitionerProfileExcerpt, url: candidate?.practitionerProfileEvidenceUrl, kind: 'profile_card_context' },
    { text: candidate?.practitionerBio, url: candidate?.practitionerBioUrl, kind: 'biography_context' }
  ];
  const contextPackets = contextCandidates.filter(item => String(item.text || '').trim().length >= 80
    && exactNamePresent(item.text, name) && validPublicUrl(item.url)).map(item => ({
    practitionerName: name,
    email,
    emailExcerpt,
    emailUrl,
    contextExcerpt: String(item.text).trim(),
    contextUrl: item.url,
    attributionMethod: proof.emailAttributionMethod || candidate?.emailAttributionMethod || '',
    personContextName: proof.personContextName || name,
    personContextEvidence: String(item.text).trim(),
    personContextEvidenceUrl: item.url,
    sourceReference: { sourceIdentity: row?.sourceIdentity || row?.id || '', sourceFile: row?.sourceFile || '', sourceRow: row?.sourceRow || 0 },
    legacyPacket: true,
    evidenceType: item.kind
  }));
  if (!contextPackets.length) contextPackets.push({
    practitionerName: name, email, emailExcerpt, emailUrl,
    contextExcerpt: '', contextUrl: '', attributionMethod: proof.emailAttributionMethod || candidate?.emailAttributionMethod || '',
    personContextName: proof.personContextName || name,
    sourceReference: { sourceIdentity: row?.sourceIdentity || row?.id || '', sourceFile: row?.sourceFile || '', sourceRow: row?.sourceRow || 0 },
    legacyPacket: true
  });
  return [...contextPackets, ...profilePackets, ...aboutPackets];
}

function assessPacket(packet, expectedEmail, expectedName, row) {
  const reasons = [];
  const name = String(packet.practitionerName || '').trim();
  const email = String(packet.email || expectedEmail || '').trim().toLowerCase();
  const emailExcerpt = String(packet.emailExcerpt || '');
  const contextExcerpt = String(packet.contextExcerpt || packet.personContextEvidence || '');
  const emailUrl = String(packet.emailUrl || '');
  const contextUrl = String(packet.contextUrl || packet.personContextEvidenceUrl || '');
  const attributionMethod = String(packet.attributionMethod || '');

  if (!name || normalizeIdentityName(name) !== normalizeIdentityName(expectedName)) reasons.push('evidence_name_mismatch');
  if (!plausibleIdentityName(name)) reasons.push('practitioner_name_not_personlike');
  if (!email || email !== String(expectedEmail || '').trim().toLowerCase()) reasons.push('evidence_email_mismatch');
  if (!hasExactEmail(emailExcerpt, expectedEmail)) reasons.push('exact_email_missing_from_attribution_excerpt');
  if (!validPublicUrl(emailUrl)) reasons.push('email_evidence_url_missing_or_invalid');
  if (!ALLOWED_ATTRIBUTION.has(attributionMethod)) reasons.push('person_email_attribution_method_unrecognized');
  if (isRoleInbox(expectedEmail)) reasons.push('generic_or_shared_role_inbox');
  if (!sourceRefMatches(packet, row)) reasons.push('source_row_identity_mismatch');

  const structuredPersonRecord = attributionMethod === 'structured_person_email'
    && packet.structuredPersonRecord === true
    && normalizeIdentityName(packet.structuredRecordName) === normalizeIdentityName(expectedName)
    && String(packet.structuredRecordEmail || '').toLowerCase() === String(expectedEmail || '').toLowerCase();
  const sameCard = ['email_and_name_matched_within_profile_card', 'name_and_exact_email_in_public_contact_text', 'user_evidence_review'].includes(attributionMethod)
    && nameAndEmailNear(emailExcerpt, expectedName, expectedEmail);
  if (!structuredPersonRecord && !sameCard) reasons.push('name_and_email_not_proven_in_same_person_record');

  const contextName = packet.personContextName || name;
  if (normalizeIdentityName(contextName) !== normalizeIdentityName(expectedName)
    || !exactNamePresent(contextExcerpt, expectedName)) reasons.push('person_specific_context_name_missing');
  if (contextExcerpt.trim().length < 80) reasons.push('person_context_too_short');
  if (!THERAPIST_ROLE.test(contextExcerpt)) reasons.push('named_therapist_role_missing_from_context');
  if (!PERSONAL_BIO_CUE.test(contextExcerpt) || !CLINICAL_DETAIL.test(contextExcerpt)) reasons.push('person_specific_biography_or_clinical_detail_missing');
  if (organizationHeadingWithoutBio(contextExcerpt, expectedName)) reasons.push('organization_or_location_label_not_a_named_clinician');
  if (!validPublicUrl(contextUrl)) reasons.push('context_evidence_url_missing_or_invalid');
  if (packet.personContextEvidenceUrl && packet.personContextEvidenceUrl !== contextUrl) reasons.push('context_url_provenance_mismatch');

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    evidence: {
      practitionerName: name,
      email,
      emailUrl,
      contextUrl,
      attributionMethod,
      sourceReference: packet.sourceReference || null,
      emailExcerpt,
      contextExcerpt
    }
  };
}

// Retrieval is deliberately exact and evidence-scoped. It ranks only documents
// that contain the requested email and practitioner; it never joins separate
// page snippets into an attribution claim.
export function retrieveIdentityEvidence({ practitionerName, email, documents = [], limit = 6 }) {
  const name = String(practitionerName || '').trim();
  const address = String(email || '').trim().toLowerCase();
  return documents.map((document, index) => {
    const excerpt = String(document.emailExcerpt || document.text || '');
    const exactAddress = hasExactEmail(excerpt, address);
    const exactName = exactNamePresent(excerpt, name);
    const structured = document.structuredPersonRecord === true
      && normalizeIdentityName(document.structuredRecordName) === normalizeIdentityName(name)
      && String(document.structuredRecordEmail || '').toLowerCase() === address;
    const score = (exactAddress ? 8 : 0) + (exactName ? 8 : 0) + (structured ? 10 : 0)
      + (validPublicUrl(document.emailUrl || document.url) ? 2 : 0);
    return { ...document, retrievalIndex: index, exactAddress, exactName, structured, score };
  }).filter(document => document.score > 0)
    .sort((a, b) => b.score - a.score || a.retrievalIndex - b.retrievalIndex)
    .slice(0, Math.max(1, limit));
}

export function evaluateTherapistContact(candidate, row = null) {
  const email = String(candidate?.email || '').trim().toLowerCase();
  const name = String(candidate?.practitionerName || '').trim();
  const packets = candidatePackets(candidate, row);
  const retrieved = retrieveIdentityEvidence({ practitionerName: name, email, documents: packets });
  const assessments = retrieved.map(packet => assessPacket(packet, email, name, row));
  const linkedNames = new Set(packets.filter(packet => plausibleIdentityName(packet.structuredPersonRecord === true ? packet.structuredRecordName : packet.practitionerName)
    && ALLOWED_ATTRIBUTION.has(String(packet.attributionMethod || ''))
    && hasExactEmail(packet.emailExcerpt, email)
    && (exactNamePresent(packet.emailExcerpt, packet.practitionerName)
      || (packet.structuredPersonRecord === true && String(packet.structuredRecordEmail || '').toLowerCase() === email)))
    .map(packet => normalizeIdentityName(packet.structuredPersonRecord === true
      && String(packet.structuredRecordEmail || '').toLowerCase() === email ? packet.structuredRecordName : packet.practitionerName)).filter(Boolean));
  const reasons = new Set(assessments.flatMap(assessment => assessment.reasons));
  if (linkedNames.size > 1) reasons.add('same_email_has_multiple_person_attributions');
  if (!assessments.some(assessment => assessment.ok)) reasons.add('no_single_complete_evidence_packet');
  const accepted = assessments.find(assessment => assessment.ok);
  const status = linkedNames.size > 1 ? 'identity_conflict' : accepted ? 'verified_person_email_context' : 'needs_review';
  return {
    ok: Boolean(accepted && linkedNames.size <= 1),
    status,
    version: IDENTITY_RAG_VERSION,
    attributedNames: [...linkedNames],
    reasons: [...reasons],
    retrievedEvidenceCount: retrieved.length,
    acceptedEvidence: accepted?.evidence || null,
    evidenceCandidates: assessments.map(item => ({ ok: item.ok, reasons: item.reasons, evidence: item.evidence }))
  };
}

export function mergeIdentityEvidencePackets(...groups) {
  const result = [];
  const seen = new Set();
  for (const packet of groups.flat().filter(Boolean)) {
    const key = [packet.practitionerName, packet.email, packet.emailUrl, packet.contextUrl,
      packet.emailExcerpt, packet.contextExcerpt].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(packet);
  }
  return result;
}
