#!/usr/bin/env node
// Vendor the impeccable design skill prose (https://github.com/pbakaus/impeccable,
// Apache-2.0) into skills/bundled/impeccable from a LOCAL upstream checkout.
//
// The script never downloads or executes anything. It copies an allowlist of
// prose files, applies deterministic transforms that remove every launcher,
// hook, live-mode, and native-platform dependency, resolves upstream
// placeholders to GoatCitadel equivalents, splits oversize references by H2
// heading, refuses to write when a forbidden string survives, removes stale
// vendored files, and records provenance in UPSTREAM.md.
//
// Usage: node scripts/sync-impeccable.mjs --source <dir> --sha <commit> [--out <dir>]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_REPOSITORY = "https://github.com/pbakaus/impeccable";
export const SKILL_VERSION = "0.1.0";
export const SPLIT_THRESHOLD_BYTES = 20 * 1024;

/** Upstream `skill/reference/<name>.md` files vendored as prose. Order is the order of UPSTREAM.md rows. */
export const VENDORED_REFERENCES = Object.freeze([
  "craft-floor",
  "mode-persuade",
  "mode-operate",
  "mode-read",
  "operate",
  "shape",
  "init",
  "document",
  "extract",
  "audit",
  "polish",
  "bolder",
  "quieter",
  "distill",
  "harden",
  "onboard",
  "animate",
  "colorize",
  "typeset",
  "layout",
  "delight",
  "overdrive",
  "clarify",
  "adapt",
  "optimize",
]);

/** The command references among VENDORED_REFERENCES, in Commands-table order. */
export const COMMAND_REFERENCES = Object.freeze([
  "shape",
  "init",
  "document",
  "extract",
  "audit",
  "polish",
  "bolder",
  "quieter",
  "distill",
  "harden",
  "onboard",
  "animate",
  "colorize",
  "typeset",
  "layout",
  "delight",
  "overdrive",
  "clarify",
  "adapt",
  "optimize",
]);

/** Upstream references deliberately not vendored, with the reason recorded in UPSTREAM.md. */
export const EXCLUDED_REFERENCES = Object.freeze({
  critique:
    "launcher-driven (critique-storage, detect loop); Phase 4 re-vendors a trimmed version with the render step",
  "new-work": "launcher-driven (concept-seed rolls, surface-brief, build-phase gates)",
  "component-review": "launcher-driven (component-review, comp-spec)",
  visualize: "launcher-driven comp pipeline that needs image generation and build-phase state",
  routing: "menu built from launcher context output; SKILL.md carries an inline no-argument rule instead",
  "region-map": "launcher-driven (comp-spec)",
  generate: "live browser variant mode",
  live: "live browser mode",
  "live-setup": "live browser mode",
  hooks: "design detector hook installer; also documents provider folders GoatCitadel does not ship",
  doctor: "launcher drift repair",
  craft: "deprecated alias of ordinary new-work",
  ios: "native platform reference",
  android: "native platform reference",
  "audit.native": "native platform reference",
  "adapt.native": "native platform reference",
});

export const EXCLUDED_AGENTS_REASON =
  "every agents/* prompt depends on the build-phase pipeline (.impeccable/review, .impeccable/build); GoatCitadel cannot run them";

/** Files inside the output directory that are GoatCitadel-authored: never written, never deleted. */
export const LOCAL_FILES = Object.freeze(["reference/artifacts.md"]);

export const SKILL_KEYWORDS = Object.freeze([
  "impeccable",
  "landing page",
  "frontend design",
  "ui polish",
  "design critique",
]);
export const SKILL_TAGS = Object.freeze(["design", "frontend", "ui", "ux"]);

const ASK_INSTRUCTION = "Ask the operator with the user_input.request tool and wait for the answer.";
const NOT_VENDORED = "(not vendored in this GoatCitadel build)";
const UNAVAILABLE_COMMANDS_LINE =
  "Not available in this vendored build: `craft`, `critique`, `live`, `generate`, pin shortcuts, hooks, doctor, and the native-platform references. Use `audit` and `polish` for review passes.";

