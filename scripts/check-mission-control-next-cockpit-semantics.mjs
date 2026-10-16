#!/usr/bin/env node
/*
 * Cockpit semantics guard (UI audit 2026-10-14, workstream D). Keeps four fixed problems from coming back:
 * 1. Shared page primitives (EmptyState, Callout) are never live regions by default and never print
 *    "Problem:"-style prefixes.
 * 2. The number of live regions (role=status/alert, aria-live) in cockpit source only goes down. Static or polled
 *    content must not be announced; lower LIVE_REGION_BUDGET when the count drops.
 * 3. Layer-level stacking (z-40 and above) lives only in the files that own a layer, so menus and tooltips stay
 *    above dialogs (scale: z-40 scrims, z-50 dialogs, z-60 popovers, z-70 toasts and the skip link).
 * 4. A cockpit link that intercepts clicks must leave modified clicks (new tab, middle click) to the browser via
 *    isModifiedClick. Files that predate the rule are listed and may only leave the list.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

export const LIVE_REGION_BUDGET = 740;

const NON_LIVE_PRIMITIVES = ["ui/EmptyState.tsx", "ui/Callout.tsx"];
const BANNED_PREFIXES = /["'`>](Problem|Attention|Information|Error): /;

export const LAYER_OWNERS = new Set([
  "ui/Dialog.tsx",
  "ui/Sheet.tsx",
  "ui/Menu.tsx",
  "ui/MenuRuntime.tsx",
  "ui/Tooltip.tsx",
  "areas/chat/ChatModelOptionsPopover.tsx",
  "app/CockpitShell.tsx",
  "app/use-cockpit-shell-switch.tsx",
]);
const LAYER_CLASS = /(?:^|[\s"'`:])z-(40|50|60|70|[89]\d|\d{3,})(?=[\s"'`]|$)/;

// Files that intercepted link clicks before this guard existed. Remove entries as they adopt isModifiedClick.
export const MODIFIED_CLICK_BASELINE = new Set([
  "areas/library/CapabilitySettings.tsx",
  "areas/library/LibraryArea.tsx",
  "areas/settings/FirstRunVerification.tsx",
  "areas/settings/LocalAiSettings.tsx",
  "areas/settings/ProviderCatalogSettings.tsx",
  "areas/settings/SafetyCatalogSummary.tsx",
  "areas/settings/SettingsArea.tsx",
  "areas/settings/TrustPolicySettings.tsx",
  "areas/system/HealthLocalRuntimeActions.tsx",
  "areas/system/SystemArea.tsx",
  "areas/system/SystemDashboards.tsx",
  "areas/work/WorkRunDetail.tsx",
  "areas/work/WorkTaskDetail.tsx",
  "ui/ClassicOwnerLink.tsx",
]);

export function countLiveRegions(contents) {
  return (contents.match(/role="(?:status|alert)"|role=\{[^}]*["'](?:status|alert)["']|aria-live=/g) ?? []).length;
}

export function checkFile(relativePath, contents) {
  const findings = [];
  if (NON_LIVE_PRIMITIVES.includes(relativePath)) {
    if (relativePath === "ui/EmptyState.tsx" && /role=/.test(contents))
      findings.push(`${relativePath}: EmptyState must not be a live region`);
    if (BANNED_PREFIXES.test(contents)) findings.push(`${relativePath}: no "Problem:"-style prefixes`);
  }
  if (!LAYER_OWNERS.has(relativePath)) {
    contents.split(/\r?\n/).forEach((line, index) => {
      if (LAYER_CLASS.test(line)) findings.push(`${relativePath}:${index + 1}: layer z-index outside a layer owner`);
    });
  }
  if (!MODIFIED_CLICK_BASELINE.has(relativePath)) {
    for (const line of findUnguardedLinkHandlers(contents))
      findings.push(`${relativePath}:${line}: intercepts clicks on a link without isModifiedClick`);
  }
  return findings;
}

/** Returns the text between the brace at `open` and its matching close brace (string contents are skipped). */
function braceBody(source, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  return "";
}

function namedHandlerBody(source, name) {
  const declaration = new RegExp(`(?:const|let|function)\\s+${name}\\b[^{]*`).exec(source);
  return declaration ? braceBody(source, declaration.index + declaration[0].length) : "";
}

/**
 * Line numbers of onClick handlers on elements with an href that cancel the click without first leaving modified
 * clicks to the browser. Each handler is checked on its own, inline or named, so one guarded link cannot hide
 * another.
 */
export function findUnguardedLinkHandlers(contents) {
  const lines = [];
  for (const match of contents.matchAll(/onClick=\{/g)) {
    const expression = braceBody(contents, match.index + "onClick=".length);
    const tag = contents.slice(contents.lastIndexOf("<", match.index), match.index);
    if (
      !/\bhref=/.test(tag) &&
      !/\bhref=/.test(contents.slice(match.index, contents.indexOf(">", match.index + 9 + expression.length)))
    )
      continue;
    const named = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expression);
    const body = named ? namedHandlerBody(contents, named[1]) : expression;
    if (/preventDefault\(\)/.test(body) && !/isModifiedClick/.test(body))
      lines.push(contents.slice(0, match.index).split(/\r?\n/).length);
  }
  return lines;
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
  let liveRegions = 0;
  const stale = [];
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    const contents = await fs.readFile(file, "utf8");
    liveRegions += countLiveRegions(contents);
    findings.push(...checkFile(relative, contents));
    if (MODIFIED_CLICK_BASELINE.has(relative) && findUnguardedLinkHandlers(contents).length === 0) stale.push(relative);
  }
  if (liveRegions > LIVE_REGION_BUDGET)
    findings.push(
      `live regions grew to ${liveRegions} (budget ${LIVE_REGION_BUDGET}); announce outcomes, not static or polled text`,
    );
  // An exact ratchet: when the count drops, the same change lowers the budget so the slack cannot be reused.
  if (liveRegions < LIVE_REGION_BUDGET)
    findings.push(
      `live regions dropped to ${liveRegions}: lower LIVE_REGION_BUDGET from ${LIVE_REGION_BUDGET} to ${liveRegions}`,
    );
  for (const relative of stale)
    findings.push(`${relative} has no unguarded link handlers: remove it from MODIFIED_CLICK_BASELINE`);
  if (findings.length) {
    console.error("[cockpit-semantics] violations:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[cockpit-semantics] ${files.length} cockpit files pass; ${liveRegions} live regions`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
