// How many saved research rows have enough material to draft from?
// Run:  node check-draftable.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { buildBrief } from './llm.mjs';

const DATA_DIR = process.env.LEADKING_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'MaazLeadSuite', 'LeadKing');
const FILE = path.join(DATA_DIR, 'therapist-research.jsonl');

const tally = { total: 0, noName: 0, noText: 0, thin: 0, draftable: 0 };
const reasons = new Map();

const rl = readline.createInterface({ input: fs.createReadStream(FILE, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line).row; } catch { continue; }
  if (!row) continue;
  tally.total++;

  // Best person + best prose the row has, mirroring what a draft would use.
  const cand = (row.candidates || [])[0] || {};
  const name = cand.practitionerName || (row.practitionerNames || [])[0]?.name || '';
  const text = cand.practitionerProfileExcerpt || cand.practitionerBio || cand.aboutEvidence
    || row.professionalDescription || cand.professionalDescription || '';

  // `tie` is always supplied by hand, so stub it to isolate the data question.
  const { missing, thin } = buildBrief(
    { practitionerName: name, publicContextExcerpt: text },
    { tie: 'x'.repeat(40) },
  );
  const dataMissing = missing.filter((m) => m !== 'offer' && m !== 'proof' && m !== 'tie');
  if (!dataMissing.length) { tally.draftable++; continue; }
  if (!name) tally.noName++;
  else if (!text) tally.noText++;
  else { tally.thin++; reasons.set(thin, (reasons.get(thin) || 0) + 1); }
}

const pct = (n) => `${((n / tally.total) * 100).toFixed(1)}%`;
console.log(`rows:            ${tally.total}`);
console.log(`draftable:       ${tally.draftable}  (${pct(tally.draftable)})`);
console.log(`no person name:  ${tally.noName}  (${pct(tally.noName)})`);
console.log(`no prose at all: ${tally.noText}  (${pct(tally.noText)})`);
console.log(`too thin:        ${tally.thin}  (${pct(tally.thin)})`);
if (reasons.size) {
  console.log('\nwhy too thin:');
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${n}  ${r}`);
}
