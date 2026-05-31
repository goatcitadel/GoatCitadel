import type { FastifyPluginAsync } from "fastify";

type TrustPolicyPosture =
  | "callable"
  | "non_callable"
  | "blocked"
  | "quarantined"
  | "disabled"
  | "not_installed"
  | "unavailable";

interface TrustPolicySourceStatus {
  key: string;
  owner: string;
  status: "available" | "unavailable";
  itemCount: number;
  error?: string;
}

interface TrustPolicySnapshot {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  enforcementSources: string[];
  sources: TrustPolicySourceStatus[];
  permissionProfiles: unknown[];
  toolGrants: unknown[];
  localOperatorOverrides: unknown[];
  capabilities: {
    inspectable: Array<Record<string, unknown>>;
    callable: Array<Record<string, unknown>>;
  };
  mcpServers: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  addons: Array<Record<string, unknown>>;
  lastUseEvidence: Array<Record<string, unknown>>;
}

type SourceReadResult<T> = {
  items: T[];
  source: TrustPolicySourceStatus;
};

const READ_ROUTE_OPTIONS = {
  config: {
    rateLimit: {
      max: 500,
    },
  },
};

export const trustRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/trust/policy-snapshot", READ_ROUTE_OPTIONS, async (request, reply) => {
    const services = fastify.services as unknown as Record<string, unknown>;
    const tools = readService(services, "tools");
    const capabilities = readService(services, "capabilities");
    const mcp = readService(services, "mcp");
    const skills = readService(services, "skills");
    const addons = readService(services, "addons");

    const permissionProfiles = await readSource("permissionProfiles", "tools.permissionProfiles", () =>
      callListMethod(tools, "listPermissionProfiles", true),
    );
    const toolGrants = await readSource("toolGrants", "tools.grants", () =>
      callListMethod(tools, "listToolGrants", undefined, undefined, 500),
    );
    const localOperatorOverrides = await readSource("localOperatorOverrides", "tools.localOperatorOverrides", () =>
      callListMethod(tools, "listActiveLocalOperatorOverrides", request.authActorId),
    );
    const inspectableCapabilities = await readSource("capabilities.inspectable", "capabilities.catalog", () =>
      callListMethod(capabilities, "listCapabilityCatalog", "inspectable"),
    );
    const callableCapabilities = await readSource("capabilities.callable", "capabilities.catalog", () =>
      callListMethod(capabilities, "listCapabilityCatalog", "callable"),
    );
    const mcpServers = await readSource("mcpServers", "mcp.servers", () => callListMethod(mcp, "listMcpServers"));
    const skillsSource = await readSource("skills", "skills.lifecycle", () => callListMethod(skills, "listSkills"));
    const addonsCatalog = await readSource("addons.catalog", "addons.catalog", () =>
      callListMethod(addons, "listAddonsCatalog"),
    );
    const installedAddons = await readSource("addons.installed", "addons.installed", () =>
      callListMethod(addons, "listInstalledAddons"),
    );

    const mcpToolSources = await Promise.all(
      mcpServers.items.map((server) =>
        readMcpToolsSource(mcp, server).then((result) => ({
          server,
          tools: result.items,
          source: result.source,
        })),
      ),
    );

    const snapshot: TrustPolicySnapshot = {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      mutationSemantics: "none",
      enforcementSources: [
        "tools.permissionProfiles",
        "tools.grants",
        "tools.localOperatorOverrides",
        "capabilities.catalog",
        "mcp.servers",
        "mcp.tools",
        "skills.lifecycle",
        "addons.catalog",
        "addons.installed",
      ],
      sources: [
        permissionProfiles.source,
        toolGrants.source,
        localOperatorOverrides.source,
        inspectableCapabilities.source,
        callableCapabilities.source,
        mcpServers.source,
        ...mcpToolSources.map((source) => source.source),
        skillsSource.source,
        addonsCatalog.source,
        installedAddons.source,
      ],
      permissionProfiles: permissionProfiles.items.map(projectPermissionProfile),
      toolGrants: toolGrants.items.map(projectToolGrant),
      localOperatorOverrides: localOperatorOverrides.items.map(projectLocalOperatorOverride),
      capabilities: {
        inspectable: inspectableCapabilities.items.map(projectCapability),
        callable: callableCapabilities.items.map(projectCapability),
      },
      mcpServers: mcpToolSources.map(({ server, tools }) => projectMcpServer(server, tools)),
      skills: skillsSource.items.map(projectSkill),
      addons: projectAddons(addonsCatalog.items, installedAddons.items),
      lastUseEvidence: [
        ...skillsSource.items.map(projectSkillLastUseEvidence).filter(isRecord),
        ...mcpToolSources.map(({ server, tools }) => projectMcpLastUseEvidence(server, tools)).filter(isRecord),
        ...installedAddons.items.map(projectAddonLastUseEvidence).filter(isRecord),
      ],
    };

    return reply.send(snapshot);
  });
};

