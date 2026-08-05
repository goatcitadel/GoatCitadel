/* eslint-disable max-lines -- Runtime authority normalization and projection stay co-located so operator-visible derivation remains auditable. */
import type {
  RuntimeAuthorityFreshness,
  RuntimeAuthorityItem,
  RuntimeAuthorityPosture,
  RuntimeAuthorityProjectionResponse,
  RuntimeAuthorityReference,
  RuntimeAuthorityScope,
} from "@goatcitadel/contracts";
import { redactSecretText } from "@goatcitadel/contracts";

const MAX_ITEMS = 40;
const MAX_RECORD_ID_LENGTH = 160;
const MAX_PUBLIC_TEXT_LENGTH = 240;
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const RETAINED_SIGNAL_STALE_MS = 15 * 60 * 1000;
const BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
const MAX_APPROVAL_EFFECTS = 40;
const MAX_DURABLE_RUN_SCAN = 500;
const MAX_REALTIME_EVENTS = 200;
const MAX_APPROVALS = 12;
const MAX_MESH_NODES = 200;
const MAX_MESH_LEASES = 200;
const MAX_EXTERNAL_SIDE_EFFECTS = 50;
const MAX_BACKUP_ISSUE_CODES = 20;

export interface RuntimeAuthorityProjectionDependencies {
  now?: () => Date;
  listDurableRuns(limit: number): Promise<unknown[]>;
  countDurableRuns(): Promise<number>;
  listRunningDurableRuns(limit: number): Promise<{ items: unknown[]; total: number }>;
  resolveDurableRunWorkspaceId(run: unknown): Promise<string | undefined>;
  listRealtimeEvents(limit: number): Promise<unknown[]>;
  listApprovals(workspaceId: string, limit: number): Promise<unknown[]>;
  listApprovalEffects(
    approvalIds: string[],
    limitPerApproval: number,
  ): Promise<Array<{ approvalId: string; effects: unknown[]; total: number }>>;
  listMeshNodes(limit: number): Promise<unknown[]>;
  listMeshLeases(limit: number): Promise<unknown[]>;
  inspectLatestBackupTrust(): Promise<unknown>;
  getRuntimeIdentity(): unknown;
  getLocalRuntimeStatus(): unknown;
  getConfigGenerationHealth(): unknown;
  listExternalSideEffects(workspaceId: string, limit: number): Promise<unknown[]>;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; value: T };

type NormalizedDurableRun = {
  raw: unknown;
  runId: string;
  workflowKey: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
  leaseHeartbeatAt?: string;
};

export class RuntimeAuthorityProjectionService {
  private readonly now: () => Date;

