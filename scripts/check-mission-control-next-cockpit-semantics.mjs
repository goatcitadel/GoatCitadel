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

export const LIVE_REGION_BUDGET = 742;

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
  "areas/chat/ChatInspectorBody.tsx",
  "areas/library/CapabilitySettings.tsx",
  "areas/library/LibraryArea.tsx",
  "areas/settings/FirstRunVerification.tsx",
  "areas/settings/LocalAiSettings.tsx",
  "areas/settings/ProviderCatalogSettings.tsx",
  "areas/settings/SafetyCatalogSummary.tsx",
  "areas/settings/SettingsArea.tsx",
  "areas/settings/TrustPolicySettings.tsx",
  "areas/system/CockpitBoardEditor.tsx",
  "areas/system/HealthLocalRuntimeActions.tsx",
  "areas/system/SystemArea.tsx",
  "areas/system/SystemDashboards.tsx",
  "areas/work/WorkRunDetail.tsx",
  "areas/work/WorkTaskCreate.tsx",
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
  const interceptsLinks = /href=/.test(contents) && /preventDefault\(\)/.test(contents);
  if (interceptsLinks && !/isModifiedClick/.test(contents) && !MODIFIED_CLICK_BASELINE.has(relativePath))
    findings.push(`${relativePath}: intercepts clicks on a link without isModifiedClick`);
  return findings;
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
  let liveRegions = 0;
  const stale = [];
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    const contents = await fs.readFile(file, "utf8");
    liveRegions += countLiveRegions(contents);
    findings.push(...checkFile(relative, contents));
    if (MODIFIED_CLICK_BASELINE.has(relative) && /isModifiedClick/.test(contents)) stale.push(relative);
  }
  if (liveRegions > LIVE_REGION_BUDGET)
    findings.push(`live regions grew to ${liveRegions} (budget ${LIVE_REGION_BUDGET}); announce outcomes, not static or polled text`);
  for (const relative of stale) findings.push(`${relative} now uses isModifiedClick: remove it from MODIFIED_CLICK_BASELINE`);
  if (findings.length) {
    console.error("[cockpit-semantics] violations:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  const note = liveRegions < LIVE_REGION_BUDGET ? ` (lower LIVE_REGION_BUDGET to ${liveRegions})` : "";
  console.log(`[cockpit-semantics] ${files.length} cockpit files pass; ${liveRegions} live regions${note}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
