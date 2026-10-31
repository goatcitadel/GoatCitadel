import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanForbiddenStrings, syncImpeccable } from "./sync-impeccable.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "sync-impeccable.mjs");
const SHA = "c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2";

// Every reference the Phase 0 allowlist vendors. Hand-written here so the
// test does not ask the script what it should produce.
const VENDORED = [
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
];

const COMMAND_LIST =
  "shape, init, document, extract, critique, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize";

// Condensed upstream critique.md: every anchor the critique transforms require, the launcher
// loop, a Codex-only block, and the snapshot-persistence section that must not survive.
const CRITIQUE_FIXTURE = [
  "### Purpose",
  "",
  "Resolve one stable target, run two independent assessments, synthesize a design critique, persist a snapshot, and ask the user what to improve next. The chat response is the primary deliverable; the snapshot is an archive of that run.",
  "",
  "### Hard Invariants",
  "",
  "- Assessment A (design review) and Assessment B (detector/browser evidence) are both required, except on a native platform (see Assessment Orchestration).",
  '- Assessment A and B MUST run as two isolated sub-agents whenever a sub-agent/Task tool is exposed. Running them inline in this context is "possible" but is NOT permitted; it is a degraded run. Inline is allowed ONLY when no sub-agent tool exists (or the user declined, on harnesses that ask). Native platforms run A alone (see Assessment Orchestration).',
  "- If you degrade for any reason, the report's first line MUST be a banner: `⚠️ DEGRADED: single-context (<reason>)`. A silent degraded critique is a failed critique.",
  "- Assessment A must finish before detector findings enter the parent synthesis context. Detector output is deterministic, but it still anchors judgment.",
  "- A skipped detector is a failed critique run unless `impeccable detect` is missing or crashes after a real attempt.",
  "- Viewable targets require browser inspection when available.",
  "- Any local server started only for critique visualization must run in the background, have a recorded stop method, and be stopped before final reporting unless the user asks to keep it.",
  "- Do not claim a user-visible overlay exists unless script injection succeeded and the detector ran in the page.",
  "- The question is the LAST thing in the response.",
  "",
  "### Setup",
  "",
  "1. **Resolve the target** to a concrete file path or URL.",
  "2. **Confirm the target slugs cleanly**:",
  "   ```bash",
  '   {{scripts_path}}/impeccable critique-storage slug "<resolved-path-or-url>"',
  "   ```",
  "   Every later command also accepts the resolved target directly and derives the same slug internally; never hand-write a slug. If this exits non-zero, skip persistence and trend for this run, but continue the critique.",
  "3. **Read `.impeccable/critique/ignore.md`** if it exists. Drop matching findings silently.",
  "",
  "### Assessment Orchestration",
  "",
  "Delegate Assessment A and Assessment B to separate sub-agents. They must not see each other's output. Do not show findings to the user until synthesis.",
  "",
  "Sub-agent gate (all harnesses):",
  "- Unless a harness-specific gate below overrides this, spawn A and B as two isolated, parallel sub-agents whenever a sub-agent/Task tool is exposed.",
  "- Desktop apps (see **Desktop apps** under Assessment B) are the one exception to parallel: both sub-agents would drive the app's single window at once.",
  '- "Unavailable" means exactly one thing: no sub-agent/Task tool is exposed in this session.',
  "- If and only if sub-agents are unavailable, fall back sequentially.",
  "- Whichever path you take, declare it in the report header (see Report header provenance).",
  "",
  "<codex>",
  "Codex sub-agent gate (overrides the default above):",
  "- If `spawn_agent` is exposed, ask exactly once.",
  "</codex>",
  "",
  "If browser automation is available, each assessment creates its own new tab. Never reuse an existing tab, even if it is already at the right URL.",
  "",
  "### Assessment A: Design Review",
  "",
  "Read relevant source files and visually inspect the live page when browser automation is available. Think like a design director.",
  "",
  "- **Design specificity**: Is the visual language grounded in this product? Make this judgment before seeing detector output.",
  "",
  "Return: design-specificity verdict, heuristic scores, and provocative questions.",
  "",
  "### Assessment B: Detector + Browser Evidence",
  "",
  "Run the bundled detector and browser visualization evidence. On web, Assessment B is mandatory and must remain isolated from Assessment A until both are complete.",
  "",
  "CLI scan:",
  "```bash",
  "{{scripts_path}}/impeccable detect --json [target]",
  "```",
  "",
  "- Pass markup files/directories as `[target]`; do not pass CSS-only files.",
  "- For URLs, skip CLI scan and use browser visualization.",
  "- For very large trees (500+ scannable files), narrow scope or ask.",
  "- Exit code 0 = clean; 2 = findings.",
  "- If the detector entrypoint is missing or fails to load, report deterministic scan unavailable and continue with browser/manual review.",
  "",
  "Browser visualization is required for a viewable target when browser automation is available. Use a localhost dev/static URL for local files; avoid `file://` unless the available browser explicitly supports this workflow. Overlay flow:",
  "",
  "1. Create a fresh tab and navigate.",
  "2. Preflight mutable injection by setting `document.title` and appending a `<script>` tag.",
  "3. If mutation is unavailable, skip live server, browser presentation, and injection; report fallback signal.",
  "4. If mutation is available, start `{{scripts_path}}/impeccable live-server --background`, then stop the live server.",
  "5. For multi-view targets, inject on 3-5 representative pages.",
  "",
  "**Desktop apps** (Electron, NW.js, CEF, WebView2): there is no URL to open, so Assessment B attaches to the running app instead.",
  "",
  "1. Launch the app with a local DevTools port: `--remote-debugging-port=9222` (Electron, NW.js, CEF).",
  "2. Seed the state under review (route, open panel, theme, data). The scan reads the window as it stands.",
  "4. Take screenshots through the harness's CDP tooling (`Page.captureScreenshot` on the same target).",
  "",
  "The app has one window, so the assessments take turns in it instead of opening tabs (A, then B; see the sub-agent gate). Tauri on macOS (WKWebView) exposes no CDP.",
  "",
  "Return: CLI findings JSON/counts, browser console findings if applicable, false positives, and skipped/failed browser steps with concrete reasons.",
  "",
  "After Assessment B returns usable CLI findings, reuse them. Do not rerun `impeccable detect` in the parent.",
  "",
  "### Generate Combined Critique Report",
  "",
  "Synthesize both assessments into a single report, noting where the LLM review and detector agree, where the detector caught issues the LLM missed, and where detector findings are false positives.",
  "",
  "The chat response is the primary user-facing deliverable. Present the full structured critique below in chat; do not replace it with a summary and a link. The persisted snapshot is an archive of that run.",
  "",
  "#### Report header provenance",
  "",
  "The report's first line MUST declare how the assessments were run, so a degraded run is never silent:",
  "- Dual-agent: `Method: dual-agent (A: <agent-id> · B: <agent-id>)`",
  "- Degraded: `⚠️ DEGRADED: single-context (<reason, e.g. no sub-agent tool exposed>)`",
  "- Native: `Method: design review only (detector not applicable, native platform)`",
  "",
  "#### Design Health Score",
  "",
  "**Mode applicability**: heuristics 7 and 10 may be scored `n/a`, and renormalize the total so the rating band stays proportional. The persisted snapshot must record the applicable maximum and which heuristics were scored n/a.",
  "",
  "#### Design Specificity Verdict",
  "",
  "**Deterministic scan**: Summarize what the automated detector found, with counts and file locations. Note any additional issues the detector caught that you missed, and flag any false positives. On a native platform, write `not applicable (native platform)` instead.",
  "",
  "**Visual overlays** (if injection succeeded): Tell the user that overlays are now visible in the **[Human]** tab in their browser, highlighting the detected issues. Summarize what the console output reported. If browser visualization was attempted but injection failed, say that no reliable user-visible overlay is available and report the fallback signal instead.",
  "",
  "#### Priority Issues",
  "",
  "- **Suggested command**: Which command could address this (from: {{available_commands}})",
  "",
  "#### Persona Red Flags",
  "",
  "Auto-select 2-3 personas most relevant to this interface type (use the selection table in the reference). If `{{config_file}}` contains a `## Design Context` section from `impeccable init`, also generate 1-2 project-specific personas from the audience/brand info.",
  "",
  "### Deliver the Report",
  "",
  "Write the full report into the chat response now, before any persistence work. This is the deliverable; everything below it is bookkeeping.",
  "",
  "Do this first because the alternative is the most common way this command fails: the report gets composed once, straight into the persistence heredoc.",
  "",
  "Persistence is not the end of the run. After it, the response continues with the trend line and the close.",
  "",
  "### Persist the Snapshot",
  "",
  "Once the report above is finalized, write it to `.impeccable/critique/` so the user can refer back, and so `{{command_prefix}}impeccable polish` can pick up the priority issues without a copy-paste.",
  "",
  "1. **Write the body to a temp file** so you can pipe it to the helper.",
  "",
  "   <codex>",
  "   Codex: exclude Run Notes from the temp body file.",
  "   </codex>",
  "",
  "2. **Pass the structured metadata**:",
  "   ```bash",
  '   {{scripts_path}}/impeccable critique-storage write "<resolved target>" <body-file>',
  "   ```",
  "",
  "### Ask the User",
  "",
  "**After presenting findings**, use targeted questions based on what was actually found. {{ask_instruction}} These answers will shape the action plan.",
  "",
  "### Recommended Actions",
  "",
  "- Only recommend commands from: {{available_commands}}",
  "- End with `{{command_prefix}}impeccable polish` as the final step if any fixes were recommended",
  "",
  "> Re-run `{{command_prefix}}impeccable critique` after fixes to see your score improve.",
  "",
  "---",
  "",
  "## Reference Material",
  "",
  "### Persona-Based Design Testing",
  "",
  "#### Project-Specific Personas",
  "",
  "If `{{config_file}}` contains a `## Design Context` section (generated by `impeccable init`), derive 1–2 additional personas from the audience and brand information:",
  "",
  "- Audience-specific persona.",
  "",
].join("\n");

