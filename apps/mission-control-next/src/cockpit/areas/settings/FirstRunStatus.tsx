import { useQuery } from "@tanstack/react-query";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { projectFirstRunState } from "./first-run-state";
import { firstRunModelSummary, firstRunSafetySummary } from "./first-run-summaries";
import { SetupStepBadge, type SetupStepPhase } from "./GuidedModelSteps";

/**
 * Settings › Get started: a compact read of first-run progress with a link to the full setup page. It changes
 * nothing; the steps themselves live on the setup page.
 */
export function FirstRunStatus() {
  const query = useQuery({
    queryKey: ["system", "onboarding"],
    queryFn: fetchOnboardingState,
    refetchOnWindowFocus: true,
  });
  const state = query.isError ? undefined : query.data;
  const link = (
    <NativeOwnerLink
      href="/settings/first-run"
      scope="first-run"
      className="text-sm font-medium text-accent hover:underline"
    >
      Open setup
    </NativeOwnerLink>
  );
  if (query.isError)
    return (
      <div className="mt-4 grid justify-items-start gap-3">
        <Callout tone="error">Setup progress is unavailable. {describeApiError(query.error).summary}</Callout>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
          {link}
        </div>
      </div>
    );
  if (!state) return <p className="mt-4 text-sm text-fg-muted">Checking setup progress…</p>;
  const progress = projectFirstRunState(state);
  const done = [progress.modelReady, state.completed && progress.safeApprovalMode, progress.firstResponseVerified];
  const current = done.findIndex((item) => !item);
  const phase = (index: number): SetupStepPhase =>
    done[index] ? "done" : index === current ? "current" : "not_started";
  const steps = [
    { label: "Choose a model", summary: firstRunModelSummary(state) },
    {
      label: "Choose your safety settings",
      summary: state.completed ? firstRunSafetySummary(state) : "Not reviewed yet.",
    },
    { label: "Send a test message", summary: `First response: ${progress.firstResponseLabel}.` },
  ];
  return (
    <div className="mt-4 grid gap-3">
      <p className="text-sm text-fg-secondary">
        {current === -1
          ? "Setup is done and your first Chat answer is verified."
          : state.completed
            ? "Setup is recorded. Send a test message in Chat to verify the first answer."
            : "Setup isn't finished. Open setup to connect a model and choose how tools ask for approval."}
      </p>
      <ol aria-label="Setup progress" className="divide-y divide-line-subtle">
        {steps.map((step, index) => (
          <li key={step.label} className="flex flex-wrap items-start justify-between gap-2 py-2">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">
                Step {index + 1}: {step.label}
              </span>
              <span className="block break-words text-xs text-fg-secondary">{step.summary}</span>
            </span>
            <SetupStepBadge phase={phase(index)} />
          </li>
        ))}
      </ol>
      <div>{link}</div>
    </div>
  );
}
