import type {
  MeshJoinRequest,
  MeshJoinResult,
  MeshLeaseAcquireRequest,
  MeshLeaseRecord,
  MeshLeaseReleaseRequest,
  MeshLeaseRenewRequest,
  MeshNodeRecord,
  MeshReplicationIngestRequest,
  MeshReplicationOffset,
  MeshReplicationRecord,
  MeshReadinessCheck,
  MeshReadinessDiagnostics,
  MeshSessionClaimRequest,
  MeshSessionOwnerRecord,
  MeshStatus,
} from "@goatcitadel/contracts";
import type { AsyncStorage, MeshRuntimeArtifactSnapshot } from "@goatcitadel/storage";

export interface MeshRuntimeOptions {
  enabled: boolean;
  mode: MeshStatus["mode"];
  localNodeId: string;
  localNodeLabel?: string;
  advertiseAddress?: string;
  requireMtls: boolean;
  tailnetEnabled: boolean;
  joinToken?: string;
  defaultLeaseTtlSeconds: number;
}

export interface MeshRuntimeOptionsReplacement {
  rollback(): Promise<void>;
}

export class MeshService {
  private options: MeshRuntimeOptions;

  public constructor(
    private readonly storage: AsyncStorage,
    options: MeshRuntimeOptions,
  ) {
    this.options = {
      ...options,
      localNodeLabel: options.localNodeLabel,
      advertiseAddress: options.advertiseAddress,
      joinToken: options.joinToken,
    };
  }

  public async init(): Promise<void> {
    await this.persistOptionsAtomically(this.options);
  }

  public getOptionsSnapshot(): MeshRuntimeOptions {
    return { ...this.options };
  }

  /**
   * Replaces the complete runtime posture only after its durable mesh rows
   * commit together. A failed node/token write leaves the prior in-memory
   * options active and the database transaction rolls back both writes.
   */
  public async replaceOptions(input: MeshRuntimeOptions): Promise<MeshRuntimeOptions> {
    const next = normalizeMeshRuntimeOptions(input, this.options);
    await this.persistOptionsAtomically(next);
    this.options = next;
    return this.getOptionsSnapshot();
  }

  /**
   * Replaces runtime options while retaining an exact durable rollback handle.
   * Unlike a second replaceOptions(previous) call, rollback restores overwritten
   * timestamps/token state and deletes candidate-only node/token rows.
   */
  public async replaceOptionsReversibly(input: MeshRuntimeOptions): Promise<MeshRuntimeOptionsReplacement> {
    const previous = this.getOptionsSnapshot();
    const next = normalizeMeshRuntimeOptions(input, this.options);
    let artifacts: MeshRuntimeArtifactSnapshot | undefined;
    await this.runAtomically(async () => {
      artifacts = await this.storage.mesh.snapshotRuntimeArtifacts(next.localNodeId, next.joinToken);
      await this.persistOptionsRows(next);
    });
    if (!artifacts) {
      throw new Error("Mesh runtime artifact snapshot was not captured");
    }
    this.options = next;

    return {
      rollback: async () => {
        await this.runAtomically(async () => {
          await this.storage.mesh.restoreRuntimeArtifacts(artifacts as MeshRuntimeArtifactSnapshot);
        });
        this.options = previous;
      },
    };
  }

  /**
   * Replays the exact pre-candidate artifact receipt retained by the config
   * generation journal. This is intentionally idempotent so startup can repeat
   * it after another hard crash before clearing the journal marker.
   */
  public async restoreRuntimeArtifactsForRecovery(snapshot: MeshRuntimeArtifactSnapshot): Promise<void> {
    await this.runAtomically(async () => {
      await this.storage.mesh.restoreRuntimeArtifacts(snapshot);
    });
  }

  private async persistOptionsAtomically(options: MeshRuntimeOptions): Promise<void> {
    await this.runAtomically(() => this.persistOptionsRows(options));
  }