// Trimmed copy of the real upstream SKILL.src.md shapes the transforms anchor on.
const SKILL_SRC = [
  "---",
  "name: impeccable",
  'description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface: websites, landing pages, dashboards, product UI, components, forms, settings, onboarding, empty states, and native iOS or Android screens. Also for making bland UI bolder, loud UI quieter, or ambitious visual effects. Not for backend-only or non-UI tasks."',
  'argument-hint: "[{{command_hint}}] [target]"',
  "user-invocable: true",
  "allowed-tools:",
  "  - Bash(npx impeccable *)",
  "  - Bash({{scripts_path}}/impeccable *)",
  "license: Apache 2.0",
  "---",
  "",
  "This skill gives you the tools and permission to create design that earns to be called out-of-distribution craft.",
  "",
  "## Setup",
  "",
  "1. Run `<skill-base-dir>/scripts/impeccable context` once per session, where `<skill-base-dir>` is the directory that contains this SKILL.md. <!-- rule:skill-setup-context -->",
  "2. Load the request's playbook: its Commands-table reference for an explicit/implied sub-command, or [reference/new-work.md](reference/new-work.md) for a new surface. <!-- rule:skill-setup-command-ref -->",
  "3. After resolving analysis and direction, read [reference/craft-floor.md](reference/craft-floor.md) immediately before any UI edit. <!-- rule:skill-craft-floor-load -->",
  "",
  "**Launcher unavailable:** On refusal or failure, send a separate message **before the next tool call**: “Context loading did not run; I’ll read the existing project context directly.”",
  "",
  "## How to design",
  "",
  "- **The brief wins.** Honor pinned aesthetics. <!-- rule:skill-brief-wins -->",
  "- **Refinement preserves; redesign replaces.** Redesign treats the old look as evidence and anti-reference; choose a replacement world in new-work and replace DESIGN.md. <!-- rule:skill-world-change-semantics -->",
  "- **Visual authority is evidence, not a filename.** Missing DESIGN.md alone does not make a project greenfield; new-work decides whether to preserve, expand, or replace the incumbent world. <!-- rule:skill-new-work-gate -->",
  "",
  "## Modes",
  "",
  "- **Persuade:** the visitor decides and acts.",
  "",
  "See [new-work.md](reference/new-work.md) for new surfaces and [operate.md](reference/operate.md) for deeper Operate/Read guidance. <!-- rule:skill-visitor-mode -->",
  "",
  "## Commands",
  "",
  "| Command | Category | Description | Reference |",
  "|---|---|---|---|",
  "| `craft [feature]` | Build | Deprecated alias for an ordinary new-work request | [reference/craft.md](reference/craft.md) |",
  "| `shape [feature]` | Build | Plan UX/UI before writing code | [reference/shape.md](reference/shape.md) |",
  "| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |",
  "| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) · native: [reference/audit.native.md](reference/audit.native.md) |",
  "| `polish [target]` | Refine | Final quality pass before shipping | [reference/polish.md](reference/polish.md) |",
  "| `live` | Iterate | Visual variant mode | [reference/live.md](reference/live.md) |",
  "| `generate [n] [action] [element]` | Iterate | Variants of a named element | [reference/generate.md](reference/generate.md) |",
  "",
  "Routing: <!-- rule:skill-routing -->",
  "",
  "- **No argument:** read [routing.md](reference/routing.md) and present its context-aware menu; never auto-run a command.",
  "- **Explicit or clearly implied request to run a command:** load its reference (native variant on native platforms) and follow it. Ask once if two commands fit.",
  "- **Workflow or command-selection question:** read [Workflow questions](reference/routing.md#workflow-questions).",
  "- **Otherwise:** treat the request as general design work. Missing PRODUCT.md routes a new surface or replacement world through init, then new-work; a narrow refinement of existing code proceeds on the incumbent implementation as `impeccable context` directs, offering init afterward rather than blocking on it.",
  "- `teach` aliases `init`. `craft` is a deprecated alias for ordinary new-work and adds nothing. `shape` owns task discovery, then enters new-work only for visual-world and surface-concept decisions.",
  "",
  "After init writes PRODUCT.md, resume without rerunning `impeccable context`; init loads the native platform reference itself.",
  "",
  "**Pin / Unpin:** `{{scripts_path}}/impeccable pin <pin|unpin> <command>` creates or removes a standalone `{{command_prefix}}<command>` shortcut.",
  "",
  "**Hooks:** `{{command_prefix}}impeccable hooks <on|off|status>` manages the design detector hook. Load [reference/hooks.md](reference/hooks.md) when the user invokes it.",
  "",
  "**Doctor:** `{{command_prefix}}impeccable doctor` reports and repairs drift. Load [reference/doctor.md](reference/doctor.md) when the user invokes it.",
  "",
  "**Never repair drift as a side effect of a design task.** A `CONTEXT_STALE` finding is reported, not acted on. <!-- rule:skill-drift-not-a-side-quest -->",
  "",
].join("\n");

