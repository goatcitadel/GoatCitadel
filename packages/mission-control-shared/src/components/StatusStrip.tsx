import { useEffect, useState } from "react";
import { StatCard } from "./StatCard";

interface StatusStripProps {
  approvalsCount: number;
  approvalsLabel?: string;
  approvalsNote?: string;
  activeAgentsCount: number;
  dailyCostUsd: number;
  openTasksCount: number;
  variant: "compact" | "expanded";
  context: "work" | "observe" | "tune";
  placement?: "standalone" | "attached";
  onToggleVariant: (next: "compact" | "expanded") => void;
  onOpenApprovals: () => void;
  onOpenAgents: () => void;
  onOpenCosts: () => void;
  onOpenTasks: () => void;
}

function readCompactViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(max-width: 767px)").matches;
}

function formatUsd(value: number): string {
  if (value >= 100) {
    return `$${value.toFixed(0)}`;
  }
  if (value >= 10) {
    return `$${value.toFixed(1)}`;
  }
  return `$${value.toFixed(2)}`;
}

export function StatusStrip({
  approvalsCount,
  approvalsLabel = "Pending decisions",
  approvalsNote,
  activeAgentsCount,
  dailyCostUsd,
  openTasksCount,
  variant,
  context,
  placement = "standalone",
  onToggleVariant,
  onOpenApprovals,
  onOpenAgents,
  onOpenCosts,
  onOpenTasks,
}: StatusStripProps) {
  const [compactViewport, setCompactViewport] = useState(readCompactViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia("(max-width: 767px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setCompactViewport(event.matches);
    };

    handleChange(media);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  const compactSummary =
    approvalsCount > 0
      ? `${approvalsCount} decision${approvalsCount === 1 ? "" : "s"} waiting`
      : openTasksCount > 0
        ? `${openTasksCount} open task${openTasksCount === 1 ? "" : "s"}`
        : "Decisions clear";

  const isExpanded = variant === "expanded";
  const compactTone = approvalsCount > 0 ? "warning" : activeAgentsCount > 0 ? "live" : "muted";
  const attached = placement === "attached";

  if (attached && !isExpanded) {
    return null;
  }

  return (
    <section
      className={`status-strip-shell status-strip-context-${context}${compactViewport ? " compact" : ""}${isExpanded ? " expanded" : " collapsed"}${attached ? " status-strip-attached" : ""}`}
      aria-label="Operator status"
    >
      {!attached ? (
        <>
          <button
            type="button"
            className="gc-button status-strip-summary"
            aria-expanded={isExpanded}
            onClick={() => onToggleVariant(isExpanded ? "compact" : "expanded")}
          >
            <span className="status-strip-summary-copy">
              <span className="status-strip-summary-label">Operator status</span>
              <span className="status-strip-summary-value">{compactSummary}</span>
            </span>
            <span className="status-strip-summary-caret" aria-hidden>
              {isExpanded ? "▴" : "▾"}
            </span>
          </button>
          <div className="status-strip-compact-row" aria-label="Operator status summary">
            <button
              type="button"
              className={`gc-nav-button gc-nav-tier-chip${approvalsCount > 0 ? " active" : ""}`}
              aria-label={`Approvals: ${approvalsCount > 0 ? `${approvalsCount} decisions waiting` : "decisions clear"}`}
              onClick={onOpenApprovals}
            >
              {approvalsCount > 0 ? `${approvalsCount} decisions` : "Decisions clear"}
            </button>
            <button
              type="button"
              className={`gc-nav-button gc-nav-tier-chip${activeAgentsCount > 0 ? " active" : ""}`}
              aria-label={`Agents: ${activeAgentsCount > 0 ? `${activeAgentsCount} agents live` : "no active agents"}`}
              onClick={onOpenAgents}
            >
              {activeAgentsCount > 0 ? `${activeAgentsCount} agents live` : "No active agents"}
            </button>
            <button
              type="button"
              className="gc-nav-button gc-nav-tier-chip"
              aria-label={`Tasks: ${openTasksCount > 0 ? `${openTasksCount} open tasks` : "no open tasks"}`}
              onClick={onOpenTasks}
            >
              {openTasksCount > 0 ? `${openTasksCount} open tasks` : "No open tasks"}
            </button>
            <button
              type="button"
              className={`gc-nav-button gc-nav-tier-chip${compactTone === "warning" ? " active" : ""}`}
              aria-label={`Spend: ${formatUsd(dailyCostUsd)} today`}
              onClick={onOpenCosts}
            >
              {formatUsd(dailyCostUsd)} today
            </button>
          </div>
        </>
      ) : null}
      {isExpanded ? (
        <div className="status-strip">
          <div className="status-strip-tier status-strip-tier-primary" aria-label="Critical operator priorities">
            <StatCard
              label={approvalsLabel}
              value={approvalsCount}
              note={approvalsNote ?? (approvalsCount > 0 ? "Needs operator review now" : "No blockers")}
              tone={approvalsCount > 0 ? "warning" : "success"}
              className={`status-strip-card status-strip-card-approvals${approvalsCount > 0 ? " is-attention" : ""}`}
              compact
              interactive
              onClick={onOpenApprovals}
            />
            <StatCard
              label="Active agents"
              value={activeAgentsCount}
              note={activeAgentsCount > 0 ? "Inspect live herd" : "No active agents"}
              tone={activeAgentsCount > 0 ? "accent" : "default"}
              className="status-strip-card status-strip-card-agents"
              compact
              interactive
              onClick={onOpenAgents}
            />
          </div>
          <div className="status-strip-tier status-strip-tier-secondary" aria-label="Monitoring and background state">
            <StatCard
              label="Spend today"
              value={formatUsd(dailyCostUsd)}
              note="Provider and runtime spend"
              tone="default"
              className="status-strip-card status-strip-card-spend"
              compact
              interactive
              onClick={onOpenCosts}
            />
            <StatCard
              label="Open tasks"
              value={openTasksCount}
              note={openTasksCount > 0 ? "Task queue" : "No open tasks"}
              tone={openTasksCount > 0 ? "accent" : "default"}
              className="status-strip-card status-strip-card-tasks"
              compact
              interactive
              onClick={onOpenTasks}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
