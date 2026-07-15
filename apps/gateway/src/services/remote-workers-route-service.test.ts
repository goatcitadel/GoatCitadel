import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  NotFoundError,
  REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
  canonicalJsonString,
  type RemoteWorkerRegistryAdmission,
} from "@goatcitadel/contracts";
import type { RemoteWorkerRegistryRecord } from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteWorkerRegistryInputError,
  RemoteWorkersRouteService,
  decodeRemoteWorkerRegistryCursor,
  encodeRemoteWorkerRegistryCursor,
  type RemoteWorkerRegistryStore,
} from "./remote-workers-route-service.js";

const OBSERVED_AT = "2026-07-15T12:00:00.000Z";
const D = (character: string): string => character.repeat(64);

function admission(overrides: Partial<RemoteWorkerRegistryAdmission> = {}): RemoteWorkerRegistryAdmission {
  return {
    registryWorkspaceId: "workspace-a",
    workerId: "worker-a",
    nodeId: "node-a",
    workerGeneration: 2,
    workerLabel: "Office worker",
    platform: "windows",
    architecture: "x64",
    allowedWorkspaceCount: 2,
    workspaceCeilingSha256: D("a"),
    capabilityClassCount: 3,
    capabilityCeilingSha256: D("b"),
    publicKeySpkiSha256: D("c"),
    clientCertificateSha256: D("d"),
    runtimeManifestSha256: D("e"),
    transportIdentitySource: "native_mtls",
    transportTrustAnchorSha256: D("f"),
    transportVerificationReceiptSha256: D("0"),
    proofOfPossessionReceiptSha256: D("1"),
    downloadVerificationReceiptSha256: D("2"),
    installedTreeAttestationSha256: D("3"),
    installedTreeVerificationReceiptSha256: D("4"),
    admittedAt: "2026-07-15T11:00:00.000Z",
    ...overrides,
  };
}

function record(overrides: Partial<RemoteWorkerRegistryRecord> = {}): RemoteWorkerRegistryRecord {
  return {
    admission: admission(),
    ...overrides,
  };
}

function store(overrides: Partial<RemoteWorkerRegistryStore> = {}): RemoteWorkerRegistryStore {
  return {
    listWorkerRegistry: vi.fn(() => ({ items: [record()] })),
    findWorkerRegistryEntry: vi.fn(() => record()),
    ...overrides,
  };
}

