import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_MODE_CHILD_SOURCE } from "./code-mode-child-source.js";

const TEMP_ROOTS: string[] = [];
const CHILD_CLOSES = new WeakMap<ChildProcess, Promise<CloseResult>>();

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

  it("supports stdio JSON-RPC transport without mixing protocol and console stdout", async () => {
    const child = await spawnHarness({ transport: "stdio_jsonrpc" });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "run-stdio-transport",
        method: "run.execute",
        params: {
          runId: "run-stdio-transport",
          source: `
            console.log("guest log on stderr");
            return { ok: true };
          `,
          input: {},
          wrapperManifest: { wrappers: [] },
          deadlineAt: Date.now() + 2000,
        },
      })}\n`,
    );

    const response = await waitForStdioChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-stdio-transport",
    );
    const close = await waitForClose(child);

    expect(response.result).toMatchObject({ ok: true });
    expect(close.code).toBe(0);
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

  it("rejects oversized outbound IPC results with a structured error", async () => {
    const child = await spawnHarness();

    child.send({
      jsonrpc: "2.0",
      id: "run-outbound-too-large",
      method: "run.execute",
      params: {
        runId: "run-outbound-too-large",
        source: `return { payload: "x".repeat(150_000) };`,
        input: {},
        wrapperManifest: { wrappers: [] },
        deadlineAt: Date.now() + 2000,
      },
    });

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-outbound-too-large",
    );
    const close = await waitForClose(child);

    expect(response.error).toMatchObject({
      code: "MESSAGE_TOO_LARGE",
      message: "Code Mode IPC message exceeded the maximum allowed size.",
      details: expect.objectContaining({
        direction: "child_to_parent",
      }),
    });
    expect(close.code).toBe(0);
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
        deadlineAt: Date.now() + 3000,
      },
    });

    await waitForChildMessage(
      child,
      (message) => isCapabilityInvoke(message) && message.params?.wrapperName === "fs.read",
    );

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

  it("exits cleanly when a wrapper response misses the propagated deadline", async () => {
    const child = await spawnHarness();
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.send({
      jsonrpc: "2.0",
      id: "run-parent-disconnect",
      method: "run.execute",
      params: {
        runId: "run-parent-disconnect",
        source: `
          return await capabilities.fs.read({ path: "README.md" });
        `,
        input: {},
        wrapperManifest: {
          wrappers: [{ name: "fs.read" }],
        },
        deadlineAt: Date.now() + 3000,
      },
    });

    await waitForChildMessage(
      child,
      (message) => isCapabilityInvoke(message) && message.params?.wrapperName === "fs.read",
    );

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-parent-disconnect",
    );
    const close = await waitForClose(child);

    expect(response.error).toMatchObject({
      code: "RUN_DEADLINE_EXCEEDED",
      message: "Code Mode wrapper deadline exceeded while waiting for parent response.",
    });
    expect(close.code).toBe(0);
    expect(stderr).not.toContain("EPIPE");
    expect(stderr).not.toContain("ERR_IPC_CHANNEL_CLOSED");
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

  it("ignores wrapper names that would mutate object prototypes", async () => {
    const child = await spawnHarness();

    child.send({
      jsonrpc: "2.0",
      id: "run-prototype-wrapper",
      method: "run.execute",
      params: {
        runId: "run-prototype-wrapper",
        source: `
          return {
            polluted: Boolean(({}).polluted),
            protoWrapperType: typeof capabilities.__proto__,
            safeWrapperType: typeof capabilities.safe.read,
          };
        `,
        input: {},
        wrapperManifest: {
          wrappers: [{ name: "__proto__.polluted" }, { name: "safe.read" }],
        },
        deadlineAt: Date.now() + 2000,
      },
    });

    const response = await waitForChildMessage(
      child,
      (message) => isResponseMessage(message) && message.id === "run-prototype-wrapper",
    );
    const close = await waitForClose(child);

    expect(response.result).toMatchObject({
      polluted: false,
      protoWrapperType: "undefined",
      safeWrapperType: "function",
    });
    expect(close.code).toBe(0);
  });
});

async function spawnHarness(options: { transport?: "node_ipc" | "stdio_jsonrpc" } = {}): Promise<ChildProcess> {
  const harnessPath = await createHarnessPath();
  const child = spawn(process.execPath, [harnessPath], {
    shell: false,
    stdio: options.transport === "stdio_jsonrpc" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      ...(options.transport === "stdio_jsonrpc" ? { GOATCITADEL_CODE_MODE_TRANSPORT: "stdio_jsonrpc" } : {}),
    },
  });
  CHILD_CLOSES.set(
    child,
    new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  );
  return child;
}

function waitForStdioChildMessage(
  child: ChildProcess,
  predicate: (message: JsonRpcMessage) => boolean,
  timeoutMs = 5000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Code Mode stdio child message."));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const parsed = JSON.parse(line) as unknown;
          if (isJsonRpcMessage(parsed) && predicate(parsed)) {
            cleanup();
            resolve(parsed);
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Code Mode stdio child closed before emitting the expected message."));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };

    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
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

type CloseResult = { code: number | null; signal: NodeJS.Signals | null };

function waitForClose(child: ChildProcess): Promise<CloseResult> {
  const trackedClose = CHILD_CLOSES.get(child);
  if (trackedClose) {
    return trackedClose;
  }
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

function isCapabilityInvoke(message: JsonRpcMessage): message is JsonRpcMessage & {
  id: string;
  method: "capability.invoke";
  params: { wrapperName: string; deadlineAt?: number };
} {
  return typeof message.id === "string" && message.method === "capability.invoke" && typeof message.params === "object";
}