  public constructor(private readonly deps: RuntimeAuthorityProjectionDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  public async getProjection(input: { workspaceId: string }): Promise<RuntimeAuthorityProjectionResponse> {
    const observedNow = this.now();
    const generatedAt = observedNow.toISOString();
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const workspaceScope = scopeForWorkspace(workspaceId);
    const citadelScope = { kind: "citadel" } as const;
    const items: RuntimeAuthorityItem[] = [];

    const runRead = await readArraySafelyAsync(
      () => this.deps.listDurableRuns(MAX_DURABLE_RUN_SCAN),
      MAX_DURABLE_RUN_SCAN,
    );
    const runCountRead = await readSafelyAsync(() => this.deps.countDurableRuns(), Number.NaN);
    const runCandidates = await Promise.all(
      runRead.value.map(async (raw) => ({
        raw,
        workspaceId: await this.resolveRunWorkspaceId(raw),
        normalized: normalizeDurableRun(raw),
      })),
    );
    const unscopedRunCount = runCandidates.filter((candidate) => candidate.workspaceId === undefined).length;
    const scopedRunCandidates = runCandidates.filter((candidate) => candidate.workspaceId === workspaceId);
    const duplicateRunIds = duplicateIds(
      scopedRunCandidates
        .map((candidate) => candidate.normalized?.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    const malformedRunCount =
      unscopedRunCount +
      scopedRunCandidates.filter(
        (candidate) => !candidate.normalized || duplicateRunIds.has(candidate.normalized.runId),
      ).length;
    const runs = scopedRunCandidates
      .map((candidate) => candidate.normalized)
      .filter((run): run is NormalizedDurableRun => run !== undefined && !duplicateRunIds.has(run.runId))
      .sort(compareDurableRuns)
      .slice(0, 5);
    const runCountIsValid = runCountRead.ok && Number.isSafeInteger(runCountRead.value) && runCountRead.value >= 0;
    const runWindowIncomplete =
      runs.length < 5 &&
      ((runCountIsValid && runCountRead.value > runRead.value.length) ||
        (!runCountIsValid && runRead.value.length >= MAX_DURABLE_RUN_SCAN));
    const realtimeRead = await readArraySafelyAsync(
      () => this.deps.listRealtimeEvents(MAX_REALTIME_EVENTS),
      MAX_REALTIME_EVENTS,
    );
    items.push(
      ...buildRunItems(
        runRead.ok,
        runs,
        realtimeRead,
        workspaceScope,
        observedNow,
        malformedRunCount,
        runWindowIncomplete,
      ),
    );

    const runningRead = await readRunningRunsSafelyAsync(
      () => this.deps.listRunningDurableRuns(MAX_DURABLE_RUN_SCAN),
      MAX_DURABLE_RUN_SCAN,
    );
    const runningCandidates = await Promise.all(
      runningRead.value.items.map(async (raw) => ({
        workspaceId: await this.resolveRunWorkspaceId(raw),
        normalized: normalizeDurableRun(raw),
      })),
    );
    const unscopedRunningCount = runningCandidates.filter((candidate) => candidate.workspaceId === undefined).length;
    const scopedRunningCandidates = runningCandidates.filter((candidate) => candidate.workspaceId === workspaceId);
    const duplicateRunningIds = duplicateIds(
      scopedRunningCandidates
        .map((candidate) => candidate.normalized?.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    const malformedRunningCount =
      unscopedRunningCount +
      scopedRunningCandidates.filter(
        (candidate) =>
          !candidate.normalized ||
          candidate.normalized.status !== "running" ||
          duplicateRunningIds.has(candidate.normalized.runId),
      ).length;
    const runningRuns = scopedRunningCandidates
      .map((candidate) => candidate.normalized)
      .filter(
        (run): run is NormalizedDurableRun =>
          run !== undefined && run.status === "running" && !duplicateRunningIds.has(run.runId),
      );
    const runningWindowIncomplete = runningRead.value.total > runningRead.value.items.length;
    items.push(
      ...buildWorkerItems(
        runningRead.ok,
        runningRuns,
        workspaceScope,
        observedNow,
        malformedRunningCount,
        runningWindowIncomplete,
      ),
    );

    const approvalRead = await readArraySafelyAsync(
      () => this.deps.listApprovals(workspaceId, MAX_APPROVALS),
      MAX_APPROVALS,
    );
    items.push(...(await this.buildApprovalItems(approvalRead, workspaceScope)));

    const meshNodes = await readArraySafelyAsync(() => this.deps.listMeshNodes(MAX_MESH_NODES), MAX_MESH_NODES);
    const meshLeases = await readArraySafelyAsync(() => this.deps.listMeshLeases(MAX_MESH_LEASES), MAX_MESH_LEASES);
    items.push(buildMeshWorkerItem(meshNodes, meshLeases, citadelScope, observedNow));
    const localRuntimeRead = readSafely(() => this.deps.getLocalRuntimeStatus(), undefined);
    items.push(buildLocalRuntimeItem(localRuntimeRead, citadelScope, observedNow));

    const backupRead = await readSafelyAsync(() => this.deps.inspectLatestBackupTrust(), undefined);
    items.push(buildBackupItem(backupRead, citadelScope, observedNow));

    const releaseRead = readSafely(() => this.deps.getRuntimeIdentity(), undefined);
    items.push(...buildReleaseItems(releaseRead, citadelScope, observedNow));

    const configRead = readSafely(() => this.deps.getConfigGenerationHealth(), undefined);
    items.push(...buildConfigItems(configRead, citadelScope, observedNow));

    const sideEffectRead = await readArraySafelyAsync(
      () => this.deps.listExternalSideEffects(workspaceId, MAX_EXTERNAL_SIDE_EFFECTS),
      MAX_EXTERNAL_SIDE_EFFECTS,
    );
    items.push(...buildManualReconciliationItems(sideEffectRead, workspaceScope));

    return {
      schemaVersion: 1,
      generatedAt,
      workspaceId,
      items: items.slice(0, MAX_ITEMS).map(boundAuthorityItem),
    };
  }

  private async resolveRunWorkspaceId(run: unknown): Promise<string | undefined> {
    try {
      return validWorkspaceId(await this.deps.resolveDurableRunWorkspaceId(run));
    } catch {
      return undefined;
    }
  }

  private async buildApprovalItems(
    read: ReadResult<unknown[]>,
    scope: RuntimeAuthorityScope,
  ): Promise<RuntimeAuthorityItem[]> {
    if (!read.ok) {
      return [
        unavailableItem({
          id: "approvals-unavailable",
          domain: "approvals",
          label: "Approval authority unavailable",
          owner: "ApprovalRepository + ApprovalEffectRepository",
          source: "canonical approval stores",
          state: "Gateway could not read canonical approval decision and follow-on effect records.",
          basis: "Approval decisions and settlement effects must be read from their durable repositories.",
          scope,
        }),
        approvalUiProjectionItem(0, scope, false),
      ];
    }

    const normalizedApprovals = read.value
      .map(normalizeApproval)
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const duplicateApprovalIds = duplicateIds(normalizedApprovals.map((item) => item.approvalId));
    const malformedApprovalCount =
      read.value.length -
      normalizedApprovals.length +
      normalizedApprovals.filter((item) => duplicateApprovalIds.has(item.approvalId)).length;
    const approvals = normalizedApprovals
      .filter((item) => !duplicateApprovalIds.has(item.approvalId))
      .filter((item) => belongsToWorkspace(item.workspaceId, scope.workspaceId))
      .sort(compareApprovals);
    if (approvals.length === 0) {
      return [
        unavailableItem({
          id: malformedApprovalCount > 0 ? "approvals-malformed" : "approvals-empty",
          domain: "approvals",
          label: malformedApprovalCount > 0 ? "Approval records malformed" : "No canonical approval record",
          owner: "ApprovalRepository + ApprovalEffectRepository",
          source: "canonical approval stores",
          state:
            malformedApprovalCount > 0
              ? "Canonical approval rows were malformed or contradictory and were not promoted into trusted status."
              : "No approval decision record is available in this workspace window.",
          basis:
            malformedApprovalCount > 0
              ? "Malformed or duplicate owner rows fail closed instead of being guessed into a decision."
              : "A missing approval row cannot be replaced by a notification, cache entry, or UI card.",
          scope,
        }),
        approvalUiProjectionItem(0, scope, true),
      ];
    }

    const visibleApprovals = approvals.slice(0, 5);
    const effectsRead = await readApprovalEffectBatchesSafelyAsync(() =>
      this.deps.listApprovalEffects(
        visibleApprovals.map((approval) => approval.approvalId),
        MAX_APPROVAL_EFFECTS,
      ),
    );
    const result: RuntimeAuthorityItem[] = [];
    for (const approval of visibleApprovals) {
      const effectBatch = effectsRead.value.get(approval.approvalId);
      const effects = (effectBatch?.effects ?? [])
        .map((effect) => normalizeApprovalEffect(effect, approval.approvalId))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const effectsComplete =
        effectsRead.ok &&
        Boolean(effectBatch) &&
        effectBatch!.total === effectBatch!.effects.length &&
        effectBatch!.effects.length <= MAX_APPROVAL_EFFECTS &&
        effects.length === effectBatch!.effects.length;
      const settlement = summarizeApprovalSettlement(approval.status, effects, effectsComplete);
      result.push({
        id: `approval:${approval.approvalId}`,
        domain: "approvals",
        label: `${publicText(approval.kind, 64, "Operator")} approval`,
        authorityClass: "canonical_record",
        owner: "ApprovalRepository + ApprovalEffectRepository",
        source: "approval decision and effect settlement rows",
        observedAt: latestIso([approval.resolvedAt, approval.createdAt, ...effects.map((effect) => effect.updatedAt)]),
        freshness: settlement.freshness,
        posture: settlement.posture,
        state: settlement.state,
        basis: "The approval row owns the decision; approval effect rows own whether follow-on work settled.",
        caveat:
          "Mission Control approval cards are derived materializations and cannot upgrade a pending or failed effect.",
        scope,
        canonicalRef: approvalReference(approval.approvalId),
      });
    }
    if (malformedApprovalCount > 0) {
      result.push(
        unavailableItem({
          id: "approvals-malformed",
          domain: "approvals",
          label: "Some approval records unavailable",
          owner: "ApprovalRepository + ApprovalEffectRepository",
          source: "canonical approval stores",
          state: "Malformed or duplicate approval rows were omitted from the trusted projection.",
          basis: "Only well-formed, uniquely identified owner rows may be labeled canonical.",
          scope,
        }),
      );
    }
    result.push(approvalUiProjectionItem(approvals.length, scope, true));
    return result;
  }
}

function buildRunItems(
  runReadOk: boolean,
  runs: NormalizedDurableRun[],
  realtimeRead: ReadResult<unknown[]>,
  scope: RuntimeAuthorityScope,
  now: Date,
  malformedRunCount: number,
  windowIncomplete: boolean,
): RuntimeAuthorityItem[] {
  if (!runReadOk || runs.length === 0) {
    const malformed = runReadOk && malformedRunCount > 0;
    const incomplete = runReadOk && !malformed && windowIncomplete;
    return [
      unavailableItem({
        id: !runReadOk
          ? "runs-unavailable"
          : malformed
            ? "runs-malformed"
            : incomplete
              ? "runs-window-incomplete"
              : "runs-empty",
        domain: "runs",
        label: !runReadOk
          ? "Run authority unavailable"
          : malformed
            ? "Run records malformed"
            : incomplete
              ? "Workspace run window incomplete"
              : "No canonical run record",
        owner: "DurableRunRepository",
        source: "durable run rows",
        state: !runReadOk
          ? "Gateway could not read canonical durable run state."
          : malformed
            ? "Durable run rows were malformed or contradictory and were not promoted into trusted status."
            : incomplete
              ? "The bounded global owner window ended before a workspace run could be established."
              : "No valid durable run record is available in this workspace window.",
        basis: malformed
          ? "Malformed or duplicate owner rows fail closed instead of being replaced by retained events."
          : incomplete
            ? "A capped cross-workspace scan cannot prove this workspace has no canonical run record."
            : "Durable run rows, not realtime events or UI joins, own execution state and terminal outcome.",
        scope,
      }),
    ];
  }

  const events = realtimeRead.value
    .map(normalizeRealtimeEvent)
    .filter((event): event is NonNullable<typeof event> => Boolean(event));
  const items: RuntimeAuthorityItem[] = [];
  for (const run of runs) {
    const terminal = isTerminalRunStatus(run.status);
    items.push({
      id: `run:${run.runId}`,
      domain: "runs",
      label: `${publicText(run.workflowKey, 64, "Durable")} run`,
      authorityClass: "canonical_record",
      owner: "DurableRunRepository",
      source: "durable_runs",
      observedAt: run.finishedAt ?? run.updatedAt ?? run.createdAt,
      freshness: "current",
      posture: runStatusPosture(run.status),
      state: terminal
        ? `Terminal outcome: ${labelRunStatus(run.status)}.`
        : `Execution state: ${labelRunStatus(run.status)}.`,
      basis: "The durable run repository owns resumable execution state and terminal outcome.",
      caveat: "A retained event may describe this run, but it does not overwrite the repository row.",
      scope,
      canonicalRef: runReference(run.runId),
    });

    const retained = latestLinkedEvent(events, run.runId);
    if (retained) {
      const expectedStatus = expectedRunStatusFromEvent(retained.eventType);
      const contradicts = expectedStatus ? !runStatusMatchesSignal(run.status, expectedStatus) : false;
      const stale = isOlderThan(retained.createdAt, now, RETAINED_SIGNAL_STALE_MS);
      items.push({
        id: `run-signal:${run.runId}`,
        domain: "runs",
        label: "Retained run signal",
        authorityClass: "retained_signal",
        owner: "RealtimeEventRepository",
        source: "retained operator stream",
        observedAt: retained.createdAt,
        freshness: contradicts ? "contradictory" : stale ? "stale" : "current",
        posture: contradicts ? "critical" : stale ? "attention" : "neutral",
        state: `Retained signal: ${labelEventType(retained.eventType)}.`,
        basis: "The event is retained for operator awareness and replay continuity, not canonical run history.",
        caveat: contradicts
          ? `The signal conflicts with the canonical ${labelRunStatus(run.status)} run state; the repository wins.`
          : "Agreement with the repository does not promote the retained signal to canonical truth.",
        scope,
        canonicalRef: runReference(run.runId),
      });
    }
  }
  if (malformedRunCount > 0) {
    items.push(
      unavailableItem({
        id: "runs-malformed",
        domain: "runs",
        label: "Some durable runs unavailable",
        owner: "DurableRunRepository",
        source: "durable run rows",
        state: "Malformed or duplicate durable run rows were omitted from the trusted projection.",
        basis: "Only well-formed, uniquely identified owner rows may be labeled canonical.",
        scope,
      }),
    );
  }
  if (windowIncomplete) {
    items.push(
      unavailableItem({
        id: "runs-window-incomplete",
        domain: "runs",
        label: "Workspace run window incomplete",
        owner: "DurableRunRepository",
        source: "bounded recent durable run window",
        state: "Fewer than five workspace runs were found before the bounded global owner window ended.",
        basis:
          "The projection preserves known canonical rows but does not claim that the workspace window is complete.",
        scope,
      }),
    );
  }
  if (!realtimeRead.ok) {
    items.push(
      unavailableItem({
        id: "run-signals-unavailable",
        domain: "runs",
        label: "Retained run signals unavailable",
        owner: "RealtimeEventRepository",
        source: "retained operator stream",
        state: "Gateway could not read retained run signals for this projection.",
        basis: "Signal loss does not change canonical durable run status, but it must remain visible as unavailable.",
        scope,
      }),
    );
  }
  return items;
}

function buildWorkerItems(
  readOk: boolean,
  runs: NormalizedDurableRun[],
  scope: RuntimeAuthorityScope,
  now: Date,
  malformedRunCount: number,
  windowIncomplete: boolean,
): RuntimeAuthorityItem[] {
  if (!readOk) {
    return [
      unavailableItem({
        id: "durable-workers-unavailable",
        domain: "workers",
        label: "Durable worker leases unavailable",
        owner: "DurableRunRepository",
        source: "running durable run lease fields",
        state: "Gateway could not read canonical running-run lease records.",
        basis: "Worker health cannot be inferred from recent terminal runs, retained events, or client activity.",
        scope,
      }),
    ];
  }
  const running = runs.filter((run) => run.status === "running").slice(0, 3);
  if (running.length === 0 && (malformedRunCount > 0 || windowIncomplete)) {
    return [
      unavailableItem({
        id: malformedRunCount > 0 ? "durable-workers-malformed" : "durable-workers-window-incomplete",
        domain: "workers",
        label: malformedRunCount > 0 ? "Durable worker lease records malformed" : "Durable worker window incomplete",
        owner: "DurableRunRepository",
        source: "running durable run lease fields",
        state:
          malformedRunCount > 0
            ? "Running-run rows were malformed or duplicated and were not projected as worker health."
            : "The bounded running-run owner window cannot establish that this workspace is idle.",
        basis:
          malformedRunCount > 0
            ? "Contradictory worker lease identity fails closed."
            : "A capped cross-workspace running-run scan cannot prove absence of an older workspace lease.",
        scope,
      }),
    ];
  }
  if (running.length === 0) {
    return [
      {
        id: "durable-worker-idle",
        domain: "workers",
        label: "Durable worker projection",
        authorityClass: "derived_projection",
        owner: "RuntimeAuthorityProjectionService",
        source: "durable run lease fields + Gateway clock",
        observedAt: now.toISOString(),
        freshness: "current",
        posture: "neutral",
        state: "No running durable run requires an active worker lease in this workspace window.",
        basis: "Worker health is derived by comparing canonical lease timestamps with the Gateway clock.",
        caveat: "This health calculation is not a new execution-state owner.",
        scope,
      },
    ];
  }

  const workerItems: RuntimeAuthorityItem[] = runs.map((run) => {
    const expiryMs = parseTimestamp(run.leaseExpiresAt);
    const heartbeatMs = parseTimestamp(run.leaseHeartbeatAt);
    const expired = expiryMs === undefined || expiryMs <= now.getTime();
    const staleHeartbeat = heartbeatMs === undefined || now.getTime() - heartbeatMs > HEARTBEAT_STALE_MS;
    const freshness: RuntimeAuthorityFreshness = expired || staleHeartbeat ? "stale" : "current";
    const posture: RuntimeAuthorityPosture = expired ? "critical" : staleHeartbeat ? "attention" : "ok";
    const state = expired
      ? "The recorded worker lease is missing or expired."
      : staleHeartbeat
        ? "The lease is live, but its heartbeat is stale or missing."
        : "The worker lease and heartbeat are current.";
    return {
      id: `worker:${run.runId}`,
      domain: "workers" as const,
      label: "Durable worker lease",
      authorityClass: "derived_projection" as const,
      owner: "RuntimeAuthorityProjectionService",
      source: "DurableRunRepository lease fields + Gateway clock",
      observedAt: now.toISOString(),
      freshness,
      posture,
      state,
      basis: "Lease expiry and heartbeat freshness are computed from canonical run fields at read time.",
      caveat: "Worker health is a projection; the durable run row remains the execution authority.",
      scope,
      canonicalRef: runReference(run.runId),
    };
  });
  workerItems.sort(
    (left, right) =>
      workerPostureRank(right.posture) - workerPostureRank(left.posture) || left.id.localeCompare(right.id),
  );
  const result = workerItems.slice(0, 3);
  if (runs.length > 3) {
    const critical = workerItems.filter((item) => item.posture === "critical").length;
    const attention = workerItems.filter((item) => item.posture === "attention").length;
    result.push({
      id: "durable-worker-summary",
      domain: "workers",
      label: "Additional durable worker leases",
      authorityClass: "derived_projection",
      owner: "RuntimeAuthorityProjectionService",
      source: "bounded running durable run lease set",
      observedAt: now.toISOString(),
      freshness: critical > 0 || attention > 0 ? "stale" : "current",
      posture: critical > 0 ? "critical" : attention > 0 ? "attention" : "ok",
      state: `${runs.length} running workspace run(s) were evaluated; ${critical} expired or missing lease(s) and ${attention} stale heartbeat(s) were found.`,
      basis: "The summary is computed over the bounded canonical running-run owner result.",
      caveat: "Only the three highest-risk individual leases are expanded as cards.",
      scope,
    });
  }
  if (malformedRunCount > 0 || windowIncomplete) {
    result.push(
      unavailableItem({
        id: malformedRunCount > 0 ? "durable-workers-malformed" : "durable-workers-window-incomplete",
        domain: "workers",
        label: malformedRunCount > 0 ? "Some durable worker leases unavailable" : "Durable worker window incomplete",
        owner: "DurableRunRepository",
        source: "running durable run lease fields",
        state:
          malformedRunCount > 0
            ? "Malformed or duplicate running-run rows were omitted from worker health."
            : "Additional running runs may exist beyond the bounded owner window.",
        basis: "Known lease projections remain visible, but the server does not claim the worker set is complete.",
        scope,
      }),
    );
  }
  return result;
}

function buildMeshWorkerItem(
  nodeRead: ReadResult<unknown[]>,
  leaseRead: ReadResult<unknown[]>,
  scope: RuntimeAuthorityScope,
  now: Date,
): RuntimeAuthorityItem {
  if (!nodeRead.ok || !leaseRead.ok) {
    return unavailableItem({
      id: "mesh-workers-unavailable",
      domain: "workers",
      label: "Mesh runtime owners unavailable",
      owner: "MeshRepository",
      source: "mesh node and lease rows",
      state: "Gateway could not read mesh node or lease records.",
      basis: "Remote owner health requires both canonical node observations and fenced lease records.",
      scope,
    });
  }
  if (nodeRead.value.length >= MAX_MESH_NODES || leaseRead.value.length >= MAX_MESH_LEASES) {
    return unavailableItem({
      id: "mesh-workers-window-incomplete",
      domain: "workers",
      label: "Mesh runtime owner window incomplete",
      owner: "MeshRepository",
      source: "bounded mesh node and lease rows",
      state:
        "The mesh node or lease owner window reached its read cap, so complete owner counts cannot be established.",
      basis:
        "A saturated owner window without an authoritative total cannot prove complete mesh ownership or lease health.",
      caveat: "Known rows are intentionally not summarized as a complete runtime-owner count.",
      scope,
      freshness: "unknown",
    });
  }
  const nodes = nodeRead.value.map(normalizeMeshNode).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const leases = leaseRead.value
    .map(normalizeMeshLease)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (
    nodes.length !== nodeRead.value.length ||
    leases.length !== leaseRead.value.length ||
    duplicateIds(nodes.map((node) => node.nodeId)).size > 0 ||
    duplicateIds(leases.map((lease) => lease.leaseKey)).size > 0
  ) {
    return unavailableItem({
      id: "mesh-workers-malformed",
      domain: "workers",
      label: "Mesh runtime owner records malformed",
      owner: "MeshRepository",
      source: "mesh node and lease rows",
      state: "Mesh node or lease rows were malformed or duplicated and were not projected as current ownership.",
      basis: "Remote ownership counts fail closed when canonical node or fenced lease identity is contradictory.",
      scope,
    });
  }
  if (nodes.length === 0 && leases.length === 0) {
    return unavailableItem({
      id: "mesh-workers-empty",
      domain: "workers",
      label: "No mesh runtime owner record",
      owner: "MeshRepository",
      source: "mesh node and lease rows",
      state: "No valid remote node heartbeat or fenced lease is available.",
      basis: "A remote runtime owner is not inferred from network presence or a client cache.",
      scope,
    });
  }

  const staleNodes = nodes.filter(
    (node) => node.status !== "online" || isOlderThan(node.lastSeenAt, now, HEARTBEAT_STALE_MS),
  ).length;
  const expiredLeases = leases.filter((lease) => {
    const expiry = parseTimestamp(lease.expiresAt);
    return expiry === undefined || expiry <= now.getTime();
  }).length;
  const currentNodes = Math.max(0, nodes.length - staleNodes);
  const activeLeases = Math.max(0, leases.length - expiredLeases);
  const hasStale = staleNodes > 0 || expiredLeases > 0;
  return {
    id: "mesh-workers",
    domain: "workers",
    label: "Mesh runtime owners",
    authorityClass: "derived_projection",
    owner: "RuntimeAuthorityProjectionService",
    source: "MeshRepository node heartbeats and fenced leases",
    observedAt: now.toISOString(),
    freshness: hasStale ? "stale" : "current",
    posture: hasStale ? "attention" : "ok",
    state: `${currentNodes} current node record(s), ${staleNodes} stale node record(s), ${activeLeases} active lease(s), ${expiredLeases} expired lease(s).`,
    basis: "Remote owner health is calculated from stored last-seen and lease-expiry timestamps.",
    caveat: "Network reachability and UI presence are not canonical ownership evidence.",
    scope,
  };
}

function buildLocalRuntimeItem(
  read: ReadResult<unknown>,
  scope: RuntimeAuthorityScope,
  now: Date,
): RuntimeAuthorityItem {
  const status = normalizeLocalRuntimeStatus(read.value);
  if (!read.ok || !status) {
    return unavailableItem({
      id: "local-runtime-unavailable",
      domain: "workers",
      label: "Local runtime lease health unavailable",
      owner: "LlamaCppRuntimeService",
      source: "local runtime status and lease lifecycle",
      state: "Gateway could not establish local runtime process and lease health.",
      basis:
        "Local health requires a well-formed runtime-owner snapshot; provider reachability or UI cache is insufficient.",
      scope,
    });
  }

  const stale = isOlderThan(status.updatedAt, now, HEARTBEAT_STALE_MS);
  const unhealthyActiveLease = status.activeLeaseCount > 0 && (!status.healthy || status.processState !== "running");
  const unhealthyRuntime =
    status.enabled &&
    (status.processState === "error" || (status.desiredState === "running" && status.processState === "stopped"));
  const posture: RuntimeAuthorityPosture =
    unhealthyActiveLease || unhealthyRuntime
      ? "critical"
      : stale
        ? "attention"
        : status.enabled && status.processState === "starting"
          ? "attention"
          : status.healthy
            ? "ok"
            : "neutral";
  const state = !status.enabled
    ? `Local runtime is disabled with ${status.activeLeaseCount} active lease(s).`
    : unhealthyActiveLease
      ? `${status.activeLeaseCount} active lease(s) exist while the local runtime is not healthy and running.`
      : `Local runtime is ${status.processState}, health is ${status.healthy ? "ready" : "not ready"}, and ${status.activeLeaseCount} lease(s) are active.`;
  return {
    id: "local-runtime-lease-health",
    domain: "workers",
    label: "Local runtime lease health",
    authorityClass: "derived_projection",
    owner: "RuntimeAuthorityProjectionService",
    source: "LlamaCppRuntimeService status and lease diagnostics",
    observedAt: status.updatedAt,
    freshness: stale ? "stale" : "current",
    posture,
    state,
    basis:
      "Gateway projects process health and lease counts from the local runtime owner without exposing command, path, PID, or endpoint data.",
    caveat: "Health and lease posture are read-time projections; they do not create or settle runtime leases.",
    scope,
  };
}

function buildBackupItem(read: ReadResult<unknown>, scope: RuntimeAuthorityScope, now: Date): RuntimeAuthorityItem {
  const inspection = normalizeBackupInspection(read.value);
  if (!read.ok || !inspection) {
    return unavailableItem({
      id: "backup-unavailable",
      domain: "backups",
      label: "Backup proof unavailable",
      owner: "BackupRetentionService",
      source: "published backup manifest and exact-byte verifier",
      state: read.ok
        ? "No published backup directory is available for verification."
        : "Gateway could not inspect the latest published backup.",
      basis: "Current filesystem presence alone is not backup proof; a manifest and payload verification are required.",
      scope,
    });
  }

  const stale = isOlderThan(inspection.createdAt, now, BACKUP_STALE_MS);
  const valid = inspection.verified && inspection.contractVerified;
  if (valid && !inspection.createdAt) {
    return unavailableItem({
      id: "backup-malformed",
      domain: "backups",
      label: "Backup proof malformed",
      owner: "BackupRetentionService",
      source: "published backup manifest and exact-byte verifier",
      state: "Backup verification claimed success without a valid manifest creation timestamp.",
      basis: "A contradictory verifier result cannot be promoted into current backup evidence.",
      scope,
      freshness: "contradictory",
    });
  }
  return {
    id: "backup-latest",
    domain: "backups",
    label: "Latest backup evidence",
    authorityClass: "canonical_record",
    owner: "BackupRetentionService",
    source: "published manifest + payload hash verification",
    observedAt: inspection.observedAt,
    freshness: valid ? (stale ? "stale" : "current") : "contradictory",
    posture: valid ? (stale ? "attention" : "ok") : "critical",
    state: valid
      ? `Manifest and payload verification passed${stale ? ", but the backup is stale" : ""}.`
      : `Backup verification failed with ${inspection.issueCount} bounded issue code(s).`,
    basis:
      "The published manifest records the backup set; exact-byte and contract verification tests the current payload.",
    caveat: valid
      ? "A verified backup is evidence for this artifact only, not a guarantee that a restore was performed."
      : "Filesystem presence must not be presented as a verified backup when hashes or contract coverage disagree.",
    scope,
  };
}

function buildReleaseItems(read: ReadResult<unknown>, scope: RuntimeAuthorityScope, now: Date): RuntimeAuthorityItem[] {
  const identity = asRecord(read.value);
  const release = asRecord(identity?.release);
  const certificateState = readString(release?.certificateState);
  const generatedAt = validIso(readString(release?.generatedAt));
  const verified = typeof release?.verified === "boolean" ? release.verified : undefined;
  const parsedCertificate = read.ok && certificateState === "parsed" && verified !== undefined && Boolean(generatedAt);
  const certificateItem: RuntimeAuthorityItem = parsedCertificate
    ? {
        id: "release-certificate",
        domain: "backups",
        label: "Release evidence certificate",
        authorityClass: "canonical_record",
        owner: "ReviewReadinessService",
        source: "release-certificate.json and bound proof artifacts",
        observedAt: generatedAt,
        freshness: verified === true ? "current" : "contradictory",
        posture: verified === true ? "ok" : "critical",
        state:
          verified === true
            ? "Certificate, required lanes, exact SHA, and bound release assets agree."
            : "A release certificate exists, but current identity or bound evidence does not verify.",
        basis: "The certificate and its bound artifacts are the durable release-evidence record.",
        caveat: "A development filesystem or diagnostics snapshot cannot upgrade failed release evidence.",
        scope,
        canonicalRef: { kind: "release_evidence", label: "Open release evidence" },
      }
    : unavailableItem({
        id: "release-certificate-unavailable",
        domain: "backups",
        label: "Release evidence unavailable",
        owner: "ReviewReadinessService",
        source: "release-certificate.json and bound proof artifacts",
        state:
          certificateState === "malformed"
            ? "The release certificate is malformed and cannot establish release trust."
            : certificateState === "parsed"
              ? "The parsed release certificate has malformed or incomplete trust metadata."
              : "No parsed release certificate is available to the running Gateway.",
        basis: "Build success or current filesystem state is not a substitute for bound release evidence.",
        scope,
        freshness: certificateState === "malformed" || certificateState === "parsed" ? "contradictory" : "missing",
      });

  const identitySource = readString(identity?.identitySource);
  const integrity = readString(identity?.integrity);
  const identityAvailable =
    read.ok &&
    ["git_checkout", "packaged_manifest"].includes(identitySource ?? "") &&
    ["clean", "modified", "unknown"].includes(integrity ?? "");
  const runtimeItem: RuntimeAuthorityItem = identityAvailable
    ? {
        id: "running-build-identity",
        domain: "backups",
        label: "Running build identity",
        authorityClass: "inferred",
        owner: "ReviewReadinessService",
        source: publicText(identitySource, 48, "runtime inspection"),
        observedAt: now.toISOString(),
        freshness: integrity === "unknown" ? "unknown" : "current",
        posture: integrity === "modified" ? "attention" : integrity === "unknown" ? "unavailable" : "neutral",
        state:
          integrity === "modified"
            ? "The running source identity has local modifications."
            : integrity === "clean"
              ? "The running identity inspection reports a clean source boundary."
              : "The running identity integrity could not be established.",
        basis: "This is a read-time inspection of the process and filesystem boundary.",
        caveat: "Runtime identity is inferred current-state evidence; release certification remains separate.",
        scope,
        canonicalRef: { kind: "release_evidence", label: "Open release evidence" },
      }
    : unavailableItem({
        id: "running-build-identity-unavailable",
        domain: "backups",
        label: "Running build identity unavailable",
        owner: "ReviewReadinessService",
        source: "runtime identity inspection",
        state: "The running Gateway identity could not be established.",
        basis: "An absent runtime inspection cannot be inferred from release labels or client state.",
        scope,
      });
  return [certificateItem, runtimeItem];
}

function buildConfigItems(read: ReadResult<unknown>, scope: RuntimeAuthorityScope, now: Date): RuntimeAuthorityItem[] {
  const health = asRecord(read.value);
  const revision = readFiniteNumber(health?.revision);
  const generationId = validRecordId(readString(health?.generationId));
  const transactionState = readString(health?.transactionState);
  const mirrorRepairPending = health?.mirrorRepairPending;
  const recovery = normalizeConfigRecovery(health?.lastRecovery);
  if (
    !read.ok ||
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    !generationId ||
    !["idle", "pending", "committed"].includes(transactionState ?? "") ||
    typeof mirrorRepairPending !== "boolean" ||
    !recovery
  ) {
    return [
      unavailableItem({
        id: "config-generation-unavailable",
        domain: "reconciliation",
        label: "Config generation authority unavailable",
        owner: "ConfigGenerationService",
        source: "active unified config generation",
        state: "Gateway could not establish the canonical config generation.",
        basis:
          "Runtime-owner projections cannot become authoritative when the active generation is missing or malformed.",
        scope,
      }),
    ];
  }

  const ownerReconciliationPending = transactionState === "committed";
  const mutationPending = transactionState === "pending";
  const pending = ownerReconciliationPending || mutationPending || mirrorRepairPending;
  const recoveryNeedsAttention = recovery.recovered && recovery.outcome !== "confirmed_generation";
  return [
    {
      id: "config-generation",
      domain: "reconciliation",
      label: "Canonical config generation",
      authorityClass: "canonical_record",
      owner: "ConfigGenerationService",
      source: "active unified config generation",
      observedAt: now.toISOString(),
      freshness: "current",
      posture: "ok",
      state: `Revision ${Math.max(0, Math.trunc(revision))} is the active canonical generation.`,
      basis: "The generation metadata and digest own the committed configuration decision.",
      caveat: "Individual runtime owners are projections of this generation and may still require reconciliation.",
      scope,
    },
    {
      id: "config-owner-reconciliation",
      domain: "reconciliation",
      label: "Runtime-owner reconciliation",
      authorityClass: "derived_projection",
      owner: "ConfigGenerationService",
      source: "transaction marker + mirror repair posture",
      observedAt: now.toISOString(),
      freshness: "current",
      posture: pending ? "attention" : "ok",
      state: pending
        ? `${ownerReconciliationPending ? "Runtime-owner reconciliation is pending. " : ""}${mutationPending ? "A config transaction is pending. " : ""}${mirrorRepairPending ? "Mirror repair is pending." : ""}`.trim()
        : "Runtime owners and config mirrors report no pending reconciliation.",
      basis: "This status is projected from the durable generation transaction and mirror-repair state.",
      caveat: "Projection health cannot rewrite or roll back the committed canonical generation.",
      scope,
    },
    {
      id: "config-generation-recovery",
      domain: "reconciliation",
      label: "Config generation recovery",
      authorityClass: "derived_projection",
      owner: "ConfigGenerationService",
      source: "startup config generation recovery outcome",
      observedAt: now.toISOString(),
      freshness: "current",
      posture: recoveryNeedsAttention ? "attention" : "neutral",
      state: recovery.recovered
        ? `Startup recovery outcome: ${recovery.outcome.replaceAll("_", " ")}${recovery.revision === undefined ? "" : ` at revision ${recovery.revision}`}.`
        : `Startup recovery outcome: ${recovery.outcome.replaceAll("_", " ")}; no generation was recovered.`,
      basis: "The config owner reports the bounded startup recovery result for the active generation.",
      caveat: "Recovery evidence does not imply every runtime owner has completed reconciliation.",
      scope,
    },
  ];
}

function buildManualReconciliationItems(
  read: ReadResult<unknown[]>,
  scope: RuntimeAuthorityScope,
): RuntimeAuthorityItem[] {
  if (!read.ok) {
    return [
      unavailableItem({
        id: "manual-reconciliation-unavailable",
        domain: "reconciliation",
        label: "Manual reconciliation ledger unavailable",
        owner: "ExternalSideEffectRunRepository",
        source: "workspace-scoped external side-effect ledger",
        state: "Gateway could not inspect post-boundary outcome records for this workspace.",
        basis: "Unknown external outcomes must remain durable and operator-visible until reconciled.",
        scope,
      }),
    ];
  }
  const normalizedRuns = read.value
    .map(normalizeExternalSideEffect)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const duplicateRunIds = duplicateIds(normalizedRuns.map((item) => item.runId));
  const malformedRunCount =
    read.value.length - normalizedRuns.length + normalizedRuns.filter((item) => duplicateRunIds.has(item.runId)).length;
  const windowIncomplete = read.value.length >= MAX_EXTERNAL_SIDE_EFFECTS;
  const validRuns = normalizedRuns
    .filter((item) => !duplicateRunIds.has(item.runId))
    .filter((item) => belongsToWorkspace(item.workspaceId, scope.workspaceId))
    .sort(compareExternalSideEffects);
  const unresolved = validRuns.filter(
    (item) =>
      item.status === "unknown_external_outcome" || item.resumeState === "manual_review_unknown_external_outcome",
  );
  if (unresolved.length === 0) {
    if (windowIncomplete) {
      return [
        unavailableItem({
          id: "manual-reconciliation-window-incomplete",
          domain: "reconciliation",
          label: "Manual reconciliation window incomplete",
          owner: "ExternalSideEffectRunRepository",
          source: "bounded workspace-scoped external side-effect ledger",
          state:
            "The external side-effect ledger reached its read cap, so the absence of an older unresolved outcome cannot be established.",
          basis:
            "A saturated recent window without an authoritative total must not be promoted into a clear reconciliation status.",
          caveat: malformedRunCount > 0 ? "The saturated window also contained malformed rows." : undefined,
          scope,
          freshness: "unknown",
        }),
      ];
    }
    if (malformedRunCount > 0) {
      return [
        unavailableItem({
          id: "manual-reconciliation-malformed",
          domain: "reconciliation",
          label: "Manual reconciliation rows malformed",
          owner: "ExternalSideEffectRunRepository",
          source: "workspace-scoped external side-effect ledger",
          state: "Recent ledger rows were malformed and were not promoted into trusted status.",
          basis: "Malformed legacy rows remain unavailable rather than being guessed into a safe outcome.",
          scope,
        }),
      ];
    }
    return [
      {
        id: "manual-reconciliation-clear",
        domain: "reconciliation",
        label: "Manual reconciliation status",
        authorityClass: "derived_projection",
        owner: "RuntimeAuthorityProjectionService",
        source: "workspace-scoped external side-effect ledger",
        observedAt: latestIso(validRuns.map((item) => item.updatedAt)),
        freshness: "current",
        posture: "ok",
        state: "No unresolved post-boundary outcome is present in the recent workspace ledger window.",
        basis: "The count is projected only from durable side-effect ledger rows in this workspace.",
        caveat:
          "This bounded recent window is not a substitute for retention policy or external provider confirmation.",
        scope,
      },
    ];
  }
  const result: RuntimeAuthorityItem[] = unresolved.slice(0, 3).map((item, index) => ({
    id: `manual-reconciliation:${index + 1}`,
    domain: "reconciliation" as const,
    label: "External side effect reconciliation",
    authorityClass: "canonical_record" as const,
    owner: "ExternalSideEffectRunRepository",
    source: "workspace-scoped external side-effect ledger",
    observedAt: item.updatedAt,
    freshness: "current" as const,
    posture: "critical" as const,
    state: "The external provider outcome is unknown; manual reconciliation is required.",
    basis: "The durable ledger records that automatic retry or rollback would be unsafe after the external boundary.",
    caveat: "A client success banner or provider guess cannot settle this record.",
    scope,
    canonicalRef: {
      kind: "external_side_effects" as const,
      label: "Open reconciliation ledger" as const,
    },
  }));
  if (malformedRunCount > 0) {
    result.push(
      unavailableItem({
        id: "manual-reconciliation-malformed",
        domain: "reconciliation",
        label: "Some reconciliation rows unavailable",
        owner: "ExternalSideEffectRunRepository",
        source: "workspace-scoped external side-effect ledger",
        state: "Malformed recent ledger rows were omitted from the trusted projection.",
        basis: "Unknown external outcomes may be displayed only from well-formed canonical ledger rows.",
        scope,
      }),
    );
  }
  if (windowIncomplete) {
    result.push(
      unavailableItem({
        id: "manual-reconciliation-window-incomplete",
        domain: "reconciliation",
        label: "Additional reconciliation rows unavailable",
        owner: "ExternalSideEffectRunRepository",
        source: "bounded workspace-scoped external side-effect ledger",
        state: "Known unresolved outcomes are shown, but the saturated ledger window may omit older rows.",
        basis:
          "A read cap preserves known canonical records without claiming the workspace reconciliation set is complete.",
        scope,
        freshness: "unknown",
      }),
    );
  }
  return result;
}

function approvalUiProjectionItem(
  count: number,
  scope: RuntimeAuthorityScope,
  sourceAvailable: boolean,
): RuntimeAuthorityItem {
  return {
    id: "approval-ui-materialization",
    domain: "approvals",
    label: "Approval UI materialization",
    authorityClass: sourceAvailable ? "derived_projection" : "unavailable",
    owner: "Mission Control",
    source: "approval queue presentation",
    freshness: sourceAvailable ? "current" : "missing",
    posture: sourceAvailable ? "neutral" : "unavailable",
    state: sourceAvailable
      ? `${count} canonical approval record(s) are available for client materialization.`
      : "The client cannot safely materialize approval settlement without canonical rows.",
    basis: "Mission Control formats Gateway records for operators; it does not own decisions or effect settlement.",
    caveat: "Client caches, realtime notices, and optimistic state remain non-canonical.",
    scope,
  };
}

function summarizeApprovalSettlement(
  approvalStatus: string,
  effects: Array<{ status: string; updatedAt?: string; manualReconciliation: boolean }>,
  effectsReadOk: boolean,
): { state: string; posture: RuntimeAuthorityPosture; freshness: RuntimeAuthorityFreshness } {
  if (!effectsReadOk) {
    return {
      state: `Decision ${labelApprovalStatus(approvalStatus)}; follow-on effect settlement is unavailable.`,
      posture: "unavailable",
      freshness: "missing",
    };
  }
  if (approvalStatus === "pending") {
    return {
      state: "Decision pending; no effect may be treated as settled.",
      posture: "attention",
      freshness: "current",
    };
  }
  if (effects.some((effect) => effect.manualReconciliation)) {
    return {
      state: `Decision ${labelApprovalStatus(approvalStatus)}; an effect requires manual reconciliation.`,
      posture: "critical",
      freshness: "current",
    };
  }
  if (effects.some((effect) => effect.status === "failed")) {
    return {
      state: `Decision ${labelApprovalStatus(approvalStatus)}; at least one follow-on effect failed.`,
      posture: "critical",
      freshness: "current",
    };
  }
  if (effects.some((effect) => effect.status === "pending" || effect.status === "running")) {
    return {
      state: `Decision ${labelApprovalStatus(approvalStatus)}; follow-on effect settlement is pending.`,
      posture: "attention",
      freshness: "current",
    };
  }
  if (effects.length === 0) {
    return {
      state: `Decision ${labelApprovalStatus(approvalStatus)}; no follow-on effect row is registered.`,
      posture: "neutral",
      freshness: "current",
    };
  }
  return {
    state: `Decision ${labelApprovalStatus(approvalStatus)}; all recorded follow-on effects settled.`,
    posture: "ok",
    freshness: "current",
  };
}

function normalizeDurableRun(value: unknown): NormalizedDurableRun | undefined {
  const record = asRecord(value);
  const runId = validRecordId(readString(record?.runId));
  const status = readString(record?.status);
  const createdAt = validIso(readString(record?.createdAt));
  const updatedAt = validIso(readString(record?.updatedAt));
  if (!record || !runId || !isKnownRunStatus(status) || !createdAt || !updatedAt) return undefined;
  return {
    raw: value,
    runId,
    workflowKey: publicText(readString(record.workflowKey), 64, "Durable"),
    status,
    createdAt,
    updatedAt,
    finishedAt: validIso(readString(record.finishedAt)),
    leaseExpiresAt: validIso(readString(record.leaseExpiresAt)),
    leaseHeartbeatAt: validIso(readString(record.leaseHeartbeatAt)),
  };
}

function normalizeRealtimeEvent(value: unknown) {
  const record = asRecord(value);
  const eventAuthority = readString(record?.eventAuthority);
  if (eventAuthority !== "retained_stream") return undefined;
  const payload = asRecord(record?.payload);
  const eventType = normalizeOptionalText(readString(payload?.type) ?? readString(record?.eventType), 96);
  const createdAt = validIso(readString(record?.timestamp) ?? readString(record?.createdAt));
  const links = asRecord(record?.links);
  const runId = validRecordId(readString(links?.runId));
  if (!eventType || !createdAt || !runId) return undefined;
  return { eventType, createdAt, runId };
}

function normalizeApproval(value: unknown) {
  const record = asRecord(value);
  const approvalId = validRecordId(readString(record?.approvalId));
  const status = readString(record?.status);
  const workspaceId = validWorkspaceId(readString(asRecord(record?.linkage)?.workspaceId));
  const createdAt = validIso(readString(record?.createdAt));
  const resolvedAt = validIso(readString(record?.resolvedAt));
  if (
    !approvalId ||
    !workspaceId ||
    !createdAt ||
    !["pending", "approved", "rejected", "edited"].includes(status ?? "") ||
    (status !== "pending" && !resolvedAt)
  ) {
    return undefined;
  }
  return {
    approvalId,
    status: status!,
    kind: publicText(readString(record?.kind), 64, "Operator"),
    workspaceId,
    createdAt,
    resolvedAt,
  };
}

function normalizeApprovalEffect(value: unknown, expectedApprovalId: string) {
  const record = asRecord(value);
  const effectId = validRecordId(readString(record?.effectId));
  const approvalId = validRecordId(readString(record?.approvalId));
  const status = readString(record?.status);
  if (
    !effectId ||
    approvalId !== expectedApprovalId ||
    !status ||
    !["pending", "running", "completed", "skipped", "failed"].includes(status)
  ) {
    return undefined;
  }
  const result = asRecord(record?.result);
  const payload = asRecord(record?.payload);
  const updatedAt = validIso(readString(record?.updatedAt));
  if (!updatedAt) return undefined;
  return {
    effectId,
    status,
    updatedAt,
    manualReconciliation: recordContainsManualReconciliation(result) || recordContainsManualReconciliation(payload),
  };
}

function normalizeMeshNode(value: unknown) {
  const record = asRecord(value);
  const nodeId = validRecordId(readString(record?.nodeId));
  const status = readString(record?.status);
  const lastSeenAt = validIso(readString(record?.lastSeenAt));
  if (!nodeId || !status || !["online", "suspect", "offline"].includes(status) || !lastSeenAt) return undefined;
  return { nodeId, status, lastSeenAt };
}

function normalizeMeshLease(value: unknown) {
  const record = asRecord(value);
  const leaseKey = validRecordId(readString(record?.leaseKey));
  const holderNodeId = validRecordId(readString(record?.holderNodeId));
  const fencingToken = readFiniteNumber(record?.fencingToken);
  const expiresAt = validIso(readString(record?.expiresAt));
  const updatedAt = validIso(readString(record?.updatedAt));
  return leaseKey &&
    holderNodeId &&
    typeof fencingToken === "number" &&
    Number.isInteger(fencingToken) &&
    fencingToken >= 1 &&
    expiresAt &&
    updatedAt
    ? { leaseKey, holderNodeId, fencingToken, expiresAt, updatedAt }
    : undefined;
}

function normalizeLocalRuntimeStatus(value: unknown) {
  const record = asRecord(value);
  const desiredState = readString(record?.desiredState);
  const processState = readString(record?.processState);
  const updatedAt = validIso(readString(record?.updatedAt));
  const leaseDiagnostics = asRecord(record?.leaseDiagnostics);
  const leaseState = readString(leaseDiagnostics?.state);
  const ownership = readString(leaseDiagnostics?.ownership);
  const activeLeaseCount = readFiniteNumber(leaseDiagnostics?.activeLeaseCount);
  if (
    typeof record?.enabled !== "boolean" ||
    typeof record.healthy !== "boolean" ||
    !["stopped", "running"].includes(desiredState ?? "") ||
    !["stopped", "starting", "running", "error"].includes(processState ?? "") ||
    !updatedAt ||
    !["idle", "starting", "active", "idle_pending", "persistent", "closed"].includes(leaseState ?? "") ||
    !["none", "owned", "external"].includes(ownership ?? "") ||
    typeof activeLeaseCount !== "number" ||
    !Number.isInteger(activeLeaseCount) ||
    activeLeaseCount < 0 ||
    activeLeaseCount > 10_000
  ) {
    return undefined;
  }
  return {
    enabled: record.enabled,
    healthy: record.healthy,
    desiredState: desiredState as "stopped" | "running",
    processState: processState as "stopped" | "starting" | "running" | "error",
    updatedAt,
    leaseState,
    ownership,
    activeLeaseCount,
  };
}

function normalizeConfigRecovery(value: unknown) {
  const record = asRecord(value);
  const outcome = readString(record?.outcome);
  const revision = record?.revision === undefined ? undefined : readFiniteNumber(record.revision);
  if (
    !record ||
    typeof record.recovered !== "boolean" ||
    ![
      "not_checked",
      "no_config",
      "not_needed",
      "confirmed_generation",
      "recovered_unconfirmed",
      "recovered_invalid_active",
    ].includes(outcome ?? "") ||
    (record.revision !== undefined && revision === undefined) ||
    (revision !== undefined && (!Number.isInteger(revision) || revision < 0))
  ) {
    return undefined;
  }
  return { outcome: outcome!, recovered: record.recovered, revision };
}

function normalizeBackupInspection(value: unknown) {
  const record = asRecord(value);
  const observedAt = validIso(readString(record?.observedAt));
  if (
    !record ||
    !observedAt ||
    typeof record.verified !== "boolean" ||
    typeof record.contractVerified !== "boolean" ||
    !Array.isArray(record.issueCodes) ||
    record.issueCodes.length > MAX_BACKUP_ISSUE_CODES ||
    !record.issueCodes.every((item) => typeof item === "string" && item.length <= 80)
  ) {
    return undefined;
  }
  return {
    observedAt,
    createdAt: validIso(readString(record.createdAt)),
    verified: record.verified,
    contractVerified: record.contractVerified,
    issueCount: record.issueCodes.length,
  };
}

function normalizeExternalSideEffect(value: unknown) {
  const record = asRecord(value);
  const runId = validRecordId(readString(record?.runId));
  const status = readString(record?.status);
  const resumeState = readString(record?.resumeState);
  const updatedAt = validIso(readString(record?.updatedAt));
  if (
    !runId ||
    !status ||
    ![
      "claimed_not_sent",
      "external_call_started",
      "completed",
      "failed_before_boundary",
      "unknown_external_outcome",
      "blocked_duplicate",
      "payload_mismatch",
      "idempotency_unavailable",
    ].includes(status) ||
    !resumeState ||
    ![
      "not_resumable",
      "completed",
      "manual_retry_after_recorded_failure",
      "manual_review_unknown_external_outcome",
      "in_progress",
      "payload_mismatch",
      "idempotency_unavailable",
    ].includes(resumeState) ||
    !updatedAt
  ) {
    return undefined;
  }
  return {
    runId,
    status,
    resumeState,
    updatedAt,
    workspaceId: validWorkspaceId(readString(record?.workspaceId)),
  };
}

function belongsToWorkspace(recordWorkspaceId: string | undefined, requestedWorkspaceId: string | undefined): boolean {
  return Boolean(recordWorkspaceId && requestedWorkspaceId && recordWorkspaceId === requestedWorkspaceId);
}

function latestLinkedEvent(events: Array<{ runId: string; eventType: string; createdAt: string }>, runId: string) {
  return events
    .filter((event) => event.runId === runId)
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.eventType.localeCompare(right.eventType),
    )[0];
}

function expectedRunStatusFromEvent(eventType: string): string | undefined {
  switch (eventType.toLowerCase()) {
    case "durable_run_completed":
      return "completed";
    case "durable_run_failed":
    case "durable_run_dead_lettered":
      return "failed";
    case "durable_run_cancelled":
      return "cancelled";
    case "durable_run_waiting":
      return "waiting";
    case "durable_run_started":
    case "durable_run_resumed":
      return "running";
    case "durable_run_queued":
    case "durable_run_created":
      return "queued";
    default:
      return undefined;
  }
}

function runStatusMatchesSignal(actual: string, expected: string): boolean {
  if (expected === "failed") return actual === "failed" || actual === "dead_lettered";
  return actual === expected;
}

function labelEventType(value: string): string {
  return publicText(value.replaceAll(/[._-]+/g, " "), 96, "runtime event").toLowerCase();
}

function labelRunStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function labelApprovalStatus(status: string): string {
  return status === "edited" ? "approved with edits" : status;
}

function runStatusPosture(status: string): RuntimeAuthorityPosture {
  if (["failed", "dead_lettered"].includes(status)) return "critical";
  if (["waiting", "paused", "cancelled"].includes(status)) return "attention";
  if (status === "completed") return "ok";
  return "neutral";
}

function isKnownRunStatus(value: string | undefined): value is string {
  return Boolean(
    value &&
    ["queued", "running", "waiting", "paused", "completed", "failed", "cancelled", "dead_lettered"].includes(value),
  );
}

function isTerminalRunStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "dead_lettered"].includes(status);
}

function recordContainsManualReconciliation(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: record, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 120) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    const currentRecord = asRecord(current.value);
    if (currentRecord) {
      for (const [key, value] of Object.entries(currentRecord).slice(0, 40)) {
        const normalizedKey = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
        if (normalizedKey === "manualreconciliationrequired" && value === true) return true;
        if (typeof value === "string" && isManualReconciliationMarker(value, key)) return true;
        if (current.depth < 4 && (Array.isArray(value) || asRecord(value))) {
          queue.push({ value, depth: current.depth + 1 });
        }
      }
      continue;
    }
    if (Array.isArray(current.value) && current.depth < 4) {
      for (const value of current.value.slice(0, 20)) {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function isManualReconciliationMarker(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    [
      "manual_reconciliation",
      "manual_reconciliation_required",
      "manual_review_unknown_external_outcome",
      "unknown_after_send",
      "unknown_external_outcome",
    ].includes(normalized)
  ) {
    return true;
  }
  return /manual[_ -]?reconciliation/i.test(`${key}:${value}`.slice(0, MAX_PUBLIC_TEXT_LENGTH));
}

function unavailableItem(
  input: Omit<RuntimeAuthorityItem, "authorityClass" | "freshness" | "posture"> & {
    freshness?: RuntimeAuthorityFreshness;
  },
): RuntimeAuthorityItem {
  return {
    ...input,
    authorityClass: "unavailable",
    freshness: input.freshness ?? "missing",
    posture: "unavailable",
  };
}

function runReference(runId: string): RuntimeAuthorityReference | undefined {
  return validRecordId(runId) ? { kind: "durable_run", label: "Open run detail", runId } : undefined;
}

function approvalReference(approvalId: string): RuntimeAuthorityReference | undefined {
  return validRecordId(approvalId) ? { kind: "approval", label: "Open approval detail", approvalId } : undefined;
}

function boundAuthorityItem(item: RuntimeAuthorityItem): RuntimeAuthorityItem {
  return {
    ...item,
    id: publicText(item.id, MAX_RECORD_ID_LENGTH, "authority-item"),
    label: publicText(item.label, 96, "Runtime authority"),
    owner: publicText(item.owner, 96, "Gateway"),
    source: publicText(item.source, 120, "runtime source"),
    state: publicText(item.state, MAX_PUBLIC_TEXT_LENGTH, "State unavailable."),
    basis: publicText(item.basis, MAX_PUBLIC_TEXT_LENGTH, "Authority basis unavailable."),
    caveat: publicOptionalText(item.caveat, MAX_PUBLIC_TEXT_LENGTH),
    observedAt: validIso(item.observedAt),
  };
}

function readSafely<T>(read: () => T, fallback: T): ReadResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, value: fallback };
  }
}

