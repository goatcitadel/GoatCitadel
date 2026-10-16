import { useQuery } from "@tanstack/react-query";
import type { SessionMeta } from "@goatcitadel/contracts";
import { fetchSessions } from "@goatcitadel/mission-control-shared/api/sessions";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { Section } from "../../ui/Section";
import { presentChannel, SESSION_BUDGET, SESSION_HEALTH, SESSION_KIND } from "./system-vocabulary";

const when = (value: string) => (Number.isFinite(Date.parse(value)) ? <TimeText value={value} /> : "Not reported");

function title(item: SessionMeta) {
  const explicit = item.displayName?.trim();
  return explicit && !/^sess[_-]/i.test(explicit) ? explicit : `${presentChannel(item.channel)} conversation`;
}

/**
 * Recent sessions across every channel (the Classic Ops "Session evidence"), each with its channel, health and budget
 * state and a native Chat link. Identifiers and usage stay in technical details; nothing here acts on a session.
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
            <li key={item.sessionId} className="space-y-1 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 break-words font-semibold text-fg">{title(item)}</h3>
                <StatusBadge status={SESSION_HEALTH[item.health] ?? { label: "Health unknown", tone: "neutral" }} />
              </div>
              <p className="text-fg-secondary">
                {presentChannel(item.channel)} · {SESSION_KIND[item.kind] ?? "Conversation"} · Last activity{" "}
                {when(item.lastActivityAt)}
              </p>
              <p className="text-fg-secondary">Budget: {SESSION_BUDGET[item.budgetState] ?? "not reported"}</p>
              <details>
                <summary className="min-h-11 cursor-pointer font-medium text-fg">Session details</summary>
                <ul className="space-y-1 break-words text-fg-secondary">
                  <li>Account: {item.account}</li>
                  <li>
                    Usage: {plural(item.tokenTotal, "token")} ({item.tokenInput.toLocaleString()} in,{" "}
                    {item.tokenOutput.toLocaleString()} out)
                  </li>
                </ul>
                <TechnicalDetails>
                  Session ID: <code className="wrap-anywhere">{item.sessionId}</code>
                </TechnicalDetails>
              </details>
              <SystemOwnerLink href={`/chat?sessionId=${encodeURIComponent(item.sessionId)}`} scope={item.sessionId}>
                Open in Chat
              </SystemOwnerLink>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
