import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "./index.js";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";
import { AgentProfileRepository } from "./agent-profile-repo.js";
import { ApprovalEventRepository } from "./approval-event-repo.js";
import { AssemblyRepository } from "./assembly-repo.js";
import { CapabilityProposalEventRepository } from "./capability-proposal-repo.js";
import { ChatAttachmentRepository } from "./chat-attachment-repo.js";
import { ChatDelegationStepRepository } from "./chat-delegation-step-repo.js";
import { ChatInlineApprovalRepository } from "./chat-inline-approval-repo.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { ChatSessionBindingRepository } from "./chat-session-binding-repo.js";
import { ChatSessionPrefsRepository } from "./chat-session-prefs-repo.js";
import { ChatSessionProjectRepository } from "./chat-session-project-repo.js";
import { ChatSessionWorkbenchRepository } from "./chat-session-workbench-repo.js";
import { ChatStreamEventRepository } from "./chat-stream-event-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { IdempotencyRepository } from "./idempotency-repo.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { MemoryQmdRunRepository } from "./memory-qmd-run-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { RealtimeEventRepository } from "./realtime-event-repo.js";
import { ResearchRunRepository } from "./research-run-repo.js";
import { ResearchSourceRepository } from "./research-source-repo.js";
import { SessionRepository } from "./session-repo.js";
import { SkillLifecycleRepository } from "./skill-lifecycle-repo.js";
import { TaskDeliverableRepository } from "./task-deliverable-repo.js";
import { TranscriptLog } from "./transcript-log.js";
import { WorkspaceHookRepository } from "./workspace-hook-repo.js";
import { WorkspaceRepository } from "./workspace-repo.js";
import { AuditLog } from "./audit-log.js";
import { enterRequestAttribution, getRequestAttribution, runWithRequestAttribution } from "./request-attribution.js";
import { safeJsonParse } from "./safe-json.js";
import { sanitizeParamsForServerEncoding } from "./postgres/server-encoding.js";
import { normalizePromptPackPolicyV3 } from "./prompt-pack-policy.js";
import { DEFAULT_PROMPT_PACK_POLICY_V3 } from "@goatcitadel/contracts";

const createdFiles: string[] = [];
const createdDirs: string[] = [];
const storageInstances: Storage[] = [];

