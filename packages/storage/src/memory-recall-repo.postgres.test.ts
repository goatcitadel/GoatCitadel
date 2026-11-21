import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "real PostgreSQL worker graph indexes scoped history and rejects stale recall after forgetting",
  { skip: !connectionString, timeout: 240_000 },
  async (t) => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "memory_corpus");
    const root = await mkdtemp(path.join(os.tmpdir(), "gc-memory-worker-"));
    const scoped = new URL(connectionString!);
    scoped.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    const worker = createPostgresRemoteStorage({
      connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1) },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
      startupWaitTimeoutMs: 120_000,
    });
    t.after(async () => {
      try {
        await worker.close();
      } catch (error) {
        t.diagnostic(`Worker cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
      await scope.teardown();
      if (
        !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(root).startsWith("gc-memory-worker-")
      )
        throw new Error("Unsafe fixture cleanup path");
      await rm(root, { recursive: true, force: true });
    });
    try {
      await worker.waitUntilReady();
      const now = "2026-11-18T00:00:00.000Z";
      await worker.sessions.upsert({
        sessionId: "dm",
        sessionKey: "dm",
        kind: "dm",
        channel: "web",
        account: "operator",
        timestamp: now,
      });
      await worker.chatSessionMeta.ensure("dm", now, "default");
      await worker.chatSessionMeta.patch("dm", { origin: "operator" });
      await worker.chatMessages.upsert({
        sessionId: "dm",
        messageId: "pg-user",
        role: "user",
        actorType: "user",
        actorId: "operator",
        sourceAuthority: "operator",
        content: "Keep the original requirement. " + "x".repeat(500),
        timestamp: now,
      });
      await worker.chatMessages.upsert({
        sessionId: "dm",
        messageId: "pg-assistant",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        sourceAuthority: "agent_proposed",
        content: "Completed the review",
        timestamp: now,
      });
      await worker.chatTurnTraces.create({
        sessionId: "dm",
        turnId: "pg-turn",
        userMessageId: "pg-user",
        assistantMessageId: "pg-assistant",
        status: "completed",
        finishedAt: now,
        completion: { status: "complete", repaired: false, providerCallCount: 1 },
        mode: "chat",
        webMode: "off",
        memoryMode: "auto",
        thinkingLevel: "standard",
      });
      const sourceInput = { workspaceId: "default", sessionId: "dm", turnIds: ["pg-turn"] };
      const source = await worker.memoryLearnings.readConsolidationSource(sourceInput);
      const operatorSource = await worker.memoryLearnings.readOperatorSource({
        workspaceId: "default",
        sessionId: "dm",
        messageId: "pg-user",
      });
      assert.ok(source);
      assert.ok(operatorSource);
      scope.db
        .prepare("UPDATE chat_messages SET content=content || ' late correction' WHERE message_id='pg-user'")
        .run();
      assert.notEqual(
        (await worker.memoryLearnings.readConsolidationSource(sourceInput))?.sourceHash,
        source.sourceHash,
      );
      assert.notEqual(
        (
          await worker.memoryLearnings.readOperatorSource({
            workspaceId: "default",
            sessionId: "dm",
            messageId: "pg-user",
          })
        )?.sourceHash,
        operatorSource.sourceHash,
      );
      const old = await worker.memoryLearnings.insert({
        learningId: "pg-old",
        workspaceId: "default",
        key: "Kestrel",
        type: "operator_preference",
        insight: "Kestrel deploys on port 45433",
        confidence: 0.8,
        status: "trusted",
        authority: "operator",
        sourceRefs: [],
        fileRefs: [],
        createdAt: now,
        updatedAt: now,
      });
      const request = { workspaceId: "default", sessionId: "dm", query: "Kestrel port", limit: 40 };
      const result = await worker.memoryRecall.searchEligibleCorpus(request);
      assert.equal(result.hits[0]?.sourceRef, "pg-old");
      assert.equal(result.hits[0]?.sourceHash, old.sourceHash);
      assert.equal(result.coverage.lexicalStatus, "ready");
      assert.deepEqual(
        (await worker.memoryRecall.searchEligibleCorpus({ ...request, workspaceId: "foreign" })).hits,
        [],
      );
      const document = await worker.knowledge.createDocumentWithChunks(
        {
          namespace: "notes",
          sourceType: "memory",
          sourceRef: "operator-note",
          title: "Scoped note",
          workspaceId: "default",
        },
        [{ content: "Kestrel accepts only a local connection" }],
      );
      const notes = await worker.memoryRecall.searchEligibleCorpus({ ...request, sourceTypes: ["knowledge_chunk"] });
      assert.equal(notes.hits[0]?.docId, document.document.docId);
      await worker.knowledge.createDocumentWithChunks(
        { namespace: "notes", sourceType: "memory", sourceRef: "legacy", title: "Unowned" },
        [{ content: "Kestrel legacy must stay outside recall" }],
      );
      assert.equal(
        (await worker.memoryRecall.searchEligibleCorpus({ ...request, sourceTypes: ["knowledge_chunk"] })).hits.length,
        1,
      );
      scope.db.prepare("UPDATE memory_learnings SET status = 'forgotten' WHERE learning_id = ?").run("pg-old");
      assert.deepEqual(
        await worker.memoryRecall.getEligibleSources({
          workspaceId: "default",
          sessionId: "dm",
          sources: [{ sourceType: "memory_learning", sourceRef: "pg-old" }],
        }),
        [],
      );
      assert.equal(
        (await worker.memoryRecall.searchEligibleCorpus(request)).hits.some((hit) => hit.sourceRef === "pg-old"),
        false,
      );
      await worker.memoryConsolidationProgress.readProgress("default");
    } catch (error) {
      t.diagnostic(error instanceof Error ? (error.stack ?? error.message) : String(error));
      throw error;
    }
  },
);
