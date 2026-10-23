import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'resources', 'apps');
const stage = path.join(root, '.build', 'apps');

await rm(stage, { recursive: true, force: true });
await mkdir(path.dirname(stage), { recursive: true });
// pnpm uses junctions for package links on Windows. Dereference them during
// staging so the installed app doesn't retain links back to the build PC.
await cp(source, stage, { recursive: true, dereference: true });

const postboxPackage = path.join(stage, 'postbox', 'package.json');
const postboxModules = path.join(stage, 'postbox', 'node_modules');
const pnpmStore = path.join(postboxModules, '.pnpm');
async function copyMissing(from, to) {
  const sourceInfo = await stat(from);
  let targetInfo;
  try { targetInfo = await stat(to); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await cp(from, to, { recursive: true, dereference: true });
    return;
  }
  if (!sourceInfo.isDirectory() || !targetInfo.isDirectory()) return;
  for (const child of await readdir(from)) await copyMissing(path.join(from, child), path.join(to, child));
}
// Make the runtime dependency tree conventional/portable: copy pnpm's linked
// package entries into node_modules so Node resolves transitive packages on
// machines that don't have this checkout or pnpm's store.
for (const entry of await readdir(pnpmStore, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const linkedModules = path.join(pnpmStore, entry.name, 'node_modules');
  let packages;
  try { packages = await readdir(linkedModules, { withFileTypes: true }); }
  catch { continue; }
  for (const pkg of packages) {
    if (pkg.name.startsWith('.')) continue;
    const from = path.join(linkedModules, pkg.name);
    const to = path.join(postboxModules, pkg.name);
    await copyMissing(from, to);
  }
}

// The flattened runtime tree no longer needs pnpm's duplicate package store.
await rm(pnpmStore, { recursive: true, force: true });
await rm(path.join(postboxModules, '.bin'), { recursive: true, force: true });
const stagedRequire = createRequire(postboxPackage);
stagedRequire.resolve('googleapis');
stagedRequire.resolve('googleapis-common');
stagedRequire('googleapis');
console.log('Staged Postbox dependencies as portable files.');
