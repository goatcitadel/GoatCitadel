import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import type { DnsLookupFunction } from "../sandbox/network-guard.js";
import { executeCommsTool, type ChannelEnvSecretRequest, type ChannelEnvSecretResolution } from "./comms-executor.js";

/**
 * The SMTP password variable is read through the same Gateway hook as every channel's variable. The hook here is a
 * stand-in with a small rule of its own; the Gateway tests drive the real rule through this same executor.
 */

const nodemailerMock = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: nodemailerMock, createTransport: nodemailerMock.createTransport }));

// The executor runs the default (node:dns) lookup path; keep it offline.
const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  lookup: dnsMock.lookup,
}));

const PUBLIC_SMTP_IP = "93.184.216.34";
const REFUSAL = "The variable name must start with SMTP_ or IMAP_. Rename it and restart GoatCitadel.";
const OPENAI_VALUE = "synthetic-openai-value-0101";
const SMTP_VALUE = "synthetic-smtp-password-0102";

function fakeLookup(address: string): DnsLookupFunction {
  return (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
      return;
    }
    callback(null, address, address.includes(":") ? 6 : 4);
  };
}

function policyConfig(allowlist: string[]): ToolPolicyConfig {
  return {
    profiles: { minimal: ["session.status"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./skills"],
      networkAllowlist: allowlist,
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

/** The Gateway's job in miniature: refuse a name that starts with neither SMTP_ nor IMAP_, read the rest from the environment. */
function smtpOnlyHook() {
  return vi.fn((input: ChannelEnvSecretRequest): ChannelEnvSecretResolution => {
    if (!/^(SMTP|IMAP)_/u.test(input.envName)) return { refusal: REFUSAL };
    return { value: process.env[input.envName] };
  });
}

beforeEach(() => {
  dnsMock.lookup.mockImplementation(fakeLookup(PUBLIC_SMTP_IP));
});

afterEach(() => {
  vi.unstubAllEnvs();
  nodemailerMock.createTransport.mockReset();
  dnsMock.lookup.mockReset();
});

describe("smtp.send reads its password variable through the Gateway's name rule", () => {
  it.each([
    ["OPENAI_API_KEY", OPENAI_VALUE],
    ["GOATCITADEL_AUTH_TOKEN", "synthetic-gateway-auth-value-0103"],
  ])("fails before any lookup or connection when smtpPasswordEnv is %s", async (name, value) => {
    vi.stubEnv(name, value);
    const boundary = vi.fn();
    const hook = smtpOnlyHook();
    const { storage, createQueued, markSent, markFailed } = smtpStorage({ smtpPasswordEnv: name });

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: hook,
      beforeExternalSideEffect: boundary,
    });

    expect(hook).toHaveBeenCalledWith({
      catalogId: "automation.imap-smtp",
      channelKey: "imap-smtp",
      field: "smtpPasswordEnv",
      envName: name,
    });
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(String(result.error)).toContain(REFUSAL);
    expect(dnsMock.lookup).not.toHaveBeenCalled();
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
    expect(boundary).not.toHaveBeenCalled();
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(value);
  });

  it("sends with the value the hook gives for a correctly named variable, not the process environment's", async () => {
    vi.stubEnv("SMTP_PASSWORD", "value-from-the-process-environment");
    const sendMail = vi.fn(async () => ({ messageId: "<sent@x>" }));
    nodemailerMock.createTransport.mockReturnValue({ sendMail });
    const hook = vi.fn((_input: ChannelEnvSecretRequest): ChannelEnvSecretResolution => ({ value: ` ${SMTP_VALUE} ` }));
    const { storage, createQueued, markSent, markFailed } = smtpStorage({ smtpPasswordEnv: "SMTP_PASSWORD" });

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "sent", providerMessageId: "<sent@x>" });
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "ops@example.com", pass: SMTP_VALUE } }),
    );
    const kept = JSON.stringify([result, createQueued.mock.calls, markSent.mock.calls, markFailed.mock.calls]);
    expect(kept).not.toContain(SMTP_VALUE);
  });

  it("fails closed with no hook, even when a well-named variable is set", async () => {
    vi.stubEnv("SMTP_PASSWORD", SMTP_VALUE);
    const { storage } = smtpStorage({ smtpPasswordEnv: "SMTP_PASSWORD" });

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage);

    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.error)).toContain("Missing SMTP password");
    expect(dnsMock.lookup).not.toHaveBeenCalled();
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
  });

  it("says the password is missing when the hook finds the allowed variable unset", async () => {
    const { storage } = smtpStorage({ smtpPasswordEnv: "SMTP_PASSWORD" });

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: () => ({}),
    });

    expect(String(result.error)).toContain("Missing SMTP password");
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
  });

  it("uses a pasted password without asking, even when the variable's name would be refused", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_VALUE);
    nodemailerMock.createTransport.mockReturnValue({ sendMail: vi.fn(async () => ({ messageId: "<d@x>" })) });
    const hook = smtpOnlyHook();
    const { storage } = smtpStorage({ smtpPassword: "pasted-smtp-password", smtpPasswordEnv: "OPENAI_API_KEY" });

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage, undefined, {
      resolveChannelEnvSecret: hook,
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(hook).not.toHaveBeenCalled();
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "ops@example.com", pass: "pasted-smtp-password" } }),
    );
  });
});
