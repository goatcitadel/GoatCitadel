import {
  TOOL_GROUPS,
  toolGroupForTool,
  type CapabilityToolAsks,
  type CapabilityToolBlock,
  type CapabilityToolGroupItem,
  type CapabilityToolGroupState,
  type CapabilityToolItem,
  type CapabilityToolsResponse,
  type ToolAccessEvaluateRequest,
  type ToolAccessEvaluateResponse,
  type ToolCatalogEntry,
  type ToolGroupDefinition,
  type ToolGroupId,
  type ToolPolicyActorContext,
  type ToolRiskLevel,
} from "@goatcitadel/contracts";

/** The probes run this many at a time, the same as the chat runner's per-turn policy probes. */
const PROBE_CONCURRENCY = 8;
/** The session the probes run under. It names no real chat, so a probe never touches one. */
const PROBE_SESSION_ID = "capabilities-tools";
const UNCHECKED_RULES_ISSUE = "Some tools' rules couldn't be checked right now.";

/** Lowest to highest, the order a group's risk is taken in. */
const RISK_ORDER: readonly ToolRiskLevel[] = ["safe", "caution", "danger", "nuclear"];

/**
 * What each engine denial means to the operator. Any code not listed here is read as unknown, including
 * `tool_group_off`: the group's switch is the group's state, not a rule that blocks the tool.
 */
const BLOCK_BY_REASON_CODE: ReadonlyMap<string, CapabilityToolBlock> = new Map([
  ["policy_deny", "safety_rules"],
  ["policy_disallow", "safety_rules"],
  ["permission_profile_upper_bound", "permission_profile"],
  ["citadel_ward_deny", "citadel_ward"],
  ["grant_deny", "grant"],
]);

type CatalogTool = Pick<ToolCatalogEntry, "toolName" | "description" | "riskLevel">;

/** The caller whose permission profile the probes use. These come from the request's own auth, never from its query. */
export interface CapabilityToolsActor {
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
}

/** Every source is a plain function reader over an existing owner; this service owns none of them. */
export interface CapabilityToolsSources {
  /** The tools this install offers, in registry order. */
  listToolCatalog(): readonly CatalogTool[];
  readSettings(): Promise<{ revision: number; switchedOffToolGroups: readonly ToolGroupId[] }>;
  resolvePolicyContext(
    input: { workspaceId: string; surface: "chat" } & CapabilityToolsActor,
  ): Promise<ToolPolicyActorContext>;
  /** The non-recording policy probe: it never writes an access decision or publishes an event. */
  inspectAccess(request: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse>;
  probeArgs(toolName: string): Record<string, unknown>;
  /** Whether this install's deployment profile keeps the tool off, whatever the policy says. */
  isBlockedByInstall(toolName: string, args: Record<string, unknown>): boolean;
}

interface ToolVerdict {
  asks: CapabilityToolAsks;
  blockedBy?: CapabilityToolBlock;
  /** True when the rules couldn't be read, which the response says once. */
  unchecked?: boolean;
}

const UNKNOWN_VERDICT: ToolVerdict = { asks: "unknown" };

/**
 * The Capabilities Tools tab's list: every tool group with whether it is on, and for each tool whether the AI asks
 * first or a rule blocks it. Every tool is probed with the same read-only check Chat uses, in switched-off groups too.
 * A group's state comes from the Settings switches only, never from what a probe answers.
 *
 * Nothing is cached after a list finishes, so a switch shows on the next request. Requests that arrive while an
 * identical list is being built share it; a request made after a Settings change never joins a list started before it.
 */
export class CapabilityToolsService {
  private readonly inFlight = new Map<string, Promise<CapabilityToolsResponse>>();

