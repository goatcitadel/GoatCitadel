import { createHash, randomUUID } from "node:crypto";
import type {
  A2ABridgeAgentCard,
  A2ABridgeGovernance,
  A2ABridgeRuntimeConfig,
  A2ABridgeStatus,
  A2ABridgeStatusResponse,
  A2APeerCredentialConfig,
  A2APeerCredentialHealth,
  A2ATaskExportPreviewRequest,
  A2ATaskExportPreviewResponse,
} from "@goatcitadel/contracts";

const A2A_BRIDGE_PROTOCOL_VERSION = "goatcitadel-a2a-boundary-1";
const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

export const DEFAULT_A2A_RUNTIME_CONFIG: A2ABridgeRuntimeConfig = {
  enabled: false,
  publicDiscoveryEnabled: false,
  protocolVersion: "1.0",
  bindings: ["JSONRPC"],
  inbound: {
    enabled: false,
    grpc: {
      enabled: false,
      host: "127.0.0.1",
      port: 8788,
    },
    peerCredentials: [],
  },
  outbound: {
    enabled: false,
    peers: [],
  },
};

export function buildA2ABridgeStatus(input: {
  checkedAt: string;
  baseUrl?: string;
  config?: A2ABridgeRuntimeConfig;
}): A2ABridgeStatusResponse {
  const config = normalizeA2AConfig(input.config);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const peerCredentials = buildPeerCredentialHealth(config.inbound.peerCredentials, input.checkedAt);
  const governance = buildA2ABridgeGovernance(config, peerCredentials);
  return {
    status: resolveA2ABridgeStatus(config, governance, peerCredentials),
    checkedAt: input.checkedAt,
    agentCard: buildA2AAgentCard({ baseUrl, config, governance }),
    previewRoutes: {
      agentCard: `${baseUrl}/api/v1/a2a/agent-card`,
      taskPreview: `${baseUrl}/api/v1/a2a/task-preview`,
      jsonRpc: `${baseUrl}/api/v1/a2a/jsonrpc`,
      httpJson: `${baseUrl}/api/v1/a2a/http-json/tasks`,
      grpc: buildGrpcUrl(baseUrl, config.inbound.grpc),
      authenticatedExtendedCard: `${baseUrl}/api/v1/a2a/extended-agent-card`,
      publicDiscovery: `${baseUrl}/.well-known/agent-card.json`,
      outboundPreview: `${baseUrl}/api/v1/a2a/outbound/preview`,
      outboundSend: `${baseUrl}/api/v1/a2a/outbound/send`,
    },
    peerCredentials,
    governance,
  };
}

export function buildA2ATaskExportPreview(
  input: A2ATaskExportPreviewRequest,
  options: { checkedAt: string; config?: A2ABridgeRuntimeConfig },
): A2ATaskExportPreviewResponse {
  const goal = input.goal.trim();
  const exportId = `a2a-preview-${randomUUID()}`;
  const contextId = input.sessionId?.trim() || input.taskId?.trim() || exportId;
  const artifactRefs = normalizeArtifactRefs(input.artifactRefs);
  const config = normalizeA2AConfig(options.config);
  return {
    exportId,
    checkedAt: options.checkedAt,
    status: "preview",
    governance: buildA2ABridgeGovernance(
      config,
      buildPeerCredentialHealth(config.inbound.peerCredentials, options.checkedAt),
    ),
    warnings: [
      "Preview only: no A2A client request, webhook, or remote task mutation was sent.",
      "Callable A2A traffic uses configured peer credentials, Gateway policy, durable task bindings, and audit.",
    ],
    task: {
      id: exportId,
      contextId,
      status: {
        state: "submitted",
        timestamp: options.checkedAt,
      },
      messages: [
        {
          role: "user",
          parts: [{ kind: "text", text: goal }],
        },
      ],
      artifacts: artifactRefs.map((ref, index) => ({
        artifactId: `artifact-${index + 1}`,
        name: ref,
        uri: ref,
        parts: [
          {
            kind: "data",
            data: {
              ref,
              source: "goatcitadel_artifact_ref",
            },
          },
        ],
      })),
      metadata: {
        bridge: "goatcitadel-a2a",
        sourceSurface: input.sourceSurface ?? "chat",
        workspaceId: input.workspaceId ?? "default",
        projectId: input.projectId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        payloadHash: hashPreviewPayload({
          goal,
          artifactRefs,
          projectId: input.projectId,
          sessionId: input.sessionId,
          taskId: input.taskId,
        }),
      },
    },
  };
}

