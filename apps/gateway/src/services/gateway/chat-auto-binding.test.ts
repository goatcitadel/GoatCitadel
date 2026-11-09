import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDurableChatTurnExecutionPayloadAuthority, type ChatSendMessageRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyHeaderPlugin } from "../../plugins/idempotency.js";
import { registerChatSessionRoutes } from "../../routes/chat.sessions.js";
import {
  getChatApprovalMode,
  isChatAutoApprovalEnabled,
  readChatApprovalAdmission,
  updateChatApprovalMode,
  withCurrentChatApprovalAuthority,
} from "../chat-session-service.js";
import {
  computeChatTurnAdmissionMaterialSha256,
  createAuthenticatedOperatorAdmissionContext,
  SessionControlService,
} from "../session-control-service.js";
import { createDurableChatTurnPayload } from "./durable-chat-turn-payload.js";

const sessionId = "session-1";
const workspaceId = "default";
const operatorId = "token:test-fixture";
const admissionRequest = {
  content: "Create a file",
  operatorId,
  authActorId: operatorId,
  authActorSource: "token",
} as const;
const localAdmissionInput = {
  sessionId,
  turnId: "turn-1",
  request: admissionRequest,
  runtimeOwnerId: "runtime-1",
  actorId: operatorId,
  idempotencyKey: "admission-1",
  correlationId: "turn-1",
  authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
    actorId: operatorId,
    authActorSource: "token",
    directLocal: true,
  }),
};
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "goatcitadel-chat-auto-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: join(root, "transcripts"),
    auditDir: join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  storage.sessions.upsert({
    sessionId,
    sessionKey: "mission:operator:session-1",
    channel: "mission",
    account: "operator",
    kind: "dm",
    timestamp: "2026-11-08T00:00:00.000Z",
  });
  storage.chatSessionMeta.ensure(sessionId, undefined, workspaceId);
  const { projectId } = storage.chatProjects.create({ workspaceId, name: "Project one", workspacePath: "project-one" });
  const { projectId: otherProjectId } = storage.chatProjects.create({
    workspaceId,
    name: "Project two",
    workspacePath: "project-two",
  });
  storage.chatSessionProjects.assign(sessionId, projectId);
  const asyncStorage = createSqliteAsyncStorage(storage);
  return {
    storage,
    projectId,
    otherProjectId,
    deps: { storage: asyncStorage, chatAutoApprovalEnabled: isChatAutoApprovalEnabled(asyncStorage) },
  };
}

function turnScope(storage: Storage) {
  return { sessionId, workspaceId, admissionAggregateRevision: storage.chatSessionMeta.get(sessionId)!.revision };
}

async function setMode(deps: ReturnType<typeof setup>["deps"], mode: "standard" | "auto") {
  const { modeRevision } = await getChatApprovalMode(deps, sessionId);
  return await updateChatApprovalMode(deps, sessionId, { mode, expectedModeRevision: modeRevision });
}

