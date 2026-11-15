#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Validates new-findings/*.json (Phase 2 area findings) and merges them into findings.json.
// Findings whose journey is "prior" belong to apply-verdicts.cjs and are preserved untouched.
// Every other finding is rebuilt from the new-findings files on each run. Ids are stable through
// the append-only map new-findings/_ids.json. Paths resolve from __dirname.
'use strict';
const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.resolve(__dirname, '..');
const NEW_DIR = path.join(REVIEW_DIR, 'new-findings');
const FINDINGS = path.join(REVIEW_DIR, 'findings.json');
const ID_MAP = path.join(NEW_DIR, '_ids.json');
const PRIOR_ID_MAP = path.join(REVIEW_DIR, 'prior-verdicts', '_ids.json');
const EVIDENCE_DIR = path.join(REVIEW_DIR, 'evidence');

const PREFIX = {
  chat: 'CH', projects: 'PJ', inbox: 'IN', work: 'WK', capabilities: 'CP', library: 'LB',
  system: 'SY', settings: 'ST', 'first-run': 'FR', messaging: 'MS', global: 'GL',
};
const SEVERITIES = ['blocker', 'stall', 'friction', 'polish'];
const KINDS = ['bug', 'dead-end', 'missing-state', 'wrong-status', 'unclear-copy', 'slow', 'approval-friction'];
const FOUND_BY = ['live', 'code', 'both'];
const CONFIDENCE = ['confirmed', 'likely'];
const TEXT_FIELDS = ['journey', 'title', 'trigger', 'expected', 'actual', 'owner'];
const EVIDENCE_PREFIXES = ['docs/review/2026-11-usability/evidence/', 'evidence/'];

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function evidenceFile(entry) {
  for (const p of EVIDENCE_PREFIXES) {
    if (entry.startsWith(p)) return path.join(EVIDENCE_DIR, entry.slice(p.length));
  }
  return null;
}

function validate(f, where, errors) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) { errors.push(`${where}: finding must be an object`); return; }
  if (!isStr(f.area) || !PREFIX[f.area]) errors.push(`${where}: area "${f.area}" invalid (${Object.keys(PREFIX).join('|')})`);
  for (const k of TEXT_FIELDS) if (!isStr(f[k])) errors.push(`${where}: ${k} missing or empty`);
  if (isStr(f.journey) && f.journey.trim().toLowerCase() === 'prior') errors.push(`${where}: journey must not be "prior"`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`${where}: severity "${f.severity}" invalid`);
  if (!KINDS.includes(f.kind)) errors.push(`${where}: kind "${f.kind}" invalid`);
  if (!FOUND_BY.includes(f.foundBy)) errors.push(`${where}: foundBy "${f.foundBy}" invalid`);
  if (!CONFIDENCE.includes(f.confidence)) errors.push(`${where}: confidence "${f.confidence}" invalid`);
  if (!Array.isArray(f.evidence) || f.evidence.length === 0 || !f.evidence.every(isStr)) {
    errors.push(`${where}: evidence must be a non-empty array of strings`);
  } else {
    for (const e of f.evidence) {
      const file = evidenceFile(e.trim());
      if (file && !fs.existsSync(file)) errors.push(`${where}: evidence file not found: ${e}`);
    }
  }
  if (!Array.isArray(f.priorIds)) errors.push(`${where}: priorIds must be an array`);
  if (f.journeys !== undefined && !(Array.isArray(f.journeys) && f.journeys.every(isStr))) {
    errors.push(`${where}: journeys must be an array of strings`);
  }
  if (f.kind === 'slow' && !(isStr(f.actual) && /\d+(\.\d+)?\s*(ms|s)\b/.test(f.actual))) {
    errors.push(`${where}: kind "slow" needs a measured time such as "1200 ms" or "3 s" in actual`);
  }
}

function loadAll(errors) {
  const files = fs.existsSync(NEW_DIR)
    ? fs.readdirSync(NEW_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()
    : [];
  const items = [];
  const titles = new Map();
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(NEW_DIR, file), 'utf8')); }
    catch (e) { errors.push(`${file}: invalid JSON (${e.message})`); continue; }
    if (!Array.isArray(data)) { errors.push(`${file}: top level must be an array`); continue; }
    data.forEach((f, i) => {
      const where = `${file}[${i}]${f && f.title ? ' "' + String(f.title).slice(0, 50) + '"' : ''}`;
      validate(f, where, errors);
      if (f && isStr(f.area) && isStr(f.title)) {
        const key = `${f.area}::${f.title}`;
        if (titles.has(key)) errors.push(`${where}: duplicate title in area ${f.area} (also ${titles.get(key)})`);
        else titles.set(key, where);
      }
      items.push({ file: file.replace(/\.json$/, ''), f });
    });
  }
  return { files, items };
}

function main() {
  const errors = [];
  const { files, items } = loadAll(errors);
  if (errors.length) {
    console.error(`${errors.length} validation error(s):`);
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }

  const existing = readJson(FINDINGS, []);
  const prior = existing.filter((f) => f.journey === 'prior');
  const idMap = readJson(ID_MAP, {});
  const priorMap = readJson(PRIOR_ID_MAP, {});

  const next = {};
  const bump = (id) => {
    const m = /^U-([A-Z]+)-(\d+)$/.exec(id || '');
    if (m) next[m[1]] = Math.max(next[m[1]] || 0, parseInt(m[2], 10));
  };
  Object.values(idMap).forEach(bump);
  Object.values(priorMap).forEach(bump);
  existing.forEach((f) => bump(f.id));

  let mapChanged = false;
  const merged = items.map(({ file, f }) => {
    const key = `${file}::${f.area}::${f.title}`;
    if (!idMap[key]) {
      const p = PREFIX[f.area];
      next[p] = (next[p] || 0) + 1;
      idMap[key] = `U-${p}-${String(next[p]).padStart(3, '0')}`;
      mapChanged = true;
    }
    const out = {
      id: idMap[key], area: f.area, journey: f.journey, severity: f.severity, kind: f.kind,
      title: f.title, trigger: f.trigger, expected: f.expected, actual: f.actual,
      evidence: f.evidence, foundBy: f.foundBy, confidence: f.confidence, priorIds: f.priorIds,
      owner: f.owner,
    };
    if (f.journeys) out.journeys = f.journeys;
    out.sourceTask = file;
    out.rootCause = null;
    return out;
  });

  if (mapChanged) writeJson(ID_MAP, idMap);
  // Same order apply-verdicts.cjs writes: non-prior findings first, then the carried ones.
  writeJson(FINDINGS, [...merged, ...prior]);

  const count = (list) => SEVERITIES.map((s) => `${s}=${list.filter((x) => x.severity === s).length}`).join(', ');
  console.log(`files read: ${files.length}`);
  console.log(`findings merged: ${merged.length} (${count(merged)})`);
  console.log(`findings.json total: ${merged.length + prior.length} (${count([...merged, ...prior])}), prior preserved: ${prior.length}`);
}

main();