const REFERENCES = {
  "craft-floor": "# Craft floor\n\nLoad this after the direction is settled. <!-- rule:skill-craft-floor -->\n",
  "mode-persuade":
    "# Persuade\n\n`impeccable concept-seed --mode persuade` (or `experience`) prints the two sections below as its MODE RULES block. On these surfaces the design is what the visitor judges.\n\n## Rules\n\n- Earn attention.\n",
  "mode-operate":
    "# Operate\n\n`impeccable concept-seed --mode operate` prints the two sections below as its MODE RULES block. On an Operate surface the visitor came to get a job done.\n",
  "mode-read":
    "# Read\n\n`impeccable concept-seed --mode read` prints the two sections below as its MODE RULES block. On a Read surface the visitor came to understand something.\n",
  init: [
    "# Init",
    "",
    "`init` captures durable product truth in PRODUCT.md. It does not write DESIGN.md; [new-work.md](new-work.md) creates one, and [document.md](document.md) records an incumbent one.",
    "",
    "Use the PRODUCT.md path resolved by `impeccable context`. Update it instead of creating a competing authority.",
    "",
    "- **Redesign/rebrand request:** preserve confirmed product truth unless the user changes it. Visual replacement happens later in new-work, not here.",
    "",
    "Never silently overwrite an existing file or offer DESIGN.md during init. If another request invoked init, finish PRODUCT.md and resume it. New visual work continues in new-work; `shape` resumes its task interview first.",
    "",
    "Before loading new-work or resuming shape/build, verify that PRODUCT.md exists at the resolved path and contains the confirmed product record.",
    "",
    "{{ask_instruction}} Ask only about material gaps.",
    "",
    "When the platform you just recorded is `ios`, load [ios.md](ios.md) before any design work. On a project that had no PRODUCT.md, `impeccable context` could not know the platform.",
    "",
    "Write the answer to `.impeccable/config.json` as buildPath.",
    "",
    "## Step 5: Record workflow defaults",
    "",
    "Then configure live mode when useful. Otherwise follow [live.md](live.md)'s first-time setup.",
    "",
    "## Step 6: Wrap up or resume",
    "",
    "- Empty or early project: use `/impeccable shape <surface>` when the user wants a brief. New-work will establish a visual world only when the requested work needs one.",
    "- Web project ready for visual iteration: `/impeccable live` when configured.",
    "- Iterate in the browser with `{{command_prefix}}impeccable live` once the dev server runs.",
    "",
  ].join("\n"),
  polish: [
    "# Polish",
    "",
    "Run the snapshot:",
    "",
    "```",
    '{{scripts_path}}/impeccable critique-storage latest "<resolved target>" --json',
    "```",
    "",
    "Exit 0 returns JSON with the latest snapshot's `body` and an exact `snapshot_file` identity. Retain `snapshot_file` until the end of the pass.",
    "",
    "Follow the quality guidance supplied by `impeccable context` and hooks, then run any other relevant QA commands. Context requests a manual scan only when no automatic detector is active; never add another detector pass. Fix real defects first.",
    "",
  ].join("\n"),
  audit: [
    "# Audit",
    "",
    "Run the bundled detector and verify each finding in context. Look for repeated shortcuts.",
    "",
    "- **Suggested command**: Which command to use (prefer: {{available_commands}})",
    "",
    "1. **[P?] `{{command_prefix}}command-name`**: Brief description",
    "",
    "> Re-run `{{command_prefix}}impeccable audit` after fixes.",
    "",
  ].join("\n"),
  bolder:
    '# Bolder\n\nAn open direction round owns the word first: "bolder" said while a direction decision is on the table is the Bolder hand register steer, a fresh deal of foreign forms (see new-work.md), not this command. This command refines a surface whose world already shipped.\n\nIf unclear, do not guess. {{ask_instruction}}\n\nWhen it holds, hand off to `{{command_prefix}}impeccable polish` for the final pass.\n',
  shape: [
    "# Shape",
    "",
    "Never ask for CSS values or canned aesthetic lanes. New-work owns visual-world and concept choices.",
    "",
    "For new surfaces, brand expansion, or replacement, follow [new-work.md](new-work.md) through visual authority, any world workshop, and concept choice. Reuse discovery, then return before its contract, persistence, or implementation.",
    "",
  ].join("\n"),
  typeset: [
    "# Typeset",
    "",
    "- **Native:** follow [ios.md](ios.md) or [android.md](android.md), including platform scaling.",
    "",
    "## Apply",
    "",
    "Run the detector scoped to type:",
    "",
    "```bash",
    "{{scripts_path}}/impeccable detect --json --scope type [target files or dirs]",
    "```",
    "",
    "Then fix.",
    "",
    "## Line breaks",
    "",
    "- An uneven break can carry meaning. Make it deliberate and keep it rare. The detector's `straggler` and `unbalanced-heading` findings are advisory for this reason; say which breaks are intended.",
    "",
    "## Live-mode signature params",
    "",
    "Every variant declares a coarse `scale` parameter.",
    "",
    "```json",
    '{"id":"scale","kind":"range"}',
    "```",
    "",
    "Follow [live.md](live.md)'s parameter contract.",
    "",
  ].join("\n"),
  harden: "# Harden\r\n\r\nTrailing spaces here.   \r\nAnd here.\t\r\n",
  critique: CRITIQUE_FIXTURE,
};

