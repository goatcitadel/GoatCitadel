import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  canonicalJsonString,
  type MeshCapabilityDescriptor,
} from "@goatcitadel/contracts";
import {
  Storage,
  computeMeshCapabilityDescriptorSha256,
  createSqliteAsyncStorage,
  type AsyncStorage,
} from "@goatcitadel/storage";
import { authPlugin } from "../plugins/auth.js";
import { MeshCapabilityActivationService } from "../services/mesh-capability-activation-service.js";
import { MeshCapabilityInvocationService } from "../services/mesh-capability-invocation-service.js";
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

async function admitNodeAsync(storage: AsyncStorage, nodeId: string, token: string): Promise<void> {
  const now = new Date().toISOString();
  await storage.mesh.upsertNode({
    nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint: `sha256:${nodeId}`,
    joinedAt: now,
    lastSeenAt: now,
  });
  await storage.mesh.issueJoinToken(token, "2099-01-01T00:00:00.000Z");
  expect(await storage.mesh.consumeJoinToken(token, nodeId, now)).toBe(true);
  await storage.meshCapabilityNodeAdmissions.admit({
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
  storage: AsyncStorage;
  service: MeshCapabilityPublicationService;
  activation: MeshCapabilityActivationService;
  invocation: MeshCapabilityInvocationService;
}> {
  const rawStorage = createStorage();
  admitNode(rawStorage, "node-a", NODE_TOKEN);
  const storage = createSqliteAsyncStorage(rawStorage);
  const service = new MeshCapabilityPublicationService({ storage });
  const activation = new MeshCapabilityActivationService({ storage, publication: service });
  const invocation = new MeshCapabilityInvocationService({
    storage,
    transport: {
      localNodeId: () => "gateway-node",
      appendEvent: (input) => storage.mesh.appendReplicationEvent(input),
    },
    settlementPollIntervalMs: 15,
  });
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
  app.decorate("services", {
    meshCapabilityPublication: service,
    meshCapabilityActivation: activation,
    meshCapabilityInvocation: invocation,
  } as never);
  await app.register(authPlugin);
  await app.register(meshCapabilityRoutes);
  return { app, storage, service, activation, invocation };
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

  it("runs the governed operator activation flow: request, approve, activate, inspect, revoke", async () => {
    const { app, storage, activation } = await buildHarness();
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    const manifest = (
      published.json() as {
        manifest: { manifestSha256: string; entries: Array<{ capabilityId: string; entrySha256: string }> };
      }
    ).manifest;
    const entry = manifest.entries[0]!;

    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/activations",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        capabilityId: entry.capabilityId,
        manifestSha256: manifest.manifestSha256,
        entrySha256: entry.entrySha256,
      },
    });
    expect(requested.statusCode).toBe(201);
    expect(requested.headers["cache-control"]).toBe("no-store");
    const requestedBody = requested.json() as {
      approval: { approvalId: string; status: string; kind: string };
      replayed: boolean;
      activationId: string;
      activationRevision: number;
      permissionDiff: { disposition: string };
      effectDiff: { disposition: string };
    };
    expect(requestedBody.replayed).toBe(false);
    expect(requestedBody.approval.kind).toBe("mesh.capability.activate");
    expect(requestedBody.approval.status).toBe("pending");
    expect(requestedBody.approval.approvalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(requestedBody.activationRevision).toBe(1);
    expect(requestedBody.permissionDiff.disposition).toBe("initial");

    // Exact replay converges on the same deterministic approval.
    const replayed = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/activations",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        capabilityId: entry.capabilityId,
        manifestSha256: manifest.manifestSha256,
        entrySha256: entry.entrySha256,
      },
    });
    expect(replayed.statusCode).toBe(200);
    expect((replayed.json() as { approval: { approvalId: string } }).approval.approvalId).toBe(
      requestedBody.approval.approvalId,
    );

    await storage.approvals.resolve(requestedBody.approval.approvalId, {
      decision: "approve",
      resolvedBy: "operator-approver",
    });
    await activation.executeApprovedActivation({
      workspaceId: "default",
      approvalId: requestedBody.approval.approvalId,
    });

    const inspection = await app.inject({
      method: "GET",
      url: "/api/v1/mesh/capabilities/publications?workspaceId=default",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const inspected = inspection.json() as {
      manifests: Array<{
        entries: Array<{ status: string; activation?: { activationId: string; revoked: boolean } }>;
      }>;
    };
    expect(inspected.manifests[0]?.entries[0]?.status).toBe("active");
    expect(inspected.manifests[0]?.entries[0]?.activation).toMatchObject({
      activationId: requestedBody.activationId,
      revoked: false,
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/activations/${requestedBody.activationId}/revoke`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { reason: "Operator revoked this capability." },
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { replayed: boolean }).replayed).toBe(false);
    // Callability flips before the next read.
    expect(await storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
    const revokedAgain = await app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/activations/${requestedBody.activationId}/revoke`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { reason: "Second revoke converges." },
    });
    expect(revokedAgain.statusCode).toBe(200);
    expect((revokedAgain.json() as { replayed: boolean }).replayed).toBe(true);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/v1/mesh/capabilities/publications?workspaceId=default",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const afterBody = afterRevoke.json() as {
      manifests: Array<{ entries: Array<{ status: string; reasons: string[]; activation?: { revoked: boolean } }> }>;
    };
    expect(afterBody.manifests[0]?.entries[0]?.status).toBe("review_required");
    expect(afterBody.manifests[0]?.entries[0]?.reasons).toContain("activation_revoked");
    expect(afterBody.manifests[0]?.entries[0]?.activation?.revoked).toBe(true);
  });

  it("rejects node credentials and anonymous callers on the activation surface", async () => {
    const { app } = await buildHarness();
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    const manifest = (
      published.json() as {
        manifest: { manifestSha256: string; entries: Array<{ capabilityId: string; entrySha256: string }> };
      }
    ).manifest;
    const entry = manifest.entries[0]!;
    const payload = {
      capabilityId: entry.capabilityId,
      manifestSha256: manifest.manifestSha256,
      entrySha256: entry.entrySha256,
    };

    const withNodeToken = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/activations",
      headers: nodeHeaders(),
      payload,
    });
    expect(withNodeToken.statusCode).toBe(401);
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/mesh/capabilities/activations", payload });
    expect(anonymous.statusCode).toBe(401);
    const revokeWithNodeToken = await app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/activations/mesh-activation-${"a".repeat(48)}/revoke`,
      headers: nodeHeaders(),
      payload: { reason: "Node revoke attempt." },
    });
    expect(revokeWithNodeToken.statusCode).toBe(401);
  });

  it("fails skill activation, malformed bodies, and unknown activations closed", async () => {
    const { app } = await buildHarness();
    const skillDescriptor = {
      kind: "skill",
      title: "Project guide",
      semanticVersion: "1.0.0",
      effectPosture: "read_only",
      permissions: {
        schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
        filesystemRead: [],
        filesystemWrite: [],
        networkOrigins: [],
        environmentNames: [],
        deviceCapabilities: [],
      },
      resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 },
      healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
      manifestSha256: "1".repeat(64),
      instructionsSha256: "2".repeat(64),
      proofSha256: "3".repeat(64),
    } as unknown as Record<string, unknown>;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: {
        publicationKey: "publication-skill",
        entries: [
          {
            localId: "project.guide",
            kind: "skill",
            descriptor: skillDescriptor,
            descriptorSha256: computeMeshCapabilityDescriptorSha256(skillDescriptor),
          },
        ],
      },
    });
    const manifest = (
      published.json() as {
        manifest: { manifestSha256: string; entries: Array<{ capabilityId: string; entrySha256: string }> };
      }
    ).manifest;
    const skillEntry = manifest.entries[0]!;

    const skillActivation = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/activations",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: {
        capabilityId: skillEntry.capabilityId,
        manifestSha256: manifest.manifestSha256,
        entrySha256: skillEntry.entrySha256,
      },
    });
    expect(skillActivation.statusCode).toBe(409);
    expect(skillActivation.json()).toMatchObject({ reason: "mesh_capability_skill_staging_deferred" });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/activations",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { capabilityId: skillEntry.capabilityId, extra: true },
    });
    expect(malformed.statusCode).toBe(400);

    const unknownRevoke = await app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/activations/mesh-activation-${"b".repeat(48)}/revoke`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { reason: "Nothing to revoke." },
    });
    expect(unknownRevoke.statusCode).toBe(404);
    expect(unknownRevoke.json()).toMatchObject({ reason: "mesh_capability_activation_not_found" });
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

