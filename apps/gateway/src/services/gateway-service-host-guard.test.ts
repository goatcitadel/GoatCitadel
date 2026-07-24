import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createChatTurnRuntimeHost, type ChatTurnRuntimeHost } from "./chat-turn-runtime-host-composition.js";

const SERVICES_DIR = new URL(".", import.meta.url);
const HOST_GUARD_EXCLUDED_PATHS = new Set([
  "gateway-service.ts",
  "gateway-runtime-factory.ts",
  "service-context.ts",
  "gateway/build-service-context.ts",
]);

const HOST_COUPLING_PATTERNS = [
  /import\s+(?:type\s+)?\{[^}]*\bGatewayService\b[^}]*\}\s+from\s+"[^"]*gateway-service\.js";/m,
  /type\s+\w+Host\s*=\s*GatewayService\b/m,
  /GatewayService\["[^"]+"\]/m,
];

const EXTRACTED_GATEWAY_SERVICE_SYMBOLS = [
  "ApprovalReplayResult",
  "ApprovalResolveResult",
  "DurableChatTurnExecutionPayload",
  "DurableChatTurnUserInputResumeRecord",
  "InspectableChatStreamChunk",
  "PersistableChatStreamChunk",
  "PreparedChatExecutionPlanResolution",
  "RemoteApprovalActionTokenIssueResult",
  "RuntimeSettings",
  "ResolvedRuntimeGuidance",
  "CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT",
  "CHAT_PLANNER_MAX_STEPS",
  "CHAT_PLANNER_MIN_STEPS",
  "ChatTurnCancelledError",
  "CompanionAccessValidationResult",
  "CompanionSessionRecord",
  "DEFAULT_DELEGATION_ROLES",
  "applyExecutionPlanDraftToOrchestrationPlan",
  "buildCompanionSigningPayload",
  "buildDelegationFailureGuidance",
  "buildEmptyAssistantTurnFallbackText",
  "buildExecutionPlanDraftFromOrchestrationPlan",
  "buildMemoryContextSystemMessage",
  "buildPlanningModeSystemInstruction",
  "buildRetrievalTrace",
  "buildRoleGapSpecialistSuggestion",
  "buildSpecialistMatchReason",
  "buildSpecialistSuggestionFromCapability",
  "calculateSavings",
  "coercePlannerExecutionPlanDraft",
  "createChatCompletionDeadline",
  "decodeBase64Url",
  "dedupeChatCitations",
  "delayChatCompletionRetry",
  "detectDelegationRoles",
  "extractCompletionText",
  "extractSpecialistObjectiveKeywords",
  "extractPromptFromMessages",
  "getRemainingChatCompletionTimeoutMs",
  "inferDegradedAssistantTurnFailure",
  "inferSpecialistBaseRole",
  "isChatTurnCancelledError",
  "isCompanionSessionCurrentlyActive",
  "isCompanionSessionOperatorActive",
  "isCompanionSessionRefreshable",
  "isImageMimeType",
  "isPersistableChatStreamChunk",
  "isRecord",
  "mapCompanionSessionRow",
  "mergeChatSystemInstructions",
  "mergeExecutionPlanStepStatuses",
  "mergeSpecialistEvidence",
  "mergeSpecialistRoutingHints",
  "normalizeChatInputParts",
  "normalizeChatCompletionAttemptError",
  "normalizeCompanionAuditEvent",
  "normalizeCompanionNonce",
  "normalizeCompanionRequestPath",
  "normalizeCompanionSignature",
  "normalizeSpecialistCandidateFingerprint",
  "normalizeToolProtocolRetryRequest",
  "parseLooseJsonRecord",
  "renderExecutionPlanAsMarkdown",
  "scoreSpecialistCandidateMatch",
  "shouldRetryToolProtocolError",
  "shouldRetryTransientProviderError",
  "splitIntoChunks",
  "toCompanionSessionAdminRecord",
  "toCompanionSessionInfoResponse",
  "toTitleCase",
  "truncateSummaryLine",
];

const ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_NAMES = [
  "addonsService",
  "addonSlotService",
  "approvalRuntime",
  "assemblyService",
  "backupRetentionService",
  "capabilityPackService",
  "capabilityScopeResolver",
  "capabilitySystemService",
  "chatCompactionBreakerActionService",
  "chatMessageRouteRuntimeHost",
  "chatProjectService",
  "chatTurnRuntime",
  "databaseCutoverService",
  "devDiagnostics",
  "durableOperatorService",
  "evidenceEnvelopeService",
  "guidanceService",
  "improvementService",
  "autonomyControlService",
  "mediaVoiceService",
  "obsidianVaultService",
  "onboardingStateHost",
  "promptPackService",
  "realtimeEventService",
  "researchService",
  "runtimeLifecycleReadService",
  "taskLifecycleService",
  "toolInvocationCoordinator",
] as const;