const EXCLUDED_FIXTURE = {
  "new-work": "# New work\n\n`{{scripts_path}}/impeccable concept-seed --scope surface`\n",
  "audit.native": "# Audit native\n",
};

function oversizeDocument() {
  return documentFixture({ oversize: true });
}

function documentFixture({ oversize }) {
  const filler = (label) => (oversize ? `${label} paragraph. `.repeat(600) : `${label} paragraph.`);
  return [
    "# Document",
    "",
    "Intro paragraph before any heading.",
    "",
    "## Step 1: Scan tokens",
    "",
    "- New-work found a coherent incumbent visual system but no `DESIGN.md`.",
    "- **Seed mode**: the project is pre-implementation. Ensure PRODUCT.md exists, then reuse new-work's visual-world workshop and write its directional DESIGN.md seed. Re-run in scan mode once there's code.",
    "",
    "Decide by scanning first (Scan mode Step 1). `/impeccable document --seed` requests new-work's world workshop, but it does not authorize replacing coherent code: when an incumbent system exists, offer scan mode or route an explicit identity-replacement request through new-work.",
    "",
    "- **Component sub-tokens** are limited to 8 props. Shadows, motion, focus rings, backdrop-filter: none of those fit. Carry them in the sidecar (Step 4b).",
    "- **Components**: one entry per variant. If a variant needs a property Stitch's 8-prop set doesn't cover (shadow, focus ring, backdrop-filter), carry the full snippet in the sidecar instead.",
    "",
    filler("Scan"),
    "",
    "```css",
    "## not a heading inside a fence",
    "```",
    "",
    "## Step 4: Write DESIGN.md",
    "",
    "**What changed from schemaVersion 1.** The old sidecar carried token primitive arrays. Those values now live in the frontmatter.",
    "",
    "- Don't invent frontmatter token groups outside Stitch's schema. Anything else belongs in the sidecar's `extensions`.",
    "",
    filler("Write"),
    "",
    "### Step 4b: Write .impeccable/design.json sidecar (extensions only)",
    "",
    "The sidecar at `.impeccable/design.json` carries extras.",
    "",
    "Regenerate the sidecar whenever you regenerate root `DESIGN.md`.",
    "",
    "### Step 5: Report",
    "",
    "Tell the user what was written.",
    "",
    "## Step 6: Verify",
    "",
    filler("Verify"),
    "",
    "### Step 1: Route through new-work's workshop",
    "",
    "If PRODUCT.md exists, load [new-work.md](new-work.md) and resolve visual authority. Seed mode requires a concrete first surface: use the target the user named, or ask what they want to make first. Run new-work's **Create or replace the visual world** flow, then **Commit the world**, so the visual world and its first expression are chosen together. Stop after the directional DESIGN.md seed.",
    "",
    "If new-work already completed the workshop in this session, use its chosen direction directly. Do not ask again.",
    "",
    "- **Colors**: the selected palette strategy and roles. Include values only when the user, an existing asset, or new-work's exploration established them; otherwise mark them `[to be resolved during implementation]`.",
    "",
    'Tell the user: "Re-run `/impeccable document` once you have some code. That pass will extract real tokens and generate the sidecar."',
    "",
  ].join("\n");
}

