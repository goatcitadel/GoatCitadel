import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { OpsRuntimeData } from "../../../features/native-routes/ops/runtime-overview-model";
import { Button } from "../../ui/Button";
import { MetricList } from "../../ui/MetricList";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { SessionControlManager } from "../chat/SessionControlManager";
import { findSession, sessionTitle } from "./sessions-page-model";
import { sessionTime } from "./SessionRow";
import { presentChannel, SESSION_BUDGET, SESSION_HEALTH, SESSION_KIND } from "./system-vocabulary";

/**
 * The session chosen with `?sessionId=`. Its controls bind to the id and the active workspace even when the recent
 * list no longer carries it, because Chat control does not depend on the list.
 */
export function SelectedSessionSection({
  data,
  listRead,
  sessionId,
  workspaceId,
  onClose,
}: {
  data: OpsRuntimeData | null;
  /** False when the recent list could not be read: then its absence says nothing about this session. */
  listRead: boolean;
  sessionId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const item = data ? findSession(data, sessionId) : undefined;
  return (
    <Section
      id="selected-session"
      title={item ? sessionTitle(item) : "Selected session"}
      actions={
        <Button size="sm" onClick={onClose}>
          Close session
        </Button>
      }
      className="space-y-3 text-sm"
    >
      {item ? (
        <>
          <p className="text-fg-secondary">
            {presentChannel(item.channel)} · {SESSION_KIND[item.kind] ?? "Conversation"} · Last activity{" "}
            {sessionTime(item.lastActivityAt)}
          </p>
          <MetricList
            label="Session state"
            items={[
              {
                term: "Health",
                value: (
                  <StatusBadge status={SESSION_HEALTH[item.health] ?? { label: "Health unknown", tone: "neutral" }} />
                ),
              },
              { term: "Budget", value: SESSION_BUDGET[item.budgetState] ?? "Not reported" },
              {
                term: "Tokens",
                value: Number.isFinite(item.tokenTotal) ? plural(item.tokenTotal, "token") : "Not reported",
              },
            ]}
          />
        </>
      ) : listRead ? (
        <p className="text-fg-secondary">This session isn&apos;t in the recent list. Its controls still apply.</p>
      ) : (
        <p className="text-fg-secondary">
          Recent sessions couldn&apos;t be read, so this session&apos;s details aren&apos;t shown. Its controls still
          apply.
        </p>
      )}
      <TechnicalDetails>
        Session ID: <code className="wrap-anywhere">{sessionId}</code>
      </TechnicalDetails>
      <SessionControlManager key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />
    </Section>
  );
}