const EXPECTED_ROUTE_COMPOSITION_PRIVATE_DEPENDENCIES_ALIAS = `export type GatewayRouteCompositionPrivateDependencies = Pick<
  GatewayRouteCompositionPort,
${ROUTE_COMPOSITION_PRIVATE_DEPENDENCY_NAMES.map((dependencyName) => `  | "${dependencyName}"`).join("\n")}
>;`;

async function collectServiceFiles(dir: URL, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectServiceFiles(new URL(`${entry.name}/`, dir), relativePath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(relativePath);
  }

  return files;
}

let serviceSourcesPromise: Promise<Array<{ relativePath: string; source: string }>> | null = null;

async function readServiceSources(): Promise<Array<{ relativePath: string; source: string }>> {
  serviceSourcesPromise ??= collectServiceFiles(SERVICES_DIR).then(async (files) =>
    Promise.all(
      files.map(async (relativePath) => ({
        relativePath,
        source: await fs.readFile(new URL(relativePath, SERVICES_DIR), "utf8"),
      })),
    ),
  );
  return serviceSourcesPromise;
}

describe("gateway service host guard", () => {
  it("does not allow GatewayService host coupling outside gateway-service.ts", async () => {
    const files = await readServiceSources();
    const offenders: string[] = [];

    for (const { relativePath, source } of files) {
      if (HOST_GUARD_EXCLUDED_PATHS.has(relativePath)) {
        continue;
      }
      if (HOST_COUPLING_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(relativePath);
      }
    }

    offenders.sort();
    expect(offenders).toEqual([]);
  }, 15_000);

  it("does not allow imports of extracted helper and payload types from gateway-service.ts", async () => {
    const files = await readServiceSources();
    const offenders: string[] = [];

    for (const { relativePath, source } of files) {
      if (relativePath === "gateway-service.ts") {
        continue;
      }
      const importedSymbols = extractGatewayServiceNamedImports(source);
      const extractedImports = importedSymbols.filter((symbol) => EXTRACTED_GATEWAY_SERVICE_SYMBOLS.includes(symbol));
      if (extractedImports.length > 0) {
        offenders.push(`${relativePath}: ${extractedImports.sort().join(", ")}`);
      }
    }

    offenders.sort();
    expect(offenders).toEqual([]);
  }, 15_000);

  it("keeps the Fastify runtime port narrower than full storage", async () => {
    const files = await readServiceSources();
    const runtimeFactory = files.find(({ relativePath }) => relativePath === "gateway-runtime-factory.ts");
    expect(runtimeFactory?.source).toBeTruthy();
    const source = runtimeFactory?.source ?? "";
    const runtimePortBlock = source.match(/export interface GatewayRuntimePort\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(runtimePortBlock).not.toMatch(/\breadonly\s+storage\b/);
    expect(runtimePortBlock).toMatch(/\breadonly\s+mutationIdempotencyStore:\s+MutationIdempotencyStore\b/);
    expect(source).not.toMatch(/export function createGatewayRuntime[\s\S]*?return new GatewayService\(config\)/);
    expect(source).not.toMatch(/export function createGatewayAdminRuntime[\s\S]*?return new GatewayService\(config\)/);
    expect(source).toContain("return createGatewayRuntimeFacade(new GatewayService(config, options));");

    const appSource = await fs.readFile(new URL("../app.ts", SERVICES_DIR), "utf8");
    expect(appSource).not.toMatch(/\bgatewayRuntime\.storage\b/);
    expect(appSource).toContain("app.gatewayRuntime.mutationIdempotencyStore");
  }, 15_000);

  it("keeps chat-turn runtime host contracts split by collaborator", async () => {
    const files = await readServiceSources();
    const prep = files.find(({ relativePath }) => relativePath === "chat-turn-prep-service.ts")?.source ?? "";
    const entry = files.find(({ relativePath }) => relativePath === "chat-turn-entry-service.ts")?.source ?? "";
    const stream = files.find(({ relativePath }) => relativePath === "chat-turn-stream-service.ts")?.source ?? "";
    const dispatch = files.find(({ relativePath }) => relativePath === "chat-turn-dispatch-service.ts")?.source ?? "";
    const composition =
      files.find(({ relativePath }) => relativePath === "chat-turn-runtime-host-composition.ts")?.source ?? "";

    expect(prep).not.toContain("readonly storage: Storage;");
    expect(prep).toContain("type ChatTurnPrepStorage = Pick<");
    for (const collaborator of [
      "ChatTurnActiveExecutionControl",
      "ChatTurnDurableRunOwner",
      "ChatTurnIntegrationDispatch",
      "ChatTurnLeaseControl",
      "ChatTurnMemorySideEffects",
      "ChatTurnRealtimeEmitter",
      "ChatTurnStreamLifecycleControl",
      "ChatTurnTranscriptIngress",
    ]) {
      expect(`${entry}\n${stream}\n${dispatch}\n${composition}`).toContain(collaborator);
    }
    for (const composer of [
      "composeSessionPreparation",
      "composeActiveExecution",
      "composeStreamLifecycle",
      "composeDurableOwnership",
      "composeMemorySideEffects",
      "composeRealtimeEmission",
      "composeTranscriptIngress",
    ]) {
      expect(composition).toContain(`function ${composer}`);
    }
  }, 15_000);

  it("forwards critical chat-turn runtime collaborators through the composed host", async () => {
    const calls: string[] = [];
    async function* emptyStream() {
      calls.push("empty-stream");
      for (const value of [] as never[]) {
        yield value;
      }
    }
    const source = {
      streamPersistedChatTurnEvents: () => {
        calls.push("streamPersistedChatTurnEvents");
        return emptyStream();
      },
      withEphemeralStreamEnvelope: (stream: AsyncGenerator<never>) => {
        calls.push("withEphemeralStreamEnvelope");
        return stream;
      },
      getActiveChatTurnExecution: () => {
        calls.push("getActiveChatTurnExecution");
        return undefined;
      },
      ensureSessionInternalToolGrant: () => {
        calls.push("ensureSessionInternalToolGrant");
      },
      extractAndPersistLearnedMemory: () => {
        calls.push("extractAndPersistLearnedMemory");
      },
      publishRealtime: () => {
        calls.push("publishRealtime");
      },
      ingestEvent: async () => {
        calls.push("ingestEvent");
      },
    } as unknown as ChatTurnRuntimeHost;

    const host = createChatTurnRuntimeHost(source);
    host.streamPersistedChatTurnEvents("session", "turn");
    host.withEphemeralStreamEnvelope(emptyStream());
    host.getActiveChatTurnExecution("turn");
    host.ensureSessionInternalToolGrant("session", "tool", "reason");
    host.extractAndPersistLearnedMemory("session", "content", { role: "user", sourceRef: "turn" });
    host.publishRealtime("channel", "topic", {});
    await host.ingestEvent("idempotency-key", { type: "chat", payload: {} } as never);

    expect(calls).toEqual([
      "streamPersistedChatTurnEvents",
      "withEphemeralStreamEnvelope",
      "getActiveChatTurnExecution",
      "ensureSessionInternalToolGrant",
      "extractAndPersistLearnedMemory",
      "publishRealtime",
      "ingestEvent",
    ]);
  });

  it("keeps route-service composition on an explicit internal port", async () => {
    const files = await readServiceSources();
    const composition = files.find(({ relativePath }) => relativePath === "gateway-route-service-composition.ts");
    const port = files.find(({ relativePath }) => relativePath === "gateway-route-composition-port.ts");
    expect(composition?.source).toBeTruthy();
    expect(port?.source).toBeTruthy();
    const entrypointSource = composition?.source ?? "";
    const portSource = port?.source ?? "";
    const routeCompositionSources = files
      .filter(({ relativePath }) =>
        /^gateway-route-composition-(?:chat|integrations|memory|port|runtime|shared|system|tools)\.ts$/.test(
          relativePath,
        ),
      )
      .map(({ source: fileSource }) => fileSource)
      .join("\n");
    const source = [entrypointSource, routeCompositionSources].join("\n");

    expect(portSource).toContain("export interface GatewayRouteCompositionPort");
    expect(source).not.toMatch(/\bGatewayRouteComposition(?:Source|Port)\s*=\s*any\b/);
    expect(source).not.toMatch(/\btype\s+GatewayRouteComposition(?:Service|Callable)\s*=/);
    expect(source).not.toMatch(/\bGatewayRouteCompositionPort[\s\S]*?\(\s*\.\.\.args\s*:\s*any\[\]\s*\)\s*:\s*any/);
    expect(portSource).not.toMatch(/export\s+interface\s+GatewayRouteCompositionPort\s+extends\b/);
    expect(portSource).not.toMatch(/\bGatewayRouteCompositionPort\s+(?:extends|=)[^;\n]*GatewayService\b/);
    expect(portSource).not.toMatch(/\bGatewayRouteCompositionPort\s+(?:extends|=)[^;\n]*ServiceContext\b/);
    const compositionPrivateDependencyType =
      portSource.match(/export type GatewayRouteCompositionPrivateDependencies\s*=[\s\S]*?;\r?\n/)?.[0] ?? "";
    const compositionHostType =
      portSource.match(/export type GatewayRouteCompositionHost\s*=[\s\S]*?;\r?\n/)?.[0] ?? "";
    expect(compositionPrivateDependencyType).not.toMatch(/\b(?:any|unknown|Partial\s*<|Record\s*<)/);
    expect(compositionHostType).not.toMatch(/\b(?:any|unknown|Partial\s*<|Record\s*<)/);
    expect(normalizeTypeAlias(compositionPrivateDependencyType)).toBe(
      normalizeTypeAlias(EXPECTED_ROUTE_COMPOSITION_PRIVATE_DEPENDENCIES_ALIAS),
    );
    expect(compositionHostType).toMatch(
      /export type GatewayRouteCompositionHost\s*=\s*Omit<\s*GatewayRouteCompositionPort,\s*keyof GatewayRouteCompositionPrivateDependencies\s*>;/,
    );
    expect(entrypointSource).not.toMatch(
      /composeGatewayRouteServices\s*\(\s*gateway\s*:\s*(?:any|GatewayService|ServiceContext)\b/,
    );
    expect(portSource).not.toMatch(/\[\s*key\s*:\s*string\s*\]/);
    const portBlock = portSource.match(/export interface GatewayRouteCompositionPort\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const portMemberCount = portBlock.match(/^\s+(?:readonly\s+)?[A-Za-z_]\w+\??[:(]/gm)?.length ?? 0;
    // Soft bloat cap. Bumped to 163 for workspace/citadel capability scoping: `invokeMcpTool`
    // (routes the REST /mcp/invoke surface through the guarded gateway method) + `capabilityScopeResolver`
    // (resolution for the capability-scope route service).
    // Bumped to 164 for `syncSignalInboundRuntime` (legacy Signal inbound
    // setting diagnostics on integration connection create/update/delete).
    // Bumped to 171 for the integrated config-generation/inbound-channel owners,
    // message projection, and the governed compaction-breaker route service.
    // Bumped to 173 for explicit Skill Hub review and rollback-review owners.
    expect(portMemberCount).toBeLessThanOrEqual(173);
    const portFactory = portSource.slice(
      portSource.indexOf("export function createGatewayRouteCompositionPort"),
      portSource.indexOf("export type RouteDependencyDomain"),
    );
    expect(portFactory).not.toMatch(/config:\s*gateway\.config/);
    expect(portFactory).toMatch(/get config\(\)\s*\{\s*return gateway\.config;/);
    expect(source).not.toMatch(/\bonboardingMarker(?:Path)?\b/);
    expect(source).toMatch(/new IntegrationDiagnosticsService\(\{\s*get config\(\)/);
    expect(source).not.toMatch(
      /config:\s*\{\s*toolPolicy:\s*\{[\s\S]*?networkAllowlist:\s*gateway\.config\.toolPolicy\.sandbox\.networkAllowlist/,
    );
    const domainComposerNames = [
      "composeChatRouteDependencies",
      "composeIntegrationChannelRouteDependencies",
      "composeRuntimeAdminRouteDependencies",
      "composeMemoryKnowledgeRouteDependencies",
      "composeToolsMcpRouteDependencies",
      "composeSystemRouteDependencies",
    ];
    const entrypointStart = entrypointSource.indexOf("export function composeGatewayRouteServices");
    expect(entrypointStart).toBeGreaterThanOrEqual(0);
    const entrypoint = entrypointSource.slice(entrypointStart);
    expect(source).not.toContain("function composeGatewayRouteServiceDependencies");
    expect(source).not.toMatch(
      /function compose\w+RouteDependencies\(\s*dependencies:\s*GatewayRouteServiceDependencies/,
    );
    for (const composerName of domainComposerNames) {
      expect(source).toMatch(
        new RegExp(`export\\s+function\\s+${composerName}\\s*\\(\\s*gateway:\\s*GatewayRouteCompositionPort`),
      );
      expect(entrypoint).toContain(`...${composerName}(gateway)`);
    }
    expect(entrypoint).not.toContain("...dependencies");
    expect(entrypoint).not.toContain("dependencies.");
    expect(entrypoint).not.toMatch(/createGatewayRouteServices\(\s*dependencies\s*\)/);
    const routeServiceInput =
      entrypoint.match(/createGatewayRouteServices\(\s*\{(?<body>[\s\S]*?)\}\s*\)/)?.groups?.body ?? "";
    const routeServiceLines = routeServiceInput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(routeServiceLines).toEqual(domainComposerNames.map((composerName) => `...${composerName}(gateway),`));
    expect(entrypoint).not.toMatch(/create[A-Z]\w+RoutePort\(/);
    expect(entrypoint).not.toMatch(/new\s+[A-Z]\w+Service\(/);
    expect(source).not.toContain("const INTEGRATION_PLUGINS_SETTING_KEY");
    expect(source).not.toMatch(/function readIntegrationPlugins|function writeIntegrationPlugins/);
    expect(source).toContain('from "./integration-plugin-store.js"');
    const gatewayService = files.find(({ relativePath }) => relativePath === "gateway-service.ts")?.source ?? "";
    expect(gatewayService).not.toMatch(/\bclass\s+GatewayService\s+implements\s+GatewayRouteCompositionPort\b/);
    expect(gatewayService).not.toMatch(/new\s+ChatTurnRuntimeService\(\s*createChatTurnRuntimeHost\(\s*this\s*\)\s*\)/);
    expect(gatewayService).toMatch(/new\s+ChatTurnRuntimeService\(\s*this\.buildChatTurnRuntimeHost\(\)\s*\)/);
    const factoryConsumers = files
      .filter(
        ({ relativePath }) =>
          relativePath !== "gateway-service.ts" &&
          relativePath !== "gateway-route-service-composition.ts" &&
          relativePath !== "gateway-route-composition-port.ts",
      )
      .filter(({ source: serviceSource }) => /\bcreateGatewayRouteCompositionPort\b/.test(serviceSource))
      .map(({ relativePath }) => relativePath)
      .sort();
    expect(factoryConsumers).toEqual([]);
    expect(gatewayService).toMatch(/createGatewayRouteCompositionPort\(\s*this,\s*\{/);
    expect(gatewayService).not.toMatch(
      /\bas\s+(?:any\s+as\s+|unknown\s+as\s+)?GatewayRouteComposition(?:PrivateDependencies|Host)\b/,
    );
    expect(gatewayService).not.toMatch(/<\s*GatewayRouteComposition(?:PrivateDependencies|Host)\s*>/);
    expect(source).not.toMatch(
      /\bgateway\.(?:listGlobalGuidance|listWorkspaceGuidance|updateGlobalGuidance|updateWorkspaceGuidance)\b/,
    );
    for (const dependencyName of [
      "addonsService",
      "approvalRuntime",
      "assemblyService",
      "backupRetentionService",
      "capabilityPackService",
      "capabilitySystemService",
      "chatProjectService",
      "chatTurnRuntime",
      "databaseCutoverService",
      "devDiagnostics",
      "durableOperatorService",
      "evidenceEnvelopeService",
      "guidanceService",
      "improvementService",
      "autonomyControlService",
      "mediaVoiceService",
      "obsidianVaultService",
      "promptPackService",
      "realtimeEventService",
      "researchService",
      "runtimeLifecycleReadService",
      "taskLifecycleService",
      "toolInvocationCoordinator",
      "continuationGateService",
      "memoryWriteGateService",
    ]) {
      expect(gatewayService).not.toMatch(new RegExp(`public\\s+readonly\\s+${dependencyName}\\b`));
    }
    for (const { relativePath, source: serviceSource } of files) {
      if (relativePath === "gateway-route-service-composition.ts") {
        continue;
      }
      expect(serviceSource).not.toMatch(
        /\bas\s+(?:any\s+as\s+|unknown\s+as\s+)?GatewayRouteComposition(?:Port|PrivateDependencies|Host)\b/,
      );
      expect(serviceSource).not.toMatch(/<\s*GatewayRouteComposition(?:Port|PrivateDependencies|Host)\s*>/);
    }
  }, 15_000);

  it("routes dry-run commit approvals through the single integration-action host construction site", async () => {
    const files = await readServiceSources();
    const gatewayService = files.find(({ relativePath }) => relativePath === "gateway-service.ts")?.source ?? "";
    const composition =
      files.find(({ relativePath }) => relativePath === "gateway-route-composition-integrations.ts")?.source ?? "";

    // The approved dry-run replay dispatch must claim the pending action BEFORE the
    // external-runtime/tool.invoke fallthroughs, and both callers of the integration
    // action runtime must share buildIntegrationActionHostForGateway so the host
    // members (createApproval, dryRunCommits via storage) cannot drift apart.
    expect(gatewayService).toMatch(
      /pending\?\.actionType === "integration\.dry_run_commit"[\s\S]{0,120}executeApprovedIntegrationDryRunCommit/,
    );
    expect(gatewayService).toMatch(/buildIntegrationActionHostForGateway\(this\.getRouteCompositionPort\(\)\)/);
    expect(gatewayService).not.toMatch(/invokeIntegrationConnectionAction\(\s*\{/);
    expect(composition).toMatch(/export function buildIntegrationActionHostForGateway\(/);
    expect(composition).toMatch(
      /invokeIntegrationConnectionActionImpl\(\s*buildIntegrationActionHostForGateway\(gateway\)/,
    );
    expect(composition).toMatch(/createApproval: \(input\) => gateway\.createApproval\(input\)/);
    const inlineHostBuilders = files
      .filter(({ relativePath }) => relativePath !== "gateway-route-composition-integrations.ts")
      .filter(({ source: serviceSource }) =>
        /invokeIntegrationConnectionAction(?:Impl)?\(\s*\{\s*storage:/.test(serviceSource),
      )
      .map(({ relativePath }) => relativePath);
    expect(inlineHostBuilders).toEqual([]);
  }, 15_000);

  it("routes policy-engine approval creation through the canonical Gateway lifecycle", async () => {
    const files = await readServiceSources();
    const gatewayService = files.find(({ relativePath }) => relativePath === "gateway-service.ts")?.source ?? "";
    const normalizedGatewayService = normalizeSourceForGuard(gatewayService);
    const createApprovalMethod = normalizeSourceForGuard(extractPublicMethodSource(gatewayService, "createApproval"));

    expect(normalizedGatewayService).toMatch(
      /new ToolPolicyEngine\(config\.toolPolicy, this\.storage, undefined, \{[\s\S]{0,700}createApproval: \(input, onCreated, authority\) => this\.createApproval\(input, onCreated, authority\)/,
    );
    expect(createApprovalMethod).toMatch(
      /const approval = authority \? await this\.approvalRuntime\.createApproval\(input, onCreated, authority\) : await this\.approvalRuntime\.createApproval\(input, onCreated\)/,
    );
    expect(gatewayService).toMatch(
      /new CapabilitySystemService\(\{[\s\S]{0,800}resolveApproval: \(approvalId, input\) => this\.resolveApproval\(approvalId, input\)/,
    );
  }, 15_000);
});

function normalizeTypeAlias(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function normalizeSourceForGuard(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function extractPublicMethodSource(source: string, methodName: string): string {
  const escapedMethodName = methodName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signature = new RegExp(`\\bpublic\\s+(?:async\\s+)?${escapedMethodName}\\s*\\(`).exec(source);
  if (!signature) {
    return "";
  }
  const remainder = source.slice(signature.index + signature[0].length);
  const nextPublicMember = /\n\s*public\s+(?:async\s+)?[A-Za-z_$]/.exec(remainder);
  return source.slice(
    signature.index,
    nextPublicMember ? signature.index + signature[0].length + nextPublicMember.index : source.length,
  );
}

function extractGatewayServiceNamedImports(source: string): string[] {
  const importedSymbols: string[] = [];
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?\{(?<symbols>[\s\S]*?)\}\s+from\s+"[^"]*gateway-service\.js";?/g;
  for (const match of source.matchAll(importPattern)) {
    const symbols = match.groups?.symbols;
    if (!symbols) {
      continue;
    }
    importedSymbols.push(
      ...symbols
        .split(",")
        .map((symbol) =>
          symbol
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/i)[0]
            ?.trim(),
        )
        .filter((symbol): symbol is string => Boolean(symbol)),
    );
  }
  return importedSymbols;
}
