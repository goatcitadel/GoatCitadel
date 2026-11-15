#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Applies overrides.json (Task 15: severity and wording corrections, root causes, merges, removals) to the
// findings.json that apply-verdicts.cjs and apply-new-findings.cjs leave behind, ranks what remains and writes
// withdrawn.json. Run it through build-findings.cjs, which runs all three in order. Paths resolve from __dirname.
'use strict';
const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.resolve(__dirname, '..');
const FINDINGS = path.join(REVIEW_DIR, 'findings.json');
const OVERRIDES = path.join(REVIEW_DIR, 'overrides.json');
const ROOT_CAUSES = path.join(REVIEW_DIR, 'root-causes.md');
const WITHDRAWN = path.join(REVIEW_DIR, 'withdrawn.json');

const SEVERITIES = ['blocker', 'stall', 'friction', 'polish'];
const KINDS = ['bug', 'dead-end', 'missing-state', 'wrong-status', 'unclear-copy', 'slow', 'approval-friction'];
const CONFIDENCE = ['confirmed', 'likely'];
const FOUND_BY = ['live', 'code', 'both'];
const MOVED_TO = ['engineering-note', 'design-decision', 'sandbox-artifact'];
const REPLACEABLE = ['severity', 'kind', 'title', 'trigger', 'expected', 'actual', 'confidence', 'foundBy', 'owner',
  'evidence', 'priorIds', 'journeys'];
const CONTROL = ['rootCause', 'relatedIds', 'mergedInto', 'withdrawn', 'movedTo', 'reason', 'why'];
const NEEDS_WHY = ['severity', 'confidence', 'title'];

// How early a new operator meets each journey in their first hour on the Windows desktop app (1 = first).
// Install and first start, first run, the shell and first Chat, then Settings, approvals, projects, Capabilities,
// Library, System, Work, messaging; paths a default desktop install does not take come last.
const FIRST_HOUR = {
  'FR-5': 1, 'FR-4': 2, 'FR-1': 3, 'FR-2': 4, 'CH-1': 5, 'GL-1': 6, 'GL-7': 6, 'SY-1': 6,
  'CH-2': 8, 'CH-3': 8, 'CH-4': 8, 'CH-5': 8, 'CH-6': 8, 'ST-1': 9, 'GL-P': 9, 'ST-2': 10, 'ST-3': 10,
  'CH-9': 11, 'CH-10': 11, 'IN-1': 12, 'IN-3': 12, 'GL-3': 13, 'GL-6': 13,
  'CH-11': 14, 'CH-12': 14, 'CH-13': 14, 'CH-14': 14, 'CH-16': 14, 'MS-4': 14, 'PJ-1': 15, 'PJ-2': 15,
  'CP-2': 16, 'CP-3': 16, 'CP-4': 16, 'CP-5': 16, 'CP-6': 16, 'ST-6': 17, 'ST-7': 17, 'ST-8': 17, 'ST-9': 17,
  'LB-1': 18, 'LB-2': 18, 'LB-3': 18, 'LB-4': 18, 'SY-2': 19, 'SY-4': 19, 'SY-5': 19, 'SY-6': 19, 'SY-7': 19,
  'WK-1': 20, 'WK-2': 20, 'WK-3': 20, 'WK-4': 20, 'MS-1': 21, 'MS-3': 21, 'CH-8': 22, 'IN-2': 22, 'GL-5': 22,
  Outage: 23, 'FR-3': 24, 'GL-T': 24, 'GL-L': 25,
};
const PREFIX_HOUR = { FR: 4, CH: 8, ST: 17, GL: 13, PJ: 15, IN: 12, CP: 16, LB: 18, SY: 19, WK: 20, MS: 21 };
// Carried findings ("prior" journey) take the hour of their area.
const AREA_HOUR = {
  'first-run': 3, global: 6, chat: 8, settings: 9, inbox: 12, projects: 15, capabilities: 16, library: 18,
  system: 19, work: 20, messaging: 21,
};

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const uniq = (list) => Array.from(new Set(list));
const byId = (a, b) => a.localeCompare(b, 'en', { numeric: true });

