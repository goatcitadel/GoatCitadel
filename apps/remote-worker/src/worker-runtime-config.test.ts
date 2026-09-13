import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTED_WORKER_ENV as names,
  parseConnectedWorkerConfig,
  parseConnectedWorkerStartup,
} from "./worker-runtime-config.js";

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./worker-windows-protected-transport.js", () => ({ createWindowsProtectedWorkerTransport: native.create }));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "goat-worker-startup-"));
  const file = (name: string, content: string) => {
    const target = join(root, name);
    writeFileSync(target, content, { flag: "wx" });
    return target;
  };
  const ticket = { workerId: "test-worker", protectedSignerPublicKeySpkiBase64Url: "public-signer" };
  const env: Record<string, string | undefined> = {
    [names.host]: "127.0.0.1",
    [names.port]: "9443",
    [names.clientCertificateFile]: file("client.pem", "public certificate"),
    [names.trustAnchorFile]: file("ca.pem", "public CA"),
    [names.ticketFile]: file("ticket.json", JSON.stringify(ticket)),
    [names.stateDir]: join(root, "state"),
    [names.reportFile]: join(root, "report.json"),
    [names.runId]: "startup",
    [names.protectedKeyFile]: file("protected-key.txt", "public-key-reference"),
  };
  return { env, ticket, file };
}

beforeEach(() => {
  native.create.mockReset();
});

describe("connected worker startup key authority", () => {
  it("loads only public material before delegating to the fixed installed transport owner", () => {
    const { env, ticket } = fixture();
    const transport = Object.freeze({ clientTlsContext: {} });
    const protectedKeys = Object.freeze({ reference: {} });
    native.create.mockReturnValue({ transport, protectedKeys });
    const startup = parseConnectedWorkerStartup(env);
    expect(native.create).toHaveBeenCalledExactlyOnceWith({
      transport: {
        host: "127.0.0.1",
        port: 9443,
        clientCertificatePem: "public certificate",
        trustAnchorPem: "public CA",
      },
      tlsKeyIdentifier: "public-key-reference",
      admissionSignerSpkiBase64Url: "public-signer",
    });
    expect(startup.protectedKeys).toBe(protectedKeys);
    expect(startup.config.transport).toBe(transport);
    expect(startup.config.ticket).toEqual(ticket);
    expect(startup.config).toMatchObject({
      stopAfter: "complete",
      executionMode: "gateway_inference",
      runMode: "once",
    });
    expect(Object.isFrozen(startup.config)).toBe(true);
    expect(Object.isFrozen(startup.config.ticket)).toBe(true);
  });

  it("keeps explicitly configured PEM startup separate from native loading", () => {
    const { env, file } = fixture();
    delete env[names.protectedKeyFile];
    env[names.clientKeyFile] = file("private.pem", "fixture-private-key");
    expect(parseConnectedWorkerStartup(env)).toEqual({ config: parseConnectedWorkerConfig(env) });
    expect(parseConnectedWorkerConfig(env).transport.clientPrivateKeyPem).toBe("fixture-private-key");
    expect(native.create).not.toHaveBeenCalled();
  });

  it.each(["", "missing-private-key.pem"])(
    "rejects ambiguous PEM and protected settings (%j) before opening either",
    (value) => {
      const { env } = fixture();
      env[names.clientKeyFile] = value;
      expect(() => parseConnectedWorkerStartup(env)).toThrow("cannot combine");
      expect(native.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { protectedSignerPrivateKeyPem: "fixture-private-key", protectedSignerPublicKeySpkiBase64Url: "public-signer" },
    { protectedSignerPrivateKeyPem: null, protectedSignerPublicKeySpkiBase64Url: "public-signer" },
    {},
    { protectedSignerPublicKeySpkiBase64Url: 1 },
    { protectedSignerPublicKeySpkiBase64Url: "" },
  ])("rejects a protected ticket without exclusively public signer authority: %j", (ticket) => {
    const { env } = fixture();
    writeFileSync(env[names.ticketFile]!, JSON.stringify(ticket));
    expect(() => parseConnectedWorkerStartup(env)).toThrow("public signer");
    expect(native.create).not.toHaveBeenCalled();
  });

  it("rejects a configurable native addon before loading it", () => {
    const { env } = fixture();
    env.GOATCITADEL_CONNECTED_WORKER_IMAGE_GUARD = "arbitrary-addon.node";
    expect(() => parseConnectedWorkerStartup(env)).toThrow("Unsupported connected-worker setting");
    expect(native.create).not.toHaveBeenCalled();
  });

  it("does not downgrade after native loading fails", () => {
    const { env } = fixture();
    native.create.mockImplementation(() => {
      throw new Error("The installed native image guard is unavailable.");
    });
    expect(() => parseConnectedWorkerStartup(env)).toThrow("image guard is unavailable");
    expect(native.create).toHaveBeenCalledOnce();
  });

  it("refuses a protected setting in the PEM-only parser", () => {
    expect(() => parseConnectedWorkerConfig(fixture().env)).toThrow("protected startup");
    expect(native.create).not.toHaveBeenCalled();
  });

  it("does not echo bootstrap material from malformed ticket JSON", () => {
    const { env } = fixture();
    writeFileSync(env[names.ticketFile]!, '{"bootstrapSecret":"fixture-secret-do-not-echo",');
    expect(() => parseConnectedWorkerStartup(env)).toThrow("admission ticket is not valid JSON");
    try {
      parseConnectedWorkerStartup(env);
    } catch (error) {
      expect(String(error)).not.toContain("fixture-secret-do-not-echo");
    }
    expect(native.create).not.toHaveBeenCalled();
  });

  it("reads each environment value only once before choosing key authority", () => {
    const { env } = fixture();
    const keyFile = env[names.protectedKeyFile];
    const read = vi.fn(() => keyFile);
    Object.defineProperty(env, names.protectedKeyFile, { enumerable: true, get: read });
    native.create.mockReturnValue({ transport: {}, protectedKeys: {} });
    parseConnectedWorkerStartup(env);
    expect(read).toHaveBeenCalledOnce();
  });

  it("binds optional local mesh tools to an absolute registry and exact digest", () => {
    const { env } = fixture();
    native.create.mockReturnValue({ transport: {}, protectedKeys: {} });
    env[names.meshRegistryFile] = join(tmpdir(), "operator-registry.json");
    env[names.meshRegistrySha256] = "a".repeat(64);
    expect(parseConnectedWorkerStartup(env).config.meshRegistry).toEqual({ file: env[names.meshRegistryFile], sha256: "a".repeat(64) });
    delete env[names.meshRegistrySha256];
    expect(() => parseConnectedWorkerStartup(env)).toThrow("exact digest");
    env[names.meshRegistrySha256] = "bad";
    expect(() => parseConnectedWorkerStartup(env)).toThrow("exact digest");
    env[names.meshRegistrySha256] = "a".repeat(64);
    env[names.meshRegistryFile] = "relative.json";
    expect(() => parseConnectedWorkerStartup(env)).toThrow("absolute");
    env[names.meshRegistryFile] = join(tmpdir(), "operator-registry.json");
    env[names.executionMode] = "protocol_probe";
    expect(() => parseConnectedWorkerStartup(env)).toThrow("governed execution");
  });
});
