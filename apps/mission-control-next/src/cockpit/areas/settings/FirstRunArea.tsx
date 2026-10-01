import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { ApprovalModeEditor } from "./ApprovalModeControl";
import { FirstRunModelStep } from "./FirstRunModelStep";
import { FirstRunAdvanced } from "./FirstRunAdvanced";
import { McpDraftLeave } from "./McpDraftLeave";
import { useFirstRunSetup, type FirstRunStep } from "./use-first-run-setup";

const STEPS: readonly { id: FirstRunStep; label: string; detail: string }[] = [
  { id: "model", label: "Choose a model", detail: "Connect a provider and confirm the default model." },
  { id: "safety", label: "Set your safety posture", detail: "Review the approval rule before finishing setup." },
  {
    id: "message",
    label: "Send a test message",
    detail: "After setup, a completed Chat response verifies the first answer.",
  },
];

export function FirstRunArea() {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const setup = useFirstRunSetup(activeWorkspaceId);
  const { query, state, progress, step, approval, completion } = setup;
  const leave = useDraftLeave();
  const go = (path: string) => leave.request(() => navigate(path));
  const finish = async () => {
    if (await setup.finish()) go("/chat");
  };
  return (
    <section aria-label="First-run setup" className="mx-auto flex min-h-full max-w-4xl flex-col gap-5 p-4 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line-subtle pb-5">
        <div>
          <p className="text-xs font-semibold text-accent">GoatCitadel setup</p>
          <h1 className="font-display text-xl font-semibold text-fg">Your first answer</h1>
          <p className="mt-1 text-sm text-fg-secondary">
            Three steps to connect a model, choose how tools ask for approval, and verify a response.
          </p>
        </div>
        <Button onClick={() => go("/settings")}>Exit setup</Button>
      </header>
      {query.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Checking setup state…
        </p>
      ) : null}
      {query.isError ? (
        <EmptyState
          title="Setup state unavailable"
          description={describeApiError(query.error).summary}
          action={<Button onClick={() => void setup.refresh()}>Try again</Button>}
        />
      ) : null}
      {state && progress ? (
        <>
          <nav aria-label="Setup steps" className="grid gap-2 sm:grid-cols-3">
            {STEPS.map((item, index) => {
              const done =
                item.id === "model"
                  ? progress.modelReady
                  : item.id === "message"
                    ? progress.firstResponseVerified
                    : setup.safetyConfirmed;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => leave.request(() => setup.setStep(item.id))}
                  aria-current={step === item.id ? "step" : undefined}
                  className="rounded-lg border border-line bg-raised p-3 text-left hover:border-accent aria-[current=step]:border-accent"
                >
                  <span className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-fg-muted">Step {index + 1}</span>
                    <StatusBadge status={{ label: done ? "Done" : "Open", tone: done ? "done" : "neutral" }} />
                  </span>
                  <span className="block text-sm font-semibold text-fg">{item.label}</span>
                  <span className="mt-1 block text-xs text-fg-muted">{item.detail}</span>
                </button>
              );
            })}
          </nav>
          <div className="rounded-lg border border-line bg-raised p-4 sm:p-6">
            {step === "model" ? <FirstRunModelStep state={state} workspaceId={activeWorkspaceId} /> : null}
            {step === "safety" ? (
              <div className="space-y-4">
                <h2 className="font-display text-lg font-semibold text-fg">Set your safety posture</h2>
                <p className="text-sm text-fg-secondary">
                  Current tool approval rule: {describeToolApprovalMode(state.settings.toolApprovalMode)}.
                </p>
                <ApprovalModeEditor control={approval} safeOnly />
                {progress.safeApprovalMode ? (
                  <Button disabled={!setup.canKeep} onClick={() => void setup.keepCurrentRule()}>
                    {setup.checking ? "Checking current rule…" : "Keep current rule"}
                  </Button>
                ) : (
                  <p role="alert" className="text-sm text-status-waiting">
                    Choose and save a rule that keeps approval prompts before finishing guided setup.
                  </p>
                )}
                <p className="text-xs text-fg-muted">
                  After a saved change, refresh checks and review the current rule. Pending approvals and uncertain
                  saves cannot finish setup.
                </p>
              </div>
            ) : null}
            {step === "message" ? (
              <div className="space-y-4">
                <h2 className="font-display text-lg font-semibold text-fg">Send a test message</h2>
                <p className="text-sm text-fg-secondary">
                  First response: {progress.firstResponseLabel}. The Gateway checks a completed Chat turn after setup,
                  not a catalog entry or a test connection.
                </p>
                <p className="text-sm text-fg-secondary">
                  {progress.firstResponseVerified
                    ? "Your first provider-backed Chat response is recorded. Continue in Chat whenever you are ready."
                    : "Finish setup, open Chat, ask a short question, then return here to review the verified response."}
                </p>
                <Button variant="primary" disabled={!state.completed} onClick={() => go("/chat")}>
                  Open Chat
                </Button>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              onClick={() => void setup.refresh()}
              disabled={query.isFetching || completion.attempt?.phase === "pending"}
            >
              Refresh checks
            </Button>
            {!state.completed ? (
              <Button variant="primary" disabled={!setup.canFinish} onClick={() => void finish()}>
                {completion.attempt?.phase === "pending" ? "Confirming setup…" : "Finish setup and open Chat"}
              </Button>
            ) : null}
          </div>
          {setup.notice || completion.notice ? (
            <p role="status" className="text-sm text-fg-secondary">
              {completion.notice ?? setup.notice}
            </p>
          ) : null}
          {completion.attempt?.phase === "unknown" ? (
            <p role="alert" className="text-sm text-status-waiting">
              {completion.attempt.message}
            </p>
          ) : null}
          {!state.completed ? (
            <p className="text-xs text-fg-muted">
              Finish records a setup marker after fresh model and approval checks; it does not run a model. The
              completion API has no atomic settings revision guard. Your first completed Chat response provides separate
              inference evidence.
            </p>
          ) : null}
        </>
      ) : null}
      <FirstRunAdvanced workspaceId={activeWorkspaceId ?? "default"} />
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
