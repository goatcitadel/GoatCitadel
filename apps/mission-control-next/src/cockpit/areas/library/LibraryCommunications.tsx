import { useQuery } from "@tanstack/react-query";
import type { CalendarAccountRecord, CommunicationsDashboardResponse, MailAccountRecord } from "@goatcitadel/contracts";
import { fetchCommunicationsDashboard } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { LibraryMailCompose } from "./LibraryMailCompose";
import { useLibraryOperation } from "./use-library-operation";

const SYNC_STATUS: Readonly<Record<MailAccountRecord["syncStatus"], StatusPresentation>> = {
  ready: { label: "Ready", tone: "done" },
  syncing: { label: "Syncing", tone: "running" },
  degraded: { label: "Degraded", tone: "waiting" },
  not_configured: { label: "Not configured", tone: "waiting" },
  failed: { label: "Failed", tone: "failed" },
};
const CARD = "grid min-w-0 grid-cols-1 content-start gap-3 rounded-lg border border-line p-3";
const ITEM = "min-w-0 rounded-md border border-line p-3 wrap-anywhere";

const formatTime = (iso?: string) => {
  const date = iso ? new Date(iso) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
};

/** Defense in depth: the Gateway already projects only unbound and same-workspace connections. */
function scopeDashboard(data: CommunicationsDashboardResponse, workspaceId: string): CommunicationsDashboardResponse {
  const mailAccounts = data.mailAccounts.filter((account) => account.workspaceId === workspaceId);
  const calendarAccounts = data.calendarAccounts.filter((account) => account.workspaceId === workspaceId);
  const mailIds = new Set(mailAccounts.map((account) => account.accountId)),
    calendarIds = new Set(calendarAccounts.map((account) => account.accountId));
  return {
    mailAccounts,
    calendarAccounts,
    messages: data.messages.filter((message) => mailIds.has(message.accountId)),
    events: data.events.filter((event) => calendarIds.has(event.accountId)),
    contacts: data.contacts.filter((contact) => contact.workspaceId === workspaceId),
  };
}

export function LibraryCommunications({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["communications", workspaceId]));
  const query = useQuery({
    queryKey: ["library", "communications", workspaceId, access.identity],
    queryFn: () => fetchCommunicationsDashboard(workspaceId),
    staleTime: 0,
  });
  const data = query.data ? scopeDashboard(query.data, workspaceId) : undefined;
  const refresh = () => query.refetch();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 overflow-y-auto p-4">
      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-xl font-semibold">Mail</h1>
        <p className="text-sm text-fg-secondary">
          Inbox, agenda and contacts read through governed integrations for workspace {workspaceId}. Sending is
          approval-gated and this screen never delivers mail.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={query.isFetching} onClick={() => void refresh()}>
            Refresh communications
          </Button>
        </div>
        {query.isPending ? <p role="status">Reading communications…</p> : null}
        {query.error ? (
          <Callout tone="error">{describeApiError(query.error).summary} Retry with Refresh communications.</Callout>
        ) : null}
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <section className={CARD} aria-label="Inbox">
            <h2 className="font-display text-lg text-fg">Inbox</h2>
            {data && !data.messages.length ? (
              <p className="text-sm text-fg-muted">No inbox messages returned.</p>
            ) : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {data?.messages.map((message) => (
                <li key={message.messageId} className={ITEM}>
                  <h3 className="font-medium">{message.subject || "Untitled message"}</h3>
                  <p className="text-sm text-fg-secondary">
                    {message.from ?? "Unknown sender"}
                    {formatTime(message.receivedAt) ? ` · ${formatTime(message.receivedAt)}` : ""}
                  </p>
                  {message.snippet ? <p className="text-sm">{message.snippet}</p> : null}
                  {message.triage ? (
                    <p className="text-sm text-fg-secondary">
                      Triage: {message.triage.urgency} urgency · {message.triage.category}
                      {message.triage.summary ? ` · ${message.triage.summary}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <section className={CARD} aria-label="Agenda">
            <h2 className="font-display text-lg text-fg">Agenda</h2>
            {data && !data.events.length ? <p className="text-sm text-fg-muted">No agenda items returned.</p> : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {data?.events.map((event) => (
                <li key={event.eventId} className={ITEM}>
                  <h3 className="font-medium">{event.title}</h3>
                  <p className="text-sm text-fg-secondary">
                    {formatTime(event.startIso) ?? event.startIso} to {formatTime(event.endIso) ?? event.endIso}
                  </p>
                  {event.location ? <p className="text-sm">{event.location}</p> : null}
                  {event.description ? <p className="text-sm">{event.description}</p> : null}
                  <p className="text-sm text-fg-secondary">
                    {event.attendees.length === 1 ? "1 attendee" : `${event.attendees.length} attendees`}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <section className={CARD} aria-label="Contacts">
            <h2 className="font-display text-lg text-fg">Contacts</h2>
            {data && !data.contacts.length ? <p className="text-sm text-fg-muted">No contacts returned.</p> : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {data?.contacts.map((contact) => (
                <li key={contact.contactId} className={ITEM}>
                  <h3 className="font-medium">{contact.displayName}</h3>
                  {contact.company || contact.role ? (
                    <p className="text-sm text-fg-secondary">
                      {[contact.role, contact.company].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                  {contact.emailAddresses.length ? (
                    <p className="text-sm">{contact.emailAddresses.join(", ")}</p>
                  ) : null}
                  {contact.phoneNumbers.length ? <p className="text-sm">{contact.phoneNumbers.join(", ")}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <section className={CARD} aria-label="Mail and calendar accounts">
            <h2 className="font-display text-lg text-fg">Accounts</h2>
            {data && !data.mailAccounts.length && !data.calendarAccounts.length ? (
              <p className="text-sm text-fg-muted">No mail or calendar account is connected to this workspace.</p>
            ) : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {[
                ...(data?.mailAccounts ?? []).map((account) => ["Mail", account] as const),
                ...(data?.calendarAccounts ?? []).map((account) => ["Calendar", account] as const),
              ].map(([kind, account]) => (
                <AccountItem key={kind + account.accountId} kind={kind} account={account} />
              ))}
            </ul>
          </section>
          <LibraryMailCompose
            workspaceId={workspaceId}
            accounts={data?.mailAccounts}
            loadFailed={!data && query.isError}
            available={Boolean(data) && !query.isError}
            onRefresh={refresh}
          />
        </div>
      </div>
    </div>
  );
}

function AccountItem({
  kind,
  account,
}: {
  kind: "Mail" | "Calendar";
  account: MailAccountRecord | CalendarAccountRecord;
}) {
  return (
    <li className={ITEM}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{account.label}</h3>
        <StatusBadge status={SYNC_STATUS[account.syncStatus] ?? { label: account.syncStatus, tone: "neutral" }} />
      </div>
      <p className="text-sm text-fg-secondary">
        {kind} · {account.provider}
        {"address" in account && account.address ? ` · ${account.address}` : ""}
      </p>
      {formatTime(account.lastSyncedAt) ? (
        <p className="text-sm text-fg-secondary">Last synced {formatTime(account.lastSyncedAt)}</p>
      ) : null}
      <TechnicalDetails label="Account record">
        <p>Account {account.accountId}</p>
        <p>
          Credential custody stays with the connector
          {account.secretRef ? "; a reference is configured." : "; no reference is configured."}
        </p>
      </TechnicalDetails>
    </li>
  );
}
