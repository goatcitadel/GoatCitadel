import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type {
  ChatMessageRecord,
  ChatTimerRecord,
  ChatTurnTraceRecord,
  ChatUserInputPromptResponse,
  DurableCheckpointRecord,
  DurableRunRecord,
} from "@goatcitadel/contracts";
import type { HeartbeatOccurrenceRecord, VerifiedTerminalTurnWriteHandoff } from "@goatcitadel/storage";
import {
  answerChatUserInputPrompt as answerChatUserInputPromptRuntime,
  getChatThread,
  getTurnContextManifestForSession,
  selectChatBranchTurn,
  type ChatMessageRouteRuntimeHost,
} from "./chat-message-route-runtime.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY,
  HEARTBEAT_DECISION_RECEIPT_METADATA_KEY,
  buildAutonomousChatAdmissionMetadataMaterial,
  buildChatTurnRuntimeAuthoritySeal,
  buildHeartbeatDecisionReceipt,
  sealAutonomousChatAdmissionMetadata,
} from "./chat-durable-runtime-authority.js";

const TEST_RESPONDER = { actorId: "operator:test", authActorSource: "token" } as const;

describe("chat-message-route-runtime", () => {
  it("builds chat threads and records branch selection realtime truth", async () => {
    const state = createThreadState();
    const runtime = createRuntime({ state });

    const thread = await getChatThread(runtime, "sess-1");
    expect(thread.activeLeafTurnId).toBe("turn-child-a");
    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);

    const selected = await selectChatBranchTurn(runtime, "sess-1", "turn-root");

    expect(runtime.storage.chatSessionBranchState.setActiveLeaf).toHaveBeenCalledWith("sess-1", "turn-child-b");
    expect(runtime.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({
        type: "chat_thread_branch_selected",
        sessionId: "sess-1",
        turnId: "turn-root",
        activeLeafTurnId: "turn-child-b",
      }),
      expect.objectContaining({
        eventAuthority: "retained_stream",
      }),
    );
    expect(selected.activeLeafTurnId).toBe("turn-child-b");
    expect(selected.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-b"]);
  });

  it("projects verified historical file writes as safe workspace downloads without mutating stored content", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-download-projection-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    try {
      const outputDir = path.join(workspaceRoot, "goatcitadel_out");
      const artifactPath = path.join(outputDir, "funniest-jokes.pptx");
      const outsidePath = path.join(tempRoot, "outside.txt");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(artifactPath, Buffer.from("valid-pptx-fixture"));
      await fs.writeFile(outsidePath, "outside");
      const state = createThreadState();
      const rootTrace = state.traces.find((trace) => trace.turnId === "turn-root")!;
      rootTrace.toolRuns = [
        {
          toolRunId: "tool-file-1",
          turnId: rootTrace.turnId,
          sessionId: rootTrace.sessionId,
          toolName: "presentations.create",
          status: "executed",
          result: { path: artifactPath, bytesWritten: 18, slideCount: 12 },
          startedAt: "2026-03-22T12:00:00.000Z",
          finishedAt: "2026-03-22T12:00:01.000Z",
        },
        {
          toolRunId: "tool-file-outside",
          turnId: rootTrace.turnId,
          sessionId: rootTrace.sessionId,
          toolName: "artifacts.create",
          status: "executed",
          result: { path: outsidePath, bytesWritten: 7 },
          startedAt: "2026-03-22T12:00:01.000Z",
          finishedAt: "2026-03-22T12:00:02.000Z",
        },
        {
          toolRunId: "tool-file-failed",
          turnId: rootTrace.turnId,
          sessionId: rootTrace.sessionId,
          toolName: "fs.write",
          status: "failed",
          result: { path: path.join(outputDir, "blocked.txt"), bytesWritten: 10 },
          startedAt: "2026-03-22T12:00:01.000Z",
          finishedAt: "2026-03-22T12:00:02.000Z",
        },
        {
          toolRunId: "tool-file-missing",
          turnId: rootTrace.turnId,
          sessionId: rootTrace.sessionId,
          toolName: "documents.create",
          status: "executed",
          result: { path: path.join(outputDir, "missing.docx"), bytesWritten: 10 },
          startedAt: "2026-03-22T12:00:02.000Z",
          finishedAt: "2026-03-22T12:00:03.000Z",
        },
      ];
      const storedAssistantMessage = state.messagesById.get("assistant-root")!;
      storedAssistantMessage.content = [
        "Done.",
        "[Download the PowerPoint](sandbox:/mnt/data/funniest-jokes.pptx)",
        "[Outside file](sandbox:/mnt/data/outside.txt)",
        "[Blocked file](sandbox:/mnt/data/blocked.txt)",
        "[Missing file](sandbox:/mnt/data/missing.docx)",
      ].join("\n\n");
      const runtime = createRuntime({ state, workspaceFileRootDir: workspaceRoot });

      const thread = await getChatThread(runtime, "sess-1");
      const projectedContent = thread.turns.find((turn) => turn.turnId === "turn-root")?.assistantMessage?.content;

      expect(projectedContent).toContain(
        "[Download the PowerPoint](/api/v1/files/download?relativePath=goatcitadel_out%2Ffunniest-jokes.pptx)",
      );
      expect(projectedContent).not.toContain("sandbox:/mnt/data/funniest-jokes.pptx");
      expect(projectedContent).toContain("[Outside file](sandbox:/mnt/data/outside.txt)");
      expect(projectedContent).toContain("[Blocked file](sandbox:/mnt/data/blocked.txt)");
      expect(projectedContent).toContain("[Missing file](sandbox:/mnt/data/missing.docx)");
      expect(storedAssistantMessage.content).toContain("sandbox:/mnt/data/funniest-jokes.pptx");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("projects an exact retained heartbeat separately without changing branch truth", async () => {
    const state = createThreadState();
    const heartbeat = createHeartbeatThreadFixture();
    state.traces.push(heartbeat.trace);
    const runtime = createRuntime({
      state,
      durableRun: heartbeat.run,
      durableCheckpoint: heartbeat.checkpoint,
      heartbeatOccurrence: heartbeat.occurrence,
      terminalHandoff: heartbeat.terminalHandoff,
      canonicalMessageOverrides: new Map([[heartbeat.message.messageId, heartbeat.message]]),
    });

    const thread = await getChatThread(runtime, "sess-1");
    const loadOptions = vi.mocked(runtime.loadChatTurnSessionState).mock.calls[0]?.[1];

    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);
    expect(thread.activeLeafTurnId).toBe("turn-child-a");
    expect(thread.systemNotices).toEqual([
      expect.objectContaining({
        kind: "system_heartbeat",
        noticeId: heartbeat.message.messageId,
        turnId: heartbeat.trace.turnId,
        message: expect.objectContaining({ content: "Disk pressure high." }),
      }),
    ]);
    expect(state.messagesById.has(heartbeat.trace.userMessageId)).toBe(false);
    expect(loadOptions?.isConversationTrace).toBeUndefined();

    const selected = await selectChatBranchTurn(runtime, "sess-1", "turn-root");
    expect(selected.activeLeafTurnId).toBe("turn-child-b");
    expect(selected.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-b"]);
    expect(selected.systemNotices.map((notice) => notice.noticeId)).toEqual([heartbeat.message.messageId]);

    state.messagesById.set(heartbeat.trace.userMessageId, {
      ...heartbeat.message,
      messageId: heartbeat.trace.userMessageId,
      role: "user",
      content: "illicit hidden input",
    });
    await expect(selectChatBranchTurn(runtime, "sess-1", heartbeat.trace.turnId)).rejects.toThrow("not found");
    expect(runtime.storage.chatSessionBranchState.setActiveLeaf).toHaveBeenCalledTimes(1);
  });

  it("projects only settled provider-free timer notices", async () => {
    const state = createThreadState();
    const timerMessage: ChatMessageRecord = {
      messageId: "timer-notice-timer-1",
      sessionId: "sess-1",
      role: "assistant",
      actorType: "system",
      actorId: "chat-timer",
      content: "Review the proof.",
      timestamp: "2026-07-28T01:00:00.000Z",
    };
    const timer = {
      timerId: "timer-1",
      workspaceId: "workspace-1",
      sessionId: "sess-1",
      revision: 3,
      dueAt: "2026-07-28T01:00:00.000Z",
      timezone: "UTC",
      message: "Review the proof.",
      cancelOnNextReply: false,
      status: "fired",
      createdBy: "operator",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T01:00:00.000Z",
      noticeMessageId: timerMessage.messageId,
      notificationEventId: "timer-due-timer-1",
      notificationDeliveryStatus: "no_targets",
      firedAt: "2026-07-28T01:00:00.000Z",
    } satisfies ChatTimerRecord;
    const runtime = createRuntime({
      state,
      chatTimers: [timer],
      canonicalMessageOverrides: new Map([[timerMessage.messageId, timerMessage]]),
    });

    const thread = await getChatThread(runtime, "sess-1");
    expect(thread.systemNotices).toContainEqual({
      kind: "timer_due",
      noticeId: timerMessage.messageId,
      turnId: "timer:timer-1",
      message: timerMessage,
    });
  });

  it("reloads a notice-only session through canonical message hydration without creating a branch", async () => {
    const heartbeat = createHeartbeatThreadFixture();
    const state = {
      session: { sessionId: "sess-1" },
      activeLeafTurnId: undefined,
      traces: [heartbeat.trace],
      childrenByTurnId: new Map(),
      messagesById: new Map(),
    } as unknown as ChatTurnSessionState;
    const runtime = createRuntime({
      state,
      durableRun: heartbeat.run,
      durableCheckpoint: heartbeat.checkpoint,
      heartbeatOccurrence: heartbeat.occurrence,
      terminalHandoff: heartbeat.terminalHandoff,
      canonicalMessageOverrides: new Map([[heartbeat.message.messageId, heartbeat.message]]),
    });

    const thread = await getChatThread(runtime, "sess-1");

    expect(thread.turns).toEqual([]);
    expect(thread.activeLeafTurnId).toBeUndefined();
    expect(thread.selectedTurnId).toBeUndefined();
    expect(thread.systemNotices.map((notice) => notice.message.content)).toEqual(["Disk pressure high."]);
    expect(state.messagesById.size).toBe(0);
  });

  it.each([
    {
      label: "silent decision",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        fixture.run.metadata![HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] = '{"notify":false}';
      },
    },
    {
      label: "malformed decision evidence",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        delete fixture.run.metadata![HEARTBEAT_DECISION_RECEIPT_METADATA_KEY];
      },
    },
    {
      label: "nonterminal run",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        fixture.run.status = "running";
      },
    },
    {
      label: "message drift",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        fixture.message.content = "Different bytes";
      },
    },
    {
      label: "checkpoint drift",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        fixture.checkpoint.state.outputSummary = "Different bytes";
      },
    },
    {
      label: "occurrence-owner drift",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        fixture.occurrence.claimSha256 = "f".repeat(64);
      },
    },
    {
      label: "terminal-handoff drift",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        fixture.terminalHandoff.handoffSha256 = "0".repeat(64);
      },
    },
    {
      label: "completion-shape drift",
      mutate: (fixture: ReturnType<typeof createHeartbeatThreadFixture>) => {
        (fixture.trace.completion as Record<string, unknown>).finishReason = "stop";
      },
    },
  ])("omits $label from the public thread", async ({ mutate }) => {
    const state = createThreadState();
    const heartbeat = createHeartbeatThreadFixture();
    mutate(heartbeat);
    state.traces.push(heartbeat.trace);
    state.messagesById.set(heartbeat.message.messageId, heartbeat.message);
    const runtime = createRuntime({
      state,
      durableRun: heartbeat.run,
      durableCheckpoint: heartbeat.checkpoint,
      heartbeatOccurrence: heartbeat.occurrence,
      terminalHandoff: heartbeat.terminalHandoff,
    });

    const thread = await getChatThread(runtime, "sess-1");

    expect(thread.systemNotices).toEqual([]);
    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);
  });

  it("omits a heartbeat when canonical storage contains a hidden input row that the loaded page missed", async () => {
    const state = createThreadState();
    const heartbeat = createHeartbeatThreadFixture();
    state.traces.push(heartbeat.trace);
    state.messagesById.set(heartbeat.message.messageId, heartbeat.message);
    const hiddenUserMessage: ChatMessageRecord = {
      messageId: heartbeat.trace.userMessageId,
      sessionId: "sess-1",
      role: "user",
      actorType: "system",
      actorId: "system-heartbeat",
      content: "must never persist",
      timestamp: "2026-07-15T10:00:00.000Z",
    };
    const runtime = createRuntime({
      state,
      durableRun: heartbeat.run,
      durableCheckpoint: heartbeat.checkpoint,
      heartbeatOccurrence: heartbeat.occurrence,
      terminalHandoff: heartbeat.terminalHandoff,
      canonicalMessageOverrides: new Map([[hiddenUserMessage.messageId, hiddenUserMessage]]),
    });

    const thread = await getChatThread(runtime, "sess-1");

    expect(thread.systemNotices).toEqual([]);
    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);
  });

  it("omits a heartbeat that drifted into the active conversation leaf", async () => {
    const state = createThreadState();
    const heartbeat = createHeartbeatThreadFixture();
    state.traces.push(heartbeat.trace);
    state.messagesById.set(heartbeat.message.messageId, heartbeat.message);
    state.activeLeafTurnId = heartbeat.trace.turnId;
    const runtime = createRuntime({
      state,
      durableRun: heartbeat.run,
      durableCheckpoint: heartbeat.checkpoint,
      heartbeatOccurrence: heartbeat.occurrence,
      terminalHandoff: heartbeat.terminalHandoff,
    });

    const thread = await getChatThread(runtime, "sess-1");

    expect(thread.systemNotices).toEqual([]);
    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-b"]);
    expect(thread.activeLeafTurnId).toBe("turn-child-b");
  });

  it("limits generated-artifact lookup to renderable thread turns", async () => {
    const state = createThreadState();
    state.messagesById.delete("user-b");
    state.messagesById.delete("assistant-b");
    const runtime = createRuntime({ state });

    const thread = await getChatThread(runtime, "sess-1");

    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);
    expect(runtime.storage.chatGeneratedArtifacts.listByTurnIds).toHaveBeenCalledWith(["turn-root", "turn-child-a"]);
  });

  it("projects secret-bearing tool runs for the public thread without mutating runtime truth", async () => {
    const state = createThreadState();
    const rootTrace = state.traces.find((trace) => trace.turnId === "turn-root")!;
    rootTrace.toolRuns = [
      {
        toolRunId: "tool-secret-1",
        turnId: "turn-root",
        sessionId: "sess-1",
        toolName: "docs.search",
        status: "executed",
        args: {
          webhookUrl: "https://hooks.example.test/send?token=short-token",
          tokenEnv: "DOCS_SEARCH_TOKEN",
        },
        result: {
          authorization: "Bearer short",
          DATABASE_PASSWORD: "tiny-secret",
          tokenBudget: 2048,
        },
        startedAt: "2026-03-22T12:00:00.000Z",
        finishedAt: "2026-03-22T12:00:01.000Z",
      } as never,
    ];
    const rawAssistantMessage = state.messagesById.get("assistant-root")!;
    rawAssistantMessage.content =
      '{\\"DATABASE_PASSWORD\\":\\"legacy-db-secret\\",\\"webhookUrl\\":\\"https://hooks.example.test/services/team/legacy-hook-secret\\"}';
    const runtime = createRuntime({ state });

    const thread = await getChatThread(runtime, "sess-1");

    expect(JSON.stringify(thread)).not.toContain("short-token");
    expect(JSON.stringify(thread)).not.toContain("Bearer short");
    expect(JSON.stringify(thread)).not.toContain("tiny-secret");
    expect(JSON.stringify(thread)).not.toContain("legacy-db-secret");
    expect(JSON.stringify(thread)).not.toContain("legacy-hook-secret");
    expect(thread.turns[0]?.toolRuns?.[0]).toMatchObject({
      args: { tokenEnv: "DOCS_SEARCH_TOKEN" },
      result: { tokenBudget: 2048 },
    });
    expect(JSON.stringify(rootTrace)).toContain("short-token");
    expect(JSON.stringify(rootTrace)).toContain("Bearer short");
    expect(JSON.stringify(rootTrace)).toContain("tiny-secret");
    expect(rawAssistantMessage.content).toContain("legacy-db-secret");
    expect(rawAssistantMessage.content).toContain("legacy-hook-secret");
  });

  it("validates context manifest session and turn identifiers", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        turnId: "turn-1",
        sessionId: "sess-1",
      }),
      contextManifest: { manifestId: "manifest-1" },
    });

    await expect(getTurnContextManifestForSession(runtime, " ", "turn-1")).rejects.toThrow(ValidationError);
    await expect(getTurnContextManifestForSession(runtime, "sess-1", " ")).rejects.toThrow(ValidationError);
    await expect(getTurnContextManifestForSession(runtime, "sess-2", "turn-1")).rejects.toThrow(
      "does not belong to session",
    );
    await expect(getTurnContextManifestForSession(runtime, "sess-1", "turn-1")).resolves.toEqual({
      manifestId: "manifest-1",
    });
  });

  it("validates mismatched active prompts before invoking the atomic continuation owner", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-1" },
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "single_select",
          question: "Pick one",
          options: [{ optionId: "a", label: "A" }],
        },
      }),
    });

    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "missing", { kind: "single_select", optionId: "a" }),
    ).rejects.toThrow("is not active");
    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "details" }),
    ).rejects.toThrow("expects a single_select response");
    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", {
        kind: "single_select",
        optionId: "z",
      }),
    ).rejects.toThrow("is not valid");

    runtime.trace = createTrace({
      status: "waiting_for_user_input",
      durable: { runId: "run-1" },
      pendingUserInput: {
        promptId: "prompt-2",
        kind: "text",
        question: "Add detail",
      },
    });
    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-2", { kind: "text", text: "   " }),
    ).rejects.toThrow("requires non-empty text");
  });

  it("atomically resolves text input under the exact admission and queues processing", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-1" },
        pendingUserInput: {
          promptId: "prompt-text",
          kind: "text",
          title: "Missing input",
          question: "What should happen next?",
        },
      }),
      durableRun: createDurableRun("run-1", "waiting"),
    });

    const result = await answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-text", {
      kind: "text",
      text: "  Continue with the safe path.  ",
    });

    expect(result).toMatchObject({
      ok: true,
      resumed: true,
      resumedRunId: "run-1",
      resumedTurnId: "turn-1",
    });
    expect(runtime.storage.sessionMutationAdmissions.resolveDurableChatUserInput).toHaveBeenCalledWith({
      admissionIdentity: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        workspaceId: "workspace-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        aggregateRevision: 7,
        controllerGeneration: 3,
        materialSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      durableRunId: "run-1",
      expectedWaitingRunVersion: 3,
      promptId: "prompt-text",
      eventKey: "chat.user_input.resolved",
      correlationId: "prompt-text",
      responder: TEST_RESPONDER,
      response: { kind: "text", text: "Continue with the safe path." },
    });
    expect(runtime.durableRunService.requestRunProcessing).toHaveBeenCalledWith("run-1");
    expect(runtime.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.user_input_prompt.answered",
        sessionId: "sess-1",
        turnId: "turn-1",
      }),
    );
    expect(JSON.stringify(runtime.recordDevDiagnostic.mock.calls)).not.toContain("Continue with the safe path");
    expect(JSON.stringify(runtime.publishRealtime.mock.calls)).not.toContain("Continue with the safe path");
  });

  it("passes selected options to storage without echoing the answer", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-2" },
        pendingUserInput: {
          promptId: "prompt-choice",
          kind: "single_select",
          question: "Which branch?",
          options: [{ optionId: "safe", label: "Safe path", description: "Bounded continuation" }],
        },
      }),
      durableRun: createDurableRun("run-2", "waiting"),
    });

    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-choice", {
        kind: "single_select",
        optionId: "safe",
      }),
    ).resolves.toMatchObject({ resumed: true });

    expect(runtime.storage.sessionMutationAdmissions.resolveDurableChatUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "single_select", optionId: "safe" },
      }),
    );
    expect(JSON.stringify(runtime.recordDevDiagnostic.mock.calls)).not.toContain("safe");
  });

  it("allows an exact sealed replay after the trace has advanced and does not re-enqueue terminal work", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "running",
        durable: { runId: "run-replay" },
        pendingUserInput: undefined,
      }),
      durableRun: createDurableRun("run-replay", "running"),
      resolveOutcome: {
        disposition: "replayed",
        run: { runId: "run-replay", status: "completed", version: 8 },
      },
    });

    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "yes" }),
    ).resolves.toMatchObject({ resumed: true, resumedRunId: "run-replay" });

    expect(runtime.storage.sessionMutationAdmissions.resolveDurableChatUserInput).toHaveBeenCalledTimes(1);
    expect(runtime.durableRunService.requestRunProcessing).not.toHaveBeenCalled();
    expect(runtime.recordDevDiagnostic).not.toHaveBeenCalled();
    expect(runtime.publishRealtime).not.toHaveBeenCalled();
  });

  it("re-requests idempotent processing for a queued sealed replay without publishing a second event", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "running",
        durable: { runId: "run-replay-queued" },
        pendingUserInput: undefined,
      }),
      durableRun: createDurableRun("run-replay-queued", "queued"),
      resolveOutcome: {
        disposition: "replayed",
        run: { runId: "run-replay-queued", status: "queued", version: 4 },
      },
    });

    await answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "yes" });

    expect(runtime.durableRunService.requestRunProcessing).toHaveBeenCalledOnce();
    expect(runtime.recordDevDiagnostic).not.toHaveBeenCalled();
    expect(runtime.publishRealtime).not.toHaveBeenCalled();
  });

  it("raises conflicts for missing durable links and invalid durable admission payloads", async () => {
    const noRunRuntime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "text",
          question: "Continue?",
        },
      }),
    });

    await expect(
      answerChatUserInputPrompt(noRunRuntime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "yes" }),
    ).rejects.toThrow(ConflictError);

    const invalidPayloadRuntime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-invalid" },
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "text",
          question: "Continue?",
        },
      }),
      durableRun: {
        ...createDurableRun("run-invalid", "waiting"),
        payload: { version: "other" },
      } as DurableRunRecord,
    });

    await expect(
      answerChatUserInputPrompt(invalidPayloadRuntime, "sess-1", "turn-1", "prompt-1", {
        kind: "text",
        text: "yes",
      }),
    ).rejects.toThrow("missing a valid chat turn payload");
  });
});