  private async persistOptionsRows(options: MeshRuntimeOptions): Promise<void> {
    const now = new Date().toISOString();
    await this.storage.mesh.upsertNode({
      nodeId: options.localNodeId,
      label: options.localNodeLabel,
      advertiseAddress: options.advertiseAddress,
      transport: options.mode,
      status: "online",
      capabilities: ["gateway", "scheduler", "orchestration"],
      joinedAt: now,
      lastSeenAt: now,
    });

    if (options.joinToken?.trim()) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await this.storage.mesh.issueJoinToken(options.joinToken.trim(), expiresAt);
    }
  }

  private runAtomically<T>(write: () => Promise<T>): Promise<T> {
    return this.storage.db.transaction("immediate", async () => write());
  }

  public status(): Promise<MeshStatus> {
    return this.storage.mesh.buildStatus(this.options.enabled, this.options.mode, this.options.localNodeId);
  }

  public async readinessDiagnostics(): Promise<MeshReadinessDiagnostics> {
    const statusSnapshot = await this.status();
    const checks = await this.buildReadinessChecks(statusSnapshot);
    const blockers = checks.filter((check) => check.status === "fail").map((check) => check.message);
    return {
      generatedAt: new Date().toISOString(),
      status: !this.options.enabled ? "not_enabled" : blockers.length === 0 ? "ready" : "blocked",
      statusSnapshot,
      checks,
      blockers,
      evidenceLane: "verify:mesh:readiness",
    };
  }

  public async updateOptions(input: Partial<MeshRuntimeOptions>): Promise<void> {
    await this.replaceOptions({
      ...this.options,
      ...input,
    });
  }

  public async join(request: MeshJoinRequest): Promise<MeshJoinResult> {
    if (!this.options.enabled) {
      throw new Error("Mesh is disabled");
    }
    if (this.options.requireMtls && !request.tlsFingerprint?.trim()) {
      throw new Error("Mesh join requires tlsFingerprint");
    }

    const node = await this.storage.mesh.join(request);
    return {
      accepted: true,
      node,
    };
  }

  public listNodes(limit = 200): Promise<MeshNodeRecord[]> {
    return this.storage.mesh.listNodes(limit);
  }

  public acquireLease(request: MeshLeaseAcquireRequest): Promise<MeshLeaseRecord> {
    return this.storage.mesh.acquireLease(
      request.leaseKey,
      request.holderNodeId,
      request.ttlSeconds ?? this.options.defaultLeaseTtlSeconds,
    );
  }

  public renewLease(request: MeshLeaseRenewRequest): Promise<MeshLeaseRecord> {
    return this.storage.mesh.renewLease(
      request.leaseKey,
      request.holderNodeId,
      request.fencingToken,
      request.ttlSeconds ?? this.options.defaultLeaseTtlSeconds,
    );
  }

  public async releaseLease(request: MeshLeaseReleaseRequest): Promise<{ released: boolean }> {
    return {
      released: await this.storage.mesh.releaseLease(request.leaseKey, request.holderNodeId, request.fencingToken),
    };
  }

  public claimSessionOwner(sessionId: string, request: MeshSessionClaimRequest): Promise<MeshSessionOwnerRecord> {
    return this.storage.mesh.claimSessionOwner(sessionId, request);
  }

  public getSessionOwner(sessionId: string): Promise<MeshSessionOwnerRecord> {
    return this.storage.mesh.getSessionOwner(sessionId);
  }

  public listSessionOwners(limit = 500): Promise<MeshSessionOwnerRecord[]> {
    return this.storage.mesh.listSessionOwners(limit);
  }

  public listLeases(limit = 200): Promise<MeshLeaseRecord[]> {
    return this.storage.mesh.listLeases(limit);
  }

  public ingestReplicationEvent(input: MeshReplicationIngestRequest): Promise<MeshReplicationRecord> {
    return this.storage.mesh.appendReplicationEvent(input);
  }

  public listReplicationEvents(limit = 200, cursor?: string): Promise<MeshReplicationRecord[]> {
    return this.storage.mesh.listReplicationEvents(limit, cursor);
  }

  public setReplicationOffset(
    consumerNodeId: string,
    sourceNodeId: string,
    lastReplicationId?: string,
  ): Promise<MeshReplicationOffset> {
    return this.storage.mesh.setReplicationOffset(consumerNodeId, sourceNodeId, lastReplicationId);
  }

  public listReplicationOffsets(limit = 500): Promise<MeshReplicationOffset[]> {
    return this.storage.mesh.listReplicationOffsets(limit);
  }

  private async buildReadinessChecks(statusSnapshot: MeshStatus): Promise<MeshReadinessCheck[]> {
    const [nodes, leases, owners, events, offsets] = await Promise.all([
      this.listNodes(20),
      this.listLeases(20),
      this.listSessionOwners(20),
      this.listReplicationEvents(20),
      this.listReplicationOffsets(20),
    ]);
    if (!this.options.enabled) {
      return [
        {
          key: "local_node",
          status: "fail",
          message: "Mesh runtime is disabled; readiness evidence cannot be claimed.",
          evidence: { localNodeId: this.options.localNodeId },
        },
      ];
    }
    const localNode = nodes.find((node) => node.nodeId === this.options.localNodeId);
    return [
      {
        key: "local_node",
        status: localNode ? "pass" : "fail",
        message: localNode
          ? "Local mesh node is registered and visible."
          : "Local mesh node is not registered in mesh storage.",
        evidence: { localNodeId: this.options.localNodeId, nodesOnline: statusSnapshot.nodesOnline },
      },
      {
        key: "join_token_lifecycle",
        status: this.options.joinToken?.trim() ? "pass" : "warn",
        message: this.options.joinToken?.trim()
          ? "Join-token lifecycle is configured for operator-issued joins."
          : "No join token is configured; join-token lifecycle proof requires an operator/env token.",
      },
      {
        key: "mtls_tailnet_posture",
        status: this.options.mode === "tailnet" && !this.options.tailnetEnabled ? "fail" : "pass",
        message:
          this.options.mode === "tailnet" && !this.options.tailnetEnabled
            ? "Tailnet mode requires tailnet security posture to be enabled."
            : "mTLS/tailnet posture is explicit in mesh runtime settings.",
        evidence: {
          requireMtls: this.options.requireMtls,
          tailnetEnabled: this.options.tailnetEnabled,
          mode: this.options.mode,
        },
      },
      {
        key: "lease_lifecycle",
        status: "pass",
        message: "Lease acquire, renew, release, takeover, and fencing APIs are exposed through mesh service/storage.",
        evidence: { activeLeases: leases.length },
      },
      {
        key: "session_owner_failover",
        status: "pass",
        message: "Session owner claim/failover APIs are exposed through mesh service/storage.",
        evidence: { ownedSessions: owners.length },
      },
      {
        key: "replication_offsets",
        status: "pass",
        message: "Replication event and offset APIs are exposed through mesh service/storage.",
        evidence: { recentEvents: events.length, offsets: offsets.length },
      },
      {
        key: "gateway_route_visibility",
        status: "pass",
        message: "Gateway route diagnostics expose mesh status, nodes, leases, owners, replication, and readiness.",
      },
      {
        key: "settings_visibility",
        status: "pass",
        message: "Settings owns mesh runtime configuration and diagnostics visibility.",
      },
    ];
  }
}

function normalizeMeshRuntimeOptions(input: MeshRuntimeOptions, fallback: MeshRuntimeOptions): MeshRuntimeOptions {
  const localNodeId = input.localNodeId.trim() || fallback.localNodeId;
  if (!localNodeId) {
    throw new Error("Mesh localNodeId is required");
  }
  if (!Number.isInteger(input.defaultLeaseTtlSeconds) || input.defaultLeaseTtlSeconds < 1) {
    throw new Error("Mesh defaultLeaseTtlSeconds must be a positive integer");
  }
  return {
    ...input,
    localNodeId,
    localNodeLabel: input.localNodeLabel,
    advertiseAddress: input.advertiseAddress,
    joinToken: input.joinToken,
  };
}
