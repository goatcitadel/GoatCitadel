import { describe, expect, it, vi } from "vitest";
import { composeCapabilityToolUsage } from "./capability-tools-composition.js";

describe("composeCapabilityToolUsage", () => {
  it("reads the call counts from the chat tool run history", async () => {
    const countCallsByToolSince = vi.fn(async () => [
      { toolName: "fs.read", calls: 2, lastCalledAt: "2026-10-20T00:00:00.000Z" },
    ]);

    const response = await composeCapabilityToolUsage({ chatToolRuns: { countCallsByToolSince } }).read({
      refresh: false,
    });

    expect(countCallsByToolSince).toHaveBeenCalledTimes(1);
    expect(countCallsByToolSince).toHaveBeenCalledWith(response.since);
    expect(response.tools).toEqual([{ toolName: "fs.read", calls: 2, lastCalledAt: "2026-10-20T00:00:00.000Z" }]);
    expect(response.groups.find((group) => group.groupId === "files")?.calls).toBe(2);
  });
});
