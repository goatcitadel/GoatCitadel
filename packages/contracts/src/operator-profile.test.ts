import { describe, expect, it } from "vitest";
import {
  MAX_OPERATOR_PROFILE_FACTS,
  MAX_OPERATOR_PROFILE_FACT_LENGTH,
  MAX_OPERATOR_PROFILE_SUMMARY_LENGTH,
  type OperatorProfileFact,
  type OperatorProfileFactKind,
  type OperatorProfileRecord,
} from "./operator-profile.js";

describe("OperatorProfileFact", () => {
  it("models the four standing fact kinds with confidence and optional provenance", () => {
    const kinds: OperatorProfileFactKind[] = ["preference", "goal", "constraint", "fact"];
    const facts: OperatorProfileFact[] = kinds.map((kind, index) => ({
      kind,
      content: `${kind} ${index}`,
      confidence: 0.8,
      sourceRef: index === 0 ? "item-1" : undefined,
    }));
    expect(facts).toHaveLength(4);
    expect(facts[0]?.sourceRef).toBe("item-1");
    expect(facts[1]?.sourceRef).toBeUndefined();
  });
});

describe("OperatorProfileRecord", () => {
  it("carries a revision used as the digest cache key", () => {
    const record: OperatorProfileRecord = {
      operatorProfileId: "op_1",
      workspaceId: "default",
      summary: "Founder/operator who prefers terse, source-grounded answers.",
      facts: [{ kind: "preference", content: "Prefers metric units.", confidence: 0.9 }],
      revision: 3,
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:05:00.000Z",
    };
    expect(record.revision).toBe(3);
    expect(record.facts[0]?.kind).toBe("preference");
  });
});

describe("operator profile bounds", () => {
  it("exposes defensive caps for facts and lengths", () => {
    expect(MAX_OPERATOR_PROFILE_FACTS).toBeGreaterThan(0);
    expect(MAX_OPERATOR_PROFILE_SUMMARY_LENGTH).toBeGreaterThan(0);
    expect(MAX_OPERATOR_PROFILE_FACT_LENGTH).toBeGreaterThan(0);
  });
});
