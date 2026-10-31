import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  CodeModeReadiness,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { executeTool } from "@goatcitadel/policy-engine";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { CapabilitySystemService, type ApprovedCodeModeRequest } from "./capability-system-service.js";

// Each case spawns a real Code Mode child process; a contended Windows host needs headroom.
const RUN_TIMEOUT_MS = 60_000;
const READY: CodeModeReadiness = { enabled: true, sandboxEnabled: true, sandboxSupported: true, canRun: true };

const roots: string[] = [];
let fixtureCount = 0;
// One migrated in-memory database for the file; every fixture uses its own session, turn and root.
let shared: { storage: Storage; asyncStorage: ReturnType<typeof createSqliteAsyncStorage>; dir: string } | undefined;

function sharedStorage() {
  if (!shared) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-code-mode-request-db-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(dir, "transcripts"),
      auditDir: path.join(dir, "audit"),
    });
    shared = { storage, asyncStorage: createSqliteAsyncStorage(storage), dir };
  }
  return shared;
}

// Migrating the schema dominates wall time on a contended host; pay it once, outside the per-test budget.
beforeAll(() => {
  sharedStorage();
}, 300_000);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (shared) {
    await shared.asyncStorage.close();
    fs.rmSync(shared.dir, { recursive: true, force: true });
    shared = undefined;
  }
});

