import {
  ConflictError,
  SemanticValidationError,
  type CapabilityPackManifest,
  type ChangePlanCapabilityPackRequest,
  type ChangePlanRecord,
  type ChangePlanRequest,
  type CandidateSkillDetailRecord,
  type McpServerCreateInput,
  type McpServerRecord,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
} from "./evolution-control-plane-adapter.js";
import { packBindingHash, resolvePackAssetBinding, type PackAssetBinding } from "./capability-pack-bindings.js";
import { packCandidateIds, stagePackSkillCandidate } from "./capability-pack-candidate-service.js";
import { packMcpConfiguration as mcpConfiguration } from "./capability-pack-mcp-owner.js";
import {
  compensatePack,
  PACK_COMPENSATION_STARTED,
  type PackCompensationDependencies,
} from "./capability-pack-compensation.js";

interface Dependencies extends PackCompensationDependencies {
  rootDir: string;
  candidateRoot: string;
  listPacks(): CapabilityPackManifest[];
  readMcpServers(): Promise<McpServerRecord[]>;
  readMcpTools(): Promise<McpToolRecord[]>;
  createMcpServer(input: McpServerCreateInput, serverId: string, planId: string): Promise<McpServerRecord>;
  enableMcpServer(serverId: string, planId: string): Promise<McpServerRecord>;
  connectMcpServer(serverId: string): Promise<McpServerRecord>;
  readFeatures(): Promise<Record<string, boolean>>;
  getCandidateDetail(candidateId: string): Promise<CandidateSkillDetailRecord>;
  createChild(plan: ChangePlanRecord, request: ChangePlanRequest, idempotencyKey: string): Promise<ChangePlanRecord>;
}

/** Coordinates existing owners; a recorded approval alone never proves a pack ready. */
export class CapabilityPackChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanCapabilityPackRequest> {
  readonly adapterId = "capability-pack-execution";
  readonly version = 1;
  readonly kinds = ["capability_pack"] as const;
  constructor(private readonly deps: Dependencies) {}

