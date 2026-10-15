#!/usr/bin/env node
/*
 * Danger-actions guard (UI audit 2026-10-14, workstream A). Enforces the static parts of DESIGN.md "Decisions and
 * danger" in cockpit source:
 * 1. Red is never used for a reversible verb (archive, restore, close or mark done, deny, test, send, retry,
 *    promote), either as a literal `variant="danger"` button or through a kind-based condition.
 * 2. Typed confirmations go through typedConfirmationMatches, never a literal string comparison.
 * 3. Unsaved-changes prompts use the shared UnsavedChangesDialog, never a hand-written dialog.
 * 4. No grant form may describe an empty list as "allow everything".
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

const REVERSIBLE_VERBS =
  "Archive|Restore|Close\\b|Mark done|Deny|Confirm deny|Test|Send test|Send|Retry|Promote|Keep proposal";
// The opening tag may hold arrow functions, so "=>" is skipped while looking for the tag's closing ">".
const DANGER_BUTTON = /variant="danger"(?:=>|[^>])*?>\s*(?:\{[^}]*\?\s*)?["']?([^<{"']+)/g;
const DESTRUCTIVE_WORDS = /\b(revoke|delete|remove|forget|discard|uninstall)\b/i;
const DANGER_CONDITION =
  /===\s*["'](archive|restore|test|close|deny|reject|promote|keep|retry)["']\s*\?\s*["']danger["']/g;
const TYPED_LITERAL = /\btyped\w*\s*[!=]==?\s*["'`]|["'`][^"'`]+["'`]\s*[!=]==?\s*\btyped\w*/gi;
const UNSAVED_TITLE = /title="Unsaved[^"]*"/g;
const EVERY_HOST_DEFAULT = /empty to allow every host/i;
const SHARED_DIALOG = "ui/UnsavedChangesDialog.tsx";
const SHARED_TYPED = "ui/TypedConfirmation.tsx";

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

export function checkFile(relativePath, contents) {
  const findings = [];
  const report = (index, message) => findings.push(`${relativePath}:${lineOf(contents, index)}: ${message}`);
  for (const match of contents.matchAll(DANGER_BUTTON)) {
    // A label that also names a destructive step ("Close session and revoke grants") is rightly red.
    if (new RegExp(`^\\s*(?:${REVERSIBLE_VERBS})`).test(match[1]) && !DESTRUCTIVE_WORDS.test(match[1]))
      report(match.index, `"${match[1].trim()}" is reversible and must not be red`);
  }
  for (const match of contents.matchAll(DANGER_CONDITION))
    report(match.index, `a "${match[1]}" action is reversible and must not be red`);
  if (relativePath !== SHARED_TYPED) {
    for (const match of contents.matchAll(TYPED_LITERAL))
      report(match.index, "compare typed confirmations with typedConfirmationMatches");
  }
  if (relativePath !== SHARED_DIALOG) {
    for (const match of contents.matchAll(UNSAVED_TITLE))
      report(match.index, "use the shared UnsavedChangesDialog for unsaved changes");
  }
  const everyHost = EVERY_HOST_DEFAULT.exec(contents);
  if (everyHost) report(everyHost.index, "an empty list must not silently mean every host");
  return findings;
}

async function walk(dir) {
  // A directory that cannot be read must fail the guard, not pass silently.
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    }),
  );
  return groups.flat();
}

async function main() {
  const files = await walk(cockpitRoot);
  const findings = [];
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    findings.push(...checkFile(relative, await fs.readFile(file, "utf8")));
  }
  if (findings.length) {
    console.error("[danger-actions] violations (see DESIGN.md › Decisions and danger):");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[danger-actions] ${files.length} cockpit files follow the danger rule`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
