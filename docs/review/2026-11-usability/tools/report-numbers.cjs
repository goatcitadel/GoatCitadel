#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Prints every number the 2026-11 usability review report states, computed from findings.json, withdrawn.json,
// overrides.json, root-causes.md, the journey files and prior-register.json. Nothing is edited.
//
//   node docs/review/2026-11-usability/tools/report-numbers.cjs            numbers, as text
//   node docs/review/2026-11-usability/tools/report-numbers.cjs --json     the same data as JSON
//   node docs/review/2026-11-usability/tools/report-numbers.cjs --check <report.md>
//        checks the report: journey ids in the table, finding ids exist, stalls in sections 3 and 5,
//        every root cause in section 5, cited paths exist, no personal paths, no em dashes or arrows.
'use strict';
const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(REVIEW_DIR, '..', '..', '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, name), 'utf8'));

const SEVERITIES = ['blocker', 'stall', 'friction', 'polish'];
const RESULTS = ['PASS', 'FAIL', 'PARTLY RUN', 'NOT RUN'];
const JOURNEY_FILES = ['task-6', 'task-7', 'task-8', 'task-9', 'task-10', 'task-11', 'task-12', 'task-13a', 'task-13b',
  'task-14'];
// Register rows the review corrected: apply-verdicts.cjs cannot override a row, so the register keeps the old
// verdicts and root-causes.md ("Register corrections") records the new ones, one bullet per row:
// "- <priorId> (...), recorded `<old>`: should read `<new>`. ... <U- ids it is carried as>".
function loadRegisterCorrections() {
  const text = fs.readFileSync(path.join(REVIEW_DIR, 'root-causes.md'), 'utf8');
  const section = (text.split('## Register corrections')[1] || '').split(/^## /m)[0];
  const out = {};
  for (const lineText of section.split(/\r?\n/)) {
    const m = lineText.match(/^- (\S+) \(.*?should read `([a-z-]+)`/);
    if (!m) continue;
    out[m[1]] = { verdict: m[2], carriedAs: [...new Set(lineText.match(/U-[A-Z]{2}-\d{3}/g) || [])] };
  }
  return out;
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// "GL-T CH-3 ..." is the token sign-in repeat of CH-3, so it counts towards CH-3.
function journeyId(label) {
  const words = String(label || '').trim().split(/\s+/).map((w) => w.replace(/[:.,]$/, ''));
  if (words[0] === 'GL-T' && /^[A-Z]{2}-\d+$/.test(words[1] || '')) return words[1];
  return words[0];
}

function normaliseResult(text) {
  if (/\bFAIL\b/.test(text)) return 'FAIL';
  if (/^PARTLY RUN/.test(text)) return 'PARTLY RUN';
  if (/^NOT RUN/.test(text)) return 'NOT RUN';
  if (/^PASS/.test(text)) return 'PASS';
  throw new Error(`Unrecognised result: ${text}`);
}

// Ids that journey notes use but findings.json does not hold (root-causes.md, "Retired ids").
function loadRetiredIds() {
  const text = fs.readFileSync(path.join(REVIEW_DIR, 'root-causes.md'), 'utf8');
  const section = text.split('## Retired ids')[1] || '';
  const map = {};
  for (const m of section.matchAll(/(U-[A-Z]{2}-\d{3}) is (U-[A-Z]{2}-\d{3})/g)) map[m[1]] = m[2];
  return map;
}

function loadRootCauses() {
  const text = fs.readFileSync(path.join(REVIEW_DIR, 'root-causes.md'), 'utf8');
  const causes = {};
  for (const block of text.split(/^## (?=RC-\d+)/m).slice(1)) {
    const id = block.match(/^(RC-\d+)/)[1];
    const field = (name) => {
      const m = block.match(new RegExp(`^- ${name}: (.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    causes[id] = { id, cause: field('Cause'), owner: field('Owner'), change: field('Smallest change'),
      installs: field('Installs affected') };
  }
  return causes;
}

function parseJourneys(findingIds, mergedInto, retired) {
  const main = [];
  const repeats = [];
  const other = [];
  for (const file of JOURNEY_FILES) {
    const rel = `journeys/${file}.md`;
    const lines = fs.readFileSync(path.join(REVIEW_DIR, rel), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const h = lines[i].match(/^(##|###) (.+)$/);
      if (!h) continue;
      const heading = h[2].trim();
      let resultText = null;
      let findingsLine = '';
      let body = '';
      for (let j = i + 1; j < lines.length && !/^#{2,3} /.test(lines[j]); j += 1) {
        body += `${lines[j]}\n`;
        const r = lines[j].match(/^Result:\s*(.+)$/);
        if (r && resultText === null) resultText = r[1].trim();
        const f = lines[j].match(/^Findings:\s*(.+)$/);
        if (f && !findingsLine) findingsLine = f[1];
      }
      if (resultText === null) continue;
      // A check without a journey id and without a Findings line names its findings in its body.
      const isOther = !/^[A-Z]{2}-[0-9A-Z]+\s/.test(heading);
      const mentioned = [];
      for (const m of (isOther && !findingsLine ? body : `${resultText} ${findingsLine}`).matchAll(/U-[A-Z]{2}-\d{3}/g)) {
        let id = m[0];
        if (file === 'task-7' && id === 'U-CH-001') id = 'U-CH-028'; // Task 7 meant the sticky bar
        id = retired[id] || id;
        id = mergedInto[id] || id;
        if (findingIds.has(id) && !mentioned.includes(id)) mentioned.push(id);
      }
      const entry = { file: rel, heading, result: normaliseResult(resultText), resultText, mentioned };
      const idMatch = heading.match(/^([A-Z]{2}-[0-9A-Z]+)\s+(.*)$/);
      if (h[1] === '###') {
        const base = heading.match(/^([A-Z]{2}-\d+)\s/);
        repeats.push({ ...entry, kind: 'real model', base: base[1] });
      } else if (idMatch && idMatch[1] === 'GL-T' && /^[A-Z]{2}-\d+\s/.test(idMatch[2])) {
        repeats.push({ ...entry, kind: 'token sign-in', base: idMatch[2].split(/\s/)[0] });
      } else if (idMatch) {
        main.push({ ...entry, id: idMatch[1], name: idMatch[2] });
      } else {
        const id = /^Outage/.test(heading) ? 'Outage' : 'ST-none';
        other.push({ ...entry, id, name: heading });
      }
    }
  }
  return { main, repeats, other };
}

function compute() {
  const findings = readJson('findings.json');
  const withdrawn = readJson('withdrawn.json');
  const overrides = readJson('overrides.json');
  const register = readJson('prior-register.json');
  const rootCauses = loadRootCauses();
  const retired = loadRetiredIds();
  const findingIds = new Set(findings.map((f) => f.id));
  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  const mergedInto = {};
  for (const [id, o] of Object.entries(overrides)) if (o && o.mergedInto) mergedInto[id] = o.mergedInto;
  const withdrawnIds = new Set(withdrawn.map((w) => w.id));

  // Findings
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const areas = [...new Set(findings.map((f) => f.area))].sort();
  const byArea = Object.fromEntries(areas.map((a) => [a, Object.fromEntries(SEVERITIES.map((s) =>
    [s, findings.filter((f) => f.area === a && f.severity === s).length]))]));
  const confidence = countBy(findings, (f) => f.confidence);
  const foundBy = countBy(findings, (f) => f.foundBy);
  const likely = findings.filter((f) => f.confidence === 'likely');
  const likelyBySeverity = countBy(likely, (f) => f.severity);
  const seenLive = findings.filter((f) => f.foundBy === 'live' || f.foundBy === 'both').length;
  const codeOnly = findings.filter((f) => f.foundBy === 'code').length;
  const carried = findings.filter((f) => (f.priorIds || []).length > 0).length;

  // Root causes
  const rcIds = Object.keys(rootCauses).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const rc = rcIds.map((id) => {
    const members = findings.filter((f) => f.rootCause === id).sort((a, b) => a.rank - b.rank);
    return { id, count: members.length, severities: countBy(members, (f) => f.severity),
      ids: members.map((f) => f.id), bestRank: members.length ? members[0].rank : null };
  });
  const rcMulti = rc.filter((r) => r.count > 1).length;
  const unassigned = findings.filter((f) => !rootCauses[f.rootCause]).map((f) => f.id);

  // Journeys
  const journeys = parseJourneys(findingIds, mergedInto, retired);
  const linked = {};
  for (const f of findings) {
    for (const label of [f.journey, ...(f.journeys || [])]) {
      const id = journeyId(label);
      if (!linked[id]) linked[id] = [];
      if (!linked[id].includes(f.id)) linked[id].push(f.id);
    }
  }
  const rankOf = (id) => byId[id].rank;
  for (const j of [...journeys.main, ...journeys.other]) {
    const ids = [...new Set([...(linked[j.id] || []), ...j.mentioned])].sort((a, b) => rankOf(a) - rankOf(b));
    j.findings = ids;
  }
  const mainResults = Object.fromEntries(RESULTS.map((r) => [r, journeys.main.filter((j) => j.result === r).length]));
  const failedWithStall = journeys.main.filter((j) => j.result === 'FAIL'
    && j.findings.some((id) => byId[id].severity === 'stall')).map((j) => j.id);
  const repeatResults = {};
  for (const kind of ['real model', 'token sign-in']) {
    const set = journeys.repeats.filter((j) => j.kind === kind);
    repeatResults[kind] = { total: set.length,
      ...Object.fromEntries(RESULTS.map((r) => [r, set.filter((j) => j.result === r).length])) };
  }
  const noJourney = findings.filter((f) => journeyId(f.journey) === 'prior' && !(f.journeys || []).length).length;

  // Register
  const sources = [...new Set(register.map((r) => String(r.source)))];
  const verdicts = ['fixed', 'partial', 'open', 'obsolete', 'operator-only', 'cannot-check'];
  const registerTable = Object.fromEntries(sources.map((s) => [s, Object.fromEntries(verdicts.map((v) =>
    [v, register.filter((r) => String(r.source) === s && r.verdict === v).length]))]));
  const verdictTotals = Object.fromEntries(verdicts.map((v) => [v, register.filter((r) => r.verdict === v).length]));
  const corrections = loadRegisterCorrections();
  const corrected = register.map((r) => (corrections[r.priorId]
    ? { ...r, ...corrections[r.priorId], corrected: true }
    : { ...r, carriedAs: r.carriedAs ? [r.carriedAs] : [] }));
  const correctedTotals = Object.fromEntries(verdicts.map((v) => [v, corrected.filter((r) => r.verdict === v).length]));
  const rawOpenOrPartial = register.filter((r) => r.verdict === 'open' || r.verdict === 'partial').length;
  // Still open or partly open, after the corrections; a row can be carried by more than one finding.
  const stillOpen = corrected.filter((r) => r.verdict === 'open' || r.verdict === 'partial').map((r) => {
    const nows = r.carriedAs.map((id) => mergedInto[id] || id);
    const stateOf = (id) => (findingIds.has(id) ? 'finding' : withdrawnIds.has(id)
      ? withdrawn.find((w) => w.id === id).disposition : 'missing');
    const states = [...new Set(nows.map(stateOf))];
    return { priorId: r.priorId, source: String(r.source), verdict: r.verdict, title: r.title,
      carriedAs: r.carriedAs, nows, state: states.length === 1 ? states[0] : states.join('+'),
      corrected: Boolean(r.corrected) };
  });
  const stillOpenStates = countBy(stillOpen, (r) => r.state);
  const stillOpenDistinctFindings = new Set(stillOpen.filter((r) => r.state === 'finding').flatMap((r) => r.nows)).size;
  const operatorRows = register.filter((r) => r.verdict === 'operator-only' || r.verdict === 'cannot-check')
    .map((r) => r.priorId);

  // Withdrawn
  const withdrawnByDisposition = countBy(withdrawn, (w) => w.disposition);
  const merged = findings.flatMap((f) => (f.mergedIds || []).map((m) => ({ from: m, into: f.id })));

  // Stalls
  const stalls = findings.filter((f) => f.severity === 'stall').sort((a, b) => a.rank - b.rank).map((f) => ({
    id: f.id, rank: f.rank, rootCause: f.rootCause, confidence: f.confidence, foundBy: f.foundBy,
    installs: (rootCauses[f.rootCause] || {}).installs,
    // Which installs meet it: from the cause's "Installs affected" line; a likely (code-only) stall stands apart.
    group: /more than one workspace/.test((rootCauses[f.rootCause] || {}).installs || '') ? 'more than one workspace'
      : f.confidence === 'likely' ? 'read in code only' : 'every install' }));
  for (const s of stalls) s.line = `  ${s.rank} ${s.id} ${s.rootCause} ${s.confidence}/${s.foundBy} [${s.group}]`;

  return { findings: { total: findings.length, bySeverity, byArea, confidence, foundBy, likely: likely.length,
    likelyBySeverity, seenLive, codeOnly, carried, noJourney },
  rootCauses: { total: rcIds.length, withMoreThanOne: rcMulti, unassigned, list: rc },
  journeys: { mainTotal: journeys.main.length, mainResults, failedWithStall, repeatResults, main: journeys.main,
    repeats: journeys.repeats, other: journeys.other },
  register: { rows: register.length, sources, table: registerTable, verdictTotals, correctedTotals,
    corrections, rawOpenOrPartial, openOrPartial: stillOpen.length, stillOpenStates, stillOpenDistinctFindings,
    stillOpen, operatorOrCannotCheck: operatorRows.length },
  withdrawn: { total: withdrawn.length, byDisposition: withdrawnByDisposition, merged },
  stalls, data: { findings, withdrawn, rootCauses, mergedInto, retired } };
}

function printText(n) {
  const out = [];
  const line = (s) => out.push(s.replace(/\s+$/, ''));
  const f = n.findings;
  line(`findings: ${f.total}`);
  line(`  by severity: ${SEVERITIES.map((s) => `${s} ${f.bySeverity[s]}`).join(', ')}`);
  line(`  confidence: confirmed ${f.confidence.confirmed || 0}, likely ${f.likely}` +
    ` (likely by severity: ${SEVERITIES.map((s) => `${s} ${f.likelyBySeverity[s] || 0}`).join(', ')})`);
  line(`  found by: live ${f.foundBy.live || 0}, both ${f.foundBy.both || 0}, code ${f.foundBy.code || 0}` +
    ` (seen live, live or both: ${f.seenLive}; read in code only: ${f.codeOnly})`);
  line(`  carried from earlier reviews (priorIds set): ${f.carried}; with no journey of this review: ${f.noJourney}`);
  line('  by area (stall / friction / polish / total):');
  for (const [a, s] of Object.entries(f.byArea)) {
    line(`    ${a}: ${s.stall} / ${s.friction} / ${s.polish} / ${s.blocker + s.stall + s.friction + s.polish}`);
  }
  line('');
  const groups = countBy(n.stalls, (s) => s.group);
  line(`stalls (${n.stalls.length}): ${Object.entries(groups).map(([k, v]) => `${k} ${v}`).join(', ')}; in rank order:`);
  for (const s of n.stalls) line(s.line);
  line('');
  const r = n.rootCauses;
  line(`root causes: ${r.total}; with more than one finding: ${r.withMoreThanOne}; findings without a cause: ${r.unassigned.length}`);
  for (const c of [...r.list].sort((a, b) => b.count - a.count || a.bestRank - b.bestRank)) {
    const sev = SEVERITIES.filter((s) => c.severities[s]).map((s) => `${s} ${c.severities[s]}`).join(', ');
    line(`  ${c.id}: ${c.count} (${sev})`);
  }
  line('');
  const j = n.journeys;
  line(`journeys walked in the area reviews: ${j.mainTotal}`);
  line(`  ${RESULTS.map((x) => `${x} ${j.mainResults[x]}`).join(', ')}`);
  line(`  failed journeys that involve a stall: ${j.failedWithStall.length} (${j.failedWithStall.join(', ')})`);
  for (const [kind, s] of Object.entries(j.repeatResults)) {
    line(`  repeated with ${kind}: ${s.total} (${RESULTS.map((x) => `${x} ${s[x]}`).join(', ')})`);
  }
  line(`  other checks: ${j.other.map((o) => `${o.id} ${o.result} [${o.findings.join(' ')}]`).join(', ')}`);
  for (const m of j.main) line(`  ${m.id} ${m.result} [${m.findings.length}] ${m.findings.join(' ')}`);
  line('');
  const g = n.register;
  line(`earlier-review register: ${g.rows} rows`);
  for (const s of g.sources) {
    line(`  ${s}: ${Object.entries(g.table[s]).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  line(`  totals: ${Object.entries(g.verdictTotals).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  line(`  open or partial as recorded: ${g.rawOpenOrPartial} rows`);
  line(`  corrections (root-causes.md "Register corrections"): ${Object.entries(g.corrections).map(([k, v]) => `${k} ${v.verdict} ${v.carriedAs.join('+')}`).join('; ')}`);
  line(`  totals with the ${Object.keys(g.corrections).length} corrections: ${Object.entries(g.correctedTotals).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  line(`  open or partial after corrections: ${g.openOrPartial} rows; now: ${Object.entries(g.stillOpenStates).map(([k, v]) => `${k} ${v}`).join(', ')}; distinct current findings: ${g.stillOpenDistinctFindings}`);
  line(`  operator-only or cannot-check rows: ${g.operatorOrCannotCheck}`);
  line('');
  const w = n.withdrawn;
  line(`withdrawn.json: ${w.total} (${Object.entries(w.byDisposition).map(([k, v]) => `${k} ${v}`).join(', ')}); merged into another finding: ${w.merged.map((m) => `${m.from} into ${m.into}`).join(', ')}`);
  return out.join('\n');
}

// ---- report checks ----
function sections(text) {
  const parts = {};
  for (const block of text.split(/^## (?=\d+\.)/m).slice(1)) parts[block.match(/^(\d+)\./)[1]] = block;
  return parts;
}

function check(reportPath, n) {
  const problems = [];
  const text = fs.readFileSync(reportPath, 'utf8');
  const sec = sections(text);
  const { findings, withdrawn, rootCauses, mergedInto } = n.data;
  const known = new Set([...findings.map((f) => f.id), ...withdrawn.map((w) => w.id), ...Object.keys(mergedInto),
    'U-CH-029']);
  // 1. Journey table
  const table = sec['2'] || '';
  const ids = new Set([...n.journeys.main.map((m) => m.id), ...n.journeys.repeats.map((r) => r.base)]);
  for (const id of ids) if (!table.includes(`| ${id} |`)) problems.push(`journey ${id} missing from the journey table`);
  // 2. Finding ids
  for (const m of text.matchAll(/U-[A-Z]{2}-\d{3}/g)) if (!known.has(m[0])) problems.push(`unknown finding id ${m[0]}`);
  // 3. Stalls in sections 3 and 5
  for (const s of n.stalls) {
    if (!(sec['3'] || '').includes(s.id)) problems.push(`stall ${s.id} missing from section 3`);
    if (!(sec['5'] || '').includes(s.id)) problems.push(`stall ${s.id} missing from section 5`);
  }
  // 4. Every root cause in a fix batch
  for (const id of Object.keys(rootCauses)) {
    if (!new RegExp(`\\b${id}\\b`).test(sec['5'] || '')) problems.push(`${id} not in any fix batch`);
  }
  // 5. Paths
  const dir = path.dirname(reportPath);
  const checked = new Set();
  for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(m[1])) continue;
    const p = path.resolve(dir, m[1]);
    checked.add(m[1]);
    if (!fs.existsSync(p)) problems.push(`link target missing: ${m[1]}`);
  }
  for (const m of text.matchAll(/`([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@<>*-]+)+\/?)(?::\d+(?:-\d+)?)?`/g)) {
    const rel = m[1];
    if (/[<>*]/.test(rel) || checked.has(rel)) continue;
    if (!/^(apps|packages|scripts|config|docs|skills)\//.test(rel)) continue;
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) problems.push(`path missing: ${rel}`);
  }
  // 6. Hygiene
  if (/[A-Za-z]:[\\/](Users|personal-ai|code)/i.test(text)) problems.push('drive-letter or user-profile path');
  if (/\/[a-z]\/(Users|personal-ai|code)\//i.test(text)) problems.push('MSYS-style personal path');
  if (/—/.test(text)) problems.push('em dash');
  if (/[←-⇿]|->|=>/.test(text)) problems.push('arrow characters');
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const n = compute();
  if (args[0] === '--json') {
    const { data: _data, ...rest } = n;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    return;
  }
  if (args[0] === '--check') {
    const target = args[1] ? path.resolve(args[1]) : path.join(REVIEW_DIR, '..', '2026-11-usability-review.md');
    const problems = check(target, n);
    for (const p of problems) console.log(`FAIL ${p}`);
    console.log(problems.length ? `${problems.length} problem(s)` : 'report checks: all passed');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  console.log(printText(n));
}

if (require.main === module) main();
else module.exports = { compute };