function makeUpstream(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-upstream-"));
  const referenceDir = path.join(root, "skill", "reference");
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.mkdirSync(path.join(root, "skill", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "skill", "SKILL.src.md"), overrides.skill ?? SKILL_SRC);
  fs.writeFileSync(path.join(root, "LICENSE"), "Apache License\nVersion 2.0, January 2004\n");
  fs.writeFileSync(path.join(root, "NOTICE.md"), "# Third-Party Notices\n\nplatform-design-skills, MIT.\n");
  const references = { ...REFERENCES, document: oversizeDocument(), ...(overrides.references ?? {}) };
  for (const name of VENDORED) {
    const body = references[name] ?? `# ${name}\n\nBody for ${name}.\n`;
    fs.writeFileSync(path.join(referenceDir, `${name}.md`), body);
  }
  for (const [name, body] of Object.entries(EXCLUDED_FIXTURE)) {
    fs.writeFileSync(path.join(referenceDir, `${name}.md`), body);
  }
  fs.writeFileSync(path.join(root, "skill", "agents", "impeccable-finish-reviewer.md"), "# Finish reviewer\n");
  return root;
}

function makeOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-out-"));
}

function read(outDir, relative) {
  return fs.readFileSync(path.join(outDir, relative), "utf8");
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function runSync(upstream, outDir) {
  return syncImpeccable({ sourceDir: upstream, sha: SHA, outDir });
}

test("refuses to run without --source and --sha", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: sync-impeccable --source <dir> --sha <commit>/u);
});

test("refuses a source without skill/SKILL.src.md or LICENSE", () => {
  const upstream = makeUpstream();
  fs.rmSync(path.join(upstream, "LICENSE"));
  assert.throws(() => runSync(upstream, makeOut()), /LICENSE/u);
  const upstreamNoSkill = makeUpstream();
  fs.rmSync(path.join(upstreamNoSkill, "skill", "SKILL.src.md"));
  assert.throws(() => runSync(upstreamNoSkill, makeOut()), /SKILL\.src\.md/u);
});

test("vendors only the allowlisted references and the license", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const files = listFiles(outDir);
  for (const name of VENDORED) {
    assert.ok(files.includes(`reference/${name}.md`), `missing reference/${name}.md`);
  }
  for (const excluded of ["new-work", "audit.native"]) {
    assert.ok(!files.includes(`reference/${excluded}.md`), `vendored excluded reference/${excluded}.md`);
  }
  assert.ok(!files.some((file) => file.startsWith("agents/")), "agents must not be vendored in Phase 0");
  assert.equal(read(outDir, "LICENSE"), "Apache License\nVersion 2.0, January 2004\n");
  for (const required of ["SKILL.md", "NOTICE", "UPSTREAM.md"]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
});

test("rewrites SKILL.md frontmatter, adds the modification notice, and replaces Setup", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const skill = read(outDir, "SKILL.md");
  const lines = skill.split("\n");
  assert.equal(lines[0], "---");
  const close = lines.indexOf("---", 1);
  const frontmatter = lines.slice(1, close);
  assert.ok(frontmatter.includes("name: impeccable"));
  assert.ok(frontmatter.some((line) => line.startsWith("description: ")));
  for (const dropped of ["argument-hint", "user-invocable", "allowed-tools", "license:", "Bash("]) {
    assert.ok(!frontmatter.some((line) => line.includes(dropped)), `frontmatter still carries ${dropped}`);
  }
  assert.ok(frontmatter.includes("metadata:"));
  assert.ok(frontmatter.includes('  version: "0.1.0"'));
  assert.ok(frontmatter.includes("    - impeccable"));
  assert.ok(frontmatter.includes("    - landing page"));
  const afterFrontmatter = lines.slice(close + 1).find((line) => line.trim().length > 0);
  assert.match(afterFrontmatter, /^> Vendored from \[pbakaus\/impeccable\]/u);
  assert.ok(afterFrontmatter.includes(`\`${SHA}\``));
  assert.ok(skill.includes("GoatCitadel ships no impeccable launcher"));
  assert.ok(skill.includes("[reference/craft-floor.md](reference/craft-floor.md)"));
  assert.ok(!skill.includes("Launcher unavailable"));
  assert.ok(!skill.includes("<skill-base-dir>"));
  assert.ok(skill.includes("## How to design"));
});

test("drops launcher-only Commands rows, strips native suffixes, and lists unavailable commands", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const skill = read(outDir, "SKILL.md");
  for (const row of ["| `craft [feature]`", "| `live`", "| `generate [n]"]) {
    assert.ok(!skill.includes(row), `row still present: ${row}`);
  }
  assert.ok(skill.includes("| `shape [feature]` | Build |"));
  assert.ok(
    skill.includes(
      "| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |",
    ),
  );
  assert.ok(
    skill.includes(
      "| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) |",
    ),
  );
  assert.ok(!skill.includes("native:"));
  assert.ok(skill.includes("Not available in this vendored build: `craft`, `live`, `generate`"));
  assert.ok(skill.includes("Use `critique`, `audit`, and `polish` for review passes."));
});

test("rewrites routing bullets without routing.md or launcher context", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const skill = read(outDir, "SKILL.md");
  assert.ok(skill.includes("- **No argument:** present a short menu of the commands above grouped by category"));
  assert.ok(!skill.includes("routing.md"));
  assert.ok(skill.includes("load its reference and follow it. Ask once if two commands fit."));
  assert.ok(!skill.includes("Workflow or command-selection question"));
  assert.ok(skill.includes("as the project design context directs"));
  assert.ok(skill.includes("- `teach` aliases `init`. `shape` owns task discovery and surface-concept decisions."));
  assert.ok(!skill.includes("deprecated alias"));
});

test("drops pin, hooks, doctor, drift, and post-init launcher paragraphs", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const skill = read(outDir, "SKILL.md");
  for (const gone of [
    "Pin / Unpin",
    "**Hooks:**",
    "**Doctor:**",
    "Never repair drift",
    "After init writes PRODUCT.md",
    "CONTEXT_STALE",
  ]) {
    assert.ok(!skill.includes(gone), `still present: ${gone}`);
  }
});

