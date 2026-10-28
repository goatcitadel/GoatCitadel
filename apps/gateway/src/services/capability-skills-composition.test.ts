import { describe, expect, it, vi } from "vitest";
import type { SkillUseCount } from "@goatcitadel/storage";
import { composeCapabilitySkills } from "./capability-skills-composition.js";

describe("composeCapabilitySkills", () => {
  it("reads the use counts from the chat turn capability profiles", async () => {
    const countSkillUsesSince = vi.fn(
      async (): Promise<SkillUseCount[]> => [{ skillId: "research", uses: 2, lastUsedAt: "2026-10-20T00:00:00.000Z" }],
    );

    const { usage } = composeCapabilitySkills({ chatTurnCapabilityProfiles: { countSkillUsesSince } });
    const response = await usage.read({ refresh: false });

    expect(countSkillUsesSince).toHaveBeenCalledTimes(1);
    expect(countSkillUsesSince).toHaveBeenCalledWith(response.since);
    expect(response.skills).toEqual([{ skillId: "research", uses: 2, lastUsedAt: "2026-10-20T00:00:00.000Z" }]);
  });

  it("turns a failure in the profile history into a failed read, never an empty list", async () => {
    // The history query throws on a profile it can't parse; the Gateway's storage hands that back as a rejection.
    const countSkillUsesSince = vi.fn(async (): Promise<SkillUseCount[]> => {
      throw new Error("malformed JSON");
    });

    const { usage } = composeCapabilitySkills({ chatTurnCapabilityProfiles: { countSkillUsesSince } });

    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
    expect(countSkillUsesSince).toHaveBeenCalledTimes(2);
  });

  it("also fails the read when the history throws before it returns a promise", async () => {
    const countSkillUsesSince = vi.fn((): Promise<SkillUseCount[]> => {
      throw new Error("malformed JSON");
    });

    const { usage } = composeCapabilitySkills({ chatTurnCapabilityProfiles: { countSkillUsesSince } });

    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
  });
});
