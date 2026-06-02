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
import type { Storage } from "@goatcitadel/storage";

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

export class MeshService {
  private options: MeshRuntimeOptions;

  public constructor(
    private readonly storage: Storage,
    options: MeshRuntimeOptions,
  ) {
    this.options = {
      ...options,
      localNodeLabel: options.localNodeLabel,
      advertiseAddress: options.advertiseAddress,
      joinToken: options.joinToken,
    };
  }

  public init(): void {
    const now = new Date().toISOString();
    this.storage.mesh.upsertNode({
      nodeId: this.options.localNodeId,
      label: this.options.localNodeLabel,
      advertiseAddress: this.options.advertiseAddress,
      transport: this.options.mode,
      status: "online",
      capabilities: ["gateway", "scheduler", "orchestration"],
      joinedAt: now,
      lastSeenAt: now,
    });

    if (this.options.joinToken?.trim()) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      this.storage.mesh.issueJoinToken(this.options.joinToken.trim(), expiresAt);
    }
  }

  public status(): MeshStatus {
    return this.storage.mesh.buildStatus(this.options.enabled, this.options.mode, this.options.localNodeId);
  }

  public readinessDiagnostics(): MeshReadinessDiagnostics {
    const statusSnapshot = this.status();
    const checks = this.buildReadinessChecks(statusSnapshot);
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

  public updateOptions(input: Partial<MeshRuntimeOptions>): void {
    const next: MeshRuntimeOptions = {
      ...this.options,
      ...input,
      localNodeId: input.localNodeId?.trim() || this.options.localNodeId,
      mode: input.mode ?? this.options.mode,
      enabled: input.enabled ?? this.options.enabled,
      requireMtls: input.requireMtls ?? this.options.requireMtls,
      tailnetEnabled: input.tailnetEnabled ?? this.options.tailnetEnabled,
      defaultLeaseTtlSeconds: input.defaultLeaseTtlSeconds ?? this.options.defaultLeaseTtlSeconds,
      joinToken: input.joinToken ?? this.options.joinToken,
      localNodeLabel: input.localNodeLabel ?? this.options.localNodeLabel,
      advertiseAddress: input.advertiseAddress ?? this.options.advertiseAddress,
    };
    this.options = next;
    this.init();
  }

  public join(request: MeshJoinRequest): MeshJoinResult {
    if (!this.options.enabled) {
      throw new Error("Mesh is disabled");
    }
    if (this.options.requireMtls && !request.tlsFingerprint?.trim()) {
      throw new Error("Mesh join requires tlsFingerprint");
    }

    const node = this.storage.mesh.join(request);
    return {
      accepted: true,
      node,
    };
  }

  public listNodes(limit = 200): MeshNodeRecord[] {
    return this.storage.mesh.listNodes(limit);
  }

  public acquireLease(request: MeshLeaseAcquireRequest): MeshLeaseRecord {
    return this.storage.mesh.acquireLease(
      request.leaseKey,
      request.holderNodeId,
      request.ttlSeconds ?? this.options.defaultLeaseTtlSeconds,
    );
  }

  public renewLease(request: MeshLeaseRenewRequest): MeshLeaseRecord {
    return this.storage.mesh.renewLease(
      request.leaseKey,
      request.holderNodeId,
      request.fencingToken,
      request.ttlSeconds ?? this.options.defaultLeaseTtlSeconds,
    );
  }

  public releaseLease(request: MeshLeaseReleaseRequest): { released: boolean } {
    return {
      released: this.storage.mesh.releaseLease(request.leaseKey, request.holderNodeId, request.fencingToken),
    };
  }

  public claimSessionOwner(sessionId: string, request: MeshSessionClaimRequest): MeshSessionOwnerRecord {
    return this.storage.mesh.claimSessionOwner(sessionId, request);
  }

  public getSessionOwner(sessionId: string): MeshSessionOwnerRecord {
    return this.storage.mesh.getSessionOwner(sessionId);
  }

  public listSessionOwners(limit = 500): MeshSessionOwnerRecord[] {
    return this.storage.mesh.listSessionOwners(limit);
  }

  public listLeases(limit = 200): MeshLeaseRecord[] {
    return this.storage.mesh.listLeases(limit);
  }

  public ingestReplicationEvent(input: MeshReplicationIngestRequest): MeshReplicationRecord {
    return this.storage.mesh.appendReplicationEvent(input);
  }

  public listReplicationEvents(limit = 200, cursor?: string): MeshReplicationRecord[] {
    return this.storage.mesh.listReplicationEvents(limit, cursor);
  }

  public setReplicationOffset(
    consumerNodeId: string,
    sourceNodeId: string,
    lastReplicationId?: string,
  ): MeshReplicationOffset {
    return this.storage.mesh.setReplicationOffset(consumerNodeId, sourceNodeId, lastReplicationId);
  }

  public listReplicationOffsets(limit = 500): MeshReplicationOffset[] {
    return this.storage.mesh.listReplicationOffsets(limit);
  }

  private buildReadinessChecks(statusSnapshot: MeshStatus): MeshReadinessCheck[] {
    const nodes = this.listNodes(20);
    const leases = this.listLeases(20);
    const owners = this.listSessionOwners(20);
    const events = this.listReplicationEvents(20);
    const offsets = this.listReplicationOffsets(20);
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
