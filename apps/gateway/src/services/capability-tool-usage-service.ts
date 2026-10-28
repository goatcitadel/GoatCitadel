import {
  ESSENTIAL_TOOL_GROUP_IDS,
  SWITCHABLE_TOOL_GROUP_IDS,
  TOOL_GROUPS,
  TOOL_USAGE_WINDOW_DAYS,
  toolGroupForTool,
  type CapabilityToolGroupUsage,
  type CapabilityToolUsageResponse,
  type ToolGroupId,
} from "@goatcitadel/contracts";
import type { ChatToolCallCount } from "@goatcitadel/storage";

/** How long a read of the counts is served again. The read scans every finished tool run in the window. */
export const TOOL_USAGE_CACHE_MS = 600_000;

const DAY_MS = 86_400_000;
/** How many groups "Most used" shows once enough groups have been used. */
const MOST_USED_GROUP_COUNT = 4;

interface Read {
  /** Set once the read starts; the read itself may finish before the caller stores it. */
  promise?: Promise<CapabilityToolUsageResponse>;
}

/**
 * Tool call counts for the Capabilities Tools tab: how often each tool, and each group's own tools, ran from chats in
 * the last year. The counts come from one storage query that is cached, so opening the tab never rescans the history.
 */
export class CapabilityToolUsageService {
  private cached: { response: CapabilityToolUsageResponse; readAtMs: number } | undefined;
  /** The newest read that has not settled. Only the newest read may fill the cache or clear this. */
  private latest: Read | undefined;

  public constructor(
    private readonly readCounts: (sinceIso: string) => Promise<readonly ChatToolCallCount[]>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Concurrent reads share one query. `refresh` skips the cache and reads afresh; a failed read is never cached.
   * A read that fails rejects with the real error, and the caller decides what to show.
   */
  public async read(options: { refresh: boolean }): Promise<CapabilityToolUsageResponse> {
    if (!options.refresh) {
      if (this.cached && this.now().getTime() - this.cached.readAtMs < TOOL_USAGE_CACHE_MS) {
        return this.cached.response;
      }
      if (this.latest?.promise) {
        return this.latest.promise;
      }
    }
    return this.startRead();
  }

  private startRead(): Promise<CapabilityToolUsageResponse> {
    const read: Read = {};
    this.latest = read;
    read.promise = this.load(read);
    return read.promise;
  }

  private async load(read: Read): Promise<CapabilityToolUsageResponse> {
    const readAt = this.now();
    try {
      const since = new Date(readAt.getTime() - TOOL_USAGE_WINDOW_DAYS * DAY_MS).toISOString();
      const response = buildUsageResponse(await this.readCounts(since), since, readAt.toISOString());
      if (this.latest === read) {
        this.cached = { response, readAtMs: readAt.getTime() };
      }
      return response;
    } finally {
      if (this.latest === read) {
        this.latest = undefined;
      }
    }
  }
}

function buildUsageResponse(
  counts: readonly ChatToolCallCount[],
  since: string,
  generatedAt: string,
): CapabilityToolUsageResponse {
  const tools = counts
    .filter((count) => count.toolName.length > 0 && Number.isSafeInteger(count.calls) && count.calls > 0)
    .map((count) => ({ toolName: count.toolName, calls: count.calls, lastCalledAt: count.lastCalledAt }))
    .sort((left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName));

  const totals = new Map<ToolGroupId, { calls: number; lastCalledAt?: string }>();
  for (const tool of tools) {
    // Connector tools (mcp.<server>.<tool>) and mesh tools match no group, so they add to none.
    const groupId = toolGroupForTool(tool.toolName)?.id;
    if (!groupId) continue;
    const total = totals.get(groupId) ?? { calls: 0 };
    totals.set(groupId, {
      calls: total.calls + tool.calls,
      lastCalledAt:
        total.lastCalledAt === undefined || tool.lastCalledAt > total.lastCalledAt
          ? tool.lastCalledAt
          : total.lastCalledAt,
    });
  }

  const groups: CapabilityToolGroupUsage[] = TOOL_GROUPS.map((group) => {
    const total = totals.get(group.id);
    return total?.lastCalledAt === undefined
      ? { groupId: group.id, calls: 0 }
      : { groupId: group.id, calls: total.calls, lastCalledAt: total.lastCalledAt };
  });

  return { since, generatedAt, tools, groups, mostUsed: pickMostUsed(groups) };
}

/** The 4 switchable groups with the most calls once 4 or more have any; the starter set before that. Core is never in it. */
function pickMostUsed(groups: readonly CapabilityToolGroupUsage[]): CapabilityToolUsageResponse["mostUsed"] {
  const used = groups
    .filter((group) => group.calls > 0 && SWITCHABLE_TOOL_GROUP_IDS.includes(group.groupId))
    // Array.prototype.sort is stable, so a tie keeps the TOOL_GROUPS order the groups arrive in.
    .sort((left, right) => right.calls - left.calls);
  return used.length >= MOST_USED_GROUP_COUNT
    ? { kind: "most_used", groupIds: used.slice(0, MOST_USED_GROUP_COUNT).map((group) => group.groupId) }
    : { kind: "essentials", groupIds: [...ESSENTIAL_TOOL_GROUP_IDS] };
}
