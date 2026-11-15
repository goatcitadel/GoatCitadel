#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Usage: node docs/review/2026-11-usability/tools/phase1-summary.cjs
// Reads prior-register.json and findings.json (one directory up) and writes phase-1-summary.md next to them.
// Deterministic: no dates, stable ordering. Re-run after any verdict changes.
// Only findings whose journey is "prior" count as carried findings.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}
function load(name) {
  const file = path.join(root, name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`phase1-summary: cannot read ${name}: ${error.message}`);
  }
  if (!Array.isArray(data)) fail(`phase1-summary: ${name} must hold a JSON array`);
  return data;
}

const rows = load("prior-register.json");
const findings = load("findings.json").filter((f) => f.journey === "prior");

const VERDICTS = ["fixed", "open", "partial", "operator-only", "cannot-check", "obsolete"];
const SEVERITIES = ["blocker", "stall", "friction", "polish"];
const AREA_ORDER = [
  "chat", "inbox", "work", "projects", "capabilities", "library",
  "system", "settings", "first-run", "messaging", "global",
];

for (const r of rows) {
  if (!VERDICTS.includes(r.verdict)) fail(`phase1-summary: prior-register.json row ${r.priorId} has unknown verdict ${JSON.stringify(r.verdict)}`);
}
for (const f of findings) {
  if (!SEVERITIES.includes(f.severity)) fail(`phase1-summary: findings.json ${f.id} has unknown severity ${JSON.stringify(f.severity)}`);
}

const esc = (value) => String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const areaRank = (area) => {
  const i = AREA_ORDER.indexOf(area);
  return i === -1 ? AREA_ORDER.length : i;
};
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byArea = (a, b) => areaRank(a) - areaRank(b) || byCode(a, b);
const sourceLabel = (row) => (Array.isArray(row.source) ? [...row.source].sort(byCode).join(" + ") : String(row.source));
const noteOf = (row) => String(row.note ?? "");
const count = (list, pred) => list.filter(pred).length;
// Truncated source titles end in "..", "….", etc.: show a single ellipsis.
const clean = (title) => String(title ?? "").replace(/[.…]{2,}$/, "…");

