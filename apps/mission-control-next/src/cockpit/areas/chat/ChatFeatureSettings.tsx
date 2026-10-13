import { useEffect, useState } from "react";
import type { ChatSubagentPolicy } from "@goatcitadel/contracts";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ChatProviderFallbackSettings } from "../../../features/threaded-surface/ChatProviderFallbackSettings";
import { ContextDisclosure } from "../../../features/threaded-surface/ThreadedContextDisclosure";
import "./chat-feature-settings.css";

/** Presentation only: existing session controllers and Gateway checks own every action. */
export function ChatFeatureSettings({ dock }: { dock: MissionThreadedContextDockProps }) {
  const [confirmAutomatic, setConfirmAutomatic] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const automaticAvailable = Boolean(dock.automaticFanout?.enabled);
  const busy = pending || dock.sending || Boolean(dock.sessionControlPending);
  const effectivePolicy =
    dock.prefs?.subagentPolicy === "auto_when_useful" && !automaticAvailable
      ? "ask_when_useful"
      : (dock.prefs?.subagentPolicy ?? "ask_when_useful");
  useEffect(() => {
    if (!automaticAvailable) setConfirmAutomatic(false);
  }, [automaticAvailable]);
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch {
      setError("Could not apply this change. Check the conversation and its current permissions, then try again.");
    } finally {
      setPending(false);
    }
  };
  const changePolicy = (policy: ChatSubagentPolicy) => {
    if (busy) return;
    if (policy === "auto_when_useful") {
      if (automaticAvailable) setConfirmAutomatic(true);
      return;
    }
    void perform(() => dock.onPrefPatch({ subagentPolicy: policy }));
  };
  return (
    <div className="cockpit-chat-feature-settings space-y-3" aria-label="Conversation execution settings">
      <fieldset disabled={busy} className="min-w-0 border-0 p-0">
        <ChatProviderFallbackSettings {...dock} sending={busy} />
      </fieldset>
      <ContextDisclosure summary="Subagents and coding delegates">
        <label className="mc-next-context-field">
          <span>Subagents</span>
          <select
            aria-label="Subagent policy"
            value={effectivePolicy}
            disabled={busy || (!dock.supervisedDelegationAvailable && !automaticAvailable)}
            onChange={(event) => changePolicy(event.target.value as ChatSubagentPolicy)}
          >
            <option value="off">No subagents</option>
            <option value="ask_when_useful">Ask before delegating</option>
            <option value="auto_when_useful" disabled={!automaticAvailable}>
              Auto when useful
            </option>
          </select>
        </label>
        <p role="status">
          {dock.supervisedDelegationAvailable
            ? "Review each proposed plan before starting its subagents. Automatic delegation requires an active grant for this project."
            : "Supervised delegation is not enabled for this runtime. Your saved preference remains available."}
        </p>
        {dock.automaticFanout?.unavailableReason ? <p>{dock.automaticFanout.unavailableReason}</p> : null}
        {dock.supervisedDelegationAvailable ? (
          <>
            <p>
              Coding delegates use Chat tools and approvals. Governed Code Mode runs require their own code review and
              artifact hash checks.
            </p>
            <div className="mc-next-context-actions">
              <button
                type="button"
                className="mc-next-panel-button"
                disabled={busy}
                onClick={() => void perform(dock.onSuggestDelegation)}
              >
                Suggest delegation
              </button>
              {(["implement", "review", "test", "ship"] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="mc-next-panel-button"
                  disabled={busy || !dock.codingDelegationAvailable}
                  onClick={() => void perform(() => dock.onRunCodeDelegation(preset))}
                >
                  {preset === "implement"
                    ? "Delegate implementation"
                    : preset === "review"
                      ? "Delegate review"
                      : preset === "test"
                        ? "Delegate tests"
                        : "Delegate release preparation"}
                </button>
              ))}
            </div>
            {!dock.codingDelegationAvailable ? (
              <p>Bind this Chat to an active project before delegating coding work.</p>
            ) : null}
          </>
        ) : null}
        {dock.delegationSuggestion ? (
          <section aria-label="Proposed delegation" className="mc-next-context-card">
            <strong>{dock.delegationSuggestion.mode}</strong>
            <p>{dock.delegationSuggestion.objective}</p>
            <p>{dock.delegationSuggestion.roles.join(" · ")}</p>
            <button
              type="button"
              className="mc-next-panel-button primary"
              disabled={busy || !dock.supervisedDelegationAvailable}
              onClick={() => void perform(dock.onAcceptDelegation)}
            >
              Approve delegation
            </button>
          </section>
        ) : null}
      </ContextDisclosure>
      {error ? <p role="alert">{error}</p> : null}
      <ConfirmModal
        open={confirmAutomatic}
        title="Allow Chat to auto-delegate to subagents?"
        message="Chat may start up to three subagents within this project's active grant and shared budget. You can inspect or stop the run. This preference persists for this conversation."
        confirmLabel="Allow auto-delegation"
        cancelLabel="Keep asking"
        danger
        confirmDisabled={busy || !automaticAvailable}
        onCancel={() => setConfirmAutomatic(false)}
        onConfirm={() => {
          if (busy || !automaticAvailable) return;
          setConfirmAutomatic(false);
          void perform(() => dock.onPrefPatch({ subagentPolicy: "auto_when_useful" }));
        }}
      />
    </div>
  );
}
