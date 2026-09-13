import {
  canonicalJsonString, normalizeRemoteWorkerCellPreparation, normalizeRemoteWorkerCellProvisioningExchange,
  readRemoteWorkerCellProvisioningCheckpoint,
  readRemoteWorkerCellVolumeCheckpoint, remoteWorkerCellProvisioningVolumeAnchor,
  readRemoteWorkerCellFormatCheckpoint, remoteWorkerCellProvisioningFormatAnchor,
  readRemoteWorkerCellProtectionCheckpoint, remoteWorkerCellProvisioningProtectionAnchor,
  readRemoteWorkerCellMountCheckpoint, remoteWorkerCellProvisioningMountAnchor,
  readRemoteWorkerCellMountedWorkspaceCheckpoint, remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  type RemoteWorkerCellPreparation, type RemoteWorkerCellPreparationSubmission,
  type RemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningPlan,
  type RemoteWorkerCellProvisioningRecovery, type RemoteWorkerCellProvisioningSubmission,
} from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding } from "./connected-worker-routes.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import type { WindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";

export interface WorkerCellProvisioningNativePort {
  create(plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>): Promise<void>;
  recover(input: RemoteWorkerCellProvisioningRecovery): Promise<readonly string[]>;
  createVolume?(plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>, authorize: () => Promise<void>): Promise<void>;
  recoverVolume?(input: RemoteWorkerCellProvisioningExchange): Promise<{ readonly records: readonly string[]; readonly volumeRecords: readonly string[] }>;
  createFormat?(plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>, authorize: () => Promise<void>): Promise<void>;
  recoverFormat?(input: RemoteWorkerCellProvisioningExchange): Promise<{
    readonly records: readonly string[]; readonly volumeRecords: readonly string[]; readonly formatRecords: readonly string[];
  }>;
  createProtection?(plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>, authorize: () => Promise<void>): Promise<void>;
  recoverProtection?(input: RemoteWorkerCellProvisioningExchange): Promise<{
    readonly records: readonly string[]; readonly volumeRecords: readonly string[]; readonly formatRecords: readonly string[];
    readonly protectionRecords: readonly string[];
  }>;
  createMount?(plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>, authorize: () => Promise<void>): Promise<void>;
  recoverMount?(input: RemoteWorkerCellProvisioningExchange): Promise<{
    readonly records: readonly string[]; readonly volumeRecords: readonly string[]; readonly formatRecords: readonly string[];
    readonly protectionRecords: readonly string[]; readonly mountRecords: readonly string[];
  }>;
  createMountedWorkspace?(plan: RemoteWorkerCellProvisioningPlan, commit: (recordHex: string) => Promise<string>, authorize: () => Promise<void>): Promise<void>;
  recoverMountedWorkspace?(input: RemoteWorkerCellProvisioningExchange): Promise<{
    readonly records: readonly string[]; readonly volumeRecords: readonly string[]; readonly formatRecords: readonly string[];
    readonly protectionRecords: readonly string[]; readonly mountRecords: readonly string[]; readonly mountedWorkspaceRecords: readonly string[];
  }>;
}
export interface WorkerCellProvisioningInput {
  readonly scope: Pick<LeaseBinding, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">;
  readonly state: WorkerDurableStatePort;
  /** Read from the installed pinned helper, never supplied by a workload. */
  readonly custody: WindowsWorkerCellControllerCustody;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly prepare: (submission: RemoteWorkerCellPreparationSubmission, signal: AbortSignal) => Promise<RemoteWorkerCellPreparation>;
  readonly exchange: (submission: RemoteWorkerCellProvisioningSubmission, signal: AbortSignal) => Promise<RemoteWorkerCellProvisioningExchange>;
  readonly native: (options: { readonly wallMs: number; readonly signal: AbortSignal }) => WorkerCellProvisioningNativePort;
  /** Trusted installed startup requires the complete volume stage. This cannot
   * authorize continuation of any interrupted or previously consumed creator. */
  readonly requireVolume?: boolean;
  /** Includes volume preparation and both canonical NTFS format checkpoints. */
  readonly requireFormat?: boolean;
  /** Includes complete volume/format history and both root protection records. */
  readonly requireProtection?: boolean;
  /** Includes all preceding stages and the four fixed-folder mount records. */
  readonly requireMount?: boolean;
  /** Includes complete mount history and both execution-root journal records. */
  readonly requireMountedWorkspace?: boolean;
}
export type WorkerCellProvisioningResult = {
  readonly status: "recorded" | "recovery_verified";
  readonly snapshot: RemoteWorkerCellProvisioningExchange;
} | {
  readonly status: "reconciliation_required";
  readonly reason: "no_anchor" | "checkpoint_mismatch" | "incomplete_journal" | "mount_verification_unavailable" | "workspace_verification_unavailable";
  readonly snapshot: RemoteWorkerCellProvisioningExchange;
};

