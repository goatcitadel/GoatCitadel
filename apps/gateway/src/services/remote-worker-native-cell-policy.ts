import { REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, normalizeRemoteWorkerCellCapacityReservation } from "@goatcitadel/contracts";
import type { RemoteWorkerNativeCellPolicy } from "@goatcitadel/storage";

/** Gateway-owned ceilings for native preparation. Assignment output/artifact
 * ceilings can narrow them. Creating a profile does not make a backend ready. */
export const REMOTE_WORKER_NATIVE_CELL_POLICY: RemoteWorkerNativeCellPolicy = Object.freeze({
  provisioningWallMs: 120_000,
  capacity: normalizeRemoteWorkerCellCapacityReservation({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    logicalDiskBytes: 256 * 1024 * 1024, allocatedDiskBytes: 576 * 1024 * 1024,
    fileLimit: 10_000, inodeLimit: 20_000, processLimit: 4, cpuLimitMilli: 1000,
    wallLimitMs: 600_000, memoryLimitBytes: 512 * 1024 * 1024,
    rawOutputLimitBytes: 1024 * 1024, diagnosticLimitBytes: 1024 * 1024, artifactCeilingBytes: 64 * 1024 * 1024,
    backupStagingBytes: 64 * 1024 * 1024, backupPublicationBytes: 64 * 1024 * 1024 }),
});
