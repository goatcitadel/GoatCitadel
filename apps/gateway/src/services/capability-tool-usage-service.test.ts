import { describe, expect, it, vi } from "vitest";
import { ESSENTIAL_TOOL_GROUP_IDS, TOOL_GROUPS, TOOL_USAGE_WINDOW_DAYS } from "@goatcitadel/contracts";
import type { ChatToolCallCount } from "@goatcitadel/storage";
import { CapabilityToolUsageService, TOOL_USAGE_CACHE_MS } from "./capability-tool-usage-service.js";

const START = new Date("2026-10-27T12:00:00.000Z");
const DAY_MS = 86_400_000;

function counts(entries: Array<[string, number, string?]>): ChatToolCallCount[] {
  return entries.map(([toolName, calls, lastCalledAt]) => ({
    toolName,
    calls,
    lastCalledAt: lastCalledAt ?? "2026-10-20T00:00:00.000Z",
  }));
}

/** A service over a clock the test moves by hand. */
function build(read: (sinceIso: string) => Promise<readonly ChatToolCallCount[]>) {
  let current = START;
  const readCounts = vi.fn(read);
  const service = new CapabilityToolUsageService(readCounts, () => current);
  return {
    service,
    readCounts,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CapabilityToolUsageService", () => {
  it("sums each group's own tools and leaves connector tools out", async () => {
    const { service, readCounts } = build(async () =>
      counts([
        ["fs.read", 5, "2026-10-10T00:00:00.000Z"],
        ["fs.write", 2, "2026-10-12T00:00:00.000Z"],
        ["made_up.tool", 9],
        ["browser.search", 4],
        ["mcp.invoke", 3],
        ["mcp.github.create_issue", 7],
        ["mesh:node-a:tool:echo", 6],
      ]),
    );

    const response = await service.read({ refresh: false });

    expect(readCounts).toHaveBeenCalledWith(new Date(START.getTime() - TOOL_USAGE_WINDOW_DAYS * DAY_MS).toISOString());
    expect(response.since).toBe("2025-10-27T12:00:00.000Z");
    expect(response.generatedAt).toBe(START.toISOString());
    expect(response.groups.map((group) => group.groupId)).toEqual(TOOL_GROUPS.map((group) => group.id));
    expect(response.groups).toHaveLength(14);
    const byId = new Map(response.groups.map((group) => [group.groupId, group]));
    expect(byId.get("files")).toEqual({ groupId: "files", calls: 7, lastCalledAt: "2026-10-12T00:00:00.000Z" });
    expect(byId.get("web_search")).toEqual({
      groupId: "web_search",
      calls: 4,
      lastCalledAt: "2026-10-20T00:00:00.000Z",
    });
    // mcp.invoke belongs to Core; a connector's own tool and a mesh tool belong to no group.
    expect(byId.get("core")).toMatchObject({ calls: 3 });
    const grouped = response.groups.reduce((total, group) => total + group.calls, 0);
    expect(grouped).toBe(14);
    // A group with no calls reads 0 and has no last call time.
    expect(byId.get("git")).toEqual({ groupId: "git", calls: 0 });
    // Every tool is still listed with its own count, connector tools included.
    expect(response.tools.find((tool) => tool.toolName === "mcp.github.create_issue")?.calls).toBe(7);
  });

  it("picks the top 4 once 4 groups have calls, else the essentials", async () => {
    const few = build(async () =>
      counts([
        ["git.status", 50],
        ["fs.read", 3],
        ["mcp.invoke", 99],
      ]),
    );
    const fewResponse = await few.service.read({ refresh: false });
    // Only two switchable groups have calls, and Core never counts toward it.
    expect(fewResponse.mostUsed).toEqual({ kind: "essentials", groupIds: [...ESSENTIAL_TOOL_GROUP_IDS] });

    const many = build(async () =>
      counts([
        ["memory.read", 10],
        ["fs.read", 20],
        ["http.get", 30],
        ["browser.search", 20],
        ["shell.exec", 5],
        ["mcp.invoke", 500],
      ]),
    );
    const manyResponse = await many.service.read({ refresh: false });
    // http.get 30, then files and web_search tie at 20 and fall back to display order (files first), then memory.
    expect(manyResponse.mostUsed).toEqual({
      kind: "most_used",
      groupIds: ["web_requests", "files", "web_search", "memory"],
    });
  });

  it("serves the cached counts for 10 minutes and reads again on refresh", async () => {
    let calls = 1;
    const { service, readCounts, advance } = build(async () => counts([["fs.read", calls++]]));

    const first = await service.read({ refresh: false });
    advance(TOOL_USAGE_CACHE_MS - 1);
    const cached = await service.read({ refresh: false });
    expect(readCounts).toHaveBeenCalledTimes(1);
    expect(cached).toBe(first);
    // The cached answer keeps the time its counts were read.
    expect(cached.generatedAt).toBe(START.toISOString());

    advance(1);
    const expired = await service.read({ refresh: false });
    expect(readCounts).toHaveBeenCalledTimes(2);
    expect(expired.groups.find((group) => group.groupId === "files")?.calls).toBe(2);

    const refreshed = await service.read({ refresh: true });
    expect(readCounts).toHaveBeenCalledTimes(3);
    expect(refreshed.groups.find((group) => group.groupId === "files")?.calls).toBe(3);
    // The refresh replaced the cache.
    expect(await service.read({ refresh: false })).toBe(refreshed);
    expect(readCounts).toHaveBeenCalledTimes(3);
  });

  it("shares one read between concurrent requests", async () => {
    const gate = deferred<ChatToolCallCount[]>();
    const { service, readCounts } = build(() => gate.promise);

    const requests = [
      service.read({ refresh: false }),
      service.read({ refresh: false }),
      service.read({ refresh: false }),
    ];
    gate.resolve(counts([["fs.read", 1]]));
    const responses = await Promise.all(requests);

    expect(readCounts).toHaveBeenCalledTimes(1);
    expect(responses[1]).toBe(responses[0]);
    expect(responses[2]).toBe(responses[0]);
  });

  it("doesn't cache a failed read", async () => {
    const outcomes: Array<() => Promise<ChatToolCallCount[]>> = [
      async () => {
        throw new Error("database is locked");
      },
      async () => counts([["fs.read", 4]]),
    ];
    const { service, readCounts } = build(async () => (await outcomes.shift()!)());

    await expect(service.read({ refresh: false })).rejects.toThrow("database is locked");
    const recovered = await service.read({ refresh: false });

    expect(readCounts).toHaveBeenCalledTimes(2);
    expect(recovered.groups.find((group) => group.groupId === "files")?.calls).toBe(4);
  });

  it("lets a refresh start its own read, and an older read never replaces a newer cache", async () => {
    const older = deferred<ChatToolCallCount[]>();
    const newer = deferred<ChatToolCallCount[]>();
    const pending = [older, newer];
    const { service, readCounts } = build(() => pending.shift()!.promise);

    const first = service.read({ refresh: false });
    const refreshed = service.read({ refresh: true });
    expect(readCounts).toHaveBeenCalledTimes(2);
    newer.resolve(counts([["fs.read", 9]]));
    const newerResponse = await refreshed;
    older.resolve(counts([["fs.read", 1]]));
    await first;

    expect(await service.read({ refresh: false })).toBe(newerResponse);
    expect(readCounts).toHaveBeenCalledTimes(2);
  });
});
