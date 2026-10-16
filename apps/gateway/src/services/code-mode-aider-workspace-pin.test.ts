import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionWorkbenchRecord, CodeModeAiderWorkspacePin } from "@goatcitadel/contracts";
import {
  captureCodeModeAiderWorkspacePin,
  resolveCodeModeAiderWorkspaceSeed,
  type CodeModeAiderWorkspacePinDeps,
} from "./code-mode-aider-workspace-pin.js";
import { captureCodeModeWorkbenchWorktree } from "./code-mode-worktree-capture.js";

const roots: string[] = [];
const FIXED_NOW = new Date("2026-10-16T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Aider workspace pin", () => {
  it("pins a ready clean workbench at its HEAD", async () => {
    const fixture = createFixture();
    const deps = fixture.deps({ worktreePath: "repo" });

    const pin = await captureCodeModeAiderWorkspacePin(
      deps,
      { sessionId: "session-a", runId: "run-1" },
      { now: () => FIXED_NOW },
    );

    expect(pin).toEqual({
      version: 1,
      sessionId: "session-a",
      worktreeIdentityHash: expectedIdentityHash("session-a", "project-a", fixture.worktree),
      worktreeHead: fixture.head(),
      worktreeStateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      capturedAt: FIXED_NOW.toISOString(),
    });
    expect(deps.storage.chatSessionWorkbench.get).toHaveBeenCalledWith("session-a");
  });

  it("does not pin a dirty, not-ready or missing workbench", async () => {
    const fixture = createFixture();
    const binding = { sessionId: "session-a", runId: "run-1" };

    fs.writeFileSync(path.join(fixture.worktree, "scratch.txt"), "untracked\n");
    expect(await captureCodeModeAiderWorkspacePin(fixture.deps({ worktreePath: "repo" }), binding)).toBeUndefined();
    fs.rmSync(path.join(fixture.worktree, "scratch.txt"));

    fs.appendFileSync(path.join(fixture.worktree, "index.ts"), "export const dirty = true;\n");
    expect(await captureCodeModeAiderWorkspacePin(fixture.deps({ worktreePath: "repo" }), binding)).toBeUndefined();
    git(fixture.worktree, ["checkout", "--", "index.ts"]);

    expect(
      await captureCodeModeAiderWorkspacePin(
        fixture.deps({ worktreePath: "repo", worktreeStatus: "uninitialized" }),
        binding,
      ),
    ).toBeUndefined();
    expect(
      await captureCodeModeAiderWorkspacePin(fixture.deps({ worktreePath: "[outside-root]" }), binding),
    ).toBeUndefined();
    expect(await captureCodeModeAiderWorkspacePin(fixture.deps(undefined), binding)).toBeUndefined();

    // Clean again: the same workbench now pins.
    expect(await captureCodeModeAiderWorkspacePin(fixture.deps({ worktreePath: "repo" }), binding)).toBeDefined();
  });

  it("propagates workbench storage errors", async () => {
    const fixture = createFixture();
    const deps: CodeModeAiderWorkspacePinDeps = {
      rootDir: fixture.root,
      storage: {
        chatSessionWorkbench: {
          get: vi.fn(async () => {
            throw new Error("storage offline");
          }),
        },
      } as unknown as CodeModeAiderWorkspacePinDeps["storage"],
    };

    await expect(captureCodeModeAiderWorkspacePin(deps, { sessionId: "session-a", runId: "run-1" })).rejects.toThrow(
      "storage offline",
    );
  });

  it("pin state hash equals the verification capture for the same tree", async () => {
    const fixture = createFixture();
    const deps = fixture.deps({ worktreePath: "repo" });

    const pin = await captureCodeModeAiderWorkspacePin(deps, { sessionId: "session-a", runId: "run-1" });
    // The verification service calls the shared capture with the run record and no rootDir; an absolute stored path
    // resolves identically there.
    const verificationCapture = await captureCodeModeWorkbenchWorktree(
      fixture.deps({ worktreePath: fixture.worktree }).storage,
      { sessionId: "session-a", runId: "run-unrelated" },
      15_000,
    );

    expect(verificationCapture.valid).toBe(true);
    expect(pin?.worktreeStateHash).toBe(verificationCapture.stateHash);
    expect(pin?.worktreeIdentityHash).toBe(verificationCapture.identityHash);
    expect(pin?.worktreeHead).toBe(verificationCapture.headHash);
    // Same formula the verification evidence has always used for a clean tree.
    expect(pin?.worktreeStateHash).toBe(
      sha256(
        JSON.stringify({
          headHash: fixture.head(),
          statusSha256: sha256(""),
          diffSha256: sha256(""),
          untrackedDigests: [],
        }),
      ),
    );
  });

  it("resolveCodeModeAiderWorkspaceSeed seeds from the pinned commit even after HEAD moves", async () => {
    const fixture = createFixture();
    const deps = fixture.deps({ worktreePath: "repo" });
    const pin = await requirePin(deps);

    fs.writeFileSync(path.join(fixture.worktree, "next.ts"), "export const next = 1;\n");
    git(fixture.worktree, ["add", "next.ts"]);
    git(fixture.worktree, ["commit", "-q", "-m", "next"]);
    expect(fixture.head()).not.toBe(pin.worktreeHead);

    const seed = await resolveCodeModeAiderWorkspaceSeed(deps, pin, { sessionId: "session-a", runId: "run-1" });

    expect(seed).toEqual({ worktreePath: fixture.worktree, baseCommit: pin.worktreeHead, pin });
  });

  it("resolveCodeModeAiderWorkspaceSeed refuses a different worktree identity", async () => {
    const fixture = createFixture();
    const pin = await requirePin(fixture.deps({ worktreePath: "repo" }));
    const other = createFixture();

    await expect(
      resolveCodeModeAiderWorkspaceSeed(
        { rootDir: other.root, storage: other.deps({ worktreePath: "repo" }).storage },
        pin,
        { sessionId: "session-a", runId: "run-1" },
      ),
    ).rejects.toThrow(/identity/i);
    await expect(
      resolveCodeModeAiderWorkspaceSeed(fixture.deps({ worktreePath: "repo", projectId: "project-b" }), pin, {
        sessionId: "session-a",
        runId: "run-1",
      }),
    ).rejects.toThrow(/identity/i);
    await expect(
      resolveCodeModeAiderWorkspaceSeed(fixture.deps({ worktreePath: "repo", worktreeStatus: "missing" }), pin, {
        sessionId: "session-a",
        runId: "run-1",
      }),
    ).rejects.toThrow(/not ready/i);
    await expect(
      resolveCodeModeAiderWorkspaceSeed(
        fixture.deps({ worktreePath: "repo" }),
        { ...pin, worktreeHead: "f".repeat(40) },
        {
          sessionId: "session-a",
          runId: "run-1",
        },
      ),
    ).rejects.toThrow(/pinned commit/i);
  });

  it("resolveCodeModeAiderWorkspaceSeed refuses a session mismatch", async () => {
    const fixture = createFixture();
    const deps = fixture.deps({ worktreePath: "repo" });
    const pin = await requirePin(deps);

    await expect(
      resolveCodeModeAiderWorkspaceSeed(deps, pin, { sessionId: "session-b", runId: "run-1" }),
    ).rejects.toThrow(/session/i);
    await expect(resolveCodeModeAiderWorkspaceSeed(deps, pin, { runId: "run-1" })).rejects.toThrow(/session/i);
  });
});

