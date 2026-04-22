export type UiRiskLevel = "safe" | "warning" | "critical";

interface ChangeBadgeProps {
  level: UiRiskLevel;
  changed?: boolean;
}

export function ChangeBadge({ level, changed = true }: ChangeBadgeProps) {
  const label = level === "safe" ? "Calm Goat" : level === "warning" ? "Alert Horns" : "Steep Cliff";
  const icon = level === "safe" ? "🐐" : level === "warning" ? "📯" : "⛰️";
  return (
    <span className={`change-badge ${level}`}>
      {icon} {changed ? label : "No change"}
    </span>
  );
}
