import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChatApprovalMode, updateChatApprovalMode } from "./chat-approval-mode-service.js";
import { agentSendChatMessage, agentSendChatMessageStream, type ChatTurnEntryHost } from "./chat-turn-entry-service.js";
import { getSessionControlRuntimeOwner } from "./session-control-runtime-owner.js";
import { createAuthenticatedOperatorAdmissionContext } from "./session-control-service.js";

describe("Chat turn authenticated heartbeat preemption seam", () => {
  it("refuses a streamed Auto turn when its binding switches to an integration after admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "goatcitadel-auto-stream-binding-"));
    const raw = new Storage({
      dbPath: ":memory:",
      transcriptsDir: join(root, "transcripts"),
      auditDir: join(root, "audit"),
    });
    const sessionId = "auto-stream-session";
    const workspaceId = "default";
    try {
      raw.sessions.upsert({
        sessionId,
        sessionKey: "mission:operator:auto-stream",
        channel: "mission",
        account: "operator",
        kind: "dm",
        timestamp: new Date().toISOString(),
      });
      raw.chatSessionMeta.ensure(sessionId, undefined, workspaceId);
      raw.chatSessionProjects.assign(
        sessionId,
        raw.chatProjects.create({ workspaceId, name: "Auto", workspacePath: "project" }).projectId,
      );
      raw.chatSessionBindings.upsert({ sessionId, workspaceId, transport: "llm", writable: true });
      const storage = createSqliteAsyncStorage(raw);
      const deps = { storage, chatAutoApprovalEnabled: true };
      await updateChatApprovalMode(deps, sessionId, {
        mode: "auto",
        expectedModeRevision: (await getChatApprovalMode(deps, sessionId)).modeRevision,
      });
      const owner = getSessionControlRuntimeOwner(storage, {
        chatAutoApprovalEnabled: true,
        isDurableAvailable: async () => true,
        unavailableMessage: "Auto requires durable Chat execution.",
      });
      const admit = owner.admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery.bind(owner);
      const switchBinding = vi
        .spyOn(owner, "admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery")
        .mockImplementation(async (...args) => {
          const admitted = await admit(...args);
          expect(admitted.chatApprovalAuthority?.mode).toBe("auto");
          await storage.chatSessionBindings.upsert({
            sessionId,
            workspaceId,
            transport: "integration",
            writable: true,
          });
          return admitted;
        });
      const prepareAgentChatTurn = vi.fn();
      const host = {
        ...buildAdmissionOnlyHost(vi.fn()),
        storage,
        sessionControlRuntimeOwner: owner,
        prepareAgentChatTurn,
      } as unknown as ChatTurnEntryHost;
      const authenticatedOperator = createAuthenticatedOperatorAdmissionContext({
        actorId: "operator-http",
        authActorSource: "loopback",
        directLocal: true,
      });
      const request = {
        content: "operator work",
        operatorId: "operator-http",
        authActorId: "operator-http",
        authActorSource: "loopback" as const,
      };
      await expect(
        consume(agentSendChatMessageStream(host, sessionId, request, { authenticatedOperator })),
      ).rejects.toThrow(/Auto requires a local LLM Chat binding/);
      expect(switchBinding).toHaveBeenCalledOnce();
      expect(prepareAgentChatTurn).not.toHaveBeenCalled();
      expect(raw.sessionMutationAdmissions.listActive(workspaceId, sessionId)).toEqual([]);
    } finally {
      raw.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["buffered", "streamed"] as const)(
    "rejects %s Auto sends before durable-disabled admission",
    async (variant) => {
      const root = mkdtempSync(join(tmpdir(), "goatcitadel-auto-entry-"));
      const raw = new Storage({
        dbPath: ":memory:",
        transcriptsDir: join(root, "transcripts"),
        auditDir: join(root, "audit"),
      });
      const sessionId = "session-1";
      try {
        raw.sessions.upsert({
          sessionId,
          sessionKey: "mission:operator:auto",
          channel: "mission",
          account: "operator",
          kind: "dm",
          timestamp: new Date().toISOString(),
        });
        raw.chatSessionMeta.ensure(sessionId, undefined, "default");
        raw.chatSessionProjects.assign(
          sessionId,
          raw.chatProjects.create({ workspaceId: "default", name: "Auto", workspacePath: "project" }).projectId,
        );
        const storage = createSqliteAsyncStorage(raw);
        const deps = { storage, chatAutoApprovalEnabled: true };
        await updateChatApprovalMode(deps, sessionId, {
          mode: "auto",
          expectedModeRevision: (await getChatApprovalMode(deps, sessionId)).modeRevision,
        });
        const host = {
          ...buildAdmissionOnlyHost(vi.fn()),
          sessionControlRuntimeOwner: getSessionControlRuntimeOwner(storage, {
            chatAutoApprovalEnabled: true,
            isDurableAvailable: async () => false,
            unavailableMessage: "Auto requires durable Chat execution.",
          }),
          prepareAgentChatTurn: vi.fn(),
        } as unknown as ChatTurnEntryHost;
        const authenticatedOperator = createAuthenticatedOperatorAdmissionContext({
          actorId: "operator-http",
          authActorSource: "loopback",
          directLocal: true,
        });
        const request = {
          content: "operator work",
          operatorId: "operator-http",
          authActorId: "operator-http",
          authActorSource: "loopback" as const,
        };
        const operation =
          variant === "buffered"
            ? agentSendChatMessage(host, sessionId, request, { authenticatedOperator })
            : consume(agentSendChatMessageStream(host, sessionId, request, { authenticatedOperator }));
        await expect(operation).rejects.toThrow(/Auto requires durable/);
        expect(raw.sessionMutationAdmissions.listActive("default", sessionId)).toEqual([]);
        expect(host.prepareAgentChatTurn).not.toHaveBeenCalled();
      } finally {
        raw.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps an internal caller on the ordinary conflict path with no preemption authority", async () => {
    const conflict = new ConflictError({ message: "an active heartbeat owns the turn" });
    const admitOperatorChatTurn = vi.fn(() => {
      throw conflict;
    });
    const host = buildAdmissionOnlyHost(admitOperatorChatTurn);

    await expect(
      agentSendChatMessage(host, "session-1", {
        content: "internal work",
        operatorId: "operator-internal",
      }),
    ).rejects.toBe(conflict);

    expect(admitOperatorChatTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ authenticatedOperator: expect.anything() }),
    );
  });

  it("passes the separate authenticated route context to append and stream admission", async () => {
    const stopAfterAdmission = new Error("stop after admission capture");
    const admitOperatorChatTurn = vi.fn(() => {
      throw stopAfterAdmission;
    });
    const host = buildAdmissionOnlyHost(admitOperatorChatTurn);
    const authenticatedOperator = createAuthenticatedOperatorAdmissionContext({
      actorId: "operator-http",
      authActorSource: "loopback",
    });
    const request = {
      content: "operator work",
      operatorId: "operator-http",
      authActorId: "operator-http",
      authActorSource: "loopback" as const,
    };

    await expect(agentSendChatMessage(host, "session-1", request, { authenticatedOperator })).rejects.toBe(
      stopAfterAdmission,
    );
    await expect(
      consume(agentSendChatMessageStream(host, "session-1", request, { authenticatedOperator })),
    ).rejects.toBe(stopAfterAdmission);

    expect(admitOperatorChatTurn).toHaveBeenCalledTimes(2);
    for (const [input] of admitOperatorChatTurn.mock.calls) {
      expect(input).toMatchObject({
        sessionId: "session-1",
        request,
        actorId: "operator-http",
        authenticatedOperator,
      });
    }
  });
});

function buildAdmissionOnlyHost(admitOperatorChatTurn: ReturnType<typeof vi.fn>): ChatTurnEntryHost {
  return {
    withChatTurnWriteLease: async (_sessionId: string, _owner: string, operation: () => Promise<unknown>) =>
      operation(),
    withChatTurnWriteLeaseStream: (_sessionId: string, _owner: string, operation: () => AsyncGenerator<unknown>) =>
      operation(),
    sessionControlRuntimeOwner: {
      admitOperatorChatTurn,
      admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery: async (input: unknown) => admitOperatorChatTurn(input),
    },
    recoverDecisionCommittedHeartbeat: vi.fn(async () => undefined),
  } as unknown as ChatTurnEntryHost;
}

async function consume(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Admission throws before the first chunk; consuming drives that branch.
  }
}
