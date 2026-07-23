import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import {
  fetchMeshCapabilityInvocationActivity,
  fetchMeshCapabilityPublications,
  requestMeshCapabilityActivation,
  revokeMeshCapabilityActivation,
  summarizeMeshCapabilityInvocationActivity,
} from "./mesh-capabilities";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

beforeEach(() => {
  apiMocks.request.mockReset();
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const ACTIVATION_ID = `mesh-activation-${"d".repeat(48)}`;

function inspectionPayload(): Record<string, unknown> {
  return {
    workspaceId: "default",
    generatedAt: "2026-07-23T10:00:00.000Z",
    manifests: [
      {
        publicationKey: "publication-1",
        manifestSha256: SHA_A,
        admissionGeneration: 1,
        publisherGeneration: 2,
        createdAt: "2026-07-22T10:00:00.000Z",
        entries: [
          {
            nodeId: "node-a",
            admissionGeneration: 1,
            publisherGeneration: 2,
            manifestSha256: SHA_A,
            entrySha256: SHA_B,
            localId: "project.status",
            capabilityKind: "tool",
            status: "active",
            reasons: ["activation_live"],
            effectPosture: "read_only",
            activation: {
              activationId: ACTIVATION_ID,
              activationRevision: 1,
              approvalId: "3b1e8a10-0000-4000-8000-000000000001",
              revoked: false,
            },
          },
        ],
      },
    ],
  };
}

describe("mesh-capabilities API client", () => {
  it("fetches the operator inspection with the workspace query and parses the projection", async () => {
    apiMocks.request.mockResolvedValueOnce(inspectionPayload());
    const inspection = await fetchMeshCapabilityPublications("default");
    expect(apiMocks.request).toHaveBeenCalledWith("/api/v1/mesh/capabilities/publications?workspaceId=default");
    expect(inspection.manifests[0]?.entries[0]).toMatchObject({
      localId: "project.status",
      status: "active",
      effectPosture: "read_only",
      activation: { activationId: ACTIVATION_ID, revoked: false },
    });
  });

  it("rejects an invalid workspace scope before any request", async () => {
    await expect(fetchMeshCapabilityPublications("bad workspace!")).rejects.toThrow(/workspace/u);
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("fails closed on smuggled or malformed projection material", async () => {
    const withBadDigest = inspectionPayload();
    ((withBadDigest.manifests as Record<string, unknown>[])[0]!.entries as Record<string, unknown>[])[0]!.entrySha256 =
      "not-a-digest";
    apiMocks.request.mockResolvedValueOnce(withBadDigest);
    await expect(fetchMeshCapabilityPublications("default")).rejects.toThrow(/invalid mesh capability/u);

    const withBadStatus = inspectionPayload();
    ((withBadStatus.manifests as Record<string, unknown>[])[0]!.entries as Record<string, unknown>[])[0]!.status =
      "definitely_callable";
    apiMocks.request.mockResolvedValueOnce(withBadStatus);
    await expect(fetchMeshCapabilityPublications("default")).rejects.toThrow(/invalid mesh capability/u);

    const wrongWorkspace = { ...inspectionPayload(), workspaceId: "other" };
    apiMocks.request.mockResolvedValueOnce(wrongWorkspace);
    await expect(fetchMeshCapabilityPublications("default")).rejects.toThrow(/invalid mesh capability/u);
  });

  it("requests activation with the exact entry binding and parses the diff summary", async () => {
    apiMocks.request.mockResolvedValueOnce({
      approval: {
        approvalId: "3b1e8a10-0000-4000-8000-000000000001",
        status: "pending",
        expiresAt: "2026-07-23T10:15:00.000Z",
      },
      replayed: false,
      activationId: ACTIVATION_ID,
      activationRevision: 1,
      permissionDiff: {
        schemaVersion: 1,
        disposition: "initial",
        currentPermissionEnvelopeSha256: SHA_C,
        added: ["filesystemRead:workspace://project"],
        removed: [],
      },
      effectDiff: { schemaVersion: 1, disposition: "initial", currentEffectPosture: "unknown" },
    });
    const result = await requestMeshCapabilityActivation({
      workspaceId: "default",
      capabilityId: "mesh:node-a:tool:project.status",
      manifestSha256: SHA_A,
      entrySha256: SHA_B,
    });
    const [path, init] = apiMocks.request.mock.calls.at(-1) as [string, RequestInit];
    expect(path).toBe("/api/v1/mesh/capabilities/activations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: "default",
      capabilityId: "mesh:node-a:tool:project.status",
      manifestSha256: SHA_A,
      entrySha256: SHA_B,
    });
    expect(result).toMatchObject({
      replayed: false,
      activationId: ACTIVATION_ID,
      approvalStatus: "pending",
      diff: {
        permissionDisposition: "initial",
        permissionsAdded: ["filesystemRead:workspace://project"],
        // The unknown posture must survive the parse without upgrade.
        currentEffectPosture: "unknown",
      },
    });
  });

  it("refuses an activation request without exact digests", async () => {
    await expect(
      requestMeshCapabilityActivation({
        workspaceId: "default",
        capabilityId: "mesh:node-a:tool:project.status",
        manifestSha256: "short",
        entrySha256: SHA_B,
      }),
    ).rejects.toThrow(/exact manifest and entry digests/u);
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("revokes an activation with a bounded reason and parses the revocation", async () => {
    apiMocks.request.mockResolvedValueOnce({
      replayed: false,
      revocation: {
        workspaceId: "default",
        activationId: ACTIVATION_ID,
        reason: "Operator withdrew the remote grant.",
        actorId: "operator-a",
        idempotencyKey: "revoke-1",
        requestSha256: SHA_C,
        revokedAt: "2026-07-23T10:20:00.000Z",
      },
    });
    const result = await revokeMeshCapabilityActivation({
      workspaceId: "default",
      activationId: ACTIVATION_ID,
      reason: "Operator withdrew the remote grant.",
    });
    const [path, init] = apiMocks.request.mock.calls.at(-1) as [string, RequestInit];
    expect(path).toBe(`/api/v1/mesh/capabilities/activations/${ACTIVATION_ID}/revoke`);
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: "default",
      reason: "Operator withdrew the remote grant.",
    });
    expect(result).toMatchObject({ activationId: ACTIVATION_ID, revokedAt: "2026-07-23T10:20:00.000Z" });
  });

  it("refuses a revoke without a valid activation id or reason", async () => {
    await expect(
      revokeMeshCapabilityActivation({ workspaceId: "default", activationId: "activation-1", reason: "why" }),
    ).rejects.toThrow(/valid activation id/u);
    await expect(
      revokeMeshCapabilityActivation({ workspaceId: "default", activationId: ACTIVATION_ID, reason: "   " }),
    ).rejects.toThrow(/non-empty reason/u);
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("reduces retained mesh events to the newest fact per invocation with honest reconciliation flags", () => {
    const events = [
      meshEvent("mesh_capability_invocation_settled", {
        invocationId: "mesh-invocation-1",
        disposition: "unknown",
        settlementAuthority: "gateway",
        errorCode: "mesh_capability_dispatch_deadline_expired",
      }),
      meshEvent("mesh_capability_invocation_dispatched", { invocationId: "mesh-invocation-1" }),
      meshEvent("mesh_capability_invocation_settled", {
        invocationId: "mesh-invocation-2",
        disposition: "succeeded",
        settlementAuthority: "node",
      }),
      // Foreign workspace and non-mesh sources never leak into the summary.
      meshEvent("mesh_capability_invocation_settled", {
        invocationId: "mesh-invocation-3",
        disposition: "failed",
        workspaceId: "other",
      }),
      { ...meshEvent("mesh_capability_invocation_settled", { invocationId: "mesh-invocation-4" }), source: "gateway" },
    ];
    const summary = summarizeMeshCapabilityInvocationActivity(events, "default");
    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({
      invocationId: "mesh-invocation-1",
      phase: "settled",
      disposition: "unknown",
      settlementAuthority: "gateway",
      manualReconciliationRequired: true,
    });
    expect(summary[1]).toMatchObject({
      invocationId: "mesh-invocation-2",
      disposition: "succeeded",
      manualReconciliationRequired: false,
    });
  });

  it("fetches invocation activity through the existing retained-events route only", async () => {
    apiMocks.request.mockResolvedValueOnce({ items: [] });
    const items = await fetchMeshCapabilityInvocationActivity("default", 50);
    expect(apiMocks.request).toHaveBeenCalledWith("/api/v1/events?limit=50");
    expect(items).toEqual([]);
  });
});

let sequence = 0;

function meshEvent(eventType: string, payload: Record<string, unknown>): RealtimeEvent {
  sequence += 1;
  return {
    eventId: `evt-${sequence}`,
    sequence,
    eventType,
    source: "mesh",
    timestamp: "2026-07-23T10:00:00.000Z",
    payload: {
      workspaceId: "default",
      capabilityId: "mesh:node-a:tool:project.status",
      nodeId: "node-a",
      ...payload,
    },
  };
}
