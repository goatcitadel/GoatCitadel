import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeTool, type ToolExecutorRuntimeHooks } from "@goatcitadel/policy-engine";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { resolveChannelSendEnvSecret } from "./channel-secret-resolution.js";

/**
 * smtp.send through the real executor with the hook the Gateway wires, so the rule that decides which password
 * variable a send may read is the real one. DNS is mocked and answers with a private address, which the executor
 * refuses: a send that gets past the password check ends there, and nothing ever connects.
 */

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  lookup: dnsMock.lookup,
}));

const OPENAI_VALUE = "synthetic-openai-value-0201";
const AUTH_VALUE = "synthetic-gateway-auth-value-0202";
const SMTP_VALUE = "synthetic-smtp-password-0203";
const REFUSAL = "The variable name must start with SMTP_ or IMAP_. Rename it and restart GoatCitadel.";
const hooks: ToolExecutorRuntimeHooks = { resolveChannelEnvSecret: resolveChannelSendEnvSecret };

function privateLookup(
  _hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, result: unknown, family?: number) => void,
) {
  if (options.all) {
    callback(null, [{ address: "10.0.0.5", family: 4 }]);
    return;
  }
  callback(null, "10.0.0.5", 4);
}

function policyConfig(): ToolPolicyConfig {
  return {
    profiles: { minimal: ["session.status"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: ["smtp.example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function smtpStorage(config: Record<string, unknown>) {
  const createQueued = vi.fn((input: Record<string, unknown>) => ({
    deliveryId: "delivery-smtp",
    status: "queued",
    channelKey: input.channelKey,
    target: input.target,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  }));
  const markSent = vi.fn();
  const markFailed = vi.fn();
  const storage = {
    integrationConnections: {
      get: vi.fn(() => ({
        connectionId: "smtp-conn",
        catalogId: "automation.imap-smtp",
        kind: "automation",
        key: "imap-smtp",
        enabled: true,
        status: "connected",
        config: {
          smtpHost: "smtp.example.com",
          smtpUser: "ops@example.com",
          fromAddress: "ops@example.com",
          ...config,
        },
      })),
    },
    commsDeliveries: { createQueued, markSent, markFailed },
  } as unknown as Storage & AsyncStorage;
  return { storage, createQueued, markSent, markFailed };
}

function smtpSendRequest(): ToolInvokeRequest {
  return {
    toolName: "smtp.send",
    args: { connectionId: "smtp-conn", to: ["alice@example.com"], subject: "Update", bodyText: "Numbers." },
    agentId: "operator",
    sessionId: "sess-smtp",
  };
}

beforeEach(() => {
  dnsMock.lookup.mockImplementation(privateLookup);
});

afterEach(() => {
  dnsMock.lookup.mockReset();
  vi.unstubAllEnvs();
});

describe("smtp.send and the Gateway's name rule", () => {
  it.each([
    ["OPENAI_API_KEY", OPENAI_VALUE],
    ["GOATCITADEL_AUTH_TOKEN", AUTH_VALUE],
    ["SLACK_BOT_TOKEN", "synthetic-slack-bot-value-0204"],
  ])("fails before any lookup when smtpPasswordEnv is %s, and says the name is not allowed", async (name, value) => {
    vi.stubEnv(name, value);
    const { storage, createQueued, markSent, markFailed } = smtpStorage({ smtpPasswordEnv: name });

    const result = await executeTool(smtpSendRequest(), policyConfig(), storage, hooks);

    expect(dnsMock.lookup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(result.error).toBe(`blocked: ${REFUSAL}`);
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(value);
  });

  it.each([["SMTP_PASSWORD"], ["IMAP_PASSWORD"], ["IMAP_SMTP_PASSWORD"], ["INTEGRATION_IMAP_SMTP_PASSWORD"]])(
    "gets past the password check with %s",
    async (name) => {
      vi.stubEnv(name, SMTP_VALUE);
      const { storage, createQueued, markSent, markFailed } = smtpStorage({ smtpPasswordEnv: name });

      const result = await executeTool(smtpSendRequest(), policyConfig(), storage, hooks);

      // The private DNS answer is what stops it, after the password was read and before any connection.
      expect(dnsMock.lookup).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
      expect(String(result.error)).not.toContain("must start with");
      expect(String(result.error)).not.toContain("Missing SMTP password");
      const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
      expect(kept).not.toContain(SMTP_VALUE);
    },
  );

  it("says the password is missing when the allowed variable is not set", async () => {
    const { storage } = smtpStorage({ smtpPasswordEnv: "SMTP_PASSWORD" });

    const result = await executeTool(smtpSendRequest(), policyConfig(), storage, hooks);

    expect(dnsMock.lookup).not.toHaveBeenCalled();
    expect(String(result.error)).toContain("Missing SMTP password");
  });

  it("keeps a token pasted into the name field out of the failure and the ledger", async () => {
    const pasted = "pasted-token-0205-not-a-name";
    vi.stubEnv(pasted, SMTP_VALUE);
    const { storage, createQueued, markSent, markFailed } = smtpStorage({ smtpPasswordEnv: pasted });

    const result = await executeTool(smtpSendRequest(), policyConfig(), storage, hooks);

    expect(result.error).toBe(`blocked: ${REFUSAL}`);
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(pasted);
    expect(kept).not.toContain(SMTP_VALUE);
  });

  it("fails closed with no hook, even for the well-named variable the form suggests", async () => {
    vi.stubEnv("SMTP_PASSWORD", SMTP_VALUE);
    const { storage } = smtpStorage({ smtpPasswordEnv: "SMTP_PASSWORD" });

    const result = await executeTool(smtpSendRequest(), policyConfig(), storage);

    expect(dnsMock.lookup).not.toHaveBeenCalled();
    expect(String(result.error)).toContain("Missing SMTP password");
  });
});
