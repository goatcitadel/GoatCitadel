import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import type { DnsLookupFunction } from "../sandbox/network-guard.js";
import { createDefaultToolRegistry } from "../tool-registry.js";
import { deriveToolCapabilityPolicy } from "../tool-security.js";
import { executeCommsTool } from "./comms-executor.js";
import { CommsPreBoundaryProviderError } from "./comms-provider-errors.js";
import { smtpSend, type SmtpSendRuntime, type SmtpTransportFactory } from "./smtp-mail-executor.js";

const nodemailerMock = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: nodemailerMock, createTransport: nodemailerMock.createTransport }));

// The executor-level tests run the default (node:dns) lookup path; keep them offline.
const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  lookup: dnsMock.lookup,
}));

const PUBLIC_SMTP_IP = "93.184.216.34";

const SMTP_CONFIG = {
  smtpHost: "smtp.example.com",
  smtpUser: "ops@example.com",
  smtpPassword: "smtp-secret",
  fromAddress: "ops@example.com",
};

const SEND_ARGS = {
  connectionId: "smtp-conn",
  to: ["alice@example.com"],
  cc: ["bob@example.com"],
  bcc: ["carol@example.com"],
  subject: "Quarterly update",
  bodyText: "Numbers attached inline.",
};

function fakeLookup(address: string): DnsLookupFunction {
  return (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
      return;
    }
    callback(null, address, address.includes(":") ? 6 : 4);
  };
}

