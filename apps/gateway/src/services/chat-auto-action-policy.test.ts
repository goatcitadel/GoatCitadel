import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ConflictError, type ToolInvokeRequest, type ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChatSessionRoutes } from "../routes/chat.sessions.js";
import { ChatAutoActionPolicy, classifyChatAutoAction, type ResolvedAutoAction } from "./chat-auto-action-policy.js";
import {
  getChatApprovalMode,
  readChatApprovalAdmission,
  updateChatApprovalMode,
} from "./chat-approval-mode-service.js";
import { assertChatAutoCodeModeAllowed } from "./code-mode-request-tool.js";
import {
  createManagedProjectFileOperator,
  inspectManagedProjectFileAvailability,
} from "./chat-managed-project-files.js";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import { createDurableChatTurnPayload } from "./gateway/durable-chat-turn-payload.js";
import {
  RemoteWorkerChatPlacementService,
  type RemoteWorkerChatPlacementDependencies,
} from "./remote-worker-chat-placement-service.js";
import { createAuthenticatedOperatorAdmissionContext, SessionControlService } from "./session-control-service.js";

const action = (toolName: string, overrides: Partial<ResolvedAutoAction> = {}): ResolvedAutoAction => ({
  toolName,
  owner: "builtin",
  ...overrides,
});

describe("Chat Auto action classification", () => {
  it.each(["fs.read", "fs.stat", "fs.list", "file.read_range", "file.find", "code.search", "code.search_files"])(
    "admits the built-in structured read %s",
    (toolName) => expect(classifyChatAutoAction(action(toolName))).toBe("read_only"),
  );

  it.each(["fs.delete", "fs.move", "fs.trash"])("classifies %s as deletion", (toolName) => {
    expect(classifyChatAutoAction(action(toolName))).toBe("delete");
  });

  it.each([
    "shell.exec",
    "shell.exec_background",
    "tests.run",
    "lint.run",
    "build.run",
    "code_mode.request",
    "git.status",
    "git.worktree.remove",
    "agent.fanout",
    "browser.exec",
    "unknown.future_tool",
  ])("blocks %s before approval or execution", (toolName) => {
    expect(classifyChatAutoAction(action(toolName))).toBe("blocked");
  });

  it.each(["wrapper", "external"] as const)("rejects a read label with a %s owner", (owner) => {
    expect(classifyChatAutoAction(action("fs.read", { owner }))).toBe("blocked");
  });

  it("keeps writes and reviewed outbound actions distinct", () => {
    expect(classifyChatAutoAction(action("fs.write"))).toBe("edit");
    expect(classifyChatAutoAction(action("fs.patch"))).toBe("edit");
    expect(classifyChatAutoAction(action("channel.send"))).toBe("review");
  });
});