describe("CapabilitySystemService.keepCodeModeRunAsCandidate", { timeout: RUN_TIMEOUT_MS }, () => {
  it("keeps a finished chat run as a candidate", async () => {
    const fx = createFixture();
    const source = "return { pages: 3 };";
    const { runId } = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest(source));

    const kept = await fx.service.keepCodeModeRunAsCandidate(runId, { name: "Count Pages", summary: "Counts pages." });

    const run = await fx.service.getCodeModeRun(runId);
    const version = await fx.asyncStorage.candidateSkillVersions.find(kept.versionId);
    expect(version).toMatchObject({
      candidateId: kept.candidateId,
      sourceKind: "code_mode_generated",
      title: "Count Pages",
    });
    expect(version?.lifecycleState).toBe("candidate");
    const program = fs.readFileSync(path.resolve(fx.root, version!.programArtifact.relPath), "utf8");
    expect(sha256(program)).toBe(run.codeHash);
    expect(kept.revision).toBeGreaterThanOrEqual(1);
  });

  it("keeping the same run again returns the same candidate", async () => {
    // After a reload the card offers Keep as a tool again; a second keep must not stage a second candidate.
    const fx = createFixture();
    const { runId } = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest("return { pages: 2 };"));
    const input = { name: "Count Pages", summary: "Counts pages." };

    const first = await fx.service.keepCodeModeRunAsCandidate(runId, input);
    const second = await fx.service.keepCodeModeRunAsCandidate(runId, input);

    expect(second).toEqual(first);
    expect(await fx.asyncStorage.candidateSkillVersions.listByCandidateId(first.candidateId, 10)).toHaveLength(1);
  });

  it("refuses a failed run", async () => {
    const fx = createFixture();
    const { runId } = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest("throw new Error('boom');"));
    await expect(fx.service.keepCodeModeRunAsCandidate(runId, { name: "x", summary: "y" })).rejects.toThrow(
      "Only a finished Code Mode run from Chat can be kept.",
    );
  });

  it("refuses a run without a chat approval source", async () => {
    const fx = createFixture();
    const run = await fx.service.createCodeModeRun({ language: "javascript", source: "return { ok: true };" });
    // Finish the code_mode.run first, so only the missing Chat approval source can refuse it.
    fx.storage.approvals.resolve(run.approvalId!, { decision: "approve", resolvedBy: "operator-1" });
    await fx.service.executeApprovedCodeModeRun(run.approvalId!);
    const completed = await fx.service.getCodeModeRun(run.runId);
    expect(completed.status).toBe("completed");
    expect(completed).not.toHaveProperty("approvalSource");
    await expect(fx.service.keepCodeModeRunAsCandidate(run.runId, { name: "x", summary: "y" })).rejects.toThrow(
      "Only a finished Code Mode run from Chat can be kept.",
    );
  });
});

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-code-mode-request-")));
  roots.push(root);
  const { storage, asyncStorage } = sharedStorage();
  fixtureCount += 1;
  const fixtureId = fixtureCount;
  let turnCount = 0;
  const sessionId = `session-request-${fixtureId}`;
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: new Date().toISOString(),
  });
  storage.chatSessionMeta.ensure(sessionId, new Date().toISOString(), "default");

  const toolConfig: ToolPolicyConfig = {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
  const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
    const result = await executeTool(
      { toolName: request.toolName, args: request.args, agentId: request.agentId, sessionId: request.sessionId },
      toolConfig,
      asyncStorage,
    );
    return { outcome: "executed", policyReason: "executed", auditEventId: `audit-${fixtureId}`, result };
  });
  const createApproval = vi.fn(async (input: ApprovalCreateInput) => storage.approvals.create(input));
  const spawnCodeModeChild = vi.fn(((...args: Parameters<typeof spawn>) => spawn(...args)) as typeof spawn);
  const service = new CapabilitySystemService({
    rootDir: root,
    runtimeConfig: {
      candidateRoot: "./data/capability-candidates",
      codeModeArtifactRoot: "./data/code-mode-artifacts",
      tempRoot: "./data/code-mode-temp",
      // Runs unsandboxed in the test process tree; readiness is stubbed below.
      codeModeSandbox: { mode: "best_effort_host", required: false, bestEffortHostEnabled: false },
      codeModeDockerBackend: { enabled: false },
      codeModeAiderAdapter: { enabled: false },
    },
    storage: asyncStorage,
    readFeatureFlags: async () => ({ codeModeV1Enabled: true }),
    listToolCatalog: () => [docsExtractTextTool()],
    listLoadedSkills: () => [],
    readSkillStates: async () => new Map(),
    invokeTool,
    createApproval,
    resolveApproval: vi.fn(),
    publishRealtime: vi.fn(async () => undefined),
    readPolicySnapshot: async () => ({ mode: "test" }),
    spawnCodeModeChild,
  });
  const readiness = vi.spyOn(service, "getCodeModeReadiness").mockResolvedValue(READY);

  const approvedRequest = (
    source: string,
    options: {
      input?: Record<string, unknown>;
      resolve?: boolean;
      /** Register the policy engine's tool.invoke pending action (default true). */
      pendingAction?: boolean;
      pendingSource?: string;
      pendingToolName?: string;
    } = {},
  ): ApprovedCodeModeRequest => {
    turnCount += 1;
    const turnId = `turn-request-${fixtureId}-${turnCount}`;
    storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: `message-${turnId}`,
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: new Date().toISOString(),
    });
    const goal = "count the pages";
    const approval = storage.approvals.create({
      kind: "code_mode.request",
      riskLevel: "danger",
      payload: { goal, source },
      preview: { goal },
      linkage: { sessionId, turnId },
    });
    if (options.pendingAction !== false) {
      storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "tool.invoke",
        request: {
          toolName: options.pendingToolName ?? "code_mode.request",
          args: { goal, source: options.pendingSource ?? source },
          sessionId,
        },
      });
    }
    if (options.resolve !== false) {
      storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator-1" });
    }
    return {
      approvalId: approval.approvalId,
      approvedSourceSha256: sha256(source),
      goal,
      language: "javascript",
      source,
      ...(options.input ? { input: options.input } : {}),
      sessionId,
      turnId,
      policyContext: { operatorId: "operator-1", sessionId, surface: "chat" },
    };
  };

  return {
    root,
    storage,
    asyncStorage,
    service,
    readiness,
    invokeTool,
    createApproval,
    spawnCodeModeChild,
    approvedRequest,
  };
}

function docsExtractTextTool(): ToolCatalogEntry {
  return {
    toolName: "docs.extract_text",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Extract plain text from a PDF, DOCX or text file.",
    argSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 } } },
    examples: [],
    pack: "knowledge",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
