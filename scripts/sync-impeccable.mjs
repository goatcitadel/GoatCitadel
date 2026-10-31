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
  "critique",
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
  "critique",
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
  "Not available in this vendored build: `craft`, `live`, `generate`, pin shortcuts, hooks, doctor, and the native-platform references. Use `critique`, `audit`, and `polish` for review passes. `new-work` (the visual-world workshop) is not vendored either: when a step routes through it, choose and commit the visual world with the operator through user_input.request and record it in DESIGN.md.";

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
  /\{\{scripts_path\}\}|\bimpeccable (?:detect|context|pin|hooks|doctor|critique-storage|concept-seed|surface-brief|build-phase|component-review|comp-spec|live-server)\b|\bnpx impeccable\b|~\/\.impeccable|\.impeccable\/|\bsnapshot_file\b/u;

/** Lines that invoke a command this vendored build does not carry. */
const UNAVAILABLE_COMMAND_LINE = /`(?:\/|@skill )?impeccable (?:live|generate|craft)\b/u;

/** Lines that route to the excluded native-platform references. */
const NATIVE_REFERENCE_LINE = /\b(?:ios|android)\.md\b|\b(?:audit|adapt)\.native\.md\b/u;

/** Sections, at any heading level, that only make sense in upstream's live browser mode. */
const LIVE_MODE_SECTION = /^#{2,6} .*\blive[- ]mode\b/iu;

const FORBIDDEN_PATTERNS = Object.freeze([
  { label: "{{", re: /\{\{[^}\n]*\}?\}?/giu },
  { label: "npx impeccable", re: /npx impeccable/giu },
  { label: "impeccable <launcher verb>", re: /\bimpeccable (?:detect|pin|hooks|context|doctor)\b/giu },
  { label: "~/.impeccable", re: /~\/\.impeccable/giu },
  { label: ".impeccable/", re: /\.impeccable\//giu },
  { label: "grok", re: /grok/giu },
  { label: "xai", re: /\bxai\b/giu },
  { label: "x.ai", re: /\bx\.ai\b/giu },
  // The .impeccable/design.json sidecar was removed; any surviving mention would send the model to recreate it.
  { label: "sidecar", re: /\bsidecar\b/giu },
  // Commands this build does not carry must not survive as invocations after placeholder resolution.
  { label: "unavailable command", re: /@skill impeccable (?:live|generate|craft)\b/giu },
]);

/** Whole paragraphs (single lines) dropped from a reference by prefix, when a rewrite would leave nothing useful. */
const REFERENCE_PARAGRAPH_DROPS = {
  document: ["**What changed from schemaVersion 1.**"],
  critique: [
    "- Any local server started only for critique visualization",
    "- Do not claim a user-visible overlay exists",
    "   Every later command also accepts the resolved target directly",
    "If browser automation is available, each assessment creates its own new tab.",
    "Sub-agent gate (all harnesses):",
    "- Unless a harness-specific gate below overrides this",
    '- "Unavailable" means exactly one thing',
    "- If and only if sub-agents are unavailable",
    "- Whichever path you take, declare it in the report header",
    "- Pass markup files/directories as",
    "- For URLs, skip CLI scan",
    "- For very large trees",
    "- Exit code 0 = clean",
    "- If the detector entrypoint is missing",
    "1. Create a fresh tab and navigate.",
    "2. Preflight mutable injection",
    "3. If mutation is unavailable",
    "5. For multi-view targets",
    "- Dual-agent: `Method: dual-agent",
    "Do this first because the alternative is the most common way",
    "Persistence is not the end of the run.",
    // Desktop-app assessment drives a running app over a CDP port; GoatCitadel critiques attached renders.
    "- Desktop apps (see **Desktop apps** under Assessment B)",
    "**Desktop apps** (Electron, NW.js, CEF, WebView2)",
    "1. Launch the app with a local DevTools port",
    "2. Seed the state under review",
    "4. Take screenshots through the harness's CDP tooling",
    "The app has one window, so the assessments take turns",
    "- Native: `Method: design review only",
  ],
};

/** Harness-specific blocks (`<codex>` … `</codex>`) dropped whole from a reference. */
const REFERENCE_TAG_DROPS = {
  critique: ["codex"],
};

