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
import { mapWithConcurrency } from "./memory-learning-file-probe.js";

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

/** The Settings switches a list is built at. */
interface ToolSettings {
  revision: number;
  switchedOffToolGroups: readonly ToolGroupId[];
  pluginToolGroupHolds?: readonly { groupId: ToolGroupId; pluginId: string; pluginName: string }[];
}

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
  /**
   * The switches, and each plugin that holds a group off (`switchedOffToolGroups` already holds those groups). Without
   * `pluginToolGroupHolds` no group names a plugin.
   */
  readSettings(): Promise<ToolSettings>;
  resolvePolicyContext(
    input: { workspaceId: string; surface: "chat" } & CapabilityToolsActor,
  ): Promise<ToolPolicyActorContext>;
  /** The non-recording policy probe: it never writes an access decision or publishes an event. */
  inspectAccess(request: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse>;
  probeArgs(toolName: string): Record<string, unknown>;
  /** Whether this install's deployment profile keeps the tool off, whatever the policy says. */
  isBlockedByInstall(toolName: string, args: Record<string, unknown>): boolean;
  /**
   * Where the real error goes when a rule check fails. It is called once per list, never once per tool, with the first
   * error that left a tool's rules unchecked (in the order the tools are listed) and how many tools were left
   * unchecked. The answer to the operator never carries the error.
   */
  reportError?(error: unknown, failedProbes: number): void;
}

interface ToolVerdict {
  asks: CapabilityToolAsks;
  blockedBy?: CapabilityToolBlock;
  /** Set when the tool's rules couldn't be read, which the response says once. */
  failure?: { error: unknown };
}

/** The permission profile for the probes, or the error that stopped it from being resolved. */
type PolicyContextResult = { policyContext: ToolPolicyActorContext } | { error: unknown };

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
    settings: ToolSettings,
  ): Promise<CapabilityToolsResponse> {
    const switchedOff = new Set<ToolGroupId>(settings.switchedOffToolGroups);
    const heldOffBy = holdersByGroup(settings.pluginToolGroupHolds ?? []);
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
    const context = await this.resolvePolicyContext(workspaceId, actor);
    const verdicts = new Map<string, ToolVerdict>();
    const results = await mapWithConcurrency(probed, PROBE_CONCURRENCY, (tool) =>
      this.probe(tool.toolName, workspaceId, context),
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
        ...(heldOffBy.has(group.id) ? { heldOffBy: heldOffBy.get(group.id) } : {}),
      };
    });

    // The operator sees one plain line. The real error goes to the log, once per list with a count, never per tool.
    const failures = [...verdicts.values()].flatMap((verdict) => (verdict.failure ? [verdict.failure] : []));
    const unchecked = "error" in context || failures.length > 0;
    if (unchecked) {
      this.sources.reportError?.("error" in context ? context.error : failures[0]?.error, failures.length);
    }
    return {
      workspaceId,
      groups,
      settingsRevision: settings.revision,
      issues: unchecked ? [UNCHECKED_RULES_ISSUE] : [],
      generatedAt: this.now().toISOString(),
    };
  }

  /** The permission profile and overrides that apply to this operator in this workspace's chats. */
  private async resolvePolicyContext(workspaceId: string, actor: CapabilityToolsActor): Promise<PolicyContextResult> {
    try {
      return {
        policyContext: await this.sources.resolvePolicyContext({
          workspaceId,
          surface: "chat",
          operatorId: actor.operatorId,
          authActorId: actor.authActorId,
          authActorSource: actor.authActorSource,
        }),
      };
    } catch (error) {
      return { error };
    }
  }

  private async probe(toolName: string, workspaceId: string, context: PolicyContextResult): Promise<ToolVerdict> {
    try {
      const args = this.sources.probeArgs(toolName);
      // The install's guard runs before the engine on a real call, so it is the reason a real call would give.
      if (this.sources.isBlockedByInstall(toolName, args)) return { asks: "unknown", blockedBy: "install_profile" };
      if ("error" in context) return { asks: "unknown", failure: { error: context.error } };
      const { policyContext } = context;
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
    } catch (error) {
      return { asks: "unknown", failure: { error } };
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

/** Each held group's plugins, in the order the holds list them, each plugin once per group. */
function holdersByGroup(
  holds: NonNullable<ToolSettings["pluginToolGroupHolds"]>,
): Map<ToolGroupId, Array<{ pluginId: string; name: string }>> {
  const byGroup = new Map<ToolGroupId, Array<{ pluginId: string; name: string }>>();
  for (const hold of holds) {
    const holders = byGroup.get(hold.groupId) ?? [];
    if (!holders.some((holder) => holder.pluginId === hold.pluginId)) {
      holders.push({ pluginId: hold.pluginId, name: hold.pluginName });
    }
    byGroup.set(hold.groupId, holders);
  }
  return byGroup;
}

function riskiestOf(tools: readonly CapabilityToolItem[]): ToolRiskLevel {
  return tools.reduce<ToolRiskLevel>(
    (riskiest, tool) => (RISK_ORDER.indexOf(tool.risk) > RISK_ORDER.indexOf(riskiest) ? tool.risk : riskiest),
    "safe",
  );
}
