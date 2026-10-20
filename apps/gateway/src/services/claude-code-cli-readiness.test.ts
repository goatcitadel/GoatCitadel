import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeCliReadiness } from "./claude-code-cli-readiness.js";

const status = (value: unknown) => vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(value) }));

describe("ClaudeCodeCliReadiness", () => {
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

  it("shares one in-flight probe between concurrent checks", async () => {
    const run = status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
    const readiness = new ClaudeCodeCliReadiness({ run });
    await Promise.all([readiness.check(), readiness.check()]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
