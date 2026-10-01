import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPostgresRemoteStorage,
  POSTGRES_MIGRATIONS,
  PostgresDatabaseClient,
  runPostgresMigrations,
  type AsyncStorage,
} from "@goatcitadel/storage";
import { seedLocalDelegationAuthority, localDelegationPayload } from "../../test/fixtures/local-delegation.js";
import {
  acquireGatewayLivePostgresTestLease,
  type GatewayLivePostgresTestLease,
} from "../test/live-postgres-suite-lock.js";
import { assertLocalDelegationTurnAuthority } from "./chat-local-delegation-authority.js";
import { beginDurableChatRun, type ChatDurableRunBeginDeps } from "./chat-durable-run-service.js";
import { SessionControlService } from "./session-control-service.js";
import { normalizeAgentInputFromSend } from "./chat-agent-input-normalization.js";
import { routeWithModelRouter } from "./model-router-decision-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
describe.skipIf(!url)("local delegated admission on isolated real PostgreSQL", { timeout: 120_000 }, () => {
  let admin: Pool, storage: AsyncStorage, observer: AsyncStorage, directory: string;
  let lease: GatewayLivePostgresTestLease | undefined;
  const schema = `local_delegation_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    lease = await acquireGatewayLivePostgresTestLease(url!);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "gc-local-delegation-pg-"));
    admin = new Pool({ connectionString: url });
    if (!/^local_delegation_[a-f0-9]+$/u.test(schema)) throw new Error("Invalid task schema");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migration = new PostgresDatabaseClient(
      { connectionString: scoped.toString(), database: scoped.pathname.slice(1) },
      { pool: new Pool({ connectionString: scoped.toString(), max: 2 }) },
    );
    try {
      await runPostgresMigrations(migration, POSTGRES_MIGRATIONS);
    } finally {
      await migration.close();
    }
    const open = () =>
      createPostgresRemoteStorage({
        connection: {
          connectionString: scoped.toString(),
          database: scoped.pathname.slice(1),
          pool: { max: 2, connectionTimeoutMs: 10_000 },
        },
        migrationsTable: "schema_migrations",
        transcriptsDir: path.join(directory, "transcripts"),
        auditDir: path.join(directory, "audit"),
        startupWaitTimeoutMs: 120_000,
      });
    storage = open();
    observer = open();
    await Promise.all([storage.waitUntilReady(), observer.waitUntilReady()]);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([storage?.close(), observer?.close()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (
      directory &&
      path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith("gc-local-delegation-pg-")
    )
      await fs.rm(directory, { recursive: true, force: true });
    await lease?.release();
  });

  it("rolls back failed child linkage and publishes only the atomically visible admitted child", async () => {
    const fixture = await seedLocalDelegationAuthority(storage);
    const input = fixture.input;
    const admission = input.admission!;
    await expect(assertLocalDelegationTurnAuthority(storage, input)).resolves.toBeUndefined();
    await expect(assertLocalDelegationTurnAuthority(storage, { ...input, sessionId: "foreign" })).rejects.toThrow();
    const prepared = await prepare(storage, fixture);
    const control = new SessionControlService(storage);
    const effects: string[] = [];
    const processing = vi.fn((runId: string) => {
      effects.push(`process:${runId}`);
    });
    const published = vi.fn(async () => {
      // This separate storage worker cannot see uncommitted admission writes.
      expect((await observer.chatDelegationSteps.get("local-step")).durableRunId).toBe("local-child-run");
      expect((await observer.durableChildWatchers.get("delegation-child:local-step")).childRunId).toBe(
        "local-child-run",
      );
      expect((await observer.sessionMutationAdmissions.findDurableRunBinding(admission.identity))?.durableRunId).toBe(
        "local-child-run",
      );
      effects.push("published");
    });
    const deps: ChatDurableRunBeginDeps = {
      shouldUseDurableExecution: true,
      runImmediateTransaction: (work) => storage.runImmediateTransaction(work),
      createDurableRun: (request) => storage.durableRuns.createRun(request),
      buildDurablePayloadRecord: () => localDelegationPayload(admission, input.userMessageId, input.assistantMessageId),
      assertTurnAdmissionWrite: async () => {
        await control.assertActiveTurnWrite(admission);
      },
      bindTurnAdmissionToDurableRun: async (_prepared, runId) => {
        await control.bindDurableRun(admission, runId);
      },
      chatTurnTraces: storage.chatTurnTraces,
      persistChatStreamChunk: vi.fn(async () => {
        effects.push("stream-persisted");
      }),
      onDurableRunCommitted: published,
      requestDurableRunProcessing: processing,
    };
    const bind = async (runId: string, fail: boolean) => {
      await assertLocalDelegationTurnAuthority(storage, input);
      expect((await storage.durableRuns.getRun(runId)).status).toBe("queued");
      expect((await observer.durableRuns.listRuns()).map((run) => run.runId)).toEqual(["local-parent-run"]);
      const linked = await storage.chatDelegationSteps.bindOwnedDurableRun({
        stepId: "local-step",
        childSessionId: input.sessionId,
        expectedDispatchToken: fixture.dispatchToken,
        durableRunId: runId,
      });
      expect(linked).toBeDefined();
      await storage.chatDelegationSteps.patch("local-step", { childTurnId: input.turnId });
      await storage.durableChildWatchers.create({
        watcherId: "delegation-child:local-step",
        parentRunId: "local-parent-run",
        childRunId: runId,
        source: "chat_delegation",
        metadata: {
          delegationRunId: "local-delegation",
          stepId: "local-step",
          childSessionId: input.sessionId,
          childTurnId: input.turnId,
        },
      });
      if (fail) throw new Error("injected child linkage failure");
    };
    await expect(
      beginDurableChatRun(deps, prepared, input.request, "chat_thread_turn_appended", {
        runId: "local-child-run",
        onChildDurableRunAdmitted: (runId) => bind(runId, true),
      }),
    ).rejects.toThrow("injected child linkage failure");
    expect(await observer.durableRuns.listRuns()).toHaveLength(1);
    expect((await observer.chatDelegationSteps.get("local-step")).durableRunId).toBeUndefined();
    await expect(observer.durableChildWatchers.get("delegation-child:local-step")).rejects.toThrow();
    expect(await observer.sessionMutationAdmissions.findDurableRunBinding(admission.identity)).toBeUndefined();
    expect(effects).toEqual([]);
    expect(processing).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    await expect(assertLocalDelegationTurnAuthority(storage, input)).resolves.toBeUndefined();

    await expect(
      beginDurableChatRun(deps, prepared, input.request, "chat_thread_turn_appended", {
        runId: "local-child-run",
        onChildDurableRunAdmitted: (runId) => bind(runId, false),
      }),
    ).resolves.toMatchObject({ runId: "local-child-run" });
    expect(effects).toEqual(["stream-persisted", "published", "process:local-child-run"]);
    expect(await observer.chatTurnCapabilityProfiles.findByTurn(input.turnId)).toBeUndefined();
    const claimed = await storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
      runId: "local-child-run",
      workerId: "pg-local-executor",
      leaseDurationMs: 300_000,
    });
    expect(claimed?.leaseOwnerId).toBe("pg-local-executor");
    const replay = {
      ...input,
      admission: {
        ...admission,
        requestClaim: undefined,
        durableClaim: {
          durableRunId: "local-child-run",
          leaseOwnerId: claimed!.leaseOwnerId!,
          attemptCount: claimed!.attemptCount,
        },
      },
    };
    await expect(assertLocalDelegationTurnAuthority(observer, replay)).resolves.toBeUndefined();
    await storage.durableChildWatchers.detach("delegation-child:local-step");
    await expect(assertLocalDelegationTurnAuthority(observer, replay)).resolves.toBeUndefined();
    expect(processing).toHaveBeenCalledTimes(1);
  });
});

async function prepare(
  storage: AsyncStorage,
  fixture: Awaited<ReturnType<typeof seedLocalDelegationAuthority>>,
): Promise<PreparedAgentChatTurn> {
  const input = fixture.input;
  return {
    session: await storage.sessions.getBySessionId(input.sessionId),
    route: { channel: "chat", account: "operator" },
    citadelId: "personal",
    workspaceId: "default",
    content: input.request.content,
    userEventId: input.userMessageId,
    userMessage: {
      messageId: input.userMessageId,
      sessionId: input.sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      sourceAuthority: "operator",
      content: input.request.content,
      timestamp: new Date().toISOString(),
    },
    prefs: await storage.chatSessionPrefs.ensure(input.sessionId),
    autonomy: await storage.sessionAutonomyPrefs.ensure(input.sessionId),
    normalized: normalizeAgentInputFromSend(input.request),
    effectiveMode: "chat",
    modelRouterDecision: routeWithModelRouter({ prompt: input.request.content }),
    retrievalTrace: { l0Used: false, l1Used: false, l2Used: false },
    threadKnowledgeCitations: [],
    resolvedGuidance: { workspaceId: "default", globalFilesUsed: [], workspaceFilesUsed: [], truncated: false },
    conversationMessages: [],
    history: [],
    turnId: input.turnId,
    turnAdmission: input.admission,
    assistantMessageId: input.assistantMessageId,
    branchKind: "append",
    effectiveToolAutonomy: "manual",
    compactionDimensionHash: "fixture-no-provider",
  };
}