const GOATCITADEL_SETUP = [
  "## Setup",
  "",
  "1. Read the project design context before any design work: the workspace `PRODUCT.md` (durable product truth) and `DESIGN.md` (the committed visual system) when the GoatCitadel runtime attaches them or the project contains them. Nothing is executed. GoatCitadel ships no impeccable launcher, binary, hook, or live mode; when a step below is impossible without one, say so once and continue with the rest. A missing DESIGN.md alone does not make a project greenfield.",
  "2. Load the request's playbook: its Commands-table reference for an explicit or implied sub-command. Inspect target and incumbent visual truth before editing: existing tokens, components, stylesheets, and committed visual-regression baselines or screenshot fixtures, checked for freshness against the current code.",
  "3. After resolving analysis and direction, read [reference/craft-floor.md](reference/craft-floor.md) immediately before any UI edit, including small refinements. It carries the quality floor, the absolute bans, and the reflexes no detector catches. Do not load it for planning-only work.",
  "",
];

/** Lines that invoke the upstream launcher or its working directory; dropped wherever they survive the targeted rewrites. */
const LAUNCHER_LINE =
  /\{\{scripts_path\}\}|\bimpeccable (?:detect|context|pin|hooks|doctor|critique-storage|concept-seed|surface-brief|build-phase|component-review|comp-spec|live-server)\b|\bnpx impeccable\b|~\/\.impeccable|\.impeccable\//u;

const FORBIDDEN_PATTERNS = Object.freeze([
  { label: "{{", re: /\{\{[^}\n]*\}?\}?/giu },
  { label: "npx impeccable", re: /npx impeccable/giu },
  { label: "impeccable <launcher verb>", re: /\bimpeccable (?:detect|pin|hooks|context|doctor)\b/giu },
  { label: "~/.impeccable", re: /~\/\.impeccable/giu },
  { label: ".impeccable/", re: /\.impeccable\//giu },
  { label: "grok", re: /grok/giu },
  { label: "xai", re: /\bxai\b/giu },
  { label: "x.ai", re: /\bx\.ai\b/giu },
]);

/** Exact-anchor rewrites per file. Every entry is required; a missing anchor means upstream drifted and the transform must be revisited. */
const SKILL_REPLACEMENTS = [
  {
    find: "- **No argument:** read [routing.md](reference/routing.md) and present its context-aware menu; never auto-run a command.",
    replace:
      "- **No argument:** present a short menu of the commands above grouped by category, recommend `init` first when no PRODUCT.md context exists, and never auto-run a command.",
  },
  {
    find: "load its reference (native variant on native platforms) and follow it.",
    replace: "load its reference and follow it.",
  },
  { find: "as `impeccable context` directs", replace: "as the project design context directs" },
  { find: "through init, then new-work;", replace: "through init;" },
  {
    find: "- `teach` aliases `init`. `craft` is a deprecated alias for ordinary new-work and adds nothing. `shape` owns task discovery, then enters new-work only for visual-world and surface-concept decisions.",
    replace: "- `teach` aliases `init`. `shape` owns task discovery and surface-concept decisions.",
  },
];

const MODE_CLAUSE =
  /^`impeccable concept-seed --mode [a-z]+`(?: \(or `[a-z]+`\))? prints the two sections below as its MODE RULES block\. /mu;

const REFERENCE_REPLACEMENTS = {
  "mode-persuade": [{ find: MODE_CLAUSE, replace: "The two sections below are this mode's MODE RULES. " }],
  "mode-operate": [{ find: MODE_CLAUSE, replace: "The two sections below are this mode's MODE RULES. " }],
  "mode-read": [{ find: MODE_CLAUSE, replace: "The two sections below are this mode's MODE RULES. " }],
  init: [
    {
      find: "Use the PRODUCT.md path resolved by `impeccable context`.",
      replace:
        "Use the workspace PRODUCT.md design context when the runtime attaches one, otherwise the project's PRODUCT.md.",
    },
  ],
  polish: [
    {
      find: "Follow the quality guidance supplied by `impeccable context` and hooks, then run any other relevant QA commands. Context requests a manual scan only when no automatic detector is active; never add another detector pass.",
      replace: "Follow the quality guidance in the project design context, then run any other relevant QA commands.",
    },
  ],
};

