#!/usr/bin/env node
// Meta-check (review Finding 5): the release-proof matrix must actually trigger
// for the current release line. Historically it fired only on `push: tags: v*`,
// but the shipping version is `0.1.0-rc.1` (no `v` prefix), so tagging the real
// release would NOT have run the matrix — it went dark for 458 commits. This
// asserts two things so that regression cannot recur silently:
//   1. the workflow declares a `schedule:` trigger (guards `main` between tags), and
//   2. at least one `push.tags` glob matches the current package.json version.
// Wired into `docs:check` so it runs on every PR/push in the fast lane.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const workflowPath = resolve(repoRoot, ".github/workflows/verification-1-0-release-proof.yml");
const pkgPath = resolve(repoRoot, "package.json");

const workflow = readFileSync(workflowPath, "utf8");
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;

const errors = [];

// 1. Require a schedule trigger so the matrix runs against main between releases.
if (!/^\s*schedule:\s*$/m.test(workflow)) {
  errors.push(
    "verification-1-0-release-proof.yml has no `schedule:` trigger — the release-proof matrix would only run on manual dispatch or a matching tag, leaving `main` unguarded between releases.",
  );
}

// 2. Collect push.tags globs and require one to match the current version.
// Lightweight line scan (no yaml dep): find the `tags:` block and read its list items.
const tagGlobs = [];
const lines = workflow.split(/\r?\n/);
let inTags = false;
let tagsIndent = 0;
for (const line of lines) {
  const tagsHeader = line.match(/^(\s*)tags:\s*$/);
  if (tagsHeader) {
    inTags = true;
    tagsIndent = tagsHeader[1].length;
    continue;
  }
  if (inTags) {
    const item = line.match(/^(\s*)-\s*["']?([^"'#]+?)["']?\s*$/);
    if (item && item[1].length > tagsIndent) {
      tagGlobs.push(item[2].trim());
      continue;
    }
    if (line.trim() !== "" && !/^\s*#/.test(line)) {
      inTags = false;
    }
  }
}

function globToRegExp(glob) {
  // GitHub tag filter semantics: `*` matches any run of non-`/` chars; other
  // chars (including `.` and `-`) are literals. Enough for `v*`, `*.*.*`, `*.*.*-*`.
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

if (tagGlobs.length === 0) {
  errors.push("verification-1-0-release-proof.yml declares no `push.tags` globs.");
} else if (!tagGlobs.some((g) => globToRegExp(g).test(version))) {
  errors.push(
    `No release-proof tag glob matches the current version "${version}". ` +
      `Globs: [${tagGlobs.join(", ")}]. Tagging the real release would not trigger the matrix. ` +
      `Add a glob such as "*.*.*-*" (pre-release) / "*.*.*" (release).`,
  );
}

if (errors.length > 0) {
  console.error("check-release-proof-tag-glob: FAIL");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

console.log(
  `check-release-proof-tag-glob: OK (version "${version}" matched by [${tagGlobs.join(", ")}]; schedule trigger present)`,
);