function answerChatUserInputPrompt(
  runtime: ChatMessageRouteRuntimeHost,
  sessionId: string,
  turnId: string,
  promptId: string,
  response: ChatUserInputPromptResponse,
) {
  return answerChatUserInputPromptRuntime(runtime, sessionId, turnId, promptId, response, TEST_RESPONDER);
}

function createRuntime(input: {
  state?: ChatTurnSessionState;
  trace?: Partial<ChatTurnTraceRecord>;
  contextManifest?: Record<string, unknown>;
  durableRun?: DurableRunRecord;
  durableCheckpoint?: DurableCheckpointRecord;
  heartbeatOccurrence?: HeartbeatOccurrenceRecord;
  terminalHandoff?: VerifiedTerminalTurnWriteHandoff;
  chatTimers?: ChatTimerRecord[];
  canonicalMessageOverrides?: Map<string, ChatMessageRecord>;
  workspaceFileRootDir?: string;
  resolveOutcome?: {
    disposition: "resolved" | "replayed";
    run: { runId: string; status: string; version: number };
  };
}): ChatMessageRouteRuntimeHost & { trace: ChatTurnTraceRecord } {
  const threadState = input.state ?? createThreadState();
  const runtime = {
    trace: createTrace(input.trace),
    config: input.workspaceFileRootDir
      ? { rootDir: input.workspaceFileRootDir, assistant: { workspaceDir: "." } }
      : undefined,
    storage: {
      chatGeneratedArtifacts: {
        listByTurnIds: vi.fn(() => new Map()),
      },
      chatTimers: {
        listFiredBySession: vi.fn(() => input.chatTimers ?? []),
      },
      chatSessionBranchState: {
        setActiveLeaf: vi.fn(),
      },
      chatTurnTraces: {
        get: vi.fn(() => runtime.trace),
        patch: vi.fn(),
      },
      contextManifests: {
        maybeGetDetailByTurn: vi.fn(() => input.contextManifest),
      },
      chatMessages: {
        get: vi.fn(
          (messageId: string) =>
            input.canonicalMessageOverrides?.get(messageId) ?? threadState.messagesById.get(messageId),
        ),
      },
      durableRuns: {
        getLatestCheckpointByKind: vi.fn(() => input.durableCheckpoint),
      },
      heartbeatOccurrences: {
        find: vi.fn(() => input.heartbeatOccurrence),
      },
      sessionMutationAdmissions: {
        findVerifiedTerminalTurnWriteHandoff: vi.fn(() => input.terminalHandoff),
        resolveDurableChatUserInput: vi.fn((request) => ({
          disposition: input.resolveOutcome?.disposition ?? "resolved",
          run: input.resolveOutcome?.run ?? {
            runId: request.durableRunId,
            status: "queued",
            version: request.expectedWaitingRunVersion + 1,
          },
          seal: {},
          responseRecord: {},
        })),
      },
    },
    durableRunService: {
      getDurableRun: vi.fn(() => input.durableRun ?? createDurableRun("run-1", "waiting")),
      requestRunProcessing: vi.fn(),
    },
    getSession: vi.fn(),
    loadChatTurnSessionState: vi.fn(async () => threadState),
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
  } as unknown as ChatMessageRouteRuntimeHost & { trace: ChatTurnTraceRecord };
  return runtime;
}