const sessionId = "auto-test-session";
const workspaceId = "default";
const turnId = "auto-test-turn";
const runId = "auto-test-run";
const operatorId = "token:auto-test";
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function setup(
  options: {
    adapter?: boolean;
    readScopedTarget?: NonNullable<ConstructorParameters<typeof ChatAutoActionPolicy>[0]["readScopedTarget"]>;
    approvalMode?: "approve_all" | "bypass";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "goatcitadel-auto-action-"));
  const project = join(root, "project");
  const file = join(project, "target.ts");
  const protectedFile = join(project, "protected.ts");
  mkdirSync(project);
  writeFileSync(file, "const verifiedSearch = 1;\n");
  writeFileSync(protectedFile, "protected\n");
  const raw = new Storage({
    dbPath: ":memory:",
    transcriptsDir: join(root, "transcripts"),
    auditDir: join(root, "audit"),
  });
  cleanup.push(() => {
    raw.close();
    rmSync(root, { recursive: true, force: true });
  });
  raw.sessions.upsert({
    sessionId,
    sessionKey: "mission:operator:auto-test",
    channel: "mission",
    account: "operator",
    kind: "dm",
    timestamp: new Date().toISOString(),
  });
  raw.chatSessionMeta.ensure(sessionId, undefined, workspaceId);
  const { projectId } = raw.chatProjects.create({ workspaceId, name: "Project", workspacePath: "project" });
  raw.chatSessionProjects.assign(sessionId, projectId);
  const storage = createSqliteAsyncStorage(raw);
  const modeDeps = { storage, chatAutoApprovalEnabled: true };
  async function setMode(mode: "standard" | "auto") {
    const { modeRevision } = await getChatApprovalMode(modeDeps, sessionId);
    await updateChatApprovalMode(modeDeps, sessionId, { mode, expectedModeRevision: modeRevision });
  }
  await setMode("auto");
  const request = {
    content: "Work on the project",
    operatorId,
    authActorId: operatorId,
    authActorSource: "token",
  } as const;
  const admission = new SessionControlService(storage, (id, workspace) =>
    readChatApprovalAdmission(modeDeps, id, workspace, true),
  );
  async function bindTurn(sessionId: string, turnId: string, runId: string) {
    const turnAdmission = await admission.admitOperatorChatTurn({
      sessionId,
      turnId,
      request,
      runtimeOwnerId: "fixture",
      actorId: operatorId,
      idempotencyKey: `auto-action-admit:${turnId}`,
      correlationId: turnId,
      authenticatedOperator: createAuthenticatedOperatorAdmissionContext({
        actorId: operatorId,
        authActorSource: "token",
        directLocal: true,
      }),
    });
    const payload = createDurableChatTurnPayload(
      {
        turnId,
        userEventId: `${turnId}:user`,
        assistantMessageId: `${turnId}:answer`,
        branchKind: "append",
        session: { sessionId },
        turnAdmission,
      } as Parameters<typeof createDurableChatTurnPayload>[0],
      request,
      "chat_thread_turn_appended",
      runId,
    );
    const run = raw.durableRuns.createRun({ runId, workflowKey: "chat.turn.execute", payload: { ...payload } });
    await admission.bindDurableRun(turnAdmission, runId);
    return run;
  }
  const run = await bindTurn(sessionId, turnId, runId);
  const bindStandard = async () => {
    const sessionId = "standard-session",
      turnId = "standard-turn";
    raw.sessions.upsert({
      sessionId,
      sessionKey: "mission:operator:standard-test",
      channel: "mission",
      account: "operator",
      kind: "dm",
      timestamp: new Date().toISOString(),
    });
    raw.chatSessionMeta.ensure(sessionId, undefined, workspaceId);
    raw.chatSessionProjects.assign(sessionId, projectId);
    return { sessionId, turnId, run: await bindTurn(sessionId, turnId, "standard-run") };
  };

  const policyConfig: ToolPolicyConfig = {
    tools: { allow: ["*"], deny: [], approvalMode: options.approvalMode ?? "bypass" },
    agents: {},
    sandbox: {
      writeJailRoots: [project],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
      runtimeWriteProtection: { rootDir: root, protectedPaths: [protectedFile] },
    },
  };
  const deleteExactTarget = vi.fn((target: { path: string; identitySha256: string }) => ({
    path: target.path,
    deleted: true,
  }));
  const auto = new ChatAutoActionPolicy({
    ...modeDeps,
    rootDir: root,
    workspaceDir: ".",
    ...(options.adapter ? { deleteExactTarget } : {}),
    readScopedTarget: options.readScopedTarget,
  });
  const beforeProcessSpawn = vi.fn();
  const runCodeModeRequest = vi.fn();
  const engine = new ToolPolicyEngine(policyConfig, storage, undefined, {
    beforeProcessSpawn,
    runCodeModeRequest,
    resolveExecutionRestriction: (invoke, stage, approvalId) => auto.inspect(invoke, stage, approvalId),
  });
  const invoke = (
    toolName: string,
    args: Record<string, unknown>,
    more: Partial<ToolInvokeRequest> = {},
  ): ToolInvokeRequest => ({
    toolName,
    args,
    agentId: "goatherder",
    workspaceId,
    sessionId,
    turnId,
    toolRunId: "auto-test-tool",
    ...more,
  });
  function approve(approvalId: string) {
    raw.approvals.resolve(approvalId, { decision: "approve", resolvedBy: operatorId });
    raw.approvalEvents.append({
      approvalId,
      eventType: "resolved",
      actorId: operatorId,
      payload: { decision: "approve", outcome: "approved" },
    });
  }
  return {
    raw,
    storage,
    root,
    project,
    file,
    protectedFile,
    engine,
    auto,
    run,
    bindStandard,
    invoke,
    approve,
    setMode,
    policyConfig,
    projectId,
    deleteExactTarget,
    beforeProcessSpawn,
    runCodeModeRequest,
  };
}

