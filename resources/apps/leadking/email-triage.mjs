const ROLE_INBOX_LOCAL = /^(?:info|contact|hello|admin|office|support|booking|bookings|appointment|appointments|enquir(?:y|ies)|intake|reception|team|care|clinic|practice|general|mail|help|connect|service|services|sales|marketing|careers|jobs|hr|privacy|billing|schedule|scheduling|frontdesk|customerservice|clientcare|newclients|referrals|media|press|work|staff|patient|patients|client|clients|email|your|use|speak|ask|consult|consultation|meetings?|providers?)(?:$|\s)/i;
const PRACTICE_WORDS = /\b(?:therapy|therapist|psych|psychology|psychologist|counsel(?:ing|ling|or)|clinic|group|associates|wellness|mental health|behavioral health|behavioural health|services|practice|center|centre|collective|pllc|llc|inc)\b/i;
const GROUP_SIGNALS = /\b(?:group|associates|collective|clinic|center|centre|team|partners|multi[- ]?disciplinary|counseling services|counselling services)\b/i;
const BUSINESS_LOCAL_WORDS = /(?:therapy|therapist|psych|counsel|counselling|counseling|clinic|wellness|mentalhealth|behavioralhealth|behaviouralhealth|practice|services|pllc|llc|inc|office|admin|team|booking|appointments|scheduling|support|info|contact|hello|referrals|intake|reception|billing|inquiries|enquiries|enquiry|mail|help|careers|jobs|privacy)/i;
const FREE_EMAIL_DOMAINS = new Set(['gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.ca','outlook.com','hotmail.com','live.com','msn.com','aol.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','fastmail.com','gmx.com','mail.com','yandex.com','zoho.com']);

function candidateNameTokens(value) {
  const cleaned = String(value || '').replace(/\b(?:dr|doctor|phd|psyd|lcsw(?:-r)?|lmhc|lmft|lpc|lcpc|licsw|msw|ma|m(ed)?|counselor|counsellor|psychologist|psychotherapist|therapist|clinical)\b/gi, ' ')
    .split(/[|—–•,;()]/)[0].toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(token => token.length > 1);
  return tokens.length >= 2 && tokens.length <= 4 ? tokens : [];
}

export function classifyEmailStyle(candidate, row) {
  const email = String(candidate?.email || '').trim().toLowerCase();
  const [local = ''] = email.split('@');
  const localWords = local.toLowerCase().split(/[._+-]+/).filter(Boolean);
  const compact = local.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) || !compact) {
    return { category: 'malformed_capture', label: 'Malformed capture', reason: 'Email structure is invalid; exclude unless corrected from the source.' };
  }
  if (candidate?.inboxType === 'shared_or_role_inbox' || ROLE_INBOX_LOCAL.test(local.replace(/[._+-]+/g, ' '))) {
    return { category: 'shared_or_role', label: 'Shared / role inbox', reason: 'Generic or team mailbox naming pattern.' };
  }
  const names = [candidate?.practitionerName, ...(row?.practitionerNames || []).map(person => person.name), row?.name]
    .filter(name => !PRACTICE_WORDS.test(name || ''))
    .map(candidateNameTokens).filter(tokens => tokens.length);
  const matchedName = names.some(tokens => {
    const significant = tokens.filter(token => token.length >= 2);
    if (significant.some(token => compact === token)) return true;
    return significant.slice(0, -1).some(first => significant.at(-1).length >= 3
      && (compact === `${first}${significant.at(-1)}` || compact === `${first[0]}${significant.at(-1)}`));
  }) || names.some(tokens => {
    const first = tokens[0], last = tokens.at(-1);
    let normalized = compact;
    for (const suffix of ['psychotherapy','counseling','counselling','therapist','therapy','psychology','psych','counselor','counsellor','emdr','nyc']) {
      if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 4) normalized = normalized.slice(0, -suffix.length);
    }
    return normalized === `${first[0]}${last}` || new RegExp(`^${first[0]}[a-z]{0,2}${last}$`).test(normalized);
  });
  if (matchedName) return { category: 'personal_name_style', label: 'Personal name-style', reason: 'Email username matches or resembles a named practitioner; address style alone is not treated as proof.' };
  const leadCompact = String(row?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (BUSINESS_LOCAL_WORDS.test(local) || (leadCompact.length > 5 && (leadCompact.includes(compact) || compact.includes(leadCompact)))) {
    return { category: 'business_or_service_style', label: 'Practice / service-style address', reason: 'Address resembles a practice brand or service function, not an individual name.' };
  }

  if (localWords.length >= 2 && localWords.every(word => /^[a-z]{2,}$/i.test(word)) && !localWords.some(word => /^(?:gts|nyc|llc|pllc|pc|inc|team|office|admin)$/i.test(word))) {
    return { category: 'human_name_shape', label: 'Human-name-shaped', reason: 'Address contains multiple name-like words; person attribution still needs checking.' };
  }
  if (/^[a-z][a-z0-9._+-]{2,28}$/i.test(local) && !BUSINESS_LOCAL_WORDS.test(local)) {
    return { category: 'personal_username_style', label: 'Personal username-style', reason: 'Individual-looking username, but no confident name match was found.' };
  }
  return { category: 'ambiguous_style', label: 'Ambiguous style', reason: 'Address pattern alone does not distinguish person from practice mailbox.' };
}