function testSecret(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined {
  const direct = config[directKey];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const envName = config[envKey];
  return typeof envName === "string" ? process.env[envName]?.trim() || undefined : undefined;
}

function fakeRuntime(
  overrides: Partial<SmtpSendRuntime> & { sendMail?: ReturnType<typeof vi.fn> } = {},
): SmtpSendRuntime & {
  createTransport: ReturnType<typeof vi.fn> & SmtpTransportFactory;
  markMutationRequestStarted: ReturnType<typeof vi.fn>;
  sendMail: ReturnType<typeof vi.fn>;
} {
  const sendMail = overrides.sendMail ?? vi.fn(async () => ({ messageId: "<m-1@x>" }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return {
    resolveSecret: testSecret,
    dnsLookup: fakeLookup(PUBLIC_SMTP_IP),
    ...overrides,
    createTransport: createTransport as unknown as ReturnType<typeof vi.fn> & SmtpTransportFactory,
    markMutationRequestStarted: vi.fn(async () => undefined),
    sendMail,
  };
}

function smtpError(message: string, code?: string, command?: string): Error {
  return Object.assign(new Error(message), { code, command });
}

beforeEach(() => {
  dnsMock.lookup.mockImplementation(fakeLookup(PUBLIC_SMTP_IP));
});

afterEach(() => {
  vi.unstubAllEnvs();
  nodemailerMock.createTransport.mockReset();
  dnsMock.lookup.mockReset();
});

describe("smtpSend", () => {
  it("connects to the guard-resolved address with SNI bound to the hostname and returns the messageId", async () => {
    const runtime = fakeRuntime();

    const messageId = await smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, runtime);

    expect(messageId).toBe("<m-1@x>");
    expect(runtime.createTransport).toHaveBeenCalledTimes(1);
    expect(runtime.createTransport).toHaveBeenCalledWith({
      host: PUBLIC_SMTP_IP,
      port: 587,
      secure: false,
      auth: { user: "ops@example.com", pass: "smtp-secret" },
      tls: { servername: "smtp.example.com" },
    });
    expect(runtime.sendMail).toHaveBeenCalledWith({
      from: "ops@example.com",
      to: ["alice@example.com"],
      cc: ["bob@example.com"],
      bcc: ["carol@example.com"],
      subject: "Quarterly update",
      text: "Numbers attached inline.",
    });
    expect(runtime.markMutationRequestStarted).toHaveBeenCalledTimes(1);
    expect(runtime.markMutationRequestStarted.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendMail.mock.invocationCallOrder[0]!,
    );
  });

  it("throws a partial-delivery error carrying the messageId when any recipient is refused", async () => {
    const runtime = fakeRuntime({
      sendMail: vi.fn(async () => ({
        messageId: "<m-2@x>",
        accepted: ["alice@example.com"],
        rejected: ["bob@example.com"],
      })),
    });

    const error = await smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, runtime).then(
      () => undefined,
      (caught: unknown) => caught as Error & { providerMessageId?: string },
    );

    expect(error?.message).toContain("partial_channel_delivery_sent");
    expect(error?.providerMessageId).toBe("<m-2@x>");
    expect(error).not.toBeInstanceOf(CommsPreBoundaryProviderError);
  });

  it("defaults secure to true on port 465, reads the password from an env var, and falls back to address", async () => {
    vi.stubEnv("GC_TEST_SMTP_PASSWORD", "env-secret");
    const runtime = fakeRuntime();

    await smtpSend(
      {
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpUser: "u",
        smtpPasswordEnv: "GC_TEST_SMTP_PASSWORD",
        address: "me@example.com",
      },
      { to: ["alice@example.com"], subject: "s", bodyText: "b" },
      ["smtp.example.com"],
      undefined,
      runtime,
    );

    expect(runtime.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, auth: { user: "u", pass: "env-secret" } }),
    );
    expect(runtime.sendMail.mock.calls[0]?.[0]).toMatchObject({ from: "me@example.com" });
  });

  it("omits auth when no SMTP user is configured and honors an explicit smtpSecure", async () => {
    const runtime = fakeRuntime();

    await smtpSend(
      { smtpHost: "smtp.example.com", smtpPort: "2525", smtpSecure: true, email: "me@example.com" },
      { to: ["alice@example.com"], subject: "s", bodyText: "b" },
      ["smtp.example.com"],
      undefined,
      runtime,
    );

    expect(runtime.createTransport).toHaveBeenCalledWith({
      host: PUBLIC_SMTP_IP,
      port: 2525,
      secure: true,
      tls: { servername: "smtp.example.com" },
    });
  });

  it("does not set an SNI servername for a literal IPv4 host", async () => {
    const runtime = fakeRuntime();

    await smtpSend({ ...SMTP_CONFIG, smtpHost: PUBLIC_SMTP_IP }, SEND_ARGS, [PUBLIC_SMTP_IP], undefined, runtime);

    expect(runtime.createTransport.mock.calls[0]?.[0]).toEqual(expect.not.objectContaining({ tls: expect.anything() }));
    expect(runtime.createTransport.mock.calls[0]?.[0]).toMatchObject({ host: PUBLIC_SMTP_IP });
  });

  it("blocks a hostname that resolves to a private address and never creates the transport", async () => {
    const runtime = fakeRuntime({ dnsLookup: fakeLookup("10.0.0.5") });

    await expect(smtpSend(SMTP_CONFIG, SEND_ARGS, ["*"], undefined, runtime)).rejects.toThrow(
      /^blocked: smtp\.send host failed guarded DNS resolution/,
    );
    expect(runtime.createTransport).not.toHaveBeenCalled();
    expect(runtime.markMutationRequestStarted).not.toHaveBeenCalled();
  });

  it("blocks a hostname that resolves to the metadata address", async () => {
    const runtime = fakeRuntime({ dnsLookup: fakeLookup("169.254.169.254") });

    await expect(smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, runtime)).rejects.toThrow(
      /^blocked:/,
    );
    expect(runtime.createTransport).not.toHaveBeenCalled();
  });

  it("maps a DNS lookup failure to a blocked pre-boundary error", async () => {
    const runtime = fakeRuntime({
      dnsLookup: (_hostname, _options, callback) =>
        callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), ""),
    });

    await expect(smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, runtime)).rejects.toThrow(
      /^blocked:.*ENOTFOUND/,
    );
    expect(runtime.createTransport).not.toHaveBeenCalled();
    expect(runtime.markMutationRequestStarted).not.toHaveBeenCalled();
  });

  it("throws before transport creation and the boundary when smtpHost is missing", async () => {
    const runtime = fakeRuntime();

    await expect(
      smtpSend({ ...SMTP_CONFIG, smtpHost: undefined }, SEND_ARGS, ["smtp.example.com"], undefined, runtime),
    ).rejects.toThrow(/smtpHost/);
    expect(runtime.createTransport).not.toHaveBeenCalled();
    expect(runtime.markMutationRequestStarted).not.toHaveBeenCalled();
  });

  it.each([
    ["absent from the network allowlist", SMTP_CONFIG, ["other.example.com"], undefined],
    ["absent from the grant allowlist", SMTP_CONFIG, ["smtp.example.com"], ["other.example.com"]],
    [
      "a private literal that is not explicitly allowlisted",
      { ...SMTP_CONFIG, smtpHost: "10.0.0.5" },
      ["*.example.com"],
      undefined,
    ],
  ])("blocks a host %s before the transport and the boundary", async (_label, config, allowlist, grantAllowlist) => {
    const runtime = fakeRuntime();

    await expect(smtpSend(config, SEND_ARGS, allowlist, grantAllowlist, runtime)).rejects.toThrow(/^blocked:/);
    expect(runtime.createTransport).not.toHaveBeenCalled();
    expect(runtime.markMutationRequestStarted).not.toHaveBeenCalled();
  });

  it("rejects a host value that smuggles a port, path, or credentials", async () => {
    const runtime = fakeRuntime();

    for (const smtpHost of ["smtp.example.com:25", "smtp.example.com/x", "user@smtp.example.com", "smtp example.com"]) {
      await expect(
        smtpSend({ ...SMTP_CONFIG, smtpHost }, SEND_ARGS, ["smtp.example.com", "*"], undefined, runtime),
      ).rejects.toThrow(/smtpHost/);
    }
    expect(runtime.createTransport).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port", async () => {
    const runtime = fakeRuntime();

    await expect(
      smtpSend({ ...SMTP_CONFIG, smtpPort: 70000 }, SEND_ARGS, ["smtp.example.com"], undefined, runtime),
    ).rejects.toThrow(/smtpPort/);
    expect(runtime.createTransport).not.toHaveBeenCalled();
  });

  it("throws when to is empty, before the transport and the boundary", async () => {
    const runtime = fakeRuntime();

    await expect(
      smtpSend(SMTP_CONFIG, { ...SEND_ARGS, to: [] }, ["smtp.example.com"], undefined, runtime),
    ).rejects.toThrow(/requires args\.to/);
    expect(runtime.createTransport).not.toHaveBeenCalled();
    expect(runtime.markMutationRequestStarted).not.toHaveBeenCalled();
  });

  it("throws when no from address is configured", async () => {
    const runtime = fakeRuntime();

    await expect(
      smtpSend({ ...SMTP_CONFIG, fromAddress: undefined }, SEND_ARGS, ["smtp.example.com"], undefined, runtime),
    ).rejects.toThrow(/from address/);
    expect(runtime.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["EAUTH", undefined, /^blocked: SMTP server rejected the configured credentials \(EAUTH\)/],
    ["ENOAUTH", undefined, /^blocked: SMTP server rejected the configured credentials \(ENOAUTH\)/],
    ["EDNS", "CONN", /before the message was sent \(EDNS\)/],
    ["ETLS", "CONN", /before the message was sent \(ETLS\)/],
    ["EENVELOPE", "RCPT TO", /before the message was sent \(EENVELOPE\)/],
  ])("classifies nodemailer %s as a pre-boundary failure", async (code, command, pattern) => {
    const runtime = fakeRuntime({
      sendMail: vi.fn(async () => Promise.reject(smtpError("server said no", code, command))),
    });

    const failure = await smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, runtime).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommsPreBoundaryProviderError);
    expect((failure as Error).message).toMatch(pattern);
  });

  it.each([
    ["ESOCKET", "DATA"],
    ["ETIMEDOUT", "CONN"],
    ["EMESSAGE", "DATA"],
    ["ESTREAM", undefined],
    ["ECONNECTION", "API"],
    ["ECONNECTION", "CONN"],
    [undefined, undefined],
  ])("leaves nodemailer %s (%s) as a possibly-sent failure", async (code, command) => {
    const original = smtpError("connection dropped", code, command);
    const runtime = fakeRuntime({ sendMail: vi.fn(async () => Promise.reject(original)) });

    await expect(smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, runtime)).rejects.toBe(original);
  });

  it("uses nodemailer as the default transport factory with TLS required and file/url access disabled", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "<default@x>" }));
    nodemailerMock.createTransport.mockReturnValue({ sendMail });

    await expect(
      smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, {
        resolveSecret: testSecret,
        markMutationRequestStarted: async () => undefined,
      }),
    ).resolves.toBe("<default@x>");

    expect(dnsMock.lookup).toHaveBeenCalledWith(
      "smtp.example.com",
      expect.objectContaining({ all: true }),
      expect.any(Function),
    );
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: PUBLIC_SMTP_IP,
        port: 587,
        secure: false,
        tls: { servername: "smtp.example.com" },
        requireTLS: true,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
  });
});

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

