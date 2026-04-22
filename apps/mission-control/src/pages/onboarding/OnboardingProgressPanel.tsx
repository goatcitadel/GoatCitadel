import type { CSSProperties } from "react";
import { StatusChip } from "../../components/StatusChip";

interface OnboardingProgressPanelProps {
  stepTitle: string;
  currentStep: number;
  totalSteps: number;
  checklist: Array<{
    id: string;
    label: string;
    status: string;
    detail?: string;
  }>;
  onRefresh: () => Promise<void>;
}

export function OnboardingProgressPanel(props: OnboardingProgressPanelProps) {
  const { stepTitle, currentStep, totalSteps, checklist, onRefresh } = props;
  const completedItems = checklist.filter((item) => item.status === "complete").length;
  const totalItems = checklist.length;
  const progressValue =
    totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : Math.round((currentStep / Math.max(totalSteps, 1)) * 100);

  return (
    <article className="card onboarding-progress-card">
      <div className="controls-row">
        <strong>Progress</strong>
        <span>{stepTitle}</span>
        <button type="button" onClick={() => void onRefresh()} className="gc-button">
          Refresh
        </button>
      </div>
      <div className="onboarding-progress-summary">
        <div
          className="gc-radial-progress onboarding-progress-ring"
          style={{ "--value": progressValue } as CSSProperties}
          aria-valuenow={progressValue}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
          aria-label={`Onboarding progress ${progressValue}%`}
        >
          <div className="onboarding-progress-ring-content">
            <strong>{progressValue}%</strong>
            <span>{completedItems}/{Math.max(totalItems, 0)} complete</span>
          </div>
        </div>
        <div className="onboarding-progress-copy">
          <strong>Step {currentStep} of {totalSteps}</strong>
          <p>{stepTitle}</p>
          <span>
            {completedItems} checklist item{completedItems === 1 ? "" : "s"} complete
            {totalItems > 0 ? ` of ${totalItems}` : ""}.
          </span>
        </div>
      </div>
      <ul className="compact-list onboarding-progress-checklist">
        {checklist.map((item) => (
          <li key={item.id} className="onboarding-progress-checklist-item">
            <div className="onboarding-progress-checklist-header">
              <strong>{item.label}</strong>
              <StatusChip tone={statusTone(item.status)}>{humanizeStatus(item.status)}</StatusChip>
            </div>
            {item.detail ? <span>{item.detail}</span> : null}
          </li>
        ))}
      </ul>
    </article>
  );
}

function humanizeStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function statusTone(status: string): "default" | "warning" | "critical" | "success" | "muted" {
  switch (status) {
    case "complete":
      return "success";
    case "blocked":
    case "failed":
      return "critical";
    case "needs_input":
    case "pending":
      return "warning";
    default:
      return "muted";
  }
}