function createHeartbeatThreadFixture(): {
  run: DurableRunRecord;
  checkpoint: DurableCheckpointRecord;
  occurrence: HeartbeatOccurrenceRecord;
  terminalHandoff: VerifiedTerminalTurnWriteHandoff;
  trace: ChatTurnTraceRecord;
  message: ChatMessageRecord;
} {
  const runId = "run-heartbeat-1";
  const turnId = "turn-heartbeat-1";
  const userMessageId = "ephemeral-heartbeat-1";
  const assistantMessageId = "assistant-heartbeat-1";
  const occurrenceId = "heartbeat-occurrence-1";
  const claimSha256 = "a".repeat(64);
  const content = "Disk pressure high.";
  const rawOutput = `{"notify":true,"message":"${content}"}`;
  const request = {
    content: "Perform the bounded heartbeat check and return the exact decision object.",
    permissionProfileId: "heartbeat-restricted",
    policyRunId: runId,
  };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const payload = {
    version: "chat.turn.execute.v2" as const,
    admissionId: "admission-heartbeat-1",
    sessionIncarnationId: "incarnation-heartbeat-1",
    admissionMaterialSha256,
    workspaceId: "workspace-1",
    admissionAggregateRevision: 7,
    admissionControllerGeneration: 3,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    requestActor: { actorKind: "system" as const, actorId: "system-heartbeat" },
    sessionId: "sess-1",
    turnId,
    userMessageId,
    assistantMessageId,
    branchKind: "append" as const,
    threadEventType: "chat_heartbeat_message_committed",
    request,
    heartbeatOccurrenceId: occurrenceId,
    heartbeatClaimSha256: claimSha256,
    heartbeatEvaluatedPolicySha256: "b".repeat(64),
    heartbeatFrozenObjectiveSha256: "c".repeat(64),
  };
  const autonomous = {
    kind: "heartbeat" as const,
    systemActorId: "system-heartbeat",
    sourceRunId: runId,
    reason: "bounded session heartbeat",
    deliverMode: "on_notify" as const,
  };
  const decision = buildHeartbeatDecisionReceipt({ occurrenceId, claimSha256, rawOutput });
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId,
    turnId,
    transitionKind: "terminal",
    durableStatus: "completed",
    traceStatus: "completed",
    transitionAt: "2026-07-15T10:01:00.000Z",
    postCommitGenerationId: "heartbeat-generation-1",
    postCommitEligibility: {
      version: 1,
      autonomyEnabledAtParentSettlement: false,
      evalIntegrityTurn: false,
      humanSession: false,
    },
    terminalOutput: {
      assistantMessageId,
      outputText: content,
      outputSummary: content,
    },
    heartbeatDecisionReceipt: decision.receipt,
    requiredFinalizers: ["autonomous", "general"],
  });
  const autonomousAdmission = sealAutonomousChatAdmissionMetadata(
    buildAutonomousChatAdmissionMetadataMaterial({
      identity: { userMessageId, turnId, assistantMessageId, durableRunId: runId },
      sessionId: "sess-1",
      objective: request.content,
      autonomous,
      payload,
    }),
  );
  const run = {
    runId,
    workflowKey: "chat.turn.execute",
    status: "completed",
    attemptCount: 1,
    maxAttempts: 3,
    version: 8,
    payload,
    metadata: {
      objective: request.content,
      autonomous,
      autonomousAdmission,
      [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: rawOutput,
      [HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]: decision.receipt,
      [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: authority,
      outputText: content,
      outputSummary: content,
      finalOutput: content,
      finalSummary: content,
    },
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:01:00.000Z",
    finishedAt: "2026-07-15T10:01:00.000Z",
  } satisfies DurableRunRecord;
  const checkpoint = {
    checkpointId: "checkpoint-heartbeat-1",
    runId,
    checkpointKind: "run_completed",
    state: {
      [CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]: authority,
      [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: rawOutput,
      [HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]: decision.receipt,
      assistantMessageId,
      outputText: content,
      outputSummary: content,
    },
    createdAt: "2026-07-15T10:01:00.000Z",
  } satisfies DurableCheckpointRecord;
  const occurrence: HeartbeatOccurrenceRecord = {
    occurrenceId,
    workspaceId: payload.workspaceId,
    sessionId: payload.sessionId,
    sessionIncarnationId: payload.sessionIncarnationId,
    admissionId: payload.admissionId,
    admissionRequestSha256: "d".repeat(64),
    admissionIdempotencyKey: "heartbeat-idempotency-1",
    admissionCorrelationId: occurrenceId,
    runtimeOwnerId: "gateway-runtime-owner",
    systemActorId: "system-heartbeat",
    admissionMaterialSha256: payload.admissionMaterialSha256,
    evaluatedPolicySha256: payload.heartbeatEvaluatedPolicySha256,
    frozenRequestSha256: "e".repeat(64),
    frozenObjectiveSha256: payload.heartbeatFrozenObjectiveSha256,
    claimSha256,
    aggregateRevision: payload.admissionAggregateRevision,
    controllerGeneration: payload.admissionControllerGeneration,
    priorCadence: {},
    heartbeatIntervalSeconds: 300,
    cooldownSeconds: 60,
    idleFloorSeconds: 30,
    observedSessionActivityAt: "2026-07-15T09:55:00.000Z",
    state: "terminal",
    revision: 3,
    claimedAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:01:00.000Z",
    boundDurableRunId: runId,
    durableBoundAt: "2026-07-15T10:00:01.000Z",
    terminalAt: "2026-07-15T10:01:00.000Z",
    terminalStatus: "completed",
    terminalHandoffSha256: "f".repeat(64),
    userMessageId,
    assistantMessageId,
    turnId,
    durableRunId: runId,
  };
  const terminalHandoff: VerifiedTerminalTurnWriteHandoff = {
    durableRunStatus: "completed",
    traceStatus: "completed",
    handoffSha256: occurrence.terminalHandoffSha256!,
  };
  const trace = createTrace({
    turnId,
    userMessageId,
    assistantMessageId,
    completion: { status: "complete", repaired: false },
    finishedAt: "2026-07-15T10:01:00.000Z",
    durable: { runId, status: "completed", checkpointKind: "run_completed" },
  });
  const message: ChatMessageRecord = {
    messageId: assistantMessageId,
    sessionId: "sess-1",
    role: "assistant",
    actorType: "system",
    actorId: "system-heartbeat",
    content,
    timestamp: "2026-07-15T10:01:00.000Z",
  };
  return { run, checkpoint, occurrence, terminalHandoff, trace, message };
}

function createThreadState(): ChatTurnSessionState {
  const root = createTrace({
    turnId: "turn-root",
    startedAt: "2026-03-22T12:00:00.000Z",
    userMessageId: "user-root",
    assistantMessageId: "assistant-root",
  });
  const childA = createTrace({
    turnId: "turn-child-a",
    parentTurnId: "turn-root",
    startedAt: "2026-03-22T12:01:00.000Z",
    userMessageId: "user-a",
    assistantMessageId: "assistant-a",
  });
  const childB = createTrace({
    turnId: "turn-child-b",
    parentTurnId: "turn-root",
    startedAt: "2026-03-22T12:02:00.000Z",
    userMessageId: "user-b",
    assistantMessageId: "assistant-b",
  });
  return {
    session: { sessionId: "sess-1" },
    activeLeafTurnId: "turn-child-a",
    traces: [root, childA, childB],
    childrenByTurnId: new Map([["turn-root", ["turn-child-a", "turn-child-b"]]]),
    messagesById: new Map(
      ["user-root", "assistant-root", "user-a", "assistant-a", "user-b", "assistant-b"].map((messageId) => [
        messageId,
        {
          messageId,
          sessionId: "sess-1",
          role: messageId.startsWith("user") ? "user" : "assistant",
          content: messageId,
          timestamp: "2026-03-22T12:00:00.000Z",
        },
      ]),
    ),
  } as ChatTurnSessionState;
}

function createTrace(overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "sess-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    status: "completed",
    mode: "chat",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    effectiveToolAutonomy: "safe_auto",
    routing: { liveDataIntent: false },
    toolRuns: [],
    citations: [],
    startedAt: "2026-03-22T12:00:00.000Z",
    updatedAt: "2026-03-22T12:00:00.000Z",
    ...overrides,
  } as ChatTurnTraceRecord;
}

function createDurableRun(runId: string, status: string): DurableRunRecord {
  const request = { content: "continue" };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  return {
    runId,
    workflowKey: "chat.turn.execute",
    status,
    version: 3,
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: "admission-1",
      sessionIncarnationId: "incarnation-1",
      admissionMaterialSha256,
      workspaceId: "workspace-1",
      admissionAggregateRevision: 7,
      admissionControllerGeneration: 3,
      effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
      policyRunIdDerivation: {
        version: 1,
        kind: "durable_run_id",
        runId,
      },
      requestActor: {
        actorKind: "operator",
        actorId: TEST_RESPONDER.actorId,
        authActorId: TEST_RESPONDER.actorId,
        authActorSource: "token",
      },
      sessionId: "sess-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request,
    },
  } as DurableRunRecord;
}