function smtpStorage(): { storage: Storage & AsyncStorage; markFailed: ReturnType<typeof vi.fn> } {
  const markFailed = vi.fn();
  const storage = {
    integrationConnections: {
      get: vi.fn(() => ({ connectionId: "smtp-conn", key: "smtp", config: SMTP_CONFIG })),
    },
    commsDeliveries: {
      createQueued: vi.fn((input: Record<string, unknown>) => ({
        deliveryId: "delivery-smtp",
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
      })),
      markSent: vi.fn(),
      markFailed,
    },
  } as unknown as Storage & AsyncStorage;
  return { storage, markFailed };
}

function smtpSendRequest(): ToolInvokeRequest {
  return { toolName: "smtp.send", args: SEND_ARGS, agentId: "operator", sessionId: "sess-smtp" };
}

describe("smtp.send through executeCommsTool", () => {
  it("dispatches smtp.send, crosses the durable boundary before sendMail, and reports the messageId", async () => {
    const order: string[] = [];
    const sendMail = vi.fn(async () => {
      order.push("sendMail");
      return { messageId: "<sent@x>" };
    });
    nodemailerMock.createTransport.mockReturnValue({ sendMail });
    const { storage } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage, undefined, {
      beforeExternalSideEffect: () => {
        order.push("boundary");
      },
    });

    expect(result).toMatchObject({ status: "sent", deliveryStatus: "sent", providerMessageId: "<sent@x>" });
    expect(order).toEqual(["boundary", "sendMail"]);
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: PUBLIC_SMTP_IP, tls: { servername: "smtp.example.com" } }),
    );
  });

  it("classifies a host outside the allowlist as blocked without crossing the boundary", async () => {
    const boundary = vi.fn();
    const { storage } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["other.example.com"]), storage, undefined, {
      beforeExternalSideEffect: boundary,
    });

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(boundary).not.toHaveBeenCalled();
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
  });

  it("classifies a DNS answer pointing at a private address as blocked without crossing the boundary", async () => {
    dnsMock.lookup.mockImplementation(fakeLookup("10.0.0.5"));
    const boundary = vi.fn();
    const { storage } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage, undefined, {
      beforeExternalSideEffect: boundary,
    });

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(boundary).not.toHaveBeenCalled();
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
  });

  it("reports an SMTP auth rejection as a readable pre-boundary failure, not manual reconciliation", async () => {
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: vi.fn(async () =>
        Promise.reject(smtpError("Invalid login: 535 5.7.8 rejected", "EAUTH", "AUTH PLAIN")),
      ),
    });
    const { storage } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage);

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
    expect(String(result.error)).toContain("rejected the configured credentials");
    expect(String(result.error)).not.toContain("unknown_after_send");
  });

  it("reports a pre-DATA TLS failure as not_available, not manual reconciliation", async () => {
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: vi.fn(async () =>
        Promise.reject(smtpError("Error initiating TLS - certificate has expired", "ETLS", "CONN")),
      ),
    });
    const { storage } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage);

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "not_available" });
    expect(String(result.error)).not.toContain("unknown_after_send");
  });

  it("reports a partial delivery (one recipient accepted, one refused) as manual reconciliation, never sent", async () => {
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: vi.fn(async () => ({
        messageId: "<partial@x>",
        accepted: ["alice@example.com"],
        rejected: ["bob@example.com"],
        rejectedErrors: [smtpError("550 mailbox unavailable", "EENVELOPE", "RCPT TO")],
      })),
    });
    const { storage, markFailed } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage);

    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "<partial@x>",
    });
    expect(result.status).not.toBe("sent");
    expect(String(result.error)).toContain("partial_channel_delivery_sent");
    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it("classifies an unexpected close (ECONNECTION/CONN, possibly after DATA) as an unknown outcome", async () => {
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: vi.fn(async () => Promise.reject(smtpError("Connection closed unexpectedly", "ECONNECTION", "CONN"))),
    });
    const { storage } = smtpStorage();

    const result = await executeCommsTool(smtpSendRequest(), policyConfig(["smtp.example.com"]), storage);

    expect(result).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
    expect(String(result.error)).toContain("unknown_after_send");
  });
});

describe("smtp.send registry entry", () => {
  it("is a danger comms tool that requires approval", () => {
    const tool = createDefaultToolRegistry()
      .toCatalog()
      .find((entry) => entry.toolName === "smtp.send");

    expect(tool).toMatchObject({ category: "comms", riskLevel: "danger", requiresApproval: true, pack: "comms" });
  });

  it("is classified as a secret-resolving remote mutation", () => {
    expect(deriveToolCapabilityPolicy("smtp.send", { category: "comms" })).toMatchObject({
      family: "comms",
      usesNetwork: true,
      mutatesRemoteState: true,
      resolvesSecrets: true,
      blocksUntrustedEscalation: true,
    });
  });
});