describe("durable Chat approval authority", () => {
  it.each([true, false])(
    "compares a conditional send to the live mode with the release gate set to %s",
    async (enabled) => {
      const { deps, storage } = setup();
      const stale = await setMode(deps, "auto");
      const current = await setMode(deps, "standard");
      const service = new SessionControlService(
        deps.storage,
        (id, workspace, expected) =>
          readChatApprovalAdmission({ ...deps, chatAutoApprovalEnabled: enabled }, id, workspace, true, expected),
        enabled,
      );
      const request = { ...admissionRequest, expectedChatApprovalModeRevision: stale.modeRevision };
      await expect(service.admitOperatorChatTurn({ ...localAdmissionInput, request })).rejects.toMatchObject({
        httpStatus: 409,
        details: { reason: "chat_approval_mode_changed" },
      });
      expect(storage.sessionMutationAdmissions.listActive(workspaceId, sessionId)).toEqual([]);
      const admitted = await service.admitOperatorChatTurn({
        ...localAdmissionInput,
        request: { ...request, expectedChatApprovalModeRevision: current.modeRevision },
      });
      expect(admitted.chatApprovalAuthority?.mode).toBe(enabled ? "standard" : undefined);
      expect(admitted.admittedRequest).not.toHaveProperty("expectedChatApprovalModeRevision");
      expect(await service.admitOperatorChatTurn(localAdmissionInput)).toEqual(admitted);
    },
  );

  it("keeps historical payloads on the standard path", async () => {
    const { deps, storage } = setup();
    await expect(
      withCurrentChatApprovalAuthority(deps, turnScope(storage), async (authority) => authority),
    ).resolves.toMatchObject({ status: "current", value: { mode: "standard" } });
  });

  it("does not stamp a parked Standard admission with Auto on replay across a mode change", async () => {
    const { deps } = setup();
    let changeBeforeSample = false;
    const service = new SessionControlService(deps.storage, async (id, workspace) => {
      if (changeBeforeSample) await setMode(deps, "auto");
      return await readChatApprovalAdmission(deps, id, workspace, true);
    });
    const admitted = await service.admitOperatorChatTurn(localAdmissionInput);
    expect(admitted.chatApprovalAuthority?.mode).toBe("standard");
    changeBeforeSample = true;
    await expect(service.admitOperatorChatTurn(localAdmissionInput)).rejects.toThrow(/replay|revision/i);
  });

  it("requires the original server stamp at durable bind", async () => {
    const { deps, storage } = setup();
    await setMode(deps, "auto");
    const service = new SessionControlService(deps.storage, (id, workspace) =>
      readChatApprovalAdmission(deps, id, workspace, true),
    );
    const admitted = await service.admitOperatorChatTurn(localAdmissionInput);
    const exactReplay = await service.admitOperatorChatTurn(localAdmissionInput);
    expect(exactReplay.chatApprovalAuthority).toEqual(admitted.chatApprovalAuthority);
    await expect(
      service.admitOperatorChatTurn({
        ...localAdmissionInput,
        authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
          actorId: operatorId,
          authActorSource: "token",
        }),
      }),
    ).rejects.toThrow(/replay|authority/i);
    const payload = createDurableChatTurnPayload(
      {
        turnId: "turn-1",
        userEventId: "user-1",
        assistantMessageId: "assistant-1",
        branchKind: "append",
        session: { sessionId },
        turnAdmission: { ...admitted, chatApprovalAuthority: undefined },
      } as Parameters<typeof createDurableChatTurnPayload>[0],
      admissionRequest,
      "chat_thread_turn_appended",
      "run-without-stamp",
    );
    storage.durableRuns.createRun({
      runId: "run-without-stamp",
      workflowKey: "chat.turn.execute",
      payload: { ...payload },
    });
    await expect(service.bindDurableRun(admitted, "run-without-stamp")).rejects.toThrow(/authority|conflicts/i);
  });

  it.each(["toggle", "reassign"] as const)(
    "keeps old unstamped turns stale after %s and permits fresh Standard",
    async (change) => {
      const { deps, storage, projectId, otherProjectId } = setup();
      const parked = turnScope(storage);
      if (change === "toggle") {
        await setMode(deps, "auto");
        await setMode(deps, "standard");
      } else {
        await deps.storage.chatSessionProjects.assign(sessionId, otherProjectId);
        await deps.storage.chatSessionProjects.assign(sessionId, projectId);
      }
      await expect(
        withCurrentChatApprovalAuthority(deps, parked, async () => {
          throw new Error("old unstamped turn ran a side effect");
        }),
      ).resolves.toMatchObject({ status: "stale" });
      await expect(
        withCurrentChatApprovalAuthority(deps, turnScope(storage), async (authority) => authority),
      ).resolves.toEqual({ status: "current", value: { mode: "standard" } });
    },
  );

  it("takes no binding from caller-supplied request fields", () => {
    const suppliedBinding = { sessionId, workspaceId, projectId: "forged-project", modeRevision: "forged" };
    const request = {
      content: "Create a file",
      chatAutoBinding: suppliedBinding,
      chatApprovalAuthority: { version: 1, mode: "auto", binding: suppliedBinding },
    } as ChatSendMessageRequest;
    const prepared = {
      turnId: "turn-1",
      userEventId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "append",
      session: { sessionId },
      turnAdmission: {
        identity: {
          admissionId: "admission-1",
          sessionIncarnationId: "incarnation-1",
          workspaceId,
          materialSha256: computeChatTurnAdmissionMaterialSha256({ content: request.content }),
          aggregateRevision: 1,
          controllerGeneration: 1,
        },
        admittedRequest: { content: request.content },
        requestActor: { actorKind: "operator", actorId: "operator-1" },
      },
    } as Parameters<typeof createDurableChatTurnPayload>[0];
    const payload = createDurableChatTurnPayload(prepared, request, "chat_thread_turn_appended", "run-1");
    expect(payload.chatApprovalAuthority).toBeUndefined();
    expect(payload.request).toEqual({ content: request.content });
  });

  it.each(["local", "remote", "delegated"] as const)("uses the canonical %s admission provenance", async (source) => {
    const { deps, projectId, storage } = setup();
    const mode = await setMode(deps, "auto");
    const service = new SessionControlService(deps.storage, (id, workspace) =>
      readChatApprovalAdmission(deps, id, workspace, true),
    );
    const actorId = "token:test-fixture";
    const request = {
      content: "Create a file",
      operatorId: actorId,
      authActorId: actorId,
      authActorSource: "token",
    } as const;
    const admitted = await service.admitOperatorChatTurn({
      sessionId,
      turnId: "turn-1",
      request,
      runtimeOwnerId: "runtime-1",
      actorId,
      idempotencyKey: "admission-1",
      correlationId: "turn-1",
      ...(source === "delegated"
        ? {}
        : {
            authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
              actorId,
              authActorSource: "token",
              directLocal: source === "local",
            }),
          }),
    });
    if (source !== "local") {
      expect(admitted.chatApprovalAuthority).toBeUndefined();
      return;
    }
    const payload = createDurableChatTurnPayload(
      {
        turnId: "turn-1",
        userEventId: "user-1",
        assistantMessageId: "assistant-1",
        branchKind: "append",
        session: { sessionId },
        turnAdmission: admitted,
      } as Parameters<typeof createDurableChatTurnPayload>[0],
      request,
      "chat_thread_turn_appended",
      "run-1",
    );
    const read = (value: unknown) =>
      readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: "chat.turn.execute",
        durableRunId: "run-1",
        payload: value,
      });
    expect(read(payload)?.chatApprovalAuthority).toEqual({
      version: 1,
      mode: "auto",
      binding: { sessionId, workspaceId, projectId, modeRevision: mode.modeRevision },
    });
    expect(read({ ...payload, chatApprovalAuthority: undefined })).toBeUndefined();
    expect(read({ ...payload, requestActor: { actorKind: "system", actorId: "system" } })).toBeUndefined();
    storage.durableRuns.createRun({ runId: "run-1", workflowKey: "chat.turn.execute", payload: { ...payload } });
    await expect(service.bindDurableRun(admitted, "run-1")).resolves.toBeUndefined();
  });

  it("rejects a parked Auto turn after toggling back to the same mode", async () => {
    const { deps, storage } = setup();
    await setMode(deps, "auto");
    const chatApprovalAuthority = await readChatApprovalAdmission(deps, sessionId, workspaceId, true);
    const parked = { ...turnScope(storage), chatApprovalAuthority };
    await setMode(deps, "standard");
    await setMode(deps, "auto");
    await expect(
      withCurrentChatApprovalAuthority(deps, parked, async () => {
        throw new Error("stale turn ran an effect");
      }),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it("rejects a parked Auto turn after the project changes", async () => {
    const { deps, storage, projectId, otherProjectId } = setup();
    await setMode(deps, "auto");
    const chatApprovalAuthority = await readChatApprovalAdmission(deps, sessionId, workspaceId, true);
    const parked = { ...turnScope(storage), chatApprovalAuthority };
    storage.chatSessionProjects.assign(sessionId, otherProjectId);
    await expect(
      withCurrentChatApprovalAuthority(deps, parked, async () => {
        throw new Error("stale turn ran an effect");
      }),
    ).resolves.toMatchObject({ status: "stale" });
    storage.chatSessionProjects.assign(sessionId, projectId);
    await expect(getChatApprovalMode(deps, sessionId)).resolves.toMatchObject({ mode: "standard", projectId });
    await expect(
      withCurrentChatApprovalAuthority(deps, parked, async () => {
        throw new Error("a former project binding ran an effect");
      }),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it("rejects old standard turns after Auto is enabled", async () => {
    const { deps, storage } = setup();
    const parked = turnScope(storage);
    const chatApprovalAuthority = await readChatApprovalAdmission(deps, sessionId, workspaceId, true);
    await setMode(deps, "auto");
    for (const authority of [undefined, chatApprovalAuthority]) {
      await expect(
        withCurrentChatApprovalAuthority(deps, { ...parked, chatApprovalAuthority: authority }, async () => {
          throw new Error("standard turn ran an effect in Auto");
        }),
      ).resolves.toMatchObject({ status: "stale" });
    }
  });

  it("rejects stale mode updates and keeps the release gate closed by default", async () => {
    const { deps } = setup();
    const { modeRevision } = await getChatApprovalMode(deps, sessionId);
    await expect(
      updateChatApprovalMode({ storage: deps.storage }, sessionId, {
        mode: "auto",
        expectedModeRevision: modeRevision,
      }),
    ).rejects.toThrow();
    await setMode(deps, "auto");
    await expect(
      updateChatApprovalMode(deps, sessionId, { mode: "standard", expectedModeRevision: modeRevision }),
    ).rejects.toThrow();
  });

  it("restricts mode reads and updates to direct authenticated operators", async () => {
    const { deps } = setup();
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      const authenticated = request.headers.authorization === "Bearer test-fixture";
      request.authActorSource = authenticated ? "token" : "none";
      request.authActorId = authenticated ? "token:test-fixture" : "anonymous";
    });
    app.decorate("services", {
      chatSessions: {
        getChatApprovalMode: (id: string) => getChatApprovalMode(deps, id),
        updateChatApprovalMode: (id: string, input: Parameters<typeof updateChatApprovalMode>[2]) =>
          updateChatApprovalMode(deps, id, input),
      },
    } as never);
    registerChatSessionRoutes(app);
    const url = `/api/v1/chat/sessions/${sessionId}/approval-mode`;
    const headers = { authorization: "Bearer test-fixture" };
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url, headers, remoteAddress: "203.0.113.4" })).statusCode).toBe(403);
      const read = await app.inject({ method: "GET", url, headers });
      expect(read.statusCode).toBe(200);
      const payload = { mode: "auto", expectedModeRevision: read.json().modeRevision };
      expect(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers: { ...headers, forwarded: "" },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers,
            payload: { ...payload, projectId: "caller-selected-project" },
          })
        ).statusCode,
      ).toBe(400);
      expect((await app.inject({ method: "PATCH", url, headers, payload })).json()).toMatchObject({ mode: "auto" });
    } finally {
      await app.close();
    }
  });

  it("awaits the persistent idempotency fence before sending a successful PATCH", async () => {
    const { deps } = setup();
    const app = Fastify();
    const fenceEntered = Promise.withResolvers<void>();
    const releaseFence = Promise.withResolvers<void>();
    let sentBeforeCommit = false;
    let commitSettled = false;
    app.addHook("onRequest", async (request) => {
      request.authActorId = operatorId;
      request.authActorSource = "token";
    });
    app.addHook("onSend", async (_request, reply) => {
      if (reply.statusCode === 200 && !commitSettled) sentBeforeCommit = true;
    });
    const store = deps.storage.mutationIdempotency;
    await app.register(idempotencyHeaderPlugin, {
      mutationStore: {
        claim: (input) => store.claim(input),
        markFailed: (input) => store.markFailed(input),
        markCompleted: async (input) => {
          fenceEntered.resolve();
          await releaseFence.promise;
          const completed = await store.markCompleted(input);
          commitSettled = true;
          return completed;
        },
      },
    });
    app.decorate("services", {
      chatSessions: {
        updateChatApprovalMode: (id: string, input: Parameters<typeof updateChatApprovalMode>[2]) =>
          updateChatApprovalMode(deps, id, input),
      },
    } as never);
    registerChatSessionRoutes(app);
    const { modeRevision } = await getChatApprovalMode(deps, sessionId);
    const request = {
      method: "PATCH",
      url: `/api/v1/chat/sessions/${sessionId}/approval-mode`,
      headers: { "idempotency-key": "mode-patch-key" },
      payload: { mode: "auto", expectedModeRevision: modeRevision },
    } as const;
    const first = app.inject(request);
    try {
      await Promise.race([
        fenceEntered.promise,
        first.then(() => {
          throw new Error("PATCH never reached the persisted idempotency fence");
        }),
      ]);
      const concurrent = await app.inject(request);
      expect(concurrent.statusCode).toBe(409);
      expect(concurrent.json().error).toMatch(/in progress/);
      expect(sentBeforeCommit).toBe(false);
      releaseFence.resolve();
      expect((await first).json()).toMatchObject({ mode: "auto" });
      const replay = await app.inject(request);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toMatch(/duplicate/i);
    } finally {
      releaseFence.resolve();
      await first;
      await app.close();
    }
  });
});
