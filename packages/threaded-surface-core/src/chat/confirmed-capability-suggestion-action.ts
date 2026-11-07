import type { ChatCapabilityUpgradeSuggestion, ChatMode, SkillListItem } from "@goatcitadel/contracts";
import {
  createCapabilityProposal,
  createCodeModeRun,
  fetchMcpTemplates,
  fetchSkills,
  installSkillImport,
  isApiRequestError,
  updateSkillState,
} from "@goatcitadel/mission-control-shared/api/client";

type Input = {
  suggestion: ChatCapabilityUpgradeSuggestion;
  workspaceId?: string;
  selectedSessionId: string | null;
  selectedTurnId: string | null;
  surfaceMode: ChatMode;
  current: () => boolean;
  setError: (value: string | null) => void;
  setInstalledSkills: React.Dispatch<React.SetStateAction<SkillListItem[]>>;
  pushLocalNotice: (
    content: string,
    tone?: "neutral" | "success" | "warning",
    publicationCurrent?: () => boolean,
  ) => void;
  dismissCapabilitySuggestion: (suggestion: ChatCapabilityUpgradeSuggestion) => void;
  resumeCapabilitySuggestionTurn: () => Promise<void>;
};

/** Code for explicitly confirmed actions. The hook retains confirmation and owner admission. */
export async function runConfirmedCapabilitySuggestionAction({
  suggestion,
  workspaceId,
  selectedSessionId,
  selectedTurnId,
  surfaceMode,
  current,
  setError,
  setInstalledSkills,
  pushLocalNotice,
  dismissCapabilitySuggestion,
  resumeCapabilitySuggestionTurn,
}: Input): Promise<void> {
  if (!current()) return;
  try {
    if (suggestion.recommendedAction === "enable_skill") {
      if (!suggestion.candidateId) {
        throw new Error("This suggestion is missing the installed skill identifier.");
      }
      const canonical = await fetchSkills();
      if (!current()) return;
      setInstalledSkills((previous) => (current() ? canonical.items : previous));
      const expectedRevision = readCanonicalSkillRevision(canonical.items, suggestion.candidateId);
      // HX-402 P2: skill state changes are approval-first; this only
      // requests one canonical skill.lifecycle approval.
      const outcome = await updateSkillState(suggestion.candidateId, {
        expectedRevision,
        state: "enabled",
        note: "Enabled from chat capability suggestion.",
      });
      if (!current()) return;
      if (outcome.pendingApproval) {
        pushLocalNotice(
          `Approval requested to enable skill ${suggestion.candidateId} (approval ${outcome.pendingApproval.approvalId}). Resolve it in Approvals, then retry your request.`,
          "warning",
          current,
        );
        dismissCapabilitySuggestion(suggestion);
        return;
      }
      pushLocalNotice(
        `Skill ${suggestion.candidateId} is already enabled. Resuming the original request now.`,
        "success",
        current,
      );
      const refreshed = await fetchSkills();
      if (!current()) return;
      setInstalledSkills((previous) => (current() ? refreshed.items : previous));
      dismissCapabilitySuggestion(suggestion);
      await resumeCapabilitySuggestionTurn();
      return;
    }

    if (
      suggestion.recommendedAction === "install_skill_disabled" ||
      suggestion.recommendedAction === "install_skill_enable"
    ) {
      if (!suggestion.sourceRef) {
        throw new Error("This suggestion is missing the import source.");
      }
      // HX-402 P2: the legacy executable install is retired — the gateway
      // validates and redirects into the governed Skill Hub review.
      const redirected = await installSkillImport({
        sourceRef: suggestion.sourceRef,
        sourceProvider:
          suggestion.sourceProvider &&
          suggestion.sourceProvider !== "mcp_template" &&
          suggestion.sourceProvider !== "code_mode"
            ? suggestion.sourceProvider
            : undefined,
        confirmHighRisk: suggestion.riskLevel === "high",
      });
      if (!current()) return;
      const redirect = redirected?.redirect;
      pushLocalNotice(
        redirect?.eligible
          ? `Validated the suggested skill. Installs are governed by the Skill Hub: review ${redirect.sourceRef} there and resolve its approval before it can run.`
          : `Validated the suggested skill, but it cannot be installed: ${
              redirect?.ineligibleReason ?? "the source is not eligible for the governed Skill Hub review."
            }`,
        "warning",
        current,
      );
      dismissCapabilitySuggestion(suggestion);
      window.location.hash = "skills";
      return;
    }

    if (suggestion.recommendedAction === "add_mcp_template") {
      if (!suggestion.sourceRef) {
        throw new Error("This suggestion is missing the template reference.");
      }
      const templateId = suggestion.sourceRef.replace(/^mcp-template:\/\//, "");
      await fetchMcpTemplates();
      if (!current()) return;
      window.location.hash = `mcp?template=${encodeURIComponent(templateId)}`;
      dismissCapabilitySuggestion(suggestion);
      return;
    }

    if (suggestion.recommendedAction === "build_code_mode_skill_candidate") {
      if (!selectedSessionId) {
        throw new Error("A selected session is required before GoatCitadel can stage a reusable capability.");
      }
      let builders: typeof import("./capability-candidate-builders.js");
      try {
        builders = await import("./capability-candidate-builders.js");
      } catch (cause) {
        if (!current()) return;
        throw cause;
      }
      if (!current()) return;
      const {
        buildCapabilityCandidateId,
        buildCandidateSkillMarkdown,
        buildSkillName,
        CODE_MODE_CAPABILITY_CANDIDATE_SOURCE,
      } = builders;
      const candidateId =
        suggestion.candidateId ?? buildCapabilityCandidateId(selectedSessionId, selectedTurnId, suggestion.title);
      const sourceTurnId = suggestion.sourceTurnId ?? selectedTurnId ?? undefined;
      const skillMarkdown = buildCandidateSkillMarkdown(suggestion);
      const proposal = await createCapabilityProposal({
        proposalKind: "skill",
        title: suggestion.title,
        summary: suggestion.summary,
        candidateId,
        payload: {
          proposalSource: "chat_capability_gap",
          codeMode: {
            sourceSessionId: suggestion.sourceSessionId ?? selectedSessionId,
            sourceTurnId,
            gapSummary: suggestion.summary,
            intendedBehavior: suggestion.intendedBehavior ?? suggestion.summary,
            candidateType: suggestion.candidateType ?? "self_generated_skill",
            requiredPermissions: suggestion.requiredPermissions ?? [],
            validationExpectation: suggestion.validationExpectation,
            rollbackPosture: suggestion.rollbackPosture,
          },
          rationale: suggestion.reason,
        },
      });
      if (!current()) return;
      const codeModeRun = await createCodeModeRun({
        language: "javascript",
        source: CODE_MODE_CAPABILITY_CANDIDATE_SOURCE,
        originSurface: surfaceMode,
        workspaceId,
        sessionId: selectedSessionId,
        turnId: sourceTurnId,
        requestedOutputIntent: suggestion.intendedBehavior ?? suggestion.summary,
        saveCandidateOnSuccess: true,
        input: {
          capabilityProposal: {
            proposalId: proposal.proposalId,
            candidateId,
            title: proposal.title,
            summary: proposal.summary,
            sourceSessionId: suggestion.sourceSessionId ?? selectedSessionId,
            sourceTurnId,
          },
          candidateSkillMarkdown: skillMarkdown,
          skillName: buildSkillName(suggestion.title),
          intendedBehavior: suggestion.intendedBehavior ?? suggestion.summary,
          requiredPermissions: suggestion.requiredPermissions ?? [],
          validationExpectation: suggestion.validationExpectation,
          rollbackPosture: suggestion.rollbackPosture,
        },
      });
      if (!current()) return;
      pushLocalNotice(
        `Created proposal ${proposal.proposalId} and queued governed capability build ${codeModeRun.runId} for approval.`,
        "success",
        current,
      );
      dismissCapabilitySuggestion(suggestion);
      return;
    }
    throw new Error("Unsupported confirmed capability action.");
  } catch (err) {
    if (!current()) return;
    // HX-402 P2: install-and-enable no longer exists (the retired install
    // redirects into the governed Skill Hub), so the only conflicted
    // subject is the enable_skill candidate itself.
    if (isSkillWriteConflict(err)) {
      const conflictedSkillId = suggestion.candidateId;
      if (conflictedSkillId) {
        try {
          const refreshed = await fetchSkills();
          if (!current()) return;
          setInstalledSkills((previous) => (current() ? refreshed.items : previous));
        } catch (refreshError) {
          if (!current()) return;
          setError(
            `Skill ${conflictedSkillId} changed elsewhere and the canonical refresh failed: ${errorMessage(refreshError)} No update or turn retry was replayed; retry explicitly.`,
          );
          return;
        }
      }
      setError(
        `Skill ${conflictedSkillId ?? "state"} changed elsewhere. Canonical skills were refreshed; no update or turn retry was replayed. Review the refreshed state and retry explicitly.`,
      );
      return;
    }
    setError(errorMessage(err));
  }
}

function readCanonicalSkillRevision(items: SkillListItem[], skillId: string): number {
  const revision = items.find((item) => item.skillId === skillId)?.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Skill ${skillId} is missing a positive canonical revision. Refresh skills and retry explicitly.`);
  }
  return revision;
}

function isSkillWriteConflict(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || !isRecord(error.body)) {
    return false;
  }
  return error.body.code === "WRITE_CONFLICT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
