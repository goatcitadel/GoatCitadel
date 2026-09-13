import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWorkerStateOwnership } from "./worker-state-ownership.js";

describe("worker retained-state process ownership", () => {
  it("excludes a second writer even through a directory alias, then releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "gc-worker-ownership-"));
    const state = join(root, "state");
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireWorkerStateOwnership(state);
      await expect(acquireWorkerStateOwnership(state)).rejects.toThrow("ownership is unavailable");
      const alias = join(root, "alias");
      await symlink(state, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(acquireWorkerStateOwnership(alias)).rejects.toThrow("ownership is unavailable");
      await release();
      release = await acquireWorkerStateOwnership(state);
    } finally {
      await release?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32" && process.platform !== "linux")(
    "releases OS ownership after an actual owner process is killed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gc-worker-crash-"));
      const moduleUrl = new URL("./worker-state-ownership.ts", import.meta.url).href;
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          "const { acquireWorkerStateOwnership } = await import(process.argv[1]); await acquireWorkerStateOwnership(process.argv[2]); process.send('ready');",
          moduleUrl,
          root,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
      );
      let release: (() => Promise<void>) | undefined;
      const exited = once(child, "exit");
      const diagnostics: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        if (diagnostics.length < 10) diagnostics.push(chunk);
      });
      try {
        await Promise.race([
          once(child, "message"),
          exited.then(() => {
            throw new Error(`Owner exited before ready: ${Buffer.concat(diagnostics).toString()}`);
          }),
        ]);
        await expect(acquireWorkerStateOwnership(root)).rejects.toThrow("ownership is unavailable");
        child.kill("SIGKILL");
        await exited;
        release = await acquireWorkerStateOwnership(root);
      } finally {
        child.kill("SIGKILL");
        await exited;
        await release?.();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