test("resolves placeholders to GoatCitadel equivalents", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  assert.ok(read(outDir, "reference/bolder.md").includes("hand off to `@skill impeccable polish` for the final pass."));
  const audit = read(outDir, "reference/audit.md");
  assert.ok(audit.includes(`(prefer: ${COMMAND_LIST})`));
  assert.ok(audit.includes("`@skill impeccable command-name`"));
  assert.ok(audit.includes("`@skill impeccable audit`"));
  assert.ok(
    read(outDir, "reference/init.md").includes(
      "Ask the operator with the user_input.request tool and wait for the answer. Ask only about material gaps.",
    ),
  );
});

test("rewrites links to references outside the allowlist as plain text", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const init = read(outDir, "reference/init.md");
  assert.ok(init.includes("new-work.md (not vendored in this GoatCitadel build) creates one"));
  assert.ok(init.includes("[document.md](document.md) records"));
  const skill = read(outDir, "SKILL.md");
  assert.ok(
    skill.includes(
      "See new-work.md (not vendored in this GoatCitadel build) for new surfaces and [operate.md](reference/operate.md)",
    ),
  );
});

test("drops launcher lines, launcher-only fences with their lead-in, and rewrites targeted clauses", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const polish = read(outDir, "reference/polish.md");
  assert.ok(!polish.includes("critique-storage"));
  assert.ok(!polish.includes("Run the snapshot:"));
  assert.ok(!polish.includes("```"));
  assert.ok(
    polish.includes(
      "Follow the quality guidance in the project design context, then run any other relevant QA commands. Fix real defects first.",
    ),
  );
  const typeset = read(outDir, "reference/typeset.md");
  assert.ok(!typeset.includes("detect"));
  assert.ok(!typeset.includes("Run the detector scoped to type:"));
  assert.ok(typeset.includes("Then fix."));
  const persuade = read(outDir, "reference/mode-persuade.md");
  assert.ok(
    persuade.includes(
      "The two sections below are this mode's MODE RULES. On these surfaces the design is what the visitor judges.",
    ),
  );
  assert.ok(!persuade.includes("concept-seed"));
  const init = read(outDir, "reference/init.md");
  assert.ok(
    init.includes(
      "Use the workspace PRODUCT.md design context when the runtime attaches one, otherwise the project's PRODUCT.md. Update it instead of creating a competing authority.",
    ),
  );
  assert.ok(!init.includes(".impeccable/config.json"));
  assert.ok(!init.includes("could not know the platform"));
  assert.ok(!init.includes("ios.md (not vendored"), "the native-platform line is dropped, not just unlinked");
});

test("drops the document sidecar section and splits oversize references by H2 with an index", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const index = read(outDir, "reference/document.md");
  assert.ok(index.startsWith("# Document\n"));
  assert.ok(index.includes("Intro paragraph before any heading."));
  assert.ok(index.includes("## Parts"));
  assert.ok(index.includes("[Step 1: Scan tokens](document/01-step-1-scan-tokens.md)"));
  assert.ok(index.includes("[Step 4: Write DESIGN.md](document/02-step-4-write-design-md.md)"));
  assert.ok(index.includes("[Step 6: Verify](document/03-step-6-verify.md)"));
  const parts = listFiles(path.join(outDir, "reference", "document"));
  assert.deepEqual(parts, ["01-step-1-scan-tokens.md", "02-step-4-write-design-md.md", "03-step-6-verify.md"]);
  const part1 = read(outDir, "reference/document/01-step-1-scan-tokens.md");
  assert.ok(part1.startsWith("# Document: Step 1: Scan tokens\n"));
  assert.ok(part1.includes("## not a heading inside a fence"));
  const part2 = read(outDir, "reference/document/02-step-4-write-design-md.md");
  assert.ok(!part2.includes("Step 4b"));
  assert.ok(!part2.includes(".impeccable/design.json"));
  assert.ok(!part2.includes("Regenerate the sidecar"));
  assert.ok(part2.includes("### Step 5: Report"));
  assert.ok(part2.includes("Tell the user what was written."));
});

test("drops live-mode sections, native lines, unavailable-command bullets, launcher artifact prose, and converts slash commands", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const typeset = read(outDir, "reference/typeset.md");
  assert.ok(!typeset.includes("Live-mode"));
  assert.ok(!typeset.includes("live.md"));
  assert.ok(!typeset.includes("Native:"));
  assert.ok(!typeset.includes("ios.md"));
  assert.ok(typeset.includes("## Apply"));
  const init = read(outDir, "reference/init.md");
  assert.ok(!init.includes("Step 5: Record workflow defaults"));
  assert.ok(!init.includes("configure live mode"));
  assert.ok(init.includes("## Step 6: Wrap up or resume"));
  assert.ok(init.includes("use `@skill impeccable shape <surface>` when the user wants a brief."));
  assert.ok(!init.includes("impeccable live"));
  const polish = read(outDir, "reference/polish.md");
  assert.ok(!polish.includes("snapshot_file"));
  assert.ok(!polish.includes("Exit 0 returns JSON"));
  const audit = read(outDir, "reference/audit.md");
  assert.ok(
    audit.includes(
      "Review any design advisories the runtime attached and verify each finding in context. Look for repeated shortcuts.",
    ),
  );
  assert.ok(!audit.includes("bundled detector"));
  const part3 = read(outDir, "reference/document/03-step-6-verify.md");
  assert.ok(
    part3.includes('Re-run `@skill impeccable document` once you have some code. That pass will extract real tokens."'),
  );
  assert.ok(!part3.includes("generate the sidecar"));
});

