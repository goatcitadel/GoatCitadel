import { Panel } from "../../components/Panel";
import type { ChatContextDockPanelsProps } from "./ChatContextDockPanels.types";

export function ChatDockSuggestionsSection(
  props: Pick<
    ChatContextDockPanelsProps,
    | "isChatSurface"
    | "isCoworkSurface"
    | "sending"
    | "proactiveRuns"
    | "proactiveSuggestionCount"
    | "capabilitySuggestions"
    | "specialistSuggestions"
    | "specialistCandidates"
    | "delegationSuggestion"
    | "onCapabilitySuggestionAction"
    | "onCreateSpecialistDraft"
    | "onSpecialistCandidatePatch"
    | "onAcceptDelegation"
  >,
) {
  const {
    isChatSurface,
    isCoworkSurface,
    sending,
    proactiveRuns,
    proactiveSuggestionCount,
    capabilitySuggestions,
    specialistSuggestions,
    specialistCandidates,
    delegationSuggestion,
    onCapabilitySuggestionAction,
    onCreateSpecialistDraft,
    onSpecialistCandidatePatch,
    onAcceptDelegation,
  } = props;

  return (
    <Panel
      className="chat-v11-agentic-card chat-v11-panel-inbox"
      title={isCoworkSurface ? "Cowork inbox" : "Suggestions"}
      actions={<span className="token-chip">{proactiveSuggestionCount} suggested</span>}
    >
      {capabilitySuggestions.length > 0 ? (
        <div className="chat-v11-suggestion-card">
          <p>
            <strong>Capability upgrade available:</strong> GoatCitadel found a possible way to add what this request
            needs, but it still requires your approval.
          </p>
          <ul className="chat-v11-proactive-list">
            {capabilitySuggestions.slice(0, 3).map((suggestion) => (
              <li key={`${suggestion.kind}-${suggestion.candidateId ?? suggestion.title}`}>
                <p>
                  <strong>{suggestion.title}</strong>
                  {suggestion.riskLevel ? ` · ${suggestion.riskLevel} risk` : ""}
                </p>
                <p>{suggestion.summary}</p>
                <p className="chat-v11-muted">{suggestion.reason}</p>
                <div className="chat-v11-row-actions">
                  <button type="button" onClick={() => onCapabilitySuggestionAction(suggestion)}>
                    {suggestion.recommendedAction === "enable_skill"
                      ? "Enable skill"
                      : suggestion.recommendedAction === "install_skill_disabled"
                        ? "Install disabled"
                        : suggestion.recommendedAction === "install_skill_enable"
                          ? "Approve and install"
                          : suggestion.recommendedAction === "add_mcp_template"
                            ? "Add MCP template"
                            : suggestion.recommendedAction === "switch_tool_profile"
                              ? "Open tools"
                              : "Review"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {specialistSuggestions.length > 0 ? (
        <div className="chat-v11-suggestion-card">
          <p>
            <strong>Specialist suggestions:</strong> Save strong candidates when you want reusable collaborators for
            this session.
          </p>
          <ul className="chat-v11-proactive-list">
            {specialistSuggestions.slice(0, 3).map((suggestion, index) => (
              <li key={`${suggestion.role}-${index}`}>
                <p>
                  <strong>{suggestion.title}</strong> · {suggestion.role}
                </p>
                <p>{suggestion.summary}</p>
                <div className="chat-v11-row-actions">
                  <button type="button" disabled={sending} onClick={() => void onCreateSpecialistDraft(suggestion)}>
                    Draft dormant specialist
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {specialistCandidates.filter((item) => item.status !== "retired").length > 0 ? (
        <div className="chat-v11-suggestion-card">
          <p>
            <strong>Saved specialists:</strong> Review dormant specialists for this session.
          </p>
          <ul className="chat-v11-proactive-list">
            {specialistCandidates
              .filter((item) => item.status !== "retired")
              .slice(0, 6)
              .map((candidate) => (
                <li key={candidate.candidateId}>
                  <p>
                    <strong>{candidate.title}</strong> · {candidate.role}
                  </p>
                  <p>{candidate.summary}</p>
                  <p className="chat-v11-muted">
                    Status: {candidate.status} · Routing: {candidate.routingMode} · Confidence:{" "}
                    {Math.round(candidate.confidence * 100)}%
                  </p>
                  <div className="chat-v11-row-actions">
                    {candidate.status !== "approved" && candidate.status !== "active" ? (
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() =>
                          void onSpecialistCandidatePatch(
                            candidate.candidateId,
                            { status: "approved" },
                            `Approved ${candidate.title}.`,
                          )
                        }
                      >
                        Approve
                      </button>
                    ) : null}
                    {candidate.status !== "active" || candidate.routingMode !== "strong_match_only" ? (
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() =>
                          void onSpecialistCandidatePatch(
                            candidate.candidateId,
                            { status: "active", routingMode: "strong_match_only" },
                            `Activated ${candidate.title} for strong-match routing.`,
                          )
                        }
                      >
                        Activate auto-match
                      </button>
                    ) : null}
                    {candidate.status === "active" ||
                    candidate.status === "approved" ||
                    candidate.status === "drafted" ? (
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() =>
                          void onSpecialistCandidatePatch(
                            candidate.candidateId,
                            { status: "disabled", routingMode: "manual_only" },
                            `Disabled ${candidate.title}.`,
                          )
                        }
                      >
                        Disable
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() =>
                        void onSpecialistCandidatePatch(
                          candidate.candidateId,
                          { status: "retired", routingMode: "disabled" },
                          `Retired ${candidate.title}.`,
                        )
                      }
                    >
                      Retire
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {isCoworkSurface && delegationSuggestion ? (
        <div className="chat-v11-suggestion-card">
          <p>
            <strong>Delegation suggestion:</strong> {delegationSuggestion.reason}
          </p>
          <p>Roles: {delegationSuggestion.roles.join(" -> ")}</p>
          <div className="chat-v11-row-actions">
            <button type="button" disabled={sending} onClick={() => void onAcceptDelegation()}>
              Accept plan
            </button>
          </div>
        </div>
      ) : null}
      {isCoworkSurface || (isChatSurface && proactiveSuggestionCount > 0) ? (
        <ul className="chat-v11-proactive-list">
          {proactiveRuns.slice(0, 4).map((run) => (
            <li key={run.runId}>
              <p>
                <strong>{run.status}</strong> · {new Date(run.startedAt).toLocaleTimeString()}
              </p>
              <p>{run.reasoningSummary}</p>
            </li>
          ))}
          {isCoworkSurface && proactiveRuns.length === 0 ? (
            <li className="chat-v11-muted">No proactive runs yet for this session.</li>
          ) : null}
        </ul>
      ) : null}
    </Panel>
  );
}
