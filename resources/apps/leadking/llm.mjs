// Client for the local LM Studio server, plus the lead -> brief mapping.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM, PITCH, pitchGaps } from './llm-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A refused connection is the normal failure here (server not started), and
// the stock message - "fetch failed" - sends you looking in the wrong place.
function explain(e) {
  const code = String(e?.cause?.code || e?.code || '');
  if (code === 'ECONNREFUSED') return `No LM Studio at ${LLM.baseUrl}. Start it with: lms server start`;
  if (e?.name === 'AbortError') return `Model did not answer within ${Math.round(LLM.timeoutMs / 1000)}s`;
  return e?.message || String(e);
}

async function call(pathname, { method = 'GET', body, ms = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(LLM.baseUrl + pathname, {
      method,
      signal: ac.signal,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* handled below */ }
    if (!r.ok) throw new Error(data?.error?.message || data?.error || `LM Studio returned HTTP ${r.status}`);
    if (!data) throw new Error('LM Studio returned a non-JSON body');
    return data;
  } catch (e) {
    throw new Error(explain(e));
  } finally {
    clearTimeout(timer);
  }
}

// Is the server up, and is the configured model actually loaded? "Loaded" is
// the part that bites: the server answers happily with no model in memory and
// only fails once you ask it to generate.
export async function llmStatus() {
  try {
    const { data = [] } = await call('/models');
    const ids = data.map((m) => m.id);
    return { up: true, models: ids, model: LLM.model, loaded: ids.includes(LLM.model), pitchGaps: pitchGaps() };
  } catch (e) {
    return { up: false, models: [], model: LLM.model, loaded: false, pitchGaps: pitchGaps(), error: e.message };
  }
}

// Read fresh every time so the prompt can be edited and retried without
// restarting the server.
const readPrompt = () => fs.readFile(path.join(HERE, LLM.promptFile), 'utf8');

const clean = (s, max = 600) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// The handoff's publicContextExcerpt is a contact-page scrape - a name, some
// letters after it, and an email. There is nothing in that to have noticed.
// Measured: fed one, the model wrote "I saw you use sand trays and dream work
// in the room" - lifted straight from the example in the prompt - in 4 runs
// out of 4. So thin material is refused here rather than sent to the model.
const CREDENTIALS = /\b(LCPC|LCSW|LMFT|LPC|LMHC|PhD|PsyD|MA|MSW|MS|NCC|CCTP|RN|She\/Her|He\/Him|They\/Them)\b/gi;
// Scraped nav bars pass a word count easily - "HOME ABOUT PROVIDERS SERVICES
// BLOG TESTIMONIALS CONTACT REQUEST APPOINTMENT" is nine distinct words and
// says nothing about anyone. Fed one, the model wrote that her site "gets
// people to the point where they're ready to book", which is a description of
// having a website. That is the "So what?" email.
const NAV_WORDS = /\b(home|about(\s+us)?|contact(\s+us)?|blog|services|testimonials|appointment|book\s+now|request|providers|team|faq|resources|privacy|login|menu|search|insurance|rates|fees)\b/gi;
// Crawled snippets usually open with the site's nav bar before any prose, and
// the model will happily build its hook out of "REQUEST APPOINTMENT". Drop the
// leading run of menu labels and shouted headings so the first thing it sees
// is a sentence about a person.
function stripNav(text) {
  const words = text.split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const isShout = w.length <= 14 && w === w.toUpperCase() && /[A-Z]/.test(w);
    const isNav = NAV_WORDS.test(w);
    NAV_WORDS.lastIndex = 0; // global regex keeps state between tests
    if (!isShout && !isNav) break;
    i++;
  }
  // Only trust the strip if real text remains; otherwise leave it alone and
  // let tooThin judge the original.
  const rest = words.slice(i).join(' ');
  return rest.length >= 60 ? rest : text;
}

