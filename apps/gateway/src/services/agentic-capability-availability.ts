import type {
  AgenticCapabilityAvailability,
  AgenticHarnessAvailabilityRecord,
  AgenticPluginProviderRuntimeStatus,
  AgenticRuntimeAvailabilityResponse,
  AgenticScalabilityTrackRecord,
  A2ABridgeStatusResponse,
} from "@goatcitadel/contracts";
import type { IntegrationCatalogEntry, IntegrationConnection } from "@goatcitadel/contracts";
import type { LlmProviderSummary } from "@goatcitadel/contracts";
import type { IntegrationPluginRecord } from "@goatcitadel/contracts";
import {
  normalizePluginProviderRuntimeStatus,
  runtimeStatusToCapabilityAvailability,
} from "./plugin-provider-governance-service.js";

const OPENAI_API_HOSTNAME = "api.openai.com";

export type AgenticCapabilityFamily = AgenticCapabilityAvailability["family"];

export interface AgenticCapabilityRuntimeAvailabilityInput {
  capabilityId: string;
  label: string;
  family: AgenticCapabilityFamily;
  inspectable: boolean;
  callable: boolean;
  configured?: boolean;
  reasons?: string[];
  unavailableReason?: string;
  blockedReason?: string;
  notConfiguredReason?: string;
  checkedAt?: string;
}

export interface AgenticRuntimeAvailabilityBuildInput {
  generatedAt?: string;
  harnesses?: AgenticHarnessAvailabilityRecord[];
  providers?: LlmProviderSummary[];
  plugins?: IntegrationPluginRecord[];
  channelCatalog?: IntegrationCatalogEntry[];
  channelConnections?: IntegrationConnection[];
  a2a?: A2ABridgeStatusResponse;
}

export function normalizeAgenticCapabilityAvailability(
  input: AgenticCapabilityRuntimeAvailabilityInput,
): AgenticCapabilityAvailability {
  const reasons = normalizeReasons([
    ...(input.reasons ?? []),
    input.unavailableReason,
    input.notConfiguredReason,
    input.blockedReason,
  ]);
  const inspectable = input.inspectable;
  const callable = inspectable && input.callable;

  return {
    capabilityId: input.capabilityId.trim(),
    label: input.label.trim(),
    family: input.family,
    status: resolveAvailabilityStatus({
      inspectable,
      callable,
      configured: input.configured,
      unavailableReason: input.unavailableReason,
      notConfiguredReason: input.notConfiguredReason,
      reasons,
    }),
    callable,
    reasons,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

export function normalizeAgenticCapabilityAvailabilitySet(input: {
  providers?: AgenticCapabilityRuntimeAvailabilityInput[];
  harnesses?: AgenticCapabilityRuntimeAvailabilityInput[];
  channels?: AgenticCapabilityRuntimeAvailabilityInput[];
  other?: AgenticCapabilityRuntimeAvailabilityInput[];
}): AgenticCapabilityAvailability[] {
  return [
    ...(input.providers ?? []).map((item) => normalizeAgenticCapabilityAvailability({ ...item, family: "provider" })),
    ...(input.harnesses ?? []).map((item) => normalizeAgenticCapabilityAvailability({ ...item, family: "harness" })),
    ...(input.channels ?? []).map((item) => normalizeAgenticCapabilityAvailability({ ...item, family: "channel" })),
    ...(input.other ?? []).map((item) => normalizeAgenticCapabilityAvailability(item)),
  ];
}

export function buildAgenticRuntimeAvailability(
  input: AgenticRuntimeAvailabilityBuildInput,
): AgenticRuntimeAvailabilityResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const providerSummaries = input.providers ?? [];
  const harnesses = input.harnesses ?? [];
  const providers = providerSummaries.map((provider) => providerSummaryToRuntimeStatus(provider, generatedAt));
  const plugins = (input.plugins ?? []).map((plugin) => integrationPluginToRuntimeStatus(plugin, generatedAt));
  const channels = buildChannelAvailability(input.channelCatalog ?? [], input.channelConnections ?? [], generatedAt);
  const scalability = buildAgentScalabilityTracks(providerSummaries, generatedAt, input.a2a);
  const items = [
    ...harnesses.map(harnessAvailabilityToCapabilityAvailability),
    ...providers.map(runtimeStatusToCapabilityAvailability),
    ...plugins.map(runtimeStatusToCapabilityAvailability),
    ...channels,
    ...scalability.map(scalabilityTrackToCapabilityAvailability),
  ];

  return {
    generatedAt,
    items,
    harnesses,
    plugins,
    providers,
    channels,
    scalability,
  };
}

export function harnessAvailabilityToCapabilityAvailability(
  input: AgenticHarnessAvailabilityRecord,
): AgenticCapabilityAvailability {
  return {
    capabilityId: `harness:${input.harnessId}`,
    label: input.label,
    family: "harness",
    status: input.status,
    callable: input.callable && input.status === "callable",
    reasons: input.reasons,
    checkedAt: input.checkedAt,
  };
}

function resolveAvailabilityStatus(input: {
  inspectable: boolean;
  callable: boolean;
  configured?: boolean;
  unavailableReason?: string;
  notConfiguredReason?: string;
  reasons: string[];
}): AgenticCapabilityAvailability["status"] {
  if (input.callable) {
    return "callable";
  }
  if (!input.inspectable) {
    return "unavailable";
  }
  if (input.unavailableReason) {
    return "unavailable";
  }
  if (input.configured === false || input.notConfiguredReason) {
    return "not_configured";
  }
  return "blocked";
}

function normalizeReasons(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    reasons.push(normalized);
  }
  return reasons;
}