/** Upstream description claims that this build cannot honour (native iOS and Android references). */
const DESCRIPTION_REPLACEMENTS = [
  { find: "onboarding, empty states, and native iOS or Android screens.", replace: "onboarding, and empty states." },
];

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
  {
    find: "choose a replacement world in new-work and replace DESIGN.md",
    replace: "choose a replacement world with the operator and replace DESIGN.md",
  },
  {
    find: "new-work decides whether to preserve, expand, or replace the incumbent world",
    replace: "the evidence decides whether to preserve, expand, or replace the incumbent world",
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
    {
      find: "Visual replacement happens later in new-work, not here.",
      replace: "Visual replacement happens later, not here.",
    },
    {
      find: "New visual work continues in new-work; `shape` resumes its task interview first.",
      replace: "New visual work continues after init; `shape` resumes its task interview first.",
    },
    {
      find: "Before loading new-work or resuming shape/build, verify",
      replace: "Before any visual-world work or resuming shape/build, verify",
    },
    {
      find: "New-work will establish a visual world only when the requested work needs one.",
      replace: "Establish a visual world only when the requested work needs one.",
    },
  ],
  shape: [
    {
      find: "New-work owns visual-world and concept choices.",
      replace: "Visual-world and concept choices are made with the operator.",
    },
    {
      find: "follow [new-work.md](new-work.md) through visual authority, any world workshop, and concept choice.",
      replace:
        "resolve visual authority, any world choice, and concept choice with the operator (the new-work workshop is not vendored in this GoatCitadel build).",
    },
  ],
  bolder: [{ find: "(see new-work.md)", replace: "(the new-work workshop is not vendored in this GoatCitadel build)" }],
  polish: [
    {
      find: "Follow the quality guidance supplied by `impeccable context` and hooks, then run any other relevant QA commands. Context requests a manual scan only when no automatic detector is active; never add another detector pass.",
      replace: "Follow the quality guidance in the project design context, then run any other relevant QA commands.",
    },
  ],
  audit: [
    {
      find: "Run the bundled detector and verify each finding in context.",
      replace: "Review any design advisories the runtime attached and verify each finding in context.",
    },
  ],
  document: [
    {
      find: "That pass will extract real tokens and generate the sidecar.",
      replace: "That pass will extract real tokens.",
    },
    {
      find: "Carry them in the sidecar (Step 4b).",
      replace: "Carry them in DESIGN.md prose under the relevant section.",
    },
    {
      find: "carry the full snippet in the sidecar instead.",
      replace: "carry the full snippet in DESIGN.md prose instead.",
    },
    {
      find: "Anything else belongs in the sidecar's `extensions`.",
      replace: "Anything else belongs in DESIGN.md prose under the relevant section.",
    },
    {
      find: "- New-work found a coherent incumbent visual system but no `DESIGN.md`.",
      replace: "- A new-surface request found a coherent incumbent visual system but no `DESIGN.md`.",
    },
    {
      find: "then reuse new-work's visual-world workshop and write its directional DESIGN.md seed",
      replace: "then choose the visual world with the operator and write a directional DESIGN.md seed",
    },
    {
      find: "`/impeccable document --seed` requests new-work's world workshop, but it does not authorize replacing coherent code: when an incumbent system exists, offer scan mode or route an explicit identity-replacement request through new-work.",
      replace:
        "`/impeccable document --seed` requests the visual-world choice, but it does not authorize replacing coherent code: when an incumbent system exists, offer scan mode or treat an explicit identity-replacement request as a redesign chosen with the operator.",
    },
    {
      find: "### Step 1: Route through new-work's workshop",
      replace: "### Step 1: Resolve the visual world with the operator",
    },
    {
      find: "If PRODUCT.md exists, load [new-work.md](new-work.md) and resolve visual authority.",
      replace:
        "If PRODUCT.md exists, resolve visual authority inline: the new-work workshop is not vendored in this GoatCitadel build, so choose the visual world with the operator through user_input.request and record the choice in DESIGN.md.",
    },
    {
      find: "Run new-work's **Create or replace the visual world** flow, then **Commit the world**, so the visual world and its first expression are chosen together.",
      replace:
        "Choose the visual world and its first expression together with the operator, then commit them in DESIGN.md.",
    },
    {
      find: "If new-work already completed the workshop in this session, use its chosen direction directly. Do not ask again.",
      replace: "If the visual world was already chosen in this session, use that direction directly. Do not ask again.",
    },
    { find: "or new-work's exploration established them", replace: "or the operator's choice established them" },
  ],
  // The GoatCitadel critique turn carries routed context (which pins the route and disables
  // delegation) and render evidence instead of the upstream detector, browser overlay, and
  // snapshot persistence; the flow is rewritten to a single-context run over that evidence.
  critique: [
    {
      find: "Resolve one stable target, run two independent assessments, synthesize a design critique, persist a snapshot, and ask the user what to improve next. The chat response is the primary deliverable; the snapshot is an archive of that run.",
      replace:
        "Resolve one stable target, run two independent assessments, synthesize a design critique, and ask the user what to improve next. The chat response is the deliverable.",
    },
    {
      find: "- Assessment A (design review) and Assessment B (detector/browser evidence) are both required, except on a native platform (see Assessment Orchestration).",
      replace: "- Assessment A (design review) and Assessment B (render evidence) are both required.",
    },
    {
      find: '- Assessment A and B MUST run as two isolated sub-agents whenever a sub-agent/Task tool is exposed. Running them inline in this context is "possible" but is NOT permitted; it is a degraded run. Inline is allowed ONLY when no sub-agent tool exists (or the user declined, on harnesses that ask). Native platforms run A alone (see Assessment Orchestration).',
      replace:
        "- The GoatCitadel critique turn carries routed context, which pins the provider and model and disables delegation, so Assessment A and Assessment B run sequentially in this context: finish and record Assessment A before reading the render evidence and advisories for Assessment B.",
    },
    {
      find: "- If you degrade for any reason, the report's first line MUST be a banner: `⚠️ DEGRADED: single-context (<reason>)`. A silent degraded critique is a failed critique.",
      replace: "- The report's first line MUST declare the method: `Method: single-context (routed-context critique)`.",
    },
    {
      find: "- Assessment A must finish before detector findings enter the parent synthesis context. Detector output is deterministic, but it still anchors judgment.",
      replace:
        "- Assessment A must finish before render evidence and runtime advisories enter the synthesis. Advisories are deterministic, but they still anchor judgment.",
    },
    {
      find: "- Viewable targets require browser inspection when available.",
      replace: "- Viewable targets require inspection of the attached renders when they are available.",
    },
    {
      find: "Delegate Assessment A and Assessment B to separate sub-agents. They must not see each other's output. Do not show findings to the user until synthesis.",
      replace:
        "Run Assessment A, then Assessment B. Record Assessment A's findings before Assessment B begins so the evidence cannot anchor the review. Do not show findings to the user until synthesis.",
    },
    {
      find: "Read relevant source files and visually inspect the live page when browser automation is available. Think like a design director.",
      replace:
        "Read the artifact markup from the routed context and inspect the attached renders when they are available. Think like a design director.",
    },
    {
      find: "Make this judgment before seeing detector output.",
      replace: "Make this judgment before seeing the renders or the runtime advisories.",
    },
    { find: "### Assessment B: Detector + Browser Evidence", replace: "### Assessment B: Render Evidence" },
    {
      find: "noting where the LLM review and detector agree, where the detector caught issues the LLM missed, and where detector findings are false positives.",
      replace:
        "noting where the design review and the render evidence or advisories agree, where the advisories caught issues the review missed, and where advisories are false positives.",
    },
    {
      find: "Run the bundled detector and browser visualization evidence. On web, Assessment B is mandatory and must remain isolated from Assessment A until both are complete.",
      replace:
        "Review the render evidence GoatCitadel attached to this critique: offline PNG snapshots of the artifact at desktop (1440×900) and phone (390×844) viewports when the provider can inspect images, plus the runtime design advisories recorded on the artifact. Assessment B is mandatory and must remain isolated from Assessment A until both are complete.",
    },
    {
      find: "Browser visualization is required for a viewable target when browser automation is available. Use a localhost dev/static URL for local files; avoid `file://` unless the available browser explicitly supports this workflow. Overlay flow:",
      replace:
        "Read the renders like a design director: compare the desktop and phone snapshots for hierarchy, density, overflow, contrast, and responsive breaks, and tie every observation to a region of the page. When no renders were attached, say so and assess the markup alone.",
    },
    {
      find: "Return: CLI findings JSON/counts, browser console findings if applicable, false positives, and skipped/failed browser steps with concrete reasons.",
      replace:
        "Return: what each render shows, the runtime advisories with counts and line locations, false positives, and whether renders were unavailable with the concrete reason.",
    },
    {
      find: "The chat response is the primary user-facing deliverable. Present the full structured critique below in chat; do not replace it with a summary and a link. The persisted snapshot is an archive of that run.",
      replace:
        "The chat response is the deliverable. Present the full structured critique below in chat; do not replace it with a summary and a link.",
    },
    {
      find: "The report's first line MUST declare how the assessments were run, so a degraded run is never silent:",
      replace: "The report's first line declares the method:",
    },
    {
      find: "- Degraded: `⚠️ DEGRADED: single-context (<reason, e.g. no sub-agent tool exposed>)`",
      replace: "- `Method: single-context (routed-context critique)`",
    },
    {
      find: " The persisted snapshot must record the applicable maximum and which heuristics were scored n/a.",
      replace: "",
    },
    {
      find: "**Deterministic scan**: Summarize what the automated detector found, with counts and file locations. Note any additional issues the detector caught that you missed, and flag any false positives.",
      replace:
        "**Runtime advisories**: Summarize the design advisories GoatCitadel recorded on the artifact, with counts and line locations. Note any additional issues they caught that you missed, and flag any false positives.",
    },
    {
      find: "**Visual overlays** (if injection succeeded): Tell the user that overlays are now visible in the **[Human]** tab in their browser, highlighting the detected issues. Summarize what the console output reported. If browser visualization was attempted but injection failed, say that no reliable user-visible overlay is available and report the fallback signal instead.",
      replace:
        "**Render evidence** (when snapshots were attached): Say what the desktop and phone renders show that the markup alone would not. When no renders were attached, state that the critique is text-only.",
    },
    {
      find: "If `{{config_file}}` contains a `## Design Context` section from `impeccable init`, also generate 1-2 project-specific personas from the audience/brand info.",
      replace:
        "If the workspace PRODUCT.md or DESIGN.md names the audience or brand, also generate 1-2 project-specific personas from that context.",
    },
    {
      find: "Write the full report into the chat response now, before any persistence work. This is the deliverable; everything below it is bookkeeping.",
      replace: "Write the full report into the chat response now. This is the deliverable.",
    },
    {
      find: "If `{{config_file}}` contains a `## Design Context` section (generated by `impeccable init`), derive 1–2 additional personas from the audience and brand information:",
      replace:
        "If the workspace PRODUCT.md or DESIGN.md names the audience or brand, derive 1–2 additional personas from that information:",
    },
    { find: " On a native platform, write `not applicable (native platform)` instead.", replace: "" },
  ],
  // The runtime design advisories have no line-break rules, so upstream detector rule names would point at nothing.
  typeset: [
    {
      find: " The detector's `straggler` and `unbalanced-heading` findings are advisory for this reason; say which breaks are intended.",
      replace: " Say which breaks are intended.",
    },
  ],
};

