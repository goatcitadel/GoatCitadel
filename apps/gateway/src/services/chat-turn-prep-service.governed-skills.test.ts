import { describe, expect, it } from "vitest";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";
import { buildChatCompactionDimension, upsertChatActivatedSkillSystemInstruction } from "./chat-turn-prep-service.js";

describe("governed skill turn preparation", () => {
  it("injects one server-owned system instruction and replaces stale prior injection", () => {
    const marker = "Server-owned governed runtime skill instructions follow.";
    const initial = upsertChatActivatedSkillSystemInstruction(
      [
        { role: "system", content: "Base runtime instruction." },
        { role: "user", content: "Create a presentation." },
      ],
      `${marker}\n\nExact governed design instructions v1.`,
    );
    const replaced = upsertChatActivatedSkillSystemInstruction(
      initial,
      `${marker}\n\nExact governed design instructions v2.`,
    );

    expect(
      replaced.filter((message) => typeof message.content === "string" && message.content.startsWith(marker)),
    ).toHaveLength(1);
    expect(replaced[1]).toEqual({ role: "system", content: expect.stringContaining("instructions v2") });
  });

  it("binds activated instruction and module hashes into the compaction dimension", () => {
    const base = {
      schemaVersion: "chat.turn.capability-profile.v1",
      identity: { workspaceId: "workspace-1" },
      catalog: {
        inspectableHash: "1".repeat(64),
        callableHash: "2".repeat(64),
      },
      selection: {
        mode: "chat",
        webMode: "auto",
        memory: { mode: "off", retrievalMode: "standard", workspaceId: "workspace-1", writeApprovalRequired: true },
        thinkingLevel: "standard",
        speedMode: "standard",
        subagentPolicy: "auto_when_useful",
        toolAutonomy: "safe_auto",
        allowedFallbacks: [],
        tools: [],
        trustedSkills: [],
      },
      governance: { activeGrants: [], policyDecisions: [], authReadiness: [] },
    } as unknown as ChatTurnCapabilityProfileRecord;
    const withReceipt = {
      ...base,
      selection: {
        ...base.selection,
        activatedSkills: [
          {
            capabilityId: "skill:bundled:design-intelligence",
            skillId: "bundled:design-intelligence",
            confidence: 0.98,
            reasons: ["routing_keyword"],
            treeSha256: "3".repeat(64),
            instructionSha256: "4".repeat(64),
            instructionBytes: 1024,
            modules: [
              { name: "main", relativePath: "SKILL.md", sha256: "5".repeat(64), bytes: 512 },
              { name: "layout", relativePath: "layout.md", sha256: "6".repeat(64), bytes: 512 },
            ],
          },
        ],
      },
    } as ChatTurnCapabilityProfileRecord;

    const withoutSkills = buildChatCompactionDimension({ providerId: "openai", model: "gpt-5", profile: base });
    const withSkills = buildChatCompactionDimension({ providerId: "openai", model: "gpt-5", profile: withReceipt });

    expect(withSkills.dimensionHash).not.toBe(withoutSkills.dimensionHash);
  });
});
