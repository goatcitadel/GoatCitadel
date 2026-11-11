import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRemoteStorage,
  POSTGRES_MIGRATIONS,
  PostgresDatabaseClient,
  runPostgresMigrations,
  type AsyncStorage,
} from "@goatcitadel/storage";
import { claimArtifactRetry, closeChatTurnToolUse, readChatTurnControl } from "./chat-turn-control.js";
import {
  getChatApprovalMode,
  isChatAutoApprovalEnabled,
  readChatApprovalAdmission,
  updateChatApprovalMode,
  withCurrentChatApprovalAuthority,
} from "./chat-approval-mode-service.js";
import { preserveCancelledChatTurnOutput } from "./chat-turn-interruption-recovery-service.js";
import { commitDurableWakeTransition } from "./durable-wake-transition-service.js";
import {
  acquireGatewayLivePostgresTestLease,
  type GatewayLivePostgresTestLease,
} from "../test/live-postgres-suite-lock.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
describe.skipIf(!url)("Chat turn control on isolated real PostgreSQL", { timeout: 120_000 }, () => {
  let admin: Pool, storage: AsyncStorage, second: AsyncStorage, root: string, scopedUrl: URL;
  let lease: GatewayLivePostgresTestLease | undefined;
  const schema = `chat_control_${randomUUID().replaceAll("-", "")}`;
  const open = () =>
    createPostgresRemoteStorage({
      connection: {
        connectionString: scopedUrl.toString(),
        database: scopedUrl.pathname.slice(1),
        applicationName: "goatcitadel-chat-control-test",
        pool: { max: 2, connectionTimeoutMs: 10_000 },
      },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
      startupWaitTimeoutMs: 120_000,
    });
  beforeAll(async () => {
    lease = await acquireGatewayLivePostgresTestLease(url!);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-chat-control-pg-"));
    admin = new Pool({ connectionString: url });
    if (!/^chat_control_[a-f0-9]+$/u.test(schema)) throw new Error("Invalid isolated schema");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    scopedUrl = new URL(url!);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const migration = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: scopedUrl.pathname.slice(1) },
      { pool: new Pool({ connectionString: scopedUrl.toString(), max: 2 }) },
    );
    try {
      await runPostgresMigrations(migration, POSTGRES_MIGRATIONS);
    } finally {
      await migration.close();
    }
    storage = open();
    second = open();
    await Promise.all([storage.waitUntilReady(), second.waitUntilReady()]);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([storage?.close(), second?.close()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (root && path.basename(root).startsWith("gc-chat-control-pg-"))
      await fs.rm(root, { recursive: true, force: true });
    await lease?.release();
  });
  async function seed() {
    const turnId = randomUUID(),
      sessionId = `session-${turnId}`;
    const run = await storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
      payload: { sessionId, turnId },
      metadata: { preserve: "untouched" },
    });
    await storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: `user-${turnId}`,
      status: "running",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: new Date().toISOString(),
      durable: { runId: run.runId, status: "running" },
    });
    return { turnId, sessionId, runId: run.runId };
  }

  it("admits project Auto mode and retains exact, revision-bound file effects across PostgreSQL workers", async () => {
    const sessionId = randomUUID();
    const workspaceId = "default";
    const deps = { storage, chatAutoApprovalEnabled: isChatAutoApprovalEnabled(storage) };
    const other = { storage: second, chatAutoApprovalEnabled: isChatAutoApprovalEnabled(second) };
    await storage.sessions.upsert({
      sessionId,
      sessionKey: `mission:operator:${sessionId}`,
      channel: "mission",
      account: "operator",
      kind: "dm",
      timestamp: new Date().toISOString(),
    });
    await storage.chatSessionMeta.ensure(sessionId, undefined, workspaceId);
    const { projectId } = await storage.chatProjects.create({
      workspaceId,
      name: "Auto PostgreSQL proof",
      workspacePath: "auto-pg",
    });
    await storage.chatSessionProjects.assign(sessionId, projectId);
    const standard = await getChatApprovalMode(deps, sessionId);
    expect(standard.autoAvailable).toBe(true);
    const auto = await updateChatApprovalMode(deps, sessionId, {
      mode: "auto",
      expectedModeRevision: standard.modeRevision,
    });
    await expect(getChatApprovalMode(other, sessionId)).resolves.toEqual(auto);
    await expect(readChatApprovalAdmission(other, sessionId, workspaceId, false)).resolves.toBeUndefined();
    const authority = await readChatApprovalAdmission(other, sessionId, workspaceId, true, auto.modeRevision);
    expect(authority).toMatchObject({ mode: "auto", binding: { sessionId, workspaceId, projectId } });
    const turn = {
      sessionId,
      workspaceId,
      admissionAggregateRevision: (await storage.chatSessionMeta.get(sessionId))!.revision,
      chatApprovalAuthority: authority,
    };
    const target = { workspaceId, projectId, path: "proof.txt" };
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff]);
    const created = await withCurrentChatApprovalAuthority(deps, turn, async () =>
      storage.managedProjectFiles.save({
        ...target,
        expectedRevision: null,
        effectId: randomUUID(),
        contentBase64: original.toString("base64"),
      }),
    );
    if (created.status !== "current") throw new Error("Auto authority did not survive admission");
    const saved = await second.managedProjectFiles.save({
      ...target,
      expectedRevision: created.value.revisionId,
      effectId: randomUUID(),
      contentBase64: Buffer.from("replacement").toString("base64"),
    });
    const deleteEffect = {
      ...target,
      expectedRevision: saved.revisionId,
      effectId: randomUUID(),
    };
    const restored = await storage.managedProjectFiles.restore({ ...deleteEffect, effectId: randomUUID() });
    await expect(second.managedProjectFiles.delete(deleteEffect)).rejects.toThrow(/managed file changed/i);
    expect((await second.managedProjectFiles.read(target))?.contentBase64).toBe(original.toString("base64"));

    const exactDelete = { ...deleteEffect, expectedRevision: restored.revisionId };
    const results = await Promise.all([
      storage.managedProjectFiles.delete(exactDelete),
      second.managedProjectFiles.delete(exactDelete),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].revisionId).toBe(results[1].revisionId);
    const recreated = await second.managedProjectFiles.save({
      ...target,
      expectedRevision: null,
      effectId: randomUUID(),
      contentBase64: Buffer.from("new bytes").toString("base64"),
    });
    await expect(storage.managedProjectFiles.delete(exactDelete)).resolves.toMatchObject({ replayed: true });
    expect((await storage.managedProjectFiles.read(target))?.revisionId).toBe(recreated.revisionId);
  });
  it("admits one retry across independent workers and preserves it across reconnect", async () => {
    const { sessionId, turnId, runId } = await seed();
    const claims = await Promise.all([
      claimArtifactRetry(storage, sessionId, turnId),
      claimArtifactRetry(second, sessionId, turnId),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await storage.durableRuns.getRun(runId)).metadata?.preserve).toBe("untouched");
    await second.close();
    second = open();
    await second.waitUntilReady();
    expect(await claimArtifactRetry(second, sessionId, turnId)).toBe(false);
  });
  it("rolls back a failed lifecycle transaction and keeps its connection usable", async () => {
    const { sessionId, turnId } = await seed();
    await expect(
      storage.runImmediateTransaction(async () => {
        await claimArtifactRetry(storage, sessionId, turnId);
        await closeChatTurnToolUse(storage, sessionId, turnId, {
          outcome: "denied",
          actorId: "operator",
          closedAt: new Date().toISOString(),
        });
        throw new Error("injected persistence failure");
      }),
    ).rejects.toThrow("injected persistence failure");
    expect(await readChatTurnControl(second, sessionId, turnId)).toEqual({});
    expect(await claimArtifactRetry(second, sessionId, turnId)).toBe(true);
  });
  it("makes committed denial visible to other workers before any subsequent retry", async () => {
    const { sessionId, turnId } = await seed();
    await closeChatTurnToolUse(storage, sessionId, turnId, {
      outcome: "denied",
      approvalId: "operator-request",
      actorId: "operator",
      closedAt: new Date().toISOString(),
    });
    expect(await claimArtifactRetry(second, sessionId, turnId)).toBe(false);
    expect((await readChatTurnControl(second, sessionId, turnId)).toolClosure).toMatchObject({
      outcome: "denied",
      approvalId: "operator-request",
    });
  });
  it("withdraws only the bound pending request, including expiry, without reopening approval", async () => {
    const { sessionId, turnId } = await seed();
    const request = await storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "caution",
      payload: { toolName: "documents.create" },
      preview: {},
      linkage: { sessionId, turnId },
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      (await second.approvals.listPage({ status: "pending", includeExpired: true })).items.map(
        (item) => item.approvalId,
      ),
    ).toContain(request.approvalId);
    await expect(
      storage.approvals.withdrawPendingChatTurn(request.approvalId, {
        sessionId,
        turnId: "foreign",
        resolvedBy: "operator",
        resolutionNote: "Stopped",
      }),
    ).rejects.toThrow("another Chat turn");
    await storage.approvals.withdrawPendingChatTurn(request.approvalId, {
      sessionId,
      turnId,
      resolvedBy: "operator",
      resolutionNote: "Withdrawn",
    });
    expect(await second.approvals.get(request.approvalId)).toMatchObject({
      status: "rejected",
      resolvedBy: "operator",
    });
    await expect(
      second.approvals.resolve(request.approvalId, { decision: "approve", resolvedBy: "operator" }),
    ).rejects.toThrow("already resolved");
  });
  it("atomically wakes a confirmed delegation trace across rollback and reconnect", async () => {
    const { sessionId, turnId, runId } = await seed();
    const proposalId = randomUUID(),
      delegationId = randomUUID();
    const event = { eventKey: "chat.confirmed_delegation.resolved", correlationId: delegationId };
    const current = await storage.durableRuns.updateRun({
      runId,
      status: "waiting",
      payload: {
        version: "chat.turn.execute.v2",
        sessionId,
        turnId,
        userInputResponses: [{ promptId: proposalId, response: { kind: "single_select", optionId: "run_plan" } }],
      },
      metadata: {
        waitForEvent: event,
        chatTurnControlV1: {
          delegationProposal: {
            promptId: proposalId,
            bindingHash: "a".repeat(64),
            objective: "Review the plan",
            roles: ["qa"],
          },
        },
      },
    });
    await storage.chatDelegationRuns.create({
      runId: delegationId,
      parentRunId: runId,
      sessionId,
      taskId: randomUUID(),
      objective: "Review the plan",
      roles: ["qa"],
      mode: "sequential",
      workflowTemplate: "chat.confirmed-delegation.v1",
      executionPlanId: proposalId,
    });
    await storage.chatTurnTraces.patch(turnId, {
      status: "waiting_for_tool",
      routing: { confirmedDelegation: { runId: delegationId, proposalId, waiting: true } },
    });
    let failTimeline = true;
    const port = {
      prepareMetadata: async () => ({}),
      recordTimeline: async () => {
        if (failTimeline) throw new Error("injected wake persistence failure");
      },
    };
    await expect(
      commitDurableWakeTransition(storage, port, current, runId, event, new Date().toISOString()),
    ).rejects.toThrow("injected wake persistence failure");
    expect((await second.chatTurnTraces.get(turnId)).status).toBe("waiting_for_tool");
    expect((await second.durableRuns.getRun(runId)).status).toBe("waiting");
    failTimeline = false;
    await commitDurableWakeTransition(storage, port, current, runId, event, new Date().toISOString());
    await second.close();
    second = open();
    await second.waitUntilReady();
    expect((await second.chatTurnTraces.get(turnId)).status).toBe("queued");
    expect((await second.durableRuns.getRun(runId)).status).toBe("queued");
  });
  it("preserves cancelled partial output once across reconnect without claiming completion", async () => {
    const { sessionId, turnId, runId } = await seed();
    const messageId = `assistant-${turnId}`;
    await storage.sessions.upsert({
      sessionId,
      sessionKey: `mission:operator:${sessionId}`,
      kind: "dm",
      channel: "mission",
      account: "operator",
      timestamp: new Date().toISOString(),
    });
    await storage.chatTurnTraces.patch(turnId, { status: "cancelled", assistantMessageId: messageId });
    await storage.chatStreamEvents.append({
      eventId: randomUUID(),
      sessionId,
      turnId,
      runId,
      sequence: 1,
      chunkType: "delta",
      payload: { type: "delta", sessionId, turnId, messageId, delta: "Retained before Stop." },
      createdAt: new Date().toISOString(),
    });
    await storage.runImmediateTransaction(() => preserveCancelledChatTurnOutput(storage, sessionId, turnId));
    await second.close();
    second = open();
    await second.waitUntilReady();
    await second.runImmediateTransaction(() => preserveCancelledChatTurnOutput(second, sessionId, turnId));
    expect((await second.chatMessages.get(messageId))?.content).toBe("Retained before Stop.");
    expect(await second.chatTurnTraces.get(turnId)).toMatchObject({
      status: "cancelled",
      completion: { status: "interrupted" },
    });
    expect((await second.transcriptOutbox.listPending(100)).filter((row) => row.eventId === messageId)).toHaveLength(1);
  });
});
