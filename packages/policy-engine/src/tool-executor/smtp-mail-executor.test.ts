import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { createDefaultToolRegistry } from "../tool-registry.js";
import { deriveToolCapabilityPolicy } from "../tool-security.js";
import { executeCommsTool } from "./comms-executor.js";
import { smtpSend, type SmtpTransportFactory } from "./smtp-mail-executor.js";

const nodemailerMock = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: nodemailerMock, createTransport: nodemailerMock.createTransport }));

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

function fakeTransportFactory(sendMail: ReturnType<typeof vi.fn> = vi.fn(async () => ({ messageId: "<m-1@x>" }))) {
  const factory = vi.fn(() => ({ sendMail }));
  return { factory: factory as unknown as SmtpTransportFactory & typeof factory, sendMail };
}

afterEach(() => {
  vi.unstubAllEnvs();
  nodemailerMock.createTransport.mockReset();
});

describe("smtpSend", () => {
  it("sends through the pinned host, port, and auth and returns the provider messageId", async () => {
    const { factory, sendMail } = fakeTransportFactory();

    const messageId = await smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"], undefined, factory);

    expect(messageId).toBe("<m-1@x>");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "ops@example.com", pass: "smtp-secret" },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: "ops@example.com",
      to: ["alice@example.com"],
      cc: ["bob@example.com"],
      bcc: ["carol@example.com"],
      subject: "Quarterly update",
      text: "Numbers attached inline.",
    });
  });

  it("defaults secure to true on port 465, reads the password from an env var, and falls back to address", async () => {
    vi.stubEnv("GC_TEST_SMTP_PASSWORD", "env-secret");
    const { factory, sendMail } = fakeTransportFactory();

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
      factory,
    );

    expect(factory).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "u", pass: "env-secret" },
    });
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ from: "me@example.com" });
  });

  it("omits auth when no SMTP user is configured and honors an explicit smtpSecure", async () => {
    const { factory } = fakeTransportFactory();

    await smtpSend(
      { smtpHost: "smtp.example.com", smtpPort: "2525", smtpSecure: true, email: "me@example.com" },
      { to: ["alice@example.com"], subject: "s", bodyText: "b" },
      ["smtp.example.com"],
      undefined,
      factory,
    );

    expect(factory).toHaveBeenCalledWith({ host: "smtp.example.com", port: 2525, secure: true });
  });

  it("throws before transport creation when smtpHost is missing", async () => {
    const { factory } = fakeTransportFactory();

    await expect(
      smtpSend({ ...SMTP_CONFIG, smtpHost: undefined }, SEND_ARGS, ["smtp.example.com"], undefined, factory),
    ).rejects.toThrow(/smtpHost/);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    ["absent from the network allowlist", ["other.example.com"], undefined],
    ["absent from the grant allowlist", ["smtp.example.com"], ["other.example.com"]],
    ["a private address that is not explicitly allowlisted", ["*.example.com"], undefined],
  ])("blocks a host %s and never creates the transport", async (_label, allowlist, grantAllowlist) => {
    const { factory } = fakeTransportFactory();
    const config = _label.startsWith("a private") ? { ...SMTP_CONFIG, smtpHost: "10.0.0.5" } : SMTP_CONFIG;

    await expect(smtpSend(config, SEND_ARGS, allowlist, grantAllowlist, factory)).rejects.toThrow(/^blocked:/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects a host value that smuggles a port, path, or credentials", async () => {
    const { factory } = fakeTransportFactory();

    for (const smtpHost of ["smtp.example.com:25", "smtp.example.com/x", "user@smtp.example.com", "smtp example.com"]) {
      await expect(
        smtpSend({ ...SMTP_CONFIG, smtpHost }, SEND_ARGS, ["smtp.example.com", "*"], undefined, factory),
      ).rejects.toThrow(/smtpHost/);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port", async () => {
    const { factory } = fakeTransportFactory();

    await expect(
      smtpSend({ ...SMTP_CONFIG, smtpPort: 70000 }, SEND_ARGS, ["smtp.example.com"], undefined, factory),
    ).rejects.toThrow(/smtpPort/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("throws when to is empty", async () => {
    const { factory } = fakeTransportFactory();

    await expect(
      smtpSend(SMTP_CONFIG, { ...SEND_ARGS, to: [] }, ["smtp.example.com"], undefined, factory),
    ).rejects.toThrow(/requires args\.to/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("throws when no from address is configured", async () => {
    const { factory } = fakeTransportFactory();

    await expect(
      smtpSend({ ...SMTP_CONFIG, fromAddress: undefined }, SEND_ARGS, ["smtp.example.com"], undefined, factory),
    ).rejects.toThrow(/from address/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses nodemailer as the default transport factory with TLS required and file/url access disabled", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "<default@x>" }));
    nodemailerMock.createTransport.mockReturnValue({ sendMail });

    await expect(smtpSend(SMTP_CONFIG, SEND_ARGS, ["smtp.example.com"])).resolves.toBe("<default@x>");

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
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

  it("classifies a failure after the SMTP exchange started as an unknown outcome", async () => {
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: vi.fn(async () => {
        throw new Error("Connection closed unexpectedly");
      }),
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