export function triageEmailCandidate(candidate, row, domainPersonEmails = 0) {
  const email = String(candidate?.email || '').trim().toLowerCase();
  const [local = ''] = email.split('@');
  const reasons = [];
  const syntacticallyValid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && !((local.match(/\d/g) || []).length >= 8);
  if (!syntacticallyValid) return { category: 'malformed_capture', priority: 0, reasons: ['Address fails email-shape checks; inspect the page capture before using it.'] };
  const normalizedLocal = local.toLowerCase().replace(/[^a-z0-9]/g, '');
  const role = candidate?.inboxType === 'shared_or_role_inbox' || ROLE_INBOX_LOCAL.test(local.replace(/[._+-]+/g, ' '));
  if (role) return { category: 'shared_or_role', priority: 0, reasons: ['Role/shared/booking-style mailbox; exclude from personal-direct contacts.'] };

  const namedSources = [candidate?.practitionerName, ...(row?.practitionerNames || []).map(person => person.name)];
  const explicitNames = namedSources.map(candidateNameTokens).filter(tokens => tokens.length);
  const leadNameIsPractice = PRACTICE_WORDS.test(row?.name || '');
  const leadTokens = leadNameIsPractice ? [] : candidateNameTokens(row?.name);
  const allNames = [...explicitNames, ...(leadTokens.length ? [leadTokens] : [])];
  const nameMatch = allNames.some(tokens => {
    const last = tokens.at(-1);
    if (last.length < 3) return false;
    const firstNames = tokens.slice(0, -1).filter(token => token.length >= 2);
    const fullMatches = firstNames.some(first => normalizedLocal === `${first}${last}` || normalizedLocal.includes(`${first}${last}`));
    const initialMatch = tokens.slice(0, -1).some(first => normalizedLocal === `${first[0]}${last}`);
    const firstLastInitial = firstNames.some(first => normalizedLocal === `${first}${last[0]}`);
    return fullMatches || initialMatch || firstLastInitial;
  });
  const nameFragmentMatch = !nameMatch && allNames.some(tokens => tokens.some(token => token.length >= 3 && normalizedLocal === token));
  const pageNames = (row?.practitionerNames || []).filter(person => person.evidence === 'Schema.org Person').map(person => person.name).map(candidateNameTokens).filter(tokens => tokens.length);
  if (candidate?.practitionerName) {
    const candidateTokens = candidateNameTokens(candidate.practitionerName);
    if (candidateTokens.length) pageNames.push(candidateTokens);
  }
  const multiPersonPage = new Set(pageNames.map(tokens => tokens.join(' '))).size > 1;
  const rowEmails = new Set((row?.candidates || []).map(item => String(item.email || '').toLowerCase())).size;
  const groupContext = multiPersonPage || domainPersonEmails > 1 || rowEmails > 1 || GROUP_SIGNALS.test(row?.name || '');
  if (multiPersonPage) reasons.push('Structured page data lists multiple practitioners.');
  if (rowEmails > 1) reasons.push('Multiple addresses were found on this lead website; check for a shared practice/team.');
  if (domainPersonEmails > 1) reasons.push('Multiple person-shaped addresses share this domain; check whether it is a group practice.');
  if (GROUP_SIGNALS.test(row?.name || '')) reasons.push('Lead/site name contains a possible group-practice signal.');
  if (nameMatch && !groupContext) {
    reasons.push('Email local-part matches a named practitioner; verify that the exact published address is tied to that clinician on public evidence.');
    return { category: 'person_name_match_needs_evidence', priority: 3, reasons };
  }
  if (nameFragmentMatch && !groupContext) {
    reasons.push('Email local-part matches one name component; this is a personal-style clue, while exact public email-to-clinician attribution still needs evidence.');
    return { category: 'person_name_fragment_needs_evidence', priority: 2.5, reasons };
  }
  if (nameMatch || nameFragmentMatch) {
    reasons.push('Person-specific address pattern on a site with group-practice signals: check whether public evidence ties the exact address to this named clinician. Group affiliation alone does not disqualify an individually attributed email.');
    return { category: 'person_named_group_context', priority: 1, reasons };
  }
  if (nameFragmentMatch) {
    reasons.push('A name component matches on a group-context site: treat it as a personal-style clue and verify the exact email-to-clinician link from public evidence.');
    return { category: 'person_named_group_context', priority: 1, reasons };
  }
  reasons.push('Not a role inbox, but the address does not confidently match a named practitioner.');
  return { category: 'direct_unmatched_needs_attribution', priority: 2, reasons };
}