describe("RemoteWorkersRouteService HX-507A", () => {
  it("projects a deeply frozen read-only page with explicit downstream unavailability", () => {
    const registry = store({
      listWorkerRegistry: vi.fn(() => ({ items: [record()], nextCursor: "worker-a" })),
    });
    const service = new RemoteWorkersRouteService(registry, () => OBSERVED_AT);
    const page = service.listRegistry({ workspaceId: "workspace-a", limit: 1 });

    expect(page).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-a",
      observedAt: OBSERVED_AT,
      items: [
        {
          workerId: "worker-a",
          admission: { authorityClass: "canonical_record", owner: "storage.remoteWorkerAdmissions" },
          control: { value: null, authorityClass: "canonical_record" },
          posture: { value: "active", authorityClass: "derived_projection" },
          unavailable: {
            connectionHealth: { value: null, authorityClass: "unavailable" },
            assignments: { value: null, authorityClass: "unavailable" },
            usageAndCost: { value: null, authorityClass: "unavailable" },
            resourceCell: { value: null, authorityClass: "unavailable" },
            artifactAndEffects: { value: null, authorityClass: "unavailable" },
          },
        },
      ],
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.admission.value)).toBe(true);
    expect(registry.listWorkerRegistry).toHaveBeenCalledWith("workspace-a", { limit: 1 });
    expect(decodeRemoteWorkerRegistryCursor(page.nextCursor!)).toEqual({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-a",
    });
    expect(JSON.stringify(page)).not.toMatch(
      /secret|token|reason|actor|idempotency|requestSha256|allowedWorkspaceIds|capabilityClasses/u,
    );
  });

  it("decodes only canonical workspace-bound cursors and passes the raw position to storage", () => {
    const registry = store({ listWorkerRegistry: vi.fn(() => ({ items: [] })) });
    const service = new RemoteWorkersRouteService(registry, () => OBSERVED_AT);
    const cursor = encodeRemoteWorkerRegistryCursor({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-before",
    });
    service.listRegistry({ workspaceId: "workspace-a", cursor });
    expect(registry.listWorkerRegistry).toHaveBeenCalledWith("workspace-a", {
      limit: 25,
      cursor: "worker-before",
    });
    expect(() => service.listRegistry({ workspaceId: "workspace-b", cursor })).toThrow(RemoteWorkerRegistryInputError);

    const reordered = Buffer.from(
      JSON.stringify({
        workspaceId: "workspace-a",
        schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
        lastWorkerId: "worker-before",
      }),
      "utf8",
    ).toString("base64url");
    const extra = Buffer.from(
      canonicalJsonString({
        schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
        workspaceId: "workspace-a",
        lastWorkerId: "worker-before",
        secret: "must-not-echo",
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeRemoteWorkerRegistryCursor(reordered)).toThrow(RemoteWorkerRegistryInputError);
    expect(() => decodeRemoteWorkerRegistryCursor(extra)).toThrow(RemoteWorkerRegistryInputError);
    expect(() => decodeRemoteWorkerRegistryCursor("not-canonical+base64")).toThrow(RemoteWorkerRegistryInputError);
  });

  it("derives quarantine and revoke posture only from the canonical latest control", () => {
    const registry = store({
      listWorkerRegistry: vi.fn(() => ({
        items: [
          record({
            control: {
              workerGeneration: 2,
              controlRevision: 1,
              action: "quarantine",
              createdAt: "2026-07-15T11:30:00.000Z",
            },
          }),
          record({
            admission: admission({ workerId: "worker-b", nodeId: "node-b" }),
            control: {
              workerGeneration: 2,
              controlRevision: 2,
              action: "revoke",
              createdAt: "2026-07-15T11:45:00.000Z",
            },
          }),
        ],
      })),
    });
    const page = new RemoteWorkersRouteService(registry, () => OBSERVED_AT).listRegistry({
      workspaceId: "workspace-a",
    });
    expect(page.items.map((item) => item.posture.value)).toEqual(["quarantined", "revoked"]);
  });

  it("returns frozen detail, maps foreign-workspace absence to 404, and fails inconsistent storage closed", () => {
    const registry = store();
    const service = new RemoteWorkersRouteService(registry, () => OBSERVED_AT);
    const detail = service.getRegistryEntry({ workspaceId: "workspace-a", workerId: "worker-a" });
    expect(detail).toMatchObject({ readOnly: true, workspaceId: "workspace-a", item: { workerId: "worker-a" } });
    expect(Object.isFrozen(detail.item)).toBe(true);

    const missing = new RemoteWorkersRouteService(
      store({ findWorkerRegistryEntry: vi.fn(() => undefined) }),
      () => OBSERVED_AT,
    );
    expect(() => missing.getRegistryEntry({ workspaceId: "workspace-b", workerId: "worker-a" })).toThrow(NotFoundError);

    const wrongDetail = new RemoteWorkersRouteService(
      store({
        findWorkerRegistryEntry: vi.fn(() =>
          record({ admission: admission({ workerId: "worker-b", nodeId: "node-b" }) }),
        ),
      }),
      () => OBSERVED_AT,
    );
    expect(() => wrongDetail.getRegistryEntry({ workspaceId: "workspace-a", workerId: "worker-a" })).toThrow(
      /storage detail is inconsistent/u,
    );

    const inconsistent = new RemoteWorkersRouteService(
      store({
        listWorkerRegistry: vi.fn(() => ({
          items: [record({ admission: admission({ registryWorkspaceId: "workspace-b" }) })],
        })),
      }),
      () => OBSERVED_AT,
    );
    expect(() => inconsistent.listRegistry({ workspaceId: "workspace-a" })).toThrow(TypeError);

    const reordered = new RemoteWorkersRouteService(
      store({
        listWorkerRegistry: vi.fn(() => ({
          items: [record({ admission: admission({ workerId: "worker-b", nodeId: "node-b" }) }), record()],
          nextCursor: "worker-a",
        })),
      }),
      () => OBSERVED_AT,
    );
    expect(() => reordered.listRegistry({ workspaceId: "workspace-a", limit: 2 })).toThrow(/order is invalid/u);
  });

  it("binds malformed storage pages to the requested limit and decoded cursor", () => {
    const cursor = encodeRemoteWorkerRegistryCursor({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-a",
    });
    const oversized = new RemoteWorkersRouteService(
      store({
        listWorkerRegistry: vi.fn(() => ({
          items: [record(), record({ admission: admission({ workerId: "worker-b", nodeId: "node-b" }) })],
        })),
      }),
      () => OBSERVED_AT,
    );
    expect(() => oversized.listRegistry({ workspaceId: "workspace-a", limit: 1 })).toThrow(
      /storage page is inconsistent/u,
    );

    for (const workerId of ["worker-a", "worker-0"]) {
      const stale = new RemoteWorkersRouteService(
        store({
          listWorkerRegistry: vi.fn(() => ({
            items: [record({ admission: admission({ workerId, nodeId: `node-${workerId}` }) })],
          })),
        }),
        () => OBSERVED_AT,
      );
      expect(() => stale.listRegistry({ workspaceId: "workspace-a", cursor })).toThrow(/storage page is inconsistent/u);
    }

    const shortPageWithCursor = new RemoteWorkersRouteService(
      store({ listWorkerRegistry: vi.fn(() => ({ items: [record()], nextCursor: "worker-a" })) }),
      () => OBSERVED_AT,
    );
    expect(() => shortPageWithCursor.listRegistry({ workspaceId: "workspace-a", limit: 2 })).toThrow(
      /storage page is inconsistent/u,
    );
  });

  it("composes only through storage.remoteWorkerAdmissions and registers the server route", () => {
    const composition = readFileSync(new URL("./gateway-route-composition-runtime.ts", import.meta.url), "utf8");
    const services = readFileSync(new URL("./gateway-route-services.ts", import.meta.url), "utf8");
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(composition).toMatch(/remoteWorkers:\s*gateway\.storage\.remoteWorkerAdmissions/u);
    expect(composition).not.toMatch(
      /remoteWorkers:\s*gateway\.storage\.remoteWorker(?:Assignments|Usage|ResourceCells|Artifacts)/u,
    );
    expect(services).toMatch(/remoteWorkers:\s*new RemoteWorkersRouteService\(deps\.remoteWorkers\)/u);
    expect(app).toMatch(/import \{ remoteWorkersRoutes \} from "\.\/routes\/remote-workers\.js"/u);
    expect(app).toMatch(/await app\.register\(remoteWorkersRoutes\)/u);
  });
});
