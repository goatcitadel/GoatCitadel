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

// 892: Web & Search settings (#464) added five outcome and error callouts (allowlist, connection check, key actions,
// key status load), which announce.
// 893: the Capabilities Connectors tab announces the one outcome that replaces its whole page, a first read that failed.
// 894: a connector panel announces why its switch or Remove did not happen (one alert, shared by both).
// 895: a connector panel announces why a change to what asks first did not happen.
// 896: Channel setup page status line (SetupSteps).
// 897: a connector install's status line (InstallStatus), one per panel, which reads out each step the install or a
// saved server's sign-in and connect reaches.
// 898: the Capabilities Tools tab announces the one outcome that replaces its whole page, a first read that failed.
// 899: a tool group's switch announces the note under it (what on and off mean, or that the change waits in Inbox).
// 900: a tool group's switch announces why a change did not happen. A group shown twice announces in one place only.
// 901: the Capabilities Skills tab announces the one outcome that replaces its whole page, a first read that failed.
// 902: a skill row announces that its change is waiting for approval, once, when the change was asked for there.
// 903: a skill row announces why a change did not happen. A skill shown twice announces in one place only.
// 904: a skill panel's switch announces the note under it (what on and paused mean, or that the change waits).
// 905: a skill panel's switch announces why a change did not happen, under the same one-place rule.
// 906: the Skills tab's Discover view announces the one outcome that replaces its list, a read or search that failed.
// 907: Library's skill-packs panel went (-1, its notice callout); a skill's install panel announces its progress line
// and why a check or step stopped (+2). The Git address field's refusal uses Field's own alert.
// 900: the add-on screens went (-7): AddonsSettings had six live regions and AddonEvidence one. Capability packs stay.
// 898: the plugin setup guidance went (-2): its unsupported-version note and its copy-sample status line.
// 904: Chat's Code Mode request row announces its one status line (Running code…, then the outcome), why a read it
// needs failed (the request, Code Mode readiness), why a click was not sent, and why Keep as a tool did not save (+5);
// its loading lines are not announced. A code_mode.run approval in Chat says why Approve waits, as Inbox does (+1).
export const LIVE_REGION_BUDGET = 904;

