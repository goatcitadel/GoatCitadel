import { describe, expect, it } from "vitest";
import {
  SESSION_MUTATION_SOURCE_CLASSIFICATIONS,
  SESSION_MUTATION_SOURCE_INVENTORY,
  classifySessionMutationSource,
  isSessionMutationSourceClassified,
} from "./session-mutation-classification.js";

describe("session mutation classification", () => {
  it("keeps the frozen eight-value vocabulary unique", () => {
    expect(new Set(SESSION_MUTATION_SOURCE_CLASSIFICATIONS).size).toBe(8);
    expect(SESSION_MUTATION_SOURCE_CLASSIFICATIONS).toEqual([
      "synchronous_authority_mutation",
      "long_lived_turn_mutation",
      "external_effect_dispatch",
      "authority_bearing_callback_result",
      "allowed_actual_attempt_evidence",
      "operator_approval_exemption",
      "advisory_read_only",
      "forbidden_unclassified",
    ]);
  });

  it("fails closed for unknown or blank source ids", () => {
    expect(classifySessionMutationSource("chat.unknown.callback")).toBe("forbidden_unclassified");
    expect(classifySessionMutationSource("   ")).toBe("forbidden_unclassified");
    expect(isSessionMutationSourceClassified("chat.unknown.callback")).toBe(false);
  });

  it("classifies every inventoried source without the forbidden fallback", () => {
    for (const record of SESSION_MUTATION_SOURCE_INVENTORY) {
      expect(classifySessionMutationSource(record.sourceId)).toBe(record.classification);
      expect(isSessionMutationSourceClassified(record.sourceId)).toBe(true);
    }
  });
});