test("rewrites sidecar and new-work routing into operator-facing instructions and drops the native-platform claim", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const skill = read(outDir, "SKILL.md");
  const description = skill.split("\n").find((line) => line.startsWith("description: "));
  assert.ok(!description.includes("live browser"));
  assert.ok(!/\biOS\b|\bAndroid\b/u.test(description));
  assert.ok(description.includes("forms, settings, onboarding, and empty states."));
  assert.ok(description.includes("design, redesign, shape, critique, audit, polish,"));
  assert.ok(skill.includes("choose a replacement world with the operator and replace DESIGN.md"));
  assert.ok(skill.includes("the evidence decides whether to preserve, expand, or replace the incumbent world"));
  assert.ok(skill.includes("`new-work` (the visual-world workshop) is not vendored either"));
  assert.ok(skill.includes("user_input.request"));
  const part1 = read(outDir, "reference/document/01-step-1-scan-tokens.md");
  assert.ok(part1.includes("- A new-surface request found a coherent incumbent visual system but no `DESIGN.md`."));
  assert.ok(part1.includes("then choose the visual world with the operator and write a directional DESIGN.md seed"));
  assert.ok(
    part1.includes(
      "`@skill impeccable document --seed` requests the visual-world choice, but it does not authorize replacing coherent code: when an incumbent system exists, offer scan mode or treat an explicit identity-replacement request as a redesign chosen with the operator.",
    ),
  );
  assert.ok(part1.includes("Carry them in DESIGN.md prose under the relevant section."));
  assert.ok(part1.includes("carry the full snippet in DESIGN.md prose instead."));
  const part2 = read(outDir, "reference/document/02-step-4-write-design-md.md");
  assert.ok(!part2.includes("What changed from schemaVersion 1"));
  assert.ok(part2.includes("Anything else belongs in DESIGN.md prose under the relevant section."));
  const part3 = read(outDir, "reference/document/03-step-6-verify.md");
  assert.ok(part3.includes("### Step 1: Resolve the visual world with the operator"));
  assert.ok(
    part3.includes(
      "If PRODUCT.md exists, resolve visual authority inline: the new-work workshop is not vendored in this GoatCitadel build, so choose the visual world with the operator through user_input.request and record the choice in DESIGN.md.",
    ),
  );
  assert.ok(
    part3.includes(
      "Choose the visual world and its first expression together with the operator, then commit them in DESIGN.md.",
    ),
  );
  assert.ok(
    part3.includes(
      "If the visual world was already chosen in this session, use that direction directly. Do not ask again.",
    ),
  );
  assert.ok(part3.includes("or the operator's choice established them"));
  for (const part of [part1, part2, part3]) assert.ok(!part.includes("sidecar"));
  const init = read(outDir, "reference/init.md");
  assert.ok(init.includes("Visual replacement happens later, not here."));
  assert.ok(init.includes("New visual work continues after init; `shape` resumes its task interview first."));
  assert.ok(init.includes("Before any visual-world work or resuming shape/build, verify that PRODUCT.md exists"));
  assert.ok(init.includes("Establish a visual world only when the requested work needs one."));
  assert.ok(
    !init.includes("impeccable live"),
    "unavailable commands behind the command_prefix placeholder are dropped too",
  );
  const shape = read(outDir, "reference/shape.md");
  assert.ok(shape.includes("Visual-world and concept choices are made with the operator."));
  assert.ok(
    shape.includes(
      "resolve visual authority, any world choice, and concept choice with the operator (the new-work workshop is not vendored in this GoatCitadel build).",
    ),
  );
  assert.ok(
    read(outDir, "reference/bolder.md").includes("(the new-work workshop is not vendored in this GoatCitadel build)"),
  );
});

test("vendors a trimmed critique reference built on render evidence instead of the launcher loop", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const critique = read(outDir, "reference/critique.md");
  for (const kept of [
    "### Assessment B: Render Evidence",
    "Method: single-context (routed-context critique)",
    "desktop (1440×900) and phone (390×844)",
    "**Runtime advisories**:",
    "**Render evidence** (when snapshots were attached)",
    "Read the artifact markup from the routed context",
    "If the workspace PRODUCT.md or DESIGN.md names the audience or brand, derive",
    "`@skill impeccable polish`",
    "`@skill impeccable critique`",
    "### Ask the User",
    `(from: ${COMMAND_LIST})`,
  ]) {
    assert.ok(critique.includes(kept), `critique lost: ${kept}`);
  }
  for (const gone of [
    "critique-storage",
    "impeccable detect",
    "live-server",
    "<codex>",
    "</codex>",
    "### Persist the Snapshot",
    "sub-agent",
    "Sub-agent gate",
    "DEGRADED",
    "overlay",
    "Dual-agent",
    "persisted snapshot",
    "persist a snapshot",
    "Persistence is not the end",
    "Do this first because",
    "browser automation",
    "Pass markup files",
    "Create a fresh tab",
    ".impeccable/",
    "{{",
    "detector",
    "Desktop apps",
    "Electron",
    "CDP",
    "native platform",
    "The app has one window",
  ]) {
    assert.ok(!critique.includes(gone), `critique still contains: ${gone}`);
  }
  const typeset = read(outDir, "reference/typeset.md");
  assert.ok(!typeset.includes("straggler"), "typeset still names an upstream detector rule");
  assert.ok(typeset.includes("Make it deliberate and keep it rare. Say which breaks are intended."));
  const upstreamDoc = read(outDir, "UPSTREAM.md");
  assert.ok(upstreamDoc.includes("| reference/critique.md | skill/reference/critique.md |"));
  assert.ok(!upstreamDoc.includes("- skill/reference/critique.md:"));
  assert.ok(upstreamDoc.includes("critique.md: Codex-only"));
});

test("refuses to vendor into a directory that is not an impeccable skill directory", () => {
  const outDir = makeOut();
  fs.writeFileSync(path.join(outDir, "SKILL.md"), "---\nname: other-skill\ndescription: x\n---\n\nBody.\n");
  fs.mkdirSync(path.join(outDir, "reference"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "reference", "theirs.md"), "# Theirs\n");
  assert.throws(() => runSync(makeUpstream(), outDir), /refusing to vendor into .*SKILL\.md/u);
  assert.ok(fs.existsSync(path.join(outDir, "reference", "theirs.md")), "nothing was deleted");
  assert.equal(read(outDir, "SKILL.md"), "---\nname: other-skill\ndescription: x\n---\n\nBody.\n");
});

