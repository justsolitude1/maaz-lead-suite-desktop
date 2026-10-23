import { cp, mkdir, readdir, rm } from 'node:fs/promises';
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
    try { await cp(from, to, { recursive: true, dereference: true, errorOnExist: true }); }
    catch (error) { if (error.code !== 'ERR_FS_CP_EEXIST') throw error; }
  }
}

const stagedRequire = createRequire(postboxPackage);
stagedRequire.resolve('googleapis');
stagedRequire.resolve('googleapis-common');
console.log('Staged Postbox dependencies as portable files.');
