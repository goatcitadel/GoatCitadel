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

// Follow-up review IN-R02/GL-R03: cancel, recover, send-for-approval and single rejects are reversible too; a bulk
// "Reject all" stays red (DESIGN: "rejects in bulk").
const REVERSIBLE_VERBS =
  "Archive|Restore|Close\\b|Mark done|Deny|Confirm deny|Test|Send test|Send|Retry|Promote|Keep proposal|Cancel|Recover|Request|Reject(?! all)|Skip|Review prompt skipping";
// The opening tag may hold arrow functions, so "=>" is skipped while looking for the tag's closing ">".
const DANGER_BUTTON = /variant="danger"(?:=>|[^>])*?>\s*(?:\{[^}]*\?\s*)?["']?([^<{"']+)/g;
// A red button whose label is a bare identifier: `<Button variant="danger">{label}</Button>`.
const DANGER_DYNAMIC_LABEL = /variant="danger"(?:=>|[^>])*?>\s*\{(\w+)\}/g;
const DESTRUCTIVE_WORDS = /\b(revoke|delete|remov(?:e|al)|forget|discard|uninstall)\b/i;
const REVERSIBLE_IDS = new Set([
  "archive",
  "restore",
  "test",
  "close",
  "deny",
  "reject",
  "promote",
  "keep",
  "retry",
  "cancel",
  "recover",
  "pause",
  "resume",
]);
// Every `… ? "danger"`: the condition before it is scanned for any reversible literal, not only the last one.
const DANGER_TERNARY = /\?\s*["']danger["']/g;
const CONDITION_LITERAL = /===\s*["'](\w+)["']/g;
const DANGER_INVERTED = /!==\s*["'](\w+)["']\s*\?\s*["'][^"']+["']\s*:\s*["']danger["']/g;
const TYPED_LITERAL = /\btyped\w*\s*[!=]==?\s*["'`]|["'`][^"'`]+["'`]\s*[!=]==?\s*\btyped\w*/gi;
const UNSAVED_TITLE = /title="Unsaved[^"]*"/g;
const EVERY_HOST_DEFAULT = /empty to allow every host/i;
const SHARED_DIALOG = "ui/UnsavedChangesDialog.tsx";
const SHARED_TYPED = "ui/TypedConfirmation.tsx";

/**
 * Every `danger-actions: destructive <id>` exemption in the tree, ratcheted so a new one is a visible budget change.
 * Today: WorkScheduleInspector, where a schedule's "cancel" deletes it.
 */
export const DESTRUCTIVE_MARKER_BUDGET = 1;

export function countDestructiveMarkers(contents) {
  return contents.match(/danger-actions: destructive \w+/g)?.length ?? 0;
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

export function checkFile(relativePath, contents) {
  const findings = [];
  const report = (index, message) => findings.push(`${relativePath}:${lineOf(contents, index)}: ${message}`);
  // A reversible verb may follow a leading "Confirm" or "Review" ("Confirm retry"). A label that also names a
  // destructive step ("Close session and revoke grants") is rightly red.
  const isReversibleLabel = (label) =>
    new RegExp(`^\\s*(?:(?:Confirm|Review)\\s+)?(?:${REVERSIBLE_VERBS})`, "i").test(label) &&
    !DESTRUCTIVE_WORDS.test(label);
  for (const match of contents.matchAll(DANGER_BUTTON)) {
    if (isReversibleLabel(match[1])) report(match.index, `"${match[1].trim()}" is reversible and must not be red`);
  }
  for (const match of contents.matchAll(DANGER_DYNAMIC_LABEL)) {
    // Resolve the identifier from its single `const x = …;` assignment (up to the semicolon, so a prettier-wrapped
    // ternary is read whole): every label literal it can take, the strings not compared with ===, must be reversible.
    const assignments = [...contents.matchAll(new RegExp(`\\b(?:const|let)\\s+${match[1]}\\s*=\\s*([^;]+);`, "g"))];
    if (assignments.length !== 1) continue;
    const options = [...assignments[0][1].matchAll(/(===\s*)?["']([^"']+)["']/g)]
      .filter((literal) => !literal[1])
      .map((literal) => literal[2]);
    if (options.length && options.every(isReversibleLabel))
      report(match.index, `"${options[0].trim()}" is reversible and must not be red`);
  }
  // A marker names the one destructive id it exempts: `danger-actions: destructive cancel` on one of the three lines
  // above. Only that id is exempt; any other reversible id in the same condition is still reported.
  const exemptIds = (index) => {
    const lineStart = contents.lastIndexOf("\n", index);
    const above = contents.slice(0, lineStart).split(/\r?\n/).slice(-3).join("\n");
    return new Set([...above.matchAll(/danger-actions: destructive (\w+)/g)].map((marker) => marker[1]));
  };
  const reportCondition = (index, condition) => {
    const exempt = exemptIds(index);
    const reversible = [...condition.matchAll(CONDITION_LITERAL)]
      .map((literal) => literal[1])
      .find((id) => REVERSIBLE_IDS.has(id) && !exempt.has(id));
    if (reversible) report(index, `a "${reversible}" action is reversible and must not be red`);
  };
  for (const match of contents.matchAll(DANGER_TERNARY)) {
    // The condition is the expression between the nearest `{`, `;` or `return` (calls such as canRetry(id) stay
    // inside it) and this `?`, cut after any earlier `?` or `:` so only the branch that yields "danger" is read.
    const before = contents.slice(Math.max(0, match.index - 400), match.index);
    const boundary = Math.max(before.lastIndexOf("{"), before.lastIndexOf(";"), before.lastIndexOf("return"));
    let condition = before.slice(boundary + 1);
    const branch = Math.max(condition.lastIndexOf("?"), condition.lastIndexOf(":"));
    if (branch >= 0) condition = condition.slice(branch + 1);
    reportCondition(match.index, condition);
  }
  // The inverted form: `id !== "cancel" ? "secondary" : "danger"` paints exactly that id red.
  for (const match of contents.matchAll(DANGER_INVERTED)) {
    if (REVERSIBLE_IDS.has(match[1]) && !exemptIds(match.index).has(match[1]))
      report(match.index, `a "${match[1]}" action is reversible and must not be red`);
  }
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
  let markers = 0;
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    const contents = await fs.readFile(file, "utf8");
    findings.push(...checkFile(relative, contents));
    markers += countDestructiveMarkers(contents);
  }
  if (markers !== DESTRUCTIVE_MARKER_BUDGET)
    findings.push(
      `destructive markers: ${markers} in the tree, budget ${DESTRUCTIVE_MARKER_BUDGET}. Each exemption needs a reviewed budget change.`,
    );
  if (findings.length) {
    console.error("[danger-actions] violations (see DESIGN.md › Decisions and danger):");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[danger-actions] ${files.length} cockpit files follow the danger rule`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