function journeyCode(j) {
  const m = /^([A-Z]{2}-[A-Z0-9]+)\b/.exec(j || '');
  if (m) return m[1];
  return /^Outage\b/.test(j || '') ? 'Outage' : null;
}

function journeysOf(f) {
  const all = [f.journey, ...(f.journeys || [])].filter((j) => isStr(j) && j !== 'prior');
  return uniq(all.map((j) => journeyCode(j) || j));
}

function hourOf(f) {
  const hours = journeysOf(f).map((code) => FIRST_HOUR[code] ?? PREFIX_HOUR[code.slice(0, 2)]).filter(Number.isFinite);
  return hours.length ? Math.min(...hours) : AREA_HOUR[f.area] ?? 30;
}

function rootCauseSections() {
  if (!fs.existsSync(ROOT_CAUSES)) return new Set();
  const text = fs.readFileSync(ROOT_CAUSES, 'utf8');
  return new Set(Array.from(text.matchAll(/^## (RC-\d+)\b/gm), (m) => m[1]));
}

function validate(findings, overrides, errors) {
  const ids = new Set(findings.map((f) => f.id));
  const removed = new Set(Object.entries(overrides)
    .filter(([, o]) => o.mergedInto || o.withdrawn || o.movedTo).map(([id]) => id));
  const sections = rootCauseSections();
  for (const [id, o] of Object.entries(overrides)) {
    const where = `overrides.${id}`;
    if (!ids.has(id)) { errors.push(`${where}: no such finding`); continue; }
    for (const k of Object.keys(o)) {
      if (!REPLACEABLE.includes(k) && !CONTROL.includes(k)) errors.push(`${where}: unknown field "${k}"`);
    }
    if (o.severity !== undefined && !SEVERITIES.includes(o.severity)) errors.push(`${where}: severity "${o.severity}" invalid`);
    if (o.kind !== undefined && !KINDS.includes(o.kind)) errors.push(`${where}: kind "${o.kind}" invalid`);
    if (o.confidence !== undefined && !CONFIDENCE.includes(o.confidence)) errors.push(`${where}: confidence invalid`);
    if (o.foundBy !== undefined && !FOUND_BY.includes(o.foundBy)) errors.push(`${where}: foundBy invalid`);
    for (const k of ['evidence', 'priorIds', 'journeys', 'relatedIds']) {
      if (o[k] !== undefined && !(Array.isArray(o[k]) && o[k].every(isStr))) errors.push(`${where}: ${k} must be an array of strings`);
    }
    const removals = ['mergedInto', 'withdrawn', 'movedTo'].filter((k) => o[k] !== undefined);
    if (removals.length > 1) errors.push(`${where}: only one of mergedInto, withdrawn, movedTo`);
    if (o.movedTo !== undefined && (!MOVED_TO.includes(o.movedTo) || !isStr(o.reason))) {
      errors.push(`${where}: movedTo must be one of ${MOVED_TO.join('|')} with a reason`);
    }
    if (o.withdrawn !== undefined && !isStr(o.withdrawn)) errors.push(`${where}: withdrawn must be a reason string`);
    if (o.mergedInto !== undefined) {
      if (!ids.has(o.mergedInto)) errors.push(`${where}: merge target ${o.mergedInto} does not exist`);
      else if (removed.has(o.mergedInto)) errors.push(`${where}: merge target ${o.mergedInto} is itself removed`);
    }
    const original = findings.find((f) => f.id === id);
    const changed = NEEDS_WHY.some((k) => o[k] !== undefined && o[k] !== original[k]);
    if ((changed || removals.length) && !isStr(o.why)) errors.push(`${where}: "why" required for this change`);
    for (const rel of o.relatedIds || []) {
      if (!ids.has(rel)) errors.push(`${where}: related ${rel} does not exist`);
      else if (removed.has(rel)) errors.push(`${where}: related ${rel} is removed`);
    }
    if (!removals.length && o.rootCause !== undefined && !sections.has(o.rootCause)) {
      errors.push(`${where}: ${o.rootCause} has no section in root-causes.md`);
    }
  }
  for (const f of findings) {
    if (removed.has(f.id)) continue;
    const rc = overrides[f.id] && overrides[f.id].rootCause;
    if (!isStr(rc)) errors.push(`${f.id}: no rootCause`);
  }
  return removed;
}

function apply(findings, overrides, removed) {
  const out = new Map();
  for (const f of findings) {
    const o = overrides[f.id] || {};
    const next = { ...f };
    for (const k of REPLACEABLE) if (o[k] !== undefined) next[k] = o[k];
    if (o.rootCause !== undefined) next.rootCause = o.rootCause;
    out.set(f.id, next);
  }
  const mergedIds = new Map();
  const ordered = Object.keys(overrides).sort(byId);
  for (const id of ordered) {
    const o = overrides[id];
    if (!o.mergedInto) continue;
    const src = out.get(id);
    const target = out.get(o.mergedInto);
    const srcJourneys = [src.journey, ...(src.journeys || [])].filter((j) => isStr(j) && j !== 'prior');
    out.set(o.mergedInto, {
      ...target,
      journeys: uniq([...(target.journeys || []), ...srcJourneys]).filter((j) => j !== target.journey),
      evidence: uniq([...target.evidence, ...src.evidence]),
      priorIds: uniq([...(target.priorIds || []), ...(src.priorIds || [])]),
    });
    mergedIds.set(o.mergedInto, [...(mergedIds.get(o.mergedInto) || []), id]);
  }
  const related = new Map();
  const link = (a, b) => related.set(a, uniq([...(related.get(a) || []), b]));
  for (const id of ordered) {
    if (removed.has(id)) continue;
    for (const rel of overrides[id].relatedIds || []) { link(id, rel); link(rel, id); }
  }
  const kept = [];
  for (const [id, f] of out) {
    if (removed.has(id)) continue;
    const next = { ...f };
    if (!next.journeys || next.journeys.length === 0) delete next.journeys;
    if (mergedIds.has(id)) next.mergedIds = mergedIds.get(id).sort(byId);
    if (related.has(id)) next.relatedIds = related.get(id).sort(byId);
    kept.push(next);
  }
  return kept;
}

function rankAll(kept) {
  const key = (f) => [SEVERITIES.indexOf(f.severity), -journeysOf(f).length || -1, hourOf(f)];
  const sorted = [...kept].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return byId(a.id, b.id);
  });
  return sorted.map((f, i) => ({ ...f, rank: i + 1 }));
}

function main() {
  const errors = [];
  const findings = readJson(FINDINGS);
  if (findings.some((f) => f.rank !== undefined)) {
    console.error('findings.json already carries ranks: run tools/build-findings.cjs, which rebuilds it first');
    process.exit(1);
  }
  const overrides = fs.existsSync(OVERRIDES) ? readJson(OVERRIDES) : {};
  const removed = validate(findings, overrides, errors);
  if (errors.length) {
    console.error(`${errors.length} validation error(s):`);
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  const ranked = rankAll(apply(findings, overrides, removed));
  const withdrawn = Object.keys(overrides).sort(byId)
    .filter((id) => overrides[id].withdrawn || overrides[id].movedTo)
    .map((id) => {
      const o = overrides[id];
      const f = findings.find((x) => x.id === id);
      return { id, title: f.title, disposition: o.movedTo || 'withdrawn', reason: o.movedTo ? o.reason : o.withdrawn };
    });
  writeJson(FINDINGS, ranked);
  writeJson(WITHDRAWN, withdrawn);
  const merged = Object.values(overrides).filter((o) => o.mergedInto).length;
  console.log(`findings before: ${findings.length}; merged ${merged}, removed to withdrawn.json ${withdrawn.length}`);
  console.log(`findings after: ${ranked.length} (${SEVERITIES.map((s) => `${s}=${ranked.filter((f) => f.severity === s).length}`).join(', ')})`);
}

main();