function readApprovalEffectBatchesSafely(
  read: () => unknown,
): ReadResult<Map<string, { effects: unknown[]; total: number }>> {
  const fallback = new Map<string, { effects: unknown[]; total: number }>();
  try {
    const value = read();
    if (!Array.isArray(value) || value.length > 20) return { ok: false, value: fallback };
    const batches = new Map<string, { effects: unknown[]; total: number }>();
    const seenEffectIds = new Set<string>();
    for (const candidate of value) {
      const record = asRecord(candidate);
      const approvalId = validRecordId(readString(record?.approvalId));
      const total = readFiniteNumber(record?.total);
      if (
        !record ||
        !approvalId ||
        batches.has(approvalId) ||
        !Array.isArray(record.effects) ||
        record.effects.length > MAX_APPROVAL_EFFECTS ||
        typeof total !== "number" ||
        !Number.isInteger(total) ||
        total < record.effects.length ||
        total > 1_000_000
      ) {
        return { ok: false, value: fallback };
      }
      for (const effectCandidate of record.effects) {
        const effect = asRecord(effectCandidate);
        const effectId = validRecordId(readString(effect?.effectId));
        const effectApprovalId = validRecordId(readString(effect?.approvalId));
        if (!effectId || effectApprovalId !== approvalId || seenEffectIds.has(effectId)) {
          return { ok: false, value: fallback };
        }
        seenEffectIds.add(effectId);
      }
      batches.set(approvalId, { effects: record.effects, total });
    }
    return { ok: true, value: batches };
  } catch {
    return { ok: false, value: fallback };
  }
}

