#!/usr/bin/env node
// Applies prior-verdicts/*.json to prior-register.json and rebuilds the carried
// ("prior" journey) findings in findings.json. Paths resolve from __dirname.
'use strict';
const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.resolve(__dirname, '..');
const VERDICT_DIR = path.join(REVIEW_DIR, 'prior-verdicts');
const REGISTER = path.join(REVIEW_DIR, 'prior-register.json');
const FINDINGS = path.join(REVIEW_DIR, 'findings.json');
const ID_MAP = path.join(VERDICT_DIR, '_ids.json');

const VERDICTS = ['fixed', 'open', 'partial', 'obsolete', 'operator-only', 'cannot-check'];
const SEVERITIES = ['blocker', 'stall', 'friction', 'polish'];
const KINDS = ['bug', 'dead-end', 'missing-state', 'wrong-status', 'unclear-copy', 'slow', 'approval-friction'];
const FOUND_BY = ['live', 'code', 'both'];
const CONFIDENCE = ['confirmed', 'likely'];
const PREFIX = {
  chat: 'CH', projects: 'PJ', inbox: 'IN', work: 'WK', capabilities: 'CP', library: 'LB',
  system: 'SY', settings: 'ST', 'first-run': 'FR', messaging: 'MS', global: 'GL',
};
const FINDING_FIELDS = ['area', 'journey', 'severity', 'kind', 'title', 'trigger', 'expected', 'actual',
  'evidence', 'foundBy', 'confidence', 'owner'];

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

