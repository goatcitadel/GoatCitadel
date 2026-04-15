interface OnboardingStepNavProps {
  step: number;
  applying: boolean;
  steps: readonly string[];
  onSelectStep: (step: number) => void;
  onBack: () => void;
  onNext: () => void;
}

export function OnboardingStepNav(props: OnboardingStepNavProps) {
  const { step, applying, steps, onSelectStep, onBack, onNext } = props;

  return (
    <article className="card">
      <div className="stack-sm">
        <strong>Setup Steps</strong>
        <div className="stack-list">
          {steps.map((label, index) => (
            <button
              key={label}
              type="button"
              className={`stack-card stack-card-selectable${index === step ? " active" : ""}`}
              onClick={() => onSelectStep(index)}
              disabled={applying}
            >
              <div className="stack-card-header">
                <strong>
                  {index + 1}. {label}
                </strong>
                {index === step ? <span className="token-chip token-chip-active">Current</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button type="button" onClick={onBack} disabled={step === 0 || applying} className="gc-button">
          Back
        </button>
        <button type="button" onClick={onNext} disabled={step === 4 || applying} className="gc-button">
          Next
        </button>
      </div>
    </article>
  );
}