function providerSummaryToRuntimeStatus(
  provider: LlmProviderSummary,
  checkedAt: string,
): AgenticPluginProviderRuntimeStatus {
  const configured = provider.hasApiKey || provider.oauthStatus?.connected === true;
  return normalizePluginProviderRuntimeStatus({
    runtimeId: provider.providerId,
    kind: "provider",
    label: provider.label,
    manifestSource: provider.baseUrl,
    integrityStatus: "verified",
    runtimeAvailable: configured,
    approvedForCallableUse: true,
    healthOk: configured,
    secretsRequired: configured ? [] : [`${provider.providerId} credential`],
    checkedAt,
    healthMessage: configured ? undefined : "Provider is inspectable but no usable credential is configured.",
  });
}

function integrationPluginToRuntimeStatus(
  plugin: IntegrationPluginRecord,
  checkedAt: string,
): AgenticPluginProviderRuntimeStatus {
  const integrityStatus = mapPluginIntegrityStatus(plugin);
  const hasCriticalWarning = (plugin.trustWarnings ?? []).some((warning) => warning.severity === "critical");
  return normalizePluginProviderRuntimeStatus({
    runtimeId: plugin.pluginId,
    kind: "plugin",
    label: plugin.label,
    manifestSource: plugin.sourceMetadata?.display ?? plugin.source,
    integrityStatus,
    runtimeAvailable: plugin.enabled && integrityStatus !== "corrupt" && !hasCriticalWarning,
    approvedForCallableUse: plugin.enabled && !hasCriticalWarning,
    healthOk: plugin.enabled && integrityStatus === "verified" && !hasCriticalWarning,
    permissions: plugin.capabilities,
    rollbackRef: plugin.version,
    checkedAt,
    healthMessage: hasCriticalWarning
      ? "Plugin has a critical trust warning and is excluded from callable runtime."
      : undefined,
  });
}

function mapPluginIntegrityStatus(
  plugin: IntegrationPluginRecord,
): AgenticPluginProviderRuntimeStatus["integrityStatus"] {
  switch (plugin.integrityStatus ?? plugin.sourceMetadata?.integrityStatus ?? "unknown") {
    case "verified":
    case "not_applicable":
      return "verified";
    case "missing":
    case "mismatch":
      return "corrupt";
    case "unknown":
    default:
      return "unverified";
  }
}

