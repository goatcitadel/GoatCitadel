import {
  CURATED_FS_MUTATION_TOOLS,
  type ChangePlanRecord,
  type ChangePlanRisk,
  type CuratedFsMutationTool,
  type GlobalToolAccessChange,
  type GlobalToolAccessPosture,
  type GlobalToolAccessSummary,
  type OperatorWriteRootChange,
  type OperatorWriteRootSummary,
} from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";

/**
 * Pure helpers for the cockpit filesystem write-access control. The Gateway
 * settings owner validates, canonicalizes and applies every change; these only
 * read its settings projection and mirror its confirmation checks.
 */

export type ToolAccessDraft = Readonly<Record<CuratedFsMutationTool, GlobalToolAccessPosture>>;

export interface AddRootDraft {
  readonly path: string;
  readonly allowDelete: boolean;
}

export const EMPTY_ADD_ROOT_DRAFT: AddRootDraft = { path: "", allowDelete: false };

/** One governed settings save: an operator write-root change or one curated tool's global access. */
export type WriteAccessSubmission =
  | {
      readonly kind: "root";
      readonly change: OperatorWriteRootChange;
      /** Root paths before the save, so an added root is recognized after the server canonicalizes it. */
      readonly before: readonly string[];
      readonly draft?: AddRootDraft;
    }
  | {
      readonly kind: "tool";
      readonly change: GlobalToolAccessChange;
      readonly draft: ToolAccessDraft;
      readonly saved: ToolAccessDraft;
    };

export const TOOL_ACCESS_LABELS: Readonly<Record<GlobalToolAccessPosture, string>> = {
  denied: "Denied",
  available: "Available",
  unlisted: "Not listed",
};

export const TOOL_ACCESS_ORDER: readonly GlobalToolAccessPosture[] = ["denied", "available", "unlisted"];

export const TOOL_DESCRIPTIONS: Readonly<Record<CuratedFsMutationTool, string>> = {
  "fs.write": "Create or overwrite files",
  "fs.delete": "Delete files and folders",
  "fs.copy": "Copy files and folders",
  "fs.move": "Move or rename files and folders",
  "fs.patch": "Edit part of an existing file",
};

export const DENY_WINS_COPY =
  "Deny-wins and approvals still apply: agent, permission-profile and wildcard deny rules keep blocking a tool, risky calls still ask for approval, and GoatCitadel's own runtime files stay unwritable.";

export function operatorWriteRoots(settings: RuntimeSettingsResponse | undefined): readonly OperatorWriteRootSummary[] {
  return settings?.operatorWriteRoots ?? [];
}

export function isWriteAccessProjection(settings: RuntimeSettingsResponse | undefined): boolean {
  const access = settings?.globalToolAccess;
  return Boolean(
    settings &&
    Number.isSafeInteger(settings.revision) &&
    settings.revision > 0 &&
    Array.isArray(settings.writeJailRoots) &&
    Array.isArray(settings.readOnlyRoots) &&
    Array.isArray(settings.operatorWriteRoots) &&
    access &&
    Array.isArray(access.allow) &&
    Array.isArray(access.deny),
  );
}

/** Mirrors the settings owner: an exact deny entry wins, then an exact allow entry; wildcards are left alone. */
export function toolAccess(tool: CuratedFsMutationTool, access: GlobalToolAccessSummary | undefined) {
  if (access?.deny.some((entry) => entry.trim() === tool)) return "denied";
  if (access?.allow.some((entry) => entry.trim() === tool)) return "available";
  return "unlisted";
}

export function toolAccessDraft(access: GlobalToolAccessSummary | undefined): ToolAccessDraft {
  return Object.fromEntries(CURATED_FS_MUTATION_TOOLS.map((tool) => [tool, toolAccess(tool, access)])) as Record<
    CuratedFsMutationTool,
    GlobalToolAccessPosture
  >;
}

/** Wildcard deny entries that the curated controls cannot change (for example "fs.*"). */
export function wildcardDenyEntries(access: GlobalToolAccessSummary | undefined): string[] {
  return (access?.deny ?? []).filter((entry) => entry.includes("*"));
}

/** The client-side review gate; the Gateway assigns the authoritative risk to the change. */
export function toolAccessRisk(
  tool: CuratedFsMutationTool,
  current: GlobalToolAccessPosture,
  next: GlobalToolAccessPosture,
): ChangePlanRisk {
  if (next === "denied") return "safe";
  const highImpact = tool === "fs.delete" || tool === "fs.write";
  return highImpact && (next === "available" || current === "denied") ? "danger" : "caution";
}

export function toolAccessConsequence(tool: CuratedFsMutationTool, next: GlobalToolAccessPosture): string {
  switch (next) {
    case "denied":
      return `${tool} is denied for every agent and session. No permission profile or grant can turn it back on.`;
    case "available":
      return tool === "fs.delete"
        ? "Making fs.delete available lets Chat delete, with approval, in every write root: the workspace write folders and each operator write root that has Allow delete on."
        : `Chat can call ${tool}, with approval, in every write root: the workspace write folders and each operator write root.`;
    case "unlisted":
      return `${tool} leaves the global allow and deny lists, so permission profiles and agent policy decide. Where they allow it, Chat can call it, with approval, in every write root.`;
  }
}

export function writeAccessOperation(submission: WriteAccessSubmission) {
  return submission.kind === "tool" ? "tool_global_access" : "operator_write_root";
}

export function matchesWriteAccessPlan(plan: ChangePlanRecord, submission: WriteAccessSubmission): boolean {
  return (
    plan.kind === "runtime_configuration" &&
    plan.request.kind === "runtime_configuration" &&
    plan.request.change.operation === writeAccessOperation(submission) &&
    plan.target.ownerId === "runtime_settings"
  );
}

/** True when the saved settings show the submitted change; never inferred from the request alone. */
export function writeAccessSaved(settings: RuntimeSettingsResponse, submission: WriteAccessSubmission): boolean {
  if (submission.kind === "tool") {
    return toolAccess(submission.change.toolName, settings.globalToolAccess) === submission.change.posture;
  }
  const roots = operatorWriteRoots(settings);
  const { change } = submission;
  if (change.action === "remove") {
    return change.preset
      ? !roots.some((root) => root.preset === change.preset)
      : !roots.some((root) => root.path === change.path);
  }
  return roots.some(
    (root) =>
      !submission.before.includes(root.path) &&
      root.allowDelete === (change.allowDelete ?? false) &&
      (!change.preset || root.preset === change.preset),
  );
}

/** A remove names a preset root by its preset and any other root by its saved path. */
export function removeRootChange(root: OperatorWriteRootSummary): OperatorWriteRootChange {
  return root.preset ? { action: "remove", preset: root.preset } : { action: "remove", path: root.path };
}

export function readdRootChange(root: OperatorWriteRootSummary, allowDelete: boolean): OperatorWriteRootChange {
  return {
    action: "add",
    ...(root.preset ? { preset: root.preset } : { path: root.path }),
    allowDelete,
    ...(root.label ? { label: root.label } : {}),
  };
}

export function rootName(root: OperatorWriteRootSummary): string {
  if (root.label) return root.label;
  return root.preset === "os_temp" ? "OS temp folder" : root.path;
}