export function normalizeA2AConfig(config: A2ABridgeRuntimeConfig | undefined): A2ABridgeRuntimeConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_A2A_RUNTIME_CONFIG.enabled,
    publicDiscoveryEnabled: config?.publicDiscoveryEnabled ?? DEFAULT_A2A_RUNTIME_CONFIG.publicDiscoveryEnabled,
    protocolVersion: "1.0",
    bindings: normalizeProtocolBindings(config?.bindings),
    inbound: {
      enabled: config?.inbound?.enabled ?? DEFAULT_A2A_RUNTIME_CONFIG.inbound.enabled,
      grpc: {
        enabled: config?.inbound?.grpc?.enabled ?? DEFAULT_A2A_RUNTIME_CONFIG.inbound.grpc.enabled,
        host: config?.inbound?.grpc?.host ?? DEFAULT_A2A_RUNTIME_CONFIG.inbound.grpc.host,
        port: config?.inbound?.grpc?.port ?? DEFAULT_A2A_RUNTIME_CONFIG.inbound.grpc.port,
      },
      peerCredentials: config?.inbound?.peerCredentials ?? [],
    },
    outbound: {
      enabled: config?.outbound?.enabled ?? DEFAULT_A2A_RUNTIME_CONFIG.outbound.enabled,
      peers: config?.outbound?.peers ?? [],
    },
  };
}

export function buildPeerCredentialHealth(
  credentials: A2APeerCredentialConfig[],
  checkedAt: string,
): A2APeerCredentialHealth[] {
  return credentials.map((credential) => {
    const token = readPeerCredentialSecret(credential);
    return {
      peerId: credential.peerId,
      label: credential.label,
      status: resolvePeerCredentialStatus(credential, token, checkedAt),
      scopes: credential.scopes ?? ["a2a:jsonrpc"],
      expiresAt: credential.expiresAt,
      revokedAt: credential.revokedAt,
      checkedAt,
    };
  });
}

export function buildA2ABridgeGovernance(
  config: A2ABridgeRuntimeConfig,
  peerCredentials: A2APeerCredentialHealth[],
): A2ABridgeGovernance {
  const inboundJsonRpcEnabled = Boolean(
    config.enabled && config.inbound.enabled && config.bindings.includes("JSONRPC"),
  );
  const inboundHttpJsonEnabled = Boolean(
    config.enabled && config.inbound.enabled && config.bindings.includes("HTTP_JSON"),
  );
  const inboundGrpcEnabled = Boolean(
    config.enabled && config.inbound.enabled && config.bindings.includes("GRPC") && config.inbound.grpc.enabled,
  );
  const outboundNetworkEnabled = Boolean(config.enabled && config.outbound.enabled);
  const configuredPeerCount = peerCredentials.filter((credential) => credential.status === "configured").length;
  const callable = (inboundJsonRpcEnabled || inboundHttpJsonEnabled || inboundGrpcEnabled) && configuredPeerCount > 0;
  const reasons = buildGovernanceReasons(config, {
    inboundJsonRpcEnabled,
    inboundHttpJsonEnabled,
    inboundGrpcEnabled,
    outboundNetworkEnabled,
    configuredPeerCount,
  });
  return {
    exposure: config.publicDiscoveryEnabled
      ? "public_discovery"
      : callable && inboundJsonRpcEnabled && !inboundHttpJsonEnabled
        ? "a2a_peer_jsonrpc"
        : callable
          ? "a2a_peer_gateway"
          : "operator_api_only",
    callable,
    approvalRequired: true,
    outboundNetworkEnabled,
    inboundJsonRpcEnabled,
    inboundHttpJsonEnabled,
    inboundGrpcEnabled,
    replayPolicy: callable ? "durable_task_binding" : "preview_only",
    audit: callable || outboundNetworkEnabled ? "durable_gateway_audit" : "gateway_route",
    reasons,
  };
}