function table(header, body) {
  const lines = [`| ${header.map(esc).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const cells of body) lines.push(`| ${cells.map(esc).join(" | ")} |`);
  return lines.join("\n");
}

function verdictTable(label, keys) {
  const body = keys.map((key) => {
    const subset = rows.filter((row) => key.match(row));
    return [key.name, ...VERDICTS.map((v) => count(subset, (r) => r.verdict === v)), subset.length];
  });
  const totals = ["Total", ...VERDICTS.map((v) => count(rows, (r) => r.verdict === v)), rows.length];
  return table([label, ...VERDICTS, "Total"], [...body, totals]);
}

// Split "lead 1) a 2) b 3) c" into a lead and items, only when the note literally holds a
// consecutive 1., 2., ... (or 1), 2), ...) run. Otherwise return null.
function numberedRun(note) {
  const marker = /(?:^|\s)(\d+)([.)])\s/g;
  const hits = [];
  let m;
  while ((m = marker.exec(note)) !== null) hits.push({ n: Number(m[1]), style: m[2], start: m.index, end: marker.lastIndex });
  for (let s = 0; s < hits.length; s += 1) {
    if (hits[s].n !== 1) continue;
    const run = [hits[s]];
    for (let k = s + 1; k < hits.length; k += 1) {
      const last = run[run.length - 1];
      if (hits[k].n === last.n + 1 && hits[k].style === last.style) run.push(hits[k]);
    }
    if (run.length < 2) continue;
    const lead = note.slice(0, run[0].start).trim();
    const items = run.map((h, i) => note.slice(h.end, i + 1 < run.length ? run[i + 1].start : note.length).trim());
    return { lead, items };
  }
  return null;
}

function noteBlock(row) {
  const lines = [`**${esc(clean(row.title))}** (${esc(row.priorId)})`, ""];
  const note = noteOf(row);
  const run = numberedRun(note);
  if (!run) {
    lines.push(note.replace(/\r?\n/g, " "));
  } else {
    if (run.lead) lines.push(run.lead, "");
    run.items.forEach((item, i) => lines.push(`${i + 1}. ${item.replace(/\r?\n/g, " ")}`));
  }
  lines.push("");
  return lines;
}

const out = [];
const total = rows.length;
const n = (v) => count(rows, (r) => r.verdict === v);
const openCount = n("open");
const partialCount = n("partial");

out.push("# Phase 1 close-out summary", "");
out.push(
  `We re-tested ${total} findings from the earlier reviews. ${n("fixed")} are fixed. ` +
    `${openCount + partialCount} are still open or partly open (${openCount} open, ${partialCount} partly open). ` +
    `${n("operator-only")} need you, because they require a real account, device or installed app. ` +
    `${n("cannot-check")} could not be checked here. ${n("obsolete")} are obsolete because the screen or feature no longer exists. ` +
    `${findings.length} findings carry forward into the new review (${SEVERITIES.map((v) => `${count(findings, (f) => f.severity === v)} ${v}`).join(", ")}).`,
  "",
);

out.push("## How to read this", "");
out.push(
  "- **Ids.** Each earlier finding keeps its original id. `OL-…` is a live check that an earlier merged change still owed. " +
    "`PR-…` is an old Classic screen that was checked for an equivalent in the Cockpit. " +
    "Ids ending `~fu206` are rows from the older 206-finding audit. " +
    "`U-…` is a finding carried into this review.",
  "- **Phase 2** is the fresh, area-by-area review that follows this close-out.",
  "- **Task N** in a note is a later step of this same review.",
  "- **The controller** is the agent that coordinates the review.",
  "",
);

const sources = [...new Set(rows.map(sourceLabel))].sort(byCode);
out.push("## Verdicts by source", "");
out.push(verdictTable("Source", sources.map((s) => ({ name: s, match: (r) => sourceLabel(r) === s }))), "");

const rowAreas = [...new Set(rows.map((r) => r.area))].sort(byArea);
out.push("## Verdicts by area", "");
out.push(verdictTable("Area", rowAreas.map((a) => ({ name: a, match: (r) => r.area === a }))), "");

// Carried findings
out.push("## Carried findings", "");
out.push(`${findings.length} findings carry forward into the new review. Counts by area and severity:`, "");
const fAreas = [...new Set(findings.map((f) => f.area))].sort(byArea);
const fBody = fAreas.map((a) => {
  const subset = findings.filter((f) => f.area === a);
  return [a, ...SEVERITIES.map((s) => count(subset, (f) => f.severity === s)), subset.length];
});
fBody.push(["Total", ...SEVERITIES.map((s) => count(findings, (f) => f.severity === s)), findings.length]);
out.push(table(["Area", ...SEVERITIES, "Total"], fBody), "");

const sortFindings = (a, b) => byArea(a.area, b.area) || byCode(a.id, b.id);
const severe = findings
  .filter((f) => f.severity === "blocker" || f.severity === "stall")
  .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || sortFindings(a, b));
out.push("### Every blocker and stall", "");
if (severe.length === 0) out.push("None.", "");
else {
  out.push(
    table(
      ["Id", "Severity", "Title", "Earlier ids", "Trigger"],
      severe.map((f) => [f.id, f.severity, clean(f.title), (f.priorIds || []).join(", "), f.trigger]),
    ),
    "",
  );
}

const friction = findings.filter((f) => f.severity === "friction").sort(sortFindings);
out.push("### Friction findings by area", "");
for (const a of [...new Set(friction.map((f) => f.area))].sort(byArea)) {
  out.push(`#### ${a}`, "");
  out.push(
    table(
      ["Id", "Title", "Earlier ids", "Trigger"],
      friction.filter((f) => f.area === a).map((f) => [f.id, clean(f.title), (f.priorIds || []).join(", "), f.trigger]),
    ),
    "",
  );
}

// Clusters
out.push("## Where open rows cluster", "");
const cluster = rowAreas
  .map((a) => {
    const subset = rows.filter((r) => r.area === a);
    const live = count(subset, (r) => r.verdict === "open" || r.verdict === "partial");
    return { area: a, live, rows: subset.length, share: subset.length ? (live / subset.length) * 100 : 0 };
  })
  .sort((a, b) => b.live - a.live || byArea(a.area, b.area));
out.push(
  table(
    ["Area", "Open + partly open", "Rows in area", "Share of area"],
    cluster.map((c) => [c.area, c.live, c.rows, `${c.share.toFixed(1)}%`]),
  ),
  "",
);
const top = cluster.slice(0, 3);
const topShare = [...cluster].sort((a, b) => b.share - a.share || byArea(a.area, b.area))[0];
out.push(
  `Most open and partly open rows sit in ${top[0].area} (${top[0].live}), ${top[1].area} (${top[1].live}) and ${top[2].area} (${top[2].live}). ` +
    `Measured as a share of its own rows, ${topShare.area} is highest (${topShare.live} of ${topShare.rows}, ${topShare.share.toFixed(1)}%). ` +
    "Phase 2 spends more time in these areas.",
  "",
);

// Operator-only rows, grouped by area
const operatorRows = rows.filter((r) => r.verdict === "operator-only").sort((a, b) => byArea(a.area, b.area) || byCode(a.priorId, b.priorId));
out.push("## For you to check", "");
out.push(
  `${operatorRows.length} rows need a real account, device or installed app. ` +
    "These notes were written by the review agents, quoted unchanged, and \"I\" is the agent that tested the row in the sandbox. " +
    "Each note says what was already checked in the sandbox and what is left for you; a polished checklist comes in the final report.",
  "",
);
for (const a of [...new Set(operatorRows.map((r) => r.area))].sort(byArea)) {
  out.push(`### ${a}`, "");
  for (const r of operatorRows.filter((x) => x.area === a)) out.push(...noteBlock(r));
}

const cannot = rows
  .filter((r) => r.verdict === "cannot-check" && !noteOf(r).startsWith("ENGINEERING-NOTE:"))
  .sort((a, b) => byCode(a.priorId, b.priorId));
out.push("## Could not be checked here", "");
if (cannot.length === 0) out.push("None.");
for (const r of cannot) out.push(`- **${esc(r.priorId)}** ${esc(clean(r.title))}. Reason: ${esc(noteOf(r))}`);
out.push("");

const stripPrefix = (note, prefix) => {
  const text = note.slice(prefix.length).trim();
  const first = text.split(/\s/)[0];
  return /^[a-z]/.test(text) && !/[A-Z._\-/\\`]/.test(first) ? text[0].toUpperCase() + text.slice(1) : text;
};
const design = rows.filter((r) => noteOf(r).startsWith("DESIGN-DECISION:")).sort((a, b) => byCode(a.priorId, b.priorId));
out.push("## Design decisions to confirm", "");
out.push(
  "Each of these earlier findings recommended a change that the product's design documents (DESIGN.md, PRODUCT.md) deliberately do not make. " +
    "No action is needed unless you want to change the design.",
  "",
);
if (design.length === 0) out.push("None.");
for (const r of design) out.push(`- **${esc(r.priorId)}** ${esc(clean(r.title))} (${esc(r.verdict)}). ${esc(stripPrefix(noteOf(r), "DESIGN-DECISION:"))}`);
out.push("");

const eng = rows.filter((r) => noteOf(r).startsWith("ENGINEERING-NOTE:")).sort((a, b) => byCode(a.priorId, b.priorId));
out.push("## Engineering notes", "");
out.push("Developer-hygiene rows with no symptom an operator can see.", "");
if (eng.length === 0) out.push("None.");
for (const r of eng) out.push(`- **${esc(r.priorId)}** ${esc(clean(r.title))} (${esc(r.verdict)}). ${esc(stripPrefix(noteOf(r), "ENGINEERING-NOTE:"))}`);
out.push("");

fs.writeFileSync(path.join(root, "phase-1-summary.md"), out.join("\n"), "utf8");
