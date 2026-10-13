import {
  buildGovernedActivatedSkillReceipts,
  type SkillContextDocReader,
} from "./governed-skill-instruction-service.js";
import { detectPresentationArtifactIntent, detectDocumentArtifactIntent } from "./chat-artifact-intent.js";
import type { ChatTurnCapabilityTrustedSkill } from "@goatcitadel/contracts";
import type {
  SkillResolveInput,
  SkillListItem,
  SkillRuntimeState,
  SkillActivationPolicy,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CapabilitySystemService } from "./capability-system-service.js";
import type { SkillStateService } from "./skill-state-service.js";
import { resolveCallableSkillSelection } from "./callable-skill-activation.js";
import { logger } from "@goatcitadel/gateway-core";
const log = logger.child("gateway-service");

export interface ChatSkillSelectionRuntimeHost {
  getSkillActivationPolicy(): Promise<SkillActivationPolicy>;
  capabilitySystemService: Pick<CapabilitySystemService, "listSkills" | "listCatalog">;
  skillStateService: Pick<SkillStateService, "readSkillStates" | "recordSkillUsage">;
  storage: Pick<AsyncStorage, "skillAggregateRevisions">;
}

/** Callable nomination remains separate from lifecycle confidence and confirmation. */
export async function resolveChatRuntimeSkillSelection(
  host: ChatSkillSelectionRuntimeHost,
  input: SkillResolveInput,
  recordUsage: boolean,
  workspaceId?: string,
) {
  const policy = await host.getSkillActivationPolicy();
  const selection = resolveCallableSkillSelection(
    {
      request: input,
      loadedSkills: await host.capabilitySystemService.listSkills("ALL", workspaceId),
      inspectableCatalog: await host.capabilitySystemService.listCatalog("inspectable", "ALL", workspaceId),
      callableCatalog: await host.capabilitySystemService.listCatalog("callable", "ALL", workspaceId),
    },
    { mode: policy.selectionMode ?? "legacy" },
  );
  if (selection.ranking) {
    log.debug("Chat skill selection metrics", {
      mode: selection.mode,
      ranking: selection.ranking,
      selectedCount: selection.decision.selected.length,
    });
  }
  const base = selection.decision;
  const stateMap = await host.skillStateService.readSkillStates();
  const selected: Array<
    SkillListItem & {
      confidence: number;
      requiresConfirmation: boolean;
    }
  > = [];
  const suppressed: Array<{
    skill: string;
    state: SkillRuntimeState;
    confidence: number;
    reason: string;
  }> = [];

  for (const skill of base.selected) {
    const reasons = base.reasons[skill.name] ?? [];
    const isExplicit = reasons.includes("explicit");
    const stateRecord = stateMap.get(skill.skillId);
    const state: SkillRuntimeState = stateRecord?.state ?? "enabled";
    const confidence = computeSkillActivationConfidence(reasons, isExplicit);

    if (state === "disabled") {
      suppressed.push({
        skill: skill.name,
        state,
        confidence,
        reason: "skill_disabled",
      });
      continue;
    }

    if (state === "sleep" && !isExplicit && confidence < policy.guardedAutoThreshold) {
      suppressed.push({
        skill: skill.name,
        state,
        confidence,
        reason: "below_guarded_auto_threshold",
      });
      continue;
    }

    const requiresConfirmation =
      state === "sleep" && policy.requireFirstUseConfirmation && !isExplicit && !stateRecord?.firstAutoApprovedAt;

    selected.push({
      ...skill,
      revision:
        stateRecord?.revision ??
        (await host.storage.skillAggregateRevisions.ensure("runtime_skill", skill.skillId)).revision,
      state,
      confidence,
      requiresConfirmation,
    });
  }

  if (recordUsage) {
    await host.skillStateService.recordSkillUsage(selected.map((skill) => skill.skillId));
  }

  return {
    ...base,
    selected,
    suppressed,
  };
}

function computeSkillActivationConfidence(reasons: string[], isExplicit: boolean): number {
  if (isExplicit) {
    return 1;
  }
  if (reasons.includes("keyword")) {
    return 0.84;
  }
  if (reasons.includes("dependency")) {
    return 0.68;
  }
  return 0.5;
}

export async function buildChatRuntimeSkillReceipts(
  host: {
    resolveSkills(
      content: string,
      workspaceId: string,
    ): Promise<import("@goatcitadel/contracts").SkillActivationDecision>;
    listLifecycle(): Promise<import("@goatcitadel/contracts").SkillLifecycleRecord[]>;
    contextDocs(workspaceId: string): SkillContextDocReader;
  },
  input: { content: string; trustedSkills: ChatTurnCapabilityTrustedSkill[]; workspaceId: string },
) {
  return buildGovernedActivatedSkillReceipts({
    content: input.content,
    trustedSkills: input.trustedSkills,
    decision: await host.resolveSkills(input.content, input.workspaceId),
    lifecycleRows: await host.listLifecycle(),
    artifactIntent: {
      presentation: detectPresentationArtifactIntent(input.content),
      document: detectDocumentArtifactIntent(input.content),
    },
    contextDocs: host.contextDocs(input.workspaceId),
  });
}
