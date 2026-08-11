import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkerAssignmentExecutionNativeRequestHandler } from "./remote-worker-assignment-execution-handler.js";
import {
  REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES,
  type RemoteWorkerAssignmentExecutionProtocolPort,
} from "./remote-worker-assignment-execution-protocol-service.js";
import type { RemoteWorkerNativeHandlerRequest } from "./remote-worker-native-tls-listener.js";
import { REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES } from "./remote-worker-protocol.js";

const transportIdentity = Object.freeze({
  source: "native_mtls" as const,
  certificateDerSha256: "a".repeat(64),
  publicKeySpkiSha256: "b".repeat(64),
  trustAnchorDerSha256: "c".repeat(64),
  tlsExporterSha256: "d".repeat(64),
  tlsExporter: Buffer.alloc(32, 0x11),
});

function request(
  rawPath = REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange.rawPath,
  body: string = "{}",
): RemoteWorkerNativeHandlerRequest {
  return {
    method: "POST",
    rawPath,
    headers: Object.freeze({}),
    bodyBytes: Buffer.from(body, "utf8"),
    transportIdentity,
  };
}

function protocol(): {
  readonly port: RemoteWorkerAssignmentExecutionProtocolPort;
  readonly execute: ReturnType<typeof vi.fn<RemoteWorkerAssignmentExecutionProtocolPort["execute"]>>;
} {
  const execute = vi.fn<RemoteWorkerAssignmentExecutionProtocolPort["execute"]>();
  return { port: { execute }, execute };
}

describe("remote worker assignment execution native handler", () => {
  it("serves only the routes 11-12 execution paths and returns the canonical owner response", async () => {
    expect(Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES).map(({ code }) => code)).toEqual([11, 12]);
    const owner = protocol();
    const handler = createRemoteWorkerAssignmentExecutionNativeRequestHandler({ executionProtocol: owner.port });
    owner.execute.mockResolvedValueOnce({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
      operation: "assignment.inference.exchange",
      registryWorkspaceId: "registry-a",
      disposition: "delivered",
      request: {} as never,
      frames: [],
    });
    await expect(handler(request())).resolves.toStrictEqual({
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({
        schemaVersion: REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
        operation: "assignment.inference.exchange",
        registryWorkspaceId: "registry-a",
        disposition: "delivered",
        request: {},
        frames: [],
      }),
    });

    owner.execute.mockResolvedValueOnce({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
      operation: "assignment.settlement.submit",
      registryWorkspaceId: "registry-a",
      disposition: "effect_settled",
      effect: {} as never,
    });
    await expect(
      handler(request(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission.rawPath)),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(owner.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps malformed and unknown requests outside the protocol owner", async () => {
    const owner = protocol();
    const handler = createRemoteWorkerAssignmentExecutionNativeRequestHandler({ executionProtocol: owner.port });

    await expect(handler(request("/api/v1/remote-workers/not-a-route"))).resolves.toStrictEqual({
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({ error: "REMOTE_WORKER_ROUTE_NOT_FOUND" }),
    });
    await expect(handler(request(undefined, "{"))).resolves.toStrictEqual({
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({ error: "REMOTE_WORKER_REQUEST_INVALID" }),
    });
    await expect(
      handler({ ...request(), bodyBytes: Buffer.alloc(REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES + 1, 0x20) }),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(owner.execute).not.toHaveBeenCalled();
  });

  it("collapses sensitive failures and oversized owner responses to one fixed bounded error", async () => {
    const owner = protocol();
    const handler = createRemoteWorkerAssignmentExecutionNativeRequestHandler({ executionProtocol: owner.port });
    owner.execute.mockRejectedValueOnce(new Error("raw lease: never-return-this-secret"));
    const rejected = await handler(request());
    expect(rejected).toStrictEqual({
      statusCode: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({ error: "REMOTE_WORKER_ASSIGNMENT_EXECUTION_REJECTED" }),
    });
    expect(String(rejected.body)).not.toContain("never-return-this-secret");

    owner.execute.mockResolvedValueOnce({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
      operation: "assignment.inference.exchange",
      registryWorkspaceId: "registry-a",
      disposition: "delivered",
      request: { output: "x".repeat(REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) },
      frames: [],
    } as never);
    await expect(handler(request())).resolves.toStrictEqual(rejected);
  });

  it("refuses composition when the execution protocol owner is unavailable", () => {
    expect(() =>
      createRemoteWorkerAssignmentExecutionNativeRequestHandler({
        executionProtocol: undefined as never,
      }),
    ).toThrow("execution protocol service is unavailable");
    expect(() =>
      createRemoteWorkerAssignmentExecutionNativeRequestHandler({
        executionProtocol: {} as never,
      }),
    ).toThrow("execution protocol service is unavailable");
  });
});
