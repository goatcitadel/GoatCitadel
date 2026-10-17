import { FocusedDetail } from "../shared/FocusedDetail";
import { NativeButton } from "../primitives";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { useMemo, useState } from "react";
import {
  createMailDraft,
  fetchCommunicationsDashboard,
  sendMailDraft,
} from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeMailDraftFailure } from "@goatcitadel/mission-control-shared/content/mail-draft-failure";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { NativeCard, NativeDisclosureCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import { getErrorMessage, nativeLoad, nativeLoadIssues, useAsyncLoad, type Notice } from "../shared/native-helpers";
import {
  LibraryActionCardGrid,
  LibraryActionList,
  LibraryButtonRow,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryNotice,
  LibrarySectionShell,
} from "../shared/library-primitives";

export function LibraryCommunicationsSection({ activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const [view, setView] = useState<"inbox" | "agenda" | "compose">("inbox");
  const leave = useDraftLeave();
  const messageDraft = useSessionDraft(
    "mail-draft:" + activeWorkspaceId,
    { to: "", subject: "", bodyText: "" },
    undefined,
    { label: "Email draft", active: view === "compose" },
  );
  const { to, subject, bodyText } = messageDraft.value;
  const setTo = (to: string) => messageDraft.setValue((current) => ({ ...current, to }));
  const setSubject = (subject: string) => messageDraft.setValue((current) => ({ ...current, subject }));
  const setBodyText = (bodyText: string) => messageDraft.setValue((current) => ({ ...current, bodyText }));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The raw Gateway failure reason, shown only behind technical details; the notice carries operator copy.
  const [failureDetail, setFailureDetail] = useState<string | undefined>(undefined);
  const { showTechnicalDetails } = useUiPreferences();
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const dashboard = await nativeLoad("Communications", fetchCommunicationsDashboard(activeWorkspaceId), {
      mailAccounts: [],
      calendarAccounts: [],
      messages: [],
      events: [],
      contacts: [],
    });
    return {
      issues: nativeLoadIssues([dashboard]),
      dashboard: dashboard.data,
    };
  }, [activeWorkspaceId]);

  const mailAccounts = data?.dashboard.mailAccounts ?? [];
  const primaryAccount = mailAccounts[0] ?? null;
  const agendaItems = useMemo(() => data?.dashboard.events ?? [], [data?.dashboard.events]);
  const inboxItems = useMemo(() => data?.dashboard.messages ?? [], [data?.dashboard.messages]);

  const handleCreateDraft = async () => {
    if (!primaryAccount) {
      setNotice({ tone: "warning", message: "Connect a mail account before drafting." });
      return;
    }
    const submitted = messageDraft.value;
    setSaving(true);
    try {
      const draft = await createMailDraft({
        workspaceId: activeWorkspaceId,
        accountId: primaryAccount.accountId,
        to: to
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        subject,
        bodyText,
      });
      const sendState = await sendMailDraft(draft.draftId, activeWorkspaceId);
      const failure =
        sendState.status === "failed" || sendState.status === "send_unavailable"
          ? describeMailDraftFailure(sendState.failureReason)
          : undefined;
      setFailureDetail(failure?.technicalDetail);
      setNotice(
        sendState.status === "outcome_unknown"
          ? {
              tone: "warning",
              message:
                "Outcome unknown: the message may have been delivered. Check the sent mailbox before sending it again.",
            }
          : failure
            ? { tone: "error", message: failure.summary }
            : sendState.status === "sent"
              ? { tone: "success", message: "Sent." }
              : {
                  tone: "success",
                  message:
                    "Send approval requested. Nothing has been sent yet. Approving sends this exact message once.",
                },
      );
      if (messageDraft.acceptSaved({ to: "", subject: "", bodyText: "" }, undefined, submitted)) setView("inbox");
      await reload();
    } catch (draftError) {
      setFailureDetail(undefined);
      setNotice({ tone: "error", message: getErrorMessage(draftError) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <LibrarySectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      {notice && failureDetail && showTechnicalDetails ? (
        <details className="mc-next-inline-disclosure">
          <summary>Recorded failure reason</summary>
          <p>{failureDetail}</p>
        </details>
      ) : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {view !== "compose" ? (
        <div className="mc-next-view-tabs" role="group" aria-label="Communication views">
          <NativeButton variant="ghost" aria-pressed={view === "inbox"} onClick={() => setView("inbox")}>
            Inbox
          </NativeButton>
          <NativeButton variant="ghost" aria-pressed={view === "agenda"} onClick={() => setView("agenda")}>
            Agenda
          </NativeButton>
          <NativeButton onClick={() => setView("compose")}>
            {messageDraft.isDirty ? "Resume draft · Unsaved" : "New draft"}
          </NativeButton>
        </div>
      ) : null}
      <div className="mc-next-calm-directory">
        {view === "inbox" ? (
          <NativeCard
            title="Communications"
            subtitle={`Inbox, agenda, contacts, and approval-gated drafts for ${activeWorkspaceName}.`}
            stats={[
              { label: "Mail accounts", value: String(mailAccounts.length) },
              { label: "Calendar accounts", value: String(data?.dashboard.calendarAccounts.length ?? 0) },
              { label: "Contacts", value: String(data?.dashboard.contacts.length ?? 0) },
            ]}
          >
            <NativeDisclosureCard id="communication-accounts" title="Connected accounts">
              <LibraryActionCardGrid
                items={mailAccounts.map((account) => ({
                  id: account.accountId,
                  label: account.label,
                  value: account.syncStatus,
                  description: account.address ?? account.provider,
                  meta: account.secretRef ? `secret: ${account.secretRef}` : account.connectionId,
                  tone: account.syncStatus === "ready" ? "success" : "warning",
                }))}
                emptyLabel="No mail accounts are connected."
              />
            </NativeDisclosureCard>
            <LibraryActionList
              ariaLabel="Inbox messages"
              items={inboxItems.map((message) => ({
                id: message.messageId,
                label: message.subject ?? "Untitled message",
                description: message.snippet ?? message.from ?? "No preview returned.",
                meta: message.receivedAt ?? message.from,
              }))}
              emptyLabel="No inbox messages returned."
            />
          </NativeCard>
        ) : null}
        <div className="mc-next-settings-stack">
          {view === "agenda" ? (
            <NativeCard title="Agenda" subtitle="Calendar items surfaced through governed connections.">
              <LibraryActionList
                ariaLabel="Agenda events"
                items={agendaItems.map((event) => ({
                  id: event.eventId,
                  label: event.title,
                  description: event.description ?? event.location ?? "Calendar event",
                  meta: `${event.startIso} -> ${event.endIso}`,
                }))}
                emptyLabel="No agenda items returned."
              />
            </NativeCard>
          ) : null}
          {view === "compose" ? (
            <FocusedDetail
              title="New email draft"
              onClose={() => leave.request(() => setView("inbox"), [messageDraft.key])}
            >
              <NativeCard
                title="Draft email"
                subtitle="Drafts are saved on the Gateway; sending requires approval and sends once."
              >
                <LibraryFieldGrid>
                  <LibraryField label="To">
                    <input
                      className="mc-next-settings-input"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                      placeholder="client@example.com"
                    />
                  </LibraryField>
                  <LibraryField label="Subject">
                    <input
                      className="mc-next-settings-input"
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      placeholder="Follow-up"
                    />
                  </LibraryField>
                  <LibraryField label="Body" span={2}>
                    <textarea
                      className="mc-next-settings-input"
                      value={bodyText}
                      onChange={(event) => setBodyText(event.target.value)}
                      placeholder="Draft body"
                      rows={5}
                    />
                  </LibraryField>
                </LibraryFieldGrid>
                <LibraryButtonRow>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    disabled={saving || !primaryAccount || !to.trim()}
                    onClick={() => void handleCreateDraft()}
                  >
                    Queue approval
                  </button>
                </LibraryButtonRow>
              </NativeCard>
            </FocusedDetail>
          ) : null}
        </div>
      </div>
      {leave.dialog}
    </LibrarySectionShell>
  );
}
