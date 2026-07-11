import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { executeTool } from "../tool-executor.js";

const TOKEN_ID = "rat_boundary_matrix";
const TOKEN_REF = `keychain:goatcitadel:approval-remote-action:${TOKEN_ID}`;
const RAW_TOKEN = `grat_${"b".repeat(43)}`;
const EXPIRES_AT = "2099-07-10T00:15:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("protected approval action provider boundary", () => {
  it("rejects providers without native authenticated approval actions before resolving a bearer", async () => {
    const harness = createHarness({ channelKey: "slack" });

    const result = await executeTool(createRequest(), createConfig(["slack.com"]), harness.storage, harness.runtime);

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(harness.deleteSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.createQueued.mock.calls)).not.toContain(RAW_TOKEN);
  });

  it("blocks a token bound to another connector without resolving or deleting it", async () => {
    const harness = createHarness({ connectorId: "integration:another-connection" });

    const result = await executeTool(
      createRequest(),
      createConfig(["api.telegram.org"]),
      harness.storage,
      harness.runtime,
    );

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(harness.deleteSecret).not.toHaveBeenCalled();
  });

  it("deletes an expired terminal token before provider dispatch", async () => {
    const expiresAt = "2020-07-10T00:15:00.000Z";
    const harness = createHarness({ expiresAt });
    const request = createRequest({ expiresAt });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(request, createConfig(["api.telegram.org"]), harness.storage, harness.runtime);

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(harness.deleteSecret).toHaveBeenCalledWith(TOKEN_REF);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the secret when policy blocks before the provider request", async () => {
    const harness = createHarness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(createRequest(), createConfig(["localhost"]), harness.storage, harness.runtime);

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(harness.resolveSecret).toHaveBeenCalledWith(TOKEN_REF);
    expect(harness.deleteSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when authenticated callback ingress is no longer ready at provider dispatch", async () => {
    const harness = createHarness({ approvalReady: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      createRequest(),
      createConfig(["api.telegram.org"]),
      harness.storage,
      harness.runtime,
    );

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(harness.approvalReady).toHaveBeenCalledWith("conn-telegram");
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(harness.deleteSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, status: "connected" },
    { enabled: true, status: "disconnected" },
  ])("does not dispatch through a disabled or disconnected integration: %o", async ({ enabled, status }) => {
    const harness = createHarness({ enabled, status });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      createRequest(),
      createConfig(["api.telegram.org"]),
      harness.storage,
      harness.runtime,
    );

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(harness.approvalReady).not.toHaveBeenCalled();
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(harness.deleteSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes the secret after an unknown external outcome to prevent a duplicate send", async () => {
    const harness = createHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket reset after write");
      }),
    );

    const result = await executeTool(
      createRequest(),
      createConfig(["api.telegram.org"]),
      harness.storage,
      harness.runtime,
    );

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
    expect(harness.deleteSecret).toHaveBeenCalledWith(TOKEN_REF);
  });

  it("rejects case-varied pre-hydrated raw callbacks even when a secret reference is present", async () => {
    const harness = createHarness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = createRequest();
    const template = request.args.interactiveActionTemplate as Record<string, unknown>;
    template.buttons = [
      { label: "Approve", decision: "a", callbackData: `GCA:${RAW_TOKEN}:A` },
      { label: "Deny", decision: "r" },
    ];

    await expect(
      executeTool(request, createConfig(["api.telegram.org"]), harness.storage, harness.runtime),
    ).rejects.toThrow(/raw remote approval bearers/i);
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bare approval bearer anywhere in native tool arguments", async () => {
    const harness = createHarness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = createRequest();
    request.args.message = `Never persist ${RAW_TOKEN}`;

    await expect(
      executeTool(request, createConfig(["api.telegram.org"]), harness.storage, harness.runtime),
    ).rejects.toThrow(/raw remote approval bearers/i);
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not classify a benign token-like message as a raw approval bearer", async () => {
    const harness = createHarness();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = createRequest();
    request.args.message = "Use grat_community_discount_code for the operator note.";

    await expect(
      executeTool(request, createConfig(["api.telegram.org"]), harness.storage, harness.runtime),
    ).resolves.toMatchObject({ status: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([`x${RAW_TOKEN}`, `${RAW_TOKEN}x`])("rejects recoverable decorated approval bearer %s", async (message) => {
    const harness = createHarness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = createRequest();
    request.args.message = message;

    await expect(
      executeTool(request, createConfig(["api.telegram.org"]), harness.storage, harness.runtime),
    ).rejects.toThrow(/raw remote approval bearers/i);
    expect(harness.resolveSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createHarness(
  overrides: {
    channelKey?: string;
    connectorId?: string;
    expiresAt?: string;
    enabled?: boolean;
    status?: string;
    approvalReady?: boolean;
  } = {},
) {
  const channelKey = overrides.channelKey ?? "telegram";
  const expiresAt = overrides.expiresAt ?? EXPIRES_AT;
  const createQueued = vi.fn((input: Record<string, unknown>) => ({
    deliveryId: "delivery-boundary-matrix",
    status: "queued",
    channelKey: input.channelKey,
    target: input.target,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  }));
  const resolveSecret = vi.fn(() => RAW_TOKEN);
  const deleteSecret = vi.fn();
  const approvalReady = vi.fn(() => overrides.approvalReady ?? true);
  const storage = {
    integrationConnections: {
      get: vi.fn(() => ({
        connectionId: "conn-telegram",
        key: channelKey,
        enabled: overrides.enabled ?? true,
        status: overrides.status ?? "connected",
        config:
          channelKey === "telegram"
            ? { botToken: "telegram-provider-token", defaultChatId: "-1001234567890" }
            : { botToken: "slack-provider-token", defaultChannel: "#approvals" },
      })),
    },
    remoteActionTokens: {
      get: vi.fn(() => ({
        tokenId: TOKEN_ID,
        actionType: "approval.resolve",
        approvalId: "approval-boundary-matrix",
        connectorId: overrides.connectorId ?? "integration:conn-telegram",
        mutation: { approvalId: "approval-boundary-matrix" },
        createdAt: "2026-07-10T00:00:00.000Z",
        expiresAt,
        state: "pending",
      })),
    },
    commsDeliveries: {
      createQueued,
      markSent: vi.fn(),
      markFailed: vi.fn(),
    },
  } as unknown as Storage;
  return {
    storage,
    createQueued,
    resolveSecret,
    deleteSecret,
    approvalReady,
    runtime: {
      resolveApprovalActionTokenSecret: resolveSecret,
      deleteApprovalActionTokenSecret: deleteSecret,
      isApprovalActionConnectorReady: approvalReady,
    },
  };
}

function createRequest(overrides: { expiresAt?: string } = {}): ToolInvokeRequest {
  return {
    toolName: "channel.send",
    args: {
      connectionId: "conn-telegram",
      target: "-1001234567890",
      message: "Approval requested.",
      interactiveActionTemplate: {
        platform: "telegram",
        tokenId: TOKEN_ID,
        tokenRef: TOKEN_REF,
        expiresAt: overrides.expiresAt ?? EXPIRES_AT,
        buttons: [
          { label: "Approve", decision: "a" },
          { label: "Deny", decision: "r" },
        ],
      },
    },
    agentId: "operator",
    sessionId: "session-boundary-matrix",
    authContext: { boundary: "tool_host_boundary", secretRefs: [TOKEN_REF] },
  };
}

function createConfig(networkAllowlist: string[]): ToolPolicyConfig {
  return {
    profiles: { minimal: ["session.status"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist,
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}