function loadEntries(errors) {
  const files = fs.existsSync(VERDICT_DIR)
    ? fs.readdirSync(VERDICT_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()
    : [];
  const entries = [];
  const seen = new Map();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(VERDICT_DIR, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: invalid JSON (${e.message})`);
      continue;
    }
    if (!Array.isArray(data)) { errors.push(`${file}: top level must be an array`); continue; }
    data.forEach((entry, i) => {
      const where = `${file}[${i}]${entry && entry.priorId ? ' ' + entry.priorId : ''}`;
      if (!entry || typeof entry !== 'object') { errors.push(`${where}: not an object`); return; }
      if (seen.has(entry.priorId)) {
        errors.push(`${where}: priorId also appears in ${seen.get(entry.priorId)}`);
        return;
      }
      seen.set(entry.priorId, file);
      entries.push({ file, where, entry });
    });
  }
  return entries;
}

function validateFinding(f, where, errors) {
  if (!f || typeof f !== 'object') { errors.push(`${where}: finding must be an object`); return; }
  for (const k of FINDING_FIELDS) {
    if (k === 'evidence') {
      if (!Array.isArray(f.evidence) || f.evidence.length === 0 || !f.evidence.every(isStr)) {
        errors.push(`${where}: finding.evidence must be a non-empty array of strings`);
      }
    } else if (!isStr(f[k])) {
      errors.push(`${where}: finding.${k} missing`);
    }
  }
  if (isStr(f.journey) && f.journey !== 'prior') errors.push(`${where}: finding.journey must be "prior" (got "${f.journey}")`);
  if (isStr(f.foundBy) && !FOUND_BY.includes(f.foundBy)) errors.push(`${where}: finding.foundBy "${f.foundBy}" invalid`);
  if (isStr(f.confidence) && !CONFIDENCE.includes(f.confidence)) errors.push(`${where}: finding.confidence "${f.confidence}" invalid`);
  if (isStr(f.severity) && !SEVERITIES.includes(f.severity)) errors.push(`${where}: finding.severity "${f.severity}" invalid`);
  if (isStr(f.kind) && !KINDS.includes(f.kind)) errors.push(`${where}: finding.kind "${f.kind}" invalid`);
  if (isStr(f.area) && !PREFIX[f.area]) errors.push(`${where}: finding.area "${f.area}" has no id prefix`);
}

function validate(entries, registerById, errors) {
  const byId = new Map(entries.map((e) => [e.entry.priorId, e.entry]));
  for (const { where, entry } of entries) {
    if (!registerById.has(entry.priorId)) { errors.push(`${where}: priorId not in register`); continue; }
    if (!VERDICTS.includes(entry.verdict)) { errors.push(`${where}: verdict "${entry.verdict}" invalid`); continue; }
    const needsEvidence = entry.verdict !== 'cannot-check' && entry.verdict !== 'operator-only';
    if (needsEvidence && !(Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.every(isStr))) {
      errors.push(`${where}: evidence must be a non-empty array for ${entry.verdict}`);
    }
    if (entry.evidence !== undefined && !Array.isArray(entry.evidence)) errors.push(`${where}: evidence must be an array`);
    if (!isStr(entry.note)) errors.push(`${where}: note missing`);
    const carries = entry.verdict === 'open' || entry.verdict === 'partial';
    if (entry.sameFindingAs !== undefined) {
      if (!carries) errors.push(`${where}: sameFindingAs only valid for open/partial`);
      const target = byId.get(entry.sameFindingAs);
      if (!target) errors.push(`${where}: sameFindingAs ${entry.sameFindingAs} has no verdict entry`);
      else if (!target.finding) errors.push(`${where}: sameFindingAs ${entry.sameFindingAs} has no finding`);
      if (entry.finding) errors.push(`${where}: finding must be absent when sameFindingAs is set`);
    } else if (carries) {
      if (!entry.finding) errors.push(`${where}: ${entry.verdict} needs a finding or sameFindingAs`);
      else validateFinding(entry.finding, where, errors);
    } else if (entry.finding) {
      errors.push(`${where}: finding only allowed for open/partial`);
    }
  }
}

function numberOf(id, prefix) {
  const m = new RegExp(`^U-${prefix}-(\\d+)$`).exec(id || '');
  return m ? parseInt(m[1], 10) : 0;
}

function main() {
  const errors = [];
  const register = readJson(REGISTER, null);
  if (!register) { console.error('prior-register.json not found'); process.exit(1); }
  const registerById = new Map(register.map((r) => [r.priorId, r]));
  const entries = loadEntries(errors);
  validate(entries, registerById, errors);
  if (errors.length) {
    console.error(`${errors.length} validation error(s):`);
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }

  const idMap = readJson(ID_MAP, {});
  const existing = readJson(FINDINGS, []);
  const kept = existing.filter((f) => f.journey !== 'prior');

  // Next free number per prefix: considers the map and preserved findings.
  const next = {};
  const bump = (prefix, n) => { next[prefix] = Math.max(next[prefix] || 0, n); };
  for (const id of Object.values(idMap)) {
    const m = /^U-([A-Z]+)-(\d+)$/.exec(id);
    if (m) bump(m[1], parseInt(m[2], 10));
  }
  for (const f of kept) {
    const m = /^U-([A-Z]+)-(\d+)$/.exec(f.id || '');
    if (m) bump(m[1], parseInt(m[2], 10));
  }

  const byId = new Map(entries.map((e) => [e.entry.priorId, e.entry]));
  const primaries = entries.filter((e) => e.entry.finding).sort((a, b) =>
    a.entry.priorId.localeCompare(b.entry.priorId, 'en', { numeric: true }));
  let mapChanged = false;
  for (const { entry } of primaries) {
    if (idMap[entry.priorId]) continue;
    const prefix = PREFIX[entry.finding.area];
    next[prefix] = (next[prefix] || 0) + 1;
    idMap[entry.priorId] = `U-${prefix}-${String(next[prefix]).padStart(3, '0')}`;
    mapChanged = true;
  }

  const findingIdFor = (e) => (e.sameFindingAs ? idMap[e.sameFindingAs] : idMap[e.priorId]);

  const carried = primaries.map(({ entry }) => {
    const id = idMap[entry.priorId];
    const row = registerById.get(entry.priorId);
    const priorIds = [entry.priorId];
    for (const other of entries) {
      if (other.entry.sameFindingAs === entry.priorId) priorIds.push(other.entry.priorId);
    }
    if (Array.isArray(row.priorIds)) priorIds.push(...row.priorIds);
    const f = entry.finding;
    return {
      id,
      area: f.area,
      journey: f.journey,
      severity: f.severity,
      kind: f.kind,
      title: f.title,
      trigger: f.trigger,
      expected: f.expected,
      actual: f.actual,
      evidence: f.evidence,
      foundBy: f.foundBy,
      confidence: f.confidence,
      priorIds: Array.from(new Set(priorIds)),
      owner: f.owner,
      rootCause: null,
    };
  });
  // Findings whose journey is "prior" must keep that journey value to be replaced next run.
  carried.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  const newRegister = register.map((row) => {
    const e = byId.get(row.priorId);
    if (!e) return row;
    const out = { ...row };
    out.verdict = e.verdict;
    out.evidence = e.evidence || [];
    out.note = e.note;
    out.carriedAs = e.verdict === 'open' || e.verdict === 'partial' ? findingIdFor(e) : null;
    return out;
  });

  const newFindings = [...kept, ...carried];
  if (mapChanged) writeJson(ID_MAP, sortKeys(idMap));
  writeJson(REGISTER, newRegister);
  writeJson(FINDINGS, newFindings);

  const counts = {};
  entries.forEach((e) => { counts[e.entry.verdict] = (counts[e.entry.verdict] || 0) + 1; });
  const sev = {};
  carried.forEach((f) => { sev[f.severity] = (sev[f.severity] || 0) + 1; });
  console.log(`entries applied: ${entries.length}`);
  console.log('by verdict: ' + (Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'));
  console.log(`findings written: ${carried.length} carried (kept ${kept.length} other)`);
  console.log('by severity: ' + (Object.entries(sev).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'));
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj));
}

main();