async function readMcpToolsSource(
  mcp: Record<string, unknown> | undefined,
  server: unknown,
): Promise<SourceReadResult<unknown>> {
  const serverId = readString(readRecord(server)?.serverId);
  if (!serverId) {
    return {
      items: [],
      source: {
        key: "mcpTools.unknown",
        owner: "mcp.tools",
        status: "unavailable",
        itemCount: 0,
        error: "MCP server is missing a serverId.",
      },
    };
  }
  return readSource(`mcpTools.${serverId}`, "mcp.tools", () => callListMethod(mcp, "listMcpTools", serverId));
}

async function readSource<T>(key: string, owner: string, read: () => T[] | Promise<T[]>): Promise<SourceReadResult<T>> {
  try {
    const items = await read();
    const normalized = Array.isArray(items) ? items : [];
    return {
      items: normalized,
      source: {
        key,
        owner,
        status: "available",
        itemCount: normalized.length,
      },
    };
  } catch (error) {
    return {
      items: [],
      source: {
        key,
        owner,
        status: "unavailable",
        itemCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function callListMethod(
  service: Record<string, unknown> | undefined,
  methodName: string,
  ...args: unknown[]
): unknown[] {
  const method = service?.[methodName];
  if (typeof method !== "function") {
    throw new Error(`${methodName} is unavailable.`);
  }
  return method.apply(service, args) as unknown[];
}

function projectPermissionProfile(profile: unknown): Record<string, unknown> {
  const record = readRecord(profile);
  const status = readString(record?.status) ?? "active";
  return compactRecord({
    profileId: readString(record?.profileId),
    label: readString(record?.label),
    builtin: record?.builtin === true,
    status,
    posture: status === "archived" ? "disabled" : "callable",
    scope: readString(record?.scope),
    scopeRef: readString(record?.scopeRef),
    approvalMode: readString(record?.approvalMode),
    readAccessMode: readString(record?.readAccessMode),
    defaultForSurfaces: readStringArray(record?.defaultForSurfaces),
    allow: readStringArray(record?.allow),
    deny: readStringArray(record?.deny),
    source: "tools.permissionProfiles",
    createdAt: readString(record?.createdAt),
    updatedAt: readString(record?.updatedAt),
    archivedAt: readString(record?.archivedAt),
  });
}

function projectToolGrant(grant: unknown): Record<string, unknown> {
  const record = readRecord(grant);
  const revoked = Boolean(readString(record?.revokedAt));
  const expired = isPastIsoDate(readString(record?.expiresAt));
  const decision = readString(record?.decision);
  return compactRecord({
    grantId: readString(record?.grantId),
    toolPattern: readString(record?.toolPattern),
    decision,
    posture: revoked || expired ? "disabled" : decision === "deny" ? "blocked" : "callable",
    scope: readString(record?.scope),
    scopeRef: readString(record?.scopeRef),
    grantType: readString(record?.grantType),
    constraints: readRecord(record?.constraints),
    usesRemaining: typeof record?.usesRemaining === "number" ? record.usesRemaining : undefined,
    source: "tools.grants",
    createdBy: readString(record?.createdBy),
    createdAt: readString(record?.createdAt),
    expiresAt: readString(record?.expiresAt),
    revokedAt: readString(record?.revokedAt),
  });
}

function projectLocalOperatorOverride(override: unknown): Record<string, unknown> {
  const record = readRecord(override);
  const status = readString(record?.status) ?? "active";
  return compactRecord({
    overrideId: readString(record?.overrideId),
    operatorId: readString(record?.operatorId),
    scope: readString(record?.scope),
    scopeRef: readString(record?.scopeRef),
    status,
    posture: status === "active" && !isPastIsoDate(readString(record?.expiresAt)) ? "callable" : "disabled",
    reason: readString(record?.reason),
    source: "tools.localOperatorOverrides",
    createdBy: readString(record?.createdBy),
    createdAt: readString(record?.createdAt),
    expiresAt: readString(record?.expiresAt),
    revokedAt: readString(record?.revokedAt),
  });
}

function projectCapability(capability: unknown): Record<string, unknown> {
  const record = readRecord(capability);
  const callable = record?.callable === true;
  const lifecycleState = readString(record?.lifecycleState);
  return compactRecord({
    capabilityId: readString(record?.capabilityId),
    kind: readString(record?.kind),
    category: readString(record?.category),
    title: readString(record?.title) ?? readString(record?.name),
    summary: readString(record?.summary),
    callable,
    posture: readCapabilityPosture(callable, lifecycleState, readString(record?.reviewWarning)),
    lifecycleState,
    trustLabel: readString(record?.trustLabel),
    reviewWarning: readString(record?.reviewWarning),
    toolName: readString(record?.toolName),
    skillId: readString(record?.skillId),
    proposalId: readString(record?.proposalId),
    candidateId: readString(record?.candidateId),
    declaredTools: readStringArray(record?.declaredTools),
    requires: readStringArray(record?.requires),
    source: "capabilities.catalog",
  });
}

function projectMcpServer(server: unknown, tools: unknown[]): Record<string, unknown> {
  const record = readRecord(server);
  const trustTier = readString(record?.trustTier);
  const enabled = record?.enabled === true;
  const status = readString(record?.status);
  const serverPosture = readMcpPosture({
    enabled,
    trustTier,
    status,
    lastError: readString(record?.lastError),
  });
  return compactRecord({
    serverId: readString(record?.serverId),
    label: readString(record?.label),
    transport: readString(record?.transport),
    enabled,
    status,
    trustTier,
    posture: serverPosture,
    category: readString(record?.category),
    costTier: readString(record?.costTier),
    policy: readRecord(record?.policy),
    verifiedAt: readString(record?.verifiedAt),
    lastConnectedAt: readString(record?.lastConnectedAt),
    lastError: readString(record?.lastError),
    source: "mcp.servers",
    tools: tools.map((tool) => projectMcpTool(tool, serverPosture)),
    createdAt: readString(record?.createdAt),
    updatedAt: readString(record?.updatedAt),
  });
}

function projectMcpTool(tool: unknown, serverPosture: TrustPolicyPosture): Record<string, unknown> {
  const record = readRecord(tool);
  const enabled = record?.enabled === true;
  return compactRecord({
    toolName: readString(record?.toolName),
    enabled,
    description: readString(record?.description),
    posture: enabled && serverPosture === "callable" ? "callable" : serverPosture,
    source: "mcp.tools",
    updatedAt: readString(record?.updatedAt),
  });
}

function projectSkill(skill: unknown): Record<string, unknown> {
  const record = readRecord(skill);
  const callable = record?.callable === true;
  const lifecycleState = readString(record?.lifecycleState);
  const state = readString(record?.state) ?? "enabled";
  return compactRecord({
    skillId: readString(record?.skillId),
    name: readString(record?.name),
    sourceKind: readString(record?.source),
    state,
    lifecycleState,
    callable,
    posture: readSkillPosture({ callable, state, lifecycleState, reviewWarning: readString(record?.reviewWarning) }),
    capabilityCategory: readString(record?.capabilityCategory),
    trustLabel: readString(record?.trustLabel),
    reviewWarning: readString(record?.reviewWarning),
    usageCount: typeof record?.usageCount === "number" ? record.usageCount : undefined,
    lastUsedAt: readString(record?.lastUsedAt),
    declaredTools: readStringArray(record?.declaredTools),
    requires: readStringArray(record?.requires),
    source: "skills.lifecycle",
  });
}

function projectAddons(catalog: unknown[], installed: unknown[]): Array<Record<string, unknown>> {
  const installedById = new Map(
    installed
      .map((item) => [readString(readRecord(item)?.addonId), readRecord(item)] as const)
      .filter((entry): entry is readonly [string, Record<string, unknown>] => Boolean(entry[0] && entry[1])),
  );
  const catalogIds = new Set<string>();
  const catalogRows = catalog.map((addon) => {
    const record = readRecord(addon);
    const addonId = readString(record?.addonId);
    if (addonId) {
      catalogIds.add(addonId);
    }
    const installedRecord = addonId ? installedById.get(addonId) : undefined;
    return compactRecord({
      addonId,
      label: readString(record?.label),
      trustTier: readString(installedRecord?.trustTier) ?? readString(record?.trustTier),
      category: readString(record?.category),
      runtimeType: readString(record?.runtimeType),
      webEntryMode: readString(installedRecord?.webEntryMode) ?? readString(record?.webEntryMode),
      sameOwnerAsGoatCitadel: installedRecord?.sameOwnerAsGoatCitadel ?? record?.sameOwnerAsGoatCitadel,
      status: readString(installedRecord?.runtimeStatus) ?? "not_installed",
      posture: readAddonPosture(installedRecord),
      enabled: installedRecord?.enabled,
      source: installedRecord ? "addons.installed" : "addons.catalog",
      installedAt: readString(installedRecord?.installedAt),
      updatedAt: readString(installedRecord?.updatedAt) ?? readString(record?.updatedAt),
      lastError: readString(installedRecord?.lastError),
    });
  });
  const installedOnlyRows = [...installedById.entries()]
    .filter(([addonId]) => !catalogIds.has(addonId))
    .map(([addonId, installedRecord]) =>
      compactRecord({
        addonId,
        label: addonId,
        trustTier: readString(installedRecord.trustTier),
        runtimeType: readString(installedRecord.runtimeType),
        webEntryMode: readString(installedRecord.webEntryMode),
        sameOwnerAsGoatCitadel: installedRecord.sameOwnerAsGoatCitadel,
        status: readString(installedRecord.runtimeStatus) ?? "installed",
        posture: readAddonPosture(installedRecord),
        enabled: installedRecord.enabled,
        source: "addons.installed",
        installedAt: readString(installedRecord.installedAt),
        updatedAt: readString(installedRecord.updatedAt),
        lastError: readString(installedRecord.lastError),
      }),
    );
  return [...catalogRows, ...installedOnlyRows];
}

function projectSkillLastUseEvidence(skill: unknown): Record<string, unknown> | undefined {
  const record = readRecord(skill);
  const lastUsedAt = readString(record?.lastUsedAt);
  const usageCount = typeof record?.usageCount === "number" ? record.usageCount : undefined;
  if (!lastUsedAt && usageCount === undefined) {
    return undefined;
  }
  return compactRecord({
    source: "skills.lifecycle",
    subjectType: "skill",
    subjectId: readString(record?.skillId),
    lastUsedAt,
    usageCount,
    runId: readString(record?.runId) ?? readString(record?.lastRunId),
    approvalId: readString(record?.approvalId) ?? readString(record?.lastApprovalId),
    evidenceRef: readString(record?.evidenceRef) ?? readString(record?.lastEvidenceRef),
  });
}

function projectMcpLastUseEvidence(server: unknown, tools: unknown[]): Record<string, unknown> | undefined {
  const record = readRecord(server);
  const lastConnectedAt = readString(record?.lastConnectedAt);
  const latestToolUpdatedAt = tools
    .map((tool) => readString(readRecord(tool)?.updatedAt))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  if (!lastConnectedAt && !latestToolUpdatedAt) {
    return undefined;
  }
  return compactRecord({
    source: "mcp.servers",
    subjectType: "mcp_server",
    subjectId: readString(record?.serverId),
    lastConnectedAt,
    latestToolUpdatedAt,
    runId: readString(record?.runId) ?? readString(record?.lastRunId),
    approvalId: readString(record?.approvalId) ?? readString(record?.lastApprovalId),
    evidenceRef: readString(record?.evidenceRef) ?? readString(record?.lastEvidenceRef),
  });
}

function projectAddonLastUseEvidence(addon: unknown): Record<string, unknown> | undefined {
  const record = readRecord(addon);
  const updatedAt = readString(record?.updatedAt);
  if (!updatedAt) {
    return undefined;
  }
  return compactRecord({
    source: "addons.installed",
    subjectType: "addon",
    subjectId: readString(record?.addonId),
    updatedAt,
    status: readString(record?.runtimeStatus),
    runId: readString(record?.runId) ?? readString(record?.lastRunId),
    approvalId: readString(record?.approvalId) ?? readString(record?.lastApprovalId),
    evidenceRef: readString(record?.evidenceRef) ?? readString(record?.lastEvidenceRef),
  });
}

function readCapabilityPosture(callable: boolean, lifecycleState?: string, reviewWarning?: string): TrustPolicyPosture {
  if (callable) {
    return "callable";
  }
  if (lifecycleState === "revoked" || lifecycleState === "deprecated" || reviewWarning) {
    return "blocked";
  }
  return "non_callable";
}

function readMcpPosture(input: {
  enabled: boolean;
  trustTier?: string;
  status?: string;
  lastError?: string;
}): TrustPolicyPosture {
  if (input.trustTier === "quarantined") {
    return "quarantined";
  }
  if (!input.enabled) {
    return "disabled";
  }
  if (input.lastError || input.status === "error") {
    return "blocked";
  }
  if (input.status !== "connected") {
    return "non_callable";
  }
  return "callable";
}

function readSkillPosture(input: {
  callable: boolean;
  state?: string;
  lifecycleState?: string;
  reviewWarning?: string;
}): TrustPolicyPosture {
  if (input.state === "disabled" || input.state === "sleep") {
    return "disabled";
  }
  if (input.lifecycleState === "revoked" || input.lifecycleState === "deprecated" || input.reviewWarning) {
    return "blocked";
  }
  return input.callable ? "callable" : "non_callable";
}

function readAddonPosture(installed: Record<string, unknown> | undefined): TrustPolicyPosture {
  if (!installed) {
    return "not_installed";
  }
  const status = readString(installed.runtimeStatus);
  if (status === "error") {
    return "blocked";
  }
  if (status === "disabled" || installed.enabled === false) {
    return "disabled";
  }
  return status === "running" || status === "installed" || status === "stopped" ? "callable" : "non_callable";
}

function readService(services: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return readRecord(services[key]);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return items.length > 0 ? items : undefined;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isPastIsoDate(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now();
}
