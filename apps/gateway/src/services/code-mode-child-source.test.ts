import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
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
    const harnessPath = await createHarnessPath();
    const child = spawn(process.execPath, [harnessPath], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Code Mode child result."));
      }, 5000);
      child.once("message", (message: unknown) => {
        clearTimeout(timeout);
        const record = message as {
          id?: string;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (record?.error) {
          reject(new Error(record.error.message ?? "Code Mode child returned an error."));
          return;
        }
        resolve(record.result ?? {});
      });
      child.once("error", reject);
    });

    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });

    child.send({
      jsonrpc: "2.0",
      id: "run-1",
      method: "run.execute",
      params: {
        runId: "run-1",
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

    const result = await resultPromise;
    const close = await closePromise;

    expect(result).toMatchObject({
      processType: "undefined",
      requireType: "undefined",
      globalProcessType: "undefined",
      globalType: "undefined",
    });
    expect(close.code).toBe(0);
    expect(close.signal).toBeNull();
  });
});