const REFERENCE_SECTION_DROPS = {
  document: [/^### Step 4b: Write \.impeccable\/design\.json sidecar/u],
};

const SKILL_PARAGRAPH_DROPS = ["**Never repair drift", "- **Workflow or command-selection question:**"];

export const TRANSFORMS_APPLIED = Object.freeze([
  "SKILL.md frontmatter keeps name and description; argument-hint, user-invocable, allowed-tools, and license are dropped; metadata (version, tags, keywords) is added.",
  "An Apache License 2.0 section 4(b) modification notice follows the SKILL.md frontmatter.",
  "The SKILL.md Setup section is replaced: no launcher runs; context comes from the workspace PRODUCT.md and DESIGN.md.",
  "SKILL.md routing: inline no-argument rule, workflow-questions bullet removed, launcher context clauses rewritten, deprecated craft alias removed.",
  "SKILL.md Commands table: craft, critique, live, and generate rows removed; native-platform suffixes removed; an availability note added.",
  "Pin, Hooks, Doctor, drift-repair, and post-init launcher paragraphs removed.",
  "Mode references: the concept-seed clause becomes plain prose.",
  "init.md: the PRODUCT.md path sentence points at the workspace context; polish.md: the launcher context sentence is rewritten.",
  "document.md: the .impeccable/design.json sidecar section is removed.",
  "Fenced code blocks that only invoke the launcher are removed together with a lead-in line ending in a colon; any other line invoking the launcher or an .impeccable/ path is removed.",
  "Placeholders: {{command_prefix}} becomes `@skill impeccable`, {{ask_instruction}} becomes the user_input.request phrasing, {{available_commands}} becomes the vendored command list.",
  "Links to references that are not vendored become plain text marked as not vendored.",
  "Line endings normalized to LF, trailing whitespace trimmed, runs of blank lines collapsed, single trailing newline.",
  "References over 20 KiB are split by H2 heading into reference/<name>/NN-<slug>.md with reference/<name>.md as the index.",
]);

export class SyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncError";
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function normalizeNewlines(text) {
  return text.replace(/\r\n?/gu, "\n");
}

export function normalizeWhitespace(text) {
  const lines = normalizeNewlines(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
  const collapsed = [];
  for (const line of lines) {
    if (line === "" && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") collapsed.pop();
  return `${collapsed.join("\n")}\n`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isFence(line) {
  return /^\s*```/u.test(line);
}

function headingLevel(line) {
  const match = /^(#{1,6}) /u.exec(line);
  return match ? match[1].length : 0;
}

function applyReplacements(text, replacements, label) {
  let out = text;
  for (const { find, replace } of replacements) {
    const matched = typeof find === "string" ? out.includes(find) : find.test(out);
    if (!matched) {
      throw new SyncError(`transform anchor missing in ${label}: ${String(find)}`);
    }
    out = typeof find === "string" ? out.split(find).join(replace) : out.replace(find, replace);
  }
  return out;
}

function replaceSection(text, startHeading, endHeading, replacementLines, label) {
  const lines = text.split("\n");
  const start = lines.indexOf(startHeading);
  if (start < 0) throw new SyncError(`section anchor missing in ${label}: ${startHeading}`);
  const end = lines.indexOf(endHeading, start + 1);
  if (end < 0) throw new SyncError(`section anchor missing in ${label}: ${endHeading}`);
  return [...lines.slice(0, start), ...replacementLines, ...lines.slice(end)].join("\n");
}

function dropSections(text, startPatterns, label) {
  let lines = text.split("\n");
  for (const pattern of startPatterns) {
    let inFence = false;
    let start = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isFence(line)) inFence = !inFence;
      if (!inFence && pattern.test(line)) {
        start = index;
        break;
      }
    }
    if (start < 0) throw new SyncError(`section anchor missing in ${label}: ${String(pattern)}`);
    const level = headingLevel(lines[start]);
    let end = lines.length;
    inFence = false;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (isFence(line)) inFence = !inFence;
      const current = headingLevel(line);
      if (!inFence && current > 0 && current <= level) {
        end = index;
        break;
      }
    }
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  return lines.join("\n");
}

function dropParagraphsStartingWith(text, prefixes) {
  return text
    .split("\n")
    .filter((line) => !prefixes.some((prefix) => line.startsWith(prefix)))
    .join("\n");
}

function dropLauncherFences(text) {
  const lines = text.split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!isFence(line)) {
      out.push(line);
      index += 1;
      continue;
    }
    let close = index + 1;
    while (close < lines.length && !isFence(lines[close])) close += 1;
    const inner = lines.slice(index + 1, close);
    const launcherOnly = inner.length > 0 && inner.every((item) => item.trim() === "" || LAUNCHER_LINE.test(item));
    if (!launcherOnly) {
      out.push(...lines.slice(index, Math.min(close + 1, lines.length)));
      index = close + 1;
      continue;
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (out.length > 0 && /:\s*$/u.test(out[out.length - 1])) out.pop();
    index = close + 1;
  }
  return out.join("\n");
}

function dropLauncherLines(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && LAUNCHER_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

function resolvePlaceholders(text) {
  return text
    .split("{{command_prefix}}impeccable")
    .join("@skill impeccable")
    .split("{{command_prefix}}")
    .join("@skill impeccable ")
    .split("{{ask_instruction}}")
    .join(ASK_INSTRUCTION)
    .split("{{available_commands}}")
    .join(COMMAND_REFERENCES.join(", "));
}

function rewriteLinks(text) {
  const vendored = new Set([...VENDORED_REFERENCES, "artifacts"]);
  return text.replace(/\[([^\]]+)\]\((?:reference\/)?([a-z0-9.-]+)\.md(?:#[^)]*)?\)/gu, (whole, label, name) =>
    vendored.has(name) ? whole : `${label} ${NOT_VENDORED}`,
  );
}

function transformCommandsTable(text) {
  const lines = text.split("\n");
  const header = lines.indexOf("## Commands");
  if (header < 0) throw new SyncError("section anchor missing in SKILL.md: ## Commands");
  let first = header + 1;
  while (first < lines.length && !lines[first].startsWith("|")) first += 1;
  if (first >= lines.length) throw new SyncError("Commands table missing in SKILL.md");
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].startsWith("|")) last += 1;
  const rows = lines
    .slice(first, last + 1)
    .filter((row) => !/^\| `(?:craft|critique|live|generate)\b/u.test(row))
    .map((row) => row.replace(/ · native: \[[^\]]*\]\([^)]*\)/gu, ""));
  return [...lines.slice(0, first), ...rows, "", UNAVAILABLE_COMMANDS_LINE, ...lines.slice(last + 1)].join("\n");
}

function splitFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new SyncError("SKILL.src.md must start with YAML frontmatter");
  const close = lines.indexOf("---", 1);
  if (close < 0) throw new SyncError("SKILL.src.md frontmatter is not closed");
  return { frontmatter: lines.slice(1, close), body: lines.slice(close + 1).join("\n") };
}

function rewriteFrontmatter(frontmatterLines) {
  const kept = frontmatterLines.filter((line) => /^(?:name|description):/u.test(line));
  if (!kept.some((line) => line.startsWith("name:")) || !kept.some((line) => line.startsWith("description:"))) {
    throw new SyncError("SKILL.src.md frontmatter must carry name and description");
  }
  return [
    ...kept,
    "metadata:",
    `  version: "${SKILL_VERSION}"`,
    "  tags:",
    ...SKILL_TAGS.map((tag) => `    - ${tag}`),
    "  keywords:",
    ...SKILL_KEYWORDS.map((keyword) => `    - ${keyword}`),
  ];
}

function modificationNotice(sha) {
  return `> Vendored from [pbakaus/impeccable](${UPSTREAM_REPOSITORY}) at commit \`${sha}\` under the Apache License 2.0 and modified for the GoatCitadel runtime: the launcher, hooks, live mode, doctor, pin shortcuts, and native-platform references were removed, and Setup now reads the workspace design context. See \`UPSTREAM.md\` and \`NOTICE\` in this directory.`;
}

// ---------------------------------------------------------------------------
// Per-file transforms
// ---------------------------------------------------------------------------

function finishProse(text) {
  let out = dropLauncherFences(text);
  out = dropLauncherLines(out);
  out = resolvePlaceholders(out);
  out = rewriteLinks(out);
  return normalizeWhitespace(out);
}

export function transformSkillSource(text, { sha }) {
  const { frontmatter, body } = splitFrontmatter(normalizeNewlines(text));
  let content = replaceSection(body, "## Setup", "## How to design", GOATCITADEL_SETUP, "SKILL.md");
  content = applyReplacements(content, SKILL_REPLACEMENTS, "SKILL.md");
  content = dropParagraphsStartingWith(content, SKILL_PARAGRAPH_DROPS);
  content = transformCommandsTable(content);
  const assembled = [
    "---",
    ...rewriteFrontmatter(frontmatter),
    "---",
    "",
    modificationNotice(sha),
    "",
    content.trimStart(),
  ].join("\n");
  return finishProse(assembled);
}

export function transformReference(name, text) {
  let content = normalizeNewlines(text);
  const replacements = REFERENCE_REPLACEMENTS[name];
  if (replacements) content = applyReplacements(content, replacements, `reference/${name}.md`);
  const sectionDrops = REFERENCE_SECTION_DROPS[name];
  if (sectionDrops) content = dropSections(content, sectionDrops, `reference/${name}.md`);
  return finishProse(content);
}

/** Split a transformed reference by H2 heading. Returns undefined when the file is small enough or has no H2. */
export function splitOversizeReference(name, text, threshold = SPLIT_THRESHOLD_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= threshold) return undefined;
  const lines = text.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const title = titleLine ? titleLine.slice(2).trim() : name;
  const sections = [];
  let preamble = [];
  let current;
  let inFence = false;
  for (const line of lines) {
    if (isFence(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (sections.length === 0) return undefined;
  const width = String(sections.length).length < 2 ? 2 : String(sections.length).length;
  const parts = sections.map((section, index) => {
    const ordinal = String(index + 1).padStart(width, "0");
    const file = `${ordinal}-${slugify(section.heading)}.md`;
    const body = normalizeWhitespace(
      [
        `# ${title}: ${section.heading}`,
        "",
        `Part ${index + 1} of ${sections.length} of [${name}.md](../${name}.md).`,
        "",
        ...section.lines,
      ].join("\n"),
    );
    return { relative: `reference/${name}/${file}`, heading: section.heading, file, content: body, ordinal: index + 1 };
  });
  preamble = preamble.filter((line, index) => !(index === 0 && line === titleLine));
  const index = normalizeWhitespace(
    [
      `# ${title}`,
      "",
      ...preamble,
      "",
      "## Parts",
      "",
      `This reference is split by section so the runtime can load one part at a time. Read the parts in order.`,
      "",
      ...parts.map((part) => `- [${part.heading}](${name}/${part.file})`),
    ].join("\n"),
  );
  return { index, parts, count: sections.length };
}

export function scanForbiddenStrings(text) {
  const findings = [];
  normalizeNewlines(text)
    .split("\n")
    .forEach((line, offset) => {
      let best;
      for (const pattern of FORBIDDEN_PATTERNS) {
        pattern.re.lastIndex = 0;
        const match = pattern.re.exec(line);
        if (match && (best === undefined || match.index < best.index)) best = { index: match.index, match: match[0] };
      }
      if (best) findings.push({ line: offset + 1, match: best.match });
    });
  return findings;
}

// ---------------------------------------------------------------------------
// Provenance documents
// ---------------------------------------------------------------------------

function buildNotice(sha, upstreamNotice, localFiles) {
  const lines = [
    "NOTICE",
    "",
    `This directory vendors prose from impeccable (${UPSTREAM_REPOSITORY}), copyright its contributors, licensed under the Apache License, Version 2.0 (see the LICENSE file in this directory). Vendored at commit ${sha}.`,
    "",
    "The vendored files were modified for the GoatCitadel runtime: the launcher, hooks, live mode, doctor, pin shortcuts, and native-platform references were removed, upstream placeholders were resolved, oversize references were split by section, and the SKILL.md Setup section now reads the workspace design context. UPSTREAM.md lists every file, hash, exclusion, and transform.",
    "",
  ];
  if (localFiles.length > 0) {
    lines.push("The following files are GoatCitadel-authored and are not part of impeccable:", "");
    for (const file of localFiles) lines.push(`- ${file}`);
    lines.push("");
  }
  if (upstreamNotice.trim()) {
    lines.push(
      "Upstream's own third-party notice follows; it covers upstream files that are not vendored here.",
      "",
      upstreamNotice.trim(),
      "",
    );
  }
  return normalizeWhitespace(lines.join("\n"));
}

function buildUpstreamDoc({ sha, rows, excludedReferences, localFiles }) {
  const lines = [
    "# Upstream provenance: impeccable",
    "",
    `- Repository: ${UPSTREAM_REPOSITORY}`,
    `- Commit: \`${sha}\``,
    "- License: Apache-2.0 (see `LICENSE`; attribution and modification statement in `NOTICE`)",
    "- Sync: `node scripts/sync-impeccable.mjs --source <local upstream checkout> --sha <commit>`; the script never downloads or executes upstream code, and running it again at the same commit reproduces these bytes exactly.",
    "",
    "## Vendored files",
    "",
    "| Vendored path | Upstream path | Upstream sha256 | Vendored sha256 | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) => `| ${row.vendored} | ${row.upstream} | ${row.upstreamSha} | ${row.vendoredSha} | ${row.notes} |`,
    ),
    "",
    "## Excluded upstream files",
    "",
    ...excludedReferences.map(([name, reason]) => `- skill/reference/${name}.md: ${reason}`),
    `- skill/agents/*: ${EXCLUDED_AGENTS_REASON}`,
    "- skill/scripts/*, launcher binaries, hooks, live-browser bundles: GoatCitadel runs no external design runtime",
    "",
    "## Transforms applied",
    "",
    ...TRANSFORMS_APPLIED.map((item) => `- ${item}`),
    "",
    "## GoatCitadel-authored files (not upstream)",
    "",
    ...(localFiles.length > 0 ? localFiles.map((file) => `- ${file}`) : ["- (none present)"]),
  ];
  return normalizeWhitespace(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function listFilesRecursive(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out.sort();
}

function removeEmptyDirectories(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function readUpstream(sourceDir, relative) {
  const full = path.join(sourceDir, relative);
  if (!fs.existsSync(full)) throw new SyncError(`upstream file missing: ${relative}`);
  return fs.readFileSync(full);
}

export function defaultOutDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "bundled", "impeccable");
}

/**
 * Vendor impeccable from a local checkout. Computes every output in memory, runs
 * the forbidden-string guard, and only then writes, so a failed guard leaves the
 * output directory untouched.
 */
export function syncImpeccable({ sourceDir, sha, outDir = defaultOutDir() }) {
  if (!/^[0-9a-f]{7,40}$/u.test(sha)) throw new SyncError(`--sha must be a hexadecimal commit id, received: ${sha}`);
  const source = path.resolve(sourceDir);
  for (const required of ["skill/SKILL.src.md", "LICENSE"]) {
    if (!fs.existsSync(path.join(source, required))) throw new SyncError(`upstream file missing: ${required}`);
  }
  const out = path.resolve(outDir);
  const localFiles = LOCAL_FILES.filter((file) => fs.existsSync(path.join(out, file)));

  const outputs = new Map();
  const rows = [];
  const record = (vendored, upstream, upstreamBytes, content, notes) => {
    outputs.set(vendored, content);
    rows.push({
      vendored,
      upstream,
      upstreamSha: sha256(upstreamBytes),
      vendoredSha: sha256(Buffer.from(content, "utf8")),
      notes,
    });
  };

  const skillBytes = readUpstream(source, "skill/SKILL.src.md");
  record(
    "SKILL.md",
    "skill/SKILL.src.md",
    skillBytes,
    transformSkillSource(skillBytes.toString("utf8"), { sha }),
    "transformed",
  );

  const licenseBytes = readUpstream(source, "LICENSE");
  record("LICENSE", "LICENSE", licenseBytes, normalizeNewlines(licenseBytes.toString("utf8")), "copied");

  for (const name of VENDORED_REFERENCES) {
    const upstreamPath = `skill/reference/${name}.md`;
    const bytes = readUpstream(source, upstreamPath);
    const transformed = transformReference(name, bytes.toString("utf8"));
    const split = splitOversizeReference(name, transformed);
    if (!split) {
      record(`reference/${name}.md`, upstreamPath, bytes, transformed, "transformed");
      continue;
    }
    record(`reference/${name}.md`, upstreamPath, bytes, split.index, `transformed; split index (${split.count} parts)`);
    for (const part of split.parts) {
      record(part.relative, upstreamPath, bytes, part.content, `transformed; part ${part.ordinal} of ${split.count}`);
    }
  }

  const noticePath = path.join(source, "NOTICE.md");
  const upstreamNotice = fs.existsSync(noticePath) ? normalizeNewlines(fs.readFileSync(noticePath, "utf8")) : "";
  outputs.set("NOTICE", buildNotice(sha, upstreamNotice, localFiles));

  const findings = [];
  for (const [relative, content] of outputs) {
    for (const finding of scanForbiddenStrings(content)) findings.push(`${relative}:${finding.line}: ${finding.match}`);
  }
  for (const file of localFiles) {
    for (const finding of scanForbiddenStrings(fs.readFileSync(path.join(out, file), "utf8"))) {
      findings.push(`${file}:${finding.line}: ${finding.match}`);
    }
  }
  if (findings.length > 0) {
    throw new SyncError(`forbidden strings remain after transforms:\n${findings.join("\n")}`);
  }

  outputs.set(
    "UPSTREAM.md",
    buildUpstreamDoc({ sha, rows, excludedReferences: Object.entries(EXCLUDED_REFERENCES), localFiles }),
  );

  const keep = new Set([...outputs.keys(), ...LOCAL_FILES]);
  const removed = [];
  for (const existing of listFilesRecursive(out)) {
    if (keep.has(existing)) continue;
    fs.rmSync(path.join(out, existing));
    removed.push(existing);
  }
  for (const [relative, content] of outputs) {
    const full = path.join(out, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  removeEmptyDirectories(out);

  return {
    outDir: out,
    written: [...outputs.keys()],
    removed,
    excluded: Object.keys(EXCLUDED_REFERENCES),
    local: localFiles,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: sync-impeccable --source <dir> --sha <commit> [--out <dir>]";

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--source" || flag === "--sha" || flag === "--out") && value !== undefined) {
      options[flag.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new SyncError(`${USAGE}\nunexpected argument: ${flag}`);
  }
  if (!options.source || !options.sha) throw new SyncError(USAGE);
  return { sourceDir: options.source, sha: options.sha, outDir: options.out };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  try {
    const result = syncImpeccable({
      sourceDir: parsed.sourceDir,
      sha: parsed.sha,
      ...(parsed.outDir ? { outDir: parsed.outDir } : {}),
    });
    process.stdout.write(
      [
        `vendored ${result.written.length} file(s) into ${result.outDir}`,
        ...result.written.map((file) => `  + ${file}`),
        ...result.removed.map((file) => `  - ${file} (stale, removed)`),
        `excluded ${result.excluded.length} upstream reference(s); local files kept: ${result.local.join(", ") || "none"}`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    process.stderr.write(`sync-impeccable: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