describe("mesh capability invocation routes (M3)", () => {
  async function dispatchInvocation(harness: Awaited<ReturnType<typeof buildHarness>>): Promise<{
    invocationId: string;
    args: Record<string, unknown>;
    generation: { publisherGeneration: number; publicationLeaseFencingToken: number };
    dispatchPromise: Promise<unknown>;
  }> {
    const published = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/manifests",
      headers: nodeHeaders(),
      payload: publishPayload(),
    });
    expect(published.statusCode).toBe(201);
    const manifest = (
      published.json() as {
        manifest: { manifestSha256: string; entries: Array<{ capabilityId: string; entrySha256: string }> };
      }
    ).manifest;
    const entry = manifest.entries[0]!;
    const requested = await harness.activation.requestActivation({
      workspaceId: "default",
      capabilityId: entry.capabilityId,
      manifestSha256: manifest.manifestSha256,
      entrySha256: entry.entrySha256,
      actorId: "operator-a",
    });
    await harness.storage.approvals.resolve(requested.approval.approvalId, {
      decision: "approve",
      resolvedBy: "operator-approver",
    });
    const applied = await harness.activation.executeApprovedActivation({
      workspaceId: "default",
      approvalId: requested.approval.approvalId,
    });
    const activation = applied.activation;
    const args = { query: "release notes" };
    const dispatchPromise = harness.invocation.dispatch(
      {
        workspaceId: "default",
        binding: {
          nodeId: activation.nodeId,
          publisherGeneration: activation.publisherGeneration,
          manifestSha256: activation.manifestSha256,
          entrySha256: activation.entrySha256,
          activationId: activation.activationId,
          activationRevision: activation.activationRevision,
          publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
          permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
          effectPosture: activation.effectPosture,
          healthGeneration: activation.healthGeneration,
        },
        capabilityId: activation.capabilityId,
        args,
        toolRunId: "tool-run-route-1",
        sessionId: "session-a",
        turnId: "turn-a",
        executionProfileSha256: "9".repeat(64),
      },
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const invocationId = (await harness.storage.mesh.listReplicationEvents(50)).find(
      (event) => event.eventType === "mesh_capability_invocation_dispatch",
    )!.payload.invocationId as string;
    return {
      invocationId,
      args,
      generation: {
        publisherGeneration: activation.publisherGeneration,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      },
      dispatchPromise,
    };
  }

  function settlementPayload(
    invocationId: string,
    generation: { publisherGeneration: number; publicationLeaseFencingToken: number },
    output: Record<string, unknown>,
  ): Record<string, unknown> {
    const outputSha256 = createHash("sha256").update(canonicalJsonString(output), "utf8").digest("hex");
    return {
      disposition: "succeeded",
      settlementSha256: createHash("sha256")
        .update(canonicalJsonString({ invocationId, outputSha256 }), "utf8")
        .digest("hex"),
      outputSha256,
      output,
      ...generation,
    };
  }

  it("serves input, accepts bounded progress, and settles exactly once for the dispatched node", async () => {
    const harness = await buildHarness();
    const { invocationId, args, generation, dispatchPromise } = await dispatchInvocation(harness);

    const input = await harness.app.inject({
      method: "GET",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/input`,
      headers: nodeHeaders(),
    });
    expect(input.statusCode).toBe(200);
    expect(input.headers["cache-control"]).toBe("no-store");
    expect(input.json()).toMatchObject({ invocationId, input: args });

    const progress = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/progress`,
      headers: nodeHeaders(),
      payload: { sequence: 1, stage: "executing", ...generation },
    });
    expect(progress.statusCode).toBe(202);
    expect(progress.json()).toEqual({ accepted: true, sequence: 1 });
    const staleProgress = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/progress`,
      headers: nodeHeaders(),
      payload: {
        sequence: 2,
        stage: "executing",
        ...generation,
        publisherGeneration: generation.publisherGeneration + 1,
      },
    });
    expect(staleProgress.statusCode).toBe(409);
    expect(staleProgress.json()).toMatchObject({ reason: "mesh_capability_settlement_stale_generation" });

    const output = { status: "ok" };
    const settled = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: nodeHeaders(),
      payload: settlementPayload(invocationId, generation, output),
    });
    expect(settled.statusCode).toBe(201);
    expect(settled.json()).toMatchObject({
      replayed: false,
      settlement: { invocationId, disposition: "succeeded" },
    });
    await expect(dispatchPromise).resolves.toMatchObject({ disposition: "succeeded", output });

    // Duplicate identical settlement replays idempotently (200).
    const replay = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: nodeHeaders(),
      payload: settlementPayload(invocationId, generation, output),
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { replayed: boolean }).replayed).toBe(true);

    // Changed settlement bytes conflict against the ONE immutable settlement.
    const changed = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: nodeHeaders(),
      payload: { ...settlementPayload(invocationId, generation, output), disposition: "failed" },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ reason: "mesh_capability_settlement_conflict" });

    // The transient input is no longer served after the terminal settlement.
    const inputAfter = await harness.app.inject({
      method: "GET",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/input`,
      headers: nodeHeaders(),
    });
    expect(inputAfter.statusCode).toBe(404);
  });

  it("rejects operator credentials, foreign nodes, anonymous callers, and malformed bodies", async () => {
    const harness = await buildHarness();
    await admitNodeAsync(harness.storage, "node-b", "join-node-b");
    const { invocationId, generation, dispatchPromise } = await dispatchInvocation(harness);
    const payload = settlementPayload(invocationId, generation, { status: "ok" });

    // Operator tokens never satisfy the admitted-node class.
    const asOperator = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload,
    });
    expect(asOperator.statusCode).toBe(403);
    expect(asOperator.json()).toMatchObject({ reason: "mesh_node_unknown_or_revoked" });

    // Anonymous callers are rejected before any service work.
    const anonymous = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      payload,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ reason: "mesh_node_token_required" });

    // A different admitted node cannot settle the dispatched invocation.
    const foreign = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: {
        authorization: "Bearer join-node-b",
        [MESH_NODE_TLS_FINGERPRINT_HEADER]: "sha256:node-b",
      },
      payload,
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ reason: "mesh_capability_settlement_node_mismatch" });

    // Unknown invocations and malformed bodies fail content-free.
    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mesh/capabilities/invocations/mesh-invocation-unknown/settlement",
      headers: nodeHeaders(),
      payload,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ reason: "mesh_capability_invocation_not_found" });
    const malformed = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: nodeHeaders(),
      payload: { disposition: "succeeded", extra: true },
    });
    expect(malformed.statusCode).toBe(400);

    // The invocation remains unsettled for the dispatched node afterwards.
    const settled = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: nodeHeaders(),
      payload,
    });
    expect(settled.statusCode).toBe(201);
    await dispatchPromise;
  });

  it("still requires the admitted-node credential on invocation routes when gateway auth mode is none", async () => {
    const harness = await buildHarness("none");
    const { invocationId, generation, dispatchPromise } = await dispatchInvocation(harness);
    const payload = settlementPayload(invocationId, generation, { status: "ok" });

    const anonymous = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      payload,
    });
    expect(anonymous.statusCode).toBe(401);

    const withNodeToken = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mesh/capabilities/invocations/${invocationId}/settlement`,
      headers: nodeHeaders(),
      payload,
    });
    expect(withNodeToken.statusCode).toBe(201);
    await dispatchPromise;
  });
});
