import { useEffect, useState } from "react";
import { StatCard } from "./StatCard";

interface StatusStripProps {
  approvalsCount: number;
  approvalsLabel?: string;
  approvalsNote?: string;
  activeAgentsCount: number;
  dailyCostUsd: number;
  openTasksCount: number;
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
  onOpenApprovals,
  onOpenAgents,
  onOpenCosts,
  onOpenTasks,
}: StatusStripProps) {
  const [compactViewport, setCompactViewport] = useState(readCompactViewport);
  const [expanded, setExpanded] = useState(() => !readCompactViewport());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia("(max-width: 767px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setCompactViewport(event.matches);
      if (!event.matches) {
        setExpanded(true);
      }
    };

    handleChange(media);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  const compactSummary = approvalsCount > 0
    ? `${approvalsCount} decision${approvalsCount === 1 ? "" : "s"} waiting`
    : openTasksCount > 0
      ? `${openTasksCount} open task${openTasksCount === 1 ? "" : "s"}`
      : "Decisions clear";

  return (
    <section
      className={`status-strip-shell${compactViewport ? " compact" : ""}${expanded ? " expanded" : " collapsed"}`}
      aria-label="Operator status"
    >
      {compactViewport ? (
        <button
          type="button"
          className="status-strip-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="status-strip-summary-copy">
            <span className="status-strip-summary-label">Operator status</span>
            <span className="status-strip-summary-value">{compactSummary}</span>
          </span>
          <span className="status-strip-summary-caret" aria-hidden>{expanded ? "▴" : "▾"}</span>
        </button>
      ) : null}
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
            note={openTasksCount > 0 ? "Trailboard queue" : "No open tasks"}
            tone={openTasksCount > 0 ? "accent" : "default"}
            className="status-strip-card status-strip-card-tasks"
            compact
            interactive
            onClick={onOpenTasks}
          />
        </div>
      </div>
    </section>
  );
}
