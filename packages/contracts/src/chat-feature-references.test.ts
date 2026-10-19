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
  it("keeps a content-free workspace snapshot and rejects extra fields", () => {
    const workspaceSnapshot = {
      schemaVersion: "chat.workspace-snapshot.v1" as const,
      snapshotId: "chat-workspace-snapshot-1",
      requestId: "snapshot-request-1",
      workspaceId: "workspace",
      project: { projectId: "project-1", projectRevision: 3 },
      status: "captured" as const,
      pathBinding: {
        verificationId: "verification-1",
        fingerprintSha256: "c".repeat(64),
        gitIdentitySha256: "d".repeat(64),
      },
      git: { headSha: "e".repeat(40), branch: "main", trackedChangeCount: 1, untrackedChangeCount: 0, dirty: true },
      capturedAt: "2026-10-19T00:00:00.000Z",
      snapshotHash: "f".repeat(64),
    };
    expect(readChatTurnFeatureReferences({ ...base, workspaceSnapshot }).workspaceSnapshot).toEqual(workspaceSnapshot);
    expect(() =>
      readChatTurnFeatureReferences({ ...base, workspaceSnapshot: { ...workspaceSnapshot, diff: "secret" } }),
    ).toThrow();
  });
});
