import type { ToolGroupId } from "./tool-groups.js";

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
