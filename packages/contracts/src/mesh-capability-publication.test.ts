import { describe, expect, it } from "vitest";
import {
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
  assertMeshCallableKind,
  assertMeshCapabilityEffectDiff,
  assertMeshCapabilityManifest,
  assertMeshCapabilityPermissionDiff,
  deriveMeshCapabilityId,
  type MeshCapabilityManifest,
  type MeshMcpServerCapabilityDescriptor,
  type MeshToolCapabilityDescriptor,
} from "./mesh-capability-publication.js";

const SHA = "a".repeat(64);

function descriptor(overrides: Partial<MeshToolCapabilityDescriptor> = {}): MeshToolCapabilityDescriptor {
  return {
    kind: "tool",
    title: "Read project status",
    semanticVersion: "1.2.3",
    effectPosture: "read_only",
    permissions: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: ["workspace://project"],
      filesystemWrite: [],
      networkOrigins: ["https://api.example.test"],
      environmentNames: [],
      deviceCapabilities: [],
    },
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    idempotency: "intrinsic",
    ...overrides,
  };
}

function manifest(overrides: Partial<MeshCapabilityManifest> = {}): MeshCapabilityManifest {
  const capabilityId = deriveMeshCapabilityId("node-a", "tool", "project.status");
  return {
    schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    workspaceId: "workspace-a",
    nodeId: "node-a",
    admissionGeneration: 1,
    publisherGeneration: 1,
    publicationKey: "publication-1",
    publicationLeaseFencingToken: 1,
    entries: [
      {
        localId: "project.status",
        kind: "tool",
        capabilityId,
        descriptor: descriptor(),
        descriptorSha256: SHA,
        permissionEnvelopeSha256: SHA,
        entrySha256: SHA,
      },
    ],
    createdAt: "2026-07-14T12:00:00.000Z",
    manifestSha256: SHA,
    ...overrides,
  };
}

function mcpDescriptor(overrides: Partial<MeshMcpServerCapabilityDescriptor> = {}): MeshMcpServerCapabilityDescriptor {
  return {
    kind: "mcp_server",
    title: "Project files",
    semanticVersion: "1.0.0",
    effectPosture: "read_only",
    permissions: descriptor().permissions,
    resourceLimits: descriptor().resourceLimits,
    healthCheck: descriptor().healthCheck,
    protocol: "mcp",
    protocolVersion: "2025-06-18",
    tools: [{ name: "files.read", inputSchemaSha256: SHA }],
    ...overrides,
  };
}

describe("governed mesh capability publication contracts", () => {
  it("accepts a bounded exact-key tool manifest with server-derived identity", () => {
    expect(() => assertMeshCapabilityManifest(manifest())).not.toThrow();
    expect(deriveMeshCapabilityId("node-a", "mcp_server", "files.v1")).toBe("mesh:node-a:mcp_server:files.v1");
  });

  it("accepts bounded MCP metadata without allowing a publisher-selected transport", () => {
    const capabilityId = deriveMeshCapabilityId("node-a", "mcp_server", "project.files");
    const mcpManifest = manifest({
      entries: [
        {
          localId: "project.files",
          kind: "mcp_server",
          capabilityId,
          descriptor: mcpDescriptor(),
          descriptorSha256: SHA,
          permissionEnvelopeSha256: SHA,
          entrySha256: SHA,
        },
      ],
    });
    expect(() => assertMeshCapabilityManifest(mcpManifest)).not.toThrow();
    expect(() =>
      assertMeshCapabilityManifest({
        ...mcpManifest,
        entries: [
          {
            ...mcpManifest.entries[0]!,
            descriptor: mcpDescriptor({ endpoint: "https://publisher.example" } as never),
          },
        ],
      }),
    ).toThrow(/unknown field endpoint|direct transport/);
  });

  it("fails closed on unknown fields, duplicate identities, and unsafe local names", () => {
    expect(() => assertMeshCapabilityManifest({ ...manifest(), endpoint: "https://node.test" } as never)).toThrow(
      /unknown field endpoint/,
    );
    const duplicate = manifest();
    duplicate.entries = [...duplicate.entries, duplicate.entries[0]!];
    expect(() => assertMeshCapabilityManifest(duplicate)).toThrow(/duplicate|sorted/);
    expect(() => deriveMeshCapabilityId("node-a", "tool", "../../shell")).toThrow(/safe name/);
  });

  it("rejects credentials, direct transport, malformed schemas, and non-origin network grants", () => {
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({ entries: [{ ...manifest().entries[0]!, descriptor: descriptor({ command: "pwsh" } as never) }] }),
      ),
    ).toThrow(/unknown field command|direct transport/);
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({ entries: [{ ...manifest().entries[0]!, descriptor: descriptor({ inputSchema: {} }) }] }),
      ),
    ).toThrow(/cannot be empty/);
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({
          entries: [
            {
              ...manifest().entries[0]!,
              descriptor: descriptor({
                permissions: { ...descriptor().permissions, networkOrigins: ["https://user:pass@example.test/path"] },
              }),
            },
          ],
        }),
      ),
    ).toThrow(/credential-free exact/);
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({
          entries: [
            {
              ...manifest().entries[0]!,
              descriptor: descriptor({ description: "Authorization: Bearer abcdefghijklmnop" }),
            },
          ],
        }),
      ),
    ).toThrow(/embedded credential/);
  });

  it("requires exact versioned health metadata and canonical permission/effect diff shapes", () => {
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({ entries: [{ ...manifest().entries[0]!, descriptor: descriptor({ semanticVersion: "01.2.3" }) }] }),
      ),
    ).toThrow(/SemVer/);
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({
          entries: [
            {
              ...manifest().entries[0]!,
              descriptor: descriptor({
                healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 1_000, timeoutMs: 2_000 },
              }),
            },
          ],
        }),
      ),
    ).toThrow(/timeout/);
    const inheritedVersion = { ...descriptor() };
    delete (inheritedVersion as Partial<MeshToolCapabilityDescriptor>).semanticVersion;
    Object.setPrototypeOf(inheritedVersion, { semanticVersion: "1.2.3" });
    expect(() =>
      assertMeshCapabilityManifest(
        manifest({ entries: [{ ...manifest().entries[0]!, descriptor: inheritedVersion }] }),
      ),
    ).toThrow(/missing required field semanticVersion/);

    expect(() =>
      assertMeshCapabilityPermissionDiff(
        {
          schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
          disposition: "widened",
          priorActivationId: "activation-1",
          priorPermissionEnvelopeSha256: "b".repeat(64),
          currentPermissionEnvelopeSha256: SHA,
          added: [],
          removed: [],
        },
        SHA,
      ),
    ).toThrow(/change shape/);
    expect(() =>
      assertMeshCapabilityEffectDiff(
        {
          schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
          disposition: "reduced",
          priorActivationId: "activation-1",
          priorEffectPosture: "read_only",
          currentEffectPosture: "external_side_effect",
        },
        "external_side_effect",
      ),
    ).toThrow(/exact posture transition/);
  });

  it("keeps published skill descriptors inspectable-only", () => {
    expect(() => assertMeshCallableKind("tool")).not.toThrow();
    expect(() => assertMeshCallableKind("mcp_server")).not.toThrow();
    expect(() => assertMeshCallableKind("skill")).toThrow(/never be callable/);
  });
});
