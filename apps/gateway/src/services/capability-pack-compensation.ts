import type { AsyncStorage } from "@goatcitadel/storage";
import type {
  CandidateSkillDetailRecord,
  ChangePlanRecord,
  ChangePlanRequest,
  McpServerRecord,
} from "@goatcitadel/contracts";
import type { PackAssetBinding } from "./capability-pack-bindings.js";
import { packCandidateIds } from "./capability-pack-candidate-service.js";
import { packMcpConfigurationHash, type PackMcpCompensationInput } from "./capability-pack-mcp-owner.js";

export interface PackCompensationDependencies {
  storage: AsyncStorage;
  readMcpServers(): Promise<McpServerRecord[]>;
  readSettingsSnapshot(): Promise<{ revision: number; features: Record<string, boolean> }>;
  getCandidateDetail(candidateId: string): Promise<CandidateSkillDetailRecord>;
  createChild(plan: ChangePlanRecord, request: ChangePlanRequest, idempotencyKey: string): Promise<ChangePlanRecord>;
  cancelChild(plan: ChangePlanRecord, child: ChangePlanRecord): Promise<ChangePlanRecord>;
  compensateMcp(input: PackMcpCompensationInput): Promise<void>;
}
export type PackCompensationAsset = { id: string; binding: PackAssetBinding; serverId?: string };
export const PACK_COMPENSATION_STARTED = "pack_compensation:started";

/** Reversal re-enters each owning service. Review/approval of a child reversal
 * remains explicit; the parent never promotes, revokes, or changes flags itself. */
export async function compensatePack(
  deps: PackCompensationDependencies,
  plan: ChangePlanRecord,
  assets: PackCompensationAsset[],
  execute: boolean,
) {
  const evidenceRefs = [...plan.evidenceRefs, PACK_COMPENSATION_STARTED];
  const pending: string[] = [];
  const preserved: string[] = [];
  const handledChildren = new Set<string>();
  for (const asset of assets) {
    const { binding, id } = asset;
    if (binding.owner === "mcp") {
      const mode = plan.rollbackRefs.includes(`pack_compensate_mcp:${id}:created`)
        ? "created"
        : plan.rollbackRefs.includes(`pack_compensate_mcp:${id}:enabled`)
          ? "enabled"
          : undefined;
      if (!mode || !asset.serverId) continue;
      const input: PackMcpCompensationInput = {
        planId: plan.planId,
        serverId: asset.serverId,
        mode,
        configurationHash: packMcpConfigurationHash(binding.input),
      };
      const server = (await deps.readMcpServers()).find((item) => item.serverId === input.serverId);
      if (!server) continue;
      if (execute) {
        try {
          await deps.compensateMcp(input);
        } catch {
          preserved.push(id);
          continue;
        }
      } else if (
        server.enabled ||
        server.packChange?.planId !== plan.planId ||
        packMcpConfigurationHash(server) !== input.configurationHash ||
        !(server.packChange.phase === "compensate" || (mode === "created" && server.packChange.revision === 1))
      ) {
        preserved.push(id);
        continue;
      }
      evidenceRefs.push(`pack_asset:${id}:compensated`);
      continue;
    }
    const childId = binding.owner === "runtime_configuration" ? "runtime-settings" : id;
    if (handledChildren.has(childId)) continue;
    handledChildren.add(childId);
    const child = await deps.storage.changePlans.findByIdempotency(
      plan.origin.workspaceId,
      `pack:${plan.planId}:${childId}`,
    );
    if (!child || child.status === "cancelled") continue;
    const key = `pack:${plan.planId}:compensate:${childId}`;
    const reversal = await deps.storage.changePlans.findByIdempotency(plan.origin.workspaceId, key);
    if (reversal) {
      evidenceRefs.push(`change_plan:${reversal.planId}`);
      if (reversal.status === "completed") evidenceRefs.push(`pack_asset:${id}:compensated`);
      else if (["failed", "cancelled", "rollback_failed"].includes(reversal.status)) preserved.push(id);
      else pending.push(id);
      continue;
    }
    if (["awaiting_input", "awaiting_confirmation"].includes(child.status) && !child.approvalRefs.length) {
      if (execute) {
        try {
          await deps.cancelChild(plan, child);
          evidenceRefs.push(`pack_asset:${id}:review_cancelled`);
        } catch {
          preserved.push(id);
        }
      } else preserved.push(id);
      continue;
    }
    if (child.status !== "completed" || !execute) {
      preserved.push(id);
      continue;
    }
    let request: ChangePlanRequest;
    let expectedRevision: number;
    if (binding.owner === "capability_candidate") {
      if (!plan.rollbackRefs.includes(`pack_compensate_candidate:${id}`) || plan.request.kind !== "capability_pack") {
        preserved.push(id);
        continue;
      }
      const ids = packCandidateIds(plan.origin.workspaceId, plan.request.packId, binding);
      const detail = await deps.getCandidateDetail(ids.candidateId);
      if (!detail.activeVersion) {
        evidenceRefs.push(`pack_asset:${id}:already_inactive`);
        continue;
      }
      const prefix = `capability_candidate:${ids.candidateId}:revision:`;
      const revisions = child.evidenceRefs
        .filter((ref) => ref.startsWith(prefix))
        .map((ref) => Number(ref.slice(prefix.length)));
      expectedRevision = Math.max(-1, ...revisions.filter(Number.isSafeInteger));
      if (detail.activeVersion.versionId !== ids.versionId || detail.revision !== expectedRevision) {
        preserved.push(id);
        continue;
      }
      request = {
        kind: "capability_candidate",
        proposalId: ids.proposalId,
        versionId: ids.versionId,
        action: "revoke",
      };
    } else {
      const settings = await deps.readSettingsSnapshot();
      expectedRevision = child.result?.appliedRevision ?? -1;
      const flags: Record<string, boolean> = {};
      for (const ref of plan.rollbackRefs) {
        const match = /^pack_feature_before:([a-zA-Z0-9]+):(true|false)$/u.exec(ref);
        if (match) flags[match[1]!] = match[2] === "true";
      }
      if (settings.revision !== expectedRevision || !Object.keys(flags).length) {
        preserved.push(id);
        continue;
      }
      request = { kind: "runtime_configuration", change: { operation: "feature_flags", flags } };
    }
    const created = await deps.createChild(plan, request, key);
    if (created.target.expectedRevision !== expectedRevision) {
      // The owner changed between inspection and preparing the reversal.
      await deps.cancelChild(plan, created);
      preserved.push(id);
      continue;
    }
    evidenceRefs.push(`change_plan:${created.planId}`);
    pending.push(id);
  }
  return {
    status: preserved.length
      ? ("manual_required" as const)
      : pending.length
        ? ("monitoring" as const)
        : ("rolled_back" as const),
    evidenceRefs: [...new Set(evidenceRefs)],
    result: {
      summary: preserved.length
        ? `Owned changes were compensated where verified. Later edits or unsettled owner actions were preserved: ${preserved.join(", ")}. Review their owner records before continuing.`
        : pending.length
          ? `Review the linked owner reversal plans for: ${pending.join(", ")}. Completed compensation remains recorded.`
          : "Verified pack-owned changes are compensated. Pre-existing installations and later operator edits are preserved.",
      ...(preserved.length
        ? { failureCode: "pack_compensation_requires_review" }
        : pending.length
          ? { failureCode: "pack_compensation_pending" }
          : {}),
    },
  };
}
