import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "./index.js";

const createdDirs: string[] = [];
const createdStorageInstances: Storage[] = [];

afterEach(() => {
  for (const storage of createdStorageInstances.splice(0)) {
    try {
      storage.close();
    } catch {
      // Ignore close noise during cleanup.
    }
  }
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup noise.
    }
  }
});

function createStorage(): Storage {
  const root = path.join(os.tmpdir(), `goatcitadel-storage-delete-${randomUUID()}`);
  createdDirs.push(root);
  fs.mkdirSync(root, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  createdStorageInstances.push(storage);
  return storage;
}

describe("Storage.deleteChatSessionData", () => {
  it("removes session-scoped chat data and preserves other sessions", () => {
    const storage = createStorage();
    seedChatSession(storage, "sess-1");
    seedChatSession(storage, "sess-2");

    const result = storage.deleteChatSessionData("sess-1");

    assert.equal(result.deleted, true);
    assert.equal(result.sessionId, "sess-1");
    assert.deepEqual(result.cleanupRelPaths.sort(), [
      "chat/default/artifacts/sess-1-artifact.txt",
      "chat/default/attachments/sess-1-thumb.png",
      "chat/default/attachments/sess-1.txt",
    ]);

    assert.equal(countRows(storage, "sessions", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_session_meta", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_messages", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_turn_traces", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_tool_runs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_inline_approvals", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "research_runs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "research_sources", "run_id = 'research-sess-1'"), 0);
    assert.equal(countRows(storage, "chat_delegation_runs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_delegation_steps", "run_id = 'delegation-sess-1'"), 0);
    assert.equal(countRows(storage, "chat_attachments", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_generated_artifacts", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_thread_knowledge_attachments", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "knowledge_documents", "namespace = 'chat-session:sess-1:knowledge'"), 0);
    assert.equal(countKnowledgeChunksByNamespace(storage, "chat-session:sess-1:knowledge"), 0);
    assert.equal(countRows(storage, "media_jobs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "media_artifacts", "job_id = 'media-sess-1'"), 0);
    assert.equal(countRows(storage, "proactive_runs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "proactive_actions", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "learned_memory_items", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "learned_memory_sources", "item_id = 'memory-sess-1'"), 0);
    assert.equal(countRows(storage, "learned_memory_conflicts", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_reflection_attempts", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "tool_grants", "scope = 'session' AND scope_ref = 'sess-1'"), 0);
    assert.equal(countRows(storage, "prompt_pack_runs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "prompt_pack_scores", "run_id = 'pack-run-sess-1'"), 0);
    assert.equal(countRows(storage, "memory_context_packs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "context_manifests", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "context_manifest_entries", "manifest_id = 'manifest-sess-1'"), 0);
    assert.equal(countRows(storage, "memory_qmd_runs", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_execution_plans", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "chat_execution_plan_steps", "plan_id = 'plan-sess-1'"), 0);
    assert.equal(countRows(storage, "chat_conversation_summaries", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "tool_access_decisions", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "tool_invocations", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "policy_blocks", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "cost_ledger", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "voice_sessions", "session_id = 'sess-1'"), 0);
    assert.equal(countRows(storage, "mesh_session_owners", "session_id = 'sess-1'"), 0);

    assert.equal(countRows(storage, "sessions", "session_id = 'sess-2'"), 1);
    assert.equal(countRows(storage, "chat_messages", "session_id = 'sess-2'"), 1);
    assert.equal(countRows(storage, "chat_generated_artifacts", "session_id = 'sess-2'"), 1);
    assert.equal(countRows(storage, "chat_thread_knowledge_attachments", "session_id = 'sess-2'"), 1);
    assert.equal(countRows(storage, "knowledge_documents", "namespace = 'chat-session:sess-2:knowledge'"), 1);
    assert.equal(countKnowledgeChunksByNamespace(storage, "chat-session:sess-2:knowledge"), 1);
  });
});

function seedChatSession(storage: Storage, sessionId: string): void {
  const now = "2026-03-09T00:00:00.000Z";
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: now,
  });
  storage.chatSessionMeta.ensure(sessionId, now, "default");
  storage.chatSessionBindings.upsert(
    {
      sessionId,
      workspaceId: "default",
      transport: "llm",
      writable: true,
    },
    now,
  );
  storage.chatSessionPrefs.ensure(sessionId, now);
  storage.sessionAutonomyPrefs.ensure(sessionId, now);
  storage.chatMessages.upsert(
    {
      messageId: `message-${sessionId}`,
      sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: `hello from ${sessionId}`,
      timestamp: now,
    },
    now,
  );
  storage.chatTurnTraces.create({
    turnId: `turn-${sessionId}`,
    sessionId,
    userMessageId: `message-${sessionId}`,
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: now,
  });
  storage.chatToolRuns.create({
    toolRunId: `tool-${sessionId}`,
    turnId: `turn-${sessionId}`,
    sessionId,
    toolName: "browser.search",
    startedAt: now,
  });
  storage.chatInlineApprovals.upsert({
    approvalId: `approval-${sessionId}`,
    sessionId,
    turnId: `turn-${sessionId}`,
    status: "pending",
    createdAt: now,
  });
  storage.contextManifests.ensure({
    scope: "chat_turn",
    turnId: `turn-${sessionId}`,
    sessionId,
    createdAt: now,
  });
  storage.db
    .prepare(
      `
    UPDATE context_manifests
    SET manifest_id = @manifestId
    WHERE turn_id = @turnId
  `,
    )
    .run({
      manifestId: `manifest-${sessionId}`,
      turnId: `turn-${sessionId}`,
    });
  storage.contextManifests.appendEntry({
    manifestId: `manifest-${sessionId}`,
    kind: "system_message",
    entryIndex: 0,
    sourceRef: "system:0",
    contentText: "system instructions",
    createdAt: now,
  });
  storage.researchRuns.create({
    runId: `research-${sessionId}`,
    sessionId,
    query: "test query",
    mode: "quick",
    startedAt: now,
  });
  storage.researchSources.replaceForRun(`research-${sessionId}`, [
    {
      sourceId: `source-${sessionId}`,
      url: "https://example.com",
      rank: 0,
      createdAt: now,
    },
  ]);
  storage.chatDelegationRuns.create({
    runId: `delegation-${sessionId}`,
    sessionId,
    taskId: `task-${sessionId}`,
    objective: "test objective",
    roles: ["qa"],
    mode: "sequential",
    startedAt: now,
  });
  storage.chatDelegationSteps.create({
    stepId: `delegation-step-${sessionId}`,
    runId: `delegation-${sessionId}`,
    role: "qa",
    index: 0,
    startedAt: now,
  });
  storage.chatExecutionPlans.create({
    planId: `plan-${sessionId}`,
    sessionId,
    turnId: `turn-${sessionId}`,
    mode: "cowork",
    planningMode: "advisory",
    source: "planner",
    advisoryOnly: true,
    objective: "test objective",
    summary: "test summary",
    steps: [
      {
        stepId: `plan-step-${sessionId}`,
        index: 0,
        objective: "review failures",
        parallelizable: false,
        status: "pending",
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
  storage.chatConversationSummaries.upsert({
    sessionId,
    branchHeadTurnId: `turn-${sessionId}`,
    startTurnId: `turn-${sessionId}`,
    endTurnId: `turn-${sessionId}`,
    turnIds: [`turn-${sessionId}`],
    sourceHash: `summary-hash-${sessionId}`,
    tokenEstimate: 24,
    summary: "compact summary",
    createdAt: now,
    updatedAt: now,
  });
  storage.chatAttachments.create(
    {
      attachmentId: `attachment-${sessionId}`,
      sessionId,
      workspaceId: "default",
      fileName: `${sessionId}.txt`,
      mimeType: "text/plain",
      sizeBytes: 4,
      sha256: "deadbeef",
      storageRelPath: `chat/default/attachments/${sessionId}.txt`,
      thumbnailRelPath: `chat/default/attachments/${sessionId}-thumb.png`,
      extractStatus: "ready",
    },
    now,
  );
  storage.chatGeneratedArtifacts.create({
    artifactId: `generated-${sessionId}`,
    sessionId,
    workspaceId: "default",
    turnId: `turn-${sessionId}`,
    title: `Artifact ${sessionId}`,
    kind: "markdown",
    content: `# Artifact for ${sessionId}`,
    sourceSurface: "chat",
    version: 1,
    providerId: "openai",
    model: "gpt-5.4-mini",
    createdAt: now,
    updatedAt: now,
  });
  const knowledgeNamespace = `chat-session:${sessionId}:knowledge`;
  const document = storage.knowledge.createDocument(
    {
      namespace: knowledgeNamespace,
      sourceType: "file",
      sourceRef: `${sessionId}.txt`,
      title: `${sessionId} attachment`,
      metadata: {
        sessionId,
      },
    },
    now,
  );
  storage.knowledge.appendChunks(
    document.docId,
    [
      {
        content: `knowledge for ${sessionId}`,
      },
    ],
    now,
  );
  storage.chatThreadKnowledgeAttachments.create({
    attachmentId: `thread-knowledge-${sessionId}`,
    sessionId,
    sourceType: "file",
    sourceRef: `${sessionId}.txt`,
    title: `${sessionId} attachment`,
    retrievalMode: "retrieval",
    ingestStatus: "ready",
    chunkCount: 1,
    namespace: knowledgeNamespace,
    chatAttachmentId: `attachment-${sessionId}`,
    documentId: document.docId,
    createdAt: now,
    updatedAt: now,
  });

  storage.db
    .prepare(
      `
    INSERT INTO media_jobs (
      job_id, session_id, attachment_id, job_type, status, input_json, output_json, error, created_at, updated_at, completed_at
    ) VALUES (
      @jobId, @sessionId, @attachmentId, 'ocr', 'queued', NULL, NULL, NULL, @createdAt, @createdAt, NULL
    )
  `,
    )
    .run({
      jobId: `media-${sessionId}`,
      sessionId,
      attachmentId: `attachment-${sessionId}`,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO media_artifacts (
      artifact_id, job_id, attachment_id, kind, storage_rel_path, text_preview, mime_type, size_bytes, created_at
    ) VALUES (
      @artifactId, @jobId, @attachmentId, 'text', @storageRelPath, NULL, 'text/plain', 12, @createdAt
    )
  `,
    )
    .run({
      artifactId: `artifact-${sessionId}`,
      jobId: `media-${sessionId}`,
      attachmentId: `attachment-${sessionId}`,
      storageRelPath: `chat/default/artifacts/${sessionId}-artifact.txt`,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO proactive_runs (
      run_id, session_id, status, mode, confidence, reasoning_summary, action_count, suggested_actions_json,
      executed_actions_json, error, started_at, finished_at
    ) VALUES (
      @runId, @sessionId, 'suggested', 'suggest', 0.8, 'summary', 1, '[]', '[]', NULL, @createdAt, NULL
    )
  `,
    )
    .run({
      runId: `proactive-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO proactive_actions (
      action_id, run_id, session_id, kind, status, tool_name, args_json, result_json, error, created_at, updated_at
    ) VALUES (
      @actionId, @runId, @sessionId, 'tool', 'queued', 'browser.search', '{}', NULL, NULL, @createdAt, @createdAt
    )
  `,
    )
    .run({
      actionId: `proactive-action-${sessionId}`,
      runId: `proactive-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO learned_memory_items (
      item_id, session_id, item_type, content, confidence, status, superseded_by_item_id, redacted, disabled_reason, created_at, updated_at
    ) VALUES (
      @itemId, @sessionId, 'fact', 'memory', 0.7, 'active', NULL, 0, NULL, @createdAt, @createdAt
    )
  `,
    )
    .run({
      itemId: `memory-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO learned_memory_sources (
      source_id, item_id, source_kind, source_ref, snippet, created_at
    ) VALUES (
      @sourceId, @itemId, 'chat', 'turn', 'snippet', @createdAt
    )
  `,
    )
    .run({
      sourceId: `memory-source-${sessionId}`,
      itemId: `memory-${sessionId}`,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO learned_memory_conflicts (
      conflict_id, session_id, item_type, existing_item_id, incoming_item_id, incoming_content, status, resolution_note, created_at, resolved_at
    ) VALUES (
      @conflictId, @sessionId, 'fact', NULL, NULL, 'incoming', 'open', NULL, @createdAt, NULL
    )
  `,
    )
    .run({
      conflictId: `memory-conflict-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO chat_reflection_attempts (
      attempt_id, turn_id, session_id, reason, outcome, attempt_count, strategy, error, created_at
    ) VALUES (
      @attemptId, @turnId, @sessionId, 'retry', 'success', 1, 'reflect', NULL, @createdAt
    )
  `,
    )
    .run({
      attemptId: `reflection-${sessionId}`,
      turnId: `turn-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO prompt_pack_runs (
      run_id, pack_id, test_id, session_id, status, provider_id, model, response_text, trace_json, citations_json, error, started_at, finished_at
    ) VALUES (
      @runId, 'pack-1', 'test-1', @sessionId, 'completed', 'glm', 'glm-5', 'ok', '{}', '[]', NULL, @createdAt, @createdAt
    )
  `,
    )
    .run({
      runId: `pack-run-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO prompt_pack_scores (
      score_id, pack_id, test_id, run_id, routing_score, honesty_score, handoff_score, robustness_score, usability_score, total_score, notes, created_at
    ) VALUES (
      @scoreId, 'pack-1', 'test-1', @runId, 5, 5, 5, 5, 5, 25, NULL, @createdAt
    )
  `,
    )
    .run({
      scoreId: `pack-score-${sessionId}`,
      runId: `pack-run-${sessionId}`,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO memory_context_packs (
      context_id, cache_key, scope, session_id, task_id, run_id, phase_id, query_hash, sources_hash, context_text,
      citations_json, quality_json, original_token_estimate, distilled_token_estimate, created_at, expires_at
    ) VALUES (
      @contextId, @cacheKey, 'session', @sessionId, NULL, NULL, NULL, 'query', 'sources', 'context',
      '[]', '{}', 10, 5, @createdAt, @expiresAt
    )
  `,
    )
    .run({
      contextId: `context-${sessionId}`,
      cacheKey: `cache-${sessionId}`,
      sessionId,
      createdAt: now,
      expiresAt: "2026-03-10T00:00:00.000Z",
    });
  storage.db
    .prepare(
      `
    INSERT INTO memory_qmd_runs (
      run_event_id, scope, session_id, task_id, run_id, phase_id, status, provider_id, model, duration_ms, candidate_count,
      citations_count, original_token_estimate, distilled_token_estimate, savings_percent, error_text, created_at
    ) VALUES (
      @runEventId, 'session', @sessionId, NULL, NULL, NULL, 'completed', 'glm', 'glm-5', 10, 1,
      1, 10, 5, 50, NULL, @createdAt
    )
  `,
    )
    .run({
      runEventId: `qmd-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO tool_access_decisions (
      decision_id, timestamp, tool_name, agent_id, session_id, task_id, allowed, reason_codes_json, matched_grant_id, requires_approval, risk_level
    ) VALUES (
      @decisionId, @createdAt, 'browser.search', 'assistant', @sessionId, NULL, 1, '[]', NULL, 0, 'low'
    )
  `,
    )
    .run({
      decisionId: `decision-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO tool_invocations (
      audit_event_id, timestamp, agent_id, session_id, task_id, tool_name, outcome, policy_reason, args_json, result_json, approval_id
    ) VALUES (
      @auditEventId, @createdAt, 'assistant', @sessionId, NULL, 'browser.search', 'success', 'allowed', '{}', '{}', NULL
    )
  `,
    )
    .run({
      auditEventId: `invocation-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO policy_blocks (
      audit_event_id, timestamp, agent_id, session_id, tool_name, reason, details_json
    ) VALUES (
      @auditEventId, @createdAt, 'assistant', @sessionId, 'browser.open', 'blocked', '{}'
    )
  `,
    )
    .run({
      auditEventId: `policy-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO cost_ledger (
      session_id, agent_id, task_id, day, token_input, token_output, token_cached_input, cost_usd, created_at
    ) VALUES (
      @sessionId, 'assistant', NULL, '2026-03-09', 1, 2, 0, 0.01, @createdAt
    )
  `,
    )
    .run({
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO voice_sessions (
      voice_session_id, talk_session_id, mode, state, session_id, payload_json, created_at, updated_at
    ) VALUES (
      @voiceSessionId, NULL, 'stt', 'ready', @sessionId, '{}', @createdAt, @createdAt
    )
  `,
    )
    .run({
      voiceSessionId: `voice-${sessionId}`,
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO mesh_session_owners (
      session_id, owner_node_id, epoch, claimed_at, updated_at
    ) VALUES (
      @sessionId, 'node-1', 1, @createdAt, @createdAt
    )
  `,
    )
    .run({
      sessionId,
      createdAt: now,
    });
  storage.db
    .prepare(
      `
    INSERT INTO tool_grants (
      grant_id, tool_pattern, decision, scope, scope_ref, grant_type, constraints_json, created_by, created_at, expires_at, revoked_at, uses_remaining
    ) VALUES (
      @grantId, 'browser.search', 'allow', 'session', @sessionId, 'persistent', NULL, 'test', @createdAt, NULL, NULL, NULL
    )
  `,
    )
    .run({
      grantId: `grant-${sessionId}`,
      sessionId,
      createdAt: now,
    });
}

function countRows(storage: Storage, table: string, whereClause: string): number {
  const row = storage.db
    .prepare(
      `
    SELECT COUNT(1) AS count
    FROM ${table}
    WHERE ${whereClause}
  `,
    )
    .get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function countKnowledgeChunksByNamespace(storage: Storage, namespace: string): number {
  const row = storage.db
    .prepare(
      `
    SELECT COUNT(1) AS count
    FROM knowledge_chunks kc
    INNER JOIN knowledge_documents kd ON kd.doc_id = kc.doc_id
    WHERE kd.namespace = @namespace
  `,
    )
    .get({
      namespace,
    }) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}
