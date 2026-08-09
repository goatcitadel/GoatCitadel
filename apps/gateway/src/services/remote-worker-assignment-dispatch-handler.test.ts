import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkerAssignmentDispatchNativeRequestHandler } from "./remote-worker-assignment-dispatch-handler.js";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import type { RemoteWorkerAssignmentDispatchProtocolPort } from "./remote-worker-assignment-dispatch-protocol-service.js";
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
  rawPath = REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers.rawPath,
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
  readonly port: RemoteWorkerAssignmentDispatchProtocolPort;
  readonly execute: ReturnType<typeof vi.fn<RemoteWorkerAssignmentDispatchProtocolPort["execute"]>>;
} {
  const execute = vi.fn<RemoteWorkerAssignmentDispatchProtocolPort["execute"]>();
  return { port: { execute }, execute };
}

describe("remote worker assignment dispatch native handler", () => {
  it("maps listed, fresh claim, and claim replay to canonical bounded responses", async () => {
    const owner = protocol();
    const handler = createRemoteWorkerAssignmentDispatchNativeRequestHandler({ dispatchProtocol: owner.port });
    owner.execute.mockResolvedValueOnce({
      schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-response.v1",
      operation: "assignment.offers.poll",
      registryWorkspaceId: "registry-a",
      disposition: "listed",
      items: [],
    });
    const listed = await handler(request());
    expect(listed).toStrictEqual({
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({
        schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-response.v1",
        operation: "assignment.offers.poll",
        registryWorkspaceId: "registry-a",
        disposition: "listed",
        items: [],
      }),
    });

    owner.execute.mockResolvedValueOnce({
      schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-response.v1",
      operation: "assignment.claim",
      registryWorkspaceId: "registry-a",
      disposition: "started",
      assignment: {} as never,
      generation: {} as never,
      lease: {} as never,
    });
    await expect(handler(request(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim.rawPath))).resolves.toMatchObject({
      statusCode: 201,
    });

    owner.execute.mockResolvedValueOnce({
      schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-response.v1",
      operation: "assignment.claim",
      registryWorkspaceId: "registry-a",
      disposition: "replayed",
      assignment: {} as never,
      generation: {} as never,
      lease: {} as never,
    });
    await expect(handler(request(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim.rawPath))).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it("keeps malformed and unknown requests outside the protocol owner", async () => {
    const owner = protocol();
    const handler = createRemoteWorkerAssignmentDispatchNativeRequestHandler({ dispatchProtocol: owner.port });

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
    const handler = createRemoteWorkerAssignmentDispatchNativeRequestHandler({ dispatchProtocol: owner.port });
    owner.execute.mockRejectedValueOnce(new Error("raw lease: never-return-this-secret"));
    const rejected = await handler(request());
    expect(rejected).toStrictEqual({
      statusCode: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({ error: "REMOTE_WORKER_ASSIGNMENT_DISPATCH_REJECTED" }),
    });
    expect(String(rejected.body)).not.toContain("never-return-this-secret");

    owner.execute.mockResolvedValueOnce({
      schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-response.v1",
      operation: "assignment.offers.poll",
      registryWorkspaceId: "registry-a",
      disposition: "listed",
      items: [{ payload: "x".repeat(REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) }],
    } as never);
    await expect(handler(request())).resolves.toStrictEqual(rejected);
  });
});