afterEach(() => {
  mock.restoreAll();
  delete process.env.GOAT_AUDIT_RETENTION_DAYS;
  for (const storage of storageInstances.splice(0)) {
    try {
      storage.close();
    } catch {
      // ignore cleanup noise
    }
  }
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createDb(label: string): DatabaseClient {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-${label}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createDatabase({ dbPath });
}

function createStorage(): Storage {
  const root = path.join(os.tmpdir(), `goatcitadel-storage-tail-${randomUUID()}`);
  createdDirs.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storageInstances.push(storage);
  return storage;
}

describe("storage defensive tail coverage", () => {
  it("covers root storage transaction, session validation, and cleanup path deduplication", () => {
    const storage = createStorage();
    const now = "2026-05-01T00:00:00.000Z";
    const committed = storage.runImmediateTransaction(() => {
      storage.sessions.upsert({
        sessionId: "sess-tail",
        sessionKey: "mission:operator:sess-tail",
        kind: "dm",
        channel: "mission",
        account: "operator",
        timestamp: now,
      });
      return storage.sessions.getBySessionId("sess-tail").sessionId;
    });

    assert.equal(committed, "sess-tail");
    assert.throws(() => storage.deleteChatSessionData("  "), /sessionId/);

    storage.chatAttachments.create(
      {
        attachmentId: "attachment-1",
        sessionId: "sess-tail",
        workspaceId: "default",
        fileName: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        sha256: "sha-1",
        storageRelPath: "chat/default/attachments/note.txt",
        thumbnailRelPath: "   ",
        extractStatus: "ready",
      },
      now,
    );
    storage.chatAttachments.create(
      {
        attachmentId: "attachment-2",
        sessionId: "sess-tail",
        workspaceId: "default",
        fileName: "copy.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        sha256: "sha-2",
        storageRelPath: "chat/default/attachments/copy.txt",
        thumbnailRelPath: "chat/default/attachments/copy.txt",
        extractStatus: "ready",
      },
      now,
    );

    const deleted = storage.deleteChatSessionData(" sess-tail ");

    assert.equal(deleted.deleted, true);
    assert.deepEqual(deleted.cleanupRelPaths.sort(), [
      "chat/default/attachments/copy.txt",
      "chat/default/attachments/note.txt",
    ]);
  });

  it("waits for failed transcript writes before deleting", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-transcript-tail-${randomUUID()}`);
    createdDirs.push(root);
    const log = new TranscriptLog(root);
    mock.method(fsPromises, "open", async () => {
      throw new Error("write failed");
    });

    const append = log.append({
      eventId: "event-1",
      actionId: randomUUID(),
      idempotencyKey: "idem-1",
      sessionId: "sess-transcript-tail",
      sessionKey: "mission:operator:sess-transcript-tail",
      timestamp: "2026-05-01T00:00:00.000Z",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: {},
    });
    const failedAppend = assert.rejects(append, /write failed/);

    await log.delete("sess-transcript-tail");
    await failedAppend;
  });

  it("keeps safe JSON and request attribution boundary behavior explicit", () => {
    assert.equal(safeJsonParse(null, "fallback"), "fallback");
    assert.deepEqual(safeJsonParse({ ok: true }, {}), { ok: true });

    enterRequestAttribution({ correlationId: "corr-existing", traceId: "trace-existing" });
    const merged = runWithRequestAttribution({ correlationId: "   ", traceId: "trace-next", actorId: "operator" }, () =>
      getRequestAttribution(),
    );

    assert.deepEqual(merged, {
      correlationId: "corr-existing",
      traceId: "trace-next",
      actorId: "operator",
    });
  });

  it("throws through non-ENOENT audit read and retention read failures", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-tail-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);
    const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mock.method(fsPromises, "readFile", async () => {
      throw readError;
    });

    await assert.rejects(() => log.list("hooks"), /permission denied/);
    process.env.GOAT_AUDIT_RETENTION_DAYS = "7";
    await assert.rejects(() => log.append("hooks", { action: "hook.invoke" }), /permission denied/);
  });

  it("sanitizes nested structured WIN1252 values and ignores null structured values", () => {
    assert.deepEqual(
      sanitizeParamsForServerEncoding([{ nested: ['{"content":"alert 🚨"}'], nullable: null }], "win1252"),
      [{ nested: ['{"content":"alert \\uD83D\\uDEA8"}'], nullable: null }],
    );
  });

  it("covers chat prefs fallback branches when preserving existing controls", () => {
    const repo = new ChatSessionPrefsRepository(createDb("chat-prefs-tail"));
    repo.patch("sess-prefs", {
      imageProviderId: "google",
      imageModel: "gemini-image",
      visionFallbackModel: "vision-fallback",
      orchestrationEnabled: true,
    });

    const preserved = repo.patch("sess-prefs", { speedMode: "fast" });

    assert.equal(preserved.imageProviderId, "google");
    assert.equal(preserved.imageModel, "gemini-image");
    assert.equal(preserved.visionFallbackModel, "vision-fallback");
    assert.equal(preserved.orchestrationEnabled, true);
  });

  it("covers pending approval missing and already-resolved paths", () => {
    const repo = new PendingApprovalActionRepository(createDb("pending-approval-tail"));

    assert.throws(() => repo.get("missing-approval"), /pending approval action missing-approval/);
    assert.equal(repo.find("missing-approval"), undefined);
    assert.throws(() => repo.markResolved("missing-approval", "failed"), /pending approval action missing-approval/);
  });

  it("rejects malformed approval event rows", () => {
    const repo = new ApprovalEventRepository(createDb("approval-event-tail"));
    (repo as unknown as { listByApprovalStmt: { all: () => unknown[] } }).listByApprovalStmt = {
      all: () => [null],
    };

    assert.throws(() => repo.listByApprovalId("approval-1"), /approval_events query returned/);
  });

  it("filters malformed chat attachment adapter rows", () => {
    const repo = new ChatAttachmentRepository(createDb("chat-attachment-tail"));
    const internal = repo as unknown as {
      listBySessionStmt: { all: (...args: unknown[]) => unknown };
      listBySessionWorkspaceStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listBySessionStmt = { all: () => null };
    internal.listBySessionWorkspaceStmt = { all: () => [null] };

    assert.deepEqual(repo.listBySession("sess-attachments"), []);
    assert.deepEqual(repo.listBySession("sess-attachments", 10, "workspace-a"), []);
  });

  it("throws when workbench ensure cannot read back the inserted row", () => {
    const repo = new ChatSessionWorkbenchRepository(createDb("workbench-tail"));
    (repo as unknown as { getStmt: { get: () => unknown }; upsertStmt: { run: () => unknown } }).getStmt = {
      get: () => undefined,
    };
    (repo as unknown as { upsertStmt: { run: () => unknown } }).upsertStmt = { run: () => ({ changes: 1 }) };

    assert.throws(() => repo.ensure("sess-workbench"), /ensure did not return a row/);
  });

  it("filters malformed realtime state, count, and payload rows", () => {
    const repo = new RealtimeEventRepository(createDb("realtime-tail"));
    const internal = repo as unknown as {
      allocateSequenceStmt: { get: () => unknown };
      countStmt: { get: () => unknown };
      listLatestStmt: { all: () => unknown };
    };
    internal.allocateSequenceStmt = { get: () => ({ last_sequence: "bad" }) };
    const appended = repo.append(
      "custom_event",
      "custom",
      { nested: [{ workspaceId: "workspace-a" }, "skip-me"] },
      undefined,
      "2026-05-01T00:00:00.000Z",
    );
    assert.equal(appended.sequence, 1);

    internal.countStmt = { get: () => null };
    assert.equal(repo.pruneToMaxRows(10), 0);

    internal.listLatestStmt = { all: () => null };
    assert.deepEqual(repo.list(10), []);
  });

  it("filters malformed memory maintenance source and change rows", () => {
    const repo = new MemoryMaintenanceRepository(createDb("memory-maintenance-tail"));
    const internal = repo as unknown as {
      listRunSourcesStmt: { all: () => unknown };
      listRunChangesStmt: { all: () => unknown };
    };
    internal.listRunSourcesStmt = { all: () => [null] };
    internal.listRunChangesStmt = { all: () => [null] };

    assert.deepEqual(repo.listRunSources("run-1"), []);
    assert.deepEqual(repo.listRunChanges("run-1"), []);
  });

  it("filters malformed workspace hook adapter rows and invalid persisted actions", () => {
    const db = createDb("workspace-hook-tail");
    const repo = new WorkspaceHookRepository(db);
    const created = repo.create(
      {
        workspaceId: "workspace-a",
        label: "Hook",
        trigger: "tool.call.after",
        mode: "observe",
        action: { type: "webhook", webhook: { url: "https://example.test/hook" } },
      },
      "2026-05-01T00:00:00.000Z",
    );
    db.prepare("UPDATE workspace_hooks SET action_json = ? WHERE hook_id = ?").run(
      JSON.stringify({ type: "webhook", webhook: { url: 123 } }),
      created.hookId,
    );
    assert.throws(() => repo.get("workspace-a", created.hookId), /invalid action config/);

    const internal = repo as unknown as {
      listStmt: { all: () => unknown };
      getByTriggerStmt: { all: () => unknown };
    };
    internal.listStmt = { all: () => null };
    internal.getByTriggerStmt = { all: () => [null] };

    assert.deepEqual(repo.list("workspace-a"), []);
    assert.deepEqual(repo.listByTrigger("workspace-a", "tool.call.after"), []);
  });

  it("covers delegation step citation fallback and malformed parent rows", () => {
    const db = createDb("delegation-step-tail");
    const repo = new ChatDelegationStepRepository(db);
    repo.create({
      stepId: "step-1",
      runId: "run-1",
      role: "qa",
      index: 0,
      startedAt: "2026-05-01T00:00:00.000Z",
    });

    assert.equal(repo.patch("step-1", {}).citations, undefined);

    (db as unknown as { prepare: () => { all: () => unknown[] } }).prepare = () => ({ all: () => [null] });
    assert.deepEqual(repo.listParentsByChildSessionIds(["child-1"]), new Map());
  });

  it("filters malformed chat input parts without dropping valid messages", () => {
    const db = createDb("chat-message-tail");
    const repo = new ChatMessageRepository(db);
    repo.upsert({
      messageId: "message-1",
      sessionId: "sess-message",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "hello",
      timestamp: "2026-05-01T00:00:00.000Z",
    });
    db.prepare("UPDATE chat_messages SET parts_json = ? WHERE message_id = ?").run(
      JSON.stringify([null, { type: "unknown" }]),
      "message-1",
    );

    assert.equal(repo.get("message-1")?.parts, undefined);
  });

  it("covers task deliverable count fallback and malformed row filtering", () => {
    const repo = new TaskDeliverableRepository(createDb("task-deliverable-tail"));
    const internal = repo as unknown as {
      listByTaskStmt: { all: () => unknown };
      countByTaskStmt: { get: () => unknown };
    };
    internal.listByTaskStmt = { all: () => [null] };
    internal.countByTaskStmt = { get: () => undefined };

    assert.deepEqual(repo.listByTask("task-1"), []);
    assert.equal(repo.countByTask("task-1"), 0);
  });

  it("filters malformed agent profile and assembly reputation rows", () => {
    const agents = new AgentProfileRepository(createDb("agent-profile-tail"));
    (agents as unknown as { listStmt: { all: () => unknown } }).listStmt = { all: () => null };
    assert.deepEqual(agents.list("all"), []);

    const assembly = new AssemblyRepository(createDb("assembly-tail"));
    (assembly as unknown as { listReputationsStmt: { all: () => unknown } }).listReputationsStmt = {
      all: () => [null],
    };
    assert.deepEqual(assembly.listReputations(), []);
  });

  it("filters malformed capability proposal event rows", () => {
    const events = new CapabilityProposalEventRepository(createDb("capability-proposal-event-tail"));
    (events as unknown as { listStmt: { all: () => unknown } }).listStmt = { all: () => [null] };

    assert.deepEqual(events.listByProposalId("proposal-1"), []);
  });

  it("covers strict chat attachment workspace validation", () => {
    const attachments = new ChatAttachmentRepository(createDb("chat-attachment-workspace-tail"));

    assert.throws(
      () =>
        attachments.create({
          attachmentId: "attachment-empty-workspace",
          sessionId: "sess-attachment",
          workspaceId: "  ",
          fileName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          sha256: "sha-empty",
          storageRelPath: "attachments/note.txt",
          extractStatus: "ready",
        }),
      /workspaceId/,
    );
  });

  it("rejects malformed inline approval and session binding rows", () => {
    const inline = new ChatInlineApprovalRepository(createDb("inline-approval-tail"));
    (inline as unknown as { getStmt: { get: () => unknown } }).getStmt = { get: () => "bad-row" };
    assert.throws(() => inline.get("approval-1"), /chat_inline_approvals query returned/);

    const bindings = new ChatSessionBindingRepository(createDb("session-binding-tail"));
    (bindings as unknown as { getStmt: { get: () => unknown } }).getStmt = { get: () => null };
    assert.throws(() => bindings.get("sess-binding"), /chat_session_bindings row shape/);
  });

  it("throws when chat session project assignment cannot be read back", () => {
    const projects = new ChatSessionProjectRepository(createDb("session-project-tail"));
    (projects as unknown as { getStmt: { get: () => unknown }; upsertStmt: { run: () => unknown } }).getStmt = {
      get: () => undefined,
    };
    (projects as unknown as { upsertStmt: { run: () => unknown } }).upsertStmt = { run: () => ({ changes: 1 }) };

    assert.throws(() => projects.assign("sess-project", "project-1"), /was not persisted/);
  });

  it("covers latest stream sequence and durable retry malformed row fallbacks", () => {
    const streams = new ChatStreamEventRepository(createDb("stream-event-tail"));
    (streams as unknown as { getLatestSequenceStmt: { get: () => unknown } }).getLatestSequenceStmt = {
      get: () => null,
    };
    assert.equal(streams.getLatestSequence("turn-1"), 0);

    const runs = new DurableRunRepository(createDb("durable-run-tail"));
    (runs as unknown as { listRetriesStmt: { all: () => unknown } }).listRetriesStmt = { all: () => [null] };
    assert.deepEqual(runs.listRetries("run-1"), []);
  });

  it("covers idempotency misses and prompt-pack v3 null min scores", () => {
    const idempotency = new IdempotencyRepository(createDb("idempotency-tail"));
    assert.equal(idempotency.find("webhook", "missing-key"), undefined);

    assert.deepEqual(normalizePromptPackPolicyV3({ ...DEFAULT_PROMPT_PACK_POLICY_V3, minScores: null }).minScores, {});
  });

  it("filters malformed research and workspace list rows", () => {
    const researchRuns = new ResearchRunRepository(createDb("research-run-tail"));
    (researchRuns as unknown as { listBySessionStmt: { all: () => unknown } }).listBySessionStmt = {
      all: () => null,
    };
    assert.deepEqual(researchRuns.listBySession("sess-research"), []);

    const researchSources = new ResearchSourceRepository(createDb("research-source-tail"));
    (researchSources as unknown as { listByRunStmt: { all: () => unknown } }).listByRunStmt = {
      all: () => [null],
    };
    assert.deepEqual(researchSources.listByRun("run-research"), []);

    const workspaces = new WorkspaceRepository(createDb("workspace-tail"));
    (workspaces as unknown as { listStmt: { all: () => unknown } }).listStmt = { all: () => null };
    assert.deepEqual(workspaces.list("all"), []);
  });

  it("filters malformed operator summaries and covers terminal skill lifecycle states", () => {
    const sessions = new SessionRepository(createDb("session-tail"));
    (sessions as unknown as { listOperatorSummariesStmt: { all: () => unknown } }).listOperatorSummariesStmt = {
      all: () => [null],
    };
    assert.throws(() => sessions.listOperatorSummaries("2026-05-01T00:00:00.000Z"), /operator summary row shape/);

    const skills = new SkillLifecycleRepository(createDb("skill-lifecycle-tail"));
    const base = {
      category: "built_in" as const,
      trustLabel: "trusted",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    assert.equal(
      skills.upsert({ ...base, skillId: "skill-deprecated", lifecycleState: "deprecated" }).lifecycleState,
      "deprecated",
    );
    assert.equal(
      skills.upsert({ ...base, skillId: "skill-revoked", lifecycleState: "revoked" }).lifecycleState,
      "revoked",
    );
  });

  it("preserves channel setup failure category and reports neutral QMD stats", () => {
    const drafts = new ChannelSetupDraftRepository(createDb("channel-draft-tail"));
    const draft = drafts.create(
      {
        catalogId: "telegram",
        lifecycleMode: "create",
        enabled: true,
        contentVersion: "1",
        adapterVersion: "1",
        validationVersion: "1",
        testVersion: "1",
      },
      "2026-05-01T00:00:00.000Z",
    );
    const failed = drafts.update(draft.draftId, { lastFailureCategory: "platform_unavailable" });
    assert.equal(failed.lastFailureCategory, "platform_unavailable");
    assert.equal(drafts.update(draft.draftId, { label: "Renamed draft" }).lastFailureCategory, "platform_unavailable");

    const qmd = new MemoryQmdRunRepository(createDb("qmd-tail"));
    assert.equal(qmd.stats("2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z").efficiencyLabel, "neutral");
  });
});
