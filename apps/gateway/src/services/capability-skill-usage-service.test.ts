import { describe, expect, it, vi } from "vitest";
import { SKILL_USAGE_WINDOW_DAYS } from "@goatcitadel/contracts";
import type { SkillUseCount } from "@goatcitadel/storage";
import { USAGE_CACHE_MS } from "./capability-usage-cache.js";
import { CapabilitySkillUsageService } from "./capability-skill-usage-service.js";

const START = new Date("2026-10-28T12:00:00.000Z");
const DAY_MS = 86_400_000;

function uses(entries: Array<[string, number, string?]>): SkillUseCount[] {
  return entries.map(([skillId, count, lastUsedAt]) => ({
    skillId,
    uses: count,
    lastUsedAt: lastUsedAt ?? "2026-10-20T00:00:00.000Z",
  }));
}

/** A service over a clock the test moves by hand. */
function build(read: (sinceIso: string) => Promise<readonly SkillUseCount[]>) {
  let current = START;
  const readUses = vi.fn(read);
  const service = new CapabilitySkillUsageService(readUses, () => current);
  return {
    service,
    readUses,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

describe("CapabilitySkillUsageService", () => {
  it("reads the last 365 days and stamps the window and the read time", async () => {
    const { service, readUses } = build(async () => uses([["research", 4, "2026-10-12T00:00:00.000Z"]]));

    const response = await service.read({ refresh: false });

    expect(SKILL_USAGE_WINDOW_DAYS).toBe(365);
    expect(readUses).toHaveBeenCalledWith(new Date(START.getTime() - SKILL_USAGE_WINDOW_DAYS * DAY_MS).toISOString());
    expect(response.since).toBe("2025-10-28T12:00:00.000Z");
    expect(response.generatedAt).toBe(START.toISOString());
    expect(response.skills).toEqual([{ skillId: "research", uses: 4, lastUsedAt: "2026-10-12T00:00:00.000Z" }]);
  });

  it("orders the skills by skill id itself, whatever order the read returns them in", async () => {
    const { service } = build(async () =>
      uses([
        ["zeta", 1],
        ["alpha", 2],
        ["Beta", 3],
        ["Alpha", 4],
        ["beta", 5],
      ]),
    );

    const response = await service.read({ refresh: false });

    // A plain comparison, not the locale's: capitals sort before lower case, on every machine.
    expect(response.skills.map((skill) => skill.skillId)).toEqual(["Alpha", "Beta", "alpha", "beta", "zeta"]);
  });

  it("answers an empty list, not an error, when no skill was used", async () => {
    const { service } = build(async () => []);

    const response = await service.read({ refresh: false });

    expect(response.skills).toEqual([]);
  });

  it("leaves out an entry with no skill id or no uses", async () => {
    const { service } = build(async () =>
      uses([
        ["research", 2],
        ["", 5],
        ["unused", 0],
        ["negative", -1],
        ["fractional", 1.5],
        ["huge", Number.MAX_SAFE_INTEGER + 2],
      ]),
    );

    const response = await service.read({ refresh: false });

    expect(response.skills.map((skill) => skill.skillId)).toEqual(["research"]);
  });

  it("doesn't change what the read returned", async () => {
    const original = uses([
      ["zeta", 1],
      ["alpha", 2],
    ]);
    const snapshot = structuredClone(original);
    const { service } = build(async () => original);

    await service.read({ refresh: false });

    expect(original).toEqual(snapshot);
  });

  it("serves the cached answer for 10 minutes and reads again on refresh", async () => {
    let reads = 1;
    const { service, readUses, advance } = build(async () => uses([["research", reads++]]));

    const first = await service.read({ refresh: false });
    advance(USAGE_CACHE_MS - 1);
    const cached = await service.read({ refresh: false });
    expect(readUses).toHaveBeenCalledTimes(1);
    expect(cached).toBe(first);
    // The cached answer keeps the time its counts were read.
    expect(cached.generatedAt).toBe(START.toISOString());

    advance(1);
    const expired = await service.read({ refresh: false });
    expect(readUses).toHaveBeenCalledTimes(2);
    expect(expired.skills[0]?.uses).toBe(2);
    expect(expired.generatedAt).toBe(new Date(START.getTime() + USAGE_CACHE_MS).toISOString());

    const refreshed = await service.read({ refresh: true });
    expect(readUses).toHaveBeenCalledTimes(3);
    expect(refreshed.skills[0]?.uses).toBe(3);
    expect(await service.read({ refresh: false })).toBe(refreshed);
    expect(readUses).toHaveBeenCalledTimes(3);
  });

  it("shares one read between concurrent requests", async () => {
    let release!: (value: SkillUseCount[]) => void;
    const gate = new Promise<SkillUseCount[]>((resolve) => {
      release = resolve;
    });
    const { service, readUses } = build(() => gate);

    const requests = [service.read({ refresh: false }), service.read({ refresh: false })];
    release(uses([["research", 1]]));
    const [first, second] = await Promise.all(requests);

    expect(readUses).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("doesn't cache a failed read, and fails with the real error rather than an empty list", async () => {
    const outcomes: Array<() => Promise<SkillUseCount[]>> = [
      async () => {
        throw new Error("Capability profile profile-9 is not valid JSON.");
      },
      async () => uses([["research", 4]]),
    ];
    const { service, readUses } = build(async () => (await outcomes.shift()!)());

    await expect(service.read({ refresh: false })).rejects.toThrow("not valid JSON");
    const recovered = await service.read({ refresh: false });

    expect(readUses).toHaveBeenCalledTimes(2);
    expect(recovered.skills).toEqual([{ skillId: "research", uses: 4, lastUsedAt: "2026-10-20T00:00:00.000Z" }]);
  });
});
