import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { upsertChatCapabilityProfileSystemInstruction } from "./chat-turn-prep-service.js";

describe("Work Passport turn instruction", () => {
  it("binds review and evidence requirements without claiming authority or completed review", () => {
    const profile = {
      profileId: "profile-work-passport",
      hashes: { profileHash: "a".repeat(64) },
      selection: {
        tools: [],
        trustedSkills: [],
        memory: { mode: "auto", retrievalMode: "standard" },
        workPassport: {
          boundary: "cross_domain",
          consequence: "high",
          actionPosture: "approval_before_external_action",
          review: { posture: "domain_expert_required" },
          evidenceRequirements: ["Cite current primary sources.", "Obtain accountable domain review."],
        },
      },
    } as unknown as ChatTurnCapabilityProfileRecord;

    const messages = upsertChatCapabilityProfileSystemInstruction(
      [{ role: "user", content: "Review this contract." }],
      profile,
    );
    const instruction = String(messages[0]?.content);

    expect(instruction).toContain("boundary=cross_domain");
    expect(instruction).toContain("review=domain_expert_required");
    expect(instruction).toContain("Cite current primary sources");
    expect(instruction).toContain("not an assessment of the operator");
    expect(instruction).toContain("do not represent review as completed unless evidence shows it");
  });
});
