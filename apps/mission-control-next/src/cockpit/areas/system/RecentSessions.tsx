import { useQuery } from "@tanstack/react-query";
import type { BudgetState, SessionHealth, SessionMeta } from "@goatcitadel/contracts";
import { fetchSessions } from "@goatcitadel/mission-control-shared/api/sessions";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { SystemOwnerLink } from "./SystemOwnerLink";

const HEALTH: Record<SessionHealth, StatusPresentation> = {
  healthy: { label: "Healthy", tone: "done" },
  degraded: { label: "Degraded", tone: "waiting" },
  blocked: { label: "Blocked", tone: "failed" },
};
const BUDGET: Record<BudgetState, string> = {
  ok: "within limits",
  warning: "near its limit",
  hard_cap: "hard cap reached",
};
const when = (value: string) =>
  Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    "Not reported"
  );

function title(item: SessionMeta) {
  const explicit = item.displayName?.trim();
  return explicit && !/^sess[_-]/i.test(explicit) ? explicit : `${humanizeToken(item.channel)} conversation`;
}

/**
 * Recent sessions across every channel (the Classic Ops "Session evidence"), each with its channel, health and budget
 * state and a native Chat link. Identifiers and usage stay in technical details; nothing here acts on a session.
 */
export function RecentSessions() {
  const sessions = useQuery({ queryKey: ["system", "recent-sessions"], queryFn: fetchSessions });
  const items = sessions.isError ? [] : (sessions.data?.items ?? []);
  return (
    <section
      aria-labelledby="recent-sessions-title"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="recent-sessions-title" className="font-display text-base font-semibold text-fg">
            Recent sessions
          </h2>
          <p className="mt-1 text-fg-secondary">Conversations across every channel, most recent first.</p>
        </div>
        <Button size="sm" disabled={sessions.isFetching} onClick={() => void sessions.refetch()}>
          Refresh sessions
        </Button>
      </div>
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
        <ul aria-label="Recent sessions" className="space-y-2">
          {items.map((item) => (
            <li key={item.sessionId} className="space-y-1 rounded-md border border-line bg-raised p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 break-words font-semibold text-fg">{title(item)}</h3>
                <StatusBadge status={HEALTH[item.health] ?? { label: humanizeToken(item.health), tone: "neutral" }} />
              </div>
              <p className="text-fg-secondary">
                {humanizeToken(item.channel)} · {humanizeToken(item.kind)} · Last activity {when(item.lastActivityAt)}
              </p>
              <p className="text-fg-secondary">Budget: {BUDGET[item.budgetState] ?? humanizeToken(item.budgetState)}</p>
              <details>
                <summary className="min-h-11 cursor-pointer font-medium text-fg">Session details</summary>
                <ul className="space-y-1 break-words text-fg-secondary">
                  <li>
                    Session ID: <code className="wrap-anywhere">{item.sessionId}</code>
                  </li>
                  <li>Account: {item.account}</li>
                  <li>
                    Usage: {item.tokenTotal.toLocaleString()} tokens ({item.tokenInput.toLocaleString()} in,{" "}
                    {item.tokenOutput.toLocaleString()} out)
                  </li>
                </ul>
              </details>
              <SystemOwnerLink href={`/chat?sessionId=${encodeURIComponent(item.sessionId)}`} scope={item.sessionId}>
                Open in Chat
              </SystemOwnerLink>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