async function requirePin(deps: CodeModeAiderWorkspacePinDeps): Promise<CodeModeAiderWorkspacePin> {
  const pin = await captureCodeModeAiderWorkspacePin(deps, { sessionId: "session-a", runId: "run-1" });
  if (!pin) {
    throw new Error("expected a workspace pin");
  }
  return pin;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-aider-pin-"));
  roots.push(root);
  const worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  git(worktree, ["init", "-q"]);
  git(worktree, ["config", "user.name", "Pin Test"]);
  git(worktree, ["config", "user.email", "pin-test@example.invalid"]);
  git(worktree, ["config", "commit.gpgsign", "false"]);
  // The hardened capture ignores global config, so keep line endings repo-local and stable.
  git(worktree, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(worktree, "index.ts"), "export const value = 1;\n");
  git(worktree, ["add", "index.ts"]);
  git(worktree, ["commit", "-q", "-m", "initial"]);
  const realWorktree = fs.realpathSync(worktree);
  return {
    root,
    worktree: realWorktree,
    head: () => git(realWorktree, ["rev-parse", "HEAD"]).trim(),
    deps(
      overrides:
        | (Partial<Pick<ChatSessionWorkbenchRecord, "worktreeStatus" | "projectId">> & { worktreePath: string })
        | undefined,
    ): CodeModeAiderWorkspacePinDeps & {
      storage: { chatSessionWorkbench: { get: ReturnType<typeof vi.fn> } };
    } {
      const record = overrides
        ? ({
            sessionId: "session-a",
            projectId: "project-a",
            worktreeStatus: "ready",
            baseRef: "main",
            ...overrides,
          } as unknown as ChatSessionWorkbenchRecord)
        : undefined;
      return {
        rootDir: root,
        storage: { chatSessionWorkbench: { get: vi.fn(async () => record) } },
      } as unknown as CodeModeAiderWorkspacePinDeps & {
        storage: { chatSessionWorkbench: { get: ReturnType<typeof vi.fn> } };
      };
    },
  };
}

function expectedIdentityHash(sessionId: string, projectId: string, worktreePath: string): string {
  return sha256(JSON.stringify({ sessionId, projectId, path: worktreePath.replaceAll("\\", "/") }));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
