import { createHash } from "node:crypto";
import {
  NotFoundError,
  canonicalJsonString,
  type ChangePlanRuntimeFeatureFlag,
  type AssistantReadinessAction,
  type AssistantReadinessItem,
  type AssistantReadinessResponse,
  type BackgroundLearningDestination,
  type BackgroundLearningReadiness,
} from "@goatcitadel/contracts";
import { prepareAssistantSetupReview, type AssistantSetupReviewDeps } from "./assistant-setup-review-service.js";
export interface AssistantReadinessDeps {
  readSession(
    sessionId: string,
  ): Promise<
    | {
        workspaceId: string;
        sessionId: string;
        sessionIncarnationId?: string;
        active: boolean;
        privateOperator: boolean;
        memoryMode: "auto" | "on" | "off";
        configRevision: number;
        memoryEnabled: boolean;
        flags: Record<string, boolean | undefined>;
      }
    | undefined
  >;
  setupReviewOwner?: AssistantSetupReviewDeps["owner"];
  /** Same learning owner, using passive/cached provider readiness for a read-only view. */
  readLearningReadiness(input: { workspaceId: string; sessionId: string }): Promise<BackgroundLearningReadiness>;
  readFollowThroughReadiness(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<{ followUp: BackgroundLearningDestination; scheduledWork: BackgroundLearningDestination }>;
}
const feature = (flag: ChangePlanRuntimeFeatureFlag, label: string): AssistantReadinessAction => ({
  kind: "review_change_plan",
  href: "/settings/advanced#feature-switches",
  label,
  request: { kind: "runtime_configuration", change: { operation: "feature_flag", flag, enabled: true } },
});
const unavailable: BackgroundLearningDestination = { state: "unavailable", reasonCode: "owner_unavailable" };
export class AssistantReadinessService {
  public constructor(private readonly deps: AssistantReadinessDeps) {}
  public async prepareSetup(input: import("@goatcitadel/contracts").AssistantSetupReviewInput, actorId?: string) {
    const readiness = await this.getAssistantReadiness(input.sessionId, input.workspaceId);
    return prepareAssistantSetupReview(
      {
        readiness,
        owner: this.deps.setupReviewOwner,
        refreshReadiness: () => this.getAssistantReadiness(input.sessionId, input.workspaceId),
      },
      input,
      actorId,
    );
  }
  public async getAssistantReadiness(sessionId: string, workspaceId?: string): Promise<AssistantReadinessResponse> {
    const state = await this.deps.readSession(sessionId);
    if (
      !state ||
      state.sessionId !== sessionId ||
      !state.active ||
      !state.privateOperator ||
      (workspaceId !== undefined && state.workspaceId !== workspaceId)
    )
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    const scope = { workspaceId: state.workspaceId, sessionId };
    const [learning, follow] = await Promise.all([
      this.deps.readLearningReadiness(scope),
      this.deps.readFollowThroughReadiness(scope).catch(() => ({ followUp: unavailable, scheduledWork: unavailable })),
    ]);
    let memory: AssistantReadinessItem = {
      id: "memory",
      label: "Reviewed memory",
      state: "ready",
      scope: "workspace",
      reasons: ["reviewed_memory_available"],
    };
    if (state.memoryMode === "off")
      memory = {
        ...memory,
        state: "disabled",
        scope: "session",
        reasons: ["session_memory_off"],
        nextAction: {
          kind: "open_owner",
          href: "/chat",
          label: "Enable memory for this conversation",
          sessionPreference: { memoryMode: "auto" },
        },
      };
    else if (!state.memoryEnabled)
      memory = {
        ...memory,
        state: "disabled",
        scope: "installation",
        reasons: ["memory_disabled"],
        nextAction: {
          kind: "review_change_plan",
          href: "/settings/memory",
          label: "Review memory setup",
          request: {
            kind: "runtime_configuration",
            change: { operation: "memory_configuration", config: { enabled: true } },
          },
        },
      };
    else if (!state.flags.memoryLifecycleAdminV1Enabled)
      memory = {
        ...memory,
        state: "disabled",
        scope: "installation",
        reasons: ["memory_administration_disabled"],
        nextAction: feature("memoryLifecycleAdminV1Enabled", "Review memory setup"),
      };
    const prerequisite = [learning.source, learning.provider, learning.budget].find((item) => item.state !== "ready");
    let skills: AssistantReadinessItem = {
      id: "skills",
      label: "Reusable skill drafts",
      state: learning.canDraftSkill ? "ready" : (prerequisite?.state ?? learning.skill.state),
      scope: "workspace",
      reasons: learning.canDraftSkill
        ? ["drafts_require_evaluation_and_review"]
        : [prerequisite?.reasonCode ?? learning.skill.reasonCode ?? "not_ready"],
    };
    if (!state.flags.backgroundSkillDraftsV1Enabled)
      skills = {
        ...skills,
        state: "disabled",
        scope: "installation",
        reasons: ["skill_drafts_disabled"],
        nextAction: feature("backgroundSkillDraftsV1Enabled", "Review skill drafting setup"),
      };
    else if (prerequisite?.reasonCode === "provider_unavailable")
      skills.nextAction = { kind: "open_owner", href: "/settings/models", label: "Set up the background model" };
    else if (prerequisite?.reasonCode === "session_memory_off") skills.nextAction = memory.nextAction;
    const followUp: AssistantReadinessItem = {
      id: "follow_up",
      label: "Open commitments",
      state: follow.followUp.state,
      scope: "session",
      reasons: follow.followUp.reasonCode ? [follow.followUp.reasonCode] : ["accepted_commitments_only"],
      nextAction: { kind: "open_owner", href: "/work/schedules", label: "Manage follow-through" },
    };
    if (!state.flags.commitmentScheduledTurnsV1Enabled)
      Object.assign(followUp, {
        state: "disabled",
        scope: "installation",
        reasons: ["commitment_scheduling_disabled"],
        nextAction: feature("commitmentScheduledTurnsV1Enabled", "Review commitment follow-ups"),
      });
    const scheduled: AssistantReadinessItem = {
      id: "scheduled_work",
      label: "Scheduled work",
      state: follow.scheduledWork.state,
      scope: "workspace",
      reasons: follow.scheduledWork.reasonCode ? [follow.scheduledWork.reasonCode] : ["explicit_schedule_required"],
      nextAction: { kind: "open_owner", href: "/work/schedules", label: "Manage schedules" },
    };
    if (follow.scheduledWork.reasonCode === "scheduled_chat_disabled")
      Object.assign(scheduled, {
        scope: "installation",
        nextAction: feature("scheduledChatTurnsV1Enabled", "Review scheduled Chat setup"),
      });
    if (state.flags.autonomyV1Disabled)
      for (const item of [skills, followUp, scheduled]) {
        if (item.state === "unavailable") continue;
        item.state = "blocked";
        item.scope = "installation";
        item.reasons = ["autonomy_disabled"];
        item.nextAction = { kind: "open_owner", href: "/settings/advanced", label: "Review installation autonomy" };
      }
    const indexedRecall: BackgroundLearningDestination =
      memory.state !== "ready"
        ? { state: memory.state, reasonCode: memory.reasons[0] }
        : state.flags.memoryCorpusRecallV1Enabled
          ? { state: "ready" }
          : { state: "disabled", reasonCode: "indexed_recall_disabled" };
    return {
      version: 1,
      ...scope,
      sessionIncarnationId: state.sessionIncarnationId,
      configRevision: state.configRevision,
      sourceHash: createHash("sha256")
        .update(canonicalJsonString([state, learning, follow]))
        .digest("hex"),
      items: [memory, skills, followUp, scheduled],
      learning,
      indexedRecall,
      reviewedSkillUse:state.flags.chatSkillInstructionsV1Enabled ? {state:"ready"}:{state:"disabled",reasonCode:"skill_instructions_disabled"},
      ...(!state.flags.chatSkillInstructionsV1Enabled ? {reviewedSkillUseSetup:feature("chatSkillInstructionsV1Enabled","Review skill use setup")} : {}),
      ...(memory.state === "ready" && !state.flags.memoryCorpusRecallV1Enabled
        ? { indexedRecallSetup: feature("memoryCorpusRecallV1Enabled", "Review indexed memory search") }
        : {}),
    };
  }
}
