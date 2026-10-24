import { useQuery } from "@tanstack/react-query";
import { fetchSessions } from "@goatcitadel/mission-control-shared/api/sessions";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Section } from "../../ui/Section";
import { SessionRow } from "./SessionRow";

/**
 * Recent sessions across every channel, each with its channel, health and budget state and a native Chat link.
 * Identifiers and usage stay in technical details; nothing here acts on a session.
 */
export function RecentSessions() {
  const sessions = useQuery({ queryKey: ["system", "recent-sessions"], queryFn: fetchSessions });
  const items = sessions.isError ? [] : (sessions.data?.items ?? []);
  return (
    <Section
      title="Recent sessions"
      description="Conversations across every channel, most recent first."
      className="space-y-3 text-sm"
      actions={
        <Button size="sm" disabled={sessions.isFetching} onClick={() => void sessions.refetch()}>
          Refresh sessions
        </Button>
      }
    >
      {sessions.isLoading ? (
        <p role="status" className="text-fg-muted">
          Loading sessions…
        </p>
      ) : null}
      {sessions.isError ? (
        <p role="alert" className="text-status-failed">
          Sessions unavailable: {describeApiError(sessions.error).summary}
        </p>
      ) : null}
      {sessions.data && !sessions.isError && !items.length ? (
        <p className="text-fg-muted">No sessions have recent activity.</p>
      ) : null}
      {items.length ? (
        <ul aria-label="Recent sessions" className="divide-y divide-line-subtle">
          {items.map((item) => (
            <SessionRow key={item.sessionId} item={item} />
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
