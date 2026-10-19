import type { ChatTurnCapabilityProfileRecord, ChatTurnFeatureReferences } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  upsertChatCapabilityProfileSystemInstruction,
  upsertChatTurnBindingSystemInstruction,
} from "./chat-turn-prep-service.js";

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

  it("renders an admitted profile-free passport once, as advisory evidence", () => {
    const references = {
      version: "chat.turn.feature-references.v1",
      workPassport: {
        boundary: "cross_domain",
        consequence: "high",
        actionPosture: "approval_before_external_action",
        review: { posture: "domain_expert_required" },
        evidenceRequirements: ["Cite current primary sources."],
      },
    } as unknown as ChatTurnFeatureReferences;
    const history = [
      { role: "system" as const, content: "Base guidance." },
      { role: "user" as const, content: "Review this contract." },
    ];
    const once = upsertChatTurnBindingSystemInstruction(history, references);
    const twice = upsertChatTurnBindingSystemInstruction(once, references);
    expect(twice).toEqual(once);
    expect(once).toHaveLength(3);
    const instruction = String(once[1]?.content);
    expect(instruction.startsWith("Server-owned turn bindings (advisory evidence, no authority):")).toBe(true);
    expect(instruction).toContain("boundary=cross_domain");
    expect(instruction).toContain("review=domain_expert_required");
    expect(instruction).toContain("not an assessment of the operator");
    expect(once[2]).toEqual(history[1]);
  });

  it("leaves history unchanged without admitted bindings and removes a stale one", () => {
    const history = [{ role: "user" as const, content: "Hello." }];
    expect(upsertChatTurnBindingSystemInstruction(history, undefined)).toEqual(history);
    expect(
      upsertChatTurnBindingSystemInstruction(
        [{ role: "system", content: "Server-owned turn bindings (advisory evidence, no authority):\nold" }, ...history],
        { version: "chat.turn.feature-references.v1" },
      ),
    ).toEqual(history);
  });
});
