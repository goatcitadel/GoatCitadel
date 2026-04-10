import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseChangedFilesFromStatus, resolveWorkbenchPathStatus } from "./chat-workbench-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
    }),
  );
});

describe("chat workbench helpers", () => {
  it("uses the destination path for renamed files in git status output", () => {
    const changedFiles = parseChangedFilesFromStatus(
      "R  workspace/demo/old-name.ts -> workspace/demo/new-name.ts\nM  workspace/demo/index.ts\n",
      "workspace/demo",
    );

    expect(changedFiles).toEqual(["new-name.ts", "index.ts"]);
  });

  it("marks stray existing worktree directories as blocked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-workbench-"));
    tempRoots.push(root);

    const blockedPath = path.join(root, "blocked");
    await fs.mkdir(blockedPath, { recursive: true });
    expect(resolveWorkbenchPathStatus(blockedPath)).toBe("blocked");

    const readyPath = path.join(root, "ready");
    await fs.mkdir(readyPath, { recursive: true });
    await fs.writeFile(path.join(readyPath, ".git"), "gitdir: /tmp/demo/.git/worktrees/ready\n", "utf8");
    expect(resolveWorkbenchPathStatus(readyPath)).toBe("ready");
  });
});
