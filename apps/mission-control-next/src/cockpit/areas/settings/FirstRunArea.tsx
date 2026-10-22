import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { EmptyState } from "../../ui/EmptyState";
import { ApprovalModeEditor } from "./ApprovalModeControl";
import { FirstRunModelStep } from "./FirstRunModelStep";
import { FirstRunAdvanced } from "./FirstRunAdvanced";
import { McpDraftLeave } from "./McpDraftLeave";
import { SetupStepBadge } from "./GuidedModelSteps";
import { firstRunModelSummary, firstRunSafetySummary } from "./first-run-summaries";
import { useFirstRunSetup, type FirstRunStep } from "./use-first-run-setup";

const STEPS: readonly { id: FirstRunStep; label: string; detail: string }[] = [
  { id: "model", label: "Choose a model", detail: "Use a cloud provider, try the demo, or run a local model." },
  { id: "safety", label: "Choose your safety settings", detail: "Review the approval rule before finishing setup." },
  {
    id: "message",
    label: "Send a test message",
    detail: "After setup, a completed Chat response verifies the first answer.",
  },
];

const TITLE = "Get started";
const DESCRIPTION = "Three steps to connect a model, choose how tools ask for approval, and verify a response.";

/** The guided setup page at Settings › First run. Settings › Get started shows FirstRunStatus instead. */
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
    <section aria-label="First-run setup" className={AREA_PAGE}>
      <AreaHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={<Button onClick={() => go("/settings/models#onboarding")}>Exit setup</Button>}
      />
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
          <nav aria-label="Setup steps">
            <ol className="grid gap-1 sm:grid-cols-3">
              {STEPS.map((item, index) => {
                const done =
                  item.id === "model"
                    ? progress.modelReady
                    : item.id === "message"
                      ? progress.firstResponseVerified
                      : setup.safetyConfirmed;
                const current = step === item.id;
                // A finished step collapses to what was chosen; the open step and later ones say what they need.
                const summary =
                  done && !current
                    ? item.id === "model"
                      ? firstRunModelSummary(state)
                      : item.id === "safety"
                        ? firstRunSafetySummary(state)
                        : `First response: ${progress.firstResponseLabel}`
                    : item.detail;
                return (
                  <li key={item.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => leave.request(() => setup.setStep(item.id))}
                      aria-current={current ? "step" : undefined}
                      className="flex h-full w-full flex-col items-start justify-start rounded-md px-3 py-2 text-left hover:bg-sunken aria-[current=step]:bg-sunken"
                    >
                      <span className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-fg-muted">Step {index + 1}</span>
                        <SetupStepBadge phase={done ? "done" : current ? "current" : "not_started"} />
                      </span>
                      <span className="block text-sm font-semibold text-fg">{item.label}</span>
                      <span className="mt-1 block break-words text-xs text-fg-muted">{summary}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="border-t border-line-subtle pt-5">
            {step === "model" ? (
              <FirstRunModelStep
                state={state}
                workspaceId={activeWorkspaceId}
                onReload={setup.refresh}
                onModelReady={() => setup.setStep("safety")}
                canContinue={Boolean(
                  progress.modelReady && !query.isFetching && !setup.checking && !completion.locked && !approval.locked,
                )}
                onContinue={() => void setup.continueModel()}
              />
            ) : null}
            {step === "safety" ? (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold text-fg">Choose your safety settings</h2>
                <p className="text-sm text-fg-secondary">
                  Current tool approval rule: {describeToolApprovalMode(state.settings.toolApprovalMode)}.
                </p>
                <ApprovalModeEditor control={approval} safeOnly />
                {progress.safeApprovalMode ? (
                  <Button disabled={!setup.canKeep} onClick={() => void setup.keepCurrentRule()}>
                    {setup.checking ? "Checking current rule…" : "Keep current rule"}
                  </Button>
                ) : (
                  <p className="text-sm text-status-waiting">
                    Choose and save a rule that keeps approval prompts before finishing guided setup.
                  </p>
                )}
              </div>
            ) : null}
            {step === "message" ? (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold text-fg">Send a test message</h2>
                <p className="text-sm text-fg-secondary">
                  First response: {progress.firstResponseLabel}.{" "}
                  {progress.firstResponseVerified
                    ? "Your first Chat answer is recorded."
                    : "Ask a short question in Chat; a completed answer verifies your model."}
                </p>
                {!state.completed ? (
                  <Button disabled aria-describedby="first-run-message-prerequisite">
                    Send a test message
                  </Button>
                ) : null}
                {!state.completed ? (
                  <p id="first-run-message-prerequisite" className="text-sm text-fg-secondary">
                    Finish setup first: choose a model, review the approval rule, then select Finish setup and open
                    Chat.
                  </p>
                ) : null}
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
            {state.completed ? (
              <Button variant="primary" onClick={() => go("/chat")}>
                {progress.firstResponseVerified ? "Open Chat" : "Open Chat to send a test message"}
              </Button>
            ) : null}
            {!state.completed ? (
              <Button
                variant="primary"
                aria-describedby="first-run-finish-prerequisite"
                disabled={!setup.canFinish}
                onClick={() => void finish()}
              >
                {completion.attempt?.phase === "pending" ? "Confirming setup…" : "Finish setup and open Chat"}
              </Button>
            ) : null}
          </div>
          {!state.completed ? (
            <p id="first-run-finish-prerequisite" className="text-sm text-fg-secondary">
              {setup.finishPrerequisite}
            </p>
          ) : null}
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
              Finish saves that setup is done after checking your model and approval choices again; it does not run a
              model. Your first completed Chat answer confirms the model separately.
            </p>
          ) : null}
        </>
      ) : null}
      <FirstRunAdvanced workspaceId={activeWorkspaceId ?? "default"} />
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
