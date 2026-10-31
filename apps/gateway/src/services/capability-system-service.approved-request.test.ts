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
import {
  CODE_MODE_REQUEST_RESULT_MAX_BYTES,
  CapabilitySystemService,
  type ApprovedCodeModeRequest,
} from "./capability-system-service.js";

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

describe("CapabilitySystemService.runApprovedCodeModeRequest", { timeout: RUN_TIMEOUT_MS }, () => {
  it("runs approved source and returns the guest result", async () => {
    const fx = createFixture();
    const source = "return { pages: 3 };";
    const request = fx.approvedRequest(source);

    const result = await fx.service.runApprovedCodeModeRequest(request);

    expect(result).toMatchObject({ status: "completed", result: { pages: 3 } });
    expect(result.result).toEqual({ pages: 3 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const run = await fx.service.getCodeModeRun(result.runId);
    expect(run).toMatchObject({
      status: "completed",
      approvalId: request.approvalId,
      approvalSource: { kind: "code_mode.request", approvalId: request.approvalId },
      originSurface: "chat",
      sessionId: request.sessionId,
      turnId: request.turnId,
      requestedOutputIntent: request.goal,
      saveCandidateOnSuccess: false,
    });
    expect(run.codeHash).toBe(sha256(source));
    // No second approval: the run is bound to the code_mode.request tool approval.
    expect(fx.createApproval).not.toHaveBeenCalled();
  });

  it("projects approvalSource on every read path but never stores it", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { ok: true };");
    const { runId } = await fx.service.runApprovedCodeModeRequest(request);
    const expected = { kind: "code_mode.request", approvalId: request.approvalId };

    // The real repository round-trip drops the field: it is computed, not persisted.
    const stored = await fx.asyncStorage.codeModeRuns.get(runId);
    expect(stored).not.toHaveProperty("approvalSource");
    await fx.asyncStorage.codeModeRuns.upsert({ ...stored, approvalSource: expected } as typeof stored);
    expect(await fx.asyncStorage.codeModeRuns.get(runId)).not.toHaveProperty("approvalSource");

    expect((await fx.service.getCodeModeRun(runId)).approvalSource).toEqual(expected);
    const listed = await fx.service.listCodeModeRuns({ sessionId: request.sessionId, limit: 10 });
    expect(listed.find((run) => run.runId === runId)?.approvalSource).toEqual(expected);
    const scoped = await fx.service.getCodeModeRunInScope(runId, { sessionId: request.sessionId });
    expect(scoped.approvalSource).toEqual(expected);

    // The hashed policy snapshot carries the binding as durable evidence.
    const snapshot = JSON.parse(
      fs.readFileSync(path.resolve(fx.root, stored.policySnapshotArtifact.relPath), "utf8"),
    ) as Record<string, unknown>;
    expect(snapshot.codeModeApprovalSource).toEqual({
      ...expected,
      approvedSourceSha256: request.approvedSourceSha256,
    });
    expect(sha256(JSON.stringify(snapshot))).toBe(stored.policySnapshotHash);
  });

  it("does not project approvalSource for a code_mode.run approval", async () => {
    const fx = createFixture();
    const run = await fx.service.createCodeModeRun({ language: "javascript", source: "return { ok: true };" });

    expect(run.approvalId).toBeDefined();
    expect(run).not.toHaveProperty("approvalSource");
    expect(await fx.service.getCodeModeRun(run.runId)).not.toHaveProperty("approvalSource");
  });

  it("refuses when the approved hash does not match the source", async () => {
    const fx = createFixture();
    const request = {
      ...fx.approvedRequest("return { pages: 3 };"),
      approvedSourceSha256: sha256("return { pages: 4 };"),
    };

    await expect(fx.service.runApprovedCodeModeRequest(request)).rejects.toThrow(/does not match the approved code/);
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
    expect(await fx.service.listCodeModeRuns({ sessionId: request.sessionId, limit: 10 })).toEqual([]);
  });

  it("refuses when Code Mode cannot run", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");

    fx.readiness.mockResolvedValue({ ...READY, enabled: false, canRun: false, reason: "code_mode_off" });
    await expect(fx.service.runApprovedCodeModeRequest(request)).rejects.toThrow(/Code Mode is off/);
    fx.readiness.mockResolvedValue({ ...READY, sandboxEnabled: false, canRun: false, reason: "sandbox_off" });
    await expect(fx.service.runApprovedCodeModeRequest(request)).rejects.toThrow(/sandbox/);
    fx.readiness.mockResolvedValue({
      ...READY,
      sandboxSupported: false,
      canRun: false,
      reason: "sandbox_unsupported",
    });
    await expect(fx.service.runApprovedCodeModeRequest(request)).rejects.toThrow(/sandbox/);

    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
    expect(await fx.service.listCodeModeRuns({ sessionId: request.sessionId, limit: 10 })).toEqual([]);
  });

  it("refuses an approval that is not an approved code_mode.request", async () => {
    const fx = createFixture();
    const pendingRequest = fx.approvedRequest("return { pages: 3 };", { resolve: false });
    await expect(fx.service.runApprovedCodeModeRequest(pendingRequest)).rejects.toThrow(/is pending, not approved/);

    const otherKind = fx.storage.approvals.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });
    fx.storage.approvals.resolve(otherKind.approvalId, { decision: "approve", resolvedBy: "operator-1" });
    await expect(
      fx.service.runApprovedCodeModeRequest({ ...pendingRequest, approvalId: otherKind.approvalId }),
    ).rejects.toThrow(/shell\.exec approval and cannot run a Code Mode request/);

    const otherTurn = fx.approvedRequest("return { pages: 3 };");
    await expect(
      fx.service.runApprovedCodeModeRequest({ ...otherTurn, turnId: pendingRequest.turnId }),
    ).rejects.toThrow(/belongs to a different chat turn/);
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });

  it("returns the recorded outcome when the same approval is delivered again", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");

    const first = await fx.service.runApprovedCodeModeRequest(request);
    const second = await fx.service.runApprovedCodeModeRequest(request);

    expect(second).toMatchObject({ runId: first.runId, status: "completed", result: { pages: 3 } });
    expect(fx.spawnCodeModeChild).toHaveBeenCalledTimes(1);
  });

  it("does not post the separate final transcript message", async () => {
    const fx = createFixture();
    const enqueue = vi.spyOn(
      fx.service as unknown as { enqueueCodeModeFinalTranscript: (run: unknown) => Promise<boolean> },
      "enqueueCodeModeFinalTranscript",
    );
    const request = fx.approvedRequest("return { pages: 3 };");

    const { runId } = await fx.service.runApprovedCodeModeRequest(request);

    expect(enqueue).not.toHaveBeenCalled();
    const stored = await fx.asyncStorage.codeModeRuns.get(runId);
    // Settled as delivered, so the boot reconciler never posts it later either.
    expect(stored.executionRecovery.finalTranscriptEnqueuedAt).toBeDefined();
    const eventId = stored.executionRecovery.finalTranscriptEventId!;
    await fx.service.reconcileCodeModeFinalTranscriptDeliveries();
    expect(await fx.asyncStorage.transcriptOutbox.get(eventId)).toBeUndefined();

    // Regression: the code_mode.run approval path still posts its final transcript.
    const run = await fx.service.createCodeModeRun({ language: "javascript", source: "return { ok: true };" });
    fx.storage.approvals.resolve(run.approvalId!, { decision: "approve", resolvedBy: "operator-1" });
    await expect(fx.service.executeApprovedCodeModeRun(run.approvalId!)).resolves.toMatchObject({
      result: { status: "completed" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
  });

  it("guest can call docs.extract_text", async () => {
    const fx = createFixture();
    const pdfPath = path.join(fx.root, "report.pdf");
    fs.writeFileSync(pdfPath, buildMinimalPdf("Quarterly revenue grew"));
    // The harness nests wrapper names by their dots, so guest code uses the dotted accessor form.
    const source =
      'const bracket = typeof capabilities["docs.extract_text"]; ' +
      "const extracted = await capabilities.docs.extract_text({ path: input.path }); " +
      "return { bracket, format: extracted.format, text: extracted.text };";

    const result = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(source, { input: { path: pdfPath } }),
    );

    expect(result.status).toBe("completed");
    const value = result.result as { bracket: string; format: string; text: string };
    expect(value.format).toBe("pdf");
    expect(value.text).toContain("Quarterly revenue grew");
    expect(value.bracket).toBe("undefined");
    expect(fx.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "docs.extract_text", args: { path: pdfPath } }),
    );
  });

  it("caps a huge return value", async () => {
    const fx = createFixture();
    // Large enough to pass the 64 KB turn cap, small enough for the 128 KB child IPC message bound.
    const source = 'return "x".repeat(100000);';

    const result = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest(source));

    expect(result.status).toBe("completed");
    const serialized = JSON.stringify({ value: "x".repeat(100_000) });
    expect(result.result).toEqual({
      truncated: true,
      preview: serialized.slice(0, CODE_MODE_REQUEST_RESULT_MAX_BYTES),
    });
  });

  it("fails a return value larger than the child IPC message bound", async () => {
    const fx = createFixture();

    const result = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest('return "x".repeat(1024 * 1024);'));

    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/maximum allowed size/) });
    expect(result).not.toHaveProperty("result");
  });

  it("keeps a code_mode.request run out of the code_mode.run read-path terminalizers", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { ok: true };");
    const { runId } = await fx.service.runApprovedCodeModeRequest(request);
    const stored = await fx.asyncStorage.codeModeRuns.get(runId);
    // A pending request run whose approval looks expired to the code_mode.run expiry check.
    const expiredApproval = fx.storage.approvals.create({
      kind: "code_mode.request",
      riskLevel: "danger",
      payload: {},
      preview: {},
      expiresAt: new Date(Date.now() + 50).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pendingRunId = `${runId}-pending`;
    await fx.asyncStorage.codeModeRuns.upsert({
      ...stored,
      runId: pendingRunId,
      status: "approval_pending",
      approvalId: expiredApproval.approvalId,
      executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
      startedAt: undefined,
      finishedAt: undefined,
    });

    const read = await fx.service.getCodeModeRun(pendingRunId);

    expect(read.status).toBe("approval_pending");
    expect(read.approvalSource).toEqual({ kind: "code_mode.request", approvalId: expiredApproval.approvalId });
    expect((await fx.asyncStorage.codeModeRuns.get(pendingRunId)).status).toBe("approval_pending");
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
    options: { input?: Record<string, unknown>; resolve?: boolean } = {},
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
    argSchema: { type: "object", properties: { path: { type: "string" } } },
    examples: [],
    pack: "knowledge",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
  };
}

/** A one-page PDF with a single line of Helvetica text and a correct xref table. */
function buildMinimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
