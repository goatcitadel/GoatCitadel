import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityArtifactRecord } from "@goatcitadel/contracts";
import { executeCodeModeAiderAdapter } from "./code-mode-aider-execution.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("code-mode-aider-execution", () => {
  it("runs Aider only in run-temp space and persists an audit-only result bundle", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-exec-"));
    tempRoots.push(runTempRoot);
    const persisted: Array<{ filename: string; content: string }> = [];
    const spawnCommand = vi.fn((executable: string, args: string[]) => {
      expect(executable).toBe("docker");
      expect(args).toEqual(
        expect.arrayContaining([
          "--network",
          "none",
          "--read-only",
          "--mount",
          expect.stringContaining(`src=${path.join(runTempRoot, "aider-live")}`),
          "ghcr.io/goatcitadel/aider-adapter:preview",
          "aider",
          "--message-file",
          "aider/request.md",
        ]),
      );
      return fakeChild({ stdout: "done\n", stderr: "", exitCode: 0 });
    });

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider",
      runTempRoot,
      language: "typescript",
      source: "return { ok: true };",
      requestMarkdown: "Please refactor this file.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
        command: "aider",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister(persisted),
      spawnCommand: spawnCommand as never,
    });

    expect(result).toMatchObject({
      failed: false,
      outcome: "no_changes",
      stdout: "done\n",
      result: {
        aiderAdapter: {
          envelope: expect.objectContaining({
            adapterId: "aider-cli-adapter",
            outcome: "no_changes",
            replay: expect.objectContaining({ policy: "audit_only", replaySafe: false }),
          }),
        },
      },
    });
    await expect(fs.readFile(path.join(runTempRoot, "aider-live", "aider", "request.md"), "utf8")).resolves.toBe(
      "Please refactor this file.",
    );
    expect(persisted.map((item) => item.filename)).toEqual(
      expect.arrayContaining(["request.md", "invocation-plan.json", "stdout.log", "result-envelope.json"]),
    );
  });

  it("records failed adapter exits instead of applying patches", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-fail-"));
    tempRoots.push(runTempRoot);

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider-failed",
      runTempRoot,
      language: "javascript",
      source: "return { ok: true };",
      requestMarkdown: "Try a risky change.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister([]),
      spawnCommand: vi.fn(() => fakeChild({ stdout: "", stderr: "denied\n", exitCode: 2 })) as never,
    });

    expect(result).toMatchObject({
      failed: true,
      outcome: "failed",
      errorCode: "AIDER_EXIT_NONZERO",
      errorDetails: { exitCode: 2 },
    });
    expect(result.result.aiderAdapter.envelope).toMatchObject({
      outcome: "failed",
      error: {
        code: "AIDER_EXIT_NONZERO",
        message: "Aider adapter exited with code 2.",
      },
    });
  });

  it("bounds adapter stdout and stderr before persisting log evidence", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-bounded-"));
    tempRoots.push(runTempRoot);
    const persisted: Array<{ filename: string; content: string }> = [];

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider-bounded",
      runTempRoot,
      language: "javascript",
      source: "return { ok: true };",
      requestMarkdown: "Keep logs bounded.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister(persisted),
      outputCaptureLimitBytes: 32,
      spawnCommand: vi.fn(() =>
        fakeChild({
          stdout: "o".repeat(96),
          stderr: "e".repeat(96),
          exitCode: 0,
        }),
      ) as never,
    });

    expect(result).toMatchObject({
      failed: false,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(result.stdout).toContain("...[truncated]");
    expect(result.stderr).toContain("...[truncated]");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(96);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(96);
    expect(persisted.find((item) => item.filename === "stdout.log")?.content).toBe(result.stdout);
    expect(persisted.find((item) => item.filename === "stderr.log")?.content).toBe(result.stderr);
  });

  it("uses process-tree cleanup and records timeout evidence", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-timeout-"));
    tempRoots.push(runTempRoot);
    const terminateProcessTree = vi.fn();

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider-timeout",
      runTempRoot,
      language: "typescript",
      source: "return { ok: true };",
      requestMarkdown: "This adapter hangs.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister([]),
      timeoutMs: 20,
      terminateProcessTree: terminateProcessTree as never,
      spawnCommand: vi.fn(() => fakeChild({ stdout: "partial\n", stderr: "", close: false, pid: 4511 })) as never,
    });

    expect(terminateProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Aider adapter timeout",
        context: { runId: "code-run-aider-timeout" },
      }),
    );
    expect(result).toMatchObject({
      failed: true,
      outcome: "failed",
      errorCode: "AIDER_TIMEOUT",
      errorDetails: expect.objectContaining({
        timeoutMs: 20,
        processTreeCleanup: "requested",
      }),
    });
    expect(result.result.aiderAdapter.envelope.error).toMatchObject({
      code: "AIDER_TIMEOUT",
      message: expect.stringContaining("timed out after 20ms"),
      details: expect.objectContaining({ processTreeCleanup: "requested" }),
    });
  });

  it("uses process-tree cleanup and records abort evidence", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-abort-"));
    tempRoots.push(runTempRoot);
    const terminateProcessTree = vi.fn();
    const controller = new AbortController();

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider-abort",
      runTempRoot,
      language: "javascript",
      source: "return { ok: true };",
      requestMarkdown: "This adapter is cancelled.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister([]),
      signal: controller.signal,
      terminateProcessTree: terminateProcessTree as never,
      spawnCommand: vi.fn(() => {
        setImmediate(() => controller.abort(new Error("operator cancelled")));
        return fakeChild({ stdout: "", stderr: "waiting\n", close: false, pid: 4512 });
      }) as never,
    });

    expect(terminateProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Aider adapter abort",
        context: { runId: "code-run-aider-abort" },
      }),
    );
    expect(result).toMatchObject({
      failed: true,
      outcome: "failed",
      errorCode: "AIDER_ABORTED",
      errorDetails: expect.objectContaining({
        reason: "operator cancelled",
        processTreeCleanup: "requested",
      }),
    });
    expect(result.result.aiderAdapter.envelope.error).toMatchObject({
      code: "AIDER_ABORTED",
      details: expect.objectContaining({ reason: "operator cancelled" }),
    });
  });

  it("uses process-tree cleanup when the adapter process errors", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-process-error-"));
    tempRoots.push(runTempRoot);
    const terminateProcessTree = vi.fn();

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider-process-error",
      runTempRoot,
      language: "typescript",
      source: "return { ok: true };",
      requestMarkdown: "The process errors.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister([]),
      terminateProcessTree: terminateProcessTree as never,
      spawnCommand: vi.fn(() =>
        fakeChild({
          error: new Error("spawn failed after pid assignment"),
          close: false,
          pid: 4513,
        }),
      ) as never,
    });

    expect(terminateProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Aider adapter process error",
        context: { runId: "code-run-aider-process-error" },
      }),
    );
    expect(result).toMatchObject({
      failed: true,
      outcome: "failed",
      errorCode: "AIDER_PROCESS_ERROR",
      error: "spawn failed after pid assignment",
      errorDetails: expect.objectContaining({
        processTreeCleanup: "requested",
      }),
    });
  });

  it("records a generated patch artifact when Aider edits the run-temp input file", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-aider-edit-"));
    tempRoots.push(runTempRoot);
    const persisted: Array<{ filename: string; content: string }> = [];

    const result = await executeCodeModeAiderAdapter({
      runId: "code-run-aider-edited",
      runTempRoot,
      language: "typescript",
      source: "return { ok: false };\n",
      requestMarkdown: "Flip the result.",
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
      },
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      persister: fakePersister(persisted),
      spawnCommand: vi.fn(() =>
        fakeChild({
          stdout: "edited\n",
          stderr: "",
          exitCode: 0,
          beforeClose: async () => {
            await fs.writeFile(path.join(runTempRoot, "aider-live", "input.ts"), "return { ok: true };\n", "utf8");
          },
        }),
      ) as never,
    });

    expect(result).toMatchObject({
      failed: false,
      outcome: "patch_produced",
    });
    expect(result.result.aiderAdapter.envelope).toMatchObject({
      patchArtifact: {
        kind: "git_patch",
        fileCount: 1,
      },
    });
    expect(persisted.find((item) => item.filename === "aider.git.patch")?.content).toContain(
      "diff --git a/input.ts b/input.ts",
    );
  });
});