  async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanCapabilityPackRequest) {
    const { manifest, assets } = this.resolve(request);
    const snapshot = await this.snapshot(context.origin.workspaceId, request, assets);
    return {
      target: {
        ownerId: "capability_pack",
        resourceId: `${context.origin.workspaceId}:${manifest.packId}`,
        expectedHash: packBindingHash(snapshot),
      },
      title: `Set up ${manifest.name}`,
      summary: `Set up ${assets.length} selected assets through their existing owners.`,
      impact:
        "This can register, enable, and connect a shared MCP server. Skills and settings have separate review actions. Existing tool approvals and policy remain authoritative.",
      risk: "danger" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: "Review pack execution",
        confirmationText: `Set up ${assets.map(({ id }) => id).join(", ")} from ${manifest.name} ${manifest.version}. Connection may download the pinned tool server; first tool use still requires approval.`,
      }),
      evidenceRefs: [`pack_manifest:${request.manifestHash}`],
      rollbackRefs: snapshot.rollbackRefs,
    };
  }

  async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const { assets } = this.resolve(request);
    if (packBindingHash(await this.snapshot(plan.origin.workspaceId, request, assets)) !== plan.target.expectedHash) {
      throw new ConflictError({ message: "Pack owner state changed after review. Review a fresh execution plan." });
    }
    const refs = [...plan.evidenceRefs];
    // Create reviewable child records before launching any external process.
    for (const asset of assets) {
      if (asset.binding.owner === "capability_candidate") {
        const ids = await stagePackSkillCandidate(this.deps, plan, request.packId, asset.binding);
        refs.push(`pack_asset:${asset.id}:candidate:${ids.versionId}`);
        const existing = await this.deps.getCandidateDetail(ids.candidateId);
        if (
          existing.activeVersion?.versionId === ids.versionId &&
          ["approved", "trusted"].includes(existing.activeVersion.lifecycleState) &&
          !existing.activationBlocked
        ) {
          continue;
        }
        const child = await this.child(plan, asset.id, {
          kind: "capability_candidate",
          proposalId: ids.proposalId,
          versionId: ids.versionId,
        });
        refs.push(`change_plan:${child.planId}`);
      }
    }
    const currentFeatures = await this.deps.readFeatures();
    const flags = Object.fromEntries(
      assets.flatMap(({ binding }) =>
        binding.owner === "runtime_configuration" &&
        binding.request.change.operation === "feature_flag" &&
        currentFeatures[binding.request.change.flag] !== binding.request.change.enabled
          ? [[binding.request.change.flag, binding.request.change.enabled]]
          : [],
      ),
    );
    if (Object.keys(flags).length) {
      const child = await this.child(plan, "runtime-settings", {
        kind: "runtime_configuration",
        change: { operation: "feature_flags", flags },
      });
      refs.push(`change_plan:${child.planId}`);
    }
    for (const asset of assets)
      if (asset.binding.owner === "mcp") {
        const serverId = packMcpServerId(plan.origin.workspaceId, request.packId, asset.binding);
        let server = (await this.deps.readMcpServers()).find((item) => item.serverId === serverId);
        try {
          if (!server) server = await this.deps.createMcpServer(asset.binding.input, serverId, plan.planId);
          assertMcpBinding(server, asset.binding);
          if (!server.enabled) server = await this.deps.enableMcpServer(serverId, plan.planId);
          if (server.status !== "connected") await this.deps.connectMcpServer(serverId);
        } catch {
          return {
            status: "manual_required" as const,
            evidenceRefs: [...refs, `pack_asset:${asset.id}:connection_failed`],
            result: {
              summary:
                "The MCP connection did not complete. Existing child reviews are retained. Inspect MCP diagnostics before retrying setup.",
              failureCode: "pack_connection_failed",
            },
          };
        }
        refs.push(`pack_asset:${asset.id}:mcp:${serverId}`);
      }
    const observation = await this.observe(plan);
    return { ...observation, evidenceRefs: [...new Set([...refs, ...observation.evidenceRefs])] };
  }

  async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observe(plan);
    return { ...observed, effectObserved: observed.status === "completed" || observed.status === "rolled_back" };
  }

  async rollback(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    return this.compensate(plan, true);
  }

  private async compensate(plan: ChangePlanRecord, execute: boolean) {
    const request = requireRequest(plan);
    const { assets } = this.resolve(request);
    return compensatePack(
      this.deps,
      plan,
      assets.map((asset) => ({
        ...asset,
        ...(asset.binding.owner === "mcp"
          ? {
              serverId: packMcpServerId(plan.origin.workspaceId, request.packId, asset.binding),
            }
          : {}),
      })),
      execute,
    );
  }

  async verify(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    return this.observe(plan);
  }

  private async child(plan: ChangePlanRecord, assetId: string, request: ChangePlanRequest) {
    const key = `pack:${plan.planId}:${assetId}`;
    return (
      (await this.deps.storage.changePlans.findByIdempotency(plan.origin.workspaceId, key)) ??
      (await this.deps.createChild(plan, request, key))
    );
  }

  private resolve(request: ChangePlanCapabilityPackRequest) {
    const manifest = this.deps.listPacks().find((pack) => pack.packId === request.packId);
    if (
      !manifest ||
      manifest.provenance.contentHash !== request.manifestHash ||
      new Set(request.assetIds).size !== request.assetIds.length ||
      !request.assetIds.length
    ) {
      throw new ConflictError({ message: "The reviewed pack manifest is unavailable or changed." });
    }
    const assets = request.assetIds.map((id) => {
      const asset = manifest.assets.find((item) => item.id === id);
      const binding = asset ? resolvePackAssetBinding(manifest.packId, asset) : undefined;
      if (!asset?.binding || !binding || asset.binding.sha256 !== packBindingHash(binding)) {
        throw new SemanticValidationError(`Pack asset ${id} has no reviewed execution binding.`);
      }
      return { id, binding };
    });
    return { manifest, assets };
  }

  private async snapshot(
    workspaceId: string,
    request: ChangePlanCapabilityPackRequest,
    assets: { id: string; binding: PackAssetBinding }[],
  ) {
    const servers = await this.deps.readMcpServers();
    const features = await this.deps.readFeatures();
    const rollbackRefs: string[] = ["pack_compensation:v1"];
    const states = [];
    for (const { id, binding } of assets) {
      if (binding.owner === "mcp") {
        const server = servers.find((item) => item.serverId === packMcpServerId(workspaceId, request.packId, binding));
        if (server) assertMcpBinding(server, binding);
        states.push({ id, server: server ? { ...mcpConfiguration(server), enabled: server.enabled } : null });
        if (!server || !server.enabled)
          rollbackRefs.push(`pack_compensate_mcp:${id}:${server ? "enabled" : "created"}`);
      } else if (binding.owner === "capability_candidate") {
        const ids = packCandidateIds(workspaceId, request.packId, binding);
        const revision = await this.deps.storage.skillAggregateRevisions.get("candidate_skill", ids.candidateId);
        states.push({ id, revision: revision?.revision ?? 0 });
        const version = await this.deps.storage.candidateSkillVersions.find(ids.versionId);
        if (!version || !(await this.deps.getCandidateDetail(ids.candidateId)).activeVersion) {
          rollbackRefs.push(`pack_compensate_candidate:${id}`);
        }
      } else {
        const change = binding.request.change;
        const flag = change.operation === "feature_flag" ? change.flag : undefined;
        states.push({ id, bindingHash: packBindingHash(binding), enabled: flag ? features[flag] : undefined });
        if (
          flag &&
          typeof features[flag] === "boolean" &&
          change.operation === "feature_flag" &&
          features[flag] !== change.enabled
        ) {
          rollbackRefs.push(`pack_feature_before:${flag}:${features[flag]}`);
        }
      }
    }
    return { manifestHash: request.manifestHash, states, rollbackRefs };
  }

  private async observe(plan: ChangePlanRecord) {
    if (plan.status === "rolling_back" || plan.evidenceRefs.includes(PACK_COMPENSATION_STARTED)) {
      return this.compensate(plan, false);
    }
    const request = requireRequest(plan);
    const { assets } = this.resolve(request);
    const [servers, tools, features] = await Promise.all([
      this.deps.readMcpServers(),
      this.deps.readMcpTools(),
      this.deps.readFeatures(),
    ]);
    const evidenceRefs = [...plan.evidenceRefs];
    const pending: string[] = [];
    let failed = false;
    for (const { id, binding } of assets) {
      let ready = false;
      if (binding.owner === "mcp") {
        const server = servers.find(
          (item) => item.serverId === packMcpServerId(plan.origin.workspaceId, request.packId, binding),
        );
        if (server) {
          assertMcpBinding(server, binding);
          ready =
            server.enabled &&
            server.status === "connected" &&
            binding.requiredTools.every((name) =>
              tools.some((tool) => tool.serverId === server.serverId && tool.toolName === name && tool.enabled),
            );
        }
      } else if (binding.owner === "capability_candidate") {
        const ids = packCandidateIds(plan.origin.workspaceId, request.packId, binding);
        const candidate = await this.deps.storage.candidateSkillVersions.find(ids.versionId);
        if (candidate) {
          const detail = await this.deps.getCandidateDetail(ids.candidateId);
          ready =
            detail.activeVersion?.versionId === ids.versionId &&
            ["approved", "trusted"].includes(detail.activeVersion.lifecycleState) &&
            !detail.activationBlocked;
        }
      } else {
        const change = binding.request.change;
        ready = change.operation === "feature_flag" && features[change.flag] === change.enabled;
      }
      const child = await this.deps.storage.changePlans.findByIdempotency(
        plan.origin.workspaceId,
        `pack:${plan.planId}:${binding.owner === "runtime_configuration" ? "runtime-settings" : id}`,
      );
      if (child) {
        evidenceRefs.push(`change_plan:${child.planId}`);
        if (["failed", "cancelled", "rolled_back", "rollback_failed"].includes(child.status)) failed = true;
        if (child.status !== "completed") ready = false;
      }
      evidenceRefs.push(`pack_asset:${id}:${ready ? "ready" : "pending"}`);
      if (!ready) pending.push(id);
    }
    return {
      status: !pending.length ? ("completed" as const) : failed ? ("failed" as const) : ("monitoring" as const),
      evidenceRefs: [...new Set(evidenceRefs)],
      result: {
        summary: !pending.length
          ? "Selected pack assets are ready according to their runtime owners. Tool invocation remains policy-governed."
          : `Waiting for owner actions: ${pending.join(", ")}. Review linked skill/settings plans and MCP tool discovery. After an interrupted connection, use MCP diagnostics before retrying.`,
        ...(failed ? { failureCode: "pack_child_failed" } : {}),
      },
    };
  }
}

export const packMcpServerId = (workspaceId: string, packId: string, binding: PackAssetBinding) =>
  `pack-${packBindingHash({ workspaceId, packId, binding }).slice(0, 40)}`;
const requireRequest = (plan: ChangePlanRecord): ChangePlanCapabilityPackRequest => {
  if (plan.request.kind !== "capability_pack") throw new SemanticValidationError("Expected capability pack request.");
  return plan.request;
};
function assertMcpBinding(server: McpServerRecord, binding: Extract<PackAssetBinding, { owner: "mcp" }>) {
  if (packBindingHash(mcpConfiguration(server)) !== packBindingHash(mcpConfiguration(binding.input))) {
    throw new ConflictError({ message: "The pack MCP server differs from its reviewed configuration." });
  }
}
