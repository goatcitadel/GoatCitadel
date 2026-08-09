import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
  type RemoteWorkerAdmissionExchangeResult,
} from "./remote-worker-admission-service.js";
import {
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RESPONSE_SCHEMA_VERSION,
  createRemoteWorkerAdmissionNativeRequestHandler,
} from "./remote-worker-admission-handler.js";
import type { RemoteWorkerNativeHandlerRequest } from "./remote-worker-native-tls-listener.js";

const SECRET = Buffer.alloc(32, 0x5a).toString("base64url");

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(overrides: Partial<RemoteWorkerNativeHandlerRequest> = {}): RemoteWorkerNativeHandlerRequest {
  const tlsExporter = Buffer.alloc(32, 0x44);
  return Object.freeze({
    method: "POST",
    rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
    headers: Object.freeze({ authorization: `GoatWorkerBootstrap ${Buffer.alloc(32, 0x22).toString("base64url")}` }),
    bodyBytes: Buffer.from('{"schemaVersion":"body.v1","value":1}', "utf8"),
    transportIdentity: Object.freeze({
      source: "native_mtls",
      certificateDerSha256: digest("certificate"),
      publicKeySpkiSha256: digest("public-key"),
      trustAnchorDerSha256: digest("trust-anchor"),
      tlsExporterSha256: digest(tlsExporter),
      tlsExporter,
    }),
    ...overrides,
  });
}

function admittedResult(): RemoteWorkerAdmissionExchangeResult {
  return {
    disposition: "admitted",
    generation: { workerId: "worker-1" } as never,
    credential: { credentialId: "credential-1" } as never,
    authorizationScheme: "Bearer",
    credentialSecret: SECRET,
    secretDisposition: "returned_once",
  };
}

describe("remote worker admission native request handler", () => {
  it("maps the strict native request into the service and returns the credential only in an admitted response", async () => {
    const exchange = vi.fn(async () => admittedResult());
    const handler = createRemoteWorkerAdmissionNativeRequestHandler({ admissionService: { exchange } });
    const nativeRequest = request();

    const response = await handler(nativeRequest);

    expect(response.statusCode).toBe(201);
    expect(response.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    const parsed = JSON.parse(String(response.body)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schemaVersion: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RESPONSE_SCHEMA_VERSION,
      disposition: "admitted",
      authorizationScheme: "Bearer",
      credentialSecret: SECRET,
      secretDisposition: "returned_once",
    });
    expect(String(response.body).split(SECRET)).toHaveLength(2);
    expect(exchange).toHaveBeenCalledWith({
      method: "POST",
      rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
      headers: nativeRequest.headers,
      body: { schemaVersion: "body.v1", value: 1 },
      transportIdentity: nativeRequest.transportIdentity,
    });
  });

  it("returns an exact replay without any credential secret field", async () => {
    const exchange = vi.fn(async () => ({
      disposition: "replayed_without_credential_secret" as const,
      generation: { workerId: "worker-1" } as never,
      credential: { credentialId: "credential-1" } as never,
    }));
    const handler = createRemoteWorkerAdmissionNativeRequestHandler({ admissionService: { exchange } });

    const response = await handler(request());
    const parsed = JSON.parse(String(response.body)) as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(parsed.disposition).toBe("replayed_without_credential_secret");
    expect(parsed).not.toHaveProperty("credentialSecret");
    expect(String(response.body)).not.toContain(SECRET);
  });

  it("fails malformed UTF-8/JSON and unknown paths without invoking admission", async () => {
    const exchange = vi.fn(async () => admittedResult());
    const handler = createRemoteWorkerAdmissionNativeRequestHandler({ admissionService: { exchange } });

    const malformed = await handler(request({ bodyBytes: Buffer.from([0xc3, 0x28]) }));
    const missingRoute = await handler(request({ rawPath: "/api/v1/remote-workers/not-admission" }));

    expect(malformed).toMatchObject({ statusCode: 400, body: '{"error":"REMOTE_WORKER_REQUEST_INVALID"}' });
    expect(missingRoute).toMatchObject({ statusCode: 404, body: '{"error":"REMOTE_WORKER_ROUTE_NOT_FOUND"}' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("collapses verifier/storage failures to one redacted response and never logs secrets", async () => {
    const canary = `PRIVATE_${SECRET}`;
    const exchange = vi.fn(async () => {
      throw new Error(canary);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createRemoteWorkerAdmissionNativeRequestHandler({ admissionService: { exchange } });

    const response = await handler(request());

    expect(response).toMatchObject({ statusCode: 403, body: '{"error":"REMOTE_WORKER_ADMISSION_REJECTED"}' });
    expect(JSON.stringify(response)).not.toContain(canary);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
