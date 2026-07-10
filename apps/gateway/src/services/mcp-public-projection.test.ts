import { describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { preserveMcpServerSecretsForPublicUpdate, projectMcpPublicValue } from "./mcp-public-projection.js";

describe("MCP public projection", () => {
  it("redacts argv pairs, encoded credential-path labels, query credentials, and structured secrets", () => {
    const raw = {
      args: [
        "server.mjs",
        "--password",
        "short-pass",
        "--api-key=short-key",
        "https://mcp.example.test/%2574oken/path-secret?client_secret=query-secret&%74oken=encoded-query&mode=safe",
      ],
      result: {
        authorization: "Bearer short",
        endpoint: "https://mcp.example.test?%74oken=root-query#access_token=fragment-secret",
        tokenId: "public-token-id",
        secretRef: "vault:mcp/public",
      },
    };

    expect(projectMcpPublicValue(raw)).toEqual({
      args: [
        "server.mjs",
        "--password",
        "[REDACTED]",
        "--api-key=[REDACTED]",
        "https://mcp.example.test/%2574oken/[REDACTED]?client_secret=[REDACTED]&%74oken=[REDACTED]&mode=safe",
      ],
      result: {
        authorization: "[REDACTED]",
        endpoint: "https://mcp.example.test?%74oken=[REDACTED]#access_token=[REDACTED]",
        tokenId: "public-token-id",
        secretRef: "vault:mcp/public",
      },
    });
    expect(raw.args[2]).toBe("short-pass");
    expect(raw.result.authorization).toBe("Bearer short");
  });

  it("preserves MCP auth/count semantics and JSON Schema shape while removing schema defaults", () => {
    const raw = {
      authReadiness: "ready",
      authState: {
        authType: "oauth2",
        readiness: "ready",
        accessTokenRef: "keychain:mcp/token",
        error: "Failed at https://mcp.example.test/token/error-secret?token=error-query",
      },
      requiresGatewayAuth: true,
      needsAuth: 2,
      redactedSecretCount: 3,
      tokenRefreshSkewSeconds: 30,
      inputSchema: {
        type: "object",
        required: ["password"],
        properties: {
          password: { type: "string", default: "short-default", description: "Operator credential." },
          tokenBudget: { type: "number", default: 256 },
        },
      },
    };

    expect(projectMcpPublicValue(raw)).toMatchObject({
      authReadiness: "ready",
      authState: {
        authType: "oauth2",
        readiness: "ready",
        accessTokenRef: "keychain:mcp/token",
        error: "Failed at https://mcp.example.test/token/[REDACTED]?token=[REDACTED]",
      },
      requiresGatewayAuth: true,
      needsAuth: 2,
      redactedSecretCount: 3,
      tokenRefreshSkewSeconds: 30,
      inputSchema: {
        type: "object",
        required: ["password"],
        properties: {
          password: { type: "string", default: "[REDACTED]", description: "Operator credential." },
          tokenBudget: { type: "number", default: 256 },
        },
      },
    });
  });

  it("restores projected MCP argv and URL credentials on routine public updates", () => {
    const current = {
      serverId: "server-secret",
      label: "Secret server",
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "--password", "short-pass", "--api-key=short-key", "--port", "3000"],
      url: "https://mcp.example.test/token/path-secret?token=query-secret&mode=safe",
      authType: "none",
      enabled: true,
      status: "disconnected",
      category: "development",
      trustTier: "restricted",
      costTier: "free",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "strict",
        allowedToolPatterns: ["*"],
        blockedToolPatterns: [],
        notes: "Authorization: Bearer policy-secret",
      },
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    } satisfies McpServerRecord;
    const projected = projectMcpPublicValue(current);

    const routine = preserveMcpServerSecretsForPublicUpdate(current, {
      label: "Renamed server",
      args: projected.args?.map((entry) => (entry === "3000" ? "4000" : entry)),
      url: projected.url?.replace("mode=safe", "mode=fast"),
      policy: projected.policy,
    });
    const explicit = preserveMcpServerSecretsForPublicUpdate(current, {
      args: ["server.mjs", "--password", "replacement-pass", "--api-key=replacement-key"],
      url: "https://mcp.example.test/token/replacement-secret?token=replacement-query",
    });

    expect(routine).toMatchObject({
      label: "Renamed server",
      args: ["server.mjs", "--password", "short-pass", "--api-key=short-key", "--port", "4000"],
      url: "https://mcp.example.test/token/path-secret?token=query-secret&mode=fast",
      policy: current.policy,
    });
    expect(explicit).toMatchObject({
      args: ["server.mjs", "--password", "replacement-pass", "--api-key=replacement-key"],
      url: "https://mcp.example.test/token/replacement-secret?token=replacement-query",
    });
    expect(current.args[2]).toBe("short-pass");
    expect(current.url).toContain("path-secret");
  });

  it("fails closed on moved argv markers while keeping explicit argv deletion explicit", () => {
    const current = {
      serverId: "server-secret",
      label: "Secret server",
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "--password", "short-pass", "--api-key", "short-key", "--port", "3000"],
      authType: "none",
      enabled: true,
      status: "disconnected",
      category: "development",
      trustTier: "restricted",
      costTier: "free",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "strict",
        allowedToolPatterns: ["*"],
        blockedToolPatterns: [],
      },
      createdAt: "2026-07-09T12:00:00.000Z",
      updatedAt: "2026-07-09T12:00:00.000Z",
    } satisfies McpServerRecord;

    const moved = preserveMcpServerSecretsForPublicUpdate(current, {
      args: ["server.mjs", "--api-key", "[REDACTED]", "--password", "[REDACTED]", "--port", "4000"],
    });
    const deleted = preserveMcpServerSecretsForPublicUpdate(current, {
      args: ["server.mjs", "--port", "4000"],
    });
    const normalizedMarker = preserveMcpServerSecretsForPublicUpdate(current, {
      args: ["server.mjs", "--password", "[redacted]", "--api-key", "[ReDaCtEd]", "--port", "4000"],
    });

    expect(moved.args).toEqual(current.args);
    expect(deleted.args).toEqual(["server.mjs", "--port", "4000"]);
    expect(normalizedMarker.args).toEqual([
      "server.mjs",
      "--password",
      "short-pass",
      "--api-key",
      "short-key",
      "--port",
      "4000",
    ]);
    expect(current.args).toEqual([
      "server.mjs",
      "--password",
      "short-pass",
      "--api-key",
      "short-key",
      "--port",
      "3000",
    ]);
  });
});
