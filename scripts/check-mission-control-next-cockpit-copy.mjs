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

/** Every tree that renders operator copy in the cockpit: its own areas, the native routes and shared components. */
export const COPY_ROOTS = [
  { id: "cockpit", dir: cockpitRoot },
  { id: "native-routes", dir: path.join(repoRoot, "apps", "mission-control-next", "src", "features", "native-routes") },
  { id: "shared-components", dir: path.join(repoRoot, "packages", "mission-control-shared", "src", "components") },
];

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
  {
    id: "glossary-terms",
    pattern: /\b(?:Gateway|evidence|owners?|replay(?:s|ed|ing)?|revisions?|snapshots?)\b/gi,
    budget: 0,
    help: 'write "GoatCitadel" or name the page; keep these words in TechnicalDetails',
  },
  {
    id: "plural-template",
    // A count, up to two words ("known workspace"), then a plural noun.
    pattern:
      /\$\{(?![^}]*\bplural\()(?![^}]*\?)[^}]*\b(?:count|length|total|size|known)\b[^}]*\}\s+(?:[a-z]+\s+){0,2}[a-z]+s\b|\w\(s\)/gi,
    budget: 0,
    help: "use plural() from mission-control-shared/content/format for every number-noun pair",
  },
];

/*
 * Budgets per root, overriding the rule budget. The cockpit's own areas are held at the rule budgets; the native
 * routes and shared components ratchet down as the copy sweep reaches them (cockpit follow-up plan, Task 4.3).
 */
export const ROOT_BUDGETS = {
  cockpit: { "glossary-terms": 0 },
  "native-routes": {
    "internal-terms": 275,
    "dead-end-pointer": 1,
    "aria-label-id": 10,
    "glossary-terms": 971,
    "plural-template": 37,
  },
  "shared-components": { "internal-terms": 21, "aria-label-id": 11, "glossary-terms": 45, "plural-template": 2 },
};
const ARIA_ID = /aria-label=\{`[^`]*\$\{[^}]*\b\w*(?:Id|ID)\b[^}]*\}[^`]*`\}/g;
const CODE_LINE =
  /^(?:import|export|const|let|var|return|if|else|for|while|function|type|interface|case|await|throw|switch|default|try|catch)\b/;

/*
 * TechnicalDetails children and class names never reach operator copy; blank them, keeping line breaks. The
 * TechnicalDetails tag itself stays, because its label is the visible disclosure summary.
 */
function stripHiddenText(contents) {
  return contents
    .replace(/(<TechnicalDetails\b[^>]*>)([\s\S]*?)(<\/TechnicalDetails>)/g, (_, open, body, close) => {
      return `${open}${body.replace(/[^\n]/g, "")}${close}`;
    })
    .replace(/className=(?:"[^"]*"|\{`[^`]*`\})/g, "");
}

/** JSX props whose value an operator reads. */
const COPY_PROP =
  /\b(?:label|title|placeholder|aria-label|description|heading|summary|hint|helper|emptyTitle|emptyMessage)=(["'])([^"']+)\1/g;

/** A line after `// copy-guard: not copy (…)` holds text an operator never reads, such as search keywords. */
const NOT_COPY_MARKER = /\/\/\s*copy-guard: not copy\b/;

/** The parts of a source file an operator can read. */
export function visibleText(contents) {
  const parts = [];
  let skipNext = false;
  for (const line of stripHiddenText(contents).split(/\r?\n/)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (NOT_COPY_MARKER.test(line)) {
      skipNext = true;
      continue;
    }
    if (isComment(line)) continue;
    // A "literal" that starts or ends with an operator, or holds JSX attribute syntax, is the code between two
    // literals, not copy.
    for (const match of line.matchAll(/(["'`])((?:(?!\1).)*\s(?:(?!\1).)*)\1/g))
      if (!/^\s*(?:&&|\|\||[=!]==?|\?\?|[?:+,)])|(?:&&|\|\||[=!]==?|\()\s*$|=\{|=>/.test(match[2]))
        parts.push(match[2]);
    for (const match of line.matchAll(/>([^<>{}=]*[A-Za-z][^<>{}=]*)</g)) parts.push(match[1]);
    // One-word values of copy-bearing props (label="Gateway") are read too; other one-word literals are code values.
    for (const match of line.matchAll(COPY_PROP)) if (!/\s/.test(match[2])) parts.push(match[2]);
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
    // A template's ${…} is code; only the plural rule reads it, to catch `${count} items`.
    const read = (part) => (rule.id === "plural-template" ? part : part.replace(/\$\{[^}]*\}/g, ""));
    const hits = text.reduce((sum, part) => sum + (read(part).match(rule.pattern)?.length ?? 0), 0);
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

/** A root that cannot be read fails the guard instead of passing with nothing checked. */
export async function walk(dir) {
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

async function scanRoot(root) {
  const files = await walk(root.dir);
  const findings = [];
  const totals = {};
  const byFile = {};
  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    if (root.id === "cockpit") findings.push(...findClassicHandoffCopy(file, contents));
    const relative = path.relative(root.dir, file).split(path.sep).join("/");
    for (const [id, count] of Object.entries(countCopyRatchets(relative, contents))) {
      totals[id] = (totals[id] ?? 0) + count;
      (byFile[id] ??= []).push(`${relative} (${count})`);
    }
  }
  const budgets = ROOT_BUDGETS[root.id] ?? {};
  const rules = COPY_RATCHETS.map((rule) => ({ ...rule, budget: budgets[rule.id] ?? rule.budget }));
  return { files, findings, totals, byFile, failures: evaluateCopyRatchets(totals, rules) };
}

async function main() {
  let fileCount = 0;
  const summary = {};
  for (const root of COPY_ROOTS) {
    const { files, findings, totals, byFile, failures } = await scanRoot(root);
    fileCount += files.length;
    summary[root.id] = totals;
    if (failures.length) {
      console.error(`[cockpit-copy] ${root.id}: operator language (see DESIGN.md › Copy and Glossary):`);
      for (const failure of failures) {
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
    }
  }
  if (!process.exitCode)
    console.log(`[cockpit-copy] ${fileCount} files follow the operator glossary (${JSON.stringify(summary)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
