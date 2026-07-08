import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, Storage, TranscriptLog } from "@goatcitadel/storage";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
import type { ServiceContext } from "./service-context.js";
import { createPostgresDialectStrictDb } from "./testing/postgres-dialect-strict-db.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-pg-dialect-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });

  const storage = new Storage({
    db: createPostgresDialectStrictDb(rootDir),
    transcriptsDir,
    auditDir,
    // Keep the file-based logs so the sqlite-backed facade never has to serve
    // the postgres transcript/audit SQL variants.
    transcripts: new TranscriptLog(transcriptsDir),
    audit: new AuditLog(auditDir),
  });

  const ctx: ServiceContext = {
    storage,
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: () => undefined,
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    createChatCompletion: vi.fn(async () => ({
      id: "mock-chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readEffectiveBlockerTemplateStrictness: () => 1,
    readEffectiveRetryRepairThreshold: () => 0.5,
    readEffectiveLiveIntentThreshold: () => 0.5,
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;

  const service = new ImprovementService(ctx, callbacks);
  const harness = { rootDir, storage, service };
  harnesses.push(harness);
  return harness;
}

describe("ImprovementService on the postgres dialect", () => {
  it("completes the improvement ledger replay transaction path without sqlite-only exec", async () => {
    // Regression: the weekly improvement replay used raw `exec("BEGIN IMMEDIATE")`,
    // which is sqlite-only syntax and failed every run on Postgres deployments
    // with `syntax error at or near "IMMEDIATE"` (observed live 2026-07-06).
    const harness = createHarness();

    const result = await harness.service.runImprovementReplayManually({ sampleSize: 50 });

    expect(result.run.status).toBe("completed");
  });
});