function fakePersister(persisted: Array<{ filename: string; content: string }>) {
  const makeArtifact = (filename: string, content: string, mimeType: string): CapabilityArtifactRecord => ({
    artifactId: `artifact-${filename}`,
    relPath: `data/code-mode-artifacts/code-run-aider/aider/${filename}`,
    sha256: `sha256-${filename}`,
    bytes: Buffer.byteLength(content),
    mimeType,
    createdAt: "2026-05-31T00:00:00.000Z",
  });
  return {
    persistText: vi.fn(async (input: { filename: string; content: string; mimeType: string }) => {
      persisted.push({ filename: input.filename, content: input.content });
      return makeArtifact(input.filename, input.content, input.mimeType);
    }),
    persistJson: vi.fn(async (input: { filename: string; value: unknown }) => {
      const content = JSON.stringify(input.value, null, 2);
      persisted.push({ filename: input.filename, content });
      return makeArtifact(input.filename, content, "application/json");
    }),
  };
}

function fakeChild(input: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  beforeClose?: () => Promise<void>;
  close?: boolean;
  pid?: number;
  error?: Error;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = input.pid ?? 4510;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal?: NodeJS.Signals) => {
    child.killed = true;
    child.signalCode = signal ?? "SIGTERM";
    return true;
  };
  setImmediate(async () => {
    if (input.error) {
      child.emit("error", input.error);
      return;
    }
    await input.beforeClose?.();
    child.stdout.write(input.stdout ?? "");
    child.stderr.write(input.stderr ?? "");
    if (input.close === false) {
      return;
    }
    child.exitCode = input.exitCode ?? 0;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", child.exitCode);
  });
  return child;
}
