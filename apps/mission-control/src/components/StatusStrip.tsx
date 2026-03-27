import { StatCard } from "./StatCard";

interface StatusStripProps {
  approvalsCount: number;
  activeAgentsCount: number;
  dailyCostUsd: number;
  openTasksCount: number;
  onOpenApprovals: () => void;
  onOpenAgents: () => void;
  onOpenCosts: () => void;
  onOpenTasks: () => void;
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
  activeAgentsCount,
  dailyCostUsd,
  openTasksCount,
  onOpenApprovals,
  onOpenAgents,
  onOpenCosts,
  onOpenTasks,
}: StatusStripProps) {
  return (
    <section className="status-strip" aria-label="Operator status">
      <StatCard
        label="Pending approvals"
        value={approvalsCount}
        note={approvalsCount > 0 ? "Review queue" : "No blockers"}
        tone={approvalsCount > 0 ? "warning" : "success"}
        compact
        interactive
        onClick={onOpenApprovals}
      />
      <StatCard
        label="Active agents"
        value={activeAgentsCount}
        note={activeAgentsCount > 0 ? "Inspect live herd" : "No active agents"}
        tone={activeAgentsCount > 0 ? "accent" : "default"}
        compact
        interactive
        onClick={onOpenAgents}
      />
      <StatCard
        label="Spend today"
        value={formatUsd(dailyCostUsd)}
        note="Provider and runtime spend"
        tone="default"
        compact
        interactive
        onClick={onOpenCosts}
      />
      <StatCard
        label="Open tasks"
        value={openTasksCount}
        note={openTasksCount > 0 ? "Trailboard queue" : "No open tasks"}
        tone={openTasksCount > 0 ? "accent" : "default"}
        compact
        interactive
        onClick={onOpenTasks}
      />
    </section>
  );
}
