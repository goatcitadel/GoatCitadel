import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { EvidenceEnvelopeRepository } from "./evidence-envelope-repo.js";
import type { DatabaseClient, DbStatement } from "./db.js";

const createdFiles: string[] = [];
const createdDbs: DatabaseClient[] = [];

afterEach(() => {
  for (const db of createdDbs.splice(0)) {
    db.close();
  }
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createRepo(): EvidenceEnvelopeRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-evidence-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  createdDbs.push(db);
  return new EvidenceEnvelopeRepository(db);
}

describe("EvidenceEnvelopeRepository", () => {
  it("persists hash-linked unsigned local envelopes", () => {
    const repo = createRepo();

    const first = repo.create({
      envelopeId: "env-1",
      eventKind: "tool_invocation",
      sessionId: "session-1",
      contentHash: "hash-1",
      payloadHash: "payload-1",
      toolCallHashes: ["tool-hash-1"],
      signatureStatus: "unsigned_local",
      metadata: { toolName: "browser.open" },
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const second = repo.create({
      envelopeId: "env-2",
      eventKind: "memory_write",
      sessionId: "session-1",
      contentHash: "hash-2",
      previousEnvelopeHash: first.contentHash,
      payloadHash: "payload-2",
      memoryLineage: ["turn-1"],
      signatureStatus: "unsigned_local",
      metadata: { decision: { decision: "proposed" } },
      createdAt: "2026-05-04T00:00:01.000Z",
    });

    assert.equal(second.previousEnvelopeHash, "hash-1");
    assert.equal(repo.latest()?.envelopeId, "env-2");
    assert.deepEqual(
      repo.list({ sessionId: "session-1" }).map((item) => item.envelopeId),
      ["env-2", "env-1"],
    );
    assert.deepEqual(repo.get("env-1")?.toolCallHashes, ["tool-hash-1"]);
  });

  it("handles missing rows, blank filters, malformed JSON, and create readback fallback", () => {
    const repo = createRepo();

    assert.equal(repo.get("missing-envelope"), undefined);
    assert.equal(repo.latest(), undefined);

    const full = repo.create({
      envelopeId: "env-full",
      eventKind: "approval_resolution",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      approvalId: "approval-1",
      contentHash: "content-full",
      previousEnvelopeHash: "content-prev",
      payloadHash: "payload-full",
      toolCallHashes: ["tool-1"],
      memoryLineage: ["memory-1"],
      policyHash: "policy-1",
      signatureStatus: "signed_hmac",
      signature: "sig-1",
      metadata: { decision: "approve" },
      createdAt: "2026-05-04T00:00:02.000Z",
    });
    assert.equal(full.turnId, "turn-1");
    assert.equal(full.approvalId, "approval-1");
    assert.equal(full.signature, "sig-1");

    const db = (repo as unknown as { db: DatabaseClient }).db;
    db.prepare(
      `
      UPDATE runtime_evidence_envelopes
      SET tool_call_hashes_json = ?,
          memory_lineage_json = ?,
          metadata_json = ?
      WHERE envelope_id = ?
    `,
    ).run("{bad", "{bad", "{bad", "env-full");

    const malformed = repo.get("env-full");
    assert.deepEqual(malformed?.toolCallHashes, []);
    assert.deepEqual(malformed?.memoryLineage, []);
    assert.deepEqual(malformed?.metadata, {});
    assert.deepEqual(
      repo.list({ sessionId: " ", turnId: " ", runId: " ", limit: 0 }).map((item) => item.envelopeId),
      ["env-full"],
    );

    const fallbackRepo = new EvidenceEnvelopeRepository(new EvidenceFallbackDatabase());
    const fallback = fallbackRepo.create({
      envelopeId: "env-fallback",
      eventKind: "tool_invocation",
      contentHash: "content-fallback",
      payloadHash: "payload-fallback",
      signatureStatus: "unsigned_local",
      createdAt: "2026-05-12T00:00:00.000Z",
    });
    assert.deepEqual(fallback, {
      envelopeId: "env-fallback",
      eventKind: "tool_invocation",
      sessionId: undefined,
      turnId: undefined,
      runId: undefined,
      approvalId: undefined,
      contentHash: "content-fallback",
      previousEnvelopeHash: undefined,
      payloadHash: "payload-fallback",
      toolCallHashes: [],
      memoryLineage: [],
      policyHash: undefined,
      signatureStatus: "unsigned_local",
      signature: undefined,
      metadata: {},
      createdAt: "2026-05-12T00:00:00.000Z",
    });
    assert.deepEqual(fallbackRepo.list(), []);
  });

  it("casts optional list filters for postgres null parameters", () => {
    const db = new EvidenceSqlCaptureDatabase("postgres");
    new EvidenceEnvelopeRepository(db);

    const listSql = db.sql.find((sql) => sql.includes("session_id") && sql.includes("ORDER BY created_at"));
    assert.ok(listSql);
    assert.match(listSql, /\(@sessionId::text IS NULL OR session_id = @sessionId::text\)/);
    assert.match(listSql, /\(@turnId::text IS NULL OR turn_id = @turnId::text\)/);
    assert.match(listSql, /\(@runId::text IS NULL OR run_id = @runId::text\)/);
  });
});

class EvidenceSqlCaptureDatabase implements DatabaseClient {
  public readonly sql: string[] = [];

  public constructor(public readonly dialect: DatabaseClient["dialect"]) {}

  public prepare(sql: string): DbStatement {
    this.sql.push(sql);
    return new EvidenceFakeStatement({});
  }

  public exec(): void {}

  public close(): void {}

  public transaction<T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return callback();
  }
}

class EvidenceFallbackDatabase implements DatabaseClient {
  public readonly dialect = "sqlite" as const;

  public prepare(sql: string): DbStatement {
    if (sql.includes("INSERT INTO runtime_evidence_envelopes")) {
      return new EvidenceFakeStatement({ run: () => ({ changes: 1 }) });
    }
    if (sql.includes("SELECT * FROM runtime_evidence_envelopes WHERE envelope_id")) {
      return new EvidenceFakeStatement({ get: () => undefined });
    }
    if (sql.includes("ORDER BY created_at DESC, envelope_id DESC")) {
      return new EvidenceFakeStatement({ get: () => undefined });
    }
    return new EvidenceFakeStatement({ all: () => undefined as unknown as unknown[] });
  }

  public exec(): void {}

  public close(): void {}

  public transaction<T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return callback();
  }
}

class EvidenceFakeStatement implements DbStatement {
  public constructor(
    private readonly handlers: {
      run?: (...params: unknown[]) => { changes: number };
      get?: (...params: unknown[]) => unknown;
      all?: (...params: unknown[]) => unknown[];
    },
  ) {}

  public run(...params: unknown[]): { changes: number } {
    return this.handlers.run?.(...params) ?? { changes: 0 };
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    return this.handlers.get?.(...params) as T | undefined;
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    return (this.handlers.all?.(...params) ?? []) as T[];
  }
}
