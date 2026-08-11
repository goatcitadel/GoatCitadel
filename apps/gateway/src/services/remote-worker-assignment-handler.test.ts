import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_ASSIGNMENT_RPC_RESPONSE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES,
  REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION,
  type RemoteWorkerAssignmentProtocolResponse,
} from "./remote-worker-assignment-protocol-service.js";
import { createRemoteWorkerAssignmentNativeRequestHandler } from "./remote-worker-assignment-handler.js";
import type { RemoteWorkerNativeHandlerRequest } from "./remote-worker-native-tls-listener.js";

const SECRET = Buffer.alloc(32, 0x5a).toString("base64url");
const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function request(overrides: Partial<RemoteWorkerNativeHandlerRequest> = {}): RemoteWorkerNativeHandlerRequest {
  const tlsExporter = Buffer.alloc(32, 0x44);
  return Object.freeze({
    method: "POST",
    rawPath: REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync.rawPath,
    headers: Object.freeze({ authorization: `Bearer ${SECRET}` }),
    bodyBytes: Buffer.from(
      JSON.stringify({
        schemaVersion: "goatcitadel.remote-worker-pop.v1",
        operation: REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync.operation,
        authorityId: "credential-1",
        authorityGeneration: 1,
        idempotencyKey: "sync:1",
        payload: {
          schemaVersion: REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION,
          registryWorkspaceId: "default",
          assignmentId: "assignment-1",
          assignmentGeneration: 1,
          leaseRevision: 1,
          leaseToken: SECRET,
        },
      }),
      "utf8",
    ),
    transportIdentity: Object.freeze({
      source: "native_mtls",
      certificateDerSha256: D("certificate"),
      publicKeySpkiSha256: D("public-key"),
      trustAnchorDerSha256: D("trust-anchor"),
      tlsExporterSha256: D(tlsExporter),
      tlsExporter,
    }),
    ...overrides,
  });
}

function response(): RemoteWorkerAssignmentProtocolResponse {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_RPC_RESPONSE_SCHEMA_VERSION,
    operation: REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync.operation,
    disposition: "synchronized",
    assignment: { assignmentId: "assignment-1" } as never,
    generation: { assignmentGeneration: 1 } as never,
    lease: { leaseRevision: 1 } as never,
  };
}

describe("remote worker assignment native request handler", () => {
  it("adapts a known native path and returns a canonical secret-free response", async () => {
    const execute = vi.fn(async () => response());
    const handler = createRemoteWorkerAssignmentNativeRequestHandler({ assignmentProtocol: { execute } });
    const nativeRequest = request();

    const result = await handler(nativeRequest);

    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(JSON.parse(String(result.body))).toMatchObject({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_RPC_RESPONSE_SCHEMA_VERSION,
      operation: "assignment.sync",
      disposition: "synchronized",
    });
    expect(String(result.body)).not.toContain(SECRET);
    expect(execute).toHaveBeenCalledWith({
      method: "POST",
      rawPath: nativeRequest.rawPath,
      headers: nativeRequest.headers,
      body: JSON.parse(nativeRequest.bodyBytes.toString("utf8")) as unknown,
      transportIdentity: nativeRequest.transportIdentity,
    });
  });

  it("rejects unknown paths and malformed or oversized JSON before service invocation", async () => {
    const execute = vi.fn(async () => response());
    const handler = createRemoteWorkerAssignmentNativeRequestHandler({ assignmentProtocol: { execute } });

    const missing = await handler(request({ rawPath: "/api/v1/remote-workers/not-assignment" }));
    const malformed = await handler(request({ bodyBytes: Buffer.from([0xc3, 0x28]) }));
    const oversized = await handler(request({ bodyBytes: Buffer.alloc(512 * 1024 + 1, 0x20) }));

    expect(missing).toMatchObject({ statusCode: 404, body: '{"error":"REMOTE_WORKER_ROUTE_NOT_FOUND"}' });
    expect(malformed).toMatchObject({ statusCode: 400, body: '{"error":"REMOTE_WORKER_REQUEST_INVALID"}' });
    expect(oversized).toMatchObject({ statusCode: 400, body: '{"error":"REMOTE_WORKER_REQUEST_INVALID"}' });
    expect(execute).not.toHaveBeenCalled();
  });

  it("collapses verifier, storage, and post-commit failures to one fixed response without logging secrets", async () => {
    const canary = `PRIVATE_${SECRET}`;
    const execute = vi.fn(async () => {
      throw new Error(canary);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createRemoteWorkerAssignmentNativeRequestHandler({ assignmentProtocol: { execute } });

    const result = await handler(request());

    expect(result).toMatchObject({ statusCode: 403, body: '{"error":"REMOTE_WORKER_ASSIGNMENT_REJECTED"}' });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects an oversized service response instead of crossing the listener limit", async () => {
    const execute = vi.fn(async () => ({ ...response(), padding: "x".repeat(512 * 1024) }) as never);
    const handler = createRemoteWorkerAssignmentNativeRequestHandler({ assignmentProtocol: { execute } });

    await expect(handler(request())).resolves.toMatchObject({
      statusCode: 403,
      body: '{"error":"REMOTE_WORKER_ASSIGNMENT_REJECTED"}',
    });
  });
});