function readRunningRunsSafely(read: () => unknown, maxItems: number): ReadResult<{ items: unknown[]; total: number }> {
  try {
    const record = asRecord(read());
    const total = readFiniteNumber(record?.total);
    if (
      !record ||
      !Array.isArray(record.items) ||
      record.items.length > maxItems ||
      typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      total < record.items.length
    ) {
      return { ok: false, value: { items: [], total: 0 } };
    }
    return { ok: true, value: { items: record.items, total } };
  } catch {
    return { ok: false, value: { items: [], total: 0 } };
  }
}

async function readSafelyAsync<T>(read: () => Promise<T>, fallback: T): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false, value: fallback };
  }
}

async function readArraySafelyAsync(read: () => Promise<unknown>, maxLength: number): Promise<ReadResult<unknown[]>> {
  const result = await readSafelyAsync(read, undefined);
  return result.ok && Array.isArray(result.value) && result.value.length <= maxLength
    ? { ok: true, value: result.value }
    : { ok: false, value: [] };
}

async function readRunningRunsSafelyAsync(
  read: () => Promise<unknown>,
  maxItems: number,
): Promise<ReadResult<{ items: unknown[]; total: number }>> {
  const result = await readSafelyAsync(read, undefined);
  return result.ok
    ? readRunningRunsSafely(() => result.value, maxItems)
    : { ok: false, value: { items: [], total: 0 } };
}

