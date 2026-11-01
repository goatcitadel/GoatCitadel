import {
  TOOL_GROUPS,
  type ChangePlanRisk,
  type GlobalToolAccessChange,
  type GlobalToolAccessPosture,
  type OperatorWriteRootChange,
  type ToolGroupChange,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { isSameOperatorWriteRootFolder } from "./settings-operator-write-access.js";

/**
 * Change Plan descriptions and owner-match checks for the runtime write-access
 * operations (operator write roots, curated fs tool posture and tool group
 * switches). The settings owner applies them; see `settings-operator-write-access.ts`.
 */

interface WriteAccessDescription {
  readonly title: string;
  readonly summary: string;
  readonly completedSummary: string;
  readonly impact: string;
  readonly risk: ChangePlanRisk;
}

const DENY_WINS_NOTE =
  "Deny-wins still applies: agent, permission-profile, and wildcard deny entries keep blocking the tool, and the protected runtime paths stay unwritable.";

export function describeOperatorWriteRootChange(change: OperatorWriteRootChange): WriteAccessDescription {
  const target = change.preset === "os_temp" ? "the OS temp folder" : (change.path ?? "the folder");
  if (change.action === "remove") {
    return {
      title: "Remove an operator write root",
      summary: `Remove ${target} from the operator write roots.`,
      completedSummary: `${target} is no longer an operator write root.`,
      impact:
        "Filesystem tools can no longer write inside this folder unless the workspace write jail covers it. Files already in it are left as they are.",
      risk: "caution",
    };
  }
  const allowDelete = change.allowDelete === true;
  return {
    title: allowDelete ? "Add an operator write root with delete" : "Add an operator write root",
    summary: `Add ${target} as an operator write root with delete ${allowDelete ? "allowed" : "off"}.`,
    completedSummary: `${target} is now an operator write root with delete ${allowDelete ? "allowed" : "off"}.`,
    impact: [
      "Filesystem tools that are not denied (fs.write, fs.patch, fs.copy, fs.move, fs.delete) become callable, with approval, inside this folder.",
      allowDelete
        ? "Delete-shaped operations (fs.delete and the source of fs.move) are allowed here too."
        : "Delete-shaped operations (fs.delete and the source of fs.move) stay blocked here.",
      "Workbench, worktrees, and memory exports are not affected.",
      DENY_WINS_NOTE,
    ].join(" "),
    risk: allowDelete ? "danger" : "caution",
  };
}

export function describeGlobalToolAccessChange(
  change: GlobalToolAccessChange,
  settings: RuntimeSettings,
): WriteAccessDescription {
  const { toolName, posture } = change;
  const current = currentPosture(toolName, settings);
  const removesDeny = current === "denied" && posture !== "denied";
  const highImpactTool = toolName === "fs.delete" || toolName === "fs.write";
  const risk: ChangePlanRisk =
    posture === "denied" ? "safe" : highImpactTool && (posture === "available" || removesDeny) ? "danger" : "caution";
  return {
    title: `Set ${toolName} to ${posture}`,
    summary: `Change the global posture of ${toolName} from ${current} to ${posture}.`,
    completedSummary: `${toolName} is now ${posture} in the global tool policy.`,
    impact: describePostureImpact(toolName, posture),
    risk,
  };
}

function describePostureImpact(toolName: string, posture: GlobalToolAccessPosture): string {
  switch (posture) {
    case "denied":
      return `${toolName} is denied for every agent and session; deny-wins means no permission profile or grant can re-enable it.`;
    case "available":
      return `Un-denying ${toolName} makes it callable, with approval, in every write root: the workspace write jail and each operator write root. ${DENY_WINS_NOTE}`;
    case "unlisted":
      return `${toolName} leaves the global allow and deny lists, so permission profiles and agent policy decide. Un-denying it makes it callable, with approval, in every write root where they allow it. ${DENY_WINS_NOTE}`;
  }
}

function currentPosture(toolName: string, settings: RuntimeSettings): GlobalToolAccessPosture {
  if (settings.globalToolAccess.deny.some((entry) => entry.trim() === toolName)) return "denied";
  if (settings.globalToolAccess.allow.some((entry) => entry.trim() === toolName)) return "available";
  return "unlisted";
}

/** Off is safe and on is caution: switching a group on can only widen what the AI may try, never lift another rule. */
export function describeToolGroupChange(change: ToolGroupChange): WriteAccessDescription {
  // Every entry is gated by isToolGroupChange, so the group is found; a raw id never reaches Inbox copy.
  const label = TOOL_GROUPS.find((group) => group.id === change.groupId)?.label ?? "selected";
  if (change.enabled) {
    return {
      title: `Switch the ${label} tools back on`,
      summary: `Let the AI use the ${label} tools again.`,
      completedSummary: `The ${label} tools are back on. Other safety rules still apply.`,
      impact:
        "Only this switch changes. Denied tools, permission profiles, Citadel Wards and approvals still apply to these tools.",
      risk: "caution",
    };
  }
  return {
    title: `Switch off the ${label} tools`,
    summary: `Stop the AI from using the ${label} tools in any chat.`,
    completedSummary: `The AI can't use the ${label} tools in any chat.`,
    impact:
      "The AI can't use these tools until you switch them back on. What GoatCitadel does for you, such as Library actions and channel replies, keeps working.",
    risk: "safe",
  };
}

export function matchesGlobalToolAccessChange(change: GlobalToolAccessChange, settings: RuntimeSettings): boolean {
  return currentPosture(change.toolName, settings) === change.posture;
}

/**
 * Whether the operator's own switch reads as the plan set it. A plugin's hold is never the operator's switch, so a group
 * a plugin holds off doesn't make an unwritten switch-off read as written (F8).
 */
export function matchesToolGroupChange(
  change: ToolGroupChange,
  settings: Pick<RuntimeSettings, "operatorSwitchedOffToolGroups">,
): boolean {
  return settings.operatorSwitchedOffToolGroups.includes(change.groupId) === !change.enabled;
}

export function matchesOperatorWriteRootChange(change: OperatorWriteRootChange, settings: RuntimeSettings): boolean {
  const root = settings.operatorWriteRoots.find((candidate) =>
    change.preset
      ? candidate.preset === change.preset
      : isSameOperatorWriteRootFolder(candidate.path, change.path ?? ""),
  );
  if (change.action === "remove") return root === undefined;
  return root !== undefined && root.allowDelete === (change.allowDelete ?? false);
}
