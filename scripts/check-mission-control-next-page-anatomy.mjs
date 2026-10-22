#!/usr/bin/env node
/*
 * Page-anatomy guard (UI audit 2026-10-14, workstream E; DESIGN.md › Page anatomy). Exact ratchets over cockpit source
 * (tests excluded): a count above its budget fails, and a count below it asks for the budget to be lowered in the same
 * change.
 * - raw-h1: pages title themselves through ui/AreaHeader.tsx (title row, then the area's one tab row). Chat keeps its
 *   conversation header and is excluded.
 * - bare-rounded: `rounded` alone falls outside the 6/8/12 radius tokens; use rounded-sm, rounded-md or rounded-lg (6, 8 or 12px).
 * - eyebrow: an uppercase, letter-spaced label above a heading is on DESIGN.md's refuse list.
 * - card-surface: bordered card containers (a class string with rounded-lg or rounded-xl and a border); the page is the
 *   only card, and sub-sections are hairline-separated regions (ui/Section.tsx).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

export const ANATOMY_RULES = [
  {
    id: "raw-h1",
    budget: 0,
    help: "title the page with ui/AreaHeader",
    count: (relative, contents) =>
      relative.startsWith("areas/") && !relative.startsWith("areas/chat/") && relative.endsWith(".tsx")
        ? (contents.match(/<h1[\s>]/g)?.length ?? 0)
        : 0,
  },
  {
    id: "bare-rounded",
    budget: 0,
    help: "use rounded-sm, rounded-md or rounded-lg (6, 8 or 12px)",
    count: (_relative, contents) => contents.match(/(?<=["'`\s])rounded(?=["'`\s])/g)?.length ?? 0,
  },
  {
    id: "eyebrow",
    budget: 0,
    help: "drop the uppercase eyebrow and let the heading carry its own weight",
    count: (_relative, contents) =>
      contents.match(/["'`][^"'`\n]*\buppercase\b[^"'`\n]*\btracking-[a-z]+[^"'`\n]*["'`]/g)?.length ?? 0,
  },
  {
    id: "card-surface",
    budget: 11,
    help: "make the page the only card; use ui/Section for sub-sections",
    // Card containers: a large radius with a border. Controls (inputs, buttons, chips) use rounded-md and stay out.
    count: (_relative, contents) =>
      contents.match(/["'`][^"'`\n]*\brounded-(?:lg|xl)\b[^"'`\n]*\bborder\b[^"'`\n]*["'`]/g)?.length ?? 0,
  },
  {
    id: "padded-panel",
    budget: 56,
    help: "list rows are hairline-separated (divide-y divide-line-subtle); a bordered padded box is a nested card",
    // A container element in a page area whose class has rounded-md, a full border and padding. Form controls and
    // buttons also use rounded-md border, so only container tags count; rounded-lg/xl is the card-surface rule.
    count: (relative, contents) =>
      relative.startsWith("areas/")
        ? [
            ...contents.matchAll(
              /<(?:div|section|article|aside|li|ul|ol|dl|details|fieldset|figure|form|p|label)\b[^>]*?className=(?:"([^"]*)"|\{`([^`]*)`\})/gs,
            ),
          ].filter((match) => {
            const classes = ` ${match[1] ?? match[2] ?? ""} `;
            return /\srounded-md\s/.test(classes) && /\sborder\s/.test(classes) && /\sp[xy]?-\d/.test(classes);
          }).length
        : 0,
  },
  {
    id: "small-textarea",
    budget: 0,
    help: "text boxes use 16px text (text-md) on phones so iOS does not zoom; use sm:text-sm for denser desktop text",
    // A textarea whose class sets text-xs/text-sm as the base size (no sm: prefix) is under 16px on a phone.
    count: (_relative, contents) =>
      [...contents.matchAll(/<textarea\b[^>]*?className=(?:"([^"]*)"|\{`([^`]*)`\})/gs)].filter((match) =>
        /(?:^|\s)text-(?:xs|sm)(?=\s|$)/.test(match[1] ?? match[2] ?? ""),
      ).length,
  },
  {
    id: "settings-raw-control",
    // Workstream G moved the provider, MCP, hooks, budget, approval, permission, tool and appearance forms onto Field;
    // the rest (mostly Citadel editors, plus the per-tool access selects in FilesystemToolAccessPanel) ratchet down
    // from here.
    budget: 83,
    help: "wrap Settings inputs in ui/Field so the label, help, required marker and error stay tied to the control",
    // A text-like control in Settings that does not spread Field's render props ({...props}, {...fieldProps}, {...field}).
    // Checkboxes, radios, hidden and file inputs carry their own label pattern and stay out.
    count: (relative, contents) =>
      relative.startsWith("areas/settings/") && relative.endsWith(".tsx")
        ? [...contents.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gs)].filter(
            (match) =>
              !/\{\.\.\.(?:field|\w*[pP]rops)\b/.test(match[1]) && !/type=["'](?:checkbox|radio|hidden|file)["']/.test(match[1]),
          ).length
        : 0,
  },
  {
    id: "model-setup-css",
    budget: 0,
    help: "the guided model setup is built from cockpit primitives; do not bring back the Classic override sheet",
    count: (_relative, contents) => contents.match(/model-setup\.css/g)?.length ?? 0,
  },
];

/** Phone chrome at the bottom edge must clear the home indicator (viewport-fit=cover). */
export const SAFE_AREA_REQUIRED = ["app/MobileTabBar.tsx"];

export function checkSafeArea(relativePath, contents) {
  return SAFE_AREA_REQUIRED.includes(relativePath) && !/\bcockpit-safe-bottom\b/.test(contents)
    ? [`${relativePath}: bottom-edge phone chrome must use cockpit-safe-bottom`]
    : [];
}

export function countAnatomy(relativePath, contents, rules = ANATOMY_RULES) {
  const counts = {};
  for (const rule of rules) {
    const hits = rule.count(relativePath, contents);
    if (hits) counts[rule.id] = hits;
  }
  return counts;
}

export function evaluateAnatomy(totals, rules = ANATOMY_RULES) {
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
  const totals = {};
  const byFile = {};
  const safeArea = [];
  const seen = new Set();
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    const contents = await fs.readFile(file, "utf8");
    seen.add(relative);
    safeArea.push(...checkSafeArea(relative, contents));
    for (const [id, count] of Object.entries(countAnatomy(relative, contents))) {
      totals[id] = (totals[id] ?? 0) + count;
      (byFile[id] ??= []).push(`${relative} (${count})`);
    }
  }
  for (const required of SAFE_AREA_REQUIRED)
    if (!seen.has(required)) safeArea.push(`${required}: required phone chrome file is missing`);
  const failures = [...evaluateAnatomy(totals), ...safeArea];
  if (failures.length) {
    console.error("[page-anatomy] violations (see DESIGN.md › Page anatomy):");
    for (const failure of failures) {
      console.error(`- ${failure}`);
      const id = failure.split(":")[0];
      if (process.env.ANATOMY_VERBOSE && byFile[id]) console.error(`  ${byFile[id].join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[page-anatomy] ${files.length} cockpit files within budget (${JSON.stringify(totals)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
