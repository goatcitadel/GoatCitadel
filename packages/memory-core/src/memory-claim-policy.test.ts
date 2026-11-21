import { describe, expect, it } from "vitest";
import { type MemoryClaim } from "@goatcitadel/contracts";
import { classifyMemoryClaimChange } from "./memory-claim-policy.js";

const claim: MemoryClaim = {
  identity: {
    subject: "operator",
    predicate: "reply_length",
    scope: { kind: "workspace", id: "A" },
    cardinality: "scalar",
  },
  value: "concise",
};
const current = [{ sourceRef: "reply", sourceHash: "revision-one", workspaceId: "A", claim }];
const incoming = { workspaceId: "A", claim: { ...claim, value: "detailed" }, authority: "operator" };

describe("memory claim identity", () => {
  it("rejects empty evidence and a stale correction even when the desired value already matches", () => {
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, correctionTarget: { sourceRef: "reply", expectedSourceHash: "" } },
        current: [{ ...current[0]!, sourceHash: "" }],
      }),
    ).toBe("ambiguous");
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, claim, correctionTarget: { sourceRef: "reply", expectedSourceHash: "stale" } },
        current,
      }),
    ).toBe("ambiguous");
  });

  it("requires exact current target evidence and operator authority for a scalar correction", () => {
    expect(classifyMemoryClaimChange({ incoming, current })).toBe("ambiguous");
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, correctionTarget: { sourceRef: "reply", expectedSourceHash: "revision-one" } },
        current,
      }),
    ).toBe("correction");
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, correctionTarget: { sourceRef: "reply", expectedSourceHash: "stale" } },
        current,
      }),
    ).toBe("ambiguous");
    expect(
      classifyMemoryClaimChange({
        incoming: {
          ...incoming,
          authority: "agent_proposed",
          correctionTarget: { sourceRef: "reply", expectedSourceHash: "revision-one" },
        },
        current,
      }),
    ).toBe("ambiguous");
  });
  it("keeps unrelated properties/scopes independent and equal values duplicate", () => {
    expect(classifyMemoryClaimChange({ incoming: { ...incoming, claim }, current })).toBe("duplicate");
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, claim: { ...claim, identity: { ...claim.identity, predicate: "language" } } },
        current,
      }),
    ).toBe("independent");
    expect(classifyMemoryClaimChange({ incoming, current: [{ ...current[0]!, workspaceId: "B" }] })).toBe(
      "independent",
    );
    expect(classifyMemoryClaimChange({ incoming: { ...incoming, claim: undefined }, current })).toBe("independent");
  });
  it("never chooses a target from multiple matching scalar records", () => {
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, correctionTarget: { sourceRef: "reply", expectedSourceHash: "revision-one" } },
        current: [...current, { ...current[0]!, sourceRef: "second" }],
      }),
    ).toBe("ambiguous");
  });
  it("allows different set values without replacing previous interests", () => {
    const setClaim = { ...claim, identity: { ...claim.identity, cardinality: "set" as const } };
    expect(
      classifyMemoryClaimChange({
        incoming: { ...incoming, claim: { ...setClaim, value: "other" } },
        current: [{ ...current[0]!, claim: setClaim }],
      }),
    ).toBe("independent");
  });
});
