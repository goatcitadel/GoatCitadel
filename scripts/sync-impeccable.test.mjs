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
  "shape, init, document, extract, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize";

// Trimmed copy of the real upstream SKILL.src.md shapes the transforms anchor on.
const SKILL_SRC = [
  "---",
  "name: impeccable",
  'description: "Use when the user wants to design, redesign, or polish a frontend interface."',
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
    "- Empty or early project: use `/impeccable shape <surface>` when the user wants a brief.",
    "- Web project ready for visual iteration: `/impeccable live` when configured.",
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
    "# Bolder\n\nIf unclear, do not guess. {{ask_instruction}}\n\nWhen it holds, hand off to `{{command_prefix}}impeccable polish` for the final pass.\n",
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
};

const EXCLUDED_FIXTURE = {
  critique: "# Critique\n\nRun `npx impeccable detect` and trust Grok Build.\n",
  "new-work": "# New work\n\n`{{scripts_path}}/impeccable concept-seed --scope surface`\n",
  "audit.native": "# Audit native\n",
};

function oversizeDocument() {
  const filler = (label) => `${label} paragraph. `.repeat(600);
  return [
    "# Document",
    "",
    "Intro paragraph before any heading.",
    "",
    "## Step 1: Scan tokens",
    "",
    filler("Scan"),
    "",
    "```css",
    "## not a heading inside a fence",
    "```",
    "",
    "## Step 4: Write DESIGN.md",
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
  for (const excluded of ["critique", "new-work", "audit.native"]) {
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
  for (const row of ["| `craft [feature]`", "| `critique [target]`", "| `live`", "| `generate [n]"]) {
    assert.ok(!skill.includes(row), `row still present: ${row}`);
  }
  assert.ok(skill.includes("| `shape [feature]` | Build |"));
  assert.ok(
    skill.includes(
      "| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) |",
    ),
  );
  assert.ok(!skill.includes("native:"));
  assert.ok(skill.includes("Not available in this vendored build: `craft`, `critique`, `live`, `generate`"));
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
  const grokUpstream = makeUpstream({ references: { shape: "# Shape\n\nAlso works in Grok Build.\n" } });
  assert.throws(() => runSync(grokUpstream, makeOut()), /reference\/shape\.md:3/u);
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

test("preserves local files, removes stale vendored files, and is idempotent", () => {
  const outDir = makeOut();
  fs.mkdirSync(path.join(outDir, "reference"), { recursive: true });
  const local = "# Artifacts\n\nGoatCitadel-authored.\n";
  fs.writeFileSync(path.join(outDir, "reference", "artifacts.md"), local);
  fs.writeFileSync(path.join(outDir, "reference", "stale.md"), "# Stale\n");
  const upstream = makeUpstream();
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
