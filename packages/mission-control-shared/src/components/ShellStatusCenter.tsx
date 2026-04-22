import { StatusChip } from "./StatusChip";
import type { ShellStatusEntry, ShellStatusSummary } from "./shell-status-model";

function formatToneLabel(tone: ShellStatusEntry["tone"]): string | null {
  switch (tone) {
    case "warning":
      return "Attention";
    case "critical":
      return "Critical";
    case "success":
      return "Healthy";
    case "live":
      return "Live";
    case "muted":
      return "Quiet";
    case "default":
    default:
      return null;
  }
}

function StatusEntryButton({
  entry,
  onAction,
}: {
  entry: ShellStatusEntry;
  onAction?: (entry: ShellStatusEntry) => void;
}) {
  const interactive = Boolean(onAction && entry.actionLabel);
  const content = (
    <>
      <div className="shell-status-entry-copy">
        <p className="shell-status-entry-label">{entry.label}</p>
        <strong className="shell-status-entry-value">{entry.value}</strong>
        {entry.note ? <p className="shell-status-entry-note">{entry.note}</p> : null}
      </div>
      <div className="shell-status-entry-meta">
        {entry.tone && formatToneLabel(entry.tone) ? (
          <StatusChip tone={entry.tone}>{formatToneLabel(entry.tone)}</StatusChip>
        ) : null}
        {entry.actionLabel ? <span className="shell-status-entry-action">{entry.actionLabel}</span> : null}
      </div>
    </>
  );

  if (!interactive) {
    return <div className="shell-status-entry-card">{content}</div>;
  }

  return (
    <button type="button" className="shell-status-entry-card interactive" onClick={() => onAction?.(entry)}>
      {content}
    </button>
  );
}

export function ShellStatusCenter({
  summary,
  expanded,
  onToggle,
  onEntryAction,
}: {
  summary: ShellStatusSummary;
  expanded: boolean;
  onToggle: () => void;
  onEntryAction?: (entry: ShellStatusEntry) => void;
}) {
  return (
    <section className={`shell-status-center${expanded ? " is-expanded" : ""}`} aria-label="Status Center">
      <button
        type="button"
        className={`shell-status-center-trigger gc-nav-button gc-nav-tier-chip${expanded ? " active" : ""}`}
        aria-label={`Status Center: ${summary.label}`}
        aria-expanded={expanded}
        aria-controls="shell-status-center-panel"
        title={`Status Center: ${summary.label}`}
        onClick={onToggle}
      >
        <span className="shell-status-center-trigger-copy">
          <span className="shell-status-center-trigger-label">Status</span>
          <span className="shell-status-center-trigger-summary">
            <strong className="shell-status-center-trigger-value">{summary.label}</strong>
            <span className="shell-status-center-trigger-note">{summary.note}</span>
          </span>
        </span>
        <div className="shell-status-center-trigger-meta">
          <StatusChip tone={summary.tone}>
            {summary.approvalCount > 0
              ? `${summary.approvalCount} decision${summary.approvalCount === 1 ? "" : "s"}`
              : "Clear"}
          </StatusChip>
        </div>
      </button>
      {expanded ? (
        <div className="shell-status-center-panel" id="shell-status-center-panel">
          {summary.sections.map((section) => (
            <section key={section.id} className="shell-status-center-section">
              <div className="shell-status-center-section-head">
                <p className="shell-status-center-section-kicker">{section.title}</p>
                <strong>{section.summary}</strong>
              </div>
              <div className="shell-status-center-entry-grid">
                {section.entries.map((entry) => (
                  <StatusEntryButton key={entry.id} entry={entry} onAction={onEntryAction} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}
