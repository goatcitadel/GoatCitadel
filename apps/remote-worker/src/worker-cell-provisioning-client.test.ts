import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  remoteWorkerCellProvisioningPlanSha256, type RemoteWorkerCellProvisioningPlan,
} from "@goatcitadel/contracts";
import { exchangeWorkerCellProvisioning, prepareWorkerCellProvisioning, projectWorkerCellProvisioningResponse } from "./worker-cell-provisioning-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";
import { volumeExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mount-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";

vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));

// Independent encoder for the two initial native records. Keep the worker test
// inside its package boundary; it must not pull Gateway storage into the worker.
function checkpointFixture(plan: RemoteWorkerCellProvisioningPlan, sequence: number, previous = "0".repeat(64)): string {
  const bytes = Buffer.alloc(1024);
  bytes.write("GCCELLP1"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  for (const [offset, value] of [[16, previous], [48, plan.assignmentBindingSha256], [80, plan.profileSha256],
    [112, plan.diskIdentifierHex], [144, plan.parentIdentityHex], [168, "0100000000000000" + "2".repeat(32)]] as const) {
    Buffer.from(value, "hex").copy(bytes, offset);
  }
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
  bytes.write(plan.cellName, 192); bytes.write(plan.ownerSid, 232); bytes.write(plan.controllerSid, 416);
  createHash("sha256").update(bytes.subarray(0, 992)).digest().copy(bytes, 992);
  return bytes.toString("hex");
}

function fixture() {
  const lease = { registryWorkspaceId: "default", assignmentId: "assignment-a", assignmentGeneration: 1,
    leaseRevision: 2, leaseToken: "synthetic-private-lease" };
  const plan = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: "1".repeat(64), profileSha256: "2".repeat(64),
    parentIdentityHex: "0100000000000000" + "1".repeat(32), cellName: `gc-cell-${"1".repeat(32)}`,
    ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5", diskIdentifierHex: "3".repeat(32),
    virtualDiskBytes: 16 * 1024 * 1024, reservedDiskBytes: 80 * 1024 * 1024 } as const;
  const first = checkpointFixture(plan, 1);
  const cellProvisioning = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId,
    assignmentGeneration: lease.assignmentGeneration, leaseRevision: lease.leaseRevision,
    plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records: [first] };
  return { lease, cellProvisioning, submission: { kind: "cell.provisioning.checkpoint" as const, expectedSequence: 0, recordHex: first },
    body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      registryWorkspaceId: "default", disposition: "cell_provisioning_recorded", cellProvisioning } };
}