async function readApprovalEffectBatchesSafelyAsync(
  read: () => Promise<unknown>,
): Promise<ReadResult<Map<string, { effects: unknown[]; total: number }>>> {
  const result = await readSafelyAsync(read, undefined);
  return result.ok
    ? readApprovalEffectBatchesSafely(() => result.value)
    : { ok: false, value: new Map<string, { effects: unknown[]; total: number }>() };
}

function scopeForWorkspace(workspaceId: string): RuntimeAuthorityScope {
  return { kind: "workspace", workspaceId };
}

function normalizeWorkspaceId(value: string): string {
  const normalized = validWorkspaceId(value);
  if (!normalized) {
    throw new Error("Runtime authority requires a valid workspace scope.");
  }
  return normalized;
}

function validWorkspaceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-zA-Z0-9._-]{1,80}$/.test(normalized) ? normalized : undefined;
}

function publicText(value: unknown, maxLength: number, fallback: string): string {
  return publicOptionalText(value, maxLength) ?? fallback;
}

function publicOptionalText(value: unknown, maxLength: number): string | undefined {
  const normalized = normalizeOptionalText(value, Math.max(maxLength * 4, maxLength));
  if (!normalized) return undefined;
  return normalizeOptionalText(redactSecretText(normalized).value, maxLength);
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = replaceAsciiControlCharacters(value).replaceAll(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function replaceAsciiControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
  }).join("");
}

