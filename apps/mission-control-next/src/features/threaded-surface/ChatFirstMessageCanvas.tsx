import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { resolveChatRouteReadiness, type ChatRouteReadiness } from "./chat-route-readiness";

const CHAT_STARTER_PROMPTS = [
  {
    label: "Orient me",
    prompt: "Summarize the current workspace state and suggest the safest next step.",
  },
  {
    label: "Plan a task",
    prompt: "Turn this goal into a short plan with risks, open questions, and a first action.",
  },
  {
    label: "Review context",
    prompt: "Review the available context and call out what is known, missing, and uncertain.",
  },
] as const;

export function ChatFirstMessageCanvas({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const readiness = resolveChatRouteReadiness(props);
  const readinessCards = buildChatReadinessCards(props, readiness);
  const hasConfiguredModelChoices = (props.providerOptions ?? []).some(
    (provider) => !provider.disabled && provider.models.length > 0,
  );
  const canOpenModelPalette = hasConfiguredModelChoices && Boolean(props.composerPalette?.enabled);
  const applyStarterPrompt = (prompt: string) => {
    props.onDraftChange(prompt);
    props.composerRef.current?.focus();
  };
  const openModelPalette = () => {
    props.composerPalette?.onQueryChange("model");
    props.composerPalette?.onOpen();
  };

  return (
    <div className="mc-next-chat-start-canvas">
      <div className="mc-next-chat-start-hero">
        <p className="mc-next-thread-meta">
          <strong data-readiness={readiness.state}>{readiness.title}</strong>
        </p>
        <h2>What should we tackle?</h2>
        <p>{readiness.message}</p>
        {readiness.state === "no_provider" ? (
          // Nothing is connected, so no model choice can help yet: route to
          // the real provider settings instead of the model palette.
          <div className="mc-next-chat-start-readiness-actions" aria-label="Chat setup actions">
            {props.onOpenProviderSettings ? (
              <button
                type="button"
                className="mc-next-thread-inline-button primary"
                onClick={props.onOpenProviderSettings}
              >
                Connect a model
              </button>
            ) : null}
            {props.onOpenLocalAiSettings ? (
              <button type="button" className="mc-next-thread-inline-button" onClick={props.onOpenLocalAiSettings}>
                Set up a local model
              </button>
            ) : null}
          </div>
        ) : readiness.state === "blocked" ? (
          <div className="mc-next-chat-start-readiness-actions" aria-label="Chat setup actions">
            {canOpenModelPalette ? (
              <button type="button" className="mc-next-thread-inline-button primary" onClick={openModelPalette}>
                Choose a model
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="mc-next-thread-inline-button primary"
                  onClick={props.onOpenProviderSettings}
                >
                  Configure providers
                </button>
                <button type="button" className="mc-next-thread-inline-button" onClick={props.onOpenLocalAiSettings}>
                  Set up a local model
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="mc-next-chat-start-readiness" aria-label="Chat readiness">
        {readinessCards.map((card) => (
          <article key={card.label} className={`mc-next-chat-start-card tone-${card.tone}`}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>

      {readiness.state === "no_provider" ? <ChatModelFreeDestinations props={props} /> : null}

      <div className="mc-next-chat-start-section">
        <h3>Starter prompts</h3>
        {readiness.state === "no_provider" ? (
          <p className="mc-next-chat-start-note">
            Starter prompts fill in the message box. Send them once a model is connected.
          </p>
        ) : null}
        <div className="mc-next-chat-start-prompts">
          {CHAT_STARTER_PROMPTS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="mc-next-chat-start-prompt"
              onClick={() => applyStarterPrompt(starter.prompt)}
            >
              <strong>{starter.label}</strong>
              <span>{starter.prompt}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Pending approvals stay on the Chat header's compact count; the canvas does not repeat them. */}
      <div className="mc-next-chat-start-actions" aria-label="Chat handoff actions">
        <button type="button" className="mc-next-thread-inline-button" onClick={props.onAttachFiles}>
          Attach files
        </button>
      </div>
    </div>
  );
}

/** Places that stay useful before any model is connected (e.g. right after the safe demo). */
function ChatModelFreeDestinations({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const destinations = [
    props.onOpenLibraryArtifacts
      ? {
          label: "Library",
          description: "Browse saved artifacts, knowledge, and memory for this workspace.",
          onSelect: props.onOpenLibraryArtifacts,
        }
      : null,
    props.onOpenOpsRuntime
      ? {
          label: "Runtime health",
          description: "Check the Gateway, storage, and local runtimes.",
          onSelect: props.onOpenOpsRuntime,
        }
      : null,
  ].filter((destination): destination is NonNullable<typeof destination> => destination !== null);
  if (destinations.length === 0) {
    return null;
  }
  return (
    <div className="mc-next-chat-start-section" aria-label="Explore without a model">
      <h3>Explore without a model</h3>
      <div className="mc-next-chat-start-prompts">
        {destinations.map((destination) => (
          <button
            key={destination.label}
            type="button"
            className="mc-next-chat-start-prompt"
            onClick={() => destination.onSelect()}
          >
            <strong>{destination.label}</strong>
            <span>{destination.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildChatReadinessCards(props: MissionThreadedActiveSessionSurfaceProps, readiness: ChatRouteReadiness) {
  const contextValue = props.contextSelection
    ? `${props.contextSelection.label} · ${props.contextSelection.turnCount} selected`
    : props.outboundContext
      ? props.outboundContext.sourceLabel
        ? `${props.outboundContext.label} · ${props.outboundContext.sourceLabel}`
        : props.outboundContext.label
      : props.pendingAttachments.length > 0
        ? `${props.pendingAttachments.length} attachment${props.pendingAttachments.length === 1 ? "" : "s"} pending`
        : "No extra context selected";

  return [
    {
      label: "Model",
      value: readiness.state === "no_provider" ? "Not connected" : props.trust.providerModelSummary,
      tone: readiness.state === "no_provider" ? "warning" : "default",
    },
    { label: "Runtime", value: props.trust.runtimeSummary, tone: props.trust.runtimeTone ?? "muted" },
    { label: "Policy", value: props.trust.approvalsSummary, tone: props.approvalsCount > 0 ? "warning" : "muted" },
    { label: "Context", value: contextValue, tone: props.contextSelection || props.outboundContext ? "live" : "muted" },
  ] as const;
}
