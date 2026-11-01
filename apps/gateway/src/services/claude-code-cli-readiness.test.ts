import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeCliReadiness,
  claudeManagedSettingsDirs,
  detectClaudeManagedHooks,
} from "./claude-code-cli-readiness.js";

const status = (value: unknown) => vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(value) }));

describe("ClaudeCodeCliReadiness", () => {
  const deferredRun = () => {
    const pending: Array<(value: { exitCode: number | null; stdout: string }) => void> = [];
    const run = vi.fn(
      () =>
        new Promise<{ exitCode: number | null; stdout: string }>((resolve) => {
          pending.push(resolve);
        }),
    );
    return { run, pending };
  };
  const loggedIn = (value: boolean) => ({
    exitCode: 0,
    stdout: JSON.stringify({ loggedIn: value, authMethod: "claude.ai", apiProvider: "firstParty" }),
  });

  it("refresh after an in-flight logged-out probe starts a new probe and caches its result", async () => {
    const { run, pending } = deferredRun();
    const readiness = new ClaudeCodeCliReadiness({ run });
    const checkA = readiness.check();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    readiness.invalidate();
    const checkB = readiness.check();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    pending[1]!(loggedIn(true));
    await expect(checkB).resolves.toMatchObject({ status: "ready" });
    pending[0]!(loggedIn(false));
    await checkA;
    await expect(readiness.check()).resolves.toMatchObject({ status: "ready" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(readiness.peek()).toMatchObject({ status: "ready" });
  });

  it("a superseded probe that resolves ready after invalidate leaves the cache empty", async () => {
    const { run, pending } = deferredRun();
    const readiness = new ClaudeCodeCliReadiness({ run });
    const checkA = readiness.check();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    readiness.invalidate();
    pending[0]!(loggedIn(true));
    await checkA;
    expect(readiness.peek()).toBeUndefined();
    const checkB = readiness.check();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    pending[1]!(loggedIn(false));
    await expect(checkB).resolves.toMatchObject({ status: "missing" });
  });

  it("reports a logged-out CLI as missing", async () => {
    const readiness = new ClaudeCodeCliReadiness({
      run: status({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
    });
    await expect(readiness.check()).resolves.toEqual({
      status: "missing",
      reasonCode: "claude_cli_logged_out",
      liveVerified: true,
    });
  });

  it("reports a first-party subscription login as ready", async () => {
    const readiness = new ClaudeCodeCliReadiness({
      run: status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
    });
    await expect(readiness.check()).resolves.toEqual({
      status: "ready",
      reasonCode: "claude_cli_logged_in",
      liveVerified: true,
    });
  });

  it("rejects an API-key login because it would not bill the subscription", async () => {
    const readiness = new ClaudeCodeCliReadiness({
      run: status({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }),
    });
    await expect(readiness.check()).resolves.toMatchObject({
      status: "invalid",
      reasonCode: "claude_cli_not_subscription_login",
    });
  });

  it("rejects a third-party API provider such as Bedrock or Vertex", async () => {
    const readiness = new ClaudeCodeCliReadiness({
      run: status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }),
    });
    await expect(readiness.check()).resolves.toMatchObject({
      status: "invalid",
      reasonCode: "claude_cli_not_subscription_login",
    });
  });

  it("reports a missing executable as unavailable", async () => {
    const readiness = new ClaudeCodeCliReadiness({
      run: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { reasonCode: "claude_cli_missing" });
      }),
    });
    await expect(readiness.check()).resolves.toEqual({
      status: "unavailable",
      reasonCode: "claude_cli_missing",
      liveVerified: false,
    });
  });

  it("reports unreadable status output as unavailable", async () => {
    const readiness = new ClaudeCodeCliReadiness({ run: vi.fn(async () => ({ exitCode: 0, stdout: "nope" })) });
    await expect(readiness.check()).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "claude_cli_status_unreadable",
    });
  });

  it("caches for the TTL and refetches after invalidate()", async () => {
    let now = 1_000;
    const run = status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    const readiness = new ClaudeCodeCliReadiness({ run, now: () => now, ttlMs: 60_000 });
    await readiness.check();
    now += 59_000;
    await readiness.check();
    expect(run).toHaveBeenCalledTimes(1);
    now += 2_000;
    await readiness.check();
    expect(run).toHaveBeenCalledTimes(2);
    readiness.invalidate();
    await readiness.check();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not cache a transient unavailable result but still reports it to listings", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("slow"), { reasonCode: "claude_cli_timeout" }))
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
      });
    const readiness = new ClaudeCodeCliReadiness({ run });
    await expect(readiness.check()).resolves.toMatchObject({ status: "unavailable", reasonCode: "claude_cli_timeout" });
    expect(readiness.peek()).toMatchObject({ status: "unavailable" });
    await expect(readiness.check()).resolves.toMatchObject({ status: "ready" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe between concurrent checks", async () => {
    const run = status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    const readiness = new ClaudeCodeCliReadiness({ run });
    await Promise.all([readiness.check(), readiness.check()]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("managed hooks", () => {
  it("refuses the provider when organization-managed hooks are active", async () => {
    const run = status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    const readiness = new ClaudeCodeCliReadiness({ run, managedHooks: () => "active" });
    await expect(readiness.check()).resolves.toEqual({
      status: "invalid",
      reasonCode: "claude_cli_managed_hooks_active",
      liveVerified: true,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on an unreadable managed settings file", async () => {
    const readiness = new ClaudeCodeCliReadiness({ run: status({ loggedIn: true }), managedHooks: () => "unreadable" });
    await expect(readiness.check()).resolves.toMatchObject({ reasonCode: "claude_cli_managed_hooks_active" });
  });

  const fsWith = (files: Record<string, string>, dirs: Record<string, string[]> = {}) => ({
    readFile: (filePath: string) => files[filePath],
    listDir: (dirPath: string) => dirs[dirPath] ?? [],
  });

  it("detects hooks in managed-settings.json and in drop-in files", () => {
    expect(detectClaudeManagedHooks(["/etc/claude-code"], fsWith({}))).toBe("none");
    expect(
      detectClaudeManagedHooks(
        ["/etc/claude-code"],
        fsWith({ "/etc/claude-code/managed-settings.json": '{"hooks":{}}' }),
      ),
    ).toBe("none");
    expect(
      detectClaudeManagedHooks(
        ["/etc/claude-code"],
        fsWith({ "/etc/claude-code/managed-settings.json": '{"hooks":{"Stop":[{"hooks":[]}]}}' }),
      ),
    ).toBe("active");
    expect(
      detectClaudeManagedHooks(
        ["/etc/claude-code"],
        fsWith(
          { "/etc/claude-code/managed-settings.d/10-org.json": '{"hooks":{"SessionStart":[]}}' },
          { "/etc/claude-code/managed-settings.d": ["10-org.json", "README.md"] },
        ),
      ),
    ).toBe("active");
    expect(
      detectClaudeManagedHooks(["/etc/claude-code"], fsWith({ "/etc/claude-code/managed-settings.json": "{nope" })),
    ).toBe("unreadable");
  });

  it("refuses the provider when organization-managed settings force auto-memory on", async () => {
    const run = status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    const readiness = new ClaudeCodeCliReadiness({ run, managedHooks: () => "auto_memory" });
    await expect(readiness.check()).resolves.toEqual({
      status: "invalid",
      reasonCode: "claude_cli_managed_auto_memory",
      liveVerified: true,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("detects managed settings that force auto-memory on, without masking managed hooks", () => {
    const file = "/etc/claude-code/managed-settings.json";
    expect(detectClaudeManagedHooks(["/etc/claude-code"], fsWith({ [file]: '{"autoMemoryEnabled":true}' }))).toBe(
      "auto_memory",
    );
    expect(
      detectClaudeManagedHooks(
        ["/etc/claude-code"],
        fsWith({ [file]: '{"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"0"}}' }),
      ),
    ).toBe("auto_memory");
    // Managed settings that keep it off, or say nothing, are fine.
    expect(detectClaudeManagedHooks(["/etc/claude-code"], fsWith({ [file]: '{"autoMemoryEnabled":false}' }))).toBe(
      "none",
    );
    expect(
      detectClaudeManagedHooks(
        ["/etc/claude-code"],
        fsWith({ [file]: '{"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"}}' }),
      ),
    ).toBe("none");
    // Hooks are the stronger refusal: they win even when a later drop-in forces auto-memory.
    expect(
      detectClaudeManagedHooks(
        ["/etc/claude-code"],
        fsWith(
          {
            [file]: '{"autoMemoryEnabled":true}',
            "/etc/claude-code/managed-settings.d/10-org.json": '{"hooks":{"Stop":[{"hooks":[]}]}}',
          },
          { "/etc/claude-code/managed-settings.d": ["10-org.json"] },
        ),
      ),
    ).toBe("active");
  });

  it("knows the managed settings locations per platform", () => {
    expect(
      claudeManagedSettingsDirs("win32", { ProgramFiles: "D:\\Program Files", ProgramData: "D:\\ProgramData" }),
    ).toEqual(["D:\\Program Files\\ClaudeCode", "D:\\ProgramData\\ClaudeCode"]);
    expect(claudeManagedSettingsDirs("win32", {})).toEqual([
      "C:\\Program Files\\ClaudeCode",
      "C:\\ProgramData\\ClaudeCode",
    ]);
    expect(claudeManagedSettingsDirs("darwin", {})).toEqual(["/Library/Application Support/ClaudeCode"]);
    expect(claudeManagedSettingsDirs("linux", {})).toEqual(["/etc/claude-code"]);
  });
});
