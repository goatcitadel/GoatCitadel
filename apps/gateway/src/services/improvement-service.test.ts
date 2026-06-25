import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
  type SurfaceRouteOverrideSignalInput,
} from "./improvement-service.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  published: Array<{
    channel: string;
    topic: string;
    payload: Record<string, unknown>;
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;
  }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService recordSurfaceRouteOverrideSignal", () => {
  it("persists a surface-route override as a human negative signal with the expected shape", () => {
    const harness = createHarness();

    const input: SurfaceRouteOverrideSignalInput = {
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      fromMode: "code",
      toMode: "chat",
      autoConfidence: 0.85,
      promptFeatureHash: "abc123",
    };

    harness.service.recordSurfaceRouteOverrideSignal(input);

    // Read the signal back by listing all signals in the DB
    const row = harness.storage.gatewaySql
      .prepare("SELECT * FROM improvement_signals WHERE signal_kind = ?")
      .get("surface_route_override") as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!["origin"]).toBe("human");
    expect(row!["signal_kind"]).toBe("surface_route_override");
    expect(row!["outcome"]).toBe("negative");

    const fingerprint = String(row!["fingerprint"]);
    expect(fingerprint).toContain("personal");
    expect(fingerprint).toContain("code");
    expect(fingerprint).toContain("chat");
  });

  it("returns void and does not throw on a valid input", () => {
    const harness = createHarness();

    const result = harness.service.recordSurfaceRouteOverrideSignal({
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s2",
      turnId: "t2",
      fromMode: "code",
      toMode: "chat",
      autoConfidence: 0.9,
      promptFeatureHash: "def456",
    });

    expect(result).toBeUndefined();
  });
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-surface-router-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir,
    auditDir,
  });
  const published: Harness["published"] = [];
  const harness = {
    rootDir,
    storage,
    service: undefined as unknown as ImprovementService,
    published,
  };
  const ctx: ImprovementServiceContext = {
    storage,
    gatewaySql: storage.gatewaySql,
    publishRealtime: (channel, topic, payload, realtimeOptions) => {
      published.push({ channel, topic, payload, options: realtimeOptions });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;

  harness.service = new ImprovementService(ctx, callbacks);
  harnesses.push(harness);
  return harness;
}
