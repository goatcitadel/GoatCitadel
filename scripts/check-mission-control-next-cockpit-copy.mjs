#!/usr/bin/env node
/*
 * Cockpit copy guard. Inside the cockpit, "current Chat", "current controls" and similar
 * phrases read as "right here", but they were used to mean the classic shell. Handoffs must
 * say "classic view" instead. Descriptive uses that really mean the present Chat
 * ("do not govern current Chat", "current Chat turn", the "Current Chat question" label)
 * are allowed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

const BANNED = [
  /\bcurrent (?:Ops(?: Kanban)?|controls|Settings|Approvals|Kanban|Runtime|Library)\b/,
  /\b(?:open|in|to|resolve it in|return to|review it in)\s+(?:the\s+)?current Chat\b(?!\s+turns?\b)/i,
  /label=["'{][^"'}]*\bcurrent\s/,
];

/** Lines that are code comments cannot reach the UI. */
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

export function findClassicHandoffCopy(filePath, contents) {
  const findings = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    if (isComment(line)) return;
    for (const pattern of BANNED) {
      const match = pattern.exec(line);
      if (match) {
        findings.push({ file: filePath, line: index + 1, text: match[0] });
        break;
      }
    }
  });
  return findings;
}

/*
 * Operator-language ratchets (UI audit 2026-10-14, workstream C; DESIGN.md › Copy and Glossary). Each counts uses in
 * text an operator can see: string literals with a space in them, JSX text between tags, and text-only lines. Each
 * budget is exact: above it fails, below it asks for a lower budget in the same change.
 */
export const COPY_RATCHETS = [
  {
    id: "internal-terms",
    pattern:
      /\b(?:projections?|durable|posture|canonical|Gateway-authored|owner-reported|callers?|admitted|admission|readback|live proof|rebas(?:e|ed|ing))\b/gi,
    budget: 0,
    help: "use the DESIGN.md glossary words; keep internal terms in TechnicalDetails",
  },
  {
    id: "dead-end-pointer",
    pattern:
      /\b(?:Open|Use|See|Review|Inspect)\b[^.!?]{0,60}?\b(?:in|from)\s+(?:Ops|Classic|the classic view|Approvals)\b/g,
    budget: 0,
    help: "link to the destination in the same element, or name a control that exists here",
  },
  {
    id: "aria-label-id",
    budget: 0,
    help: "accessible names start with the visible text and never read IDs",
  },
];
const ARIA_ID = /aria-label=\{`[^`]*\$\{[^}]*\b\w*(?:Id|ID)\b[^}]*\}[^`]*`\}/g;
const CODE_LINE =
  /^(?:import|export|const|let|var|return|if|else|for|while|function|type|interface|case|await|throw|switch|default|try|catch)\b/;

/** The parts of a source file an operator can read. */
export function visibleText(contents) {
  const parts = [];
  for (const line of contents.split(/\r?\n/)) {
    if (isComment(line)) continue;
    for (const match of line.matchAll(/(["'`])((?:(?!\1).)*\s(?:(?!\1).)*)\1/g)) parts.push(match[2]);
    for (const match of line.matchAll(/>([^<>{}=]*[A-Za-z][^<>{}=]*)</g)) parts.push(match[1]);
    const trimmed = line.trim();
    // A text-only line is JSX text; parameter lists ("projection: Inbox,"), continued conditions and property
    // access ("projection.items") are code.
    const code =
      CODE_LINE.test(trimmed) || /^\w+\??:\s/.test(trimmed) || /[,(]$/.test(trimmed) || /\w\.\w/.test(trimmed);
    if (/^[A-Za-z(][^=;{}<>"'`|&]*$/.test(trimmed) && !code && /\s/.test(trimmed)) parts.push(trimmed);
  }
  return parts;
}

export function countCopyRatchets(relativePath, contents) {
  const counts = {};
  const text = visibleText(contents);
  for (const rule of COPY_RATCHETS) {
    if (!rule.pattern) continue;
    const hits = text.reduce((sum, part) => sum + (part.match(rule.pattern)?.length ?? 0), 0);
    if (hits) counts[rule.id] = hits;
  }
  const ariaIds = relativePath.endsWith(".tsx") ? (contents.match(ARIA_ID)?.length ?? 0) : 0;
  if (ariaIds) counts["aria-label-id"] = ariaIds;
  return counts;
}

export function evaluateCopyRatchets(totals, rules = COPY_RATCHETS) {
  const failures = [];
  for (const rule of rules) {
    const count = totals[rule.id] ?? 0;
    if (count > rule.budget)
      failures.push(`${rule.id}: ${count} uses, budget ${rule.budget}. Remove the new ones: ${rule.help}.`);
    else if (count < rule.budget)
      failures.push(`${rule.id}: ${count} uses is below the budget of ${rule.budget}; lower the budget to ${count}.`);
  }
  return failures;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
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
  const totals = {};
  const byFile = {};
  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    findings.push(...findClassicHandoffCopy(file, contents));
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    for (const [id, count] of Object.entries(countCopyRatchets(relative, contents))) {
      totals[id] = (totals[id] ?? 0) + count;
      (byFile[id] ??= []).push(`${relative} (${count})`);
    }
  }
  const ratchetFailures = evaluateCopyRatchets(totals);
  if (ratchetFailures.length) {
    console.error("[cockpit-copy] operator language (see DESIGN.md › Copy and Glossary):");
    for (const failure of ratchetFailures) {
      console.error(`- ${failure}`);
      const id = failure.split(":")[0];
      if (process.env.COPY_VERBOSE && byFile[id]) console.error(`  ${byFile[id].join(", ")}`);
    }
    process.exitCode = 1;
  }
  if (findings.length) {
    console.error('[cockpit-copy] say "classic view" for handoffs, not "current …":');
    for (const item of findings) console.error(`- ${path.relative(repoRoot, item.file)}:${item.line} -> ${item.text}`);
    process.exitCode = 1;
    return;
  }
  if (!ratchetFailures.length)
    console.log(
      `[cockpit-copy] ${files.length} cockpit files name the classic view plainly (${JSON.stringify(totals)})`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
