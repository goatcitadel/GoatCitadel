export interface OfficeKpiGridProps {
  activeAgents: number;
  hotAgents: number;
  readyAgents: number;
  eventFlow: number;
  pendingApprovalsCount: number;
  streamHealthy: boolean;
}

export function OfficeKpiGrid(props: OfficeKpiGridProps) {
  const { activeAgents, hotAgents, readyAgents, eventFlow, pendingApprovalsCount, streamHealthy } = props;

  return (
    <div className="office-kpi-grid">
      <article className="office-kpi-card">
        <p className="office-kpi-label">Goats in motion</p>
        <p className="office-kpi-value">{activeAgents}</p>
        <p className="office-kpi-note">Actively executing work</p>
      </article>
      <article className="office-kpi-card">
        <p className="office-kpi-label">Hot hooves</p>
        <p className="office-kpi-value">{hotAgents}</p>
        <p className="office-kpi-note">Updated in last 2 minutes</p>
      </article>
      <article className="office-kpi-card">
        <p className="office-kpi-label">Ready reserves</p>
        <p className="office-kpi-value">{readyAgents}</p>
        <p className="office-kpi-note">Ready for assignment</p>
      </article>
      <article className="office-kpi-card">
        <p className="office-kpi-label">Event pace</p>
        <p className="office-kpi-value">{eventFlow.toFixed(1)}/min</p>
        <p className="office-kpi-note">
          {pendingApprovalsCount} approvals pending · stream {streamHealthy ? "live" : "syncing"}
        </p>
      </article>
    </div>
  );
}
