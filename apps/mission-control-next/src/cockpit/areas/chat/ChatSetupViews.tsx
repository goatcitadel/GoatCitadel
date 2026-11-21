import type { OnboardingState } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../../ui/Button";
import { projectFirstRunState } from "../settings/first-run-state";
import { startConversation } from "./conversation-reuse";

/**
 * Advisory once a model is ready: sending works before setup is finished, so that copy must not read as a block.
 * Without a model nothing can answer, so the banner says so and sends the operator to choose one.
 */
export function ChatSetupBanner({
  modelReady,
  providerNotReady = false,
  onReturnToSetup,
}: {
  modelReady: boolean;
  /** A model is chosen and its provider reported that it is not ready: a different fix from choosing a model. */
  providerNotReady?: boolean;
  onReturnToSetup: () => void;
}) {
  const sentence = modelReady
    ? "You can chat now. Finish setup to verify your first answer."
    : providerNotReady
      ? "Your model's provider is not ready. Check its connection before you send your first message."
      : "Connect a model before you send your first message.";
  const action = modelReady ? "Return to setup" : providerNotReady ? "Check model setup" : "Set up a model";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle bg-sunken px-3 py-2 text-sm text-fg-secondary">
      <p>{sentence}</p>
      <Button size="sm" onClick={onReturnToSetup}>
        {action}
      </Button>
    </div>
  );
}

/** The setup banner, shown while setup is unfinished and the setup state could be read. */
function chatSetupProgress(onboarding: { data?: OnboardingState; isError: boolean } | undefined) {
  const state = onboarding?.data;
  if (!state || onboarding.isError || state.completed) return undefined;
  const progress = projectFirstRunState(state);
  const provider = state.setupReadiness?.items.find((item) => item.id === "provider");
  if (progress.modelConfigured && (!provider || provider.status === "unknown")) return undefined;
  return progress;
}

export function ChatSetupGate({
  onboarding,
  hidden,
  onSetup,
}: {
  onboarding: { data?: OnboardingState; isError: boolean };
  hidden: boolean;
  onSetup: () => void;
}) {
  const progress = chatSetupProgress(onboarding);
  if (hidden || !progress) return null;
  return (
    <ChatSetupBanner
      modelReady={progress.modelReady}
      providerNotReady={progress.modelConfigured && !progress.providerReady}
      onReturnToSetup={onSetup}
    />
  );
}

export function ChatEmptyState({
  rail,
  onOpenConversations,
  railYields = false,
  onboarding,
  onSetup,
}: {
  rail: MissionThreadedRenderSurfaceInput["sessionRail"];
  /** Below the desktop rail the list is behind the header's Conversations button; the empty state offers it too. */
  onOpenConversations?: () => void;
  railYields?: boolean;
  onboarding?: { data?: OnboardingState; isError: boolean };
  onSetup?: () => void;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  const historyUnavailable = rail.historyUnavailable === true;
  // Only a plain Recent list with nothing in it is a first conversation; a search or the archive that found nothing is not.
  const first =
    !historyUnavailable &&
    rail.historyView === "active" &&
    !rail.search?.trim() &&
    (rail.selectedProjectId ?? "all") === "all" &&
    (rail.selectedFolderId ?? "all") === "all" &&
    !rail.selectedTag &&
    !rail.hasMoreSessions &&
    !rail.loadingMoreSessions &&
    !rail.missionSessions.length &&
    !rail.externalSessions?.length;
  const progress = first ? chatSetupProgress(onboarding) : undefined;
  const needsSetup = Boolean(onSetup && progress && !progress.modelReady);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-3 overflow-y-auto p-5 text-center">
      {rail.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading conversations…
        </p>
      ) : (
        <>
          <p className="text-lg font-semibold text-fg">
            {historyUnavailable
              ? "Couldn't confirm conversation history"
              : first
                ? "Start your first conversation"
                : "Choose a conversation"}
          </p>
          <p className="max-w-sm text-sm text-fg-secondary">
            {needsSetup
              ? "Connect a model before you send your first message."
              : historyUnavailable
                ? "You can still start a new conversation."
                : first
                  ? "Ask GoatCitadel anything. Your conversations will be listed here."
                  : "Pick one from the list, or start a new conversation."}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {onOpenConversations ? (
              <Button
                className={railYields ? "max-sm:h-11 xl:hidden" : "max-sm:h-11 lg:hidden"}
                onClick={onOpenConversations}
              >
                Show conversations
              </Button>
            ) : null}
            {needsSetup ? (
              <Button variant="primary" onClick={onSetup}>
                {progress?.modelConfigured ? "Check model setup" : "Set up a model"}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => startConversation(rail, activeWorkspaceId ?? undefined)}
                disabled={rail.creatingSession}
              >
                {rail.creatingSession ? "Creating…" : "New conversation"}
              </Button>
            )}
          </div>
          {first ? (
            <details className="max-w-sm text-left text-sm text-fg-secondary">
              <summary className="cursor-pointer py-1 text-center font-medium text-accent">
                See a sample approval
              </summary>
              <dl className="mt-2 space-y-2 border-t border-line-subtle pt-2">
                <div>
                  <dt className="font-medium text-fg">Request</dt>
                  <dd>“Remember to include sources in my weekly summaries.”</dd>
                </div>
                <div>
                  <dt className="font-medium text-fg">Review</dt>
                  <dd>
                    GoatCitadel shows the preference and its memory destination. You choose whether to approve this
                    write once.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-fg">Recorded result</dt>
                  <dd>GoatCitadel confirms the preference was saved after the write completes.</dd>
                </div>
              </dl>
              <p className="mt-2 text-fg-muted">Example only. Opening it does not change your memory.</p>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
