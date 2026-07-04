import type {
  ChatCapabilityUpgradeSuggestion,
  ChatSessionRecord,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import { useCallback, useMemo, useState, type MutableRefObject } from "react";
import {
  activateImportedAgentCatalogEntry,
  createChatSpecialistCandidate,
  createCapabilityProposal,
  createCodeModeRun,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  installSkillImport,
  updateChatSpecialistCandidate,
  updateSkillState,
} from "@goatcitadel/mission-control-shared/api/client";
import { getCapabilitySuggestionConfirmationCopy } from "./chat-page-pure-helpers";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

export function useChatSpecialistCapabilityActions(input: {
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  selectedTurnId: string | null;
  sending: boolean;
  setError: (value: string | null) => void;
  setSending: (value: boolean) => void;
  setSpecialistCandidates: React.Dispatch<React.SetStateAction<ChatSpecialistCandidateRecord[]>>;
  setInstalledSkills: React.Dispatch<React.SetStateAction<SkillListItem[]>>;
  setMcpServers: React.Dispatch<React.SetStateAction<McpServerRecord[]>>;
  setMcpTemplates: React.Dispatch<React.SetStateAction<Array<McpServerTemplateRecord & { installed: boolean }>>>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  executeOutboundItemRef: MutableRefObject<(item: OutboundQueueItem) => Promise<void>>;
  tryBeginOutboundExecutionRef: MutableRefObject<() => boolean>;
  setQueuedOutbound: React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>;
}) {
  const {
    selectedSessionId,
    selectedSession,
    selectedTurnId,
    sending,
    setError,
    setSending,
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    setQueuedOutbound,
  } = input;

  const [capabilitySuggestions, setCapabilitySuggestions] = useState<ChatCapabilityUpgradeSuggestion[]>([]);
  const [specialistSuggestions, setSpecialistSuggestions] = useState<ChatSpecialistCandidateSuggestionRecord[]>([]);
  const [capabilitySuggestionConfirm, setCapabilitySuggestionConfirm] =
    useState<ChatCapabilityUpgradeSuggestion | null>(null);
  const [capabilitySuggestionPending, setCapabilitySuggestionPending] = useState(false);

  const capabilityConfirmationCopy = useMemo(
    () => (capabilitySuggestionConfirm ? getCapabilitySuggestionConfirmationCopy(capabilitySuggestionConfirm) : null),
    [capabilitySuggestionConfirm],
  );

  const handleCreateSpecialistDraft = useCallback(
    async (suggestion: ChatSpecialistCandidateSuggestionRecord) => {
      if (!selectedSession || sending) {
        return;
      }
      setSending(true);
      try {
        const created = await createChatSpecialistCandidate(selectedSession.sessionId, {
          turnId: selectedTurnId ?? undefined,
          suggestion,
        });
        setSpecialistCandidates((current) => {
          const withoutCurrent = current.filter((item) => item.candidateId !== created.candidateId);
          return [created, ...withoutCurrent];
        });
        setSpecialistSuggestions((current) =>
          current.filter((item) => JSON.stringify(item) !== JSON.stringify(suggestion)),
        );
        pushLocalNotice(`Drafted specialist candidate: ${created.title}.`, "success");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    },
    [pushLocalNotice, selectedSession, selectedTurnId, sending, setError, setSending, setSpecialistCandidates],
  );

  const handleSpecialistCandidatePatch = useCallback(
    async (candidateId: string, patch: ChatSpecialistCandidatePatchInput, notice: string) => {
      if (!selectedSession || sending) {
        return;
      }
      setSending(true);
      try {
        const updated = await updateChatSpecialistCandidate(selectedSession.sessionId, candidateId, patch);
        setSpecialistCandidates((current) =>
          current.map((item) => (item.candidateId === updated.candidateId ? updated : item)),
        );
        pushLocalNotice(notice, "success");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    },
    [pushLocalNotice, selectedSession, sending, setError, setSending, setSpecialistCandidates],
  );

  const handleActivateCatalogSpecialist = useCallback(
    async (suggestion: ChatSpecialistCandidateSuggestionRecord) => {
      if (!selectedSession || sending) {
        return;
      }
      if (!suggestion.candidateId) {
        setError("Catalog suggestion is missing its entry identifier.");
        return;
      }
      setSending(true);
      try {
        const activated = await activateImportedAgentCatalogEntry(suggestion.candidateId, {
          sessionId: selectedSession.sessionId,
        });
        setSpecialistCandidates((current) => {
          const withoutCurrent = current.filter((item) => item.candidateId !== activated.specialist.candidateId);
          return [activated.specialist, ...withoutCurrent];
        });
        setSpecialistSuggestions((current) => current.filter((item) => item.candidateId !== suggestion.candidateId));
        pushLocalNotice(
          `Activated ${activated.catalogEntry.definition.frontmatter.name} for this session as a manual-only specialist.`,
          "success",
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    },
    [pushLocalNotice, selectedSession, sending, setError, setSending, setSpecialistCandidates],
  );

  const dismissCapabilitySuggestion = useCallback((suggestion: ChatCapabilityUpgradeSuggestion) => {
    setCapabilitySuggestions((current) =>
      current.filter(
        (item) =>
          item.kind !== suggestion.kind ||
          (item.candidateId ?? item.title) !== (suggestion.candidateId ?? suggestion.title),
      ),
    );
  }, []);

  const resumeCapabilitySuggestionTurn = useCallback(async () => {
    if (!selectedTurnId) {
      pushLocalNotice("Capability upgraded, but there is no failed turn selected to resume yet.", "warning");
      return;
    }
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: "retry",
      sessionId: selectedSessionId ?? undefined,
      targetTurnId: selectedTurnId,
      content: "",
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    if (!tryBeginOutboundExecutionRef.current()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      pushLocalNotice("Capability upgraded. The original request has been queued to resume automatically.");
      return;
    }
    await executeOutboundItemRef.current(nextItem);
  }, [
    executeOutboundItemRef,
    pushLocalNotice,
    selectedSessionId,
    selectedTurnId,
    setQueuedOutbound,
    tryBeginOutboundExecutionRef,
  ]);

  const runCapabilitySuggestionAction = useCallback(
    async (suggestion: ChatCapabilityUpgradeSuggestion) => {
      try {
        setError(null);
        if (suggestion.recommendedAction === "enable_skill") {
          if (!suggestion.candidateId) {
            throw new Error("This suggestion is missing the installed skill identifier.");
          }
          const updated = await updateSkillState(suggestion.candidateId, {
            state: "enabled",
            note: "Enabled from chat capability suggestion.",
          });
          pushLocalNotice(`Enabled skill ${updated.skillId}. Resuming the original request now.`, "success");
          setInstalledSkills(await fetchSkills().then((result) => result.items));
          dismissCapabilitySuggestion(suggestion);
          await resumeCapabilitySuggestionTurn();
          return;
        }

        if (suggestion.recommendedAction === "install_skill_disabled") {
          if (!suggestion.sourceRef) {
            throw new Error("This suggestion is missing the import source.");
          }
          const installed = await installSkillImport({
            sourceRef: suggestion.sourceRef,
            sourceProvider:
              suggestion.sourceProvider &&
              suggestion.sourceProvider !== "mcp_template" &&
              suggestion.sourceProvider !== "code_mode"
                ? suggestion.sourceProvider
                : undefined,
            confirmHighRisk: suggestion.riskLevel === "high",
          });
          pushLocalNotice(
            installed.installedSkillId
              ? `Installed ${installed.installedSkillId}. It remains disabled by default until you enable it.`
              : "Installed the suggested skill. It remains disabled by default until you enable it.",
            "success",
          );
          setInstalledSkills(await fetchSkills().then((result) => result.items));
          dismissCapabilitySuggestion(suggestion);
          window.location.hash = "skills";
          return;
        }

        if (suggestion.recommendedAction === "install_skill_enable") {
          if (!suggestion.sourceRef) {
            throw new Error("This suggestion is missing the import source.");
          }
          const installed = await installSkillImport({
            sourceRef: suggestion.sourceRef,
            sourceProvider:
              suggestion.sourceProvider &&
              suggestion.sourceProvider !== "mcp_template" &&
              suggestion.sourceProvider !== "code_mode"
                ? suggestion.sourceProvider
                : undefined,
            confirmHighRisk: suggestion.riskLevel === "high",
          });
          if (!installed.installedSkillId) {
            throw new Error("The skill installed, but GoatCitadel could not resolve its installed skill identifier.");
          }
          await updateSkillState(installed.installedSkillId, {
            state: "enabled",
            note: "Enabled immediately from chat capability suggestion.",
          });
          pushLocalNotice(
            `Installed and enabled ${installed.installedSkillId}. Resuming the original request now.`,
            "success",
          );
          setInstalledSkills(await fetchSkills().then((result) => result.items));
          dismissCapabilitySuggestion(suggestion);
          await resumeCapabilitySuggestionTurn();
          return;
        }

        if (suggestion.recommendedAction === "add_mcp_template") {
          if (!suggestion.sourceRef) {
            throw new Error("This suggestion is missing the template reference.");
          }
          const templateId = suggestion.sourceRef.replace(/^mcp-template:\/\//, "");
          await fetchMcpTemplates();
          window.location.hash = `mcp?template=${encodeURIComponent(templateId)}`;
          dismissCapabilitySuggestion(suggestion);
          return;
        }

        if (suggestion.recommendedAction === "switch_tool_profile") {
          window.location.hash = "tools";
          dismissCapabilitySuggestion(suggestion);
          return;
        }

        if (suggestion.recommendedAction === "build_code_mode_skill_candidate") {
          if (!selectedSessionId) {
            throw new Error("A selected session is required before Code Mode can build a reusable capability.");
          }
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
          const codeModeRun = await createCodeModeRun({
            language: "javascript",
            source: CODE_MODE_CAPABILITY_CANDIDATE_SOURCE,
            originSurface: "code",
            workspaceId: selectedSession?.workspaceId,
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
          pushLocalNotice(
            `Created proposal ${proposal.proposalId} and queued Code Mode run ${codeModeRun.runId} for approval.`,
            "success",
          );
          dismissCapabilitySuggestion(suggestion);
          window.location.hash = "skills";
          return;
        }

        if (suggestion.recommendedAction === "connect_mcp") {
          setMcpServers(await fetchMcpServers().then((result) => result.items));
          setMcpTemplates(await fetchMcpTemplates().then((result) => result.items));
          window.location.hash = "mcp";
          dismissCapabilitySuggestion(suggestion);
          return;
        }

        throw new Error(`Unsupported capability action: ${suggestion.recommendedAction}`);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [
      dismissCapabilitySuggestion,
      pushLocalNotice,
      resumeCapabilitySuggestionTurn,
      selectedSession?.workspaceId,
      selectedSessionId,
      selectedTurnId,
      setError,
      setInstalledSkills,
      setMcpServers,
      setMcpTemplates,
    ],
  );

  const handleCapabilitySuggestionAction = useCallback(
    (suggestion: ChatCapabilityUpgradeSuggestion) => {
      const confirmation = getCapabilitySuggestionConfirmationCopy(suggestion);
      if (confirmation) {
        setCapabilitySuggestionConfirm(suggestion);
        return;
      }
      void runCapabilitySuggestionAction(suggestion);
    },
    [runCapabilitySuggestionAction],
  );

  const confirmCapabilitySuggestionAction = useCallback(async () => {
    if (!capabilitySuggestionConfirm) {
      return;
    }
    setCapabilitySuggestionPending(true);
    try {
      await runCapabilitySuggestionAction(capabilitySuggestionConfirm);
    } finally {
      setCapabilitySuggestionPending(false);
      setCapabilitySuggestionConfirm(null);
    }
  }, [capabilitySuggestionConfirm, runCapabilitySuggestionAction]);

  return {
    capabilitySuggestions,
    setCapabilitySuggestions,
    specialistSuggestions,
    setSpecialistSuggestions,
    capabilitySuggestionConfirm,
    setCapabilitySuggestionConfirm,
    capabilitySuggestionPending,
    capabilityConfirmationCopy,
    handleCreateSpecialistDraft,
    handleActivateCatalogSpecialist,
    handleSpecialistCandidatePatch,
    handleCapabilitySuggestionAction,
    confirmCapabilitySuggestionAction,
  };
}

const CODE_MODE_CAPABILITY_CANDIDATE_SOURCE = `
const skillMarkdown = typeof input.candidateSkillMarkdown === "string" ? input.candidateSkillMarkdown : "";
if (!skillMarkdown.trim()) {
  throw new Error("Candidate skill markdown is required.");
}
return {
  candidateKind: "self_generated_skill",
  candidateSkillMarkdown: skillMarkdown,
  proposedCapability: input.capabilityProposal ?? {},
  validationNotes: [
    "Generated as a non-callable candidate.",
    "Activation remains governed by capability proposal approval."
  ]
};
`.trim();

function buildCapabilityCandidateId(sessionId: string, turnId: string | null, title: string): string {
  const seed = `${sessionId}:${turnId ?? "none"}:${title}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `candidate-${hash.toString(16).padStart(8, "0")}`;
}

function buildCandidateSkillMarkdown(suggestion: ChatCapabilityUpgradeSuggestion): string {
  const skillName = buildSkillName(suggestion.title);
  const description = sanitizeSkillMarkdownText(
    suggestion.intendedBehavior ??
      suggestion.summary ??
      "Reusable GoatCitadel capability candidate generated from a capability gap.",
  );
  const requiredPermissions =
    suggestion.requiredPermissions && suggestion.requiredPermissions.length > 0
      ? suggestion.requiredPermissions.map((item) => `- ${sanitizeSkillMarkdownText(item)}`).join("\n")
      : "- No additional permissions requested by the initial candidate.";
  return [
    "---",
    `name: ${quoteYamlScalar(skillName)}`,
    `description: ${quoteYamlScalar(description)}`,
    "---",
    "",
    `# ${skillName}`,
    "",
    "## When to use",
    sanitizeSkillMarkdownText(
      suggestion.intendedBehavior ??
        "Use this candidate after it has been approved to handle requests matching the original capability gap.",
    ),
    "",
    "## When not to use",
    "- Do not use while this candidate is proposed, validating, rejected, revoked, deprecated, or failed.",
    "- Do not bypass GoatCitadel policy, approvals, path jails, or capability lifecycle checks.",
    "",
    "## Required inputs",
    "- The user request that triggered the reusable workflow.",
    "- Any workspace context the approved skill explicitly asks for.",
    "",
    "## Required permissions",
    requiredPermissions,
    "",
    "## Workflow",
    "- Confirm the request still matches this approved skill.",
    "- Gather the minimum context needed for the workflow.",
    "- Use only callable tools and approved runtime capabilities.",
    "- Return concise output with evidence, uncertainty, and any required next action.",
    "",
    "## Output contract",
    "- State what was done.",
    "- Link or name any artifacts produced.",
    "- State validation performed and anything not validated.",
    "",
    "## Validation notes",
    `- ${sanitizeSkillMarkdownText(
      suggestion.validationExpectation ??
        "The Code Mode staging run must validate the skill content and record artifact hashes.",
    )}`,
    "",
    "## Provenance",
    `- Source session: ${sanitizeSkillMarkdownText(suggestion.sourceSessionId ?? "current session")}`,
    `- Source turn: ${sanitizeSkillMarkdownText(suggestion.sourceTurnId ?? "current turn")}`,
    `- Gap summary: ${sanitizeSkillMarkdownText(suggestion.summary)}`,
    `- Rationale: ${sanitizeSkillMarkdownText(suggestion.reason)}`,
    "",
    "## Rollback",
    `- ${sanitizeSkillMarkdownText(
      suggestion.rollbackPosture ??
        "Rollback restores the previously approved version and records durable lifecycle evidence.",
    )}`,
  ].join("\n");
}

function buildSkillName(title: string): string {
  const cleaned = title
    .replace(/^build reusable skill:\s*/i, "")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
  if (!cleaned) {
    return "Generated Capability Candidate";
  }
  return cleaned
    .split(" ")
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sanitizeSkillMarkdownText(value: string): string {
  const redacted = value
    .replace(/https?:\/\/\S+/gi, "[external source]")
    .replace(/\b(api[_-]?key|secret|password|token|credential)\b/gi, "sensitive value")
    .replace(/\b(sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,})\b/gi, "[redacted]")
    .replace(/\b(fetch\s*\(|axios\.|curl\s+)\b/gi, "[network step]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted || "No additional detail provided.";
}

function quoteYamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}