function tooThin(text, name) {
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) return 'it is a contact scrape (contains an email address)';
  const navHits = new Set((text.match(NAV_WORDS) || []).map((w) => w.toLowerCase().trim()));
  const sentences = (text.match(/[.!?]/g) || []).length;
  if (navHits.size >= 4 && sentences < Math.ceil(text.length / 200)) {
    return `it looks like a scraped navigation bar (${navHits.size} menu labels, ${sentences} sentence${sentences === 1 ? '' : 's'})`;
  }
  const rest = text
    .replace(new RegExp(name.split(/\s+/).filter(Boolean).join('|'), 'gi'), ' ')
    .replace(CREDENTIALS, ' ')
    .replace(/[^a-z\s]/gi, ' ');
  const words = [...new Set(rest.toLowerCase().split(/\s+/).filter((w) => w.length > 3))];
  if (words.length < 12) return `only ${words.length} substantive words once the name and credentials are removed`;
  return '';
}

// Turns one lead into the brief the model is given.
//
// THIS IS THE SEAM. Everything else is plumbing; this is where lead data
// becomes an email brief, and it is the only part that changes when the
// research side moves.
//
//   name      row.practitionerName        a person, never the practice name
//   noticed   row.publicContextExcerpt    what they say about themselves
//   tie       typed by hand               why that connects to you
//   offer     llm-config.mjs              constant across leads
//   proof     llm-config.mjs              constant across leads
//
// `tie` is the one nothing can supply - a bio excerpt cannot tell us why it
// means something to you. Until it is typed the draft refuses. Do not "solve"
// that by letting the model fill the gap; it will, and it will be fiction.
export function buildBrief(lead = {}, { tie = '', noticed = '' } = {}) {
  const who = clean(lead.practitionerName || lead.name, 80);
  const raw = clean(noticed || lead.publicContextExcerpt || lead.professionalDescription || lead.practitionerBio, 900);
  const seen = raw ? clean(stripNav(raw), 700) : '';
  const why = clean(tie, 400);

  const missing = [];
  if (!who) missing.push('practitionerName');
  if (!seen) missing.push('noticed');
  if (!why) missing.push('tie');
  missing.push(...pitchGaps());

  const thin = seen && who ? tooThin(seen, who) : '';
  if (thin && !missing.includes('noticed')) missing.push('noticed');

  const lines = [
    `Prospect: ${who}${lead.location ? `, ${clean(lead.location, 60)}` : ''}`,
    `What I noticed: ${seen}`,
    `My genuine tie: ${why}`,
    `Offer: ${PITCH.offer}`,
    `Proof to cite: ${PITCH.proof}`,
  ];
  if (PITCH.objection) lines.push(`Likely objection: ${PITCH.objection}`);
  if (lead.website) lines.push('', `Background: their site is ${clean(lead.website, 120)}`);

  return { brief: lines.join('\n'), missing, who, thin, seen };
}

export async function draftEmail(lead, opts = {}) {
  const { brief, missing, who, thin, seen } = buildBrief(lead, opts);
  if (missing.length) {
    const err = new Error(thin
      ? `Not enough to go on: ${thin}. Add a real observation before drafting.`
      : `Nothing to work from yet: ${missing.join(', ')}`);
    err.missing = missing;
    throw err;
  }
  const started = Date.now();
  const data = await call('/chat/completions', {
    method: 'POST',
    ms: LLM.timeoutMs,
    body: {
      model: LLM.model,
      temperature: LLM.temperature,
      max_tokens: LLM.maxTokens,
      messages: [
        { role: 'system', content: await readPrompt() },
        { role: 'user', content: brief },
      ],
    },
  });
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model returned an empty draft');
  // `noticed` comes back so the UI can show what the model was actually given
  // after the nav strip, rather than the raw snippet.
  return { text, who, noticed: seen, tokens: data.usage?.completion_tokens ?? null, ms: Date.now() - started };
}
