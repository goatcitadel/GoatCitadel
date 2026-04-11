import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_MODE_CHILD_SOURCE } from "./code-mode-child-source.js";

const TEMP_ROOTS: string[] = [];

async function createHarnessPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-code-mode-child-"));
  TEMP_ROOTS.push(root);
  const harnessPath = path.join(root, "code-mode-harness.mjs");
  await writeFile(harnessPath, CODE_MODE_CHILD_SOURCE, "utf8");
  return harnessPath;
}

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("CODE_MODE_CHILD_SOURCE", () => {
  it("hides ambient Node globals from guest code and exits after the run completes", async () => {
    const child = await spawnHarness();

    child.send({
      jsonrpc: "2.0",
      id: "run-ambient-globals",
      method: "run.execute",
      params: {
        runId: "run-ambient-globals",
        source: `
          return {
            processType: typeof process,
            requireType: typeof require,
            globalProcessType: typeof globalThis.process,
            globalType: typeof global,
          };
        `,
        input: {},
        wrapperManifest: {
          wrappers: [],
        },
        deadlineAt: Date.now() + 2000,
      },
    });

    const result = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-ambient-globals",
    );
    const close = await waitForClose(child);

    expect(result.result).toMatchObject({
      processType: "undefined",
      requireType: "undefined",
      globalProcessType: "undefined",
      globalType: "undefined",
    });
    expect(close.code).toBe(0);
    expect(close.signal).toBeNull();
  });

  it("rejects oversized inbound IPC messages with a structured error", async () => {
    const child = await spawnHarness();

    child.send({
      jsonrpc: "2.0",
      id: "run-too-large",
      method: "run.execute",
      params: {
        runId: "run-too-large",
        source: `return ${JSON.stringify("x".repeat(150_000))};`,
        input: {},
        wrapperManifest: { wrappers: [] },
        deadlineAt: Date.now() + 2000,
      },
    });

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-too-large",
    );

    expect(response.error).toMatchObject({
      code: "MESSAGE_TOO_LARGE",
      message: "Code Mode IPC message exceeded the maximum allowed size.",
    });

    child.kill();
    await waitForClose(child);
  });

  it("propagates wrapper deadlines to the parent IPC contract", async () => {
    const child = await spawnHarness();
    const deadlineAt = Date.now() + 3000;

    child.send({
      jsonrpc: "2.0",
      id: "run-deadline-propagation",
      method: "run.execute",
      params: {
        runId: "run-deadline-propagation",
        source: `
          return await capabilities.fs.read({ path: "README.md" });
        `,
        input: {},
        wrapperManifest: {
          wrappers: [{ name: "fs.read" }],
        },
        deadlineAt,
      },
    });

    const invokeRequest = await waitForChildMessage(
      child,
      (message) => isCapabilityInvoke(message) && message.params?.wrapperName === "fs.read",
    );
    expect(invokeRequest.params?.deadlineAt).toBe(deadlineAt);

    child.send({
      jsonrpc: "2.0",
      id: invokeRequest.id,
      result: {
        ok: true,
        path: "README.md",
      },
    });

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-deadline-propagation",
    );
    const close = await waitForClose(child);

    expect(response.result).toMatchObject({
      ok: true,
      path: "README.md",
    });
    expect(close.code).toBe(0);
  });

  it("returns a structured cancellation error while a wrapper call is pending", async () => {
    const child = await spawnHarness();

    child.send({
      jsonrpc: "2.0",
      id: "run-cancelled",
      method: "run.execute",
      params: {
        runId: "run-cancelled",
        source: `
          return await capabilities.fs.read({ path: "README.md" });
        `,
        input: {},
        wrapperManifest: {
          wrappers: [{ name: "fs.read" }],
        },
        deadlineAt: Date.now() + 5000,
      },
    });

    await waitForChildMessage(child, (message) => isCapabilityInvoke(message) && message.params?.wrapperName === "fs.read");

    child.send({
      jsonrpc: "2.0",
      id: "cancel-run-cancelled",
      method: "run.cancel",
      params: {
        reason: "operator requested cancellation",
      },
    });

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-cancelled",
    );
    const close = await waitForClose(child);

    expect(response.error).toMatchObject({
      code: "RUN_CANCELLED",
      message: "operator requested cancellation",
    });
    expect(close.code).toBe(0);
  });

  it("fails with RUN_DEADLINE_EXCEEDED before invoking a wrapper when the deadline has already passed", async () => {
    const child = await spawnHarness();

    child.send({
      jsonrpc: "2.0",
      id: "run-expired-deadline",
      method: "run.execute",
      params: {
        runId: "run-expired-deadline",
        source: `
          return await capabilities.fs.read({ path: "README.md" });
        `,
        input: {},
        wrapperManifest: {
          wrappers: [{ name: "fs.read" }],
        },
        deadlineAt: Date.now() - 1000,
      },
    });

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-expired-deadline",
    );
    const close = await waitForClose(child);

    expect(response.error).toMatchObject({
      code: "RUN_DEADLINE_EXCEEDED",
      message: "Code Mode wrapper deadline exceeded before invocation.",
    });
    expect(close.code).toBe(0);
  });
});

async function spawnHarness(): Promise<ChildProcess> {
  const harnessPath = await createHarnessPath();
  return spawn(process.execPath, [harnessPath], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

function waitForChildMessage(
  child: ChildProcess,
  predicate: (message: JsonRpcMessage) => boolean,
  timeoutMs = 5000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Code Mode child message."));
    }, timeoutMs);

    const onMessage = (message: unknown) => {
      if (!isJsonRpcMessage(message) || !predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Code Mode child closed before emitting the expected message."));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

type JsonRpcMessage = {
  id?: string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

function isJsonRpcMessage(message: unknown): message is JsonRpcMessage {
  return Boolean(message) && typeof message === "object";
}

function isResponseMessage(message: JsonRpcMessage): message is JsonRpcMessage & { id: string } {
  return typeof message.id === "string" && ("result" in message || "error" in message);
}

function isCapabilityInvoke(
  message: JsonRpcMessage,
): message is JsonRpcMessage & { id: string; method: "capability.invoke"; params: { wrapperName: string; deadlineAt?: number } } {
  return typeof message.id === "string" && message.method === "capability.invoke" && typeof message.params === "object";
}