  public constructor(
    private readonly sources: CapabilityToolsSources,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(workspaceId: string, actor: CapabilityToolsActor = {}): Promise<CapabilityToolsResponse> {
    const settings = await this.sources.readSettings();
    // The probes depend on who asks and on the Settings revision, so only identical requests share a list.
    const key = JSON.stringify([
      workspaceId,
      actor.operatorId,
      actor.authActorId,
      actor.authActorSource,
      settings.revision,
    ]);
    const running = this.inFlight.get(key);
    if (running) return running;
    const started = this.build(workspaceId, actor, settings).finally(() => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  private async build(
    workspaceId: string,
    actor: CapabilityToolsActor,
    settings: { revision: number; switchedOffToolGroups: readonly ToolGroupId[] },
  ): Promise<CapabilityToolsResponse> {
    const switchedOff = new Set<ToolGroupId>(settings.switchedOffToolGroups);
    const stateOf = (group: ToolGroupDefinition): CapabilityToolGroupState =>
      !group.switchable ? "always_on" : switchedOff.has(group.id) ? "off" : "on";

    const catalogByGroup = new Map<ToolGroupId, CatalogTool[]>();
    for (const tool of this.sources.listToolCatalog()) {
      // Connector and mesh tools belong to their connector and match no group.
      const groupId = toolGroupForTool(tool.toolName)?.id;
      if (groupId) catalogByGroup.set(groupId, [...(catalogByGroup.get(groupId) ?? []), tool]);
    }

    // Every group is probed, switched-off ones too. The engine checks the deny list before the group switch, so a tool
    // that is also denied still reports its rule, which tells the operator that switching the group on won't be enough.
    // A tool that is only switched off answers `tool_group_off`, which reads as unknown with no rule named.
    const probed = TOOL_GROUPS.flatMap((group) => catalogByGroup.get(group.id) ?? []);
    const policyContext = await this.resolvePolicyContext(workspaceId, actor);
    const verdicts = new Map<string, ToolVerdict>();
    const results = await mapWithConcurrency(probed, PROBE_CONCURRENCY, (tool) =>
      this.probe(tool.toolName, workspaceId, policyContext),
    );
    probed.forEach((tool, index) => verdicts.set(tool.toolName, results[index] ?? UNKNOWN_VERDICT));

    const groups = TOOL_GROUPS.map((group): CapabilityToolGroupItem => {
      const tools = (catalogByGroup.get(group.id) ?? []).map((tool): CapabilityToolItem => {
        const verdict = verdicts.get(tool.toolName) ?? UNKNOWN_VERDICT;
        return {
          toolName: tool.toolName,
          description: tool.description,
          risk: tool.riskLevel,
          asks: verdict.asks,
          ...(verdict.blockedBy ? { blockedBy: verdict.blockedBy } : {}),
        };
      });
      return {
        groupId: group.id,
        label: group.label,
        description: group.description,
        state: stateOf(group),
        risk: riskiestOf(tools),
        tools,
        blockedToolCount: tools.filter((tool) => tool.blockedBy !== undefined).length,
      };
    });

    const unchecked = policyContext === undefined || [...verdicts.values()].some((verdict) => verdict.unchecked);
    return {
      workspaceId,
      groups,
      settingsRevision: settings.revision,
      issues: unchecked ? [UNCHECKED_RULES_ISSUE] : [],
      generatedAt: this.now().toISOString(),
    };
  }

  /** The permission profile and overrides that apply to this operator in this workspace's chats, or undefined. */
  private async resolvePolicyContext(
    workspaceId: string,
    actor: CapabilityToolsActor,
  ): Promise<ToolPolicyActorContext | undefined> {
    try {
      return await this.sources.resolvePolicyContext({
        workspaceId,
        surface: "chat",
        operatorId: actor.operatorId,
        authActorId: actor.authActorId,
        authActorSource: actor.authActorSource,
      });
    } catch {
      return undefined;
    }
  }

  private async probe(
    toolName: string,
    workspaceId: string,
    policyContext: ToolPolicyActorContext | undefined,
  ): Promise<ToolVerdict> {
    try {
      const args = this.sources.probeArgs(toolName);
      // The install's guard runs before the engine on a real call, so it is the reason a real call would give.
      if (this.sources.isBlockedByInstall(toolName, args)) return { asks: "unknown", blockedBy: "install_profile" };
      if (!policyContext) return { asks: "unknown", unchecked: true };
      const access = await this.sources.inspectAccess({
        toolName,
        agentId: "assistant",
        sessionId: PROBE_SESSION_ID,
        workspaceId,
        surface: "chat",
        args,
        policyContext,
        permissionProfileId: policyContext.permissionProfileId,
      });
      return verdictFor(access);
    } catch {
      return { asks: "unknown", unchecked: true };
    }
  }
}

function verdictFor(access: ToolAccessEvaluateResponse): ToolVerdict {
  if (access.allowed) return { asks: access.requiresApproval ? "asks_first" : "runs_freely" };
  for (const reasonCode of access.reasonCodes) {
    const blockedBy = BLOCK_BY_REASON_CODE.get(reasonCode);
    if (blockedBy) return { asks: "unknown", blockedBy };
  }
  return UNKNOWN_VERDICT;
}

function riskiestOf(tools: readonly CapabilityToolItem[]): ToolRiskLevel {
  return tools.reduce<ToolRiskLevel>(
    (riskiest, tool) => (RISK_ORDER.indexOf(tool.risk) > RISK_ORDER.indexOf(riskiest) ? tool.risk : riskiest),
    "safe",
  );
}

/** Maps `items` with at most `limit` calls running at once, keeping the input order. */
async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  run: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array<TResult>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as TItem);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
