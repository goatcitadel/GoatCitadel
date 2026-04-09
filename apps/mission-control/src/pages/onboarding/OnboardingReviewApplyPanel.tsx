import { ChangeReviewPanel } from "../../components/ChangeReviewPanel";

interface OnboardingReviewApplyPanelProps {
  changeReview: {
    overall: "safe" | "warning" | "critical";
    items: Array<{ field: string; level: "safe" | "warning" | "critical"; hint?: string }>;
  };
  criticalConfirmed: boolean;
  setCriticalConfirmed: (value: boolean) => void;
  markComplete: boolean;
  setMarkComplete: (value: boolean) => void;
  summary: Record<string, unknown>;
  applying: boolean;
  onSubmit: () => Promise<void>;
}

export function OnboardingReviewApplyPanel(props: OnboardingReviewApplyPanelProps) {
  const {
    changeReview,
    criticalConfirmed,
    setCriticalConfirmed,
    markComplete,
    setMarkComplete,
    summary,
    applying,
    onSubmit,
  } = props;

  return (
    <article className="card">
      <h3>Step 5: Review & Apply</h3>
      <p>Ready to apply this onboarding configuration through the gateway API.</p>
      <ChangeReviewPanel
        title="Onboarding Change Risk"
        overall={changeReview.overall}
        items={changeReview.items}
        requireCriticalConfirm
        criticalConfirmed={criticalConfirmed}
        onCriticalConfirmChange={setCriticalConfirmed}
      />
      <div className="controls-row">
        <label htmlFor="wizard-mark-complete">Mark onboarding complete</label>
        <input
          id="wizard-mark-complete"
          type="checkbox"
          checked={markComplete}
          onChange={(event) => setMarkComplete(event.target.checked)}
        />
      </div>
      <pre>{JSON.stringify(summary, null, 2)}</pre>
      <button type="button" onClick={() => void onSubmit()} disabled={applying}>
        {applying ? "Applying..." : "Apply onboarding"}
      </button>
      <p className="office-subtitle">
        After apply, use Integrations to validate channels and Code mode to exercise implementation workflows.
      </p>
    </article>
  );
}
