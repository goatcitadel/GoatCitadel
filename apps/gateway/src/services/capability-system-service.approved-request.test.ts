import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  CodeModeReadiness,
  CodeModeRunRecord,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { createDefaultToolRegistry, executeTool } from "@goatcitadel/policy-engine";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import {
  CODE_MODE_REQUEST_RESULT_MAX_BYTES,
  CODE_MODE_REQUEST_RESULT_TOO_LARGE_ERROR,
  CapabilitySystemService,
  type ApprovedCodeModeRequest,
} from "./capability-system-service.js";
import { CODE_MODE_OFF_TOOL_ERROR, CODE_MODE_UNSUPPORTED_TOOL_ERROR } from "./code-mode-request-tool.js";
import { readToolDomainExecutionFailure } from "./tool-domain-result-truth.js";

// Each case spawns a real Code Mode child process; a contended Windows host needs headroom.
const RUN_TIMEOUT_MS = 60_000;
const READY: CodeModeReadiness = { enabled: true, sandboxEnabled: true, sandboxSupported: true, canRun: true };
/** The registry's file helpers a Code Mode script can be offered, including those that search across the read roots. */
const CODE_MODE_FILE_HELPER_TOOLS = createDefaultToolRegistry()
  .toCatalog()
  .filter((tool) =>
    ["fs.read", "file.read_range", "fs.stat", "fs.list", "file.find", "code.search", "code.search_files"].includes(
      tool.toolName,
    ),
  );
