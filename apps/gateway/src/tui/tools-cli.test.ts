import { describe, expect, it, vi } from "vitest";
import { runToolsCli, __toolsCliInternals } from "./tools-cli.js";

function createHarness() {
  const output: string[] = [];
  const client = {
    toolsCatalog: vi.fn(async () => ({ items: [{ toolName: "session.status" }] })),
    toolsCreateGrant: vi.fn(async () => ({ grantId: "grant-1" })),
    toolsRevokeGrant: vi.fn(async () => ({ revoked: true })),
    toolsInvoke: vi.fn(async () => ({ outcome: "dry_run" })),
  };
  const loadResolvedProfile = vi.fn(async () => ({
    profileName: "ops",
    filePath: "profile.json",
    profile: {
      gatewayBaseUrl: "http://gateway.local",
      authMode: "token" as const,
    },
    auth: {
      mode: "token" as const,
      token: "secret",
    },
  }));
  const createClient = vi.fn(() => client);

  return {
    client,
    createClient,
    loadResolvedProfile,
    output,
    deps: {
      createClient,
      loadResolvedProfile,
      writeOutput: (value: string) => output.push(value),
    },
  };
}

describe("tools cli", () => {
  it("parses global profile, gateway, and read-only options for catalog", async () => {
    const harness = createHarness();

    await runToolsCli(["catalog", "--profile", "ops", "--gateway", "http://override", "--read-only"], harness.deps);

    expect(harness.loadResolvedProfile).toHaveBeenCalledWith({
      profileName: "ops",
      gatewayOverride: "http://override",
    });
    expect(harness.createClient).toHaveBeenCalledWith({
      baseUrl: "http://gateway.local",
      auth: { mode: "token", token: "secret" },
      readOnly: true,
    });
    expect(harness.client.toolsCatalog).toHaveBeenCalled();
    expect(JSON.parse(harness.output.join(""))).toEqual({ items: [{ toolName: "session.status" }] });
  });

  it("normalizes grant add aliases and defaults before calling the API", async () => {
    const harness = createHarness();

    await runToolsCli(
      [
        "grant",
        "add",
        "--tool",
        "shell.*",
        "--scope",
        "workspace",
        "--scope-ref",
        "workspace-1",
        "--grant-type",
        "ttl",
        "--expires-at",
        "2026-05-14T00:00:00.000Z",
      ],
      harness.deps,
    );

    expect(harness.client.toolsCreateGrant).toHaveBeenCalledWith({
      toolPattern: "shell.*",
      decision: "allow",
      scope: "workspace",
      scopeRef: "workspace-1",
      grantType: "ttl",
      expiresAt: "2026-05-14T00:00:00.000Z",
    });
    expect(JSON.parse(harness.output.join(""))).toEqual({ grantId: "grant-1" });
  });

  it("requires grant and tool identifiers for mutating commands", async () => {
    const harness = createHarness();

    await expect(runToolsCli(["grant", "add"], harness.deps)).rejects.toThrow("--tool is required");
    await expect(runToolsCli(["grant", "revoke"], harness.deps)).rejects.toThrow("--grant-id is required");
    await expect(runToolsCli(["invoke"], harness.deps)).rejects.toThrow("--tool is required");
  });

  it("revokes grants and invokes tools with parsed args and consent context", async () => {
    const revokeHarness = createHarness();
    await runToolsCli(["grant", "revoke", "--grant-id", "grant-1"], revokeHarness.deps);
    expect(revokeHarness.client.toolsRevokeGrant).toHaveBeenCalledWith("grant-1");
    expect(JSON.parse(revokeHarness.output.join(""))).toEqual({ revoked: true });

    const invokeHarness = createHarness();
    await runToolsCli(
      [
        "invoke",
        "--tool",
        "session.status",
        "--args",
        '{"sessionId":"session-1"}',
        "--session",
        "session-1",
        "--agent",
        "operator",
        "--task",
        "task-1",
        "--dry-run",
      ],
      invokeHarness.deps,
    );

    expect(invokeHarness.client.toolsInvoke).toHaveBeenCalledWith({
      toolName: "session.status",
      args: { sessionId: "session-1" },
      sessionId: "session-1",
      agentId: "operator",
      taskId: "task-1",
      dryRun: true,
      consentContext: {
        source: "tui",
        reason: "tools-cli",
      },
    });
    expect(JSON.parse(invokeHarness.output.join(""))).toEqual({ outcome: "dry_run" });
  });

  it("rejects unknown command shapes with the usage text", () => {
    expect(() => __toolsCliInternals.parseArgs(["grant"])).toThrow("Usage: goat tools catalog");
  });
});