function validRecordId(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value, MAX_RECORD_ID_LENGTH);
  if (!normalized || normalized.length > MAX_RECORD_ID_LENGTH || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function validIso(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : undefined;
}

function latestIso(values: Array<string | undefined>): string | undefined {
  const valid = values.filter((value): value is string => Boolean(validIso(value)));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left) || left.localeCompare(right))[0];
}

function parseTimestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isOlderThan(value: string | undefined, now: Date, thresholdMs: number): boolean {
  const parsed = parseTimestamp(value);
  return parsed === undefined || now.getTime() - parsed > thresholdMs;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function duplicateIds(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function compareDurableRuns(left: NormalizedDurableRun, right: NormalizedDurableRun): number {
  return (
    Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? "") ||
    left.runId.localeCompare(right.runId)
  );
}

function compareApprovals(
  left: { approvalId: string; createdAt?: string; resolvedAt?: string },
  right: { approvalId: string; createdAt?: string; resolvedAt?: string },
): number {
  return (
    Date.parse(right.resolvedAt ?? right.createdAt ?? "") - Date.parse(left.resolvedAt ?? left.createdAt ?? "") ||
    left.approvalId.localeCompare(right.approvalId)
  );
}

function compareExternalSideEffects(
  left: { runId: string; updatedAt: string },
  right: { runId: string; updatedAt: string },
): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.runId.localeCompare(right.runId);
}

function workerPostureRank(posture: RuntimeAuthorityPosture): number {
  if (posture === "critical") return 3;
  if (posture === "attention") return 2;
  if (posture === "ok") return 1;
  return 0;
}