const active = new WeakMap<WorkerDurableStatePort, Set<string>>();
const refused = () => new Error("Worker cell provisioning requires reconciliation of retained evidence.");

/** Consumes a fresh Gateway decision once, with a local stop marker before any
 * native creation. The marker only removes authority. It never permits create,
 * resume, cleanup, workload execution or a platform-ready transition. The host's
 * existing process state lock owns cross-process exclusion. */
export async function provisionWorkerCell(input: WorkerCellProvisioningInput): Promise<WorkerCellProvisioningResult> {
  if (input.requireVolume !== undefined && typeof input.requireVolume !== "boolean") throw refused();
  if (input.requireFormat !== undefined && typeof input.requireFormat !== "boolean") throw refused();
  if (input.requireProtection !== undefined && typeof input.requireProtection !== "boolean") throw refused();
  if (input.requireMount !== undefined && typeof input.requireMount !== "boolean") throw refused();
  if (input.requireMountedWorkspace !== undefined && typeof input.requireMountedWorkspace !== "boolean") throw refused();
  input = Object.freeze({ ...input, requireVolume: input.requireVolume || input.requireFormat || input.requireProtection || input.requireMount || input.requireMountedWorkspace,
    requireFormat: input.requireFormat || input.requireProtection || input.requireMount || input.requireMountedWorkspace,
    requireProtection: input.requireProtection || input.requireMount || input.requireMountedWorkspace,
    requireMount: input.requireMount || input.requireMountedWorkspace, custody: Object.freeze({ ...input.custody }) });
  const scope = Object.freeze({ registryWorkspaceId: input.scope.registryWorkspaceId,
    assignmentId: input.scope.assignmentId, assignmentGeneration: input.scope.assignmentGeneration });
  const stateKey = `cell-provisioning-${sha256Utf8(canonicalJsonString(scope))}`;
  const held = active.get(input.state) ?? new Set<string>();
  if (held.has(stateKey)) throw refused();
  held.add(stateKey); active.set(input.state, held);
  const stop = new AbortController();
  let signal = AbortSignal.any([input.signal, stop.signal]);
  let closed = false, failed = false;
  let pending: Promise<string> | undefined;
  const assertCurrent = async () => {
    signal.throwIfAborted();
    await input.assertCurrent();
    signal.throwIfAborted();
    if (closed || failed) throw refused();
  };
  try {
    await assertCurrent();
    const prepared = normalizeRemoteWorkerCellPreparation(await input.prepare({
      kind: "cell.provisioning.prepare", parentIdentityHex: input.custody.parentIdentityHex,
    }, signal));
    let snapshot = prepared.exchange;
    const check = (value: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellProvisioningExchange => {
      const next = normalizeRemoteWorkerCellProvisioningExchange(value);
      if (next.registryWorkspaceId !== scope.registryWorkspaceId || next.assignmentId !== scope.assignmentId ||
          next.assignmentGeneration !== scope.assignmentGeneration || next.planSha256 !== snapshot.planSha256 ||
          next.leaseRevision < snapshot.leaseRevision || next.plan.parentIdentityHex !== input.custody.parentIdentityHex ||
          (!input.requireVolume && next.volumeRecords?.length) || (!input.requireFormat && next.formatRecords?.length) ||
          (!input.requireProtection && next.protectionRecords?.length)) throw refused();
      return next;
    };
    snapshot = check(snapshot);
    if (!input.requireMountedWorkspace && snapshot.mountedWorkspaceRecords?.length) {
      await assertCurrent();
      return { status: "reconciliation_required", reason: "workspace_verification_unavailable", snapshot };
    }
    // A caller requiring a shorter stage cannot independently verify a mount.
    if (!input.requireMount && snapshot.mountRecords?.length) {
      await assertCurrent();
      return { status: "reconciliation_required", reason: "mount_verification_unavailable", snapshot };
    }
    const remaining = Date.parse(prepared.provisioningExpiresAt) - Date.now();
    if (remaining < 100 || remaining > 600000) throw refused();
    signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    await assertCurrent();
    const marker = canonicalJsonString({ schemaVersion: "goatcitadel.worker-cell-provisioning-consumed.v1",
      ...scope, planSha256: snapshot.planSha256, custodySha256: input.custody.custodySha256 });
    const retained = await input.state.read(stateKey);
    if (retained !== undefined && retained !== marker) throw refused();
    if (retained === undefined) {
      await input.state.write(stateKey, marker);
      if (await input.state.read(stateKey) !== marker) throw refused();
    }
    await assertCurrent();
    const refresh = async () => {
      await assertCurrent();
      const current = check(await input.exchange({ kind: "cell.provisioning.snapshot" }, signal));
      await assertCurrent();
      if (!sameHistory(current, snapshot)) throw refused();
      snapshot = current;
    };
    const native = () => {
      signal.throwIfAborted();
      const wallMs = Math.min(600000, Date.parse(prepared.provisioningExpiresAt) - Date.now());
      if (wallMs < 100) throw refused();
      return input.native({ wallMs, signal });
    };
    if (prepared.decision === "reconcile" || retained !== undefined) {
      const anchor = snapshot.records[0];
      if (anchor === undefined) return { status: "reconciliation_required", reason: "no_anchor", snapshot };
      if (input.requireVolume) {
        if (snapshot.volumeRecords?.length !== 6 || (input.requireFormat && snapshot.formatRecords?.length !== 2) ||
            (input.requireProtection && snapshot.protectionRecords?.length !== 2) || (input.requireMount && snapshot.mountRecords?.length !== 4) ||
            (input.requireMountedWorkspace && snapshot.mountedWorkspaceRecords?.length !== 2))
          return { status: "reconciliation_required", reason: "incomplete_journal", snapshot };
        const port = native();
        const recover = input.requireMountedWorkspace ? port.recoverMountedWorkspace : input.requireMount ? port.recoverMount : input.requireProtection ? port.recoverProtection : input.requireFormat ? port.recoverFormat : port.recoverVolume;
        if (input.requireMountedWorkspace && !recover)
          return { status: "reconciliation_required", reason: "workspace_verification_unavailable", snapshot };
        if (input.requireMount && !recover)
          return { status: "reconciliation_required", reason: "mount_verification_unavailable", snapshot };
        if (!recover) throw refused();
        const returned = await recover.call(port, snapshot);
        const observed = normalizeRemoteWorkerCellProvisioningExchange({ ...snapshot, records: returned.records,
          volumeRecords: returned.volumeRecords, formatRecords: "formatRecords" in returned ? returned.formatRecords : [],
          protectionRecords: "protectionRecords" in returned ? returned.protectionRecords : [],
          mountRecords: "mountRecords" in returned ? returned.mountRecords : [],
          mountedWorkspaceRecords: "mountedWorkspaceRecords" in returned ? returned.mountedWorkspaceRecords : [] });
        await assertCurrent();
        if (!sameHistory(observed, snapshot))
          return { status: "reconciliation_required", reason: "checkpoint_mismatch", snapshot };
        await refresh();
        return { status: "recovery_verified", snapshot };
      }
      const returned = await native().recover({ plan: snapshot.plan, preparedRecordHex: anchor });
      const observed = normalizeRemoteWorkerCellProvisioningExchange({ ...snapshot, records: returned }).records;
      await assertCurrent();
      if (!sameRecords(observed, snapshot.records))
        return { status: "reconciliation_required", reason: "checkpoint_mismatch", snapshot };
      await refresh();
      return snapshot.records.length === 5 ? { status: "recovery_verified", snapshot }
        : { status: "reconciliation_required", reason: "incomplete_journal", snapshot };
    }
    const commit = (recordHex: string): Promise<string> => {
      if (closed || pending || failed || signal.aborted) {
        failed = true; stop.abort();
        return Promise.reject(refused());
      }
      pending = (async () => {
        const workspace = input.requireMountedWorkspace && snapshot.mountRecords?.length === 4;
        const mount = !workspace && input.requireMount && snapshot.protectionRecords?.length === 2;
        const protection = !workspace && !mount && input.requireProtection && snapshot.formatRecords?.length === 2;
        const format = !workspace && !mount && !protection && input.requireFormat && snapshot.volumeRecords?.length === 6;
        const volume = !workspace && !mount && !protection && !format && input.requireVolume && snapshot.records.length === 5;
        const checkpoint = workspace ? readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(snapshot), recordHex)
          : mount ? readRemoteWorkerCellMountCheckpoint(remoteWorkerCellProvisioningMountAnchor(snapshot), recordHex)
          : protection ? readRemoteWorkerCellProtectionCheckpoint(remoteWorkerCellProvisioningProtectionAnchor(snapshot), recordHex)
          : format ? readRemoteWorkerCellFormatCheckpoint(remoteWorkerCellProvisioningFormatAnchor(snapshot), recordHex)
          : volume ? readRemoteWorkerCellVolumeCheckpoint(remoteWorkerCellProvisioningVolumeAnchor(snapshot), recordHex)
          : readRemoteWorkerCellProvisioningCheckpoint(recordHex);
        const expected = normalizeRemoteWorkerCellProvisioningExchange({ ...snapshot,
          ...(workspace ? { mountedWorkspaceRecords: [...(snapshot.mountedWorkspaceRecords ?? []), checkpoint.recordHex] }
            : mount ? { mountRecords: [...(snapshot.mountRecords ?? []), checkpoint.recordHex] }
            : protection ? { protectionRecords: [...(snapshot.protectionRecords ?? []), checkpoint.recordHex] }
            : format ? { formatRecords: [...(snapshot.formatRecords ?? []), checkpoint.recordHex] }
            : volume ? { volumeRecords: [...(snapshot.volumeRecords ?? []), checkpoint.recordHex] }
            : { records: [...snapshot.records, checkpoint.recordHex] }) });
        await assertCurrent();
        const committed = check(await input.exchange({ kind: workspace ? "cell.mounted-workspace.checkpoint" : mount ? "cell.mount.checkpoint" : protection ? "cell.protection.checkpoint" : format ? "cell.format.checkpoint" : volume ? "cell.volume.checkpoint" : "cell.provisioning.checkpoint",
          expectedSequence: workspace ? (snapshot.mountedWorkspaceRecords?.length ?? 0) : mount ? (snapshot.mountRecords?.length ?? 0) : protection ? (snapshot.protectionRecords?.length ?? 0) : format ? (snapshot.formatRecords?.length ?? 0) : volume ? (snapshot.volumeRecords?.length ?? 0) : snapshot.records.length,
          recordHex: checkpoint.recordHex }, signal));
        if (!sameHistory(committed, expected)) throw refused();
        await assertCurrent();
        snapshot = committed;
        return checkpoint.recordSha256;
      })().catch((error: unknown) => { failed = true; stop.abort(); throw error; })
        .finally(() => { pending = undefined; });
      return pending;
    };
    const port = native();
    if (input.requireMountedWorkspace) {
      if (!port.createMountedWorkspace) throw refused();
      await port.createMountedWorkspace(snapshot.plan, commit, refresh);
    } else if (input.requireMount) {
      if (!port.createMount) throw refused();
      await port.createMount(snapshot.plan, commit, refresh);
    } else if (input.requireProtection) {
      if (!port.createProtection) throw refused();
      await port.createProtection(snapshot.plan, commit, refresh);
    } else if (input.requireFormat) {
      if (!port.createFormat) throw refused();
      await port.createFormat(snapshot.plan, commit, refresh);
    } else if (input.requireVolume) {
      if (!port.createVolume) throw refused();
      await port.createVolume(snapshot.plan, commit, refresh);
    } else await port.create(snapshot.plan, commit);
    if (pending || failed || snapshot.records.length !== 5 || (input.requireVolume && snapshot.volumeRecords?.length !== 6) ||
        (input.requireFormat && snapshot.formatRecords?.length !== 2) || (input.requireProtection && snapshot.protectionRecords?.length !== 2) ||
        (input.requireMount && snapshot.mountRecords?.length !== 4) ||
        (input.requireMountedWorkspace && snapshot.mountedWorkspaceRecords?.length !== 2)) throw refused();
    await refresh();
    return { status: "recorded", snapshot };
  } finally {
    closed = true; stop.abort();
    // A failed or misbehaving driver may return before a commit has finished.
    // Drain that exact mutation before releasing the local process owner.
    if (pending) await pending.catch(() => undefined);
    held.delete(stateKey);
    if (held.size === 0) active.delete(input.state);
  }
}

function sameRecords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((record, index) => record === right[index]);
}
function sameHistory(left: RemoteWorkerCellProvisioningExchange, right: RemoteWorkerCellProvisioningExchange): boolean {
  return sameRecords(left.records, right.records) && sameRecords(left.volumeRecords ?? [], right.volumeRecords ?? []) &&
    sameRecords(left.formatRecords ?? [], right.formatRecords ?? []) && sameRecords(left.protectionRecords ?? [], right.protectionRecords ?? []) &&
    sameRecords(left.mountRecords ?? [], right.mountRecords ?? []) &&
    sameRecords(left.mountedWorkspaceRecords ?? [], right.mountedWorkspaceRecords ?? []);
}
