import {
  ConflictError,
  NotFoundError,
  PolicyViolationError,
  TOOL_GROUPS,
  redactSecretText,
  type CapabilityPluginInspection,
  type ChangePlanOrigin,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { StoredPlugin } from "./capability-plugin-store.js";

// What the plugin plans (install and uninstall) and the Capabilities plugin actions share: the checks an install is
// bound by, the origin rule both plans keep, and the plain-copy helpers their summaries use. One copy, so the refusal
// before a plan is made and the same check when the plan applies can't drift apart.

export const PLUGIN_CHANGED_MESSAGE = "This plugin changed since it was checked. Check it again.";
export const PLUGIN_INSPECTION_GONE_MESSAGE =
  "That plugin check wasn't found, or it ran out of time. Check the plugin again.";
export const OTHER_WORKSPACE_MESSAGE = "This plugin was checked for another workspace. Check it again here.";
const NOT_INSTALLABLE_MESSAGE = "This plugin has pieces that can't be installed. Check it again once they're fixed.";
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 180;

/** A kept inspection, with the snapshot it read. */
export interface KeptPluginInspection {
  readonly inspection: CapabilityPluginInspection;
  readonly snapshotTreeSha256: string;
}

/**
 * The kept inspection an install goes on from: kept and current (else 404), checked for this workspace, installable
 * and with a manifest (else 409).
 */
export function requireInstallableInspection(
  kept: KeptPluginInspection | undefined,
  workspaceId: string,
): KeptPluginInspection {
  if (!kept) throw new NotFoundError(PLUGIN_INSPECTION_GONE_MESSAGE);
  const { inspection } = kept;
  if (inspection.workspaceId !== workspaceId) throw new ConflictError({ message: OTHER_WORKSPACE_MESSAGE });
  if (!inspection.installable || !inspection.manifestSha256) {
    throw new ConflictError({ message: NOT_INSTALLABLE_MESSAGE });
  }
  return kept;
}

/** 409 `ALREADY_EXISTS` for a plugin that has a record: it is installed, or its install or removal is under way. */
export function pluginAlreadyInstalled(installed: Pick<StoredPlugin, "pluginId" | "name">): ConflictError {
  return new ConflictError({
    code: "ALREADY_EXISTS",
    message: `${installed.name} is already installed.`,
    details: { pluginId: installed.pluginId },
  });
}

/** 409: the plugin's check, manifest or bytes aren't the ones the install was made from. */
export function pluginChanged(): ConflictError {
  return new ConflictError({ message: PLUGIN_CHANGED_MESSAGE });
}

/** Sentences joined, kept within a plan summary's bound: past it, the rest are counted, not listed. */
export function boundedSentences(sentences: readonly string[]): string {
  const kept: string[] = [];
  for (const [index, sentence] of sentences.entries()) {
    const rest = sentences.length - index;
    const tail = ` And ${rest} more ${rest === 1 ? "step" : "steps"}.`;
    if ([...kept, sentence].join(" ").length + tail.length > MAX_SUMMARY_LENGTH) {
      return `${kept.join(" ")}${tail}`;
    }
    kept.push(sentence);
  }
  return kept.join(" ");
}

/** A title within a plan title's bound. */
export function boundedTitle(title: string): string {
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Only the operator's own Capabilities route makes a plugin plan; Chat, a model or the generic API can't. A refusal
 * names the plan's kind in its code, such as `plugin_install_untrusted_origin`.
 */
export function requireCapabilitiesOrigin(
  origin: ChangePlanOrigin,
  refusal: { message: string; diagnosticCode: string },
): void {
  if (origin.surface !== "capabilities" || origin.sessionId || origin.turnId) {
    throw new PolicyViolationError({
      message: refusal.message,
      details: { diagnosticCode: refusal.diagnosticCode },
    });
  }
}

/** The plugin a plan's target names (`plugin:<id>`), so nothing depends on an inspection still being kept. */
export function planPluginId(plan: Pick<ChangePlanRecord, "target">): string {
  return plan.target.resourceId.startsWith("plugin:") ? plan.target.resourceId.slice("plugin:".length) : "";
}

/** A tool group's own label, or its id when GoatCitadel has no group by that id. */
export function groupLabel(groupId: string): string {
  return TOOL_GROUPS.find((group) => group.id === groupId)?.label ?? groupId;
}

/** The host a hook's address sends to. */
export function hookHost(url: string): string {
  return new URL(url).hostname;
}

/** An owner's error message on one line, redacted and bounded, or nothing when it carries none. */
export function failureDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.replace(/[\s\p{Cc}]+/gu, " ").trim() : "";
  const detail = redactSecretText(message).value.slice(0, 300).trim();
  return detail || undefined;
}
