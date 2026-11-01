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
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

/**
 * Every tree that renders operator copy in the cockpit: its own areas, the native routes and shared components. A root
 * with `files` reads just those files (relative to `dir`): copy written outside the cockpit that the cockpit shows as
 * written, such as the hook trigger labels, the plugin checks' lines, the plugin source refusals, the plugin install
 * and uninstall refusals, and a plugin uninstall's plan and summaries (its adapter, scope and words). A plugin
 * fetch's Git words sit in `plugin-git-messages.ts`, apart from `hardened-git.ts` and `hardened-git-wording.ts`, which
 * hold the skill import's.
 */
export const COPY_ROOTS = [
  { id: "cockpit", dir: cockpitRoot },
  { id: "native-routes", dir: path.join(repoRoot, "apps", "mission-control-next", "src", "features", "native-routes") },
  { id: "shared-components", dir: path.join(repoRoot, "packages", "mission-control-shared", "src", "components") },
  {
    id: "shown-as-written",
    dir: repoRoot,
    files: [
      "packages/contracts/src/hooks.ts",
      "apps/gateway/src/routes/capability-plugins.ts",
      "apps/gateway/src/services/capability-plugin-actions-service.ts",
      "apps/gateway/src/services/capability-plugin-inspection-service.ts",
      "apps/gateway/src/services/capability-plugin-detail.ts",
      "apps/gateway/src/services/capability-plugins-route-service.ts",
      "apps/gateway/src/services/plugin-owned-refusal.ts",
      "apps/gateway/src/services/plugin-uninstall-change-plan-adapter.ts",
      "apps/gateway/src/services/plugin-uninstall-scope.ts",
      "apps/gateway/src/services/plugin-uninstall-words.ts",
      "apps/gateway/src/services/plugin-source-service.ts",
      "apps/gateway/src/services/plugin-snapshot-store.ts",
      "apps/gateway/src/services/plugin-git-messages.ts",
      "apps/gateway/src/services/skill-hub-plugin-skill-source.ts",
    ],
  },
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
 * text an operator can see (see visibleText). Each budget is exact: above it fails, below it asks for a lower budget
 * in the same change.
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
    "internal-terms": 297,
    "dead-end-pointer": 1,
    "aria-label-id": 10,
    "glossary-terms": 1079,
    "plural-template": 39,
  },
  "shared-components": { "internal-terms": 23, "aria-label-id": 11, "glossary-terms": 55, "plural-template": 5 },
};
const ARIA_ID = /aria-label=\{`[^`]*\$\{[^}]*\b\w*(?:Id|ID)\b[^}]*\}[^`]*`\}/g;
/** JSX props and object keys whose value an operator reads, even when it is one word. */
const COPY_PROPS = new Set([
  "label",
  "title",
  "placeholder",
  "aria-label",
  "description",
  "heading",
  "summary",
  "hint",
  "helper",
  "emptyTitle",
  "emptyMessage",
]);
/** JSX props whose value is code: class names, styles, ids, links and SVG geometry. */
const CODE_PROPS =
  /^(?:className|class|style|key|id|htmlFor|href|src|d|viewBox|points|transform|data-[\w-]+|aria-(?:controls|describedby|labelledby|owns))$/;
const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InKeyword,
]);

/** A line after `// copy-guard: not copy (…)` holds text an operator never reads, such as search keywords. */
const NOT_COPY_MARKER = /\/\/\s*copy-guard: not copy\b/;

/** Zero-based numbers of the lines that follow a not-copy marker. */
function notCopyLines(contents) {
  const lines = new Set();
  contents.split(/\r?\n/).forEach((line, index) => {
    if (NOT_COPY_MARKER.test(line)) lines.add(index + 1);
  });
  return lines;
}

function isLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

/** The literals an expression can evaluate to or join: `"A"`, `ok ? "A" : "B"`, `name ?? "A"`, `ok && "A"`, `"A" + b`. */
function resultLiterals(node) {
  if (!node) return [];
  if (isLiteral(node)) return [node];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isJsxExpression(node))
    return resultLiterals(node.expression);
  if (ts.isConditionalExpression(node)) return [...resultLiterals(node.whenTrue), ...resultLiterals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return resultLiterals(node.right);
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    )
      return [...resultLiterals(node.left), ...resultLiterals(node.right)];
  }
  return [];
}

/** A literal that is compared against, used as a key or case label, or names a module or type is code, not copy. */
function isCodeLiteral(node) {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) return COMPARISON.has(parent.operatorToken.kind);
  if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === node;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name === node;
  return (
    ts.isCaseClause(parent) ||
    ts.isLiteralTypeNode(parent) ||
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent)
  );
}

/*
 * A template's text with each `${…}` kept as source. A `${…}` that evaluates to literals (`${ok ? "a" : `${n} b`}`)
 * is elided, since those literals are read on their own; one that only uses a literal in code keeps its count.
 */
function templateText(node, source) {
  const spans = node.templateSpans.map((span) => {
    const expression = resultLiterals(span.expression).length ? "…" : span.expression.getText(source);
    return `\${${expression}}${span.literal.text}`;
  });
  return node.head.text + spans.join("");
}

function propName(name, source) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(source);
}

/*
 * The parts of a source file an operator can read: JSX text, literals rendered as JSX children or passed to a
 * copy-bearing prop (even one word), and other string or template literals with a space in them. Comments,
 * TechnicalDetails children, class names and other code props, and literals in code positions are skipped; the
 * TechnicalDetails label stays, because it is the visible disclosure summary. A template keeps its `${…}` source so
 * the plural rule can read it.
 */
export function visibleText(contents, fileName = "source.tsx") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, true, kind);
  const skippedLines = notCopyLines(contents);
  const rendered = new Set();
  const parts = [];
  const add = (node, text) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    if (!skippedLines.has(line) && /[A-Za-z]/.test(text)) parts.push(text);
  };
  const markRendered = (node) => resultLiterals(node).forEach((literal) => rendered.add(literal));

  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "TechnicalDetails") {
      visit(node.openingElement);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = propName(node.name, source);
      if (CODE_PROPS.test(name)) return;
      if (COPY_PROPS.has(name)) markRendered(node.initializer);
    } else if (ts.isPropertyAssignment(node) && COPY_PROPS.has(propName(node.name, source))) {
      markRendered(node.initializer);
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      markRendered(node.expression);
    } else if (ts.isJsxText(node)) {
      add(node, node.text.replace(/\s+/g, " ").trim());
    } else if (isLiteral(node) && !isCodeLiteral(node)) {
      const text = ts.isTemplateExpression(node) ? templateText(node, source) : node.text;
      if (rendered.has(node) || /\s/.test(text)) {
        add(node, text);
        // The literals a copy template interpolates are copy too, even one word.
        if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => markRendered(span.expression));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return parts;
}

export function countCopyRatchets(relativePath, contents) {
  const counts = {};
  const text = visibleText(contents, relativePath);
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
  // A listed file that is missing fails the read below, as an unreadable root does.
  const files = root.files ? root.files.map((file) => path.join(root.dir, ...file.split("/"))) : await walk(root.dir);
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
      for (const item of findings)
        console.error(`- ${path.relative(repoRoot, item.file)}:${item.line} -> ${item.text}`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode)
    console.log(`[cockpit-copy] ${fileCount} files follow the operator glossary (${JSON.stringify(summary)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