export function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_BASE_URL;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function readPeerCredentialSecret(credential: A2APeerCredentialConfig): string | undefined {
  if (credential.token?.trim()) {
    return credential.token.trim();
  }
  if (credential.tokenEnv?.trim()) {
    const value = process.env[credential.tokenEnv.trim()];
    return value?.trim() || undefined;
  }
  return undefined;
}

function buildA2AAgentCard(input: {
  baseUrl?: string;
  config: A2ABridgeRuntimeConfig;
  governance: A2ABridgeGovernance;
}): A2ABridgeAgentCard {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const jsonRpcCallable = input.governance.inboundJsonRpcEnabled && input.governance.callable;
  const httpJsonCallable = input.governance.inboundHttpJsonEnabled && input.governance.callable;
  const grpcCallable = input.governance.inboundGrpcEnabled && input.governance.callable;
  const publicationStatus = input.config.publicDiscoveryEnabled
    ? "public_discovery"
    : input.config.enabled
      ? "private_configured"
      : "draft_operator_preview";
  return {
    name: "GoatCitadel Mission Control",
    description:
      "Gateway-governed A2A v1.0 boundary for external agent interoperability. GoatCitadel mesh remains native runtime coordination.",
    version: A2A_BRIDGE_PROTOCOL_VERSION,
    protocolVersion: "1.0",
    publicationStatus,
    discoveryPublished: input.config.enabled && input.config.publicDiscoveryEnabled,
    supportedInterfaces: [
      {
        url: `${baseUrl}/api/v1/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        enabled: jsonRpcCallable,
        reason: jsonRpcCallable
          ? "Inbound JSON-RPC is callable for configured A2A peers."
          : "Inbound JSON-RPC requires A2A, inbound mode, JSON-RPC binding, and configured peer credentials.",
      },
      {
        url: buildGrpcUrl(baseUrl, input.config.inbound.grpc),
        protocolBinding: "GRPC",
        protocolVersion: "1.0",
        enabled: grpcCallable,
        reason: grpcCallable
          ? "Inbound gRPC is callable for configured A2A peers on the Gateway gRPC listener."
          : "gRPC requires A2A, inbound mode, GRPC binding, configured peer credentials, and an enabled gRPC listener.",
      },
      {
        url: `${baseUrl}/api/v1/a2a/http-json`,
        protocolBinding: "HTTP_JSON",
        protocolVersion: "1.0",
        enabled: httpJsonCallable,
        reason: httpJsonCallable
          ? "Inbound HTTP+JSON is callable for configured A2A peers."
          : "HTTP+JSON requires A2A, inbound mode, HTTP_JSON binding, and configured peer credentials.",
      },
    ],
    capabilities: {
      streaming: jsonRpcCallable || grpcCallable,
      pushNotifications: input.governance.callable,
      stateTransitionHistory: true,
      extendedAgentCard: input.governance.callable,
      extensions: [
        ...(httpJsonCallable ? ["goatcitadel.http_json_tasks"] : []),
        ...(grpcCallable ? ["goatcitadel.grpc_tasks"] : []),
        ...(input.governance.callable ? ["goatcitadel.push_notifications"] : []),
      ],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "goatcitadel.task_interop",
        name: "Governed Task Interop",
        description:
          "Accepts peer-authenticated A2A messages through Gateway policy, durable task bindings, and visible chat/task lifecycle state.",
        tags: [
          "a2a",
          "json-rpc",
          ...(httpJsonCallable ? ["http-json"] : []),
          ...(grpcCallable ? ["grpc"] : []),
          "durable-tasks",
          "operator-governed",
        ],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
      },
    ],
    security: [{ a2aPeerBearer: [] }],
    governance: input.governance,
  };
}

function resolveA2ABridgeStatus(
  config: A2ABridgeRuntimeConfig,
  governance: A2ABridgeGovernance,
  peerCredentials: A2APeerCredentialHealth[],
): A2ABridgeStatus {
  if (!config.enabled) {
    return "preview_ready";
  }
  if (governance.callable) {
    return "callable";
  }
  if (config.inbound.enabled && peerCredentials.length === 0) {
    return "blocked";
  }
  if (config.inbound.enabled || config.outbound.enabled) {
    return "configured";
  }
  return "not_configured";
}

function resolvePeerCredentialStatus(
  credential: A2APeerCredentialConfig,
  token: string | undefined,
  checkedAt: string,
): A2APeerCredentialHealth["status"] {
  if (credential.revokedAt) {
    return "revoked";
  }
  if (credential.expiresAt) {
    const expiresAt = Date.parse(credential.expiresAt);
    const now = Date.parse(checkedAt);
    if (Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt <= now) {
      return "expired";
    }
  }
  return token ? "configured" : "missing_secret";
}

function buildGovernanceReasons(
  config: A2ABridgeRuntimeConfig,
  state: {
    inboundJsonRpcEnabled: boolean;
    inboundHttpJsonEnabled: boolean;
    inboundGrpcEnabled: boolean;
    outboundNetworkEnabled: boolean;
    configuredPeerCount: number;
  },
): string[] {
  if (!config.enabled) {
    return [
      "A2A is disabled by default for local-first safety; operator diagnostics and task preview remain available.",
      "Mesh remains GoatCitadel-native coordination for readiness, leases, ownership, replication, and runtime state.",
    ];
  }
  const reasons = [
    "A2A is the governed external agent-to-agent boundary at the Gateway.",
    "Gateway policy, approvals, path jails, memory policy, capability activation, durable execution, audit, and network allowlists remain authoritative.",
  ];
  if (!state.inboundJsonRpcEnabled) {
    reasons.push("Inbound JSON-RPC is not callable until A2A inbound mode and JSON-RPC binding are enabled.");
  }
  if (!state.inboundHttpJsonEnabled) {
    reasons.push("Inbound HTTP+JSON is not callable until A2A inbound mode and HTTP_JSON binding are enabled.");
  }
  if (!state.inboundGrpcEnabled) {
    reasons.push(
      "Inbound gRPC is not callable until A2A inbound mode, GRPC binding, and the gRPC listener are enabled.",
    );
  }
  if (
    (state.inboundJsonRpcEnabled || state.inboundHttpJsonEnabled || state.inboundGrpcEnabled) &&
    state.configuredPeerCount === 0
  ) {
    reasons.push("Inbound A2A requires at least one configured, unexpired, unrevoked peer credential.");
  }
  if (!state.outboundNetworkEnabled) {
    reasons.push("Outbound A2A is disabled until explicitly configured and allowlisted.");
  }
  reasons.push(
    "A2A push notification delivery is callable for configured peers and remains governed by Gateway peer auth, network allowlists, durable task bindings, and external side-effect audit.",
  );
  reasons.push(
    "A2A gRPC remains a Gateway-owned loopback/default listener and outbound client; it does not replace mesh-native readiness, leases, ownership, or replication.",
  );
  return reasons;
}

function buildGrpcUrl(baseUrl: string, grpc: A2ABridgeRuntimeConfig["inbound"]["grpc"]): string {
  const base = new URL(normalizeBaseUrl(baseUrl));
  const host = grpc.host === "0.0.0.0" || grpc.host === "::" ? base.hostname : grpc.host;
  return `grpc://${host}:${grpc.port}`;
}

function normalizeProtocolBindings(
  value: A2ABridgeRuntimeConfig["bindings"] | undefined,
): A2ABridgeRuntimeConfig["bindings"] {
  const bindings = value?.length ? value : DEFAULT_A2A_RUNTIME_CONFIG.bindings;
  return [...new Set(bindings)].filter(
    (binding) => binding === "JSONRPC" || binding === "GRPC" || binding === "HTTP_JSON",
  );
}

function normalizeArtifactRefs(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

function hashPreviewPayload(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