export function enrichCandidateTriage(rows) {
  const preliminary = [];
  for (const row of rows) for (const candidate of row.candidates || []) preliminary.push({ row, candidate, triage: triageEmailCandidate(candidate, row, 0) });
  const namedPeopleByDomain = new Map();
  for (const item of preliminary) {
    if (!item.triage.category.startsWith('person_')) continue;
    const domain = String(item.candidate.email || '').split('@')[1]?.toLowerCase();
    if (!domain || FREE_EMAIL_DOMAINS.has(domain)) continue;
    const addresses = namedPeopleByDomain.get(domain) || new Set();
    addresses.add(String(item.candidate.email).toLowerCase());
    namedPeopleByDomain.set(domain, addresses);
  }
  const candidatesByRow = new Map();
  const counts = { person_name_match_needs_evidence: 0, person_name_fragment_needs_evidence: 0, person_named_group_context: 0, direct_unmatched_needs_attribution: 0, shared_or_role: 0, malformed_capture: 0 };
  for (const item of preliminary) {
    const domain = String(item.candidate.email || '').split('@')[1]?.toLowerCase();
    const domainPeople = FREE_EMAIL_DOMAINS.has(domain) ? 0 : (namedPeopleByDomain.get(domain)?.size || 0);
    const triage = triageEmailCandidate(item.candidate, item.row, domainPeople);
    counts[triage.category] = (counts[triage.category] || 0) + 1;
    const list = candidatesByRow.get(item.row.id) || [];
    list.push({ ...item.candidate, triage, emailStyle: classifyEmailStyle(item.candidate, item.row) });
    candidatesByRow.set(item.row.id, list);
  }
  for (const list of candidatesByRow.values()) list.sort((a, b) => (b.triage?.priority || 0) - (a.triage?.priority || 0));
  return { candidatesByRow, counts };
}
