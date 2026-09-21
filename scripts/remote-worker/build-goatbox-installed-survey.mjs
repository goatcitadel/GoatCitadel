// Builds the read-only GOATBOX installed-survey handoff: esbuild bundle + hash-pinned launcher.
// Read-only on GOATBOX; this script only writes into .tmp on the controller.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const pnpmDir = path.join(root, 'node_modules/.pnpm');
const esbuildPkg = fs.readdirSync(pnpmDir).filter((n) => n.startsWith('esbuild@')).sort().pop();
if (!esbuildPkg) throw Error('No vendored esbuild found under node_modules/.pnpm.');
const esbuild = await import(
  pathToFileURL(path.join(pnpmDir, esbuildPkg, 'node_modules/esbuild/lib/main.js')).href
);

const outDir = path.join(root, '.tmp', process.argv[2] ?? 'goatbox-installed-survey-v2');
fs.mkdirSync(outDir); // Exclusive: never overwrite an earlier handoff.

const bundlePath = path.join(outDir, 'survey.mjs');
const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/remote-worker/survey-installed-goatbox.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'warning',
});
if (result.errors.length > 0) throw Error('Survey bundle failed to build.');

const bundleBytes = fs.readFileSync(bundlePath);
const bundleSha = sha(bundleBytes);

const launcherSource = fs.readFileSync(
  path.join(root, 'scripts/remote-worker/survey-installed-goatbox.ps1'),
  'utf8',
);
const placeholder = '__SURVEY_BUNDLE_SHA256__';
if (launcherSource.split(placeholder).length !== 2)
  throw Error('Launcher must contain exactly one bundle-hash placeholder.');
const launcherText = launcherSource.replace(placeholder, bundleSha);
if (launcherText.includes(placeholder)) throw Error('Bundle hash placeholder survived substitution.');
const launcherPath = path.join(outDir, 'Run-GOATBOX-Installed-Survey.ps1');
fs.writeFileSync(launcherPath, launcherText, { flag: 'wx' });

console.log(JSON.stringify({
  outputDir: outDir,
  esbuild: esbuildPkg,
  bundleSha256: bundleSha,
  bundleBytes: bundleBytes.length,
  launcherSha256: sha(fs.readFileSync(launcherPath)),
  warnings: result.warnings.length,
}, null, 2));