function buildChannelAvailability(
  catalog: IntegrationCatalogEntry[],
  connections: IntegrationConnection[],
  checkedAt: string,
): AgenticCapabilityAvailability[] {
  const connectionsByCatalog = new Map<string, IntegrationConnection[]>();
  for (const connection of connections) {
    const current = connectionsByCatalog.get(connection.catalogId) ?? [];
    current.push(connection);
    connectionsByCatalog.set(connection.catalogId, current);
  }

  return catalog
    .filter((entry) => entry.kind === "channel")
    .map((entry) => {
      const matchingConnections = connectionsByCatalog.get(entry.catalogId) ?? [];
      const enabledConnected = matchingConnections.find(
        (connection) => connection.enabled && connection.status === "connected",
      );
      const anyConnection = matchingConnections[0];
      const runnable = entry.runtimeAvailability === "runnable";
      const configured = matchingConnections.length > 0;
      const unavailableReason = runnable ? undefined : "Channel runtime is catalog-only or blocked.";
      const notConfiguredReason = configured ? undefined : "No channel connection is configured.";
      const blockedReason =
        configured && !enabledConnected
          ? (anyConnection?.lastError ??
            (anyConnection?.enabled === false
              ? "Channel connection is disabled."
              : `Channel connection is ${anyConnection?.status ?? "not connected"}.`))
          : undefined;

      return normalizeAgenticCapabilityAvailability({
        capabilityId: `channel:${entry.key}`,
        label: entry.label,
        family: "channel",
        inspectable: true,
        callable: Boolean(runnable && enabledConnected),
        configured,
        unavailableReason,
        notConfiguredReason,
        blockedReason,
        checkedAt,
      });
    });
}

function buildAgentScalabilityTracks(
  providers: LlmProviderSummary[],
  checkedAt: string,
  a2a?: A2ABridgeStatusResponse,
): AgenticScalabilityTrackRecord[] {
  const openAiProviders = providers.filter(isOpenAiFamilyProvider);
  const openAiResponsesProvider = openAiProviders.find((provider) =>
    ["openai-responses", "openai-codex-responses"].includes(provider.resolvedApiStyle ?? provider.apiStyle),
  );
  const claudeProviders = providers.filter(isClaudeFamilyProvider);

  return [
    {
      trackId: "openai_agents_sdk",
      label: "OpenAI Agents SDK",
      kind: "agent_sdk",
      status: openAiProviders.length > 0 ? "blocked" : "unavailable",
      callable: false,
      implementationStatus: openAiProviders.length > 0 ? "partial" : "missing",
      summary:
        openAiProviders.length > 0
          ? "OpenAI-family provider paths are visible, but no SDK-backed Agents adapter is registered."
          : "No OpenAI-family provider path is visible in this runtime availability snapshot.",
      reasons: normalizeReasons([
        openAiResponsesProvider
          ? `Responses-style provider path is present through ${openAiResponsesProvider.label}.`
          : openAiProviders.length > 0
            ? "Visible OpenAI-family provider support does not prove an Agents SDK runtime adapter."
            : undefined,
        "No @openai/agents dependency or SDK-backed gateway adapter is registered.",
        "Agent handoffs, guardrails, human review, tracing, and eval loops are not exposed as an OpenAI Agents SDK runtime.",
      ]),
      evidence: [
        {
          label: "OpenAI Agents guide",
          url: "https://developers.openai.com/api/docs/guides/agents",
        },
        {
          label: "Gateway provider execution",
          path: "apps/gateway/src/services/llm-service.ts",
        },
        {
          label: "Built-in provider template",
          path: "packages/contracts/src/provider-templates.ts",
        },
      ],
      requiredNextSteps: [
        "Add an adapter behind gateway-owned durable execution before marking callable",
        "Route SDK tools, handoffs, guardrails, traces, and approvals through existing policy boundaries",
        "Add focused SDK adapter and eval-loop tests",
      ],
      checkedAt,
    },
    {
      trackId: "claude_agent_sdk",
      label: "Claude Agent SDK",
      kind: "agent_sdk",
      status: claudeProviders.length > 0 ? "blocked" : "unavailable",
      callable: false,
      implementationStatus: claudeProviders.length > 0 ? "partial" : "missing",
      summary:
        claudeProviders.length > 0
          ? "Claude/Anthropic provider paths are visible, but no Claude Agent SDK loop is registered."
          : "No Claude/Anthropic provider path is visible in this runtime availability snapshot.",
      reasons: normalizeReasons([
        claudeProviders.length > 0
          ? `Provider API path is visible through ${claudeProviders.map((provider) => provider.label).join(", ")}.`
          : undefined,
        "No @anthropic-ai/claude-agent-sdk dependency or SDK-backed gateway adapter is registered.",
        "SDK sessions, subagents, allowed tools, hooks, MCP wiring, and .claude configuration boundaries are not exposed as a callable runtime.",
      ]),
      evidence: [
        {
          label: "Claude Agent SDK overview",
          url: "https://code.claude.com/docs/en/agent-sdk/overview",
        },
        {
          label: "Anthropic provider adapter",
          path: "apps/gateway/src/services/llm-provider-anthropic.ts",
        },
        {
          label: "Built-in provider template",
          path: "packages/contracts/src/provider-templates.ts",
        },
      ],
      requiredNextSteps: [
        "Add an adapter behind gateway-owned durable execution before marking callable",
        "Map SDK permissions, hooks, subagent lineage, sessions, costs, and MCP configuration into policy-governed records",
        "Constrain .claude configuration loading to approved workspace boundaries",
      ],
      checkedAt,
    },
    {
      trackId: "a2a_protocol",
      label: "A2A protocol interoperability",
      kind: "agent_protocol",
      status: a2a?.governance.callable ? "callable" : a2a?.status === "not_configured" ? "not_configured" : "blocked",
      callable: Boolean(a2a?.governance.callable),
      implementationStatus: a2a?.governance.callable ? "implemented" : "partial",
      summary: a2a?.governance.callable
        ? "A2A is configured as a governed external agent-to-agent Gateway boundary across enabled JSON-RPC, HTTP+JSON, push, and gRPC bindings."
        : "A2A is present as a Gateway-owned external interoperability boundary but is not currently callable.",
      reasons: a2a?.governance.reasons ?? [
        "Operator-authenticated preview routes expose an Agent Card and A2A-style task envelope mapping.",
        "Callable A2A requires enabled inbound bindings, configured peer credentials, durable task bindings, network allowlists, and audit.",
        "A2A must remain a first-class interoperability protocol, not a provider template or MCP alias.",
      ],
      evidence: [
        {
          label: "A2A project",
          url: "https://github.com/a2aproject/A2A",
        },
        {
          label: "A2A specification",
          url: "https://a2a-protocol.org/latest/specification/",
        },
        {
          label: "Gateway A2A bridge routes",
          path: "apps/gateway/src/routes/tasks.ts",
        },
        {
          label: "Gateway A2A bridge service",
          path: "apps/gateway/src/services/a2a-bridge-service.ts",
        },
        {
          label: "Gateway A2A gRPC transport",
          path: "apps/gateway/src/services/a2a-grpc-server.ts",
        },
        {
          label: "A2A bridge contracts",
          path: "packages/contracts/src/a2a.ts",
        },
        {
          label: "Runtime availability route",
          path: "apps/gateway/src/routes/tasks.ts",
        },
        {
          label: "Runtime contracts",
          path: "packages/contracts/src",
        },
      ],
      requiredNextSteps: [
        "Keep public Agent Card discovery disabled by default unless explicitly configured",
        "Continue proving peer auth, network allowlists, durable task binding, audit, push delivery, and gRPC behavior in verify:a2a:full",
        "Keep mesh-native readiness, leases, ownership, and replication separate from A2A interop",
      ],
      checkedAt,
    },
  ];
}

