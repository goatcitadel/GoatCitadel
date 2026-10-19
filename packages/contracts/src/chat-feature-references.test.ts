import { describe, expect, it } from "vitest";
import { readChatTurnFeatureReferences } from "./chat-feature-references.js";

describe("Chat feature reference decoding", () => {
  const base = {
    version: "chat.turn.feature-references.v1",
    providerRoute: {
      primary: { providerId: "local", model: "test" },
      fingerprint: "a".repeat(64),
    },
  };
  it("keeps explicit consent and rejects client authority or raw content", () => {
    expect(readChatTurnFeatureReferences(base)).toEqual(base);
    for (const patch of [{ grant: true }, { sourceContent: "private content" }, { version: "future" }]) {
      expect(() => readChatTurnFeatureReferences({ ...base, ...patch })).toThrow();
    }
    expect(() =>
      readChatTurnFeatureReferences({
        ...base,
        providerRoute: {
          ...base.providerRoute,
          fallback: { providerId: "cloud", model: "test" },
        },
      }),
    ).toThrow();
  });
  it("rejects selected skill receipts without an exact trusted tree", () => {
    expect(() =>
      readChatTurnFeatureReferences({
        ...base,
        selectedSkills: {
          selectionMode: "ranked",
          instructionBudgetTokens: 4096,
          trustedSkills: [],
          activatedSkills: [
            {
              capabilityId: "skill:test",
              skillId: "test",
              confidence: 0.6,
              reasons: ["metadata_ranked"],
              treeSha256: "a".repeat(64),
              instructionSha256: "b".repeat(64),
              instructionBytes: 100,
              modules: [],
            },
          ],
        },
      }),
    ).toThrow(/exact trusted/u);
  });
  it("records an operator model council request and rejects any other council shape", () => {
    const modelCouncil = { version: "chat.model-council.admission.v1" };
    expect(readChatTurnFeatureReferences({ ...base, modelCouncil }).modelCouncil).toEqual(modelCouncil);
    expect(() =>
      readChatTurnFeatureReferences({ ...base, modelCouncil: { ...modelCouncil, participants: ["cloud"] } }),
    ).toThrow();
  });
});
