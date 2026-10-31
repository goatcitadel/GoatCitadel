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

  it("keeps an advisory Work Passport and rejects a malformed one", () => {
    const workPassport = {
      passportId: "passport-1",
      schemaVersion: "work.passport.v1",
      classificationMode: "deterministic_local_v1",
      baseline: { configured: false, primaryDomains: [] },
      taskSignals: [{ domain: "legal", strength: "high", reasons: ["contract review"] }],
      boundary: "baseline_not_configured",
      consequence: "moderate",
      review: { posture: "independent_review", reason: "Sensitive domain.", requirements: ["Get review."] },
      evidenceRequirements: ["Cite sources."],
      actionPosture: "ready_for_review",
      limitations: ["Local heuristic."],
      operatorCorrectionAllowed: true,
    };
    expect(readChatTurnFeatureReferences({ ...base, workPassport }).workPassport).toEqual(workPassport);
    expect(() =>
      readChatTurnFeatureReferences({ ...base, workPassport: { ...workPassport, operatorCorrectionAllowed: false } }),
    ).toThrow();
  });

  it("parses a stored chat feature reference whose runtime owner is a plugin", () => {
    const digest = "b".repeat(64);
    const remotePlacement = {
      version: "chat.remote-placement.admission.v1",
      scope: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: digest,
        actorId: "operator-1",
        actorSource: "token",
      },
      citadelId: "citadel-1",
      contentSha256: digest,
      memoryMode: "off",
      runtimeInterposition: { hash: digest, count: 0 },
      permission: { profileId: "profile-1", approvalMode: "approve_risky", profileHash: digest },
      selectedTools: [
        {
          canonicalName: "fs.read",
          modelName: "fs_read",
          definitionHash: digest,
          providerDefinition: { name: "fs_read" },
          runtimeOwner: { kind: "plugin", bindingHash: digest },
          effectPotential: {
            version: "goatcitadel.tool-effect.v1",
            potential: "unknown",
            sourceKind: "plugin",
            reason: "plugin_runtime_untrusted",
          },
        },
      ],
    };
    // Old records only: nothing produces a plugin runtime owner since Phase 4, but stored turns still carry one.
    const parsed = readChatTurnFeatureReferences({ ...base, remotePlacement });
    expect(parsed.remotePlacement).toEqual(remotePlacement);
  });
});
