import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptDir = import.meta.dirname;
const root = path.resolve(scriptDir, '../..');
const builder = path.join(scriptDir, 'build-goatbox-installed-survey.mjs');
const launcherSource = path.join(scriptDir, 'survey-installed-goatbox.ps1');
const PLACEHOLDER = '__SURVEY_BUNDLE_SHA256__';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const build = (name) =>
  spawnSync(process.execPath, [builder, name], { encoding: 'utf8', cwd: root, timeout: 180000 });
const scratch = () => `goatbox-installed-survey-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const remove = (name) => fs.rmSync(path.join(root, '.tmp', name), { recursive: true, force: true });

test('launcher source keeps exactly one bundle-hash placeholder', () => {
  const text = fs.readFileSync(launcherSource, 'utf8');
  assert.equal(text.split(PLACEHOLDER).length - 1, 1);
});

test('build pins the launcher to the digest of the bundle it just produced', () => {
  const name = scratch();
  try {
    const result = build(name);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.match(report.bundleSha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.warnings, 0);

    const dir = path.join(root, '.tmp', name);
    const bundle = fs.readFileSync(path.join(dir, 'survey.mjs'));
    const launcher = fs.readFileSync(path.join(dir, 'Run-GOATBOX-Installed-Survey.ps1'), 'utf8');

    // The invariant the handoff depends on: the pin is the real bundle digest.
    assert.equal(sha(bundle), report.bundleSha256);
    assert.equal(bundle.length, report.bundleBytes);
    assert.ok(launcher.includes(report.bundleSha256));
    assert.ok(!launcher.includes(PLACEHOLDER));
    assert.equal(sha(Buffer.from(launcher, 'utf8')), report.launcherSha256);
  } finally {
    remove(name);
  }
});

test('bundle retains the GOATBOX host guard and the pinned package digest', () => {
  const name = scratch();
  try {
    const result = build(name);
    assert.equal(result.status, 0, result.stderr);
    const entry = fs.readFileSync(path.join(scriptDir, 'survey-installed-goatbox.ts'), 'utf8');
    const pinned = entry.match(/packageSha256\s*=\s*"([a-f0-9]{64})"/u);
    assert.ok(pinned, 'entry must pin a package digest');
    const bundle = fs.readFileSync(path.join(root, '.tmp', name, 'survey.mjs'), 'utf8');
    assert.ok(bundle.includes('GOATBOX only.'));
    assert.ok(bundle.includes(pinned[1]));
    assert.ok(bundle.includes('admissionReady'));
  } finally {
    remove(name);
  }
});

test('build refuses to overwrite an existing handoff directory', () => {
  const name = scratch();
  const dir = path.join(root, '.tmp', name);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const result = build(name);
    assert.notEqual(result.status, 0);
    assert.ok(/EEXIST|already exists/iu.test(result.stderr));
    assert.ok(!fs.existsSync(path.join(dir, 'survey.mjs')));
  } finally {
    remove(name);
  }
});
