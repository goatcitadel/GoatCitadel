interface OnboardingProgressPanelProps {
  stepTitle: string;
  checklist: Array<{
    id: string;
    label: string;
    status: string;
    detail?: string;
  }>;
  onRefresh: () => Promise<void>;
}

export function OnboardingProgressPanel(props: OnboardingProgressPanelProps) {
  const { stepTitle, checklist, onRefresh } = props;

  return (
    <article className="card">
      <div className="controls-row">
        <strong>Progress</strong>
        <span>{stepTitle}</span>
        <button type="button" onClick={() => void onRefresh()} className="gc-button">
          Refresh
        </button>
      </div>
      <div className="compact-list">
        {checklist.map((item) => (
          <li key={item.id}>
            <strong>{item.label}</strong> [{item.status}] {item.detail}
          </li>
        ))}
      </div>
    </article>
  );
}
