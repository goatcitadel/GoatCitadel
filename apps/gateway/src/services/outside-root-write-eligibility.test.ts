import { describe, expect, it } from "vitest";
import { isOutsideRootWriteEligible, type OutsideRootWriteEligibilityDeps } from "./outside-root-write-eligibility.js";

function depsWith(parentSessionIds: string[] | Error): OutsideRootWriteEligibilityDeps {
  return {
    storage: {
      chatDelegationSteps: {
        listParentsByChildSessionIds: async (ids: string[]) => {
          if (parentSessionIds instanceof Error) throw parentSessionIds;
          return new Map(ids.filter((id) => parentSessionIds.includes(id)).map((id) => [id, { stepId: `step-${id}` }]));
        },
      },
    } as unknown as OutsideRootWriteEligibilityDeps["storage"],
  };
}

describe("isOutsideRootWriteEligible", () => {
  it("allows ordinary sessions", async () => {
    await expect(isOutsideRootWriteEligible({ sessionId: "session-1" }, depsWith([]))).resolves.toBe(true);
  });

  it("refuses delegated child sessions", async () => {
    await expect(isOutsideRootWriteEligible({ sessionId: "child-1" }, depsWith(["child-1"]))).resolves.toBe(false);
  });

  it("refuses A2A peers and mesh nodes", async () => {
    for (const authActorSource of ["a2a_peer", "mesh_node"] as const) {
      await expect(
        isOutsideRootWriteEligible({ sessionId: "session-1", policyContext: { authActorSource } }, depsWith([])),
      ).resolves.toBe(false);
    }
  });

  it("fails closed for blank session ids and lookup failures", async () => {
    await expect(isOutsideRootWriteEligible({ sessionId: "  " }, depsWith([]))).resolves.toBe(false);
    await expect(isOutsideRootWriteEligible({ sessionId: "session-1" }, depsWith(new Error("db down")))).resolves.toBe(
      false,
    );
  });
});
