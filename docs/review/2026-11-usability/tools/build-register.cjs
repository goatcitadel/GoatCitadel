#!/usr/bin/env node
// Builds docs/review/2026-11-usability/prior-register.json from the earlier review sources.
//
// Usage (every input is a path argument; nothing is baked in):
//   node build-register.cjs \
//     --ledger <remediation-ledger.json> \
//     --followup-data <followup-data.js> --followup-status <followup-status.js> \
//     --comp-ledger <findings-ledger-closure-N.json> --comp-areas <prior-comp-areas.json> \
//     --parity <classic-parity-inventory.json> \
//     --owed <prior-owed-live.json> \
//     [--merges <prior-merges.json>] \
//     --out <prior-register.json> [--candidates <file>]
//
// It prints a count table (source, rows in source, fixed and skipped, out of scope and skipped,
// imported, merged away, final). The final column sums to the register length.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, "")] = args[i + 1];
for (const key of ["ledger", "followup-data", "followup-status", "comp-ledger", "comp-areas", "parity", "owed", "out"]) {
  if (!opt[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
const clip = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const firstSentence = (text, max = 150) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const cut = flat.search(/[.!?](\s|$)/);
  return clip(cut > 20 && cut < max ? flat.slice(0, cut + 1) : flat, max);
};

const AREAS = new Set(["chat", "projects", "inbox", "work", "capabilities", "library", "system", "settings", "first-run", "messaging", "global"]);
const stats = {}; // source key -> counts
const stat = (key) => (stats[key] ??= { inSource: 0, fixedSkipped: 0, scopeSkipped: 0, imported: 0, mergedAway: 0, final: 0, label: key });

// ---- source 1: ledger-233 ----
const LEDGER_AREA = { CH: "chat", IN: "inbox", WK: "work", LB: "library", SY: "system", ST: "settings", FR: "first-run", NV: "global", GL: "global" };
const N_AREA = { "N-01": "global", "N-02": "global", "N-03": "settings", "N-04": "system", "N-05": "global", "N-06": "system", "N-07": "inbox", "N-08": "chat", "N-09": "settings", "N-10": "chat", "N-11": "settings", "N-12": "system", "N-13": "global", "N-14": "chat" };
function importLedger() {
  const s = stat("ledger-233");
  s.label = "ledger-233";
  const rows = [];
  for (const f of readJson(opt.ledger).findings) {
    s.inSource += 1;
    const area = N_AREA[f.id] ?? LEDGER_AREA[f.id.split("-")[0]];
    rows.push({
      priorId: f.id,
      source: "ledger-233",
      title: f.title,
      severity: f.severity,
      area,
      criterion: f.acceptance_criterion ?? null,
      sourceStatus: { sourceStatus: f.source_status, implementation: f.current_implementation_status, workstream: f.source_workstream },
    });
    s.imported += 1;
  }
  return rows;
}

// ---- source 2: followup-157 (new 157 findings + older 206 re-check) ----
const FU_SEV = { c: "Critical", h: "High", m: "Medium", l: "Low" };
const FU_AREA = { Global: "global", Shell: "global", Chat: "chat", Work: "work", Inbox: "inbox", System: "system", Library: "library", Settings: "settings" };
function loadFollowup() {
  const window = {};
  const context = vm.createContext({ window, console: { log() {} } });
  vm.runInContext(fs.readFileSync(path.resolve(opt["followup-data"]), "utf8"), context, { timeout: 5000 });
  vm.runInContext(fs.readFileSync(path.resolve(opt["followup-status"]), "utf8"), context, { timeout: 5000 });
  return window;
}
function importFollowup() {
  const w = loadFollowup();
  const status = w.STATUS ?? {};
  const rows = [];
  const open = new Set(["open", "partial", "deferred", "regressed"]);
  const make = (item, origin) => {
    const st = status[item.id];
    const effective = st ? st.state : item.verdict;
    const kind = origin === "new" ? stat("followup-157/new-157") : stat("followup-157/older-206");
    kind.inSource += 1;
    if (!open.has(effective)) {
      kind.fixedSkipped += 1;
      return;
    }
    kind.imported += 1;
    rows.push({
      priorId: item.id,
      source: "followup-157",
      origin,
      title: firstSentence(item.problem),
      severity: FU_SEV[item.sev] ?? item.sev,
      area: FU_AREA[item.area],
      criterion: item.fix ?? null,
      loc: item.loc ?? null,
      sourceStatus: {
        state: effective,
        reviewVerdict: item.verdict ?? null,
        pr: st?.pr ?? null,
        note: st?.note ?? st?.seen ?? null,
      },
      sourceEvidence: item.evidence ?? null,
    });
  };
  for (const item of w.FINDINGS) make(item, "new");
  for (const item of w.VERIFY) make(item, "older-206");
  return rows;
}

// ---- source 3: comprehensive-138 ----
const COMP_SEV = { P1: "High", P2: "Medium", P3: "Low" };
function importComprehensive() {
  const s = stat("comprehensive-138");
  const scope = readJson(opt["comp-areas"]);
  const rows = [];
  const seen = new Set();
  for (const f of readJson(opt["comp-ledger"]).findings) {
    s.inSource += 1;
    seen.add(f.stableId);
    if (scope.skip[f.stableId]) {
      s.scopeSkipped += 1;
      continue;
    }
    const area = scope.import[f.stableId];
    if (!area) throw new Error(`comprehensive row ${f.stableId} is in neither the import nor the skip list`);
    s.imported += 1;
    rows.push({
      priorId: f.stableId,
      source: "comprehensive-138",
      title: f.title ?? firstSentence(f.trigger, 140),
      severity: COMP_SEV[f.severity] ?? f.severity,
      area,
      criterion: f.expected ?? null,
      loc: (f.owners ?? []).map((o) => o.file ?? o).slice(0, 3).join("; ") || null,
      sourceStatus: { sourceSeverity: f.severity, disposition: f.disposition?.status ?? null },
    });
  }
  for (const id of [...Object.keys(scope.import), ...Object.keys(scope.skip)]) {
    if (!seen.has(id)) throw new Error(`comp-areas names ${id}, which is not in the ledger`);
  }
  return rows;
}

// ---- source 4: parity-routes ----
function importParity() {
  const s = stat("parity-routes");
  const rows = [];
  const bareAreaRoots = new Set(["/chat", "/library", "/inbox", "/system", "/settings", "/work"]);
  for (const r of readJson(opt.parity).routes) {
    s.inSource += 1;
    const dest = r.native_destination;
    const bare = bareAreaRoots.has(dest.split("#")[0]) && r.legacy_url.split("?")[0] !== dest.split("#")[0];
    const anchored = dest.includes("#");
    const experimental = r.release_scope?.status === "experimental";
    // A route is imported when its Cockpit destination is not a dedicated page: folded into an area root
    // (missing own screen), a section of a combined page (partial), or experimental.
    if (!(bare || anchored || experimental)) {
      s.scopeSkipped += 1;
      continue;
    }
    const first = dest.split("#")[0].split("/")[1];
    const area = dest.startsWith("/chat/projects") ? "projects" : first;
    if (!AREAS.has(area)) throw new Error(`parity route ${r.id}: unknown area ${area}`);
    s.imported += 1;
    rows.push({
      priorId: `PR-${r.id.replace(/[^a-z0-9]+/gi, "-")}`,
      source: "parity-routes",
      title: `Classic route ${r.legacy_url} has ${bare ? "no dedicated Cockpit screen" : anchored ? "only a section of a combined Cockpit page" : "an experimental Cockpit screen"} (${dest})`,
      severity: "Medium",
      area,
      criterion: r.release_scope?.release_action ?? null,
      loc: r.legacy_url,
      sourceStatus: { destinationStatus: r.destination_status, releaseScope: r.release_scope?.status ?? null, nativeDestination: dest, classicFallback: r.classic_fallback },
    });
  }
  return rows;
}

// ---- source 5: owed-live ----
function importOwed() {
  const s = stat("owed-live");
  const rows = [];
  readJson(opt.owed).forEach((o, index) => {
    s.inSource += 1;
    if (!AREAS.has(o.area)) throw new Error(`owed row ${index + 1}: unknown area ${o.area}`);
    s.imported += 1;
    rows.push({
      priorId: `OL-${String(index + 1).padStart(2, "0")}`,
      source: "owed-live",
      title: o.title,
      severity: "n/a",
      area: o.area,
      criterion: o.criterion ?? null,
      sourceStatus: { sourceRef: o.sourceRef },
    });
  });
  return rows;
}

// ---- assemble ----
const SHORT = { "ledger-233": "led", "followup-157": "fu", "comprehensive-138": "comp", "parity-routes": "par", "owed-live": "ol" };
const all = [...importLedger(), ...importFollowup(), ...importComprehensive(), ...importParity(), ...importOwed()];
const taken = new Set();
let rows = all.map((row) => {
  let id = row.priorId;
  if (taken.has(id)) id = `${row.priorId}~${row.origin === "older-206" ? "fu206" : SHORT[row.source]}`;
  if (taken.has(id)) throw new Error(`cannot disambiguate ${row.priorId}`);
  taken.add(id);
  return { ...row, priorId: id, ...(id !== row.priorId ? { sourceId: row.priorId } : {}) };
});

// ---- merges (Step 6) ----
const sourceKey = (row) => (row.source === "followup-157" ? (row.origin === "new" ? "followup-157/new-157" : "followup-157/older-206") : row.source);
const byId = new Map(rows.map((r) => [r.priorId, r]));
const merged = new Set();
const mergeConfig = opt.merges ? readJson(opt.merges) : { merge: [], seeAlso: [] };
for (const m of mergeConfig.merge) {
  const primary = byId.get(m.primary);
  if (!primary) throw new Error(`merge primary ${m.primary} not in register`);
  for (const id of m.with) {
    const other = byId.get(id);
    if (!other) throw new Error(`merge member ${id} not in register`);
    if (merged.has(id) || id === m.primary) throw new Error(`merge member ${id} used twice`);
    merged.add(id);
    stat(sourceKey(other)).mergedAway += 1;
    primary.priorIds = [...(primary.priorIds ?? []), id];
    const sources = Array.isArray(primary.source) ? primary.source : [primary.source];
    if (!sources.includes(other.source)) primary.source = [...sources, other.source];
    primary.mergeReason = m.reason;
    primary.mergedTitles = [...(primary.mergedTitles ?? []), other.title];
    if (primary.severity === "n/a" || (other.severity === "Critical" && primary.severity !== "Critical")) primary.severity = other.severity;
    if (!primary.criterion && other.criterion) primary.criterion = other.criterion;
    primary.mergedFrom = [...(primary.mergedFrom ?? []), { priorId: id, source: other.source, severity: other.severity, criterion: other.criterion ?? null }];
  }
}
for (const group of mergeConfig.seeAlso) {
  for (const id of group.ids) {
    const row = byId.get(id);
    if (!row) throw new Error(`seeAlso ${id} not in register`);
    row.seeAlso = [...new Set([...(row.seeAlso ?? []), ...group.ids.filter((x) => x !== id)])];
  }
}
rows = rows.filter((r) => !merged.has(r.priorId));

// ---- final row shape ----
const register = rows.map((r) => {
  const out = {
    priorId: r.priorId,
    ...(r.priorIds ? { priorIds: r.priorIds } : {}),
    source: r.source,
    title: r.title,
    severity: r.severity,
    area: r.area,
    criterion: r.criterion ?? null,
    verdict: null,
    evidence: "",
    note: "",
    carriedAs: null,
  };
  for (const key of ["origin", "sourceId", "loc", "seeAlso", "mergeReason", "mergedFrom", "sourceStatus", "sourceEvidence"]) {
    if (r[key] !== undefined && r[key] !== null) out[key] = r[key];
  }
  return out;
});
for (const row of register) {
  if (!AREAS.has(row.area)) throw new Error(`${row.priorId}: bad area ${row.area}`);
  stat(sourceKey({ source: Array.isArray(row.source) ? row.source[0] : row.source, origin: row.origin })).final += 1;
}
const ids = register.map((r) => r.priorId);
if (new Set(ids).size !== ids.length) throw new Error("duplicate priorId in register");
fs.writeFileSync(path.resolve(opt.out), `${JSON.stringify(register, null, 2)}\n`);

// ---- candidates for merge review (optional) ----
if (opt.candidates) {
  const stop = new Set("the a an and or of to in on for is are was be it its that this with as by from at not no can when still but into than then so if do does only any all more one two".split(" "));
  const tok = (text) => new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 3 && !stop.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
  const toks = register.map((r) => ({ r, t: tok(`${r.title} ${r.criterion ?? ""}`) }));
  const lines = [];
  for (let i = 0; i < toks.length; i += 1) {
    for (let j = i + 1; j < toks.length; j += 1) {
      const a = toks[i];
      const b = toks[j];
      if (a.r.area !== b.r.area) continue;
      const sa = sourceKey({ source: [].concat(a.r.source)[0], origin: a.r.origin });
      const sb = sourceKey({ source: [].concat(b.r.source)[0], origin: b.r.origin });
      if (sa === sb) continue;
      const inter = [...a.t].filter((w) => b.t.has(w)).length;
      const score = inter / (a.t.size + b.t.size - inter || 1);
      if (score >= 0.1 && inter >= 2) lines.push({ score, text: `${score.toFixed(2)}  ${a.r.priorId} <> ${b.r.priorId}\n    A: ${clip(a.r.title, 200)}\n    B: ${clip(b.r.title, 200)}` });
    }
  }
  lines.sort((x, y) => y.score - x.score);
  fs.writeFileSync(path.resolve(opt.candidates), `${lines.map((l) => l.text).join("\n")}\n`);
}

// ---- count table ----
const order = ["ledger-233", "followup-157/new-157", "followup-157/older-206", "comprehensive-138", "parity-routes", "owed-live"];
const tot = { inSource: 0, fixedSkipped: 0, scopeSkipped: 0, imported: 0, mergedAway: 0, final: 0 };
const out = ["| source | rows in source | already fixed, skipped | out of scope, skipped | imported | merged away | final |", "|---|---|---|---|---|---|---|"];
for (const key of order) {
  const s = stat(key);
  out.push(`| ${key} | ${s.inSource} | ${s.fixedSkipped} | ${s.scopeSkipped} | ${s.imported} | ${s.mergedAway} | ${s.final} |`);
  for (const k of Object.keys(tot)) tot[k] += s[k];
}
out.push(`| total | ${tot.inSource} | ${tot.fixedSkipped} | ${tot.scopeSkipped} | ${tot.imported} | ${tot.mergedAway} | ${tot.final} |`);
console.log(out.join("\n"));
console.log(`register rows: ${register.length}`);
console.log(`check: imported - merged away = ${tot.imported - tot.mergedAway}; final sum = ${tot.final}; ${tot.final === register.length && tot.imported - tot.mergedAway === tot.final ? "OK" : "MISMATCH"}`);
const byArea = {};
for (const row of register) byArea[row.area] = (byArea[row.area] ?? 0) + 1;
console.log(`by area: ${Object.entries(byArea).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (tot.final !== register.length) process.exit(1);
