import type { ToolGroupId } from "./tool-groups.js";
import type { ToolRiskLevel } from "./tools.js";

// ---------------------------------------------------------------------------
// Tool call counts: GET /api/v1/capabilities/tools/usage
// ---------------------------------------------------------------------------

/** How far back the call counts reach. */
export const TOOL_USAGE_WINDOW_DAYS = 365;

/** One tool's calls from chats in the window. A call is an executed or failed run, not a blocked or waiting one. */
export interface CapabilityToolUsageEntry {
  toolName: string;
  calls: number;
  lastCalledAt: string;
}

/** The calls of one group's own tools. Connector tools belong to their connector and are in no group. */
export interface CapabilityToolGroupUsage {
  groupId: ToolGroupId;
  calls: number;
  /** Absent when the group has no calls. */
  lastCalledAt?: string;
}

export interface CapabilityToolUsageResponse {
  /** The start of the window: now minus `TOOL_USAGE_WINDOW_DAYS`, ISO. */
  since: string;
  /** When the counts were read. A cached answer keeps the time of the read that filled the cache. */
  generatedAt: string;
  tools: CapabilityToolUsageEntry[];
  /** Every group, in display order; 0 calls when none. */
  groups: CapabilityToolGroupUsage[];
  /**
   * The groups to put first. `most_used` is the 4 switchable groups with the most calls, once 4 or more have any;
   * `essentials` is the fixed starter set before that. Core is never in it.
   */
  mostUsed: { kind: "most_used" | "essentials"; groupIds: ToolGroupId[] };
}

// ---------------------------------------------------------------------------
// Tool groups: GET /api/v1/capabilities/tools?workspaceId=<id>
// ---------------------------------------------------------------------------

/** Whether the AI can use a group. `always_on` is Core, which can't be switched off. */
export type CapabilityToolGroupState = "on" | "off" | "always_on";

/**
 * The rule that blocks a tool even though its group is on. `install_profile` is this install's deployment profile,
 * which keeps some tools (browser cookies and storage) off unless the install is a trusted local one.
 */
export type CapabilityToolBlock = "safety_rules" | "permission_profile" | "citadel_ward" | "grant" | "install_profile";

/**
 * Whether the AI asks before using a tool. `unknown` covers a tool that is only switched off, a tool that is blocked,
 * and one whose rules couldn't be checked; it is never a guess.
 */
export type CapabilityToolAsks = "asks_first" | "runs_freely" | "unknown";

export interface CapabilityToolItem {
  toolName: string;
  description: string;
  risk: ToolRiskLevel;
  asks: CapabilityToolAsks;
  /**
   * Set only when one of the rules above blocks the tool. A group's own switch is its `state`, never a block, so a
   * tool that is only switched off has none. In a switched-off group only `safety_rules` and `install_profile` can
   * show: the engine answers the switch before the permission profile, Ward and grant checks, so those read
   * `unknown` until the group is switched on.
   */
  blockedBy?: CapabilityToolBlock;
}

export interface CapabilityToolGroupItem {
  groupId: ToolGroupId;
  label: string;
  description: string;
  state: CapabilityToolGroupState;
  /** The riskiest tool's risk. A group with no tools offered on this install reads as safe. */
  risk: ToolRiskLevel;
  /** The tools this install offers, in registry order. */
  tools: CapabilityToolItem[];
  blockedToolCount: number;
  /**
   * The plugins that hold this group off, in the order the Gateway lists its holds. A held group reads `off` whatever
   * the operator's own switch says, and only uninstalling each plugin releases its hold. Absent when no plugin holds it.
   */
  heldOffBy?: { pluginId: string; name: string }[];
}

export interface CapabilityToolsResponse {
  workspaceId: string;
  /** Every group, in display order. */
  groups: CapabilityToolGroupItem[];
  /** The Settings revision the switches were read at. */
  settingsRevision: number;
  /** Plain-language notes about parts of the list that couldn't be read. */
  issues: string[];
  generatedAt: string;
}