/** Guest code: runs one helper call and reports "ran", or the message it was refused with. */
const ATTEMPT_HELPER =
  "const attempt = async (call) => { try { await call(); return 'ran'; } " +
  "catch (error) { return String(error && error.message ? error.message : error); } };";

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

  it("refuses source the operator did not approve, even when the caller's source and hash agree", async () => {
    const fx = createFixture();
    const approvedSource = "return { pages: 3 };";
    const callerSource = "return { pages: 4 };";

    // The approval payload and the pending action both hold the approved source; the caller swaps in other code.
    const swapped = {
      ...fx.approvedRequest(approvedSource),
      source: callerSource,
      approvedSourceSha256: sha256(callerSource),
    };
    await expect(fx.service.runApprovedCodeModeRequest(swapped)).rejects.toThrow(/does not match the approved code/);

    // Only the pending action differs from the caller (the approval payload agrees with it): still refused.
    const pendingDiffers = fx.approvedRequest(callerSource, { pendingSource: approvedSource });
    await expect(fx.service.runApprovedCodeModeRequest(pendingDiffers)).rejects.toThrow(
      /does not match the approved code/,
    );

    // A pending action that is not a code_mode.request tool.invoke is refused too.
    const wrongAction = fx.approvedRequest(callerSource, { pendingToolName: "shell.exec" });
    await expect(fx.service.runApprovedCodeModeRequest(wrongAction)).rejects.toThrow(
      /does not match the approved code/,
    );

    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
    expect(await fx.service.listCodeModeRuns({ sessionId: swapped.sessionId, limit: 10 })).toEqual([]);
  });

  it("runs from the approval payload when no pending action was registered", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };", { pendingAction: false });

    await expect(fx.service.runApprovedCodeModeRequest(request)).resolves.toMatchObject({ status: "completed" });

    const noPendingSwap = fx.approvedRequest("return { pages: 3 };", { pendingAction: false });
    await expect(
      fx.service.runApprovedCodeModeRequest({
        ...noPendingSwap,
        source: "return { pages: 5 };",
        approvedSourceSha256: sha256("return { pages: 5 };"),
      }),
    ).rejects.toThrow(/does not match the approved code/);
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
    expect(second).not.toHaveProperty("manualReconciliationRequired");
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
      fx.approvedRequest(source, { input: { path: pdfPath }, reads: [pdfPath] }),
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

  it("lets a docs.* call read only a path or attachment in the approved reads", async () => {
    const fx = createFixture();
    fs.writeFileSync(path.join(fx.root, "approved.txt"), "approved text");
    fs.writeFileSync(path.join(fx.root, ".env"), "SECRET=1");
    const read = (args: string) =>
      `try { const page = await capabilities.docs.extract_text(${args}); return { text: page.text }; } ` +
      "catch (error) { return { refused: String(error && error.message ? error.message : error) }; }";

    // A relative entry matches the absolute path the code passes once both go through path resolution.
    const approved = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(read("{ path: input.path }"), {
        input: { path: path.join(fx.root, "approved.txt") },
        reads: ["approved.txt"],
      }),
    );
    expect(approved.result).toEqual({ text: "approved text" });

    // The goal and reads say approved.txt; the hidden input points elsewhere. The call is refused before it runs.
    const swapped = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(read("{ path: input.path }"), { input: { path: ".env" }, reads: ["approved.txt"] }),
    );
    expect((swapped.result as { refused: string }).refused).toMatch(/\.env.*not in the files approved for this run/);

    const attachment = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(read('{ attachmentId: "att-other" }'), { reads: ["att-approved"] }),
    );
    expect((attachment.result as { refused: string }).refused).toMatch(/att-other.*not in the files approved/);

    expect(fx.invokeTool).toHaveBeenCalledTimes(1);
    expect(fx.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "docs.extract_text", args: { path: path.join(fx.root, "approved.txt") } }),
    );
  });

  it("lets a run without approved reads read no files, and binds reads in the hashed policy snapshot", async () => {
    const fx = createFixture();
    fs.writeFileSync(path.join(fx.root, "notes.txt"), "notes");
    const source =
      "try { await capabilities.docs.extract_text({ path: input.path }); return { read: true }; } " +
      "catch (error) { return { refused: String(error && error.message ? error.message : error) }; }";

    const result = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(source, { input: { path: path.join(fx.root, "notes.txt") } }),
    );

    expect((result.result as { refused: string }).refused).toMatch(/not in the files approved for this run/);
    expect(fx.invokeTool).not.toHaveBeenCalled();
    const withReads = fx.approvedRequest("return { ok: true };", { reads: ["notes.txt"] });
    const { runId } = await fx.service.runApprovedCodeModeRequest(withReads);
    const stored = await fx.asyncStorage.codeModeRuns.get(runId);
    const snapshot = JSON.parse(
      fs.readFileSync(path.resolve(fx.root, stored.policySnapshotArtifact.relPath), "utf8"),
    ) as Record<string, unknown>;
    expect(snapshot.codeModeReads).toEqual(["notes.txt"]);
    expect(sha256(JSON.stringify(snapshot))).toBe(stored.policySnapshotHash);
  });

  it("runs fs.read, file.read_range and fs.stat only on a path in the approved reads", async () => {
    const fx = createFixture();
    fs.writeFileSync(path.join(fx.root, "approved.txt"), "line one\nline two");
    fs.writeFileSync(path.join(fx.root, "other.txt"), "SECRET=1");
    const source = [
      ATTEMPT_HELPER,
      "const tryAll = async (target) => ({",
      "  read: await attempt(() => capabilities.fs.read({ path: target })),",
      "  range: await attempt(() => capabilities.file.read_range({ path: target, startLine: 1, endLine: 1 })),",
      "  stat: await attempt(() => capabilities.fs.stat({ path: target })),",
      "});",
      "return { approved: await tryAll(input.approved), other: await tryAll(input.other) };",
    ].join("\n");

    const result = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(source, {
        input: { approved: path.join(fx.root, "approved.txt"), other: "other.txt" },
        reads: ["approved.txt"],
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.result).toEqual({
      approved: { read: "ran", range: "ran", stat: "ran" },
      other: {
        read: expect.stringMatching(/"other\.txt" is not in the files approved for this run, so fs\.read cannot/),
        range: expect.stringMatching(/"other\.txt" is not in the files approved .* file\.read_range cannot/),
        stat: expect.stringMatching(/"other\.txt" is not in the files approved .* fs\.stat cannot/),
      },
    });
    expect(fx.invokeTool.mock.calls.map(([call]) => [call.toolName, call.args.path])).toEqual([
      ["fs.read", path.join(fx.root, "approved.txt")],
      ["file.read_range", path.join(fx.root, "approved.txt")],
      ["fs.stat", path.join(fx.root, "approved.txt")],
    ]);
  });

  it("lists only a folder that is itself in the approved reads with fs.list", async () => {
    const fx = createFixture();
    fs.mkdirSync(path.join(fx.root, "approved-dir"));
    fs.writeFileSync(path.join(fx.root, "approved-dir", "a.txt"), "a");
    fs.mkdirSync(path.join(fx.root, "other-dir"));
    const source = [
      ATTEMPT_HELPER,
      "return {",
      "  approved: await attempt(() => capabilities.fs.list({ path: input.approved })),",
      "  other: await attempt(() => capabilities.fs.list({ path: input.other })),",
      "  file: await attempt(() => capabilities.fs.list({ path: input.file })),",
      // Without a path fs.list would list the workspace folder, which nobody approved.
      "  unnamed: await attempt(() => capabilities.fs.list({})),",
      "};",
    ].join("\n");

    const result = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(source, {
        input: { approved: path.join(fx.root, "approved-dir"), other: "other-dir", file: "approved-dir/a.txt" },
        reads: ["approved-dir"],
      }),
    );

    expect(result.result).toEqual({
      approved: "ran",
      other: expect.stringMatching(/"other-dir" is not in the files approved for this run, so fs\.list cannot/),
      file: expect.stringMatching(/"approved-dir\/a\.txt" is not in the files approved .* fs\.list cannot/),
      unnamed: expect.stringMatching(/fs\.list must name a file or folder approved for this run/),
    });
    expect(fx.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("refuses the helpers that search across the read roots, and leaves them out of the run's manifest", async () => {
    const fx = createFixture();
    const source =
      "return { code: typeof capabilities.code, find: typeof capabilities.file.find, " +
      "range: typeof capabilities.file.read_range, list: typeof capabilities.fs.list };";

    const result = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest(source));

    // The script never sees them...
    expect(result.result).toEqual({ code: "undefined", find: "undefined", range: "function", list: "function" });
    const stored = await fx.asyncStorage.codeModeRuns.get(result.runId);
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(fx.root, stored.wrapperManifestArtifact.relPath), "utf8"),
    ) as { wrappers: Array<{ name: string }> };
    expect(manifest.wrappers.map((wrapper) => wrapper.name).sort()).toEqual([
      "docs.extract_text",
      "file.read_range",
      "fs.list",
      "fs.read",
      "fs.stat",
    ]);
    expect(sha256(JSON.stringify(manifest))).toBe(stored.wrapperManifestHash);
    // ...and a call that reaches the gateway anyway is refused by name, even when it names an approved folder.
    const internals = fx.service as unknown as {
      assertCodeModeReadApproved(request: ToolInvokeRequest, approvedReads: readonly string[]): Promise<void>;
    };
    for (const toolName of ["code.search", "session.search", "file.find", "code.search_files"]) {
      await expect(
        internals.assertCodeModeReadApproved(
          { toolName, args: { path: fx.root, query: "SECRET" }, agentId: "code-mode", sessionId: "session-1" },
          [fx.root],
        ),
      ).rejects.toThrow(`${toolName} is not available in this run, which can read only the files approved for it.`);
    }
    expect(fx.invokeTool).not.toHaveBeenCalled();
  });

  it("refuses fs.read when the approved reads are empty", async () => {
    const fx = createFixture();
    fs.writeFileSync(path.join(fx.root, "notes.txt"), "notes");
    const source = `${ATTEMPT_HELPER}\nreturn { read: await attempt(() => capabilities.fs.read({ path: input.path })) };`;

    const result = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(source, { input: { path: path.join(fx.root, "notes.txt") }, reads: [] }),
    );

    expect((result.result as { read: string }).read).toMatch(/not in the files approved for this run, so fs\.read/);
    expect(fx.invokeTool).not.toHaveBeenCalled();
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

  it("fails a return value larger than the child IPC message bound with a plain error", async () => {
    const fx = createFixture();

    const result = await fx.service.runApprovedCodeModeRequest(fx.approvedRequest('return "x".repeat(1024 * 1024);'));

    expect(result).toMatchObject({ status: "failed" });
    expect(result.error).toBe("The code's result is too large to return (over 128 KB). Return a shorter result.");
    expect(result.error).toBe(CODE_MODE_REQUEST_RESULT_TOO_LARGE_ERROR);
    expect(result).not.toHaveProperty("result");
  });

  it("lets a guest page through a long document with docs.extract_text offsets", async () => {
    const fx = createFixture();
    const textPath = path.join(fx.root, "long.txt");
    const text = Array.from({ length: 150_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
    fs.writeFileSync(textPath, text);
    const source = [
      "let offset = 0; let pages = 0; let length = 0; let checksum = 0; let tail = '';",
      "while (offset !== undefined) {",
      "  const page = await capabilities.docs.extract_text({ path: input.path, offset });",
      "  pages += 1; length += page.text.length; tail = page.text.slice(-10);",
      "  for (let i = 0; i < page.text.length; i += 1) checksum = (checksum * 31 + page.text.charCodeAt(i)) % 1000000007;",
      "  offset = page.nextOffset;",
      "}",
      "return { pages, length, checksum, tail };",
    ].join("\n");

    const result = await fx.service.runApprovedCodeModeRequest(
      fx.approvedRequest(source, { input: { path: textPath }, reads: [textPath] }),
    );

    expect(result.status).toBe("completed");
    let checksum = 0;
    for (let i = 0; i < text.length; i += 1) checksum = (checksum * 31 + text.charCodeAt(i)) % 1000000007;
    expect(result.result).toEqual({ pages: 3, length: text.length, checksum, tail: text.slice(-10) });
    expect(fx.invokeTool).toHaveBeenCalledTimes(3);
    expect(fx.invokeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: "docs.extract_text", args: { path: textPath, offset: 120_000 } }),
    );
  });

  it("a second registration of the same approval keeps the first record instead of failing on its artifacts", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");
    const internals = fx.service as unknown as {
      registerApprovedCodeModeRequestRun(runId: string, request: ApprovedCodeModeRequest): Promise<CodeModeRunRecord>;
    };
    const runId = `code-run-request-${sha256(`code_mode.request:${request.approvalId}`).slice(0, 32)}`;

    // A redelivery after a crash, or a concurrent one, freezes a new snapshot with new bytes for the same run id.
    const first = await internals.registerApprovedCodeModeRequestRun(runId, request);
    const second = await internals.registerApprovedCodeModeRequestRun(runId, request);

    expect(second).toEqual(first);
    await expect(fx.service.runApprovedCodeModeRequest(request)).resolves.toMatchObject({
      runId,
      status: "completed",
      result: { pages: 3 },
    });
  });

  it("fails a request run whose owner was lost after dispatch when the approval is delivered again", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");
    const runId = await seedStaleRequestRun(fx, request, "boundary_crossed");

    const result = await fx.service.runApprovedCodeModeRequest(request);

    expect(result).toMatchObject({ runId, status: "failed", manualReconciliationRequired: true });
    expect(result.error).toMatch(/interrupted/i);
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
    expect((await fx.asyncStorage.codeModeRuns.get(runId)).status).toBe("failed");
    // The approval effect reads the flag, so it keeps the reconciliation gate instead of resuming Chat.
    expect(readToolDomainExecutionFailure({ ...result }, "allowed")).toMatchObject({
      kind: "manual_reconciliation",
      manualReconciliationRequired: true,
    });
    // A later delivery of the same approval reads the terminal run and still reports it.
    await expect(fx.service.runApprovedCodeModeRequest(request)).resolves.toMatchObject({
      runId,
      status: "failed",
      manualReconciliationRequired: true,
    });
  });

  it("reports a run lost after dispatch as needing reconciliation even when Code Mode is now off", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");
    const runId = await seedStaleRequestRun(fx, request, "boundary_crossed");
    fx.readiness.mockResolvedValue({ ...READY, enabled: false, canRun: false, reason: "code_mode_off" });

    // The stale run is recovered from its record, not refused as "Code Mode is off": it may already have run.
    await expect(fx.service.runCodeModeRequestTool(toolRequest(request))).resolves.toMatchObject({
      runId,
      status: "failed",
      manualReconciliationRequired: true,
    });
    // Once terminal, a later delivery still reads the record.
    await expect(fx.service.runCodeModeRequestTool(toolRequest(request))).resolves.toMatchObject({
      runId,
      manualReconciliationRequired: true,
    });
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });

  it("refuses a stale claim that never reached dispatch while Code Mode is off, without running it", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");
    await seedStaleRequestRun(fx, request, "claimed");
    fx.readiness.mockResolvedValue({ ...READY, enabled: false, canRun: false, reason: "code_mode_off" });

    await expect(fx.service.runCodeModeRequestTool(toolRequest(request))).resolves.toEqual({
      status: "failed",
      error: CODE_MODE_OFF_TOOL_ERROR,
    });
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });

  it("runs a request run whose stale claim never reached dispatch when the approval is delivered again", async () => {
    const fx = createFixture();
    const request = fx.approvedRequest("return { pages: 3 };");
    const runId = await seedStaleRequestRun(fx, request, "claimed");

    const result = await fx.service.runApprovedCodeModeRequest(request);

    expect(result).toMatchObject({ runId, status: "completed", result: { pages: 3 } });
  });

  it("terminalizes an orphaned request run on read instead of leaving it running", async () => {
    const fx = createFixture();
    const dispatched = fx.approvedRequest("return { pages: 3 };");
    const dispatchedRunId = await seedStaleRequestRun(fx, dispatched, "boundary_crossed");
    // The shared approved-action boundary resolved the pending action; nothing delivers this approval again.
    fx.storage.pendingApprovalActions.markResolved(dispatched.approvalId, "failed", {
      manualReconciliationRequired: true,
    });
    const claimed = fx.approvedRequest("return { pages: 3 };");
    const claimedRunId = await seedStaleRequestRun(fx, claimed, "claimed");
    fx.storage.pendingApprovalActions.markResolved(claimed.approvalId, "failed", {
      manualReconciliationRequired: true,
    });

    expect((await fx.service.getCodeModeRun(dispatchedRunId)).status).toBe("failed");
    expect((await fx.asyncStorage.codeModeRuns.get(dispatchedRunId)).status).toBe("failed");
    const claimedRun = await fx.service.getCodeModeRun(claimedRunId);
    expect(claimedRun).toMatchObject({ status: "failed", errorCode: "code_mode_request_not_started" });
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
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

describe("CapabilitySystemService.runCodeModeRequestTool", { timeout: RUN_TIMEOUT_MS }, () => {
  it("runs the approved tool call bound to its pending action's source", async () => {
    const fx = createFixture();
    const approved = fx.approvedRequest("return { pages: 3 };", { reads: ["plan.pdf"] });

    const result = await fx.service.runCodeModeRequestTool(toolRequest(approved));

    expect(result).toMatchObject({ status: "completed", result: { pages: 3 } });
    // The approved reads travel from the tool call into the run's hashed policy snapshot.
    const stored = await fx.asyncStorage.codeModeRuns.get(result.runId as string);
    const snapshot = JSON.parse(
      fs.readFileSync(path.resolve(fx.root, stored.policySnapshotArtifact.relPath), "utf8"),
    ) as Record<string, unknown>;
    expect(snapshot.codeModeReads).toEqual(["plan.pdf"]);
  });

  it("refuses a call without an approval or outside a Chat turn", async () => {
    const fx = createFixture();
    const approved = fx.approvedRequest("return { pages: 3 };");

    await expect(
      fx.service.runCodeModeRequestTool({ ...toolRequest(approved), approvedByApprovalId: undefined }),
    ).rejects.toThrow(/runs only after the operator approves it/);
    await expect(fx.service.runCodeModeRequestTool({ ...toolRequest(approved), turnId: undefined })).rejects.toThrow(
      /only inside a Chat turn/,
    );
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });

  it("requires the operator's recorded decision on the approval", async () => {
    const fx = createFixture();
    const unresolved = fx.approvedRequest("return { pages: 3 };", { resolve: false });
    await expect(fx.service.runCodeModeRequestTool(toolRequest(unresolved))).rejects.toThrow(
      /needs the operator's approval decision/,
    );

    const noDecider = fx.approvedRequest("return { pages: 3 };", { resolve: false });
    fx.storage.approvals.resolve(noDecider.approvalId, { decision: "approve", resolvedBy: " " });
    await expect(fx.service.runCodeModeRequestTool(toolRequest(noDecider))).rejects.toThrow(
      /needs the operator's approval decision/,
    );
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });

  it("refuses when the approval's pending action holds no code_mode.request source", async () => {
    const fx = createFixture();
    const noPending = fx.approvedRequest("return { pages: 3 };", { pendingAction: false });
    await expect(fx.service.runCodeModeRequestTool(toolRequest(noPending))).rejects.toThrow(
      /approved code for this request is missing/,
    );
    const otherTool = fx.approvedRequest("return { pages: 3 };", { pendingToolName: "shell.exec" });
    await expect(fx.service.runCodeModeRequestTool(toolRequest(otherTool))).rejects.toThrow(
      /approved code for this request is missing/,
    );
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });

  it("returns a failed result the turn can resume with when Code Mode cannot run", async () => {
    const fx = createFixture();
    const cases = [
      [{ ...READY, enabled: false, canRun: false, reason: "code_mode_off" }, CODE_MODE_OFF_TOOL_ERROR],
      [{ ...READY, sandboxEnabled: false, canRun: false, reason: "sandbox_off" }, CODE_MODE_OFF_TOOL_ERROR],
      [
        { ...READY, sandboxSupported: false, canRun: false, reason: "sandbox_unsupported" },
        CODE_MODE_UNSUPPORTED_TOOL_ERROR,
      ],
    ] as const;
    for (const [readiness, error] of cases) {
      fx.readiness.mockResolvedValue(readiness);
      const approved = fx.approvedRequest("return { pages: 3 };");
      await expect(fx.service.runCodeModeRequestTool(toolRequest(approved))).resolves.toEqual({
        status: "failed",
        error,
      });
    }
    expect(fx.spawnCodeModeChild).not.toHaveBeenCalled();
  });
});

/**
 * Registers a request run and leaves it `running` under a claim old enough to be stale, as a gateway killed mid-run
 * would: still at `claimed` (before dispatch) or past the dispatch boundary.
 */
async function seedStaleRequestRun(
  fx: ReturnType<typeof createFixture>,
  request: ApprovedCodeModeRequest,
  phase: "claimed" | "boundary_crossed",
): Promise<string> {
  const internals = fx.service as unknown as {
    registerApprovedCodeModeRequestRun(runId: string, request: ApprovedCodeModeRequest): Promise<CodeModeRunRecord>;
  };
  const runId = `code-run-request-${sha256(`code_mode.request:${request.approvalId}`).slice(0, 32)}`;
  const registered = await internals.registerApprovedCodeModeRequestRun(runId, request);
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const claimed = await fx.asyncStorage.codeModeRuns.claimForExecution({
    runId,
    approvalId: request.approvalId,
    sandbox: registered.sandbox!,
    startedAt,
  });
  if (phase === "boundary_crossed") {
    await fx.asyncStorage.codeModeRuns.markExecutionBoundaryCrossed({
      runId,
      approvalId: request.approvalId,
      startedAt,
      executionGeneration: claimed!.executionRecovery.generation,
      boundaryCrossedAt: startedAt,
    });
  }
  expect((await fx.asyncStorage.codeModeRuns.get(runId)).status).toBe("running");
  return runId;
}

/** The replayed `code_mode.request` tool call the policy engine hands the hook once the operator approved it. */
function toolRequest(approved: ApprovedCodeModeRequest): ToolInvokeRequest {
  return {
    toolName: "code_mode.request",
    args: {
      goal: approved.goal,
      source: approved.source,
      ...(approved.input ? { input: approved.input } : {}),
      ...(approved.reads ? { reads: approved.reads } : {}),
    },
    agentId: "assistant",
    sessionId: approved.sessionId,
    turnId: approved.turnId,
    approvedByApprovalId: approved.approvalId,
    policyContext: approved.policyContext,
  };
}

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
    listToolCatalog: () => [docsExtractTextTool(), ...CODE_MODE_FILE_HELPER_TOOLS],
    listLoadedSkills: () => [],
    readSkillStates: async () => new Map(),
    invokeTool,
    createApproval,
    resolveApproval: vi.fn(),
    publishRealtime: vi.fn(async () => undefined),
    readPolicySnapshot: async () => ({ mode: "test" }),
    // Stands in for the session path resolution chat tools get: relative paths resolve against the fixture root.
    resolveToolRequestPaths: async (request) =>
      typeof request.args.path === "string"
        ? { ...request, args: { ...request.args, path: path.resolve(root, request.args.path) } }
        : request,
    spawnCodeModeChild,
  });
  const readiness = vi.spyOn(service, "getCodeModeReadiness").mockResolvedValue(READY);

  const approvedRequest = (
    source: string,
    options: {
      input?: Record<string, unknown>;
      /** The approved `reads`: the only files, folders and attachments the run's helpers may read. */
      reads?: string[];
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
      payload: { goal, source, ...(options.reads ? { reads: options.reads } : {}) },
      preview: { goal },
      linkage: { sessionId, turnId },
    });
    if (options.pendingAction !== false) {
      storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "tool.invoke",
        request: {
          toolName: options.pendingToolName ?? "code_mode.request",
          args: {
            goal,
            source: options.pendingSource ?? source,
            ...(options.input ? { input: options.input } : {}),
            ...(options.reads ? { reads: options.reads } : {}),
          },
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
      ...(options.reads ? { reads: options.reads } : {}),
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