function scalabilityTrackToCapabilityAvailability(input: AgenticScalabilityTrackRecord): AgenticCapabilityAvailability {
  return {
    capabilityId: `scalability:${input.trackId}`,
    label: input.label,
    family: input.kind,
    status: input.status,
    callable: input.callable && input.status === "callable",
    reasons: normalizeReasons([input.summary, ...input.reasons]),
    checkedAt: input.checkedAt,
  };
}

function isOpenAiFamilyProvider(provider: LlmProviderSummary): boolean {
  const providerId = provider.providerId.trim().toLowerCase();
  const label = provider.label.trim().toLowerCase();
  return (
    providerId === "openai" ||
    providerId.startsWith("openai-") ||
    label.includes("openai") ||
    isOpenAiApiBaseUrl(provider.baseUrl)
  );
}

function isOpenAiApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === OPENAI_API_HOSTNAME;
  } catch {
    return false;
  }
}

function isClaudeFamilyProvider(provider: LlmProviderSummary): boolean {
  const providerId = provider.providerId.trim().toLowerCase();
  const label = provider.label.trim().toLowerCase();
  return (
    providerId === "anthropic" ||
    providerId === "claude-code" ||
    label.includes("anthropic") ||
    label.includes("claude") ||
    provider.apiStyle === "anthropic-messages" ||
    provider.resolvedApiStyle === "anthropic-messages"
  );
}
