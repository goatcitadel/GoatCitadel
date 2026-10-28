import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the persistent channel-stream lifecycle wiring in the runtime facade: streams start only on the
 * serving path (startDeferredInit), never from admin/cron init(), and every shutdown path closes them
 * before the gateway itself.
 */

const calls: string[] = [];

const streams = {
  sync: vi.fn(async () => {
    calls.push("streams.sync");
  }),
  close: vi.fn(async () => {
    calls.push("streams.close");
  }),
};

const voiceGates: Array<() => Promise<boolean>> = [];
const referenceReaders: Array<(secretRef: string) => string | undefined> = [];
const resolveConnectionSecret = vi.fn((config: Record<string, unknown>, directKey: string) =>
  config[directKey] === "keychain:goatcitadel:channel-connection:c1:botToken:n1" ? "stored-secret" : undefined,
);
const isFeatureEnabled = vi.fn(async (flag: string) => flag === "channelVoiceInboundV1Enabled");

class FakeGatewayService {
  readonly discordRuntimeService = {
    setVoiceInboundGate: (gate: () => Promise<boolean>) => {
      voiceGates.push(gate);
    },
    setSecretReferenceReader: (read: (secretRef: string) => string | undefined) => {
      referenceReaders.push(read);
    },
  };
  readonly isFeatureEnabled = isFeatureEnabled;
  readonly resolveConnectionSecret = resolveConnectionSecret;
  constructor(..._args: unknown[]) {
    calls.push("gateway.construct");
  }
  async init(): Promise<void> {
    calls.push("gateway.init");
  }
  async initCritical(): Promise<void> {
    calls.push("gateway.initCritical");
  }
  async startDeferredInit(_signal?: AbortSignal): Promise<void> {
    calls.push("gateway.startDeferredInit");
  }
  async stopExternalAdmission(): Promise<void> {
    calls.push("gateway.stopExternalAdmission");
  }
  async close(): Promise<void> {
    calls.push("gateway.close");
  }
}

vi.mock("./gateway-service.js", () => ({ GatewayService: FakeGatewayService }));
const getChannelStreamRuntime = vi.fn(() => streams);
vi.mock("./channel-stream-runtime-registry.js", () => ({ getChannelStreamRuntime }));
vi.mock("./remote-worker-gateway-handler-composition.js", () => ({
  composeGatewayNativeWorkerHandler: vi.fn(),
}));

const { createGatewayAdminRuntime, createGatewayRuntime } = await import("./gateway-runtime-factory.js");

const config = {} as Parameters<typeof createGatewayRuntime>[0];

describe("gateway runtime facade channel-stream lifecycle", () => {
  beforeEach(() => {
    calls.length = 0;
    voiceGates.length = 0;
    referenceReaders.length = 0;
    resolveConnectionSecret.mockClear();
    isFeatureEnabled.mockClear();
    streams.sync.mockClear();
    streams.close.mockClear();
    getChannelStreamRuntime.mockClear();
  });

  it("syncs channel streams after the serving startDeferredInit", async () => {
    const runtime = createGatewayRuntime(config);
    await runtime.startDeferredInit();
    expect(calls).toEqual(["gateway.construct", "gateway.startDeferredInit", "streams.sync"]);
  });

  it("does not sync channel streams when the deferred-init signal is already aborted", async () => {
    const runtime = createGatewayRuntime(config);
    const controller = new AbortController();
    controller.abort();
    await runtime.startDeferredInit(controller.signal);
    expect(streams.sync).not.toHaveBeenCalled();
  });

  it("closes channel streams before the gateway on close and on stopExternalAdmission", async () => {
    const runtime = createGatewayRuntime(config);
    await runtime.stopExternalAdmission?.();
    expect(calls.slice(1)).toEqual(["streams.close", "gateway.stopExternalAdmission"]);
    calls.length = 0;
    await runtime.close();
    expect(calls).toEqual(["streams.close", "gateway.close"]);
  });

  it("never constructs or syncs channel streams from admin/cron init", async () => {
    const admin = createGatewayAdminRuntime(config);
    await admin.init();
    await admin.initCritical();
    expect(streams.sync).not.toHaveBeenCalled();
    expect(calls).toEqual(["gateway.construct", "gateway.init", "gateway.initCritical"]);
    expect(getChannelStreamRuntime).not.toHaveBeenCalled();
    await admin.close();
    expect(streams.close).toHaveBeenCalledTimes(1);
  });

  it("wires the Discord voice-inbound gate before serving deferred init, never from admin/cron init", async () => {
    const admin = createGatewayAdminRuntime(config);
    await admin.init();
    expect(voiceGates).toHaveLength(0);

    const runtime = createGatewayRuntime(config);
    expect(voiceGates).toHaveLength(0);
    await runtime.startDeferredInit();
    expect(voiceGates).toHaveLength(1);
    await expect(voiceGates[0]!()).resolves.toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith("channelVoiceInboundV1Enabled");
  });

  it("gives the Discord runtime the Gateway's saved-key reader before serving deferred init, never from admin/cron init", async () => {
    const admin = createGatewayAdminRuntime(config);
    await admin.init();
    expect(referenceReaders).toHaveLength(0);

    const runtime = createGatewayRuntime(config);
    expect(referenceReaders).toHaveLength(0);
    await runtime.startDeferredInit();
    expect(referenceReaders).toHaveLength(1);
    expect(referenceReaders[0]!("keychain:goatcitadel:channel-connection:c1:botToken:n1")).toBe("stored-secret");
    expect(referenceReaders[0]!("keychain:goatcitadel:channel-connection:c2:botToken:n2")).toBeUndefined();
    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      { ref: "keychain:goatcitadel:channel-connection:c1:botToken:n1" },
      "ref",
      "refEnv",
    );
  });
});
