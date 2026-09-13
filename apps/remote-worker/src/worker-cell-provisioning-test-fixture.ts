import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION, remoteWorkerCellProvisioningPlanSha256,
  type RemoteWorkerCellPreparation, type RemoteWorkerCellProvisioningExchange,
} from "@goatcitadel/contracts";
import { decodeWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";

/** Independent worker-side native-format fixture; no storage/runtime imports. */
export function workerCellProvisioningFixture(virtualDiskMiB = 16) {
  const identity = (index: number) => "0100000000000000" + index.toString(16).padStart(32, "0");
  const parentPath = "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells";
  const pathBytes = Buffer.from(parentPath);
  const custodyBytes = Buffer.alloc(132 + pathBytes.length);
  custodyBytes.write("GCCINF01"); custodyBytes.writeUInt32LE(pathBytes.length, 8); custodyBytes.write("GCCUST01", 12);
  custodyBytes.fill(0x11, 20, 52); custodyBytes.fill(0x22, 52, 84);
  Buffer.from(identity(8), "hex").copy(custodyBytes, 84); Buffer.from(identity(1), "hex").copy(custodyBytes, 108);
  pathBytes.copy(custodyBytes, 132);
  const custody = decodeWindowsWorkerCellControllerCustody(custodyBytes);
  const lease = { registryWorkspaceId: "default", assignmentId: "assignment-native", assignmentGeneration: 1,
    leaseRevision: 2, leaseToken: "synthetic-private-lease" };
  const plan = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: "1".repeat(64), profileSha256: "2".repeat(64), parentIdentityHex: identity(1),
    cellName: `gc-cell-${"1".repeat(32)}`, ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5",
    diskIdentifierHex: "3".repeat(32), virtualDiskBytes: virtualDiskMiB * 1024 * 1024, reservedDiskBytes: (virtualDiskMiB + 64) * 1024 * 1024 } as const;
  const records: string[] = [];
  for (let sequence = 1; sequence <= 5; sequence++) {
    const bytes = Buffer.alloc(1024);
    bytes.write("GCCELLP1"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
    for (const [offset, value] of [[16, records.at(-1)?.slice(-64) ?? "0".repeat(64)],
      [48, plan.assignmentBindingSha256], [80, plan.profileSha256], [112, plan.diskIdentifierHex],
      [144, plan.parentIdentityHex], [168, identity(2)]] as const) Buffer.from(value, "hex").copy(bytes, offset);
    bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
    bytes.write(plan.cellName, 192); bytes.write(plan.ownerSid, 232); bytes.write(plan.controllerSid, 416);
    if (sequence >= 3) for (let index = 0; index < 4; index++) Buffer.from(identity(index + 3), "hex").copy(bytes, 600 + index * 24);
    if (sequence === 5) Buffer.from(identity(7), "hex").copy(bytes, 696);
    createHash("sha256").update(bytes.subarray(0, 992)).digest().copy(bytes, 992);
    records.push(bytes.toString("hex"));
  }
  const exchange: RemoteWorkerCellProvisioningExchange = {
    schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: lease.registryWorkspaceId,
    assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration, leaseRevision: lease.leaseRevision,
    plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records: [],
  };
  const prepared: RemoteWorkerCellPreparation = { schemaVersion: REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION,
    decision: "create_once", provisioningExpiresAt: new Date(Date.now() + 120000).toISOString(), exchange };
  return { lease, plan, records, custody, custodyBytes, exchange, prepared };
}