const REFERENCE_SECTION_DROPS = {
  document: [/^### Step 4b: Write \.impeccable\/design\.json sidecar/u],
  init: [/^## Step 5: Record workflow defaults/u],
  critique: [/^### Persist the Snapshot/u],
};

const SKILL_PARAGRAPH_DROPS = ["**Never repair drift", "- **Workflow or command-selection question:**"];

export const TRANSFORMS_APPLIED = Object.freeze([
  "SKILL.md frontmatter keeps name and description; argument-hint, user-invocable, allowed-tools, and license are dropped; metadata (version, tags, keywords) is added; the description no longer claims native iOS or Android screens.",
  "new-work (the upstream visual-world workshop) is not vendored: SKILL.md, init.md, document.md, shape.md, and bolder.md sentences that routed through it now ask the operator (user_input.request) to choose and commit the visual world in DESIGN.md; remaining links to it are marked as not vendored.",
  "document.md: sentences that pointed at the removed design.json sidecar now point at DESIGN.md prose and the schemaVersion paragraph is removed; any other surviving sidecar mention fails the guard so a re-sync must add a rewrite rather than ship it.",
  "An Apache License 2.0 section 4(b) modification notice follows the SKILL.md frontmatter.",
  "The SKILL.md Setup section is replaced: no launcher runs; context comes from the workspace PRODUCT.md and DESIGN.md.",
  "SKILL.md routing: inline no-argument rule, workflow-questions bullet removed, launcher context clauses rewritten, deprecated craft alias removed.",
  "SKILL.md Commands table: craft, live, and generate rows removed; native-platform suffixes removed; an availability note added.",
  "Pin, Hooks, Doctor, drift-repair, and post-init launcher paragraphs removed.",
  "Mode references: the concept-seed clause becomes plain prose.",
  "init.md: the PRODUCT.md path sentence points at the workspace context and the live-mode workflow-defaults step is removed; polish.md: the launcher context sentence is rewritten; audit.md: the bundled-detector sentence points at runtime design advisories; document.md: the sidecar mention in the seed-mode wrap-up is removed.",
  "document.md: the .impeccable/design.json sidecar section is removed.",
  "Sections about live mode are removed at any heading level.",
  "Fenced code blocks that only invoke the launcher are removed together with a lead-in line ending in a colon; any other line invoking the launcher, a launcher artifact such as snapshot_file, an .impeccable/ path, a native-platform reference, or an unavailable command (live, generate, craft) is removed.",
  "critique.md: Codex-only harness blocks (<codex>…</codex>) are removed; the launcher slug and ignore-list steps, the detector and browser-overlay evidence, the sub-agent gate, and the snapshot-persistence section are removed or rewritten so the critique runs as a single-context routed turn over GoatCitadel's render evidence (attached offline PNG snapshots plus runtime design advisories).",
  "Placeholders: {{command_prefix}} becomes `@skill impeccable`, upstream `/impeccable <command>` syntax becomes `@skill impeccable <command>`, {{ask_instruction}} becomes the user_input.request phrasing, {{available_commands}} becomes the vendored command list.",
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
    if (
      !inFence &&
      (LAUNCHER_LINE.test(line) || UNAVAILABLE_COMMAND_LINE.test(line) || NATIVE_REFERENCE_LINE.test(line))
    ) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Drop every section whose heading matches `pattern`, at any level, fence-aware. Nothing is required to match. */
function dropSectionsMatching(text, pattern) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let droppingLevel = 0;
  for (const line of lines) {
    if (isFence(line)) inFence = !inFence;
    const level = inFence ? 0 : headingLevel(line);
    if (droppingLevel > 0 && level > 0 && level <= droppingLevel) droppingLevel = 0;
    if (droppingLevel === 0 && level > 0 && pattern.test(line)) {
      droppingLevel = level;
      continue;
    }
    if (droppingLevel === 0) out.push(line);
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
    .join(COMMAND_REFERENCES.join(", "))
    .replace(/\/impeccable (?=[a-z-])/gu, "@skill impeccable ");
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
    .filter((row) => !/^\| `(?:craft|live|generate)\b/u.test(row))
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
  const kept = frontmatterLines
    .filter((line) => /^(?:name|description):/u.test(line))
    .map((line) =>
      line.startsWith("description:")
        ? applyReplacements(line, DESCRIPTION_REPLACEMENTS, "SKILL.md description")
        : line,
    );
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
  // Placeholders resolve first so `{{command_prefix}}impeccable live` is visible to the
  // unavailable-command drop as `@skill impeccable live`.
  let out = resolvePlaceholders(text);
  out = dropSectionsMatching(out, LIVE_MODE_SECTION);
  out = dropLauncherFences(out);
  out = dropLauncherLines(out);
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

/** Drop every `<tag>` … `</tag>` block (the tag lines may be indented) for the listed tags. */
function dropTagBlocks(text, tags) {
  const out = [];
  let closing;
  for (const line of text.split("\n")) {
    if (closing) {
      if (line.trim() === closing) closing = undefined;
      continue;
    }
    const tag = tags.find((candidate) => line.trim() === `<${candidate}>`);
    if (tag) {
      closing = `</${tag}>`;
      continue;
    }
    out.push(line);
  }
  if (closing) throw new SyncError(`unterminated ${closing.slice(2, -1)} block`);
  return out.join("\n");
}

export function transformReference(name, text) {
  let content = normalizeNewlines(text);
  const tagDrops = REFERENCE_TAG_DROPS[name];
  if (tagDrops) content = dropTagBlocks(content, tagDrops);
  const replacements = REFERENCE_REPLACEMENTS[name];
  if (replacements) content = applyReplacements(content, replacements, `reference/${name}.md`);
  const sectionDrops = REFERENCE_SECTION_DROPS[name];
  if (sectionDrops) content = dropSections(content, sectionDrops, `reference/${name}.md`);
  const paragraphDrops = REFERENCE_PARAGRAPH_DROPS[name];
  if (paragraphDrops) content = dropParagraphsStartingWith(content, paragraphDrops);
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

function buildNotice(sha, upstreamNotice, localFiles, splitCount) {
  const splitClause = splitCount > 0 ? " oversize references were split by section," : "";
  const lines = [
    "NOTICE",
    "",
    `This directory vendors prose from impeccable (${UPSTREAM_REPOSITORY}), copyright its contributors, licensed under the Apache License, Version 2.0 (see the LICENSE file in this directory). Vendored at commit ${sha}.`,
    "",
    `The vendored files were modified for the GoatCitadel runtime: the launcher, hooks, live mode, doctor, pin shortcuts, and native-platform references were removed, upstream placeholders were resolved,${splitClause} and the SKILL.md Setup section now reads the workspace design context. UPSTREAM.md lists every file, hash, exclusion, and transform.`,
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
    "| Vendored path | Upstream path | Upstream sha256 (LF-normalized) | Vendored sha256 | Notes |",
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
 * Stale-file removal deletes everything under the output directory that the sync does not own, so
 * the directory must be absent, empty, hold only GoatCitadel-authored local files, or already be an
 * impeccable skill directory (its SKILL.md or UPSTREAM.md says so). Anything else is refused by name.
 */
function assertImpeccableOutDir(out) {
  if (!fs.existsSync(out)) return;
  const existing = listFilesRecursive(out);
  const foreign = existing.filter((file) => !LOCAL_FILES.includes(file));
  if (foreign.length === 0) return;
  const skillPath = path.join(out, "SKILL.md");
  const upstreamPath = path.join(out, "UPSTREAM.md");
  const isImpeccableSkill = fs.existsSync(skillPath) && /^name: impeccable$/mu.test(fs.readFileSync(skillPath, "utf8"));
  const isImpeccableProvenance =
    fs.existsSync(upstreamPath) &&
    fs.readFileSync(upstreamPath, "utf8").startsWith("# Upstream provenance: impeccable");
  if (isImpeccableSkill || isImpeccableProvenance) return;
  throw new SyncError(
    `refusing to vendor into ${out}: it is not empty and holds no impeccable SKILL.md or UPSTREAM.md (found ${foreign
      .slice(0, 10)
      .join(", ")}${foreign.length > 10 ? ", ..." : ""})`,
  );
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
  assertImpeccableOutDir(out);
  const localFiles = LOCAL_FILES.filter((file) => fs.existsSync(path.join(out, file)));

  const outputs = new Map();
  const rows = [];
  let splitCount = 0;
  const record = (vendored, upstream, upstreamBytes, content, notes) => {
    outputs.set(vendored, content);
    rows.push({
      vendored,
      upstream,
      // Hash the LF form of the upstream bytes so the recorded value does not depend on the
      // checkout's core.autocrlf setting and can be reproduced on any machine.
      upstreamSha: sha256(Buffer.from(normalizeNewlines(upstreamBytes.toString("utf8")), "utf8")),
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
    splitCount += 1;
    record(`reference/${name}.md`, upstreamPath, bytes, split.index, `transformed; split index (${split.count} parts)`);
    for (const part of split.parts) {
      record(part.relative, upstreamPath, bytes, part.content, `transformed; part ${part.ordinal} of ${split.count}`);
    }
  }

  const noticePath = path.join(source, "NOTICE.md");
  const upstreamNotice = fs.existsSync(noticePath) ? normalizeNewlines(fs.readFileSync(noticePath, "utf8")) : "";
  outputs.set("NOTICE", buildNotice(sha, upstreamNotice, localFiles, splitCount));

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
