export type MeshTransport = "lan" | "wan" | "tailnet";
export type MeshNodeStatus = "online" | "suspect" | "offline";

export interface MeshNodeRecord {
  nodeId: string;
  label?: string;
  advertiseAddress?: string;
  transport: MeshTransport;
  status: MeshNodeStatus;
  capabilities: string[];
  tlsFingerprint?: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface MeshLeaseRecord {
  leaseKey: string;
  holderNodeId: string;
  fencingToken: number;
  expiresAt: string;
  updatedAt: string;
}

export interface MeshSessionOwnerRecord {
  sessionId: string;
  ownerNodeId: string;
  epoch: number;
  claimedAt: string;
  updatedAt: string;
}

export interface MeshReplicationRecord {
  replicationId: string;
  sourceNodeId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
}

export interface MeshReplicationOffset {
  consumerNodeId: string;
  sourceNodeId: string;
  lastReplicationId?: string;
  updatedAt: string;
}

export interface MeshStatus {
  enabled: boolean;
  mode: MeshTransport;
  localNodeId: string;
  tailnetEnabled: boolean;
  nodesOnline: number;
  activeLeases: number;
  ownedSessions: number;
}

export type MeshReadinessStatus = "ready" | "blocked" | "not_enabled";

export interface MeshReadinessCheck {
  key:
    | "local_node"
    | "join_token_lifecycle"
    | "mtls_tailnet_posture"
    | "lease_lifecycle"
    | "session_owner_failover"
    | "replication_offsets"
    | "gateway_route_visibility"
    | "settings_visibility";
  status: "pass" | "warn" | "fail";
  message: string;
  evidence?: Record<string, unknown>;
}

export interface MeshReadinessDiagnostics {
  generatedAt: string;
  status: MeshReadinessStatus;
  statusSnapshot: MeshStatus;
  checks: MeshReadinessCheck[];
  blockers: string[];
  evidenceLane: "verify:mesh:readiness";
}

export interface MeshJoinRequest {
  token: string;
  nodeId: string;
  label?: string;
  advertiseAddress?: string;
  transport?: MeshTransport;
  capabilities?: string[];
  tlsFingerprint?: string;
}

export interface MeshJoinResult {
  accepted: boolean;
  node: MeshNodeRecord;
}

export interface MeshLeaseAcquireRequest {
  leaseKey: string;
  holderNodeId: string;
  ttlSeconds?: number;
}

export interface MeshLeaseRenewRequest {
  leaseKey: string;
  holderNodeId: string;
  fencingToken: number;
  ttlSeconds?: number;
}

export interface MeshLeaseReleaseRequest {
  leaseKey: string;
  holderNodeId: string;
  fencingToken: number;
}

export interface MeshSessionClaimRequest {
  ownerNodeId: string;
  expectedEpoch?: number;
  force?: boolean;
}

export interface MeshReplicationIngestRequest {
  sourceNodeId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}