describe("Chat Auto durable execution boundary", () => {
  it("creates and edits managed bytes without a default approval, then restores the exact saved edit once", async () => {
    const { storage, engine, invoke, projectId, project } = await setup({ approvalMode: "approve_all" });
    const path = "notes.md";
    const create = invoke(
      "project.files.save",
      { path, expectedRevision: null, text: "first\r\n" },
      { toolRunId: "managed-create" },
    );
    const created = await engine.invoke(create);
    expect(created).toMatchObject({
      outcome: "executed",
      result: { kind: "managed_project_file", path, canRestore: false },
    });
    expect(await engine.invoke(create)).toMatchObject({ outcome: "executed", result: { replayed: true } });
    expect(await engine.invoke(invoke("project.files.read", { path }))).toMatchObject({
      outcome: "executed",
      result: { text: "first\r\n" },
    });
    const edit = await engine.invoke(
      invoke(
        "project.files.save",
        {
          path,
          expectedRevision: created.result?.revisionId,
          text: "second\n",
        },
        { toolRunId: "managed-edit" },
      ),
    );
    expect(edit).toMatchObject({
      outcome: "executed",
      result: { previousRevisionId: created.result?.revisionId, canRestore: true },
    });
    expect(() => readFileSync(join(project, path))).toThrow();

    const deps = { storage, chatAutoApprovalEnabled: true, checkPolicy: vi.fn(async () => {}) };
    const operator = createManagedProjectFileOperator(deps);
    const { modeRevision } = await getChatApprovalMode(deps, sessionId);
    const input = { path, expectedRevision: String(edit.result?.revisionId), expectedModeRevision: modeRevision };
    const restored = await operator.restore(sessionId, operatorId, input);
    expect(restored).toMatchObject({ canRestore: false, replayed: false, projectId });
    expect(await operator.restore(sessionId, operatorId, input)).toMatchObject({
      revisionId: restored.revisionId,
      replayed: true,
    });
    expect((await operator.download(sessionId, operatorId, { path, revisionId: restored.revisionId })).bytes).toEqual(
      Buffer.from("first\r\n"),
    );
    await expect(
      operator.download(sessionId, operatorId, { path, revisionId: input.expectedRevision }),
    ).rejects.toThrow(/changed/u);
  });

  it("requires exact operator approval before a managed tombstone and blocks a stale replay", async () => {
    const { raw, engine, invoke, approve, projectId } = await setup();
    const path = "notes.md";
    const scope = { workspaceId, projectId, path };
    const saved = raw.managedProjectFiles.save({
      ...scope,
      expectedRevision: null,
      effectId: "fixture-save",
      contentBase64: "b25l",
    });
    const stale = await engine.invoke(
      invoke("project.files.delete", { path, expectedRevision: saved.revisionId }, { toolRunId: "old-delete" }),
    );
    expect(stale.outcome).toBe("approval_required");
    expect(raw.managedProjectFiles.read(scope)?.deleted).toBe(false);
    const edited = raw.managedProjectFiles.save({
      ...scope,
      expectedRevision: saved.revisionId,
      effectId: "fixture-edit",
      contentBase64: "dHdv",
    });
    approve(stale.approvalId!);
    expect((await engine.executeApprovedAction(stale.approvalId!))?.outcome).toBe("blocked");
    expect(raw.managedProjectFiles.read(scope)?.revisionId).toBe(edited.revisionId);
    const pending = await engine.invoke(
      invoke("project.files.delete", { path, expectedRevision: edited.revisionId }, { toolRunId: "current-delete" }),
    );
    expect(pending.outcome).toBe("approval_required");
    approve(pending.approvalId!);
    expect(await engine.executeApprovedAction(pending.approvalId!)).toMatchObject({
      outcome: "executed",
      result: { deleted: true },
    });
    expect(await engine.executeApprovedAction(pending.approvalId!)).toBeUndefined();
    expect(raw.managedProjectFiles.read(scope)?.deleted).toBe(true);
  });

  it("recovers the committed delete receipt after interruption before approval settlement", async () => {
    const { raw, engine, invoke, approve, projectId, setMode } = await setup();
    const path = "delete-after-commit.md";
    const scope = { workspaceId, projectId, path };
    const saved = raw.managedProjectFiles.save({
      ...scope,
      expectedRevision: null,
      effectId: "fixture-save",
      contentBase64: "b25l",
    });
    const pending = await engine.invoke(invoke("project.files.delete", { path, expectedRevision: saved.revisionId }));
    expect(pending.outcome).toBe("approval_required");
    approve(pending.approvalId!);
    const committed = await engine.executeApprovedAction(pending.approvalId!, undefined, { deferResolution: true });
    expect(committed).toMatchObject({ outcome: "executed", result: { deleted: true, replayed: false } });
    expect(raw.pendingApprovalActions.find(pending.approvalId!)?.resolutionStatus).toBe("pending");
    // A mode change prevents new effects. It does not erase the committed outcome.
    await setMode("standard");
    const recovered = await engine.executeApprovedAction(pending.approvalId!);
    expect(recovered).toMatchObject({
      outcome: "executed",
      result: { deleted: true, revisionId: committed?.result?.revisionId, replayed: true },
    });
    expect(raw.managedProjectFiles.read(scope)?.revisionId).toBe(committed?.result?.revisionId);
    expect(raw.pendingApprovalActions.find(pending.approvalId!)?.resolutionStatus).toBe("executed");
  });

  it.each([
    (root: string) => ({ allowedPaths: [root] }),
    (root: string) => ({ referenceRoots: [{ label: "host", rootPath: root, access: "read_only" as const }] }),
  ])("rejects host path grants even for a no-prefix managed list", async (constraints) => {
    const { raw, root, policyConfig, engine, invoke } = await setup();
    policyConfig.tools.allow = [];
    raw.toolGrants.create({
      toolPattern: "project.files.list",
      decision: "allow",
      scope: "session",
      scopeRef: sessionId,
      grantType: "persistent",
      constraints: constraints(root),
      createdBy: operatorId,
    });
    expect(await engine.invoke(invoke("project.files.list", {}))).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("Host path constraints"),
    });
  });

  it("keeps managed content out of audit and refuses a redaction Ward added just before reserve", async () => {
    const { raw, storage, engine, invoke } = await setup();
    const path = "private-work.md";
    const text = "unique retained file data";
    const saved = await engine.invoke(invoke("project.files.save", { path, expectedRevision: null, text }));
    expect(saved.outcome).toBe("executed");
    expect(saved.internalCall?.args).toEqual({ path, expectedRevision: null });
    const read = invoke("project.files.read", { path }, { citadelId: "personal" });
    const visible = await engine.invoke(read);
    expect(visible.result).toMatchObject({ text });
    expect(visible.internalResult?.result).not.toHaveProperty("text");
    const blocked = await engine.invoke(read, {
      beforeExecute: async () => {
        raw.citadels.addWard({
          citadelId: "personal",
          name: "Limit managed reads",
          actionPattern: read.toolName,
          effect: "redact",
        });
      },
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.result?.text).toBeUndefined();
    expect(JSON.stringify(await storage.audit.list("tool_invocations"))).not.toContain(text);
    expect(JSON.stringify(raw.db.prepare("SELECT args_json, result_json FROM tool_invocations").all())).not.toContain(
      text,
    );
  });

  it("does not stage managed save text in approvals or pending actions when a Ward requires review", async () => {
    const { raw, engine, invoke } = await setup();
    raw.citadels.addWard({
      citadelId: "personal",
      name: "Require file review",
      actionPattern: "project.files.save",
      effect: "require_approval",
    });
    const text = "managed text that must not enter pending approval";
    const blocked = await engine.invoke(
      invoke("project.files.save", { path: "file.txt", expectedRevision: null, text }, { citadelId: "personal" }),
    );
    expect(blocked).toMatchObject({ outcome: "blocked" });
    expect(blocked.approvalId).toBeUndefined();
    expect(JSON.stringify(raw.db.prepare("SELECT args_json, result_json FROM tool_invocations").all())).not.toContain(
      text,
    );
  });

  it("keeps managed operations behind current Auto authority and tool deny rules", async () => {
    const { raw, storage, auto, engine, invoke, bindStandard, setMode, policyConfig, projectId } = await setup();
    const request = invoke("project.files.save", { path: "notes.md", expectedRevision: null, text: "safe" });
    const denyEngine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, deny: ["project.files.save"] } },
      storage,
      undefined,
      {
        resolveExecutionRestriction: (invoke, stage, approvalId) => auto.inspect(invoke, stage, approvalId),
      },
    );
    expect((await denyEngine.invoke(request)).outcome).toBe("blocked");
    const standard = await bindStandard();
    expect((await engine.invoke({ ...request, sessionId: standard.sessionId, turnId: standard.turnId })).outcome).toBe(
      "blocked",
    );
    await setMode("standard");
    expect((await engine.invoke(request)).outcome).toBe("blocked");
    expect(raw.managedProjectFiles.list({ workspaceId, projectId })).toEqual([]);
  });

  it("advertises managed tools only for the current Auto workspace without weakening policy", async () => {
    const { storage, engine, invoke, bindStandard } = await setup({ approvalMode: "approve_all" });
    const standard = await bindStandard();
    const deps = { storage, chatAutoApprovalEnabled: true };
    const probe = async (request: ToolInvokeRequest, enabled = true) =>
      inspectManagedProjectFileAvailability({ ...deps, chatAutoApprovalEnabled: enabled }, request, () =>
        engine.inspectManagedProjectFileAccess(request),
      );
    const save = invoke("project.files.save", {});
    expect(await probe(save)).toMatchObject({ allowed: true, requiresApproval: false });
    expect(await probe(invoke("project.files.delete", {}))).toMatchObject({ allowed: true, requiresApproval: true });
    expect(await probe({ ...save, ...standard })).toMatchObject({ allowed: false });
    expect(await probe({ ...save, workspaceId: "foreign" })).toMatchObject({ allowed: false });
    expect(await probe(save, false)).toMatchObject({ allowed: false });
  });

  it("scopes managed list, download, and restore to local operators and their active project", async () => {
    const { raw, storage, projectId } = await setup();
    const path = "z-managed/example.html";
    const scope = { workspaceId, projectId, path };
    const first = raw.managedProjectFiles.save({
      ...scope,
      expectedRevision: null,
      effectId: "first-save",
      contentBase64: "AA0K/w==",
    });
    const second = raw.managedProjectFiles.save({
      ...scope,
      expectedRevision: first.revisionId,
      effectId: "second-save",
      contentBase64: "eA==",
    });
    for (let index = 0; index < 200; index++) {
      raw.managedProjectFiles.save({
        ...scope,
        path: `earlier/file-${index}.txt`,
        expectedRevision: null,
        effectId: `list-file-${index}`,
        contentBase64: "",
      });
    }
    const otherProject = raw.chatProjects.create({ workspaceId, name: "Another project", workspacePath: "another" });
    raw.managedProjectFiles.save({
      ...scope,
      projectId: otherProject.projectId,
      path: "z-managed/foreign.html",
      expectedRevision: null,
      effectId: "other-project-save",
      contentBase64: "",
    });
    const deps = { storage, chatAutoApprovalEnabled: true, checkPolicy: vi.fn(async () => {}) };
    const { modeRevision } = await getChatApprovalMode(deps, sessionId);
    const operator = createManagedProjectFileOperator(deps);
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.authActorSource = request.headers.authorization ? "token" : "none";
      request.authActorId = request.headers.authorization ? operatorId : "anonymous";
    });
    app.decorate("services", {
      chatSessions: {
        listManagedProjectFiles: operator.list,
        downloadManagedProjectFile: operator.download,
        restoreManagedProjectFile: operator.restore,
      },
    } as never);
    registerChatSessionRoutes(app);
    const url = `/api/v1/chat/sessions/${sessionId}/managed-files`;
    const headers = { authorization: "Bearer fixture" };
    const payload = { path, expectedRevision: second.revisionId, expectedModeRevision: modeRevision };
    try {
      expect((await app.inject({ url })).statusCode).toBe(403);
      expect((await app.inject({ url, headers: { ...headers, forwarded: "for=192.0.2.1" } })).statusCode).toBe(403);
      const initial = (await app.inject({ url, headers })).json().items as { path: string }[];
      expect(initial).toHaveLength(200);
      expect(initial.map((file) => file.path)).not.toContain(path);
      for (const prefix of ["Z-Managed", path]) {
        const scoped = await app.inject({ url: `${url}?prefix=${encodeURIComponent(prefix)}`, headers });
        expect(scoped.statusCode).toBe(200);
        expect(scoped.json().items).toMatchObject([{ path, projectId, workspaceId }]);
        expect(deps.checkPolicy).toHaveBeenLastCalledWith(
          sessionId,
          { workspaceId, projectId },
          operatorId,
          "project.files.list",
          { prefix },
        );
      }
      expect((await app.inject({ url: `${url}?prefix=../z-managed`, headers })).statusCode).toBe(400);
      expect(
        (await app.inject({ url: `${url}?prefix=z-managed&projectId=${otherProject.projectId}`, headers })).statusCode,
      ).toBe(400);
      deps.checkPolicy.mockRejectedValueOnce(
        new ConflictError({ message: "Current policy does not allow this operation." }),
      );
      expect((await app.inject({ url: `${url}?prefix=z-managed`, headers })).statusCode).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/restore`,
            headers,
            payload: { ...payload, projectId: "foreign" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/restore`,
            headers,
            payload: { ...payload, expectedModeRevision: "f".repeat(64) },
          })
        ).statusCode,
      ).toBe(409);
      const restored = await app.inject({ method: "POST", url: `${url}/restore`, headers, payload });
      expect(restored.statusCode).toBe(200);
      const download = await app.inject({
        url: `${url}/download?path=${path}&revisionId=${restored.json().revisionId}`,
        headers,
      });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(Buffer.from([0, 13, 10, 255]));
      expect(download.headers).toMatchObject({
        "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      expect(download.headers["content-disposition"]).toMatch(/^attachment; /u);
    } finally {
      await app.close();
    }
  });
  it("claims only local placement and refuses a retained worker assignment for an admitted Auto turn", async () => {
    const { auto, run } = await setup();
    const findTaskBoundChatAssignment = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ assignment: {} });
    const claimLocal = vi.fn(async () => ({ executionKind: "local" }));
    const listExecutionGrants = vi.fn();
    const scheduleTaskBoundChatOffer = vi.fn();
    const placement = new RemoteWorkerChatPlacementService({
      storage: {
        chatExecutionPlacements: { get: vi.fn(async () => undefined), claimLocal },
        remoteWorkerAssignments: { findTaskBoundChatAssignment, scheduleTaskBoundChatOffer },
        remoteWorkerBudgets: { listExecutionGrants },
      },
      resolveChatApprovalPlacement: (candidate) => auto.assertPlacementCurrent(candidate),
    } as unknown as RemoteWorkerChatPlacementDependencies);
    const prepared = { workspaceId, session: { sessionId }, turnId } as Parameters<typeof placement.resolve>[1];
    await expect(placement.resolve(run, prepared)).resolves.toBeUndefined();
    await expect(placement.resolve(run, prepared)).rejects.toThrow(/cannot resume a worker assignment/);
    expect(claimLocal).toHaveBeenCalledOnce();
    expect(listExecutionGrants).not.toHaveBeenCalled();
    expect(scheduleTaskBoundChatOffer).not.toHaveBeenCalled();
  });

  it("runs verified structured project reads through real policy and rejects paths outside the project", async () => {
    const readScopedTarget = vi.fn(async (request: ToolInvokeRequest) =>
      request.toolName === "code.search" ? { count: 1 } : { content: readFileSync(String(request.args.path), "utf8") },
    );
    const { engine, auto, run, invoke, root, project, file } = await setup({ readScopedTarget });
    await auto.runInDurableTurn(run, async () => {
      expect(await engine.invoke(invoke("fs.read", { path: file }))).toMatchObject({ outcome: "executed" });
      expect(await engine.invoke(invoke("code.search", { path: project, query: "verifiedSearch" }))).toMatchObject({
        outcome: "executed",
        result: { count: 1 },
      });
      expect(await engine.invoke(invoke("fs.list", { path: root }))).toMatchObject({ outcome: "blocked" });
    });
    expect(readScopedTarget).toHaveBeenCalledTimes(2);
  });

  it("never falls through to the ordinary reader when the scoped adapter detects a path redirection at open", async () => {
    const readScopedTarget =
      vi.fn<NonNullable<ConstructorParameters<typeof ChatAutoActionPolicy>[0]["readScopedTarget"]>>();
    const { engine, invoke, project, root, policyConfig } = await setup({ readScopedTarget });
    const targetPath = join(project, "target.txt");
    const sibling = join(root, "sibling");
    const originalRootInode = lstatSync(project, { bigint: true }).ino;
    mkdirSync(sibling);
    writeFileSync(targetPath, "project contents");
    writeFileSync(join(sibling, "target.txt"), "secret sibling contents");
    policyConfig.sandbox.writeJailRoots.push(root);
    readScopedTarget.mockImplementation(async (_request, target) => {
      renameSync(project, join(root, "old-project"));
      renameSync(sibling, project);
      if (lstatSync(target.projectRoot, { bigint: true }).ino !== originalRootInode) {
        throw new Error("The scoped reader refused a redirected path.");
      }
      return { content: readFileSync(target.path, "utf8") };
    });
    const result = await engine.invoke(invoke("fs.read", { path: targetPath }));
    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain("The scoped reader refused a redirected path.");
    expect(readFileSync(targetPath, "utf8")).toBe("secret sibling contents");
    expect(JSON.stringify(result)).not.toContain("secret sibling contents");
    expect(readScopedTarget).toHaveBeenCalledOnce();
  });

  it("refuses both direct and approved path I/O without a verified project adapter", async () => {
    const { engine, invoke, file, storage, policyConfig, approve } = await setup({ approvalMode: "approve_all" });
    expect(await engine.invoke(invoke("fs.read", { path: file }))).toMatchObject({ outcome: "blocked" });
    const write = invoke("fs.write", { path: file, content: "replacement" });
    expect(await engine.invoke(write)).toMatchObject({ outcome: "blocked" });
    const historical = await new ToolPolicyEngine(policyConfig, storage).invoke(write);
    expect(historical.outcome).toBe("approval_required");
    approve(historical.approvalId!);
    expect(await engine.executeApprovedAction(historical.approvalId!)).toMatchObject({ outcome: "blocked" });
    expect(readFileSync(file, "utf8")).toBe("const verifiedSearch = 1;\n");
  });

  it("refuses a linked legacy approval without a durable binding in an active Auto session", async () => {
    const { engine, storage, policyConfig, invoke, approve, beforeProcessSpawn } = await setup({
      approvalMode: "approve_all",
    });
    const request = invoke("shell.exec", { command: "node opaque.js" }, { turnId: "historical-inline-turn" });
    const approval = await new ToolPolicyEngine(policyConfig, storage).invoke(request);
    expect(approval.outcome).toBe("approval_required");
    approve(approval.approvalId!);
    expect(await engine.executeApprovedAction(approval.approvalId!)).toMatchObject({ outcome: "blocked" });
    expect(beforeProcessSpawn).not.toHaveBeenCalled();
  });

  it("enforces the explicit Auto target independently of a Standard ambient scope", async () => {
    const { auto, bindStandard, engine, storage, policyConfig, invoke, approve, beforeProcessSpawn } = await setup({
      approvalMode: "approve_all",
    });
    const standard = await bindStandard();
    const approval = await new ToolPolicyEngine(policyConfig, storage).invoke(
      invoke("shell.exec", { command: "node opaque.js" }),
    );
    expect(approval.outcome).toBe("approval_required");
    approve(approval.approvalId!);
    await auto.runInDurableTurn(standard.run, async () => {
      expect(await engine.executeApprovedAction(approval.approvalId!)).toMatchObject({ outcome: "blocked" });
    });
    expect(beforeProcessSpawn).not.toHaveBeenCalled();
  });

  it("isolates the real global approval worker from the triggering Auto turn", async () => {
    const { auto, run, bindStandard, raw, engine, storage, policyConfig, invoke, approve, file, beforeProcessSpawn } =
      await setup({ approvalMode: "approve_all" });
    const standard = await bindStandard();
    const historical = new ToolPolicyEngine(policyConfig, storage);
    const standardRequest = invoke(
      "fs.read",
      { path: file },
      { sessionId: standard.sessionId, turnId: standard.turnId },
    );
    const autoRequest = invoke("shell.exec", { command: "node opaque.js" });
    const requests = new Map<string, ToolInvokeRequest>();
    for (const request of [standardRequest, autoRequest]) {
      const approval = await historical.invoke(request);
      expect(approval.outcome).toBe("approval_required");
      approve(approval.approvalId!);
      requests.set(approval.approvalId!, request);
      raw.approvalEffects.upsert({
        approvalId: approval.approvalId!,
        effectKind: "pending_action_execute",
        targetKind: "pending_action",
        targetId: approval.approvalId!,
        payload: { actionType: "tool.invoke" },
      });
    }
    const backgroundTasks = new Set<Promise<unknown>>();
    const executeApprovedPendingAction = vi.fn((id: string, signal: AbortSignal) =>
      engine.executeApprovedAction(id, signal),
    );
    const worker = new ApprovalEffectsService(
      { storage, publishRealtime: vi.fn() } as unknown as ConstructorParameters<typeof ApprovalEffectsService>[0],
      {
        backgroundTasks,
        runOutsideChatExecutionScope: (work) => auto.runOutsideChatExecutionScope(work),
        checkChatAutoApprovalReplay: async (id) => {
          const request = requests.get(id)!;
          const restriction = await auto.inspect(request, "replay", id);
          if (restriction?.kind === "block") return engine.blockRestrictedExecution(request, restriction.reason);
          return undefined;
        },
        executeApprovedPendingAction,
      } as ConstructorParameters<typeof ApprovalEffectsService>[1],
    );
    try {
      await auto.runInDurableTurn(run, async () => {
        worker.requestEffectProcessing();
        await Promise.all([...backgroundTasks]);
      });
      const [standardApproval, autoApproval] = [...requests.keys()];
      expect(raw.pendingApprovalActions.get(standardApproval).resolutionStatus).toBe("executed");
      expect(raw.pendingApprovalActions.get(autoApproval).resolutionStatus).toBe("failed");
      expect(executeApprovedPendingAction).toHaveBeenCalledOnce();
      expect(beforeProcessSpawn).not.toHaveBeenCalled();
    } finally {
      worker.stopWorker();
    }
  });

  it("blocks wrappers with missing or substituted turn scope before any spawn or Code Mode dispatch", async () => {
    const { engine, auto, run, invoke, file, beforeProcessSpawn, runCodeModeRequest } = await setup();
    await auto.runInDurableTurn(run, async () => {
      for (const request of [
        invoke("shell.exec", { command: "pwsh -File arbitrary.ps1" }, { turnId: undefined }),
        invoke("shell.exec_background", { command: "node arbitrary.js" }),
        invoke("tests.run", { command: "pnpm test" }),
        invoke("fs.read", { path: file }, { turnId: "fake-turn" }),
        invoke("fs.read", { path: file }, { policyContext: { approvedCodeModeRunId: "code-mode-run" } }),
        invoke("fs.read", { path: file }, { externalRuntime: true }),
        invoke("code_mode.request", { source: "opaque" }),
      ])
        expect(await engine.invoke(request)).toMatchObject({ outcome: "blocked" });
      await expect(assertChatAutoCodeModeAllowed(auto, { sessionId, workspaceId })).rejects.toThrow(/cannot verify/);
      await expect(auto.assertNoDelegatedExecution({ sessionId, workspaceId })).rejects.toThrow(/delegated execution/);
    });
    expect(beforeProcessSpawn).not.toHaveBeenCalled();
    expect(runCodeModeRequest).not.toHaveBeenCalled();
  });

  it("asks despite broad bypass and executes the exact direct deletion only once", async () => {
    const { raw, engine, auto, run, invoke, file, protectedFile, approve, deleteExactTarget } = await setup({
      adapter: true,
    });
    const deletion = invoke("fs.delete", { path: file });
    await auto.runInDurableTurn(run, async () => {
      expect(await engine.invoke(invoke("fs.delete", { path: protectedFile }))).toMatchObject({ outcome: "blocked" });
      const proposal = await engine.invoke(deletion);
      expect(proposal).toMatchObject({ outcome: "approval_required" });
      const approvalId = proposal.approvalId!;
      approve(approvalId);
      expect(raw.approvalEvents.listByApprovalId(approvalId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "pending_action_registered",
            payload: expect.objectContaining({ chatAutoDelete: expect.any(String) }),
          }),
        ]),
      );
      expect(await engine.invoke({ ...deletion, consentContext: { reason: `approval:${approvalId}` } })).toMatchObject({
        outcome: "approval_required",
      });
      expect(deleteExactTarget).not.toHaveBeenCalled();
      const results = await Promise.all([
        engine.executeApprovedAction(approvalId),
        engine.executeApprovedAction(approvalId),
      ]);
      expect(results.filter((result) => result?.outcome === "executed")).toHaveLength(1);
      expect(raw.pendingApprovalActions.get(approvalId).resolutionStatus).toBe("executed");
      expect(deleteExactTarget).toHaveBeenCalledExactlyOnceWith({
        path: file,
        identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });
  });

  it.each(["one_time", "persistent"] as const)(
    "honors the first exact deletion under a constrained %s grant",
    async (grantType) => {
      const { engine, invoke, file, raw, policyConfig, approve, deleteExactTarget } = await setup({ adapter: true });
      policyConfig.tools.allow = [];
      const grant = raw.toolGrants.create({
        toolPattern: "fs.delete",
        decision: "allow",
        scope: "session",
        scopeRef: sessionId,
        grantType,
        constraints: { maxCallsPerHour: 1, maxWritesPerHour: 1 },
        createdBy: operatorId,
      });
      const request = invoke("fs.delete", { path: file });
      const first = await engine.invoke(request);
      expect(first.outcome).toBe("approval_required");
      expect(raw.toolGrants.get(grant.grantId).usesRemaining).toBe(grantType === "one_time" ? 1 : undefined);
      approve(first.approvalId!);
      expect(await engine.executeApprovedAction(first.approvalId!)).toMatchObject({ outcome: "executed" });
      expect(raw.toolGrants.get(grant.grantId).usesRemaining).toBe(grantType === "one_time" ? 0 : undefined);
      expect(await engine.invoke(request)).toMatchObject({ outcome: "blocked" });
      expect(deleteExactTarget).toHaveBeenCalledOnce();
    },
  );

  it("refuses the bounded delete when its reserved grant is revoked after the one-use claim", async () => {
    const { engine, invoke, file, raw, policyConfig, approve, deleteExactTarget } = await setup({ adapter: true });
    policyConfig.tools.allow = [];
    const grant = raw.toolGrants.create({
      toolPattern: "fs.delete",
      decision: "allow",
      scope: "session",
      scopeRef: sessionId,
      grantType: "one_time",
      constraints: { maxCallsPerHour: 1 },
      createdBy: operatorId,
    });
    const first = await engine.invoke(invoke("fs.delete", { path: file }));
    expect(first.outcome).toBe("approval_required");
    approve(first.approvalId!);
    const lock = raw.toolGrants.lockUnrevokedGrantForReservedUse.bind(raw.toolGrants);
    let lockCount = 0;
    vi.spyOn(raw.toolGrants, "lockUnrevokedGrantForReservedUse").mockImplementation((id) => {
      if (++lockCount === 2) raw.toolGrants.revoke(id, undefined, operatorId);
      return lock(id);
    });
    expect(await engine.executeApprovedAction(first.approvalId!)).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("The deletion policy or target changed."),
    });
    expect(lockCount).toBe(2);
    expect(raw.toolGrants.get(grant.grantId)).toMatchObject({ usesRemaining: 0, revokedBy: operatorId });
    expect(deleteExactTarget).not.toHaveBeenCalled();
  });

  it("refuses unsupported deletions before creating an approval", async () => {
    const { engine, invoke, file, project, deleteExactTarget } = await setup();
    for (const request of [
      invoke("fs.delete", { path: file }),
      invoke("fs.delete", { path: project, recursive: true }),
      invoke("fs.move", { from: file, to: join(project, "moved.ts") }),
      invoke("fs.trash", { path: file }),
    ]) {
      const result = await engine.invoke(request);
      expect(result.outcome).toBe("blocked");
      expect(result.approvalId).toBeUndefined();
    }
    expect(deleteExactTarget).not.toHaveBeenCalled();
  });

  it.each(["target", "policy", "mode"] as const)("rechecks changed %s before approved deletion", async (change) => {
    const { engine, invoke, file, approve, deleteExactTarget, policyConfig, setMode } = await setup({ adapter: true });
    const proposed = await engine.invoke(invoke("fs.delete", { path: file }));
    expect(proposed.outcome).toBe("approval_required");
    approve(proposed.approvalId!);
    if (change === "target") writeFileSync(file, "replacement content\n");
    if (change === "policy") policyConfig.tools.deny.push("fs.delete");
    if (change === "mode") await setMode("standard");
    expect(await engine.executeApprovedAction(proposed.approvalId!)).toMatchObject({ outcome: "blocked" });
    expect(deleteExactTarget).not.toHaveBeenCalled();
  });

  it("rejects previously approved opaque actions before any spawn", async () => {
    const { engine, storage, invoke, approve, policyConfig, beforeProcessSpawn } = await setup({
      approvalMode: "approve_all",
    });
    const historicalEngine = new ToolPolicyEngine(policyConfig, storage);
    for (const toolName of ["shell.exec", "shell.exec_background", "code_mode.request"]) {
      const request = invoke(
        toolName,
        toolName === "code_mode.request"
          ? { goal: "Opaque work", language: "javascript", source: "return 42" }
          : { command: "node opaque.js" },
      );
      const proposed = await historicalEngine.invoke(request);
      expect(proposed.outcome).toBe("approval_required");
      approve(proposed.approvalId!);
      expect(await engine.executeApprovedAction(proposed.approvalId!)).toMatchObject({ outcome: "blocked" });
    }
    expect(beforeProcessSpawn).not.toHaveBeenCalled();
  });
});
