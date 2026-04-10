interface OnboardingStepNavProps {
  step: number;
  applying: boolean;
  onBack: () => void;
  onNext: () => void;
}

export function OnboardingStepNav(props: OnboardingStepNavProps) {
  const { step, applying, onBack, onNext } = props;

  return (
    <article className="card">
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