const NON_LIVE_PRIMITIVES = ["ui/EmptyState.tsx", "ui/Callout.tsx"];
const BANNED_PREFIXES = /["'`>](Problem|Attention|Information|Error): /;

export const LAYER_OWNERS = new Set([
  "ui/Dialog.tsx",
  "ui/Sheet.tsx",
  "ui/Menu.tsx",
  "ui/MenuRuntime.tsx",
  "ui/Popover.tsx",
  "ui/Tooltip.tsx",
  "areas/chat/ChatModelOptionsPopover.tsx",
  "app/CockpitShell.tsx",
  "app/use-cockpit-shell-switch.tsx",
]);
const LAYER_CLASS = /(?:^|[\s"'`:])z-(40|50|60|70|[89]\d|\d{3,})(?=[\s"'`]|$)/;

// Files that intercepted link clicks before this guard existed. Remove entries as they adopt isModifiedClick.
export const MODIFIED_CLICK_BASELINE = new Set([
  "areas/library/CapabilitySettings.tsx",
  "areas/settings/FirstRunVerification.tsx",
  "areas/settings/LocalAiSettings.tsx",
  "areas/settings/ProviderCatalogSettings.tsx",
  "areas/settings/SafetyCatalogSummary.tsx",
  "areas/settings/SettingsArea.tsx",
  "areas/settings/TrustPolicySettings.tsx",
  "areas/system/HealthLocalRuntimeActions.tsx",
  "areas/system/SystemDashboards.tsx",
  "areas/work/WorkRunDetail.tsx",
  "areas/work/WorkTaskDetail.tsx",
  "ui/ClassicOwnerLink.tsx",
]);

/** Live regions, including a Callout left announcing (it is role=status/alert unless announce={false}). */
export function countLiveRegions(contents) {
  const explicit = (contents.match(/role="(?:status|alert)"|role=\{[^}]*["'](?:status|alert)["']|aria-live=/g) ?? [])
    .length;
  const callouts = [...contents.matchAll(/<Callout\b([^>]*)>/g)].filter(
    (match) => !/\bannounce=\{false\}/.test(match[1]),
  ).length;
  return explicit + callouts;
}

/*
 * Exact ratchets (a count above the budget fails, below it asks for a lower budget):
 * - label-in-name: an aria-label that doesn't start with the element's literal visible text, or with the text of the
 *   <label> wrapping the control (WCAG 2.5.3; DESIGN: accessible names start with the visible text).
 * - aria-label-no-role: aria-label on a div, span or p with no role; screen readers ignore it.
 * - phone-input-size: a text input without cockpitInputClass whose base text is under 16px, so iOS zooms on focus.
 */
export const SEMANTIC_RATCHETS = {
  "label-in-name": { budget: 0, help: "start the aria-label with the visible text, or drop it" },
  "aria-label-no-role": { budget: 0, help: "give the element a role (group, region…) or drop the aria-label" },
  "phone-input-size": { budget: 0, help: "use cockpitInputClass, or text-md with sm:text-sm" },
};

const starts = (label, text) => label.trim().toLowerCase().startsWith(text.trim().toLowerCase());

export function countSemanticRatchets(relativePath, contents) {
  if (!relativePath.endsWith(".tsx")) return {};
  const counts = {};
  const add = (id, hits) => {
    if (hits) counts[id] = (counts[id] ?? 0) + hits;
  };
  // A control (button, link, summary, or the shared Button) with an aria-label and literal text as its first child.
  add(
    "label-in-name",
    [
      ...contents.matchAll(
        // (?:=>|[^>]) lets an arrow handler (`onClick={() => …}`) sit inside the tag without ending it.
        /<(?:button|a|summary|Button|NativeOwnerLink)\b(?:=>|[^>])*?\baria-label="([^"]+)"(?:=>|[^>])*>\s*([^<{}\s][^<{}]*)/g,
      ),
    ].filter((match) => !starts(match[1], match[2])).length,
  );
  // A control inside a <label> whose literal text comes first.
  add(
    "label-in-name",
    [
      ...contents.matchAll(
        /<label\b[^>]*>\s*([^<{}\s][^<{}]*?)\s*<(?:select|input|textarea)\b[^>]*?\baria-label="([^"]+)"/g,
      ),
    ].filter((match) => !starts(match[2], match[1])).length,
  );
  add(
    "aria-label-no-role",
    contents.match(/<(?:div|span|p)\b(?!(?:=>|[^>])*\brole=)(?:=>|[^>])*\baria-label=/g)?.length ?? 0,
  );
  add(
    "phone-input-size",
    // iOS zooms any focused text field under 16px: inputs, selects and text areas.
    [...contents.matchAll(/<(?:input|select|textarea)\b((?:=>|[^>])*)>/g)].filter((match) => {
      const attributes = match[1];
      if (/type=["'](?:checkbox|radio|hidden|file|range|color)["']/.test(attributes)) return false;
      if (/cockpitInputClass/.test(attributes)) return false;
      const classes = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(attributes);
      return Boolean(classes && /(?:^|\s)text-(?:xs|sm)(?=\s|$)/.test(classes[1] ?? classes[2] ?? ""));
    }).length,
  );
  return counts;
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
  const ratchets = {};
  const ratchetFiles = {};
  for (const file of files) {
    const relative = path.relative(cockpitRoot, file).split(path.sep).join("/");
    const contents = await fs.readFile(file, "utf8");
    liveRegions += countLiveRegions(contents);
    findings.push(...checkFile(relative, contents));
    if (MODIFIED_CLICK_BASELINE.has(relative) && findUnguardedLinkHandlers(contents).length === 0) stale.push(relative);
    for (const [id, count] of Object.entries(countSemanticRatchets(relative, contents))) {
      ratchets[id] = (ratchets[id] ?? 0) + count;
      (ratchetFiles[id] ??= []).push(`${relative} (${count})`);
    }
  }
  for (const [id, rule] of Object.entries(SEMANTIC_RATCHETS)) {
    const count = ratchets[id] ?? 0;
    if (count > rule.budget)
      findings.push(`${id}: ${count} uses, budget ${rule.budget}; ${rule.help}: ${ratchetFiles[id].join(", ")}`);
    else if (count < rule.budget) findings.push(`${id}: ${count} uses is below the budget of ${rule.budget}; lower it`);
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
