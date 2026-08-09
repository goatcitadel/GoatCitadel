import { describe, expect, it } from "vitest";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  buildAutonomousChatAdmissionMetadataMaterial,
  buildChatTurnRuntimeAuthoritySeal,
  buildHeartbeatDecisionReceipt,
  hashChatTurnRuntimeAuthorityValue,
  parseExactHeartbeatDecisionRawOutput,
  readAutonomousChatAdmissionMetadataSeal,
  readExactAutonomousChatPostCommitPendingMarker,
  readExactChatTurnAdmissionHandoff,
  readExactGeneralChatPostCommitSettlement,
  readExactLegacyGeneralChatPostCommitPendingMarker,
  selectCanonicalGeneralChatPostCommitResolution,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
  verifyAutonomousChatAdmissionRunMetadata,
  sealAutonomousChatAdmissionMetadata,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";

const eligibility = {
  version: 1 as const,
  autonomyEnabledAtParentSettlement: true,
  evalIntegrityTurn: false,
  humanSession: false,
};

describe("Chat durable runtime authority", () => {
  it("parses only exact heartbeat decision objects and rejects duplicate or wrapped keys", () => {
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":false}')).toEqual({ notify: false });
    expect(parseExactHeartbeatDecisionRawOutput(' \r\n { "message": "  Wake up  ", "notify": true }\t')).toEqual({
      notify: true,
      normalizedMessage: "Wake up",
    });
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":false,"notify":true,"message":"wake"}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"not\\u0069fy":false,"notify":false}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":false,"message":"hidden"}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":true}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":true,"message":"   "}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":1,"message":"wake"}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":true,"message":"wake","extra":false}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('```json\n{"notify":false}\n```')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('result: {"notify":false}')).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput("null")).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput("[]")).toBeUndefined();
  });

  it("freezes heartbeat message length as Unicode scalar values without normalization", () => {
    const exactBound = `e\u0301${"😀".repeat(3_998)}`;
    const parsed = parseExactHeartbeatDecisionRawOutput(JSON.stringify({ notify: true, message: exactBound }));
    expect(parsed).toEqual({ notify: true, normalizedMessage: exactBound });
    expect(
      parseExactHeartbeatDecisionRawOutput(JSON.stringify({ notify: true, message: `${exactBound}x` })),
    ).toBeUndefined();
    expect(parseExactHeartbeatDecisionRawOutput('{"notify":true,"message":"\\ud800"}')).toBeUndefined();
  });

  it("binds completed heartbeat authority to the exact raw and normalized UTF-8 hashes", () => {
    const rawOutput = ' {"message":"  Wake up  ","notify":true}\n';
    const { decision, receipt } = buildHeartbeatDecisionReceipt({
      occurrenceId: "occurrence-1",
      claimSha256: "a".repeat(64),
      rawOutput,
    });
    expect(decision).toEqual({ notify: true, normalizedMessage: "Wake up" });
    const seal = buildChatTurnRuntimeAuthoritySeal({
      runId: "run-heartbeat",
      turnId: "turn-heartbeat",
      transitionKind: "terminal",
      durableStatus: "completed",
      traceStatus: "completed",
      transitionAt: "2026-07-15T12:00:00.000Z",
      postCommitGenerationId: "generation-heartbeat",
      postCommitEligibility: {
        version: 1,
        autonomyEnabledAtParentSettlement: false,
        evalIntegrityTurn: false,
        humanSession: false,
      },
      terminalOutput: {
        assistantMessageId: "assistant-heartbeat",
        outputText: "Wake up",
        outputSummary: "Wake up",
      },
      heartbeatDecisionReceipt: receipt,
      requiredFinalizers: ["autonomous", "general"],
    });
    expect(seal.material.heartbeatDecisionReceipt).toEqual(receipt);
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        ...seal.material,
        transitionAt: "2026-07-15T12:00:01.000Z",
        postCommitGenerationId: "generation-drift",
        postCommitEligibility: eligibility,
        terminalOutput: {
          assistantMessageId: "assistant-heartbeat",
          outputText: "Wake up",
          outputSummary: "Wake up",
        },
        heartbeatDecisionReceipt: receipt,
      }),
    ).toThrow("disable every post-commit eligibility bit");
  });

  it("allows a silent completed heartbeat only with no terminal output", () => {
    const { receipt } = buildHeartbeatDecisionReceipt({
      occurrenceId: "occurrence-1",
      claimSha256: "b".repeat(64),
      rawOutput: '{"notify":false}',
    });
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        runId: "run-heartbeat",
        turnId: "turn-heartbeat",
        transitionKind: "terminal",
        durableStatus: "completed",
        traceStatus: "completed",
        transitionAt: "2026-07-15T12:00:00.000Z",
        postCommitGenerationId: "generation-heartbeat",
        postCommitEligibility: {
          version: 1,
          autonomyEnabledAtParentSettlement: false,
          evalIntegrityTurn: false,
          humanSession: false,
        },
        heartbeatDecisionReceipt: receipt,
        requiredFinalizers: ["autonomous", "general"],
      }),
    ).not.toThrow();
  });

  it("seals and verifies one exact checkpoint-anchored transition", () => {
    const seal = buildChatTurnRuntimeAuthoritySeal({
      runId: "run-1",
      turnId: "turn-1",
      transitionKind: "terminal",
      durableStatus: "completed",
      traceStatus: "completed",
      transitionAt: "2026-07-15T12:00:00.000Z",
      postCommitGenerationId: "generation-1",
      postCommitEligibility: eligibility,
      terminalOutput: {
        assistantMessageId: "assistant-1",
        outputText: "Canonical answer",
        outputSummary: "Canonical answer",
      },
      requiredFinalizers: ["autonomous", "general"],
    });
    const metadata = withChatTurnRuntimeAuthority({}, seal);
    const checkpoint = withChatTurnRuntimeAuthorityCheckpoint({ currentStep: "completed" }, seal);
    expect(verifyCheckpointAnchoredChatTurnRuntimeAuthority(metadata, checkpoint)).toEqual(seal);

    const driftedCheckpoint = {
      ...checkpoint,
      [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: {
        ...seal,
        materialSha256: "0".repeat(64),
      },
    };
    expect(() => verifyCheckpointAnchoredChatTurnRuntimeAuthority(metadata, driftedCheckpoint)).toThrow();
  });

  it("rejects impossible status pairs and completed authority without canonical output", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      transitionKind: "terminal" as const,
      transitionAt: "2026-07-15T12:00:00.000Z",
      postCommitGenerationId: "generation-1",
      postCommitEligibility: eligibility,
      requiredFinalizers: ["autonomous", "general"] as const,
    };
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        ...base,
        durableStatus: "completed",
        traceStatus: "completed",
      }),
    ).toThrow("internally inconsistent");
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        ...base,
        durableStatus: "completed",
        traceStatus: "partial",
        terminalOutput: {
          assistantMessageId: "assistant-1",
          outputText: "Partial but canonical answer",
          outputSummary: "Partial but canonical answer",
        },
      }),
    ).not.toThrow();
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        ...base,
        durableStatus: "completed",
        traceStatus: "failed",
        terminalOutput: {
          assistantMessageId: "assistant-1",
          outputText: "Answer",
          outputSummary: "Answer",
        },
      }),
    ).toThrow("internally inconsistent");
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        ...base,
        transitionKind: "waiting",
        durableStatus: "waiting",
        traceStatus: "completed",
        waitForEvent: { eventKey: "approval.resolved" },
        requiredFinalizers: ["general"],
      }),
    ).toThrow("internally inconsistent");
    expect(() =>
      buildChatTurnRuntimeAuthoritySeal({
        ...base,
        durableStatus: "failed",
        traceStatus: "failed",
        requiredFinalizers: ["autonomous", "general"],
      }),
    ).toThrow("exact transition contract");
  });

  it("rejects parseable but non-canonical transition timestamps", () => {
    const build = (transitionAt: string) =>
      buildChatTurnRuntimeAuthoritySeal({
        runId: "run-1",
        turnId: "turn-1",
        transitionKind: "terminal",
        durableStatus: "failed",
        traceStatus: "failed",
        transitionAt,
        postCommitGenerationId: "generation-1",
        postCommitEligibility: eligibility,
        requiredFinalizers: ["general"],
      });
    expect(() => build("2026-07-15T12:00:00.000Z")).not.toThrow();
    expect(() => build("2026-07-15T05:00:00-07:00")).toThrow("canonical UTC millisecond");
    expect(() => build("2026-07-15T12:00:00Z")).toThrow("canonical UTC millisecond");
  });

  it("rejects self-hashed minimal admission fakes and verifies the full autonomous run cross-binding", () => {
    const minimal = { version: "chat.autonomous.admission.v1", identity: { durableRunId: "run-1" } };
    expect(() =>
      readAutonomousChatAdmissionMetadataSeal({
        material: minimal,
        materialSha256: hashChatTurnRuntimeAuthorityValue(minimal),
      }),
    ).toThrow("missing or unknown keys");

    const admissionMaterialSha256 = "a".repeat(64);
    const effectiveRequestMaterialSha256 = "b".repeat(64);
    const profileHash = "c".repeat(64);
    const autonomous = {
      kind: "scheduled" as const,
      systemActorId: "system:cron:job-1",
      sourceRunId: "cron-run-1",
      reason: "scheduled run",
      deliverMode: "always" as const,
    };
    const payload = {
      version: "chat.turn.execute.v2",
      sessionId: "session-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      workspaceId: "default",
      sessionIncarnationId: "incarnation-1",
      admissionId: "admission-1",
      admissionMaterialSha256,
      effectiveRequestMaterialSha256,
      request: { content: "Canonical objective" },
      requestActor: { actorKind: "system", actorId: autonomous.systemActorId },
      capabilityProfileId: "profile-1",
      capabilityProfileHash: profileHash,
    };
    const material = buildAutonomousChatAdmissionMetadataMaterial({
      identity: {
        durableRunId: "run-1",
        turnId: "turn-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
      },
      sessionId: "session-1",
      objective: "Canonical objective",
      autonomous,
      payload,
      capabilitySnapshotId: "snapshot-1",
    });
    const run = {
      runId: "run-1",
      workflowKey: "chat.turn.execute",
      status: "completed",
      attemptCount: 0,
      maxAttempts: 3,
      version: 1,
      payload,
      metadata: {
        objective: "Canonical objective",
        autonomous,
        capabilityProfileId: "profile-1",
        capabilityProfileHash: profileHash,
        autonomousAdmission: sealAutonomousChatAdmissionMetadata(material),
      },
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
    } as const;
    expect(
      verifyAutonomousChatAdmissionRunMetadata(run, {
        admission: {
          admissionId: "admission-1",
          admissionKind: "turn_write",
          status: "active",
          sessionIncarnationId: "incarnation-1",
          workspaceId: "default",
          sessionId: "session-1",
          turnId: "turn-1",
          actorKind: "system",
          actorId: autonomous.systemActorId,
          materialSha256: admissionMaterialSha256,
        } as never,
        trace: {
          turnId: "turn-1",
          sessionId: "session-1",
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          capabilityProfileId: "profile-1",
          capabilityProfileHash: profileHash,
          capabilitySnapshotId: "snapshot-1",
        },
      }),
    ).toEqual(run.metadata.autonomousAdmission);
  });

  it("keeps legacy autonomous pending markers explicit while rejecting unknown keys", () => {
    expect(
      readExactAutonomousChatPostCommitPendingMarker({
        version: 1,
        requestedAt: "2026-07-15T12:00:00.000Z",
      }),
    ).toEqual({ version: 1, requestedAt: "2026-07-15T12:00:00.000Z" });
    expect(() =>
      readExactAutonomousChatPostCommitPendingMarker({
        version: 1,
        requestedAt: "2026-07-15T12:00:00.000Z",
        hiddenGeneration: "drift",
      }),
    ).toThrow("missing or unknown keys");
  });

  it("parses only the exact legacy general post-commit shape", () => {
    const legacy = {
      version: 1,
      generationId: "generation-legacy",
      traceStatus: "completed",
      requestedAt: "2026-07-11T00:00:00.000Z",
      completedEffects: ["agent_end", "realtime"],
      durableEffectRunIds: { commitments: "child-commitments" },
    };
    expect(readExactLegacyGeneralChatPostCommitPendingMarker(legacy)).toEqual(legacy);
    expect(
      readExactLegacyGeneralChatPostCommitPendingMarker({
        ...legacy,
        postCommitEligibility: eligibility,
      }),
    ).toBeUndefined();
    expect(() => readExactLegacyGeneralChatPostCommitPendingMarker({ ...legacy, hiddenGeneration: "drift" })).toThrow(
      "missing or unknown keys",
    );
    expect(() =>
      readExactLegacyGeneralChatPostCommitPendingMarker({
        ...legacy,
        durableEffectRunIds: { ungoverned: "child-1" },
      }),
    ).toThrow("unknown key");
  });

  it("requires canonical sorted child ids and their exact digest in handoff evidence", () => {
    const childRunIds = ["child-a", "child-b"];
    const handoff = {
      version: 1,
      admissionId: "admission-1",
      sessionIncarnationId: "incarnation-1",
      turnId: "turn-1",
      parentRunId: "run-1",
      postCommitGenerationId: "generation-1",
      parentLocalEffectsStatus: "settled",
      childRunIds,
      childRunIdsSha256: hashChatTurnRuntimeAuthorityValue(childRunIds),
      committedAt: "2026-07-15T12:00:00.000Z",
    };
    expect(readExactChatTurnAdmissionHandoff(handoff)).toEqual(handoff);
    expect(() => readExactChatTurnAdmissionHandoff({ ...handoff, childRunIds: [...childRunIds].reverse() })).toThrow();
  });

  it.each(["completed", "partial", "failed", "cancelled", "waiting_for_user_input"] as const)(
    "round-trips the canonical general settlement for %s without callback-only keys",
    (traceStatus) => {
      const resolution = selectCanonicalGeneralChatPostCommitResolution({
        disposition: "settled",
        turnId: "turn-1",
        status: traceStatus,
        realtime: "not_applicable",
      });
      expect(resolution).toEqual({ turnId: "turn-1", status: traceStatus, realtime: "not_applicable" });
      const settlement = {
        ...resolution,
        generationId: "generation-1",
        traceStatus,
        requestedAt: "2026-07-15T12:00:00.000Z",
        postCommitEligibility: eligibility,
        parentLocalEffectsStatus: "settled",
        parentLocalEffectsSettledAt: "2026-07-15T12:00:01.000Z",
        completedEffects: [],
        durableEffectRunIds: {},
        durableEffectOutcomes: {},
        childOutcomeAuthority: "child_durable_runs",
        settlementStatus: "completed",
        completedAt: "2026-07-15T12:00:02.000Z",
      };
      expect(readExactGeneralChatPostCommitSettlement(settlement)).toEqual(settlement);
    },
  );
});