describe("worker cell provisioning client", () => {
  it("preserves one-time creation and reconciliation decisions through protected requests", async () => {
    const f = fixture(), signal = new AbortController().signal;
    const submission = { kind: "cell.provisioning.prepare" as const, parentIdentityHex: f.cellProvisioning.plan.parentIdentityHex };
    const context = { client: {}, credential: {} } as RouteContext;
    for (const decision of ["create_once", "reconcile"] as const) {
      const result = { schemaVersion: "goatcitadel.remote-worker-cell-preparation.v1", decision,
        provisioningExpiresAt: "2099-01-01T00:00:00.000Z", exchange: { ...f.cellProvisioning, records: [] } };
      vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200,
        body: { ...f.body, disposition: "cell_provisioning_prepared", cellPreparation: result } });
      await expect(prepareWorkerCellProvisioning(context, f.lease, submission, signal)).resolves.toEqual(result);
      expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({ signal,
        operation: "assignment.settlement.submit", payload: expect.objectContaining({ ...f.lease, submission }) }));
    }
  });

  it.each(["expired", "foreign", "parent", "lease", "envelope", "recorded_create"])("refuses a %s preparation response", async (failure) => {
    const f = fixture(), exchange = { ...f.cellProvisioning, records: [] as string[] };
    if (failure === "foreign") exchange.assignmentId = "other";
    if (failure === "lease") exchange.leaseRevision++;
    if (failure === "recorded_create") exchange.records = f.cellProvisioning.records;
    const result = { schemaVersion: "goatcitadel.remote-worker-cell-preparation.v1", decision: "create_once",
      provisioningExpiresAt: failure === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", exchange };
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body: { ...f.body,
      disposition: failure === "envelope" ? "cell_provisioning_recorded" : "cell_provisioning_prepared", cellPreparation: result } });
    await expect(prepareWorkerCellProvisioning({ client: {}, credential: {} } as RouteContext, f.lease,
      { kind: "cell.provisioning.prepare", parentIdentityHex: failure === "parent" ? "0100000000000000" + "f".repeat(32) : exchange.plan.parentIdentityHex }))
      .rejects.toThrow();
  });

  it("carries volume records through protected settlement and requires the exact canonical acknowledgement", async () => {
    const native = workerCellProvisioningFixture(64);
    const result = volumeExchangeFixture({ ...native.exchange, records: native.records });
    const submission = { kind: "cell.volume.checkpoint" as const, expectedSequence: 5, recordHex: result.volumeRecords![5]! };
    const body = { ...fixture().body, cellProvisioning: result };
    expect(projectWorkerCellProvisioningResponse(body, native.lease, submission)).toEqual(result);
    for (const volumeRecords of [[], result.volumeRecords!.slice(0, 5), result.volumeRecords!.slice(1)])
      expect(() => projectWorkerCellProvisioningResponse({ ...body, cellProvisioning: { ...result, volumeRecords } }, native.lease, submission)).toThrow();
    expect(() => projectWorkerCellProvisioningResponse(body, { ...native.lease, leaseRevision: 1 }, submission)).toThrow();
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body });
    const signal = new AbortController().signal;
    await expect(exchangeWorkerCellProvisioning({ client: {}, credential: {} } as RouteContext, native.lease, submission, signal)).resolves.toEqual(result);
    expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({ signal, operation: "assignment.settlement.submit",
      payload: expect.objectContaining({ ...native.lease, submission }) }));
  });

  it("carries format records through protected settlement and refuses an incomplete or substituted acknowledgement", async () => {
    const native = workerCellProvisioningFixture(64);
    const result = formatExchangeFixture({ ...native.exchange, records: native.records });
    const submission = { kind: "cell.format.checkpoint" as const, expectedSequence: 1, recordHex: result.formatRecords![1]! };
    const body = { ...fixture().body, cellProvisioning: result };
    expect(projectWorkerCellProvisioningResponse(body, native.lease, submission)).toEqual(result);
    for (const formatRecords of [[], result.formatRecords!.slice(0, 1), result.formatRecords!.slice(1)])
      expect(() => projectWorkerCellProvisioningResponse({ ...body, cellProvisioning: { ...result, formatRecords } }, native.lease, submission)).toThrow();
    expect(() => projectWorkerCellProvisioningResponse(body, { ...native.lease, leaseRevision: 1 }, submission)).toThrow();
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body });
    const signal = new AbortController().signal;
    await expect(exchangeWorkerCellProvisioning({ client: {}, credential: {} } as RouteContext, native.lease, submission, signal)).resolves.toEqual(result);
    expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({ signal, operation: "assignment.settlement.submit",
      payload: expect.objectContaining({ ...native.lease, submission }) }));
  });

  it("carries protection records through settlement and requires the exact acknowledgement", async () => {
    const native = workerCellProvisioningFixture(64);
    const result = protectionExchangeFixture({ ...native.exchange, records: native.records });
    const submission = { kind: "cell.protection.checkpoint" as const, expectedSequence: 1, recordHex: result.protectionRecords![1]! };
    const body = { ...fixture().body, cellProvisioning: result };
    expect(projectWorkerCellProvisioningResponse(body, native.lease, submission)).toEqual(result);
    for (const protectionRecords of [[], result.protectionRecords!.slice(0, 1), result.protectionRecords!.slice(1)])
      expect(() => projectWorkerCellProvisioningResponse({ ...body, cellProvisioning: { ...result, protectionRecords } }, native.lease, submission)).toThrow();
    expect(() => projectWorkerCellProvisioningResponse(body, { ...native.lease, leaseRevision: 1 }, submission)).toThrow();
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body });
    const signal = new AbortController().signal;
    await expect(exchangeWorkerCellProvisioning({ client: {}, credential: {} } as RouteContext, native.lease, submission, signal)).resolves.toEqual(result);
    expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({ signal, operation: "assignment.settlement.submit",
      payload: expect.objectContaining({ ...native.lease, submission }) }));
  });

  it("carries mount records through settlement and requires the exact acknowledgement", async () => {
    const native = workerCellProvisioningFixture(64);
    const result = mountExchangeFixture({ ...native.exchange, records: native.records });
    const submission = { kind: "cell.mount.checkpoint" as const, expectedSequence: 3, recordHex: result.mountRecords![3]! };
    const body = { ...fixture().body, cellProvisioning: result };
    expect(projectWorkerCellProvisioningResponse(body, native.lease, submission)).toEqual(result);
    for (const mountRecords of [[], ...[1, 2, 3].map((length) => result.mountRecords!.slice(0, length)), result.mountRecords!.slice(1)])
      expect(() => projectWorkerCellProvisioningResponse({ ...body, cellProvisioning: { ...result, mountRecords } }, native.lease, submission)).toThrow();
    expect(() => projectWorkerCellProvisioningResponse(body, { ...native.lease, leaseRevision: 1 }, submission)).toThrow();
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body });
    const signal = new AbortController().signal;
    await expect(exchangeWorkerCellProvisioning({ client: {}, credential: {} } as RouteContext, native.lease, submission, signal)).resolves.toEqual(result);
    expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({ signal, operation: "assignment.settlement.submit",
      payload: expect.objectContaining({ ...native.lease, submission }) }));
  });
  it("carries mounted workspace records through settlement and requires the exact acknowledgement", async () => {
    const native = workerCellProvisioningFixture(64);
    const result = mountedWorkspaceExchangeFixture({ ...native.exchange, records: native.records });
    const submission = { kind: "cell.mounted-workspace.checkpoint" as const, expectedSequence: 1, recordHex: result.mountedWorkspaceRecords![1]! };
    const body = { ...fixture().body, cellProvisioning: result };
    expect(projectWorkerCellProvisioningResponse(body, native.lease, submission)).toEqual(result);
    for (const mountedWorkspaceRecords of [[], ...[1].map((length) => result.mountedWorkspaceRecords!.slice(0, length)), result.mountedWorkspaceRecords!.slice(1)])
      expect(() => projectWorkerCellProvisioningResponse({ ...body, cellProvisioning: { ...result, mountedWorkspaceRecords } }, native.lease, submission)).toThrow();
    expect(() => projectWorkerCellProvisioningResponse(body, { ...native.lease, leaseRevision: 1 }, submission)).toThrow();
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body });
    const signal = new AbortController().signal;
    await expect(exchangeWorkerCellProvisioning({ client: {}, credential: {} } as RouteContext, native.lease, submission, signal)).resolves.toEqual(result);
    expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({ signal, operation: "assignment.settlement.submit",
      payload: expect.objectContaining({ ...native.lease, submission }) }));
  });

  it("verifies the complete returned chain and refuses uncommitted, foreign or malformed acknowledgements", () => {
    const f = fixture();
    expect(projectWorkerCellProvisioningResponse(f.body, f.lease, f.submission)).toEqual(f.cellProvisioning);
    for (const patch of [{ assignmentId: "other" }, { assignmentGeneration: 2 }, { leaseRevision: 1 },
      { registryWorkspaceId: "other" }, { planSha256: "f".repeat(64) }, { records: [] },
      { records: [f.submission.recordHex, f.submission.recordHex] }, { provisioningOwner: "leaked" }]) {
      expect(() => projectWorkerCellProvisioningResponse({ ...f.body, cellProvisioning: { ...f.cellProvisioning, ...patch } },
        f.lease, f.submission)).toThrow();
    }
    for (const patch of [{ disposition: "created" }, { operation: "assignment.sync" },
      { schemaVersion: "future" }, { registryWorkspaceId: "other" }]) {
      expect(() => projectWorkerCellProvisioningResponse({ ...f.body, ...patch }, f.lease, f.submission)).toThrow();
    }
    const second = checkpointFixture(f.cellProvisioning.plan, 2, f.submission.recordHex.slice(-64));
    expect(projectWorkerCellProvisioningResponse({ ...f.body, cellProvisioning: { ...f.cellProvisioning,
      records: [f.submission.recordHex, second] } }, f.lease, f.submission).records).toHaveLength(2);
  });

  it("uses protected settlement with a frozen lease, bounded bytes and cancellation, without hashing raw secrets into idempotency", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    vi.mocked(callProtectedRoute).mockImplementationOnce(async () => {
      f.lease.assignmentId = "changed-after-send";
      return { status: 200, body: f.body };
    });
    const context = { client: {}, credential: {} } as RouteContext;
    const originalLease = { ...f.lease };
    await expect(exchangeWorkerCellProvisioning(context, f.lease, f.submission, signal)).resolves.toEqual(f.cellProvisioning);
    expect(callProtectedRoute).toHaveBeenLastCalledWith(expect.objectContaining({
      rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", operation: "assignment.settlement.submit", signal,
      payload: expect.objectContaining({ ...originalLease, submission: f.submission }),
    }));
    const firstKey = vi.mocked(callProtectedRoute).mock.calls.at(-1)![0].idempotencyKey;
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body: f.body });
    await exchangeWorkerCellProvisioning(context, { ...originalLease, leaseToken: "another-private-lease" }, f.submission);
    expect(vi.mocked(callProtectedRoute).mock.calls.at(-1)![0].idempotencyKey).toBe(firstKey);
  });
});
