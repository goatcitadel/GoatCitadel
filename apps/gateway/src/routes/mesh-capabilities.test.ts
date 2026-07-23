import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION, type MeshCapabilityDescriptor } from "@goatcitadel/contracts";
import { Storage, computeMeshCapabilityDescriptorSha256 } from "@goatcitadel/storage";
import { authPlugin } from "../plugins/auth.js";
import {
  MESH_NODE_TLS_FINGERPRINT_HEADER,
  MeshCapabilityPublicationService,
} from "../services/mesh-capability-publication-service.js";
import { meshCapabilityRoutes } from "./mesh-capabilities.js";

const OPERATOR_TOKEN = "operator-token";
const NODE_TOKEN = "join-node-a";
const NODE_FINGERPRINT = "sha256:node-a";

const apps: FastifyInstance[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const storage of storages.splice(0)) {
    storage.close();
  }
});

function createStorage(): Storage {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  storages.push(storage);
  return storage;
}

function admitNode(storage: Storage, nodeId: string, token: string): void {
  const now = new Date().toISOString();
  storage.mesh.upsertNode({
    nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint: `sha256:${nodeId}`,
    joinedAt: now,
    lastSeenAt: now,
  });
  storage.mesh.issueJoinToken(token, "2099-01-01T00:00:00.000Z");
  expect(storage.mesh.consumeJoinToken(token, nodeId, now)).toBe(true);
  storage.meshCapabilityNodeAdmissions.admit({
    workspaceId: "default",
    nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: createHash("sha256").update(token).digest("hex"),
    mtlsRequired: true,
    tlsFingerprint: `sha256:${nodeId}`,
    admittedByActorId: "operator-a",
    idempotencyKey: `admit:${nodeId}`,
  });
}

async function buildHarness(authMode: "token" | "none" = "token"): Promise<{
  app: FastifyInstance;
  storage: Storage;
  service: MeshCapabilityPublicationService;
}> {
  const storage = createStorage();
  admitNode(storage, "node-a", NODE_TOKEN);
  const service = new MeshCapabilityPublicationService({ storage });
  const app = Fastify();
  apps.push(app);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: {
        mode: authMode,
        allowLoopbackBypass: false,
        token: { value: OPERATOR_TOKEN, queryParam: "access_token" },
        basic: { username: "operator", password: "password123" },
      },
    },
  } as never);
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
    verifyCompanionRequestSignature: () => undefined,
  } as never);
  app.decorate("services", { meshCapabilityPublication: service } as never);
  await app.register(authPlugin);
  await app.register(meshCapabilityRoutes);
  return { app, storage, service };
}

function descriptor(): MeshCapabilityDescriptor {
  return {
    kind: "tool",
    title: "Project status",
    semanticVersion: "1.0.0",
    effectPosture: "read_only",
    permissions: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: ["workspace://project"],
      filesystemWrite: [],
      networkOrigins: [],
      environmentNames: [],
      deviceCapabilities: [],
    },
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    idempotency: "intrinsic",
  };
}

function publishPayload(): Record<string, unknown> {
  const body = descriptor() as unknown as Record<string, unknown>;
  return {
    publicationKey: "publication-1",
    entries: [
      {
        localId: "project.status",
        kind: "tool",
        descriptor: body,
        descriptorSha256: computeMeshCapabilityDescriptorSha256(body),
      },
    ],
  };
}

function nodeHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${NODE_TOKEN}`,
    [MESH_NODE_TLS_FINGERPRINT_HEADER]: NODE_FINGERPRINT,
  };
}

describe("mesh capability publication routes", () => {
  it("publishes and replays a manifest for an authenticated admitted node", async () => {
    const { app } = await buildHarness();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const createdBody = created.json() as {
      replayed: boolean;
      manifest: { nodeId: string; publisherGeneration: number; entries: Array<{ capabilityId: string }> };
      entries: Array<{ status: string }>;
    };
    expect(createdBody.replayed).toBe(false);
    expect(createdBody.manifest.nodeId).toBe("node-a");
    expect(createdBody.manifest.entries[0]?.capabilityId).toBe("mesh:node-a:tool:project.status");
    expect(createdBody.entries[0]?.status).toBe("review_required");

    const replayed = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    expect(replayed.statusCode).toBe(200);
    expect((replayed.json() as { replayed: boolean }).replayed).toBe(true);

    const own = await app.inject({
      method: "GET",
      url: "/api/v1/mesh/capabilities/manifests/self",
      headers: nodeHeaders(),
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json() as { nodeId: string; manifests: Array<{ publicationKey: string }> };
    expect(ownBody.nodeId).toBe("node-a");
    expect(ownBody.manifests.map((manifest) => manifest.publicationKey)).toEqual(["publication-1"]);
  });

  it("rejects operator and companion credentials on the node publication surface", async () => {
    const { app } = await buildHarness();
    const withOperatorToken = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: publishPayload(),
    });
    expect(withOperatorToken.statusCode).toBe(403);
    expect(withOperatorToken.json()).toMatchObject({ reason: "mesh_node_unknown_or_revoked" });

    const withoutCredentials = await app.inject({
      method: "GET",
      url: "/api/v1/mesh/capabilities/manifests/self",
    });
    expect(withoutCredentials.statusCode).toBe(401);
    expect(withoutCredentials.json()).toMatchObject({ reason: "mesh_node_token_required" });
  });

  it("rejects node credentials on the operator inspection surface and serves operators no-store", async () => {
    const { app } = await buildHarness();
    await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });

    const withNodeToken = await app.inject({
      method: "GET",
      url: "/api/v1/mesh/capabilities/publications",
      headers: nodeHeaders(),
    });
    expect(withNodeToken.statusCode).toBe(401);

    const anonymous = await app.inject({ method: "GET", url: "/api/v1/mesh/capabilities/publications" });
    expect(anonymous.statusCode).toBe(401);

    const asOperator = await app.inject({
      method: "GET",
      url: "/api/v1/mesh/capabilities/publications?workspaceId=default",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(asOperator.statusCode).toBe(200);
    expect(asOperator.headers["cache-control"]).toBe("no-store");
    const inspection = asOperator.json() as {
      workspaceId: string;
      manifests: Array<{ entries: Array<{ status: string; reasons: string[] }> }>;
    };
    expect(inspection.workspaceId).toBe("default");
    expect(inspection.manifests[0]?.entries[0]?.status).toBe("review_required");
  });

  it("still requires the admitted-node credential when gateway auth mode is none", async () => {
    const { app } = await buildHarness("none");
    const withoutCredentials = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      payload: publishPayload(),
    });
    expect(withoutCredentials.statusCode).toBe(401);

    const withNodeToken = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    expect(withNodeToken.statusCode).toBe(201);
  });

  it("fails malformed and identity-forging submissions closed", async () => {
    const { app } = await buildHarness();
    const invalidShape = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: { publicationKey: "p", entries: [], extra: true },
    });
    expect(invalidShape.statusCode).toBe(400);

    const payload = publishPayload();
    (payload.entries as Array<Record<string, unknown>>)[0]!.capabilityId = "mesh:forged:tool:project.status";
    const forgedCapabilityId = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload,
    });
    expect(forgedCapabilityId.statusCode).toBe(400);

    const digestDrift = publishPayload();
    (digestDrift.entries as Array<Record<string, unknown>>)[0]!.descriptorSha256 = "0".repeat(64);
    const digestMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: digestDrift,
    });
    expect(digestMismatch.statusCode).toBe(400);
    expect(digestMismatch.json()).toMatchObject({ reason: "mesh_capability_descriptor_digest_mismatch" });

    const changedBytes = publishPayload();
    await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    (changedBytes.entries as Array<Record<string, unknown>>)[0]!.localId = "project.other";
    const changedDescriptor = descriptor() as unknown as Record<string, unknown>;
    (changedBytes.entries as Array<Record<string, unknown>>)[0]!.descriptor = changedDescriptor;
    (changedBytes.entries as Array<Record<string, unknown>>)[0]!.descriptorSha256 =
      computeMeshCapabilityDescriptorSha256(changedDescriptor);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: changedBytes,
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("fails closed when the publication owner is not composed", async () => {
    const app = Fastify();
    apps.push(app);
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "none",
          allowLoopbackBypass: false,
          token: { value: undefined, queryParam: "access_token" },
          basic: { username: undefined, password: undefined },
        },
      },
    } as never);
    app.decorate("gatewayAuth", {
      getOnboardingStartupState: () => ({ completed: true }),
      validateDeviceAccessToken: () => undefined,
      validateCompanionAccessToken: () => undefined,
      verifyCompanionRequestSignature: () => undefined,
    } as never);
    app.decorate("services", {} as never);
    await app.register(authPlugin);
    await app.register(meshCapabilityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    expect(response.statusCode).toBe(500);
    expect((response.json() as { error: string }).error).toMatch(/not installed/);
  });
});