test("guards leftover sidecar and unavailable-command mentions", () => {
  assert.throws(
    () => runSync(makeUpstream({ references: { harden: "# Harden\n\nKeep it in the sidecar.\n" } }), makeOut()),
    /reference\/harden\.md:3: sidecar/u,
  );
  // Prose lines invoking an unavailable command are dropped; one inside a code fence survives the
  // drop and must still be refused.
  assert.throws(
    () =>
      runSync(makeUpstream({ references: { harden: "# Harden\n\n```\n@skill impeccable live\n```\n" } }), makeOut()),
    /reference\/harden\.md:4: @skill impeccable live/u,
  );
});

test("records LF-normalized upstream hashes and only claims a split when one happened", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const upstreamDoc = read(outDir, "UPSTREAM.md");
  assert.ok(
    upstreamDoc.includes(
      "| Vendored path | Upstream path | Upstream sha256 (LF-normalized) | Vendored sha256 | Notes |",
    ),
  );
  const hardenUpstreamLf = sha256(Buffer.from("# Harden\n\nTrailing spaces here.   \nAnd here.\t\n", "utf8"));
  assert.ok(upstreamDoc.includes(`| reference/harden.md | skill/reference/harden.md | ${hardenUpstreamLf} |`));
  assert.ok(read(outDir, "NOTICE").includes("oversize references were split by section"));
  const smallOut = makeOut();
  runSync(makeUpstream({ references: { document: documentFixture({ oversize: false }) } }), smallOut);
  assert.ok(fs.existsSync(path.join(smallOut, "reference", "document.md")));
  assert.ok(!fs.existsSync(path.join(smallOut, "reference", "document")), "no split directory for a small reference");
  assert.ok(!read(smallOut, "NOTICE").includes("were split"));
});

test("normalizes line endings and trailing whitespace", () => {
  const outDir = makeOut();
  runSync(makeUpstream(), outDir);
  const harden = read(outDir, "reference/harden.md");
  assert.equal(harden, "# Harden\n\nTrailing spaces here.\nAnd here.\n");
});

test("fails the forbidden-string guard naming the file and line", () => {
  const upstream = makeUpstream({
    references: { harden: "# Harden\n\nSafe line.\nWrite `{{config_file}}` here.\n" },
  });
  assert.throws(
    () => runSync(upstream, makeOut()),
    (error) => {
      assert.match(error.message, /reference\/harden\.md:4/u);
      assert.match(error.message, /\{\{config_file\}\}/u);
      return true;
    },
  );
  const grokUpstream = makeUpstream({ references: { extract: "# Extract\n\nAlso works in Grok Build.\n" } });
  assert.throws(() => runSync(grokUpstream, makeOut()), /reference\/extract\.md:3/u);
});

test("writes UPSTREAM.md with the commit, per-file hashes, exclusions, transforms, and local files", () => {
  const outDir = makeOut();
  fs.mkdirSync(path.join(outDir, "reference"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "reference", "artifacts.md"), "# Artifacts\n\nGoatCitadel-authored.\n");
  runSync(makeUpstream(), outDir);
  const upstreamDoc = read(outDir, "UPSTREAM.md");
  assert.ok(upstreamDoc.includes("https://github.com/pbakaus/impeccable"));
  assert.ok(upstreamDoc.includes(`Commit: \`${SHA}\``));
  const craftFloorHash = sha256(fs.readFileSync(path.join(outDir, "reference", "craft-floor.md")));
  assert.ok(upstreamDoc.includes(`| reference/craft-floor.md | skill/reference/craft-floor.md |`));
  assert.ok(upstreamDoc.includes(craftFloorHash));
  assert.ok(upstreamDoc.includes("reference/critique.md"));
  assert.ok(upstreamDoc.includes("## Transforms applied"));
  assert.ok(upstreamDoc.includes("## GoatCitadel-authored files"));
  assert.ok(upstreamDoc.includes("- reference/artifacts.md"));
  assert.ok(upstreamDoc.includes("reference/document/01-step-1-scan-tokens.md"));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/u.test(upstreamDoc), "no timestamps: output must be deterministic");
  const notice = read(outDir, "NOTICE");
  assert.ok(notice.includes("Apache License"));
  assert.ok(notice.includes(SHA));
  assert.ok(notice.includes("reference/artifacts.md"));
});

test("preserves local files, removes stale vendored files on re-sync, and is idempotent", () => {
  const outDir = makeOut();
  fs.mkdirSync(path.join(outDir, "reference"), { recursive: true });
  const local = "# Artifacts\n\nGoatCitadel-authored.\n";
  fs.writeFileSync(path.join(outDir, "reference", "artifacts.md"), local);
  const upstream = makeUpstream();
  runSync(upstream, outDir);
  // A file left behind by an earlier vendoring (or a renamed reference) is stale on the next sync.
  fs.writeFileSync(path.join(outDir, "reference", "stale.md"), "# Stale\n");
  runSync(upstream, outDir);
  assert.equal(read(outDir, "reference/artifacts.md"), local);
  assert.ok(!fs.existsSync(path.join(outDir, "reference", "stale.md")));
  const first = new Map(listFiles(outDir).map((file) => [file, sha256(fs.readFileSync(path.join(outDir, file)))]));
  runSync(upstream, outDir);
  const second = new Map(listFiles(outDir).map((file) => [file, sha256(fs.readFileSync(path.join(outDir, file)))]));
  assert.deepEqual([...second.entries()], [...first.entries()]);
});

test("scanForbiddenStrings reports line numbers case-insensitively", () => {
  assert.deepEqual(scanForbiddenStrings("clean line\nanother clean line\n"), []);
  assert.deepEqual(scanForbiddenStrings("a\nworks on Grok Build\n"), [{ line: 2, match: "Grok" }]);
  assert.deepEqual(scanForbiddenStrings("run npx impeccable detect\n"), [{ line: 1, match: "npx impeccable" }]);
});
