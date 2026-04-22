import { ChangeBadge, type UiRiskLevel } from "./ChangeBadge";
import { globalCopy } from "../content/copy";

interface ReviewItem {
  field: string;
  level: UiRiskLevel;
  hint?: string;
}

interface ChangeReviewPanelProps {
  title?: string;
  overall: UiRiskLevel;
  items: ReviewItem[];
  requireCriticalConfirm?: boolean;
  criticalConfirmed?: boolean;
  onCriticalConfirmChange?: (value: boolean) => void;
}

export function ChangeReviewPanel({
  title = "Change Review",
  overall,
  items,
  requireCriticalConfirm = false,
  criticalConfirmed = false,
  onCriticalConfirmChange,
}: ChangeReviewPanelProps) {
  return (
    <article className="card change-review-panel">
      <h4>{title}</h4>
      <p className="controls-row">
        <strong>Overall risk:</strong> <ChangeBadge level={overall} />
      </p>
      {items.length > 0 ? (
        <ul className="compact-list">
          {items.map((item) => (
            <li key={item.field}>
              <strong>{item.field}</strong> <ChangeBadge level={item.level} />
              {item.hint ? <p className="office-subtitle">{item.hint}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="office-subtitle">{globalCopy.common.noPendingEdits}</p>
      )}
      {requireCriticalConfirm && overall === "critical" ? (
        <label className="controls-row">
          <input
            type="checkbox"
            checked={criticalConfirmed}
            onChange={(event) => onCriticalConfirmChange?.(event.target.checked)}
          />
          I understand this is a critical change and want to continue.
        </label>
      ) : null}
    </article>
  );
}
