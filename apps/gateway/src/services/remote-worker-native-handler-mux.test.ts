import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH } from "./remote-worker-admission-service.js";
import { REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES } from "./remote-worker-assignment-protocol-service.js";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import { REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES } from "./remote-worker-assignment-execution-protocol-service.js";
import {
  createRemoteWorkerMeshNodeAdmissionNativeRequestHandler,
  type RemoteWorkerMeshNodeAdmissionPort,
} from "./remote-worker-mesh-node-admission-handler.js";
import { REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH } from "./remote-worker-mesh-node-admission-service.js";
import { createRemoteWorkerNativeHandlerMux } from "./remote-worker-native-handler-mux.js";
import type {
  RemoteWorkerNativeHandlerRequest,
  RemoteWorkerNativeRequestHandler,
} from "./remote-worker-native-tls-listener.js";

const transportIdentity = {
  source: "native_mtls" as const,
  certificateDerSha256: "a".repeat(64),
  publicKeySpkiSha256: "b".repeat(64),
  trustAnchorDerSha256: "c".repeat(64),
  tlsExporterSha256: "d".repeat(64),
  tlsExporter: Buffer.alloc(32, 0x11),
};

function request(rawPath: string, body: unknown = {}): RemoteWorkerNativeHandlerRequest {
  return {
    method: "POST",
    rawPath,
    headers: Object.freeze({}),
    bodyBytes: Buffer.from(JSON.stringify(body), "utf8"),
    transportIdentity,
  };
}

function owned(name: string): RemoteWorkerNativeRequestHandler {
  return vi.fn(async () => ({ statusCode: 200, body: name }));
}

describe("remote worker native handler composition", () => {
  it("dispatches the fixed bootstrap, mesh admission, assignment RPC, dispatch, and execution route set", async () => {
    const bootstrap = owned("bootstrap");
    const meshNodeAdmission = owned("mesh-node-admission");
    const assignment = owned("assignment");
    const dispatch = owned("dispatch");
    const execution = owned("execution");
    const mux = createRemoteWorkerNativeHandlerMux({ bootstrap, meshNodeAdmission, assignment, dispatch, execution });

    await expect(mux(request(REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH))).resolves.toMatchObject({ body: "bootstrap" });
    await expect(mux(request(REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH))).resolves.toMatchObject({
      body: "mesh-node-admission",
    });
    for (const route of Object.values(REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES)) {
      await expect(mux(request(route.rawPath))).resolves.toMatchObject({ body: "assignment" });
    }
    for (const route of Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES)) {
      await expect(mux(request(route.rawPath))).resolves.toMatchObject({ body: "dispatch" });
    }
    expect(Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES).map(({ code }) => code)).toEqual([11, 12]);
    for (const route of Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES)) {
      await expect(mux(request(route.rawPath))).resolves.toMatchObject({ body: "execution" });
    }
    await expect(mux(request("/api/v1/remote-workers/not-a-route"))).resolves.toStrictEqual({
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({ error: "REMOTE_WORKER_ROUTE_NOT_FOUND" }),
    });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(meshNodeAdmission).toHaveBeenCalledOnce();
    expect(assignment).toHaveBeenCalledTimes(Object.values(REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES).length);
    expect(dispatch).toHaveBeenCalledTimes(Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES).length);
    expect(execution).toHaveBeenCalledTimes(Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES).length);
  });

  it("fails composition when any owner is missing", () => {
    expect(() =>
      createRemoteWorkerNativeHandlerMux({
        bootstrap: owned("bootstrap"),
        meshNodeAdmission: undefined as never,
        assignment: owned("assignment"),
        dispatch: owned("dispatch"),
        execution: owned("execution"),
      }),
    ).toThrow("owner is unavailable");
    expect(() =>
      createRemoteWorkerNativeHandlerMux({
        bootstrap: owned("bootstrap"),
        meshNodeAdmission: owned("mesh-node-admission"),
        assignment: owned("assignment"),
        dispatch: undefined as never,
        execution: owned("execution"),
      }),
    ).toThrow("owner is unavailable");
    expect(() =>
      createRemoteWorkerNativeHandlerMux({
        bootstrap: owned("bootstrap"),
        meshNodeAdmission: owned("mesh-node-admission"),
        assignment: owned("assignment"),
        dispatch: owned("dispatch"),
        execution: undefined as never,
      }),
    ).toThrow("owner is unavailable");
  });

  it("maps mesh admission success/replay and collapses malformed or rejected requests", async () => {
    const admit = vi.fn<RemoteWorkerMeshNodeAdmissionPort["admit"]>(async () => ({
      schemaVersion: "goatcitadel.remote-worker-mesh-node-admission-response.v1",
      disposition: "admitted",
      workspaceId: "workspace-a",
      nodeId: "node-a",
      admissionGeneration: 1,
      mtlsRequired: true,
      tlsFingerprint: "a".repeat(64),
    }));
    const handler = createRemoteWorkerMeshNodeAdmissionNativeRequestHandler({ admissionService: { admit } });

    await expect(handler(request(REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH, { ok: true }))).resolves.toMatchObject({
      statusCode: 201,
    });
    admit.mockResolvedValueOnce({
      schemaVersion: "goatcitadel.remote-worker-mesh-node-admission-response.v1",
      disposition: "replayed",
      workspaceId: "workspace-a",
      nodeId: "node-a",
      admissionGeneration: 1,
      mtlsRequired: true,
      tlsFingerprint: "a".repeat(64),
    });
    await expect(handler(request(REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH, { ok: true }))).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      handler({ ...request(REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH), bodyBytes: Buffer.from("{") }),
    ).resolves.toMatchObject({ statusCode: 400 });
    admit.mockRejectedValueOnce(new Error("sensitive join credential material"));
    const rejected = await handler(request(REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH, { ok: true }));
    expect(rejected).toStrictEqual({
      statusCode: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: canonicalJsonString({ error: "REMOTE_WORKER_MESH_NODE_ADMISSION_REJECTED" }),
    });
    expect(String(rejected.body)).not.toContain("sensitive");
  });
});
