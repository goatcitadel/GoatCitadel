import { describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  readExactGeneralChatPostCommitPendingMarker,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
} from "./chat-durable-runtime-authority.js";
import {
  DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE,
  DevVerificationRouteService,
} from "./dev-verification-route-service.js";
import { parseDurableChatTurnPayload } from "./durable-execution-service.js";

describe("DevVerificationRouteService durable Chat waits", () => {
  it("seeds an admitted checkpoint-anchored user-input wait that resumes canonically", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const service = new DevVerificationRouteService({ storage } as never);
      const now = "2026-07-30T00:00:00.000Z";
      const promptId = "prompt-verification-1";
      const seeded = service.seedDurableChatWait({
        workspaceId: "workspace-verification",
        sessionId: "session-verification",
        turnId: "turn-verification",
        userMessageId: "user-verification",
        content: "Choose the deterministic continuation.",
        authActorId: "loopback:verification-service-test",
        authActorSource: "loopback",
        traceStatus: "waiting_for_user_input",
        waitForEvent: {
          eventKey: "chat.user_input.resolved",
          correlationId: promptId,
        },
        now,
      });
      const run = storage.durableRuns.getRun(seeded.runId);
      const payload = parseDurableChatTurnPayload(run);
      expect(payload).toMatchObject({
        version: "chat.turn.execute.v2",
        workspaceId: "workspace-verification",
        sessionId: "session-verification",
        turnId: "turn-verification",
        userMessageId: "user-verification",
        assistantMessageId: seeded.assistantMessageId,
        requestActor: {
          actorKind: "operator",
          actorId: "loopback:verification-service-test",
          operatorId: "loopback:verification-service-test",
          authActorId: "loopback:verification-service-test",
          authActorSource: "loopback",
        },
      });
      const checkpoint = storage.durableRuns.getLatestCheckpointByKind(seeded.runId, "run_waiting");
      expect(checkpoint).toBeDefined();
      verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint!.state);
      expect(readExactGeneralChatPostCommitPendingMarker(run.metadata?.generalChatPostCommitPending)).toMatchObject({
        traceStatus: "waiting_for_user_input",
      });

      storage.chatTurnTraces.create({
        turnId: "turn-verification",
        sessionId: "session-verification",
        userMessageId: "user-verification",
        assistantMessageId: seeded.assistantMessageId,
        status: "waiting_for_user_input",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        pendingUserInput: {
          promptId,
          turnId: "turn-verification",
          kind: "single_select",
          title: "Choose",
          question: "Continue?",
          required: true,
          dismissible: false,
          submitLabel: "Submit",
          options: [{ optionId: "option-a", label: "Continue", description: "Resume the deterministic run." }],
        },
        durable: { runId: seeded.runId, status: "waiting", checkpointKind: "run_waiting" },
        startedAt: now,
      });
      const resolved = storage.sessionMutationAdmissions.resolveDurableChatUserInput({
        admissionIdentity: {
          admissionId: payload!.admissionId,
          sessionIncarnationId: payload!.sessionIncarnationId,
          workspaceId: payload!.workspaceId,
          sessionId: payload!.sessionId,
          turnId: payload!.turnId,
          aggregateRevision: payload!.admissionAggregateRevision,
          controllerGeneration: payload!.admissionControllerGeneration,
          materialSha256: payload!.admissionMaterialSha256,
        },
        durableRunId: seeded.runId,
        expectedWaitingRunVersion: run.version,
        promptId,
        eventKey: "chat.user_input.resolved",
        correlationId: promptId,
        responder: { actorId: "verification-operator", authActorSource: "loopback" },
        response: { kind: "single_select", optionId: "option-a" },
      });

      expect(resolved).toMatchObject({ disposition: "resolved", run: { status: "queued" } });
      expect(storage.chatTurnTraces.get("turn-verification")).toMatchObject({
        status: "running",
        pendingUserInput: undefined,
      });
    } finally {
      storage.close();
    }
  });
});

describe("DevVerificationRouteService Chat attachment evidence", () => {
  it("seeds one idempotent local URL source plus rendered citation and tool truth", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const now = "2026-07-30T02:00:00.000Z";
      const workspaceId = "workspace-attachment-verification";
      const sessionId = "session-attachment-verification";
      const turnId = "turn-attachment-verification";
      storage.chatSessionMeta.ensure(sessionId, now, workspaceId);
      storage.chatMessages.upsertMany([
        {
          messageId: "user-attachment-verification",
          sessionId,
          role: "user",
          actorType: "user",
          actorId: "verification-operator",
          content: "Inspect deterministic attachment evidence.",
          timestamp: now,
        },
        {
          messageId: "assistant-attachment-verification",
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "goatherder",
          content: "Deterministic attachment evidence is ready.",
          timestamp: now,
        },
      ]);
      storage.chatTurnTraces.create({
        turnId,
        sessionId,
        userMessageId: "user-attachment-verification",
        assistantMessageId: "assistant-attachment-verification",
        status: "completed",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: now,
        finishedAt: now,
      });
      storage.chatSessionBranchState.setActiveLeaf(sessionId, turnId, now);

      const service = new DevVerificationRouteService({ storage } as never);
      const first = service.seedChatAttachmentEvidence({ workspaceId, sessionId, now });
      const second = service.seedChatAttachmentEvidence({ workspaceId, sessionId, now });

      expect(second).toEqual(first);
      expect(storage.chatTurnTraces.get(turnId).citations).toEqual([
        expect.objectContaining({
          citationId: first.citationId,
          title: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceTitle,
          url: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl,
          sourceType: "web",
        }),
      ]);
      expect(storage.chatToolRuns.listByTurn(turnId)).toEqual([
        expect.objectContaining({
          toolRunId: first.toolRunId,
          toolName: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.toolName,
          status: "executed",
          effectPotential: "none",
          effectOutcomeKind: "none",
        }),
      ]);
      const sources = storage.chatThreadKnowledgeAttachments.listBySession(sessionId);
      expect(sources).toEqual([
        expect.objectContaining({
          attachmentId: first.sourceAttachmentId,
          sourceRef: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceUrl,
          ingestStatus: "ready",
          chunkCount: 1,
        }),
      ]);
      expect(storage.knowledge.listDocuments(`chat-session:${sessionId}:knowledge`)).toHaveLength(1);
      expect(storage.knowledge.listChunksByDocument(sources[0]!.documentId!)).toEqual([
        expect.objectContaining({ content: DEV_VERIFICATION_CHAT_ATTACHMENT_EVIDENCE.sourceSnippet }),
      ]);
    } finally {
      storage.close();
    }
  });

  it("fails closed for a foreign workspace or incomplete active turn", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const now = "2026-07-30T02:00:00.000Z";
      storage.chatSessionMeta.ensure("session-1", now, "workspace-1");
      storage.chatMessages.upsert({
        messageId: "user-1",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "verification-operator",
        content: "Still running.",
        timestamp: now,
      });
      storage.chatTurnTraces.create({
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "running",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: now,
      });
      storage.chatSessionBranchState.setActiveLeaf("session-1", "turn-1", now);
      const service = new DevVerificationRouteService({ storage } as never);

      expect(() =>
        service.seedChatAttachmentEvidence({ workspaceId: "workspace-foreign", sessionId: "session-1", now }),
      ).toThrow(/exact session\/workspace match/u);
      expect(() =>
        service.seedChatAttachmentEvidence({ workspaceId: "workspace-1", sessionId: "session-1", now }),
      ).toThrow(/must be completed/u);
    } finally {
      storage.close();
    }
  });
});
